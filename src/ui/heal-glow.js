// src/ui/heal-glow.js — 回血时的屏幕四周淡绿光边（用户 2026-11-28）
//
// 用户需求：「回血的过程是一个动画」。血心的逐格脉冲（`health-hud.js` 的 `_pulseIndex`）
// 是**局部的**读数变化；本层补一条**全局的持续状态提示** —— 玩家一看边缘就知道
// 「我现在正在城堡里回血」，不必去盯左上角的心。
//
// ## 与红闪（`damage-flash.js`）的关系
//
// 两者是同一族的两个状态，**刻意共用一套结构与手感**：
//   - 四条 `linear-gradient` 边条（从边缘向内 40px 淡到全透明）—— 与红闪同带宽、同渐变方向；
//   - 绿与红是补色 ⇒ 「受伤」与「恢复」在余光里就能分辨，不需要读字；
//   - z-index 与红闪**同层（56）**，后插入者在上 —— 同时触发（挨打的同时在城堡里回血）
//     时绿边压红边。这是刻意的：回血是持续状态，受伤是瞬时闪；让持续状态的绿更稳定，
//     否则玩家会被「正在回血」与「刚挨打」两套提示互相盖住。
//
// ## 为什么不是「亮度呼吸」而是「不透明度呼吸」
//
// 回血时长可达 4 秒（40 格 × 100ms）。若做亮度呼吸（opacity 正弦），它与红闪的**淡出包络**
// 是同一个属性，两者同时存在时会互相覆盖写 `style.opacity`。本层自己写自己的元素，
// 红闪写红闪的元素 —— 两条互不干扰。呼吸周期取 700ms（约 1.4Hz）：慢到不刺眼，
// 快到能读出「还在回血」。
//
// ⚠️ **时间基准 `performance.now()`，禁止 `Date.now()`**（相差约 17 亿毫秒）。
// ⚠️ **`nowMs` 由调用方透传**（帧循环），不得在方法内新取 —— 同 `DamageFlash`。
// ⚠️ 本层**不进 uiModal 模态栈**，也不吃输入（`pointer-events:none`）。

import { DAMAGE_FLASH } from './damage-flash.js';

/**
 * 回血绿边的观感常量。
 *
 * 带宽度**直接复用红闪的 40px**（`DAMAGE_FLASH.bandPx`，红线 1：两条边条必须等宽，
 * 否则切换状态时玩家读作「屏幕形状变了」）。
 */
export const HEAL_GLOW = Object.freeze({
  /** 渐变带宽度 —— 与红闪同宽（用户裁定的 40px） */
  bandPx: DAMAGE_FLASH.bandPx,
  /** 呼吸周期（ms）—— 700ms 约 1.4Hz，慢到不刺眼、快到能读出「还在回血」 */
  breathMs: 700,
  /** 颜色分量（拼成 `rgba(${color}, α)`）—— 偏冷的淡绿，在草地与沙地上都不与地形混色 */
  color: '90, 220, 120',
  /** 最亮那一拍的不透明度（低于红闪的 0.55：回血是持续态，不该抢走画面的注意力） */
  maxAlpha: 0.34,
  /**
   * 起始淡入时长（ms）：从 0 淡到第一拍最亮。
   *
   * ⚠️ **不做成瞬间全亮**：绿边若是「啪」地出现，玩家会把它读成又一次受击（红闪的手感）。
   * 180ms 的淡入读作「开始恢复」，这是刻意的区分。
   */
  fadeInMs: 180,
  /** z-index —— 与红闪同层（56），靠插入顺序压在其上（见模块头注释） */
  zIndex: DAMAGE_FLASH.zIndex,
});

/**
 * 呼吸包络：0..1 的不透明度乘子。
 *
 * 形状 = 线性淡入（`fadeInMs` 内 0→1）之后接 `sin` 呼吸。
 * 三条语义（单测钉住）：
 *   1. `ageMs` 非有限数一律 0（写进 `style.opacity` 的 NaN 会被浏览器静默忽略 ⇒ 边缘卡住）
 *   2. 负 age（时钟回退）按 0 算 —— 不产生 >1 或负值
 *   3. 输出恒在 [0,1]（乘上 `maxAlpha` 后恒在 [0, maxAlpha]）
 *
 * @param {number} ageMs 自开始回血起的毫秒数
 * @param {object} [cfg] 缺省 `HEAL_GLOW`
 * @returns {number} 0..1
 */
