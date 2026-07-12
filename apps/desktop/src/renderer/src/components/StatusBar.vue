<script setup lang="ts">
import type { AppInfo } from '../../../shared/ipc'

defineProps<{
  appInfo: AppInfo | null
  engineStatus: string
  cameraActive: boolean
}>()
</script>

<template>
  <footer class="status-bar mono">
    <span>MONOCLE {{ appInfo ? `v${appInfo.version}` : '' }}</span>
    <span class="sep">/</span>
    <span>{{ appInfo ? `${appInfo.platform}-${appInfo.arch}` : '' }}</span>
    <span class="spacer"></span>
    <span>camera {{ cameraActive ? 'on' : 'off' }}</span>
    <span class="sep">/</span>
    <span>engine {{ engineStatus }}</span>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-top: var(--stroke-1) solid var(--line);
  background: var(--surface-2);
  color: var(--ink-lo);
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
}
.sep {
  color: var(--line-strong);
}
</style>
