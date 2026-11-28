// src/ui/health-hud.js — 玩家血心（生命系统显示层）
//
// 10 颗心横排，紧挨性能看板右侧（用户裁定）。血量 → 心形的换算权威在
// `player/health.js` 的 `heartsFor()`，本文件**只负责画**，不自己再算一遍（红线 1）。
//
// ## 为什么是 DOM 而不是画进 canvas
//
// 与快捷栏/坐标面板/迷你地图同口径：HUD 是 DOM 覆盖层，零 draw call、零 GPU 开销。
// 10 颗心是 10 个 `<img>`，每帧成本 = 一次数值比较（血量没变就直接 return）。
//
// ## 素材
//
// `assets/life/{heart,half_heart,empty_heart}.png`，各 9×9 RGBA（用户提供的原始素材，
// webp 原件已转 PNG —— 仓库其余素材全是 PNG，且 `assets/life/` 不在 `build-atlas` 的
// 递归扫描范围内，不会污染世界图集）。
//
// 显示尺寸 **18px = 2 倍整数放大**（用户裁定）+ `image-rendering:pixelated`：
// 像素风锐利不糊。非整数倍缩放会让 9px 网格的描边粗细不均。
//
// URL 一律经 `resourceUrl()`（红线：禁止站点根绝对路径 —— 仓库挂子路径部署时会全 404，
// 而本机 dev server 恒为根路径所以测不出来）。
//
// ⚠️ **无背景衬底**：素材自带黑色描边，任何画面上都读得清（原版口径）。加半透明底
// 反而会让它看起来像一块面板而不是 HUD。
import { resourceUrl } from '../core/resource-url.js';
import { PLAYER_MAX_HEARTS, heartsFor } from '../player/health.js';

/** 单颗心的显示边长（CSS px）= 源图 9px 的 2 倍整数放大（用户裁定） */
export const HEART_SIZE_PX = 18;

/**
 * 三张心形素材的 URL（模块级常量：一次解析，所有实例共用）。
 * 键名 = `heartsFor()` 的输出形态，故查表不需要任何分支。
 */
const HEART_URLS = Object.freeze({
  full: resourceUrl('assets/life/heart.png'),
  half: resourceUrl('assets/life/half_heart.png'),
  empty: resourceUrl('assets/life/empty_heart.png'),
});

/**
 * 血心行的 z-index。
 *
 * ⚠️ 改这里必须重核 AGENTS.md「UI 层级」那条不等式：
 * hotbar 40 < 迷你地图 45 < **血心 50** = 坐标/性能面板 50 < 设置按钮 60 < …
 * 与性能/坐标面板同层（50）：它是常驻信息，不该被面板盖住，也不该盖住任何模态。
 * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
 */
export const HEALTH_Z_INDEX = 50;

/**
 * 血心行左边距（CSS px）= 性能看板 `left:8px` + 看板冻结宽度 330 + 8px 间距。
 *
 * ⚠️ **330 是 `perf-hud.js` 的 `PANEL_WIDTH_PX`**（v1.80 用户裁定的冻结值，
 * `tests/player-flight.spec.mjs` 钉住）。这里写字面量而不是 import 那个常量：
 * `PANEL_WIDTH_PX` 是 perf-hud 的模块私有常量（未导出），而**导出它会让「面板宽度」
 * 变成两个模块的共享接口** —— 那反而扩大了耦合面。改为在 spec 里同时钉两个值
 * （`tests/health-hud.spec.mjs` 断言血心左缘 = 看板右缘 + 8），漂移会被抓到。
 *
 * ⚠️ 看板可折叠，但**折叠只改高度不改宽度**（`PANEL_WIDTH_PX` 恒定）→ 血心位置不随
 * 折叠移动，这正是「紧挨看板右侧」在两种状态下都成立的原因。
 */
const LEFT_PX = 8 + 330 + 8;

/**
 * 每排多少颗心 —— **派生自 `PLAYER_MAX_HEARTS`**（红线 1，不写死 10）。
 *
 * 20 颗心分两排各 10 颗（用户 2026-11-21 裁定）。
 * ⚠️ **不用 `flex-wrap`**：它会在父容宽变化时不可控地重排 —— 第 11 颗落到上排
 * 还是下排取决于父宽，而两排的语义是固定的。显式两个行容器才能钉住布局。
 */
const PER_ROW = PLAYER_MAX_HEARTS / 2;

