<script setup lang="ts">
import type { GpuCapabilities } from '../composables/useGpu'

defineProps<{ capabilities: GpuCapabilities }>()
</script>

<template>
  <section class="panel">
    <h2>Rendering</h2>
    <div class="stack">
      <div class="row">
        <span class="dot" :class="capabilities.webgl2 ? 'good' : 'bad'"></span>
        <span>WebGL2</span>
        <span class="spacer"></span>
        <span class="faint">{{ capabilities.webgl2 ? 'available' : 'missing' }}</span>
      </div>
      <div class="row">
        <span class="dot" :class="capabilities.webgpu ? 'good' : 'warn'"></span>
        <span>WebGPU</span>
        <span class="spacer"></span>
        <span class="faint">{{ capabilities.webgpu ? 'available' : 'fallback to WebGL2' }}</span>
      </div>
      <p v-if="capabilities.adapter" class="mono faint">{{ capabilities.adapter }}</p>
    </div>
  </section>
</template>

<style scoped>
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.good {
  background: var(--good);
}
.dot.warn {
  background: var(--warn);
}
.dot.bad {
  background: var(--bad);
}
</style>
