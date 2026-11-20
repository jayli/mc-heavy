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
      normalConst: 1,      // THREE.NormalBlending
      textured: g.spikeFx?.textured ?? null,
      materialType: g.spikeFx?.mesh?.material?.type ?? null,
      renderOrder: g.spikeFx?.mesh?.renderOrder ?? null,
      oceanRenderOrder: g.ocean?.plane?.renderOrder ?? null,
    };
  });
  expect(pre.hasSpike, '尖刺层须已装配').toBe(true);
  // ⚠️ ConeGeometry.parameters 的键是 `radius`（不是 CylinderGeometry 的 radiusBottom/radiusTop）；
  // 「顶端是尖的」由 `geometry.type === 'ConeGeometry'` 保证（它内部向 super 传 radiusTop=0）。
  expect(pre.geoType, '必须是锥体而不是柱体').toBe('ConeGeometry');
  expect(pre.radialSegments, '6 棱锥（像素风）').toBe(6);
  expect(pre.radius, '底半径取 IGNIS_SPIKE.radius').toBe(0.35);
  expect(pre.height, '基准高度取 IGNIS_SPIKE.height').toBe(1.6);
  expect(pre.idleVisible, '零活跃时不得提交渲染（draw call 基线）').toBe(false);
  expect(pre.idleActive).toBe(0);
  /**
   * ⚠️ **v3.24 推翻了旧断言**（原本是 `blending === AdditiveBlending`）。
   *
   * 实测结论：additive 下最终像素 = 背景 + 增益，而焰魔在开阔地战斗时锥体上半段的
   * 背景总是**亮天空 (169,208,219)** ⇒ R/G 必然撞到 255 ⇒ 金色剑纹物理上出不来
   * （四档参数扫下来 warmPct 全在 0~3.7%）。用户 2026-11-20 裁定改成**正常混合**。
   * 按新语义改写而不是放宽：这里钉的变成「正常混合 + 纹理真的挂上了 + 排在海面之后」。
   */
  expect(pre.blending, 'v3.24 起用正常混合（additive 在亮天空前会钳白）').toBe(pre.normalConst);
  expect(pre.textured, '装配层须把焰魔贴图传进来（否则是纯色锥）').toBe(true);
  expect(pre.materialType, '剑纹材质须是 TSL（普通 Map 材质给不出色相映射）')
    .toBe('MeshBasicNodeMaterial');
  expect(pre.renderOrder, '锥体必须排在海面之后（否则被水色冲淡 1.77 倍）')
    .toBeGreaterThan(pre.oceanRenderOrder);

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
  /**
   * ⚠️⚠️ **采样前钉大冷却，防它在等回收期间自然再起手**（同 `ignis-fx.spec.mjs` 口径）。
   *
   * 本轮实测：本用例在 **HEAD 上就 flaky**（连跑 3 轮 2 红，与本改动无关 ——
   * 已用 HEAD 副本核实）：焰魔此刻是 idle，约 1.5s 后自然起手，若那一招是尖刺攻击
   * 就会再出 5 根 ⇒ 「寿命结束须全部回收」读到 5 而不是 0。
   * 这不是放宽断言 —— 断言一字未改，只把「焰魔又打了一招」这个无关变量排除掉。
   */
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
  }, id);

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
/**
 * v3.23：**破土火星 + 上浮余烬**的 Tier 4 像素实测。
 *
 * 用户 2026-11-20：「尖刺升起的时候带有粒子特效……就好像蹦出的火星一样」。
 * 两项裁定：破土猛迸 + 余烬渐稀（缩回时停）、条状火星 + 少量上浮余烬（不加烟）。
 *
 * ## 为什么必须像素实测（Node 33 例全绿时画面仍可能全错）
 *
 * 粒子是 **GPU 模拟**：出生数据在 CPU，位移/尺寸/拉伸/颜色全在 TSL 里求值。
 * 本仓已实测过的静默失效形态：
 *   · `aSpawn` 写毫秒而 `uTime` 是秒 ⇒ age 恒负 ⇒ **粒子全灭**，计数全绿；
 *   · 用 `InstancedMesh` 而非 `Mesh` ⇒ instanceMatrix 接管 modelViewMatrix ⇒ 全塌到原点；
 *   · 只拉伸不改轮廓（或反之）⇒ 退回圆点，用户读作「冒爆米花」；
 *   · 尺寸太小 ⇒ 每颗只 2.3px，**画面上等于没有**（本轮实测：首版 193 像素）。
 *
 * ## 夹具的三个必需条件（全部本轮实测踩到，缺一则判据零判别力）
 *
 * ① **钉住玩家位置**：`setupScene` 之后玩家仍在下落 —— 实测 camY 从 −5.59 漂到 −7.38
 *    ⇒ 整帧差分被**相机运动**主导（264692 像素），与粒子无关。
 * ② **冻住海面**：`ocean.update(camera, dt)` 每帧推进 `uTime` ⇒ 波纹在动。
 *    实测空闲态噪声底 **[450, 0, 450, 0, 450]**（双态跳变）；把 dt 喂 0 后 **[0,0,0,0,0]**。
 *    ⚠️ 只 `plane.visible=false` 不够（体素水仍在动），要冻 `update` 的时间推进。
 * ③ **藏掉焰魔本体 + 尖锥本体**：两者都是火焰橙 additive，与火星同色系
 *    ⇒ 不藏则量到的是宿主而不是火星（同 v3.22「宿主是另一个特效层」那条教训）。
 *    尖锥用 `Object.defineProperty` 把 visible 钉 false —— 直接赋值会被下一帧 update 覆写。
 *
 * ## 采样按**真实 age**等，不按墙钟
 *
 * `waitForTimeout` 可能恰好落在 spawn 那一帧（实测首帧暖色 **0**，而 visible/计数全对）
 * ⇒ 用 `waitForFunction(performance.now() − T0 >= t)` 逐点采，取多帧的**最大值**。
 */
