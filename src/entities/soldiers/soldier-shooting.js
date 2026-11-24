// src/entities/soldiers/soldier-shooting.js — 士兵开火判定（同构纯函数）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 静态门守）。
//
// 上游 `enemies.js` 的 `Enemy.shootAt()` 是 **hitscan**（不是飞行弹丸）：
// 掷一次命中骰子决定「这一发算不算打中玩家」，然后沿方向找落点。本模块把
// 「骰子的概率」「未命中的散布点」「弹道的几何判定」三件拆成纯函数。
//
// ## ⚠️ 骰子与几何是两件事，都要过
//
// 上游只有骰子（它的 `hasLos` 已在 `sees()` 里判过）。本仓多一道 DDA：体素世界
// 随时被玩家挖改，而 Agent 的视线是 10Hz 缓存 ⇒ 缓存说「看得见」时墙可能已经砌起来了。
// 少了这道 DDA 的形态是**士兵穿墙打人**（血量掉了，画面上子弹却该被墙挡住）。
//
// ## 本模块不掷骰子、不扣血
//
// 骰子在 Agent 里（它要跨帧记 `firstBurst`），扣血在装配层（`_damagePlayer` 唯一入口）。
// 这里只回答「概率是多少」「弹着点在哪」。
import { SOLDIER_SHOT } from './soldier-config.js';
import { raycastAabbSlab } from '../entity-types.js';
import { raycastVoxel } from '../../player/raycast.js';
import { isProjectileOccluding } from '../turrets/turret-system.js';

/** [0,1] 钳制 */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * 本发的命中概率（上游 `shootAt` 的 `chance` 逐项）。
 *
 * `chance = clamp(accuracy − d×0.011 − speed×0.03 − (grounded ? 0 : 0.12), 0.06, 0.82)`
 *
 * @param {{accuracy:number, distance:number, playerSpeed:number, playerGrounded:boolean}} p
 * @returns {number} 0.06..0.82
 */
export function soldierHitChance({ accuracy, distance, playerSpeed, playerGrounded }) {
  const a = Number.isFinite(accuracy) ? accuracy : 0;
  const d = Number.isFinite(distance) ? distance : 0;
  const s = Number.isFinite(playerSpeed) ? playerSpeed : 0;
  const raw = a - d * SOLDIER_SHOT.accuracyPerBlock - s * SOLDIER_SHOT.accuracyPerSpeed
    - (playerGrounded === false ? SOLDIER_SHOT.accuracyAirPenalty : 0);
  return clamp(raw, SOLDIER_SHOT.accuracyMin, SOLDIER_SHOT.accuracyMax);
}

/**
 * 未命中时的散布弹着点（上游：玩家周围随机角度 + 半径 0.5~1.6、高度 +0.4~2.0）。
 *
 * @param {number[]} playerPos 玩家脚底
 * @param {() => number} rand [0,1) 均匀随机（可注入以便断言）
 * @returns {[number,number,number]}
 */
export function soldierMissPoint(playerPos, rand) {
  const a = rand() * Math.PI * 2;
  const r = SOLDIER_SHOT.missRadiusMin + rand() * SOLDIER_SHOT.missRadiusRange;
  return [
    playerPos[0] + Math.cos(a) * r,
    playerPos[1] + SOLDIER_SHOT.missYMin + rand() * SOLDIER_SHOT.missYRange,
    playerPos[2] + Math.sin(a) * r,
  ];
}

/**
 * 弹道判定：从枪口沿 target 方向找**最近的阻挡者**（方块或玩家盒）。
 *
 * 顺序（载荷性）：
 * ① 归一化方向；② 体素 DDA（遮挡判据 `isProjectileOccluding` = solid && opaque，
 * 与炮塔弹丸同源 ⇒ 玻璃穿透、树叶阻挡）；③ 玩家 AABB；④ **方块严格更近时按方块优先**
 * （与武器侧 `_queryEntityHit` 同口径，相等也算方块优先）。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，必须判 `.hit`。
 * ⚠️ 玩家盒由装配层注入（`playerHitboxLocal()`）—— 玩家不是 EntityManager 成员，
 * 这是 `fireball-system.js` 已确立的核准例外，不是绕过实体命中权威。
 *
 * @param {{muzzle:number[], target:number[], world:object, registry:object,
 *          player:{position:number[], aabb:{min:number[],max:number[]}}|null,
 *          maxDistance:number}} p
 * @returns {{end:number[], normal:number[]|null, hitPlayer:boolean, blockPos:number[]|null}}
 */
export function judgeSoldierShot({ muzzle, target, world, registry, player, maxDistance }) {
  const dx = target[0] - muzzle[0];
  const dy = target[1] - muzzle[1];
  const dz = target[2] - muzzle[2];
  const len = Math.hypot(dx, dy, dz);
  // 零长度（枪口恰在目标上）：无方向可言，直接返回枪口点
  if (!(len > 1e-9)) {
    return { end: [...muzzle], normal: null, hitPlayer: false, blockPos: null };
  }
  const dir = [dx / len, dy / len, dz / len];
  const reach = Number.isFinite(maxDistance) ? maxDistance : SOLDIER_SHOT.maxDistance;

  // ② 方块阻挡
  const blockHit = raycastVoxel(world, muzzle, dir, reach,
    (id) => isProjectileOccluding(id, registry));
  const blockDist = blockHit.hit ? blockHit.dist : Infinity;

  // ③ 玩家盒
  let playerDist = Infinity;
  if (player && Array.isArray(player.position) && player.aabb) {
    const t = raycastAabbSlab({ position: player.position }, muzzle, dir, reach, player.aabb);
    if (t !== null) playerDist = t;
  }

  // ④ 方块严格更近 ⇒ 方块优先（相等也算方块，保证不穿墙）
  if (blockHit.hit && blockDist <= playerDist) {
    return {
      end: [
        muzzle[0] + dir[0] * blockDist,
        muzzle[1] + dir[1] * blockDist,
        muzzle[2] + dir[2] * blockDist,
      ],
      normal: blockHit.normal ?? null,
      hitPlayer: false,
      blockPos: blockHit.blockPos,
    };
  }
  if (playerDist < Infinity) {
    return {
      end: [
        muzzle[0] + dir[0] * playerDist,
        muzzle[1] + dir[1] * playerDist,
        muzzle[2] + dir[2] * playerDist,
      ],
      normal: null,
      hitPlayer: true,
      blockPos: null,
    };
  }
  // 都没命中：弹道飞满射程
  return {
    end: [muzzle[0] + dir[0] * reach, muzzle[1] + dir[1] * reach, muzzle[2] + dir[2] * reach],
    normal: null,
    hitPlayer: false,
    blockPos: null,
  };
}