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

import { noise, seededRandom } from '../noise.js';
import { blockIndex, WORLD_MIN_Y, WORLD_MAX_Y, SEA_Y } from '../../voxel/constants.js';
import { TERRAIN_HEIGHT_PARAMS, generateHeight } from '../terrain.js';
import { TARN_SLOPE_WIDTH, TARN_ICE_RADIUS, TARN_SNOW_RADIUS } from './tarn-zone.js';

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
 * 台地地表方块：**四带分区**的唯一权威（单测直接用，不复制一份判据 —— 红线 1）。
 *
 * ## 四带（v1.91，用户 2026-10-28 设计）
 *
 * | 带 | 半径 | 材质 |
 * |---|---|---|
 * | 冰 | `0 ~ TARN_ICE_RADIUS` | `ice` |
 * | 雪环 | `TARN_ICE_RADIUS ~ TARN_SNOW_RADIUS` | `snow`，环宽按方位角连续起伏 |
 * | 草斑 + 黏土 | `TARN_SNOW_RADIUS ~ platformRadius` | `clay` 基底 + 成片连通的 `grass`/`stone` 斑块 |
 * | 黏土缓坡 | `platformRadius ~ plateauRadius` | 整片 `clay` |
 *
 * ## 「渗透带」= 边界不是一条精确的圆
 *
 * 三条带的边界都加**噪声扰动**（`BAND_WOBBLE` 格），于是雪会滲进冰区一点、
 * 草斑会滲进雪环一点 —— 观感是自然的交错，而不是三条画出来的同心圆。
 * 实测扰动幅度（见常量注释）是「看得出过渡但不破坏分区」。
 *
 * ## 「松散」= 环带占空比不是 100%
 *
 * 雪环内部按低频噪声滤掉一部分（雪/非雪），于是环是断断续续的雪块，不是一条实心环。
 * `TARN_SNOW_FILL` 标定到实测占空比 ≈ 65%。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {number} cx @param {number} cz @param {number} platformRadius @param {number} plateauRadius
 * @returns {'ice'|'snow'|'clay'|'grass'|'stone'}
 */
