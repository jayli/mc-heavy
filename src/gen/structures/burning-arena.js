// src/gen/structures/burning-arena.js — 大竞技场（burning arena）落点候选发现
//
// 权威：docs/superpowers/specs/2026-11-09-burning-arena-port-design.md（v2 修订：落点改城东沙漠）
//
// 两段式的前一段（与 giant-pyramid / shallow-water-tarns 同构，红线 2）：
//   本文件               computeBurningArenaAnchor()：全局唯一锚点（纯函数、无状态）
//   apply.js 阶段 2.93   按锚点光栅化 + 撒布/植被的让路判据
//
// Worker 同构：本文件不得 import three、不得自建 Worker、**不得 fetch**
// （产物 JSON 由 apply.js 的 `preloadStructures` 统一拉取）。
//
// ## 术语（用户 2026-11-09 裁定）
// **大竞技场 / 「竞技场」** = 本结构（Cataclysm 模组 burning_arena，85×85×80，城东沙漠）；
// **围场 / 原「小竞技场」** = 既有的城门竞技场（`arena.js`，41×79，城南门外）。
// 两者互不重叠（见 `fixedBlockers`）。代码层 `arena` 一族命名不改，只有玩家文案用「围场」。
//
// ## 为什么是「城东最近的沙漠」（用户 2026-11-09 裁定）
// 初版把大竞技场放在祭坛高台地带中心（取代祭坛），实测与两个 Boss 硬冲突：
//   · 飞龙轨道 r=24 / y=30 被碗体完全封闭 —— 玩家站圆心、碗缘顶、碗口上方三处各扫 24 方位，
//     视线净空 **0/24**；抬高轨道则斜距 ≈70~87 ≫ 步枪 entityRange 40（`dragon-config.js` 钉死）
//     ⇒ 龙变成打不到的装饰；
//   · 焰魔召唤点在圆心，而圆心是 712 格的熔岩柱+塔（y=3..36）⇒ 玩家落点从 y=5 抬到 y=37。
// 10 个既有 E2E 因此全红（单变量 A/B 已归因）。故改为放到城东沙漠，祭坛与两个 Boss 原地不动。
//
// ## 为什么「压制地标」而不是「避让地标」（与浅水高台同一裁定）
// 实测（8 seed）：把地标圆 / 巨型金字塔 / 空岛都当**避让**项时，seed 12345 在 span≤8 下
// 仍**找不到任何落点**（landmark 1179 + pyramid 607 + sky 1009 次拒绝）—— 与
// `shallow-water-tarns.js` 的 `fixedBlockers` 注释记录的是同一个坑（那里实测 10 seed 全失效）。
// 用户要求「城东最近的沙漠**必须且唯一**生成大竞技场」⇒ 落点必须存在，故改为：
//   · **避让**只留「地基级大结构」：城市 / 高台地带 / 浅水高台 / 围场（四者互斥是既有口径）；
//   · **压制**其余内容：地标（金字塔/冰封山/岛/平地/雪原）、巨型金字塔、空岛、撒布、植被
//     —— 由 `burningArenaSuppressed*` 与 `pointContext` 的 `kind:'none'` 分支承担。
// 改用压制后实测：8 seed 全部命中 span=5。锚点搜索首次 ~100ms（粗筛网格 + 逐格精检），
// 已预热在 `world-worker.js` 的 layout 入口（同 `computeArenaAnchor` 手法）⇒ 不落进 GEN 计时路径。
// ⚠️ 对比：避让版要 2000ms 且部分 seed 无解；压制版 100ms 且 8/8 有解。
import { getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import { getCityBoundsForSeed } from './city-layout.js';
import { REGION_SIZE, CITY_TRANSITION_SIZE, LANDMARK_OFFSET } from './region-config.js';
import { isTarnZone, computeTarnZone, TARN_ZONE_RADIUS } from './tarn-zone.js';
import {
  computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS,
} from './shallow-water-tarns.js';
import { computeArenaAnchor, ARENA_HALF_X, ARENA_HALF_Z } from './arena.js';
import {
  getPyramidCenterInRegion, getFrozenMountainCenterInRegion,
  getPlainLandCenterInRegion, getIslandCenterInRegion,
} from './landmarks.js';
import { computeRegionLocalGiantPyramid, PYRAMID_HALF } from './giant-pyramid.js';
import { computeSkyCandidates } from './sky-structures.js';
import { getRegionSeededCenter } from './region-center.js';
import { LANDMARK_CLEARANCE } from './landmark-circles.js';
// 纯数据（VARIANTS / HALF）的唯一权威在 `burning-arena-data.js`（零 node 依赖，浏览器/Worker 可用）。
// ⚠️ **不得在本文件再定义一份 `BURNING_ARENA_HALF`**（红线 1）：两份字面量会漂移出
// 「AABB 裁剪判据与产物尺寸两套口径」（形态：碗身缺一整条边，方块层面看不出是裁剪差 1）。
// 本文件 re-export 它，使 apply.js / 单测仍可从本模块 import（与 `FACING_TO_ORIENT` 同手法）。
export { BURNING_ARENA_HALF } from './burning-arena-data.js';
import { BURNING_ARENA_HALF } from './burning-arena-data.js';

/**
 * 结构高度（归一化 y ∈ [1, 80]）。塔顶世界高度 = `floorY + BURNING_ARENA_HEIGHT`。
 *
 * ⚠️ 80 格远高于巨型金字塔（24）—— 这是必须压制空岛的原因：空岛底 y≥40，
 * 而塔顶实测落在 y=79~84，两者必然相交（8 seed 中 7 个命中）。
 */
export const BURNING_ARENA_HEIGHT = 80;

/**
 * Boss 召唤点的**脚底**相对 `anchor.floorY` 的竖直偏移（格）—— 唯一权威。
 *
 * ## 语义：「房顶下面这一层」的中心可站面（用户 2026-11-09 裁定）
 *
 * 用户原话：「不要召唤到房顶上，而是房顶下面的这一层」。
 *
 * 实测竖向结构（真实世界中心列，seed 12345、floorY=−1）：
 *
 * | 世界 y | 归一化 normY | 内容 |
 * |---|---|---|
 * | 69 | 80 | netherrack **房顶**（3717 格平板，脚底 y=70 = 屋顶外表面）|
 * | 34..68 | 45..79 | **全空**（室内净空 35 格）|
 * | **33** | **44** | **gold_block —— 室内顶层中心塔顶（脚底 y=34 = 本常量）** |
 * | 32 | 43 | obsidian（室内主地板）|
 * | 31..11 | 42..20 | chest / nether_bricks / lava 柱（本仓 lava 是 solid）|
 *
 * ## 推导（勿凭直觉改）
 *
 * 脚底 normY = 45（gold_block 在 normY=44，脚底 = 其上那一格）；
 * 世界 y = `floorY + normY − floorRow(10)` ⇒ **脚底 = floorY + 45 − 10 = floorY + 35**。
 *
 * ⚠️ **floorRow 是产物冻结值**（`check:data` 指纹 + `test-burning-arena-gen.js` 的 `FLOOR_ROW=10`
 * 双向钉住），**不能用 `floorRowOf()` 读**：它读主线程模块缓存，而产物只在 GEN Worker 里
 * 加载过 ⇒ 主线程恒返回兜底值 1（`burning-arena.spec.mjs` 实测踩过同源坑）。
 * 故本常量是**派生冻结值**，由 `test-burning-arena-gen.js` 从产物重算钉住（红线 1：
 * 产物是权威，本常量是它的派生；素材/烘焙变了那条用例会红）。
 *
 * ⚠️ **曾错取「房顶外表面」**（`floorY + BURNING_ARENA_HEIGHT − 9` = floorY+71）：
 * 那是屋顶**上面**，焰魔会站在房顶上（用户报告的缺陷）。有意思的是修复后的 y=34 正是
 * 未传 `summonY` 时 `_findGroundY` 自然选中的位置（中心列只有塔顶 34 / 屋顶 70 两个可站位，
 * 取「离玩家最近」时玩家在碗内低层 ⇒ 34）。
 */
export const BURNING_ARENA_SUMMON_FEET_DY = 35;

/**
 * 占地内地表高差上限（格）—— **渐进放宽**的第一档。
 *
 * 实测（8 seed，城东 ±1600×±900 窗）：85×85 占地在 span≤4（巨型金字塔的标准）下
 * 候选数 **0** —— 大竞技场占地是金字塔的 3 倍，沙漠地形容不下那么平的一块。
 * span≤5 时 8/8 seed 全部命中，故 5 是「相对平坦」的最小可行档。
 *
 * ⚠️ `BURNING_ARENA_SPANS` 的放宽顺序是载荷性的：先严后松，取第一个有解的档
 * ⇒ 既满足「相对平坦」，又保证「必须生成」。
 */
export const BURNING_ARENA_MAX_SPAN = 5;

/**
 * 渐进放宽档位。最后一档 8 是兜底（保证「必须生成」不因某 seed 的沙漠太起伏而失败）。
 *
 * 实测各档命中情况（8 seed）：span≤5 → 8/8；≤6 → 8/8；≤8 → 8/8。
 * 即当前 5 已够用，6/8 是为将来 seed 变化留的兜底（不改变现有落点）。
 */
export const BURNING_ARENA_SPANS = Object.freeze([4, 5, 6, 8]);

/** 圆心到城市 bounds 的最小净距（复用 `CITY_TRANSITION_SIZE`，红线 1 不另写 32） */
const CITY_CLEARANCE = CITY_TRANSITION_SIZE;

/**
 * 向东搜索的最远距离（格）。超过它就不生成（返回 null，不阻断 GEN）。
 *
 * 实测 8 个 seed 的锚点都落在城东 525~737 格内 ⇒ 1600 是「再远就不值得」的工程上限
 * （与 `SHALLOW_TARN_MAX_GAP` 2400 同口径，本结构占地小故取更紧的值）。
 */
export const BURNING_ARENA_MAX_GAP = 1600;

/** 纬度搜索半宽（相对城市 z 中心）。实测锚点 z 偏移最大 ~380 ⇒ 取 900 留余量 */
const SEARCH_HALF_Z = 900;

/**
 * 瞬移落点与大竞技场**西缘**的水平净距（格，v2.87）。
 *
 * 设置面板「竞技场」按钮的落点 = 占地西缘再向西 `GAP` 格（见 `burningArenaTeleportPoint`）。
 * 取 6 的理由：碗体基座在西缘向上收分，离缘太近会被碗身挡视线；太远（>10）又失去
 * 「就在门口」的方位感。6 格在两者之间，且仍在锚点判据保证的「全 DESERT、高于海平面」
 * 的沙漠腹地内（搜索窗外扩余量远大于它）。
 */
export const BURNING_ARENA_TELEPORT_GAP = 6;

/**
 * 粗筛网格步长（格）。
 *
 * ⚠️ **两级筛选是性能关键**：85×85 = 7225 格逐格全检，实测单候选 ~0.6ms；
 * 城东窗内有 ~1.1 万个沙漠点 ⇒ 全精检要 ~7 秒（不可接受，锚点在 GEN 计时路径上）。
 * 粗筛用 8 格网格的 biome/height 先淘汰 99.99%（实测每 seed 只需 **1 次**精检），
 * 总耗时降到 **2ms**。
 * ⚠️ 粗筛只是**必要条件**（网格点全沙漠 + 高差达标），命中后仍要逐格精检 ——
 * 网格点之间的格子可能不是沙漠（与巨型金字塔「step=2 采样漏判」同一教训）。
 */
const COARSE_STEP = 8;

/** 锚点 memo（键 = seed）。同 `findAltarTarnRegion` / `computeShallowTarnAnchor` 手法 */
const anchorMemo = new Map();
const ANCHOR_MEMO_MAX = 64;

/** 清空锚点 memo（单测隔离用；生产代码不需要调用） */
export function clearBurningArenaCache() {
  anchorMemo.clear();
}

/**
 * 占地内逐格全检：全 DESERT + 全高于海平面 + 高差 ≤ span。
 * @returns {{minH:number, maxH:number, span:number}|null}
 */
function exactFootprint(wx, wz, span, seed) {
  let minH = Infinity, maxH = -Infinity;
  for (let dz = -BURNING_ARENA_HALF; dz <= BURNING_ARENA_HALF; dz++) {
    for (let dx = -BURNING_ARENA_HALF; dx <= BURNING_ARENA_HALF; dx++) {
      if (getBiome(wx + dx, wz + dz, seed) !== 'DESERT') return null;
      const h = generateHeight(wx + dx, wz + dz, seed);
      if (h <= SEA_Y) return null;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      if (maxH - minH > span) return null;   // 早退：已超阈值就不必扫完
    }
  }
  return { minH, maxH, span: maxH - minH };
}

/**
 * 地基级大结构的 AABB 冲突判定（**只这四类**，理由见文件头「压制 vs 避让」）。
 *
 * ⚠️ **避让是单向的**（spec 2026-11-10-ruined-citadel-port §6 风险 5）：废弃堡垒
 * （`ruined-citadel.js`，城西）的 `fixedBlockerAt` **会**避让本结构，而本函数**不知道**
 * 废弃堡垒的存在。当前两者分处 City 东西两侧 ⇒ 实测 8/8 seed 无冲突，单向足够。
 * ⚠️ **将来若把任一结构改到同一侧，必须在这里补上双向避让** —— 否则两个大结构会
 * 静默互相穿插（锚点层各自都认为对方不存在，而光栅化是后写胜，方块层面看不出是避让漏了）。
 *
 * @returns {string|null} 冲突原因（诊断用），无冲突返回 null
 */
function fixedBlockerAt(wx, wz, city, shallow, arena, seed) {
  // ① 城市：整个占地都要出城（不是圆心出城）
  if (wx - BURNING_ARENA_HALF <= city.maxX + CITY_CLEARANCE) return 'city';
  // ② 浅水高台：整形区（含缓坡）整圆让路
  if (shallow &&
      Math.hypot(shallow.wx - wx, shallow.wz - wz) <= SHALLOW_TARN_OUTER_RADIUS + BURNING_ARENA_HALF) {
    return 'shallowTarn';
  }
  // ③ 围场（城南门外，全世界一个）
  if (arena &&
      Math.abs(arena.wx - wx) <= ARENA_HALF_X + BURNING_ARENA_HALF &&
      Math.abs(arena.wz - wz) <= ARENA_HALF_Z + BURNING_ARENA_HALF) {
    return 'arena';
  }
  // ④ 高台地带：整圆让路（地带是地基级内容，与本结构同级，两者不得重叠）。
  //    ⚠️ 必须扫占地触及的全部 region（85×85 可跨 2×2 个 region）。
  const rxLo = Math.floor((wx - BURNING_ARENA_HALF) / REGION_SIZE);
  const rxHi = Math.floor((wx + BURNING_ARENA_HALF) / REGION_SIZE);
  const rzLo = Math.floor((wz - BURNING_ARENA_HALF) / REGION_SIZE);
  const rzHi = Math.floor((wz + BURNING_ARENA_HALF) / REGION_SIZE);
  for (let rx = rxLo; rx <= rxHi; rx++) {
    for (let rz = rzLo; rz <= rzHi; rz++) {
      if (!isTarnZone(rx, rz, seed)) continue;
      const t = computeTarnZone(rx, rz, seed);
      if (!t) continue;
      if (Math.abs(t.cx - wx) <= TARN_ZONE_RADIUS + BURNING_ARENA_HALF &&
          Math.abs(t.cz - wz) <= TARN_ZONE_RADIUS + BURNING_ARENA_HALF) return 'tarn';
    }
  }
  return null;
}

/**
 * 大竞技场的落点（**每个 seed 恰好一个**，用户裁定「必须且唯一」）。
 *
 * ## 判据
 *   ① 整个 85×85 占地都是 DESERT biome；
 *   ② 占地内每格 `generateHeight > SEA_Y`（不扎海底）；
 *   ③ 占地内地表高差 ≤ `BURNING_ARENA_SPANS` 的某一档（先严后松，取第一个有解的档）；
 *   ④ 在 City 东侧，且与城市 bounds 净距 ≥ `CITY_TRANSITION_SIZE`；
 *   ⑤ 不与高台地带 / 浅水高台 / 围场重叠；
 *   ⑥ 在所有满足 ①~⑤ 的点里取**距城市中心最近**的（「城东最近」的口径）。
 *
 * ⚠️ **确定性**：候选按「距城市中心距离 → x → z」排序，tie 用坐标字典序 ⇒ 跨机 / 跨 Worker
 * 结果恒一致（红线 2）。不用 `seededRandom` 乱序 —— 用户要的是「最近」，不是「随机一个」。
 *
 * @param {number} seed
 * @returns {{wx:number, wz:number, floorY:number, span:number}|null} 找不到返回 null（不阻断 GEN）
 */
export function computeBurningArenaAnchor(seed) {
  if (anchorMemo.has(seed)) return anchorMemo.get(seed);

  const city = getCityBoundsForSeed(seed);
  const cityCx = Math.round((city.minX + city.maxX) / 2);
  const cityCz = Math.round((city.minZ + city.maxZ) / 2);
  const shallow = computeShallowTarnAnchor(seed);
  const arena = computeArenaAnchor(seed);

  // 搜索窗：城东（起点已含半宽 + 城市净空），纬度取城市中线 ±SEARCH_HALF_Z
  const x0 = city.maxX + BURNING_ARENA_HALF + CITY_CLEARANCE;
  const x1 = x0 + BURNING_ARENA_MAX_GAP;
  const z0 = cityCz - SEARCH_HALF_Z;
  const z1 = cityCz + SEARCH_HALF_Z;

  // ⚠️ **必须用 `floor` 而不是 `ceil`**（实测踩到的真缺陷之一）：粗筛只能是精检的
  // **必要条件**（更宽），绝不能更严。`ceil(42/8)=6` 让粗筛覆盖 ±48 > 精检的 ±42，
  // 于是「±42 内全沙漠、但 ±48 环上有非沙漠」的点被粗筛误杀 —— 实测 seed 12345
  // 因此跳过了**更近**的合法候选，违反「最近」口径。
  // `floor(42/8)=5` → 粗筛 ±40 ⊂ 精检 ±42：粗筛不过 ⇒ 精检必不过（正确的必要条件）。
  const gi = Math.floor(BURNING_ARENA_HALF / COARSE_STEP);

  // ⚠️ **网格必须向四周外扩 `gi` 格**（实测踩到的真缺陷之二）：`coarseOk` 要查候选的
  // ±gi 邻域，若网格只覆盖搜索窗本身，**窗边缘的候选**其邻域会越出网格 → 越界返回 false
  // → 合法候选被静默误杀。实测 seed 99999：候选 (457,-443) 的网格下标 i=1，邻域下界
  // i-gi = -4 < 0 ⇒ 被误杀，而它的 `exactFootprint` 完全合法（x∈[415,499] 全沙漠）。
  // 外扩后邻域查得到真实 biome，越界分支只在「真的出了外扩网格」时触发。
  const gx0 = x0 - gi * COARSE_STEP;
  const gz0 = z0 - gi * COARSE_STEP;
  const nx = Math.ceil((x1 + gi * COARSE_STEP - gx0) / COARSE_STEP) + 1;
  const nz = Math.ceil((z1 + gi * COARSE_STEP - gz0) / COARSE_STEP) + 1;

  // 粗筛网格：一次算好 biome + height（全部候选共用，不逐候选重算）
  const desert = new Uint8Array(nx * nz);
  const hgt = new Float32Array(nx * nz);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const wx = gx0 + i * COARSE_STEP, wz = gz0 + j * COARSE_STEP;
      desert[i + j * nx] = getBiome(wx, wz, seed) === 'DESERT' ? 1 : 0;
      hgt[i + j * nx] = generateHeight(wx, wz, seed);
    }
  }

  // 候选 = **搜索窗内**的沙漠点（外扩那圈只作邻域数据，不当候选），
  // 按「距城市中心 → x → z」排序（确定性）
  const iLo = gi, iHi = Math.ceil((x1 - gx0) / COARSE_STEP);
  const jLo = gi, jHi = Math.ceil((z1 - gz0) / COARSE_STEP);
  const pts = [];
  for (let i = iLo; i <= iHi; i++) {
    for (let j = jLo; j <= jHi; j++) {
      if (!desert[i + j * nx]) continue;
      const wx = gx0 + i * COARSE_STEP, wz = gz0 + j * COARSE_STEP;
      pts.push([wx, wz, i, j, Math.hypot(wx - cityCx, wz - cityCz)]);
    }
  }
  pts.sort((a, b) => (a[4] - b[4]) || (a[0] - b[0]) || (a[1] - b[1]));

  /** 粗筛：网格邻域内全沙漠 + 高差 ≤ span（必要条件，命中后仍要精检） */
  const coarseOk = (i, j, span) => {
    let mn = Infinity, mx = -Infinity;
    for (let dj = -gi; dj <= gi; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= nz) return false;
      for (let di = -gi; di <= gi; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) return false;
        const k = ii + jj * nx;
        if (!desert[k]) return false;
        const h = hgt[k];
        if (h <= SEA_Y) return false;
        if (h < mn) mn = h;
        if (h > mx) mx = h;
        if (mx - mn > span) return false;
      }
    }
    return true;
  };

  // 先严后松：取第一个有解的 span 档（保证「相对平坦」优先，同时「必须生成」兜底）
  let result = null;
  for (const span of BURNING_ARENA_SPANS) {
    for (const [wx, wz, i, j] of pts) {
      if (!coarseOk(i, j, span)) continue;
      if (fixedBlockerAt(wx, wz, city, shallow, arena, seed)) continue;
      const f = exactFootprint(wx, wz, span, seed);
      if (!f) continue;
      result = Object.freeze({ wx, wz, floorY: f.minH, span: f.span });
      break;
    }
    if (result) break;
  }
  if (anchorMemo.size >= ANCHOR_MEMO_MAX) anchorMemo.delete(anchorMemo.keys().next().value);
  anchorMemo.set(seed, result);
  return result;
}

