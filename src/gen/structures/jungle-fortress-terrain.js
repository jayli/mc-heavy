// src/gen/structures/jungle-fortress-terrain.js — 丛林要塞地形耦合（v3.16）
//
// 权威：docs/superpowers/specs/2026-11-18-jungle-fortress-terrain-coupling-design.md DR-2/3/4/10
//
// ## v3.16 语义变更（与 v3.13 相反）
// v3.13 把占地 161×155 **整片削平**到 floorY（挖 17.7 万格）+ 16 格遇湿即止缓坡。
// v3.16 改为原版 RepurposedStructures 语义：**地形保留自然起伏**，结构整体抬到
// 占地自然高度的 75 分位（`anchor.floorY` = baseY），底面悬空处逐列补石墩。
// ⇒ 削平/铺地表/填实三步与 16 格插值缓坡**全部删除**。
//
// ## 本文件现在只做三件事
//   ① `jungleFortressSurfaceYAt`：地表唯一权威（内部 = generateHeight）
//   ② `inJungleFortressTerraform`：植被管理区（占地 + 16，范围与 v3.13 相同）
//   ③ `fillJungleFortressPiers` / `fillJungleFortressSkirt`（后续 Task 加）
//
// Worker 同构：本文件不得 import three。
import { getBiome } from '../noise.js';
import { generateHeight, surfaceTypeOfBiome } from '../terrain.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';
import { floorRowOf } from './structure-json.js';
import { JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z } from './jungle-fortress-data.js';

/**
 * 植被管理区的外延宽度（格）。
 *
 * ⚠️ v3.16：**不再用于地形整形**（削平与插值缓坡已删）。保留它只为了
 *    `inJungleFortressTerraform` 的植被管理范围 —— 用户 v3.13b 裁定「过渡带也要有树」。
 */
export const JUNGLE_FORTRESS_SLOPE_BAND = 16;

/**
 * 接壤阶梯过渡裙边的内侧宽度（格，DR-10）。
 *
 * 最大源值抬升 11 格（墙脚基座顶−nat），每步降 1 ⇒ 12 步内降到 nat。
 * 实测 R=10 与 R=14 结果逐位相同（带内突变都已 0），取 12 为冻结值。
 * ⚠️ 换地形公式后若抬升 >12 需重标 R/BW。
 */
export const JUNGLE_FORTRESS_SKIRT_INNER = 12;

/** 接壤阶梯过渡裙边的外侧宽度（格，DR-10）。留余量，实测实际带宽 11。 */
export const JUNGLE_FORTRESS_SKIRT_OUTER = 22;

/**
 * 某列的地表高度（**唯一权威**：墩/裙边/瞬移落点/植被/单测共用）。
 *
 * ⚠️ 不得在别处再写一份 —— 两份漂移会让瞬移落点与真实地表差几格
 * （浅水高台踩过完全同形的坑：玩家悬空或埋进土里）。
 *
 * ⚠️ v3.16：**恒返回数值，不再返回 null**（旧语义的 null = 「在自适应带外不整形」，
 *    现在全区都有定义）。返回 **过渡带处理后的地面 T**：
 *    内部非带列 = `generateHeight`；过渡带 = DR-10 包络值；建筑列 = nat。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number, floorY:number}} anchor
 * @returns {number}
 */
export function jungleFortressSurfaceYAt(wx, wz, seed, anchor) {
  const field = jfSkirtFieldCached(anchor, seed);
  if (!field) return generateHeight(wx, wz, seed);   // 产物未加载（预热前）⇒ 自然高度
  return field.T(wx - anchor.wx, wz - anchor.wz);
}

/**
 * 点是否落在**植被管理区**内（占地 + 16 格的外接方形）。
 *
 * ⚠️ v3.16 语义改为「植被管理区」（旧名「整形区」保留以免改全部调用方）：
 *    地形不再被削平，但这片区的植被由本结构的专属分支接管（密度/让位/树种）。
 *    范围与 v3.13 逐位相同 ⇒ 用户「过渡带也要有树」的裁定仍成立。
 *
 * ⚠️ **不是占地**：撒布剔除用 `inJungleFortressFootprint`（占地），两个判据分开。
 */