export function tarnSurfaceBlock(wx, wz, seed, cx, cz, platformRadius, plateauRadius) {
  const d = Math.hypot(wx - cx, wz - cz);

  // ── 边界扰动：同一条噪声被三条带共用，边界才能彼此「渗透」而不是各自跳 ──
  const wobble = noise(wx, wz, seed + TARN_BAND_WOBBLE_SALT, TARN_BAND_WOBBLE_SCALE) * BAND_WOBBLE;

  // ── 缓坡带：整片 clay（接续外围地形，不过雪/冰） ──
  // ⚠️ 缓坡必须接受「整片一色」：它要跟外面的自然地形接上，
  //    那里是 grass/dirt/sand —— clay 的中立性观感最不突乑。
  if (d > platformRadius) return 'clay';

  // ── 冰带 / 融合带 / 雪环 ──
  //
  // 边界 = `TARN_ICE_RADIUS + iceWobble`（随方位角起伏，不是完美圆弧）。
  // 融合带是一条**贴着这条边界**的 `TARN_BLEND_WIDTH` 宽的带：
  //
  // | 相对位置 | 材质 |
  // |---|---|
  // | `d < b - half` | 纯 `ice` |
  // | `b - half ≤ d < b + half` | 融合带：冰比例随 t 从 ~95% 降到 ~8% |
  // | 再往外 | 雪环 |
  //
  // ⚠️ **融合带不能只是「边界加扰动」**：扰动只让边界变成波浪，两侧仍是硬切换
  //    —— 单条射线上读出来就是 `IIIII...SSSS`，没有任何过渡（实测）。要真的过渡
  //    就必须在带内按位置决定概率，见 `TARN_BLEND_WIDTH` 的注释。
  // ── 冰/雪边界：双向渗透（v1.93，用户 2026-10-29） ──
  //
  // ⚠️ **用户要求的不是「一条夹在中间的中性带」，而是「方块互相侵入对方地界」**。
  //    上一版把边界做成一条平滑的 `TARN_ICE_RADIUS + wobble` 圆弧、只在带内做比例渐变 ——
  //    结果**带外一刀切干净**（实测基准圆内侧 38 格内雪 0.0%、外侧 50~72 格内冰 0.0%），
  //    观感就是「冰到雪直接跳」，用户据此判断「过渡带没实现」。
  //
  // ✅ 修法 = **边界本身带高频齿**（`tarnIceBoundaryAt`）：
  //    低频噪声给大幅度的方位起伏，高频噪声给 ±`ICE_TOOTH` 的锯齿。
  //    齿让冰尖突进雪区、雪尖突进冰区 —— 这正是「互相侵入」。
  const iceBoundary = tarnIceBoundaryAt(wx, wz, seed);
  const blendHalf = TARN_BLEND_WIDTH / 2;
  if (d < iceBoundary - blendHalf) return 'ice';
  if (d < iceBoundary + blendHalf) {
    // 带内仍是按 t 的概率混合（把两侧的齿连起来，避免齿根处出现僵硬台阶）
    const t = (d - (iceBoundary - blendHalf)) / TARN_BLEND_WIDTH;
    const v = noise(wx, wz, seed + TARN_BLEND_SALT, TARN_BLEND_SCALE);
    return v <= 4 - 8 * t ? 'ice' : 'snow';
  }

  // ── 雪环：外缘也带齿（雪会往草斑带里渗透几格），内部松散 ──
  const snowOuter = TARN_SNOW_RADIUS + wobble;
  if (d < snowOuter) {
    if (noise(wx, wz, seed + TARN_SNOW_SALT, SURFACE_SCALE) > TARN_SNOW_FILL) return 'snow';
    return 'clay';
  }

  // ── 草斑 + 黏土（雪环以外到平台边缘） ──
  //
  // ⚠️ **必须用不可分离噪声 `blobNoise`，不能用 `noise()`**（v1.93，用户 2026-10-29）：
  //    用户报告「草地方块的边界过于横平竖直」。根因实测确认 —— `noise()` 的实现是
  //    `sin((x+seed)*s)*2 + cos((z+seed)*s)*2`，**x 项与 z 项可分离相加**，
  //    等值线必然是十字/菱形，边界上会出现几十格长的水平/垂直直线段（实测 36 格）。
  //    `blobNoise` 把 x、z 交叉耦合进同一个三角函数 → 等值线是弯曲的闭合斑块。
  //
  // 三档材质（各自边界都用**不同的** salt/尺度，所以三者互不平行）：
  //   clay（基底） / grass / stone / stone_diorite（浅色石，贴图均值 188）
  if (blobNoise(wx, wz, seed + TARN_PLOT_SALT, TARN_PLOT_SCALE) > TARN_PLOT_THRESHOLD) {
    // 草与石的交界：再用一层独立 blobNoise（尺度略大 ⇒ 石斑更大更圆）
    const stoneV = blobNoise(wx, wz, seed + TARN_STONE_SALT, TARN_STONE_SCALE);
    if (stoneV > TARN_STONE_THRESHOLD) {
      // ⚠️ **浅色石与 stone 必须用同一个 `stoneV` 的两个阈值档切分，
      //    不能再用第三层独立噪声**（v1.93 实测踩坑）：
      //    用独立噪声时，它与 `stoneV` 的等值线互相交叉 ⇒ 两族边界不断相交，
      //    交叉处会切出大量**长直缝**（实测掩码里交界出现几十格直线），
      //    观感就是用户说的「石头边界是直的」。
      //    同族阈值 ⇒ 两条边界是同一条等值线的不同档位，永远平行不相交。
      //
      // ⚠️ **浅色方块 = `light_gray_cloth`（用户 2026-10-29 指名：「light_stone 是指 Light_Gray_Cloth」）**。
      //    实测贴图均值 163（对比 stone 125 / smooth_stone_1 156 / stone_diorite 188）——
      //    比 stone 明显更亮，且是中性灰，与石头族的观感最接近。
      return stoneV > TARN_LIGHT_STONE_THRESHOLD ? 'light_gray_cloth' : 'stone';
    }
    return 'grass';
  }
  return 'clay';
}

