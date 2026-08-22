import { test, expect } from 'playwright/test';

test('atlas 覆盖 mc-lite 全部 122 张纹理 + M2 水纹理 + 程序化烘焙贴图且 UV 合法', async ({ page }) => {
  await page.goto('/src/tests/index.html'); // 任意页面，只为同源 fetch
  const report = await page.evaluate(async () => {
    const meta = await (await fetch('/assets/atlas.json')).json();
    const names = Object.keys(meta.tiles);
    const bad = names.filter((n) => {
      const t = meta.tiles[n];
      return !(t.u0 < t.u1 && t.v0 < t.v1 &&
               t.u0 >= 0 && t.u1 <= 1 && t.v0 >= 0 && t.v1 <= 1);
    });
    // 抽查关键 tile 存在（含 M2-5 水纹理）
    const need = ['stone', 'dirt', 'grass_carried', 'Bedrock', 'Glowstone',
                  'Glass', 'bed/Bed_(top_texture)_JE1_BE1', 'water', 'swamp_water'];
    // 程序化烘焙贴图（tools/bake-procedural-textures.mjs，复刻 mc-lite canvas 材质）
    const procNeed = ['procedural/vine', 'procedural/flower', 'procedural/lilypad',
                      'procedural/marble', 'procedural/cactus', 'procedural/handrail',
                      'procedural/pillar', 'procedural/chimney', 'procedural/hanging_lamp'];
    const missing = [...need, ...procNeed].filter((n) => !meta.tiles[n]);
    const procCount = names.filter((n) => n.startsWith('procedural/')).length;
    return { count: names.length, procCount, bad, missing, size: meta.size, gutter: meta.gutter };
  });
  // 124（mc-lite 122 张 + 水×2）+ 21 程序化烘焙 = 145
  expect(report.count).toBe(145);
  expect(report.procCount).toBe(21);
  expect(report.bad).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.size).toBe(2048);
  expect(report.gutter).toBe(2);
});

test('atlas 纹理可被 three 加载（WebGPU 环境）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const ok = await page.evaluate(async () => {
    const { loadAtlas } = await import('/src/mesh/atlas-loader.js');
    const { texture, tileRect } = await loadAtlas();
    const r = tileRect('stone');
    return texture.image.width === 2048 && r.u1 > r.u0;
  });
  expect(ok).toBe(true);
});
