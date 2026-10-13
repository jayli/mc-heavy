// tests/sun-shadow.spec.mjs — 太阳阴影（shadow map）最小接线验收（Task 3）
//
// 本 spec 是 spec §8 风险闸门的落点：WebGPU 阴影 pass 对 BatchedMesh（自定义 packed
// 属性布局 + per-instance 剔除）的兼容性在 r185.1 无现成验证 —— 用例 2 用**像素实测**
// 证明「阴影真的出现」。闸门失败（两区亮度无差异）时不得在本 spec 内自行改道。
//
// ⚠️ 亮度阈值先探针实测再定（本仓铁律「写断言前必须先在真实数据上跑一次」），
// 不贴线（留 >20% 余量）；实测值记录在用例 2 注释里。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** three.core.js:88 `const VSMShadowMap = 3`（vendor 冻结版本）—— DR-4b 用户拍板的档位 */
const VSM_SHADOW_MAP = 3;

/**
 * 等世界真正稳定（整段照 tests/tnt.spec.mjs 复制 —— 各 spec 各自定义，无共享模块）。
 * ⚠️ 不能只判队列归零（瞬时状态）：sections 连续两次采样不变 + 全队列归零才是真稳态。
 */
async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（照 tests/explosion-sprite.spec.mjs 手法） */
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
const lum = (c) => (c.r + c.g + c.b) / 3;

/**
 * 起页 URL。⚠️ brief 原写 vd=4，实测采用 vd=2（加载半径小 → 稳定快，与 tnt.spec 同口径）。
 * style=noon 固定正午（settings.js:73 消费）；weather=clear 钉死天气 —— 天气状态机会随机
 * 转雨，雨丝污染亮度取样（同 minecart-render.spec 口径）。
 */
const URL = '/?vd=2&seed=12345&style=noon&weather=clear';

/**
 * `?shadows=0` 起页（Task 5 URL 入口）：除 shadows 外与 URL 逐键相同 —— 地形/风格/天气
 * 口径一致，唯一变量是阴影开关（「对照只差一个变量」）。
 */
const SHADOWS_OFF_URL = '/?vd=2&seed=12345&style=noon&weather=clear&shadows=0';

/**
 * 搭 Tier 4 俯视平台（用例 2/3/4 共用 setup；几何与判据说明见用例 2 顶部注释）。
 * 清平台上空 ±14 → ±14 全 stone 平台 → 3 格石柱 → 手动摆光源 → 冻结玩家 → 隐藏 HUD →
 * 近垂直俯视相机。返回平台中心的世界坐标 (ox, oz)。
 *
 * ⚠️ **光源为什么仍需手动摆**（Task 4 已交付光源跟随，Ruling f）：跟随把阴影相机居中到
 * **玩家**（±30 覆盖），而被测平台在玩家头顶约 58 格（P=80 vs 出生点 y≈22）→ 平台整体在
 * 阴影相机视锥外。手动定位只是把被测物挪进阴影相机覆盖范围，**不是补机制缺位**；采样时
 * 的光源方向仍读真实接线 `dayNight.params.sunDirection`（无字面量方向）。
 */
async function setupShadowPlatform(page, P) {
  const { ox, oz } = await page.evaluate((P) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const stone = g.registry.idOf('stone');
    // 清平台上空 ±14（y=81..95）：云/空岛/建筑全部清掉 → 取样区只剩平台顶面与天空
    for (let y = P + 1; y <= 95; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
        const x = ox + dx, z = oz + dz;
        if (g.world.getBlockId(x, y, z) !== 0) g.editor.setBlock({ x, y, z, id: 0 });
      }
    }
    // 全 stone 平台（同一材质 → 同一贴图 tile，消除材质差异这个变量）
    for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) {
      g.editor.setBlock({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    // 3 格高石柱立平台中央
    for (let dy = 1; dy <= 3; dy++) g.editor.setBlock({ x: ox, y: P + dy, z: oz, id: stone });
    // 光源摆到被测物上方（理由见本函数 JSDoc；noon 归一化方向 (0,0.8,0.6) 来自 dayNight）
    if (g.sunLight) {
      const dir = g.dayNight.params.sunDirection;
      g.sunLight.position.set(ox + 0.5 + dir[0] * 60, P + dir[1] * 60, oz + 0.5 + dir[2] * 60);
      g.sunLight.target.position.set(ox + 0.5, P, oz + 0.5);
      g.sunLight.target.updateMatrixWorld();
    }
    // 冻结玩家（pushModal → 帧循环跳过 player.update → 相机不会被物理挪走）
    g.pushModal('tier4-shadow');
    // ⚠️ 隐藏**全部** HUD 覆盖物（见用例 2 顶部注释：perf HUD 半透明黑底会造假暗区）
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
    // 近垂直俯视（+X 偏 3 格避免 lookAt 的 up 退化；该姿态已实测平台均匀 spread=0）
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 3, P + 22, oz + 0.5);
    g.camera.lookAt(ox + 0.5, P + 1, oz + 0.5);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    return { ox, oz };
  }, P);
  await waitWorldSettled(page);   // 等清场 + 立柱的 remesh 收敛
  await page.waitForTimeout(1500);
  return { ox, oz };
}

