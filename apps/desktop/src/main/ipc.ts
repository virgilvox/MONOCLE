import { copyFile, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  Channel,
  type ExportArtifactRequest,
  type ReadArtifactRequest,
  type ReconstructRequest,
  type SaveFileRequest,
  type StageFrameRequest,
} from '../shared/ipc'
import { requestCameraAccess } from './permissions'
import { SessionManager } from './session'
import type { SidecarSupervisor } from './sidecar'

/**
 * Resolve `path` to a real path and refuse anything outside the OS temp
 * directory. Both the read and export handlers run untrusted renderer-supplied
 * paths through this so neither can touch arbitrary files on disk. Returns the
 * canonical path to operate on.
 */
async function assertUnderTmp(path: string): Promise<string> {
  const real = await realpath(path)
  const base = await realpath(tmpdir())
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error('refused to access a file outside the temp directory')
  }
  return real
}

/**
 * Register every IPC handler and wire supervisor events out to the renderer.
 * Returns the SessionManager so the caller can clean up temp dirs on quit.
 */
export function registerIpc(supervisor: SidecarSupervisor): SessionManager {
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
    return supervisor.reconstruct({
      framesDir,
      backend: request.backend,
      outputDir,
      quality: request.quality,
      color: request.color,
    })
  })

  ipcMain.handle(Channel.SidecarCancel, () => supervisor.cancelReconstruct())

  ipcMain.handle(Channel.SaveFile, async (_event, request: SaveFileRequest) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: request.defaultName,
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, request.data)
    return filePath
  })

  ipcMain.handle(Channel.ExportArtifact, async (_event, request: ExportArtifactRequest) => {
    // Guard the source path the same way ReadArtifact does: the renderer must
    // not be able to copy arbitrary files off disk to a user-chosen location.
    const source = await assertUnderTmp(request.sourcePath)
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: request.defaultName,
    })
    if (canceled || !filePath) return null
    await copyFile(source, filePath)
    return filePath
  })

  ipcMain.handle(Channel.ReadArtifact, async (_event, request: ReadArtifactRequest) => {
    // Only sidecar output under the temp directory is readable, so the renderer
    // cannot use this to read arbitrary files on disk.
    const real = await assertUnderTmp(request.path)
    return readFile(real)
  })

  ipcMain.handle(Channel.Reveal, (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  supervisor.on('status', (status) => broadcast(Channel.EventSidecarStatus, status))
  supervisor.on('progress', (note) => broadcast(Channel.EventSidecarProgress, note))
  supervisor.on('log', (note) => broadcast(Channel.EventSidecarLog, note))

  return sessions
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}
