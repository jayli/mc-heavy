import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * Tier 4：云方块半透光观感（v3.50）—— 「云的暗面不再死暗，而亮面逐位不动」的像素级验收。
 *
 * 设计稿：docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md §6.3
 *
 * ## 用户报告的观感问题
 *
 * 「云方块是完全不透明的……我希望给云方块增加一些半透光的光影效果，这样显得云方块
 *   组成的云朵不会这么硬（像飘在空中的石头方块一样）。」
 *
 * 云贴图实测是 64×64 **全 255 纯白零细节** ⇒ 立体感 100% 来自与石头共用的着色公式。
 * 修法 = 给三个致暗因子（AO / 半球 / 太阳项）各加一个地板，用 `max(原值, 地板)`。
 *
 * ## 隔离场景（夹具口径**照抄 tests/hemisphere-ambient.spec.mjs**，不重造）
 *
 * 两块**同尺寸悬空厚板**（13×13×2，y = P..P+1），一块 cloud、一块 stone，水平错开 20 格。
 * ⇒ 同机位同法线下「云 vs 石头」是**单变量对照**。
 * ⚠️ 这一点是必需的：`wet-surface.spec` 记过「不同法线下 N·L 会造出亮度差，
 *    即使材质分类完全退化也能全绿」那个盲区。
 *
 * 唯一变量 = `uCloudSoften` 0↔1（0 = 逐位回到 v3.49）。
 *
 * ## 判据（四条同时成立，缺一条就有恒真路径）
 *
 *   ① 云底面显著变亮 —— 只判这条会被「整体提亮」蒙过；
 *   ② **云顶面逐位不变** —— 正向对照：改系数 / wrap lighting / 加法都会让它变；
 *   ③ **石头板顶底都逐位不变** —— 证明 bit19 没误置到整个 opaque 通道；
 *   ④ sanity floor：四支读数都是几何（不是黑屏），且云顶 ≠ 云底。
 *
 * ⚠️⚠️ **sanity floor 的上界不能照抄 hemisphere-ambient 的 185**（本轮实测踩到）：
 *    那个 spec 用 stone（顶面 151），而**云顶面实测 227，比天空 192 还亮**
 *    ⇒ 「<185」对云在结构上不可能成立。正解：
 *      · 四支都有下界 >20（防黑屏）；
 *      · **石头**两支 <185（天空上界对 stone 成立）；
 *      · 云顶读数须 ≈ CPU 预测的 **226（±12）** —— 天空是 192，差 34，
 *        故这条能区分「取到云」与「取到天空」，比一个拍出来的上界更有判别力。
 *
 * ⚠️ **光源必须手动摆到被测物上方**（同 hemisphere-ambient）：`_updateSunPosition()`
 *    把阴影相机居中到**玩家**（±96），而本板在 P=80、玩家在 y≈22 ⇒ 板在阴影视锥外。
 * ⚠️ **隐藏全部 HUD**：perf-hud 的半透明黑底会造出跟随屏幕的假暗区。
 * ⚠️ **取样点由真实 camera.project 算**，不写死屏幕坐标（wet-surface 那轮实测过写死会取到天空）。
 */

const URL = '/?vd=4&seed=12345&style=noon&weather=clear';

/** 区域平均亮度（照 tests/hemisphere-ambient.spec.mjs 的 regionLuma，三通道均值） */
function regionLuma(png, cx, cy, r) {
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
      const o = (y * png.width + x) * 4;
      sum += (png.data[o] + png.data[o + 1] + png.data[o + 2]) / 3;
      n++;
    }
  }
  return n ? sum / n : NaN;
}

async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections && s.genInflight === 0 && s.meshInflight === 0 &&
      s.meshQueued === 0 && s.pendingMesh === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/** 两块厚板的中心 x 偏移（cloud 在原点、stone 东移 20 格）—— 互不遮挡 */
const STONE_DX = 20;
const P = 80;

