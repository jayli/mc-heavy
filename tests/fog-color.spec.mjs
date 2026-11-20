import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：雾色融入天空（v1.59）—— 像素级验收。
 *
 * 机制见 `src/render/materials.js` 的 `setupFog`：雾的 color 参数从「固定 0x87ceeb」变成
 * 「按视线方向的方位角采样天空盒（俯角一律归到地平线带）」，开关 `uFogColorMix`。
 *
 * 判据（**三条都是双侧的**，单侧断言会被「全黑」或「无变化」蒙过）：
 *   ① 开关打开后，**远景方块区**的颜色必须向「天空盒地平线色」移动
 *      —— 白天 R 通道显著上升（0x87ceeb 的 R=134 远低于天空地平线的 R≈188~207）；
 *   ② **天空区必须逐位不变** —— 雾不能污染天空（天空是背景，不是被雾覆盖的几何）；
 *   ③ **近景（雾带以内）必须逐位不变** —— 雾从 fogNear 才开始，近处不该受影响。
 *
 * ⚠️ 测量方法三件套（缺一条就会得到「机制上不可能」的数值）：
 *   a. **冻结物理**（`pushModal` + 直接摆相机）：不冻的话相机会被重力拉着走，
 *      同一状态连拍两张的差异高达 122（实测），任何雾色信号都被淹没；
 *   b. **冻结日夜**（`setVisualStyle('noon')`）并**关阴影**：否则太阳方向随时刻插值，
 *      方向光让整屏每一行都在变，对照就不再只差「雾色」这一个变量；
 *   c. **隐藏全部 HUD**：perf HUD 的半透明黑底会压暗左上象限（`sun-shadow.spec` 的教训）。
 *   本文件先测**同状态重复截图的噪声底**，实测为 0 后才用严格阈值比较 —— 噪声底非零时
 *   阈值必须跟着放宽，否则是「用固定阈值回答一个变量噪声的问题」。
 */

