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
 * 本 seed 的最近地带 region（由探针实测确定，**不是想象的坐标**）。
 *
 * ⚠️ **不能填 (0,0)**：那是 `CITY_REGION`，`isTarnZone(0,0,*) ≡ false`。
 * ⚠️ **s1.90 换过夹具**：旧值 `(0,-2)` 在旧口径（纯哈希 1/3）下是地带，但新口径下
 * （1/5 × PLAINS × 邻沙 × 沙漠占比 ≤ 25%）它不合格（核心沙漠占比 0.379）—— 忘换会
 * 使 `flyToTarn` 的自检断言真红（那正是它存在的意义：安静地测错地方比失败更糟）。
 * 下面的 `findTarn` 会反查并断言它真的地带。
 */
const TARN_REGION = { rx: -4, rz: -1 };

/** 地带中心的实测坐标（探针输出，用于断言「找对了地方」） */
const TARN_CENTER = { cx: -1400, cz: -200 };
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
  await page.goto(`/?vd=16&seed=${SEED}`);
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
  // ⚠️ **加载半径必须覆盖整个地带圆**：v1.90 缩外形后地带半径 138，「地带外形」那条用例
  //    要探到半径 + 8 = 146 格，而 `settle` 默认只等 6 个 column（96 格）→ 超出的
  //    `topAt` 读到 null（未加载）。
  //    ⚠️ **视距必须同步抬到 16**：vd=8 时世界径向只加载 (8+2)*16 = 160 格，
  //    而探针在 146 格处已经贴到边缘（实测会卡在 settle 5 分钟超时）。
  //    vd=16 → 径向 288 格，余量充足。
  const needCols = Math.ceil((c.lay.plateauRadius + 8) / 16) + 1;
  await settle(page, c.center.cx, c.center.cz, needCols);
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
  test('地带平台：中心是实心地表，完全没有水（v1.89 去掉中央水池）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const layers = await page.evaluate(({ cx, cz, plateauY }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      const out = {};
      for (const dy of [-1, 0, 1]) out['y' + (plateauY + dy)] = nm(g.world.getBlockId(cx, plateauY + dy, cz));
      // 再扫一遍平台内是否有任何水（体素水 + 沼泽水）
      const waters = new Set(['water', 'swamp_water']);
      let waterCells = 0;
      for (let dx = -60; dx <= 60; dx += 4) {
        for (let dz = -60; dz <= 60; dz += 4) {
          for (let y = plateauY - 30; y <= plateauY + 2; y++) {
            if (waters.has(nm(g.world.getBlockId(cx + dx, y, cz + dz)))) waterCells++;
          }
        }
      }
      return { ...out, waterCells };
    }, { cx: c.cx, cz: c.cz, plateauY: c.lay.plateauY });
    const surface = layers['y' + c.lay.plateauY];
    // ⚠️ v1.91 起中心是冰带（用户 2026-10-28 设计），不再是草石镶嵌
    expect(['ice', 'snow'], `平台中心 y=${c.lay.plateauY} 应是冰/雪（实际 ${surface}）`).toContain(surface);
    expect(layers['y' + (c.lay.plateauY + 1)], '平台地表之上必须是空气').toBe('air');
    // ⚠️ v1.89 的核心断言：地带内一格水都没有
    expect(layers.waterCells, '地带内出现水格 —— v1.89 起地带必须完全无水（否则占 transparent 通道）').toBe(0);
    await unpin(page);
  });

  test('地带外形：平台外真的开始降坡，且地带外的地表不是被削平的', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    // ⚠️ **不能用「地表高度 == generateHeight」判圆外零影响**（实测踩坑）：
    //    圆外照旧会生成树/巨树/结构，地表可能比自然地形高几十格（实测 52 vs -3）——
    //    那与「地带有没有整形那里」无关。
    //
    // ✅ 用两个不受植被影响的事实：
    //    ① **缓坡真的存在**：从平台边缘向内、向外各取一圈的**中位数**地表高度，
    //       内圈应贴近 plateauY（平台），外圈应显著低于/远离 plateauY（已降坡）。
    //       ⚠️ 平台内立着 8 座高台（最高 46 格），所以内圈不能用均值，必须用中位数，
    //       且只要求「≥ plateauY − 2」（高台只会把中位数抬高，不会拉低）。
    //    ② **地带圆外一格都没被削平**：在那里的列上，`y = plateauY` 处不应出现
    //       「被强制铺成草/石平台」的迹象。实测地带内 `plateauY` 层的草/石覆盖率接近
    //       全满，而圆外在同层的草/石覆盖率极低（地被自然环境决定）。
    //       用「覆盖率 < 50%」作判据 —— 若缓坡/平台扩到圆外，那里会被铺满。
    const r = await page.evaluate(async ({ cx, cz, plateauY, platformRadius, zoneRadius }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      const topAt = (x, z) => {
        for (let y = 90; y >= -30; y--) if (g.world.getBlockId(x, y, z) !== 0) return y;
        return null;
      };
      const ringTop = (rad) => {
        const vals = [];
        for (let i = 0; i < 48; i++) {
          const ang = i * 2 * Math.PI / 48;
          const x = Math.round(cx + rad * Math.cos(ang));
          const z = Math.round(cz + rad * Math.sin(ang));
          const top = topAt(x, z);
          if (top !== null) vals.push(top);
        }
        vals.sort((a, b) => a - b);
        return { median: vals.length ? vals[Math.floor(vals.length / 2)] : null, n: vals.length };
      };
      // 平台层的台地材质覆盖率（地带内 vs 圆外）
      // ⚠️ v1.91：台地材质变成冰/雪/黏土/草/石五种（不再是纯草石），
      //    判据得跟着改 —— 不然「台地整形生效」的赋值率会因材质换代跌到 31% 假失败。
      const PLATFORM_MATERIALS = new Set(['ice', 'snow', 'clay', 'grass', 'stone']);
      const platformCoverage = (radMin, radMax) => {
        let total = 0, paved = 0;
        for (let i = 0; i < 64; i++) {
          const ang = i * 2 * Math.PI / 64;
          const rad = radMin + (radMax - radMin) * ((i % 4) / 3);
          const x = Math.round(cx + rad * Math.cos(ang));
          const z = Math.round(cz + rad * Math.sin(ang));
          total++;
          const n = nm(g.world.getBlockId(x, plateauY, z));
          // v1.91：台地材质是 ice/snow/clay/grass/stone 五种之一（不再是纯草石）
          if (PLATFORM_MATERIALS.has(n)) paved++;
        }
        return { total, paved, rate: total ? paved / total : 0 };
      };
      return {
        inner: ringTop(Math.round(platformRadius * 0.55)),
        outer: ringTop(zoneRadius),
        insideCoverage: platformCoverage(Math.round(platformRadius * 0.4), Math.round(platformRadius * 0.8)),
        // 圆外一圈（半径 + 6 ~ + 22）：那里**不该**被铺成 plateauY 的草石平台
        outsideCoverage: platformCoverage(zoneRadius + 6, zoneRadius + 22),
      };
    }, {
      cx: c.cx, cz: c.cz, plateauY: c.lay.plateauY,
      platformRadius: c.lay.platformRadius, zoneRadius: c.lay.plateauRadius,
    });

    // ① 平台内圈必须抬到 plateauY 附近（≥ plateauY − 2；高台只会更高）
    expect(r.inner.median, '平台内圈必须有地表').not.toBeNull();
    expect(r.inner.median, `平台内圈中位数 ${r.inner.median} 低于 plateauY=${c.lay.plateauY} —— 平台没抬高`)
      .toBeGreaterThanOrEqual(c.lay.plateauY - 2);
    // ② 地带圆内 plateauY 层基本铺满
    // ⚠️ 下界实测 **84%**（不是 100%）：采样环上有几处正落在高台/紫晶柱的方块上
    //    （那里 plateauY 层是结构方块而不是 grass/stone）。取 0.75 留足余量，
    //    同时仍能把「整形完全没生效」（圆外那种 <10% 的量级）抓出来。
    expect(r.insideCoverage.rate,
      `地带内 plateauY 层草石覆盖率只有 ${(r.insideCoverage.rate * 100).toFixed(0)}%（应 ≥75%）—— 台地整形没生效`)
      .toBeGreaterThanOrEqual(0.75);
    // ③ 地带圆外同层几乎不铺（< 50%）—— 这是「外形真的只有那么大」的直接证据
    expect(r.outsideCoverage.rate,
      `地带圆外 plateauY 层草石覆盖率 ${(r.outsideCoverage.rate * 100).toFixed(0)}% —— 地带外形扩到了圆外`)
      .toBeLessThan(0.5);
    // ④ 常量本身必须还是收缩后的值（用户 2026-10-28 裁定）—— 用字面量，不拿字段自比
    expect(c.lay.platformRadius, '平台半径（= 地带半径 − 缓坡宽度）').toBe(114);
    expect(c.lay.slopeWidth, '缓坡宽度').toBe(24);
    expect(c.lay.platformRadius + c.lay.slopeWidth, '三者必须自洽').toBe(c.lay.plateauRadius);
    await unpin(page);
  });

  test('台地层是四带材质（冰 / 雪 / 草斑+黏土 / 黏土缓坡）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    const surface = await page.evaluate(({ cx, cz, lay }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      // 按半径带分开统计 ---— 关键：不能全部混在一起数，否则「冰区 100% ice」与
      //「缓坡 100% clay」会互相抵消成一个看不出问题的分布。
      const bands = [
        ['ice', 0, 44], ['snow', 44, 72], ['plot', 72, lay.platformRadius],
        ['slope', lay.platformRadius, lay.plateauRadius],
      ];
      const out = {};
      for (const [name, lo, hi] of bands) {
        const counts = {};
        let n = 0;
        // 环形采样：每个带取 48 方位 × 带内均匀的 4 个半径
        for (let a = 0; a < 48; a++) {
          const ang = (a / 48) * Math.PI * 2;
          for (let k = 0; k < 4; k++) {
            const r = lo + (hi - lo) * (k + 0.5) / 4;
            const x = Math.round(cx + r * Math.cos(ang));
            const z = Math.round(cz + r * Math.sin(ang));
            // ⚠️ **必须逐列找地表，不能读固定的 `plateauY` 层**：缓坡带的地表高度
            //    从 plateauY 线性降到自然高度（实测最低到 -6），那里 `plateauY` 层是空气。
            //    读固定层会把缓坡全数成空气（实测 51.6% air）→「缓坡不是整片 clay」假失败。
            let top = null;
            for (let y = lay.plateauY + 40; y >= lay.plateauY - 20; y--) {
              if (g.world.getBlockId(x, y, z) !== 0) { top = y; break; }
            }
            if (top === null) continue;
            const nmv = nm(g.world.getBlockId(x, top, z));
            counts[nmv] = (counts[nmv] || 0) + 1;
            n++;
          }
        }
        const frac = {};
        for (const [k, v] of Object.entries(counts)) frac[k] = v / n;
        out[name] = frac;
      }
      return out;
    }, { cx: c.cx, cz: c.cz, lay: c.lay });

    // ① 冰带：主体是 ice
    expect(surface.ice.ice ?? 0, `冰带 ice 占比 ${JSON.stringify(surface.ice)}`).toBeGreaterThan(0.5);
    // ② 雪环：有雪但不是实心一环（松散）
    const snowFrac = surface.snow.snow ?? 0;
    expect(snowFrac, `雪环 snow 占比 ${JSON.stringify(surface.snow)}`).toBeGreaterThan(0.25);
    expect(snowFrac, `雪环 snow 占比 ${(snowFrac * 100).toFixed(0)}% —— 不是「松散」，是实心环`)
      .toBeLessThan(0.98);
    // ③ 草斑带：grass / stone / clay 三种都出现
    expect(surface.plot.grass ?? 0, `草斑带 ${JSON.stringify(surface.plot)}`).toBeGreaterThan(0.1);
    expect(surface.plot.clay ?? 0, `草斑带 ${JSON.stringify(surface.plot)}`).toBeGreaterThan(0.1);
    // ④ 缓坡：整片 clay
    // ⚠️ **先排除「覆盖在缓坡上但不是地表材质」的方块**（实测两类）：
    //    ① `water` ~10% —— 洼地回水（v1.91 修的那个 bug 的正确行为）；扫描到水面就采到水。
    //    ② `cloud` ~6% —— 巨型云在 y≥54，`topAt` 从高往低扫会先碰到云。
    //    这两者都不是「地表材质错了」的证据，计入 clay 占比会让修好的实现假失败。
    const SLOPE_NON_SURFACE = new Set(['water', 'swamp_water', 'cloud']);
    const slopeSolid = Object.entries(surface.slope)
      .filter(([k]) => !SLOPE_NON_SURFACE.has(k))
      .reduce((acc, [, v]) => acc + v, 0);
    const slopeClay = slopeSolid > 0 ? (surface.slope.clay ?? 0) / slopeSolid : 0;
    expect(slopeClay, `缓坡固体材质 ${JSON.stringify(surface.slope)} —— clay 占 ${(slopeClay * 100).toFixed(0)}%`)
      .toBeGreaterThan(0.9);
    await unpin(page);
  });

  test('洼地有水：地带边缘的水体与外围地图连续（v1.91 修 bug）', async ({ page }) => {
    await openGame(page);
    const c = await flyToTarn(page);
    // ⚠️ **用户 2026-10-28 报告的缺陷**：「高台地带和外围地图接壤的部分，如果有共享的水池，
    //    则原有的水方块并未在高台地带延伸过来的水下区域填充水方块」。
    // 这里从**世界侧**验：地带圆内所有「陆地顶低于海平面」的列，从陆地顶到 SEA_Y 必须是水。
    const r = await page.evaluate(({ cx, cz, lay, SEA_Y }) => {
      const g = window.__MC_GAME__;
      const waterId = g.registry.idOf('water');
      let pit = 0, dry = 0;
      const dryEx = [];
      const R = lay.plateauRadius;
      for (let dx = -R; dx <= R; dx += 2) for (let dz = -R; dz <= R; dz += 2) {
        if (Math.hypot(dx, dz) > R) continue;
        const x = cx + dx, z = cz + dz;
        // 找陆地顶（跳过水）
        let landTop = null;
        for (let y = lay.plateauY; y >= SEA_Y - 24; y--) {
          const id = g.world.getBlockId(x, y, z);
          if (id !== 0 && id !== waterId) { landTop = y; break; }
        }
        if (landTop === null || landTop >= SEA_Y) continue;
        pit++;
        let ok = true;
        for (let y = landTop + 1; y <= SEA_Y; y++) {
          if (g.world.getBlockId(x, y, z) !== waterId) { ok = false; break; }
        }
        if (!ok) { dry++; if (dryEx.length < 5) dryEx.push(`(${x},${z}) landTop=${landTop}`); }
      }
      return { pit, dry, dryEx };
    }, { cx: c.cx, cz: c.cz, lay: c.lay, SEA_Y: -2 });

    // 先确认用例有判别力：地带边缘必须真的存在低于海平面的洼地
    expect(r.pit, `地带内低于海平面的列只有 ${r.pit} 个 —— 本用例无判别力`).toBeGreaterThan(10);
    expect(r.dry, `${r.pit} 个洼地里有 ${r.dry} 个没水：${r.dryEx.join(' ')}`).toBe(0);
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

  test('非地带 region 不出现地带特征（台地草石/巨型云都不在那儿）', async ({ page }) => {
    await openGame(page);
    // 找一个非地带 region 的中心 —— **必须挑一个「合格但没抽中」的**，不能随便找个非地带：
    // 旧写法拿第一个非地带 region（常常是森林/沙漠中心），那里本来就无台地，
    // 判据恒真（测不出「地带漏到外面」）。
    const normal = await page.evaluate(async ({ seed }) => {
      const { isTarnZone, hasTarnEligibility, tarnZoneCenter } = await import('/src/gen/structures/tarn-zone.js');
      for (let rx = -12; rx <= 12; rx++) for (let rz = -12; rz <= 12; rz++) {
        if (rx === 0 && rz === 0) continue;              // 城市
        // 合格但没抽中 = 最容易「漏成地带」的那一类
        if (!hasTarnEligibility(rx, rz, seed)) continue;
        if (isTarnZone(rx, rz, seed)) continue;
        return { ...tarnZoneCenter(rx, rz), rx, rz };
      }
      return null;
    }, { seed: SEED });
    expect(normal, '必须存在「合格但没抽中」的 region').not.toBeNull();

    await teleport(page, normal.cx, normal.cz, 80);
    await settle(page, normal.cx, normal.cz);
    const stats = await page.evaluate(({ cx, cz }) => {
      const g = window.__MC_GAME__;
      const nm = (id) => { try { return g.registry.nameOf(id); } catch { return String(id); } };
      // 在 region 中心 ±150 内统计：台地层草石 / 高空非空
      // ⚠️ s1.90 去掉了「水格」判据：地带已经没有水池，而且 y=2 的水格判据在
      //     新口径下对「非地带 region」也几乎恒为 0（它们本来就是陆地）。
      //     改为钉「platformRadius 尺度上的整片台地」—— 那是地带独有的形态。
      let grassAtPlateau = 0, skyCells = 0, samples = 0;
      for (let dx = -150; dx <= 150; dx += 10) {
        for (let dz = -150; dz <= 150; dz += 10) {
          const x = cx + dx, z = cz + dz;
          samples++;
          const y2 = nm(g.world.getBlockId(x, 2, z));
          if (y2 === 'grass' || y2 === 'stone') grassAtPlateau++;
          for (let y = 54; y <= 94; y += 8) {
            if (g.world.getBlockId(x, y, z) !== 0) skyCells++;
          }
        }
      }
      return { grassAtPlateau, skyCells, samples };
    }, { cx: normal.cx, cz: normal.cz });

    // 非地带 region 不该有「整片 y=2 的台地」：实测地带的平台是 plateauY=2 整片草/石，
    // 而普通 region 的 y=2 绝大多数是 air 或水。阈值取 samples × 0.5（台地会接近 0.785）。
    expect(stats.grassAtPlateau, `非地带 region(${normal.rx},${normal.rz}) 在 y=2 有 ${stats.grassAtPlateau}/${stats.samples} 个草石格 —— 地带漏到了外面`)
      .toBeLessThan(stats.samples * 0.5);
    expect(stats.samples).toBeGreaterThan(500);
    await unpin(page);
  });
});
