import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 森林落叶 + 草地萤火虫的 Tier 4 像素实测（v3.26）。
 *
 * 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md §5.2
 *
 * **为什么必须像素实测**：两个池的运动/着色全在 TSL（GPU 求值）。数据层
 * （`aOrigin` / `aAlive` / `visible` / draw call）对，画面仍可能全错：
 *   · `vec3(Color)` 写法 ⇒ 纯黑零报错（v3.14）；
 *   · 径向量在顶点算 ⇒ 整片 quad 一起亮再整片消失（v3.23）；
 *   · 世界偏移加进 centerView ⇒ 薄片随镜头转歪；
 *   · 秋色权重没生效 ⇒ 读作「绿色碎屑」而不是秋风。
 *
 * ## ⚠️⚠️ 本轮特有：被测对象自己就是持续动画
 *
 * 冻住全部环境动态源之后，落叶/萤火虫**仍在动** ⇒ **不能要求「同状态连拍噪声底 = 0」**
 * （那是断言想象中的世界）。正确口径：**对照组 = 同会话、同机位、
 * `setAmbientFxEnabled(false)`**，两侧各连拍 3 张取**最大值**，判据取「开的下限 > 关的上限」。
 *
 * ## 六个环境动态源全冻（既有教训，缺一则判据零判别力）
 *
 * 玩家下落（钉 physics.pos）/ 海面波纹（ocean.update 传 dt=0）/ 第一人称手臂（藏 mesh+node）/
 * 昼夜（dayNight.update 空转）/ viewBob+stepLift（两个 update 空转）/ 雨滴（?weather=clear）。
 * 每项返回布尔，用例里逐条 expect —— 缺一项就红，不静默跳过。
 *
 * ## 机位按数据选（spec §5.2 已实测，seed 12345）
 *
 * 森林 (−400,−400)：r16 圆盘 100% FOREST；草地 (−350,−150)：r16/r22 均 100% PLAINS；
 * 沙漠对照 (8,8)：17×17 全 DESERT ⇒ 两池都该 invisible。
 */

const SEED = 12345;
const FOREST = { x: -393.5, z: -399.5 };
const PLAINS = { x: -349.5, z: -149.5 };
const DESERT = { x: 8.5, z: 8.5 };

/** 一律带 reflect=0：不关倒影会把反射 pass 算进同一个 draw call 计数（v3.20 实测） */
const URL_BASE = `/?seed=${SEED}&vd=6&weather=clear&shadows=0&reflect=0&stats=0`;

const shot = async (page, clip) => PNG.sync.read(await page.screenshot(clip ? { clip } : undefined));

/**
 * 传送到目标机位并等世界稳定。
 * ⚠️ 必须用 `_teleportTo`（它会加载目标 column）—— `player.spawn` 不加载，
 * 玩家会悬在未加载空列里等落地 30s 超时（既有实测）。
 */
async function gotoSite(page, x, z) {
  // ⚠️⚠️ **一次传送 + 等物理自然落地**（本轮实测踩到两次）：
  //   ① `_teleportTo(x, 45, z)` 的 45 可能落在**巨树树冠里**（实测 y=39 是
  //      giant_spruce_leaves）⇒ 玩家停在叶层顶 y=40，相机高于全部落叶 ⇒ 像素零命中；
  //   ② 反复搜索式传送会让玩家在未加载 column 之间坠落到 y=−23。
  // 故传到一个**远高于树冠**的 y，然后等 `onGround` —— 与本仓其它 spec 的落地口径一致。
  await page.evaluate(([px, pz]) => window.__MC_GAME__._teleportTo(px, 60, pz), [x, z]);
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 60_000, polling: 400 });
  await page.waitForTimeout(3500);
  // 等队列收敛 + section 数停止增长（只看队列瞬时归零不够，见既有 memory）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const n = g.renderStats().sections;
    const prev = window.__SEC_PREV__;
    window.__SEC_PREV__ = n;
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && prev === n;
  }, null, { timeout: 60_000, polling: 600 });
}

/**
 * 冻住六个环境动态源 + 钉相机。**每项返回布尔**，用例逐条断言。
 * @param {import('playwright/test').Page} page
 * @param {number} pitch 俯仰（负 = 俯视）
 */
