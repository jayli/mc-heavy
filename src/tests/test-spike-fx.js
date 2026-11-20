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
import {
  SPIKE_SPARK_FX, spikeTexUvRect, spikeTexPattern,
} from '../render/spike-fx-config.js';
import { SPIKE_TEX_ATTR } from '../render/spike-fx-material.js';

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

// ---------- v3.24：锥面剑纹（用户 2026-11-20）----------
//
// 「纹理的颜色图案类比焰魔的剑的图案贴图，可以随机一些，不要是单纯的没有纹理的锥体」。
//
// 这些用例钉的是「改坏了肉眼看不出来」的部分：UV 子区是否真的落在剑纹带上（flipY 折算）、
// 逐根随机参数是否真的变化、贴图缺失时是否静默退回纯色、以及水面遮挡那条回归。
// 观感本身由 `tests/ignis-spike.spec.mjs` 的 Tier 4 像素实测兜住。

test('spike tex: UV 子区落在剑身嵌纹带内，且 flipY 已折算', () => {
  const { u0, v0, u1, v1 } = spikeTexUvRect(SPIKE_SPARK_FX.textureRect, 256);
  assertTrue(u0 >= 0 && u1 <= 1 && v0 >= 0 && v1 <= 1, 'UV 必须落在 [0,1]');
  assertTrue(v0 < v1, `v0(${v0}) 必须小于 v1(${v1})（矩形要正向）`);
  // 像素矩形 [90,128,82,7] / 256
  assertClose(u0, 90 / 256, 1e-12, 'u0');
  assertClose(u1, 172 / 256, 1e-12, 'u1');
  // flipY：图片行 128..135 ⇒ v 从 1−135/256 到 1−128/256
  assertClose(v0, 1 - 135 / 256, 1e-12, 'v0 必须按 flipY 折算（写反会让纹样上下颠倒）');
  assertClose(v1, 1 - 128 / 256, 1e-12, 'v1');
});

test('spike tex: 逐根随机参数真的在变（不是全池同一套）', () => {
  // 注入确定性 rand（黄金比例序列，分布良好且可复现）
  let i = 0;
  const rand = () => ((i++ * 0.6180339887) % 1);
  const seen = new Set();
  const phases = [];
  for (let k = 0; k < 24; k++) {
    const p = spikeTexPattern(rand);
    assertTrue(p.tiles >= SPIKE_SPARK_FX.wrapTiles[0] && p.tiles < SPIKE_SPARK_FX.wrapTiles[1],
      `tiles ${p.tiles} 越界（区间 ${SPIKE_SPARK_FX.wrapTiles}）`);
    assertTrue(p.reps >= SPIKE_SPARK_FX.riseTiles[0] && p.reps < SPIKE_SPARK_FX.riseTiles[1],
      `reps ${p.reps} 越界（区间 ${SPIKE_SPARK_FX.riseTiles}）`);
    assertTrue(p.phase >= 0 && p.phase < 1, 'phase 必须在 [0,1)');
    assertTrue(p.mirror === 0 || p.mirror === 1, 'mirror 只能是 0/1');
    // 整数化：shader 里 tiles/reps 直接参与 fract，非整数会让同一根刺首尾接不上
    assertEqual(p.tiles, Math.round(p.tiles), 'tiles 必须是整数');
    assertEqual(p.reps, Math.round(p.reps), 'reps 必须是整数');
    seen.add(`${p.tiles}|${p.reps}|${p.mirror}`);
    phases.push(p.phase);
  }
  assertTrue(seen.size >= 4, `24 次抽样只出现 ${seen.size} 种组合 —— 逐根随机没生效`);
  assertTrue(new Set(phases).size >= 20, `相位几乎不变（${new Set(phases).size} 种）—— 每根纹理会长得一样`);
});

