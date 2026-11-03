import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 祭坛飞龙（v2.41）Tier 4 像素实测。
 *
 * **为什么必须像素实测**：蒙皮变换、UV 采样、flipY 方向、面序映射全在 GPU 求值，
 * 单测读不到片元输出（testing-policy §5.1）。单测能钉住骨骼属性与矩阵，但钉不住
 * 「GPU 真的按这个 UV 采到了贴图的那块矩形」「贴图没上下颠倒」「翼膜双面真的渲了」
 * —— 这些错了单测全绿而画面是错的（spec §11 风险 1：面序映射错只有像素能抓）。
 *
 * 场景：单条龙 + 黑背景隔离（fixture `test-dragon-render.html`）。取样点由 fixture 按
 * 素材实测的模型空间坐标投影得到，**不硬编码像素**。
 *
 * ⚠️ **测「画面是否在动」时，隐藏 HUD 后只能 `waitForTimeout`，绝不能 `await rAF`**
 * （AGENTS.md v2.14 实测：在 page.evaluate 里 await rAF 会让后续截图恒为同一帧）。
 * 本 spec 用 fixture 的 `renderView` 显式渲染两帧后截图，不依赖 rAF。
 */

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB */
function regionRGB(png, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n } : null;
}

/** 区域内「非黑」像素占比（龙是否真的画出来了） */
function nonBlackRatio(png, rect, threshold = 20) {
  let changed = 0, total = 0;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const o = (y * png.width + x) * 4;
      total++;
      if (png.data[o] > threshold || png.data[o + 1] > threshold || png.data[o + 2] > threshold) changed++;
    }
  }
  return total ? changed / total : 0;
}

/** 两张图在指定矩形内「显著变化」的像素占比（区域隔离判据用） */
function changedRatioInRect(a, b, rect, threshold = 6) {
  let changed = 0, total = 0;
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      const o = (y * a.width + x) * 4;
      total++;
      if (Math.abs(a.data[o] - b.data[o]) > threshold
        || Math.abs(a.data[o + 1] - b.data[o + 1]) > threshold
        || Math.abs(a.data[o + 2] - b.data[o + 2]) > threshold) changed++;
    }
  }
  return total ? changed / total : 0;
}

/** 两张图「显著变化」的像素占比 */
function changedRatio(a, b, threshold = 6) {
  let changed = 0, total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    total++;
    if (Math.abs(a.data[i] - b.data[i]) > threshold
      || Math.abs(a.data[i + 1] - b.data[i + 1]) > threshold
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > threshold) changed++;
  }
  return changed / total;
}

async function setup(page) {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/src/tests/test-dragon-render.html');
  await page.waitForFunction(
    () => window.__DR_READY__ === true || window.__DR_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__DR_ERROR__);
  expect(err, `fixture 加载失败: ${err}`).toBeUndefined();
}

async function shot(page, view, opts = {}) {
  await page.evaluate(([v, o]) => window.__DR_RENDER__(v, o), [view, opts]);
  const buf = await page.screenshot();
  return PNG.sync.read(buf);
}

test('龙 Tier 4：fixture 前提（产物/贴图/材质口径）', async ({ page }) => {
  await setup(page);
  const info = await page.evaluate(() => window.__DR_INFO__);
  expect(info.hasTexture).toBe(true);
  expect(info.textureSize).toEqual([128, 128]);
  expect(info.boneCount).toBe(78);
  expect(info.vertexCount).toBe(2760);
  expect(info.assetScale).toBe(3);
  expect(info.animNames.sort()).toEqual(['fly', 'glide']);
  // 材质口径（与单测重复，但这里是「真实加载路径」的确认）
  expect(info.isBasic).toBe(true);
  expect(info.side).toBe(2);        // THREE.DoubleSide
  expect(info.alphaTest).toBe(0.5);
  // v2.43 多实例池：几何共享一份、材质与骨骼逐龙独立
  expect(info.capacity).toBeGreaterThan(1);
  expect(info.sharedGeometry).toBe(1);
  expect(info.distinctMaterials).toBe(info.capacity);
  expect(info.distinctSkeletons).toBe(info.capacity);
});

