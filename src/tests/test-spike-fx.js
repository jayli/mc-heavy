// src/tests/test-spike-fx.js — 焰魔尖刺攻击的火焰尖锥（Tier 1：纯函数与池化）
//
// 覆盖「改坏了肉眼看不出来」的部分：5 根落点与朝向、递延延迟序列、
// 升起→保持→缩回的 scale 包络、**基准几何是 6 棱锥**、零活跃 visible。
//
// ⚠️ **首根必须在正前方 2 格，不在脚底**（与法阵 `FLAME_SIGIL.firstOffset = 0` 刻意不同）：
// 用户要「向**前** 10 格内放出尖刺」，首根长在自己脚下读不出「向前」。
//
// ⚠️ GPU 侧（additive 叠加结果）证明不了 → 由 `tests/ignis-spike.spec.mjs` 的
// Tier 4 像素实测兜住（橙红判据，带沙漠沙对照组 + 藏掉焰魔本体）。
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertDeepEqual, AssertionError,
} from './assert.js';
import * as THREE from 'three';
import { IGNIS_SPIKE, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { Game } from '../core/game.js';
import {
  SPIKE_FX, spikeSpawnPoints, spikeScaleAt, SpikeFxRenderer,
} from '../render/spike-fx.js';

/** 浮点比较（经 sin/cos 后无法精确等于字面量）。同 `test-flame-sigil.js` 的同名局部工具。 */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// ---------- 常量 ----------

test('spike fx: 渲染常量与玩法常量一致（同一事实不得两份）', () => {
  assertEqual(SPIKE_FX.riseMs, IGNIS_SPIKE.riseMs);
  assertEqual(SPIKE_FX.lifeMs, IGNIS_SPIKE.lifeMs);
  assertEqual(SPIKE_FX.height, IGNIS_SPIKE.height);
  assertEqual(SPIKE_FX.radius, IGNIS_SPIKE.radius);
  assertEqual(SPIKE_FX.maxActive, IGNIS_SPIKE.maxActive);
  assertTrue(Object.isFrozen(SPIKE_FX), '常量须冻结（渲染层不得改写）');
  assertTrue(SPIKE_FX.riseMs < SPIKE_FX.lifeMs, '升起段必须短于总寿命');
});

// ---------- 落点与朝向 ----------

test('spike fx: 5 根落点 = 正前方 2/4/6/8/10 格（本仓 yaw 口径）', () => {
  const pts = spikeSpawnPoints([10, 5, 20], 0);
  assertEqual(pts.length, 5);
  for (let i = 0; i < 5; i++) {
    const d = 2 + 2 * i;
    // yaw=0 ⇒ 正前方 = (−sin0, −cos0) = (0, −1) ⇒ 只动 z
    assertClose(pts[i].x, 10, 1e-9, `第 ${i} 根 x`);
    assertClose(pts[i].z, 20 - d, 1e-9, `第 ${i} 根 z`);
  }
  // yaw = π/2 ⇒ 正前方 = (−1, 0) ⇒ 只动 x
  const p2 = spikeSpawnPoints([10, 5, 20], Math.PI / 2);
  assertClose(p2[0].x, 8, 1e-9, 'yaw=π/2 首根 x');
  assertClose(p2[0].z, 20, 1e-9, 'yaw=π/2 首根 z');
});

test('spike fx: 首根在正前方 2 格，不在脚底（Review Focus 5）', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  assertTrue(Math.hypot(pts[0].x, pts[0].z) >= 2 - 1e-9,
    `首根距脚底 ${Math.hypot(pts[0].x, pts[0].z)} 格 —— 不得长在自己脚下`);
  // 最远一根 = 10 格（用户草图「向前 10 格内」）
  const last = pts[pts.length - 1];
  assertClose(Math.hypot(last.x, last.z), 10, 1e-9, '最远一根');
});

test('spike fx: 延迟序列 0/50/100/150/200ms（递延点亮）', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  assertDeepEqual(pts.map((p) => p.delayMs), [0, 50, 100, 150, 200]);
});

test('spike fx: 落点随 yaw 旋转等变（不是固定 −Z）', () => {
  const yaw = 0.7;
  const pts = spikeSpawnPoints([3, 0, -4], yaw);
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  for (let i = 0; i < pts.length; i++) {
    const d = 2 + 2 * i;
    assertClose(pts[i].x, 3 + fx * d, 1e-9, `第 ${i} 根 x`);
    assertClose(pts[i].z, -4 + fz * d, 1e-9, `第 ${i} 根 z`);
  }
});