/**
 * 一个候选点是否**完全合法**（导出供单测复用同一份判据 —— 红线 1）。
 *
 * ⚠️ **为什么必须导出**：单测要钉「锚点是最近的那个」，就得能判「另一个更近的点合不合法」。
 * 若测试自己写一份判据（只算沙漠+平坦），会与搜索侧漂移 —— 实测踩过：测试漏了
 * 城市净空判据，把被城市挡掉的 (449,-443) 当成「更近的合法候选」报假 FAIL。
 * 搜索与测试共用本函数 ⇒ 两边不可能不一致。
 *
 * @param {number} wx @param {number} wz 候选中心
 * @param {number} span 地表高差上限
 * @param {number} seed
 * @returns {{ok:true, minH:number, maxH:number, span:number}|{ok:false, why:string}}
 */
export function burningArenaCandidateValid(wx, wz, span, seed) {
  const city = getCityBoundsForSeed(seed);
  const blocker = fixedBlockerAt(wx, wz, city, computeShallowTarnAnchor(seed), computeArenaAnchor(seed), seed);
  if (blocker) return { ok: false, why: blocker };
  const f = exactFootprint(wx, wz, span, seed);
  if (!f) return { ok: false, why: 'footprint' };
  return { ok: true, minH: f.minH, maxH: f.maxH, span: f.span };
}

