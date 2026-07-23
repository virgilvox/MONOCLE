# MONOCLE handoff

State of the project for a fresh session or a new contributor. Pair this with
[architecture.md](architecture.md), [roadmap.md](roadmap.md), and
[BUILD.md](BUILD.md). Read [CLAUDE.md](../CLAUDE.md) first: it is the rulebook
(no emojis-as-icons, no emdashes, no AI-cliche language or design, smart
separation of concerns, tested code, and never credit AI in commits).

## What it is

Webcam-first 3D scanning suite. One ordinary webcam in, a printable mesh out. No
depth sensor, no markers required, everything on-device. The default Object scan
is a markerless monocular walk-around (Depth Anything V2 depth + ORB visual
odometry + Open3D TSDF fusion); a single sharp frame gives a quick 2.5D mesh, and
Depth Anything 3 is an optional higher-quality multi-view model. Plus a live
in-renderer depth preview, color capture, a real 3D viewport, and export to
STL/PLY/GLB/OBJ/USDZ/3MF.

## Status

Working and actively developed on Apple Silicon (macOS 12.7.4 / M1). Milestones
M0 through M2, an audit-hardening pass, the design system, the bundled
interpreter, live reconstruction, and the v1.x release line are all on `main`.

Released: **v1.1.0** (latest). The v1.0.x line fixed three separate ways the
shipped app broke on the macOS 11-13 support floor, each because CI builds on the
macos-14 runner where every wheel imports fine (so the old import-based gate was
blind): live-depth COOP/COEP broke WebGPU device acquisition (v1.0.1); onnxruntime
1.27 needed a macOS-14 libc++ symbol (v1.0.1 pinned `<1.20`); opencv 4.11+/5.0
ship macosx_13 arm64 wheels with an ffmpeg that references a macOS-13 AVFoundation
symbol (v1.0.3 pinned `>=4.10,<4.11`). The cure is a build-host-independent
release gate that scans every bundled wheel's own macOS platform tag and fails if
any required wheel targets macosx_13+ (the torch/DA3 stack is allow-listed since
it is macOS-14+ anyway). It caught v1.0.2 before publish. The gate lives in the
"Verify the bundled interpreter" step of `release.yml`.

Signed and notarized installers publish from CI on a `v*.*.*` tag: macOS `.dmg`
and `.zip` (arm64 and Intel), a Windows NSIS installer, and Linux AppImage (x64
and arm64). As of v1.1.0 **every platform ships the lean `walk` bundle** (DA2 +
Open3D, no torch): the macOS arm64 installer is ~680 MB, down from ~2.6 GB. The
heavy Depth Anything 3 stack (torch + DA3-BASE weights, ~3 GB) is no longer
bundled; the app downloads it on demand into user app-data (see the DA3 pack
below). The macOS bundle runs on macOS 12+: it ships the OpenBLAS build of
numpy/scipy (not the macOS-14-only Accelerate build), verified by a release step.
The mac entitlements enable `disable-library-validation` so the signed interpreter
can dlopen the runtime-installed DA3 pack.

Runtime-validated on this machine:

- Depth Anything V2 single-view depth to a colored mesh (real ONNX inference).
- Open3D TSDF fusion and the export matrix (STL, colored PLY, GLB, 3MF).
- The Depth Anything V2 walk-around (the DEFAULT Object scan) fuses a real
  capture into a bounded single body. The default path is the greedy
  `live.py::LiveWalkFusion` engine: one disparity-to-depth affine calibrated from
  the first placed pair and frozen, each frame tracked against the last placed
  frame, every baseline derived from metric depth (`pose/metric_scale.py`), and
  nothing integrated on a tracking failure. Proven on a real 50-frame capture:
  a 0.867 m single connected body (measured in-memory; see the mm/STL gotcha in
  Environment notes). Still monocular, so absolute scale is arbitrary and a long
  orbit drifts (no loop closure).
- Depth Anything 3 multi-view runs on CPU in a dev venv (slow, a few tens of
  seconds to minutes) but is NOT usable on this macOS 12 box in a shipped build:
  it needs torch, whose arm64-macOS wheels are macOS 14+, so it is the on-demand
  pack and is unavailable here. It stays a selectable model in Advanced.
