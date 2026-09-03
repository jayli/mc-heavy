// src/tests/test-inventory-ui.js — M3.1 背包面板 UI（设计文档 §4.5.4）
// 覆盖：DOM 结构与 mc-lite 样式口径、Z toggle / Escape 关闭 / 数字键 / 点击选中、
// 模态栈（不误清他人门控）、count 不渲染、空槽不渲染、无 tile 物品降级、样式表幂等注入。
//
// 组件生命周期：每个测试必须 dispose()（面板在 window 上挂 keydown 监听，
// 不清理会跨测试串扰——一个实例会响应另一个实例的按键）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNull } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createCreativeInventory } from '../player/inventory.js';
import { InventoryPanel } from '../ui/inventory.js';
import { tileOfName } from '../ui/hotbar.js';

/** 最小 Game 替身：模态栈语义与真实 Game 一致（真实实例的验证在 Playwright spec） */
function makeGame() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const modals = [];
  const player = {
    keys: new Set(),
    canvas: null, // 无 DOM canvas：实现须判空跳过 requestPointerLock
    inventory: createCreativeInventory(reg),
  };
  Object.defineProperty(player, 'hotbarIndex', {
    get() { return this.inventory.selectedSlot; },
    set(n) { this.inventory.selectSlot(n); },
  });
  return {
    _modals: modals,
    get uiModal() { return modals.length > 0; },
    pushModal(o) { if (!modals.includes(o)) modals.push(o); },
    popModal(o) { const i = modals.indexOf(o); if (i >= 0) modals.splice(i, 1); },
    player,
    registry: reg,
  };
}

/** 真实 atlas 元数据（测试页同源，fetch 一次后复用） */
let atlasMeta = null;
async function loadAtlas() {
  if (!atlasMeta) atlasMeta = await (await fetch('/assets/atlas.json')).json();
  return atlasMeta;
}

/** 构造面板 + 统一清理的包装（保证 keydown 监听不泄漏到其他测试） */
async function withPanel(fn) {
  const game = makeGame();
  const atlas = await loadAtlas();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const panel = new InventoryPanel(host, game, {
    atlasTiles: atlas.tiles,
    atlasSize: atlas.size,
    tileOfName,
    atlasUrl: '/assets/atlas.png',
  });
  try {
    return await fn(panel, game, host);
  } finally {
    panel.dispose();
    host.remove();
  }
}

/** 派发 window keydown（面板监听在 window 上） */
function press(code) {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}

// --- DOM 结构与样式口径（照搬 mc-lite global.css / index.html） ---

test('背包 DOM：构造后 modal 隐藏、内容框/网格/标题齐备', async () => {
  await withPanel((panel) => {
    const modal = document.getElementById('inventory-modal');
    assertEqual(modal.style.display, 'none', '构造后隐藏');
    assertEqual(panel.el, modal);
    assertFalse(panel.isOpen);
    assertTrue(!!document.getElementById('inventory-content'), '内容框存在');
    assertTrue(!!document.getElementById('inventory-grid'), '网格存在');
    assertEqual(document.querySelector('#inventory-content h2').textContent,
      '物品清单（点击装备）');
  });
});

test('背包 DOM：样式表注入幂等（两次构造只注入一次）', async () => {
  await withPanel(async () => {
    const first = document.querySelectorAll('#mc-inventory-style').length;
    const game = makeGame();
    const atlas = await loadAtlas();
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const p2 = new InventoryPanel(host2, game, {
      atlasTiles: atlas.tiles, atlasSize: atlas.size, tileOfName, atlasUrl: '/assets/atlas.png',
    });
    try {
      assertEqual(document.querySelectorAll('#mc-inventory-style').length, first,
        '重复构造不再注入');
      assertEqual(first, 1);
    } finally {
      p2.dispose();
      host2.remove();
    }
  });
});

