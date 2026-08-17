# mc-heavy 高性能可玩核心实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立不依赖预生成的 WebGPU 优先体素世界，并交付可在当前 Mac Chrome 以 8 chunk 半径运行、支持移动和方块交互的首个可玩版本。

**Architecture:** 游戏规则以 TypeScript 纯模块实现；世界真值是确定性生成基底加稀疏编辑覆盖。生成和网格在版本化 Worker 中完成，渲染线程只做预算内的 GPU 提交。Three.js r184 仅作为 WebGPU/WebGL2 渲染适配层。

**Tech Stack:** TypeScript、Vite、Three.js r184、Web Workers、Vitest、Playwright。

## Global Constraints

- 当前 Mac 的最新 Chrome 是性能基准设备；WebGPU 默认画质下，8 个 16×16 chunk 可视半径的 5 分钟持续移动场景须达到 1% low ≥90 FPS（p99 帧时长 ≤11.1 ms）。
- WebGPU 优先，WebGL2 仅保证正确性和可玩性；世界、输入与交互不得依赖任一渲染后端。
- 不得实现 Region 预生成、WorldBounds 扩容、跨 chunk overflow 重路由、全局 block InstancedMesh、独立 FaceCullingSystem 或 Consolidation 定时器。
- 世界真值仅为“确定性生成基底 + 编辑覆盖”；网格、AO、光照、GPU buffer、LOD 和交互加速数据均可丢弃和重建。
- 所有新增行为按 Red → Green → Refactor：先写会因目标生产代码缺失而失败的真实行为测试，运行确认失败，再写最小实现并确认全套相关测试通过。
- 测试期望必须采用手工可验证的字面值或夹具，不得用生产函数计算期望；除浏览器、GPU 和 IndexedDB 边界外不使用 mock。
- `mc-lite` 导入只读旧库；同源直接读取优先，JSON 文件是后备，任何无效/不完整输入都必须报告，绝不伪造成功。

---

## 文件结构

| 路径 | 职责 |
| --- | --- |
| `src/domain/coords.ts` | 负坐标安全的 section/块坐标和块内索引 |
| `src/domain/blocks.ts` | 不依赖渲染器的 block registry 和渲染类别 |
| `src/domain/voxel-section.ts` | 调色板压缩 section 与编辑版本 |
| `src/world/world-query.ts` | 方块读取、批量编辑、DDA 射线和内存世界 |
| `src/world/terrain.ts` | 纯确定性地形和生物群系采样 |
| `src/world/features.ts` | 256×256 超级单元 manifest 与结构模板物化 |
| `src/meshing/greedy-mesher.ts` | 含 halo 的不透明方块面剔除和贪心网格 |
| `src/streaming/priority-queue.ts` | 可取消、去重、按优先级调度的 Worker 任务 |
| `src/streaming/stream-controller.ts` | column/section 生命周期和 GPU 上传预算 |
| `src/render/renderer-adapter.ts` | WebGPU/WebGL2 后端探测、RenderPage 和 Three.js 适配 |
| `src/render/terrain-lod.ts`、`src/render/water.ts` | 远景 clipmap 与相机跟随水面 |
| `src/gameplay/player-controller.ts`、`src/gameplay/inventory.ts` | 物理、DDA 交互和快捷栏 |
| `src/persistence/snapshot-store.ts`、`src/persistence/legacy-import.ts` | 新快照事务与 mc-lite 一次性导入 |
| `src/benchmark/frame-metrics.ts` | 帧时间、1% low 和性能事件采样 |
| `src/app/main.ts` | 组合根、出生安全环、HUD 和错误提示 |

## Task 1: 创建 TypeScript 工程、测试命令与后端探测外壳

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/app/main.ts`, `src/render/backend.ts`
- Create: `tests/unit/render/backend.test.ts`, `tests/support/dom.ts`

**Interfaces:**
- Produces `detectRenderBackend(navigatorLike): 'webgpu' | 'webgl2' | 'unsupported'`。
- Produces `npm run test:unit`, `npm run test:e2e`, `npm run build`, `npm run dev`。

- [ ] **Step 1: 安装确定的开发依赖并配置脚本**

```bash
npm init -y
npm install three@0.184.0
npm install -D typescript vite vitest @vitest/coverage-v8 playwright @playwright/test eslint @eslint/js typescript-eslint
npx playwright install chromium
```

在 `package.json` 写入：

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 8080",
    "build": "tsc --noEmit && vite build",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "lint": "eslint ."
  }
}
```

- [ ] **Step 2: 写失败的后端选择测试**

`tests/unit/render/backend.test.ts`：生产代码若错误地选择 WebGL2 或没有降级分支，以下断言必须失败。

```ts
import { describe, expect, it } from 'vitest';
import { detectRenderBackend } from '../../../src/render/backend';

describe('detectRenderBackend', () => {
  it('prefers WebGPU when navigator exposes gpu', () => {
    expect(detectRenderBackend({ gpu: {} })).toBe('webgpu');
  });

  it('uses WebGL2 only when WebGPU is absent and a WebGL2 factory exists', () => {
    expect(detectRenderBackend({ createWebGL2Context: () => ({}) })).toBe('webgl2');
  });

  it('reports unsupported when neither capability is available', () => {
    expect(detectRenderBackend({})).toBe('unsupported');
  });
});
```

