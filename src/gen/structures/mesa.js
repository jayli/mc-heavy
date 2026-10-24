// src/gen/structures/mesa.js — Cloudland 高台（桌山景观）落点候选发现
// 设计文档 docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md §3.3
//
// 两段式的**前一段**（与 scatter / giant-trees 同构，红线 2）：
//   本文件          computeMesaAnchor()：region 级候选发现（纯函数、无状态、跨 region 无缝）
//   apply.js 阶段 2.75  按锚点光栅化 + 让路判据
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**
// （候选在 layout 层算一次，DR-13；见「为什么用常量矩形而不是产物掩码」）。
//
// ## 素材形态决定了判据（实测，勿按「高台 = 下宽上窄」的直觉改）
// Landscape/9 是**桌山（蘑菇形）**：基座只有 15×15（164 格）、中部收腰、顶部 17×17 更宽。
// 所以「地基判据」必须落在**基座**上，不能落在 20×21 的并集外接框上 —— 并集里有 85 格
// （20%）在基座上根本没有方块，拿它做判据会把合法落点误杀，也会要求本不需要支撑的列。
//
// ## 为什么用常量矩形而不是烘焙产物里的 164 格掩码
// 掩码只存在于 `assets/structures/cloudland_mesa_small.json`，读它必须 fetch；而本函数在
// layout 层（Worker 内、纯函数）跑，fetch 会违反 DR-13 的「候选在 layout 层算一次」。
// 实测对照（16 个 region，同 seed 交替）：
//   A 164 格真实掩码 → 16/16 命中，锚点逐个一致，p50 0.39ms / max 0.95ms
//   B 15×15 实心矩形 → 16/16 命中，锚点逐个一致，p50 0.35ms / max 0.60ms
// B 只是多查 61 个角格；其 floorY 只会**更低或相等**（矩形包含对角低点）→ 埋没量略大但
// **绝不悬空**，方向安全。故取 B。
import { getBiome, seededRandom } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { computeSkyCandidates } from './sky-structures.js';
import { REGION_SIZE } from './region-config.js';
import { SEA_Y } from '../../voxel/constants.js';

/**
 * 基座半宽：基座是 x∈[-7,7] z∈[-7,7] 的 15×15 框（实测 164 格全落在框内）。
 * 改这个值必须同步 `MESA_METRICS.baseCells` 的语义（那是真实掩码的格数，不是矩形格数）。
 */
export const MESA_BASE_RECT_HALF = 7;

/**
 * 并集外接框半宽：**全部 335 列**的占地 bbox 是 x∈[-9,10] z∈[-11,9]（实测），
 * 取两个方向的最大绝对值 11。两个用途：① region 内缩量；② 空岛冲突的 AABB 外扩。
 */
export const MESA_UNION_HALF = 11;

/**
 * 台顶最高位（相对产物 y=1 的层高，实测 Landscape/9 是 42）。
 * 空岛冲突判据用它：空岛底 y 必须高于 `floorY + MESA_TOP_REL_Y`，否则台顶穿岛。
 */
export const MESA_TOP_REL_Y = 42;

/**
 * 候选排序（确定性乱序）的 salt。
 *
 * ⚠️ **程序化扫描确认空闲**，不能只 grep 字面量（带 `+ step`/`+ y` 的调用点占用的是区间）：
 *   · 已占用单值：100 / 200 / 201 / 301 / 302 / 303 / 311~314 / 777 / 800 / 801 /
 *     803~805 / 812 / 823 / 824 / 826 / 911 / 921 / 931 / 1000 / 2000 / … / 16000
 *   · 已占用区间：58..107（云簇 frontier `seed+58+step`）、270..397（landmarks `seed+302+y`）、
 *     102..112（terrain `seed+100+k`）
 *   → 空闲带 932..999，本设计取 950。
 */
export const MESA_SALT = 950;

/**
 * 候选扫描步长。实测 step=8：`getBiome` 全扫 0.067ms/region；step=1 要 3.79ms/region。
 * 步长 8 在 400×400 里仍有 ~250~1100 个沙漠候选点，贪心命中前 1~11 个就够（实测 max 11）。
 */
const SCAN_STEP = 8;

/**
 * region 内缩量：并集半宽 + 2 格余量。
 * 锚点离 region 边界更近时，20×21 的占地会越界，而相邻 region 的 layout **不会**为它生成
 * 锚点（各 region 独立算候选）⇒ 高台半边永久消失。这是「跨 region 边界缺一块」的唯一护栏。
 */
const REGION_INSET = MESA_UNION_HALF + 2;

