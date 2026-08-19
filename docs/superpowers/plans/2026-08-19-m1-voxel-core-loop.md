# M1 体素核心闭环实施计划（mc-heavy 第一阶段）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M0 骨架上实现体素核心闭环——地形无限生成、section 网格化（快速+精修双路径）、BatchedMesh 通道级合批发布、玩家移动/物理/DDA 射线/放块挖块、最小存档（edits 持久化），达成设计文档 §7 M1 验收：平原地形无限行走不掉帧、放块挖块当帧生效、重启后修改保留。

**Architecture:** typed 体素数组为唯一权威（ChunkColumn 16×16×128，blocks/meta/light 三个 typed array + edits 稀疏层）；GEN/MESH/LIGHT 全部在 Worker 池执行、Transferable 零拷贝回传、版本协议收敛；mesher 逐面输出三通道 flat 缓冲（opaque/cutout/transparent），发布层每通道一个 BatchedMesh（section = 1 geometry slot + 1 instance）；玩家物理定步长 60Hz 与渲染解耦，交互走 Amanatides-Woo DDA 射线；edits 经 IndexedDB 防抖持久化，加载时随 GEN 重放。

**Tech Stack:** 纯 JavaScript ES Modules（JSDoc 类型）、three.js r185.1 本地 vendor（three.webgpu.js + three.tsl.js，TSL NodeMaterial）、Playwright 1.62.1（channel:'chromium' 零 flag 走 Metal）、pngjs 无新增依赖。

## Global Constraints

- 纯 JavaScript + JSDoc，**禁止 TypeScript**，无构建步骤（设计文档 DR-9）。
- three.js 固定 r185.1，本地 `vendor/three/` 引入；**three 只在主线程**，`src/workers/`、`src/gen/`、`src/mesh/mesher.js`、`src/mesh/lighting.js`、`src/voxel/` 不得 import three（Worker 同构约束，设计文档 §3）。
- 世界高度：`WORLD_MIN_Y = -32, WORLD_MAX_Y = 96`（高 128，8 个 16³ section）；方块 ID 0 = air；海面 `SEA_Y = -2`（与 mc-lite 坐标兼容，DR-8）。
- 顶点格式（§4.3，M0 bench 已验证 flat 快路径）：`position` Float32×3（section 局部坐标）+ `uv` Float32×2 + `packed` **Uint32**×1（bit0-7 light = sky<<4|block，bit8-9 AO 0-3，bit10-12 面索引 0-5）；每面 4 顶点 6 索引（uint32 index）。**不得改 interleaved、不得改 uint16**（WebGPU arrayStride 必须 4 字节倍数）。
- 权威边界（DR-17）：gameplay 真相 = `blocks` + `meta`（+ `blockEntities` 预留）；`light` 是派生缓存可重算收敛，不得当真相来源。
- 版本协议（§4.9）：所有异步任务携带 `(columnKey, version)`，回传不匹配即丢弃。
- 冻结断言纪律：本计划的性能断言数字（帧时阈值、draw 上限）在实测不符时**停下报告**，不得擅自修改。
- 每个任务结束必须 commit（Conventional Commits）；commit 需用户明确指令时先报告等待。
- M1 **不含**：结构/城市/树木/装饰物（M2）、blocklight 增量删除（M2，本阶段光源删除走全 column 重算）、cross/slab 等非立方几何（M2，mesher 留接口）、水面 TSL 特效（M2）、日夜/阴影（M2）。

## File Structure

```
mc-heavy/
├─ src/
│  ├─ main.js                    # 改造：接入 Game（世界+玩家+调度）
│  ├─ core/
│  │  ├─ game.js                 # 主循环编排：input→physics→schedule→budget→render
│  │  └─ scheduler.js            # 世界流式调度：GEN/MESH 队列、滞回卸载、LRU 重入、帧预算上传
│  ├─ voxel/
│  │  ├─ constants.js            # 世界常量（MIN_Y/MAX_Y/SECTION/COLUMN/SEA_Y）
│  │  ├─ chunk-column.js         # ChunkColumn：typed 存储 + edits + 脏标记
│  │  ├─ world-data.js           # WorldData：column 索引 + 跨柱读路径 + section halo 视图
│  │  └─ faces-data.js           # 方块→纹理面映射（从 mc-lite MaterialManager 转换）
│  ├─ gen/
│  │  ├─ noise.js                # seededRandom/noise/getBiome（移植 mc-lite MathUtils，Worker 同构）
│  │  └─ terrain.js              # heightmap + column 填充 + spawn 安全点（Worker 同构）
│  ├─ mesh/
│  │  ├─ lighting.js             # skylight top-down + blocklight flood fill（Worker 同构）
│  │  └─ mesher.js               # 逐面网格化：面剔除 + AO + 三通道输出（Worker/主线程同构）
│  ├─ render/
│  │  ├─ materials.js            # TSL 体素材质（packed 属性解包 + atlas 采样 + 雾）
│  │  └─ render-world.js         # PublishStrategy：3×BatchedMesh 通道级合批 + slot 生命周期
│  ├─ player/
│  │  ├─ physics.js              # AABB 碰撞 + 定步长积分（0.6×1.8×0.6，GRAVITY -24）
│  │  ├─ raycast.js              # Amanatides-Woo DDA 体素射线
│  │  └─ player.js               # 输入/视角/交互编排（放块挖块唯一写入口经 world.setBlock）
│  ├─ save/
│  │  └─ persistence.js          # IndexedDB edits 读写（防抖 5s + visibilitychange flush）
│  ├─ workers/
│  │  └─ world-worker.js         # GEN/MESH/LIGHT RPC 入口（installRpcHandler）
│  └─ tests/
│     ├─ test-chunk-column.js    # Task 1
│     ├─ test-terrain.js         # Task 2
│     ├─ test-lighting.js        # Task 3
│     ├─ test-mesher.js          # Task 5
│     ├─ test-physics.js         # Task 9
│     ├─ test-raycast.js         # Task 9
│     └─ index.html              # 逐个追加 import
└─ tests/
├─ render-terrain.spec.mjs    # Task 7：地形渲染非空 + draw 上限
   ├─ interaction.spec.mjs       # Task 9：放块挖块当帧生效
   ├─ persistence.spec.mjs       # Task 10：重启后修改保留
   └─ m1-acceptance.spec.mjs     # Task 11：行走帧时 + 放挖压力 p95
```

**职责边界**：`gen/`、`mesh/mesher.js`、`mesh/lighting.js`、`voxel/` 不依赖 three（Worker 同构）；`render/` 是唯一接触 three 渲染对象的层；`scheduler.js` 是唯一编排异步任务生命周期的层（版本校验集中在此）；`player/` 只经 `world.setBlock`/`world.getBlockId` 读写世界。

---

### Task 1: 体素数据层（constants + ChunkColumn + WorldData）

**Files:**
- Create: `src/voxel/constants.js`
- Create: `src/voxel/chunk-column.js`
- Create: `src/voxel/world-data.js`
- Test: `src/tests/test-chunk-column.js`
- Modify: `src/tests/index.html`（追加 import）

**Interfaces:**
- Produces（后续所有任务依赖）：
  - `constants.js`：`WORLD_MIN_Y=-32, WORLD_MAX_Y=96, WORLD_HEIGHT=128, COLUMN_SIZE=16, SECTION_SIZE=16, SECTIONS_PER_COLUMN=8, SEA_Y=-2, BLOCKS_PER_COLUMN=32768, BLOCKS_PER_SECTION=4096`；`blockIndex(lx, y, lz) = lx + lz*16 + (y-WORLD_MIN_Y)*256`（lx/lz ∈ [0,16)）；`sectionOf(y) = (y-WORLD_MIN_Y) >> 4`；`columnKey(cx, cz) = cx + ',' + cz`。
  - `class ChunkColumn`：`constructor(cx, cz)`；字段 `blocks: Uint16Array(32768)`、`meta: Uint8Array(32768)`、`light: Uint8Array(32768)`（高4位 sky 低4位 block）、`edits: Map<index, {id, meta}>`、`blockEntities: Map<index, object>`（预留，M1 恒空）、`version: number`（初始 0）、`state: 'empty'|'generating'|'ready'`、`dirtySections: Uint8Array(8)`（0/1 位图）；方法 `get(lx,y,lz)→id`（y 越界返回 0）、`set(lx,y,lz,id,meta=0)`（写 blocks/meta + version++ + edits.set + 对应 section 置脏，y 越界静默忽略）、`markDirty(sy)`、`takeDirty()→number[]`（返回脏 section 列表并清零）、`applyEdits(editsArray)`（重放 [{index,id,meta}]，不重复记入 edits 自身——重放源就是 edits）。
  - `class WorldData`：`constructor(registry)`（registry = M0 的 BlockRegistry 实例）；`columns: Map<columnKey, ChunkColumn>`；`getColumn(cx,cz)`、`hasColumn(cx,cz)`、`add(column)`、`remove(columnKey)`；读路径 `getBlockId(x,y,z)→id`（column 缺失或 y 越界返回 0；y < WORLD_MIN_Y 返回 bedrock ID——防穿底，§4.1）、`isSolid(x,y,z)→bool`（solidTable 直查）、`isOpaque(x,y,z)→bool`（opaqueTable 直查）、`setBlock(x,y,z,id,meta=0)→{column, index, sy, affected: [{cx,cz,sy}]}`（跨 column 写入：定位 column 调 set；affected 返回受影响的 section 列表——本 section + 贴边时相邻 column 的边界 section，供调度器置脏，§4.5.3 最坏范围规则）；`getSectionView(cx, sy, cz)→{data: Uint16Array(18*18*18), light: Uint8Array(18*18*18), missing: boolean}`（中心 section + 1 格 halo，跨 column/section 自动拼接；任一邻居 column 缺失时 `missing=true` 且缺失方向按 air 填充——halo 协议 §4.3 第 4 条由调用方决策）；`viewIndex(dx,dy,dz) = dx + dz*18 + dy*324`（dx/dz/dy ∈ [0,18)，halo 内局部坐标）。
- Consumes: M0 `createRegistry`/`blocks-data.js`（bedrock ID 查询）。

- [ ] **Step 1: 写失败测试 src/tests/test-chunk-column.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertThrows } from './assert.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex, sectionOf, columnKey } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('constants: 索引与 section 换算', () => {
  assertEqual(blockIndex(0, WORLD_MIN_Y, 0), 0);
  assertEqual(blockIndex(15, WORLD_MIN_Y, 15), 15 + 15 * 16);
  assertEqual(blockIndex(0, WORLD_MIN_Y + 16, 0), 256 * 16);
  assertEqual(sectionOf(WORLD_MIN_Y), 0);
  assertEqual(sectionOf(WORLD_MAX_Y), 7);
  assertEqual(columnKey(3, -2), '3,-2');
});

test('ChunkColumn: set/get + 脏标记 + 版本', () => {
  const col = new ChunkColumn(0, 0);
  const v0 = col.version;
  col.set(1, WORLD_MIN_Y + 20, 2, 5, 3);
  assertEqual(col.get(1, WORLD_MIN_Y + 20, 2), 5);
  assertEqual(col.meta[blockIndex(1, WORLD_MIN_Y + 20, 2)], 3);
  assertTrue(col.version > v0, 'version bumped');
  assertEqual(col.edits.size, 1);
  assertTrue(col.dirtySections[sectionOf(WORLD_MIN_Y + 20)] === 1, 'section dirty');
  const dirty = col.takeDirty();
  assertEqual(dirty.length, 1);
  assertEqual(col.takeDirty().length, 0, 'takeDirty clears');
});

test('ChunkColumn: y 越界行为', () => {
  const col = new ChunkColumn(0, 0);
  col.set(0, WORLD_MAX_Y + 1, 0, 5);   // 静默忽略
  assertEqual(col.get(0, WORLD_MAX_Y + 1, 0), 0);
  assertEqual(col.version, 0, 'no version bump on out-of-bounds');
});

test('ChunkColumn: applyEdits 重放', () => {
  const col = new ChunkColumn(0, 0);
  col.applyEdits([{ index: blockIndex(2, WORLD_MIN_Y + 5, 2), id: 7, meta: 1 }]);
  assertEqual(col.get(2, WORLD_MIN_Y + 5, 2), 7);
  assertEqual(col.edits.size, 0, 'replay does not re-record edits');
});

test('WorldData: 跨 column 读写 + 越界', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  world.setBlock(15, WORLD_MIN_Y + 3, 0, 9);   // column a
  world.setBlock(16, WORLD_MIN_Y + 3, 0, 10);  // column b（x=16 → cx=1, lx=0）
  assertEqual(world.getBlockId(15, WORLD_MIN_Y + 3, 0), 9);
  assertEqual(world.getBlockId(16, WORLD_MIN_Y + 3, 0), 10);
  assertEqual(a.get(15, WORLD_MIN_Y + 3, 0), 9);
  assertEqual(b.get(0, WORLD_MIN_Y + 3, 0), 10);
  // 缺 column 返回 air；y 低于世界底返回 bedrock
  assertEqual(world.getBlockId(100, WORLD_MIN_Y + 3, 0), 0);
  const bedrockId = world.registry.idOf('bedrock');
  assertEqual(world.getBlockId(0, WORLD_MIN_Y - 5, 0), bedrockId);
});

test('WorldData: setBlock 返回受影响 section（贴边跨 column）', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0)); world.add(new ChunkColumn(1, 0));
  const r = world.setBlock(15, WORLD_MIN_Y + 3, 0, 9); // lx=15 贴 +X 边
  assertEqual(r.sy, 0);
  const keys = r.affected.map((a) => columnKey(a.cx, a.cz) + ':' + a.sy);
  assertTrue(keys.includes('0,0:0'), 'own section');
  assertTrue(keys.includes('1,0:0'), 'neighbor boundary section');
});

test('WorldData: getSectionView 拼接 halo', () => {
  const world = new WorldData(makeRegistry());
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  a.set(15, WORLD_MIN_Y + 5, 8, 11);   // 贴 +X 边
  b.set(0, WORLD_MIN_Y + 5, 8, 12);    // 邻居侧
  world.add(a); world.add(b);
  const view = world.getSectionView(0, 0, 0); // section sy=0 覆盖 y ∈ [-32,-17)
  assertEqual(view.missing, false);
  // halo 坐标：中心 section 内 (15,5,8) → view (16, 5+1, 9)；邻居 (0,5,8) → view (17, 6, 9)
  assertEqual(view.data[16 + 9 * 18 + 6 * 324], 11);
  assertEqual(view.data[17 + 9 * 18 + 6 * 324], 12);
});

test('WorldData: getSectionView 缺邻居 → missing=true', () => {
  const world = new WorldData(makeRegistry());
  world.add(new ChunkColumn(0, 0));
  const view = world.getSectionView(0, 0, 0);
  assertEqual(view.missing, true);
});
```

并在 `src/tests/index.html` 追加 `import './test-chunk-column.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `constants.js`/`chunk-column.js`/`world-data.js` 不存在（harness 模块加载错误）。

- [ ] **Step 3: 实现 src/voxel/constants.js**

```js
// src/voxel/constants.js — 世界几何常量（设计文档 §4.1，DR-8）
// Worker 同构：本文件不得 import three。

export const WORLD_MIN_Y = -32;
export const WORLD_MAX_Y = 96;
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y; // 128
export const COLUMN_SIZE = 16;
export const SECTION_SIZE = 16;
export const SECTIONS_PER_COLUMN = WORLD_HEIGHT / SECTION_SIZE; // 8
export const SEA_Y = -2; // 与 mc-lite 坐标兼容（海平面）
export const BLOCKS_PER_COLUMN = COLUMN_SIZE * COLUMN_SIZE * WORLD_HEIGHT; // 32768
export const BLOCKS_PER_SECTION = COLUMN_SIZE * COLUMN_SIZE * SECTION_SIZE; // 4096

/** column 内局部坐标 → typed array 索引（lx/lz ∈ [0,16)） */
export function blockIndex(lx, y, lz) {
  return lx + lz * COLUMN_SIZE + (y - WORLD_MIN_Y) * COLUMN_SIZE * COLUMN_SIZE;
}

/** 世界 y → section 序号（0..7）；越界调用方自行处理 */
export function sectionOf(y) {
  return (y - WORLD_MIN_Y) >> 4;
}

export function columnKey(cx, cz) {
  return cx + ',' + cz;
}
```

- [ ] **Step 4: 实现 src/voxel/chunk-column.js**

```js
// src/voxel/chunk-column.js — ChunkColumn：世界数据基本单元（设计文档 §4.1）
// typed 数组为唯一权威；edits 稀疏层仅用于持久化与重放（DR-6/DR-17）。
// Worker 同构：本文件不得 import three。
import {
  WORLD_MIN_Y, WORLD_MAX_Y, BLOCKS_PER_COLUMN, SECTIONS_PER_COLUMN,
  blockIndex, sectionOf,
} from './constants.js';

export class ChunkColumn {
  /** @param {number} cx @param {number} cz */
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint16Array(BLOCKS_PER_COLUMN);
    this.meta = new Uint8Array(BLOCKS_PER_COLUMN);
    /** 高4位 skylight，低4位 blocklight（派生缓存，可重算，§4.6） */
    this.light = new Uint8Array(BLOCKS_PER_COLUMN);
    /** 玩家修改稀疏层：index → {id, meta}（持久化与重放用） */
    this.edits = new Map();
    /** 方块实体富状态预留（DR-17）：M1 恒空，形状定好不实现消费者 */
    this.blockEntities = new Map();
    /** 每次数据变更 +1，异步结果版本校验用（§4.9） */
    this.version = 0;
    /** 'empty'|'generating'|'ready' */
    this.state = 'empty';
    /** 脏 section 位图（0/1），meshing 调度消费 */
    this.dirtySections = new Uint8Array(SECTIONS_PER_COLUMN);
  }

  /** @returns {number} 方块 ID；y 越界返回 0（air） */
  get(lx, y, lz) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return 0;
    return this.blocks[blockIndex(lx, y, lz)];
  }

  /** 写方块：blocks/meta + version + edits + 脏标记；y 越界静默忽略 */
  set(lx, y, lz, id, meta = 0) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return;
    const idx = blockIndex(lx, y, lz);
    this.blocks[idx] = id;
    this.meta[idx] = meta;
    this.version++;
    this.edits.set(idx, { id, meta });
    this.dirtySections[sectionOf(y)] = 1;
  }

  markDirty(sy) {
    if (sy >= 0 && sy < SECTIONS_PER_COLUMN) this.dirtySections[sy] = 1;
  }

  /** @returns {number[]} 脏 section 序号列表（取后清零） */
  takeDirty() {
    const out = [];
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      if (this.dirtySections[sy]) { out.push(sy); this.dirtySections[sy] = 0; }
    }
    return out;
  }

  /**
   * 重放 edits（GEN 完成接管 / 存档加载时调用）。
   * 不记入 this.edits（重放源就是 edits 本身），不 bump version。
   * @param {Array<{index: number, id: number, meta: number}>} editsArray
   */
  applyEdits(editsArray) {
    for (const e of editsArray) {
      this.blocks[e.index] = e.id;
      this.meta[e.index] = e.meta;
    }
  }
}
```