- [ ] **Step 3: 运行测试确认 Red 状态**

Run: `npm run test:unit -- tests/unit/render/backend.test.ts`

Expected: FAIL，原因是 `src/render/backend.ts` 尚不存在，而不是测试环境或 import 配置错误。

- [ ] **Step 4: 写最小后端实现和应用入口**

```ts
// src/render/backend.ts
export type BackendCapabilities = {
  gpu?: unknown;
  createWebGL2Context?: () => unknown | null;
};

export function detectRenderBackend(capabilities: BackendCapabilities): 'webgpu' | 'webgl2' | 'unsupported' {
  if (capabilities.gpu) return 'webgpu';
  if (capabilities.createWebGL2Context?.()) return 'webgl2';
  return 'unsupported';
}
```

`src/app/main.ts` 只创建根元素，显示选中的后端文字；不要在本任务初始化 Three.js。

- [ ] **Step 5: 验证 Green、构建和 lint**

Run: `npm run test:unit -- tests/unit/render/backend.test.ts && npm run build && npm run lint`

Expected: 三个命令均以 exit 0 结束。

- [ ] **Step 6: 提交工程外壳**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src/app tests/unit/render/backend.test.ts tests/support
git commit -m "build: scaffold typed voxel game"
```

## Task 2: 实现块坐标、section 坐标和方块注册表

**Files:**
- Create: `src/domain/coords.ts`, `src/domain/blocks.ts`
- Create: `tests/unit/domain/coords.test.ts`, `tests/unit/domain/blocks.test.ts`

**Interfaces:**

```ts
export const SECTION_SIZE = 16;
export type BlockPos = Readonly<{ x: number; y: number; z: number }>;
export type SectionPos = Readonly<{ x: number; y: number; z: number }>;
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export function sectionOf(block: BlockPos): SectionPos;
export function localIndex(block: BlockPos): number;
export function localPos(index: number): BlockPos;
export type RenderClass = 'opaque' | 'cutout' | 'translucent' | 'none';
export type BlockDefinition = Readonly<{ id: number; key: string; solid: boolean; renderClass: RenderClass; orientation: boolean }>;
export function blockByKey(key: string): BlockDefinition;
export function blockById(id: number): BlockDefinition;
export type BlockRegistry = Readonly<{ byId(id: number): BlockDefinition; byKey(key: string): BlockDefinition }>;
```

- [ ] **Step 1: 写坐标失败测试，覆盖负坐标和手工索引**

```ts
it('maps the block at -1, 0, -17 to its negative section and local cell', () => {
  expect(sectionOf({ x: -1, y: 0, z: -17 })).toEqual({ x: -1, y: 0, z: -2 });
  expect(localIndex({ x: -1, y: 0, z: -17 })).toBe(255);
});

it('round-trips the highest local cell', () => {
  expect(localPos(4095)).toEqual({ x: 15, y: 15, z: 15 });
});
```

- [ ] **Step 2: 运行坐标测试确认 Red 状态**

Run: `npm run test:unit -- tests/unit/domain/coords.test.ts`

Expected: FAIL，缺少 `coords.ts` 导出。

- [ ] **Step 3: 实现纯坐标函数**

```ts
export const SECTION_SIZE = 16;
const floorDiv = (value: number) => Math.floor(value / SECTION_SIZE);
const mod = (value: number) => ((value % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;
export const sectionOf = ({ x, y, z }: BlockPos): SectionPos => ({ x: floorDiv(x), y: floorDiv(y), z: floorDiv(z) });
export const localIndex = ({ x, y, z }: BlockPos) => mod(x) | (mod(z) << 4) | (mod(y) << 8);
export const localPos = (index: number): BlockPos => ({ x: index & 15, z: (index >>> 4) & 15, y: (index >>> 8) & 15 });
```

- [ ] **Step 4: 写 block registry 失败测试，再实现最小注册表**

```ts
it('keeps water non-solid and translucent while stone is opaque and solid', () => {
  expect(blockByKey('water')).toMatchObject({ id: 3, solid: false, renderClass: 'translucent' });
  expect(blockByKey('stone')).toMatchObject({ id: 1, solid: true, renderClass: 'opaque' });
});
```

定义不可变的 `air=0`、`stone=1`、`grass=2`、`water=3`、`sand=4`、`wood=5`、`leaves=6`、`glass=7`，并让未知 key 抛出 `Unknown block key: <key>`。

- [ ] **Step 5: 验证、lint 并提交**

Run: `npm run test:unit -- tests/unit/domain && npm run lint`

```bash
git add src/domain tests/unit/domain
git commit -m "feat(domain): add voxel coordinates and block registry"
```

## Task 3: 实现紧凑 VoxelSection 和版本化编辑

**Files:**
- Create: `src/domain/voxel-section.ts`
- Create: `tests/unit/domain/voxel-section.test.ts`

**Interfaces:**

```ts
export class VoxelSection {
  readonly pos: SectionPos;
  readonly editVersion: number;
  get(localIndex: number): number;
  set(localIndex: number, blockId: number): VoxelSection;
  static filled(pos: SectionPos, blockId: number): VoxelSection;
}
```

- [ ] **Step 1: 写不可变编辑的失败测试**

```ts
it('increments the version once and preserves the previous section after an edit', () => {
  const before = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);
  const after = before.set(0, 3);
  expect(before.get(0)).toBe(1);
  expect(after.get(0)).toBe(3);
  expect(after.editVersion).toBe(1);
});
```

- [ ] **Step 2: 运行测试确认 Red 状态**

Run: `npm run test:unit -- tests/unit/domain/voxel-section.test.ts`

Expected: FAIL，`VoxelSection` 未定义。

- [ ] **Step 3: 最小实现单色 palette 与复制时扩展 palette**

使用 `Uint16Array(4096)` 保存 palette index；`palette: readonly number[]` 保存 block id。`set` 复制索引数组，查找/追加 block id，返回 `editVersion + 1` 的新实例。禁止暴露可写 typed array。

- [ ] **Step 4: 添加 palette 扩展和相同值编辑的行为测试**

```ts
it('does not create a new version when setting a cell to its current block id', () => {
  const section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);
  expect(section.set(12, 1)).toBe(section);
});
```

该测试防止无效编辑造成永久重网格队列。

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/domain/voxel-section.test.ts && npm run lint`

