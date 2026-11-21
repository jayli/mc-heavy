// src/tests/test-flame-sigil.js — 焰魔地面火焰法阵（Tier 1：纯函数与池化）
//
// 覆盖「改坏了肉眼看不出来」的部分：四段间距与朝向、原版截断延迟序列、
// 延迟期不可见（原版 `isSee`）、旋转速率、**基准几何边长**与零活跃 visible。
//
// ⚠️ **基准几何边长必须是 2**：原版 `RendererFlame_Strike` 的 quad 顶点是 `(±1, 0, ±1)`
// ⇒ 基准 2×2，再 `scale(radius=2.0)` ⇒ 实际 **4×4 格**。写成 `PlaneGeometry(1,1)` 会得到
// 2×2 —— **尺寸差一倍，而所有计数类断言仍全绿**（只有像素占比能看出）。故本文件直接钉
// `geometry.parameters.width/height`。
//
// ⚠️ GPU 侧（additive 叠加结果、贴地不闪）证明不了 → 由 `tests/ignis-fx.spec.mjs` 的
// Tier 4 像素实测兜住（金黄判据 `r > g && r − b > 100`，带沙漠沙对照组）。
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertDeepEqual, assertNull, assertNotNull, AssertionError,
} from './assert.js';
import * as THREE from 'three';
import { Game } from '../core/game.js';
import {
  FLAME_SIGIL, sigilSpawnPoints, sigilDelayMs, sigilRotationRad, sigilOpacityAt,
  FlameSigilRenderer,
} from '../render/flame-sigil.js';
import { IGNIS_AOE, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';

/** 浮点比较（经 sin/cos 后无法精确等于字面量）。同 `test-zombies.js` 的同名局部工具。 */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

/** 构造用假纹理（只为让材质有 map；**不验 flipY** —— DataTexture 与 TextureLoader 相反） */
function fakeTexture() {
  return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
}

// ---------- 常量 ----------

test('flame sigil: 冻结常量取设计文档标定值', () => {
  assertEqual(FLAME_SIGIL.radius, 2.0);
  assertEqual(FLAME_SIGIL.lifeMs, 3000);
  assertEqual(FLAME_SIGIL.segments, 4);
  assertEqual(FLAME_SIGIL.spacing, 4.25);
  // v3.04b 用户裁定：首段就在焰魔脚底（原 firstOffset=2 ⇒ 首段 8.5 格，
  // 而玩家站定环是 4.25~5.0 格 ⇒ 圆圈全生成在玩家**身后**的地面，看不到）
  assertEqual(FLAME_SIGIL.firstOffset, 0);
  assertEqual(FLAME_SIGIL.spinDegPerSec, 20);
  assertTrue(Object.isFrozen(FLAME_SIGIL), '常量须冻结（渲染层不得改写）');
});

// ---------- 落点与朝向 ----------

test('flame sigil: 四段距离 = 4.25×l，yaw=0 时沿 −Z', () => {
  const pts = sigilSpawnPoints([10, 5, 20], 0);
  assertEqual(pts.length, 4);
  for (let l = 0; l < 4; l++) {
    const d = 4.25 * (l + FLAME_SIGIL.firstOffset);
    // yaw=0 ⇒ 正前方 = (−sin0, −cos0) = (0, −1) ⇒ 只动 z
    assertClose(pts[l].x, 10, 1e-9, `第 ${l} 段 x`);
    assertClose(pts[l].z, 20 - d, 1e-9, `第 ${l} 段 z`);
  }
  // 负向锚点：照抄原版 `cos(yaw+90°)` 会让整串偏 90°（x 变成 ±d、z 不动）⇒ 上面必 FAIL。
});

test('flame sigil: 首段就在焰魔脚底（用户 v3.04b 裁定，不是原版 8.5 格）', () => {
  const at = [10, 5, 20];
  for (const yaw of [0, 0.7, Math.PI / 2, -Math.PI, 2.3]) {
    const pts = sigilSpawnPoints(at, yaw);
    // 首段与脚底重合（水平距离 0）⇒ 玩家对打时它就在焰魔脚下，后退时也在视野内
    const d0 = Math.hypot(pts[0].x - at[0], pts[0].z - at[2]);
    assertClose(d0, 0, 1e-12, `yaw=${yaw} 首段须在脚底`);
    // 后续段依次向前推 4.25 格（递延点亮的推进感保留）
    assertClose(Math.hypot(pts[1].x - at[0], pts[1].z - at[2]), 4.25, 1e-9);
    assertClose(Math.hypot(pts[3].x - at[0], pts[3].z - at[2]), 12.75, 1e-9);
  }
  // 负向锚点：firstOffset 退回 2 ⇒ 首段 8.5 格 ⇒ 上面 d0=0 必 FAIL。
});

test('flame sigil: yaw=π/2 时正前方是 −X（本仓 yaw 口径，不是原版公式）', () => {
  const pts = sigilSpawnPoints([0, 0, 0], Math.PI / 2);
  // ⚠️ 首段在脚底（0,0）⇒ 方向判据改查**第二段**（距离 4.25）
  assertClose(pts[0].x, 0, 1e-9);
  assertClose(pts[0].z, 0, 1e-9);
  assertClose(pts[1].x, -4.25, 1e-9);
  assertClose(pts[1].z, 0, 1e-9);
  // 与 dragon-boss-agent.js:127-128 的移动方向同口径：(−sin yaw, −cos yaw)
});

test('flame sigil: 落点不带 y（渲染层不查体素，y 由调用方补）', () => {
  const pts = sigilSpawnPoints([1, 2, 3], 0.7);
  for (const p of pts) {
    assertEqual(typeof p.x, 'number');
    assertEqual(typeof p.z, 'number');
    assertEqual(typeof p.delayMs, 'number');
    assertEqual(p.y, undefined);
  }
});

// ---------- 延迟序列 ----------

test('flame sigil: 延迟取原版截断序列 floor(1.5l)×50ms，不是线性 l×75', () => {
  // 原版 `int j2 = (int)(1.5F * l)` ⇒ tick 0,1,3,4 ⇒ ms 0,50,150,200
  // ⚠️ 数组用 assertDeepEqual：`assertEqual` 是 `===`（引用相等），对数组恒假。
  assertDeepEqual([0, 1, 2, 3].map(sigilDelayMs), [0, 50, 150, 200]);
  // 负向锚点：写成 l*75 会得 [0,75,150,225] ⇒ FAIL
  assertEqual(sigilDelayMs(1), 50);
  assertEqual(sigilDelayMs(3), 200);
});

test('flame sigil: 落点自带各自的 delayMs', () => {
  const pts = sigilSpawnPoints([0, 0, 0], 0);
  assertDeepEqual(pts.map((p) => p.delayMs), [0, 50, 150, 200]);
});

// ---------- 可见性与淡出 ----------

test('flame sigil: 延迟期内不可见（原版 isSee 为假时不画）', () => {
  const before = sigilOpacityAt(100, 150);
  assertFalse(before.visible);
  assertEqual(before.opacity, 0);
  assertFalse(before.done);
});

test('flame sigil: 延迟一到立刻满亮', () => {
  const at = sigilOpacityAt(150, 150);
  assertTrue(at.visible);
  assertEqual(at.opacity, 1);
  assertFalse(at.done);
});

test('flame sigil: 寿命末 done，且不再可见', () => {
  const end = sigilOpacityAt(3000 + 150, 150);
  assertTrue(end.done);
  assertFalse(end.visible);
  assertEqual(end.opacity, 0);
});

test('flame sigil: 末段淡出单调下降（不是一到寿命就突然消失）', () => {
  // 末 25% 线性淡出：t=0.8 → 0.8，t=0.9 → 0.4
  const a = sigilOpacityAt(3000 * 0.8, 0);
  const b = sigilOpacityAt(3000 * 0.9, 0);
  assertTrue(a.visible && b.visible);
  assertTrue(b.opacity < a.opacity, `淡出须下降：${a.opacity} → ${b.opacity}`);
  assertTrue(b.opacity > 0, '淡出中途不得已经归零（否则观感是提前消失）');
});

// ---------- 旋转 ----------

test('flame sigil: 旋转 20°/s 且单调增', () => {
  assertTrue(sigilRotationRad(1000) > sigilRotationRad(500));
  assertClose(sigilRotationRad(1000), 20 * Math.PI / 180, 1e-9);
  assertClose(sigilRotationRad(0), 0, 1e-12);
});

// ---------- 渲染器 ----------

test('flame sigil: 基准几何边长必须是 2（⇒ scale=radius 后 4×4 格）', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  try {
    // 原版基准 quad 顶点 ±1 ⇒ 2×2。写 (1,1) 会让实际尺寸只有一半，而计数类断言全绿。
    assertEqual(r.mesh.geometry.parameters.width, 2);
    assertEqual(r.mesh.geometry.parameters.height, 2);
    assertEqual(FLAME_SIGIL.radius * r.mesh.geometry.parameters.width, 4);
  } finally {
    r.dispose();
  }
});

