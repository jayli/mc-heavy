// src/tests/test-fire-ring.js — 焰魔扩散火圈（Tier 1：纯函数 / 池化 / 装配）
//
// 用户 2026-11-20：「把地上扬起的碎石块的特效改为扩散火圈……以焰魔为中心来散出一个
// 逐渐向外燃烧的火圈，不需要外加声音，只实现视觉特效」。两招（持盾冲撞 / 举盾砸击）都换。
//
// 覆盖「改坏了肉眼玩不出来」的部分：
//   ① **圆心在焰魔脚底**（旧碎石环心在正前方 2.75 格 —— 照抄会让火圈整体偏出去）；
//   ② **半径随时间外扩且走 outQuint**（换成 outCubic 读作「慢慢胀」，计数全绿）；
//   ③ 暖色（r > b）与「配色引 Cinder 不另写一套」的关系式；
//   ④ 池容量派生自 `IGNIS.maxAlive`、零活跃 visible=false（draw call 归零）；
//   ⑤ 火星**分批沿圆周**撒、总量不超池、出生在环带上而不是圆心；
//   ⑥ 装配层招式过滤（只有两招出火圈）+ 地面扫描失败时跳过。
//
// ⚠️ GPU 侧（TSL 在 GPU 求值）证明不了 → 由 `tests/ignis-fx.spec.mjs` 的 Tier 4
// 像素实测兜住（差分判据 + 藏掉焰魔本体 + 环缘随时间真的变大）。
import * as THREE from 'three';
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, AssertionError,
} from './assert.js';
import { IGNIS, IGNIS_AI, IGNIS_ATTACKS, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { Game } from '../core/game.js';
import { CINDER_FX } from '../render/cinder-fall-config.js';
import {
  FIRE_RING, fireRingRadiusAt, fireRingFadeAt, fireRingSparks,
} from '../render/fire-ring-config.js';
import { FireRingRenderer } from '../render/fire-ring-renderer.js';

/** assert.js 没有 assertClose（AGENTS.md 已记），本文件自带 */
function assertClose(actual, expected, eps, msg = '') {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new AssertionError(`${msg ? msg + ': ' : ''}Expected ~${expected} (±${eps}), got ${actual}`);
  }
}

