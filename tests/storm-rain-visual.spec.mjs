import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.30d/e：用户实玩报告的雨天缺陷的回归门。
//
// ① v3.30d「下雨时画面像光栅扫描渲染」→ 根因 hash(floor(uv)) 硬格子。
//    v3.30e「屏幕上有纹路，让屏幕看上去很粗糙」→ **另一个根因**：换成双线性条纹图后，
//    柱面投影把 512² 细丝压到 1.37~5.69 texel/像素 ⇒ **欠采样走样**成满屏竖纹。
//    上游靠链尾 FXAA 抹平，而本仓 MSAA 只抗几何边缘、对 shader 内高频**完全无效**。
//    ⇒ 用户裁定**远景雨幕整层移除**；本 spec 的首用例改为钉「竖纹不超过无链基线」。
//    ⚠️ 判据必须用「符号翻转次数」：v3.30d 的「相邻像素差为 0 的比例」对走样零判别力。
//
// ② v3.30d「有的方块不呈现反射，好像地下又有一层模糊的透射」
//    根因：复用海平面 reflector（镜面 y=−1.5），而本仓地面 y≈22 ⇒ 上游的
//    「压平到镜面再投影」把地面点推低 23.5 格 ⇒ 投影出画。上游地面就在 y=0（=镜面）
//    所以那步是 no-op。**复用海平面 reflector 在几何上不可能正确**。
//    修法：独立地面反射 pass（镜面 = 玩家脚下地面，平滑跟随）+ 去掉误用的 rfade。
//
// ⚠️ 判据全部读**真实 GPU 像素**，不读常量。