// ---------- scale 包络 ----------

test('spike fx: 延迟期内不可见（scale 0），但 slot 不回收', () => {
  const e = spikeScaleAt(50, 200);
  assertFalse(e.visible, '延迟期内不得画');
  assertEqual(e.scale, 0);
  assertFalse(e.done, '延迟期内不得判 done（否则那根永远不出现）');
});

test('spike fx: 升起段 scale 从 0 单调增到 1', () => {
  const rise = SPIKE_FX.riseMs;
  let prev = -1;
  // ⚠️ 从 t>0 起量：t=0 时 scale=0 ⇒ visible=false（零尺寸不可见是正确的）。
  for (let t = rise / 10; t <= rise; t += rise / 10) {
    const e = spikeScaleAt(t, 0);
    assertTrue(e.visible, `t=${t} 须可见`);
    assertTrue(e.scale >= prev - 1e-9, `t=${t} scale ${e.scale} 比前一步 ${prev} 小`);
    prev = e.scale;
  }
  assertClose(spikeScaleAt(rise, 0).scale, 1, 1e-9, '升起结束须满尺寸');
  // t=0 恰好是「刚破土」：scale 0、不可见（不是缺陷）
  assertEqual(spikeScaleAt(0, 0).scale, 0);
});

test('spike fx: 保持段 scale === 1', () => {
  const mid = SPIKE_FX.riseMs + (SPIKE_FX.lifeMs - SPIKE_FX.riseMs) * 0.3;
  assertClose(spikeScaleAt(mid, 0).scale, 1, 1e-9);
});

test('spike fx: 缩回段 scale 单调降到 0，寿命末 done=true', () => {
  const from = SPIKE_FX.lifeMs * SPIKE_FX.shrinkFrom;
  let prev = 2;
  for (let t = from; t < SPIKE_FX.lifeMs; t += (SPIKE_FX.lifeMs - from) / 10) {
    const e = spikeScaleAt(t, 0);
    assertTrue(e.scale <= prev + 1e-9, `t=${t} scale ${e.scale} 比前一步 ${prev} 大`);
    prev = e.scale;
  }
  const end = spikeScaleAt(SPIKE_FX.lifeMs, 0);
  assertTrue(end.done, '寿命末须 done');
  assertFalse(end.visible);
  assertEqual(end.scale, 0);
});

test('spike fx: 延迟平移整条包络（不是只平移可见性）', () => {
  const delay = 200;
  const t = SPIKE_FX.riseMs * 0.5;
  const a = spikeScaleAt(t, 0);
  const b = spikeScaleAt(t + delay, delay);
  assertClose(b.scale, a.scale, 1e-9, '延迟后的包络须与无延迟时同形');
});

// ---------- 池化 ----------

test('spike fx: 几何是 6 棱锥，基准高度/半径取常量', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    const p = r.mesh.geometry.parameters;
    // ⚠️ **ConeGeometry.parameters 的键是 `radius`**（不是 CylinderGeometry 的
    // `radiusBottom`/`radiusTop`）—— three 源码重写了 parameters。
    // 锥顶恒为尖（ConeGeometry 内部向 super 传 radiusTop=0），故不需要断言 radiusTop。
    assertEqual(r.mesh.geometry.type, 'ConeGeometry', '必须是锥体而不是柱体');
    assertEqual(p.radialSegments, 6, '6 棱锥（像素风）');
    assertEqual(p.height, SPIKE_FX.height);
    assertEqual(p.radius, SPIKE_FX.radius);
  } finally {
    r.dispose();
  }
});

test('spike fx: additive 混合 + 不写深度（发光语义）', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    assertEqual(r.mesh.material.blending, THREE.AdditiveBlending);
    assertFalse(r.mesh.material.depthWrite);
    assertTrue(r.mesh.material.transparent);
  } finally {
    r.dispose();
  }
});

test('spike fx: 零活跃 visible=false，spawn 后 true，寿命结束后回 false', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    assertFalse(r.mesh.visible, '构造后零活跃不得提交渲染');
    assertEqual(r.activeCount, 0);
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
    r.update(1000 + SPIKE_FX.riseMs);
    assertTrue(r.mesh.visible, '升起后须可见');
    assertEqual(r.activeCount, 1);
    r.update(1000 + SPIKE_FX.lifeMs + 10);
    assertFalse(r.mesh.visible, '全部结束后须回 visible=false');
    assertEqual(r.activeCount, 0);
  } finally {
    r.dispose();
  }
});

