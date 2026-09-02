// src/ui/settings-panel.js — 设置面板（M3-4）
// 视觉风格照搬 mc-lite `src/style/global.css` 的设置弹窗（#settings-modal/#settings-content/
// .setting-item/.btn-group/button）：Minecraft 灰底 GUI（#c6c6c6 + 4px 深灰边 + 5px 硬黑投影）
// + 斜角浮雕按钮（左上白/右下深灰，:hover 提亮，:active 反向斜角，选中态绿色 #559944）。
// hover/active/.active 等伪类与状态类无法用 inline style 表达，故注入一次性样式表
// （组件自带样式，不依赖宿主页面；重复构造只注入一次）。
// 档位：视距（持久化+重载生效）/ 画质 blur（重载生效）/ 音量（持久化，第一阶段无音频消费方）
// / 视觉风格（运行时即时）/ 帧预算档位（运行时即时，M3-2）/ 新世界（随机 seed + 清 edits + 重载）。
// 打开时：退出 pointer lock + 清空按键 + game.uiModal 置位（主循环跳过 player.update）。
import {
  VIEW_DISTANCE_OPTIONS, VISUAL_STYLE_OPTIONS, saveStoredSettings,
} from './settings.js';

const STYLE_ID = 'mc-settings-style';

/** mc-lite global.css 设置弹窗相关规则的移植（选择器加 mc- 前缀避免污染宿主页面） */
const PANEL_CSS = `
#settings-btn {
  position: fixed; top: 66px; right: 8px; width: 33px; height: 33px;
  background: rgba(0,0,0,0.6); border: 2px solid #555; color: #fff; font-size: 24px;
  display: flex; justify-content: center; align-items: center;
  cursor: pointer; z-index: 60; border-radius: 4px; user-select: none;
  transition: background 0.2s;
}
#settings-btn:hover { background: rgba(255,255,255,0.2); }

#settings-modal {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(0,0,0,0.7);
  justify-content: center; align-items: center;
  font-family: 'Segoe UI', sans-serif;
}
#settings-modal .mc-content {
  background: #c6c6c6; border: 4px solid #555; padding: 20px;
  width: 480px; min-height: 250px; border-radius: 4px;
  box-shadow: 5px 5px 0 #000;
  display: flex; flex-direction: column; text-align: center;
  max-height: 80vh; overflow: auto;
}
#settings-modal h2 {
  margin: 0 0 12px; text-align: left; font-size: 18px; font-weight: bold; color: #333;
}
#settings-modal .mc-item {
  margin: 0; display: flex; flex-direction: column; gap: 8px;
  font-weight: bold; color: #333;
  border-top: 1px solid #999; padding-top: 10px;
}
#settings-modal .mc-item:first-of-type { border-top: none; padding-top: 0; }
#settings-modal .mc-title { text-align: left; font-size: 14px; line-height: 1.2; font-weight: bold; }
#settings-modal .mc-btn-group { display: flex; gap: 8px; width: 100%; }
#settings-modal button {
  flex: 1; padding: 6px 4px; font-size: 12px;
  background: #8b8b8b; border: 2px solid #fff;
  border-right-color: #373737; border-bottom-color: #373737;
  color: #fff; cursor: pointer; font-family: inherit; font-weight: bold;
  text-shadow: 1px 1px 0 #000;
}
#settings-modal button:hover { background: #999; }
#settings-modal button:active {
  border: 2px solid #373737; border-right-color: #fff; border-bottom-color: #fff;
}
#settings-modal button.active {
  background: #559944; /* 绿色表示选中（mc-lite 同款） */
  border: 2px solid #373737; border-right-color: #fff; border-bottom-color: #fff;
}
#settings-modal .mc-world-row {
  display: flex; align-items: center; gap: 8px;
  border-top: 1px solid #999; padding-top: 10px; margin-top: 10px;
}
#settings-modal .mc-world-row .mc-title { flex: none; }
#settings-modal .mc-seed { font-size: 12px; color: #555; font-weight: bold; white-space: nowrap; }
#settings-modal .mc-footer {
  margin-top: auto; display: flex; justify-content: center; padding-top: 20px;
}
#settings-modal .mc-footer button { flex: none; padding: 8px 24px; font-size: 13px; }
`;

