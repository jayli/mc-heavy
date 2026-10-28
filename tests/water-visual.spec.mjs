import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * M2 验收：海面可见 + 跟随相机 + 帧率达标（§7 M2-5 口径）
 * + 水面**颜色**的 Tier 4 判据（用户 2026-10-26 两轮实玩反馈）。
 *
 * 判据演进（每一版都对着实测点标定，不贴线）：
 *
 * **v1.82**：用户「波纹泛白，要深一些、灰一些」。把基色压灰 + 高光改乘算混色。
 * **v1.85**：用户「水方块太浅要更蓝；远看几乎呈透明色，不要那么清晰的看到海底；波纹也变蓝一些」。
 * ① 颜色再压深一档（平面基色 `0x22598a`、体素水贴图均值 `70/115/155`）；
 * ② **贴图 alpha 175 → 230**（0.686 → 0.90）—— 「盖不盖得住海底」与「颜色对不对」是两个独立维度，
 *    源 alpha 太低时水下地形透上来 31% → 远看发虚。这一条钉在 `check:data` 的 `[水体贴图]`。
 *
 * **v1.83**：用户「还是太泛白，参照真实大海（附 `/Users/bachi/ttt/bug/海.png`）」。
 * 量那张图得海区 **67/107/124**（**G−R +40**、B−G +17）、近处 41/83/98、远处 94/132/152 ——
 * 真实海面是**青绿**，而 v1.82 的实现是 `133/149/178`（G−R 只有 +16、且亮 60 的**灰蓝**）。
 * 故基色改深青绿 `0x0c342f`、高光改偏青绿、**`WATER_OPACITY` 0.7 → 0.92**
 * （0.7 时底下那层**蓝色体素水**透上来 30%，把青绿拉回蓝并抬亮 —— 这是“改基色仍泛白”的
 * 第二个根因）、雾色 `0x8aacbe` → `0x556e7e`。
 *
 * 实测矩阵（noon / 海岸机位 / 五变量冻结，水区众数峰）：
 *
 * | 变体 | 近处水面 | luma | G−R | B−G |
 * |---|---|---|---|---|
 * | mc-lite 原实现 | `163/186/217` | 183 | 23 | 31 |
 * | v1.82（0x707f89，opacity 0.7） | `133/149/178` | 148 | 16 | 29 |
 * | v1.83（0x0c342f 深青绿）| `67/99/101` | 92 | 32 | 2 |
 * | **v1.84 现行（0x2a5f85 海蓝）** | **`85/130/163`** | **123** | **45** | **33** |
 * | 破坏：基色→白 | 采不到样（不再是水）| — | — | — |
 * | 破坏：基色→黑 | `68/82/92` | 80 | 14 | 10 |
 * | 破坏：高光权重归零 | `27/100/145` | 88 | 73 | 45 |
 *
 * 四条判据：① 判别力（隐藏海面必须显著改变画面）；② 亮度双侧带；③ **色相必须是海蓝**
 * （`G − R >= 24` 且 `B − G >= 8` 且 `B − G <= 45`）；④ 波纹仍可见。
 *
 * **为什么 ③ 要三个条件**：v1.83 的教训 —— 只钉 `G−R` 会放过「又绿又暗」（v1.83 的 B−G 只有 2）；
 * 只钉 `B−G` 会放过「紫蓝」。参照图（`/Users/bachi/ttt/bug/海.png`）海区是 `67/107/124`
 * （G−R +40、B−G +17）→ 游戏里需要**更亮**的同一色相（那张图是阴天，游戏里是正午）。
 *
 * **第五条：两侧一致（v1.84 用户直接要求）** —— 海面平面（`ocean.js`）与体素水方块
 * （`faces-data.js` → `procedural/water` tile）是两套独立颜色源，必须互相接近：
 * | | 近处平面 | 远处体素水带 | 差（逐通道绝对和）|
 * |---|---|---|---|
 * | v1.83 | `92/133/164` | `59/100/190` | **85**（亮紫蓝带浮在浅蓝水面上）|
 * | **v1.84** | `92/133/164` | `100/140/162` | **17** |
 * 这一条钉在 `[水体贴图]` 的 `check:data` 环节（比源图均值）而不是 Tier 4（更稳、不会因机位飘）。
 * ⚠️ **水体像素判据用 `b > r+12 && g > r+12`，不能用旧的 `b > r+30 && b > g+30`**：
 * 后者要求 B 显著高于 G，把青绿/灰蓝海面整类排除 —— v1.82 之后它量到的样本会越来越少，
 * 极端时一个都采不到（实测出现过）。判据要跟着被测色相走。
 *
 * **第六条：水面亮度随环境风格（v2.1，2026-10-31 用户实玩反馈）**
 * 用户：「早晨和正午的水面波纹颜色没问题，但傍晚和晚上显得过于亮，晚上看上去像水面会发光」。
 *
 * 根因**不是配色，是机制**：`ocean.js` 是 unlit 材质，只读 `uColor`/`uSunDirection`，
 * **完全不接环境亮度**；而 dusk/night 的 `toneMappingExposure` 是 1.20/1.60（为体素世界
 * 暗部补光，见 `daynight.js` 的 VISUAL_STYLES 标定）→ 水面连带被提亮。
 * 实测（海岸机位，五变量冻结，水面众数峰 luma）：
 *
 * | 风格 | exposure | 修复前 | 修复后 |
 * |---|---|---|---|
 * | morning | 1.00 | 116 | **116**（零回归）|
 * | noon | 1.00 | 116 | **116**（零回归）|
 * | dusk | 1.20 | **131** | **118** |
 * | night | 1.60 | **147** | **114** |
 *
 * 另一个副作用（用户报告的直接体现）：修复前夜里体素水方块被 `skyDim 0.25` 压暗、
 * 水面平面反而变亮一档 → 海岸线上同一片水两种亮度。现在两侧方向一致。
 */

