// tracer-water-occlusion.spec.mjs — 曳光与海面的遮挡关系（v2.3，用户 2026-10-28 报告）
//
// 用户：「枪械的曳光效果被水面所遮挡，当我在岸上朝着水里射击时，曳光线被波纹水面所遮挡。
// 这是不对的，只有当曳光线入水后，才被水面所遮挡，这才对。」
//
// ## 根因（实测）
//
// 曳光与海面都在 transparent 队列、原先**都不写深度**，而海面 `renderOrder = 1` 排在曳光
// （默认 0）之后：
//   ① 曳光先画，`depthWrite:false` → 深度缓冲里没有它；
//   ② 海面后画，深度测试通过（缓冲里对这块水面没有任何东西）→ **无条件混合覆盖到曳光之上**。
// 所以不只「入水后被挡」——**水面上方的曳光同样被整片盖掉**。
//
// 受控 A/B（同机位，曳光固定在水面上方 3 格 / 下方 3.5 格，两配置交替各 3 轮，可见像素）：
// | 配置 | 水面上方 | 水面下方 |
// |---|---|---|
// | 修前（海面不写深度、曳光先画） | 1544 / 1544 / 1544 | 3134 / 3134 / 3135 |
// | 修后（海面写深度、曳光后画 + 深度测试） | 3528 / 3528 / 3528 | **0 / 0 / 0** |
//
// ## 修法（两个文件，缺一不可）
//
//   · `ocean.js`：`waterMaterial.depthWrite = true`
//   · `tracer-renderer.js`：`mesh.renderOrder = 2`（排在体素水 0 / 海面 1 之后）
//
// ## 判据设计
//
// 用「同状态开/关曳光的两张截图做差」量曳光的可见像素 —— 这是唯一可靠的量法：
// 直接数「黄色像素」会被天空/沙地/水色干扰（实测背景里就有 553 个黄像素）。
// 两种几何（水面之上 / 水面之下）必须在**同一帧冻结状态**下测，且交替顺序，
// 否则相机/波纹/日夜的漂移会混进读数。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

const shot = async (page) => PNG.sync.read(await page.screenshot());

/** 两张截图的差异像素数（逐通道差之和 > 10 记作变化）—— 即「曳光贡献了多少可见像素」 */
function tracerPixels(on, off) {
  let n = 0;
  for (let i = 0; i < on.width * on.height; i++) {
    const o = i * 4;
    const d = Math.abs(on.data[o] - off.data[o])
      + Math.abs(on.data[o + 1] - off.data[o + 1])
      + Math.abs(on.data[o + 2] - off.data[o + 2]);
    if (d > 10) n++;
  }
  return n;
}