async function freezeAll(page, pitch = -0.10) {
  const r = await page.evaluate((pit) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const px = p.x; const py = p.y; const pz = p.z;
    if (window.__PIN__) clearInterval(window.__PIN__);
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = pit;
    }, 16);
    g.player.yaw = 0; g.player.pitch = pit;
    let bobFrozen = false;
    if (g.player?.viewBob?.update) { g.player.viewBob.update = () => {}; bobFrozen = true; }
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    let oceanFrozen = false;
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
      oceanFrozen = true;
    }
    let armHidden = false;
    if (g.viewArm?.mesh) { g.viewArm.mesh.visible = false; armHidden = true; }
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    let dnFrozen = false;
    if (g.dayNight?.update) { g.dayNight.update = () => {}; dnFrozen = true; }
    g.setShadowsEnabled(false);
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
    return {
      pinned: true, bobFrozen, oceanFrozen, armHidden, dnFrozen,
      camY: g.camera.position.y,
    };
  }, pitch);
  expect(r.pinned, '前置：须钉住玩家位置（否则相机下落主导整帧差分）').toBe(true);
  expect(r.bobFrozen, '前置：须冻住 viewBob/stepLift（相机微动是噪声源）').toBe(true);
  expect(r.oceanFrozen, '前置：须冻住海面时间推进（只藏 plane 不够）').toBe(true);
  expect(r.armHidden, '前置：须藏掉第一人称手臂（待机摆动是噪声源）').toBe(true);
  expect(r.dnFrozen, '前置：须冻住昼夜推进（天空色漂移是噪声源）').toBe(true);
  await page.waitForTimeout(1200);
  return r;
}

/** 开/关环境特效（同会话同机位单变量对照） */
async function setAmbient(page, on) {
  const eff = await page.evaluate((v) => window.__MC_GAME__.setAmbientFxEnabled(v), on);
  // ⚠️ 切换后等 2.5s：池要重新播种/迁移，且远处 column 仍在上传（700ms 实测读数不稳）
  await page.waitForTimeout(2500);
  return eff;
}

/**
 * 秋色叶片的像素判据（spec §5.2 CPU 复刻已验）。
 *
 * 黄叶顶面屏幕色 150,159,9 vs 草顶背景 68,128,53 ⇒
 * `Δr ≥ 25 && Δr > Δg + 12 && Δb < 0` 在**草顶背景**上命中、在其余五种叶色上不命中
 * ⇒ 这条判据钉的正是「秋色权重真的生效」。
 * ⚠️ 机位必须让叶子落在草顶背景上（天空/树干背景上不命中 ⇒ 零判别力）。
 */
function autumnCount(before, after, region) {
  const m = autumnCount.mask(before, after, region);
  let n = 0; for (let k = 0; k < m.length; k++) n += m[k];
  return n;
}
autumnCount.mask = (before, after, region) => {
  const { x0, y0, w, h } = region;
  const out = new Uint8Array(w * h);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * before.width + x) * 4;
      const dr = after.data[i] - before.data[i];
      const dg = after.data[i + 1] - before.data[i + 1];
      const db = after.data[i + 2] - before.data[i + 2];
      if (dr >= 25 && dr > dg + 12 && db < 0) out[(y - y0) * w + (x - x0)] = 1;
    }
  }
  return out;
};

/**
 * 萤火虫的暖黄绿判据（差分）：`Δr > 20 && Δg > 20 && Δb < Δr − 15`。
 * CPU 复刻已验：gain 0.6 正午 Δ[127,95,41] / 夜间 Δ[182,163,72] 两侧都命中。
 */
function fireflyCount(before, after, region) {
  const m = fireflyCount.mask(before, after, region);
  let n = 0; for (let k = 0; k < m.length; k++) n += m[k];
  return n;
}
fireflyCount.mask = (before, after, region) => {
  const { x0, y0, w, h } = region;
  const out = new Uint8Array(w * h);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * before.width + x) * 4;
      const dr = after.data[i] - before.data[i];
      const dg = after.data[i + 1] - before.data[i + 1];
      const db = after.data[i + 2] - before.data[i + 2];
      if (dr > 20 && dg > 20 && db < dr - 15) out[(y - y0) * w + (x - x0)] = 1;
    }
  }
  return out;
};

/**
 * 采样区 = **整屏**。
 *
 * ⚠️⚠️ 实测推翻 spec §5.2 的「下 40%」设计取值：落叶出生在**地面 +3..13**，而相机
 * 眼高只有 +1.62 ⇒ 多数叶子在**相机之上**，屏幕投影落在画面**上半部**。
 * 实测（pitch −0.10，森林机位）：秋色命中 712 像素，其中 top 665 / mid 47 / **lower 0**
 * ⇒ 取下半屏会零判别力。故取整屏，并靠「开的下限 > 关的上限」+ 上界排除整屏变色。
 */
/**
 * 任意可见变化像素（分母）—— 用来算「秋色占比」。
 * ⚠️ 尽对计数在真实叶种比例下仍非零（25% 黄叶也命中）⇒ 占比才有判别力。
 */
function anyChangeCount(before, after, region) {
  const m = anyChangeCount.mask(before, after, region);
  let n = 0; for (let k = 0; k < m.length; k++) n += m[k];
  return n;
}
anyChangeCount.mask = (before, after, region) => {
  const { x0, y0, w, h } = region;
  const out = new Uint8Array(w * h);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * before.width + x) * 4;
      const d = Math.abs(after.data[i] - before.data[i])
        + Math.abs(after.data[i + 1] - before.data[i + 1])
        + Math.abs(after.data[i + 2] - before.data[i + 2]);
      if (d > 24) out[(y - y0) * w + (x - x0)] = 1;
    }
  }
  return out;
};