/**
 * 读区 A（影区）/ 区 B（开阔区）亮度。
 * @param {number|null} strength 数字 → 直写 `uShadowStrength` 并等待渲染（用例 2 的
 *   自校准手法：同一相机同一几何，0↔1 的唯一变量是 shadowFactor）；null → **不碰** uniform，
 *   读 `setShadowsEnabled` 决定的实际状态（用例 3/4 的被测对象就是那个开关本身，
 *   直写 uniform 会绕过它 → 测不到开关接线）。
 */
async function measureRegions(page, sampleWorld, strength) {
  if (strength !== null) {
    await page.evaluate((s) => {
      const u = window.__MC_GAME__.renderWorld.materials.dayNight.uShadowStrength;
      // 接线前句柄不存在 → 跳过（RED 落在亮度断言而非抛错）
      if (u) u.value = s;
    }, strength);
  }
  await page.waitForTimeout(900);
  /** 世界点 → 屏幕像素（renderer.render 每帧更新 matrixWorldInverse） */
  const px = await page.evaluate((pts) => {
    const g = window.__MC_GAME__;
    const out = {};
    for (const [k, p] of Object.entries(pts)) {
      const v = new g.camera.position.constructor(p[0], p[1], p[2]);
      v.project(g.camera);
      out[k] = { x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
                 y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight), z: v.z };
    }
    return out;
  }, sampleWorld);
  const png = PNG.sync.read(await page.screenshot());
  return { A: lum(regionRGB(png, px.A.x, px.A.y, 5)), B: lum(regionRGB(png, px.B.x, px.B.y, 5)), px };
}

test('接线：shadowMap 开关 + sunLight 阴影相机 + 三通道 cast/receive + uShadowStrength 句柄', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const s = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const rw = g.renderWorld;
    const sl = g.sunLight;
    if (!sl) return { hasSunLight: false };
    const u = rw.materials.dayNight.uShadowStrength;
    return {
      hasSunLight: true,
      enabled: g.renderer.shadowMap.enabled,
      type: g.renderer.shadowMap.type,
      castShadow: sl.castShadow,
      mapSize: [sl.shadow.mapSize.width, sl.shadow.mapSize.height],
      cam: {
        left: sl.shadow.camera.left, right: sl.shadow.camera.right,
        top: sl.shadow.camera.top, bottom: sl.shadow.camera.bottom,
        near: sl.shadow.camera.near, far: sl.shadow.camera.far,
      },
      radius: sl.shadow.radius,
      blurSamples: sl.shadow.blurSamples,
      targetInScene: sl.target.parent === g.scene,
      opaqueCast: rw.meshes.opaque.castShadow,
      cutoutCast: rw.meshes.cutout.castShadow,
      transparentCast: rw.meshes.transparent.castShadow,
      opaqueRecv: rw.meshes.opaque.receiveShadow,
      cutoutRecv: rw.meshes.cutout.receiveShadow,
      transparentRecv: rw.meshes.transparent.receiveShadow,
      // uShadowStrength 句柄必须恒存在：DayNight._apply 是「判句柄存在再写」，
      // 句柄缺失 = 静默 no-op（日夜浓度联动失效而游戏照常跑）。
      hasShadowStrength: !!(u && typeof u.value === 'number'),
      // noon 风格 skyDim=1 → 句柄值必须是 1（证明 Task 2 的写入路径真的生效了）
      shadowStrengthValue: u ? u.value : null,
    };
  });

  expect(s.hasSunLight, 'game.sunLight 须存在（weaponSun 改名而来）').toBe(true);
  expect(s.enabled, 'renderer.shadowMap.enabled 是硬门控').toBe(true);
  expect(s.type, 'shadowMap.type 须为 VSMShadowMap（DR-4b）').toBe(VSM_SHADOW_MAP);
  expect(s.castShadow).toBe(true);
  expect(s.mapSize).toEqual([256, 256]);
  expect(s.cam).toEqual({ left: -30, right: 30, top: 30, bottom: -30, near: 0.1, far: 250 });
  // VSM 口径（DR-4b）：不吃 bias/normalBias（mc-lite 的 0.00008 / 0.048 不移植），
  // 软化参数是 radius + blurSamples（实测出影值 4 / 8）。
  expect(s.radius).toBeCloseTo(4, 6);
  expect(s.blurSamples).toBe(8);
  expect(s.targetInScene, 'sunLight.target 须加入场景（否则 matrixWorld 不更新）').toBe(true);
  // DR-2 通道粗粒度：opaque + cutout 投射，transparent 不投射；三通道都接收
  expect(s.opaqueCast).toBe(true);
  expect(s.cutoutCast).toBe(true);
  expect(s.transparentCast).toBe(false);
  expect(s.opaqueRecv).toBe(true);
  expect(s.cutoutRecv).toBe(true);
  expect(s.transparentRecv).toBe(true);
  expect(s.hasShadowStrength, 'dayNight.uShadowStrength 句柄须恒存在').toBe(true);
  expect(s.shadowStrengthValue, 'noon 时 uShadowStrength 须为 1（skyDim=1，Task 2 写入生效）').toBe(1);

  // Review Focus 5：视图模型（枪）不投影 —— 挂相机上的枪投影没有意义且随转头闪烁。
  // three 默认 castShadow=false，此断言防未来回归。
  await page.evaluate(() => window.__MC_GAME__.selectWeapon('pistol'));
  await page.waitForFunction(() => window.__MC_GAME__.viewWeapon.node !== null, null, { timeout: 30_000 });
  const weapon = await page.evaluate(() => {
    let meshes = 0, casting = 0;
    window.__MC_GAME__.viewWeapon.node.traverse((o) => {
      if (o.isMesh) { meshes++; if (o.castShadow) casting++; }
    });
    return { meshes, casting };
  });
  expect(weapon.meshes, '手枪模型须已挂载').toBeGreaterThan(0);
  expect(weapon.casting, '枪模型任何 mesh 都不得 castShadow').toBe(0);
});

