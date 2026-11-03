// src/entities/turrets/projectile-system.js — M8：弹丸实体（M5 临时实体，规格 §5.2）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
//
// 弹丸是**临时实体**（roadmap 指定接入点：M5 `EntityManager` + 实体 raycast），不是渲染节点：
// 命中真相由实体的逻辑 AABB 给出，渲染层只发布 pose。
//
// **两处判定按红线 6 重写**（有意偏离 mc-lite，规格 §5.2 的偏离表）：
// ① 方块阻挡：mc-lite 用起点/终点双点 `getBlock` 采样（`Projectile.js:130-152`）→ 一帧
//    0.667 格的步长下斜射可能整步不落在同一格，漏穿薄墙。本仓库走体素 DDA（`raycastVoxel`，
//    共用同一份实现 —— 见该文件的 `occludes` 参数注释）；
// ② 实体命中：mc-lite 用「点到线段距离 + 半径容差」（`Projectile.js:157-193`）→ 本仓库走
//    `EntityManager.raycast()`（实体命中唯一入口，红线 6）。
import { TURRET } from './turret-config.js';
import { isProjectileOccluding } from './turret-system.js';   // 遮挡判据共用（红线 1）
import { raycastAabbSlab, WEAPON_HITTABLE_TYPES } from '../entity-types.js';
import { raycastVoxel } from '../../player/raycast.js';

/** 弹丸 AABB：0.3 见方的小盒（mc-lite `_projectileRadius = 0.3` 的等价表达） */
export const PROJECTILE_AABB = Object.freeze({
  min: Object.freeze([-0.15, -0.15, -0.15]),
  max: Object.freeze([0.15, 0.15, 0.15]),
});

/**
 * 新建一份合法 state（形状校验：position/direction 必须是 3 个有限数，direction 归一化）。
 * ⚠️ **每次都返回全新数组** —— 推进靠反复调用本函数（见下方 `update` 的 ⚠️）。
 */
function createState({ position, direction, traveled, source }) {
  if (!Array.isArray(position) || position.length !== 3) return null;
  if (!Array.isArray(direction) || direction.length !== 3) return null;
  for (const v of [...position, ...direction]) if (!Number.isFinite(v)) return null;
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) return null;   // 零方向 → 无法推进
  return {
    position: [position[0], position[1], position[2]],
    direction: [direction[0] / len, direction[1] / len, direction[2] / len],
    traveled: Number.isFinite(traveled) ? traveled : 0,
    source: typeof source === 'string' ? source : null,
  };
}

/**
 * 单步推进（直线，无重力、无碰撞响应 —— mc-lite 同口径：弹丸只判定命中后即消失，
 * 不弹跳、不下坠）。
 *
 * ⚠️ **必须返回全新 state + 全新数组**（CLAUDE.md 活跃约束）：`EntityManager.update()` 的
 * 跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」。原地改写会让 before/after
 * 从同一份已改位置算出 → 恒相等 → **索引永不迁移** → column 卸载漏回收弹丸。
 * 浅拷贝 `{...state}` 也不够（position 数组引用相同仍会被污染）。
 * 弹丸 40 格/秒 × 最大 50 格 → 寿命约 1.25 秒，跨 column 是常态，故这条尤其关键。
 *
 * @param {import('../entity-manager.js').Entity} entity
 * @param {number} dt @param {{world}} context
 */
// ⚠️ `_context` 前缀 = **本函数刻意不消费第三参数**（eslint `no-unused-vars` 的 `/^_/` 约定）。
// 弹丸是纯直线推进，不读 world（阻挡判定在 `judgeProjectile` 里做，不在推进阶段）。
function update(entity, dt, _context) {
  const prev = entity.state;
  const step = TURRET.projectileSpeed * dt;
  const [dx, dy, dz] = prev.direction;
  return createState({
    position: [
      prev.position[0] + dx * step,
      prev.position[1] + dy * step,
      prev.position[2] + dz * step,
    ],
    direction: prev.direction,
    traveled: prev.traveled + step,
    source: prev.source,
  });
}

export const projectileDefinition = Object.freeze({
  create: createState,
  update,
  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, PROJECTILE_AABB),
  /** 弹丸不存档（临时实体）—— serialize 返回 null 即不进 entities snapshot */
  serialize() { return null; },
  deserialize() { return null; },
});

