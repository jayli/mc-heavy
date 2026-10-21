// src/ui/crosshair.js — 准心自适应配色（v1.64）
//
// 问题：准心原来是固定纯白，对准白墙/雪地/天空时直接消失。
// 为什么不用 `mix-blend-mode: difference` 反色：GPU 反色在背景色与笔画色相同时输出完全相同
// （实测背景亮度 127 时 Δ=1）—— **中灰盲区是数学必然**，不是参数没调好。加黑衬能补，但
// 用户明确要求不要衬层（显得十字太粗）。
//
// 采用的方案：**默认白色，只在背景亮到白芯几乎看不见时才切黑**（阈值 220）。
// 实测亮度分布（正午、无阴影）：地面/水 58~100，云与雪 178~181，天空 137~216。
// 所以日常游玩几乎全是白芯，只有极亮的天空才转黑 —— 且不会来回跳。
//
// （中间试过「按亮度 128 中点二选一」：全梯度对比度最优（Δ=128），但会让石地这类**中等灰度的
// 常见画面**也转黑 —— 观感上是准心“乱变色”，不符合「默认白」的要求。实测依据：白色准心在
// 背景亮度 181 时对比度 Δ=74、216 时 Δ=39，都还能辨认。）
//
// ⚠️ 采样必须在 **`renderer.render()` 之后**。WebGPU 的 swapchain canvas 在渲染前读到的是
// 上一帧已 present / 已失效的内容 —— 实测帧循环里 `render()` 之前采样恒为 **0**，之后恒为
// 正确值（209）。这份 0 会让准心永远判为「暗背景」而恒白（实测的缺陷形态）。
// 故 `update()` 只负责**消费**上一次的采样结果，真正的采样在 `sample()` 里，由 Game 在
// `render()` 之后调用。
// ⚠️ 采样还要 `drawImage` + `getImageData`，实测 ~1.1ms（回读 GPU），**不能每帧做** ——
// 故按 `SAMPLE_INTERVAL_MS` 节流。
// ⚠️ 只切 `color`（`background: currentColor`），不碰布局：笔画宽度恒 2px。

/** 采样间隔（ms）。60 次/秒的回读没有必要 —— 准心底下的画面不会每 16ms 换一次明暗。 */
const SAMPLE_INTERVAL_MS = 100;

/**
 * 切色阈值（0~255 亮度）。
 *
 * ⚠️ 设计口径是「默认白，只在白到看不见时才转黑」，**不是**「按亮度中点选色」。
 * 白色准心与背景的对比度 = `255 − 亮度`：
 *   · 亮度 181（实测游戏内最亮方块：snow / cloud / snow_leaves 都是这个值）→ 对比度 74；
 *   · 亮度 216（实测最亮：正午天空）→ 对比度 39。
 * 取 **220** 作阈值（对比度 < 35 才转黑），让白芯覆盖日常全部场景。
 */
const SWITCH_HIGH = 220;
/**
 * 迟滞回差：转黑后要暗到 **200** 以下才转回白（对比度 > 55）。
 * ⚠️ 回差故意拉得比常规宽（20 档）—— 避免在地平线/云边缘扫过时黑白反复横跳。
 * 代价是「转黑有粘性」：一旦因极亮天空转黑，要等画面明显变暗才回白（这是有意的，符合
 * 「固定颜色为主、避免频繁切换」的要求）。
 */
const SWITCH_LOW = 200;

/** 采样区域边长（CSS px）：准心 20×20，取四周各外扩 4px，覆盖笔画背后那一小片画面 */
const SAMPLE_BOX = 28;

