// src/gen/structures/tarn-zone.js — 高台地带（Cloudland Tarn Zone）候选与布局
// 设计文档 docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md DR-1~DR-10
//
// 两段式的前一段（与 scatter / giant-trees / mesa / giant-pyramid 同构，红线 2）：
//   本文件               computeTarnZone()：region 级布局（纯函数、无状态、无 fetch）
//   apply.js 阶段 2.4    按布局光栅化到 column
//
// Worker 同构：不得 import three、不得自建 Worker、**不得 fetch**（候选在 layout 层算一次，DR-13）。
import { seededRandom, getBiome } from '../noise.js';
import {
  REGION_SIZE, CITY_REGION, CITY_TRANSITION_SIZE, SNOW_LAND_SIZE, TRANSITION_SIZE, LANDMARK_OFFSET,
} from './region-config.js';
import { getRegionSeededCenter } from './region-center.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { KIT_METRICS, KIT_VARIANTS } from './cloudland-kit-data.js';
// `SEA_Y` 只依赖 `voxel/constants.js`（无 three、无 DOM），Worker 同构层可直接 import。
// 先例：`gen/structures/giant-trees.js:18` 同一个 import。
import { SEA_Y } from '../../voxel/constants.js';

// ==================== 地带尺度 ====================

/**
 * 地带半径（圆）：平台 114 + 缓坡 24。
 *
 * ⚠️ **必须满足 `TARN_ZONE_RADIUS + 2 <= REGION_SIZE / 2`**（实测 138 + 2 = 140 ≤ 200）：
 * 地带圆心固定在 region 中心，圆越界就意味着地带半边**永久消失**（相邻 region 不为它算候选）。
 *
 * ⚠️ **v1.90 从 160 收到 138**（用户 2026-10-28 裁定「核心高台区域外围的缓坡地带有点太大，
 * 可以适当缩小一些」）：面积降到原来的 74%，缓坡占面积比从 44% → 32%。
 * 缓坡 24 格的依据 = 让「走不上去的列」占比 0.32%，与自然地形本身 0.19% 同一量级
 * （再缩到 20 格会升到 0.41%，16 格升到 0.48%）。
 */
export const TARN_ZONE_RADIUS = 138;

/**
 * 平台半径（地形恒定为 `plateauY` 的内圈）= 地带半径 − 缓坡宽度。
 *
 * ⚠️ **缓坡宽度住在本文件**（而不是 `tarn-terrain.js`）：`isTarnZone` 的「核心沙漠占比」
 * 判据要采到平台边缘，而它是 `(regionX, regionZ, seed)` 的**纯函数** —— 若把坡宽当参数传进去，
 * 两个调用点传不同值就会得到不同的地带判定（红线 1 正是要防这个）。
 * `tarn-terrain.js` 反过来 import 它，方向单一不会成环。
 */
export const TARN_SLOPE_WIDTH = 24;

/**
 * 平台半径（唯一权威）= `TARN_ZONE_RADIUS - TARN_SLOPE_WIDTH` = 114。
 *
 * 从这个半径往外，地表在 `TARN_SLOPE_WIDTH` 格内线性过渡到自然地形高度。
 * 实测依据（改坡宽前必看）：
 *
 * | 坡宽 | 地带半径 | 「走不上去」的列占比（对比自然地形本身 0.19%） |
 * |---|---|---|
 * | 40（v1.89） | 160 | 0.20% |
 * | **24**（现行） | 138 | **0.32%** |
 * | 20 | 133 | 0.41% |
 * | 16 | 129 | 0.48% |
 *
 * ⇒ 24 是「缩外形」与「缓坡仍可走上去」之间的实测平衡点（`MAX_STEP = 1.0`，玩家跑步直接上）。
 */
export const TARN_PLATFORM_RADIUS = TARN_ZONE_RADIUS - TARN_SLOPE_WIDTH;

/**
 * 高台环半径（轴对齐摆放，spec DR-7 方案 1）。
 *
 * ⚠️ **这是实测标定值，不是公式**：58 是「定稿 8 座的四角全部落在池内」的上限
 * （59 起 L3 四角最远 90.73 > 池半径 90）。轴对齐下最远角与环上角度 θ 有关，没有闭式解，
 * **不要写成 `TARN_POOL_RADIUS − max(half) − 4` 这类公式**。改池半径 / 改保留组合 →
 * 必须重新穷举标定这个值。
 */
export const TARN_RING_RADIUS = 58;

/**
 * 相邻高台的 **AABB 真实最小间距**（格）。抖动必须钳制，使该值恒成立（DR-7）。
 *
 * ⚠️ **原值 10 是「长边切向朝心」旋转假设下的口径，轴对齐下几何上达不到**
 * （AABB 真实间距只有 ~5.05 格；缩 ringR / 重排顺序 / 加大抖动三条路都试过，都救不回 10）。
 * 用户第六轮裁定改为 4。改这个值前先读 spec DR-7「轴对齐的固有代价」。
 */
export const TARN_GAP = 4;

/**
 * 地带出现概率：**合格草地里的五取一**（用户 2026-10-28 裁定）。
 *
 * ⚠️ **它作用在「通过全部资格判据」的 region 上，不是作用在全部 region 上**。
 * 合格集合 = 中心 PLAINS + 圆周挨沙漠 + 核心沙漠占比 ≤ `TARN_DESERT_CAP` + 不撞城市。
 * 实测（62 个 seed 的 ±12 窗口）合格集上命中率均值 **0.1963**（期望 0.20），
 * p10 = 0.160 / p90 = 0.229，94% 的 seed 落在 ±0.05 内。
 *
 * 最终密度（7 seed 实测）= 每 **13.6~23.1** 个 region 一座。改这个数只动密度、不牵动几何。
 */
export const TARN_ZONE_CHANCE = 1 / 5;

/**
 * 核心平台允许的沙漠占比上限（`TARN_ZONE_CHANCE` 之外的第二道观感门）。
 *
 * ⚠️ **这个数不是可选的**：合格 region 的核心沙漠占比分布是 p50 = 0.083、p90 = 0.28、
 * p95 = 0.37、max = 0.44（5 seed 实测）—— 没有它，抽中的地点有 **15%** 的核心平台一半以上是
 * 沙漠，观感是「高台盖在沙漠上」。25% 恰好切在 p90 与 p95 之间。
 */
export const TARN_DESERT_CAP = 0.25;