test('flame sigil: 零活跃 visible=false，spawn 后可见，寿命结束后回到 false', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  try {
    assertFalse(r.mesh.visible, '零活跃须不提交渲染（否则恒增 draw call）');
    assertEqual(r.activeCount, 0);
    r.spawn([{ x: 0, y: 5, z: 0, delayMs: 0 }], 1000);
    assertTrue(r.mesh.visible);
    assertEqual(r.activeCount, 1);
    r.update(1000 + 3000 + 1);
    assertFalse(r.mesh.visible, '全部结束后须回到 visible=false');
    assertEqual(r.activeCount, 0);
  } finally {
    r.dispose();
  }
});

test('flame sigil: 延迟期内的段仍占 slot 但不画（update 不提前回收）', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  try {
    r.spawn([{ x: 0, y: 5, z: 0, delayMs: 200 }], 1000);
    r.update(1000 + 100);          // 仍在延迟期
    assertEqual(r.activeCount, 1, '延迟期内不得被回收（否则那一段永远不出现）');
    r.update(1000 + 250);          // 延迟已过
    assertEqual(r.activeCount, 1);
    assertTrue(r.mesh.visible);
  } finally {
    r.dispose();
  }
});

test('flame sigil: dispose 从场景移除并释放几何/材质', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  assertEqual(scene.children.length, 1);
  r.dispose();
  assertEqual(scene.children.length, 0);
});
// ---------- 地面扫描（Review Focus #1，最终审阅补的覆盖）----------
//
// ⚠️ **为什么必须单测这一段**：`_findSigilGroundY` 的扫描窗口是 `脚底+4 → 脚底−8`，
// 而「从脚底**上方**起扫」正是为了处理**前方地形凸起**。若退回「从脚底起扫」，
// 法阵会被放进山体内部 —— 而**所有其它断言仍全绿**（段数/间距/延迟/尺寸都对）。
// 既有的 Tier 4 只断言 `spawned > 0`，抓不到这个分支。
//
// 用 `Object.create(Game.prototype)` 造壳（同 `test-tnt-chain.js` 的既有手法）：
// `_findSigilGroundY` 只碰 `this.world.isSolid`，不需要 DOM/WebGPU。

