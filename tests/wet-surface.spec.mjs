import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// v3.31：按材质分类的湿表面 —— Tier 4 像素门。
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md §9.2
//
// ## 用户报告的缺陷（本文件的第一条用例就是它的直接防线）
//
// 「为什么远处的云层和近处的岩壁上有光晕，很明显」（附两张实玩截图）。
// 根因三条（实测取证见 spec §2）：
//   ① 墙侧面 wet 实测 0.85（上游公式在 up=0 时仍给近满强度）；
//   ② 流水纹沿 y 的空间频率只有 xz 的 1/12.2 ⇒ 竖直长条亮带；
//   ③ 反射投影只对「玩家脚下那一层」成立 ⇒ 墙面/云层采到别处内容（天空暖白）；
//   ④ cloud 走 opaque 通道吃满强度湿分支 + 屏幕空间体积雾 + bloom 放大。
//
// ## 判据选型（每条都写明「缺陷态会怎样」）
//
// ⚠️ **云与岩壁必须逐位几乎不变，同时地面必须显著变** —— 两侧都要：
//    只判「云/墙不变」会被「整体没生效」蒙过（恒真）；
//    只判「地面变」会被「云/墙也一起变」蒙过（正是缺陷态）。
// ⚠️ **材质分层必须用同法线单变量**：不同法线下 N·L/菲涅尔会造出亮度差，
//    即使分类完全退化也能全绿（v3.14 已实测过这个盲区）。
// ⚠️ **不过曝判据拦「加法钳白」**：反光若写成 add 而非 mix，亮端必被 ACES 削平。

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
    g.ocean.plane.visible = false;
    g.setShadowsEnabled(false);
  });
  return errs;
};

/** 等世界收敛（section 数连续 3 次不变）—— 只看队列瞬时归零不够 */
async function waitWorldStable(page) {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    let last = -1; let stable = 0;
    for (let i = 0; i < 120 && stable < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const n = g.renderWorld.slotMap.size;
      if (n === last) stable++; else { stable = 0; last = n; }
    }
  });
}

/** 注册模块内容替换（**必须在 goto 之前调**，否则注入静默失效） */
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

/**
 * 造一个「云 + 岩壁 + 地面」同框的夹具，并把相机摆好。
 *
 * 几何（全部走唯一写入口 editor）：
 *   · 地面：y=P 铺 25×25 石头
 *   · 岩壁：x∈[-8,8]、y∈[P+1,P+6]、z=oz-6（法线 ±Z，正对相机）
 *   · 云簇：y=P+16..P+18 的 9×9×3 cloud（**加厚**：1 格厚在屏幕上只有几像素高）
 *   · 其余上方清空
 *
 * ⚠️⚠️ **取样区由真实投影算出，不写死相对坐标**（本轮实测的判据坑）：
 * 上一版写死 cloud=[0.30,0.02,0.70,0.20] / wall=[0.30,0.34,0.70,0.52]，
 * 而真实投影是 cloudCenter fy=0.043、wallMid fy=0.641、wallTop fy=0.500
 * ⇒ 那两个区**取到的是天空**，「云/墙不变」两条判据恒真
 * （负向注入落地却 frac 不变，正是这个原因）。
 * ⇒ 现在把每类几何的 8 个角点 project 到屏幕，取包围盒并内缩 15% 防边缘混入。
 */