/**
 * 「草地地形」biome 集合。
 *
 * ⚠️ **用户 2026-10-28 两轮裁定**：先答「只有 PLAINS」，实玩后报「再也碰不到高台地带」，
 * 再改为**放宽到 PLAINS + FOREST + AZALEA**。SWAMP 仍排除（湿地有它自己的观感）。
 *
 * 实测（±12 = 625 region，6 seed 均值）资格命中率：
 * | biome 集合 | 资格 | ×1/5 后密度 |
 * |---|---|---|
 * | 只有 PLAINS | 32.9% | 每 15.2 region 一座 |
 * | **+FOREST+AZALEA（现行）** | **66.0%** | **每 7.6 一座** |
 * | +SWAMP | 66.4% | 每 7.5 一座（几乎无增益，故不加） |
 *
 * ⚠️ **放宽 biome 是提密度的唯一有效途径**：实测「挨沙漠」那条判据对 PLAINS
 * 完全不起作用（去掉它资格仍是 33.7%）—— 因为「沙漠占比 ≤25%」已经把邻近沙漠的
 * PLAINS 全排掉了，两条判据高度重叠。所以想变密只能放宽 biome。
 */
export const TARN_HOST_BIOMES = Object.freeze(['PLAINS', 'FOREST', 'AZALEA']);

/**
 * 地表材质分区（v1.91 重做，用户 2026-10-28 设计）。
 *
 * 从圆心往外四带（半径均为格）：
 *
 * | 带 | 半径 | 材质 |
 * |---|---|---|
 * | 冰 | `0 ~ TARN_ICE_RADIUS`(44) | `ice` |
 * | 雪环 | `TARN_ICE_RADIUS ~ TARN_SNOW_RADIUS`(72) | `snow`，按噪声成≈环宽连续起伏的环带 |
 * | 草斑 + 黏土 | `TARN_SNOW_RADIUS ~ platformRadius`(114) | `clay` 基底 + 成片连通的 `grass`/`stone` 斑块 |
 * | 黏土缓坡 | `platformRadius ~ plateauRadius`(138) | 整片 `clay`，接续外围地形 |
 *
 * ⚠️ **四带的边界位置住在本文件（而不是 `tarn-terrain.js`）**：
 * ① 它们是「地带的形状」而不是「整形实现」，与半径/坡宽同口径；
 * ② `tarn-terrain.js` 从 `tarn-zone.js` import 常量，而反之会成环（同 `TARN_SLOPE_WIDTH` 的理由）；
 * ③ 将来 `isTarnZone` / 水面遮罩若要接「平台内无水、缓坡有水」的门控，读的就是同一份。
 *
 * ⚠️ **不能改回 `tarnSurfaceBlock` 里写死数字**：那样「带边界」会变成渲染实现细节，
 * 单测就没法在不跑网格的前提下断言「冰带确实到 44 为止」。
 */
export const TARN_ICE_RADIUS = 44;

/** 雪环外缘半径（格）。冰带以外、草斑带以内。 */
export const TARN_SNOW_RADIUS = 72;

/**
 * 中心广场半径（格）—— 石英柱围成的圆圈内，地表整片铺 `smooth_stone_1`。
 *
 * **用户 2026-11-03**：「中心石英柱子围成的圆圈区域内，用 smooth_stone_1 铺设，
 * 中间正南正北有一个十字形状的三个方块宽度的十字，十字形状用 tuff_briks 铺设，
 * 就铺设地表一层，地下仍然是冰块」。
 *
 * ⚠️ **半径 28 是实测标定值，不是猜的**：七根紫晶柱摆在环半径 `TARN_SPIRE_RING_RADIUS`(20) 上，
 * 而它们的**真实烘焙足迹**（不是 AABB）逐格量到圆心：
 * | 口径 | 12 seed × 各自地带的最小值 | 最大值 |
 * |---|---|---|
 * | 全部高度的格到圆心（格方块 AABB 距离） | **13.04** | — |
 * | 最外层那圈格（含顶部出挑） | — | **25.4** |
 * | 基座层（`y = 1`，即柱脚） | **16.00** | 23.0 |
 * 取 28：把七根柱子的**全部方块**都罩在广场里，柱脚外侧还留 2.6 格空地。
 * 取 20 会让柱子一半压在广场之外（广场与柱脚交界参差）。
 *
 * ⚠️ **必须 < `TARN_ICE_RADIUS`(44)**：广场外仍要留一圈冰带（44 − 28 = 16 格），
 * 否则「中心冰带」这个既有特征被广场吃光。
 */
export const TARN_PLAZA_RADIUS = 28;

/**
 * 十字臂的半宽（格）：`1` ⇒ 臂宽 **3 格**（用户 2026-11-03 指定「三个方块宽度的十字」）。
 *
 * 判据是 `|dx| <= 半宽 || |dz| <= 半宽`（正南正北、轴对齐），与广场圆取交 ⇒ 臂端止于圆周。
 * ⚠️ **与 `TARN_PLAZA_RADIUS` 是**一组耦合常量**：改半宽会同时改「十字占广场的面积比」
 * （实测半宽 1 ⇒ 325/2453 = 13.2%），单测里有一条按它派生的占比断言。
 */
export const TARN_PLAZA_CROSS_HALF_WIDTH = 1;

/**
 * 圆心到城市 bounds 的最小净距（格）—— 取 `CITY_TRANSITION_SIZE`（红线 1：不另写 32）。
 *
 * ⚠️ **城市排除必须在候选层，不能只靠 apply 层**（与巨型金字塔踩过的坑同源）：
 * 只在 apply 判时，被丢弃的地区会**静默变空地**（植被/巨树已按 `kind:'tarn'` 让路却长不出台地）。
 * 实测（改造前）8 个 seed 里 **6 个有地带撞城市**，最深 **112 格**（seed 12345 的 region(1,-1)）——
 * 地带的平顶高原直接压在城市地面上。
 */
const TARN_CITY_CLEARANCE = CITY_TRANSITION_SIZE;

/**
 * 台地高度（= `SEA_Y + 4`）。
 *
 * ⚠️ **这是几何常量而不是地形常量**，所以放在本文件而不是 `tarn-terrain.js`
 * （后者依赖前者，放那边会成环）。Task 4 的整形、Task 5 的高台 y、Task 6 的水面平面
 * 全部读同一个值 —— 各写一份会漂移出「水漫过台地」或「台地浮在水面上」。
 *
 * ⚠️ **必须从 `SEA_Y` 派生，不得写字面量 2**：写成字面量后单测里的
 * `assertEqual(TARN_PLATEAU_Y, SEA_Y + 4)` 才真的能抓到「台地高度漂了」——
 * 若两边同源（断言 `lay.plateauY === TARN_PLATEAU_Y`），改常量时断言跟着变，恒真。
 */
export const TARN_PLATEAU_Y = SEA_Y + 4;

/**
 * 巨型云的最低 y（Task 5 要 import）。
 *
 * 取 54 = 台地 y(2) + 高台最高高度(46) + 6 格间隙：定稿 8 座里最高的是 tarn_05/tarn_06
 * （高 46/39），顶面 y = 2 + 46 = 48，留 6 格净空。
 * 云最高 38 层 → 云顶 ≤ 54 + 38 = 92 ≤ `WORLD_MAX_Y = 96`。
 */
export const TARN_CLOUD_MIN_Y = 54;

// ==================== 高台组合 ====================

