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
  // 软化参数是 radius + blurSamples。**radius = 2.6 是 mc-lite 原值**（Engine.js:182）：
  // 分支原用 4 是「阴影乘在最终颜色上（影区纯黑）」时代的补偿值，改成「只衰减 skylight
  // 项 + 地板」后 radius=4 反而把阴影冲淡（实测谷底比值 0.852 vs r=2.6 的 0.726）。
  expect(s.radius).toBeCloseTo(2.6, 6);
  expect(s.blurSamples).toBe(8);
  expect(s.targetInScene, 'sunLight.target 须加入场景（否则 matrixWorld 不更新）').toBe(true);
  // DR-2 通道粗粒度：opaque + cutout 投射，transparent（水/玻璃）**既不投射也不接收**。
  // ⚠️ transparentRecv 必须是 false：VSM 档位的阴影 pass 判据是 `castShadow ||
  // (receiveShadow && VSM)`（three.webgpu.js:44682）—— receive=true 会把水/玻璃几何渲进
  // 阴影深度图 → 照样投影；且材质的 shadow() 节点不受 receiveShadow 门控（只门控灯光
  // 管线，three.webgpu.js:46101）→ 水面照样被压暗。mc-lite 对 water/glass 也是双 false。
  expect(s.opaqueCast).toBe(true);
  expect(s.cutoutCast).toBe(true);
  expect(s.transparentCast).toBe(false);
  expect(s.opaqueRecv).toBe(true);
  expect(s.cutoutRecv).toBe(true);
  expect(s.transparentRecv).toBe(false);
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
 *
 * ⚠️ **上面的 0.675 是「阴影乘在最终颜色上」时代的数值，已作废**（用户实玩报告「阴影部分
 * 黑乎乎一片」）。旧判据只有上界 `< 0.85`，而**纯黑（0.675）也满足「比基线暗」** →
 * 该断言**结构上就抓不到这个缺陷**（负向验证实测：把 SHADOW_FLOOR 改回 0 后 ratioA=0.122
 * —— 影区几乎纯黑 —— 本用例仍全绿）。故现在用**双侧**判据钉住地板：
 *   上界 0.85（阴影真的存在）+ **下界 0.5（影区不得归零）**。
 *
 * 实测数据（2026-10-14 地板修复后，radius=2.6 / SHADOW_FLOOR=0.5）：
 *   - baseline（strength=0）：A=134.4 / B=135.6
 *   - shadowed（strength=1）：A=**98.9** / B=135.6
 *   - **ratioA = 0.735 / ratioB = 1.000**，0 个 GPU 错误
 *   - 负向对照（SHADOW_FLOOR=0，即旧的乘到纯黑行为）：**ratioA = 0.122**
 *   - 0.735 与 mc-lite 的理论影区亮度 0.71（ambient 2.3/(2.3+sun 3.2×NdotL 0.8)=0.4733 线性
 *     → sRGB 0.71）几乎重合 → 地板值 0.5 对齐上游观感。
 * 阈值：上界 0.85（实测 0.735，余量 13.6%）；**下界 0.5**（实测 0.735 余量 32%，
 * 而破坏态 0.122 在阈值下方 4× → 两侧都不贴线，且能真实区分修好/改坏）。
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

  // ① 影区须显著变暗（上界 0.85 = 暗 ≥15%；实测 0.735）
  expect(on.A / off.A,
    `影区（柱 -Z 侧）须显著暗于自身基线：baseline=${off.A.toFixed(1)} shadowed=${on.A.toFixed(1)}`)
    .toBeLessThan(0.85);
  // ①b **影区不得归零（下界 0.5）** —— 这条才是「黑乎乎一片」的真正判据。
  // 只有上界时，把阴影乘在最终颜色上（影区 ×0 → 纯黑）也能全绿：负向验证实测
  // SHADOW_FLOOR=0 时 ratioA=0.122（几乎纯黑）而旧断言仍 PASS。
  // 地板语义：阴影只衰减 skylight 项且最低保留 SHADOW_FLOOR（对齐 mc-lite 的环境光填充：
  // 它的阴影只拿走方向光贡献，AmbientLight(2.3) 不受影响 → 影区是「暗一档」而非全黑）。
  expect(on.A / off.A,
    `影区不得归零（阴影只衰减 skylight 项 + 地板 SHADOW_FLOOR）：baseline=${off.A.toFixed(1)} shadowed=${on.A.toFixed(1)} ratio=${(on.A / off.A).toFixed(3)}`)
    .toBeGreaterThan(0.5);
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
    const cam = g.sunLight.shadow.camera;
    return {
      px: p.x, py: p.y, pz: p.z, dir,
      // 纹素尺寸从实际配置读（红线 1：不写字面量）—— v1.47 纹素对齐后 target 与玩家
      // 最多差半纹素对角，故容差由它推导而非硬编码
      texelSize: (cam.right - cam.left) / g.sunLight.shadow.mapSize.width,
      light: [g.sunLight.position.x, g.sunLight.position.y, g.sunLight.position.z],
      target: [g.sunLight.target.position.x, g.sunLight.target.position.y, g.sunLight.target.position.z],
    };
  });
  const close = (a, b, tol) => Math.abs(a - b) <= tol;
  // v1.47 纹素对齐（texel snapping）后 target = 玩家 + 吸附偏移，偏移幅度上界 = 半纹素对角
  // `0.5 × texelSize × √2`（实测 0.166）。⚠️ 旧容差 0.1 是「target 恰等于玩家」时代的值，
  // 对齐后实测偏移 0.109 已超它 → 假失败。改为从配置推导 + 余量，不是「放宽断言」而是
  // 行为变了导致几何口径变了（见 .pi/plans/2026-10-17-shadow-texel-snap-sun-gate.md §4.4）。
  const snapTol = 0.5 * before.texelSize * Math.SQRT2 + 0.02;
  expect(close(before.target[0], before.px, snapTol) &&
         close(before.target[1], before.py, snapTol) &&
         close(before.target[2], before.pz, snapTol),
    `启动后 target 须已定位到玩家附近（容差 = 半纹素对角 ${snapTol.toFixed(3)}）：target=${JSON.stringify(before.target)} player=(${before.px.toFixed(1)},${before.py.toFixed(1)},${before.pz.toFixed(1)})`)
    .toBe(true);
  // ⚠️ **方向不变式**（比位置容差更载荷）：纹素对齐只能平移光源，不得改「position − target」
  // 的方向 —— 那个方向就是枪 PBR 高光依赖的太阳方向（game.js `_updateSunPosition` 注释）。
  // 只加偏移到一侧（position 或 target）会让本断言 FAIL。
  {
    const d = [before.light[0] - before.target[0], before.light[1] - before.target[1], before.light[2] - before.target[2]];
    const len = Math.hypot(...d);
    const nd = d.map((v) => v / len);
    expect(Math.abs(len - 60), `position−target 长度须仍为 60（mc-lite 偏移原值）：${len.toFixed(4)}`).toBeLessThan(1e-6);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(nd[i] - before.dir[i]),
        `光照方向须严格等于太阳方向（纹素对齐不得扰动 → 枪 PBR 高光不漂移）：分量${i} 实测 ${nd[i].toFixed(6)} vs 期望 ${before.dir[i].toFixed(6)}`)
        .toBeLessThan(1e-9);
    }
  }
  expect(close(before.light[0], before.px + before.dir[0] * 60, snapTol) &&
         close(before.light[1], before.py + before.dir[1] * 60, snapTol) &&
         close(before.light[2], before.pz + before.dir[2] * 60, snapTol),
    `光源须在「玩家 + 太阳方向×60」附近（同纹素对齐容差）：light=${JSON.stringify(before.light)}`)
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
  expect(close(after.target[0], moved.x, snapTol) &&
         close(after.target[1], moved.y, snapTol) &&
         close(after.target[2], moved.z, snapTol),
    `teleport +6 格后 target 须跟到新位置（容差 = 半纹素对角 ${snapTol.toFixed(3)}）：target=${JSON.stringify(after.target)} player=(${moved.x.toFixed(1)},${moved.y.toFixed(1)},${moved.z.toFixed(1)})`)
    .toBe(true);
  expect(close(after.light[0], moved.x + before.dir[0] * 60, snapTol) &&
         close(after.light[1], moved.y + before.dir[1] * 60, snapTol) &&
         close(after.light[2], moved.z + before.dir[2] * 60, snapTol),
    `teleport 后光源须保持「玩家 + 太阳方向×60」（同纹素对齐容差）：light=${JSON.stringify(after.light)}`)
    .toBe(true);
  // teleport 后方向不变式仍须成立（重定位路径不得因移动而改方向）
  {
    const d = [after.light[0] - after.target[0], after.light[1] - after.target[1], after.light[2] - after.target[2]];
    const len = Math.hypot(...d);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(d[i] / len - before.dir[i]),
        `teleport 后光照方向须仍等于太阳方向：分量${i} 实测 ${(d[i] / len).toFixed(6)} vs 期望 ${before.dir[i].toFixed(6)}`)
        .toBeLessThan(1e-9);
    }
  }
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
 * 断言用**窗口内多次采样**而非单次读：阴影开启时 request 发生而 tick 每 200ms
 * 消费一次 → 单次读 `_pending` 可能恰好落在消费后的 false 上（假阴性）。对照组
 * （阴影开）必须观测到 pending 为真 —— 否则被测组的「恒 false」是无效断言。
 *
 * ⚠️ v1.47 后 `onSunDirection` 多了**太阳方向角度阈值门控**（`SUN_DIR_GATE_DEG=0.5°`）：
 * 默认 1200s/天下太阳 0.3°/秒，跨过阈值需 1.67s > 采样窗口 → 对照组会假阴性（实测 0/47）。
 * 故本用例把 `cycleSeconds` 加速到 60（太阳 6°/秒 → 约 83ms 跨一次阈值），让方向门控在
 * 窗口内频繁放行，从而隔离出被测的 castShadow 门控。**两个门控是串联关系**，测下游必须
 * 让上游放行（否则恒真）。方向门控本身由专项用例钉住（见本文件「日夜循环下方向门控」用例）。
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
    // v1.47：onSunDirection 新增**太阳方向角度阈值门控**（SUN_DIR_GATE_DEG=0.5°）。两个叠加的
    // 假阴性陷阱：① 默认 1200s/天 → 太阳 0.3°/秒，跨 0.5° 需 1.67s > 采样窗口；② 更隐蔽的是
    // **启动 hour=12 落在 noon 平台段**（KEYFRAMES [9,noon]~[17,noon]），该段 sunDirection
    // 恒定 → 无论怎么加速日夜循环方向都不变 → 门控永不放行（实测 cycleSeconds=60 仍 0/47）。
    // 修法：把 hour 设进**插值段**（7.5 = morning→noon 之间，实测 1.4°/0.1h）+ 加速循环到
    // 60s/天（0.1h = 0.25s → 5.6°/秒 → 约 89ms 跨一次阈值）。仍是真实日夜循环路径（非 override）。
    g.dayNight.setTime(7.5);
    g.dayNight.cycleSeconds = 60;
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
    const out = { cycleMode: g.dayNight._styleOverride === null, cycleSeconds: g.dayNight.cycleSeconds, hour: g.dayNight.hour };
    // 对照组：阴影开 + 日夜循环（方向门控频繁放行）→ 窗口内必观测到 pending
    g.setShadowsEnabled(true);
    await sleep(300);
    out.on = await sample(500);
    // 被测组：关阴影 → castShadow 门控生效，窗口内 pending 恒 false
    g.setShadowsEnabled(false);
    await sleep(300);   // 让关阴影前挂起的请求被 tick 消费（跨 200ms 节流窗口）
    out.off = await sample(500);
    g.popModal('shadow-gate-test');
    return out;
  });

  expect(r.cycleMode, '本用例必须在日夜循环模式下跑（override 风格测不到该缺陷）').toBe(true);
  expect(r.cycleSeconds, '须已加速日夜循环以让太阳方向门控在窗口内放行').toBe(60);
  expect(r.hour, 'hour 须落在太阳方向插值段（noon 平台段方向恒定 → 门控永不放行）').toBeCloseTo(7.5, 0);
  expect(r.on.sawTrue,
    `对照组：阴影开启时日夜循环须持续请求刷新（否则被测组断言无效）：${r.on.sawTrue}/${r.on.n}`)
    .toBeGreaterThan(0);
  expect(r.off.sawTrue,
    `关阴影后不得再产生任何刷新请求（castShadow 门控）：观测到 ${r.off.sawTrue}/${r.off.n} 次 pending`)
    .toBe(0);
});

