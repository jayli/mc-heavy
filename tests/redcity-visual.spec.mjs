// RedCity Tier 4 像素实测：青绿屋顶 / 樱花粉 / 玻璃通透 / 水面门控
//
// 单测测不到 TSL 在 GPU 上的求值结果，所以这里全部落在**屏幕像素**上，并且每条都带「对照」：
//  - 屋顶 / 樱花：同一机位正对 vs 背对目标（背对时占比应显著下降 —— 证明统计到的是目标而不是别的青绿/粉色像素）
//  - 玻璃：同一机位把 3×3 玻璃面板换成 stone 再截一次（玻璃通透 → 两次画面有差）
//  - 水面门控：同一洞同一机位，门控开 / 关两次截图（关 = 注入缺陷，水面平面出现 → 洞中心偏蓝）
// 全部 pin：`?skybox=0` + noon 冻结日夜 + 关阴影 + 隐藏 HUD + 冻结物理（既有约束：天空盒让纯色天空判据失效、
// 太阳方向光与阴影会漂移色比、perf HUD 的半透明黑底会压暗左上象限）。像素判据**不用相对 +10% 之类的拍脑袋阈值**：
// 先在真实数据上量（见各用例注释里的〔实测〕），再取离实测值足够远、离对照值也足够远的门限。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const SEED = 12345;

async function boot(page, vd) {
  await page.setViewportSize({ width: 960, height: 600 });
  await page.goto(`/?vd=${vd}&seed=${SEED}&skybox=0&weather=clear`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0;
  }, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    g.player.physics.step = () => {};     // 冻结物理（不用 pushModal：它阻断玩家更新、相机不跟随，整屏不变）
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
  });
}

const shot = async (page) => PNG.sync.read(await page.screenshot());

/** 满足 pred 的像素占比 */
function ratioOf(png, pred) {
  let n = 0, m = 0;
  for (let i = 0; i < png.data.length; i += 4) { n++; if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) m++; }
  return m / n;
}

/** 中心 60×60（玻璃用 50×50）取均值 */
function centerMean(png, x0, y0, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * png.width + x) * 4; r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++; }
  return [r / n, g / n, b / n];
}

/** 出生点周围距离最近的一块 `name`（每列取最高的，便于从侧面看到） */
const findNearest = (page, name, R) => page.evaluate(([name, R]) => {
  const g = window.__MC_GAME__; const id = g.registry.idOf(name);
  const cx0 = Math.floor(g.spawnX), cz0 = Math.floor(g.spawnZ);
  let best = null;
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    for (let y = 90; y > -10; y--) {
      if (g.world.getBlockId(cx0 + dx, y, cz0 + dz) !== id) continue;
      const d = Math.hypot(dx, dz);
      if (!best || d < best.d) best = { x: cx0 + dx, y, z: cz0 + dz, d };
      break;
    }
  }
  return best;
}, [name, R]);

/** 把相机放在 cam，朝向 tgt（pitch/yaw 与 player.js 同约定） */
const aim = (page, cam, tgt) => page.evaluate(([cam, tgt]) => {
  const g = window.__MC_GAME__;
  const dx = tgt.x + 0.5 - cam.x, dy = tgt.y + 0.5 - cam.y, dz = tgt.z + 0.5 - cam.z;
  g.player.physics.pos.x = cam.x; g.player.physics.pos.y = cam.y - 1.62; g.player.physics.pos.z = cam.z;
  g.player.yaw = Math.atan2(-dx, -dz);
  g.player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}, [cam, tgt]);

// 〔实测〕oxidized_cut_copper 贴图平均色 RGB(58,196,169) → R<B<G；判据用关系式 + 绿红差，不用绝对色值（U2：只钉「是青绿系」）
const isRoof = (r, g, b) => r < b && b < g && g - r > 40;
// 樱花粉（pink_wool）：R>B>G 且红绿差、蓝绿差都明显
const isPink = (r, g, b) => r > b && b > g && r - g > 50 && b - g > 15;

