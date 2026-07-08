<script setup lang="ts">
import type { ProgressNote, ReconstructResult } from '@monoclejs/protocol'
import { computed, ref, watch } from 'vue'
import type { SidecarStatus } from '../../../shared/ipc'

const props = defineProps<{
  status: SidecarStatus
  progress: ProgressNote | null
  reconstructing: boolean
  canReconstruct: boolean
  result: ReconstructResult | null
  error: string | null
  savedPath: string | null
  presetLabel: string
}>()

const emit = defineEmits<{
  reconstruct: []
  cancel: []
  save: [request: { sourcePath: string; defaultName: string }]
  reveal: [path: string]
}>()

interface SaveOption {
  key: string
  label: string
  path: string
  defaultName: string
}

const ready = computed(() => props.status === 'ready')
const percent = computed(() => Math.round((props.progress?.ratio ?? 0) * 100))

const saveOptions = computed<SaveOption[]>(() => {
  const r = props.result
  if (!r) return []
  const a = r.artifacts ?? {}
  const options: SaveOption[] = []
  const stl = a.stl ?? (r.meshPath.toLowerCase().endsWith('.stl') ? r.meshPath : undefined)
  if (stl)
    options.push({ key: 'stl', label: 'STL (for 3D printing)', path: stl, defaultName: 'scan.stl' })
  if (a.ply)
    options.push({
      key: 'ply',
      label: 'PLY (color point cloud)',
      path: a.ply,
      defaultName: 'scan.ply',
    })
  if (a.glb)
    options.push({ key: 'glb', label: 'GLB (color mesh)', path: a.glb, defaultName: 'scan.glb' })
  if (a.threeMF)
    options.push({
      key: '3mf',
      label: '3MF (color printing)',
      path: a.threeMF,
      defaultName: 'scan.3mf',
    })
  if (options.length === 0) {
    options.push({ key: 'mesh', label: 'Mesh', path: r.meshPath, defaultName: 'scan' })
  }
  return options
})

const selectedKey = ref<string | null>(null)

watch(
  saveOptions,
  (options) => {
    if (options.length > 0 && !options.some((o) => o.key === selectedKey.value)) {
      selectedKey.value = options[0]!.key
    }
  },
  { immediate: true },
)

const selectedOption = computed(
  () => saveOptions.value.find((o) => o.key === selectedKey.value) ?? null,
)

function onSave(): void {
  const option = selectedOption.value
  if (option) emit('save', { sourcePath: option.path, defaultName: option.defaultName })
}
</script>

<template>
  <section class="panel">
    <h2>Reconstruct</h2>
    <div class="stack">
      <p class="faint preset-line">
        Using <span class="strong">{{ presetLabel }}</span>
      </p>

      <div v-if="!reconstructing" class="actions">
        <button class="primary" :disabled="!canReconstruct" @click="emit('reconstruct')">
          Reconstruct
        </button>
        <p v-if="!ready" class="faint hint">Engine is not ready yet.</p>
        <p v-else-if="!canReconstruct" class="faint hint">
          Capture at least one frame, or pick the synthetic preset.
        </p>
      </div>

      <div v-else class="running">
        <div class="progress">
          <div class="bar" :style="{ width: `${percent}%` }"></div>
        </div>
        <div class="row">
          <span class="faint stage">{{ progress?.stage ?? 'working' }} {{ percent }}%</span>
          <span class="spacer"></span>
          <button @click="emit('cancel')">Cancel</button>
        </div>
        <p v-if="progress?.message" class="faint hint">{{ progress.message }}</p>
      </div>

      <div v-if="result" class="result">
        <div class="row">
          <span class="mono">{{ result.vertexCount.toLocaleString() }}</span>
          <span class="faint">vertices</span>
          <span class="spacer"></span>
          <span class="mono">{{ result.triangleCount.toLocaleString() }}</span>
          <span class="faint">triangles</span>
        </div>

        <label class="field">
          <span class="faint">Save as</span>
          <select v-model="selectedKey">
            <option v-for="option in saveOptions" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button @click="onSave">Save</button>

        <div v-if="savedPath" class="saved">
          <p class="ok">Saved</p>
          <p class="mono path faint">{{ savedPath }}</p>
          <button @click="emit('reveal', savedPath)">Reveal in Finder</button>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.preset-line {
  font-size: 12px;
}
.strong {
  color: var(--text);
  font-weight: 600;
}
.actions,
.running,
.result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.progress {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-inset);
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.stage {
  font-size: 11px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.saved {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--good);
  border-radius: var(--radius-sm);
  background: rgba(55, 211, 155, 0.08);
}
.ok {
  color: var(--good);
  font-weight: 600;
  font-size: 12px;
}
.path {
  word-break: break-all;
}
.hint {
  font-size: 12px;
}
.error {
  color: var(--bad);
  font-size: 12px;
}
</style>