/**
 * 点是否落在大竞技场占地内（85×85 方形）。
 *
 * 唯一权威（红线 1）：`apply.js` 阶段 2.7 的撒布剔除、`pointContext` 的植被让路、
 * 将来的消费者都用这一份，不得各自写一遍 `Math.abs(dx) <= 42`。
 * 与 `inGiantPyramidFootprint` / `inArenaFootprint` 同签名同语义。
 *
 * @param {number} wx @param {number} wz
 * @param {Array<{wx:number, wz:number}|null>} anchors 邻域 layouts 的 `burningArena`
 * @returns {boolean}
 */
export function inBurningArenaFootprint(wx, wz, anchors) {
  if (!anchors) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (Math.abs(wx - a.wx) <= BURNING_ARENA_HALF && Math.abs(wz - a.wz) <= BURNING_ARENA_HALF) return true;
  }
  return false;
}

/**
 * 本 region 的雪原是否被**大竞技场占地**让路（v2.94）。
 *
 * ## 语义：与 `snowLandSuppressedByTarn` 完全同构 —— “整座雪原不生成”
 * 判据是“雪原盒（±28）× 占地矩形（±42）相交”，**不是**“雪原中心在占地内”：
 * 雪原在 `getSnowLandInfo` 里是切比雪夫方形（±20 核心 + ±8 过渡带 = ±28），
 * 用圆心距近似会漏掉**角部擦入**（同 `snowLandSuppressedByTarn` 的实测教训）。
 *
 * ## 为何不是“只擦占地内那几格”
 * ① 地图与 Boss 定位粒度是“整座雪原”（`boss-map.js` 的 `snowMapAt` / `minimap-regions.js`
 *    的 `snows`）—— 部分侵入会留下一座“半截还在地图上、却已不存在”的雪原；
 * ② `layout.snowLand` 是 region 级字段，部分压制在数据模型里表达不了（除非引入第二份权威）。
 * 与大竞技场其余压制项（地标/金字塔/空岛）同口径：**整座压掉**。
 *
 * ## 三个消费者（单一权威，红线 1）
 *   ① `apply.js` 阶段 1 的 `generateSnowLand` 跳过门（与 `snowLandSuppressedByTarn` 并列）；
 *   ② `structure-layout.js` 把 `layout.snowLand` 置 null（地图/Boss 定位不再看到它）；
 *   ③ 单测直接驱动。
 *
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {boolean} true = 该 region 的雪原要整座让路
 */
