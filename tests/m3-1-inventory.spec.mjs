// tests/m3-1-inventory.spec.mjs — M3.1 背包（设计文档 §4.5.4，v1.16 定稿）
// 真实游戏内集成验证（单测用的是 Game 替身，此处走完整 Game/Player/UI 装配）：
//   ① 物品模型：背包集合数（关系式）、快捷栏 = slots[0..8] 视图（无第二份物品状态）
//   ② Z 键 toggle + 模态栈 + keydown 守卫（背包开着按 W/数字键无效）
//   ③ 点击第 6 格以外的槽位 → 放块用该方块（世界实际写入 ID 校验）
//   ④ 模态栈不误清设置面板门控（原可写布尔的竞争根因）
//   ⑤ 创造模式不消耗：放块后 count 不变
// 无头环境无 pointer lock，交互经 window.__MC_GAME__ 编程驱动 + 派发真实 KeyboardEvent。
import { test, expect } from 'playwright/test';
import {
  buildItemNames, NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY,
} from '../src/player/inventory.js';
import { buildDefaultRegistry } from '../src/voxel/block-registry.js';

// 固定 seed：放块点位与地形相关，钉 seed 保可复现（M3 起全部性能/视觉 spec 同口径）
const URL = '/?vd=4&seed=12345';

// 物品集合数走**两侧独立计算比对**而非硬编码 118（分级策略 docs/testing-policy.md §3.2）。
//
// **不能用「registry − 排除集合」直接算然后与被测值比**——那会写出代数恒等式
// （`nonEmpty = registry − excluded` 与 `registry = nonEmpty + excluded` 是同一个方程，
// blocks-data 丢方块时两边同时位移、断言静默通过，正是「测试一开始就通过 = 测试写错了」）。
// 正确做法：在 Node 侧用 `buildItemNames()` 独立跑一遍同一份算法，与浏览器侧的真实
// 背包状态比对 —— 两条路径（Node 纯函数 / 浏览器完整装配）算出的集合必须一致。
// 旧版本写死 `toBe(118)`，122→118 变更时要同步改 spec + CLAUDE.md + 设计文档三处。
const EXPECTED_ITEMS = buildItemNames(await buildDefaultRegistry());
const EXPECTED_COUNT = EXPECTED_ITEMS.length;

/** 等待世界就绪 + mesh 管线排空（避免采样混入加载期状态） */
async function boot(page) {
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
}

test('M3.1：物品模型 — 背包集合与 buildItemNames 一致、快捷栏是 slots[0..8] 的视图', async ({ page }) => {
  await boot(page);
  // 排除集合作为参数传入浏览器上下文（page.evaluate 里不能直接访问 Node 侧 import 的标识符）
  const excludedNames = [...NON_PLACEABLE_ITEMS, ...HIDDEN_FROM_INVENTORY];
  const r = await page.evaluate((excluded) => {
    const g = window.__MC_GAME__;
    const inv = g.player.inventory;
    const nonEmpty = inv.slots.filter((s) => !s.isEmpty());
    const items = nonEmpty.map((s) => s.item);
    return {
      slotCount: inv.slots.length,
      nonEmpty: nonEmpty.length,
      items,
      firstCount: inv.slots[0].count,
      selectedSlot: inv.selectedSlot,
      selectedIsAliasOfHotbarIndex: g.player.hotbarIndex === inv.selectedSlot,
      // 快捷栏 DOM 是背包前 HOTBAR_SIZE 格的视图：图标数 = 9（v2.96），前 9 槽物品名
      hotbarCells: document.getElementById('mc-hotbar').children.length,
      front9: inv.slots.slice(0, 9).map((s) => s.item),
      // 排除集合的每一项都不在物品集合内（集合口径由传入常量驱动，勿在此手写清单）
      excluded: excluded.filter((n) => items.includes(n)),
      // mine_cart 保留（mc-lite 背包包含）；bed_alias_block 已移出背包（规避床渲染问题）
      hasBedAlias: items.includes('bed_alias_block'),
      // 2026-11-14：mine_cart 已不在快捷栏（改成 leaves），但必须在背包里（矿车玩法的选槽入口）
      hasMineCart: items.includes('mine_cart'),
      hasMineCartInHotbar: inv.slots.slice(0, 9).some((s) => s.item === 'mine_cart'),
      registryCount: g.registry.all().length,
    };
  }, excludedNames);

  expect(r.slotCount).toBe(1000);
  // **两侧独立计算比对**：Node 侧 buildItemNames() 与浏览器侧真实背包装配必须算出同一集合。
  // 这是真断言而非恒等式——两条路径任一处偏离（如浏览器侧漏了排除逻辑）都会失配。
  expect(r.nonEmpty).toBe(EXPECTED_COUNT);
  expect(r.items).toEqual(EXPECTED_ITEMS); // 顺序也一致（前 9 项冻结 + 其余注册序）
  expect(r.firstCount).toBe(1500);
  expect(r.selectedSlot).toBe(0);
  expect(r.selectedIsAliasOfHotbarIndex).toBe(true);
  expect(r.hotbarCells).toBe(9);
  // 前 9 项冻结（§4.5.4 + v2.96：快捷栏观感固定；纯注册序会让第 6~9 格变成 water/swamp_water/cloud/glass_block）
  // 第 9 项（2026-11-14，用户裁定）：`mine_cart` → `leaves`（矿车仍在背包里，只是不在快捷栏）
  expect(r.front9).toEqual(['stone', 'dirt', 'grass', 'sand', 'cobblestone',
    'wood', 'glass_block', 'tnt', 'leaves']);
  expect(r.excluded).toEqual([]);
  expect(r.hasBedAlias).toBe(false); // bed_alias_block 已移出背包（规避床渲染问题）
  expect(r.hasMineCart).toBe(true); // mine_cart 保留（mc-lite 背包包含，矿车玩法的选槽入口）
  expect(r.hasMineCartInHotbar).toBe(false); // 2026-11-14：第 9 格改成 leaves，矿车不在快捷栏
  // registry 与物品集合的关系：注册表 = 物品集合 + 排除集合（排除项确实是注册过的方块）
  expect(r.registryCount).toBe(r.nonEmpty + excludedNames.length);
});