test('背包 DOM：注入样式给出 mc-lite 口径（600×400 内容框 + 8 列网格）', async () => {
  await withPanel((panel) => {
    panel.open(); // 样式在显示态才可测量
    const content = document.getElementById('inventory-content');
    const cs = getComputedStyle(content);
    assertEqual(cs.width, '600px', 'mc-lite #inventory-content 宽 600');
    assertEqual(cs.height, '400px', 'mc-lite #inventory-content 高 400');
    assertEqual(cs.borderTopWidth, '4px', '4px 深灰边');
    assertEqual(cs.borderTopColor, 'rgb(85, 85, 85)', 'mc-lite #555 深灰边');
    // mc-lite 硬黑投影 `5px 5px 0 #000`。Chromium 的 computed 规范化格式是
    // `rgb(0, 0, 0) 5px 5px 0px 0px`（颜色前置、blur/spread 补全），
    // 故按分量断言而非整串比对，避免依赖规范化格式。
    assertTrue(cs.boxShadow.includes('5px 5px 0px'), `投影偏移 5px 5px 0：${cs.boxShadow}`);
    assertTrue(cs.boxShadow.includes('rgb(0, 0, 0)'), `投影为纯黑：${cs.boxShadow}`);
    const grid = document.getElementById('inventory-grid');
    assertEqual(getComputedStyle(grid).gridTemplateColumns.split(' ').length, 8, '8 列');
    assertEqual(getComputedStyle(grid).overflowY, 'auto', '可滚动');
  });
});

// --- open / close / toggle 与模态栈 ---

test('背包 open：显示 + pushModal + 清空按键', async () => {
  await withPanel((panel, game) => {
    game.player.keys.add('KeyW');
    game.player.keys.add('Space');
    assertFalse(game.uiModal);
    panel.open();
    assertTrue(panel.isOpen);
    assertEqual(document.getElementById('inventory-modal').style.display, 'flex');
    assertTrue(game.uiModal, 'pushModal 后 uiModal=true');
    assertEqual(game._modals.length, 1);
    assertEqual(game._modals[0], 'inventory');
    assertEqual(game.player.keys.size, 0, '打开瞬间清空按键防 WASD 粘滞');
  });
});

test('背包 open：渲染 118 个非空槽且首槽选中', async () => {
  await withPanel((panel) => {
    panel.open();
    const slots = document.querySelectorAll('#inventory-grid .mc-slot');
    assertEqual(slots.length, 118, '物品集合全量入包 = 118 槽（chimney + 3 个床方块不入包）');
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot.selected').length, 1);
    assertTrue(slots[0].classList.contains('selected'), 'selectedSlot=0 高亮首槽');
    assertEqual(slots[0].dataset.index, '0');
    assertEqual(slots[0].querySelector('.mc-item-name').textContent, 'stone');
  });
});

test('背包 close：隐藏 + popModal', async () => {
  await withPanel((panel, game) => {
    panel.open();
    panel.close();
    assertFalse(panel.isOpen);
    assertEqual(document.getElementById('inventory-modal').style.display, 'none');
    assertFalse(game.uiModal);
    assertEqual(game._modals.length, 0);
  });
});

test('模态栈：关背包不误清设置面板的门控（原可写布尔的竞争根因）', async () => {
  await withPanel((panel, game) => {
    game.pushModal('settings'); // 设置面板已开
    assertTrue(game.uiModal);
    panel.open();
    assertEqual(game._modals.length, 2, '两个面板共存');
    assertTrue(game.uiModal);
    panel.close();
    assertTrue(game.uiModal, '设置面板仍在，门控不得被清');
    assertEqual(game._modals.length, 1);
    assertEqual(game._modals[0], 'settings');
    game.popModal('settings');
    assertFalse(game.uiModal);
  });
});

test('模态栈：open 幂等（同一面板重复 open 不叠层）', async () => {
  await withPanel((panel, game) => {
    panel.open();
    panel.open();
    panel.open();
    assertEqual(game._modals.length, 1);
    assertTrue(panel.isOpen);
  });
});

// --- 键盘：Z toggle / Escape / 数字键 ---

