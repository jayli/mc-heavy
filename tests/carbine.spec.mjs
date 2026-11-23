import { test, expect } from 'playwright/test';

// v3.30 KV-9 卡宾枪：视图模型上屏 / 整匣（40 发）自动换弹 / 五个特效池 / 掉血与机枪一致 /
// hitstop 与震动 / 音效计数。全部从**玩家真实入口**（selectWeapon + fireWeaponOnce）进。
//
// ⚠️ 机位与噪声源冻结口径同既有 Tier 4 spec：?skybox=0 固定纯色天空、
// dayNight.setStyle('noon') 停日夜推进、隐藏 HUD。

const BOOT = async (page, extra = '') => {
  await page.goto(`/?vd=4&seed=12345&skybox=0&weather=clear${extra}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
  });
};

test('KV-9：选中后视图模型挂相机、几何非空、与旧枪互斥', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    const v = g.carbineView;
    let verts = 0;
    let meshes = 0;
    v.rig.traverse((o) => { if (o.isMesh) { meshes++; verts += o.geometry.attributes.position.count; } });
    // 相机下的第一人称节点清单（证明互斥）
    const camChildren = g.camera.children.filter((c) => c.visible !== false).map((c) => c.name || c.type);
    return {
      selected: g.player.weaponController.selectedId,
      mounted: v.mounted,
      rootParentIsCamera: v.root.parent === g.camera,
      meshes, verts,
      oldGunNode: g.viewWeapon.node,
      armVisible: g.viewArm.mesh.visible,
      magVisible: v.mag.visible,
      camChildren,
      rigPos: v.rig.position.toArray().map((x) => +x.toFixed(4)),
    };
  });
  console.log('KV9 MOUNT:', JSON.stringify(r));
  expect(r.selected).toBe('carbine');
  expect(r.mounted).toBe(true);
  expect(r.rootParentIsCamera).toBe(true);
  // 四个实体 mesh（gun/mag/armL/armR）+ reticle + 三片火光 = 8
  expect(r.meshes).toBe(8);
  expect(r.verts).toBeGreaterThan(2000);
  expect(r.oldGunNode).toBeNull();          // 旧枪节点已摘
  expect(r.armVisible).toBe(false);         // 徒手手臂已隐
  expect(r.magVisible).toBe(true);
  // rig 落在腰射基准位附近（上游 ads=0 端 0.165 / −0.175 / −0.31）
  expect(Math.abs(r.rigPos[0] - 0.165)).toBeLessThan(0.05);
  expect(Math.abs(r.rigPos[1] + 0.175)).toBeLessThan(0.4);   // 举枪动画可能还在收敛
  expect(Math.abs(r.rigPos[2] + 0.31)).toBeLessThan(0.05);
});

test('KV-9：枪体在画面上非黑且占一定面积（Tier 4 像素）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    // 举枪动画收敛
    for (let i = 0; i < 60; i++) g.carbineView.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    g.ocean.plane.visible = false;
  });
  await page.waitForTimeout(600);
  const shot = await page.screenshot();
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(shot);
  // 枪在屏幕右下（rig x=+0.165 ⇒ 偏右；y=−0.175 ⇒ 偏下）
  let dark = 0;
  let total = 0;
  const x0 = Math.floor(png.width * 0.5);
  const y0 = Math.floor(png.height * 0.55);
  for (let y = y0; y < png.height; y++) {
    for (let x = x0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const luma = 0.299 * png.data[o] + 0.587 * png.data[o + 1] + 0.114 * png.data[o + 2];
      total++;
      // 枪体是深灰金属/聚合物（luma < 110），天空是亮蓝（luma > 150）
      if (luma < 110) dark++;
    }
  }
  const ratio = dark / total;
  console.log('KV9 GUN PIXELS:', JSON.stringify({ dark, total, ratio: +ratio.toFixed(4) }));
  expect(ratio, '右下区域应出现枪体暗像素（纯黑或全无 = 枪没上屏）').toBeGreaterThan(0.02);
  expect(ratio, '暗像素占比过高 = 可能整片黑（材质/灯光错）').toBeLessThan(0.75);
});

test('KV-9：一匣（40 发）打光自动换弹，三段音各一次，换弹期不开火，之后补满', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    const wc = g.player.weaponController;
    const am = g.audioManager;
    const before = {};
    for (const id of ['carbine_fire', 'carbine_reload_out', 'carbine_reload_in', 'carbine_reload_rack']) {
      before[id] = (am.playRequests.get(id) ?? 0);
    }
    // 走真实入口：按下左键 + 逐帧 update（与键鼠完全同路径）
    const aim = g.player._buildAim();
    wc.pointerDown(aim);
    // ⚠️ **目标发数从真值派生**，不写第二份 40（容量唯一权威是 CARBINE.mag）：
    // 打满两匣 ⇒ 中途必过一次换弹 ⇒ 无限子弹成立。按冷却算 80 发 ≈ 6.9s，
    // 加 2.15s 换弹 ⇒ 约 1090 帧；上限取 2000 帧（≈16.7s）留足余量。
    const want = wc.carbineMag.cfg.mag * 2;
    let shots = 0;
    let reloadStarts = 0;
    const stages = [];
    let sawFireDuringReload = false;
    for (let i = 0; i < 2000; i++) {
      const out = wc.update(1 / 120, g.player._buildAim());
      for (const e of out) {
        if (e.type === 'shot' || e.type === 'entity-hit') {
          shots++;
          if (wc.carbineMag.reloading) sawFireDuringReload = true;
        }
        if (e.type === 'carbine-reload-start') reloadStarts++;
        if (e.type === 'carbine-reload-stage') stages.push(e.reloadStage);
      }
      if (shots >= want) break;
    }
    wc.pointerUp();
    const after = {};
    for (const id of Object.keys(before)) after[id] = (am.playRequests.get(id) ?? 0);
    const delta = {};
    for (const id of Object.keys(before)) delta[id] = after[id] - before[id];
    return {
      shots, want, reloadStarts, stages, sawFireDuringReload,
      ammo: wc.carbineMag.ammo, mag: wc.carbineMag.cfg.mag,
      soundDelta: delta,
      state: wc.debugState().carbine,
    };
  });
  console.log('KV9 RELOAD:', JSON.stringify(r));
  expect(r.shots).toBeGreaterThanOrEqual(r.want);     // 两匣 ⇒ 无限子弹成立
  expect(r.reloadStarts).toBeGreaterThanOrEqual(1);
  expect(r.stages.slice(0, 3)).toEqual([0, 1, 2]);
  expect(r.sawFireDuringReload).toBe(false);
  expect(r.ammo).toBeLessThanOrEqual(r.mag);
  // 弹匣容量 = 用户裁定的 40（上游 30 已改）
  expect(r.mag).toBe(40);
  expect(r.soundDelta.carbine_fire).toBeGreaterThanOrEqual(r.want);
  expect(r.soundDelta.carbine_reload_out).toBeGreaterThanOrEqual(1);
  expect(r.soundDelta.carbine_reload_in).toBeGreaterThanOrEqual(1);
  expect(r.soundDelta.carbine_reload_rack).toBeGreaterThanOrEqual(1);
});

test('KV-9：换弹动作真的在动（弹匣下移+隐藏、左臂跟随、整枪侧倾）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    const v = g.carbineView;
    const wc = g.player.weaponController;
    const snap = () => ({
      magY: +v.mag.position.y.toFixed(4),
      magVisible: v.mag.visible,
      armLY: +v.armL.position.y.toFixed(4),
      armLZ: +v.armL.position.z.toFixed(4),
      rigRoll: +v.rig.rotation.z.toFixed(4),
      rigPitch: +v.rig.rotation.x.toFixed(4),
    });
    // 静止基线
    for (let i = 0; i < 40; i++) v.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    const idle = snap();
    // 换弹中段（弹匣全脱）
    v.update(1 / 60, { reloadT: 0.6, yaw: 0, pitch: 0 });
    const mid = snap();
    // 拉机柄那一刻
    v.update(1 / 60, { reloadT: 1.76, yaw: 0, pitch: 0 });
    const rack = snap();
    // 换弹结束
    v.update(1 / 60, { reloadT: 2.2, yaw: 0, pitch: 0 });
    const end = snap();
    return { idle, mid, rack, end, magCapacity: wc.carbineMag.cfg.mag };
  });
  console.log('KV9 RELOAD POSE:', JSON.stringify(r));
  // 弹匣脱出：y 明显下移且不可见
  expect(r.mid.magY).toBeLessThan(r.idle.magY - 0.2);
  expect(r.mid.magVisible).toBe(false);
  // 左臂跟着下去
  expect(r.mid.armLY).toBeLessThan(-0.2);
  // 整枪侧倾（roll 为负 = 向内侧翻，上游 −rl*0.5）
  expect(r.mid.rigRoll).toBeLessThan(r.idle.rigRoll - 0.3);
  // 拉机柄：左臂向后拉（z 增大）
  expect(r.rack.armLZ).toBeGreaterThan(r.mid.armLZ);
  // 结束后全部回位
  expect(r.end.magVisible).toBe(true);
  expect(Math.abs(r.end.magY - r.idle.magY)).toBeLessThan(0.001);
  expect(Math.abs(r.end.armLY)).toBeLessThan(0.001);
});

test('KV-9：开火出曳光/火花/烟尘/弹壳/弹孔，且命中掉血 = 加特林', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    // ⚠️ 模块 import 放在**开火之前**：它是 await，放开火后会让短命特效过期。
    const { WEAPONS } = await import('/src/player/weapons/weapon-catalog.js');
    await g.selectWeapon('carbine');
    for (let i = 0; i < 40; i++) g.carbineView.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    // 生成一只丧尸并瞄准它
    const sp = g.spawnZombieNearPlayer();
    const ent = g.entities.get(sp.spawned);
    const p = ent.state.position;
    const cp = g.player.camera.position;
    g.player.setTestAim([p[0] - cp.x, p[1] + 0.9 - cp.y, p[2] - cp.z]);
    const hpBefore = ent.state.health;
    const fx = g.carbineFx;
    const countsBefore = { ...fx.counts };
    const out = g.player.fireWeaponOnce();
    // ⚠️ **开火后同步立刻取样**：曳光只活 (L+len)/320 ≈ 0.02s、火光 0.045s、
    // hitstop 0.022s —— 任何 await（包括 dynamic import）都会让它们自然过期，
    // 断言就变成在测「过期后不可见」而不是「开火时可见」（本轮实测踩到）。
    const countsAfter = { ...fx.counts };
    const immediate = {
      tracerVisible: fx.tracerMesh.visible,
      sparkVisible: fx.sparkMesh.visible,
      puffVisible: fx.puffMesh.visible,
      casingVisible: fx.casingMesh.visible,
      flashVisible: g.carbineView.flash.visible,
      kick: g.carbineView.kick,
      trauma: g.carbineFeel.trauma,
      hitstop: g.carbineFeel.hitstop,
    };
    const hpAfter = g.entities.get(sp.spawned)?.state.health ?? 0;
    return {
      effectType: out[0]?.type,
      hasCarbineTracer: !!out[0]?.carbineTracer,
      hasOldTracer: !!out[0]?.tracer,
      countsBefore, countsAfter,
      hpBefore, hpAfter,
      damage: hpBefore - hpAfter,
      minigunDamage: WEAPONS.minigun.entityDamage,
      carbineDamage: WEAPONS.carbine.entityDamage,
      immediate,
    };
  });
  console.log('KV9 FIRE:', JSON.stringify(r));
  expect(r.effectType).toBe('entity-hit');
  expect(r.hasCarbineTracer).toBe(true);
  expect(r.hasOldTracer).toBe(false);
  // 掉血与加特林完全一致（用户裁定）
  expect(r.damage).toBe(r.minigunDamage);
  expect(r.carbineDamage).toBe(r.minigunDamage);
  // 五个池都动了
  expect(r.countsAfter.sparks).toBeGreaterThan(r.countsBefore.sparks);
  expect(r.countsAfter.puffs).toBeGreaterThan(r.countsBefore.puffs);
  expect(r.countsAfter.casings).toBeGreaterThan(r.countsBefore.casings);
  expect(r.immediate.tracerVisible).toBe(true);
  expect(r.immediate.sparkVisible).toBe(true);
  expect(r.immediate.puffVisible).toBe(true);
  expect(r.immediate.casingVisible).toBe(true);
  // 后坐 / 火光 / 震动 / hitstop
  expect(r.immediate.kick).toBeGreaterThan(0);
  expect(r.immediate.flashVisible).toBe(true);
  expect(r.immediate.trauma).toBeGreaterThan(0);
  expect(r.immediate.hitstop).toBeGreaterThan(0);
});

test('KV-9：hitstop 只缩玩法 dt，且用真实时间计时（不自我拉长）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { CARBINE } = await import('/src/player/weapons/carbine.js');
    g.hitstop(0.05);
    const t0 = g.carbineFeel.hitstop;
    // 等 200ms 真实时间（>0.05s）⇒ hitstop 必须已归零
    await new Promise((r) => setTimeout(r, 250));
    const t1 = g.carbineFeel.hitstop;
    g.shake(0.3);
    const tr0 = g.carbineFeel.trauma;
    await new Promise((r) => setTimeout(r, 300));
    const tr1 = g.carbineFeel.trauma;
    return { t0, t1, tr0, tr1, scale: CARBINE.hitstopTimeScale, decay: CARBINE.traumaDecayPerSecond };
  });
  console.log('KV9 FEEL:', JSON.stringify(r));
  expect(r.t0).toBeGreaterThan(0);
  expect(r.t1).toBe(0);                     // 用 realDt 计时 ⇒ 250ms 后必然结束
  expect(r.tr0).toBeGreaterThan(0);
  expect(r.tr1).toBeLessThan(r.tr0);        // trauma 在衰减
  expect(r.scale).toBeGreaterThan(0);
  expect(r.scale).toBeLessThan(1);
});

test('KV-9：切回其他枪时视图模型摘下、特效清空、后坐归零', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    g.player.fireWeaponOnce();
    const during = { mounted: g.carbineView.mounted, counts: { ...g.carbineFx.counts } };
    await g.selectWeapon('minigun');
    // ⚠️ clear() 后**同一 evaluate 内立刻读**：帧循环会在 await 间隙跑，
    // 而 selectWeapon 内部有 await ⇒ 必须在它返回后同步取样，不再插入任何 await。
    const after = {
      mounted: g.carbineView.mounted,
      rootParent: g.carbineView.root.parent,
      counts: { ...g.carbineFx.counts },
      oldGunLoaded: !!g.viewWeapon.node,
      recoilP: g.player._recoilP,
    };
    await g.selectWeapon('carbine');
    const back = { mounted: g.carbineView.mounted, ammo: g.player.weaponController.carbineMag.ammo };
    return { during, after, back };
  });
  console.log('KV9 SWITCH:', JSON.stringify(r));
  expect(r.during.mounted).toBe(true);
  expect(r.after.mounted).toBe(false);
  expect(r.after.rootParent).toBeNull();
  expect(r.after.counts.sparks).toBe(0);
  expect(r.after.counts.casings).toBe(0);
  expect(r.after.oldGunLoaded).toBe(true);
  expect(r.after.recoilP).toBe(0);
  expect(r.back.mounted).toBe(true);
  expect(r.back.ammo).toBe(40);
});