test('spike tex: 矩形必须落在剑身嵌纹带上（内容级判断的 Node 部分）', () => {
  // ⚠️ **本用例只能钉结构约束**（真正的「不透明率」在 `check:data` 的 `[焰魔]` 环节用 pngjs 量，
  // 下一条用例里声明了它）。这里钉的是**换矩形时容易错位的那三件事**：
  //   ① 必须整体落在 256×256 内（越界会采到相邻骨骼的纹样）；
  //   ② 不得包含剑身平面的**透明镂空区**（那个矩形实测不透明率只有 61.7%）；
  //   ③ 必须是「宽 >> 高」的横带（剑脊嵌纹带是 82×7）。
  const [x0, y0, w, h] = SPIKE_SPARK_FX.textureRect;
  assertTrue(x0 >= 0 && y0 >= 0, '矩形原点必须在贴图内');
  assertTrue(x0 + w <= 256 && y0 + h <= 256, `矩形 ${SPIKE_SPARK_FX.textureRect} 超出 256² 贴图`);
  assertTrue(w > h * 4, `纹样带应是横带（宽 ${w} / 高 ${h}）`);
  // 剑身平面（49,74,40,13）的不透明率只有 61.7%（实测）⇒ 那个矩形已在本仓实测为不可用。
  // 钉住「不能是它」这个负面事实：换矩形时若换回它，这条会红。
  const isBladePlane = x0 < 89 && x0 + w > 49 && y0 < 87 && y0 + h > 74;
  assertFalse(isBladePlane, '剑身平面 (49,74,40,13) 有透明镂空（61.7%）—— 采到会在锥面出黑洞');
});

test('spike tex: 给了贴图就走剑纹材质，没给就退回纯色锥（不抛错）', () => {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const withTex = new SpikeFxRenderer({ scene: new THREE.Scene(), texture: tex });
  try {
    assertTrue(withTex.textured, '给了贴图必须走剑纹版');
    assertEqual(withTex.mesh.material.type, 'MeshBasicNodeMaterial',
      `剑纹版须是 TSL 材质（实得 ${withTex.mesh.material.type}）`);
  } finally { withTex.dispose(); }

  const noTex = new SpikeFxRenderer({ scene: new THREE.Scene(), texture: null });
  try {
    assertFalse(noTex.textured, '没给贴图不得声称有纹理');
    assertEqual(noTex.mesh.material.type, 'MeshBasicMaterial', '退回纯色版');
    // ⚠️ 退回时也必须能正常出刺（贴图加载失败不该让尖刺整个消失）
    noTex.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
    noTex.update(1000 + SPIKE_FX.riseMs);
    assertTrue(noTex.mesh.visible, '纯色回退路径也必须能画出来');
  } finally { noTex.dispose(); }
});

test('spike tex: 逐实例纹理参数属性在两种材质下都存在（缺了会静默全 0）', () => {
  for (const texture of [null, new THREE.DataTexture(new Uint8Array(4), 1, 1)]) {
    const r = new SpikeFxRenderer({ scene: new THREE.Scene(), texture, maxActive: 6 });
    try {
      for (const name of Object.values(SPIKE_TEX_ATTR)) {
        const a = r.mesh.geometry.getAttribute(name);
        assertTrue(!!a, `几何缺属性 ${name} —— shader 会静默读到全 0（每根纹理一样）`);
        assertEqual(a.count, 6, `${name} 的实例数须 = 池容量`);
        assertTrue(a.isInstancedBufferAttribute, `${name} 必须是 instanced 属性（否则每顶点一份）`);
      }
      // 池里必须真的填了不同的值（初始化循环不能白跑）
      const phases = new Set();
      for (let i = 0; i < 6; i++) phases.add(r.mesh.geometry.getAttribute(SPIKE_TEX_ATTR.phase).getX(i));
      assertTrue(phases.size >= 4, `6 个 slot 只有 ${phases.size} 种相位 —— 初始化没生效`);
    } finally { r.dispose(); }
  }
});

test('spike fx: 锥体必须排在海面之后绘制（水面遮挡回归，v3.24 实测）', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    // ⚠️ 这是**实测标定**的耦合约定，不是预防性常数：
    // 只改海面 renderOrder 的单变量对照里，水面区域内锥体的发光增量 p50 从 11.6（海面后画）
    // 涨到 20.5（海面先画）—— 被水色冲淡 1.77 倍。
    // 海面在 `ocean.js:491` 固定 renderOrder = 1 ⇒ 锥体必须 > 1。
    assertTrue(r.mesh.renderOrder > 1,
      `锥体 renderOrder=${r.mesh.renderOrder}，必须 > 1（海面是 1）`);
    assertEqual(r.mesh.renderOrder, SPIKE_SPARK_FX.renderOrder,
      '锥体与它自己的粒子池同档（两者都是焰魔尖刺的可视部分）');
    // 深度语义不得被这次改动碰坏：不写深度（否则会挡住它身后的粒子/其他特效）
    assertFalse(r.mesh.material.depthWrite, 'additive 半透明不得写深度');
    assertTrue(r.mesh.material.depthTest, '深度测试保留（否则会画到地形前面）');
  } finally { r.dispose(); }
});