for (const c of [
  // 〔实测 seed=12345〕正对 19.01% / 背对 6.23%（背对时仍有别的塔的屋顶入镜，所以不要求背对≈0，而要求「正对 ≥ 2× 背对」）
  { label: '青绿屋顶', block: 'oxidized_cut_copper', pred: isRoof, minFacing: 0.08, minRatio: 2 },
  // 〔实测〕正对 26.08% / 背对 0.32%
  { label: '樱花粉', block: 'pink_wool', pred: isPink, minFacing: 0.08, minRatio: 5 },
]) {
  test(`${c.label}：正对 ${c.block} 的画面中目标色像素占比显著高于背对（同机位对照）`, async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page, 4);
    const t = await findNearest(page, c.block, 70);
    expect(t, `出生点 70 格内应有 ${c.block}（映射表改了 / 方块没落地时这里是 null）`).not.toBeNull();
    await aim(page, { x: t.x + 0.5 - 12, y: t.y + 8, z: t.z + 0.5 + 12 }, t);
    await page.waitForTimeout(2500);
    const a = ratioOf(await shot(page), c.pred), a2 = ratioOf(await shot(page), c.pred);
    expect(Math.abs(a - a2), '同状态连拍噪声底（实测 0）').toBeLessThan(0.002);
    await page.evaluate(() => { window.__MC_GAME__.player.yaw += Math.PI; });
    await page.waitForTimeout(900);
    const away = ratioOf(await shot(page), c.pred);
    console.log(`REDCITY VISUAL ${c.label}: facing=${(a * 100).toFixed(2)}% away=${(away * 100).toFixed(2)}% target=(${t.x},${t.y},${t.z})`);
    expect(a, '正对占比').toBeGreaterThan(c.minFacing);
    expect(a, '正对 / 背对').toBeGreaterThan(Math.max(away, 0.001) * c.minRatio);
  });
}

test('玻璃通透：同机位把 3×3 玻璃面板换成 stone，画面中心明显变化（玻璃不是不透明墙）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page, 8);
  // 找一块外露玻璃：背面一格是空气（室内）、正面 6 格是空气（相机位）、3×3 面板全是 glass_block（确定性扫描，取最近）
  const cand = await page.evaluate(() => {
    const g = window.__MC_GAME__; const glass = g.registry.idOf('glass_block');
    const cx0 = Math.floor(g.spawnX), cz0 = Math.floor(g.spawnZ);
    let best = null;
    for (let dx = -130; dx <= 130; dx++) for (let dz = -130; dz <= 130; dz++) for (let y = 90; y > -10; y--) {
      if (g.world.getBlockId(cx0 + dx, y, cz0 + dz) !== glass) continue;
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (g.world.getBlockId(cx0 + dx - nx, y, cz0 + dz - nz) !== 0) continue;
        let free = 0;
        for (let k = 1; k <= 8; k++) { if (g.world.getBlockId(cx0 + dx + nx * k, y, cz0 + dz + nz * k) === 0) free++; else break; }
        if (free < 6) continue;
        const tx = nz !== 0 ? 1 : 0, tz = nx !== 0 ? 1 : 0;
        let panel = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (g.world.getBlockId(cx0 + dx + tx * a, y + b, cz0 + dz + tz * a) === glass) panel++;
        if (panel !== 9) continue;
        const d = Math.hypot(dx, dz);
        if (!best || d < best.d) best = { x: cx0 + dx, y, z: cz0 + dz, nx, nz, tx, tz, d };
        break;
      }
    }
    return best;
  });
  expect(cand, '出生点 130 格内应有 3×3 外露玻璃面板').not.toBeNull();
  await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    g.player.physics.pos.x = c.x + 0.5 + c.nx * 6; g.player.physics.pos.y = c.y + 0.5; g.player.physics.pos.z = c.z + 0.5 + c.nz * 6;
    g.player.yaw = Math.atan2(c.nx, c.nz); g.player.pitch = 0;
  }, cand);
  await page.waitForTimeout(3000);
  const glassMean = centerMean(await shot(page), 455, 275, 50, 50);
  const again = centerMean(await shot(page), 455, 275, 50, 50);
  await page.evaluate((c) => {
    const g = window.__MC_GAME__; const stone = g.registry.idOf('stone'); const aff = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const r = g.world.setBlock(c.x + c.tx * a, c.y + b, c.z + c.tz * a, stone); if (r) aff.push(...r.affected); }
    g.scheduler.remeshSections(aff, { fastPath: true });
  }, cand);
  await page.waitForTimeout(2000);
  const stoneMean = centerMean(await shot(page), 455, 275, 50, 50);
  const delta = glassMean.map((v, i) => stoneMean[i] - v);
  console.log(`REDCITY VISUAL 玻璃: glass=${glassMean.map((v) => v.toFixed(1))} stone=${stoneMean.map((v) => v.toFixed(1))} Δ=${delta.map((v) => v.toFixed(1))} 距出生点 ${cand.d.toFixed(0)}`);
  // 〔实测 seed=12345〕glass (104.6,109,116.6) → stone (92.3,94.6,99.8)，Δ=(-12.3,-14.4,-16.8)，同状态连拍噪声 0
  const noise = Math.max(...glassMean.map((v, i) => Math.abs(v - again[i])));
  expect(noise, '同状态连拍噪声底').toBeLessThan(1);
  expect(Math.max(...delta.map(Math.abs)), '换成不透明石头后画面中心必须明显变化（玻璃通透）').toBeGreaterThan(8);
});

