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
import { WORLD_MIN_Y } from '../../voxel/constants.js';

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
function createState({ launch, traveled, source, prevPosition, fall }) {
  if (!launch || !isVec3(launch.origin) || !isVec3(launch.target)) return null;
  if (!(Number.isFinite(launch.distance) && launch.distance > 0)) return null;
  const t0 = Number.isFinite(traveled) ? traveled : 0;
  const falling = !!fall;
  // 下落段：位置由 fall.pos 直接给（不再走弹道参数化）
  const position = falling && isVec3(fall.pos)
    ? [...fall.pos]
    : cinderArcPoint(launch, cinderParamAt(t0, launch.distance));
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
    /**
     * 下落相位（飞满瞄准点后）。null = 还在抛物线上。
     * ⚠️ **它是「碰到地面才爆」的唯一开关**：没有它就只能二选一
     * 「末端空中自爆」（用户否定）或「末端静默消失」（球飞到了但不爆）。
     */
    falling,
    fall: falling ? {
      pos: [...position],
      vel: isVec3(fall.vel) ? [...fall.vel] : [0, 0, 0],
      elapsed: Number.isFinite(fall.elapsed) ? fall.elapsed : 0,
    } : null,
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

  // ---- 已在下落相位：纯重力积分（水平速度保留，竖直受重力）----
  if (prev.falling && prev.fall) {
    const v = prev.fall.vel;
    const vy = v[1] - CFG.fallGravity * step;
    const pos = [
      prev.fall.pos[0] + v[0] * step,
      prev.fall.pos[1] + (v[1] + vy) * 0.5 * step,   // 梯形积分（与匀加速解析解一致）
      prev.fall.pos[2] + v[2] * step,
    ];
    return createState({
      launch: prev.launch,
      traveled: prev.traveled,
      source: prev.source,
      prevPosition: prev.position,
      fall: { pos, vel: [v[0], vy, v[2]], elapsed: prev.fall.elapsed + step },
    });
  }

  // ---- 抛物线相位 ----
  const raw = prev.traveled + CFG.speed * step;
  const traveled = Math.min(prev.launch.distance, raw);
  // ⚠️ **飞满瞄准点 ⇒ 转下落，而不是停住等判定**（用户：碰到地面才爆）。
  // 交接速度取**弹道末端的真实切向**（数值微分），保证位置与速度都连续 ——
  // 直接拿 [0,0,0] 会让岩石在末端「顿一下」再垂直掉，读作两段动画。
  if (raw >= prev.launch.distance) {
    const d = prev.launch.distance;
    const eps = 1e-3;
    const pEnd = cinderArcPoint(prev.launch, 1);
    const pBefore = cinderArcPoint(prev.launch, Math.max(0, 1 - eps));
    // t 的推进速率 = speed / distance（见 cinderParamAt）⇒ 切向 = dp/dt × dt/ds
    const k = CFG.speed / (d * eps);
    const vel = [
      (pEnd[0] - pBefore[0]) * k,
      (pEnd[1] - pBefore[1]) * k,
      (pEnd[2] - pBefore[2]) * k,
    ];
    // 本帧超出瞄准点的那段路程按切向前进（不丢帧，dt 尖峰时位置仍连续）
    const over = (raw - d) / CFG.speed;
    const pos = [pEnd[0] + vel[0] * over, pEnd[1] + vel[1] * over, pEnd[2] + vel[2] * over];
    return createState({
      launch: prev.launch,
      traveled: d,
      source: prev.source,
      prevPosition: prev.position,
      fall: { pos, vel, elapsed: over },
    });
  }
  return createState({
    launch: prev.launch,
    traveled,
    source: prev.source,
    prevPosition: prev.position,
  });
}

