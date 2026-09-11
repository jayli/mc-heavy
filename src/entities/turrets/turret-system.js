// src/entities/turrets/turret-system.js — M8：炮塔索敌（同构纯函数，规格 §4）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
//
// **在主线程执行，不走 Worker**（规格 §4.1）：索敌必须做 LOS 判定，而 LOS 必须读方块 ——
// Worker 内没有持久世界数据（`world-worker.js:178`「worker 里没有世界数据，也不该有」）。
// 传体素 view 给 worker = 每 RPC 1.28MB / 每秒 10MB 结构化克隆；worker 内持久化世界数据 =
// 第二份体素权威（违反红线 1）。故 LOS 留在主线程 —— 红线 3 的第二个边界判定例外
// （第一个是爆炸计算，理由记在设计文档 §4.5.5）。
//
// 数值逐项对齐 mc-lite `TURRET_CONFIG`（见 turret-config.js）。遮挡判据
// `isProjectileOccluding` 被**两个消费方**共用（LOS + 弹丸）—— 红线 1：各写一份会漂移出
// 「看得见但打不着」的撕裂状态。
import { TURRET } from './turret-config.js';

/** 起点偏移：避免 LOS 采样到炮塔自身的方块（mc-lite `LOS_START_EPSILON`） */
const LOS_START_EPSILON = 0.1;
/** 终点容差：避免目标贴身的方块误判为遮挡（mc-lite `LOS_TARGET_EPSILON`） */
const LOS_TARGET_EPSILON = 0.35;

/**
 * 方块是否阻挡视线/弹丸：只有「实心且不透明」阻挡（mc-lite `isBlockOccluding` 同口径
 * `props.isSolid && !props.isTransparent`）。透明方块（玻璃/水/云）与 cutout（树叶）可穿透。
 *
 * ⚠️ **两个消费方共用**（炮塔 LOS + 弹丸阻挡）—— 各写一份会漂移出「看得见但打不着」。
 * @param {number} id
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function isProjectileOccluding(id, registry) {
  if (id === 0) return false;   // air
  return registry.solidTable[id] === 1 && registry.opaqueTable[id] === 1;
}

/**
 * 视线判定（mc-lite `hasLineOfSightToEnemy` 语义照搬）：沿 from→to 按 `losSampleStep`
 * 步长采样，任一采样格被「实心不透明」方块占据即不可见。
 * @param {{world: import('../../voxel/world-data.js').WorldData,
 *          registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>,
 *          from: [number,number,number], to: [number,number,number]}} p
 * @returns {boolean}
 */
export function hasLineOfSight({ world, registry, from, to }) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const total = Math.hypot(dx, dy, dz);
  if (total <= LOS_START_EPSILON) return true;   // 贴身 → 视为可见
  const ux = dx / total, uy = dy / total, uz = dz / total;
  const start = LOS_START_EPSILON;
  const end = Math.max(start, total - LOS_TARGET_EPSILON);
  let lastX = NaN, lastY = NaN, lastZ = NaN;
  for (let d = start; d <= end; d += TURRET.losSampleStep) {
    const bx = Math.floor(from[0] + ux * d);
    const by = Math.floor(from[1] + uy * d);
    const bz = Math.floor(from[2] + uz * d);
    if (bx === lastX && by === lastY && bz === lastZ) continue;   // 同格跳过重复查询
    lastX = bx; lastY = by; lastZ = bz;
    if (isProjectileOccluding(world.getBlockId(bx, by, bz), registry)) return false;
  }
  return true;
}

/**
 * 最短角差（归一化到 [-π, π]）。mc-lite `MathUtils.shortestAngleDiff` 同口径。
 * 导出为单一权威 —— controller 的插值与测试共用（各写一份会漂移）。
 * @param {number} from @param {number} to @returns {number}
 */
