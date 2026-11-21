// src/player/health.js — 玩家血量的唯一权威（生命系统显示层）
//
// 纯常量 + 纯函数模块：**无 DOM、无 three** —— 与 `render/pixel-ratio.js` 同口径，
// 可在浏览器内单测（`src/tests/test-health.js`）里安全 import。
//
// ## 口径（原版 Minecraft，v3.29 起血量翻倍）
//
// - 满血 = **40 格**（`PLAYER_MAX_HEALTH`）；
// - 用 **20 颗心**表示（`PLAYER_MAX_HEARTS`），每颗心 = 2 格血；
// - **半颗心 = 1 格血**（用户明确要求，与原版一致）。
//
// ⚠️ **v3.29（用户 2026-11-21）：「玩家的血量默认在增加一倍」** ⇒ 20 → 40 格、10 → 20 颗心。
// 每颗心仍代表 2 格血（半心 = 1 格），所以 `heartsFor()` 的换算逻辑**一行未改** ——
// 它按 `HEALTH_PER_HEART` 派生、按 `PLAYER_MAX_HEARTS` 定长度，两个常量改完就自动跟着变。
// 翻倍的原因是同期给焰魔新增了两处小额伤害源（法阵 1 格 / 尖刺 1 格）：20 格上这些数字读不出分量。
// 连带推翻的旧标定：焰魔一刀 14 ⇒ 原本「两刀即死」的压迫感，现在变成三刀（40 ÷ 14）。
//
// ## 为什么单独成模块
//
// 「血量 → 心形数组」的换算是**有对错可言的逻辑**（半心、越界、非法值的边界），
// 必须能被 Tier 1 单测钉住。渲染层（`ui/health-hud.js`）只消费 `heartsFor()` 的输出，
// 不自己再算一遍（红线 1：同一事实只有一份权威）。
//
// ## 当前阶段（用户裁定）
//
// v2.55 起**焰魔会扣玩家血**（近战挥砍），故本模块新增 `applyDamage()`：
// 「扣血 → 钳制到 [0, PLAYER_MAX_HEALTH]」的纯函数。
//
// ⚠️ **用户 2026-11-05 裁定「只扣血，不做死亡」**：血降到 0 就**停在 0**，
// 不弹死亡界面、不重生、不回血。故本模块**没有**死亡判定与恢复逻辑。
// 也不入存档：`Player.health` 不写 `meta` 行 ⇒ **重进游戏回满血**。
// 这是有意的取舍 —— 把 health 写进存档需要 `settingsVersion` 迁移，而「重进就回满」
// 对「只扣血不死亡」的当前阶段是合理语义（用户没要求持久化）。

/** 玩家满血格数（原版口径 20；v3.29 用户 2026-11-21 裁定翻倍到 40） */
export const PLAYER_MAX_HEALTH = 40;

/** 血心的颗数（原版口径 10；v3.29 用户 2026-11-21 裁定翻倍到 20） */
export const PLAYER_MAX_HEARTS = 20;

/** 每颗心对应的血量格数（2 = 半颗心 1 格血的数学表达） */
const HEALTH_PER_HEART = PLAYER_MAX_HEALTH / PLAYER_MAX_HEARTS;

/**
 * 把血量换算成 `PLAYER_MAX_HEARTS` 颗心的形态数组（渲染层按位画，长度恒为 `PLAYER_MAX_HEARTS`）。
 *
 * 每颗心取值 `'full'`（满）/ `'half'`（半）/ `'empty'`（空），从左到右排列。
 * 换算规则：每颗心 = 2 格血，半颗心 = 1 格血（原版口径）。
 *
 * ⚠️ **越界与非法值一律钳制，不抛异常**：
 *   - `health > PLAYER_MAX_HEALTH` → 全满（未来若有吸收/增益不画出第 21 颗心）；
 *   - `health < 0` / `NaN` / 非数 → 全空（缺陷形态是静默画错，不是崩溃）；
 *   - 小数血向下取整到格（`1.9 → 1` 格亮点 = 首颗半心）。
 *
 * @param {number} health 当前血量（格）
 * @returns {Array<'full'|'half'|'empty'>} 长度恒为 `PLAYER_MAX_HEARTS` 的心形数组
 */
export function heartsFor(health) {
  // 钳制到 [0, PLAYER_MAX_HEALTH] 并向下取整到格。
  // `Number.isFinite` 同时挡住 NaN / Infinity / 非数（undefined/null/字符串）。
  const raw = Number.isFinite(health) ? health : 0;
  const hp = Math.max(0, Math.min(PLAYER_MAX_HEALTH, Math.floor(raw)));

  const out = new Array(PLAYER_MAX_HEARTS);
  for (let i = 0; i < PLAYER_MAX_HEARTS; i += 1) {
    // 第 i 颗心覆盖的血量区间 = [i*2, (i+1)*2)。
    // 落在区间内的格数决定形态：2 → full，1 → half，0 → empty。
    const cellLo = i * HEALTH_PER_HEART;
    const lit = Math.max(0, Math.min(HEALTH_PER_HEART, hp - cellLo));
    out[i] = lit >= HEALTH_PER_HEART ? 'full' : lit >= 1 ? 'half' : 'empty';
  }
  return out;
}

/**
 * 扣血：把 `health` 减去 `amount`，结果钳制到 `[0, PLAYER_MAX_HEALTH]`。
 *
 * ## 三 条语义（都有对错可言，单测逐条钉住）
 *
 * 1. **下限钳到 0，不钳到「死」** —— 用户 2026-11-05 裁定「血降到 0 就停在 0」，
 *    没有死亡界面也不需要重生。**重复打也不会变成负数**（血心行不会出现异常形态）。
 * 2. **负数伤害不收血** —— `amount <= 0` 一律当 0 伤害。把负数当治疗是一个语义偷换：
 *    将来的治疗应该是独立函数（带自己的上限/冷却），不是「负的伤害」。
 * 3. **非法值不产生 NaN** —— `health` 非法时按满血兜底（防御：宁可满血也不能变成 NaN，
 *    后者会让 `heartsFor` 全部变空、玩家看起来当场暴毙）。
 *
 * ⚠️ **本函数不改 `Player.health` 本身**（纯函数）：调用方写回
 * `player.health = applyDamage(player.health, dmg)`。这样它能在浏览器单测里直接验证，
 * 也不需要 `Player` 依赖。
 *
 * @param {number} health 当前血量（格）
 * @param {number} amount 伤害量（格，正数才生效）
 * @returns {number} 扣血后的血量（格，∈ [0, PLAYER_MAX_HEALTH]）
 */
export function applyDamage(health, amount) {
  const hp = Number.isFinite(health) ? health : PLAYER_MAX_HEALTH;
  // ⚠️ 只接受有限正数：Infinity / NaN / 负数 / 字符串 全部当 0 伤害
  const dmg = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return Math.max(0, Math.min(PLAYER_MAX_HEALTH, hp - dmg));
}
