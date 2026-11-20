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

/**
 * 「变红」像素数（**差分判据**，v3.22 火圈用）：红增量 > 25 且显著大于绿/蓝增量。
 *
 * ⚠️ **不能用绝对色判据**：additive 叠在蓝天空上后结果仍偏蓝
 * （`ignis-spike.spec.mjs` 实测 125,147,176）⇒ `r > g + 40` 永远不成立、零判别力。
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

/**
 * 暖色像素相对**图像中心竖轴**的横向散度（v3.22：证「逐渐向外扩张」）。
 *
 * ⚠️⚠️ **为何不用包围盒宽度**（本轮实测推翻）：终值直径 13 格的环在 11 格机位下
 * **超出 700px 采样区** ⇒ min/max 与 5%/95% 分位**全部饱和到边缘**
 * （实测 654 → 650，而半径 0.94 → 6.35）⇒ 零判别力。
 *
 * 改用**平均绝对横向偏移**（mean |x − cx|）：环外扩时像素质量整体远离中轴，
 * 即使两侧都被截断，均值仍单调增大（实测 179 → 244）。
 *
 * ⚠️ **cx 取图像中心而不是暖色质心**：焰魔就在相机正前方（yaw=0）⇒ 环心投影
 * 恒在中心竖轴；取质心会让「环变大」被归一化掉（均值永远≈半宽）。
 * 另：**不取最亮像素定中心**（会被同量级的火星抢走原点，AGENTS.md 已记）。
 *
 * @returns {{meanAbsDx:number, p90AbsDx:number, count:number}}
 */
function warmSpread(before, after) {
  const cx = before.width / 2;
  const ds = [];
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = after.data[i] - before.data[i];
    const dg = after.data[i + 1] - before.data[i + 1];
    const db = after.data[i + 2] - before.data[i + 2];
    if (dr > 25 && dr > dg + 12 && dr > db + 12) ds.push(Math.abs((i / 4) % before.width - cx));
  }
  if (ds.length === 0) return { meanAbsDx: 0, p90AbsDx: 0, count: 0 };
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  ds.sort((a, b) => a - b);
  return { meanAbsDx: mean, p90AbsDx: ds[Math.floor(ds.length * 0.9)], count: ds.length };
}

/**
 * 暖色像素的**平均 RGB**（v3.22：证「是火不是白弧」）。
 *
 * ⚠️ 只数「变红」像素不够：白弧在绿草地上也满足 Δr>Δg（白抬三通道，绿底 g 已高）。
 * 必须直接量环像素自身的 r 与 g —— 实测缺陷态 g>r，修好后 r−g≈40。
 */
function warmMeanRGB(before, after) {
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = after.data[i] - before.data[i];
    const dg = after.data[i + 1] - before.data[i + 1];
    const db = after.data[i + 2] - before.data[i + 2];
    if (dr > 25 && dr > dg + 12 && dr > db + 12) {
      n++; sr += after.data[i]; sg += after.data[i + 1]; sb += after.data[i + 2];
    }
  }
  if (!n) return { n: 0, r: 0, g: 0, b: 0 };
  return { n, r: +(sr / n).toFixed(1), g: +(sg / n).toFixed(1), b: +(sb / n).toFixed(1) };
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

/**
 * v3.22：持盾冲撞 / 举盾砸击的**扩散火圈**走真实命中帧路径（取代原碎石圆环）。
 *
 * 用户 2026-11-20：「把地上扬起的碎石块的特效改为扩散火圈……以焰魔为中心来散出一个
 * 逐渐向外燃烧的火圈，不需要外加声音，只实现视觉特效」。两招都换。
 *
 * ## 判据三件（缺一就没有判别力）
 *
 * ① **差分暖色像素**（`redderCount`）：additive 叠在蓝天空上后绝对色仍偏蓝
 *    （尖刺 spec 实测 125,147,176）⇒ 绝对色判据零判别力，必须两侧做差。
 * ② **藏掉焰魔本体**：它自带火焰橙且 idle 波动 ±18000 像素，不藏则
 *    「火圈永不上屏」的注入退化仍会 PASS（v3.04 实测）。
 * ③ **包围盒随时间变宽**：只数亮像素证明不了「逐渐向外」——
 *    恒定半径的圆环给出同样的计数。故在早/晚两个时刻各拍一张，量暖色像素的
 *    水平包围盒宽度，后者必须显著更宽。
 *
 * ⚠️⚠️ **必须藏掉地面法阵（本轮实测踩到）**：举盾砸击同时铺 4 段金黄法阵，
 * 它同样满足暖色差分判据 ⇒ 不藏它时量到的是**法阵在递延点亮**（段 1~3 延迟
 * 50/150/200ms，早期采样在它们点亮之前）—— 实测包围盒 197 → 180（**变窄**），
 * 而火圈半径 0.94 → 6.45 确实扩了 6.9 倍。藏法阵后两侧只差火圈这一个变量。
 * （同「发光特效必须先藏掉自带同色的宿主」那条教训，只是宿主这次是另一个特效层。）
 *
 * ⚠️ **机位要容得下整个环**：终值半径 6.5 格 ⇒ 直径 13 格，而 setupScene 把焰魔
 * 放在 4 格外 ⇒ 环的近半在相机身后。故本用例把焰魔推到 **11 格**外并加大俯视，
 * 让整个环落在视野内（否则外扩被画面边缘截断，包围盒宽度饱和 ⇒ 零判别力）。
 *
 * ⚠️ **举盾砸击仍同时铺法阵**：本轮只换碎石，法阵一行未动 ⇒ 另读数据层断言它仍在。
 */