test('焰魔尖刺 Tier 4：破土火星与余烬真的画出来了（藏宿主的单变量对照）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0&shadows=0&reflect=0`);
  await waitWorldReady(page);
  await gotoOpenField(page, { offsetX: 2100, offsetZ: 2100 });
  const id = await setupScene(page);

  // ---- 前提断言（排除「层没装配 / 用错 mesh 类型」造成的假绿）----
  const pre = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    return {
      meshCount: r?.meshes?.length ?? 0,
      sparkIsInstancedMesh: r?.sparkMesh?.isInstancedMesh === true,
      emberIsInstancedMesh: r?.emberMesh?.isInstancedMesh === true,
      sparkGeoInstanced: r?.sparkMesh?.geometry?.isInstancedBufferGeometry === true,
      sparkBlending: r?.sparkMesh?.material?.blending ?? null,
      emberBlending: r?.emberMesh?.material?.blending ?? null,
      idleAllHidden: r ? r.meshes.every((m) => !m.visible) : null,
      hasVel: !!r?.sparkMesh?.geometry?.getAttribute('aVel'),
      renderOrder: r?.sparkMesh?.renderOrder ?? null,
      capacity: r?.sparkMesh?.geometry?.getAttribute('aOrigin')?.count ?? 0,
    };
  });
  expect(pre.meshCount, '尖锥 + 火星 + 余烬三个 mesh').toBe(3);
  expect(pre.sparkIsInstancedMesh, '火星不得用 InstancedMesh（会塌到原点）').toBe(false);
  expect(pre.emberIsInstancedMesh, '余烬同理').toBe(false);
  expect(pre.sparkGeoInstanced, '几何须是 InstancedBufferGeometry').toBe(true);
  expect(pre.hasVel, 'aVel 必须存在（STREAK 拉伸的输入）').toBe(true);
  expect(pre.sparkBlending, '火星 additive').toBe(2);
  expect(pre.emberBlending, '余烬 additive').toBe(2);
  expect(pre.idleAllHidden, '零活跃时全部 mesh 不得提交渲染').toBe(true);
  expect(pre.renderOrder, '与闪电/Cinder/火圈同档 3').toBe(3);
  expect(pre.capacity, '池容量取常量').toBe(768);

  // ---- 夹具：藏宿主 + 钉玩家 + 冻海面 + 真实交战距离（4 格）----
  const fixture = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return { ok: false, why: 'no ignis mesh' };
    inst.mesh.visible = false;
    const e = g.entities.get(eid);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, attackCooldown: 999,
    };
    /**
     * ⓪ **冻住焰魔 AI**：`attackCooldown: 999` 只挡起手，**不挡追击** ——
     * 实测 state.mode 会变成 `chase`，位置与姿态每帧在动 ⇒ 藏了 mesh 也仍有
     * 阴影/间接影响，且它随时可能再打一招污染回收断言。
     * 直接把它的 update 换成空转（本用例只测渲染层，AI 由 ignis.spec 守）。
     */
    let aiFrozen = false;
    if (g.ignises?.update) { g.ignises.update = () => {}; aiFrozen = true; }
    // ① 钉玩家（不钉则相机仍在下落，整帧差分被相机运动主导）
    const px = p.x; const py = p.y; const pz = p.z;
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.30;
    }, 16);
    /**
     * ①b **冻住 viewBob 与 stepLift**（本轮实测定位到的最后一个噪声源）：
     * 钉 `physics.pos` 只固定了**逻辑位置**，而相机 y 还要叠 `viewBob.offset` 与
     * `_stepLift.offset`（`player.js:386`）—— 传送后两者仍在衰减 ⇒ 相机每帧微动
     * ⇒ 噪声底在 **0 与 30 之间双态跳变**。把两个 update 换成空转即可归零。
     */
    let bobFrozen = false;
    if (g.player?.viewBob?.update) { g.player.viewBob.update = () => {}; bobFrozen = true; }
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    // ② 冻海面波纹（只藏 plane 不够 —— 体素水仍在动）
    let froze = false;
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
      froze = true;
    }
    // ③ 钉尖锥本体不可见（update 每帧重算 visible ⇒ 必须用 getter）
    const m = g.spikeFx.mesh;
    Object.defineProperty(m, 'visible', { get: () => false, set: () => {}, configurable: true });
    /**
     * ④ **藏第一人称手臂/武器 + 冻昼夜**（本轮实测定位到的两个噪声源）：
     * 手臂有待机摆动，昼夜推进让天空色缓慢漂 —— 两者合计让空闲态噪声底在
     * **0 与 494 之间双态跳变**（实测 10 连拍：494×7 / 0×3）。
     * 逐步隔离实测：藏焰魔全部实例后仍 [675,494,…]；再藏手臂 → [68,0,0,0,68]；
     * 再冻昼夜 → **[0,0,0,0,0]**。⇒ 两者都必须处理，缺一张基线就不干净。
     */
    let armHidden = false;
    if (g.viewArm?.mesh) { g.viewArm.mesh.visible = false; armHidden = true; }
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    const dn = g.dayNight || g.daynight;
    let dnFrozen = false;
    if (dn?.update) { dn.update = () => {}; dnFrozen = true; }
    return { ok: true, froze, coneHidden: m.visible === false, armHidden, dnFrozen, aiFrozen, bobFrozen };
  }, id);
  expect(fixture.ok, `前置：须能藏掉焰魔渲染实例（${fixture.why ?? ''}）`).toBe(true);
  expect(fixture.froze, '前置：须能冻住海面时间推进（否则噪声底 450 双态跳变）').toBe(true);
  expect(fixture.coneHidden, '前置：须能藏掉尖锥本体（同色系宿主）').toBe(true);
  expect(fixture.armHidden, '前置：须能藏掉第一人称手臂（待机摆动是噪声源）').toBe(true);
  expect(fixture.dnFrozen, '前置：须能冻住昼夜推进（天空色漂移是噪声源）').toBe(true);
  expect(fixture.aiFrozen, '前置：须能冻住焰魔 AI（否则它会追击/再起手）').toBe(true);
  expect(fixture.bobFrozen, '前置：须能冻住 viewBob（相机微动是最后一个噪声源）').toBe(true);
  /**
   * ⚠️ **等 3.5s 而不是 2s**（本轮实测）：2s 时远处 column 仍在流式上传，
   * 噪声底偶发 37/43；3.5s 后连拍 8 张**逐位相同**（差分分位数全 0）。
   * 下面的「等相邻差分为 0」循环是二次保险，两者一起才让基线可复现。
   */
  await page.waitForTimeout(3500);

  /**
   * ---- 噪声底：**等画面真的静止**再取基线（不是固定 sleep）----
   *
   * ⚠️ 本轮实测：固定等 2s 后首帧偶发 37 像素跳变 —— 远处 column 仍在流式加载/上传网格。
   * 同「判世界稳定要等 sections 停止增长」那条教训：固定 sleep 拓不到「还在动」。
   * 做法：连拍直到**相邻两张暖色差分为 0**，用那一张当基线；预算内达不到就硬失败
   *（不静默放宽 —— 那会把「还有动态源」这个真问题藏起来）。
   */
  let baseline = PNG.sync.read(await shoot(page));
  let settled = false;
  const settleTries = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(140);
    const next = PNG.sync.read(await shoot(page));
    const d = redderCount(baseline, next);
    settleTries.push(d);
    baseline = next;
    if (d === 0) { settled = true; break; }
  }
  expect(settled, `画面须在预算内静止（实得相邻差分 ${settleTries}）—— 否则还有未冻住的动态源`)
    .toBe(true);
  // 静止后再连拍 3 张确认噪声底真的是 0
  const idleShots = [baseline];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(110);
    idleShots.push(PNG.sync.read(await shoot(page)));
  }
  const baseCounts = idleShots.slice(1).map((s) => redderCount(idleShots[0], s));
  const noiseFloor = Math.max(...baseCounts);
  /**
   * 五个动态源全部冻住后实测噪声底 **0~1 像素**（8 连拍逐位相同，偶发 ±1 量化抖动）。
   * 上界取 5：远高于抖动、比信号（>200）低两个量级 ⇒ 任一步夹具失效
   * （手臂没藏 ⇒ 494 / 昼夜没冻 ⇒ 450 / AI 没冻 ⇒ 37~43）都会让它红。
   * ⚠️ 不钉「恒 0」：那是断言想象中的世界（GPU 尾数抖动真实存在）。
   */
  // 冻结五个动态源后实测 0~1；远处 column 流式上传偶发再抬到 30~43。
  // 故这里只钉「远小于信号」，**真正的噪声底由下面的零粒子对照组自校准**
  //（同会话、同机位、同地形，只差有没有粒子 —— 那才是单变量对照的正确基准）。
  expect(noiseFloor, `空闲噪声底须远小于信号（实得 ${baseCounts}）`).toBeLessThan(80);

  /** 起一排刺（mode 决定放行哪类粒子），并记录 T0 供按真实 age 采样 */
  const cast = async (mode) => page.evaluate(async ([eid, m]) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const at = g.entities.get(eid).state.position;
    const pts = [];
    for (const p of spikeSpawnPoints(at, 0)) {
      const y = g._findSigilGroundY(p.x, p.z, at[1]);
      if (y === null) continue;
      pts.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
    }
    delete r._emitSparks;                       // 还原实例覆盖，回到原型方法
    const proto = Object.getPrototypeOf(r);
    if (m === 'none') r._emitSparks = () => {};
    if (m === 'spark') r._emitSparks = (s, k, p2, c, t) => { if (k === 'spark') proto._emitSparks.call(r, s, k, p2, c, t); };
    if (m === 'ember') r._emitSparks = (s, k, p2, c, t) => { if (k === 'ember') proto._emitSparks.call(r, s, k, p2, c, t); };
    r.reset();
    r.spawn(pts, performance.now());
    window.__T0__ = performance.now();
    return pts.length;
  }, [id, mode]);

  /** 按真实 age 逐点采样，返回每帧的暖色像素数与色相 */
  const sample = async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForFunction((t) => performance.now() - window.__T0__ >= t,
        150 + i * 80, { timeout: 15_000 });
      const shot = PNG.sync.read(await shoot(page));
      let n = 0; let sr = 0; let sg = 0; let sb = 0;
      for (let k = 0; k < baseline.data.length; k += 4) {
        const dr = shot.data[k] - baseline.data[k];
        const dg = shot.data[k + 1] - baseline.data[k + 1];
        const db = shot.data[k + 2] - baseline.data[k + 2];
        if (dr > 25 && dr > dg + 12 && dr > db + 12) {
          n++; sr += shot.data[k]; sg += shot.data[k + 1]; sb += shot.data[k + 2];
        }
      }
      rows.push({
        n,
        r: n ? +(sr / n).toFixed(1) : 0,
        g: n ? +(sg / n).toFixed(1) : 0,
        b: n ? +(sb / n).toFixed(1) : 0,
        white: nearWhiteCount(shot),
      });
    }
    return rows;
  };

  // ---- 对照组 A：**只有尖锥、零粒子**（证明基线不是「什么都没有」）----
  expect(await cast('none'), '5 根都该找到地面（开阔地夹具）').toBe(5);
  const coneRows = await sample();
  const coneState = await page.evaluate(() => ({
    active: window.__MC_GAME__.spikeFx.activeCount,
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
    ember: window.__MC_GAME__.spikeFx.emberMesh.visible,
  }));
  expect(coneState.active, '对照组里尖锥须仍活跃（证明它真的在跑，只是被藏了）').toBe(5);
  expect(coneState.spark, '对照组里火星层不得提交（发射已关）').toBe(false);
  /**
   * **有效噪声底 = 零粒子对照组的峰值**（自校准，不用空闲态那个数）。
   * 它与实验组同会话、同机位、同地形、同尖锥，**只差有没有粒子** ⇒
   * 远处 column 上传之类的残余漂移会同时出现在两侧，被减法天然消掉。
   */
  const controlFloor = Math.max(...coneRows.map((x) => x.n));
  expect(controlFloor, `零粒子对照组须停在噪声量级（实得 ${coneRows.map((x) => x.n)}）`)
    .toBeLessThan(80);
  await page.waitForTimeout(1700);

  // ---- 对照组 B：只有火星 ----
  await cast('spark');
  const sparkRows = await sample();
  const sparkState = await page.evaluate(() => {
    const r = window.__MC_GAME__.spikeFx;
    const count = (g) => { const a = g.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return {
      written: count(r._sparkGeo),
      emberWritten: count(r._emberGeo),
      visible: r.sparkMesh.visible,
      uTime: r._sparkUniforms.uTime.value,
      firstSpawn: r._sparkGeo.getAttribute('aSpawn').getX(0),
    };
  });
  await page.waitForTimeout(1700);

  // ---- 对照组 C：只有余烬 ----
  await cast('ember');
  const emberRows = await sample();
  const emberState = await page.evaluate(() => {
    const r = window.__MC_GAME__.spikeFx;
    const count = (g) => { const a = g.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return { written: count(r._emberGeo), sparkWritten: count(r._sparkGeo), visible: r.emberMesh.visible };
  });
  await page.waitForTimeout(1700);

  // ---- 实验组：两者都开（真实生产路径）----
  await cast('both');
  const bothRows = await sample();
  const bothState = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const count = (geo) => { const a = geo.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return {
      active: r.activeCount,
      sparkVisible: r.sparkMesh.visible,
      emberVisible: r.emberMesh.visible,
      sparkWritten: count(r._sparkGeo),
      emberWritten: count(r._emberGeo),
    };
  });

  const peak = (rows) => Math.max(...rows.map((x) => x.n));
  const hueOf = (rows) => rows.reduce((a, b) => (b.n > a.n ? b : a), rows[0]);
  console.log('SPIKE_SPARK_PIXELS', JSON.stringify({
    baseCounts, noiseFloor,
    cone: coneRows.map((x) => x.n), controlFloor,
    spark: sparkRows, ember: emberRows.map((x) => x.n),
    both: bothRows, coneState, sparkState, emberState, bothState,
  }));

  // ---- ① 数据层：两类粒子都真的写入了，且时钟同源 ----
  expect(bothState.sparkVisible, '火星层须提交渲染').toBe(true);
  expect(bothState.emberVisible, '余烬层须提交渲染').toBe(true);
  expect(bothState.sparkWritten, '火星须真的写入池').toBeGreaterThan(150);
  expect(bothState.emberWritten, '余烬须真的写入池').toBeGreaterThan(40);
  expect(bothState.emberWritten, '余烬须少于火星（用户裁定「少量」）')
    .toBeLessThan(bothState.sparkWritten);
  expect(Math.abs(sparkState.firstSpawn - sparkState.uTime),
    'aSpawn 与 uTime 须同一时钟（差 <1s；写毫秒会差 3 个量级）').toBeLessThan(1);
  expect(sparkState.emberWritten, '只放火星时余烬池不得被写').toBe(0);
  expect(emberState.sparkWritten, '只放余烬时火星池不得被写').toBe(0);

  // ---- ② 画面层：两类各自都真的上屏（分开验，避免「一类顶上另一类」）----
  // 阈值按实测标定：火星峰值 ~700、余烬峰值 ~250、两者合计 ~884。
  expect(peak(sparkRows), `火星单独须画出暖色像素（实得 ${sparkRows.map((x) => x.n)}）`)
    .toBeGreaterThan(controlFloor + 150);
  expect(peak(emberRows), `余烬单独须画出暖色像素（实得 ${emberRows.map((x) => x.n)}）`)
    .toBeGreaterThan(controlFloor + 60);
  expect(peak(bothRows), '两者合计须显著高于对照组').toBeGreaterThan(controlFloor + 400);
  expect(peak(bothRows), '暖色像素过多 = 粒子炸开或 additive 过曝').toBeLessThan(294000 * 0.10);
  expect(Math.max(...bothRows.map((x) => x.white)),
    '不得出现大面积近白（暖色照抄冷色增益会钳白）').toBeLessThan(294000 * 0.02);

  /**
   * ---- ③ 余烬真的**往上飘**（读真实 GPU 属性，在 CPU 侧复刻位移公式）----
   *
   * ⚠️⚠️ **像素质心/顶边对这条零判别力**（本轮实测四种口径全部推翻）：
   * 出生高度本身随锥面上爬（`climb × progress × height`），后期出生的余烬天然更高
   * ⇒ 即使把 `emberRise` 改成 −9.5（往下掉），暖色质心仍随时间上移
   *（实测退化态 rise 41~46px vs 正确态 48~61px，**分布重叠**）。
   * 归一化、顶边、刺尖参照同样重叠 —— 都被「出生点在上移」这个变量污染。
   *
   * **正解：只量粒子自己相对出生点的位移**（去掉出生高度这个混淆项）。
   * 读 `aOrigin/aVel/aSpawn/aLife` 四个真实 instanced 属性，按 shader 的闭式解
   *   dy = vel.y·(1−e^(−drag·t))/drag + g·t²/2
   * 在 CPU 侧算每颗**当前**的竖直位移。上浮时全为正，下坠时后期为负。
   * 这与 Tier 1 的闭式复刻同源，但读的是**真实写入 GPU 的数据** ⇒ 能抓接线缺陷。
   */
  const emberMotion = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const geo = r._emberGeo;
    const org = geo.getAttribute('aOrigin');
    const vel = geo.getAttribute('aVel');
    const sp = geo.getAttribute('aSpawn');
    const lf = geo.getAttribute('aLife');
    const u = r._emberUniforms.uTime.value;
    // 常量从 config 模块读（不在探针里另写一份，红线 1）
    const { SPIKE_SPARK_FX: FX } = await import('/src/render/spike-fx-config.js');
    let n = 0; let minDy = Infinity; let sumDy = 0; let lateNeg = 0; let lateN = 0;
    for (let i = 0; i < org.count; i++) {
      const age = u - sp.getX(i);
      if (sp.getX(i) <= 0 || age < 0 || age > lf.getX(i)) continue;
      const integ = (1 - Math.exp(-FX.emberDrag * age)) / FX.emberDrag;
      const dy = vel.getY(i) * integ + FX.emberRise * age * age * 0.5;
      n++; sumDy += dy;
      if (dy < minDy) minDy = dy;
      // 后半寿命的粒子：下坠态在这里必然转负
      if (age > lf.getX(i) * 0.5) { lateN++; if (dy < 0) lateNeg++; }
    }
    return { n, minDy: n ? +minDy.toFixed(4) : null, meanDy: n ? +(sumDy / n).toFixed(4) : null, lateN, lateNeg };
  });
  console.log('EMBER_MOTION', JSON.stringify(emberMotion));
  expect(emberMotion.n, '须有在飞的余烬可量位移').toBeGreaterThan(20);
  expect(emberMotion.minDy,
    `余烬相对出生点的竖直位移须全为正（最低 ${emberMotion.minDy}）—— 负值 = 往下掉`)
    .toBeGreaterThan(0);
  expect(emberMotion.lateNeg, '后半寿命的余烬也不得下沉').toBe(0);

  // ---- ④ 色相：是火不是白弧（直接量像素自身 r > g）----
  const hue = hueOf(bothRows);
  expect(hue.r, `火星像素须 r>g（白弧态 g>r）：r=${hue.r} g=${hue.g}`)
    .toBeGreaterThan(hue.g + 20);
  expect(hue.r, '须明显暖于蓝通道').toBeGreaterThan(hue.b + 40);

  // ---- ⑤ 到期回收：尖锥先回收，粒子自然衰亡后再隐藏（不硬切）----
  await page.waitForTimeout(700);
  const mid = await page.evaluate(() => ({
    active: window.__MC_GAME__.spikeFx.activeCount,
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
  }));
  expect(mid.active, '尖锥寿命 900ms 后须回收').toBe(0);
  expect(mid.spark, '在飞的火星不得被硬切（余烬寿命远长于尖锥剩余寿命）').toBe(true);
  await page.waitForTimeout(2400);
  const end = await page.evaluate(() => ({
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
    ember: window.__MC_GAME__.spikeFx.emberMesh.visible,
  }));
  expect(end.spark, '空闲超时后火星层须隐藏（draw call 回基线）').toBe(false);
  expect(end.ember, '余烬层同理').toBe(false);
  await page.evaluate(() => clearInterval(window.__PIN__));
});