/**
 * 运行时实际使用的 8 座高台（产物基名，顺序 = `.schem` 分量序）。
 *
 * ⚠️ **烘焙产出 11 座，只用 8 座** —— 这不是「漏了 3 个」，是 spec DR-5f/DR-7 穷举后的定稿：
 * 约束「不扩容（reserved ≤ 125,000）且四角落池内」，取高台总格数尽量大的组合
 * （139,014 格 / reserved 98,235 = 78.6%）。
 *
 * ⚠️ 早期的「格数最大」组合（188,944 格）因含 L1（68×60）被否决：它在 ringR=58 上
 * 吃掉 71.6° 占角，8 座总占角超 360° → 环上排不下。
 *
 * 舍弃：cloudland_tarn_01(83,145) / cloudland_tarn_02(50,327) / cloudland_tarn_07(12,624)。
 * ⚠️ 保留 tarn_03（L3）—— 它是 44×48，是定稿组合里最大的一座（四角最远 88.88 ≤ 90）。
 * 改这个列表 = 改水池的容量占用与环半径标定 → **必须重跑 test-tarn-zone.js 的布局用例**。
 */
export const TARN_KEPT_TARN_IDS = Object.freeze([
  'cloudland_tarn_03', 'cloudland_tarn_04', 'cloudland_tarn_05', 'cloudland_tarn_06',
  'cloudland_tarn_09', 'cloudland_tarn_08', 'cloudland_tarn_10', 'cloudland_tarn_11',
]);

// ==================== salt 分配 ====================
//
// 程序化扫描确认 1016..1099 空闲（带 `+ offset` 的调用点占用的是区间，不能只 grep 字面量）。
// 本设计占用 1020..1024，逐项分配见 spec §8。

/** 地带判定的 salt。 */
export const TARN_ZONE_SALT = 1020;
/** 高台角度抖动的 salt（与判定用不同值，否则「顺序靠前的更容易过」产生偏斜）。 */
export const TARN_ANGLE_SALT = 1021;
/** 台地草石镶嵌的 salt（Task 4 消费）。 */
export const TARN_TERRAIN_SALT = 1022;
/** 拱洞/紫晶柱落位的 salt。 */
export const TARN_DECO_SALT = 1023;
/** 巨型云选择与角度的 salt。 */
export const TARN_CLOUD_SALT = 1024;

// ==================== 地带判定 ====================

/**
 * 地带圆到某个矩形的最短距离（格，重叠为负）—— **唯一实现**，供消费方与断言共用。
 *
 * 城市之外的消费方也可用（例如门禁校验「地带圆不碰城市」）。
 * @param {number} cx @param {number} cz @param {number} radius
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} rect
 * @returns {number}
 */
export function circleRectGap(cx, cz, radius, rect) {
  const dx = Math.max(0, rect.minX - cx, cx - rect.maxX);
  const dz = Math.max(0, rect.minZ - cz, cz - rect.maxZ);
  return Math.hypot(dx, dz) - radius;
}

/**
 * 核心平台内的沙漠占比（`0`~`1`）。
 *
 * 采样 = 圆心 1 点 + 6 圈 × 24 方位点（共 145 点，半径均匀铺到平台边缘）。
 * ⚠️ **必须采到平台边缘**（最后一圈 r = `tarnPlatformRadius`）：只采圆心附近会把
 * 「圆心是草地、半个平台是沙漠」的位置判成合格 —— 那正是 cap 要挡的形态。
 * @param {number} cx @param {number} cz @param {number} seed @param {number} platformRadius
 * @returns {number}
 */
function coreDesertFraction(cx, cz, seed, platformRadius) {
  let total = 0;
  let desert = 0;
  for (let ring = 0; ring <= 6; ring++) {
    const r = platformRadius * ring / 6;
    const count = ring === 0 ? 1 : 24;
    for (let i = 0; i < count; i++) {
      // 每圈错开半格角度，避免所有圈采在同一条射线上（那会把星形分布采样成一条线）
      const ang = i * 2 * Math.PI / count + ring * 0.37;
      const wx = Math.round(cx + r * Math.cos(ang));
      const wz = Math.round(cz + r * Math.sin(ang));
      if (getBiome(wx, wz, seed) === 'DESERT') desert++;
      total++;
    }
  }
  return desert / total;
}

/**
 * 地带圆周（`TARN_ZONE_RADIUS` 处）是否碰到沙漠 —— 即「这块草地挨着沙漠」。
 *
 * 16 方位采样。⚠️ 实测这条判据在 PLAINS region 上通过率 **99.6%**（248 个 PLAINS 里 247 个
 * 邻沙）—— biome 是连续噪声、沙漠成片，草地几乎总在某处贴着沙漠。**所以它几乎不筛**，
 * 真正决定密度的是 `TARN_ZONE_CHANCE` 与 `TARN_DESERT_CAP`。保留它是因为它是用户需求
 * 「挨着沙漠地带」的**语义表达**：将来若 biome 参数变化让草地不再普遍邻沙，判据自动生效。
 * @param {number} cx @param {number} cz @param {number} seed
 * @returns {boolean}
 */
function rimTouchesDesert(cx, cz, seed) {
  // ⚠️ **采样范围在 v1.92 从「圆周 16 方位」放宽到「260 格环形区」**（用户 2026-10-28
  //    第三轮：「每 3 个 region 一座」→ 实测圆周判据×1/5 只能到每 15 座，太稀）。
  //    现在扫的是「地带圆外 40 格到 260 格」这个环形带里的任意一点是不是沙漠。
  //    实测（PLAINS+FOREST+AZALEA）资格命中率 42.7% → 66.0%（×1/5 → 每 7.6 个一座）。
  //    ⚠️ 对**只有 PLAINS** 时这条放宽完全没有效果（33.7% 不变）—— 因为
  //    「沙漠占比 ≤25%」已经排掉了邻近沙漠的 PLAINS，两条判据重叠。
  for (let dx = -TARN_DESERT_NEAR; dx <= TARN_DESERT_NEAR; dx += DESERT_SCAN_STEP) {
    for (let dz = -TARN_DESERT_NEAR; dz <= TARN_DESERT_NEAR; dz += DESERT_SCAN_STEP) {
      const d = Math.hypot(dx, dz);
      // 只看地带圆外缘以外（圆内会被整形覆盖，与「外围有沙漠」无关）
      if (d < TARN_ZONE_RADIUS - 40) continue;
      if (getBiome(cx + dx, cz + dz, seed) === 'DESERT') return true;
    }
  }
  return false;
}

/**
 * 「附近有沙漠」的搜索半径（格）。
 *
 * ⚠️ **实测标定值**：260 格是「资格命中率停止增长」的拐点（±12 = 625 region，6 seed）——
 * 200 格 59.3% / 260 格 65.8% / 320 格 66.0%。取 260 既拿到全部增益，又不白扫。
 *
 * ⚠️ **必须 ≥ `TARN_ZONE_RADIUS + 40`**：小于它时环形带为空 → 判据恒假 → **一座地带都没有**。
 */