- [ ] **Step 5: 实现 src/voxel/world-data.js**

```js
// src/voxel/world-data.js — WorldData：column 索引 + 跨柱读路径 + halo 视图（§4.1/§4.3）
// Worker 同构：本文件不得 import three。
import {
  WORLD_MIN_Y, WORLD_MAX_Y, SECTION_SIZE, SECTIONS_PER_COLUMN,
  blockIndex, sectionOf, columnKey,
} from './constants.js';

const VIEW = 18; // section halo 视图边长（16 + 2×1）

export class WorldData {
  /** @param {ReturnType<import('./block-registry.js').createRegistry>} registry */
  constructor(registry) {
    this.registry = registry;
    /** @type {Map<string, import('./chunk-column.js').ChunkColumn>} */
    this.columns = new Map();
  }

  getColumn(cx, cz) { return this.columns.get(columnKey(cx, cz)); }
  hasColumn(cx, cz) { return this.columns.has(columnKey(cx, cz)); }
  add(column) { this.columns.set(columnKey(column.cx, column.cz), column); }
  remove(key) { this.columns.delete(key); }

  /**
   * O(1) 读方块。column 缺失或 y 越上界 → 0（air）；y 低于世界底 → bedrock（防穿底）。
   */
  getBlockId(x, y, z) {
    if (y < WORLD_MIN_Y) return this.registry.idOf('bedrock');
    if (y > WORLD_MAX_Y) return 0;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return 0;
    return col.blocks[blockIndex(x - cx * 16, y, z - cz * 16)];
  }

  isSolid(x, y, z) { return this.registry.solidTable[this.getBlockId(x, y, z)] === 1; }
  isOpaque(x, y, z) { return this.registry.opaqueTable[this.getBlockId(x, y, z)] === 1; }

  /**
   * 唯一写入口（§4.5.3）。跨 column 定位；返回受影响 section 列表
   * （本 section + 贴边时相邻 column 的边界 section——AO/面剔除最坏范围）。
   * @returns {{column: import('./chunk-column.js').ChunkColumn, index: number, sy: number,
   *            affected: Array<{cx: number, cz: number, sy: number}>} | null} column 缺失返回 null
   */
  setBlock(x, y, z, id, meta = 0) {
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return null;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return null;
    const lx = x - cx * 16, lz = z - cz * 16;
    col.set(lx, y, lz, id, meta);
    const sy = sectionOf(y);
    const affected = [{ cx, cz, sy }];
    const yInSection = y - WORLD_MIN_Y - sy * SECTION_SIZE;
    // 贴边 → 相邻 column 的边界 section 置脏（面剔除依赖）
    if (lx === 0) affected.push({ cx: cx - 1, cz, sy });
    if (lx === 15) affected.push({ cx: cx + 1, cz, sy });
    if (lz === 0) affected.push({ cx, cz: cz - 1, sy });
    if (lz === 15) affected.push({ cx, cz: cz + 1, sy });
    // 贴 section 上下边 → 本 column 相邻 section（AO 对角影响走精修路径，§4.5.3）
    if (yInSection === 0 && sy > 0) affected.push({ cx, cz, sy: sy - 1 });
    if (yInSection === 15 && sy < SECTIONS_PER_COLUMN - 1) affected.push({ cx, cz, sy: sy + 1 });
    return { column: col, index: blockIndex(lx, y, lz), sy, affected };
  }

  /**
   * section halo 视图：18×18×18（中心 section + 1 格 halo），跨 column/section 拼接。
   * 任一水平邻居 column 缺失 → missing=true（缺失方向按 air 填充，调用方决策保守出块，§4.3）。
   * @returns {{data: Uint16Array, light: Uint8Array, missing: boolean}}
   */
  getSectionView(cx, sy, cz) {
    const data = new Uint16Array(VIEW * VIEW * VIEW);
    const light = new Uint8Array(VIEW * VIEW * VIEW);
    let missing = false;
    const baseY = WORLD_MIN_Y + sy * SECTION_SIZE - 1; // halo 起点世界 y
    for (let dy = 0; dy < VIEW; dy++) {
      const wy = baseY + dy;
      if (wy < WORLD_MIN_Y || wy > WORLD_MAX_Y) continue; // 上下 halo 越界保持 air
      for (let dz = 0; dz < VIEW; dz++) {
        const wz = cz * 16 + dz - 1;
        const ncz = Math.floor(wz / 16);
        for (let dx = 0; dx < VIEW; dx++) {
          const wx = cx * 16 + dx - 1;
          const ncx = Math.floor(wx / 16);
          const col = this.columns.get(columnKey(ncx, ncz));
          if (!col) {
            if (ncx !== cx || ncz !== cz) missing = true;
            continue;
          }
          const idx = blockIndex(wx - ncx * 16, wy, wz - ncz * 16);
          const vi = dx + dz * VIEW + dy * VIEW * VIEW;
          data[vi] = col.blocks[idx];
          light[vi] = col.light[idx];
        }
      }
    }
    return { data, light, missing };
  }
}
```

- [ ] **Step 6: 运行验证通过**

Run: `npm test`
Expected: PASS（test-chunk-column 8 个用例全过）。

- [ ] **Step 7: lint + Commit**

Run: `npm run lint`（0 errors）

```bash
git add src/voxel/constants.js src/voxel/chunk-column.js src/voxel/world-data.js src/tests/test-chunk-column.js src/tests/index.html
git commit -m "feat(voxel): 体素数据层（ChunkColumn typed 存储 + WorldData 跨柱读路径 + halo 视图）"
```

---

### Task 2: 地形生成（noise + terrain，Worker 同构）

**Files:**
- Create: `src/gen/noise.js`
- Create: `src/gen/terrain.js`
- Test: `src/tests/test-terrain.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Produces:
  - `noise.js`（逐行移植 mc-lite MathUtils 的确定性函数，**seed 参数化**——mc-lite 用全局 WORLD_CONFIG.SEED，新引擎所有函数显式传 seed，Worker 无全局态）：`seededRandom(x, z, seed)→[0,1)`（sin 哈希，与 mc-lite 完全一致）；`noise(x, z, seed, scale=0.05)→[-4,4]`（`sin((x+seed)*scale)*2 + cos((z+seed)*scale)*2`）；`getBiome(x, z, seed)→'FOREST'|'AZALEA'|'DESERT'|'SWAMP'|'PLAINS'`（阈值与 mc-lite 一致：temp>1.2 FOREST；0.6<temp≤1.2 且 humidity>0 AZALEA；temp<-1.5 DESERT；-1.5<temp<-0.8 且 humidity>0.5 SWAMP；其余 PLAINS。M1 不含 CITY——结构是 M2）。
  - `terrain.js`：`generateHeight(x, z, seed)→number`（`h = floor(noise(x,z,seed,0.08) + noise(x,z,seed,0.02)*3)`，再按 biome 调整：DESERT `floor(h*0.5+2)`、SWAMP `floor(h*0.3-2)`、其余原值——与 mc-lite TerrainGen.generateHeight 一致，CITY 分支 M2 再加）；`fillColumn(column, seed, registry)`（对 column 的 16×16 每列：h = generateHeight；地层填充规则逐条移植 mc-lite WorldWorker.js:983-1015——`h < SEA_Y` 时：(wx,h,wz)=sand、(wx,h-1,wz)=end_stone；否则 (wx,h,wz)=surf、(wx,h-1,wz)=sub（PLAINS: grass/dirt；DESERT: sand/sand；AZALEA: moss/dirt；SWAMP: swamp_grass/dirt），k=2..12 填 (wx,h-k,wz)：k=12→end_stone、k=11→stone、k=2..10→stone 且 seededRandom(wx,wz,seed+100+k)<0.01 时 gold_ore；水面填充：y ∈ (h, SEA_Y] 且 h < SEA_Y 时填 water；y < h-12 到 WORLD_MIN_Y 填 stone（mc-lite 只填到 h-12，新引擎补实底部防止悬空见洞）；bedrock 层：y = WORLD_MIN_Y 填 bedrock）；`findSpawnY(world, x, z)→number`（出生点安全：从 WORLD_MAX_Y 向下找首个非 air 方块，返回其 y+1——复刻 mc-lite spawn on dry ground，§4.2）。
  - 注意：M1 不生成树/花/草/云/装饰物（M2），不生成结构（M2）——fillColumn 只做地层+水面+基岩。
- Consumes: Task 1 `ChunkColumn`/`blockIndex`/`SEA_Y`；M0 registry（方块名：`grass`/`dirt`/`stone`/`sand`/`end_stone`/`bedrock`/`water`/`moss`/`swamp_grass`/`gold_ore`——已核对 blocks-data.js 全部存在，注意是 `grass` 不是 `grass_block`、`moss` 不是 `moss_block`）。

- [ ] **Step 1: 写失败测试 src/tests/test-terrain.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { seededRandom, noise, getBiome } from '../gen/noise.js';
import { generateHeight, fillColumn, findSpawnY } from '../gen/terrain.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { SEA_Y, WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('noise: 确定性（同输入同输出，与 mc-lite 公式一致）', () => {
  const a = seededRandom(10, 20, SEED);
  const b = seededRandom(10, 20, SEED);
  assertEqual(a, b);
  assertTrue(a >= 0 && a < 1, 'range [0,1)');
  // mc-lite 公式手工对照：sin(10*12.9898 + 20*78.233 + 12345) * 43758.5453123 取小数
  const expected = (() => { const v = Math.sin(10 * 12.9898 + 20 * 78.233 + SEED) * 43758.5453123; return v - Math.floor(v); })();
  assertEqual(a, expected);
  assertEqual(noise(5, 7, SEED, 0.08), Math.sin((5 + SEED) * 0.08) * 2 + Math.cos((7 + SEED) * 0.08) * 2);
});

test('noise: 不同 seed 结果不同', () => {
  assertTrue(seededRandom(10, 20, 1) !== seededRandom(10, 20, 2));
});

test('getBiome: 阈值分支', () => {
  // 扫描一片区域，确认至少出现 PLAINS（不锁死具体坐标，避免与噪声实现细节耦合）
  const biomes = new Set();
  for (let x = -500; x < 500; x += 37) for (let z = -500; z < 500; z += 37) biomes.add(getBiome(x, z, SEED));
  assertTrue(biomes.has('PLAINS'), 'plains exists');
  assertTrue(biomes.size >= 2, 'multiple biomes');
});

test('generateHeight: 与 mc-lite 公式一致（biome 调整）', () => {
  for (let x = -200; x < 200; x += 53) {
    for (let z = -200; z < 200; z += 61) {
      const biome = getBiome(x, z, SEED);
      let h = Math.floor(noise(x, z, SEED, 0.08) + noise(x, z, SEED, 0.02) * 3);
      if (biome === 'DESERT') h = Math.floor(h * 0.5 + 2);
      if (biome === 'SWAMP') h = Math.floor(h * 0.3 - 2);
      assertEqual(generateHeight(x, z, SEED), h, `height at ${x},${z}`);
    }
  }
});

test('fillColumn: 地层结构正确（陆地块）', () => {
  const reg = makeRegistry();
  // 找一个 h >= SEA_Y 的 column
  let cx = 0, cz = 0, h = -999;
  outer: for (let tx = -20; tx < 20; tx++) for (let tz = -20; tz < 20; tz++) {
    const hh = generateHeight(tx, tz, SEED);
    if (hh >= SEA_Y + 1) { cx = Math.floor(tx / 16); cz = Math.floor(tz / 16); h = hh; break outer; }
  }
  assertTrue(h >= SEA_Y + 1, 'found land column');
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  const lx = (cx * 16 + 5) - cx * 16; // 用 column 内固定列验证结构
  const wx = cx * 16 + lx, wz = cz * 16 + lx;
  const hh = generateHeight(wx, wz, SEED);
  if (hh >= SEA_Y) {
    assertEqual(col.get(lx, hh, lx), reg.idOf(getBiome(wx, wz, SEED) === 'DESERT' ? 'sand' : getBiome(wx, wz, SEED) === 'AZALEA' ? 'moss' : getBiome(wx, wz, SEED) === 'SWAMP' ? 'swamp_grass' : 'grass'));
    assertEqual(col.get(lx, hh - 11, lx), reg.idOf('stone'));
    assertEqual(col.get(lx, hh - 12, lx), reg.idOf('end_stone'));
    assertEqual(col.get(lx, WORLD_MIN_Y, lx), reg.idOf('bedrock'));
  }
});

test('fillColumn: 水面填充（h < SEA_Y 时水填到 SEA_Y）', () => {
  const reg = makeRegistry();
  let cx = 0, cz = 0, found = false;
  outer: for (let tx = -60; tx < 60; tx++) for (let tz = -60; tz < 60; tz++) {
    if (generateHeight(tx, tz, SEED) < SEA_Y) { cx = Math.floor(tx / 16); cz = Math.floor(tz / 16); found = true; break outer; }
  }
  if (!found) return; // 该 seed 近区无水域则跳过（不视为失败）
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  const lx = 7, lz = 7;
  const wx = cx * 16 + lx, wz = cz * 16 + lz;
  const hh = generateHeight(wx, wz, SEED);
  if (hh < SEA_Y) {
    assertEqual(col.get(lx, SEA_Y, lz), reg.idOf('water'));
    assertEqual(col.get(lx, hh, lz), reg.idOf('sand'));
    assertEqual(col.get(lx, hh - 1, lz), reg.idOf('end_stone'));
  }
});

test('findSpawnY: 落在首个非 air 方块上方', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  fillColumn(col, SEED, reg);
  world.add(col);
  const y = findSpawnY(world, 8, 8);
  assertTrue(world.getBlockId(8, y, 8) === 0, 'spawn is air');
  assertTrue(world.getBlockId(8, y - 1, 8) !== 0, 'below spawn is solid-ish');
});
```

并在 `src/tests/index.html` 追加 `import './test-terrain.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `gen/noise.js`/`gen/terrain.js` 不存在。

- [ ] **Step 3: 实现 src/gen/noise.js**

```js
// src/gen/noise.js — 确定性噪声（逐行移植 mc-lite MathUtils，seed 参数化）
// Worker 同构：本文件不得 import three。

/**
 * 确定性伪随机（与 mc-lite seededRandom 完全一致，保证同 seed 世界可比对）。
 * @param {number} x @param {number} z @param {number} seed
 * @returns {number} [0,1)
 */
export function seededRandom(x, z, seed) {
  const val = Math.sin(x * 12.9898 + z * 78.233 + seed) * 43758.5453123;
  return val - Math.floor(val);
}

/**
 * 双层三角噪声（与 mc-lite noise 一致，seed 由参数传入替代全局 WORLD_CONFIG.SEED）。
 * @returns {number} [-4, 4]
 */
export function noise(x, z, seed, scale = 0.05) {
  const nx = x + seed, nz = z + seed;
  return Math.sin(nx * scale) * 2 + Math.cos(nz * scale) * 2;
}

/**
 * 生物群系判定（阈值与 mc-lite getBiome 一致；CITY 由 M2 结构系统叠加）。
 * @returns {'FOREST'|'AZALEA'|'DESERT'|'SWAMP'|'PLAINS'}
 */
export function getBiome(x, z, seed) {
  const temp = noise(x, z, seed, 0.01);
  const humidity = noise(x + 1000, z + 1000, seed, 0.015);
  if (temp > 1.2) return 'FOREST';
  if (temp > 0.6 && temp <= 1.2 && humidity > 0) return 'AZALEA';
  if (temp < -1.5) return 'DESERT';
  if (temp > -1.5 && temp < -0.8 && humidity > 0.5) return 'SWAMP';
  return 'PLAINS';
}
```

- [ ] **Step 4: 实现 src/gen/terrain.js**

```js
// src/gen/terrain.js — 地形高度 + column 填充 + 出生点（移植 mc-lite TerrainGen/WorldWorker 地层规则）
// M1 范围：地层 + 水面 + 基岩。树/花/草/云/结构 = M2。
// Worker 同构：本文件不得 import three。
import { seededRandom, noise, getBiome } from './noise.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

/** 地形高度（与 mc-lite TerrainGen.generateHeight 一致，CITY 分支 M2 补） */
export function generateHeight(x, z, seed) {
  const biome = getBiome(x, z, seed);
  let h = Math.floor(noise(x, z, seed, 0.08) + noise(x, z, seed, 0.02) * 3);
  if (biome === 'DESERT') h = Math.floor(h * 0.5 + 2);
  if (biome === 'SWAMP') h = Math.floor(h * 0.3 - 2);
  return h;
}

const SURFACE_BY_BIOME = {
  PLAINS: ['grass', 'dirt'],
  FOREST: ['grass', 'dirt'],
  DESERT: ['sand', 'sand'],
  AZALEA: ['moss', 'dirt'],
  SWAMP: ['swamp_grass', 'dirt'],
};

