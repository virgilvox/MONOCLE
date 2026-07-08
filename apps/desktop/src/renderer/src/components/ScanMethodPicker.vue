<script setup lang="ts">
import { SCAN_METHODS, type ScanMethod } from '../stores/capture'

defineProps<{
  selected: ScanMethod
  locked: boolean
}>()

const emit = defineEmits<{ select: [method: ScanMethod] }>()
</script>

<template>
  <section class="panel">
    <h2>Scan method</h2>
    <div class="methods">
      <button
        v-for="method in SCAN_METHODS"
        :key="method.id"
        class="method"
        :class="{ selected: method.id === selected }"
        :disabled="!method.available || locked"
        @click="emit('select', method.id)"
      >
        <span class="label">
          {{ method.label }}
          <span v-if="!method.available" class="tag">planned</span>
        </span>
        <span class="desc faint">{{ method.description }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.methods {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.method {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
}

.method.selected {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.desc {
  font-size: 12px;
}

.tag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