/**
 * v1.47 太阳方向角度阈值门控（`SUN_DIR_GATE_DEG`）：日夜循环下不再每帧重定位光源。
 *
 * 钉的是真实浪费（不只为测试）：门控前 `onSunDirection` 每帧触发 → `_updateSunPosition()`
 * 120 次/秒，而太阳每帧只转 0.0025°（256² 贴图上不可见）；且每帧 `paramsAtHour()` 新分配
 * 2~3 个小对象（GC 压力源）。门控后约 0.6Hz。
 *
 * **观测口径 = `_updateSunPosition()` 调用次数**，不是刷新次数：200ms 节流在下游，会把
 * 「每帧重定位」与「0.6Hz 重定位」的刷新次数都压到 ~5/s → 刷新次数测不出门控。而
 * `_updateSunPosition()` 是门控的直接下游（每次放行必调一次），能隔离出门控本身。
 *
 * 隔离变量：冻结玩家（pushModal → 帧循环跳过 player.update → 移动阈值路径不触发）+ 不做
 * 编辑 → 唯一的重定位源就是 onSunDirection，正是被测对象。把 hour 设进插值段（7.5）+
 * cycleSeconds=60（太阳 6°/秒）→ 门控理论放行频率 = 6°/秒 ÷ 0.5° = **12 次/秒**；
 * 若无门控则每帧一次 = ~120 次/秒。1 秒窗口断言落在 [4, 40]（与无门控的 ~120 差 3×，
 与门控理论值 12 两侧都不贴线）。
 */