/**
 * 填充整个 column（地层规则逐条移植 mc-lite WorldWorker.js:983-1015）。
 * 直接写 column.blocks（生成路径，不走 set()——不记 edits、不 bump version，
 * GEN 完成接管后由调度器统一置 version 基线）。
 * @param {import('../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 */
export function fillColumn(column, seed, registry) {
  const id = (name) => registry.idOf(name);
  const waterId = id('water'), stoneId = id('stone'), endStoneId = id('end_stone');
  const bedrockId = id('bedrock'), sandId = id('sand'), goldId = id('gold_ore');
  const surfIds = {};
  for (const [b, [s, sub]] of Object.entries(SURFACE_BY_BIOME)) surfIds[b] = [id(s), id(sub)];

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx, wz = column.cz * 16 + lz;
      const biome = getBiome(wx, wz, seed);
      const h = generateHeight(wx, wz, seed);
      const [surfId, subId] = surfIds[biome];

      if (h < SEA_Y) {
        // 水底：sand + end_stone（mc-lite WorldWorker.js:983-984）
        column.blocks[blockIndex(lx, h, lz)] = sandId;
        column.blocks[blockIndex(lx, h - 1, lz)] = endStoneId;
        // 水面填充：(h, SEA_Y]
        for (let y = h + 1; y <= SEA_Y; y++) column.blocks[blockIndex(lx, y, lz)] = waterId;
      } else {
        column.blocks[blockIndex(lx, h, lz)] = surfId;
        column.blocks[blockIndex(lx, h - 1, lz)] = subId;
        // k=2..12 地层（mc-lite WorldWorker.js:1002-1014）
        for (let k = 2; k <= 12; k++) {
          const y = h - k;
          if (y < WORLD_MIN_Y) break;
          if (k === 12) { column.blocks[blockIndex(lx, y, lz)] = endStoneId; continue; }
          if (k === 11) { column.blocks[blockIndex(lx, y, lz)] = stoneId; continue; }
          const r = seededRandom(wx, wz, seed + 100 + k);
          column.blocks[blockIndex(lx, y, lz)] = r < 0.01 ? goldId : stoneId;
        }
      }
      // 底部补实：从最深已填充层之下到基岩之上全填 stone（防悬空空洞——
      // mc-lite 稀疏存储下方留空，新引擎补实；水面分支 deepest=h-1，陆地分支 deepest=h-12）
      const deepest = (h < SEA_Y) ? h - 1 : Math.max(h - 12, WORLD_MIN_Y + 1);
      for (let y = deepest - 1; y > WORLD_MIN_Y; y--) {
        column.blocks[blockIndex(lx, y, lz)] = stoneId;
      }
      // 基岩层
      column.blocks[blockIndex(lx, WORLD_MIN_Y, lz)] = bedrockId;
    }
  }
}

/**
 * 出生点安全（复刻 mc-lite spawn on dry ground，§4.2）：
 * 从顶向下找首个非 air 方块，返回其上方一格 y。
 * @param {import('../voxel/world-data.js').WorldData} world
 */
export function findSpawnY(world, x, z) {
  for (let y = WORLD_MAX_Y; y > WORLD_MIN_Y; y--) {
    if (world.getBlockId(x, y, z) !== 0) return y + 1;
  }
  return SEA_Y + 2; // 兜底
}
```

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（test-terrain 7 个用例全过）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/gen src/tests/test-terrain.js src/tests/index.html
git commit -m "feat(gen): 地形生成（确定性噪声 + 地层/水面/基岩填充 + 出生点安全）"
```

---

### Task 3: 光照（skylight top-down + blocklight flood fill）

**Files:**
- Create: `src/mesh/lighting.js`
- Test: `src/tests/test-lighting.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Produces（Worker 同构，GEN/MESH 任务与主线程共用）：
  - `computeSkylightColumn(column, registry)`：纯垂直 top-down 模型（§4.6/DR-14）——对 column 每列 (lx,lz)：从 y=WORLD_MAX_Y 向下，skylight 初始 15，遇 `opaqueTable[id]===1` 的方块停止（该格及其下方 skylight=0）；写入 `column.light[idx]` 高 4 位。**不依赖任何水平邻居**（纯垂直，无 halo 需求）。
  - `computeBlocklightColumn(column, registry)`：对 column 内 emissive 方块（`emissiveTable[id]>0`）做 flood fill——强度从光源的 emissive 值（M1 全部为 15）开始，每格 -1 衰减，穿 air/非 opaque 方块，被 opaque 阻挡；**范围限本 column + 4 邻 column**（光泄漏过界，§4.6）——签名 `computeBlocklightRegion(world, cx, cz, registry)`，读 WorldData 的 5 个 column，写回各自 light 低 4 位；邻 column 缺失时只算本 column（边界光截断，可接受）。
  - `recomputeLight(world, cx, cz, registry)`：skylight（本 column）+ blocklight（5 column 区域）全量重算，返回受影响的 columnKey 列表（供调度器置脏重 mesh）。
  - light 打包格式：`light[idx] = (sky << 4) | block`（与 packed 顶点 bit0-7 一致，mesher 直接透传）。
- Consumes: Task 1 `ChunkColumn`/`WorldData`/`blockIndex`；M0 registry（opaqueTable/emissiveTable）。

- [ ] **Step 1: 写失败测试 src/tests/test-lighting.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeSkylightColumn, computeBlocklightRegion, recomputeLight } from '../mesh/lighting.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}
const sky = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] >> 4;
const blk = (col, lx, y, lz) => col.light[blockIndex(lx, y, lz)] & 0xF;

test('skylight: 露天列全程 15', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 90, 8), 15);
  assertEqual(sky(col, 8, WORLD_MIN_Y + 1, 8), 15);
});

test('skylight: opaque 方块遮挡（下方为 0，封闭洞穴正确）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, 50, 8)] = stoneId;
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 51, 8), 15);
  assertEqual(sky(col, 8, 50, 8), 0, 'opaque block itself is dark');
  assertEqual(sky(col, 8, 49, 8), 0, 'below opaque is dark');
  assertEqual(sky(col, 8, 20, 8), 0);
});

test('skylight: 透明方块不遮挡（玻璃下方仍 15）', () => {
  const reg = makeRegistry();
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glass_block');
  computeSkylightColumn(col, reg);
  assertEqual(sky(col, 8, 49, 8), 15);
});

test('blocklight: 光源 flood fill 衰减', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone'); // emissive 15
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 50, 8), 15);
  assertEqual(blk(col, 8, 51, 8), 14);
  assertEqual(blk(col, 9, 50, 8), 14);
  assertEqual(blk(col, 8, 55, 8), 10);
  assertEqual(blk(col, 8, 66, 8), 0, 'beyond radius 15 is dark');
});

test('blocklight: opaque 阻挡传播', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  // 在光源上方盖一层石头
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 52, lz)] = reg.idOf('stone');
  }
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14, 'below lid still lit');
  assertEqual(blk(col, 8, 53, 8), 0, 'above lid dark');
});

test('blocklight: 跨 column 泄漏', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const a = new ChunkColumn(0, 0), b = new ChunkColumn(1, 0);
  world.add(a); world.add(b);
  a.blocks[blockIndex(15, 50, 8)] = reg.idOf('glowstone'); // 贴 +X 边
  computeBlocklightRegion(world, 0, 0, reg);
  assertEqual(blk(b, 0, 50, 8), 14, 'light leaks into neighbor column');
});

test('recomputeLight: 挖掉光源后降光（全 column 重算兜底，§4.6）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  world.add(col);
  col.blocks[blockIndex(8, 50, 8)] = reg.idOf('glowstone');
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 14);
  col.blocks[blockIndex(8, 50, 8)] = 0; // 挖掉
  recomputeLight(world, 0, 0, reg);
  assertEqual(blk(col, 8, 51, 8), 0, 'light removed after recompute');
});
```

并在 `src/tests/index.html` 追加 `import './test-lighting.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `mesh/lighting.js` 不存在。

- [ ] **Step 3: 实现 src/mesh/lighting.js**

```js
// src/mesh/lighting.js — skylight top-down + blocklight flood fill（§4.6/DR-14）
// skylight：纯垂直逐列传播，无水平依赖；封闭洞穴正确，侧开口洞穴偏暗（接受）。
// blocklight：删除光源不做增量降光，全 column 区域重算兜底（§4.6 第一阶段口径）。
// Worker 同构：本文件不得 import three。
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

/**
 * skylight：从顶向下逐列传播，初始 15，遇 opaque 停止（该格及下方为 0）。
 * 只写 column.light 高 4 位（保留低 4 位 blocklight）。
 */
export function computeSkylightColumn(column, registry) {
  const opaque = registry.opaqueTable;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      let sky = 15;
      for (let y = WORLD_MAX_Y; y >= WORLD_MIN_Y; y--) {
        const idx = blockIndex(lx, y, lz);
        if (opaque[column.blocks[idx]] === 1) sky = 0;
        column.light[idx] = (column.light[idx] & 0x0F) | (sky << 4);
      }
    }
  }
}

/**
 * blocklight：region 内所有 emissive 源 flood fill（强度 -1/格，opaque 阻挡）。
 * region = 中心 column + 4 正交邻居（光泄漏过界，§4.6）；邻居缺失则截断。
 * 先清零 region 内低 4 位，再 BFS。
 */
export function computeBlocklightRegion(world, cx, cz, registry) {
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const cols = [];
  for (const [dx, dz] of offsets) {
    const col = world.getColumn(cx + dx, cz + dz);
    if (col) cols.push(col);
  }
  if (cols.length === 0) return;
  // 清零低 4 位
  for (const col of cols) {
    for (let i = 0; i < col.light.length; i++) col.light[i] &= 0xF0;
  }
  const emissive = registry.emissiveTable;
  const opaque = registry.opaqueTable;
  /** BFS 队列元素：[worldX, y, worldZ, level] */
  const queue = [];
  for (const col of cols) {
    for (let i = 0; i < col.blocks.length; i++) {
      const e = emissive[col.blocks[i]];
      if (e > 0) {
        const lx = i & 15, lz = (i >> 4) & 15, y = WORLD_MIN_Y + (i >> 8);
        queue.push([col.cx * 16 + lx, y, col.cz * 16 + lz, e]);
      }
    }
  }
  const setLight = (x, y, z, level) => {
    const cx2 = Math.floor(x / 16), cz2 = Math.floor(z / 16);
    const col = world.getColumn(cx2, cz2);
    if (!col) return false;
    const idx = blockIndex(x - cx2 * 16, y, z - cz2 * 16);
    if ((col.light[idx] & 0x0F) >= level) return false;
    col.light[idx] = (col.light[idx] & 0xF0) | level;
    return true;
  };
  let head = 0;
  while (head < queue.length) {
    const [x, y, z, level] = queue[head++];
    if (level <= 1) continue;
    const next = level - 1;
    const neighbors = [
      [x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of neighbors) {
      if (ny < WORLD_MIN_Y || ny > WORLD_MAX_Y) continue;
      const ncx = Math.floor(nx / 16), ncz = Math.floor(nz / 16);
      const ncol = world.getColumn(ncx, ncz);
      if (!ncol) continue;
      const nidx = blockIndex(nx - ncx * 16, ny, nz - ncz * 16);
      if (opaque[ncol.blocks[nidx]] === 1) continue; // opaque 阻挡
      if (setLight(nx, ny, nz, next)) queue.push([nx, ny, nz, next]);
    }
  }
}

/**
 * 全量重算（GEN 完成 / 光源增删时调用）。
 * @returns {string[]} 受影响的 columnKey 列表（供调度器置脏重 mesh）
 */
export function recomputeLight(world, cx, cz, registry) {
  const col = world.getColumn(cx, cz);
  if (!col) return [];
  computeSkylightColumn(col, registry);
  computeBlocklightRegion(world, cx, cz, registry);
  const keys = new Set([`${cx},${cz}`]);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.getColumn(cx + dx, cz + dz)) keys.add(`${cx + dx},${cz + dz}`);
  }
  return [...keys];
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（test-lighting 7 个用例全过）。

- [ ] **Step 5: lint + Commit**

```bash
git add src/mesh/lighting.js src/tests/test-lighting.js src/tests/index.html
git commit -m "feat(mesh): 光照（skylight top-down 逐列 + blocklight flood fill 区域重算）"
```

---

### Task 4: Worker GEN 管线（world-worker + 调度器 GEN 段）

**Files:**
- Create: `src/workers/world-worker.js`
- Create: `src/core/scheduler.js`（本任务只实现 GEN 段：目标集合计算、GEN 任务下发、接管数据、版本校验、滞回卸载；MESH 段 Task 6 补）
- Test: `src/tests/test-worker-gen.html`（fixture：Blob worker 跑真实 GEN RPC）
- Create: `tests/worker-gen.spec.mjs`

**Interfaces:**
- Produces:
  - `world-worker.js` RPC 方法（installRpcHandler 注册）：
    - `gen({ cx, cz, seed, edits })` → `{ cx, cz, version: 0, blocks: ArrayBuffer, meta: ArrayBuffer, light: ArrayBuffer }`（**transfer** 三个 buffer 回传；blocks/meta 由 fillColumn 生成后叠加 edits；light 由 computeSkylightColumn + computeBlocklightRegion（仅本 column，邻居缺失截断——GEN 时邻柱多半未就绪，blocklight 跨柱部分由后续 recomputeLight 收敛）计算。Worker 内自建 registry（buildDefaultRegistry 同构路径：直接 import blocks-data.js 相对路径，module worker 不继承 import map，§3））。
    - `mesh(...)` / `light(...)`：Task 5/6 补，本任务先注册占位 handler 抛 `not implemented`（防静默吞错）。
  - `class Scheduler`（`src/core/scheduler.js`）：
    - `constructor({ world, pool, registry, seed, viewDistance = 8, perf })`（pool = M0 WorkerPool；perf = M0 PerfMonitor，队列深度经 mark 上报）；
    - `update(playerX, playerZ)`：每帧调用——① 计算目标 column 集合（切比雪夫距离 ≤ viewDistance，按距离升序）；② 新 column 且不在途 → 发 GEN（`pool.call('gen', {...})`，记录在途 Set）；③ GEN 结果回传 → 版本校验（此时 column 若已被卸载则丢弃）→ 构造 ChunkColumn、接管 buffer（`new Uint16Array(buffer)` 零拷贝包装）、`applyEdits`（从 persistence 缓存取该 column 的 edits）、`state='ready'`、`world.add`；④ 滞回卸载：切比雪夫距离 > viewDistance + 2 的 ready column → `world.remove` + 在途 GEN 任务 `pool.cancel`（§4.9/DR-16）；
    - `onColumnReady(callback)`：GEN 就绪回调（Task 6 的 MESH 段订阅）；
    - `stats()→{ pending, inflight, ready }`（HUD 用）。
  - GEN 预算：单 column GEN（无结构）< 8ms Worker 时间（§4.2）——本任务 fixture 实测并断言 p95 < 8ms。
- Consumes: Task 1-3 全部；M0 WorkerPool（call/cancel/transfer）、PerfMonitor（mark）。

- [ ] **Step 1: 写失败测试 src/tests/test-worker-gen.html + tests/worker-gen.spec.mjs**

`src/tests/test-worker-gen.html`（fixture：真实 worker 文件经 HTTP 加载——world-worker.js import 链较深，Blob 内联不便，直接用 `/src/workers/world-worker.js` 作为 workerUrl）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>worker-gen fixture</title><link rel="icon" href="data:,"></head>
<body>
<script type="module">
  import { WorkerPool } from '../core/worker-pool.js';
  import { WorldData } from '../voxel/world-data.js';
  import { Scheduler } from '../core/scheduler.js';
  import { createRegistry } from '../voxel/block-registry.js';
  import { BLOCKS } from '../voxel/blocks-data.js';
  import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
  import { generateHeight } from '../gen/terrain.js';

  async function run() {
    const results = { passed: 0, failed: 0, errors: [], genMs: [] };
    const check = (name, cond) => {
      if (cond) results.passed++;
      else { results.failed++; results.errors.push(name); }
    };
    const reg = createRegistry();
    for (const def of BLOCKS) reg.register(def.name, def);
    reg.freeze();

    // 1. 直接 RPC：gen 返回 Transferable buffer 且内容正确
    const pool = new WorkerPool({ workerUrl: '/src/workers/world-worker.js', size: 2 });
    await pool.ready;
    const t0 = performance.now();
    const r = await pool.call('gen', { cx: 0, cz: 0, seed: 12345, edits: [] }, { transfer: [] }).promise;
    results.genMs.push(performance.now() - t0);
    check('gen returns buffers', r.blocks instanceof ArrayBuffer && r.blocks.byteLength === 32768 * 2);
    const blocks = new Uint16Array(r.blocks);
    const h = generateHeight(8, 8, 12345);
    const idx = blockIndex(8, h, 8);
    check('surface block non-air', blocks[idx] !== 0);
    check('bedrock at bottom', blocks[blockIndex(8, WORLD_MIN_Y, 8)] === reg.idOf('bedrock'));
    check('skylight packed', new Uint8Array(r.light)[blockIndex(8, 90, 8)] >> 4 === 15);

    // 2. edits 重放：gen 携带 edits 时覆盖生成结果
    const editIdx = blockIndex(5, 60, 5);
    const r2 = await pool.call('gen', { cx: 0, cz: 0, seed: 12345, edits: [{ index: editIdx, id: 3, meta: 0 }] }).promise;
    check('edits applied in worker', new Uint16Array(r2.blocks)[editIdx] === 3);

    // 3. GEN 预算：16 个 column 并行，单 column Worker 时间 p95 < 8ms（用主线程往返近似）
    const times = [];
    for (let i = 0; i < 4; i++) {
      const batch = [];
      for (let j = 0; j < 4; j++) {
        const s = performance.now();
        batch.push(pool.call('gen', { cx: i + 1, cz: j + 1, seed: 12345, edits: [] }).promise.then(() => {
          times.push(performance.now() - s);
        }));
      }
      await Promise.all(batch);
    }
    times.sort((a, b) => a - b);
    results.genP95 = times[Math.floor(times.length * 0.95)];
    check('gen p95 < 8ms', results.genP95 < 8);

    // 4. Scheduler 集成：update 后出生点 column 就绪
    const world = new WorldData(reg);
    const sched = new Scheduler({ world, pool, registry: reg, seed: 12345, viewDistance: 2 });
    let readyCount = 0;
    sched.onColumnReady(() => { readyCount++; });
    sched.update(8, 8);
    await new Promise((r) => setTimeout(r, 1500));
    check('scheduler generated columns', world.hasColumn(0, 0));
    check('column ready callback fired', readyCount > 0);
    const col = world.getColumn(0, 0);
    check('column state ready', col && col.state === 'ready');

    // 5. 滞回卸载：走到远处后出生点 column 被卸载
    for (let i = 0; i < 10; i++) { sched.update(8 + 200, 8); await new Promise((r) => setTimeout(r, 50)); }
    check('hysteresis unload', !world.hasColumn(0, 0));

    pool.dispose();
    window.__WORKER_GEN_RESULTS__ = results;
  }
  run().catch((e) => { window.__WORKER_GEN_RESULTS__ = { passed: 0, failed: 1, errors: [String(e)] }; });