test('焰魔特效 Tier 4：扩散火圈走真实命中帧路径，圆心在脚底且逐渐向外扩张', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page, { offsetX: 900, offsetZ: 900 });
  const id = await setupScene(page);

  // ---- 前提断言（排除「层没装配」造成的假绿）----
  const pre = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.fireRing;
    return {
      hasRing: !!r,
      idleVisible: r ? r.meshes.every((m) => !m.visible) : null,
      idleActive: r?.activeCount ?? null,
      meshCount: r?.meshes.length ?? 0,
      // 环材质的混合模式（additive=2）与几何朝向
      blending: r?.meshes[0]?.material?.blending ?? null,
      sparkBlending: r?.sparkMesh?.material?.blending ?? null,
      normalY: r?.meshes[0]?.geometry?.getAttribute('normal')?.getY(0) ?? null,
      lift: r?.meshes[0] ? r.meshes[0].position.y : null,
    };
  });
  expect(pre.hasRing, '火圈层须已装配（无贴图依赖 ⇒ 恒装配）').toBe(true);
  expect(pre.idleVisible, '零活跃时全部 mesh 不得提交渲染（draw call 基线）').toBe(true);
  expect(pre.idleActive).toBe(0);
  // ⚠️ 环走 **NormalBlending(1)**：暖橙 additive 会在亮草地上钳成白弧
  //（本轮实测 g>r）；火星仍是 additive(2) 才读作迸出的火。
  expect(pre.blending, '环须 NormalBlending（additive 会把暖橙钳成白）').toBe(1);
  expect(pre.sparkBlending, '火星须 additive').toBe(2);
  expect(pre.normalY, '几何须已旋成贴地 XZ 平面（法线 +Y）').toBeCloseTo(1, 5);

  // ---- 藏掉焰魔本体（单变量对照的关键）----
  const hid = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    return true;
  }, id);
  expect(hid, '前置：须能藏掉焰魔渲染实例（否则判据没有判别力）').toBe(true);
  // ⚠️ 同时藏掉**地面法阵**：它与火圈同色系，不藏则量到的是法阵递延点亮（见文件头）
  const hidSigil = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (!g.flameSigil?.mesh) return false;
    g.flameSigil.mesh.visible = false;
    // update() 每帧会按活跃段重算 visible ⇒ 同时把它的 update 换成空转
    g.flameSigil.update = () => {};
    return true;
  });
  expect(hidSigil, '前置：须能藏掉地面法阵（同色系宿主）').toBe(true);
  // 机位：焰魔推到 11 格外 + 加大俯视 ⇒ 直径 13 格的环完整入画
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, p.y, Math.floor(p.z) - 11 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0], yaw: 0, onGround: true,
    };
    g.player.yaw = 0;
    g.player.pitch = -0.62;
  }, id);
  await page.waitForTimeout(400);

  // ---- 噪声底：同状态重复截图 3 次，两两做差 ----
  const baseShots = [];
  for (let i = 0; i < 3; i++) {
    baseShots.push(PNG.sync.read(await shoot(page)));
    await page.waitForTimeout(120);
  }
  const baseCounts = [
    redderCount(baseShots[0], baseShots[1]),
    redderCount(baseShots[1], baseShots[2]),
  ];
  const noiseFloor = Math.max(...baseCounts);
  const baseline = baseShots[2];

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

  // 等火圈入池（命中帧 1.89s + 余量）
  await page.waitForFunction(() => window.__MC_GAME__.fireRing.activeCount > 0,
    null, { timeout: 30_000 });
  /**
   * ⚠️⚠️ **两个采样点按「真实半径」等，不按墙钟等待**（本轮实测踩到）：
   * `waitForFunction` 的轮询粒度可能恰好落在 spawn 那一帧（实测半径 **0.70 格**），
   * 1.4 格直径的环在 11 格机位下投影不足阈值 ⇒ 暖色像素 **0**，
   * 看起来像「火圈没画」而它完全正常（同帧 radius/visible 均正确）。
   * 改成等半径进入目标区间再拍，两侧机位/地形/相机全不变。
   */
  await page.waitForFunction(() => {
    const r = window.__MC_GAME__.fireRing.radiusOf(0);
    return r >= 2 && r <= 3.6;
  }, null, { timeout: 15_000 });

  // ---- 早期采样：半径还小的时候 ----
  const early = await page.evaluate(async (eid) => {
    const { FIRE_RING } = await import('/src/render/fire-ring-config.js');
    const g = window.__MC_GAME__;
    const at = g.entities.get(eid).state.position;
    const r = g.fireRing;
    return {
      radius: r.radiusOf(0),
      // 圆心必须落在焰魔脚底（读真实 mesh.position，不是测试自己算的）
      dx: r.meshes[0].position.x - at[0],
      dz: r.meshes[0].position.z - at[2],
      visible: r.meshes[0].visible,
      sparkVisible: r.sparkMesh.visible,
      startRadius: FIRE_RING.startRadius,
      endRadius: FIRE_RING.endRadius,
      debris: g.blockHitFx.activeDebrisCount,
      sigil: g.flameSigil.activeCount,
    };
  }, id);
  const earlyShot = PNG.sync.read(await shoot(page));

  // ---- 晚期采样：半径已扩到接近终值（同样按半径等，不拍运气）----
  await page.waitForFunction(() => window.__MC_GAME__.fireRing.radiusOf(0) >= 5.8,
    null, { timeout: 15_000 });
  const late = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { radius: g.fireRing.radiusOf(0), active: g.fireRing.activeCount };
  });
  const lateShot = PNG.sync.read(await shoot(page));

  // 采样完毕：钉大冷却，防它在等待回收期间自然再起手（同法阵用例的口径）
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
  }, id);

  const earlyLit = redderCount(baseline, earlyShot);
  const lateLit = redderCount(baseline, lateShot);
  const earlyBox = warmSpread(baseline, earlyShot);
  const lateBox = warmSpread(baseline, lateShot);
  const lateWhite = nearWhiteCount(lateShot);
  console.log('FX_FIRE_RING', JSON.stringify({
    baseCounts, noiseFloor, earlyLit, lateLit, earlyBox, lateBox, early, late, lateWhite,
  }));

  // ---- ① 圆心在脚底（用户「以焰魔为中心」）----
  expect(Math.abs(early.dx), '火圈圆心 x 须 = 焰魔脚底（旧碎石环心前移 2.75 格）').toBeLessThan(0.01);
  expect(Math.abs(early.dz), '火圈圆心 z 须 = 焰魔脚底').toBeLessThan(0.01);
  expect(early.visible, '火圈须真的提交渲染').toBe(true);

  // ---- ② 半径真的外扩（读真实 uniform）----
  expect(late.radius, '半径须随时间外扩').toBeGreaterThan(early.radius + 1);
  expect(late.radius, '不得超过终值半径').toBeLessThanOrEqual(early.endRadius + 1e-6);

  // ---- ③ 画面上真的烧起来了（差分暖色，上下界都钉）----
  expect(earlyLit, `火圈帧暖色像素须显著高于噪声底（base=${baseCounts}）`)
    .toBeGreaterThan(noiseFloor + 300);
  expect(earlyLit, '暖色像素过多 = 几何炸开或 additive 过曝').toBeLessThan(294000 * 0.25);
  expect(lateWhite, '不得出现大面积近白（暖色 additive 照抄冷色增益会钳白）')
    .toBeLessThan(294000 * 0.02);
  // ⚠️⚠️ **色相判据（本轮实测新增）**：只数「变红」像素不够 ——
  // 白弧在绿草地上也满足 Δr>Δg（白把三通道都抬，但绿底 g 已高）。
  // 必须直接钉**环像素自身 r > g**：实测 additive+宽白热核时 g>r（白弧），
  // 修好后 r−g ≈ 40。这条是「火而不是白弧」的直接判据。
  const hue = warmMeanRGB(baseline, lateShot);
  console.log('FX_FIRE_RING_HUE', JSON.stringify(hue));
  expect(hue.n, '须有足够的环像素可量色相').toBeGreaterThan(300);
  // 阈值按**两侧实测**取中：NormalBlending + 窄白热核 r−g ≈ 40~50；
  // 退回 additive（单变量）实测 r−g ≈ 25；两者都退回时 g>r（白弧）。
  // 取 32 ⇒ 三种退化态全部落在线下，而正确态有 ~10 的余量。
  expect(hue.r, `环像素须显著 r>g（additive 态实测仅 +25，白弧态 g>r）：r=${hue.r} g=${hue.g}`)
    .toBeGreaterThan(hue.g + 32);
  expect(hue.r, '环像素须明显暖于蓝通道').toBeGreaterThan(hue.b + 30);

  // ---- ④ 「逐渐向外」的画面判据：暖色像素必须整体远离中轴 ----
  // 只数像素证明不了外扩（恒定圆环给出同样的计数）；包围盒宽度也不行 ——
  // 13 格直径的环在 11 格机位下超出 700px 采样区，min/max 与分位全部饱和
  // （实测 654 → 650 而半径 0.94 → 6.35）⇒ 改用平均绝对横向偏移。
  expect(earlyBox.count, '早期须有可测量的暖色区域').toBeGreaterThan(100);
  expect(lateBox.meanAbsDx,
    `晚期暖色须整体更远离中轴（早 ${earlyBox.meanAbsDx.toFixed(1)} → 晚 ${lateBox.meanAbsDx.toFixed(1)}）`)
    .toBeGreaterThan(earlyBox.meanAbsDx * 1.15);

  // ---- ⑤ 本轮只换碎石：法阵仍在，碎块池不再被这两招占用 ----
  expect(early.sigil, '举盾砸击须仍同时铺法阵（本轮未动它）').toBeGreaterThan(0);
  expect(early.debris, '两招不得再往碎块池里塞碎石').toBe(0);

  // ---- 到期回收（draw call 回基线）----
  await page.waitForTimeout(2600);
  const end = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      ring: g.fireRing.activeCount,
      ringVisible: g.fireRing.meshes.some((m) => m.visible),
    };
  });
  expect(end.ring, '火圈到期须回收').toBe(0);
  expect(end.ringVisible, '回收后全部 mesh 须 visible=false').toBe(false);
  // ⚠️ **不在这里断言法阵回收**：本用例为单变量对照把 `flameSigil.update` 换成了
  // 空转（否则它每帧重算 visible 会污染像素），那之后它的 slot 永远不会回收 ——
  // 断言它=0 是**探针自己造成的**，不是生产缺陷。法阵回收由本文件另两条用例守。
});