test('键盘 Z：关态按下打开、开态按下关闭（toggle）', async () => {
  await withPanel((panel, game) => {
    press('KeyZ');
    assertTrue(panel.isOpen, 'Z 打开背包');
    assertTrue(game.uiModal);
    press('KeyZ');
    assertFalse(panel.isOpen, 'Z 再按关闭');
    assertFalse(game.uiModal);
  });
});

test('键盘 Escape：仅打开态关闭，关态无副作用', async () => {
  await withPanel((panel, game) => {
    press('Escape');
    assertFalse(panel.isOpen, '关态按 Escape 不应打开');
    assertFalse(game.uiModal);
    panel.open();
    press('Escape');
    assertFalse(panel.isOpen, '开态按 Escape 关闭');
    assertFalse(game.uiModal);
  });
});

test('键盘 Escape：背包关着时不误清设置面板门控', async () => {
  await withPanel((panel, game) => {
    game.pushModal('settings');
    press('Escape'); // 背包未开，Escape 不应动到 settings
    assertFalse(panel.isOpen);
    assertTrue(game.uiModal, '设置面板门控保持');
    assertEqual(game._modals.length, 1);
  });
});

test('键盘数字 1-5：仅打开态改选中槽（关态由 Player 负责）', async () => {
  await withPanel((panel, game) => {
    press('Digit3');
    assertEqual(game.player.inventory.selectedSlot, 0, '关态面板不处理数字键');
    panel.open();
    press('Digit3');
    assertEqual(game.player.inventory.selectedSlot, 2);
    assertEqual(game.player.hotbarIndex, 2, '别名同源');
    press('Digit5');
    assertEqual(game.player.inventory.selectedSlot, 4);
    press('Digit1');
    assertEqual(game.player.inventory.selectedSlot, 0);
    // 数字键改选中后高亮同步
    const slots = document.querySelectorAll('#inventory-grid .mc-slot');
    assertTrue(slots[0].classList.contains('selected'));
    assertFalse(slots[4].classList.contains('selected'));
  });
});

test('键盘：dispose 后不再响应（监听器已摘除）', async () => {
  const game = makeGame();
  const atlas = await loadAtlas();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const panel = new InventoryPanel(host, game, {
    atlasTiles: atlas.tiles, atlasSize: atlas.size, tileOfName, atlasUrl: '/assets/atlas.png',
  });
  panel.dispose();
  host.remove();
  press('KeyZ');
  assertFalse(game.uiModal, 'dispose 后 Z 不应打开任何面板');
  assertEqual(document.getElementById('inventory-modal'), null, 'DOM 已移除');
});

// --- 点击槽位选中（selectedSlot 可越出快捷栏 5 格） ---

test('点击槽位：改 selectedSlot 并移动高亮（含第 6 格以外）', async () => {
  await withPanel((panel, game) => {
    panel.open();
    const slots = () => document.querySelectorAll('#inventory-grid .mc-slot');
    slots()[7].click();
    assertEqual(game.player.inventory.selectedSlot, 7, '可越出 5 格');
    assertEqual(game.player.hotbarIndex, 7);
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot.selected').length, 1);
    assertTrue(slots()[7].classList.contains('selected'));
    assertFalse(slots()[0].classList.contains('selected'));
    assertEqual(game.player.inventory.getSelected().item,
      game.player.inventory.slots[7].item);
  });
});

