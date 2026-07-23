# Architecture

## Principle

Build the engine once. A scanning method is a set of backends, not a new
codebase. Everything below serves that rule.

## The five-stage engine

Status note: this five-stage engine is the conceptual model, not a literal code
path. Geometry and serialization run in the Python sidecar (see the inference
split), whose backends map onto these stages. A standalone TypeScript
implementation of the model (`@monoclejs/core`, with `@monoclejs/mesh-io` for
serializers) once lived in this repo but was never on the app's scan path and
has been removed. Read this section as the design the sidecar backends follow.

A scan is a stream of frames driven through five stages to a mesh:

```
CAPTURE -> POSE -> GEOMETRY -> FUSION -> MESH/EXPORT
```

Each stage is an interface:

- `PoseEstimator` recovers camera pose (and optionally intrinsics) per frame.
- `GeometryStage` produces per-frame cues: a foreground mask, a depth map, or both.
- `FusionVolume` accumulates posed frames (binary carve, TSDF, point-map merge).
- `Mesher` extracts a mesh from the fused volume.

The engine owns the control flow: it drives frames through the stages, emits
progress and error events, and returns a mesh. Swapping methods means swapping
backends, never editing the engine.

## Scanning methods (backends)

- **Markerless walk-around (shipping default).** The `LiveWalkFusion` engine:
  ORB visual-odometry pose plus Depth Anything V2 depth fused into an Open3D
  TSDF, in the sidecar. Depth Anything 3 multi-view is an optional downloaded
  pack, selectable in Advanced.
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
strict CSP, and a media-only permission allowlist. The renderer is cross-origin
isolated (COOP/COEP set on both the packaged `app://` responses and the dev
server), which is safe because everything it loads is local and lets the
live-depth wasm fallback run multi-threaded off WebGPU.

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
