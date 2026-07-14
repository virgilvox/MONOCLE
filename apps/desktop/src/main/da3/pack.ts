import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { delimiter, join } from 'node:path'
import { Emitter } from '../emitter'
import type { Da3Progress, Da3Status } from '../../shared/ipc'
import { da3Support, type Da3Platform } from './support'

/**
 * Manage the optional Depth Anything 3 pack: the PyTorch multi-view stack and the
 * DA3-BASE weights, kept out of the installer and downloaded on demand into user
 * app-data.
 *
 * The pack installs into `<userData>/da3`, where the app can write (the app
 * bundle itself is read-only and, on macOS, signed). Two pieces land there: the
 * multi-view Python packages under `site-packages/` (installed with the bundled
 * interpreter's pip, so the wheels match this exact platform and arch), and the
 * DA3-BASE weights under `models/da3-base/`. When both are present the app adds
 * the pack to the sidecar's PYTHONPATH and points MONOCLE_DA3_CKPT at the weights,
 * so DA3 runs with no change to the shipped interpreter.
 *
 * This module is Electron-free (node builtins only): the caller passes the
 * app-data base directory, so status and env resolution unit-test without Electron.
 */

// torch + torchvision + pycolmap + the DA3 runtime, then the ~517 MB weights.
const SIZE_ESTIMATE_BYTES = 3_100_000_000

const DA3_WEIGHTS_REPO = 'https://huggingface.co/depth-anything/DA3-BASE/resolve/main'
const DA3_WEIGHTS_FILES = ['config.json', 'model.safetensors']
const MARKER_VERSION = 1

interface Da3PackEvents extends Record<string, unknown> {
  state: Da3Status
  progress: Da3Progress
}

export class Da3Pack extends Emitter<Da3PackEvents> {
  private installing = false
  private abort: AbortController | null = null

  constructor(
    /** `<userData>/da3`, the writable root the pack installs into. */
    private readonly baseDir: string,
    /** The bundled interpreter that pip-installs the pack (matches this platform). */
    private readonly interpreter: string,
    /** The sidecar source dir, whose `[multiview]` extra names the deps to install. */
    private readonly sidecarDir: string,
    private readonly platform: Da3Platform,
    /** Injectable for tests; defaults to the real filesystem. */
    private readonly exists: (path: string) => boolean = existsSync,
  ) {
    super()
  }

  private get pkgsDir(): string {
    return join(this.baseDir, 'site-packages')
  }

  private get modelDir(): string {
    return join(this.baseDir, 'models', 'da3-base')
  }

  private get marker(): string {
    return join(this.baseDir, 'installed.json')
  }

  /** Both the Python stack and the weights are present. */
  isInstalled(): boolean {
    return (
      this.exists(this.marker) &&
      this.exists(join(this.pkgsDir, 'torch')) &&
      this.exists(join(this.modelDir, 'model.safetensors'))
    )
  }

  status(): Da3Status {
    const { supported, reason } = da3Support(this.platform)
    return {
      installed: this.isInstalled(),
      installing: this.installing,
      supported,
      reason,
      sizeEstimateBytes: SIZE_ESTIMATE_BYTES,
    }
  }

  /**
   * Environment additions that make the pack visible to the sidecar. Empty when
   * the pack is not installed, so the sidecar env is untouched until DA3 exists.
   * PYTHONPATH is prepended to any inherited value so the pack's torch wins.
   */
  env(inherited: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    if (!this.isInstalled()) return {}
    const existing = inherited.PYTHONPATH
    return {
      PYTHONPATH: existing ? `${this.pkgsDir}${delimiter}${existing}` : this.pkgsDir,
      MONOCLE_DA3_CKPT: this.modelDir,
    }
  }

  private emitState(): void {
    this.emit('state', this.status())
  }

