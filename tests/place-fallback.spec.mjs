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

test('兜底不越过主射线命中（命中时落点仍是 prevPos，不是兜底格）', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  const spot = await buildPillarAndStand(page);
  expect(await selectItem(page, 'stone')).toBeGreaterThanOrEqual(0);

  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    // 正下方俯视会命中脚底方块（prevPos = 玩家所在格）→ 被 AABB 守卫拒绝，不得落到别处
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

  // 前提：正下方俯视确实命中。（命中即走命中路径，兜底不参与）
  expect(r.targetBefore, '俯视脚下须命中方块').not.toBe(null);
  // 命中但被 AABB 守卫拒绝 → 世界零变化（裁决：不回落兜底）
  expect(r.after, '命中路径放不下时须零世界变化（不得偷偷兜底）').toEqual(r.before);
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