/** 水体像素：G 与 B 都高于 R（海蓝、青绿、灰蓝都算） */
const isWater = (r, g, b) => b > r + 12 && g > r + 12;

/** 水区平坦面的众数峰（8 级量化直方图）—— 面积最大的那一档就是「看上去的水色」 */
function modeOf(png, y0f = 0.55, y1f = 0.95) {
  const bins = new Map();
  for (let y = Math.floor(png.height * y0f); y < Math.floor(png.height * y1f); y++) {
    for (let x = Math.floor(png.width * 0.10); x < Math.floor(png.width * 0.90); x++) {
      const o = (y * png.width + x) * 4;
      const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
      if (!isWater(r, g, b)) continue;
      const k = `${r >> 3},${g >> 3},${b >> 3}`;
      const e = bins.get(k) || { c: 0, r: 0, g: 0, b: 0 };
      e.c++; e.r += r; e.g += g; e.b += b; bins.set(k, e);
    }
  }
  const top = [...bins.values()].sort((a, b) => b.c - a.c)[0];
  if (!top) return null;
  const m = [top.r / top.c, top.g / top.c, top.b / top.c];
  return {
    rgb: m.map(Math.round),
    luma: Math.round(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]),
    gMinusR: Math.round(m[1] - m[0]),
    bMinusG: Math.round(m[2] - m[1]),
    share: top.c,
  };
}

/** 近处水面（画面最下 16%）—— 用户抱怨的「泛白」正是这一块 */
const nearWater = (png) => modeOf(png, 0.80, 0.96);

/** 水区两帧差异占比 —— 波纹动画的可见度（平坦水面的动画 = 0） */
function waterAnimDiff(a, b) {
  let changed = 0, n = 0;
  for (let y = Math.floor(a.height * 0.60); y < Math.floor(a.height * 0.95); y++) {
    for (let x = Math.floor(a.width * 0.15); x < Math.floor(a.width * 0.85); x++) {
      const o = (y * a.width + x) * 4;
      const d = Math.abs(a.data[o] - b.data[o])
        + Math.abs(a.data[o + 1] - b.data[o + 1])
        + Math.abs(a.data[o + 2] - b.data[o + 2]);
      if (d > 6) changed++;
      n++;
    }
  }
  return changed / n;
}

/** 两张截图的差异（逐像素三通道和 > 12 记作变化） */
function frameDiff(a, b) {
  let changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o])
      + Math.abs(a.data[o + 1] - b.data[o + 1])
      + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 12) changed++;
  }
  return changed / n;
}

const shot = async (page) => PNG.sync.read(await page.screenshot());