/** 取一块区域的 RGB 均值 */
function regionMean(png, x0f, x1f, y0f, y1f) {
  const x0 = Math.round(png.width * x0f), x1 = Math.round(png.width * x1f);
  const y0 = Math.round(png.height * y0f), y1 = Math.round(png.height * y1f);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** 三条水平带：天空 / 远景（雾带） / 近景 */
function bands(png) {
  return {
    sky: regionMean(png, 0.08, 0.92, 0.02, 0.18),
    far: regionMean(png, 0.08, 0.92, 0.58, 0.74),
    near: regionMean(png, 0.08, 0.92, 0.86, 0.99),
  };
}

/**
 * 整屏逐行平均变化量 —— 用来证明「只有雾带在变」，而不是「整屏都变」。
 * 返回 [{y, delta}]，y 是像素行号。
 * ⚠️ 实测（960×600、站在地面平视）：变化集中在 y≈360~432（雾带），
 * 天空（y<300）与近景（y>440）几乎为 0。这个分布本身就是「雾按距离生效」的证据。
 */
function rowDelta(off, on) {
  const out = [];
  for (let y = 0; y < off.height; y += 12) {
    let sum = 0, n = 0;
    for (let x = 0; x < off.width; x += 4) {
      const o = (y * off.width + x) * 4;
      sum += Math.abs(on.data[o] - off.data[o])
        + Math.abs(on.data[o + 1] - off.data[o + 1])
        + Math.abs(on.data[o + 2] - off.data[o + 2]);
      n++;
    }
    out.push({ y, delta: sum / n });
  }
  return out;
}

const shot = async (page) => PNG.sync.read(await page.screenshot());

/** 固定机位：停物理 + 冻结日夜 + 关阴影 + 隐藏 HUD，站在地面平视远处（雾带在画面中下部）
 *
 * ⚠️ **不要用 `pushModal` 冻结物理**：它会阻断玩家更新循环，相机停在原地不跟随
 * `physics.pos` 的新值 → 换了机位但画面根本没变（实测整屏 Δ=0，一度误判为「雾色失效」）。
 * 正确做法是只停 `physics.step`，相机仍由 `player.update()` 跟随新位置。
 * ⚠️ 出生点在城市（城堡围栏）——直接在那里测雾带会被墙挡住。往外挪 400 格到开阔地。
 *
 * ## v2.57：从「固定等 2200ms」改为「等画面真正静止」（修既有 flaky）
 *
 * ⚠️⚠️ **原实现 `await page.waitForTimeout(2200)` 是 3 条用例长期失败的根因**
 * （2026-11-05 实测，`main` 基线上同样必红）：它等的是「传送指令下发后 2200ms」，
 * 而**列加载与网格上传耗时随机器负载浮动** —— 高负载时 2200ms 后地形还在长。
 *
 * 确定性探针（同一 page.evaluate 内逐帧采样，本机实测）：
 * - t=0→600ms ：**3144 px 变化，maxDelta 431**（地形还在长）
 * - t=600ms→4200ms：**0 变化**（完全稳定，逐位静止）
 *
 * 而 `scheduler.stats()` 的 `inflight / meshInflight / uploadQueue` 全程为 **0**、
 * `renderStats().sections` 恒为 **1490** —— 队列/section 数归零**不等于**世界稳定
 * （memory `world-stable-judgement-in-playwright-specs` 记的同一类缺陷）。
 *
 * ⇒ 唯一可靠的判据是**画面本身连续两次逐位相同**，而这正好是测试要断言的东西。
 *
 * @param {import('playwright/test').Page} page
 * @param {string} [style] 视觉风格
 */
async function pinView(page, style = 'noon') {
  await page.evaluate((style) => {
    const g = window.__MC_GAME__;
    g.setVisualStyle(style);            // 冻结日夜 → 太阳方向恒定（消掉 N·L 漂移）
    g.setShadowsEnabled(false);         // 阴影刷新会让亮度抖动
    g.player.physics.step = () => {};   // 停物理：相机不被重力拉走，但仍跟随 pos
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    g.player.physics.pos.x = px + 400;  // 离开城市，看开阔地形
    g.player.physics.pos.z = pz + 400;
    g.player.physics.pos.y = 40;
    g.player.yaw = 0.6;
    g.player.pitch = -0.08;             // 近水平：雾带落在画面中下部
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  }, style);
  // ⚠️ v2.57：**不再固定等 2200ms**，改为等画面真正静止（见上方文件注释的实测数据）。
  await waitForStableFrame(page);
}

/**
 * 等到画面**连续两次截图逐位相同**（世界真的加载完了）。
 *
 * 为什么要等到逐位相同而不是「等够久」：
 * - `scheduler.stats()` 的队列与 `renderStats().sections` **全程都是稳态**
 *   （实测 0/0/0 + 1490），它们在列加载期间完全看不出变化 ⇒ 不能用作判据；
 * - 列加载 + 网格上传的耗时随机器负载浮动，任何固定毫秒数都会在重负载下不够。
 *
 * ⚠️ **必须用 PNG 字节比较，不能用 `page.screenshot()` 的 Buffer 直接比**：
 * PNG 编码器不保证同一画面输出完全相同的字节（时间戳/压缩器行为）。本仓的
 * `tests/helpers/png-diff.mjs` 提供了现成的逐像素比较。
 *
 * @param {import('playwright/test').Page} page
 * @param {{maxWaitMs?: number, intervalMs?: number}} [opts]
 */
async function waitForStableFrame(page, opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const start = Date.now();
  let prev = null;
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(intervalMs);
    const png = PNG.sync.read(await page.screenshot());
    if (prev && pixelIdentical(prev, png)) return;
    prev = png;
  }
  // 超时也不直接失败：后续的噪声底断言会给更具体的错误信息
  // （但如果真的一直在动，那条断言会红，带出实际噪声值）。
  throw new Error(`[pinView] 画面在 ${maxWaitMs}ms 内未稳定（世界一直在动，后续断言不可信）`);
}