export class Crosshair {
  /**
   * @param {HTMLElement} root
   * @param {Game} game
   */
  constructor(root, game) {
    this.game = game;
    this._lastSample = -Infinity;
    /** 上一次采样到的画面亮度（0~255）；尚未采样过时为 null */
    this.lastLuminance = null;
    /** 当前是否为白芯。初值白 —— 默认状态就是白，符合「绝大多数情况白」的口径。 */
    this._white = true;

    this.el = document.createElement('div');
    this.el.id = 'crosshair';
    this.el.style.cssText =
      'position:absolute;left:calc(50% - 10px);top:calc(50% - 10px);width:20px;height:20px;' +
      'pointer-events:none;color:#fff;';
    // 两笔都由 `currentColor` 着色 —— 改颜色只改容器的 color，笔画宽度恒为 2px
    const h = document.createElement('div');
    h.style.cssText = 'position:absolute;left:0;top:9px;width:20px;height:2px;background:currentColor';
    const v = document.createElement('div');
    v.style.cssText = 'position:absolute;left:9px;top:0;width:2px;height:20px;background:currentColor';
    this.el.append(h, v);
    root.appendChild(this.el);

    // 采样用的 1×1 离屏画布（`willReadFrequently` 让 getImageData 走 CPU 缓存路径）
    this._scratch = document.createElement('canvas');
    this._scratch.width = 1;
    this._scratch.height = 1;
    this._scratchCtx = this._scratch.getContext('2d', { willReadFrequently: true });
    this._canvas = null;
  }

  /**
   * 每帧调用（内部按 `SAMPLE_INTERVAL_MS` 节流）。**必须在 `renderer.render()` 之后调用**
   * —— 渲染前 canvas 内容不可读（详见文件头注释）。
   *
   * @param {number} nowMs `performance.now()` 基准（渲染循环传入）
   */
  update(nowMs) {
    if (nowMs - this._lastSample < SAMPLE_INTERVAL_MS) return;
    this._lastSample = nowMs;

    const canvas = this._resolveCanvas();
    if (!canvas) return;

    const lum = this._sampleLuminance(canvas);
    if (lum === null) return;
    // 记下上次采样值（调试/测试可读）。不是第二份权威数据 —— 它只是上一次读到的画面亮度。
    this.lastLuminance = lum;

    // 迟滞：只有越过外侧阈值才切换，避免在 220 附近逐帧闪烁。
    // （默认白 → 只在极亮时转黑 → 变暗后回白，见 SWITCH_HIGH / SWITCH_LOW 的注释）
    if (this._white && lum > SWITCH_HIGH) this._setWhite(false);
    else if (!this._white && lum < SWITCH_LOW) this._setWhite(true);
  }

  /** @param {boolean} white */
  _setWhite(white) {
    this._white = white;
    this.el.style.color = white ? '#fff' : '#000';
  }

  _resolveCanvas() {
    if (this._canvas && this._canvas.isConnected) return this._canvas;
    this._canvas = this.game?.renderer?.domElement ?? null;
    return this._canvas;
  }

  /**
   * 取准心背后一小片画面的**平均亮度**（0~255）。
   *
   * 在 1×1 离屏画布上做缩放绘制 → 由 GPU 做面积平均（比回读 28×28 再在 JS 里算便宜得多，
   * 实测 1×1 约 1.1ms，整块回读会到数 ms 级）。
   *
   * @returns {number|null} 采样失败（画布不可读 / 尺寸为 0）时返回 null
   */
  _sampleLuminance(canvas) {
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return null;

    const dpr = w / window.innerWidth || 1;
    const box = Math.max(1, Math.round(SAMPLE_BOX * dpr));
    const x = Math.max(0, Math.round(w / 2 - box / 2));
    const y = Math.max(0, Math.round(h / 2 - box / 2));
    const sw = Math.min(box, w - x);
    const sh = Math.min(box, h - y);
    if (sw <= 0 || sh <= 0) return null;

    // 缩到 1×1 采样：GPU 侧做面积平均，比回读 28×28 再在 JS 里算便宜得多
    // （回读面积越大越慢，实测 1×1 约 1.1ms，整块会到数 ms 级）
    try {
      this._scratchCtx.drawImage(canvas, x, y, sw, sh, 0, 0, 1, 1);
      const d = this._scratchCtx.getImageData(0, 0, 1, 1).data;
      return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
    } catch {
      return null; // 上下文丢失 / 画布被污染 —— 保持当前颜色，不影响游戏
    }
  }
}