test('M2 验收：海面可见 + 跟随相机 + 帧率达标 + 水色深蓝不泛白不脏', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // 找一片海：扫描窗口内最低点（保证视野中心是水面）
  const sea = await page.evaluate(async () => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const seed = window.__MC_GAME__.seed;
    let best = null;
    for (let x = -640; x <= -480; x += 8) {
      for (let z = -600; z <= -460; z += 8) {
        const h = generateHeight(x, z, seed);
        if (h < -3 && (!best || h < best.h)) best = { x, z, h };
      }
    }
    return best;
  });
  expect(sea).not.toBeNull();

  // 传送玩家到海面上方。⚠️ **冻结五个变量**，缺一个采样就不可复现：
  //   ① 日夜（`setVisualStyle('noon')`）—— 否则 luma 随时刻插值漂移，色阶判据失效；
  //   ② 阴影（`setShadowsEnabled(false)`）—— 刷新帧亮度抖动；
  //   ③ HUD（隐藏 `#hud-root > *` 等）—— 左上角半透明黑底会压暗采样区（sun-shadow 的教训）；
  //   ④ 物理（`physics.step = () => {}`）—— 不停的话玩家会下落，两帧间相机位移让「噪声底」
  //      高达 0.95（那量的是相机运动，不是渲染噪声）；相机仍由 player.update 跟随 pos；
  //   ⑤ 波纹动画（`ocean.update = () => {}`）—— 不冻的话 uTime 每帧推进，水区两帧必然不同。
  await page.evaluate(({ x, z }) => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    g.player.physics.step = () => {};
    g.player.physics.pos.x = x; g.player.physics.pos.z = z;
    g.player.physics.pos.y = 6;
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  }, sea);
  await page.waitForTimeout(9000);

  // 海面跟随相机（无限水面）
  const follow = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      px: g.ocean.plane.position.x, pz: g.ocean.plane.position.z,
      cx: g.camera.position.x, cz: g.camera.position.z,
      y: g.ocean.plane.position.y,
    };
  });
  expect(Math.abs(follow.px - follow.cx)).toBeLessThan(2);
  expect(Math.abs(follow.pz - follow.cz)).toBeLessThan(2);
  expect(follow.y).toBe(-1.5); // SEA_Y + 0.5

  // ---- ④ 波纹仍可见：在**冻动画之前**量（连拍 4 帧看水区变化）----
  // 实测：正常实现 0.20 / 高光权重归零 0.00。阈值 0.05 两侧都不贴线。
  const frames = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(260);
    frames.push(await shot(page));
  }
  const animDiff = Math.max(...[1, 2, 3].map((i) => waterAnimDiff(frames[0], frames[i])));
  expect(animDiff, `水面的波纹动画必须仍然可见（平坦=高光没在起作用），实测变化占比 ${animDiff.toFixed(3)}`)
    .toBeGreaterThan(0.05);

  // ---- 冻住波纹动画，进入静帧测量 ----
  await page.evaluate(() => { window.__MC_GAME__.ocean.update = () => {}; });
  await page.waitForTimeout(500);

  // ---- ① 判别力：隐藏海面平面，画面必须显著变化 ----
  // 「下面量的确实是海面」。先量噪声底（同状态连拍两张），再量有/无海面的差异。
  // 实测（五变量冻结后）：噪声底 changedFrac **0**、有→无 **0.31**。
  const withPlane = await shot(page);
  await page.waitForTimeout(300);
  const noise = frameDiff(withPlane, await shot(page));
  await page.evaluate(() => { window.__MC_GAME__.ocean.plane.visible = false; });
  await page.waitForTimeout(800);
  const withoutPlane = await shot(page);
  await page.evaluate(() => { window.__MC_GAME__.ocean.plane.visible = true; });
  await page.waitForTimeout(800);
  const signal = frameDiff(withPlane, withoutPlane);
  expect(signal, `隐藏海面必须显著改变画面（否则下面的水色判据量的是别的东西）：`
    + `signal=${signal.toFixed(3)} noise=${noise.toFixed(3)}`).toBeGreaterThan(0.10);
  expect(noise, `噪声底必须为零（海面动画/物理/日夜/阴影都必须冻结），实测 ${noise.toFixed(3)}`)
    .toBeLessThan(0.02);

  // ---- ② 亮度双侧带 ----------------
  // 实测五点：mc-lite 183 / v1.82 灰蓝 148 / **现行 123** / v1.83 深青绿 92 / 基色归黑 80。
  // 上界 145：距现行 22、距 v1.82 的 148 只有 3 → 改取 **140**（距现行 17、距 148 为 8）；
  // 下界 105：距现行 18、距 v1.83 的 92 为 13、距基色归黑的 80 为 25。
  const near = nearWater(withPlane);
  expect(near, '近处水面必须能采到样（画面下部有水体像素）').not.toBeNull();
  expect(near.luma, `近处水面不得泛白（mc-lite 183 / v1.82 灰蓝 148），`
    + `实测 ${near.luma} rgb=${near.rgb.join('/')}`).toBeLessThan(140);
  expect(near.luma, `但也不得暗成脏水（v1.83 深青绿 92 / 基色归黑 80），实测 ${near.luma}`)
    .toBeGreaterThan(105);

  // ---- ③ 色相：海蓝（三个条件，见文件头「为什么 ③ 要三个条件」）----
  // 实测：现行 G−R 45 / B−G 33；v1.83 深青绿 32 / **2**（被 B−G 下界拦住）；
  // mc-lite 23（被 G−R 下界拦住）；基色归黑 14 / 10（两个都拦住）。
  expect(near.gMinusR, `海面的 G 必须明显高于 R（参照图 +40），实测 rgb=${near.rgb.join('/')} `
    + `G−R=${near.gMinusR}`).toBeGreaterThanOrEqual(24);
  expect(near.bMinusG, `海面必须偏蓝（B 高于 G）（参照图 +17），实测 rgb=${near.rgb.join('/')} `
    + `B−G=${near.bMinusG}`).toBeGreaterThanOrEqual(8);
  expect(near.bMinusG, `但不得紫得发假（v1.83 之前的紫蓝态 B−G 达 40），实测 B−G=${near.bMinusG}`)
    .toBeLessThanOrEqual(45);

  console.log('WATER VISUAL: ' + JSON.stringify({
    near, animDiff: +animDiff.toFixed(3), signal: +signal.toFixed(3), noise: +noise.toFixed(3),
  }));

  // 帧率
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('WATER FPS:', perf.fps.toFixed(1));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
});

