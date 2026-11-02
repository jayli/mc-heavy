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
 * 两张图在指定矩形内「显著变化」的像素占比（通道差 > threshold）。
 * 用于头摆这类「位移小、单点色差弱」的判据 —— 整块区域统计比单点取样稳。
 */
function regionDiff(a, b, rect, threshold = 6) {
  let changed = 0, total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const o = (y * a.width + x) * 4;
      total++;
      if (Math.abs(a.data[o] - b.data[o]) > threshold
        || Math.abs(a.data[o + 1] - b.data[o + 1]) > threshold
        || Math.abs(a.data[o + 2] - b.data[o + 2]) > threshold) changed++;
    }
  }
  return changed / total;
}

/** 两张图之间「显著变化」的像素占比（通道差 > threshold） */
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

/**
 * 丧尸模型（原版人形重建）Tier 4 像素实测。
 *
 * **为什么必须像素实测**：纹理采样与摆动矩阵在 GPU 求值，单测读不到片元输出
 * （testing-policy §5.1）。单测能钉住 UV 属性数值与矩阵，但钉不住「GPU 真的按这个 UV
 * 采到了皮肤的那块矩形」—— 轴映射搞反、纹理没加载、面序错了，单测全绿而画面是错的。
 *
 * 场景：单只丧尸 + 黑背景隔离（fixture `test-zombie-model.html`）。取样点由 fixture
 * 按 `ZOMBIE_MODEL_DEFS` 的 pivot/size 投影世界坐标得到，**不硬编码像素**。
 *
 * 六条断言，每条都能双向验证（见各条注释的「注入什么会失败」）：
 * ① 三区可分（头绿皮 / 躯干青蓝 / 腿蓝紫）—— 抓「自烘配色撞车」
 * ② 头部偏绿（G 是最大通道）—— 抓「头用了衣服色」
 * ③ 正脸有眼睛（暗点）—— 抓「眼睛没画 / UV 正面矩形指错」
 * ④ 侧面不串脸（侧面取样点不是眼睛黑）—— 抓「轴映射搞反」
 * ⑤ 摆动使画面变化 —— 抓「手臂/头没动」
 * ⑥ 红闪仍染红 —— 抓「红闪路径被新的 instanceColor 逻辑打断」
 * 另加前提：纹理确实加载（防静默退回纯色）。
 */
