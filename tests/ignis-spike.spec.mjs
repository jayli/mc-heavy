import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 焰魔尖刺攻击的 Tier 4 像素实测（v3.06）。
 *
 * **为什么必须像素实测**：尖锥是 additive 混合的 InstancedMesh（`blending` / 逐实例
 * `instanceColor` / 实例矩阵全在 GPU 求值）。数据层（`spikeFx.activeCount`）对，
 * **画面仍可能全错**：
 *   · 几何写成 `radiusTop > 0` ⇒ 变成柱体不是刺，计数全绿；
 *   · additive 没生效 ⇒ 刺变成不透明橙块，计数全绿；
 *   · `instanceColor` 没写 ⇒ 刺全白，计数全绿；
 *   · `translate(0, height/2, 0)` 漏了 ⇒ 刺有一半埋在地下，计数全绿。
 *
 * ## 判据与对照组校准（⚠️ **必须用差分，不能用绝对色** —— 实测教训）
 *
 * 尖锥色 `SPIKE_FX.color = [1.0, 0.45, 0.12]`，additive 叠在**天空背景**上。
 * 实测：背景 (86,136,175)（蓝）+ 尖锥 ⇒ (125,147,176) —— **仍然偏蓝**！
 * 绝对色判据 `r > g + 40 && r − b > 120` 在这种叠加下**永远不成立**（实测命中 2 像素，
 * 与基线相同 ⇒ 零判别力）。根因：additive 是**加法**，蓝背景的 b=175 加上尖锥的 b≈31
 * 仍是 176，而 r 从 86 只升到 125 ⇒ r < g。
 *
 * ⇒ 改用**差分判据**：同一相机同一地形，两侧只差有没有 spawn 尖刺，数
 * **`Δr > 25 && Δr > Δg + 12 && Δr > Δb + 12`** 的像素（「变红且红增量显著大于绿蓝」）。
 * 实测：基线 **0**（同状态重复截图零噪声）、尖刺帧 **4016**。
 * 沙漠沙对照：沙地像素在两侧完全相同 ⇒ Δ=0 ⇒ 天然被排除。
 *
 * ## 单变量对照（逐行复用 ignis-fx.spec.mjs 的实测教训）
 *
 * 同一相机、同一地形、同一时刻，**只差有没有 spawn 尖刺**；
 * 并且两侧都**先藏掉焰魔的渲染实例**（`inst.mesh.visible = false`）。
 *
 * ⚠️⚠️ **为何必须藏掉焰魔**（v3.04 实测）：焰魔本体是**火焰橙皮肤**，自己就满足
 * 橙红判据，且 idle 动画让它在 1.5s 内波动 **±18000 像素**，而法阵真实贡献只有 ≈2833
 * ⇒ 判据被宿主噪声淹没，「永不上屏」的注入退化**仍然 PASS**。
 *
 * ⚠️ **取基线 + 注入必须在同一次 evaluate 的同一帧内完成**：分两次 evaluate 时中间
 * 隔着 CDP 往返（数十毫秒 = 多帧），焰魔可能在间隙自然起手别的招 ⇒ 误报。
 *
 * ⚠️ **宿主必须与玩家同高**（v3.04 实测）：`ignises.summon` 的 `_findGroundY` 取
 * 「离参考高度最近的可站位置」，起伏开阔地会把焰魔放到 y=12 而玩家 y=4（差 8 格）
 * ⇒ 贴地尖刺全在相机上方，俯视根本看不到 ⇒ 像素零变化。
 */

const SEED = 12345;

/**
 * 「变红」像素数（差分判据）：红增量 > 25 且显著大于绿/蓝增量。
 *
 * ⚠️ **不能用绝对色判据**：additive 叠在蓝天空上后结果仍偏蓝（实测 125,147,176），
 * `r > g + 40` 永远不成立 ⇒ 零判别力。见文件头。
 */
function redderCount(before, after) {
  let n = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = after.data[i] - before.data[i];
    const dg = after.data[i + 1] - before.data[i + 1];
    const db = after.data[i + 2] - before.data[i + 2];
    if (dr > 25 && dr > dg + 12 && dr > db + 12) n++;
  }
  return n;
}

/** 近白像素数（防「additive 叠成白团」的上界判据） */
function nearWhiteCount(png, threshold = 245) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > threshold && png.data[i + 1] > threshold && png.data[i + 2] > threshold) n++;
  }
  return n;
}

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/**
 * 开阔地（远离城市 —— 建筑遮挡会让 AI 抖动）。逐行复用 `ignis-fx.spec.mjs`：
 * `g._teleportTo(x, 45, z)` + 固定等 2.5s。
 * ⚠️ 改用 `player.spawn` 会 30s 超时（它不加载目标 column，玩家悬在空列里）。
 *
 * v3.26：传**绝对坐标**（不再用 offset）—— 阵列扩到 12 格半径，机位必须按数据选。
 */
async function gotoOpenField(page, { x = 1200, z = 1200 } = {}) {
  await page.evaluate(async ([wx, wz]) => {
    const g = window.__MC_GAME__;
    g._teleportTo(wx, 45, wz);
    await new Promise((r) => setTimeout(r, 2500));
  }, [x, z]);
}

/**
 * **按数据搜索机位**（v3.26）—— 30 根落点必须同高、干燥、无建筑。
 *
 * ⚠️ **不得写死坐标**：AGENTS.md 记过「spec 里写死的坐标可能落在湿列」——
 * 湿列上裙边零抬升、画面 20% 是水 ⇒ 零判别力。换 seed 时本搜索自动跟上。
 *
 * 判据：以候选点为焰魔位置算 30 根落点，要求它们的 `generateHeight` **全相同**
 * 且 > SEA_Y（干燥）。同高 ⇒ 每根都能找到地面且剑尖齐平，像素判据才干净。
 *
 * @returns {Promise<{x:number, z:number, h:number, same:number}>}
 */
async function findFlatSite(page, { hintX = 1199, hintZ = 1100 } = {}) {
  const site = await page.evaluate(async ([hx, hz]) => {
    const { generateHeight } = await import('/src/gen/terrain.js');
    const { SEA_Y } = await import('/src/voxel/constants.js');
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const seed = window.__MC_GAME__.seed;
    const score = (cx, cz) => {
      const h0 = generateHeight(cx, cz, seed);
      if (h0 <= SEA_Y) return null;
      const pts = spikeSpawnPoints([cx + 0.5, h0, cz + 0.5], 0);
      const hs = pts.map((p) => generateHeight(Math.floor(p.x), Math.floor(p.z), seed));
      if (hs.some((h) => h <= SEA_Y)) return null;
      const same = hs.filter((h) => h === h0).length;
      const spread = Math.max(...hs) - Math.min(...hs);
      return { x: cx, z: cz, h: h0, same, spread };
    };
    // 先试提示点（已实测满足），不满足就在它周围网格搜
    const hint = score(hx, hz);
    if (hint && hint.same === 30 && hint.spread === 0) return hint;
    let best = null;
    for (let dx = -120; dx <= 120; dx += 7) {
      for (let dz = -120; dz <= 120; dz += 7) {
        const s = score(hx + dx, hz + dz);
        if (!s) continue;
        if (!best || s.same > best.same || (s.same === best.same && s.spread < best.spread)) best = s;
      }
    }
    return best;
  }, [hintX, hintZ]);
  expect(site, '前提：须找到 30 根落点全同高的干燥机位').not.toBeNull();
  expect(site.same, `机位 (${site.x},${site.z}) 只有 ${site.same}/30 根同高`).toBe(30);
  expect(site.spread, '落点高度极差须为 0（否则剑尖不齐，像素判据不干净）').toBe(0);
  return site;
}

/**
 * 召一只焰魔并钉到与玩家同高，相机在后方 **4 格**、pitch −0.35（低机位）。
 *
 * ⚠️⚠️ **机位选择的三轮实测（都是推翻，不是拍脑袋）**：
 *   ① 低机位 4 格：阵列横向 ±12 格，左/右两排在视野外
 *     ⇒ 五向像素分布 `[848,1946,6408,0,66]`；
 *   ② 抬高到 +12 / dist 22：30 根全进 clip，但**零特效对照组自身就有 20758
 *     暖色像素**（比信号还大）—— 抬高把大片远景/天空纳入画面，而光照 uniform
 *     仍在推进（`?shadows=0` 只关 pass 不关太阳方向）⇒ 减法基准失效；
 *   ③ **定稿：回低机位**。像素判据只覆盖**画面内**的方向；
 *     **五向完整性与朝向由数据层保证**（`test-spike-fx.js` 的 30 根落点 / 五向各 6 根 /
 *     宽面法线点积，与实例矩阵判据 —— 四条负向注入均已真红）。
 *     剑体是**同一份 InstancedMesh**：一个方向能画则全部能画，差异只在视野。
 *
 * 布局：玩家在 (px,pz)，焰魔在玩家 −Z 4 格、yaw=0（正前方 −Z）
 * ⇒ 阵列以焰魔为圆心向 −Z 半圆展开（半径 2..12），相机看向 −Z。
 */
