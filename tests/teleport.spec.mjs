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

test('瞬移：九个按钮都在面板里，同一行不换行，且位于「背景音乐」下方（用户指定落位）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });
  await openPanel(page);

  // v2.10 用户 2026-10-29 指定顺序：「标记，跳转标记，回家，高台，竞技场」；
  // v2.19 用户 2026-10-30 在本行末尾追加「湖」（浅水高台）；
  // v2.87 用户 2026-11-09：原「竞技场」（小竞技场）改名「围场」，其后新增指向**大竞技场**的「竞技场」；
  // v2.89 用户 2026-11-10：末尾追加「堡垒」（城西废弃堡垒），同时「竞技场」缩为「竞技」。
  // v3.13 用户 2026-11-17：末尾追加「丛林」（城西第一个丛林地带的丛林要塞）；
  //    v3.14 用户 2026-11-18 把该按钮文案改为「要塞」（同为 2 字，布局不变）。
  //    实测第 9 个后每只宽 **38.1px**、高 33px、行盒数 1（2 字 24px 放得下）。
  // ⚠️ 文案上限随按钮数递减：六按钮 4 字、七按钮 3 字、**八按钮 2 字**（实测每只文字可用
  //    31.4px，3 字 36px 折行，即使 gap 收到 0px 也只有 34.9px）。
  const ORDER = ['btn-mark-position', 'btn-teleport-mark', 'btn-teleport-home',
    'btn-teleport-tarn', 'btn-teleport-arena', 'btn-teleport-burning-arena', 'btn-teleport-lake',
    'btn-teleport-ruined-citadel', 'btn-teleport-jungle-fortress'];
  const LABELS = ['标记', '跳转', '回家', '高台', '围场', '竞技', '湖', '堡垒', '要塞'];
  const ids = new Set(ORDER);
  for (const id of ORDER) await expect(page.locator(`#${id}`)).toBeVisible();
  expect(ids.size).toBe(9);

  const rowTops = await page.evaluate((order) =>
    order.map((id) => document.getElementById(id).offsetTop), ORDER);
  // 九个按钮必须**同一行**（`.mc-btn-group` 的 flex:1 等宽）：换成两行会让面板高度涨一档、
  // 文案也被压窄。判据用 offsetTop 相等（行内元素基线一致），不能用宽度 —— 宽度本来就相等，
  // 换行也看不出。
  expect(new Set(rowTops).size, `九个按钮须同一行，实测 offsetTop=${rowTops.join(',')}`).toBe(1);
  expect(await page.evaluate((order) => order.map((id) => document.getElementById(id).textContent), ORDER))
    .toEqual(LABELS);

  // ⚠️ **`scrollWidth <= clientWidth` 只是第一层判据**（v1.98 的「导入进度→导入」就是它逼出来的）：
  // 按钮平分 375px 后每个仅 ~43px 可用，12px 字号下一个汉字约 12px。
  // ⚠️ **它对「文案折行」没有判别力**（v2.19 实测）：中文可在任意字间断行，文案放不下时
  // 浏览器是**折成两行**而不是溢出 —— 折行时 `scrollWidth` 与 `clientWidth` 依然相等（实测 52 == 52），
  // 真实形态是按钮高 33 → 50px。故必须再加一层**行盒数 == 1** 的判据（`Range.getClientRects()`）。
  const overflow = await page.evaluate((order) => order.map((id) => {
    const b = document.getElementById(id);
    const r = document.createRange();
    r.selectNodeContents(b);
    const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    return { id, scrollW: b.scrollWidth, clientW: b.clientWidth, text: b.textContent, lines, h: b.offsetHeight };
  }), ORDER);
  for (const o of overflow) {
    expect(o.scrollW, `「${o.text}」超出按钮宽度（${o.scrollW} > ${o.clientW}）`).toBeLessThanOrEqual(o.clientW);
    expect(o.lines, `「${o.text}」折成了 ${o.lines} 行（按钮高 ${o.h}px）—— 九个按钮 + gap:4px 平分只剩 ≈26px 文字宽，最多 2 个字`).toBe(1);
  }

  // 顺序必须与 DOM 文档序一致（不能只在视觉上排对了、DOM 序错乱）
  const domOrder = await page.evaluate(() => {
    const g = document.querySelector('#settings-modal .mc-teleport .mc-btn-group');
    return [...g.children].map((b) => b.id);
  });
  expect(domOrder).toEqual(ORDER);

  // 面板不得因新增按钮出现纵向滚动条（v1.63/v1.98 的既定判据：面板高度不涨）
  const scroll = await page.evaluate(() => {
    const c = document.getElementById('settings-modal').querySelector('.mc-content');
    return { scrollH: c.scrollHeight, clientH: c.clientHeight };
  });
  expect(scroll.scrollH, '面板内容不得溢出（出现纵向滚动条 = 高度涨了一档）').toBeLessThanOrEqual(scroll.clientH + 1);

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

test('瞬移：标记 → 走远 → 跳转，玩家回到标记点且跨会话保留', async ({ page }) => {
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
  // ⚠️「标记」是六个按钮里**唯一不自动关面板**的（用户 2026-10-30：「除了点击标记按钮外，
  // 点击其他的按钮完成跳转后」）—— 它只记录位置、不跳转，关掉面板会让坐标提示一闪而过。
  // 晚于 TELEPORT_AUTO_CLOSE_MS（100ms）再断言，才能区分「不关」与「关得慢一点」。
  await page.waitForTimeout(400);
  await expect(page.locator('#settings-modal'), '点「标记」后面板必须保持打开').toBeVisible();

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

  // 跳转 → 回到标记点
  await page.locator('#btn-teleport-mark').click();
  // v2.28（用户 2026-10-30）：跳转成功 100ms 后自动关面板、回到游戏。
  // ⚠️ 这条断言必须在本用例里也有：其余五条用例各自只覆盖一个按钮，把某一支漏接线时
  // 只有那条会红——首版本用例没写这句，负向验证实测「跳转」不关面板时**全绿**。
  await expect(page.locator('#settings-modal'), '跳转成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
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
  // 重载后这一支同样要自动关面板（与上一条同源断言，防止只给首次会话接线）
  await expect(page.locator('#settings-modal'), '重载后跳转成功也应自动关面板')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction((o) => {
    const p = window.__MC_GAME__.player.physics.pos;
    return Math.round(p.x) === o.x && Math.round(p.z) === o.z;
  }, origin, { timeout: 30000 });
  const backAfterReload = await page.evaluate(POS);
  expect(backAfterReload.x).toBe(origin.x);
  expect(backAfterReload.y).toBe(origin.y);
  expect(backAfterReload.z).toBe(origin.z);
});

test('瞬移：没有标记时点「跳转」不传送，只给提示', async ({ page }) => {
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
  // ⚠️ **失败不自动关面板**：`no-mark` 要玩家去点「标记」，自动关掉只会逼他再按一次 ⚙。
  await page.waitForTimeout(400);
  await expect(page.locator('#settings-modal'), '失败时面板必须保持打开').toBeVisible();
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
  // ⚠️ **面板必须已关闭**：设置面板是模态（`game.uiModal`），主循环的
  // `if (!this.uiModal) this.player.update(dt)` 会整体跳过 → 相机根本不更新。
  // 第一版没关面板就断言，实测 10s 超时（不是实现缺陷，是测试 setup 漏了这一步）。
  // v2.28 起无需手动点 `#settings-close` —— 瞬移成功 100ms 后面板自己关了，
  // 这里改成**等它自己关**（同时钉住「这条接线真的在」：五条跳转按钮各有一条用例）。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
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
  //    ⚠️ 面板必须已关闭：面板是模态，主循环跳过 player.update → 相机不更新。
  //    v2.28 起由「瞬移成功 100ms 后自动关面板」接管（用户 2026-10-30 需求）。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

test('瞬移：点「围场」落到城南围场（原小竞技场）中心、站得住、且真的传到了（v2.10 / v2.87 改名）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 围场落点的唯一权威 = `computeArenaAnchor(seed)`（与 apply.js 阶段 2.9 同源，红线 1）。
  // 这里在**页面里** import 同一份纯函数算期望值，不另写一份落点副本。
  const anchor = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/arena.js');
    const a = m.computeArenaAnchor(window.__MC_GAME__.seed);
    return a ? { wx: a.wx, wz: a.wz, floorY: a.floorY } : null;
  });
  // 前提：seed 12345 必须真的有围场（否则本用例无判别力 —— 先跑真实数据再断言）
  expect(anchor, 'seed 12345 须生成围场').not.toBeNull();

  const before = await page.evaluate(POS);
  expect(Math.abs(before.x - anchor.wx) + Math.abs(before.z - anchor.wz),
    '前提：玩家出生点不在围场（否则「传送生效」无判别力）').toBeGreaterThan(50);

  // 真实按钮点击（不是 game.teleportToArena() —— M7 教训：只测 API 会漏「面板没接线」）
  await openPanel(page);
  await page.locator('#btn-teleport-arena').click();
  // 文案必须标明是围场（v2.87 改名），不能落进 default 的「已完成：」，
  // 也不能误报成「竞技场」（那是大竞技场的文案）
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到围场/, { timeout: 15_000 });

  const pos = await page.evaluate(POS);
  // ① 落点 = 围场占地中心（x/z 逐值等于 anchor）
  expect(pos.x).toBe(anchor.wx);
  expect(pos.z).toBe(anchor.wz);
  // ② y = floorY + 1（脚底踩在地板层上方一格）。这是 `apply.js` 阶段 2.9 的落位口径：
  //    地板层坐落在 floorY，故站 floorY+1 就是站在场地上。
  expect(pos.y).toBe(anchor.floorY + 1);

  // ③ 等目标 column GEN 完再验「脚下是实心、抬头是空气」（传送当帧目标 region 尚未加载，
  //    此时读世界全是空气 —— 这是 `_teleportTo` 的既定语义，不是缺陷）。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });

  const ground = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const fy = Math.round(p.y);
    return {
      feetSolid: g.world.isSolid(p.x, fy - 1, p.z),
      atAir: g.world.isSolid(p.x, fy, p.z),
      headAir: g.world.isSolid(p.x, fy + 1, p.z),
      floorBlock: g.world.getBlockId(p.x, fy - 1, p.z),
    };
  });
  expect(ground.feetSolid, `脚下须是实心场地（floorBlock=${ground.floorBlock}）`).toBe(true);
  expect(ground.atAir, '脚所在格须是空气').toBe(false);
  expect(ground.headAir, '抬头须是空气（不能把头埋进方块里）').toBe(false);

  // ④ 相机真的跟过去（防「physics.pos 改了但相机没跟上」）。必须先关面板 —— 模态期
  //    主循环跳过 player.update，相机不更新（v1.92 已踩过这个 setup 坑）。
  //    v2.28 起由「瞬移成功 100ms 后自动关面板」接管（用户 2026-10-30 需求）。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

