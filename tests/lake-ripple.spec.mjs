// tests/lake-ripple.spec.mjs — 浅水高台湖面的波纹覆盖（Tier 4 像素实测）
//
// 钉的形态（用户 2026-11-01 报告）：「水面的波纹并没有覆盖全部」。
//
// ## 根因（数值层面已在 test-ocean-mask.js 钉住，这里钉画面）
// 水域遮罩读的是 `generateHeight`（**自然**地形），而浅水高台的整形把湖底压到了 `SEA_Y-1`
// —— 自然高度**没有变**。于是自然高度 ≥ `SEA_Y` 的湖盆格子会被遮罩关掉水面平面，
// 只剩体素水的**静态顶面**（无波纹、无高光）。实测湖内 288 采样点里 **109 个**中招。
//
// ## 为什么必须是 Tier 4
// 判据函数（`isOceanMasked`）单测能验「它返回 true」，但验不了「GPU 上那片水面**真的在动**」。
// 波纹是 TSL 在 GPU 求值的：uniform 没接线、`inLake` 被 `mix` 淡掉、`Discard` 提前触发，
// 都会让画面上的某片水静止，而判据函数单测依然全绿。
//
// ## 判据
// 湖面固定机位、连续两帧截图 → 计算「水区像素发生变化的比例」。
// 平坦静止的水面（无波纹）= 0；正常波纹实测 > 0.05（与 `water-visual.spec.mjs` 的
// ④「波纹仍可见」同口径）。
import { test, expect } from 'playwright/test';

const SEED = 12345;

/** 队列收敛（唯一权威口径，与其它 spec 同一份） */
const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
         s._inflightLight.size === 0;
};