/** 造两块悬空厚板并清掉上方一切（云/空岛/建筑），返回两块板的中心 */
async function buildSlabs(page) {
  const geo = await page.evaluate(({ P, STONE_DX }) => {
    const g = window.__MC_GAME__;
    const ox = Math.floor(g.player.physics.pos.x), oz = Math.floor(g.player.physics.pos.z);
    const cloud = g.registry.idOf('cloud');
    const stone = g.registry.idOf('stone');
    const changes = [];
    // 清空两板占地区域的上方与下方（板必须悬空，底面才可见）
    for (let y = P - 12; y <= P + 30; y++) {
      for (let dx = -10; dx <= STONE_DX + 10; dx++) {
        for (let dz = -10; dz <= 10; dz++) {
          const x = ox + dx, z = oz + dz;
          if (g.world.getBlockId(x, y, z) !== 0) changes.push({ x, y, z, id: 0 });
        }
      }
    }
    // 两块 13×13×2 厚板（顶面朝上、底面朝下，各自同材质）
    for (const [cx, id] of [[ox, cloud], [ox + STONE_DX, stone]]) {
      for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
          for (let dy = 0; dy <= 1; dy++) {
            changes.push({ x: cx + dx, y: P + dy, z: oz + dz, id });
          }
        }
      }
    }
    g.editor.setBlocks(changes);
    return { ox, oz };
  }, { P, STONE_DX });
  await waitWorldSettled(page);
  // 光源摆到两板中间上方（阴影相机视锥要覆盖它们）
  await page.evaluate(({ ox, oz, P, STONE_DX }) => {
    const g = window.__MC_GAME__;
    const dir = g.dayNight.params.sunDirection;
    const mx = ox + STONE_DX / 2 + 0.5;
    g.sunLight.position.set(mx + dir[0] * 60, P + dir[1] * 60, oz + 0.5 + dir[2] * 60);
    g.sunLight.target.position.set(mx, P + 1, oz + 0.5);
    g.sunLight.target.updateMatrixWorld();
    g.sunLight.shadow.needsUpdate = true;
    g.pushModal('tier4-cloud-softness');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  }, { ...geo, P, STONE_DX });
  await waitWorldSettled(page);
  await page.waitForTimeout(800);
  return geo;
}

/**
 * 取一个机位下一块板的采样点亮度。
 * @param {{dx:number, atY:number, up?:number[]}} cam dx = 板中心相对 ox 的偏移；atY = 采样面世界 y 相对 P
 *   ⚠️ v3.52：`up` 可选。既有四个机位是俯/仰视（视线近垂直）⇒ up 必须 (0,0,-1) 避 lookAt 退化；
 *   新增的**侧面机位是水平视线** ⇒ up 必须 (0,1,0)，否则 up 与视线平行同样退化。
 *   缺省仍 (0,0,-1) ⇒ 既有四机位逐位不变。
 */
async function sample(page, geo, cam) {
  await page.evaluate(({ ox, oz, P, cam }) => {
    const g = window.__MC_GAME__;
    // ⚠️ 必须避开 lookAt 退化（正下方/正上方时 up 与视线平行）
    const up = cam.up || [0, 0, -1];
    g.camera.up.set(up[0], up[1], up[2]);
    g.camera.position.set(ox + cam.dx + 0.5, P + cam.pos[1], oz + 0.5);
    g.camera.lookAt(ox + cam.dx + 0.5, P + cam.atY, oz + 0.5);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    g.renderer.render(g.scene, g.camera);
  }, { ...geo, P, cam });
  await page.waitForTimeout(400);
  const png = PNG.sync.read(await page.screenshot());
  const pt = await page.evaluate(({ ox, oz, P, cam }) => {
    const g = window.__MC_GAME__;
    const v = new (g.camera.position.constructor)(ox + cam.dx + 0.5, P + cam.atY, oz + 0.5);
    v.project(g.camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
    };
  }, { ...geo, P, cam });
  return regionLuma(png, pt.x, pt.y, 6);
}

/**
 * 取一个机位下**指定世界点**的采样亮度（取样点与机位解耦）。
 *
 * ⚠️ v3.52：侧面机位不能沿用 `sample()` —— 它把相机放在目标正下/正上方，
 * 水平视线看侧面时那个布局只能看到底面。故把「相机位」与「取样点」拆开。
 * 取样点仍由**真实 `camera.project`** 算（不写死屏幕坐标 —— wet-surface 那轮实测过写死会取到天空）。
 *
 * @param {{pos:number[], at:number[], up?:number[]}} cam pos/at 均为相对 (ox, P, oz) 的偏移
 * @param {{dx:number, y:number, dz:number}} target 取样点（相对 ox / P / oz）
 */
