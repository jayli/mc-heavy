// src/ui/inventory.js — 背包面板（M3.1，设计文档 §4.5.4，v1.16 定稿）
// 视觉与交互照搬 mc-lite `src/ui/Inventory.js` + `src/style/global.css:22-63`：
// Minecraft 灰底 GUI（#c6c6c6 + 4px 深灰边 + 5px 硬黑投影）+ 48×48 斜角浮雕槽位
// （左上白/右下 #373737，:hover 提亮，.selected 3px 黄边）+ 8 列可滚动网格。
// 与 mc-lite 的三处有意差异（均记录在 §4.5.4）：
//   ① **不渲染 count**——创造模式无限背包，显示 1500 是噪声（mc-lite 渲染）；
//   ② 图标用 atlas tile CSS background 裁剪（复用 hotbar 的 tileStyle），
//      不用 mc-lite 的 canvas → dataURL img；
//   ③ 关闭时 pointer lock 回 **canvas**，不是 mc-lite 的 document.body——本仓库 Player 的
//      `document.pointerLockElement !== this.canvas` 守卫会令锁 body 时视角与放挖全失效。
// 模态门控走 game.pushModal/popModal（M3.1 模态栈，收口原可写布尔的多面板竞争）。
import { tileOfName as defaultTileOfName, tileStyle } from './hotbar.js';

const STYLE_ID = 'mc-inventory-style';
/** 模态栈 owner 标识（game.popModal 只移除自己，不误清设置面板的门控） */
const MODAL_OWNER = 'inventory';
/** 槽位图标边长（mc-lite `.slot img` 32×32） */
const ICON_SIZE = 32;

/** mc-lite global.css 背包相关规则的移植（选择器加 mc- 前缀避免污染宿主页面） */
const PANEL_CSS = `
/* z-index 80 > 设置面板的 70：两个模态可共存于栈中（§4.5.4 模态栈），
   后开的背包必须在视觉上层，否则设置面板开着时按 Z 打开的是一个被完全盖住的背包。
   Escape 关最上层（背包）后回落到设置面板，符合菜单分层直觉。 */
#inventory-modal {
  position: fixed; inset: 0; z-index: 80;
  background: rgba(0,0,0,0.7);
  justify-content: center; align-items: center;
  font-family: 'Segoe UI', sans-serif;
}
#inventory-modal #inventory-content {
  background: #c6c6c6; border: 4px solid #555; padding: 20px;
  width: 600px; height: 400px; border-radius: 4px;
  box-shadow: 5px 5px 0 #000;
  display: flex; flex-direction: column;
}
#inventory-modal h2 {
  margin: 0; font-size: 18px; font-weight: bold; color: #333; text-align: left;
}
#inventory-modal #inventory-grid {
  display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px;
  overflow-y: auto; margin-top: 15px;
}
#inventory-modal .mc-slot {
  width: 48px; height: 48px; background: #8b8b8b; border: 2px solid #fff;
  border-right-color: #373737; border-bottom-color: #373737;
  display: flex; justify-content: center; align-items: center; position: relative;
  transition: border-color 0.1s; cursor: pointer;
}
#inventory-modal .mc-slot:hover { background-color: #999; }
#inventory-modal .mc-slot.selected { border: 3px solid #FFFF00; background: #a0a0a0; }
#inventory-modal .mc-slot .mc-icon {
  width: ${ICON_SIZE}px; height: ${ICON_SIZE}px;
  image-rendering: pixelated; pointer-events: none; background-repeat: no-repeat;
}
#inventory-modal .mc-slot .mc-item-name {
  position: absolute; top: -2px; left: 0; right: 0;
  color: white; font-size: 10px; text-align: center;
  text-shadow: 1px 1px 0 #000; pointer-events: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
`;

