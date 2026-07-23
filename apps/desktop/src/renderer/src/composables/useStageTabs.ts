/**
 * The workspace stage tabs (Camera, Live depth, 3D Preview): which one is
 * selected, when the Preview tab unlocks, ARIA roving focus across the tablist,
 * and the auto-jump to the preview when a reconstruction lands.
 */

import { ref, watch, type Ref } from 'vue'
import type { IconName } from '../components/icons/registry'
import { useCaptureStore } from '../stores/capture'

export type StageView = 'camera' | 'live' | 'preview'

/** The three stage tabs, backed by icon and label. */
export const STAGE_TABS: { id: StageView; label: string; icon: IconName }[] = [
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'live', label: 'Live depth', icon: 'lens' },
  { id: 'preview', label: '3D Preview', icon: 'wireframe' },
]

export function useStageTabs(liveActive: Ref<boolean>) {
  const capture = useCaptureStore()

  const stageView = ref<StageView>('camera')
  const stageTabsEl = ref<HTMLElement | null>(null)
  // A tab the user picked while a run was underway is their choice of view;
  // the finished result must not yank them away from it. Picks made while idle
  // do not count, so the common flow (start a scan, wait) still lands on the
  // preview automatically.
  let userPickedTab = false

  function selectTab(id: StageView): void {
    stageView.value = id
    if (capture.importing || capture.reconstructing) userPickedTab = true
  }

  /** The Preview tab is unavailable until there is something to show. */
  function tabDisabled(id: StageView): boolean {
    return id === 'preview' && !capture.result && !liveActive.value
  }

  // Arrow-key roving focus across the tablist, as ARIA tabs expect: Left/Right
  // move between enabled tabs (wrapping), Home/End jump to the ends, and focus
  // follows selection. Only the active tab is in the tab order (roving tabindex).
  function onTabsKeydown(event: KeyboardEvent): void {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const enabled = STAGE_TABS.filter((tab) => !tabDisabled(tab.id))
    if (enabled.length === 0) return
    const current = Math.max(
      0,
      enabled.findIndex((tab) => tab.id === stageView.value),
    )
    const last = enabled.length - 1
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (current + 1) % enabled.length
            : (current - 1 + enabled.length) % enabled.length
    const target = enabled[next]
    if (!target) return
    selectTab(target.id)
    stageTabsEl.value?.querySelector<HTMLButtonElement>(`#stage-tab-${target.id}`)?.focus()
  }

  // Each new run resets the choice: the guard protects navigation within one
  // run only. Import (decode) and reconstruction are one combined busy signal;
  // the store hands off importing -> reconstructing in the same tick, so a tab
  // picked during a long video decode survives into the reconstruction.
  watch(
    () => capture.importing || capture.reconstructing,
    (busy, wasBusy) => {
      if (busy && !wasBusy) userPickedTab = false
    },
  )

  // Jump to the 3D preview once a reconstruction lands, unless the user chose
  // their own view while the run was in progress.
  watch(
    () => capture.result,
    (result) => {
      if (result && !userPickedTab) stageView.value = 'preview'
    },
  )

  return { stageView, stageTabsEl, selectTab, tabDisabled, onTabsKeydown }
}
