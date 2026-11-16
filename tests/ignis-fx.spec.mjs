import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 焰魔砸击特效的 Tier 4 像素实测（v3.04）。
 *
 * **为什么必须像素实测**：法阵是 additive 混合的贴地 quad（`blending` / `opacity` /
 * `texture.offset` 全在 GPU 求值），碎石颜色走 `InstancedMesh.instanceColor`。
 * 数据层（`flameSigil.activeCount` / `blockHitFx.activeDebrisCount`）对，**画面仍可能全错**：
 *   · 基准几何写成 `PlaneGeometry(1,1)` ⇒ 实际尺寸只有一半，计数全绿；
 *   · additive 材质没生效 ⇒ 符文变成一张不透明贴纸，计数全绿；
 *   · `instanceColor` 没写 ⇒ 碎块全白，计数全绿。
 *
 * ## 判据与对照组校准
 *
 * 法阵贴图实测（128×128，非透明 3876/16384 像素）：均值 RGB **222.7 / 179.9 / 51.6**，
 * alpha 全 255。故取 **`r > g && r − b > 100`** 作「金黄符文」判据。
 * ⚠️ **必须带对照组**：沙漠沙 `sand_side` 是 193,183,144（`r − b = 49`）⇒ 被排除，
 * 否则「只是沙漠没有法阵」也会命中，断言失去判别力（同废弃堡垒 v2.89 的教训）。
 *
 * ## 单变量对照（实测标定，第一版写错过）
 *
 * 同一相机、同一地形、同一时刻，**只差有没有 spawn 法阵**；
 * 并且两侧都**先藏掉焰魔的渲染实例**（`inst.mesh.visible = false`）。
 *
 * ⚠️⚠️ **为何必须藏掉焰魔（实测数据，第一版就栩在这里）**：
 * 焰魔本体是**火焰橙皮肤**，它自己就满足 `r > g && r − b > 100`，
 * 而且 idle 动画让它在 1.5s 内剧烈波动。实测分解（同一夹具、同一 clip）：
 *   · 焰魔可见 + 无法阵：**34526 → 34875 → 53108**（波动 ±18000！）
 *   · 焰魔隐藏 + 无法阵：**616 / 616**（地形几乎不贡献 ⇒ 沙漠沙对照有效）
 *   · 焰魔隐藏 + 有法阵：**3449 / 3446** ⇒ **法阵真实贡献 ≈ 2833 像素**
 * 第一版把焰魔留在画面里，于是「法阵永不上屏」的注入退化**仍然 PASS**
 *（onCount 40261 > noiseFloor+3000）—— 判据被焰魔本体噪声淹没，零判别力。
 * 藏掉后两侧只差法阵这一个变量，基线稳定在 ~616。
 *
 * ⚠️ **取基线 + 注入必须在同一次 evaluate 的同一帧内完成**（`boss-audio.spec.mjs` 实测教训）：
 * 分两次 evaluate 时中间隔着 CDP 往返（数十毫秒 = 多帧），焰魔可能在间隙自然起手别的招，
 * 那次的特效被算进增量 ⇒ 误报。
 */

const SEED = 12345;

/** 金黄符文像素数（法阵判据，带沙漠沙对照：r−b=49 被排除） */
function goldenCount(png) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if (r > g && r - b > 100) n++;
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
 * 开阔地（远离城市 —— 建筑遮挡会让 AI 抖动）。**逐行复用 `boss-audio.spec.mjs` 的
 * `gotoOpenField`**：`g._teleportTo(x, 45, z)` + 固定等 2.5s。
 *
 * ⚠️ 实测踩过：改用 `player.spawn(x, 60, z)` + 轮询「脚下实心」会 **30s 超时** ——
 * `_teleportTo` 会触发目标 column 加载，`player.spawn` 不会，于是玩家悬在未加载的空列里。
 */
async function gotoOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));   // 等 column 加载 + 落地
  }, [offsetX, offsetZ]);
}