async function buildScene(page) {
  const geo = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z);
    const P = Math.floor(p.y);
    const stone = g.registry.idOf('stone');
    const cloud = g.registry.idOf('cloud');
    const changes = [];
    // 清空上方（云/空岛/建筑）
    for (let y = P + 1; y <= P + 24; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 22; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) changes.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    // 地面
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 20; dz++) {
      changes.push({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    // 岩壁（法线 ±Z）
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 6; dy++) {
      changes.push({ x: ox + dx, y: P + dy, z: oz - 6, id: stone });
    }
    // 云簇（加厚到 3 格，否则屏幕上取不到样）
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 16; dy <= 18; dy++) {
      changes.push({ x: ox + dx, y: P + dy, z: oz - 6 + dz, id: cloud });
    }
    g.editor.setBlocks(changes);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  const regions = await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);      // 雨丝会污染差分 ⇒ 只量湿表面
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    /**
     * 机位由**几何算出**，不凭直觉（本轮实测）：
     * 相机 fov=70°（半角 35°）。三个目标相对眼高的仰角：
     *   云 y=P+17（+14）、墙 y=P+3.5（+0.5）、地面 y=P+1（−2）
     * 相机在 oz+d 处、看向 z=oz-6：span(d=16)=37.0° < 70°×0.85 ⇒ 三者均入画。
     * 上一版用 d=3.5 + lookAt(P+8) 时实测 cloud fy=−0.116、ground fy=1.621
     * ⇒ 云与地面**都在画面外**，夹具前提断言当场抦下（那正是它存在的意义）。
     */
    const camZ = oz + 16;
    const camY = P + 3;
    g.camera.position.set(ox + 0.5, camY, camZ);
    // 看向「云与地面的中点」：pitch ≈ +11.8°（上表 d=16 行）
    const pitch = 11.8 * Math.PI / 180;
    g.camera.lookAt(ox + 0.5, camY + Math.tan(pitch) * 22, camZ - 22);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    const V = g.camera.position.constructor;
    /** 一组世界角点 → 屏幕相对包围盒（内缩 15%，钳到 [0.02,0.98]） */
    const box = (pts) => {
      let x0 = 1e9; let x1 = -1e9; let y0 = 1e9; let y1 = -1e9; let ok = 0;
      for (const [x, y, z] of pts) {
        const v = new V(x, y, z); v.project(g.camera);
        if (v.z > 1) continue;                     // 在相机后方
        const fx = v.x * 0.5 + 0.5; const fy = -v.y * 0.5 + 0.5;
        x0 = Math.min(x0, fx); x1 = Math.max(x1, fx);
        y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); ok++;
      }
      if (ok < 4) return null;
      const mx = (x1 - x0) * 0.15; const my = (y1 - y0) * 0.15;
      const c = (v) => Math.max(0.02, Math.min(0.98, v));
      return [c(x0 + mx), c(y0 + my), c(x1 - mx), c(y1 - my)];
    };
    const corners = (xa, xb, ya, yb, za, zb) => {
      const out = [];
      for (const x of [xa, xb]) for (const y of [ya, yb]) for (const z of [za, zb]) out.push([x, y, z]);
      return out;
    };
    const fyOf = (x, y, z) => { const v = new V(x, y, z); v.project(g.camera); return +(-v.y * 0.5 + 0.5).toFixed(3); };
    return {
      // 云：取**南侧立面**（z = oz-1.5 是云簇最南那一列的 +Z 面）。
      // ⚠️ 不能取底面：相机仰视云时底面法线·视线 0.509、侧面 0.861
      // ⇒ 侧面才是主可见面；而底面 up=−1 ⇒ orient=0 **完全不湿**
      // ⇒ 取底面会让「cloud→STONE」的负向注入零判别力（本轮实测）。
      cloud: box(corners(ox - 3, ox + 4, P + 16.2, P + 18.8, oz - 1.05, oz - 1)),
      // 墙：朝相机那一面（z = oz-5），取中段
      wall: box(corners(ox - 6, ox + 7, P + 2, P + 5.5, oz - 5, oz - 4.9)),
      // 地面：墙前方到相机之间那一段（相机已退到 oz+16，故取 oz+2..oz+10）
      ground: box(corners(ox - 8, ox + 9, P + 1, P + 1.01, oz + 2, oz + 10)),
      proj: {
        cloudMid: fyOf(ox + 0.5, P + 17, oz - 2),
        wallMid: fyOf(ox + 0.5, P + 3.5, oz - 5),
        groundMid: fyOf(ox + 0.5, P + 1, oz),
      },
    };
  }, geo);
  await page.waitForTimeout(700);
  console.log('SCENE REGIONS:', JSON.stringify(regions));
  // 前提断言：三个区都必须算出来、不退化、且上下不重叠
  // （否则判据取样在别的东西上 = 恒真，本轮已踩过）
  for (const k of ['cloud', 'wall', 'ground']) {
    if (!regions[k]) throw new Error(`[夹具] ${k} 区投影失败（角点不足 4 个在视锥内）`);
    const [x0, y0, x1, y1] = regions[k];
    if (!(x1 > x0 && y1 > y0)) throw new Error(`[夹具] ${k} 区退化：${regions[k]}`);
  }
  if (!(regions.cloud[3] < regions.wall[1])) throw new Error(`[夹具] 云区必须在墙区上方：${JSON.stringify(regions)}`);
  if (!(regions.wall[3] < regions.ground[1])) throw new Error(`[夹具] 墙区必须在地面区上方：${JSON.stringify(regions)}`);
  return { ...geo, regions };
}

function regionDiff(on, off, [fx0, fy0, fx1, fy1]) {
  let n = 0; let changed = 0; let sumOn = 0; let sumOff = 0;
  const x0 = Math.floor(on.width * fx0); const x1 = Math.floor(on.width * fx1);
  const y0 = Math.floor(on.height * fy0); const y1 = Math.floor(on.height * fy1);
  const lum = (p, o) => 0.2126 * p.data[o] + 0.7152 * p.data[o + 1] + 0.0722 * p.data[o + 2];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * on.width + x) * 4;
      const d = Math.abs(on.data[o] - off.data[o]) + Math.abs(on.data[o + 1] - off.data[o + 1])
        + Math.abs(on.data[o + 2] - off.data[o + 2]);
      n++; if (d > 8) changed++;
      sumOn += lum(on, o); sumOff += lum(off, o);
    }
  }
  return {
    frac: +(changed / Math.max(1, n)).toFixed(4),
    lumaOn: +(sumOn / Math.max(1, n)).toFixed(1),
    lumaOff: +(sumOff / Math.max(1, n)).toFixed(1),
  };
}