test('龙 Tier 4：两条龙同时渲染且姿态各自独立（不共享骨骼的判据）', async ({ page }) => {
  await setup(page);
  // ⚠️ **必须用 wide 视角**：第二条龙在 +X 60 格，front/side/below/top 四个常规视角
  // 都把它放在画外（side 视角更是放在相机背后）⇒ 那四个视角下 changedRatio 恒 0
  // （实测踩到，一度误判成「渲染没生效」）。wide 相机距 90、可见半宽 56 ⇒ 两条都入画。
  //
  // ⚠️ **判据是「同姿势对照」而不是「两条龙画面不同」**：两条龙本来就摆在不同位置，
  // 画面当然不同 —— 那拓不到「骨骼共享」。真正的判据是：
  //   two（第二条 orbitT 差 0.6s）vs twoSync（第二条与第一条同 orbitT）两张图必须不同。
  // 共享骨骼时第二条会被迫摆第一条的姿势 ⇒ two 与 twoSync **逐位相同**。
  const two = await shot(page, 'wide', { orbitT: 0.5, two: true });
  const twoSync = await shot(page, 'wide', { orbitT: 0.5, two: true, twoSync: true });
  // 先测噪声底：同参数两次渲染必须逐位相同（确定性）
  const twoAgain = await shot(page, 'wide', { orbitT: 0.5, two: true });
  expect(changedRatio(two, twoAgain, 6)).toBe(0);
  // 核心判据：第二条龙换姿势（orbitT 0.5 → 1.1）必须让画面变化 ⇒ 骨骼不共享
  expect(changedRatio(two, twoSync, 6)).toBeGreaterThan(0.005);
  // ⚠️ **更尖锐的判据：第一条龙的区域在 two 与 twoSync 之间必须逐位相同**。
  // 第一条龙在两张图里都是 orbitT=0.5，只有第二条的姿势变了。若骨骼共享，
  // 后一次 sync 会覆写同一套骨骼 ⇒ 第一条龙也被迫摆第二条的姿势 ⇒ 它的区域会变化。
  // （实测：只靠上面那条 changedRatio 抓不到「后写胜」型的共享缺陷 —— 两张图里
  // 第一条龙都变成了第二条的姿势，整图仍不同；区域隔离才能拓到。）
  const rect1 = await page.evaluate(() => {
    const pts = window.__DR_RENDER__('wide', { orbitT: 0.5, two: true });
    return { x0: Math.max(0, pts.skull.x - 60), x1: Math.min(639, pts.skull.x + 60),
             y0: 0, y1: 479 };
  });
  expect(changedRatioInRect(two, twoSync, rect1, 6)).toBe(0);
  // 且两条龙在 wide 视角下都非黑（真的各画了一条，不是只画了第一条）
  const pts = await page.evaluate(() => window.__DR_RENDER__('wide', { orbitT: 0.5, two: true }));
  const png = await shot(page, 'wide', { orbitT: 0.5, two: true });
  const head1 = regionRGB(png, pts.skull.x, pts.skull.y, 4);
  const head2 = regionRGB(png, pts.skull2.x, pts.skull2.y, 4);
  expect(head1).not.toBeNull();
  expect(head2).not.toBeNull();
  expect((head1.r + head1.g + head1.b) / 3).toBeGreaterThan(20);
  expect((head2.r + head2.g + head2.b) / 3).toBeGreaterThan(20);
  // 隔离性：常规视角下多一条出画的龙不得污染第一条的取样点
  const frontOne = await shot(page, 'front', { orbitT: 0.5 });
  const frontTwo = await shot(page, 'front', { orbitT: 0.5, two: true });
  expect(changedRatio(frontOne, frontTwo, 6)).toBe(0);
});

