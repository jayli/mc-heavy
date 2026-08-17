# Task 9 Report: Three.js Render Adapter, Pages, LOD, and Water

## Status

Implemented the section-local Three.js render resource layer with asynchronous WebGPU/WebGL2 backend creation, monotonic page replacement, explicit GPU-resource lifetimes, frustum submission, finite camera-following terrain rings, and a single camera-following water surface.

## RED

The first focused run was:

```text
npm run test:unit -- tests/unit/render/render-page.test.ts tests/unit/render/terrain-lod.test.ts tests/integration/render/renderer-fallback.test.ts
```

It failed in all three suites because `render-page`, `terrain-lod`, and `renderer-adapter` did not exist. This established the requested missing-module RED before production files were created.

Independent review later identified four runtime contract gaps. New regressions failed for each gap before the fixes:

- the atlas material shader graph did not consume `blockId`;
- terrain LOD and water were absent from renderer submission;
- shared material/atlas resources lacked adapter teardown;
- the adapter reported the selected backend rather than the backend obtained after asynchronous initialization.

## GREEN

The focused command passes 10 tests total: 7 across the two unit files and 3 in the fallback integration file.

Key behavior covered:

- older and equal `sourceVersion` uploads are no-ops;
- replacement builds complete position/normal/UV/`blockId`/index geometry before the scene swap, then disposes the old geometry;
- canonical section keys derive 16-cubed `BlockPos` AABBs, while explicit AABBs are supported;
- repeated disposal is idempotent;
- a shared TSL `MeshBasicNodeMaterial` samples the atlas through the `blockId` attribute;
- pages excluded by the supplied frustum are not submitted;
- a fixed finite set of terrain ring geometries follows the camera without recreation;
- water keeps one geometry while position and time-driven material state update;
- LOD and water objects participate in the adapter scene/submission path;
- WebGL2-only canvas selection passes the exact canvas context to the renderer factory;
- asynchronous WebGPU initialization propagates the actual initialized backend;
- adapter teardown disposes page geometry, the shared material, and atlas texture exactly once.

## Implementation

- `RenderPage` owns only section-local render resources, not voxel truth. It uses a narrow scene target for synchronous object swaps and compares only `OpaqueMesh.sourceVersion`.
- `materials.ts` maintains a ref-counted shared material/atlas lease. The TSL node graph reads the per-vertex `blockId`; WebGL2 installs Three r184's `WebGLNodesHandler` so the same node material works through `WebGLRenderer`.
- `RendererAdapter.create` checks real browser capabilities. WebGPU uses `three/webgpu`, constructs `WebGPURenderer`, and awaits `init()`. WebGL2 uses the context returned by the supplied canvas and constructs `THREE.WebGLRenderer`. Unsupported environments reject clearly.
- The initialized renderer driver reports its actual backend, including a Three-internal WebGPU-to-WebGL2 fallback.
- `TerrainLod` owns four fixed ring geometries. `WaterSurface` owns one plane geometry. Neither creates chunk sections or block instances.
- No global `InstancedMesh`, per-block instance/material, face-culling system, consolidation timer, region, or bounds subsystem was introduced.
- Added `@types/three` 0.184.1 to typecheck Three 0.184.0, including `three/webgpu` and the WebGL node handler APIs.

## Verification

Completed verification before report creation:

```text
npm run test:unit
17 test files passed, 79 tests passed

npm run build
tsc --noEmit passed; Vite production build passed

npm run lint
ESLint passed

git diff --check
passed
```

Also confirmed at runtime that `three/webgpu` exports `WebGPURenderer` as a constructor function. An independent re-review marked all four prior Important findings addressed and reported no new Critical or Important findings.

## Remaining Concern

The automated fallback test uses the permitted narrow renderer factory because Vitest has no GPU context. The real Three WebGL/WebGPU constructors and r184 APIs are typechecked, and the WebGPU module export is runtime-checked, but a live Chrome-on-macOS GPU smoke test remains a runtime integration step for the application bootstrap task.

## Main Review Fix Round 1: WebGPU Normal Layout

Main review found that a normalized `Int8BufferAttribute` with `itemSize = 3` is not a valid Three r184 WebGPU vertex-buffer layout. The mesher emits tightly packed `Int8Array` xyz normals using values `-1`, `0`, and `1`. Three's `WebGPUAttributeUtils` pads the corresponding vertex format to `snorm8x4` but computes an array stride of three bytes; WebGPU requires the four-byte format and stride alignment to agree. Normalizing the mesher's value `1` would also produce approximately `1 / 127`, not the intended unit component.

The regression imports Three r184's real WebGPU attribute utility and probes the actual RenderPage normal attribute. Before the fix it failed because the uploaded attribute remained an `Int8Array`; the equivalent utility probe for that old attribute yields `snorm8x4` with `arrayStride: 3`.

The minimal fix keeps `OpaqueMesh.normals` and the worker wire format as `Int8Array`, then converts to a non-normalized `Float32BufferAttribute` only inside `RenderPage` geometry creation. The GREEN probe now observes the original xyz values, `float32x3`, and `arrayStride: 12`.

Focused RED/GREEN command:

```text
npm run test:unit -- tests/unit/render/render-page.test.ts
RED: 1 failed / 5 passed because normal.array was Int8Array
GREEN: 6 passed
```

Post-fix verification:

```text
focused render tests: 4 files passed, 14 tests passed
full Vitest suite: 17 files passed, 80 tests passed
tsc + Vite build: passed
ESLint: passed
git diff --check: passed
independent fix review: approved with no Critical or Important findings
```
