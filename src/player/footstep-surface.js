// src/player/footstep-surface.js — 跑动脚步声「按地表选哪一路音」的唯一权威（v3.38）
//
// 用户 2026-11-24：**开启雨天光影**时，玩家进入**被雨淋的湿地**跑动要用 `running_wet.wav`；
// 回到非淋雨区就回 `running_land.mp3`；**未开启雨天光影**时始终 `running_land.mp3`。
//
// ## 为什么单独一个模块（而不是在 `player.js` 里写 if/else）
//
// `player.js` 依赖 three + DOM，无法在 Node 单测里驱动；本模块是纯函数 + 冻结常量，
// 交 `test-footstep-surface.js` 钉住三档优先级与三卷音量（与 `view-bob.js` / `step-lift.js`
// 同一手法）。判据本体（头顶有没有屋顶、方块会不会湿）在 `render/rain-shelter.js` ——
// 这里只做**优先级**，不重写任何一条判据（红线 1）。
//
// ## 三档优先级
//
//   ① **入水**（`physics.inWater`，身体格是水）→ `water`：沿用 v3.37 的 `running_wet` 0.25。
//      ⚠️ 它**优先于**雨天湿地：湖面淋着雨，但玩家已经在水里，那一路更响更贴切。
//   ② **雨天湿地**（雨天档开着 ∧ 脚下会湿 ∧ 头顶无屋顶）→ `wet`：`running_wet` **0.2**。
//   ③ 其余 → `land`：`running_land` 0.2（含「未开启雨天光影」的一切情形 —— 那条路径由
//      注入谓词恒 false 保证，本模块不需要知道开关本身）。
//
// ## 为什么湿地取 0.2 而不是与入水一样的 0.25（用户 2026-11-24 裁定）
//
// `running_wet.wav` 是全片 RMS 对齐 `running_land` 烘焙的（见 `footstep-water-recipe.js`）
// ⇒ 与陆地同档时**过界只换音色、不跳音量**。取 0.25 会在进出屋檐的瞬间多出约 2 dB 的
// 音量台阶，听感是「突然变响」而不是「踩到水」。
//
// ⚠️ 本文件不 import three、不碰 DOM（Node 单测直接 import）。

/** 脚步声地表（`footstepSurfaceOf` 的返回值域）。 */
export const FOOTSTEP_SURFACE = Object.freeze({
  /** 入水（身体格是水） */
  WATER: 'water',
  /** 雨天被雨淋着的湿地 */
  WET: 'wet',
  /** 其余（干地 / 未开启雨天档 / 不知道） */
  LAND: 'land',
});

/**
 * 地表 → 循环音效（id + 音量）。**唯一权威**：`player._updateFootsteps()` 只查这张表，
 * 不在别处写 `'running_wet'` / `0.25` 这类字面量（写两份会在调音量时漂移）。
 *
 * ⚠️ `water` 与 `wet` **共用同一个 id**（`running_wet`）—— 这不是笔误：
 *    它们是同一个音频素材、只是音量与语义不同。因此「停另一路」不能靠 id 互斥
 *    （`playLoop` 同名只改音量），必须由调用方按本模块给的 surface 决定停谁。
 */
export const FOOTSTEP_LOOPS = Object.freeze({
  water: Object.freeze({ id: 'running_wet', volume: 0.25 }),
  wet: Object.freeze({ id: 'running_wet', volume: 0.2 }),
  land: Object.freeze({ id: 'running_land', volume: 0.2 }),
});

/**
 * 另一个地表对应的音效 id（用于「两路互斥」）。同 id 时返回 null。
 * @param {'water'|'wet'|'land'} surface
 * @returns {string|null}
 */
export function otherFootstepId(surface) {
  const cur = FOOTSTEP_LOOPS[surface];
  if (!cur) return null;
  for (const key of Object.keys(FOOTSTEP_LOOPS)) {
    const other = FOOTSTEP_LOOPS[key];
    if (other.id !== cur.id) return other.id;
  }
  return null;
}

/**
 * 本帧该用哪一路脚步声。
 *
 * @param {{inWater?: boolean, onRainWetGround?: boolean}} s
 *   `inWater`            `physics.inWater`（身体格是水）
 *   `onRainWetGround`    装配层注入的谓词结果：**雨天档开着 ∧ 脚下会湿 ∧ 头顶无屋顶**
 *                        （判据本体在 `render/rain-shelter.js` 的 `rainWetGround`）
 * @returns {'water'|'wet'|'land'}
 */
export function footstepSurfaceOf({ inWater = false, onRainWetGround = false } = {}) {
  if (inWater === true) return FOOTSTEP_SURFACE.WATER;
  if (onRainWetGround === true) return FOOTSTEP_SURFACE.WET;
  return FOOTSTEP_SURFACE.LAND;
}