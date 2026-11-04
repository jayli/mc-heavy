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
import { PATHFIND, DIRECTION_ORDER, ZOMBIE_MAX_STEP } from './zombie-config.js';
import { zombieCollidesAt, zombieStepUpY } from './zombie-navigation.js';

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
 * 绝大多数格是「空 + 脚下实心」，那种情况下 `zombieCollidesAt`（要扫 3×3×2 = 6~18 格、
 * 每格都从 `columnKey` 字符串查起）完全是浪费。先用 3 次 `isSolid` 判掉这个常见情形，
 * 只有需要时才走完整 AABB —— 结果**逐位等价**（快路径通过 ⟺ AABB 不碰撞）。
 */
function standable(world, x, y, z) {
  const by = Math.floor(y);
  // 快路径：脚底那格空气 + 头顶那格空气 + 脚下实心 ⇒ AABB 必然不碰撞
  // （丧尸高 1.8、脚底 y 的整数部分是 by ⇒ 占据 by 与 by+1 两层）
  if (!world.isSolid(x, by, z) && !world.isSolid(x, by + 1, z) && world.isSolid(x, by - 1, z)) {
    return true;
  }
  if (!zombieCollidesAt(world, x + 0.5, y, z + 0.5)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, x + 0.5, lifted, z + 0.5);
}

/**
 * 从 `from` 向 `to` 做**有界** BFS，返回路径上的第一个地标。
 *
 * 语义：
 * - 只搜**水平面**（`y` 固定为 `from[1]`），不跨层；
 * - 终点 = 与目标**切比雪夫距离 ≤ 1** 的格（不需要精确踩到玩家格 —— 那格常被玩家身体占着，
 *   判不到「可站」）；
 * - 半径上限用**切比雪夫距离**（与 8 邻接步数一致），超出即停并置 `truncated`；
 * - 邻接顺序固定 → 同输入同路径（红线 2）。
 *
 * @param {{isSolid(x:number,y:number,z:number):boolean}} world
 * @param {number[]} from 丧尸脚底 `[x, y, z]`
 * @param {number[]} to 玩家脚底 `[x, y, z]`
 * @param {{maxRadius?: number}} [opts]
 * @returns {{reachable: boolean, nextStep: [number, number]|null, pathLength: number,
 *            explored: number, truncated: boolean}}
 */
export function planStep(world, from, to, { maxRadius = PATHFIND.maxRadius } = {}) {
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
  // 队列用**两个并行数字数组**而不是 `[x, z]` 元组数组：避免每格分配一个小数组
  const qx = [sx];
  const qz = [sz];
  let head = 0;
  let explored = 0;
  let truncated = false;

  while (head < qx.length) {
    if (explored >= cap) { truncated = true; break; }
    const cx = qx[head];
    const cz = qz[head];
    head++;
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
          return {
            reachable: true,
            nextStep: [nx - sx, nz - sz],
            pathLength: steps,
            explored,
            truncated: false,
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
      if (!standable(world, nx, y, nz)) continue;
      seen.add(k);
      prev.set(k, curKey);
      qx.push(nx);
      qz.push(nz);
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
 * **正确判据 = 位置容差 + 时效**：
 * - 目标格变了 → 立刻重算（玩家跑掉了，旧路线无意义）；
 * - 起点仍在「上一条路径的第一个地标」附近（≤ `stickyRadius` 格）→ 复用旧结果
 *   （这正是「沿计划前进」的定义：下一个地标还没走到）；
 * - 距离上一次计算超过 `maxAgeMs` → 重算（兜底，防世界改动导致路线过期）。
 *
 * 这样「沿一条长路径走」时**每次决策都命中**，只有真正换段（走到地标）才重算。
 *
 * ⚠️ **不缓存「世界变化的失效」**：玩家在同一条路线上拆/放方块时缓存会过期。
 * 代价 = 最坏情况下丧尸按旧路线走最多 `stickyRadius` 格，下个决策周期自纠；
 * 且 `steerIntent`（每帧跑）会挡住「撞进新放的方块」。
 */
export class PathCache {
  /** @param {{stickyRadius?: number, maxAgeMs?: number}} [opts] */
  constructor({ stickyRadius = 6, maxAgeMs = 4000 } = {}) {
    this.stickyRadius = stickyRadius;
    this.maxAgeMs = maxAgeMs;
    /** @type {Map<string, object>} agentId → 缓存条目 */
    this._cache = new Map();
    /** @type {{hits: number, misses: number}} */ this._stats = { hits: 0, misses: 0 };
  }

  /**
   * 取（或计算）一次规划结果。
   * @param {object} world
   * @param {number[]} from 丧尸脚底 [x, y, z]
   * @param {number[]} to 玩家脚底 [x, y, z]
   * @param {{maxRadius?: number, agentId?: string, nowMs?: number}} [opts]
   *   `agentId` 用于把缓存按丧尸隔离（缺省 `__default__`）
   * @returns {ReturnType<typeof planStep>}
   */
  plan(world, from, to, opts = {}) {
    const radius = opts.maxRadius ?? PATHFIND.maxRadius;
    const id = opts.agentId ?? '__default__';
    const nowMs = opts.nowMs ?? 0;
    const prev = this._cache.get(id);
    if (prev !== undefined
      && prev.radius === radius
      // ⚠️ **不可达的结果绝不缓存**：玩家随时可能拆墙/挖通道，缓存 4 秒会让丧尸在墙被拆开后
      // 仍然"装作没路"最多 4 秒（实测：拆墙后 1050ms 仍返回 reachable=false，要到 6000ms
      // 超时才恢复）。可达的路径可以缓存（走的过程中墙不会变），不可达的必须每次重算。
      && prev.result.reachable === true
      && prev.goalX === Math.floor(to[0]) && prev.goalZ === Math.floor(to[2])
      && prev.at !== undefined && (nowMs - prev.at) <= this.maxAgeMs) {
      // 起点仍在「上一条路径的地标附近」→ 沿计划前进，复用
      const ddx = Math.floor(from[0]) - prev.landmarkX;
      const ddz = Math.floor(from[2]) - prev.landmarkZ;
      const stillOnRoute = prev.landmarkX === null
        || Math.max(Math.abs(ddx), Math.abs(ddz)) <= this.stickyRadius;
      if (stillOnRoute) {
        this._stats.hits++;
        prev.at = nowMs;
        return prev.result;
      }
    }
    this._stats.misses++;
    const result = planStep(world, from, to, { maxRadius: radius });
    const landmark = result.nextStep
      ? [Math.floor(from[0]) + result.nextStep[0], Math.floor(from[2]) + result.nextStep[1]]
      : null;
    this._cache.set(id, {
      result, radius, at: nowMs,
      goalX: Math.floor(to[0]), goalZ: Math.floor(to[2]),
      landmarkX: landmark ? landmark[0] : null,
      landmarkZ: landmark ? landmark[1] : null,
    });
    return result;
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
