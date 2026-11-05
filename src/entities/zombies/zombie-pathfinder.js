// src/entities/zombies/zombie-pathfinder.js — 有界 BFS 寻路（v2.46 v2 修订）
//
// 同构层：无 DOM、无 three、不自建 Worker。
//
// ## 为什么需要这一层
//
// v1 的在线 AI 只在 9×9 窗口里让模型选方向 —— 实测 31 格宽的墙让 69 次决策全部耗在原地
// 横跳（60 秒净位移 0.7 格）：**模型永远看不到墙的尽头**，信息根本不在它眼前。局部信息缺失
// 无法靠措辞弥补，故「长距离可达性」必须由代码算（spec §2.7 / §3.10）。
//
// ## 与物理的关系
//
// 可走性**复用** `zombie-navigation.js`（红线 1）：一层台阶算可走（物理 step-up 会抬上去），
// 两格高算墙。写第二份判据会漂移成「规划得出、物理走不通」，而那种缺陷只能靠实玩发现。
//
// ## 非目标
//
// 不做跨层寻路（不搜上下楼梯）—— 三维搜索成本 ×几十，而当前玩法里丧尸追的是同一层平面上的
// 玩家。不做全图寻路 —— 半径 24 格有界，超出即 `truncated`（回落到 v1 的局部决策）。
import { PATHFIND, DIRECTION_ORDER, ZOMBIE, ZOMBIE_MAX_STEP } from './zombie-config.js';
import { AABB_EPSILON, aabbCollidesAt, zombieStepUpY } from './zombie-navigation.js';

/**
 * 缺省的可走性体型 = **丧尸**（v2.61 参数化后的缺省值，保证零回归）。
 *
 * ⚠️ **任何新增调用方都应该显式传 `box`**；缺省值只为「既有丧尸调用一行不改」。
 * 复用同一份 A\* 而不是写第二份，是红线 1 的要求 —— 两份寻路的漂移形态是
 * 「一个实体绕得过去、另一个绕不过去」，而且只能靠实玩发现。
 */
export const DEFAULT_BOX = Object.freeze({
  halfWidth: ZOMBIE.width / 2,
  height: ZOMBIE.height,
  maxStep: ZOMBIE_MAX_STEP,
});

/**
 * 8 邻接增量 `[dx, dz]`，**与 `DIRECTION_ORDER` 严格同序**
 * （north, north_east, east, south_east, south, south_west, west, north_west）。
 * ⚠️ 两份常量必须同序，否则方向名会张冠李戴（单测钉住）。
 */
const NEIGHBORS = Object.freeze([
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
]);

/**
 * 把一步增量翻译成方向名（与 `DIRECTION_VECTORS` 的键一致）。
 * 非 8 向对齐（含原地）返回 null。
 * @param {number} dx x 增量 @param {number} dz z 增量
 * @returns {string|null}
 */
export function directionNameOf(dx, dz) {
  for (let i = 0; i < NEIGHBORS.length; i++) {
    if (NEIGHBORS[i][0] === dx && NEIGHBORS[i][1] === dz) return DIRECTION_ORDER[i];
  }
  return null;
}

/**
 * 该格能否站（一层台阶算能站 —— 与物理 step-up 同口径）。
 *
 * ⚠️ **快路径是载荷性的**（实测：BFS 最坏单次 0.75ms，其中 20% 花在 `getBlockId`）。
 * 绝大多数格是「空 + 脚下实心」，那种情况下完整 AABB 扫描（丧尸 3×3×2 = 6~18 格、
 * 焰魔 3×3×4 = 12~48 格，每格都从 `columnKey` 字符串查起）完全是浪费。
 * 先用几次 `isSolid` 判掉这个常见情形，只有需要时才走完整 AABB —— 结果**逐位等价**。
 *
 * ⚠️⚠️ **层数由 AABB 跨度算，不能写死 2**（v2.61）：
 * 旧版注释写「丧尸高 1.8、脚底 y 的整数部分是 by ⇒ 占据 by 与 by+1 两层」，那是**丧尸专属**的
 * 推导。焰魔 height 3.25 ⇒ 占 `by … by+3` **四层**，写死 2 会让快路径把一个 2 格高的门洞判成
 * 「可走」（它只检查了下面两层）—— 形态是「规划得出、物理走不通」，正是本文件头部警告的那类漂移。
 *
 * `spans = floor(y + height − ε) − floor(y) + 1` 与 `aabbCollidesAt` 的 `y1` 用**同一个** ε
 * （`AABB_EPSILON`，从 `zombie-navigation` 导出），故快路径通过 ⇔ AABB 不碰撞。
 * 整数 `y` 且 `height` 1.8 时 `spans === 2`，与改动前**逐位相同**。
 *
 * @param {object} world @param {number} x @param {number} y @param {number} z 格坐标
 * @param {{halfWidth: number, height: number, maxStep: number}} box 可走性体型
 */