/** 注入面板样式表（幂等） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

export class SettingsPanel {
  /**
   * @param {HTMLElement} root hud 根节点
   * @param {import('../core/game.js').Game} game
   * @param {typeof import('./settings.js').DEFAULT_SETTINGS} settings 生效中的设置（resolveSettings 结果）
   */
  constructor(root, game, settings) {
    this.game = game;
    this.settings = settings;
    this.root = root;
    ensureStyle();

    // ⚙ 按钮（mc-lite #settings-btn：常驻右上、hover 提亮；坐标 HUD 下方避让）
    this.btn = document.createElement('div');
    this.btn.id = 'settings-btn';
    this.btn.textContent = '⚙';
    this.btn.addEventListener('click', () => this.toggle());
    root.appendChild(this.btn);

    // 模态框（display none/flex 切换，isOpen 依赖该口径）
    this.el = document.createElement('div');
    this.el.id = 'settings-modal';
    this.el.style.display = 'none';
    const box = document.createElement('div');
    box.className = 'mc-content';
    const h2 = document.createElement('h2');
    h2.textContent = '游戏设置';
    box.appendChild(h2);
    this.el.appendChild(box);
    root.appendChild(this.el);
    // 点击遮罩关闭（mc-lite settingsModal.onclick 语义）
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });

    box.appendChild(this._rowViewDistance());
    box.appendChild(this._rowBlur());
    box.appendChild(this._rowVolume());
    box.appendChild(this._rowVisualStyle());
    box.appendChild(this._rowBudget());
    box.appendChild(this._rowNewWorld());

    const footer = document.createElement('div');
    footer.className = 'mc-footer';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'settings-close';
    closeBtn.textContent = '确定';
    closeBtn.addEventListener('click', () => this.close());
    footer.appendChild(closeBtn);
    box.appendChild(footer);
  }

  // ---- 行构造（mc-lite .setting-item + .btn-group：标题左对齐、按钮等宽一行、选中态绿色） ----

  /**
   * @param {string} title 行标题
   * @param {Array<*>} values 档位值
   * @param {Array<string>} labels 档位文案
   * @param {*} current 当前值（渲染选中态）
   * @param {(v: *) => void} onPick 选档回调
   */
  _makeRow(title, values, labels, current, onPick) {
    const row = document.createElement('div');
    row.className = 'mc-item';
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = title;
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group';
    const btns = [];
    values.forEach((v, i) => {
      const b = document.createElement('button');
      b.textContent = labels[i];
      if (v === current) b.classList.add('active');
      b.addEventListener('click', () => {
        onPick(v);
        for (const bb of btns) bb.classList.remove('active');
        b.classList.add('active');
      });
      group.appendChild(b);
      btns.push(b);
    });
    row.appendChild(group);
    return row;
  }

  _rowViewDistance() {
    // 视距改动 → 持久化 + 带参重载（BatchedMesh maxInstances 构造期固定，不支持运行时扩容）
    return this._makeRow('视距', VIEW_DISTANCE_OPTIONS,
      VIEW_DISTANCE_OPTIONS.map(String), this.settings.viewDistance,
      (v) => {
        this.settings.viewDistance = v;
        this._save();
        this.game.applyViewDistance(v); // 重载生效
      });
  }

  _rowBlur() {
    return this._makeRow('画质（远处纹理）', [false, true], ['像素风', '平滑'],
      this.settings.blur,
      (v) => {
        this.settings.blur = v;
        this._save();
        this.game.setBlurQuality(v); // 重载生效（纹理 mip level 创建期固定）
      });
  }

  _rowVolume() {
    return this._makeRow('音量', [0, 0.5, 1], ['静音', '50%', '100%'],
      this.settings.volume,
      (v) => {
        this.settings.volume = v;
        this._save(); // 第一阶段无音频消费方（§9 扩展点），仅持久化
      });
  }

  _rowVisualStyle() {
    return this._makeRow('环境风格', VISUAL_STYLE_OPTIONS, ['自动', '早晨', '正午', '黑夜'],
      this.settings.visualStyle,
      (v) => {
        this.settings.visualStyle = v;
        this._save();
        this.game.setVisualStyle(v); // null = 恢复日夜循环（M2-6）
      });
  }

  _rowBudget() {
    return this._makeRow('帧预算', ['auto', 'high', 'low'], ['自动', '120Hz 档', '60Hz 档'],
      this.settings.budgetProfile,
      (v) => {
        this.settings.budgetProfile = v;
        this._save();
        this.game.budget.setProfile(v); // M3-2 手动覆盖
      });
  }

  _rowNewWorld() {
    const row = document.createElement('div');
    row.className = 'mc-world-row';
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = '世界';
    row.appendChild(t);
    const b = document.createElement('button');
    b.id = 'btn-new-world';
    b.textContent = '新世界（随机种子）';
    b.addEventListener('click', () => this.game.newWorld(null)); // null = 随机 seed
    row.appendChild(b);
    const cur = document.createElement('span');
    cur.className = 'mc-seed';
    cur.textContent = `当前 seed ${this.game.seed}`;
    row.appendChild(cur);
    return row;
  }

  _save() { saveStoredSettings(this.settings); }

  open() {
    this.el.style.display = 'flex';
    this.game.uiModal = true;
    this.game.player?.keys.clear(); // 打开瞬间清空按键，防 WASD 粘滞
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close() {
    this.el.style.display = 'none';
    this.game.uiModal = false;
  }

  toggle() {
    if (this.el.style.display === 'flex') this.close();
    else this.open();
  }

  get isOpen() { return this.el.style.display === 'flex'; }
}
