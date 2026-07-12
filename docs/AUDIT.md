# MONOCLE functional and product audit

Ranked findings from a deep audit of the product and code (2026-07). The design
audit is separate, in [UX-AUDIT.md](UX-AUDIT.md). Previously fixed items (the
app:// scheme, stdout redirect, reconstruct timeout, supervisor kill, path
guards, worker teardown, sRGB color, adaptive keyframe gate, guarded mesh parse)
are confirmed in place and not repeated here.

## Blocker (resolved)

- **Shipped installer cannot reconstruct.** Fixed. `scripts/bundle-python.mjs`
  bundles a relocatable python-build-standalone interpreter with the sidecar and
  its `depth` extra installed, wired into `extraResources`, and `main/python.ts`
  now prefers it (after a `MONOCLE_PYTHON` override, before the dev venv and
  system fallback). Verified on macOS arm64: the bundled interpreter answers the
  health handshake ready over JSON-RPC. Bundling the heavier `reconstruct`
  extra (Open3D + torch for multi-view) is opt-in via `--extras`. See
  [BUILD.md](BUILD.md).

## High

- **Multi-view color is dropped on nearly every real scan (M7).** In
  `multiview.py`, color is kept only when the source frame resolution equals the
  DA3 depth resolution, which it almost never does, so `object-scan` (sold as
  "more detail and color") outputs geometry only, silently. Fix: resize RGB to
  the depth resolution before building the posed frame instead of dropping color.
- **Live-depth worker has no auto-restart.** `useLiveDepth.ts` tears down on
  `worker.onerror` (correct) but only recovers when `active`/`stream`/`quality`
  change. A transient WebGPU device-loss mid-session leaves the tab dead until
  the user toggles tabs. Fix: a bounded auto-restart with backoff, like the
  sidecar supervisor.
- **Live-depth is broken off WebGPU.** Only the fp16 model is bundled, and the
  onnxruntime-web wasm EP has weak fp16 support, so the wasm fallback likely
  fails rather than degrading; and no COOP/COEP headers are set, so
  `crossOriginIsolated` is false and the threaded wasm runs single-threaded. This
  contradicts the Linux/Pi positioning. Fix: ship an fp32 model for the wasm path
  and add COOP/COEP to the production headers.

## Medium

- **`@monoclejs/core` and `@monoclejs/mesh-io` are dead code relative to the
  product.** The app imports only `Emitter` from core and nothing from mesh-io;
  all real reconstruction and serialization happen in the Python sidecar. The
  documented five-stage TS engine is a paper architecture the product routes
  around. Decide: wire them in, or demote them to clearly separate publishable
  libraries and stop implying they are the app engine.
- **Test effort is inverted.** The desktop app has one test (session manager).
  The concurrency-heavy `SidecarSupervisor` (restart backoff, reconstruct
  timeout, kill grace, launch-racing-restart) and the pure, core-UX
  `useKeyframeGate` are untested; `vitest.config.ts` uses the node environment
  with no jsdom, so composable/component tests are not bootstrapped. Meanwhile the
  well-tested `core`/`mesh-io` are the code the product does not run, and the DA3
  happy path is never exercised in CI (importorskip). Fix: unit-test the
  supervisor with a fake child and the keyframe gate; add a weights-free DA3
  contract test.
- **Cross-platform Python resolution is fragile.** `resolvePython` falls back to
  bare `python`/`python3` with no version or capability check; on Windows this is
  often the wrong or absent interpreter, producing an opaque "sidecar failed to
  start". The bundled-interpreter fix removes this; short of that, probe the
  version and surface a specific setup message.

## Low

- Viewer rebuilds the full point cloud on every load even in shaded mode (M6);
  build it lazily on first switch to points.
- `LiveDepthView` runs its render loop continuously while hidden (mounted with
  `v-show`); gate on visibility.
- The live model reloads and recompiles the ONNX session on every visit to the
  Live tab; keep the worker warm across `active` toggles.
- `LiveDepthView` lacks `webglcontextlost`/`restored` handling that `MeshViewer`
  has (L1).
- Preset/backend frame mismatch: `object-scan` targets 48 frames but the backend
  caps at 40, and capture never auto-stops at the target for multi-view; the HUD
  guides past what the backend uses.
- The stage view stays on Preview when a new scan starts instead of returning to
  Camera.
- The installer bundles about 125 MB of live-depth model into every platform,
  including ones where the preview may not run.

## Top things to address next

1. Done: the Python interpreter and the `depth` extra are bundled so a shipped
   build can reconstruct (see the resolved blocker above).
2. Fix multi-view color (resize RGB to depth instead of dropping it).
3. Ship an fp32 live-depth model and add COOP/COEP so the preview works off
   WebGPU.
4. Auto-restart the live-depth worker on crash.
5. Test the code that can break (supervisor races, keyframe gate) and add a
   weights-free DA3 contract test; decide the fate of the unused TS packages.