/** 确定性 LCG：特效是随机的，测试必须可复现 */
function makeRand(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeRenderer(scene = new THREE.Scene()) {
  return new FireRingRenderer({ scene, rand: makeRand(7) });
}

// ==================== 常量与派生关系 ====================

test('fire ring: 常量冻结，池容量派生自 IGNIS.maxAlive（不写第二份）', () => {
  assertTrue(Object.isFrozen(FIRE_RING), '常量须冻结（渲染层不得改写）');
  assertEqual(FIRE_RING.maxActive, IGNIS.maxAlive);
  // 负向锚点：硬编码 2 在 maxAlive 改动后会静默不够用 ⇒ 上面必 FAIL。
});

test('fire ring: 配色直接引 Cinder 火焰色阶（同一事实只有一份权威）', () => {
  assertEqual(FIRE_RING.colorEdge, CINDER_FX.colorFlameEdge);
  assertEqual(FIRE_RING.colorMid, CINDER_FX.colorFlameMid);
  assertEqual(FIRE_RING.colorHot, CINDER_FX.colorHot);
  assertEqual(FIRE_RING.colorSparkA, CINDER_FX.colorSparkA);
  // 暖色身份：r > b（Storm Lance 是冷蓝白，两者不得混）
  for (const key of ['colorEdge', 'colorMid', 'colorSparkB', 'colorSparkC']) {
    const c = new THREE.Color(FIRE_RING[key]);
    assertTrue(c.r > c.b, `${key} 必须是暖色（r=${c.r} b=${c.b}）`);
  }
});

test('fire ring: 寿命短于「同一只焰魔两次火圈的最小间隔」（单环不自己叠自己）', () => {
  // 两招各自「命中帧 → 收势结束」的余量 + 招间空档下限
  for (const kind of ['shieldSmash', 'shieldBash']) {
    const a = IGNIS_ATTACKS[kind];
    const gap = (a.animSeconds - a.hitFrameSeconds) + IGNIS_AI.attackCooldownMin;
    assertTrue(FIRE_RING.lifeMs / 1000 < gap,
      `${kind}: 火圈寿命 ${FIRE_RING.lifeMs / 1000}s 必须 < 最小间隔 ${gap.toFixed(2)}s`);
  }
});

// ⚠️⚠️⚠️ **半径不得在顶点阶段算**（本轮隔离探针实测到的真缺陷，下面两条钉住）：
// `PlaneGeometry(2,2)` 只有 **4 个顶点**，四角的 `length(xz)` 恒等 ⇒ 插值后
// 整个 quad 上半径是**常数** ⇒ 根本没有圆环：整张 quad 一起亮（实心饼）
// 然后整片消失。实测：常量纯红对照 **158340** 像素，而真实材质只 **452**。

test('fire ring 几何: 4 顶点的 length(xz) 恒等 ⇒ 半径必须在片元算（缺陷前提）', () => {
  const r = makeRenderer();
  try {
    const pos = r.meshes[0].geometry.getAttribute('position');
    assertEqual(pos.count, 4, 'PlaneGeometry(2,2) 只有 4 个顶点');
    const lens = [];
    for (let i = 0; i < pos.count; i++) lens.push(Math.hypot(pos.getX(i), pos.getZ(i)));
    // 四角长度逐位相同（√2）—— 这就是「顶点算半径」必然失败的数学前提
    for (const L of lens) assertClose(L, Math.SQRT2, 1e-6, '顶点 length(xz)');
    assertClose(Math.max(...lens) - Math.min(...lens), 0, 1e-9,
      '四角长度零差异 ⇒ 线性插值后恒为常数');
  } finally {
    r.dispose();
  }
});

test('fire ring 材质: 顶点只传局部坐标 varying，半径/角度在片元算', () => {
  const r = makeRenderer();
  try {
    const mat = r.meshes[0].material;
    /**
     * 取真正的 TSL 函数体。
     * ⚠️ `vertexNode` / `colorNode` 外面包着 **VarNode**（实测），
     * 直读 `.jsFunc` 永远是 undefined ⇒ 断言会恒真/恒假。
     */
    const dig = (n, depth = 0) => {
      if (!n || depth > 6) return null;
      if (typeof n.jsFunc === 'function') return n.jsFunc;
      for (const k of ['node', 'shaderNode']) {
        if (n[k]) { const f = dig(n[k], depth + 1); if (f) return f; }
      }
      return null;
    };
    const vs = String(dig(mat.vertexNode) ?? '');
    const fs = String(dig(mat.colorNode) ?? '');
    assertTrue(vs.length > 10 && fs.length > 10, '须真的取到两个节点函数体（否则下面两条恒真）');
    assertTrue(!/length\s*\(/.test(vs),
      '顶点节点不得算 length（四顶点插值后半径恒定，圆环会退化成整片 quad）');
    assertTrue(/length\s*\(/.test(fs), '片元节点必须自己算 length（逐像素真半径）');
    // 换算成世界米数的倍率必须与 mesh.scale 同源（否则 bandWidth 不是米数）
    assertClose(r._rings[0].uniforms.uExtent.value, r.meshes[0].scale.x, 1e-9,
      'uExtent 须 = mesh.scale');
    assertClose(r._rings[0].uniforms.uExtent.value, FIRE_RING.endRadius, 1e-9);
  } finally {
    r.dispose();
  }
});

test('fire ring: 白热核必须窄（否则整条带都是近白色，读作白弧）', () => {
  // ⚠️⚠️ 本轮 CPU 复刻片元数学 + GPU 像素双重定位到的真缺陷：
  // 旧写法 heat 在带内恒达 1.0 ⇒ core=1 ⇒ **所有画出来的像素都是 colorHot
  // (255,243,208)**，橙色只存在于 alpha≈0 处。此处钉「带体不得白热」。
  assertTrue(FIRE_RING.coreSharp >= 3,
    `coreSharp=${FIRE_RING.coreSharp} 必须 ≥3（否则白热区占满整条带）`);
  // 带体中部（band=0.5）的白热权重必须很小
  const mid = Math.pow(0.5, FIRE_RING.coreSharp);
  assertTrue(mid < 0.13, `band=0.5 处白热权重 ${mid} 须 <0.13`);
  // 而波前（band=1）仍须满白热（否则火没有亮芯）
  assertClose(Math.pow(1, FIRE_RING.coreSharp), 1, 1e-12);
  // 带体往红端偏：拉开与亮草地的色相距离
  assertTrue(FIRE_RING.bodyRedBias > 0 && FIRE_RING.bodyRedBias < 1,
    'bodyRedBias 必须在 (0,1) 内');
});

test('fire ring: 噪声必须能「吃掉」环带（否则是光滑丝带，读作光环）', () => {
  // ⚠️ 写成 `band + turb` 时噪声只能加亮、不能侵蚀 ⇒ 边缘永远光滑。
  // 正解是 `band×gain − |turb|×k`，gain 必须 >1 才能让外半被吃出锯齿。
  assertTrue(FIRE_RING.bandGain > 1,
    `bandGain=${FIRE_RING.bandGain} 必须 >1（否则噪声无法侵蚀边缘）`);
  assertTrue(FIRE_RING.turbulence > 0.2, '侵蚀强度必须足以看出火舌');
  // 量化：带的外缘（band=0.3）在典型噪声下应被吃掉（eaten<0）
  const eatenOuter = 0.3 * FIRE_RING.bandGain - 0.5 * FIRE_RING.turbulence;
  assertTrue(eatenOuter < 0.35,
    `外缘 eaten=${eatenOuter.toFixed(3)} 须低于 mask 下阈附近（才会被吃掉）`);
  // 而内缘（band=1）仍须保留
  const eatenInner = 1 * FIRE_RING.bandGain - 0.5 * FIRE_RING.turbulence;
  assertTrue(eatenInner > 0.62, `内缘 eaten=${eatenInner.toFixed(3)} 须高于 mask 上阈`);
});

test('fire ring: 内圈余烬必须随半径衰减（否则整个圆盘被填成实心橙饼）', () => {
  // ⚠️⚠️ 本轮**玩家视角截图实测到的真缺陷**：只写 innerGlow 而不随半径衰减时，
  // 波前以内恒亮度 ⇒ 画面是一张实心饼而不是一圈火，而所有计数/uniform 判据全绿。
  // 此处钉住「衰减幂存在且 >1」—— 幂=1 是线性，中心区仍占总亮度的一半。
  assertTrue(FIRE_RING.innerFalloff > 1,
    `innerFalloff=${FIRE_RING.innerFalloff} 必须 >1（否则内圈填充过亮）`);
  assertTrue(FIRE_RING.innerGlow < 0.3, '余烬只是余光，不得与火舌带同量级');
  // 量化：半径一半处的余烬必须已降到峰值的 1/8 以下（幂 3 ⇒ 0.125）
  const half = Math.pow(0.5, FIRE_RING.innerFalloff);
  assertTrue(half < 0.13, `半径一半处余烬比 ${half} 须 <0.13`);
  // 负向锚点：删掉衰减（等价于幂=0）⇒ half=1 ⇒ 上面两条均 FAIL。
});

test('fire ring: 抬离地面必须 > 0（共面会被深度测试全遮掉，画面 0 像素）', () => {
  assertTrue(FIRE_RING.yLift > 0, `yLift=${FIRE_RING.yLift} 不得为 0（Cinder Fall 实测教训）`);
  assertTrue(FIRE_RING.yLift < 0.2, '抬升须远小于一格（否则读作浮空）');
});

test('fire ring: 绘制序号与闪电/Cinder 同档（水面顺序不变式）', () => {
  assertEqual(FIRE_RING.renderOrder, CINDER_FX.renderOrder);
  assertTrue(FIRE_RING.renderOrder > 2, '必须排在海面(1)与曳光(2)之后');
});

// ==================== 半径外扩曲线 ====================

test('fire ring: 半径从 startRadius 单调外扩到 endRadius', () => {
  assertClose(fireRingRadiusAt(0), FIRE_RING.startRadius, 1e-12, 't=0 半径');
  assertClose(fireRingRadiusAt(1), FIRE_RING.endRadius, 1e-12, 't=1 半径');
  let prev = -1;
  for (let k = 0; k <= 1.0001; k += 0.05) {
    const r = fireRingRadiusAt(k);
    assertTrue(r >= prev - 1e-9, `k=${k.toFixed(2)} 半径 ${r} 比前一步 ${prev} 小（不得回缩）`);
    prev = r;
  }
  // 负向锚点：写成恒定半径（旧碎石口径）⇒ 单调性仍成立但两端相等 ⇒ 上面首尾两条 FAIL。
});

test('fire ring: 扩张走 outQuint —— 前 20% 就冲掉 2/3（不是慢胀）', () => {
  const span = FIRE_RING.endRadius - FIRE_RING.startRadius;
  const ratio = (fireRingRadiusAt(0.2) - FIRE_RING.startRadius) / span;
  // outQuint(0.2)=0.67232；outCubic(0.2)=0.488 ⇒ 阈值 0.6 两侧分得开
  assertTrue(ratio > 0.6,
    `20% 寿命时进度 ${ratio.toFixed(4)} 必须 >0.6（outQuint 0.672 vs outCubic 0.488）`);
  assertClose(ratio, 1 - Math.pow(0.8, 5), 1e-9, 'outQuint 精确值');
});

test('fire ring: 越界进度被钳（不产生负半径或超出终值）', () => {
  assertClose(fireRingRadiusAt(-1), FIRE_RING.startRadius, 1e-12, 'k<0');
  assertClose(fireRingRadiusAt(2), FIRE_RING.endRadius, 1e-12, 'k>1');
});

test('fire ring: 亮度前 fadeFrom 满亮、之后单调降到 0', () => {
  assertEqual(fireRingFadeAt(0), 1);
  assertEqual(fireRingFadeAt(FIRE_RING.fadeFrom), 1);
  assertEqual(fireRingFadeAt(1), 0);
  let prev = 2;
  for (let k = FIRE_RING.fadeFrom; k <= 1.0001; k += 0.03) {
    const f = fireRingFadeAt(k);
    assertTrue(f <= prev + 1e-9, `k=${k.toFixed(2)} 亮度 ${f} 比前一步 ${prev} 大`);
    prev = f;
  }
  // 中途不得已归零（否则观感是提前消失）
  assertTrue(fireRingFadeAt((FIRE_RING.fadeFrom + 1) / 2) > 0.2, '淡出中途须仍可见');
});

// ==================== 火星出生数据 ====================

test('fire ring: 火星出生在**环带上**（±bandWidth），不是圆心', () => {
  const ring = { x: 10, y: 5, z: -3, radius: 4 };
  const pts = fireRingSparks(ring, 60, makeRand(3));
  assertEqual(pts.length, 60);
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    const r = Math.hypot(p.pos[0] - ring.x, p.pos[2] - ring.z);
    min = Math.min(min, r); max = Math.max(max, r);
    assertClose(p.pos[1], ring.y, 1e-12, '火星 y = 环所在高度');
    assertTrue(Math.abs(r - ring.radius) <= FIRE_RING.bandWidth / 2 + 1e-9,
      `到圆心距离 ${r} 须落在环带 ±${FIRE_RING.bandWidth / 2} 内`);
  }
  // 负向锚点：从圆心发射（r≈0）⇒ 上面逐点判据必 FAIL。
  assertTrue(max > ring.radius - 0.01, '须有点落在环带外沿（否则全挤在内侧）');
  assertTrue(min < ring.radius + 0.01, '须有点落在环带内沿');
});

test('fire ring: 火星绕整圆（四象限都覆盖），不是朝前的扇弧', () => {
  const pts = fireRingSparks({ x: 0, y: 0, z: 0, radius: 3 }, 120, makeRand(11));
  const quadrants = new Set();
  for (const p of pts) quadrants.add(`${p.pos[0] >= 0 ? '+' : '-'}${p.pos[2] >= 0 ? '+' : '-'}`);
  assertEqual(quadrants.size, 4, `须覆盖四象限，实得 ${[...quadrants].join(',')}`);
});

test('fire ring: 火星初速有向上分量（读作往外窜的火星，不是贴地滑行）', () => {
  const pts = fireRingSparks({ x: 0, y: 0, z: 0, radius: 3 }, 40, makeRand(5));
  for (const p of pts) {
    assertTrue(p.vel[1] > 0, `竖直分量须为正：${p.vel[1]}`);
    // 径向分量与位置同向（往外，不是往圆心吸）
    const dot = p.vel[0] * p.pos[0] + p.vel[2] * p.pos[2];
    assertTrue(dot > 0, '水平速度须朝环外');
  }
});

test('fire ring: rand 注入可复现（同 seed 逐位相同）', () => {
  const ring = { x: 1, y: 2, z: 3, radius: 5 };
  const a = fireRingSparks(ring, 20, makeRand(42));
  const b = fireRingSparks(ring, 20, makeRand(42));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < 3; j++) {
      assertEqual(a[i].pos[j], b[i].pos[j], `第 ${i} 颗 pos[${j}]`);
      assertEqual(a[i].vel[j], b[i].vel[j], `第 ${i} 颗 vel[${j}]`);
    }
  }
});

