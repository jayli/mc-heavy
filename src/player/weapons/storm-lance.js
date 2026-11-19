// src/player/weapons/storm-lance.js — Storm Lance 的几何与命中纯函数（v3.20）
//
// **无 three、无 DOM**（与 `mag7-pattern.js` 同口径）：controller 与浏览器内单测都能直接驱动。
// 渲染层只消费本模块算出的 `origin/target/side/length`，不自己再推一遍（红线 1）。
//
// ## 入参是 aim 基底，不是 yaw
//
// `player.js:_buildAim()` 是「相机前向/右/上」的唯一来源。在本模块里再从 yaw 推一遍前向
// 就是第二份权威 —— 而 yaw→前向的口径按实体类型不同（丧尸 `atan2(vx,vz)` vs
// Boss `atan2(-dx,-dz)`，AGENTS.md 已记），照错一侧的形态是整条闪电偏 180°。
//
// ## 命中用十字五射线，不是单射线也不是 3×3
//
// 闪电束是**有粗细的**（远端半宽 `radius`）。单条轴线射线会漏掉「偏离轴心但在束半径内」
// 的敌人；而 MAG7 那套 3×3 截面的四个角在 `√2·r ≈ 1.06` 格处，**落在圆柱外** ⇒ 会打到束外敌人。
// 十字（轴线 + right/up 各 ±r）是圆的内接采样，宁可略保守。
//
// 五条射线各自复用 `definition.raycastAabb`（经 `EntityManager.raycastAll`）——
// **不自己写一份膨胀 AABB**：各类型的盒由自己的 `xxxAabbFor(state)` 给出（焰魔/守卫还随 yaw 旋转），
// 从外部注入膨胀量做不到，写第二份几何必然漂移。
import { raycastVoxel } from '../raycast.js';

/**
 * 蓄力进度（0..1）。**前 `chargeDelaySeconds` 秒恒 0**。
 *
 * ⚠️⚠️ 静默期是用户明确要求（2026-11-19）：「按下一秒后开始启动蓄力……不然我只需要
 * 挥刀的时候也会触发蓄力的动画，画面就太乱了」。按下边沿仍照旧挥一刀，但那 1 秒里
 * **不得有任何蓄力视觉** —— 本函数的返回值是渲染层唯一的开关，故延迟必须落在这里，
 * 不能只在 UI 侧藏环（那样光球与吸入粒子仍会画出来）。
 *
 * 非法值一律钳到 0（不抛异常 —— 缺陷形态是静默画错，不是崩溃）。
 *
 * @param {number} elapsedSeconds 自按下左键起的秒数
 * @param {{chargeDelaySeconds: number, chargeSeconds: number}} cfg
 * @returns {number}
 */
export function stormChargeProgress(elapsedSeconds, cfg) {
  const t = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
  const delay = Number.isFinite(cfg?.chargeDelaySeconds) && cfg.chargeDelaySeconds >= 0
    ? cfg.chargeDelaySeconds : 0;
  const d = Number.isFinite(cfg?.chargeSeconds) && cfg.chargeSeconds > 0 ? cfg.chargeSeconds : 0;
  if (!(d > 0)) return 0;
  if (t <= delay) return 0;
  return Math.max(0, Math.min(1, (t - delay) / d));
}

/**
 * 闪电的轴线几何（**不含遮挡** —— 那由 `stormLanceSweep` 覆盖 `length`）。
 *
 * `origin` = 相机位置 + right·handOffset[0] + up·handOffset[1] + forward·handOffset[2]，
 * 读作「从剑尖射出」而不是「从眼睛射出」。`side` 直接取 `aim.right`。
 *
 * ⚠️ **不用上游的 `handHeight`/`endHeight`**：那是「离地板的绝对米数」（沙盒地板恒 y=0）。
 * 本仓地形起伏，照抄会让闪电在山上插进地里、在洞里飘到天花板上方。
 *
 * @param {{origin:number[], forward:number[], right:number[], up:number[]}} aim
 * @param {{range:number, handOffset:number[]}} cfg
 * @returns {{origin:number[], target:number[], side:number[], length:number}}
 */
export function stormLanceAxis(aim, cfg) {
  const [hr, hu, hf] = cfg.handOffset;
  const o = aim.origin, f = aim.forward, r = aim.right, u = aim.up;
  const origin = [
    o[0] + r[0] * hr + u[0] * hu + f[0] * hf,
    o[1] + r[1] * hr + u[1] * hu + f[1] * hf,
    o[2] + r[2] * hr + u[2] * hu + f[2] * hf,
  ];
  const target = [
    origin[0] + f[0] * cfg.range,
    origin[1] + f[1] * cfg.range,
    origin[2] + f[2] * cfg.range,
  ];
  return { origin, target, side: [...r], length: cfg.range };
}