/**
 * Tier 4 有影判据（controller 裁定 (d)：俯视相机 + 大面积均匀平台）。
 *
 * 几何：y=80 高空清出 ±14 全 stone 平台（云上、无地形起伏）→ 3 格石柱立平台中央 →
 * 相机近垂直俯视（+X 偏 3 格避免 lookAt 的 up 退化）→ noon 光向 (0,-0.8,-0.6) 使影落在
 * 柱的 **-Z 侧**（水平投影长 3×0.6/0.8 = 2.25 格）。区 A = 柱 -Z 侧影区、区 B = 柱 +Z 侧
 * 等距开阔区，**两区都落在同一 stone 平台顶面**（裁定 (d) 第 4 条的硬条件）。
 *
 * ⚠️ **必须隐藏全部 HUD 覆盖物**（不只准心）：perf HUD 是 `position:fixed;top:8px;left:8px;
 * background:rgba(0,0,0,.55)` 的半透明黑底，会在屏幕左上角造出**假暗区**。前一次派发据此
 * 误判「亮度硬分裂 2×、明暗侧随相机翻转」为渲染缺陷 —— 实测隐藏 HUD 后同一平台 25 点
 * 全读 156.0、spread = 0.0（完全均匀）。这是本判据有效性的前提，不是可选清理。
 *
 * 判据用 **uShadowStrength 0↔1 同帧 A/B**（自校准，消除纹理/AO 混淆）：
 * 同一屏幕像素在 strength=0 与 1 下唯一差别就是 shadowFactor —— 影外像素 shadow() 恒返回 1，
 * `mix(1, 1, s) === 1` 与 s 无关 → 区 B 两次读数应**完全相同**。故：
 *   ① 区 A 须显著变暗（影真的落在 -Z 侧）
 *   ② 区 B 须几乎不变（证明是**局部**阴影，不是全屏压暗/黑屏）
 * ② 正是抓住本次闸门失败形态的关键：PCFSoft 下**整个接收面全黑**（区 B 也归零）。
 *
 * 实测数据（2026-10-13 Fix Round 1，VSMShadowMap 档位下本用例自身打印的区域均值 r=5 luma）：
 *   - baseline（strength=0）：A=134.4 / B=135.6
 *   - shadowed（strength=1）：A=**90.8** / B=135.6
 *   - **ratioA = 0.675（影区暗 32.5%）/ ratioB = 1.000（开阔区逐位相同）**，0 个 GPU 错误
 *     → 阴影确实落在柱的 -Z 侧，且是**局部**的（不是全屏压暗）
 *   - 平台均匀性前提（无柱、隐藏 HUD）：25 点全 156.0，spread 0.0（probe11 实测）
 *   - 对照：**PCFSoftShadowMap(2)（DR-4 原规定的档位）下 dz=-5..+5 全部 0**，每帧 222 条
 *     `GPUValidationError: [Texture "ShadowDepthTexture"] usage (TextureBinding|RenderAttachment)
 *     includes writable usage and another usage in the same synchronization scope` → 整个
 *     CommandBuffer 失效。**闸门失败 → 用户拍板改 VSM（DR-4b）。**
 * 阈值取 0.85（暗 ≥15%）：VSM 实测 0.675，余量 (0.85-0.675)/0.675 ≈ 26% > 20%（不贴线）。
 * 区 B 阈值取 0.95：影外像素理论上比值恒 1.0（实测恰为 1.000），留 5% 吸收截图噪声。
 */