/**
 * 计算单个 region 的高台锚点（至多 1 个）。
 *
 * 判据四条，缺一不可（每条都对应一种「静默产出错误高台」的缺陷，见 test-mesa.js）：
 *   ① 基座 15×15 每列都是 DESERT              —— 否则高台一半长在草地上
 *   ② 基座 15×15 每列 generateHeight > SEA_Y   —— 否则高台一半扎在海底
 *   ③ 不与任何空岛 AABB 相交（台顶不得穿岛）
 *   ④ 并集外接框完整落在本 region 内（内缩 REGION_INSET）
 *
 * `floorY = min(基座各列地表 h)` —— 取 **min** 而非中心点高度：min 保证任何一列基座都不悬空
 * （取中心点会让低洼侧露出空隙，实测 8% 的候选会有 4~8 格空隙）。代价是占地内高处的地形被
 * 台体埋没 ≤span 格（实测 span p50=1 / p95=3 / max=4，与「山体埋进地形」同一观感）。
 *
 * @param {number} regionX
 * @param {number} regionZ
 * @param {number} seed
 * @returns {{wx: number, wz: number, floorY: number}|null} 无沙漠 / 无合法落点时 null
 */
export function computeMesaAnchor(regionX, regionZ, seed) {
  const baseX = regionX * REGION_SIZE;
  const baseZ = regionZ * REGION_SIZE;
  const loX = baseX + REGION_INSET;
  const hiX = baseX + REGION_SIZE - REGION_INSET;
  const loZ = baseZ + REGION_INSET;
  const hiZ = baseZ + REGION_SIZE - REGION_INSET;

  // ① 便宜门：只查 biome 收集沙漠候选点（无候选 → 绝大多数非沙漠 region 在这里就返回）
  const cands = [];
  for (let wz = loZ; wz < hiZ; wz += SCAN_STEP) {
    for (let wx = loX; wx < hiX; wx += SCAN_STEP) {
      if (getBiome(wx, wz, seed) === 'DESERT') cands.push(wx, wz);
    }
  }
  if (cands.length === 0) return null;

  // ② 确定性乱序：按 seededRandom 升序，tie 用坐标字典序 → 跨机 / 跨 Worker 一致
  const order = [];
  for (let i = 0; i < cands.length; i += 2) order.push(i);
  order.sort((ia, ib) => {
    const ra = seededRandom(cands[ia], cands[ia + 1], seed + MESA_SALT);
    const rb = seededRandom(cands[ib], cands[ib + 1], seed + MESA_SALT);
    if (ra !== rb) return ra - rb;
    const dx = cands[ia] - cands[ib];
    if (dx !== 0) return dx;
    return cands[ia + 1] - cands[ib + 1];
  });

  const H = MESA_BASE_RECT_HALF;
  const sky = computeSkyCandidates(regionX, regionZ, seed).skyIslands;

  // ③ 就近命中即停
  for (const i of order) {
    const wx = cands[i], wz = cands[i + 1];

    // 基座全检（判据 ①②）：一趟同时算 biome、海平面、最低地表
    let minH = Infinity;
    let ok = true;
    for (let dz = -H; dz <= H && ok; dz++) {
      for (let dx = -H; dx <= H; dx++) {
        const nx = wx + dx, nz = wz + dz;
        if (getBiome(nx, nz, seed) !== 'DESERT') { ok = false; break; }
        const h = generateHeight(nx, nz, seed);
        if (h <= SEA_Y) { ok = false; break; }
        if (h < minH) minH = h;
      }
    }
    if (!ok) continue;

    // 判据 ③：不与任何空岛 AABB 相交（空岛底必须高于台顶）
    if (skyConflicts(sky, wx, wz, minH)) continue;

    // 判据 ④ 已由 REGION_INSET 的扫描窗构造性保证（扫描点本身就内缩了）
    return { wx, wz, floorY: minH };
  }
  return null;
}

/**
 * 台体与空岛的 AABB 冲突判定。
 *
 * 用 AABB 粗判而非逐格：空岛底 y∈[40,68]（region(1,1) 实测 68 个岛）、台顶最高 ≤ 53，
 * 判据已足够；逐格会引入不必要的复杂度，且空岛几何是逐层收窄的圆（AABB 已覆盖）。
 *
 * @param {Int32Array} islands stride 5: [originCx, originCz, bottomY, radius, height]
 */
function skyConflicts(islands, wx, wz, floorY) {
  const topY = floorY + MESA_TOP_REL_Y;
  for (let i = 0; i < islands.length; i += 5) {
    const ox = islands[i] * 16 + 8;
    const oz = islands[i + 1] * 16 + 8;
    const bottomY = islands[i + 2];
    const radius = islands[i + 3];
    // 水平不相交 → 不可能冲突
    if (Math.abs(ox - wx) > radius + MESA_UNION_HALF) continue;
    if (Math.abs(oz - wz) > radius + MESA_UNION_HALF) continue;
    // 空岛底低于台顶 → 穿岛
    if (bottomY <= topY) return true;
  }
  return false;
}