const TARN_DESERT_NEAR = 260;

/**
 * 沙漠搜索的采样步长（格）。
 *
 * ⚠️ 取 20 是为控制成本：`(2*260/20)² ≈ 676` 次采样，但**环形带内只有约 480 次**
 * 会真正调 `getBiome`（每 3 步有 1 步被 `d < R-40` 跳过）。
 *
 * ⚠️ **步长是「采样密度」而不是「精度」**：biome 由噪声决定，波长量级上千米，
 * 20 格的步长不会漏掉一整块沙漠（实测步长 8 与 20 的资格命中率分别为 66.0% / 66.0%）。
 */
const DESERT_SCAN_STEP = 20;

/**
 * 该 region 是否**有资格**长一座高台地带（判据 ③④⑤⑥，**不含** 1/5 抽签）。
 *
 * ⚠️ **拆出来只为可测**：单测要能断言「1/5 作用在合格集合上」而不是「作用在全部 region 上」——
 * 若测试自己再写一份资格判据副本，两份漂移后那个断言就失去判别力（红线 1）。
 * `isTarnZone` = `hasTarnEligibility() && 抽签`，两者共用同一份资格实现。
 *
 * ⚠️ **外部消费方一律用 `isTarnZone`，不得直接调本函数** —— 后者不含抽签，拿它当
 * 「是不是地带」会造成「世界上每块合格草地都是地带」。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {boolean}
 */
export function hasTarnEligibility(regionX, regionZ, seed) {
  const { cx, cz } = tarnZoneCenter(regionX, regionZ);
  // ③ 永不与 City 重叠（含过渡带余量）
  if (circleRectGap(cx, cz, TARN_ZONE_RADIUS + TARN_CITY_CLEARANCE, getCityBoundsForSeed(seed)) <= 0) {
    return false;
  }
  // ④ 「草地地形」
  if (!TARN_HOST_BIOMES.includes(getBiome(cx, cz, seed))) return false;
  // ⑤ 「挨着沙漠地带」
  if (!rimTouchesDesert(cx, cz, seed)) return false;
  // ⑥ 别把沙漠整块吃掉（否则高台盖在沙漠上）
  return coreDesertFraction(cx, cz, seed, TARN_PLATFORM_RADIUS) <= TARN_DESERT_CAP;
}

/**
 * 该 region 是否为高台地带。
 *
 * ⚠️ **这是地带的唯一判定入口**（红线 1，spec DR-2）：候选层、`apply.js` 的让路、
 * 雪原让路、`pointContext`、巨树 `allowedAt`、海面遮罩全部调它，不得各写一份
 * 判据副本 —— 两份漂移会让「有的系统当地带、有的不当」，形态是台地上长树、
 * 水池里插空岛这类撕裂。
 *
 * ## 判据链（v1.90 重写：从「纯哈希 1/3」改为「稀有草地替换」）
 *
 * | # | 判据 | 挡掉的量（实测 seed 12345 ±12，625 region） |
 * |---|---|---|
 * | ① | `CITY_REGION` 恒 false | 1 |
 * | ② | `seededRandom(...) < 1/5` | 80% |
 * | ③ | 圆 + 32 格余量不碰城市 bounds | 6 个 seed 里 6 个曾有重叠 |
 * | ④ | 圆心 biome ∈ `TARN_HOST_BIOMES`（只有 PLAINS） | 377 |
 * | ⑤ | 圆周 16 方位碰到沙漠（「挨着沙漠」） | 1~4 |
 * | ⑥ | 核心平台沙漠占比 ≤ `TARN_DESERT_CAP` | 25（在 ②④ 之后） |
 *
 * ⚠️ **② 必须排在最前**：判据 ③④⑤⑥ 要采 ~177 次 `getBiome`（实测 0.35 µs/次），
 * 而 ② 是单次 `seededRandom`。先抽签让 80% 的 region 在 1 次哈希内返回 ——
 * 这是 `snowLandSuppressedByTarn` 每 column 调 49 次也不影响 genP95 的前提
 * （配合那里的几何前置，实测 0.007 ms/column）。
 *
 * ⚠️ **③ 的余量用的是 `CITY_TRANSITION_SIZE`**：城市边缘 32 格是缓坡过渡带，
 * 地带贴着它会把城市的过渡地形削平。
 *
 * ⚠️ **用哈希而不是噪声 + 阈值**（巨树 v1.71 实测沉淀）：`noise()` 把 seed 加进坐标，
 * 相位随 seed 漂移 → 固定阈值跨 seed 不稳；而整数 region 下标的哈希通过率与 seed 无关。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {boolean}
 */
export function isTarnZone(regionX, regionZ, seed) {
  if (regionX === CITY_REGION.X && regionZ === CITY_REGION.Z) return false;
  // ② 廉价门：先挡掉 80%（判据 ③④⑤⑥ 共需 ~177 次 getBiome）
  if (seededRandom(regionX, regionZ, seed + TARN_ZONE_SALT) >= TARN_ZONE_CHANCE) return false;
  return hasTarnEligibility(regionX, regionZ, seed);
}

/**
 * 地带中心 = region 中心（spec DR-3：偏移搜索在多数 seed 下找不到能同时满足「草地 + 邻沙」的位置）。
 *
 * @param {number} regionX @param {number} regionZ
 * @returns {{cx: number, cz: number}}
 */
export function tarnZoneCenter(regionX, regionZ) {
  return {
    cx: regionX * REGION_SIZE + REGION_SIZE / 2,
    cz: regionZ * REGION_SIZE + REGION_SIZE / 2,
  };
}

/**
 * 世界坐标是否落在地带圆**内**（半径 `TARN_ZONE_RADIUS`）。
 *
 * ⚠️ **候选层「圆内才剔除」的唯一实现**（红线 1）：`structure-layout.js` 的杜鹃候选清空
 * 与 `apply.js` 的 `pointContext` 的 `kind:'tarn'` 分支必须同源 —— 两份判据漂移会让
 * 「候选层剔了、apply 层没剔」（树写进台地）或反过来（圆外被误剔 → 大片空地）。
 *
 * ⚠️ **不要只看 `isTarnZone(region) `就清空整个 region 的候选**（v2.3 修掉的缺陷）：
 * 地带圆半径 138 只覆盖 400×400 region 的 **37.4%**，整块清空会把圆外 62.6% 的
 * 合法杜鹃树/巨树一并抹掉 —— 实测 seed 12345 的 `region(2,0)` 28 个候选全在圆外，
 * 留下 **104×91 格** 的连续纯草地（用户 2026-10-28 报告的「大片空地」）。
 *
 * @param {number} wx 世界 x
 * @param {number} wz 世界 z
 * @param {{cx: number, cz: number}} tarn 地带布局（至少含圆心）
 * @returns {boolean}
 */
