// src/ui/hotbar.js — 快捷栏（M3-4 建，M3.1 改为背包视图，v1.26 简化图标路径）：
// 5 格内容 = `inventory.slots[0..4]`（**不是独立容器**，§4.5.4：快捷栏是背包前 5 格的视图），
// 高亮读 inventory.selectedSlot（可 > 4，此时 5 格无高亮，mc-lite 同行为）。
//
// **v1.26：图标改为读预生成的 CSS 串**（`src/ui/icons.js` 的 manifest）。此前是
// 「两级查表（tileOfName）+ 裁剪数学（tileStyle）+ 写 4 个样式属性」，现在是 1 行
// `icon.style.background = css`。裁剪参数（位置/尺寸）由 `tools/bake-icon-atlas.mjs`
// 离线算好，且**按显示尺寸烘焙**（40px）→ 运行时零缩放、像素风锐利。
// 消除的代码：INVENTORY_ICONS 例外表（44 行含注释）、tileOfName 两级查表、
// tileStyle 裁剪数学 —— 实测预生成串与旧路径的 computed style 逐项相等。
import { HOTBAR_ITEMS } from '../player/hotbar-items.js';

export { HOTBAR_ITEMS };

/**
 * 创建快捷栏 DOM（挂到 hudRoot）。**背包前 5 格的视图**，不是独立容器（§4.5.4）：
 * 传 `inventory` 时内容取 `inventory.slots[0..4]`、高亮取 `selectedSlot`；
 * 未传时退回 `items` 常量（兼容纯展示场景与既有单测）。
 *
 * `selectedSlot` 可由背包面板点击设为 > 4，此时 5 格**无高亮**（mc-lite 同行为）。
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
  el.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:40;' +
    'display:flex;gap:4px;padding:4px;background:rgba(0,0,0,.45);border-radius:6px;' +
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
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'width:44px;height:44px;border:2px solid rgba(255,255,255,.35);border-radius:4px;' +
      'position:relative;background-color:rgba(0,0,0,.25);';
    const icon = document.createElement('div');
    // 预生成的 background 简写自带 no-repeat，故此处不再单列 background-repeat
    icon.style.cssText = 'width:40px;height:40px;margin:0;position:absolute;top:0;left:0;';
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
  const lastItems = [itemAt(0), itemAt(1), itemAt(2), itemAt(3), itemAt(4)];
  return {
    el,
    /**
     * 每帧调用：选中格高亮 + 5 格内容同步（DOM 写只在变化时发生）。
     * @param {number} [selectedIndex] 缺省读 `inventory.selectedSlot`
     */
    update(selectedIndex) {
      const sel = selectedIndex === undefined && inventory ? inventory.selectedSlot : selectedIndex;
      // 内容同步（M3.1 后背包是唯一权威；创造模式下前 5 槽恒定，
      // 该分支为后续生存 Epic 的掉落/拾取预留，成本是 5 次逐格字符串比较、零分配）
      for (let i = 0; i < 5; i++) {
        const now = itemAt(i);
        if (now !== lastItems[i]) { paintIcon(iconEls[i], now); lastItems[i] = now; }
      }
      // 高亮：selectedSlot > 4 时两分支都落空 → 5 格无高亮（mc-lite 同行为）
      if (sel === lastSelected) return;
      if (cells[lastSelected]) cells[lastSelected].style.borderColor = 'rgba(255,255,255,.35)';
      if (cells[sel]) cells[sel].style.borderColor = '#fff';
      lastSelected = sel;
    },
  };
}