/** 造一个只实现 isSolid 的假世界 + Game 原型壳 */
function groundScanFixture(isSolid) {
  const game = Object.create(Game.prototype);
  game.world = { isSolid };
  return game;
}

test('flame sigil ground: 平地 —— 脚底那一格实心、上方空气 ⇒ 返回脚底 y', () => {
  // 地面顶面在 y=10（y<=9 实心）；焰魔脚底 y=10
  const g = groundScanFixture((_x, y, _z) => y <= 9);
  assertEqual(g._findSigilGroundY(0.5, 0.5, 10), 10);
});

test('flame sigil ground: 前方凸起 3 格 ⇒ 贴凸起顶面，不是落进山体内部', () => {
  // 该列地面顶面在 y=13（y<=12 实心），比焰魔脚底 y=10 高 3 格。
  // ⚠️ 从脚底起扫（旧写法）会在 y=10 就命中「实心且上方…」的判断链 ⇒ 落进山体。
  // 从脚底+4=14 起扫 ⇒ 第一个「实心且上方空气」是 y=12 ⇒ 返回 13。
  const g = groundScanFixture((_x, y, _z) => y <= 12);
  assertEqual(g._findSigilGroundY(0.5, 0.5, 10), 13,
    '凸起地形须贴其顶面（脚底+4 起扫的意义）');
});

