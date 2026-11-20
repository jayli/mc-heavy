// src/tests/test-ambient-fx.js — 森林落叶 + 草地萤火虫（Tier 1，v3.26）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md
//
// 覆盖「改坏了肉眼玩不出来」的部分：
//   · 两张常量表的冻结与关系式（秋色权重和 ≡ 1 / 出生带不高于树冠 / 容量装得下夜间上限）；
//   · 出生采样是**圆内面积均匀**（不是角度均匀 ⇒ 不挤在圆心）；
//   · 运动闭式复刻：落叶 y 单调不增且不穿地、**落地后摆荡与自转全部冻结**；
//   · 萤火虫 y 无长期漂移（不飘上天也不钻地）、三轴异频；
//   · 夜间 gain/count 单调不减、count 不越界；
//   · 池账与门控：非目标 biome 零 isSolid 调用、关闭态 uTime 仍推进。
//
// ⚠️ GPU 侧（TSL 在 GPU 求值）证明不了 → `tests/ambient-fx.spec.mjs` 的 Tier 4 像素实测兜住。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  LEAF_FX, FIREFLY_FX, LEAF_AUTUMN_WEIGHTS,
  leafSeedAt, fireflySeedAt, pickAutumnLeaf,
  leafLandSeconds, leafMotionAt, fireflyMotionAt, fireflyNightAt, ambientParticleCount,
} from '../render/ambient-fx-config.js';
import { CINDER_FX } from '../render/cinder-fall-config.js';
import { LEAF_ATTR, createLeafGeometry, createLeafMaterial } from '../render/leaf-fx-material.js';
import { LeafFxRenderer } from '../render/leaf-fx.js';
import {
  FIREFLY_ATTR, createFireflyGeometry, createFireflyMaterial,
} from '../render/firefly-fx-material.js';
import { FireflyFxRenderer } from '../render/firefly-fx.js';
import { DEFAULT_SETTINGS, resolveSettings } from '../ui/settings.js';

