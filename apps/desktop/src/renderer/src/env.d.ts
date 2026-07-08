/// <reference types="vite/client" />
import type { MonocleApi } from '../../shared/ipc'

declare global {
  interface Window {
    api: MonocleApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

export {}
