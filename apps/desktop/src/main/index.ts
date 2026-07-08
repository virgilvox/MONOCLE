import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol } from 'electron'
import { registerIpc } from './ipc'
import { installPermissionHandler } from './permissions'
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

// In a packaged build the sidecar is copied into Resources; in dev it lives at
// the repo root next to the apps and packages directories.
const sidecarDir = app.isPackaged
  ? join(process.resourcesPath, 'sidecar')
  : join(app.getAppPath(), '..', '..', 'sidecar')

const supervisor = new SidecarSupervisor(sidecarDir)
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
  const rendererRoot = join(__dirname, '../renderer')
  protocol.handle(APP_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    const relative = pathname === '/' ? '/index.html' : pathname
    const filePath = join(rendererRoot, decodeURIComponent(relative))
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
