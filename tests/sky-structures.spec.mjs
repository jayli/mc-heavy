// tests/sky-structures.spec.mjs — M2-7 空中结构真实世界验收（设计文档 §4.2/§7）
// 口径：视距 8 全量加载 + 队列收敛后，数据级验证空岛/云层的确定性内容
// （逐格形状、无 chest、天空树已回补、岛体覆盖云），截图确认岛与云可见，
// 记录并断言 M3 冻结 fps/p95/draw 口径（本机硬门、CI 宽松门）。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 截图中非天空蓝像素占比；天空蓝 0x87ceeb=(135,206,235)，容差 30 */
function nonSkyRatio(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  let nonSky = 0;
  const n = png.width * png.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = png.data[o], g = png.data[o + 1], b = png.data[o + 2];
    if (Math.abs(r - 135) > 30 || Math.abs(g - 206) > 30 || Math.abs(b - 235) > 30) nonSky++;
  }
  return nonSky / n;
}

test('M2-7 验收：空岛与云层确定性内容 + 可视 + 性能门（视距 8）', async ({ page }) => {
  test.setTimeout(300_000);
  // ⚠️ `skybox=0`（v1.58）：本 spec 用「像素落在 0x87ceeb ±30 内 = 天空」来数非天空占比。
  // 天空盒上线后天空是照片 → 天空像素被误判成地形，下界断言近乎恒真（判据失效）。
  // 按 testing-policy 的「只改被测 setup、断言与阈值逐字不动」口径 pin 纯色天空。
  await page.goto('/?vd=8&seed=12345&skybox=0');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 视距 8 全 289 列就绪
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 120_000 });
  // 队列收敛（GEN/MESH/上传/挂起全空）——性能门的稳态前提
  const queueConverged = () => {
    const s = window.__MC_GAME__.scheduler;
    return s._inflightGen.size === 0 && s._meshQueue.length === 0 &&
           s._inflightMesh.size === 0 && s._uploadQueue.length === 0 &&
           s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
           s._inflightLight.size === 0;
  };
  await page.waitForFunction(queueConverged, null, { timeout: 120_000 });

  // 从 layout 紧凑候选中找距出生点最近的空岛
  const island = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const sx = g.spawnX, sz = g.spawnZ;
    let best = null;
    for (const layout of g.scheduler.structureIndex._layouts.values()) {
      const arr = layout.sky && layout.sky.skyIslands;
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 5) {
        const centerX = arr[i] * 16 + 8, centerZ = arr[i + 1] * 16 + 8;
        const bottomY = arr[i + 2], radius = arr[i + 3], height = arr[i + 4];
        const d = (centerX - sx) ** 2 + (centerZ - sz) ** 2;
        if (!best || d < best.d) best = { centerX, centerZ, bottomY, radius, height, d };
      }
    }
    return best;
  });
  expect(island).not.toBeNull();
  expect(island.bottomY).toBeGreaterThanOrEqual(40);
  expect(island.bottomY).toBeLessThanOrEqual(69);

  // 传送到空岛近旁（侧视位）并等覆盖列加载
  await page.evaluate((isl) => {
    const g = window.__MC_GAME__;
    const x = isl.centerX + isl.radius + 10, z = isl.centerZ;
    const y = isl.bottomY + Math.floor(isl.height / 2) + 1.2;
    g.player.physics.pos.x = x; g.player.physics.pos.z = z; g.player.physics.pos.y = y;
    g.player.physics.vel.x = 0; g.player.physics.vel.y = 0; g.player.physics.vel.z = 0;
    window.__PIN_Y__ = setInterval(() => {
      g.player.physics.pos.x = x; g.player.physics.pos.z = z; g.player.physics.pos.y = y;
      g.player.physics.vel.y = 0;
    }, 50);
  }, island);
  await page.waitForFunction((isl) => {
    const g = window.__MC_GAME__;
    for (let cx = Math.floor((isl.centerX - isl.radius) / 16);
         cx <= Math.floor((isl.centerX + isl.radius) / 16); cx++) {
      for (let cz = Math.floor((isl.centerZ - isl.radius) / 16);
           cz <= Math.floor((isl.centerZ + isl.radius) / 16); cz++) {
        if (!g.world.hasColumn(cx, cz)) return false;
      }
    }
    return true;
  }, island, { timeout: 120_000 });
  // 传送触发流式加载/卸载，性能采样前再次等待全队列收敛（真稳态）
  await page.waitForFunction(queueConverged, null, { timeout: 120_000 });

  // ---- 数据级：岛体逐格形状 + 无 chest + 天空树存在 + 岛体覆盖云 + 云层存在 ----
  const check = await page.evaluate((isl) => {
    const g = window.__MC_GAME__;
    const { idOf } = g.registry;
    const skyStone = idOf('sky_stone'), skyGrass = idOf('sky_grass');
    const chest = idOf('chest'), skyWood = idOf('sky_wood'), skyLeaves = idOf('sky_leaves');
    const cloudId = idOf('cloud');
    let matched = 0, expected = 0, bad = 0, cloudInside = 0;
    for (let y = 0; y <= isl.height; y++) {
      const r = Math.floor(isl.radius * Math.pow(y / isl.height, 0.7));
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r) continue;
        expected++;
        const id = g.world.getBlockId(isl.centerX + dx, isl.bottomY + y, isl.centerZ + dz);
        if (id === ((y === isl.height) ? skyGrass : skyStone)) matched++;
        else bad++;
        if (isl.bottomY + y === 55 && id === cloudId) cloudInside++;
      }
    }
    // 岛顶无 chest（宝箱仍不迁移，spec §1）；天空树已回补 → sky_wood/sky_leaves 须存在。
    // ⚠️ 两个断言的扫描区**都是** topY+1 的 dx,dz ∈ -2..2 —— 拆 forbidden 时只把
    // sky_wood/sky_leaves 移出，不改 chest 的扫描区（否则 chest 断言失去意义）。
    const topY1 = isl.bottomY + isl.height + 1;
    let forbidden = 0, treeWood = 0, treeLeaves = 0, trunkOnGrass = 0, trunkTotal = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const id = g.world.getBlockId(isl.centerX + dx, topY1, isl.centerZ + dz);
      if (id === chest) forbidden++;
      if (id === skyWood) {
        treeWood++;
        trunkTotal++;
        // 树干底格正下方必须是岛顶层 sky_grass（树长在岛上，不悬空）
        if (g.world.getBlockId(isl.centerX + dx, topY1 - 1, isl.centerZ + dz) === skyGrass) trunkOnGrass++;
      }
      if (id === skyLeaves) treeLeaves++;
    }
    // 树冠可能高出 topY+1（树冠在 y+2..y+4）→ 单独扫岛顶上方 6 格数树冠
    let canopy = 0;
    for (let dy = 1; dy <= 6; dy++) {
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        if (g.world.getBlockId(isl.centerX + dx, topY1 + dy, isl.centerZ + dz) === skyLeaves) canopy++;
      }
    }
    // 已加载世界的云层内容（Y=55 单云 + Y=35 云簇）
    let singleCloud = 0, clusterCloud = 0;
    for (const [, col] of g.world.columns) {
      for (let lx = 0; lx < 16; lx += 2) for (let lz = 0; lz < 16; lz += 2) {
        if (col.get(lx, 55, lz) === cloudId) singleCloud++;
        if (col.get(lx, 35, lz) === cloudId) clusterCloud++;
      }
    }
    return { matched, expected, bad, forbidden, cloudInside, singleCloud, clusterCloud,
             treeWood, treeLeaves, canopy, trunkOnGrass, trunkTotal };
  }, island);
  expect(check.expected).toBeGreaterThan(50);
  expect(check.bad).toBe(0);                 // 岛体逐格一致（含岛内无残留 cloud）
  expect(check.matched).toBe(check.expected);
  expect(check.cloudInside).toBe(0);         // 与 Y=55 相交处岛体覆盖云
  expect(check.forbidden).toBe(0);           // 无 chest（宝箱仍不迁移）
  // 天空树已回补（spec §2）。断言用 > 0 而非具体数（不同岛半径/高度不同，硬编码会脆）；
  // 逐格位置由浏览器内单测钉住（test-sky-structures.js 的忠实模拟比对）。
  // 实测（seed=12345，选中的最近岛 radius=5）：treeWood=2、canopy=165 —— 余量小但确定通过（详下警告）。
  expect(check.treeWood).toBeGreaterThan(0);
  expect(check.canopy).toBeGreaterThan(0);
  expect(check.trunkOnGrass).toBe(check.trunkTotal); // 每根树干都长在 sky_grass 上
  expect(check.singleCloud).toBeGreaterThan(0);
  expect(check.clusterCloud).toBeGreaterThan(0);

  // ---- 视觉级：面向空岛截图，岛体占据视野 ----
  await page.evaluate((isl) => {
    const g = window.__MC_GAME__;
    const px = g.player.physics.pos.x, pz = g.player.physics.pos.z;
    g.player.yaw = Math.atan2(-(isl.centerX - px), -(isl.centerZ - pz));
    g.player.pitch = -0.12; // 微俯视（pitch 正为仰视）
  }, island);
  await page.waitForTimeout(1500); // 等相机位 column 的 mesh 上传稳定
  const shot = await page.screenshot();
  const ratio = nonSkyRatio(shot);
  console.log('SKY VISUAL:', JSON.stringify({ nonSkyRatio: ratio.toFixed(3) }));
  expect(ratio).toBeGreaterThan(0.05);

  // ---- M3 冻结性能门：队列已收敛，静置采帧 ----
  // 空中场景稳态 ~105fps：约 14% 的帧被 120Hz vsync 量化为双倍帧时（84/600，
  // 超过 p95 容忍的 30 个），故窗口级 p95 必为双倍帧量化值 16.7000007——
  // 字面 `p95<16.7` 数学上不可满足（同 AGENTS.md 帧时口径注记）。二级门取
  // 16.75（16.7 阈值 + 一个量化 epsilon），仍能拦截三倍帧（25ms）级跌落；
  // 主断言为 fps ≥90。
  await page.waitForTimeout(3000);
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  const stats = await page.evaluate(() => window.__MC_GAME__.renderStats());
  console.log('SKY PERF:', JSON.stringify({ perf, stats }));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.75);
  expect(stats.drawCalls).toBeGreaterThan(0);

  await page.evaluate(() => clearInterval(window.__PIN_Y__));
});
