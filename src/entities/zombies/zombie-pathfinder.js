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

/** 该格能否站（一层台阶算能站 —— 与物理 step-up 同口径） */
function standable(world, x, y, z) {
  if (!zombieCollidesAt(world, x + 0.5, y, z + 0.5)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, x + 0.5, lifted, z + 0.5);
}

/** 从 prev 链回溯出「起点到 end 的步数」 */
function pathLenOf(prev, endKey, startKey, cap) {
  let n = 0;
  let cur = endKey;
  while (cur !== startKey && n < cap) {
    const p = prev.get(cur);
    if (!p) break;
    cur = `${p[0]},${p[1]}`;
    n++;
  }
  return n;
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
  const key = (x, z) => `${x},${z}`;

  // 已在终点范围内：可达、无下一步
  if (Math.max(Math.abs(sx - gx), Math.abs(sz - gz)) <= 1) {
    return { reachable: true, nextStep: null, pathLength: 0, explored: 0, truncated: false };
  }

  const prev = new Map();
  const seen = new Set([key(sx, sz)]);
  const queue = [[sx, sz]];
  let head = 0;
  let explored = 0;
  let truncated = false;

  while (head < queue.length) {
    if (explored >= cap) { truncated = true; break; }
    const [cx, cz] = queue[head++];
    explored++;
    if (Math.max(Math.abs(cx - gx), Math.abs(cz - gz)) <= 1) {
      // 回溯到「起点之后的第一步」
      let cur = [cx, cz];
      for (let guard = 0; guard < cap; guard++) {
        const p = prev.get(key(cur[0], cur[1]));
        if (!p) {
          // cur 就是起点本身（极少见：起点已贴脸时上面已早退）
          break;
        }
        if (p[0] === sx && p[1] === sz) {
          return {
            reachable: true,
            nextStep: [cur[0] - sx, cur[1] - sz],
            pathLength: pathLenOf(prev, key(cx, cz), key(sx, sz), cap),
            explored,
            truncated: false,
          };
        }
        cur = p;
      }
      break;
    }
    for (const [dx, dz] of NEIGHBORS) {
      const nx = cx + dx;
      const nz = cz + dz;
      const k = key(nx, nz);
      if (seen.has(k)) continue;
      if (Math.max(Math.abs(nx - sx), Math.abs(nz - sz)) > maxRadius) { truncated = true; continue; }
      if (!standable(world, nx, y, nz)) continue;
      seen.add(k);
      prev.set(k, [cx, cz]);
      queue.push([nx, nz]);
    }
  }
  return { reachable: false, nextStep: null, pathLength: 0, explored, truncated };
}
