import { copyFile, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  Channel,
  type ExportArtifactRequest,
  type ReconstructRequest,
  type SaveFileRequest,
  type StageFrameRequest,
} from '../shared/ipc'
import { requestCameraAccess } from './permissions'
import { SessionManager } from './session'
import type { SidecarSupervisor } from './sidecar'

/** Register every IPC handler and wire supervisor events out to the renderer. */
export function registerIpc(supervisor: SidecarSupervisor): void {
  const sessions = new SessionManager()

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

  ipcMain.handle(Channel.SessionBegin, async () => {
    const session = await sessions.createSession()
    return session.sessionId
  })

  ipcMain.handle(Channel.SessionStageFrame, (_event, request: StageFrameRequest) =>
    sessions.stageFrame(request.sessionId, request.data),
  )

  ipcMain.handle(Channel.SessionEnd, (_event, sessionId: string) => sessions.endSession(sessionId))

  ipcMain.handle(Channel.SidecarReconstruct, async (_event, request: ReconstructRequest) => {
    // The renderer never handles filesystem paths; main resolves the session.
    // With a sessionId we reconstruct against its staged frames; otherwise we
    // allocate a fresh (empty) session directory as a fallback.
    let framesDir: string
    let outputDir: string
    if (request.sessionId) {
      ;({ framesDir, outputDir } = sessions.resolve(request.sessionId))
    } else {
      const session = await sessions.createSession()
      ;({ framesDir, outputDir } = session)
    }
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
