// src/entities/cinder/cinder-system.js — Cinder Fall 的岩石实体（v3.21）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// 岩石是**临时实体**（`persistent: false`），与飞龙火球 / 炮塔弹丸同构但**刻意独立**：
// 轨迹（抛物线 vs 直线）、命中对象（丧尸+Boss vs 玩家）、爆炸语义（只扣血 vs 破坏方块）
// 全不同。共用它们的数值会让「岩石飞得像曳光弹」或「岩石把墙炸了」。
//
// ## ⚠️⚠️ 判定线段取 `prevPosition → position`，**不是** `position − direction×stepLen`
//
// 直线弹丸（`judgeProjectile` / `judgeFireball`）的方向恒定，故能用「步后位置减一个
// 已知位移」还原线段。**抛物线下方向每步都在变** —— 照抄那个公式会算出一条与实际
// 轨迹不同的线段，dt 尖峰时穿墙（18 格/秒 × 0.2s = 3.6 格 > 1 格墙厚）。
// 故 state 显式存 `prevPosition`，判定用真实的两端点。
//
// ## 遮挡判据：只看 `solidTable`（与飞龙火球同口径，用户「和 storm lance 一样」）
//
// 炮塔弹丸用 `isProjectileOccluding`（solid && opaque）⇒ 穿过玻璃。岩石**必须被玻璃挡住**，
// 故用 `registry.solidTable[id] === 1`。树叶两个判据都挡 ⇒ **只测树叶的用例抓不到这个差异**，
// 玻璃那条是判别性用例（`test-cinder-fall.js`）。
//
// ## 实体命中走 `entities.raycastAll`（红线 6 的实体命中唯一入口）
//
// ⚠️ **不得手工注入盒**：`fireball-system.js` 打玩家是核准例外（玩家不是 EntityManager
// 成员），而丧尸/三种 Boss **是**成员 ⇒ 必须走 manager，否则漂移出 N 份命中口径。
// 各类型的盒由自己的 `xxxAabbFor(state)` 给出（焰魔/守卫还随 yaw 旋转）。
//
// 设计文档 `docs/superpowers/specs/2026-11-19-cinder-fall-staged-charge-design.md` §6。
import { WEAPONS, WEAPON_IDS } from '../../player/weapons/weapon-catalog.js';
import {
  CINDER_TYPE, CINDER_AABB, cinderArcPoint, cinderParamAt,
} from '../../player/weapons/cinder-fall.js';
import { raycastAabbSlab, WEAPON_HITTABLE_TYPES } from '../entity-types.js';
import { raycastVoxel } from '../../player/raycast.js';

const CFG = WEAPONS[WEAPON_IDS.SWORD].cinderFall;

export { CINDER_TYPE, CINDER_AABB };

/** 三维数组合法性（形状 + 有限数） */
function isVec3(a) {
  return Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v));
}

/**
 * 新建一份合法 state。
 *
 * ⚠️ **每次都返回全新数组** —— 推进靠反复调用本函数（见 `update` 的 ⚠️）。
 * `launch` 是 `cinderLaunch` 的产物（冻结的起点/瞄准点/拱起参数），整体带进 state：
 * 岩石在飞的时候玩家可能已经转了镜头，弹道不得跟着变（与曳光同口径）。
 */
function createState({ launch, traveled, source, prevPosition }) {
  if (!launch || !isVec3(launch.origin) || !isVec3(launch.target)) return null;
  if (!(Number.isFinite(launch.distance) && launch.distance > 0)) return null;
  const t0 = Number.isFinite(traveled) ? traveled : 0;
  const position = cinderArcPoint(launch, cinderParamAt(t0, launch.distance));
  return {
    launch: {
      origin: [...launch.origin],
      target: [...launch.target],
      distance: launch.distance,
      arc: Number.isFinite(launch.arc) ? launch.arc : 0,
      arcCurve: Number.isFinite(launch.arcCurve) ? launch.arcCurve : 1,
      degenerate: !!launch.degenerate,
    },
    position,
    // 首帧无位移 ⇒ prevPosition = 起点（judge 会因零长度早退，不误判命中）
    prevPosition: isVec3(prevPosition) ? [...prevPosition] : [...position],
    traveled: t0,
    source: typeof source === 'string' ? source : null,
  };
}

/**
 * 单步推进（沿抛物线，无碰撞响应 —— 命中判定在 `judgeCinder` 里做）。
 *
 * ⚠️ **必须返回全新 state + 全新数组**（M5 不变式）：`EntityManager.update()` 的跨 column
 * 索引迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让 before/after 从同一份
 * 算出 → 恒相等 → 索引永不迁移 → column 卸载漏回收岩石。岩石 18 格/秒 × 20 格 ≈ 1.1 秒，
 * 跨 column 是常态，故这条尤其关键。
 *
 * @param {import('../entity-manager.js').Entity} entity
 * @param {number} dt @param {object} _context 本函数刻意不消费（纯弹道推进）
 */