test('flame sigil ground: 整列实心到窗口上方（实心天花板）⇒ null（跳过该段）', () => {
  // ⚠️ 本条初版写成 `y <= 14` 并期望 null —— **那是断言描述想象中的世界**（实测报错）：
  // y=14 实心、y=15 是空气 ⇒ 从 14 起扫第一个就命中 ⇒ 正确返回 15。
  // 要造「窗口内找不到可站面」必须让**上方也是实心**（被埋在实心体里）。
  const g = groundScanFixture((_x, y, _z) => y <= 20);   // 窗口 14..2 全实心，上方也实心
  assertNull(g._findSigilGroundY(0.5, 0.5, 10));
});

test('flame sigil ground: 前方是坑（低 5 格）⇒ 贴坑底顶面', () => {
  // 顶面 y=5（y<=4 实心），窗口下界 10−8=2 ⇒ 扫得到
  const g = groundScanFixture((_x, y, _z) => y <= 4);
  assertEqual(g._findSigilGroundY(0.5, 0.5, 10), 5);
});

test('flame sigil ground: 坑深超过扫描下界（−9 格）⇒ null（不回落世界底）', () => {
  const g = groundScanFixture((_x, y, _z) => y <= 0);   // 顶面 y=1 < 下界 2
  assertNull(g._findSigilGroundY(0.5, 0.5, 10));
});

test('flame sigil ground: 未加载列（全 air）⇒ null，绝不返回 0 或世界底', () => {
  // WorldData.getBlockId 对未加载列恒返 0（air）⇒ isSolid 恒 false
  const g = groundScanFixture(() => false);
  const y = g._findSigilGroundY(100000.5, 100000.5, 10);
  assertNull(y, '未加载列须跳过该段（回落到 0 会在空中/地底凭空出法阵）');
});

test('flame sigil ground: 悬空平台 —— 取窗口内最高的那个可站面', () => {
  // y=12 是平台（其上方 13 空气），y<=5 是真正的地面。
  // 从 14 向下扫 ⇒ 先命中平台顶面 13（而不是地面 6）。
  const g = groundScanFixture((_x, y, _z) => y === 12 || y <= 5);
  assertEqual(g._findSigilGroundY(0.5, 0.5, 10), 13);
});

test('flame sigil ground: 小数坐标按 floor 取列（与体素口径一致）', () => {
  // 只有 x∈[3,4) 且 z∈[7,8) 这一列有地面（顶面 y=10）
  const g = groundScanFixture((x, y, z) => x === 3 && z === 7 && y <= 9);
  assertEqual(g._findSigilGroundY(3.7, 7.2, 10), 10);
  assertNull(g._findSigilGroundY(4.1, 7.2, 10), '邻列无地面 ⇒ null');
});

test('flame sigil ground: 负坐标也按 floor（不是截断）', () => {
  // floor(-0.3) = -1；若用 ~~ 或 trunc 会得 0 ⇒ 取错列
  const g = groundScanFixture((x, _y, _z) => x === -1 && _y <= 9);
  assertEqual(g._findSigilGroundY(-0.3, 0.5, 10), 10);
});

