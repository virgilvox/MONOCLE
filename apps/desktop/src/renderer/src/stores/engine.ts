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
  /** The sidecar's reconstruction compute device (cpu/mps/cuda), once ready. */
  const torchDevice = ref<string | null>(null)
  let bound = false

  function bind(): void {
    if (bound) return
    bound = true
    void window.api.sidecar.getStatus().then((current) => {
      status.value = current
      if (current === 'ready') onReady()
    })
    window.api.sidecar.onStatus((next) => {
      status.value = next
      if (next === 'ready') onReady()
    })
    window.api.sidecar.onLog((note) => {
      logs.value = [...logs.value, note].slice(-MAX_LOG_LINES)
    })
    window.api.sidecar.onProgress((note) => {
      progress.value = note
    })
  }

  /** Clear the progress note so a new reconstruction starts from empty, not the
   * previous run's completed bar. */
  function resetProgress(): void {
    progress.value = null
  }

  /** On a ready sidecar, load what the UI needs from it: backends and device. */
  function onReady(): void {
    void loadBackends()
    void window.api.sidecar
      .getDevice()
      .then((device) => {
        torchDevice.value = device
      })
      .catch(() => {
        torchDevice.value = null
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

  /** Bring a failed or stopped engine back up: stop cleanly, then start. */
  async function restart(): Promise<void> {
    try {
      await window.api.sidecar.stop()
    } catch {
      // Already down; starting is what matters.
    }
    await window.api.sidecar.start()
  }

  /** The most recent error-level log line, as a short reason for a failure. */
  function lastErrorMessage(): string | null {
    for (let i = logs.value.length - 1; i >= 0; i -= 1) {
      const note = logs.value[i]
      if (note && note.level === 'error') return note.message
    }
    return null
  }

  return {
    status,
    logs,
    backends,
    progress,
    torchDevice,
    bind,
    loadBackends,
    resetProgress,
    start,
    stop,
    restart,
    lastErrorMessage,
  }
})
