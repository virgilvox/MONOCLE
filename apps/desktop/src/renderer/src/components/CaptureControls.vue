<script setup lang="ts">
defineProps<{
  scanning: boolean
  canScan: boolean
  cameraActive: boolean
  frameCount: number
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <section class="panel">
    <h2>Capture</h2>
    <div class="stack">
      <div class="counter">
        <span class="count mono">{{ frameCount }}</span>
        <span class="faint">keyframes</span>
      </div>
      <button class="primary big" :disabled="!canScan || !cameraActive" @click="emit('toggle')">
        {{ scanning ? 'Stop scan' : 'Start scan' }}
      </button>
      <p v-if="!cameraActive" class="faint hint">Start the camera to capture.</p>
      <p v-else-if="!canScan" class="faint hint">This method is not available yet.</p>
    </div>
  </section>
</template>

<style scoped>
.counter {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.count {
  font-size: 30px;
  font-weight: 700;
  color: var(--text);
}
.big {
  width: 100%;
  padding: 12px;
  font-weight: 600;
}
.hint {
  font-size: 12px;
}
</style>
