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
const STYLE_ID = 'mc-inventory-style';
/** 模态栈 owner 标识（game.popModal 只移除自己，不误清设置面板的门控） */
const MODAL_OWNER = 'inventory';
/**
 * 槽位图标边长（mc-lite `.slot img` 32×32）。
 * **同时是烘焙尺寸**：`tools/bake-icon-atlas.mjs` 的 `SIZES.inventory = 32` ——
 * 按显示尺寸烘焙 → 运行时零缩放，像素风锐利。改这个值必须同步改烘焙脚本并重跑
 * `npm run icons`（`npm run check:data` 的图标检查会抓过期）。
 */
const ICON_SIZE = 32;

/**
 * hover 浮层的 z-index（v2.17）。
 *
 * 层级表（改任一层级须重核这条不等式，同 `toast.js` 的 `TOAST_Z_INDEX`）：
 * hotbar 40 < coords/perf 50 < settings-btn 60 < 设置面板遮罩 70 < 背包 80
 *   < **tooltip 85** < toast 90 < 启动错误遮罩 100。
 *
 * ⚠️ 浮层挂在 `body` 下、背包与设置面板挂在 `#hud-root` 下，而 `#hud-root` 没有任何
 * CSS（不建层叠上下文）⇒ 三方在**同一个根层叠上下文**里按 z-index 比较。原先取 60（与
 * settings-btn 同档）时它低于设置面板的 70、更低于背包自己的 80 → 被不透明的背包内容框
 * （`#c6c6c6`）整个盖住，只露出面板之外那一小圈（还被遮罩压暗 70%），玩家看到的就是
 * 「浮层跑到面板下面去了」。实测「浮层可见 vs 隐藏」两张同位置裁剪图**逐位相同**（Δ=0）。
 * `toBeVisible()` 抓不到这类缺陷 —— 它只看 CSS display，不看画没画在最上层。
 */
export const TOOLTIP_Z_INDEX = 85;

/** mc-lite global.css 背包相关规则的移植（选择器加 mc- 前缀避免污染宿主页面） */
/**
 * 背包面板的样式表文本。**导出供单测读契约**（浮层的 `pointer-events:none` 是载荷性的，
 * 见 `#inventory-tooltip` 那段注释）—— 让测试构造整个面板去触发 `ensureStyle()` 再读
 * `<style>` 会引入 game 桩件与 body 副作用，读导出常量是等价且更干净的路径。
 */
