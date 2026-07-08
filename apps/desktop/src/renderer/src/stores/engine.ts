import type { BackendInfo, LogNote, ProgressNote } from '@monoclejs/protocol'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SidecarStatus } from '../../../shared/ipc'

const MAX_LOG_LINES = 200

/**
 * Tracks the inference sidecar as the renderer sees it: status, a bounded log
 * tail, the available backends, and the latest reconstruction progress note.
 * Subscribes to the main-process event streams once.
 */
export const useEngineStore = defineStore('engine', () => {
  const status = ref<SidecarStatus>('stopped')
  const logs = ref<LogNote[]>([])
  const backends = ref<BackendInfo[]>([])
  const progress = ref<ProgressNote | null>(null)
  let bound = false

  function bind(): void {
    if (bound) return
    bound = true
    void window.api.sidecar.getStatus().then((current) => {
      status.value = current
      if (current === 'ready') void loadBackends()
    })
    window.api.sidecar.onStatus((next) => {
      status.value = next
      if (next === 'ready') void loadBackends()
    })
    window.api.sidecar.onLog((note) => {
      logs.value = [...logs.value, note].slice(-MAX_LOG_LINES)
    })
    window.api.sidecar.onProgress((note) => {
      progress.value = note
    })
  }

  async function loadBackends(): Promise<void> {
    try {
      backends.value = await window.api.sidecar.listBackends()
    } catch {
      backends.value = []
    }
  }

  async function start(): Promise<void> {
    await window.api.sidecar.start()
  }

  async function stop(): Promise<void> {
    await window.api.sidecar.stop()
  }

  return { status, logs, backends, progress, bind, loadBackends, start, stop }
})
