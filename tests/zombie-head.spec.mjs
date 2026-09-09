import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（各通道均值） */
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

/**
 * 丧尸头部马赛克图案 Tier 4 像素实测（M6 遗留 TODO 补齐）。
 *
 * **为什么必须像素实测**：纹理采样在 GPU 求值，单测读不到片元输出（testing-policy §5.1）。
 * 单测只能钉住 UV 属性数值（`test-zombies.js` 的 UV 分区断言），无法证明 GPU 真的按这个
 * UV 采到了右半的眼睛区 —— 方向反了、纹理没加载、map 没生效，单测全绿而渲染是错的。
 *
 * 场景：单只丧尸 + 黑背景隔离场景（fixture `test-zombie-head.html`）。取样点由 fixture
 * 投影世界坐标得到，**不硬编码像素位置**（同 `ao-corner-visual.spec.mjs` 手法）。
 * 渲染由 spec 驱动（一个相机只能看一个方向，而截图只有最后一帧 —— 多次渲染会互相覆盖）。
 *
 * 五条断言，每条都能双向验证（见各条注释的「注入什么会失败」）：
 * ① 正面眼睛点显著暗于正面非眼睛点 → 证明眼睛真被采到（去掉 UV 改写 / 面序常量改错即失败）
 * ② 顶面/侧面取样点非黑 → 证明眼睛只在右半、没有污染其余五面
 * ③ 红闪时 R 显著高于 G/B → 证明红闪路径仍生效（head 有 map → 呈**暗红**，非纯红，
 *    这是 mc-lite 的既有行为：红 instanceColor × 深绿马赛克纹理）
 * ④ 前提：纹理确实加载（防「加载失败 → 静默退回纯色」）
 * ⑤ 前提：fixture 暴露全部取样点（防断言到 undefined）
 */
