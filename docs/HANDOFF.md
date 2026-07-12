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
M2 plus an audit-hardening pass are done and pushed to `main`.

Runtime-validated on this machine:

- Depth Anything V2 single-view depth to a colored mesh (real ONNX inference).
- Open3D TSDF fusion and the export matrix (STL, colored PLY, GLB, 3MF).
- Depth Anything 3 multi-view reconstruction (CPU, a few tens of seconds).
- Live depth preview (onnxruntime-web WebGPU in a Web Worker), in dev and in a
  packaged-style build via the `app://` scheme.

Not yet done: a polished, coherent UI/UX and design system (the next focus, see
below), a self-contained installer that bundles the Python sidecar, and the
deferred audit items in roadmap Known issues.

## Run it

Prerequisites: Node 22.12+, pnpm 10+, Python 3.11+ (3.12 for the sidecar extras).

```
pnpm install
pnpm build
pnpm --filter @monoclejs/desktop fetch:models   # live-depth model (optional)
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

Declared in `sidecar/monocle_sidecar/models.toml`, chosen by scan preset:

- `synthetic` - writes a known sphere, no camera or model. Pipeline smoke test.
- `depth-anything-v2-small` - Apache-2.0, `depth` extra. Single-view depth mesh.
- `depth-anything-3` - default checkpoint DA3-BASE (Apache-2.0); LARGE/GIANT are
  CC-BY-NC and opt-in via `MONOCLE_DA3_CKPT`. Multi-view fusion.

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

## Testing, CI, release

- `pnpm typecheck` / `pnpm test` / `pnpm exec prettier --check .` across the
  workspace; sidecar tests via `cd sidecar && .venv/bin/python -m pytest tests`.
- `.github/workflows/ci.yml` runs typecheck/test/format/build on push and PR.
- `.github/workflows/release.yml` builds installers for macOS (arm64 + Intel),
  Linux (x64 + arm64), and Windows on a `v*.*.*` tag; code-signing secrets and
  the full list are in [BUILD.md](BUILD.md).
- Screenshots: `pnpm --filter @monoclejs/desktop screenshots` drives the built
  app with Playwright-Electron (fake camera + synthetic reconstruction).

## Known issues

Ranked in [AUDIT.md](AUDIT.md) (functional) and [UX-AUDIT.md](UX-AUDIT.md)
(design). The one to know first: the installer ships the sidecar as source, not a
bundled interpreter, so a shipped build cannot reconstruct a real scan yet (only
the synthetic sphere and the live-depth preview work without a local venv). Other
headline items: multi-view color dropped on resolution mismatch (M7), live-depth
broken off WebGPU and no worker auto-restart, and the TS `core`/`mesh-io`
packages being unused by the app.

## Immediate next focus: UI/UX and design system

The functionality is broad and working, but the interface is a generic dark
dashboard without a centralized theme or a distinctive point of view. The next
effort is a coherent design system and a considered visual identity fitting a
precision optics instrument (the name is MONOCLE), modern and characterful but
highly readable, and explicitly not the cliche AI-app aesthetic (no
purple/neon gradients, glassmorphism-by-default, or emoji icons). A UI/UX audit
and a redesign brief accompany this handoff (see docs/UX-AUDIT.md and the
redesign kickoff prompt).
