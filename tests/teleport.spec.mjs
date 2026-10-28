import { test, expect } from 'playwright/test';

// 「瞬移」验收（设置面板，v1.92）：背景音乐下方一行四按钮。
//
// 用户 2026-10-29：「在背景音乐下面增加一排按钮，这个区域的功能就是瞬移：
// ①高台地带 → 瞬移到最近的高台地带；②标记位置 → 记录当前玩家位置；
// ③跳转标记位置 → 瞬移到标记位置」，并裁定「高台地带的落点是边缘处」「标记跨会话保留」。
// v1.97 追加 ④回家（用户 2026-10-31：「返回到 City 原始的玩家出生点的位置」）。
//
// ⚠️ **本 spec 必须走真实按钮点击**，不能只调 `game.teleportToTarnZone()` ——
// M7 巢穴的教训（验收报告 §3.7）：只测 Game API 时「面板根本没接线」这类缺陷全绿通过，
// 而玩家实玩立刻发现。所以每个用例都从 `#settings-btn` 打开面板、点 `#btn-*`。

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

/** 玩家脚底坐标（round 到整数，与标记/瞬移的落点口径一致） */
const POS = () => {
  const p = window.__MC_GAME__.player.physics.pos;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
};

/** 打开设置面板（面板是两列 DOM，瞬移行在左列） */
async function openPanel(page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
}

test('瞬移：四个按钮都在面板里，同一行不换行，且位于「背景音乐」下方（用户指定落位）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  await openPanel(page);

  const tarn = page.locator('#btn-teleport-tarn');
  const mark = page.locator('#btn-mark-position');
  const go = page.locator('#btn-teleport-mark');
  const home = page.locator('#btn-teleport-home');
  await expect(tarn).toBeVisible();
  await expect(mark).toBeVisible();
  await expect(go).toBeVisible();
  await expect(home).toBeVisible();
  await expect(tarn).toHaveText('高台地带');
  await expect(mark).toHaveText('标记位置');
  await expect(go).toHaveText('跳转标记位置');
  await expect(home).toHaveText('回家');

  // 四个按钮必须**同一行**（`.mc-btn-group` 的 flex:1 等宽）：换成两行会让每个按钮的字号
  // 不够排「跳转标记位置」→ 文案折行、面板高度也涨一档。判据用 offsetTop 相等（行内元素
  // 基线一致），不能用宽度 —— 宽度本来就相等，换行也看不出。
  const rowTops = await page.evaluate(() =>
    ['btn-teleport-tarn', 'btn-mark-position', 'btn-teleport-mark', 'btn-teleport-home']
      .map((id) => document.getElementById(id).offsetTop));
  expect(new Set(rowTops).size, `四个按钮须同一行，实测 offsetTop=${rowTops.join(',')}`).toBe(1);

  // 落位判据：瞬移行必须出现在「背景音乐」那一组**之后**（用户说「在背景音乐下面」）。
  // ⚠️ 用 DOM 顺序（`querySelectorAll` 的文档序）而不是 getBoundingClientRect 的 top ——
  // 两列并排时 top 不能表达「先后」，只有文档顺序才是「下面」。
  // ⚠️ v1.98：背景音乐不再独占 `.mc-item`（它与雾色同处一个合并盒的右半）→ 必须把
  // **两种容器**都纳入扫描，否则 `iMusic` 恒为 -1，断言退化成「找不到就报错」。
  const ordered = await page.evaluate(() => {
    const modal = document.getElementById('settings-modal');
    const rows = [...modal.querySelectorAll('.mc-item, .mc-combined')];
    const titleOf = (r) => r.querySelector('.mc-title')?.textContent ?? '';
    // 合并盒内多个组标题 → 用「包含」判断（合并盒本身是容器，不是某个组）
    const has = (r, t) => [...r.querySelectorAll('.mc-title')].some((x) => x.textContent === t);
    const iMusic = rows.findIndex((r) => has(r, '背景音乐'));
    const iTele = rows.findIndex((r) => titleOf(r) === '瞬移');
    return { iMusic, iTele, count: rows.length };
  });
  expect(ordered.iMusic, '面板里应有「背景音乐」').toBeGreaterThanOrEqual(0);
  expect(ordered.iTele, '面板里应有「瞬移」行').toBeGreaterThanOrEqual(0);
  // 同一列内文档顺序 = 视觉上下顺序；瞬移行必须紧跟在背景音乐所在容器之后
  expect(ordered.iTele).toBe(ordered.iMusic + 1);
});

