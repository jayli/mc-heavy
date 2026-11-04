import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// tests/health-hud.spec.mjs — 生命系统显示层 E2E（用户 2026-11-05）
//
// 覆盖三条接线（全部是「漏接线就静默失效」型，单测拓不到）：
//   ① 玩家血心：10 颗心真的画出来（像素断言 —— `resourceUrl` 写错会静默 404 成全透明，
//      DOM 断言抓不到）、紧挨性能看板右侧；
//   ② 丧尸受击：头顶弹「掉血后还剩的血量」数字（武器/炮塔路径 `damageEntity` + TNT 路径
//      `_damageEntitiesInRadius` 两条伤害路径都要接）；
//   ③ Boss（飞龙）受击：同样弹数字。
//
// ⚠️ 伤害数字的**形式**是用户裁定的「浮动数字」（不是血条）：DOM 覆盖层零 draw call。
// 本 spec 断言的是「数字出现 + 内容 = 剩余血量 + 致命一击显示 0」，不断言像素位置
// （数字跟随移动实体，逐帧位置不稳定；位置正确性由冒烟期实测确认）。
//
// ⚠️ **打数字前必须先瞄准目标**（实测踩坑）：`projectFn` 对相机**背后**的点返回 null
// （数字刻意隐藏，防镜像假坐标）。`spawnZombieNearPlayer()` 生成的丧尸落点随机，可能恰好在
// 玩家身后 ⇒ 不瞄准就读 `#mc-damage-numbers` 会拿到空数组（假失败）。故每条伤害用例都先
// `setTestAim` 把相机转向目标 —— 这也更贴近真实路径（玩家打的是自己看着的东西）。

const SEED = 12345;