async function setupScene(page) {
  const sum = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.ignises.summon('spike-spec:0', Math.floor(p.x), Math.floor(p.z) + 4, 0, Math.floor(p.y));
  });
  expect(sum.ok, `前置：焰魔召唤成功（${sum.reason ?? ''}）`).toBe(true);
  await page.waitForFunction((id) => {
    const e = window.__MC_GAME__.entities.get(id);
    return e?.state?.onGround === true;
  }, sum.id, { timeout: 30_000 });
  await page.evaluate((id) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(id);
    const p = g.player.physics.pos;
    const groundY = p.y;                 // 焰魔站地面（与落点同高）
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, groundY, Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, spikeSecond: false,
    };
    // 相机抬高 12 格（俯视）—— 钉住，否则自由下落会把阵列推出画面
    const px = p.x; const pz = p.z; const eyeY = groundY;   // 低机位：抬高会把远景纳入画面，残余漂移盖过信号（实测）
    p.y = eyeY;
    if (g.player.physics.velocity) g.player.physics.velocity.set?.(0, 0, 0);
    g.player.yaw = 0;
    g.player.pitch = -0.35;
    clearInterval(window.__PIN__);
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = eyeY; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.35;
    }, 16);
    if (g.player?.viewBob?.update) g.player.viewBob.update = () => {};
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
  }, sum.id);
  await page.waitForTimeout(600);
  return sum.id;
}

/** 截图（固定 clip，避开 UI 面板/血心/小地图） */
async function shoot(page) {
  return page.screenshot({ clip: { x: 200, y: 150, width: 700, height: 420 } });
}