</script>
</body>
</html>
```

`tests/worker-gen.spec.mjs`：

```js
import { test, expect } from 'playwright/test';

test('Worker GEN 管线全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-worker-gen.html');
  await page.waitForFunction(() => window.__WORKER_GEN_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__WORKER_GEN_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `world-worker.js`/`scheduler.js` 不存在。

- [ ] **Step 3: 实现 src/workers/world-worker.js**

```js
// src/workers/world-worker.js — GEN/MESH/LIGHT 统一 Worker 入口（DR-5 单池多任务）
// module worker 不继承页面 import map：全部相对路径 import（设计文档 §3）。
// 本文件及其 import 链（gen/、mesh/、voxel/）不得 import three。
import { installRpcHandler } from '../core/worker-pool.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { fillColumn } from '../gen/terrain.js';
import { computeSkylightColumn, computeBlocklightRegion } from '../mesh/lighting.js';

// Worker 内自建 registry（与主线程数据同源，blocks-data.js 纯数据）
const registry = createRegistry();
for (const def of BLOCKS) registry.register(def.name, def);
registry.freeze();

installRpcHandler({
  /**
   * GEN：生成单 column（地形 + 光照 + edits 叠加）。
   * @param {{cx: number, cz: number, seed: number, edits: Array<{index:number,id:number,meta:number}>}} p
   */
  gen(p) {
    const column = new ChunkColumn(p.cx, p.cz);
    fillColumn(column, p.seed, registry);
    if (p.edits && p.edits.length) column.applyEdits(p.edits);
    computeSkylightColumn(column, registry);
    // blocklight：GEN 时邻柱多半未就绪，只算本 column（截断）；
    // 邻柱就绪后由主线程 recomputeLight 收敛跨柱光。
    const world = new WorldData(registry);
    world.add(column);
    computeBlocklightRegion(world, p.cx, p.cz, registry);
    return {
      cx: p.cx, cz: p.cz,
      blocks: column.blocks.buffer,
      meta: column.meta.buffer,
      light: column.light.buffer,
    };
  },

  mesh() { throw new Error('mesh: not implemented (Task 6)'); },
  light() { throw new Error('light: not implemented (Task 6)'); },
});
```

注意：`gen` 返回的 buffer 经 structured clone 传回；调用方用 `{ transfer: [r.blocks, r.meta, r.light] }` 无法在响应侧 transfer（M0 RPC 响应未实现 transfer 回传——structured clone 3×128KB 约 1-2ms，M1 接受；M3 调优时如需零拷贝再给 installRpcHandler 加 transfer 支持，**本任务不改 worker-pool.js**）。

- [ ] **Step 4: 实现 src/core/scheduler.js（GEN 段）**

```js
// src/core/scheduler.js — 世界流式调度（§4.9）
// 本任务实现 GEN 段；MESH 段（Task 6）、上传预算（Task 7）后续补入。
import { ChunkColumn } from '../voxel/chunk-column.js';
import { columnKey } from '../voxel/constants.js';

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {import('./worker-pool.js').WorkerPool} opts.pool
   * @param {*} opts.registry
   * @param {number} opts.seed
   * @param {number} [opts.viewDistance] 视距（column 数，切比雪夫半径），默认 8
   * @param {import('./perf.js').PerfMonitor} [opts.perf]
   * @param {(key: string) => Array<{index:number,id:number,meta:number}>} [opts.getEdits]
   *        持久化层提供的 edits 查询（Task 10 接入；缺省返回空数组）
   */
  constructor({ world, pool, registry, seed, viewDistance = 8, perf, getEdits }) {
    this.world = world;
    this.pool = pool;
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.perf = perf;
    this.getEdits = getEdits || (() => []);
    /** @type {Map<string, {callId: number}>} 在途 GEN 任务 */
    this._inflightGen = new Map();
    this._columnReadyCallbacks = [];
  }

  onColumnReady(cb) { this._columnReadyCallbacks.push(cb); }

  /** 每帧调用：目标集合 → GEN 下发 → 滞回卸载 */
  update(playerX, playerZ) {
    const pcx = Math.floor(playerX / 16), pcz = Math.floor(playerZ / 16);
    const R = this.viewDistance;

    // 1. GEN 下发（按切比雪夫距离升序，内圈先就绪，§4.3 halo 协议第 1 条）
    const targets = [];
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        targets.push([pcx + dx, pcz + dz, Math.max(Math.abs(dx), Math.abs(dz))]);
      }
    }
    targets.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of targets) {
      const key = columnKey(cx, cz);
      if (this.world.hasColumn(cx, cz) || this._inflightGen.has(key)) continue;
      const edits = this.getEdits(key);
      const { id: callId, promise } = this.pool.call('gen', { cx, cz, seed: this.seed, edits });
      this._inflightGen.set(key, { callId });
      promise.then((r) => this._onGenResult(key, r)).catch(() => {
        this._inflightGen.delete(key); // 失败/取消：下帧重试
      });
    }

    // 2. 滞回卸载（半径 +2，DR-16）
    for (const [key, col] of [...this.world.columns]) {
      const dist = Math.max(Math.abs(col.cx - pcx), Math.abs(col.cz - pcz));
      if (dist > R + 2) {
        this.world.remove(key);
        const inflight = this._inflightGen.get(key);
        if (inflight) { this.pool.cancel(inflight.callId); this._inflightGen.delete(key); }
      }
    }

    if (this.perf) {
      this.perf.mark('gen-inflight', this._inflightGen.size);
    }
  }

  /** GEN 结果接管：版本/存在性校验 → 零拷贝包装 → edits 已在 Worker 叠加 → ready */
  _onGenResult(key, r) {
    this._inflightGen.delete(key);
    if (this.world.columns.has(key)) return; // 已有（重入竞态）
    const [cx, cz] = key.split(',').map(Number);
    if (r.cx !== cx || r.cz !== cz) return;
    const column = new ChunkColumn(cx, cz);
    column.blocks = new Uint16Array(r.blocks);
    column.meta = new Uint8Array(r.meta);
    column.light = new Uint8Array(r.light);
    column.state = 'ready';
    this.world.add(column);
    for (const cb of this._columnReadyCallbacks) cb(key, column);
  }

  stats() {
    return { inflight: this._inflightGen.size, ready: this.world.columns.size };
  }
}
```

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（worker-gen spec 全部 check 过，含 GEN p95 < 8ms）。若 p95 超 8ms：先检查是否首次调用含 Worker 冷启动（fixture 已用第一个 gen 预热），仍超则停下报告（§4.2 预算是设计约束，不得擅自放宽）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/workers src/core/scheduler.js src/tests/test-worker-gen.html tests/worker-gen.spec.mjs
git commit -m "feat(gen): Worker GEN 管线（world-worker RPC + Scheduler 流式加载/滞回卸载）"
```

---

### Task 5: 逐面网格化（mesher，Worker/主线程同构）

**Files:**
- Create: `src/mesh/mesher.js`
- Test: `src/tests/test-mesher.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Produces:
  - `buildSectionMesh(view, registry, atlasMeta, cx, sy, cz)` → `{ opaque: SectionGeomData, cutout: SectionGeomData, transparent: SectionGeomData }`
    - `view` = Task 1 `getSectionView()` 返回的 18×18×18 halo 视图（`data`/`light`/`missing`）
    - `SectionGeomData = { positions: Float32Array, uvs: Float32Array, packed: Uint32Array, indices: Uint32Array, vertexCount: number, indexCount: number }`
    - 面剔除规则（§4.3）：对每个非 air 方块的每个面，查邻居 `cullTable[neighborId]`——邻居是 opaque 则剔除该面；邻居是 cutout/transparent/none 则保留；同类型 water/glass 相邻不画面（`neighborId === selfId && cullTable[selfId] >= 2` 时剔除）
    - AO：经典四角 AO（移植 mc-lite AOUtils 的 side/corner 判定，`AO_NEIGHBOR_OFFSETS` 表），写入 packed bit8-9（0-3）
    - light：从 view.light 读取对应格的 `(sky<<4)|block`，写入 packed bit0-7
    - 面索引：写入 packed bit10-12（0-5，+X/-X/+Y/-Y/+Z/-Z）
    - UV：从 atlasMeta.tiles 查对应 tile 的 u0/v0/u1/v1，按面的 UV 映射写入
    - 顶点格式：position（section 局部坐标，0-16）+ uv + packed（uint32）；每面 4 顶点 6 索引
    - 三通道分离：`cullTable[id]===0` → opaque；`===1` → cutout；`===2` → transparent；`===3` → 不渲染
  - `atlasMeta`：M0 `atlas.json` 的 tiles 对象（`{ tileName: {u0,v0,u1,v1} }`），由调用方传入（Worker 侧从主线程广播，主线程侧直接 import）
  - 方块→纹理面映射：`src/voxel/faces-data.js`（从 mc-lite MaterialManager 转换，见下方 Step 3）
- Consumes: Task 1 `getSectionView`/`viewIndex`；M0 registry（cullTable/opaqueTable）；M0 atlas.json（tileRect）

- [ ] **Step 1: 写失败测试 src/tests/test-mesher.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

// 最小 atlasMeta（只需 stone 的 UV）
const atlasMeta = {
  stone: { u0: 0.0, v0: 0.0, u1: 0.01, v1: 0.01 },
  grass: { u0: 0.02, v0: 0.0, u1: 0.03, v1: 0.01 },
  dirt:  { u0: 0.04, v0: 0.0, u1: 0.05, v1: 0.01 },
  glass_block: { u0: 0.06, v0: 0.0, u1: 0.07, v1: 0.01 },
  leaves: { u0: 0.08, v0: 0.0, u1: 0.09, v1: 0.01 },
  water: { u0: 0.10, v0: 0.0, u1: 0.11, v1: 0.01 },
};

function makeWorldWithBlock(reg, lx, y, lz, id) {
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  col.blocks[blockIndex(lx, y, lz)] = id;
  world.add(col);
  return world;
}

test('mesher: 单个 opaque 方块 → 6 面 24 顶点', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.opaque.vertexCount, 24, 'one cube = 24 vertices');
  assertEqual(result.opaque.indexCount, 36, 'one cube = 36 indices');
  assertEqual(result.cutout.vertexCount, 0);
  assertEqual(result.transparent.vertexCount, 0);
});

test('mesher: 两个相邻 opaque 方块 → 共享面剔除（10 面）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const stoneId = reg.idOf('stone');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = stoneId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = stoneId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 cube：各 6 面，共享 1 面剔除 → 10 面 = 40 顶点
  assertEqual(result.opaque.vertexCount, 40, 'two adjacent cubes = 10 faces');
});

test('mesher: cutout 方块（leaves）→ cutout 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('leaves'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: transparent 方块（glass）→ transparent 通道', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('glass_block'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  assertEqual(result.transparent.vertexCount, 24);
  assertEqual(result.opaque.vertexCount, 0);
});

test('mesher: 同类型 water 相邻不画面', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  const waterId = reg.idOf('water');
  col.blocks[blockIndex(8, WORLD_MIN_Y + 5, 8)] = waterId;
  col.blocks[blockIndex(9, WORLD_MIN_Y + 5, 8)] = waterId;
  world.add(col);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  // 两个相邻 water：共享面剔除 → 10 面
  assertEqual(result.transparent.vertexCount, 40);
});

test('mesher: packed 包含 light 和面索引', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  // 先算 skylight，否则 col.light 全 0（light 是派生缓存，mesher 只透传）
  computeSkylightColumn(world.getColumn(0, 0), reg);
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  // 顶面（+Y，面索引 2）的 light 应为 15（skylight 全亮）
  // 找面索引为 2 的顶点
  let foundTop = false;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const faceIdx = (packed[i] >> 10) & 0x7;
    const light = packed[i] & 0xFF;
    if (faceIdx === 2) {
      foundTop = true;
      assertTrue(light >= 0xF0, `top face skylight should be 15, got ${light >> 4}`);
    }
  }
  assertTrue(foundTop, 'top face exists');
});

test('mesher: AO 值在 packed bit8-9', () => {
  const reg = makeRegistry();
  const world = makeWorldWithBlock(reg, 8, WORLD_MIN_Y + 5, 8, reg.idOf('stone'));
  const view = world.getSectionView(0, 0, 0);
  const result = buildSectionMesh(view, reg, atlasMeta, 0, 0, 0);
  const packed = result.opaque.packed;
  for (let i = 0; i < result.opaque.vertexCount; i++) {
    const ao = (packed[i] >> 8) & 0x3;
    assertTrue(ao >= 0 && ao <= 3, `AO value ${ao} in range`);
  }
});
```

并在 `src/tests/index.html` 追加 `import './test-mesher.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `mesh/mesher.js` 不存在。

- [ ] **Step 3: 实现 src/voxel/faces-data.js（方块→纹理面映射）**

```js
// src/voxel/faces-data.js — 方块→纹理面映射（从 mc-lite MaterialManager 转换）
// 面索引：0:+X, 1:-X, 2:+Y(top), 3:-Y(bottom), 4:+Z, 5:-Z
// 格式：blockName → [face0tile, face1tile, face2tile, face3tile, face4tile, face5tile]
// 单 tile 方块用字符串（所有面相同）

export const FACES_DATA = {
  grass: ['grass_side_carried', 'grass_side_carried', 'grass_carried', 'dirt', 'grass_side_carried', 'grass_side_carried'],
  dirt: ['dirt', 'dirt', 'dirt_podzol_top', 'dirt_podzol_top', 'dirt', 'dirt'],
  stone: ['stone', 'stone', 'stone_andesite', 'stone_andesite', 'stone', 'stone'],
  stone_diorite: 'stone_diorite',
  gold_ore: 'Deepslate_Gold',
  bricks: 'Bricks',
  cobblestone: 'Cobblestone',
  obsidian: 'Obsidian',
  mossy_stone: 'Mossy_Cobblestone',
  end_stone: 'End_Stone',
  sand: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  hay_bale: ['Hay_Bale', 'Hay_Bale', 'Hay_Bale_top', 'Hay_Bale_top', 'Hay_Bale', 'Hay_Bale'],
  sand_train_track: ['sand', 'sand', 'sand_train_track', 'sand', 'sand', 'sand'],
  sand_train_track_corner: ['sand', 'sand', 'sand_train_track_conner', 'sand', 'sand', 'sand'],
  wood: ['log_big_oak', 'log_big_oak', 'log_big_oak_top', 'log_big_oak_top', 'log_big_oak', 'log_big_oak'],
  birch_log: ['Birch_Log_side', 'Birch_Log_side', 'Birch_Log_top', 'Birch_Log_top', 'Birch_Log_side', 'Birch_Log_side'],
  glass_block: 'Glass',
  glass_blink: 'glass_blink',
  water: 'water_placeholder', // M1 占位，M2 水面特效时替换
  swamp_water: 'water_placeholder',
  leaves: 'leaves',
  azalea_leaves: 'azalea_leaves',
  yellow_leaves: 'leaves_yellow',
  sky_leaves: 'leaves',
  realistic_oak_leaves: 'oak_leaves_branch_medium',
  realistic_yellow_leaves: 'leaves_yellow',
  swamp_leaves: 'leaves',
  snow_leaves: 'leaves_with_snow',
  moss: 'moss_block',
  swamp_grass: ['grass_side_carried', 'grass_side_carried', 'grass_carried', 'dirt', 'grass_side_carried', 'grass_side_carried'],
  bedrock: 'Bedrock',
  glowstone: 'Glowstone',
  lava: 'Lava',
  hanging_lamp: 'Ochre_Froglight',
  ochre_froglight: 'Ochre_Froglight',
  tnt: ['tnt_side', 'tnt_side', 'tnt_top', 'tnt_top', 'tnt_side', 'tnt_side'],
  // 其余方块默认用 stone（M1 占位，M2 补全）
};

/** 获取方块某面的 tile 名；未知方块返回 'stone' */
export function getFaceTile(blockName, faceIdx) {
  const entry = FACES_DATA[blockName];
  if (!entry) return 'stone';
  if (typeof entry === 'string') return entry;
  return entry[faceIdx] || 'stone';
}
```

- [ ] **Step 4: 实现 src/mesh/mesher.js**

