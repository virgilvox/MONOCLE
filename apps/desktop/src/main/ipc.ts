import { randomUUID } from 'node:crypto'
import { copyFile, cp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  Channel,
  type ChosenMedia,
  type ExportArtifactRequest,
  type ImportMediaRequest,
  type ImportMediaResult,
  type LiveReconstructRequest,
  type ReadArtifactRequest,
  type ReconstructRequest,
  type SaveFileRequest,
  type StageFrameRequest,
} from '../shared/ipc'
import { assertUnderTmp } from './paths'
import { requestCameraAccess } from './permissions'
import { SessionManager } from './session'
import type { SidecarSupervisor } from './sidecar'

/**
 * Register every IPC handler and wire supervisor events out to the renderer.
 * Returns the SessionManager so the caller can clean up temp dirs on quit.
 */
export function registerIpc(supervisor: SidecarSupervisor): SessionManager {
  const sessions = new SessionManager()
  // Maps an opaque token to a dialog-approved media path. The renderer only ever
  // sees the token, so it cannot ask the sidecar to read an arbitrary file.
  const approvedMedia = new Map<string, string>()

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
  ipcMain.handle(Channel.SidecarDevice, () => supervisor.getDevice())

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
      // The session id is a temp-dir path; reject anything outside temp so a
      // hostile renderer cannot point reconstruction at arbitrary directories.
      await assertUnderTmp(request.sessionId)
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
      checkpoint: request.checkpoint,
      device: request.device,
      output: request.output,
    })
  })

  ipcMain.handle(Channel.ChooseMedia, async (): Promise<ChosenMedia | null> => {
    // One picker for both a video file and an image folder. macOS allows the two
    // properties together; elsewhere the user picks a file. The kind is decided
    // from the chosen path, not the dialog, so it is always correct.
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a video or image folder',
      properties: ['openFile', 'openDirectory'],
      filters: [
        {
          name: 'Video or images',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'png', 'jpg', 'jpeg', 'webp', 'bmp'],
        },
      ],
    })
    const chosen = canceled ? undefined : filePaths[0]
    if (!chosen) return null
    const path = await realpath(chosen)
    const info = await stat(path)
    // Hand back a token, not the path; main keeps the real path so prepareMedia
    // can only ever read a location the user actually picked in the dialog.
    const token = randomUUID()
    approvedMedia.set(token, path)
    return { token, kind: info.isDirectory() ? 'folder' : 'video' }
  })

  ipcMain.handle(
    Channel.SidecarPrepareMedia,
    async (_event, request: ImportMediaRequest): Promise<ImportMediaResult> => {
      const source = approvedMedia.get(request.token)
      if (!source) throw new Error('media selection expired; choose the file again')
      // Imported media gets its own session directory, so its staged keyframes
      // reconstruct through the exact same path as a live capture.
      const session = await sessions.createSession()
      const { frameCount } = await supervisor.prepareMedia({
        source,
        framesDir: session.framesDir,
        maxFrames: request.maxFrames,
      })
      return { sessionId: session.sessionId, frameCount }
    },
  )

  ipcMain.handle(
    Channel.SidecarLiveReconstruct,
    async (_event, request: LiveReconstructRequest) => {
      // Live reconstruction always runs against a real capture session's frames.
      await assertUnderTmp(request.sessionId)
      const { framesDir, outputDir } = sessions.resolve(request.sessionId)
      await supervisor.liveReconstruct({ framesDir, outputDir, color: request.color })
    },
  )

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
    // The COLMAP output is a directory, not a file; copy it recursively. Every
    // other artifact is a single file.
    const info = await stat(source)
    if (info.isDirectory()) {
      await cp(source, filePath, { recursive: true })
    } else {
      await copyFile(source, filePath)
    }
    return filePath
  })

  ipcMain.handle(Channel.ReadArtifact, async (_event, request: ReadArtifactRequest) => {
    // Only sidecar output under the temp directory is readable, so the renderer
    // cannot use this to read arbitrary files on disk.
    const real = await assertUnderTmp(request.path)
    return readFile(real)
  })

  ipcMain.handle(Channel.Reveal, async (_event, path: string) => {
    // Reveal targets a user-chosen saved file, which lives outside temp, so it
    // is not temp-restricted. Require an existing absolute path so a hostile
    // renderer cannot probe the filesystem with relative or bogus input.
    if (!isAbsolute(path)) return
    await stat(path)
    shell.showItemInFolder(path)
  })

  supervisor.on('status', (status) => broadcast(Channel.EventSidecarStatus, status))
  supervisor.on('progress', (note) => broadcast(Channel.EventSidecarProgress, note))
  supervisor.on('log', (note) => broadcast(Channel.EventSidecarLog, note))
  supervisor.on('meshUpdate', (note) => broadcast(Channel.EventSidecarMeshUpdate, note))

  return sessions
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}
