import { test, expect } from 'playwright/test';

// 回归：**结构性光源**（房屋里的 glowstone / 地下的 lava / 城市吊灯）的 blocklight 必须跨 column。
//
// 为什么单独一条 spec（区别于 light-spread.spec.mjs 的「玩家放灯」）：
// GEN 只对本 column 算 blocklight（world-worker 的 `gen` 分支，截断），跨列光必须靠
// 「以各列为中心的 light 任务」收敛。玩家放灯会经 `remeshSections → enqueueLight` 触发；
// 而**结构性光源**没有任何编辑事件 —— 若 `_onGenResult` 不做 emissive 检测
// （`_enqueueLightIfOverhang` 的第二半，2026-10-21 补），光就永远停在 column 边界上。
// 实测（seed=12345 默认视距）：注入「去掉 GEN 收敛」后 32 个跨列邻居格失效。
//
// ⚠️ 判据必须排除「沿途被不透明方块挡住」的方向：房屋里的 glowstone 隔 2 格就是
// dark_planks 墙，光本来就到不了邻列（实测 10 个不达标方向里 9 个是这种情况）。
// 只对**沿途畅通**的方向断言 —— 否则断言描述的是想象中的世界（testing-policy §2.6）。
test('结构性光源的 blocklight 跨 column 扩散（GEN 收敛）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=4&seed=12345&style=noon&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.lightInflight === 0 && s.lightQueued === 0 &&
      s.meshInflight === 0 && s.pendingMesh === 0;
  }, null, { timeout: 120_000, polling: 250 });

  const out = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { blockIndex, WORLD_MIN_Y } = await import('/src/voxel/constants.js');
    const emissive = g.registry.emissiveTable, opaque = g.registry.opaqueTable;
    const rows = [];
    for (const [, col] of g.world.columns) {
      for (let i = 0; i < col.blocks.length; i++) {
        if (emissive[col.blocks[i]] <= 0) continue;
        const lx = i & 15, lz = (i >> 4) & 15, y = WORLD_MIN_Y + (i >> 8);
        for (const [dir, nOff, nlx, nlz, steps] of [
          ['+X', [1, 0], 0, lz, 15 - lx], ['-X', [-1, 0], 15, lz, lx],
          ['+Z', [0, 1], lx, 0, 15 - lz], ['-Z', [0, -1], lx, 15, lz],
        ]) {
          const hop = steps + 1;
          if (hop > 14) continue; // 光最远 14 格，更远的邻列格本就该是 0
          const ncol = g.world.getColumn(col.cx + nOff[0], col.cz + nOff[1]);
          if (!ncol) continue;
          // 沿途（本列内走向边界的那几格）必须全通透，否则光本来就到不了邻列 —— 不计入
          let blocked = false;
          for (let k = 1; k <= steps; k++) {
            const sx = dir === '+X' ? lx + k : dir === '-X' ? lx - k : lx;
            const sz = dir === '+Z' ? lz + k : dir === '-Z' ? lz - k : lz;
            if (opaque[col.blocks[blockIndex(sx, y, sz)]] === 1) { blocked = true; break; }
          }
          if (blocked) continue;
          // 目标格自身也必须通透：opaque 方块自身格永远没有 blocklight（光的 BFS 不以
          // opaque 格为中继），拿它当判据等于要求「墙也发光」（实测漏了这一条的代价：
          // 1 个假失败，目标格是 dark_planks）。
          const targetIdx = blockIndex(nlx, y, nlz);
          if (opaque[ncol.blocks[targetIdx]] === 1) continue;
          rows.push({ hop, bl: ncol.light[targetIdx] & 15, expect: 15 - hop });
        }
      }
    }
    return {
      total: rows.length,
      ok: rows.filter((r) => r.bl >= r.expect).length,
      bad: rows.filter((r) => r.bl < r.expect).length,
      samples: rows.filter((r) => r.bl < r.expect).slice(0, 5),
    };
  });

  console.log('LIGHT-STRUCTURES:', JSON.stringify(out));
  // sanity floors：世界上确实有可测的结构性光源（防「全 0 也通过」）
  expect(out.total).toBeGreaterThan(5);
  expect(out.bad).toBe(0);
});