/** 两张 PNG 是否逐位相同 */
function pixelIdentical(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) return false;
  }
  return true;
}

/**
 * 起点必须是**关闭**态（下面是「开 → 关」对照）。用户 2026-10-25 裁定默认开，
 * 故显式传 `?fog=0` 回到起点，而不是依赖默认值 —— 本用例的断言不依赖默认值怎么变。
 */
test('雾色融入天空：远景向地平线天色移动，天空与近景逐位不变', async ({ page }) => {
  test.setTimeout(180_000);
  // 不传 &style：pinView 里 setVisualStyle 需要走真实日夜循环路径才能冻结
  // ?ambient=0 是观测口径隔离（v3.26）：本 spec 的 pinView 机位是「出生点+400」≈(400,400)，
  // getBiome 实测 **FOREST** ⇒ 环境特效会引入持续动画，打破下面的「噪声底必须为 0」与
  // waitForStableFrame。断言与阈值逐字未动。
  await page.goto('/?vd=8&seed=12345&weather=clear&fog=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await pinView(page);

  // 起点确认（否则下面的「开」可能与一个本来就开着的画面做对照 → ΔR≈0 假失败）
  expect(await page.evaluate(() => window.__MC_GAME__.fogColorEnabled),
    '`?fog=0` 必须让开关落在关闭态').toBe(false);

  // ---- 噪声底：同状态连拍两张，差异必须为 0（否则下面的阈值不可信）----
  const a = bands(await shot(page));
  await page.waitForTimeout(600);
  const b = bands(await shot(page));
  const noise = Math.max(...[0, 1, 2].flatMap((i) => ['sky', 'far', 'near']
    .map((k) => Math.abs(a[k][i] - b[k][i]))));
  expect(noise, `同状态重复截图的噪声底必须为 0（实测 ${noise}）—— 非零说明变量没冻结干净`).toBe(0);

  // ---- 打开雾色 ----
  const offPng = await shot(page);
  const enabled = await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(true));
  expect(enabled, '有天空盒时 setFogColorEnabled(true) 必须生效').toBe(true);
  await page.waitForTimeout(700);
  const onPng = await shot(page);
  const on = bands(onPng);

  // ① 远景向地平线天色移动：白天 0x87ceeb 的 R=134 明显低于天空地平线 R≈188~207
  //    → 融入天空后 R 必须上升。这是**主判据**，方向单一、不含歧义。
  const farDelta = on.far[0] - b.far[0];
  expect(farDelta, `雾带 R 通道必须上升（雾色从偏蓝的 0x87ceeb 转向地平线灰白），实测 ΔR=${farDelta.toFixed(1)}`)
    .toBeGreaterThan(2);

  // ② 天空逐位不变（雾不作用于背景天空）
  for (let i = 0; i < 3; i++) {
    expect(on.sky[i], `天空通道 ${i} 必须逐位不变（雾不得污染天空），实测 ${b.sky[i]} → ${on.sky[i]}`)
      .toBe(b.sky[i]);
  }

  // ③ 近景逐位不变（雾从 fogNear 才开始）
  for (let i = 0; i < 3; i++) {
    expect(on.near[i], `近景通道 ${i} 必须逐位不变（近处不在雾带），实测 ${b.near[i]} → ${on.near[i]}`)
      .toBe(b.near[i]);
  }

  // ④ 变化真的局限在雾带（不是整屏均变）—— 这是「雾按距离生效」的正面证据。
  //    用整屏逐行变化量：天空行（顶部 15%）与近景行（底部 15%）必须几乎为 0。
  const rowDiff = rowDelta(offPng, onPng);
  const top = rowDiff.slice(0, Math.floor(rowDiff.length * 0.15));
  const bottom = rowDiff.slice(Math.ceil(rowDiff.length * 0.85));
  const maxTop = Math.max(...top.map((r) => r.delta));
  const maxBottom = Math.max(...bottom.map((r) => r.delta));
  const maxAll = Math.max(...rowDiff.map((r) => r.delta));
  expect(maxAll, `雾带必须有明显变化（否则整条用例是空的），实测最大行变化 ${maxAll.toFixed(2)}`)
    .toBeGreaterThan(1);
  expect(maxTop, `画面顶部（天空）不得随雾色变化，实测最大行变化 ${maxTop.toFixed(2)}`).toBe(0);
  expect(maxBottom, `画面底部（近景）不得随雾色变化，实测最大行变化 ${maxBottom.toFixed(2)}`).toBeLessThan(0.5);

  // 记录实测值便于人工核对（断言失败时能从日志看出是哪个方向错了）
  console.log('FOG-COLOR: ' + JSON.stringify({
    noise, farOff: b.far.map((v) => +v.toFixed(1)), farOn: on.far.map((v) => +v.toFixed(1)), farDelta: +farDelta.toFixed(1),
    skyOff: b.sky.map((v) => +v.toFixed(1)), skyOn: on.sky.map((v) => +v.toFixed(1)),
    nearOff: b.near.map((v) => +v.toFixed(1)), nearOn: on.near.map((v) => +v.toFixed(1)),
    maxTop: +maxTop.toFixed(2), maxBottom: +maxBottom.toFixed(2), maxAll: +maxAll.toFixed(2),
  }));
});