export function inJungleFortressTerraform(wx, wz, anchors) {
  if (!anchors) return false;
  const bx = JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_SLOPE_BAND;
  const bz = JUNGLE_FORTRESS_HALF_Z + JUNGLE_FORTRESS_SLOPE_BAND;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= bx && Math.abs(wz - a.wz) <= bz) return true;
  }
  return false;
}

/**
 * 产物的逐列竖直构成（墩 / 裙边 / 漏底修补共用的**唯一派生源**）。
 *
 * 红线 1：这是**可重建的派生数据**，不是第二份体素权威。按产物对象 WeakMap 缓存
 * （同 `apply.js` 的 `jungleFortressCells` 手法）；它只依赖产物，不依赖 seed/锚点。
 *
 * @param {{blocks:Array<{x:number,y:number,z:number,type:string}>}} data 已加载产物
 * @returns {{
 *   colMinNy: Map<string,number>,   // "px,pz" → 该列最低实心 ny
 *   colMaxNy: Map<string,number>,   // "px,pz" → 该列最高实心 ny
 *   solid: Set<string>,             // "px,ny,pz" 产物实心
 *   air: Set<string>,               // "px,ny,pz" 产物显式 air
 *   roomAir: Set<string>,           // 地下（ny < floorRow）air
 *   roomFloor: Set<string>,         // 实心且正上方是地下房间 air
 *   floorRow: number,
 * }}
 */
const JF_GEOM_CACHE = new WeakMap();
export function jungleFortressGeometry(data) {
  if (JF_GEOM_CACHE.has(data)) return JF_GEOM_CACHE.get(data);
  const floorRow = floorRowOf('jungleFortress');
  const colMinNy = new Map(), colMaxNy = new Map();
  const solid = new Set(), air = new Set();
  for (const b of data.blocks) {
    const k3 = `${b.x},${b.y},${b.z}`;
    if (b.type === 'air') { air.add(k3); continue; }
    solid.add(k3);
    const ck = `${b.x},${b.z}`;
    const lo = colMinNy.get(ck);
    if (lo === undefined || b.y < lo) colMinNy.set(ck, b.y);
    const hi = colMaxNy.get(ck);
    if (hi === undefined || b.y > hi) colMaxNy.set(ck, b.y);
  }
  const roomAir = new Set();
  for (const k of air) if (Number(k.split(',')[1]) < floorRow) roomAir.add(k);
  const roomFloor = new Set();
  for (const k of solid) {
    const [x, ny, z] = k.split(',').map(Number);
    if (roomAir.has(`${x},${ny + 1},${z}`)) roomFloor.add(k);
  }
  const entry = { colMinNy, colMaxNy, solid, air, roomAir, roomFloor, floorRow };
  JF_GEOM_CACHE.set(data, entry);
  return entry;
}

/**
 * 石墩托底 + 地下房间漏底修补（DR-3 / DR-4，原版 `pillar_processor` 语义）。
 *
 * ## 墩
 * 逐列从「该列最低产物实心的下一格」向下写 `mossy_stone`，直到自然地表。
 * 材质选建筑主材（46%）⇒ 观感是「建筑自己的基座加高」而不是外来土墩。
 *
 * ## 漏底修补
 * 不削平后 `carveCaves` 的洞可能正在地下房间下方 ⇒ 地板漏空。
 * 对每个「地下房间 air 格」与「房间地板格」，检查正下方第一格：
 * 若它既非产物实心、也非产物 air、且是洞穴空气 ⇒ 写 `stone`，并对补的格迭代同样检查。
 *
 * ⚠️ **必须排除「下方是产物 air」**：那是房间内部竖井（正常），
 *    不排除会多补 116 格（seed 4242 实测）把竖井填死。
 * ⚠️ **不得用「逐列向下填到连续 2 格实心」的粗口径**：实测要填 36026 格（486 倍）。
 *
 * ⚠️ **必须在光栅化之后调**（DR-8 层序），且逐格守 `blocks[idx] === 0`
 *    ⇒ 永不覆盖产物（含产物 air，保护房间内腔）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx:number, wz:number, floorY:number}} anchor floorY = baseY
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {{blocks:Array}} data 已加载产物（调用方在异步上下文 await 后传入）
 *   ⚠️ 不在此自己 `loadStructure`：它返 Promise，同步拿不到值；
 *      而 GEN 阶段 2.95 本就是 async（植被分支已在 await loadStructure）。
 */
