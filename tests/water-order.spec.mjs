// water-order.spec.mjs — issue #2：体素水与动画海面的透明绘制顺序必须与镜头朝向无关。
//
// 根因（见 issue #2 评论）：两层均 transparent + depthWrite=false 且无 renderOrder，
// three 按排序锚点的 NDC 深度定先后——海面锚点钉在相机正下方（恒定），而体素
// transparent 通道 BatchedMesh 的锚点是合并几何包围球中心（世界原点附近），排序值
// 随镜头转动在 -174~+283 间摆动，跨过海面值时绘制顺序翻转 → 水色离散跳变。
//
// 口径：包装 renderer.render 读 WebGPURenderList.transparent 的真实绘制顺序，
// yaw 全周扫描，断言（体素水在列时）体素水恒在海面之前绘制。
import { test, expect } from 'playwright/test';

test('issue#2：体素水与海面绘制顺序不随镜头转动翻转', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=8&seed=12345');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // 找一处岸边（陆地紧邻水面），保证视野内同时有体素水与海面平面
  const shore = await page.evaluate(async () => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const g = window.__MC_GAME__;
    const SEA_Y = -2;
    const sx = Math.round(g.spawnX), sz = Math.round(g.spawnZ);
    let best = null;
    for (let dx = -240; dx <= 240; dx += 4) {
      for (let dz = -240; dz <= 240; dz += 4) {
        const x = sx + dx, z = sz + dz;
        const h = generateHeight(x, z, g.seed);
        if (h <= SEA_Y) continue;
        let waterPt = null;
        for (const [ox, oz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
          if (generateHeight(x + ox, z + oz, g.seed) < SEA_Y) { waterPt = { x: x + ox, z: z + oz }; break; }
        }
        if (!waterPt) continue;
        const d = dx * dx + dz * dz;
        if (!best || d < best.d) best = { x, z, h, d, waterPt };
      }
    }
    return best;
  });
  expect(shore).not.toBeNull();

  await page.evaluate(({ x, z, h }) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = x + 0.5; g.player.physics.pos.z = z + 0.5;
    g.player.physics.pos.y = h + 1.2;
    window.__PIN_Y__ = setInterval(() => { g.player.physics.pos.y = h + 1.2; }, 50);
  }, shore);
  await page.waitForTimeout(12_000); // 等流式加载补齐岸边 column

  // 每帧记录透明渲染项的实际绘制顺序
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.renderer;
    const orig = r.render.bind(r);
    window.__ORDER_SNAP__ = null;
    r.render = (scene, camera) => {
      orig(scene, camera);
      try {
        const list = r._renderLists.get(scene, camera);
        window.__ORDER_SNAP__ = list.transparent.map((it) => (
          it.object === g.ocean.plane ? 'ocean'
            : it.object === g.renderWorld.meshes.transparent ? 'voxelWater'
            : 'other'
        ));
      } catch { /* 取不到就保持 null，由断言暴露 */ }
    };
  });

  const baseYaw = Math.atan2(-(shore.waterPt.x - shore.x), -(shore.waterPt.z - shore.z));

  // yaw 全周扫描（24 步 × 15°），采集每步绘制顺序
  const orders = [];
  for (let i = 0; i < 24; i++) {
    await page.evaluate(({ yaw }) => {
      const g = window.__MC_GAME__;
      g.player.yaw = yaw;
      g.player.pitch = 0.15;
    }, { yaw: baseYaw + (i / 24) * Math.PI * 2 });
    await page.waitForTimeout(150);
    const snap = await page.evaluate(() => window.__ORDER_SNAP__);
    orders.push({ deg: i * 15, snap });
  }
  await page.evaluate(() => clearInterval(window.__PIN_Y__));

  // 至少要有若干帧两层同时在列（否则测试没有判别力）
  const both = orders.filter(({ snap }) => snap && snap.includes('voxelWater') && snap.includes('ocean'));
  expect(both.length, '应存在体素水与海面同时在透明队列的帧').toBeGreaterThan(10);

  // 顺序必须全周一致
  const distinct = new Set(both.map(({ snap }) => snap.join(',')));
  expect([...distinct], '绘制顺序随镜头转动发生变化（排序锚点交叉翻转）').toHaveLength(1);

  // 且期望的恒定顺序是体素水先、海面后（海面是视觉表面层，恒后画）
  const order = both[0].snap.filter((n) => n !== 'other');
  expect(order.indexOf('voxelWater')).toBeLessThan(order.indexOf('ocean'));
});