test('丧尸模型 Tier 4：原版人形比例 + 皮肤分区 + 眼睛 + 摆动 + 红闪', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto('/src/tests/test-zombie-model.html');
  await page.waitForFunction(
    () => window.__ZM_READY__ === true || window.__ZM_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__ZM_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // 前提：皮肤确实加载并挂到全部六部件（否则下面的断言测的是纯色退回路径）
  const info = await page.evaluate(() => window.__ZM_INFO__);
  expect(info.hasSkinTexture, 'hasSkinTexture 须为真').toBe(true);
  expect(info.textureSize, '纹理尺寸须为 64×64（标准皮肤）').toEqual([64, 64]);
  expect(info.partsWithoutMap, '六部件都该带 map').toEqual([]);

  const R = 2;
  /** 切视角（可选相位/红闪）→ 渲染 → 截图 + 取样点 */
  const shot = async (view, opts = {}) => {
    const pts = await page.evaluate(([v, o]) => window.__ZM_RENDER__(v, o), [view, opts]);
    const png = PNG.sync.read(await page.screenshot());
    return { pts, png };
  };

  // ---- 正面 ----
  const front = await shot('front');
  for (const k of ['head', 'torso', 'leg', 'eyeL', 'eyeR']) {
    expect(front.pts[k], `正面取样点 ${k} 须存在`).toBeDefined();
  }
  const head = regionRGB(front.png, front.pts.head.x, front.pts.head.y, R);
  const torso = regionRGB(front.png, front.pts.torso.x, front.pts.torso.y, R);
  const leg = regionRGB(front.png, front.pts.leg.x, front.pts.leg.y, R);
  console.log('FRONT:', JSON.stringify({ head, torso, leg }));

  const dist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  // ① 三区可分。阈值取「皮肤参数级色距 49~86」的一半（屏幕取样更宽容：有抗锯齿与
  //    黑色背景的边缘混合），实测三对都在 40 以上。
  expect(dist(head, torso), `head vs torso: ${JSON.stringify({ head, torso })}`).toBeGreaterThan(25);
  expect(dist(torso, leg), `torso vs leg: ${JSON.stringify({ torso, leg })}`).toBeGreaterThan(25);
  expect(dist(head, leg), `head vs leg: ${JSON.stringify({ head, leg })}`).toBeGreaterThan(25);
  // ② 头部偏绿（绿皮）：G 必须同时大于 R 与 B
  expect(head.g, `head=${JSON.stringify(head)}`).toBeGreaterThan(head.r);
  expect(head.g).toBeGreaterThan(head.b);

  // ③ 正脸有眼睛：眼睛取样点显著暗于同面的非眼睛点
  const eyeL = regionRGB(front.png, front.pts.eyeL.x, front.pts.eyeL.y, 1);
  const eyeR = regionRGB(front.png, front.pts.eyeR.x, front.pts.eyeR.y, 1);
  console.log('EYES:', JSON.stringify({ eyeL, eyeR }));
  const headLuma = head.r + head.g + head.b;
  expect(eyeL.r + eyeL.g + eyeL.b).toBeLessThan(headLuma * 0.75);
  expect(eyeR.r + eyeR.g + eyeR.b).toBeLessThan(headLuma * 0.75);

  // ③b **脸必须是正的**：眼睛在屏幕上的 y 必须**小于**嘴的 y（像素坐标向下为正）。
  //
  // ⚠️ 这条是用户 2026-11-04 实玩报告的直接回归门（「眼睛在下面，嘴巴在上面」）。
  // 单测钉的是 UV 数值语义（世界顶部 → 矩形顶边），但「眼睛/嘴各自落在哪一行」是
  // 烘焙侧的像素布局 —— 两者都对才叫脸是正的。只钉 UV 时，把眼睛和嘴的**烘焙坐标**
  // 对调仍然全绿（因为它们都在矩形内、UV 也都在范围内）。
  const mouth = regionRGB(front.png, front.pts.mouth.x, front.pts.mouth.y, 1);
  console.log('MOUTH:', JSON.stringify(mouth));
  expect(front.pts.eyeL.y, `眼睛须在嘴上方（eye y=${front.pts.eyeL.y}, mouth y=${front.pts.mouth.y}）`)
    .toBeLessThan(front.pts.mouth.y);
  // 嘴也必须是暗的（与眼睛同色系），否则「上暗下亮」可能只是破损斑
  expect(mouth.r + mouth.g + mouth.b).toBeLessThan(headLuma * 0.75);

  // ③c **手臂必须露出皮肤**（用户 2026-11-04 实拍反馈：「短袖套在手臂上」）。
  //
  // 原版丧尸的典型特征是「袖子破了、前臂露出来」。这条同时钉两个失效模式：
  //   · 袖子占比过大（曾用 2/3）→ 整条臂都是青蓝，只有端面有皮肤
  //   · 端面（`ny`）没单独上色 → 手臂前伸后正面主要看到端面，同样「全被袖子包住」
  // 判据：正面看时，手臂取样点必须**偏绿**（皮肤），而不是偏蓝（衣服）。
  const armFront = regionRGB(front.png, front.pts.armL.x, front.pts.armL.y, 2);
  console.log('ARM:', JSON.stringify(armFront));
  // ⚠️ 判据用**绿比蓝高出一截**，不是 `g > b`：破损斑是绿的，袖子回退到 2/3 时
  // 实测 g=120.5 / b=116.5（只差 4）仍然「g > b」通过 —— 那是无效盲区。
  // 修好时 g=138.5 / b=83.5（差 55），故阈值取 25（两侧实测值之间）。
  expect(armFront.g - armFront.b, `手臂须露皮肤（g−b 显著为正）: ${JSON.stringify(armFront)}`)
    .toBeGreaterThan(25);

  // ④ 侧面不串脸：侧面看头时，取样点是皮肤色不是眼睛黑
  const side = await shot('side');
  const sideHead = regionRGB(side.png, side.pts.head.x, side.pts.head.y, R);
  console.log('SIDE:', JSON.stringify({ sideHead }));
  expect(sideHead.r + sideHead.g + sideHead.b).toBeGreaterThan(60);

  // ⑤ 摆动：**手臂**与**头部**必须各自在动 —— 两条独立判据，不能合并成全图变化。
  //
  // ⚠️ **实测踩到的无效盲区**：初版只断言「两张截图的整体变化占比 > 1%」，
  // 而把手臂摆动注入成 0 之后仍然通过（6.6% > 1%）—— 因为头还在摆、身体占据的画面
  // 足够大。判据必须落在**被测部件自己的取样点**上。
  //
  // 相位选 π/2 的整数倍附近：sin(phase)=0 时臂在基准角，sin(π/2)=1 时摆到极值。
  // phase = walkTime × ZOMBIE_WALK_SPEED，armSwing = sin(phase) × π/12。
  // 取 157ms → phase = 1.57 ≈ π/2 → 臂摆到最大；取 0ms → phase = 0 → 臂在基准角。
  const armPoseA = await shot('front', { phaseMs: 0 });
  const armPoseB = await shot('front', { phaseMs: 157 });
  // 用**手臂区域的像素差分**（与头摆同款手法，已在头摆上验证有效）：
  // 臂绕肩摆动时整块区域都在动，单点取样容易落在几乎不动的位置（实测只有 2 的色差）。
  const armMoved = regionDiff(armPoseA.png, armPoseB.png, armPoseA.pts.armRect);
  console.log('ARM SWING region diff:', armMoved.toFixed(4));
  expect(armMoved, '手臂区域应随摆动变化').toBeGreaterThan(0.04);
  // 头部：头摆是**半频**（sin(phase × 0.5)），必须取它的极值相位才能看出位移。
  // 相位 = walkTime × ZOMBIE_WALK_SPEED；头相位 = 相位 × 0.5。
  // 取 314ms → 相位 3.14 = π → 头相位 1.57 = π/2 → **头摆到最大**；取 0ms → 头在正中
  // ⚠️ 头只有 0.5 格宽、摆幅 7.5°，屏幕上边缘位移约 3px —— 单个取样点的色差很小
  // （实测只有 2~3，远低于阈值）。故判据用「头部整块区域的像素差分」，不是单点色差。
  const headPoseA = await shot('front', { phaseMs: 0 });
  const headPoseB = await shot('front', { phaseMs: 314 });
  const headMoved = regionDiff(headPoseA.png, headPoseB.png, headPoseA.pts.headRect);
  console.log('HEAD SWAY region diff:', headMoved.toFixed(4));
  expect(headMoved, '头部区域应随头摆变化（半频极值相位）').toBeGreaterThan(0.04);
  // 全图变化仍保留为补充判据（防「两个取样点都恰好落在不变的位置」）
  const moved = changedRatio(armPoseA.png, armPoseB.png);
  console.log('SWING changed ratio:', moved.toFixed(4));
  expect(moved).toBeGreaterThan(0.01);

  // ⑥ 红闪仍染红（R 通道显著高于 G/B）
  const flash = await shot('front', { flashing: true });
  const f = regionRGB(flash.png, flash.pts.torso.x, flash.pts.torso.y, R);
  console.log('FLASH:', JSON.stringify(f));
  expect(f.r / Math.max(1, f.g)).toBeGreaterThan(2);
  expect(f.r / Math.max(1, f.b)).toBeGreaterThan(2);
});

/**
 * 真游戏页的接线验收。
 *
 * **为什么上一条 fixture 测不到这个**：fixture 自己 `await loadZombieSkinTexture()` 再传给
 * ZombieRenderer —— 它验的是渲染层能力，验不到 `game.js` 是否真的传了纹理。而「忘传」是
 * **静默降级**（`_baseColorOf` 退回各部件纯色，玩家看到的是纯色方块人，不报错、不阻断启动）
 * → 只有落在真游戏页的断言能抓。
 */
test('丧尸模型：真游戏页确实接线了皮肤（防忘传 → 静默退回纯色）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const info = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      hasSkinTexture: g.zombieRenderer.hasSkinTexture(),
      partsWithMap: ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']
        .filter((p) => !!g.zombieRenderer.meshes[p].material.map).length,
      textureSize: (() => {
        const img = g.zombieRenderer.meshes.head.material.map?.image;
        return img ? [img.width, img.height] : null;
      })(),
    };
  });
  expect(info.hasSkinTexture, 'game.js 须把皮肤传给 ZombieRenderer').toBe(true);
  expect(info.partsWithMap, '六部件都该带 map（全身皮肤）').toBe(6);
  expect(info.textureSize, '纹理尺寸须为 64×64').toEqual([64, 64]);
});