test('水面门控：RedCity 内下挖到 y<-1.5 不出现水面平面（A/B：关门控 = 注入缺陷 → 洞中心偏蓝）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, 4);
  // 出生点下方挖 3×3 洞：从地面一路到 y=-6（洞底顶面 -5 < 水面平面 -1.5），相机在洞口正上方垂直向下看
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const hx = Math.floor(g.spawnX), hz = Math.floor(g.spawnZ);
    let gy = -1; for (let y = 60; y > -32; y--) if (g.world.getBlockId(hx, y, hz) !== 0) { gy = y; break; }
    const affected = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let y = gy; y >= -6; y--) { const r = g.world.setBlock(hx + dx, y, hz + dz, 0); if (r) affected.push(...r.affected); }
    g.scheduler.remeshSections(affected, { fastPath: true });
    g.player.physics.pos.x = hx + 0.5; g.player.physics.pos.z = hz + 0.5; g.player.physics.pos.y = gy + 6;
    g.player.yaw = 0; g.player.pitch = -Math.PI / 2 + 0.01;
  });
  await page.waitForTimeout(2500);
  const on = centerMean(await shot(page), 440, 280, 80, 40);
  const on2 = centerMean(await shot(page), 440, 280, 80, 40);
  await page.evaluate(() => window.__MC_GAME__.ocean.setRedCityBounds(null));      // 注入缺陷：门控关
  await page.waitForTimeout(700);
  const off = centerMean(await shot(page), 440, 280, 80, 40);
  await page.evaluate(() => window.__MC_GAME__.ocean.setRedCityBounds(window.__MC_GAME__.scheduler.structureIndex.redCity()));   // 还原
  await page.waitForTimeout(700);
  const back = centerMean(await shot(page), 440, 280, 80, 40);
  const delta = off.map((v, i) => v - on[i]);
  console.log(`REDCITY VISUAL 水面门控: on=${on.map((v) => v.toFixed(1))} off=${off.map((v) => v.toFixed(1))} Δ(开→关)=${delta.map((v) => v.toFixed(1))}`);
  // 〔实测〕on (141.6,146.5,158.1) → off (159.9,183.8,237.1)，Δ=(+18.3,+37.3,+79.0)，噪声底 0；蓝通道抬升是水面平面的特征
  expect(Math.max(...on.map((v, i) => Math.abs(v - on2[i]))), '同状态连拍噪声底').toBeLessThan(1);
  expect(delta[2], '关掉门控后洞中心蓝通道应显著抬升（水面平面出现）').toBeGreaterThan(40);
  expect(Math.max(...back.map((v, i) => Math.abs(v - on[i]))), '还原门控后与最初一致').toBeLessThan(1);
});
