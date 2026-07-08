# @monoclejs/core

Environment-neutral heart of the MONOCLE scanning suite. No DOM or Node APIs, so
it runs unchanged in an Electron renderer, a web worker, or a Node process.

## What it provides

- **Frame model** (`Frame<TImage>`): the packet that flows through the pipeline,
  generic over its image payload so the renderer can use `ImageBitmap` while a
  headless context uses a buffer or file path.
- **Geometry containers** (`Mesh`, `PointCloud`): the single representation that
  fusion backends produce and `@monoclejs/mesh-io` serializes.
- **Pipeline stages** (`PoseEstimator`, `GeometryStage`, `FusionVolume`,
  `Mesher`): the five-stage contract every scanning method plugs into.
- **`ScanEngine`**: backend-agnostic control flow from a stream of frames to a
  mesh, with a typed event stream for progress and errors.
- **Math** (`mat4`, `vec3`): the small linear-algebra surface the stages share.

## Design rule

Build the engine once. A scanning method (markerless depth, marker mat,
turntable) is a set of backends slotted into `ScanEngine`, never a fork of the
control flow.

```ts
import { ScanEngine } from '@monoclejs/core'

const engine = new ScanEngine({ pose, geometry, fusion, mesher })
engine.on('progress', ({ integrated }) => report(integrated))
const mesh = await engine.run(frameStream)
```

## Scripts

- `pnpm build` bundles ESM, CJS, and type declarations with tsup.
- `pnpm test` runs the Vitest suite.
- `pnpm typecheck` type-checks without emitting.
