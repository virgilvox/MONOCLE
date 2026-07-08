import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'

/**
 * Resolve `path` to a real path and refuse anything outside the OS temp
 * directory. Renderer-supplied paths (artifact reads/exports, session ids) run
 * through this so the renderer can never reach arbitrary files on disk. Returns
 * the canonical path to operate on.
 */
export async function assertUnderTmp(path: string): Promise<string> {
  const real = await realpath(path)
  const base = await realpath(tmpdir())
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error('refused to access a file outside the temp directory')
  }
  return real
}