export class HealthHUD {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {import('../player/player.js').Player} player 血量权威（读 `player.health`）
   */
  constructor(root, player) {
    this.player = player;
    this.el = document.createElement('div');
    this.el.id = 'mc-health';
    this.el.style.cssText =
      `position:fixed;top:8px;left:${LEFT_PX}px;z-index:${HEALTH_Z_INDEX};` +
      `display:flex;flex-direction:column;gap:0;pointer-events:none;` +
      `height:${HEART_SIZE_PX * 2}px;`;

    /**
     * 心形 `<img>`（构造期一次建好，之后只换 `src`），分两排各 `PER_ROW` 颗。
     *
     * ⚠️ **不每帧重建 DOM**：血量变化是低频事件，但重建 20 个 img 会触发 20 次
     * 图片解码请求。换 `src` 走浏览器图片缓存。
     *
     * ⚠️ **`this._imgs` 的顺序就是 `heartsFor()` 的索引顺序**：
     * 先 row0 的 0..9，再 row1 的 0..9。`_paint()` 与 `hearts()` 依赖这一点，
     * 两排布局对它们完全透明（它们不知道行容器存在）。
     */
    this._imgs = [];
    for (let row = 0; row < 2; row += 1) {
      const rowEl = document.createElement('div');
      rowEl.id = `mc-health-row${row}`;
      rowEl.style.cssText = `display:flex;gap:0;height:${HEART_SIZE_PX}px;`;
      for (let i = 0; i < PER_ROW; i += 1) {
        const img = document.createElement('img');
        img.style.cssText =
          `width:${HEART_SIZE_PX}px;height:${HEART_SIZE_PX}px;` +
          'image-rendering:pixelated;display:block;' +
          // 回血脉冲的放大以心的**中心**为原点（缺省 50% 50% 也是一样的，写出来是为了
          // 防止将来的 `transform-origin` 继承把脉冲的放大锚点推到左上角 → 心会“偏出去”）。
          'transform-origin:center center;';
        img.draggable = false;
        // 装饰性图像：读屏软件跳过（血量数值不是可交互内容）
        img.alt = '';
        rowEl.appendChild(img);
        this._imgs.push(img);
      }
      this.el.appendChild(rowEl);
    }
    root.appendChild(this.el);

    /**
     * 上次画过的血量。初值 `null` → 首帧必然画一次（不寄望于某个远处的初值，
     * 与 `Minimap` 构造期显式 `redraw()` 同一思路）。
     * @type {number|null}
     */
    this._lastHealth = null;
    /** 上次画过的心形数组（避免 `heartsFor` 每帧分配；只在血量变化时重算） */
    this._hearts = heartsFor(player?.health);
    this._paint(this._hearts);
    this._lastHealth = player?.health ?? null;
    /**
     * 回血脉冲的下标（本次回血**新亮起**的那颗心；-1 = 没有脉冲）。
     *
     * 用户 2026-11-28：「回血的过程是一个动画」—— 每 100ms 亮半颗心本身是离散跳动，
     * 这里给「刚变成新形态的那一颗」一个 1.35 倍放大 + 缩短的短暂脉冲（180ms），
     * 让逐格恢复读作「一颗一颗地亮」而不是「数字在跳」。
     */
    this._pulseIndex = -1;
    this._pulseStartMs = -1;
  }

  /**
   * 每帧调用。**血量与回血状态都没变就直接 return**。
   *
   * ⚠️ 不接 `nowMs` 参数（与 `CoordsHUD`/`PerfHUD` 的签名不同）：血量刷新由「血量变化」
   * 驱动，不是由时间驱动。接一个用不上的参数会被 eslint 拓成 no-unused-vars
   *（本仓约定：未用参数必须 `_` 前缀）。
   *
   * ⚠️ **回血脉冲必须走 `healing` 参数而不是读 `player.health` 的变化**：
   * 掉血与回血都会让血量变化，而脉冲只该在「城堡回血」时出现（挨打时闪红边、
   * 心不该放大）。
   *
   * @param {number} nowMs 帧循环的 `performance.now()` 基准
   * @param {boolean} [healing] 本帧是否正在城堡回血（`CastleHeal.active`）
   */
  update(nowMs, healing = false) {
    const hp = this.player?.health;
    const changed = hp !== this._lastHealth;
    if (!changed && !this._updatePulse(nowMs)) return;
    if (changed) {
      this._lastHealth = hp;
      this._hearts = heartsFor(hp);
      this._paint(this._hearts);
      // 回血时给「新亮起的那一颗」加脉冲。判据 = 心形数组里最后一个非 empty 的位置，
      // 它正好是本次恢复点亮的那颗（半颗心也算 —— 用户要的正是 100ms 半颗心的节奏）。
      if (healing) this._startPulse(this._lastLitIndex(), nowMs);
    }
    this._applyPulse(nowMs);
  }