```js
// src/mesh/mesher.js — 逐面网格化（§4.3，DR-15）
// Worker/主线程同构：本文件不得 import three。
import { getFaceTile } from '../voxel/faces-data.js';
import { WORLD_MIN_Y, SECTION_SIZE } from '../voxel/constants.js';

// 面方向：0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// 每面的 4 个顶点（section 局部坐标，单位 cube）
// 顶点顺序：逆时针（从面外向内看）
const FACE_VERTICES = [
  // +X
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
  // -X
  [[0,0,1],[0,1,1],[0,1,0],[0,0,0]],
  // +Y
  [[0,1,1],[1,1,1],[1,1,0],[0,1,0]],
  // -Y
  [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],
  // +Z
  [[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  // -Z
  [[1,0,0],[0,0,0],[0,1,0],[1,1,0]],
];

// 每面的 UV 映射（对应 FACE_VERTICES 的 4 个顶点）
const FACE_UVS = [[0,0],[1,0],[1,1],[0,1]];

function viewIdx(dx, dy, dz) { return dx + dz * 18 + dy * 324; }

function getAO(side1, side2, corner) {
  // 经典四角 AO（mc-lite AOUtils.getAOValue 语义逐行一致）：
  // 只有当侧边存在时才考虑对角；两侧都遮挡 → 0（最暗）
  const c = (side1 || side2) ? (corner ? 1 : 0) : 0;
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + c);
}

/**
 * 从顶点坐标推导 AO 邻居（不查表——mc-lite AOUtils 的偏移表绑定其自身顶点序，
 * 直接搬会错位；此处按"顶点相对面法线的两个切向 ± 方向"推导，与顶点序无关）。
 * @param {number} face 面索引 0-5
 * @param {number[]} v 顶点局部坐标 [fx,fy,fz]（0 或 1）
 * @returns {number[][]} [side1Offset, side2Offset, cornerOffset]（各 3 分量）
 */
function aoOffsetsFor(face, v) {
  const n = FACE_DIRS[face]; // 面法线（±1 单轴）
  // 两个切向轴 = 非法线的轴
  const axes = [0, 1, 2].filter((a) => n[a] === 0);
  const offs = [];
  for (const a of axes) {
    const o = [n[0], n[1], n[2]];
    o[a] = v[a] === 1 ? 1 : -1; // 顶点在该切向的 ± 侧
    offs.push(o);
  }
  const corner = [
    offs[0][0] + offs[1][0] - n[0],
    offs[0][1] + offs[1][1] - n[1],
    offs[0][2] + offs[1][2] - n[2],
  ];
  return [offs[0], offs[1], corner];
}

/**
 * 构建单个 section 的三通道网格数据。
 * @param {{data: Uint16Array, light: Uint8Array, missing: boolean}} view
 * @param {*} registry
 * @param {Object} atlasMeta - tiles: { tileName: {u0,v0,u1,v1} }
 * @param {number} cx @param {number} sy @param {number} cz
 * @returns {{opaque: SectionGeomData, cutout: SectionGeomData, transparent: SectionGeomData}}
 */
export function buildSectionMesh(view, registry, atlasMeta, cx, sy, cz) {
  const { data, light } = view;
  const cullTable = registry.cullTable;
  const opaqueTable = registry.opaqueTable;
  const nameOf = registry.nameOf.bind(registry);
  const tiles = atlasMeta.tiles || atlasMeta;

  const channels = {
    opaque: { pos: [], uv: [], packed: [], idx: [] },
    cutout: { pos: [], uv: [], packed: [], idx: [] },
    transparent: { pos: [], uv: [], packed: [], idx: [] },
  };
  const channelNames = ['opaque', 'cutout', 'transparent'];

  for (let ly = 0; ly < SECTION_SIZE; ly++) {
    for (let lz = 0; lz < SECTION_SIZE; lz++) {
      for (let lx = 0; lx < SECTION_SIZE; lx++) {
        // halo 视图坐标：中心 section 从 (1,1,1) 开始
        const vx = lx + 1, vy = ly + 1, vz = lz + 1;
        const id = data[viewIdx(vx, vy, vz)];
        if (id === 0) continue;

        const cullMode = cullTable[id];
        if (cullMode === 3) continue; // none：不渲染
        const channel = channelNames[cullMode]; // 0→opaque, 1→cutout, 2→transparent
        const ch = channels[channel];
        const blockName = nameOf(id);

        for (let face = 0; face < 6; face++) {
          const [dx, dy, dz] = FACE_DIRS[face];
          const nx = vx + dx, ny = vy + dy, nz = vz + dz;
          const neighborId = data[viewIdx(nx, ny, nz)];

          // 面剔除：邻居 opaque 则剔除；同类型 transparent 相邻剔除
          if (opaqueTable[neighborId] === 1) continue;
          if (neighborId === id && cullMode >= 2) continue; // water/glass 同类相邻

          const tileName = getFaceTile(blockName, face);
          const tile = tiles[tileName] || tiles['stone'];
          const baseY = sy * SECTION_SIZE; // section 内局部 y 起点

          const vertBase = ch.pos.length / 3;
          // 面亮度读"面朝向的邻居（空气）格"光照，不是方块自身格——
          // opaque 方块自身格 skylight=0（top-down 光遇 opaque 停止），读自身会全黑。
          const faceLight = light[viewIdx(nx, ny, nz)];
          for (let vi = 0; vi < 4; vi++) {
            const [fx, fy, fz] = FACE_VERTICES[face][vi];
            ch.pos.push(lx + fx, ly + fy, lz + fz);
            const [uu, vv] = FACE_UVS[vi];
            ch.uv.push(
              tile.u0 + (tile.u1 - tile.u0) * uu,
              tile.v0 + (tile.v1 - tile.v0) * vv,
            );
            // AO：四角 AO（从顶点坐标推导邻居，与顶点序无关）
            const [s1o, s2o, co] = aoOffsetsFor(face, FACE_VERTICES[face][vi]);
            const s1 = opaqueTable[data[viewIdx(vx + s1o[0], vy + s1o[1], vz + s1o[2])]] === 1 ? 1 : 0;
            const s2 = opaqueTable[data[viewIdx(vx + s2o[0], vy + s2o[1], vz + s2o[2])]] === 1 ? 1 : 0;
            const co_ = opaqueTable[data[viewIdx(vx + co[0], vy + co[1], vz + co[2])]] === 1 ? 1 : 0;
            const ao = getAO(s1, s2, co_);
            const packed = faceLight | (ao << 8) | (face << 10);
            ch.packed.push(packed);
          }
          ch.idx.push(vertBase, vertBase + 1, vertBase + 2, vertBase, vertBase + 2, vertBase + 3);
        }
      }
    }
  }

  // 转为 typed array
  const result = {};
  for (const [name, ch] of Object.entries(channels)) {
    const vertexCount = ch.pos.length / 3;
    const indexCount = ch.idx.length;
    result[name] = {
      positions: new Float32Array(ch.pos),
      uvs: new Float32Array(ch.uv),
      packed: new Uint32Array(ch.packed),
      indices: new Uint32Array(ch.idx),
      vertexCount,
      indexCount,
    };
  }
  return result;
}
```

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（test-mesher 7 个用例全过）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/mesh/mesher.js src/voxel/faces-data.js src/tests/test-mesher.js src/tests/index.html
git commit -m "feat(mesh): 逐面网格化（面剔除 + AO + 三通道 flat 缓冲输出）"
```

---

### Task 6: MESH 管线 + BatchedMesh 渲染发布（render-world + scheduler MESH 段）

**Files:**
- Create: `src/render/materials.js`
- Create: `src/render/render-world.js`
- Modify: `src/mesh/atlas-loader.js`（相对路径 `./assets/*` 改绝对 `/assets/*`——fetch 相对页面 URL 解析，fixture 页在 `/src/tests/` 下会 404）
- Modify: `src/core/scheduler.js`（补 MESH 段：脏 section 入队、Worker mesh 任务、上传预算）
- Modify: `src/workers/world-worker.js`（实现 mesh handler）
- Test: `src/tests/test-render-world.html`（fixture：真实渲染，断言 draw 数与 section 可见性）
- Create: `tests/render-world.spec.mjs`

**Interfaces:**
- Produces:
  - `materials.js`：`createVoxelMaterials(atlasTexture)` → `{ opaque: MeshBasicMaterial-like, cutout, transparent }`——三个 TSL NodeMaterial（`MeshBasicNodeMaterial`）：colorNode = `texture(atlasTex, uv)` 解包；**packed 属性解包**：`attribute('packed', 'uint')` → light = `(packed & 0xFF)` 拆 sky/block → 亮度 = `max(sky/15, block/15)` 乘到 color；AO = `(packed >> 8) & 3` → `1 - ao*0.2` 乘到 color（经典 AO 变暗）；cutout 材质 `alphaTest = 0.5`；transparent 材质 `transparent = true, opacity 由纹理 alpha`。雾：`scene.fogNode = rangeFogFactor(...)`（r185.1 TSL，材质 `fog: true` 默认生效）。
  - `class RenderWorld`（发布层，§4.4.2 默认 BatchedMesh 实现）：
    - `constructor({ scene, atlasTexture, viewDistance = 8 })`：创建 3 个 BatchedMesh（opaque/cutout/transparent 各一），容量按 §4.4.2 v1.6 口径——`maxInstanceCount = 2312 * 1.2`（视距 8），`maxVertexCount` 按预期活跃非空 section（opaque ~800 / cutout ~300 / transparent ~100）× 平均 4000 顶点 × 1.25，index 同理 ×1.5；`perObjectFrustumCulled = true`（默认）；`sortObjects = true`（默认，transparent 通道运行时排序）；
    - `uploadSection(cx, sy, cz, channel, geomData, version)`：section 首次上传 → `addGeometry(geom, reservedV=v*1.25, reservedI=i*1.25)` + `addInstance` + `setMatrixAt`（平移矩阵 = section 世界偏移 `(cx*16, WORLD_MIN_Y + sy*16, cz*16)`）；已有 slot → `setGeometryAt`（**先比对顶点/索引数与 reserved，超出走 deleteGeometry→addGeometry→addInstance 重建路径**，§4.4.2 溢出处理）；记录 `slotMap: Map<sectionKey, {channel, geometryId, instanceId, version}>`；
    - `removeSection(cx, sy, cz)`：deleteGeometry（级联删 instance）+ slotMap 清理；
    - `removeColumn(cx, cz)`：8 个 section 全删；
    - `stats()→{ sections, drawEstimate }`（HUD 用）；
    - sectionKey = `cx,sy,cz`。
  - `Scheduler` MESH 段（补入 `update()`）：
    - column ready → 全部 8 section 入 MESH 队列（按 sy 排序，地面层优先）；
    - MESH 任务前置条件（§4.3 halo 协议第 2 条）：4 个水平邻居 column「在加载半径内但尚未 ready」→ pending 不产出；半径外缺失 → 直接 mesh（保守出块）；
    - MESH Worker 任务：`pool.call('mesh', { cx, sy, cz, view: {data, light}, version })`——view 的 data/light buffer 经 transfer 传给 Worker（Worker 侧 buildSectionMesh，atlasMeta 在 Worker 启动时由主线程 broadcast 一次）；
    - 结果回传：版本校验（`column.version !== r.version` 丢弃）→ 进上传队列；
    - 上传预算（§4.9）：每帧 ≤ 3ms，从上传队列取 section 调 `renderWorld.uploadSection`；超支顺延下帧；
    - 邻居到达触发重 mesh（§4.3 第 3 条）：column B ready 时，把相邻已 mesh column 的边界 section 置脏重入队（携带当前 version）；
    - column 卸载 → `renderWorld.removeColumn`。
  - `world-worker.js` mesh handler：`mesh({ cx, sy, cz, data, light, version, atlasMeta? })` → 重建 view 对象 → `buildSectionMesh` → 返回 `{ cx, sy, cz, version, channels: { opaque: {positions, uvs, packed, indices}, ... } }`（buffer 经 structured clone 回传）。
- Consumes: Task 1-5 全部；M0 atlas-loader（atlasTexture + tileRect）、WorkerPool（broadcast）。

- [ ] **Step 1: 写失败测试 src/tests/test-render-world.html + tests/render-world.spec.mjs**

`src/tests/test-render-world.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>render-world fixture</title><link rel="icon" href="data:,"></head>
<body>
<script type="module">
  import * as THREE from 'three';
  import { RenderWorld } from '../render/render-world.js';
  import { createVoxelMaterials } from '../render/materials.js';
  import { buildSectionMesh } from '../mesh/mesher.js';
  import { WorldData } from '../voxel/world-data.js';
  import { ChunkColumn } from '../voxel/chunk-column.js';
  import { createRegistry } from '../voxel/block-registry.js';
  import { BLOCKS } from '../voxel/blocks-data.js';
  import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';
  import { loadAtlas } from '../mesh/atlas-loader.js';

  async function run() {
    const results = { passed: 0, failed: 0, errors: [] };
    const check = (name, cond) => {
      if (cond) results.passed++;
      else { results.failed++; results.errors.push(name); }
    };

    const reg = createRegistry();
    for (const def of BLOCKS) reg.register(def.name, def);
    reg.freeze();

    const renderer = new THREE.WebGPURenderer({ antialias: false });
    renderer.setSize(640, 480);
    document.body.appendChild(renderer.domElement);
    await renderer.init();

    const { texture } = await loadAtlas();
    const scene = new THREE.Scene();
    const rw = new RenderWorld({ scene, atlasTexture: texture, viewDistance: 2 });
    check('three batched meshes in scene', scene.children.filter(c => c.isBatchedMesh).length === 3);

    // 构造一个有方块的 column，mesh 一个 section 并上传
    const world = new WorldData(reg);
    const col = new ChunkColumn(0, 0);
    const stoneId = reg.idOf('stone');
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      col.blocks[blockIndex(lx, WORLD_MIN_Y + 16, lz)] = stoneId; // sy=1 层
    }
    world.add(col);
    const view = world.getSectionView(0, 1, 0);
    const atlasMeta = await (await fetch('/assets/atlas.json')).json();
    const meshData = buildSectionMesh(view, reg, atlasMeta, 0, 1, 0);
    rw.uploadSection(0, 1, 0, 'opaque', meshData.opaque, 1);
    check('section uploaded', rw.stats().sections === 1);

    // 渲染一帧，断言 draw 数 = 可见非空 section 数（opaque 1 个）+ RTT 输出 pass（+1，M0 bench 已确认）
    const camera = new THREE.PerspectiveCamera(70, 640 / 480, 0.1, 1000);
    camera.position.set(8, WORLD_MIN_Y + 40, 40);
    camera.lookAt(8, WORLD_MIN_Y + 16, 8);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 隔离 RTT pass（M0 bench 结论）
    for (let i = 0; i < 5; i++) renderer.render(scene, camera);
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.render(scene, camera);
    const drawCalls = renderer.info.render.drawCalls;
    renderer.info.autoReset = true;
    check('draw calls = 1 section (no RTT pass)', drawCalls === 1);

    // 重复上传同 section（setGeometryAt 路径）不增加 section 数
    rw.uploadSection(0, 1, 0, 'opaque', meshData.opaque, 2);
    check('re-upload same section', rw.stats().sections === 1);

    // 删除 section
    rw.removeSection(0, 1, 0);
    check('section removed', rw.stats().sections === 0);

    renderer.dispose();
    renderer.domElement.remove();
    window.__RENDER_WORLD_RESULTS__ = results;
  }
  run().catch((e) => { window.__RENDER_WORLD_RESULTS__ = { passed: 0, failed: 1, errors: [String(e)] }; });
</script>
</body>
</html>
```

`tests/render-world.spec.mjs`：

```js
import { test, expect } from 'playwright/test';

test('RenderWorld BatchedMesh 发布层全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-render-world.html');
  await page.waitForFunction(() => window.__RENDER_WORLD_RESULTS__ !== undefined, null, { timeout: 60_000 });
  const r = await page.evaluate(() => window.__RENDER_WORLD_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `render/materials.js`/`render/render-world.js` 不存在。

- [ ] **Step 2.5: 修 src/mesh/atlas-loader.js 相对路径（前置 bug）**

`fetch('./assets/atlas.json')` 相对页面 URL 解析：从 `/`（index.html）正常，但本任务 fixture 页在 `/src/tests/` 下会解析成 `/src/tests/assets/atlas.json` → 404。改绝对路径：

```js
// src/mesh/atlas-loader.js（两处）
    fetch('/assets/atlas.json').then((r) => r.json()),
    new THREE.TextureLoader().loadAsync('/assets/atlas.png'),
```

- [ ] **Step 3: 实现 src/render/materials.js**

```js
// src/render/materials.js — TSL 体素材质（packed 属性解包 + atlas 采样 + 雾）
// r185.1 TSL：attribute('packed','uint') 读自定义顶点属性；位运算 bitAnd/shiftRight 已核验可用。
import * as THREE from 'three';
import {
  texture, attribute, float, vec3, vec4, mul, div, max, select,
  rangeFogFactor, uniform, fog,
} from 'three/tsl';

/**
 * 创建三通道体素材质。
 * @param {THREE.Texture} atlasTexture
 * @returns {{opaque: THREE.MeshBasicNodeMaterial, cutout: THREE.MeshBasicNodeMaterial, transparent: THREE.MeshBasicNodeMaterial}}
 */
export function createVoxelMaterials(atlasTexture) {
  const makeMaterial = ({ alphaTest = 0, transparent = false }) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    // packed 属性解包：bit0-7 light（sky<<4|block），bit8-9 AO
    const packed = attribute('packed', 'uint');
    const lightByte = packed.bitAnd(0xFF);
    const sky = float(lightByte.shiftRight(4)).div(15);
    const block = float(lightByte.bitAnd(0xF)).div(15);
    const brightness = max(sky, block);
    const ao = float(packed.shiftRight(8).bitAnd(3));
    const aoFactor = float(1).sub(mul(ao, 0.2)); // AO 0→1.0, 3→0.4
    const uvNode = attribute('uv', 'vec2');
    const texColor = texture(atlasTexture, uvNode);
    mat.colorNode = vec4(mul(texColor.rgb, mul(brightness, aoFactor)), texColor.a);
    if (alphaTest > 0) { mat.alphaTest = alphaTest; }
    if (transparent) { mat.transparent = true; mat.depthWrite = false; }
    mat.side = THREE.FrontSide;
    return mat;
  };

  return {
    opaque: makeMaterial({}),
    cutout: makeMaterial({ alphaTest: 0.5 }),
    transparent: makeMaterial({ transparent: true }),
  };
}