- Live depth preview (onnxruntime-web WebGPU in a Web Worker), in dev and in a
  packaged-style build via the `app://` scheme. A picker switches between Depth
  Anything V2 (default, the better single-frame model) and Depth Anything 3.
  DA3's metric depth is converted to capped disparity so it reads with contrast
  comparable to DA2 rather than a flat linear ramp.
- A relocatable bundled interpreter answers the health handshake over JSON-RPC.

Two packaged-build live-depth bugs were fixed this pass: under the `app://`
scheme a missing file rejects rather than returning 404, so the worker only
fetches a model's external-data sibling when the config declares one (the DA2
fp32 wasm fallback has none); and `package`/`package:bundled` now run
`fetch:models`, so a locally built installer no longer ships an empty models
directory. The UI also gained engine-failure recovery on the primary surface, a
WebGL-unavailable fallback in the viewer, elapsed/ETA on long reconstructions,
and keyboard/aria wiring on the tabs, camera select, and viewer.

Done since the early milestones: the design system and optics identity (now a
mesh mark, MONO/CLE wordmark, light optical-blue accent; see DESIGN.md), the
bundled interpreter, a depth-model picker with DA3 sizes, and most of the ranked
audit fixes. See Known issues below for what remains.

## Run it

Prerequisites: Node 22.12+, pnpm 10+, Python 3.11+ (3.12 for the sidecar extras).

```
pnpm install
pnpm build
pnpm --filter @monoclejs/desktop fetch:models   # live-depth model (needed for the live preview in dev)
pnpm dev:desktop
```

Sidecar (for real reconstruction):

```
cd sidecar
python3.12 -m venv .venv
.venv/bin/pip install -e '.[depth]'        # onnxruntime monocular depth
.venv/bin/pip install -e '.[reconstruct]'  # torch + Open3D fusion
.venv/bin/pip install -e '.[multiview]'    # Depth Anything 3 runtime deps
.venv/bin/pip install depth-anything-3 --no-deps   # DA3 itself, see note below
```

The app's supervisor prefers `sidecar/.venv` automatically and auto-starts the
engine on launch.

## Architecture

Monorepo (pnpm workspaces + Turborepo), scope `@monoclejs`.

```
apps/desktop/      Electron (main/preload/renderer) + Vue 3 app
packages/protocol/ JSON-RPC framing + the sidecar contract
sidecar/           Python inference: depth, fusion, meshing, export
scripts/           signed build; (screenshots + model fetch live under apps/desktop)
docs/              architecture, roadmap, build, screenshots, this handoff
```

