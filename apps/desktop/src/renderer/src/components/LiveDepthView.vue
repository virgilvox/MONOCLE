<script setup lang="ts">
/**
 * Live depth preview.
 *
 * Renders the camera feed as a displaced point cloud driven by the depth model.
 * The geometry is a static grid of points built once; per frame we only update
 * two textures (depth and color) and their needsUpdate flags. A vertex shader
 * reads the depth texture to push each point along Z, and the fragment shader
 * paints it with the camera color at the same uv.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLiveDepth, type DepthQuality } from '@renderer/composables/useLiveDepth'
import {
  DEFAULT_LIVE_DEPTH_MODEL,
  LIVE_DEPTH_MODELS,
  type LiveDepthModel,
} from '@renderer/lib/liveDepthModel'
import { viewport as vp } from '../styles/theme'

const props = defineProps<{
  stream: MediaStream | null
  active: boolean
  quality: DepthQuality
}>()

// Point grid density. Fixed and independent of quality so the geometry is never
// rebuilt; the shader samples the depth texture by uv regardless of its size.
const GRID = 192
const Z_SCALE = 1.2
const POINT_SIZE = 4.0

const container = ref<HTMLDivElement | null>(null)
const contextLost = ref(false)

// Which single-image depth model drives the preview. Local to the live view:
// DA2 (default, fp16 on WebGPU) or DA3 (fp32, opt-in). Switching rebuilds the
// worker session, so it is a deliberate toggle rather than a per-frame setting.
const depthModel = ref<LiveDepthModel>(DEFAULT_LIVE_DEPTH_MODEL)

const { status, errorMessage, revision, depthData, depthSize, colorData, colorSize } = useLiveDepth(
  {
    stream: () => props.stream,
    active: () => props.active,
    quality: () => props.quality,
    model: () => depthModel.value,
  },
)

const overlay = computed(() => {
  if (status.value === 'missing-model') return errorMessage.value
  if (status.value === 'error') return errorMessage.value ?? 'Live depth failed to start'
  if (status.value === 'loading') return 'Loading depth model...'
  return null
})

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let points: THREE.Points | null = null
let material: THREE.ShaderMaterial | null = null
let depthTexture: THREE.DataTexture | null = null
let colorTexture: THREE.DataTexture | null = null
let observer: ResizeObserver | null = null
let frameHandle = 0
let lastRevision = -1

const vertexShader = /* glsl */ `
  uniform sampler2D depthMap;
  uniform float zScale;
  uniform float pointSize;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float d = texture2D(depthMap, uv).r;
    vec3 displaced = vec3(position.x, position.y, (d - 0.5) * zScale);
    vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = pointSize * (2.0 / max(-mvPosition.z, 0.05));
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D colorMap;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(colorMap, vUv).rgb, 1.0);
  }
`

onMounted(() => {
  const el = container.value
  if (!el) return

  scene = new THREE.Scene()
  scene.background = new THREE.Color(vp.background)

  camera = new THREE.PerspectiveCamera(50, aspectOf(el), 0.01, 100)
  camera.position.set(0, 0, 2.4)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(el.clientWidth, el.clientHeight)
  el.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

  buildTextures()
  buildGrid()

  observer = new ResizeObserver(onResize)
  observer.observe(el)

  ensureRenderLoop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameHandle)
  frameHandle = 0
  observer?.disconnect()
  disposeScene()
  controls?.dispose()
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    renderer.dispose()
    renderer.domElement.remove()
  }
  renderer = scene = camera = controls = null
})

// Only render while the Live tab is showing: the component stays mounted under
// v-show, so an ungated loop would drive the GPU continuously in the background.
watch(
  () => props.active,
  () => ensureRenderLoop(),
)

function ensureRenderLoop(): void {
  if (frameHandle === 0 && props.active && !contextLost.value) {
    frameHandle = requestAnimationFrame(animate)
  }
}

function onContextLost(event: Event): void {
  event.preventDefault()
  contextLost.value = true
  cancelAnimationFrame(frameHandle)
  frameHandle = 0
}

function onContextRestored(): void {
  // The GL resources are gone; rebuild the textures, material, and point grid,
  // then resume, mirroring MeshViewer's recovery.
  disposeScene()
  buildTextures()
  buildGrid()
  contextLost.value = false
  ensureRenderLoop()
}

// The depth texture is sized to the model output, which changes with quality.
// The grid stays put; only the texture is rebuilt.
watch(depthSize, () => {
  if (!material) return
  buildDepthTexture()
  material.uniforms.depthMap!.value = depthTexture
})

