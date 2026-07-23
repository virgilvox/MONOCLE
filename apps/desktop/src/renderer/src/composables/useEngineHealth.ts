/**
 * The engine's health as the header and alert surfaces read it: a plain label,
 * a status-indicator state, and a restart action for when it has failed, so the
 * user never has to dig into Diagnostics. The status stream flips the alert
 * away on recovery.
 */

import { computed, ref } from 'vue'
import type { Status } from '../components/StatusIndicator.vue'
import { useEngineStore } from '../stores/engine'
import type { SidecarStatus } from '../../../shared/ipc'

const ENGINE_LABELS: Record<SidecarStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  error: 'Error',
}

export function useEngineHealth() {
  const engine = useEngineStore()

  const engineLabel = computed(() => ENGINE_LABELS[engine.status])
  const engineState = computed<Status>(
    () =>
      ({ stopped: 'idle', starting: 'busy', ready: 'ok', error: 'danger' })[
        engine.status
      ] as Status,
  )

  const restarting = ref(false)
  async function restart(): Promise<void> {
    if (restarting.value) return
    restarting.value = true
    try {
      await engine.restart()
    } catch (error) {
      // start() can reject when the sidecar cannot spawn. The status stream already
      // reflects the failure and the alert stays up, so log and let the user retry
      // rather than surface an unhandled rejection.
      console.error('engine restart failed', error)
    } finally {
      restarting.value = false
    }
  }

  return { engineLabel, engineState, restarting, restart }
}