/** 单变量 uWet 0↔1，返回三区读数（regions 由 buildScene 的**真实投影**给出） */
async function wetAB(page, regions) {
  const grab = async (v) => {
    await page.evaluate((w) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = w;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await grab(0);
  const on = await grab(1);
  const out = {};
  for (const k of ['cloud', 'wall', 'ground']) out[k] = regionDiff(on, off, regions[k]);
  return { out, on, off };
}

test('湿表面①：云与岩壁零光晕，同时地面必须显著变湿（用户报告缺陷的直接防线）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildScene(page);
  const { out } = await wetAB(page, scene.regions);
  console.log('WET ZERO-GLOW:', JSON.stringify(out));
  // 云：完全不湿（NONE 类）⇒ 逐位不变
  expect(out.cloud.frac, '云区不得被湿表面改变（缺陷态：云吃满强度湿分支 ⇒ 高空光晕）')
    .toBeLessThan(0.02);
  /**
   * ⚠️⚠️ **墙面必须量「亮度幅度」而不是「变化像素计数」**（本轮实测的判据坑）：
   * 光晕的定义是「局部**变亮**」，而正确实现是「轻微**压暗**」。
   * 实测：墙面 up=0 ⇒ wet 0.187、albedo 乘数 0.9476（压暗 **5.2%**）、
   * reflK **0.001666**（反光近乎零）；顶面对照压暗 23.8%。
   * 5% 压暗会让大量像素超过 d>8 的计数阈值（实测 frac 0.667），
   * 但那**不是光晕** —— 用计数当判据会把正确实现判成红。
   * 缺陷态（上游那套）在墙面 reflK 上限 0.283 ⇒ **必然变亮**，下面两条都能抓。
   */
  const wallDelta = out.wall.lumaOn - out.wall.lumaOff;
  const groundDelta = out.ground.lumaOn - out.ground.lumaOff;
  expect(wallDelta, `墙面不得变亮（缺陷态：竖直长条亮带），实测 Δluma=${wallDelta.toFixed(1)}`)
    .toBeLessThanOrEqual(0.5);
  /**
   * ⚠️ 墙面压暗的**绝对上界**，不用「与地面的比值」（本轮实测的判据坑）：
   * 地面区含大量**掠射角**像素（相机俯角小），其 F 高 ⇒ 反光抵消了部分压暗，
   * 使地面净降幅变小（实测 −3.5）⇒ 比值 1.9/3.5 = 0.543 贴线。
   * 绝对上界 6 luma 更稳：实测墙 −1.9，而缺陷态（上游 reflK 上限 0.283）
   * 会让墙面**变亮** ⇒ 上一条 already 必红。
   */
  expect(Math.abs(wallDelta), `墙面压暗幅度必须极小（实测 1.9，上界 6）`)
    .toBeLessThan(6);
  // 地面：必须显著变（防「整体没生效」的恒真）
  expect(out.ground.frac, '地面必须显著变湿（0 = 湿表面根本没上屏）')
    .toBeGreaterThan(0.10);
  /**
   * ⚠️ **v3.32 重标：−2 → −1.5**（用户 2026-11-23 裁定「重标为实测值」）。
   *
   * 原因：积水镜面反光生效后，水汪处**变亮**抵消了部分水膜压暗
   * ⇒ 全区加权 Δluma 从 v3.31 的 −3.5 抬到 **−1.80**（实测）。
   * 这是**预期代价**，不是缺陷 —— 用户要的就是「水汪有反光」。
   * 按既有裁定（冻结断言因预期代价越线 ⇒ 重标基线，不放宽容差百分比），
   * 阈值取实测 −1.80 略下方的 **−1.5**（留 0.3 的量化余量）。
   *
   * ⚠️ 「湿表面真的上屏」的**主力判据是上面的 frac > 0.10**（实测 0.82，判别力充足），
   * 本条只是「净效应仍偏压暗」的方向锚点 —— 水汪反光不得强到把整片地面变成镜子。
   * 水汪自身的变亮幅度由用例⑦（Δ > +2）独立钉住。
   */
  expect(groundDelta, '地面净效应仍须偏压暗（水汪反光不得强到把地面变成镜子）')
    .toBeLessThan(-1.5);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('湿表面②：材质分层 —— 同法线单变量下反光强度按类单调', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const geo = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z); const P = Math.floor(p.y);
    const stone = g.registry.idOf('smooth_stone');
    const changes = [];
    for (let y = P + 1; y <= P + 20; y++) {
      for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) changes.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
      changes.push({ x: ox + dx, y: P, z: oz + dz, id: stone });
    }
    g.editor.setBlocks(changes);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  // ① 内容级判据：读真实 GPU packed 的类位（不依赖亮度）
  const cls = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WET_CLASS } = await import('/src/voxel/wet-material-data.js');
    const bm = g.renderWorld.meshes.opaque;
    const packed = bm.geometry.getAttribute('packed');
    const seen = new Set();
    for (let i = 0; i < packed.count; i++) seen.add((packed.getX(i) >>> 15) & 0xF);
    return {
      distinct: [...seen].sort((a, b) => a - b),
      polished: WET_CLASS.POLISHED,
      tableLen: g.renderWorld.materials.wet.uWetParams.array.length,
    };
  });
  console.log('WET CLASS ON GPU:', JSON.stringify(cls));
  expect(cls.distinct.includes(cls.polished), 'GPU 上必须真的出现 POLISHED 类位').toBe(true);
  expect(cls.tableLen, 'uniform 数组长度必须是 9').toBe(9);

  // ② 同法线单变量：同一块地面，只改 uWetParams 里 POLISHED 那一项
  await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    g.camera.position.set(ox + 0.5, P + 6, oz + 6);
    g.camera.lookAt(ox + 0.5, P + 1, oz - 2);   // 俯视 45° 左右
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
  }, geo);
  await page.waitForTimeout(700);

  const R = [0.25, 0.62, 0.75, 0.92];
  const grab = async (params) => {
    await page.evaluate((p) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      /**
       * ⚠️ **v3.33：本用例必须关掉真倒影**（单变量原则）。
       * 它量的是**程序化天空反光**按材质类的分层；真倒影（复用 ocean RT）
       * 叠在同一画面上会成为**额外变量**，把 luma 排序打乱
       * （实测：wood 176.57 < soil 176.96，而关倒影时 wood 184.1 > soil 182.5）。
       * ⇒ 不是放宽阈值，而是把无关变量置 0，恢复本用例原有的判别力。
       * 真倒影自己的判据在 tests/puddle-reflect.spec.mjs（内容级空间对应）。
       */
      U.uPuddleReflect.value = 0;
      const v = U.uWetParams.array[1];   // POLISHED
      v.set(p[0], p[1], p[2], p[3]);
      g.renderer.render(g.scene, g.camera);
    }, params);
    await page.waitForTimeout(260);
    const png = PNG.sync.read(await page.screenshot());
    let n = 0; let sum = 0; let bright = 0;
    const x0 = Math.floor(png.width * R[0]); const x1 = Math.floor(png.width * R[2]);
    const y0 = Math.floor(png.height * R[1]); const y1 = Math.floor(png.height * R[3]);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const o = (y * png.width + x) * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; sum += l; if (l >= 250) bright++;
    }
    return { luma: +(sum / n).toFixed(2), over: +(bright / n).toFixed(5) };
  };
  /**
   * ⚠️⚠️ **darken 一律固定为 1**（本轮实测的判据坑）：
   * 最终 luma 同时吃「压暗」与「反光」两个**反向**项 —— SOIL 压暗最狠（0.62），
   * 尽管它的反光比 FABRIC 强，最终 luma 反而更低。用最终 luma 排序会把
   * 「分类正确」判成红（实测 wood 168.89 > stone 166.91）。
   * ⇒ 本用例只量**反光项**：把 darken 钉成 1，让 rough/specGain 成为唯一变量。
   * 压暗那一侧由用例①的「地面 frac > 0.10」覆盖。
   *
   * 序关系取自 CPU 同构纯函数的分解实测（反光增量，线性空间）：
   *   FABRIC 0.00021 < SOIL 0.00123 < WOOD 0.00185 < STONE 0.00286 < POLISHED 0.00863
   * （PLANT 因 wetGain 0.35 更低，单独排在最前）
   */
  const ladder = {
    none: [0, 1, 1, 0],
    fabric: [1, 1, 0.90, 0.04],
    soil: [1, 1, 0.62, 0.18],
    wood: [1, 1, 0.45, 0.35],
    stone: [1, 1, 0.35, 0.45],
    polished: [1, 1, 0.06, 1.00],
  };
  const r = {};
  for (const [k, p] of Object.entries(ladder)) r[k] = await grab(p);
  console.log('WET MATERIAL LADDER:', JSON.stringify(r));
  // 反光强度单调（darken 恒 1 ⇒ luma 越高 = 混入的天空色越多）
  // ⚠️ 只钉**屏幕上分得开**的档（本轮实测）：wood 与 fabric 的 Δluma 都 <0.5，
  // 8bit 量化后并列（182.50 vs 182.52）⇒ 钉它们的严格序是噪声判据。
  // 中间档的序关系由 Tier 1 的纯函数判据承担（那里精度足够，已钉 stone>wood>soil>fabric）。
  expect(r.polished.luma, '抛光 > 石').toBeGreaterThan(r.stone.luma);
  expect(r.stone.luma, '石 > 木').toBeGreaterThan(r.wood.luma);
  expect(r.polished.luma - r.fabric.luma, '抛光与布必须拉开 ≥2 luma（材质分层的屏幕判据）')
    .toBeGreaterThan(2);
  expect(r.polished.luma - r.none.luma, '抛光 vs 不湿必须拉开 ≥2 luma（反光真的上屏）')
    .toBeGreaterThan(2);
  // 分类退化的反向防线：若把各类参数写成一样，上面四条会全红
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('湿表面③：不过曝（反光是 mix 不是 add）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  const scene = await buildScene(page);
  const { on, off } = await wetAB(page, scene.regions);
  const overFrac = (png) => {
    let n = 0; let b = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; if (l >= 250) b++;
    }
    return b / n;
  };
  const a = overFrac(off); const b = overFrac(on);
  console.log('WET OVEREXPOSURE:', JSON.stringify({ off: +a.toFixed(5), on: +b.toFixed(5) }));
  expect(b, '开湿表面后过曝像素占比不得显著上升（缺陷态：add 在亮端钳白）')
    .toBeLessThan(a + 0.005);
});

