import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LogNote, ProgressNote } from '@monoclejs/protocol'
import { Channel, type MonocleApi, type SidecarStatus } from '../shared/ipc'

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
    reconstruct: (params) => ipcRenderer.invoke(Channel.SidecarReconstruct, params),
    onStatus: (listener) => subscribe<SidecarStatus>(Channel.EventSidecarStatus, listener),
    onProgress: (listener) => subscribe<ProgressNote>(Channel.EventSidecarProgress, listener),
    onLog: (listener) => subscribe<LogNote>(Channel.EventSidecarLog, listener),
  },
  saveFile: (request) => ipcRenderer.invoke(Channel.SaveFile, request),
  exportArtifact: (request) => ipcRenderer.invoke(Channel.ExportArtifact, request),
}

contextBridge.exposeInMainWorld('api', api)