export function shortestAngleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** 归一化角度到 [-π, π)。mc-lite `MathUtils.normalizeAngle` 同口径 */
export function normalizeAngle(a) {
  let x = a % (Math.PI * 2);
  if (x >= Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/**
 * 计算一批炮塔的索敌意图。**在主线程同步执行**（规格 §4.1）。
 *
 * 目标选择（mc-lite `findTarget`）：检测范围内**最近**且 LOS 可见的丧尸；先 `distSq` 粗筛
 * 再 LOS（避免对所有丧尸跑 LOS —— 最坏 20 炮塔 × 20 丧尸 × 100 采样）。
 * 无目标时回归炮塔的默认朝向（`rotation`）。
 *
 * ⚠️ **yaw/pitch 用 atan2 算，不用 Euler 反解**（CLAUDE.md 活跃约束：three 的 Euler 'XYZ'
 * 序对 Y 轴用 `asin(m13)`，`|θ| > π/2` 时折叠回 `[-π/2, π/2]`）。本函数从坐标直接算角度，
 * 天然规避；渲染层反解朝向时须用 `atan2(elements[8], elements[0])`（见 Task 5）。
 *
 * ⚠️ **返回形状无 `generation`** —— 不走 RPC，故红线 7 的版本协议不适用（同步调用不存在
 * 迟到回包）。但若未来把 AI 改成 Worker 任务，它立刻生效。
 *
 * @param {{turrets: Array<{id:string, pivot:[number,number,number], rotation:number}>,
 *          zombies: Array<{id:string, position:[number,number,number]}>,
 *          world: import('../../voxel/world-data.js').WorldData,
 *          registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>}} p
 * @returns {{updates: Array<{id:string, targetYaw:number, targetPitch:number,
 *            hasTarget:boolean, targetId:string|null}>}}
 */
export function computeTurretUpdates({ turrets, zombies, world, registry }) {
  const updates = [];
  const list = zombies ?? [];
  for (const t of turrets ?? []) {
    let target = null;
    let targetId = null;
    let minDistSq = TURRET.detectionRange * TURRET.detectionRange;
    if (list.length > 0) {
      for (const z of list) {
        // 瞄准丧尸上半身（胸部）—— mc-lite `ENEMY_BODY_OFFSET_Y`
        const tx = z.position[0], ty = z.position[1] + TURRET.enemyBodyOffsetY, tz = z.position[2];
        const dx = tx - t.pivot[0], dy = ty - t.pivot[1], dz = tz - t.pivot[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= minDistSq) continue;   // 粗筛：超范围或非最近
        if (!hasLineOfSight({ world, registry, from: t.pivot, to: [tx, ty, tz] })) continue;
        minDistSq = distSq;
        target = [tx, ty, tz];
        targetId = z.id;
      }
    }
    if (!target) {
      // ⚠️ **必须显式报「无目标」**（实玩反馈修正）：只返回朝向不足以让 controller 区分
      // 「无目标回归默认」与「目标恰好在默认朝向上」—— 后者角度差为 0，若 controller 只判
      // 角度对准 + 冷却就会**对着空气无限开火**。mc-lite 的 `tryFire()` 第一道门控正是
      // `if (!this.targetEnemy) return;`（`Turret.js:665`）。
      updates.push({ id: t.id, targetYaw: t.rotation, targetPitch: 0, hasTarget: false, targetId: null });
      continue;
    }
    const dx = target[0] - t.pivot[0], dy = target[1] - t.pivot[1], dz = target[2] - t.pivot[2];
    // yaw = atan2(dx, dz)（+Z 为 0，顺时针为正；与渲染层反解口径一致）
    const targetYaw = Math.atan2(dx, dz);
    // pitch = atan2(dy, 水平距离)，限制在 ±45°（`MAX_PITCH_ANGLE`）
    const horizontal = Math.hypot(dx, dz);
    let targetPitch = Math.atan2(dy, horizontal);
    targetPitch = Math.max(-TURRET.maxPitchAngle, Math.min(TURRET.maxPitchAngle, targetPitch));
    updates.push({ id: t.id, targetYaw, targetPitch, hasTarget: true, targetId: targetId });
  }
  return { updates };
}