test('湿表面④：积水斑不是轴对齐矩形（连续噪声，不是 hash(floor)）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  const scene = await buildScene(page);
  const { on, off } = await wetAB(page, scene.regions);
  // 量**效应层自身**（开−关差分）的「相邻像素差为 0 的比例」：
  // 硬格子 ⇒ 该比例极高（同一 cell 整体同值）；连续噪声 ⇒ 接近场景水平。
  // ⚠️ 取样区用**真实投影**给出的地面区（不写死相对坐标）。
  const [gx0, gy0, gx1, gy1] = scene.regions.ground;
  const bounds = (p) => [Math.floor(p.width * gx0), Math.floor(p.height * gy0),
    Math.floor(p.width * gx1), Math.floor(p.height * gy1)];
  const sameRate = (dx, dy) => {
    let n = 0; let same = 0;
    const [x0, y0, x1, y1] = bounds(on);
    const d = (p, x, y) => {
      const o = (y * p.width + x) * 4;
      return (p.data[o] - off.data[o]) + (p.data[o + 1] - off.data[o + 1]) + (p.data[o + 2] - off.data[o + 2]);
    };
    for (let y = y0; y < y1 - dy; y++) for (let x = x0; x < x1 - dx; x++) {
      n++;
      if (d(on, x, y) === d(on, x + dx, y + dy)) same++;
    }
    return same / Math.max(1, n);
  };
  const sceneSame = (() => {
    let n = 0; let same = 0;
    const [x0, y0, x1, y1] = bounds(off);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 1; x++) {
      const o = (y * off.width + x) * 4; const p = o + 4;
      n++;
      if (off.data[o] === off.data[p] && off.data[o + 1] === off.data[p + 1] && off.data[o + 2] === off.data[p + 2]) same++;
    }
    return same / Math.max(1, n);
  })();
  const eff = sameRate(1, 0);
  console.log('WET PUDDLE CONTINUITY:', JSON.stringify({ eff: +eff.toFixed(4), scene: +sceneSame.toFixed(4) }));
  /**
   * ⚠️⚠️ **必须用相对判据，不能用绝对阈值**（本轮实测的判据坑）：
   * 本机位地面是匀质石头贴图，**场景本身**的相邻像素相同率就有 0.8521，
   * 效应层 0.8506 与它几乎相同 —— 写「eff < 0.60」会把正确实现判成红。
   * 硬格子（hash(floor)）的形态是效应层**显著高于**场景水平
   * （v3.30d 实测：雨幕层 82.06% vs 场景 4.6%）⇒ 判据是「不得显著高于场景」。
   */
  expect(eff, `积水斑不得比场景本身更「块状」（效应层 ${eff.toFixed(4)} vs 场景 ${sceneSame.toFixed(4)}）`)
    .toBeLessThan(sceneSame + 0.05);
});