test('日夜循环下太阳方向门控：光源重定位频率从每帧降到阈值放行频率', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(CYCLE_URL);
  await waitWorldSettled(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    g.pushModal('dir-gate-test');          // 冻结玩家 → 移动阈值路径不触发
    g.dayNight.setTime(7.5);               // 插值段（noon 平台段方向恒定 → 门控永不放行）
    g.dayNight.cycleSeconds = 60;          // 太阳 6°/秒 → 门控理论放行 12 次/秒
    // 包一层计数（保留原逻辑）
    let calls = 0;
    const orig = g._updateSunPosition.bind(g);
    g._updateSunPosition = function (...args) { calls++; return orig(...args); };
    await sleep(200);                      // 让计数从稳定态开始（跳过启动瞬态）
    calls = 0;
    await sleep(1000);                     // 1 秒观测窗口
    const count = calls;
    g._updateSunPosition = orig;
    g.popModal('dir-gate-test');
    return {
      count,
      cycleMode: g.dayNight._styleOverride === null,
      cycleSeconds: g.dayNight.cycleSeconds,
      gateDeg: (await import('/src/render/shadow-manager.js')).SUN_DIR_GATE_DEG,
    };
  });

  expect(r.cycleMode, '本用例必须在日夜循环模式下跑').toBe(true);
  expect(r.cycleSeconds, '须已加速日夜循环').toBe(60);
  expect(r.gateDeg, '门控阈值须为单一权威常量').toBe(0.5);
  // 理论放行频率 = 6°/秒 ÷ 0.5° = 12 次/秒；无门控则 ~120 次/秒（每帧）
  expect(r.count,
    `1 秒内光源重定位次数须落在门控放行频率附近（理论 12，无门控 ~120）：实测 ${r.count}`)
    .toBeGreaterThanOrEqual(4);
  expect(r.count,
    `1 秒内光源重定位次数须远低于每帧（无门控 ~120）：实测 ${r.count}`)
    .toBeLessThanOrEqual(40);
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
 *   - 开：A/B ≈ **0.729**（实测阴影值 98.9 / 135.6；地板修复后口径，旧值 0.670 已作废）
 * 阈值取 **0.85**（与用例 2 同阈同口径）；正向对照同时钉**下界 0.5**（同用例 2 的①b：
 * 只有上界时「影区纯黑」也能全绿，抓不到地板失效）。
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
  // 正向对照：本判据真的看得到影子（实测 0.729，阈值同用例 2）+ 不得归零（下界同用例 2 的①b）
  expect(on.A / on.B,
    `对照：开阴影时影区须显著暗于开阔区（证明判据有效）：A=${on.A.toFixed(1)} B=${on.B.toFixed(1)}`)
    .toBeLessThan(0.85);
  expect(on.A / on.B,
    `对照：开阴影时影区不得归零（地板 SHADOW_FLOOR 生效）：A=${on.A.toFixed(1)} B=${on.B.toFixed(1)}`)
    .toBeGreaterThan(0.5);
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
 * 像素判据沿用 A/B 比值（同屏对照，无需碰 uniform）：开 ≈**0.729** / 关 ≈0.992，阈值 0.85
 * （地板修复后口径；旧值 0.670 已作废）+ 下界 0.5（同用例 2 的①b）。
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
    `重新开启后影区须显著变暗（A/B < 0.85，实测 0.729）：A=${back.A.toFixed(1)} B=${back.B.toFixed(1)}`)
    .toBeLessThan(0.85);
  // 下界（同用例 2 的①b）：重开后影区不得归零 —— 地板 SHADOW_FLOOR 生效
  expect(back.A / back.B,
    `重新开启后影区不得归零（地板 SHADOW_FLOOR 生效）：A=${back.A.toFixed(1)} B=${back.B.toFixed(1)}`)
    .toBeGreaterThan(0.5);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-shadow'));
});