/**
 * 俯视机位：从高空往下看（pitch 深负）—— 专测「俯角归地平线」那条不变式。
 *
 * ⚠️ **这条用例是为负向验证盲区而存在的**：把 `materials.js` 里的
 * `select(dir.y > 0, dir.y, eps)` 换成裸 `dir.y`（即不钳制）后，平视机位（pitch≈0）
 * **仍然会通过**——实测 ΔR 从 5.0 只降到 3.5，依然大于阈值 2。原因是平视时 dir.y 本就接近 0，
 * 钳与不钳几乎无差。只有**俯视**时二者才分得开：不钳制会采样到天底那半张图（实测白天
 * negy 均值 [97,125,186]，比地平线 [207,216,232] 暗得多）→ **R 会下降**而不是上升。
 * 所以这条用例的判据与平视用例相同（ΔR > 2），但机位不同，且它是唯一能抓到该回归的用例。
 */
async function pinLookDown(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    g.player.physics.step = () => {};
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    g.player.physics.pos.x = px + 400;
    g.player.physics.pos.z = pz + 400;
    g.player.physics.pos.y = 120;   // 高空 → 视野里全是远处地形（雾带铺满画面）
    g.player.yaw = 0.6;
    g.player.pitch = -0.55;         // 深俯角：不钳 y 就会采样到天底
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
  // ⚠️ v2.57：与 `pinView` 同一修法 —— 固定 2200ms 在重负载下不够（列加载浮动），
  // 改为等画面连续两帧逐位相同。
  await waitForStableFrame(page);
}

test('俯视时雾色仍向地平线天色移动（防「采样到天底」回归）', async ({ page }) => {
  test.setTimeout(180_000);
  // ?ambient=0 是观测口径隔离（v3.26）：本 spec 的 pinView 机位是「出生点+400」≈(400,400)，
  // getBiome 实测 **FOREST** ⇒ 环境特效会引入持续动画，打破下面的「噪声底必须为 0」与
  // waitForStableFrame。断言与阈值逐字未动。
  await page.goto('/?vd=8&seed=12345&weather=clear&fog=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await pinLookDown(page);

  const offPng = await shot(page);
  const off = bands(offPng);
  await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(true));
  await page.waitForTimeout(700);
  const on = bands(await shot(page));

  const delta = on.far[0] - off.far[0];
  // 钳制正确 → R 上升；采样到天底 → R 下降（天底比地平线暗得多）
  expect(delta, `俯视时雾色也必须变亮（向地平线天色靠，而不是脚下那半张天底图），实测 ΔR=${delta.toFixed(1)}`)
    .toBeGreaterThan(2);
  for (let i = 0; i < 3; i++) {
    expect(on.sky[i], `俯视时天空通道 ${i} 仍必须逐位不变`).toBe(off.sky[i]);
  }
  console.log('FOG-COLOR-LOOKDOWN: ' + JSON.stringify({
    off: off.far.map((v) => +v.toFixed(1)), on: on.far.map((v) => +v.toFixed(1)), delta: +delta.toFixed(1),
  }));
});