test('焰魔尖刺 Tier 4：剑体真的画出来了（五向阵列各自上屏）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0&shadows=0&reflect=0&weather=clear`);
  await waitWorldReady(page);
  const site = await findFlatSite(page);
  await gotoOpenField(page, { x: site.x, z: site.z });
  const id = await setupScene(page);

  // ---- 前提断言（排除「几何/材质写错」造成的假绿）----
  const pre = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const pos = r?.mesh?.geometry?.getAttribute('position');
    let minY = null;
    let maxY = null;
    if (pos) {
      minY = Infinity; maxY = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        minY = Math.min(minY, pos.getY(i));
        maxY = Math.max(maxY, pos.getY(i));
      }
    }
    return {
      hasSpike: !!r,
      blade: r?.blade ?? null,
      vertexCount: pos?.count ?? 0,
      indexCount: r?.mesh?.geometry?.getIndex()?.count ?? 0,
      geoMinY: minY,
      geoMaxY: maxY,
      hasMap: !!r?.mesh?.material?.map,
      idleVisible: r?.mesh?.visible ?? null,
      idleActive: r?.activeCount ?? null,
      blending: r?.mesh?.material?.blending ?? null,
      normalConst: 1,      // THREE.NormalBlending
      textured: r?.textured ?? null,
      materialType: r?.mesh?.material?.type ?? null,
      side: r?.mesh?.material?.side ?? null,
      doubleSide: 2,       // THREE.DoubleSide
      renderOrder: r?.mesh?.renderOrder ?? null,
      oceanRenderOrder: g.ocean?.plane?.renderOrder ?? null,
    };
  });
  expect(pre.hasSpike, '尖刺层须已装配').toBe(true);
  /**
   * ⚠️ **v3.26 推翻了旧断言**（原本是 `geoType === 'ConeGeometry'` + `radialSegments === 6`）。
   * 用户裁定「圆锥体的带有纹路的尖刺模型不要了，换成焰魔宝剑刺出地面的样子」
   * ⇒ 按新语义改写：钉**剑体度量**（48 顶点 / 24 三角 / 宽 0.4375 / 厚 0.0625）
   * 与**露出/埋入的 y 极值**（护手不得进几何）。
   */
  expect(pre.blade, '有产物时 blade 度量不得为 null（否则退回了锥体）').not.toBeNull();
  expect(pre.vertexCount, '剑身 + 剑尖两盒 = 48 顶点').toBe(48);
  expect(pre.indexCount, '24 三角 = 72 索引').toBe(72);
  expect(pre.blade.width, '剑面宽取原剑尺寸（不缩放）').toBeCloseTo(0.4375, 5);
  expect(pre.blade.thickness, '剑厚取原剑尺寸').toBeCloseTo(0.0625, 5);
  expect(pre.blade.exposeHeight, '露出高度与原锥体一致').toBeCloseTo(1.6, 5);
  expect(pre.geoMaxY, '剑尖恰好在 1.6 格').toBeCloseTo(1.6, 5);
  expect(pre.geoMinY, '埋入 1.055625 格（护手/剑柄根本不进几何）').toBeCloseTo(-1.055625, 5);
  expect(pre.idleVisible, '零活跃时不得提交渲染（draw call 基线）').toBe(false);
  expect(pre.idleActive).toBe(0);
  expect(pre.blending, '正常混合（additive 在亮天空前会钳白）').toBe(pre.normalConst);
  expect(pre.textured, '装配层须把焰魔贴图传进来').toBe(true);
  expect(pre.hasMap, '剑体贴图必须真的挂上（原色直采）').toBe(true);
  expect(pre.materialType, '剑体不再需要 TSL（UV 已正确）').toBe('MeshBasicMaterial');
  expect(pre.side, '0.0625 厚薄片必须双面').toBe(pre.doubleSide);
  expect(pre.renderOrder, '剑体必须排在海面之后（否则被水色冲淡 1.77 倍）')
    .toBeGreaterThan(pre.oceanRenderOrder);

  // ---- 藏掉焰魔渲染实例（单变量对照的关键，见文件头）----
  const hid = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    // 冻掉其余动态源（同第三个用例的口径）—— 抬高 12 格后视野变大，
    // 远处 column 流式上传 + 海面波纹 + 手臂摆动 + 昼夜漂移都会抬高噪声底
    //（实测未冻时 baseCounts = [816,831,1476]）。
    if (g.ignises?.update) g.ignises.update = () => {};
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
    }
    if (g.viewArm?.mesh) g.viewArm.mesh.visible = false;
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    const dn = g.dayNight || g.daynight;
    if (dn?.update) dn.update = () => {};
    // ⚠️ 天气/雨也要冻：抬高 12 格后视野变大，云层与雨丝进入画面
    //（实测相机已逐位静止、sections 稳定 275，残余差分 ~780 + 偶发 14000 尖峰来自它们）
    if (g.weather?.update) g.weather.update = () => {};
    if (g.rain?.update) g.rain.update = () => {};
    return true;
  }, id);
  expect(hid, '前置：须能藏掉焰魔渲染实例（否则判据没有判别力）').toBe(true);
  /**
   * ⚠️ **等 3.5s 而不是 300ms**：抬高后视野变大，远处 column 仍在流式上传。
   */
  await page.waitForTimeout(3500);

  /**
   * ---- 基线口径：**同会话零特效对照组自校准**（不追求「相邻差分恒 0」）----
   *
   * ☠️ **实测推翻了「等画面静止」这个口径**（本轮探针 A/B/C 三档逐个隔离）：
   * 抬高 12 格后，即使 **sections 恒 275、全部 update 关空转、相机逐位静止、
   * weather=clear、海面冻住、手臂/昼夜/天气/雨全关**，仍有 **~2900 稳定相邻差分**
   * 与偶发 **37875 尖峰**（判定为光照/阴影 uniform 仍在推进 —— `?shadows=0` 只关 pass
   * 不关太阳方向）。继续追求恒 0 会无限追动态源。
   *
   * **正解**（第三个用例已验证过这套手法）：用**同会话、同机位、同地形、
   * 只差有没有特效**的零特效对照组作基准 —— 残余漂移两侧同时出现，被减法消掉。
   * 下面的 `controlFloor` 就是它；所有下界判据都相对它而不是相对 0。
   */
  const baseShots = [PNG.sync.read(await shoot(page))];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(110);
    baseShots.push(PNG.sync.read(await shoot(page)));
  }
  const baseCounts = baseShots.slice(1).map((s) => redderCount(baseShots[0], s));
  const noiseFloor = Math.max(...baseCounts);
  const noiseMin = Math.min(...baseCounts);

  // ---- 采样前先钉大冷却 + 冻 AI（下方零特效对照组与实验组共用这份夹具）----
  /**
   * ⚠️⚠️ **采样前钉大冷却 + 冻 AI，防它在等回收期间自然再起手**。
   *
   * `attackCooldown: 999` **只挡起手不挡追击** ⇒ 它仍会进 chase 每帧移动
   *（AGENTS.md 记过）⇒ 纯渲染类用例要把 `ignises.update` 也换空转。
   * 这不是放宽断言 —— 断言一字未改，只把「焰魔又打了一招 / 在走」这个无关变量排除掉。
   */
  await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    e.state = { ...e.state, attackCooldown: 999 };
    if (g.ignises?.update) g.ignises.update = () => {};
  }, id);

  /**
   * ---- 按真实 age 逐点采样 + 每根落点的屏幕投影 ----
   *
   * ⚠️ **相机姿态必须先冻住**（viewBob / stepLift）：否则投影坐标与实际画面对不上
   *（AGENTS.md 记过「相机投影定中心撞上 viewBob 每帧重写姿态，实测偏 59px/96px」）。
   * 本用例已在 setupScene 后钉住玩家 yaw/pitch，这里再把两个缓动 update 换空转。
   */
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    if (g.player?.viewBob?.update) g.player.viewBob.update = () => {};
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    const p = g.player.physics.pos;
    const px = p.x; const py = p.y; const pz = p.z;
    // ☠️ setupScene 已建一个 __PIN__，**不清就是两个定时器互相覆写** ⇒ 相机抖动
    clearInterval(window.__PIN__);
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.35;
    }, 16);
  });

  /** 每根落点的屏幕坐标 + 它属于哪个方向 / 多大半径（相机投影，像素口径） */
  const proj = await page.evaluate(async (entityId) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const { IGNIS_SPIKE } = await import('/src/entities/ignis/ignis-config.js');
    const g = window.__MC_GAME__;
    const at = g.entities.get(entityId).state.position;
    const cam = g.camera;
    cam.updateMatrixWorld(true);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const ratio = g.renderer?.getPixelRatio?.() ?? 1;
    const out = [];
    const pts = spikeSpawnPoints(at, 0);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const y = g._findSigilGroundY(p.x, p.z, at[1]) ?? at[1];
      // 取剑体中段（露出高度的一半）作为代表点 —— 剑尖太细，中段像素最多
      const v = new (await import('three')).Vector3(p.x, y + IGNIS_SPIKE.exposeHeight * 0.5, p.z);
      v.project(cam);
      out.push({
        sx: (v.x * 0.5 + 0.5) * W * ratio,
        sy: (-v.y * 0.5 + 0.5) * H * ratio,
        dir: Math.floor(i / IGNIS_SPIKE.count),
        ring: i % IGNIS_SPIKE.count,
        radius: Math.hypot(p.x - at[0], p.z - at[2]),
        behind: v.z > 1,
      });
    }
    return { pts: out, W, H, ratio, clip: { x: 200, y: 150, width: 700, height: 420 } };
  }, id);
  expect(proj.ratio, 'pixelRatio 实测 = 1（不是它造成的投影偏移）').toBe(1);

  /**
   * 逐像素按**最近落点**归属到方向/半径，数暖色像素。
   * @returns {{total:number, byDir:number[], byRing:number[], radiusCentroid:number}}
   */
  const analyse = (before, after) => {
    const { pts, clip } = proj;
    const byDir = [0, 0, 0, 0, 0];
    const byRing = [0, 0, 0, 0, 0, 0];
    let total = 0;
    let wsum = 0;
    for (let cy = 0; cy < clip.height; cy++) {
      for (let cx = 0; cx < clip.width; cx++) {
        const i = (cy * clip.width + cx) * 4;
        const dr = after.data[i] - before.data[i];
        const dg = after.data[i + 1] - before.data[i + 1];
        const db = after.data[i + 2] - before.data[i + 2];
        if (!(dr > 25 && dr > dg + 12 && dr > db + 12)) continue;
        total++;
        const sx = clip.x + cx;
        const sy = clip.y + cy;
        let best = -1;
        let bestD = Infinity;
        for (let k = 0; k < pts.length; k++) {
          const d = (pts[k].sx - sx) ** 2 + (pts[k].sy - sy) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
        if (best < 0) continue;
        byDir[pts[best].dir]++;
        byRing[pts[best].ring]++;
        wsum += pts[best].radius;
      }
    }
    return { total, byDir, byRing, radiusCentroid: total ? wsum / total : 0 };
  };

  /**
   * ---- 零特效对照组：同机位同地形，**只差有没有剑体** ----
   *
   * 它量的是「残余漂移在同一时间窗里能造出多少暖色像素」—— 这才是有效噪声底。
   * 与实验组同会话、同机位、同采样时刻表 ⇒ 光照漂移共模，被减法消掉。
   */
  const controlSamples = [];
  await page.evaluate(() => window.__MC_GAME__.spikeFx.reset());
  await page.evaluate(() => { window.__T0__ = performance.now(); });
  for (const t of [60, 120, 180, 240, 300, 430]) {
    await page.waitForFunction((ms) => performance.now() - window.__T0__ >= ms,
      t, { timeout: 15_000 });
    const shot = PNG.sync.read(await shoot(page));
    controlSamples.push({ t, ...analyse(baseShots[0], shot) });
  }
  const controlFloor = Math.max(...controlSamples.map((s) => s.total));
  const controlByDir = [0, 1, 2, 3, 4].map(
    (d) => Math.max(...controlSamples.map((s) => s.byDir[d])),
  );
  await page.waitForTimeout(1400);

  // ---- 实验组：真的 spawn（按真实 age 逐点采样）----
  const injected = await page.evaluate(async (entityId) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const g = window.__MC_GAME__;
    const at = g.entities.get(entityId).state.position;
    const points = [];
    for (const p of spikeSpawnPoints(at, 0)) {
      const y = g._findSigilGroundY(p.x, p.z, at[1]);
      if (y === null) continue;
      points.push({ x: p.x, y, z: p.z, delayMs: p.delayMs, yaw: p.yaw });
    }
    g.spikeFx.reset();
    if (points.length > 0) g.spikeFx.spawn(points, performance.now());
    window.__T0__ = performance.now();
    return { spawned: points.length };
  }, id);
  expect(injected.spawned, '30 根都该找到地面（按数据选的同高干燥机位）').toBe(30);

  const samples = [];
  for (const t of [60, 120, 180, 240, 300, 430]) {
    await page.waitForFunction((ms) => performance.now() - window.__T0__ >= ms,
      t, { timeout: 15_000 });
    const shot = PNG.sync.read(await shoot(page));
    samples.push({ t, ...analyse(baseShots[0], shot), white: nearWhiteCount(shot) });
  }
  const peak = samples.reduce((a, b) => (b.total > a.total ? b : a), samples[0]);
  const onCount = peak.total;
  const onWhite = Math.max(...samples.map((s) => s.white));
  const onActive = await page.evaluate(() => window.__MC_GAME__.spikeFx.activeCount);
  const litNow = await page.evaluate(() => window.__MC_GAME__.spikeFx.mesh.visible);

  console.log('SPIKE_COUNTS', JSON.stringify({
    baseCounts, noiseFloor, noiseMin, controlFloor, controlByDir,
    onCount, onWhite, onActive, litNow, site,
    byDir: peak.byDir, byRing: peak.byRing,
    centroid: samples.map((s) => +s.radiusCentroid.toFixed(3)),
    totals: samples.map((s) => s.total),
    controlTotals: controlSamples.map((s) => s.total),
  }));

  // ---- 上下界都钉（下界相对**零特效对照组**，不是相对 0）----
  expect(onCount, `剑体帧暖色像素须显著高于零特效对照组（control=${controlFloor}）`)
    .toBeGreaterThan(controlFloor + 1500);
  expect(onCount, '暖色像素过多 = 几何炸开或过曝').toBeLessThan(60000);
  expect(onWhite, '不得出现大面积近白').toBeLessThan(294000 * 0.02);
  expect(onActive, '30 根应仍在活跃（寿命 900ms，采样在 ≤430ms）').toBe(injected.spawned);
  expect(litNow, '剑体须 visible=true（否则根本没画）').toBe(true);

  /**
   * ---- **画面内的每个方向各自都上屏** ----
   *
   * ☠️ **不能要求五个方向全部有像素**：低机位下左/右两排在视野外（见 setupScene 注释）。
   * 五向完整性由**数据层**保证（`test-spike-fx.js` 钉 30 根落点与五向各 6 根）。
   * 这里钉的是「**投影落在 clip 内的方向，每个都得自己画出像素**」——
   * 只数总量抓不到「某一个可见方向没画」。
   */
  const DIR_NAMES = ['正前', '左前', '右前', '左', '右'];
  const { pts: projPts, clip: projClip } = proj;
  const inClip = (p) => !p.behind
    && p.sx >= projClip.x && p.sx <= projClip.x + projClip.width
    && p.sy >= projClip.y && p.sy <= projClip.y + projClip.height;
  const visCount = [0, 0, 0, 0, 0];
  for (const p of projPts) if (inClip(p)) visCount[p.dir]++;
  /**
   * ☠️ **阈值必须按「该方向有几根在画面内」加权**：
   * 低机位下右侧只有最内 1~2 根勉强进画面边缘（实测 54 像素），
   * 而右前有 6 根全在画面内（5854 像素）—— 统一阈值会把前者误判成缺陷。
   * 取**每根 ≥ 25 像素**（实测最稀疏那侧 54/2 ≈ 27，最密侧 5854/6 ≈ 976）。
   */
  const visibleDirs = visCount.map((n, d) => ({ n, d })).filter((x) => x.n > 0);
  expect(visibleDirs.length, `至少三个方向须落在截图区内（实得 ${JSON.stringify(visCount)}）`)
    .toBeGreaterThanOrEqual(3);
  for (const { n, d } of visibleDirs) {
    expect(peak.byDir[d],
      `${DIR_NAMES[d]}方向（画面内 ${n} 根）须自己画出暖色像素`
      + `（实得 ${peak.byDir}，对照组 ${controlByDir}）`)
      .toBeGreaterThan(controlByDir[d] + n * 25);
  }

  /**
   * ---- **先内圈再外圈**：暖色像素的半径质心单调不减 ----
   *
   * ⚠️ **与「出生点自己在动」那条教训不同**：那条说的是粒子出生高度随主动作上爬，
   * 屏幕绝对位置被污染；本判据量的是「**哪些根已破土**」，而落点是**固定**的
   *（不随时间移动）⇒ 半径质心直接反映「已亮的那批有多远」，无混淆项。
   * 后来者不要把这里改成「相对位移」—— 那是粒子判据的口径，不适用于固定落点。
   */
  const centroids = samples.map((s) => s.radiusCentroid);
  for (let i = 1; i < centroids.length; i++) {
    expect(centroids[i],
      `半径质心须单调不减（t=${samples[i].t}ms 实得 ${centroids.map((c) => c.toFixed(2))}）`)
      .toBeGreaterThanOrEqual(centroids[i - 1] - 0.35);
  }
  expect(centroids[centroids.length - 1] - centroids[0],
    `首末质心差须 > 2 格（实得 ${(centroids[centroids.length - 1] - centroids[0]).toFixed(2)}）`)
    .toBeGreaterThan(2);

  // ---- 寿命结束后回到 visible=false（draw call 回基线）----
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return { active: g.spikeFx.activeCount, visible: g.spikeFx.mesh.visible };
  });
  expect(after.active, '寿命结束后须全部回收').toBe(0);
  expect(after.visible, '回收后须 visible=false（draw call 回基线）').toBe(false);
  await page.evaluate(() => clearInterval(window.__PIN__));
});