```bash
git add src/domain/voxel-section.ts tests/unit/domain/voxel-section.test.ts
git commit -m "feat(domain): add versioned palette voxel sections"
```

## Task 4: 建立 WorldQuery、批量编辑和 DDA 方块命中

**Files:**
- Create: `src/world/world-query.ts`, `src/world/edit-overlay.ts`
- Create: `tests/unit/world/world-query.test.ts`, `tests/unit/world/dda-raycast.test.ts`

**Interfaces:**

```ts
export type VoxelHit = Readonly<{ block: BlockPos; normal: BlockPos; distance: number; blockId: number }>;
export type BlockEdit = Readonly<{ pos: BlockPos; blockId: number; orientation?: number }>;
export interface WorldQuery {
  getBlock(pos: BlockPos): number;
  isSolid(pos: BlockPos): boolean;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null;
  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }>;
}
export class InMemoryWorld implements WorldQuery {
  getBlock(pos: BlockPos): number;
  isSolid(pos: BlockPos): boolean;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null;
  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }>;
}
```

- [ ] **Step 1: 写 DDA 和原子批量编辑失败测试**

```ts
it('hits the first solid voxel on the ray and returns the entered face normal', () => {
  const world = new InMemoryWorld();
  world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
  expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 8)).toMatchObject({
    block: { x: 2, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, blockId: 1,
  });
});

it('reports one changed section for two edits in that section', () => {
  const world = new InMemoryWorld();
  expect(world.applyEdits([
    { pos: { x: 0, y: 0, z: 0 }, blockId: 1 },
    { pos: { x: 1, y: 0, z: 0 }, blockId: 1 },
  ]).changedSections).toEqual([{ x: 0, y: 0, z: 0 }]);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/world/world-query.test.ts tests/unit/world/dda-raycast.test.ts`

Expected: FAIL，因为 `InMemoryWorld` 未实现。

- [ ] **Step 3: 实现真实的 sparse edit overlay 与 Amanatides-Woo DDA**

`edit-overlay.ts` 以 `Map<sectionKey, Map<localIndex, blockId>>` 保存覆盖，其中 `0` 是显式空气。DDA 每步以方向分量计算 `tMax`/`tDelta`，先检查当前格；命中只由 `isSolid(blockId)` 判定。

- [ ] **Step 4: 添加跨负 section 与显式空气删除测试**

```ts
it('makes an explicit air override hide a generated stone block', () => {
  const world = new InMemoryWorld(() => 1);
  world.applyEdits([{ pos: { x: -1, y: 0, z: -1 }, blockId: 0 }]);
  expect(world.getBlock({ x: -1, y: 0, z: -1 })).toBe(0);
});
```

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/world && npm run lint`

```bash
git add src/world tests/unit/world
git commit -m "feat(world): add versioned edits and DDA interaction query"
```

## Task 5: 实现确定性地形、超级单元 feature manifest 与建筑物化

**Files:**
- Create: `src/world/terrain.ts`, `src/world/features.ts`, `src/world/structure-template.ts`
- Create: `tests/unit/world/terrain.test.ts`, `tests/unit/world/features.test.ts`

**Interfaces:**

```ts
export type WorldGenerator = {
  blockAt(pos: BlockPos): number;
  biomeAt(x: number, z: number): 'plains' | 'desert' | 'snow' | 'coast';
  featuresForSupercell(x: number, z: number): readonly Feature[];
};
export function createGenerator(seed: number): WorldGenerator;
export type Aabb = Readonly<{ min: BlockPos; max: BlockPos }>;
export type Feature = Readonly<{ id: string; kind: 'house' | 'tower' | 'pyramid'; bounds: Aabb; seed: number }>;
export function materializeFeature(feature: Feature, pos: BlockPos): number | null;
```

- [ ] **Step 1: 写确定性与跨 section 建筑失败测试**

```ts
it('returns the same feature manifest irrespective of request order', () => {
  const generator = createGenerator(42);
  const first = generator.featuresForSupercell(0, 0);
  generator.featuresForSupercell(8, -3);
  expect(generator.featuresForSupercell(0, 0)).toEqual(first);
});

