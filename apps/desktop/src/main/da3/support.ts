/**
 * Whether this machine can run the Depth Anything 3 multi-view pack, and if not,
 * why.
 *
 * DA3 needs PyTorch, and torch's prebuilt wheels decide where the pack can
 * install: recent arm64-macOS wheels require macOS 14+, there is no x86_64-macOS
 * torch wheel past 2.2, and arm64 Linux has no open3d/pycolmap wheels. So the
 * pack is only offered where the whole stack actually installs; everywhere else
 * the UI shows the plain reason instead of letting a multi-gigabyte download run
 * only to fail at `pip install`.
 *
 * Pure and injectable so it is unit tested without touching the real OS.
 */

export interface Da3Support {
  supported: boolean
  /** A plain sentence shown in the UI when unsupported. Empty when supported. */
  reason: string
}

export interface Da3Platform {
  platform: NodeJS.Platform
  arch: string
  /** os.release() (the Darwin kernel version on macOS), used to derive the macOS major. */
  release: string
}

// Darwin kernel major -> macOS: 21=12, 22=13, 23=14, 24=15. torch's arm64-macOS
// wheels need macOS 14, i.e. Darwin >= 23.
const MIN_DARWIN_MAJOR = 23

/** Assess whether the DA3 download can install and run here. */
export function da3Support({ platform, arch, release }: Da3Platform): Da3Support {
  if (platform === 'darwin') {
    if (arch !== 'arm64') {
      return {
        supported: false,
        reason: 'Depth Anything 3 needs an Apple Silicon Mac; PyTorch has no Intel-Mac build.',
      }
    }
    const darwinMajor = Number.parseInt(release.split('.')[0] ?? '', 10)
    if (!Number.isFinite(darwinMajor) || darwinMajor < MIN_DARWIN_MAJOR) {
      return {
        supported: false,
        reason: 'Depth Anything 3 needs macOS 14 or newer; PyTorch dropped the older macOS build.',
      }
    }
    return { supported: true, reason: '' }
  }
  if (platform === 'win32') {
    return arch === 'x64'
      ? { supported: true, reason: '' }
      : { supported: false, reason: 'Depth Anything 3 needs 64-bit Windows.' }
  }
  if (platform === 'linux') {
    return arch === 'x64'
      ? { supported: true, reason: '' }
      : {
          supported: false,
          reason: 'Depth Anything 3 is not available on ARM Linux (no prebuilt wheels).',
        }
  }
  return { supported: false, reason: 'Depth Anything 3 is not available on this platform.' }
}
