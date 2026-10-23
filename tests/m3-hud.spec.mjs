import { test, expect } from 'playwright/test';

// M3-4 验收：HUD 完善 + 随机种子/新世界（roadmap Task M3-4）
// ① HUD 元素可见：perf 面板 / 坐标+biome / 快捷栏 5 格 / ⚙ 设置按钮
// ② 设置面板：点击打开 → uiModal 置位 + 玩家输入暂停；视觉风格/帧预算/枪械破坏生效与持久化
// ③ 新世界：seed 变化、edits 清空、重启读回同 seed（确定性红线 2 回归）
// ④ ?seed= 固定参数两次启动世界一致

const READY = () => window.__MC_GAME__?.worldReady === true;

test('M3-4：HUD 元素可见（坐标/快捷栏/设置按钮/perf 面板）', async ({ page }) => {
  test.setTimeout(180_000);
  // RedCity 起默认出生在 RedCity；本用例断言出生点 biome = CITY，pin spawn=city（RedCity spec §14.8）
  await page.goto('/?vd=4&spawn=city');
  await page.waitForFunction(READY, null, { timeout: 90_000 });

  // 坐标 HUD：xyz + biome + seed 行
  await expect(page.locator('#mc-coords')).toBeVisible();
  const coords = await page.locator('#mc-coords').textContent();
  expect(coords).toMatch(/xyz -?\d+\.\d -?\d+\.\d -?\d+\.\d/);
  expect(coords).toMatch(/biome (CITY|PLAINS|FOREST|DESERT|SWAMP|AZALEA)/);
  expect(coords).toMatch(/seed \d+/);

  // biome 数据级一致性：CITY 判定与游戏侧同一函数（出生点即城市中心）
  const biome = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.biomeAt(p.x, p.z);
  });
  expect(biome).toBe('CITY'); // 出生点 = 城市中心（M2-2 语义）

  // 快捷栏：5 格，图标背景已裁剪（atlas background-size 非默认）
  const hotbar = await page.evaluate(() => {
    const el = document.getElementById('mc-hotbar');
    const cells = el.querySelectorAll(':scope > div');
    const icons = [...cells].map((c) => c.querySelector('div').style.backgroundSize);
    return { count: cells.length, icons };
  });
  expect(hotbar.count).toBe(5);
  for (const ic of hotbar.icons) expect(ic).toMatch(/^\d+px \d+px$/);

  // 数字键切换 hotbar（Player 既有逻辑，UI 同步高亮）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3' })));
  await page.waitForFunction(() => window.__MC_GAME__.player.hotbarIndex === 2, null, { timeout: 5_000 });
  const border = await page.evaluate(() =>
    document.getElementById('mc-hotbar').children[2].style.borderColor);
  expect(border).not.toBe(''); // 选中格边框高亮已应用

  // ⚙ 设置按钮 + perf 面板可见
  await expect(page.locator('#settings-btn')).toBeVisible();
  const shot = await page.screenshot();
  expect(shot.byteLength).toBeGreaterThan(10_000);
});

test('M3-4：设置面板交互（uiModal 门控 + 风格/帧预算/枪械破坏生效与持久化）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4');
  await page.waitForFunction(READY, null, { timeout: 90_000 });

  // 打开面板：uiModal 置位、pointer lock 退出语义（无头无 lock，只断言状态位）
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  expect(await page.evaluate(() => window.__MC_GAME__.uiModal)).toBe(true);

  // 合并盒（画质+枪械破坏）四边框必须完整 —— 钉 CSS 特异性回归（实测踩坑）：
  // 分隔线规则曾写成 `#settings-modal .mc-column > :first-child`（特异性 1,2,0），
  // 压过 `#settings-modal .mc-combined`（1,1,0）的装饰边框 → 列首的合并盒上边框被置
  // none，方框缺一边。用户报告的正是这个观感缺陷（肉眼看不出是特异性冲突）。
  // 故规则只作用于 `.mc-item`（行型），这条断言钉住「合并盒四边都在」。
  const combinedSides = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#settings-modal .mc-combined'));
    return ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[`border${s}Style`]);
  });
  expect(combinedSides.every((s) => s === 'solid')).toBe(true);

  // 面板打开时玩家输入暂停：按住 W 位置不动
  const posBefore = await page.evaluate(() => ({ ...window.__MC_GAME__.player.physics.pos }));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.add('KeyW'); });
  await new Promise((r) => setTimeout(r, 600));
  const posDuring = await page.evaluate(() => ({ ...window.__MC_GAME__.player.physics.pos }));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.delete('KeyW'); });
  expect(Math.abs(posDuring.x - posBefore.x) + Math.abs(posDuring.z - posBefore.z)).toBeLessThan(0.01);

  // 视觉风格切 night：运行时即时生效（dayNight styleOverride）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-modal button')];
    btns.find((b) => b.textContent === '黑夜').click();
  });
  await page.waitForFunction(() => window.__MC_GAME__.dayNight._styleOverride === 'night', null, { timeout: 5_000 });

  // 帧预算 60Hz 档：持久化到 localStorage
  // （原断言用「音量 50%」，音量档已移出面板 —— 默认 100% 开启、无消费方时不必占版面；
  //   改用同为「运行时即时 + 持久化」的帧预算档位，验证路径等价且不会触发重载。）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-modal button')];
    btns.find((b) => b.textContent === '60Hz 档').click();
  });
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}');
    return s.budgetProfile === 'low' && s.visualStyle === 'night';
  }, null, { timeout: 5_000 });

  // 枪械破坏开启：运行时即时生效（weaponController.blockDamageEnabled）+ 持久化
  // （M4 遗留 TODO：对齐 mc-lite「枪械破坏」开/关两按钮，委派 game.setGunBlockDamage）
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#settings-modal button')];
    btns.find((b) => b.textContent === '开启').click();
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return g.player.weaponController.blockDamageEnabled === true
      && JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}').gunBlockDamage === true;
  }, null, { timeout: 5_000 });

  // 关闭面板 → 输入恢复
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  expect(await page.evaluate(() => window.__MC_GAME__.uiModal)).toBe(false);

  // 重载后设置读回：风格 night 自动应用
  await page.reload();
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  const restored = await page.evaluate(() => ({
    style: window.__MC_GAME__.dayNight._styleOverride,
    budgetProfile: window.__MC_GAME__.settings.budgetProfile,
    // 启动应用持久化值：gunBlockDamage=true 重载后 weaponController 自动开启
    gunBlockDamage: window.__MC_GAME__.player.weaponController.blockDamageEnabled,
  }));
  expect(restored.style).toBe('night');
  expect(restored.budgetProfile).toBe('low');
  expect(restored.gunBlockDamage).toBe(true);
});