// ---------- 逐段淡出必须真的到画面（最终审阅 set-aside 项，我判定为缺陷）----------
//
// ⚠️⚠️ **共享 material.opacity 会让淡出包络在画面上失效**：4 段延迟只差 0~200ms，
// 若材质取「活跃段 opacity 的最大值」，则先淡出的段被后淡出的段拖着**一起保持满亮**，
// 直到最后一段淡完才整体消失 —— 单测里 `sigilOpacityAt` 的淡出曲线是对的，
// 但**渲染器画出来的不是它**（纯函数测试不描述画面，正是这类缺陷的温床）。
//
// 修法：additive 混合下「颜色乘 alpha」等价于调亮度 ⇒ 用 `setColorAt` 做**逐段**亮度。
// 判据落在真实 instanceColor 上（不是纯函数返回值）。

test('flame sigil: 逐段亮度独立（先淡出的段更暗，不被后段拖着满亮）', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  try {
    // 两段同刻 spawn，但延迟差 600ms ⇒ 采样时它们的淡出进度不同
    r.spawn([
      { x: 0, y: 5, z: 0, delayMs: 0 },
      { x: 8, y: 5, z: 0, delayMs: 600 },
    ], 1000);
    // 采样在 t=2800：段0 lived=2800（t=0.933 → 淡出中），段1 lived=2200（t=0.733 → 满亮）
    r.update(1000 + 2800);
    assertTrue(r.mesh.visible);
    assertNotNull(r.mesh.instanceColor, '须用逐实例颜色承载逐段亮度');
    const c0 = new THREE.Color();
    const c1 = new THREE.Color();
    r.mesh.getColorAt(0, c0);
    r.mesh.getColorAt(1, c1);
    // 段0 已进入淡出 ⇒ 更暗；段1 仍满亮
    assertTrue(c0.r < c1.r - 0.2,
      `先淡出的段须明显更暗：段0 ${c0.r.toFixed(3)} vs 段1 ${c1.r.toFixed(3)}`);
    assertTrue(c1.r > 0.99, `未到淡出的段须满亮：${c1.r}`);
    assertTrue(c0.r > 0, '淡出中途不得已归零（否则观感是提前消失）');
    // 负向锚点：退回「共享 material.opacity 取 max」⇒ 两段颜色相同 ⇒ 上面第一条必 FAIL。
  } finally {
    r.dispose();
  }
});

test('flame sigil: 满亮段的实例色是白（不整体压暗）', () => {
  const scene = new THREE.Scene();
  const r = new FlameSigilRenderer({ scene, texture: fakeTexture() });
  try {
    r.spawn([{ x: 0, y: 5, z: 0, delayMs: 0 }], 1000);
    r.update(1000 + 500);      // t=0.167 ⇒ 满亮段
    const c = new THREE.Color();
    r.mesh.getColorAt(0, c);
    assertClose(c.r, 1, 1e-6);
    assertClose(c.g, 1, 1e-6);
    assertClose(c.b, 1, 1e-6);
  } finally {
    r.dispose();
  }
});

// ==================== 装配层：法阵对玩家的 1 格伤害（v3.29）====================
//
// 用户 2026-11-21：「法阵的图案如果在玩家脚底生成，玩家也掉 1 格血」。
//
// 用 `Object.create(Game.prototype)` 造壳（同 `test-fire-ring.js` / `test-spike-fx.js` 的既有手法）：
// `_consumeIgnisFxRequests` 只碰 world / ignises / entities / fireRing / flameSigil / spikeFx / player，
// 不需要 DOM / WebGPU。

/**
 * 装配层壳：法阵伤害用例专用。
 * 玩家 AABB 宽 0.6（半宽 0.3）、高 1.8，与 `PlayerPhysics` 同口径。
 */