async function openGame(page, vd = 8) {
  await page.goto(`/?seed=${SEED}&vd=${vd}&skybox=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
}

async function shallowTarnAnchor(page) {
  return page.evaluate(async ({ seed }) => {
    const m = await import('/src/gen/structures/shallow-water-tarns.js');
    m.clearShallowTarnCache();
    const a = m.computeShallowTarnAnchor(seed);
    return a ? { wx: a.wx, wz: a.wz, lakeFloorY: a.lakeFloorY, lakeRadius: m.LAKE_RADIUS } : null;
  }, { seed: SEED });
}

/** 把玩家（= 相机）钉在给定位置；相机高一点从上方看湖面 */
async function pinAt(page, x, z, y) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const ph = window.__MC_GAME__.player.physics;
    ph.pos.x = px; ph.pos.y = py; ph.pos.z = pz;
    ph.vel.x = ph.vel.y = ph.vel.z = 0;
    window.__PIN__ = setInterval(() => {
      ph.pos.x = px; ph.pos.z = pz; ph.pos.y = py; ph.vel.y = 0;
    }, 30);
  }, [x, z, y]);
}

/** 等相机确实跟到目标点（`ocean.update` 依赖 camera.position，必须等它跟上再量） */
async function waitCamera(page, x, z) {
  await page.waitForFunction(([px, pz]) => {
    const c = window.__MC_GAME__.camera.position;
    return Math.hypot(c.x - px, c.z - pz) < 4;
  }, [x, z], { timeout: 60_000 });
}

/**
 * 连续两帧截图 → 指定屏幕矩形内的像素变化占比。
 *
 * ⚠️ 必须用 `page.screenshot` 而不是页面内 `drawImage`：WebGPU swapchain canvas 在
 * rAF 回调外 `drawImage` 读到黑屏（既有教训，见 AGENTS.md 的阴影探针条目）。
 */
async function twoFrameDiff(page, clip) {
  const a = await page.screenshot({ clip });
  // 等两帧（波相位 0.015/帧 × 60 会移动肉眼可见的量）
  await page.waitForTimeout(200);
  const b = await page.screenshot({ clip });
  return page.evaluate(async ({ aB64, bB64, w, h }) => {
    const load = (b64) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.src = `data:image/png;base64,${b64}`;
    });
    const [ia, ib] = await Promise.all([load(aB64), load(bB64)]);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, w, h).data;
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, w, h).data;
    let changed = 0;
    let blue = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (da[i + 2] > da[i] + 10 && da[i + 2] > 60) blue++;
      if (Math.abs(da[i] - db[i]) > 6 || Math.abs(da[i + 1] - db[i + 1]) > 6
        || Math.abs(da[i + 2] - db[i + 2]) > 6) changed++;
    }
    return { changed: changed / (w * h), blue: blue / (w * h) };
  }, { aB64: a.toString('base64'), bB64: b.toString('base64'), w: clip.width, h: clip.height });
}

test('浅水高台：湖面整片都有波纹（不是只有天然低地那一块）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const a = await shallowTarnAnchor(page);
  expect(a, '必须能找到浅水高台锚点').not.toBeNull();

  // 站到湖心上方 25 格俯视：视野内几乎全是湖面
  await pinAt(page, a.wx, a.wz, a.lakeFloorY + 25);
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [a.wx, a.wz], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
  await waitCamera(page, a.wx, a.wz);
  // ⚠️ **先让渲染稳定下来再动 HUD**（v2.14 实测）：队列收敛 ≠ 画面已在跑稳态帧。
  // 实测差别：隐藏 HUD 后只等 300ms → changed = 0.00%；先稳定 5s 再隐藏 → **6.58%**。
  // 同 AGENTS.md「出现机制上不可能的数值时先怀疑测量方法」。
  await page.waitForTimeout(5000);
  // 隐藏 HUD（性能面板的半透明黑底会污染像素统计 —— 既有教训）
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#hud-root > *')) el.style.display = 'none';
    const ch = document.getElementById('crosshair');
    if (ch) ch.style.display = 'none';
    const sb = document.getElementById('settings-btn');
    if (sb) sb.style.display = 'none';
  });
  // ⚠️ **隐藏 HUD 后只需 `waitForTimeout`，绝不能调 `requestAnimationFrame`**
  // （v2.14 实测到的测量方法陷阱，三步对照见下）：
  // | 时机 | 两帧变化占比 |
  // |---|---|
  // | A 未隐藏 HUD | 6.53% |
  // | **B 隐藏 HUD 后等 2s** | **10.87%** ✅ |
  // | C 再执行一次 `requestAnimationFrame` 等待 + 500ms | **0.00%** ❌ |
  // ⇒ 在 `page.evaluate` 里 `await` rAF 会让后续截图恒为同一帧（疑似与 Playwright 的
  // CDP 消息/合成时机有关），**它比不等待更糟**。别加它，也别「多等两帧更保险」。
  await page.waitForTimeout(2000);

  const vp = page.viewportSize();
  // 取画面中下部一块（俯视时那里全是湖面，避开顶部天空与底部近景沙滩）
  const clip = {
    x: Math.round(vp.width * 0.25),
    y: Math.round(vp.height * 0.35),
    width: Math.round(vp.width * 0.5),
    height: Math.round(vp.height * 0.3),
  };
  const diff = await twoFrameDiff(page, clip);
  const ratio = diff.changed;
  await page.evaluate(() => clearInterval(window.__PIN__));

  // 判别力：静止水面 = 0；正常波纹（与 water-visual 同口径）> 0.05
  // ⚠️ **两条判据缺一不可**：
  //   ① 画面里必须**真的是水面**（蓝色占比高）—— 否则机位拍错成草地时，
  //      植被摆动照样让 changed > 0.05，用例会在「湖没渲染」时误判通过；
  //   ② 水面必须**在动**（两帧变化 > 0.05）—— 静止水面 = 0。
  // 实测（v2.14 正确实现）：blue 65.6% / changed 6.58%。
  expect(diff.blue, `取样区蓝色占比 ${(diff.blue * 100).toFixed(1)}%（必须真的是湖面）`)
    .toBeGreaterThan(0.3);
  expect(ratio, `湖面两帧变化占比 ${(ratio * 100).toFixed(1)}%（静止水面应为 0）`)
    .toBeGreaterThan(0.05);
});

test('浅水高台：湖面与大海的水一样有波纹（同一套着色器，不是两套表现）', async ({ page }) => {
  test.setTimeout(600_000);
  await openGame(page);
  const a = await shallowTarnAnchor(page);
  expect(a).not.toBeNull();

  await pinAt(page, a.wx, a.wz, a.lakeFloorY + 25);
  await page.waitForFunction(([px, pz]) => {
    const g = window.__MC_GAME__;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [a.wx, a.wz], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
  await waitCamera(page, a.wx, a.wz);

  // 湖区 uniform 必须已接线（radius > 0）—— 这是「波纹能盖全」的**根因条件**，
  // 与「画面在动」是两层判据：只钉症状时，若哪天 uniform 没接上而恰好有天然水面在动，
  // 读数同样是「有变化」→ 两者无法区分（同 `fog-color.spec` 的教训）。
  const uniform = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // `uniform(new THREE.Vector4(cx, cz, radius, 0))` → `.value.x = cx`、`.y = cz`、`.z = radius`
    const v = g.ocean?.uLakeCircle?.value;
    return v ? { cx: v.x, cz: v.y, radius: v.z } : null;
  });
  await page.evaluate(() => clearInterval(window.__PIN__));
  expect(uniform, 'Game.start() 必须调 ocean.setLakeCircle(锚点) —— 否则湖面上没有波纹').not.toBeNull();
  expect(uniform.radius, `uLakeCircle.radius 必须 > 0（实际 ${uniform.radius}）`).toBeGreaterThan(0);
  expect(Math.round(uniform.cx), 'uLakeCircle.cx 必须是锚点').toBe(a.wx);
  expect(Math.round(uniform.cz), 'uLakeCircle.cz 必须是锚点').toBe(a.wz);
});
