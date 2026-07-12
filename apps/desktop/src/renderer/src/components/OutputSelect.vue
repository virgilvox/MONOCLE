<script setup lang="ts">
/**
 * The output/export choice: what product a scan yields. `mesh` runs on any
 * backend; the richer products (point cloud, Gaussian splat, COLMAP) are native
 * to Depth Anything 3, so they are disabled until it is the selected model, and
 * the Gaussian option is annotated as needing the giant checkpoint.
 */
import type { ReconstructOutput } from '@monoclejs/protocol'
import { computed } from 'vue'
import { GAUSSIAN_CHECKPOINT, OUTPUT_KINDS } from '../stores/capture'

const props = defineProps<{
  /** The output currently in effect (already coerced to mesh off Depth Anything 3). */
  output: ReconstructOutput
  /** True when the selected backend can emit the rich products. */
  richAvailable: boolean
  /** The selected DA3 checkpoint, so the Gaussian note can flag a missing giant. */
  checkpoint: string
  locked: boolean
}>()

const emit = defineEmits<{
  change: [output: ReconstructOutput]
}>()

const selectedKind = computed(
  () => OUTPUT_KINDS.find((k) => k.id === props.output) ?? OUTPUT_KINDS[0]!,
)

// The one-line note under the select: the kind's own note, plus a nudge when a
// rich product is picked but the machine or checkpoint cannot yet produce it.
const hint = computed(() => {
  const kind = selectedKind.value
  if (kind.richOnly && !props.richAvailable) {
    return 'Pick Depth Anything 3 in Advanced to enable this output.'
  }
  if (kind.needsGiant && props.checkpoint !== GAUSSIAN_CHECKPOINT) {
    return 'Set the model size to Giant in Advanced for a Gaussian splat.'
  }
  return kind.note
})

function onChange(event: Event): void {
  emit('change', (event.target as HTMLSelectElement).value as ReconstructOutput)
}
</script>

<template>
  <label class="field">
    <span class="faint">Output</span>
    <select :value="output" :disabled="locked" @change="onChange">
      <option
        v-for="kind in OUTPUT_KINDS"
        :key="kind.id"
        :value="kind.id"
        :disabled="kind.richOnly && !richAvailable"
      >
        {{ kind.label }}{{ kind.richOnly && !richAvailable ? ' (Depth Anything 3)' : '' }}
      </option>
    </select>
    <span class="faint note">{{ hint }}</span>
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.note {
  font-size: var(--text-2xs);
  line-height: var(--leading-normal);
}
</style>