test('点击遮罩空白处关闭（mc-lite settingsModal.onclick 同语义）', async () => {
  await withPanel((panel, game) => {
    panel.open();
    const modal = document.getElementById('inventory-modal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assertFalse(panel.isOpen, '点在遮罩自身 → 关闭');
    assertFalse(game.uiModal);
  });
});

test('点击内容框内部不关闭（事件目标是子元素时忽略）', async () => {
  await withPanel((panel) => {
    panel.open();
    const content = document.getElementById('inventory-content');
    content.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assertTrue(panel.isOpen, '点在内容框 → 保持打开');
  });
});

// --- 渲染细节 ---

test('渲染：不显示 count（创造模式无限背包，§4.5.4 产品决策）', async () => {
  await withPanel((panel, game) => {
    panel.open();
    assertEqual(document.querySelectorAll('#inventory-grid .count').length, 0, '无 count 元素');
    const slot0 = document.querySelectorAll('#inventory-grid .mc-slot')[0];
    assertFalse(slot0.textContent.includes('1500'), '槽位文本不含数量');
    assertEqual(game.player.inventory.slots[0].count, 1500, '数据层 count 仍在');
  });
});

test('渲染：图标走 atlas tile CSS background 裁剪（同快捷栏 tileStyle）', async () => {
  await withPanel((panel) => {
    panel.open();
    const icon = document.querySelector('#inventory-grid .mc-slot .mc-icon');
    assertTrue(!!icon, '图标元素存在');
    assertTrue(icon.style.backgroundImage.includes('atlas.png'), 'background-image = atlas');
    assertTrue(/^\d+px \d+px$/.test(icon.style.backgroundSize), 'background-size 已算出');
    assertEqual(icon.style.imageRendering, 'pixelated', '像素风放大（blur=0 口径）');
  });
});

test('渲染：mine_cart 走图标表（Invicon_Minecart），不再是空槽', async () => {
  await withPanel((panel, game) => {
    panel.open();
    const names = [...document.querySelectorAll('#inventory-grid .mc-item-name')]
      .map((el) => el.textContent);
    // bed_alias_block 已移出背包（规避床渲染问题），它是唯一真正无图标的物品
    assertFalse(names.includes('bed_alias_block'), 'bed_alias_block 不在背包');
    assertTrue(names.includes('mine_cart'));
    const idx = names.indexOf('mine_cart');
    const slot = document.querySelectorAll('#inventory-grid .mc-slot')[idx];
    assertEqual(slot.dataset.index, String(idx));
    const icon = slot.querySelector('.mc-icon');
    // v1.23：mine_cart 无 faces-data 条目，但图标表给了 Invicon_Minecart → 有图标
    assertTrue(icon.style.backgroundImage.includes('atlas.png'), '有 background-image');
    assertTrue(/^\d+px \d+px$/.test(icon.style.backgroundSize), 'background-size 已算出');
    // 仍可点击选中（玩法可用性保留）
    slot.click();
    assertEqual(game.player.inventory.selectedSlot, idx);
  });
});

/** 台阶图标在背包 DOM 里必须与母方块图标不同 tile（端到端确认裁剪参数不同） */
/**
 * 端到端：异形方块槽位的图标裁剪参数与「会撞脸的那个方块」不同。
 * v1.24 起异形方块走等轴测图标 tile（`inventory-icons/*`），故与母方块/世界贴图的
 * 裁剪位置必然不同。比对 `backgroundPosition` 而非 tile 名——tile 更名不影响本判据
 * （语义是「渲染出的图标不是同一张」）。
 *
 * 覆盖 9 项异形方块：台阶 4 项 vs 母方块、栏杆 3 项 vs 彼此（世界贴图几乎相同 →
 * 撞脸）、柱子 2 项 vs 彼此。
 */
test('渲染：异形方块槽位图标裁剪参数互不相同（9 项等轴测图标）', async () => {
  await withPanel((panel) => {
    panel.open();
    const names = [...document.querySelectorAll('#inventory-grid .mc-item-name')]
      .map((el) => el.textContent);
    const bgOf = (blockName) => {
      const idx = names.indexOf(blockName);
      assertTrue(idx >= 0, `${blockName} 在背包内`);
      const icon = document.querySelectorAll('#inventory-grid .mc-slot')[idx].querySelector('.mc-icon');
      return icon.style.backgroundPosition;
    };
    // 台阶 vs 母方块
    assertTrue(bgOf('planks_step') !== bgOf('planks'),
      'planks_step 裁剪位置不同于 planks');
    assertTrue(bgOf('cobblestone_step') !== bgOf('cobblestone'),
      'cobblestone_step 裁剪位置不同于 cobblestone');
    assertTrue(bgOf('cobblestone_step_updown') !== bgOf('cobblestone'),
      'cobblestone_step_updown 裁剪位置不同于 cobblestone');
    assertTrue(bgOf('stone_diorite_step') !== bgOf('stone_diorite'),
      'stone_diorite_step 裁剪位置不同于 stone_diorite');
    // 正置/倒置台阶彼此不同（几何形状相反）
    assertTrue(bgOf('cobblestone_step_updown') !== bgOf('cobblestone_step'),
      '正置/倒置台阶图标不同');
    // 竖柱 vs 横梁（几何形状相反；世界贴图 pillar/pillar_horizontal 噪点分布差异极小）
    assertTrue(bgOf('vertical_pillar') !== bgOf('horizontal_pillar'),
      '竖柱/横梁图标不同');
    // 栏杆 3 项彼此不同（世界贴图 procedural/handrail{,A,B} 均仅 2 种颜色 → 此前撞脸）
    const rails = [bgOf('handrail'), bgOf('handrailA'), bgOf('handrailB')];
    assertEqual(new Set(rails).size, 3, '栏杆 3 项图标互不相同');
  });
});

test('渲染：空槽不列出（只渲染非空槽，mc-lite 同行为）', async () => {
  await withPanel((panel, game) => {
    panel.open();
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot').length, 118);
    game.player.inventory.slots[117].clear(); // 清空末槽（118 项 → 下标 117）
    game.player.inventory.slots[5].clear();
    panel.render();
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot').length, 116);
    const idxs = [...document.querySelectorAll('#inventory-grid .mc-slot')]
      .map((el) => Number(el.dataset.index));
    assertFalse(idxs.includes(117), '空槽不在列');
    assertFalse(idxs.includes(5));
    assertEqual(idxs[0], 0, 'data-index 仍是背包真实槽索引（非渲染序号）');
    assertEqual(idxs[5], 6, '跳过空槽后索引连续但值跳号');
  });
});

test('渲染：selectedSlot 指向空槽时无高亮', async () => {
  await withPanel((panel, game) => {
    panel.open();
    game.player.inventory.selectSlot(9);
    game.player.inventory.slots[9].clear();
    panel.render();
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot.selected').length, 0,
      '选中槽为空 → 不渲染该槽 → 无高亮');
  });
});

