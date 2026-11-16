import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 焰魔尖刺攻击的 Tier 4 像素实测（v3.06）。
 *
 * **为什么必须像素实测**：尖锥是 additive 混合的 InstancedMesh（`blending` / 逐实例
 * `instanceColor` / 实例矩阵全在 GPU 求值）。数据层（`spikeFx.activeCount`）对，
 * **画面仍可能全错**：
 *   · 几何写成 `radiusTop > 0` ⇒ 变成柱体不是刺，计数全绿；
 *   · additive 没生效 ⇒ 刺变成不透明橙块，计数全绿；
 *   · `instanceColor` 没写 ⇒ 刺全白，计数全绿；
 *   · `translate(0, height/2, 0)` 漏了 ⇒ 刺有一半埋在地下，计数全绿。
 *
 * ## 判据与对照组校准（⚠️ **必须用差分，不能用绝对色** —— 实测教训）
 *
 * 尖锥色 `SPIKE_FX.color = [1.0, 0.45, 0.12]`，additive 叠在**天空背景**上。
 * 实测：背景 (86,136,175)（蓝）+ 尖锥 ⇒ (125,147,176) —— **仍然偏蓝**！
 * 绝对色判据 `r > g + 40 && r − b > 120` 在这种叠加下**永远不成立**（实测命中 2 像素，
 * 与基线相同 ⇒ 零判别力）。根因：additive 是**加法**，蓝背景的 b=175 加上尖锥的 b≈31
 * 仍是 176，而 r 从 86 只升到 125 ⇒ r < g。
 *
 * ⇒ 改用**差分判据**：同一相机同一地形，两侧只差有没有 spawn 尖刺，数
 * **`Δr > 25 && Δr > Δg + 12 && Δr > Δb + 12`** 的像素（「变红且红增量显著大于绿蓝」）。
 * 实测：基线 **0**（同状态重复截图零噪声）、尖刺帧 **4016**。
 * 沙漠沙对照：沙地像素在两侧完全相同 ⇒ Δ=0 ⇒ 天然被排除。
 *
 * ## 单变量对照（逐行复用 ignis-fx.spec.mjs 的实测教训）
 *
 * 同一相机、同一地形、同一时刻，**只差有没有 spawn 尖刺**；
 * 并且两侧都**先藏掉焰魔的渲染实例**（`inst.mesh.visible = false`）。
 *
 * ⚠️⚠️ **为何必须藏掉焰魔**（v3.04 实测）：焰魔本体是**火焰橙皮肤**，自己就满足
 * 橙红判据，且 idle 动画让它在 1.5s 内波动 **±18000 像素**，而法阵真实贡献只有 ≈2833
 * ⇒ 判据被宿主噪声淹没，「永不上屏」的注入退化**仍然 PASS**。
 *
 * ⚠️ **取基线 + 注入必须在同一次 evaluate 的同一帧内完成**：分两次 evaluate 时中间
 * 隔着 CDP 往返（数十毫秒 = 多帧），焰魔可能在间隙自然起手别的招 ⇒ 误报。
 *
 * ⚠️ **宿主必须与玩家同高**（v3.04 实测）：`ignises.summon` 的 `_findGroundY` 取
 * 「离参考高度最近的可站位置」，起伏开阔地会把焰魔放到 y=12 而玩家 y=4（差 8 格）
 * ⇒ 贴地尖刺全在相机上方，俯视根本看不到 ⇒ 像素零变化。
 */

const SEED = 12345;

/**
 * 「变红」像素数（差分判据）：红增量 > 25 且显著大于绿/蓝增量。
 *
 * ⚠️ **不能用绝对色判据**：additive 叠在蓝天空上后结果仍偏蓝（实测 125,147,176），
 * `r > g + 40` 永远不成立 ⇒ 零判别力。见文件头。
 */
function redderCount(before, after) {
  let n = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = after.data[i] - before.data[i];
    const dg = after.data[i + 1] - before.data[i + 1];
    const db = after.data[i + 2] - before.data[i + 2];
    if (dr > 25 && dr > dg + 12 && dr > db + 12) n++;
  }
  return n;
}

/** 近白像素数（防「additive 叠成白团」的上界判据） */
function nearWhiteCount(png, threshold = 245) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > threshold && png.data[i + 1] > threshold && png.data[i + 2] > threshold) n++;
  }
  return n;
}

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/**
 * 开阔地（远离城市 —— 建筑遮挡会让 AI 抖动）。逐行复用 `ignis-fx.spec.mjs`：
 * `g._teleportTo(x, 45, z)` + 固定等 2.5s。
 * ⚠️ 改用 `player.spawn` 会 30s 超时（它不加载目标 column，玩家悬在空列里）。
 */
