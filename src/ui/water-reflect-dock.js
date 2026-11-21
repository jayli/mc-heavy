// src/ui/water-reflect-dock.js — 水面倒影的常驻调参坞（v3.17）
//
// ## 为什么是常驻坞而不是设置面板里的一行
// 倒影是**观感参数**：强度 / 朦胧度 / 晃动幅度 / 刷新节奏都要边看水边调。
// 塞进设置面板意味着「改一个值 → 关面板 → 看效果 → 再开面板」，而水面在面板遮罩下
// 根本看不见（面板是 70 层的全屏半透明黑遮罩）。故独立成右下角常驻坞，
// 拖动滑块时水面**就在旁边实时变**。
//
// ## 层级
// 取 **50**（与坐标/性能面板、血心同层 = 常驻信息）。低于设置按钮 60、设置面板 70、
// 背包 80 ⇒ 打开任何模态时它自动被盖住，不与模态争位（AGENTS.md 的层级不等式）。
//
// ## 与迷你地图不重叠
// 迷你地图在**左下**（153px 见方 + 12px 边距），本坞在**右下**，水平不相交。
// 快捷栏在底部居中，本坞靠右且底边留 12px —— 1280 宽下实测右缘不与快捷栏相交。
//
// ## 折叠态
// 标题栏可点击收起（只留标题条）。与性能面板用同一套状态语义：**默认折起、不持久化**
// —— 它是调试/调参入口，展开会遮住右下角水面，玩家只在调参时临时展开。
import {
  REFLECT_STRENGTH, REFLECT_DISTORT, REFLECT_MIP_LEVEL, REFLECT_REFRESH_EVERY,
  REFLECT_HEIGHT_FULL, REFLECT_HEIGHT_ZERO, REFLECT_GRAZE, REFLECT_RESOLUTION_SCALE, REFLECT_TINT,
} from '../render/water-reflect-config.js';

/** 坞的 z-index（常驻信息层，见文件头） */
export const REFLECT_DOCK_Z_INDEX = 50;

/** 滑块档位定义（唯一权威：DOM、初值、reset 都从这里派生） */
export const REFLECT_SLIDERS = Object.freeze([
  Object.freeze({
    key: 'strength', label: '倒影强度', min: 0, max: 1, step: 0.01,
    value: REFLECT_STRENGTH, fmt: (v) => `${Math.round(v * 100)}%`,
    hint: '水面颜色里倒影占多少',
  }),
  Object.freeze({
    key: 'tint', label: '水面吸收', min: 0.1, max: 1, step: 0.01,
    value: REFLECT_TINT, fmt: (v) => `${Math.round(v * 100)}%`,
    hint: '倒影反射率；越高水越亮（100% = 理想镜面）',
  }),
  Object.freeze({
    key: 'blur', label: '朦胧度', min: 0, max: 4, step: 1,
    value: REFLECT_MIP_LEVEL, fmt: (v) => (v === 0 ? '清晰' : `${v} 级`),
    hint: 'mip 级别，越高越糊',
  }),
  Object.freeze({
    key: 'distort', label: '随波晃动', min: 0, max: 0.06, step: 0.001,
    value: REFLECT_DISTORT, fmt: (v) => (v === 0 ? '静止' : v.toFixed(3)),
    hint: '倒影跟着水纹扭曲的幅度',
  }),
  Object.freeze({
    key: 'graze', label: '视角影响', min: 0, max: 1, step: 0.01,
    value: REFLECT_GRAZE, fmt: (v) => (v === 0 ? '关' : `${Math.round(v * 100)}%`),
    hint: '贴水面看倒影强、俯视弱（Fresnel）',
  }),
  Object.freeze({
    key: 'heightFull', label: '满强度高度', min: 1, max: 60, step: 1,
    value: REFLECT_HEIGHT_FULL, fmt: (v) => `${v} 格`,
    hint: '低于此高度倒影满强度',
  }),
  Object.freeze({
    key: 'heightZero', label: '消失高度', min: 2, max: 160, step: 1,
    value: REFLECT_HEIGHT_ZERO, fmt: (v) => `${v} 格`,
    hint: '高于此高度倒影消失且反射 pass 不跑（省性能）',
  }),
  Object.freeze({
    key: 'scale', label: '倒影分辨率', min: 0.1, max: 1, step: 0.01,
    value: REFLECT_RESOLUTION_SCALE, fmt: (v) => `${Math.round(v * 100)}%`,
    hint: 'RT 边长倍率（改显存与锐度，几乎不影响帧时）',
  }),
  Object.freeze({
    key: 'every', label: '刷新间隔', min: 1, max: 6, step: 1,
    value: REFLECT_REFRESH_EVERY, fmt: (v) => `${v} 帧`,
    hint: '越大越省性能，倒影延迟越高',
  }),
]);

