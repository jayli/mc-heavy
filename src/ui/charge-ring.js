// src/ui/charge-ring.js — 持剑蓄力大招的准心蓄力环（v3.20 Storm Lance）
//
// 用户 2026-11-19 裁定：「不要调参坞，只加准心蓄力环」。它是玩家判断「2 秒到了没有」的
// 唯一视觉通道（另有一声 `gun_load` 作听觉通道）。
//
// ## ⚠️ 不得挂进 `#crosshair`
//
// `tests/crosshair.spec.mjs:99` 钉死准心只有两笔 2px 笔画（`['20x2','2x20']`）——
// 用户明确要求「不显粗、不加衬层」。往里加任何子节点都会让那条用例红。
// 故本环是**独立元素**，挂 `document.body`（与 crosshair 同级），自己居中。
//
// ## 层级
//
// 取 **50**（= 坐标/性能面板 = 血心 = Boss 提示，常驻信息层）。低于设置按钮 60 与一切模态，
// **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。`pointer-events: none` ⇒ 不拦任何输入。
// ⚠️ 判「它在最上层」只能走像素：`elementFromPoint` 会跳过 pointer-events:none 的元素。
//
// ## 形态
//
// SVG `<circle r=18>` + `stroke-dasharray = 周长` / `stroke-dashoffset = 周长·(1−p)`，
// `rotate(-90deg)` 让进度从 12 点顺时针扫。外径 48px，准心 20px 在中心 ⇒ 不压住笔画。
// 蓄力中冷蓝（上游 thunder accent `#7fb4ff`），蓄满转琥珀金（本仓 Boss 提示的 `#ffd75e`）+ 外发光呼吸。
//
// ## 每帧成本
//
// 进度变化 ≤0.005 时**跳过 DOM 写**（与迷你地图同节流思路）。2 秒蓄力在 120fps 下
// 共 240 帧，阈值 0.005 ⇒ 约 200 次写，每次只改一个 attribute。
const RADIUS = 18;
const STROKE = 3;
const CIRC = 2 * Math.PI * RADIUS;
/** v3.21：第二圈（Cinder Fall 段）—— 外侧 4px，不压住准心 20px 笔画 */
const RADIUS2 = 22;
const CIRC2 = 2 * Math.PI * RADIUS2;
/** 进度变化小于它就不写 DOM（1px 级不可见） */
const EPS = 0.005;

/** 元素 id（E2E 与单测的 DOM 契约） */
export const CHARGE_RING_ID = 'mc-charge-ring';

/**
 * z-index。⚠️ 改这里必须重核 AGENTS.md「UI 层级」那条不等式：
 * hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 = **蓄力环 50** < 伤害数字 55
 * < 设置按钮 60 < 设置面板 70 < 背包 80 < 浮层 85 < toast 90 < loading 95 < 错误遮罩 100。
 */
export const CHARGE_RING_Z_INDEX = 50;

