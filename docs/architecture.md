# Architecture

## Principle

Build the engine once. A scanning method is a set of backends, not a new
codebase. Everything below serves that rule.

## The five-stage engine

Status note: this five-stage engine is defined in `@monoclejs/core` as an
independently published, tested TypeScript library, and it expresses the
intended model below. The shipping desktop app does not currently route
reconstruction through `ScanEngine`: geometry and serialization run in the
Python sidecar (see the inference split), and the app consumes only small shared
pieces of `core` (such as the event `Emitter`). Read this section as the library
design and the target, not the code path a scan takes in the app today. Wiring
the app onto `ScanEngine`, or keeping the two deliberately separate, is an open
decision tracked in [AUDIT.md](AUDIT.md).

Defined in `@monoclejs/core`. A scan is a stream of frames driven through five
stages to a mesh:

```
CAPTURE -> POSE -> GEOMETRY -> FUSION -> MESH/EXPORT
```

Each stage is an interface:

- `PoseEstimator` recovers camera pose (and optionally intrinsics) per frame.
- `GeometryStage` produces per-frame cues: a foreground mask, a depth map, or both.
- `FusionVolume` accumulates posed frames (binary carve, TSDF, point-map merge).
- `Mesher` extracts a mesh from the fused volume.

`ScanEngine` owns the control flow: it drives frames through the stages, emits a
typed event stream (progress, pose, integrated, error), and returns a `Mesh`.
Swapping methods means swapping backends, never editing the engine.

## Scanning methods (backends)

- **Markerless walk-around (MVP).** Feed-forward multi-view geometry recovers
  pose and depth from unposed frames. Runs in the sidecar.
- **Object sweep.** Same models, object-centric capture with masking.
- **Turntable.** Fixed camera, known step angles for pose, object on a motor.
- **Marker mat (fallback).** ChArUco/AprilTag pose plus silhouette carving or
  monocular-depth TSDF. Runs anywhere, including low-end hardware.

## Inference split (hybrid)

Inference is divided by weight class:

- **Renderer, light path.** Live monocular-depth preview and the interactive
  point-cloud viewport run in the renderer via transformers.js / onnxruntime-web
  on WebGPU, with a WASM+SIMD floor. Zero cross-process copies against the same
  webcam stream. WebGL2 is the guaranteed rendering layer.
- **Sidecar, heavy path.** Multi-view reconstruction (Depth Anything 3 class) and
  TSDF fusion / Poisson meshing run in a Python process on PyTorch MPS plus
  Open3D. The app supervises it and streams progress back.

## App shell

Electron, three processes:

- **main** owns the window, camera permissions, and the `SidecarSupervisor`.
- **preload** exposes a narrow typed `window.api` over `contextBridge`.
- **renderer** is the Vue app.

Security defaults: `contextIsolation` and `sandbox` on, `nodeIntegration` off, a
strict CSP, and a media-only permission allowlist.

## Sidecar protocol

`@monoclejs/protocol` defines JSON-RPC 2.0 with Content-Length framing and the
typed method contract (`health`, `listBackends`, `reconstruct`, `cancel`) plus
`progress` and `log` notifications. The supervisor speaks it over the child's
stdio. Image payloads are passed by temp-file path, never inline, to keep the
pipe light. `PROTOCOL_VERSION` guards against app/sidecar drift.

## Hardware targets

- **Apple Silicon (M1)** is the primary target: WebGPU in the renderer, PyTorch
  MPS in the sidecar. Apple Object Capture is a possible optional macOS engine.
- **Raspberry Pi 5** is a capture and carving node, not a transformer host.
  WebGPU is disabled there, so the renderer runs on WebGL2; heavy multi-view
  reconstruction is off the device unless an NPU hat is present.