test('瞬移：标记 → 走远 → 跳转标记，玩家回到标记点且跨会话保留', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 先记录当前点（用 spawn 后原地不动的位置，避免物理把玩家推走导致基准漂移）
  const origin = await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  });

  await openPanel(page);
  await page.locator('#btn-mark-position').click();
  // 提示文案必须出现（不是静默成功）——这是玩家唯一能确认「记下了」的反馈
  await expect(page.locator('#mc-toast')).toContainText(/已记录位置/);

  // 标记内容落 localStorage（跨会话保留的判据）
  const stored = await page.evaluate(() => localStorage.getItem('mc_heavy_mark_v1'));
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored);
  expect(parsed).toEqual(origin);

  // 走远：直接改物理位置（面板开着时 player.update 被跳过，不会自己动）
  await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    p.x += 500; p.z += 500;
  });
  const away = await page.evaluate(POS);
  expect(Math.abs(away.x - origin.x) + Math.abs(away.z - origin.z)).toBeGreaterThan(100);

  // 跳转标记 → 回到标记点
  await page.locator('#btn-teleport-mark').click();
  // 传送是 async（要等目标 column 加载），等它真的落地再读坐标
  await page.waitForFunction((o) => {
    const p = window.__MC_GAME__.player.physics.pos;
    return Math.round(p.x) === o.x && Math.round(p.z) === o.z;
  }, origin, { timeout: 30000 });
  const back = await page.evaluate(POS);
  expect(back.x).toBe(origin.x);
  expect(back.y).toBe(origin.y);
  expect(back.z).toBe(origin.z);

  // 跨会话：重载后标记仍在，仍能跳回去（用户裁定「标记可以跨会话保留」）
  await page.reload();
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    p.x -= 300; p.z -= 300;
  });
  await openPanel(page);
  await page.locator('#btn-teleport-mark').click();
  await page.waitForFunction((o) => {
    const p = window.__MC_GAME__.player.physics.pos;
    return Math.round(p.x) === o.x && Math.round(p.z) === o.z;
  }, origin, { timeout: 30000 });
  const backAfterReload = await page.evaluate(POS);
  expect(backAfterReload.x).toBe(origin.x);
  expect(backAfterReload.y).toBe(origin.y);
  expect(backAfterReload.z).toBe(origin.z);
});

test('瞬移：没有标记时点「跳转标记位置」不传送，只给提示', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.evaluate(() => localStorage.removeItem('mc_heavy_mark_v1'));
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  await page.evaluate(() => localStorage.removeItem('mc_heavy_mark_v1'));

  const before = await page.evaluate(POS);
  await openPanel(page);
  await page.locator('#btn-teleport-mark').click();
  await expect(page.locator('#mc-toast')).toContainText('尚未标记位置', { timeout: 5000 });
  const after = await page.evaluate(POS);
  // ⚠️ 无标记时**不得传送**：传送到 (0,0) 之类的兜底会把玩家莫名扔走。
  // 断言坐标逐分量不变（不是「差得不多」—— 那是另一个语义）。
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
  expect(after.z).toBe(before.z);
});

