<script setup lang="ts">
/**
 * Surfaces the in-app auto-updater. It stays out of the way until the main
 * process reports a newer release, then walks the user through it: Download,
 * live progress, then Restart to update. Downloads never start on their own.
 *
 * The component owns its own state and subscribes to the updater event streams
 * directly, so App.vue only has to mount it. In dev the main process wires no
 * updater handlers, so no events arrive and the banner never appears.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'
import StatusIndicator from './StatusIndicator.vue'
import { clampPercent, progressLabel } from '../lib/updateState'
import type { UpdateDownloadProgress } from '../../../shared/ipc'

type Phase = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error'

const phase = ref<Phase>('idle')
const version = ref<string | null>(null)
const progress = ref<UpdateDownloadProgress | null>(null)
const errorMessage = ref<string | null>(null)
const dismissed = ref(false)

const percent = computed(() => clampPercent(progress.value?.percent ?? 0))
const detail = computed(() => (progress.value ? progressLabel(progress.value) : ''))
const visible = computed(() => phase.value !== 'idle' && !dismissed.value)

const unsubscribes: Array<() => void> = []

onMounted(() => {
  unsubscribes.push(
    window.api.updater.onUpdateAvailable((info) => {
      version.value = info.version
      errorMessage.value = null
      dismissed.value = false
      phase.value = 'available'
    }),
    window.api.updater.onDownloadProgress((next) => {
      progress.value = next
      phase.value = 'downloading'
    }),
    window.api.updater.onUpdateDownloaded((info) => {
      version.value = info.version
      phase.value = 'downloaded'
    }),
    window.api.updater.onUpdateError((info) => {
      // An error only interrupts an active flow. A background check that fails
      // (no releases, offline) should not raise a banner out of nowhere.
      if (phase.value === 'idle') return
      errorMessage.value = info.message
      phase.value = 'error'
    }),
  )
})

onUnmounted(() => {
  for (const off of unsubscribes) off()
})

async function onDownload(): Promise<void> {
  errorMessage.value = null
  phase.value = 'downloading'
  progress.value = null
  try {
    await window.api.updater.downloadUpdate()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
    phase.value = 'error'
  }
}

async function onInstall(): Promise<void> {
  // Hands off to the installer and relaunches; nothing runs after this resolves.
  await window.api.updater.installUpdate()
}

function onDismiss(): void {
  dismissed.value = true
}
</script>

<template>
  <section v-if="visible" class="update-banner" role="status" aria-live="polite">
    <div class="head">
      <StatusIndicator
        :state="phase === 'error' ? 'danger' : phase === 'downloaded' ? 'ok' : 'busy'"
        :label="`Update ${phase}`"
      />
      <span class="title">
        <template v-if="phase === 'downloaded'">Update ready</template>
        <template v-else-if="phase === 'error'">Update failed</template>
        <template v-else-if="phase === 'downloading'">Downloading update</template>
        <template v-else>Update available</template>
      </span>
      <span v-if="version" class="numeric version">{{ version }}</span>
      <span class="spacer"></span>
      <button
        v-if="phase !== 'downloading'"
        class="icon-only"
        aria-label="Dismiss"
        @click="onDismiss"
      >
        <Icon name="cancel" :size="14" />
      </button>
    </div>

    <p v-if="phase === 'available'" class="detail">
      A newer version of MONOCLE is ready to download.
    </p>

    <div v-else-if="phase === 'downloading'" class="downloading">
      <div
        class="progress"
        role="progressbar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="bar" :style="{ width: `${percent}%` }"></div>
      </div>
      <div class="row">
        <span class="faint numeric">{{ percent }}%</span>
        <span v-if="detail" class="faint numeric detail-line">{{ detail }}</span>
      </div>
    </div>

    <p v-else-if="phase === 'downloaded'" class="detail">
      Restart to finish installing. Your work is not affected.
    </p>

    <p v-else-if="phase === 'error'" class="detail">
      The update could not complete.
      <span v-if="errorMessage" class="reason">{{ errorMessage }}</span>
    </p>

    <div class="actions">
      <button v-if="phase === 'available' || phase === 'error'" class="primary" @click="onDownload">
        <Icon name="update" :size="15" />
        {{ phase === 'error' ? 'Retry download' : 'Download' }}
      </button>
      <button v-else-if="phase === 'downloaded'" class="primary" @click="onInstall">
        <Icon name="reset" :size="15" />
        Restart to update
      </button>
    </div>
  </section>
</template>

<style scoped>
.update-banner {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--stroke-1) solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent-tint);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.title {
  font-weight: var(--weight-semibold);
  font-size: var(--text-sm);
  color: var(--ink-hi);
}
.version {
  font-size: var(--text-2xs);
  color: var(--ink-lo);
}
.spacer {
  flex: 1;
}
.icon-only {
  padding: var(--space-1);
  background: transparent;
  border-color: transparent;
  color: var(--ink-lo);
}
.icon-only:hover {
  color: var(--ink-hi);
}
.detail {
  font-size: var(--text-xs);
  color: var(--ink-lo);
}
.reason {
  display: block;
  margin-top: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--ink-lo);
  word-break: break-word;
}
.downloading {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.progress {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur) var(--ease);
}
.row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-2xs);
}
.detail-line {
  text-align: right;
}
.actions:empty {
  display: none;
}
.primary {
  align-self: flex-start;
}
</style>