export function healBreathAt(ageMs, cfg = HEAL_GLOW) {
  if (!Number.isFinite(ageMs)) return 0;
  const age = Math.max(0, ageMs);
  const fadeIn = cfg.fadeInMs > 0 ? Math.min(1, age / cfg.fadeInMs) : 1;
  // sin 呼吸：period 的一半是「亮」，另一半是「暗」；`(1 - cos)/2` 让起点恒为 0
  // ⇒ 淡入结束后不会从 0 跳到 0.5（那会出现一次可见的台阶）。
  const phase = cfg.breathMs > 0 ? (age % cfg.breathMs) / cfg.breathMs : 0;
  const breath = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  return Math.min(1, Math.max(0, fadeIn * breath));
}

/** 四条边的 CSS（贴边 + 从该边向内淡出的渐变）—— 与 `damage-flash.js` 的 `sideStyles` 同构 */
function sideStyles(cfg) {
  const band = cfg.bandPx;
  const [r, g, b] = cfg.color.split(',').map((s) => s.trim());
  const a0 = cfg.maxAlpha;
  const grad = (dir) => `linear-gradient(${dir}, rgba(${r},${g},${b},${a0}), rgba(${r},${g},${b},0))`;
  return [
    `top:0;left:0;right:0;height:${band}px;background:${grad('to bottom')};`,
    `bottom:0;left:0;right:0;height:${band}px;background:${grad('to top')};`,
    `top:0;left:0;bottom:0;width:${band}px;background:${grad('to right')};`,
    `top:0;right:0;bottom:0;width:${band}px;background:${grad('to left')};`,
  ];
}

export class HealGlow {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {object} [cfg] 缺省 `HEAL_GLOW`（单测可注入极短的周期）
   */
  constructor(root, cfg = HEAL_GLOW) {
    this.cfg = cfg;
    this.el = document.createElement('div');
    this.el.id = 'mc-heal-glow';
    // `display:none` 而不是只靠 opacity:0 —— 空闲时连合成层都不占（同红闪口径）
    this.el.style.cssText =
      `position:fixed;inset:0;z-index:${cfg.zIndex};` +
      'pointer-events:none;display:none;opacity:0;';

    this._sides = [];
    for (const css of sideStyles(cfg)) {
      const side = document.createElement('div');
      side.style.cssText = `position:absolute;${css}`;
      this.el.appendChild(side);
      this._sides.push(side);
    }
    root.appendChild(this.el);

    /** 本次回血的开始时刻（`-1` = 未激活） */
    this._startMs = -1;
    /** 上一帧画过的 opacity（避免每帧写同一个值触发样式重算） */
    this._lastOpacity = -1;
  }

  /** 是否正在显示（测试钩子） */
  get active() { return this._startMs >= 0; }

  /** 开始/继续显示。已在显示时**不重置**呼吸相位（否则每格回血都从暗起亮，读作频闪）。 */
  show(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    if (this._startMs < 0) {
      this._startMs = nowMs;
      this._lastOpacity = -1;
      this.el.style.display = 'block';
    }
  }

  /**
   * 每帧推进。不在显示时只有一次数值比较。
   * @param {number} nowMs 帧循环的 `performance.now()` 基准
   */
  update(nowMs) {
    if (this._startMs < 0) return;
    if (!Number.isFinite(nowMs)) return;
    const age = nowMs - this._startMs;
    const op = healBreathAt(age < 0 ? 0 : age, this.cfg);
    // 呼吸最低点不做 `display:none` 切换（会闪）；只写 opacity，差值 < 0.01 时跳过
    if (Math.abs(op - this._lastOpacity) >= 0.01) {
      this.el.style.opacity = String(op);
      this._lastOpacity = op;
    }
  }

  /** 立即隐藏（离开城堡 / 满血 / dispose 用） */
  reset() {
    this._startMs = -1;
    this._lastOpacity = -1;
    this.el.style.opacity = '0';
    this.el.style.display = 'none';
  }

  dispose() {
    this.el.remove();
    this._sides.length = 0;
    this._startMs = -1;
  }
}