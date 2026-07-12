<script setup lang="ts">
/**
 * The core scan surface: pick an outcome (a preset card), whether to capture
 * color, and the output product. The granular model, checkpoint, quality, device,
 * and pose levers live in the separate Advanced controls, so this stays a small,
 * friendly set of choices.
 */
import type { ReconstructOutput } from '@monoclejs/protocol'
import { computed } from 'vue'
import Icon from './Icon.vue'
import OutputSelect from './OutputSelect.vue'
import type { IconName } from './icons/registry'
import { CARD_PRESETS, SCAN_PRESETS } from '../stores/capture'

const props = defineProps<{
  selected: string
  color: boolean
  /** The output in effect, already coerced to what the backend can produce. */
  output: ReconstructOutput
  /** True when the selected backend can emit the rich outputs. */
  supportsRichOutput: boolean
  /** The DA3 checkpoint, so the output note can flag a missing giant. */
  checkpoint: string
  locked: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  'color-override': [color: boolean | null]
  output: [output: ReconstructOutput]
}>()

// Each preset carries an optical glyph so the choice reads at a glance.
const PRESET_ICON: Record<string, IconName> = {
  'quick-depth': 'lens',
  'object-scan': 'orbit',
  synthetic: 'wireframe',
}

const activePreset = computed(
  () => SCAN_PRESETS.find((p) => p.id === props.selected) ?? SCAN_PRESETS[0]!,
)

// A color choice that matches the preset default is cleared, so state stays honest.
function onColorChange(event: Event): void {
  const value = (event.target as HTMLInputElement).checked
  emit('color-override', value === activePreset.value.color ? null : value)
}
</script>

<template>
  <section class="panel">
    <h2>Scan preset</h2>
    <div class="presets">
      <button
        v-for="preset in CARD_PRESETS"
        :key="preset.id"
        class="preset"
        :class="{ selected: preset.id === selected }"
        :aria-pressed="preset.id === selected"
        :disabled="locked"
        @click="emit('select', preset.id)"
      >
        <span class="glyph" aria-hidden="true">
          <Icon :name="PRESET_ICON[preset.id] ?? 'iris'" :size="18" />
        </span>
        <span class="body">
          <span class="label">{{ preset.label }}</span>
          <span class="desc faint">{{ preset.description }}</span>
          <span class="meta">
            <span class="tag">{{ preset.quality }}</span>
            <span class="tag">{{ preset.color ? 'color' : 'geometry only' }}</span>
          </span>
        </span>
      </button>
    </div>

    <div class="core-fields">
      <label class="check">
        <input type="checkbox" :checked="color" :disabled="locked" @change="onColorChange" />
        <span>Capture color</span>
      </label>

      <OutputSelect
        :output="output"
        :rich-available="supportsRichOutput"
        :checkpoint="checkpoint"
        :locked="locked"
        @change="emit('output', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.presets {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.preset {
  text-align: left;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
}
.preset.selected {
  border-color: var(--accent);
  background: var(--accent-tint);
}
.glyph {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-md);
  border: var(--stroke-1) solid var(--line);
  background: var(--surface-0);
  color: var(--ink-lo);
}
.preset.selected .glyph {
  border-color: var(--accent);
  color: var(--accent);
}
.body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.label {
  font-weight: var(--weight-semibold);
  color: var(--ink-hi);
}
.desc {
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.meta {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
.tag {
  font-size: var(--text-2xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--ink-lo);
  padding: 2px var(--space-2);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-sm);
}
.core-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.check input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
</style>
