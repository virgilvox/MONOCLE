# @monoclejs/mesh-io

Serializers that turn a `Mesh` or `PointCloud` from `@monoclejs/core` into the
file formats a scanning suite needs. No dependencies beyond core, so it runs in
the renderer, a worker, or Node.

## Formats

| Function              | Output       | Use                                               |
| --------------------- | ------------ | ------------------------------------------------- |
| `stlBinary(mesh)`     | `Uint8Array` | The 3D-printing target. Compact, slicer-ready.    |
| `stlAscii(mesh)`      | `string`     | Human-readable STL for debugging.                 |
| `plyBinary(geometry)` | `Uint8Array` | Meshes and point clouds, with normals and colors. |
| `plyAscii(geometry)`  | `string`     | Readable PLY.                                     |
| `objAscii(mesh)`      | `string`     | Wavefront OBJ for interchange.                    |

```ts
import { stlBinary } from '@monoclejs/mesh-io'

const bytes = stlBinary(mesh)
await writeFile('scan.stl', bytes)
```

STL carries no color, so use PLY when you need to keep per-vertex color from a
capture. Binary encoders return bytes; ASCII encoders return strings.
