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
