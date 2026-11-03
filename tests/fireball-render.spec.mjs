// tests/fireball-render.spec.mjs — 飞龙火球 Tier 4 像素实测（v2.44，v2.45 燃烧外观）
//
// **为什么必须像素实测**：火球的颜色、球体轮廓与**光晕发光**在 GPU 求值，单测读不到片元输出
// （testing-policy §5.1）。单测能钉住「材质是 MeshBasicMaterial、颜色常量、光晕是 additive」，
// 但钉不住「GPU 真的画出了一团燃烧的火」—— 例如 `visible` 门控写反、实例矩阵全零、
// billboard 朝向错（侧看退化成一条线）、或 additive 被误设成 NormalBlending，单测全绿而
// 画面里什么都没有（或只是一个橙球）。
//
// 场景：黑背景隔离（fixture `test-fireball-render.html`），相机正对原点。
//
// ⚠️ **判据必须带噪声底对照**（AGENTS.md「写这类 Tier 4 用例前先测噪声底」）：
// 先量「空场景」的火焰色像素数（应为 0），再量「有火球」的（应显著 > 0）。
// 只钉「有火球时 > 阈值」会在「渲染器根本没画」时假失败，也会在「阈值定太低」时假通过。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 亮核颜色（必须与 `src/render/fireball-renderer.js` 的 `FIREBALL_CORE_COLOR` 一致）。
 * ⚠️ 不能在 Node 里 import 那个模块（它 import three，无 import map 解析不了）；
 * 浏览器单测 `test-fireball-render.js` 已钉住「材质色 === FIREBALL_CORE_COLOR」这条链，
 * 此处用字面量只作 Tier 4 前提断言（改色时两处同步）。
 */
const FIREBALL_CORE_COLOR = 0xffb340;

/** 火焰色像素占比：R 显著高于 G 与 B（炽橙 0xffb340 经 ACES 后仍是 R>G>B） */
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

test('火球 Tier 4：fixture 前提（池容量/几何/材质口径 + v2.45 光晕层）', async ({ page }) => {
  await setup(page);
  const info = await page.evaluate(() => window.__FB_INFO__);
  expect(info.maxActive).toBe(info.poolSize);
  expect(info.meshCount).toBe(info.poolSize);
  expect(info.geometryType).toBe('SphereGeometry');
  expect(info.radius).toBeGreaterThan(0);
  expect(info.isBasic).toBe(true);
  expect(info.colorHex).toBe(FIREBALL_CORE_COLOR);
  expect(info.visibleAtStart, '构造后核心必须隐藏（draw call 归零）').toBe(false);
  // ---- v2.45 光晕层前提 ----
  expect(info.haloCount, '光晕池容量必须 = poolSize').toBe(info.poolSize);
  expect(info.haloVisibleAtStart, '构造后光晕必须隐藏（否则恒增 1 个 draw call）').toBe(false);
  expect(info.haloAdditive, '光晕必须 additive 混合（发光感）').toBe(true);
  expect(info.haloDepthWrite, '光晕不得写深度').toBe(false);
  expect(info.haloTransparent, '光晕必须 transparent').toBe(true);
  expect(info.haloHasMap, '光晕必须挂径向渐变贴图').toBe(true);
  expect(info.haloScaleRatio, `光晕尺寸必须 = 核心半径 × 3.4（实测 ${info.haloScaleRatio}）`)
    .toBeCloseTo(3.4, 5);
});