export function fillJungleFortressPiers(column, anchor, seed, registry, data) {
  if (!data || !data.blocks.length) return;
  const { colMinNy, solid, air, roomAir, roomFloor, floorRow } = jungleFortressGeometry(data);
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const mossyId = registry.idOf('mossy_stone');
  const stoneId = registry.idOf('stone');
  const baseY = anchor.floorY;

  /** 本 column 内的格写入（只写空气，且只写世界边界内） */
  const put = (wx, wy, wz, id) => {
    if (wy < WORLD_MIN_Y || wy >= WORLD_MAX_Y) return false;
    const lx = wx - colMinX, lz = wz - colMinZ;
    if (lx < 0 || lx > 15 || lz < 0 || lz > 15) return false;
    const idx = blockIndex(lx, wy, lz);
    if (column.blocks[idx] !== 0) return false;
    column.blocks[idx] = id;
    return true;
  };

  // ---- ① 墩：逐列从最低实心下一格补到自然地表 ----
  for (const [ck, minNy] of colMinNy) {
    const [px, pz] = ck.split(',').map(Number);
    const wx = anchor.wx + px, wz = anchor.wz + pz;
    if (wx < colMinX || wx > colMinX + 15 || wz < colMinZ || wz > colMinZ + 15) continue;
    const baseWy = baseY + (minNy - floorRow);
    const h = generateHeight(wx, wz, seed);
    for (let wy = baseWy - 1; wy > h; wy--) put(wx, wy, wz, mossyId);
  }

  // ---- ② 漏底修补：迭代到「补的格下方也是实心」（实测 ≤9 轮）----
  //
  // ⚠️⚠️ **判据用「世界里真的是空气」，不用 noise3D 阀值重算**（实测踩过）：
  //    `carveCaves` 挖两类洞 —— 3D 噪声大洞 **与 rooms 空腔**（LCG 逐 column 确定性）。
  //    只查 noise3D > CAVE_THRESHOLD 会漏掉 rooms 那类：seed 777 的 (38,6,-5) 下方
  //    noise=0.4378 < 0.72 但世界确实是 air（rooms 挖的）⇒ 地板仍漏空。
  //
  // ⚠️⚠️ **不得加「wy ≤ h−4」范围门**（实测踩过）：那个门是 carveCaves 的挖洞上限，
  //    不是「漏底格的位置上限」。房间地板可能**高于自然地表**（半埋房间，正是用户要的）：
  //    seed 777 的 (69,9,-56) nat=2、地板 wy=5、漏底格 wy=4 > h−4=−2 ⇒ 加门会静默漏补。
  //    真意图是「房间正下方第一格是空气就补实」，与它在地下多深无关。
  //    下界仍守 WORLD_MIN_Y（世界底部基岩之上）。
  let pending = [];
  for (const k of roomAir) pending.push(k);
  for (const k of roomFloor) pending.push(k);
  for (let round = 0; round < 24 && pending.length; round++) {
    const next = [];
    for (const k of pending) {
      const [px, ny, pz] = k.split(',').map(Number);
      const belowNy = ny - 1;
      const bk = `${px},${belowNy},${pz}`;
      // 产物实心 ⇒ 已有支撑；产物 air ⇒ 房间竖井（正常，不得填）
      if (solid.has(bk) || air.has(bk)) continue;
      const wx = anchor.wx + px, wz = anchor.wz + pz;
      const lx = wx - colMinX, lz = wz - colMinZ;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
      const wy = baseY + (belowNy - floorRow);
      if (wy <= WORLD_MIN_Y || wy >= WORLD_MAX_Y) continue;
      if (column.blocks[blockIndex(lx, wy, lz)] !== 0) continue;   // 已是实心 ⇒ 无需补
      if (put(wx, wy, wz, stoneId)) next.push(bk);
    }
    pending = next;
  }
}