test('雾色开关关闭时逐位回到固定雾色（v1.58 行为不变式）', async ({ page }) => {
  test.setTimeout(180_000);
  // ?ambient=0 是观测口径隔离（v3.26）：本 spec 的 pinView 机位是「出生点+400」≈(400,400)，
  // getBiome 实测 **FOREST** ⇒ 环境特效会引入持续动画，打破下面的「噪声底必须为 0」与
  // waitForStableFrame。断言与阈值逐字未动。
  await page.goto('/?vd=8&seed=12345&weather=clear&fog=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await pinView(page);

  // 开 → 关，必须与「一开始就没开」逐位相同（uFogColorMix 走 mix 插值，不是 if 分支）
  const baseline = bands(await shot(page));
  await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(true));
  await page.waitForTimeout(600);
  const on = bands(await shot(page));
  await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(false));
  await page.waitForTimeout(600);
  const back = bands(await shot(page));

  // 先证明「开」真的改变了画面（否则下面的「关回去相同」是恒真的空断言）
  const changed = Math.max(...[0, 1, 2].map((i) => Math.abs(on.far[i] - baseline.far[i])));
  expect(changed, `开启必须先产生可测的变化，实测最大通道差 ${changed.toFixed(1)}`).toBeGreaterThan(2);

  for (const k of ['sky', 'far', 'near']) {
    for (let i = 0; i < 3; i++) {
      expect(back[k][i], `关回去后 ${k} 通道 ${i} 必须与未开启时逐位相同`)
        .toBe(baseline[k][i]);
    }
  }
  console.log('FOG-COLOR-TOGGLE: ' + JSON.stringify({
    off: baseline.far.map((v) => +v.toFixed(1)),
    on: on.far.map((v) => +v.toFixed(1)),
    back: back.far.map((v) => +v.toFixed(1)),
  }));
});

