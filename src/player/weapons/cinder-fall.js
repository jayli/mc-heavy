// src/player/weapons/cinder-fall.js — Cinder Fall 的弹道与命中纯函数（v3.21）
//
// **无 three、无 DOM**（与 `storm-lance.js` / `mag7-pattern.js` 同口径）：
// controller、实体 definition 与浏览器内单测都能直接驱动。
//
// ## 为什么是「叠加拱起」而不是独立弹道（本模块最载荷性的一条）
//
// 上游 `MeteorAbility._arcPoint` 的竖直项是 `lerp(handHeight, endHeight, t)`，
// 那两个高度是**离地板的绝对米数**（沙盒地板恒 y=0）。本仓地形起伏，照抄会让岩石
// 在山上插进地里、在洞里飘到天花板上方 —— 与 Storm Lance 同一条教训。
//
// 本仓口径：**末端锚在准心瞄准点**，拱起是叠加在 `origin→target` 直线上的一个 bump：
//   p(t) = lerp(origin, target, t) + up_world · arc · sin(t·π)^arcCurve
// ⇒ 仰视/俯视时末端照样落在准心上（瞄准手感不变），只是中段更高。
// 写成「先抛后落」的独立弹道时，抬头扔会打不到准心指向的地方，而**飞行看着完全正常**。
//
// ## 入参是 aim 基底，不是 yaw
//
// `player.js:_buildAim()` 是「相机前向/右/上」的唯一来源。在这里再从 yaw 推一遍前向
// 就是第二份权威（yaw→前向的口径按实体类型不同，AGENTS.md 已记）。
import { WEAPONS, WEAPON_IDS } from './weapon-catalog.js';

/** 实体 type（`EntityManager` 注册键，也是渲染器的过滤键） */
export const CINDER_TYPE = 'cinder';

const CFG = WEAPONS[WEAPON_IDS.SWORD].cinderFall;

/**
 * 岩石 AABB：`radius` 见方的小盒（与火球 `FIREBALL_AABB` / 弹丸 `PROJECTILE_AABB` 同手法）。
 * ⚠️ 用真实半径而不是 probe 的 0.3：命中判据必须用真实尺寸。
 */
export const CINDER_AABB = Object.freeze({
  min: Object.freeze([-CFG.radius, -CFG.radius, -CFG.radius]),
  max: Object.freeze([CFG.radius, CFG.radius, CFG.radius]),
});

const sat = (x) => Math.max(0, Math.min(1, x));

/**
 * 组装一次抛掷的弹道参数（**冻结起点与瞄准点**，与曳光同口径：
 * 抛出后镜头移动不影响已在飞的岩石）。
 *
 * @param {{origin:number[], forward:number[], right:number[], up:number[]}} aim
 * @param {{range:number, handOffset:number[], arc:number, arcCurve:number}} cfg
 * @param {number} aimDistance 准心命中距离（格）；非法/超射程一律钳到 `range`
 * @returns {{origin:number[], target:number[], distance:number,
 *            arc:number, arcCurve:number, degenerate:boolean}}
 *          `degenerate` = 水平距离为 0（垂直朝上/下）⇒ 退化成直线，见 `cinderArcPoint`
 */
export function cinderLaunch(aim, cfg, aimDistance) {
  const [hr, hu, hf] = cfg.handOffset;
  const o = aim.origin, f = aim.forward, r = aim.right, u = aim.up;
  const origin = [
    o[0] + r[0] * hr + u[0] * hu + f[0] * hf,
    o[1] + r[1] * hr + u[1] * hu + f[1] * hf,
    o[2] + r[2] * hr + u[2] * hu + f[2] * hf,
  ];
  const raw = Number.isFinite(aimDistance) && aimDistance > 0 ? aimDistance : cfg.range;
  const distance = Math.min(cfg.range, raw);
  const target = [
    origin[0] + f[0] * distance,
    origin[1] + f[1] * distance,
    origin[2] + f[2] * distance,
  ];
  // 水平分量为 0 ⇒ 拱起没有「中段」可言（t 的参数化仍成立，但 bump 会把垂直路径推歪）
  const horizontal = Math.hypot(target[0] - origin[0], target[2] - origin[2]);
  return {
    origin,
    target,
    distance,
    arc: cfg.arc,
    arcCurve: cfg.arcCurve,
    degenerate: !(horizontal > 1e-6),
  };
}

/**
 * 弹道上一点（`t` ∈ [0,1]，0 = 手点、1 = 瞄准点）。
 *
 * ⚠️ **垂直退化**（`degenerate`）时不叠 bump：朝正上方扔时「拱起」会把路径推向侧面，
 * 末端就不再是准心指向的地方。此时退化成直线（单测钉住）。
 *
 * @param {ReturnType<typeof cinderLaunch>} launch
 * @param {number} t
 * @returns {number[]} 世界坐标（每次全新数组）
 */
export function cinderArcPoint(launch, t) {
  const k = sat(Number.isFinite(t) ? t : 0);
  const a = launch.origin, b = launch.target;
  const bump = launch.degenerate ? 0
    : launch.arc * Math.pow(Math.sin(k * Math.PI), Math.max(0.05, launch.arcCurve));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k + bump,
    a[2] + (b[2] - a[2]) * k,
  ];
}

/**
 * 按「已飞行路程」求弹道参数 t。
 *
 * ⚠️ **用路程比例而不是弧长积分**：`speed` 的语义是「沿弹道推进的速率」，
 * 取 `traveled / distance` 让 20 格射程恰好用 `range/speed` 秒飞完 ——
 * 这正是冷却推导（`weapon-catalog.js` 的 `cinderFall.cooldown`）所依赖的关系式。
 * 真实弧长比直线距离长（拱起），故实际速度略高于 `speed`，这是刻意的简化：
 * 换成弧长积分会让飞行时长与冷却推导脱钩（单槽前提静默失效）。
 *
 * @param {number} traveled @param {number} distance @returns {number} 0..1
 */
export function cinderParamAt(traveled, distance) {
  if (!(distance > 0)) return 1;
  const d = Number.isFinite(traveled) ? traveled : 0;
  return sat(d / distance);
}

/**
 * 推进 + 判定一次完成 —— **单测夹具**（照 `advanceFireball` / `advanceProjectile` 同位置）。
 *
 * ⚠️ Game 帧循环**不用**它：推进已由 `entities.update()` 驱动，两处推进会让速度翻倍
 * （与弹丸/火球「两处推进」同一类缺陷）。
 *
 * ⚠️ **判定器经参数注入**（`judge`）而不是在此 import 实体模块：
 * `player/` 不得反向依赖 `entities/`（后者已经 import 本模块的纯几何，
 * 再反向 import 就是循环）。单测传真 `judgeCinder` 进来 ⇒ 仍验的是生产代码。
 *
 * @param {{state:object, dt:number, world:object, registry:object,
 *          entities:object|null, advance:Function, judge:Function}} p
 * @returns {{state:object, alive:boolean, reason?:string, at?:number[], hitId?:string}}
 */
export function cinderAdvance({ state, dt, world, registry, entities, advance, judge }) {
  const next = advance({ state }, dt, {});
  if (!next) return { state, alive: false, reason: 'invalid-state' };
  const { reason, at, hitId } = judge({ next, world, registry, entities });
  if (reason) {
    return { state: next, alive: false, reason, ...(at ? { at } : {}), ...(hitId ? { hitId } : {}) };
  }
  return { state: next, alive: true };
}