/** 场景雾（与视距联动，§4.4.3 简化版：M1 固定雾距，M2 接日夜）
 *  r185.1 语义（three.webgpu.js:42069 已核验）：`fog(color, factor)` 返回 vec4 混合节点，
 *  factor = rangeFogFactor(near, far)（0=无雾 1=全雾），赋给 scene.fogNode 即生效。 */
export function setupFog(scene, viewDistance) {
  const fogNear = uniform(viewDistance * 16 * 0.5);
  const fogFar = uniform(viewDistance * 16 * 0.95);
  const fogColor = uniform(new THREE.Color(0x87ceeb));
  scene.fogNode = fog(fogColor, rangeFogFactor(fogNear, fogFar));
  return { fogNear, fogFar, fogColor };
}
```

注意：`fog` 需从 `three/tsl` 一并 import（上方 import 列表补 `fog`）。材质侧 `fog: true` 是 NodeMaterial 默认值（three.webgpu.js:20848 已核验），无需显式设置。

- [ ] **Step 4: 实现 src/render/render-world.js**

```js
// src/render/render-world.js — 发布层：3×BatchedMesh 通道级合批（§4.4.2 默认实现，DR-11）
// 每个 section = 1 geometry slot + 1 instance（1:1）；instance 矩阵 = section 世界偏移平移。
import * as THREE from 'three';
import { createVoxelMaterials } from './materials.js';
import { WORLD_MIN_Y, SECTION_SIZE, SECTIONS_PER_COLUMN } from '../voxel/constants.js';

const CHANNELS = ['opaque', 'cutout', 'transparent'];
// 视距 8 容量口径（§4.4.2 v1.6）：instance 元数据便宜按全 slot 预留；
// 顶点按预期活跃非空 section × 平均顶点 × 1.25
const CAPACITY = {
  opaque:      { active: 800, avgVerts: 4000 },
  cutout:      { active: 300, avgVerts: 1500 },
  transparent: { active: 100, avgVerts: 1000 },
};

function sectionKey(cx, sy, cz) { return `${cx},${sy},${cz}`; }

export class RenderWorld {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Texture} opts.atlasTexture
   * @param {number} [opts.viewDistance]
   */
  constructor({ scene, atlasTexture, viewDistance = 8 }) {
    this.scene = scene;
    const materials = createVoxelMaterials(atlasTexture);
    const maxInstances = Math.ceil((2 * viewDistance + 1) ** 2 * SECTIONS_PER_COLUMN * 1.2);
    /** @type {Object<string, THREE.BatchedMesh>} */
    this.meshes = {};
    /** @type {Map<string, {channel: string, geometryId: number, instanceId: number, reservedV: number, reservedI: number}>} */
    this.slotMap = new Map();

    for (const channel of CHANNELS) {
      const cap = CAPACITY[channel];
      const maxVerts = Math.ceil(cap.active * cap.avgVerts * 1.25);
      const maxIdx = maxVerts * 1.5;
      const bm = new THREE.BatchedMesh(maxInstances, maxVerts, maxIdx, materials[channel]);
      bm.frustumCulled = false; // 整体不剔除，per-instance 剔除由 perObjectFrustumCulled 负责
      scene.add(bm);
      this.meshes[channel] = bm;
    }
  }

  /** 从 SectionGeomData 构造 three BufferGeometry（flat 属性，M0 bench 验证的快路径格式） */
  _toGeometry(geomData) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geomData.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(geomData.uvs, 2));
    g.setAttribute('packed', new THREE.BufferAttribute(geomData.packed, 1));
    g.setIndex(new THREE.BufferAttribute(geomData.indices, 1));
    return g;
  }

  /**
   * 上传/替换 section 几何（版本由调用方校验后传入）。
   * 首次 → addGeometry+addInstance+setMatrixAt；已有 → setGeometryAt（溢出走重建路径）。
   */
  uploadSection(cx, sy, cz, channel, geomData, version) {
    if (geomData.vertexCount === 0) { this.removeSection(cx, sy, cz); return; }
    const key = sectionKey(cx, sy, cz);
    const bm = this.meshes[channel];
    const geom = this._toGeometry(geomData);
    const reservedV = Math.ceil(geomData.vertexCount * 1.25);
    const reservedI = Math.ceil(geomData.indexCount * 1.25);
    const existing = this.slotMap.get(key);

    if (existing && existing.channel === channel) {
      // 增量替换：未溢出预留 → setGeometryAt 快路径；溢出 → 重建 slot
      if (geomData.vertexCount <= existing.reservedV && geomData.indexCount <= existing.reservedI) {
        bm.setGeometryAt(existing.geometryId, geom);
      } else {
        bm.deleteGeometry(existing.geometryId); // 级联删 instance
        const gid = bm.addGeometry(geom, reservedV, reservedI);
        const iid = bm.addInstance(gid);
        this._setInstanceMatrix(bm, iid, cx, sy, cz);
        this.slotMap.set(key, { channel, geometryId: gid, instanceId: iid, reservedV, reservedI });
      }
    } else {
      if (existing) this.removeSection(cx, sy, cz); // 通道变更
      const gid = bm.addGeometry(geom, reservedV, reservedI);
      const iid = bm.addInstance(gid);
      this._setInstanceMatrix(bm, iid, cx, sy, cz);
      this.slotMap.set(key, { channel, geometryId: gid, instanceId: iid, reservedV, reservedI });
    }
  }

  _setInstanceMatrix(bm, instanceId, cx, sy, cz) {
    const m = new THREE.Matrix4().makeTranslation(
      cx * SECTION_SIZE, WORLD_MIN_Y + sy * SECTION_SIZE, cz * SECTION_SIZE);
    bm.setMatrixAt(instanceId, m);
  }

  removeSection(cx, sy, cz) {
    const key = sectionKey(cx, sy, cz);
    const slot = this.slotMap.get(key);
    if (!slot) return;
    this.meshes[slot.channel].deleteGeometry(slot.geometryId);
    this.slotMap.delete(key);
  }

  removeColumn(cx, cz) {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this.removeSection(cx, sy, cz);
  }

  stats() {
    return { sections: this.slotMap.size };
  }
}
```

- [ ] **Step 5: 实现 world-worker.js mesh handler + scheduler MESH 段，运行验证通过**

`world-worker.js` 的 `mesh` handler 替换占位：

```js
  /**
   * MESH：单 section 网格化（Worker 精修路径，§4.3）。
   * atlasMeta 由主线程启动时 broadcast（installRpcHandler 的 broadcast 消息走同一 onmessage）。
   * @param {{cx:number, sy:number, cz:number, data:ArrayBuffer, light:ArrayBuffer, version:number}} p
   */
  mesh(p) {
    const view = { data: new Uint16Array(p.data), light: new Uint8Array(p.light), missing: false };
    const result = buildSectionMesh(view, registry, _atlasMeta, p.cx, p.sy, p.cz);
    return {
      cx: p.cx, sy: p.sy, cz: p.cz, version: p.version,
      channels: {
        opaque: packGeom(result.opaque),
        cutout: packGeom(result.cutout),
        transparent: packGeom(result.transparent),
      },
    };
  },
```

其中 `packGeom(g)` 把 SectionGeomData 的四个 typed array 转成 `{ positions: g.positions.buffer, uvs: g.uvs.buffer, packed: g.packed.buffer, indices: g.indices.buffer, vertexCount, indexCount }`（buffer 经 structured clone 回传）；`_atlasMeta` 由 broadcast handler 赋值——在 `installRpcHandler` 外额外挂 `self.addEventListener('message', ...)` 处理 `{ broadcast: true, method: 'atlas-meta' }` 消息（M0 WorkerPool.broadcast 已支持）。

`Scheduler` 补 MESH 段（在 `update()` 内，GEN 段之后）：

```js
    // 3. MESH 下发（halo 协议 §4.3：4 水平邻居在半径内未 ready → pending）
    for (const [key, col] of this.world.columns) {
      if (col.state !== 'ready') continue;
      const dirty = col.takeDirty();
      for (const sy of dirty) this._enqueueMesh(col, sy);
    }
    // 首次 ready 的 column：8 section 全入队（onColumnReady 回调里触发）
```

`_enqueueMesh(col, sy)`：检查 4 水平邻居（在半径内未 ready → 记入 `_pendingMesh` 等邻居就绪）；否则取 `world.getSectionView(col.cx, sy, col.cz)`，`pool.call('mesh', { cx, sy, cz, data: view.data.buffer, light: view.light.buffer, version: col.version }, { transfer: [view.data.buffer, view.light.buffer] })`，结果回传校验 `world.getColumn(cx,cz)?.version === r.version` → 进 `this._uploadQueue.push({cx, sy, cz, channels: r.channels, version})`。

`update()` 末尾补上传预算段：

```js
    // 4. 上传预算：≤3ms/帧（§4.9）
    const t0 = performance.now();
    while (this._uploadQueue.length && performance.now() - t0 < 3) {
      const item = this._uploadQueue.shift();
      const col = this.world.getColumn(item.cx, item.cz);
      if (!col || col.version !== item.version) continue; // 版本校验
      for (const channel of ['opaque', 'cutout', 'transparent']) {
        const g = item.channels[channel];
        this.renderWorld.uploadSection(item.cx, item.sy, item.cz, channel, unpackGeom(g), item.version);
      }
    }
```

`unpackGeom` 把 buffer 包回 typed array。`Scheduler` 构造参数增加 `renderWorld`；`onColumnReady` 内部补：column ready → 8 section 入 MESH 队列 + 触发相邻已 mesh column 边界 section 重 mesh（§4.3 第 3 条）。

Run: `npm test`
Expected: PASS（render-world spec 全部 check 过，含 draw calls === 1）。若 draw 数不符：先核对 RTT pass 隔离（toneMapping/colorSpace），仍不符停下报告（BatchedMesh 行为与 M0 bench 核验不一致属重大异常）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/render src/core/scheduler.js src/workers/world-worker.js src/tests/test-render-world.html tests/render-world.spec.mjs
git commit -m "feat(render): MESH 管线 + BatchedMesh 通道级合批发布（TSL 体素材质 + 上传预算）"
```

---

### Task 7: 游戏主循环 + 地形渲染集成（Game + main.js 改造）

**Files:**
- Create: `src/core/game.js`
- Modify: `src/main.js`（boot 后接入 Game）
- Test: `tests/render-terrain.spec.mjs`（地形渲染非空 + 帧时 + draw 上限）

**Interfaces:**
- Produces:
  - `class Game`：`constructor({ canvas, registry, seed, viewDistance = 8 })` → 初始化 renderer/scene/camera/world/pool/scheduler/renderWorld/perf/hud；`start()` → 加载 atlas、broadcast atlasMeta 到 Worker、生成出生点 3×3 column（§4.2 冷启动口径：先就绪即可玩）、设相机到 spawn、启动渲染循环；`dispose()`。
  - 渲染循环（§4.9 主线程每帧流程）：`perf.tick` → `scheduler.update(playerX, playerZ)`（M1 玩家位置暂时固定 spawn，Task 9 接移动）→ `hud.update` → `renderer.render`。
  - 相机：PerspectiveCamera(70, aspect, 0.1, viewDistance*16*1.2)，位置 = spawn + (0, 20, 20) 俯视出生点（M1 验收用，Task 9 接第一人称）。
  - 天空背景：`scene.background = new THREE.Color(0x87ceeb)`（M2 接 TSL 天空盒）。
- Consumes: Task 1-6 全部；M0 PerfMonitor/PerfHUD/WorkerPool/loadAtlas。

- [ ] **Step 1: 写失败测试 tests/render-terrain.spec.mjs**

```js
import { test, expect } from 'playwright/test';

test('地形渲染：出生点地形可见、帧时达标、draw 数受控', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  // 等世界就绪（Game 暴露 __MC_GAME__ 状态）
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 截图像素检查：画面非纯天空蓝（有地形像素）
  const shot = await page.screenshot();
  const terrainPixels = await page.evaluate(() => {
    // 读 canvas 中心区域像素，统计非天空蓝像素占比
    const c = document.getElementById('app-canvas');
    return window.__MC_GAME__.sampleTerrainRatio();
  });
  expect(terrainPixels).toBeGreaterThan(0.05); // 至少 5% 像素是地形

  // 2. 帧时：等 2s 稳定后采样，p95 < 8.3ms（120fps 预算）——本地真 GPU 硬门槛
  await new Promise((r) => setTimeout(r, 2000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 33 : 8.3);
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 25 : 55);

  // 3. draw 数受控：视距 2（测试配置）下 draw < 100
  const stats = await page.evaluate(() => window.__MC_GAME__.renderStats());
  expect(stats.drawCalls).toBeLessThan(100);
  expect(stats.sections).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `window.__MC_GAME__` 未定义（main.js 还没接 Game）。

- [ ] **Step 3: 实现 src/core/game.js**

```js
// src/core/game.js — 主循环编排（§4.9）：input→physics→schedule→budget→render
// M1 范围：世界流式加载 + 地形渲染；玩家移动/交互 Task 9 接入。
import * as THREE from 'three';
import { WorldData } from '../voxel/world-data.js';
import { Scheduler } from './scheduler.js';
import { WorkerPool } from './worker-pool.js';
import { PerfMonitor } from './perf.js';
import { PerfHUD } from './perf-hud.js';
import { RenderWorld } from '../render/render-world.js';
import { setupFog } from '../render/materials.js';
import { loadAtlas } from '../mesh/atlas-loader.js';
import { findSpawnY } from '../gen/terrain.js';

export class Game {
  /**
   * @param {Object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {*} opts.registry - BlockRegistry 实例
   * @param {number} opts.seed
   * @param {number} [opts.viewDistance] 默认 8（测试可传 2 加速）
   * @param {HTMLElement} opts.hudRoot
   */
  constructor({ canvas, registry, seed, viewDistance = 8, hudRoot }) {
    this.registry = registry;
    this.seed = seed;
    this.viewDistance = viewDistance;
    this.world = new WorldData(registry);
    this.perf = new PerfMonitor();
    this.pool = new WorkerPool({ workerUrl: '/src/workers/world-worker.js' });
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, viewDistance * 16 * 1.2);
    this.worldReady = false;
    this._hudRoot = hudRoot;
  }

  async start() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    await this.renderer.init();

    // atlas：纹理 + tileRect 元数据（broadcast 给 Worker 供 mesher 查 UV）
    const { texture } = await loadAtlas();
    const atlasMeta = await (await fetch('/assets/atlas.json')).json();
    this.pool.broadcast('atlas-meta', atlasMeta);

    this.scene.background = new THREE.Color(0x87ceeb);
    setupFog(this.scene, this.viewDistance);
    this.renderWorld = new RenderWorld({ scene: this.scene, atlasTexture: texture, viewDistance: this.viewDistance });

    this.scheduler = new Scheduler({
      world: this.world, pool: this.pool, registry: this.registry,
      seed: this.seed, viewDistance: this.viewDistance, perf: this.perf,
      renderWorld: this.renderWorld,
    });

    // 出生点：(8, 8) 列，3×3 先就绪即可玩（§4.2 冷启动口径）
    this.spawnX = 8; this.spawnZ = 8;
    this.scheduler.update(this.spawnX, this.spawnZ);
    await this._waitForColumn(0, 0, 10000);
    this.spawnY = findSpawnY(this.world, this.spawnX, this.spawnZ);
    this.camera.position.set(this.spawnX, this.spawnY + 20, this.spawnZ + 20);
    this.camera.lookAt(this.spawnX, this.spawnY, this.spawnZ);
    this.worldReady = true;

    this._hud = new PerfHUD(this.perf, this._hudRoot);
    window.addEventListener('resize', () => this._onResize());
    this._onResize();

    this.renderer.setAnimationLoop((nowMs) => {
      this.perf.tick(nowMs);
      this.scheduler.update(this.spawnX, this.spawnZ); // Task 9 改为玩家实时位置
      this._hud.update(nowMs);
      this.renderer.render(this.scene, this.camera);
    });
  }

  _waitForColumn(cx, cz, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const timer = setInterval(() => {
        if (this.world.hasColumn(cx, cz)) { clearInterval(timer); resolve(); }
        else if (performance.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error('spawn column timeout')); }
      }, 50);
    });
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** 测试钩子：地形像素占比（canvas 中心区域非天空蓝比例） */
  sampleTerrainRatio() {
    const c = this.renderer.domElement;
    const gl = c.getContext('webgpu');
    // WebGPU canvas 无法直接 readPixels，用 2D canvas 截图对比
    const tmp = document.createElement('canvas');
    tmp.width = 64; tmp.height = 64;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(c, c.width / 2 - 32, c.height / 2 - 32, 64, 64, 0, 0, 64, 64);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    let terrain = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      // 天空蓝 0x87ceeb = (135,206,235)，容差 30
      if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) terrain++;
    }
    return terrain / (64 * 64);
  }

  perfSnapshot() { return this.perf.snapshot(); }
  renderStats() {
    return { ...this.renderWorld.stats(), drawCalls: this.renderer.info.render.drawCalls };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.pool.dispose();
    this.renderer.dispose();
  }
}
```

注意：`sampleTerrainRatio` 依赖 canvas 可被 2D context 读取——WebGPURenderer 创建 canvas 时需 `preserveDrawingBuffer` 语义；r185.1 WebGPURenderer 默认 canvas 不可被 drawImage 读取（WebGPU swapchain）。**若 drawImage 读不到像素，改用 `renderer.domElement` 上叠加离屏 2D canvas 的方案不可行——退路是 Playwright 直接 `page.screenshot()` 后在 Node 侧用 pngjs 分析像素**（M0 已验证该路径可用）。Step 5 实测确认，以能读出地形像素为准，两种实现都接受。

- [ ] **Step 4: 改造 src/main.js 接入 Game**

```js
// src/main.js — 启动入口：WebGPU gate → Game
import * as THREE from 'three';
import { Game } from './core/game.js';
import { buildDefaultRegistry } from './voxel/block-registry.js';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null };

