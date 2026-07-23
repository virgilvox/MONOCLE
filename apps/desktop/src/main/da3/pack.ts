import { spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { delimiter, join } from 'node:path'
import { Emitter } from '../emitter'
import type { Da3Progress, Da3Status } from '../../shared/ipc'
import { da3Support, type Da3Platform } from './support'
import {
  buildMarker,
  integrityError,
  markerMatchesPins,
  parseMarker,
  resumeOffset,
  type DownloadedFile,
  type PinnedFile,
} from './integrity'

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
 * Downloads are pinned and verified: the weights come from a fixed DA3-BASE
 * revision, each file's sha256 is checked while it streams, and the install
 * marker records what was verified so isInstalled can spot a file that later
 * changed size. The large weights file resumes over transient network failures.
 *
 * This module is Electron-free (node builtins only): the caller passes the
 * app-data base directory, so status and env resolution unit-test without Electron.
 */

// torch + torchvision + pycolmap + the DA3 runtime, then the ~517 MB weights.
const SIZE_ESTIMATE_BYTES = 3_100_000_000

// DA3-BASE pinned to a specific revision so a repo update (or a tampered main)
// can never change what an install downloads. Sizes and hashes below were
// resolved from the Hugging Face API for this exact commit.
const DA3_WEIGHTS_REVISION = 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e'
const DA3_WEIGHTS_REPO = `https://huggingface.co/depth-anything/DA3-BASE/resolve/${DA3_WEIGHTS_REVISION}`
export const DA3_WEIGHTS_FILES: PinnedFile[] = [
  // config.json is a small non-LFS file: the API publishes no sha256 for it, so
  // the pinned revision and size are its only anchors.
  { name: 'config.json', sizeBytes: 1205, sha256: '' },
  {
    name: 'model.safetensors',
    sizeBytes: 541_518_028,
    sha256: 'e01067dc1659613083d9145a9a2547ccdbe6ccbbf83c4fe7b3e8a4e2bdae78b5',
  },
]

// The DA3 model code from PyPI, pinned so an install today matches what was
// tested. Bump together with the bundler's pin in scripts/bundle-python.mjs.
const DA3_RUNTIME_VERSION = '0.1.1'

// Version 2 markers record each verified file's size and sha256; older markers
// read as not-installed so existing unverified installs re-verify by reinstalling.
export const MARKER_VERSION = 2

const DOWNLOAD_ATTEMPTS = 3

/** The filesystem reads isInstalled needs, injectable so tests skip real IO. */
export interface PackFileSystem {
  exists(path: string): boolean
  /** File content as UTF-8, or null when unreadable. */
  readText(path: string): string | null
  /** Regular-file size in bytes, or null when missing or not a file. */
  fileSize(path: string): number | null
}

const realFs: PackFileSystem = {
  exists: existsSync,
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  fileSize: (path) => {
    try {
      const info = statSync(path)
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  },
}

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
    private readonly fs: PackFileSystem = realFs,
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

  /**
   * The Python stack and the weights are present and still look like what the
   * installer verified: the marker must match the current pins (full hashes were
   * checked at install time) and each weights file must still have its recorded
   * size. Size alone keeps startup cheap; a truncated or swapped file fails here
   * instead of confusingly at scan time.
   */
  isInstalled(): boolean {
    if (!this.fs.exists(join(this.pkgsDir, 'torch'))) return false
    const records = parseMarker(this.fs.readText(this.marker), MARKER_VERSION)
    if (!records || !markerMatchesPins(records, DA3_WEIGHTS_FILES)) return false
    return records.every(
      (record) => this.fs.fileSize(join(this.modelDir, record.name)) === record.sizeBytes,
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
      // --no-deps, exactly as the bundler does (its pins do not build everywhere),
      // and pinned so every install gets the version this app was tested against.
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
          `depth-anything-3==${DA3_RUNTIME_VERSION}`,
        ],
        signal,
      )

      const downloaded = await this.downloadWeights(signal)

      this.emit('progress', { phase: 'finalize', message: 'Finishing up' })
      // Record what was verified (names, sizes, hashes) so isInstalled can later
      // check the files against the same expectations without re-hashing.
      await writeFile(this.marker, buildMarker(MARKER_VERSION, downloaded))
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

  /**
   * Fetch the DA3-BASE weights with real byte progress across both files. The
   * pinned sizes give the total, so the fraction spans the whole download. Each
   * file is verified against its pin; the returned records go into the marker.
   */
  private async downloadWeights(signal: AbortSignal): Promise<DownloadedFile[]> {
    const total = DA3_WEIGHTS_FILES.reduce((sum, pin) => sum + pin.sizeBytes, 0)
    const downloaded: DownloadedFile[] = []
    let completed = 0
    for (const pin of DA3_WEIGHTS_FILES) {
      const record = await downloadPinnedFile(
        `${DA3_WEIGHTS_REPO}/${pin.name}`,
        join(this.modelDir, pin.name),
        pin,
        signal,
        (bytesOnDisk) => {
          this.emit('progress', {
            phase: 'weights',
            message: `Downloading Depth Anything 3 weights (${pin.name})`,
            fraction: Math.min((completed + bytesOnDisk) / total, 1),
          })
        },
      )
      downloaded.push(record)
      completed += pin.sizeBytes
    }
    return downloaded
  }
}

/** The server ignored our Range request, so a resume must restart from zero. */
class RangeNotSupportedError extends Error {
  constructor(url: string) {
    super(`server ignored the Range request for ${url}`)
  }
}

/** The destination's current size, or null when it does not exist yet. */
async function sizeOnDisk(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** Feed an existing partial file through the hash so a resume stays one pass. */
function hashFileInto(path: string, hash: Hash): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
}

/**
 * Download a pinned file, verifying size and sha256, with up to three attempts.
 * A partial file left by a failed attempt resumes with an HTTP Range request
 * (the hash is rebuilt from the partial bytes first, so the digest still covers
 * the whole file); a server that ignores Range triggers a clean restart instead.
 * A file that fails verification is deleted so the next attempt starts over.
 */
async function downloadPinnedFile(
  url: string,
  dest: string,
  pin: PinnedFile,
  signal: AbortSignal,
  onProgress: (bytesOnDisk: number) => void,
): Promise<DownloadedFile> {
  let failures = 0
  for (;;) {
    const offset = resumeOffset(await sizeOnDisk(dest), pin.sizeBytes)
    try {
      const hash = createHash('sha256')
      if (offset > 0) await hashFileInto(dest, hash)
      await streamToFile(url, dest, offset, hash, signal, onProgress)
      const size = (await sizeOnDisk(dest)) ?? 0
      const sha256 = hash.digest('hex')
      const problem = integrityError(pin, size, sha256)
      if (problem) {
        await rm(dest, { force: true })
        throw new Error(`corrupt download from ${url}: ${problem}`)
      }
      return { name: pin.name, sizeBytes: size, sha256 }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof RangeNotSupportedError) {
        // Restart clean without consuming an attempt: with no partial file left,
        // the next pass sends no Range header, so this cannot loop.
        await rm(dest, { force: true })
        continue
      }
      failures += 1
      if (failures >= DOWNLOAD_ATTEMPTS) throw error
    }
  }
}

