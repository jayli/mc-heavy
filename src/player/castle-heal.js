// src/player/castle-heal.js — 回城回血：城堡范围内的血量恢复推进（生命系统）
//
// ## 用户需求（2026-11-28）
//
// 「当玩家回到最初诞生时的城堡的位置，就自动回血完成，回血的过程是一个动画，
// 比如玩家现在只有一格血，回到 City 中心的城堡时，就 100ms 半格血的速度回血，直到满血。」
//
// 后续裁定（同轮）：「按你的判断做，每 100ms +1 格，直接开工」。
//
// ## 口径换算（为什么是「每 100ms +1 格」而不是「+0.5 格」）
//
// 本仓 `player/health.js` 的口径是**一颗心 = 2 格血、半颗心 = 1 格血**
// （v3.29 用户裁定把血量翻倍到 40 格 / 20 颗心，这个换算一行未改）。
// 用户说的「半格血」= **半颗心** = 1 格。若按 0.5 格累加，`heartsFor()` 向下取整到整格
// ⇒ HUD 会隔一拍才亮一次（一顿一顿）。按 1 格累加则每 100ms 稳定亮半颗心、4 秒回满。
//
// ## 为什么单独成模块
//
// 「在不在城堡里」与「这次该回多少」都是有对错可言的逻辑（范围边界、时间累积的
// 浮点漂移、上限钳制、非法值），必须能被 Tier 1 单测钉住。装配层（`core/game.js`）
// 只负责按帧把位置与 `nowMs` 喂进来、把结果写回 `player.health`。
//
// 纯常量 + 纯函数：**无 DOM、无 three、无 Gen 依赖**，与 `player/health.js` 同口径，
// 可在浏览器内单测里安全 import。
import { PLAYER_MAX_HEALTH } from './health.js';

/** 每多少毫秒回 1 格血（用户 2026-11-28 裁定：100ms 半格/半颗心） */
export const HEAL_INTERVAL_MS = 100;

/** 每次「回血 tick」恢复的格数（= 半颗心，见上面口径换算） */
export const HEAL_PER_TICK = 1;

/**
 * 回血范围的半宽（格，正方形 footprint，从城堡中心算起）。
 *
 * ## 为什么用「城堡中心 ± N」的方形，而不是 City bounds 或城堡 JSON 的 bbox
 *
 * - **City bounds 太大**：`halfSize` 实测可达 283 格（`expandBoundsIfNeeded` 有不受
 *   `CITY_SIZE_MAX` 钳制的增长路径）⇒ 整个城区都回血，「回到城堡」的语义消失。
 * - **城堡 JSON 的 bbox 太严**：产物本地 bbox 是 x∈[-23,23] × z∈[-23,26]，而四面城墙把
 *   玩家挡在外面 ⇒ 只有飞进去/挖进去才能回血，「回到城堡」变成不可达。
 *
 * 取 `CITY_STRUCTURE_FOOTPRINT.castle.halfX = 23` 的**外扩一圈**（城墙外侧也是「回到了
 * 城堡」的落地语义 —— 玩家从城门走回来就停在这里）。这个值**派生自 footprint 表**
 * （`tests/unit` 侧钉住），不另写一份权威。
 */
export const CASTLE_HEAL_HALF = 26;

/**
 * 判定某点是否在**回血范围**内（与城堡中心同轴的方形 footprint）。
 *
 * ## 语义三条（每条都有对错可言，单测逐条钉住）
 *
 * 1. **只看水平距离**，不看 y。城堡有 54 层高、中心列最高方块实测 y=21（天井）⇒ 若把 y
 *    也纳入，玩家站在城墙上、屋顶上、或脚下的地板抬高一格就会静默失去回血。用户要的是
 *    「回到城堡这个位置」，不是「站在某一层」。
 * 2. **边界算在内**（`<=`，闭区间）：站在正好 ±half 那格不该有 1 格的空档。
 * 3. **非法坐标一律 false**（NaN / Infinity / 非数）：NaN 比较恒 false 会「静默不回血」，
 *    那是缺陷形态而非崩溃 —— 显式返回 false 让它的原因唯一（位置无效，不是不在城堡）。
 *
 * @param {number} x 玩家世界 x（`physics.pos.x`，脚底中心）
 * @param {number} z 玩家世界 z
 * @param {{x: number, z: number}|null|undefined} center 城堡中心（装配层传 `spawnX/spawnZ`，
 *   那是出生点权威 —— castle 固定在 city 中心，`getCitySpawnPoint()` 返回的就是它）
 * @param {number} [half] 半宽（缺省 `CASTLE_HEAL_HALF`；单测可传小值）
 * @returns {boolean}
 */
export function isInCastleHealZone(x, z, center, half = CASTLE_HEAL_HALF) {
  if (!center) return false;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(center.x) || !Number.isFinite(center.z)) {
    return false;
  }
  const h = Number.isFinite(half) && half >= 0 ? half : CASTLE_HEAL_HALF;
  return Math.abs(x - center.x) <= h && Math.abs(z - center.z) <= h;
}