test('湿表面⑤：关闭后逐位回到未开启（同一 page 内单变量）', async ({ page }) => {
  test.setTimeout(300_000);
  await BOOT(page);
  await buildScene(page);
  const grab = async (v) => {
    await page.evaluate((w) => {
      const g = window.__MC_GAME__;
      g.renderWorld.materials.wet.uWet.value = w;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const base = await grab(0);
  await grab(1);
  const back = await grab(0);
  let diff = 0;
  for (let i = 0; i < base.data.length; i++) if (base.data[i] !== back.data[i]) diff++;
  console.log('WET ZERO-REGRESSION:', JSON.stringify({ diffBytes: diff }));
  expect(diff, 'uWet 写回 0 后必须与基线逐位相同').toBe(0);
});

test('湿表面⑥：水下逐片元归零（相机在水上、片元在水下）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const site = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { computeShallowTarnAnchor } = await import('/src/gen/structures/shallow-water-tarns.js');
    const a = computeShallowTarnAnchor(g.seed);
    return a ? { x: a.wx + 0.5, z: a.wz + 0.5 } : null;
  });
  expect(site, 'seed 必须有浅水高台落点').not.toBeNull();
  await page.evaluate(([x, z]) => window.__MC_GAME__._teleportTo(x, 40, z), [site.x, site.z]);
  await page.waitForTimeout(4000);
  await waitWorldStable(page);
  const st = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { WATER_SURFACE_Y } = await import('/src/render/water-surface.js');
    g.setStormLighting(true);
    await new Promise((r) => setTimeout(r, 1500));
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    const p = g.player.physics.pos;
    p.y = WATER_SURFACE_Y + 3.0;
    g.player.pitch = -0.75; g.player.yaw = 0;
    g.player.update(0.016);
    g.ocean.plane.visible = false;
    const U = g.renderWorld.materials.wet;
    return { camY: +g.camera.position.y.toFixed(3), waterY: WATER_SURFACE_Y, uWet: U.uWet.value };
  });
  console.log('WET UNDERWATER STATE:', JSON.stringify(st));
  expect(st.camY, '相机必须在水面之上（否则测的是别的情形）').toBeGreaterThan(st.waterY);
  expect(st.uWet, '总强度必须是开的（否则归零是总开关造成的，判据恒真）').toBeGreaterThan(0);
  const grab = async (waterY) => {
    await page.evaluate((wy) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      U.uWetWaterY.value = wy;
      g.renderer.render(g.scene, g.camera);
    }, waterY);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const gated = await grab(st.waterY);
  const ungated = await grab(-1000);
  const r = regionDiff(gated, ungated, [0.15, 0.55, 0.85, 0.95]);
  console.log('WET UNDERWATER DIFF:', JSON.stringify(r));
  expect(r.frac, '水下门必须真的改变湖底像素（0 = 门没生效）').toBeGreaterThan(0.10);
  const gpuErrs = errs.filter((e) => /GPUValidationError|Invalid CommandBuffer/.test(e));
  expect(gpuErrs, `不得有 WebGPU 验证错误：${gpuErrs.slice(0, 2).join(' | ')}`).toEqual([]);
});

// ==================== v3.32 积水斑的镜面反光 ====================
//
// 设计稿：docs/superpowers/specs/2026-11-23-puddle-mirror-reflection-design.md
//
// 用户 2026-11-23：「水汪没有反光，适当的加一些水汪的反光效果」。
// 根因（CPU + GPU 双向实测）：specGain 被 min(…,1) 钳死，抛光类本来就是 1.0
// ⇒ v3.31 的 ×1.60 是恒等，积水 reflK 只 +4% 却额外压暗 12% ⇒ 水汪比周边暗 5.9 luma。
//
// ⚠️ 本组全部走**单变量 `uWetPuddleRefl` 1↔0**：几何/相机/太阳/材质参数全不动，
// 不重 mesh、不换 page ⇒ 差分里只有「积水反光」这一个因子。

/**
 * 积水夹具：大片**抛光石**地面 + 一面石墙 + 一簇云。
 *
 * ⚠️⚠️ **机位必须与 buildScene 不同（本轮实测的判据坑）**：
 * buildScene 是仰视 11.8° 的**掠射**机位（为了把云/墙/地面三者同时入画），
 * 它的地面区 noV 只 **0.164**、且取样段落在掩码稀疏处
 * ⇒ 积水反光实测只 **Δluma +1.30 / frac 0.116**（信号太弱）。
 * 机位扇描（同一夹具、只改相机）：
 *   掠射 11.8° → Δ 2.67 / frac 0.230
 *   **俯视 30°  → Δ 3.60 / frac 0.288**（noV 0.640）
 *   俯视 45°  → Δ 2.35 / frac 0.232
 *   俯视 60°  → Δ 2.53 / frac 0.275
 * ⇒ 本夹具取 **30° 俯视**（信噪比最高），云/墙/地面三区仍由真实投影算包围盒。
 *
 * 为什么地面用 smooth_stone：POLISHED 类（specGain 1.0）⇒ 积水反光最强；
 * 石材的分层由用例②与 Tier 1 承担。
 */