test('M3-4：新世界（seed 变化 + edits 清空 + 重启读回确定性）', async ({ page }) => {
  test.setTimeout(240_000);
  // 1. 初始世界（?seed=12345 固定入口）+ 放一块石头留下 edits
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  const before = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    // 记录一段地形指纹（出生点邻域列的方块采样和）
    const fp = () => {
      let sum = 0;
      for (const [, col] of g.world.columns) {
        for (let i = 0; i < col.blocks.length; i += 997) sum += col.blocks[i];
      }
      return sum;
    };
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px + 2, y, pz + 2) !== 0) { groundY = y; break; } }
    const r = g.world.setBlock(px + 2, groundY + 1, pz + 2, g.registry.idOf('stone'));
    g.scheduler.remeshSections(r.affected, { fastPath: true });
    await g.persistence.flushNow(g.world);
    return { seed: g.seed, fp: fp(), savedColumns: await g.persistence.countSavedColumns() };
  });
  expect(before.seed).toBe(12345);
  expect(before.savedColumns).toBeGreaterThan(0); // edits 已落库

  // 2. newWorld()：seed 变化 + 重载（带新 ?seed=）
  await page.evaluate(() => window.__MC_GAME__.newWorld(null));
  await page.waitForLoadState('load');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  const after = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    let sum = 0;
    for (const [, col] of g.world.columns) {
      for (let i = 0; i < col.blocks.length; i += 997) sum += col.blocks[i];
    }
    return { seed: g.seed, fp: sum, savedColumns: await g.persistence.countSavedColumns() };
  });
  expect(after.seed).not.toBe(before.seed);           // 新世界 seed 变化
  expect(after.fp).not.toBe(before.fp);               // 地形与旧世界不同
  expect(after.savedColumns).toBe(0);                 // 旧 edits 已清空

  // 3. 重启读回同一 seed（确定性红线 2：meta 落库后重启不变）
  const newSeed = after.seed;
  await page.reload();
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  const restarted = await page.evaluate(() => window.__MC_GAME__.seed);
  expect(restarted).toBe(newSeed);

  // 4. ?seed= 固定参数：全新上下文两次启动世界一致（无存档 → 显式 seed 生效）
  const fpOf = async () => {
    const ctx = await page.context().browser().newContext();
    const p2 = await ctx.newPage();
    await p2.goto('/?vd=2&seed=777');
    await p2.waitForFunction(READY, null, { timeout: 90_000 });
    await p2.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 20, null, { timeout: 60_000 });
    const fp = await p2.evaluate(() => {
      const g = window.__MC_GAME__;
      let sum = 0;
      for (const [, col] of g.world.columns) {
        for (let i = 0; i < col.blocks.length; i += 997) sum += col.blocks[i];
      }
      return { seed: g.seed, sum };
    });
    await ctx.close();
    return fp;
  };
  const a = await fpOf();
  const b = await fpOf();
  expect(a.seed).toBe(777);
  expect(b.seed).toBe(777);
  expect(a.sum).toBe(b.sum); // 同 seed 两次启动逐格一致
});
