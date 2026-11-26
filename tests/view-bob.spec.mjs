import { test, expect } from 'playwright/test';

/**
 * 跑动视角晃动 + 第一人称手臂（挖/放挥动）的**真游戏页接线**验收。
 *
 * 分工（docs/testing-policy.md §2.4）：
 * - 纯逻辑（Bob 的判据/相位/帧率无关、Arm 的站位/挥动编排）走浏览器内单测
 *   `src/tests/test-view-bob.js`；
 * - **本 spec** 只测只有真游戏页才成立的部分：节点真的挂在 camera 上且随武器切换显隐、
 *   相机真的吃到晃动偏移（且幅度受 intensity 约束、停下后归零）、走过**玩家主路径**
 *   （`digBlock` / `placeBlock` / 背包选中分流）时手臂真的挥动。
 *
 * ⚠️ 为什么挥动必须走 `digBlock()` / `placeBlock()` 而不是直接调 `viewArm.swing()`：
 * M7 验收报告 §3.7 的教训 —— 只调测试 API 的用例全绿却漏了玩家主路径上的缺陷。
 * 这里断言的是「玩家按键/点击后会发生什么」。
 */

/**
 * v3.46：手臂整体照抄 OpusCraft / vanilla 口径后，**旧的三个欧拉角常量已作废**：
 *   ARM_REST = −0.8 / ARM_BOTTOM = −1.67 / SWING_ROLL = 0.349
 * 它们描述的是 mc-lite 的单轴下压实现；新实现是 11 步右乘变换链，
 * `mesh.rotation` 是 decompose 出来的**等价欧拉角**（随旋转序变化，同一姿态多种表示）。
 *
 * ⇒ 判据改落在**手臂长轴的相机空间朝向**与**手端位置**上（与
 * `src/tests/test-view-bob.js` 同口径）。下面的阀值均为**实测值**，不是推导值。
 */
// 手臂长轴（手端→肩端）在挥动中的夹角峰：实测 **58.5°**（上游主摆动 70°）
const SWING_AXIS_PEAK_DEG = 58.5;
// 手端向前探的最大位移（相机 −Z）：实测 **0.308 格**
const SWING_FORWARD_MIN = 0.15;
const INTENSITY = 0.15;     // v1.57：用户「晃动幅度还不够大，可以稍微大一些」（原版上限 0.1）
// ⚠️ 标称值 ≠ 实际幅度：一阶平滑在 1.35Hz 处通过率 ≈ 0.916，故实际 y 峰 ≈ 0.1375、x 峰 ≈ 0.0687。
// v1.51：旋转全部归零（用户要求「跑动时镜头始终水平，不要歪头」）→ 相机 roll/pitch 必须恒为 0。
// 跑动感全部来自位置平移（左右微移不改变任何朝向）。

/**
 * 手臂长轴与手端的相机空间量（与单测同口径，各用例内联定义 `probe()`）。
 * 几何局部坐标：手端 y = −2/16、肩端 y = 10/16，x 中心 = −1/16。
 */

