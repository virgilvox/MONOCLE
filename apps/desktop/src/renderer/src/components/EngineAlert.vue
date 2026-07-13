<script setup lang="ts">
import Icon from './Icon.vue'
import StatusIndicator from './StatusIndicator.vue'
import type { SidecarStatus } from '../../../shared/ipc'

const props = defineProps<{
  status: SidecarStatus
  /** A short reason drawn from the engine's last error log, if any. */
  message: string | null
  /** True while a restart is in flight, to keep the action from repeating. */
  restarting: boolean
}>()

defineEmits<{ restart: [] }>()

// Only speak up when the engine has actually failed. 'stopped' is the normal
// pre-start state and 'starting'/'ready' need no action here.
const visible = () => props.status === 'error'
</script>

<template>
  <section v-if="visible()" class="engine-alert" role="alert">
    <div class="head">
      <StatusIndicator state="danger" label="Engine error" />
      <span class="title">The inference engine stopped</span>
    </div>
    <p class="detail">
      Reconstruction and live depth are unavailable until it restarts.
      <span v-if="message" class="reason">{{ message }}</span>
    </p>
    <button class="primary" :disabled="restarting" @click="$emit('restart')">
      <Icon name="reset" :size="15" />
      {{ restarting ? 'Restarting…' : 'Restart engine' }}
    </button>
  </section>
</template>

<style scoped>
.engine-alert {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: var(--stroke-1) solid var(--danger);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.title {
  font-weight: 600;
  font-size: var(--text-sm);
}
.detail {
  font-size: var(--text-xs);
  color: var(--ink-lo);
}
.reason {
  display: block;
  margin-top: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--ink-lo);
  word-break: break-word;
}
</style>