async function gotoOpenField(page, { offsetX = 1200, offsetZ = 1200 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));
  }, [offsetX, offsetZ]);
}

/**
 * 召一只焰魔并钉到与玩家同高、相机正前方 4 格，然后俯视。
 * 布局：玩家在 (px,pz)，焰魔在玩家 −Z 4 格、yaw=0（正前方 −Z）
 * ⇒ 尖刺落在玩家 −Z 方向 6/8/10/12/14 格处（相机看向 −Z）。
 */
async function setupScene(page) {
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('spike-spec:0', Math.floor(p.x), Math.floor(p.z) + 4, 0, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);
  await page.waitForFunction((id) => {
    const e = window.__MC_GAME__.entities.get(id);
    return e?.state?.onGround === true;
  }, sum.id, { timeout: 30_000 });
  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(id);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, spikeSecond: false,
    };
    g.player.yaw = 0;
    g.player.pitch = -0.35;
  }, sum.id);
  await page.waitForTimeout(600);
  return sum.id;
}

/** 截图（固定 clip，避开 UI 面板/血心/小地图） */
async function shoot(page) {
  return page.screenshot({ clip: { x: 200, y: 150, width: 700, height: 420 } });
}

test('焰魔尖刺 Tier 4：火焰尖锥真的画出来了（橙红像素，带沙漠沙对照）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  const id = await setupScene(page);

  // ---- 前提断言（排除「几何/材质写错」造成的假绿）----
  const pre = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.spikeFx?.mesh?.geometry?.parameters;
    return {
      hasSpike: !!g.spikeFx,
      geoType: g.spikeFx?.mesh?.geometry?.type ?? null,
      radialSegments: p?.radialSegments ?? null,
      radius: p?.radius ?? null,
      height: p?.height ?? null,
      idleVisible: g.spikeFx?.mesh?.visible ?? null,
      idleActive: g.spikeFx?.activeCount ?? null,
      blending: g.spikeFx?.mesh?.material?.blending ?? null,
      additiveConst: 2,   // THREE.AdditiveBlending
    };
  });
  expect(pre.hasSpike, '尖刺层须已装配（无贴图依赖 ⇒ 恒装配）').toBe(true);
  // ⚠️ ConeGeometry.parameters 的键是 `radius`（不是 CylinderGeometry 的 radiusBottom/radiusTop）；
  // 「顶端是尖的」由 `geometry.type === 'ConeGeometry'` 保证（它内部向 super 传 radiusTop=0）。
  expect(pre.geoType, '必须是锥体而不是柱体').toBe('ConeGeometry');
  expect(pre.radialSegments, '6 棱锥（像素风）').toBe(6);
  expect(pre.radius, '底半径取 IGNIS_SPIKE.radius').toBe(0.35);
  expect(pre.height, '基准高度取 IGNIS_SPIKE.height').toBe(1.6);
  expect(pre.idleVisible, '零活跃时不得提交渲染（draw call 基线）').toBe(false);
  expect(pre.idleActive).toBe(0);
  expect(pre.blending, 'additive 混合须生效（否则是不透明橙块）').toBe(pre.additiveConst);

  // ---- 藏掉焰魔渲染实例（单变量对照的关键，见文件头）----
  const hid = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    return true;
  }, id);
  expect(hid, '前置：须能藏掉焰魔渲染实例（否则判据没有判别力）').toBe(true);
  await page.waitForTimeout(300);

  // ---- 噪声底：同状态重复截图 3 次，两两做差（已藏焰魔）----
  const baseShots = [];
  for (let i = 0; i < 3; i++) {
    baseShots.push(PNG.sync.read(await shoot(page)));
    await page.waitForTimeout(120);
  }
  const baseCounts = [
    redderCount(baseShots[0], baseShots[1]),
    redderCount(baseShots[1], baseShots[2]),
    redderCount(baseShots[0], baseShots[2]),
  ];
  const noiseFloor = Math.max(...baseCounts);
  const noiseMin = Math.min(...baseCounts);

  // ---- 注入：同一帧内取基线 + spawn（零 CDP 间隙）----
  // 直接用渲染器的 spawn 入口 + game 的地面查找 ⇒ 与真实消费路径同一套落点算法，
  // 只差「谁来触发」这一个变量（焰魔姿态两侧完全相同）。
  const injected = await page.evaluate(async (entityId) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const g = window.__MC_GAME__;
    const e = g.entities.get(entityId);
    const at = e.state.position;
    const points = [];
    for (const p of spikeSpawnPoints(at, 0)) {
      const y = g._findSigilGroundY(p.x, p.z, at[1]);
      if (y === null) continue;
      points.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
    }
    const beforeActive = g.spikeFx.activeCount;
    if (points.length > 0) g.spikeFx.spawn(points, performance.now());
    return { spawned: points.length, beforeActive, ys: points.map((p) => p.y) };
  }, id);
  expect(injected.spawned, '5 根都该找到地面（开阔地夹具）').toBe(5);

  // 等最后一根的延迟（200ms）+ 升起（180ms）过去
  await page.waitForTimeout(500);
  const onShot = PNG.sync.read(await shoot(page));
  const onCount = redderCount(baseShots[2], onShot);
  const onWhite = nearWhiteCount(onShot);
  const onActive = await page.evaluate(() => window.__MC_GAME__.spikeFx.activeCount);
  const litNow = await page.evaluate(() => window.__MC_GAME__.spikeFx.mesh.visible);

  console.log('SPIKE_COUNTS', JSON.stringify({
    baseCounts, noiseFloor, noiseMin, onCount, onWhite, onActive, litNow, injected,
  }));

  // ---- 上下界都钉（阈值按实测标定：基线 0 / 尖刺帧 4016）----
  // 下界取 noiseFloor + 1800（约实测增量的一半），上界取 8000（约 2 倍）
  // ⇒ 两侧余量对称，不因机器负载 flaky。
  expect(onCount, `尖刺帧变红像素须显著高于噪声底（base=${baseCounts}）`).toBeGreaterThan(noiseFloor + 1800);
  expect(onCount, '变红像素过多 = 几何炸开或 additive 过曝').toBeLessThan(8000);
  expect(onWhite, '不得出现大面积近白（additive 过曝）').toBeLessThan(294000 * 0.02);
  expect(onActive, '5 根应仍在活跃（寿命 900ms，采样在 500ms）').toBe(injected.spawned);
  expect(litNow, '尖刺须 visible=true（否则根本没画）').toBe(true);

  // ---- 寿命结束后回到 visible=false（draw call 回基线）----
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { active: g.spikeFx.activeCount, visible: g.spikeFx.mesh.visible };
  });
  expect(after.active, '寿命结束后须全部回收').toBe(0);
  expect(after.visible, '回收后须 visible=false（draw call 回基线）').toBe(false);
});

