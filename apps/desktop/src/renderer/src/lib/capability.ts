/**
 * Turn what we know about the machine into plain guidance: which reconstruction
 * methods will run, roughly how fast, and which one to default to.
 *
 * MONOCLE wraps around Depth Anything 3, but DA3 is heavy and slow on a CPU-only
 * box, so the right default depends on the hardware. This module is the single
 * place that encodes that judgement. It is pure (no DOM, no I/O) so it is unit
 * tested and reused by both the simple and advanced UI: the advisor panel reads
 * the assessments, and the store reads the recommended default.
 *
 * The two compute tiers are independent. The renderer light path (live depth
 * preview) runs on WebGPU or a WebGL2/wasm floor; the sidecar heavy path
 * (reconstruction) runs on the torch device the sidecar reports (cpu / mps /
 * cuda). A machine can be strong on one and weak on the other.
 */

import type { ReconstructDevice } from '@monoclejs/protocol'

/** The sidecar's reconstruction compute device, from the health handshake. */
export type ComputeDevice = 'cpu' | 'mps' | 'cuda' | 'unknown'

/** A coarse, honest expectation of speed. Not a benchmark, a heads-up. */
export type SpeedTier = 'fast' | 'moderate' | 'slow' | 'unavailable'

/** What we know about the machine's two compute tiers. */
export interface MachineProfile {
  /** Sidecar heavy-path device (reconstruction). */
  torchDevice: ComputeDevice
  /** Renderer can run the live-depth model on WebGPU (fast). */
  webgpu: boolean
  /** Renderer has at least the WebGL2 floor. */
  webgl2: boolean
  /**
   * Whether the renderer is cross-origin isolated. When true, SharedArrayBuffer
   * exists and the live-depth wasm fallback could run on multiple threads. The app
   * no longer sets COOP/COEP (isolation broke WebGPU device acquisition on Apple
   * Silicon), so this is false in shipped builds.
   */
  crossOriginIsolated: boolean
}

/** How a reconstruction method is expected to behave on this machine. */
export interface MethodCapability {
  /** Backend id, matching listBackends and the scan presets. */
  backend: string
  label: string
  speed: SpeedTier
  /** One plain sentence a non-expert can act on. */
  note: string
  /** Weights are non-commercial (gated in a shippable build). */
  nonCommercial?: boolean
}

const SPEED_BY_DEVICE: Record<ComputeDevice, { da3: SpeedTier; walk: SpeedTier }> = {
  cuda: { da3: 'fast', walk: 'fast' },
  mps: { da3: 'moderate', walk: 'fast' },
  cpu: { da3: 'slow', walk: 'moderate' },
  unknown: { da3: 'slow', walk: 'moderate' },
}

const DEVICE_LABEL: Record<ComputeDevice, string> = {
  cuda: 'NVIDIA GPU',
  mps: 'Apple GPU',
  cpu: 'CPU only',
  unknown: 'unknown device',
}

/**
 * Assess every reconstruction method for this machine, best default first.
 *
 * Depth Anything 3 is the quality anchor but is only pleasant on a GPU; on CPU
 * the Depth Anything V2 walk-around is the faster path. The single-view snapshot
 * is always fast. Gaussian output needs the giant DA3 weights and real GPU
 * muscle, so it is unavailable off CUDA.
 */
export function assessMethods(profile: MachineProfile): MethodCapability[] {
  const device = profile.torchDevice
  const speed = SPEED_BY_DEVICE[device]
  return [
    {
      backend: 'depth-anything-3',
      label: 'Depth Anything 3 (multi-view)',
      speed: speed.da3,
      note:
        speed.da3 === 'slow'
          ? 'Highest quality, but slow on this machine. Expect minutes per scan.'
          : 'Recovers geometry and camera pose jointly. The best all-round quality.',
    },
    {
      backend: 'depth-anything-v2-walk',
      label: 'Walk-around (Depth Anything V2)',
      speed: speed.walk,
      note: 'Faster than DA3 and runs well on CPU. Good for a walk-around capture.',
    },
    {
      backend: 'depth-anything-v2-small',
      label: 'Quick depth snapshot',
      speed: 'fast',
      note: 'One frame to a depth mesh. The fastest way to any result.',
    },
  ]
}

/**
 * Whether the live-depth wasm fallback can run multi-threaded on this machine.
 * Threads only help the wasm execution provider, which is used when WebGPU is
 * absent, and SharedArrayBuffer only exists under cross-origin isolation. This
 * mirrors exactly the condition the depth worker uses to raise numThreads.
 */
export function threadedWasmAvailable(profile: MachineProfile): boolean {
  return !profile.webgpu && profile.crossOriginIsolated
}

/** Whether the live in-app depth preview will run, and how smoothly. */
export function livePreviewSupport(profile: MachineProfile): {
  speed: SpeedTier
  note: string
} {
  if (profile.webgpu) {
    return { speed: 'fast', note: 'Live depth preview runs smoothly on your GPU (WebGPU).' }
  }
  if (profile.webgl2) {
    return {
      speed: 'slow',
      note: threadedWasmAvailable(profile)
        ? 'Live depth preview runs without WebGPU, on multiple CPU threads.'
        : 'Live depth preview runs without WebGPU, at reduced speed.',
    }
  }
  return { speed: 'unavailable', note: 'Live depth preview is not supported here.' }
}

/**
 * The backend to default to on this machine: Depth Anything 3 whenever it can
 * run, otherwise the walk-around.
 *
 * DA3 recovers depth and camera pose jointly with a trained model, so it is
 * robust where the hand-rolled walk-around (monocular VO + scale + loop closure)
 * drifts and garbles. That robustness is worth the speed, so DA3 is preferred
 * even on CPU (slower but correct); the walk-around is the fallback only when DA3
 * is unavailable (no torch, and the pack not installed). ``da3Available`` reflects
 * whether the sidecar can actually run DA3, so with the lean installer it is the
 * default the moment torch is present (a dev venv, or the downloaded pack).
 *
 * ``profile`` is retained for callers and future tuning; the choice is now purely
 * availability-driven, since correctness beats speed for the default.
 */
export function recommendedDefault(_profile: MachineProfile, da3Available = true): string {
  return da3Available ? 'depth-anything-3' : 'depth-anything-v2-walk'
}

/** A one-line summary of the machine for the header or advisor panel. */
export function describeMachine(profile: MachineProfile): string {
  const gpu = profile.webgpu ? 'WebGPU' : profile.webgl2 ? 'WebGL2' : 'no GPU'
  return `${DEVICE_LABEL[profile.torchDevice]} reconstruction, ${gpu} preview`
}

/** Normalize an arbitrary torchDevice string from the sidecar into our union. */
export function toComputeDevice(value: string | null | undefined): ComputeDevice {
  if (value === 'cuda' || value === 'mps' || value === 'cpu') return value
  return 'unknown'
}

/**
 * Whether the machine currently offers a given heavy-path compute device. `auto`
 * and `cpu` are always available; `mps` and `cuda` only when the sidecar reported
 * that device. The advanced lever still lets a user pick an unavailable GPU (so a
 * later machine can use it), and this drives the "not detected" annotation.
 */
export function deviceAvailable(device: ReconstructDevice, profile: MachineProfile): boolean {
  if (device === 'auto' || device === 'cpu') return true
  return profile.torchDevice === device
}
