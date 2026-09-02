// src/ui/coords-hud.js — 坐标显示（M3-4）：x/y/z + biome + seed，250ms 节流（与 perf-hud 同节奏）
// biome 判定收口在 game.biomeAt（CITY 布局边界优先，否则 getBiome 纯函数）。

export class CoordsHUD {
  /**
   * @param {HTMLElement} root
   * @param {import('../core/game.js').Game} game
   */
  constructor(root, game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.id = 'mc-coords';
    this.el.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:50;padding:6px 10px;' +
      'background:rgba(0,0,0,.55);color:#fff;font:12px/1.6 monospace;' +
      'border-radius:4px;pointer-events:none;white-space:pre;text-align:right;';
    root.appendChild(this.el);
    this._lastUpdate = 0;
  }

  /** 每帧调用（250ms 节流刷新 DOM） */
  update(nowMs) {
    if (nowMs - this._lastUpdate < 250) return;
    this._lastUpdate = nowMs;
    const p = this.game.player?.physics?.pos;
    if (!p) return;
    const biome = this.game.biomeAt(p.x, p.z);
    this.el.textContent =
      `xyz ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `biome ${biome}  seed ${this.game.seed}`;
  }
}
