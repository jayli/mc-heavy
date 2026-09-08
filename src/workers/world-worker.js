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
import { preloadStructures } from '../gen/structures/structure-json.js';
import { SCATTER_JSON_TYPES } from '../gen/structures/scatter.js';
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
   * 主线程编辑/邻居到达后异步收敛用——区域重算 ~4ms，不在主线程跑（守帧预算）。
   * @param {{cx:number, cz:number, columns: Array<{cx:number, cz:number, version:number, blocks:ArrayBuffer}>}} p
   */
  light(p) {
    const world = new WorldData(registry);
    const cols = [];
    for (const c of p.columns) {
      const col = new ChunkColumn(c.cx, c.cz);
      col.blocks = new Uint16Array(c.blocks);
      col.version = c.version;
      world.add(col);
      cols.push(col);
    }
    computeSkylightRegion(world, p.cx, p.cz, registry);
    computeBlocklightRegion(world, p.cx, p.cz, registry);
    return {
      cx: p.cx, cz: p.cz,
      results: cols.map((col) => ({ cx: col.cx, cz: col.cz, version: col.version, light: col.light.buffer })),
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
});