/**
 * 不可分离的「斑块」噪声 —— 等值线是弯曲的闭合形状，不是十字/菱形。
 *
 * ⚠️ **存在的唯一理由**：`gen/noise.js` 的 `noise()` 是 `sin(x·s)·2 + cos(z·s)·2`，
 * x 与 z **可分离相加** ⇒ 等值线必带直边与直角。用 `noise()` 做斑块掩码时，
 * 草斑/石斑的边界就是横平竖直的（实测出现 36 格长的水平直线段）。
 *
 * 本函数把 x、z 交叉耦合进同一个三角函数（`sin(nx)·cos(nz)`、`sin(0.7nx+1.3nz)`、
 * `cos(hypot·)`），于是等值线不再可分离 → 边界弯曲。
 *
 * 值域标定在 **[-4, 4]**（实测 20 万样本 `[-3.97, 3.97]`，均值 -0.01），
 * 与 `noise()` 同口径 ⇒ 阈值不必重标。
 *
 * ⚠️ **本仓 Worker 同构约束**：纯函数、无 three/DOM，可在 Worker 里跑。
 *
 * @param {number} x @param {number} z @param {number} seed @param {number} scale
 * @returns {number} [-4, 4]
 */
export function blobNoise(x, z, seed, scale) {
  const nx = x * scale;
  const nz = z * scale;
  const s = seed * scale;
  const a = Math.sin(nx + s) * Math.cos(nz + s * 0.7) * 2;
  const b = Math.sin(nx * 0.7 + nz * 1.3 + s * 1.3) * 1.4;
  const c = Math.cos(Math.hypot(nx, nz) * 1.1 + s) * 0.6;
  return a + b + c;
}

/**
 * 冰/雪边界的**实际半径**（含双向渗透的齿）。
 *
 * = `TARN_ICE_RADIUS` + 低频方位起伏（±`WOB`）+ 高频锯齿（±`ICE_TOOTH`）。
 *
 * ⚠️ **导出给测试用**：测试要能算出「基准圆 44 内侧有多少格被雪侵入」，
 * 那是按**固定基准圆**判的（若按本函数算，侵入量恒为 0 —— 实测踩过）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {number}
 */
export function tarnIceBoundaryAt(wx, wz, seed) {
  const lowFreq = noise(wx, wz, seed + TARN_BAND_WOBBLE_SALT, TARN_BAND_WOBBLE_SCALE) * (ICE_WOBBLE / BAND_WOBBLE);
  // ⚠️ **`noise()` 值域是 [-4, 4]，不是 [-1, 1]** —— 齿幅度必须按 4 归一化。
  //    写成 `tooth * (ICE_TOOTH / 4)` 时实测齿只有 ±1.9×2.5 ≈ ±4.8 格，而
  //    低频谱又把边界整体推进了 +2~+4，齿**永远穿不出 44±8** ⇒ 侵入率只有 0.8%
  //    （低于断言要求，用户看到的就是「还是没有渗透」）。
  //    除以 4 才是「齿峰值 = ICE_TOOTH」。
  const tooth = noise(wx, wz, seed + ICE_TOOTH_SALT, ICE_TOOTH_SCALE) / 4;
  return TARN_ICE_RADIUS + lowFreq + tooth * ICE_TOOTH;
}

/**
 * 冰/雪渗透齿的幅度（格）。
 *
 * ⚠️ **这是「互相侵入」的唯一旋钮**：实测（基准圆 44 内侧 8 格 / 外侧 8~72 格）：
 * | ICE_TOOTH | 冰区里的雪 | 雪区里的冰 |
 * |---|---|---|
 * | 0（无齿） | 0.0% | 0.0% |
 * | 12 | 1.1% | 1.3% | 冰带纯度 89.9% |
 * | 16 | 3.2% | 3.4% | 86.8% |
 * | **20** | **5.6%** | **6.6%** | **84.2%** |
 * | 24 | 8.1% | 10.0% | 81.8% |
 * | 30 | 12.0% | 15.2% | 78.2% |
 *
 * 取 20：是「两侧侵入看得出来（≥5%）」与「冰带仍然纯净（≥80%）」的平衡点。
 * ⚠️ **齿越深侵入越明显、但纯净区越不纯** —— 这两个是竞争关系，不要只盯一头。
 */