test('Tier 4 有影：俯视均匀平台上石柱影子落在 -Z 侧，且开阔区不受影响', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(URL);
  await waitWorldSettled(page);

  // ---- 搭隔离场景（几何与理由见 setupShadowPlatform 的 JSDoc）----
  const P = 80;   // 平台高度（云层 y=55 之上、WORLD_MAX_Y=96 之下）
  const { ox, oz } = await setupShadowPlatform(page, P);

  // 区 A = 影区：柱 -Z 侧 1.5 格（影子水平投影 2.25 格 → 该处整格在影内；与柱隔半格以上，
  // 不受柱脚 AO 影响）。区 B = 开阔区：柱 +Z 侧 3 格（远在影外，同平台同材质）。
  const sampleWorld = { A: [ox + 0.5, P + 1.02, oz - 1], B: [ox + 0.5, P + 1.02, oz + 3] };

  // 两个方向都直写 uShadowStrength 自校准（只差 shadowFactor 一个变量）
  const off = await measureRegions(page, sampleWorld, 0);   // 基线：无阴影贡献
  const on = await measureRegions(page, sampleWorld, 1);    // 全浓度阴影
  console.log('SUN-SHADOW TIER4:', JSON.stringify({
    baseline: { A: +off.A.toFixed(1), B: +off.B.toFixed(1) },
    shadowed: { A: +on.A.toFixed(1), B: +on.B.toFixed(1) },
    ratioA: +(on.A / off.A).toFixed(3), ratioB: +(on.B / off.B).toFixed(3),
    px: on.px,
  }));

  // sanity：基线两区都必须正常照亮（否则测的是黑屏/未渲染，后续比值断言会恒真 = 无效盲区）
  expect(off.A, `影区基线须正常照亮：${off.A.toFixed(1)}`).toBeGreaterThan(40);
  expect(off.B, `开阔区基线须正常照亮：${off.B.toFixed(1)}`).toBeGreaterThan(40);

  // ① 影区须显著变暗（阈值 0.85 = 暗 ≥15%；VSM 实测 0.675，余量 26%）
  expect(on.A / off.A,
    `影区（柱 -Z 侧）须显著暗于自身基线：baseline=${off.A.toFixed(1)} shadowed=${on.A.toFixed(1)}`)
    .toBeLessThan(0.85);
  // ② 开阔区须几乎不变 —— 这条抓住「全屏压暗/黑屏」的失败形态
  //    （PCFSoft 下整个接收面归零，区 B 比值 = 0 → 本断言 FAIL）
  expect(on.B / off.B,
    `开阔区（柱 +Z 侧）不得被影响：baseline=${off.B.toFixed(1)} shadowed=${on.B.toFixed(1)}`)
    .toBeGreaterThan(0.95);

  // popModal 与 setupShadowPlatform 的 pushModal 配对（PLAYWRIGHT 每 test 独立 page，
  // 无实际泄漏 —— 纯一致性；同文件用例 6 的成对手法）。
  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-shadow'));
});

/**
 * 光源跟随玩家（Fix Round 2，Ruling f）—— 根因 A 的防回归断言。
 *
 * 背景：光源停在世界原点而出生点在 (283,22,117)（阴影相机 ±30 覆盖外）时，阴影相机
 * 覆盖不到任何可见几何 → 阴影系统静默无效（probe12 实测 uSkyDim 响应差 0.1048 vs 正常
 * 0.4604）。若未来有人删掉跟随，上面的用例 2 因为自己手动摆光源仍会全绿 → 必须单独钉。
 *
 * 判据：帧循环的 distSq>25 检查（移动超 5 格）→ teleport +6 格后一帧内光源/target
 * 必须跟到新玩家位置（容差 0.1）。同时验证初始状态已就位（出生点距 _lastShadowPos
 * 初始 (0,0,0) 必 >5 格 → 第一帧即自动定位）。
 */
