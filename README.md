# MONOCLE

Webcam-first 3D scanning suite. One ordinary webcam in, a printable mesh out. No
depth sensor, no markers required, everything on-device.

The core experience is markerless: walk a webcam through a space or around an
object and MONOCLE tracks pose and recovers geometry using monocular depth and
feed-forward multi-view models. Marker-mat and turntable methods are planned as
additional inputs to the same engine. STL is a first-class output because 3D
printing is the point.

## Status

Foundation, running shell, and a working reconstruction pipeline. The monorepo,
the three core libraries, the Electron + Vue app with live capture, and the
supervised inference sidecar are in place and tested. Reconstruction runs end to
end today through a dependency-free synthetic backend: pick a backend, watch
progress, and save an STL, verified against the real spawned sidecar across the
language boundary. Frame staging and the real monocular-depth (Depth Anything V2)
and multi-view (Depth Anything 3) backends plus Open3D TSDF fusion are
implemented behind optional extras; they need the extras and model weights
installed to validate at runtime (see [docs/roadmap.md](docs/roadmap.md)).

## Layout

```
apps/
  desktop/          Electron + Vue 3 app, supervises the sidecar
packages/
  core/             @monoclejs/core     engine types, pipeline stages, math
  mesh-io/          @monoclejs/mesh-io  STL / PLY / OBJ serializers
  protocol/         @monoclejs/protocol JSON-RPC framing + sidecar contract
configs/
  tsconfig/         shared TypeScript config
sidecar/            Python inference process (depth, fusion, meshing)
docs/               architecture and roadmap
```

The `packages/*` libraries are published to npm independently under the
`@monoclejs` scope; each is useful on its own. The desktop app is private.

## Quick start

Prerequisites: Node 22.12+, pnpm 10+, Python 3.11+ (only for the sidecar).

```
pnpm install
pnpm build          # build the libraries
pnpm test           # run every library test suite
pnpm dev:desktop    # launch the app with hot reload
```

The app starts and previews the webcam without the sidecar. To run inference
later, install the sidecar extras (see [sidecar/README.md](sidecar/README.md)).

## Architecture in one paragraph

A single five-stage engine (capture, pose, geometry, fusion, meshing) lives in
`@monoclejs/core`. Each scanning method is a set of backends slotted into that
engine, never a fork of the control flow. Light inference (live monocular depth
preview) runs in the renderer via WebGPU with a WebGL2 floor; heavy inference
(multi-view reconstruction, TSDF fusion) runs in a supervised Python sidecar over
JSON-RPC. Full detail in [docs/architecture.md](docs/architecture.md).

## Development

- `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint` run across the
  workspace through Turborepo.
- `pnpm changeset` records a version bump for the publishable packages.
- Contribution rules, including no AI attribution in commits, are in
  [CLAUDE.md](CLAUDE.md).

## Licensing

Code is MIT. Model weights carry their own licenses, which differ from the code
and from each other. The sidecar records each backend's weight license and a
commercial-use flag so a shippable build can exclude non-commercial weights.
Re-check any weight license at the version you pin.