async function boot(page, query = '') {
  await page.goto(`/?vd=4&seed=${SEED}${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 等血心的 10 张图全部加载完成（异步解码；截图断言的前提） */
async function waitHeartsLoaded(page) {
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('#mc-health img');
    return imgs.length === 10 && [...imgs].every((i) => i.complete && i.naturalWidth === 9);
  }, null, { timeout: 15_000 });
}

/** 读当前可见的伤害数字文本（`display:none` 的不算 —— 相机背后时刻意隐藏） */
const VISIBLE_NUMBERS = () => [...document.querySelectorAll('#mc-damage-numbers div')]
  .filter((d) => d.style.display !== 'none').map((d) => d.textContent);

test('玩家血心：10 颗红心真的画出来（像素断言）且紧挨性能看板右侧', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await waitHeartsLoaded(page);

  const m = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const health = document.getElementById('mc-health');
    const perf = g._hud.el.getBoundingClientRect();
    const hr = health.getBoundingClientRect();
    const imgs = [...health.querySelectorAll('img')];
    return {
      count: imgs.length,
      srcs: imgs.map((i) => i.src.split('/').pop()),
      sizes: imgs.map((i) => [i.getBoundingClientRect().width, i.getBoundingClientRect().height]),
      pixelated: imgs.every((i) => getComputedStyle(i).imageRendering === 'pixelated'),
      zIndex: getComputedStyle(health).zIndex,
      gap: hr.left - perf.right,
      top: hr.top, perfTop: perf.top,
      hudHearts: g._healthHud.hearts(),
    };
  });

  expect(m.count, '必须恰好 10 颗心').toBe(10);
  expect(m.srcs, '满血 = 10 张红心图').toEqual(Array(10).fill('heart.png'));
  expect(m.hudHearts, 'HUD 内部状态 = 全满').toEqual(Array(10).fill('full'));
  for (const [w, h] of m.sizes) {
    expect(w, '显示宽 = 18px（9px 源图 × 2 整数倍）').toBeCloseTo(18, 0);
    expect(h, '显示高 = 18px').toBeCloseTo(18, 0);
  }
  expect(m.pixelated, '像素风放大必须 pixelated（否则描边发糊）').toBe(true);
  expect(m.zIndex, '血心与性能/坐标面板同层（50）').toBe('50');
  // 「紧挨性能看板右侧」：左缘 = 看板右缘 + 8px 间距（perf-hud left:8 + 宽 330 + 8 = 346）
  expect(m.gap, '血心左缘与看板右缘的间距应为 8px').toBeGreaterThan(6);
  expect(m.gap).toBeLessThan(10);
  expect(m.top, '与看板同高（top:8px）').toBeCloseTo(m.perfTop, 0);

  // ---- 像素断言：心形真的画出来了（404 → 全透明，DOM 断言抓不到）----
  // 素材是红心（255,19,19）+ 黑描边：数裁剪区内的偏红像素。10 颗心 × 每颗 ~26 红像素
  // × 4 倍面积（2× 放大）≈ 1000+，取 200 作下界（留足世界背景偶然红色的余量）。
  const hr = await page.evaluate(() => {
    const r = document.getElementById('mc-health').getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) };
  });
  const png = PNG.sync.read(await page.screenshot());
  let red = 0;
  for (let y = hr.y; y < hr.y + hr.h; y += 1) {
    for (let x = hr.x; x < hr.x + hr.w; x += 1) {
      const i = (png.width * y + x) * 4;
      if (png.data[i] > 150 && png.data[i + 1] < 90 && png.data[i + 2] < 90) red += 1;
    }
  }
  expect(red, `血心行内偏红像素必须足够多（实测 ${red}）—— 0 说明图片 404 或没画`).toBeGreaterThan(200);
});

test('玩家血量当前恒为满血 20（掉血逻辑未接入，用户后续添加）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const hp = await page.evaluate(() => window.__MC_GAME__.player.health);
  expect(hp, '当前阶段血量权威 = 满血 20').toBe(20);
});

test('丧尸受击：头顶弹「剩余血量」数字，致命一击显示 0', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const visible = () => [...document.querySelectorAll('#mc-damage-numbers div')]
      .filter((d) => d.style.display !== 'none').map((d) => d.textContent);
    // ⚠️ `spawnZombieNearPlayer()` 返回 `{spawned, position, attempts, count}`，
    // `spawned` 才是 id（audio-fx.spec.mjs 同源注释：读错字段会静默跳过）。
    const res = g.spawnZombieNearPlayer();
    if (!res.spawned) return { skipped: true, attempts: res.attempts, count: res.count };
    const id = res.spawned;
    // ⚠️ 先把相机转向丧尸（否则它可能在身后 → 数字被隐藏 → 假失败）
    const [zx, zy, zz] = g.zombies.get(id).position;
    const cam = g.camera.position.toArray();
    g.player.setTestAim([zx - cam[0], zy + 0.9 - cam[1], zz - cam[2]]);
    // ① 非致命：打 30 → 剩 70
    const hit = g.damageEntity(id, 30, performance.now());
    for (let i = 0; i < 3; i += 1) await new Promise((rr) => requestAnimationFrame(rr));
    const afterHit = visible();
    // ①b 机枪连射（用户 2026-11-05 追加裁定）：同一实体的新数字直接顶掉旧的未消失数字，
    //     任何时刻头顶至多一个数字 —— 否则连射时数字叠在一起不可读。
    for (let i = 0; i < 5; i += 1) g.damageEntity(id, 5, performance.now());
    for (let i = 0; i < 3; i += 1) await new Promise((rr) => requestAnimationFrame(rr));
    const afterRapid = visible();
    // ② 致命：剩余血量归 0，实体同帧 despawn —— 数字仍要出现（冻结在死亡位置）
    const lethal = g.damageEntity(id, 100000, performance.now());
    for (let i = 0; i < 3; i += 1) await new Promise((rr) => requestAnimationFrame(rr));
    const afterLethal = visible();
    return { hitHealth: hit?.health, lethalDead: lethal?.dead, afterHit, afterRapid, afterLethal };
  });

  expect(r.skipped ?? false,
    `丧尸生成失败（attempts=${r.attempts}, count=${r.count}）`).toBe(false);
  expect(r.hitHealth, '前置：掉血后剩 70').toBe(70);
  expect(r.afterHit, '受击后必须弹出数字，内容 = 剩余血量 70').toContain('70');
  // 连射 5 次（70 → 45）后：至多一个数字，且是最新的剩余血量
  expect(r.afterRapid.length, '连射后同一实体头顶至多一个数字（不得叠加）').toBeLessThanOrEqual(1);
  expect(r.afterRapid, '显示的是最新的剩余血量 45').toContain('45');
  expect(r.lethalDead, '前置：致死伤害').toBe(true);
  expect(r.afterLethal, '致命一击显示 0（实体已 despawn，数字冻结在死亡位置）').toContain('0');
});

test('TNT 半径伤害路径也弹数字（_damageEntitiesInRadius 与 damageEntity 同口径）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const res = g.spawnZombieNearPlayer();
    if (!res.spawned) return { skipped: true };
    const id = res.spawned;
    const [px, py, pz] = g.zombies.get(id).position;
    // ⚠️ 先瞄准（同「丧尸受击」用例：防身后落点 → 数字被隐藏 → 假失败）
    const cam = g.camera.position.toArray();
    g.player.setTestAim([px - cam[0], py + 0.9 - cam[1], pz - cam[2]]);
    // 直接调半径伤害入口（TNT 到期回调走的就是它）—— 本用例测的是「这条路径接了显示」，
    // TNT 引信机制本身由 tnt.spec.mjs 覆盖，不在这里重复。
    g._damageEntitiesInRadius([px, py, pz], 10, 25, performance.now());
    for (let i = 0; i < 3; i += 1) await new Promise((rr) => requestAnimationFrame(rr));
    const texts = [...document.querySelectorAll('#mc-damage-numbers div')]
      .filter((d) => d.style.display !== 'none').map((d) => d.textContent);
    return { health: g.zombies.get(id)?.health ?? null, texts };
  });

  expect(r.skipped ?? false, '丧尸生成失败').toBe(false);
  expect(r.health, '前置：半径伤害生效，剩 75').toBe(75);
  expect(r.texts, 'TNT 路径必须弹数字，内容 = 剩余血量 75').toContain('75');
});

test('Boss（飞龙）受击：头顶弹「剩余血量」数字', async ({ page }) => {
  test.setTimeout(180_000);
  // 龙在祭坛地带召唤（dragon.spec.mjs 同源：seed 12345 的祭坛在 region(2,0)）
  await page.goto(`/?vd=8&seed=${SEED}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const c = await page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const a = findAltarTarnRegion(window.__MC_GAME__.seed);
    return a ? { cx: a.cx, cz: a.cz } : null;
  });
  expect(c, '前置：seed 12345 必须有祭坛地带').not.toBeNull();

  // 传送到祭坛中心上空并等 column 加载，然后按 C 召唤（真实键盘事件路径）
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [c.cx, c.cz]);
  await page.waitForFunction(([x, z]) =>
    window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
  [c.cx, c.cz], { timeout: 30_000 });
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', repeat: false, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC', bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() =>
    (window.__MC_GAME__.dragons?.activeEntities().length ?? 0) >= 1, null, { timeout: 15_000 });

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const e = g.dragons.activeEntities()[0];
    const maxHp = e.state.health;
    // ⚠️ 龙在轨道上飞，可能恰好在玩家身后 → 先瞄准（同丧尸用例）
    const [dx, dy, dz] = e.state.position;
    const cam = g.camera.position.toArray();
    g.player.setTestAim([dx - cam[0], dy - cam[1], dz - cam[2]]);
    const hit = g.damageEntity(e.id, 100, performance.now());
    for (let i = 0; i < 3; i += 1) await new Promise((rr) => requestAnimationFrame(rr));
    const texts = [...document.querySelectorAll('#mc-damage-numbers div')]
      .filter((d) => d.style.display !== 'none').map((d) => d.textContent);
    return { maxHp, hitHealth: hit?.health, texts };
  });

  expect(r.hitHealth, '前置：龙掉血后剩 maxHp-100').toBe(r.maxHp - 100);
  expect(r.texts, `Boss 受击必须弹数字，内容 = 剩余血量 ${r.maxHp - 100}`)
    .toContain(String(r.maxHp - 100));
});