test('M3.1：Z 键 toggle + 模态栈 + keydown 守卫（背包开着 W 不进 keys、数字键由面板处理不双写）', async ({ page }) => {
  await boot(page);

  // 背包面板 DOM 已装配；z-index 高于设置面板（两模态可共存于栈，后开的在上层）
  expect(await page.evaluate(() => !!document.getElementById('inventory-modal'))).toBe(true);
  expect(await page.evaluate(() => document.getElementById('inventory-modal').style.display)).toBe('none');
  const zBag = await page.evaluate(() => getComputedStyle(document.getElementById('inventory-modal')).zIndex);
  const zSet = await page.evaluate(() => getComputedStyle(document.getElementById('settings-modal')).zIndex);
  expect(Number(zBag)).toBeGreaterThan(Number(zSet));
  expect(await page.evaluate(() => window.__MC_GAME__.uiModal)).toBe(false);

  // Z 键打开（派发真实事件，走 InventoryPanel 的 window keydown）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === true, null, { timeout: 5_000 });
  expect(await page.evaluate(() => document.getElementById('inventory-modal').style.display)).toBe('flex');
  // 渲染槽位数 = 物品集合数（空槽不渲染、data-index 跳号），走 EXPECTED_COUNT 不写死
  expect(await page.evaluate(() => document.querySelectorAll('#inventory-grid .mc-slot').length)).toBe(EXPECTED_COUNT);

  // keydown 守卫：背包开着时按 W 不写入 keys（原漏洞：模态期间新按的键仍会进 keys）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  expect(await page.evaluate(() => window.__MC_GAME__.player.keys.size)).toBe(0);

  // 数字键职责分工（§4.5.4）：开态由背包面板处理（选中第 4 格），Player 的 digit 分支
  // 被 uiModal 守卫拦截 —— 二者不得双写，故 keys 也不应收到 Digit4。
  // 注意：守卫拦的是 Player 自己的分支，不是「数字键无效」；面板仍按自身职责改选中槽。
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit4' })));
  const afterDigit = await page.evaluate(() => ({
    selectedSlot: window.__MC_GAME__.player.inventory.selectedSlot,
    hotbarIndex: window.__MC_GAME__.player.hotbarIndex,
    keys: [...window.__MC_GAME__.player.keys],
    // 高亮已同步到第 4 格（背包面板 render + 快捷栏 update 同读 selectedSlot）
    bagSelectedIdx: document.querySelector('#inventory-grid .mc-slot.selected')?.dataset.index ?? null,
  }));
  expect(afterDigit.selectedSlot).toBe(3);
  expect(afterDigit.hotbarIndex).toBe(3);
  expect(afterDigit.keys).toEqual([]);
  expect(afterDigit.bagSelectedIdx).toBe('3');

  // Escape 关闭
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });
  expect(await page.evaluate(() => document.getElementById('inventory-modal').style.display)).toBe('none');

  // 关闭后守卫解除：数字键恢复由 Player 处理
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3' })));
  expect(await page.evaluate(() => window.__MC_GAME__.player.hotbarIndex)).toBe(2);

  // Z 键可再次打开（toggle 语义）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === true, null, { timeout: 5_000 });
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });
});

