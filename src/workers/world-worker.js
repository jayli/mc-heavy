// src/workers/world-worker.js — GEN/MESH/LIGHT 统一 Worker 入口（DR-5 单池多任务）
// module worker 不继承页面 import map：全部相对路径 import（设计文档 §3）。
// 本文件及其 import 链（gen/、mesh/、voxel/）不得 import three。
import { installRpcHandler } from '../core/worker-pool.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import { preloadStructures } from '../gen/structures/structure-json.js';
import { SCATTER_JSON_TYPES } from '../gen/structures/scatter.js';
import { loadGiantTrees } from '../gen/structures/giant-trees.js';
import { loadAzaleaTrees } from '../gen/structures/azalea-trees.js';
// M6 ai 分支：全部逻辑走 `computeAiUpdates`（同构纯函数，红线 8）。
// 它内部 import `zombie-config.js` 的冻结玩法数据，故本文件不再直接 import ZOMBIE。
import { computeAiUpdates } from '../entities/zombies/zombie-system.js';
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion } from '../mesh/lighting.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { setDebugFlags } from '../core/debug-config.js';

// Worker 内自建 registry（与主线程数据同源，blocks-data.js 纯数据）
const registry = createRegistry();
for (const def of BLOCKS) registry.register(def.name, def);
registry.freeze();

/**
 * 撒布结构 JSON 预热（worker 加载期发起，**不 await** —— 见下）。
 *
 * 为什么需要预热：实测冷 fetch 并行 **3.1ms**（flowerBed 2.9 / uglyHouse 2.8 / tank 2.8 …）。
 * 若由首个 GEN 任务触发，该任务的耗时就含这笔一次性成本 —— `structure-gen` fixture 的
 * 16 column 并行 p95 正好抓到首批的冷启动离群值（实测 18~20ms vs 稳态 0.8~2.6ms），
 * 撞破 §4.2 的 8ms 冻结预算。
 *
 * ⚠️ **不能写成 `await preloadStructures(...)`（top-level await）**：await 期间
 * `installRpcHandler` 还没执行 → `self.onmessage` 未注册 → 早到的 RPC 消息被**丢弃**
 * （HTML 规范：无 listener 时消息丢弃，不排队）。实测首个 `layout` RPC 4s 无响应 → 死锁。
 *
 * 正确做法 = 「发起但不 await」+ 由**首个被调用的 handler（layout）await 同一个 promise**：
 * ① `installRpcHandler` 立即注册 → 消息不丢；② fixture/主线程总是先发 `layout` RPC，
 * 它 await 本 promise → 返回时预热已完成；③ 后续 GEN 的 `preloadStructures` 全部 cache 命中
 * （`loadStructure` 用 `loading` Map 缓存 in-flight promise，structure-json.js:45-66，
 * 不重复 fetch）→ GEN 计时路径不含这笔成本。这是确定性的（不依赖时间差竞态）。
 *
 * 稳态无影响：cache 命中后 `preloadStructures` ≈ 0ms（bench 实测 fps 110~120，无回退）。
 */
const scatterPreloadPromise = preloadStructures(SCATTER_JSON_TYPES);

/**
 * 巨树变体预热（同手法：发起但不 await；layout 与 gen 入口 await 同一个 promise）。
 * 实测不预热时每个 Worker 首个 GEN 要付 fetch+解析，`structure-gen` fixture 的 genP95 从 ~9ms 涨到 ~12ms。
 */
const giantPreloadPromise = loadGiantTrees();

/**
 * 杜鹃树变体预热（同手法：发起但不 await；layout 与 gen 入口 await 同一个 promise）。
 * ⚠️ 不预热的话每个新 Worker 的首个 GEN 要多付一次冷 fetch+解析 —— 与巨树同一条理由
 * （实测使 structure-gen 的 genP95 从 ~9ms 涨到 ~12ms，撞破 10ms 门）。
 */
const azaleaPreloadPromise = loadAzaleaTrees();

// atlasMeta 由主线程启动时 broadcast（'atlas-meta' handler 赋值）
let _atlasMeta = null;

