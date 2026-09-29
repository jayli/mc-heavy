// tests/sky-tree-visual.spec.mjs — Tier 4：天空树渲染像素实测（spec §6.5）
// 判据：① 树冠区屏幕像素 == sky_leaves 颜色（不含背景/墙色混合）→ opaque 不混合
//      ② 与 cutout 单变量对照 RGB 基本相同 → 证明改通道视觉零变化
// ⚠️ 不宣称目视（CLAUDE.md：截图的 Read 只返回 URL）；阈值对着屏幕实测值读（M8 教训）。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 区域主色（取中位数，比均值抗纹理噪点） */
function regionMedianColor(png, x0, y0, x1, y1) {
  const rs = [], gs = [], bs = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o = (y * png.width + x) * 4;
    rs.push(png.data[o]); gs.push(png.data[o + 1]); bs.push(png.data[o + 2]);
  }
  const med = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return [med(rs), med(gs), med(bs)];
}
/** 区域内「接近目标色」的像素占比 */
function colorRatio(png, x0, y0, x1, y1, target, tol) {
  let hit = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o = (y * png.width + x) * 4;
    n++;
    if (Math.abs(png.data[o] - target[0]) <= tol &&
        Math.abs(png.data[o + 1] - target[1]) <= tol &&
        Math.abs(png.data[o + 2] - target[2]) <= tol) hit++;
  }
  return hit / n;
}

async function shoot(page, mode) {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(`/src/tests/test-sky-tree.html?mode=${mode}`);
  await page.waitForFunction(
    () => window.__SKYTREE_READY__ === true || window.__SKYTREE_ERROR__, null, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__SKYTREE_ERROR__);
  expect(err, `mode=${mode} 渲染失败`).toBeUndefined();
  const info = await page.evaluate(() => ({
    cull: window.__SKYTREE_CULL__, verts: window.__SKYTREE_VERTS__,
  }));
  const png = PNG.sync.read(await page.screenshot());
  return { png, info };
}

test('Tier 4：sky_leaves 走 opaque 通道 → 树冠不透明、颜色对齐 atlas、与 cutout 视觉等价', async ({ page }) => {
  const A = await shoot(page, 'opaque'); // 方案 C（本次实现）
  const B = await shoot(page, 'cutout'); // 单变量对照（改回 cutout）

  // 通道归属前提（否则本 spec 测的不是方案 C）
  expect(A.info.cull).toBe(0); // opaque
  expect(B.info.cull).toBe(1); // cutout
  expect(A.info.verts.cutout).toBe(0);   // 方案 C：树不进 cutout
  expect(B.info.verts.cutout).toBeGreaterThan(0); // 对照：树进 cutout

  // 采样区（实施时按全图颜色包围盒 + 20px 网格中位色实测标定，非推算值）：
  //   叶粉包围盒 x∈[213,426] y∈[154,282]；树干（sky_wood）在 x 260~299 下缘 → CANOPY 取
  //   x≥300 的纯叶核心区（实测 leafRatio=1.000）。墙可见区为左右竖条 + 树下横带，
  //   WALLRECT 取右竖条（实测中位色 == atlas 墙色 [74,144,226]）。SKY 为左上纯天空。
  const LEAF = [255, 105, 180]; // atlas procedural/sky_leaves 实测中位数
  const CANOPY = { x0: 300, y0: 210, x1: 340, y1: 250 };
  const SKY = { x0: 10, y0: 10, x1: 90, y1: 60 };
  const WALLRECT = { x0: 430, y0: 160, x1: 455, y1: 270 };

  const canopyA = regionMedianColor(A.png, CANOPY.x0, CANOPY.y0, CANOPY.x1, CANOPY.y1);
  const canopyB = regionMedianColor(B.png, CANOPY.x0, CANOPY.y0, CANOPY.x1, CANOPY.y1);
  const sky = regionMedianColor(A.png, SKY.x0, SKY.y0, SKY.x1, SKY.y1);
  const wall = regionMedianColor(A.png, WALLRECT.x0, WALLRECT.y0, WALLRECT.x1, WALLRECT.y1);
  const ratioA = colorRatio(A.png, CANOPY.x0, CANOPY.y0, CANOPY.x1, CANOPY.y1, LEAF, 60);
  const wallDist = Math.abs(canopyA[0] - wall[0]) + Math.abs(canopyA[1] - wall[1]) + Math.abs(canopyA[2] - wall[2]);
  const channelDelta = Math.abs(canopyA[0] - canopyB[0]) +
                       Math.abs(canopyA[1] - canopyB[1]) +
                       Math.abs(canopyA[2] - canopyB[2]);
  console.log('SKYTREE VISUAL:', JSON.stringify({ canopyA, canopyB, sky, wall, ratioA, wallDist, channelDelta,
    vertsA: A.info.verts, vertsB: B.info.verts }));

  // ① 树冠主色偏红偏粉（atlas 中心 [255,105,180]）—— 与天空蓝 [135,206,235] 明确区分
  expect(canopyA[0]).toBeGreaterThan(canopyA[2]); // R > B（粉色特征；天空蓝是 B > R）
  expect(canopyA[0]).toBeGreaterThan(sky[0]);
  expect(canopyA[2]).toBeLessThan(sky[2]);
  // 树冠区像素接近 atlas 粉色（实测 ratioA=1.000；阈值 0.8 = 实测值留 20% 余量，
  // 天空/墙/地面混入会跌到 ~0，检验力充足）
  expect(ratioA).toBeGreaterThan(0.8);

  // ② 不透明性：树冠区**不含蓝墙成分**（若混合，B 通道会被墙色拉高）
  //    实测 wallDist=266（canopyA==atlas 叶色、wall==atlas 墙色）；阈值 200 留 25% 余量
  expect(wallDist).toBeGreaterThan(200);
  expect(canopyA[2]).toBeLessThan(wall[2]); // 实测 180 < 226（墙 B 高于叶 B，混合必抬升叶 B）

  // ③ 单变量对照：opaque vs cutout 的树冠主色基本相同
  //    （证明 spec §2.6.1 的论断：cutout 通道下 alpha 0.902 全保留不混合 → 已是不透明）
  //    实测 channelDelta=0（median 口径）；逐像素差异仅 ~8% 像素、来自 AO
  //    （opaque 模式叶-叶相邻产生 AO 暗角，spec §2.6.3 第 2 项，median 不受少数像素影响）。
  //    阈值 60 = 容许至多每通道 20 的 median 漂移，远超即非 AO 可解释（spec §6.5 第 3 条）。
  expect(channelDelta).toBeLessThan(60);
});