it('materializes both sides of a house that crosses x=16 without duplicate ownership', () => {
  const feature = { id: 'house:0:0', kind: 'house', seed: 9, bounds: { min: { x: 14, y: 0, z: 0 }, max: { x: 17, y: 3, z: 3 } } } as const;
  expect(materializeFeature(feature, { x: 15, y: 0, z: 0 })).toBe(5);
  expect(materializeFeature(feature, { x: 16, y: 0, z: 0 })).toBe(5);
});
```

- [ ] **Step 2: 确认 Red 状态**

Run: `npm run test:unit -- tests/unit/world/terrain.test.ts tests/unit/world/features.test.ts`

Expected: FAIL，`createGenerator` 和 `materializeFeature` 缺失。

- [ ] **Step 3: 实现无状态 hash noise、地表层和 feature manifest**

实现 `hash2(seed, x, z): number`，仅用整数混合和无状态输入；地形在海平面以下输出 water，上方按 `biomeAt` 输出 grass/sand/stone。每个 256×256 超级单元仅根据 `(seed, supercellX, supercellZ)` 生成有限且排序稳定的 feature 列表。

- [ ] **Step 4: 实现结构模板覆盖顺序并添加相交规则测试**

`blockAt` 顺序必须是 terrain → 所有相交 feature（按 `feature.id` 排序）→ 由 WorldQuery 处理的玩家编辑。测试两个同单元 feature 时以排序靠后的 feature 覆盖同一格，期望使用手写 block id。

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/world/terrain.test.ts tests/unit/world/features.test.ts && npm run lint`

```bash
git add src/world/terrain.ts src/world/features.ts src/world/structure-template.ts tests/unit/world
git commit -m "feat(world): add deterministic terrain and structure manifests"
```

## Task 6: 在 Worker 纯函数中实现 halo 面剔除和不透明贪心网格

**Files:**
- Create: `src/meshing/mesh-types.ts`, `src/meshing/greedy-mesher.ts`
- Create: `tests/unit/meshing/greedy-mesher.test.ts`

**Interfaces:**

```ts
export type MeshingInput = Readonly<{ section: VoxelSection; neighbors: readonly VoxelSection[]; sourceVersion: number }>;
export type OpaqueMesh = Readonly<{ positions: Float32Array; normals: Int8Array; uvs: Float32Array; materialIds: Uint16Array; indices: Uint32Array; sourceVersion: number }>;
export function meshOpaque(input: MeshingInput, blocks: BlockRegistry): OpaqueMesh;
```

- [ ] **Step 1: 写两个可手工计数的失败测试**

```ts
it('emits six quads for one stone cube', () => {
  const mesh = meshOpaque(singleStoneAt(0, 0, 0), registry);
  expect(mesh.indices.length).toBe(36);
});

it('merges the exposed top of two adjacent stone cubes into one quad', () => {
  const mesh = meshOpaque(twoStonesAt(0, 0, 0, 1, 0, 0), registry);
  expect(countQuadsWithNormal(mesh, [0, 1, 0])).toBe(1);
});
```

`countQuadsWithNormal` 只能检查返回数组，不能调用 mesher 内部 helper。

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/meshing/greedy-mesher.test.ts`

Expected: FAIL，`meshOpaque` 缺失。

- [ ] **Step 3: 实现六方向 halo 采样、遮挡掩码与贪心矩形扫描**

将 section 的 6 个相邻 section 显式传入；越界单元由 halo 读取，未加载 halo 按空气处理。只对 `renderClass === 'opaque'` 且相邻格不是 opaque 的面建掩码。每个轴/方向扫描二维掩码，按 `(blockId, normal, skyLight, blockLight, ao)` 相等条件合并矩形。

- [ ] **Step 4: 添加边界 halo 与材质边界测试**

```ts
it('does not emit the east face when the east halo contains stone', () => {
  expect(countQuadsWithNormal(meshOpaque(stoneAtEastEdgeWithStoneHalo(), registry), [1, 0, 0])).toBe(0);
});

it('does not merge stone and grass faces into one quad', () => {
  expect(countTopQuads(meshOpaque(adjacentStoneAndGrass(), registry))).toBe(2);
});
```

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/meshing/greedy-mesher.test.ts && npm run lint`

```bash
git add src/meshing tests/unit/meshing
git commit -m "feat(meshing): add halo-aware greedy opaque meshes"
```

## Task 7: 建立可取消的优先级 Worker 调度和 section 生命周期

**Files:**
- Create: `src/streaming/priority-queue.ts`, `src/streaming/stream-controller.ts`, `src/workers/protocol.ts`
- Create: `tests/unit/streaming/priority-queue.test.ts`, `tests/unit/streaming/stream-controller.test.ts`

**Interfaces:**