/**
 * 用例 9（Tier 4）：**阴影刷新不得让阴影视锥外的几何整帧消失**（远端闪烁回归门）。
 *
 * 被测缺陷（three r185.1 上游）：BatchedMesh 的主 pass 与阴影 pass **共用一份** multi-draw
 * 列表（`_multiDrawStarts/_multiDrawCounts/_multiDrawCount/_indirectTexture`）。帧内顺序：
 * 主 `onBeforeRender(主相机)` 建列表 → 阴影 pass `onBeforeShadow` → `onBeforeRender(阴影相机)`
 * **覆写同一列表**（只剩 ±30 视锥内的 instance）→ 主 `backend.draw` 读到被覆写的列表
 * → 阴影视锥外的几何该帧不绘制 → 透出天空。修法 = `render-world.js _installShadowListGuard`
 * （阴影 pass 前快照、后恢复）。
 *
 * **几何口径**：平台铺在 y=80（玩家被挪到平台上 → 阴影相机居中于此），采样点沿 -Z 排到
 * 56~90 格 —— 全部在阴影相机 ±30 视锥**外**、但在主相机视锥**内**（正是缺陷的触发区）。
 * 每 200ms 强制一次 `shadow.needsUpdate`（与真实日夜循环的刷新节奏同量级），逐帧读像素。
 *
 * **实测口径**（探针 P22/P23，200 帧 / 9 次强制刷新）：
 *   · 修法在位：5 个采样点 sd=0、range=0、jumps=0（逐帧逐位相同）
 *   · 去掉修法：sd=11.05~11.71、range=53~56、jumps=18，且亮帧值恒为 **192**
 *     == noon 天空亮度 (135+206+235)/3 → 证明该帧几何确实消失而非「变亮」
 * 阈值取 jumps ≤ 3 / sd < 2 / range < 3：与破坏态（18 / 11 / 53）差一个数量级，不贴线。
 *
 * ⚠️ 本用例用 `drawImage` 逐帧读 canvas（`page.screenshot()` 太慢，抓不到单帧闪烁）——
 * 实测本环境 WebGPU swapchain canvas 可被 2D drawImage 读取（读到真实亮度值，非 0）。
 */
