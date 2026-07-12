<script setup lang="ts">
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ViewerToolbar, { type ViewerBackground, type ViewMode } from './ViewerToolbar.vue'
import { viewport as vp } from '../styles/theme'
import type { MeshFormat } from '../stores/capture'

const props = defineProps<{
  data: Uint8Array | null
  format: MeshFormat
  /** True when a reconstruction exists even if its bytes could not load. */
  hasResult: boolean
}>()

const container = ref<HTMLDivElement | null>(null)
const mode = ref<ViewMode>('shaded')
const pointSize = ref(3)
const background = ref<ViewerBackground>('dark')
const contextLost = ref(false)

const SIZE_UNIT = 0.0012
const BG_COLORS: Record<ViewerBackground, number> = {
  dark: vp.background,
  light: vp.backgroundLight,
}

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let grid: THREE.GridHelper | null = null
let ground: THREE.Mesh | null = null
let root: THREE.Group | null = null
let meshContent: THREE.Object3D | null = null
let pointsContent: THREE.Points | null = null
let frameHandle = 0
let observer: ResizeObserver | null = null

onMounted(() => {
  const el = container.value
  if (!el) return
  initScene(el)
  load()
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameHandle)
  observer?.disconnect()
  observer = null
  teardownScene()
})

watch(
  () => props.data,
  () => load(),
)
watch(mode, applyMode)
watch(pointSize, applyPointSize)
watch(background, applyBackground)

function initScene(el: HTMLElement): void {
  scene = new THREE.Scene()

  camera = new THREE.PerspectiveCamera(50, aspectOf(el), 0.001, 100)
  camera.position.set(0.15, 0.12, 0.25)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.setSize(el.clientWidth, el.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  el.appendChild(renderer.domElement)
  renderer.domElement.addEventListener('webglcontextlost', onContextLost)
  renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(1, 1.6, 1)
  const fill = new THREE.DirectionalLight(0x9aa4ad, 0.7)
  fill.position.set(-1, -0.4, -0.8)
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.45))

  // A recessed ground plane under a measured grid, so the subject sits on a
  // surface rather than floating in a void.
  ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 64),
    new THREE.MeshBasicMaterial({
      color: vp.ground,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.001
  scene.add(ground)

  grid = new THREE.GridHelper(0.4, 8, vp.gridMajor, vp.gridMinor)
  scene.add(grid)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true

  if (!observer) {
    observer = new ResizeObserver(onResize)
    observer.observe(el)
  }
  applyBackground()
}

function teardownScene(): void {
  disposeContent()
  controls?.dispose()
  if (renderer) {
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
    renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
    renderer.dispose()
    renderer.domElement.remove()
  }
  if (ground) {
    ground.geometry.dispose()
    ;(ground.material as THREE.Material).dispose()
  }
  renderer = scene = camera = controls = grid = ground = root = null
}

function aspectOf(el: HTMLElement): number {
  return el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1
}

function animate(): void {
  frameHandle = requestAnimationFrame(animate)
  if (contextLost.value) return
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

function onContextLost(event: Event): void {
  // Keep the drawing buffer from being recreated until we rebuild deliberately.
  event.preventDefault()
  contextLost.value = true
  cancelAnimationFrame(frameHandle)
}

function onContextRestored(): void {
  const el = container.value
  if (!el) return
  // Rebuild the renderer and scene, then reload the current artifact.
  teardownScene()
  initScene(el)
  contextLost.value = false
  load()
  animate()
}

function load(): void {
  if (!scene || !camera || !controls) return
  disposeContent()
  if (!props.data) return

  const bytes = props.data
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer

  if (props.format === 'glb') {
    new GLTFLoader().parse(
      buffer,
      '',
      (gltf) => {
        meshContent = gltf.scene
        mount()
      },
      () => {
        meshContent = null
        pointsContent = null
      },
    )
    return
  }

  if (props.format === 'ply') {
    try {
      const geometry = new PLYLoader().parse(buffer)
      const hasFaces = geometry.index !== null && geometry.index.count > 0
      if (hasFaces) {
        geometry.computeVertexNormals()
        meshContent = new THREE.Mesh(geometry, meshMaterial())
      } else {
        // A pure point cloud has no shaded representation.
        meshContent = null
        pointsContent = new THREE.Points(geometry, pointsMaterial(geometry))
      }
      mount()
    } catch {
      // Corrupt or truncated artifact: fall through to the "could not load" state.
      meshContent = null
      pointsContent = null
    }
    return
  }

  try {
    const geometry = new STLLoader().parse(buffer)
    geometry.computeVertexNormals()
    meshContent = new THREE.Mesh(geometry, meshMaterial())
    mount()
  } catch {
    meshContent = null
    pointsContent = null
  }
}

/** Add the loaded representations to a fresh root, frame it, and apply the mode. */
function mount(): void {
  if (!scene) return
  root = new THREE.Group()
  if (meshContent) root.add(meshContent)
  if (pointsContent) root.add(pointsContent)
  frame(root)
  scene.add(root)
  applyMode()
  applyPointSize()
}

/**
 * Build the point cloud for a shaded artifact lazily, the first time the user
 * asks for Points. Sampling every vertex is costly on a high-detail mesh, so
 * doing it eagerly on load froze the viewport even for users who never leave
 * shaded mode. Once built it is cached on `root` for the rest of the session.
 */
function ensurePoints(): void {
  if (pointsContent || !meshContent || !root) return
  pointsContent = buildPoints(meshContent)
  root.add(pointsContent)
  applyPointSize()
}

/** Sample every mesh's vertices into a single Points cloud in root-local space. */
function buildPoints(object: THREE.Object3D): THREE.Points {
  object.updateMatrixWorld(true)
  // The points join `root`, which carries the centering offset frame() applied,
  // so express each vertex relative to root to avoid a double offset.
  const toRoot = new THREE.Matrix4()
  if (root) {
    root.updateMatrixWorld(true)
    toRoot.copy(root.matrixWorld).invert()
  }
  const positions: number[] = []
  const colors: number[] = []
  let anyColor = false
  const vertex = new THREE.Vector3()

  object.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return
    const colAttr = mesh.geometry.getAttribute('color')
    const material = mesh.material
    const base = new THREE.Color(vp.mesh)
    if (!Array.isArray(material) && (material as THREE.MeshStandardMaterial)?.color) {
      base.copy((material as THREE.MeshStandardMaterial).color)
    }
    for (let i = 0; i < pos.count; i += 1) {
      vertex.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(toRoot)
      positions.push(vertex.x, vertex.y, vertex.z)
      if (colAttr) {
        anyColor = true
        colors.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i))
      } else {
        colors.push(base.r, base.g, base.b)
      }
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    size: pointSize.value * SIZE_UNIT,
    vertexColors: true,
    color: anyColor ? 0xffffff : vp.points,
  })
  return new THREE.Points(geometry, material)
}

