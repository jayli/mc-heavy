// src/gen/structures/tarn-altar.js — 高台地带祭坛（v2.30 首创，v2.82 用户重做造型）
//
// 用户 2026-10-31 在存档里手工修出了一座祭坛并内化进代码；2026-11-06 用户在同一存档
// （进度包 `/Users/bachi/ttt/mc/mc-heavy-progress-1249026-2026-11-06T15-01-30.json`，
// seed 1249026 的 region(0,-3) 地带圆心 (200,-1000)）**重做了祭坛造型**，要求替换
// v2.30 的旧图案。本文件是重做后的造型（逐格解码自用户存档，重建比对 0 不符）。
// 祭坛仍只放在**离 City 最近的高台地带**的圆心广场（设置面板「高台」瞬移到达的那个地带）。
//
// 祭坛 = 两层：
//   · 地表层（y = plateauY，**替换**广场原有的 tuff_bricks/smooth_stone_1，不抬高地面）：
//     - 中心 7×7 美朵（debris 心 + diamond 十字 + gold/amethyst 点缀，见 MEDALLION 表）；
//     - 十字轴（dx=0 或 dz=0）：中心到 ±29，**gold（偶数格）/ amethyst（奇数格）交替**；
//     - 对角线（|dx|=|dz|）：4~20，同样 gold（偶）/ amethyst（奇）交替；
//     - 外圈 amethyst 环（28 < r ≤ 29），**带 8 个对称缺口**（(±16,±24)、(±24,±16)，
//       用户刻意保留，2026-11-08 确认「按解码原样实现」）；
//     - 旧 tuff 十字臂的抹平：|dx|=1 或 |dz|=1（另一轴 4~27）写回 smooth_stone_1
//       （广场的 tuff 十字是 v2.25 的地形特征，祭坛范围内用户全部抹平，实测 tuff 残留 0）。
//   · 神龛（唯一突出地面的区域，v2.82 从旧版 22 格简化为 6 格）：
//     dy+1：中心 gold_block + 四向 planks_step（高侧朝中心，沿用旧版实测口径）；
//     dy+2：中心 diamond。
//
// ⚠️ **v2.31 起祭坛地带不生成紫晶柱**（用户 2026-10-31 裁定，v2.82 不改）：
// `computeTarnZone` 对 `altar` 地带不放 spire，其他地带的 7 根紫晶柱一根不动。
//
// ⚠️ **`TARN_PLAZA_RADIUS`(28) 不因此改小**：它的标定理由是「紫晶柱真实足迹最远 25.4」，
// 而其他地带仍有柱子 ⇒ 全局常量必须按最坏情况留。祭坛外环（r≤29）比广场半径大 1 格，
// 落在冰带内圈上 —— 这是用户存档的原样（外环压在 ice 上），刻意保留。
//
// Worker 同构：纯函数、无 three、无 DOM、无 fetch（红线 8）。

/** 十字轴臂长（单侧，从中心到轴末端 ±29；也是整个地表图案的最大 |dx|/|dz|） */
export const ALTAR_ARM_LENGTH = 29;
/** 对角线的起止半径（含端点；t=3 属中心美朵，故从 4 起） */
export const ALTAR_DIAG_MIN = 4;
export const ALTAR_DIAG_MAX = 20;
/** 外圈紫晶环的半径范围：`ALTAR_RING_RMIN < r <= ALTAR_RING_RMAX` */
export const ALTAR_RING_RMIN = 28;
export const ALTAR_RING_RMAX = 29;

/**
 * 外圈的对称缺口（用户刻意保留，2026-11-08 确认「按解码原样实现」）。
 *
 * ⚠️ 键是**归一化的绝对值对** `min(ax,az),max(ax,az)`：`'16,24'` 一项即覆盖全部 8 个
 * 对称格 (±16,±24) 与 (±24,±16)。查询侧必须用同一归一式，否则四向对称会被打破。
 * ⚠️ (±20,±20) 也落在环带内，但它先被对角线规则取走（gold），不属缺口。
 */
export const ALTAR_RING_GAPS = Object.freeze(new Set(['16,24']));

/**
 * 中心 7×7 美朵的四分之一表（`MEDALLION[ax][az]`，ax=|dx|、az=|dz|，均 ≤ 3）。
 * 图案四向对称，故只存第一象限；`null` = 不属祭坛（保持广场 smooth_stone_1 背景）。
 *
 * ```
 *        az=0       az=1       az=2       az=3
 * ax=0   debris     diamond    gold       amethyst
 * ax=1   diamond    gold       amethyst   gold
 * ax=2   gold       amethyst   gold       (背景)
 * ax=3   amethyst   gold       (背景)     amethyst
 * ```
 */
const MEDALLION = Object.freeze([
  Object.freeze(['debris', 'diamond', 'gold_block', 'amethyst']),
  Object.freeze(['diamond', 'gold_block', 'amethyst', 'gold_block']),
  Object.freeze(['gold_block', 'amethyst', 'gold_block', null]),
  Object.freeze(['amethyst', 'gold_block', null, 'amethyst']),
]);

