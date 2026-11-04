// src/entities/zombies/zombie-navigator.js — 丧尸导航（本地寻路 + 记忆 + 决策）
//
// 同构层：**无 DOM、无 three、无网络、不自建 Worker**（`npm run check:arch` 静态门守）。
//
// ## 历史上这里有过一个「在线模型决策」层，已整体删除
//
// v2.46 曾把方向判断交给 TypeSafe/Jev 模型（`zombie-jev-*`），经过两轮实玩被推翻：
// ① 只给 9×9 窗口时模型无法绕行超过 4 格（31 格长墙 → 69 次决策、净位移 0.7 格）；
// ② 加了代码寻路后，模型**连续 14 次否决**正确的规划方向（把丧尸按在原地 20 秒）。
// 用户 2026-11-04 裁定：**完全去掉网络推理，只依赖本地计算**。
//
// ## 现状：三层，全部本地、确定性、零网络
//
// ① `zombie-pathfinder.js` —— 24 格有界 BFS 给出「下一个地标」（长距离可达性）
// ② 本模块 —— 把地标方向修成「真正能走的那一步」：贴墙滑行、防往返振荡
// ③ `zombie-navigation.js` 的 `steerIntent` —— 物理层之前的最后 1.2 格精细避让
//
// ## 为什么需要记忆（保留自 v2.46）
//
// 纯 BFS 每 0.5 秒重算时，「往东绕」与「往西绕」常等长 —— 不记住上一次的选择，丧尸会在
// 两条等长路线间来回横跳（实测形态：位置在 0.1 格内摆动、60 秒净位移接近 0）。
// 记忆只剩 `plan`（v2.49 清理，`visits`/`trail`/`deadEnds` 只写不读，已删）。
import { ZOMBIE_STEERING } from './zombie-config.js';
import { PathCache, directionNameOf } from './zombie-pathfinder.js';

/**
 * 8 方向 → 单位向量 `[vx, vz]`（与 `DIRECTION_ORDER` 同序）。
 * ⚠️ 键名必须与 `zombie-pathfinder.js` 的 `DIRECTION_ORDER` 一致。
 */
export const DIRECTION_VECTORS = Object.freeze({
  north: Object.freeze([0, -1]),
  north_east: Object.freeze([Math.SQRT1_2, -Math.SQRT1_2]),
  east: Object.freeze([1, 0]),
  south_east: Object.freeze([Math.SQRT1_2, Math.SQRT1_2]),
  south: Object.freeze([0, 1]),
  south_west: Object.freeze([-Math.SQRT1_2, Math.SQRT1_2]),
  west: Object.freeze([-1, 0]),
  north_west: Object.freeze([-Math.SQRT1_2, -Math.SQRT1_2]),
});

/**
 * 取（或创建）某只丧尸的导航记忆。**只剩 `plan` 一个字段**（v2.49 清理）。
 *
 * `plan` = `{direction, walked}`：当前计划方向 + 已沿该计划走了几步。
 * 用于计划固化 —— BFS 每 0.5 秒重算时「往东绕」与「往西绕」常等长，
 * 不记住上一次的选择会让丧尸在两条等长路线间来回横跳。
 *
 * ⚠️ **加回任何字段前先确认它有生产消费者**：`visits`/`trail`/`deadEnds`/`lastStep`
 * 曾是喂给已删除的 Jev 模型的「事实」，删 Jev 后只写不读（每秒 400 次无用写入）。
 *
 * @param {Map<string, object>} memoryMap id → 记忆
 * @param {string} id
 */
export function memoryFor(memoryMap, id) {
  let mem = memoryMap.get(id);
  if (!mem) {
    mem = { __id: id, plan: null };
    memoryMap.set(id, mem);
  }
  return mem;
}

/** 单位速度向量（方向名 → [vx, vz]；未知方向返回 null） */
function unitVector(dir) {
  const v = DIRECTION_VECTORS[dir];
  return v ? [v[0], v[1]] : null;
}