test('光源跟随玩家：teleport +6 格后 sunLight/target 跟到新位置', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await waitWorldSettled(page);

  // 初始状态：出生点距原点必 >5 格 → 第一帧即已自动定位到玩家处
  const before = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const dir = g.dayNight.params.sunDirection;
    return {
      px: p.x, py: p.y, pz: p.z, dir,
      light: [g.sunLight.position.x, g.sunLight.position.y, g.sunLight.position.z],
      target: [g.sunLight.target.position.x, g.sunLight.target.position.y, g.sunLight.target.position.z],
    };
  });
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  expect(close(before.target[0], before.px, 0.1) &&
         close(before.target[1], before.py, 0.1) &&
         close(before.target[2], before.pz, 0.1),
    `启动后 target 须已定位到玩家（第一帧 distSq>25 自动触发）：target=${JSON.stringify(before.target)} player=(${before.px.toFixed(1)},${before.py.toFixed(1)},${before.pz.toFixed(1)})`)
    .toBe(true);
  expect(close(before.light[0], before.px + before.dir[0] * 60, 0.1) &&
         close(before.light[1], before.py + before.dir[1] * 60, 0.1) &&
         close(before.light[2], before.pz + before.dir[2] * 60, 0.1),
    `光源须在「玩家 + 太阳方向×60」：light=${JSON.stringify(before.light)}`)
    .toBe(true);

  // teleport +6 格（>5 格阈值必触发）；pushModal 冻结玩家物理，位置不会被帧循环挪走
  const moved = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.pushModal('sun-follow-test');
    g.player.physics.pos.x += 6;
    return { x: g.player.physics.pos.x, y: g.player.physics.pos.y, z: g.player.physics.pos.z };
  });
  // 帧循环 120Hz → 300ms 宽余足够跨过 distSq>25 检查的那一帧
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      light: [g.sunLight.position.x, g.sunLight.position.y, g.sunLight.position.z],
      target: [g.sunLight.target.position.x, g.sunLight.target.position.y, g.sunLight.target.position.z],
    };
  });
  expect(close(after.target[0], moved.x, 0.1) &&
         close(after.target[1], moved.y, 0.1) &&
         close(after.target[2], moved.z, 0.1),
    `teleport +6 格后 target 须跟到新位置：target=${JSON.stringify(after.target)} player=(${moved.x.toFixed(1)},${moved.y.toFixed(1)},${moved.z.toFixed(1)})`)
    .toBe(true);
  expect(close(after.light[0], moved.x + before.dir[0] * 60, 0.1) &&
         close(after.light[1], moved.y + before.dir[1] * 60, 0.1) &&
         close(after.light[2], moved.z + before.dir[2] * 60, 0.1),
    `teleport 后光源须保持「玩家 + 太阳方向×60」：light=${JSON.stringify(after.light)}`)
    .toBe(true);
});

/**
 * setShadowsEnabled(false) 后日夜循环不得覆写 uShadowStrength（Fix Round 2，Ruling g）。
 *
 * 钉的正是静默失效：DayNight._apply 每次日夜推进都写 uShadowStrength —— 若只靠
 * setShadowsEnabled 单次置 0 而不加 shadowEnabled 标志，**正常日夜循环模式下下一帧
 * 就被覆写回 skyDim**。注意 override 风格（setVisualStyle('noon') 等）下 update()
 * early-return 测不出这个 bug，故本用例走 setVisualStyle(null) 恢复循环 + 推进 dt。
 */
test('setShadowsEnabled(false) 后日夜循环不覆写 uShadowStrength', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const u = g.renderWorld.materials.dayNight.uShadowStrength;
    const out = {};
    out.before = u.value;                       // noon 风格 → skyDim=1
    g.setShadowsEnabled(false);
    out.afterDisable = u.value;
    out.castShadowOff = g.sunLight.castShadow === false;
    out.getterOff = g.shadowsEnabled === false;
    // 恢复日夜循环（override 模式下 update() early-return，测不出覆写 bug → 必须走循环）
    g.setVisualStyle(null);
    const hourBefore = g.dayNight.hour;
    g.dayNight.update(100);                     // 推进 100s（cycleSeconds=1200 → 2 小时）
    out.hourAdvanced = g.dayNight.hour !== hourBefore;
    out.afterCycle = u.value;                   // 静默失效时这里会被覆写成 skyDim(≠0)
    // 再开回来：uShadowStrength 恢复为当前 skyDim，castShadow 恢复 true
    g.setShadowsEnabled(true);
    out.afterEnable = u.value;
    out.skyDim = g.dayNight.params.skyDim;
    out.castShadowOn = g.sunLight.castShadow === true;
    out.getterOn = g.shadowsEnabled === true;
    return out;
  });

  expect(r.before, 'noon 初始浓度须为 1（skyDim=1）').toBe(1);
  expect(r.afterDisable, '关闭后浓度须立即置 0').toBe(0);
  expect(r.castShadowOff).toBe(true);
  expect(r.getterOff).toBe(true);
  expect(r.hourAdvanced, '日夜循环须真的推进了（否则本用例测不出覆写）').toBe(true);
  expect(r.afterCycle, '日夜推进后浓度仍须为 0（_apply 遵守 shadowEnabled 标志）').toBe(0);
  expect(r.afterEnable, '重新开启后浓度须恢复为当前 skyDim').toBeCloseTo(r.skyDim, 6);
  expect(r.castShadowOn).toBe(true);
  expect(r.getterOn).toBe(true);
});

