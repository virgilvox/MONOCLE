<script setup lang="ts">
import Icon from './Icon.vue'
import type { IconName } from './icons/registry'

export type ViewMode = 'shaded' | 'wireframe' | 'points'
export type ViewerBackground = 'dark' | 'light'

const props = defineProps<{
  mode: ViewMode
  pointSize: number
  background: ViewerBackground
}>()

const emit = defineEmits<{
  'update:mode': [mode: ViewMode]
  'update:pointSize': [size: number]
  'update:background': [background: ViewerBackground]
  reset: []
}>()

const MODES: { id: ViewMode; label: string; icon: IconName }[] = [
  { id: 'shaded', label: 'Shaded', icon: 'shaded' },
  { id: 'wireframe', label: 'Wireframe', icon: 'wireframe' },
  { id: 'points', label: 'Points', icon: 'points' },
]

function onPointSize(event: Event): void {
  emit('update:pointSize', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="toolbar">
    <div class="group modes">
      <button
        v-for="m in MODES"
        :key="m.id"
        :class="{ active: m.id === props.mode }"
        @click="emit('update:mode', m.id)"
      >
        <Icon :name="m.icon" :size="14" />
        {{ m.label }}
      </button>
    </div>

    <div v-if="props.mode === 'points'" class="group point-size">
      <label class="faint" for="point-size">Point size</label>
      <input
        id="point-size"
        type="range"
        min="1"
        max="8"
        step="0.5"
        :value="props.pointSize"
        @input="onPointSize"
      />
    </div>

    <div class="spacer"></div>

    <button
      class="bg-toggle"
      :title="
        props.background === 'dark' ? 'Switch to light background' : 'Switch to dark background'
      "
      @click="emit('update:background', props.background === 'dark' ? 'light' : 'dark')"
    >
      <Icon :name="props.background === 'dark' ? 'light-bg' : 'dark-bg'" :size="14" />
      {{ props.background === 'dark' ? 'Light bg' : 'Dark bg' }}
    </button>
    <button @click="emit('reset')">
      <Icon name="reset" :size="14" />
      Reset view
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface-1);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.modes button {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-xs);
}
.modes button.active {
  border-color: var(--accent);
  background: var(--accent-tint);
  color: var(--ink-hi);
}
.point-size {
  gap: var(--space-2);
  font-size: var(--text-xs);
}
.point-size input {
  width: 90px;
}
.spacer {
  flex: 1;
}
.bg-toggle,
.toolbar > button {
  font-size: var(--text-xs);
  padding: var(--space-1) var(--space-3);
}
</style>