function buildTextures(): void {
  buildDepthTexture()

  colorTexture = new THREE.DataTexture(
    colorData,
    colorSize,
    colorSize,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  colorTexture.minFilter = THREE.LinearFilter
  colorTexture.magFilter = THREE.LinearFilter
  colorTexture.colorSpace = THREE.SRGBColorSpace
  colorTexture.needsUpdate = true
}

function buildDepthTexture(): void {
  depthTexture?.dispose()
  const size = depthSize.value
  depthTexture = new THREE.DataTexture(
    depthData.value,
    size,
    size,
    THREE.RedFormat,
    THREE.FloatType,
  )
  // Nearest filtering avoids depending on OES_texture_float_linear for the
  // float depth map, which vertex texture fetch cannot assume.
  depthTexture.minFilter = THREE.NearestFilter
  depthTexture.magFilter = THREE.NearestFilter
  depthTexture.needsUpdate = true
}

function buildGrid(): void {
  if (!scene) return
  const count = GRID * GRID
  const positions = new Float32Array(count * 3)
  const uvs = new Float32Array(count * 2)

  let v = 0
  let u = 0
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const fx = x / (GRID - 1)
      const fy = y / (GRID - 1)
      // Row 0 is the top of the image, so map it to the top of the plane.
      positions[v] = fx * 2 - 1
      positions[v + 1] = 1 - fy * 2
      positions[v + 2] = 0
      uvs[u] = fx
      uvs[u + 1] = fy
      v += 3
      u += 2
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))

  material = new THREE.ShaderMaterial({
    uniforms: {
      depthMap: { value: depthTexture },
      colorMap: { value: colorTexture },
      zScale: { value: Z_SCALE },
      pointSize: { value: POINT_SIZE * window.devicePixelRatio },
    },
    vertexShader,
    fragmentShader,
  })

  points = new THREE.Points(geometry, material)
  scene.add(points)
}

function animate(): void {
  // Stop the loop when hidden or after a context loss; ensureRenderLoop resumes.
  if (!props.active || contextLost.value) {
    frameHandle = 0
    return
  }
  frameHandle = requestAnimationFrame(animate)
  if (revision.value !== lastRevision) {
    lastRevision = revision.value
    if (depthTexture) depthTexture.needsUpdate = true
    if (colorTexture) colorTexture.needsUpdate = true
  }
  controls?.update()
  if (renderer && scene && camera) renderer.render(scene, camera)
}

function onResize(): void {
  const el = container.value
  if (!el || !renderer || !camera) return
  camera.aspect = aspectOf(el)
  camera.updateProjectionMatrix()
  renderer.setSize(el.clientWidth, el.clientHeight)
}

function aspectOf(el: HTMLElement): number {
  return el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1
}

function disposeScene(): void {
  if (points) {
    scene?.remove(points)
    points.geometry.dispose()
  }
  material?.dispose()
  depthTexture?.dispose()
  colorTexture?.dispose()
  points = material = depthTexture = colorTexture = null
}
</script>

<template>
  <div ref="container" class="live-depth">
    <div class="vignette" aria-hidden="true"></div>
    <div class="brackets" aria-hidden="true">
      <span class="corner tl"></span>
      <span class="corner tr"></span>
      <span class="corner bl"></span>
      <span class="corner br"></span>
    </div>
    <div class="model-picker" role="radiogroup" aria-label="Live depth model">
      <button
        v-for="model in LIVE_DEPTH_MODELS"
        :key="model.id"
        type="button"
        role="radio"
        :aria-checked="depthModel === model.id"
        :class="{ active: depthModel === model.id }"
        @click="depthModel = model.id"
      >
        {{ model.label }}
      </button>
    </div>
    <div v-if="overlay" class="live-depth__overlay">{{ overlay }}</div>
  </div>
</template>

<style scoped>
.live-depth {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-lg);
  background: var(--viewport);
}

.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    120% 120% at 50% 50%,
    transparent 58%,
    color-mix(in srgb, var(--viewport) 72%, transparent) 100%
  );
}

.brackets {
  position: absolute;
  inset: var(--space-3);
  pointer-events: none;
}
.corner {
  position: absolute;
  width: 20px;
  height: 20px;
  border: var(--stroke-2) solid color-mix(in srgb, var(--accent) 55%, transparent);
}
.corner.tl {
  top: 0;
  left: 0;
  border-right: none;
  border-bottom: none;
}
.corner.tr {
  top: 0;
  right: 0;
  border-left: none;
  border-bottom: none;
}
.corner.bl {
  bottom: 0;
  left: 0;
  border-right: none;
  border-top: none;
}
.corner.br {
  bottom: 0;
  right: 0;
  border-left: none;
  border-top: none;
}

.model-picker {
  position: absolute;
  top: var(--space-3);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: var(--stroke-1);
  padding: var(--stroke-1);
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--surface-0) 72%, transparent);
  backdrop-filter: blur(6px);
}
.model-picker button {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--ink-lo);
  font-size: var(--text-xs);
  cursor: pointer;
}
.model-picker button:hover {
  color: var(--ink);
}
.model-picker button.active {
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.live-depth__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  text-align: center;
  color: var(--ink);
  background: color-mix(in srgb, var(--surface-0) 72%, transparent);
  font-size: var(--text-sm);
}
</style>
