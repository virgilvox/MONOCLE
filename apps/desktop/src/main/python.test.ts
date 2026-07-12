import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePython } from './python'

// The resolution order is what makes a shipped build self-contained while dev
// stays convenient: an explicit override always wins; a packaged build then
// prefers the bundled interpreter; development prefers the full dev venv (so the
// heavy backends run without an override) over the walk-only bundled tree. A
// wrong order silently ships a build that cannot reconstruct, so it is pinned
// here.

const sidecarDir = '/app/sidecar'
const bundledDir = '/app/python'
const never = () => false

describe('resolvePython', () => {
  it('honors an explicit MONOCLE_PYTHON override without touching disk', () => {
    const r = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'darwin',
      env: { MONOCLE_PYTHON: '/opt/py/bin/python3' },
      exists: never,
    })
    expect(r).toEqual({ path: '/opt/py/bin/python3', source: 'env' })
  })

  it('prefers the bundled interpreter in a packaged build', () => {
    const bundled = join(bundledDir, 'bin', 'python3')
    const r = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'darwin',
      isPackaged: true,
      env: {},
      exists: () => true, // both bundled and venv present
    })
    expect(r).toEqual({ path: bundled, source: 'bundled' })
  })

  it('prefers the dev venv over the bundled interpreter in development', () => {
    const venv = join(sidecarDir, '.venv', 'bin', 'python')
    const r = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'darwin',
      isPackaged: false,
      env: {},
      exists: () => true, // both bundled and venv present; dev must pick the venv
    })
    expect(r).toEqual({ path: venv, source: 'venv' })
  })

  it('falls back to the bundled interpreter in development when no venv exists', () => {
    const bundled = join(bundledDir, 'bin', 'python3')
    const r = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'darwin',
      isPackaged: false,
      env: {},
      exists: (p) => p === bundled,
    })
    expect(r).toEqual({ path: bundled, source: 'bundled' })
  })

  it('falls back to the dev venv when no bundled interpreter is present', () => {
    const venv = join(sidecarDir, '.venv', 'bin', 'python')
    const r = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'darwin',
      env: {},
      exists: (p) => p === venv,
    })
    expect(r).toEqual({ path: venv, source: 'venv' })
  })

  it('falls back to system python3 when nothing is bundled or installed', () => {
    const r = resolvePython({ sidecarDir, platform: 'darwin', env: {}, exists: never })
    expect(r).toEqual({ path: 'python3', source: 'system' })
  })

  it('uses Windows interpreter layouts and command', () => {
    const bundled = join(bundledDir, 'python.exe')
    const win = resolvePython({
      sidecarDir,
      bundledDir,
      platform: 'win32',
      env: {},
      exists: (p) => p === bundled,
    })
    expect(win).toEqual({ path: bundled, source: 'bundled' })

    const system = resolvePython({ sidecarDir, platform: 'win32', env: {}, exists: never })
    expect(system).toEqual({ path: 'python', source: 'system' })
  })
})