/**
 * 召一只焰魔并把它**钉到与玩家同高**、相机正前方 4 格，然后俯视。
 *
 * ⚠️ **同高是夹具的必需条件（实测踩过）**：`ignises.summon` 的 `_findGroundY` 会取
 * 「离参考高度最近的可站位置」，开阔地起伏地形下它把焰魔放到了 **y=12**，
 * 而玩家在 **y=4**（差 8 格）⇒ 法阵地面在 y=11~14，**全在相机（y=5.62）上方**
 * ⇒ 俯视根本看不到，金黄像素零变化（569→569）。
 * 钉到同高后实测：4 段全找到地面（y=0/1/1/1）、NDC 全在视锥内
 *（x≈0.02、y∈[−0.12, 0.24]）。
 *
 * 布局：玩家在 (px,pz)，焰魔在玩家 −Z 4 格、yaw=0（正前方 −Z）
 * ⇒ **v3.04b（首段落到脚底）**法阵落在玩家 −Z 方向 **4 / 8.25 / 12.5 / 16.75** 格处
 *（相机看向 −Z）。旧口径（首段 8.5 格）是 8.5/12.75/17/21.25 —— 全在玩家身后，
 * 用户实玩报「对打时看不到」，故首段改成 0（就在焰魔脚下）。
 */
