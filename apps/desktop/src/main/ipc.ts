import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  Channel,
  type ExportArtifactRequest,
  type ReconstructRequest,
  type SaveFileRequest,
} from '../shared/ipc'
import { requestCameraAccess } from './permissions'
import type { SidecarSupervisor } from './sidecar'

/** Register every IPC handler and wire supervisor events out to the renderer. */
export function registerIpc(supervisor: SidecarSupervisor): void {
  ipcMain.handle(Channel.AppInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }))

  ipcMain.handle(Channel.CameraAccess, () => requestCameraAccess())

  ipcMain.handle(Channel.SidecarStatus, () => supervisor.getStatus())
  ipcMain.handle(Channel.SidecarStart, () => supervisor.start())
  ipcMain.handle(Channel.SidecarStop, () => supervisor.stop())
  ipcMain.handle(Channel.SidecarListBackends, () => supervisor.listBackends())

  ipcMain.handle(Channel.SidecarReconstruct, async (_event, request: ReconstructRequest) => {
    // The renderer never handles filesystem paths; main allocates a session.
    const sessionDir = await mkdtemp(join(tmpdir(), 'monocle-scan-'))
    const framesDir = join(sessionDir, 'frames')
    const outputDir = join(sessionDir, 'output')
    await mkdir(framesDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })
    return supervisor.reconstruct({ framesDir, backend: request.backend, outputDir })
  })

  ipcMain.handle(Channel.SaveFile, async (_event, request: SaveFileRequest) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: request.defaultName,
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, request.data)
    return filePath
  })

  ipcMain.handle(Channel.ExportArtifact, async (_event, request: ExportArtifactRequest) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: request.defaultName,
    })
    if (canceled || !filePath) return null
    await copyFile(request.sourcePath, filePath)
    return filePath
  })

  supervisor.on('status', (status) => broadcast(Channel.EventSidecarStatus, status))
  supervisor.on('progress', (note) => broadcast(Channel.EventSidecarProgress, note))
  supervisor.on('log', (note) => broadcast(Channel.EventSidecarLog, note))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}
