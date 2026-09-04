import { test, expect } from 'playwright/test';

// 「删除缓存」验收（设置面板）：只清玩家改动（edits），保留 seed 与设置。
// 与 newWorld 的区别：newWorld 会换 seed，本功能**不换**——重载后地形必须回到
// 未修改的原始版本（同 seed 确定性，红线 2），且 localStorage 设置原样保留。
//
// 关键竞态（Tier 1）：清 edits 后重载时，beforeunload → flushNow(world) 会把
// world.columns 里各 column 的内存 edits 写回刚清空的 store。若 clearSave 只清
// IndexedDB 不清内存，用户「点了没生效」——静默失败，肉眼看不出来（重启才暴露）。
// 故本 spec 用「重载后 savedColumns 仍为 0」钉住这条路径，而非只查点击当时的值。
//
// ⚠ 地形指纹必须**全量求和**，不能用 m3-hud/persistence spec 的 `i += 997` 步长采样：
// 那边是「换 seed」场景（整片地形全变，采样和必然变）。本 spec 只改**一个格子**，
// 除非该格恰好落在采样点上，否则采样和不变（实测踩坑：基线与改动侧同为 50533）。

const READY = () => window.__MC_GAME__?.worldReady === true;

/** 等世界稳定：sections 连续两次采样不变 + 三条队列归零（勿只看队列瞬时归零） */
const STABLE = () => {
  const g = window.__MC_GAME__;
  const s = g.scheduler.stats();
  const sections = g.renderStats().sections;
  const prev = window.__MC_STABLE_PREV__;
  window.__MC_STABLE_PREV__ = sections;
  return prev === sections &&
    s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
};

/** 地形指纹 + column 数（column 数用于确认前后世界状态对等，指纹才可比） */
const FINGERPRINT = () => {
  let sum = 0;
  for (const [, col] of window.__MC_GAME__.world.columns) {
    for (let i = 0; i < col.blocks.length; i++) sum += col.blocks[i];
  }
  return { fp: sum, columns: window.__MC_GAME__.world.columns.size };
};

test('删除缓存：清 edits 但保留 seed 与设置，重载后回到未修改的原始世界', async ({ page }) => {
  test.setTimeout(240_000);
  // 1. 固定 seed 入口 + 记录「未修改」基线指纹
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  const pristine = await page.evaluate(FINGERPRINT);

  // 2. 改设置（音量 50%）——删除缓存不得动 localStorage
  await page.locator('#settings-btn').click();
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-modal button')];
    btns.find((b) => b.textContent === '50%').click();
  });
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').volume === 0.5,
  null, { timeout: 5_000 });

  // 3. 放一块石头留下 edits 并落库
  const placed = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) + 2;
    const pz = Math.floor(g.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const r = g.world.setBlock(px, groundY + 1, pz, g.registry.idOf('stone'));
    g.scheduler.remeshSections(r.affected, { fastPath: true });
    await g.persistence.flushNow(g.world);
    return { x: px, y: groundY + 1, z: pz,
      savedColumns: await g.persistence.countSavedColumns() };
  });
  expect(placed.savedColumns).toBeGreaterThan(0); // edits 确已落库

  // 4. 重载验证修改生效（对照组：证明第 6 步的「回到原始」不是「根本没存上」）
  await page.reload();
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  const dirty = await page.evaluate(FINGERPRINT);
  const dirtyStone = await page.evaluate((p) =>
    window.__MC_GAME__.world.getBlockId(p.x, p.y, p.z), placed);
  expect(dirty.columns).toBe(pristine.columns);      // 前后 column 数对等，指纹才可比
  expect(dirty.fp).not.toBe(pristine.fp);            // 改动确实改了地形
  expect(dirtyStone).not.toBe(0);

  // 5. 面板里点「删除缓存」→ 二次确认 → 重载
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  const clearBtn = page.locator('#btn-clear-save');
  await expect(clearBtn).toBeVisible();
  await clearBtn.click();                            // 第一次：进入确认态，不得立即执行
  await expect(clearBtn).toHaveText(/确认/);
  expect(await page.evaluate(() => window.__MC_GAME__.seed)).toBe(12345); // 尚未重载
  // ⚠ 导航监听必须在 click **之前**武装。`waitForLoadState('load')` 写在 click 之后会踩竞态：
  // 若导航尚未开始，它看到「当前页已是 load 态」立即返回，随后 READY 在**旧页**上本就为真
  // → 全部等待瞬间通过 → 读到的是 clear 之前的世界（内存石头还在、IndexedDB 已清空），
  // 表现为 savedColumns=0/seed 不变都通过、只有 fp 多出一个 stoneId（实测差值恰为 48）。
  const nav = page.waitForNavigation({ waitUntil: 'load' });
  await clearBtn.click();                            // 第二次：执行 + 重载
  await nav;
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 6. 断言：edits 清空（竞态核心）、seed 不变、地形回到原始、设置保留
  const cleared = await page.evaluate(FINGERPRINT);
  const clearedDetail = await page.evaluate(async (p) => ({
    stone: window.__MC_GAME__.world.getBlockId(p.x, p.y, p.z),
    seed: window.__MC_GAME__.seed,
    savedColumns: await window.__MC_GAME__.persistence.countSavedColumns(),
    volume: JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').volume,
  }), placed);

  expect(clearedDetail.seed).toBe(12345);       // seed 保留（与 newWorld 的区别）
  expect(cleared.columns).toBe(pristine.columns);
  expect(cleared.fp).toBe(pristine.fp);         // 地形回到未修改的原始版本
  expect(clearedDetail.stone).toBe(0);          // 放的石头没了
  expect(clearedDetail.volume).toBe(0.5);       // 设置未受影响

  // 7. 端到端：重载两次后 edits 不重现（第一次的事实在第二次时必已提交）
  await page.reload();
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  const persisted = await page.evaluate(async (p) => ({
    savedColumns: await window.__MC_GAME__.persistence.countSavedColumns(),
    stone: window.__MC_GAME__.world.getBlockId(p.x, p.y, p.z),
  }), placed);
  expect(persisted.savedColumns).toBe(0);
  expect(persisted.stone).toBe(0);
});

