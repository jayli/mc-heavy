import { test, expect } from 'playwright/test';

// v3.30c：曳光起点必须从**枪口锚点**发出（用户实玩报告「起点偏右几像素」）。
//
// 根因（GPU/几何逐层取证）：`muzzleWorld(out = this._v)` 与 `portWorld(out = this._v)`
// **共用同一个 scratch Vector3**，而调用方写的是
//   const mw = view.muzzleWorld(); const pw = view.portWorld();
//   fx.spawnFromEffect({ muzzle: [mw.x,…], port: [pw.x,…] })
// 对象字面量在**两次调用之后**才求值 ⇒ mw 已被 port 覆写 ⇒ 曳光从抛壳口射出。
//
// ## v3.30f：按用户调定的枪口锚点重标两条几何阈值
//
// 用户 2026-11-22 手动把 `CARBINE_ANCHORS.muzzle` 从上游的 `(0, 0.006, -0.7)`
// 改成 **`(0, 0.009, -0.5)`**（commit 381395e）并裁定「功能代码都是我调试好的，不改」。
// 旧阈值是按上游锚点标定的，在新锚点下**几何上必然红**（不是缺陷）：
//   · `gap > 0.5`：枪口↔抛壳口真实距离从 0.68 变成 **0.481673**
//     （= √(0.04² + 0.003² + 0.48²)，实测逐位吻合）；
//   · `dTip < 2px`：锚点 z=-0.5 距枪管末端 z=-0.69 有 **0.19 格**轴向差
//     ⇒ 透视投影 **30.204px**（实测）。
//
// ⚠️⚠️ **重标不得丢掉原缺陷的判别力**：本 spec 要抓的是「起点串到抛壳口」，
// 不是「起点必须贴着枪管末端」。实测新锚点下：
//   · `dMuzzle`（起点↔枪口锚点）= **0**（逐位重合，这条不放宽）；
//   · `dPortMuzzle`（枪口↔抛壳口）= **280.8px** ⇒ 串位仍一眼可辨。
// ⇒ 把「贴枪管末端」换成**从真实几何推导的轴向一致性**判据（见下），
//   并把「远离抛壳口」的阈值改成**相对量**（占两锚点真实间距的比例），
//   这样将来再调锚点也不会假红，而串位缺陷仍必红。
//
// 判据取**真实 GPU 属性**（曳光池的 aA）与**真实几何投影**，不读常量。

const BOOT = async (page) => {
  await page.goto('/?vd=4&seed=12345&skybox=0&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 120_000 });
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g.dayNight.setStyle('noon');
    document.getElementById('hud-root').style.display = 'none';
    g.ocean.plane.visible = false;
  });
};

/** 让视图模型与相机都收敛到静止姿态，并刷新世界矩阵 */
const SETTLE = async (page) => {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('carbine');
    for (let i = 0; i < 200; i++) g.carbineView.update(1 / 60, { reloadT: -1, yaw: 0, pitch: 0 });
    g.renderer.setAnimationLoop(null);
    g.player.pitch = 0; g.player.yaw = 0;
    g.player.update(0.016);
    g.carbineView.update(0, { reloadT: -1, yaw: 0, pitch: 0 });
    g.camera.updateMatrixWorld(true);
    g.carbineView.root.updateMatrixWorld(true);
  });
};

test('KV-9 曳光：起点逐位等于枪口世界坐标（不是抛壳口）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await SETTLE(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const THREE = await import('three');
    const v = g.carbineView;
    // 开火前独立取一次枪口坐标（用调用方自己的向量，避免任何 scratch 干扰）
    const expectMuzzle = v.muzzle.getWorldPosition(new THREE.Vector3()).toArray();
    const expectPort = v.port.getWorldPosition(new THREE.Vector3()).toArray();
    g.player.fireWeaponOnce();
    const fx = g.carbineFx;
    const slot = (fx._tracerCursor - 1 + 40) % 40;
    const aA = fx.tracerGeo.getAttribute('aA');
    const start = [aA.getX(slot), aA.getY(slot), aA.getZ(slot)];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return {
      start, expectMuzzle, expectPort,
      distToMuzzle: dist(start, expectMuzzle),
      distToPort: dist(start, expectPort),
      muzzlePortGap: dist(expectMuzzle, expectPort),
    };
  });
  console.log('TRACER ORIGIN:', JSON.stringify(r));
  // 起点必须逐位等于枪口（容差只留浮点误差）
  // ⚠️ 容差取 1e-4：aA 是 **Float32Array**，世界坐标 ≈283 时单精度量化误差约 2e-5
  // （实测 1.96e-6）。写 1e-6 会把「正确的 float32 存储」判成缺陷。
  expect(r.distToMuzzle, '曳光起点必须等于枪口世界坐标').toBeLessThan(1e-4);
  // 且必须远离抛壳口（缺陷态两者只差 0.68 格，这里要求至少差开一半）
  expect(r.distToPort, '曳光起点不得落在抛壳口上').toBeGreaterThan(r.muzzlePortGap * 0.5);
});