test('瞬移：点「竞技场」落到大竞技场**西缘外的平地**（不在碗内、站得住、y 与自然地表同源，v2.87）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 期望值只用**纯函数**算（与 Game 同源，红线 1）：锚点 + 占地半宽 + 缘外净距 + 自然地表。
  // ⚠️ 不在这里复制 `burningArenaTeleportPoint` 的实现 —— 那会变成第二份落点权威；
  // 本用例验的是**性质**（在占地外、在西侧、y = 真实地表 + 1），而不是逐值复算。
  const arena = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/burning-arena.js');
    const t = await import('/src/gen/terrain.js');
    const a = m.computeBurningArenaAnchor(window.__MC_GAME__.seed);
    if (!a) return null;
    const p = m.burningArenaTeleportPoint(window.__MC_GAME__.seed);
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY,
      half: m.BURNING_ARENA_HALF, gap: m.BURNING_ARENA_TELEPORT_GAP,
      point: p, surfaceY: t.generateHeight(p.x, p.z, window.__MC_GAME__.seed),
    };
  });
  // 前提：seed 12345 必须真有大竞技场（否则本用例无判别力 —— 先跑真实数据再断言）
  expect(arena, 'seed 12345 须生成大竞技场').not.toBeNull();

  const before = await page.evaluate(POS);
  expect(Math.abs(before.x - arena.wx) + Math.abs(before.z - arena.wz),
    '前提：玩家出生点不在大竞技场（否则「传送生效」无判别力）').toBeGreaterThan(100);

  // 真实按钮点击（不是 game.teleportToBurningArena() —— M7 教训：只测 API 会漏「面板没接线」）
  await openPanel(page);
  await page.locator('#btn-teleport-burning-arena').click();
  // 文案必须标明是竞技场，不能落进 default 的「已完成：」，也不能误报成「围场」
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到竞技场/, { timeout: 15_000 });

  const pos = await page.evaluate(POS);
  // ① 落点 = 纯函数给出的那一点（x/z/y 逐值）
  expect(pos.x).toBe(arena.point.x);
  expect(pos.z).toBe(arena.point.z);
  expect(pos.y).toBe(arena.point.y);
  // ② 「边缘的平地」判据：在占地**外**（不在碗里），且紧贴西缘（用户：「瞬移到大竞技场
  //    边缘的平地的位置」）。z 取锚点中线 ⇒ 玩家面朝东就能看到整个碗体。
  expect(Math.abs(pos.x - arena.wx), `落点须在占地外（半宽 ${arena.half}）`).toBeGreaterThan(arena.half);
  expect(pos.x, '落点须在西侧（City 那一侧）').toBeLessThan(arena.wx);
  expect(arena.wx - pos.x, `离西缘 ${arena.wx - pos.x - arena.half} 格，须是「边缘」而不是走到沙漠深处`)
    .toBeLessThanOrEqual(arena.half + arena.gap);
  expect(pos.z).toBe(arena.wz);
  // ③ y 与**自然地表**同源（不是碗内地板 floorY —— 缘外沙漠的自然高度与它可能差几格）
  expect(pos.y, `y 须 = 自然地表 ${arena.surfaceY} + 1`).toBe(arena.surfaceY + 1);

  // ④ 等目标 column GEN 完再验世界（传送当帧目标 region 尚未加载，见 `_teleportTo`）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });

  const ground = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const fy = Math.round(p.y);
    return {
      feetSolid: g.world.isSolid(p.x, fy - 1, p.z),
      atAir: g.world.isSolid(p.x, fy, p.z),
      headAir: g.world.isSolid(p.x, fy + 1, p.z),
      floorBlock: g.world.getBlockId(p.x, fy - 1, p.z),
      floorName: g.world.getBlockId(p.x, fy - 1, p.z) ? g.registry.nameOf(g.world.getBlockId(p.x, fy - 1, p.z)) : 'air',
    };
  });
  expect(ground.feetSolid, `脚下须是实心平地（floorBlock=${ground.floorName}）`).toBe(true);
  expect(ground.atAir, '脚所在格须是空气').toBe(false);
  expect(ground.headAir, '抬头须是空气（不能把头埋进方块里）').toBe(false);

  // ⑤ 相机真的跟过去（防「physics.pos 改了但相机没跟上」）。v2.28 起由「瞬移成功 100ms
  //    后自动关面板」接管 —— 面板是模态，不关则主循环跳过 player.update、相机不更新。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

