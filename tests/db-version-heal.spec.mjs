import { test, expect } from 'playwright/test';

// DB 版本自愈（Tier 1）：浏览器里残留**更高版本**的存档库时，旧代码 `indexedDB.open`
// 抛 VersionError → 启动 gate 把它显示成「浏览器不支持 WebGPU」→ 游戏白屏。
//
// 真实成因（2026-10 实测）：RedCity 分支把 DB_VERSION 提到 3 并按 D7 清库；切回未包含
// RedCity 的分支（声明 2）后，浏览器里那个 v3 库**还在**，git 回撤管不到浏览器状态 →
// 每次打开都 VersionError。场景用「先把库建成 v3」精确复现。
const DB = 'mc_heavy_saves';

async function seedDbAtVersion(page, version) {
  return page.evaluate(async ({ dbName, v }) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, v);
      req.onupgradeneeded = () => {
        const db = req.result;
        const spec = { meta: 'key', edits: 'columnKey', entities: 'id' };
        for (const [name, keyPath] of Object.entries(spec)) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
        }
      };
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    return (await indexedDB.databases()).map((d) => ({ name: d.name, version: d.version }));
  }, { dbName: DB, v: version });
}

test('启动自愈：残留更高版本的存档库不再白屏（VersionError）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const before = await seedDbAtVersion(page, 3);
  expect(before).toEqual([{ name: DB, version: 3 }]);

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__MC_BOOT__ && (window.__MC_BOOT__.rendererReady || window.__MC_BOOT__.error),
    null, { timeout: 90_000 },
  );

  const boot = await page.evaluate(() => window.__MC_BOOT__);
  const overlay = await page.evaluate(() => {
    const el = document.getElementById('webgpu-error');
    return el ? getComputedStyle(el).display : 'no-el';
  });
  // 症状层：渲染必须真的就绪，且不得弹出「浏览器不支持 WebGPU」的误导遮罩
  expect(boot.error).toBe(null);
  expect(boot.rendererReady).toBe(true);
  expect(overlay).toBe('none');
  expect(errors).toEqual([]);

  // 根因层：库版本必须已被重建到代码声明的版本（而不是靠「能打开」侥幸通过）
  const after = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const row = dbs.find((d) => d.name === 'mc_heavy_saves');
    return row ? row.version : null;
  });
  expect(after).toBe(2);
});

test('启动自愈不误伤：正常 v2 存档库重开仍可用且不被清空', async ({ page }) => {
  test.setTimeout(120_000);
  // 先正常启动一次（库里写入 seed meta），再 reload —— 若自愈逻辑误判「版本不符」
  // 就会在每次启动时清库，表现为「修改每次重启都丢」。
  await page.goto('/?vd=2');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const seedBefore = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.persistence.flushNow(g.world);
    return g.seed;
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const seedAfter = await page.evaluate(() => window.__MC_GAME__.seed);
  expect(seedAfter).toBe(seedBefore);

  const version = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.find((d) => d.name === 'mc_heavy_saves')?.version ?? null;
  });
  expect(version).toBe(2);
});