// ==================== 渲染池 ====================

test('fire ring 渲染: 构造后全部 mesh visible=false（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = makeRenderer(scene);
  try {
    for (const m of r.meshes) assertFalse(m.visible, `${m.name} 构造后必须隐藏`);
    assertEqual(r.activeCount, 0);
    assertFalse(r.active);
    r.update(1000);
    for (const m of r.meshes) assertFalse(m.visible, `${m.name} 空转后仍须隐藏`);
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 圆心 = 传入的脚底位置，且抬离地面 yLift', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: 10.5, y: 7, z: -4.5 }, 1000);
    const mesh = r.meshes[0];
    assertClose(mesh.position.x, 10.5, 1e-9, '圆心 x');
    assertClose(mesh.position.z, -4.5, 1e-9, '圆心 z');
    assertClose(mesh.position.y, 7 + FIRE_RING.yLift, 1e-9, '圆心 y = 地面 + yLift');
    // 负向锚点：照抄旧碎石的「正前方 2.75 格」⇒ x/z 必偏 ⇒ 上面 FAIL。
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 几何是贴地 XZ 平面（法线 +Y），基准边长 2', () => {  const r = makeRenderer();
  try {
    const geo = r.meshes[0].geometry;
    assertEqual(geo.parameters.width, 2);
    assertEqual(geo.parameters.height, 2);
    // rotateX(-π/2) 后法线从 +Z 转到 +Y
    const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    assertClose(n.y, 1, 1e-6, '旋转后法线须朝 +Y');
    // 真实几何法线（读 attribute，不靠上面的推导自证）
    const nAttr = geo.getAttribute('normal');
    assertClose(nAttr.getY(0), 1, 1e-6, '几何法线 y');
    assertClose(nAttr.getZ(0), 0, 1e-6, '几何法线 z（未旋转时会是 1）');
    // scale = endRadius ⇒ 局部坐标 ±1 映射到 ±endRadius（bandWidth 才是恒定米数）
    assertClose(r.meshes[0].scale.x, FIRE_RING.endRadius, 1e-9, 'mesh scale');
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 半径真的随帧推进外扩（读真实 uniform，不是纯函数自证）', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: 0, y: 5, z: 0 }, 1000);
    const r0 = r.radiusOf(0);
    r.update(1000 + FIRE_RING.lifeMs * 0.2);
    const r20 = r.radiusOf(0);
    r.update(1000 + FIRE_RING.lifeMs * 0.6);
    const r60 = r.radiusOf(0);
    assertTrue(r20 > r0 + 1, `20% 时半径须明显变大：${r0} → ${r20}`);
    assertTrue(r60 > r20, `60% 时须继续变大：${r20} → ${r60}`);
    assertClose(r20, fireRingRadiusAt(0.2), 1e-9, '与纯函数同源');
    assertTrue(r.meshes[0].visible, '活跃期必须提交渲染');
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 寿命结束回收；火星层按「最后发射 + 两个最长寿命」自然衰亡后隐藏', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: 0, y: 5, z: 0 }, 1000);
    // ⚠️ 量**真实的最后一次发射时刻**，不拿环的寿命当它：
    // 最后一批在 k≈0.833 就撒完了（比环结束早），写成「环刚结束那帧火星必亮」
    // 是**断言描述想象中的世界**（实测：那帧距最后发射已 1.1s = 恰好两个最长寿命）。
    r.update(1000 + FIRE_RING.lifeMs * 0.9);
    const lastEmitMs = r._sparkLastEmit * 1000;
    assertTrue(r.sparkMesh.visible, '刚撒完火星那帧必须亮');

    r.update(1000 + FIRE_RING.lifeMs + 1);
    assertEqual(r.activeCount, 0, '环到期须回收');
    assertFalse(r.meshes[0].visible, '环回收后不得提交');

    // 最后发射后不足两个最长寿命 ⇒ 仍在飞的不得被硬切
    r.update(lastEmitMs + FIRE_RING.sparkLifetime * 1000);
    assertTrue(r.sparkMesh.visible, '一个寿命时不得硬切（在飞的火星要自然衰亡）');
    // 超过两个最长寿命 ⇒ 隐藏（draw call 回基线）
    r.update(lastEmitMs + FIRE_RING.sparkLifetime * 2000 + 10);
    assertFalse(r.sparkMesh.visible, '两个寿命后火星层须隐藏');
    assertFalse(r.active);
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 火星总量 = sparkCount，分 sparkBatches 批（不一次性星爆）', () => {
  const r = makeRenderer();
  try {
    let total = 0;
    const batches = [];
    const orig = r._emit.bind(r);
    r._emit = (slot, radius, t, count) => { total += count; batches.push(count); return orig(slot, radius, t, count); };
    r.spawn({ x: 0, y: 5, z: 0 }, 1000);
    for (let ms = 0; ms <= FIRE_RING.lifeMs; ms += 16) r.update(1000 + ms);
    assertEqual(total, FIRE_RING.sparkCount, '总颗数须等于配置（不多不少）');
    assertEqual(batches.length, FIRE_RING.sparkBatches, `须分 ${FIRE_RING.sparkBatches} 批`);
    assertTrue(total <= FIRE_RING.sparkCapacity, '单环不得超池');
    // 负向锚点：起手一次性撒全部 ⇒ batches.length=1 ⇒ 上面 FAIL。
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 两环并发各自独立半径与种子（不互相覆写）', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: 0, y: 5, z: 0 }, 5000);
    r.spawn({ x: 9, y: 5, z: 0 }, 5400);
    assertEqual(r.activeCount, 2);
    r.update(5600);
    const a = r.radiusOf(0);
    const b = r.radiusOf(1);
    assertTrue(a > b + 0.1, `先起的环须更大：${a} vs ${b}（共享 uniform 会让两者相等）`);
    assertTrue(r._rings[0].uniforms.uSeed.value !== r._rings[1].uniforms.uSeed.value,
      '两环种子须不同（否则火舌形状一模一样）');
    // 两环火星总量仍须装进池
    assertTrue(FIRE_RING.sparkCount * IGNIS.maxAlive <= FIRE_RING.sparkCapacity,
      '两环并发火星总量须 ≤ 池容量');
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: 池满时覆盖最旧的环（不无界增长）', () => {
  const r = makeRenderer();
  try {
    for (let i = 0; i < 6; i++) r.spawn({ x: i, y: 5, z: 0 }, 1000 + i * 10);
    assertTrue(r.activeCount <= FIRE_RING.maxActive,
      `活跃 ${r.activeCount} 超过池容量 ${FIRE_RING.maxActive}`);
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: NaN 入参不入池（防污染 uniform 与实例属性）', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: NaN, y: 5, z: 0 }, 1000);
    r.spawn({ x: 0, y: 5, z: 0 }, NaN);
    r.spawn(null, 1000);
    assertEqual(r.activeCount, 0);
    r.update(NaN);
    assertEqual(r.activeCount, 0);
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: reset 清空全部并让 mesh 回到不可见', () => {
  const r = makeRenderer();
  try {
    r.spawn({ x: 0, y: 5, z: 0 }, 1000);
    r.update(1200);
    r.reset();
    assertEqual(r.activeCount, 0);
    for (const m of r.meshes) assertFalse(m.visible, `${m.name} reset 后须隐藏`);
  } finally {
    r.dispose();
  }
});

test('fire ring 渲染: dispose 从场景移除全部 mesh', () => {
  const scene = new THREE.Scene();
  const r = makeRenderer(scene);
  assertEqual(scene.children.length, FIRE_RING.maxActive + 1);
  r.dispose();
  assertEqual(scene.children.length, 0);
});

// ==================== 装配层（招式过滤 + 地面扫描）====================
//
// 用 `Object.create(Game.prototype)` 造壳（同 `test-spike-fx.js` 的既有手法）：
// `_consumeIgnisFxRequests` 只碰 world / ignises / entities / fireRing / flameSigil /
// spikeFx / player，不需要 DOM/WebGPU。

function fxGameFixture({ groundY = 10, solid = true } = {}) {
  const game = Object.create(Game.prototype);
  const isSolid = (_x, y, _z) => solid && y < groundY;
  game.world = { isSolid, getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0) };
  game.registry = { nameOf: () => 'stone' };
  game._damagePlayer = () => 20;
  game.player = { physics: { pos: { x: 0.5, y: 10, z: -20 }, overlapsBlock: () => false } };
  const rings = [];
  game.fireRing = { spawn: (at, nowMs) => rings.push({ ...at, nowMs }) };
  game.flameSigil = null;
  game.spikeFx = { spawn: () => {} };
  const state = { attackFxRequest: null };
  game.ignises = { activeEntities: () => [{ id: 'ignis:t:0', state }] };
  game.entities = { count: (t) => (t === IGNIS_TYPE ? 1 : 0) };
  return { game, state, rings };
}

test('fire ring 装配: 持盾冲撞与举盾砸击都出火圈，圆心在脚底', () => {
  for (const kind of ['shieldSmash', 'shieldBash']) {
    const f = fxGameFixture();
    f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 1.2, kind };
    f.game._consumeIgnisFxRequests(1000);
    assertEqual(f.rings.length, 1, `${kind} 须出 1 个火圈`);
    assertClose(f.rings[0].x, 3.5, 1e-9, `${kind} 圆心 x = 脚底`);
    assertClose(f.rings[0].z, -7.5, 1e-9, `${kind} 圆心 z = 脚底`);
    assertEqual(f.rings[0].y, 10, `${kind} 圆心 y = 地面顶面`);
    assertEqual(f.rings[0].nowMs, 1000, 'nowMs 须由调用方一路透传（不得内部另取）');
  }
  // 负向锚点：yaw 参与圆心计算（旧碎石口径）⇒ x/z 会随 yaw 偏 ⇒ 上面 FAIL。
});

test('fire ring 装配: 圆心不随 yaw 变（整圆各向同性）', () => {
  const seen = [];
  for (const yaw of [0, 0.9, Math.PI / 2, -2.4]) {
    const f = fxGameFixture();
    f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw, kind: 'shieldSmash' };
    f.game._consumeIgnisFxRequests(1000);
    seen.push([f.rings[0].x, f.rings[0].z]);
  }
  for (const [x, z] of seen) {
    assertClose(x, seen[0][0], 1e-12, 'x 不随 yaw 变');
    assertClose(z, seen[0][1], 1e-12, 'z 不随 yaw 变');
  }
});

