<script setup lang="ts">
import type { BackendInfo, ProgressNote, ReconstructResult } from '@monoclejs/protocol'
import { computed, ref, watch } from 'vue'
import type { SidecarStatus } from '../../../shared/ipc'

const props = defineProps<{
  status: SidecarStatus
  backends: BackendInfo[]
  progress: ProgressNote | null
  reconstructing: boolean
  result: ReconstructResult | null
  error: string | null
}>()

const emit = defineEmits<{
  reconstruct: [backend: string]
  save: []
}>()

const selected = ref<string | null>(null)

watch(
  () => props.backends,
  (list) => {
    if (!selected.value && list.length > 0) selected.value = list[0]!.id
  },
  { immediate: true },
)

const ready = computed(() => props.status === 'ready')
const canRun = computed(() => ready.value && selected.value !== null && !props.reconstructing)
const percent = computed(() => Math.round((props.progress?.ratio ?? 0) * 100))
</script>

<template>
  <section class="panel">
    <h2>Reconstruct</h2>
    <div class="stack">
      <select v-model="selected" :disabled="!ready || backends.length === 0">
        <option v-if="backends.length === 0" :value="null">
          Start the engine to list backends
        </option>
        <option v-for="backend in backends" :key="backend.id" :value="backend.id">
          {{ backend.label }}
        </option>
      </select>

      <button
        class="primary"
        :disabled="!canRun"
        @click="selected && emit('reconstruct', selected)"
      >
        {{ reconstructing ? 'Reconstructing...' : 'Reconstruct' }}
      </button>

      <div v-if="reconstructing" class="progress">
        <div class="bar" :style="{ width: `${percent}%` }"></div>
        <span class="faint stage">{{ progress?.stage ?? 'working' }} {{ percent }}%</span>
      </div>

      <div v-if="result" class="result">
        <div class="row">
          <span class="mono">{{ result.vertexCount.toLocaleString() }}</span>
          <span class="faint">vertices</span>
        </div>
        <div class="row">
          <span class="mono">{{ result.triangleCount.toLocaleString() }}</span>
          <span class="faint">triangles</span>
        </div>
        <button @click="emit('save')">Save STL</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.2s;
}
.stage {
  font-size: 11px;
}
.result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.error {
  color: var(--bad);
  font-size: 12px;
}
</style>