/**
 * 祭坛地表层图案的唯一权威（相对地带圆心的偏移 → 方块）。
 *
 * 返回 `{type, meta}` 或 `null`（该格不属于祭坛，保持广场/冰带原材质）。
 * 图案完全四向对称（镜像 + 转置），与用户 2026-11-06 存档逐格一致（565 格）。
 *
 * 分支顺序是载荷性的：美朵 → 十字轴 → 对角线 → 外环 → 抹平臂。
 * 对角线必须先于外环（(20,20) 的 r=28.28 落在环带内，但它是 gold 不是环的 amethyst）。
 *
 * @param {number} dx 相对地带圆心的 x 偏移
 * @param {number} dz 相对地带圆心的 z 偏移
 * @returns {{type: string, meta: number} | null}
 */
export function altarSurfaceBlockAt(dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);

  // ── 中心 7×7 美朵 ──
  if (ax <= 3 && az <= 3) {
    const t = MEDALLION[ax][az];
    return t ? { type: t, meta: 0 } : null;
  }

  // ── 十字轴：gold（偶数格）/ amethyst（奇数格）交替，2..29 ──
  if (dx === 0 || dz === 0) {
    const t = Math.max(ax, az);
    if (t >= 2 && t <= ALTAR_ARM_LENGTH) {
      return { type: t % 2 === 0 ? 'gold_block' : 'amethyst', meta: 0 };
    }
    return null;
  }

  // ── 对角线：gold（偶）/ amethyst（奇）交替，4..20 ──
  if (ax === az && ax >= ALTAR_DIAG_MIN && ax <= ALTAR_DIAG_MAX) {
    return { type: ax % 2 === 0 ? 'gold_block' : 'amethyst', meta: 0 };
  }

  // ── 外圈 amethyst 环：28 < r <= 29，带 8 个对称缺口 ──
  const r = Math.hypot(dx, dz);
  if (r > ALTAR_RING_RMIN && r <= ALTAR_RING_RMAX) {
    const gapKey = `${Math.min(ax, az)},${Math.max(ax, az)}`;
    if (ALTAR_RING_GAPS.has(gapKey)) return null;
    return { type: 'amethyst', meta: 0 };
  }

  // ── 抹平旧 tuff 十字臂：|dx|=1 或 |dz|=1（另一轴 4..27）写回 smooth_stone_1 ──
  //    （广场的 3 格宽 tuff 十字在祭坛范围内被用户全部抹平；不写则 tuff 残留。）
  if ((ax === 1 && az >= 4 && az <= 27) || (az === 1 && ax >= 4 && ax <= 27)) {
    return { type: 'smooth_stone_1', meta: 0 };
  }

  return null;
}

/**
 * 祭坛神龛（唯一突出地面的部分）的块表，相对地带圆心 + plateauY。
 *
 * v2.82 简化为 6 格：dy=1 中心 gold_block + 四向台阶（高侧朝中心），dy=2 中心 diamond。
 * 台阶 meta 按 mesher 实测口径（orient 0/1/2/3 高侧 = -X/+Z/+X/-Z），与旧版一致。
 * （旧版 v2.30 的 iron 角柱 / emerald 环已被用户拆除。）
 *
 * @returns {Array<{dx: number, dy: number, dz: number, type: string, meta: number}>}
 */
export function altarShrineBlocks() {
  return [
    { dx: 0, dy: 1, dz: 0, type: 'gold_block', meta: 0 },
    // 四向台阶，高侧朝中心（(1,0)→-X / (-1,0)→+X / (0,-1)→+Z / (0,1)→-Z）
    { dx: 1, dy: 1, dz: 0, type: 'planks_step', meta: 0 },
    { dx: -1, dy: 1, dz: 0, type: 'planks_step', meta: 2 },
    { dx: 0, dy: 1, dz: -1, type: 'planks_step', meta: 1 },
    { dx: 0, dy: 1, dz: 1, type: 'planks_step', meta: 3 },
    { dx: 0, dy: 2, dz: 0, type: 'diamond', meta: 0 },
  ];
}

/**
 * 把祭坛光栅化进 column（生成路径：不记 edits、不 bump version，与
 * `fillTarnPlateau` / 结构光栅化同口径）。
 *
 * ⚠️ **必须在 `fillTarnPlateau` 之后调用**：祭坛地表替换掉广场的
 *    tuff_bricks/smooth_stone_1（晚于台地整形才不会被它盖回去）。
 *    （v2.31 起祭坛地带已无紫晶柱，「早于紫晶柱」这条层序不再有实际效果，
 *    但接线位置不动 —— 若将来给祭坛地带加回柱子，后写胜仍是正确语义。）
 * 写入裁剪由 `setBlock`（`makeColumnSetter`）承担，越界格静默跳过。
 *
 * @param {{cx: number, cz: number, plateauY: number}} layout 地带布局
 * @param {(wx:number, y:number, wz:number, name:string, meta?:number) => void} setBlock
 */
export function rasterizeAltar(layout, setBlock) {
  const { cx, cz, plateauY } = layout;

  // 地表层（y = plateauY）
  for (let dx = -ALTAR_ARM_LENGTH; dx <= ALTAR_ARM_LENGTH; dx++) {
    for (let dz = -ALTAR_ARM_LENGTH; dz <= ALTAR_ARM_LENGTH; dz++) {
      const b = altarSurfaceBlockAt(dx, dz);
      if (b) setBlock(cx + dx, plateauY, cz + dz, b.type, b.meta);
    }
  }

  // 神龛（y = plateauY + 1 / + 2）
  for (const b of altarShrineBlocks()) {
    setBlock(cx + b.dx, plateauY + b.dy, cz + b.dz, b.type, b.meta);
  }
}