test('瞬移：堡垒 → 城西废弃堡垒东缘外干燥落地（传送 y 与真实地表同源）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 期望值只用**纯函数**算（与 Game 同源，红线 1）：锚点 + 占地半宽 + 缘外净距 + 自然地表。
  // ⚠️ 不在这里复制 `ruinedCitadelTeleportPoint` 的实现 —— 那会变成第二份落点权威；
  // 本用例验的是**性质**（在占地外、在东侧、y = 真实地表 + 1），而不是逐值复算。
  const citadel = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/ruined-citadel.js');
    const t = await import('/src/gen/terrain.js');
    const a = m.computeRuinedCitadelAnchor(window.__MC_GAME__.seed);
    if (!a) return null;
    const p = m.ruinedCitadelTeleportPoint(window.__MC_GAME__.seed);
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY,
      halfX: m.RUINED_CITADEL_HALF_X, halfZ: m.RUINED_CITADEL_HALF_Z,
      gap: m.RUINED_CITADEL_TELEPORT_GAP,
      point: p, surfaceY: t.generateHeight(p.x, p.z, window.__MC_GAME__.seed),
    };
  });
  // 前提：seed 12345 必须真有废弃堡垒（否则本用例无判别力 —— 先跑真实数据再断言）
  expect(citadel, 'seed 12345 须生成废弃堡垒').not.toBeNull();

  const before = await page.evaluate(POS);
  expect(Math.abs(before.x - citadel.wx) + Math.abs(before.z - citadel.wz),
    '前提：玩家出生点不在废弃堡垒（否则「传送生效」无判别力）').toBeGreaterThan(100);

  // 真实按钮点击（不是 game.teleportToRuinedCitadel() —— M7 教训：只测 API 会漏「面板没接线」）
  await openPanel(page);
  await page.locator('#btn-teleport-ruined-citadel').click();
  // 文案必须标明是堡垒，不能落进 default 的「已完成：」，也不能误报成「竞技场」/「围场」
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到堡垒/, { timeout: 15_000 });

  const pos = await page.evaluate(POS);
  // ① 落点 = 纯函数给出的那一点（x/z/y 逐值）
  expect(pos.x).toBe(citadel.point.x);
  expect(pos.z).toBe(citadel.point.z);
  expect(pos.y).toBe(citadel.point.y);
  // ② 「边缘的平地」判据：在占地**外**，且紧贴东缘。z 取锚点中线 ⇒ 玩家面朝西就能看到整个堡垒。
  //    ⚠️ **方向与大竞技场相反**：大竞技场在城东 ⇒ 落点在其西缘；本结构在城西 ⇒ 落点在其东缘。
  //    两者都是「靠 City 的那一侧」，照抄大竞技场的 `toBeLessThan` 会让本条恒红。
  expect(Math.abs(pos.x - citadel.wx), `落点须在占地外（x 半宽 ${citadel.halfX}）`).toBeGreaterThan(citadel.halfX);
  expect(pos.x, '落点须在东侧（City 那一侧）').toBeGreaterThan(citadel.wx);
  expect(pos.x - citadel.wx, `离东缘 ${pos.x - citadel.wx - citadel.halfX} 格，须是「边缘」而不是走到沙漠深处`)
    .toBeLessThanOrEqual(citadel.halfX + citadel.gap);
  expect(pos.z).toBe(citadel.wz);
  // ③ y 与**自然地表**同源（不是甲板 floorY —— 缘外沙漠的自然高度与它可能差几格）
  expect(pos.y, `y 须 = 自然地表 ${citadel.surfaceY} + 1`).toBe(citadel.surfaceY + 1);

  // ④ 等目标 column GEN 完再验世界（传送当帧目标 region 尚未加载，见 `_teleportTo`）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });

  const ground = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const fy = Math.round(p.y);
    return {
      feetSolid: g.world.isSolid(p.x, fy - 1, p.z),
      atAir: g.world.isSolid(p.x, fy, p.z),
      headAir: g.world.isSolid(p.x, fy + 1, p.z),
      floorName: g.world.getBlockId(p.x, fy - 1, p.z) ? g.registry.nameOf(g.world.getBlockId(p.x, fy - 1, p.z)) : 'air',
    };
  });
  expect(ground.feetSolid, `脚下须是实心平地（floorBlock=${ground.floorName}）`).toBe(true);
  expect(ground.atAir, '脚所在格须是空气').toBe(false);
  expect(ground.headAir, '抬头须是空气（不能把头埋进方块里）').toBe(false);

  // ⑤ 相机真的跟过去（防「physics.pos 改了但相机没跟上」）。v2.28 起由「瞬移成功 100ms
  //    后自动关面板」接管 —— 面板是模态，不关则主循环跳过 player.update、相机不更新。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

