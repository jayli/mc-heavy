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