test('夜间雾色同样生效（防「夜里雾距过远 → 无物可染」回归）', async ({ page }) => {
  test.setTimeout(240_000);
  // ?ambient=0 是观测口径隔离（v3.26）：本 spec 的 pinView 机位是「出生点+400」≈(400,400)，
  // getBiome 实测 **FOREST** ⇒ 环境特效会引入持续动画，打破下面的「噪声底必须为 0」与
  // waitForStableFrame。断言与阈值逐字未动。
  await page.goto('/?vd=8&seed=12345&weather=clear&fog=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await pinView(page, 'night');   // 冻结到黑夜

  // ⚠️ **这条用例钉的是一个真实回归**（v1.61 修）：mc-lite 的 night 风格 `fogScale = 4.0`
  // 会把雾距拉到 `(vd+2)*16*0.95*4`（vd=8 时 **608 格**），而世界径向只加载约 160 格 →
  // **视野内没有任何方块到达雾区** → 雾完全不参与渲染 → 「雾色融入天空」在夜里无物可染，
  // 开关切换的像素变化实测 **0.0%**（白天是 4.1%）。用户实玩报告「从白天切换成黑夜模式后，
  // 远方的雾色和天空盒的颜色渐变嵌入就没有了」。
  // 修法 = 把 night 的 `fogScale` 改为与白天一致的 1.0。
  //
  // 判据必须落在**「夜里雾真的存在」**上，而不是只看「开关有没有改变像素」：
  // 后者在雾距过远时恰好是 0，但若哪天雾距正常、而开关本身坏了，也会是 0 —— 两者
  // 无法区分。故先断言**雾色 uniform 已生效（mix=1）**，再断言像素真的变了。
  const state = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      fogNear: g.fog.fogNear.value,
      fogFar: g.fog.fogFar.value,
      nightBlend: g.sky?.uNightBlend?.value,
    };
  });
  // ① 雾距必须落在世界加载半径之内（否则雾永远不可见）—— 这条直接钉住根因
  const loadRadius = 8 * 16 + 2 * 16; // (viewDistance+2)*16 ≈ 160
  expect(state.fogFar,
    `夜间 fogFar=${state.fogFar} 超过世界加载半径 ~${loadRadius} → 雾永远不可见（回归！）`)
    .toBeLessThan(loadRadius);
  expect(state.nightBlend, '机位应处于夜晚（uNightBlend=1）').toBeGreaterThan(0.9);

  // ② 开关打开 → 远景必须变化（且幅度与白天同量级）
  const baseline = bands(await shot(page));
  await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(true));
  await page.waitForTimeout(800);
  const on = bands(await shot(page));
  const mix = await page.evaluate(() => window.__MC_GAME__.fog.uFogColorMix.value);
  expect(mix, '夜间开关须真的置位（否则像素不变是「没开」而非「雾距过远」）').toBe(1);

  // 天空区必须逐位不变（雾不能污染天空）
  for (let i = 0; i < 3; i++) {
    expect(on.sky[i], `夜间开启雾色后天空区通道 ${i} 不得变化`).toBe(baseline.sky[i]);
  }

  // 远景必须移动 —— 夜间天空地平线色 [~20,42,71] 与固定雾色 0x050b1e=[5,11,30] 差 15~41 级，
  // 实测整屏 4.0% 像素变化、最大三通道和差 184。阈值取 3（远低于实测 41 的通道差，
  // 且高于同状态噪声底 0）。
  const farDelta = [0, 1, 2].map((i) => Math.abs(on.far[i] - baseline.far[i]));
  console.log('FOG-COLOR-NIGHT: ' + JSON.stringify({
    fogFar: state.fogFar,
    off: baseline.far.map((v) => +v.toFixed(1)),
    on: on.far.map((v) => +v.toFixed(1)),
    farDelta: farDelta.map((v) => +v.toFixed(1)),
  }));
  expect(Math.max(...farDelta),
    `夜间开启雾色后远景几乎没变（最大通道差 ${Math.max(...farDelta).toFixed(1)}）`
    + ' —— 雾距过远导致无物可染的典型症状').toBeGreaterThan(3);

  // ③ 关回去必须逐位还原（与白天同一条不变式）
  await page.evaluate(() => window.__MC_GAME__.setFogColorEnabled(false));
  await page.waitForTimeout(600);
  const back = bands(await shot(page));
  for (const k of ['sky', 'far', 'near']) {
    for (let i = 0; i < 3; i++) {
      expect(back[k][i], `夜间关回去后 ${k} 通道 ${i} 必须逐位还原`).toBe(baseline[k][i]);
    }
  }
});