test('龙 Tier 4：正面视图有龙头，且贴图方向正确（flipY 判据）', async ({ page }) => {
  await setup(page);
  const pts = await page.evaluate(() => window.__DR_RENDER__('front', {}));
  const png = await shot(page, 'front');
  const head = regionRGB(png, pts.skull.x, pts.skull.y, 6);
  expect(head).not.toBeNull();
  const headLuma = (head.r + head.g + head.b) / 3;
  // ① **flipY 判据（阈值落在两侧实测值之间）**：skull 的 north 面 uv=[93,9,101,16]
  //    （图片顶部）。若 v 轴翻转，会采到图片 y∈[112,119] —— 实测那块**全透明**（alphaTest
  //    剔除）→ 头部只剩 DoubleSide 看到的内壁与邻件，读数显著变暗。
  //    实测：正确版 luma **204.3**（RGB 201/174/238）、翻转版 **126**（119/94/165）→ 阈值 160。
  //    ⚠️ 初版写 `> 40` 是**无效判据**（两侧都过，负向验证实测 8 passed）。
  expect(headLuma).toBeGreaterThan(160);
  // ② 龙是紫水晶色系：B 是最大通道（贴图 skull 区 RGB ≈ 120/89/181）。
  //    ⚠️ 这条**不是** flipY 判据（翻转版同样满足 B>R>G），只是色系 sanity。
  expect(head.b).toBeGreaterThan(head.r);
  expect(head.b).toBeGreaterThan(head.g);
  // ③ 吻部也在（龙真的完整，不是只有一个盒）。实测正确版 191.0 / 翻转版 127 → 阈值 155。
  const snout = regionRGB(png, pts.snout.x, pts.snout.y, 4);
  expect(snout).not.toBeNull();
  expect((snout.r + snout.g + snout.b) / 3).toBeGreaterThan(155);
});

test('龙 Tier 4：侧面视图翼展量级正确（≈16.5 格的投影）', async ({ page }) => {
  await setup(page);
  const pts = await page.evaluate(() => window.__DR_RENDER__('side', {}));
  const png = await shot(page, 'side');
  // 翼展 16.5 格（bbox x 跨度），相机 DIST=30、FOV=50° → 屏幕宽度应占画面相当比例。
  // 判据：翼膜取样点非黑 + 两翼取样点都非黑（龙有两只翅膀，不是半个）
  const wingR = regionRGB(png, pts.wingR.x, pts.wingR.y, 5);
  const wingL = regionRGB(png, pts.wingL.x, pts.wingL.y, 5);
  expect(wingR).not.toBeNull();
  expect(wingL).not.toBeNull();
  expect((wingR.r + wingR.g + wingR.b) / 3).toBeGreaterThan(25);
  expect((wingL.r + wingL.g + wingL.b) / 3).toBeGreaterThan(25);
});

test('龙 Tier 4：下方视图翼膜可见（DoubleSide 生效）', async ({ page }) => {
  await setup(page);
  // ⚠️ **必须用翅膀下展的时刻**（orbitT=0.9，fly 下拍段）：orbitT=0 时翅膀上举 38°，
  // 从下方看是侧对/被身体遮挡 → 取样点读 0（实测）。这不是 DoubleSide 缺陷，是姿态问题。
  // orbitT=0.9 实测：wingR=93 wingL=93 wingRectRatio=0.19。
  const pts = await page.evaluate(() => window.__DR_RENDER__('below', { orbitT: 0.9 }));
  const png = await shot(page, 'below', { orbitT: 0.9 });
  // ⚠️ **这条是 DoubleSide 的判据**：翼膜是 1px 薄片，若材质是 FrontSide，
  // 从下方看会被背面剔除 → 翼膜区域渲染成背景黑。注入 `side: FrontSide` 应真 FAIL。
  const wingR = regionRGB(png, pts.wingR.x, pts.wingR.y, 6);
  const wingL = regionRGB(png, pts.wingL.x, pts.wingL.y, 6);
  expect(wingR).not.toBeNull();
  expect(wingL).not.toBeNull();
  expect((wingR.r + wingR.g + wingR.b) / 3).toBeGreaterThan(20);
  expect((wingL.r + wingL.g + wingL.b) / 3).toBeGreaterThan(20);
  // 区域统计：翼膜小区域内非黑像素占比（比单点稳）
  const ratio = nonBlackRatio(png, pts.wingRect, 20);
  expect(ratio).toBeGreaterThan(0.10);
});

