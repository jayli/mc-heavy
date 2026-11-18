import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（同 zombie-model.spec.mjs 手法） */
function regionRGB(png, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n, n, lum: (sr + sg + sb) / (3 * n) };
}

/** 区域内「背景色（近黑）」像素数 —— 炮管分离的直接证据 */
function backgroundPixels(png, cx, cy, r) {
  let bg = 0, tot = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      tot++;
      if (png.data[o] < 8 && png.data[o + 1] < 8 && png.data[o + 2] < 8) bg++;
    }
  }
  return { bg, tot };
}

/**
 * 炮塔塔顶 Tier 4 像素实测（v3.14：炮头去贴图 → 三档冷灰金属）。
 *
 * **为什么必须像素实测**：TSL 的 select 链与四项叠加都在 GPU 求值，单测读不到片元输出
 * （testing-policy §5.1）。单测只能钉住 tone 属性数值，无法证明 GPU 真的按那个档选了色。
 *
 * ⚠️⚠️ **本轮实测抓到的静默缺陷**：`vec3(new THREE.Color(hex))` 在 WebGPU 后端
 * **输出纯黑且零报错零警告** ⇒ 装甲 6 部件整片消失，而 tone 属性 / 值域 / 冻结表 /
 * 材质类型 / 集合关系式**全部通过**。只有像素能抓到它。正解是显式拆分量
 * `vec3(c.r, c.g, c.b)`（见 turret-metal.js 的注释与逐写法实测表）。
 *
 * **判据用「三档亮度递减 + 各档亮度区间 + 冷调」**，不用绝对色值单点：
 *
 * ⚠️ **取样点由 fixture 从产物几何 + 实例矩阵反解**，且按「面积降序 + 射线无遮挡」选面。
 * ⚠️ **档位由几何法线独立判定，不读产物 tone**（否则与被测代码共用同一个错误假设）。
 *
 * ⚠️ **夹具是 NoToneMapping，真实游戏是 ACES** ⇒ 下面的阈值按**无 tone mapping** 标定。
 *
 * 实测基线（2026-11-18，R=3 即 7×7px，三次重复**逐位相同** ⇒ 零噪声）：
 *   top(cheek 档0)    (168.6,183.2,201.9) lum 184.6  B−R 33.3
 *   side(cheek 档1)   (120.1,130.0,144.0) lum 131.4  B−R 23.9
 *   bottom(skirt 档2) ( 83.0, 85.0, 87.3) lum  85.1  B−R  4.3
 *   barrel            ( 59.0, 64.0, 72.6) lum  65.2
 */
