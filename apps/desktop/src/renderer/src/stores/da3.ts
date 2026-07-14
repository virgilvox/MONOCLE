import type { Da3Progress, Da3Status } from '../../../shared/ipc'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Client-side state for the optional Depth Anything 3 pack. Mirrors the main
 * process: it holds the last reported status, streams install progress, and
 * exposes the three actions (install, cancel, remove). The heavy lifting (the
 * multi-gigabyte download and the pip install) all happens in main; this store
 * only reflects it and drives the pack panel.
 */
export const useDa3Store = defineStore('da3', () => {
  const status = ref<Da3Status | null>(null)
  const progress = ref<Da3Progress | null>(null)
  const error = ref<string | null>(null)

  const installed = computed(() => status.value?.installed ?? false)
  const installing = computed(() => status.value?.installing ?? false)
  const supported = computed(() => status.value?.supported ?? false)
  const reason = computed(() => status.value?.reason ?? '')
  const sizeGb = computed(() =>
    status.value ? (status.value.sizeEstimateBytes / 1e9).toFixed(1) : '3.0',
  )
  /** Install completion percent when known (the weights download), else null. */
  const percent = computed(() =>
    progress.value?.fraction != null ? Math.round(progress.value.fraction * 100) : null,
  )

  async function refresh(): Promise<void> {
    status.value = await window.api.da3.getStatus()
  }

  async function install(): Promise<void> {
    error.value = null
    progress.value = null
    try {
      await window.api.da3.install()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // A user cancel is not an error; the state stream flips installing off.
      error.value = /cancel/i.test(message) ? null : message
    }
  }

  async function cancel(): Promise<void> {
    await window.api.da3.cancel()
  }

  async function remove(): Promise<void> {
    error.value = null
    await window.api.da3.remove()
  }

  // Reflect main's pushes. Registered once for the store's lifetime.
  window.api.da3.onState((next) => {
    status.value = next
    if (!next.installing) progress.value = null
  })
  window.api.da3.onProgress((next) => {
    progress.value = next
  })

  return {
    status,
    progress,
    error,
    installed,
    installing,
    supported,
    reason,
    sizeGb,
    percent,
    refresh,
    install,
    cancel,
    remove,
  }
})