test('M3.1：点击第 9 格外的槽位 → 放块用该方块（世界实际写入 ID 校验）', async ({ page }) => {
  await boot(page);

  // 打开背包并点击第 13 个渲染槽（index 12 → selectedSlot 越出快捷栏 9 格）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'flex', null, { timeout: 5_000 });
  const picked = await page.evaluate(() => {
    const slots = document.querySelectorAll('#inventory-grid .mc-slot');
    const target = slots[12];
    const idx = Number(target.dataset.index);
    target.click();
    return { idx, item: window.__MC_GAME__.player.inventory.slots[idx].item };
  });
  expect(picked.idx).toBe(12);
  expect(await page.evaluate(() => window.__MC_GAME__.player.inventory.selectedSlot)).toBe(12);
  // 快捷栏 9 格无高亮（selectedSlot ≥ 9，mc-lite 同行为）。
  // ⚠️ **必须等帧、不能点完立即读**（v2.54 修 flaky）：`selectedSlot` 是点击同步写入的，
  // 但快捷栏高亮由帧循环里的 `hotbar.update()` 刷新（`game.js`，且它 `sel === lastSelected`
  // 时早退）—— 点击那一帧之前 cell 0 仍是白色。单独跑时下一帧赶得上、批量回归负载下
  // 帧间隔变长，同步读会抢在刷新之前（实测 2026-11-05：批量连跑概率性读到白色 → 红）。
  // 改用条件轮询（不是 `waitForTimeout` 硬等）：超时即真失败，语义仍是「无高亮」。
  // v2.96：选中色常量仍是 `#fff`，未选中格是 `#373737`（原版箱子描边）。
  await page.waitForFunction(() => {
    const borders = [...document.getElementById('mc-hotbar').children].map((c) => c.style.borderColor);
    return borders.every((b) => b !== 'rgb(255, 255, 255)' && b !== '#fff');
  }, null, { timeout: 5_000, polling: 100 });
  const hotbarBorders = await page.evaluate(() => [...document.getElementById('mc-hotbar').children]
    .map((c) => c.style.borderColor));
  expect(hotbarBorders.every((b) => b !== 'rgb(255, 255, 255)' && b !== '#fff')).toBe(true);

  // 关闭背包（放块要走真实交互路径，需解除模态）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });

  // 在玩家前方地面放块：经 player.placeBlock()（读 inventory.getSelected()，不再索引常量）
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const { player, world, registry } = g;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let groundY = -1;
    for (let y = 60; y > -32; y--) { if (world.getBlockId(px + 2, y, pz) !== 0) { groundY = y; break; } }
    const targetId = registry.idOf(player.inventory.getSelected().item);
    // 构造射线命中（无 pointer lock，直接给 target）
    player.target = { blockPos: [px + 2, groundY, pz], prevPos: [px + 2, groundY + 1, pz] };
    const before = world.getBlockId(px + 2, groundY + 1, pz);
    const countBefore = player.inventory.getSelected().count;
    player.placeBlock();
    return {
      pickedItem: player.inventory.getSelected().item,
      targetId,
      before,
      after: world.getBlockId(px + 2, groundY + 1, pz),
      countBefore,
      countAfter: player.inventory.getSelected().count,
      editRecorded: world.getColumn(Math.floor((px + 2) / 16), Math.floor(pz / 16)).edits.size > 0,
    };
  });
  expect(r.before).toBe(0);
  expect(r.after).toBe(r.targetId);
  // 放的是背包选中的方块（不是快捷栏第 1 格 stone）
  expect(r.pickedItem).not.toBe('stone');
  expect(r.targetId).not.toBe(await page.evaluate(() => window.__MC_GAME__.registry.idOf('stone')));
  expect(r.editRecorded).toBe(true);
  // 创造模式不消耗
  expect(r.countAfter).toBe(r.countBefore);
  expect(r.countAfter).toBe(1500);
});