test('炮塔塔顶 Tier 4：三档冷灰金属，亮度递减且炮管更暗', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 120_000 },
  );
  const err = await page.evaluate(() => window.__TT_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // ---- 前提：贴图路径已彻底删除，全部部件走金属 TSL ----
  const info = await page.evaluate(() => window.__TT_INFO__);
  expect(info.topGeometryLoaded, '塔顶几何须加载成功').toBe(true);
  expect(info.partsWithMap, '零贴图：任何部件都不得带 map').toEqual([]);
  expect(info.partsWithColorNode, '9 个部件全部走金属 TSL').toEqual([
    'mantlet', 'cheek', 'nose', 'ring', 'deckMid', 'barrel', 'podR', 'podL', 'skirt',
  ]);
  expect(info.partsWithToneAttr, '9 个部件的 tone 属性都已上传').toEqual([
    'mantlet', 'cheek', 'nose', 'ring', 'deckMid', 'barrel', 'podR', 'podL', 'skirt',
  ]);
  expect(info.tonedParts, '三档色调部件集合').toEqual([
    'cheek', 'mantlet', 'deckMid', 'ring', 'nose', 'skirt',
  ]);
  expect(info.meshNames, '9 个 mesh 都挂进 scene 且带受控名字').toEqual([
    'turret:mantlet', 'turret:cheek', 'turret:nose', 'turret:ring', 'turret:deckMid',
    'turret:barrel', 'turret:podR', 'turret:podL', 'turret:skirt',
  ]);
  // ⚠️ 夹具口径自检：阈值是按 NoToneMapping 标定的，混用 ACES 会整体偏亮
  expect(info.toneMapping, '夹具须为 NoToneMapping（阈值标定口径）').toBe(0);

  // ---- ① 上传到 GPU 的三档分布（分类退化的唯一防线）----
  //
  // ⚠️⚠️ **下面的「三档亮度递减」对分类退化零判别力**（负向验证实测）：
  // 三个取样面的**法线不同**（顶面 ny≈0.966 / 侧壁 ny≈0.144 / 底面 ny=−1），
  // 即使 tone 全相同，四项叠加的 N·L / 环境反射 / 菲涅尔仍会造出亮度差
  // ⇒ 注入「tone 恒 1」后实测顶−侧 **24.6** / 侧−底 **29.5**，均 >20，判据**仍绿**。
  // 故必须直接钉「**上传的** tone 分布」（不依赖光照）。
  // 冻结表与烘焙侧 `TURRET_TOP_METRICS.toneVertices` 同源（离线从源 OBJ 实测）。
  const TONE_VERTS = {
    cheek: [256, 304, 30], mantlet: [116, 112, 21], deckMid: [82, 0, 0],
    ring: [81, 452, 79], nose: [8, 1206, 8], skirt: [131, 2015, 64],
    barrel: [80, 1120, 132], podR: [64, 832, 64], podL: [32, 416, 32],
  };
  for (const [part, want] of Object.entries(TONE_VERTS)) {
    expect(info.toneCounts[part], `${part} 上传的三档顶点数`).toEqual(want);
  }

  // 取样面自检：fixture 按法线选的档，必须与产物记录的档一致
  const samples = await page.evaluate(() => window.__TT_SAMPLES__);
  for (const [view, s] of Object.entries(samples)) {
    expect(s.productTone, `${view} 取样面的产物 tone 须与法线判定一致`).toBe(s.tone);
    expect(s.area, `${view} 取样面须有正面积`).toBeGreaterThan(0);
  }

  const R = 3;
  const shot = async (view) => {
    const pt = await page.evaluate((v) => window.__TT_RENDER__(v), view);
    const rgb = regionRGB(PNG.sync.read(await page.screenshot()), pt.point.x, pt.point.y, R);
    return { ...rgb, pt };
  };
  const top = await shot('top');
  const side = await shot('side');
  const bottom = await shot('bottom');

  // ---- ② 三档都真的画出来了（非黑）----
  // ⚠️ **这条是 vec3(Color) 缺陷的直接防线**：那个缺陷下三档全是 0。
  for (const [name, s] of [['top', top], ['side', side], ['bottom', bottom]]) {
    expect(s.lum, `${name} 档不得是黑（vec3(Color) 缺陷形态）：${JSON.stringify(s)}`)
      .toBeGreaterThan(40);
  }

  // ---- ③ 亮度严格递减：顶 > 侧 > 底 ----
  // 实测 184.6 / 131.4 / 85.1，相邻差 53.2 与 46.3 ⇒ 阈值 20 远低于实测差。
  // ⚠️ **本条对「tone 恒 1」零判别力**（法线差异自带亮度差，见 ①），
  // 它钉的是「三档色值全等」与「三档顺序写反」。
  expect(top.lum - side.lum, `顶档须亮于侧档：top=${top.lum.toFixed(1)} side=${side.lum.toFixed(1)}`)
    .toBeGreaterThan(20);
  expect(side.lum - bottom.lum, `侧档须亮于底档：side=${side.lum.toFixed(1)} bottom=${bottom.lum.toFixed(1)}`)
    .toBeGreaterThan(20);

  // ---- ④ 各档亮度区间（同时钉上下界）----
  // ⚠️ 只钉「递减」抓不到「整机银白」或「整机近黑」—— 三档一起平移仍递减。
  // 区间取实测值 ±25（零噪声，但留材质参数微调余量）。
  expect(top.lum, `顶档亮度须在区间内：${top.lum.toFixed(1)}`).toBeGreaterThan(150);
  expect(top.lum, `顶档不得银白（用户否决塑料感）：${top.lum.toFixed(1)}`).toBeLessThan(215);
  expect(side.lum, `侧档亮度须在区间内：${side.lum.toFixed(1)}`).toBeGreaterThan(105);
  expect(side.lum, `侧档不得过亮：${side.lum.toFixed(1)}`).toBeLessThan(160);
  expect(bottom.lum, `底档亮度须在区间内：${bottom.lum.toFixed(1)}`).toBeGreaterThan(60);
  expect(bottom.lum, `底档不得过亮：${bottom.lum.toFixed(1)}`).toBeLessThan(110);

  // ---- ⑤ 冷调：三档都 B > R（参考图实测 B−R = +10.7~16.4，无暖色）----
  // ⚠️ 注入「基色改暖色（旧 rust 贴图色 159,138,108）」⇒ R > B → 红。
  for (const [name, s] of [['top', top], ['side', side], ['bottom', bottom]]) {
    expect(s.b, `${name} 档须冷调 B>R：${JSON.stringify(s)}`).toBeGreaterThan(s.r);
  }
  // 顶/侧档的冷调幅度要明显（实测 33.3 / 23.9）；底档因环境地面色偏暖而幅度小（4.3），
  // 故**不对底档钉幅度**——那会让正确实现 FAIL（实测踩过同类坑）。
  expect(top.b - top.r, `顶档冷调幅度：${(top.b - top.r).toFixed(1)}`).toBeGreaterThan(15);
  expect(side.b - side.r, `侧档冷调幅度：${(side.b - side.r).toFixed(1)}`).toBeGreaterThan(10);

  // ---- ⑥ 炮管比装甲最暗档还暗（炮头/炮管的层次，参考图炮管更暗）----
  const bp = await page.evaluate(() => window.__TT_RENDER_BARREL__());
  const barrel = regionRGB(PNG.sync.read(await page.screenshot()), bp.x, bp.y, R);
  expect(barrel.lum, `炮管须画出来了：${JSON.stringify(barrel)}`).toBeGreaterThan(30);
  expect(bottom.lum - barrel.lum,
    `装甲最暗档须亮于炮管：bottom=${bottom.lum.toFixed(1)} barrel=${barrel.lum.toFixed(1)}`)
    .toBeGreaterThan(10);
  expect(barrel.b, `炮钢是冷调（B>R）：${JSON.stringify(barrel)}`).toBeGreaterThan(barrel.r);

  // ---- ⑦ **同法线单变量对照：三档色值真的不同** ----
  //
  // ⚠️⚠️ **上面③的亮度递减对「三档色值全等」零判别力**（负向验证实测）：
  // 三个取样面法线不同，即使色值全等，光照仍造出 24.6 / 29.5 的差 ⇒ 仍绿。
  // 本段把**同一个面**（cheek 顶面）的 tone 依次改成 0/1/2，几何/相机/太阳全不动
  // ⇒ 唯一变量是档位，亮度差只能来自色值。色值全等时三个读数**逐位相同** → 红。
  const sameFace = [];
  for (const t of [0, 1, 2]) {
    const counts = await page.evaluate(({ p, v }) => window.__TT_SET_TONE__(p, v), { p: 'cheek', v: t });
    expect(counts[t], `cheek 全部顶点须已改成档 ${t}`).toBe(counts[0] + counts[1] + counts[2]);
    const pt = await page.evaluate(() => window.__TT_RESHOOT__('top'));
    sameFace.push(regionRGB(PNG.sync.read(await page.screenshot()), pt.x, pt.y, R));
  }
  // 恢复产物原值（不影响后续用例）
  await page.evaluate(() => window.__TT_SET_TONE__('cheek', null));
  const [s0, s1, s2] = sameFace;
  // 同一面、只差档位 ⇒ 顶档 > 侧档 > 底档，且差值明显
  expect(s0.lum - s1.lum,
    `同一面上顶档须亮于侧档（证明色值不同）：${s0.lum.toFixed(1)} vs ${s1.lum.toFixed(1)}`)
    .toBeGreaterThan(10);
  expect(s1.lum - s2.lum,
    `同一面上侧档须亮于底档：${s1.lum.toFixed(1)} vs ${s2.lum.toFixed(1)}`)
    .toBeGreaterThan(10);
});