const ICE_TOOTH = 20;

/**
 * 齿的噪声尺度。`1/0.9 ≈ 1.1 格`的周期 —— 比融合带（6 格）**窄得多** ⇒ 齿是密集的小锯齿，
 * 而不是又一层缓慢的大波浪（大波浪会和低频谱叠加成「边界整体漂移」，反而盖过融合带）。
 */
const ICE_TOOTH_SCALE = 0.9;

/** 齿的噪声 salt（与其它 salt 不撞）。 */
const ICE_TOOTH_SALT = 1030;

/** 草斑（grass vs clay）的噪声尺度。0.15 实测斑块大小适中、边界弯曲。 */
const TARN_PLOT_SCALE = 0.15;

/** 草/石交界（grass vs stone/stone_diorite）的噪声参数 —— 尺度略大 ⇒ 石斑更大更圆。 */
const TARN_STONE_SALT = 1031;
const TARN_STONE_SCALE = 0.11;

/** 草斑带里「是斑块（草/石）而非黏土」的阈值。实测 ≈57% 面积是斑块。 */
const TARN_PLOT_THRESHOLD = -1.2;

/** 斑块里「是石头而非草」的阈值（≈50%）。 */
const TARN_STONE_THRESHOLD = 0;

/**
 * 石头内部「浅色 `light_gray_cloth`」与「深灰 `stone`」的分档阈值。
 *
 * ⚠️ 与 `TARN_STONE_THRESHOLD` 是**同一个 `stoneV` 的两个档位**（不是独立噪声）——
 * 理由见 `tarnSurfaceBlock` 里那段注释：独立噪声会让两族边界交叉出长直缝。
 *
 * 取 0.8（`stoneV` 值域 [-4,4]）：石头区里约 **40%** 是浅色块。
 * 实测占比见 `test-tarn-terrain.js` 的「浅色石成片出现」用例。
 */
const TARN_LIGHT_STONE_THRESHOLD = 0.8;


/**
 * 冰/雪融合带的宽度（格）。
 *
 * ⚠️ **用户 2026-10-28 第二轮裁定 5~7 格**（「我希望他们两个相互之间有一个融合带，
 * 五到 7 个方块的融合带，让雪过渡到冰」）。取 6 格是中位值。
 *
 * ## 融合带怎么工作（与「边界扰动」不是一回事）
 *
 * 融合带是一条**贴着实际边界**的带（边界 = `TARN_ICE_RADIUS + wobble`，所以它随方位角起伏）。
 * 带内按相对位置 `t`（0 = 冰侧，1 = 雪侧）把一个**独立噪声**的阈值从 +4 线性移到 -4：
 * `ice` 当且仅当 `noise(...) <= 4 - 8t`。于是冰的比例随 t 平滑下降。
 *
 * ⚠️ **两条反直觉的实测结论（调试时踩过，勿重踩）**：
 *
 * ① **不能用「同半径一圈平均」验融合带**：同一半径上不同方位的 `t` 完全不同
 *    （因为边界随 wobble 起伏），平均后看不到渐变。
 * ② **也不能只看一条射线**：融合噪声在 6 格尺度上可能恰好单调，
 *    剖面读成 `IIIII...SSSS` 的假突变。
 *
 * 正确的量法 = 按 t 分桶统计冰比例（见 `test-tarn-terrain.js`），实测 6 个桶是
 * **95% → 83% → 63% → 38% → 22% → 8%**。
 */
export const TARN_BLEND_WIDTH = 6;

/**
 * 冰/雪边界的扰动幅度（格）—— 比 `BAND_WOBBLE` 小，理由见 `tarnSurfaceBlock`。
 *
 * ⚠️ **导出为了测试能复算“融合带到底在哪”**：融合带贴着的是
 * `TARN_ICE_RADIUS + wobble`，而不是裸的 `TARN_ICE_RADIUS`。
 * 测试自己再写一份扰动公式会与实现漂移（红线 1）。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @returns {number}
 */
export function tarnIceWobbleAt(wx, wz, seed) {
  return noise(wx, wz, seed + TARN_BAND_WOBBLE_SALT, TARN_BAND_WOBBLE_SCALE)
    * BAND_WOBBLE * (ICE_WOBBLE / BAND_WOBBLE);
}

