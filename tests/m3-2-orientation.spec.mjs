// tests/m3-2-orientation.spec.mjs — M3.2 方块朝向放置交互（设计文档 §4.3，v1.17 定稿）
// 真实游戏内集成验证（单测覆盖纯函数三分支，此处走完整 Game/Player 装配 + 真实世界写入）：
//   ① 放 chest 首次 meta=0（分支④ 无记忆 → EAST）
//   ② 原位挖放四次 meta 依次 1→2→3→0（分支②，真实手感来源）
//   ③ 跨位置放同类型沿用记忆（分支③）
//   ④ stone（orientationModes=0）恒 meta=0（分支①）
//   ⑤ 带朝向方块存档后重启 meta 保留（edits 通路，无 schema 变更）
//   ⑥ 旋转后 section 重建无报错、draw 受控
// 无头环境无 pointer lock，交互经 window.__MC_GAME__ 编程驱动（同 M3.1 spec 口径）。
import { test, expect } from 'playwright/test';

// 固定 seed：放块点位与地形相关，钉 seed 保可复现（M3 起全部性能/视觉 spec 同口径）
const URL = '/?vd=4&seed=12345';

/** 等待世界就绪 + mesh 管线排空（避免采样混入加载期状态） */
async function boot(page) {
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
}

/** 在页内找一个可放块的空中点位（玩家旁地面上方 1 格），返回坐标 */
async function pickSpot(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) + 2;
    const pz = Math.floor(g.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    return { x: px, y: groundY + 1, z: pz };
  });
}

/** 经真实交互路径放块（读背包选中槽 + 算朝向） */
async function place(page, spot) {
  return page.evaluate(({ x, y, z }) => {
    const g = window.__MC_GAME__;
    g.player.target = { blockPos: [x, y - 1, z], prevPos: [x, y, z] };
    g.player.placeBlock();
    return {
      id: g.world.getBlockId(x, y, z),
      meta: g.world.getBlockMeta(x, y, z),
    };
  }, spot);
}

/** 经真实交互路径挖块（挖前记朝向） */
async function dig(page, spot) {
  return page.evaluate(({ x, y, z }) => {
    const g = window.__MC_GAME__;
    g.player.target = { blockPos: [x, y, z], prevPos: [x, y + 1, z] };
    g.player.digBlock();
    return {
      id: g.world.getBlockId(x, y, z),
      remembered: g.player.lastRemovedBlock
        ? { ...g.player.lastRemovedBlock }
        : null,
    };
  }, spot);
}

test('M3.2：放 chest 首次 meta=0（无记忆 → EAST）', async ({ page }) => {
  await boot(page);
  const spot = await pickSpot(page);

  // 选中 chest（背包面板点击第 N 格 → selectedSlot）
  const chestIndex = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'chest');
    g.player.inventory.selectSlot(idx);
    return idx;
  });
  expect(chestIndex).toBeGreaterThan(4); // chest 不在快捷栏前 5 格

  const r = await place(page, spot);
  const chestId = await page.evaluate(() => window.__MC_GAME__.registry.idOf('chest'));
  expect(r.id).toBe(chestId);
  expect(r.meta).toBe(0);
});

test('M3.2：原位挖放四次 meta 依次 1→2→3→0（顺时针循环）', async ({ page }) => {
  await boot(page);
  const spot = await pickSpot(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'chest');
    g.player.inventory.selectSlot(idx);
  });

  // 首次放置 meta=0
  expect((await place(page, spot)).meta).toBe(0);

  const seq = [];
  for (let i = 0; i < 4; i++) {
    const dug = await dig(page, spot);
    expect(dug.id).toBe(0, `第 ${i + 1} 次挖块后方块应为 air`);
    // 挖块记下旧朝向（从世界 meta 读出）
    expect(dug.remembered, `第 ${i + 1} 次挖块应有记录`).not.toBeNull();
    expect(dug.remembered.x).toBe(spot.x);
    expect(dug.remembered.y).toBe(spot.y);
    expect(dug.remembered.z).toBe(spot.z);
    expect(dug.remembered.orientation).toBe(seq.length === 0 ? 0 : seq[seq.length - 1],
      `第 ${i + 1} 次记下的朝向 = 上次写入的 meta`);

    const placed = await place(page, spot);
    seq.push(placed.meta);
    // 放置成功后清空挖块记忆
    expect(await page.evaluate(() => window.__MC_GAME__.player.lastRemovedBlock)).toBeNull();
  }
  expect(seq).toEqual([1, 2, 3, 0]);

  // 类型记忆已建立（会话内持久，跨位置沿用）
  expect(await page.evaluate(() => window.__MC_GAME__.player.placementOrientationMemory.get(
    window.__MC_GAME__.registry.idOf('chest'),
  ))).toBe(0);
});

test('M3.2：跨位置放同类型沿用记忆（转身/移位不改朝向）', async ({ page }) => {
  await boot(page);
  const spot = await pickSpot(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'chest');
    g.player.inventory.selectSlot(idx);
  });

  // 原位挖放两次建立记忆 = 2
  await place(page, spot);
  await dig(page, spot);
  await place(page, spot); // meta=1
  await dig(page, spot);
  await place(page, spot); // meta=2
  expect((await page.evaluate(({ x, y, z }) => window.__MC_GAME__.world.getBlockMeta(x, y, z), spot))).toBe(2);

  // 换到另一个位置放 chest：沿用记忆 2，而不是重新从 0 开始
  const other = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) - 3;
    const pz = Math.floor(g.player.physics.pos.z) - 3;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    return { x: px, y: groundY + 1, z: pz };
  });
  expect((await place(page, other)).meta).toBe(2);
});