// ==================== 接壤阶梯过渡裙边（DR-10，用户 2026-11-18 追加裁定）====================
//
// 用户：「最终丛林要塞的地界和旁边的地图接壤的地方，都要有一个接壤区域的阶梯过渡，
// 不要出现陡峭的悬崖突变。」
//
// 结构抬升后边缘墙脚基座顶高于周边自然地面 10~13 格 ⇒ 不做过渡就是垂直悬崖。
// 方案：以**边缘环（占地最外圈）的地面顶**为源，向**内外两侧**做 Lipschitz 阶梯包络
// （每步降 1 格），只抬不削。
//
// ⚠️⚠️ **为什么必须两侧**（实测否决两条弯路）：
//   · 只抬外侧：内侧自然边缘列（nat=0）紧邻外侧裙边（9~11）⇒ 9~11 格沟槽（8 seed max 9~10）
//   · 全域抬内部：基座被埋回去（可见率 45.8% → 22.2%），违背「地下部分裸露」诉求
//   本方案只动「边缘环 + 内侧 R 格 + 外侧 BW 格」，内部非带列一律 nat ⇒ 基座可见率不降。
//
// ⚠️⚠️ **三屏障缺一即静默退化**：
//   · 建筑列（baseTop.has）：不抬（裙边不盖建筑，基座照露）；但它是源
//   · 保护列（露出地下房间/竖井 air 所在列）：不抬（否则埋掉用户要的裸露）
//   · 湿列（nat ≤ SEA_Y）：不抬也不传播（防假水面，红线 1）