  /**
   * 本次回血新点亮的那颗心的下标（最后一个非 `empty` 的位置；全空返回 -1）。
   *
   * ⚠️ 它必须是「最后一个非空」而不是「第 hp 颗」：`heartsFor` 的索引是心（0..19），
   * 而血量是格（0..40），两者按 `HEALTH_PER_HEART=2` 换算 —— 用血量当下标会在
   * 20 格以上的血量直接越界（`_imgs[25]` 是 undefined）。
   * @returns {number}
   */
  _lastLitIndex() {
    for (let i = this._hearts.length - 1; i >= 0; i -= 1) {
      if (this._hearts[i] !== 'empty') return i;
    }
    return -1;
  }

  /**
   * 脉冲时长（ms）。取 180ms：短于 100ms 的下一拍会让动画来不及读完，
   * 长于 250ms 会与下一颗心的脉冲**重叠**（两个心同时放大读作整排抖动）。
   */
  static get PULSE_MS() { return 180; }

  /**
   * 开始一次脉冲（`index < 0` 时清空）。
   *
   * ⚠️ `nowMs` **必须由调用方透传**（帧循环的 `performance.now()`）—— 本方法内不得
   * 新取：同帧两个时基会让脉冲起点与 `_updatePulse` 的基准错开一帧耗时。同 `DamageFlash.show`。
   */
  _startPulse(index, nowMs) {
    // 先还原上一颗心的样式：否则 100ms 一个脉冲时，上一颗的 scale 永远留着
    // （形态：回血中段整排心都停在 1.35 倍）。
    this._clearPulse();
    this._pulseIndex = index;
    this._pulseStartMs = index >= 0 && Number.isFinite(nowMs) ? nowMs : -1;
  }

  /**
   * 推进脉冲进度：返回 true 表示「本帧需要重画」（脉冲仍在进行）。
   * 未进行时只有一次数值比较。
   * @returns {boolean}
   */
  _updatePulse(nowMs) {
    if (this._pulseStartMs < 0) return false;
    if (!Number.isFinite(nowMs)) return false;
    if (nowMs - this._pulseStartMs >= HealthHUD.PULSE_MS) {
      this._clearPulse();
      return false;
    }
    return true;
  }

  /** 脉冲强度 0..1（1 = 刚点亮，0 = 结束）；非法时间一律 0 */
  _pulseStrength(nowMs) {
    if (this._pulseStartMs < 0 || !Number.isFinite(nowMs)) return 0;
    const age = nowMs - this._pulseStartMs;
    if (!(age >= 0)) return 1;   // 时钟回退：按刚点亮算（不放大到 NaN）
    const t = Math.min(1, age / HealthHUD.PULSE_MS);
    return 1 - t;
  }

  /** 把脉冲落到 DOM（缩放 + 轻微提亮）；结束的那一帧负责把样式还原 */
  _applyPulse(nowMs) {
    if (this._pulseIndex < 0) return;
    const img = this._imgs[this._pulseIndex];
    if (!img) return;
    const s = this._pulseStrength(nowMs);
    if (s <= 0) { this._clearPulse(); return; }
    // 1.35 倍放大：11px 的位移在 18px 的心上读作「脉动」而不遮住相邻的心。
    // 用 transform 而不是 width/height —— transform 不触发布局（20 颗心同时重排会很贵）。
    img.style.transform = `scale(${1 + 0.35 * s})`;
    img.style.filter = s > 0.5 ? 'brightness(1.35)' : '';
  }

  /** 清空脉冲并还原该 img 的样式 */
  _clearPulse() {
    const img = this._pulseIndex >= 0 ? this._imgs[this._pulseIndex] : null;
    if (img) {
      img.style.transform = '';
      img.style.filter = '';
    }
    this._pulseIndex = -1;
    this._pulseStartMs = -1;
  }

  /** 是否正在脉冲（测试钩子） */
  get pulsing() { return this._pulseStartMs >= 0; }

  /** 当前脉冲的下标（测试钩子；-1 = 无） */
  get pulseIndex() { return this._pulseIndex; }

  /**
   * 把心形数组落到 10 个 `<img>` 的 `src`。
   *
   * ⚠️ **只在形态真的变了才写 `src`**：写同一个值浏览器也会走一次属性变更，
   * 而 10 个 img 同时变更可能触发重排。逐位比较后只写差异位。
   * @param {Array<'full'|'half'|'empty'>} hearts
   */
  _paint(hearts) {
    for (let i = 0; i < this._imgs.length; i += 1) {
      const url = HEART_URLS[hearts[i]] ?? HEART_URLS.empty;
      if (this._imgs[i].getAttribute('src') !== url) this._imgs[i].src = url;
    }
  }

  /**
   * 当前心形数组（只读测试接口）。
   * 供 E2E 断言钉住「HUD 真的按血量画了」而不是只钉 DOM 存在。
   * @returns {Array<'full'|'half'|'empty'>}
   */
  hearts() { return this._hearts; }
}
