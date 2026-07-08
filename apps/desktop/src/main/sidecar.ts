import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Emitter } from '@monoclejs/core'
import {
  PROTOCOL_VERSION,
  RpcClient,
  SidecarMethod,
  SidecarNotification,
  type BackendInfo,
  type HealthResult,
  type LogNote,
  type ProgressNote,
  type ReconstructParams,
  type ReconstructResult,
  type Transport,
} from '@monoclejs/protocol'
import type { SidecarStatus } from '../shared/ipc'

interface SupervisorEvents extends Record<string, unknown> {
  status: SidecarStatus
  progress: ProgressNote
  log: LogNote
}

const HEALTH_TIMEOUT_MS = 15_000
const MAX_RESTART_DELAY_MS = 10_000
// How long to let a killed sidecar exit on its own before we SIGKILL it, so a
// wedged process holding a multi-gigabyte model can never be orphaned.
const KILL_GRACE_MS = 2_000
// After this many consecutive failed starts, stop retrying and hold an error
// state so the UI can surface "engine needs setup" instead of looping forever
// (for example when no Python interpreter or the sidecar deps are present).
const MAX_RESTART_ATTEMPTS = 3

/**
 * Owns the Python inference sidecar: spawns it, speaks JSON-RPC over stdio,
 * performs a health handshake, restarts it with backoff on unexpected exit, and
 * guarantees it is killed when the app quits. Nothing else in the app touches
 * the child process directly.
 */
export class SidecarSupervisor extends Emitter<SupervisorEvents> {
  private child: ChildProcess | null = null
  private client: RpcClient | null = null
  private status: SidecarStatus = 'stopped'
  private stopping = false
  private restartDelay = 500
  private restartAttempts = 0

  constructor(
    private readonly sidecarDir: string,
    private readonly pythonPath = resolvePython(sidecarDir),
  ) {
    super()
  }

  getStatus(): SidecarStatus {
    return this.status
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') return
    this.stopping = false
    this.restartAttempts = 0
    await this.launch()
  }

  private async launch(): Promise<void> {
    this.setStatus('starting')
    try {
      const child = spawn(this.pythonPath, ['-m', 'monocle_sidecar'], {
        cwd: this.sidecarDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      child.on('error', (error) => this.onFailure(error.message))
      child.on('exit', (code) => this.onExit(code))
      child.stderr?.on('data', (buffer: Buffer) => {
        this.emit('log', { level: 'debug', message: buffer.toString().trimEnd() })
      })

      this.client = new RpcClient(childTransport(child))
      this.client.onNotification<ProgressNote>(SidecarNotification.Progress, (note) =>
        this.emit('progress', note),
      )
      this.client.onNotification<LogNote>(SidecarNotification.Log, (note) => this.emit('log', note))

      const health = await withTimeout(
        this.client.request<HealthResult>(SidecarMethod.Health),
        HEALTH_TIMEOUT_MS,
      )
      if (health.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `sidecar protocol ${health.protocolVersion} does not match app protocol ${PROTOCOL_VERSION}`,
        )
      }
      this.restartDelay = 500
      this.restartAttempts = 0
      this.setStatus('ready')
    } catch (error) {
      this.onFailure(error instanceof Error ? error.message : String(error))
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.killChild()
    this.setStatus('stopped')
  }

  async listBackends(): Promise<BackendInfo[]> {
    return this.requireClient().request<BackendInfo[]>(SidecarMethod.ListBackends)
  }

  async reconstruct(params: ReconstructParams): Promise<ReconstructResult> {
    return this.requireClient().request<ReconstructResult>(SidecarMethod.Reconstruct, params)
  }

  /**
   * Ask the sidecar to abort the in-flight reconstruction. Fire-and-forget: the
   * pending `reconstruct` request rejects on the sidecar's side. No-op unless a
   * ready client exists.
   */
  async cancelReconstruct(): Promise<void> {
    if (this.client && this.status === 'ready') {
      this.client.notify(SidecarMethod.Cancel)
    }
  }

  /**
   * Terminate the child and drop our references. Sends SIGTERM, then SIGKILL
   * after a grace period if it has not exited, so we never orphan the process.
   */
  private killChild(): void {
    const child = this.child
    this.child = null
    this.client = null
    if (!child) return
    child.kill()
    if (child.exitCode !== null || child.signalCode !== null) return
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    child.once('exit', () => clearTimeout(timer))
  }

  private requireClient(): RpcClient {
    if (!this.client || this.status !== 'ready') {
      throw new Error('sidecar is not ready')
    }
    return this.client
  }

  private setStatus(status: SidecarStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private onFailure(message: string): void {
    this.emit('log', { level: 'error', message: `sidecar: ${message}` })
    this.setStatus('error')
    this.killChild()
    this.scheduleRestart()
  }

  private onExit(code: number | null): void {
    if (this.stopping) return
    this.emit('log', { level: 'warn', message: `sidecar exited with code ${code}` })
    this.setStatus('error')
    this.killChild()
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping) return
    this.restartAttempts += 1
    if (this.restartAttempts > MAX_RESTART_ATTEMPTS) {
      this.emit('log', {
        level: 'error',
        message:
          'sidecar failed to start repeatedly; giving up. Check that Python and the sidecar dependencies are installed.',
      })
      this.setStatus('error')
      return
    }
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS)
    setTimeout(() => {
      if (!this.stopping) void this.launch()
    }, delay)
  }
}

function childTransport(child: ChildProcess): Transport {
  return {
    send: (data) => {
      child.stdin?.write(data)
    },
    onData: (listener) => {
      child.stdout?.on('data', (buffer: Buffer) => listener(new Uint8Array(buffer)))
    },
    onClose: (listener) => {
      child.on('close', listener)
    },
  }
}

/** Prefer a bundled virtualenv interpreter, otherwise fall back to system python3. */
function resolvePython(sidecarDir: string): string {
  const venvPython = join(sidecarDir, '.venv', 'bin', 'python')
  return existsSync(venvPython) ? venvPython : 'python3'
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