/**
 * 融合带噪声的 salt 与尺度。
 *
 * ⚠️ **scale 是载荷性的，而且方向与直觉相反**：它决定融合带内的冰/雪是
 * 「交织」还是一整块。实测**局部同色率**（融合带内每格与其 4 邻居同材质的比例）：
 *
 * | scale | 波长 | 局部同色率 |
 * |---|---|---|
 * | 0.15 | ~40 格 | **88.7%** |
 * | 0.5 | ~12 格 | 87.0% |
 * | **0.8** | ~8 格 | **83.1%** |
 * | 2.0 | ~3 格 | 69.5%（开始像噪点） |
 *
 * 取 0.8：波长（≈8 格）与融合带宽度（6 格）同量级 ⇒ 带内真的是一块块冰/雪交织。
 * ⚠️ **0.15 那次踩过坑**：波长 40 格远大于 6 格带宽 ⇒ 整段融合带被同一股噪声覆盖，
 * 真实现与「前半纯冰后半纯雪」的局部同色率几乎相同（88.7% vs 87.8%）——
 * 断言因此失去了判别力（负向验证实测注入后仍全绿）。
 *
 * salt 的取值则确实不敏感：与扰动噪声同源（1027）时冰比例与 t 的相关系数只有 -0.013。
 */
const TARN_BLEND_SALT = 1029;
const TARN_BLEND_SCALE = 0.8;

/**
 * 冰/雪边界的扰动幅度（格）—— 比 `BAND_WOBBLE` 小，理由见 `tarnSurfaceBlock`。
 */
const ICE_WOBBLE = 3;

/**
 * 带状边界扰动的幅度（格）。
 *
 * ⚠️ **这是「滲透带」的唯一旋钮**：0 = 三条完美的同心圆（硬边界）；
 * 大到接近带宽的一半会把分区打碎。实测 6 格 ≈ 「看得出交错但每条带依然认得出」。
 */
const BAND_WOBBLE = 4;

/**
 * 带状边界扰动的噪声尺度。取低频（≈1/20 格）使边界呈大而缓的波浪，不是铲齿。
 */
const TARN_BAND_WOBBLE_SCALE = 0.05;

/**
 * 雪环内「非雪」的阈值：`noise(...) > TARN_SNOW_FILL` 时为雪。
 *
 * ⚠️ `noise()` 值域是 [-4, 4]，不是 [0,1]（实测 20 万样本 min -4.000 / max 4.000）。
 * 实测分位：`> -1` 占 69.3%、`> -0.5` 占 61.4%、`> 0` 占 50.1%。
 * 取 **-1.0** ⇒ 理论 69%，但环带外缘会被扰动切掉一部分 ⇒ 实测环内占空比（见测试）。
 */
const TARN_SNOW_FILL = -2.5;

/**
 * 雪环疏密的噪声 salt（与草斑、扰动分开，否则三者相位相关 —— 雪洞会排成直线）。
 */
const TARN_SNOW_SALT = 1025;

/** 草斑排布的噪声 salt。 */
const TARN_PLOT_SALT = 1026;

/**
 * 带状边界扰动（滲透带）的噪声 salt。
 */
const TARN_BAND_WOBBLE_SALT = 1027;

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

// ==================== 地带草地的单格植被（v1.93） ====================

/**
 * `short_grass` 的盐。**用程序化扫描确认空闲**（`seed + N` 的区间占用要一起算，
 * grep 字面量会漏）：1020~1031 已被 tarn 系列占满（`TARN_ZONE_SALT` … `TARN_STONE_SALT`），
 * 1032 起是大段空闲带，故取 1032。
 */
const TARN_GRASS_SALT = 1032;
/** `azure_bluet` 的盐。与上面同一段空闲带，取相邻的 1033。 */
const TARN_FLOWER_SALT = 1033;

