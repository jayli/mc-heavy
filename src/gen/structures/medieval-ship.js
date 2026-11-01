// src/gen/structures/medieval-ship.js — 中世纪船落点（Medieval Ship Epic）
//
// 需求（用户 2026-11-01）：把 Ships & Boats Pack 里最大的船（Medieval Ship，1264 格）
// 搬进游戏，生成到浅水高台地图的水域里。船要完整落在水里（与相邻地图水域接壤也行），
// 不与其他实体重叠（不接触高台等）。只用现有方块，唯一例外是新增一个倒置台阶。
// 台阶与栏杆都有方向，方向不能错。
//
// 职责：`computeMedievalShipPlacement(seed)` —— 每个 seed 在浅水高台的湖里放**一艘**船，
// 返回 `{wx, wz, variant, loX, hiX, loZ, hiZ}`（船 AABB 的世界坐标半宽）或 `null`。
//
// ## 落点判据（全部满足才合法）
// ① **船 AABB 内每一列都在水下**：`shallowTarnSurfaceYAt(x,z) <= SEA_Y - 1`。
//    这是用户「把船完整地生成在水域中」的直接翻译 —— 浅水高台的湖与相邻地图的水域
//    接壤也没关系，只要那一格是水下即可（判据对湖盆 / 水下坡 / 接壤的天然海域一视同仁）。
// ② **不压五座高台**：船 AABB 与每座高台的 AABB 不相交（含 2 格余量）。
//    用户明确「船不接触高台等等」。
// ③ **不压跨湖拱桥**：船 AABB 不含任何桥格（含 2 格余量）。桥虽在 y≈47 高空、
//    船顶 y≈33 碰不到，但「不与其他结构重叠」按水平占地从严判，避免桅杆与桥身视觉纠缠。
//
// ## 朝向与变体
// 朝向 `o ∈ [0,4)` 由 `seededRandom(…, seed + MEDIEVAL_SHIP_SALT)` 抽签，
// 变体 = `MEDIEVAL_SHIP_VARIANTS[o]`（烘焙期已把船旋到该朝向，运行期零旋转逻辑）。
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
import { SEA_Y } from '../../voxel/constants.js';
import { seededRandom } from '../noise.js';
import {
  computeShallowTarnAnchor, computeShallowTarnLayout, shallowTarnHalfWidth,
  LAKE_RADIUS, LAKE_RADIUS_MIN,
} from './shallow-water-tarns.js';
import { computeShallowTarnBridge } from './shallow-water-bridge.js';
import { shallowTarnSurfaceYAt } from './shallow-water-terrain.js';
import { rasterizeStructure } from './structure-json.js';
import { MEDIEVAL_SHIP_VARIANTS, medievalShipHalfWidth } from './medieval-ship-data.js';

/**
 * 落点抽签的 salt。
 *
 * 1039 经**程序化扫描**确认空闲（`src/**` 里 `seededRandom` 与 SALT 常量：
 * 1~26 / 50~58 / 100 / 113 / 200~201 / 301~314 / 800~805 / 941 / 951~961 /
 * 1020~1038 已占用，其中 1038 = 跨湖拱桥）。⚠️ 带 `+ step` 的调用点占用的是**区间**，
 * 加新 salt 前必须重跑同一个扫描。
 */
export const MEDIEVAL_SHIP_SALT = 1039;

/** 船 AABB 与高台 / 桥的最小水平余量（格）—— 留出「看得见的水缝」，不贴边 */
const SHIP_CLEARANCE = 2;

/** 候选中心的网格步长（格）。3 格足够密（船长 37，落点精度无需逐格），又省遍历 */
const CANDIDATE_STEP = 3;

/** 落点缓存（`seed → placement | null`）。纯函数，`clearMedievalShipCache()` 供单测隔离。 */
const placementCache = new Map();
const PLACEMENT_CACHE_MAX = 64;

/** 清空落点缓存（单测隔离用；生产代码不需要调用） */
export function clearMedievalShipCache() {
  placementCache.clear();
}

/**
 * 五座高台的世界坐标 AABB（供船判「不压高台」用）。
 * 与 `rasterizeShallowTarnPlatforms` 的落位口径同源（`Math.round(anchor + p.c*)`）。
 */
function platformAabbs(anchor, seed) {
  const layout = computeShallowTarnLayout(seed);
  return layout.map((p) => {
    const hw = shallowTarnHalfWidth(p.variant);
    const cx = Math.round(anchor.wx + p.cx);
    const cz = Math.round(anchor.wz + p.cz);
    return { minX: cx - hw.loX, maxX: cx + hw.hiX, minZ: cz - hw.loZ, maxZ: cz + hw.hiZ };
  });
}