/** SectionGeomData → 可 transfer 的 buffer 形式 */
function packGeom(g) {
  return {
    positions: g.positions.buffer, uvs: g.uvs.buffer,
    packed: g.packed.buffer, indices: g.indices.buffer,
    vertexCount: g.vertexCount, indexCount: g.indexCount,
  };
}

installRpcHandler({
  /**
   * GEN：生成单 column（地形 + 结构 + 光照 + edits 叠加）。
   * layouts：查询域内 region 布局（主线程 StructureIndex 缓存后下发，DR-13）。
   * @param {{cx: number, cz: number, seed: number, edits: Array<{index:number,id:number,meta:number}>, layouts?: Array<Object>}} p
   */
  async gen(p) {
    // 安全网：多 worker 场景下某个 worker 可能从未收到过 layout 任务却先收到 gen
    // （pool 按轮转分发，layout 覆盖不保证逐 worker）。此处 await 同一个预热 promise ——
    // 已 resolve 时是微任务（≈0 成本），未完成时才等剩余 fetch，确保 rasterize 不静默跳过。
    await scatterPreloadPromise.catch(() => {});
    await giantPreloadPromise.catch(() => {});
    await azaleaPreloadPromise.catch(() => {});
    const column = new ChunkColumn(p.cx, p.cz);
    fillColumn(column, p.seed, registry);
    carveCaves(column, p.seed);
    await applyStructuresToColumn(column, p.seed, registry, p.layouts);
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

  /**
   * MESH：单 section 网格化（Worker 精修路径，§4.3）。
   * atlasMeta 由主线程启动时 broadcast。meta：朝向元数据（朝向渲染消费，§4.3）。
   * @param {{cx:number, sy:number, cz:number, data:ArrayBuffer, light:ArrayBuffer, meta?:ArrayBuffer, version:number}} p
   */
  mesh(p) {
    const view = {
      data: new Uint16Array(p.data),
      light: new Uint8Array(p.light),
      meta: p.meta ? new Uint8Array(p.meta) : undefined,
      missing: false,
    };
    const result = buildSectionMesh(view, registry, _atlasMeta || {}, p.cx, p.sy, p.cz);
    return {
      cx: p.cx, sy: p.sy, cz: p.cz, version: p.version,
      channels: {
        opaque: packGeom(result.opaque),
        cutout: packGeom(result.cutout),
        transparent: packGeom(result.transparent),
      },
      stats: result.stats,
    };
  },

  /**
   * LIGHT：区域光照重算（skylight 垂直+水平扩散 + blocklight flood fill，§4.6）。
   * 主线程编辑/邻居到达后异步收敛用——区域重算 ~5ms，不在主线程跑（守帧预算）。
   *
   * 回包形状（2026-10-21 改）：**只回中心列的 light** + 本次参与计算的各输入列 version。
   * 为什么不回 3×3 的 9 份 light：写回协议是「中心权威」（邻列的 3×3 结果是截断的、只能参与
   * 计算不能写回，见 scheduler `_onLightResult`），传它们纯属浪费 —— 入队范围扩到 3×3 后
   * 会把 RPC 出参从 32KB 推到 288KB/次。实测 RPC 往返（交替多轮取中位）：9 列 **7.8ms /
   * 0.59MB 入**，25 列 9.8ms / 1.64MB —— 区域变大**并未增加**总载荷。
   * @param {{cx:number, cz:number, columns: Array<{cx:number, cz:number, version:number, blocks:ArrayBuffer}>}} p
   */
  light(p) {
    const world = new WorldData(registry);
    let center = null;
    const inputs = [];
    for (const c of p.columns) {
      const col = new ChunkColumn(c.cx, c.cz);
      col.blocks = new Uint16Array(c.blocks);
      col.version = c.version;
      world.add(col);
      inputs.push({ cx: col.cx, cz: col.cz, version: c.version });
      if (col.cx === p.cx && col.cz === p.cz) center = col;
    }
    computeSkylightRegion(world, p.cx, p.cz, registry);
    computeBlocklightRegion(world, p.cx, p.cz, registry);
    return {
      cx: p.cx, cz: p.cz,
      // 中心列不在送来的列里（调用方漏送）→ light 为 null，主线程按「无结果」处理
      light: center ? center.light.buffer : null,
      version: center ? center.version : undefined,
      inputs,
    };
  },

  /**
   * layout：region 结构布局（确定性，seed 驱动）。
   * 候选扫描较重（城市放置算法），只在 Worker 算一次，主线程缓存后随 GEN 下发（§4.2 DR-13）。
   * @param {{regionX: number, regionZ: number, seed: number}} p
   */
  async layout(p) {
    // await 撒布 JSON 预热：主线程总是先发 layout RPC（StructureIndex.dispatch 先于 GEN），
    // 本 handler 返回时预热已完成 → 后续 gen 的 preloadStructures 全 cache 命中，
    // GEN 计时路径不含冷 fetch 成本（确定性，不依赖时间差竞态；详见文件头预热注释）。
    // 预热失败不阻断 layout（结构 JSON 缺失会让 rasterize 静默跳过，但布局本身仍可用）。
    await scatterPreloadPromise.catch(() => {});
    await giantPreloadPromise.catch(() => {});
    await azaleaPreloadPromise.catch(() => {});
    // 预热城市 bounds 缓存：`buildCityLayout` 实测 10~12ms，绝不能落进首个 GEN 的计时
    // 路径（`structure-gen` fixture 的 genP95 门是 10ms）。`layout` 入口是唯一保证
    // 「先于 GEN、且本 Worker 一定会走到」的位置（与上面两个预载 promise 同处）。
    // 巨型金字塔的候选层读这个缓存判断「占地是否在城市内」。
    getCityBoundsForSeed(p.seed);
    return computeRegionLayout(p.regionX, p.regionZ, p.seed);
  },

  /**
   * atlas-meta：主线程启动时 broadcast 一次（WorkerPool.broadcast 走 __rpc 通道，
   * id=0 的回包会被 pool 忽略）。
   * @param {{tiles: Object}} p
   */
  'atlas-meta'(p) {
    _atlasMeta = p;
    return true;
  },

  /**
   * debug-flags：主线程启动时 broadcast 一次（调试开关，§4.9）。
   * mesher 与主线程快速路径同构生效——关闭 worldStats 时热循环跳过计数。
   * @param {{worldStats?: boolean}} p
   */
  'debug-flags'(p) {
    setDebugFlags(p);
    return true;
  },

  /**
   * AI：丧尸追逐意图（M6 规格 §2）。**在既有 message switch 增加分支，不新建 Worker**
   * （红线 3 + M5 规格 §3：Worker 创建入口唯一 = `core/worker-pool.js`）。
   *
   * 输入/输出仅为可 clone 的 number/object（结构化克隆）—— **不读世界、不传局部体素 view**：
   * 本 handler 只算朝玩家的归一化水平速度。重力/AABB 碰撞/step-up 一律由主线程物理用
   * `world.isSolid()` 做（worker 里没有世界数据，也不该有）。
   *
   * 每 0.05 秒一条批量 RPC，承载全部距玩家 ≤60 格的活尸；主线程回包时逐个验 `{id,generation}`
   * （红线 7 版本协议）。距离 >80（感知范围）输出 idle/零速度 —— 60 格是**预算门**（超出的
   * 丧尸根本不进批次），80 格是**感知门**（进了批次但太远则不追）。
   *
   * @param {{playerPosition: number[], dt: number,
   *          zombies: Array<{id: string, generation: number, position: number[], yaw: number, mode: string}>}} p
   * @returns {{updates: Array<{id: string, generation: number, vx: number, vz: number, mode: string}>}}
   */
  ai(p) {
    // 全部逻辑走同构纯函数 `computeAiUpdates`（红线 8）—— worker 与浏览器内单测共用同一份，
    // 避免「测试与真实接线口径不一致」的盲区（CLAUDE.md 活跃约束：fake pool 曾让纯逻辑测试
    // 全绿而真实接线丢回包）。含追逐（感知门内归一化方向 × speed）+ 实体间排斥力叠加。
    return computeAiUpdates(p);
  },
});
