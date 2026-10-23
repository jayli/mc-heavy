// src/gen/structures/redcity-surface.js — RedCity 地表：过渡环台阶钳制 / core 与 ring 的列整形 / 地标吞并判定
// Worker 同构：本文件不得 import three，无 DOM。
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../../voxel/constants.js';
import { generateHeight } from '../terrain.js';
import { REDCITY_TRANSITION } from './region-config.js';
import { getRedCityInfo } from './redcity-layout.js';
import { getRedCityData } from './redcity-data.js';
import { landmarkHalfExtent } from './landmarks.js';

/** 外缘 0（= 自然高度），向内每 3 格多允许 1 格高差（与 City 的 getCityFinalSurfaceY 同构，独立实现） */
export function ringMaxDelta(edgeDistance) {
  return Math.floor(Math.max(0, REDCITY_TRANSITION - edgeDistance) / 3);
}

/**
 * 过渡环地表高度。e = max(自然高度, SEA_Y+1)（水域按海平面+1 计 = 水一律变陆地）；
 * s = clamp(baseY, e-m, e+m)，m = ringMaxDelta(d)。
 * 可证明的性质：相邻两格 |Δs| ≤ |Δe| + 1（clamp 对两端点 1-Lipschitz，m 相邻差 ≤1）——环只会在自然地形的高差上多加 ≤1。
 */
export function ringSurfaceY(edgeDistance, naturalH, baseY) {
  const e = Math.max(naturalH, SEA_Y + 1);
  const m = ringMaxDelta(edgeDistance);
  return e + Math.max(-m, Math.min(m, baseY - e));
}

/**
 * 点的 RedCity 地表高度：core = baseY + ground；ring = ringSurfaceY；influence 外 = max(自然高度, SEA_Y+1)。
 * @param {Object|null} [model] 缺省读模块缓存；未注入时 core 退化为 baseY（防御路径，见 apply.js 的降级语义）
 */
export function getRedCitySurfaceY(wx, wz, redCity, seed, model = getRedCityData()) {
  const info = getRedCityInfo(wx, wz, redCity);
  const n = generateHeight(wx, wz, seed);
  if (!info) return Math.max(n, SEA_Y + 1);
  if (info.zone === 'core') return redCity.baseY + (model ? model.ground[info.oz * model.width + info.ox] : 0);
  return ringSurfaceY(info.edgeDistance, n, redCity.baseY);
}

/**
 * core 列整形（阶段 1）：全深度实心（WORLD_MIN_Y+1 .. ground，不留洞穴/水体）+ 挖方（ground+1 .. max(自然高度, SEA_Y)，
 * 清掉自然树/残丘/水体）。直接写 typed array（单列 ~8 千次写入，比逐格 setBlock 闭包快一个量级）。
 */
export function shapeRedCityCore(column, lx, lz, groundY, naturalH, fillId) {
  const top = Math.min(WORLD_MAX_Y - 1, Math.max(naturalH, SEA_Y));
  for (let y = WORLD_MIN_Y + 1; y <= groundY; y++) { const i = blockIndex(lx, y, lz); column.blocks[i] = fillId; column.meta[i] = 0; }
  for (let y = groundY + 1; y <= top; y++) { const i = blockIndex(lx, y, lz); column.blocks[i] = 0; column.meta[i] = 0; }
}

/**
 * ring 列整形（阶段 1）。s = ringSurfaceY，n = 该列**原始**自然高度（可能 < SEA_Y，即水域）。
 *  - s > n（填方，含水域转陆地）：(n, s-2] 填 fill（clay，覆盖原水体——**不得清成 air**，否则地下出空洞）；s-1 写 sub；s 写 surf。
 *  - s < n（挖方）：(s, max(n,SEA_Y)] 清成 air；s 写 surf；s-1 写 sub。
 *  - s == n：不动（保留自然表层）。
 * surf/sub = 该点自然 biome 的表层/次表层（surfaceBlocksOfBiome），环带与外侧自然地形同色。
 * 因 s ≥ SEA_Y+1 恒成立，s 以上不会残留水。
 */
export function shapeRedCityRing(column, lx, lz, s, n, ids) {
  const set = (y, id) => { if (y <= WORLD_MIN_Y || y >= WORLD_MAX_Y) return; const i = blockIndex(lx, y, lz); column.blocks[i] = id; column.meta[i] = 0; };
  if (s > n) {
    for (let y = n + 1; y <= s - 2; y++) set(y, ids.fill);
    set(s - 1, ids.sub); set(s, ids.surf);
  } else if (s < n) {
    const top = Math.min(WORLD_MAX_Y - 1, Math.max(n, SEA_Y));
    for (let y = s + 1; y <= top; y++) set(y, 0);
    set(s - 1, ids.sub); set(s, ids.surf);
  }
}

/**
 * 地标是否被 RedCity 吞并：外包范围（landmarkHalfExtent）与 influence 相交 → **整个地标**不生成
 * （地形整形 + JSON 结构 + 植被上下文都跳过）。null-safe：redCity 或 center 缺失 → false（既有调用方不传 redCity）。
 * @param {{cx:number, cz:number}|null} center 布局里的地标中心
 */
export function landmarkErased(kind, center, redCity) {
  if (!redCity || !center) return false;
  const fp = landmarkHalfExtent(kind);
  if (!fp) return false;
  const r = redCity.influence;
  return !(center.cx + fp.halfX < r.minX || center.cx - fp.halfX > r.maxX
    || center.cz + fp.halfZ < r.minZ || center.cz - fp.halfZ > r.maxZ);
}

const NONE = Object.freeze({ pyramid: false, frozenMountain: false, snowLand: false, island: false, plainLand: false });
/**
 * 一个 region 布局里五类地标的「被吞并」标志。**每次 applyStructuresToColumn 调用只算一次**，
 * 阶段 1 / 阶段 2 / 阶段 3（pointContext）共用同一份——三处各算一遍会漂移出「地形没了、树还在」的悬空树。
 */
export function erasedFlags(layout, redCity) {
  if (!redCity) return NONE;
  return {
    pyramid: landmarkErased('pyramid', layout.pyramid, redCity),
    frozenMountain: landmarkErased('frozenMountain', layout.frozenMountain, redCity),
    snowLand: landmarkErased('snowLand', layout.snowLand, redCity),
    island: landmarkErased('island', layout.island, redCity),
    plainLand: landmarkErased('plainLand', layout.plainLand, redCity),
  };
}
