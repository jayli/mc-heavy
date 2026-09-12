import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（同 turret-render.spec.mjs 手法） */
function regionRGB(png, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n };
}

const lum = (c) => (c.r + c.g + c.b) / 3;

/**
 * TNT 爆炸序列帧特效 Tier 4 像素实测。
 *
 * **为什么必须像素实测**：切帧靠 `texture.offset` → `TextureNode.update()` 折进
 * `texture.matrix` 经 uniform 传 shader（`three.webgpu.js:13247`），在 GPU 求值。
 * 单测（`src/tests/test-explosion-sprite.js`）只能钉住 offset 的**算术**，证明不了
 * GPU 真按它采样。
 *
 * ⚠️ **本改动最大的静默失效风险**：若 WebGPU 后端不消费 offset，序列帧会**恒显第 0 帧** ——
 * 爆炸照常播、照常扩张、照常淡出，只是图案不动，肉眼几乎看不出差别。故主判据必须是
 * 「不同帧采到不同区」（下面帧 0 vs 帧 7 那条），**不能**只看「爆炸播了」。
 *
 * **判据用「帧间亮度差」而非绝对色值**（同 turret-render.spec.mjs 理由：渲染管线的小差异
 * 不影响判据）。
 *
 * ⚠️ **阈值对着「屏幕实测值」读，不是图集像素统计值**（实测踩坑，勿按图集数字改阈值）：
 * 屏幕中心区 9×9px 的实测亮度是 帧 0 = 242.7 / 帧 1 = 239.2 / 帧 2 = 181.4 / 帧 4 = 111.0 /
 * 帧 7 = 0.0 / 帧 9 = 0.0。**帧 7/8/9 读 0 而图集像素统计帧 7 中心区是 20.4** —— 因为
 * scale 随 progress 扩张（3 → 8），屏幕同样大的取样区覆盖的**纹理区域越来越小**，越靠后
 * 的帧只采到纹理正中心那一小块（那里是黑的）。图集像素统计用 ±10px 固定区，口径不同。
 *
 * ⚠️ **主判据的对照只差一个变量 = 帧号**（CLAUDE.md「对照脚本只差一个变量」原则）：
 * 选帧 0 与帧 7 —— 两者 progress（0.05 / 0.75）都在前 80%，`opacity` 恒 1，故亮度差异
 * **纯粹**来自切帧（实测差 242.7）。不用帧 9 作主判据：它 progress=0.95 已进淡出段
 * （opacity 0.25），会混入第二个变量。帧 9 另作「末帧是空帧」的补充断言。
 */
test('爆炸序列帧 Tier 4：不同帧采到图集不同区（切帧真在生效）', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-explosion-sprite.html');
  await page.waitForFunction(
    () => window.__EXP_READY__ === true || window.__EXP_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__EXP_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // ---- 前提断言（排除「加载失败 → 特效静默禁用」造成的假绿）----
  const info = await page.evaluate(() => window.__EXP_INFO__);
  expect(info.ready, '图集须加载成功（否则整个特效静默禁用）').toBe(true);
  expect(info.textureSize, '图集须为 500×200（5×2 = 10 帧）').toEqual([500, 200]);
  // ⚠️ **repeat 须在 `clone()` 之前设置**：clone 复制参数快照，顺序反了则每个副本的 repeat
  // 丢失 → 采样整幅图集（10 帧叠在一起），观感是「一团糊」而非分帧。这条钉住顺序依赖。
  expect(info.repeat, 'repeat 须为 (1/5, 1/2)').toEqual([0.2, 0.5]);
  expect(info.slotCount, '池容量须为 10（mc-lite MAX_EXPLOSION_BILLBOARDS）').toBe(10);
  // ⚠️ **每 slot 须有独立材质 + 独立纹理副本**：共享材质会让 offset 互相覆盖 →
  // 只有一个 slot 能切帧（其余恒显同一帧），且肉眼看不出差别（池内只有一个爆炸时）。
  expect(info.materialsUnique, '10 个 slot 须各有独立材质').toBe(10);
  expect(info.mapsUnique, '10 个 slot 须各有独立纹理副本').toBe(10);
  expect(info.additive, '须用 AdditiveBlending（mc-lite `:36` 发光感）').toBe(true);
  expect(info.allHidden, '初始全部 slot 须 visible=false（draw call 回基线）').toBe(true);
  expect(info.spriteNames, 'Sprite 须带受控名字').toEqual(['explosion-sprite']);

  const R = 4;   // 9×9px 取样（scale=3 的 sprite 占约 160px 屏幕高度，中心区足够大）

  // ---- 帧 0（图集左上角，最亮）----
  const f0 = await page.evaluate(() => window.__EXP_FRAME__(0));
  const shot0 = PNG.sync.read(await page.screenshot());
  const c0 = regionRGB(shot0, f0.point.x, f0.point.y, R);

  // ---- 帧 7（图集下半行第三帧，暗）----
  const f7 = await page.evaluate(() => window.__EXP_FRAME__(7));
  const shot7 = PNG.sync.read(await page.screenshot());
  const c7 = regionRGB(shot7, f7.point.x, f7.point.y, R);

  // 主判据：帧 0 亮、帧 7 显著更暗。**注入「offset 不更新」→ 两次读数相同 → 这条真 FAIL**
  // （这是本改动唯一能证明「GPU 真在切帧」的断言）。实测帧 0 = 242.7、帧 7 = 0.0。
  expect(lum(c0), `帧 0 须亮（屏幕实测 242.7）：${JSON.stringify(c0)}`).toBeGreaterThan(60);
  expect(lum(c0) - lum(c7),
    `帧 0 须显著亮于帧 7（屏幕实测 242.7 vs 0.0）：c0=${JSON.stringify(c0)} c7=${JSON.stringify(c7)}`)
    .toBeGreaterThan(40);

  // ---- 帧 9（末帧，全透明空帧）----
  // 补充判据：末帧采到图集右下角那个**全透明**帧（图集实测该帧最大 alpha = 0）→ 渲染为
  // 黑背景。若切帧失效，这里会读到别的帧的图案 → 真 FAIL。
  const f9 = await page.evaluate(() => window.__EXP_FRAME__(9));
  const shot9 = PNG.sync.read(await page.screenshot());
  const c9 = regionRGB(shot9, f9.point.x, f9.point.y, R);
  expect(lum(c9), `帧 9 须为全透明空帧（渲染成黑背景）：${JSON.stringify(c9)}`).toBeLessThan(12);
});

test('爆炸序列帧：到期后全部 slot visible=false（draw call 回基线）', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-explosion-sprite.html');
  await page.waitForFunction(
    () => window.__EXP_READY__ === true || window.__EXP_ERROR__, null, { timeout: 60_000 },
  );
  const result = await page.evaluate(() => window.__EXP_EXPIRE__());
  // ⚠️ 与 M6 活跃约束 ①（常驻实例池须无活跃实例时 visible=false）同一口径：
  // 空闲 slot 若仍 visible，会恒增 draw call 且进入透明渲染列表干扰水面排序不变式。
  expect(result.activeCount, '到期后活跃 slot 须归零').toBe(0);
  expect(result.visibleSprites, '到期后可见 Sprite 须归零（draw call 回基线）').toBe(0);
});