The app's only workspace-library dependency is `@monoclejs/protocol`; all
geometry and serialization run in the sidecar. The unused `core` and `mesh-io`
libraries (a TypeScript five-stage engine and mesh serializers that were never
on the app's scan path) have been removed from the repo. The app's typed event
`Emitter` is a local module at `apps/desktop/src/main/emitter.ts`. The desktop
app versions via git tags; there is no Changesets flow.

Inference is hybrid: light path (live depth preview) runs in the renderer via
onnxruntime-web on WebGPU with a WebGL2 floor; heavy path (multi-view, fusion,
meshing, export) runs in a supervised Python sidecar over JSON-RPC (Content-Length
framing). The app owns the sidecar lifecycle: spawn, health handshake, restart
with backoff, kill on quit, reconstruct timeout, cancel.

## Backends

Declared in `sidecar/monocle_sidecar/models.toml`, chosen by scan preset or the
Advanced "Depth model" picker:

- `synthetic` - writes a known sphere, no camera or model. The pipeline smoke
  test, run from the "Run synthetic test" button under Advanced / Diagnostics.
- `depth-anything-v2-small` - Apache-2.0, `depth` extra. Single-view depth mesh
  (the Quick depth snapshot preset).
- `depth-anything-v2-walk` - the DEFAULT (Object scan preset). A monocular
  walk-around fused from Depth Anything V2 depth + ORB visual-odometry pose +
  Open3D TSDF. `backends/walkaround.py` has two paths: the DEFAULT
  `_reconstruct_live` runs the greedy `live.py::LiveWalkFusion` engine (the
  verified-working reference, commit 90f5cd9), and an OPT-IN `_reconstruct_two_pass`
  runs the loop-closed `pose/orb_pgo.py` estimator (VO chain + loop closure +
  pose-graph optimization). The two-pass is opt-in only, reached when a caller
  injects an estimator (tests) or passes `loopClosure`, because it regressed hard
  on real captures (it decouples calibration from chaining and cascaded to ~1 of
  50 frames placed, exploding the volume). Needs the `depth` extra plus Open3D
  from `reconstruct`.
- `depth-anything-3` - multi-view transformer, higher quality but needs torch and
  is slow on CPU. Selectable in Advanced. Requires the on-demand DA3 pack (below)
  or a dev venv with torch; unavailable on macOS < 14. Checkpoint size
  (base/large/giant) picks the model; base is Apache-2.0, large/giant are CC-BY-NC.

The on-demand **DA3 pack** (`apps/desktop/src/main/da3/`) downloads the multi-view
torch stack + DA3-BASE weights into user app-data (`<userData>/da3`) with the
bundled interpreter's own pip, so wheels match the platform. `support.ts` gates it
to platforms where torch has a wheel (Apple Silicon macOS 14+, x64 Windows, x64
Linux); elsewhere the UI shows a plain reason. `pack.ts` installs, downloads
weights with progress, and exposes `env()` (PYTHONPATH + MONOCLE_DA3_CKPT); the
supervisor takes a per-launch env function and restarts to pick up the pack. UI is
the `Da3PackPanel` in Advanced. Because DA3 does not run on this macOS 12 box, the
adaptive default (`recommendedDefault`) returns the walk-around here.

Live reconstruction (experimental): the "Live reconstruct" toggle on a
multi-view scan streams a mesh that forms as you capture, via the
`liveReconstruct` RPC over the same `live.py` engine.

## Environment notes (important)

- The sidecar venv is Python 3.12, not 3.13: onnxruntime has no macOS 12 wheel
  for 3.13, and this box is macOS 12.7.4 (Darwin 21), so MPS is unavailable
  (needs macOS 14+); DA3 and torch run on CPU here.
- Depth Anything 3 installs with `--no-deps`: its pinned xformers and
  opencv-python do not build here and are not required (xformers falls back to
  pure PyTorch; cv2 comes from opencv-contrib-python). The `multiview` extra
  lists the real runtime deps. A real OpenMP/Open3D segfault was fixed by
  importing Open3D before cv2 in the multiview backend.
- The live-depth model and ort wasm live under
  `apps/desktop/src/renderer/public/models/` (gitignored) and are fetched by
  `pnpm --filter @monoclejs/desktop fetch:models`. The renderer is served from a
  custom `app://` scheme in packaged builds so absolute fetches resolve.
- Running in dev with real reconstruction: the interpreter resolver prefers the
  bundled interpreter (`apps/desktop/resources/python`, `depth` extra only), so
  DA3 and the walk backend (which need Open3D from `reconstruct`) fail under it.
  Point the app at the full venv and bypass Turbo (which strips the env var):
  `MONOCLE_PYTHON=/abs/sidecar/.venv/bin/python pnpm -C apps/desktop exec
electron-vite dev`. In `ps` the venv interpreter shows the framework base path
  (`/Library/Frameworks/Python.framework/.../Python`), not `.venv/bin/python`;
  confirm the venv is active with `lsof -p <pid> | grep sidecar/.venv`. Smoothing
  this in dev is an open task.
- Verifying scan quality (learned the hard way): MEASURE THE IN-MEMORY open3d
  mesh, not the written file. STL/3MF export in MILLIMETERS (GLB/USDZ in meters)
  and STL stores unmerged per-triangle vertices, so reading `meshPath` back shows
  1000x the size, 3x the vertices, and every triangle as its own "component", an
  artifact, not garbage. Also CLEAR the sidecar `__pycache__` between edited runs
  (`find sidecar/monocle_sidecar -name __pycache__ -exec rm -rf {} +`) or a stale
  `.pyc` runs old code. Real captured frames survive under `/private/tmp/
monocle-scan-*/frames` for reproducing a scan without a webcam.
- Brand assets: `pnpm --filter @monoclejs/desktop render:brand` regenerates the
  app icon (`apps/desktop/build/icon.png`) and the README lockup (`docs/logo.png`)
  from the mesh mark with headless chromium.

## Testing, CI, release

- `pnpm typecheck` / `pnpm test` / `pnpm exec prettier --check .` across the
  workspace; sidecar tests via `cd sidecar && .venv/bin/python -m pytest tests`.
- `.github/workflows/ci.yml` runs typecheck/test/format/build on push and PR.
- `.github/workflows/release.yml` builds installers for macOS (arm64 + Intel),
  Windows, and Linux AppImage (x64 + arm64) on a `v*.*.*` tag; code-signing
  secrets and the full list are in [BUILD.md](BUILD.md). Every platform bundles
  the lean `walk` interpreter (`--extras walk`). The "Verify the bundled
  interpreter" step is the release gate: it confirms numpy links OpenBLAS (not
  macOS-14 Accelerate) and scans every bundled wheel's macOS platform tag, failing
  the publish if any required wheel targets macosx_13+ (build-host-independent, so
  it catches what an import test on the macos-14 runner cannot).