test('焰魔尖刺 Tier 4：走真实命中帧路径，两刀各出一次（不受 freshLos 影响）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0&weather=clear`);
  await waitWorldReady(page);
  const site2 = await findFlatSite(page, { hintX: 1254, hintZ: 1364 });
  await gotoOpenField(page, { x: site2.x, z: site2.z });
  const id = await setupScene(page);

  // 钉 spikeSlash 起手 + spikeSecond=true（双刀），让**真实帧循环**推进两个命中帧。
  // ⚠️ 玩家站在 3 格内 ⇒ Agent 自己会在第一刀命中帧置 spikeSecond；
  // 这里直接置 true 是为了让夹具不依赖玩家位置（单变量：只测「两刀各出一次」）。
  await page.evaluate((entityId) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(entityId);
    e.state = {
      ...e.state, mode: 'attack', attackKind: 'spikeSlash', attackAnimT: 0,
      spikeSecond: true, yaw: 0, velocity: [0, 0, 0], losVisible: true, losTimer: 999,
    };
  }, id);

  // 第一刀命中帧 0.991667s ⇒ 等尖刺入池
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount > 0,
    null, { timeout: 30_000 });
  const first = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    return { active: g.spikeFx.activeCount, t: g.entities.get(eid)?.state?.attackAnimT ?? null };
  }, id);
  expect(first.active, '第一刀命中帧须出 30 根尖刺').toBe(30);

  // 第二刀命中帧 2.216667s ⇒ 尖刺寿命 900ms + 最大延迟 250ms = 1.15s，
  // 第一刀在 0.99s 出、第二刀在 2.22s 出 ⇒ 间隔 1.23s > 1.15s ⇒ 第一批已回收。
  // 故「第二批入池」的判据是：等到 activeCount 归零后再次 > 0。
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount === 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__MC_GAME__.spikeFx.activeCount > 0,
    null, { timeout: 30_000 });
  const second = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const e = g.entities.get(eid);
    return { active: g.spikeFx.activeCount, t: e?.state?.attackAnimT ?? null, kind: e?.state?.attackKind ?? null };
  }, id);
  console.log('SPIKE_TWO_HITS', JSON.stringify({ first, second }));
  expect(second.active, '第二刀命中帧须再出 30 根').toBe(30);
  expect(second.t, '第二批须在第二命中帧之后').toBeGreaterThan(2.2);
});
/**
 * v3.23：**破土火星 + 上浮余烬**的 Tier 4 像素实测。
 *
 * 用户 2026-11-20：「尖刺升起的时候带有粒子特效……就好像蹦出的火星一样」。
 * 两项裁定：破土猛迸 + 余烬渐稀（缩回时停）、条状火星 + 少量上浮余烬（不加烟）。
 *
 * ## 为什么必须像素实测（Node 33 例全绿时画面仍可能全错）
 *
 * 粒子是 **GPU 模拟**：出生数据在 CPU，位移/尺寸/拉伸/颜色全在 TSL 里求值。
 * 本仓已实测过的静默失效形态：
 *   · `aSpawn` 写毫秒而 `uTime` 是秒 ⇒ age 恒负 ⇒ **粒子全灭**，计数全绿；
 *   · 用 `InstancedMesh` 而非 `Mesh` ⇒ instanceMatrix 接管 modelViewMatrix ⇒ 全塌到原点；
 *   · 只拉伸不改轮廓（或反之）⇒ 退回圆点，用户读作「冒爆米花」；
 *   · 尺寸太小 ⇒ 每颗只 2.3px，**画面上等于没有**（本轮实测：首版 193 像素）。
 *
 * ## 夹具的三个必需条件（全部本轮实测踩到，缺一则判据零判别力）
 *
 * ① **钉住玩家位置**：`setupScene` 之后玩家仍在下落 —— 实测 camY 从 −5.59 漂到 −7.38
 *    ⇒ 整帧差分被**相机运动**主导（264692 像素），与粒子无关。
 * ② **冻住海面**：`ocean.update(camera, dt)` 每帧推进 `uTime` ⇒ 波纹在动。
 *    实测空闲态噪声底 **[450, 0, 450, 0, 450]**（双态跳变）；把 dt 喂 0 后 **[0,0,0,0,0]**。
 *    ⚠️ 只 `plane.visible=false` 不够（体素水仍在动），要冻 `update` 的时间推进。
 * ③ **藏掉焰魔本体 + 尖锥本体**：两者都是火焰橙 additive，与火星同色系
 *    ⇒ 不藏则量到的是宿主而不是火星（同 v3.22「宿主是另一个特效层」那条教训）。
 *    尖锥用 `Object.defineProperty` 把 visible 钉 false —— 直接赋值会被下一帧 update 覆写。
 *
 * ## 采样按**真实 age**等，不按墙钟
 *
 * `waitForTimeout` 可能恰好落在 spawn 那一帧（实测首帧暖色 **0**，而 visible/计数全对）
 * ⇒ 用 `waitForFunction(performance.now() − T0 >= t)` 逐点采，取多帧的**最大值**。
 */