/**
 * 跨湖拱桥的**走廊 AABB**。桥是沿正轴的直条（宽 3 格），其占用格集合恰好是一个
 * 轴对齐矩形 —— 故「船不压桥」可化简为一次 AABB 相交判断，不必逐格比对
 * （逐格 Set 查询 ~600 次/候选，是落点搜索的主要开销）。
 *
 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}|null}
 */
function bridgeCorridor(anchor, seed) {
  const bridge = computeShallowTarnBridge(seed, null);
  if (!bridge) return null;
  const alongMin = -bridge.halfN, alongMax = bridge.halfP;
  if (bridge.ux !== 0) {
    return { minX: anchor.wx + alongMin, maxX: anchor.wx + alongMax, minZ: anchor.wz - 1, maxZ: anchor.wz + 1 };
  }
  return { minX: anchor.wx - 1, maxX: anchor.wx + 1, minZ: anchor.wz + alongMin, maxZ: anchor.wz + alongMax };
}

function aabbOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * 某个候选中心 `(cx, cz)` 放某朝向的船是否合法（判据 ①②③，见文件头）。
 *
 * @param {{wx:number, wz:number}} anchor 湖心
 * @param {number} seed
 * @param {number} cx @param {number} cz 候选中心
 * @param {{loX:number, hiX:number, loZ:number, hiZ:number}} hw 该朝向船的水平半宽
 * @param {Array} platforms `platformAabbs` 的结果
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}|null} bridge 桥走廊 AABB
 */
function isValidPlacement(anchor, seed, cx, cz, hw, platforms, bridge) {
  const minX = cx - hw.loX, maxX = cx + hw.hiX;
  const minZ = cz - hw.loZ, maxZ = cz + hw.hiZ;
  const box = { minX, maxX, minZ, maxZ };

  // ② 高台（含余量）：把高台 AABB 外扩余量后与船 AABB 求交
  for (const p of platforms) {
    if (aabbOverlap(box, {
      minX: p.minX - SHIP_CLEARANCE, maxX: p.maxX + SHIP_CLEARANCE,
      minZ: p.minZ - SHIP_CLEARANCE, maxZ: p.maxZ + SHIP_CLEARANCE,
    })) return false;
  }

  // ③ 桥（含余量）：一次 AABB 相交（桥走廊是正轴矩形，见 `bridgeCorridor`）
  if (bridge && aabbOverlap(box, {
    minX: bridge.minX - SHIP_CLEARANCE, maxX: bridge.maxX + SHIP_CLEARANCE,
    minZ: bridge.minZ - SHIP_CLEARANCE, maxZ: bridge.maxZ + SHIP_CLEARANCE,
  })) return false;

  // ① 每一列都在水下（船完整落在水域里）。
  //    **快路径**：船 AABB 的最远角到湖心的距离 ≤ `LAKE_RADIUS_MIN`（构造性下界，
  //    对所有 θ 都有 R(θ) ≥ LAKE_RADIUS_MIN）⇒ 整个 AABB 必在湖盆内（e ≤ 0）⇒
  //    每列地表恒 `LAKE_FLOOR_Y ≤ SEA_Y-1`，无需逐格调 `shallowTarnSurfaceYAt`
  //    （那是落点搜索主要开销：沙滩/缓坡带每列要探 289 次采样）。
  const farDist = Math.hypot(
    Math.max(Math.abs(minX - anchor.wx), Math.abs(maxX - anchor.wx)),
    Math.max(Math.abs(minZ - anchor.wz), Math.abs(maxZ - anchor.wz)),
  );
  if (farDist <= LAKE_RADIUS_MIN) return true;

  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      if (shallowTarnSurfaceYAt(x, z, seed, anchor) > SEA_Y - 1) return false;
    }
  }
  return true;
}

/**
 * 每个 seed 一艘中世纪船的落点（纯函数，带缓存）。
 *
 * 搜索：以湖心为原点、`CANDIDATE_STEP` 为步长，在半径 `LAKE_RADIUS_MAX` 内枚举候选中心，
 * 按「离湖心距离升序、同距按角度」排序，取**第一个**合法位置 —— 让船尽量落在湖的
 * 开阔中心带，同时保证确定性（同一 seed 永远同一个落点）。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, variant:string,
 *   loX:number, hiX:number, loZ:number, hiZ:number}|null}
 */
