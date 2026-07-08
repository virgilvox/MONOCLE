<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CameraView from './components/CameraView.vue'
import CaptureControls from './components/CaptureControls.vue'
import CaptureHud from './components/CaptureHud.vue'
import CapabilityList from './components/CapabilityList.vue'
import DeviceSelect from './components/DeviceSelect.vue'
import EngineStatus from './components/EngineStatus.vue'
import LiveDepthView from './components/LiveDepthView.vue'
import MeshViewer from './components/MeshViewer.vue'
import ReconstructPanel from './components/ReconstructPanel.vue'
import ScanPresetPicker from './components/ScanPresetPicker.vue'
import StatusBar from './components/StatusBar.vue'
import { useCamera } from './composables/useCamera'
import { encodeBitmapToPng } from './composables/useFrameEncoder'
import { useGpu } from './composables/useGpu'
import { type GateReason, useKeyframeGate } from './composables/useKeyframeGate'
import { useCaptureStore } from './stores/capture'
import { useEngineStore } from './stores/engine'
import type { AppInfo, SidecarStatus } from '../../shared/ipc'

const camera = useCamera()
const { capabilities, detect } = useGpu()
const capture = useCaptureStore()
const engine = useEngineStore()
const gate = useKeyframeGate()

const cameraView = ref<InstanceType<typeof CameraView> | null>(null)
const appInfo = ref<AppInfo | null>(null)
const stageView = ref<'camera' | 'live' | 'preview'>('camera')

// HUD feedback from the keyframe gate.
const gateReason = ref<GateReason>('searching')
const gateSharpness = ref(0)

// Poll the camera a few times a second; the gate decides what to keep.
const GRAB_INTERVAL_MS = 200
let captureTimer: ReturnType<typeof setInterval> | null = null
let grabbing = false

const ENGINE_LABELS: Record<SidecarStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  ready: 'Ready',
  error: 'Error',
}
const engineLabel = computed(() => ENGINE_LABELS[engine.status])
const engineDot = computed(
  () => ({ stopped: 'idle', starting: 'warn', ready: 'good', error: 'bad' })[engine.status],
)

const canReconstruct = computed(
  () =>
    engine.status === 'ready' &&
    !capture.reconstructing &&
    (capture.captureStrategy === 'synthetic' || capture.frameCount > 0),
)

// Jump to the 3D preview automatically once a reconstruction lands.
watch(
  () => capture.result,
  (result) => {
    if (result) stageView.value = 'preview'
  },
)

onMounted(async () => {
  appInfo.value = await window.api.getAppInfo()
  engine.bind()
  void engine.start()
  await detect()
  await camera.listDevices()
})

onBeforeUnmount(stopCaptureLoop)

async function startCamera(deviceId: string | undefined): Promise<void> {
  await window.api.requestCameraAccess()
  await camera.start(deviceId)
}

async function toggleScan(): Promise<void> {
  if (capture.scanning) {
    await stopScan()
    return
  }
  gate.reset()
  gateReason.value = 'searching'
  gateSharpness.value = 0
  await capture.beginScan()
  captureTimer = setInterval(() => void grabFrame(), GRAB_INTERVAL_MS)
}

async function stopScan(): Promise<void> {
  stopCaptureLoop()
  await capture.endScan()
}

async function grabFrame(): Promise<void> {
  // In-flight guard: never let two grabs overlap.
  if (grabbing || !capture.scanning) return
  grabbing = true
  try {
    const bitmap = await cameraView.value?.grab()
    if (!bitmap) return
    try {
      const metrics = gate.evaluate(bitmap)
      gateReason.value = metrics.reason
      gateSharpness.value = metrics.sharpness
      if (!metrics.accept) return
      const png = await encodeBitmapToPng(bitmap)
      await capture.stageFrame(png)
      // A single-frame preset is done as soon as one good frame lands.
      if (capture.captureStrategy === 'single') await stopScan()
    } finally {
      bitmap.close()
    }
  } finally {
    grabbing = false
  }
}

function stopCaptureLoop(): void {
  if (captureTimer) {
    clearInterval(captureTimer)
    captureTimer = null
  }
}

async function onCancelReconstruct(): Promise<void> {
  await capture.cancelReconstruction()
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
      <span class="spacer"></span>
      <div class="engine-badge" :title="`Inference engine: ${engineLabel}`">
        <span class="dot" :class="engineDot"></span>
        <span class="faint">Engine</span>
        <span>{{ engineLabel }}</span>
      </div>
    </header>

    <main class="workspace">
      <div class="stage">
        <div class="stage-tabs">
          <button :class="{ active: stageView === 'camera' }" @click="stageView = 'camera'">
            Camera
          </button>
          <button :class="{ active: stageView === 'live' }" @click="stageView = 'live'">
            Live depth
          </button>
          <button
            :class="{ active: stageView === 'preview' }"
            :disabled="!capture.result"
            @click="stageView = 'preview'"
          >
            3D Preview
          </button>
        </div>
        <div class="stage-body">
          <div v-show="stageView === 'camera'" class="layer">
            <CameraView
              ref="cameraView"
              :stream="camera.stream.value"
              :active="camera.active.value"
              :scanning="capture.scanning"
            />
            <CaptureHud
              :scanning="capture.scanning"
              :strategy="capture.captureStrategy"
              :staged="capture.frameCount"
              :target="capture.targetFrames"
              :reason="gateReason"
              :sharpness="gateSharpness"
            />
          </div>
          <LiveDepthView
            v-show="stageView === 'live'"
            class="layer"
            :stream="camera.stream.value"
            :active="stageView === 'live'"
            :quality="capture.quality"
          />
          <MeshViewer
            v-if="stageView === 'preview'"
            class="layer"
            :data="capture.meshData"
            :format="capture.meshFormat"
            :has-result="capture.result !== null"
          />
        </div>
      </div>

      <aside class="sidebar stack">
        <ScanPresetPicker
          :selected="capture.presetId"
          :backends="engine.backends"
          :backend-override="capture.backendOverride"
          :locked="capture.scanning"
          @select="capture.selectPreset"
          @backend-override="capture.setBackendOverride"
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
          :uses-camera="capture.usesCamera"
          :camera-active="camera.active.value"
          :frame-count="capture.frameCount"
          :target-frames="capture.targetFrames"
          @toggle="toggleScan"
        />
        <ReconstructPanel
          :status="engine.status"
          :progress="engine.progress"
          :reconstructing="capture.reconstructing"
          :can-reconstruct="canReconstruct"
          :result="capture.result"
          :error="capture.reconstructError"
          :saved-path="capture.savedPath"
          :preset-label="capture.activePreset.label"
          @reconstruct="capture.runReconstruction"
          @cancel="onCancelReconstruct"
          @save="(r) => capture.saveArtifact(r.sourcePath, r.defaultName)"
          @reveal="capture.reveal"
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

.engine-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
}

.engine-badge .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.engine-badge .dot.good {
  background: var(--good);
}
.engine-badge .dot.warn {
  background: var(--warn);
}
.engine-badge .dot.bad {
  background: var(--bad);
}
.engine-badge .dot.idle {
  background: var(--text-faint);
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
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.stage-tabs {
  display: flex;
  gap: 6px;
}

.stage-tabs button {
  padding: 5px 12px;
  font-size: 12px;
}

.stage-tabs button.active {
  border-color: var(--accent);
  background: var(--accent-dim);
}

.stage-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.stage-body > .layer {
  height: 100%;
}

.layer {
  position: relative;
}

.sidebar {
  overflow-y: auto;
  padding-right: 4px;
}
</style>