/**
 * 本模块的核心：给定丧尸与玩家位置，算出**这一步该走的方向**。
 *
 * 三档退化（按信息质量从高到低）：
 * 1. **BFS 可达** → 用规划方向。若该方向被贴墙挡住（物理 step-up 也过不去），
 *    退到「与规划方向夹角最小的可走方向」（`ZOMBIE_STEERING.anglesDeg` 升序，先 + 后 −）。
 * 2. **BFS 不可达（truncated）** → 退到「直线朝玩家 + 局部绕行」（v2.40 的贴身避障口径）。
 * 3. 全部不可走 → `blocked`（原地站住等下一周期）。
 *
 * @param {{world: object, position: number[], playerPosition: number[],
 *          memory: object, pathCache: PathCache, nowMs: number,
 *          isWalkable: (world: object, x: number, y: number, z: number) => boolean}} p
 *   `isWalkable(x, y, z)` 是**格坐标**判据（由调用方注入 `zombie-navigation.js` 的实现，
 *   避免本模块反向依赖它 —— 依赖方向：navigator → pathfinder → navigation）
 * @returns {{vx: number, vz: number, mode: 'chasing'|'blocked', plannedDirection: string|null,
 *            reachable: boolean, blocked: boolean}}
 *   速度是**单位向量**，大小由调用方乘 `ZOMBIE.speed`
 */
export function decideStep({ world, position, playerPosition, memory, pathCache, nowMs, isWalkable }) {
  const [x, y, z] = position;
  const bx = Math.floor(x);
  const bz = Math.floor(z);

  // ---- ① 代码寻路 ----
  const plan = pathCache.plan(world, position, playerPosition, {
    agentId: memory.__id ?? '__default__',
    nowMs,
  });
  const plannedDir = (plan.reachable && plan.nextStep)
    ? directionNameOf(plan.nextStep[0], plan.nextStep[1])
    : null;

  // 计划固化：方向没变就沿用并累加步数；变了就重置（换了路线）
  if (plannedDir !== null) {
    if (memory.plan && memory.plan.direction === plannedDir) {
      memory.plan.walked = (memory.plan.walked ?? 0) + 1;
    } else {
      memory.plan = { direction: plannedDir, walked: 0 };
    }
  } else {
    memory.plan = null;
  }

  // ---- ② 选方向 ----
  let dir = null;
  if (plannedDir !== null) {
    dir = plannedDir;
    // 规划方向被挡住时，按最小偏角找可走的方向（沿墙滑行）
    if (!isWalkable(world, bx + Math.round(DIRECTION_VECTORS[plannedDir][0]), y,
      bz + Math.round(DIRECTION_VECTORS[plannedDir][1]))) {
      const base = Math.atan2(DIRECTION_VECTORS[plannedDir][1], DIRECTION_VECTORS[plannedDir][0]);
      dir = null;
      for (const deg of ZOMBIE_STEERING.anglesDeg) {
        for (const sign of [1, -1]) {
          const th = base + (sign * deg * Math.PI) / 180;
          const cx = bx + Math.round(Math.cos(th));
          const cz = bz + Math.round(Math.sin(th));
          if (cx === bx && cz === bz) continue;
          if (!isWalkable(world, cx, y, cz)) continue;
          const name = directionNameOf(cx - bx, cz - bz);
          if (name !== null) { dir = name; break; }
        }
        if (dir !== null) break;
      }
    }
  }

  // 不可达（或绕行无解）→ 退回直线朝玩家 + 局部绕行
  if (dir === null) {
    const dx = Math.floor(playerPosition[0]) - bx;
    const dz = Math.floor(playerPosition[2]) - bz;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      const base = Math.atan2(dz, dx);
      for (const deg of [0, ...ZOMBIE_STEERING.anglesDeg]) {
        let found = false;
        for (const sign of deg === 0 ? [1] : [1, -1]) {
          const th = base + (sign * deg * Math.PI) / 180;
          const cx = bx + Math.round(Math.cos(th));
          const cz = bz + Math.round(Math.sin(th));
          if (cx === bx && cz === bz) continue;
          if (!isWalkable(world, cx, y, cz)) continue;
          const name = directionNameOf(cx - bx, cz - bz);
          if (name !== null) { dir = name; found = true; break; }
        }
        if (found) break;
      }
    }
  }

  // ---- ③ 全部不可走 → blocked ----
  if (dir === null) {
    // ⚠️ **不标记死胡同**：这一格只是「此刻」走不出去，玩家随时可能拆墙/开挖。
    // 标成死胡同会让拆墙后仍然 blocked（实测：v2.40 的「拆墙后恢复 chasing」用例因此失败）。
    return {
      vx: 0, vz: 0, mode: 'blocked',
      plannedDirection: plannedDir, reachable: plan.reachable, blocked: true,
    };
  }

  const vec = unitVector(dir);
  return {
    vx: vec[0], vz: vec[1], mode: 'chasing',
    plannedDirection: plannedDir, reachable: plan.reachable, blocked: false,
  };
}