export function computeMedievalShipPlacement(seed) {
  const cached = placementCache.get(seed);
  if (cached !== undefined) return cached;

  const anchor = computeShallowTarnAnchor(seed);
  if (!anchor) {
    remember(seed, null);
    return null;
  }

  // 朝向抽签（4 向）→ 变体与半宽
  const o = Math.floor(seededRandom(0, 0, seed + MEDIEVAL_SHIP_SALT) * 4) % 4;
  const variant = MEDIEVAL_SHIP_VARIANTS[o];
  const hw = medievalShipHalfWidth(variant);

  const platforms = platformAabbs(anchor, seed);
  const bridge = bridgeCorridor(anchor, seed);

  // 候选中心：湖心附近网格点（中心须在湖内，船体可略探入接壤水域）
  const R = LAKE_RADIUS;
  const cands = [];
  for (let dx = -R; dx <= R; dx += CANDIDATE_STEP) {
    for (let dz = -R; dz <= R; dz += CANDIDATE_STEP) {
      if (dx * dx + dz * dz > R * R) continue;
      cands.push({ cx: anchor.wx + dx, cz: anchor.wz + dz, d: Math.hypot(dx, dz), ang: Math.atan2(dz, dx) });
    }
  }
  cands.sort((a, b) => (a.d - b.d) || (a.ang - b.ang));

  let result = null;
  for (const c of cands) {
    if (isValidPlacement(anchor, seed, c.cx, c.cz, hw, platforms, bridge)) {
      result = { wx: c.cx, wz: c.cz, variant, ...hw };
      break;
    }
  }

  remember(seed, result);
  return result;
}

/** 缓存写入（FIFO 淘汰） */
function remember(seed, value) {
  if (placementCache.size >= PLACEMENT_CACHE_MAX) {
    placementCache.delete(placementCache.keys().next().value);
  }
  placementCache.set(seed, value);
}

/**
 * 船是否要落在本 column（AABB 相交判断，与 `rasterizeShallowTarnPlatforms` 同口径）。
 *
 * ⚠️ **不需要 layout 层的 region 裁剪字段**：船的落点是 `seed` 的纯函数（由湖心锚点派生），
 * 而湖心锚点已经由 `shallowTarnOverlapsRegion` 做了 region 裁剪 —— 携带 `shallowTarn` 的
 * region 必然能算出船。再加一个 `layout.medievalShip` 字段会是**同一事实的第二份副本**
 * （红线 1），且两者可能漂移出「layout 说有船、世界里没船」。
 *
 * @param {{wx:number, wz:number}} placement `computeMedievalShipPlacement` 的结果
 * @param {number} colMinX @param {number} colMinZ column 的左下角世界坐标
 * @param {number} marginal 与 `apply.js` 的 `INTERSECT_MARGIN` 同口径（默认 2）
 */
export function medievalShipTouchesColumn(placement, colMinX, colMinZ, marginal = 2) {
  const colMaxX = colMinX + 15, colMaxZ = colMinZ + 15;
  return !(placement.wx + placement.hiX + marginal < colMinX ||
           placement.wx - placement.loX - marginal > colMaxX ||
           placement.wz + placement.hiZ + marginal < colMinZ ||
           placement.wz - placement.loZ - marginal > colMaxZ);
}

/**
 * 在湖里光栅化中世纪船。
 *
 * ## y 口径（易错一格，与五座高台**不同**）
 * 传 `anchor.lakeFloorY + 1`（= `SEA_Y`）—— 船的**最底层坐在湖底方块之上**，
 * 与那一格水同层（船体把水挤开、坐在沙底上）。这正是用户选的「船坐湖底，不挖坑」：
 * 湖底方块在 `LAKE_FLOOR_Y = SEA_Y-1`（顶面 = `SEA_Y`），船底落在 `SEA_Y` 就紧贴它。
 *
 * ⚠️ **不要照抄高台的 `lakeFloorY`**：`rasterizeShallowTarnPlatforms` 传的是
 * `anchor.lakeFloorY`（= `SEA_Y-1`），因为高台底座要**占掉湖底方块那一层**（坐在湖底里）。
 * 船若也传 `lakeFloorY`，船底会埋进沙里一格（方块层面看不出，只是船低了一格）。
 *
 * ## 旋转
 * 零旋转逻辑：朝向已在烘焙期烘成 4 个变体（`MEDIEVAL_SHIP_VARIANTS[o]`），
 * 这里只按落点抽签的 `variant` 直接光栅化（红线 1：旋转公式只有 mesher 的
 * `rotateOffset` 一份，烘焙脚本消费它）。
 *
 * ## 裁剪
 * 按 AABB 与 column 相交才光栅化（每艘船跨多个 column，各自光栅化自己那一部分，
 * 接缝无缝拼接 —— 判定是 seed 级纯函数，跨 column 结论恒一致）。
 *
 * ⚠️ **groundSupport = false**：船坐在湖底上，不需要补支撑柱（湖底已由
 * `fillShallowTarnBasin` 填实；补柱会在船底下多插一根基座）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx: number, wz: number, lakeFloorY: number}} anchor 浅水高台锚点
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function rasterizeMedievalShip(column, anchor, seed, registry, setBlock) {
  const placement = computeMedievalShipPlacement(seed);
  if (!placement) return;
  if (!medievalShipTouchesColumn(placement, column.cx * 16, column.cz * 16)) return;
  rasterizeStructure(
    placement.variant, placement.wx, anchor.lakeFloorY + 1, placement.wz,
    setBlock, column, registry, seed, false,
  );
}
