import { join } from 'node:path'
import { BrowserWindow, session, shell } from 'electron'

/** Custom scheme the packaged renderer is served from (see main/index.ts). */
export const APP_SCHEME = 'app'
const APP_URL = `${APP_SCHEME}://bundle/index.html`

/** Create the main window with the locked-down defaults the app relies on. */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'MONOCLE',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  const devServer = process.env.ELECTRON_RENDERER_URL

  // Open external links in the system browser, but only safe schemes, and never
  // in-app. A hostile renderer must not be able to open file:// or a custom
  // scheme handler.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block top-level navigation away from the app. Without this a link or a
  // scripted location change would load a remote origin with the preload (and
  // window.api) still attached.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = url === devServer || url.startsWith(`${APP_SCHEME}://`)
    if (!allowed) event.preventDefault()
  })

  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadURL(APP_URL)
  }

  return window
}

function isSafeExternal(url: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Apply the strict content security policy to the packaged app:// responses. In
 * dev the index.html meta CSP governs the renderer, so this is a no-op there to
 * avoid fighting HMR.
 *
 * Deliberately NOT cross-origin isolated: COOP: same-origin + COEP: require-corp
 * were tried to let the depth worker's wasm fallback go multi-threaded on
 * machines without WebGPU, but on the primary Apple Silicon target isolation
 * broke WebGPU device acquisition inside the worker, forcing an unreliable
 * fp16-on-wasm path and killing the live preview ("Live depth failed to
 * recover"). The WebGPU path is the one that matters here, so isolation stays
 * off until it can be gated on WebGPU actually being absent and validated on a
 * real no-WebGPU target.
 */
export function applyContentSecurityPolicy(): void {
  if (process.env.ELECTRON_RENDERER_URL) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
            "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
            "worker-src 'self' blob:; connect-src 'self'",
        ],
      },
    })
  })
}
