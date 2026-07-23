<script setup lang="ts">
import { computed } from 'vue'
import {
  assessMethods,
  describeMachine,
  livePreviewSupport,
  type MachineProfile,
  type SpeedTier,
} from '../lib/capability'

const props = defineProps<{
  profile: MachineProfile
  /** The backend the current selection resolves to, so the list can mark it. */
  effectiveBackend: string
}>()

const summary = computed(() => describeMachine(props.profile))
const methods = computed(() => assessMethods(props.profile))
const live = computed(() => livePreviewSupport(props.profile))

const SPEED_LABEL: Record<SpeedTier, string> = {
  fast: 'Fast',
  moderate: 'OK',
  slow: 'Slow',
  unavailable: 'N/A',
}
</script>

<template>
  <section class="panel">
    <h2>Your machine</h2>
    <div class="stack">
      <p class="summary">{{ summary }}</p>
      <ul class="methods">
        <li v-for="method in methods" :key="method.backend">
          <span class="mlabel">
            {{ method.label }}
            <span v-if="method.backend === effectiveBackend" class="current">Current</span>
          </span>
          <span class="speed" :class="method.speed">{{ SPEED_LABEL[method.speed] }}</span>
          <span class="note faint">{{ method.note }}</span>
        </li>
      </ul>
      <p class="faint live" :class="{ off: live.speed === 'unavailable' }">{{ live.note }}</p>
    </div>
  </section>
</template>

<style scoped>
.summary {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-hi);
}
.methods {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.methods li {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}
.mlabel {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.current {
  font-family: var(--font-mono);
  font-size: var(--text-2xs, 11px);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 100px;
  white-space: nowrap;
  color: var(--ink-hi);
  border: var(--stroke-1) solid var(--accent);
  margin-left: var(--space-1);
}
.note {
  grid-column: 1 / -1;
  font-size: var(--text-xs);
}
.speed {
  font-family: var(--font-mono);
  font-size: var(--text-2xs, 11px);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 7px;
  border-radius: 100px;
  white-space: nowrap;
}
.speed.fast {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.speed.moderate {
  color: var(--brass);
  background: color-mix(in srgb, var(--brass) 18%, transparent);
}
.speed.slow,
.speed.unavailable {
  color: var(--ink-lo);
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.live {
  font-size: var(--text-xs);
}
.live.off {
  opacity: 0.7;
}
</style>
