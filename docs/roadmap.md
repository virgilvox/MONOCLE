# Roadmap

Milestones are ordered by dependency, not date. Each builds on the last.

## Current plan (post-v0.1.0, prioritized)

v0.1.0 publishes signed and notarized installers for macOS (arm64 + Intel),
Windows, and Linux AppImage (x64 + arm64), and the app now has an in-app
auto-updater (electron-updater, `src/main/updater.ts` + `UpdateBanner.vue`). The
four open workstreams, in priority order, each with a concrete first step. None
forks the engine; each plugs into an existing seam.

### 1. Reconstruction quality: close loops on the walk-around (core done)

The default Object scan now runs a two-pass, loop-closed pipeline, fully
commercial-safe (no new weights): `pose/pose_graph.py` (Open3D `global_optimization`,
MIT, CPU), `pose/loop_closure.py` (ORB matches between temporally distant
keyframes, verified with findEssentialMat/recoverPose and a min-inlier gate,
loop-edge translation scaled to metric via the frozen depth affine), and the
`orb-pgo` estimator, consumed by `backends/walkaround.py` in two passes: estimate
optimized poses, then fuse at them through `PosedDepthFrame`/TSDF. MASt3R-SLAM
stays the documented heavy option (GPU-first, CC-BY-NC weights).

Remaining (from the adversarial audit, all lower severity):

- Loop-edge metric fidelity degrades with loop distance: the single frozen depth
  affine is extrapolated to a temporally distant loop-source frame where Depth
  Anything V2's per-frame scale can differ, so a distant loop's translation can
  sit on a slightly different scale than the odometry baselines. Down-weight
  distant loop edges or re-normalize the loop-source depth scale.
- `verify_essential`/`recoverPose` use the source frame's intrinsics for both
  views (correct for the uniform single-camera capture the pose stage assumes;
  pass the target intrinsics if mixed-resolution captures ever arrive).
- Scale-drift mitigation (Sim(3) or periodic re-anchoring) and wiring an explicit
  estimator choice into the UI are the natural follow-ons.

### 2. Packaging and release maturity

Auto-update shipped; the rest is guardrails. Adopt Changesets as the single
version source (un-ignore `@monoclejs/desktop` in `.changeset/config.json`,
GitHub changelog, a Version-Packages PR that tags on merge instead of the
hand-moved `v0.1.0` tag). Turn `bundle:python` into a hard health gate. `lib3mf`
is now decoupled from the `walk`/`depth` extras into an opt-in `color-print`
extra (the 3MF writer skips with a log when it is absent), so arm64 Linux can
bundle a working interpreter. Put COOP/COEP behind an explicit opt-in and
validate the wasm-thread live-depth path on a no-WebGPU target. **First step:**
un-ignore the desktop app in Changesets and switch to `@changesets/changelog-github`.

### 3. Output paths and package honesty

The Gaussian-splat (`gs_ply`) and COLMAP output paths are wired but unproven, and
three renderer honesty bugs remain (COLMAP empty-state, gs_ply preview, missing
point counts). Add a CPU integration test on the Apache-2.0 DA3-BASE checkpoint
that actually exercises point-cloud + COLMAP export, then fix the renderer gating.
Separately, resolve the unused `@monoclejs/core` / `mesh-io` libraries: sever the
app's nominal dependency and label them as standalone published libraries (they
do not sit on the app's Python reconstruction path). **First step:** land the CPU
BASE integration test that proves the DA3 export API before any UI change.

### 4. New depth inputs behind one seam

Add OpenNI2 depth cameras (Orbbec Astra, Structure) and stereo webcams as new
backends via a single reusable `PosedDepthBackend` that treats depth as an
on-disk metric artifact (16-bit mm) alongside RGB, fused through the existing
`PosedDepthFrame` contract. Stereo webcams are the first shippable input
(OpenCV `StereoSGBM`, BSD). **First step:** `backends/posed_depth.py` that globs
`frame_*.png` + sibling metric `depth_*.png`, loads `poses.json`, and fuses via
the existing `integrate_depth_frames` path (mirroring `walkaround.py`).

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

Runtime-validated (in a Python 3.12 venv with the extras installed):

- Depth path: the Depth Anything V2 Small ONNX weights download and run through
  onnxruntime on real frames, producing a valid binary STL. No code changes were
  needed.
- Fusion path: Open3D `integrate_depth_frames` and `write_mesh` produce a valid
  STL from posed depth frames. One real bug was fixed here: the `depth_trunc`
  default dropped surfaces at the cutoff, yielding an empty mesh.

