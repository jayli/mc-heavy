// src/entities/dragons/fireball-system.js — 飞龙火球（v2.44）：临时实体 definition + 判定
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// 火球是**临时实体**（`persistent: false`），与炮塔弹丸同构但**刻意独立**：
// 速度（15 vs 40）、遮挡判据（只看 solid vs solid && opaque）、命中语义（爆炸 vs 伤害）
// 全不同。共用 `projectile-system.js` 的数值会让「火球穿过玻璃」或「火球飞得像曳光弹」。
//
// ## 判定顺序（照 `judgeProjectile`：① 超距 → ② 方块 → ③ 玩家）
//
// ⚠️ **顺序不能换**：若先判玩家命中，火球可能在「已飞超最大距离」的位置上命中玩家。
//
// ## 遮挡判据（Review Focus 2，与炮塔弹丸有意不同）
//
// 火球用 **`registry.solidTable[id] === 1`（只看 solid）**，而炮塔弹丸用
// `isProjectileOccluding`（solid && opaque）。差异在玻璃：`glass_block` 是
// `cullMode:'transparent'` → `opaqueTable=0`，炮塔弹丸穿过它，而**火球必须被它挡住**
// （用户原话「包括树叶、玻璃等半透明方块」）。树叶是 `opaque:true`，两个判据都挡 ——
// 故只测树叶的用例抓不到这个差异，玻璃那条是判别性用例。
//
// ## 玩家命中（用户：火球命中玩家只爆炸不掉血）
//
// 玩家盒由调用方（game.js）经 `ctx.playerAabb` 注入 —— 形状 `{position, aabb}`，
// `position` = 脚底中心、`aabb` = `playerHitboxLocal()` 的局部盒。⚠️ entities/ 不得
// import player/（矿车先例），玩家尺寸的唯一权威仍在 `physics.js`。
// **本文件不写任何伤害** —— 命中只返回 `reason:'player'` + 爆炸中心，由 game.js 调
// `_applyExplosion`（玩家掉血以后再做）。
//
// ## ⚠️ 为何此处**有意偏离** `judgeProjectile` 的实体命中口径（红线 6 的核准例外）
//
// 炮塔弹丸打实体走 `entities.raycast(from, dir, stepLen, predicate)`（EntityManager 是
// 实体命中的唯一入口），而火球打**玩家**直调 `raycastAabbSlab` + 注入盒。理由：
// **玩家不是 EntityManager 的成员**（`Player` 是独立对象，物理在 `player/physics.js`），
// `EntityManager.raycast()` 结构上就打不到它 —— 注入盒直调是**唯一可行路径**，不是偷懒。
// 红线 6 的实质是「命中真相 = 逻辑 AABB，禁止对 mesh 做 THREE.Raycaster」—— 本写法完全符合
// （用的正是 `raycastAabbSlab` 这唯一实现，盒尺寸从 `PLAYER_WIDTH/HEIGHT` 派生）。
// ⚠️ **若将来火球要命中其它实体（丧尸/龙）**：那时必须改走 `entities.raycast`（它们**是**
// EntityManager 成员），而不是给每种实体再手工注入一个盒 —— 那会漂移出 N 份命中口径。
//
// 设计文档 `docs/superpowers/specs/2026-11-03-dragon-boss-ai-design.md` §4。

import { FIREBALL } from './dragon-config.js';
import { raycastAabbSlab } from '../entity-types.js';
import { raycastVoxel } from '../../player/raycast.js';

/** 火球 AABB：`FIREBALL.radius` 见方的小盒（与弹丸 `PROJECTILE_AABB` 同手法） */
export const FIREBALL_AABB = Object.freeze({
  min: Object.freeze([-FIREBALL.radius, -FIREBALL.radius, -FIREBALL.radius]),
  max: Object.freeze([FIREBALL.radius, FIREBALL.radius, FIREBALL.radius]),
});

/**
 * 新建一份合法 state（形状校验：position/direction 必须是 3 个有限数，direction 归一化）。
 * ⚠️ **每次都返回全新数组** —— 推进靠反复调用本函数（见 `update` 的 ⚠️）。
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
 * 单步推进（直线，无重力、无追踪 —— 用户裁定「直线飞向玩家发射瞬间的位置」）。
 *
 * ⚠️ **必须返回全新 state + 全新数组**（M5 不变式）：`EntityManager.update()` 的跨 column
 * 索引迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让 before/after 从同一份
 * 算出 → 恒相等 → 索引永不迁移 → column 卸载漏回收火球。火球 15 格/秒 × 最远 80 格 →
 * 寿命约 5.3 秒，跨 column 是常态，故这条尤其关键。
 *
 * @param {import('../entity-manager.js').Entity} entity
 * @param {number} dt @param {object} _context 本函数刻意不消费（纯直线推进）
 */