/**
 * 按需刷新接线（Fix Round 4，裁定 (h)）：autoUpdate=false + 调度器在位 + 放块同步触发请求。
 *
 * 背景：Task 3 临时 `autoUpdate=true`（每帧重渲 shadow map）把 render-terrain 的冻结断言
 * `drawCalls < 100` 从 53 打到 428（VSM 下 receiveShadow 对象也进阴影 pass）。切回
 * DR-5 按需刷新（autoUpdate=false）后稳态 drawCalls 与 HEAD 逐位相同（controller 实测 53）。
 *
 * 观测口径：`editor.setBlock` 同步写世界 + 同步 `_emit`，subscribe 回调同步调
 * `request()`（只置 `_pending=true`，不碰 needsUpdate）→ 放块后**立即**读
 * `shadowScheduler._pending` 即可证明「编辑 → 刷新请求」接线通了，不依赖渲染帧。
 */
test('按需刷新：autoUpdate 已关、调度器在位、放块同步触发刷新请求', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await waitWorldSettled(page);
  // 静置 300ms：让启动定位/remesh 可能挂起的请求走过 200ms 节流窗口被 tick 消费，
  // 保证 pendingBefore 读到的是稳态（玩家静止 + noon 风格下日夜 update early-return，无新请求源）
  await page.waitForTimeout(300);

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const out = {};
    out.autoUpdate = g.sunLight.shadow.autoUpdate;
    out.hasScheduler = !!g.shadowScheduler;
    if (!g.shadowScheduler) return out;
    out.pendingBefore = g.shadowScheduler._pending;
    // 玩家脚边放一块石头。⚠️ 目标格若已是 stone，setBlock 判 no-change 跳过、不 emit
    // → 先清成空气保证有一次真实写入。整条链（setBlock → _emit → subscribe 回调 →
    // request）全同步，放完立即读 _pending。
    const p = g.player.physics.pos;
    const x = Math.floor(p.x) + 2, y = Math.floor(p.y) + 1, z = Math.floor(p.z);
    const stone = g.registry.idOf('stone');
    if (g.world.getBlockId(x, y, z) === stone) g.editor.setBlock({ x, y, z, id: 0 });
    g.editor.setBlock({ x, y, z, id: stone });
    out.pendingAfter = g.shadowScheduler._pending;
    return out;
  });

  expect(r.autoUpdate, 'sunLight.shadow.autoUpdate 须为 false（DR-5 按需刷新）').toBe(false);
  expect(r.hasScheduler, 'game.shadowScheduler 须存在').toBe(true);
  expect(r.pendingBefore, '静置稳态后不应残留待处理的刷新请求').toBe(false);
  expect(r.pendingAfter, '放块须同步触发 shadowScheduler.request()（编辑 → 刷新接线）').toBe(true);
});

/**
 * 阴影关闭时不得产生任何刷新请求（Fix Round 4，裁定 (i)）—— 回调 castShadow 门控的防回归断言。
 *
 * 钉的是真实缺陷（不只为测试）：日夜循环模式下 `DayNight.update()` 每帧调 `_apply`
 * → `onSunDirection` 每帧触发。不门控则「用户已关阴影」时系统仍每 200ms 重渲一次
 * 阴影贴图（VSM 下 receiveShadow 对象也进阴影 pass → drawCalls 53→273）。
 * 实测（200 次采样，口径同 render-terrain:48）：门控前 ≥100 占比 6~8%，门控后 0%。
 *
 * ⚠️ **本用例必须走日夜循环模式**（URL 不带 `style=`）：override 风格下 `update()`
 * early-return → 回调根本不会每帧触发 → 断言恒真（无效盲区）。本文件顶部的 `URL`
 * 带 `style=noon`，故本用例单独用 CYCLE_URL。
 *
 * 断言用**窗口内多次采样**而非单次读：阴影开启时 request 每帧发生而 tick 每 200ms
 * 消费一次 → 单次读 `_pending` 可能恰好落在消费后的 false 上（假阴性）。对照组
 * （阴影开）必须观测到 pending 为真 —— 否则被测组的「恒 false」是无效断言。
 */
const CYCLE_URL = '/?vd=2&seed=12345&weather=clear';

