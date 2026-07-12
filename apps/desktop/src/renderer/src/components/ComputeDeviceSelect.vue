<script setup lang="ts">
/**
 * The heavy-path compute device lever. `auto` picks the best the machine offers;
 * the explicit devices force one. A GPU the machine does not currently report is
 * still selectable but annotated "not detected", so a scan set up on one machine
 * carries a sensible intent to a later, stronger one.
 */
import type { ReconstructDevice } from '@monoclejs/protocol'
import { deviceAvailable, type MachineProfile } from '../lib/capability'
import { COMPUTE_DEVICES } from '../stores/capture'

const props = defineProps<{
  device: ReconstructDevice
  profile: MachineProfile
  locked: boolean
}>()

const emit = defineEmits<{
  change: [device: ReconstructDevice]
}>()

function available(device: ReconstructDevice): boolean {
  return deviceAvailable(device, props.profile)
}

function onChange(event: Event): void {
  emit('change', (event.target as HTMLSelectElement).value as ReconstructDevice)
}
</script>

<template>
  <label class="field">
    <span class="faint">Compute device</span>
    <select :value="device" :disabled="locked" @change="onChange">
      <option v-for="d in COMPUTE_DEVICES" :key="d.id" :value="d.id">
        {{ d.label }}{{ available(d.id) ? '' : ' (not detected)' }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
}
</style>