/**
 * One streaming request: write the body to `dest` (appending past a resume
 * offset), feed every byte to `hash`, and report cumulative bytes on disk. The
 * offset is preserved across redirects; past the redirects, a resume expects
 * 206 Partial Content and treats a plain 200 as "Range unsupported".
 */
function streamToFile(
  url: string,
  dest: string,
  offset: number,
  hash: Hash,
  signal: AbortSignal,
  onProgress: (bytesOnDisk: number) => void,
  depth = 0,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
    if (depth > 5) return reject(new Error(`too many redirects for ${url}`))
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined
    const req = httpsGet(url, { signal, headers }, (res) => {
      const { statusCode = 0, headers: resHeaders } = res
      if (statusCode >= 300 && statusCode < 400 && resHeaders.location) {
        res.resume()
        resolve(
          streamToFile(resHeaders.location, dest, offset, hash, signal, onProgress, depth + 1),
        )
        return
      }
      if (offset > 0 && statusCode === 200) {
        res.destroy()
        reject(new RangeNotSupportedError(url))
        return
      }
      if (statusCode !== (offset > 0 ? 206 : 200)) {
        res.resume()
        reject(new Error(`download failed (${statusCode}) for ${url}`))
        return
      }
      let written = offset
      const file = createWriteStream(dest, offset > 0 ? { flags: 'a' } : undefined)
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        written += chunk.length
        onProgress(written)
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', (error) => {
        res.destroy()
        reject(error)
      })
      // A connection dropped mid-body errors on the response, not the request.
      // Close the file so its flushed length is what the resume offset sees.
      res.on('error', (error) => {
        file.destroy()
        reject(error)
      })
    })
    req.on('error', reject)
  })
}
