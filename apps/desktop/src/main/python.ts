import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Choosing the Python interpreter that runs the inference sidecar.
 *
 * A shipped build must be able to reconstruct a real scan without the user
 * installing anything, so a relocatable interpreter with the `walk` extra is
 * bundled into the app's resources (see scripts/bundle-python.mjs and
 * docs/BUILD.md). In a packaged build this bundled interpreter is picked first.
 *
 * In development the order is deliberately flipped to prefer the sidecar's dev
 * virtualenv over the bundled interpreter, because the bundled tree carries only
 * the shippable extras (walk, no torch) while a dev venv typically has the full
 * stack (reconstruct + multiview + slam). Preferring the venv in dev means the
 * heavy backends (Depth Anything 3, the walk-around) run under `pnpm dev:desktop`
 * without a manual MONOCLE_PYTHON override.
 *
 * The resolution is pure and injectable so it can be unit-tested without a real
 * filesystem.
 */

export type PythonSource = 'env' | 'bundled' | 'venv' | 'system'

export interface PythonResolution {
  /** The interpreter to spawn: an absolute path, or a bare command on PATH. */
  path: string
  /** Which candidate won, for diagnostics. */
  source: PythonSource
}

export interface ResolveContext {
  /** Directory the sidecar package lives in; its `.venv` is the dev fallback. */
  sidecarDir: string
  /** Directory holding the bundled standalone interpreter tree, if any. */
  bundledDir?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /**
   * Whether the app is packaged. In development (false) the dev venv is
   * preferred over the depth/walk-only bundled interpreter so heavy backends run
   * without an override. Defaults to true, keeping the self-contained production
   * order (bundled first) unless a caller says otherwise.
   */
  isPackaged?: boolean
  /** Injectable for tests; defaults to the real filesystem. */
  exists?: (path: string) => boolean
}

/** The interpreter path inside a python-build-standalone tree. */
function bundledInterpreter(bundledDir: string, isWindows: boolean): string {
  return isWindows ? join(bundledDir, 'python.exe') : join(bundledDir, 'bin', 'python3')
}

/** The interpreter path inside a virtualenv. */
function venvInterpreter(sidecarDir: string, isWindows: boolean): string {
  return isWindows
    ? join(sidecarDir, '.venv', 'Scripts', 'python.exe')
    : join(sidecarDir, '.venv', 'bin', 'python')
}

/**
 * Resolve the interpreter. An explicit override always wins. Then, in a packaged
 * build, the bundled interpreter is preferred (self-contained release); in
 * development the dev venv is preferred (it carries the full inference stack).
 * Both orders fall back to the other candidate and finally to system Python.
 */
export function resolvePython(ctx: ResolveContext): PythonResolution {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const exists = ctx.exists ?? existsSync
  const isWindows = platform === 'win32'
  const isPackaged = ctx.isPackaged ?? true

  // An explicit override always wins; it may be a bare command on PATH, so it
  // is trusted without a filesystem check.
  const override = env.MONOCLE_PYTHON
  if (override) return { path: override, source: 'env' }

  const venv = venvInterpreter(ctx.sidecarDir, isWindows)
  const bundled = ctx.bundledDir ? bundledInterpreter(ctx.bundledDir, isWindows) : null

  // In development the dev venv (full extras) beats the bundled interpreter
  // (walk extra only), so DA3 and the walk-around run without an override.
  if (!isPackaged && exists(venv)) return { path: venv, source: 'venv' }
  if (bundled && exists(bundled)) return { path: bundled, source: 'bundled' }
  if (exists(venv)) return { path: venv, source: 'venv' }

  return { path: isWindows ? 'python' : 'python3', source: 'system' }
}