export const PANEL_CSS = `
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
  /* 52 = 48 内容区 + 2px 边框 × 2 的等价总盒尺寸。border-box 下 width/height 是**总盒**，
     故须显式写 52 才能保持改 border-box 之前的观感不变。
     必须用 border-box：.selected 的边框从 2px 增到 3px，content-box 下总盒 52→54 会把
     grid 该行撑高 2px → 下一行整体下移（点选抖动的根因，实测位移 2px）。border-box 下
     边框往内吃，总盒恒 52 → 零抖动。内容区选中时 48→46，32px 图标两种情况都放得下，
     且中心始终不偏移（边框四边等宽 → flex 居中的内容区始终居中于外框，实测偏移 0/0）。 */
  box-sizing: border-box; width: 52px; height: 52px;
  background: #8b8b8b; border: 2px solid #fff;
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
/* hover 浮层：显示方块**完整**名字（槽位里的 10px 小字被 ellipsis 裁掉，
   长的如 polished_blackstone_bricks 根本看不全）。
   ⚠️ pointer-events:none 是必须的 —— 否则浮层会挡在光标下方拦截 mousemove，
   触发 mouseleave → 隐藏 → 再 mouseenter 的循环闪烁。
   ⚠️ z-index 走 {@link TOOLTIP_Z_INDEX}（85）：必须高于背包自己的 80，否则被盖住。 */
#inventory-tooltip {
  position: fixed; z-index: ${TOOLTIP_Z_INDEX}; pointer-events: none;
  padding: 4px 8px; background: rgba(0, 0, 0, 0.88); color: #fff;
  border: 2px solid #555; font: 13px/1.3 monospace;
  white-space: nowrap; display: none;
}
#inventory-tooltip.mc-visible { display: block; }
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
   * @param {Object<string,string>} [opts.icons] 图标 CSS 串表（`loadIconManifest()` 的
   *        `inventory` 档：方块名 → 完整 background 串）。缺失项 → 该槽无图标（仍可点击选中）。
   */
  constructor(root, game, { icons = null }) {
    this.game = game;
    this.root = root;
    this.icons = icons;
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

    // hover 浮层（**单个共享实例**，不是每个槽位一个 —— 126 个槽各带一个绝对定位浮层
    // 会让 DOM 节点数翻倍。挂在 body 下、position:fixed 跟着光标走）。
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'inventory-tooltip';
    document.body.appendChild(this.tooltip);
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

  /**
   * 显示 hover 浮层（用户 2026-10-29）。文案 = 方块 id **原样**
   * （用户裁定：「方块本来叫什么名字，就显示什么名字，比如 polished_blackstone_bricks」），
   * 不做下划线转空格、不翻译 —— 仓库里没有「显示名」映射表，新增一份就要跟着
   * `blocks-data.js` 维护，是第二个会漂移的权威。
   * @param {string} name @param {MouseEvent} e
   */
  _showTooltip(name, e) {
    if (!this.tooltip) return;
    this.tooltip.textContent = name;
    this.tooltip.classList.add('mc-visible');
    this._moveTooltip(e);
  }

  /**
   * 浮层跟随光标（右下偏移 14/18，避免挡住光标与槽位）。
   * ⚠️ 贴到窗口右/下边缘时翻转方向 —— 否则长名字（26 字符）会超出视口被裁掉。
   * @param {MouseEvent} e
   */
  _moveTooltip(e) {
    if (!this.tooltip || !this.tooltip.classList.contains('mc-visible')) return;
    const pad = 14;
    // 先落位再看尺寸（display:none → block 后才有 offsetWidth）
    this.tooltip.style.left = `${e.clientX + pad}px`;
    this.tooltip.style.top = `${e.clientY + pad}px`;
    const w = this.tooltip.offsetWidth, h = this.tooltip.offsetHeight;
    if (e.clientX + pad + w > window.innerWidth) {
      this.tooltip.style.left = `${Math.max(0, e.clientX - pad - w)}px`;
    }
    if (e.clientY + pad + h > window.innerHeight) {
      this.tooltip.style.top = `${Math.max(0, e.clientY - pad - h)}px`;
    }
  }

  _hideTooltip() {
    this.tooltip?.classList.remove('mc-visible');
  }

  close() {
    if (!this.isOpen) return; // 关态 close 无副作用（不误清他人门控）
    // ⚠️ 必须隐藏浮层：背包关掉后光标还停在那儿，浮层是 position:fixed 挂在 body 上的
    // 单例 → 不隐藏就会留下一个跟着鼠标跑的框。
    this._hideTooltip();
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
      // v1.26：读预生成的 CSS 串（裁剪参数由烘焙脚本离线算好）。无条目的物品留空图标、
      // 仍可点击选中——正常不触发（物品集合全量都有图标，`npm run check:data` 钉死此不变式），
      // 该降级分支仅为「新增方块忘跑 npm run icons」兜底。
      const css = this.icons?.[slot.item];
      if (css) icon.style.background = css;

      const name = document.createElement('div');
      name.className = 'mc-item-name';
      name.textContent = slot.item;
      // 刻意不渲染 count：创造模式无限背包，1500 是占位（§4.5.4 产品决策）

      div.addEventListener('click', () => {
        inv.selectSlot(idx); // 可越出快捷栏 5 格
        this.render();
      });
      // hover 显示完整名字（用户 2026-10-29：「鼠标移动到某个方块上的时候，hover 住的时候
      // 要在鼠标旁边显示 hover 的方块的名字全称」，并裁定「就原样显示方块本来叫什么名字」，
      // 例如 `polished_blackstone_bricks` —— 不做翻译或美化）。
      div.addEventListener('mouseenter', (e) => this._showTooltip(slot.item, e));
      div.addEventListener('mousemove', (e) => this._moveTooltip(e));
      div.addEventListener('mouseleave', () => this._hideTooltip());
      div.append(name, icon);
      this.grid.appendChild(div);
    });
  }

  /** 摘除监听与 DOM，并释放模态门控（防跨实例串扰） */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.isOpen) this.game.popModal(MODAL_OWNER);
    // 浮层挂在 body 下（不在 this.el 里）→ 必须单独摘掉，否则换实例后残留
    this.tooltip?.remove();
    this.tooltip = null;
    this.el.remove();
  }
}