/** 注入背包样式表（幂等：重复构造只注入一次，与 settings-panel 同法） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

export class InventoryPanel {
  /**
   * @param {HTMLElement} root hud 根节点（与设置面板同宿主）
   * @param {import('../core/game.js').Game} game 需具备 pushModal/popModal/uiModal/player/registry
   * @param {Object} opts
   * @param {Object} opts.atlasTiles atlas.json 的 tiles 映射（name → {x,y,w,h}）
   * @param {number} [opts.atlasSize] atlas 边长（默认 2048）
   * @param {(name: string) => string|undefined} [opts.tileOfName] 方块名 → tile 名
   *        （无 faces-data 条目返回 undefined → 该槽无图标，仍可点击选中）
   * @param {string} opts.atlasUrl atlas.png 的 URL
   */
  constructor(root, game, { atlasTiles, atlasSize = 2048, tileOfName = defaultTileOfName, atlasUrl }) {
    this.game = game;
    this.root = root;
    this.atlasTiles = atlasTiles;
    this.atlasSize = atlasSize;
    this.tileOfName = tileOfName;
    this.atlasUrl = atlasUrl;
    ensureStyle();

    // 模态框（display none/flex 切换，isOpen 依赖该口径——与设置面板一致）
    this.el = document.createElement('div');
    this.el.id = 'inventory-modal';
    this.el.style.display = 'none';

    const box = document.createElement('div');
    box.id = 'inventory-content';
    const h2 = document.createElement('h2');
    h2.textContent = '物品清单（点击装备）';
    box.appendChild(h2);
    this.grid = document.createElement('div');
    this.grid.id = 'inventory-grid';
    box.appendChild(this.grid);
    this.el.appendChild(box);
    root.appendChild(this.el);

    // 点击遮罩空白处关闭（mc-lite settingsModal.onclick 同语义；点在内容框/槽位不关）
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });

    // 键盘：Z toggle / Escape 关闭 / 数字键 1-5（仅打开态处理——关态由 Player 负责，
    // 二者不重复：Player 的 keydown 有 uiModal 守卫，打开时被拦截）
    this._onKeyDown = (e) => this._handleKey(e);
    window.addEventListener('keydown', this._onKeyDown);
  }

  /** 打开态判据（display 口径，与设置面板一致） */
  get isOpen() { return this.el.style.display === 'flex'; }

  open() {
    if (this.isOpen) return; // 幂等：重复 open 不叠模态层
    this.el.style.display = 'flex';
    this.game.pushModal(MODAL_OWNER);
    this.game.player?.keys.clear(); // 打开瞬间清空按键，防 WASD 粘滞
    if (document.pointerLockElement) document.exitPointerLock();
    this.render();
  }

  close() {
    if (!this.isOpen) return; // 关态 close 无副作用（不误清他人门控）
    this.el.style.display = 'none';
    this.game.popModal(MODAL_OWNER); // 只移除自己的 owner
    // pointer lock 恢复到 canvas（§4.5.4：mc-lite 锁 body，本仓库必须锁 canvas）。
    // 程序化 requestPointerLock 需用户手势，可能抛 SecurityError（无头环境尤甚）——
    // try/catch 吞掉，失败时回落到既有「点击画面重新锁定」（Player 的 canvas click 入口）。
    // 仅当没有其他模态仍开着时才恢复，否则会与设置面板的锁状态打架。
    const canvas = this.game.player?.canvas;
    if (canvas && !this.game.uiModal) {
      try { canvas.requestPointerLock(); } catch { /* 忽略：等待用户点击 */ }
    }
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** 键盘分发（Z / Escape / 数字键） */
  _handleKey(e) {
    if (e.code === 'KeyZ') { this.toggle(); return; }
    // Escape 仅在打开态响应（mc-lite：`e.code === 'Escape' && this.isOpen`）
    if (e.code === 'Escape') { if (this.isOpen) this.close(); return; }
    if (!this.isOpen) return; // 关态数字键交回 Player（它有 uiModal 守卫，不会双写）
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5)) - 1;
      // 数字键只在快捷栏 5 格内选中（背包面板点击才可越出）
      if (n >= 0 && n < 5) { this.game.player.inventory.selectSlot(n); this.render(); }
    }
  }

  /**
   * 渲染网格：只列**非空槽**（mc-lite 同行为），槽位 `data-index` 是背包真实索引
   * （非渲染序号，跳过空槽后会跳号）。关态早退（mc-lite `render()` 同语义）。
   */
  render() {
    if (!this.isOpen) return;
    const inv = this.game.player?.inventory;
    if (!inv) return;
    this.grid.textContent = '';
    inv.slots.forEach((slot, idx) => {
      if (slot.isEmpty()) return;
      const div = document.createElement('div');
      div.className = 'mc-slot' + (idx === inv.selectedSlot ? ' selected' : '');
      div.dataset.index = String(idx);

      const icon = document.createElement('div');
      icon.className = 'mc-icon';
      // 无 faces-data 的物品（bed_alias_block/mine_cart）无 tile → 留空图标，仍可点击选中
      const tile = this.atlasTiles?.[this.tileOfName(slot.item)];
      if (tile) {
        const st = tileStyle(tile, ICON_SIZE, this.atlasSize);
        icon.style.backgroundImage = `url('${this.atlasUrl}')`;
        icon.style.backgroundSize = st.backgroundSize;
        icon.style.backgroundPosition = st.backgroundPosition;
        icon.style.imageRendering = st.imageRendering;
      }

      const name = document.createElement('div');
      name.className = 'mc-item-name';
      name.textContent = slot.item;
      // 刻意不渲染 count：创造模式无限背包，1500 是占位（§4.5.4 产品决策）

      div.addEventListener('click', () => {
        inv.selectSlot(idx); // 可越出快捷栏 5 格
        this.render();
      });
      div.append(name, icon);
      this.grid.appendChild(div);
    });
  }

  /** 摘除监听与 DOM，并释放模态门控（防跨实例串扰） */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.isOpen) this.game.popModal(MODAL_OWNER);
    this.el.remove();
  }
}