const STYLE_ID = 'mc-charge-ring-style';
// ⚠️ 本 CSS 是 JS 模板字面量：注释里禁用反引号包裹标识符（会提前终止模板串 → 页面白屏）。
const CSS = `
#${CHARGE_RING_ID} {
  position: fixed; left: 50%; top: 50%;
  width: 48px; height: 48px; margin: -24px 0 0 -24px;
  z-index: ${CHARGE_RING_Z_INDEX};
  pointer-events: none; user-select: none;
  opacity: 0; visibility: hidden;
  transition: opacity .12s ease-out, visibility .12s;
}
#${CHARGE_RING_ID}.mc-nc-on { opacity: 1; visibility: visible; }
#${CHARGE_RING_ID} svg { display: block; overflow: visible; }
#${CHARGE_RING_ID} .mc-nc-track {
  fill: none; stroke: rgba(8, 20, 32, 0.55); stroke-width: ${STROKE};
}
#${CHARGE_RING_ID} .mc-nc-arc {
  fill: none; stroke: #7fb4ff; stroke-width: ${STROKE}; stroke-linecap: round;
  transform: rotate(-90deg); transform-origin: 24px 24px;
  filter: drop-shadow(0 0 3px rgba(127, 240, 255, 0.85));
  transition: stroke .15s ease-out;
}
#${CHARGE_RING_ID}.mc-nc-ready .mc-nc-arc {
  stroke: #ffd75e;
  filter: drop-shadow(0 0 6px rgba(255, 215, 94, 0.95));
  animation: mc-nc-breathe 1.2s ease-in-out infinite;
}
#${CHARGE_RING_ID} .mc-nc-arc2 {
  fill: none; stroke: #ff8a3c; stroke-width: ${STROKE}; stroke-linecap: round;
  transform: rotate(-90deg); transform-origin: 24px 24px;
  filter: drop-shadow(0 0 4px rgba(255, 138, 60, 0.9));
  opacity: 0; transition: opacity .12s ease-out;
}
#${CHARGE_RING_ID}.mc-nc-warm .mc-nc-arc2 { opacity: 1; }
@keyframes mc-nc-breathe {
  0%, 100% { filter: drop-shadow(0 0 4px rgba(255, 215, 94, 0.7)); }
  50%      { filter: drop-shadow(0 0 9px rgba(255, 215, 94, 1)); }
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

export class ChargeRing {
  /** @param {HTMLElement} root 挂载点（Game 传 document.body —— 不是 #crosshair） */
  constructor(root) {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.id = CHARGE_RING_ID;
    // SVG 用 innerHTML 一次建好（静态结构，之后只改 arc 的 dashoffset）
    this.el.innerHTML =
      '<svg width="48" height="48" viewBox="0 0 48 48">'
      + `<circle class="mc-nc-track" cx="24" cy="24" r="${RADIUS}"/>`
      + `<circle class="mc-nc-arc" cx="24" cy="24" r="${RADIUS}"`
      + ` stroke-dasharray="${CIRC.toFixed(3)}" stroke-dashoffset="${CIRC.toFixed(3)}"/>`
      + `<circle class="mc-nc-arc2" cx="24" cy="24" r="${RADIUS2}"`
      + ` stroke-dasharray="${CIRC2.toFixed(3)}" stroke-dashoffset="${CIRC2.toFixed(3)}"/>`
      + '</svg>';
    this.arc = this.el.querySelector('.mc-nc-arc');
    this.arc2 = this.el.querySelector('.mc-nc-arc2');
    root.appendChild(this.el);
    this._last = -1;
    this._ready = false;
    this._warm = false;
  }

  /**
   * 每帧调用。`p<=0` 隐藏；`p>=1` 转就绪态。
   * @param {number} progress 0..1
   * @param {number} [warm=0] v3.21：1 = 第二段（Cinder Fall）—— 主环满格 + 第二圈暖橙扫过。
   *        缺省 0 ⇒ 既有单参调用逐位回到 v3.20 行为。
   */
  update(progress, warm = 0) {
    const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const w = Number.isFinite(warm) && warm > 0.5;
    if (p <= 0 && !w) {
      if (this._last !== 0) {
        this._last = 0;
        this.el.classList.remove('mc-nc-on', 'mc-nc-ready', 'mc-nc-warm');
        this._ready = false;
        this._warm = false;
        this.arc.setAttribute('stroke-dashoffset', CIRC.toFixed(3));
        this.arc2.setAttribute('stroke-dashoffset', CIRC2.toFixed(3));
      }
      return;
    }
    if (Math.abs(p - this._last) < EPS && (p >= 1) === this._ready && w === this._warm) return;
    this._last = p;
    this._warm = w;
    this.el.classList.add('mc-nc-on');
    this.el.classList.toggle('mc-nc-warm', w);
    // 第二段：主环恒满格（读作「第一段已满」），第二圈扫当前进度
    const mainP = w ? 1 : p;
    this.arc.setAttribute('stroke-dashoffset', (CIRC * (1 - mainP)).toFixed(3));
    this.arc2.setAttribute('stroke-dashoffset', (CIRC2 * (1 - (w ? p : 0))).toFixed(3));
    const ready = mainP >= 1;
    if (ready !== this._ready) {
      this._ready = ready;
      this.el.classList.toggle('mc-nc-ready', ready);
    }
  }

  /** 当前 dashoffset（E2E 判「进度单调递减」用） */
  get dashOffset() { return Number(this.arc.getAttribute('stroke-dashoffset')); }
  /** v3.21：第二圈的 dashoffset（E2E 判第二段进度） */
  get dashOffset2() { return Number(this.arc2.getAttribute('stroke-dashoffset')); }
  get ready() { return this._ready; }
  /** v3.21：是否处于第二段（暖橙） */
  get warm() { return this._warm; }

  dispose() { this.el.remove(); }
}