export function snowLandSuppressedByBurningArena(regionX, regionZ, seed) {
  const a = computeBurningArenaAnchor(seed);
  if (!a) return false;
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  const snowCx = raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X;
  const snowCz = raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z;
  // 方↔方相交（两轴都需相交才是真相交）
  return Math.abs(a.wx - snowCx) <= BURNING_ARENA_HALF + LANDMARK_CLEARANCE.snowLand &&
         Math.abs(a.wz - snowCz) <= BURNING_ARENA_HALF + LANDMARK_CLEARANCE.snowLand;
}

/**
 * 本 region 的**哪些地标**被大竞技场压掉（与 `shallowTarnSuppressedLandmarks` 同构）。
 *
 * 判据是「该地标中心是否落在大竞技场占地内」，**不是**「本 region 是不是锚点所在 region」。
 * ⚠️ 两种写法实测差别很大（浅水高台踩过）：85×85 占地可跨 2×2 个 region，而锚点所在的
 * 那个 region 里可能一个地标都没有、地标全在邻居 region。按「锚点 region」压制会
 * ① 压掉一个本来没冲突的地标（零回归失败），② 又不压真正冲突的那些。
 *
 * @param {{wx:number, wz:number, floorY:number}} anchor
 * @param {number} regionX @param {number} regionZ @param {number} seed
 * @returns {{pyramid:boolean, frozenMountain:boolean, plainLand:boolean, island:boolean,
 *           snowLand:boolean, giantPyramid:boolean, skyIslands:boolean}}
 */
