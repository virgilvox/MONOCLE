<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BrandMark from './components/BrandMark.vue'
import CameraView from './components/CameraView.vue'
import CaptureControls from './components/CaptureControls.vue'
import CaptureHud from './components/CaptureHud.vue'
import CapabilityList from './components/CapabilityList.vue'
import DeviceSelect from './components/DeviceSelect.vue'
import Disclosure from './components/Disclosure.vue'
import EngineStatus from './components/EngineStatus.vue'
import Icon from './components/Icon.vue'
import LiveDepthView from './components/LiveDepthView.vue'
import MeshViewer from './components/MeshViewer.vue'
import ReconstructPanel from './components/ReconstructPanel.vue'
import ScanPresetPicker from './components/ScanPresetPicker.vue'
import StatusBar from './components/StatusBar.vue'
import StatusIndicator, { type Status } from './components/StatusIndicator.vue'
import WorkflowStepper, { type Step } from './components/WorkflowStepper.vue'
import type { IconName } from './components/icons/registry'
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
const engineState = computed<Status>(
  () =>
    ({ stopped: 'idle', starting: 'busy', ready: 'ok', error: 'danger' })[engine.status] as Status,
)

// The three stage tabs, backed by icon and label.
const STAGE_TABS: { id: 'camera' | 'live' | 'preview'; label: string; icon: IconName }[] = [
  { id: 'camera', label: 'Camera', icon: 'camera' },
  { id: 'live', label: 'Live depth', icon: 'lens' },
  { id: 'preview', label: '3D Preview', icon: 'wireframe' },
]

// The linear workflow, expressed as a light stepper. Camera and capture steps
// only appear for presets that actually use the camera; synthetic goes straight
// from preset to reconstruct.
const activeStepKey = computed(() => {
  if (capture.reconstructing || capture.result) return 'reconstruct'
  if (capture.usesCamera) {
    if (capture.scanning || capture.frameCount > 0) return 'capture'
    if (camera.active.value) return 'camera'
    return 'preset'
  }
  return 'reconstruct'
})

const workflowSteps = computed<Step[]>(() => {
  const ordered: { key: string; label: string; icon: IconName }[] = [
    { key: 'preset', label: 'Preset', icon: 'iris' },
  ]
  if (capture.usesCamera) {
    ordered.push({ key: 'camera', label: 'Camera', icon: 'camera' })
    ordered.push({ key: 'capture', label: 'Capture', icon: 'focus-box' })
  }
  ordered.push({ key: 'reconstruct', label: 'Reconstruct', icon: 'wireframe' })

  const activeIndex = ordered.findIndex((s) => s.key === activeStepKey.value)
  return ordered.map((step, index) => ({
    ...step,
    state: capture.result
      ? 'done'
      : index < activeIndex
        ? 'done'
        : index === activeIndex
          ? 'active'
          : 'upcoming',
  }))
})

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

async function grabFrame(force = false): Promise<void> {
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
      // Manual capture forces the frame through even when the gate would skip it.
      if (!force && !metrics.accept) return
      const png = await encodeBitmapToPng(bitmap)
      await capture.stageFrame(png)
      // A single-frame preset is done as soon as one frame lands.
      if (capture.captureStrategy === 'single') await stopScan()
    } finally {
      bitmap.close()
    }
  } finally {
    grabbing = false
  }
}

async function onManualCapture(): Promise<void> {
  await grabFrame(true)
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
        <BrandMark :size="24" />
        <span class="name">MONOCLE</span>
      </div>
      <span class="tagline faint">Webcam 3D scanning</span>
      <span class="spacer"></span>
      <div class="engine-badge" :title="`Inference engine: ${engineLabel}`">
        <StatusIndicator :state="engineState" :label="`Engine ${engineLabel}`" />
        <span class="faint">Engine</span>
        <span class="engine-value">{{ engineLabel }}</span>
      </div>
    </header>

    <main class="workspace">
      <div class="stage">
        <div class="stage-tabs" role="tablist" aria-label="Workspace view">
          <button
            v-for="tab in STAGE_TABS"
            :key="tab.id"
            role="tab"
            :aria-selected="stageView === tab.id"
            :class="{ active: stageView === tab.id }"
            :disabled="tab.id === 'preview' && !capture.result"
            @click="stageView = tab.id"
          >
            <Icon :name="tab.icon" :size="15" />
            {{ tab.label }}
          </button>
        </div>
        <div class="stage-body" role="tabpanel">
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

      <aside class="sidebar">
        <section class="group stack" aria-label="Workflow">
          <WorkflowStepper :steps="workflowSteps" />
          <ScanPresetPicker
            :selected="capture.presetId"
            :backends="engine.backends"
            :backend-override="capture.backendOverride"
            :quality="capture.quality"
            :color="capture.color"
            :has-overrides="capture.hasOverrides"
            :locked="capture.scanning"
            @select="capture.selectPreset"
            @backend-override="capture.setBackendOverride"
            @quality-override="capture.setQualityOverride"
            @color-override="capture.setColorOverride"
            @reset-overrides="capture.resetOverrides"
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
            @capture="onManualCapture"
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
        </section>

        <Disclosure title="Diagnostics" icon="diagnostics">
          <CapabilityList :capabilities="capabilities" />
          <EngineStatus
            :status="engine.status"
            :logs="engine.logs"
            @start="engine.start"
            @stop="engine.stop"
          />
        </Disclosure>
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
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--stroke-1) solid var(--line);
  background: var(--surface-1);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.name {
  font-family: var(--font-display);
  font-weight: var(--weight-bold);
  font-size: var(--text-lg);
  letter-spacing: var(--tracking-wide);
  color: var(--ink-hi);
}

.tagline {
  font-size: var(--text-xs);
}

.engine-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-full);
  font-size: var(--text-xs);
}
.engine-value {
  color: var(--ink-hi);
  font-variant-numeric: tabular-nums;
}

.workspace {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: var(--space-4);
  padding: var(--space-4);
  min-height: 0;
}

.stage {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
}

.stage-tabs {
  display: flex;
  gap: var(--space-1);
}

.stage-tabs button {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--ink);
  background: transparent;
  border-color: transparent;
}
.stage-tabs button:hover:not(:disabled) {
  background: var(--surface-1);
  border-color: var(--line);
}
.stage-tabs button.active {
  border-color: var(--accent);
  background: var(--accent-tint);
  color: var(--ink-hi);
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
  padding-right: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.group {
  gap: var(--space-4);
}
</style>
