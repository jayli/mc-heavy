// src/gen/structures/jungle-fortress-terrain.js — 丛林要塞地形整形（遇湿即止缓坡）
//
// 权威：docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md DR-7
//
// ## 为什么需要整形
// FOREST 地表起伏 span 14~16（DESERT 有 0.5 压平系数只有 5）。不整形则 5,425 格
// 地上城墙空气被天然岩层埋掉、458 列墙脚露空。整形后两者都归零。
//
// ## 「遇湿即止」自适应带宽（本结构的关键设计）
// 固定 16 格缓坡带会触水：193×187 范围内**全干燥候选 = 0**（8/8 seed）。
// 六档方案实测后只有这一档同时做到：零水格 / 零假水面 / 零无波纹 / 边缘跳变 1，
// 且**不需要改 ocean-mask.js / ocean.js**（红线 1 零风险）。
//
// 算法：逐列从占地边缘 outward 走，遇第一个 `generateHeight <= SEA_Y` 的列就停，
// 该列及其外侧一律不整形；插值分母用**该列自己的带宽 w**（不是固定 16），
// 于是带末 e=w 时 target = 自然 h ⇒ 与自然地形连续。
//
// Worker 同构：本文件不得 import three。
import { getBiome } from '../noise.js';
import { generateHeight, surfaceTypeOfBiome } from '../terrain.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';
import { JUNGLE_FORTRESS_HALF_X, JUNGLE_FORTRESS_HALF_Z } from './jungle-fortress-data.js';

/** 缓坡带最大宽度（格）。逐列实际带宽 w ≤ 此值（遇湿即止） */
export const JUNGLE_FORTRESS_SLOPE_BAND = 16;

/** 该列到占地矩形的切比雪夫距离与两轴分量 */
function offsets(wx, wz, anchor) {
  const dx = wx - anchor.wx, dz = wz - anchor.wz;
  const ex = Math.max(0, Math.abs(dx) - JUNGLE_FORTRESS_HALF_X);
  const ez = Math.max(0, Math.abs(dz) - JUNGLE_FORTRESS_HALF_Z);
  return { dx, dz, ex, ez, e: Math.max(ex, ez) };
}

/**
 * 某列整形后的地表高度（**唯一权威**：整形、瞬移落点、单测三处共用）。
 *
 * ⚠️ 不得在别处再写一份插值 —— 两份漂移会让瞬移落点与真实地表差几格
 * （浅水高台踩过完全同形的坑：玩家悬空或埋进土里）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{wx:number, wz:number, floorY:number}} anchor
 * @returns {number|null} null = 该列不整形（在自适应带外）
 */
export function jungleFortressSurfaceYAt(wx, wz, seed, anchor) {
  const { dx, dz, ex, ez, e } = offsets(wx, wz, anchor);
  const h = generateHeight(wx, wz, seed);
  if (e === 0) return anchor.floorY;
  if (e > JUNGLE_FORTRESS_SLOPE_BAND) return null;

  // 沿该列的 outward 路径找第一个湿列 ⇒ 带宽 w = k−1
  // ⚠️ ex >= ez 时走 X（保持 dz 不变），否则走 Z —— 与 offsets 的分量口径一致
  let w = JUNGLE_FORTRESS_SLOPE_BAND;
  for (let k = 1; k <= JUNGLE_FORTRESS_SLOPE_BAND; k++) {
    const sx = ex >= ez ? Math.sign(dx) * (JUNGLE_FORTRESS_HALF_X + k) : dx;
    const sz = ez > ex ? Math.sign(dz) * (JUNGLE_FORTRESS_HALF_Z + k) : dz;
    if (generateHeight(anchor.wx + sx, anchor.wz + sz, seed) <= SEA_Y) { w = k - 1; break; }
  }
  if (e > w) return null;
  if (w === 0) return anchor.floorY;
  // ⚠️ 分母是**逐列带宽 w**：固定 16 时带末 target ≠ 自然 h ⇒ 边缘 8 格悬崖（实测）
  // ⚠️ min(…, h) 保证**只削不填**（填方恒 0，不需要「填实基座下方」那套逻辑）
  return Math.min(Math.round(anchor.floorY + (h - anchor.floorY) * (e / w)), h);
}