test('火球 Tier 4：空场景噪声底为 0，有火球时出现火焰色像素（核心 + 光晕都提交）', async ({ page }) => {
  await setup(page);
  // ① 噪声底：空场景（count=0）
  const empty = await shot(page, { count: 0 });
  expect(empty.info.slots, 'sanity：空场景不得分配 slot').toBe(0);
  expect(empty.info.visible, 'sanity：空场景核心必须 visible=false').toBe(false);
  expect(empty.info.haloVisible, 'sanity：空场景光晕必须 visible=false').toBe(false);
  const baseFlame = flameRatio(empty.png);
  const baseNonBlack = nonBlackRatio(empty.png);
  expect(baseFlame, `噪声底必须为 0（实测 ${baseFlame}）`).toBe(0);
  expect(baseNonBlack, `空场景必须全黑（实测 ${baseNonBlack}）`).toBe(0);

  // ② 有火球：火焰色像素显著出现，且两个 mesh 都提交渲染
  const one = await shot(page, { count: 1 });
  expect(one.info.slots).toBe(1);
  expect(one.info.visible, '有火球核心必须提交渲染').toBe(true);
  expect(one.info.haloVisible, '有火球光晕必须提交渲染（否则只是橙球，不是燃烧）').toBe(true);
  const flame = flameRatio(one.png);
  expect(flame, `火球必须画出火焰色像素（噪声底 ${baseFlame}）`).toBeGreaterThan(0.002);
  expect(nonBlackRatio(one.png)).toBeGreaterThan(0.002);

  // ③ 颜色口径：画面中心偏炽橙（R > G > B）
  const c = centerRGB(one.png);
  expect(c.r, `中心 R=${c.r.toFixed(1)} G=${c.g.toFixed(1)} B=${c.b.toFixed(1)}`).toBeGreaterThan(c.g);
  expect(c.g).toBeGreaterThan(c.b);
  expect(c.r).toBeGreaterThan(150);
});

test('火球 Tier 4：光晕真的比核心大（燃烧的外圈光，不是只换了个颜色）', async ({ page }) => {
  await setup(page);
  const one = await shot(page, { count: 1 });
  // 光晕边长 = 核心直径 × 3.4 ⇒ 发光区应显著大于核心球。
  // ⚠️ **判据用「非黑包围半径」而不是「火焰色包围半径」**：光晕是 additive 径向渐变，
  // 外缘很淡（橙度不够 r-g≥25 的火焰色门）—— 用火焰色判据只能量到 13.6px，而光晕
  // 几何半径约 32px。非黑（任一通道 > 8）才能量出发光扩到多远。
  const png = one.png;
  const cx = png.width / 2, cy = png.height / 2;
  let maxR = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      if (png.data[o] > 8 || png.data[o + 1] > 8 || png.data[o + 2] > 8) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > maxR) maxR = d;
      }
    }
  }
  // 核心球半径 0.45 格、距相机 12 格、FOV 50°、画面高 240px：
  // 核心屏幕半径 ≈ tan(atan(0.45/12)) / tan(25°) × 120 ≈ 9.6px。
  // 光晕几何半径 ≈ 9.6 × 3.4 ≈ 32px。取 1.6 倍作下界（只有核心时 = 9.6 < 15.4 → FAIL）。
  expect(maxR, `非黑包围半径 ${maxR.toFixed(1)}px 必须显著大于核心球（≈9.6px）—— 光晕真的在发光`)
    .toBeGreaterThan(9.6 * 1.6);
});

test('火球 Tier 4：光晕脉动（不同时刻截图的火焰色像素数不同 —— 火在「跳」）', async ({ page }) => {
  await setup(page);
  // 两个相差 1/4 脉动周期的时刻（6Hz ⇒ ~41.7ms）：光晕尺度一胀一缩
  const a = await shot(page, { count: 1, nowMs: 0 });
  const b = await shot(page, { count: 1, nowMs: 1000 / 24 });
  const fa = flameRatio(a.png);
  const fbv = flameRatio(b.png);
  expect(fa).toBeGreaterThan(0.002);
  expect(fbv).toBeGreaterThan(0.002);
  // ⚠️ 判据用「非黑像素占比差」：脉动改的是光晕外圈面积，火焰色判据可能把两帧都算进去，
  // 而「非黑」能精确量出光晕边缘的胀缩。两帧必须真的不同（否则脉动没生效）。
  const na = nonBlackRatio(a.png);
  const nb = nonBlackRatio(b.png);
  expect(Math.abs(na - nb), `脉动必须真的在动（na=${na.toFixed(5)} nb=${nb.toFixed(5)}）`)
    .toBeGreaterThan(0.0005);
});

test('火球 Tier 4：火球消失后画面回到全黑（slot 归还 + 两个 mesh 的 visible 门控真的生效）', async ({ page }) => {
  await setup(page);
  const one = await shot(page, { count: 1 });
  expect(flameRatio(one.png)).toBeGreaterThan(0.002);
  // 清空 → 画面必须逐位回到空场景（否则说明 slot 没归还 / visible 没回落）
  const empty1 = await shot(page, { count: 0 });
  const empty2 = await shot(page, { count: 0 });
  expect(empty1.info.visible).toBe(false);
  expect(empty1.info.haloVisible, '光晕也必须回落 visible=false').toBe(false);
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
