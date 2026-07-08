<script setup lang="ts">
defineProps<{
  scanning: boolean
  usesCamera: boolean
  cameraActive: boolean
  frameCount: number
  targetFrames: number
}>()

const emit = defineEmits<{ toggle: []; capture: [] }>()
</script>

<template>
  <section class="panel">
    <h2>Capture</h2>
    <div class="stack">
      <template v-if="usesCamera">
        <div class="counter">
          <span class="count mono">{{ frameCount }}</span>
          <span class="faint">
            good frames<template v-if="targetFrames > 0"> of {{ targetFrames }}</template>
          </span>
        </div>
        <button class="primary big" :disabled="!cameraActive" @click="emit('toggle')">
          {{ scanning ? 'Stop scan' : 'Start scan' }}
        </button>
        <button v-if="scanning" class="big" @click="emit('capture')">Capture this frame</button>
        <p v-if="!cameraActive" class="faint hint">Start the camera to capture.</p>
        <p v-else-if="scanning" class="faint hint">
          Sharp, well-spaced frames are kept automatically; use Capture this frame to force one.
        </p>
        <p v-else class="faint hint">Only sharp, well-spaced frames are kept.</p>
      </template>
      <template v-else>
        <p class="faint hint">
          This preset needs no camera capture. Run Reconstruct to generate the test mesh.
        </p>
      </template>
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