async function sampleAt(page, geo, cam, target) {
  await page.evaluate(({ ox, oz, P, cam }) => {
    const g = window.__MC_GAME__;
    const up = cam.up || [0, 1, 0];
    g.camera.up.set(up[0], up[1], up[2]);
    g.camera.position.set(ox + cam.pos[0], P + cam.pos[1], oz + cam.pos[2]);
    g.camera.lookAt(ox + cam.at[0], P + cam.at[1], oz + cam.at[2]);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    g.renderer.render(g.scene, g.camera);
  }, { ...geo, P, cam });
  await page.waitForTimeout(400);
  const png = PNG.sync.read(await page.screenshot());
  const pt = await page.evaluate(({ ox, oz, P, target }) => {
    const g = window.__MC_GAME__;
    const v = new (g.camera.position.constructor)(ox + target.dx, P + target.y, oz + target.dz);
    v.project(g.camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      inFront: v.z < 1,
    };
  }, { ...geo, P, target });
  return { luma: regionLuma(png, pt.x, pt.y, 4), pt };
}

// 四个机位：俯视顶面（相机在板上方 14 格）/ 仰视底面（下方 10 格）
const CAMS = {
  topCloud: { dx: 0, pos: [0, 14, 0], atY: 2 },
  botCloud: { dx: 0, pos: [0, -10, 0], atY: 0 },
  topStone: { dx: STONE_DX, pos: [0, 14, 0], atY: 2 },
  botStone: { dx: STONE_DX, pos: [0, -10, 0], atY: 0 },
};

const setSoften = (page, v) => page.evaluate((v) => {
  const g = window.__MC_GAME__;
  g.renderWorld.materials.cloud.uCloudSoften.value = v;
}, v);

/** 一轮四机位采样 */
async function grabAll(page, geo) {
  const out = {};
  for (const [k, cam] of Object.entries(CAMS)) out[k] = await sample(page, geo, cam);
  return out;
}

test('云柔和化：云底面变亮、云顶面与石头板逐位不动', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(URL);
  await waitWorldSettled(page);
  const geo = await buildSlabs(page);
  /**
   * ⚠️⚠️ **v3.52：本用例必须把面间对比钉死在 0**（单变量隔离）。
   * 本轮新增的 `uCloudFaceContrast` 常开（初值 1）会把底面再乘 0.72
   * ⇒ 不钉住的话本用例的 A/B 混进**两个**变量，读数从 v3.50 记录的 145→195
   * 漂到 **121→174**（已实测）。钉 0 后回到纯粋的 v3.50 语义，阈值一个不改。
   * 面间对比自己的判据在下一个用例（它钉 uCloudSoften=1、只切 contrast）。
   */
  await setContrast(page, 0);

  // 三个地板 uniform 的实际值（阈值可疑时先查它们，而不是降阈值）
  const uniforms = await page.evaluate(() => {
    const u = window.__MC_GAME__.renderWorld.materials.cloud;
    return {
      soften: u.uCloudSoften.value,
      sunFloor: u.uCloudSunFloor.value,
      hemiFloor: u.uCloudHemiFloor.value,
      aoFloor: u.uCloudAoFloor.value,
    };
  });

  await setSoften(page, 0);
  const off = await grabAll(page, geo);
  await setSoften(page, 1);
  const on = await grabAll(page, geo);

  const r = {
    topCloudOff: +off.topCloud.toFixed(1), topCloudOn: +on.topCloud.toFixed(1),
    botCloudOff: +off.botCloud.toFixed(1), botCloudOn: +on.botCloud.toFixed(1),
    topStoneOff: +off.topStone.toFixed(1), topStoneOn: +on.topStone.toFixed(1),
    botStoneOff: +off.botStone.toFixed(1), botStoneOn: +on.botStone.toFixed(1),
    botCloudRatio: +(on.botCloud / off.botCloud).toFixed(4),
    topCloudRatio: +(on.topCloud / off.topCloud).toFixed(4),
    uniforms,
  };
  console.log('CLOUD-SOFTNESS:', JSON.stringify(r));

  // ---- ④ sanity floor：四支读数都是几何，且云顶 ≠ 云底 ----
  for (const [k, v] of Object.entries({
    topCloudOff: off.topCloud, botCloudOff: off.botCloud,
    topStoneOff: off.topStone, botStoneOff: off.botStone,
  })) {
    expect(v, `${k} 读数须为几何（不是黑屏）：${v.toFixed(1)}`).toBeGreaterThan(20);
  }
  // 石头两支：天空上界对 stone 成立（顶面 CPU 预测 151）
  expect(off.topStone, `石顶读数不得到天空亮度：${off.topStone.toFixed(1)}`).toBeLessThan(185);
  expect(off.botStone, `石底读数不得到天空亮度：${off.botStone.toFixed(1)}`).toBeLessThan(185);
  /**
   * 云顶：不能用「<185」（云比天空亮）。改用**CPU 预测值 226 ±12**：
   * 天空实测 192，与 226 差 34 ⇒ 取到天空会落在区间外。
   * 预测来源：tex=255（cloud 贴图实测全 255）× shade 1.0 → ACES → sRGB = 226。
   */
  expect(Math.abs(off.topCloud - 226),
    `云顶读数须 ≈ CPU 预测 226（±12）—— 取到天空（192）会越线：实测 ${off.topCloud.toFixed(1)}`)
    .toBeLessThan(12);
  expect(Math.abs(off.topCloud - off.botCloud),
    `云顶与云底读数须不同（证明采到了两个面）：${JSON.stringify(r)}`)
    .toBeGreaterThan(5);

  // ---- ① 云底面显著变亮（实测 1.3448，CPU 预测 1.3379）----
  expect(on.botCloud / off.botCloud,
    `云底面须显著变亮（实测比值 ${(on.botCloud / off.botCloud).toFixed(4)}）：${JSON.stringify(r)}`)
    .toBeGreaterThan(1.25);

  // ---- ② 云顶面逐位不变（正向对照：证明不是整体提亮）----
  expect(on.topCloud / off.topCloud,
    `云顶面须逐位不变（max 对亮面恒等）：${JSON.stringify(r)}`)
    .toBeGreaterThan(0.99);
  expect(on.topCloud / off.topCloud).toBeLessThan(1.01);

  // ---- ③ 石头板顶底都逐位不变（bit19 没误置到整个通道）----
  expect(Math.abs(on.topStone - off.topStone),
    `石顶须逐位不变：${JSON.stringify(r)}`).toBeLessThan(1.0);
  expect(Math.abs(on.botStone - off.botStone),
    `石底须逐位不变：${JSON.stringify(r)}`).toBeLessThan(1.0);

  expect(errs, '不得有 console 错误').toEqual([]);
});
/**
 * 注册模块内容替换（**必须在 goto 之前调**，否则注入静默失效）。
 * 照 tests/wet-surface.spec.mjs 的 routeModule：模式未命中就 throw，
 * 防「注入没落地却全绿」那类假绿（testing-policy §2.7）。
 */