test('炮塔塔顶 Tier 4：刚性一体 —— ±45° 俯仰时炮管与塔身连接处无背景色', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 120_000 },
  );
  expect(await page.evaluate(() => window.__TT_ERROR__), 'fixture 不应报错').toBeUndefined();

  // 判据：连接处 5×5 区域内**零背景像素**（炮管若分离，该处会露出黑背景）。
  // 实测三个姿态各两次重复均为 bg=0 / tot=25 ⇒ 零噪声，阈值可直接取 0。
  // ⚠️ 同时钉上下界：tot 必须是 25（取样点落在画面内），否则「区域全在画面外」也会 bg=0。
  for (const deg of [0, -45, 45]) {
    const r = await page.evaluate((d) => window.__TT_RENDER_POSE__(d), deg);
    const shot = PNG.sync.read(await page.screenshot());
    const { bg, tot } = backgroundPixels(shot, r.point.x, r.point.y, 2);
    expect(tot, `pitch=${deg}° 取样区域须完整落在画面内`).toBe(25);
    expect(bg, `pitch=${deg}° 炮管与塔身连接处不得露出背景（分离）：${JSON.stringify(r)}`).toBe(0);
  }
});

test('炮塔渲染：无炮塔时 9 个部件 mesh 全部 visible=false（draw call 回基线）', async ({ page }) => {
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 120_000 },
  );
  const stillVisible = await page.evaluate(() => window.__TT_CLEAR__());
  expect(stillVisible, `须全部不可见，实际仍可见：${stillVisible.join(',')}`).toEqual([]);
});