export function burningArenaSuppressedLandmarks(anchor, regionX, regionZ, seed) {
  const out = {
    pyramid: false, frozenMountain: false, plainLand: false, island: false,
    snowLand: false, giantPyramid: false, skyIslands: false,
  };
  if (!anchor) return out;
  const H = BURNING_ARENA_HALF;

  // ⚠️ **廉价距离门（性能关键，实测踩到的真缺陷）**：本函数对**每个** region 都会被
  // `computeRegionLayout` 调用，而它内部要调 `computeRegionLocalGiantPyramid`（扫全区沙漠）
  // 与 `computeSkyCandidates`（两个都是重函数）。实测不加门时 `computeRegionLayout`
  // 从 pristine 的 7.81ms/region 涨到 8.57ms/region（+0.76ms，+9.7%）—— 而 layout 在
  // GEN 计时路径上被 9 个邻域 region 各调一次，这个增量会让 `lake-ripple.spec` 的
  // 波纹测量窗口里主线程/Worker 被 layout 占满 → 两帧截图逐位相同（changed=0%）。
  //
  // 门判据：地标中心被 clamp 在本 region AABB 内，故「本 region 任一地标圆能碰到竞技场」
  // 的必要条件是「region AABB 到竞技场矩形的最近距离 ≤ 最大地标半径」。
  // 超过就不可能有任何地标/空岛/金字塔碰到 → 直接返回全 false，不付任何重函数成本。
  // 最大半径取 `LANDMARK_CLEARANCE` 的最大值（frozenMountain 48）+ 空岛/金字塔余量，单一权威不写死。
  const MAX_REACH = Math.max(...Object.values(LANDMARK_CLEARANCE)) + PYRAMID_HALF;
  const regionMinX = regionX * REGION_SIZE, regionMaxX = regionMinX + REGION_SIZE - 1;
  const regionMinZ = regionZ * REGION_SIZE, regionMaxZ = regionMinZ + REGION_SIZE - 1;
  const gapX = Math.max(0, (anchor.wx - H) - regionMaxX, regionMinX - (anchor.wx + H));
  const gapZ = Math.max(0, (anchor.wz - H) - regionMaxZ, regionMinZ - (anchor.wz + H));
  if (Math.hypot(gapX, gapZ) > MAX_REACH) return out;
  // ⚠️ **必须用「圆↔矩形相交」而不是「地标中心在占地内」**（实测踩到的真缺陷）：
  // 地标是「中心 + 半径」的圆，占地是 ±H 的方。seed 12345 的 plainLand 中心 (760,-20)
  // 在竞技场 z 范围 [-105,-21] **外 1 格**（dz=43 > 42），但它的半径 15 伸进了占地
  // ⇒ 中心判据漏压，平地的沙柱+仙人掌长进了碗身（实测 16 格植被穿模）。
  // 圆↔矩形相交：圆心到矩形的最近距离 ≤ 半径即相交（与 `circleRectGap` 同口径）。
  const hits = (cx, cz, r) => {
    const dx = Math.max(0, Math.abs(cx - anchor.wx) - H);
    const dz = Math.max(0, Math.abs(cz - anchor.wz) - H);
    return Math.hypot(dx, dz) <= r;
  };

  const py = getPyramidCenterInRegion(regionX, regionZ, seed);
  if (py && hits(py.cx, py.cz, LANDMARK_CLEARANCE.pyramid)) out.pyramid = true;
  const fm = getFrozenMountainCenterInRegion(regionX, regionZ, seed);
  if (fm && hits(fm.cx, fm.cz, LANDMARK_CLEARANCE.frozenMountain)) out.frozenMountain = true;
  const plain = getPlainLandCenterInRegion(regionX, regionZ, seed);
  if (plain && hits(plain.cx, plain.cz, LANDMARK_CLEARANCE.plainLand)) out.plainLand = true;
  const isl = getIslandCenterInRegion(regionX, regionZ, seed);
  if (isl && hits(isl.islandCx, isl.islandCz, LANDMARK_CLEARANCE.island)) out.island = true;
  // 雪原：中心由 region 播种中心 + 固定偏移派生（与 `computeRegionLayout` 同源常量）
  const raw = getRegionSeededCenter(regionX, regionZ, seed);
  if (hits(raw.centerX + LANDMARK_OFFSET.SNOW_LAND_X, raw.centerZ + LANDMARK_OFFSET.SNOW_LAND_Z,
    LANDMARK_CLEARANCE.snowLand)) {
    out.snowLand = true;
  }
  // 巨型金字塔：用**未过间距去重与概率门**的局部锚点（更保守，排除得更多 —— 方向安全）。
  // 它是方形占地（±PYRAMID_HALF），用方↔方相交（与 `inGiantPyramidFootprint` 同口径）。
  const gp = computeRegionLocalGiantPyramid(regionX, regionZ, seed);
  if (gp && Math.abs(gp.wx - anchor.wx) <= PYRAMID_HALF + H &&
      Math.abs(gp.wz - anchor.wz) <= PYRAMID_HALF + H) out.giantPyramid = true;
  // 空岛：塔顶 y = floorY + 80（实测 79~84）远高于空岛底（y≥40）⇒ 水平重叠即相撞。
  // ⚠️ 这是大竞技场**特有**的压制项（浅水高台在海平面，塔高只有几格，碰不到空岛）。
  //    实测 8 seed 中 7 个的空岛与大竞技场占地水平重叠。
  const topY = anchor.floorY + BURNING_ARENA_HEIGHT;
  const sky = computeSkyCandidates(regionX, regionZ, seed).skyIslands;
  for (let i = 0; i < sky.length; i += 5) {
    const ox = sky[i] * 16 + 8, oz = sky[i + 1] * 16 + 8;
    const bottomY = sky[i + 2], radius = sky[i + 3];
    if (Math.abs(ox - anchor.wx) > radius + H) continue;
    if (Math.abs(oz - anchor.wz) > radius + H) continue;
    if (bottomY <= topY) { out.skyIslands = true; break; }
  }
  return out;
}