function standable(world, x, y, z, box) {
  const by = Math.floor(y);
  const spans = Math.floor(y + box.height - AABB_EPSILON) - by + 1;
  if (!world.isSolid(x, by, z) && world.isSolid(x, by - 1, z)) {
    let clear = true;
    for (let i = 1; i < spans; i++) {
      if (world.isSolid(x, by + i, z)) { clear = false; break; }
    }
    if (clear) return true;
  }
  if (!aabbCollidesAt(world, x + 0.5, y, z + 0.5, box.halfWidth, box.height)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= box.maxStep
    && !aabbCollidesAt(world, x + 0.5, lifted, z + 0.5, box.halfWidth, box.height);
}

/**
 * 把 `prev` 链回溯成一串**格坐标**（起点之后 → 终点，含终点）。
 * 仅供 `PathCache` 判断「丧尸是否仍在这条路线上」；导航层不消费它。
 */
function collectPath(prev, endKey, startKey, keyToXZ) {
  const out = [];
  let k = endKey;
  for (let guard = 0; guard < PATHFIND.maxExplored; guard++) {
    if (k === startKey) break;
    out.push(keyToXZ(k));
    const p = prev.get(k);
    if (p === undefined) break;
    k = p;
  }
  out.reverse();     // 起点 → 终点
  return out;
}

/**
 * 当前格是否仍在「缓存路径的剩余段」上，**且计划的第一步仍然朝向目标**。
 *
 * ## 两个判据缺一不可（各修一种实测 bug）
 *
 * ① **路径附近容忍 `nearRadius` 格** —— 解决「拥挤时命中率崩塌」：
 *    20 只丧尸互相推挤时位置每帧微动（±0.x 格），精确匹配路径格几乎永不命中。
 *    实测（1 格宽窄门 + 20 只）：命中率掉到 **10.1%**、13355 次真实 A\*。
 * ② **必须校验「计划方向仍在靠近目标」** —— 解决「绕过障碍后又往回走」（v2.49 修过的 bug）：
 *    上一版为了修它改成精确匹配，结果牺牲了命中率。真正的原因是**旧的模糊判据只看距离、
 *    不看方向**：丧尸走到 (41,29)（早已越过墙端、真实方向是西南）时，因为离旧路径点
 *    「1 格内」而继续朝东北走。
 *
 * ⇒ 现在同时要求「在路径附近」**和**「计划首步让到目标的距离不增加」：
 *    - 拥挤微动 → 仍在附近、方向也对 → 命中（拿回命中率）
 *    - 越过墙端该转向了 → 旧计划首步会让距离变大 → **立刻重算**（不会回头）
 *
 * @param {object} entry 缓存条目 @param {number} x @param {number} z 当前格（整数）
 * @param {number} gx @param {number} gz 目标格
 */
function onCachedPath(entry, x, z, gx, gz) {
  const path = entry.path;
  if (!path || path.length === 0) return false;
  // ① 在路径剩余段的 `nearRadius` 格内
  let near = false;
  for (let i = 0; i < path.length; i++) {
    if (Math.abs(path[i][0] - x) <= entry.nearRadius
      && Math.abs(path[i][1] - z) <= entry.nearRadius) { near = true; break; }
  }
  if (!near) return false;
  // ② 计划首步必须不增加「到目标的距离」（否则说明玩家方向已经变了）
  const step = entry.result.nextStep;
  if (!step) return true;
  const cur = Math.hypot(x - gx, z - gz);
  const next = Math.hypot(x + step[0] - gx, z + step[1] - gz);
  return next <= cur + 1e-9;
}

/**
 * 从 `from` 向 `to` 做**有界 A\***，返回路径上的第一个地标。
 *
 * ⚠️⚠️ **必须是 A\* 而不是纯 BFS**（v2.49 修正，用户实测 bug 的根因）：
 * 纯 BFS 是**等代价**搜索，8 邻接每步都算 1 —— 它只保证「步数最少」，不保证「方向合理」。
 * 目标在 10 格内时，往往有**多条等步数路径**，BFS 按邻接顺序任选一条
 * （顺序 N,NE,E,SE,S,SW,W,NW），于是选中「先贴着墙走、再拐向玩家」那条。
 * 实测形态（用户 2026-11-04：「绕过障碍后已经可以直线走向玩家，但丧尸直接回头原路返回」）：
 * 丧尸在 (288,170)、玩家在 (283,168)，NW `(287,169)` 的曼哈顿距离只有 5（最靠近玩家），
 * 但 BFS 先探到的却是 SW `(287,171)`（曼哈顿 7，**背离玩家**）—— 因为那条路的总步数同样是 4。
 * 观感就是「绕出墙端后又往反方向走」。
 * A* 加欧氏启发后选的是 h 最小的方向（NW 的 h=4.12 vs SW 的 h=5.00），路径自然朝向玩家。
 *
 * 语义：
 * - 只搜**水平面**（`y` 固定为 `from[1]`），不跨层；
 * - 终点 = 与目标**切比雪夫距离 ≤ 1** 的格（不需要精确踩到玩家格 —— 那格常被玩家身体占着，
 *   判不到「可站」）；
 * - 半径上限用**切比雪夫距离**（与 8 邻接步数一致），超出即停并置 `truncated`；
 * - 邻接顺序固定 → 同输入同路径（红线 2）。
 *
 * @param {{isSolid(x:number,y:number,z:number):boolean}} world
 * @param {number[]} from 实体脚底 `[x, y, z]`
 * @param {number[]} to 玩家脚底 `[x, y, z]`
 * @param {{maxRadius?: number, box?: {halfWidth: number, height: number, maxStep: number}}} [opts]
 *   `box` = 可走性体型（半宽 / 高 / 能上的台阶高度），缺省 `DEFAULT_BOX`（丧尸）。
 *   ⚠️ **高度真的改变结果**：同一格 2 格高门洞对丧尸可走、对焰魔（3.25 高）不可走。
 * @returns {{reachable: boolean, nextStep: [number, number]|null, pathLength: number,
 *            explored: number, truncated: boolean}}
 */
export function planStep(world, from, to, { maxRadius = PATHFIND.maxRadius, box = DEFAULT_BOX } = {}) {
  const sx = Math.floor(from[0]);
  const sz = Math.floor(from[2]);
  const y = from[1];
  const gx = Math.floor(to[0]);
  const gz = Math.floor(to[2]);
  const cap = PATHFIND.maxExplored;
  // ⚠️ **数字 key（不是字符串）**：实测字符串模板 key 的 Map 查找比数字慢 4~5 倍
  // （0.019µs vs 0.004µs），而 BFS 每格要做 8 次查找 —— 24 格 × 2401 格会把它放大到毫秒级
  // （实测字符串版最坏 1.18ms，数字版见下方 measured 注释）。
  // 坐标范围是 `[s-24, s+24]`，用 `(x + OFFSET) * SPAN + (z + OFFSET)` 编码成非负整数。
  const OFFSET = 1 << 20;          // 远大于任何世界坐标偏移
  const SPAN = 1 << 22;
  const keyOf = (x, z) => (x + OFFSET) * SPAN + (z + OFFSET);
  const keyToXZ = (k) => [Math.floor(k / SPAN) - OFFSET, (k % SPAN) - OFFSET];

  // 已在终点范围内：可达、无下一步
  if (Math.max(Math.abs(sx - gx), Math.abs(sz - gz)) <= 1) {
    return { reachable: true, nextStep: null, pathLength: 0, explored: 0, truncated: false };
  }
  // ⚠️ **目标在半径外是常态**（玩家离丧尸 30~60 格很常见），不能因此判「不可达」——
  // 那会让丧尸在远离玩家时完全不寻路（`truncated=true` → 回落直追）。
  // 语义改为：**朝目标方向走到半径内「离目标最近的可达格」**，再从那格给出第一步。
  // 这是 BFS 的天然行为（探索前沿就是「朝目标扩散」），只是终点判据要放宽。
  const goalOutOfRadius = Math.max(Math.abs(sx - gx), Math.abs(sz - gz)) > maxRadius;

  const prev = new Map();           // key → 父节点 key
  const startKey = keyOf(sx, sz);
  const seen = new Set([startKey]);
  /** 半径外模式：记录「离目标最近的已探索格」 */
  let best = null;
  const distToGoal = (x, z) => Math.hypot(x - gx, z - gz);
  // **优先队列**（按 `f = g + h` 升序）。用「两个并行数字数组 + 每次线性取最小」而不是
  // 二叉堆：搜索域上限 2401 格、队列实际长度几十到几百（A* 收敛快），
  // 线性扫描的常数比维护堆更小，且零分配（堆节点要建对象）。
  // ⚠️ 仍用并行数组而非 `[x, z]` 元组：避免每格分配一个小数组。
  const qx = [sx];
  const qz = [sz];
  const qf = [0];
  /** g 值（从起点走过来的实际步数）—— 判「已有更短路径」用 */
  const gScore = new Map([[startKey, 0]]);
  let explored = 0;
  let truncated = false;

  while (qx.length > 0) {
    if (explored >= cap) { truncated = true; break; }
    // 取 f 最小的那一项（线性扫描；队尾交换删除，O(1) 移除）
    let bi = 0;
    for (let i = 1; i < qf.length; i++) if (qf[i] < qf[bi]) bi = i;
    const cx = qx[bi];
    const cz = qz[bi];
    const cg = gScore.get(keyOf(cx, cz)) ?? 0;
    qx[bi] = qx[qx.length - 1];
    qz[bi] = qz[qz.length - 1];
    qf[bi] = qf[qf.length - 1];
    qx.pop(); qz.pop(); qf.pop();
    explored++;
    const curKey = keyOf(cx, cz);
    if (goalOutOfRadius) {
      // 半径外：把「探索到的前沿」里离目标最近的那格当作阶段终点
      const d = distToGoal(cx, cz);
      if (best === null || d < best.d) best = { x: cx, z: cz, key: curKey, d };
    }
    if (!goalOutOfRadius && Math.max(Math.abs(cx - gx), Math.abs(cz - gz)) <= 1) {
      // 回溯到「起点之后的第一步」
      let k = curKey;
      let steps = 0;
      for (let guard = 0; guard < cap; guard++) {
        const p = prev.get(k);
        if (p === undefined) break;              // k 就是起点
        steps++;
        if (p === startKey) {
          const [nx, nz] = keyToXZ(k);
          // `_path` = 「起点之后要依次踩的格」（供 `PathCache` 判断「丧尸是否仍在路线上」）。
          // ⚠️ 它不是第二份权威：只是这份 BFS 结果的附带产物，调用方（导航）只读 `nextStep`。
          return {
            reachable: true,
            nextStep: [nx - sx, nz - sz],
            pathLength: steps,
            explored,
            truncated: false,
            _path: collectPath(prev, curKey, startKey, keyToXZ),
          };
        }
        k = p;
      }
      break;
    }
    for (let i = 0; i < NEIGHBORS.length; i++) {
      const nx = cx + NEIGHBORS[i][0];
      const nz = cz + NEIGHBORS[i][1];
      const k = keyOf(nx, nz);
      if (seen.has(k)) continue;
      if (Math.max(Math.abs(nx - sx), Math.abs(nz - sz)) > maxRadius) { truncated = true; continue; }
      if (!standable(world, nx, y, nz, box)) continue;
      seen.add(k);
      prev.set(k, curKey);
      // 斜向按 √2 计代价（8 邻接的真实几何距离）；启发 = 欧氏距离（可采纳、一致）
      const stepCost = (NEIGHBORS[i][0] !== 0 && NEIGHBORS[i][1] !== 0) ? Math.SQRT2 : 1;
      const g = cg + stepCost;
      gScore.set(k, g);
      qx.push(nx);
      qz.push(nz);
      qf.push(g + distToGoal(nx, nz));
    }
  }
  // 半径外模式：用「离目标最近的前沿格」回溯第一步
  if (goalOutOfRadius && best !== null && (best.x !== sx || best.z !== sz)) {
    let k = best.key;
    let steps = 0;
    for (let guard = 0; guard < cap; guard++) {
      const p = prev.get(k);
      if (p === undefined) break;
      steps++;
      if (p === startKey) {
        const [nx, nz] = keyToXZ(k);
        return {
          reachable: true,
          nextStep: [nx - sx, nz - sz],
          pathLength: steps,
          explored,
          // 目标仍在半径外 —— 但「沿着这条路继续走」是对的，不该判 truncated 让调用方降级
          truncated: false,
          _path: collectPath(prev, best.key, startKey, keyToXZ),
        };
      }
      k = p;
    }
  }
  return { reachable: false, nextStep: null, pathLength: 0, explored, truncated };
}

/**
 * 带缓存的规划器（v2.46 v2，Review Focus 5 的落点）。
 *
 * **为什么需要**：`planStep` 一次最坏要探索 2401 格（目标不可达时必然跑满），
 * 实测真实地形 p90 **1.09ms**、20 只 × 2Hz 摊平 **10.9ms/秒** —— 那是 120Hz 帧预算的 9%。
 *
 * **为什么不能用「格级坐标」做缓存键**（第一版就是这么写的，实测命中率 **0%**）：
 * 丧尸 1.2 格/秒 × 0.5 秒决策周期 = 每次决策移动 **0.6 格** ⇒ 几乎每次都会跨格。
 *
 * **正确判据 = 「丧尸仍在这条路线上」+ 时效**（v2.49 修正，前一版是错的）：
 * - 目标格变了 → 立刻重算（玩家跑掉了，旧路线无意义）；
 * - **当前位置必须在缓存路径的「尚未走过」那一段里**（或紧邻它一格内）→ 复用；
 * - 距离上一次计算超过 `maxAgeMs` → 重算（兜底，防世界改动导致路线过期）。
 *
 * ⚠️⚠️ **前一版用「离旧地标 ≤ stickyRadius 格」是错的，会复现一个真实 bug**
 * （用户 2026-11-04 实测：「绕过障碍之后已经可以直线走向玩家了，但丧尸直接回头原路返回」）：
 * 那个判据只看「离上一条路径的地标有多远」，**完全不看玩家方向是否已经变了**。
 * 丧尸绕行时第一次写入的 landmark 在墙端外侧，于是它被允许沿旧方向多走最多 6 格 ——
 * 而它早就该在墙端转向玩家了。实测复现（x∈[20,40]/z=30 的墙，绕东端）：
 * 位置 (39,31) 时缓存给 `(1,-1)`「继续东北」，而实时 `planStep` 已经给 `(1,0)`「正东」。
 * 偏差累积到能看出来的程度，就是用户描述的「绕过障碍后又往回走」。
 *
 * **现在的判据是「路径前缀匹配」**：缓存里存完整的 `_path`（起点→终点的格序列），
 * 命中条件 = 当前格出现在该序列里。丧尸一旦偏离路线（例如墙端之后该转向了），
 * 当前格就不再在「剩余那段」里 → 立刻重算。这既保留了缓存收益（沿路前进时命中率仍高），
 * 又保证了**任何方向变化都在一个决策周期内被发现**。
 *
 * 代价 = 最坏情况下丧尸按旧路线走 1 格，下个决策周期自纠。
 * 且 `steerIntent`（每帧跑）会挡住「撞进新放的方块」。
 */
export class PathCache {
  /** @param {{maxAgeMs?: number}} [opts] */
  constructor({ maxAgeMs = 4000, nearRadius = 1 } = {}) {
    this.maxAgeMs = maxAgeMs;
    /**
     * 「仍在路线上」的水平容差（格）。
     * ⚠️ **不是越大越好**：太大就会允许丧尸沿旧方向走很远（那正是 v2.49 修的「回头」bug）；
     * 太小则拥挤时命中率崩塌（实测精确匹配在窄门场景只有 10.1%）。
     * **1 是实测标定值**（固定地形、1 格宽窄门、20 只丧尸的对照）：
     * | nearRadius | 到达 | 命中率 | 真实 A\* |
     * |---|---|---|---|
     * | 0（精确） | 18/20 | 7.5% | 13674 |
     * | **1** | **18/20** | **66.1%** | 5021 |
     * | 2 | 17/20 | 69.2% | 4545 |
     * ⇒ 取 1：到达率与精确匹配**完全相同**，而真实 A\* 少 63%。
     * 取 2 只多 3% 命中率却丢了一只（大容差让丧尸沿旧路径走进墙里）。
     */
    this.nearRadius = nearRadius;
    /** @type {Map<string, object>} agentId → 缓存条目 */
    this._cache = new Map();
    /** @type {{hits: number, misses: number}} */ this._stats = { hits: 0, misses: 0 };
  }

  /**
   * 取（或计算）一次规划结果。
   * @param {object} world
   * @param {number[]} from 实体脚底 [x, y, z]
   * @param {number[]} to 玩家脚底 [x, y, z]
   * @param {{maxRadius?: number, agentId?: string, nowMs?: number,
   *          box?: {halfWidth: number, height: number, maxStep: number}}} [opts]
   *   `agentId` 用于把缓存按实体隔离（缺省 `__default__`）；`box` 转发给 `planStep`
   * @returns {ReturnType<typeof planStep>}
   */
  plan(world, from, to, opts = {}) {
    const radius = opts.maxRadius ?? PATHFIND.maxRadius;
    const box = opts.box ?? DEFAULT_BOX;
    const id = opts.agentId ?? '__default__';
    const nowMs = opts.nowMs ?? 0;
    const fx = Math.floor(from[0]);
    const fz = Math.floor(from[2]);
    const prev = this._cache.get(id);
    if (prev !== undefined
      && prev.radius === radius
      // ⚠️ **不可达的结果绝不缓存**：玩家随时可能拆墙/挖通道，缓存 4 秒会让丧尸在墙被拆开后
      // 仍然"装作没路"最多 4 秒（实测：拆墙后 1050ms 仍返回 reachable=false，要到 6000ms
      // 超时才恢复）。可达的路径可以缓存（走的过程中墙不会变），不可达的必须每次重算。
      && prev.result.reachable === true
      && prev.goalX === Math.floor(to[0]) && prev.goalZ === Math.floor(to[2])
      && prev.at !== undefined && (nowMs - prev.at) <= this.maxAgeMs
      && onCachedPath(prev, fx, fz, prev.goalX, prev.goalZ)) {
      this._stats.hits++;
      prev.at = nowMs;
      // 把「已经站在的那格」从路径头部裁掉（只是性能优化：路径会越走越短）
      while (prev.path && prev.path.length > 1
        && prev.path[0][0] === fx && prev.path[0][1] === fz) {
        prev.path.shift();
      }
      return prev.result;
    }
    this._stats.misses++;
    const result = planStep(world, from, to, { maxRadius: radius, box });
    this._cache.set(id, {
      result, radius, at: nowMs,
      goalX: Math.floor(to[0]), goalZ: Math.floor(to[2]),
      path: result._path ?? null,
      nearRadius: this.nearRadius,
    });
    return result;
  }

  /**
   * @param {string} id
   * @returns {ReadonlyArray<{x: number, z: number}>|null} 只读测试钩子：缓存的剩余路径
   */
  cachedPathOf(id) {
    return this._cache.get(id)?.path ?? null;
  }

  /** 清空（世界结构大幅变化 / 关闭在线 AI / 丧尸回收时调） */
  clear() { this._cache.clear(); }

  /** 回收某只丧尸的缓存条目 */
  forget(agentId) { this._cache.delete(agentId); }

  /** @returns {{hits: number, misses: number, size: number, hitRate: number}} */
  debugState() {
    const total = this._stats.hits + this._stats.misses;
    return {
      hits: this._stats.hits,
      misses: this._stats.misses,
      size: this._cache.size,
      hitRate: total === 0 ? 0 : this._stats.hits / total,
    };
  }
}
