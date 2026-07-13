/**
 * Cross-origin isolation headers.
 *
 * Setting Cross-Origin-Opener-Policy: same-origin together with
 * Cross-Origin-Embedder-Policy: require-corp makes window.crossOriginIsolated
 * true. That is the switch that unlocks SharedArrayBuffer, which onnxruntime-web
 * needs to run its wasm execution provider on multiple threads. It is the live
 * depth preview's only speed lever on a machine without WebGPU (Linux, older
 * Macs), where the single-threaded wasm floor is slow.
 *
 * Isolating the top-level document is safe here because everything MONOCLE loads
 * is local: bundled into the renderer and served from the app:// origin in a
 * packaged build, or from the local dev server. There are no cross-origin
 * frames, popups, or subresources for isolation to break.
 * Cross-Origin-Resource-Policy: same-origin is included so the app:// responses
 * themselves satisfy COEP when the renderer or its depth worker fetches the
 * model and ort wasm binaries.
 *
 * The value strings are constant, so this is a pure helper both the packaged
 * app:// header pass (main) and the dev server (electron.vite.config) share,
 * keeping the two origins in lockstep.
 */
export function crossOriginIsolationHeaders(): Record<string, string> {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
}