/**
 * 大竞技场占地 AABB 是否与本 region 相交（layout 层裁剪用：不相交则不携带锚点）。
 *
 * ⚠️ 与 `arenaOverlapsRegion` 同手法同理由：锚点是**全局唯一**的，可能落在任何 region，
 * 而每个 column 的查询域只拿 3×3 region 布局 —— 不相交的 region 携带它只会白抬 payload。
 * ⚠️ **不能写成「只在锚点所在 region 携带」**：85×85 占地可跨 2×2 个 region，
 * 只让一个 region 携带会让邻区负责的那部分**缺半边**（与围场 v2.7 踩过的坑同形）。
 */
export function burningArenaOverlapsRegion(anchor, regionX, regionZ) {
  if (!anchor) return false;
  const minX = anchor.wx - BURNING_ARENA_HALF, maxX = anchor.wx + BURNING_ARENA_HALF;
  const minZ = anchor.wz - BURNING_ARENA_HALF, maxZ = anchor.wz + BURNING_ARENA_HALF;
  const rMinX = regionX * REGION_SIZE, rMaxX = rMinX + REGION_SIZE - 1;
  const rMinZ = regionZ * REGION_SIZE, rMaxZ = rMinZ + REGION_SIZE - 1;
  return minX <= rMaxX && maxX >= rMinX && minZ <= rMaxZ && maxZ >= rMinZ;
}