test('阴影刷新不得让视锥外几何整帧消失（远端闪烁回归门）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 800, height: 600 });
  // vd=8：采样点最远 90 格，须真的加载出几何（vd=2 下平台不加载 → 采样恒为天空，用例失效）
  await page.goto('/?vd=8&seed=12345&weather=clear');
  await waitWorldSettled(page);

  const PY = 80;
  const DISTANCES = [56, 60, 70, 80, 90];

  // 铺平台：清上空 → 全 stone 平台（同材质同高度，消除材质差异变量）→ 每 10 格一根 3 格石柱
  await page.evaluate((PY) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x), oz = Math.floor(p.z);
    const stone = g.registry.idOf('stone');
    for (let y = PY + 1; y <= PY + 20; y++)
      for (let dx = -8; dx <= 8; dx++) for (let dz = -110; dz <= 8; dz++)
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) g.editor.setBlock({ x: ox + dx, y, z: oz + dz, id: 0 });
    for (let dx = -8; dx <= 8; dx++) for (let dz = -110; dz <= 8; dz++)
      g.editor.setBlock({ x: ox + dx, y: PY, z: oz + dz, id: stone });
    for (let dz = -10; dz >= -100; dz -= 10)
      for (let dy = 1; dy <= 3; dy++) g.editor.setBlock({ x: ox, y: PY + dy, z: oz + dz, id: stone });
  }, PY);
  await waitWorldSettled(page);

  // 相机/光源/采样点就位（冻结太阳方向 → 唯一变化源是强制刷新，隔离变量）
  const meta = await page.evaluate(({ PY, DISTANCES }) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x), oz = Math.floor(p.z);
    g.dayNight.setStyle('noon');
    // 玩家挪到平台上 → 光源跟随把阴影相机居中到平台（采样点因此落在 ±30 视锥外）
    p.x = ox + 0.5; p.y = PY + 1; p.z = oz + 0.5;
    g._lastShadowPos = { x: p.x, y: p.y, z: p.z };
    g._updateSunPosition();
    g.pushModal('tier4-flicker');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, PY + 46, oz + 4);
    g.camera.lookAt(ox + 0.5, PY + 1, oz - 60);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    const project = (w) => {
      const v = new g.camera.position.constructor(w[0], w[1], w[2]);
      v.project(g.camera);
      return { x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) };
    };
    // 采样点须在阴影相机视锥外（缺陷触发区）—— 用 three 真实 shadow.matrix 判定，不靠距离估算
    const V = g.camera.position.constructor;
    const screen = DISTANCES.map((d) => {
      const w = [ox + 3.5, PY + 1.02, oz - d + 0.5];
      const sv = new V(w[0], w[1], w[2]).applyMatrix4(g.sunLight.shadow.matrix);
      const inShadowFrustum = sv.x >= 0 && sv.x <= 1 && sv.y >= 0 && sv.y <= 1 && sv.z <= 1;
      return { d, inShadowFrustum, ...project(w) };
    });
    // 守卫接线检查：投影通道的 onBeforeShadow 须已被覆写（不是 Object3D 的空实现）
    const guarded = [];
    g.scene.traverse((o) => {
      if (o.isBatchedMesh && o.castShadow) guarded.push(o.onBeforeShadow !== o.constructor.prototype.onBeforeShadow);
    });
    return { screen, guarded };
  }, { PY, DISTANCES });

  // 前提断言：采样点确实全部在阴影视锥外（否则本用例测不到缺陷区，恒真）
  expect(meta.screen.every((s) => s.inShadowFrustum === false),
    `采样点须全部落在阴影相机视锥外（缺陷触发区）：${JSON.stringify(meta.screen.map((s) => [s.d, s.inShadowFrustum]))}`)
    .toBe(true);
  expect(meta.guarded.length, '须有投影通道的 BatchedMesh').toBeGreaterThan(0);
  expect(meta.guarded.every(Boolean),
    `投影通道须装 multi-draw 列表守卫（render-world.js _installShadowListGuard）：${JSON.stringify(meta.guarded)}`)
    .toBe(true);

  await page.evaluate((m) => { window.__MC_FLICKER_PTS__ = m.screen; }, meta);
  await waitWorldSettled(page);
  await page.waitForTimeout(3000);

  // 逐帧采样 + 每 200ms 强制一次阴影刷新
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const src = g.renderer.domElement;
    const pts = window.__MC_FLICKER_PTS__;
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 8;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const read = (p) => {
      if (!p || p.x < 4 || p.y < 4 || p.x >= src.width - 4 || p.y >= src.height - 4) return null;
      ctx.drawImage(src, p.x - 4, p.y - 4, 8, 8, 0, 0, 8, 8);
      const d = ctx.getImageData(0, 0, 8, 8).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return s / (d.length / 4);
    };
    const nFrames = 200;
    const series = pts.map(() => []);
    let n = 0, forced = 0, lastForce = -1e9;
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        if (now - lastForce >= 200) { g.sunLight.shadow.needsUpdate = true; lastForce = now; forced++; }
        for (let i = 0; i < pts.length; i++) {
          const v = read(pts[i]);
          if (v !== null) series[i].push(v);
        }
        if (++n < nFrames) requestAnimationFrame(tick);
        else {
          const out = pts.map((p, i) => {
            const a = series[i];
            if (!a.length) return { d: p.d, n: 0 };
            const mean = a.reduce((s, v) => s + v, 0) / a.length;
            const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length);
            let jumps = 0;
            for (let k = 1; k < a.length; k++) if (Math.abs(a[k] - a[k - 1]) > 1.5) jumps++;
            return { d: p.d, n: a.length, mean: +mean.toFixed(1), sd: +sd.toFixed(2), range: +(Math.max(...a) - Math.min(...a)).toFixed(1), jumps };
          });
          resolve({ forced, out });
        }
      };
      requestAnimationFrame(tick);
    });
  });

  console.log('SUN-SHADOW FAR-FLICKER:', JSON.stringify(r));

  // sanity floor：采样点须真的读到几何（不是天空/黑屏）—— 否则「零变化」是恒真
  const sampled = r.out.filter((o) => o.n > 0);
  expect(sampled.length, '至少须有一个采样点入画').toBeGreaterThan(0);
  for (const o of sampled) {
    expect(o.mean, `d=${o.d} 须读到平台几何而非天空（天空≈192）`).toBeLessThan(170);
    expect(o.mean, `d=${o.d} 须非黑屏`).toBeGreaterThan(40);
  }
  // 刷新确实发生了（否则本用例没测到东西）
  expect(r.forced, '扫描期内须真的强制刷新过阴影').toBeGreaterThan(3);
  // 主判据：视锥外几何在刷新帧不得消失
  for (const o of sampled) {
    expect(o.jumps, `d=${o.d} 不得出现单帧亮度跳变（破坏态实测 18 次）：${JSON.stringify(o)}`).toBeLessThanOrEqual(3);
    expect(o.sd, `d=${o.d} 亮度须逐帧稳定（破坏态实测 sd≈11）：${JSON.stringify(o)}`).toBeLessThan(2);
    expect(o.range, `d=${o.d} 亮度极差须小（破坏态实测 53~56 = 透出天空）：${JSON.stringify(o)}`).toBeLessThan(3);
  }

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-flicker'));
});