test('瞬移：湖 → 浅水高台西岸干燥落地（不落水、传送 y 与真实地表同源）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 期望值只用**纯函数**算（与 Game 同源，红线 1）：湖心 / 湖岸极径 / 海平面 / 整形区外缘。
  // ⚠️ **不在这里复制 Game 里那段「扫方位找干燥岸」的逻辑** —— 那会变成第二份落点权威；
  // 本用例验的是**性质**（在湖心以西、在本地图整形区内的缓坡带、干燥、y 与真实地表一致），
  // 而不是逐值复算落点。
  const lake = await page.evaluate(async () => {
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    const c = await import('/src/voxel/constants.js');
    const a = m.computeShallowTarnAnchor(window.__MC_GAME__.seed);
    if (!a) return null;
    return {
      wx: a.wx, wz: a.wz,
      seaY: c.SEA_Y,
      radiusMin: m.LAKE_RADIUS_MIN,
      beach: m.BEACH_WIDTH,
      outer: m.SHALLOW_TARN_OUTER_RADIUS,
    };
  });
  // 前提：seed 12345 必须真的有浅水高台（否则本用例无判别力 —— 先跑真实数据再断言）
  expect(lake, 'seed 12345 须生成浅水高台').not.toBeNull();

  const before = await page.evaluate(POS);
  expect(Math.abs(before.x - lake.wx) + Math.abs(before.z - lake.wz),
    '前提：玩家出生点不在浅水高台（否则「传送生效」无判别力）').toBeGreaterThan(200);

  // 真实按钮点击（不是 game.teleportToShallowTarn() —— M7 教训：只测 API 会漏「面板没接线」）
  await openPanel(page);
  await page.locator('#btn-teleport-lake').click();
  // 文案必须标明是浅水高台，不能落进 default 的「已完成：」
  await expect(page.locator('#mc-toast')).toContainText(/已瞬移到浅水高台/, { timeout: 15_000 });

  const pos = await page.evaluate(POS);
  // ① 落在湖的**西侧**（City 那一侧）：x 必须小于湖心
  expect(pos.x, `落点须在湖心以西（pos.x=${pos.x}，湖心=${lake.wx}）`).toBeLessThan(lake.wx);
  // ② 水平距离落在「沙滩带之外 → 整形区外缘之内」 ⇒ 落在缓坡带，属本地图而不是外面的自然地形
  const d = Math.hypot(pos.x - lake.wx, pos.z - lake.wz);
  expect(d, `离湖心 ${d.toFixed(1)} 格，须在沙滩带（${(lake.radiusMin + lake.beach).toFixed(1)}）之外`)
    .toBeGreaterThan(lake.radiusMin + lake.beach);
  expect(d, `离湖心 ${d.toFixed(1)} 格，须在整形区（${lake.outer.toFixed(1)}）之内`)
    .toBeLessThan(lake.outer);
  // ③ 干燥（用户 2026-10-30 选的是「干燥落地」）：地表不低于海平面 ⟺ 上方没有水方块
  expect(pos.y - 1, `地表 y=${pos.y - 1} 须不低于海平面 ${lake.seaY}（否则落在水下坡）`)
    .toBeGreaterThanOrEqual(lake.seaY);

  // ④ 等目标 column GEN 完再验世界（传送当帧目标 region 尚未加载，见 `_teleportTo`）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });

  const ground = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const fy = Math.round(p.y);
    // 该列「最高的实心方块」—— 与 `shallowTarnSurfaceYAt` 的交叉比对（真实世界 vs 纯函数）。
    // ⚠️ 用 isSolid 扫而不是「第一个非空气」：落点列上可能长出非实心植被（草/花），
    // 那不是地形表面，也不影响玩家站立。
    let topY = null, topId = 0;
    for (let y = fy + 10; y >= fy - 20; y--) {
      if (!g.world.isSolid(p.x, y, p.z)) continue;
      topY = y;
      topId = g.world.getBlockId(p.x, y, p.z);
      break;
    }
    return {
      feetSolid: g.world.isSolid(p.x, fy - 1, p.z),
      atSolid: g.world.isSolid(p.x, fy, p.z),
      headSolid: g.world.isSolid(p.x, fy + 1, p.z),
      topY, topName: topId ? g.registry.nameOf(topId) : 'air',
    };
  });
  // ⑤ y 与真实地表同源：世界上「最高的实心方块」必须正好在脚下一格
  expect(ground.topY, `传送 y 须正好落在地表之上（世界最高实心 y=${ground.topY}（${ground.topName}），`
    + `脚下=${pos.y - 1}）`).toBe(pos.y - 1);
  expect(ground.feetSolid, `脚下须是实心地表（${ground.topName}）`).toBe(true);
  expect(ground.atSolid, '脚所在格须是空气（不能站在方块里）').toBe(false);
  expect(ground.headSolid, '抬头须是空气（不能把头埋进方块里）').toBe(false);
  // ⑥ 不得落在水里 —— 干燥落地的硬判据（水的 top face 低下 0.5，视觉上「站水里」也是缺陷）
  expect(['water', 'swamp_water'], `落点地表不得是水（实得 ${ground.topName}）`).not.toContain(ground.topName);

  // ⑦ 相机真的跟过去（防「physics.pos 改了但相机没跟上」）。必须先关面板 —— 模态期
  //    主循环跳过 player.update，相机不更新（v1.92 已踩过这个 setup 坑）。
  //    v2.28 起由「瞬移成功 100ms 后自动关面板」接管（用户 2026-10-30 需求）。
  await expect(page.locator('#settings-modal'), '瞬移成功后应自动关面板回游戏')
    .toBeHidden({ timeout: 5000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const c = g.player.camera.position;
    return Math.abs(c.x - p.x) < 1.5 && Math.abs(c.z - p.z) < 1.5;
  }, null, { timeout: 10_000 });
});

