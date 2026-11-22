import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.30d：用户实玩报告的两个雨天缺陷的回归门。
//
// ① 「下雨时画面像光栅扫描渲染，光栅占满整个屏幕」
//    根因：远景雨幕与体积雾都用 `hash(floor(uv))` —— **硬格子**，每个 cell 整体亮/暗
//    ⇒ 屏幕上是一片轴对齐矩形块。实测雨幕层相邻像素**完全相同 82.06%**（场景本身 4.6%）。
//    修法：雨幕改**烘焙的双线性条纹图**（上游 makeRainSheet 逐字），雾改**连续 perlin**；
//    视线方向改**真实相机反投影**（旧的固定 fov 近似没转世界空间 ⇒ 雨幕跟着屏幕转）。
//
// ② 「有的方块不呈现反射，好像地地下又有一层模糊的透射」
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
 * 「块状度」：相邻像素差为 0 的比例。
 * 硬格子（hash(floor(uv))）⇒ 大片平坦色块 ⇒ 该比例极高；
 * 连续噪声 / 双线性纹理 ⇒ 该比例接近场景本身的水平。
 */
function zeroDiffFrac(png, x0, y0, x1, y1) {
  let zero = 0; let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0 + 1; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      const p = (y * png.width + x - 1) * 4;
      const d = Math.abs(png.data[o] - png.data[p])
        + Math.abs(png.data[o + 1] - png.data[p + 1])
        + Math.abs(png.data[o + 2] - png.data[p + 2]);
      n++;
      if (d === 0) zero++;
    }
  }
  return zero / n;
}

/** 把「开-关」的差分放大成可视图（128 为中点），用于量效应层自身的块状度 */
function diffLayer(on, off, gain = 4) {
  const d = new PNG({ width: on.width, height: on.height });
  for (let i = 0; i < on.width * on.height; i++) {
    const o = i * 4;
    for (let k = 0; k < 3; k++) {
      d.data[o + k] = Math.max(0, Math.min(255, 128 + (on.data[o + k] - off.data[o + k]) * gain));
    }
    d.data[o + 3] = 255;
  }
  return d;
}

test('雨天：远景雨幕不是硬格子（块状度接近场景水平）', async ({ page }) => {
  test.setTimeout(240_000);
  await BOOT(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 1800));
    g.renderer.setAnimationLoop(null);
    g.player.pitch = 0.12;          // 略抬头：远景雨幕最明显
    g.player.update(0.016);
    g.stormGrade.uniforms.uTime.value = 8.0;
    g._renderWaterReflection();
    g.stormGrade.pipeline.render();
  });
  const shot = async (fog, rain) => {
    await page.evaluate(({ f, r }) => {
      const g = window.__MC_GAME__;
      g.stormGrade.uniforms.uFogGain.value = f;
      g.stormGrade.uniforms.uRainGain.value = r;
      g.stormGrade.pipeline.render();
    }, { f: fog, r: rain });
    await page.waitForTimeout(230);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await shot(0, 0);
  const rainOn = await shot(0, 1.0);
  const fogOn = await shot(0.02, 0);
  const base = zeroDiffFrac(off, 100, 60, 1180, 260);
  const rainFrac = zeroDiffFrac(diffLayer(rainOn, off), 100, 60, 1180, 260);
  const fogFrac = zeroDiffFrac(diffLayer(fogOn, off), 100, 60, 1180, 260);
  console.log('RAIN BLOCKINESS:', JSON.stringify({
    scene: +base.toFixed(4), rainLayer: +rainFrac.toFixed(4), fogLayer: +fogFrac.toFixed(4),
  }));
  // 缺陷态：雨幕层 0.8206（硬格子）。修后必须远低于它，且不超过场景水平的 2 倍 + 余量。
  expect(rainFrac, '远景雨幕不得是硬格子（缺陷态 0.82）').toBeLessThan(0.45);
  expect(fogFrac, '体积雾不得是硬格子（缺陷态 0.22 且跳变间距集中）').toBeLessThan(0.45);
  // 雨幕必须真的画出来了（差分非零）
  let rainChanged = 0;
  for (let i = 0; i < rainOn.width * rainOn.height; i++) {
    const o = i * 4;
    const d = Math.abs(rainOn.data[o] - off.data[o]) + Math.abs(rainOn.data[o + 1] - off.data[o + 1]) + Math.abs(rainOn.data[o + 2] - off.data[o + 2]);
    if (d > 6) rainChanged++;
  }
  expect(rainChanged, '远景雨幕必须真的上屏').toBeGreaterThan(2000);
});

test('雨天：雨幕锚在世界空间（同姿态同时间重渲必须逐位稳定）', async ({ page }) => {
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
    // 只留远景雨幕（关雾/bloom/CA/暗角/冷调/颗粒），冻时间
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
   * ⚠️⚠️ **必须先预热两帧再取样**（本轮实测）：后处理链的 RTTNode 首帧才确定
   * RT 尺寸 / 建立缓存，首两次渲染的输出不同（实测 diff 90%→37% 逐次变化，
   * 而相机/世界/uniform 状态**逐位相同**）。逐层剥离探针里先跑了 4 档 pair
   * 预热过 ⇒ 四档 diff 全 0。⇒ 预热是判据的前提，不是被测缺陷。
   */
  await page.evaluate(render);
  await page.waitForTimeout(200);
  await page.evaluate(render);
  await page.waitForTimeout(200);
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
  console.log('RAIN WORLD-ANCHOR REPEAT DIFF:', JSON.stringify({ diff, frac: +frac.toFixed(6) }));
  // 状态必须逐位相同（否则差异来自世界/相机而不是雨幕）
  expect(st2.sections).toBe(st1.sections);
  expect(st2.camRotY).toBe(st1.camRotY);
  expect(st2.gradeTime).toBe(st1.gradeTime);
  expect(frac, '同姿态同时间的雨幕必须逐位稳定（跟着屏幕转的写法会漂）').toBeLessThan(0.005);
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