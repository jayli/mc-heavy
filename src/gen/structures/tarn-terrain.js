// src/gen/structures/tarn-terrain.js — 高台地带：台地整形（草石镶嵌 + 水池）
//
// 设计文档 docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md DR-9。
//
// 两段式里的「地形」那一半：`computeTarnZone()`（tarn-zone.js）算布局，
// 本文件把布局**落到方块**。调用顺序必须是
//   `fillColumn`（自然地形） → **`fillTarnPlateau`（本文件）** → 结构光栅化（高台/拱洞/紫晶柱）
// 放在 `fillColumn` 之前会被它覆盖；放在结构光栅化之后会把高台削掉。
//
// Worker 同构：本文件不得 import three、不得 fetch、不得自建 Worker。
// 生成路径：不记 edits、不 bump version（与 `fillColumn` 同口径）。

import { noise } from '../noise.js';
import { blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';
import { TERRAIN_HEIGHT_PARAMS, generateHeight } from '../terrain.js';

/**
 * 台地整形的噪声 salt。
 *
 * ⚠️ **程序化扫描确认空闲**（不能只 grep 字面量 —— 带 `+ step` 的调用点占用的是区间）：
 * 已占用 1-58 / 100 / 113 / 200-201 / 301-303 / 311-314 / 800-805 / 911-958 /
 * 950 / 960-961 / 999 / **1020-1024（本设计的五个 salt）**。
 * 本文件取 1022（`TARN_TERRAIN_SALT`，与 tarn-zone.js 的注释一致）。
 */
export const TARN_TERRAIN_SALT = 1022;

/**
 * 草石镶嵌的噪声尺度。
 *
 * **必须从 `terrain.js` 取，不要写 0.08 字面量**（红线 1：改地形粗糙度时两处会漂移出
 * 「台地镶嵌粒度与大尺度地形不一致」）。取 `COARSE_SCALE`（0.08）是因为它的波长约
 * 8~16 格 —— 正是「成片」的观感（spec DR-9）。更小（如 0.2）会变成逐格花屏，
 * 更大（如 0.02）会整片只有一种方块。
 */
const SURFACE_SCALE = TERRAIN_HEIGHT_PARAMS.COARSE_SCALE;

/**
 * 平台边缘的缓坡宽度（格）。
 *
 * 平台半径 = `plateauRadius - TARN_SLOPE_WIDTH`；从这个半径往外，地表高度在
 * `TARN_SLOPE_WIDTH` 格内线性过渡到自然地形高度。
 *
 * ⚠️ **v1.89 引入**（用户 2026-10-27 裁定：「完全就用普通的平缓的地形来接续高台地形
 * 旁边的地图，只要能接续上即可，坡度缓和一些」）。取 40 格 ⇒ 从 `plateauY`(=2) 过渡到
 * 常见自然高度（~10）的坡度约 8°，玩家跑上去不会被挡住（`MAX_STEP = 1.0`，
 * 40 格摊 8 格高差 = 每格 0.2，天然可走）。
 */
export const TARN_SLOPE_WIDTH = 40;

/**
 * 台地地表方块：草石镶嵌的**唯一权威**（单测直接用，不复制一份判据 —— 红线 1）。
 *
 * 用**低频噪声**做「成片」镶嵌而不是逐格随机：逐格随机会读成花屏（spec DR-9 实测）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {'grass'|'stone'}
 */
export function tarnSurfaceBlock(wx, wz, seed) {
  return noise(wx, wz, seed + TARN_TERRAIN_SALT, SURFACE_SCALE) > 0 ? 'grass' : 'stone';
}

/**
 * 把一个 column 的台地整形到布局指定的高度。
 *
 * 三条分支（`plateauY` 是台地地表高度，池内低一格）：
 *
 * | 距离 | 内容 |
 * |---|---|
 * | `<= poolRadius` | 池底 = `plateauY - 1`（**下沉一格**，`stone`）；`plateauY` 那层填 `water`；之上清空 |
 * | `(poolRadius, plateauRadius]` | 地表 = `plateauY`，材质 `tarnSurfaceBlock`；之下 `stone`；之上清空 |
 * | 圆外 | **不动** |
 *
 * ⚠️ **高于 `plateauY` 的格必须显式写 0**：`fillColumn` 已按自然地形填过整个 column，
 * 不清掉就会在台地上方留下原来的山体 —— 观感是「台地长在山里」，而且方块层面
 * 完全看不出是整形漏了（地形本来就在那）。负向验证靠「高于 plateauY 的原山体被削平」那条用例钉住。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {import('./tarn-zone.js').TarnLayout} layout
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 */
export function fillTarnPlateau(column, layout, seed, registry) {
  const { cx, cz, poolRadius, plateauRadius, plateauY } = layout;
  const stoneId = registry.idOf('stone');
  const grassId = registry.idOf('grass');
  // 干掉的两种水体（v1.89）：填实时要一并替换成石头
  const waterId = registry.idOf('water');
  const swampWaterId = registry.idOf('swamp_water');
  const idCache = new Map([['stone', stoneId], ['grass', grassId]]);
  // 内圈平台半径 = 地带半径 − 坡宽。v1.89 起池内也是平台（无水），
  // 故平台半径只由坡宽决定，不再看 poolRadius。
  const flatR = plateauRadius - TARN_SLOPE_WIDTH;
  const idOfName = (name) => {
    if (idCache.has(name)) return idCache.get(name);
    const id = registry.idOf(name);
    idCache.set(name, id);
    return id;
  };

  // 只扫「本 column 与地带圆的外接方形」的交集 —— 圆外一格都不碰（性能 + 零影响）
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const x0 = Math.max(colMinX, Math.ceil(cx - plateauRadius));
  const x1 = Math.min(colMinX + 15, Math.floor(cx + plateauRadius));
  const z0 = Math.max(colMinZ, Math.ceil(cz - plateauRadius));
  const z1 = Math.min(colMinZ + 15, Math.floor(cz + plateauRadius));
  if (x0 > x1 || z0 > z1) return;

  const platR2 = plateauRadius * plateauRadius;

  for (let wx = x0; wx <= x1; wx++) {
    const dx = wx - cx;
    for (let wz = z0; wz <= z1; wz++) {
      const dz = wz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > platR2) continue;                    // 圆外：不动

      const lx = wx - colMinX, lz = wz - colMinZ;

      // ── 目标高度：内圈平台恒定 plateauY，外圈 TARN_SLOPE_WIDTH 内平滑过渡到自然地形 ──
      // ⚠️ **v1.89 去掉中央水池**（用户 2026-10-27 裁定：「把高台所在的中央水面去掉，
      //    完全就用普通的平缓的地形来接续高台地形旁边的地图，只要能接续上即可，
      //    坡度缓和一些」）。现在池内也是平台，整片地带是一块平顶高原，
      //    边缘用 `TARN_SLOPE_WIDTH` 宽的缓坡接回自然地形 —— 不再有 `water` 方块，
      //    因此 transparent 通道与高台地带**完全无关**。
      const d = Math.sqrt(d2);
      let targetY;
      if (d <= flatR) {
        targetY = plateauY;
      } else {
        // 从 flatR 到 plateauRadius 线性插值到自然高度（缓坡）
        const t = (d - flatR) / (plateauRadius - flatR);
        const naturalY = generateHeight(wx, wz, seed);
        targetY = Math.round(plateauY * (1 - t) + naturalY * t);
      }

      // ── 1. 削平：targetY 以上一律清空（含原山体） ──
      for (let y = targetY + 1; y < WORLD_MAX_Y; y++) {
        const idx = blockIndex(lx, y, lz);
        if (column.blocks[idx] !== 0) column.blocks[idx] = 0;
      }

      // ── 2. 地表：平台用草石镶嵌，坡面用 stone（与自然地形同材质，接缝不突兀） ──
      const surfaceName = d <= flatR ? tarnSurfaceBlock(wx, wz, seed) : 'stone';
      column.blocks[blockIndex(lx, targetY, lz)] = idOfName(surfaceName);

      // ── 3. 向下填实（防止玩家从地表掉进原地下水/空气腔） ──
      // ⚠️ **v1.89：地下水也要换成石头**（用户 2026-10-27 裁定「确保这次新增的高台地形……
      // 其他不应该有任何差异」+「高台所在的水面完全去掉」）。清掉 `water`/`swamp_water` 是
      // 让地带**彻底不含透明方块**的最后一步 —— 不填的话自然地形原有的地下水体留在原地，
      // 既占 transparent 通道，也让「地带有水」这个断言无法成立。
      for (let y = WORLD_MIN_Y + 1; y < targetY; y++) {
        const idx = blockIndex(lx, y, lz);
        const cur = column.blocks[idx];
        if (cur === 0 || cur === waterId || cur === swampWaterId) column.blocks[idx] = stoneId;
      }
    }
  }
}