async function routeModule(page, file, transform) {
  await page.route(`**/${file}*`, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const next = transform(body);
    if (next === body) throw new Error(`[负向对照] ${file} 的注入模式未命中 —— 注入静默失效`);
    await route.fulfill({
      response: res, body: next,
      headers: { ...res.headers(), 'content-type': 'application/javascript' },
    });
  });
}

/** 读回浏览器侧源码的**代码行**（滤掉注释 —— 全文件 includes 会因 jsdoc 恒真） */
async function browserCode(page, path) {
  return page.evaluate(async (p) => {
    const src = await (await fetch(p)).text();
    return src.split('\n')
      .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
      .join('\n');
  }, path);
}

/**
 * 负向①：mesher 不给 cloud 置 bit19 ⇒ **判据①（云底面变亮）必须失效**。
 *
 * ⚠️ **方向**：本用例 PASS 意味着「缺陷被抓到」——
 * 它断言的是「注入后云底面不再变亮」，不是「注入后功能仍正常」。
 * 若注入后云底面照旧变亮，说明判据①对被测机制零判别力（那才是真问题）。
 */
test('负向①：mesher 不给 cloud 置 bit19 ⇒ 云底面变亮判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await routeModule(page, 'mesher.js', (b) => b.replace(
    "const cloudSoftBit = blockName === 'cloud' ? CLOUD_SOFT_BIT : 0;",
    "const cloudSoftBit = false ? CLOUD_SOFT_BIT : 0;",
  ));
  await page.goto(URL);
  await waitWorldSettled(page);
  // v3.52：两条负向验的是 **v3.50 柔和机制**，同样要把面间对比钉 0（单变量）。
  await setContrast(page, 0);
  // 注入生效确认：读回浏览器侧源码（只看代码行）
  const code = await browserCode(page, '/src/mesh/mesher.js');
  expect(code.includes('const cloudSoftBit = false ? CLOUD_SOFT_BIT : 0;'),
    '注入须真的落地').toBe(true);
  expect(code.includes("const cloudSoftBit = blockName === 'cloud' ? CLOUD_SOFT_BIT : 0;"),
    '原写法须已被替换').toBe(false);

  const geo = await buildSlabs(page);
  await setSoften(page, 0);
  const off = await grabAll(page, geo);
  await setSoften(page, 1);
  const on = await grabAll(page, geo);
  const ratio = on.botCloud / off.botCloud;
  console.log('NEG-BIT19:', JSON.stringify({
    botCloudOff: +off.botCloud.toFixed(1), botCloudOn: +on.botCloud.toFixed(1),
    ratio: +ratio.toFixed(4),
  }));
  // 注入后 bit19 恒 0 ⇒ cloudT 恒 0 ⇒ 三个地板全部不生效 ⇒ 云底面不该变亮
  expect(ratio,
    `注入后云底面不该再变亮（实测比值 ${ratio.toFixed(4)}），否则判据①对缺陷零判别力`)
    .toBeLessThan(1.02);
});