test('阴影关闭后日夜循环不再请求刷新（onSunDirection 的 castShadow 门控）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(CYCLE_URL);
  await waitWorldSettled(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // 冻结玩家物理（消除移动请求源）；本用例不做任何编辑（消除 editor 请求源）
    // → 剩下的唯一请求源就是 onSunDirection，正是被测对象。
    g.pushModal('shadow-gate-test');
    /** 窗口内每 10ms 采一次 `_pending`，统计观测到 true 的次数 */
    const sample = async (ms) => {
      let sawTrue = 0, n = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        n++;
        if (g.shadowScheduler._pending) sawTrue++;
        await sleep(10);
      }
      return { sawTrue, n };
    };
    const out = { cycleMode: g.dayNight._styleOverride === null };
    // 对照组：阴影开 + 日夜循环 → 回调每帧 request，窗口内必观测到 pending
    g.setShadowsEnabled(true);
    await sleep(300);
    out.on = await sample(500);
    // 被测组：关阴影 → 门控生效，窗口内 pending 恒 false
    g.setShadowsEnabled(false);
    await sleep(300);   // 让关阴影前挂起的请求被 tick 消费（跨 200ms 节流窗口）
    out.off = await sample(500);
    g.popModal('shadow-gate-test');
    return out;
  });

  expect(r.cycleMode, '本用例必须在日夜循环模式下跑（override 风格测不到该缺陷）').toBe(true);
  expect(r.on.sawTrue,
    `对照组：阴影开启时日夜循环须持续请求刷新（否则被测组断言无效）：${r.on.sawTrue}/${r.on.n}`)
    .toBeGreaterThan(0);
  expect(r.off.sawTrue,
    `关阴影后不得再产生任何刷新请求（castShadow 门控）：观测到 ${r.off.sawTrue}/${r.off.n} 次 pending`)
    .toBe(0);
});


/**
 * `?shadows=0` URL 入口（Task 5）：起页即关 —— URL → main.js → 构造选项 → start() 的
 * `setShadowsEnabled(false)` 整条链接线。
 *
 * 两级判据：① 接线（`shadowsEnabled` getter + 三处状态）② **像素**（俯视平台上影区与开阔区
 * 的亮度比 —— 有影 ≈0.67 / 无影 ≈1.00）。
 *
 * ⚠️ **像素判据为什么不能照搬用例 2 的「直写 uShadowStrength=1 → 影区变暗」**（实测证伪，
 * 见 `.superpowers/sdd/2026-10-13-sun-shadow-map/task-5-report.md` 的 probe）：强制 uniform=1
 * 时本用例实测影区**照样暗到 0.670**，即它会**恒 FAIL**（零假阴性，但零真阴性 —— 一个恒
 * 失败的用例等于没有判据）。根因：start() 的首次 `needsUpdate = true` 早于
 * `setShadowsEnabled(false)`，map 里已烘好带柱深度的数据；关阴影后无人再置 needsUpdate，
 * 这份 map 就**永久驻留**，而 `shadow()` 节点只读 `uShadowStrength` → 强制置 1 就把残留
 * map 采样回来。故本用例的像素判据必须**不碰 uniform**，读开关本身的真实效果。
 *
 * 像素判据 = **同一次截图内**影区 A / 开阔区 B 的比值（一个变量都没引入，不需要「两帧对照」）：
 *   - 关（本用例）：A/B ≈ 0.992（实测基线 134.4 / 135.6 —— stone 顶面中央受柱脚 AO 微暗）
 *   - 开：A/B ≈ 0.670（实测阴影值 90.8 / 135.6）
 * 阈值取 **0.85**（与用例 2 同阈同口径，VSM 实测两侧余量均 >20%）。
 * ⚠️ 正向对照必须同屏存在：第一次读在**开阴影**下断言 A/B < 0.85（证明本相机与取样点真的
 * 看得到影子），再关掉断言 A/B > 0.85。缺了正向对照，「比值 > 0.85」可能因**根本没渲出影子**
 * 而恒真（无效盲区）。
 */
test('构造选项可关（URL 入口 ?shadows=0）：getter 为 false 且像素无影', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(SHADOWS_OFF_URL);
  await waitWorldSettled(page);

  // ① 接线：URL → main.js → 构造选项 → start() 内的 setShadowsEnabled(false)
  const st = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      getter: g.shadowsEnabled,
      castShadow: g.sunLight.castShadow,
      flag: g.dayNight.shadowEnabled,
      uStrength: g.renderWorld.materials.dayNight.uShadowStrength.value,
    };
  });
  expect(st.getter, '?shadows=0 起页后 game.shadowsEnabled 须为 false').toBe(false);
  expect(st.castShadow, 'sunLight.castShadow 须为 false（停阴影 pass）').toBe(false);
  expect(st.flag, 'dayNight.shadowEnabled 须为 false（否则日夜循环会覆写回 skyDim）').toBe(false);
  expect(st.uStrength, 'uShadowStrength 须为 0（视觉零影响）').toBe(0);

  // ② 像素：不碰 uniform，读开关的真实效果
  const P = 80;
  const { ox, oz } = await setupShadowPlatform(page, P);
  const sampleWorld = { A: [ox + 0.5, P + 1.02, oz - 1], B: [ox + 0.5, P + 1.02, oz + 3] };
  const shot = async (label) => {
    const r = await measureRegions(page, sampleWorld, null);
    console.log(`SUN-SHADOW URL ${label}:`, JSON.stringify({
      A: +r.A.toFixed(1), B: +r.B.toFixed(1), ratioAB: +(r.A / r.B).toFixed(3), px: r.px,
    }));
    return r;
  };

  // 正向对照：开阴影 → 影子必须出现在本相机视野内（否则下面的「无影」断言恒真）
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(true));
  const on = await shot('ON (control)');
  // 被测组：关阴影 → 影区恢复到与开阔区同亮度
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  const off = await shot('OFF (url entry)');

  // sanity：两区都须正常照亮（否则测的是黑屏，比值断言恒真 = 无效盲区）
  expect(off.A, `影区须正常照亮：${off.A.toFixed(1)}`).toBeGreaterThan(40);
  expect(off.B, `开阔区须正常照亮：${off.B.toFixed(1)}`).toBeGreaterThan(40);
  // 正向对照：本判据真的看得到影子（VSM 实测 0.670，阈值同用例 2）
  expect(on.A / on.B,
    `对照：开阴影时影区须显著暗于开阔区（证明判据有效）：A=${on.A.toFixed(1)} B=${on.B.toFixed(1)}`)
    .toBeLessThan(0.85);
  // 被测组：关阴影后影区与开阔区同亮度（无影实测 0.992）
  expect(off.A / off.B,
    `?shadows=0 起页后影区须无影（A/B > 0.85，实测 0.992）：A=${off.A.toFixed(1)} B=${off.B.toFixed(1)}`)
    .toBeGreaterThan(0.85);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-shadow'));
});