/** 取真正的 TSL 函数体（照 test-spike-sparks.js 的 nodeSource/nodeCode，含去注释） */
function nodeSource(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node.jsFunc === 'function') return String(node.jsFunc);
  for (const k of ['node', 'shaderNode']) {
    if (node[k]) { const s = nodeSource(node[k], depth + 1); if (s) return s; }
  }
  return '';
}
const nodeCode = (n) => nodeSource(n).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** 确定性 LCG（同 test-spike-sparks.js 的 makeRand） */
function makeRand(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('ambient: 两张常量表冻结，renderOrder 与既有特效同档', () => {
  assertTrue(Object.isFrozen(LEAF_FX) && Object.isFrozen(FIREFLY_FX), '须冻结');
  assertEqual(LEAF_FX.renderOrder, CINDER_FX.renderOrder);
  assertEqual(FIREFLY_FX.renderOrder, CINDER_FX.renderOrder);
});

test('ambient: 秋色权重和恰为 1（不做归一化兜底）', () => {
  const sum = LEAF_AUTUMN_WEIGHTS.reduce((n, [, w]) => n + w, 0);
  assertTrue(Math.abs(sum - 1) < 1e-9, `权重和 ${sum}`);
});

test('ambient: 出生带上界不超过森林叶层聚合上界（用户点名「高于树不得有落叶」）', () => {
  // 实测：33×33 森林范围内代码生成树的叶层相对地面上界 +14（spec §3.3）
  assertTrue(LEAF_FX.birthMax < 14, `birthMax=${LEAF_FX.birthMax}`);
  assertTrue(LEAF_FX.birthMin >= 2, '下界须在矮树叶层最低处之上');
});

test('ambient: 地面扫描深度须容得下传送落点高度（否则整池播不出来）', () => {
  // ⚠️⚠️ 本轮浏览器实测：`_teleportTo(x, 45, z)` 是既有 spec 的标准落点，而森林真地面
  // 在 y≈8 ⇒ 相距 **37 格**。首版 searchDepth=24 ⇒ 扫描窗口 [45,21] 够不到地面
  // ⇒ **220 片全部跳过**（零报错、visible=true、count=220 全对）。
  // rain 用的是 56；本表不得低于「传送高度 45 − 海平面附近地面」的践离。
  assertTrue(LEAF_FX.searchDepth >= 45, `落叶 searchDepth=${LEAF_FX.searchDepth} 太浅`);
  assertTrue(FIREFLY_FX.searchDepth >= 45, `萤火虫 searchDepth=${FIREFLY_FX.searchDepth} 太浅`);
});

test('ambient: 落叶飘速与萤火虫密度是用户裁定的翻倍值（v3.26b）', () => {
  // 用户 2026-11-20：「落叶飘速度快一倍，萤火虫数量多一倍」。
  // 钉**相对首版的倍率**而不是裸数字：首版 fallSpeed [0.55,0.90]、countDay 28 / countNight 42。
  assertEqual(LEAF_FX.fallSpeed[0], 1.10, '下界翻倍');
  assertEqual(LEAF_FX.fallSpeed[1], 1.80, '上界翻倍');
  assertEqual(FIREFLY_FX.countDay, 56, '白天只数翻倍');
  assertEqual(FIREFLY_FX.countNight, 84, '夜里只数翻倍');
  // 容量必须跟着抬（否则 aAlive 写越界 / 夜间只数被静默钳住）
  assertTrue(FIREFLY_FX.capacity >= FIREFLY_FX.countNight,
    `容量 ${FIREFLY_FX.capacity} 装不下夜间 ${FIREFLY_FX.countNight}`);
  assertEqual(FIREFLY_FX.capacityPerformance * 2, FIREFLY_FX.capacity, '性能档仍是清晰档的一半');
});

test('ambient: 落叶提速后落地时刻减半（回收节奏跟着变快）', () => {
  // 同一出生高度下，tLand 与 fallSpeed 成反比 ⇒ 速度翻倍则落地时刻减半。
  const s = leafSeedAt({ x: 0, y: 0, z: 0 }, 8, makeRand(3));
  const tLand = leafLandSeconds(s);
  const slow = { ...s, fallSpeed: s.fallSpeed / 2 };
  assertEqual(leafLandSeconds(slow), tLand * 2);
  // 最快一片的落地时刻（birthMin / fallSpeed 上界）须仍远大于淡出时长
  assertTrue(LEAF_FX.birthMin / LEAF_FX.fallSpeed[1] > LEAF_FX.landFadeSeconds,
    '最快落地仍需看得见淡出（否则叶子一到地就硬消失）');
});

test('ambient: 性能档粒子数严格小于清晰档，且容量装得下夜间上限', () => {
  assertTrue(LEAF_FX.capacityPerformance < LEAF_FX.capacity, '落叶');
  assertTrue(FIREFLY_FX.capacityPerformance < FIREFLY_FX.capacity, '萤火虫');
  assertTrue(FIREFLY_FX.countNight <= FIREFLY_FX.capacity, '夜间只数不得越界');
  assertTrue(FIREFLY_FX.countDay < FIREFLY_FX.countNight, '夜里更密');
});

test('ambient: 落叶出生在圆内面积均匀 + 高度带内 + minY 贴地', () => {
  const rand = makeRand(7);
  const c = { x: 100, y: 0, z: -50 };
  let inner = 0;
  for (let i = 0; i < 2000; i++) {
    const s = leafSeedAt(c, 8, rand);
    const r = Math.hypot(s.x - c.x, s.z - c.z);
    assertTrue(r <= LEAF_FX.radius + 1e-9, `半径越界 ${r}`);
    if (r <= LEAF_FX.radius / 2) inner++;
    assertTrue(s.y >= 8 + LEAF_FX.birthMin - 1e-9 && s.y <= 8 + LEAF_FX.birthMax + 1e-9, `y=${s.y}`);
    assertEqual(s.minY, 8 + LEAF_FX.floorOffset);
  }
  // 面积均匀 ⇒ 内半圆占 25%（角度均匀会挤在圆心 ⇒ 约 50%）
  const share = inner / 2000;
  assertTrue(share > 0.20 && share < 0.30, `内半圆占比 ${share}`);
});

test('ambient: 萤火虫出生在贴地高度带内，三轴频率互不相同', () => {
  const rand = makeRand(11);
  for (let i = 0; i < 500; i++) {
    const s = fireflySeedAt({ x: 0, y: 0, z: 0 }, 5, rand);
    assertTrue(s.y >= 5 + FIREFLY_FX.heightMin - 1e-9 && s.y <= 5 + FIREFLY_FX.heightMax + 1e-9, `y=${s.y}`);
    assertTrue(s.freqX !== s.freqY && s.freqY !== s.freqZ && s.freqX !== s.freqZ, '三轴同频会读作绕圈');
    assertTrue(s.driftX !== 0 || s.driftZ !== 0, '要有慢漂移');
  }
});

test('ambient: 秋色抽签按权重分箱，σ 越界不静默落回第一项', () => {
  assertEqual(pickAutumnLeaf(0), 'yellow_leaves');
  assertEqual(pickAutumnLeaf(0.64), 'yellow_leaves');
  assertEqual(pickAutumnLeaf(0.65), 'giant_banyan_leaves');
  assertEqual(pickAutumnLeaf(0.999), 'giant_spruce_leaves');
  let threw = false;
  try { pickAutumnLeaf(1.5); } catch { threw = true; }
  assertTrue(threw, 'σ 越界须抛错（静默回落会放大第一项占比）');
});

test('ambient: 落叶 y 单调不增且不低于 minY；落地后 x/z/rot 全部冻结', () => {
  const s = leafSeedAt({ x: 0, y: 0, z: 0 }, 8, makeRand(3));
  const tLand = leafLandSeconds(s);
  assertTrue(tLand > 0, '落地时刻须为正');
  let prevY = Infinity;
  for (let t = 0; t <= tLand + 2; t += 0.1) {
    const m = { ...leafMotionAt(s, t) };
    assertTrue(m.y <= prevY + 1e-9, `y 上升了 t=${t}`);
    assertTrue(m.y >= s.minY - 1e-9, `y 穿地 t=${t}`);
    prevY = m.y;
  }
  const a = { ...leafMotionAt(s, tLand + 0.05) };
  const b = { ...leafMotionAt(s, tLand + 1.20) };
  assertEqual(a.x, b.x); assertEqual(a.z, b.z);
  assertEqual(a.rotX, b.rotX); assertEqual(a.rotY, b.rotY); assertEqual(a.rotZ, b.rotZ);
  assertTrue(a.alpha > b.alpha, '落地后须淡出');
  assertTrue(leafMotionAt(s, tLand + LEAF_FX.landFadeSeconds + 0.01).alpha <= 1e-9, '淡出到 0');
});

test('ambient: 萤火虫 y 无长期漂移（不飘上天也不钻地）', () => {
  const s = fireflySeedAt({ x: 0, y: 0, z: 0 }, 5, makeRand(5));
  let sum = 0; let n = 0; let minY = Infinity;
  for (let t = 0; t < 120; t += 0.05) {
    const m = fireflyMotionAt(s, t);
    sum += m.y; n++; minY = Math.min(minY, m.y);
  }
  assertTrue(Math.abs(sum / n - s.y) < 0.05, `y 均值漂移 ${sum / n - s.y}`);
  assertTrue(minY >= 5 + FIREFLY_FX.floorClearance - 1e-9, `钻地 minY=${minY}`);
});

test('ambient: 夜间 gain/count 单调不减，两端等于常量表', () => {
  const d = fireflyNightAt(0); const n = fireflyNightAt(1);
  assertEqual(d.gain, FIREFLY_FX.gainDay); assertEqual(n.gain, FIREFLY_FX.gainNight);
  assertEqual(d.count, FIREFLY_FX.countDay); assertEqual(n.count, FIREFLY_FX.countNight);
  let pg = -1; let pc = -1;
  for (let nb = 0; nb <= 1.0001; nb += 0.05) {
    const r = fireflyNightAt(nb);
    assertTrue(r.gain >= pg - 1e-9 && r.count >= pc, '须单调不减');
    assertTrue(r.count <= FIREFLY_FX.capacity, 'count 不得越界');
    pg = r.gain; pc = r.count;
  }
});

test('ambient: 档位 → 粒子数（非法档位回落清晰档）', () => {
  assertEqual(ambientParticleCount('sharp', 'leaf'), LEAF_FX.capacity);
  assertEqual(ambientParticleCount('performance', 'leaf'), LEAF_FX.capacityPerformance);
  assertEqual(ambientParticleCount('performance', 'firefly'), FIREFLY_FX.capacityPerformance);
  assertEqual(ambientParticleCount('bogus', 'leaf'), LEAF_FX.capacity);
});

// ==================== 落叶材质与几何 ====================

test('leaf 几何: 八个属性齐全、单 quad、instanceCount = 容量、包围球够大', () => {
  const g = createLeafGeometry(64);
  assertEqual(g.instanceCount, 64);
  assertEqual(g.getAttribute('position').count, 4);
  assertEqual(g.getIndex().count, 6);
  for (const name of Object.values(LEAF_ATTR)) assertTrue(!!g.getAttribute(name), `缺 ${name}`);
  assertTrue(g.boundingSphere.radius >= 1000, '包围球太小会被误剔除');
  assertTrue(g.isInstancedBufferGeometry === true, '必须是 InstancedBufferGeometry');
});

test('leaf/firefly 几何: 顶点缓冲数 ≤ 8（WebGPU 硬上限，超了整池不上屏）', () => {
  // ⚠️⚠️ 本轮浏览器实测：落叶首版 position + 8 个逐实例属性 = **9 个 vertex buffer**
  // ⇒ `Vertex buffer count (9) exceeds the maximum number of vertex buffers (8)`
  // ⇒ render pipeline 创建失败、**整池零像素**，而 visible/count/属性全对（静默失效）。
  // 正解：把两个 float 合进一个 vec2（aLife = (born, alpha) / (born, life)）。
  const count = (geo) => Object.keys(geo.attributes).length;
  const leaf = createLeafGeometry(16);
  const fly = createFireflyGeometry(16);
  assertTrue(count(leaf) <= 8, `落叶顶点缓冲数 ${count(leaf)} > 8`);
  assertTrue(count(fly) <= 8, `萤火虫顶点缓冲数 ${count(fly)} > 8`);
  // 合并后的 aLife 必须是 vec2（否则装不下两个量）
  assertEqual(leaf.getAttribute(LEAF_ATTR.life).itemSize, 2);
  assertEqual(fly.getAttribute(FIREFLY_ATTR.life).itemSize, 2);
  assertEqual(fly.getAttribute(FIREFLY_ATTR.sizeAlive).itemSize, 4);
  assertEqual(fly.getAttribute(FIREFLY_ATTR.driftGround).itemSize, 3);
});

test('leaf 材质: 正常混合（不发光）、双面、不写深度、不吃雾、不投影', () => {
  const { material: m } = createLeafMaterial({});
  assertEqual(m.blending, THREE.NormalBlending);
  assertEqual(m.side, THREE.DoubleSide);
  assertEqual(m.depthWrite, false);
  assertEqual(m.depthTest, true);
  assertEqual(m.fog, false);
  assertEqual(m.castShadow, false);
});

test('leaf TSL: 顶点有 rotate 与落地钳制，且 tEff 取 min（落地后冻结）', () => {
  const { material: m } = createLeafMaterial({});
  const v = nodeCode(m.vertexNode);
  assertTrue(v.includes('rotate('), '缺自转 ⇒ 读作纸片平移');
  assertTrue(/\.min\(|min\(/.test(v), '缺 tEff=min ⇒ 落地后仍打转');
  assertTrue(/max\(/.test(v), '缺 y 钳制 ⇒ 穿地');
});

test('leaf TSL: 昼夜 uniform 是外部实例（不是自己 new 的）', () => {
  const skyDim = { value: 1 }; const shadowStrength = { value: 1 };
  const made = createLeafMaterial({ skyDim, shadowStrength });
  // 材质须持有传入的同一对象引用（红线 1：日夜变了落叶要跟着变）
  assertTrue(made.uniforms.uSkyDim === skyDim, 'uSkyDim 必须是传入实例');
  assertTrue(made.uniforms.uShadowStrength === shadowStrength, 'uShadowStrength 同理');
});

test('leaf TSL: 昼夜因子真的乘进了片元颜色（不是只传了句柄）', () => {
  const { material: m } = createLeafMaterial({});
  const c = nodeCode(m.colorNode);
  // Review Focus #4：只传句柄没接进 colorNode 的形态是「夜里落叶比草地还亮」
  assertTrue(/uSkyDim/.test(c), 'colorNode 必须引用 uSkyDim');
  assertTrue(/uShadowStrength/.test(c), 'colorNode 必须引用 uShadowStrength');
  assertTrue(/mix\(/.test(c), '两层 mix 嵌套（strength=0 时恒 1）');
});

// ==================== 落叶池 ====================

/** fake world：只实现 isSolid，并计数（零成本判据要落在「有没有查体素」上） */
function fakeWorld(groundY = 8) {
  const w = { calls: 0, isSolid(_x, y, _z) { w.calls++; return y <= groundY; } };
  return w;
}
/** 固定色 resolver（避免单测依赖 canvas） */
const fakeResolver = () => [0.2, 0.23, 0.01];

function makeLeaf(overrides = {}) {
  return new LeafFxRenderer({
    scene: new THREE.Scene(), world: fakeWorld(), seed: 12345,
    colorResolver: fakeResolver, playerPos: { x: -400, y: 9, z: -400 },
    capacity: 32, rand: makeRand(9), ...overrides,
  });
}

test('leaf 池: 构造后不可见（未 update 过 ⇒ 不提交渲染）', () => {
  const r = makeLeaf();
  assertEqual(r.mesh.visible, false);
  assertEqual(r.mesh.name, 'ambient:leaf');
  assertEqual(r.mesh.renderOrder, LEAF_FX.renderOrder);
  assertEqual(r.mesh.frustumCulled, false);
  assertEqual(r.meshes.length, 1);
  r.dispose();
});

test('leaf 池: 森林机位 update 后可见；沙漠机位不可见且零 isSolid 调用', () => {
  const forest = makeLeaf();
  forest.update({ x: -400, y: 9, z: -400 }, 0.016);
  assertEqual(forest.mesh.visible, true);
  assertTrue(forest.debugState().biome === 'FOREST', '机位须真是 FOREST');
  forest.dispose();

  const desertWorld = fakeWorld();
  const desert = makeLeaf({ world: desertWorld, playerPos: { x: 8, y: 5, z: 8 } });
  for (let i = 0; i < 60; i++) desert.update({ x: 8, y: 5, z: 8 }, 0.016);
  assertEqual(desert.mesh.visible, false);
  assertEqual(desertWorld.calls, 0, '非目标 biome 不得查体素（零成本）');
  desert.dispose();
});

test('leaf 池: 关闭态 uTime 仍推进（回到森林时 age 不跳变）', () => {
  const r = makeLeaf();
  r.setEnabled(false);
  for (let i = 0; i < 30; i++) r.update({ x: -400, y: 9, z: -400 }, 0.1);
  const t1 = r.debugState().time;
  assertTrue(t1 > 2.5, `关闭态时间须累计，实得 ${t1}`);
  assertEqual(r.mesh.visible, false);
  r.setEnabled(true);
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  assertTrue(r.debugState().time > t1, '重开后时间继续');
  r.dispose();
});

test('leaf 池: 每片叶的出生高度都在该列地面 +[3,13]（用户点名的硬约束）', () => {
  const r = makeLeaf({ capacity: 64 });
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const p = r.mesh.geometry.getAttribute(LEAF_ATTR.params);
  let checked = 0;
  for (let i = 0; i < o.count; i++) {
    const groundY = p.getX(i) - LEAF_FX.floorOffset;   // minY 反解地面
    const above = o.getY(i) - groundY;
    assertTrue(above >= LEAF_FX.birthMin - 1e-6 && above <= LEAF_FX.birthMax + 1e-6,
      `第 ${i} 片离地 ${above}`);
    checked++;
  }
  assertTrue(checked >= 64, '须真的检查了全部实例');
  r.dispose();
});

test('leaf 池: 落地后 aAlpha 递减到 0 并重新出生（不堆积、不穿地）', () => {
  const r = makeLeaf({ capacity: 16 });
  const pos = { x: -400, y: 9, z: -400 };
  r.update(pos, 0.016);
  const life = r.mesh.geometry.getAttribute(LEAF_ATTR.life);
  const born0 = life.getX(0);
  // 大步长推进到超过最慢叶的落地时刻（13/1.10 ≈ 11.8s，v3.26b 提速后）+ 淡出
  for (let i = 0; i < 300; i++) r.update(pos, 0.1);
  assertTrue(life.getX(0) > born0, '第 0 片须已重新出生（落地淡出后回收）');
  for (let i = 0; i < life.count; i++) {
    assertTrue(life.getY(i) >= 0 && life.getY(i) <= 1, `alpha 越界 ${life.getY(i)}`);
  }
  r.dispose();
});

test('leaf 池: 玩家移动超阈值触发分批迁移，每帧不超过批大小', () => {
  const r = makeLeaf({ capacity: 64 });
  r.update({ x: -400, y: 9, z: -400 }, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const x0 = o.getX(0);
  // 移动 20 格（> refreshDistance 8）；仍在森林内
  const far = { x: -380, y: 9, z: -400 };
  r.update(far, 0.05);   // 跨过 30Hz 与 5Hz 两个节流窗口
  const st = r.debugState();
  assertTrue(st.isRefreshing, '须进入迁移态');
  assertTrue(st.refreshCursor <= LEAF_FX.refreshBatchSize, `单帧迁移 ${st.refreshCursor} 片`);
  // 推进若干帧后全部迁移完，中心跟着玩家
  for (let i = 0; i < 10; i++) r.update(far, 0.05);
  assertEqual(r.debugState().isRefreshing, false);
  assertTrue(Math.abs(o.getX(0) - x0) > 1, '第 0 片的 x 须真的迁移了');
  r.dispose();
});

test('leaf 池: 走出森林再走回来不闪断（visible 恢复 / 缓冲未清 / 时间单调）', () => {
  const r = makeLeaf({ capacity: 24 });
  const forest = { x: -400, y: 9, z: -400 };
  r.update(forest, 0.016);
  const born = r.mesh.geometry.getAttribute(LEAF_ATTR.life);
  const b0 = born.getX(0);
  assertTrue(b0 > -100, '森林首帧须已播种');
  const desert = { x: 8, y: 5, z: 8 };
  let prevT = r.debugState().time;
  for (let i = 0; i < 30; i++) {
    r.update(desert, 0.1);
    const t = r.debugState().time;
    assertTrue(t > prevT, '时间须单调增');
    prevT = t;
  }
  assertEqual(r.mesh.visible, false);
  assertEqual(born.getX(0), b0, '关闭态不得清空缓冲（否则重开闪断）');
  r.update(forest, 0.016);
  assertEqual(r.mesh.visible, true, '回来那一帧就该可见');
  assertTrue(r.debugState().time > prevT);
  r.dispose();
});

test('leaf 池: 地面扫描必须取整坐标（小数坐标会读成 air）', () => {
  // ⚠️⚠️ 本轮浏览器实测：`WorldData.getBlockId` 用 `blockIndex(x - cx*16, ...)`，
  // 小数 x/z 会算出**小数数组下标** ⇒ undefined ⇒ 全读成 air ⇒ 地面扫不到
  // ⇒ 整池零像素（而 visible/count/biome 全对）。玩家坐标恒带 .5 ⇒ 必须取整。
  const w = {
    calls: 0,
    isSolid(x, y, z) {
      w.calls++;
      // 真实 WorldData 的行为：只有整数坐标才能读到方块
      if (!Number.isInteger(x) || !Number.isInteger(z)) return false;
      return y <= 8;
    },
  };
  const r = makeLeaf({ world: w, capacity: 10 });
  r.update({ x: -393.5, y: 11.000000000000034, z: -399.5 }, 0.016);
  assertEqual(r.debugState().seeded, 10, '小数玩家坐标下仍须全部播种');
  r.dispose();
});

test('leaf 池: 地面长期扫不到时播种重试必须节流（不得每帧全池重扫）', () => {
  // ⚠️⚠️ 自审抳到的热路径缺陷：`_seedAll` 对未播种成功的片**每帧全池重扫**。
  // 玩家站在世界边缘 / 流式加载未跟上时，这个状态会**永久持续** ⇒
  // 实测真实 `WorldData` 空世界下 **0.359ms/帧**（3135 次 isSolid/帧）。
  // 它不违反「非目标 biome 零成本」（那条仍绿），但在目标 biome 里永久吃帧。
  const w = { calls: 0, isSolid() { w.calls++; return false; } };   // 永远扫不到
  const r = makeLeaf({ world: w, capacity: LEAF_FX.capacity });
  const pos = { x: -400, y: 11, z: -400 };
  r.update(pos, 0.016);
  const first = w.calls;
  assertTrue(first > 0, '首帧须真的试过播种');
  // 紧接着的 10 帧（共 0.16s，远小于任何合理重试间隔）不得再全池重扫
  const before = w.calls;
  for (let k = 0; k < 10; k++) r.update(pos, 0.016);
  const perFrame = (w.calls - before) / 10;
  assertTrue(perFrame < first * 0.2,
    `重试未节流：每帧 ${perFrame.toFixed(0)} 次 isSolid（首帧 ${first}）`);
  r.dispose();
});

test('leaf 池: 扫到世界底不算地面（未加载 column 全 air），加载后须重播', () => {
  // ⚠️⚠️ 本轮浏览器实测：`WorldData.getBlockId` 对 `y < WORLD_MIN_Y` 返回 **bedrock**
  //（防穿底）⇒ 未加载 column 全 air 时，向下扫描会一直命中世界底 ⇒ 地面被解成 −32
  // ⇒ 叶子全出生在地下（实测 origin.y ≈ −20、minY = −31.98），**零像素而所有计数全对**。
  let loaded = false;
  const w = {
    calls: 0,
    isSolid(_x, y, _z) {
      w.calls++;
      if (y < -32) return true;         // 世界底兼底 bedrock（同 WorldData）
      return loaded && y <= 8;
    },
  };
  const r = makeLeaf({ world: w, capacity: 12 });
  const pos = { x: -400, y: 11, z: -400 };
  r.update(pos, 0.016);
  assertEqual(r.debugState().seeded, 0, '未加载时不得把世界底当成地面');
  loaded = true;
  // ⚠️ 播种重试有节流（seedRetryInterval）⇒ 推进到下一个重试窗口，而不是要求下一帧就好
  r.update(pos, LEAF_FX.seedRetryInterval + 0.01);
  assertEqual(r.debugState().seeded, 12, '加载后须播种全部');
  const p = r.mesh.geometry.getAttribute(LEAF_ATTR.params);
  for (let i = 0; i < p.count; i++) {
    assertTrue(p.getX(i) > 0, `第 ${i} 片的地面不得在地下（实得 ${p.getX(i)}）`);
  }
  r.dispose();
});

test('leaf 池: 地面扫描不得被玩家头顶的树冠骗到（传送落点在树冠下）', () => {
  // ⚠️⚠️ 本轮浏览器实测：`_teleportTo(-400, 45, -400)` 后，从 y=58 向下扫的第一个
  // 实心格是 **y=55 的树冠**（在玩家头顶）⇒ 地面被解成 56，第二次扫描窗口
  // [69,45] 够不到真地面 ⇒ **220 片全部跳过**（玩家看到「森林里没有落叶」）。
  // 正解：从**玩家脚下**向下扫（落叶要落在玩家站的那层地面上）。
  const w = {
    calls: 0,
    isSolid(_x, y, _z) {
      w.calls++;
      return y === 55 || y <= 8;   // y=55 是树冠，y≤8 是真地面
    },
  };
  const r = makeLeaf({ world: w, capacity: 12 });
  r.update({ x: -400, y: 45, z: -400 }, 0.016);
  assertEqual(r.debugState().seeded, 12, '树冠在头顶时仍须全部播种成功');
  const p = r.mesh.geometry.getAttribute(LEAF_ATTR.params);
  for (let i = 0; i < p.count; i++) {
    // ⚠️ Float32 属性有往返误差（9.02 → 9.020000457763672）⇒ 用容差而不是 ===
    assertTrue(Math.abs(p.getX(i) - (9 + LEAF_FX.floorOffset)) < 1e-5,
      `地面须是真地面的顶面（9）而不是树冠顶（56），实得 ${p.getX(i)}`);
  }
  r.dispose();
});

test('leaf 池: 地面暂未加载时不得把实例写成全 0，加载后须自愈', () => {
  // ⚠️⚠️ 本轮浏览器实测：`_teleportTo` 后目标 column 尚未加载 ⇒ `isSolid` 全 false
  // ⇒ 首次播种全部跳过，而 `_seeded` 已置 true ⇒ **220 片属性永远全 0**
  //（原点一堆零尺寸 quad，玩家看到「森林里没有落叶」）。
  let loaded = false;
  const w = { calls: 0, isSolid(_x, y, _z) { w.calls++; return loaded && y <= 8; } };
  const r = makeLeaf({ world: w, capacity: 16 });
  const pos = { x: -400, y: 9, z: -400 };
  r.update(pos, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const born = r.mesh.geometry.getAttribute(LEAF_ATTR.life);
  // 未加载阶段：不得把 born 写成当前时间（那会让全 0 的实例变成「已播种」）
  assertEqual(r.debugState().seeded, 0, '未找到地面时不得计入已播种');
  loaded = true;
  // ⚠️ 同上：推进到下一个重试窗口（节流是热路径保护，不是缺陷）
  r.update(pos, LEAF_FX.seedRetryInterval + 0.01);
  assertEqual(r.debugState().seeded, 16, 'column 加载后须自愈播种全部');
  for (let i = 0; i < o.count; i++) {
    assertTrue(o.getY(i) > 8, `第 ${i} 片须真的出生在地面之上（实得 ${o.getY(i)}）`);
    assertTrue(born.getX(i) > -100, `第 ${i} 片的 born 须已写入`);
  }
  r.dispose();
});

test('leaf 池: 非法输入不污染缓冲（playerPos / dt）', () => {
  const r = makeLeaf({ capacity: 16 });
  const pos = { x: -400, y: 9, z: -400 };
  r.update(pos, 0.016);
  const o = r.mesh.geometry.getAttribute(LEAF_ATTR.origin);
  const visible0 = r.mesh.visible;
  r.update(null, 0.016);
  r.update({ x: NaN, y: 9, z: -400 }, 0.016);
  r.update(pos, NaN);
  assertEqual(r.mesh.visible, visible0);
  for (let i = 0; i < o.count; i++) {
    assertTrue(Number.isFinite(o.getX(i)) && Number.isFinite(o.getY(i)) && Number.isFinite(o.getZ(i)),
      `第 ${i} 片属性被污染`);
  }
  r.dispose();
});

test('leaf 池: colorResolver 缺失时构造不抛错（渲染层容错，装配层负责不装配）', () => {
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  let r = null;
  try {
    r = makeLeaf({ colorResolver: null, capacity: 8 });
    r.update({ x: -400, y: 9, z: -400 }, 0.016);
  } finally {
    console.warn = warn;
  }
  assertTrue(r !== null, '构造不得抛错');
  assertEqual(r.mesh.visible, true);
  assertTrue(warned >= 1, '需告警一次（不得静默兼底）');
  const c = r.mesh.geometry.getAttribute(LEAF_ATTR.color);
  assertTrue(Number.isFinite(c.getX(0)), '兼底色须有限');
  r.dispose();
});

// ==================== 萤火虫材质与几何 ====================

test('firefly 几何: 十一个属性齐全、单 quad、初始全部已死', () => {
  const g = createFireflyGeometry(24);
  assertEqual(g.instanceCount, 24);
  for (const name of Object.values(FIREFLY_ATTR)) assertTrue(!!g.getAttribute(name), `缺 ${name}`);
  const life = g.getAttribute(FIREFLY_ATTR.life);
  for (let i = 0; i < 24; i++) { assertTrue(life.getX(i) < -100, '初始须已死'); assertTrue(life.getY(i) < 0.01, '初始寿命极小'); }
  assertTrue(g.boundingSphere.radius >= 1000, '包围球');
});

test('firefly 材质: additive 自发光、不写深度、不吃雾', () => {
  const { material: m } = createFireflyMaterial();
  assertEqual(m.blending, THREE.AdditiveBlending);
  assertEqual(m.depthWrite, false);
  assertEqual(m.fog, false);
  assertEqual(m.side, THREE.DoubleSide);
});

test('firefly TSL: 径向量在片元算（顶点算 length 会整片一起亮）', () => {
  const { material: m } = createFireflyMaterial();
  const v = nodeCode(m.vertexNode);
  const c = nodeCode(m.colorNode);
  assertTrue(/length\(/.test(c), '片元必须算径向距离');
  assertTrue(!/length\(\s*positionGeometry/.test(v), '顶点不得对 quad 局部坐标算 length');
  assertTrue(/pow\(/.test(c), '光晕须有幂衰减（否则是硬边圆盘）');
});

test('firefly TSL: 三轴各自用自己的频率与相位（同频会读作绕圈）', () => {
  const { material: m } = createFireflyMaterial();
  const v = nodeCode(m.vertexNode);
  // 钉表达式结构而不是字面量：三个轴分别取 freq 的 x/y/z 分量
  assertTrue(/freq\.x/.test(v) && /freq\.y/.test(v) && /freq\.z/.test(v), '三轴须各取自己的频率分量');
});

// ==================== 萤火虫池 ====================

function makeFly(overrides = {}) {
  return new FireflyFxRenderer({
    scene: new THREE.Scene(), world: fakeWorld(6), seed: 12345,
    playerPos: { x: -350, y: 6, z: -150 }, capacity: 24, rand: makeRand(13), ...overrides,
  });
}

test('firefly 池: 草地机位可见、沙漠机位不可见且零 isSolid', () => {
  const plains = makeFly();
  plains.update({ x: -350, y: 6, z: -150 }, 0.016, 0);
  assertEqual(plains.debugState().biome, 'PLAINS');
  assertEqual(plains.mesh.visible, true);
  plains.dispose();
  const w = fakeWorld();
  const desert = makeFly({ world: w, playerPos: { x: 8, y: 5, z: 8 } });
  for (let i = 0; i < 60; i++) desert.update({ x: 8, y: 5, z: 8 }, 0.016, 0);
  assertEqual(desert.mesh.visible, false);
  assertEqual(w.calls, 0);
  desert.dispose();
});

test('firefly 池: 夜里 gain 与 count 都抬升，且 aAlive 前 count 个为 1', () => {
  const r = makeFly({ capacity: FIREFLY_FX.capacity });
  const pos = { x: -350, y: 6, z: -150 };
  r.update(pos, 0.016, 0);
  const day = r.debugState();
  r.update(pos, 0.016, 1);
  const night = r.debugState();
  assertTrue(night.gain > day.gain, '夜里更亮');
  assertTrue(night.count > day.count, '夜里更密');
  const alive = r.mesh.geometry.getAttribute(FIREFLY_ATTR.sizeAlive);
  let ones = 0;
  for (let i = 0; i < alive.count; i++) if (alive.getY(i) === 1) ones++;
  assertEqual(ones, night.count);
  // 前 count 个必须是 1（不是随便散布 —— 否则密度判据与实际渲染不符）
  for (let i = 0; i < night.count; i++) assertEqual(alive.getY(i), 1);
  r.dispose();
});

test('firefly 池: 出生高度在该列地面 +[0.4,2.6]，且 aGround 记的是真实地面', () => {
  const r = makeFly({ capacity: 24 });
  r.update({ x: -350, y: 6, z: -150 }, 0.016, 0.5);
  const o = r.mesh.geometry.getAttribute(FIREFLY_ATTR.origin);
  const gr = r.mesh.geometry.getAttribute(FIREFLY_ATTR.driftGround);
  for (let i = 0; i < o.count; i++) {
    const above = o.getY(i) - gr.getZ(i);
    assertTrue(above >= FIREFLY_FX.heightMin - 1e-6 && above <= FIREFLY_FX.heightMax + 1e-6,
      `第 ${i} 只离地 ${above}`);
    assertEqual(gr.getZ(i), 7);   // fakeWorld(6) ⇒ 地面顶面 = 6+1
  }
  r.dispose();
});

test('firefly 池: 草地内移动 20 格触发分批迁移，每帧不超批大小', () => {
  const r = makeFly({ capacity: 40 });
  r.update({ x: -350, y: 6, z: -150 }, 0.016, 0);
  const o = r.mesh.geometry.getAttribute(FIREFLY_ATTR.origin);
  const x0 = o.getX(0);
  const far = { x: -330, y: 6, z: -150 };
  r.update(far, 0.05, 0);
  const st = r.debugState();
  assertTrue(st.isRefreshing, '须进入迁移态');
  assertTrue(st.refreshCursor <= FIREFLY_FX.refreshBatchSize, `单帧迁移 ${st.refreshCursor} 只`);
  for (let i = 0; i < 10; i++) r.update(far, 0.05, 0);
  assertEqual(r.debugState().isRefreshing, false);
  assertTrue(Math.abs(o.getX(0) - x0) > 1, '第 0 只的 x 须真的迁移了');
  r.dispose();
});

test('firefly 池: 地面长期扫不到时播种重试同样节流', () => {
  const w = { calls: 0, isSolid() { w.calls++; return false; } };
  const r = makeFly({ world: w, capacity: FIREFLY_FX.capacity });
  const pos = { x: -350, y: 8, z: -150 };
  r.update(pos, 0.016, 0);
  const first = w.calls;
  assertTrue(first > 0, '首帧须真的试过播种');
  const before = w.calls;
  for (let k = 0; k < 10; k++) r.update(pos, 0.016, 0);
  const perFrame = (w.calls - before) / 10;
  assertTrue(perFrame < first * 0.2,
    `重试未节流：每帧 ${perFrame.toFixed(0)} 次 isSolid（首帧 ${first}）`);
  r.dispose();
});

test('firefly 池: 非法输入不污染缓冲（playerPos / dt / nb）', () => {
  const r = makeFly({ capacity: 16 });
  const pos = { x: -350, y: 6, z: -150 };
  r.update(pos, 0.016, 0);
  const o = r.mesh.geometry.getAttribute(FIREFLY_ATTR.origin);
  const visible0 = r.mesh.visible;
  r.update(null, 0.016, 0);
  r.update(pos, NaN, 0);
  r.update(pos, 0.016, NaN);   // nb 非法按 0 处理，不得把 gain 写成 NaN
  assertEqual(r.mesh.visible, visible0);
  assertTrue(Number.isFinite(r.debugState().gain), 'gain 不得是 NaN');
  for (let i = 0; i < o.count; i++) {
    assertTrue(Number.isFinite(o.getX(i)) && Number.isFinite(o.getY(i)) && Number.isFinite(o.getZ(i)),
      `第 ${i} 只属性被污染`);
  }
  r.dispose();
});

test('firefly 池: 走出草地再走回来不闪断（visible 恢复 / 缓冲未清 / 时间单调）', () => {
  const r = makeFly({ capacity: 20 });
  const plains = { x: -350, y: 6, z: -150 };
  r.update(plains, 0.016, 0);
  const born = r.mesh.geometry.getAttribute(FIREFLY_ATTR.life);
  const b0 = born.getX(0);
  assertTrue(b0 > -100, '草地首帧须已播种');
  let prevT = r.debugState().time;
  for (let i = 0; i < 30; i++) {
    r.update({ x: 8, y: 5, z: 8 }, 0.1, 0);
    const t = r.debugState().time;
    assertTrue(t > prevT, '时间须单调增');
    prevT = t;
  }
  assertEqual(r.mesh.visible, false);
  assertEqual(born.getX(0), b0, '关闭态不得清空缓冲');
  r.update(plains, 0.016, 0);
  assertEqual(r.mesh.visible, true, '回来那一帧就该可见');
  r.dispose();
});

test('firefly 池: 性能档容量减半时只数按比例缩（不得反而比清晰档密）', () => {
  const r = makeFly({ capacity: FIREFLY_FX.capacityPerformance });
  // ⚠️ 用**白天**档量：夜间 count=countNight=capacity 两侧都被容量钳住 ⇒ 零判别力（实测过）。
  // 白天 countDay=56、性能档容量 42：按比例应得 28，而直接钳容量会得 42。
  r.update({ x: -350, y: 6, z: -150 }, 0.016, 0);
  const st = r.debugState();
  assertTrue(st.count <= FIREFLY_FX.capacityPerformance, 'count 不得越界');
  // ⚠️ 不能钉「< countDay」：性能档容量本身就小于 countDay ⇒ 直接钳容量的错写法也绿（实测过）。
  // 钉**比例关系式**：容量减半 ⇒ 只数也减半（56 × 42/84 = 28）。
  assertEqual(st.count, Math.round(FIREFLY_FX.countDay * (FIREFLY_FX.capacityPerformance / FIREFLY_FX.capacity)),
    '只数须按容量比例缩');
  const alive = r.mesh.geometry.getAttribute(FIREFLY_ATTR.sizeAlive);
  let ones = 0;
  for (let i = 0; i < alive.count; i++) if (alive.getY(i) === 1) ones++;
  assertEqual(ones, st.count);
  r.dispose();
});

// ==================== 设置三道入口与 AND 语义 ====================

test('ambient 设置: 默认开；存储与 ?ambient= 均可覆盖；旧存档缺字段自然回落', () => {
  assertEqual(DEFAULT_SETTINGS.ambientFx, true);
  assertEqual(resolveSettings(null, new URLSearchParams('')).ambientFx, true);
  assertEqual(resolveSettings({ viewDistance: 4 }, new URLSearchParams('')).ambientFx, true);
  const v = DEFAULT_SETTINGS.settingsVersion;
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: false }, new URLSearchParams('')).ambientFx, false);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: false }, new URLSearchParams('ambient=1')).ambientFx, true);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: true }, new URLSearchParams('ambient=0')).ambientFx, false);
  assertEqual(resolveSettings({ settingsVersion: v, ambientFx: 'yes' }, new URLSearchParams('')).ambientFx, true);
});

test('雾色恒开: 存储里的 false 不再被采信，但 ?fog=0 仍是隔离入口', () => {
  const v = DEFAULT_SETTINGS.settingsVersion;
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('')).fogColor, true,
    '玩家侧已无雾色开关 ⇒ 存储值不可信');
  assertEqual(resolveSettings({ settingsVersion: v, fogColor: false }, new URLSearchParams('fog=0')).fogColor, false,
    '?fog=0 必须仍能关（Tier 4 隔离入口）');
  assertEqual(resolveSettings(null, new URLSearchParams('fog=0')).fogColor, false);
});