function sigilGameFixture({ playerPos, groundY = 10, flameSigil = true } = {}) {
  const game = Object.create(Game.prototype);
  const isSolid = (_x, y, _z) => y < groundY;
  game.world = { isSolid, getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0) };
  game.registry = { nameOf: () => 'stone' };
  const damages = [];
  game._damagePlayer = (n) => { damages.push(n); return 40 - n; };
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
  game.fireRing = { spawn: () => {} };
  game.spikeFx = { spawn: () => {} };
  // ⚠️ flameSigil: false 模拟 flame_sigil.png 加载失败（渲染器为 null 是允许的降级）
  game.flameSigil = flameSigil ? { spawn: (pts) => spawned.push(...pts) } : null;
  const state = { attackFxRequest: null };
  game.ignises = { activeEntities: () => [{ id: 'ignis:t:0', state }] };
  game.entities = { count: (t) => (t === IGNIS_TYPE ? 1 : 0) };
  return { game, state, damages, spawned };
}

test('法阵伤害: 玩家站在首段图案中心 ⇒ 扣 1 格（走 IGNIS_AOE.damage）', () => {
  // 焰魔在 (0.5, 10, 0.5)、yaw=0 ⇒ 正前方 = z 递减
  // 首段 firstOffset=0 ⇒ 落点在焰魔脚底 (0.5, 0.5)，半宽 2.0 ⇒ z ∈ [-1.5, 2.5]
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [IGNIS_AOE.damage],
    `首段压到玩家须扣 1 格，实得 ${JSON.stringify(f.damages)}`);
  assertTrue(f.spawned.length > 0, '前置：法阵确实生成了');
});

test('法阵伤害: 玩家横向偏离到足迹外 ⇒ 不扣', () => {
  // 各段的 x 恒 = 焰魔脚底 x = 0.5，半宽 2.0 ⇒ x ∈ [-1.5, 2.5]
  // 玩家 x = 6.0 ⇒ 远离所有段（沿 X 偏出去，因为沿 Z 偏会撞上第 2/3/4 段）
  const f = sigilGameFixture({ playerPos: [6.0, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [], `足迹外不得扣血，实得 ${JSON.stringify(f.damages)}`);
  assertTrue(f.spawned.length > 0, '前置：法阵仍生成了（只是玩家不在里面）');
});

test('法阵伤害: 多段同时压到玩家也只扣一次（break，不是每段各扣）', () => {
  // 段间距 4.25 / 半宽 2.0 ⇒ 相邻段边隙仅 0.25 格 < 玩家半宽 0.3
  // ⇒ 站在首段中心时，前后几段几乎必然也重叠 ⇒ 这条用例天然覆盖「多段同时命中」
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertTrue(f.spawned.length >= 4, `前置：至少 4 段法阵生成，实得 ${f.spawned.length}`);
  assertDeepEqual(f.damages, [IGNIS_AOE.damage],
    `多段重叠仍只扣一次，实得 ${JSON.stringify(f.damages)}`);
});

test('法阵伤害: 扫不到地面（未加载列）⇒ 不扣，也不生成法阵', () => {
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5], groundY: -100 });   // 全 air
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length, 0, '未加载列不生成法阵');
  assertDeepEqual(f.damages, [], '未加载列不得扣血（回落 y 会在空中判伤害）');
});

test('法阵伤害: 法阵渲染器为 null（贴图加载失败）时伤害仍然生效', () => {
  // ⚠️ 这是审稿抓到的静默失效：伤害若写在 `!this.flameSigil` 门控内，
  // flame_sigil.png 加载失败 ⇒ 观感没了、玩法伤害也静默没了，
  // 而单测用 flameSigil: null 造壳还会把它读成「不扣血 = 正常」。
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5], flameSigil: false });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.game.flameSigil, null, '前置：渲染器缺席');
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], '伤害不得挂在渲染器存在性上');
});

test('法阵伤害: 旋斩（spin）也铺法阵并扣 1 格（与举盾砸击同源）', () => {
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spin' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], 'spin 也扣 1 格');
});

test('法阵伤害: 另两招（swing / shieldSmash）不走法阵判定', () => {
  for (const kind of ['swing', 'shieldSmash']) {
    const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
    f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind };
    f.game._consumeIgnisFxRequests(1000);
    assertDeepEqual(f.damages, [], `${kind} 不得走法阵判定`);
  }
});
