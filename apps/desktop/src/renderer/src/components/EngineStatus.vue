<script setup lang="ts">
import { computed } from 'vue'
import type { LogNote } from '@monoclejs/protocol'
import type { SidecarStatus } from '../../../shared/ipc'

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

const dotClass = computed(
  () =>
    ({
      stopped: 'faint-dot',
      starting: 'warn',
      ready: 'good',
      error: 'bad',
    })[props.status],
)
</script>

<template>
  <section class="panel">
    <h2>Inference engine</h2>
    <div class="stack">
      <div class="row">
        <span class="dot" :class="dotClass"></span>
        <span>{{ label }}</span>
        <span class="spacer"></span>
        <button v-if="status === 'stopped' || status === 'error'" @click="emit('start')">
          Start
        </button>
        <button v-else @click="emit('stop')">Stop</button>
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
.dot.faint-dot {
  background: var(--text-faint);
}
.hint {
  font-size: 12px;
}
.log {
  background: var(--bg-inset);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  max-height: 120px;
  overflow-y: auto;
}
.log .warn {
  color: var(--warn);
}
.log .error {
  color: var(--bad);
}
.log .debug {
  color: var(--text-faint);
}
</style>