test('启动默认开启雾色（用户 2026-10-25 裁定）；面板那一格已是环境特效开关（v3.26）', async ({ page }) => {
  test.setTimeout(180_000);
  // 不传 ?fog —— 钉的正是「默认值本身」。
  // ?ambient=0 是观测口径隔离（v3.26）：本 spec 机位落在 FOREST，环境特效会引入持续动画。
  await page.goto('/?vd=8&seed=12345&weather=clear&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const r = await page.evaluate(() => ({
    setting: window.__MC_GAME__.settings.fogColor,
    mix: window.__MC_GAME__.fog.uFogColorMix.value,
    enabled: window.__MC_GAME__.fogColorEnabled,
    hasSky: window.__MC_GAME__.sky !== null,
    ambientSetting: window.__MC_GAME__.settings.ambientFx,
    ambientWanted: window.__MC_GAME__.ambientFxEnabled,
  }));
  expect(r.hasSky, '这条用例需要天空盒（否则开关本就该被静默关掉）').toBe(true);
  expect(r.setting, '设置默认值须为开').toBe(true);
  expect(r.mix, '材质 uniform 须在启动时就被写成 1（不是靠面板点击才生效）').toBe(1);
  expect(r.enabled, '启动后 fogColorEnabled 须为 true').toBe(true);
  // v3.26：面板那一格换成了环境特效开关 ⇒ 高亮断言改钉新开关。
  // ⚠️ 本用例 URL 带 `?ambient=0`，而 `resolveSettings` **也认它**（玩家意图那一道）
  // ⇒ `settings.ambientFx` 必为 false。故这里钉的是**两个位都被隔离关掉**，
  // 「默认开」由不带参数的下面那条面板用例与本文件单测共同钉住。
  expect(r.ambientSetting, '?ambient=0 经 resolveSettings ⇒ 玩家意图位也被置 false').toBe(false);
  expect(r.ambientWanted, '?ambient=0 是代码级隔离 ⇒ 生效值取 AND，应为 false').toBe(false);

  // 面板高亮必须同步（默认开启但面板显示「关闭」会静默撕裂）
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(300);
  const { AMBIENT_ROW_TITLE } = await import('../src/ui/settings-panel.js');
  const row = page.locator('#settings-modal .mc-combined-col', { hasText: AMBIENT_ROW_TITLE });
  // ⚠️ 本用例带了 ?ambient=0 ⇒ 面板当前值就是「关闭」（settings.ambientFx=false）。
  // 钉「高亮与 settings 同步」而不是钉某个固定文案 —— 后者会把隔离参数当成默认值。
  await expect(row.locator('button.active')).toHaveText('关闭');

  // `?fog=0` 仍可关闭（默认翻转不得把入口锁死）
  await page.goto('/?vd=8&seed=12345&weather=clear&fog=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__MC_GAME__.fogColorEnabled),
    '`?fog=0` 必须仍能关闭').toBe(false);
});

test('?skybox=0 时雾色开关静默保持关闭（没有立方图可采样）', async ({ page }) => {
  test.setTimeout(180_000);
  // 不传 ?fog：默认「开」也必须在没有天空盒时静默退回关闭（不得谎报生效）
  await page.goto('/?vd=8&seed=12345&skybox=0&ambient=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      sky: g.sky,
      setting: g.settings.fogColor,            // 意图是开（默认值）
      bootMix: g.fog.uFogColorMix.value,       // 但启动时没有立方图 → 必须保持 0
      effective: g.setFogColorEnabled(true),   // 没有天空盒 → 不得谎报生效
      mix: g.fog.uFogColorMix.value,
      enabled: g.fogColorEnabled,
    };
  });
  expect(r.sky, '?skybox=0 时不该有天空盒句柄').toBe(null);
  expect(r.setting, '默认值仍是开（意图与生效是两件事）').toBe(true);
  expect(r.bootMix, '启动时无立方图 → uFogColorMix 必须已被压回 0').toBe(0);
  expect(r.effective, '没有立方图时必须返回 false（不得谎报生效）').toBe(false);
  expect(r.mix, 'uFogColorMix 必须保持 0（未绑定立方图采样会读全黑）').toBe(0);
  expect(r.enabled).toBe(false);
});