/** 值降序二叉堆（max-plus Dijkstra 用：值大的先出队） */
class JfMaxHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(it) {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[i][0] > a[p][0]) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] > a[m][0]) m = l;
        if (r < a.length && a[r][0] > a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const jfInFootprint = (x, z) =>
  Math.abs(x) <= JUNGLE_FORTRESS_HALF_X && Math.abs(z) <= JUNGLE_FORTRESS_HALF_Z;
const jfIsEdge = (x, z) => jfInFootprint(x, z) &&
  (Math.abs(x) === JUNGLE_FORTRESS_HALF_X || Math.abs(z) === JUNGLE_FORTRESS_HALF_Z);
const jfInBand = (x, z) => {
  const HX = JUNGLE_FORTRESS_HALF_X, HZ = JUNGLE_FORTRESS_HALF_Z;
  const BW = JUNGLE_FORTRESS_SKIRT_OUTER, R = JUNGLE_FORTRESS_SKIRT_INNER;
  if (x < -HX - BW || x > HX + BW || z < -HZ - BW || z > HZ + BW) return false;
  if (jfInFootprint(x, z)) return Math.abs(x) >= HX - R || Math.abs(z) >= HZ - R;
  return true;
};

/**
 * 裙边包络场（**纯函数**，返回过渡带处理后的地面 T 与判据用的屏障集合）。
 *
 * 算法：源 = 边缘环列，`source = 建筑列 ? baseTop−1 : (pierTop ?? nat)`；
 * `T(x,z) = max(nat, max_e(source(e) − dist4(e,(x,z))))`，dist4 为 4 邻域最短路，
 * 建筑列/保护列/湿列**不可穿越也不被抬**；建筑列 T = nat。
 *
 * ⚠️ 用**值降序**优先队列（max-plus Dijkstra）：值大的先定型，settled 防重复松弛。
 * ⚠️ 实测成本（8 seed 均）：nat 预填 121ms + solve 20ms，**按锚点缓存一次**，
 *    不进 GEN 逐 column 热路径（genP95 门 10ms）。
 *
 * @param {{wx:number,wz:number,floorY:number}} anchor
 * @param {number} seed
 * @param {{blocks:Array}} data 已加载产物
 */
export function jungleFortressSkirtField(anchor, seed, data) {
  const G = jungleFortressGeometry(data);
  const FR = G.floorRow;
  const baseY = anchor.floorY;
  const HX = JUNGLE_FORTRESS_HALF_X, HZ = JUNGLE_FORTRESS_HALF_Z;
  const BW = JUNGLE_FORTRESS_SKIRT_OUTER;
  const bounds = { x0: -HX - BW, x1: HX + BW, z0: -HZ - BW, z1: HZ + BW };

  const hC = new Map();
  const nat = (x, z) => {
    const k = `${x},${z}`;
    let v = hC.get(k);
    if (v === undefined) { v = generateHeight(anchor.wx + x, anchor.wz + z, seed); hC.set(k, v); }
    return v;
  };
  // 预填高度缓存：一次扫带内全部列，避免 Dijkstra 里逐次 Map miss 的抖动
  for (let x = bounds.x0; x <= bounds.x1; x++) {
    for (let z = bounds.z0; z <= bounds.z1; z++) nat(x, z);
  }

  // baseTop = 该列最低产物实心的世界 y；pierTop = 墩顶（只在高于 nat 时存在）
  const baseTop = new Map(), pierTop = new Map();
  for (const [ck, minNy] of G.colMinNy) {
    const [x, z] = ck.split(',').map(Number);
    const bt = baseY + (minNy - FR);
    baseTop.set(ck, bt);
    if (bt - 1 > nat(x, z)) pierTop.set(ck, bt - 1);
  }
  // 保护列：露出地表的下地下 air 所在列
  const prot = new Set();
  for (const k of G.roomAir) {
    const [x, ny, z] = k.split(',').map(Number);
    if (baseY + (ny - FR) > nat(x, z)) prot.add(`${x},${z}`);
  }
  const isWet = (x, z) => nat(x, z) <= SEA_Y;
  const isBuilding = (x, z) => baseTop.has(`${x},${z}`);
  const isProtected = (x, z) => prot.has(`${x},${z}`);
  const blocked = (x, z) => isProtected(x, z) || isWet(x, z);

  const best = new Map();
  const heap = new JfMaxHeap();
  for (let x = -HX; x <= HX; x++) {
    for (let z = -HZ; z <= HZ; z++) {
      if (!jfIsEdge(x, z)) continue;
      const key = `${x},${z}`;
      const bt = baseTop.get(key);
      const v = bt !== undefined ? bt - 1 : (pierTop.get(key) ?? nat(x, z));
      best.set(key, { v, d: 0 });
      heap.push([v, key, 0]);
    }
  }
  const settled = new Set();
  while (heap.size) {
    const [v, key, d] = heap.pop();
    if (settled.has(key)) continue;
    const rec = best.get(key);
    if (!rec || rec.v !== v || rec.d !== d) continue;
    settled.add(key);
    const [x, z] = key.split(',').map(Number);
    const nd = d + 1, nv = v - 1;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!jfInBand(nx, nz)) continue;
      if (blocked(nx, nz) || isBuilding(nx, nz)) continue;
      const nk = `${nx},${nz}`;
      const prev = best.get(nk);
      if (!prev || nv > prev.v || (nv === prev.v && nd < prev.d)) {
        best.set(nk, { v: nv, d: nd });
        heap.push([nv, nk, nd]);
      }
    }
  }
  const T = (x, z) => {
    if (isBuilding(x, z)) return nat(x, z);      // 建筑列地面恒 nat（基座可见性按 nat 判）
    const r = best.get(`${x},${z}`);
    return r === undefined ? nat(x, z) : Math.max(nat(x, z), r.v);
  };
  return { T, nat, baseTop, pierTop, prot, bounds,
    inBand: jfInBand, inFootprint: jfInFootprint, isEdge: jfIsEdge,
    isBuilding, isProtected, isWet };
}