const DOCK_CSS = `
#mc-reflect-dock {
  position: fixed; right: 12px; bottom: 12px; z-index: ${REFLECT_DOCK_Z_INDEX};
  width: 232px; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #dff1ff;
  background: linear-gradient(160deg, rgba(9,26,43,0.90) 0%, rgba(6,17,29,0.92) 100%);
  border: 1px solid rgba(108,196,255,0.34);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.55), inset 0 1px 0 rgba(160,225,255,0.16);
  backdrop-filter: blur(3px);
  overflow: hidden;
  user-select: none;
}
#mc-reflect-dock .rd-head {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 9px; cursor: pointer;
  background: linear-gradient(90deg, rgba(34,89,138,0.85), rgba(12,52,88,0.55));
  border-bottom: 1px solid rgba(108,196,255,0.26);
}
#mc-reflect-dock .rd-title {
  font-size: 11px; font-weight: bold; letter-spacing: 1.4px; flex: 1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);
}
#mc-reflect-dock .rd-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #4fe3a1; box-shadow: 0 0 7px #4fe3a1;
  transition: background .18s, box-shadow .18s;
}
#mc-reflect-dock.rd-off .rd-dot { background: #6b7a88; box-shadow: none; }
#mc-reflect-dock .rd-fold {
  font-size: 12px; line-height: 1; padding: 1px 5px; border-radius: 3px;
  background: rgba(120,200,255,0.14); border: 1px solid rgba(120,200,255,0.3);
  color: #bfe6ff;
}
#mc-reflect-dock .rd-body {
  display: flex; flex-direction: column; gap: 6px;
  padding: 9px;
  /* 九个滑块 + 三按钮 + 读数 ≈ 430px；上限取视口比例而不是写死像素，
     否则短屏（如 620 高）下底部按钮与读数会被裁掉（overflow:hidden 会直接吃掉它们）。*/
  max-height: min(64vh, 460px); overflow-y: auto; overflow-x: hidden;
  transition: max-height .22s ease, padding .22s ease, opacity .18s ease;
}
#mc-reflect-dock.rd-folded .rd-body {
  max-height: 0; padding-top: 0; padding-bottom: 0; opacity: 0; overflow: hidden;
}
#mc-reflect-dock .rd-row { display: flex; flex-direction: column; gap: 3px; }
#mc-reflect-dock .rd-lab {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 10px; letter-spacing: .5px; color: #9fc6e2;
}
#mc-reflect-dock .rd-val { color: #6fe3ff; font-weight: bold; font-size: 10px; }
#mc-reflect-dock input[type=range] {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 14px; background: transparent; cursor: pointer; margin: 0;
}
#mc-reflect-dock input[type=range]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px;
  background: linear-gradient(90deg, #2a6f9e, #123b58);
  border: 1px solid rgba(120,200,255,0.22);
}
#mc-reflect-dock input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 11px; height: 11px; margin-top: -4.5px; border-radius: 50%;
  background: radial-gradient(circle at 34% 30%, #d9f6ff, #35b6e8 62%, #1670a0);
  border: 1px solid #0a2c44;
  box-shadow: 0 0 6px rgba(80,205,255,0.75);
}
#mc-reflect-dock input[type=range]:hover::-webkit-slider-thumb {
  box-shadow: 0 0 10px rgba(120,225,255,0.95);
}
#mc-reflect-dock input[type=range]::-moz-range-track {
  height: 4px; border-radius: 2px; background: #1d5478;
}
#mc-reflect-dock input[type=range]::-moz-range-thumb {
  width: 11px; height: 11px; border-radius: 50%; border: 1px solid #0a2c44;
  background: #35b6e8;
}
#mc-reflect-dock .rd-btns { display: flex; gap: 5px; margin-top: 1px; }
#mc-reflect-dock .rd-btn {
  flex: 1; padding: 5px 2px; font-size: 10px; font-family: inherit; font-weight: bold;
  letter-spacing: .6px; cursor: pointer; border-radius: 4px;
  color: #e6f6ff; background: rgba(46,110,158,0.5);
  border: 1px solid rgba(120,200,255,0.34);
  transition: background .15s, border-color .15s, transform .08s;
}
#mc-reflect-dock .rd-btn:hover { background: rgba(66,146,204,0.68); border-color: rgba(160,225,255,0.6); }
#mc-reflect-dock .rd-btn:active { transform: translateY(1px); }
#mc-reflect-dock .rd-btn.rd-on {
  background: linear-gradient(180deg, #2f9e6e, #1d7550);
  border-color: rgba(120,255,200,0.5); color: #eafff5;
}
#mc-reflect-dock .rd-btn.rd-off {
  background: rgba(70,84,96,0.55); border-color: rgba(150,170,185,0.3); color: #b9c9d6;
}
#mc-reflect-dock .rd-stat {
  font-size: 9px; color: #7fa8c4; letter-spacing: .4px;
  display: flex; justify-content: space-between; gap: 6px;
  border-top: 1px solid rgba(108,196,255,0.16); padding-top: 5px;
}
#mc-reflect-dock .rd-stat b { color: #9fe8ff; font-weight: bold; }
/* 坞内滚动条走自己的配色（不用浏览器默认灰） */
#mc-reflect-dock .rd-body::-webkit-scrollbar { width: 6px; }
#mc-reflect-dock .rd-body::-webkit-scrollbar-track { background: rgba(10,32,50,0.6); }
#mc-reflect-dock .rd-body::-webkit-scrollbar-thumb {
  background: rgba(90,180,235,0.55); border-radius: 3px;
}
#mc-reflect-dock .rd-body::-webkit-scrollbar-thumb:hover { background: rgba(130,215,255,0.8); }
/* 窄屏：坞收窄并允许纵向滚动，绝不与快捷栏/迷你地图抢位 */
@media (max-width: 900px) {
  #mc-reflect-dock { width: 190px; right: 8px; bottom: 8px; }
  #mc-reflect-dock .rd-body { max-height: min(52vh, 380px); }
}
/* 手机竖屏（≤560px）：快捷栏居中且几乎占满宽度 ⇒ 右下角**必定**与它重叠
   （390×780 实测 overlapsHotbar=true，而当时只在 820 档钉了这条 ⇒ 漏网）。
   改成靠**右上**：避开底部快捷栏与左下迷你地图；top 下推到坐标面板下方。 */
@media (max-width: 560px) {
  /* ⚠️⚠️ **窄屏下快捷栏不是横条而是竖条**（实测推翻直觉）：
     它是 display:flex 无 nowrap、九格×44px ⇒ 宽度不够时**折行**，
     390×780 实测 rect = **52×404**（x 169~221, y 364~768）—— 几乎占满屏高。
     ⇒ 「右下角」与「右上角」都会压它（右上那版实测 y 104~545 与它相交）。
     唯一不撞的位置是**顶部横带**（快捷栏顶边 364 之上），且宽 168 靠右
     （x 216~384）也避开了左下迷你地图（x 12~165, y 615~768）。
     ⚠️ 高度必须按「快捷栏顶边 − top − 余量」算：780 下可用 ≈ 248，减标题条 30 ⇒ 218。
     取 100vh − 562px（= top 104 + 快捷栏区 404 + 余量 24 + 标题条 30），
     并给 120px 下限（极短屏上宁可让它自己滚，也不能把控件压成 0 高）。
     ⚠️ 本注释在 JS 模板字面量内，**不得用反引号**包裹标识符（会提前终止模板串）。 */
  #mc-reflect-dock {
    width: 158px; right: 6px; top: 96px; bottom: auto;
    height: fit-content;
  }
  /* 快捷栏竖条顶边实测在 y=364（390×780）⇒ 坞底必须 ≤ 352。
     可用 body 高 = 352 − top(96) − 标题条(28) − 余量(8) = 220。
     写成 100vh − 560：780 → 220 ✓；更短的屏按同一比例收紧，下限 108 保控件可读。 */
  #mc-reflect-dock .rd-body { max-height: max(108px, calc(100vh - 560px)); }
  #mc-reflect-dock .rd-lab { font-size: 9px; }
  #mc-reflect-dock .rd-btn { font-size: 9px; padding: 4px 1px; }
}
`;

