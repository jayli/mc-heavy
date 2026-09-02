// src/ui/hotbar.js — 快捷栏（M3-4）：5 格，数字键切换（Player.hotbarIndex 已有逻辑），
// 图标 = atlas.png 按 tile 像素坐标做 CSS background 裁剪（mc-lite Inventory DOM 方案）。
// 方块数据与 player/hotbar-items.js 单一来源（放置语义仍由 Player 消费 hotbarIndex）。
import { HOTBAR_ITEMS } from '../player/hotbar-items.js';

export { HOTBAR_ITEMS };

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
 * 创建快捷栏 DOM（挂到 hudRoot）。selectedIndex 每帧由 update 同步 Player.hotbarIndex。
 * @param {HTMLElement} root
 * @param {Object} opts
 * @param {Array<string>} [opts.items] 方块名列表
 * @param {Object} opts.atlasTiles atlas.json 的 tiles 映射（name → {x,y,w,h}）
 * @param {number} [opts.atlasSize] atlas 边长（atlas.json size，默认 2048）
 * @param {(name: string) => string} opts.tileOfName 方块名 → 图标 tile 名
 *        （FACES_DATA 顶面优先；字符串条目即全方块同 tile）
 * @param {string} opts.atlasUrl atlas.png 的 URL（background-image）
 */
export function createHotbar(root, { items = HOTBAR_ITEMS, atlasTiles, atlasSize = 2048, tileOfName, atlasUrl }) {
  const el = document.createElement('div');
  el.id = 'mc-hotbar';
  el.style.cssText =
    'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:40;' +
    'display:flex;gap:4px;padding:4px;background:rgba(0,0,0,.45);border-radius:6px;' +
    'pointer-events:none;';
  const cells = [];
  for (let i = 0; i < items.length; i++) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'width:44px;height:44px;border:2px solid rgba(255,255,255,.35);border-radius:4px;' +
      'position:relative;background-color:rgba(0,0,0,.25);';
    const icon = document.createElement('div');
    const tileName = tileOfName(items[i]);
    const tile = atlasTiles[tileName];
    if (tile) {
      const st = tileStyle(tile, 40, atlasSize);
      icon.style.cssText =
        `width:40px;height:40px;margin:0;position:absolute;top:0;left:0;` +
        `background-image:url('${atlasUrl}');background-repeat:no-repeat;` +
        `background-size:${st.backgroundSize};background-position:${st.backgroundPosition};` +
        `image-rendering:${st.imageRendering};`;
    }
    const label = document.createElement('span');
    label.textContent = String(i + 1);
    label.style.cssText =
      'position:absolute;right:2px;bottom:0;color:#fff;font:10px/1 monospace;' +
      'text-shadow:0 0 2px #000;';
    cell.appendChild(icon);
    cell.appendChild(label);
    el.appendChild(cell);
    cells.push(cell);
  }
  root.appendChild(el);

  let lastSelected = -1;
  return {
    el,
    /** 每帧调用：选中格高亮同步（DOM 写只在选择变化时发生） */
    update(selectedIndex) {
      if (selectedIndex === lastSelected) return;
      if (cells[lastSelected]) cells[lastSelected].style.borderColor = 'rgba(255,255,255,.35)';
      if (cells[selectedIndex]) cells[selectedIndex].style.borderColor = '#fff';
      lastSelected = selectedIndex;
    },
  };
}
