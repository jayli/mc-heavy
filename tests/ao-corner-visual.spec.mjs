import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均亮度（0-255，RGB 均值） */
function regionBrightness(png, cx, cy, r) {
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const o = (y * png.width + x) * 4;
      sum += (png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

/**
 * AO 对角凹角 Tier 4 像素实测（§4.3 有意偏离 mc-lite 第 ⑤ 项）。
 *
 * 场景：y=0 整片地面 + (8,1,8) 单个墙角块 B（fixture `test-ao-corner.html`）。
 * 取样点由 fixture 投影世界坐标得到（`window.__AO_PROJ__`），**不硬编码像素位置**。
 *
 * **取样必须紧邻角顶点**：AO 逐顶点插值，顶面中心是四角平均（≈2.75），信号被稀释。
 * 紧邻 (9,1,9) 角处插值权重偏向该角 → AO≈2.28（aoFactor 0.784），门控下为 3.0（1.0）。
 *
 * 三条断言，都能双向验证（改回 mc-lite 门控即失败）：
 * ① **阴影存在**：对角格紧邻角处必须明显暗于「同相对位置的开阔对照」
 *    （controlCorner 在 (5,5) 角同样位置但四周无遮挡 → 恒 AO=3）。用同相对位置的对照
 *    排除「靠近格角本身就暗」的混淆变量。门控下 nearCorner AO=3 → 与对照同亮 → 失败。
 *    实测：改动侧 ratio≈0.85，HEAD（门控）侧 ratio≈1.07 → 约 19% 差异，双向有效。
 * ② **阴影延伸进对角格内部**：对角格远离 B 的那角 (10,1,10) 恒 AO=3（三个邻居全开阔），
 *    靠 B 的那角变暗 → 格内形成梯度。门控下两角都 AO=3 → 整格平坦无阴影（比值≈1.0）。
 * ③ **场景前提**：东格/南格紧邻角处有阴影（mc-lite 与去门控都 AO=2）→ 钉住场景没跑偏。
 */
test('AO 视觉：对角凹角阴影连通（无阴影断层）', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/src/tests/test-ao-corner.html');
  await page.waitForFunction(() => window.__AO_READY__ === true || window.__AO_ERROR__, null, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__AO_ERROR__);
  expect(err).toBeUndefined();

  const proj = await page.evaluate(() => window.__AO_PROJ__);
  // 前置断言钉住前提：fixture 确实投影出全部取样点（避免断言到 undefined 坐标）
  for (const k of ['nearCorner', 'controlCorner', 'eCorner', 'sCorner', 'farCorner']) {
    expect(proj[k], `fixture 应暴露取样点 ${k}`).toBeDefined();
    expect(proj[k].x).toBeGreaterThanOrEqual(0);
    expect(proj[k].y).toBeGreaterThanOrEqual(0);
  }

  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  // 半径 4（9×9px）：够小以保留 AO 梯度（43px/格），够大以抹平石头纹理噪声
  const R = 4;
  const at = (k) => regionBrightness(png, proj[k].x, proj[k].y, R);
  const near = at('nearCorner'), control = at('controlCorner'), far = at('farCorner');

  console.log('AO CORNER VISUAL:', JSON.stringify({
    near: +near.toFixed(2), control: +control.toFixed(2), far: +far.toFixed(2),
    nearVsControl: +(near / control).toFixed(4), farVsNear: +(far / near).toFixed(4),
  }));

  // ① 阴影存在：对角格紧邻角处暗于同相对位置的开阔对照（AO 2.28 → factor 0.784）
  expect(near / control).toBeLessThan(0.9);
  // ② 阴影延伸进对角格内部：靠 B 角暗于远离 B 角 → 格内有梯度（门控下比值≈1.0）
  expect(far / near).toBeGreaterThan(1.08);
  // ③ 场景前提：东格/南格紧邻角处有阴影（两侧 AO 都应为 2，故都暗于对照）
  expect(at('eCorner') / control).toBeLessThan(0.95);
  expect(at('sCorner') / control).toBeLessThan(0.95);
});
