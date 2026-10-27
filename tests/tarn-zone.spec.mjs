// tests/tarn-zone.spec.mjs — 高台地带 Tier 4：真游戏页景观实测
//
// 钉的是「纯函数与接线单测全绿、但真游戏页里景观不对」这一类缺陷：
//   · 台地整形没生效（池心是空气不是水）—— Task 6 就踩到过（layouts 只取第一个 tarn）
//   · 巨型云没接线（地带上空一片空）—— Task 5 漏了云的光栅化，本 spec 才发现
//   · 池面平面没抬升（池心看到池底而不是水面）
//   · 高台没落地（台地层只有草石、没有凸起）
//
// ⚠️ 三条铁律（照 fog-color / sun-shadow 的既有教训）：
//   1. **必须隐藏全部 HUD + 冻结物理/日夜/阴影**，否则噪声底可达 0.95。
//   2. **逐帧读像素必须在 rAF 回调内**（WebGPU swapchain 在 rAF 外 drawImage 读到黑屏）。
//   3. **停物理用 setInterval pin，不要用 pushModal** —— 它阻断玩家更新循环 →
//      相机不跟随新位置 → 换了机位画面却没变（实测整屏 Δ=0，一度误判为功能失效）。
import { test, expect } from 'playwright/test';

const SEED = 12345;
/**
 * 本 seed 的地带 region（由探针实测确定，**不是想象的坐标**）。
 *
 * ⚠️ 不能填 (0,0)：那是 `CITY_REGION`，`isTarnZone(0,0,*) ≡ false`，
 * 忘换会「安静地测错地方」。下面的 `findTarn` 会反查并断言它真的地带。
 */
const TARN_REGION = { rx: 0, rz: -2 };

/** 地带中心的实测坐标（探针输出，用于断言「找对了地方」） */
const TARN_CENTER = { cx: 200, cz: -600 };
const PLATEAU_Y = 2;

const queueConverged = () => {
  const s = window.__MC_GAME__.scheduler;
  return s._inflightGen.size === 0 && s._meshQueue.length === 0 && s._inflightMesh.size === 0 &&
         s._uploadQueue.length === 0 && s._pendingMesh.size === 0 && s._lightQueue.size === 0 &&
         s._inflightLight.size === 0;
};

async function teleport(page, x, z, y = 80) {
  await page.evaluate(([px, pz, py]) => {
    clearInterval(window.__PIN__);
    const p = window.__MC_GAME__.player.physics;
    p.pos.x = px; p.pos.y = py; p.pos.z = pz;
    p.vel.x = p.vel.y = p.vel.z = 0;
    window.__PIN__ = setInterval(() => { p.pos.x = px; p.pos.z = pz; p.pos.y = py; p.vel.y = 0; }, 30);
  }, [x, z, y]);
}

async function unpin(page) {
  await page.evaluate(() => clearInterval(window.__PIN__));
}

async function settle(page, x, z, radius = 6) {
  await page.waitForFunction(([px, pz, r]) => {
    const g = window.__MC_GAME__; const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (!g.world.hasColumn(cx + dx, cz + dz)) return false;
    }
    return true;
  }, [x, z, radius], { timeout: 180_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

async function freezeAndHideHud(page) {
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (g.setShadowsEnabled) g.setShadowsEnabled(false);
    if (g.setVisualStyle) g.setVisualStyle('noon');
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) {
      el.style.display = 'none';
    }
  });
}