/**
 * 点是否落在**整形区**内（含缓坡带的外接方形）。
 *
 * ⚠️ 这是「让路」判据的范围（`pointContext` 用它）：缓坡带的地表也被改写过，
 * 树/撒布长在缓坡上会穿模。**不是占地** —— 用占地会漏掉缓坡带那 1.1 万列。
 *
 * ⚠️ 用外接方形而不是逐列 `surfaceYAt !== null`：让路是「整片保守让」，
 * 方形比自适应带略大（多让几列树），方向安全且 O(1)（逐列判要算 16 次高度）。
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
 * 把一个 column 的地形整形到锚点指定的高度。
 *
 * 三件事的顺序是**载荷性的**：① 削平 → ② 铺地表 → ③ 向下填实。
 * 反序会把刚铺的地表削掉。
 *
 * ⚠️ **不填水**：整形区恒干燥（`surfaceYAt` 的遇湿即止保证 target > SEA_Y），
 * 故本函数与 transparent 通道完全无关，也不需要动海面遮罩。
 *
 * ⚠️ **target 以上必须显式写 0**：`fillColumn` 已按自然地形填过整列，
 * 不清掉就会在平地上方留下原山体 —— 观感是「要塞长在山里」，
 * 而方块层面完全看不出是整形漏了（地形本来就在那）。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {{wx:number, wz:number, floorY:number}} anchor
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 */
export function fillJungleFortressGround(column, anchor, seed, registry) {
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const bx = JUNGLE_FORTRESS_HALF_X + JUNGLE_FORTRESS_SLOPE_BAND;
  const bz = JUNGLE_FORTRESS_HALF_Z + JUNGLE_FORTRESS_SLOPE_BAND;
  // 只扫「本 column 与整形区外接方形」的交集 —— 区外一格都不碰
  const x0 = Math.max(colMinX, anchor.wx - bx);
  const x1 = Math.min(colMinX + 15, anchor.wx + bx);
  const z0 = Math.max(colMinZ, anchor.wz - bz);
  const z1 = Math.min(colMinZ + 15, anchor.wz + bz);
  if (x0 > x1 || z0 > z1) return;

  const stoneId = registry.idOf('stone');
  const idCache = new Map();
  const idOfName = (name) => {
    if (idCache.has(name)) return idCache.get(name);
    const id = registry.idOf(name);
    idCache.set(name, id);
    return id;
  };

  for (let wx = x0; wx <= x1; wx++) {
    for (let wz = z0; wz <= z1; wz++) {
      const target = jungleFortressSurfaceYAt(wx, wz, seed, anchor);
      if (target === null) continue;                 // 自适应带外 ⇒ 不动
      const lx = wx - colMinX, lz = wz - colMinZ;

      // ① 削平：target 以上一律清空（含原山体）
      for (let y = target + 1; y < WORLD_MAX_Y; y++) {
        const idx = blockIndex(lx, y, lz);
        if (column.blocks[idx] !== 0) column.blocks[idx] = 0;
      }
      // ② 地表：材质走 surfaceTypeOfBiome（整形区有少量 AZALEA/PLAINS 侵入，
      //    硬编码 grass 会在那些列刷出错误颜色）
      column.blocks[blockIndex(lx, target, lz)] =
        idOfName(surfaceTypeOfBiome(getBiome(wx, wz, seed)));
      // ③ 向下填实：只填空气（防玩家挖开地表掉进 carveCaves 的洞）
      for (let y = WORLD_MIN_Y + 1; y < target; y++) {
        const idx = blockIndex(lx, y, lz);
        if (column.blocks[idx] === 0) column.blocks[idx] = stoneId;
      }
    }
  }
}