function fullRegion(png) {
  return { x0: 0, y0: 0, w: png.width, h: png.height };
}

/**
 * 与**同一固定基线**比对的累计命中像素数（并集）。
 *
 * ⚠️⚠️ **为什么不能用「相邻两张差分」**（本轮实测反复踩到）：落叶是自由翻转的薄片，
 * 翻到侧面时投影只 1~2px ⇒ 相邻帧差分在 **0~609** 之间剧烈波动（同一机位同一实现，
 * 两轮读数 [0,0,0] vs [324,502,316]）。而与「特效关闭态的固定基线」比对并累计 N 帧，
 * 量到的是「这段时间里特效一共染了哪些像素」—— 单调不减、随时序稳定。
 */
async function unionCounts(page, counter, region, baseline, shots = 6) {
  let union = null;
  const per = [];
  for (let i = 0; i < shots; i++) {
    await page.waitForTimeout(240);
    const now = await shot(page);
    const mask = counter.mask(baseline, now, region);
    if (!union) union = mask; else for (let k = 0; k < mask.length; k++) union[k] |= mask[k];
    let n = 0; for (let k = 0; k < mask.length; k++) n += mask[k];
    per.push(n);
  }
  let total = 0; for (let k = 0; k < union.length; k++) total += union[k];
  return { total, per };
}

test('落叶：出生高度恒在该列地面 +[3,13]（用户点名「高于树不得有落叶」）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await freezeAll(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const { LEAF_FX } = await import('/src/render/ambient-fx-config.js');
    const geo = g.leafFx?.mesh?.geometry;
    if (!geo) return { ok: false, why: 'leafFx 未装配（取色器失败？）' };
    const o = geo.getAttribute(LEAF_ATTR.origin);
    const p = geo.getAttribute(LEAF_ATTR.params);
    const above = [];
    for (let i = 0; i < o.count; i++) {
      above.push(o.getY(i) - (p.getX(i) - LEAF_FX.floorOffset));
    }
    return {
      ok: true,
      visible: g.leafFx.mesh.visible,
      biome: g.leafFx.debugState().biome,
      capacity: geo.instanceCount,
      checked: above.length,
      min: Math.min(...above),
      max: Math.max(...above),
      birthMin: LEAF_FX.birthMin,
      birthMax: LEAF_FX.birthMax,
    };
  });
  expect(r.ok, `前置：落叶池须已装配（${r.why ?? ''}）`).toBe(true);
  expect(r.biome, '机位须真是 FOREST').toBe('FOREST');
  expect(r.visible, '森林机位落叶池须可见').toBe(true);
  expect(r.checked, '须真的检查了全部实例（防空转）').toBe(r.capacity);
  expect(r.min, `最低出生高度须 ≥ birthMin（实测 ${r.min}）`).toBeGreaterThanOrEqual(r.birthMin - 1e-4);
  expect(r.max, `最高出生高度须 ≤ birthMax（实测 ${r.max}）`).toBeLessThanOrEqual(r.birthMax + 1e-4);
  console.log('AMBIENT-LEAF-BIRTH: ' + JSON.stringify(r));
});

test('落叶：落地即停 —— tLand 之后 x/z/rot 逐位冻结且 alpha 递减', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await freezeAll(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const { leafMotionAt, leafLandSeconds } = await import('/src/render/ambient-fx-config.js');
    const geo = g.leafFx.mesh.geometry;
    const o = geo.getAttribute(LEAF_ATTR.origin);
    const p = geo.getAttribute(LEAF_ATTR.params);
    const sway = geo.getAttribute(LEAF_ATTR.sway);
    const spin = geo.getAttribute(LEAF_ATTR.spin);
    const life = geo.getAttribute(LEAF_ATTR.life);
    let checked = 0; let frozen = 0; let fading = 0;
    let maxLand = 0;
    for (let i = 0; i < o.count; i++) {
      // 尚未播种的实例（born=-1e3）不参与：它们的 tLand 无意义
      if (life.getX(i) < -100) continue;
      // 从**真实 GPU 属性**重建 seed（不自己另抽一份）
      const seed = {
        x: o.getX(i), y: o.getY(i), z: o.getZ(i),
        minY: p.getX(i), fallSpeed: p.getY(i),
        swayAmp: sway.getX(i), swayFreq: sway.getY(i), swayPhase: sway.getZ(i),
        spinX: spin.getX(i), spinY: spin.getY(i), spinZ: spin.getZ(i),
      };
      const tLand = leafLandSeconds(seed);
      maxLand = Math.max(maxLand, tLand);
      const a = { ...leafMotionAt(seed, tLand + 0.05) };
      const b = { ...leafMotionAt(seed, tLand + 1.20) };
      if (a.x === b.x && a.z === b.z && a.rotX === b.rotX && a.rotY === b.rotY && a.rotZ === b.rotZ) frozen++;
      if (a.alpha > b.alpha) fading++;
      checked++;
    }
    return { checked, frozen, fading, maxLand, capacity: geo.instanceCount, seeded: g.leafFx.debugState().seeded };
  });
  expect(r.seeded, '前置：全部实例须已播种（否则这条用例是空的）').toBe(r.capacity);
  expect(r.checked, '须逐片检查（防空转）').toBe(r.capacity);
  expect(r.frozen, `全部叶片落地后 x/z/rot 须冻结（实测 ${r.frozen}/${r.checked}）`).toBe(r.checked);
  expect(r.fading, `全部叶片落地后须淡出（实测 ${r.fading}/${r.checked}）`).toBe(r.checked);
  expect(r.maxLand, '落地时刻须为正（否则这条用例是空的）').toBeGreaterThan(0);
  console.log('AMBIENT-LEAF-LAND: ' + JSON.stringify(r));
});