```ts
export type SectionState = 'absent' | 'queued' | 'generating' | 'meshing' | 'uploadQueued' | 'visible' | 'evicting';
export type ColumnPos = Readonly<{ x: number; z: number }>;
export type Vec2 = Readonly<{ x: number; z: number }>;
export type WorkRequest = Readonly<{ key: string; epoch: number; priority: number; editVersion: number; kind: 'generate' | 'mesh' }>;
export type GeneratedSection = Readonly<{ key: string; epoch: number; editVersion: number; section: VoxelSection }>;
export type MeshedSection = Readonly<{ key: string; epoch: number; editVersion: number; mesh: OpaqueMesh }>;
export type UploadJob = Readonly<{ key: string; editVersion: number; mesh: OpaqueMesh; estimatedUploadMs: number }>;
export class PriorityWorkQueue {
  enqueue(request: WorkRequest): void;
  cancel(key: string, epoch: number): void;
  take(): WorkRequest | null;
}
export class StreamController {
  requestVisibleColumns(center: ColumnPos, velocity: Vec2, radius: number): void;
  acceptGenerated(result: GeneratedSection): void;
  acceptMeshed(result: MeshedSection): void;
  drainUploads(budgetMs: number): readonly UploadJob[];
}
```

- [ ] **Step 1: 写优先级、取消和过期回包的失败测试**

```ts
it('takes the forward high-priority request before a farther side request', () => {
  const queue = new PriorityWorkQueue();
  queue.enqueue({ key: 'forward', epoch: 1, priority: 100, editVersion: 0, kind: 'generate' });
  queue.enqueue({ key: 'side', epoch: 1, priority: 10, editVersion: 0, kind: 'generate' });
  expect(queue.take()?.key).toBe('forward');
});

it('rejects a mesh result whose editVersion is older than the section', () => {
  const stream = loadedStreamWithVersion('0,0,0', 2);
  expect(stream.acceptMeshed({ key: '0,0,0', epoch: 1, editVersion: 1, mesh: emptyMesh() })).toBe(false);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/streaming`

Expected: FAIL，队列和控制器尚不存在。

- [ ] **Step 3: 实现稳定优先队列和显式状态迁移**

队列以 `priority DESC, insertionSequence ASC` 排序；`cancel` 添加 `(key, epoch)` tombstone。控制器只允许 `absent → queued → generating → meshing → uploadQueued → visible`，非法状态迁移抛出带 key 的错误。生成/网格结果必须同时匹配 key、epoch 和 editVersion。

- [ ] **Step 4: 添加速度预测和上传预算测试**

```ts
it('assigns a higher request priority to columns in the velocity direction', () => {
  const stream = new StreamController();
  stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 1, z: 0 }, 2);
  expect(stream.peekPriority({ x: 2, z: 0 })).toBeGreaterThan(stream.peekPriority({ x: -2, z: 0 }));
});

it('returns no more jobs than fit in the declared upload budget', () => {
  expect(uploadQueuedStream().drainUploads(1).length).toBe(1);
});
```

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/streaming && npm run lint`

```bash
git add src/streaming src/workers/protocol.ts tests/unit/streaming
git commit -m "feat(streaming): add cancellable versioned section pipeline"
```

## Task 8: 接入生成/网格 Worker 与 3×3 出生安全环

**Files:**
- Create: `src/workers/generation.worker.ts`, `src/workers/meshing.worker.ts`, `src/workers/worker-client.ts`
- Create: `src/world/world-service.ts`
- Create: `tests/integration/workers/world-service.test.ts`

**Interfaces:**

```ts
export class WorldService implements WorldQuery {
  async prepareSpawn(center: ColumnPos): Promise<void>;
  updateStreaming(player: Vec3, velocity: Vec2): void;
  dispose(): void;
}
```

- [ ] **Step 1: 写真实 Worker 集成失败测试**

```ts
it('makes all nine spawn columns queryable before resolving prepareSpawn', async () => {
  const world = new WorldService({ seed: 123, workerFactory: realModuleWorkerFactory });
  await world.prepareSpawn({ x: 0, z: 0 });
  expect(world.loadedColumns()).toHaveLength(9);
  expect(world.isSolid({ x: 0, y: -1, z: 0 })).toBe(true);
  world.dispose();
});
```

- [ ] **Step 2: 运行集成测试确认 Red 状态**

Run: `npm run test:unit -- tests/integration/workers/world-service.test.ts`

Expected: FAIL，`WorldService` 和 worker entry 尚不存在。若 Vitest 不支持 module worker，先实现 `worker-client` 的同一协议 in-process adapter；测试不得 mock 生成函数。

- [ ] **Step 3: 实现可转移 Worker 协议和服务编排**

`generation.worker.ts` 接收 `{ kind: 'generate', key, epoch, editVersion, seed }`，返回 section palette/index arrays 并 transfer。`meshing.worker.ts` 接收 section 与 halo 的只读副本，调用 `meshOpaque`。`WorldService.prepareSpawn` 只请求中心 3×3 column 所需 section，并在全部返回后 resolve。

- [ ] **Step 4: 添加过期任务不发布和 Worker 错误保留旧资源测试**

```ts
it('keeps the currently visible mesh when a replacement worker request fails', async () => {
  const world = visibleWorldWithOneMesh();
  await world.handleWorkerFailure({ key: '0,0,0', epoch: 2, reason: new Error('worker crashed') });
  expect(world.visibleMeshFor('0,0,0')).toBeDefined();
});
```

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/integration/workers/world-service.test.ts && npm run lint`

