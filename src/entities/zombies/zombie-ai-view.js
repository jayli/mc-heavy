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
import { directionNameOf, planStep } from './zombie-pathfinder.js';

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

/**
 * 方位文案（题面与选项描述共用）。from/to 是 `[x, z]`。
 *
 * ⚠️ **只说方位不给坐标**：坐标是绝对值，进 state 既不必要、也让模型更难对齐
 * （它看不到丧尸实际站在世界的哪一格，只会被数字干扰）。
 */
export function bearingWords(from, to) {
  const dz = to[1] - from[1];
  const dx = to[0] - from[0];
  const ns = dz < 0 ? 'north' : dz > 0 ? 'south' : '';
  const ew = dx < 0 ? 'west' : dx > 0 ? 'east' : '';
  return [ns, ew].filter(Boolean).join(' and ') || 'the same square';
}

/** 沿某方向连续可站的格数（最多 cap） */
function openGroundAhead(world, bx, y, bz, dr, dc, cap = 16) {
  let n = 0;
  for (let k = 1; k <= cap; k++) {
    if (!standableAt(world, bx + dc * k, y, bz + dr * k)) break;
    n++;
  }
  return n;
}

/** 某格「除来路外的可走方向数」（死胡同信号） */
function exitsBesides(world, bx, y, bz, cameDr, cameDc) {
  let n = 0;
  for (const [, [dr, dc]] of Object.entries(DIRECTION_VECTORS)) {
    if (bx + dc === bx + cameDc && bz + dr === bz + cameDr) continue;
    if (standableAt(world, bx + dc, y, bz + dr)) n++;
  }
  return n;
}

/**
 * 某格周围（含自身，3×3）能站的格数。
 *
 * 用途 = 「进去之后还有多大活动空间」：凹角/U 底这一带只有 2~4，开阔地是 9。
 * ⚠️ **不要用「除来路外的出口数」代替它**：U 底中央那格的出口数也是 3（左/右/后），
 * 但走到那儿之后仍然出不去 —— 模型看不出「空间在收窄」。
 */
function roomAround(world, bx, y, bz) {
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (standableAt(world, bx + dx, y, bz + dz)) n++;
    }
  }
  return n;
}

/**
 * 沿「朝玩家」的直线方向连续可走多少格（上限 16），以及玩家是否落在这段直线上。
 *
 * @returns {{walkable_steps_toward_player: number, player_is_on_that_line: boolean}}
 */
function describePathToPlayer(world, bx, y, bz, px, pz) {
  let ddx = px - bx;
  let ddz = pz - bz;
  const len = Math.hypot(ddx, ddz);
  if (len < 0.5) return { walkable_steps_toward_player: 0, player_is_on_that_line: true };
  ddx /= len;
  ddz /= len;
  let n = 0;
  let sawPlayer = false;
  let lastKey = `${bx},${bz}`;
  for (let k = 1; k <= 16; k++) {
    const cx = bx + Math.round(ddx * k);
    const cz = bz + Math.round(ddz * k);
    // ⚠️ **同一格只数一次**：斜向 `Math.round` 会让相邻 k 落在同一格（实测 30° 射线上
    // 每 5 步有 2 次重复），不跳过会把「能通几格」虚高——而模型是拿这个数判「该直走还是绕」。
    const key = `${cx},${cz}`;
    if (key === lastKey) continue;
    lastKey = key;
    if (cx === px && cz === pz) { sawPlayer = true; break; }
    if (!standableAt(world, cx, y, cz)) break;
    n++;
  }
  return { walkable_steps_toward_player: n, player_is_on_that_line: sawPlayer };
}

/** 标记死胡同（地图性质，不随 LRU 淘汰） */
export function markDeadEnd(mem, x, z) {
  mem.deadEnds.add(cellKey(x, z));
}

/**
 * 计算候选方向事实（spec §3.5）。**只含可走方向**。
 *
 * ⚠️ **这是「可走性由代码算」的落点**（spec §2.2）：把墙也列成选项时，模型 4/12 次选了墙；
 * 只列可走方向后 0/12 次非法。故这里不是「过滤一下更好看」，而是模型不擅长的部分由代码兜住。
 *
 * @param {object} world @param {number[]} position 丧尸脚底 [x,y,z]
 * @param {number[]} playerPosition 玩家脚底 [x,y,z] @param {object} memory
 * @returns {Record<string, object>} 键为方向名；空对象 = 四面皆不可走
 */
export function buildCandidateSteps(world, position, playerPosition, memory, plannedDirection = null) {
  const [xb, y, zb] = position;
  const bx = Math.floor(xb);
  const bz = Math.floor(zb);
  const px = Math.floor(playerPosition[0]);
  const pz = Math.floor(playerPosition[2]);
  const hereDist = Math.hypot(bx - px, bz - pz);
  const out = {};
  for (const [name, [dr, dc]] of Object.entries(DIRECTION_VECTORS)) {
    const nx = bx + dc;
    const nz = bz + dr;
    if (!standableAt(world, nx, y, nz)) continue;
    const afterDist = Math.hypot(nx - px, nz - pz);
    out[name] = {
      direction: name.replace('_', ' '),
      player_lies_toward: bearingWords([nx, nz], [px, pz]),
      straight_line_distance_after_step: `${afterDist.toFixed(1)} meters`,
      closer_or_farther: afterDist < hereDist - 0.05 ? 'closer to the player'
        : afterDist > hereDist + 0.05 ? 'farther from the player' : 'about the same distance',
      open_ground_ahead: `${openGroundAhead(world, bx, y, bz, dr, dc)} meters`,
      other_ways_out_after_the_step: exitsBesides(world, nx, y, nz, dr, dc),
      times_already_visited: memory.visits.get(cellKey(nx, nz)) ?? 0,
      marked_dead_end: memory.deadEnds.has(cellKey(nx, nz)),
      // **「走开之后还能不能继续走」** —— 这一条是 U 形/凹角的关键信号。
      // 只给「这一步可走」不够：U 底那两格都可走，但进去之后两侧都是墙，
      // 丧尸会左右横跳（实测：模型连续 13 次都选 west，位置在 0.1 格内来回摆动）。
      // 判据 = 该落点周围（含自身，8 邻域）可站格数。凹角里这个数很小。
      room_around_after_the_step: roomAround(world, nx, y, nz),
      // **这一步是否延续代码规划出的路线**（v2）：模型不再需要自己发现绕行方向，
      // 只需判断「这个方向上有什么理由不照走」。见 spec §3.10.4。
      continues_planned_route: plannedDirection !== null && name === plannedDirection,
    };
  }
  return out;
}

