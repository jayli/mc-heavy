// RedCity E2E（真实页面）：出生点 / Worker 接线 / 全局下发 / ?spawn=city / DB 升级（D7）
//
// 这些用例都落在「玩家实际会走的路径」上，而不是只调测试 API（CLAUDE.md M7 教训：E2E 全绿却漏了背包放置缺陷）：
//  - Worker 接线：断言的是主线程 `world` 里的**方块**（经 GEN→Worker→回包→接管），不是 `getRedCityData()` 的内存模型；
//  - 全局下发：影响域越过 x=799 的 seed，断言 x>799 的 core 列确实是 RedCity（全深度 clay），不是被截成自然地形。
import { test, expect } from 'playwright/test';

const SEED = 12345;

async function boot(page, query = '') {
  await page.goto(`/?vd=8&seed=${SEED}&style=noon&weather=clear${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && s.lightInflight === 0;
  }, null, { timeout: 120_000 });
}

/** 悬停到 (x, 70, z)（不依赖物理）并等该处 column 就绪 */
async function hoverAt(page, x, z) {
  await page.evaluate(([x, z]) => {
    const g = window.__MC_GAME__; clearInterval(g._hover);
    g.player.spawn(x, 70, z); g._hover = setInterval(() => g.player.spawn(x, 70, z), 50);
  }, [x, z]);
  await page.waitForFunction(([cx, cz]) => window.__MC_GAME__.world.hasColumn(cx, cz), [Math.floor(x / 16), Math.floor(z / 16)], { timeout: 60_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && s.lightInflight === 0;
  }, null, { timeout: 120_000 });
}

test('出生点：在 RedCity core 内，脚下 solid、头顶 24 格全空，且与产物 spawn 一致', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const rc = g.scheduler.structureIndex.redCity();
    const { ox, oz, dy } = g.redCityModel.spawn;
    const x = Math.floor(g.spawnX), y = Math.floor(g.spawnY), z = Math.floor(g.spawnZ);
    let airAbove = 0;
    for (let k = 0; k < 24; k++) if (g.world.getBlockId(x, y + k, z) === 0) airAbove++;
    return {
      spawn: [g.spawnX, g.spawnY, g.spawnZ], core: rc.core, baseY: rc.baseY, spawnLocal: { ox, oz, dy },
      inCore: x >= rc.core.minX && x <= rc.core.maxX && z >= rc.core.minZ && z <= rc.core.maxZ,
      belowSolid: g.registry.solidTable[g.world.getBlockId(x, y - 1, z)] === 1,
      airAbove,
    };
  });
  expect(r.inCore, `出生点 ${JSON.stringify(r.spawn)} 须在 core ${JSON.stringify(r.core)} 内`).toBe(true);
  expect(r.belowSolid, '脚下一格 solid').toBe(true);
  expect(r.airAbove, '头顶 24 格（含脚所在格）全空').toBe(24);
  // 与产物一致：x/z = 烘焙列的方块中心；y = 站立位 = baseY + dy + 1（dy 是行号，不是相对该列地面的偏移）
  expect(r.spawn[0]).toBe(r.core.minX + r.spawnLocal.ox + 0.5);
  expect(r.spawn[2]).toBe(r.core.minZ + r.spawnLocal.oz + 0.5);
  expect(r.spawn[1]).toBe(r.baseY + r.spawnLocal.dy + 1);
});

test('Worker 接线：烘焙方块逐格出现在世界里（世界 y = baseY + dy）——出生列 + 出生点附近三根「高柱」', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const mod = await import('/src/gen/structures/redcity-data.js');
    const rc = g.scheduler.structureIndex.redCity();
    const model = g.redCityModel;
    const countOf = (ox, oz) => { let n = 0; mod.forEachRedCityBlock(model, ox, oz, () => { n++; }); return n; };
    // 出生列地面之上全空（出生点的判据），只有 K=2 层岛面；要验证「建筑/树冠」也落地，须再挑几根内容多的列：
    // 以出生列为中心 ±60 格内按 (oz, ox) 扫描，取前三根方块数 ≥ 20 的列（确定性）
    const tall = [];
    for (let oz = model.spawn.oz - 60; oz <= model.spawn.oz + 60 && tall.length < 3; oz++) {
      for (let ox = model.spawn.ox - 60; ox <= model.spawn.ox + 60 && tall.length < 3; ox++) if (countOf(ox, oz) >= 20) tall.push([ox, oz]);
    }
    const out = [];
    // 比的是**主线程 world**（GEN→Worker→回包→接管）而不是内存模型
    for (const [ox, oz] of [[model.spawn.ox, model.spawn.oz], ...tall]) {
      let total = 0, matched = 0; const bad = [];
      mod.forEachRedCityBlock(model, ox, oz, (dy, name) => {
        total++;
        const id = g.world.getBlockId(rc.core.minX + ox, rc.baseY + dy, rc.core.minZ + oz);
        if (id === g.registry.idOf(name)) matched++; else if (bad.length < 3) bad.push({ dy, name, got: g.registry.nameOf(id) });
      });
      out.push({ ox, oz, total, matched, bad });
    }
    return out;
  });
  expect(r.length, '出生列 + 3 根高柱').toBe(4);
  expect(r[0].total, '出生列至少有烘焙出的岛面方块').toBeGreaterThanOrEqual(1);
  for (const c of r.slice(1)) expect(c.total, `高柱 (${c.ox},${c.oz}) 方块数（防止「没有数据」时恒真）`).toBeGreaterThanOrEqual(20);
  for (const c of r) expect(c.matched, `列 (${c.ox},${c.oz}) 烘焙方块未全部落地：${JSON.stringify(c.bad)}`).toBe(c.total);
});

test('全局下发：影响域越过 x=799 的 seed，x>799 的 core 列仍是 RedCity（全深度 clay），不是被截成自然地形', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const rc = await page.evaluate(() => window.__MC_GAME__.scheduler.structureIndex.redCity());
  // 前置：seed=12345 的 core 东缘 840 > 799（若 seed/几何变了使其不越界，本用例会失去意义，宁可在这里响）
  expect(rc.core.maxX, '前置：core 必须越过 3×3 查询域的东界 x=799').toBeGreaterThan(799);
  const x = 830, z = rc.core.minZ + 141;   // core 东部，x>799
  await hoverAt(page, x + 0.5, z + 0.5);
  const r = await page.evaluate(([x, z]) => {
    const g = window.__MC_GAME__; const clay = g.registry.idOf('clay');
    // core 全深度实心 clay：取 y=-10（自然地形该处是石头/洞穴，绝不会是整列 clay）
    let clayCount = 0, n = 0;
    for (let dz = -6; dz <= 6; dz += 3) for (let dx = -6; dx <= 6; dx += 3) { n++; if (g.world.getBlockId(x + dx, -10, z + dz) === clay) clayCount++; }
    return { clayCount, n, colLoaded: g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)) };
  }, [x, z]);
  expect(r.colLoaded).toBe(true);
  expect(r.clayCount, 'x>799 的 core 列在 y=-10 应全是 clay（被截成自然地形时这里是 stone）').toBe(r.n);
});

test('?spawn=city：出生在 City 中心（调试入口，供语义绑定 City 环境的 spec / bench pin 住原环境）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&spawn=city');
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const l = g.scheduler.structureIndex._layouts.get('0,0');
    const castle = l.city.placements.find((p) => p.type === 'castle');
    return { spawn: [g.spawnX, g.spawnZ], castle: castle && [castle.x, castle.z], rc: l.redCity.core };
  });
  expect(r.spawn).toEqual(r.castle);
  expect(r.spawn[0] < r.rc.minX, 'City 中心在 RedCity core 之西').toBe(true);
});

test('产物 fetch 失败 = 启动失败（loud）：redcity.json 返回 404 时页面显示「启动失败」并给出原因，不进游戏', async ({ page }) => {
  test.setTimeout(60_000);
  // 缺了它 RedCity 的位置会静默变成一片平地（降级路径）——这是最难发现的失效形态，所以 fetch 失败不降级，直接让启动失败
  await page.route('**/assets/redcity/redcity.json', (r) => r.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_BOOT__ && window.__MC_BOOT__.error, null, { timeout: 45_000 });
  const r = await page.evaluate(() => ({
    err: window.__MC_BOOT__.error,
    shown: getComputedStyle(document.getElementById('webgpu-error')).display,
    detail: document.getElementById('webgpu-error-detail').textContent,
    entered: !!window.__MC_GAME__,
  }));
  expect(r.err, '错误原因必须指向 redcity.json 与 HTTP 状态（而不是下游的 JSON 解析错误）').toMatch(/redcity\.json 加载失败：HTTP 404/);
  expect(r.shown).toBe('flex');
  expect(r.detail).toContain('启动失败');
  expect(r.entered, '不得进入游戏').toBe(false);
});

// ---------------------------------------------------------------- D7：DB 升级清库

/** 在空白同源页里准备一个旧版本库（v1 无 entities store），塞入数据后关闭 */
const seedOldDb = (page, version) => page.evaluate(async (version) => {
  localStorage.setItem('mc-heavy-settings-probe', 'keep-me');
  await new Promise((res) => { const r = indexedDB.deleteDatabase('mc_heavy_saves'); r.onsuccess = r.onerror = r.onblocked = res; });
  await new Promise((res, rej) => {
    const r = indexedDB.open('mc_heavy_saves', version);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('edits', { keyPath: 'columnKey' });
      if (version >= 2) db.createObjectStore('entities', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const db = r.result; const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readwrite');
      tx.objectStore('meta').put({ key: 'main', seed: 777, spawn: [8, 8] });
      tx.objectStore('edits').put({ columnKey: '0,0', edits: [{ index: 1, id: 2, meta: 0 }] });
      if (names.includes('entities')) tx.objectStore('entities').put({ id: 'e1', type: 'minecart', state: {} });
      tx.oncomplete = () => { db.close(); res(); };
    };
    r.onerror = () => rej(r.error);
  });
}, version);

const openAndCount = (page) => page.evaluate(async () => {
  const { Persistence } = await import('/src/save/persistence.js');
  const p = new Persistence();
  await p.open();
  const count = (n) => new Promise((res) => { const r = p.db.transaction(n).objectStore(n).count(); r.onsuccess = () => res(r.result); });
  const out = {
    version: p.db.version, stores: [...p.db.objectStoreNames].sort(),
    meta: await count('meta'), edits: await count('edits'), entities: await count('entities'),
    loadMeta: await p.loadMeta(), ls: localStorage.getItem('mc-heavy-settings-probe'),
  };
  p.db.close();
  return out;
});

for (const from of [2, 1]) {
  test(`D7：v${from} 库升级到 v3 时清空 meta/edits/entities；localStorage 设置不动`, async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto('/package.json');   // 空白同源页（只要同源即可共享 IndexedDB/localStorage）
    await seedOldDb(page, from);
    const out = await openAndCount(page);
    expect(out.version).toBe(3);
    expect(out.stores).toEqual(['edits', 'entities', 'meta']);
    expect([out.meta, out.edits, out.entities], '三个 store 升级后必须全空').toEqual([0, 0, 0]);
    expect(out.loadMeta, '等价于全新世界：loadMeta 返回 null → 走 !hadMeta 分支').toBeNull();
    expect(out.ls, '设置在 localStorage，不属于存档').toBe('keep-me');
  });
}

test('D7：已是 v3 的库再次打开不清空（升级只在 oldVersion<3 时发生）', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/package.json');
  const m = await page.evaluate(async () => {
    const { Persistence } = await import('/src/save/persistence.js');
    await new Promise((res) => { const r = indexedDB.deleteDatabase('mc_heavy_saves'); r.onsuccess = r.onerror = r.onblocked = res; });
    const a = new Persistence(); await a.open(); await a.saveMeta({ seed: 5, spawn: [1, 1] }); a.db.close();
    const b = new Persistence(); await b.open(); const meta = await b.loadMeta(); b.db.close();
    return meta;
  });
  expect(m && m.seed).toBe(5);
});

test('D7：旧版本连接未关闭时升级被阻塞 → 触发 onBlocked 回调；旧连接关闭后升级自动完成', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/package.json');
  await seedOldDb(page, 2);
  const out = await page.evaluate(async () => {
    const { Persistence } = await import('/src/save/persistence.js');
    // 模拟「另一个 mc-heavy 旧标签页」：开着 v2 连接且不响应 versionchange
    const old = await new Promise((res, rej) => { const r = indexedDB.open('mc_heavy_saves', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    let blocked = false;
    const p = new Persistence();
    const opened = p.open({ onBlocked: () => { blocked = true; setTimeout(() => old.close(), 50); } });   // 提示后用户关掉了旧页
    // 竞速超时：缺陷（没有 onblocked）时 open 会一直挂着——5s 内判失败，而不是拖到测试超时
    const r = await Promise.race([opened.then(() => 'ok'), new Promise((res) => setTimeout(() => res('timeout'), 5000))]);
    if (r === 'timeout') { old.close(); return { blocked, version: null }; }
    const version = p.db.version; p.db.close();
    return { blocked, version };
  });
  expect(out.blocked, '升级被旧连接阻塞时必须告知（否则玩家看到的是无报错白屏）').toBe(true);
  expect(out.version).toBe(3);
});