test('瞬移：点「高台地带」落到最近地带**边缘**（不是圆心，也不埋进结构里）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  await openPanel(page);
  await page.locator('#btn-teleport-tarn').click();
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到高台地带/, { timeout: 15000 });

  const pos = await page.evaluate(POS);

  // ① 落点必须真的在地带几何范围内（圆心距 ∈ (platformRadius, plateauRadius]）
  const geo = await page.evaluate(async (p) => {
    const m = await import('/src/gen/structures/tarn-zone.js');
    const found = m.findNearestTarnZone(p.x, p.z, window.__MC_GAME__.seed);
    const lay = found ? m.computeTarnZone(found.regionX, found.regionZ, window.__MC_GAME__.seed) : null;
    if (!lay) return null;
    return {
      dist: Math.hypot(p.x - lay.cx, p.z - lay.cz),
      platformRadius: lay.platformRadius, plateauRadius: lay.plateauRadius,
      cx: lay.cx, cz: lay.cz, plateauY: lay.plateauY,
    };
  }, pos);
  expect(geo, '瞬移后应仍能解析出所在地带').not.toBeNull();
  // ② 「边缘」判据：落在平台外缘之外、地带圆之内（缓坡带上）
  expect(geo.dist).toBeGreaterThan(geo.platformRadius);
  expect(geo.dist).toBeLessThanOrEqual(geo.plateauRadius);
  // 也不许贴着圆外 —— 那样「边缘」就成了「圆外」
  expect(geo.dist).toBeLessThan(geo.plateauRadius - 1);

  // ③ 落点高度必须等于**真实生成的地表**（不是瞎猜一个值）
  //
  // ⚠️ **不能断言「传送瞬间脚下实心」**（第一版就是这么写的，实测 FAIL 且是测试的错）：
  // 瞬移目标在 1200 格外，vd=2 的加载半径只有 48 格 —— 传送当帧那块 column 根本还没 GEN，
  // 世界里读到的全是空气。正确口径是：等它加载完（帧循环自动把调度中心推过去），
  // 再断言「玩家站在地表之上」且「高度与地形生成公式一致」。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });

  const ground = await page.evaluate(async (p) => {
    const m = await import('/src/gen/structures/tarn-terrain.js');
    const tz = await import('/src/gen/structures/tarn-zone.js');
    const g = window.__MC_GAME__;
    const found = tz.findNearestTarnZone(p.x, p.z, g.seed);
    const lay = tz.computeTarnZone(found.regionX, found.regionZ, g.seed);
    // 地形生成公式算出的地表方块 y
    const surfaceY = m.tarnSurfaceYAt(p.x, p.z, g.seed, lay);
    return {
      surfaceY,
      // 真实世界该格是什么（column 已加载）
      worldBlockAtSurface: g.world.getBlockId(p.x, surfaceY, p.z),
      feetSolid: g.world.isSolid(p.x, Math.round(p.y) - 1, p.z),
      headSolid: g.world.isSolid(p.x, Math.round(p.y), p.z),
      aboveSolid: g.world.isSolid(p.x, Math.round(p.y) + 1, p.z),
    };
  }, pos);

  // 玩家脚底 y 应 = 地表方块 y + 1（站在地表上方一格）
  expect(Math.round(pos.y)).toBe(ground.surfaceY + 1);
  // 地表那格在世界里必须真的是实心方块（纯函数公式与真实生成一致）
  expect(ground.worldBlockAtSurface, '公式算出的地表应是实心方块（与真实生成一致）').not.toBe(0);
  // 玩家能站、能抬头
  expect(ground.feetSolid, '脚下应是实心地面').toBe(true);
  expect(ground.headSolid, '脚所在的格应是空气').toBe(false);
  expect(ground.aboveSolid, '头顶应是空气').toBe(false);

  // ④ 相机真的跟到了新位置（防「physics.pos 改了但相机没跟上」这类静默缺陷）
  //
  // ⚠️ **必须先关面板**：设置面板是模态（`game.uiModal`），主循环的
  // `if (!this.uiModal) this.player.update(dt)` 会整体跳过 → 相机根本不更新。
  // 第一版没关面板就断言，实测 10s 超时（不是实现缺陷，是测试 setup 漏了这一步）。
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

test('瞬移：点「回家」回到 City 出生点（与 game.spawnX/Y/Z 逐值一致，非重新扫地表）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 出生点的唯一权威是 game.spawnX/Y/Z（启动期从 getCitySpawnPoint + findSpawnY 写入，
  // 与 player.spawn(...) 是同一份数字）—— 断言直接对它，不另建副本。
  const spawn = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { x: g.spawnX, y: g.spawnY, z: g.spawnZ };
  });

  // ① 走远（改物理位置而不是走路：物理拉开得慢，而且地形可能挡路）。
  //    面板开着时 player.update 被跳过，不会自己动。
  await page.evaluate(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    p.x += 500; p.z += 500;
  });
  const away = await page.evaluate(POS);
  expect(Math.abs(away.x - spawn.x) + Math.abs(away.z - spawn.z)).toBeGreaterThan(100);

  // ② 真实按钮点击（不是 game.teleportToSpawn()）—— M7 教训：只测 API 时「面板没接线」类
  //    缺陷全绿通过。
  await openPanel(page);
  await page.locator('#btn-teleport-home').click();

  // ③ toast 必须是「已回到出生点」，不能是「已记录位置」—— 后者是 v1.92 靠嗅探字段判定的
  //    旧路径会输出的错文案（带 x/y/z 而无 dist → 误判成标记）。
  await expect(page.locator('#mc-toast')).toContainText('已回到出生点', { timeout: 15_000 });

  const home = await page.evaluate(POS);
  expect(home.x).toBe(spawn.x);
  expect(home.z).toBe(spawn.z);
  // y 必须是**启动时缓存的 spawnY**，不是点击时重扫的结果：此时出生 column 已被卸载，
  // 重扫会落到兜底值（SEA_Y+2）→ 开在出生点上方/下方。逐值相等才能区分两种实现。
  expect(home.y).toBe(Math.round(spawn.y));

  // ④ 相机真的跟到出生点（防「physics.pos 改了但相机没跟上」这类静默缺陷）。
  //    ⚠️ 必须先关面板：面板是模态，主循环跳过 player.update → 相机不更新。
  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-modal')).toBeHidden();
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});
