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
import { generateHeight } from '../terrain.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';
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
 * 某列的地表高度（**唯一权威**：墩/裙边/瞬移落点/植被/单测共用）。
 *
 * ⚠️ 不得在别处再写一份 —— 两份漂移会让瞬移落点与真实地表差几格
 * （浅水高台踩过完全同形的坑：玩家悬空或埋进土里）。
 *
 * ⚠️ v3.16：**恒返回数值，不再返回 null**（旧语义的 null = 「在自适应带外不整形」，
 *    现在全区都有定义）。内部恒 = `generateHeight`；Task 5 加裙边后过渡带返回包络值 T。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number, floorY:number}} _anchor 保留签名（T5 裙边要用锚点算包络）
 * @returns {number}
 */
export function jungleFortressSurfaceYAt(wx, wz, seed, _anchor) {
  return generateHeight(wx, wz, seed);
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

