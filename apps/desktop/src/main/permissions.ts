import { session, systemPreferences } from 'electron'

/**
 * Allow the renderer to request the camera only, and deny everything else,
 * including the microphone. Called once at startup before any window loads.
 */
export function installPermissionHandler(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission !== 'media') {
        callback(false)
        return
      }
      // details.mediaTypes lists the requested kinds; allow video, refuse if audio
      // is requested alongside it.
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? ['video']
      callback(mediaTypes.every((kind) => kind === 'video'))
    },
  )
}

/**
 * Drive the native camera permission prompt on macOS. On other platforms the
 * browser-level getUserMedia prompt is sufficient, so this reports granted.
 */
export async function requestCameraAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('camera')
  if (status === 'granted') return true
  return systemPreferences.askForMediaAccess('camera')
}