/**
 * 负向②：把太阳项的 `max` 换成加法（整体提亮）⇒ **判据②（云顶面不变）必须失效**。
 *
 * 这条证明「云顶面逐位不变」不是恒真判据 —— 改系数 / wrap lighting / 加法
 * 这三类「整体提亮冒充柔和」的实现都会被它抓到。
 */
test('负向②：把 max 换成加法（整体提亮）⇒ 云顶面不变判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await routeModule(page, 'materials.js', (b) => b.replace(
    'const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloorRGB), cloudT);',
    'const sunTermSoft = sunTerm.add(uCloudSunFloorRGB.mul(cloudT).mul(0.3));',
  ));
  await page.goto(URL);
  await waitWorldSettled(page);
  await setContrast(page, 0);   // v3.52：单变量隔离（同负向①）
  const code = await browserCode(page, '/src/render/materials.js');
  expect(code.includes('sunTerm.add(uCloudSunFloorRGB.mul(cloudT).mul(0.3))'),
    '注入须真的落地').toBe(true);
  expect(code.includes('const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloorRGB), cloudT);'),
    '原写法须已被替换').toBe(false);

  const geo = await buildSlabs(page);
  await setSoften(page, 0);
  const off = await grabAll(page, geo);
  await setSoften(page, 1);
  const on = await grabAll(page, geo);
  const topRatio = on.topCloud / off.topCloud;
  console.log('NEG-ADDITIVE:', JSON.stringify({
    topCloudOff: +off.topCloud.toFixed(1), topCloudOn: +on.topCloud.toFixed(1),
    topRatio: +topRatio.toFixed(4),
  }));
  // 加法把顶面也抬 ⇒ 顶面必须变（证明判据②有判别力）
  expect(Math.abs(topRatio - 1),
    `注入后云顶面必须变（实测比值 ${topRatio.toFixed(4)}），否则判据②是恒真判据`)
    .toBeGreaterThan(0.01);
});

// ==================== v3.52：面间明暗分离（侧面 vs 底面）====================
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-side-face-contrast-design.md
//
// 用户报告：「从底向上看云朵，大云岛下方的小云朵模糊不清，因为云朵底色、垂直的面的颜色
// 和背后大云岛的底色完全一样」+ MC 原版参考图（侧面亮带 218 / 云体底面 182 ⇒ 比 1.198）。
//
// 根因是恒等式：CLOUD_HEMI_LIFT=0.50 使半球地板 (1+g)/2 恰等于侧面 hemi 因子，
// 而侧面与底面 N·L 都 ≤0 ⇒ 太阳项同地板 ⇒ 底面与四侧面逐位同色（五档实测比值全 1.000）。
//
// ⚠️ **唯一变量 = uCloudFaceContrast**（不是 uCloudSoften —— 后者 =0 会同时关掉 v3.50 地板）。
// ⚠️ **侧面机位必须水平视线**：sample() 把相机放目标正下/正上方，那样只看得到底面。
//    故用 sampleAt()：相机位与取样点解耦，up=(0,1,0)（水平视线不能用 (0,0,-1)，会 lookAt 退化）。