/**
 * 用例 10（Tier 4）：**纹素对齐消除「阴影随玩家移动微微晃动」**（v1.47 回归门）。
 *
 * 机制：阴影相机 ±30 / 贴图 256² → 每纹素 ≈ 0.234 格。相机连续跟随玩家时，世界点在
 * 贴图上的 UV 分数部分连续变 → 双线性滤波结果变 → 同一世界点的阴影值抖动（shimmer）。
 * `texelSnapOffset` 把相机中心吸附到纹素边界后，相机只按整纹素步进 → UV 分数部分恒定
 * → 同一世界点的阴影值恒定。
 *
 * **判据**：固定渲染相机 + 固定世界采样点（影子边缘），把玩家按**分数纹素**步长（0.05 格
 * ≈ 0.21 纹素，沿 X 与影子方向垂直 → 不改影子真实位置）推进，每步 `_updateSunPosition()`
 * + 强制刷新，读该点亮度序列 → 断言跨全部步长恒定。
 *
 * **实测口径**（探针 P25，12 步）：
 *   · 对齐 ON：亮度恒 112.63（spread **0.00**）、纹素相位恒 0.6（spread 0.00）
 *   · 对齐 OFF：亮度 118.77↔123.79（spread **5.02**）、相位 0.013~0.947（spread 0.93）
 * 阈值取 spread ≤ 1.0：与破坏态 5.02 差 5×，不贴线。
 *
 * ⚠️ **必须在 rAF 回调内读 canvas**：WebGPU swapchain canvas 在 rAF 外 drawImage 读到黑屏
 * （探针 P25 首版踩坑：全部读到 0）。本仓 Tier 4 逐帧读像素一律走 rAF 内采样。
 */