test('丧尸头部 Tier 4：正面有眼睛、顶面侧面无、红闪仍染红', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-zombie-head.html');
  await page.waitForFunction(
    () => window.__ZH_READY__ === true || window.__ZH_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__ZH_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // ④ 前提：纹理确实加载并挂上 head 材质（否则下面的断言测的是纯色退回路径，不是图案）
  const info = await page.evaluate(() => window.__ZH_INFO__);
  expect(info.headHasTexture, 'headHasTexture 须为真').toBe(true);
  expect(info.headHasMap, 'head 材质须带 map').toBe(true);
  expect(info.textureSize, '纹理尺寸须为 128×64（双区并排）').toEqual([128, 64]);
  expect(info.otherPartsHaveMap, '其余五部件不应带 map').toEqual([]);

  // ---- 正面视角：眼睛 vs 非眼睛 ----
  const frontPoints = await page.evaluate(() => window.__ZH_RENDER__('front'));
  // ⑤ 前提断言：取样点齐备（防断言到 undefined 坐标 —— ao-corner spec 同款手法）
  for (const k of ['eye1', 'eye2', 'plain']) {
    expect(frontPoints[k], `正面取样点 ${k} 须存在`).toBeDefined();
  }
  const shotFront = PNG.sync.read(await page.screenshot());
  // 半径 2（5×5px）：马赛克格约 34px，半径 2 足够稳健且不会跨格
  const R = 2;
  const eye1 = regionRGB(shotFront, frontPoints.eye1.x, frontPoints.eye1.y, R);
  const eye2 = regionRGB(shotFront, frontPoints.eye2.x, frontPoints.eye2.y, R);
  const plain = regionRGB(shotFront, frontPoints.plain.x, frontPoints.plain.y, R);

  console.log('FRONT:', JSON.stringify({ eye1, eye2, plain }));

  // ① **眼睛存在**：眼睛格是纯黑（0,0,0），非眼睛格是马赛克绿（≈ [64,107,48] 附近）。
  //    断言用「显著暗」而非「精确黑」—— 纹理 nearest 采样 + 投影取整可能带来边缘混合。
  //    注入「去掉 UV 改写」→ 正面采左半（无眼睛）→ 两点同色 → 失败。
  //    注入「面序常量改成右面顶点」→ 眼睛跑到侧面 → 正面取样点全是马赛克绿 → 失败。
  expect(eye1.r).toBeLessThan(60);
  expect(eye1.g).toBeLessThan(60);
  expect(eye1.b).toBeLessThan(60);
  expect(eye2.r).toBeLessThan(60);
  expect(eye2.g).toBeLessThan(60);
  // 非眼睛对照须是马赛克绿（明显亮于眼睛）
  expect(plain.g).toBeGreaterThan(60);
  expect(plain.g / Math.max(1, eye1.g)).toBeGreaterThan(1.5);

  // ---- 顶面视角：应无眼睛 ----
  // 取样点用「眼睛格的纹理位置」（fixture 内部按各面轴向换算，消除 vdir 符号陷阱）——
  // 顶面 UV 走左半（无眼睛），故这些位置须是马赛克绿、不是黑。**这是断言 ② 的真正判据**：
  // 若取样点随便取（如面中心），「眼睛被误画进左半」这类注入测不出来（实测踩过：注入后仍全绿）。
  const topPoints = await page.evaluate(() => window.__ZH_RENDER__('top'));
  for (const k of ['eye1', 'eye2', 'plain']) expect(topPoints[k], `顶面取样点 ${k} 须存在`).toBeDefined();
  const shotTop = PNG.sync.read(await page.screenshot());
  const topEye1 = regionRGB(shotTop, topPoints.eye1.x, topPoints.eye1.y, R);
  const topEye2 = regionRGB(shotTop, topPoints.eye2.x, topPoints.eye2.y, R);
  const topPlain = regionRGB(shotTop, topPoints.plain.x, topPoints.plain.y, R);
  console.log('TOP:', JSON.stringify({ topEye1, topEye2, topPlain }));
  expect(topEye1.g).toBeGreaterThan(60);
  expect(topEye2.g).toBeGreaterThan(60);
  expect(topPlain.g).toBeGreaterThan(60);

  // ---- 侧面视角：应无眼睛 ----
  const sidePoints = await page.evaluate(() => window.__ZH_RENDER__('side'));
  for (const k of ['eye1', 'eye2', 'plain']) expect(sidePoints[k], `侧面取样点 ${k} 须存在`).toBeDefined();
  const shotSide = PNG.sync.read(await page.screenshot());
  const sideEye1 = regionRGB(shotSide, sidePoints.eye1.x, sidePoints.eye1.y, R);
  const sideEye2 = regionRGB(shotSide, sidePoints.eye2.x, sidePoints.eye2.y, R);
  const sidePlain = regionRGB(shotSide, sidePoints.plain.x, sidePoints.plain.y, R);
  console.log('SIDE:', JSON.stringify({ sideEye1, sideEye2, sidePlain }));
  expect(sideEye1.g).toBeGreaterThan(60);
  expect(sideEye2.g).toBeGreaterThan(60);
  expect(sidePlain.g).toBeGreaterThan(60);

  // ---- 红闪视角 ----
  const flashPoints = await page.evaluate(() => window.__ZH_RENDER__('front', { flashing: true }));
  const shotFlash = PNG.sync.read(await page.screenshot());
  const flash = regionRGB(shotFlash, flashPoints.plain.x, flashPoints.plain.y, R);
  console.log('FLASH:', JSON.stringify(flash));

  // ③ **红闪仍生效**：head 有 map → 红闪 = 红 instanceColor × 深绿马赛克 → 呈**暗红**
  //    （R 通道保留、G/B 被压到接近 0），**不是纯红 [255,0,0]** —— 这是 mc-lite 的既有行为
  //    （它同样 map × flash color），断言要诚实反映真实表现而非理想值。
  //    注入「红闪失效」→ 三通道都是马赛克绿 → R/G 比值接近 1 → 失败。
  expect(flash.r).toBeGreaterThan(20);
  expect(flash.r / Math.max(1, flash.g)).toBeGreaterThan(2);
  expect(flash.r / Math.max(1, flash.b)).toBeGreaterThan(2);
});

/**
 * 真游戏页的纹理接线验收。
 *
 * **为什么上一条 fixture 测不到这个**：`test-zombie-head.html` 自己 `await
 * loadZombieHeadTexture()` 再传给 ZombieRenderer —— 它验的是渲染层能力，验不到
 * `game.js` 是否真的传了纹理。而「忘传」是**静默降级**（`_baseColorOf` 退回纯色头，
 * 玩家看到的是绿头，不报错、不阻断启动）→ 只有落在真游戏页的断言能抓。
 */
test('丧尸头部：真游戏页确实接线了纹理（防忘传 → 静默退回纯色头）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const info = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      headHasTexture: g.zombieRenderer.headHasTexture(),
      headHasMap: !!g.zombieRenderer.meshes.head.material.map,
      // 纹理尺寸（128×64 = 双区并排；若加载失败会是 null）
      textureSize: (() => {
        const img = g.zombieRenderer.meshes.head.material.map?.image;
        return img ? [img.width, img.height] : null;
      })(),
      // 其余五部件不得带头部纹理
      otherPartsHaveMap: ['body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']
        .filter((p) => !!g.zombieRenderer.meshes[p].material.map),
    };
  });
  expect(info.headHasTexture, 'game.js 须把头部纹理传给 ZombieRenderer').toBe(true);
  expect(info.headHasMap, 'head 材质须带 map').toBe(true);
  expect(info.textureSize, '纹理尺寸须为 128×64').toEqual([128, 64]);
  expect(info.otherPartsHaveMap, '其余五部件不应带 map').toEqual([]);
});
