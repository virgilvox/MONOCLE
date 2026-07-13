<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdvancedControls from './components/AdvancedControls.vue'
import BrandMark from './components/BrandMark.vue'
import CameraView from './components/CameraView.vue'
import CaptureControls from './components/CaptureControls.vue'
import CaptureHud from './components/CaptureHud.vue'
import CapabilityList from './components/CapabilityList.vue'
import DeviceSelect from './components/DeviceSelect.vue'
import Disclosure from './components/Disclosure.vue'
import EngineAlert from './components/EngineAlert.vue'
import EngineStatus from './components/EngineStatus.vue'
import Icon from './components/Icon.vue'
import ImportMedia from './components/ImportMedia.vue'
import LiveDepthView from './components/LiveDepthView.vue'
import MachineAdvisor from './components/MachineAdvisor.vue'
import { recommendedDefault, toComputeDevice, type MachineProfile } from './lib/capability'
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

// Experimental live reconstruction: a mesh that forms in the 3D preview as the
// scan runs. Only applies to multi-view (walk-around) captures.
const liveEnabled = ref(false)
const liveActive = ref(false)
const liveMeshData = ref<Uint8Array | null>(null)
const liveFrameCount = ref(0)
let unsubMesh: (() => void) | null = null
const canLive = computed(() => capture.usesCamera && capture.captureStrategy === 'multi-view')

// The 3D viewer shows the live-forming mesh during a live scan, otherwise the
// finished reconstruction.
const previewData = computed(() => (liveActive.value ? liveMeshData.value : capture.meshData))
const previewFormat = computed(() => (liveActive.value ? 'ply' : capture.meshFormat))
const previewHasResult = computed(() =>
  liveActive.value ? liveMeshData.value !== null : capture.result !== null,
)

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
const stageTabsEl = ref<HTMLElement | null>(null)

/** The Preview tab is unavailable until there is something to show. */
function tabDisabled(id: 'camera' | 'live' | 'preview'): boolean {
  return id === 'preview' && !capture.result && !liveActive.value
}

// Arrow-key roving focus across the tablist, as ARIA tabs expect: Left/Right
// move between enabled tabs (wrapping), Home/End jump to the ends, and focus
// follows selection. Only the active tab is in the tab order (roving tabindex).
function onTabsKeydown(event: KeyboardEvent): void {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const enabled = STAGE_TABS.filter((tab) => !tabDisabled(tab.id))
  if (enabled.length === 0) return
  const current = Math.max(
    0,
    enabled.findIndex((tab) => tab.id === stageView.value),
  )
  const last = enabled.length - 1
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowRight'
          ? (current + 1) % enabled.length
          : (current - 1 + enabled.length) % enabled.length
  const target = enabled[next]
  if (!target) return
  stageView.value = target.id
  stageTabsEl.value?.querySelector<HTMLButtonElement>(`#stage-tab-${target.id}`)?.focus()
}

// Restart the engine from the primary surface when it has failed, without
// digging into Diagnostics. The status stream flips the alert away on recovery.
const restartingEngine = ref(false)
async function onRestartEngine(): Promise<void> {
  if (restartingEngine.value) return
  restartingEngine.value = true
  try {
    await engine.restart()
  } finally {
    restartingEngine.value = false
  }
}

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

// What this machine can do, combining the sidecar's reconstruction device with
// the renderer's WebGPU/WebGL2 tier. Feeds the advisor and, later, the default
// method choice.
const machineProfile = computed<MachineProfile>(() => ({
  torchDevice: toComputeDevice(engine.torchDevice),
  webgpu: capabilities.value.webgpu,
  webgl2: capabilities.value.webgl2,
}))

// Adapt the default method to the machine: DA3 where a GPU makes it pleasant,
// otherwise the faster walk-around. The store folds this into effectiveBackend
// unless the user has pinned a model in Advanced.
watch(machineProfile, (profile) => capture.setRecommendedBackend(recommendedDefault(profile)), {
  immediate: true,
})

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

onBeforeUnmount(() => {
  stopCaptureLoop()
  stopLive()
})

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
  // Return to the camera view: the old preview is being cleared and capture is
  // where the user needs to be looking.
  stageView.value = 'camera'
  await capture.beginScan()
  if (liveEnabled.value && canLive.value) startLive()
  captureTimer = setInterval(() => void grabFrame(), GRAB_INTERVAL_MS)
}

async function stopScan(): Promise<void> {
  stopCaptureLoop()
  stopLive()
  await capture.endScan()
}

function startLive(): void {
  const sessionId = capture.sessionId
  if (!sessionId) return
  liveActive.value = true
  liveMeshData.value = null
  liveFrameCount.value = 0
  // Watch it form: the 3D preview shows the growing mesh while capture runs in
  // the background (the camera keeps grabbing under v-show).
  stageView.value = 'preview'
  unsubMesh = window.api.sidecar.onMeshUpdate(
    (note) => void onMeshUpdate(note.meshPath, note.frameCount),
  )
  // Fire-and-forget: it resolves when the scan cancels it.
  void window.api.sidecar.liveReconstruct({ sessionId, color: capture.color })
}

async function onMeshUpdate(meshPath: string, frameCount: number): Promise<void> {
  try {
    liveMeshData.value = await window.api.readArtifact({ path: meshPath })
    liveFrameCount.value = frameCount
  } catch {
    // A versioned mesh file may already be gone; the next update will land.
  }
}

