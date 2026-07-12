import { type ChildProcess, spawn } from 'node:child_process'
import { Emitter } from '@monoclejs/core'
import {
  PROTOCOL_VERSION,
  RpcClient,
  SidecarMethod,
  SidecarNotification,
  type BackendInfo,
  type HealthResult,
  type LiveReconstructParams,
  type LogNote,
  type MeshUpdateNote,
  type PrepareMediaParams,
  type PrepareMediaResult,
  type ProgressNote,
  type ReconstructParams,
  type ReconstructResult,
  type Transport,
} from '@monoclejs/protocol'
import { resolvePython } from './python'
import type { SidecarStatus } from '../shared/ipc'

interface SupervisorEvents extends Record<string, unknown> {
  status: SidecarStatus
  progress: ProgressNote
  log: LogNote
  meshUpdate: MeshUpdateNote
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
// Hard ceiling on a single reconstruction. Past this we treat the sidecar as
// wedged and forcibly restart it, so a stuck job never hangs the UI forever.
const RECONSTRUCT_TIMEOUT_MS = 15 * 60_000

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
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly sidecarDir: string,
    private readonly pythonPath = resolvePython({ sidecarDir }).path,
    // Extra environment for the child, merged over process.env. Used to point
    // the sidecar at bundled assets (e.g. MONOCLE_DA2_ONNX) without a global env.
    private readonly extraEnv: NodeJS.ProcessEnv = {},
  ) {
    super()
  }

  getStatus(): SidecarStatus {
    return this.status
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') return
    this.clearRestartTimer()
    this.stopping = false
    this.restartAttempts = 0
    await this.launch()
  }

  private async launch(): Promise<void> {
    // Cancel any pending restart and kill a lingering child so a manual start
    // racing a scheduled restart cannot double-spawn and orphan a process.
    this.clearRestartTimer()
    this.killChild()
    this.setStatus('starting')
    try {
      const child = spawn(this.pythonPath, ['-m', 'monocle_sidecar'], {
        cwd: this.sidecarDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
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
      this.client.onNotification<MeshUpdateNote>(SidecarNotification.MeshUpdate, (note) =>
        this.emit('meshUpdate', note),
      )

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
    this.clearRestartTimer()
    this.killChild()
    this.setStatus('stopped')
  }

  async listBackends(): Promise<BackendInfo[]> {
    return this.requireClient().request<BackendInfo[]>(SidecarMethod.ListBackends)
  }

  /**
   * Ingest a dropped-in video or image folder into a session's frames directory,
   * selecting sharp, well-spread keyframes. Subject to the reconstruct timeout,
   * since a long video decode is the slow part; a wedged decode recovers the same
   * way a wedged reconstruction does.
   */
  async prepareMedia(params: PrepareMediaParams): Promise<PrepareMediaResult> {
    return this.requestOrRecover(
      this.requireClient().request<PrepareMediaResult>(SidecarMethod.PrepareMedia, params),
      'media import',
    )
  }

  async reconstruct(params: ReconstructParams): Promise<ReconstructResult> {
    return this.requestOrRecover(
      this.requireClient().request<ReconstructResult>(SidecarMethod.Reconstruct, params),
      'reconstruction',
    )
  }

  /**
   * Await a heavy sidecar request under the reconstruct timeout. On timeout the
   * sidecar is wedged, so restart it and reject, letting the renderer clear its
   * busy state instead of hanging. Other errors pass through unchanged.
   */
  private async requestOrRecover<T>(request: Promise<T>, label: string): Promise<T> {
    try {
      return await withTimeout(request, RECONSTRUCT_TIMEOUT_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('timed out')) {
        this.emit('log', {
          level: 'error',
          message: `${label} timed out; restarting the inference engine`,
        })
        this.restartAttempts = 0
        this.killChild()
        this.setStatus('error')
        this.scheduleRestart()
        throw new Error(`${label} timed out`)
      }
      throw error
    }
  }

  /**
   * Start an experimental live reconstruction. Resolves when the app cancels
   * (which ends the scan); the sidecar streams `meshUpdate` events meanwhile.
   * Not subject to the reconstruct timeout, since it runs for the whole scan.
   */
  async liveReconstruct(params: LiveReconstructParams): Promise<unknown> {
    return this.requireClient().request(SidecarMethod.LiveReconstruct, params)
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
    // Detach the launch-installed lifecycle listeners before killing. Otherwise
    // this deliberately-killed child fires 'exit' asynchronously, after a
    // replacement has already spawned, and onExit would tear down the healthy
    // replacement and schedule yet another restart.
    child.removeAllListeners('exit')
    child.removeAllListeners('error')
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
    // Never leak a pending restart: a second failure must replace, not stack, the
    // timer, or two timers both fire launch() and double-spawn the sidecar.
    this.clearRestartTimer()
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
    const timer = setTimeout(() => {
      // Only clear the handle if it still points at this timer, so a newer
      // scheduled restart is not silently orphaned.
      if (this.restartTimer === timer) this.restartTimer = null
      if (!this.stopping) void this.launch()
    }, delay)
    this.restartTimer = timer
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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