test('焰魔尖刺 Tier 4：走真实命中帧路径，两刀各出一次（不受 freshLos 影响）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page, { offsetX: 1500, offsetZ: 1500 });
  const id = await setupScene(page);

  // 钉 spikeSlash 起手 + spikeSecond=true（双刀），让**真实帧循环**推进两个命中帧。
  // ⚠️ 玩家站在 3 格内 ⇒ Agent 自己会在第一刀命中帧置 spikeSecond；
  // 这里直接置 true 是为了让夹具不依赖玩家位置（单变量：只测「两刀各出一次」）。
  await page.evaluate((entityId) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(entityId);
    e.state = {
      ...e.state, mode: 'attack', attackKind: 'spikeSlash', attackAnimT: 0,
      spikeSecond: true, yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999,
    };
  }, id);

  // 第一刀命中帧 0.991667s ⇒ 等尖刺入池
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount > 0,
    null, { timeout: 30_000 });
  const first = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    return { active: g.spikeFx.activeCount, t: g.entities.get(eid)?.state?.attackAnimT ?? null };
  }, id);
  expect(first.active, '第一刀命中帧须出 5 根尖刺').toBe(5);

  // 第二刀命中帧 2.216667s ⇒ 尖刺寿命 900ms + 最大延迟 200ms = 1.1s，
  // 第一刀在 0.99s 出、第二刀在 2.22s 出 ⇒ 间隔 1.23s > 1.1s ⇒ 第一批已回收。
  // 故「第二批入池」的判据是：等到 activeCount 归零后再次 > 0。
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount === 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount > 0,
    null, { timeout: 30_000 });
  const second = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    return { active: g.spikeFx.activeCount, t: e?.state?.attackAnimT ?? null, kind: e?.state?.attackKind ?? null };
  }, id);
  console.log('SPIKE_TWO_HITS', JSON.stringify({ first, second }));
  expect(second.active, '第二刀命中帧须再出 5 根').toBe(5);
  expect(second.t, '第二批须在第二命中帧之后').toBeGreaterThan(2.2);
});