const STYLE_ID = 'mc-reflect-dock-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = DOCK_CSS;
  document.head.appendChild(s);
}

export class WaterReflectDock {
  /**
   * @param {HTMLElement} root HUD 根
   * @param {import('../core/game.js').Game} game
   */
  constructor(root, game) {
    ensureStyle();
    this.game = game;
    /** @type {Map<string, HTMLInputElement>} */
    this.inputs = new Map();
    /** @type {Map<string, HTMLElement>} */
    this.values = new Map();
    this._folded = false;
    this._lastStatMs = -Infinity;

    this.el = document.createElement('div');
    this.el.id = 'mc-reflect-dock';

    const head = document.createElement('div');
    head.className = 'rd-head';
    this.dot = document.createElement('span');
    this.dot.className = 'rd-dot';
    const title = document.createElement('span');
    title.className = 'rd-title';
    title.textContent = '水面倒影';
    this.foldBtn = document.createElement('span');
    this.foldBtn.className = 'rd-fold';
    this.foldBtn.textContent = '−';
    head.append(this.dot, title, this.foldBtn);
    head.addEventListener('click', () => this.toggleFold());
    this.el.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'rd-body';
    this.el.appendChild(this.body);

    for (const def of REFLECT_SLIDERS) this.body.appendChild(this._makeSlider(def));

    const btns = document.createElement('div');
    btns.className = 'rd-btns';
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'rd-btn rd-on';
    this.toggleBtn.id = 'rd-toggle';
    this.toggleBtn.addEventListener('click', () => this._onToggle());
    const reset = document.createElement('button');
    reset.className = 'rd-btn';
    reset.id = 'rd-reset';
    reset.textContent = '复位';
    reset.addEventListener('click', () => this.reset());
    const presets = document.createElement('button');
    presets.className = 'rd-btn';
    presets.id = 'rd-preset';
    presets.textContent = '换档';
    presets.addEventListener('click', () => this.cyclePreset());
    btns.append(this.toggleBtn, reset, presets);
    this.body.appendChild(btns);

    this.stat = document.createElement('div');
    this.stat.className = 'rd-stat';
    this.stat.innerHTML = '<span>RT <b id="rd-rt">—</b></span><span>刷新 <b id="rd-hz">—</b></span>'
      + '<span>高度 <b id="rd-h">—</b></span>';
    this.body.appendChild(this.stat);

    root.appendChild(this.el);
    this._presetIndex = 0;
    this._syncToggle();
    this.reset();
    // ⚠️ **默认折起**（用户 2026-11-18 裁定：「水面倒影的 HUD 面板默认关闭」）：
    // 只留标题条（12px 高的「水面倒影」+ 开关点），不占地、不遮水。
    // ⚠️ **不做成彻底隐藏**：彻底隐藏后玩家找不回这个开关（无任何入口）——
    // 标题条是它的唯一入口，保留它才能「默认关闭」与「可重新打开」同时成立。
    // ⚠️ 必须放在 `reset()` **之后**：`reset()` 会调 `_refreshStat` 但不碰折叠态，
    // 放在前面也能工作；放后面是为了让「折叠」成为构造的最后一步（不会被后续写覆盖）。
    this.setFolded(true);
  }