/** 侧面机位：相机在板西侧 16 格、与板同高，看向板的 −X 侧面中点 */
const SIDE_CAM = { pos: [-16, 1.0, 0.5], at: [0.5, 1.0, 0.5], up: [0, 1, 0] };
const SIDE_TARGET_CLOUD = { dx: -6.0, y: 1.0, dz: 0.5 };
const SIDE_TARGET_STONE = { dx: STONE_DX - 6.0, y: 1.0, dz: 0.5 };
/** 底面机位沿用既有 CAMS.botCloud（相机在板正下方 10 格） */

const setContrast = (page, v) => page.evaluate((v) => {
  const g = window.__MC_GAME__;
  g.renderWorld.materials.cloud.uCloudFaceContrast.value = v;
}, v);

/** 一轮：侧面（cloud/stone）+ 底面（cloud）+ 顶面（cloud） */
async function grabFaces(page, geo) {
  const side = await sampleAt(page, geo, SIDE_CAM, SIDE_TARGET_CLOUD);
  const sideStone = await sampleAt(page, geo,
    { pos: [SIDE_CAM.pos[0] + STONE_DX, SIDE_CAM.pos[1], SIDE_CAM.pos[2]],
      at: [SIDE_CAM.at[0] + STONE_DX, SIDE_CAM.at[1], SIDE_CAM.at[2]], up: SIDE_CAM.up },
    SIDE_TARGET_STONE);
  const bot = await sample(page, geo, CAMS.botCloud);
  const top = await sample(page, geo, CAMS.topCloud);
  const botStone = await sample(page, geo, CAMS.botStone);
  return { side: side.luma, sidePt: side.pt, sideStone: sideStone.luma, sideStonePt: sideStone.pt, bot, top, botStone };
}

