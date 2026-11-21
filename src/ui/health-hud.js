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
          'image-rendering:pixelated;display:block;';
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
  }

  /**
   * 每帧调用。**血量没变就直接 return**（当前阶段恒不变 → 每帧成本 = 一次比较）。
   *
   * ⚠️ 不接 `nowMs` 参数（与 `CoordsHUD`/`PerfHUD` 的签名不同）：本 HUD 没有任何
   * 时间节流或动画 —— 刷新由「血量变化」驱动，不是由时间驱动。接一个用不上的
   * 参数会被 eslint 拓成 no-unused-vars（本仓约定：未用参数必须 `_` 前缀）。
   */
  update() {
    const hp = this.player?.health;
    if (hp === this._lastHealth) return;
    this._lastHealth = hp;
    this._hearts = heartsFor(hp);
    this._paint(this._hearts);
  }

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
