// src/ui/damage-flash.js — 玩家受伤时屏幕四周的红色闪光（用户 2026-11-21）
//
// 用户原话：「玩家如果受到攻击时，屏幕四周闪现一下掉血的动画，很简单，就是屏幕四周向内
// 有一个 40 像素的从半透明红到全透明红的渐变，表明玩家被攻击后掉血了」。
// 追加裁定：任何掉血都闪（不只焰魔）；0.35 秒快速一闪；血掉到 0 后受击**仍然**闪。
//
// ## 为什么是四条独立的 DOM 渐变条，而不是一张图 / 后处理 pass
//
// 与血心/小地图/伤害数字同口径：DOM 覆盖层零 draw call、零 GPU 开销。
// 四条边各自的 `linear-gradient` 能精确表达「从边缘向内 40px 淡到全透明」；
// WebGPU 后处理 pass 要多一个 render pass，且与色调映射/天空盒的交互需要单独像素标定
// （用户已裁定用 DOM）。
//
// ## 为什么用 rAF 驱动 opacity 而不是 CSS transition
//
// 连续挨打时必须能**从全亮重头再闪**。CSS transition 在元素已处于淡出中途时把 opacity
// 重新设为 1 的行为依赖浏览器的中断语义，实测不可控；每帧自己写 opacity 是确定的。
//
// ## 四角的重叠
//
// 四条边各自 `position:absolute` 贴一条边。上下两条先插入、覆盖矩形的四个角，
// 观感是「边框亮、四角略重 1.55 倍（两次 maxAlpha 叠加）」。这是刻意接受的：
// 用 radial-gradient 做精确角落会让每条边各画一个椭圆，在 40px 这个尺度上肉眼无差别，
// 却多四层节点。
//
// ⚠️ **时间基准 `performance.now()`，禁止 `Date.now()`**（相差约 17 亿毫秒 → 首帧即消失）。
// ⚠️ **`nowMs` 必须由调用方透传**（`game.js` 的帧循环），不得在方法内新取 ——
// 与 `_consumeIgnisFxRequests` / `_syncBossAudio` 同一口径。

/**
 * 红闪的观感常量（用户 2026-11-21 裁定的三项：40px / 0.35s / 半透明红）。
 */
export const DAMAGE_FLASH = Object.freeze({
  /** 渐变带宽度（CSS px）—— 用户裁定「40 像素」 */
  bandPx: 40,
  /** 总时长（ms）—— 用户裁定「0.35 秒快速一闪」 */
  lifeMs: 350,
  /** 颜色分量（拼成 `rgba(${color}, α)`）—— 深红，在亮草地与暗洞穴上都读得出 */
  color: '200, 0, 0',
  /** 边缘处的最大不透明度（半透明红） */
  maxAlpha: 0.55,
  /**
   * z-index = 56。
   *
   * ⚠️ 改这里必须重核 `CLAUDE.md` 的「UI 层级不等式」：
   * 50（血心/坐标/性能面板） < 55（伤害数字） < **56（红闪）** < 60（设置按钮）
   * < 70（设置面板） < 80（背包） < 85（背包 hover） < 90（toast） < 95（loading）
   * < 100（启动错误遮罩）。
   *
   * 为什么不取更低：红闪要压过血心与伤害数字，否则「受到攻击」的即时反馈被 HUD 盖住。
   * 为什么不取更高：它绝不该盖住设置按钮 / 面板 / 背包 / toast。
   * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
   */
  zIndex: 56,
});

const sat = (x) => Math.max(0, Math.min(1, x));

/**
 * 淡出包络：0ms 全亮 → `lifeMs` 全透明，线性。
 *
 * ⚠️ **非法值一律钳制**：`ageMs >= lifeMs`、NaN、Infinity 都返 0。
 * 写进 `style.opacity` 的 NaN 会被浏览器静默忽略 ⇒ 红闪卡在上一帧的亮度上永不消失
 * （缺陷形态是「挨一次打之后屏幕永久发红」）。
 *
 * @param {number} ageMs 自触发起的毫秒数
 * @param {object} [cfg] 缺省 `DAMAGE_FLASH`
 * @returns {number} 0..1
 */
export function flashOpacityAt(ageMs, cfg = DAMAGE_FLASH) {
  if (!Number.isFinite(ageMs)) return 0;
  const t = sat(ageMs / cfg.lifeMs);
  return 1 - t;
}

/**
 * 四条边各自的 CSS（贴边 + 从该边向内淡出的渐变）。
 *
 * ⚠️ **渐变方向必须朝内**：`to bottom`（上边）/ `to top`（下边）/ `to right`（左边）/
 * `to left`（右边）。写反的形态是「边缘透明、向内实红」，读作屏幕中间有一圈红框。
 *
 * @param {object} cfg
 * @returns {string[]} 4 条 CSS（上下左右）
 */
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

export class DamageFlash {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   */
  constructor(root) {
    this.el = document.createElement('div');
    this.el.id = 'mc-damage-flash';
    // ⚠️ `display:none` 而不是只靠 opacity:0：空闲时连合成层都不占
    //（与血心/伤害数字的「常驻池但零成本」同一思路）。
    this.el.style.cssText =
      `position:fixed;inset:0;z-index:${DAMAGE_FLASH.zIndex};` +
      'pointer-events:none;display:none;opacity:0;';

    this._sides = [];
    for (const css of sideStyles(DAMAGE_FLASH)) {
      const side = document.createElement('div');
      side.style.cssText = `position:absolute;${css}`;
      this.el.appendChild(side);
      this._sides.push(side);
    }
    root.appendChild(this.el);

    /**
     * 本次闪光的触发时刻。`-1` = 未激活。
     * @type {number}
     */
    this._startMs = -1;
  }

  /** 是否正在闪（测试钩子） */
  get active() { return this._startMs >= 0; }

  /**
   * 触发一次闪光。连续挨打时**重置**计时（从全亮重头再闪），不叠加亮度。
   *
   * @param {number} nowMs 帧循环的 `performance.now()` 基准
   */
  show(nowMs) {
    // NaN 会让 _startMs 变 NaN ⇒ active 恒 false ⇒ 永远不闪（静默失效）
    if (!Number.isFinite(nowMs)) return;
    this._startMs = nowMs;
    this.el.style.display = 'block';
    this.el.style.opacity = '1';
  }

  /**
   * 每帧推进。未激活时只有一次数值比较（同血心的口径）。
   * @param {number} nowMs 帧循环的 `performance.now()` 基准
   */
  update(nowMs) {
    if (this._startMs < 0) return;
    if (!Number.isFinite(nowMs)) return;
    const age = nowMs - this._startMs;
    // 时钟回退（不可能但防御）：按刚触发算，不让它卡在全亮或变负
    const opacity = flashOpacityAt(age < 0 ? 0 : age);
    if (opacity <= 0) {
      this._startMs = -1;
      this.el.style.opacity = '0';
      this.el.style.display = 'none';
      return;
    }
    this.el.style.opacity = String(opacity);
  }

  /** 立即结束并隐藏（换世界 / dispose 用） */
  reset() {
    this._startMs = -1;
    this.el.style.opacity = '0';
    this.el.style.display = 'none';
  }

  dispose() {
    this.el.remove();
    this._sides.length = 0;
    this._startMs = -1;
  }
}