export function inTarnRadius(wx, wz, tarn) {
  if (!tarn) return false;
  const dx = wx - tarn.cx, dz = wz - tarn.cz;
  return dx * dx + dz * dz < TARN_ZONE_RADIUS * TARN_ZONE_RADIUS;
}

/**
 * 找**离给定世界坐标最近**的高台地带（设置面板「瞬移 → 高台地带」的落点解析）。
 *
 * 从包含 `(wx, wz)` 的 region 开始，按环半径 0,1,2,… 向外扩，第一个命中的环上取曼哈顿
 * 距离最近的 region。`isTarnZone` 是纯函数（实测 0.9µs/次），扫满 `maxRadius` 环
 * （(2R+1)² 个 region）在 R=16 时约 1ms —— 面板点击级别完全可接受。
 *
 * ⚠️ **按 ring 扫而不是逐 region 距离排序**：距离排序要对全部 (2R+1)² 个 region 算距离
 * 再排，而环扫一旦命中即可提前退出 —— 玩家绝大多数时候一个环内就命中（实测 12 seed
 * 的密度是每 ~7.9 个 region 一座）。
 *
 * ⚠️ **返回的是 region 坐标，不是落点**：落点（「边缘处」）由调用方按
 * `platformRadius + step` 落在缓坡上，并用真实方块高度定 y —— 这里不掺渲染/地形细节。
 *
 * @param {number} wx 玩家当前 x（世界坐标）
 * @param {number} wz 玩家当前 z
 * @param {number} seed
 * @param {number} [maxRadius=16] 最多向外扩几个 region 环（16 → 覆盖 6400 格半径）
 * @returns {{regionX: number, regionZ: number, cx: number, cz: number,
 *            dist: number, ring: number} | null} 超出范围返回 null
 */
export function findNearestTarnZone(wx, wz, seed, maxRadius = 16) {
  const baseX = Math.floor(wx / REGION_SIZE);
  const baseZ = Math.floor(wz / REGION_SIZE);
  for (let ring = 0; ring <= maxRadius; ring++) {
    let best = null;
    // 沿环遍历：只走外圈（ring=0 时退化为单个 region）
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        // 只要环边框，不要内部（内部已在更小的 ring 里查过）
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
        const rx = baseX + dx, rz = baseZ + dz;
        if (!isTarnZone(rx, rz, seed)) continue;
        const { cx, cz } = tarnZoneCenter(rx, rz);
        const dist = Math.hypot(cx - wx, cz - wz);
        // 同环内可能有多座 —— 取离玩家最近的
        if (best === null || dist < best.dist) best = { regionX: rx, regionZ: rz, cx, cz, dist, ring };
      }
    }
    if (best) return best;
  }
  return null;
}

// ==================== 雪原让路（spec DR-6） ====================

/**
 * 雪原占地的半宽（切比雪夫方形）= 核心半宽 + 过渡带。
 *
 * ⚠️ 必须从 `SNOW_LAND_SIZE` / `TRANSITION_SIZE` 派生，不得写字面量 28 —— 与
 * `landmarks.js` 的 `getSnowLandInfo` 同一口径（那里也是 `floor(SIZE/2) + TRANSITION`）。
 * 两处各写一份字面量，改雪原尺寸时会漂移出「让路按旧方形算、渲染按新方形」的撕裂。
 */
const SNOW_HALF_EXTENT = Math.floor(SNOW_LAND_SIZE / 2) + TRANSITION_SIZE.SNOW_LAND;

/**
 * 雪原让路的邻域半径（region）。
 *
 * 地带半径 138、region 边长 400 ⇒ 只有紧邻 region 的地带圆才可能伸进本 region 的雪原，
 * ±3 是安全上界（实测 ±1/±2/±3 命中数完全相同）。取 3 而非 1 是为将来改半径
 * 或改 region 尺寸留余量 —— 那时不必回头改这个循环。
 */
const SNOW_SUPPRESS_NEIGHBORHOOD = 3;

/**
 * 本 region 的雪原是否被「高台地带」让路波及（spec DR-6）。
 *
 * 判据原文：「该 region 的雪原圆若与**任一**邻域地带的圆相交 → 跳过 `generateSnowLand`」。
 *
 * ## 几何是「方形到圆」而不是「圆心距」
 * 雪原在 `landmarks.js` 的 `getSnowLandInfo` 里是**切比雪夫方形**（±28），不是圆。
 * 所以要算方形到圆的**真实最短距离**：
 *
 * ```
 * dx = max(0, |snowCx − tarnCx| − half)
 * dz = max(0, |snowCz − tarnCz| − half)
 * 相交 ⟺ hypot(dx, dz) < TARN_ZONE_RADIUS
 * ```
 *
 * ❌ **不要写成 `hypot(中心距) < half + TARN_ZONE_RADIUS`** —— 那是把方形当圆，
 * 会用内切圆半径 28 代替真实的对角伸展 28√2 ≈ 39.6，漏掉**角部擦入**。
 * 实测（seed 12345、±6 的 169 个 region）：近似口径 25 命中 / 精确口径 28 命中，
 * 漏掉的 3 个中心距都已是 188~194（> 188 阈值），而它们的角部只隔地带圆 150~156 格。
 *
 * ## 没有「本地是地带 region 就无条件让路」这一条
 * 雪原中心 = `seededCenter + 偏移(160, 0)`，而地带中心 = region 中心 ⇒ X 分量恒差
 * `offsetX − 40`（`offsetX` ∈ [100, 400) ⇒ ≥ 60）。所以多数地带 region 的自己的雪原
 * 离自己的地带圆 168~337 格、根本没压进水池 —— 加特判会白删它们，且与 DR-6 的
 * 「相交」判据不符。实测 37 个地带 region 里只有 **5** 个的雪原真的压进自己的圆。
 *
 * ## 实测覆盖率（v1.90 后的新口径，1/5 × PLAINS × 邻沙 × cap25%）
 * 3 个 seed × 169 region 实测命中 **11** 个（旧口径是 28 个）；
 * 几何剪枝后 `isTarnZone` 只被调 **0.40%~1.36%** 的候选。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {boolean}
 */