/**
 * 射线与方块**外表面**的接触点（用户：「碰到方块表面就爆，不是跑到内部爆」）。
 *
 * 两种情形必须分开（实测）：
 * ① **起点在格外**：DDA 的 `dist` 就是精确入射参数（实测纯 −Z 射线得 z=−5.000000），
 *    `from + dir×dist` 即接触点，`normal` 是入射面法线。
 * ② **起点已在格内**（逐步判定的常态：上一帧末位置已跨进方块）：
 *    DDA 给 `dist=0` / `normal=[0,0,0]` ⇒ 直接用它会拿到**方块内部的点**
 *    （实测 z=−5.75，已在表下 0.75 格）。
 *    此时把起点**沿运动反方向投影回本步线段与格面的交点**：
 *    对每个轴算「从 from 退到该格两个边界」的参数，取**最小的非负回退量**
 *    ⇒ 那正是本步刚刚跨过的那个面。
 *
 * ⚠️⚠️ **「起点已埋在实心内」走的是②，不是另一条分支**（实测确认）：
 * `raycastVoxel` 从 `from` 开始逐格查，**起点格本身就先被命中** ⇒ 只要 `from` 在实心内，
 * 它必返 `dist=0` / `normal=[0,0,0]`（探针实测：fromSolid=true 时 dist 恒 0）。
 * 所以②的回退逃辑同时覆盖了「刚跨进一格」与「穿坡时已埋在土里」两种形情。
 * （曾为此写过第三条「 buried-start」分支，探针证明它**不可达**⇒ 已删，不留死代码。）
 *
 * ⚠️ 不得回退成 `blockPos + 0.5`（块心）—— 那就是用户报的缺陷本身。
 *
 * @param {number[]} from 本步起点 @param {number[]} dir 已归一化
 * @param {{dist:number, normal:number[], blockPos:number[]}} hit DDA 结果
 * @returns {{at:number[], normal:number[]}}
 */
function blockSurfacePoint(from, dir, hit, world) {
  const cell = hit.blockPos;
  const d = Number.isFinite(hit.dist) ? hit.dist : 0;
  const n = Array.isArray(hit.normal) ? hit.normal : [0, 0, 0];
  const hasNormal = n[0] !== 0 || n[1] !== 0 || n[2] !== 0;
  if (d > 1e-9 && hasNormal) {
    return {
      at: [from[0] + dir[0] * d, from[1] + dir[1] * d, from[2] + dir[2] * d],
      normal: [...n],
    };
  }
  /**
   * ② 起点已在实心格内（DDA 必返 dist=0）⇒ 沿 −dir 回退找**最后一个空气位置**。
   *
   * ⚠️⚠️ **不能只退到「命中格的最近边界」**（首版这里错过，浏览器实测）：
   * 穿坡时岩石已埋在土里，命中格的六个面**全是实心**
   * （实测 `outwardSolid=true` 且 `inwardSolid=true`）⇒ 退到那个面仍在土里，
   * 爆炸仍画在地底。必须退到**真正露天的那一面**。
   *
   * 手法：粗退（1/8 格）找首个空气点 → 二分逐近实心边界（12 轮 ⇒ 误差 <1e-4 格）。
   * 回退上限 = 2 格（单步最大 18×0.2=3.6 格，但埋入深度实测 ≤1 格；取 2 留余）。
   */
  const solidAt = (p) => world.isSolid(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
  const backMax = 2;
  const h = 1 / 8;
  let airK = -1;
  for (let k = h; k <= backMax; k += h) {
    const p = [from[0] - dir[0] * k, from[1] - dir[1] * k, from[2] - dir[2] * k];
    if (!solidAt(p)) { airK = k; break; }
  }
  if (airK < 0) {
    // 整段都在实心里（极端 dt 尖峰 / 出生就在土里）⇒ 保底取命中格顶面
    return { at: [cell[0] + 0.5, cell[1] + 1, cell[2] + 0.5], normal: [0, 1, 0] };
  }
  // 二分：lo = 空气侧，hi = 实心侧
  let lo = airK;
  let hi = 0;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = [from[0] - dir[0] * mid, from[1] - dir[1] * mid, from[2] - dir[2] * mid];
    if (solidAt(p)) hi = mid; else lo = mid;
  }
  const at = [from[0] - dir[0] * lo, from[1] - dir[1] * lo, from[2] - dir[2] * lo];
  // 法线：空气格 → 实心格 跨的那个轴（取与运动方向最对齐的那个）
  const pa = at.map(Math.floor);
  const pb = [from[0] - dir[0] * hi, from[1] - dir[1] * hi, from[2] - dir[2] * hi].map(Math.floor);
  const normal = [0, 0, 0];
  let axis = -1;
  let bestDot = -1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] === pb[i]) continue;
    if (Math.abs(dir[i]) > bestDot) { bestDot = Math.abs(dir[i]); axis = i; }
  }
  if (axis >= 0) {
    normal[axis] = dir[axis] > 0 ? -1 : 1;
    at[axis] = dir[axis] > 0 ? pb[axis] : pb[axis] + 1;   // 钉在面上
  } else {
    normal[1] = 1;
  }
  return { at, normal };
}

