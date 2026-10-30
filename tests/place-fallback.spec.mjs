// tests/place-fallback.spec.mjs — 准心对着空气时的「贴最近方块面放置」兜底（v1.70）
//
// 场景（用户报告）：玩家站在一块方块上朝下看，只能看到脚底方块的**顶面**，
// 看不到它的水平侧面 —— 想把方块接续放在它东侧时，准心对准那侧的空位，
// 主射线打空（`target === null`）→ 修复前右键**完全无反应**。
//
// ⚠️ 断言必须落在**真实游戏页的世界状态**上，且**不得手工设 `player.target`**
//（既有放置用例大多直接塞 target，那会绕过 `placeBlock()` 的开头分支 ——
// 正是本次改动的落点。M7「只测 API 漏玩家主路径」的同类教训）。
// 本 spec 用 `player.setTestAim()` 摆真实相机姿态 → `player.update()` 自己算 DDA target
// → `player.placeBlock()`（与右键同一代码路径）。
// v2.25（放置就近优先）：落点改为「沿视线从近到远第一个可放的候选，命中面前那格 A 排最后」，
// 命中与打空共用 `_placeNearest()`；头格（相机所在格）永不作候选。本文件因此新增两条
// 「真实页面」用例（就近优先 / 头格出局），原第 2 条用例的标题与注释按新语义改写（场景与断言不变）。
import { test, expect } from 'playwright/test';

const URL = '/?vd=2&seed=12345';

/**
 * 导航 + 等世界真正稳定（判据 = sections 连续两次采样不变 + 全队列归零）。
 * 与 `tests/tnt.spec.mjs` 同款（本仓 tests/ 无共享 helper 模块，各 spec 自带）。
 */
async function boot(page) {
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/**
 * 在高空搭一根 1×1 石柱（顶格 y=blockY），把玩家放上去，并清空四周空气。
 * 返回 `{ bx, bz, blockY, feetY }`。
 * ⚠️ 抬到 y=60 一带而不是就地搭：出生点在山地/森林，四周地形会干扰射线。
 * `pushModal` 冻结玩家更新循环**不行**（`setTestAim` 后需要 `update()` 重算 target），
 * 故改为把柱顶置于高空 + 清空邻域，物理稳定后玩家自然站住。
 */
async function buildPillarAndStand(page, blockY = 59) {
  return page.evaluate(async (topY) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const R = g.registry;
    const px = Math.floor(pl.physics.pos.x);
    const pz = Math.floor(pl.physics.pos.z);
    const air = 0;
    const stone = R.idOf('stone');
    // 清空 ±4 邻域（先挖空，再搭柱）
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let y = topY - 3; y <= topY + 3; y++) {
          g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: air });
        }
      }
    }
    // 1×1 石柱：顶格 = topY-1，玩家脚底落在 topY
    g.editor.setBlock({ x: px, y: topY - 1, z: pz, id: stone });
    pl.physics.pos.x = px + 0.5;
    pl.physics.pos.y = topY;
    pl.physics.pos.z = pz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    // 等两帧让物理稳定（脚底贴住柱顶）
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { bx: px, bz: pz, blockY: topY - 1, feetY: Math.floor(pl.physics.pos.y) };
  }, blockY);
}

/** 选中背包里的某物品（背包是物品权威，快捷栏只是视图） */
async function selectItem(page, item) {
  return page.evaluate((name) => {
    const inv = window.__MC_GAME__.player.inventory;
    const idx = inv.slots.findIndex((s) => s.item === name);
    if (idx >= 0) inv.selectSlot(idx);
    return idx;
  }, item);
}

test('准心对着空气（脚下方块东侧的空位）→ 右键把方块贴到脚底方块东侧', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  const spot = await buildPillarAndStand(page);
  expect(await selectItem(page, 'stone'), 'stone 须在背包里').toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const eye = [s.bx + 0.5, s.feetY + 1.62, s.bz + 0.5];
    // 用户姿态：朝东**偏下**看，对准东侧那格的中心（脚底方块东侧的空位）
    const aim = [s.bx + 1.5, s.blockY + 0.5, s.bz + 0.5];
    pl.setTestAim([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]);
    // 再跑一帧玩家更新，让 update() 用新姿态重算 DDA target
    await new Promise((r) => requestAnimationFrame(r));
    const targetBefore = pl.target ? { B: pl.target.blockPos, P: pl.target.prevPos } : null;
    const eastCell = [s.bx + 1, s.blockY, s.bz];
    const before = g.world.getBlockId(eastCell[0], eastCell[1], eastCell[2]);
    pl.placeBlock();
    const after = g.world.getBlockId(eastCell[0], eastCell[1], eastCell[2]);
    return { eye, aim, targetBefore, eastCell, before, after, stone: g.registry.idOf('stone') };
  }, spot);

  // 前提断言：这个姿态下主射线**确实打空**（否则测的是既有 prevPos 路径，落点就没意义）
  expect(r.targetBefore, '该姿态下 DDA 须未命中（否则用例测不到兜底）').toBe(null);
  expect(r.before, '东侧那格原本是空气').toBe(0);
  expect(r.after, '兜底须把方块放到脚底方块东侧').toBe(r.stone);
});

