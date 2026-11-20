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
  assertNotNull, assertNull,
} from './assert.js';
import * as THREE from 'three';
import { IGNIS_SPIKE, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { Game } from '../core/game.js';
import {
  SPIKE_FX, spikeSpawnPoints, spikeScaleAt, SpikeFxRenderer,
} from '../render/spike-fx.js';
import {
  SPIKE_SPARK_FX,
} from '../render/spike-fx-config.js';

/** 烘焙产物（剑体几何的输入）—— Node 快档有 file:// 垫片 */
let ignisAssetCache = null;
async function loadIgnisAssetForTest() {
  if (ignisAssetCache) return ignisAssetCache;
  const r = await fetch(new URL('../../assets/ignis/ignis.json', import.meta.url));
  ignisAssetCache = await r.json();
  return ignisAssetCache;
}

/** 1×1 白贴图（只为验「map 真的挂上了」，不验像素） */
const fakeTex = () => new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

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

test('spike fx: 30 根落点 = 五向 × 2/4/6/8/10/12 格（本仓 yaw 口径）', () => {
  const pts = spikeSpawnPoints([10, 5, 20], 0);
  assertEqual(pts.length, 30);
  // yaw=0：正前方 = (0,−1)，左侧(−90°) = (+1,0)，右侧(+90°) = (−1,0)
  // ⇒ 只有正前方那一排的 x 恒 = 10（左右两排 z 恒 = 20、x 在变）
  const front = pts.filter((p) => Math.abs(p.x - 10) < 1e-9);
  assertEqual(front.length, 6);
  assertDeepEqual(front.map((p) => +(20 - p.z).toFixed(6)), [2, 4, 6, 8, 10, 12]);
  // yaw = π/2 ⇒ 正前方 = (−1, 0) ⇒ 只动 x
  const p2 = spikeSpawnPoints([10, 5, 20], Math.PI / 2);
  const front2 = p2.filter((p) => Math.abs(p.z - 20) < 1e-9);
  assertEqual(front2.length, 6);
  assertClose(10 - front2[0].x, 2, 1e-9, 'yaw=π/2 首根 x');
});

test('spike fx: 左侧方向落在模型左手侧（RF-1，符号写反会整阵镜像）', () => {
  // ☠️ **几何锚点必须独立于 `directionsDeg`**：从那张表推导方向的判据是自证循环
  // （把表改成左右镜像后，「表里的左侧」与「表算出的方向」仍一致 ⇒ 恒绿）。
  // 模型左向量由 **three 的 yaw 旋转**独立算出（与落点公式不同源）。
  const modelLeftOf = (yaw) => {
    const v = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    return [v.x, v.z];
  };
  for (const yaw of [0, 0.7, Math.PI / 2, 2.3]) {
    const modelLeft = modelLeftOf(yaw);
    const pts = spikeSpawnPoints([0, 0, 0], yaw);
    const sideOf = (p) => {
      const r = Math.hypot(p.x, p.z);
      return (p.x / r) * modelLeft[0] + (p.z / r) * modelLeft[1];
    };
    const leftPts = pts.filter((p) => sideOf(p) > 0.99);
    const rightPts = pts.filter((p) => sideOf(p) < -0.99);
    assertEqual(leftPts.length, 6, `yaw=${yaw} 模型左手侧须恰有 6 根`);
    assertEqual(rightPts.length, 6, `yaw=${yaw} 模型右手侧须恰有 6 根`);
    // 左前 / 右前 各 6 根（与左向量点积 ≈ ±cos45°）
    const c45 = Math.SQRT1_2;
    assertEqual(pts.filter((p) => Math.abs(sideOf(p) - c45) < 1e-6).length, 6,
      `yaw=${yaw} 左前 45° 须有 6 根`);
    assertEqual(pts.filter((p) => Math.abs(sideOf(p) + c45) < 1e-6).length, 6,
      `yaw=${yaw} 右前 45° 须有 6 根`);
    // 正前方 6 根（与左向量垂直）
    assertEqual(pts.filter((p) => Math.abs(sideOf(p)) < 1e-6).length, 6,
      `yaw=${yaw} 正前方须有 6 根`);
    // 方向表的左侧项必须是 −90（实测：与模型 +X 点积 +1.00）
    assertEqual(IGNIS_SPIKE.directionsDeg[3], -90);
    assertEqual(IGNIS_SPIKE.directionsDeg[4], 90);
  }
});

test('spike fx: 首根在正前方 2 格，不在脚底；最外圈 12 格', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  const radii = pts.map((p) => Math.hypot(p.x, p.z));
  assertTrue(Math.min(...radii) >= 2 - 1e-9,
    `最近一根距脚底 ${Math.min(...radii)} 格 —— 不得长在自己脚下`);
  assertClose(Math.max(...radii), 12, 1e-9, '最外圈（v3.26 从 10 扩到 12）');
});