test('落叶：秋色像素（关态基线 → 开态累计）+ 权重内容级判据', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await freezeAll(page, -0.10);
  await page.waitForTimeout(4000);

  const region = fullRegion(await shot(page));
  const area = region.w * region.h;

  // 关态：取固定基线 + 量「关态自己累计能染多少像素」（= 残余噪声上界）
  expect(await setAmbient(page, false), '关闭须生效').toBe(false);
  const offBase = await shot(page);
  const off = await unionCounts(page, autumnCount, region, offBase, 6);
  const offAny = await unionCounts(page, anyChangeCount, region, offBase, 6);

  // 开态：与**同一关态基线**比，累计 6 帧的并集
  expect(await setAmbient(page, true), '开启须生效').toBe(true);
  const on = await unionCounts(page, autumnCount, region, offBase, 6);
  const onAny = await unionCounts(page, anyChangeCount, region, offBase, 6);
  const ratio = on.total / Math.max(1, onAny.total);

  const leafDbg = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const geo = g.leafFx.mesh.geometry;
    const c = geo.getAttribute(LEAF_ATTR.color);
    const lf = geo.getAttribute(LEAF_ATTR.life);
    let yellow = 0; let green = 0; let alive = 0;
    for (let i = 0; i < c.count; i++) {
      const r = c.getX(i); const gr = c.getY(i);
      if (r > 0.19 && gr > 0.22 && gr < 0.25) yellow++;      // yellow_leaves 0.202,0.232
      if (r < 0.02 && gr > 0.14 && gr < 0.17) green++;        // leaves 0.012,0.154
      if (lf.getY(i) > 0.05) alive++;
    }
    return { yellow, green, alive, count: c.count, st: g.leafFx.debugState() };
  });
  console.log('AMBIENT-LEAF-COLORS: ' + JSON.stringify(leafDbg));
  console.log('AMBIENT-LEAF-HUE: ' + JSON.stringify({ off, offAny, on, onAny, ratio, area }));
  expect(on.total, `开的累计秋色像素须 > 关的累计（off=${off.total} on=${on.total}）`)
    .toBeGreaterThan(off.total);
  // 上界：防「整屏变色」
  expect(on.total, `秋色像素不得超过采样区的 25%（实测 ${on.total}/${area}）`)
    .toBeLessThan(area * 0.25);
  /**
   * ⚠️⚠️ **「秋色权重真的生效」必须用内容级判据，不能用像素占比**（本轮实测推翻两次）：
   * 占比 = 暖色命中 / 全部变化像素，两者都随**叶片翻转相位与落地时刻**漂移 ⇒
   * 正向实测 0.11~0.42、负向 0.03~0.11，**分布重叠**，任何固定阈值都会 flaky。
   * 内容级判据读**真实 GPU 属性色分布**：秋色档黄叶必须显著多于绿叶（权重 0.65 vs 0.10），
   * 它与相位、时序、机位全都无关。负向①钉同一口径的反向。
   */
  expect(leafDbg.alive, '前置：叶片须真的活着（否则这条用例是空的）').toBeGreaterThan(leafDbg.count * 0.5);
  expect(leafDbg.yellow, `秋色档黄叶实例须多于绿叶 2 倍以上（实测 yellow=${leafDbg.yellow} green=${leafDbg.green}）`)
    .toBeGreaterThan(leafDbg.green * 2);
});