test('M3.1：模态栈不误清设置面板门控（原可写布尔的竞争根因）', async ({ page }) => {
  await boot(page);

  // 设置面板打开（点击 ⚙ 按钮走真实事件）
  await page.click('#settings-btn');
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === true, null, { timeout: 5_000 });
  expect(await page.evaluate(() => document.getElementById('settings-modal').style.display)).toBe('flex');

  // 设置面板开着时按 Z 开背包 → 两个模态共存
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'flex', null, { timeout: 5_000 });
  const both = await page.evaluate(() => ({
    uiModal: window.__MC_GAME__.uiModal,
    modals: window.__MC_GAME__._modals.slice(),
  }));
  expect(both.uiModal).toBe(true);
  expect(both.modals).toEqual(['settings', 'inventory']);

  // 关背包：设置面板门控必须保持（这是把 uiModal 从可写布尔改成栈的全部理由）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })));
  await page.waitForFunction(() => document.getElementById('inventory-modal').style.display === 'none', null, { timeout: 5_000 });
  const afterBag = await page.evaluate(() => ({
    uiModal: window.__MC_GAME__.uiModal,
    modals: window.__MC_GAME__._modals.slice(),
    settingsOpen: document.getElementById('settings-modal').style.display,
  }));
  expect(afterBag.uiModal).toBe(true);
  expect(afterBag.modals).toEqual(['settings']);
  expect(afterBag.settingsOpen).toBe('flex');

  // 守卫仍在：设置面板开着按 W 不进 keys
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
  expect(await page.evaluate(() => window.__MC_GAME__.player.keys.size)).toBe(0);

  // 关设置面板 → 门控全清
  await page.click('#settings-close');
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });
  expect(await page.evaluate(() => window.__MC_GAME__._modals.length)).toBe(0);

  // 关态数字键恢复生效
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit5' })));
  expect(await page.evaluate(() => window.__MC_GAME__.player.hotbarIndex)).toBe(4);
});

test('M3.1：uiModal 只读（面板经 push/popModal 改动，直接赋值无效）', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const before = g.uiModal;
    let threw = false;
    try { g.uiModal = true; } catch { threw = true; }
    return { before, threw, after: g.uiModal, modals: g._modals.length };
  });
  expect(r.before).toBe(false);
  // getter-only：赋值静默失败（非严格模式）或抛错，但都不得改动状态
  expect(r.after).toBe(false);
  expect(r.modals).toBe(0);
});

test('M3.1：背包渲染不显示 count（创造模式无限背包）', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() => document.querySelectorAll('#inventory-grid .mc-slot').length > 0, null, { timeout: 5_000 });
  const r = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('#inventory-grid .mc-slot')];
    return {
      countEls: document.querySelectorAll('#inventory-grid .count').length,
      anyShows1500: slots.some((s) => s.textContent.includes('1500')),
      // v1.26：图标走独立的 icons-atlas.png（不再是世界 atlas.png）。
      // 判据必须写精确——`includes('atlas.png')` 对 'icons-atlas.png' 也为真，会掩盖
      // 「图标仍指向世界 atlas」的回退。
      withIcon: slots.filter((s) => s.querySelector('.mc-icon')?.style.backgroundImage.includes('icons-atlas.png')).length,
      total: slots.length,
      // v1.23：图标表补齐 mine_cart（Invicon_Minecart）→ 背包项**全部有图标**。
      // bed_alias_block 已移出背包（cullMode:'none' 不渲染、无法出图标），故背包内无空槽项。
      noIcon: slots.filter((s) => !s.querySelector('.mc-icon')?.style.backgroundImage).map((s) => s.dataset.index),
    };
  });
  expect(r.countEls).toBe(0);
  expect(r.anyShows1500).toBe(false);
  // 计数走 EXPECTED_COUNT，不写死 118
  expect(r.total).toBe(EXPECTED_COUNT);
  // **不变式**（Tier 1 级，不得放宽）：每个渲染槽都必须有图标 → withIcon ≡ total。
  // 写死 `toBe(118)` 只是计数副本；真正要钉的是「无空图标槽」这条不变式。
  expect(r.withIcon).toBe(r.total);
  expect(r.noIcon.length).toBe(0);
});