/**
 * 组装送模型的完整 state（spec §3.5）。**「环境信息」的唯一权威。**
 *
 * 输出必须完全可 JSON 序列化（送网络的前提）—— 故这里不含 Map / Set / 函数。
 */
export function buildJevState(world, position, playerPosition, memory) {
  const [xb, y, zb] = position;
  const bx = Math.floor(xb);
  const bz = Math.floor(zb);
  const px = Math.floor(playerPosition[0]);
  const pz = Math.floor(playerPosition[2]);
  // **代码寻路**（v2，spec §3.10）：9×9 窗口半宽只有 4 格，模型看不到墙的尽头。
  // 长距离可达性必须由代码算 —— 实测 31 格宽的墙让纯窗口方案 69 次决策净位移 0.7 格。
  // ⚠️ `planStep` 不可达时（半径内绕不过去）**不改变候选表**：仍回落 v1 的局部决策，
  // 否则远处玩家会让丧尸完全站死（Review Focus 2）。
  const plan = planStep(world, position, playerPosition);
  const plannedDir = plan.reachable && plan.nextStep
    ? directionNameOf(plan.nextStep[0], plan.nextStep[1])
    : null;
  // 计划固化（Review Focus 4）：每 0.5 秒重算 BFS 时「往东绕」与「往西绕」常等长，
  // 不记住上一次的选择会让丧尸在两条等长路线间来回横跳。
  const walked = (memory.plan && memory.plan.direction === plannedDir)
    ? (memory.plan.walked ?? 0)
    : 0;
  return {
    situation: SITUATION,
    player_direction_from_zombie: bearingWords([bx, bz], [px, pz]),
    straight_line_distance_now: `${Math.hypot(bx - px, bz - pz).toFixed(1)} meters`,
    // **「照直朝玩家走能不能走通」** —— 这一条是「该直走还是该绕」的总开关。
    // ⚠️ 只给 `candidate_steps` 的 closer_or_farther 不够：墙把玩家挡在正前方时，
    // 「往墙里再挪半步」也是「更近」，模型会一直贴着墙磨（实测连续 10 次选 west）。
    // 判据 = 从丧尸格沿「朝玩家的方向」连续可走多少格（上限 16），以及玩家是否就在那一段里。
    path_to_player: describePathToPlayer(world, bx, y, bz, px, pz),
    steps_already_walked: Math.max(0, memory.trail.length - 1),
    ground_window: {
      rows: sampleGroundWindow(world, position, playerPosition),
      top_is: 'north',
      left_is: 'west',
      legend: WINDOW_LEGEND,
    },
    path_plan: {
      reachable_within_24_meters: plan.reachable,
      next_step_toward_player: plannedDir,
      path_length_in_steps: plan.pathLength,
      walked_along_this_plan: walked,
    },
    candidate_steps: buildCandidateSteps(world, position, playerPosition, memory, plannedDir),
  };
}

/**
 * 把模型答案翻译成**单位**速度向量（spec §3.7）。
 *
 * 三条失败 reason **逐条独立**（不合成一句「失败」—— 那是 spec §3.8 逐 reason 映射的口径）：
 * - `no-answer`：没回包 / 缺 `choice` 字段；
 * - `unknown-direction`：回了个不认识的字符串（模型幻觉）；
 * - `blocked-direction`：认识的方向，但**不在候选表里**（= 那一格现在不可走）。
 *
 * ⚠️ **候选表是唯一合法性依据**：`buildCandidateSteps` 已用物理判据筛过，「在表里」等价于
 * 「现在能走」。不在这里重新采样世界 —— 那会让「可走性」变成第二份判据。
 * ⚠️ **只给单位向量、不给速度大小**：速度上限的唯一权威是 `ZombieService._applyIntent` 的钳制
 * ＋ `ZOMBIE.speed`，本函数不复制一份。
 *
 * @param {object|null} answer `answers[QUESTION_ID]`
 * @param {Record<string, object>} candidateSteps
 * @returns {{ok: true, direction: string, vx: number, vz: number} | {ok: false, reason: string}}
 */
export function parseDirectionChoice(answer, candidateSteps) {
  const choice = answer?.choice;
  if (typeof choice !== 'string' || choice.length === 0) return { ok: false, reason: 'no-answer' };
  const vec = DIRECTION_VECTORS[choice];
  if (!vec) return { ok: false, reason: 'unknown-direction' };
  if (!candidateSteps || !(choice in candidateSteps)) return { ok: false, reason: 'blocked-direction' };
  const [dr, dc] = vec;            // dr = z 增量，dc = x 增量
  const len = Math.hypot(dr, dc);
  return { ok: true, direction: choice, vx: dc / len, vz: dr / len };
}
