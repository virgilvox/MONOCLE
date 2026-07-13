# MONOCLE sidecar

The inference process the desktop app supervises. It speaks JSON-RPC 2.0 over
stdio using the same Content-Length framing as `@monoclejs/protocol`, so the app
and sidecar share one contract.

## Design

- **Dependency-free core.** `health` and `listBackends` run on a bare Python
  3.11+ interpreter, so the app can start the engine and show available backends
  before any model is downloaded.
- **Swappable backends.** `models.toml` declares each backend's metadata and the
  module to lazy-import. A new model is a new file in `backends/` plus a toml
  entry, never a change to the server.
- **License-aware.** Each backend records the weight license and a
  `commercial_use` flag, so a shippable build can exclude non-commercial weights.

## Layout

```
monocle_sidecar/
  __main__.py        serve over stdio
  rpc.py             framing + JSON-RPC dispatch
  server.py          method wiring (health, listBackends, reconstruct, cancel)
  registry.py        loads models.toml, lazy-imports backends
  backends/
    base.py          the Backend interface (+ require_mesh_output guard)
    depth_anything_v2.py
    multiview.py     Depth Anything 3: inference, device, mesh fusion
    da3_outputs.py   native DA3 exports (point cloud, COLMAP, Gaussian splat)
  fusion/
    tsdf.py          posed depth -> mesh (Open3D)
  models.toml        backend registry
```

## Running

Health and listing need nothing extra:

```
python3 -m monocle_sidecar   # then speak framed JSON-RPC on stdin
```

The heavy paths need their extras:

```
pip install -e '.[depth]'        # onnxruntime monocular depth
pip install -e '.[reconstruct]'  # torch (MPS) + Open3D fusion
pip install -e '.[color-print]'  # optional lib3mf for colored 3MF export
pip install -e '.[dev]' && pytest
```

For distribution, build a one-directory bundle (PyInstaller or Nuitka) so torch
and Open3D dylibs stay signed in place rather than re-extracting on each launch.
`uv` is the recommended dev workflow once available on the machine.

## Reconstruction outputs and device

`reconstruct` reads two optional `ReconstructParams` fields beyond the mesh
defaults:

- `output` picks the product. `mesh` (the default) fuses depth into a watertight
  TSDF surface and writes the STL/PLY/GLB/OBJ/USDZ matrix, adding a colored 3MF
  when the optional `color-print` extra (lib3mf) is installed. `pointCloud`,
  `colmap`, and `gaussian` are the native Depth Anything 3 exports and run only on
  the `depth-anything-3` backend: a colored point cloud plus camera poses (GLB), a
  COLMAP sparse model, or a 3D Gaussian splat PLY. Every other backend produces a
  mesh only and rejects a non-mesh `output` with a clear error. `gaussian` needs a
  Gaussian-capable checkpoint (`giant` or nested-giant); requesting it against
  BASE or LARGE fails before inference.
- `device` (`auto`|`cpu`|`mps`|`cuda`) forces the heavy-path compute device,
  overriding the backend's configured device. `auto` picks CUDA, then Apple MPS,
  then CPU. An explicit accelerator that is unavailable logs a warning and falls
  back to the best available device rather than failing.