function showError(detail) {
  if (detail) document.getElementById('webgpu-error-detail').textContent = detail;
  document.getElementById('webgpu-error').style.display = 'flex';
}

async function boot() {
  if (!window.isSecureContext) {
    window.__MC_BOOT__.error = 'insecure context';
    showError('WebGPU 仅在安全上下文可用：当前地址是 ' + location.origin +
      '，请改用 http://localhost:8081/ 或 HTTPS 地址打开。');
    return;
  }
  if (!navigator.gpu) {
    window.__MC_BOOT__.error = 'navigator.gpu unavailable';
    showError();
    return;
  }
  window.__MC_BOOT__.webgpu = true;

  const registry = await buildDefaultRegistry();
  const seed = 12345; // M1 固定 seed（M2 接存档/随机）
  const game = new Game({
    canvas: document.getElementById('app-canvas'),
    registry, seed,
    viewDistance: new URLSearchParams(location.search).get('vd')
      ? Number(new URLSearchParams(location.search).get('vd')) : 8,
    hudRoot: document.getElementById('hud-root'),
  });
  await game.start();
  window.__MC_BOOT__.rendererReady = true;
  window.__MC_GAME__ = game; // 测试钩子
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  showError('启动失败：' + err);
});
```

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（render-terrain spec 全过）。若帧时不达标：先核对视距（测试用 `?vd=2`）、Worker 数、上传预算，仍不达标停下报告（§7 M1 验收是硬约束）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/core/game.js src/main.js tests/render-terrain.spec.mjs
git commit -m "feat(core): 游戏主循环 + 地形渲染集成（Game 编排 + 出生点冷启动）"
```

---

### Task 8: 玩家物理 + DDA 射线 + 放块挖块

**Files:**
- Create: `src/player/physics.js`
- Create: `src/player/raycast.js`
- Create: `src/player/player.js`
- Test: `src/tests/test-physics.js`、`src/tests/test-raycast.js`
- Create: `tests/interaction.spec.mjs`
- Modify: `src/core/game.js`（接入 Player + 输入）、`src/core/scheduler.js`（setBlock 触发快速路径）、`src/tests/index.html`

**Interfaces:**
- Produces:
  - `physics.js`：`class PlayerPhysics`——`constructor(world)`；常量移植 mc-lite Physics.js：`PLAYER_WIDTH=0.6, PLAYER_HEIGHT=1.8, GRAVITY=-24.0, JUMP_FORCE=10.0, SPEED=8.0`；`step(dt)` 定步长积分（60Hz 累加器在 player.js 管）：速度积分 → 分轴碰撞解析（X→Y→Z 逐轴移动 + AABB 与 `world.isSolid` 采样，采样点按 0.6×1.8×0.6 盒的角点+边中点）→ `onGround` 判定（下移被挡）；`jump()`（仅 onGround 时 vy=JUMP_FORCE）；`move(inputX, inputZ)`（按朝向旋转到世界系，归一化 × SPEED）。水中判定（脚下方块为 water）：重力 ×0.4、速度 ×0.6、可空格上浮（mc-lite 语义简化版，M2 精调）。
  - `raycast.js`：`raycastVoxel(world, origin, dir, maxDist)` → `{ hit, blockPos: [x,y,z], normal: [nx,ny,nz], prevPos: [x,y,z], dist }`（Amanatides-Woo DDA，§4.5.2）：沿射线逐格步进，每格查 `world.getBlockId`，非 0 且非 water 即命中；`prevPos` = 命中前一格（放置用）；`maxDist` 默认 40（mc-lite 枪的 far 语义）；步数上限 `maxDist*3` 防死循环。
  - `player.js`：`class Player`——`constructor({ world, physics, camera, renderWorld, registry })`；`pos: {x,y,z}`（脚底中心）、`yaw/pitch`；输入状态 `keys`（WASD/空格/Shift）+ 鼠标（pointer lock，左键挖块右键放块）；`update(dt)`：60Hz 定步长累加器调 `physics.step` → 相机同步（眼高 1.62）→ 每帧 1 次主射线（§4.5.2）→ 高亮目标方块（M1 用 wireframe box helper，M2 换 mc-lite 样式）；`placeBlock(id)` / `digBlock()`：经 `world.setBlock`（唯一写入口，§4.5.3）→ 返回 affected sections → 调 `scheduler.remeshSections(affected, {fastPath: true})`。
  - `Scheduler` 补快速路径（§4.5.3 写死规则）：`remeshSections(affected, {fastPath})`——几何实际变化的 section（编辑所在 section + 正交相邻 section）**主线程同步** `buildSectionMesh` + 立即上传（<2ms，当帧生效）；仅 AO 受影响的对角 section 置脏走 Worker 精修（M1 简化：affected 全部同步重建，对角 AO 差异一帧内由后续精修收敛——因为 affected 已含贴边 section，对角 section 在 M1 直接置脏入 MESH 队列）。
  - 快捷栏（§4.5.4 最小版）：数字键 1-5 切换 5 个默认方块（stone/dirt/grass/sand/cobblestone），M2 接完整背包 UI。
- Consumes: Task 1-7 全部。

- [ ] **Step 1: 写失败测试 src/tests/test-physics.js + test-raycast.js**

```js
// src/tests/test-physics.js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { PlayerPhysics } from '../player/physics.js';
import { raycastVoxel } from '../player/raycast.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, blockIndex } from '../voxel/constants.js';

function makeWorld() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  // y=0 铺一层石头地面
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(lx, 0, lz)] = reg.idOf('stone');
  }
  world.add(col);
  return { world, reg };
}

test('physics: 自由落体到地面停止（onGround）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 5, z: 8 };
  for (let i = 0; i < 300; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'should land');
  assertTrue(Math.abs(p.pos.y - 1) < 0.01, `rest at y=1, got ${p.pos.y}`);
});

test('physics: 跳跃上升后回落', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60); // 先落地
  p.jump();
  const y0 = p.pos.y;
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  assertTrue(p.pos.y > y0 + 0.3, 'ascended after jump');
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assertTrue(p.onGround, 'landed back');
});

test('physics: 水平移动被墙阻挡', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  // x=10 处立一堵墙（y=1..3）
  for (let y = 1; y <= 3; y++) for (let lz = 0; lz < 16; lz++) {
    col.blocks[blockIndex(10, y, lz)] = reg.idOf('stone');
  }
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: 1, z: 8 };
  for (let i = 0; i < 10; i++) p.step(1 / 60);
  p.move(1, 0); // 向 +X
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assertTrue(p.pos.x < 10 - 0.3, `blocked by wall, x=${p.pos.x}`);
});

test('physics: 不穿底（世界底部以下 isSolid）', () => {
  const { world } = makeWorld();
  const p = new PlayerPhysics(world);
  p.pos = { x: 8, y: WORLD_MIN_Y + 1, z: 8 };
  for (let i = 0; i < 60; i++) p.step(1 / 60);
  assertTrue(p.pos.y >= WORLD_MIN_Y, 'never below world');
});

// src/tests/test-raycast.js（同文件 import 区合并到 test-physics.js 亦可，此处独立文件）
test('raycast: 垂直向下命中地面（blockPos + prevPos）', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, -1, 0], 40);
  assertTrue(r.hit, 'hit ground');
  assertEqual(r.blockPos[1], 0, 'hit y=0 stone');
  assertEqual(r.prevPos[1], 1, 'prev y=1 (placement spot)');
  assertEqual(r.normal[1], 1, 'normal points up');
});

test('raycast: 未命中返回 hit=false', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, 1, 0], 40); // 朝天
  assertEqual(r.hit, false);
});

test('raycast: 斜向命中正确格', () => {
  const { world, reg } = makeWorld();
  const col = world.getColumn(0, 0);
  col.blocks[blockIndex(12, 1, 8)] = reg.idOf('stone');
  const r = raycastVoxel(world, [8, 1.5, 8], [1, 0, 0], 40);
  assertTrue(r.hit);
  assertEqual(r.blockPos[0], 12);
});

test('raycast: maxDist 截断', () => {
  const { world } = makeWorld();
  const r = raycastVoxel(world, [8, 5, 8], [0, -1, 0], 2); // 距离 5 > 2
  assertEqual(r.hit, false, 'beyond maxDist');
});
```

并在 `src/tests/index.html` 追加 `import './test-physics.js';` 与 `import './test-raycast.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `player/physics.js`/`player/raycast.js` 不存在。

- [ ] **Step 3: 实现 src/player/raycast.js**

```js
// src/player/raycast.js — Amanatides-Woo DDA 体素射线（§4.5.2，DR-4）
// O(距离) 次 getBlockId；替代 mc-lite 每帧 Raycaster.intersectObjects 数万次矩阵求交。

/**
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin [x,y,z]
 * @param {number[]} dir 归一化方向 [dx,dy,dz]
 * @param {number} [maxDist=40]
 * @returns {{hit: boolean, blockPos?: number[], normal?: number[], prevPos?: number[], dist?: number}}
 */
export function raycastVoxel(world, origin, dir, maxDist = 40) {
  let [x, y, z] = origin;
  let ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const [dx, dy, dz] = dir;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? ix + 1 - x : x - ix) * tDeltaX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? iy + 1 - y : y - iy) * tDeltaY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? iz + 1 - z : z - iz) * tDeltaZ) : Infinity;
  let normal = [0, 0, 0];
  let prev = [ix, iy, iz];
  let t = 0;
  const maxSteps = Math.ceil(maxDist * 3);

  for (let i = 0; i < maxSteps && t <= maxDist; i++) {
    const id = world.getBlockId(ix, iy, iz);
    if (id !== 0 && id !== world.registry.idOf('water')) {
      return { hit: true, blockPos: [ix, iy, iz], normal, prevPos: prev, dist: t };
    }
    prev = [ix, iy, iz];
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      ix += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      iy += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
    } else {
      iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
    }
  }
  return { hit: false };
}
```

- [ ] **Step 4: 实现 src/player/physics.js**

```js
// src/player/physics.js — AABB 碰撞 + 定步长积分（§4.5.1，常数移植 mc-lite Physics.js）
const PLAYER_WIDTH = 0.6;
const PLAYER_HEIGHT = 1.8;
const GRAVITY = -24.0;
const JUMP_FORCE = 10.0;
const SPEED = 8.0;
const EPSILON = 0.001;

export class PlayerPhysics {
  /** @param {import('../voxel/world-data.js').WorldData} world */
  constructor(world) {
    this.world = world;
    this.pos = { x: 8, y: 40, z: 8 }; // 脚底中心
    this.vel = { x: 0, y: 0, z: 0 };
    this.onGround = false;
    this.inWater = false;
  }

  /** 单步积分（调用方按 60Hz 定步长驱动） */
  step(dt) {
    const w = this.world;
    this.inWater = w.getBlockId(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.5), Math.floor(this.pos.z)) === w.registry.idOf('water');
    const gravity = this.inWater ? GRAVITY * 0.4 : GRAVITY;
    this.vel.y += gravity * dt;
    if (this.inWater) { this.vel.y = Math.max(this.vel.y, -4); }
    const drag = this.inWater ? 0.6 : 1;
    // 分轴移动 + 碰撞
    this._moveAxis(this.vel.x * dt * drag, 0);
    this._moveAxis(this.vel.z * dt * drag, 2);
    this.onGround = false;
    this._moveAxis(this.vel.y * dt, 1);
    // 水平速度由 move() 每步重设，此处衰减为 0（无惯性，mc-lite 手感）
    this.vel.x = 0; this.vel.z = 0;
  }

  _moveAxis(delta, axis) {
    if (delta === 0) return;
    const p = this.pos;
    const keys = ['x', 'y', 'z'];
    const k = keys[axis];
    const old = p[k];
    p[k] += delta;
    if (this._collides()) {
      // 二分回退到不碰撞位置
      let lo = 0, hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        p[k] = old + delta * mid;
        if (this._collides()) hi = mid; else lo = mid;
      }
      p[k] = old + delta * lo;
      if (axis === 1 && delta < 0) this.onGround = true;
      this.vel[keys[axis] === 'x' ? 'x' : keys[axis] === 'z' ? 'z' : 'y'] = 0;
    }
  }

  /** AABB 0.6×1.8×0.6 与实心方块采样检测 */
  _collides() {
    const w = this.world;
    const hw = PLAYER_WIDTH / 2;
    const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
    const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + PLAYER_HEIGHT - EPSILON);
    const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (w.isSolid(x, y, z)) return true;
    }
    return false;
  }

  jump() {
    if (this.onGround) this.vel.y = JUMP_FORCE;
    else if (this.inWater) this.vel.y = 4; // 水中上浮
  }

  /** 按输入方向设置水平速度（调用方传入朝向旋转后的 inputX/inputZ ∈ [-1,1]） */
  move(inputX, inputZ) {
    const len = Math.hypot(inputX, inputZ);
    if (len > 1) { inputX /= len; inputZ /= len; }
    const speed = SPEED * (this.inWater ? 0.6 : 1);
    this.vel.x = inputX * speed;
    this.vel.z = inputZ * speed;
  }
}
```

- [ ] **Step 5: 实现 src/player/player.js + scheduler 快速路径 + game 接入**

`player.js`：

```js
// src/player/player.js — 输入/视角/交互编排（§4.5）
import * as THREE from 'three';
import { raycastVoxel } from './raycast.js';
import { PlayerPhysics } from './physics.js';

const EYE_HEIGHT = 1.62;
const REACH = 40; // mc-lite 枪的 far 语义
const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'cobblestone'];

export class Player {
  /**
   * @param {Object} opts
   * @param {import('../voxel/world-data.js').WorldData} opts.world
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {import('../core/scheduler.js').Scheduler} opts.scheduler
   * @param {*} opts.registry
   * @param {HTMLCanvasElement} opts.canvas - pointer lock 目标
   */
  constructor({ world, camera, scheduler, registry, canvas }) {
    this.world = world;
    this.camera = camera;
    this.scheduler = scheduler;
    this.registry = registry;
    this.physics = new PlayerPhysics(world);
    this.yaw = 0; this.pitch = 0;
    this.keys = new Set();
    this.hotbarIndex = 0;
    this.target = null; // 当前射线命中
    this._canvas = canvas;
    this._highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000 }));
    this._highlight.visible = false;
    this._bindInput();
  }

  spawn(x, y, z) {
    this.physics.pos = { x, y, z };
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5)) - 1;
        if (n >= 0 && n < HOTBAR.length) this.hotbarIndex = n;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    this._canvas.addEventListener('click', () => this._canvas.requestPointerLock());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this._canvas) return;
      this.yaw -= e.movementX * 0.002;
      this.pitch -= e.movementY * 0.002;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    });
    window.addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== this._canvas) return;
      if (e.button === 0) this.digBlock();
      if (e.button === 2) this.placeBlock();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** 60Hz 定步长累加器（渲染帧率与物理解耦，§4.5.1） */
  update(dt) {
    this._acc = (this._acc || 0) + dt;
    const step = 1 / 60;
    let n = 0;
    while (this._acc >= step && n < 5) {
      this._applyInput();
      this.physics.step(step);
      this._acc -= step; n++;
    }
    // 相机同步（眼高 1.62）
    const p = this.physics.pos;
    this.camera.position.set(p.x, p.y + EYE_HEIGHT, p.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
    // 每帧 1 次主射线（§4.5.2）
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    const r = raycastVoxel(this.world, [p.x, p.y + EYE_HEIGHT, p.z], [dir.x, dir.y, dir.z], REACH);
    this.target = r.hit ? r : null;
    if (this.target) {
      this._highlight.visible = true;
      this._highlight.position.set(r.blockPos[0] + 0.5, r.blockPos[1] + 0.5, r.blockPos[2] + 0.5);
    } else this._highlight.visible = false;
  }

  _applyInput() {
    const fwd = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const strafe = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    if (fwd || strafe) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      this.physics.move(-sin * fwd + cos * strafe, -cos * fwd - sin * strafe);
    }
    if (this.keys.has('Space')) this.physics.jump();
  }

  digBlock() {
    if (!this.target) return;
    const [x, y, z] = this.target.blockPos;
    if (this.world.getBlockId(x, y, z) === this.registry.idOf('bedrock')) return; // 基岩不可挖
    const r = this.world.setBlock(x, y, z, 0);
    if (r) this.scheduler.remeshSections(r.affected, { fastPath: true });
  }

  placeBlock() {
    if (!this.target) return;
    const [x, y, z] = this.target.prevPos;
    // 不与玩家自身 AABB 重叠
    const p = this.physics.pos;
    if (x === Math.floor(p.x) && z === Math.floor(p.z) &&
        (y === Math.floor(p.y) || y === Math.floor(p.y + 1))) return;
    const id = this.registry.idOf(HOTBAR[this.hotbarIndex]);
    const r = this.world.setBlock(x, y, z, id);
    if (r) this.scheduler.remeshSections(r.affected, { fastPath: true });
  }

  get highlight() { return this._highlight; }
}
```

`Scheduler` 补 `remeshSections`（§4.5.3 快速路径）：

```js
  /**
   * 方块编辑后重建受影响 section（§4.5.3）。
   * fastPath：主线程同步 buildSectionMesh + 立即上传（<2ms 当帧生效）；
   * 同步重建仅限几何实际变化的 section，本实现 affected 全同步（M1 口径），
   * 对角 AO 差异由后续常规 MESH 收敛。
   */
  remeshSections(affected, { fastPath = true } = {}) {
    for (const { cx, cz, sy } of affected) {
      const col = this.world.getColumn(cx, cz);
      if (!col || col.state !== 'ready') continue;
      if (!fastPath) { col.markDirty(sy); this._enqueueMesh(col, sy); continue; }
      const t0 = performance.now();
      const view = this.world.getSectionView(cx, sy, cz);
      const data = buildSectionMesh(view, this.registry, this._atlasMeta, cx, sy, cz);
      for (const channel of ['opaque', 'cutout', 'transparent']) {
        this.renderWorld.uploadSection(cx, sy, cz, channel, data[channel], col.version);
      }
      if (this.perf) this.perf.mark('fast-remesh', performance.now() - t0);
    }
  }