  /**
   * Download and install the pack. Rejects immediately if the platform cannot run
   * DA3 (so a multi-gigabyte download never runs only to fail at pip). A prior
   * partial install is wiped first so the tree is always coherent.
   */
  async install(): Promise<void> {
    if (this.installing) return
    const { supported, reason } = da3Support(this.platform)
    if (!supported) throw new Error(reason)
    if (this.isInstalled()) return

    this.installing = true
    this.abort = new AbortController()
    const { signal } = this.abort
    this.emitState()
    try {
      await rm(this.baseDir, { recursive: true, force: true })
      await mkdir(this.pkgsDir, { recursive: true })
      await mkdir(this.modelDir, { recursive: true })

      // The multi-view stack. Installing the sidecar's `[multiview]` extra keeps
      // the dep list in one place (pyproject); the bundled interpreter's pip picks
      // platform- and arch-correct wheels. depth-anything-3 itself installs with
      // --no-deps, exactly as the bundler does (its pins do not build everywhere).
      await this.runPip(
        [
          'install',
          '--no-input',
          '--disable-pip-version-check',
          '--target',
          this.pkgsDir,
          `${this.sidecarDir}[multiview]`,
        ],
        signal,
      )
      await this.runPip(
        [
          'install',
          '--no-input',
          '--disable-pip-version-check',
          '--target',
          this.pkgsDir,
          '--no-deps',
          'depth-anything-3',
        ],
        signal,
      )

      await this.downloadWeights(signal)

      this.emit('progress', { phase: 'finalize', message: 'Finishing up' })
      await writeFile(
        this.marker,
        JSON.stringify({ version: MARKER_VERSION, files: DA3_WEIGHTS_FILES }, null, 2),
      )
    } catch (error) {
      // Leave nothing half-installed: a partial tree would read as present and
      // fail confusingly at scan time.
      await rm(this.baseDir, { recursive: true, force: true }).catch(() => {})
      throw error
    } finally {
      this.installing = false
      this.abort = null
      this.emitState()
    }
  }

  /** Cancel an in-flight install. The install()'s cleanup removes the partial tree. */
  cancel(): void {
    this.abort?.abort()
  }

  /** Delete the installed pack. No-op while installing. */
  async remove(): Promise<void> {
    if (this.installing) return
    await rm(this.baseDir, { recursive: true, force: true })
    this.emitState()
  }

  /** Run the bundled interpreter's pip, streaming its output as coarse progress. */
  private runPip(args: string[], signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('cancelled'))
      const child = spawn(this.interpreter, ['-m', 'pip', ...args], {
        cwd: this.baseDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
      const onAbort = (): void => {
        child.kill()
      }
      signal.addEventListener('abort', onAbort, { once: true })

      const report = (buffer: Buffer): void => {
        for (const line of buffer.toString().split('\n')) {
          const m = /^\s*(Downloading|Installing collected packages|Collecting|Building)\b.*/.exec(
            line,
          )
          if (m) this.emit('progress', { phase: 'packages', message: line.trim().slice(0, 120) })
        }
      }
      child.stdout?.on('data', report)
      child.stderr?.on('data', report)

      child.on('error', (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('exit', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else
          reject(
            new Error(
              `pip exited with code ${code}; the Depth Anything 3 stack may not build on this machine`,
            ),
          )
      })
    })
  }

  /** Fetch the DA3-BASE weights with real byte progress across both files. */
  private async downloadWeights(signal: AbortSignal): Promise<void> {
    // Probe sizes first so the fraction spans both files, not each on its own.
    const sizes = await Promise.all(
      DA3_WEIGHTS_FILES.map((name) => headLength(`${DA3_WEIGHTS_REPO}/${name}`, signal)),
    )
    const total = sizes.reduce((a, b) => a + b, 0) || SIZE_ESTIMATE_BYTES
    let done = 0
    for (const name of DA3_WEIGHTS_FILES) {
      await downloadToFile(
        `${DA3_WEIGHTS_REPO}/${name}`,
        join(this.modelDir, name),
        signal,
        (chunk) => {
          done += chunk
          this.emit('progress', {
            phase: 'weights',
            message: `Downloading Depth Anything 3 weights (${name})`,
            fraction: Math.min(done / total, 1),
          })
        },
      )
    }
  }
}

/** Follow redirects and resolve a URL's Content-Length, or 0 if unknown. */
function headLength(url: string, signal: AbortSignal, depth = 0): Promise<number> {
  return new Promise<number>((resolve) => {
    if (depth > 5) return resolve(0)
    const req = httpsGet(url, { signal }, (res) => {
      const { statusCode = 0, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        resolve(headLength(headers.location, signal, depth + 1))
        return
      }
      res.resume()
      resolve(Number.parseInt(headers['content-length'] ?? '0', 10) || 0)
    })
    req.on('error', () => resolve(0))
  })
}

/** Stream a URL to a file, following redirects and reporting chunk byte counts. */
function downloadToFile(
  url: string,
  dest: string,
  signal: AbortSignal,
  onChunk: (bytes: number) => void,
  depth = 0,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    if (depth > 5) return reject(new Error(`too many redirects for ${url}`))
    const req = httpsGet(url, { signal }, (res) => {
      const { statusCode = 0, headers } = res
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume()
        resolve(downloadToFile(headers.location, dest, signal, onChunk, depth + 1))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed (${statusCode}) for ${url}`))
        return
      }
      const file = createWriteStream(dest)
      res.on('data', (chunk: Buffer) => onChunk(chunk.length))
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    })
    req.on('error', reject)
  })
}
