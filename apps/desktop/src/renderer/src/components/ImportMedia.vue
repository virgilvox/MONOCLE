<script setup lang="ts">
import Icon from './Icon.vue'

defineProps<{
  /** True while the sidecar is decoding and selecting keyframes. */
  importing: boolean
  /** True while a reconstruction (including one started by an import) is running. */
  reconstructing: boolean
  /** True when the inference engine is ready to accept a job. */
  ready: boolean
}>()

const emit = defineEmits<{
  import: []
  cancel: []
}>()
</script>

<template>
  <section class="panel">
    <h2>Import</h2>
    <div class="stack">
      <p class="faint hint">
        Reconstruct from a video or a folder of photos instead of the live camera. Sharp,
        well-spread keyframes are chosen for you.
      </p>
      <button
        v-if="!importing"
        class="big"
        :disabled="!ready || reconstructing"
        @click="emit('import')"
      >
        <Icon name="import" :size="15" />
        Import video or photos
      </button>
      <template v-else>
        <!-- Decoding and keyframe selection can take a while on a long video, so
             show a live busy state, not just a relabeled button. -->
        <div class="busy" role="status" aria-live="polite">
          <div class="bar indeterminate" aria-hidden="true">
            <div class="fill"></div>
          </div>
          <p class="faint hint">Decoding media…</p>
        </div>
        <button class="big" @click="emit('cancel')">
          <Icon name="cancel" :size="15" />
          Cancel import
        </button>
      </template>
      <p v-if="!ready" class="faint hint">Start the inference engine to import.</p>
    </div>
  </section>
</template>

<style scoped>
.big {
  width: 100%;
  padding: var(--space-3);
  font-weight: var(--weight-semibold);
}
.hint {
  font-size: var(--text-xs);
}
.busy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.busy .hint {
  margin: 0;
}
/* The same indeterminate sweep as the pack panel's download bar. */
.bar {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--line);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
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
</style>
