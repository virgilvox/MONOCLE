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

- **Multi-view color is dropped on nearly every real scan (M7). Fixed.**
  `multiview.py` now resizes the RGB frame to the DA3 depth resolution
  (`_resize_rgb`) instead of dropping color when the two differ, so `object-scan`
  keeps its color. Covered by `tests/test_multiview_color.py`.
- **Live-depth worker has no auto-restart. Fixed.** `useLiveDepth.ts` now does a
  bounded auto-restart with backoff after a worker crash or a recoverable device
  loss, resetting the budget on a clean load, so a transient WebGPU device loss
  recovers on its own instead of leaving the tab dead.
- **Live-depth is broken off WebGPU. Partly fixed.** An fp32 model is now
  fetched and the worker selects it (with the wasm EP) when WebGPU is absent, so
  the no-WebGPU path runs full precision rather than the weak wasm fp16. COOP/COEP
  headers are still not enabled: turning them on broke WebGPU device acquisition
  in the depth worker (forcing the failing wasm path), and they only help the
  no-WebGPU case, so they need validation on such a target first (see window.ts).

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

- Fixed: the viewer built the full point cloud on every load even in shaded mode
  (M6); it is now built lazily on the first switch to Points.
- Fixed: `LiveDepthView` ran its render loop while hidden; it now gates on the
  active flag and stops when the tab is not showing.
- Fixed: the live model reloaded and recompiled the ONNX session on every visit
  to the Live tab; the worker is now kept warm across `active` toggles.
- Fixed: `LiveDepthView` now has `webglcontextlost`/`restored` handling (L1).
- Preset/backend frame mismatch: `object-scan` targets 48 frames but the backend
  caps at 40, and capture never auto-stops at the target for multi-view; the HUD
  guides past what the backend uses.
- Fixed: the stage view now returns to Camera when a new scan starts, and a new
  scan clears the previous reconstruction instead of leaving it in the preview.
- The installer bundles about 125 MB of live-depth model into every platform,
  including ones where the preview may not run (now plus the fp32 model).

## Also fixed in the latest hardening pass

- Two `SidecarSupervisor` restart races: a deliberately-killed child kept its
  lifecycle listeners and could tear down its healthy replacement, and
  `scheduleRestart` could stack two timers and double-spawn. Both fixed, with a
  regression test (`sidecar.test.ts`).
- `app://` path traversal: a crafted URL could read arbitrary local files; the
  handler now rejects any path that escapes the renderer root.
- Multi-view fusion now errors on an empty mesh instead of exporting it as a
  successful reconstruction; `engine.progress` resets between runs; and a scan
  that ends mid-encode no longer stages to a closed session.

## Top things to address next

1. Preset/backend frame-count mismatch for `object-scan` (target 48 vs cap 40).
2. Validate COOP/COEP on a real no-WebGPU target so wasm threading can be enabled
   without regressing the WebGPU path.
3. Unit-test `useKeyframeGate`; add a weights-free DA3 contract test.