```bash
git add src/workers src/world/world-service.ts tests/integration/workers
git commit -m "feat(world): stream generated and meshed spawn sections"
```

## Task 9: 实现 Three.js 渲染适配、RenderPage、远景 LOD 与水面

**Files:**
- Create: `src/render/renderer-adapter.ts`, `src/render/render-page.ts`, `src/render/terrain-lod.ts`, `src/render/water.ts`, `src/render/materials.ts`
- Create: `tests/unit/render/render-page.test.ts`, `tests/unit/render/terrain-lod.test.ts`
- Create: `tests/integration/render/renderer-fallback.test.ts`

**Interfaces:**

```ts
export class RenderPage {
  readonly key: string;
  readonly sourceVersion: number;
  replace(mesh: OpaqueMesh): void;
  isVisible(camera: CameraFrustum): boolean;
  dispose(): void;
}
export type CameraFrustum = Readonly<{ intersectsAabb(bounds: Aabb): boolean }>;
export type RenderFrame = Readonly<{ camera: CameraFrustum; timeMs: number }>;
export class RendererAdapter {
  readonly backend: 'webgpu' | 'webgl2';
  enqueueUpload(job: UploadJob): void;
  render(frame: RenderFrame): void;
}
```

- [ ] **Step 1: 写 RenderPage 原子替换与 frustum 排除失败测试**

```ts
it('keeps version 2 when an older page upload arrives after it', () => {
  const page = new RenderPage('0,0,0');
  page.replace(meshWithVersion(2));
  page.replace(meshWithVersion(1));
  expect(page.sourceVersion).toBe(2);
});

it('does not submit a page whose AABB is outside the camera frustum', () => {
  expect(pageAt({ minX: 200, maxX: 216 }).isVisible(frustumLookingAtOrigin())).toBe(false);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/render/render-page.test.ts tests/unit/render/terrain-lod.test.ts`

Expected: FAIL，RenderPage 和 LOD 环缺失。

- [ ] **Step 3: 写最小 Three.js 适配实现**

WebGPU 可用时从 `three/webgpu` 构建 `WebGPURenderer`；不可用时用 `WebGLRenderer`。`RenderPage.replace` 只接受较新的 `sourceVersion`，以新的 `BufferGeometry` 创建 opaque mesh 后再一次交换场景对象；旧 geometry/material 在交换后 dispose。材质图集以 `blockId` attribute 选择纹理层，禁止创建每种方块一个材质实例。

- [ ] **Step 4: 实现不阻塞近景的远景和水面，并添加行为测试**

`TerrainLod.update(cameraPosition)` 必须生成相机跟随的环而非固定世界平面；`WaterSurface.update(cameraPosition, time)` 必须只移动/更新 uniform，不重新创建 geometry。测试相机从 `{x:0,z:0}` 移到 `{x:64,z:-32}` 后环中心为 `{x:64,z:-32}`，水面 geometry 对象身份保持相同。

- [ ] **Step 5: 编写 WebGL2 后备集成测试、验证并提交**

```ts
it('creates a usable adapter when WebGPU is unavailable but WebGL2 is available', async () => {
  const adapter = await RendererAdapter.create(canvasWithWebGL2Only());
  expect(adapter.backend).toBe('webgl2');
});
```

Run: `npm run test:unit -- tests/unit/render && npm run test:unit -- tests/integration/render/renderer-fallback.test.ts && npm run lint`

```bash
git add src/render tests/unit/render tests/integration/render
git commit -m "feat(render): add versioned pages, lod and water adapter"
```

## Task 10: 实现玩家物理、背包和不依赖渲染网格的挖掘/放置

**Files:**
- Create: `src/gameplay/inventory.ts`, `src/gameplay/player-controller.ts`, `src/gameplay/player-interaction.ts`
- Create: `tests/unit/gameplay/inventory.test.ts`, `tests/unit/gameplay/player-controller.test.ts`, `tests/unit/gameplay/player-interaction.test.ts`

**Interfaces:**

```ts
export class Inventory {
  add(blockId: number, count: number): void;
  remove(blockId: number, count: number): boolean;
  selected(): Readonly<{ blockId: number; count: number }> | null;
}
export class PlayerController {
  step(input: Readonly<{ x: number; z: number }>, dtSeconds: number): Vec3;
}
export class PlayerInteraction {
  breakBlock(world: WorldQuery, origin: Vec3, direction: Vec3): boolean;
  placeBlock(world: WorldQuery, origin: Vec3, direction: Vec3, blockId: number): boolean;
}
```

- [ ] **Step 1: 写挖掘、放置和库存失败测试**

```ts
it('removes the DDA hit block and gives exactly one matching inventory item', () => {
  const { world, inventory, interaction } = worldWithStoneAt(2, 0, 0);
  expect(interaction.breakBlock(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 })).toBe(true);
  expect(world.getBlock({ x: 2, y: 0, z: 0 })).toBe(0);
  expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
});

it('places a selected block on the entered face without placing inside the player AABB', () => {
  const { world, interaction } = worldWithStoneAt(2, 0, 0);
  expect(interaction.placeBlock(world, { x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 5)).toBe(true);
  expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(5);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/gameplay`

Expected: FAIL，inventory 和 interaction 尚不存在。