  /**
   * 设置折叠态（默认折起，见构造器注释）。
   * 用方法而不是直接写 `_folded`：`foldBtn` 的文案与 class 必须与状态同步，
   * 三处（`_folded` / class / 图标）分开写就会漂出「图标说 ＋ 而面板是展开的」这类静默不一致。
   * @param {boolean} folded
   */
  setFolded(folded) {
    this._folded = !!folded;
    this.el.classList.toggle('rd-folded', this._folded);
    this.foldBtn.textContent = this._folded ? '+' : '−';
  }

  _makeSlider(def) {
    const row = document.createElement('div');
    row.className = 'rd-row';
    const lab = document.createElement('div');
    lab.className = 'rd-lab';
    const name = document.createElement('span');
    name.textContent = def.label;
    name.title = def.hint;
    const val = document.createElement('span');
    val.className = 'rd-val';
    val.id = `rd-val-${def.key}`;
    lab.append(name, val);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `rd-${def.key}`;
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(def.value);
    input.title = def.hint;
    input.addEventListener('input', () => {
      this._apply(def.key, Number(input.value));
    });
    row.append(lab, input);
    this.inputs.set(def.key, input);
    this.values.set(def.key, val);
    return row;
  }

  /** 把一个滑块值推给 game，并刷新读数（唯一写入点） */
  _apply(key, v) {
    const g = this.game;
    let actual = v;
    if (key === 'strength') actual = g.setReflectStrength(v);
    else if (key === 'tint') actual = g.setReflectTint(v);
    else if (key === 'blur') actual = g.setReflectBlur(v);
    else if (key === 'distort') actual = g.setReflectDistort(v);
    else if (key === 'graze') actual = g.setReflectGraze(v);
    else if (key === 'heightFull') actual = g.setReflectHeightFull(v);
    else if (key === 'heightZero') actual = g.setReflectHeightZero(v);
    else if (key === 'scale') actual = g.setReflectScale(v);
    else if (key === 'every') actual = g.setReflectEvery(v);
    const def = REFLECT_SLIDERS.find((d) => d.key === key);
    const el = this.values.get(key);
    if (def && el) el.textContent = def.fmt(actual);
    // game 侧可能钳制过（非法值/范围），把滑块回写成真实生效值，避免"显示与生效不一致"
    const inp = this.inputs.get(key);
    if (inp && Number(inp.value) !== actual) inp.value = String(actual);
    // 两个高度阈值互相钳制 ⇒ 改一个可能连带改另一个，把对方的滑块与读数一并同步
    // （不同步的形态是「滑块显示 40 而实际生效 17」，玩家会以为功能坏了）。
    if (key === 'heightFull' || key === 'heightZero') {
      for (const [k, v] of [['heightFull', g._reflectHeightFull], ['heightZero', g._reflectHeightZero]]) {
        if (k === key) continue;
        const other = this.inputs.get(k);
        const def = REFLECT_SLIDERS.find((d) => d.key === k);
        const lab = this.values.get(k);
        if (other && Number(other.value) !== v) other.value = String(v);
        if (def && lab) lab.textContent = def.fmt(v);
      }
    }
    this._refreshStat(true);
  }

