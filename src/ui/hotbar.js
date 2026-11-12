// src/ui/hotbar.js — 快捷栏（M3-4 建，M3.1 改为背包视图，v1.26 简化图标路径，
// v2.96 扩到 9 格并改原版箱子样式）：
// 格内容 = `inventory.slots[0..HOTBAR_SIZE-1]`（**不是独立容器**，§4.5.4：快捷栏是背包
// 前 N 格的视图），高亮读 inventory.selectedSlot（可 ≥ HOTBAR_SIZE，此时全格无高亮，
// mc-lite 同行为）。
//
// **v1.26：图标改为读预生成的 CSS 串**（`src/ui/icons.js` 的 manifest）。此前是
// 「两级查表（tileOfName）+ 裁剪数学（tileStyle）+ 写 4 个样式属性」，现在是 1 行
// `icon.style.background = css`。裁剪参数（位置/尺寸）由 `tools/bake-icon-atlas.mjs`
// 离线算好，且**按显示尺寸烘焙**（40px）→ 运行时零缩放、像素风锐利。
// 消除的代码：INVENTORY_ICONS 例外表（44 行含注释）、tileOfName 两级查表、
// tileStyle 裁剪数学 —— 实测预生成串与旧路径的 computed style 逐项相等。
//
// **v2.96：视觉改为原版（vanilla）箱子风格（用户 2026-11-12：「这个显示区域的盒子样式
// 参照你理解的原版的样式」）**。纯 CSS，**不新增贴图素材、不跑烘焙**：
//   · 外框 = 2px 纯黑边（原版 hotbar sprite 的外轮廓），面板底色 `#8b8b8b`；
//   · 每格 = `#8b8b8b` 底 + `#373737` 深灰描边 + 左上亮/右下暗的 inset 浮雕斜面
//     （原版槽位的「凹陷」观感，用 box-shadow 两层实现，零图片）；
//   · 选中格 = 原版那圈**白色内描边**（`inset 0 0 0 3px #fff`），
//     同时**仍然写 `borderColor: '#fff'`** —— 既有 E2E（`m3-hud` / `m3-1-inventory`）
//     读的是 `cell.style.borderColor` 这个 DOM 契约，改成只写 box-shadow 会让它们静默失效。
// 旧的圆角 + 半透明黑底 + 半透明白边已全部移除（那套是自拟样式，不是原版）。
import { HOTBAR_ITEMS, HOTBAR_SIZE } from '../player/hotbar-items.js';

export { HOTBAR_ITEMS, HOTBAR_SIZE };

/** 槽位边长（含 2px 边框的**总盒**，图标区 40px + 2×2） */
const CELL_SIZE = 44;
/** 图标边长 —— 必须等于 `tools/bake-icon-atlas.mjs` 的 `SIZES.hotbar`（按显示尺寸烘焙） */
const ICON_SIZE = 40;
/** 未选中格的描边色（原版槽位外框的深灰；也是既有 E2E 读到的「无高亮」值） */
const CELL_BORDER_IDLE = '#373737';
/** 选中格的描边色 */
const CELL_BORDER_SELECTED = '#fff';
/**
 * 原版槽位浮雕：**左侧/顶部亮、右侧/底部暗**（`#fff` / `#373737`）。
 * 方向取自仓库既有的 `ui/inventory.js` 的 `.mc-slot`（`border:2px solid #fff` +
 * `border-right/bottom-color:#373737`）—— 快捷栏必须用同一套方向，
 * 两侧浮雕方向相反会一眼看出不是同一套 GUI。
 */
const CELL_EDGE_LIGHT = '#fff';
const CELL_EDGE_DARK = '#373737';

/** 未选中格的浮雕印影（建 DOM 与切换高亮共用同一串，否则首帧与之后观感不一致） */
const CELL_SHADOW_IDLE =
  `inset 2px 2px 0 ${CELL_EDGE_LIGHT},inset -2px -2px 0 ${CELL_EDGE_DARK}`;
/**
 * 选中格：原版那圈**白色内描边**叠在浮雕斜面之上（`inset` 顺序 = 后者压前者）。
 * 不用 `outline` 是因为它不受盒模型约束，会把相邻格的 2px 间隙盖掉。
 */
const CELL_SHADOW_SELECTED =
  `inset 0 0 0 3px ${CELL_BORDER_SELECTED},inset 2px 2px 0 ${CELL_EDGE_LIGHT},inset -2px -2px 0 ${CELL_EDGE_DARK}`;