test('spike fx: 同一半径的 5 根同延迟（先内圈再外圈）', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0.4);
  for (let i = 0; i < 6; i++) {
    const ring = pts.filter((p) => Math.abs(Math.hypot(p.x, p.z) - 2 * (i + 1)) < 1e-6);
    assertEqual(ring.length, 5, `半径 ${2 * (i + 1)} 那一圈须有 5 根`);
    const delays = new Set(ring.map((p) => p.delayMs));
    assertEqual(delays.size, 1, `同圈延迟必须相同，实得 ${[...delays]}`);
    assertEqual([...delays][0], i * IGNIS_SPIKE.delayPerSegmentMs);
  }
  // 负向锚点：延迟若按「方向 × 6 + 半径」递增，同圈会有 5 个不同值 ⇒ 上面必红
});

test('spike fx: 延迟序列每方向 0/50/100/150/200/250ms', () => {
  const pts = spikeSpawnPoints([0, 0, 0], 0);
  const front = pts.filter((p) => Math.abs(p.x) < 1e-9 && p.z < 0);
  assertDeepEqual(front.map((p) => p.delayMs), [0, 50, 100, 150, 200, 250]);
});

test('spike fx: 30 根占 30 个互不相同的格，最近两点不穿模', () => {
  const pts = spikeSpawnPoints([0.5, 0, 0.5], 0);
  const cells = new Set(pts.map((p) => `${Math.floor(p.x)},${Math.floor(p.z)}`));
  assertEqual(cells.size, 30, '落点不得共格（共格会让两根剑叠在一起）');
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
    }
  }
  assertClose(min, 1.530734, 1e-4, '最近两点间距（实测）');
  assertTrue(min > IGNIS_SPIKE.radius * 2, '间距须大于剑面宽，否则穿模');
});

test('spike fx: 逐根 yaw 让剑宽面朝焰魔（RF-4）', () => {
  const yaw = 0.9;
  const pts = spikeSpawnPoints([0, 0, 0], yaw);
  for (const p of pts) {
    // 剑宽沿局部 X、厚沿局部 Z ⇒ 宽面法线 = 局部 ±Z
    // 实例 rotation.y = p.yaw 后，局部 +Z 的世界方向 = (sin p.yaw, cos p.yaw)
    const n = [Math.sin(p.yaw), Math.cos(p.yaw)];
    const r = Math.hypot(p.x, p.z);
    const radial = [p.x / r, p.z / r];
    const dot = n[0] * radial[0] + n[1] * radial[1];
    assertTrue(dot > 0.999, `(${p.x.toFixed(2)},${p.z.toFixed(2)}) 宽面法线 · 径向 = ${dot}，须 ≈1`);
  }
  // 负向锚点：yaw 不加 π ⇒ dot ≈ −1 ⇒ 上面必红
});

test('spike fx: 落点随 yaw 旋转等变（不是固定 −Z）', () => {
  const yaw = 0.7;
  const a = spikeSpawnPoints([3, 0, -4], 0);
  const b = spikeSpawnPoints([3, 0, -4], yaw);
  // 逐点绕 y 旋转 yaw 后必须与 b 重合（等变性，比逐根算公式更难写错）
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - 3;
    const dz = a[i].z + 4;
    const rx = dx * Math.cos(yaw) + dz * Math.sin(yaw);
    const rz = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
    assertClose(b[i].x, 3 + rx, 1e-9, `第 ${i} 根 x`);
    assertClose(b[i].z, -4 + rz, 1e-9, `第 ${i} 根 z`);
    assertClose(b[i].yaw - a[i].yaw, yaw, 1e-9, '朝向也要跟着转');
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

test('spike fx: 给了产物就走剑体几何，尺寸取剑体度量', async () => {
  const asset = await loadIgnisAssetForTest();
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset, texture: fakeTex() });
  try {
    assertEqual(r.mesh.geometry.getAttribute('position').count, 48);
    assertEqual(r.mesh.geometry.getIndex().count, 72);
    assertNotNull(r.blade, '有产物时 blade 度量不得为 null');
    assertClose(r.blade.exposeHeight, IGNIS_SPIKE.exposeHeight, 1e-6);
    assertClose(r.blade.width, 0.4375, 1e-6);
    assertClose(r.blade.halfWidth, IGNIS_SPIKE.radius, 1e-9,
      '玩法侧 radius 必须与几何半宽同源（两份会漂）');
    // RF-2：几何 y 极值 —— 剑尖 1.6、埋入 −1.055625
    const pos = r.mesh.geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    assertClose(maxY, 1.6, 1e-6, '剑尖高度');
    assertClose(minY, -1.055625, 1e-6, '埋入深度（护手不得进几何）');
  } finally {
    r.dispose();
  }
});