test('炮塔渲染：真游戏页无炮塔时部件 mesh 不可见', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const visible = await page.evaluate(() =>
    window.__MC_GAME__.scene.children.filter((c) => c.name?.startsWith('turret:') && c.visible).length);
  expect(visible).toBe(0);
  // 放一个炮塔 → 9 个部件 mesh 须可见（证明帧循环 sync 真的接线了）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const px = Math.floor(p.x), pz = Math.floor(p.z);
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let ox = cx * 16 + 1; ox <= cx * 16 + 14; ox++) {
      for (let oz = cz * 16 + 1; oz <= cz * 16 + 14; oz++) {
        let gy = null;
        for (let y = 90; y > -32; y--) { if (g.world.getBlockId(ox, y, oz) !== 0) { gy = y; break; } }
        if (gy === null || !g.world.isSolid(ox, gy, oz)) continue;
        let clear = true;
        for (let dx = -1; dx <= 1 && clear; dx++) {
          for (let dz = -1; dz <= 1 && clear; dz++) {
            for (let dy = 1; dy <= 3; dy++) {
              if (g.world.getBlockId(ox + dx, gy + dy, oz + dz) !== 0) clear = false;
            }
          }
        }
        if (clear) { g.placeTurret([ox, gy, oz]); return; }
      }
    }
  });
  await page.waitForFunction(() =>
    window.__MC_GAME__.scene.children.filter((c) => c.name?.startsWith('turret:') && c.visible).length === 9,
    null, { timeout: 10_000, polling: 200 });
  // 真实游戏页的装甲材质：零 map + 有 colorNode（证明装配层真的传了太阳 uniform）
  const mats = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const out = {};
    for (const c of g.scene.children) {
      if (!c.name?.startsWith('turret:')) continue;
      out[c.name.slice(7)] = { hasMap: !!c.material.map, hasColorNode: !!c.material.colorNode };
    }
    return out;
  });
  for (const [part, m] of Object.entries(mats)) {
    expect(m.hasMap, `${part} 真实游戏页也不得带贴图`).toBe(false);
    expect(m.hasColorNode, `${part} 真实游戏页须走金属 TSL（装配层传了太阳 uniform）`).toBe(true);
  }
});

/**
 * 金属光泽 Tier 4（炮管 + 装甲各自独立量）。
 *
 * ⚠️ **必须只留被测部件**（藏掉其余 8 个）：装甲与炮管现在都是冷灰金属、亮度同量级，
 * 混进来会把统计淹没 —— 与焰魔法阵「先藏掉自带同色的宿主」同一条教训。
 *
 * 判据：深灰身份 + 存在高光带 + 高光随太阳方向变 + 随视角变 + 关方向光后高光消失。
 */