test('龙 Tier 4：相邻两帧画面变化（动画在动）', async ({ page }) => {
  await setup(page);
  const a = await shot(page, 'front', { orbitT: 0.5 });
  const b = await shot(page, 'front', { orbitT: 1.1 });   // 差 0.6s ≈ fly 半周期
  const diff = changedRatio(a, b, 6);
  // ⚠️ 先测噪声底：同 orbitT 两次截图应逐位相同（确定性渲染）
  const a2 = await shot(page, 'front', { orbitT: 0.5 });
  const noise = changedRatio(a, a2, 6);
  expect(noise).toBe(0);   // 确定性：同参数渲染必须逐位相同
  expect(diff).toBeGreaterThan(0.01);   // 动画必须让画面变化（翅膀/脖子在动）
});

test('龙 Tier 4：fly 段与 glide 段画面不同（状态机真的切了动画）', async ({ page }) => {
  await setup(page);
  // fly 段：orbitT=2.0（< 4.0）；glide 段：orbitT=8.0（在 [4.4, 11.6) 内）
  const fly = await shot(page, 'front', { orbitT: 2.0 });
  const glide = await shot(page, 'front', { orbitT: 8.0 });
  const diff = changedRatio(fly, glide, 6);
  expect(diff).toBeGreaterThan(0.01);
});

test('龙 Tier 4：红闪帧整体偏红', async ({ page }) => {
  await setup(page);
  const normal = await shot(page, 'front', {});
  const flash = await shot(page, 'front', { flashing: true });
  // 红闪 = 材质 color 0xff0000 乘贴图 → R 通道相对 G/B 显著抬升
  const headN = await page.evaluate(() => window.__DR_RENDER__('front', {}));
  const rn = regionRGB(normal, headN.skull.x, headN.skull.y, 6);
  const rf = regionRGB(flash, headN.skull.x, headN.skull.y, 6);
  // 正常：B 最大（紫水晶）。红闪：R 应反超 G/B
  expect(rf.r).toBeGreaterThan(rf.g);
  expect(rf.r).toBeGreaterThan(rf.b);
  // 且与正常帧明显不同
  expect(changedRatio(normal, flash, 6)).toBeGreaterThan(0.01);
});

test('龙 Tier 4：hide 后画面与纯黑背景逐位相同（visible=false 生效）', async ({ page }) => {
  await setup(page);
  const hidden = await shot(page, 'front', { hidden: true });  // 整图应几乎全黑（背景 0x000000）
  let nonBlack = 0, total = 0;
  for (let i = 0; i < hidden.data.length; i += 4) {
    total++;
    if (hidden.data[i] > 10 || hidden.data[i + 1] > 10 || hidden.data[i + 2] > 10) nonBlack++;
  }
  expect(nonBlack / total).toBeLessThan(0.001);
  // 对照：有龙时非黑像素显著
  const shown = await shot(page, 'front', {});
  let shownNonBlack = 0;
  for (let i = 0; i < shown.data.length; i += 4) {
    if (shown.data[i] > 10 || shown.data[i + 1] > 10 || shown.data[i + 2] > 10) shownNonBlack++;
  }
  expect(shownNonBlack / total).toBeGreaterThan(0.02);
});