/**
 * 地带草地上是否长一株单格植物（v1.93，用户 2026-10-29：「高台地图的草地上随机生成
 * 一些 short_grass 和 azure 花」）。
 *
 * ## 只在 `grass` 上长
 *
 * 判据直接调 `tarnSurfaceBlock()` —— **不另写一套「哪里有草」的判据**（红线 1）。
 * 地带的冰 / 雪环 / 黏土 / 缓坡上一株都不长，正是用户要的「草地上」。
 *
 * ## 密度 = 普通 PLAINS 同口径
 *
 * 用户裁定「按照 PLAINS 同密度做」。`vegetation.js` 的 PLAINS 分支是：
 * `short_grass` 5%、花档 5%（10%~5% 区间）且在花档内 1/3 是 `azure_bluet`
 * → 草的 5% + azure_bluet 约 1.67%，与这里逐值对齐。
 * ⚠️ 两份概率各自独立计算（不用嵌套区间），是为了让「草」与「花」互不挤占 ——
 * PLAINS 的花档其实挤掉了 5% 的草抽签，但那是上游的实现细节，观感上等价于独立抽样。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{cx:number, cz:number, platformRadius:number, plateauRadius:number}} layout
 * @returns {'short_grass'|'azure_bluet'|null}
 */
export function tarnPlantAt(wx, wz, seed, layout) {
  const { cx, cz, platformRadius, plateauRadius } = layout;
  if (tarnSurfaceBlock(wx, wz, seed, cx, cz, platformRadius, plateauRadius) !== 'grass') return null;
  if (seededRandom(wx, wz, seed + TARN_GRASS_SALT) < TARN_GRASS_CHANCE) return 'short_grass';
  if (seededRandom(wx, wz, seed + TARN_FLOWER_SALT) < TARN_FLOWER_CHANCE) return 'azure_bluet';
  return null;
}

/** `short_grass` 的逐格概率（= PLAINS 的 0.05，见 `tarnPlantAt`）。 */
const TARN_GRASS_CHANCE = 0.05;
/** `azure_bluet` 的逐格概率（= PLAINS 花档 0.05 × 花档内 1/3 ≈ 0.0167）。 */
const TARN_FLOWER_CHANCE = 0.05 / 3;

/**
 * 地带内任意点的**地表高度**（纯函数，v1.92）。
 *
 * 与 `fillTarpPlateau` 的 `targetY` 公式**同一份**（平台恒 `plateauY`；缓坡从 `plateauY`
 * 线性插值到平滑后的自然高度；圆外返回自然高度）。有了它，瞬移可以在**目标 column
 * 尚未加载**时就算出正确落脚高度 —— 不必等 GEN（实测：vd=2 时加载半径只有 48 格，
 * 传送 1200 格外的地带永远等不到 `_waitForColumn`，超时 30s 且 async 异常被吞，
 * 按钮看起来完全没反应）。
 *
 * ⚠️ **必须与 `fillTarnPlateau` 用同一个 `slopeNaturalHeight`**，不得各写一份插值 ——
 * 两份漂移会让「瞬移落点的高度」与「真实地表」差几格，表现是玩家悬空或埋进土里。
 *
 * @param {number} wx @param {number} wz @param {number} seed
 * @param {{cx:number, cz:number, platformRadius:number, plateauRadius:number, plateauY:number}} layout
 * @returns {number} 该列地表的 y（方块所在的那一格）
 */
export function tarnSurfaceYAt(wx, wz, seed, layout) {
  const { cx, cz, platformRadius, plateauRadius, plateauY } = layout;
  const d = Math.hypot(wx - cx, wz - cz);
  if (d > plateauRadius) return generateHeight(wx, wz, seed);
  if (d <= platformRadius) return plateauY;
  const t = (d - platformRadius) / (plateauRadius - platformRadius);
  return Math.round(plateauY * (1 - t) + slopeNaturalHeight(wx, wz, seed) * t);
}

/**
 * 雪盖能触及的最高 y。
 *
 * = 高台最高高度（`plateauY` + 46，产物里最高的 `cloudland_tarn_04` 是 45 层）上方余量；
 * 巨型云在 y ≥ `TARN_CLOUD_MIN_Y`（54），两者不重叠。
 */
const TARN_SNOW_CAP_MAX_Y = 50;

