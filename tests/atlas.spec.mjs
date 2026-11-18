import { test, expect } from 'playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// 分级策略见 docs/testing-policy.md §3.2：本 spec 的断言分两类。
//
// ① **设计常量**（size=2048 / gutter=16）→ 保留硬编码。判据：这是「设计决策」不是
//    「事实统计」，改了就是改了设计，应当停下来报告（CLAUDE.md 规则条）。
// ② **事实统计**（tile 数 / procCount / iconCount）→ 关系型断言，与 assets/textures
//    的实际 PNG 数比对。取代旧的 `toBe(156)`/`toBe(23)`/`toBe(9)`——那是「改动放大器」：
//    新增一张贴图就要改 spec + CLAUDE.md + 设计文档三处（同一事实的三个副本，违反红线 1）。
//    关系式下新增贴图**不用改断言**，而 atlas 漏 tile / PNG 漏打包会当场报错。

/** assets/textures 下某前缀的 PNG 数（= 该前缀应有的 tile 数） */
function pngCount(prefix) {
  const dir = path.join(process.cwd(), 'assets', 'textures', prefix);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length;
}

test('atlas 覆盖全部纹理 PNG 且 UV 合法（关系型断言，取代硬编码计数）', async ({ page }) => {
  // 只为同源 fetch（v3.15 改空白夹具页）—— 原先 goto index.html 会触发整页 2400+ 例，
  // 而本用例只需要一个能 `fetch('/assets/atlas.json')` 的同源页面。
  // 实测两侧 fetch 结果逐位相同（tiles 174 / size 2048），而就绪 19ms vs 147723ms。
  await page.goto('/src/tests/fixture-blank.html');
  const report = await page.evaluate(async () => {
    const meta = await (await fetch('/assets/atlas.json')).json();
    const names = Object.keys(meta.tiles);
    const bad = names.filter((n) => {
      const t = meta.tiles[n];
      return !(t.u0 < t.u1 && t.v0 < t.v1 &&
               t.u0 >= 0 && t.u1 <= 1 && t.v0 >= 0 && t.v1 <= 1);
    });
    // 抽查关键 tile 存在（含 M2-5 水纹理）——防关键纹理被误删（Tier 2 抽查，可随事实更新）
    const need = ['stone', 'dirt', 'grass_carried', 'Bedrock', 'Glowstone',
                  'Glass', 'bed/Bed_(top_texture)_JE1_BE1', 'water', 'swamp_water'];
    // 程序化烘焙贴图（tools/bake-procedural-textures.mjs，复刻 mc-lite canvas 材质）
    const procNeed = ['procedural/vine', 'procedural/flower', 'procedural/lilypad',
                      'procedural/marble', 'procedural/cactus', 'procedural/handrail',
                      'procedural/pillar', 'procedural/chimney', 'procedural/hanging_lamp',
                      'procedural/sky_stone', 'procedural/sky_grass'];
    const missing = [...need, ...procNeed].filter((n) => !meta.tiles[n]);
    const procCount = names.filter((n) => n.startsWith('procedural/')).length;
    const iconCount = names.filter((n) => n.startsWith('inventory-icons/')).length;
    return { count: names.length, procCount, iconCount, bad, missing, size: meta.size, gutter: meta.gutter };
  });

  // ② 关系型：atlas tile 数 ≡ assets/textures 下的 PNG 总数（build-atlas.mjs 的契约：
  //    每张 PNG 打成一个 tile）。新增贴图自动跟上，atlas 漏 tile / PNG 漏打包当场报错。
  expect(report.count).toBe(pngCount('.') + pngCount('procedural') + pngCount('inventory-icons') + pngCount('bed'));
  expect(report.procCount).toBe(pngCount('procedural'));
  // 防「改了 mesher 几何只跑 npm run icons 忘跑 npm run atlas」→ PNG 存在但 atlas 未更新
  // → 图标静默过期（渲染旧形状，肉眼看不出）。tools/check-data.mjs 的 [3] 也钉同一失效路径。
  expect(report.iconCount).toBe(pngCount('inventory-icons'));

  // ① UV 合法性是**不变式**（Tier 1 级）：任何 tile 的 UV 必须落在 [0,1] 且 u0<u1/v0<v1。
  //    非法 UV 会让块面采样到相邻 tile（块缝粉灰线，v1.9 踩过），不得放宽。
  expect(report.bad).toEqual([]);
  expect(report.missing).toEqual([]);
  // ① 设计常量（§4.4.1 定稿）：改了就是改了设计，须停下来报告而非静默放宽。
  expect(report.size).toBe(2048);
  expect(report.gutter).toBe(16); // mipmap 档 mip 足迹防护（每侧 8px bleed 填满）
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

test('atlas blur 档位（§4.4.1 提前落地）：默认关 mipmap，?blur=1 开三线性 mipmap', async ({ page }) => {
  // 默认档：像素风，无 mipmap
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const def = await page.evaluate(async () => {
    const THREE = await import('three');
    const t = window.__MC_GAME__._atlasTexture;
    return { gen: t.generateMipmaps, min: t.minFilter, mag: t.magFilter,
             nearest: THREE.NearestFilter, mipmapLinear: THREE.LinearMipmapLinearFilter };
  });
  expect(def.gen).toBe(false);
  expect(def.min).toBe(def.nearest);
  expect(def.mag).toBe(def.nearest);

  // ?blur=1：远处莫尔纹档位，开 mipmap；magFilter 仍 Nearest 保近处像素风
  await page.goto('/?blur=1');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const blur = await page.evaluate(async () => {
    const THREE = await import('three');
    const t = window.__MC_GAME__._atlasTexture;
    return { gen: t.generateMipmaps, min: t.minFilter, mag: t.magFilter,
             nearest: THREE.NearestFilter, mipmapLinear: THREE.LinearMipmapLinearFilter };
  });
  expect(blur.gen).toBe(true);
  expect(blur.min).toBe(blur.mipmapLinear);
  expect(blur.mag).toBe(blur.nearest);
});