// ==================== 解卡（v2.29，用户 2026-10-31） ====================
//
// 用户报告：「瞬移过去的时候有时候瞬移到了地底下，导致玩家瞬移完了之后卡在了地底下的方块里
// 动弹不得」。
//
// 根因（实测，见 `_resolvePlayerStuck` 注释）：`_teleportTo()` 刻意不等目标 column 加载 →
// 传送当帧目标区域全是未加载 column（`getBlockId` 对缺失 column 返回空气）→ 玩家悬空、重力
// 一路拉到世界底；随后 column GEN 完成，`fillColumn` 的「底部补实」把 `WORLD_MIN_Y` 到地表之间
// 全填成 stone → **玩家 AABB 整个埋在实心石头里**，而 `_moveAxis` 碰撞后二分回退到零位移并清零
// `vel` → 水平与竖直全部冻结。
//
// ⚠️ **实测还有一个更高频的形态**：三个传送目标（tarn/lake/arena）在默认视距下**全部**触发
// 「被埋 1 格」（探针实测 `stuck:true, raised:1`）—— 玩家下坠了不到 1 格时 column 才 ready，
// 脚底那格已被地表方块占住。所以本用例不只测「掉到世界底」，也测「浅埋」。

test('解卡：远处瞬移后玩家被埋进方块 → column 加载完成时自动抬出且能移动（v2.29）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // ① 深埋场景：传送到 700+ 格外的高台地带，**当帧**把玩家压到世界底 —— 精确复现
  //    「重力一路掉到底、随后 column 才生成并底部补实」的时序。
  const tp = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.teleportToTarnZone();
    g.player.physics.pos.y = -32;      // 世界底（bedrock 兜底那一格）
    return r;
  });
  expect(tp.ok, '前提：seed 12345 须能传送到高台地带').toBe(true);
  expect(tp.dist, '前提：目标须足够远（column 未加载才有被埋窗口）').toBeGreaterThan(200);

  // ② 等目标 column 加载完（帧循环自动把调度中心推过去）—— 解卡就挂在这条回调上
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
  }, null, { timeout: 120_000 });
  await page.waitForTimeout(500);

  // ③ 判据：**不再与方块重叠** + **y 远离世界底** + **真的能走**。
  //    ⚠️ 三条缺一不可：只断言 `!collidesAt` 时，「解卡把玩家抬到半空又掉回世界底」也满足；
  //    只断言 y 时，「抬到一个仍被埋的高度」也满足。`moved` 是用户报告的那个症状本身
  //    （「动弹不得」），也是最直接的判据。
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const y0 = p.y;
    const x0 = p.x;
    // 手动驱动物理 30 步（面板未开、帧循环也在跑，这里再推一段确保有位移可读）
    for (let i = 0; i < 30; i++) { g.player.physics.move(1, 0); g.player.physics.step(1 / 60); }
    return {
      y: +y0.toFixed(2),
      stuck: g.player.physics.collidesAt(p.x, p.y, p.z),
      moved: +(p.x - x0).toFixed(2),
    };
  });
  expect(after.stuck, `解卡后不得仍与方块重叠（y=${after.y}）`).toBe(false);
  expect(after.y, `y 须远离世界底 -32（被埋时重力会一路掉到底），实测 ${after.y}`).toBeGreaterThan(-20);
  expect(after.moved, `玩家须真的能水平移动（「动弹不得」是用户报告的症状），实测 ${after.moved}`).toBeGreaterThan(1);
});