test('fire ring 装配: 另三招不出火圈（招式过滤在装配层）', () => {
  for (const kind of ['swing', 'spin', 'spikeSlash']) {
    const f = fxGameFixture();
    f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 0, kind };
    f.game._consumeIgnisFxRequests(1000);
    assertEqual(f.rings.length, 0, `${kind} 不得出火圈`);
  }
});

test('fire ring 装配: 扫不到地面（未加载列）⇒ 跳过，绝不回落脚底或世界底', () => {
  const f = fxGameFixture({ solid: false });   // 全 air ⇒ isSolid 恒 false
  f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 0, kind: 'shieldSmash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.rings.length, 0, '未加载列须跳过（回落脚底会在空中凭空出火圈）');
});

test('fire ring 装配: 前方地面凸起 3 格 ⇒ 贴凸起顶面（复用 _findSigilGroundY）', () => {
  // 该列地面顶面在 y=13，焰魔脚底 y=10 ⇒ 从脚底+4 起扫得 13
  const f = fxGameFixture({ groundY: 13 });
  f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 0, kind: 'shieldSmash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.rings[0].y, 13, '须贴真实地面顶面，不是焰魔脚底高度');
});

test('fire ring 装配: 一次命中帧只出一个（瞬态请求，下一帧清 null）', () => {
  const f = fxGameFixture();
  f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 0, kind: 'shieldSmash' };
  f.game._consumeIgnisFxRequests(1000);
  f.state.attackFxRequest = null;
  for (let i = 0; i < 30; i++) f.game._consumeIgnisFxRequests(1000 + i * 16);
  assertEqual(f.rings.length, 1, '30 帧后仍只出一个');
});

test('fire ring 装配: 举盾砸击仍同时铺地面法阵（火圈是替换碎石，不是替换法阵）', () => {
  const f = fxGameFixture();
  const sigil = [];
  f.game.flameSigil = { spawn: (pts) => sigil.push(...pts) };
  f.state.attackFxRequest = { at: [3.5, 10, -7.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.rings.length, 1, '火圈');
  assertTrue(sigil.length > 0, '法阵不得被本轮改动带走');
});