/**
 * 回血推进器：把「在城堡里待了多久」累积成「该回多少格」。
 *
 * ## 为什么不直接把 `nowMs` 差喂给帧循环算
 *
 * 两个理由，都是实测口径的取舍：
 * 1. **跨帧累积必须在同一份状态里**：每帧 dt 是 16.7ms 量级，而回血间隔是 100ms ⇒ 只有
 *    「攒够 100ms 才回一格」，否则每帧都回一点，4 秒回满变成 16 秒（而且数值不会是整数格，
 *    `heartsFor` 向下取整后 HUD 读数与真实血量漂移）。
 * 2. **离开城堡必须清零**：用户要的是「回到城堡就回血」，走开就停（不是暂停后继续）。
 *    把这条做进实现（而不是让调用方记得清）才不会漏。
 *
 * ## 浮点累积的实测坑（本仓既有教训）
 *
 * 累积用「余数留在 `_acc` 里」而不是「重置为 0」：后者会让每格的间隔变成
 * `ceil(100ms / 帧间隔) × 帧间隔`，60fps 下累积到 4.17s 差 4%（不可见但与常量不符）。
 * 本模块保留余数，`advance` 的返回值对**同一条时间轴**逐格可复现。
 *
 * ⚠️ 时间基准必须是调用方传入的 `performance.now()`，禁止 `Date.now()`
 * （与 `damage-flash.js` / `_consumeIgnisFxRequests` 同一口径）。
 */
export class CastleHeal {
  /**
   * @param {object} [cfg]
   * @param {number} [cfg.intervalMs] 每格间隔（缺省 `HEAL_INTERVAL_MS`）
   * @param {number} [cfg.perTick] 每次 tick 的格数（缺省 `HEAL_PER_TICK`）
   * @param {number} [cfg.maxHealth] 上限（缺省 `PLAYER_MAX_HEALTH`，红线 1 派生）
   */
  constructor({ intervalMs = HEAL_INTERVAL_MS, perTick = HEAL_PER_TICK, maxHealth = PLAYER_MAX_HEALTH } = {}) {
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : HEAL_INTERVAL_MS;
    this.perTick = Number.isFinite(perTick) && perTick > 0 ? perTick : HEAL_PER_TICK;
    this.maxHealth = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : PLAYER_MAX_HEALTH;
    /** 距上一次回血 tick 的累积毫秒数（离开城堡时清零） */
    this._acc = 0;
    /** 上一次喂进来的时间戳（`null` = 尚未见过一帧，用于首帧 dt = 0） */
    this._lastMs = null;
    /** 本帧是否正在回血（读给 HUD 做动画用；离开城堡/满血为 false） */
    this.active = false;
    /** 累计已回格数（诊断/测试用，不进存档） */
    this.totalHealed = 0;
  }

  /**
   * 清零累积（离开城堡 / 满血 / 传送时调用）。
   *
   * ⚠️ **同时清 `_lastMs`**：不清的话，离开很久再回来，第一帧的 dt 会是「离开期间的
   * 全部时长」⇒ 一帧回几百格（静默的「瞬间满血」）。清掉后回来首帧 dt = 0。
   */
  reset() {
    this._acc = 0;
    this._lastMs = null;
    this.active = false;
  }

  /**
   * 推进一帧。
   *
   * @param {object} p
   * @param {number} p.health 当前血量（格）
   * @param {boolean} p.inZone 本帧是否在城堡回血范围内（`isInCastleHealZone` 的结果）
   * @param {number} p.nowMs 帧循环的 `performance.now()`（调用方透传，不得在此新取）
   * @returns {number} 推进后的血量（格）。**调用方写回 `player.health`** —— 本方法不改
   *   任何外部状态（纯推进，可被单测直接验证）。
   */
  advance({ health, inZone, nowMs }) {
    // ---- 只有「在范围内 ∧ 未满血 ∧ 时间戳有效」三种情形才累积 ----
    // 满血时也必须 reset：否则站在城堡里满血待很久，出去挨一刀再回来，
    // 累积的时间还在 ⇒ 一回去就瞬间回一格（用户要的是「每 100ms 一格」的可见过程）。
    const hp = Number.isFinite(health) ? Math.max(0, Math.min(this.maxHealth, health)) : this.maxHealth;
    const full = hp >= this.maxHealth;
    if (!inZone || full || !Number.isFinite(nowMs)) {
      this.reset();
      return hp;
    }

    const last = this._lastMs;
    this._lastMs = nowMs;
    // 首帧（或无有效基准）dt = 0：不凭空回血。上限钳 0.1s 与帧循环 `realDt` 同一口径
    // —— 后台切回来时的大步长不得一次性回几十格。
    const dt = last === null ? 0 : Math.min(100, Math.max(0, nowMs - last));
    this._acc += dt;

    let next = hp;
    while (this._acc >= this.intervalMs) {
      this._acc -= this.intervalMs;
      next = Math.min(this.maxHealth, next + this.perTick);
      this.totalHealed += this.perTick;
      if (next >= this.maxHealth) {
        // 回满就立刻停：余数不再累积（否则满血后 HUD 动画会多亮一拍）
        this._acc = 0;
        this.active = false;
        return next;
      }
    }
    this.active = true;
    return next;
  }
}