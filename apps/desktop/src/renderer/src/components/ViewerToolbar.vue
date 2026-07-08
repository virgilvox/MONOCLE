<script setup lang="ts">
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

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'shaded', label: 'Shaded' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'points', label: 'Points' },
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
      {{ props.background === 'dark' ? 'Light bg' : 'Dark bg' }}
    </button>
    <button @click="emit('reset')">Reset view</button>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.modes button {
  padding: 4px 10px;
  font-size: 12px;
}
.modes button.active {
  border-color: var(--accent);
  background: var(--accent-dim);
}
.point-size {
  gap: 8px;
  font-size: 12px;
}
.point-size input {
  width: 90px;
}
.spacer {
  flex: 1;
}
.bg-toggle,
.toolbar > button {
  font-size: 12px;
  padding: 4px 10px;
}
</style>
