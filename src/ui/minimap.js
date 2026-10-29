// src/ui/minimap.js — 左下角迷你区域地图（DOM/画布层；区域判据在 `minimap-regions.js`）
//
// 分工（红线 1）：
//   · `minimap-regions.js` —— **区域种类与配色的唯一权威**（纯函数，无 DOM，单测直接驱动）；
//   · 本文件 —— 只负责画布、节流、玩家点与「N」罗盘字。
//
// ## 视觉口径
//
// · **底图 51×51 个样本**，每样本 3 CSS px（`image-rendering:pixelated`）→ 153px 见方；
// · **玩家恒在画布正中**，用一个白点（+ 深色描边）表示 —— 地图内容是「以玩家为中心的世界」，
//   移动时底图滚动，点不动（用户 2026-10-29：「玩家在地图的中心，用一个点来表示」）；
// · **上北下南左西右东**：方向契约在 `paintMinimap` 的采样公式里，本文件只画一个 `N` 字与
//   朝向短刺（刺随 `player.yaw` 转，`yaw=0` 时指向上方 = 北）。
//
// ## 为什么两套画布
//
// 底图重绘是 2601 次 `kindAt`（实测约 0.2ms）；玩家点每帧都在动。混在一张画布上会让
// 每次转视角都重算整张地图。故：底图 canvas 只在**位置变化**时重绘（10Hz 上限），
// 玩家点 canvas 独立（20Hz 上限）。两张都是 `pointer-events:none`。
//
// ## 为什么不用 `<img>`/WebGL
//
// 51×51 的 `ImageData` → `putImageData` 是纯 CPU 一次性写入，无 GPU 资源、无 draw call、
// 不参与 three 的渲染管线 → 对 `renderer.info.render.drawCalls` 零影响（Tier 4 的
// draw call 冻结断言不受影响）。

import {
  MINIMAP_SAMPLES, MINIMAP_MAP_SIZE, MINIMAP_SPAN,
  minimapRegionContext, paintMinimap,
} from './minimap-regions.js';

/** 底图重绘的最小间隔（ms）。10Hz：玩家跑 8 格/秒 ⇒ 每次重绘最多偏 0.8 格。 */
export const BASE_REDRAW_INTERVAL_MS = 100;
/** 玩家点重绘的最小间隔（ms）。20Hz：转视角足够顺滑，又不给每帧加 DOM 写。 */
export const OVERLAY_REDRAW_INTERVAL_MS = 50;
/** 位置变化超过这个格数才触发底图重绘（小于它时滚动量看不出来，白算一次地图） */
export const BASE_REDRAW_MIN_MOVE = 0.5;

/** 玩家点圆点半径（CSS px）与描边宽度 */
const DOT_RADIUS = 3;
const DOT_STROKE = 1.5;
/** 朝向短刺长度（CSS px，从圆点边缘起算） */
const FACING_LEN = 6;
/** 设备像素比上限：地图是像素风，2 倍以上不回本 */
const MAX_DPR = 2;

