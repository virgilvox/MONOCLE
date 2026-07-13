# MONOCLE handoff

State of the project for a fresh session or a new contributor. Pair this with
[architecture.md](architecture.md), [roadmap.md](roadmap.md), and
[BUILD.md](BUILD.md). Read [CLAUDE.md](../CLAUDE.md) first: it is the rulebook
(no emojis-as-icons, no emdashes, no AI-cliche language or design, smart
separation of concerns, tested code, and never credit AI in commits).

## What it is

Webcam-first 3D scanning suite. One ordinary webcam in, a printable mesh out. No
depth sensor, no markers required, everything on-device. The core experience is
markerless monocular depth (Depth Anything V2) for a single-view mesh, a
multi-view path (Depth Anything 3 + Open3D TSDF fusion), and a live in-renderer
depth preview. Color capture, a real 3D viewport, and export to STL/PLY/GLB/3MF.

## Status

Working and actively developed on Apple Silicon (macOS). Milestones M0 through
M2, an audit-hardening pass, the centralized design system and optics identity,
the bundled interpreter, and a first pass at live reconstruction are all on
`main`.

Signed and notarized installers publish from CI on a `v*.*.*` tag: macOS `.dmg`
and `.zip` (arm64 and Intel), a Windows NSIS installer, and Linux AppImage (x64
and arm64). Each carries the bundled interpreter (~1.2 GB where torch/DA3 bundle;
the lean walk-only fallback is ~305 MB). The macOS bundle runs on macOS 11+: it
ships the OpenBLAS build of numpy/scipy, not the Accelerate build pip would
otherwise pick on the macos-14 runner (which needs macOS 14+ and crashes on
import below it); a release step verifies this before publishing.

Runtime-validated on this machine:

- Depth Anything V2 single-view depth to a colored mesh (real ONNX inference).
- Open3D TSDF fusion and the export matrix (STL, colored PLY, GLB, 3MF).
- Depth Anything 3 multi-view reconstruction (CPU, a few tens of seconds).
- The Depth Anything V2 walk-around backend and the live-reconstruction engine
  (DA2 depth + ORB visual odometry + TSDF) run end to end and now fuse to a
  scale-consistent surface: one disparity-to-depth affine is calibrated from the
  first parallax pair and frozen, and each camera baseline is derived from that
  metric depth (`pose/metric_scale.py`). Geometry is still experimental: monocular
  pose has no loop closure so it drifts over a long path, and the absolute scale
  is arbitrary. The earlier garbling (per-frame depth renormalization plus a
  fabricated VO baseline) is fixed; see AUDIT.md.
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

Monorepo (pnpm workspaces + Turborepo + Changesets), scope `@monoclejs`.

```
apps/desktop/      Electron (main/preload/renderer) + Vue 3 app
packages/core/     engine types, five-stage pipeline, math (env-neutral)
packages/mesh-io/  STL / PLY / OBJ serializers
packages/protocol/ JSON-RPC framing + the sidecar contract
sidecar/           Python inference: depth, fusion, meshing, export
scripts/           signed build; (screenshots + model fetch live under apps/desktop)
docs/              architecture, roadmap, build, screenshots, this handoff
```

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
  Open3D TSDF (`backends/walkaround.py`, reusing the `live.py` engine).
  Experimental: pose is up to scale and drifts. Needs the `depth` extra plus
  Open3D from `reconstruct`. Far faster than DA3 on CPU.
- `depth-anything-3` - multi-view transformer, higher quality but slow on CPU.
  Selectable in Advanced. Checkpoint size (base/large/giant) picks the model;
  base is Apache-2.0, large/giant are CC-BY-NC.

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
electron-vite dev`. Smoothing this in dev is an open task.
- Brand assets: `pnpm --filter @monoclejs/desktop render:brand` regenerates the
  app icon (`apps/desktop/build/icon.png`) and the README lockup (`docs/logo.png`)
  from the mesh mark with headless chromium.

## Testing, CI, release

- `pnpm typecheck` / `pnpm test` / `pnpm exec prettier --check .` across the
  workspace; sidecar tests via `cd sidecar && .venv/bin/python -m pytest tests`.
- `.github/workflows/ci.yml` runs typecheck/test/format/build on push and PR.
- `.github/workflows/release.yml` builds installers for macOS (arm64 + Intel),
  Windows, and Linux AppImage (x64 + arm64) on a `v*.*.*` tag; code-signing
  secrets and the full list are in [BUILD.md](BUILD.md). Linux is AppImage only
  (deb is dropped, see BUILD.md), Linux runners free ~20 GB before building, and
  a macOS step blocks the publish if the bundled numpy links Accelerate.
- Screenshots: `pnpm --filter @monoclejs/desktop screenshots` drives the built
  app with Playwright-Electron (fake camera + synthetic reconstruction).

## Known issues

Ranked in [AUDIT.md](AUDIT.md) (functional) and [UX-AUDIT.md](UX-AUDIT.md)
(design). Most of the earlier headline items are now fixed (see AUDIT.md): the
sidecar interpreter is bundled (`bundle:python`), M7 multi-view color, the
live-depth worker auto-restart, the two supervisor restart races, an `app://`
path traversal, the scan-reset and empty-mesh bugs, and the garbled walk-around
geometry (see the resolved blocker in AUDIT.md). The bundle now carries Open3D
and the Depth Anything 3 stack via the default `walk,multiview` extras, plus the
DA2 ONNX (~94 MB) and DA3-BASE weights (~517 MB), so both the default Object scan
and the multi-view path reconstruct in a shipped build fully offline. It is a
large build (torch and the DA3 stack, several GB); `--extras walk` produces a
lean DA2-only bundle. Development prefers the full dev venv so heavy backends run
without a `MONOCLE_PYTHON` override.

Remaining, from the latest adversarial audit and earlier ranked lists:

- Walk-around pose drifts (no loop closure), and its scale is arbitrary; a full
  orbit does not close. See Next focus and [SLAM.md](SLAM.md).
- The live-depth worker assumes the model's depth output resolution equals the
  square input edge (true for DA2/DA3 today); a future export at a different
  resolution would misalign silently. Size the buffer from the reported
  width/height if that ever changes.
- Minor live-depth range robustness: invalid pixels use 0 as a "far" sentinel,
  which can nudge the auto-range low; a percentile-based normalization would be
  steadier than raw min/max if pulsing appears.
- The preset/backend frame-count nuance, validating COOP/COEP on a no-WebGPU
  target, and honest labels on the unused `core`/`mesh-io` packages.

## Next focus

The design system and identity landed (see DESIGN.md; the driving audit is
UX-AUDIT.md). The open threads now are reconstruction quality and packaging:

- Reduce walk-around drift. The sparse-point scale alignment is now wired in
  (`pose/metric_scale.py` freezes one depth affine and derives VO baselines from
  it), so scans fuse coherently instead of garbling. What remains for the "watch
  it form" experience is drift: VO has no loop closure, so a full orbit does not
  close. The next step is a loop-closing tracker behind the same pose seam (see
  [SLAM.md](SLAM.md)), or periodic re-calibration of the depth affine so it
  tolerates the model's affine wandering over a long path.
- The multi-GB `walk,multiview` bundle now builds and publishes on macOS and
  Windows; on arm64 Linux a heavy multiview dep (pycolmap) has no wheel, so that
  platform ships the lean `walk` build via the best-effort install. Widening
  multiview to every platform (or committing to walk-only on Linux) is the open
  packaging decision. The default Object scan only needs `walk`.
- The smaller ranked items in AUDIT.md.
