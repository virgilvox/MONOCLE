<script setup lang="ts">
import { computed } from 'vue'
import StatusIndicator, { type Status } from './StatusIndicator.vue'
import type { GateReason } from '../composables/useKeyframeGate'
import type { CaptureStrategy } from '../lib/presets'

const props = defineProps<{
  scanning: boolean
  strategy: CaptureStrategy
  staged: number
  target: number
  reason: GateReason
  sharpness: number
}>()

const coverage = computed(() => {
  if (props.target <= 0) return 0
  return Math.min(props.staged / props.target, 1)
})

const guidance = computed<{ text: string; tone: 'good' | 'warn' | 'wait' }>(() => {
  switch (props.reason) {
    case 'accepted':
    case 'first':
      return { text: 'Good frame captured', tone: 'good' }
    case 'too-blurry':
      return { text: 'Too blurry, hold the camera still', tone: 'warn' }
    case 'hold-steady':
      return { text: 'Moving too fast, slow down', tone: 'warn' }
    case 'move-more':
      return { text: 'Move to a new angle', tone: 'wait' }
    default:
      return { text: 'Looking for a sharp frame', tone: 'wait' }
  }
})

const coverageHint = computed(() => {
  if (props.strategy === 'single') return 'Capturing one sharp frame'
  if (coverage.value >= 1) return 'Plenty of coverage, you can stop'
  if (props.staged === 0) return 'Start moving around the subject'
  return 'Keep circling for full coverage'
})

// Guidance tone maps to a distinct status shape so it never depends on color.
const guidanceState = computed<Status>(
  () => ({ good: 'ok', warn: 'warn', wait: 'idle' })[guidance.value.tone] as Status,
)
</script>

<template>
  <div v-if="scanning" class="hud" aria-live="polite">
    <div class="top-row">
      <span class="badge" :class="guidance.tone">
        <StatusIndicator :state="guidanceState" :label="guidance.text" />
        {{ guidance.text }}
      </span>
      <span class="frames numeric">
        {{ staged }}<span class="faint" v-if="target > 0"> / {{ target }}</span>
        <span class="faint unit">frames</span>
      </span>
    </div>

    <div v-if="strategy !== 'single'" class="coverage">
      <div class="track">
        <div class="fill" :style="{ width: `${Math.round(coverage * 100)}%` }"></div>
      </div>
      <span class="hint faint">{{ coverageHint }}</span>
    </div>

    <div class="meters">
      <span class="meter mono" :class="{ dim: sharpness < 55 }">
        focus {{ Math.round(sharpness) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.hud {
  position: absolute;
  inset: var(--space-3) var(--space-3) auto var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--surface-0) 82%, transparent);
  border: var(--stroke-1) solid var(--line);
  box-shadow: var(--elevation-2);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--r-full);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  border: var(--stroke-1) solid var(--line-strong);
}
.badge.good {
  color: var(--ok);
  border-color: var(--ok-line);
  background: var(--ok-tint);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn-line);
  background: var(--warn-tint);
}
.badge.wait {
  color: var(--ink);
}
.frames {
  font-size: var(--text-lg);
  font-weight: var(--weight-bold);
  color: var(--ink-hi);
}
.frames .unit {
  margin-left: var(--space-1);
  font-size: var(--text-2xs);
  font-weight: var(--weight-normal);
}
.coverage {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.track {
  height: 5px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width var(--dur) var(--ease);
}
.hint {
  font-size: var(--text-2xs);
}
.meters {
  display: flex;
  gap: var(--space-3);
}
.meter {
  font-size: var(--text-2xs);
  color: var(--ink);
}
.meter.dim {
  color: var(--ink-lo);
}
</style>
