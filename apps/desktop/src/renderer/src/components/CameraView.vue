<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  stream: MediaStream | null
  active: boolean
  scanning: boolean
}>()

const video = ref<HTMLVideoElement | null>(null)

watch(
  () => props.stream,
  (stream) => {
    if (video.value) video.value.srcObject = stream
  },
)

/** Grab the current video frame as an ImageBitmap, or null when idle. */
async function grab(): Promise<ImageBitmap | null> {
  const element = video.value
  if (!element || element.readyState < 2) return null
  return createImageBitmap(element)
}

defineExpose({ grab })
</script>

<template>
  <div class="viewport">
    <video ref="video" autoplay playsinline muted></video>
    <div v-if="!active" class="overlay">
      <p class="muted">No camera stream</p>
      <p class="faint">Select a device and start the camera to preview.</p>
    </div>
    <div v-if="scanning" class="recording">
      <span class="dot"></span>
      Scanning
    </div>
    <div v-if="active" class="grid-overlay" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  background: #05070b;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
}

.recording {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(242, 109, 109, 0.15);
  border: 1px solid var(--bad);
  color: var(--bad);
  font-size: 12px;
  font-weight: 600;
}

.recording .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bad);
  animation: pulse 1.4s ease-in-out infinite;
}

.grid-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(76, 141, 255, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(76, 141, 255, 0.06) 1px, transparent 1px);
  background-size: 48px 48px;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