test('萤火虫：暖黄绿色相像素 + 夜里比白天更亮（关态基线 → 开态累计）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, PLAINS.x, PLAINS.z);
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await freezeAll(page, -0.10);
  await page.waitForTimeout(4000);

  const region = fullRegion(await shot(page));

  // ---- 白天 ----
  expect(await setAmbient(page, false)).toBe(false);
  const dayBase = await shot(page);
  const offDay = await unionCounts(page, fireflyCount, region, dayBase, 6);
  expect(await setAmbient(page, true)).toBe(true);
  const onDay = await unionCounts(page, fireflyCount, region, dayBase, 8);
  const dayState = await page.evaluate(() => window.__MC_GAME__.fireflyFx.debugState());

  // ---- 夜里：同机位只换风格（dayNight.update 已空转 ⇒ 不会漂）----
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('night'));
  await page.waitForTimeout(1200);
  expect(await setAmbient(page, false)).toBe(false);
  const nightBase = await shot(page);
  const offNight = await unionCounts(page, fireflyCount, region, nightBase, 6);
  expect(await setAmbient(page, true)).toBe(true);
  const onNight = await unionCounts(page, fireflyCount, region, nightBase, 8);
  const nightState = await page.evaluate(() => window.__MC_GAME__.fireflyFx.debugState());

  console.log('AMBIENT-FLY-HUE: ' + JSON.stringify({
    offDay, onDay, offNight, onNight,
    dayGain: dayState.gain, nightGain: nightState.gain,
    dayCount: dayState.count, nightCount: nightState.count,
  }));
  expect(dayState.biome, '机位须真是 PLAINS').toBe('PLAINS');
  expect(onDay.total, `白天开态累计须 > 关态（off=${offDay.total} on=${onDay.total}）`)
    .toBeGreaterThan(offDay.total);
  expect(nightState.gain, '夜里 gain 须更大').toBeGreaterThan(dayState.gain);
  expect(nightState.count, '夜里只数须更多').toBeGreaterThan(dayState.count);
  expect(onNight.total, `夜里开态累计须 > 关态（off=${offNight.total} on=${onNight.total}）`)
    .toBeGreaterThan(offNight.total);
  expect(onNight.total, `夜里累计须多于白天（更亮更密；night=${onNight.total} day=${onDay.total}）`)
    .toBeGreaterThan(onDay.total * 1.3);
});

test('萤火虫：轨迹不是绕圈 —— 三轴异频的拟合圆残差显著大于同频', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, PLAINS.x, PLAINS.z);
  await freezeAll(page, -0.10);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { FIREFLY_ATTR } = await import('/src/render/firefly-fx-material.js');
    const { fireflyMotionAt } = await import('/src/render/ambient-fx-config.js');
    const geo = g.fireflyFx.mesh.geometry;
    const o = geo.getAttribute(FIREFLY_ATTR.origin);
    const amp = geo.getAttribute(FIREFLY_ATTR.amp);
    const freq = geo.getAttribute(FIREFLY_ATTR.freq);
    const phase = geo.getAttribute(FIREFLY_ATTR.phase);
    const sizeAlive = geo.getAttribute(FIREFLY_ATTR.sizeAlive);
    const driftGround = geo.getAttribute(FIREFLY_ATTR.driftGround);

    /** 最小二乘拟合圆（代数法）后的 RMS 残差 / 平均半径 */
    const circleResidual = (pts) => {
      const n = pts.length;
      let sx = 0; let sz = 0;
      for (const [x, z] of pts) { sx += x; sz += z; }
      const mx = sx / n; const mz = sz / n;
      // 解 [u,v] 使 x²+z² ≈ a·x + b·z + c（圆心 = (a/2, b/2)）
      let Sxx = 0; let Sxz = 0; let Szz = 0; let Sx = 0; let Sz = 0;
      let Sxy = 0; let Szy = 0; let Sy = 0;
      for (const [x0, z0] of pts) {
        const x = x0 - mx; const z = z0 - mz; const y = x * x + z * z;
        Sxx += x * x; Sxz += x * z; Szz += z * z; Sx += x; Sz += z;
        Sxy += x * y; Szy += z * y; Sy += y;
      }
      const det = Sxx * Szz - Sxz * Sxz;
      const a = det === 0 ? 0 : (Sxy * Szz - Szy * Sxz) / det;
      const b = det === 0 ? 0 : (Szy * Sxx - Sxy * Sxz) / det;
      const c = (Sy - a * Sx - b * Sz) / n;
      const cx = a / 2; const cz = b / 2;
      const R = Math.sqrt(Math.max(1e-9, c + cx * cx + cz * cz));
      let s = 0;
      for (const [x0, z0] of pts) {
        const d = Math.hypot(x0 - mx - cx, z0 - mz - cz) - R;
        s += d * d;
      }
      return Math.sqrt(s / n) / R;
    };

    const real = []; const same = [];
    const count = Math.min(12, o.count);
    for (let i = 0; i < count; i++) {
      const seed = {
        x: o.getX(i), y: o.getY(i), z: o.getZ(i), groundY: o.getY(i) - 1,
        ampX: amp.getX(i), ampY: amp.getY(i), ampZ: amp.getZ(i),
        freqX: freq.getX(i), freqY: freq.getY(i), freqZ: freq.getZ(i),
        phaseX: phase.getX(i), phaseY: phase.getY(i), phaseZ: phase.getZ(i),
        driftX: driftGround.getX(i), driftZ: driftGround.getY(i),
      };
      const pts = []; const ptsSame = [];
      for (let k = 0; k < 200; k++) {
        const t = k * 0.06;
        const m = fireflyMotionAt(seed, t, {});
        pts.push([m.x, m.z]);
        // 同频对照：三轴用同一个频率与相位、同幅、无漂移 ⇒ 真正的圆/直线
        const f = seed.freqX; const ph = seed.phaseX; const A = seed.ampX;
        ptsSame.push([
          seed.x + A * Math.sin(f * t + ph),
          seed.z + A * Math.cos(f * t + ph),
        ]);
      }
      real.push(circleResidual(pts));
      same.push(circleResidual(ptsSame));
    }
    return {
      count,
      nonCircle: real.filter((v) => v > 0.05).length,
      realMin: Math.min(...real), realMax: Math.max(...real),
      sameMax: Math.max(...same),
      freqSpread: Array.from({ length: count }, (_, i) => [freq.getX(i), freq.getY(i), freq.getZ(i)]),
    };
  });
  console.log('AMBIENT-FLY-CIRCLE: ' + JSON.stringify(r));
  expect(r.count, '须真的量了多只（防空转）').toBeGreaterThan(4);
  expect(r.sameMax, `同频对照的残差须近于 0（实测 ${r.sameMax}）`).toBeLessThan(0.02);
  /**
   * ⚠️ **不能用「每一只都显著非圆」**（本轮实测）：三轴异频里仍有个体在采样窗口内
   * 恰好走出近圆轨迹（实测最小残差 **0.0067**，而同频对照恒 ~4e-13）⇒ 逐个下限会 flaky。
   * 真意图是「这一群不是绕圈的粒子」⇒ 钉**多数个体**显著非圆 + 同频对照近零。
   */
  expect(r.nonCircle, `多数萤火虫须显著非圆（实测 ${r.nonCircle}/${r.count}）`)
    .toBeGreaterThan(r.count * 0.6);
});