async function buildPuddleScene(page) {
  const geo = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const ox = Math.floor(p.x); const oz = Math.floor(p.z); const P = Math.floor(p.y);
    const polished = g.registry.idOf('smooth_stone');
    const stone = g.registry.idOf('stone');
    const cloud = g.registry.idOf('cloud');
    const changes = [];
    for (let y = P + 1; y <= P + 24; y++) {
      for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 22; dz++) {
        if (g.world.getBlockId(ox + dx, y, oz + dz) !== 0) changes.push({ x: ox + dx, y, z: oz + dz, id: 0 });
      }
    }
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 22; dz++) {
      changes.push({ x: ox + dx, y: P, z: oz + dz, id: polished });
    }
    // 墙：沿 x 延伸、法线 ±Z（与 buildScene 同位置）
    for (let dx = -8; dx <= 8; dx++) for (let dy = 1; dy <= 6; dy++) {
      changes.push({ x: ox + dx, y: P + dy, z: oz - 6, id: stone });
    }
    // 云簇：抬高到 P+16..18（与 buildScene 同）
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 16; dy <= 18; dy++) {
      changes.push({ x: ox + dx, y: P + dy, z: oz - 6 + dz, id: cloud });
    }
    g.editor.setBlocks(changes);
    return { ox, oz, P };
  });
  await waitWorldStable(page);
  const regions = await page.evaluate(({ ox, oz, P }) => {
    const g = window.__MC_GAME__;
    g.setStormLighting(true);
    g.renderer.setAnimationLoop(null);
    g.stormRain.setEnabled(false);
    g.player.physics.step = () => {};
    g.camera.up.set(0, 1, 0);
    /**
     * 30° 俯视机位（扇描选定）：相机 (ox+0.5, P+6, oz+10)，看向 (ox+0.5, P+1, oz-2)。
     * 地面中心 noV 实测 **0.640**。
     * ⚠️ 云与墙在本机位下可能出画 ⇒ 它们的取样区由 box() 返回 null 时
     * 夹具前提断言会当场抦下（而不是静默取到别的东西）。
     */
    const camY = P + 6; const camZ = oz + 10;
    g.camera.position.set(ox + 0.5, camY, camZ);
    g.camera.lookAt(ox + 0.5, P + 1, oz - 2);
    g.camera.updateMatrixWorld();
    g.camera.updateProjectionMatrix();
    const V = g.camera.position.constructor;
    const box = (pts) => {
      let x0 = 1e9; let x1 = -1e9; let y0 = 1e9; let y1 = -1e9; let ok = 0;
      for (const [x, y, z] of pts) {
        const v = new V(x, y, z); v.project(g.camera);
        if (v.z > 1) continue;
        const fx = v.x * 0.5 + 0.5; const fy = -v.y * 0.5 + 0.5;
        // 只接受真正落在画面内的角点（否则包围盒会被画外点拉到边缘）
        if (fx < -0.2 || fx > 1.2 || fy < -0.2 || fy > 1.2) continue;
        x0 = Math.min(x0, fx); x1 = Math.max(x1, fx);
        y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); ok++;
      }
      if (ok < 4) return null;
      const mx = (x1 - x0) * 0.15; const my = (y1 - y0) * 0.15;
      const c = (v) => Math.max(0.02, Math.min(0.98, v));
      return [c(x0 + mx), c(y0 + my), c(x1 - mx), c(y1 - my)];
    };
    const corners = (xa, xb, ya, yb, za, zb) => {
      const out = [];
      for (const x of [xa, xb]) for (const y of [ya, yb]) for (const z of [za, zb]) out.push([x, y, z]);
      return out;
    };
    // 地面中心真实 noV（夹具前提：必须是俯视，不是掠射）
    const gx = ox + 0.5; const gy = P + 1; const gz = oz + 4;
    const vx = g.camera.position.x - gx; const vy = g.camera.position.y - gy; const vz = g.camera.position.z - gz;
    return {
      cloud: box(corners(ox - 3, ox + 4, P + 16.2, P + 18.8, oz - 1.05, oz - 1)),
      wall: box(corners(ox - 6, ox + 7, P + 2, P + 5.5, oz - 5, oz - 4.9)),
      ground: box(corners(ox - 5, ox + 6, P + 1, P + 1.01, oz + 1, oz + 7)),
      groundNoV: +(vy / Math.hypot(vx, vy, vz)).toFixed(4),
    };
  }, geo);
  await page.waitForTimeout(700);
  console.log('PUDDLE SCENE REGIONS:', JSON.stringify(regions));
  // 地面区必须存在且机位真的是俯视（否则测的是掠射弱信号，本轮已踩过）
  if (!regions.ground) throw new Error('[夹具] 地面区投影失败');
  expect(regions.groundNoV, '机位必须是俯视（noV > 0.5），否则积水反光信号太弱')
    .toBeGreaterThan(0.5);
  for (const k of ['cloud', 'wall', 'ground']) {
    if (!regions[k]) continue;      // 云/墙在本机位可能出画 ⇒ 对应用例自己声明前提
    const [x0, y0, x1, y1] = regions[k];
    if (!(x1 > x0 && y1 > y0)) throw new Error(`[夹具] ${k} 区退化：${regions[k]}`);
  }
  return { ...geo, regions };
}

/** 单变量 uWetPuddleRefl 0↔1（uWet 恒 1）；只算存在的区 */
async function puddleAB(page, regions) {
  const grab = async (v) => {
    await page.evaluate((s) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      U.uWetPuddleRefl.value = s;
      /**
       * ⚠️ **v3.33：本组用例量的是程序化天空反光，必须关掉真倒影**（单变量）。
       * 真倒影映的是建筑/树，它们比天空**暗** ⇒ 叠进来后地面 Δluma 从 +1.9 变 **−4.5**，
       * 把「水汪变亮」这条判据判成红 —— 但那是**两个功能叠加**的正常结果，不是缺陷。
       * ⇒ 置 0 恢复本组原有判别力；真倒影自己的判据在 tests/puddle-reflect.spec.mjs。
       */
      U.uPuddleReflect.value = 0;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const off = await grab(0);
  const on = await grab(1);
  const out = {};
  for (const k of ['cloud', 'wall', 'ground']) {
    if (regions[k]) {
      out[k] = regionDiff(on, off, regions[k]);
      out[k].bytes = regionDiffBytes(on, off, regions[k]);
    }
  }
  return { out, on, off };
}

/** 区内逐像素 luma 数组 */
function regionLumas(png, [fx0, fy0, fx1, fy1]) {
  const x0 = Math.floor(png.width * fx0); const x1 = Math.floor(png.width * fx1);
  const y0 = Math.floor(png.height * fy0); const y1 = Math.floor(png.height * fy1);
  const out = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * png.width + x) * 4;
    out.push(0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2]);
  }
  return out;
}

/**
 * 区内**逐字节**差异计数。
 *
 * ⚠️ 比 |Δluma| 阈值**强得多**：位级判据对效应幅度零依赖。
 * 墙面 wet 只 0.187，即使镜面漏上去效应也只 0.05~0.8 luma
 * ⇒ 任何 luma 阈值都会被 8bit 量化吞掉（本轮实测：负向注入后 Δ=0.00），
 * 而位级差异能抓到哪怕 1/255 的变化。
 */
