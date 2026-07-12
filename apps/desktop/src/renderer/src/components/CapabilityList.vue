<script setup lang="ts">
import type { GpuCapabilities } from '../composables/useGpu'
import StatusIndicator from './StatusIndicator.vue'

defineProps<{ capabilities: GpuCapabilities }>()
</script>

<template>
  <section class="panel">
    <h2>Rendering</h2>
    <div class="stack">
      <div class="row">
        <StatusIndicator
          :state="capabilities.webgl2 ? 'ok' : 'danger'"
          :label="`WebGL2 ${capabilities.webgl2 ? 'available' : 'missing'}`"
        />
        <span>WebGL2</span>
        <span class="spacer"></span>
        <span class="faint">{{ capabilities.webgl2 ? 'available' : 'missing' }}</span>
      </div>
      <div class="row">
        <StatusIndicator
          :state="capabilities.webgpu ? 'ok' : 'warn'"
          :label="`WebGPU ${capabilities.webgpu ? 'available' : 'falling back to WebGL2'}`"
        />
        <span>WebGPU</span>
        <span class="spacer"></span>
        <span class="faint">{{ capabilities.webgpu ? 'available' : 'fallback to WebGL2' }}</span>
      </div>
      <p v-if="capabilities.adapter" class="mono faint">{{ capabilities.adapter }}</p>
    </div>
  </section>
</template>