test('KV-9 曳光：起点屏幕投影逐像素落在枪口锚点上', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await SETTLE(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const THREE = await import('three');
    const v = g.carbineView;
    const proj = (vec) => {
      const p = vec.clone().project(g.camera);
      return [(p.x * 0.5 + 0.5) * window.innerWidth, (-p.y * 0.5 + 0.5) * window.innerHeight];
    };
    // 枪管几何最前端那一圈顶点的屏幕包围盒中心（玩家看到的「枪管末端」）
    const pos = v.gun.geometry.attributes.position;
    let minZ = Infinity;
    for (let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i));
    const xs = []; const ys = [];
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getZ(i) - minZ) > 1e-6) continue;
      const w = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(v.gun.matrixWorld);
      const p = proj(w);
      xs.push(p[0]); ys.push(p[1]);
    }
    const tipCenter = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const muzzleW = v.muzzle.getWorldPosition(new THREE.Vector3());
    const portW = v.port.getWorldPosition(new THREE.Vector3());
    const muzzlePx = proj(muzzleW);
    const portPx = proj(portW);
    g.player.fireWeaponOnce();
    const fx = g.carbineFx;
    const slot = (fx._tracerCursor - 1 + 40) % 40;
    const aA = fx.tracerGeo.getAttribute('aA');
    const startPx = proj(new THREE.Vector3(aA.getX(slot), aA.getY(slot), aA.getZ(slot)));
    /**
     * 轴向一致性：把枪管末端中心与枪口锚点都变回 **rig 局部空间**，
     * 量两者的 x/y 偏差（垂直于枪轴）—— 它必须近于 0，意即「锚点在枪管轴线上」。
     * 这比「距末端 ≤2px」更强：后者只能证明「靠近」，而本判据能抓「偏到枪管旁边」
     * （即 v3.30c 那个缺陷的横向分量），且**不随锚点沿轴前后移动而假红**。
     */
    const invRig = new THREE.Matrix4().copy(v.rig.matrixWorld).invert();
    const mzLocal = muzzleW.clone().applyMatrix4(invRig);
    // gun 与 rig 同级（实测 gunSameAsRig=true），故末端局部坐标直接取几何值
    const tipLocal = new THREE.Vector3(0, 0.006, minZ).applyMatrix4(
      new THREE.Matrix4().copy(invRig).multiply(v.gun.matrixWorld),
    );
    return {
      tipCenter, startPx, muzzlePx, portPx,
      dMuzzle: Math.hypot(startPx[0] - muzzlePx[0], startPx[1] - muzzlePx[1]),
      dTip: Math.hypot(startPx[0] - tipCenter[0], startPx[1] - tipCenter[1]),
      dPort: Math.hypot(startPx[0] - portPx[0], startPx[1] - portPx[1]),
      dPortMuzzle: Math.hypot(muzzlePx[0] - portPx[0], muzzlePx[1] - portPx[1]),
      // 锚点相对枪管轴线的横向偏差（rig 局部，格）
      axisOffsetXY: Math.hypot(mzLocal.x - tipLocal.x, mzLocal.y - tipLocal.y),
      axialGap: Math.abs(mzLocal.z - tipLocal.z),
      gunUnderRig: v.gun.parent === v.rig,
    };
  });
  console.log('TRACER ORIGIN PX:', JSON.stringify(r));
  // ① 与枪口锚点必须逐像素重合（**不放宽** —— 这才是本 spec 的核心判据）
  expect(r.dMuzzle, '曳光起点投影必须与枪口锚点重合').toBeLessThan(0.5);
  /**
   * ② 锚点必须在**枪管轴线**上（横向偏差 <0.01 格）。
   * 实测：muzzleLocal=(0, 0.009, -0.5)、枪管轴心 y=0.006 ⇒ 偏差 **0.003 格**。
   * ⚠️ 这条取代旧的「距枪管末端 ≤2px」：后者把「沿轴位置」也钉死了，
   * 而用户有意把锚点沿轴后移了 0.19 格（实测投影 30.2px）⇒ 几何上必然假红。
   * 横向判据保留了原缺陷的判别力：串到抛壳口时 x 偏 0.04 格 ⇒ 必红。
   */
  expect(r.gunUnderRig, '前置：gun 与 rig 同级（局部坐标换算的前提）').toBe(true);
  expect(r.axisOffsetXY, '枪口锚点必须在枪管轴线上（横向偏差 <0.01 格）').toBeLessThan(0.01);
  // ③ 必须远离抛壳口（**相对阈值**：至少占两锚点屏幕间距的一半）
  // 实测：dPortMuzzle=280.8px、dPort≈280.8px ⇒ 串位缺陷（dPort≈0）仍必红。
  expect(r.dPort, '曳光起点不得落在抛壳口上').toBeGreaterThan(r.dPortMuzzle * 0.5);
});

