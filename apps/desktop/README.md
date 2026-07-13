# @monoclejs/desktop

The MONOCLE desktop app: a Vue 3 UI in an Electron shell that supervises the
Python inference sidecar. Private to the repo, never published.

## Processes

- **main** (`src/main`): app lifecycle, the locked-down window, the camera
  permission handler, and the `SidecarSupervisor` that owns the Python process.
- **preload** (`src/preload`): the only bridge. Exposes a narrow, typed
  `window.api` via `contextBridge`. No raw `ipcRenderer` reaches the renderer.
- **renderer** (`src/renderer`): the Vue app. Live camera capture, GPU
  capability detection, scan-method selection, and engine status.
- **shared** (`src/shared`): the IPC contract both main and renderer compile
  against, so the two cannot drift.

## Security posture

`contextIsolation` and `sandbox` are on, `nodeIntegration` is off, a strict CSP
is applied to the session, and the permission handler allows only media. The
camera prompt is driven natively on macOS via `systemPreferences`. Cross-origin
isolation headers (COOP/COEP) are set on both the packaged `app://` origin and
the dev server; since every resource is local this is safe, and it lets the
live-depth wasm path use SharedArrayBuffer threads on machines without WebGPU.

## Rendering tiers

WebGL2 is the guaranteed layer. WebGPU is detected at runtime and used when
present; it is absent on Raspberry Pi arm64, so nothing load-bearing depends on
it. The `CapabilityList` panel shows what this machine offers.

## Scripts

- `pnpm dev` runs electron-vite with renderer HMR and main/preload hot reload.
- `pnpm build` bundles main, preload, and renderer into `out/`.
- `pnpm package` builds and runs electron-builder (see `electron-builder.yml`).
- `pnpm typecheck` runs `tsc` for main/preload and `vue-tsc` for the renderer.

## Sidecar wiring

The supervisor spawns `python3 -m monocle_sidecar` from the sidecar directory
(`../../sidecar` in dev, `Resources/sidecar` when packaged), performs a health
handshake, checks the protocol version, restarts on crash with backoff, and is
killed on quit. Starting the engine works with a bare Python; reconstruction
needs the sidecar extras installed.
