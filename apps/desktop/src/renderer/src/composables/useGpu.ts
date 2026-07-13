import { ref } from 'vue'

export interface GpuCapabilities {
  webgl2: boolean
  webgpu: boolean
  adapter: string | null
  /**
   * The page is cross-origin isolated (COOP/COEP set), so SharedArrayBuffer is
   * available and the depth worker's wasm fallback can run multi-threaded.
   */
  crossOriginIsolated: boolean
}

interface GpuAdapterLike {
  info?: { description?: string; vendor?: string }
}

interface NavigatorGpuLike {
  gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> }
}

/**
 * Detect the rendering and compute tiers available in this session. WebGL2 is
 * the guaranteed floor; WebGPU is opportunistic and absent on Raspberry Pi
 * arm64, so the UI treats it as a bonus, never a requirement.
 */
export function useGpu() {
  const capabilities = ref<GpuCapabilities>({
    webgl2: false,
    webgpu: false,
    adapter: null,
    crossOriginIsolated: false,
  })

  async function detect(): Promise<GpuCapabilities> {
    const canvas = document.createElement('canvas')
    const webgl2 = canvas.getContext('webgl2') !== null
    const isolated = window.crossOriginIsolated === true

    let webgpu = false
    let adapter: string | null = null
    const nav = navigator as Navigator & NavigatorGpuLike
    if (nav.gpu) {
      try {
        const found = await nav.gpu.requestAdapter()
        webgpu = found !== null
        adapter = found?.info?.description ?? found?.info?.vendor ?? null
      } catch {
        webgpu = false
      }
    }

    capabilities.value = { webgl2, webgpu, adapter, crossOriginIsolated: isolated }
    return capabilities.value
  }

  return { capabilities, detect }
}
