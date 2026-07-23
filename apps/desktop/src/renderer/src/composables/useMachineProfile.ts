/**
 * What this machine can do, combining the sidecar's reconstruction device with
 * the renderer's WebGPU/WebGL2 tier. Feeds the advisor and keeps the capture
 * store's recommended default method current as capabilities land.
 */

import { computed, watch } from 'vue'
import { recommendedDefault, toComputeDevice, type MachineProfile } from '../lib/capability'
import { useCaptureStore } from '../stores/capture'
import { useDa3Store } from '../stores/da3'
import { useEngineStore } from '../stores/engine'
import { useGpu } from './useGpu'

export function useMachineProfile() {
  const { capabilities, detect } = useGpu()
  const capture = useCaptureStore()
  const da3 = useDa3Store()
  const engine = useEngineStore()

  const machineProfile = computed<MachineProfile>(() => ({
    torchDevice: toComputeDevice(engine.torchDevice),
    webgpu: capabilities.value.webgpu,
    webgl2: capabilities.value.webgl2,
    crossOriginIsolated: capabilities.value.crossOriginIsolated,
  }))

  // DA3 can run whenever the sidecar has torch (a real reported device, e.g. a dev
  // venv) or the downloaded pack is present. It recovers depth and pose jointly, so
  // it is more robust than the hand-rolled walk-around; prefer it whenever available
  // and fall back to the walk-around only when it is not. Re-runs when the pack
  // downloads or the engine reports its device, so DA3 becomes the default the moment
  // it is available. The store folds this into effectiveBackend unless the user has
  // pinned a model in Advanced.
  const da3Available = computed(
    () => da3.installed || machineProfile.value.torchDevice !== 'unknown',
  )
  watch(
    [machineProfile, da3Available],
    ([profile, available]) => capture.setRecommendedBackend(recommendedDefault(profile, available)),
    { immediate: true },
  )

  return { capabilities, detect, machineProfile }
}
