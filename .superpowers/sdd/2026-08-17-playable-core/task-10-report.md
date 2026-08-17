# Task 10 Report: Player Physics, Inventory, and World-Query Interaction

## Status

Implemented player horizontal collision, deterministic selected-hotbar inventory behavior, and renderer-independent DDA block breaking and placement.

## RED

The initial focused test run was:

```text
npm run test:unit -- tests/unit/gameplay
```

All three suites failed because the requested `inventory`, `player-controller`, and `player-interaction` modules did not exist. This established the missing-module RED before production code was added.

A later collision regression first failed with the player moving from `z: 0.5` to `z: 4.5` through a solid voxel that overlapped only the player's X width. The controller was then corrected to scan the complete cross-axis AABB while sweeping Z.

## Implementation

- `Inventory` validates registry IDs and positive integer counts. It keeps the first available stack selected, returns frozen snapshots, and never changes a stack for an insufficient removal.
- `PlayerController` accepts `WorldQuery` and an initial pose. It moves at a fixed normalized horizontal speed, resolves X then Z swept movement, and exposes a narrow facing setter/getter for gameplay direction.
- `PlayerInteraction` receives an inventory and controller. It uses only `WorldQuery.raycast`, `getBlock`, `isSolid`, and `applyEdits`; it does not read renderer, mesh, page, or instance state.
- Breaking changes a real solid DDA hit to explicit air before adding exactly one matching item. A failed/no hit makes no mutation.
- Placement requires the selected requested material, a unique entered face, an air target, and no player AABB overlap. It decrements exactly one item after the world edit.
- Wood placement quantizes facing `{ x: 0, z: -1 }` to orientation `3`.
- The sparse edit overlay now stores optional orientation metadata. Explicit air always drops that metadata, and `InMemoryWorld.getOrientation` offers a narrow observable read path for behavior tests.

## Coverage

The gameplay tests use real `InMemoryWorld` behavior and hand-written expected values. They cover:

- inventory validation, immutable selected snapshots, and atomic insufficient removal;
- X and Z swept collisions, including full cross-axis player width;
- DDA break/item collection;
- placement on the entered face, unavailable material, player overlap, no hit, and ambiguous DDA normal rejection;
- wood orientation `3` and orientation clearing on break.

## Verification

Fresh verification completed after the final collision fix:

```text
npm run test:unit -- tests/unit/gameplay
3 files passed, 14 tests passed

npm run test:unit
20 files passed, 94 tests passed

npm run build
tsc --noEmit and Vite build passed

npm run lint
ESLint passed

git diff --check
passed
```

An independent code review also approved the change with no Critical or Important findings.

## Remaining Concern

`PlayerController` intentionally supplies only horizontal movement because the task does not define gravity, jumping, or vertical collision. Those behaviors can be layered on the same AABB constants later.

## Review Fix Round 1: Positive-Axis Exact Contact

Review found that the positive X/Z sweep started at `floor(leadingEdge) + 1`. If the player's leading AABB edge was exactly on the next voxel boundary (for example, center `x: 0.7` with half-width `0.3`), this skipped the contacted solid voxel entirely and allowed penetration.

Added real-`InMemoryWorld` RED tests for exact-contact positive X and Z movement. Both failed by moving the player from `0.7` to `4.7`. The positive-axis scan now begins at `floor(leadingEdge + COLLISION_EPSILON)`, making boundary contact inclusive while a player with a real `0.01` gap can still advance to just before the solid face.

Focused RED/GREEN command:

```text
npm run test:unit -- tests/unit/gameplay/player-controller.test.ts
RED: 2 failed / 4 passed
GREEN: 6 passed
```

Post-fix verification:

```text
npm run test:unit -- tests/unit/gameplay
3 files passed, 17 tests passed

npm run test:unit
20 files passed, 97 tests passed

npm run build
tsc --noEmit and Vite build passed

npm run lint
ESLint passed

git diff --check
passed
```