/**
 * 十字截面的五条偏移 `[right 分量, up 分量]`（格）。首条恒为轴线 `[0,0]`。
 * @param {{radius:number}} cfg
 * @returns {Array<[number, number]>}
 */
export function stormLanceOffsets(cfg) {
  const r = cfg.radius;
  return [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]];
}

/**
 * 五射线扫描：算出几何 + 命中的全部实体（**纯函数，不扣血**）。
 *
 * ## ⚠️⚠️ `length` 截到**首个命中实体的表面**（用户 2026-11-19 明确要求）
 *
 * 原话：「碰撞到 boss 身体要立即爆炸」「就在击中碰撞身体的位置爆炸，而不是穿过身体
 * 到 boss 身体后方的方块触碰处爆炸」。
 *
 * 口径：
 *   axisLength = min(range, 轴线方块 DDA 距离)
 *   firstHit   = **五条射线全部命中里** dist 最小的那个
 *   firstHit.dist < axisLength ⇒ length = firstHit.dist，impactKind='entity'
 *
 * ⚠️ **必须取五条的最小值，不能只查轴线那条的实体命中**：Boss 体积大且盒随 yaw 旋转，
 * 偏移射线常比轴线更早碰到它。只查轴线会让「侧面擦到」仍穿身炸到后面的墙上。
 *
 * ⚠️ **落点仍取轴线上的截断点**（不是偏移射线自己的命中点）：闪电本体沿轴线，
 * 拿偏移点当落点会让爆壳画歪到束的一侧。
 *
 * 扣血由装配层（`Game._stormLanceSweep`）逐个调 `damageEntity` 完成 —— 它按实体类型
 * 分发到 zombie/dragon/ignis/guardian。⚠️ **不得改用 `_damageEntitiesInRadius`**：
 * 那个函数只遍历 `zombies.activeEntities()`，Boss 压根打不到。
 *
 * @param {{world: object, entities: {raycastAll: Function},
 *          isHittable?: (entity:object)=>boolean, aim: object, cfg: object}} p
 * @returns {{origin:number[], target:number[], side:number[], length:number,
 *            impactKind:'entity'|'block'|'air', hits:Array<{id:string,type:string,dist:number}>}}
 */
export function stormLanceSweep({ world, entities, isHittable, aim, cfg }) {
  const axis = stormLanceAxis(aim, cfg);
  const f = aim.forward, r = aim.right, u = aim.up;
  const hittable = isHittable ?? ((entity) => entity.type === 'zombie');
  const best = new Map();
  let axisLength = cfg.range;
  let axisBlocked = false;
  let nearest = Infinity;

  const offsets = stormLanceOffsets(cfg);
  for (let i = 0; i < offsets.length; i++) {
    const [dr, du] = offsets[i];
    const origin = [
      axis.origin[0] + r[0] * dr + u[0] * du,
      axis.origin[1] + r[1] * dr + u[1] * du,
      axis.origin[2] + r[2] * dr + u[2] * du,
    ];
    // 该条射线的方块遮挡距离（无命中 = Infinity ⇒ 实体永远「更近」，可正常受伤）
    const block = raycastVoxel(world, origin, f, cfg.range);
    const reach = Math.min(cfg.range, block.hit ? block.dist : Infinity);
    if (i === 0) { axisLength = reach; axisBlocked = !!block.hit; }
    if (!(reach > 0)) continue;
    for (const hit of entities.raycastAll(origin, f, reach, hittable)) {
      // 参与截断的是**全部五条**的最小 dist（见上方 ⚠️）
      if (hit.dist < nearest) nearest = hit.dist;
      const prev = best.get(hit.id);
      if (!prev || hit.dist < prev.dist) {
        best.set(hit.id, { id: hit.id, type: hit.type, dist: hit.dist });
      }
    }
  }

  // 实体比方块更近 ⇒ 截到实体表面（严格小于：相等按方块优先，与武器既有口径一致）
  const hitEntity = nearest < axisLength;
  const length = hitEntity ? nearest : axisLength;
  const impactKind = hitEntity ? 'entity' : (axisBlocked ? 'block' : 'air');

  return {
    origin: axis.origin,
    target: [
      axis.origin[0] + f[0] * length,
      axis.origin[1] + f[1] * length,
      axis.origin[2] + f[2] * length,
    ],
    side: axis.side,
    length,
    impactKind,
    hits: [...best.values()].sort((a, b) => a.dist - b.dist),
  };
}