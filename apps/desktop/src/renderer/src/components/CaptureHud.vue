<script setup lang="ts">
import { computed } from 'vue'
import type { GateReason } from '../composables/useKeyframeGate'
import type { CaptureStrategy } from '../stores/capture'

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
</script>

<template>
  <div v-if="scanning" class="hud" aria-live="polite">
    <div class="top-row">
      <span class="badge" :class="guidance.tone">{{ guidance.text }}</span>
      <span class="frames mono">
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
  inset: 12px 12px auto 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius);
  background: rgba(8, 11, 18, 0.72);
  border: 1px solid var(--border);
  backdrop-filter: blur(6px);
  pointer-events: none;
}
.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.badge {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  border: 1px solid var(--border-strong);
}
.badge.good {
  color: var(--good);
  border-color: var(--good);
  background: rgba(55, 211, 155, 0.12);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
  background: rgba(242, 184, 75, 0.12);
}
.badge.wait {
  color: var(--text-dim);
}
.frames {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
}
.frames .unit {
  margin-left: 5px;
  font-size: 11px;
  font-weight: 400;
}
.coverage {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.track {
  height: 5px;
  border-radius: 3px;
  background: var(--bg-inset);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s;
}
.hint {
  font-size: 11px;
}
.meters {
  display: flex;
  gap: 12px;
}
.meter {
  font-size: 11px;
  color: var(--text-dim);
}
.meter.dim {
  color: var(--text-faint);
}
</style>
