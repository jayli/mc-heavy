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

const ARM_REST = -0.8;      // mc-lite 静止角（PlayerInteraction.js:932）
const ARM_BOTTOM = -1.67;   // 静止角 − 0.87（:930）。v1.49 起谷底出现在 p=0.25（原版快出曲线）
const INTENSITY = 0.15;     // v1.57：用户「晃动幅度还不够大，可以稍微大一些」（原版上限 0.1）
// ⚠️ 标称值 ≠ 实际幅度：一阶平滑在 1.35Hz 处通过率 ≈ 0.916，故实际 y 峰 ≈ 0.1375、x 峰 ≈ 0.0687。
// v1.51：旋转全部归零（用户要求「跑动时镜头始终水平，不要歪头」）→ 相机 roll/pitch 必须恒为 0。
// 跑动感全部来自位置平移（左右微移不改变任何朝向）。
const SWING_ROLL = 0.349;   // v1.49：原版甩腕 20°（sin(p²·π)，峰在 p≈0.707）

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
    const sample = () => {
      const p = pl.physics.pos;
      return {
        camX: g.camera.position.x - p.x,
        camY: g.camera.position.y - (p.y + 1.62 + pl._stepLift.offset),
        // v1.49：相机旋转分量（roll 绕 Z / pitch 绕 X）。pitch 须减去玩家自己的 pitch
        // （无头环境下恒 0，但写出来才不依赖那个前提）。
        roll: g.camera.rotation.z,
        pitch: g.camera.rotation.x - pl.pitch,
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
    const camVsBobRoll = Math.max(...settled.map((s) => Math.abs(s.roll - s.bobRoll)));
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
  expect(Math.abs(result.maxRoll), `跑动时相机 roll 必须为 0（不得歪头），实测 ${result.maxRoll}`).toBe(0);
  expect(Math.abs(result.maxPitch), `跑动时相机 pitch 必须为 0，实测 ${result.maxPitch}`).toBe(0);
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

test('挖块走玩家主路径触发手臂挥动（原版多轴：快出主劈 + 滞后甩腕）', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async ({ rest, bottom, roll }) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const p0 = pl.physics.pos;
    // 在正前方 3 格放一块石头并瞄准（与真人「看着方块挖」等价）
    const bx = Math.floor(p0.x);
    const by = Math.floor(p0.y) + 1;
    const bz = Math.floor(p0.z) - 3;
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('stone') });
    await new Promise((r) => setTimeout(r, 600));
    pl.setTestAim([0, 0, -1]);

    const before = { rot: g.viewArm.mesh.rotation.x, progress: g.viewArm.swingProgress };
    const hadTarget = !!pl.target;
    // 玩家主路径
    pl.digBlock({});
    const blockGone = g.world.getBlockId(bx, by, bz) === 0;
    const progressJustAfter = g.viewArm.swingProgress;

    // 逐帧采样挥动轨迹（含三轴与位移）
    const rows = [{
      p: g.viewArm.swingProgress,
      rot: g.viewArm.mesh.rotation.x,
      yaw: g.viewArm.mesh.rotation.y,
      roll: g.viewArm.mesh.rotation.z,
      z: g.viewArm.mesh.position.z,
    }];
    for (let i = 0; i < 24; i++) {
      await frame();
      rows.push({
        p: g.viewArm.swingProgress,
        rot: g.viewArm.mesh.rotation.x,
        yaw: g.viewArm.mesh.rotation.y,
        roll: g.viewArm.mesh.rotation.z,
        z: g.viewArm.mesh.position.z,
      });
    }
    // 主劈谷底（rotation.x 最小值）与它的进度 p：原版快出曲线下须落在 **p≤0.35**
    const deepest = rows.reduce((a, b) => (b.rot < a.rot ? b : a), rows[0]);
    // 甩腕峰值（|roll| 最大）与它的进度 p：滞后曲线下须落在 **p≥0.5**
    const maxRollRow = rows.reduce((a, b) => (Math.abs(b.roll) > Math.abs(a.roll) ? b : a), rows[0]);
    const maxYaw = Math.max(...rows.map((r) => Math.abs(r.yaw)));
    const minZ = Math.min(...rows.map((r) => r.z));
    return {
      hadTarget, blockGone, before, progressJustAfter,
      minRot: deepest.rot, deepestP: deepest.p,
      maxRoll: maxRollRow.roll, maxRollP: maxRollRow.p,
      maxYaw, minZ,
      finalRot: rows[rows.length - 1].rot,
      finalRoll: rows[rows.length - 1].roll,
      finalYaw: rows[rows.length - 1].yaw,
      rest, bottom, roll,
    };
  }, { rest: ARM_REST, bottom: ARM_BOTTOM, roll: SWING_ROLL });

  expect(result.hadTarget, '须先命中方块（前提断言）').toBe(true);
  expect(result.blockGone, '挖块须真的移除方块（前提断言）').toBe(true);
  expect(result.before.progress, '挖之前不在挥动中').toBe(1);
  expect(result.progressJustAfter, '挖之后挥动进度须从头开始').toBe(0);
  // 主劈谷底：与 mc-lite 的 −1.67 差不超过一帧的弧度步长（逐帧采样，峰值可能差一帧）
  expect(result.minRot, `挥动须到达谷底附近，实测 ${result.minRot}`).toBeLessThan(result.bottom + 0.1);
  expect(result.minRot, `挥动不得超出静态幅度，实测 ${result.minRot}`).toBeGreaterThanOrEqual(result.bottom - 1e-6);
  // **快出**：主劈谷底须在前 35% 的进度内到达（mc-lite 对称曲线是 50%）
  expect(result.deepestP, `主劈须快出（谷底在 p≤0.35），实测 p=${result.deepestP}`).toBeLessThanOrEqual(0.35);
  // **甩腕滞后**：滚转峰值须在后半段（原版 sin(p²·π) 峰在 p≈0.707）
  expect(result.maxRollP, `滚转须滞后（峰在 p≥0.5），实测 p=${result.maxRollP}`).toBeGreaterThanOrEqual(0.5);
  expect(Math.abs(result.maxRoll), `滚转须达配置幅度，实测 ${result.maxRoll}`).toBeGreaterThan(result.roll * 0.85);
  expect(Math.abs(result.maxRoll), `滚转不得超过配置幅度，实测 ${result.maxRoll}`).toBeLessThanOrEqual(result.roll + 1e-9);
  // 多轴：yaw 与向前位移都须发生（单轴还原会让画面「只是转了一下」）
  expect(result.maxYaw, `须有 yaw 分量，实测 ${result.maxYaw}`).toBeGreaterThan(0.05);
  expect(result.minZ, `须向前探，实测 z=${result.minZ}`).toBeLessThan(-0.12 - 0.01);
  // 结束严格回位（三轴都不残留）
  expect(result.finalRot, `挥动结束须回到静止角 ${result.rest}，实测 ${result.finalRot}`).toBeCloseTo(result.rest, 6);
  expect(result.finalRoll, `结束 roll 须归零，实测 ${result.finalRoll}`).toBeCloseTo(0, 6);
  expect(result.finalYaw, `结束 yaw 须归零，实测 ${result.finalYaw}`).toBeCloseTo(0, 6);
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
  const result = await page.evaluate(async ({ rest }) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    // 无命中挖一次，记录完整挥动轨迹 —— 采样式断言证明它走的是**同一个**挥动实现，
    // 而不是「只置了进度但姿态不动」的假挥手。
    pl.setTestAim([0, 1, 0]);
    pl.digBlock({});
    const rows = [];
    for (let i = 0; i < 24; i++) {
      await frame();
      rows.push({
        p: g.viewArm.swingProgress,
        rot: g.viewArm.mesh.rotation.x,
        roll: g.viewArm.mesh.rotation.z,
      });
    }
    const deepest = rows.reduce((a, b) => (b.rot < a.rot ? b : a), rows[0]);
    const maxRoll = rows.reduce((a, b) => (Math.abs(b.roll) > Math.abs(a.roll) ? b : a), rows[0]);
    return {
      minRot: deepest.rot,
      deepestP: deepest.p,
      maxRoll: maxRoll.roll,
      finalRot: rows[rows.length - 1].rot,
      rest,
    };
  }, { rest: ARM_REST });
  // 完整挥动（与成功挖掘走同一曲线）：快出谷底、滞后挂腕、结束严格回位
  expect(result.minRot, `须到达谷底附近，实测 ${result.minRot}`).toBeLessThan(ARM_BOTTOM + 0.1);
  expect(result.deepestP, `谷底须在前段（快出），实测 p=${result.deepestP}`).toBeLessThanOrEqual(0.35);
  expect(Math.abs(result.maxRoll), `须有挂腕分量，实测 ${result.maxRoll}`).toBeGreaterThan(SWING_ROLL * 0.85);
  expect(result.finalRot, `结束须回静止角，实测 ${result.finalRot}`).toBeCloseTo(result.rest, 6);
});

