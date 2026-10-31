// src/gen/structures/tarn-altar.js — 高台地带祭坛（v2.30）
//
// 用户 2026-10-31 在存档里手工修出了一座祭坛（进度包
// `/Users/bachi/ttt/bug/mc_祭坛/mc-heavy-progress-1249026-*.json`，seed 1249026 的
// region(0,5) 地带圆心），要求把造型内化进代码：放在**离 City 最近的高台地带**的
// 圆心广场（设置面板「高台」瞬移到达的那个地带）。
//
// 祭坛 = 两层（逐格解码自用户存档）：
//   · 地表层（y = plateauY，**替换**广场原有的 tuff_bricks/smooth_stone_1，不抬高地面）：
//     黄金十字（±28、1 格宽）+ 紫水晶对角线（半径 4~20）+ 中心 3×3
//     （四角 gold、四正 diamond、中心 debris）。
//   · 神龛（唯一突出地面的区域，7×7 中心）：
//     dy+1：四角与中心 iron、八位 emerald、四向 planks_step（高侧朝中心）；
//     dy+2：四角 emerald、中心 diamond。
//
// ⚠️ 紫晶柱**不受影响**：祭坛先写、紫晶柱后光栅化（后写胜），柱基自然压在祭坛
// 地表格上 —— 正好复现用户存档里「东臂缺 7 格、对角线缺 3 格」的形态（那 10 格
// 被柱基占了）。代码生成完整对称图案，柱基覆盖处由柱决定。
//
// Worker 同构：纯函数、无 three、无 DOM、无 fetch（红线 8）。

/** 黄金十字臂长（单侧，从中心 3×3 外缘到末端） */
export const ALTAR_ARM_LENGTH = 28;
/** 紫水晶对角线的起止半径（含端点） */
export const ALTAR_DIAG_MIN = 4;
export const ALTAR_DIAG_MAX = 20;

/**
 * 祭坛地表层图案的唯一权威（相对地带圆心的偏移 → 方块）。
 *
 * 返回 `{type, meta}` 或 `null`（该格不属于祭坛，保持广场原材质）。
 * 图案完全四向对称（镜像 + 转置），与用户存档逐格一致（对称补全后 185 格）。
 *
 * @param {number} dx 相对地带圆心的 x 偏移
 * @param {number} dz 相对地带圆心的 z 偏移
 * @returns {{type: string, meta: number} | null}
 */
export function altarSurfaceBlockAt(dx, dz) {
  const ax = Math.abs(dx), az = Math.abs(dz);

  // ── 中心 3×3：debris 心 + diamond 边 + gold 角 ──
  if (ax <= 1 && az <= 1) {
    if (ax === 0 && az === 0) return { type: 'debris', meta: 0 };
    if (ax + az === 1) return { type: 'diamond', meta: 0 };
    return { type: 'gold_block', meta: 0 };
  }

  // ── 黄金十字臂：一条轴为 0，另一条 2..28 ──
  const arm = Math.max(ax, az);
  if ((dx === 0 || dz === 0) && arm >= 2 && arm <= ALTAR_ARM_LENGTH) {
    return { type: 'gold_block', meta: 0 };
  }

  // ── 紫水晶对角线：|dx| === |dz|，半径 4..20 ──
  if (ax === az && ax >= ALTAR_DIAG_MIN && ax <= ALTAR_DIAG_MAX) {
    return { type: 'amethyst', meta: 0 };
  }

  return null;
}

/**
 * 祭坛神龛（唯一突出地面的部分）的块表，相对地带圆心 + plateauY。
 *
 * 共 22 格：dy=1 十七格（iron 5 + emerald 8 + planks_step 4），dy=2 五格
 * （emerald 4 + diamond 1）。台阶 meta 按 mesher 实测口径（orient 0/1/2/3
 * 高侧 = -X/+Z/+X/-Z）取「高侧朝中心」，与用户存档逐格一致。
 *
 * @returns {Array<{dx: number, dy: number, dz: number, type: string, meta: number}>}
 */
export function altarShrineBlocks() {
  const blocks = [];

  // dy=1：四角与中心 iron
  for (const [dx, dz] of [[3, 3], [3, -3], [-3, 3], [-3, -3], [0, 0]]) {
    blocks.push({ dx, dy: 1, dz, type: 'iron', meta: 0 });
  }
  // dy=1：八位 emerald（7×7 环上贴角的边格）
  for (const [dx, dz] of [[3, 2], [2, 3], [3, -2], [2, -3], [-3, 2], [-2, 3], [-3, -2], [-2, -3]]) {
    blocks.push({ dx, dy: 1, dz, type: 'emerald', meta: 0 });
  }
  // dy=1：四向台阶，高侧朝中心（(1,0)→-X / (-1,0)→+X / (0,-1)→+Z / (0,1)→-Z）
  blocks.push({ dx: 1, dy: 1, dz: 0, type: 'planks_step', meta: 0 });
  blocks.push({ dx: -1, dy: 1, dz: 0, type: 'planks_step', meta: 2 });
  blocks.push({ dx: 0, dy: 1, dz: -1, type: 'planks_step', meta: 1 });
  blocks.push({ dx: 0, dy: 1, dz: 1, type: 'planks_step', meta: 3 });

  // dy=2：四角 emerald + 中心 diamond
  for (const [dx, dz] of [[3, 3], [3, -3], [-3, 3], [-3, -3]]) {
    blocks.push({ dx, dy: 2, dz, type: 'emerald', meta: 0 });
  }
  blocks.push({ dx: 0, dy: 2, dz: 0, type: 'diamond', meta: 0 });

  return blocks;
}

/**
 * 把祭坛光栅化进 column（生成路径：不记 edits、不 bump version，与
 * `fillTarnPlateau` / 结构光栅化同口径）。
 *
 * ⚠️ **必须在 `fillTarnPlateau` 之后、紫晶柱光栅化之前调用**：
 *    · 晚于台地整形 → 祭坛地表替换掉广场的 tuff_bricks/smooth_stone_1；
 *    · 早于紫晶柱 → 柱基（后写胜）压在祭坛地表格上，复现用户存档的缺口形态。
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