  _onToggle() {
    const on = this.game.setReflectEnabled(!this.game._reflectEnabled);
    this._syncToggle();
    this._refreshStat(true);
    return on;
  }

  _syncToggle() {
    const on = !!this.game._reflectEnabled;
    this.toggleBtn.textContent = on ? '已开启' : '已关闭';
    this.toggleBtn.className = `rd-btn ${on ? 'rd-on' : 'rd-off'}`;
    this.el.classList.toggle('rd-off', !on);
  }

  /** 全部滑块回到设计默认值（并逐个推给 game） */
  reset() {
    for (const def of REFLECT_SLIDERS) {
      const inp = this.inputs.get(def.key);
      if (inp) inp.value = String(def.value);
      this._apply(def.key, def.value);
    }
    this._presetIndex = 0;
    this._refreshStat(true);
  }

  /**
   * 三档预设循环：静镜 / 微漾 / 涌浪。
   * 每档同时改强度、朦胧、晃动、节奏 —— 让用户一眼看出这套参数的表现范围。
   */
  cyclePreset() {
    const presets = [
      { strength: 0.42, tint: 0.72, blur: 0, distort: 0.004, graze: 0.20, heightFull: 24, heightZero: 72, scale: 1.00, every: 1 },  // 静镜
      { strength: REFLECT_STRENGTH, tint: REFLECT_TINT, blur: REFLECT_MIP_LEVEL, distort: REFLECT_DISTORT, graze: REFLECT_GRAZE, heightFull: REFLECT_HEIGHT_FULL, heightZero: REFLECT_HEIGHT_ZERO, scale: REFLECT_RESOLUTION_SCALE, every: REFLECT_REFRESH_EVERY },  // 微漾（= 设计默认，不写第二份字面量）
      { strength: 0.68, tint: 0.40, blur: 3, distort: 0.044, graze: 0.70, heightFull: 10, heightZero: 28, scale: 0.45, every: 3 },  // 涌浪
    ];
    this._presetIndex = (this._presetIndex + 1) % presets.length;
    const p = presets[this._presetIndex];
    for (const [k, v] of Object.entries(p)) {
      const inp = this.inputs.get(k);
      if (inp) inp.value = String(v);
      this._apply(k, v);
    }
    if (!this.game._reflectEnabled) { this.game.setReflectEnabled(true); this._syncToggle(); }
    return this._presetIndex;
  }

