<script setup lang="ts">
import { ref, watch } from 'vue'
import Icon from './Icon.vue'

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

    <!-- Instrument framing: a measured grid, corner brackets, a center
         reticle, and a vignette, so the camera reads as a viewfinder. -->
    <template v-if="active">
      <div class="grid" aria-hidden="true"></div>
      <div class="vignette" aria-hidden="true"></div>
      <div class="brackets" aria-hidden="true">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
      </div>
      <Icon name="reticle" class="crosshair" :size="34" :stroke-width="1.25" aria-hidden="true" />
    </template>

    <div v-if="!active" class="overlay">
      <Icon name="camera" :size="26" class="overlay-glyph" />
      <p class="muted">No camera stream</p>
      <p class="faint">Select a device and start the camera to preview.</p>
    </div>

    <div v-if="scanning" class="recording">
      <span class="rec-dot"></span>
      Scanning
    </div>
  </div>
</template>

<style scoped>
.viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  background: var(--viewport);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
}

video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(color-mix(in srgb, var(--accent) 7%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent) 1px, transparent 1px);
  background-size: 48px 48px;
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    120% 120% at 50% 50%,
    transparent 55%,
    color-mix(in srgb, var(--viewport) 82%, transparent) 100%
  );
}

.brackets {
  position: absolute;
  inset: var(--space-3);
  pointer-events: none;
}
.corner {
  position: absolute;
  width: 22px;
  height: 22px;
  border: var(--stroke-2) solid color-mix(in srgb, var(--accent) 65%, transparent);
}
.corner.tl {
  top: 0;
  left: 0;
  border-right: none;
  border-bottom: none;
}
.corner.tr {
  top: 0;
  right: 0;
  border-left: none;
  border-bottom: none;
}
.corner.bl {
  bottom: 0;
  left: 0;
  border-right: none;
  border-top: none;
}
.corner.br {
  bottom: 0;
  right: 0;
  border-left: none;
  border-top: none;
}

.crosshair {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: color-mix(in srgb, var(--brass) 60%, transparent);
  pointer-events: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  text-align: center;
}
.overlay-glyph {
  color: var(--ink-lo);
  margin-bottom: var(--space-1);
}

.recording {
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--r-full);
  background: var(--danger-tint);
  border: var(--stroke-1) solid var(--danger);
  color: var(--danger);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
}
.rec-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-full);
  background: var(--danger);
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