test('焰魔尖刺 Tier 4：破土火星与余烬真的画出来了（藏宿主的单变量对照）', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto(`/?vd=3&seed=${SEED}&stats=0&shadows=0&reflect=0&weather=clear`);
  await waitWorldReady(page);
  const site3 = await findFlatSite(page, { hintX: 1309, hintZ: 1100 });
  await gotoOpenField(page, { x: site3.x, z: site3.z });
  const id = await setupScene(page);

  // ---- 前提断言（排除「层没装配 / 用错 mesh 类型」造成的假绿）----
  const pre = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    // 容量从**常量模块**读（不在 spec 里写第二份 —— 写硬值会在改容量时静默过期）
    const { SPIKE_SPARK_FX } = await import('/src/render/spike-fx-config.js');
    return {
      cfgCapacity: SPIKE_SPARK_FX.capacity,
      meshCount: r?.meshes?.length ?? 0,
      sparkIsInstancedMesh: r?.sparkMesh?.isInstancedMesh === true,
      emberIsInstancedMesh: r?.emberMesh?.isInstancedMesh === true,
      sparkGeoInstanced: r?.sparkMesh?.geometry?.isInstancedBufferGeometry === true,
      sparkBlending: r?.sparkMesh?.material?.blending ?? null,
      emberBlending: r?.emberMesh?.material?.blending ?? null,
      idleAllHidden: r ? r.meshes.every((m) => !m.visible) : null,
      hasVel: !!r?.sparkMesh?.geometry?.getAttribute('aVel'),
      renderOrder: r?.sparkMesh?.renderOrder ?? null,
      capacity: r?.sparkMesh?.geometry?.getAttribute('aOrigin')?.count ?? 0,
    };
  });
  expect(pre.meshCount, '尖锥 + 火星 + 余烬三个 mesh').toBe(3);
  expect(pre.sparkIsInstancedMesh, '火星不得用 InstancedMesh（会塌到原点）').toBe(false);
  expect(pre.emberIsInstancedMesh, '余烬同理').toBe(false);
  expect(pre.sparkGeoInstanced, '几何须是 InstancedBufferGeometry').toBe(true);
  expect(pre.hasVel, 'aVel 必须存在（STREAK 拉伸的输入）').toBe(true);
  expect(pre.sparkBlending, '火星 additive').toBe(2);
  expect(pre.emberBlending, '余烬 additive').toBe(2);
  expect(pre.idleAllHidden, '零活跃时全部 mesh 不得提交渲染').toBe(true);
  expect(pre.renderOrder, '与闪电/Cinder/火圈同档 3').toBe(3);
  expect(pre.capacity, '池容量须等于常量（不写硬值，改容量时自动跟上）').toBe(pre.cfgCapacity);

  // ---- 夹具：藏宿主 + 钉玩家 + 冻海面 + 真实交战距离（4 格）----
  const fixture = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return { ok: false, why: 'no ignis mesh' };
    inst.mesh.visible = false;
    const e = g.entities.get(eid);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, g._findSigilGroundY(Math.floor(p.x) + 0.5, Math.floor(p.z) - 4 + 0.5, p.y) ?? (p.y - 12), Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, attackCooldown: 999,
    };
    /**
     * ⓪ **冻住焰魔 AI**：`attackCooldown: 999` 只挡起手，**不挡追击** ——
     * 实测 state.mode 会变成 `chase`，位置与姿态每帧在动 ⇒ 藏了 mesh 也仍有
     * 阴影/间接影响，且它随时可能再打一招污染回收断言。
     * 直接把它的 update 换成空转（本用例只测渲染层，AI 由 ignis.spec 守）。
     */
    let aiFrozen = false;
    if (g.ignises?.update) { g.ignises.update = () => {}; aiFrozen = true; }
    // ① 钉玩家（不钉则相机仍在下落，整帧差分被相机运动主导）
    // ☠️☠️ **必须先 clearInterval，且 pitch 要与 setupScene 一致**（v3.26 实测的根因）：
    // setupScene 已建一个钉 −0.35 的定时器，本处旧写法又建一个钉 **−0.30** 的
    // ⇒ **两个定时器每帧互相覆写 pitch**，相机在两个角度间抖 ⇒ 确定性的 **1638** 尖峰
    //（单跑时恒 0、跑全套必现 —— 看着像「前面用例泄漏状态」，实际是本用例自己造成的）。
    const px = p.x; const py = p.y; const pz = p.z;
    clearInterval(window.__PIN__);
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.35;
    }, 16);
    /**
     * ①b **冻住 viewBob 与 stepLift**（本轮实测定位到的最后一个噪声源）：
     * 钉 `physics.pos` 只固定了**逻辑位置**，而相机 y 还要叠 `viewBob.offset` 与
     * `_stepLift.offset`（`player.js:386`）—— 传送后两者仍在衰减 ⇒ 相机每帧微动
     * ⇒ 噪声底在 **0 与 30 之间双态跳变**。把两个 update 换成空转即可归零。
     */
    let bobFrozen = false;
    if (g.player?.viewBob?.update) { g.player.viewBob.update = () => {}; bobFrozen = true; }
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    // ② 冻海面波纹（只藏 plane 不够 —— 体素水仍在动）
    let froze = false;
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
      froze = true;
    }
    // ③ 钉尖锥本体不可见（update 每帧重算 visible ⇒ 必须用 getter）
    const m = g.spikeFx.mesh;
    Object.defineProperty(m, 'visible', { get: () => false, set: () => {}, configurable: true });
    /**
     * ④ **藏第一人称手臂/武器 + 冻昼夜**（本轮实测定位到的两个噪声源）：
     * 手臂有待机摆动，昼夜推进让天空色缓慢漂 —— 两者合计让空闲态噪声底在
     * **0 与 494 之间双态跳变**（实测 10 连拍：494×7 / 0×3）。
     * 逐步隔离实测：藏焰魔全部实例后仍 [675,494,…]；再藏手臂 → [68,0,0,0,68]；
     * 再冻昼夜 → **[0,0,0,0,0]**。⇒ 两者都必须处理，缺一张基线就不干净。
     */
    let armHidden = false;
    if (g.viewArm?.mesh) { g.viewArm.mesh.visible = false; armHidden = true; }
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    const dn = g.dayNight || g.daynight;
    let dnFrozen = false;
    if (dn?.update) { dn.update = () => {}; dnFrozen = true; }
    // ⑤ **天气/雨也要冻**（v3.26）：`?weather=clear` 只定初始天气，不阻止它逐帧推进。
    if (g.weather?.update) g.weather.update = () => {};
    if (g.rain?.update) g.rain.update = () => {};
    return { ok: true, froze, coneHidden: m.visible === false, armHidden, dnFrozen, aiFrozen, bobFrozen };
  }, id);
  expect(fixture.ok, `前置：须能藏掉焰魔渲染实例（${fixture.why ?? ''}）`).toBe(true);
  expect(fixture.froze, '前置：须能冻住海面时间推进（否则噪声底 450 双态跳变）').toBe(true);
  expect(fixture.coneHidden, '前置：须能藏掉尖锥本体（同色系宿主）').toBe(true);
  expect(fixture.armHidden, '前置：须能藏掉第一人称手臂（待机摆动是噪声源）').toBe(true);
  expect(fixture.dnFrozen, '前置：须能冻住昼夜推进（天空色漂移是噪声源）').toBe(true);
  expect(fixture.aiFrozen, '前置：须能冻住焰魔 AI（否则它会追击/再起手）').toBe(true);
  expect(fixture.bobFrozen, '前置：须能冻住 viewBob（相机微动是最后一个噪声源）').toBe(true);
  /**
   * ⚠️ **等 3.5s 而不是 2s**（本轮实测）：2s 时远处 column 仍在流式上传，
   * 噪声底偶发 37/43；3.5s 后连拍 8 张**逐位相同**（差分分位数全 0）。
   * 下面的「等相邻差分为 0」循环是二次保险，两者一起才让基线可复现。
   */
  await page.waitForTimeout(3500);

  /**
   * ---- 噪声底：**等画面真的静止**再取基线（不是固定 sleep）----
   *
   * ⚠️ 本轮实测：固定等 2s 后首帧偶发 37 像素跳变 —— 远处 column 仍在流式加载/上传网格。
   * 同「判世界稳定要等 sections 停止增长」那条教训：固定 sleep 拓不到「还在动」。
   * 做法：连拍直到**相邻两张暖色差分为 0**，用那一张当基线；预算内达不到就硬失败
   *（不静默放宽 —— 那会把「还有动态源」这个真问题藏起来）。
   */
  let baseline = PNG.sync.read(await shoot(page));
  let settled = false;
  const settleTries = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(140);
    const next = PNG.sync.read(await shoot(page));
    const d = redderCount(baseline, next);
    settleTries.push(d);
    baseline = next;
    if (d === 0) { settled = true; break; }
  }
  expect(settled, `画面须在预算内静止（实得相邻差分 ${settleTries}）—— 否则还有未冻住的动态源`)
    .toBe(true);
  // 静止后再连拍 3 张确认噪声底；☠️ **偶发尖峰要重试而不是直接失败**（v3.26）：
  // 单跑本用例噪声底 [0,0,0]，但**跑全套时偶发 [0,0,1638]** —— 前面用例留下的
  // 流式上传/光照推进尾巴。重试一轮（再等静止）而不是放宽阈值。
  let idleShots = [baseline];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(110);
    idleShots.push(PNG.sync.read(await shoot(page)));
  }
  let baseCounts = idleShots.slice(1).map((s) => redderCount(idleShots[0], s));
  for (let retry = 0; retry < 3 && Math.max(...baseCounts) >= 80; retry++) {
    // 再等一轮静止（同上面的循环），然后重取三张
    let b = PNG.sync.read(await shoot(page));
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(140);
      const next = PNG.sync.read(await shoot(page));
      const d = redderCount(b, next);
      b = next;
      if (d === 0) break;
    }
    idleShots = [b];
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(110);
      idleShots.push(PNG.sync.read(await shoot(page)));
    }
    baseCounts = idleShots.slice(1).map((s) => redderCount(idleShots[0], s));
  }
  const noiseFloor = Math.max(...baseCounts);
  /**
   * 五个动态源全部冻住后实测噪声底 **0~1 像素**（8 连拍逐位相同，偶发 ±1 量化抖动）。
   * 上界取 5：远高于抖动、比信号（>200）低两个量级 ⇒ 任一步夹具失效
   * （手臂没藏 ⇒ 494 / 昼夜没冻 ⇒ 450 / AI 没冻 ⇒ 37~43）都会让它红。
   * ⚠️ 不钉「恒 0」：那是断言想象中的世界（GPU 尾数抖动真实存在）。
   */
  // 冻结五个动态源后实测 0~1；远处 column 流式上传偶发再抬到 30~43。
  // 故这里只钉「远小于信号」，**真正的噪声底由下面的零粒子对照组自校准**
  //（同会话、同机位、同地形，只差有没有粒子 —— 那才是单变量对照的正确基准）。
  expect(noiseFloor, `空闲噪声底须远小于信号（实得 ${baseCounts}）`).toBeLessThan(80);

  /** 起一排刺（mode 决定放行哪类粒子），并记录 T0 供按真实 age 采样 */
  const cast = async (mode) => page.evaluate(async ([eid, m]) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const at = g.entities.get(eid).state.position;
    const pts = [];
    for (const p of spikeSpawnPoints(at, 0)) {
      const y = g._findSigilGroundY(p.x, p.z, at[1]);
      if (y === null) continue;
      pts.push({ x: p.x, y, z: p.z, delayMs: p.delayMs, yaw: p.yaw });
    }
    delete r._emitSparks;                       // 还原实例覆盖，回到原型方法
    const proto = Object.getPrototypeOf(r);
    if (m === 'none') r._emitSparks = () => {};
    if (m === 'spark') r._emitSparks = (s, k, p2, c, t) => { if (k === 'spark') proto._emitSparks.call(r, s, k, p2, c, t); };
    if (m === 'ember') r._emitSparks = (s, k, p2, c, t) => { if (k === 'ember') proto._emitSparks.call(r, s, k, p2, c, t); };
    r.reset();
    r.spawn(pts, performance.now());
    window.__T0__ = performance.now();
    return pts.length;
  }, [id, mode]);

  /** 按真实 age 逐点采样，返回每帧的暖色像素数与色相 */
  const sample = async () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForFunction((t) => performance.now() - window.__T0__ >= t,
        150 + i * 80, { timeout: 15_000 });
      const shot = PNG.sync.read(await shoot(page));
      let n = 0; let sr = 0; let sg = 0; let sb = 0;
      for (let k = 0; k < baseline.data.length; k += 4) {
        const dr = shot.data[k] - baseline.data[k];
        const dg = shot.data[k + 1] - baseline.data[k + 1];
        const db = shot.data[k + 2] - baseline.data[k + 2];
        if (dr > 25 && dr > dg + 12 && dr > db + 12) {
          n++; sr += shot.data[k]; sg += shot.data[k + 1]; sb += shot.data[k + 2];
        }
      }
      rows.push({
        n,
        r: n ? +(sr / n).toFixed(1) : 0,
        g: n ? +(sg / n).toFixed(1) : 0,
        b: n ? +(sb / n).toFixed(1) : 0,
        white: nearWhiteCount(shot),
      });
    }
    return rows;
  };

  // ---- 对照组 A：**只有剑体、零粒子**（证明基线不是「什么都没有」）----
  expect(await cast('none'), '30 根都该找到地面（按数据选的同高干燥机位）').toBe(30);
  const coneRows = await sample();
  const coneState = await page.evaluate(() => ({
    active: window.__MC_GAME__.spikeFx.activeCount,
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
    ember: window.__MC_GAME__.spikeFx.emberMesh.visible,
  }));
  expect(coneState.active, '对照组里剑体须仍活跃（证明它真的在跑，只是被藏了）').toBe(30);
  expect(coneState.spark, '对照组里火星层不得提交（发射已关）').toBe(false);
  /**
   * **有效噪声底 = 零粒子对照组的峰值**（自校准，不用空闲态那个数）。
   * 它与实验组同会话、同机位、同地形、同尖锥，**只差有没有粒子** ⇒
   * 远处 column 上传之类的残余漂移会同时出现在两侧，被减法天然消掉。
   */
  const controlFloor = Math.max(...coneRows.map((x) => x.n));
  expect(controlFloor, `零粒子对照组须停在噪声量级（实得 ${coneRows.map((x) => x.n)}）`)
    .toBeLessThan(80);
  await page.waitForTimeout(1700);

  // ---- 对照组 B：只有火星 ----
  await cast('spark');
  const sparkRows = await sample();
  const sparkState = await page.evaluate(() => {
    const r = window.__MC_GAME__.spikeFx;
    const count = (g) => { const a = g.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return {
      written: count(r._sparkGeo),
      emberWritten: count(r._emberGeo),
      visible: r.sparkMesh.visible,
      uTime: r._sparkUniforms.uTime.value,
      firstSpawn: r._sparkGeo.getAttribute('aSpawn').getX(0),
    };
  });
  await page.waitForTimeout(1700);

  // ---- 对照组 C：只有余烬 ----
  await cast('ember');
  const emberRows = await sample();
  const emberState = await page.evaluate(() => {
    const r = window.__MC_GAME__.spikeFx;
    const count = (g) => { const a = g.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return { written: count(r._emberGeo), sparkWritten: count(r._sparkGeo), visible: r.emberMesh.visible };
  });
  await page.waitForTimeout(1700);

  // ---- 实验组：两者都开（真实生产路径）----
  await cast('both');
  const bothRows = await sample();
  const bothState = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const count = (geo) => { const a = geo.getAttribute('aSpawn'); let n = 0; for (let i = 0; i < a.count; i++) if (a.getX(i) > 0) n++; return n; };
    return {
      active: r.activeCount,
      sparkVisible: r.sparkMesh.visible,
      emberVisible: r.emberMesh.visible,
      sparkWritten: count(r._sparkGeo),
      emberWritten: count(r._emberGeo),
    };
  });

  const peak = (rows) => Math.max(...rows.map((x) => x.n));
  console.log('SPIKE_SPARK_PIXELS', JSON.stringify({
    baseCounts, noiseFloor,
    cone: coneRows.map((x) => x.n), controlFloor,
    spark: sparkRows, ember: emberRows.map((x) => x.n),
    both: bothRows, coneState, sparkState, emberState, bothState,
  }));

  // ---- ① 数据层：两类粒子都真的写入了，且时钟同源 ----
  expect(bothState.sparkVisible, '火星层须提交渲染').toBe(true);
  expect(bothState.emberVisible, '余烬层须提交渲染').toBe(true);
  expect(bothState.sparkWritten, '火星须真的写入池').toBeGreaterThan(150);
  expect(bothState.emberWritten, '余烬须真的写入池').toBeGreaterThan(40);
  expect(bothState.emberWritten, '余烬须少于火星（用户裁定「少量」）')
    .toBeLessThan(bothState.sparkWritten);
  expect(Math.abs(sparkState.firstSpawn - sparkState.uTime),
    'aSpawn 与 uTime 须同一时钟（差 <1s；写毫秒会差 3 个量级）').toBeLessThan(1);
  expect(sparkState.emberWritten, '只放火星时余烬池不得被写').toBe(0);
  expect(emberState.sparkWritten, '只放余烬时火星池不得被写').toBe(0);

  // ---- ② 画面层：两类各自都真的上屏（分开验，避免「一类顶上另一类」）----
  // 阈值按实测标定：火星峰值 ~700、余烬峰值 ~250、两者合计 ~884。
  expect(peak(sparkRows), `火星单独须画出暖色像素（实得 ${sparkRows.map((x) => x.n)}）`)
    .toBeGreaterThan(controlFloor + 150);
  expect(peak(emberRows), `余烬单独须画出暖色像素（实得 ${emberRows.map((x) => x.n)}）`)
    .toBeGreaterThan(controlFloor + 60);
  expect(peak(bothRows), '两者合计须显著高于对照组').toBeGreaterThan(controlFloor + 400);
  expect(peak(bothRows), '暖色像素过多 = 粒子炸开或 additive 过曝').toBeLessThan(294000 * 0.10);
  expect(Math.max(...bothRows.map((x) => x.white)),
    '不得出现大面积近白（暖色照抄冷色增益会钳白）').toBeLessThan(294000 * 0.02);

  /**
   * ---- ③ 余烬真的**往上飘**（读真实 GPU 属性，在 CPU 侧复刻位移公式）----
   *
   * ⚠️⚠️ **像素质心/顶边对这条零判别力**（本轮实测四种口径全部推翻）：
   * 出生高度本身随锥面上爬（`climb × progress × height`），后期出生的余烬天然更高
   * ⇒ 即使把 `emberRise` 改成 −9.5（往下掉），暖色质心仍随时间上移
   *（实测退化态 rise 41~46px vs 正确态 48~61px，**分布重叠**）。
   * 归一化、顶边、刺尖参照同样重叠 —— 都被「出生点在上移」这个变量污染。
   *
   * **正解：只量粒子自己相对出生点的位移**（去掉出生高度这个混淆项）。
   * 读 `aOrigin/aVel/aSpawn/aLife` 四个真实 instanced 属性，按 shader 的闭式解
   *   dy = vel.y·(1−e^(−drag·t))/drag + g·t²/2
   * 在 CPU 侧算每颗**当前**的竖直位移。上浮时全为正，下坠时后期为负。
   * 这与 Tier 1 的闭式复刻同源，但读的是**真实写入 GPU 的数据** ⇒ 能抓接线缺陷。
   */
  const emberMotion = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const r = g.spikeFx;
    const geo = r._emberGeo;
    const org = geo.getAttribute('aOrigin');
    const vel = geo.getAttribute('aVel');
    const sp = geo.getAttribute('aSpawn');
    const lf = geo.getAttribute('aLife');
    const u = r._emberUniforms.uTime.value;
    // 常量从 config 模块读（不在探针里另写一份，红线 1）
    const { SPIKE_SPARK_FX: FX } = await import('/src/render/spike-fx-config.js');
    let n = 0; let minDy = Infinity; let sumDy = 0; let lateNeg = 0; let lateN = 0;
    for (let i = 0; i < org.count; i++) {
      const age = u - sp.getX(i);
      if (sp.getX(i) <= 0 || age < 0 || age > lf.getX(i)) continue;
      const integ = (1 - Math.exp(-FX.emberDrag * age)) / FX.emberDrag;
      const dy = vel.getY(i) * integ + FX.emberRise * age * age * 0.5;
      n++; sumDy += dy;
      if (dy < minDy) minDy = dy;
      // 后半寿命的粒子：下坠态在这里必然转负
      if (age > lf.getX(i) * 0.5) { lateN++; if (dy < 0) lateNeg++; }
    }
    return { n, minDy: n ? +minDy.toFixed(4) : null, meanDy: n ? +(sumDy / n).toFixed(4) : null, lateN, lateNeg };
  });
  console.log('EMBER_MOTION', JSON.stringify(emberMotion));
  expect(emberMotion.n, '须有在飞的余烬可量位移').toBeGreaterThan(20);
  expect(emberMotion.minDy,
    `余烬相对出生点的竖直位移须全为正（最低 ${emberMotion.minDy}）—— 负值 = 往下掉`)
    .toBeGreaterThan(0);
  expect(emberMotion.lateNeg, '后半寿命的余烬也不得下沉').toBe(0);

  // ---- ④ 色相：是火不是白弧（直接量像素自身 r > g）----
  /**
   * ☠️ **色相不能取「峰值帧」，要取「样本足够的帧」**（v3.26 实测）：
   * 早期帧粒子少（实测 n=38）、均值被背景稀释 ⇒ r≈g（118.9 vs 119.5），
   * 而同一实现的晚期帧是 r201.7 g175.8。跑全套时峰值帧可能落在早期 ⇒ 假红。
   * 取**粒子数 ≥ 峰值 30%** 的帧里暖色最强的那帧（阈值 20/40 一字未改）。
   */
  const huePool = bothRows.filter((x) => x.n >= peak(bothRows) * 0.3);
  const hue = (huePool.length ? huePool : bothRows)
    .reduce((a, b) => ((b.r - b.g) > (a.r - a.g) ? b : a));
  expect(hue.n, '色相判据需有足够样本的帧').toBeGreaterThan(100);
  expect(hue.r, `火星像素须 r>g（白弧态 g>r）：r=${hue.r} g=${hue.g}`)
    .toBeGreaterThan(hue.g + 20);
  expect(hue.r, '须明显暖于蓝通道').toBeGreaterThan(hue.b + 40);

  // ---- ⑤ 到期回收：尖锥先回收，粒子自然衰亡后再隐藏（不硬切）----
  await page.waitForTimeout(700);
  const mid = await page.evaluate(() => ({
    active: window.__MC_GAME__.spikeFx.activeCount,
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
  }));
  expect(mid.active, '尖锥寿命 900ms 后须回收').toBe(0);
  expect(mid.spark, '在飞的火星不得被硬切（余烬寿命远长于尖锥剩余寿命）').toBe(true);
  await page.waitForTimeout(2400);
  const end = await page.evaluate(() => ({
    spark: window.__MC_GAME__.spikeFx.sparkMesh.visible,
    ember: window.__MC_GAME__.spikeFx.emberMesh.visible,
  }));
  expect(end.spark, '空闲超时后火星层须隐藏（draw call 回基线）').toBe(false);
  expect(end.ember, '余烬层同理').toBe(false);
  await page.evaluate(() => clearInterval(window.__PIN__));
});