/**
 * 高台顶层的覆写（v1.91 雪盖 + **v1.94 顶部草换 snow_grass**）。
 *
 * 逐列**从上限向下**找「本格非空且上方一格是空气」的最高那一格（= 该列真正的露天顶层），
 * 按两级处理：
 *
 * | 顶层是 | 条件 | 换成 |
 * |---|---|---|
 * | `grass` | **不限半径**（整个地带圆内） | `snow_grass` |
 * | 其他（石头/深板岩/黏土…） | 在雪环带内 | `snow` |
 *
 * ## 为什么草顶不看半径（v1.94 用户裁定）
 *
 * 用户 2026-10-29：「高台地带的**所有**顶部的草方块都换成 snow_grass，统一都渲染成这个
 * 方块，**不再让雪方块和草方块交替**」。旧实现的草顶按雪环带判 → 高台顶部是「雪/草交错」的
 * 斑驳感。现在草顶一律 `snow_grass`，腰部（非草顶且落在雪环带）照旧覆 `snow`。
 *
 * ⚠️ **两级必须按这个顺序判**（先判 grass）：反过来的话，雪环带内的草顶会被判成「其他」
 * 覆成 `snow`，于是草顶又变成雪草交替 —— 正是用户要消除的形态。
 *
 * ## 为什么必须在光栅化之后调
 * `fillTarnPlateau` 跑的时候高台还没长出来，那里只能看到台地地表。
 *
 * ⚠️ **只换顶层一格，不往下挖**：写成「从 plateauY 到露天层全部换」会让高台变成一根
 * 同色柱子；只换顶层 = 「高处积了一层」的自然观感，也保住建筑的墙面/楼层。
 *
 * ⚠️ **扫描方向必须是「从上往下」（v1.95 实测修复）**：从 `plateauY` 往上扫时，
 * 台地平台层本身就满足「实心 + 上方空气」→ 每列都在平台层 `break`，高台本体的顶
 * 一格都换不到（实测 tarn_04 残留 **428 格 grass**、全部 8 座合计 **659 格**）。
 *
 * ⚠️ **上限算到 `TARN_SNOW_CAP_MAX_Y`**：巨型云在 y=54~95，不能被当成「地表」而盖。
 *
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {import('./tarn-zone.js').TarnLayout} layout
 * @param {number} seed
 * @param {import('../../voxel/block-registry.js').BlockRegistry} registry
 * @param {(wx:number, y:number, wz:number, name:string)=>void} setBlock
 */