/**
 * 创建快捷栏 DOM（挂到 hudRoot）。**背包前 HOTBAR_SIZE 格的视图**，不是独立容器（§4.5.4）：
 * 传 `inventory` 时内容取 `inventory.slots[0..HOTBAR_SIZE-1]`、高亮取 `selectedSlot`；
 * 未传时退回 `items` 常量（兼容纯展示场景与既有单测）。
 *
 * `selectedSlot` 可由背包面板点击设为 ≥ HOTBAR_SIZE，此时**无高亮**（mc-lite 同行为）。
 *
 * @param {HTMLElement} root
 * @param {Object} opts
 * @param {import('../player/inventory.js').Inventory} [opts.inventory] 物品权威（M3.1）
 * @param {Array<string>} [opts.items] 方块名列表（无 inventory 时的退回数据源）
 * @param {Object<string,string>} [opts.icons] 图标 CSS 串表（`loadIconManifest()` 的
 *        `hotbar` 档：方块名 → 完整 background 串）。缺失项 → 该格无图标。
 */
export function createHotbar(root, { inventory = null, items = HOTBAR_ITEMS, icons = null }) {
  const el = document.createElement('div');
  el.id = 'mc-hotbar';
  // 原版箱子：纯黑外框 + #8b8b8b 底 + 直角（旧版是圆角半透明黑底，不是原版观感）
  el.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:40;' +
    'display:flex;gap:2px;padding:2px;background:#8b8b8b;' +
    'border:2px solid #000;border-radius:0;' +
    'pointer-events:none;';
  /**
   * 第 i 格当前应展示的物品名（背包视图下读 `slots[i]`；空槽 → null → 无图标）。
   * 逐格取值而非 `slice().map()`：update() 每帧调用，切片+映射会每帧产生 2 个临时数组
   * （120fps 编辑场景下持续给 GC 施压，实测令 fast-remesh p95 从 1.1ms 涨到 1.3ms）。
   */
  const itemAt = (i) => {
    if (inventory) {
      const s = inventory.slots[i];
      return s && !s.isEmpty() ? s.item : null;
    }
    return items[i] ?? null;
  };

  /** 写入单格图标（v1.26：读预生成的 CSS 串；无条目则留空背景） */
  const paintIcon = (icon, name) => {
    const css = name === null || name === undefined ? undefined : icons?.[name];
    if (!css) { icon.style.background = ''; return; }
    icon.style.background = css;
  };

  const cells = [];
  const iconEls = []; // 图标 DOM 元素（`icons` 是 CSS 串表，二者勿混）
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    const cell = document.createElement('div');
    // 原版槽位：直角 + 深灰描边 + 左上亮/右下暗的 inset 浮雕斜面（零图片）
    cell.style.cssText =
      `width:${CELL_SIZE}px;height:${CELL_SIZE}px;box-sizing:border-box;` +
      `border:2px solid ${CELL_BORDER_IDLE};border-radius:0;` +
      `position:relative;background-color:#8b8b8b;box-shadow:${CELL_SHADOW_IDLE};`;
    const icon = document.createElement('div');
    // 预生成的 background 简写自带 no-repeat，故此处不再单列 background-repeat
    icon.style.cssText =
      `width:${ICON_SIZE}px;height:${ICON_SIZE}px;margin:0;position:absolute;top:0;left:0;`;
    paintIcon(icon, itemAt(i));
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    label.style.cssText =
      'position:absolute;right:2px;bottom:0;color:#fff;font:10px/1 monospace;' +
      'text-shadow:0 0 2px #000;';
    cell.appendChild(icon);
    cell.appendChild(label);
    el.appendChild(cell);
    cells.push(cell);
    iconEls.push(icon);
  }
  root.appendChild(el);

  let lastSelected = -1;
  // 初值必须覆盖全部格（字面量列表在扩格数时会静默漏掉新增格 → 首帧图标不刷新）
  const lastItems = cells.map((_, i) => itemAt(i));

  return {
    el,
    /**
     * 每帧调用：选中格高亮 + 全格内容同步（DOM 写只在变化时发生）。
     * @param {number} [selectedIndex] 缺省读 `inventory.selectedSlot`
     */
    update(selectedIndex) {
      const sel = selectedIndex === undefined && inventory ? inventory.selectedSlot : selectedIndex;
      // 内容同步（M3.1 后背包是唯一权威；创造模式下前置槽恒定，
      // 该分支为后续生存 Epic 的掉落/拾取预留，成本是 N 次逐格字符串比较、零分配）
      for (let i = 0; i < cells.length; i++) {
        const now = itemAt(i);
        if (now !== lastItems[i]) { paintIcon(iconEls[i], now); lastItems[i] = now; }
      }
      // 高亮：selectedSlot ≥ HOTBAR_SIZE 时两分支都落空 → 无高亮（mc-lite 同行为）
      if (sel === lastSelected) return;
      const prev = cells[lastSelected];
      if (prev) {
        prev.style.borderColor = CELL_BORDER_IDLE;
        prev.style.boxShadow = CELL_SHADOW_IDLE;
      }
      const cur = cells[sel];
      if (cur) {
        cur.style.borderColor = CELL_BORDER_SELECTED;
        cur.style.boxShadow = CELL_SHADOW_SELECTED;
      }
      lastSelected = sel;
    },
  };
}