Multi-view (Depth Anything 3): now runs end to end on this machine. xformers is
not required (the package falls back to pure PyTorch), so it installs with
`--no-deps` plus the runtime deps in the `multiview` extra. An OpenMP/Open3D
segfault was fixed by importing Open3D before cv2. The default checkpoint is the
Apache-2.0 DA3-BASE; DA3-LARGE/GIANT (CC-BY-NC) are opt-in via `MONOCLE_DA3_CKPT`.
On this macOS 12 box it runs on CPU (no MPS until macOS 14+), a few tens of
seconds for a handful of views.

Note: onnxruntime has no macOS 12 wheel for Python 3.13, so the sidecar venv uses
Python 3.12; the app's supervisor already prefers `sidecar/.venv`.

## M2: Live preview, color, quality, and UX (done)

- In-renderer realtime depth preview: onnxruntime-web on WebGPU in a Web Worker,
  a static point grid displaced by a depth texture with temporal smoothing, and a
  WebGL2 floor. Validated in a packaged-style build.
- Color end to end: vertex color capture, and STL / colored PLY / GLB / 3MF
  export.
- Mesh quality: edge-aware depth denoise and flying-pixel culling on the
  single-view path; shared Open3D cleanup (largest component, Taubin smooth,
  quadric decimation, normals) on multi-view.
- UX: one scan-preset picker, a capture HUD with sharpness/motion keyframe gating
  plus a manual capture override, an in-app 3D viewer with a toolbar, engine
  auto-start, and save-by-format with reveal in Finder.

### M2 audit and hardening (done)

A deep audit drove these fixes: a custom `app://` scheme so the live-depth model
loads in packaged builds (B1); a stdout/fd-1 redirect so native library logs
cannot corrupt the JSON-RPC stream (B2); a reconstruct timeout with sidecar
restart (B3); tracked restart timer and kill-before-respawn to avoid orphaned
processes (H1); temp-containment guards on all renderer-supplied paths (H2);
worker teardown on crash (H3); sRGB-to-linear vertex color for glTF (M1);
adaptive keyframe thresholds plus a manual capture button (M3); and guarded mesh
parsing (M5).

### Known issues

Full ranked list in [AUDIT.md](AUDIT.md) (functional) and [UX-AUDIT.md](UX-AUDIT.md)
(design). The headline items:

- Release blocker (resolved): a relocatable Python with the `depth` extra is now
  bundled per platform (`scripts/bundle-python.mjs`), so a shipped build
  reconstructs without a local setup. See [AUDIT.md](AUDIT.md) and
  [BUILD.md](BUILD.md).
- Multi-view color is dropped when DA3's depth resolution differs from the source
  frame (M7); resize instead of dropping.
- Live-depth off WebGPU now runs the fp32 wasm model with COOP/COEP
  multi-threading, but the worker still does not auto-restart after a crash.
- The TS `core` and `mesh-io` packages are effectively unused by the app, and
  test effort is inverted toward them rather than the supervisor and keyframe
  gate.
- Smaller: viewer point-cloud rebuild (M6), LiveDepthView renders while hidden
  and lacks context-loss handling (L1), preset/backend frame-count mismatch.

### UI/UX and design system (done)

A centralized design system and a precision-optics identity are in place:
`tokens.css` holds every design token, `theme.ts` is the single palette source
the chrome and the Three.js surfaces share, fonts and icons are self-hosted, and
the camera and 3D surfaces carry instrument framing. Accessibility gaps
(focus-visible, tab roles, contrast, reduced motion, status by shape) are closed.
See [DESIGN.md](DESIGN.md); the audit that drove it is [UX-AUDIT.md](UX-AUDIT.md).

## M3: Additional methods

- Pose / SLAM seam (in progress): a `PoseEstimator` interface feeds `poses.json`
  into a `needs_poses` backend, so a pose source is a swappable module, not an
  engine fork. Done: the seam, a CPU `OrbVisualOdometry` estimator, the
  `MASt3RSlamPoseEstimator` stub behind the `slam` extra, and the server pose
  stage. Remaining: a walk-around backend that consumes the poses, and scale
  alignment between VO poses and monocular depth. See [SLAM.md](SLAM.md).
- Object-sweep masking pass for object-centric scans.
- Turntable method: WebSerial motor control, known-angle pose, no marker in frame.
- Marker-mat fallback: ChArUco pose plus silhouette carving for low-end hardware.

## M4: Output and polish

- Mesh cleanup: largest-connected-component filter, decimation.
- Gaussian-splat appearance pass exported next to the mesh.
- Packaging: signed and notarized macOS arm64 build (done), Linux arm64 AppImage
  (done), in-app auto-update via electron-updater (done). See the Current plan
  above for the remaining release-maturity guardrails.

## Cross-cutting

- Keep every publishable package independently useful and tested.
- Re-check model-weight licenses at each pinned version.
- No scan method forks the engine; each is a set of backends.
