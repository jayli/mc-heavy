import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 统计「非背景像素」的平均色。黑底场景里碎块是唯一亮源 → 不必猜碎块落在哪几个像素。
 * 用亮度阈值剔除黑背景（与黑背景混合后的边缘像素也会被包含，但两侧一致，判据仍可比）。
 */
function litPixelsMean(png, threshold = 24) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if ((r + g + b) / 3 <= threshold) continue;
    sr += r; sg += g; sb += b; n++;
  }
  if (n === 0) return { r: 0, g: 0, b: 0, n: 0 };
  return { r: sr / n, g: sg / n, b: sb / n, n };
}

/** 亮像素数量（碎块存在性判据） */
function litCount(png, threshold = 24) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if ((png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3 > threshold) n++;
  }
  return n;
}

/** 近白像素数量：三通道都 > 200（白闪的判据 —— 碎块是灰/绿/棕，不会三通道同时这么高） */
function nearWhiteCount(png, threshold = 200) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > threshold && png.data[i + 1] > threshold && png.data[i + 2] > threshold) n++;
  }
  return n;
}

/**
 * 枪击方块命中特效的 Tier 4 像素实测。
 *
 * **为什么必须像素实测**：碎块颜色走 `InstancedMesh.instanceColor`（逐实例顶点属性），
 * 白闪走 Mesh 材质的 `opacity`（GPU 求值）—— 都在 GPU。**若 instanceColor 没生效，
 * 碎块会全部渲染成材质白**：特效照常播、碎块照常飞散，只是与方块材质无关，肉眼极难判定
 * 「这是 bug 还是设计」。
 *
 * 主判据只差一个变量 = **方块材质**：同一相机、同一命中点、同一时刻、同一把枪，
 * 击 `stone` 与击 `grass`，碎块亮像素的平均色须显著不同（石灰 vs 草绿）。
 * 注入「instanceColor 不写（恒白）」→ 两侧读数相同 → 真 FAIL。
 */