export function snowLandSuppressedByTarn(regionX, regionZ, seed) {
  // 与 `structure-layout.js` 同一推导：未 clamp 的原始中心 + 偏移（雪原可跳 region）
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const snowCx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
  const snowCz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;

  // ⚠️ **几何判定必须先于 `isTarnZone`**（v1.90）：旧实现先判「是不是地带」再算距离，
  // 而 v1.90 的 `isTarnZone` 从 0.018 µs 涨到 0.35 µs（要采 ~177 次 getBiome）。
  // 未剪枝时本函数每 column 会调它 49 次（实测 0.134 ms/column，进 GEN 计时路径）。
  // 反过来先算纯几何（零 biome 采样）后，实测只调 0.4%~1.4% 的候选 ⇒ **0.007 ms/column**（快 19 倍）。
  // 两步合起来恰好等价于「圆与方形相交」，所以重排不改变任何结果（只是少算 98.6% 的无用哈希）。
  const n = SNOW_SUPPRESS_NEIGHBORHOOD;
  for (let dx = -n; dx <= n; dx++) {
    for (let dz = -n; dz <= n; dz++) {
      const { cx, cz } = tarnZoneCenter(regionX + dx, regionZ + dz);
      const gapX = Math.max(0, Math.abs(snowCx - cx) - SNOW_HALF_EXTENT);
      const gapZ = Math.max(0, Math.abs(snowCz - cz) - SNOW_HALF_EXTENT);
      if (Math.hypot(gapX, gapZ) >= TARN_ZONE_RADIUS) continue;   // 几何上不可能相交
      if (isTarnZone(regionX + dx, regionZ + dz, seed)) return true;
    }
  }
  return false;
}

// ==================== 轴对齐几何工具 ====================

/**
 * 高台的**轴对齐世界半宽**（spec DR-7）：`halfX = width/2`、`halfZ = depth/2`。
 *
 * ⚠️ **与环上角度无关** —— 高台是轴对齐摆放，不旋转（spec DR-7 致命 1′）。
 * 不要返回 `{radial, tangential}`：那是「长边切向朝心」旋转假设下的概念，
 * 而 `rasterizeStructure` 是轴对齐写入（`b.direction` 只是逐格方块朝向元数据，
 * 旋转不了整个结构），轴对齐下这两个值无意义。
 *
 * @param {{width: number, height: number, depth: number}} variant
 * @returns {{halfX: number, halfZ: number}}
 */
export function tarnHalfWidth(variant) {
  return { halfX: variant.width / 2, halfZ: variant.depth / 2 };
}

/**
 * 两个**轴对齐**矩形的真实最短距离（格）。
 *
 * 判据（spec DR-7 / DR-8 唯一口径）：两轴分离量都 > 0 时取 `hypot(dx, dz)`，
 * 否则取正的那个；**两者都 < 0 即重叠**（返回负值）。
 *
 * ⚠️ 不要用「弦长 − 半宽」或外接圆近似：前者是旋转假设下的旧口径（会高估间距），
 * 后者会把「实际不重叠」判成重叠（假失败）。
 * ⚠️ 这是间距判据的**唯一实现**（红线 1）：布局自检与单测共用同一份。
 *
 * @param {{cx: number, cz: number, halfX: number, halfZ: number}} a
 * @param {{cx: number, cz: number, halfX: number, halfZ: number}} b
 * @returns {number} 真实最短距离（重叠时为负）
 */
export function aabbGap(a, b) {
  const dx = Math.abs(a.cx - b.cx) - (a.halfX + b.halfX);
  const dz = Math.abs(a.cz - b.cz) - (a.halfZ + b.halfZ);
  if (dx > 0 && dz > 0) return Math.hypot(dx, dz);
  return Math.max(dx, dz);
}

// ==================== 角度抖动 ====================

/**
 * 高台角向抖动上限 = `jitterMax`（弧度）。**逐 seed 二分求出后缓存**，不得写死。
 *
 * ## 为什么必须二分而不是写 `缝角/2`
 * `缝角/2`（实测 7.62°）会让相邻高台**直接重叠**（AABB 距离实测 **−4.17**）。
 * 抖动预算的真实上界由「AABB 真实间距仍 ≥ `TARN_GAP`」决定，与环半径 / 保留组合全都耦合
 * ⇒ 只能二分，写死任何一个数都会在改池半径或改保留组合时**静默失效**。
 *
 * ## 采样约定是载荷性的（勿改）
 * 抽样序列 = `seededRandom(i, sampleIndex, seed + TARN_ANGLE_SALT)`，`i` 是环上序号、
 * `sampleIndex` 是抽样下标。实测（seed 12345、300 抽样、二分 30 次）：
 * `jmMax = 0.8557°` → `jitterMax = jmMax × 0.8 = 0.6846°` → 300 抽样最坏间距 **4.209 ≥ 4**。
 * ⚠️ 换一套采样约定会得到 0.81~0.95° 的区间 —— 数字对不上不是实现错，是约定变了。
 *
 * ## 抖动为什么是零和的
 * 每缝偏移取 `(rand − 0.5)·2·jitterMax` 后**减去均值**，保证 Σ缝角守恒
 * （否则 8 个缝整体偏一点，最后一座会绕回第一座撞上）。
 *
 * ## 安全性的论证边界（**§实际可达域只有 3.841 < 4，以实测为准**）
 *
 * ❌ **曾经写过的过强结论（已作废，勿恢复）**：「最坏情况 = 单个 `jit_i = −jitterMax`
 * 且其余 `+jitterMax/7` ⇒ 任何零和向量都安全（4.357 ≥ 4）」。
 * 错在：`−1×jm + 7×(jm/7)` 这只是 **±jitterMax 盒 ∩ 零和** 的极值，而
 * `zeroSum()` 输出的是 `raw − mean`，`raw ∈ [−jm, +jm]` ⇒ 单值可达 **±1.75×jm**
 * （7×`+jm` + 1×`−jm` ⇒ mean = 0.75jm ⇒ 该值 = −1.75jm），**不受盒约束**。
 *
 * ✅ **实测可达域（实施期实测，seed 12345、jitterMax = 0.6846°）**：
 * | 向量族 | 最坏相邻间距 |
 * |---|---|
 * | `1×(+jm)` + `7×(−jm)` → 归一化后单值 −1.198° | **3.841** ❌ < 4 |
 * | `2×(+jm)` + `6×(−jm)` | 4.013 ✅ |
 * | `3×(+jm)` + `5×(−jm)` | 4.185 ✅ |
 * | `4×(+jm)` + `4×(−jm)`（= 盒内极值 4.357 的反向等价形）| 4.357 ✅ |
 * | **真实逐 region 采样器 30 万 region** | **min 4.031**，<4 比率 **0.0000%** |
 * | 均匀随机可达向量 30 万 | min 3.886，<4 比率 0.0013% |
 *
 * ⇒ **真正成立的说法**：`TARN_GAP = 4` 对当前这个采样器是**实测成立**的（30 万 region 零违反，
 * 最坏 4.031 距阀值 0.031），但在**可达域的数学极端上并不成立**（最坏 3.841）。
 * 「任何零和向量都安全」是错的；正确的是「本采样器实测安全」。
 *
 * ⚠️ **所以改采样器时必须重跑这组实测**（单测对应「跨 region / 跨 seed 都满足间距」
 * 与「任意两座高台都不重叠」两条用例，各扫 5 seed × 81 region），**不能拿任何解析上界作担保**。若将来要那类硬保证，得把 `JITTER_SAFETY_RATIO` 降到
 * ~0.45 使可达极端也 ≥ 4，或改 `zeroSum` 为盒内投影（`raw − clamp(mean)`，
 * 以轻微不守恒换盒约束）—— 两条都未做，属刻意选择。
 */
