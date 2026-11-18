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
  return { r: sr / n, g: sg / n, b: sb / n, n };
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
 * 炮塔塔顶 Tier 4 像素实测（模型替换后）。
 *
 * **为什么必须像素实测**：纹理采样在 GPU 求值，单测读不到片元输出（testing-policy §5.1）。
 * 单测只能钉住 UV 属性数值，无法证明 GPU 真的按那个 UV 采到了对应区。
 *
 * **判据用「区差异」而非绝对色值**：三张源图均值 front(159,138,108) 彩色 /
 * side(125,125,125) 纯灰 / top(139,141,144) 偏蓝灰。
 *
 * ⚠️ **取样点由 fixture 从产物几何 + 实例矩阵反解**，且按「面积降序 + 射线无遮挡」选面
 * （spec §9：mantlet.side / nose.side / nose.top 的最大面都被遮挡或是内腔面）。
 *
 * 实测基线（2026-11-18，R=3 即 7×7px，三次重复**逐位相同**⇒ 零噪声）：
 *   front (167.2,153.8,122.7) / side (111.2,111.2,111.2)
 *   top   (135.2,136.2,140.2) / barrel (138,138,138)
 */
test('炮塔塔顶 Tier 4：三区各采到对应贴图，炮管基色为深灰', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 120_000 },
  );
  const err = await page.evaluate(() => window.__TT_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // 前提：纹理与几何都加载成功，且装甲部件真的带 map（否则测的是纯色退回路径）
  const info = await page.evaluate(() => window.__TT_INFO__);
  expect(info.textureLoaded, '装甲纹理须加载成功').toBe(true);
  expect(info.topGeometryLoaded, '塔顶几何须加载成功').toBe(true);
  expect(info.textureSize, '纹理须为 192×64（三区并排）').toEqual([192, 64]);
  expect(info.armorPartsHaveMap, '五个装甲部件须带 map')
    .toEqual(['mantlet', 'cheek', 'nose', 'ring', 'deckMid', 'skirt']);
  expect(info.solidPartsHaveMap, '炮管/副武器不带 map').toEqual([]);
  expect(info.meshNames, '9 个 mesh 都挂进 scene 且带受控名字').toEqual([
    'turret:mantlet', 'turret:cheek', 'turret:nose', 'turret:ring', 'turret:deckMid',
    'turret:barrel', 'turret:podR', 'turret:podL', 'turret:skirt',
  ]);

  const R = 3;

  // ---- front 区（pic1，锈棕彩色）----
  const frontPt = await page.evaluate(() => window.__TT_RENDER__('front'));
  expect(frontPt.zone).toBe('front');
  const front = regionRGB(PNG.sync.read(await page.screenshot()), frontPt.point.x, frontPt.point.y, R);
  // 实测 r−g = 13.4；阈值 8 留余量。注入「zoneOf 恒 side」会让这里变灰度 → FAIL
  expect(Math.abs(front.r - front.g), `front 区须为彩色：${JSON.stringify(front)}`).toBeGreaterThan(8);
  expect(front.r, 'front 区非黑（采到了贴图，不是背景）').toBeGreaterThan(60);

  // ---- side 区（pic2，菱形花纹纯灰）----
  const sidePt = await page.evaluate(() => window.__TT_RENDER__('side'));
  expect(sidePt.zone).toBe('side');
  const side = regionRGB(PNG.sync.read(await page.screenshot()), sidePt.point.x, sidePt.point.y, R);
  // 实测三通道逐位相等（111.2）；注入「zoneIndex 恒 0」→ 这里变彩色 → FAIL
  expect(Math.abs(side.r - side.g), `side 区须为灰度：${JSON.stringify(side)}`).toBeLessThan(4);
  expect(Math.abs(side.g - side.b), `side 区须为灰度：${JSON.stringify(side)}`).toBeLessThan(4);
  expect(side.r, 'side 区非黑').toBeGreaterThan(60);

  // ---- top 区（pic3，偏蓝灰且亮度不同于 side）----
  const topPt = await page.evaluate(() => window.__TT_RENDER__('top'));
  expect(topPt.zone).toBe('top');
  const top = regionRGB(PNG.sync.read(await page.screenshot()), topPt.point.x, topPt.point.y, R);
  // 实测 top.r − side.r = 24.0；阈值 4 远低于实测差 ⇒ 有判别力
  expect(Math.abs(top.r - side.r), `top 区亮度须不同于 side：top=${JSON.stringify(top)} side=${JSON.stringify(side)}`)
    .toBeGreaterThan(4);
  expect(top.r, 'top 区非黑').toBeGreaterThan(60);
  // top 偏蓝（b > r）—— pic3 的特征，side 是纯灰做不到
  expect(top.b, `top 区偏蓝：${JSON.stringify(top)}`).toBeGreaterThan(top.r);

  // ---- 炮管（深灰炮钢 + 金属高光，不带 map）----
  // ⚠️ **fixture 不传 sunDirection ⇒ 走纯色退回路径**，量到的是基色本身。
  // 金属高光的像素判据在下面独立的「金属光泽」用例里（那个 fixture 传太阳 uniform）。
  const barrelPt = await page.evaluate(() => window.__TT_RENDER_BARREL__());
  const barrel = regionRGB(PNG.sync.read(await page.screenshot()), barrelPt.x, barrelPt.y, R);
  // 基色 0x434952 = (67,73,82)：深灰、冷调（b > r）
  expect(barrel.r, `炮管基色须是深灰：${JSON.stringify(barrel)}`).toBeGreaterThan(30);
  expect(barrel.r, '炮管不是浅灰（用户明确否决）').toBeLessThan(120);
  expect(barrel.b, `炮钢是冷调（b > r）：${JSON.stringify(barrel)}`).toBeGreaterThan(barrel.r);
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
});