async function setupScene(page) {
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('fx-spec:0', Math.floor(p.x), Math.floor(p.z) + 4, 0, Math.floor(p.y));
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
    // 钉到玩家同高 + 相机正前方 4 格；idle 冻结、零速度
    // ⇒ 两侧截图里它的姿态逐位相同（单变量对照的前提）
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true,
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

test('焰魔特效 Tier 4：地面火焰法阵真的画出来了（金黄像素，带沙漠沙对照）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  const id = await setupScene(page);

  // ---- 前提断言（排除「贴图没加载 → 法阵静默不装配」造成的假绿）----
  const pre = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      hasSigil: !!g.flameSigil,
      geoWidth: g.flameSigil?.mesh?.geometry?.parameters?.width ?? null,
      idleVisible: g.flameSigil?.mesh?.visible ?? null,
      idleActive: g.flameSigil?.activeCount ?? null,
      blending: g.flameSigil?.mesh?.material?.blending ?? null,
      additiveConst: 2,   // THREE.AdditiveBlending
    };
  });
  expect(pre.hasSigil, '法阵层须已装配（贴图缺失会静默退 null）').toBe(true);
  expect(pre.geoWidth, '基准几何边长须为 2（⇒ scale 2.0 后 4×4 格）').toBe(2);
  expect(pre.idleVisible, '零活跃时不得提交渲染（draw call 基线）').toBe(false);
  expect(pre.idleActive).toBe(0);
  expect(pre.blending, 'additive 混合须生效（否则符文是不透明贴纸）').toBe(pre.additiveConst);

  // ---- 藏掉焰魔渲染实例（单变量对照的关键，见文件头实测分解）----
  // 焰魔本体是火焰橙皮肤，自己就满足金黄判据且 idle 动画让它波动 ±18000 像素
  // ⇒ 不藏它，法阵的 ~2833 像素贡献会被噪声淹没（实测：注入退化仍 PASS）。
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

  // ---- 噪声底：同状态重复截图 3 次（已藏焰魔，实测稳定在 ~616）----
  const baseShots = [];
  for (let i = 0; i < 3; i++) {
    baseShots.push(PNG.sync.read(await shoot(page)));
    await page.waitForTimeout(120);
  }
  const baseCounts = baseShots.map(goldenCount);
  const noiseFloor = Math.max(...baseCounts);
  const noiseMin = Math.min(...baseCounts);

  // ---- 注入：同一帧内取基线 + spawn（零 CDP 间隙）----
  // 直接用渲染器的 spawn 入口 + game 的地面查找 ⇒ 与真实消费路径同一套落点算法，
  // 只差「谁来触发」这一个变量（焰魔姿态两侧完全相同）。
  const injected = await page.evaluate(async (entityId) => {
    const { sigilSpawnPoints } = await import('/src/render/flame-sigil.js');
    const g = window.__MC_GAME__;
    const e = g.entities.get(entityId);
    const at = e.state.position;
    const yaw = 0;
    const points = [];
    for (const p of sigilSpawnPoints(at, yaw)) {
      const y = g._findSigilGroundY(p.x, p.z, at[1]);
      if (y === null) continue;
      points.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
    }
    const beforeActive = g.flameSigil.activeCount;
    if (points.length > 0) g.flameSigil.spawn(points, performance.now());
    return { spawned: points.length, beforeActive, ys: points.map((p) => p.y) };
  }, id);
  expect(injected.spawned, '四段都该找到地面（开阔地夹具）').toBe(4);
  // ⚠️ **采样前钉大冷却，防它在等待回收期间自然再起手**（v3.09 实测污染）：
  // 焰魔此刻是 idle，约 1.5s 后会自然起手；旋斩现在也铺法阵（本轮新增）⇒ 第二串 4 段
  // 会让下面「寿命结束须全部回收」读到 4 而不是 0。探针实测 t=1570ms 起手 spin、t=2295ms 命中帧。
  // 这不是放宽断言 —— 断言一字未改，只是把「焰魔又打了一招」这个无关变量排除掉。
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
  }, id);

  // 等最后一段的延迟（200ms）过去 + 若干帧渲染
  await page.waitForTimeout(500);
  const onShot = PNG.sync.read(await shoot(page));
  const onCount = goldenCount(onShot);
  const onWhite = nearWhiteCount(onShot);
  const onActive = await page.evaluate(() => window.__MC_GAME__.flameSigil.activeCount);

  console.log('FX_SIGIL_COUNTS', JSON.stringify({
    baseCounts, noiseFloor, noiseMin, onCount, onWhite, onActive, injected,
  }));

  // ---- 上下界都钉（阈值按实测标定，不是拍脑袋）----
  // 实测（已藏焰魔的单变量对照）：
  //   · v3.04（首段 8.5 格）：基线 554、法阵帧 2885~2889
  //   · **v3.04b（首段落到脚底，用户裁定）**：基线 **554/554/554**、法阵帧 **2497**
  //     （Δ≈1943）—— 比旧值少是因为首段现在在焰魔脚下、距相机更近但部分落在
  //     玩家身后的低处（实测 ys=[-1,8,0,1]），投影面积变小。
  // 下界取 noiseFloor + 900：远高于基线噪声（实测 0）、约为实测增量的一半
  // ⇒ 两侧余量对称（下 900 / 上 ≈1043），不因机器负载 flaky。
  expect(onCount, `法阵帧金黄像素须显著高于噪声底（base=${baseCounts}）`).toBeGreaterThan(noiseFloor + 900);
  // 上界：不得烧成白团。实测法阵帧 3449（占 clip 294000 的 1.2%），
  // 上界取 8%：远高于实测、又能抓住「四段叠成一大片过曝」。
  expect(onCount, '金黄像素占比过高 = additive 叠成一片过曝').toBeLessThan(294000 * 0.08);
  expect(onWhite, '不得出现大面积近白（additive 过曝）').toBeLessThan(294000 * 0.02);
  expect(onActive, '四段应仍在活跃（寿命 3s，采样在 0.5s）').toBe(injected.spawned);
  // ⚠️ 法阵必须真的**提交渲染**了 —— 这条是「永不上屏」注入退化的直接判据。
  const litNow = await page.evaluate(() => window.__MC_GAME__.flameSigil.mesh.visible);
  expect(litNow, '法阵须 visible=true（否则根本没画）').toBe(true);

  // ---- 寿命结束后回到 visible=false（draw call 回基线）----
  await page.waitForTimeout(3200);
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { active: g.flameSigil.activeCount, visible: g.flameSigil.mesh.visible };
  });
  expect(after.active, '寿命结束后须全部回收').toBe(0);
  expect(after.visible, '回收后须 visible=false（draw call 回基线）').toBe(false);
});