const jitterMaxCache = new Map();
const JITTER_SAMPLE_COUNT = 300;
const JITTER_BISECT_STEPS = 30;
/** 抖动取二分上界的 0.8 倍（留 20% 余量，spec DR-7）。 */
const JITTER_SAFETY_RATIO = 0.8;

/** @param {number} seed @returns {number} jitterMax（弧度） */
function tarnJitterMax(seed) {
  const cached = jitterMaxCache.get(seed);
  if (cached !== undefined) return cached;

  const { gapAngle } = tarnRingMetrics();
  let lo = 0;
  let hi = gapAngle / 2;
  for (let step = 0; step < JITTER_BISECT_STEPS; step++) {
    const mid = (lo + hi) / 2;
    if (tarnWorstGapOverSamples(seed, mid) >= TARN_GAP) lo = mid;
    else hi = mid;
  }
  const jitterMax = lo * JITTER_SAFETY_RATIO;
  jitterMaxCache.set(seed, jitterMax);
  return jitterMax;
}

/**
 * 环上 8 座的占角与缝角（与 seed 无关，纯几何）。
 *
 * 占角 = `2·asin(max(halfX, halfZ) / ringR)`（spec DR-7 算法第 2 步）。
 * ⚠️ 这只是**排序用的保守角向度量**，不是真实 AABB 占地 —— 真实间距由 `aabbGap` 单独算。
 * 少了它，大小悬殊的 8 座会被均分到等角位上，大座互相插进去。
 *
 * 定稿实测：总占角 **238.02°**、缝隙角 **15.247°**、无抖动最坏 AABB 间距 **5.046**
 * （cloudland_tarn_03 ↔ cloudland_tarn_04）。
 */
function tarnRingMetrics() {
  const tarns = TARN_KEPT_TARN_IDS.map((id) => {
    const metric = KIT_METRICS[id];
    return { variant: id, ...tarnHalfWidth(metric) };
  });
  // 按保守角向半径降序：大座先入环，占角才与真实占地同序
  tarns.sort((a, b) => Math.max(b.halfX, b.halfZ) - Math.max(a.halfX, a.halfZ));
  const occ = tarns.map((t) => 2 * Math.asin(Math.max(t.halfX, t.halfZ) / TARN_RING_RADIUS));
  const gapAngle = (2 * Math.PI - occ.reduce((sum, v) => sum + v, 0)) / tarns.length;
  return { tarns, occ, gapAngle };
}

/**
 * 把一段「原始抖动」去均值（零和）。
 * @param {number[]} raw @returns {number[]}
 */
function zeroSum(raw) {
  const mean = raw.reduce((sum, v) => sum + v, 0) / raw.length;
  return raw.map((v) => v - mean);
}

/** 一组抖动下相邻高台的最坏 AABB 间距 */
function tarnWorstAdjacentGap(tarns, jitter, occ, gapAngle) {
  const n = tarns.length;
  const placed = tarnPlaceOnRing(tarns, occ, gapAngle, jitter);
  let worst = Infinity;
  for (let i = 0; i < n; i++) {
    const gap = aabbGap(placed[i], placed[(i + 1) % n]);
    if (gap < worst) worst = gap;
  }
  return worst;
}

/** 按占角 + 缝角 + 零和抖动把高台摆上环（返回带 cx/cz 的矩形） */
function tarnPlaceOnRing(tarns, occ, gapAngle, jitter) {
  const placed = [];
  let cursor = 0;
  for (let i = 0; i < tarns.length; i++) {
    cursor += occ[i];
    const ang = cursor - occ[i] / 2;
    cursor += gapAngle + jitter[i];
    placed.push({
      variant: tarns[i].variant,
      ang,
      ring: TARN_RING_RADIUS,
      halfX: tarns[i].halfX,
      halfZ: tarns[i].halfZ,
      cx: TARN_RING_RADIUS * Math.cos(ang),
      cz: TARN_RING_RADIUS * Math.sin(ang),
    });
  }
  return placed;
}

/** 二分用：在 `JITTER_SAMPLE_COUNT` 组抽样上取最坏相邻间距 */
function tarnWorstGapOverSamples(seed, jitterAmplitude) {
  const { tarns, occ, gapAngle } = tarnRingMetrics();
  const n = tarns.length;
  let worst = Infinity;
  for (let sample = 0; sample < JITTER_SAMPLE_COUNT; sample++) {
    const raw = [];
    for (let i = 0; i < n; i++) {
      raw.push((seededRandom(i, sample, seed + TARN_ANGLE_SALT) - 0.5) * 2 * jitterAmplitude);
    }
    const gap = tarnWorstAdjacentGap(tarns, zeroSum(raw), occ, gapAngle);
    if (gap < worst) worst = gap;
  }
  return worst;
}

/**
 * 某个 region 的高台角向抖动（零和，逐 region 抽签）。
 *
 * ⚠️ 抖动**必须逐 region 变化**：全局固定会退化成机械等距（观感是「用尺子摆的」）。
 * 安全性不依赖这个采样器选得巧 —— `tarnJitterMax` 的对抗上界保证任何零和向量都安全
 * （见该常量的注释）。
 */
function tarnRegionJitter(regionX, regionZ, seed, count) {
  const jitterMax = tarnJitterMax(seed);
  // regionKey 把 (regionX, regionZ) 折成一维，喂给 seededRandom 的 x 槽。
  // ⚠️ 这会碰撞：`(rx, rz)` 与 `(rx + 17, rz − 31)` 得到同一个 key。
  // **碰撞无害**：碰撞只意味着两个 region 共享同一组抖动。安全性的依据是
  // 「本采样器实测 30 万 region 最小间距 4.031 ≥ TARN_GAP」（见 `tarnJitterMax` 注释），
  // 与 region 是否互不相同无关。
  // ❌ 勿写成「碰撞无害是因为任何零和向量都安全」—— 那个结论已被实测推翻。
  const regionKey = regionX * 31 + regionZ * 17;
  const raw = [];
  for (let i = 0; i < count; i++) {
    raw.push((seededRandom(i, regionKey, seed + TARN_ANGLE_SALT) - 0.5) * 2 * jitterMax);
  }
  return zeroSum(raw);
}

// ==================== 装饰件落位（spec DR-8） ====================

/**
 * 拱洞所在的**平台边缘环**半径（spec DR-8）。
 *
 * ⚠️ **v1.90 从 125 改到 96**：125 + 拱洞最大半对角（19×36 → 13.8）= 外延 **138.7**，
 * 已超出平台半径（旧 120，现 114）→ 拱洞落在**缓坡上**，缓坡地形会被拱洞的底坐穿。
 * 96 时实测最坏外延 **110.0** < 平台 114（留 4 格余量），且与高台环（R=58）的
 * AABB 最小间距 **5.59** ≥ `TARN_GAP`（4）。
 *
 * ⚠️ 实测边界（改前必重跑 `test-tarn-zone.js` 的装饰件用例）：
 * | 拱洞环 | 四角最远 | vs 高台 |
 * |---|---|---|
 * | 92 | 106.0 ✅ | **1.78 ❌** |
 * | 94 | 108.0 ✅ | **3.69 ❌** |
 * | **96** | **110.0 ✅** | **5.59 ✅** |
 * | 98 | 112.0 ✅ | 7.49 ✅ |
 * ⇒ 96 是「全在平台内」与「vs 高台 ≥ 4」同时成立的**最小**环半径。
 */