test('手臂有立体感：像素亮度分布须铺开（不是单一颜色）', async ({ page }) => {
  // 用户反馈「手臂的横面和竖面没有光影效果，感觉就是一个颜色，没有立体感」。
  // v1.56 修法 = 顶点色烘焙三层明暗（vanilla 面系数 × 固定光向 Lambert × 沿长度渐变），
  // 保持 unlit（不随日夜灯光漂移）。
  //
  // **判据为什么是「分布铺开」而不是「最大-最小差值」**：修好之前手臂本来就有 2 档
  // （底面/前面），最大最小差也能过 —— 但那正是「看着平」的状态。
  // 真正区分「平」与「有立体感」的是**中间过渡是否存在**：
  // 实测修复前 78.9% 像素挤在同一个亮度桶、只有 2 个桶；修复后 46.8%、11 个桶。
  test.setTimeout(90_000);
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.setVisualStyle('noon');                       // 冻结日夜漂移，否则相邻两帧世界色会变
    for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
    await new Promise((r) => setTimeout(r, 800));
    const grab = () => new Promise((res) => requestAnimationFrame(() => {
      const cv = g.renderer.domElement;
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      res({ w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data });
    }));
    const on = await grab();
    g.viewArm.mesh.visible = false;
    await new Promise((r) => setTimeout(r, 300));
    const off = await grab();
    g.viewArm.mesh.visible = true;
    const hist = new Map();
    let n = 0;
    for (let y = 0; y < on.h; y++) {
      for (let x = 0; x < on.w; x++) {
        const i = (on.w * y + x) * 4;
        const diff = Math.abs(on.d[i] - off.d[i]) + Math.abs(on.d[i + 1] - off.d[i + 1])
          + Math.abs(on.d[i + 2] - off.d[i + 2]);
        if (diff <= 8) continue;
        n++;
        const lum = Math.round((on.d[i] + on.d[i + 1] + on.d[i + 2]) / 3 / 5) * 5;
        hist.set(lum, (hist.get(lum) ?? 0) + 1);
      }
    }
    const buckets = [...hist.values()].sort((a, b) => b - a);
    // 亮度分位数（用于识别「面间双峰」：面间差 >> 面内渐变）
    const lums = [];
    for (const [lum, c] of hist) for (let i = 0; i < c; i++) lums.push(lum);
    lums.sort((a, b) => a - b);
    const p95 = lums[Math.min(lums.length - 1, Math.floor(lums.length * 0.95))] || 1;
    // **找第二个峰**：按像素数排序后的第二个局部极大（与最大峰相隔 >10% 亮度）。
    // 这是「面间差异」的直接证据 —— 面内渐变只会拉出一个宽峰，不会产生两个分离峰。
    const peaks = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([lum, c]) => ({ lum, c }));
    const first = peaks[0] || { lum: 0, c: 0 };
    const second = peaks.find((pk) => Math.abs(pk.lum - first.lum) / p95 > 0.10 && pk.c > 50) || null;
    return {
      armPixels: n,
      uniqueBuckets: hist.size,
      largestBucketShare: buckets.length ? buckets[0] / n : 1,
      secondPeakShare: second ? second.c / n : 0,
      peakSeparation: second ? Math.abs(second.lum - first.lum) / p95 : 0,
    };
  });
  // 前提：手臂确实占了一块屏幕
  expect(result.armPixels, `须测到手臂像素，实测 ${result.armPixels}`).toBeGreaterThan(2000);
  // ① 亮度桶数量：平色 = 1~2 个；有立体感 = 多个过渡档
  expect(result.uniqueBuckets, `亮度档位须 >= 6（修复前是 2），实测 ${result.uniqueBuckets}`).toBeGreaterThanOrEqual(6);
  // ② 最大单色占比：修复前 78.9%，修复后 46.8% —— 阈值取 65%，两侧都不贴线
  expect(result.largestBucketShare, `最大单色占比须 < 65%（修复前 78.9%），实测 ${(result.largestBucketShare * 100).toFixed(1)}%`)
    .toBeLessThan(0.65);
  // ③ **面间差异**（不能只靠同面渐变）：负向验证实测——把 Lambert 项或六面系数去掉后，
  //    上面两条仍会绿（长度渐变单独就能把分布铺开），所以必须额外钉「不同朝向的亮度不同」。
  //    判据 = 直方图须有**两个显著峰**且峰距够大。⚠️ 不能用 p75−p25：面内渐变会把分位数
  //    拉在两个峰之间（实测只有 6.3%），而真实面间差是 155 vs 115 ≈ 26%。
  expect(result.secondPeakShare, `须有第二个亮度峰（面间差异），实测 ${(result.secondPeakShare * 100).toFixed(1)}%`)
    .toBeGreaterThan(0.1);
  expect(result.peakSeparation, `两个亮度峰须相距 > 15%，实测 ${(result.peakSeparation * 100).toFixed(1)}%`)
    .toBeGreaterThan(0.15);
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