- [ ] **Step 3: 实现背包和 DDA 交互**

`Inventory.remove` 只有存量足够时才扣除。`breakBlock` 用 `WorldQuery.raycast` 读取命中，写入 block id `0`，然后增加命中方块。`placeBlock` 以 `hit.block + hit.normal` 为目标，检查 `world.isSolid`、玩家 AABB 和库存后调用 `applyEdits`；旋转方块的方向使用玩家水平方向量量化为 0–3。

- [ ] **Step 4: 添加物理走入 solid 方块与旋转方块方向测试**

```ts
it('stops horizontal movement before entering a solid voxel', () => {
  expect(playerAt({ x: 0.5, y: 1, z: 0.5 }, solidWorldAt(1, 0, 0)).step({ x: 1, z: 0 }, 1).x).toBeLessThan(0.7);
});
```

用固定方向 `{x:0,z:-1}` 断言放置木材的 orientation 为 `3`，避免由生产 helper 计算期望。

- [ ] **Step 5: 验证并提交**

Run: `npm run test:unit -- tests/unit/gameplay && npm run lint`

```bash
git add src/gameplay tests/unit/gameplay
git commit -m "feat(gameplay): add player physics inventory and voxel interactions"
```

## Task 11: 添加新快照存档和安全的 mc-lite 导入器

**Files:**
- Create: `src/persistence/snapshot-store.ts`, `src/persistence/legacy-import.ts`, `src/workers/persistence.worker.ts`
- Create: `tests/unit/persistence/snapshot-store.test.ts`, `tests/unit/persistence/legacy-import.test.ts`
- Create: `tests/integration/persistence/indexeddb-roundtrip.test.ts`

**Interfaces:**

```ts
export type LegacyImportReport = Readonly<{ importedBlocks: number; preservedEntries: number; warnings: readonly string[] }>;
export type PlayerSnapshot = Readonly<{ x: number; y: number; z: number; pitch: number; yaw: number }>;
export type WorldSnapshot = Readonly<{ id: string; seed: number; player: PlayerSnapshot; edits: readonly BlockEdit[] }>;
export function parseLegacySnapshot(input: unknown): { player: PlayerSnapshot; seed: number; edits: readonly BlockEdit[]; report: LegacyImportReport };
export class SnapshotStore {
  save(snapshot: WorldSnapshot): Promise<void>;
  loadCurrent(): Promise<WorldSnapshot | null>;
}
```

- [ ] **Step 1: 写旧 key/方块条目规范化与无效导出失败测试**

```ts
it('converts a legacy string coordinate and oriented entry into a block edit', () => {
  const result = parseLegacySnapshot({ player: { x: 1, y: 2, z: 3, pitch: 0, yaw: 0 }, seed: 7, worldDeltas: [
    { key: '0,0', blocks: { '1,2,3': { type: 'wood', orientation: 2 } }, entities: {} },
  ] });
  expect(result.edits).toEqual([{ pos: { x: 1, y: 2, z: 3 }, blockId: 5, orientation: 2 }]);
});

it('rejects the known empty Promise-shaped mc-lite export instead of claiming success', () => {
  expect(() => parseLegacySnapshot({ version: '1.0', exportedAt: '2026-08-17T00:00:00Z' })).toThrow('Legacy save is missing player or worldDeltas');
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/persistence/legacy-import.test.ts`

Expected: FAIL，parser 未实现。

- [ ] **Step 3: 实现纯导入 parser 和丢失内容封存**

支持旧 `"x,y,z"` key 和数值编码 key；支持字符串 block 或 `{ type, orientation }`。已知 block 映射到 registry；未知 block/实体放入 `preservedEntries`，并在 report 中添加精确 warning。parser 不访问 IndexedDB，也不修改 `mc_lite_manual_saves`。

- [ ] **Step 4: 写 IndexedDB 原子 manifest 失败测试并实现 store**

```ts
it('keeps the previous current manifest if writing the next snapshot fails before commit', async () => {
  const store = failingAfterSectionWritesStore();
  await store.save(snapshotNamed('one'));
  await expect(store.save(snapshotNamed('two'))).rejects.toThrow('quota');
  expect((await store.loadCurrent())?.id).toBe('one');
});
```

实现顺序为：写本 snapshot 的 section/实体记录 → 写 snapshot manifest → 将 `currentManifestId` 指向新 manifest。使用 `fake-indexeddb` 仅模拟 IndexedDB API，不 mock store 自身逻辑。

- [ ] **Step 5: 添加同源旧库读取入口、验证并提交**

实现 `importFromLegacyIndexedDb(indexedDb)`，只调用旧库 readonly transaction；不同 origin 时 UI 显示“请从同一协议、主机和端口启动，或选择 JSON 文件”。

Run: `npm run test:unit -- tests/unit/persistence && npm run test:unit -- tests/integration/persistence/indexeddb-roundtrip.test.ts && npm run lint`

```bash
git add src/persistence src/workers/persistence.worker.ts tests/unit/persistence tests/integration/persistence
git commit -m "feat(persistence): add snapshots and safe mc-lite import"
```

## Task 12: 组合可玩应用、性能 HUD 和 90 FPS 浏览器基准