/**
 * 判定岩石本步是否该消失/爆炸（**只判定不推进**）。
 *
 * 判定顺序：
 *   ① 本步线段的方块/实体（**包括抵达瞄准点那一步与整个下落段**）
 *   ② 掉出世界底 / 下落超时 ⇒ `void`（**静默消失，不爆**）
 *
 * ⚠️⚠️ **不得在飞满瞄准点时自爆**（用户 2026-11-19：「碰到地面才爆炸，
 * 而不是空中爆炸」）。旧口径 `end-of-flight` 在末端空中炸，浏览器实测离地
 * **4.76 格**（平视）/ **10.39 格**（仰视）。现在抵达瞄准点后由 `update` 转重力
 * 下落，**落地自然就是 ① 的 `block`** —— 判定器不需要任何「找地面」特例。
 *
 * ⚠️ **也不能改回「超距静默消失」**（上一版踩过的坑）：那会让朝地面扔时
 * 「球飞到了但没炸」。两者的正解是同一个：**继续飞（往下掉）直到真的撞到东西**。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，不是 null ⇒ 必须判 `.hit`。
 *
 * @param {{next:object, world:object, registry:object, entities:object|null}} p
 *        `next` = 本步推进后的 state（由 `cinderDefinition.update` 给出）
 * @returns {{reason:'block'|'entity'|'void'|null, at?:number[], hitId?:string,
 *            normal?:number[], blockPos?:number[]}}
 *          `at` = **表面接触点**（世界坐标，block 与 entity 同口径）；`void` 不给 at。
 *          ⚠️ `at` **不再是格坐标** ⇒ 装配层不得再 `+0.5`（那会把爆心推进方块内部）。
 */
export function judgeCinder({ next, world, registry, entities }) {
  const from = next.prevPosition;
  const to = next.position;
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const stepLen = Math.hypot(dx, dy, dz);

  // 零位移帧（首帧 / dt=0）：没有穿越任何线段。
  // ⚠️ 不判这条会让归一化除零 ⇒ dir 变 NaN ⇒ DDA 静默走飞。
  if (stepLen > 1e-9) {
    const dir = [dx / stepLen, dy / stepLen, dz / stepLen];

    // ① 方块阻挡：DDA 遍历本步实际穿越的线段。遮挡只看 solid（见文件头 ⚠️）。
    const blockHit = raycastVoxel(world, from, dir, stepLen,
      (id) => id !== 0 && registry.solidTable[id] === 1);
    if (blockHit.hit) {
      /**
       * ⚠️⚠️ **取真实表面接触点，不是格坐标**（用户 2026-11-19：
       * 「碰到方块**表面**就爆炸，而不是跑到方块内部爆炸」）。
       *
       * DDA 已经给了 `dist`（进入该格的射线参数）与 `normal`（入射面法线），
       * 旧写法把它们丢了、只回 `blockPos`，装配层再 `+0.5` ⇒ 爆炸中心落在**块心**
       * （浏览器实测 `centerInsideSolid: true`，离顶面 0.5 格）。
       * `from + dir × dist` 就是射线与该格外表面的交点 —— 零额外几何。
       */
      const surf = blockSurfacePoint(from, dir, blockHit, world);
      return {
        reason: 'block',
        at: surf.at,
        normal: surf.normal,
        blockPos: [...blockHit.blockPos],
      };
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
  }

  /**
   * ③ 兜底回收（**静默，不爆**）：掉出世界底，或下落超时。
   *
   * ⚠️ 未加载列的 `getBlockId` 恒返 0（air）⇒ 岩石会一路掉穿。没有这道兜底
   * 就是**实体泄漏**（池只有 4 个 slot，满了之后新岩石静默生成失败）。
   * 它不给 `at` ⇒ 装配层不爆、不出视觉（与用户「碰到地面才爆」一致：
   * 掉进虚空/未加载区本来就没碰到地面）。
   */
  if (next.falling) {
    if (to[1] <= WORLD_MIN_Y) return { reason: 'void' };
    if (next.fall && next.fall.elapsed >= CFG.fallTimeoutSeconds) return { reason: 'void' };
  }
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