# Camera pose and SLAM for the walk-around path

Research memo. Scope: adding real camera pose / SLAM to MONOCLE's markerless
walk-around capture, and where it fits the existing backend and fusion seams.

## The problem

MONOCLE's multi-view path (`backends/multiview.py`) runs a Depth Anything 3 class
model that predicts, jointly for a batch of unposed views, a metric depth map,
intrinsics, and a camera extrinsic per view. The backend wraps each view as a
`PosedDepthFrame` and fuses the batch with an Open3D TSDF volume. This works well
for a turntable-style capture of a small number of views.

It has three structural limits for a longer walk-around:

1. **Pose is recovered implicitly, per batch.** Feed-forward multi-view
   transformers hold every view in memory at once, so the backend caps input at
   40 evenly spaced keyframes (`_MAX_FRAMES`). Poses are consistent only within
   that one forward pass. There is no camera track across the full capture.
2. **No persistent map.** Nothing accumulates state between batches, so two
   halves of a large scan cannot be related except through whatever overlap
   survives the keyframe subsampling.
3. **No loop closure or drift correction.** When you walk around an object and
   return to the start, nothing recognizes the revisit and closes the loop, so
   error accumulates along the trajectory. The result drifts and the two ends of
   the walk-around do not meet.

The fix is a real camera tracker (SLAM): maintain a map, track each frame against
it, detect revisits, and globally optimize the trajectory. That produces a
globally consistent pose per frame, which is exactly the input the existing TSDF
fuser already consumes.

## The 2025-2026 landscape

All of the systems below are built on the DUSt3R/MASt3R line of "3D
reconstruction priors": a network that, given two images, directly regresses a
pair of pointmaps in a shared frame, which yields correspondence, relative pose,
and geometry in one shot without classical feature matching. That prior is what
made dense, feed-forward SLAM practical in the last two years.

### DUSt3R / MASt3R (the two-view foundations)

DUSt3R regresses aligned pointmaps from an image pair; MASt3R adds a matching
head for accurate, dense correspondence. They are the geometric primitive the
SLAM systems below build on, not SLAM systems themselves (no map, no loop
closure). License: the released MASt3R weights are CC-BY-NC-SA 4.0, non
commercial. https://github.com/naver/mast3r , https://github.com/naver/dust3r

### MASt3R-SLAM

Real-time dense monocular SLAM built bottom-up on the MASt3R two-view prior
(CVPR 2025). It runs at roughly 15 FPS on a GPU and contributes efficient
pointmap matching, camera tracking and local fusion, graph construction and loop
closure, and second-order global optimization. It assumes only a unique camera
center, so it tolerates in-the-wild video without a fixed parametric camera
model. This is the closest match to what MONOCLE's walk-around needs: a drop-in
dense monocular tracker with loop closure.

Tradeoffs: it targets CUDA GPUs and depends on the MASt3R weights, which are non
commercial (CC-BY-NC-SA 4.0), so it cannot ship in a commercial build as is. The
15 FPS figure is on a discrete GPU.
https://arxiv.org/abs/2412.12392 , https://github.com/rmurai0610/MASt3R-SLAM ,
https://edexheim.github.io/mast3r-slam/

### VGGT and VGGT-SLAM

VGGT (Visual Geometry Grounded Transformer) is a feed-forward transformer that
predicts camera parameters, depth, and pointmaps for many views in a single pass
(CVPR 2025 best paper, `facebookresearch/vggt`). The default checkpoint is
CC-BY-NC 4.0 (non commercial); a separately released `VGGT-1B-Commercial`
checkpoint is licensed for commercial use, which matters for a shippable app.
https://github.com/facebookresearch/vggt , https://arxiv.org/abs/2503.11651

VGGT-SLAM turns VGGT into a full SLAM system by running VGGT over overlapping
submaps and stitching them with a factor graph optimized on the SL(4) manifold:
it estimates 15-DoF homography transforms between sequential submaps (resolving
the projective ambiguity of uncalibrated reconstruction) and adds loop closure
constraints found with SALAD place-recognition descriptors. It has been shown to
join up to 22 submaps across a 55 m office-corridor loop. A later VGGT-SLAM 2.0
keeps the SL(4) factor graph but constrains the alignment to a subset of
variables for real-time operation. https://arxiv.org/abs/2505.12549 ,
https://gtsam.org/2026/06/24/vggt-slam.html

Tradeoffs: heavier than MASt3R-SLAM (VGGT is a large model over submaps), still
GPU-first, and the default weights are non commercial.

### EC3R-SLAM

A more recent entry in the same "3D reconstruction prior" SLAM family, aimed at
efficiency and consistency. Worth tracking as the field moves toward lighter,
calibration-free dense SLAM, but less proven than MASt3R-SLAM for our use.

### The macOS 12 CPU-only reality

This development box is macOS 12, which has no Metal/MPS PyTorch acceleration
(MPS support starts at macOS 14+), so torch runs on CPU. Every system above is
GPU-first and their headline throughput assumes a discrete CUDA GPU. On CPU they
are usable for offline reconstruction of a modest capture but far from their
real-time figures. Any integration must therefore treat SLAM as an optional,
opt-in, offline stage that degrades to the current per-batch path when the
hardware is not there, not as an always-on tracker. The existing backend already
resolves device with `_resolve_device` and enables `PYTORCH_ENABLE_MPS_FALLBACK`,
so the same "pick what the box can do" posture applies.

## Recommendation

Add a **PoseEstimator** stage in front of fusion, not a fork of the engine.

The whole pipeline already runs on one unit, the `PosedDepthFrame` (depth +
intrinsics + camera-from-world pose). A SLAM method's job is precisely to produce
the pose half of that contract per frame. So the clean seam is:

```
frames  ->  PoseEstimator  ->  world-from-camera poses  ->  depth backend  ->  PosedDepthFrame  ->  TSDF fusion  ->  mesh
```

A backend that needs an external tracker declares `needs_poses = true` in
`models.toml` (the capability already exists end to end, through
`BackendConfig.needs_poses` and the protocol `BackendCapabilities.needsPoses`),
and the server runs the pose stage before handing frames to the backend. Fusion
never changes: it keeps consuming posed depth frames. This keeps a SLAM method as
a swappable module plus a registry entry, matching how depth backends already
plug in, rather than a parallel reconstruction engine.

The seam exists in `monocle_sidecar/pose/`:

- `pose/base.py`: `PoseEstimator` ABC, `FrameRef` (image path + optional
  intrinsics), and `PoseResult` (N x 4 x 4 world-from-camera poses, with
  `extrinsics()` to invert into the camera-from-world form fusion expects).
- `pose/identity.py`: `IdentityPoseEstimator`, a static-camera placeholder that
  keeps the interface exercised and tested with numpy alone.
- `pose/visual_odometry.py`: `OrbVisualOdometry`, a real classical estimator
  (ORB features plus essential-matrix pose recovery, chained across consecutive
  frames). It runs on CPU with only OpenCV, which the `depth` extra already
  bundles, so it works on this box where the foundation-model systems below do
  not. It is honest visual odometry: pose up to an unknown global scale, no loop
  closure, drift over a long path. OpenCV is imported lazily so the package stays
  numpy-only for CI.
- `pose/mast3r.py`: `MASt3RSlamPoseEstimator`, the loop-closing tracker behind
  the optional `slam` extra; torch and the tracker are imported lazily and the
  heavy path errors clearly until they are installed.
- `pose/pipeline.py`: `run_pose_stage` / `load_poses`, which run an estimator
  over a frames directory and read and write `poses.json`, the bridge the server
  uses to feed a `needs_poses` backend.

Between the candidate methods, **start with MASt3R-SLAM** as the reference
integration: it is the lightest true dense monocular SLAM with loop closure and
maps most directly onto a single per-frame pose track. Treat VGGT-SLAM as the
higher-quality, heavier alternative to slot behind the same interface once the
seam is proven. Neither default checkpoint is commercial; gate them the way
`multiview.py` already gates DA3-LARGE/GIANT, and prefer a commercially licensed
checkpoint (for example VGGT-1B-Commercial) for any shippable configuration.

## Phased integration plan

**Phase 0 (done): the seam.** `PoseEstimator` ABC, `PoseResult`, and
`IdentityPoseEstimator`, on numpy only, with tests. No weights, no behavior
change. This is what the rest of the phases build on.

**Phase 1 (done): wire the seam into the pipeline.** `pose/pipeline.py`'s
`run_pose_stage` runs a configured estimator over a frames directory and writes
`poses.json` (one camera-from-world 4x4 per frame, column-major, via
`PoseResult.extrinsics()`); `load_poses` reads it back. The server runs this
stage before any backend that declares `needs_poses` (guarded so today's
backends, which self-pose, are untouched), and a reconstruct param selects the
estimator (`orb`, `identity`, `mast3r`). An integration test drives a
`needs_poses` backend and asserts it sees `poses.json` before it runs, so the
plumbing is proven with no model involved. `poses.json` is the same contract an
external pose source (a turntable's known angles, a marker rig) can write.

**Phase 2 (done for CPU, stubbed for the tracker): a real estimator behind the
interface.** `OrbVisualOdometry` is the real CPU estimator: classical monocular
VO returning world-from-camera poses from a textured sequence with no GPU and no
weights, with the understood limits (relative scale, drift, no loop closure).
`MASt3RSlamPoseEstimator` (`pose/mast3r.py`) is the foundation-model tracker,
behind the new optional `slam` extra: its class and selection exist, but the
heavy path raises one clear error until the extra and the tracker package are
installed, exactly as `multiview.py` defers Depth Anything 3. Wiring the tracker
to its real API and validating the recovered poses is the remaining integration.

**Phase 3 (in progress): pair it with a depth backend and expose it.** Register a
walk-around backend that sets `needs_poses = true` and reads `poses.json` plus
per-frame monocular depth into `PosedDepthFrame`s, and wire the capability into
the app's model picker (the UI can already read `needsPoses`). Keep the DA3
per-batch path as the default; this is the opt-in CPU mode for longer captures.

The hard part is scale consistency: VO recovers motion only up to an unknown
global scale, and Depth Anything V2 predicts depth only up to an unknown affine
transform, so fusing them directly gives an incoherent volume. The standard fix,
from SfM-guided reconstruction work (Murre, [arXiv:2503.14483][murre], aligns
predicted depth to sparse SfM points with a robust linear regressor; see also
DeepRelativeFusion), is a per-view alignment: triangulate the VO feature matches
to sparse 3D points, project them into each frame for sparse pose-consistent
depths, and robustly fit a per-frame scale and shift mapping the dense predicted
depth onto them before fusion.

The numeric core of that alignment is done and tested: `pose/scale_align.py`'s
`fit_scale_shift` is a deterministic, seed-free robust fit (Theil-Sen seed plus a
least-squares refit on inliers) that recovers a known scale and shift and rejects
a fifth of the points as gross outliers. Remaining: the triangulation of VO
matches into sparse depths, and the backend that ties alignment to TSDF fusion.

[murre]: https://arxiv.org/abs/2503.14483

Each phase is independently shippable and none of them touch the fusion contract.