test('KV-9 曳光：连射 30 发起点始终等于开火瞬间的枪口（后坐/摆动下不漂）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await SETTLE(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const THREE = await import('three');
    const v = g.carbineView;
    const fx = g.carbineFx;
    const wc = g.player.weaponController;
    const dists = [];
    /**
     * ⚠️⚠️ **必须在开火瞬间取样，不能在帧末**（本轮实测的判据坑）：
     * 曳光起点是**开火那一刻**冻结的世界坐标，而视图模型每帧还在摆动/后坐。
     * 初版在 `v.update()` 之后才取枪口比对 ⇒ 差了一帧的摆动量（实测 0.0445 格），
     * 那是**测量时机错**而不是实现错。
     * 正解：包一层 `fx.spawnFromEffect`，在它被调用的瞬间同步读枪口坐标。
     */
    const origSpawn = fx.spawnFromEffect.bind(fx);
    fx.spawnFromEffect = (effect, ctx, nowMs) => {
      const mz = v.muzzle.getWorldPosition(new THREE.Vector3());
      const res = origSpawn(effect, ctx, nowMs);
      if (effect.carbineTracer) {
        const slot = (fx._tracerCursor - 1 + 40) % 40;
        const aA = fx.tracerGeo.getAttribute('aA');
        const start = new THREE.Vector3(aA.getX(slot), aA.getY(slot), aA.getZ(slot));
        dists.push(start.distanceTo(mz));
      }
      return res;
    };
    wc.pointerDown(g.player._buildAim());
    for (let i = 0; i < 900 && dists.length < 30; i++) {
      wc.update(1 / 120, g.player._buildAim());
      v.update(1 / 120, { reloadT: wc.carbineMag.reloadT, yaw: g.player.yaw, pitch: g.player.pitch });
      g.camera.updateMatrixWorld(true);
      v.root.updateMatrixWorld(true);
    }
    fx.spawnFromEffect = origSpawn;
    return {
      shots: dists.length,
      maxDist: Math.max(...dists),
      meanDist: dists.reduce((x, y) => x + y, 0) / dists.length,
    };
  });
  console.log('TRACER ORIGIN BURST:', JSON.stringify(r));
  expect(r.shots).toBeGreaterThanOrEqual(25);
  // 开火瞬间取样 ⇒ 只剩 Float32 量化误差（世界坐标 ≈283 时约 2e-5）
  expect(r.maxDist, '连射时每发起点都必须等于开火瞬间的枪口').toBeLessThan(1e-4);
});

test('KV-9 曳光：两个锚点 scratch 相互独立（防回归）', async ({ page }) => {
  test.setTimeout(200_000);
  await BOOT(page);
  await SETTLE(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const THREE = await import('three');
    const v = g.carbineView;
    // 复现缺陷写法：先取 muzzle 再取 port，然后才读 mw
    const mw = v.muzzleWorld();
    const pw = v.portWorld();
    // 坐基准：用调用方自己的向量独立取一次（不经任何 scratch）
    const mzRef = v.muzzle.getWorldPosition(new THREE.Vector3());
    const ptRef = v.port.getWorldPosition(new THREE.Vector3());
    return {
      sameObject: mw === pw,
      muzzle: [mw.x, mw.y, mw.z],
      port: [pw.x, pw.y, pw.z],
      gap: Math.hypot(mw.x - pw.x, mw.y - pw.y, mw.z - pw.z),
      refGap: mzRef.distanceTo(ptRef),
      // 两次取值必须各自等于独立基准（串位时 mw 会变成 port）
      muzzleErr: mw.distanceTo(mzRef),
      portErr: pw.distanceTo(ptRef),
    };
  });
  console.log('ANCHOR SCRATCH:', JSON.stringify(r));
  expect(r.sameObject, '两个锚点不得共用同一个 scratch Vector3').toBe(false);
  /**
   * ⚠️⚠️ **阈值必须是相对量，不能写上游的绝对值**（v3.30f 重标）：
   * 旧断言 `gap > 0.5` 是按上游 muzzle.z=-0.7 算的（0.68）；用户调定锚点为 -0.5 后
   * 真实间距是 **0.481673**（= √(0.04²+0.003²+0.48²)，实测逐位吻合）⇒ 几何上必然假红。
   * ⇒ 改成「两次取值各自等于独立基准」+ 「gap 等于基准间距」：
   * 它直接钉住「没有被覆写」这个语义，**不随锚点位置变**，且串位时必红
   * （串位时 mw===port ⇒ muzzleErr = 0.4817 ≫ 1e-6）。
   */
  expect(r.muzzleErr, 'muzzleWorld() 必须等于独立取值的枪口（不得被 port 覆写）').toBeLessThan(1e-6);
  expect(r.portErr, 'portWorld() 必须等于独立取值的抛壳口').toBeLessThan(1e-6);
  expect(Math.abs(r.gap - r.refGap), '两锚点间距必须等于几何真值').toBeLessThan(1e-6);
  // 且两个锚点必须真的分开（相对阈值：至少 0.1 格，远小于实测 0.4817）
  expect(r.gap, '枪口与抛壳口必须是两个分离的位置').toBeGreaterThan(0.1);
});