export class Minimap {
  /**
   * @param {HTMLElement} root HUD 根（`#hud-root`）
   * @param {import('../core/game.js').Game} game
   */
  constructor(root, game) {
    this.game = game;
    /** 上一次底图重绘时刻（`performance.now()` 基准；调试/测试可读） */
    this._lastBaseMs = -Infinity;
    /** 上一次 overlay 重绘时刻 */
    this._lastOverlayMs = -Infinity;
    /** 底图当时的玩家位置（只在移动超过阈值时重绘） */
    this._baseX = Infinity;
    this._baseZ = Infinity;
    /** 上一次 overlay 的朝向（仅用于免重绘） */
    this._lastYaw = Infinity;
    /** 底图实际重绘次数（测试可读；钉住「节流真的生效」） */
    this.baseDraws = 0;
    /** overlay 实际重绘次数 */
    this.overlayDraws = 0;

    const dpr = Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    this._dpr = dpr;

    this.el = document.createElement('div');
    this.el.id = 'mc-minimap';
    // ⚠️ 左下角（用户 2026-10-29 指定）。`bottom:12px` 与快捷栏同高会让它贴着屏幕底边，
    // 而快捷栏在 `left:50%` 居中 —— 两者不重叠。z-index 取 45：低于 toast(90)/面板，
    // 高于世界（层级表见 CLAUDE.md 的 toast 段；本元素不参与模态）。
    // `box-sizing:border-box` 是载荷性的：否则 2px 边框会把外框撑到 157px，
    // 与 `MINIMAP_MAP_SIZE` 的断言（以及左下角贴边量）对不上。
    this.el.style.cssText =
      `position:fixed;left:12px;bottom:12px;z-index:45;box-sizing:border-box;` +
      `width:${MINIMAP_MAP_SIZE}px;height:${MINIMAP_MAP_SIZE}px;` +
      'border:2px solid rgba(0,0,0,.55);border-radius:3px;' +
      'background:rgba(0,0,0,.35);overflow:hidden;pointer-events:none;';

    this.baseCanvas = this._makeCanvas('mc-minimap-base', MINIMAP_SAMPLES);
    // ⚠️ 像素风放大的唯一实现：`pixelated` 让每个样本块是硬边（默认 bilinear 会把 9 色
    // 区块糊成一团渐变，在小尺寸下看起来像「颜色乱的噪点」而不是「区域分明」）。
    this.baseCanvas.style.imageRendering = 'pixelated';
    // overlay 用**高分**画布（`MINIMAP_MAP_SIZE × dpr`）：玩家点与朝向刺是矢量图形，
    // 与底图共用 51×51 会被放大成 3px 的硬边块（『点』变成 9px 方块）。
    this.overlayCanvas = this._makeCanvas('mc-minimap-overlay', Math.round(MINIMAP_MAP_SIZE * dpr));
    this.el.append(this.baseCanvas, this.overlayCanvas, this._makeCompass());

    root.appendChild(this.el);

    this._baseCtx = this.baseCanvas.getContext('2d');
    this._overlayCtx = this.overlayCanvas.getContext('2d');
    // 底图 ImageData 复用（每次重绘只读它、不重新分配 —— 见 paintMinimap 的注释）
    this._imageData = this._baseCtx.createImageData(MINIMAP_SAMPLES, MINIMAP_SAMPLES);
  }

  /**
   * @param {string} id
   * @param {number} px 画布内部像素边长
   */
  _makeCanvas(id, px) {
    const c = document.createElement('canvas');
    c.id = id;
    c.width = px;
    c.height = px;
    c.style.cssText =
      `position:absolute;left:0;top:0;width:${MINIMAP_MAP_SIZE}px;height:${MINIMAP_MAP_SIZE}px;` +
      'pointer-events:none;';
    return c;
  }

  /**
   * 罗盘「N」字（DOM 而非画布：它是静态的，画进 overlay 只会被反复擦掉重画）。
   * 位置 = 顶部居中，字号 11px + 文字阴影 —— 在任何底图色上都读得出来。
   */
  _makeCompass() {
    const n = document.createElement('div');
    n.id = 'mc-minimap-north';
    n.textContent = 'N';
    n.style.cssText =
      'position:absolute;left:50%;top:1px;transform:translateX(-50%);' +
      'font:bold 11px/1 monospace;color:#fff;text-shadow:0 0 3px #000,0 0 2px #000;' +
      'pointer-events:none;user-select:none;';
    return n;
  }

  /**
   * 每帧调用（内部按 `BASE_REDRAW_INTERVAL_MS` / `OVERLAY_REDRAW_INTERVAL_MS` 节流）。
   *
   * ⚠️ 传 `performance.now()` 基准的时刻（与帧循环同源；禁止 `Date.now()`，见 M6 教训）。
   * @param {number} nowMs
   */
  update(nowMs) {
    const p = this.game?.player?.physics?.pos;
    if (!p) return;

    if (nowMs - this._lastBaseMs >= BASE_REDRAW_INTERVAL_MS) {
      const moved = Math.abs(p.x - this._baseX) + Math.abs(p.z - this._baseZ);
      if (moved >= BASE_REDRAW_MIN_MOVE) {
        this._lastBaseMs = nowMs;
        this._baseX = p.x;
        this._baseZ = p.z;
        this.drawBase(p.x, p.z);
      }
    }

    if (nowMs - this._lastOverlayMs >= OVERLAY_REDRAW_INTERVAL_MS) {
      const yaw = this.game.player?.yaw ?? 0;
      // 朝向变化小于 ~1.1° 时 dots/刺的位置在 1px 内不可见 → 跳过
      if (Math.abs(yaw - this._lastYaw) > 0.02) {
        this._lastOverlayMs = nowMs;
        this._lastYaw = yaw;
        this.drawOverlay(yaw);
      }
    }
  }