test('v2.3：曳光只在水下被水面遮挡，水面之上的部分必须可见', async ({ page }) => {
  test.setTimeout(300_000);
  // vd=6 够看到 60 格内的水面；weather=clear 排除雨幕对透明队列的干扰
  await page.goto('/?vd=6&seed=12345&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });

  // 深海中央（h < -6）：视野里绝大部分是海面平面
  const sea = await page.evaluate(async () => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const g = window.__MC_GAME__;
    let best = null;
    for (let x = -700; x <= -400; x += 8) {
      for (let z = -700; z <= -400; z += 8) {
        const h = generateHeight(x, z, g.seed);
        if (h < -6 && (!best || h < best.h)) best = { x, z, h };
      }
    }
    return best;
  });
  expect(sea, '必须能找到深海（否则视野里没有海面，用例失去判别力）').not.toBeNull();

  // 站到水面上方 4 格、俯视 35°：水面占满画面下半部，曳光在水面屏幕足迹内
  await page.evaluate(({ x, z }) => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    // 冻结物理（不冻的话玩家下坠 → 两帧间相机位移让差分完全失真）
    g.player.physics.step = () => {};
    g.player.physics.pos.x = x + 0.5;
    g.player.physics.pos.z = z + 0.5;
    g.player.physics.pos.y = 2.5;
    window.__PIN__ = setInterval(() => { g.player.physics.pos.y = 2.5; }, 50);
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
    g.player.yaw = 0.7;
    g.player.pitch = -0.62;
  }, sea);
  await page.waitForTimeout(12_000);   // 等流式加载补齐 + 相机跟上
  // ⚠️ 必须在相机跟上之后再冻 `ocean.update`（提前冻会让平面留在旧位置 → 画面里没有海面）
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.ocean.update = () => {};   // 冻波纹动画 + 平面跟随
    g.dayNight.update = () => {}; // 冻日夜（否则天空在水里反射/雾色都会漂）
  });
  await page.waitForTimeout(1200);

  const clearTracer = async () => {
    await page.evaluate(() => {
      const tr = window.__MC_GAME__.tracerRenderer;
      tr._slots.fill(null);
      tr._activeOrder.length = 0;
      tr._freeSlots.length = 0;
      for (let i = tr.maxActive - 1; i >= 0; i--) tr._freeSlots.push(i);
      tr.mesh.visible = false;
    });
    await page.waitForTimeout(400);
  };

  /** 沿水平视线方向放一条 24 格长的曳光，高度固定为 `y`（世界坐标） */
  const spawnTracer = async (y) => {
    await page.evaluate((y) => {
      const g = window.__MC_GAME__;
      const D = g.camera.position.constructor;
      const cam = g.camera;
      const dir = new D();
      cam.getWorldDirection(dir);
      const hl = Math.hypot(dir.x, dir.z) || 1;
      const fx = dir.x / hl, fz = dir.z / hl;
      const a = [cam.position.x + fx * 6, y, cam.position.z + fz * 6];
      const b = [cam.position.x + fx * 30, y, cam.position.z + fz * 30];
      const tr = g.tracerRenderer;
      tr._slots.fill(null);
      tr._activeOrder.length = 0;
      tr._freeSlots.length = 0;
      for (let i = tr.maxActive - 1; i >= 0; i--) tr._freeSlots.push(i);
      tr.spawn({ start: a, end: b, tracer: { color: 0xffffff, thickness: 6, lifetime: 100 } });
      tr.mesh.visible = true;
    }, y);
    await page.waitForTimeout(400);
  };

  const measure = async (y) => {
    await clearTracer();
    const off = await shot(page);
    await spawnTracer(y);
    const on = await shot(page);
    await clearTracer();
    return tracerPixels(on, off);
  };

  // ---- 先确认渲染契约（便宜、失败信息直接指向根因）----
  const cfg = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      oceanDepthWrite: g.ocean.plane.material.depthWrite,
      oceanRenderOrder: g.ocean.plane.renderOrder,
      tracerRenderOrder: g.tracerRenderer.mesh.renderOrder,
      waterY: g.ocean.plane.position.y,
    };
  });
  expect(cfg.oceanDepthWrite, '海面必须写深度（否则后画的曳光/水面互相穿帮）').toBe(true);
  expect(cfg.tracerRenderOrder, '曳光必须排在体素水(0)与海面(1)之后')
    .toBeGreaterThan(cfg.oceanRenderOrder);

  // ---- 判别力：噪声底必须为 0（五变量都冻住了）----
  await clearTracer();
  const n1 = await shot(page);
  await page.waitForTimeout(500);
  const n2 = await shot(page);
  const noise = tracerPixels(n1, n2);
  // 实测冻结干净后为 0；放宽到 200 只因 GPU/合成器极偶发的单行抖动，仍远小于信号（数千 px）
  expect(noise, `噪声底必须接近 0（否则下面的差分测的不是曳光），实测 ${noise}`).toBeLessThan(200);

  // ---- 主判据：水面上方必须可见（修复前 1544，修复后 3528）----
  const waterY = cfg.waterY;                       // -1.5
  const above = await measure(waterY + 3);         // 水面上方 3 格
  expect(above, `水面之上的曳光必须完整可见（修复前被海面盖掉一半：1544 vs 3528），实测 ${above}`)
    .toBeGreaterThan(2500);

  // ---- 主判据：水下必须被挡住（修复前 3134，修复后 0）----
  const below = await measure(waterY - 3.5);       // 水下 3.5 格
  expect(below, `入水后的曳光必须被水面遮挡（修复前透出来 3134 px），实测 ${below}`)
    .toBeLessThan(200);

  // ---- 上一条不能靠「曳光根本没画」通过：上方可见量必须是水下量的 10 倍以上 ----
  expect(above / Math.max(1, below), '水面之上的曳光必须显著多于水下（同一被测对象的两侧对照）')
    .toBeGreaterThan(10);

  console.log('TRACER OCCLUSION: ' + JSON.stringify({
    above, below, noise,
    oceanDepthWrite: cfg.oceanDepthWrite, tracerRenderOrder: cfg.tracerRenderOrder,
  }));
});