test('draw call：同机位开/关只差 ≤2（跨机位不可比），非目标 biome 零增量', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });

  /**
   * ⚠️⚠️ **必须同机位开/关对照，不能跨机位比**（本轮实测推翻 plan Step 7 的写法）：
   * 不同机位的可见 geometry slot 数差别巨大（实测沙漠 353 / 森林 308 / 草地 300）
   * ⇒ 「森林 − 沙漠」得到 **−45**，判据完全失效。
   * 单变量只能是「同一机位、同一世界，只差特效开关」。
   */
  const readPair = async () => {
    await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
    await setAmbient(page, true);
    const on = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      return {
        draw: g.renderStats().drawCalls,
        leaf: g.leafFx?.mesh?.visible ?? null,
        fly: g.fireflyFx?.mesh?.visible ?? null,
        biome: g.leafFx?.debugState()?.biome ?? null,
      };
    });
    await setAmbient(page, false);
    const off = await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls);
    await setAmbient(page, true);
    return { on, off, delta: on.draw - off };
  };

  await gotoSite(page, DESERT.x, DESERT.z);
  const desert = await readPair();
  await gotoSite(page, FOREST.x, FOREST.z);
  const forest = await readPair();
  await gotoSite(page, PLAINS.x, PLAINS.z);
  const plains = await readPair();

  console.log('AMBIENT-DRAW: ' + JSON.stringify({ desert, forest, plains }));
  expect(desert.on.leaf, '沙漠落叶池须 invisible').toBe(false);
  expect(desert.on.fly, '沙漠萤火虫池须 invisible').toBe(false);
  expect(desert.delta, `沙漠零增量（实测 ${desert.delta}）`).toBe(0);
  expect(forest.on.leaf, '森林落叶池须可见').toBe(true);
  expect(forest.on.fly, '森林萤火虫池须 invisible').toBe(false);
  // ⚠️ 实测 **+2** 而不是 plan 写的 +1：池自身 1 个 draw，另 1 个是 three 把
  // 新的 transparent mesh 插入排序列表后带来的额外一次提交（同机位单变量实测）。
  // 判据钉「小于等于 2 且 > 0」：上界排除「池漏了多个 mesh」，下界排除「根本没画」。
  expect(forest.delta, `森林单池增量须在 (0,2]（实测 ${forest.delta}）`).toBeGreaterThan(0);
  expect(forest.delta).toBeLessThanOrEqual(2);
  expect(plains.on.fly, '草地萤火虫池须可见').toBe(true);
  expect(plains.on.leaf, '草地落叶池须 invisible').toBe(false);
  expect(plains.delta, `草地单池增量须在 (0,2]（实测 ${plains.delta}）`).toBeGreaterThan(0);
  expect(plains.delta).toBeLessThanOrEqual(2);
});

// ==================== 负向对照（每条正向判据都要有） ====================
//
// ⚠️⚠️ **常量编译进 shader / 出生数据 ⇒ 浏览器侧改对象无效**，必须用 `page.route`
// 换模块内容；且 **route 必须在 `page.goto` 之前注册**（放后面时模块已加载，拦截永不触发，
// 形态是「注入静默失效」而报错看起来像生产代码没消费该常量）。
// 每条注入后都**读回浏览器侧的常量值**确认注入真的生效（否则是「注入没生效的假绿」）。

