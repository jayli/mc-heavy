// src/tests/test-carbine.js — KV-9 卡宾枪：弹匣状态机 / 换弹时间线 / 散布（Tier 1）
//
// 上游对照：`~/jaylli/bj-shooting-game/night-heron-src/src/game/weapon.js`
// 判据全部是**关系式或上游原值**，不写「实测冻结数」——
// 本模块是纯逻辑移植，真值来自上游代码而不是本仓的实测标定。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  CARBINE, CARBINE_COOLDOWN, CarbineMagazine,
  carbineReloadPose, carbineReloadSoundDue, carbineSpread, carbineJitteredDir,
} from '../player/weapons/carbine.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { WeaponController } from '../player/weapons/weapon-controller.js';
import { createRegistry } from '../voxel/block-registry.js';

/** 浮点近似断言（本仓 `assert.js` 无此函数，同 test-boss-agent.js 的 assertApprox 手法） */
function assertClose(actual, expected, eps = 1e-9, msg = '') {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg ? msg + ': ' : ''}期望 ${expected}±${eps}，实际 ${actual}`);
  }
}

// ---------- 常量：与上游对齐 ----------

test('carbine: 弹匣 40（用户裁定，上游是 30）/ 射速 690 / 换弹 2.15s', () => {
  // ⚠️ 40 是用户 2026-11-22 的裁定（上游 WEAPON.mag = 30）：不要拿上游值把它改回去。
  assertEqual(CARBINE.mag, 40);
  assertEqual(CARBINE.rpm, 690);
  assertEqual(CARBINE.reloadSeconds, 2.15);
  assertClose(CARBINE_COOLDOWN, 60 / 690, 1e-12);
  // catalog 的冷却必须**派生**自 rpm，不是另写一份 0.087
  assertClose(WEAPONS[WEAPON_IDS.CARBINE].cooldown, CARBINE_COOLDOWN, 1e-12);
});

test('carbine: 单发伤害派生自加特林（用户裁定「掉血完全一样」）', () => {
  assertEqual(WEAPONS[WEAPON_IDS.CARBINE].entityDamage,
    WEAPONS[WEAPON_IDS.MINIGUN].entityDamage);
  assertEqual(WEAPONS[WEAPON_IDS.CARBINE].entityRange,
    WEAPONS[WEAPON_IDS.MINIGUN].entityRange);
});

test('carbine: 无 reserve 字段（无限子弹）、无按键换弹字段', () => {
  const w = WEAPONS[WEAPON_IDS.CARBINE];
  assertFalse('reserve' in w, 'catalog 不得有 reserve —— 无限子弹');
  assertFalse('reloadKey' in w, '不做按键换弹');
  assertTrue(w.automatic === true, '按住连射');
});

// ---------- 换弹时间线 ----------

test('carbine pose: 未换弹（t<0）三曲线全 0 且弹匣可见', () => {
  const p = carbineReloadPose(-1);
  assertEqual(p.rig, 0); assertEqual(p.magOut, 0); assertEqual(p.rack, 0);
  assertTrue(p.magVisible);
});

test('carbine pose: rig 在 0.28s 到 1、保持到 1.82s、2.12s 回 0', () => {
  assertClose(carbineReloadPose(0).rig, 0, 1e-9);
  assertClose(carbineReloadPose(0.14).rig, 0.5, 1e-9);
  assertClose(carbineReloadPose(0.28).rig, 1, 1e-9);
  assertClose(carbineReloadPose(1.0).rig, 1, 1e-9);
  assertClose(carbineReloadPose(1.82).rig, 1, 1e-9);
  assertClose(carbineReloadPose(2.12).rig, 0, 1e-9);
  // 换弹结束时刻 rig 必须已归零（否则枪会歪着回到腰射位）
  assertClose(carbineReloadPose(CARBINE.reloadSeconds).rig, 0, 1e-9);
});

test('carbine pose: 弹匣 0.3s 起脱出、0.55s 全脱、0.95s 起插回、1.2s 到位', () => {
  assertClose(carbineReloadPose(0.3).magOut, 0, 1e-9);
  assertClose(carbineReloadPose(0.55).magOut, 1, 1e-9);
  assertClose(carbineReloadPose(0.95).magOut, 1, 1e-9);
  assertClose(carbineReloadPose(1.2).magOut, 0, 1e-9);
  // 全脱那一小段必须藏起来（上游 magOut < 0.98 才可见）
  assertFalse(carbineReloadPose(0.6).magVisible, '脱到底时弹匣应不可见');
  assertTrue(carbineReloadPose(0.4).magVisible);
  assertTrue(carbineReloadPose(1.3).magVisible);
});

test('carbine pose: rack 是以 1.76s 为中心、半宽 0.1s 的三角脉冲', () => {
  assertClose(carbineReloadPose(1.76).rack, 1, 1e-9);
  assertClose(carbineReloadPose(1.71).rack, 0.5, 1e-9);
  assertClose(carbineReloadPose(1.81).rack, 0.5, 1e-9);
  assertEqual(carbineReloadPose(1.66).rack, 0);
  assertEqual(carbineReloadPose(1.86).rack, 0);
  assertEqual(carbineReloadPose(0.5).rack, 0);
});

test('carbine pose: 三条曲线在 [0,1] 内且换弹结束时全部归零', () => {
  for (let t = 0; t <= CARBINE.reloadSeconds; t += 0.01) {
    const p = carbineReloadPose(t);
    for (const k of ['rig', 'magOut', 'rack']) {
      assertTrue(p[k] >= 0 && p[k] <= 1, `${k}=${p[k]} at t=${t.toFixed(2)} 越界`);
    }
  }
  const end = carbineReloadPose(CARBINE.reloadSeconds);
  assertClose(end.rig, 0, 1e-9);
  assertClose(end.magOut, 0, 1e-9);
  assertClose(end.rack, 0, 1e-9);
});

// ---------- 换弹音：跨越去重 ----------

test('carbine sound: 三段各只响一次（跨越比较，不是 t>=阈值）', () => {
  const marks = [CARBINE.reloadSound0At, CARBINE.reloadSound1At, CARBINE.reloadSound2At];
  // 逐帧 1/120s 走完整段换弹，收集所有 due
  const due = [];
  let stage = 0;
  let prev = 0;
  for (let t = 1 / 120; t <= CARBINE.reloadSeconds; t += 1 / 120) {
    const s = carbineReloadSoundDue(prev, t, stage);
    if (s >= 0) { due.push(s); stage = s + 1; }
    prev = t;
  }
  assertEqual(due.length, 3, `三段音应各一次，实际 ${due.length}`);
  assertEqual(due[0], 0); assertEqual(due[1], 1); assertEqual(due[2], 2);
  // 阈值之后 stage 已推进 ⇒ 不再返回同一段
  assertEqual(carbineReloadSoundDue(marks[0], marks[0] + 0.5, 1), -1);
});

test('carbine sound: 大 dt 一帧跨多段时按次序逐帧补齐，不丢段', () => {
  let stage = 0;
  const got = [];
  // 一帧从 0 跳到 2.0（跨过全部三个阈值）
  let s = carbineReloadSoundDue(0, 2.0, stage);
  while (s >= 0) { got.push(s); stage = s + 1; s = carbineReloadSoundDue(0, 2.0, stage); }
  assertEqual(got.length, 3);
  assertEqual(got.join(','), '0,1,2');
});

// ---------- 弹匣状态机 ----------

test('carbine mag: 初始满弹匣，consume 逐发递减到 0 后拒绝', () => {
  const m = new CarbineMagazine();
  assertEqual(m.ammo, CARBINE.mag);
  for (let i = 0; i < CARBINE.mag; i++) assertTrue(m.consume(), `第 ${i + 1} 发应成功`);
  assertEqual(m.ammo, 0);
  assertFalse(m.consume(), '空匣不得再消耗');
});

test('carbine mag: 打光后冷却过期 0.25s 自动进换弹（无需按键）', () => {
  const m = new CarbineMagazine();
  for (let i = 0; i < CARBINE.mag; i++) m.consume();
  // 冷却刚过期（0）时还不换 —— 上游 cool < -0.25 才换
  m.advance(1 / 60, 0);
  assertFalse(m.reloading, '冷却未过期 0.25s 时不该换弹');
  m.advance(1 / 60, -0.3);
  assertTrue(m.reloading, '冷却过期 0.3s 应自动换弹');
  assertEqual(m.reloadT, 0);
});

test('carbine mag: 换弹满 2.15s 后补满整匣（无限子弹，可重复无限次）', () => {
  const m = new CarbineMagazine();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < CARBINE.mag; i++) assertTrue(m.consume());
    m.advance(0.01, -1);          // 触发自动换弹
    assertTrue(m.reloading);
    // 推进到刚好不足 2.15s：仍是 0 发
    for (let t = 0; t < CARBINE.reloadSeconds - 0.02; t += 1 / 60) m.advance(1 / 60, -1);
    assertEqual(m.ammo, 0, '换弹未完成时不得提前补弹');
    m.advance(0.05, -1);
    assertFalse(m.reloading);
    assertEqual(m.ammo, CARBINE.mag, `第 ${round + 1} 轮换弹后应满弹`);
  }
});

test('carbine mag: 换弹中 consume 恒 false（换弹期不得开火）', () => {
  const m = new CarbineMagazine();
  m.consume(); m.startReload();
  for (let i = 0; i < 10; i++) { assertFalse(m.consume()); m.advance(1 / 60, -1); }
});

test('carbine mag: startReload 幂等，满弹匣时不启动', () => {
  const m = new CarbineMagazine();
  assertFalse(m.startReload(), '满弹匣不该换弹');
  m.consume();
  assertTrue(m.startReload());
  const t0 = m.reloadT;
  m.advance(0.5, -1);
  assertFalse(m.startReload(), '已在换弹时重复调用不得重置计时');
  assertTrue(m.reloadT > t0);
});

test('carbine mag: reset 回满弹匣且清换弹与散布', () => {
  const m = new CarbineMagazine();
  m.consume(); m.consume(); m.startReload(); m.advance(0.5, -1);
  m.reset();
  assertEqual(m.ammo, CARBINE.mag);
  assertFalse(m.reloading);
  assertEqual(m.spread, 0);
  assertEqual(m.reloadProgress, 1);
});

test('carbine mag: advance 逐帧返回三段音，且与 stage 推进一致', () => {
  const m = new CarbineMagazine();
  m.consume(); m.startReload();
  const due = [];
  for (let t = 0; t < CARBINE.reloadSeconds; t += 1 / 120) {
    const s = m.advance(1 / 120, -1);
    if (s >= 0) due.push(s);
  }
  assertEqual(due.join(','), '0,1,2');
});

test('carbine mag: reloadProgress 单调 0→1，未换弹时为 1', () => {
  const m = new CarbineMagazine();
  assertEqual(m.reloadProgress, 1);
  m.consume(); m.startReload();
  assertEqual(m.reloadProgress, 0);
  let prev = 0;
  while (m.reloading) {
    m.advance(1 / 60, -1);
    if (!m.reloading) break;
    assertTrue(m.reloadProgress >= prev - 1e-9, '进度必须单调不减');
    prev = m.reloadProgress;
  }
  assertEqual(m.reloadProgress, 1);
});

// ---------- 散布 ----------

test('carbine spread: 腰射基础值 = 上游 ads=0 端 0.0075', () => {
  assertClose(carbineSpread({ spread: 0, grounded: true, speed: 0 }), 0.0075, 1e-12);
});

test('carbine spread: 腾空 ×2.2、移动按 min(speed,8)×0.0018 叠加', () => {
  assertClose(carbineSpread({ spread: 0, grounded: false, speed: 0 }), 0.0075 * 2.2, 1e-12);
  assertClose(carbineSpread({ spread: 0, grounded: true, speed: 4 }), 0.0075 + 4 * 0.0018, 1e-12);
  // 速度钳到 8：本仓 SPEED=8，飞行 16 也不得让散布无限涨
  assertClose(carbineSpread({ spread: 0, grounded: true, speed: 16 }), 0.0075 + 8 * 0.0018, 1e-12);
});

test('carbine spread: 每发累积 0.0042、上限 0.03、每秒回落 0.055', () => {
  const m = new CarbineMagazine();
  for (let i = 0; i < 20; i++) m.consume();
  assertClose(m.spread, CARBINE.spreadMax, 1e-12, '20 发后应到上限 0.03');
  const before = m.spread;
  m.advance(0.1, 0);
  assertClose(m.spread, before - 0.1 * CARBINE.spreadDecayPerSecond, 1e-12);
  for (let i = 0; i < 100; i++) m.advance(0.1, 0);
  assertEqual(m.spread, 0, '长时间不开火后散布应归零而不是负数');
});

test('carbine jitter: 方向恒为单位向量，散布 0 时逐位等于 forward', () => {
  const f = [0, 0, -1], r = [1, 0, 0], u = [0, 1, 0];
  const d0 = carbineJitteredDir(f, r, u, 0, () => 0.5);
  assertClose(d0[0], 0, 1e-12); assertClose(d0[1], 0, 1e-12); assertClose(d0[2], -1, 1e-12);
  let seed = 1;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const d = carbineJitteredDir(f, r, u, 0.03, rand);
    assertClose(Math.hypot(d[0], d[1], d[2]), 1, 1e-9, '抖动后必须归一化');
    // 偏角不得超过 spread（小角近似下 tan≈angle，留 1.5 倍余量给归一化误差）
    const ang = Math.acos(Math.min(1, -(d[2])));
    assertTrue(ang <= 0.03 * 1.5, `偏角 ${ang} 超出散布 0.03`);
  }
});

test('carbine jitter: 圆内均匀（sqrt 校正）—— 半径分布不挤在圆心', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const f = [0, 0, -1], r = [1, 0, 0], u = [0, 1, 0];
  // ⚠️ **散布取小角（0.03，真实上限）**：大角度下「归一化后的横向分量」= sin(θ)
  // 而不是 θ，拿它当半径量会把分布量歪（spread=1 弧度时实测内圈占比 0.343，
  // 而真值仍是面积均匀）—— 那是**测量方法**的错，不是被测代码的错。
  const SPREAD = 0.03;
  let inner = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const d = carbineJitteredDir(f, r, u, SPREAD, rand);
    const rad = Math.hypot(d[0], d[1]) / SPREAD;   // 归一到 [0,1]
    if (rad < 0.5) inner++;
  }
  // 面积均匀 ⇒ 半径 <0.5 的比例应 ≈ 0.25；无 sqrt 校正时会是 0.5
  assertTrue(inner / N < 0.32, `内圈占比 ${(inner / N).toFixed(3)} 过高 —— sqrt 校正缺失`);
  assertTrue(inner / N > 0.18, `内圈占比 ${(inner / N).toFixed(3)} 过低`);
});
// ---------- controller 集成：弹匣门 / 抖动 DDA / 掉血口径 ----------

/**
 * controller fixture（与 test-weapons.js 同手法，但注入 `world` 让抖动后的 DDA 真跑）。
 *
 * ⚠️ **fake world 只实现 `getBlockId` + `registry`**：`raycastVoxel` 只读这两项。
 * 墙放在 x=6（准心方向 +X），故「未抖动时命中 x=6」是确定的。
 */
function makeCarbineControllerFixture({ entityDist = null, killed = false } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, cullMode: 'none' });
  registry.register('stone', { solid: true, cullMode: 'opaque' });
  registry.register('water', { solid: false, cullMode: 'transparent' });
  registry.freeze();
  const stoneId = registry.idOf('stone');
  const world = {
    registry,
    getBlockId(x, y, z) { return (x === 6 && y === 0 && z === 0) ? stoneId : 0; },
  };
  const editor = {
    singleCalls: 0,
    setBlock(c) { this.singleCalls++; this.last = c; return { changes: [{}] }; },
    setBlocks() { return { changes: [] }; },
  };
  const damageCalls = [];
  const effects = [];
  const controller = new WeaponController({
    registry, world,
    blockQuery: { getBlockId: (x, y, z) => world.getBlockId(x, y, z) },
    editor,
    onEffect: (e) => effects.push(e),
  });
  controller.setEntityQuery({
    raycast(origin, dir, maxDist) {
      if (entityDist === null || entityDist > maxDist) return null;
      return { id: 'z0', type: 'zombie', dist: entityDist };
    },
    damage(id, amount, nowMs) { damageCalls.push({ id, amount, nowMs }); return { dead: killed }; },
    wasKilled() { return killed; },
  });
  controller.select(WEAPON_IDS.CARBINE);
  const aim = {
    origin: [0, 0.5, 0.5], forward: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    target: { hit: true, blockPos: [6, 0, 0], normal: [-1, 0, 0], dist: 6 },
    grounded: true, speed: 0,
  };
  return { controller, aim, effects, damageCalls, editor, world };
}

test('carbine controller: 打光整匣后自动换弹，换弹期不开火，2.15s 后继续连射', () => {
  const { controller, aim } = makeCarbineControllerFixture();
  // ⚠️ **先数 pointerDown 那一发**：它同步返回效果但**不经过 onEffect**
  // （只有 `_tryFire` 路径才回调）—— 只数 update 返回值会漏计第一发（实测 29 vs 30）。
  let shots = 0;
  const count = (out) => {
    for (const e of out) {
      if (e.type === 'shot' || e.type === 'entity-hit') shots++;
      if (e.type === 'carbine-reload-start') sawReload = true;
    }
  };
  let sawReload = false;
  let reloadStartFrame = -1;
  count(controller.pointerDown(aim));
  // ⚠️ **用 controller 自己的推进路径数发数**，不用「t ≥ (n−1)·cool」的理论值：
  // ⚠️ 逐帧量化会把最后一发推到理论时刻之后（整匣 40 发时理论 3.391s，实测约 3.5s），
  //    写理论值会假红。
  // 跑到刚好打光（上限 600 帧 = 5s，远大于所需）
  for (let i = 0; i < 600 && shots < CARBINE.mag; i++) count(controller.update(1 / 120, aim));
  assertEqual(shots, CARBINE.mag, `应恰好打光 ${CARBINE.mag} 发`);
  // 再跑 1s：必须已进换弹（延迟 0.25s）
  for (let i = 0; i < 120; i++) {
    count(controller.update(1 / 120, aim));
    if (sawReload && reloadStartFrame < 0) reloadStartFrame = i;
  }
  assertTrue(sawReload, '打光后必须发换弹起手事件');
  assertTrue(controller.carbineMag.reloading, '打光 + 1s 时应仍在换弹（2.15s）');
  // 换弹期继续推进：不得有任何开火事件
  const before = shots;
  for (let i = 0; i < 60; i++) count(controller.update(1 / 120, aim));
  assertEqual(shots, before, '换弹期不得开火');
  // 推进到换弹结束 → 恢复连射
  for (let i = 0; i < 300; i++) count(controller.update(1 / 120, aim));
  assertTrue(shots > before, '换弹完成后必须恢复连射（无限子弹）');
  assertTrue(controller.carbineMag.ammo <= CARBINE.mag);
});

test('carbine controller: 松开左键也把弹匣换完（换弹不依赖 triggerHeld）', () => {
  const { controller, aim } = makeCarbineControllerFixture();
  controller.pointerDown(aim);
  // 打光 + 进换弹（同上用推进路径，不写理论秒数）
  for (let i = 0; i < 600 && controller.carbineMag.ammo > 0; i++) controller.update(1 / 120, aim);
  for (let i = 0; i < 120 && !controller.carbineMag.reloading; i++) controller.update(1 / 120, aim);
  assertTrue(controller.carbineMag.reloading, '应已进入换弹');
  controller.pointerUp();
  for (let i = 0; i < 300; i++) controller.update(1 / 120, aim);
  assertFalse(controller.carbineMag.reloading, '松手后换弹仍须走完');
  assertEqual(controller.carbineMag.ammo, CARBINE.mag, '松手后仍应补满');
});

test('carbine controller: 三段换弹音各发一次事件，段号 0/1/2', () => {
  const { controller, aim, effects } = makeCarbineControllerFixture();
  controller.pointerDown(aim);
  // 打光 → 换弹走完（总共约 5.2s）⇒ 跑 8s 余量
  for (let i = 0; i < 960; i++) controller.update(1 / 120, aim);
  const stages = effects.filter((e) => e.type === 'carbine-reload-stage');
  assertTrue(stages.length >= 3, `至少三段音，实际 ${stages.length}`);
  assertEqual(stages[0].reloadStage, 0);
  assertEqual(stages[1].reloadStage, 1);
  assertEqual(stages[2].reloadStage, 2);
  // 三个音必须两两不同（共用一个 = 三段动作只听到一声）
  const ids = stages.slice(0, 3).map((e) => e.sound);
  assertEqual(new Set(ids).size, 3, `三段音应不同，实际 ${ids.join(',')}`);
  for (const e of stages) assertEqual(e.recoil, 0, '换弹事件的 recoil 必须是 0 而不是缺席');
});

test('carbine controller: 抖动后重新发 DDA —— 命中格随弹道变，不恒等于准心格', () => {
  const { controller, aim, effects } = makeCarbineControllerFixture();
  // 大散布：把 spread 推到上限并腾空（×2.2）⇒ 偏角可达 0.08 弧度，6 格处横偏 ~0.5 格
  controller.carbineMag.spread = CARBINE.spreadMax;
  const airAim = { ...aim, grounded: false, speed: 8 };
  const cells = new Set();
  for (let i = 0; i < 40; i++) {
    controller.carbineMag.spread = CARBINE.spreadMax;
    controller.cooldown = 0;
    const out = controller.fireOnce(airAim);
    for (const e of out) {
      for (const imp of e.impacts ?? []) cells.add(imp.blockPos.join(','));
      // 曳光终点也必须跟着抖动（不是恒在准心轴上）
      if (e.end) cells.add(`end:${e.end[1].toFixed(3)},${e.end[2].toFixed(3)}`);
    }
  }
  assertTrue(cells.size > 1, `抖动后命中点应有分布，实际只有 ${cells.size} 种`);
});

test('carbine controller: 命中实体的掉血 = 加特林，且带 hitstop/trauma', () => {
  const hit = makeCarbineControllerFixture({ entityDist: 3, killed: false });
  const out = hit.controller.fireOnce(hit.aim);
  assertEqual(hit.damageCalls.length, 1);
  assertEqual(hit.damageCalls[0].amount, WEAPONS[WEAPON_IDS.MINIGUN].entityDamage);
  assertEqual(out[0].type, 'entity-hit');
  assertEqual(out[0].carbineHit.killed, false);
  assertClose(out[0].carbineHit.hitstop, CARBINE.hitstopHit, 1e-12);
  assertClose(out[0].carbineHit.trauma, CARBINE.traumaHit, 1e-12);
  // 击杀 → 大反馈
  const kill = makeCarbineControllerFixture({ entityDist: 3, killed: true });
  const ko = kill.controller.fireOnce(kill.aim);
  assertEqual(ko[0].carbineHit.killed, true);
  assertClose(ko[0].carbineHit.hitstop, CARBINE.hitstopKill, 1e-12);
  assertClose(ko[0].carbineHit.trauma, CARBINE.traumaKill, 1e-12);
});

test('carbine controller: 效果事件带 carbineTracer（走独立池）且无 tracer（不进旧池）', () => {
  const { controller, aim } = makeCarbineControllerFixture();
  const out = controller.fireOnce(aim);
  assertEqual(out[0].tracer, undefined, '不得进 TracerRenderer 的旧池');
  assertTrue(Array.isArray(out[0].carbineTracer.color));
  assertClose(out[0].carbineTracer.speed, CARBINE.tracerSpeed, 1e-12);
  assertClose(out[0].carbineTracer.width, CARBINE.tracerWidth, 1e-12);
  assertTrue(out[0].carbineKick.pitch > 0, '每发必须有后坐冲量');
  assertClose(out[0].carbineKick.trauma, CARBINE.shotTrauma, 1e-12);
});

test('carbine controller: 枪械破坏开关与 TNT 语义与既有枪一致', () => {
  const off = makeCarbineControllerFixture();
  off.controller.setBlockDamage(false);
  off.controller.fireOnce(off.aim);
  assertEqual(off.editor.singleCalls, 0, '开关关闭时不写方块');
  const on = makeCarbineControllerFixture();
  on.controller.setBlockDamage(true);
  on.controller.fireOnce(on.aim);
  assertEqual(on.editor.singleCalls, 1, '开关开启时删命中格');
});

test('carbine controller: 切枪重置弹匣（不带旧枪的换弹进度）', () => {
  const { controller, aim } = makeCarbineControllerFixture();
  controller.pointerDown(aim);
  for (let i = 0; i < 600 && controller.carbineMag.ammo > 0; i++) controller.update(1 / 120, aim);
  for (let i = 0; i < 120 && !controller.carbineMag.reloading; i++) controller.update(1 / 120, aim);
  assertTrue(controller.carbineMag.reloading);
  controller.select(WEAPON_IDS.PISTOL);
  assertFalse(controller.carbineMag.reloading, '切枪应清换弹');
  assertEqual(controller.carbineMag.ammo, CARBINE.mag);
  // 切回来仍是满弹
  controller.select(WEAPON_IDS.CARBINE);
  assertEqual(controller.carbineMag.ammo, CARBINE.mag);
});

test('carbine controller: 其余四把枪的 cooldown 仍钳 0（逐位不变）', () => {
  const { controller, aim } = makeCarbineControllerFixture();
  for (const id of [WEAPON_IDS.PISTOL, WEAPON_IDS.MAG7, WEAPON_IDS.MINIGUN, WEAPON_IDS.SWORD]) {
    controller.select(id);
    controller.fireOnce(aim);
    for (let i = 0; i < 400; i++) controller.update(1 / 60, aim);
    assertEqual(controller.cooldown, 0, `${id} 的冷却必须钳在 0`);
  }
  // 卡宾枪则允许变负（自动换弹判据靠它）
  controller.select(WEAPON_IDS.CARBINE);
  controller.cooldown = 0;
  controller.update(0.5, aim);
  assertTrue(controller.cooldown < 0, '卡宾枪冷却必须能变负');
});