function applyMode(): void {
  if (mode.value === 'points') {
    ensurePoints()
    if (meshContent) meshContent.visible = false
    if (pointsContent) pointsContent.visible = true
  } else {
    const wireframe = mode.value === 'wireframe'
    if (meshContent) {
      meshContent.visible = true
      meshContent.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        const material = mesh.material
        const list = Array.isArray(material) ? material : [material]
        for (const m of list) {
          const line = m as THREE.MeshStandardMaterial
          if ('wireframe' in line) line.wireframe = wireframe
        }
      })
      if (pointsContent) pointsContent.visible = false
    } else if (pointsContent) {
      // Point-cloud-only artifact: always show the points.
      pointsContent.visible = true
    }
  }
}

function applyPointSize(): void {
  if (!pointsContent) return
  const material = pointsContent.material as THREE.PointsMaterial
  material.size = pointSize.value * SIZE_UNIT
}

function applyBackground(): void {
  if (!scene || !renderer) return
  scene.background = new THREE.Color(BG_COLORS[background.value])
  if (grid) grid.visible = background.value === 'dark'
  if (ground) ground.visible = background.value === 'dark'
}

function frame(object: THREE.Object3D): void {
  if (!camera || !controls) return
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  object.position.sub(center) // recenter on the origin and the grid

  const radius = Math.max(size.x, size.y, size.z, 0.02) * 0.5
  const distance = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.8
  camera.position.set(distance * 0.7, distance * 0.6, distance)
  camera.near = Math.max(distance / 200, 0.0001)
  camera.far = distance * 200
  camera.updateProjectionMatrix()
  controls.target.set(0, 0, 0)
  controls.update()
}

function resetView(): void {
  if (root) frame(root)
}

function meshMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color: vp.mesh,
    metalness: 0.1,
    roughness: 0.75,
    side: THREE.DoubleSide,
  })
}

function pointsMaterial(geometry: THREE.BufferGeometry): THREE.Material {
  const hasColor = geometry.getAttribute('color') !== undefined
  return new THREE.PointsMaterial({
    size: pointSize.value * SIZE_UNIT,
    vertexColors: hasColor,
    color: hasColor ? 0xffffff : vp.points,
  })
}

function disposeContent(): void {
  if (!scene || !root) return
  scene.remove(root)
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
  root = meshContent = pointsContent = null
}
</script>

<template>
  <div class="viewer">
    <ViewerToolbar
      v-show="data"
      :mode="mode"
      :point-size="pointSize"
      :background="background"
      @update:mode="mode = $event"
      @update:point-size="pointSize = $event"
      @update:background="background = $event"
      @reset="resetView"
    />
    <div class="stage">
      <div ref="container" class="canvas-host"></div>
      <div class="vignette" aria-hidden="true"></div>
      <div v-if="!data && !hasResult" class="overlay">
        <Icon name="wireframe" :size="30" class="overlay-glyph" />
        <p class="muted">No reconstruction yet</p>
        <p class="faint">Reconstruct a scan to preview the mesh here.</p>
      </div>
      <div v-else-if="!data && hasResult" class="overlay">
        <Icon name="alert" :size="26" class="overlay-glyph" />
        <p class="muted">Mesh reconstructed but preview could not load</p>
        <p class="faint">Save still works from the Reconstruct panel.</p>
      </div>
      <div v-else class="hint faint">Drag to orbit, scroll to zoom</div>
      <div v-if="contextLost" class="overlay">
        <Icon name="lens" :size="26" class="overlay-glyph" />
        <p class="muted">Rendering paused</p>
        <p class="faint">Restoring the graphics context.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  min-height: 360px;
}
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border: var(--stroke-1) solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--viewport);
}
.canvas-host {
  width: 100%;
  height: 100%;
}
.vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    120% 120% at 50% 45%,
    transparent 58%,
    color-mix(in srgb, var(--viewport) 70%, transparent) 100%
  );
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  text-align: center;
  pointer-events: none;
}
.overlay-glyph {
  color: var(--ink-lo);
  margin-bottom: var(--space-1);
}
.hint {
  position: absolute;
  bottom: var(--space-3);
  left: var(--space-3);
  font-size: var(--text-2xs);
  pointer-events: none;
}
</style>
