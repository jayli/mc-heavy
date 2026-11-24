// src/core/perf-hud.js — HUD 性能面板（设计文档 §4.9）+ 世界数据看板（2s 异步刷新）
import { DEBUG_FLAGS } from './debug-config.js';

/** 折叠动画时长（ms）：须与 bodyEl 的 max-height/opacity 过渡一致（transitionend 据此收尾） */
const FOLD_MS = 180;

/**
 * 面板固定宽度（px，border-box，含左右 padding 各 10）。
 *
 * 用户要求 v1.80：「数据看板的宽度也固定下来吧，不要宽度随着内容长短变化一直变」。
 * 取值依据**实测量到的最宽行**（不是拍脑袋）：字体 12px monospace 下的行宽
 *   「mesh-inflight n=137 avg 65.36 p95 112.00 ms」= **309.66px**（vd=16 真实跑 20s 的峰值）
 *   「light-inflight n=600 avg 100.00 p95 100.00 ms」= 324.06px（理论极端：n 满窗口 600 位）
 * 用户裁定取「实测峰值」口径 → 309.66 + 左右 padding 20 = 329.66 → 向上取整 **330**。
 * ⚠️ 这也是**内容宽度恒定的前提**：mark 行的 `n=` 字段宽度会随计数位数变（1~3 位），
 * `formatMarkLine()` 把它右对齐到 3 位，行宽才是结构性的定值 —— 否则某天 n 变 3 位时
 * 内容会溢出一截（`white-space:pre` 不换行 → 直接超出面板底色）。
 */
const PANEL_WIDTH_PX = 330;

/**
 * 分隔线（统计区与操作说明区上方各一条，长度必须一致）。
 * 用户 v1.80：「上面也增加一条横线，长度等于方块面文字上面的那条横线」——
 * 故两处**共用这一个常量**，不得各写一份字面量（两处会漂移出长短不一）。
 */
const SEP = '──────────';

/**
 * 操作说明（用户 v1.80 给定文案，v1.81 补飞行键位、v2.43 补召唤 Boss 键，
 * 2026-11-07 召唤键从 C 改为 B）。
 * 常量**只存面板里的静态文字**，不参与任何玩法判定 —— 键位的事实来源始终是
 * `player/player.js` 的输入绑定；这里若与那里不一致，是文案滞后，不是逻辑分叉。
 *
 * ⚠️ **往任何一行里加字必须实测行宽**（AGENTS.md「性能面板宽度固定 330px」条）：
 * 面板是 `white-space:pre` 不换行 + 固定 `PANEL_WIDTH_PX`，超宽就直接溢出面板底色。
 * v2.43 实测：第一行 194.42 → **288.03**（+20 padding = 308 < 330），最宽行仍是第二行
 * 273.63，故**不需要改 `PANEL_WIDTH_PX`**。
 */