export const TARN_ARCH_RING_RADIUS = 96;

/**
 * 紫晶柱所在的**池内**内环半径（spec DR-8）。
 *
 * ⚠️ **不要用原公式 `max(12, ringR − max(half) − 30)`** —— 它在 ringR=58 下算出 12，
 * 而实测内环 12 时 7 个紫晶柱**互相重叠 3 对**（最小距 **−1.86**）。
 * 20 是穷举实测的安全值（互距 3.57、vs 高台 +4.8）。
 * ⚠️ **上界是 24**（26 起 vs 高台 −1.20 撞上），调大前必须重跑 spec DR-8 那张表。
 * ⚠️ **本任务内无外部消费方**（同 `TARN_ARCH_RING_RADIUS`）：导出是为 Task 5/Task 8 预留。
 */
export const TARN_SPIRE_RING_RADIUS = 20;

/** 装饰件角向抖动的幅度上限（弧度 ≈ 3°）：比高台松得多 —— 它们体积小、彼此间距充裕。 */
const DECO_JITTER_RAD = 3 * Math.PI / 180;

/** 巨型云的环半径 = 地带半径 × 0.6（spec DR-10） */
const CLOUD_RING_RATIO = 0.6;
/** 云环与高台环的角度错开量（spec DR-10） */
const CLOUD_ANGLE_OFFSET = Math.PI / 11;
/** 巨型云只从「格数最大的前 6 个」里抽（spec DR-10：60/121/436 格云无视觉意义） */
const CLOUD_POOL_SIZE = 6;
/** 地带里的云数 */
const CLOUD_COUNT = 4;

/**
 * 装饰件落位：`count` 个变体按等角位摆上环，带零和抖动。
 *
 * @param {string[]} variantIds 变体基名（顺序 = 环上顺序）
 * @param {number} ring 环半径
 * @param {'arch'|'spire'} kind 装饰件类型
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {Array<{variant: string, kind: string, ang: number, ring: number, halfX: number, halfZ: number}>}
 */
function tarnPlaceDecos(variantIds, ring, kind, regionX, regionZ, seed) {
  const count = variantIds.length;
  const regionKey = regionX * 31 + regionZ * 17;
  const raw = [];
  for (let i = 0; i < count; i++) {
    raw.push((seededRandom(regionKey + i * 7, i, seed + TARN_DECO_SALT) - 0.5) * 2 * DECO_JITTER_RAD);
  }
  const jitter = zeroSum(raw);
  return variantIds.map((variant, i) => {
    const ang = i * 2 * Math.PI / count + jitter[i];
    const { halfX, halfZ } = tarnHalfWidth(KIT_METRICS[variant]);
    return { variant, kind, ang, ring, halfX, halfZ };
  });
}

/**
 * 巨型云落位：从格数最大的前 6 个里，按 seed 定起点顺序取 4 个，摆在地带圆内的错开角度上。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {Array<{variant: string, ang: number, ring: number}>}
 */
function tarnPlaceClouds(regionX, regionZ, seed) {
  const pool = KIT_VARIANTS.giantCloud
    .map((id) => ({ id, blocks: KIT_METRICS[id].blocks }))
    .sort((a, b) => b.blocks - a.blocks)
    .slice(0, CLOUD_POOL_SIZE)
    .map((v) => v.id);

  // 起点由 seed/region 决定：不同 seed 看到不同的云组合
  const start = Math.floor(
    seededRandom(regionX, regionZ, seed + TARN_CLOUD_SALT) * pool.length,
  );
  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const variant = pool[(start + i) % pool.length];
    const ang = CLOUD_ANGLE_OFFSET + i * 2 * Math.PI / CLOUD_COUNT;
    clouds.push({ variant, ang, ring: TARN_ZONE_RADIUS * CLOUD_RING_RATIO });
  }
  return clouds;
}

// ==================== 地带布局 ====================

/**
 * @typedef {{
 *   cx: number, cz: number,
 *   plateauRadius: number, platformRadius: number, slopeWidth: number, plateauY: number,
 *   tarns: Array<{variant: string, ang: number, ring: number, halfX: number, halfZ: number}>,
 *   decos: Array<{variant: string, kind: 'arch'|'spire', ang: number, ring: number,
 *                 halfX: number, halfZ: number}>,
 *   clouds: Array<{variant: string, ang: number, ring: number}>
 * }} TarnLayout
 *
 * ⚠️ **`poolRadius` 已在 v1.90 删除**（v1.89 去掉中央水池后它已经没有语义，是死字段）。
 * 现在三个半径的分工：`plateauRadius` = 地带圆外缘（地形整形的扫掠上界）／
 * `platformRadius` = 恒平的内圈／`slopeWidth` = 两者间那条缓坡的宽度。
 * 三者始终保持 `plateauRadius === platformRadius + slopeWidth`。
 */

/**
 * 高台地带的完整布局。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {TarnLayout | null} 非地带 region 返回 null
 */
export function computeTarnZone(regionX, regionZ, seed) {
  if (!isTarnZone(regionX, regionZ, seed)) return null;

  const { tarns, occ, gapAngle } = tarnRingMetrics();
  const jitter = tarnRegionJitter(regionX, regionZ, seed, tarns.length);
  const placed = tarnPlaceOnRing(tarns, occ, gapAngle, jitter);

  const decos = [
    ...tarnPlaceDecos(KIT_VARIANTS.arch, TARN_ARCH_RING_RADIUS, 'arch', regionX, regionZ, seed),
    ...tarnPlaceDecos(KIT_VARIANTS.spire, TARN_SPIRE_RING_RADIUS, 'spire', regionX, regionZ, seed),
  ];

  const { cx, cz } = tarnZoneCenter(regionX, regionZ);
  return {
    cx,
    cz,
    // plateauRadius = 地带圆半径（整片地带的**最外缘**，含缓坡）
    plateauRadius: TARN_ZONE_RADIUS,
    // platformRadius = 地形恒为 plateauY 的内圈（缓坡从这里开始）
    platformRadius: TARN_PLATFORM_RADIUS,
    // slopeWidth = 缓坡宽度（= plateauRadius − platformRadius）
    slopeWidth: TARN_SLOPE_WIDTH,
    plateauY: TARN_PLATEAU_Y,
    tarns: placed,
    decos,
    clouds: tarnPlaceClouds(regionX, regionZ, seed),
  };
}
