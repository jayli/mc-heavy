// tests/fireball-render.spec.mjs — 飞龙火球 Tier 4 像素实测（v2.44）
//
// **为什么必须像素实测**：火球的颜色与球体轮廓在 GPU 求值，单测读不到片元输出
// （testing-policy §5.1）。单测能钉住「材质是 MeshBasicMaterial、颜色常量是 0xff6a00」，
// 但钉不住「GPU 真的画出了一团橙红色的球」—— 例如 `visible` 门控写反、实例矩阵全零、
// 或 InstancedMesh 的包围球被误剔除，单测全绿而画面里什么都没有。
//
// 场景：黑背景隔离（fixture `test-fireball-render.html`），相机正对原点。
//
// ⚠️ **判据必须带噪声底对照**（AGENTS.md「写这类 Tier 4 用例前先测噪声底」）：
// 先量「空场景」的火焰色像素数（应为 0），再量「有火球」的（应显著 > 0）。
// 只钉「有火球时 > 阈值」会在「渲染器根本没画」时假失败，也会在「阈值定太低」时假通过。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 火焰色像素占比：R 显著高于 G 与 B（橙红 0xff6a00 经 ACES 后仍是 R>G>B） */
function flameRatio(png, minR = 120, minDelta = 25) {
  let hit = 0, total = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    total++;
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r >= minR && r - g >= minDelta && r - b >= minDelta) hit++;
  }
  return hit / total;
}

/** 非黑像素占比（画面里到底有没有东西） */
function nonBlackRatio(png, threshold = 20) {
  let hit = 0, total = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    total++;
    if (png.data[i] > threshold || png.data[i + 1] > threshold || png.data[i + 2] > threshold) hit++;
  }
  return hit / total;
}

/** 画面中心的平均 RGB */
function centerRGB(png, r = 6) {
  const cx = Math.floor(png.width / 2), cy = Math.floor(png.height / 2);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n };
}

async function setup(page) {
  await page.setViewportSize({ width: 320, height: 240 });
  await page.goto('/src/tests/test-fireball-render.html');
  await page.waitForFunction(
    () => window.__FB_READY__ === true || window.__FB_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__FB_ERROR__);
  expect(err, `fixture 加载失败: ${err}`).toBeUndefined();
}

async function shot(page, opts) {
  const info = await page.evaluate((o) => window.__FB_RENDER__(o), opts);
  const buf = await page.screenshot();
  return { png: PNG.sync.read(buf), info };
}

test('火球 Tier 4：fixture 前提（池容量/几何/材质口径）', async ({ page }) => {
  await setup(page);
  const info = await page.evaluate(() => window.__FB_INFO__);
  expect(info.maxActive).toBe(info.poolSize);
  expect(info.meshCount).toBe(info.poolSize);
  expect(info.geometryType).toBe('SphereGeometry');
  expect(info.radius).toBeGreaterThan(0);
  expect(info.isBasic).toBe(true);
  expect(info.colorHex).toBe(0xff6a00);
  expect(info.visibleAtStart, '构造后必须隐藏（draw call 归零）').toBe(false);
});

test('火球 Tier 4：空场景噪声底为 0，有火球时出现火焰色像素', async ({ page }) => {
  await setup(page);
  // ① 噪声底：空场景（count=0）
  const empty = await shot(page, { count: 0 });
  expect(empty.info.slots, 'sanity：空场景不得分配 slot').toBe(0);
  expect(empty.info.visible, 'sanity：空场景必须 visible=false').toBe(false);
  const baseFlame = flameRatio(empty.png);
  const baseNonBlack = nonBlackRatio(empty.png);
  expect(baseFlame, `噪声底必须为 0（实测 ${baseFlame}）`).toBe(0);
  expect(baseNonBlack, `空场景必须全黑（实测 ${baseNonBlack}）`).toBe(0);

  // ② 有火球：火焰色像素显著出现
  const one = await shot(page, { count: 1 });
  expect(one.info.slots).toBe(1);
  expect(one.info.visible, '有火球必须提交渲染').toBe(true);
  const flame = flameRatio(one.png);
  expect(flame, `火球必须画出火焰色像素（噪声底 ${baseFlame}）`).toBeGreaterThan(0.002);
  expect(nonBlackRatio(one.png)).toBeGreaterThan(0.002);

  // ③ 颜色口径：画面中心偏橙红（R > G > B）
  const c = centerRGB(one.png);
  expect(c.r, `中心 R=${c.r.toFixed(1)} G=${c.g.toFixed(1)} B=${c.b.toFixed(1)}`).toBeGreaterThan(c.g);
  expect(c.g).toBeGreaterThan(c.b);
  expect(c.r).toBeGreaterThan(150);
});

test('火球 Tier 4：火球消失后画面回到全黑（slot 归还 + visible 门控真的生效）', async ({ page }) => {
  await setup(page);
  const one = await shot(page, { count: 1 });
  expect(flameRatio(one.png)).toBeGreaterThan(0.002);
  // 清空 → 画面必须逐位回到空场景（否则说明 slot 没归还 / visible 没回落）
  const empty1 = await shot(page, { count: 0 });
  const empty2 = await shot(page, { count: 0 });
  expect(empty1.info.visible).toBe(false);
  expect(flameRatio(empty1.png), '火球消失后不得残留火焰色像素').toBe(0);
  expect(nonBlackRatio(empty1.png), '火球消失后画面必须全黑').toBe(0);
  // 两次空场景逐位相同（sanity：截图路径本身是确定的）
  expect(Buffer.compare(empty1.png.data, empty2.png.data)).toBe(0);
});

test('火球 Tier 4：多颗火球各自成球（不重叠成一团）', async ({ page }) => {
  await setup(page);
  const one = await shot(page, { count: 1 });
  const three = await shot(page, { count: 3, offset: 3 });
  expect(three.info.slots).toBe(3);
  const f1 = flameRatio(one.png);
  const f3 = flameRatio(three.png);
  // 三颗铺开后火焰色像素应显著多于一颗（若三颗重叠在同一处，比值几乎不变）
  expect(f3, `三颗火球的火焰色占比 ${f3} 应显著大于一颗 ${f1}`).toBeGreaterThan(f1 * 1.8);
});