  /**
   * 画底图（区域分类 + 配色）。玩家恒在正中 —— 采样公式见 `minimap-regions.js` 文件头。
   * @param {number} px @param {number} pz
   */
  drawBase(px, pz) {
    // 城市布局来自主线程已缓存的 region 布局（Worker 算好、`StructureIndex` 持有）。
    // 未就绪时传 null → 城内暂时按 biome 画（骨架可玩、不阻塞启动；就绪后下一帧自动补上）。
    const city = this.game.cityLayout();
    const ctx = minimapRegionContext(this.game.seed, px, pz, city);
    paintMinimap(this._imageData.data, px, pz, this.game.seed, ctx);
    this._baseCtx.putImageData(this._imageData, 0, 0);
    this.baseDraws++;
  }

  /**
   * 画玩家点（恒定画布正中）+ 朝向短刺。
   *
   * **朝向换算（与 `player.js` 的相机一致）**：`player.yaw = 0` 时相机朝 −Z（北）= 屏幕上方；
   * `player.js` 写的是 `camera.rotateY(this.yaw)`，故前向向量 = `(sin(-yaw), -cos(yaw))`
   * （`yaw=0` ⇒ `(0,-1)` 朝上；`yaw=-π/2` ⇒ `(1,0)` 朝右 = 东）。
   * ⚠️ 这是**唯一**的玩家朝向换算点；`minimap-regions.js` 只管底图的采样方向（不碰玩家朝向）。
   *
   * @param {number} yaw
   */
  drawOverlay(yaw) {
    const g = this._overlayCtx;
    const size = MINIMAP_MAP_SIZE;
    const c = size / 2;
    const r = DOT_RADIUS;
    // ⚠️ **清屏必须覆盖整张画布的设备像素**（v2.8 修掉的残影缺陷）。
    // `overlayCanvas.width = MINIMAP_MAP_SIZE × dpr`，而下面的 `scale(dpr)` 把绘图坐标系
    // 缩到了 CSS px。在 `scale()` **之前**用 `clearRect(0, 0, size, size)`（size = CSS 尺寸 153）
    // 时只清掉左上 1/dpr² 那块 —— dpr=2 时每次只清 1/4，刺画到右下/上方留下的那部分
    // 永远清不掉 → **转一圈就叠一圈残影**，玩家看不见最终朝向（用户 2026-10-29 报告）。
    // dpr=1 时两个尺寸数值相等，缺陷完全不可见（**静默**，所以回归用例必须跑 dpr=2）。
    // 两种写法都能用，本实现选「先按设备像素清、再 scale」：
    //   ① 本行（`clearRect` 用 `canvas.width/height`，在 `scale()` 之前）；
    //   ② 把 `clearRect(0,0,size,size)` 放到 `scale()` **之后**（CSS 尺寸 × dpr = 设备尺寸）。
    //   ✗ 错的只有一种：`clearRect(0,0,size,size)` 放在 `scale()` **之前**。
    g.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    g.save();
    // 画布内部像素 = CSS px × dpr，故把绘图坐标系缩回 CSS px —— 线宽/半径按 CSS px 写一次即可
    g.scale(this._dpr, this._dpr);
    g.lineJoin = 'round';

    // 朝向短刺（先画，压在圆点下面）
    const fx = Math.sin(-yaw);
    const fy = -Math.cos(yaw);
    g.beginPath();
    g.moveTo(c + fx * r, c + fy * r);
    g.lineTo(c + fx * (r + FACING_LEN), c + fy * (r + FACING_LEN));
    g.strokeStyle = 'rgba(0,0,0,.75)';
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.stroke();

    // 玩家点（白芯 + 深色描边：在任何底图色上都读得出来）
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,.9)';
    g.lineWidth = DOT_STROKE;
    g.stroke();
    g.restore();
    this.overlayDraws++;
  }

  /** 强制重绘（不节流）。启动首帧与测试用 —— 正常路径走 `update()` 的节流。 */
  redraw(px, pz) {
    const p = (px === undefined || pz === undefined)
      ? this.game?.player?.physics?.pos
      : { x: px, z: pz };
    if (!p) return;
    this._baseX = p.x;
    this._baseZ = p.z;
    this.drawBase(p.x, p.z);
    this._lastYaw = this.game?.player?.yaw ?? 0;
    this.drawOverlay(this._lastYaw);
  }

  /** 地图跨度对应的世界格（供测试与文档引用，避免第二份「样本数 × 步长」的算式） */
  get span() {
    return MINIMAP_SPAN;
  }

  dispose() {
    this.el.remove();
  }
}