/**
 * 重新开启后阴影恢复（Task 5）：`setShadowsEnabled(true)` 须置 `needsUpdate = true`
 * 且像素差异真的回来。
 *
 * 只断言 `needsUpdate` 不够 —— 它只证明「请求了重渲」，证不了重渲出的 map 真的被采样到
 * （DR-5 是 autoUpdate=false：不置 needsUpdate 则重开也永远沿用旧 map —— 上面用例已实测
 * 到「残留 map 会一直被采样」这一半，本条钉的是另一半「重开能让 map 跟上当前世界」）。
 * 像素判据沿用 A/B 比值（同屏对照，无需碰 uniform）：开 ≈0.670 / 关 ≈0.992，阈值 0.85。
 */
test('重新开启后阴影恢复：needsUpdate 置位且像素差异回来', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(URL);   // 默认开
  await waitWorldSettled(page);

  const P = 80;
  const { ox, oz } = await setupShadowPlatform(page, P);
  const sampleWorld = { A: [ox + 0.5, P + 1.02, oz - 1], B: [ox + 0.5, P + 1.02, oz + 3] };

  // 基线：关阴影 → 无影参考
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
  const off = await measureRegions(page, sampleWorld, null);
  // 再开回来：needsUpdate 必须在**同一次 evaluate 内同步读**（渲染帧会把它清掉 ——
  // 重置点在渲染后，异步读会读到 false 假阴性）
  const on = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.setShadowsEnabled(true);
    return {
      needsUpdate: g.sunLight.shadow.needsUpdate,
      castShadow: g.sunLight.castShadow,
      getter: g.shadowsEnabled,
      uStrength: g.renderWorld.materials.dayNight.uShadowStrength.value,
      skyDim: g.dayNight.params.skyDim,
    };
  });
  expect(on.needsUpdate, '重新开启须置 sunLight.shadow.needsUpdate = true（DR-5 autoUpdate=false）').toBe(true);
  expect(on.castShadow).toBe(true);
  expect(on.getter).toBe(true);
  expect(on.uStrength, '浓度须恢复为当前 skyDim（noon=1）').toBeCloseTo(on.skyDim, 6);
  // 等 needsUpdate 被帧循环消费 → map 重渲完整
  const back = await measureRegions(page, sampleWorld, null);
  console.log('SUN-SHADOW RE-ENABLE TIER4:', JSON.stringify({
    off: { A: +off.A.toFixed(1), B: +off.B.toFixed(1) },
    on: { A: +back.A.toFixed(1), B: +back.B.toFixed(1) },
    ratioAB_off: +(off.A / off.B).toFixed(3), ratioAB_on: +(back.A / back.B).toFixed(3), px: back.px,
  }));

  // sanity + 正向对照：关闭态两区同亮，开启态影区显著变暗（阈值同用例 2 的 0.85）
  expect(off.A, `关阴影时影区须正常照亮：${off.A.toFixed(1)}`).toBeGreaterThan(40);
  expect(off.A / off.B,
    `关阴影时须无影（A/B > 0.85，实测 0.992）：A=${off.A.toFixed(1)} B=${off.B.toFixed(1)}`)
    .toBeGreaterThan(0.85);
  expect(back.A / back.B,
    `重新开启后影区须显著变暗（A/B < 0.85，实测 0.670）：A=${back.A.toFixed(1)} B=${back.B.toFixed(1)}`)
    .toBeLessThan(0.85);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-shadow'));
});