for (const [part, base] of [
  ['barrel', { camYaw: 0.9, camPitch: 0.28, dist: 4.2 }],
  ['cheek', { camYaw: 0.9, camPitch: 0.55, dist: 4.6 }],
]) {
  test(`炮塔 ${part} Tier 4：金属高光随太阳方向与视角变化`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 400, height: 300 });
    await page.goto('/src/tests/test-turret-render.html');
    await page.waitForFunction(
      () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 120_000 },
    );
    expect(await page.evaluate(() => window.__TT_ERROR__), 'fixture 不应报错').toBeUndefined();

    /** 只统计非背景像素的亮度分位（其余部件全隐藏） */
    const lumStats = (png) => {
      const lums = [];
      for (let i = 0; i < png.width * png.height; i++) {
        const o = i * 4;
        if (png.data[o] < 6 && png.data[o + 1] < 6 && png.data[o + 2] < 6) continue;
        lums.push((png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3);
      }
      lums.sort((a, b) => a - b);
      const q = (f) => lums[Math.floor(lums.length * f)];
      return { n: lums.length, median: q(0.5), p90: q(0.9), max: lums[lums.length - 1] };
    };
    const shot = async (args) => {
      await page.evaluate(({ p, a }) => window.__TT_RENDER_SOLO__(p, a), { p: part, a: args });
      return lumStats(PNG.sync.read(await page.screenshot()));
    };
    const sun = [0.5, 0.8, 0.3];
    const a = await shot({ ...base, sun, strength: 1 });
    expect(a.n, `${part} 须真的画出来了`).toBeGreaterThan(2000);
    // ① 深灰身份（装甲比炮管亮一档，故上界分别取）
    const medianMax = part === 'barrel' ? 110 : 190;
    expect(a.median, `${part} 须是深灰而非银白：${JSON.stringify(a)}`).toBeLessThan(medianMax);
    // ② 金属反差：存在明显更亮的高光带
    expect(a.max - a.median, `${part} 须有高光带：${JSON.stringify(a)}`).toBeGreaterThan(25);
    // ③ 高光随太阳方向变
    //
    // ⚠️⚠️ **判据取 median 与 p90 的最大差，不能只看 p90**（实测标定）：
    // cheek 是大平面集合，换太阳方向时**高光带位置滑动但 p90 几乎不变**
    // （187 → 186.7，差 0.33），而 median 167.7 → 131（差 **36.7**）、p10 140 → 114。
    // barrel 是曲面，p90 96 → 89（差 7）而 median 78 → 70.7（差 7.3）。
    // ⇒ 两个通道取最大差，两类几何都有判别力（实测最小差 7.0，阈值 3）。
    const b = await shot({ ...base, sun: [-0.7, 0.4, -0.6], strength: 1 });
    const sunDelta = Math.max(Math.abs(a.p90 - b.p90), Math.abs(a.median - b.median));
    expect(sunDelta,
      `${part} 高光须随太阳方向变：p90 ${a.p90}→${b.p90} / median ${a.median}→${b.median}`)
      .toBeGreaterThan(3);
    // ④ 高光随视角变 —— 这是「金属」而非「贴图」的证据
    const c = await shot({ ...base, camYaw: 2.3, camPitch: 0.20, sun, strength: 1 });
    const viewDelta = Math.max(Math.abs(a.p90 - c.p90), Math.abs(a.median - c.median));
    expect(viewDelta,
      `${part} 高光须随视角变：p90 ${a.p90}→${c.p90} / median ${a.median}→${c.median}`)
      .toBeGreaterThan(3);
    // ⑤ 关方向光 ⇒ 高光完全消失
    const off = await shot({ ...base, sun, strength: 0 });
    expect(a.max - off.max, `${part} 关方向光后高光须消失：${a.max} → ${off.max}`)
      .toBeGreaterThan(20);
    // ⚠️⚠️ **「关方向光后是均匀色」只对单色部件成立**（实测标定）：
    // barrel 单一基色 ⇒ p90 == median == 74（差 0）；
    // cheek 走**三档色调** ⇒ 即使关掉方向光，顶/侧/底三档基色仍不同
    // （实测 median 124.7 / p90 148，差 **23.3**）—— 那是**正确行为**，
    // 拿 barrel 的判据套到 cheek 上会让正确实现 FAIL。
    // 装甲侧的判据：关光后**最大亮度不得超过最亮档的均匀值**
    // （实测 off.max = 148 = off.p90 ⇒ 无超出三档之上的高光尖）。
    if (part === 'barrel') {
      expect(off.p90 - off.median, `${part} 关方向光后应是均匀色（无高光带）`)
        .toBeLessThan(3);
    } else {
      expect(off.max - off.p90,
        `${part} 关方向光后不得有超出三档之上的高光尖：max=${off.max} p90=${off.p90}`)
        .toBeLessThan(3);
      // 且三档层次仍在（关太阳不应把色调差也抹掉）
      expect(off.p90 - off.median,
        `${part} 关方向光后三档色调层次须保留：${off.p90} vs ${off.median}`)
        .toBeGreaterThan(5);
    }
  });
}