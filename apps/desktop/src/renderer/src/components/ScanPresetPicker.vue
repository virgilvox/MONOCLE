<script setup lang="ts">
import type { BackendInfo } from '@monoclejs/protocol'
import { computed } from 'vue'
import Disclosure from './Disclosure.vue'
import Icon from './Icon.vue'
import type { IconName } from './icons/registry'
import {
  CARD_PRESETS,
  DA3_BACKEND,
  DA3_SIZES,
  QUALITY_TIERS,
  type Quality,
  SCAN_PRESETS,
} from '../stores/capture'

const props = defineProps<{
  selected: string
  backends: BackendInfo[]
  backendOverride: string | null
  quality: Quality
  color: boolean
  checkpoint: string
  hasOverrides: boolean
  locked: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  'backend-override': [id: string | null]
  'quality-override': [quality: Quality | null]
  'color-override': [color: boolean | null]
  'checkpoint-override': [checkpoint: string | null]
  'reset-overrides': []
  'run-synthetic': []
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

// The dropdown shows the override when set, otherwise the preset's own backend.
const currentBackend = computed(() => props.backendOverride ?? activePreset.value.backend)

// Depth Anything 3 is the only backend with selectable checkpoint sizes.
const usesCheckpoint = computed(() => currentBackend.value === DA3_BACKEND)

// An override that matches the preset default is cleared, so state stays honest.
function onBackendChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('backend-override', value === activePreset.value.backend ? null : value)
}

function onQualityChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as Quality
  emit('quality-override', value === activePreset.value.quality ? null : value)
}

function onColorChange(event: Event): void {
  const value = (event.target as HTMLInputElement).checked
  emit('color-override', value === activePreset.value.color ? null : value)
}

function onCheckpointChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  // base is the default; selecting it clears the override.
  emit('checkpoint-override', value === 'base' ? null : value)
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

    <Disclosure title="Advanced" icon="advanced">
      <label class="field">
        <span class="faint">Depth model</span>
        <select
          :value="currentBackend"
          :disabled="backends.length === 0 || locked"
          @change="onBackendChange"
        >
          <option v-if="backends.length === 0" :value="currentBackend">
            {{ currentBackend }} (engine not ready)
          </option>
          <option v-for="backend in backends" :key="backend.id" :value="backend.id">
            {{ backend.label }}
          </option>
        </select>
      </label>

      <label v-if="usesCheckpoint" class="field">
        <span class="faint">Model size</span>
        <select :value="checkpoint" :disabled="locked" @change="onCheckpointChange">
          <option v-for="size in DA3_SIZES" :key="size.id" :value="size.id">
            {{ size.label }}{{ size.note ? ` (${size.note})` : '' }}
          </option>
        </select>
      </label>

      <label class="field">
        <span class="faint">Quality</span>
        <select :value="quality" :disabled="locked" @change="onQualityChange">
          <option v-for="tier in QUALITY_TIERS" :key="tier.id" :value="tier.id">
            {{ tier.label }}
          </option>
        </select>
      </label>

      <label class="check">
        <input type="checkbox" :checked="color" :disabled="locked" @change="onColorChange" />
        <span>Capture color</span>
      </label>

      <p v-if="hasOverrides" class="note">
        <span class="faint">Overriding the preset.</span>
        <button class="link" :disabled="locked" @click="emit('reset-overrides')">
          Reset to preset defaults
        </button>
      </p>

      <div class="diag">
        <span class="faint diag-label">Diagnostics</span>
        <button class="test" :disabled="locked" @click="emit('run-synthetic')">
          <Icon name="wireframe" :size="14" />
          Run synthetic test
        </button>
        <span class="faint diag-hint">Builds a known mesh with no camera.</span>
      </div>
    </Disclosure>
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
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
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
.note {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-2xs);
}
.link {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: var(--text-2xs);
  text-decoration: underline;
}
.link:hover {
  border-color: transparent;
}
.diag {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: var(--stroke-1) solid var(--line);
}
.diag-label {
  font-size: var(--text-2xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}
.test {
  align-self: flex-start;
  font-size: var(--text-xs);
}
.diag-hint {
  font-size: var(--text-2xs);
}
</style>