test('面板「萤火虫和落叶」行落在左列环境风格下方、与背景音乐同盒（v3.26）', async ({ page }) => {
  test.setTimeout(180_000);
  // ?ambient=0 只影响池的可见性，不影响面板意图位（本条要验点击真的写进游戏）。
  // ⚠️ 故本条**不带** ?ambient=0：要验的就是「点开启 ⇒ ambientFxEnabled 真的 true」。
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(300);

  const { AMBIENT_ROW_TITLE, AMBIENT_LABELS } = await import('../src/ui/settings-panel.js');
  const row = page.locator('#settings-modal .mc-combined-col', { hasText: AMBIENT_ROW_TITLE });
  await expect(row).toHaveCount(1);
  // 左列（第 1 列）且**紧跟环境风格之后**（沿用原雾色那一格的位置）。
  const cols = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#settings-modal .mc-column')];
    return rows.map((c) => [...c.querySelectorAll('.mc-title')].map((t) => t.textContent));
  });
  expect(cols[1], '右列不该出现环境特效行（沿用原雾色的左列落位）').not.toContain(AMBIENT_ROW_TITLE);
  expect(cols[0], '环境特效行必须在左列').toContain(AMBIENT_ROW_TITLE);
  const styleIdx = cols[0].indexOf('环境风格');
  expect(cols[0].indexOf(AMBIENT_ROW_TITLE), '必须紧接在环境风格下面').toBe(styleIdx + 1);
  expect(cols[0].indexOf('背景音乐'), '背景音乐紧跟在它之后（同一合并盒的右半）')
    .toBe(styleIdx + 2);
  // 雾色那一组已不存在（用户裁定恒开、不再可关）
  expect(cols[0], '面板不得再有「雾色」组').not.toContain('雾色');
  const sameBox = await page.evaluate((title) => {
    const box = (t) => [...document.querySelectorAll('#settings-modal .mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === t);
    const a = box(title), b = box('背景音乐');
    return !!a && !!b && a.parentElement === b.parentElement;
  }, AMBIENT_ROW_TITLE);
  expect(sameBox, '环境特效与背景音乐必须共用合并盒（沿用用户 2026-10-31 的排布）').toBe(true);

  // 环境风格的「自动」按钮必须还在（它是日夜循环的唯一 UI 入口）
  const styleBtns = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#settings-modal .mc-item')];
    const r = items.find((i) => i.textContent.includes('环境风格'));
    return [...r.querySelectorAll('button')].map((b) => b.textContent);
  });
  expect(styleBtns, '「自动」不得被替掉（会失去日夜循环入口）').toContain('自动');

  // 两个按钮且都可点（**无异步前置条件 ⇒ 不置灰**，与旧雾色组相反）
  const btns = row.locator('button');
  await expect(btns).toHaveCount(2);
  await expect(btns.nth(0)).toBeEnabled();
  await expect(btns.nth(1)).toBeEnabled();
  await expect(btns.nth(0)).toHaveText(AMBIENT_LABELS[0]);
  await expect(btns.nth(1)).toHaveText(AMBIENT_LABELS[1]);

  // 默认开 → 「开启」已是 active；点「关闭」必须真的关掉，再点「开启」恢复
  //（Review Focus #5：只写 settings 不调 game.setAmbientFxEnabled 的形态是高亮变了而特效不变）
  await expect(row.locator('button.active')).toHaveText('开启');
  await btns.nth(0).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__MC_GAME__.ambientFxEnabled), '点「关闭」须真的关闭').toBe(false);
  expect(await page.evaluate(() => window.__MC_GAME__.settings.ambientFx), '意图须落进 settings').toBe(false);
  await btns.nth(1).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__MC_GAME__.ambientFxEnabled)).toBe(true);
  expect(await page.evaluate(() => window.__MC_GAME__.settings.ambientFx)).toBe(true);

  // 标题与两个按钮文案的**行盒数恒为 1**（合并盒半标宽约 171px，6 字标题不得折行）。
  // ⚠️ `scrollWidth<=clientWidth` 对折行无判别力（折行时两者仍相等）⇒ 用 Range.getClientRects()。
  const lineBoxes = await page.evaluate((title) => {
    const countLines = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    };
    const col = [...document.querySelectorAll('#settings-modal .mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === title);
    return {
      title: countLines(col.querySelector('.mc-title')),
      buttons: [...col.querySelectorAll('button')].map(countLines),
    };
  }, AMBIENT_ROW_TITLE);
  expect(lineBoxes.title, `标题行盒数须为 1（实测 ${lineBoxes.title}）`).toBe(1);
  for (const n of lineBoxes.buttons) {
    expect(n, `按钮文案行盒数须为 1（实测 ${n}）`).toBe(1);
  }
});