test('解卡：浅埋（下坠不到 1 格时 column 才 ready）也要抬出，且落点是整数地表', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?seed=12345');   // 默认视距：探针实测三个目标都会浅埋 1 格
  await page.waitForFunction(READY, null, { timeout: 90_000 });
  await page.waitForFunction(STABLE, null, { timeout: 60_000, polling: 500 });

  // 装计数器（只包一层，不改实现）：记录解卡是否真的被触发、抬了几格。
  // ⚠️ 这条断言是「解卡接线在不在」的判据 —— 只断言最终位置时，「根本没被埋所以没抬」
  //    与「被埋了并抬出来」读起来一样（探针实测三个目标都 raised=1，故这里要求 > 0）。
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.__stuckLog = [];
    const orig = g._resolvePlayerStuck.bind(g);
    g._resolvePlayerStuck = (col) => {
      const p = g.player.physics.pos;
      const wasStuck = g.player.physics.collidesAt(p.x, p.y, p.z);
      const raised = orig(col);
      if (raised !== 0 || wasStuck) g.__stuckLog.push({ raised: +raised.toFixed(3), wasStuck });
      return raised;
    };
  });

  // ⚠️ 「解卡必须真的被触发」只对**实测会浅埋的三个目标**成立（tarn / lake / 围场，
  // 探针实测都 raised=1）。大竞技场（v2.87）与废弃堡垒（v2.89）落在缘外自然地表，y 已是地表+1，
  // 不保证浅埋 ⇒ 对它们只钉「落地后不被埋」（用户报告的症状本身），不钉「必须触发过」。
  const MUST_RAISE = new Set(['teleportToTarnZone', 'teleportToShallowTarn', 'teleportToArena']);
  for (const fn of ['teleportToTarnZone', 'teleportToShallowTarn', 'teleportToArena', 'teleportToBurningArena', 'teleportToRuinedCitadel']) {
    await page.evaluate(() => { window.__MC_GAME__.__stuckLog = []; });
    const r = await page.evaluate((f) => window.__MC_GAME__[f](), fn);
    if (!r.ok) continue;   // 少数 seed 没有围场/湖/大竞技场/堡垒；本 seed 五个都有，跳过只是防御
    await page.waitForFunction(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      return g.world.hasColumn(Math.floor(p.x / 16), Math.floor(p.z / 16));
    }, null, { timeout: 120_000 });
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      return {
        y: p.y, stuck: g.player.physics.collidesAt(p.x, p.y, p.z),
        log: g.__stuckLog,
        // 落点必须是整数（`resolveStuck` 抬到整数 y，不过冲 → 无可见弹跳）
        isInt: Math.abs(p.y - Math.round(p.y)) < 1e-6,
      };
    });
    expect(state.stuck, `${fn}: 落地后不得被埋（y=${state.y}）`).toBe(false);
    if (MUST_RAISE.has(fn)) {
      expect(state.log.length, `${fn}: 解卡必须真的被触发过（探针实测这三个目标都浅埋 1 格）`).toBeGreaterThan(0);
    }
    expect(state.isInt, `${fn}: 解卡落点须是整数 y（不过冲、不弹跳），实测 ${state.y}`).toBe(true);
  }
});