test('ambient 切档: dispose → 性能档重建 → 重喂开关 ⇒ 仍可见且容量真的减了', () => {
  // Review Focus #1：粒子数是几何容量（构造期固定），重建后漏喂 enabled 的形态是
  // 「玩家点性能后落叶没了」而 draw call / 计数 / 面板高亮全对。
  const scene = new THREE.Scene();
  const forestPos = { x: -400, y: 9, z: -400 };
  const plainsPos = { x: -350, y: 6, z: -150 };
  let leaf = new LeafFxRenderer({
    scene, world: fakeWorld(), seed: 12345, colorResolver: fakeResolver,
    playerPos: forestPos, capacity: LEAF_FX.capacity, rand: makeRand(21),
  });
  let fly = new FireflyFxRenderer({
    scene, world: fakeWorld(6), seed: 12345,
    playerPos: plainsPos, capacity: FIREFLY_FX.capacity, rand: makeRand(22),
  });
  leaf.update(forestPos, 0.016);
  fly.update(plainsPos, 0.016, 0);
  assertEqual(leaf.mesh.visible, true);
  assertEqual(fly.mesh.visible, true);

  // 模拟 Game#_rebuildAmbientFx 的顺序
  const resolver = leaf.colorResolver;
  assertTrue(typeof resolver === 'function', '重建靠池自己持有的 resolver（不另存一份）');
  leaf.dispose();
  fly.dispose();
  leaf = new LeafFxRenderer({
    scene, world: fakeWorld(), seed: 12345, colorResolver: resolver,
    playerPos: forestPos, capacity: LEAF_FX.capacityPerformance, rand: makeRand(21),
  });
  fly = new FireflyFxRenderer({
    scene, world: fakeWorld(6), seed: 12345,
    playerPos: plainsPos, capacity: FIREFLY_FX.capacityPerformance, rand: makeRand(22),
  });
  leaf.setEnabled(true);
  fly.setEnabled(true);
  leaf.update(forestPos, 0.016);
  fly.update(plainsPos, 0.016, 0);
  assertEqual(leaf.mesh.visible, true, '切档后落叶不得消失');
  assertEqual(fly.mesh.visible, true, '切档后萤火虫不得消失');
  assertEqual(leaf.mesh.geometry.instanceCount, LEAF_FX.capacityPerformance);
  assertEqual(fly.mesh.geometry.instanceCount, FIREFLY_FX.capacityPerformance);
  leaf.dispose();
  fly.dispose();
});