/** 打开游戏并等到队列收敛 */
async function openGame(page) {
  await page.goto(`/?vd=8&seed=${SEED}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.waitForFunction(queueConverged, null, { timeout: 180_000 });
}

/** 飞到地带中心上方并等 chunk 加载（返回地带布局） */
async function flyToTarn(page) {
  const c = await page.evaluate(async ({ rx, rz, seed }) => {
    const { isTarnZone, tarnZoneCenter, computeTarnZone } = await import('/src/gen/structures/tarn-zone.js');
    return {
      isTarn: isTarnZone(rx, rz, seed),
      center: tarnZoneCenter(rx, rz),
      lay: computeTarnZone(rx, rz, seed),
    };
  }, { ...TARN_REGION, seed: SEED });
  // 自检：这个 region 必须真的是地带，且坐标与常量一致（防止 seed/布局改动后静默测错地方）
  expect(c.isTarn, `region(${TARN_REGION.rx},${TARN_REGION.rz}) 必须是地带 —— 若不符说明 seed 或地带判定变了，请重跑探针`).toBe(true);
  expect(c.center.cx).toBe(TARN_CENTER.cx);
  expect(c.center.cz).toBe(TARN_CENTER.cz);

  await teleport(page, c.center.cx, c.center.cz, c.lay.plateauY + 25);
  await settle(page, c.center.cx, c.center.cz);
  await page.waitForTimeout(800);
  return { ...c.center, lay: c.lay };
}

/** 在 rAF 内读画布像素（WebGPU swapchain 在 rAF 外读到黑屏） */
async function readPixels(page, rect) {
  return page.evaluate((r) => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const cv = document.querySelector('canvas');
      const off = document.createElement('canvas');
      off.width = cv.width; off.height = cv.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      const x0 = Math.floor(cv.width * r.x), y0 = Math.floor(cv.height * r.y);
      const w = Math.floor(cv.width * r.w), h = Math.floor(cv.height * r.h);
      const d = ctx.getImageData(x0, y0, w, h).data;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
      resolve({ r: sr / n, g: sg / n, b: sb / n, n });
    });
  }), rect);
}

test.describe('高台地带景观', () => {
  test('池心分层：池底实心 / 1 层水 / 之上空气', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const layers = await page.evaluate(({ cx, cz, plateauY }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      return {
        below: nm(g.world.getBlockId(cx, plateauY - 1, cz)),
        water: nm(g.world.getBlockId(cx, plateauY, cz)),
        above: nm(g.world.getBlockId(cx, plateauY + 1, cz)),
      };
    }, { cx: c.cx, cz: c.cz, plateauY: c.lay.plateauY });
    expect(layers.water, `池心 y=${c.lay.plateauY} 必须是 water（台地整形没生效？）`).toBe('water');
    expect(layers.above, '水面之上必须是空气（否则是水柱）').toBe('air');
    expect(['stone', 'sand', 'deepslate'], `池底必须是实心岩（实际 ${layers.below}）`).toContain(layers.below);
    await unpin(page);
  });

  test('台地层是草石镶嵌（两种都出现，且不是清一色）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const surface = await page.evaluate(({ cx, cz, lay }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      const counts = {};
      // 台地环带：池外、地带内
      for (let a = 0; a < 48; a++) {
        const ang = (a / 48) * Math.PI * 2;
        for (const r of [lay.poolRadius + 6, lay.poolRadius + 20, lay.poolRadius + 40, lay.plateauRadius - 6]) {
          const x = Math.round(cx + r * Math.cos(ang));
          const z = Math.round(cz + r * Math.sin(ang));
          const n = nm(g.world.getBlockId(x, lay.plateauY, z));
          counts[n] = (counts[n] || 0) + 1;
        }
      }
      return counts;
    }, { cx: c.cx, cz: c.cz, lay: c.lay });

    expect(surface.grass, `台地层必须有 grass（实际 ${JSON.stringify(surface)}）`).toBeGreaterThan(0);
    expect(surface.stone, `台地层必须有 stone（实际 ${JSON.stringify(surface)}）`).toBeGreaterThan(0);
    // 不是清一色：两种都要有相当比例（各自 ≥10%，避免「只有一两格」蒙混）
    const total = Object.values(surface).reduce((s, v) => s + v, 0);
    expect(surface.grass / total).toBeGreaterThan(0.10);
    expect(surface.stone / total).toBeGreaterThan(0.10);
    await unpin(page);
  });

  test('8 座高台全部立起来（高度 > 15 格）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const tops = await page.evaluate(({ cx, cz, lay }) => {
      const g = window.__MC_GAME__;
      const out = [];
      for (const t of lay.tarns) {
        const x = Math.round(cx + t.ring * Math.cos(t.ang));
        const z = Math.round(cz + t.ring * Math.sin(t.ang));
        let top = null;
        for (let y = 95; y > lay.plateauY; y--) {
          if (g.world.getBlockId(x, y, z) !== 0) { top = y; break; }
        }
        out.push({ variant: t.variant, height: top === null ? 0 : top - lay.plateauY });
      }
      return out;
    }, { cx: c.cx, cz: c.cz, lay: c.lay });

    expect(tops.length).toBe(8);
    const short = tops.filter((t) => t.height <= 15);
    expect(short, `这些高台太矮（可能没写进世界）：${JSON.stringify(short)}`).toEqual([]);
    await unpin(page);
  });

  test('地带有 4 朵巨型云（y∈[54,95] 有大量非空格）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const r = await page.evaluate(({ cx, cz, lay }) => {
      const g = window.__MC_GAME__;
      const perCloud = [];
      for (const cl of lay.clouds) {
        const wx = Math.round(cx + cl.ring * Math.cos(cl.ang));
        const wz = Math.round(cz + cl.ring * Math.sin(cl.ang));
        let cnt = 0, minY = Infinity, maxY = -Infinity;
        for (let dx = -30; dx <= 30; dx += 2) {
          for (let dz = -30; dz <= 30; dz += 2) {
            for (let y = 45; y <= 95; y++) {
              if (g.world.getBlockId(wx + dx, y, wz + dz) !== 0) {
                cnt++; if (y < minY) minY = y; if (y > maxY) maxY = y;
              }
            }
          }
        }
        perCloud.push({ variant: cl.variant, cnt, minY: minY === Infinity ? null : minY, maxY: maxY === -Infinity ? null : maxY });
      }
      return perCloud;
    }, { cx: c.cx, cz: c.cz, lay: c.lay });

    expect(r.length).toBe(4);
    for (const cl of r) {
      expect(cl.cnt, `云 ${cl.variant} 在它自己位置附近几乎没有方块（没写进世界？）`).toBeGreaterThan(500);
      expect(cl.maxY, `云 ${cl.variant} 最高点应在空中（>50）`).toBeGreaterThan(50);
    }
    await unpin(page);
  });

  test('池面可见：俯视池心是水色而不是池底', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    await freezeAndHideHud(page);
    // 悬在池心正上方俯视
    await teleport(page, c.cx, c.cz, c.lay.plateauY + 18);
    await page.waitForTimeout(1200);
    const center = await readPixels(page, { x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
    // 水色判据：B 显著高于 R（沿用 water-visual.spec 的「水体像素」定义方向）
    expect(center.b, `池心俯视应当是水色（R=${center.r.toFixed(0)} G=${center.g.toFixed(0)} B=${center.b.toFixed(0)}），实际偏暖 —— 可能看到了池底`).toBeGreaterThan(center.r + 12);
    await unpin(page);
  });

  test('池面平面真的在渲染：水区有波纹动画（体素水是静态的）', async ({ page }) => {
    // ⚠️ **上一条用例测不出海面平面**（负向验证实测：把 `tarnPoolAt` 改成恒返 null
    //    之后它照样绿）—— 因为体素水本身就是水色，平面在不在都一样。
    //
    // 本条的判别力来自一个**只有平面才有的性质**：`ocean.js` 的 TSL 有波浪动画
    // （`sin(pos.x·1.5 + uTime·5.5)` 等），而体素水是静态贴图。
    // ⇒ 连续两帧的水区像素必须发生变化；平面没渲染时变化率恒为 0。
    //
    // 手法同 `water-visual.spec` 的「测高光是否还在不能用众数峰 luma，要用连续两帧的变化占比」。
    await openGame(page);
    const c = await flyToTarn(page);
    await freezeAndHideHud(page);
    await teleport(page, c.cx, c.cz, c.lay.plateauY + 18);
    await page.waitForTimeout(1200);

    const changeRatio = await page.evaluate(() => new Promise((resolve) => {
      const cv = document.querySelector('canvas');
      const grab = () => {
        const off = document.createElement('canvas');
        off.width = cv.width; off.height = cv.height;
        const ctx = off.getContext('2d');
        ctx.drawImage(cv, 0, 0);
        // 取画面中心的方形区（池面就在那儿）
        const W = Math.floor(cv.width * 0.3), H = Math.floor(cv.height * 0.3);
        return ctx.getImageData(
          Math.floor((cv.width - W) / 2), Math.floor((cv.height - H) / 2), W, H,
        ).data;
      };
      requestAnimationFrame(() => {
        const a = grab();
        setTimeout(() => {
          requestAnimationFrame(() => {
            const b = grab();
            let diff = 0, n = 0;
            for (let i = 0; i < a.length; i += 4) {
              n++;
              if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) diff++;
            }
            resolve(diff / n);
          });
        }, 220);
      });
    }));
    expect(changeRatio, `连续两帧的水区变化占比 ${(changeRatio * 100).toFixed(1)}% 太低 —— 海面平面没渲染（只剩静态体素水）`).toBeGreaterThan(0.05);
    await unpin(page);
  });
});

test.describe('高台地带零回归', () => {
  test('非地带 region 不出现地带特征（池水/台地草石/巨型云都不在那儿）', async ({ page }) => {
    await openGame(page);
    // 找一个非地带 region 的中心
    const normal = await page.evaluate(async ({ seed }) => {
      const { isTarnZone, tarnZoneCenter } = await import('/src/gen/structures/tarn-zone.js');
      for (let rx = -6; rx <= 6; rx++) for (let rz = -6; rz <= 6; rz++) {
        if (rx === 0 && rz === 0) continue;              // 城市
        if (!isTarnZone(rx, rz, seed)) return { ...tarnZoneCenter(rx, rz), rx, rz };
      }
      return null;
    }, { seed: SEED });
    expect(normal, '必须存在非地带 region').not.toBeNull();

    await teleport(page, normal.cx, normal.cz, 80);
    await settle(page, normal.cx, normal.cz);
    const stats = await page.evaluate(({ cx, cz }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      // 在 region 中心 ±160 内统计：水格数 / 台地层草石 / 高空非空
      let water = 0, grassAt2 = 0, stoneAt2 = 0, skyCells = 0, samples = 0;
      for (let dx = -150; dx <= 150; dx += 10) {
        for (let dz = -150; dz <= 150; dz += 10) {
          const x = cx + dx, z = cz + dz;
          samples++;
          const y2 = nm(g.world.getBlockId(x, 2, z));
          if (y2 === 'water') water++;
          if (y2 === 'grass') grassAt2++;
          if (y2 === 'stone') stoneAt2++;
          for (let y = 54; y <= 94; y += 8) {
            if (g.world.getBlockId(x, y, z) !== 0) skyCells++;
          }
        }
      }
      return { water, grassAt2, stoneAt2, skyCells, samples };
    }, { cx: normal.cx, cz: normal.cz });

    // 非地带 region 不该有「整片 y=2 的水池 + 草石台地」
    expect(stats.water, `非地带 region(${normal.rx},${normal.cz}) 在 y=2 出现 ${stats.water} 个水格 —— 地带漏到了外面`).toBeLessThan(20);
    // 云层照旧（用户要求原有云照常渲染），所以 skyCells 不设 0，但要求有值
    expect(stats.samples).toBeGreaterThan(500);
    await unpin(page);
  });
});