/**
 * 炮管金属光泽 Tier 4（用户 2026-11-18：「深灰 + 金属光泽，可以根据光照来反光」）。
 *
 * ⚠️ **必须只留炮管**（藏掉装甲部件）：装甲贴图本身是灰白花纹，混进来会把统计淹没
 * —— 与焰魔法阵「先藏掉自带同色的宿主」同一条教训。
 *
 * 判据全部来自实测（`.superpowers/.../probe-barrel-only.mjs`）：
 *   基色视角 median 78 / max 135.7；换太阳方向 p90 96→89；换视角 p90 96→100；
 *   关方向光 max 135.7→74（高光完全消失）。
 */
test('炮塔炮管 Tier 4：深灰金属 + 高光随太阳方向与视角变化', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 760, height: 560 });
  await page.goto('/src/tests/test-turret-metal.html');
  await page.waitForFunction(
    () => window.__TM_READY__ === true || window.__TM_ERROR__, null, { timeout: 120_000 },
  );
  expect(await page.evaluate(() => window.__TM_ERROR__), 'fixture 不应报错').toBeUndefined();

  /** 只统计非背景像素的亮度分位（炮管以外全隐藏） */
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
    await page.evaluate((a) => window.__TM_RENDER__(a), args);
    return lumStats(PNG.sync.read(await page.screenshot()));
  };
  const base = { camYaw: 0.9, camPitch: 0.28, dist: 4.2, sun: [0.5, 0.8, 0.3], strength: 1 };
  const a = await shot(base);
  // ① 深灰身份：中位亮度低（实测 78）。注入「基色改浅灰」会让它 >110
  expect(a.median, `炮管须是深灰：${JSON.stringify(a)}`).toBeLessThan(110);
  expect(a.n, '炮管须真的画出来了').toBeGreaterThan(5000);
  // ② 金属反差：存在明显更亮的高光带（实测 max−median = 57.7）
  expect(a.max - a.median, `须有高光带：${JSON.stringify(a)}`).toBeGreaterThan(30);
  // ③ 高光随太阳方向变（实测 p90 96 → 89）
  const b = await shot({ ...base, sun: [-0.7, 0.4, -0.6] });
  expect(Math.abs(a.p90 - b.p90), `高光须随太阳方向变：${a.p90} vs ${b.p90}`).toBeGreaterThan(3);
  // ④ 高光随视角变（实测 p90 96 → 100）—— 这是「金属」而非「贴图」的证据
  const c = await shot({ ...base, camYaw: 2.3, camPitch: 0.20 });
  expect(Math.abs(a.p90 - c.p90), `高光须随视角变：${a.p90} vs ${c.p90}`).toBeGreaterThan(3);
  // ⑤ 关方向光 ⇒ 高光完全消失（实测 max 135.7 → 74，且 p90 == median 说明全均匀）
  const off = await shot({ ...base, strength: 0 });
  expect(a.max - off.max, `关方向光后高光须消失：${a.max} → ${off.max}`).toBeGreaterThan(20);
  expect(off.p90 - off.median, '关方向光后应是均匀色（无高光带）').toBeLessThan(3);
});
