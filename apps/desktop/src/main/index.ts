import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol } from 'electron'
import { registerIpc } from './ipc'
import { installPermissionHandler } from './permissions'
import { resolvePython } from './python'
import type { SessionManager } from './session'
import { SidecarSupervisor } from './sidecar'
import { APP_SCHEME, applyContentSecurityPolicy, createMainWindow } from './window'

// Register the app:// scheme as a standard, secure, fetch-capable origin. This
// must run before the app is ready. In a packaged build the renderer is served
// from app:// so the live-depth worker's absolute fetches (/models/...) and ort
// wasm paths resolve against the renderer root; file:// cannot fetch and has no
// usable origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// In a packaged build the sidecar and the bundled interpreter are copied into
// Resources; in dev they live under the repo. The bundled interpreter, when
// present, lets a shipped build reconstruct without any local Python setup.
const sidecarDir = app.isPackaged
  ? join(process.resourcesPath, 'sidecar')
  : join(app.getAppPath(), '..', '..', 'sidecar')
const bundledDir = app.isPackaged
  ? join(process.resourcesPath, 'python')
  : join(app.getAppPath(), 'resources', 'python')

const python = resolvePython({ sidecarDir, bundledDir, isPackaged: app.isPackaged })

// Point the sidecar at the bundled Depth Anything V2 ONNX when present, so it
// never reaches out to Hugging Face at scan time. When absent (a dev tree that
// has not run bundle:python) the sidecar falls back to its own HF download, which
// on a dev box hits the existing cache.
const modelsDir = app.isPackaged
  ? join(process.resourcesPath, 'models')
  : join(app.getAppPath(), 'resources', 'models')
const da2Model = join(modelsDir, 'depth-anything-v2-small.onnx')
const da3Ckpt = join(modelsDir, 'da3-base')
const sidecarEnv: NodeJS.ProcessEnv = {}
if (existsSync(da2Model)) sidecarEnv.MONOCLE_DA2_ONNX = da2Model
// The DA3 multi-view checkpoint is a directory (config.json + model.safetensors)
// that from_pretrained loads locally; only wire it when actually bundled.
if (existsSync(join(da3Ckpt, 'model.safetensors'))) sidecarEnv.MONOCLE_DA3_CKPT = da3Ckpt

const supervisor = new SidecarSupervisor(sidecarDir, python.path, sidecarEnv)
let sessions: SessionManager | null = null

app.whenReady().then(() => {
  registerAppProtocol()
  installPermissionHandler()
  applyContentSecurityPolicy()
  sessions = registerIpc(supervisor)
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// Serve the packaged renderer over app:// from the out/renderer directory, so
// the renderer has a real secure origin and absolute-path fetches work.
function registerAppProtocol(): void {
  const rendererRoot = resolve(join(__dirname, '../renderer'))
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname)
    const filePath = resolve(join(rendererRoot, requested))
    // Contain every request under the renderer root: a crafted app:// URL with
    // ../ segments must not escape to read arbitrary local files.
    const rel = relative(rendererRoot, filePath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return new Response(null, { status: 404 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never orphan the sidecar (it can hold a multi-gigabyte model in memory) and
// never leave capture temp dirs behind.
app.on('will-quit', () => {
  void supervisor.stop()
  sessions?.cleanupAll()
})
