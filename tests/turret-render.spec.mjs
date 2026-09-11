import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（同 zombie-head.spec.mjs 手法） */
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
 * 炮塔装甲 Tier 4 像素实测（M8 Task 5）。
 *
 * **为什么必须像素实测**：纹理采样在 GPU 求值，单测读不到片元输出（testing-policy §5.1）。
 * 单测只能钉住 UV 属性数值，无法证明 GPU 真的按那个 UV 采到了对应区。
 *
 * **判据用「区差异」而非绝对色值**（三张源图是三种不同装甲图，实测烘焙产物均值：
 * front 区 (159,138,108) 有彩色 / side 区 (125,125,125) 纯灰 / top 区 (139,141,144) 偏蓝灰）。
 * 故断言落在**彩色 vs 灰度**与**亮度差异**上 —— 比钉绝对色值稳健（渲染管线的小差异不影响判据）。
 *
 * ⚠️ 取样点由 fixture 从**实例矩阵反解**（含前装甲板的 rotX 倾斜），不硬编码世界坐标。
 */
test('炮塔装甲 Tier 4：三区各采到对应贴图，炮管为纯色', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 60_000 },
  );
  const err = await page.evaluate(() => window.__TT_ERROR__);
  expect(err, 'fixture 不应报错').toBeUndefined();

  // ④ 前提：纹理确实加载并挂上五块装甲板（否则下面的断言测的是纯色退回路径，不是 UV 分区）
  const info = await page.evaluate(() => window.__TT_INFO__);
  expect(info.textureLoaded, '装甲纹理须加载成功').toBe(true);
  expect(info.textureSize, '纹理须为 192×64（三区并排）').toEqual([192, 64]);
  expect(info.armorPartsHaveMap, '五块装甲板须带 map')
    .toEqual(['front', 'left', 'right', 'top', 'back']);
  expect(info.solidPartsHaveMap, '炮管/根部/瞄准器不带 map').toEqual([]);
  // ⑤ 前提：8 个 mesh 都挂进 scene 且带受控名字（防「节点没加上」的静默缺失）
  expect(info.meshNames).toEqual([
    'turret:front', 'turret:left', 'turret:right', 'turret:top', 'turret:back',
    'turret:barrel', 'turret:root', 'turret:sight',
  ]);

  const R = 3;   // 7×7px 取样（部件面在屏幕上足够大）

  // ---- front 区（pic1，有彩色）----
  const frontPt = await page.evaluate(() => window.__TT_RENDER__('front'));
  expect(frontPt.part).toBe('front');
  const shotFront = PNG.sync.read(await page.screenshot());
  const front = regionRGB(shotFront, frontPt.point.x, frontPt.point.y, R);
  // front 区是**彩色**（R 与 G 显著不等）—— 注入「zoneIndex 恒 0」不会让这条失败，
  // 但会让下面 side/top 两条失败（它们本该灰度却变彩色）
  expect(Math.abs(front.r - front.g), `front 区须为彩色：${JSON.stringify(front)}`).toBeGreaterThan(8);
  expect(front.r, 'front 区非黑（采到了贴图，不是背景）').toBeGreaterThan(60);

  // ---- side 区（pic2，纯灰）----
  const sidePt = await page.evaluate(() => window.__TT_RENDER__('side'));
  expect(sidePt.part).toBe('right');
  const shotSide = PNG.sync.read(await page.screenshot());
  const side = regionRGB(shotSide, sidePt.point.x, sidePt.point.y, R);
  // side 区是**纯灰**（三通道几乎相等）。注入「zoneIndex 恒 0」→ 这里会变成 front 区的彩色 → FAIL
  expect(Math.abs(side.r - side.g), `side 区须为灰度：${JSON.stringify(side)}`).toBeLessThan(4);
  expect(Math.abs(side.g - side.b), `side 区须为灰度：${JSON.stringify(side)}`).toBeLessThan(4);
  expect(side.r, 'side 区非黑').toBeGreaterThan(60);

  // ---- top 区（pic3，偏蓝灰且亮度不同于 side）----
  const topPt = await page.evaluate(() => window.__TT_RENDER__('top'));
  expect(topPt.part).toBe('top');
  const shotTop = PNG.sync.read(await page.screenshot());
  const top = regionRGB(shotTop, topPt.point.x, topPt.point.y, R);
  // top 区亮度须与 side 区**显著不同**（139 vs 125）—— 否则说明 top 采到了 side 区的图
  expect(Math.abs(top.r - side.r), `top 区亮度须不同于 side：top=${JSON.stringify(top)} side=${JSON.stringify(side)}`)
    .toBeGreaterThan(4);
  expect(top.r, 'top 区非黑').toBeGreaterThan(60);

  // ---- 炮管（纯色部件对照：不带 map → 渲染为 0x222222，不是贴图也不是黑背景）----
  const barrelPt = await page.evaluate(() => window.__TT_RENDER_BARREL__());
  const shotBarrel = PNG.sync.read(await page.screenshot());
  const barrel = regionRGB(shotBarrel, barrelPt.x, barrelPt.y, R);
  // 0x222222 = (34,34,34)；须明显亮于黑背景 (0,0,0) 才能证明「炮管渲染了」而非「取到背景」
  expect(barrel.r, `炮管须为深灰纯色：${JSON.stringify(barrel)}`).toBeGreaterThan(15);
  expect(Math.abs(barrel.r - barrel.g), '炮管是纯色（三通道相等）').toBeLessThan(6);
});

test('炮塔渲染：无炮塔时 8 个部件 mesh 全部 visible=false（draw call 回基线）', async ({ page }) => {
  await page.goto('/src/tests/test-turret-render.html');
  await page.waitForFunction(
    () => window.__TT_READY__ === true || window.__TT_ERROR__, null, { timeout: 60_000 },
  );
  // fixture 初始有一个炮塔 → sync(空) 后须全部不可见
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
  // 放一个炮塔 → 8 个部件 mesh 须可见（证明帧循环 sync 真的接线了）
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
    window.__MC_GAME__.scene.children.filter((c) => c.name?.startsWith('turret:') && c.visible).length === 8,
    null, { timeout: 10_000, polling: 200 });
});