// **竞态防护的确定性门禁**（上一条端到端断言做不到这件事）。
//
// 实测结论（勿照注释里的推理实现）：`beforeunload → flushNow(world)` 的 IndexedDB 事务
// 在 `location.reload()` 立即卸载时**来不及提交就被中止** → 生产路径上竞态实际不发生。
// 对照实测：诊断脚本在 reload 前多做一次 evaluate 往返 → 事务提交、读到 savedColumns=1
// （缺陷暴露）；而真实 `clearSave()` 路径 → 事务被中止、读到 0（缺陷**静默逃逸**，
// 负向验证实测：注释掉 `col.edits.clear()` 后 E2E 仍然全绿）。
// 故 E2E 的 savedColumns 断言时序不定、不可作为门禁 → 竞态防护必须在**内存侧**直接钉住。
test('删除缓存：_discardEdits 同时清内存 edits 与 IndexedDB（unload 写回竞态防护）', async ({ page }) => {
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });

  const before = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) + 2;
    const pz = Math.floor(g.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const r = g.world.setBlock(px, groundY + 1, pz, g.registry.idOf('stone'));
    g.scheduler.remeshSections(r.affected, { fastPath: true });
    await g.persistence.flushNow(g.world);
    return {
      memEdits: [...g.world.columns.values()].reduce((n, c) => n + c.edits.size, 0),
      savedColumns: await g.persistence.countSavedColumns(),
    };
  });
  expect(before.memEdits).toBeGreaterThan(0);      // 前提：内存与库都有 edits
  expect(before.savedColumns).toBeGreaterThan(0);

  // 不重载，直接测 `_discardEdits` 的内存 + 库双侧效果（确定性，无竞态时序干扰）
  const after = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g._discardEdits();
    return {
      memEdits: [...g.world.columns.values()].reduce((n, c) => n + c.edits.size, 0),
      savedColumns: await g.persistence.countSavedColumns(),
      cacheSize: g.persistence.editsCache.size,
    };
  });
  // 内存归零是关键：少了这步，后续任何写盘机会（5s 防抖 flush / 标签页关闭且事务来得及
  // 提交）都会把旧改动写回刚清空的 store → 用户「点了没生效」
  expect(after.memEdits).toBe(0);
  expect(after.savedColumns).toBe(0);
  expect(after.cacheSize).toBe(0);                 // editsCache 同步清空（预热源不得残留）

  // seed 不受影响（clearSave 与 newWorld 的区别）
  expect(await page.evaluate(() => window.__MC_GAME__.seed)).toBe(12345);
});