function update(entity, dt, _context) {
  const prev = entity.state;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const dist = FIREBALL.speed * step;
  const [dx, dy, dz] = prev.direction;
  return createState({
    position: [
      prev.position[0] + dx * dist,
      prev.position[1] + dy * dist,
      prev.position[2] + dz * dist,
    ],
    direction: prev.direction,
    traveled: prev.traveled + dist,
    source: prev.source,
  });
}

/**
 * 判定火球本步是否该消失/爆炸。
 *
 * 判定顺序照 `judgeProjectile`：① 超距 → ② 方块阻挡（DDA）→ ③ 玩家命中。
 *
 * ⚠️ **判定线段必须是本步实际穿越的那段**：`from = 步后 position − direction×stepLen`。
 * 若只从步后位置起算，刚走过的线段永不判定 → dt 尖峰时穿墙（15 格/秒 × 0.2s = 3 格 > 1 格墙厚）。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，不是 null →
 * 必须判 `blockHit.hit`；写成 `if (blockHit)` 会让火球每次判定都立刻判「撞方块」而爆。
 *
 * @param {{next: object, world: object, registry: object,
 *          player: {position: [number,number,number], aabb: {min:number[],max:number[]}} | null,
 *          stepLen: number}} p
 *        `next` = 本步推进后的 state；`player.aabb` = `playerHitboxLocal()` 的局部盒
 * @returns {{reason: 'block'|'player'|'max-distance'|null, at?: [number,number,number]}}
 *          `at` = 爆炸中心（block 用 blockPos，player 用命中点）；**超距不给 at**（不爆炸）
 */
export function judgeFireball({ next, world, registry, player, stepLen }) {
  // ① 超距：没撞到东西就消失，**不爆炸**（故不给 at）
  if (next.traveled >= FIREBALL.maxDistance) return { reason: 'max-distance' };

  // ② 方块阻挡：DDA 遍历本步穿越的线段。遮挡判据**只看 solid**（见文件头 ⚠️）。
  const [dx, dy, dz] = next.direction;
  const from = [
    next.position[0] - dx * stepLen,
    next.position[1] - dy * stepLen,
    next.position[2] - dz * stepLen,
  ];
  const blockHit = raycastVoxel(world, from, next.direction, stepLen,
    (id) => id !== 0 && registry.solidTable[id] === 1);
  if (blockHit.hit) {
    return { reason: 'block', at: [blockHit.blockPos[0], blockHit.blockPos[1], blockHit.blockPos[2]] };
  }

  // ③ 玩家命中：raycastAabbSlab（实体 AABB 射线唯一权威，红线 1）。
  //    ⚠️ 只返回命中事实与爆炸中心，**不写伤害**（玩家掉血以后再做）。
  if (player && Array.isArray(player.position) && player.aabb) {
    const t = raycastAabbSlab({ position: player.position }, from, next.direction, stepLen, player.aabb);
    if (t !== null) {
      return {
        reason: 'player',
        at: [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t],
      };
    }
  }
  return { reason: null };
}

/**
 * `judgeFireball` 的薄封装（推进 + 判定）—— **单测用**。
 * ⚠️ Game 帧循环**不用**它（推进已由 `entities.update()` 驱动；两处推进会让火球速度翻倍，
 * 与弹丸「两处推进」同一类缺陷）。
 * @returns {{state: object, alive: boolean, reason?: 'block'|'player'|'max-distance', at?: [number,number,number]}}
 */
export function advanceFireball({ state, dt, world, registry, player }) {
  const next = update({ state }, dt, {});
  const { reason, at } = judgeFireball({
    next, world, registry, player, stepLen: FIREBALL.speed * dt,
  });
  if (reason) return { state: next, alive: false, reason, ...(at ? { at } : {}) };
  return { state: next, alive: true };
}

/**
 * 火球的 M5 definition。
 *
 * ⚠️ **`raycastAabb` 走 `FIREBALL_AABB`**（不是 PROBE_AABB）：火球半径 0.45 远大于
 * probe 的 0.3 半边，命中判据必须用真实尺寸。
 */
export const fireballDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  update,

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, FIREBALL_AABB),

  /** 临时实体不走存档（与弹丸同口径） */
  serialize() { return null; },

  deserialize() { return null; },
});
