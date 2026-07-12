<script setup lang="ts">
/**
 * The advanced reconstruction levers, collapsed behind a disclosure so the core
 * flow stays simple. Everything here overrides the adaptive defaults: the depth
 * model, its checkpoint size, the quality tier, the compute device, and the pose
 * strategy, plus a reset and the synthetic pipeline test. Each lever is a small,
 * swappable control; the compute-device selector is its own component.
 */
import type { BackendInfo, ReconstructDevice } from '@monoclejs/protocol'
import ComputeDeviceSelect from './ComputeDeviceSelect.vue'
import Disclosure from './Disclosure.vue'
import Icon from './Icon.vue'
import type { MachineProfile } from '../lib/capability'
import { DA3_SIZES, POSE_ESTIMATORS, QUALITY_TIERS, type Quality } from '../stores/capture'

const props = defineProps<{
  backends: BackendInfo[]
  /** The backend in effect (override, else the machine's recommendation). */
  effectiveBackend: string
  /** The value that means "no override": the recommendation or preset backend. */
  defaultBackend: string
  /** The preset's own quality, so selecting it clears the override. */
  presetQuality: Quality
  quality: Quality
  checkpoint: string
  usesCheckpoint: boolean
  device: ReconstructDevice
  profile: MachineProfile
  poseEstimator: string
  hasOverrides: boolean
  locked: boolean
}>()

const emit = defineEmits<{
  'backend-override': [id: string | null]
  'quality-override': [quality: Quality | null]
  'checkpoint-override': [checkpoint: string | null]
  device: [device: ReconstructDevice]
  pose: [pose: string]
  'reset-overrides': []
  'run-synthetic': []
}>()

// An override that matches the default is cleared, so the state stays honest.
function onBackendChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('backend-override', value === props.defaultBackend ? null : value)
}

function onQualityChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as Quality
  emit('quality-override', value === props.presetQuality ? null : value)
}

function onCheckpointChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  // base is the default; selecting it clears the override.
  emit('checkpoint-override', value === 'base' ? null : value)
}

function onPoseChange(event: Event): void {
  emit('pose', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <Disclosure title="Advanced" icon="advanced">
    <label class="field">
      <span class="faint">Depth model</span>
      <select
        :value="effectiveBackend"
        :disabled="backends.length === 0 || locked"
        @change="onBackendChange"
      >
        <option v-if="backends.length === 0" :value="effectiveBackend">
          {{ effectiveBackend }} (engine not ready)
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

    <ComputeDeviceSelect
      :device="device"
      :profile="profile"
      :locked="locked"
      @change="emit('device', $event)"
    />

    <label class="field">
      <span class="faint">Pose estimator</span>
      <select :value="poseEstimator" :disabled="locked" @change="onPoseChange">
        <option v-for="pose in POSE_ESTIMATORS" :key="pose.id" :value="pose.id">
          {{ pose.label }}
        </option>
      </select>
    </label>

    <p v-if="hasOverrides" class="note">
      <span class="faint">Overriding the defaults.</span>
      <button class="link" :disabled="locked" @click="emit('reset-overrides')">
        Reset to defaults
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
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
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