test('命中但没有更近候选时仍走 A（俯视脚下：A 被身体守卫拒绝 → 世界零变化，不回落到别处）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  const spot = await buildPillarAndStand(page);
  expect(await selectItem(page, 'stone')).toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    // 正下方俯视会命中脚底方块（A = prevPos = 玩家所在格）：沿途没有更近的候选，A 被 AABB 守卫拒绝；
    // A 已是最后一个候选，没有可回落的位置，不得落到别处
    pl.setTestAim([0, -1, 0]);
    await new Promise((r) => requestAnimationFrame(r));
    const targetBefore = pl.target ? { B: pl.target.blockPos, P: pl.target.prevPos } : null;
    const snapshot = () => {
      const out = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = 0; dy <= 1; dy++) {
            out.push(g.world.getBlockId(s.bx + dx, s.blockY + dy, s.bz + dz));
          }
        }
      }
      return out;
    };
    const before = snapshot();
    pl.placeBlock();
    const after = snapshot();
    return { targetBefore, before, after };
  }, spot);

  // 前提：正下方俯视确实命中（A = 玩家所在格）。
  expect(r.targetBefore, '俯视脚下须命中方块').not.toBe(null);
  // A 被 AABB 守卫拒绝 → 世界零变化（v2.25：A 是最后一个候选，没有可回落的位置）
  expect(r.after, '无更近候选且 A 放不下时须零世界变化').toEqual(r.before);
});

test('特殊物品（炮塔）未命中时不走兜底 —— 结构不得落在半空', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  const spot = await buildPillarAndStand(page);
  expect(await selectItem(page, 'turret_alias_block')).toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const eye = [s.bx + 0.5, s.feetY + 1.62, s.bz + 0.5];
    const aim = [s.bx + 1.5, s.blockY + 0.5, s.bz + 0.5];
    pl.setTestAim([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]);
    await new Promise((r) => requestAnimationFrame(r));
    const targetBefore = pl.target ? pl.target.blockPos : null;
    const before = g.turrets.count ? g.turrets.count() : null;
    pl.placeBlock();
    const after = g.turrets.count ? g.turrets.count() : null;
    return { targetBefore, before, after };
  }, spot);

  expect(r.targetBefore, '前提：该姿态须未命中').toBe(null);
  expect(r.after, '未命中时炮塔不得被兜底放下（origin 语义依赖命中格）').toBe(r.before);
});

/**
 * 搭「视线走廊」：高空清出 x∈[px-2,px+14] × z∈[pz-2,pz+2] × y∈[topY-3,topY+4]，玩家站 1×1 石柱
 * （脚底 y=topY），再按 extra（相对 [px, topY, pz] 的偏移）摆石块。头格 = (px, topY+1, pz)。
 * ⚠️ 与 buildPillarAndStand 同理抬到 y=60 一带，避开出生点地形对射线的干扰。
 */
async function buildRayCorridor(page, extra, topY = 60) {
  return page.evaluate(async ({ topY, extra }) => {
    const g = window.__MC_GAME__, pl = g.player, stone = g.registry.idOf('stone');
    const px = Math.floor(pl.physics.pos.x), pz = Math.floor(pl.physics.pos.z);
    for (let dx = -2; dx <= 14; dx++) for (let dz = -2; dz <= 2; dz++)
      for (let y = topY - 3; y <= topY + 4; y++) g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: 0 });
    g.editor.setBlock({ x: px, y: topY - 1, z: pz, id: stone });
    for (const [dx, dy, dz] of extra) g.editor.setBlock({ x: px + dx, y: topY + dy, z: pz + dz, id: stone });
    pl.physics.pos.x = px + 0.5; pl.physics.pos.y = topY; pl.physics.pos.z = pz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { px, pz, headY: topY + 1 };
  }, { topY, extra });
}

test('就近优先：命中远处方块，但视线擦过更近的可贴格 → 放在近处（真实页面）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  // 侧墙 (px+3, 头格高, pz-1)：视线擦过；远处被命中的方块 (px+12, 头格高, pz)
  const s = await buildRayCorridor(page, [[3, 1, -1], [12, 1, 0]]);
  expect(await selectItem(page, 'stone'), 'stone 须在背包里').toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    pl.setTestAim([1, 0, 0]);                              // 朝 +X 平视
    await new Promise((r) => requestAnimationFrame(r));    // 让 update() 用新姿态重算 DDA target
    const at = (dx) => g.world.getBlockId(s.px + dx, s.headY, s.pz);
    const target = pl.target ? { B: pl.target.blockPos, P: pl.target.prevPos } : null;
    const before = { near: at(3), far: at(11) };
    pl.placeBlock();
    return { target, before, after: { near: at(3), far: at(11) }, stone: g.registry.idOf('stone') };
  }, s);

  expect(r.target?.B, '前提：主射线命中远处方块').toEqual([s.px + 12, s.headY, s.pz]);
  expect(r.before, '放前两格都是空气').toEqual({ near: 0, far: 0 });
  expect(r.after.near, '落在贴侧墙的最近格').toBe(r.stone);
  expect(r.after.far, '命中面前一格（A）不放').toBe(0);
});

test('头格出局：背靠墙面朝外瞄远处，手持花草落在命中面前、不进头格（真实页面）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  // 墙紧贴头格的 -X 侧；远处被命中的方块 (px+12, 头格高, pz)
  const s = await buildRayCorridor(page, [[-1, 1, 0], [12, 1, 0]]);
  expect(await selectItem(page, 'short_grass'), 'short_grass 须在背包里').toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    pl.setTestAim([1, 0, 0]);
    await new Promise((r) => requestAnimationFrame(r));
    const at = (dx) => g.world.getBlockId(s.px + dx, s.headY, s.pz);
    const target = pl.target ? { B: pl.target.blockPos } : null;
    pl.placeBlock();
    return { target, head: at(0), far: at(11), grass: g.registry.idOf('short_grass') };
  }, s);

  expect(r.target?.B, '前提：主射线命中远处方块').toEqual([s.px + 12, s.headY, s.pz]);
  expect(r.head, '头格不得被放进花草（头格出局）').toBe(0);
  expect(r.far, '花草落在命中面前').toBe(r.grass);
});
