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
      <button v-else class="big" @click="emit('cancel')">
        <Icon name="cancel" :size="15" />
        Cancel import
      </button>
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
</style>