/** 注册一个模块内容替换（必须在 goto 之前调） */
async function routeModule(page, file, transform) {
  await page.route(`**/${file}*`, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const next = transform(body);
    if (next === body) throw new Error(`[负向对照] ${file} 的注入模式未命中 —— 注入静默失效`);
    await route.fulfill({ response: res, body: next, headers: { ...res.headers(), 'content-type': 'application/javascript' } });
  });
}

test('负向①：秋色权重换成真实叶种比例 ⇒ 秋色内容级判据必须 FAIL', async ({ page }) => {
  test.setTimeout(240_000);
  await routeModule(page, 'ambient-fx-config.js', (b) => b
    .replace("Object.freeze(['yellow_leaves', 0.65])", "Object.freeze(['yellow_leaves', 0.25])")
    .replace("Object.freeze(['giant_banyan_leaves', 0.12])", "Object.freeze(['giant_banyan_leaves', 0.0375])")
    .replace("Object.freeze(['giant_palm_leaves', 0.08])", "Object.freeze(['giant_palm_leaves', 0.0375])")
    .replace("Object.freeze(['leaves', 0.10])", "Object.freeze(['leaves', 0.60])")
    .replace("Object.freeze(['giant_spruce_leaves', 0.05])", "Object.freeze(['giant_spruce_leaves', 0.075])"));
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await page.evaluate(() => window.__MC_GAME__.setVisualStyle('noon'));
  await freezeAll(page, -0.10);
  await page.waitForTimeout(4000);

  // 注入生效确认：既读常量，也读**真实 GPU 属性色分布**（后者才是渲染消费的那份）
  const inj = await page.evaluate(async () => {
    const { LEAF_AUTUMN_WEIGHTS } = await import('/src/render/ambient-fx-config.js');
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const c = window.__MC_GAME__.leafFx.mesh.geometry.getAttribute(LEAF_ATTR.color);
    let yellow = 0; let green = 0;
    for (let i = 0; i < c.count; i++) {
      const r = c.getX(i); const g = c.getY(i);
      if (r > 0.19 && g > 0.22 && g < 0.25) yellow++;         // yellow_leaves 0.202,0.232
      if (r < 0.02 && g > 0.14 && g < 0.17) green++;           // leaves 0.012,0.154
    }
    return { w: LEAF_AUTUMN_WEIGHTS.map(([n, v]) => [n, v]), yellow, green, count: c.count };
  });
  console.log('NEG-AUTUMN-INJ: ' + JSON.stringify(inj));
  expect(inj.w.find(([n]) => n === 'yellow_leaves')[1], '注入须真的生效').toBe(0.25);
  expect(inj.green, `绿叶实例须多于黄叶（实测 green=${inj.green} yellow=${inj.yellow}）`)
    .toBeGreaterThan(inj.yellow);

  /**
   * ⚠️⚠️ **两次实测推翻的判据，别再重试**：
   * ① 「秋色计数为 0」—— 真实比例里仍有 25% 黄叶 ⇒ 计数仍非零（实测 111~824）；
   * ② 「秋色占比 < 0.10」—— 占比随叶片翻转相位与落地时刻漂移，正向 0.11~0.42 /
   *    负向 0.03~0.11 **分布重叠** ⇒ 固定阈值必 flaky。
   * 正解：与正向同口径的**内容级判据**（真实 GPU 属性色分布），它与时序无关。
   */
  expect(inj.yellow, `真实比例下黄叶实例须少于绿叶（实测 yellow=${inj.yellow} green=${inj.green}）`)
    .toBeLessThan(inj.green);
});

test('负向②：birthMax 改成 40 ⇒「不高于树」判据必须 FAIL', async ({ page }) => {
  test.setTimeout(240_000);
  await routeModule(page, 'ambient-fx-config.js', (b) => b.replace('birthMax: 13,', 'birthMax: 40,'));
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await freezeAll(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const { LEAF_FX } = await import('/src/render/ambient-fx-config.js');
    const geo = g.leafFx.mesh.geometry;
    const o = geo.getAttribute(LEAF_ATTR.origin);
    const p = geo.getAttribute(LEAF_ATTR.params);
    let max = -Infinity;
    for (let i = 0; i < o.count; i++) max = Math.max(max, o.getY(i) - (p.getX(i) - LEAF_FX.floorOffset));
    return { max, birthMax: LEAF_FX.birthMax, specUpper: 13 };
  });
  console.log('NEG-BIRTH: ' + JSON.stringify(r));
  expect(r.birthMax, '注入须真的生效').toBe(40);
  expect(r.max, `出生高度须真的越过 13（实测 ${r.max}）`).toBeGreaterThan(r.specUpper);
});

