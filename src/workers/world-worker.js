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
import { computeSkylightColumn, computeSkylightRegion, computeBlocklightRegion } from '../mesh/lighting.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { setDebugFlags } from '../core/debug-config.js';

// Worker 内自建 registry（与主线程数据同源，blocks-data.js 纯数据）
const registry = createRegistry();
for (const def of BLOCKS) registry.register(def.name, def);
registry.freeze();

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
  layout(p) {
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
