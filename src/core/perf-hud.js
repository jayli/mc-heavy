// src/core/perf-hud.js — HUD 性能面板（设计文档 §4.9）
export class PerfHUD {
  /** @param {import('./perf.js').PerfMonitor} monitor @param {HTMLElement} containerEl */
  constructor(monitor, containerEl) {
    this.monitor = monitor;
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:50;padding:6px 10px;' +
      'background:rgba(0,0,0,.55);color:#0f0;font:12px/1.6 monospace;' +
      'border-radius:4px;pointer-events:none;white-space:pre;';
    containerEl.appendChild(this.el);
    this._lastUpdate = 0;
  }

  /** 每帧调用；内部 250ms 节流刷新 DOM */
  update(nowMs) {
    if (nowMs - this._lastUpdate < 250) return;
    this._lastUpdate = nowMs;
    const s = this.monitor.snapshot();
    const lines = [
      `fps ${s.fps.toFixed(0)}`,
      `frame p50 ${s.frameMs.p50.toFixed(1)} p95 ${s.frameMs.p95.toFixed(1)} p99 ${s.frameMs.p99.toFixed(1)} ms`,
    ];
    for (const [name, m] of Object.entries(s.marks)) {
      lines.push(`${name} n=${m.count} avg ${m.avgMs.toFixed(2)} p95 ${m.p95Ms.toFixed(2)} ms`);
    }
    this.el.textContent = lines.join('\n');
  }
}