test('焰魔特效 Tier 4：碎石圆环走真实命中帧路径（不受 freshLos 影响）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page, { offsetX: 900, offsetZ: 900 });
  const id = await setupScene(page);

  const beforeShot = PNG.sync.read(await shoot(page));
  const beforeLit = goldenCount(beforeShot);

  // 钉 shieldBash 起手，让**真实帧循环**推进到命中帧（1.89s）⇒ 走真实消费路径。
  // ⚠️ 同一次 evaluate 内注入（零 CDP 间隙，见文件头）。
  await page.evaluate((entityId) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(entityId);
    e.state = {
      ...e.state, mode: 'attack', attackKind: 'shieldBash', attackAnimT: 0,
      yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999,
    };
  }, id);

  // 等碎块入池（命中帧 1.89s + 余量）
  await page.waitForFunction(() => window.__MC_GAME__.blockHitFx.activeDebrisCount > 0,
    null, { timeout: 30_000 });
  const mid = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      debris: g.blockHitFx.activeDebrisCount,
      debrisVisible: g.blockHitFx.debrisMesh.visible,
      sigilActive: g.flameSigil.activeCount,
    };
  });
  // ⚠️ **法阵的 visible 不能在命中帧当帧读**：四段延迟 0/50/150/200ms，
  // 而 `waitForFunction` 轮询粒度可能正好落在第一段点亮之前 ⇒ 实测到 `visible:false`
  //（那不是缺陷，是采样时机）。等最后一段延迟过后再读，才有判别力。
  await page.waitForTimeout(400);
  const sigilLit = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { visible: g.flameSigil.mesh.visible, active: g.flameSigil.activeCount };
  });
  const afterShot = PNG.sync.read(await shoot(page));
  const afterLit = goldenCount(afterShot);
  console.log('FX_DEBRIS', JSON.stringify({ mid, sigilLit, beforeLit, afterLit }));

  // 碎石块数读常量（v3.04c：28 → 42，用户要求 +50%），且复用既有池 ⇒ 可见
  expect(mid.debris, '命中帧须出碎石').toBeGreaterThanOrEqual(42);
  expect(mid.debrisVisible).toBe(true);
  // 举盾砸击同时出法阵，且延迟过后**真的提交渲染**
  expect(mid.sigilActive, '举盾砸击须同时铺法阵').toBeGreaterThan(0);
  expect(sigilLit.visible, '延迟过后法阵须 visible=true（否则根本没画）').toBe(true);

  // ---- 用户 v3.04b 两项裁定的**真实消费路径**判据 ----
  // 上面那条只证「出了特效」；这两条证「出在用户要的位置/尺寸」。
  // ⚠️ 读的是真实帧循环产出的落点（不是测试自己算的），所以能抓接线层缺陷。
  const geometry = await page.evaluate(async (eid) => {
    const { smashRingCenter, IGNIS_SMASH_DEBRIS, debrisOffset } = await import('/src/render/block-hit-fx.js');
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    const at = e.state.position;
    // 法阵首段：渲染器里 slot 0 的实例矩阵位移（真实 three.Matrix4，不自己造 stub）
    const m = new THREE.Matrix4();
    g.flameSigil.mesh.getMatrixAt(0, m);
    const firstX = m.elements[12];
    const firstZ = m.elements[14];
    const c = smashRingCenter(at, e.state.yaw);
    // v3.04c：**从真实实例矩阵**量碎块边长（scale 已含自旋，取列向量长度）
    // ⇒ 证「尺寸×2 真的到了 GPU」，而不是只改了常量。
    const dm = new THREE.Matrix4();
    let maxEdge = 0;
    for (let i = 0; i < g.blockHitFx.activeDebrisCount; i++) {
      g.blockHitFx.debrisMesh.getMatrixAt(i, dm);
      const el = dm.elements;
      const sx = Math.hypot(el[0], el[1], el[2]);
      if (sx > maxEdge) maxEdge = sx;
    }
    // v3.04c：弹跳峰高 —— 用**真实 debrisOffset** 扫整条寿命，对比旧 speed 上界 2.6
    const peakOf = (speed) => {
      const seed = { velocity: [0, speed, 0] };
      const out = [0, 0, 0];
      let mx = -Infinity;
      for (let ms = 0; ms <= 620; ms += 2) {
        debrisOffset(seed, ms, out);
        if (out[1] > mx) mx = out[1];
      }
      return mx;
    };
    return {
      firstSegmentDist: Math.hypot(firstX - at[0], firstZ - at[2]),
      debrisRadius: IGNIS_SMASH_DEBRIS.radius,
      ringCenterDist: Math.hypot(c[0] - at[0], c[2] - at[2]),
      debrisCount: g.blockHitFx.activeDebrisCount,
      cfgSize: IGNIS_SMASH_DEBRIS.size,
      maxInstanceEdge: maxEdge,
      peakRatio: peakOf(IGNIS_SMASH_DEBRIS.speed[1]) / peakOf(2.6),
    };
  }, id);
  console.log('FX_GEOMETRY', JSON.stringify(geometry));
  // 首段就在脚底（用户：「第一个圆圈就在焰魔的脚底下的位置」）
  expect(geometry.firstSegmentDist, '首段须就在焰魔脚底').toBeLessThan(0.01);
  // 碎石半径已翻倍（用户：「面积扩大一倍」）
  expect(geometry.debrisRadius, '碎石半径须为 2.6（原版 1.3 翻倍）').toBe(2.6);
  // ---- v3.04c 三项裁定的真实渲染路径判据 ----
  expect(geometry.debrisCount, '碎石块数须 42（+50%）').toBe(42);
  expect(geometry.cfgSize, '碎块边长区间须翻倍').toEqual([0.28, 0.48]);
  // 真实实例矩阵里边长不得超过新区间上界（且明显大于旧上界 0.24）
  expect(geometry.maxInstanceEdge, '实例边长须落在新区间内').toBeLessThanOrEqual(0.48 + 1e-6);
  expect(geometry.maxInstanceEdge, '实例边长须明显大于旧上界 0.24（证尺寸真的到了 GPU）')
    .toBeGreaterThan(0.24);
  // 弹跳峰高恰好 ×2（h ∝ vy² ⇒ speed ×√2）
  expect(Math.abs(geometry.peakRatio - 2), '弹跳峰高须恰好翻倍').toBeLessThan(0.02);

  // 画面须有变化（碎块 + 法阵）。用「像素差」而不是颜色判据 —— 碎块颜色取自地形，
  // 开阔地可能是草/石/沙，写死颜色会让判据依赖地形。
  let changed = 0;
  for (let i = 0; i < beforeShot.data.length; i += 4) {
    const d = Math.abs(beforeShot.data[i] - afterShot.data[i])
      + Math.abs(beforeShot.data[i + 1] - afterShot.data[i + 1])
      + Math.abs(beforeShot.data[i + 2] - afterShot.data[i + 2]);
    if (d > 30) changed++;
  }
  console.log('FX_DEBRIS_CHANGED', changed);
  expect(changed, '命中特效须让画面产生可见变化').toBeGreaterThan(300);

  // 到期回收
  await page.waitForTimeout(3600);
  const end = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { debris: g.blockHitFx.activeDebrisCount, sigil: g.flameSigil.activeCount };
  });
  expect(end.debris, '碎石到期须回收').toBe(0);
  expect(end.sigil, '法阵到期须回收').toBe(0);
});