test('云面间对比：侧面变亮、底面变暗、侧/底比 ≥1.15、石头板零回归', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 300)));
  await page.goto(URL);
  await waitWorldSettled(page);
  const geo = await buildSlabs(page);

  await setContrast(page, 0);
  const off = await grabFaces(page, geo);
  await setContrast(page, 1);
  const on = await grabFaces(page, geo);

  const r = {
    sideOff: +off.side.toFixed(1), sideOn: +on.side.toFixed(1),
    botOff: +off.bot.toFixed(1), botOn: +on.bot.toFixed(1),
    topOff: +off.top.toFixed(1), topOn: +on.top.toFixed(1),
    sideStoneOff: +off.sideStone.toFixed(1), sideStoneOn: +on.sideStone.toFixed(1),
    botStoneOff: +off.botStone.toFixed(1), botStoneOn: +on.botStone.toFixed(1),
    ratioOff: +(off.side / off.bot).toFixed(4), ratioOn: +(on.side / on.bot).toFixed(4),
    sideRatio: +(on.side / off.side).toFixed(4), botRatio: +(on.bot / off.bot).toFixed(4),
    sidePt: on.sidePt, sideStonePt: on.sideStonePt,
  };
  console.log('CLOUD-FACE-CONTRAST:', JSON.stringify(r));

  // ---- sanity floor（先于一切判据）----
  // ⚠️ **上界是材质相关的**（v3.50 已踩）：云顶 227 比天空 192 还亮，
  //    照搬 stone 的「<185」对云在结构上不可能成立。
  for (const [k, v] of Object.entries({
    sideOff: off.side, botOff: off.bot, topOff: off.top,
    sideStoneOff: off.sideStone, botStoneOff: off.botStone,
  })) {
    expect(v, `${k} 读数须为几何（不是黑屏）：${v.toFixed(1)}`).toBeGreaterThan(20);
  }
  // 石头两支：天空上界对 stone 成立
  expect(off.sideStone, `石侧读数不得到天空亮度：${off.sideStone.toFixed(1)}`).toBeLessThan(185);
  expect(off.botStone, `石底读数不得到天空亮度：${off.botStone.toFixed(1)}`).toBeLessThan(185);
  // 云顶：用 CPU 预测 226 ±12（天空 192，差 34 ⇒ 能区分「取到云」与「取到天空」）
  expect(Math.abs(off.top - 226),
    `云顶读数须 ≈ CPU 预测 226（±12），实测 ${off.top.toFixed(1)}`).toBeLessThan(12);
  // 侧面取样点必须在相机前方且入画（否则量到的是背景）
  expect(on.sidePt.inFront, '侧面取样点须在相机前方').toBe(true);
  expect(on.sidePt.x, '侧面取样点须入画').toBeGreaterThan(0);
  expect(on.sidePt.x).toBeLessThan(960);
  expect(on.sidePt.y).toBeGreaterThan(0);
  expect(on.sidePt.y).toBeLessThan(540);

  // ---- ① 侧面变亮（实测 195 → 211，比 1.0821；CPU 预测 1.0708）----
  // ⚠️ 只判这条会被「整体提亮」蒙过 ⇒ 必须配②底面变暗。
  expect(on.side / off.side,
    `云侧面须变亮（实测比值 ${(on.side / off.side).toFixed(4)}）：${JSON.stringify(r)}`)
    .toBeGreaterThan(1.05);

  // ---- ② 底面变暗（实测 195 → 174，比 0.8923）----
  // 整体提亮会让它上升 ⇒ 真红。这条是「顶底比侧面暗」的直接防线。
  expect(on.bot / off.bot,
    `云底面须变暗（实测比值 ${(on.bot / off.bot).toFixed(4)}）：${JSON.stringify(r)}`)
    .toBeLessThan(0.97);

  // ---- ③ 侧/底比 ≥1.15（用户诉求的直接判据）----
  // 实测 off **1.0000**（恒等式导致的同色）→ on **1.2126**；原版参考 218/182 = 1.198。
  // gain 恒 1 的缺陷态下比值回到 1.000 ⇒ 真红（负向③钉住）。
  expect(on.side / on.bot,
    `侧/底屏幕比须 ≥1.15（原版参考 1.198），实测 ${(on.side / on.bot).toFixed(4)}：${JSON.stringify(r)}`)
    .toBeGreaterThan(1.15);
  // 正向对照：关档时必须真的同色（证明这条判据量的是本轮机制，不是夹具自带的差）
  expect(Math.abs(off.side / off.bot - 1),
    `关档时侧/底须同色（v3.50 恒等式），实测 ${(off.side / off.bot).toFixed(4)}`).toBeLessThan(0.02);

  // ---- ④ 石头板三支逐位不变（gain 没漏到整个 opaque 通道）----
  expect(Math.abs(on.sideStone - off.sideStone),
    `石侧须逐位不变：${JSON.stringify(r)}`).toBeLessThan(1.0);
  expect(Math.abs(on.botStone - off.botStone),
    `石底须逐位不变：${JSON.stringify(r)}`).toBeLessThan(1.0);

  // ---- ⑤ 保色相（灰阶 gain）：底面 R−B 偏移须 <8 灰阶 ----
  // 实测（同一探针、逐通道读数）：noon shift **0** / dusk **−4** / normal **−1**；
  // 而带色偏的 gain（负向④）实测 **54** ⇒ 阈值判别力 13 倍以上。
  // ⚠️ 必须量**逐通道**：regionLuma 是三通道均值，对色相零判别力。
  const hueOff = await readBottomRgb(page, geo, 0);
  const hueOn = await readBottomRgb(page, geo, 1);
  const hueShift = hueOn.rb - hueOff.rb;
  console.log('CLOUD-FACE-HUE:', JSON.stringify({
    offRgb: [hueOff.r, hueOff.g, hueOff.b].map((v) => +v.toFixed(1)),
    onRgb: [hueOn.r, hueOn.g, hueOn.b].map((v) => +v.toFixed(1)),
    shift: +hueShift.toFixed(1),
  }));
  expect(Math.abs(hueShift),
    `底面 R−B 偏移须 <8 灰阶（灰阶 gain 保色相），实测 ${hueShift.toFixed(1)}`).toBeLessThan(8);

  expect(errs, '不得有 console 错误').toEqual([]);
});

/**
 * 读底面中心 9×9 的**逐通道**均值（保色相判据专用）。
 * ⚠️ 不能用 regionLuma：它是三通道均值，对「色相被抹」零判别力。
 */
async function readBottomRgb(page, geo, contrast) {
  await setContrast(page, contrast);
  await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.camera.up.set(0, 0, -1);
    g.camera.position.set(ox + 0.5, P - 10, oz + 0.5);
    g.camera.lookAt(ox + 0.5, P, oz + 0.5);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    g.renderer.render(g.scene, g.camera);
  }, { ...geo, P });
  await page.waitForTimeout(400);
  const png = PNG.sync.read(await page.screenshot());
  const pt = await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    const v = new (g.camera.position.constructor)(ox + 0.5, P, oz + 0.5);
    v.project(g.camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
    };
  }, { ...geo, P });
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = pt.y - 4; y <= pt.y + 4; y++) {
    for (let x = pt.x - 4; x <= pt.x + 4; x++) {
      const o = (y * png.width + x) * 4;
      r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, rb: (r - b) / n };
}