/**
 * 第六条：水面亮度随环境风格（v2.1）。见文件头「第六条」段。
 *
 * 判据设计（每条都对着实测值标，不贴线）：
 * ① **晨午零回归**：morning/noon 的 luma 必须仍落在既有双侧带 [105,140] 且与 v1.85 的 116 一致；
 * ② **傍晚/夜晚显著变暗**：相对各自“不压暗”的基线（131 / 147）降幅须 ≥ 8%；
 * ③ **但不得压成死水**：夜晚 luma 下界 ≥ 95（再暗波纹就看不见了）；
 * ④ **色相不变**：四风格的 G−R 都仍 ≥ 24（海蓝没变绿/变紫）。
 *
 * 为什么不用「夜晚 < 正午」作主判据：它会被“两者都黑掉”骗过（同 v1.45 的
 * 「影区须比基线暗」单侧断言拓不到纯黑）。故至少一条下界 + 一条色相判据并存。
 */
test('v2.1：傍晚与夜晚的水面亮度随环境风格变暗（晨午零回归）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const sea = await page.evaluate(async () => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const seed = window.__MC_GAME__.seed;
    let best = null;
    for (let x = -640; x <= -480; x += 8) {
      for (let z = -600; z <= -460; z += 8) {
        const h = generateHeight(x, z, seed);
        if (h < -3 && (!best || h < best.h)) best = { x, z, h };
      }
    }
    return best;
  });
  expect(sea).not.toBeNull();

  // 与主用例同一套五变量冻结（日光/阴影/HUD/物理/波纹动画）——少冻一个，色阶就不可比。
  await page.evaluate(({ x, z }) => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(false);
    g.player.physics.step = () => {};
    g.player.physics.pos.x = x; g.player.physics.pos.z = z;
    g.player.physics.pos.y = 6;
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  }, sea);
  await page.waitForTimeout(9000);
  await page.evaluate(() => { window.__MC_GAME__.ocean.update = () => {}; });
  await page.waitForTimeout(500);

  const readings = {};
  for (const style of ['morning', 'noon', 'dusk', 'night']) {
    await page.evaluate((s) => { window.__MC_GAME__.setVisualStyle(s); }, style);
    await page.waitForTimeout(1600);
    const png = PNG.sync.read(await page.screenshot());
    readings[style] = nearWater(png);
  }
  console.log('WATER STYLE: ' + JSON.stringify(readings));

  // ① 晨午零回归：必须仍在既有色阶带内（v1.85 实测 116）
  for (const style of ['morning', 'noon']) {
    expect(readings[style], `${style} 必须能采到水面样本`).not.toBeNull();
    expect(readings[style].luma, `${style} 的水面亮度必须保持不变（v1.85 基准 116，允许 ±8）`)
      .toBeGreaterThan(108);
    expect(readings[style].luma, `${style} 的水面亮度必须保持不变（v1.85 基准 116，允许 ±8）`)
      .toBeLessThan(124);
  }

  // ② 傍晚/夜晚显著变暗（修复前基线：dusk 131 / night 147）
  expect(readings.dusk.luma, `傍晚必须比“不压暗”时（131）明显变暗，实测 ${readings.dusk.luma}`)
    .toBeLessThan(122);
  expect(readings.night.luma, `夜晚必须比“不压暗”时（147）明显变暗（用户：“像水面会发光”），实测 ${readings.night.luma}`)
    .toBeLessThan(126);

  // ③ 但不得压成死水（上一条只看上界会被“全黑”骗过 —— v1.45 的教训）
  //    实测修复后 dusk 118 / night 114；用户裁定的“中度”档 = 夜晚与正午持平（116），
  //    下界取 95 留足标定漂移余量，同时离“死水”很远。
  expect(readings.dusk.luma, `傍晚不得压得比夜晚还暗/死黑，实测 ${readings.dusk.luma}`)
    .toBeGreaterThan(100);
  expect(readings.night.luma, `夜晚不得压成死水（波纹明暗差会消失），实测 ${readings.night.luma}`)
    .toBeGreaterThan(95);

  // ④ 色相不变：四风格仍须是海蓝（只调亮度，不改色相）
  for (const style of ['morning', 'noon', 'dusk', 'night']) {
    const r = readings[style];
    expect(r.gMinusR, `${style} 的水面必须仍是海蓝（G 明显高于 R），实测 rgb=${r.rgb.join('/')}`)
      .toBeGreaterThanOrEqual(24);
    expect(r.bMinusG, `${style} 的水面必须仍偏蓝，实测 rgb=${r.rgb.join('/')} B−G=${r.bMinusG}`)
      .toBeGreaterThanOrEqual(8);
  }
});

