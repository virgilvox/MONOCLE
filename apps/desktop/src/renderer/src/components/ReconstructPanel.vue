<script setup lang="ts">
import type { ProgressNote, ReconstructResult } from '@monoclejs/protocol'
import { computed, ref, toRef, watch } from 'vue'
import Icon from './Icon.vue'
import { useElapsed } from '../composables/useElapsed'
import { estimateRemainingMs, formatDuration } from '../lib/duration'
import { outputPreview } from '../lib/outputPreview'
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

// What the result actually is, so the counts carry the right noun (vertices,
// points, splats) and a count that is genuinely unknown is not shown as zero.
const preview = computed(() => outputPreview(props.result?.output))
const showVertexCount = computed(
  () => preview.value.countNoun !== null && (props.result?.vertexCount ?? 0) > 0,
)
const showTriangleCount = computed(() => preview.value.hasTriangles)

const ready = computed(() => props.status === 'ready')
const percent = computed(() => Math.round((props.progress?.ratio ?? 0) * 100))

// A ticking clock so a multi-minute CPU run visibly advances. ETA appears once
// there is enough progress for the linear estimate to be meaningful.
const elapsedMs = useElapsed(toRef(props, 'reconstructing'))
const elapsedLabel = computed(() => formatDuration(elapsedMs.value))
const etaLabel = computed(() => {
  const remaining = estimateRemainingMs(elapsedMs.value, props.progress?.ratio ?? 0)
  return remaining === null ? null : formatDuration(remaining)
})

/** The printed size as "W x H x D", rounded to whole millimeters. */
const sizeLabel = computed(() => {
  const box = props.result?.boundingBoxMm
  if (!box) return ''
  return `${Math.round(box.x)} x ${Math.round(box.y)} x ${Math.round(box.z)}`
})

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
  if (a.obj) options.push({ key: 'obj', label: 'OBJ (mesh)', path: a.obj, defaultName: 'scan.obj' })
  if (a.usdz)
    options.push({ key: 'usdz', label: 'USDZ (AR)', path: a.usdz, defaultName: 'scan.usdz' })
  if (a.gsPly)
    options.push({
      key: 'gsPly',
      label: 'Gaussian splat (PLY)',
      path: a.gsPly,
      defaultName: 'splat.ply',
    })
  if (a.colmap)
    options.push({
      key: 'colmap',
      label: 'COLMAP model (folder)',
      path: a.colmap,
      defaultName: 'colmap',
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
        <button class="primary big" :disabled="!canReconstruct" @click="emit('reconstruct')">
          <Icon name="wireframe" :size="16" />
          Reconstruct
        </button>
        <p v-if="!ready" class="faint hint">Engine is not ready yet.</p>
        <p v-else-if="!canReconstruct" class="faint hint">
          Capture at least one frame, or pick the synthetic preset.
        </p>
      </div>

      <div v-else class="running">
        <div
          class="progress"
          role="progressbar"
          aria-label="Reconstruction progress"
          :aria-valuenow="percent"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="bar" :style="{ width: `${percent}%` }"></div>
        </div>
        <div class="row">
          <span class="faint stage numeric" aria-live="polite"
            >{{ progress?.stage ?? 'working' }} {{ percent }}%</span
          >
          <span class="spacer"></span>
          <button @click="emit('cancel')"><Icon name="cancel" :size="14" />Cancel</button>
        </div>
        <div class="row timing">
          <span class="faint numeric">{{ elapsedLabel }} elapsed</span>
          <span v-if="etaLabel" class="faint numeric">~{{ etaLabel }} left</span>
        </div>
        <p v-if="progress?.message" class="faint hint" aria-live="polite">
          {{ progress.message }}
        </p>
      </div>

      <div v-if="result" class="result">
        <p v-if="result.output && result.output !== 'mesh'" class="kind">
          <Icon name="wireframe" :size="13" />
          <span>{{ preview.label }}</span>
        </p>

        <div v-if="showVertexCount || showTriangleCount" class="counts">
          <template v-if="showVertexCount">
            <span class="numeric value">{{ result.vertexCount.toLocaleString() }}</span>
            <span class="faint unit">{{ preview.countNoun }}</span>
          </template>
          <span class="spacer"></span>
          <template v-if="showTriangleCount">
            <span class="numeric value">{{ result.triangleCount.toLocaleString() }}</span>
            <span class="faint unit">triangles</span>
          </template>
        </div>

        <p v-if="result.boundingBoxMm" class="size">
          <span class="numeric">{{ sizeLabel }}</span>
          <span class="faint"> mm, estimated. Rescale in your slicer if needed.</span>
        </p>

        <label class="field">
          <span class="faint">Save as</span>
          <select v-model="selectedKey">
            <option v-for="option in saveOptions" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
        </label>
        <button @click="onSave"><Icon name="save" :size="15" />Save</button>

        <div v-if="savedPath" class="saved">
          <p class="ok"><Icon name="check" :size="14" :stroke-width="2.4" />Saved</p>
          <p class="numeric path faint">{{ savedPath }}</p>
          <button @click="emit('reveal', savedPath)">
            <Icon name="reveal" :size="15" />Reveal in Finder
          </button>
        </div>
      </div>

      <p v-if="error" class="error" role="alert"><Icon name="alert" :size="15" />{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.preset-line {
  font-size: var(--text-xs);
}
.strong {
  color: var(--ink-hi);
  font-weight: var(--weight-semibold);
}
.actions,
.running,
.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* The single primary action carries the most weight in the sidebar. */
.big {
  width: 100%;
  padding: var(--space-3);
  font-weight: var(--weight-semibold);
}
.progress {
  height: 6px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
}
.bar {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur) var(--ease);
}
.stage {
  font-size: var(--text-2xs);
}
.timing {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  font-size: var(--text-2xs);
}
.kind {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  color: var(--ink-hi);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
.counts {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.value {
  font-size: var(--text-lg);
  color: var(--ink-hi);
}
.unit {
  font-size: var(--text-xs);
}
.size {
  margin: 0;
  font-size: var(--text-xs);
}
.size .numeric {
  color: var(--ink-hi);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
.saved {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--stroke-1) solid var(--ok-line);
  border-radius: var(--r-sm);
  background: var(--ok-tint);
}
.ok {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ok);
  font-weight: var(--weight-semibold);
  font-size: var(--text-xs);
}
.path {
  word-break: break-all;
  font-size: var(--text-2xs);
}
.hint {
  font-size: var(--text-xs);
}
.error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  color: var(--danger);
  font-size: var(--text-xs);
}
</style>