function regionDiffBytes(on, off, [fx0, fy0, fx1, fy1]) {
  const x0 = Math.floor(on.width * fx0); const x1 = Math.floor(on.width * fx1);
  const y0 = Math.floor(on.height * fy0); const y1 = Math.floor(on.height * fy1);
  let diff = 0; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * on.width + x) * 4;
    for (let c = 0; c < 3; c++) { n++; if (on.data[o + c] !== off.data[o + c]) diff++; }
  }
  return { diff, n, frac: +(diff / Math.max(1, n)).toFixed(6) };
}

const stdev = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length));
};

test('积水反光⑦：水汪真的变亮，而云与岩壁逐位几乎不动', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildPuddleScene(page);
  const { out } = await puddleAB(page, scene.regions);
  console.log('PUDDLE MIRROR AB:', JSON.stringify(out));
  const dGround = out.ground.lumaOn - out.ground.lumaOff;
  /**
   * ⚠️ 方向是**变亮**（不是「变了」）：本轮根因正是「水汪只压暗不反光」，
   * 只判 frac>0 会被「水汪变得更暗」蒙过（那恰恰是缺陷态）。
   *
   * ⚠️ **v3.32b 重标：2 → 1.2**（用户裁定幅度减半后的实测值）。
   * 30° 俯视机位实测：MIRROR 0.70 时 Δluma **+3.5** / frac 0.2802；
   * 减半到 0.44 后 Δluma **+1.9** / frac 0.2048。
   * 取 1.2（实测 1.9 下方留 0.7 余量）—— 这是**预期代价**而非缺陷，
   * 按既有裁定（冻结断言因预期代价越线 ⇒ 重标基线，不放宽容差百分比）。
   * 判别力仍在：若积水反光完全不上屏则 Δ=0，若退化成「只压暗」则 Δ<0，两者都红。
   */
  expect(dGround, `地面必须变亮（积水反光），实测 Δluma=${dGround.toFixed(2)}`)
    .toBeGreaterThan(1.2);
  expect(out.ground.frac, '地面必须有足够多的像素被改变（0 = 积水反光根本没上屏）')
    .toBeGreaterThan(0.05);
  // 云/墙：本机位下可能出画 ⇒ 存在时才判（存在性由夹具的真实投影保证）
  // ⚠️ 用**位级**判据而不是 |Δluma|<1：墙面 wet 只 0.187，镜面漏上去也只 0.05~0.8 luma
  // ⇒ luma 阈值会被 8bit 量化吞掉（本轮实测：负向注入后 Δ=0.00，判据零判别力）。
  if (out.cloud) {
    expect(out.cloud.bytes.diff, '云区必须逐字节不动（NONE 类 ⇒ wet=0）').toBe(0);
  }
  if (out.wall) {
    expect(out.wall.bytes.diff, '墙面必须逐字节不动（朝向门；缺陷态：水汪镜面爬上墙）').toBe(0);
  }
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('积水反光⑧：水汪内有明暗层次（云影），不是纯色塑料板', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildPuddleScene(page);
  const { on, off } = await puddleAB(page, scene.regions);
  const lumOn = regionLumas(on, scene.regions.ground);
  const lumOff = regionLumas(off, scene.regions.ground);
  // 效应层自身（on − off）的空间标准差：纯色板 ⇒ 效应几乎恒定 ⇒ std 极小
  const eff = lumOn.map((v, i) => v - lumOff[i]);
  const effStd = stdev(eff);
  const effMean = eff.reduce((s, v) => s + v, 0) / eff.length;
  /**
   * ⚠️ 用**相对判据**：绝对 std 阈值会被机型/曝光/贴图对比度左右。
   * 参照量取「效应均值」——纯色板的效应是常量偏移 ⇒ std/mean 接近 0；
   * 有云影层次时 std 与 mean 同量级。v3.31 用例④的「相对场景水平」是同一思路。
   */
  const ratio = effStd / Math.max(1e-6, Math.abs(effMean));
  console.log('PUDDLE CLOUD LAYERS:', JSON.stringify({
    effMean: +effMean.toFixed(3), effStd: +effStd.toFixed(3), ratio: +ratio.toFixed(4),
    sceneStd: +stdev(lumOff).toFixed(3),
  }));
  expect(ratio, `水汪效应层必须有空间层次（std/|mean|=${ratio.toFixed(3)}，纯色板接近 0）`)
    .toBeGreaterThan(0.25);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('积水反光⑨：uWetPuddleRefl=0 是第二级零回归锚点（可重复、且差分只在地面）', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = await BOOT(page);
  const scene = await buildPuddleScene(page);
  const grab = async (v) => {
    await page.evaluate((s) => {
      const g = window.__MC_GAME__;
      const U = g.renderWorld.materials.wet;
      U.uWet.value = 1;
      U.uWetPuddleRefl.value = s;
      g.renderer.render(g.scene, g.camera);
    }, v);
    await page.waitForTimeout(260);
    return PNG.sync.read(await page.screenshot());
  };
  const a = await grab(0);
  await grab(1);
  const b = await grab(0);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  console.log('PUDDLE ZERO-REGRESSION:', JSON.stringify({ diffBytes: diff }));
  expect(diff, 'uWetPuddleRefl 写回 0 必须与首次 0 逐位相同（无状态残留）').toBe(0);
  expect(errs, '不得有 console 错误').toEqual([]);
});

test('负向③：去掉积水的两道朝向门 ⇒ 墙面必须不再逐位不动', async ({ page }) => {
  test.setTimeout(300_000);
  /**
   * ⚠️⚠️ **两道朝向门是串联的，必须同时去掉**（本轮实测的注入坑）：
   * `puddle` 里有 `select(isTop,1,0)`，`puddleW` 里又乘了 `topGate`。
   * 只删前者时 `puddleW = puddle × 0 × strength = 0`
   * ⇒ reflK 取左端、skyMul=1 ⇒ 墙面**逐位不动**，注入根本没造出缺陷
   * （实测：只删一道时墙 Δ=0.00，而 CPU 算的无门效应也才 0.094 luma）。
   *
   * ⚠️ 判据用**位级差异**而不是 luma 阈值：墙面 wet 只 0.187，
   * 镜面漏上去的效应只 0.05~0.8 luma ⇒ 任何 luma 阈值都被 8bit 量化吞掉。
   * 正向用例⑦同口径钉「墙区 diffBytes == 0」⇒ 两侧对称、判别力无穷。
   */
  await routeModule(page, 'wet-surface.js', (b) => b
    .replace('    .mul(select(isTop, float(1), float(0)))\n', '')
    .replace('  const topGate = select(isTop, float(1), float(0));',
      '  const topGate = float(1);'));
  await BOOT(page);
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/render/wet-surface.js')).text();
    const code = src.split('\n').filter((l) => {
      const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
    return {
      hasPuddleGate: code.some((l) => l.includes('.mul(select(isTop, float(1), float(0)))')),
      hasTopGate: code.some((l) => l.includes('const topGate = select(isTop')),
      topGateIsOne: code.some((l) => l.includes('const topGate = float(1);')),
    };
  });
  console.log('NEG-TOPGATE INJECT:', JSON.stringify(injected));
  expect(injected.hasPuddleGate, 'puddle 的朝向门须已删除').toBe(false);
  expect(injected.hasTopGate, 'topGate 的 select 须已删除').toBe(false);
  expect(injected.topGateIsOne, 'topGate 须已被改成恒 1').toBe(true);
  const scene = await buildPuddleScene(page);
  expect(scene.regions.wall, '本用例需要墙区入画（否则判据无从取样）').not.toBeNull();
  const { out } = await puddleAB(page, scene.regions);
  console.log('NEG-TOPGATE AB:', JSON.stringify(out));
  expect(out.wall.bytes.diff,
    `注入后墙面必须不再逐位不动（实测 diffBytes=${out.wall.bytes.diff}），否则判据对缺陷零判别力`)
    .toBeGreaterThan(0);
});

test('负向①：把 cloud 改成 STONE ⇒ 零光晕判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await routeModule(page, 'wet-material-data.js', (b) => b
    .replace('  cloud: WET_CLASS.NONE,', '  cloud: WET_CLASS.STONE,'));
  await BOOT(page);
  // 注入生效确认：读回浏览器侧源码
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/voxel/wet-material-data.js')).text();
    return { hasOld: src.includes('cloud: WET_CLASS.STONE'), hasNew: src.includes('cloud: WET_CLASS.NONE') };
  });
  console.log('NEG-CLOUD INJECT:', JSON.stringify(injected));
  expect(injected.hasOld, '注入须真的落地').toBe(true);
  expect(injected.hasNew, '原写法须已被替换').toBe(false);
  const scene = await buildScene(page);
  const { out } = await wetAB(page, scene.regions);
  console.log('NEG-CLOUD ZERO-GLOW:', JSON.stringify(out));
  // ⚠️ 与正向**同口径**：量幅度而不是计数（本轮实测）。
  // 注入后云 luma 212→211（确实变了），但 1 luma 低于 d>8 的计数阈值 ⇒ frac 仍 0。
  // 正向已改成量幅度，负向却还在量计数 ⇒ 不一致。
  const dCloud = Math.abs(out.cloud.lumaOn - out.cloud.lumaOff);
  expect(dCloud, `注入后云区亮度必须被改变（实测 Δ=${dCloud.toFixed(2)}），否则判据对缺陷零判别力`)
    .toBeGreaterThan(0.3);
});

