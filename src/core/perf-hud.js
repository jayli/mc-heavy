// src/core/perf-hud.js — HUD 性能面板（设计文档 §4.9）+ 世界数据看板（2s 异步刷新）
import { DEBUG_FLAGS } from './debug-config.js';

export class PerfHUD {
  /**
   * @param {import('./perf.js').PerfMonitor} monitor
   * @param {HTMLElement} containerEl
   * @param {(() => Object) | null} [worldStatsFn] 世界统计提供函数（Game.worldStats）；
   *        非空时面板追加体素/面剔除/合批数据区，2s 异步刷新（非实时，守帧预算）
   */
  constructor(monitor, containerEl, worldStatsFn = null) {
    this.monitor = monitor;
    this.worldStatsFn = worldStatsFn;
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:50;padding:6px 10px;' +
      'background:rgba(0,0,0,.55);color:#0f0;font:12px/1.6 monospace;' +
      'border-radius:4px;pointer-events:none;white-space:pre;';
    containerEl.appendChild(this.el);
    this._lastUpdate = 0;
    this._lastWorldUpdate = -2000; // 首帧即刷一次
    this._worldLines = [];
  }

  /** 每帧调用；帧时区 250ms 节流、世界数据区 2000ms 节流刷新 DOM */
  update(nowMs) {
    if (nowMs - this._lastUpdate < 250) return;
    this._lastUpdate = nowMs;
    const s = this.monitor.snapshot();
    if (this.worldStatsFn && nowMs - this._lastWorldUpdate >= 2000) {
      this._lastWorldUpdate = nowMs;
      try {
        const stats = this.worldStatsFn();
        this._worldLines = formatWorldStats(stats);
        // 控制台日志（§4.9 statsLog）：与 HUD 同节奏，便于无鼠标环境读数据/断点调试
        if (DEBUG_FLAGS.statsLog) logWorldStats(stats, s.fps);
      } catch {
        this._worldLines = ['世界统计暂不可用'];
      }
    }
    const lines = [
      `fps ${s.fps.toFixed(0)}`,
      `frame p50 ${s.frameMs.p50.toFixed(1)} p95 ${s.frameMs.p95.toFixed(1)} p99 ${s.frameMs.p99.toFixed(1)} ms`,
    ];
    for (const [name, m] of Object.entries(s.marks)) {
      lines.push(`${name} n=${m.count} avg ${m.avgMs.toFixed(2)} p95 ${m.p95Ms.toFixed(2)} ms`);
    }
    if (this._worldLines.length) lines.push('──────────', ...this._worldLines);
    this.el.textContent = lines.join('\n');
  }
}

/** 千位缩写：1234→1.2k，1234567→1.23M */
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/**
 * 控制台输出世界数据（statsLog 开关，§4.9）。
 * 一行可读摘要（精确数值，便于核对恒等式）+ 原始统计对象（devtools 展开细查）。
 * @param {Object} s worldStats 数据
 * @param {number} fps 当前帧率（关联性能用）
 */
function logWorldStats(s, fps) {
  const ch = s.channels || {};
  const o = ch.opaque || {}, c = ch.cutout || {}, t = ch.transparent || {};
  const totalTris = (o.triangles || 0) + (c.triangles || 0) + (t.triangles || 0);
  const cullPct = (s.cullRatio * 100).toFixed(1);
  // 精确数值单行（HUD 用缩写，日志用原值方便验证 faces×4=vertices 等关系）
  const line = `[world-stats] fps=${fps.toFixed(0)} blocks=${s.blocks} faces=${s.faces}/${s.candidateFaces} ` +
    `culled=${s.culledFaces}(${cullPct}%) verts=${s.vertices} ` +
    `draw=${s.drawCalls} tris=${s.triangles}/${totalTris} ` +
    `o=${o.slots || 0}/${o.vertices || 0}v c=${c.slots || 0}/${c.vertices || 0}v t=${t.slots || 0}/${t.vertices || 0}v ` +
    `cols=${s.columns} sec=${s.sections}/${s.sectionCount}`;
  console.log(line, s);
}

/** 世界数据看板格式化（对应 mc-lite 面板语义：方块/面/剔除/合批/节省） */
function formatWorldStats(s) {
  const lines = [];
  const cullPct = (s.cullRatio * 100).toFixed(1);
  const ch = s.channels || {};
  const o = ch.opaque || {}, c = ch.cutout || {}, t = ch.transparent || {};
  const totalTris = (o.triangles || 0) + (c.triangles || 0) + (t.triangles || 0);
  // 第 1 行：方块 → 出块面（面剔除漏斗）
  lines.push(`方块 ${fmt(s.blocks)} 面 ${fmt(s.faces)}/${fmt(s.candidateFaces)}`);
  // 第 2 行：剔除面数 + 剔除率（= 节省的渲染面占比）
  lines.push(`剔除 ${fmt(s.culledFaces)} 省 ${cullPct}%`);
  // 第 3 行：合批（3 通道 BatchedMesh）+ 实际 draw + 锥内三角/总三角
  lines.push(`批3 draw ${s.drawCalls} 三角 ${fmt(s.triangles)}/${fmt(totalTris)}`);
  // 第 4 行：各通道 slot 数 + 顶点数
  lines.push(`o ${o.slots || 0}/${fmt(o.vertices || 0)}v c ${c.slots || 0}/${fmt(c.vertices || 0)}v t ${t.slots || 0}/${fmt(t.vertices || 0)}v`);
  // 第 5 行：column/section 规模 + 总顶点
  lines.push(`col ${s.columns} sec ${s.sections}/${s.sectionCount} 顶点 ${fmt(s.vertices)}`);
  return lines;
}