test('M3.2：stone（orientationModes=0）恒 meta=0，原位挖放也不旋转', async ({ page }) => {
  await boot(page);
  const spot = await pickSpot(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'stone');
    g.player.inventory.selectSlot(idx);
  });

  expect((await place(page, spot)).meta).toBe(0);
  // 原位挖放三次：门控关闭 → 恒 0
  for (let i = 0; i < 3; i++) {
    await dig(page, spot);
    expect((await place(page, spot)).meta).toBe(0, `第 ${i + 1} 次原位重放仍 meta=0`);
  }
  // 门控关闭不写类型记忆
  expect(await page.evaluate(() => window.__MC_GAME__.player.placementOrientationMemory.size)).toBe(0);
});

test('M3.2：带朝向方块存档后重启 meta 保留（edits 通路，无 schema 变更）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const spot = await pickSpot(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'chest');
    g.player.inventory.selectSlot(idx);
  });

  // 原位挖放一次 → meta=1，并立即 flush
  await place(page, spot);
  await dig(page, spot);
  const before = await place(page, spot);
  expect(before.meta).toBe(1);
  await page.evaluate(async () => {
    await window.__MC_GAME__.persistence.flushNow(window.__MC_GAME__.world);
  });

  // 整页刷新（模拟重启）
  await page.reload();
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 60_000 });
  await page.waitForFunction(({ x, z }) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16));
  }, spot, { timeout: 30_000 });

  const after = await page.evaluate(({ x, y, z }) => {
    const g = window.__MC_GAME__;
    return { id: g.world.getBlockId(x, y, z), meta: g.world.getBlockMeta(x, y, z) };
  }, spot);
  expect(after.id).toBe(await page.evaluate(() => window.__MC_GAME__.registry.idOf('chest')));
  expect(after.meta).toBe(1, '朝向随 edits 持久化保留');
});

test('M3.2：旋转后 section 重建无报错、draw 受控', async ({ page }) => {
  await boot(page);
  const spot = await pickSpot(page);
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'chest');
    g.player.inventory.selectSlot(idx);
  });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 等世界真正稳定：连续两次采样 sections 相同 + 队列归零。
  // 只用「队列归零」不够——它是瞬时状态，高负载下后台仍在填充 sections 时队列可能短暂归零，
  // 此时采到的 before.sections 偏低，旋转期间世界继续加载会让 draw/sections 增长，
  // 断言测的就成了加载而非旋转（实测全量回归负载下会因此失败）。
  // 加载期 draw 随 section 数增长（实测 89→167 跟 sections 254→535 同步），故必须先稳定。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    // 记下上次采样：sections 连续两次不变才算稳定（window 级缓存，跨帧比较）
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000, polling: 500 });
  const before = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { draw: g.renderStats().drawCalls, sections: g.renderStats().sections };
  });

  // 原位挖放 8 次（跨两个完整循环），每次采样 draw。
  // 循环以 dig 结尾，末尾状态与 before 对等（spot 都是空的）——否则多一个方块会让
  // before/after 比的是两块不同世界，断言失去意义。
  const draws = [];
  for (let i = 0; i < 8; i++) {
    await place(page, spot);
    await dig(page, spot);
    draws.push(await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls));
  }
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 30_000 });

  expect(pageErrors).toEqual([]);
  // draw 受控：旋转全程不随次数增长。draw 是每 section 一组（通道级合批），
  // 旋转只改既有 section 的顶点朝向，不新增 section、不新增 draw。
  // 断言 message 带上实际值：本用例在完整回归负载下曾概率性失败，需要诊断数据定位。
  const maxDraw = Math.max(...draws);
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { draw: g.renderStats().drawCalls, sections: g.renderStats().sections };
  });
  const diag = `before=${JSON.stringify(before)} draws=[${draws.join(',')}] after=${JSON.stringify(after)}`;
  expect(after.sections, `旋转不新增 section｜${diag}`).toBe(before.sections);
  expect(maxDraw - before.draw, `draw 不随旋转次数增长｜${diag}`).toBeLessThanOrEqual(2);
  expect(after.draw - before.draw, `收尾 draw 与起始对等｜${diag}`).toBeLessThanOrEqual(2);
  // 队列最终归零（无永久积压）。必须**再次等待收敛**而不是立刻采样：上面的
  // waitForFunction 归零后，中间几个同步断言期间世界可能又开始加载（光照异步收敛触发
  // remesh、或视距内 column 到达），此刻直接采样会读到非零——实测在全量回归负载下
  // 概率性读到 meshInflight=32（单独跑通过）。语义仍是「无永久积压」，只是改为等它
  // 真正收敛后再断言，不削弱检查强度。
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 30_000 });
  const settled = await page.evaluate(() => window.__MC_GAME__.scheduler.stats());
  expect(settled.inflight).toBe(0);
  expect(settled.meshInflight).toBe(0);
  expect(settled.uploadQueue).toBe(0);
});
