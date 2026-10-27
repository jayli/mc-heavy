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
import { TARN_SLOPE_WIDTH } from './tarn-zone.js';

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
 * 平台边缘的缓坡宽度（格）—— **唯一权威在 `tarn-zone.js`**，这里 re-export。
 *
 * ⚠️ **必须从那里 import，不得在本文件再写一份**：`isTarnZone` 的「核心沙漠占比」判据要采到
 * 平台边缘（= `TARN_ZONE_RADIUS - 缓坡宽度`），判定是 `(regionX, regionZ, seed)` 的纯函数 ——
 * 两份坡宽漂移后，同一个 region 会「判定时按 24 采样、整形时按 40 削坡」。
 * 反过来放本文件也不行：`tarn-zone.js` 不能 import 本文件（本文件 import 它的 `generateHeight`
 * 链路），会成环。故权威在 `tarn-zone.js`，本文件只做消费 + 转出（供测试 import）。
 */
export { TARN_SLOPE_WIDTH };

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
 * 缓坡用的自然高度：半径 `SLOPE_SMOOTH_RADIUS` 内方形的**均值**。
 *
 * ⚠️ **不能直接用本格的 `generateHeight`**（v1.90 实测）：自然地形存在陡坡（实测某处
 * 1→8 格一跳），线性插值会把它**放大成断崖** —— 坡宽 24 时出现 **6~7 格**台阶，
 * 玩家被挡住（`MAX_STEP = 1.0`）；旧坡宽 40 时只有 2 格，所以这个问题在缩缓坡后才暴露。
 *
 * ⚠️ **聚合方式必须是均值，不能用最小值**（实测对比）：
 * | 平滑半径 | 无平滑 | 最小值聚合 | **均值聚合** |
 * |---|---|---|---|
 * | 2 | 7 格 | 6 格 | **2 格** |
 * | 4 | 7 格 | 4 格 | **2 格** |
 * | **8** | 7 格 | 8 格 | **1 格（>1 占比 0.000%）** |
 * 最小值聚合会把坡面系统性压低（陡坡下方取到最低点），反而在陡坡上方造成更大的落差。
 *
 * ⚠️ **半径 8 的代价可以接受**：坡面与原地形的平均偏差 **1.28 格**、最大 8 格（那几个点在
 * 陡坡正下方）—— 观感上是「缓坡略矮于周边地形」，而不是断崖。旧坡宽 40 格时同类偏差也差不多。
 * 半径再大（10）会把偏差抬到 1.30 且最大高差回升到 2，没有收益。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {number}
 */
function slopeNaturalHeight(wx, wz, seed) {
  let sum = 0;
  let n = 0;
  for (let dx = -SLOPE_SMOOTH_RADIUS; dx <= SLOPE_SMOOTH_RADIUS; dx++) {
    for (let dz = -SLOPE_SMOOTH_RADIUS; dz <= SLOPE_SMOOTH_RADIUS; dz++) {
      sum += generateHeight(wx + dx, wz + dz, seed);
      n++;
    }
  }
  return sum / n;
}

/**
 * 缓坡自然高度的平滑半径（格）。标定表与取舍理由见 `slopeNaturalHeight`。
 */
const SLOPE_SMOOTH_RADIUS = 8;

/**
 * 把一个 column 的台地整形到布局指定的高度。
 *
 * 三条分支（`plateauY` 是台地地表高度）：
 *
 * | 距离 | 内容 |
 * |---|---|
 * | `<= platformRadius` | 地表 = `plateauY`，材质 `tarnSurfaceBlock`（草石镶嵌）；之下 `stone`；之上清空 |
 * | `(platformRadius, plateauRadius]` | 缓坡：地表高度从 `plateauY` 线性插值到自然地形，材质 `stone` |
 * | 圆外 | **不动** |
 *
 * ⚠️ **s1.89 起没有中央水池了**（用户 2026-10-27 裁定）：整片地带是平顶高原 + 外圈缓坡，
 * 自然地形原有的地下水体也一并填成石头 —— 地带内**一格水都没有**，
 * 所以它与 transparent 通道完全无关。
 *
 * ⚠️ **高于目标高度的格必须显式写 0**：`fillColumn` 已按自然地形填过整个 column，
 * 不清掉就会在台地上方留下原来的山体 —— 观感是「台地长在山里」，而且方块层面
 * 完全看不出是整形漏了（地形本来就在那）。负向验证靠「高于 plateauY 的原山体被削平」那条用例钉住。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {import('./tarn-zone.js').TarnLayout} layout
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 */
export function fillTarnPlateau(column, layout, seed, registry) {
  const { cx, cz, platformRadius, plateauRadius, plateauY } = layout;
  const stoneId = registry.idOf('stone');
  const grassId = registry.idOf('grass');
  // 干掉的两种水体（v1.89）：填实时要一并替换成石头
  const waterId = registry.idOf('water');
  const swampWaterId = registry.idOf('swamp_water');
  const idCache = new Map([['stone', stoneId], ['grass', grassId]]);
  // 内圈平台半径 = `layout.platformRadius`（= 地带半径 − 缓坡宽度，由 `tarn-zone.js` 派生）；
  // s1.90 起不再有 `poolRadius` 这个字段（s1.89 删了水池后它已经是死字段）。
  const flatR = platformRadius;
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

      // ── 目标高度：内圈平台恒定 plateauY，缓坡带内线性过渡到自然地形 ──
      // ⚠️ **v1.89 去掉中央水池**（用户 2026-10-27 裁定：「把高台所在的中央水面去掉，
      //    完全就用普通的平缓的地形来接续高台地形旁边的地图，只要能接续上即可，
      //    坡度缓和一些」）。整片地带是一块平顶高原，边缘用 `TARN_SLOPE_WIDTH`
      //    （现 24 格）宽的缓坡接回自然地形 —— 不再有 `water` 方块，
      //    因此 transparent 通道与高台地带**完全无关**。
      // ⚠️ **改缓坡宽度前先重测「走不上去的列」占比**（实测表在
      //    `tarn-zone.js` 的 `TARN_PLATFORM_RADIUS` 注释里）：24 格→ 0.32%，20 格就开始变拥。
      const d = Math.sqrt(d2);
      let targetY;
      if (d <= flatR) {
        targetY = plateauY;
      } else {
        // 从 flatR 到 plateauRadius 线性插值到自然高度（缓坡）。
        //
        // ⚠️ **自然高度必须先做邻域平滑**（v1.90 实测修复）：直接用本格的
        //    `generateHeight` 时，自然地形的陡坡会被插值**放大成断崖** ——
        //    实测 seed 12345 的 region(-6,-2) 在某方向上自然高度从 1 直接跳到 8（海床陡坡），
        //    插值到 t≈0.83 处就是 6 格的台阶（旧坡宽 40 时只有 2 格，缩到 24 后变 6）。
        //    玩家会被那一级挡住（MAX_STEP = 1.0）。
        //    平滑方式 = 半径 8 的**均值**（不是最小值），标定表见 `slopeNaturalHeight`。
        const t = (d - flatR) / (plateauRadius - flatR);
        const naturalY = slopeNaturalHeight(wx, wz, seed);
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
