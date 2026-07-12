<script setup lang="ts">
import { computed } from 'vue'
import type { LogNote } from '@monoclejs/protocol'
import type { SidecarStatus } from '../../../shared/ipc'
import Icon from './Icon.vue'
import StatusIndicator, { type Status } from './StatusIndicator.vue'

const props = defineProps<{
  status: SidecarStatus
  logs: LogNote[]
}>()

const emit = defineEmits<{ start: []; stop: [] }>()

const label = computed(
  () =>
    ({
      stopped: 'Stopped',
      starting: 'Starting',
      ready: 'Ready',
      error: 'Error',
    })[props.status],
)

const dotState = computed<Status>(
  () =>
    ({
      stopped: 'idle',
      starting: 'busy',
      ready: 'ok',
      error: 'danger',
    })[props.status] as Status,
)
</script>

<template>
  <section class="panel">
    <h2>Inference engine</h2>
    <div class="stack">
      <div class="row">
        <StatusIndicator :state="dotState" :label="`Inference engine ${label}`" />
        <span>{{ label }}</span>
        <span class="spacer"></span>
        <button v-if="status === 'stopped' || status === 'error'" @click="emit('start')">
          <Icon name="play" :size="14" />
          Start
        </button>
        <button v-else @click="emit('stop')">
          <Icon name="stop" :size="14" />
          Stop
        </button>
      </div>
      <p class="faint hint">
        The Python sidecar runs Depth Anything and fusion. It needs its dependencies installed; see
        sidecar/README.
      </p>
      <div v-if="logs.length" class="log mono">
        <div v-for="(line, index) in logs.slice(-6)" :key="index" :class="line.level">
          {{ line.message }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hint {
  font-size: var(--text-xs);
}
.log {
  background: var(--surface-2);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-sm);
  padding: var(--space-2);
  max-height: 120px;
  overflow-y: auto;
}
.log .warn {
  color: var(--warn);
}
.log .error {
  color: var(--danger);
}
.log .debug {
  color: var(--ink-lo);
}
</style>