function stopLive(): void {
  if (unsubMesh) {
    unsubMesh()
    unsubMesh = null
  }
  if (liveActive.value) {
    void window.api.sidecar.cancelReconstruct()
    liveActive.value = false
  }
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
      // The scan can end while the PNG encodes; staging to a closed session
      // throws "unknown session". Re-check before handing the frame over.
      if (!capture.scanning) return
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

async function onReconstruct(): Promise<void> {
  // Clear the previous run's progress so the bar starts empty, not at 100%.
  engine.resetProgress()
  await capture.runReconstruction()
}

async function onRunSynthetic(): Promise<void> {
  // The synthetic pipeline test: no camera, just build a known mesh.
  capture.selectPreset('synthetic')
  await onReconstruct()
}

async function onImport(): Promise<void> {
  // Import prompts for a file, stages keyframes, and reconstructs. The result
  // watcher switches to the 3D preview when it lands; reset the bar so its
  // progress reads from empty.
  engine.resetProgress()
  await capture.importMedia()
}

async function onCancelReconstruct(): Promise<void> {
  await capture.cancelReconstruction()
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <BrandMark :size="26" />
        <span class="name">MONO<span class="name-accent">CLE</span></span>
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
        <div
          ref="stageTabsEl"
          class="stage-tabs"
          role="tablist"
          aria-label="Workspace view"
          @keydown="onTabsKeydown"
        >
          <button
            v-for="tab in STAGE_TABS"
            :id="`stage-tab-${tab.id}`"
            :key="tab.id"
            role="tab"
            :aria-selected="stageView === tab.id"
            :aria-controls="'stage-panel'"
            :tabindex="stageView === tab.id ? 0 : -1"
            :class="{ active: stageView === tab.id }"
            :disabled="tabDisabled(tab.id)"
            @click="stageView = tab.id"
          >
            <Icon :name="tab.icon" :size="15" />
            {{ tab.label }}
          </button>
        </div>
        <div
          id="stage-panel"
          class="stage-body"
          role="tabpanel"
          :aria-labelledby="`stage-tab-${stageView}`"
        >
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
            :data="previewData"
            :format="previewFormat"
            :has-result="previewHasResult"
          />
          <div v-if="liveActive" class="live-badge">
            <StatusIndicator state="busy" label="Live reconstructing" />
            Live
            <span class="numeric">{{ liveFrameCount }}</span>
            <span class="faint">frames</span>
          </div>
        </div>
      </div>

      <aside class="sidebar">
        <section class="group stack" aria-label="Workflow">
          <EngineAlert
            :status="engine.status"
            :message="engine.lastErrorMessage()"
            :restarting="restartingEngine"
            @restart="onRestartEngine"
          />
          <WorkflowStepper :steps="workflowSteps" />
          <ScanPresetPicker
            :selected="capture.presetId"
            :color="capture.color"
            :output="capture.effectiveOutput"
            :supports-rich-output="capture.supportsRichOutput"
            :checkpoint="capture.effectiveCheckpoint"
            :locked="capture.scanning"
            @select="capture.selectPreset"
            @color-override="capture.setColorOverride"
            @output="capture.setOutput"
          />
          <AdvancedControls
            :backends="engine.backends"
            :effective-backend="capture.effectiveBackend"
            :default-backend="capture.defaultBackend"
            :preset-quality="capture.activePreset.quality"
            :quality="capture.quality"
            :checkpoint="capture.effectiveCheckpoint"
            :uses-checkpoint="capture.usesCheckpoint"
            :device="capture.device"
            :profile="machineProfile"
            :has-overrides="capture.hasOverrides"
            :locked="capture.scanning"
            @backend-override="capture.setBackendOverride"
            @quality-override="capture.setQualityOverride"
            @checkpoint-override="capture.setCheckpointOverride"
            @device="capture.setDevice"
            @reset-overrides="capture.resetOverrides"
            @run-synthetic="onRunSynthetic"
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
            :can-live="canLive"
            :live-enabled="liveEnabled"
            @toggle="toggleScan"
            @capture="onManualCapture"
            @update:live-enabled="liveEnabled = $event"
          />
          <ImportMedia
            :importing="capture.importing"
            :reconstructing="capture.reconstructing"
            :ready="engine.status === 'ready'"
            @import="onImport"
            @cancel="onCancelReconstruct"
          />
          <MachineAdvisor :profile="machineProfile" />
          <ReconstructPanel
            :status="engine.status"
            :progress="engine.progress"
            :reconstructing="capture.reconstructing"
            :can-reconstruct="canReconstruct"
            :result="capture.result"
            :error="capture.reconstructError"
            :saved-path="capture.savedPath"
            :preset-label="capture.activePreset.label"
            @reconstruct="onReconstruct"
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
  font-size: var(--text-md);
  letter-spacing: var(--tracking-wide);
  color: var(--ink-hi);
}
.name-accent {
  color: var(--accent);
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

.live-badge {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--r-full);
  background: color-mix(in srgb, var(--surface-0) 82%, transparent);
  border: var(--stroke-1) solid var(--accent);
  color: var(--ink-hi);
  font-size: var(--text-xs);
  box-shadow: var(--elevation-2);
  pointer-events: none;
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
