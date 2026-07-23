/**
 * Derives the linear workflow for the stepper. Camera and capture steps only
 * appear for presets that actually use the camera; synthetic goes straight from
 * preset to reconstruct.
 */

import { computed, type Ref } from 'vue'
import type { Step } from '../components/WorkflowStepper.vue'
import type { IconName } from '../components/icons/registry'
import { useCaptureStore } from '../stores/capture'

export function useWorkflowSteps(cameraActive: Ref<boolean>) {
  const capture = useCaptureStore()

  const activeStepKey = computed(() => {
    if (capture.reconstructing || capture.result) return 'reconstruct'
    if (capture.usesCamera) {
      if (capture.scanning || capture.frameCount > 0) return 'capture'
      if (cameraActive.value) return 'camera'
      return 'preset'
    }
    return 'reconstruct'
  })

  const workflowSteps = computed<Step[]>(() => {
    const ordered: { key: string; label: string; icon: IconName }[] = [
      { key: 'preset', label: 'Preset', icon: 'iris' },
    ]
    if (capture.usesCamera) {
      ordered.push({ key: 'camera', label: 'Camera', icon: 'camera' })
      ordered.push({ key: 'capture', label: 'Capture', icon: 'focus-box' })
    }
    ordered.push({ key: 'reconstruct', label: 'Reconstruct', icon: 'wireframe' })

    const activeIndex = ordered.findIndex((s) => s.key === activeStepKey.value)
    return ordered.map((step, index) => ({
      ...step,
      state: capture.result
        ? 'done'
        : index < activeIndex
          ? 'done'
          : index === activeIndex
            ? 'active'
            : 'upcoming',
    }))
  })

  return { workflowSteps }
}
