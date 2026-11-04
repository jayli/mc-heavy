// src/player/health.js — 玩家血量的唯一权威（生命系统显示层）
//
// 纯常量 + 纯函数模块：**无 DOM、无 three** —— 与 `render/pixel-ratio.js` 同口径，
// 可在浏览器内单测（`src/tests/test-health.js`）里安全 import。
//
// ## 口径（原版 Minecraft）
//
// - 满血 = **20 格**（`PLAYER_MAX_HEALTH`）；
// - 用 **10 颗心**表示（`PLAYER_MAX_HEARTS`），每颗心 = 2 格血；
// - **半颗心 = 1 格血**（用户明确要求，与原版一致）。
//
// ## 为什么单独成模块
//
// 「血量 → 10 颗心形态」的换算是**有对错可言的逻辑**（半心、越界、非法值的边界），
// 必须能被 Tier 1 单测钉住。渲染层（`ui/health-hud.js`）只消费 `heartsFor()` 的输出，
// 不自己再算一遍（红线 1：同一事实只有一份权威）。
//
// ## 当前阶段（用户裁定）
//
// 玩家血量**只显示、不掉血**：`Player.health` 恒为满血 20，掉血逻辑由用户后续添加。
// 故本模块只提供「血量 → 心形」的显示换算，不含任何伤害/恢复逻辑。
// 也不入存档（值恒为 20，存档字段等真做掉血时再加，避免现在白做一次 settingsVersion 迁移）。

/** 玩家满血格数（原版口径：20 格 = 10 颗心 × 2） */
export const PLAYER_MAX_HEALTH = 20;

/** 血心的颗数（原版口径：10 颗） */
export const PLAYER_MAX_HEARTS = 10;

/** 每颗心对应的血量格数（2 = 半颗心 1 格血的数学表达） */
const HEALTH_PER_HEART = PLAYER_MAX_HEALTH / PLAYER_MAX_HEARTS;

/**
 * 把血量换算成 10 颗心的形态数组（渲染层按位画，长度恒为 `PLAYER_MAX_HEARTS`）。
 *
 * 每颗心取值 `'full'`（满）/ `'half'`（半）/ `'empty'`（空），从左到右排列。
 * 换算规则：每颗心 = 2 格血，半颗心 = 1 格血（原版口径）。
 *
 * ⚠️ **越界与非法值一律钳制，不抛异常**：
 *   - `health > PLAYER_MAX_HEALTH` → 全满（未来若有吸收/增益不画出第 11 颗心）；
 *   - `health < 0` / `NaN` / 非数 → 全空（缺陷形态是静默画错，不是崩溃）；
 *   - 小数血向下取整到格（`1.9 → 1` 格亮点 = 首颗半心）。
 *
 * @param {number} health 当前血量（格）
 * @returns {Array<'full'|'half'|'empty'>} 长度恒为 10 的心形数组
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