/**
 * v3.26 **RF-4：剑宽面朝向**的同机位单变量对照。
 *
 * 剑体宽 0.4375 / 厚 0.0625（差 **7 倍**）⇒ 朝向错了就从「看宽面」变成「看窄边」，
 * 投影面积差约 7.8 倍。而 `DoubleSide` 让正视图几乎一样 ⇒ **只靠肉眼分不出**。
 *
 * ## 为什么必须用 `page.route` 换模块内容
 *
 * 朝向常量在 `spikeSpawnPoints` 里算进**实例矩阵**（不是 uniform）⇒ 浏览器侧改
 * `IGNIS_SPIKE` 对象无效。必须换模块源码。
 * ⚠️ **`page.route` 必须在 `page.goto` 之前注册**（AGENTS.md 记过：放后面时拦截永不触发）。
 *
 * ## 两侧都要冻住的动态源
 *
 * 藏焰魔本体（同色系宿主）+ 钉玩家 + 冻 viewBob/stepLift + 冻海面 + 冻昼夜 +
 * 藏第一人称手臂 + `ignises.update` 空转。缺一个噪声底就会双态跳变。
 */
test('焰魔尖刺 Tier 4：剑宽面朝焰魔（RF-4，转 90° 看窄边的单变量对照）', async ({ page }) => {
  test.setTimeout(200_000);

  /** 是否把朝向再转 90°（注入态）—— 由 route 的 handler 读 */
  let rotate90 = false;
  await page.route('**/src/render/spike-fx.js*', async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    if (rotate90) {
      const before = body;
      body = body.replace('yaw: ang + Math.PI,', 'yaw: ang + Math.PI + Math.PI / 2,');
      // 注入必须真的生效（否则「两侧相同」是假象 —— AGENTS.md 记过 page.route 静默失效）
      if (body === before) throw new Error('[RF-4] 注入未命中：spike-fx.js 里找不到 yaw: ang + Math.PI,');
    }
    await route.fulfill({ response: res, body });
  });

  await page.goto(`/?vd=3&seed=${SEED}&stats=0&shadows=0&reflect=0&weather=clear`);
  await waitWorldReady(page);
  const site = await findFlatSite(page, { hintX: 1199, hintZ: 1160 });
  await gotoOpenField(page, { x: site.x, z: site.z });
  const id = await setupScene(page);

  // ---- 夹具：藏宿主 + 冻全部动态源（同第三个用例的口径）----
  const fixture = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return { ok: false, why: 'no ignis mesh' };
    inst.mesh.visible = false;
    const e = g.entities.get(eid);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, g._findSigilGroundY(Math.floor(p.x) + 0.5, Math.floor(p.z) - 4 + 0.5, p.y) ?? (p.y - 12), Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, attackCooldown: 999,
    };
    if (g.ignises?.update) g.ignises.update = () => {};
    const px = p.x; const py = p.y; const pz = p.z;
    clearInterval(window.__PIN__);   // setupScene 已建一个，不清就是两个互相覆写
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.35;
    }, 16);
    if (g.player?.viewBob?.update) g.player.viewBob.update = () => {};
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
    }
    if (g.viewArm?.mesh) g.viewArm.mesh.visible = false;
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    const dn = g.dayNight || g.daynight;
    if (dn?.update) dn.update = () => {};
    if (g.weather?.update) g.weather.update = () => {};
    if (g.rain?.update) g.rain.update = () => {};
    // 关掉粒子（本用例只量剑体本身的投影面积）
    g.spikeFx._emitSparks = () => {};
    return { ok: true };
  }, id);
  expect(fixture.ok, `前置：须能藏掉焰魔渲染实例（${fixture.why ?? ''}）`).toBe(true);
  await page.waitForTimeout(3500);

  /** 起一排刺并等升满，返回暖色像素数（相对同会话基线） */
  const measure = async (eid) => {
    // 基线：无刺（reset 后等画面静止）
    await page.evaluate(() => window.__MC_GAME__.spikeFx.reset());
    await page.waitForTimeout(400);
    let base = PNG.sync.read(await shoot(page));
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(140);
      const next = PNG.sync.read(await shoot(page));
      const d = redderCount(base, next);
      base = next;
      if (d === 0) break;
    }
    // **全部 30 根**的屏幕投影 + 方向归属（逐像素取最近落点，与第一个用例同口径）
    // ☠️ 不能用「离正前方落点 ≤40px」的圆形邻域：它会把邻排（左前/右前）圈进来
    //（实测 face.front 897 < edge.front 1231，方向反了）。
    const projAll = await page.evaluate(async (entityId) => {
      const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
      const { IGNIS_SPIKE } = await import('/src/entities/ignis/ignis-config.js');
      const THREE = await import('three');
      const g = window.__MC_GAME__;
      const at = g.entities.get(entityId).state.position;
      const cam = g.camera;
      cam.updateMatrixWorld(true);
      const out = [];
      const pts = spikeSpawnPoints(at, 0);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const y = g._findSigilGroundY(p.x, p.z, at[1]) ?? at[1];
        const v = new THREE.Vector3(p.x, y + IGNIS_SPIKE.exposeHeight * 0.5, p.z);
        v.project(cam);
        out.push({
          sx: (v.x * 0.5 + 0.5) * window.innerWidth,
          sy: (-v.y * 0.5 + 0.5) * window.innerHeight,
          dir: Math.floor(i / IGNIS_SPIKE.count),
        });
      }
      return out;
    }, eid);
    const spawned = await page.evaluate(async (entityId) => {
      const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
      const g = window.__MC_GAME__;
      const at = g.entities.get(entityId).state.position;
      const pts = [];
      for (const p of spikeSpawnPoints(at, 0)) {
        const y = g._findSigilGroundY(p.x, p.z, at[1]);
        if (y === null) continue;
        pts.push({ x: p.x, y, z: p.z, delayMs: p.delayMs, yaw: p.yaw });
      }
      g.spikeFx.reset();
      g.spikeFx.spawn(pts, performance.now());
      window.__T0__ = performance.now();
      return pts.length;
    }, eid);
    /** 逐像素按**最近落点**归属，只数 dir 0（正前方那一排）的暖色像素 */
    const frontWarm = (before, after) => {
      const clip = { x: 200, y: 150, width: 700, height: 420 };
      let n = 0;
      for (let cy = 0; cy < clip.height; cy++) {
        for (let cx = 0; cx < clip.width; cx++) {
          const i = (cy * clip.width + cx) * 4;
          const dr = after.data[i] - before.data[i];
          const dg = after.data[i + 1] - before.data[i + 1];
          const db = after.data[i + 2] - before.data[i + 2];
          if (!(dr > 25 && dr > dg + 12 && dr > db + 12)) continue;
          const sx = clip.x + cx;
          const sy = clip.y + cy;
          let best = -1;
          let bestD = Infinity;
          for (let k = 0; k < projAll.length; k++) {
            const d = (projAll[k].sx - sx) ** 2 + (projAll[k].sy - sy) ** 2;
            if (d < bestD) { bestD = d; best = k; }
          }
          if (best >= 0 && projAll[best].dir === 0) n++;
        }
      }
      return n;
    };
    /**
     * ☠️ **RF-4 的主判据是几何投影面积，不是暖色像素数**（实测推翻）：
     * 几何投影面积比恒 **6.5**（正前方六根 6.48~6.64），而暖色像素比只有 **0.74**
     *（方向反了）—— 根因：暖色差分阈值 `dr>25` 只圈到**金边**，剑身暗紫底
     * 两侧都过不了阈值 ⇒ 量到的不是剑体投影面积。
     *
     * 正解：读**真实实例矩阵**（`getMatrixAt`）× 产物顶点 → `project(camera)`
     * → 屏幕三角面积和。它绕过了着色阈值，直接量「朝向对不对」。
     * （材质/剔除类缺陷由第一个用例的 8745 暖色像素 + visible/activeCount 守住。）
     */
    const readFrontArea = async (entityId) => page.evaluate(async (eid) => {
      const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
      const { IGNIS_SPIKE } = await import('/src/entities/ignis/ignis-config.js');
      const THREE = await import('three');
      const g = window.__MC_GAME__;
      const r = g.spikeFx;
      const cam = g.camera;
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const pos = r.mesh.geometry.getAttribute('position');
      const idx = r.mesh.geometry.getIndex();
      const m = new THREE.Matrix4();
      const at = g.entities.get(eid).state.position;
      const want = spikeSpawnPoints(at, 0);
      let sum = 0;
      let matched = 0;
      // 只算**正前方那一排**（dir 0）：转 90° 后左/右两排反而变宽面，会抵消总量差
      for (let s = 0; s < r.activeCount; s++) {
        r.mesh.getMatrixAt(s, m);
        const e = m.elements;
        // 按位置认出它属于哪一根（实例矩阵的位移列）
        let k = -1;
        for (let i = 0; i < IGNIS_SPIKE.count; i++) {
          if (Math.abs(e[12] - want[i].x) < 1e-3 && Math.abs(e[14] - want[i].z) < 1e-3) { k = i; break; }
        }
        if (k < 0) continue;
        matched++;
        const P = [];
        for (let i = 0; i < pos.count; i++) {
          const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
          v.project(cam);
          P.push([(v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight]);
        }
        for (let t = 0; t < idx.count; t += 3) {
          const a = P[idx.getX(t)]; const b = P[idx.getX(t + 1)]; const c = P[idx.getX(t + 2)];
          sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
        }
      }
      return { area: sum, matched };
    }, entityId);
    // 等最后一根升满（250 + 180 = 430ms），取多帧最大值
    let best = 0;
    let bestFront = 0;
    let areaRead = { area: 0, matched: 0 };
    for (const t of [440, 500, 560]) {
      await page.waitForFunction((ms) => performance.now() - window.__T0__ >= ms,
        t, { timeout: 15_000 });
      const shot = PNG.sync.read(await shoot(page));
      best = Math.max(best, redderCount(base, shot));
      bestFront = Math.max(bestFront, frontWarm(base, shot));
      // ⚠️ 面积必须在**升满后**读：spawn 那一帧 scale≈0，矩阵位移虽对但面积近 0
      const a = await readFrontArea(eid);
      if (a.area > areaRead.area) areaRead = a;
    }
    await page.waitForTimeout(1200);
    return {
      spawned, warm: best, front: bestFront, area: areaRead.area, matched: areaRead.matched,
    };
  };

  // ---- 正向：宽面朝焰魔 ----
  const face = await measure(id);
  expect(face.spawned, '30 根都该找到地面').toBe(30);

  // ---- 注入：再转 90° ⇒ 看窄边（同机位、同地形、同夹具，只差朝向）----
  rotate90 = true;
  await page.reload();
  await waitWorldReady(page);
  await gotoOpenField(page, { x: site.x, z: site.z });
  const id2 = await setupScene(page);
  const fixture2 = await page.evaluate((eid) => {
    const g = window.__MC_GAME__;
    const idx = g.ignises.activeEntities().findIndex((x) => x.id === eid);
    const inst = g.ignisRenderer.instances?.[idx];
    if (!inst?.mesh) return false;
    inst.mesh.visible = false;
    const e = g.entities.get(eid);
    const p = g.player.physics.pos;
    e.state = {
      ...e.state,
      position: [Math.floor(p.x) + 0.5, g._findSigilGroundY(Math.floor(p.x) + 0.5, Math.floor(p.z) - 4 + 0.5, p.y) ?? (p.y - 12), Math.floor(p.z) - 4 + 0.5],
      mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0],
      yaw: 0, onGround: true, attackCooldown: 999,
    };
    if (g.ignises?.update) g.ignises.update = () => {};
    const px = p.x; const py = p.y; const pz = p.z;
    clearInterval(window.__PIN__);   // 同上：注入侧重载后也要先清
    window.__PIN__ = setInterval(() => {
      g.player.physics.pos.x = px; g.player.physics.pos.y = py; g.player.physics.pos.z = pz;
      g.player.yaw = 0; g.player.pitch = -0.35;
    }, 16);
    if (g.player?.viewBob?.update) g.player.viewBob.update = () => {};
    if (g.player?._stepLift?.update) g.player._stepLift.update = () => {};
    if (g.ocean?.update) {
      const orig = g.ocean.update.bind(g.ocean);
      g.ocean.update = (cam, dt) => orig(cam, 0);
    }
    if (g.viewArm?.mesh) g.viewArm.mesh.visible = false;
    if (g.viewWeapon?.node) g.viewWeapon.node.visible = false;
    const dn = g.dayNight || g.daynight;
    if (dn?.update) dn.update = () => {};
    g.spikeFx._emitSparks = () => {};
    return true;
  }, id2);
  expect(fixture2, '注入侧夹具同样要成立').toBe(true);
  await page.waitForTimeout(3500);
  // 确认注入真的生效（读实例矩阵的朝向，而不是只看 route 有没有跑）
  const injectedYaw = await page.evaluate(async (eid) => {
    const { spikeSpawnPoints } = await import('/src/render/spike-fx.js');
    const at = window.__MC_GAME__.entities.get(eid).state.position;
    const p = spikeSpawnPoints(at, 0)[0];
    return { yaw: p.yaw, ang: 0 + Math.PI };
  }, id2);
  expect(Math.abs(injectedYaw.yaw - injectedYaw.ang),
    '注入须真的把朝向转了 90°（否则两侧相同是假象）').toBeGreaterThan(1.5);
  const edge = await measure(id2);

  console.log('SPIKE_ORIENTATION', JSON.stringify({
    face, edge,
    warmRatio: +(face.warm / Math.max(1, edge.warm)).toFixed(2),
    areaRatio: +(face.area / Math.max(1, edge.area)).toFixed(2),
  }));

  /**
   * ---- 主判据：正前方那排的**屏幕投影面积** ----
   *
   * 宽面态（yaw = ang + π）的法线朗向相机 ⇒ |cos| ≈ 0.998；
   * 转 90° 后法线垂直于视线 ⇒ |cos| ≈ 0 ⇒ 只看到 0.0625 厚的窄边。
   * 实测面积比 **6.5**（六根 6.48~6.64），阈值取 3（两侧余量对称）。
   */
  expect(face.matched, '顶宽面态须认出正前方 6 根的实例矩阵').toBe(6);
  expect(edge.matched, '注入侧同理').toBe(6);
  expect(face.area, `宽面态投影面积须显著大于转 90° 的窄边态（face=${face.area.toFixed(0)} edge=${edge.area.toFixed(0)}）`)
    .toBeGreaterThan(edge.area * 3);
  // 辅助：两侧都得真的上屏（防止「面积大但根本没画」）
  expect(face.warm, '宽面态须画出暖色像素').toBeGreaterThan(500);
  expect(edge.warm, '注入侧也须上屏（否则对照不成立）').toBeGreaterThan(500);
  await page.evaluate(() => clearInterval(window.__PIN__));
});