test('spike fx: 5 根一次 spawn，逐根延迟到点后可见数递增', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    const pts = spikeSpawnPoints([0, 5, 0], 0).map((p) => ({ ...p, y: 5 }));
    r.spawn(pts, 1000);
    assertEqual(r.activeCount, 5);
    // t=1000+60：只有前两根（延迟 0/50）已过延迟期
    r.update(1000 + 60);
    let visible = 0;
    const m = new THREE.Matrix4();
    for (let i = 0; i < 5; i++) {
      r.mesh.getMatrixAt(i, m);
      if (Math.abs(m.elements[0]) > 1e-9) visible++;
    }
    assertEqual(visible, 2, `t=60ms 时应只有 2 根可见，实得 ${visible}`);
    // t=1000+250：全部过延迟期
    r.update(1000 + 250);
    visible = 0;
    for (let i = 0; i < 5; i++) {
      r.mesh.getMatrixAt(i, m);
      if (Math.abs(m.elements[0]) > 1e-9) visible++;
    }
    assertEqual(visible, 5, '全部延迟过后 5 根都可见');
  } finally {
    r.dispose();
  }
});

test('spike fx: NaN nowMs / NaN 落点不污染池', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], NaN);
    assertEqual(r.activeCount, 0, 'NaN nowMs 须整批拒绝');
    r.spawn([{ x: NaN, y: 5, z: -2, delayMs: 0 }, { x: 1, y: 5, z: -4, delayMs: 0 }], 1000);
    assertEqual(r.activeCount, 1, 'NaN 落点须跳过，合法的那根仍入池');
    r.update(1000 + SPIKE_FX.riseMs);
    const m = new THREE.Matrix4();
    r.mesh.getMatrixAt(1, m);
    assertTrue(m.elements.every(Number.isFinite), '实例矩阵不得含 NaN');
  } finally {
    r.dispose();
  }
});

test('spike fx: dispose 从场景移除并释放几何/材质', () => {
  const scene = new THREE.Scene();
  const r = new SpikeFxRenderer({ scene });
  // v3.23：尖锥 + 破土火星 + 上浮余烬 = 3 个 mesh（读 `meshes.length` 而不写死 3，
  // 但另钉一条「不得少于 3」防退化回只挂尖锥）。
  assertEqual(scene.children.length, r.meshes.length);
  assertTrue(r.meshes.length >= 3, '尖锥与两个粒子池都须挂进场景');
  r.dispose();
  assertEqual(scene.children.length, 0);
});

test('spike fx: 池满时覆盖最旧 slot（不无界增长）', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), maxActive: 4 });
  try {
    for (let i = 0; i < 10; i++) {
      r.spawn([{ x: i, y: 5, z: -2, delayMs: 0 }], 1000 + i);
    }
    assertTrue(r.activeCount <= 4, `活跃数 ${r.activeCount} 超过池容量 4`);
  } finally {
    r.dispose();
  }
});
// ---------- 装配与伤害结算（Task 6）----------
//
// 用 `Object.create(Game.prototype)` 造壳（同 `test-flame-sigil.js` 的既有手法）：
// `_consumeIgnisFxRequests` 只碰 world / registry / entities / ignises / spikeFx /
// blockHitFx / player，不需要 DOM/WebGPU。
// （`Game` 与 `IGNIS_TYPE` 已在文件顶部 import）

/**
 * 造一个只实现尖刺结算所需依赖的 Game 壳。
 *
 * @param {{playerPos:number[], groundY?:number, spikePoints?:Array}} opts
 *   `groundY` 地面顶面 y（`y < groundY` 实心）；缺省 10（焰魔脚底同高）
 */
function spikeGameFixture({ playerPos, groundY = 10 }) {
  const game = Object.create(Game.prototype);
  const isSolid = (_x, y, _z) => y < groundY;
  game.world = { isSolid, getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0) };
  game.registry = { nameOf: () => 'stone' };
  const damages = [];
  game._damagePlayer = (n) => { damages.push(n); return 20 - n; };
  // 玩家 AABB：宽 0.6、高 1.8（与 PlayerPhysics 同口径；这里只实现 overlapsBlock）
  const hw = 0.3;
  game.player = {
    physics: {
      pos: { x: playerPos[0], y: playerPos[1], z: playerPos[2] },
      overlapsBlock: (x, y, z) => {
        const [px, py, pz] = playerPos;
        return px - hw < x + 1 && px + hw > x
          && py < y + 1 && py + 1.8 > y
          && pz - hw < z + 1 && pz + hw > z;
      },
    },
  };
  const spawned = [];
  game.spikeFx = { spawn: (pts) => spawned.push(...pts) };
  // v3.22：碎石圆环已换成扩散火圈 ⇒ 壳里注入的是 fireRing（不再是 spawnSmashRing）
  game.fireRing = { spawn: () => {} };
  game.blockHitFx = { colorResolver: () => [0.5, 0.5, 0.5] };
  game.flameSigil = null;
  const state = { attackFxRequest: null };
  game.ignises = { activeEntities: () => [{ id: 'ignis:t:0', state }] };
  game.entities = { count: (t) => (t === IGNIS_TYPE ? 1 : 0) };
  return { game, state, damages, spawned };
}