/**
 * v3.09：旋斩（spin）也要铺地面法阵，**位置与举盾砸击逐字相同**
 * （用户 2026-11-16：「旋转攻击也要加上法阵的图案，跟盾击攻击一样，位置也跟盾击一样」）。
 *
 * 走**真实帧循环**到命中帧 0.70s（不是直接调 spawn）⇒ 能抓装配层的招式过滤缺陷。
 * 判据与举盾砸击那条同口径：藏掉焰魔本体 → 噪声底 → 金黄像素上下界 + 首段矩阵位移。
 *
 * ⚠️ **采样后必须把 attackCooldown 钉大**：旋斩动画只 1.90s、收势后空档 1.0~1.5s
 * ⇒ 约 3s 后它会再起手，若那一招是举盾砸击就会再铺一串法阵，让「到期回收」断言 flaky。
 */
test('焰魔特效 Tier 4：旋斩命中帧铺法阵，位置与举盾砸击同源（首段在脚底）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page);
  const id = await setupScene(page);

  // 单变量对照：藏掉焰魔本体（它自带火焰橙、idle 波动 ±18000 像素会淹没判据）
  const hid = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    return true;
  }, id);
  expect(hid, '前置：须能藏掉焰魔渲染实例').toBe(true);
  await page.waitForTimeout(300);

  const baseCounts = [];
  for (let i = 0; i < 3; i++) {
    baseCounts.push(goldenCount(PNG.sync.read(await shoot(page))));
    await page.waitForTimeout(120);
  }
  const noiseFloor = Math.max(...baseCounts);

  // 钉旋斩起手，让真实帧循环推进到命中帧（同一次 evaluate 内注入，零 CDP 间隙）
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = {
      ...e.state, mode: 'attack', attackKind: 'spin', attackAnimT: 0,
      yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999,
    };
  }, id);
  await page.waitForFunction(() => window.__MC_GAME__.flameSigil.activeCount > 0,
    null, { timeout: 15_000 });
  await page.waitForTimeout(400);   // 等最后一段延迟（200ms）过去再读 visible

  const lit = await page.evaluate(() => ({
    visible: window.__MC_GAME__.flameSigil.mesh.visible,
    active: window.__MC_GAME__.flameSigil.activeCount,
  }));
  const onShot = PNG.sync.read(await shoot(page));
  const onCount = goldenCount(onShot);
  const onWhite = nearWhiteCount(onShot);
  // 首段实例矩阵位移 == 焰魔脚底（真实 three.Matrix4，不自己造 stub）
  const geo = await page.evaluate(async (eid) => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const at = g.entities.get(eid).state.position;
    const m = new THREE.Matrix4();
    g.flameSigil.mesh.getMatrixAt(0, m);
    return { firstSegmentDist: Math.hypot(m.elements[12] - at[0], m.elements[14] - at[2]) };
  }, id);
  // 采样完毕：钉大冷却，防它在等待回收期间再起手铺第二串（见文件头 ⚠️）
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
  }, id);

  console.log('FX_SPIN_SIGIL', JSON.stringify({ baseCounts, noiseFloor, onCount, onWhite, lit, geo }));

  expect(lit.active, '旋斩须铺 4 段法阵').toBe(4);
  expect(lit.visible, '延迟过后法阵须真的提交渲染').toBe(true);
  expect(geo.firstSegmentDist, '首段必须落在焰魔脚底（与举盾砸击同口径）').toBeLessThan(0.01);
  expect(onCount, `金黄像素须显著高于噪声底（base=${baseCounts}）`).toBeGreaterThan(noiseFloor + 900);
  expect(onCount, '不得 additive 叠成一片过曝').toBeLessThan(294000 * 0.08);
  expect(onWhite, '不得出现大面积近白').toBeLessThan(294000 * 0.02);

  await page.waitForTimeout(3600);
  const end = await page.evaluate(() => ({
    active: window.__MC_GAME__.flameSigil.activeCount,
    visible: window.__MC_GAME__.flameSigil.mesh.visible,
  }));
  expect(end.active, '寿命结束须回收').toBe(0);
  expect(end.visible, '回收后 draw call 回基线').toBe(false);
});
