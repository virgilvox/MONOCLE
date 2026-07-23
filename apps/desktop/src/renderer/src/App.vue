<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
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
import MeshViewer from './components/MeshViewer.vue'
import ReconstructPanel from './components/ReconstructPanel.vue'
import ScanPresetPicker from './components/ScanPresetPicker.vue'
import StatusBar from './components/StatusBar.vue'
import StatusIndicator from './components/StatusIndicator.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import WorkflowStepper from './components/WorkflowStepper.vue'
import { useCamera } from './composables/useCamera'
import { useCaptureLoop } from './composables/useCaptureLoop'
import { useEngineHealth } from './composables/useEngineHealth'
import { useLiveReconstruction } from './composables/useLiveReconstruction'
import { useMachineProfile } from './composables/useMachineProfile'
import { STAGE_TABS, useStageTabs } from './composables/useStageTabs'
import { useWorkflowSteps } from './composables/useWorkflowSteps'
import { useCaptureStore } from './stores/capture'
import { useDa3Store } from './stores/da3'
import { useEngineStore } from './stores/engine'
import type { AppInfo } from '../../shared/ipc'

const camera = useCamera()
const capture = useCaptureStore()
const da3 = useDa3Store()
const engine = useEngineStore()

const cameraView = ref<InstanceType<typeof CameraView> | null>(null)
const appInfo = ref<AppInfo | null>(null)

// Live reconstruction and the stage tabs come first: the tabs need liveActive
// to know when the 3D Preview unlocks mid-scan.
const {
  liveEnabled,
  liveActive,
  liveFrameCount,
  canLive,
  previewData,
  previewFormat,
  previewHasResult,
  previewOutput,
  startLive,
  stopLive,
} = useLiveReconstruction()
const { stageView, stageTabsEl, selectTab, tabDisabled, onTabsKeydown } = useStageTabs(liveActive)

const { gateReason, gateSharpness, resetGate, startLoop, stopLoop, grabFrame } = useCaptureLoop({
  grab: async () => (await cameraView.value?.grab()) ?? null,
  onSingleFrameDone: stopScan,
})

const {
  engineLabel,
  engineState,
  restarting: restartingEngine,
  restart: onRestartEngine,
} = useEngineHealth()

const { workflowSteps } = useWorkflowSteps(camera.active)
const { capabilities, detect, machineProfile } = useMachineProfile()

const canReconstruct = computed(
  () =>
    engine.status === 'ready' &&
    !capture.reconstructing &&
    (capture.captureStrategy === 'synthetic' || capture.frameCount > 0),
)

onMounted(async () => {
  appInfo.value = await window.api.getAppInfo()
  engine.bind()
  void engine.start()
  // refresh() catches its own failure and lands it in the pack panel's error
  // line, so the fire-and-forget cannot become an unhandled rejection.
  void da3.refresh()
  await detect()
  await camera.listDevices()
})

onBeforeUnmount(() => {
  stopLoop()
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
  resetGate()
  // Return to the camera view: the old preview is being cleared and capture is
  // where the user needs to be looking.
  stageView.value = 'camera'
  await capture.beginScan()
  if (liveEnabled.value && canLive.value) {
    startLive()
    // Watch it form: the 3D preview shows the growing mesh while capture runs
    // in the background (the camera keeps grabbing under v-show).
    if (liveActive.value) stageView.value = 'preview'
  }
  startLoop()
}

async function stopScan(): Promise<void> {
  stopLoop()
  stopLive()
  await capture.endScan()
}

async function onManualCapture(): Promise<void> {
  await grabFrame(true)
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
            @click="selectTab(tab.id)"
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
            :output="previewOutput"
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
          <UpdateBanner />
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
            :backend-override="capture.backendOverride"
            :recommended-backend="capture.recommendedBackend"
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
          <MachineAdvisor :profile="machineProfile" :effective-backend="capture.effectiveBackend" />
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