/**
 * 按锚点缓存的包络场。
 *
 * ⚠️ 缓存键是 anchor 对象（`computeJungleFortressAnchor` 用 Object.freeze + memo，
 *    同 seed 恒同一对象）⇒ WeakMap 天然随锚点失效。
 *
 * ⚠️⚠️ **不得依赖「fillSkirt 跑过」才有值**（实测踩过的真缺陷）：
 *    第一版把产物引用写在 `fillJungleFortressSkirt` 里，于是**纯查询路径**
 *    （瞬移落点、单测、还没跑到那个 column 的 GEN）拿到的是 **nat 而不是 T**
 *    ⇒ 同一函数两种返回值 = 第二份权威（红线 1）。
 *    修法：产物引用由**加载入口统一登记**（`noteJungleFortressData`），
 *    与 GEN 写到哪一 column 无关。
 */
const JF_SKIRT_CACHE = new WeakMap();
let jfSkirtData = null;

/**
 * 登记已加载的丛林要塞产物（供 `jungleFortressSurfaceYAt` 的纯查询路径用）。
 *
 * 调用方：`apply.js` 在 `await loadStructure('jungleFortress')` 后立即调一次。
 * 幂等；同一份产物不重算包络。
 */
export function noteJungleFortressData(data) {
  if (data && data.blocks && data.blocks.length) jfSkirtData = data;
}

function jfSkirtFieldCached(anchor, seed) {
  if (!anchor || !jfSkirtData) return null;
  const hit = JF_SKIRT_CACHE.get(anchor);
  if (hit && hit.seed === seed) return hit.field;
  const field = jungleFortressSkirtField(anchor, seed, jfSkirtData);
  JF_SKIRT_CACHE.set(anchor, { seed, field });
  return field;
}

/**
 * 写入接壤阶梯过渡裙边（DR-10）。
 *
 * 对过渡带内**非建筑列**，`T > nat` 时从 `nat+1` 到 `T` 逐格写：
 * 顶格 `surfaceTypeOfBiome(getBiome)`（FOREST→grass），下方 `dirt`。
 *
 * ⚠️ 材质是**自然地形阶梯**，不是 mossy_stone —— 观感是「要塞坐在逐级抬升的台地上」。
 * ⚠️ 守卫 `blocks[idx] === 0`：永不覆盖产物/墩/已有地形。
 * ⚠️ 必须在光栅化与墩之后调（DR-8 层序）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx:number,wz:number,floorY:number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {{blocks:Array}} data 已加载产物
 */
export function fillJungleFortressSkirt(column, anchor, seed, registry, data) {
  if (!data || !data.blocks.length) return;
  noteJungleFortressData(data);
  const field = jfSkirtFieldCached(anchor, seed);
  if (!field) return;
  const { T, nat, isBuilding, bounds } = field;
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const x0 = Math.max(colMinX, anchor.wx + bounds.x0);
  const x1 = Math.min(colMinX + 15, anchor.wx + bounds.x1);
  const z0 = Math.max(colMinZ, anchor.wz + bounds.z0);
  const z1 = Math.min(colMinZ + 15, anchor.wz + bounds.z1);
  if (x0 > x1 || z0 > z1) return;
  const dirtId = registry.idOf('dirt');
  const surfCache = new Map();
  for (let wx = x0; wx <= x1; wx++) {
    for (let wz = z0; wz <= z1; wz++) {
      const px = wx - anchor.wx, pz = wz - anchor.wz;
      if (isBuilding(px, pz)) continue;       // 裙边不盖建筑
      const top = T(px, pz), h = nat(px, pz);
      if (top <= h) continue;
      const biome = getBiome(wx, wz, seed);
      let surfId = surfCache.get(biome);
      if (surfId === undefined) { surfId = registry.idOf(surfaceTypeOfBiome(biome)); surfCache.set(biome, surfId); }
      const lx = wx - colMinX, lz = wz - colMinZ;
      for (let wy = h + 1; wy <= top; wy++) {
        if (wy < WORLD_MIN_Y || wy >= WORLD_MAX_Y) continue;
        const idx = blockIndex(lx, wy, lz);
        if (column.blocks[idx] !== 0) continue;
        column.blocks[idx] = wy === top ? surfId : dirtId;
      }
    }
  }
}