- Screenshots: `pnpm --filter @monoclejs/desktop screenshots` drives the built
  app with Playwright-Electron (fake camera + synthetic reconstruction).

## Known issues

Ranked in [AUDIT.md](AUDIT.md) (functional) and [UX-AUDIT.md](UX-AUDIT.md)
(design). Most earlier headline items are fixed: the bundled interpreter, M7
multi-view color, live-depth worker auto-restart, the supervisor restart races,
the `app://` path traversal, the scan-reset and empty-mesh bugs, the macOS 11-13
release breakages (Status above), and the garbled Object scan. The Object-scan
regression is the important recent one: commit 6c66635 had swapped the default
onto the two-pass `orb_pgo` estimator, which garbled real captures; the fix
(commit 77174c9) points the default back at the proven `LiveWalkFusion` and
demotes the two-pass to opt-in. The installer is lean `walk` on every platform
(~680 MB on mac arm64); the DA3 multi-view stack is the on-demand pack, not
bundled.

Remaining, from the latest adversarial audit and earlier ranked lists:

- Walk-around pose drifts (no loop closure), and its scale is arbitrary; a full
  orbit does not close. Loop closure exists (`pose/orb_pgo.py` +
  `loop_closure.py` + `pose_graph.py`) but is opt-in and not yet robust on real
  noisy captures (it decoupled calibration from chaining and cascaded to ~1 frame
  placed). Making it a reliable improvement over the greedy default, rather than a
  regression, is open. See Next focus and [SLAM.md](SLAM.md).
- Depth-camera (Orbbec Astra) support is a pinned future direction: metric depth
  from a real sensor would kill the monocular scale ambiguity that the walk-around
  fights. Blocked mainly on the driver (OpenNI2/Orbbec SDK) on macOS 12 arm64;
  the record-then-import path (drive the camera on Linux, fuse anywhere) is the
  low-risk first step. Exact Astra model still to be identified.
- The live-depth worker assumes the model's depth output resolution equals the
  square input edge (true for DA2/DA3 today); a future export at a different
  resolution would misalign silently. Size the buffer from the reported
  width/height if that ever changes.
- Minor live-depth range robustness: invalid pixels use 0 as a "far" sentinel,
  which can nudge the auto-range low; a percentile-based normalization would be
  steadier than raw min/max if pulsing appears.
- The preset/backend frame-count nuance and validating COOP/COEP on a no-WebGPU
  target. (The `core`/`mesh-io` packaging honesty item is resolved: both
  packages are removed from the repo; see the Architecture note above.)

## Next focus

The design system, the v1.x releases, the macOS-12 fixes, the lean installer, and
the DA3 pack all landed. The open threads now are reconstruction quality and
sensors:

- The default Object scan fuses a coherent body again (greedy `LiveWalkFusion`).
  The next quality step is closing the loop on a full orbit without regressing the
  default: make the opt-in two-pass loop closure a reliable improvement (couple
  its calibration to its chaining the way `live.py` does, or refine the greedy
  poses with a pose graph only when a real revisit is verified), or periodically
  re-calibrate the depth affine over a long path. See [SLAM.md](SLAM.md).
- Depth-camera (Orbbec Astra) as a metric sensor input, the biggest lever for
  killing scale ambiguity. Identify the exact model, prove it streams (macOS 12
  arm64 driver support is the risk), then a record-then-import path first and a
  live path later. It slots in as a capture source + backend feeding the same
  Open3D TSDF, not a fork.
- Verify a real Object scan end to end in the running app (the dev app is
  currently up on the venv sidecar) and cut v1.1.1 once the scan looks right.
- The smaller ranked items in AUDIT.md.
