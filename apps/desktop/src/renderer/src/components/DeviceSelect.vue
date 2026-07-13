<script setup lang="ts">
import type { CameraDevice } from '../composables/useCamera'
import Icon from './Icon.vue'

defineProps<{
  devices: CameraDevice[]
  activeDeviceId: string | null
  active: boolean
  error: string | null
}>()

const emit = defineEmits<{
  start: [deviceId: string | undefined]
  stop: []
  change: [deviceId: string]
}>()

function onChange(event: Event): void {
  emit('change', (event.target as HTMLSelectElement).value)
}
</script>

<template>
  <section class="panel">
    <h2>Camera</h2>
    <div class="stack">
      <select
        :value="activeDeviceId ?? ''"
        :disabled="devices.length === 0"
        aria-label="Camera device"
        @change="onChange"
      >
        <option v-if="devices.length === 0" value="">No cameras detected</option>
        <option v-for="device in devices" :key="device.deviceId" :value="device.deviceId">
          {{ device.label }}
        </option>
      </select>
      <div class="row">
        <button v-if="!active" class="primary" @click="emit('start', activeDeviceId ?? undefined)">
          <Icon name="camera" :size="15" />
          Start camera
        </button>
        <button v-else @click="emit('stop')">
          <Icon name="camera" :size="15" />
          Stop camera
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.error {
  color: var(--danger);
  font-size: var(--text-xs);
}
</style>