/**
 * **只判定不推进**的纯谓词 —— 弹丸判定的**唯一实现**（阻挡 + 命中 + 超距）。
 * Game 帧循环用这个（推进由 `projectileDefinition.update` 经 `entities.update()` 驱动 ——
 * 两处推进会让弹丸速度翻倍）；单测用的 `advanceProjectile` 是它的薄封装。
 *
 * 判定顺序（mc-lite `Projectile.update` 同序）：① 超距 → ② 方块阻挡（DDA）→ ③ 实体命中。
 * ⚠️ 顺序不能换：若先判实体命中，弹丸可能在「已飞超最大距离」的位置上命中丧尸。
 *
 * ⚠️ **判定线段必须是本步实际穿越的那段**：`from = 步后 position − direction×stepLen`
 * （`direction` 已归一化，直接可算）。若只从步后位置起算，刚走过的线段永不判定 →
 * dt 尖峰时穿墙（40 格/秒 × 0.05s = 2 格 > 1 格墙厚）。「DDA 取代 mc-lite 的双点采样」
 * 正是本任务的核心论证，判定区间错了会让该论证失效（单测有专门用例钉这条）。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，不是 null →
 * 必须判 `blockHit.hit`；写成 `if (blockHit)` 会让弹丸每次判定都立刻判「撞方块」而死。
 *
 * @param {{next: object, world, registry, entities, stepLen: number, nowMs: number,
 *          onDamage?: (id:string, amount:number, nowMs:number)=>void}} p
 *        `next` = 本步推进后的 state（由 `projectileDefinition.update` 或调用方给出）
 * @returns {{reason: 'block'|'entity'|'max-distance'|null, hitId?: string}}
 */
export function judgeProjectile({ next, world, registry, entities, stepLen, nowMs, onDamage = null }) {
  // ① 超距
  if (next.traveled >= TURRET.projectileMaxDistance) return { reason: 'max-distance' };
  // ② 方块阻挡：DDA 遍历 from → to（本步实际穿越的线段）。红线 6：地形交互一律体素 DDA；
  //    遮挡判据用 `isProjectileOccluding`（与炮塔 LOS 共用 —— 红线 1，不写第二份 DDA）
  const [dx, dy, dz] = next.direction;
  const from = [
    next.position[0] - dx * stepLen,
    next.position[1] - dy * stepLen,
    next.position[2] - dz * stepLen,
  ];
  const blockHit = raycastVoxel(world, from, next.direction, stepLen,
    (id) => isProjectileOccluding(id, registry));
  if (blockHit.hit) return { reason: 'block' };   // ⚠️ 判 `.hit`，不是判对象本身
  // ③ 实体命中：EntityManager.raycast（实体命中唯一入口，红线 6）
  if (entities) {
    const hit = entities.raycast(from, next.direction, stepLen,
      // v2.41：可击中类型的唯一权威 = `WEAPON_HITTABLE_TYPES`（丧尸 + 龙）。
      // ⚠️ 不得写回 `entity.type === 'zombie'` —— 那会让炮塔弹丸穿过龙（用户裁定「炮塔也打龙」），
      // 且与武器侧的 predicate 漂移出两套口径（红线 1）。弹丸/矿车刻意不在集合里。
      (entity) => WEAPON_HITTABLE_TYPES.includes(entity.type));
    if (hit) {
      // 伤害经调用方注入的 `onDamage`（Game 的 `damageEntity` 按类型分发到
      // ZombieService / DragonService）—— 本函数不持有 service 引用（同构层不反向依赖装配层）。
      if (onDamage) onDamage(hit.id, TURRET.projectileDamage, nowMs);
      return { reason: 'entity', hitId: hit.id };
    }
  }
  return { reason: null };
}

/**
 * `judgeProjectile` 的薄封装（推进 + 判定）—— **单测用**。
 * ⚠️ Game 帧循环**不用**它（推进已由 `entities.update()` 驱动；两处推进会让速度翻倍）。
 * @returns {{state: object, alive: boolean, reason?: 'block'|'entity'|'max-distance', hitId?: string}}
 */
export function advanceProjectile({ state, dt, world, registry, entities, nowMs, onDamage = null }) {
  const next = update({ state }, dt, { world });
  const { reason, hitId } = judgeProjectile({
    next, world, registry, entities, stepLen: TURRET.projectileSpeed * dt, nowMs, onDamage,
  });
  if (reason) return { state: next, alive: false, reason, ...(hitId ? { hitId } : {}) };
  return { state: next, alive: true };
}
