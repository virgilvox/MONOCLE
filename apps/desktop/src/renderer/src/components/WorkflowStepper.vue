<script setup lang="ts">
/**
 * A light vertical stepper that makes the linear scan flow legible at a glance:
 * preset, camera, capture, reconstruct. The active step is lit in the accent
 * and completed steps carry a check, so the app reads as an instrument with a
 * current setting rather than six interchangeable cards.
 */
import Icon from './Icon.vue'
import type { IconName } from './icons/registry'

export type StepState = 'done' | 'active' | 'upcoming'

export interface Step {
  key: string
  label: string
  icon: IconName
  state: StepState
}

defineProps<{ steps: Step[] }>()
</script>

<template>
  <ol class="stepper" aria-label="Scan workflow">
    <li v-for="step in steps" :key="step.key" class="step" :class="`is-${step.state}`">
      <span class="node" aria-hidden="true">
        <Icon v-if="step.state === 'done'" name="check" :size="12" :stroke-width="2.4" />
        <Icon v-else :name="step.icon" :size="13" />
      </span>
      <span class="label">{{ step.label }}</span>
      <span v-if="step.state === 'active'" class="tag">now</span>
    </li>
  </ol>
</template>

<style scoped>
.stepper {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-md);
  background: var(--surface-0);
}
.step {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  color: var(--ink-lo);
  font-size: var(--text-sm);
}
/* The connecting rail between nodes. */
.step:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 26px;
  bottom: -6px;
  width: var(--stroke-2);
  background: var(--line);
}
.node {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: var(--r-full);
  border: var(--stroke-2) solid var(--line-strong);
  background: var(--surface-1);
  color: var(--ink-lo);
}
.is-done {
  color: var(--ink);
}
.is-done .node {
  border-color: var(--ok-line);
  color: var(--ok);
}
.is-active {
  color: var(--ink-hi);
}
.is-active .node {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-tint);
}
.label {
  font-weight: var(--weight-medium);
}
.tag {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--accent);
}
</style>