const HELP_LINES = [
  '操作：a←s↓d→w↑ | Space：跳 | B：召唤Boss',
  'F：飞行开关 | 飞行中 Space：升 / Shift：降',
  'Z：背包 | X：丧尸 | C：士兵 | R：换枪',
  'Ctrl+鼠标左键：点燃TNT，矿车启动',
  // v3.20：持剑蓄力大招。行宽必须 < 内容区可用 310px（330 − 20 padding），
  // 否则撑宽面板 ⇒ tests/player-flight.spec.mjs 的「面板宽 330 + 无横向溢出」会红。
  // v3.21：补第三秒大招（行宽已实测，见 player-flight.spec）。
  '剑长戉2秒：Storm Lance',
  '剑长戉3秒：Cinder Fall',
];

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
      `width:${PANEL_WIDTH_PX}px;box-sizing:border-box;` +
      'background:rgba(0,0,0,.55);color:#0f0;font:12px/1.6 monospace;' +
      'border-radius:4px;pointer-events:none;';
    /**
     * 首行（常驻，不折叠）：fps + 右上角折叠按钮。
     * flex 让按钮贴到面板右缘。宽度已由 `PANEL_WIDTH_PX` 固定 → 按钮位置恒定。
     */
    this.headEl = document.createElement('div');
    this.headEl.style.cssText =
      'display:flex;justify-content:space-between;align-items:baseline;gap:16px;';
    this.fpsEl = document.createElement('span');
    this.fpsEl.style.cssText = 'white-space:pre;';
    this.btn = document.createElement('span');
    this.btn.setAttribute('role', 'button');
    this.btn.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;white-space:pre;';
    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    // 还需拦 mousedown：面板其余区域是 pointer-events:none，但按钮是 auto ——
    // 不拦的话按下事件会冒泡到 window 的 mousedown 监听（武器/放置路径的输入源）。
    this.btn.addEventListener('mousedown', (e) => e.stopPropagation());
    this.btn.addEventListener('mouseenter', () => { this.btn.style.opacity = '1'; });
    this.btn.addEventListener('mouseleave', () => { this.btn.style.opacity = '.75'; });
    this.headEl.append(this.fpsEl, this.btn);
    /**
     * 折叠区：帧时分位 + 各 mark + 分隔线 + 世界数据看板。
     * max-height 在展开态收尾时置 `none`（内容行数会随 mark 与世界数据变化，固定 px 会裁掉新行）。
     */
    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText =
      'overflow:hidden;white-space:pre;' +
      `transition:max-height ${FOLD_MS}ms ease,opacity ${FOLD_MS}ms ease;`;
    this.bodyEl.addEventListener('transitionend', (e) => {
      if (e.target !== this.bodyEl || e.propertyName !== 'max-height') return;
      if (!this._collapsed) this.bodyEl.style.maxHeight = 'none';
    });
    /**
     * 操作说明区（用户 v1.80：面板下方增加键位提示，高度扩展、宽度不变）。
     * 与 bodyEl 同级且同在 el 内 → 继承固定宽度；静态文本只在构造时写一次
     * （不得搭进 `update()` 的 250ms 重写路径 —— 那是每帧节流后的热路径）。
     * 它**随面板一起折叠**（用户裁定）：收起后只剩 fps 行，视野最大化。
     */
    this.helpEl = document.createElement('div');
    this.helpEl.style.cssText =
      'overflow:hidden;white-space:pre;' +
      `transition:max-height ${FOLD_MS}ms ease,opacity ${FOLD_MS}ms ease;`;
    this.helpEl.textContent = [SEP, ...HELP_LINES].join('\n');
    // 展开收尾同样把 max-height 置回 `none`（与 bodyEl 同一原因：固定 px 会裁掉将来变长的文案）。
    this.helpEl.addEventListener('transitionend', (e) => {
      if (e.target !== this.helpEl || e.propertyName !== 'max-height') return;
      if (!this._collapsed) this.helpEl.style.maxHeight = 'none';
    });
    this.el.append(this.headEl, this.bodyEl, this.helpEl);
    containerEl.appendChild(this.el);
    this._lastUpdate = 0;
    this._lastWorldUpdate = -2000; // 首帧即刷一次
    this._worldLines = [];
    // 启动态**默认收起**（用户 2026-11-21 裁定，推翻 v1.79 的「每次启动都展开」）：
    // 进游戏先给画面留视野，需要数据时点首行右侧的 `[+]` 展开。
    // 折叠状态仍**不持久化**（与 v1.79 同口径）：刷新/重开存档一律回到收起。
    this._collapsed = true;
    this._applyCollapsedState();
  }

  /** 收起/展开切换（`[-]` ⇄ `[+]`） */
  toggle() { this.setCollapsed(!this._collapsed); }

  /**
   * 收起或展开折叠区（带动画）。收起后只留首行（fps + 按钮），给游戏留出视野。
   * @param {boolean} collapsed
   */
  setCollapsed(collapsed) {
    if (collapsed === this._collapsed) return;
    this._collapsed = collapsed;
    this._applyCollapsedState(true);
  }

  /**
   * 把 `_collapsed` 落到 DOM（按钮文案 + 折叠区高度/透明度）。
   * @param {boolean} [animate] false = 立即到位（仅构造期，避免启动时播一次动画）
   */
  _applyCollapsedState(animate = false) {
    const c = this._collapsed;
    this.btn.textContent = c ? '[+]' : '[-]';
    this.btn.setAttribute('aria-label', c ? '展开性能面板' : '收起性能面板');
    this.btn.setAttribute('aria-expanded', String(!c));
    this.btn.title = c ? '展开性能面板' : '收起性能面板';
    this.btn.style.opacity = '.75';
    // 折叠区 = bodyEl（统计）+ helpEl（操作说明）两个兄弟节点。两者要**同步过渡**：
    // 只折 bodyEl 会让操作说明在收起态仍占着一大块高度（用户要求收起后只留 fps 行）。
    const parts = [this.bodyEl, this.helpEl];
    if (!animate) {
      for (const p of parts) {
        p.style.maxHeight = c ? '0px' : 'none';
        p.style.opacity = c ? '0' : '1';
      }
      return;
    }
    // scrollHeight 恒为内容全高（与当前 max-height 无关），故两个方向都从它起步。
    // ⚠️ 展开态 max-height 是 `none` —— 从 `none` 直接过渡是瞬变、没有动画，
    //    必须先落成实测像素并强制一次回流，浏览器才有起点可比。
    //    回流每段只做一次（读完所有 scrollHeight 再写），不逐个节点穿插读写。
    for (const p of parts) p.style.maxHeight = p.scrollHeight + 'px';
    void this.bodyEl.offsetHeight; // 强制回流，固定动画起点
    for (const p of parts) {
      if (c) {
        p.style.maxHeight = '0px';
        p.style.opacity = '0';
      } else {
        p.style.opacity = '1';
      }
    }
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
    // 首行（fps）常驻 head，其余全部进可折叠的 body
    this.fpsEl.textContent = `fps ${s.fps.toFixed(0)}`;
    const lines = [
      `frame p50 ${s.frameMs.p50.toFixed(1)} p95 ${s.frameMs.p95.toFixed(1)} p99 ${s.frameMs.p99.toFixed(1)} ms`,
    ];
    for (const [name, m] of Object.entries(s.marks)) {
      // n 右对齐到 3 位 = 面板宽度恒定的前提（见 PANEL_WIDTH_PX 注释）：
      // 计数从 9 涨到 10 会让整行宽跳一档，那是用户报告的「宽度一直变」的直接来源之一。
      lines.push(formatMarkLine(name, m));
    }
    if (this._worldLines.length) lines.push(SEP, ...this._worldLines);
    this.bodyEl.textContent = lines.join('\n');
  }
}

/**
 * mark 行格式化。`n=` 右对齐到 3 位：面板宽度是固定值（`PANEL_WIDTH_PX`），
 * 而计数位数会变（1→2→3 位）—— 不右对齐时整行宽度随计数增长而跳变。
 * @param {string} name
 * @param {{count:number, avgMs:number, p95Ms:number}} m
 */
function formatMarkLine(name, m) {
  return `${name} n=${String(m.count).padStart(3, ' ')} ` +
    `avg ${m.avgMs.toFixed(2)} p95 ${m.p95Ms.toFixed(2)} ms`;
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