const BOOT = async (page, extra = '') => {
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(`/?vd=4&seed=12345&skybox=0&weather=clear${extra}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 150_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
  });
  return errs;
};

/**
 * v3.30e：用户实玩报告「屏幕上有纹路，让屏幕看上去很粗糙……感觉还不如去掉」。
 * **根因（单变量像素实测）**：远景雨幕把 512² 细丝纹理按柱面投影铺满屏幕，
 * 三层 tiles=12/25/50 ⇒ 横向密度 1.37 / 2.85 / 5.69 texel/像素 ⇒ 欠采样走样成竖纹。
 * 上游同样欠采样（4.91 texel/px），但它链尾有 **FXAA** 抹平；本仓 MSAA 只抗几何边缘、
 * 对 shader 内采样的高频纹理**完全无效** ⇒ 照搬这一层必然粗糙。
 * ⇒ **用户裁定整层去掉**。本用例改为钉「竖纹不得超过无链基线」。
 *
 * ⚠️ **判据选型**：量「同一行内相邻像素 luma 差的**符号翻转次数**」——
 * 竖纹是横向高频，翻转次数直接刻画它；而「相邻像素差为 0 的比例」（旧块状度判据）
 * 对走样零判别力：走样恰恰是**处处都不同**。实测基线 33.5、缺陷态 83.5。
 */
function rowFlipRate(png, y0, y1, x0, x1) {
  let flips = 0;
  const lum = (o) => 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
  for (let y = y0; y < y1; y++) {
    let prevSign = 0;
    for (let x = x0 + 1; x < x1; x++) {
      const d = lum((y * png.width + x) * 4) - lum((y * png.width + x - 1) * 4);
      const sg = d > 0.5 ? 1 : d < -0.5 ? -1 : 0;
      if (sg !== 0 && prevSign !== 0 && sg !== prevSign) flips++;
      if (sg !== 0) prevSign = sg;
    }
  }
  return flips / (y1 - y0);
}

test('雨天：屏幕上没有走样竖纹（远景雨幕已整层移除）', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = await BOOT(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 2500));
    let last = -1; let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const n = g.renderWorld.slotMap.size;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
    g.renderer.setAnimationLoop(null);
    // 关颗粒（它按 uTime 逐帧变，会污染横向高频读数）；其余效果全开
    g.stormGrade.uniforms.uGrain.value = 0;
    g.stormGrade.uniforms.uTime.value = 8.0;
    g.stormRain.setEnabled(false);   // 只量屏幕空间的层，排除真实几何雨丝
    g.player.pitch = 0.12; g.player.yaw = 0.4;
    g.player.update(0.016);
  });
  const render = () => {
    const g = window.__MC_GAME__;
    g._renderWaterReflection();
    g.stormGrade.pipeline.render();
  };
  // 预热两帧（RTTNode 首帧才定 RT 尺寸/建缓存 —— 见下方世界锚定用例的注释）
  await page.evaluate(render); await page.waitForTimeout(200);
  await page.evaluate(render); await page.waitForTimeout(200);

  const measure = async (gradeOn) => {
    await page.evaluate((on) => {
      window.__MC_GAME__.stormGrade.uniforms.uEnabled.value = on ? 1 : 0;
    }, gradeOn);
    await page.evaluate(render); await page.waitForTimeout(250);
    const p = PNG.sync.read(await page.screenshot());
    const W = p.width; const H = p.height;
    return {
      sky: +rowFlipRate(p, Math.round(H * 0.04), Math.round(H * 0.18), Math.round(W * 0.36), Math.round(W * 0.64)).toFixed(1),
      mid: +rowFlipRate(p, Math.round(H * 0.42), Math.round(H * 0.58), Math.round(W * 0.32), Math.round(W * 0.68)).toFixed(1),
    };
  };
  const on = await measure(true);
  const off = await measure(false);
  console.log('STRIPE FLIPS/ROW:', JSON.stringify({ gradeOn: on, gradeOff: off }));
  /**
   * 缺陷态实测：sky 83.5 / mid 158.2（无链基线 33.5 / 76.1）。
   * 整层移除后两者应当**基本相等** —— 分级只剩低频项（雾/bloom/暗角/冷调）。
   * 阈值取基线 +12 次/行余量（雾的 perlin 与 bloom 会带来少量高频）。
   */
  expect(on.sky, `天空竖纹不得超过无链基线 +12（实测缺陷态 83.5，基线 ${off.sky}）`)
    .toBeLessThan(off.sky + 12);
  expect(on.mid, `中带竖纹不得超过无链基线 +12（实测缺陷态 158.2，基线 ${off.mid}）`)
    .toBeLessThan(off.mid + 12);
  // 结构性判据：那一层的 uniform 与 API 必须真的不存在（防将来「补齐」）
  const gone = await page.evaluate(() => {
    const U = window.__MC_GAME__.stormGrade.uniforms;
    return {
      rainGain: U.uRainGain === undefined,
      sheetOn: U.uRainSheetOn === undefined,
      setRainSheet: typeof window.__MC_GAME__.stormGrade.setRainSheet,
    };
  });
  console.log('FAR RAIN REMOVED:', JSON.stringify(gone));
  expect(gone.rainGain, 'uRainGain 必须已删').toBe(true);
  expect(gone.sheetOn, 'uRainSheetOn 必须已删').toBe(true);
  expect(gone.setRainSheet, 'setRainSheet 必须已删').toBe('undefined');
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('雨天：体积雾锚在世界空间（同姿态同时间重渲必须逐位稳定）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 2000));
    /**
     * ⚠️⚠️ **必须等世界完全收敛再冻帧**：帧循环停了，但 Worker 回调与 scheduler
     * 仍在发布新 section ⇒ 两次取样之间地形还在长 ⇒ diff 90%（世界在变，不是雨幕漂）。
     */
    let last = -1; let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      await new Promise((res) => setTimeout(res, 200));
      const n = g.renderWorld.slotMap.size;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
    g.renderer.setAnimationLoop(null);
    // 只留体积雾（关 bloom/CA/暗角/冷调/颗粒），冻时间
    const U = g.stormGrade.uniforms;
    U.uFogGain.value = 0; U.uBloomGain.value = 0; U.uCA.value = 0;
    U.uVignette.value = 0; U.uCold.value = 0; U.uGrain.value = 0;
    U.uTime.value = 5.0;
    g.stormRain.setEnabled(false);
    g.player.pitch = 0.1; g.player.yaw = 0.4;
    g.player.update(0.016);      // ← 姿态只在这里推进一次
  });
  /**
   * ⚠️⚠️ **两次取样都只重渲，绝不推进 player**（本轮实测的判据坑）：
   * 多调一次 `player.update` 会让相机再走一帧（viewBob/stepLift/sway）⇒ diff 90%，
   * 那是测量方法错。逐层剥离探针实测：只重渲时 renderer.render / +反射 / +链 /
   * +远景雨幕 **四档 diff 全为 0** ⇒ 实现本身是稳定的。
   */
  const render = () => {
    const g = window.__MC_GAME__;
    g._renderWaterReflection();
    g.stormGrade.pipeline.render();
    return {
      sections: g.renderWorld.slotMap.size,
      columns: g.world.columns.size,
      camY: +g.camera.position.y.toFixed(4),
      camRotX: +g.camera.rotation.x.toFixed(5),
      camRotY: +g.camera.rotation.y.toFixed(5),
      wetTime: g.renderWorld.materials.wet.uWetTime.value,
      gradeTime: g.stormGrade.uniforms.uTime.value,
      mirrorY: g.groundReflect.mirrorY,
      wet: g.renderWorld.materials.wet.uWet.value,
    };
  };
  /**
   * ⚠️⚠️ **预热必须按「输出收敛」判，不能写固定帧数**（本轮实测）：
   * 后处理链的 RTTNode 首帧才确定 RT 尺寸 / 建立缓存。定数预热两帧在**单跑**时够
   * （diff 0），但**多 spec 批次高负载**下不够 —— 实测同一用例单跑 3 轮全 0、
   * 全 spec 跑也 0，只在 9 个 spec 的批次里 diff **0.373**（而相机/世界/uniform 逐位相同）。
   * ⇒ 改成**轮询到连续两次截图完全一致**再取样（上限 12 轮），不依赖机器负载。
   * ⚠️ 这不是「放宽阈值」：阈值仍是 diff<0.005，改的是**取样前的收敛条件**。
   */
  const shotBuf = async () => PNG.sync.read(await page.screenshot());
  const sameShot = (a, b) => {
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) return false;
    }
    return true;
  };
  await page.evaluate(render);
  await page.waitForTimeout(200);
  let prev = await shotBuf();
  let warm = 0;
  for (let i = 0; i < 12; i++) {
    await page.evaluate(render);
    await page.waitForTimeout(200);
    const cur = await shotBuf();
    if (sameShot(prev, cur)) { warm = i + 1; break; }
    prev = cur;
  }
  console.log('FOG WARMUP ROUNDS:', warm);
  expect(warm, '后处理链必须在 12 轮内收敛（否则是真实的不稳定）').toBeGreaterThan(0);
  const st1 = await page.evaluate(render);
  await page.waitForTimeout(250);
  const a = PNG.sync.read(await page.screenshot());
  const st2 = await page.evaluate(render);
  await page.waitForTimeout(250);
  const b = PNG.sync.read(await page.screenshot());
  let diff = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const o = i * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > 10) diff++;
  }
  const frac = diff / (a.width * a.height);
  console.log('FOG WORLD-ANCHOR REPEAT DIFF:', JSON.stringify({ diff, frac: +frac.toFixed(6) }));
  // 状态必须逐位相同（否则差异来自世界/相机而不是雨幕）
  expect(st2.sections).toBe(st1.sections);
  expect(st2.camRotY).toBe(st1.camRotY);
  expect(st2.gradeTime).toBe(st1.gradeTime);
  expect(frac, '同姿态同时间的体积雾必须逐位稳定（跟着屏幕转的写法会漂）').toBeLessThan(0.005);
});

test('雨天：湿地面反射在近/中/远都生效（不是只有远处有）', async ({ page }) => {
  test.setTimeout(240_000);
  const errs = await BOOT(page);
  const st = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 1600));
    g.renderer.setAnimationLoop(null);
    g.player.pitch = -0.5;         // 朝下看地面
    g.player.update(0.016);
    const wet = g.renderWorld.materials.wet;
    return {
      stormActive: g.stormLighting,
      mirrorY: g.groundReflect.mirrorY,
      playerY: g.player.physics.pos.y,
      groundRefreshes: g.groundReflect.refreshes,
      wetMirrorY: wet.uWetMirrorY.value,
      // 镜面必须贴着玩家脚下地面（而不是海平面 −1.5）
      mirrorNearGround: Math.abs(g.groundReflect.mirrorY - g.player.physics.pos.y) < 2,
    };
  });
  console.log('GROUND MIRROR STATE:', JSON.stringify(st));
  expect(st.stormActive).toBe(true);
  expect(st.groundRefreshes, '地面反射 pass 必须真的跑过').toBeGreaterThan(0);
  expect(st.mirrorNearGround, '镜面必须贴着玩家脚下地面（不是海平面）').toBe(true);

  const grab = async (refl) => {
    await page.evaluate((v) => {
      const g = window.__MC_GAME__;
      const wet = g.renderWorld.materials.wet;
      wet.uWet.value = 1;
      wet.uWetReflect.value = v;
      wet.uWetTime.value = 12.0;
      g._renderWaterReflection();
      g.stormGrade.pipeline.render();
    }, refl);
    await page.waitForTimeout(240);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await grab(0);
  const on = await grab(0.5);
  const bands = [['near', 0.72, 0.95], ['mid', 0.55, 0.72], ['far', 0.40, 0.55]];
  const out = {};
  for (const [name, y0f, y1f] of bands) {
    let n = 0; let changed = 0;
    for (let y = Math.floor(on.height * y0f); y < Math.floor(on.height * y1f); y++) {
      for (let x = Math.floor(on.width * 0.15); x < Math.floor(on.width * 0.85); x++) {
        const o = (y * on.width + x) * 4;
        const d = Math.abs(on.data[o] - off.data[o]) + Math.abs(on.data[o + 1] - off.data[o + 1]) + Math.abs(on.data[o + 2] - off.data[o + 2]);
        n++;
        if (d > 8) changed++;
      }
    }
    out[name] = +(changed / n).toFixed(4);
  }
  console.log('WET REFLECT BY DISTANCE:', JSON.stringify(out));
  // 缺陷态：near=0（镜面错位 ⇒ 近处投影出画）。修后三带都必须显著非零。
  expect(out.near, '近处地面必须有反光（缺陷态 0）').toBeGreaterThan(0.1);
  expect(out.mid, '中距离地面必须有反光').toBeGreaterThan(0.1);
  expect(out.far, '远处地面必须有反光（旧实现被 rfade 误杀）').toBeGreaterThan(0.1);
  // 无 WebGPU 验证错误（读写冲突会让整个 CommandBuffer 作废 ⇒ 全屏黑）
  const gpuErrs = errs.filter((e) => /GPUValidationError|Invalid CommandBuffer/.test(e));
  expect(gpuErrs, `不得有 WebGPU 验证错误：${gpuErrs.slice(0, 2).join(' | ')}`).toEqual([]);
});

test('雨天：主画面不被撕碎（两条反射 pass 的索引表隔离）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const shot = async (stormOn) => {
    await page.evaluate(async (on) => {
      const g = window.__MC_GAME__;
      g.setStormLighting(on);
      await new Promise((r) => setTimeout(r, 1200));
      g.renderer.setAnimationLoop(null);
      g.player.pitch = 0.05;        // 平视：地平线以上的天空占大半
      g.player.update(0.016);
      g._renderWaterReflection();
      if (on) g.stormGrade.pipeline.render();
      else g.renderer.render(g.scene, g.camera);
    }, stormOn);
    await page.waitForTimeout(300);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await shot(false);
  const on = await shot(true);
  /**
   * ⚠️⚠️ **取样区必须是「中心天空区」，不能是整条上带**（本轮实测的判据坑）：
   * 本机位左侧 10% 是**建筑/地形**（无链时 luma 54、近黑 0.002），分级把暗部
   * 进一步压暗是正常的（暗角+冷调+S曲线）⇒ 量整条带会把「建筑被压暗」误判成撕碎。
   * 撕碎的形态是**随机多边形污染整片**（v3.17 实测近黑 1.26%→11.66%），
   * 中心天空区（x∈[0.35,0.65]、y∈[0,0.2]）在无缺陷时是纯天空 ⇒ 判别力最强。
   */
  const blackSky = (png) => {
    let n = 0; let black = 0; let sum = 0;
    const x0 = Math.floor(png.width * 0.35); const x1 = Math.floor(png.width * 0.65);
    const y1 = Math.floor(png.height * 0.2);
    for (let y = 0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * png.width + x) * 4;
        const l = 0.299 * png.data[o] + 0.587 * png.data[o + 1] + 0.114 * png.data[o + 2];
        n++; sum += l;
        if (l < 24) black++;
      }
    }
    return { frac: black / n, luma: sum / n };
  };
  const a = blackSky(off); const b = blackSky(on);
  console.log('CENTER SKY:', JSON.stringify({
    off: { frac: +a.frac.toFixed(5), luma: Math.round(a.luma) },
    on: { frac: +b.frac.toFixed(5), luma: Math.round(b.luma) },
  }));
  expect(b.frac, '中心天空区不得被撕成黑多边形').toBeLessThan(0.02);
  // 中心天空必须仍然是亮的（撕碎或分级过强都会把它压暗）
  expect(b.luma, '中心天空必须仍亮（>120）').toBeGreaterThan(120);

});

test('雨天：关闭后零回归（雨幕/雾/湿地面/地面 pass 全停）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((res) => setTimeout(res, 1200));
    const onRefreshes = g.groundReflect.refreshes;
    g.setStormLighting(false);
    await new Promise((res) => setTimeout(res, 800));
    const before = g.groundReflect.refreshes;
    await new Promise((res) => setTimeout(res, 600));
    return {
      stormActive: g.stormLighting,
      uWet: g.renderWorld.materials.wet.uWet.value,
      gradeEnabled: g.stormGrade.uniforms.uEnabled.value,
      streakVisible: g.stormRain.streakMesh.visible,
      onRefreshes,
      // 关闭后地面 pass 不得再刷新
      refreshDelta: g.groundReflect.refreshes - before,
    };
  });
  console.log('STORM OFF:', JSON.stringify(r));
  expect(r.stormActive).toBe(false);
  expect(r.uWet).toBe(0);
  expect(r.gradeEnabled).toBe(0);
  expect(r.streakVisible).toBe(false);
  expect(r.onRefreshes).toBeGreaterThan(0);
  expect(r.refreshDelta, '关闭后地面反射 pass 必须停跑（零成本）').toBe(0);
});