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
    // The depth worker is imported with new URL('./depthWorker', import.meta.url);
    // building it as an ES module keeps its onnxruntime-web import intact.
    worker: { format: 'es' },
    // onnxruntime-web ships wasm it fetches at runtime rather than importing, so
    // pre-bundling it only slows dev startup and can mangle the wasm loader.
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    // Large model and runtime binaries are served from public/, but treat these
    // extensions as assets anywhere they are imported rather than inlined.
    assetsInclude: ['**/*.onnx', '**/*.onnx_data', '**/*.wasm'],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
