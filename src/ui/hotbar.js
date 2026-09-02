// src/ui/hotbar.js — 快捷栏（M3-4 建，M3.1 改为背包视图）：
// 5 格内容 = `inventory.slots[0..4]`（**不是独立容器**，§4.5.4：快捷栏是背包前 5 格的视图），
// 图标 = atlas.png 按 tile 像素坐标做 CSS background 裁剪（mc-lite Inventory DOM 方案）。
// M3.1 前 items 来自 player/hotbar-items.js 常量数组；现由 game 传入 slots 派生的物品名，
// 高亮读 inventory.selectedSlot（可 > 4，此时 5 格无高亮，mc-lite 同行为）。
import { HOTBAR_ITEMS } from '../player/hotbar-items.js';
import { FACES_DATA } from '../voxel/faces-data.js';

export { HOTBAR_ITEMS };

/**
 * 方块名 → 图标 tile 名（faces-data 顶/侧面优先）。
 * M3.1 从 game.js 内联提到此处，供快捷栏与背包面板共用（同一份图标口径）。
 * `bed_alias_block`/`mine_cart` 无 faces-data 条目 → 返回 undefined，调用方降级为无图标空槽。
 * @param {string} name 方块名
 * @returns {string|undefined} atlas tile 名
 */
export function tileOfName(name) {
  const f = FACES_DATA[name];
  if (f === undefined) return undefined;
  return Array.isArray(f) ? f[0] : f; // 侧面（index 0）最具辨识度
}

/**
 * atlas tile → CSS background 裁剪样式（纯函数，单测覆盖）。
 * @param {{x:number,y:number,w:number,h:number}} tile atlas.json 的像素矩形
 * @param {number} size 格子图标边长（px）
 * @param {number} atlasSize atlas 边长（px，2048）
 */
export function tileStyle(tile, size, atlasSize) {
  const scaleX = size / tile.w;
  const scaleY = size / tile.h;
  return {
    backgroundSize: `${Math.round(atlasSize * scaleX)}px ${Math.round(atlasSize * scaleY)}px`,
    backgroundPosition: `${-Math.round(tile.x * scaleX)}px ${-Math.round(tile.y * scaleY)}px`,
    imageRendering: 'pixelated', // 像素风放大（与默认 blur=0 口径一致）
  };
}

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
 * @param {Object} opts.atlasTiles atlas.json 的 tiles 映射（name → {x,y,w,h}）
 * @param {number} [opts.atlasSize] atlas 边长（atlas.json size，默认 2048）
 * @param {(name: string) => string|undefined} [opts.tileOfName] 方块名 → 图标 tile 名
 *        （默认用本模块的 tileOfName；无 faces-data 条目返回 undefined → 无图标空格）
 * @param {string} opts.atlasUrl atlas.png 的 URL（background-image）
 */
export function createHotbar(root, { inventory = null, items = HOTBAR_ITEMS, atlasTiles, atlasSize = 2048, tileOfName: tileOf = tileOfName, atlasUrl }) {
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

  /** 写入单格图标（物品名 → atlas tile 裁剪；无 tile 则留空背景） */
  const paintIcon = (icon, name) => {
    const tile = name === null || name === undefined ? undefined : atlasTiles[tileOf(name)];
    if (!tile) { icon.style.backgroundImage = ''; return; }
    const st = tileStyle(tile, 40, atlasSize);
    icon.style.backgroundImage = `url('${atlasUrl}')`;
    icon.style.backgroundSize = st.backgroundSize;
    icon.style.backgroundPosition = st.backgroundPosition;
    icon.style.imageRendering = st.imageRendering;
  };

  const cells = [];
  const icons = [];
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'width:44px;height:44px;border:2px solid rgba(255,255,255,.35);border-radius:4px;' +
      'position:relative;background-color:rgba(0,0,0,.25);';
    const icon = document.createElement('div');
    icon.style.cssText = 'width:40px;height:40px;margin:0;position:absolute;top:0;left:0;background-repeat:no-repeat;';
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
    icons.push(icon);
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
        if (now !== lastItems[i]) { paintIcon(icons[i], now); lastItems[i] = now; }
      }
      // 高亮：selectedSlot > 4 时两分支都落空 → 5 格无高亮（mc-lite 同行为）
      if (sel === lastSelected) return;
      if (cells[lastSelected]) cells[lastSelected].style.borderColor = 'rgba(255,255,255,.35)';
      if (cells[sel]) cells[sel].style.borderColor = '#fff';
      lastSelected = sel;
    },
  };
}
