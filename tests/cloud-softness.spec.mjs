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
 * @param {{dx:number, atY:number}} cam dx = 板中心相对 ox 的偏移；atY = 采样面世界 y 相对 P
 */
async function sample(page, geo, cam) {
  await page.evaluate(({ ox, oz, P, cam }) => {
    const g = window.__MC_GAME__;
    // ⚠️ 必须避开 lookAt 退化（正下方/正上方时 up 与视线平行）
    g.camera.up.set(0, 0, -1);
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
    'const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloor), cloudT);',
    'const sunTermSoft = sunTerm.add(uCloudSunFloor.mul(cloudT).mul(0.3));',
  ));
  await page.goto(URL);
  await waitWorldSettled(page);
  const code = await browserCode(page, '/src/render/materials.js');
  expect(code.includes('sunTerm.add(uCloudSunFloor.mul(cloudT).mul(0.3))'),
    '注入须真的落地').toBe(true);
  expect(code.includes('const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloor), cloudT);'),
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