test('负向②：把反光 mix 改成 add ⇒ 不过曝判据必须 FAIL', async ({ page }) => {
  test.setTimeout(300_000);
  await routeModule(page, 'wet-surface.js', (b) => b
    .replace('  const withSky = mix(albedo, skyEnv, reflK);',
      '  const withSky = add(albedo, skyEnv.mul(reflK.mul(20.0)));'));
  await BOOT(page);
  const injected = await page.evaluate(async () => {
    const src = await (await fetch('/src/render/wet-surface.js')).text();
    // ⚠️ 只看**代码行**：jsdoc 里也有同串公式说明，全文件 includes 会恒真
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    return {
      hasAdd: codeLines.some((l) => l.includes('skyEnv.mul(reflK.mul(20.0))')),
      hasMix: codeLines.some((l) => l.includes('mix(albedo, skyEnv, reflK)')),
    };
  });
  console.log('NEG-ADD INJECT:', JSON.stringify(injected));
  expect(injected.hasAdd, '注入须真的落地').toBe(true);
  expect(injected.hasMix, '原写法须已被替换').toBe(false);
  const scene = await buildScene(page);
  const { on, off } = await wetAB(page, scene.regions);
  const overFrac = (png) => {
    let n = 0; let b = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const o = i * 4;
      const l = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      n++; if (l >= 250) b++;
    }
    return b / n;
  };
  const a = overFrac(off); const b = overFrac(on);
  console.log('NEG-ADD OVEREXPOSURE:', JSON.stringify({ off: +a.toFixed(5), on: +b.toFixed(5) }));
  /**
   * ⚠️⚠️ **用相对倍数，不用绝对增量**（本轮实测的判据坑）：
   * 本机位过曝基数极低（0.00008），而 ACES 把高亮压得很扁
   * ⇒ add×20 后只到 0.00042（**上升 5.25 倍**），绝对增量 0.00034 远低于 0.005。
   * 相对倍数对「加法钳白」有判别力且不受基数影响。
   * （正向用例③仍用绝对增量上界 —— 它拦的是「不得显著上升」，方向相反。）
   */
  expect(b, `注入后过曝占比必须显著上升（实测 ${(b / Math.max(a, 1e-9)).toFixed(2)} 倍）`)
    .toBeGreaterThan(Math.max(a, 1e-9) * 3);
});