  toggleFold() {
    this.setFolded(!this._folded);
  }

  /** 读数刷新（250ms 节流；RT 尺寸与有效刷新率） */
  _refreshStat(force = false) {
    const now = performance.now();
    if (!force && now - this._lastStatMs < 250) return;
    this._lastStatMs = now;
    const rtEl = this.el.querySelector('#rd-rt');
    const hzEl = this.el.querySelector('#rd-hz');
    const hEl = this.el.querySelector('#rd-h');
    if (!rtEl || !hzEl) return;
    const reflect = this.game.ocean?.reflect;
    const rt = reflect && reflect.renderTargets ? [...reflect.renderTargets.values()][0] : null;
    rtEl.textContent = rt ? `${rt.width}×${rt.height}` : '待渲染';
    const every = this.game.reflectScheduler?.every ?? REFLECT_REFRESH_EVERY;
    const fade = this.game.ocean?.uReflectHeightFade?.value ?? 1;
    hzEl.textContent = this.game._reflectEnabled ? (fade > 0.001 ? `1/${every} 帧` : '高度停') : '停';
    if (hEl) {
      const camY = this.game.camera?.position?.y;
      const dh = Number.isFinite(camY) ? camY - (-1.5) : null;
      hEl.textContent = dh === null ? '—' : `${dh.toFixed(0)}格 ${Math.round(fade * 100)}%`;
    }
  }

  /** 每帧调（内部 250ms 节流，未到期只有一次时间比较） */
  update() { this._refreshStat(false); }

  dispose() { this.el.remove(); }
}