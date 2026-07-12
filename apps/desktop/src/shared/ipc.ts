import type {
  BackendInfo,
  LogNote,
  ProgressNote,
  ReconstructQuality,
  ReconstructResult,
} from '@monoclejs/protocol'

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

/**
 * Renderer-facing reconstruction request. When `sessionId` is set, main
 * reconstructs against that capture session's staged frames. Without it, main
 * falls back to allocating an empty session directory.
 */
export interface ReconstructRequest {
  backend: string
  sessionId?: string
  /** Resolution and decimation preset. Defaults to `balanced` when omitted. */
  quality?: ReconstructQuality
  /** Capture and export per-vertex color. */
  color?: boolean
  /** Model checkpoint / size override (Depth Anything 3: base, large, giant). */
  checkpoint?: string
}

/** Stage a single encoded keyframe into an active capture session. */
export interface StageFrameRequest {
  sessionId: string
  data: Uint8Array
}

/** Save an artifact the sidecar wrote (by path) to a user-chosen location. */
export interface ExportArtifactRequest {
  sourcePath: string
  defaultName: string
}

/** Read a sidecar-written artifact (by path) into the renderer for preview. */
export interface ReadArtifactRequest {
  path: string
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
    /** Ask the sidecar to abort the in-flight reconstruction. */
    cancelReconstruct(): Promise<void>
    onStatus(listener: (status: SidecarStatus) => void): () => void
    onProgress(listener: (note: ProgressNote) => void): () => void
    onLog(listener: (note: LogNote) => void): () => void
  }

  /** Capture-session lifecycle. Frames are staged to disk in the main process. */
  session: {
    /** Start a session. Resolves its id, used to stage frames and reconstruct. */
    begin(): Promise<string>
    /** Write one encoded keyframe. Resolves the session's new frame count. */
    stageFrame(request: StageFrameRequest): Promise<number>
    /** Finish a session. Files are kept for the reconstruct step. */
    end(sessionId: string): Promise<void>
  }

  /** Prompt for a save location and write bytes. Resolves the path or null. */
  saveFile(request: SaveFileRequest): Promise<string | null>
  /** Copy a sidecar-written artifact to a user-chosen path. Resolves it or null. */
  exportArtifact(request: ExportArtifactRequest): Promise<string | null>
  /** Read a sidecar-written artifact into memory for in-app 3D preview. */
  readArtifact(request: ReadArtifactRequest): Promise<Uint8Array>
  /** Reveal a file in the OS file manager (Finder/Explorer). */
  reveal(path: string): Promise<void>
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
  SidecarCancel: 'sidecar:cancel',
  SessionBegin: 'session:begin',
  SessionStageFrame: 'session:stageFrame',
  SessionEnd: 'session:end',
  SaveFile: 'file:save',
  ExportArtifact: 'file:exportArtifact',
  ReadArtifact: 'file:read',
  Reveal: 'file:reveal',
  // main -> renderer streams
  EventSidecarStatus: 'sidecar:event:status',
  EventSidecarProgress: 'sidecar:event:progress',
  EventSidecarLog: 'sidecar:event:log',
} as const