**Files:**
- Modify: `src/app/main.ts`
- Create: `src/app/hud.ts`, `src/benchmark/frame-metrics.ts`, `src/benchmark/run-path.ts`
- Create: `tests/unit/benchmark/frame-metrics.test.ts`, `tests/integration/app/playable-core.test.ts`
- Create: `tests/performance/playable-core.spec.ts`, `playwright.config.ts`

**Interfaces:**

```ts
export class FrameMetrics {
  recordFrame(timestampMs: number): void;
  summary(): Readonly<{ frames: number; averageFps: number; onePercentLowFps: number; p95FrameMs: number; p99FrameMs: number }>;
}
export type GameApp = Readonly<{ player: PlayerController; placeForTest(pos: BlockPos, block: string): void }>;
export type BenchmarkReport = Readonly<{ onePercentLowFps: number; p99FrameMs: number; frames: number }>;
export async function runBenchmarkPath(game: GameApp, durationMs: number): Promise<BenchmarkReport>;
```

- [ ] **Step 1: 写 1% low 的失败测试**

```ts
it('reports the hand-calculated 1% low from 100 recorded frames', () => {
  const metrics = new FrameMetrics();
  metrics.recordFrame(0);
  for (let i = 1; i <= 99; i += 1) metrics.recordFrame(i * 10);
  metrics.recordFrame(1200);
  expect(metrics.summary().onePercentLowFps).toBeCloseTo(4.7619047619, 5);
});
```

该夹具有 99 个 10 ms 帧和一个 210 ms 帧，因此最慢 1% 的手工计算期望值为 `4.7619047619` FPS；若 percentile 方向或帧间隔计算错误会失败。

- [ ] **Step 2: 运行失败测试**

Run: `npm run test:unit -- tests/unit/benchmark/frame-metrics.test.ts`

Expected: FAIL，`FrameMetrics` 缺失。

- [ ] **Step 3: 实现 metrics、HUD 和应用组合根**

`main.ts` 依次创建 `WorldService`、`RendererAdapter`、`PlayerController`、`Inventory`、`PlayerInteraction`；等待 `prepareSpawn({x:0,z:0})` 后移除加载 UI。每帧先更新输入/物理与 streaming，再调用 `drainUploads`，最后 render 和记录 frame。HUD 显示 backend、平均 FPS、1% low、p99、可见 section、Worker 队列和上传字节。

- [ ] **Step 4: 写可玩流程和固定路径浏览器测试**

```ts
test('loads a spawn safety ring and changes a targeted block through the public game API', async ({ page }) => {
  await page.goto('/');
  await page.getByText('World ready').waitFor();
  await page.evaluate(() => window.game!.placeForTest({ x: 1, y: 1, z: 1 }, 'wood'));
  await expect(page.getByTestId('block-at-1-1-1')).toHaveText('wood');
});
```

在 `playwright.config.ts` 定义 `chromium`（功能测试）和 `{ name: 'chrome', use: { channel: 'chrome' } }`（实机性能测试）两个项目。`tests/performance/playable-core.spec.ts` 使用固定 seed、相同相机路径和 300 秒持续移动，导出 JSON 报告；若非 WebGPU，测试标记 skip 并输出后端原因。性能断言为 `onePercentLowFps >= 90` 且 `p99FrameMs <= 11.1`。

- [ ] **Step 5: 执行全量验证和记录实机报告**

Run:

```bash
npm run test:unit
npm run build
npm run lint
npm run test:e2e
npx playwright test tests/performance/playable-core.spec.ts --project=chrome
```

Expected: 单元、构建、lint、集成全部 exit 0；最后一个命令在当前 Mac Chrome 的 WebGPU 路径生成 `artifacts/perf/playable-core.json`，其中 1% low ≥90 且 p99 ≤11.1 ms。若指标未达标，停止交付，使用 HUD/报告定位瓶颈后另开性能修复任务。

- [ ] **Step 6: 提交首个可玩核心**

```bash
git add src tests playwright.config.ts package.json package-lock.json
git commit -m "feat(game): deliver streamed playable voxel core"
```

## 完成核对

- [ ] 使用当前 Mac 的最新 Chrome 在 WebGPU 路径完成 Task 12 的 5 分钟基准，保存报告且达到 1% low ≥90 FPS。
- [ ] 手工确认从出生点持续奔跑、穿过未生成 terrain 和大型结构时没有 Region 边界停顿或近距离建筑闪现。
- [ ] 手工确认挖掘、放置、旋转、背包、碰撞、水面、昼夜和手动存档无需等待 Worker/IndexedDB。
- [ ] 手工确认 WebGL2 降级可进入、移动和编辑；不将其性能结果与 WebGPU 验收混用。
- [ ] 对 `mc-lite` 旧手动库执行只读导入演练，并对缺少 `player/worldDeltas` 的旧 JSON 显示明确失败说明。

## 后续计划边界

阶段 2 将单独计划：方块/模型内容迁移、宝箱、TNT、粒子、雨、光照质量档和导入 UI。阶段 3 将单独计划：敌人、武器、炮塔、巢穴、矿车、轨道与实体压力基准。两阶段都必须以本计划的 `WorldQuery`、`WorldService`、`RenderPage` 和 `SnapshotStore` 接口为唯一集成点。
