# Roadmap

Milestones are ordered by dependency, not date. Each builds on the last.

## M0: Foundation and running shell (done)

- pnpm + Turborepo monorepo, shared TS config, Changesets.
- `@monoclejs/core`: frame model, five-stage pipeline, `ScanEngine`, math.
- `@monoclejs/mesh-io`: STL, PLY, OBJ serializers.
- `@monoclejs/protocol`: JSON-RPC framing, client, sidecar contract.
- Electron + Vue app: live webcam capture, device selection, GPU capability
  detection, scan-method picker, supervised sidecar with health handshake.
- Python sidecar: dependency-free health and backend listing over stdio.

## M1: Markerless depth pipeline (in progress)

Done:

- Reconstruction harness: `reconstruct` runs on a worker thread and is genuinely
  cancellable over the protocol, with progress and log notifications streamed.
- Synthetic backend: a dependency-free STL producer that exercises the entire
  capture-to-STL path today, so the plumbing is provable before the models land.
- App path: reconstruct-and-export wired end to end. Main allocates the session
  directories; the renderer picks a backend, watches progress, and saves the STL.
  Verified across the language boundary against the real spawned sidecar.

Remaining:

- Sidecar depth backend: Depth Anything V2 Small via onnxruntime, real output.
- Feed-forward multi-view backend (Depth Anything 3 class) for pose and depth.
- TSDF fusion and mesh extraction (Open3D) behind the `reconstruct` extra.
- Frame staging: write captured keyframes to the session frames directory so the
  real backends have input (the synthetic backend ignores frames by design).
- Acceptance: a freehand desk-object sweep yields a usable mesh on an M1 Air.

## M2: Live preview and guidance

- In-renderer monocular depth preview via transformers.js on WebGPU.
- Live point-cloud viewport and coverage guidance so holes are visible during
  capture, with a WebGL2 fallback.
- Keyframe selection by blur score and pose delta; frames staged to OPFS.

## M3: Additional methods

- Object-sweep masking pass for object-centric scans.
- Turntable method: WebSerial motor control, known-angle pose, no marker in frame.
- Marker-mat fallback: ChArUco pose plus silhouette carving for low-end hardware.

## M4: Output and polish

- Mesh cleanup: largest-connected-component filter, decimation.
- Gaussian-splat appearance pass exported next to the mesh.
- Packaging: signed and notarized macOS arm64 build, Linux arm64 AppImage,
  differential auto-update.

## Cross-cutting

- Keep every publishable package independently useful and tested.
- Re-check model-weight licenses at each pinned version.
- No scan method forks the engine; each is a set of backends.
