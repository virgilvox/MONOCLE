import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LogNote, MeshUpdateNote, ProgressNote } from '@monoclejs/protocol'
import {
  Channel,
  type Da3Progress,
  type Da3Status,
  type MonocleApi,
  type SidecarStatus,
  type UpdateAvailableInfo,
  type UpdateDownloadedInfo,
  type UpdateDownloadProgress,
  type UpdateErrorInfo,
} from '../shared/ipc'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: MonocleApi = {
  getAppInfo: () => ipcRenderer.invoke(Channel.AppInfo),
  requestCameraAccess: () => ipcRenderer.invoke(Channel.CameraAccess),
  sidecar: {
    getStatus: () => ipcRenderer.invoke(Channel.SidecarStatus),
    start: () => ipcRenderer.invoke(Channel.SidecarStart),
    stop: () => ipcRenderer.invoke(Channel.SidecarStop),
    listBackends: () => ipcRenderer.invoke(Channel.SidecarListBackends),
    getDevice: () => ipcRenderer.invoke(Channel.SidecarDevice),
    reconstruct: (params) => ipcRenderer.invoke(Channel.SidecarReconstruct, params),
    prepareMedia: (request) => ipcRenderer.invoke(Channel.SidecarPrepareMedia, request),
    liveReconstruct: (request) => ipcRenderer.invoke(Channel.SidecarLiveReconstruct, request),
    cancelReconstruct: () => ipcRenderer.invoke(Channel.SidecarCancel),
    onStatus: (listener) => subscribe<SidecarStatus>(Channel.EventSidecarStatus, listener),
    onProgress: (listener) => subscribe<ProgressNote>(Channel.EventSidecarProgress, listener),
    onLog: (listener) => subscribe<LogNote>(Channel.EventSidecarLog, listener),
    onMeshUpdate: (listener) => subscribe<MeshUpdateNote>(Channel.EventSidecarMeshUpdate, listener),
  },
  session: {
    begin: () => ipcRenderer.invoke(Channel.SessionBegin),
    stageFrame: (request) => ipcRenderer.invoke(Channel.SessionStageFrame, request),
    end: (sessionId) => ipcRenderer.invoke(Channel.SessionEnd, sessionId),
  },
  chooseMedia: () => ipcRenderer.invoke(Channel.ChooseMedia),
  saveFile: (request) => ipcRenderer.invoke(Channel.SaveFile, request),
  exportArtifact: (request) => ipcRenderer.invoke(Channel.ExportArtifact, request),
  readArtifact: (request) => ipcRenderer.invoke(Channel.ReadArtifact, request),
  reveal: (path) => ipcRenderer.invoke(Channel.Reveal, path),
  da3: {
    getStatus: () => ipcRenderer.invoke(Channel.Da3Status),
    install: () => ipcRenderer.invoke(Channel.Da3Install),
    cancel: () => ipcRenderer.invoke(Channel.Da3Cancel),
    remove: () => ipcRenderer.invoke(Channel.Da3Remove),
    onState: (listener) => subscribe<Da3Status>(Channel.EventDa3State, listener),
    onProgress: (listener) => subscribe<Da3Progress>(Channel.EventDa3Progress, listener),
  },
  updater: {
    checkForUpdates: () => ipcRenderer.invoke(Channel.UpdateCheck),
    downloadUpdate: () => ipcRenderer.invoke(Channel.UpdateDownload),
    installUpdate: () => ipcRenderer.invoke(Channel.UpdateInstall),
    onUpdateAvailable: (listener) =>
      subscribe<UpdateAvailableInfo>(Channel.EventUpdateAvailable, listener),
    onDownloadProgress: (listener) =>
      subscribe<UpdateDownloadProgress>(Channel.EventUpdateProgress, listener),
    onUpdateDownloaded: (listener) =>
      subscribe<UpdateDownloadedInfo>(Channel.EventUpdateDownloaded, listener),
    onUpdateError: (listener) => subscribe<UpdateErrorInfo>(Channel.EventUpdateError, listener),
  },
}

contextBridge.exposeInMainWorld('api', api)
