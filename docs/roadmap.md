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

Also done (implemented, pending runtime validation with the extras and weights
installed, since those are not available in the build environment):

- Frame staging: captured keyframes are encoded to PNG and written to the
  session frames directory in the main process; reconstruction runs against that
  session. Verified by typecheck and build.
- Depth Anything V2 backend: single-view monocular depth to mesh via onnxruntime
  (numpy, pillow), needing only the `depth` extra. Back-projects the depth grid
  and triangulates it, dropping discontinuous quads. Scale is relative and
  documented as such.
- TSDF fusion: Open3D `ScalableTSDFVolume` integration and mesh export behind the
  `reconstruct` extra, with the posed-depth-frame contract.
- Depth Anything 3 multi-view backend: loads frames, runs the model behind an
  isolated call, fuses via TSDF, exports STL. The DA3 API is isolated and flagged
  for verification against the pinned package.

Remaining:

- Run the depth and multi-view paths with the extras and weights installed, and
  validate output quality on real captures.
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
