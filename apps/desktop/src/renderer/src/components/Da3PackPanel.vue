<script setup lang="ts">
/**
 * The install control for the optional Depth Anything 3 pack. DA3 (the multi-view
 * quality path) is not in the installer; this panel downloads it on demand into
 * app data. It renders one of four states from the da3 store: unsupported (with a
 * plain reason), available to download, installing (with progress), or installed.
 */
import { useDa3Store } from '../stores/da3'
import Icon from './Icon.vue'

const da3 = useDa3Store()
</script>

<template>
  <div class="pack">
    <div class="head">
      <span class="title">Depth Anything 3 pack</span>
      <span v-if="da3.installed" class="badge ok"><Icon name="check" :size="12" /> Installed</span>
      <span v-else-if="da3.installing" class="badge">Installing</span>
      <span v-else-if="!da3.supported" class="badge off">Unavailable</span>
      <span v-else class="badge">Optional &middot; ~{{ da3.sizeGb }} GB</span>
    </div>

    <!-- Failures (an install, a status check) show in every state. -->
    <p v-if="da3.error" class="err" role="alert">
      <Icon name="alert" :size="13" /> {{ da3.error }}
    </p>

    <!-- Not runnable on this machine: explain, offer nothing. -->
    <p v-if="!da3.supported && !da3.installed" class="reason">
      <Icon name="info" :size="13" />
      {{ da3.reason }}
    </p>

    <!-- Installing: live progress, cancellable. -->
    <template v-else-if="da3.installing">
      <p class="msg" aria-live="polite">{{ da3.progress?.message ?? 'Preparing…' }}</p>
      <div
        class="bar"
        :class="{ indeterminate: da3.percent === null }"
        role="progressbar"
        aria-label="Depth Anything 3 pack download"
        :aria-valuenow="da3.percent ?? undefined"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          class="fill"
          :style="da3.percent !== null ? { width: `${da3.percent}%` } : undefined"
        ></div>
      </div>
      <div class="row">
        <span class="faint">{{ da3.percent !== null ? `${da3.percent}%` : 'Downloading…' }}</span>
        <button class="ghost" @click="da3.cancel()">Cancel</button>
      </div>
    </template>

    <!-- Installed: what it enables, and a way to reclaim the space. -->
    <template v-else-if="da3.installed">
      <p class="msg faint">
        Multi-view reconstruction and the point-cloud, COLMAP and Gaussian outputs are available.
        Stored in app data.
      </p>
      <div class="row end">
        <button class="ghost" @click="da3.remove()">
          <Icon name="cancel" :size="13" /> Remove
        </button>
      </div>
    </template>

    <!-- Available to download. -->
    <template v-else>
      <p class="msg faint">
        Adds the highest-quality multi-view method (PyTorch + Depth Anything 3). Downloads about
        {{ da3.sizeGb }} GB into app data, once.
      </p>
      <div class="row end">
        <button class="primary" @click="da3.install()">
          <Icon name="import" :size="14" /> Download
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--stroke-1) solid var(--line);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.title {
  font-size: var(--text-xs);
  font-weight: 600;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--ink-lo);
  white-space: nowrap;
}
.badge.ok {
  color: var(--accent);
}
.badge.off {
  color: var(--ink-lo);
}
.msg,
.reason {
  font-size: var(--text-2xs);
  line-height: 1.5;
  display: flex;
  gap: var(--space-1);
}
.reason {
  align-items: flex-start;
}
.err {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  font-size: var(--text-2xs);
  color: var(--danger);
}
.bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--line);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.bar.indeterminate .fill {
  width: 40%;
  animation: slide 1.1s ease-in-out infinite;
}
@keyframes slide {
  0% {
    margin-left: -40%;
  }
  100% {
    margin-left: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar.indeterminate .fill {
    animation: none;
    width: 100%;
    opacity: 0.5;
  }
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.row.end {
  justify-content: flex-end;
}
.faint {
  color: var(--ink-lo);
}
button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.primary {
  color: var(--accent);
}
</style>
