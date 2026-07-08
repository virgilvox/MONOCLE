import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpc } from './ipc'
import { installPermissionHandler } from './permissions'
import type { SessionManager } from './session'
import { SidecarSupervisor } from './sidecar'
import { applyContentSecurityPolicy, createMainWindow } from './window'

// In a packaged build the sidecar is copied into Resources; in dev it lives at
// the repo root next to the apps and packages directories.
const sidecarDir = app.isPackaged
  ? join(process.resourcesPath, 'sidecar')
  : join(app.getAppPath(), '..', '..', 'sidecar')

const supervisor = new SidecarSupervisor(sidecarDir)
let sessions: SessionManager | null = null

app.whenReady().then(() => {
  installPermissionHandler()
  applyContentSecurityPolicy()
  sessions = registerIpc(supervisor)
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Never orphan the sidecar (it can hold a multi-gigabyte model in memory) and
// never leave capture temp dirs behind.
app.on('will-quit', () => {
  void supervisor.stop()
  sessions?.cleanupAll()
})
