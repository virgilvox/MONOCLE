import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import {
  Channel,
  type UpdateAvailableInfo,
  type UpdateDownloadProgress,
  type UpdateDownloadedInfo,
} from '../shared/ipc'

// electron-updater ships as CommonJS; the default-import destructure is the
// interop-safe way to reach autoUpdater from a bundled main process.
const { autoUpdater } = electronUpdater

/**
 * Wire the in-app auto-updater. It is deliberately conservative:
 *
 * - It no-ops entirely in development (`app.isPackaged` is false). There is no
 *   app-update.yml in a dev tree, so electron-updater has nothing to read and
 *   would only throw.
 * - It never downloads or installs on its own. `autoDownload` is off, so a
 *   found update is announced to the renderer and waits for an explicit
 *   download request, then an explicit install request.
 * - It checks once at startup and forwards every state change to the renderer
 *   over IPC, mirroring how the sidecar supervisor's events are broadcast.
 *
 * The GitHub publish config in electron-builder.yml generates the app-update.yml
 * this reads at runtime, so nothing here needs a feed URL.
 */
export function registerUpdater(): void {
  if (!app.isPackaged) return

  // Announce, do not auto-install. The renderer drives download and install.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    const payload: UpdateAvailableInfo = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseName: info.releaseName,
    }
    broadcast(Channel.EventUpdateAvailable, payload)
  })

  autoUpdater.on('download-progress', (progress) => {
    const payload: UpdateDownloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    }
    broadcast(Channel.EventUpdateProgress, payload)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const payload: UpdateDownloadedInfo = { version: info.version }
    broadcast(Channel.EventUpdateDownloaded, payload)
  })

  autoUpdater.on('error', (error) => {
    broadcast(Channel.EventUpdateError, { message: errorMessage(error) })
  })

  ipcMain.handle(Channel.UpdateCheck, async () => {
    await autoUpdater.checkForUpdates()
  })
  ipcMain.handle(Channel.UpdateDownload, async () => {
    await autoUpdater.downloadUpdate()
  })
  ipcMain.handle(Channel.UpdateInstall, () => {
    // Relaunch into the freshly installed version. isSilent=false so the
    // platform installer UI (where it has one) still shows.
    autoUpdater.quitAndInstall(false, true)
  })

  // A single startup check. A rejected check should not crash the app; surface
  // it to the renderer the same way a mid-flight error would arrive.
  autoUpdater.checkForUpdates().catch((error) => {
    broadcast(Channel.EventUpdateError, { message: errorMessage(error) })
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}