test('spike fx: 剑体逐实例色不得把贴图染橙（用户「贴图跟剑一模一样」）', async () => {
  const r = new SpikeFxRenderer({
    scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex(),
  });
  try {
    const pts = spikeSpawnPoints([0, 5, 0], 0).map((p) => ({ ...p, y: 5 }));
    r.spawn(pts, 1000);
    r.update(1000 + 250 + SPIKE_FX.riseMs);   // 全部升满（scale=1）
    const c = new THREE.Color();
    for (let i = 0; i < pts.length; i++) {
      r.mesh.getColorAt(i, c);
      // ☠️ three 的 setupDiffuseColor 把 instanceColor **乘到 colorNode（含 map）**
      //（`three.webgpu.js:21619`）⇒ 写火焰橙 (1.0,0.45,0.12) 会把剑贴图染成橙色，
      // 违背用户「剑体贴图就跟焰魔手里拿着的剑一模一样」。满尺寸时必须是白。
      assertClose(c.r, 1, 1e-5, `第 ${i} 根 instanceColor.r`);
      assertClose(c.g, 1, 1e-5, `第 ${i} 根 instanceColor.g`);
      assertClose(c.b, 1, 1e-5, `第 ${i} 根 instanceColor.b`);
    }
    // 淡出仍要生效（缩回段亮度递减）—— 不能为了“不染橙”直接把淡出关掉
    const shrinkMid = SPIKE_FX.lifeMs * SPIKE_FX.shrinkFrom
      + (SPIKE_FX.lifeMs - SPIKE_FX.lifeMs * SPIKE_FX.shrinkFrom) * 0.5;
    r.update(1000 + shrinkMid);
    r.mesh.getColorAt(0, c);
    assertTrue(c.r < 0.95 && c.r > 0.05,
      `缩回中段须真的淡出（实得 r=${c.r}）—— 淡出不得被一并关掉`);
    assertClose(c.g, c.r, 1e-5, '淡出必须是**中性灰**（三通道等比）而不是只压 g/b');
    assertClose(c.b, c.r, 1e-5);
  } finally {
    r.dispose();
  }
});

test('spike fx: 无产物时退回锥体且不抛错，阵列不回落（§6.2）', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene(), asset: null, texture: null });
  try {
    assertNull(r.blade, '无产物时 blade 度量须为 null（可分辨「形状退化」与「招式消失」）');
    assertEqual(r.mesh.geometry.type, 'ConeGeometry');
    // 阵列仍是 30 根（落点是玩法常量，与产物无关）
    r.spawn(spikeSpawnPoints([0, 5, 0], 0).map((p) => ({ ...p, y: 5 })), 1000);
    r.update(1000 + SPIKE_FX.riseMs);
    assertEqual(r.activeCount, 30);
    assertTrue(r.mesh.visible);
  } finally {
    r.dispose();
  }
});

test('spike fx: 剑体是正常混合 + 原色贴图 + 不写深度', async () => {
  const r = new SpikeFxRenderer({
    scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex(),
  });
  try {
    assertEqual(r.mesh.material.blending, THREE.NormalBlending,
      'additive 在亮天空前必然钳白，金纹出不来（v3.24 实测）');
    assertNotNull(r.mesh.material.map, '剑体贴图必须真的挂上（原色直采）');
    assertEqual(r.mesh.material.alphaTest, 0.5);
    assertEqual(r.mesh.material.side, THREE.DoubleSide, '0.0625 厚薄片必须双面');
    assertFalse(r.mesh.material.depthWrite);
    assertTrue(r.mesh.material.depthTest);
    assertTrue(r.mesh.material.transparent);
    assertFalse(r.mesh.material.fog, '远处不得被雾洗成天空色');
    // 基色必须白：有贴图时非白基色会把纹理乘暗（且与 instanceColor 淡出叠成平方衰减）
    const c = r.mesh.material.color;
    assertClose(c.r, 1, 1e-6, '基色 r');
    assertClose(c.g, 1, 1e-6, '基色 g');
    assertClose(c.b, 1, 1e-6, '基色 b');
  } finally {
    r.dispose();
  }
});

