import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Choosing the Python interpreter that runs the inference sidecar.
 *
 * A shipped build must be able to reconstruct a real scan without the user
 * installing anything, so a relocatable interpreter with the `depth` extra is
 * bundled into the app's resources (see scripts/bundle-python.mjs and
 * docs/BUILD.md). This module picks that bundled interpreter first and only
 * falls back to a developer virtualenv or the system Python when it is absent,
 * so development stays convenient while releases stay self-contained.
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
 * Resolve the interpreter, preferring an explicit override, then the bundled
 * interpreter, then a developer virtualenv, and finally the system Python.
 */
export function resolvePython(ctx: ResolveContext): PythonResolution {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const exists = ctx.exists ?? existsSync
  const isWindows = platform === 'win32'

  // An explicit override always wins; it may be a bare command on PATH, so it
  // is trusted without a filesystem check.
  const override = env.MONOCLE_PYTHON
  if (override) return { path: override, source: 'env' }

  if (ctx.bundledDir) {
    const bundled = bundledInterpreter(ctx.bundledDir, isWindows)
    if (exists(bundled)) return { path: bundled, source: 'bundled' }
  }

  const venv = venvInterpreter(ctx.sidecarDir, isWindows)
  if (exists(venv)) return { path: venv, source: 'venv' }

  return { path: isWindows ? 'python' : 'python3', source: 'system' }
}