/**
 * v3.22：**持盾冲撞**（用户口语「头部撞击」）也要出火圈。
 *
 * 与上一条分开是因为它走**另一条招式分支**：装配层的 `req.kind` 过滤若漏了
 * `shieldSmash`，上一条（shieldBash）仍全绿 —— 正是「改了却一点效果也没有」的形态。
 * 本条只钉「这一招真的出火圈 + 画面真的变了」，观感判据由上一条覆盖。
 */
test('焰魔特效 Tier 4：持盾冲撞命中帧也出火圈（招式分支不得漏）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0`);
  await waitWorldReady(page);
  await gotoOpenField(page, { offsetX: 1800, offsetZ: 1800 });
  const id = await setupScene(page);

  const hid = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    return true;
  }, id);
  expect(hid).toBe(true);
  await page.waitForTimeout(300);
  const baseline = PNG.sync.read(await shoot(page));

  // 钉 shieldSmash 起手，真实帧循环推进到命中帧 1.70s
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = {
      ...e.state, mode: 'attack', attackKind: 'shieldSmash', attackAnimT: 0,
      yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999,
    };
  }, id);
  await page.waitForFunction(() => window.__MC_GAME__.fireRing.activeCount > 0,
    null, { timeout: 30_000 });
  await page.waitForTimeout(250);

  const state = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      active: g.fireRing.activeCount,
      radius: g.fireRing.radiusOf(0),
      visible: g.fireRing.meshes[0].visible,
      debris: g.blockHitFx.activeDebrisCount,
      // 持盾冲撞**不铺法阵**（法阵只给 shieldBash / spin）
      sigil: g.flameSigil.activeCount,
    };
  });
  const shot = PNG.sync.read(await shoot(page));
  const lit = redderCount(baseline, shot);
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
  }, id);
  console.log('FX_FIRE_RING_SMASH', JSON.stringify({ state, lit }));

  expect(state.active, '持盾冲撞须出 1 个火圈').toBe(1);
  expect(state.visible, '火圈须真的提交渲染').toBe(true);
  expect(state.radius, '半径须已从起始值扩出去').toBeGreaterThan(0.5);
  expect(state.debris, '不得再出碎石').toBe(0);
  expect(state.sigil, '持盾冲撞不铺法阵（本轮未改这条分工）').toBe(0);
  expect(lit, '画面须真的烧起来（差分暖色像素）').toBeGreaterThan(300);

  await page.waitForTimeout(2600);
  const end = await page.evaluate(() => ({
    ring: window.__MC_GAME__.fireRing.activeCount,
    visible: window.__MC_GAME__.fireRing.meshes.some((m) => m.visible),
  }));
  expect(end.ring, '到期须回收').toBe(0);
  expect(end.visible, '回收后 draw call 回基线').toBe(false);
});/**
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
