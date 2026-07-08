<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import CameraView from './components/CameraView.vue'
import CaptureControls from './components/CaptureControls.vue'
import CapabilityList from './components/CapabilityList.vue'
import DeviceSelect from './components/DeviceSelect.vue'
import EngineStatus from './components/EngineStatus.vue'
import ReconstructPanel from './components/ReconstructPanel.vue'
import ScanMethodPicker from './components/ScanMethodPicker.vue'
import StatusBar from './components/StatusBar.vue'
import { useCamera } from './composables/useCamera'
import { encodeBitmapToPng } from './composables/useFrameEncoder'
import { useGpu } from './composables/useGpu'
import { useCaptureStore } from './stores/capture'
import { useEngineStore } from './stores/engine'
import type { AppInfo } from '../../shared/ipc'

const camera = useCamera()
const { capabilities, detect } = useGpu()
const capture = useCaptureStore()
const engine = useEngineStore()

const cameraView = ref<InstanceType<typeof CameraView> | null>(null)
const appInfo = ref<AppInfo | null>(null)
let captureTimer: ReturnType<typeof setInterval> | null = null

// Grab a keyframe roughly three times a second while scanning. Real keyframe
// selection (blur and pose delta) lands with the depth pipeline.
const CAPTURE_INTERVAL_MS = 320

onMounted(async () => {
  appInfo.value = await window.api.getAppInfo()
  engine.bind()
  await detect()
  await camera.listDevices()
})

onBeforeUnmount(stopCaptureLoop)

async function startCamera(deviceId: string | undefined): Promise<void> {
  await window.api.requestCameraAccess()
  await camera.start(deviceId)
}

function onMethodSelect(method: Parameters<typeof capture.selectMethod>[0]): void {
  capture.selectMethod(method)
}

async function toggleScan(): Promise<void> {
  if (capture.scanning) {
    stopCaptureLoop()
    await capture.endScan()
    return
  }
  await capture.beginScan()
  captureTimer = setInterval(grabFrame, CAPTURE_INTERVAL_MS)
}

async function grabFrame(): Promise<void> {
  const bitmap = await cameraView.value?.grab()
  if (!bitmap) return
  try {
    const png = await encodeBitmapToPng(bitmap)
    await capture.stageFrame(png)
  } finally {
    bitmap.close()
  }
}

function stopCaptureLoop(): void {
  if (captureTimer) {
    clearInterval(captureTimer)
    captureTimer = null
  }
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="mark"></span>
        <span class="name">MONOCLE</span>
      </div>
      <span class="tagline faint">Webcam 3D scanning</span>
    </header>

    <main class="workspace">
      <div class="stage">
        <CameraView
          ref="cameraView"
          :stream="camera.stream.value"
          :active="camera.active.value"
          :scanning="capture.scanning"
        />
      </div>

      <aside class="sidebar stack">
        <ScanMethodPicker
          :selected="capture.method"
          :locked="capture.scanning"
          @select="onMethodSelect"
        />
        <DeviceSelect
          :devices="camera.devices.value"
          :active-device-id="camera.activeDeviceId.value"
          :active="camera.active.value"
          :error="camera.error.value"
          @start="startCamera"
          @stop="camera.stop"
          @change="startCamera"
        />
        <CaptureControls
          :scanning="capture.scanning"
          :can-scan="capture.canScan"
          :camera-active="camera.active.value"
          :frame-count="capture.frameCount"
          @toggle="toggleScan"
        />
        <ReconstructPanel
          :status="engine.status"
          :backends="engine.backends"
          :progress="engine.progress"
          :reconstructing="capture.reconstructing"
          :result="capture.result"
          :error="capture.reconstructError"
          @reconstruct="capture.runReconstruction"
          @save="capture.exportResult"
        />
        <CapabilityList :capabilities="capabilities" />
        <EngineStatus
          :status="engine.status"
          :logs="engine.logs"
          @start="engine.start"
          @stop="engine.stop"
        />
      </aside>
    </main>

    <StatusBar
      :app-info="appInfo"
      :engine-status="engine.status"
      :camera-active="camera.active.value"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-inset);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mark {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 3px solid var(--accent);
}

.name {
  font-weight: 700;
  letter-spacing: 0.14em;
}

.workspace {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: var(--gap);
  padding: var(--gap);
  min-height: 0;
}

.stage {
  min-height: 0;
}

.sidebar {
  overflow-y: auto;
  padding-right: 4px;
}
</style>
