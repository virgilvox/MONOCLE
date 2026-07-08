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
  gap: 8px;
  padding: 6px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-inset);
  color: var(--text-faint);
  font-size: 11px;
}
.sep {
  color: var(--border-strong);
}
</style>