export function tarnSnowCap(column, layout, seed, registry, setBlock) {
  const { cx, cz, plateauRadius, plateauY } = layout;
  const colMinX = column.cx * 16, colMinZ = column.cz * 16;
  const x0 = Math.max(colMinX, Math.ceil(cx - plateauRadius));
  const x1 = Math.min(colMinX + 15, Math.floor(cx + plateauRadius));
  const z0 = Math.max(colMinZ, Math.ceil(cz - plateauRadius));
  const z1 = Math.min(colMinZ + 15, Math.floor(cz + plateauRadius));
  if (x0 > x1 || z0 > z1) return;

  for (let wx = x0; wx <= x1; wx++) {
    const dx = wx - cx;
    for (let wz = z0; wz <= z1; wz++) {
      const dz = wz - cz;
      const d = Math.hypot(dx, dz);
      // ⚠️ 边界也用同一条扰动噪声（与 `tarnSurfaceBlock` 的滲透带同源），
      //    否则雪盖会在雪环外缘形成一条完美圆弧，与下方松散的雪地脱节。
      // 雪环带判据**只用于「非草顶」那一级**（草顶不限半径，见函数注释）。
      const wobble = noise(wx, wz, seed + TARN_BAND_WOBBLE_SALT, TARN_BAND_WOBBLE_SCALE) * BAND_WOBBLE;
      // ⚠️ 冰/雪边界必须与 `tarnSurfaceBlock` **同源**（`tarnIceWobbleAt`，
      //    幅度 ICE_WOBBLE 而非 BAND_WOBBLE）—— 两份漂移会让高台顶的雪盖
      //    与地面的雪环错开几格，接缝处露出一个「雪盖悬在冰面上」的台阶。
      const iceWobble = tarnIceWobbleAt(wx, wz, seed);
      const inSnowRing = d > TARN_ICE_RADIUS + iceWobble - TARN_BLEND_WIDTH / 2
        && d < TARN_SNOW_RADIUS + BAND_WOBBLE + wobble;

      const lx = wx - colMinX, lz = wz - colMinZ;
      // 从**上往下**找该 column 最高的那个「露天顶层」，不是从下往上找第一个。
      //
      // ⚠️ **方向是载荷性的（v1.95 实测修复）**：原实现从 `plateauY` 向上扫，遇到第一个
      //    「本格非空 + 上方是空气」就 `break` —— 而台地平台层（y = plateauY）本身就是
      //    「实心 + 上方空气」，于是**每一列都在平台层就跳出**，高台本体（y 30~46）的
      //    顶部草一格都没被换。表现就是用户看到的「只换了一个高台」。
      //    正确做法：从上限往下扫，第一个非空格就是该列真正最高的露天顶层。
      for (let y = TARN_SNOW_CAP_MAX_Y; y >= plateauY; y--) {
        const id = column.blocks[blockIndex(lx, y, lz)];
        if (id === 0) continue;                                        // 空 → 还没到该列最高格
        if (column.blocks[blockIndex(lx, y + 1, lz)] !== 0) continue;  // 上方还有 → 不是顶层
        const name = registry.nameOf(id);
        // ⚠️ **先判 grass**（不限半径）：见函数注释「两级必须按这个顺序判」。
        if (name === 'grass') {
          setBlock(wx, y, wz, 'snow_grass');
        } else if (inSnowRing && name !== 'snow' && name !== 'snow_grass') {
          setBlock(wx, y, wz, 'snow');
        }
        break;
      }
    }
  }
}

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

      // ── 2. 地表：四带分区（v1.91，用户 2026-10-28 设计） ──
      const surfaceName = tarnSurfaceBlock(wx, wz, seed, cx, cz, flatR, plateauRadius);
      column.blocks[blockIndex(lx, targetY, lz)] = idOfName(surfaceName);

      // ── 3. 向下填实（防止玩家从地表掉进原地下水/空气腔） ──
      // ⚠️ **v1.89：地下水也要换成石头**（用户 2026-10-27 裁定「确保这次新增的高台地形……
      // 其他不应该有任何差异」+「高台所在的水面完全去掉」）。清掉 `water`/`swamp_water` 是
      // 让地带**彻底不含透明方块**的最后一步 —— 不填的话自然地形原有的地下水体留在原地，
      // 既占 transparent 通道，也让「平台内无水」这个断言无法成立。
      for (let y = WORLD_MIN_Y + 1; y < targetY; y++) {
        const idx = blockIndex(lx, y, lz);
        const cur = column.blocks[idx];
        if (cur === 0 || cur === waterId || cur === swampWaterId) column.blocks[idx] = stoneId;
      }

      // ── 4. 洼地回水（v1.91 修 bug，用户 2026-10-28 报告） ──
      // ⚠️ **不改这一步的形态是：「高台地带与外围地图接壤处，原有水方块没被延伸过来」** ——
      //    削平循环把 `targetY` 以上全写成 0（连原水体一起清），而第 3 步只写 stone、
      //    **从不写 water** → 缓坡带里 `targetY < SEA_Y` 的列就成了低于海平面的**干坑**。
      //    实测 seed 12345 的一座地带：圆内 **4179 列**成干坑、原有 **148012 格水**全被清掉。
      //
      // 判据与 `fillColumn` 的水面填充**完全同源**（`(h, SEA_Y]`，`SEA_Y` 常量直接 import），
      // 不另写一份阈值 —— 两份漂移会搞出「水方块填到 SEA_Y-1，水面平面画在 SEA_Y+0.5」
      // 那种水比水面矮一格的翲裂。
      //
      // 注：平台内地表恒为 `plateauY` = SEA_Y+4 > SEA_Y，这段循环对平台内是空转，
      // 只在缓坡带真的低于海平面时才生效。
      for (let y = targetY + 1; y <= SEA_Y; y++) {
        column.blocks[blockIndex(lx, y, lz)] = waterId;
      }
    }
  }
}