test('渲染：点击后面板重渲染不重复注入样式表', async () => {
  await withPanel((panel) => {
    panel.open();
    const before = document.querySelectorAll('#mc-inventory-style').length;
    document.querySelectorAll('#inventory-grid .mc-slot')[3].click();
    document.querySelectorAll('#inventory-grid .mc-slot')[10].click();
    assertEqual(document.querySelectorAll('#mc-inventory-style').length, before);
    assertTrue(panel.isOpen);
  });
});

test('渲染：未打开时 render 不写 DOM（mc-lite Inventory.render 早退语义）', async () => {
  await withPanel((panel) => {
    panel.render();
    assertEqual(document.querySelectorAll('#inventory-grid .mc-slot').length, 0,
      '关态 render 不应填充网格');
    assertNull(document.getElementById('inventory-grid').firstChild);
  });
});

// --- dispose ---

test('dispose：移除 DOM 与监听（不泄漏到其他面板）', async () => {
  const game = makeGame();
  const atlas = await loadAtlas();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const panel = new InventoryPanel(host, game, {
    atlasTiles: atlas.tiles, atlasSize: atlas.size, tileOfName, atlasUrl: '/assets/atlas.png',
  });
  panel.open();
  assertTrue(game.uiModal);
  panel.dispose();
  host.remove();
  assertNull(document.getElementById('inventory-modal'), 'modal DOM 已移除');
  assertFalse(game.uiModal, 'dispose 同时释放模态门控');
  press('KeyZ');
  assertNull(document.getElementById('inventory-modal'), 'Z 不再创建面板');
});
