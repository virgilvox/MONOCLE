<script setup lang="ts">
/**
 * A labeled, collapsible section with a proper button header: a rotating
 * chevron, an accessible aria-expanded/aria-controls pair, and keyboard focus.
 * Used to demote the Diagnostics group and to hold the Advanced backend
 * controls, so the two collapsibles in the app behave identically.
 */
import { ref, useId } from 'vue'
import Icon from './Icon.vue'
import type { IconName } from './icons/registry'

const props = withDefaults(
  defineProps<{ title: string; icon?: IconName; defaultOpen?: boolean }>(),
  { defaultOpen: false },
)

const open = ref(props.defaultOpen)
const panelId = useId()
</script>

<template>
  <section class="disclosure">
    <button class="head" :aria-expanded="open" :aria-controls="panelId" @click="open = !open">
      <Icon name="chevron" class="chevron" :class="{ open }" :size="14" />
      <Icon v-if="icon" :name="icon" :size="14" />
      <span class="title">{{ title }}</span>
    </button>
    <div v-show="open" :id="panelId" class="panel-body stack">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.disclosure {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.head {
  justify-content: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-1);
  border: none;
  background: none;
  color: var(--ink-lo);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
}
.head:hover:not(:disabled) {
  color: var(--ink);
}
.chevron {
  transition: transform var(--dur-fast) var(--ease);
}
.chevron.open {
  transform: rotate(90deg);
}
.title {
  color: inherit;
}
</style>