test('纹素对齐：固定世界点在分数纹素步长移动下亮度恒定（消除晃动）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(URL);
  await waitWorldSettled(page);

  const P = 80;
  const { ox, oz } = await setupShadowPlatform(page, P);

  // ⚠️ 必须先把玩家挪到平台上：`_updateSunPosition()` 把阴影相机居中到**玩家**，
  // 而 setupShadowPlatform 不挪玩家（玩家仍在出生点 y≈22）→ 不挪的话 P=80 平台在
  // 阴影相机 ±30 覆盖外 → 平台上无阴影（探针实测：亮度 142.7 ≈ 受光区，sanity ② FAIL）。
  await page.evaluate(({ P, ox, oz }) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    p.x = ox + 0.5; p.y = P + 1; p.z = oz + 0.5;
    g._lastShadowPos = { x: p.x, y: p.y, z: p.z };
    g._updateSunPosition();
    g.sunLight.shadow.needsUpdate = true;
  }, { P, ox, oz });
  await page.waitForTimeout(400); // 让刷新落地

  const r = await page.evaluate(({ P, ox, oz }) => {
    const g = window.__MC_GAME__;
    const src = g.renderer.domElement;
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 4;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    // 固定世界点 → 屏幕像素（渲染相机已被 setupShadowPlatform 冻结，pushModal 阻止跟随）
    const project = (wx, wz) => {
      const v = new g.camera.position.constructor(wx, P + 1.02, wz);
      v.project(g.camera);
      return [Math.round((v.x * 0.5 + 0.5) * window.innerWidth), Math.round((-v.y * 0.5 + 0.5) * window.innerHeight)];
    };
    const readAt = ([sx, sy]) => {
      if (sx < 2 || sy < 2 || sx >= src.width - 2 || sy >= src.height - 2) return null;
      ctx.drawImage(src, sx - 2, sy - 2, 4, 4, 0, 0, 4, 4);
      const d = ctx.getImageData(0, 0, 4, 4).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
      return s / (d.length / 4);
    };
    const shadowPx = project(ox + 0.5, oz - 2.0);   // 影子边缘（noon 方向影子落 -Z 侧）
    const litPx = project(ox + 0.5, oz + 3.0);       // 开阔受光区（sanity 参照）
    const p = g.player.physics.pos;
    const baseX = p.x;   // 玩家已在平台上（上方 setup），baseX = ox+0.5
    const STEP = 0.05;   // 分数纹素步长（0.05 格 ≈ 0.21 纹素）
    const STEPS = 12;
    const seq = [], phases = [], litSeq = [], targets = [];
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        // 沿 X 移动玩家（与影子方向垂直 → 不改影子真实位置，只改采样网格相位）
        p.x = baseX + i * STEP;
        g._lastShadowPos = { x: p.x, y: p.y, z: p.z };
        g._updateSunPosition();
        g.sunLight.shadow.needsUpdate = true;
        // 等两帧让刷新落地 + matrixWorld 经渲染更新（避免读到上一帧的陈旧光源矩阵），
        // 再在 rAF 内读亮度与相位（swapchain 在 rAF 外读是黑屏）
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const sh = g.sunLight.shadow;
          sh.updateMatrices(g.sunLight);
          const c = new g.camera.position.constructor(ox + 0.5, P + 1.02, oz - 2.0).applyMatrix4(sh.matrix);
          phases.push(+(((c.x * 256) % 1 + 1) % 1).toFixed(4));
          targets.push(+g.sunLight.target.position.x.toFixed(4));
          const sv = readAt(shadowPx), lv = readAt(litPx);
          if (sv !== null) seq.push(+sv.toFixed(2));
          if (lv !== null) litSeq.push(+lv.toFixed(2));
          if (++i < STEPS) requestAnimationFrame(tick);
          else {
            const spread = (a) => a.length ? Math.max(...a) - Math.min(...a) : -1;
            resolve({
              seq, litSeq, phases, targets,
              shadowSpread: +spread(seq).toFixed(2),
              litSpread: +spread(litSeq).toFixed(2),
              phaseSpread: +spread(phases).toFixed(3),
              targetTravel: +spread(targets).toFixed(4),
              shadowPx, litPx,
            });
          }
        }));
      };
      requestAnimationFrame(tick);
    });
  }, { P, ox, oz });

  console.log('SUN-SHADOW TEXEL-SNAP:', JSON.stringify({
    shadowSpread: r.shadowSpread, litSpread: r.litSpread, phaseSpread: r.phaseSpread,
    targetTravel: r.targetTravel, seq: r.seq, phases: r.phases,
  }));

  // sanity floor ①：采样点须真的读到几何（不是天空/黑屏）—— 否则「零变化」是恒真
  expect(r.seq.length, '影子边缘采样点须入画').toBeGreaterThan(0);
  expect(r.litSeq.length, '受光区参照点须入画').toBeGreaterThan(0);
  const shadowMean = r.seq.reduce((a, b) => a + b, 0) / r.seq.length;
  const litMean = r.litSeq.reduce((a, b) => a + b, 0) / r.litSeq.length;
  expect(shadowMean, `影子边缘须读到几何而非天空（天空≈192）：${shadowMean.toFixed(1)}`).toBeLessThan(170);
  expect(shadowMean, `影子边缘须非黑屏：${shadowMean.toFixed(1)}`).toBeGreaterThan(40);
  // sanity floor ②：采样点须真的在影区（比受光区显著暗）—— 否则「恒定」可能只是没阴影
  expect(shadowMean, `影子边缘须比受光区显著暗（证明在影区）：shadow=${shadowMean.toFixed(1)} lit=${litMean.toFixed(1)}`)
    .toBeLessThan(litMean * 0.95);
  // sanity floor ③：阴影相机须真的移动了（玩家动了 + `_updateSunPosition()` 跑了）——
  // 否则「亮度恒定」是因为什么都没做。12 步 × 0.05 格 = 0.6 格 ≈ 2.6 纹素 → 至少走 1 纹素。
  // ⚠️ 不能用「相位在变」做 sanity：对齐生效时相位**恒定**正是被测不变式（探针 P25 实测
  // ON 相位 spread 0.00 / OFF 0.93）—— 拿它做下界会让修好的代码反而 FAIL。
  expect(r.targetTravel,
    `阴影相机须真的随玩家移动（否则用例没测到东西）：target 位移 ${r.targetTravel}，targets=${JSON.stringify(r.targets)}`)
    .toBeGreaterThan(0.2);

  // 主判据：固定世界点在分数纹素步长移动下亮度恒定（对齐生效）
  expect(r.shadowSpread,
    `纹素对齐后影子边缘亮度须跨全部步长恒定（破坏态实测 spread 5.02）：seq=${JSON.stringify(r.seq)}`)
    .toBeLessThanOrEqual(1.0);
  // 纹素相位恒定（对齐的直接不变式：相机只按整纹素步进 → UV 小数部分不变）
  expect(r.phaseSpread,
    `纹素对齐后采样相位须恒定（破坏态实测 spread 0.93）：phases=${JSON.stringify(r.phases)}`)
    .toBeLessThan(0.05);
  // 对照：受光区本来就应恒定（不在影区，无相位依赖）—— 证明读法本身不引入噪声
  expect(r.litSpread, `受光区参照点须恒定（读法无噪声）：litSeq=${JSON.stringify(r.litSeq)}`)
    .toBeLessThanOrEqual(1.0);

  await page.evaluate(() => window.__MC_GAME__.popModal('tier4-shadow'));
});
