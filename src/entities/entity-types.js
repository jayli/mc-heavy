// src/entities/entity-types.js — M5：实体类型定义与 state 校验 helper
//
// 同构层：**无 DOM、无 three、不新增 Worker**（M5 规格 §2；`npm run check:arch` 静态门守）。
// definition 只提供纯函数 create/update/raycastAabb/serialize/deserialize —— 渲染层与
// Scheduler 都只经 EntityManager 消费这些函数，不得持有第二份实体逻辑。
//
// M5 只交付 `probe` 一种类型（render contract fixture / 单测载体）：M6 丧尸、炮塔弹丸、
// 矿车各自注册自己的 definition，不在本文件里预埋玩法。
import { columnKeyAt } from '../voxel/constants.js';

/** probe 的 AABB（相对 state.position 的局部偏移）：0.6×1.8×0.6 的人形盒 */
export const PROBE_AABB = Object.freeze({
  min: Object.freeze([-0.3, 0, -0.3]),
  max: Object.freeze([0.3, 1.8, 0.3]),
});

/**
 * 「哪些实体类型可被武器 / 炮塔弹丸击中」的**唯一权威**（v2.41 祭坛飞龙）。
 *
 * 三个消费方都从它派生（红线 1：各写一份会漂移出「枪打得到但炮塔打不到」的撕裂语义）：
 *  ① `weapon-controller.js` 的实体射线 predicate（经 Game 注入的 `isHittable`）；
 *  ② `projectile-system.js` 的弹丸命中 predicate（同层 import）；
 *  ③ `turret-system.js` 的索敌目标集合（由 Game 构造 `targets` 时决定放谁进去）。
 *
 * ⚠️ **加新的可击中实体类型时只改这一处**。⚠️ 弹丸（`projectile`）与矿车（`minecart`）
 * **刻意不在里面**：弹丸互相命中会连锁误伤，矿车是玩家资产不是敌对目标。
 */
export const WEAPON_HITTABLE_TYPES = Object.freeze(['zombie', 'dragon']);

/**
 * position 合法性：必须是 3 个有限数。
 * 校验放在类型侧而非 manager 侧 —— 各类型的 state 形状不同（M6 丧尸还有 yaw/health），
 * 只有 definition 知道自己的合法形状（M5 规格 §2「spawn 仅在 definition.create(state)
 * 返回合法 state 时成功」）。
 * @param {*} position
 * @returns {[number,number,number]|null}
 */
export function normalizePosition(position) {
  if (!Array.isArray(position) || position.length !== 3) return null;
  const [x, y, z] = position;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/** 世界 position → 派生 column key（几何推导唯一权威 = `voxel/constants.js` 的 columnKeyAt） */
export function columnKeyOfPosition(position) {
  return columnKeyAt(position[0], position[2]);
}

/**
 * 射线 vs AABB（slab 法，Amanatides-Woo 的连续版）。
 *
 * 为什么是纯 AABB 而不是 three mesh 求交：红线 6 要求地形交互走体素 DDA，而**实体命中只由
 * `EntityManager.raycast()` 给出**（M5 规格 §2）—— 命中真相是实体的逻辑 AABB，不是渲染节点。
 * 渲染层因此不得参与命中判定（`entity-render-layer.js` 只读 pose）。
 *
 * @param {{position:[number,number,number]}} state
 * @param {[number,number,number]} origin
 * @param {[number,number,number]} dir **已归一化**（调用方 EntityManager 负责）
 * @param {number} maxDist
 * @param {{min:number[],max:number[]}} [aabb] 缺省用 PROBE_AABB
 * @returns {number|null} 进入距离 t（>=0，<=maxDist）；未命中返回 null
 */
export function raycastAabbSlab(state, origin, dir, maxDist, aabb = PROBE_AABB) {
  if (!state || !Array.isArray(state.position)) return null;
  const [px, py, pz] = state.position;
  let tEnter = 0;
  let tExit = maxDist;
  for (let axis = 0; axis < 3; axis++) {
    const lo = aabb.min[axis] + (axis === 0 ? px : axis === 1 ? py : pz);
    const hi = aabb.max[axis] + (axis === 0 ? px : axis === 1 ? py : pz);
    const o = origin[axis];
    const d = dir[axis];
    if (d === 0) {
      // 射线平行该轴：起点必须已在 slab 内，否则永不进入
      if (o < lo || o > hi) return null;
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    if (tEnter > tExit) return null;
  }
  // 起点已在盒内 → tEnter=0（命中自己脚下的实体，dist 0 合法）
  if (tEnter > maxDist || tExit < 0) return null;
  return tEnter;
}

/**
 * probe 类型定义（M5 fixture）。
 * `update` 是 no-op —— M5 不交付任何玩法运动；M6 丧尸注册自己的 definition 时才接 AI 回包。
 */
export const probeDefinition = Object.freeze({
  /** @param {*} state @returns {{position:[number,number,number]}|null} */
  create(state) {
    const position = normalizePosition(state && state.position);
    return position ? { position } : null;
  },
  /** M5 无玩法运动：state 原样返回（签名对齐 M6 的 AI 回包消费点） */
  update(entity) { return entity.state; },
  raycastAabb: raycastAabbSlab,
  /** 最小 snapshot：只有 position（M5 规格 §3「snapshot 形状严格为 {id,type,state}」） */
  serialize(state) {
    const position = normalizePosition(state && state.position);
    return position ? { position } : null;
  },
  deserialize(raw) {
    const position = normalizePosition(raw && raw.position);
    return position ? { position } : null;
  },
});
