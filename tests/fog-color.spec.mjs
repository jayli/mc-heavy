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
 */
async function pinView(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');           // 冻结日夜 → 太阳方向恒定（消掉 N·L 漂移）
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
  });
  await page.waitForTimeout(2200);      // 等新位置的 column 加载完成（否则看到的是空洞）
}

test('雾色融入天空：远景向地平线天色移动，天空与近景逐位不变', async ({ page }) => {
  test.setTimeout(180_000);
  // 不传 &style：pinView 里 setVisualStyle 需要走真实日夜循环路径才能冻结
  await page.goto('/?vd=8&seed=12345&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await pinView(page);

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
  await page.waitForTimeout(2200);
}

test('俯视时雾色仍向地平线天色移动（防「采样到天底」回归）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8&seed=12345&weather=clear');
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
  await page.goto('/?vd=8&seed=12345&weather=clear');
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

test('?skybox=0 时雾色开关静默保持关闭（没有立方图可采样）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      sky: g.sky,
      effective: g.setFogColorEnabled(true),   // 没有天空盒 → 不得谎报生效
      mix: g.fog.uFogColorMix.value,
      enabled: g.fogColorEnabled,
    };
  });
  expect(r.sky, '?skybox=0 时不该有天空盒句柄').toBe(null);
  expect(r.effective, '没有立方图时必须返回 false（不得谎报生效）').toBe(false);
  expect(r.mix, 'uFogColorMix 必须保持 0（未绑定立方图采样会读全黑）').toBe(0);
  expect(r.enabled).toBe(false);
});

test('面板「雾色」行落在左列环境风格下方，且无天空盒时整组禁用', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.evaluate(() => document.getElementById('settings-btn').click());
  await page.waitForTimeout(300);

  const row = page.locator('#settings-modal .mc-item', { hasText: '雾色' });
  await expect(row).toHaveCount(1);
  // 左列（第 1 列）且**紧接在环境风格之后**（用户 2026-10-21 指定：同属观感）
  const cols = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#settings-modal .mc-column')];
    return rows.map((c) => [...c.querySelectorAll('.mc-title')].map((t) => t.textContent));
  });
  expect(cols[1], '右列不该出现「雾色」（已按用户要求挑到左列）').not.toContain('雾色');
  expect(cols[0], '「雾色」必须在左列').toContain('雾色');
  const styleIdx = cols[0].indexOf('环境风格');
  expect(cols[0].indexOf('雾色'), '「雾色」必须紧接在环境风格下面').toBe(styleIdx + 1);

  // 环境风格的「自动」按钮必须还在（它是日夜循环的唯一 UI 入口）
  const styleBtns = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#settings-modal .mc-item')];
    const r = items.find((i) => i.textContent.includes('环境风格'));
    return [...r.querySelectorAll('button')].map((b) => b.textContent);
  });
  expect(styleBtns, '「自动」不得被替掉（会失去日夜循环入口）').toContain('自动');

  // 有两个按钮且都可点（有天空盒时不置灰）
  const btns = row.locator('button');
  await expect(btns).toHaveCount(2);
  await expect(btns.nth(0)).toBeEnabled();

  // 打开后 active 落在「开启」上，且引擎侧真的生效
  await btns.nth(1).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__MC_GAME__.fogColorEnabled)).toBe(true);
});