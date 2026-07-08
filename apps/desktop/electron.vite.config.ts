import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Workspace libraries are bundled into the main and preload output rather than
// externalized, so the packaged app does not depend on the pnpm store layout.
const workspaceLibs = ['@monoclejs/core', '@monoclejs/mesh-io', '@monoclejs/protocol']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceLibs })],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspaceLibs })],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') },
    },
    plugins: [vue()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