async function boot(page, vd = 2) {
  await page.goto(`/?seed=12345&vd=${vd}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等 remesh/上传收敛，避免后续放挖与采样撞上队列背压
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.meshInflight === 0 && s.meshQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000, polling: 300 });
  await page.waitForTimeout(800);
}

test('手臂默认可见、挂 camera 下；持枪隐藏，切回徒手恢复', async ({ page }) => {
  await boot(page);
  const initial = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      visible: g.viewArm.mesh.visible,
      inCamera: g.camera.children.includes(g.viewArm.mesh),
      selectedId: g.viewArm.state.selectedId,
      // 默认武器是徒手（controller 初值），与手臂可见性必须同源
      weapon: g.weaponDebugState().selectedId,
    };
  });
  expect(initial.selectedId, '默认须是徒手').toBe('arm');
  expect(initial.weapon).toBe('arm');
  expect(initial.visible, '徒手时手臂须可见').toBe(true);
  expect(initial.inCamera, '手臂须挂在 camera 下（否则永不渲染）').toBe(true);

  const swapped = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('pistol');
    const onGun = g.viewArm.mesh.visible;
    await g.selectWeapon('arm');
    return { onGun, backToArm: g.viewArm.mesh.visible };
  });
  expect(swapped.onGun, '持枪时手臂须隐藏（不得与枪模型同时出现）').toBe(false);
  expect(swapped.backToArm, '切回徒手须重新显示').toBe(true);
  await page.evaluate(() => window.__MC_GAME__.selectWeapon('arm'));
});

test('跑动时相机出现周期晃动，幅度受 intensity 约束；静止时偏移为 0', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async ({ intensity }) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // ⚠️ 必须同时采样**相机相对物理位置的偏移**，不能只读 `viewBob.offset` —— 只读后者时
    // 「bob 算对了但没写进相机」的注入会全绿（实测：删掉 `camera.position.set(p.x + bob.x…)`
    // 里的 `+ bob.x` 后本用例仍 PASS）。相机偏移才是玩家实际看到的东西。
    // 相机 y = 脚底 + 1.62（眼高）+ stepLift + bob.y，故减掉前两项即得 bob 的真实落点。
    //
    // ⚠️ **判「歪头」不能读 `camera.rotation.x/z`**（v2.8 出生朝向改南后实际撞到）：
    // three 的 `camera.rotation` 是 **Euler XYZ 分解**，`yaw = π` 时得到
    // `(-π, ~0, -π)` —— pitch 与 roll 互相抵消的**等价表示**，但两个分量都非零。
    // 读它们会把「地平线完全水平」误判成歪头（实测 up 恒 (0,1,0)、最大倾角 **0°**）。
    // 改读**相机基向量**（= 玩家真正看到的画面）：地平线水平 ⟺ `up` 无水平分量、
    // `right` 无竖直分量。这与 AGENTS.md 的「从矩阵反解旋转不能用 Euler 分解」同一类陷阱。
    const V = g.camera.position.constructor;
    const rollOf = () => {
      const up = new V(0, 1, 0).applyQuaternion(g.camera.quaternion);
      const right = new V(1, 0, 0).applyQuaternion(g.camera.quaternion);
      // 倾斜角 = up 偏离 (0,1,0) 的角度（含 roll+pitch）；横向歪头 = right 的竖直分量
      return {
        tilt: Math.acos(Math.min(1, Math.max(-1, up.y))),
        skew: Math.asin(Math.min(1, Math.max(-1, right.y))),
      };
    };
    const sample = () => {
      const p = pl.physics.pos;
      const r = rollOf();
      return {
        camX: g.camera.position.x - p.x,
        camY: g.camera.position.y - (p.y + 1.62 + pl._stepLift.offset),
        // v1.49：跑动旋转分量。改成相机基向量量出来的**真实倾斜**（见上方注释）。
        roll: r.skew,   // 横向歪头（地平线变斜）
        pitch: r.tilt,  // 上下点头
        x: pl.viewBob.offset.x,
        y: pl.viewBob.offset.y,
        bobRoll: pl.viewBob.roll,
        amount: pl.viewBob.amount,
      };
    };

    // 静止基线：30 帧内偏移与旋转均恒 0（未动时不得有残余晃动/歪头）
    const idle = [];
    for (let i = 0; i < 30; i++) { await frame(); idle.push(sample()); }
    const idleMax = Math.max(...idle.map((s) => Math.abs(s.camX) + Math.abs(s.camY)));
    const idleRot = Math.max(...idle.map((s) => Math.abs(s.roll) + Math.abs(s.pitch)));

    // ② 跑动：直接写 keys（无头环境无真实键盘/pointer lock；与 onKeyDown 写的是同一集合）
    // ⚠️ 窗口长度必须覆盖足够多的**周期**，否则「周期性」断言测不到过零：
    // 步频 1.35Hz（v1.55）下 180 帧 @120Hz = 1.5s 只有 ~2 个周期，去掉渐入后只剩 1 次过零
    // → 实测踩到该断言假失败。改为 360 帧（3s ≈ 4 个周期）、跳过前 90 帧渐入。
    const run = [];
    pl.keys.add('KeyW');
    for (let i = 0; i < 360; i++) { await frame(); run.push(sample()); }
    pl.keys.delete('KeyW');
    const settled = run.slice(90); // 跳过起步渐入段
    const maxCamX = Math.max(...settled.map((s) => Math.abs(s.camX)));
    const maxCamY = Math.max(...settled.map((s) => Math.abs(s.camY)));
    const maxX = Math.max(...settled.map((s) => Math.abs(s.x)));
    const maxY = Math.max(...settled.map((s) => Math.abs(s.y)));
    // v1.52 原版口径：y 恒非正（只向下，每步一次下沉）；且 y 不越界
    const maxYPos = Math.max(...settled.map((s) => s.y));
    const maxRoll = Math.max(...settled.map((s) => Math.abs(s.roll)));
    const maxPitch = Math.max(...settled.map((s) => Math.abs(s.pitch)));
    const minPitch = Math.min(...settled.map((s) => s.pitch));
    const maxRollAbs = Math.max(...settled.map((s) => Math.abs(s.roll)));
    const amountMax = Math.max(...settled.map((s) => s.amount));
    // 相机落点与 bob 输出必须一致（防「算对了没写入」与「写入了但被别处覆盖」两种缺陷）
    const camVsBobX = Math.max(...settled.map((s) => Math.abs(s.camX - s.x)));
    const camVsBobY = Math.max(...settled.map((s) => Math.abs(s.camY - s.y)));
    const camVsBobRoll = Math.max(...settled.map((s) => Math.abs(s.roll)));
    // 相位是否真的在推进（周期性）：x 至少跨过 0 两次以上
    let crossings = 0;
    for (let i = 1; i < settled.length; i++) {
      if ((settled[i - 1].camX < 0) !== (settled[i].camX < 0)) crossings++;
    }

    // ③ 停下：偏移须收敛回 0
    const stop = [];
    for (let i = 0; i < 90; i++) { await frame(); stop.push(sample()); }
    const last = stop[stop.length - 1];
    return {
      idleMax, idleRot, maxCamX, maxCamY, maxX, maxY, maxYPos, maxRoll, maxPitch, minPitch, maxRollAbs,
      amountMax, camVsBobX, camVsBobY, camVsBobRoll, crossings, last, intensity,
    };
  }, { intensity: INTENSITY });

  // 静止不晃（相机侧，含旋转）
  expect(result.idleMax, '静止时相机不得有平移偏移').toBeLessThan(1e-9);
  expect(result.idleRot, '静止时相机不得有旋转偏移（歪头）').toBe(0);  // 跑动确实晃 —— **看相机，不看内部量**（下界，防「什么都没发生」的恒真）
  expect(result.maxCamX, `跑动时相机 x 须有可感偏移，实测 ${result.maxCamX}`)
    .toBeGreaterThan(INTENSITY * 0.25);
  // v1.53：实际可感幅度（扣掉一阶平滑衰减）—— 这才是玩家看到的东西。
  // 断言下界，防「标称调大了但平滑把增幅吃掉」这类静默失效。
  expect(result.maxCamY, `跑动时相机 y（上下起伏）须明显可感，实测 ${result.maxCamY}`).toBeGreaterThan(0.1);
  expect(result.camVsBobX, `相机 x 须等于 bob 输出，实测偏差 ${result.camVsBobX}`).toBeLessThan(1e-9);
  expect(result.camVsBobY, `相机 y 须等于 bob 输出，实测偏差 ${result.camVsBobY}`).toBeLessThan(1e-9);
  // v1.51 **硬不变式**：跑动全程相机零旋转（地平线始终水平）。
  // ⚠️ 这里必须断言**相机**的 rotation，不能只断言 `viewBob.roll/pitch` ——
  // 「算成 0 了但 player.js 仍加了个常量」的注入只有相机侧能抓到。
  // ⚠️ 用 `Math.abs(...) === 0` 而不是 `toBe(0)`：`rotateZ(0)` 可产 `-0`，
  // 而 `Object.is(-0, 0) === false`（实测踩到）—— 断言要锁「量为零」而非「符号为正」。
  expect(Math.abs(result.maxRoll), `跑动时相机不得歪头（地平线倾角），实测 ${result.maxRoll}`).toBe(0);
  expect(Math.abs(result.maxPitch), `跑动时相机不得点头（俯仰角），实测 ${result.maxPitch}`).toBe(0);
  // 前提：确实在跑（防「零旋转只是因为根本没动」使上面两条恒真）
  expect(result.maxCamX, `前提：须确实跑动产生平移，实测 ${result.maxCamX}`).toBeGreaterThan(0);
  expect(result.amountMax, '振幅须接近目标值').toBeGreaterThan(INTENSITY * 0.8);
  // **上界**：偏移不得超过 intensity（防「晃动幅度失控」）
  // 原版口径：x 幅度 = intensity×0.5，y 幅度 = intensity（只向下）
  expect(result.maxCamX, `相机 x 偏移不得超过 intensity×0.5（原版口径），实测 ${result.maxCamX}`)
    .toBeLessThanOrEqual(INTENSITY * 0.5 + 1e-9);
  expect(result.maxCamY, `相机 y 偏移不得超过 intensity（原版口径），实测 ${result.maxCamY}`)
    .toBeLessThanOrEqual(INTENSITY + 1e-9);
  // v1.52：y 只向下（原版 −|cos| 口径）
  expect(result.maxYPos, `y 须只向下（恒非正），实测最大 ${result.maxYPos}`).toBeLessThanOrEqual(1e-9);
  expect(result.maxX, `内部 x 偏移同上界，实测 ${result.maxX}`).toBeLessThanOrEqual(INTENSITY * 0.5 + 1e-9);
  expect(result.maxY, `内部 y 偏移同上界，实测 ${result.maxY}`).toBeLessThanOrEqual(INTENSITY + 1e-9);
  // 周期性（相位真的在推进，不是单向漂移）
  expect(result.crossings, `跑动期间相机 x 须反复过零（周期性），实测 ${result.crossings}`).toBeGreaterThanOrEqual(2);
  // 停下归零
  expect(Math.abs(result.last.camX), '停下后相机 x 须收敛到 0').toBeLessThan(1e-3);
  expect(Math.abs(result.last.camY), '停下后相机 y 须收敛到 0').toBeLessThan(1e-3);
  expect(Math.abs(result.last.roll), '停下后相机 roll 须为 0').toBe(0);
  expect(Math.abs(result.last.pitch), '停下后相机 pitch 须为 0').toBe(0);
});

test('挖块走玩家主路径触发手臂挥动（v3.46 vanilla 变换链：长轴横摆 + 手端前探）', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async ({ axisPeakDeg, forwardMin }) => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // 手臂长轴与手端的相机空间量（与单测同口径）
    const probe = () => {
      const m = new THREE.Matrix4().compose(
        g.viewArm.mesh.position, g.viewArm.mesh.quaternion, g.viewArm.mesh.scale);
      const at = (ly) => new THREE.Vector3(-1 / 16, ly, 0).applyMatrix4(m);
      const hand = at(-2 / 16);
      return { hand, axis: at(10 / 16).sub(hand).normalize(), p: g.viewArm.swingProgress };
    };
    const p0 = pl.physics.pos;
    const bx = Math.floor(p0.x);
    const by = Math.floor(p0.y) + 1;
    const bz = Math.floor(p0.z) - 3;
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('stone') });
    await new Promise((r) => setTimeout(r, 600));
    pl.setTestAim([0, 0, -1]);

    const rest = probe();
    const restHand = rest.hand.clone();
    const restAxis = rest.axis.clone();
    const hadTarget = !!pl.target;
    pl.digBlock({});
    const blockGone = g.world.getBlockId(bx, by, bz) === 0;
    const progressJustAfter = g.viewArm.swingProgress;

    // 逐帧采样（挥动 0.1s @120Hz ≈ 12 帧，采 24 帧盖完整段 + 回位）
    const rows = [];
    for (let i = 0; i < 24; i++) {
      await frame();
      const s = probe();
      rows.push({
        p: s.p,
        angle: s.axis.angleTo(restAxis),
        forward: restHand.z - s.hand.z,      // 正 = 向相机 −Z 探出
        lateral: Math.abs(s.hand.x - restHand.x),
      });
    }
    const peak = rows.reduce((a, b) => (b.angle > a.angle ? b : a), rows[0]);
    const deepest = rows.reduce((a, b) => (b.forward > a.forward ? b : a), rows[0]);
    const last = probe();
    return {
      hadTarget, blockGone, progressJustAfter,
      peakAngleDeg: peak.angle * 180 / Math.PI,
      peakP: peak.p,
      maxForward: deepest.forward,
      forwardP: deepest.p,
      maxLateral: Math.max(...rows.map((r) => r.lateral)),
      finalGap: last.hand.distanceTo(restHand),
      finalAngle: last.axis.angleTo(restAxis),
      axisPeakDeg, forwardMin,
    };
  }, { axisPeakDeg: SWING_AXIS_PEAK_DEG, forwardMin: SWING_FORWARD_MIN });

  expect(result.hadTarget, '须先命中方块（前提断言）').toBe(true);
  expect(result.blockGone, '挖块须真的移除方块（前提断言）').toBe(true);
  expect(result.progressJustAfter, '挖之后挥动进度须从头开始').toBe(0);
  // 主判据：长轴真的转了（上游主摆动 70°，实测夹角峰 58.5°）。
  // 阈取实测值的 70%（两侧都不贴线）；注入「去掉 rotY(70°) 那一步」⇒ 真红。
  expect(result.peakAngleDeg,
    `长轴夹角峰须达实测量级（>${result.axisPeakDeg * 0.7}°），实测 ${result.peakAngleDeg.toFixed(1)}°`)
    .toBeGreaterThan(result.axisPeakDeg * 0.7);
  // 快出：峰值在前 45%（上游 sin(√p·π) 峰在 p=0.25，实测 0.27）
  expect(result.peakP, `横摆峰须在前 45%（快出），实测 p=${result.peakP}`).toBeLessThanOrEqual(0.45);
  // 手端向前探（实测最大 0.308 格）
  expect(result.maxForward,
    `手端须向前探（>${result.forwardMin} 格），实测 ${result.maxForward.toFixed(3)}`)
    .toBeGreaterThan(result.forwardMin);
  // 结束严格回位（位置与朝向都不残留）
  expect(result.finalGap, `挥动结束手端须回到静止，实测偏差 ${result.finalGap}`).toBeLessThan(1e-6);
  expect(result.finalAngle, '结束长轴朝向须回到静止').toBeLessThan(1e-6);
});

test('放置方块走玩家主路径触发手臂挥动', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const p0 = pl.physics.pos;
    const bx = Math.floor(p0.x);
    const by = Math.floor(p0.y) + 1;
    const bz = Math.floor(p0.z) - 3;
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('stone') });
    await new Promise((r) => setTimeout(r, 600));
    pl.setTestAim([0, 0, -1]);
    // 选中石头槽（背包是物品权威；快捷栏只是视图）
    const inv = pl.inventory;
    let slot = -1;
    for (let i = 0; i < inv.slots.length; i++) if (inv.slots[i].item === 'stone') { slot = i; break; }
    inv.selectSlot(slot);
    const prev = pl.target.prevPos.slice();
    const progressBefore = g.viewArm.swingProgress;
    pl.placeBlock();
    return {
      slot, progressBefore, progressAfter: g.viewArm.swingProgress,
      placedId: g.world.getBlockId(prev[0], prev[1], prev[2]),
      progressAfterTick: (await new Promise((r) => requestAnimationFrame(r)), g.viewArm.swingProgress),
    };
  });
  expect(result.slot, '背包里须有 stone 槽（前提断言）').toBeGreaterThanOrEqual(0);
  expect(result.progressBefore, '放之前不在挥动中').toBe(1);
  expect(result.progressAfter, '放置成功后须触发挥动').toBe(0);
  expect(result.placedId, '放置须真的写出方块（前提断言）').toBeGreaterThan(0);
});

test('挖空（未命中方块）也挥动 —— 玩家意图是「挖」，不取决于是否命中', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    // 竖直向上看天空 → 无命中
    pl.setTestAim([0, 1, 0]);
    const hadTarget = !!pl.target;
    pl.digBlock({});
    const afterSky = g.viewArm.swingProgress;

    // 命中不可破坏方块（bedrock）→ 也同样挥动（玩家确实在挖）
    const p0 = pl.physics.pos;
    const bx = Math.floor(p0.x);
    const by = Math.floor(p0.y) + 1;
    const bz = Math.floor(p0.z) - 3;
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('bedrock') });
    await new Promise((r) => setTimeout(r, 600));
    pl.setTestAim([0, 0, -1]);
    const hitBedrock = !!pl.target && g.world.getBlockId(...pl.target.blockPos) === g.registry.idOf('bedrock');
    const beforeBedrock = g.viewArm.swingProgress;
    pl.digBlock({});
    return {
      hadTarget, afterSky, hitBedrock, beforeBedrock,
      afterBedrock: g.viewArm.swingProgress,
    };
  });
  expect(result.hadTarget, '向上看天空须无命中（前提断言）').toBe(false);
  // v1.50：用户要求「只要试图消除方块就挥动，不管有没有成功消除」。
  // 对齐 mc-lite：它也是无条件 `this.swing()`（命中路径与 `else` 分支各一次）。
  expect(result.afterSky, '无命中时也须挥动（尝试即反馈）').toBe(0);
  expect(result.hitBedrock, '须命中 bedrock（前提断言）').toBe(true);
  expect(result.beforeBedrock, '挖 bedrock 前不在挥动中').toBe(1);
  expect(result.afterBedrock, '命中不可破坏方块时也须挥动').toBe(0);
});

test('挖掘触发的挥动不依赖世界是否真的改变（同一个挥动路径）', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async ({ axisPeakDeg, forwardMin }) => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const probe = () => {
      const m = new THREE.Matrix4().compose(
        g.viewArm.mesh.position, g.viewArm.mesh.quaternion, g.viewArm.mesh.scale);
      const at = (ly) => new THREE.Vector3(-1 / 16, ly, 0).applyMatrix4(m);
      const hand = at(-2 / 16);
      return { hand, axis: at(10 / 16).sub(hand).normalize(), p: g.viewArm.swingProgress };
    };
    // 无命中挖一次，记录完整挥动轨迹 —— 采样式断言证明它走的是**同一个**挥动实现，
    // 而不是「只置了进度但姿态不动」的假挥手。
    pl.setTestAim([0, 1, 0]);
    const rest = probe();
    const restHand = rest.hand.clone();
    const restAxis = rest.axis.clone();
    pl.digBlock({});
    const rows = [];
    for (let i = 0; i < 24; i++) {
      await frame();
      const s = probe();
      rows.push({
        p: s.p,
        angle: s.axis.angleTo(restAxis),
        forward: restHand.z - s.hand.z,
      });
    }
    const peak = rows.reduce((a, b) => (b.angle > a.angle ? b : a), rows[0]);
    const last = probe();
    return {
      peakAngleDeg: peak.angle * 180 / Math.PI,
      peakP: peak.p,
      maxForward: Math.max(...rows.map((r) => r.forward)),
      finalGap: last.hand.distanceTo(restHand),
      axisPeakDeg, forwardMin,
    };
  }, { axisPeakDeg: SWING_AXIS_PEAK_DEG, forwardMin: SWING_FORWARD_MIN });
  // 完整挥动（与成功挖掘走同一曲线）：长轴横摆达同一量级、快出、结束严格回位
  expect(result.peakAngleDeg,
    `长轴夹角峰须达实测量级，实测 ${result.peakAngleDeg.toFixed(1)}°`)
    .toBeGreaterThan(result.axisPeakDeg * 0.7);
  expect(result.peakP, `峰值须在前段（快出），实测 p=${result.peakP}`).toBeLessThanOrEqual(0.45);
  expect(result.maxForward, `手端须向前探，实测 ${result.maxForward.toFixed(3)}`)
    .toBeGreaterThan(result.forwardMin);
  expect(result.finalGap, '结束须回静止').toBeLessThan(1e-6);
});

test('手臂皮肤 Tier 4：整条手臂全肤色，朝前远端不得是异色块（差分像素）', async ({ page }) => {
  // **v3.46b 口径反转**（用户 2026-11-27：「手臂前方的蓝色部分也烘焙成跟手臂
  // 一样的色调，不然看起来感觉怪怪的」）：
  //   · v3.46 旧判据要求 teal（袖口）**≥ 200 且占比 > 5%** —— 那正是用户否掉的形态；
  //   · 新判据：**teal 近于 0**，且肤色占绝大多数。
  //
  // ⚠️ **光判「teal = 0」零判别力**：皮肤没加载 / UV 全错位 / 手臂根本没画，
  // teal 也是 0。故必须配三条正向判据：肤色像素数 / 肤色占比 / **远端分区也有肤色**。
  //
  // ⚠️ **远端分区是本条的核心**：沿手臂长轴（手端→肩端）分 10 档，
  // 实测旧版的 teal 12500 像素**全在 bin 8~9**（几何 y 最大端 = z 更负/y 更高
  // = 屏幕上朝前的远端）。只判全图均值会把那小块稀释掉。
  //
  // ⚠️ **仍用差分口径**（on = 有手臂 / off = 藏手臂）：真游戏页背景是整个世界。
  test.setTimeout(120_000);
  await boot(page);
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');                       // 冻结日夜漂移
    g.ocean.update = () => {};                      // 冻海面波纹
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    await new Promise((r) => setTimeout(r, 800));
    const grab = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const cv = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      res({ w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data });
    })));
    // 手端 / 肩端的屏幕坐标（定义长轴方向）
    const arm = g.viewArm;
    const m = new THREE.Matrix4().compose(arm.mesh.position, arm.mesh.quaternion, arm.mesh.scale);
    const cam = g.camera;
    const tanFov = Math.tan((cam.fov / 2) * Math.PI / 180);
    const scr = (ly) => {
      const v = new THREE.Vector3(-1 / 16, ly, 0).applyMatrix4(m);
      return [((v.x / (-v.z * tanFov * cam.aspect)) + 1) / 2 * innerWidth,
        (1 - v.y / (-v.z * tanFov)) / 2 * innerHeight];
    };
    const hand = scr(-2 / 16);
    const shoulder = scr(10 / 16);
    const ax = shoulder[0] - hand[0], ay = shoulder[1] - hand[1];
    const axisLen = Math.hypot(ax, ay) || 1;
    const ux = ax / axisLen, uy = ay / axisLen;

    const on = await grab();
    arm.mesh.visible = false;
    await new Promise((r) => setTimeout(r, 300));
    const off = await grab();
    arm.mesh.visible = true;

    let n = 0;
    let teal = 0;   // 衬衫色（应近于 0）
    let skinPx = 0; // 肤色：R > G > B 且 R−B 差显著
    let sx = 0; let sy = 0;
    // 远端（bin 8~9）与近端（bin 0~6）各自的肤色 / teal 计数
    let farSkin = 0; let farTeal = 0; let farN = 0;
    // 亮度直方图（立体感回归门，5 为一桶）
    const hist = new Map();
    for (let y = 0; y < on.h; y++) {
      for (let x = 0; x < on.w; x++) {
        const i = (on.w * y + x) * 4;
        const diff = Math.abs(on.d[i] - off.d[i]) + Math.abs(on.d[i + 1] - off.d[i + 1])
          + Math.abs(on.d[i + 2] - off.d[i + 2]);
        if (diff <= 8) continue;
        n++;
        sx += x; sy += y;
        const lum = Math.round((on.d[i] + on.d[i + 1] + on.d[i + 2]) / 3 / 5) * 5;
        hist.set(lum, (hist.get(lum) ?? 0) + 1);
        const t = ((x - hand[0]) * ux + (y - hand[1]) * uy) / axisLen;
        const isFar = t >= 0.8;
        if (isFar) farN++;
        const r = on.d[i], gg = on.d[i + 1], b = on.d[i + 2];
        const isTeal = r < 110 && gg > 90 && b > 90 && Math.abs(gg - b) < 40 && gg - r > 30;
        const isSkin = r > gg && gg > b && r - b > 30 && r > 110;
        if (isTeal) { teal++; if (isFar) farTeal++; }
        if (isSkin) { skinPx++; if (isFar) farSkin++; }
      }
    }
    const buckets = [...hist.values()].sort((a, b) => b - a);
    const lums = [];
    for (const [lum, c] of hist) for (let i = 0; i < c; i++) lums.push(lum);
    lums.sort((a, b) => a - b);
    const p95 = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.95))] || 1;
    const peaks = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([lum, c]) => ({ lum, c }));
    const first = peaks[0] || { lum: 0, c: 0 };
    const second = peaks.find((pk) => Math.abs(pk.lum - first.lum) / p95 > 0.10 && pk.c > 50) || null;
    return {
      armPixels: n, teal, skinPx, farN, farSkin, farTeal,
      centroidX: n ? sx / n / on.w : 0,
      centroidY: n ? sy / n / on.h : 0,
      hasMap: !!arm.material.map,
      largestBucketShare: buckets.length ? buckets[0] / n : 1,
      peakSeparation: second ? Math.abs(second.lum - first.lum) / p95 : 0,
    };
  });

  // 前提：皮肤真的挂上了（没挂上会退回中性肤色兜底，那时本条会假绿）
  expect(result.hasMap, '皮肤贴图须已加载并挂到材质上').toBe(true);
  expect(result.armPixels, `须测到手臂像素，实测 ${result.armPixels}`).toBeGreaterThan(2000);
  // ① **肤色占绝大多数**（实测 17212/17274 = 99.6%）。
  // 注入「UV 全指向外套层」⇒ 全透明 ⇒ armPixels 崩 ⇒ 前提断言真红。
  const skinShare = result.skinPx / result.armPixels;
  expect(skinShare, `肤色占比须 > 85%，实测 ${(skinShare * 100).toFixed(1)}%`)
    .toBeGreaterThan(0.85);
  // ② **衬衫色近于消失**（实测 0）。阈取手臂像素的 2%：
  // 旧版 teal 占 65%（12500/19192）⇒ 把袖口改回衬衫色会真红。
  const tealShare = result.teal / result.armPixels;
  expect(tealShare, `衬衫色占比须 < 2%（用户要求全肤色），实测 ${(tealShare * 100).toFixed(1)}%`)
    .toBeLessThan(0.02);
  // ③ **朝前的远端分区也是肤色**（本条的核心 —— 全图均值会把它稀释掉）。
  // 实测远端 bin 8~9 共 14383 像素，其中肤色 14383（旧版那一带是 teal 12420）。
  expect(result.farN, `前提：远端分区须有像素，实测 ${result.farN}`).toBeGreaterThan(500);
  const farSkinShare = result.farSkin / result.farN;
  expect(farSkinShare,
    `朝前远端须也是肤色（> 85%），实测 ${(farSkinShare * 100).toFixed(1)}%`)
    .toBeGreaterThan(0.85);
  expect(result.farTeal / result.farN,
    `朝前远端不得是蓝块（teal < 2%），实测 ${(result.farTeal / result.farN * 100).toFixed(1)}%`)
    .toBeLessThan(0.02);
  // ④ 手臂在**右下象限**（原版第一人称右手的方位）
  expect(result.centroidX, `手臂重心须在右半屏，实测 ${result.centroidX.toFixed(3)}`)
    .toBeGreaterThan(0.5);
  expect(result.centroidY, `手臂重心须在下半屏，实测 ${result.centroidY.toFixed(3)}`)
    .toBeGreaterThan(0.5);
  // ⑤ **立体感回归门**（v3.46b）：全肤色后曾实测到 **78.6% 像素挤在同一亮度桶、
  // 无双峰** —— 即 v1.56「一个颜色、没立体感」的回归。补灰阶面间亮度后实测
  // **39.7% / 峰距 15.2%**。两条阈都取两侧不贴线的档位：
  //   · 最大单桶 < 60%（变平态 78.6% 真红，当前 39.7% 留 20 点余量）；
  //   · 峰距 > 10%（变平态 0 真红，当前 15.2%）。
  // ⚠️ 这两条与上面的色相判据**互补**：色相判据抓「颜色不对」，
  // 这两条抓「颜色对了但变成一块色板」—— 后者正是本轮踩到的。
  expect(result.largestBucketShare,
    `最大单色占比须 < 60%（否则是一块色板），实测 ${(result.largestBucketShare * 100).toFixed(1)}%`)
    .toBeLessThan(0.60);
  expect(result.peakSeparation,
    `须有两个分离的亮度峰（面间差 > 10%），实测 ${(result.peakSeparation * 100).toFixed(1)}%`)
    .toBeGreaterThan(0.10);
});

test('手臂不投影（castShadow=false），且只给 camera 增 1 个节点', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    let meshes = 0;
    let casting = 0;
    g.viewArm.mesh.traverse((o) => { if (o.isMesh) { meshes++; if (o.castShadow) casting++; } });
    return { meshes, casting, cameraChildren: g.camera.children.length, draw: g.renderStats().drawCalls };
  });
  expect(result.meshes, '手臂须是单个 mesh').toBe(1);
  expect(result.casting, '视图模型不得 castShadow（同 M4 枪口径）').toBe(0);
  // camera 下：手臂 + 可能存在的 viewWeapon 节点
  expect(result.cameraChildren).toBeLessThanOrEqual(2);
});