/**
 * 瞬移到大竞技场的落点（设置面板「竞技场」按钮，v2.87）。
 *
 * 落点 = 占地**西缘**（City 那一侧）再向西 `BURNING_ARENA_TELEPORT_GAP` 格、z 取锚点中线：
 * 玩家面朝东（+X，大竞技场在 City 东侧）就能看到整个碗体。y 用该格**自然地表**
 * （`generateHeight`）+ 1 —— **不用 `anchor.floorY`**，那是碗内地板层高度，缘外沙漠的
 * 自然高度与之可能差几格（实测 8 seed 差 0~5 格）。
 *
 * ⚠️ **缘外那一点不在锚点判据的保证范围内**（判据只逐格校 ±`BURNING_ARENA_HALF` 的占地）：
 * 实测 8 seed（12345 / 99999 / 1249026 / 20260101 / 777 / 4242 / 31337 / 8888）该点均为
 * DESERT、高于海平面、周围 5×5 自然高差 ≤ 1 格，且不在浅水高台整形区 / 城市 bounds 内。
 * 若将来改 `BURNING_ARENA_TELEPORT_GAP` 或锚点判据，**必须重跑这份普查** ——
 * 最坑的形态是落点泡进浅水高台的整形区（`fixedBlockerAt` 只保证锚点到湖心
 * > `SHALLOW_TARN_OUTER_RADIUS + HALF`，减去 48 格后理论上可伸进整形区 ≤ 6 格）。
 *
 * ⚠️ **唯一权威（红线 1）**：`Game.teleportToBurningArena` 与 `tests/teleport.spec.mjs`
 * 都消费本函数，不得各自复算一份落点。
 *
 * @param {number} seed
 * @returns {{x:number, y:number, z:number}|null} 该 seed 没有大竞技场时返回 null
 */
export function burningArenaTeleportPoint(seed) {
  const a = computeBurningArenaAnchor(seed);
  if (!a) return null;
  const x = a.wx - BURNING_ARENA_HALF - BURNING_ARENA_TELEPORT_GAP;
  const z = a.wz;
  const y = generateHeight(x, z, seed) + 1;   // +1 = 地表方块之上那一格（脚底）
  if (![x, y, z].every((v) => Number.isFinite(v))) return null;
  return { x, y, z };
}