test('spike fx 结算: 玩家站在尖刺格内扣 18，格外不扣', () => {
  // 焰魔在原点脚底 y=10、yaw=0 ⇒ 尖刺在 z = −2/−4/−6/−8/−10（格中心 −1.5/−3.5/…）
  // 玩家站在第 3 根（前方 6 格 ⇒ 刺心 z=−5.5，格 z∈[−6,−5)）⇒ 扣 18
  const hit = spikeGameFixture({ playerPos: [0.5, 10, -5.5] });
  hit.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  hit.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(hit.damages, [18], `站在刺上须扣 18，实得 ${JSON.stringify(hit.damages)}`);

  // 玩家在两根之间的间隙：刺格集合 = {−2,−4,−6,−8,−10}（刺心 0.5−d）
  // 玩家 z=−6.5 ⇒ AABB z∈[−6.8,−6.2] 只与格 −7 重叠，不在刺格集合里 ⇒ 不扣
  const miss = spikeGameFixture({ playerPos: [0.5, 10, -6.5] });
  miss.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  miss.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(miss.damages, [], `间隙里不得扣血，实得 ${JSON.stringify(miss.damages)}`);
});

test('spike fx 结算: 一次命中帧只扣一次（Review Focus 2）', () => {
  const f = spikeGameFixture({ playerPos: [0.5, 10, -5.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  // 瞬态字段：Agent 下一帧清 null ⇒ 后续帧不再结算
  f.state.attackFxRequest = null;
  for (let i = 0; i < 30; i++) f.game._consumeIgnisFxRequests(1000 + i * 16);
  assertDeepEqual(f.damages, [18], `30 帧后仍只扣一次，实得 ${JSON.stringify(f.damages)}`);
});

test('spike fx 结算: 玩家同时压住两根刺也只扣一次（不是每根 18）', () => {
  // 玩家宽 0.6，站在 z=−5.0 边界上会同时压住 −5 与 −6 格；刺只在 −6 ⇒ 仍一次。
  // 造「两根都压住」需要玩家跨两格且两格都有刺 —— 间距 2 格时不可能，
  // 故本条钉的是「命中即 break」的实现（若写成逐根累加，未来间距改 1 就会翻倍）。
  const f = spikeGameFixture({ playerPos: [0.5, 10, -5.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.damages.length, 1, '一次命中帧只结算一次伤害');
});

test('spike fx 结算: 尖刺伤害不看视线（与原版 ShieldSmashDamage 一致）', () => {
  // attackFxRequest 本身就绕过了 freshLos（Agent 无条件产生）⇒ 结算侧不得再查 LOS。
  // 造一个「玩家与焰魔之间全是实心墙」的世界：若结算侧查 LOS 就不会扣血。
  const f = spikeGameFixture({ playerPos: [0.5, 10, -5.5] });
  const origSolid = f.game.world.isSolid;
  f.game.world.isSolid = (x, y, z) => (z === -3 && y >= 10 && y <= 12) || origSolid(x, y, z);
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [18], '隔墙仍扣（原版特效与 AoE 都不看视线）');
});

test('spike fx 结算: 5 根都找到地面并 spawn（开阔地夹具）', () => {
  const f = spikeGameFixture({ playerPos: [0.5, 10, -20] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length, 5, `应 spawn 5 根，实得 ${f.spawned.length}`);
  for (const p of f.spawned) assertEqual(p.y, 10, '每根都贴地面顶面');
});

test('spike fx 结算: 另两招不出尖刺（招式过滤在装配层）', () => {
  for (const kind of ['shieldSmash', 'shieldBash', 'swing', 'spin']) {
    const f = spikeGameFixture({ playerPos: [0.5, 10, -5.5] });
    f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind };
    f.game._consumeIgnisFxRequests(1000);
    assertEqual(f.spawned.length, 0, `${kind} 不得出尖刺`);
    assertDeepEqual(f.damages, [], `${kind} 不得走尖刺伤害`);
  }
});