async function bootFixture(page) {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto('/src/tests/test-block-hit-fx.html');
  await page.waitForFunction(
    () => window.__FX_READY__ === true || window.__FX_ERROR__, null, { timeout: 90_000 },
  );
  const err = await page.evaluate(() => window.__FX_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();
  return page.evaluate(() => window.__FX_STATS__());
}

test('命中特效 Tier 4：碎块颜色来自方块材质（击石头 vs 击草，颜色显著不同）', async ({ page }) => {
  const stats = await bootFixture(page);
  // ---- 前提断言（排除「图集/解析器没起来 → 特效静默退化」造成的假绿）----
  expect(stats.hasInstanceColor, '碎块须用逐实例颜色（否则所有碎块同一色）').toBe(true);
  expect(stats.debrisCapacity).toBeGreaterThan(16);
  expect(stats.flashNames, '白闪池须带受控名字').toEqual(['block-hit-white']);

  // ⚠️ 采样时刻必须落在「白闪已结束、碎块仍在」的窗口（实测踩坑）：
  // 白闪是 1.02 格见方的白立方，会把碎块像素整个盖住 → 破坏开/关读到**完全相同**的
  // 亮像素数（旧面闪时代实测都是 9409）。白闪 150ms / 碎块 620ms → 取 300ms。
  const sampleAge = Math.max(stats.whiteFlashTotalMs, 200) + 150;
  expect(sampleAge, '取样时刻须晚于白闪结束且早于碎块寿命')
    .toBeLessThan(stats.debrisLifeMs);

  // 命中格 = [-1,-1,-1] → 白闪与碎块都围绕原点
  await page.evaluate((age) => window.__FX_HIT__('stone', [0, 1, 0], age), sampleAge);
  const stonePng = PNG.sync.read(await page.screenshot());
  const stone = litPixelsMean(stonePng);

  await page.evaluate((age) => window.__FX_HIT__('grass', [0, 1, 0], age), sampleAge);
  const grassPng = PNG.sync.read(await page.screenshot());
  const grass = litPixelsMean(grassPng);

  // 两次都必须真有碎块（否则后面的颜色比较是空对空）
  expect(stone.n, `击石头须有可见碎块像素：${JSON.stringify(stone)}`).toBeGreaterThan(80);
  expect(grass.n, `击草须有可见碎块像素：${JSON.stringify(grass)}`).toBeGreaterThan(80);

  // 主判据：草（grass_carried，绿）与石头（stone_andesite，灰）的碎块平均色须明显不同。
  // 灰的 R≈G≈B；草的 G 明显高于 R 与 B。
  const stoneSpread = Math.abs(stone.r - stone.b);
  const grassGreen = grass.g - (grass.r + grass.b) / 2;
  // 通道差：注入「instanceColor 恒白」→ 两侧都是纯白，grassGreen ≈ 0 → 真 FAIL
  const channelGap = Math.abs(stone.g - grass.g) + Math.abs(stone.r - grass.r) + Math.abs(stone.b - grass.b);
  expect(channelGap,
    `两种材质的碎块平均色须显著不同：stone=${JSON.stringify(stone)} grass=${JSON.stringify(grass)}`)
    .toBeGreaterThan(24);
  expect(grassGreen,
    `草的碎块须偏绿（G 明显高于 R/B 均值）：${JSON.stringify(grass)}`)
    .toBeGreaterThan(4);
  expect(stoneSpread,
    `石头的碎块须接近中性灰（R≈B）：${JSON.stringify(stone)}`)
    .toBeLessThan(26);
});

test('命中特效 Tier 4：白闪是被击中那格变成白色，随后自己消失', async ({ page }) => {
  const stats = await bootFixture(page);
  // MAG7 现在已经零碎块 → 画面里唯一的亮源就是白闪，判据没有第二个变量的干扰。
  await page.evaluate(() => window.__FX_HIT__('stone', [0, 1, 0], 5, { weaponId: 'mag7' }));
  const litPng = PNG.sync.read(await page.screenshot());
  const lit = litPixelsMean(litPng);
  const litWhite = nearWhiteCount(litPng);

  // 200ms > whiteFlash.totalMs(150) → 白闪必须已经完全消失，画面回到空场景。
  await page.evaluate(() => window.__FX_HIT__('stone', [0, 1, 0], 200, { weaponId: 'mag7' }));
  const gonePng = PNG.sync.read(await page.screenshot());
  const goneWhite = nearWhiteCount(gonePng);

  // 保持段必须是**满白**：三通道都贴到 255 附近（负向锚点：把白闪做成灰色/半透明会掉到阈值下）
  expect(lit.r, `白闪保持段须是白色：${JSON.stringify(lit)}`).toBeGreaterThan(220);
  expect(lit.g, `白闪保持段须是白色：${JSON.stringify(lit)}`).toBeGreaterThan(220);
  expect(lit.b, `白闪保持段须是白色：${JSON.stringify(lit)}`).toBeGreaterThan(220);
  // 「整格」判据：480×360 画面里 1.02 格的立方体（3.4 格距离、50° FOV）实测 13456 个近白像素
  // 占约 7.8% 画面 → 阈值 3000。旧的球形闪光（0.5 格）在同样机位实测约 1000 像素 ——
  // 即用户说的「球形闪光球」形态会被这条拦下。
  expect(litWhite, `白闪须占据整格：近白像素 ${litWhite}`).toBeGreaterThan(3000);
  // 到期必须归零（负向锚点：不淡出/永不过期会让这条 FAIL —— 观感是「方块变成白色方块了」）
  expect(goneWhite, `白闪到期须完全消失：残留 ${goneWhite} 像素`).toBe(0);
  // 两个采样点之间只差时间这一个变量（150ms 到期 vs 200ms 采样）
  expect(stats.whiteFlashTotalMs).toBeLessThan(200);
});

test('命中特效：破坏关闭时无碎块（只有白闪与一瞬粉尘）', async ({ page }) => {
  const stats = await bootFixture(page);
  const sampleAge = Math.max(stats.whiteFlashTotalMs, 200) + 150;
  // 破坏开启（destroyed=true）的碎块像素量作基准
  await page.evaluate((age) => window.__FX_HIT__('stone', [0, 1, 0], age, { destroyed: true }), sampleAge);
  const destroyedPixels = litCount(PNG.sync.read(await page.screenshot()));

  await page.evaluate((age) => window.__FX_HIT__('stone', [0, 1, 0], age, { destroyed: false }), sampleAge);
  const intactPixels = litCount(PNG.sync.read(await page.screenshot()));

  // 白闪此时已结束，画面里只剩下粒子：
  // 破坏开启是一整簇碎块；关闭只有几粒粉尘（尺寸 ×0.6、低速）。
  // 负向锚点：破坏关闭时仍发整簇碎块 → 两者接近 → 这条 FAIL。
  expect(destroyedPixels, `破坏开启须有碎块：${destroyedPixels}`).toBeGreaterThan(60);
  expect(destroyedPixels - intactPixels,
    `破坏关闭须显著更少粒子：destroyed=${destroyedPixels} intact=${intactPixels}`)
    .toBeGreaterThan(20);
});

test('命中特效：MAG7 只出白闪，不出碎块（碎块散落已按用户要求去掉）', async ({ page }) => {
  await bootFixture(page);
  const mag7 = await page.evaluate(() => {
    window.__FX_HIT__('stone', [0, 1, 0], 300, { weaponId: 'mag7' });
    return window.__FX_STATS__();
  });
  const pistol = await page.evaluate(() => {
    window.__FX_HIT__('stone', [0, 1, 0], 300, { weaponId: 'pistol' });
    return window.__FX_STATS__();
  });
  // 300ms：白闪都已结束 → 剩下的是纯碎块口径
  expect(pistol.activeDebris, `手枪须出碎块：${pistol.activeDebris}`).toBeGreaterThan(0);
  expect(pistol.debrisVisible, '手枪的碎块网格须可见').toBe(true);
  // 负向锚点：把 mag7 的 debrisCount 改回 >0（或恢复旧的 16 块）→ 这两条 FAIL
  expect(mag7.activeDebris, `MAG7 不得出碎块：${mag7.activeDebris}`).toBe(0);
  expect(mag7.debrisVisible, 'MAG7 的碎块网格须保持不可见（零实例 → draw call 回基线）').toBe(false);
  // 白闪两者都有（MAG7 唯一的命中反馈）
  const flashAlive = await page.evaluate(() => {
    window.__FX_HIT__('stone', [0, 1, 0], 5, { weaponId: 'mag7' });
    return window.__FX_STATS__().visibleFlashes;
  });
  expect(flashAlive, 'MAG7 须有白闪').toBe(1);
});

test('命中特效 Tier 4：MAG7 白闪波浪逐个亮起（不是同一时刻全部出现）', async ({ page }) => {
  const stats = await bootFixture(page);
  expect(stats.whiteFlashStaggerMs, '扩散时长须为 150ms（用户 2026-10-23 由 600ms 下调）').toBe(150);
  expect(stats.flashSlots, '白闪池须装得下一次 MAG7 的全部格').toBeGreaterThanOrEqual(40);

  // 40 格 = MAG7 扫描上限（4×4 阵列逐层向 -z 后退）。采样时间轴铺满整个 150ms 波浪。
  //
  // ⚠️ 判据必须用「**已启动格数**」而不是「可见白闪数」（实测枚坑）：后者是
  // 「进入 − 消退」的净流水（实测剖面 `1,9,10,10,9,4`），毫无单调性。
  // ⚠️ 150ms 波浪下 40 格每格仅隔 3.8ms（120Hz 下约 2 格/帧）→ 采样步长必须细于它，
  // 否则「已启动格数」会跳大步（旧 600ms 口径下 10ms 步长够用，这里仍够，但相位要重算）。
  const wave = await page.evaluate(() =>
    window.__FX_WAVE__(40, [0, 75, 150, 400, 700]));
  const [t0, , , , t700] = wave.visible;

  // ① 最关键的一条（用户抱怨的就是这个）：命中瞬间**不是**全部 40 格同时亮。
  //    负向锚点：去掉 `staggerTimes`（全部 `now`）→ 这里就是 40 → 真 FAIL。
  expect(t0, `t=0 不得全部亮起：${wave.visible}`).toBeLessThanOrEqual(3);
  expect(t0, `t=0 至少要有一格亮（否则打击感滞后）：${wave.visible}`).toBeGreaterThanOrEqual(1);
  // ② 扩散进度：已启动格数随时间递增到满额（「逐个亮起」的直接证据）。
  //    ⚠️ 采样窗必须覆盖「波浪结尾 + 末格淡出」= staggerMs(150) + totalMs(150) = 300ms，
  //    否则末格还在淡出段（实测只采到 200ms 时尾部还残留 26 个）。
  const prog = await page.evaluate(() => {
    const ages = [];
    for (let t = 0; t <= 320; t += 2) ages.push(t);
    const r = window.__FX_WAVE__(40, ages);
    return { ages, started: r.started, visible: r.visible };
  });
  const s0 = prog.started[0];
  // 150ms 中途（= 波浪中点 75ms）应已启动约一半；边界给宽（±12 格），只钉「真的在推进」
  const sMid = prog.started[Math.round(75 / 2)];
  const sEnd = prog.started[Math.round(160 / 2)];
  expect(s0, `t=0 已启动格数：${prog.started.slice(0, 4)}`).toBeLessThanOrEqual(2);
  expect(sMid, `75ms（波浪中点）须已启动相当一部分：${sMid}/40`).toBeGreaterThan(9);
  expect(sMid, `75ms 时须尚未全部启动：${sMid}/40`).toBeLessThan(37);
  expect(sEnd, `160ms 时 40 格须已全部启动：${sEnd}`).toBe(40);
  // 已启动格数单调不减（波浪不会倒流）
  for (let i = 1; i < prog.started.length; i++) {
    expect(prog.started[i] >= prog.started[i - 1],
      `已启动格数须单调不减：${prog.started[i - 1]} → ${prog.started[i]}`).toBe(true);
  }
  // ③ 同时刻启动的格数极少（不是一批一批、更不是全量）。
  //    2ms 采样粒度下 40 格 / 150ms ≈ 0.53 格/ms → 每采样点最多 2 格。
  let maxJump = 0;
  for (let i = 1; i < prog.started.length; i++) maxJump = Math.max(maxJump, prog.started[i] - prog.started[i - 1]);
  expect(maxJump, `每 2ms 至多启动几格：实测 ${maxJump}`).toBeLessThanOrEqual(3);
  // ④ 可见数峰值须不在第 0 个采样点（不是全程同步亮；负向锚点：全部同时启动时峰值就在 t=0）
  const peak = Math.max(...prog.visible);
  const peakIndex = prog.visible.indexOf(peak);
  expect(peakIndex * 2, `峰值须在命中之后：第 ${peakIndex} 个采样点（步长 2ms）`).toBeGreaterThan(0);
  // ⑤ 波浪结束后必须归零（白闪不会永远驻留；负向锚点：不过期 → 残留 40）
  expect(Math.min(...prog.visible.slice(-10)),
    `320ms 末段须已全部消退：尾部 ${prog.visible.slice(-10)}`).toBe(0);
  expect(t700).toBe(0);
});

test('命中特效：加特林连射累积热度，碎块逐发变多（真实路径）', async ({ page }) => {
  await bootFixture(page);
  // fixture 的 `__FX_SEQUENCE__` 走真实 spawn 路径逐发命中（间距 70ms = 加特林冷却）
  const seq = await page.evaluate(() => window.__FX_SEQUENCE__('minigun', 4, 70));
  expect(seq.counts.length).toBe(4);
  // 热度累积：第 1 发无加成，第 4 发明显更多碎块（profile.debrisCount + round(heat×4)）
  expect(seq.heats[0], `首发热度应为基础值：${seq.heats}`).toBeGreaterThan(0);
  expect(seq.heats[3], `连射后热度须更高：${seq.heats}`).toBeGreaterThan(seq.heats[0]);
  expect(seq.counts[3], `连射后碎块须更多：${seq.counts}`).toBeGreaterThan(seq.counts[0]);
});