function update(entity, dt, _context) {
  const prev = entity.state;
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  // 路程钳在 distance：到末端后停住（判定会给 max-distance ⇒ 消失）
  const traveled = Math.min(prev.launch.distance, prev.traveled + CFG.speed * step);
  const next = createState({
    launch: prev.launch,
    traveled,
    source: prev.source,
    prevPosition: prev.position,
  });
  return next;
}

/**
 * 判定岩石本步是否该消失/爆炸（**只判定不推进**）。
 *
 * 判定顺序（**与直线弹丸刻意不同，见下方 ⚠️⚠️**）：
 *   ① 先算本步线段并判方块/实体（**包括抵达瞄准点的最后一步**）
 *   ② 都没命中且已飞满射程 ⇒ `end-of-flight`（在末端自爆）
 *
 * ⚠️⚠️ **不得把「超距」放在最前面早退**（本轮浏览器实测抓到的真缺陷）：
 * `update` 把 `traveled` 钳在 `distance`，若先判 `traveled >= distance` 就直接 return，
 * **抵达瞄准点的最后一步永不被判方块/实体** ⇒ 朝地面或近处敌人扔时
 * 「球飞到了但没炸」（实测：t≈150ms 岩石消失而 blasts=0），而计数类判据全绿。
 * 直线弹丸那套「超距不爆」是因为它们的 maxDistance 是**安全上限**（远超正常射程）；
 * 本招的 distance 是**瞄准点**，飞到了就该炸（用户：「扔出去的球…都爆炸」）。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，不是 null ⇒ 必须判 `.hit`。
 *
 * @param {{next:object, world:object, registry:object, entities:object|null}} p
 *        `next` = 本步推进后的 state（由 `cinderDefinition.update` 给出）
 * @returns {{reason:'block'|'entity'|'end-of-flight'|null, at?:number[], hitId?:string}}
 *          `at` = 爆炸中心（block 用 blockPos，entity 用命中点，end-of-flight 用末端）
 */
export function judgeCinder({ next, world, registry, entities }) {
  const from = next.prevPosition;
  const to = next.position;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const stepLen = Math.hypot(dx, dy, dz);
  const arrived = next.traveled >= next.launch.distance;

  // 零位移帧（首帧 / dt=0 / 已到末端后的空转）：没有穿越任何线段。
  // ⚠️ 不判这条会让归一化除零 ⇒ dir 变 NaN ⇒ DDA 静默走飞。
  // 已到末端且本帧无位移 ⇒ 仍该给 end-of-flight（上一帧可能因未加载列而没炸成）。
  if (!(stepLen > 1e-9)) {
    return arrived ? { reason: 'end-of-flight', at: [...to] } : { reason: null };
  }
  const dir = [dx / stepLen, dy / stepLen, dz / stepLen];

  // ① 方块阻挡：DDA 遍历本步实际穿越的线段。遮挡只看 solid（见文件头 ⚠️）。
  const blockHit = raycastVoxel(world, from, dir, stepLen,
    (id) => id !== 0 && registry.solidTable[id] === 1);
  if (blockHit.hit) {
    return { reason: 'block', at: [...blockHit.blockPos] };
  }

  // ② 实体命中：EntityManager 是实体命中的唯一入口（红线 6）。
  //    predicate 读共享集合 ⇒ 丧尸 + 飞龙 + 焰魔 + 守卫都打得到，矿车/弹丸/岩石自己不算。
  if (entities && typeof entities.raycastAll === 'function') {
    const hits = entities.raycastAll(from, dir, stepLen,
      (entity) => WEAPON_HITTABLE_TYPES.includes(entity.type));
    if (hits.length > 0) {
      const first = hits[0];   // raycastAll 已按 dist 升序
      return { reason: 'entity', hitId: first.id, at: [...first.point] };
    }
  }

  // ③ 飞满射程且什么都没撞到 ⇒ 在末端自爆（而不是静默消失）
  if (arrived) return { reason: 'end-of-flight', at: [...to] };
  return { reason: null };
}

/**
 * 岩石的 M5 definition。
 *
 * ⚠️ **`raycastAabb` 走 `CINDER_AABB`**（不是 PROBE_AABB）：命中判据必须用真实尺寸。
 * 岩石自己不在 `WEAPON_HITTABLE_TYPES` 里，故武器/炮塔打不到它（与火球同口径）。
 */
export const cinderDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  update,

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, CINDER_AABB),

  /** 临时实体不走存档（与火球/弹丸同口径） */
  serialize() { return null; },

  deserialize() { return null; },
});