/**
 * 负向③：把面类别 gain 注入成恒 1 ⇒ **判据③（侧/底比 ≥1.15）必须失效**。
 *
 * ⚠️ **方向**：本用例 PASS 意味着「缺陷被抓到」——
 * 它断言的是「注入后侧/底回到同色」，不是「注入后功能仍正常」。
 * 若注入后比值照旧 ≥1.15，说明判据③对被测机制零判别力（那才是真问题）。
 */
test('负向③：gain 恒 1 ⇒ 侧/底比判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  await routeModule(page, 'materials.js', (b) => b.replace(
    'const cloudFaceGain = mix(float(1), cloudFaceK, mul(cloudBit, uCloudFaceContrast));',
    'const cloudFaceGain = float(1);',
  ));
  await page.goto(URL);
  await waitWorldSettled(page);
  const code = await browserCode(page, '/src/render/materials.js');
  expect(code.includes('const cloudFaceGain = float(1);'), '注入须真的落地').toBe(true);
  expect(code.includes('const cloudFaceGain = mix(float(1), cloudFaceK, mul(cloudBit, uCloudFaceContrast));'),
    '原写法须已被替换').toBe(false);

  const geo = await buildSlabs(page);
  await setContrast(page, 1);   // 旋钮满档，但 gain 已被注入成恒 1
  const on = await grabFaces(page, geo);
  const ratio = on.side / on.bot;
  console.log('NEG-GAIN-ONE:', JSON.stringify({
    side: +on.side.toFixed(1), bot: +on.bot.toFixed(1), ratio: +ratio.toFixed(4),
  }));
  expect(ratio,
    `注入后侧/底须回到同色（实测比值 ${ratio.toFixed(4)}），否则判据③对缺陷零判别力`)
    .toBeLessThan(1.02);
});

/**
 * 负向④：把灰阶 gain 换成**逐通道不同值**（带色偏）⇒ **保色相判据必须失效**。
 *
 * 这条证明「灰阶」不是可有可无的实现细节：`sunTermSoft` 是 vec3（含色温），
 * 逐通道 gain 会把云的冷环境色拉走 —— 用户要的是「更白」，不是「换个颜色」。
 * 判据落在**底面 R−B 的偏移**上（亮度判据对此零判别力）。
 */
test('负向④：gain 改成带色偏 ⇒ 保色相判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 960, height: 540 });
  // 注入：gain 从标量变成 vec3（R 抬、B 压）—— shade 乘它后三通道被不等比缩放
  await routeModule(page, 'materials.js', (b) => b.replace(
    'const cloudFaceGain = mix(float(1), cloudFaceK, mul(cloudBit, uCloudFaceContrast));',
    'const cloudFaceGain = mix(vec3(1, 1, 1), vec3(cloudFaceK.mul(1.35), cloudFaceK, cloudFaceK.mul(0.55)), mul(cloudBit, uCloudFaceContrast));',
  ));
  await page.goto(URL);
  await waitWorldSettled(page);
  const code = await browserCode(page, '/src/render/materials.js');
  expect(code.includes('vec3(cloudFaceK.mul(1.35), cloudFaceK, cloudFaceK.mul(0.55))'),
    '注入须真的落地').toBe(true);

  const geo = await buildSlabs(page);
  // 底面取样：用与正向判据⑤**同一个** helper（不留第二份公式）
  const off = await readBottomRgb(page, geo, 0);
  const on = await readBottomRgb(page, geo, 1);
  const shift = on.rb - off.rb;
  console.log('NEG-HUE-SHIFT:', JSON.stringify({
    offRgb: [off.r, off.g, off.b].map((v) => +v.toFixed(1)),
    onRgb: [on.r, on.g, on.b].map((v) => +v.toFixed(1)),
    rbOff: +off.rb.toFixed(1), rbOn: +on.rb.toFixed(1), shift: +shift.toFixed(1),
  }));
  // 带色偏的 gain 必须把 R−B 显著拉走（灰阶实现下该偏移 <8）
  expect(Math.abs(shift),
    `注入后底面 R−B 偏移须 >8 灰阶（实测 ${shift.toFixed(1)}），否则保色相判据零判别力`)
    .toBeGreaterThan(8);
});