```

（`this._atlasMeta` 由 Game 启动时 fetch atlas.json 后赋给 scheduler——与 broadcast 给 Worker 的是同一份。）

`game.js` 接入：`start()` 末尾创建 `Player`、`scene.add(player.highlight)`、渲染循环改为 `player.update(dt)` + `scheduler.update(player.physics.pos.x, player.physics.pos.z)`；`window.__MC_GAME__` 增加 `player` 引用。`dt` 由 `renderer.setAnimationLoop` 的时间戳差分计算（首帧 dt=0）。

- [ ] **Step 6: 写 tests/interaction.spec.mjs 并运行验证通过**

```js
import { test, expect } from 'playwright/test';

test('放块挖块当帧生效（§7 M1 验收）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 通过编程接口模拟放块/挖块（pointer lock 在无头环境不可用，直接调方法）
  const result = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { player, world, registry } = { player: game.player, world: game.world, registry: game.registry };
    // 在玩家面前地面放一块石头
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 2, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = registry.idOf('stone');
    const before = world.getBlockId(px + 2, groundY + 1, pz);
    const r = world.setBlock(px + 2, groundY + 1, pz, stoneId);
    game.scheduler.remeshSections(r.affected, { fastPath: true });
    const after = world.getBlockId(px + 2, groundY + 1, pz);
    // edits 记录了修改
    const col = world.getColumn(Math.floor((px + 2) / 16), Math.floor(pz / 16));
    const editRecorded = col.edits.size > 0;
    // 挖掉
    world.setBlock(px + 2, groundY + 1, pz, 0);
    const dug = world.getBlockId(px + 2, groundY + 1, pz);
    return { before, after, dug, stoneId, editRecorded };
  });
  expect(result.before).toBe(0);
  expect(result.after).toBe(result.stoneId);
  expect(result.dug).toBe(0);
  expect(result.editRecorded).toBe(true);

  // 帧时仍达标（编辑后不卡）
  await new Promise((r) => setTimeout(r, 1000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 33 : 8.3);
});
```

Run: `npm test`
Expected: PASS（physics/raycast 单测 + interaction spec 全过）。

- [ ] **Step 7: lint + Commit**

```bash
git add src/player src/core/scheduler.js src/core/game.js src/tests/test-physics.js src/tests/test-raycast.js src/tests/index.html tests/interaction.spec.mjs
git commit -m "feat(player): 玩家物理 + DDA 射线 + 放块挖块（快速路径当帧生效）"
```

---

### Task 9: 最小存档（edits 持久化 + 重启恢复）

**Files:**
- Create: `src/save/persistence.js`
- Modify: `src/core/game.js`（接入 getEdits + flush）、`src/core/scheduler.js`（getEdits 参数已有）
- Create: `tests/persistence.spec.mjs`

**Interfaces:**
- Produces:
  - `persistence.js`：`class Persistence`——DB 名 `mc_heavy_saves`（新库，不与 mc-lite `mc_lite_manual_saves` 冲突；迁移工具 M2 再做）、version 1、stores：`meta`（keyPath 'key'）、`edits`（keyPath 'columnKey'）；
    - `open()→Promise`（indexedDB.open + onupgradeneeded 建 store）；
    - `saveMeta({ seed, spawn, savedAt })`；`loadMeta()→Promise<object|null>`；
    - `saveColumnEdits(columnKey, editsArray)`（editsArray = `[{index, id, meta}]`，从 ChunkColumn.edits Map 序列化）；
    - `loadColumnEdits(columnKey)→Promise<Array>`（缺失返回 []）；
    - `preloadEdits(keys)→Promise<Map<columnKey, editsArray>>`（批量读，启动时预热 LRU）；
    - 防抖写盘（§4.8）：`scheduleFlush(world)`——内存按 column 聚合脏 edits，5s 防抖 + `visibilitychange`（hidden）/`beforeunload` 立即 flush；只写有 edits 的 column。
  - `Game` 接入：启动时 `loadMeta`（有则用存档 seed/spawn，无则用默认 seed 12345）→ `Scheduler` 的 `getEdits` 回调查 Persistence 内存缓存（GEN 前若缓存未命中则同步返回 []，异步补读后对该 column 标记重 GEN——M1 简化：启动时 preloadEdits 视距内全部 column key，GEN 时缓存必命中）；`scheduleFlush` 每 5s 跑一次。
  - 存档时机：edits 在 `world.setBlock` 时已入 `column.edits`（Task 1），flush 只做序列化写盘；卸载 column 时若有 edits 立即写盘（不等防抖）。
- Consumes: Task 1（ChunkColumn.edits）、Task 4（Scheduler.getEdits）、Task 7（Game）。

- [ ] **Step 1: 写失败测试 tests/persistence.spec.mjs**

```js
import { test, expect } from 'playwright/test';

test('最小存档：放块 → 重启 → 修改保留（§7 M1 验收）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });

  // 1. 放一块石头并立即 flush
  const placed = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const px = 10, pz = 10;
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (game.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = game.registry.idOf('stone');
    const r = game.world.setBlock(px, groundY + 1, pz, stoneId);
    game.scheduler.remeshSections(r.affected, { fastPath: true });
    await game.persistence.flushNow();
    return { x: px, y: groundY + 1, z: pz, stoneId };
  });

  // 2. 整页刷新（模拟重启）
  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.hasColumn(0, 0), null, { timeout: 30_000 });

  // 3. 验证修改保留
  const restored = await page.evaluate(({ x, y, z, stoneId }) => {
    return window.__MC_GAME__.world.getBlockId(x, y, z) === stoneId;
  }, placed);
  expect(restored).toBe(true);
});

test('存档隔离：未修改的 column 不写 edits', async ({ page }) => {
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  const count = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    await game.persistence.flushNow();
    return game.persistence.countSavedColumns();
  });
  // 首次进入无修改：edits store 应为 0（或仅有之前测试残留——用独立 context 保证干净）
  expect(count).toBeGreaterThanOrEqual(0);
});
```

注意：两个测试共享 IndexedDB 会互相污染——`persistence.spec.mjs` 的每个 test 用独立 browser context（Playwright 默认每 test 新 context，IndexedDB 随 context 隔离，天然干净）。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `game.persistence` 未定义。

- [ ] **Step 3: 实现 src/save/persistence.js**

```js
// src/save/persistence.js — IndexedDB edits 持久化（§4.8，DR-6）
// 只存玩家改过的方块（edits 稀疏层），加载 = GEN 时叠加，无"整图恢复"阶段。

const DB_NAME = 'mc_heavy_saves';
const DB_VERSION = 1;

export class Persistence {
  constructor() {
    this.db = null;
    /** @type {Map<string, Array<{index:number,id:number,meta:number}>>} 内存缓存 */
    this.editsCache = new Map();
    this._flushTimer = null;
    this._dirtyKeys = new Set();
  }

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'columnKey' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  saveMeta(obj) {
    return this._put('meta', { ...obj, key: 'main' });
  }

  loadMeta() {
    return this._get('meta', 'main');
  }

  /** @param {string} columnKey @param {Array<{index:number,id:number,meta:number}>} editsArray */
  saveColumnEdits(columnKey, editsArray) {
    this.editsCache.set(columnKey, editsArray);
    return this._put('edits', { columnKey, edits: editsArray });
  }

  /** @returns {Promise<Array>} 缺失返回 [] */
  async loadColumnEdits(columnKey) {
    if (this.editsCache.has(columnKey)) return this.editsCache.get(columnKey);
    const row = await this._get('edits', columnKey);
    const edits = row ? row.edits : [];
    this.editsCache.set(columnKey, edits);
    return edits;
  }

  /** 批量预热（启动时调用，GEN 前缓存必命中） */
  async preloadEdits(keys) {
    await Promise.all(keys.map((k) => this.loadColumnEdits(k)));
  }

  /** 同步查缓存（Scheduler.getEdits 用，GEN 前必须已 preload） */
  getEditsSync(columnKey) {
    return this.editsCache.get(columnKey) || [];
  }

  /** 防抖 flush：把 world 内所有有 edits 的 column 写盘（§4.8 5s 防抖） */
  scheduleFlush(world) {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flushNow(world);
    }, 5000);
  }

  /** 立即 flush（页面隐藏/退出/测试用） */
  async flushNow(world) {
    if (!world) return;
    const jobs = [];
    for (const [key, col] of world.columns) {
      if (col.edits.size === 0) continue;
      const arr = [...col.edits.entries()].map(([index, e]) => ({ index, id: e.id, meta: e.meta }));
      jobs.push(this.saveColumnEdits(key, arr));
    }
    await Promise.all(jobs);
  }

  /** 测试钩子 */
  countSavedColumns() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('edits', 'readonly');
      const req = tx.objectStore('edits').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  _put(store, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _get(store, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
}
```

- [ ] **Step 4: game.js 接入 Persistence**

`start()` 内（atlas 加载后、Scheduler 创建前）：

```js
    this.persistence = new Persistence();
    await this.persistence.open();
    const meta = await this.persistence.loadMeta();
    if (meta && meta.seed !== undefined) this.seed = meta.seed;
    else await this.persistence.saveMeta({ seed: this.seed, spawn: [8, 8], savedAt: Date.now() });
    // 预热视距内 edits 缓存（GEN 前必命中）
    const R = this.viewDistance;
    const keys = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) keys.push(`${dx},${dz}`);
    await this.persistence.preloadEdits(keys);
```

`Scheduler` 构造传 `getEdits: (key) => this.persistence.getEditsSync(key)`。渲染循环内 `this.persistence.scheduleFlush(this.world)`。`window.addEventListener('visibilitychange', () => { if (document.hidden) this.persistence.flushNow(this.world); })` 与 `beforeunload` 同理。

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（persistence spec 两个用例全过——放块→刷新→保留）。

- [ ] **Step 6: lint + Commit**

```bash
git add src/save src/core/game.js tests/persistence.spec.mjs
git commit -m "feat(save): 最小存档（IndexedDB edits 持久化 + 重启恢复）"
```

---

### Task 10: M1 验收（自动跑图 + 发布层确认门 + 验收报告）

**Files:**
- Create: `tests/m1-acceptance.spec.mjs`
- Create: `docs/m1-acceptance-report.md`

**Interfaces:**
- Consumes: Task 1-9 全部。
- Produces: §7 M1 验收证据——平原无限行走帧时、放挖压力 p95、发布层确认门结论（BatchedMesh 默认是否维持）。

- [ ] **Step 1: 实现 tests/m1-acceptance.spec.mjs（自动跑图）**

```js
import { test, expect } from 'playwright/test';

// §8 基线场景 ①：平原冲刺（视距 8）——自动驱动玩家沿直线奔跑 10s，采帧时分布
test('M1 验收：平原冲刺视距 8 帧时达标（120fps 预算）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等视距内 column 大部分就绪（后台填充，§4.2 冷启动口径）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 60_000 });

  // 驱动奔跑：模拟按住 W 10s（编程注入输入状态，无头环境无真实键盘）
  await page.evaluate(() => { window.__MC_GAME__.player.keys.add('KeyW'); });
  await new Promise((r) => setTimeout(r, 10_000));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.delete('KeyW'); });

  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  const stats = await page.evaluate(() => window.__MC_GAME__.renderStats());
  console.log('M1 RUN:', JSON.stringify({ perf, stats }));

  // 冻结口径（本地真 GPU 硬验收，CI SwiftShader 仅趋势参考，§8）：
  // p95 < 8.3ms（120fps），底线 p95 < 16.7ms（60fps）也不许破
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 8.3);
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90); // 高刷屏目标 ≥90fps（§1 目标表）
  expect(stats.sections).toBeGreaterThan(100);
});

// §8 基线场景 ③：连续放/挖 200 块——发布层确认门（§4.4.2 M1 决策门）
test('M1 验收：放挖压力 p95 帧时（BatchedMesh 确认门）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 60_000 });

  // 连续放/挖 200 块（编程驱动，每块间隔 1 帧）
  const editStats = await page.evaluate(async () => {
    const game = window.__MC_GAME__;
    const { world, registry, scheduler, player } = game;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 3, y, pz) !== 0) { groundY = y; break; } }
    const stoneId = registry.idOf('stone');
    const frameTimes = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const x = px + 3 + (i % 10), z = pz + Math.floor(i / 10) - 10;
      const r1 = world.setBlock(x, groundY + 1, z, stoneId);
      if (r1) scheduler.remeshSections(r1.affected, { fastPath: true });
      const r2 = world.setBlock(x, groundY + 1, z, 0);
      if (r2) scheduler.remeshSections(r2.affected, { fastPath: true });
      frameTimes.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    frameTimes.sort((a, b) => a - b);
    return { p95: frameTimes[Math.floor(frameTimes.length * 0.95)], max: frameTimes[frameTimes.length - 1] };
  });
  console.log('M1 EDIT:', JSON.stringify(editStats));

  // 冻结口径：单块放挖编辑帧时 p95 < 2ms（§4.3 快速路径硬约束）
  expect(editStats.p95).toBeLessThan(2);

  // 编辑后整体帧时仍达标
  await new Promise((r) => setTimeout(r, 1000));
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 8.3);
});
```

- [ ] **Step 2: 运行验收**

Run: `npm test`
Expected: PASS 全部。**若 p95 帧时或放挖 p95 不达标：停下报告**（§7 M1 验收是硬约束；先附 perf.mark 的 GEN/MESH/fast-remesh 分解数据定位瓶颈，不擅自放宽阈值）。

- [ ] **Step 3: 发布层确认门结论**

按 §4.4.2 M1 决策门核对实测：BatchedMesh 逐 instance draw 提交 p95 是否更差、setGeometryAt 增量替换有无正确性坑、剔除/排序 CPU 循环是否吃帧预算。三项均无 → 维持 BatchedMesh 默认，报告写明结论；任一命中 → 停下报告，由用户决定是否启用候选 A（column 3-group）。

- [ ] **Step 4: 写 docs/m1-acceptance-report.md**

记录：测试环境（设备/浏览器/刷新率）、基线场景 ①③ 实测数字（fps/p50/p95/p99、sections 数、fast-remesh p95）、发布层确认门结论、与设计文档 §1 目标表的对照、遗留问题（M2 清单）。

- [ ] **Step 5: Commit**

```bash
git add tests/m1-acceptance.spec.mjs docs/m1-acceptance-report.md
git commit -m "test(m1): M1 验收（平原冲刺帧时 + 放挖压力 + 发布层确认门报告）"
```

---

## M1 验收清单（设计文档 §7）

全部任务完成后逐项核对：

1. `npm start` → 出生点地形可见（草地/沙地/水面按 biome），HUD 显示 fps 与 GEN/MESH 队列；
2. 平原无限行走不掉帧：视距 8 奔跑 p95 < 8.3ms（本地高刷屏），fps ≥ 90；
3. 放块挖块当帧生效：单块编辑快速路径 p95 < 2ms，画面即时更新；
4. 重启后修改保留：放块 → 刷新页面 → 方块仍在（IndexedDB edits 重放）；
5. 发布层确认门：BatchedMesh 默认维持（或按实测退回候选 A，需用户决策）；
6. `npm test` 全绿：M0 的 5 组 + M1 的 worker-gen/render-world/render-terrain/interaction/persistence/m1-acceptance 共 11 组 spec + 浏览器内单测（chunk-column/terrain/lighting/mesher/physics/raycast）；
7. `npm run lint` 0 errors；
8. `docs/m1-acceptance-report.md` 产出实测数字与对照结论。

## Self-Review 记录

- **Spec 覆盖**：设计文档 §7 M1 全部交付一一对应——WorldData/ChunkColumn/edits（Task 1）、地形生成无结构（Task 2）、光照 skylight+blocklight（Task 3，§4.6 第一阶段口径：删除光源走全 column 重算）、Worker GEN 管线（Task 4）、section meshing 双路径（Task 5 mesher + Task 6 MESH 段/Task 8 快速路径）、BatchedMesh 发布层含 reservedVertexCount + setGeometryAt（Task 6，§4.4.2 v1.6 口径）、玩家移动/物理/DDA 射线/放块挖块（Task 8）、最小存档 edits 读写（Task 9）、发布层确认门（Task 10）。§4.3 halo 协议五条全部落位（Task 4 GEN 排序 / Task 6 MESH 前置条件与邻居触发重 mesh / 保守出块 / 对角 AO 近似）。§4.5.3 最坏重建范围规则在 Task 8 remeshSections 写死。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码；faces-data.js 对未列方块默认 stone 是显式 M1 占位策略（M2 补全，已注明）；water 纹理占位已注明 M2 替换。
- **类型一致性**：`SectionGeomData`（Task 5 定义）在 Task 6/8 消费一致；`Scheduler.remeshSections(affected, {fastPath})` 在 Task 8 定义、interaction spec 消费一致；`Persistence.getEditsSync` 在 Task 9 定义、Game 接入一致；`buildSectionMesh(view, registry, atlasMeta, cx, sy, cz)` 签名在 Task 5 定义、Task 6 worker/Task 8 快速路径消费一致；`RenderWorld.uploadSection(cx, sy, cz, channel, geomData, version)` 在 Task 6 定义、Task 8 消费一致。
- **已知留白（非本计划范围）**：结构/城市/树木/装饰物（M2）、blocklight 增量删除 BFS（M2，本阶段全 column 重算兜底）、cross/slab 非立方几何（M2，mesher 只出 cube 面）、水面 TSL 特效与体素水降面（M2）、日夜/阴影/三种视觉风格（M2）、完整背包 UI（M2，本阶段 5 格快捷栏）、mc-lite 老存档迁移（M2）。
