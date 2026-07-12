import type {
  BackendInfo,
  LogNote,
  MeshUpdateNote,
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

/**
 * A media source the user chose to reconstruct. The real path stays in the main
 * process; the renderer only ever holds an opaque token that maps back to a
 * dialog-approved path, so a compromised renderer cannot point the sidecar at an
 * arbitrary file.
 */
export interface ChosenMedia {
  token: string
  kind: 'video' | 'folder'
}

/** Ingest a chosen video/folder (by token) into a fresh session's frames dir. */
export interface ImportMediaRequest {
  /** Token minted by chooseMedia; resolves to the approved path in main. */
  token: string
  /** Keyframe budget; sampled evenly and by sharpness. Defaults per the sidecar. */
  maxFrames?: number
}

/** The session the imported keyframes were staged into, and how many there are. */
export interface ImportMediaResult {
  sessionId: string
  frameCount: number
}

/** Start an experimental live reconstruction against a capture session. */
export interface LiveReconstructRequest {
  sessionId: string
  color?: boolean
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
    /** Ingest a chosen video/folder into a new session and stage its keyframes. */
    prepareMedia(request: ImportMediaRequest): Promise<ImportMediaResult>
    /** Start an experimental live reconstruction; resolves when it is cancelled. */
    liveReconstruct(request: LiveReconstructRequest): Promise<void>
    /** Ask the sidecar to abort the in-flight (or live) reconstruction. */
    cancelReconstruct(): Promise<void>
    onStatus(listener: (status: SidecarStatus) => void): () => void
    onProgress(listener: (note: ProgressNote) => void): () => void
    onLog(listener: (note: LogNote) => void): () => void
    onMeshUpdate(listener: (note: MeshUpdateNote) => void): () => void
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

  /** Open a picker for a video file or an image folder. Resolves null if cancelled. */
  chooseMedia(): Promise<ChosenMedia | null>
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
  SidecarPrepareMedia: 'sidecar:prepareMedia',
  SidecarLiveReconstruct: 'sidecar:liveReconstruct',
  SidecarCancel: 'sidecar:cancel',
  ChooseMedia: 'media:choose',
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
  EventSidecarMeshUpdate: 'sidecar:event:meshUpdate',
} as const
