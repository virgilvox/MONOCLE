import { describe, expect, it } from 'vitest'
import {
  humanDa3InstallError,
  humanReconstructError,
  isDa3CancelMessage,
  unwrapIpcError,
} from './errors'

describe('unwrapIpcError', () => {
  it('strips the Electron IPC wrapper and the error-class name', () => {
    expect(
      unwrapIpcError(
        "Error invoking remote method 'sidecar:reconstruct': RpcError: walk-around could not establish a metric scale: ...",
      ),
    ).toBe('walk-around could not establish a metric scale: ...')
  })

  it('strips a bare Error: prefix without the IPC wrapper', () => {
    expect(unwrapIpcError('Error: pipeline crashed')).toBe('pipeline crashed')
  })

  it('strips nested class names', () => {
    expect(unwrapIpcError('Error: RpcError: no frames staged')).toBe('no frames staged')
  })

  it('is idempotent on an already-clean message', () => {
    const clean = 'walk-around could not establish a metric scale: try a slower sweep'
    expect(unwrapIpcError(clean)).toBe(clean)
    expect(unwrapIpcError(unwrapIpcError(clean))).toBe(clean)
  })

  it('keeps colons inside the detail intact', () => {
    expect(
      unwrapIpcError("Error invoking remote method 'da3:install': fetch failed: offline"),
    ).toBe('fetch failed: offline')
  })
})

describe('humanReconstructError', () => {
  it('maps known sidecar failures to plain guidance', () => {
    expect(humanReconstructError('no frames found in /tmp/x')).toMatch(/capture a scan/i)
    expect(humanReconstructError('reconstruction timed out')).toMatch(/too long/i)
    expect(humanReconstructError('multi-view fusion produced an empty mesh')).toMatch(
      /no geometry/i,
    )
    expect(humanReconstructError('gaussians need a giant checkpoint')).toMatch(/giant/i)
    expect(humanReconstructError("No module named 'open3d'")).toMatch(/not installed/i)
  })

  it('maps a wrapped known failure the same as a bare one', () => {
    expect(
      humanReconstructError(
        "Error invoking remote method 'sidecar:reconstruct': RpcError: no frames staged",
      ),
    ).toMatch(/capture a scan/i)
  })

  it('wraps an unknown failure in a friendly line with the unwrapped detail', () => {
    const wrapped =
      "Error invoking remote method 'sidecar:reconstruct': RpcError: walk-around could not establish a metric scale: not enough parallax"
    expect(humanReconstructError(wrapped)).toBe(
      'Reconstruction failed: walk-around could not establish a metric scale: not enough parallax',
    )
    // The raw wrapper must never reach the user.
    expect(humanReconstructError(wrapped)).not.toContain('invoking remote method')
  })

  it('falls back to a plain sentence when the detail is empty', () => {
    expect(humanReconstructError('Error: ')).toBe('Reconstruction failed.')
  })
})

describe('humanDa3InstallError', () => {
  it('maps network failures to a connection hint', () => {
    expect(humanDa3InstallError('fetch failed')).toMatch(/network/i)
    expect(humanDa3InstallError('getaddrinfo ENOTFOUND huggingface.co')).toMatch(/network/i)
    expect(
      humanDa3InstallError("Error invoking remote method 'da3:install': Error: read ECONNRESET"),
    ).toMatch(/network/i)
  })

  it('maps a full disk to a free-space hint', () => {
    expect(humanDa3InstallError('ENOSPC: no space left on device')).toMatch(/disk space/i)
  })

  it('maps a pip failure to the Diagnostics log', () => {
    expect(humanDa3InstallError('pip install exited with code 1')).toMatch(/diagnostics/i)
  })

  it('wraps an unknown failure with the unwrapped detail', () => {
    expect(
      humanDa3InstallError("Error invoking remote method 'da3:install': Error: archive corrupt"),
    ).toBe('The pack install failed: archive corrupt')
  })
})

describe('isDa3CancelMessage', () => {
  it('recognizes the explicit cancelled message from runPip', () => {
    expect(isDa3CancelMessage('install cancelled')).toBe(true)
  })

  it('recognizes a mid-stream AbortError from the weights download', () => {
    expect(isDa3CancelMessage('The operation was aborted')).toBe(true)
    expect(
      isDa3CancelMessage(
        "Error invoking remote method 'da3:install': AbortError: The operation was aborted",
      ),
    ).toBe(true)
  })

  it('does not swallow real failures', () => {
    expect(isDa3CancelMessage('fetch failed')).toBe(false)
    expect(isDa3CancelMessage('ENOSPC: no space left on device')).toBe(false)
    expect(isDa3CancelMessage('pip install exited with code 1')).toBe(false)
  })
})
