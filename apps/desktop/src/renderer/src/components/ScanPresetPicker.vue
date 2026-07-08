<script setup lang="ts">
import type { BackendInfo } from '@monoclejs/protocol'
import { computed, ref } from 'vue'
import { SCAN_PRESETS } from '../stores/capture'

const props = defineProps<{
  selected: string
  backends: BackendInfo[]
  backendOverride: string | null
  locked: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  'backend-override': [id: string | null]
}>()

const advancedOpen = ref(false)

const activePreset = computed(
  () => SCAN_PRESETS.find((p) => p.id === props.selected) ?? SCAN_PRESETS[0]!,
)

// The dropdown shows the override when set, otherwise the preset's own backend.
const currentBackend = computed(() => props.backendOverride ?? activePreset.value.backend)

function onBackendChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('backend-override', value === activePreset.value.backend ? null : value)
}
</script>

<template>
  <section class="panel">
    <h2>Scan preset</h2>
    <div class="presets">
      <button
        v-for="preset in SCAN_PRESETS"
        :key="preset.id"
        class="preset"
        :class="{ selected: preset.id === selected }"
        :disabled="locked"
        @click="emit('select', preset.id)"
      >
        <span class="label">{{ preset.label }}</span>
        <span class="desc faint">{{ preset.description }}</span>
        <span class="meta faint">
          <span>{{ preset.quality }}</span>
          <span class="sep">/</span>
          <span>{{ preset.color ? 'color' : 'geometry only' }}</span>
        </span>
      </button>
    </div>

    <button
      class="advanced-toggle"
      :aria-expanded="advancedOpen"
      @click="advancedOpen = !advancedOpen"
    >
      <span class="chevron" :class="{ open: advancedOpen }" aria-hidden="true"></span>
      Advanced
    </button>

    <div v-if="advancedOpen" class="advanced">
      <label class="field">
        <span class="faint">Backend</span>
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
      <p v-if="backendOverride" class="faint note">
        Overriding the preset backend.
        <button class="link" @click="emit('backend-override', null)">Reset to preset</button>
      </p>
    </div>
  </section>
</template>

<style scoped>
.presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preset {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
}
.preset.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.label {
  font-weight: 600;
}
.desc {
  font-size: 12px;
}
.meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.meta .sep {
  color: var(--border-strong);
}
.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 12px;
  background: transparent;
  border: none;
  padding: 6px 0;
  color: var(--text-dim);
  font-size: 12px;
}
.advanced-toggle:hover:not(:disabled) {
  border-color: transparent;
  color: var(--text);
}
.chevron {
  width: 0;
  height: 0;
  border-left: 5px solid var(--text-dim);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.15s;
}
.chevron.open {
  transform: rotate(90deg);
}
.advanced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.note {
  font-size: 11px;
}
.link {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: 11px;
  text-decoration: underline;
}
.link:hover {
  border-color: transparent;
}
</style>
