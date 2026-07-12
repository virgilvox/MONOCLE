<script setup lang="ts">
/**
 * A status mark that never relies on color alone: each state has a distinct
 * silhouette (disc, triangle, diamond, ring, sweeping arc) so it reads for
 * color-blind users and in grayscale. Color reinforces, it does not carry.
 */
import { computed } from 'vue'

export type Status = 'ok' | 'warn' | 'danger' | 'idle' | 'busy'

const props = withDefaults(defineProps<{ state: Status; label?: string }>(), {})

const SHAPES: Record<Status, { d?: string; ring?: boolean; tone: string; name: string }> = {
  ok: { d: 'M6 2 A4 4 0 1 1 6 10 A4 4 0 1 1 6 2 Z', tone: 'var(--ok)', name: 'OK' },
  warn: { d: 'M6 1.5 L10.6 9.8 H1.4 Z', tone: 'var(--warn)', name: 'Warning' },
  danger: { d: 'M6 1.4 L10.6 6 L6 10.6 L1.4 6 Z', tone: 'var(--danger)', name: 'Error' },
  idle: { ring: true, tone: 'var(--ink-lo)', name: 'Idle' },
  busy: { ring: true, tone: 'var(--warn)', name: 'Working' },
}

const shape = computed(() => SHAPES[props.state])
const accessibleName = computed(() => props.label ?? shape.value.name)
</script>

<template>
  <span class="status" :class="`is-${state}`" role="img" :aria-label="accessibleName">
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle
        v-if="shape.ring"
        cx="6"
        cy="6"
        r="3.6"
        fill="none"
        :stroke="shape.tone"
        stroke-width="1.6"
        :stroke-dasharray="state === 'busy' ? '9 5' : undefined"
        :class="{ spin: state === 'busy' }"
      />
      <path v-else :d="shape.d" :fill="shape.tone" />
    </svg>
  </span>
</template>

<style scoped>
.status {
  display: inline-flex;
  flex: none;
}
.spin {
  transform-origin: 6px 6px;
  animation: status-spin 1.1s linear infinite;
}
@keyframes status-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
