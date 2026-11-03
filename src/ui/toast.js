// src/ui/toast.js — M9：轻量非模态提示（规格 §3）
// mc-heavy 此前没有 showMessage/toast 设施（CoordsHUD 只显示坐标）。首个消费者 = 创造台的
// 成功/失败提示（NO_SAFE_LOCATION / PLAYER_IN_PLAYGROUND / EXISTS），后续 Epic 可复用。
//
// ⚠️ **不进 uiModal 模态栈** —— 它不是模态：玩家须在提示期间仍能操作世界。主循环的
// if (!this.uiModal) 会跳过 player.update（§4.5.4），进栈会让玩家在提示期间无法移动 ——
// 那正是「toast 提示结果」变成「toast 锁住玩家」的反效果。故 show() 不调 game.pushModal。
//
// ⚠️ TOAST_CSS 是 JS 模板字面量 —— 本文件注释里禁用反引号包裹标识符（会提前终止模板字符串
// → 整个模块解析失败 → 游戏页白屏）。与 settings-panel.js 的 PANEL_CSS 同一陷阱。
const TOAST_ID = 'mc-toast';
const TOAST_STYLE_ID = 'mc-toast-style';
/**
 * toast 的层级。**必须高于全部模态面板** —— 它是面板里那些动作按钮（创造台 / 进度导入导出 /
 * 瞬移）唯一的反馈通道，而它自己的 z-index 若低于面板遮罩，提示就被盖在遮罩下面：
 * 下载栏在浏览器右侧一闪而过，玩家看到的就是「点了没反应」（用户 2026-10-31 报告导出按钮）。
 *
 * 取值依据 = 当前全局层级表（改任一层级时须重新核对这条不等式）：
 * hotbar 40 < coords-hud 50 < settings-btn 60 < **设置面板 70** < **背包 80** <
 * **toast 90** < 启动错误遮罩 100（后者必须永远在最上：它代表「游戏根本没起来」）。
 * ⚠️ 不要取成 100 或更高：那会把 WebGPU 启动失败遮罩压下去，玩家看不到真正的错误。
 */
export const TOAST_Z_INDEX = 90;
const TOAST_CSS = `
#mc-toast {
  position: fixed; left: 50%; top: 62%; transform: translateX(-50%);
  padding: 8px 16px; background: rgba(0, 0, 0, 0.72); color: #fff;
  font: 14px/1.4 monospace; border: 2px solid #555; pointer-events: none;
  opacity: 0; transition: opacity 0.2s; z-index: ${TOAST_Z_INDEX};
}
#mc-toast.mc-toast-visible { opacity: 1; }
`;

export class Toast {
  /**
   * @param {{container?: HTMLElement|null}} [deps] 缺省挂 document.body。
   *   单测传桩件容器（只需 appendChild）—— toast 不依赖宿主页面的既有节点。
   */
  constructor({ container = null } = {}) {
    this._container = container;
    this._el = null;
    this._styleEl = null;
    this._timer = null;
    this._install();
  }

  /**
   * 幂等注入（与 settings-panel 的 ensureStyle 同手法）：**样式表只注入一次**（按 id 检查），
   * 提示元素若已存在则复用。
   * ⚠️ 必须幂等 —— fixture 页会多次构造 Game（→ 多次构造面板 → 多次 new Toast），
   * 不幂等则产出多个同 id 元素（跨实例串扰，CLAUDE.md 记过背包面板的同类问题）。
   */
  _install() {
    const root = this._container ?? document.body;
    // ⚠️ **幂等判据必须能拿到一个 Document**：`getElementById` 是 `Document` 的方法，
    // **`document.body` 上没有它** —— 旧写法 `typeof root.getElementById !== 'function'`
    // 在生产里（root = body）**恒真** ⇒ 永远走下面的桩件分支、**每次都 append 一个新的
    // `#mc-toast`**，注释里「提示元素若已存在则复用」从未成立。单实例时看不出来
    // （只有一个），第二个 Toast 实例一出现就暴露：`document.getElementById` 返回文档序里
    // **第一个**，而新实例写的是第二个 ⇒ 文案永远读不到（v2.43 Boss 召唤 toast 实测踩到）。
    // 修法：用 `root.ownerDocument ?? root` 取到 Document 再查（body.ownerDocument = document）。
    // 桩件容器（单测的 `{appendChild(){}}`）没有 ownerDocument 也没有 getElementById
    // ⇒ 仍走桩件分支，既有用例逐位不变。
    const doc = root.ownerDocument ?? root;
    if (typeof doc.getElementById !== 'function') {
      const style = document.createElement('style');
      style.textContent = TOAST_CSS;
      root.appendChild(style);
      this._styleEl = style;
      this._el = document.createElement('div');
      this._el.id = TOAST_ID;
      root.appendChild(this._el);
      return;
    }
    if (!doc.getElementById(TOAST_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = TOAST_STYLE_ID;
      style.textContent = TOAST_CSS;
      root.appendChild(style);
      this._styleEl = style;
    }
    this._el = doc.getElementById(TOAST_ID) ?? document.createElement('div');
    if (!this._el.id) {
      this._el.id = TOAST_ID;
      root.appendChild(this._el);
    }
  }

  /**
   * 显示一条提示，durationMs 后自动淡出。
   * ⚠️ **不调 game.pushModal**（见文件头：进模态栈会让玩家在提示期间无法操作世界）。
   * 重复调用会覆盖上一条文案并重置定时器（后一条胜出，不排队）。
   * @param {string} message @param {number} [durationMs=2200]
   */
  show(message, durationMs = 2200) {
    if (!this._el) return;
    this._el.textContent = message;
    this._el.classList.add('mc-toast-visible');
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.hide(), durationMs);
  }

  hide() {
    if (!this._el) return;
    this._el.classList.remove('mc-toast-visible');
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** 只读诊断接口（单测用）。当前文案 —— 断言「提示内容来自单一口径的文案映射」 */
  message() { return this._el?.textContent ?? ''; }
  /** 只读诊断接口（单测用） */
  isVisible() { return !!this._el?.classList.contains('mc-toast-visible'); }
  /**
   * **恒 false** —— toast 不是模态（见文件头理由）。单测据此钉住「不进模态栈」这条不变式。
   * ⚠️ 它不是「读 uiModal 栈」的实现（toast 没有 game 引用），而是**契约声明**：
   * 若有人把 show() 改成调 game.pushModal，须同时把本方法改成 true，届时单测会 FAIL。
   */
  isModal() { return false; }

  /**
   * 释放。⚠️ **只移除自己创建的样式表**（幂等注入下样式表可能由别的实例创建），
   * 提示元素一律移除（它是无状态的，复用与否不影响别的实例）。
   */
  dispose() {
    this.hide();
    this._el?.remove();
    this._styleEl?.remove();
    this._el = null; this._styleEl = null;
  }
}