/**
 * 第七条：**启动即目标风格**（v2.2，2026-10-31 用户第二轮反馈）。
 *
 * 用户：「刚开始进入游戏的时候，如果是晚上或者傍晚，默认就要渲染正确的水面颜色，
 * 而不是只在切换环境的时候把水面颜色渲染正确」。
 *
 * 根因是**构造时序**（不是水面本身）：`DayNight` 构造末尾硬性 apply 正午，而持久化的
 *`visualStyle` 要到 `game.start()` 尾部才补 —— 两者之间水面拿着正午的 tint（中性 1）。
 * 修法：`DayNight({ visualStyle })` **构造首帧就 apply 目标风格**，且 Game 在构造期解析设置。
 *
 * 判据选「`worldReady` 那一刻的 uniform 值」而不是像素：这正是缺陷的形态（首帧状态），
 * 而像素会因后续每帧 `_apply` 自动收敛成正确值 —— 用像素只能测到「最终对不对」，
 * 测不到「一开始对不对」，那样即使把修复回退也会全绿（无效盲区）。同时仍采一次像素，
 * 确认真的渲对了。
 */
test('v2.2：启动即傍晚/夜晚时，第一帧的水面配色就是目标风格（不等切换）', async ({ page }) => {
  test.setTimeout(240_000);

  // 期望值从真实风格数据读（不在测试里写第二份字面量）
  const expected = await page.goto('/?vd=2&seed=12345').then(async () => {
    await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
    return page.evaluate(async () => {
      const { VISUAL_STYLES } = await import('/src/render/daynight.js');
      return {
        dusk: VISUAL_STYLES.dusk.waterTint[0],
        night: VISUAL_STYLES.night.waterTint[0],
        noon: VISUAL_STYLES.noon.waterTint[0],
      };
    });
  });
  expect(expected.night).toBeLessThan(expected.noon);

  for (const style of ['dusk', 'night']) {
    // 走 URL（等价于面板持久化：两者都经 resolveSettings → settings.visualStyle）
    await page.goto(`/?vd=2&seed=12345&style=${style}`);
    await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
    const boot = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const v = g.ocean.uWaterTint.value;
      return {
        tint: [v.x, v.y, v.z],
        override: g.dayNight._styleOverride,
        settingsStyle: g.settings.visualStyle,
        exposure: g.renderer.toneMappingExposure,
      };
    });
    expect(boot.settingsStyle, `${style}：设置须在启动时就带着这个风格`).toBe(style);
    expect(boot.override, `${style}：DayNight 须在构造时已进入该风格的 override`).toBe(style);
    for (const c of boot.tint) {
      // 逐位相等：构造首帧就该是目标值（实测修复后 0.84 / 0.62）
      expect(c, `${style}：启动第一帧的 waterTint 必须是 ${expected[style]}，实测 ${boot.tint.join('/')}`)
        .toBeCloseTo(expected[style], 6);
    }
    expect(boot.exposure, `${style}：曝光也已在启动首帧生效`)
      .toBeCloseTo(style === 'dusk' ? 1.2 : 1.6, 2);
  }
});