test('ambient AND 语义: 玩家意图 × 代码隔离，只有两者都开才画', () => {
  // Review Focus #5：写成 OR 会让 ?ambient=0 的 spec 隔离失效（而面板高亮看着正常）。
  const scene = new THREE.Scene();
  const forestPos = { x: -400, y: 9, z: -400 };
  const plainsPos = { x: -350, y: 6, z: -150 };
  for (const [wanted, option] of [[true, true], [true, false], [false, true], [false, false]]) {
    const leaf = new LeafFxRenderer({
      scene, world: fakeWorld(), seed: 12345, colorResolver: fakeResolver,
      playerPos: forestPos, capacity: 8, rand: makeRand(31),
    });
    const fly = new FireflyFxRenderer({
      scene, world: fakeWorld(6), seed: 12345, playerPos: plainsPos, capacity: 8, rand: makeRand(32),
    });
    const eff = wanted && option;   // 同 Game#setAmbientFxEnabled
    leaf.setEnabled(eff);
    fly.setEnabled(eff);
    leaf.update(forestPos, 0.016);
    fly.update(plainsPos, 0.016, 0);
    assertEqual(leaf.mesh.visible, eff, `leaf wanted=${wanted} option=${option}`);
    assertEqual(fly.mesh.visible, eff, `fly wanted=${wanted} option=${option}`);
    leaf.dispose();
    fly.dispose();
  }
});