test('spike fx: 实例矩阵真的带朝向（RF-4，只写 position 会全部同向）', async () => {
  const r = new SpikeFxRenderer({
    scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex(),
  });
  try {
    const pts = spikeSpawnPoints([0, 5, 0], 0.9).map((p) => ({ ...p, y: 5 }));
    r.spawn(pts, 1000);
    r.update(1000 + 250 + SPIKE_FX.riseMs);   // 最后一根（延迟 250）也升满 ⇒ 全池 scale=1
    const m = new THREE.Matrix4();
    for (let i = 0; i < pts.length; i++) {
      r.mesh.getMatrixAt(i, m);
      const e = m.elements;
      // 局部 +Z 基向量（第三列）在世界的 xz 投影 = (sin yaw, cos yaw)
      const n = [e[8], e[10]];
      const len = Math.hypot(n[0], n[1]);
      assertClose(len, 1, 1e-5, `第 ${i} 根满尺寸时基向量须单位长`);
      const want = [Math.sin(pts[i].yaw), Math.cos(pts[i].yaw)];
      assertClose(n[0] / len, want[0], 1e-5, `第 ${i} 根朝向 x`);
      assertClose(n[1] / len, want[1], 1e-5, `第 ${i} 根朝向 z`);
      // 位置也要对（makeRotationY 会清位移 ⇒ 必须最后 setPosition）
      assertClose(e[12], pts[i].x, 1e-6, `第 ${i} 根位置 x`);
      assertClose(e[13], 5, 1e-6, `第 ${i} 根位置 y`);
      assertClose(e[14], pts[i].z, 1e-6, `第 ${i} 根位置 z`);
    }
    // 负向锚点：只 makeScale + setPosition（旧写法）⇒ 所有 n = (0,1) ⇒ 上面必红
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

test('spike fx: 30 根一次 spawn，逐圈延迟到点后可见数递增', () => {
  const r = new SpikeFxRenderer({ scene: new THREE.Scene() });
  try {
    const pts = spikeSpawnPoints([0, 5, 0], 0).map((p) => ({ ...p, y: 5 }));
    r.spawn(pts, 1000);
    assertEqual(r.activeCount, 30);
    const m = new THREE.Matrix4();
    /**
     * ☠️ **不能用 `|m.elements[0]| > 0` 判可见**（旧写法）：加了朝向后
     * `e[0] = cos(yaw) × scale`，而左右两排的 yaw ≈ ±90° ⇒ cos ≈ 6e-17
     * ⇒ 那 12 根**永远被判不可见**（实测 t=60 读到 6 而不是 10）。
     * 改用**行列式**：旋转不改变它，等比缩放下 det = scale³ ⇒ 旋转无关。
     */
    const countVisible = () => {
      let n = 0;
      for (let i = 0; i < pts.length; i++) {
        r.mesh.getMatrixAt(i, m);
        if (Math.abs(m.determinant()) > 1e-12) n++;
      }
      return n;
    };
    // t=1000+60：延迟 0 的那圈已破土（scale 60/180），延迟 50 的那圈刚破土（scale 10/180）
    // ⇒ 10 根可见（五向 × 2 圈）—— 可见数按**圈的整倍数**长，不是逐根
    r.update(1000 + 60);
    assertEqual(countVisible(), 10, 't=60ms 时最内两圈共 10 根可见');
    // t=1000+120：延迟 0/50/100 三圈 ⇒ 15 根
    r.update(1000 + 120);
    assertEqual(countVisible(), 15, 't=120ms 时前三圈共 15 根可见');
    // t=1000+300：全部过延迟期（最大 250）
    r.update(1000 + 300);
    assertEqual(countVisible(), 30, '全部延迟过后 30 根都可见');
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

test('spike fx 结算: 30 根都找到地面并 spawn（开阔地夹具）', () => {
  const f = spikeGameFixture({ playerPos: [0.5, 10, -40] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length, 30, `应 spawn 30 根，实得 ${f.spawned.length}`);
  for (const p of f.spawned) assertEqual(p.y, 10, '每根都贴地面顶面');
});

test('spike fx 结算: 逐根朝向透传到 spikeFx.spawn（漏了会全部同向）', () => {
  const f = spikeGameFixture({ playerPos: [0.5, 10, -40] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0.9, kind: 'spikeSlash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length, 30);
  const want = spikeSpawnPoints([0.5, 10, 0.5], 0.9);
  for (let i = 0; i < f.spawned.length; i++) {
    assertClose(f.spawned[i].yaw, want[i].yaw, 1e-9, `第 ${i} 根朝向须透传`);
  }
  // 负向锚点：装配层漏写 `yaw: p.yaw` ⇒ undefined ⇒ 上面必红
  assertTrue(new Set(f.spawned.map((p) => p.yaw)).size >= 5,
    '30 根不得全部同向（五向至少 5 个不同朝向）');
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

// ---------- v3.26：剑体原色直采（用户 2026-11-21）----------
//
// 「剑体贴图就跟焰魔手里拿着的剑一模一样……现在的圆锥体的带有纹路的尖刺模型不要了」。
//
// v3.24 的四条剑纹用例（UV 子区 / 逐根随机 / 矩形内容 / 逐实例属性）**整体退场** ——
// 不是放宽，是那套机制不存在了：剑体几何自带正确 UV（六面实测 100% 不透明），
// 原色直采就够了，不需要亮度→色阶重映射、不需要环绕铺贴随机。
// 剑体几何本身的契约在 `test-spike-blade.js`；观感由 `tests/ignis-spike.spec.mjs` 的 Tier 4 兜住。

test('spike fx: 给了贴图就走原色剑体材质，没给就退回纯色（不抛错）', async () => {
  const asset = await loadIgnisAssetForTest();
  const withTex = new SpikeFxRenderer({ scene: new THREE.Scene(), asset, texture: fakeTex() });
  try {
    assertTrue(withTex.textured, '给了贴图必须声称有纹理');
    assertNotNull(withTex.mesh.material.map, '原色直采 ⇒ map 必须挂上');
    assertEqual(withTex.mesh.material.type, 'MeshBasicMaterial',
      '剑体不再需要 TSL（UV 已正确，引入 TSL 只会把重映射问题带回来）');
  } finally { withTex.dispose(); }

  const noTex = new SpikeFxRenderer({ scene: new THREE.Scene(), asset, texture: null });
  try {
    assertFalse(noTex.textured, '没给贴图不得声称有纹理');
    assertNull(noTex.mesh.material.map);
    // ⚠️ 贴图缺失不得影响几何（几何看 asset、贴图看 texture，两者独立）
    assertNotNull(noTex.blade, '贴图缺失时剑体几何仍在');
    // 退回时也必须能正常出刺（贴图加载失败不该让尖刺整个消失）
    noTex.spawn([{ x: 0, y: 5, z: -2, delayMs: 0, yaw: 0 }], 1000);
    noTex.update(1000 + SPIKE_FX.riseMs);
    assertTrue(noTex.mesh.visible, '纯色回退路径也必须能画出来');
  } finally { noTex.dispose(); }
});

test('spike fx: 剑体必须排在海面之后绘制（水面遮挡回归，v3.24 实测）', async () => {
  const r = new SpikeFxRenderer({
    scene: new THREE.Scene(), asset: await loadIgnisAssetForTest(), texture: fakeTex(),
  });
  try {
    // ⚠️ 这是**实测标定**的耦合约定，不是预防性常数：
    // 只改海面 renderOrder 的单变量对照里，水面区域内尖刺的发光增量 p50 从 11.6（海面后画）
    // 涨到 20.5（海面先画）—— 被水色冲淡 1.77 倍。
    // 海面在 `ocean.js` 固定 renderOrder = 1 ⇒ 剑体必须 > 1。
    assertTrue(r.mesh.renderOrder > 1,
      `剑体 renderOrder=${r.mesh.renderOrder}，必须 > 1（海面是 1）`);
    assertEqual(r.mesh.renderOrder, SPIKE_SPARK_FX.renderOrder,
      '剑体与它自己的粒子池同档（两者都是焰魔尖刺的可视部分）');
    // 深度语义不得被这次改动碰坏：不写深度（否则会挡住它身后的粒子/其他特效）
    assertFalse(r.mesh.material.depthWrite, '半透明不得写深度');
    assertTrue(r.mesh.material.depthTest, '深度测试保留（否则会画到地形前面）');
  } finally { r.dispose(); }
});
