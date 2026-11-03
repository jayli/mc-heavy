// src/entities/zombies/zombie-ai-view.js — 在线 AI 的「世界 → state」纯函数层
//
// 同构层：**无 DOM、无 three、不新建 Worker**（`npm run check:arch` 静态门守）。
// 本模块是四件事的唯一实现（红线 1）：
//   ① `DIRECTION_VECTORS` —— 8 个候选方向的坐标增量（题面选项名与速度向量的唯一映射）
//   ② 地面窗口采样 `sampleGroundWindow` —— 「丧尸周围的地面矩阵」的唯一来源
//   ③ 候选事实 `buildCandidateSteps` —— 代码算的可走性 / 走廊长度 / 访问次数
//   ④ state 组装 `buildJevState` —— 送给模型的全部环境信息
//
// ⚠️ **可走性一律复用 `zombie-navigation.js` 的 `zombieCollidesAt` / `zombieStepUpY`**，
// 不写第二份 AABB 采样（两份会漂移成「模型说能走、物理撞墙」，静默且只能靠实玩发现）。
//
// ⚠️ **为什么「可走性」必须是代码算的，不能问模型**（spec §2.2 实测）：把 8 个方向
// （含墙）全交给 Jev 选时，它 4/12 次选了墙；先由代码筛掉不可走的、只把可走方向列成
// 选项后，0/12 次非法。官方 `model-jaggedness` 也把「计数 / 数学」列为已知弱点。
import { JEV_AI, ZOMBIE_MAX_STEP } from './zombie-config.js';
import { zombieCollidesAt, zombieStepUpY } from './zombie-navigation.js';
import { SITUATION, WINDOW_LEGEND } from './zombie-jev-prompts.js';

/** 8 个候选方向：[dr, dc] = [z 增量, x 增量]（dr<0 为 north，dc>0 为 east） */
export const DIRECTION_VECTORS = Object.freeze({
  north: Object.freeze([-1, 0]),
  north_east: Object.freeze([-1, 1]),
  east: Object.freeze([0, 1]),
  south_east: Object.freeze([1, 1]),
  south: Object.freeze([1, 0]),
  south_west: Object.freeze([1, -1]),
  west: Object.freeze([0, -1]),
  north_west: Object.freeze([-1, -1]),
});

/**
 * 格键（负坐标按 floor 归一）。
 * ⚠️ 不用 `x % 16` 那类取余写法 —— JS 的 `%` 对负数返回负值，会让负坐标的键分裂成两份
 * （CLAUDE.md 已记的「坐标类判据一律用非负取模或直接按足迹判」同源教训）。
 */
export function cellKey(x, z) {
  return `${Math.floor(x)},${Math.floor(z)}`;
}

/**
 * 取（或创建）某只丧尸的旅行记忆（spec §3.4）。
 * @param {Map<string, object>} memoryMap id → 记忆
 * @param {string} id
 */
export function memoryFor(memoryMap, id) {
  let mem = memoryMap.get(id);
  if (!mem) {
    mem = { visits: new Map(), trail: [], deadEnds: new Set(), lastDecision: null };
    memoryMap.set(id, mem);
  }
  return mem;
}

/**
 * 记录一次「站在 (x,z) 格上」。
 *
 * `visits` 是 LRU（Map 的插入序）：超上限时删**最早插入**的键。
 * ⚠️ **不淘汰 `deadEnds`** —— 死胡同是地图性质（那格永远通向死路），与「最近走过哪些格」无关。
 * ⚠️ **记忆是载荷性的**（spec §2.4 实测）：去掉 `visits` 后，螺旋与长迷宫双双退化成
 * 无限绕圈（59 步不出）；加上后两者都通。故这里不是「锦上添花的上下文」。
 */
export function noteVisit(mem, x, z) {
  const k = cellKey(x, z);
  mem.visits.set(k, (mem.visits.get(k) ?? 0) + 1);
  mem.trail.push([Math.floor(x), Math.floor(z)]);
  if (mem.trail.length > JEV_AI.maxTrail) {
    mem.trail.splice(0, mem.trail.length - JEV_AI.maxTrail);
  }
  while (mem.visits.size > JEV_AI.maxVisits) {
    const oldest = mem.visits.keys().next().value;
    mem.visits.delete(oldest);
  }
}

/**
 * 某格（脚底高度 y）能不能站 —— 一格台阶算能站（物理 step-up 会抬上去）。
 *
 * **唯一实现**：窗口采样与候选事实都调它（红线 1）。判据全部复用
 * `zombieCollidesAt` / `zombieStepUpY` / `ZOMBIE_MAX_STEP`，与丧尸物理同源 ——
 * 两份判据会漂移成「模型以为能走、物理撞墙」。
 */
function standableAt(world, bx, y, bz) {
  const x = bx + 0.5;
  const z = bz + 0.5;
  if (!zombieCollidesAt(world, x, y, z)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, x, lifted, z);
}

/**
 * 采样丧尸周围的地面窗口（**用户要的「地面矩阵」**）。
 *
 * 语义：
 * - 边长 `JEV_AI.windowSize`（9），丧尸脚底所在格在**正中**标 `Z`；
 * - 玩家在窗口范围内则标 `P`（优先于可走性判断，方便模型对齐方位）；
 * - 可走 → `.`；不可走 → `#`；
 * - **世界未加载的 column → `#`**（有意与墙同码：对丧尸而言同样是「过不去」）。
 *   ⚠️ 这条已写进 `WINDOW_LEGEND`（「or terrain that has not loaded yet」），否则模型会把
 *   加载边缘当成真墙而莫名改道。
 *
 * @param {{isSolid(x:number,y:number,z:number):boolean, hasColumn(cx:number,cz:number):boolean}} world
 * @param {number[]} position 丧尸脚底 [x, y, z]
 * @param {number[]} playerPosition 玩家脚底 [x, y, z]
 * @returns {string[]} `windowSize` 行，每行 `windowSize` 字符
 */
export function sampleGroundWindow(world, position, playerPosition) {
  const n = JEV_AI.windowSize;
  const half = (n - 1) / 2;
  const [xc, y, zc] = position;   // position 是 [x, y, z]
  const zx = Math.floor(xc);
  const zz = Math.floor(zc);
  const px = Math.floor(playerPosition[0]);
  const pz = Math.floor(playerPosition[2]);
  const canCheckColumn = typeof world?.hasColumn === 'function';
  const rows = [];
  for (let dr = -half; dr <= half; dr++) {
    let line = '';
    for (let dc = -half; dc <= half; dc++) {
      const bx = zx + dc;
      const bz = zz + dr;
      if (dr === 0 && dc === 0) { line += 'Z'; continue; }
      if (bx === px && bz === pz) { line += 'P'; continue; }
      if (canCheckColumn && !world.hasColumn(Math.floor(bx / 16), Math.floor(bz / 16))) {
        line += '#';
        continue;
      }
      line += standableAt(world, bx, y, bz) ? '.' : '#';
    }
    rows.push(line);
  }
  return rows;
}