test('负向③：去掉 tEff 的 min ⇒「落地即停」判据必须 FAIL', async ({ page }) => {
  test.setTimeout(240_000);
  // shader 侧去掉 min（落地后继续摆荡/自转）；CPU 复刻侧同步去掉，两侧同口径
  await routeModule(page, 'leaf-fx-material.js', (b) => b.replace('const tEff = min(t, tLand);', 'const tEff = t;'));
  await routeModule(page, 'ambient-fx-config.js', (b) => b.replace('const tEff = Math.min(t, tLand);', 'const tEff = t;'));
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, FOREST.x, FOREST.z);
  await freezeAll(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { LEAF_ATTR } = await import('/src/render/leaf-fx-material.js');
    const { leafMotionAt, leafLandSeconds } = await import('/src/render/ambient-fx-config.js');
    const geo = g.leafFx.mesh.geometry;
    const o = geo.getAttribute(LEAF_ATTR.origin);
    const p = geo.getAttribute(LEAF_ATTR.params);
    const sway = geo.getAttribute(LEAF_ATTR.sway);
    const spin = geo.getAttribute(LEAF_ATTR.spin);
    let frozen = 0; let checked = 0;
    for (let i = 0; i < o.count; i++) {
      const seed = {
        x: o.getX(i), y: o.getY(i), z: o.getZ(i), minY: p.getX(i), fallSpeed: p.getY(i),
        swayAmp: sway.getX(i), swayFreq: sway.getY(i), swayPhase: sway.getZ(i),
        spinX: spin.getX(i), spinY: spin.getY(i), spinZ: spin.getZ(i),
      };
      const tLand = leafLandSeconds(seed);
      const a = { ...leafMotionAt(seed, tLand + 0.05) };
      const b = { ...leafMotionAt(seed, tLand + 1.20) };
      if (a.x === b.x && a.z === b.z && a.rotX === b.rotX) frozen++;
      checked++;
    }
    const src = String(leafMotionAt);
    return { frozen, checked, injected: !src.includes('Math.min(t, tLand)') };
  });
  console.log('NEG-LAND: ' + JSON.stringify(r));
  expect(r.injected, '注入须真的生效').toBe(true);
  expect(r.frozen, `去掉 min 后不得再有冻结的叶片（实测 ${r.frozen}/${r.checked}）`).toBe(0);
});

test('负向④：萤火虫三轴改成同频 ⇒「不是绕圈」判据必须 FAIL', async ({ page }) => {
  test.setTimeout(240_000);
  await routeModule(page, 'ambient-fx-config.js', (b) => b
    .replace('freqY: f1,', 'freqY: f0,')
    .replace('freqZ: f2,', 'freqZ: f0,')
    .replace('phaseY: rand() * Math.PI * 2,', 'phaseY: 0,')
    .replace('phaseZ: rand() * Math.PI * 2,', 'phaseZ: 0,')
    .replace('driftX: (rand() * 2 - 1) * cfg.drift,', 'driftX: 0,')
    .replace('driftZ: (rand() * 2 - 1) * cfg.drift,', 'driftZ: 0,'));
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, PLAINS.x, PLAINS.z);
  await freezeAll(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { FIREFLY_ATTR } = await import('/src/render/firefly-fx-material.js');
    const geo = g.fireflyFx.mesh.geometry;
    const f = geo.getAttribute(FIREFLY_ATTR.freq);
    const d = geo.getAttribute(FIREFLY_ATTR.driftGround);
    let same = 0; let n = 0;
    for (let i = 0; i < f.count; i++) {
      if (f.getX(i) === f.getY(i) && f.getY(i) === f.getZ(i)
        && d.getX(i) === 0 && d.getY(i) === 0) same++;
      n++;
    }
    return { same, n };
  });
  console.log('NEG-CIRCLE: ' + JSON.stringify(r));
  expect(r.same, `注入后全部萤火虫须三轴同频且零漂移（实测 ${r.same}/${r.n}）`).toBe(r.n);
});

test('负向⑤：gainNight 改成等于 gainDay ⇒「夜里更亮」判据必须 FAIL', async ({ page }) => {
  test.setTimeout(240_000);
  await routeModule(page, 'ambient-fx-config.js', (b) => b.replace('gainNight: 1.15,', 'gainNight: 0.55,'));
  await page.goto(URL_BASE);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await gotoSite(page, PLAINS.x, PLAINS.z);
  await freezeAll(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { FIREFLY_FX, fireflyNightAt } = await import('/src/render/ambient-fx-config.js');
    return { gainNight: FIREFLY_FX.gainNight, day: fireflyNightAt(0).gain, night: fireflyNightAt(1).gain };
  });
  console.log('NEG-GAIN: ' + JSON.stringify(r));
  expect(r.gainNight, '注入须真的生效').toBe(0.55);
  expect(r.night, `夜里 gain 须不再大于白天（实测 ${r.night} vs ${r.day}）`).toBe(r.day);
});
