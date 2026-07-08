import type { BackendInfo, LogNote, ProgressNote, ReconstructResult } from '@monoclejs/protocol'

/** Lifecycle of the inference sidecar as surfaced to the UI. */
export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'error'

export interface AppInfo {
  version: string
  platform: string
  arch: string
}

export interface SaveFileRequest {
  defaultName: string
  data: Uint8Array
}

/** Renderer-facing reconstruction request. Main allocates the session directories. */
export interface ReconstructRequest {
  backend: string
}

/** Save an artifact the sidecar wrote (by path) to a user-chosen location. */
export interface ExportArtifactRequest {
  sourcePath: string
  defaultName: string
}

/**
 * The single source of truth for the preload bridge. Main type-checks its
 * handlers against this and the renderer type-checks `window.api` against it,
 * so the two processes cannot drift.
 */
export interface MonocleApi {
  getAppInfo(): Promise<AppInfo>
  /** Drive the native camera permission prompt. Resolves true when granted. */
  requestCameraAccess(): Promise<boolean>

  sidecar: {
    getStatus(): Promise<SidecarStatus>
    start(): Promise<void>
    stop(): Promise<void>
    listBackends(): Promise<BackendInfo[]>
    reconstruct(request: ReconstructRequest): Promise<ReconstructResult>
    onStatus(listener: (status: SidecarStatus) => void): () => void
    onProgress(listener: (note: ProgressNote) => void): () => void
    onLog(listener: (note: LogNote) => void): () => void
  }

  /** Prompt for a save location and write bytes. Resolves the path or null. */
  saveFile(request: SaveFileRequest): Promise<string | null>
  /** Copy a sidecar-written artifact to a user-chosen path. Resolves it or null. */
  exportArtifact(request: ExportArtifactRequest): Promise<string | null>
}

/** IPC channel names. Kept in one place so main and preload agree. */
export const Channel = {
  AppInfo: 'app:getInfo',
  CameraAccess: 'camera:requestAccess',
  SidecarStatus: 'sidecar:getStatus',
  SidecarStart: 'sidecar:start',
  SidecarStop: 'sidecar:stop',
  SidecarListBackends: 'sidecar:listBackends',
  SidecarReconstruct: 'sidecar:reconstruct',
  SaveFile: 'file:save',
  ExportArtifact: 'file:exportArtifact',
  // main -> renderer streams
  EventSidecarStatus: 'sidecar:event:status',
  EventSidecarProgress: 'sidecar:event:progress',
  EventSidecarLog: 'sidecar:event:log',
} as const
