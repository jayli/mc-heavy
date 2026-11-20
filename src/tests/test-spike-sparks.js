// src/tests/test-spike-sparks.js — 焰魔尖刺攻击的**破土火星 + 上浮余烬**（Tier 1）
//
// 用户 2026-11-20：「尖刺升起的时候带有粒子特效……就好像蹦出的火星一样」。
// 两项选型裁定（`ask_user_question`）：
//   ① 节奏 = **破土猛迸 + 余烬渐稀**（不是「只迸一次」也不是「全程持续」）；
//   ② 构成 = **条状火星 + 少量上浮余烬**（不加烟）。
//
// 覆盖「改坏了肉眼玩不出来」的部分：
//   · 三段速率（burst → trickle → 停）的关系式与**累计配额不超发**；
//   · 火星出生在**破土环**上而不是刺心、初速朝上朝外（不是往刺里吸）；
//   · 火星**条状拉伸 + 屏幕尺寸硬钳**两条 TSL 口径都在（缺一就退回「爆米花」）；
//   · 余烬**往上飘**（gravity 为正）—— 照抄火星的负重力会让它往下掉；
//   · 池账：一次 spawn 的总量 × 并发窗口 ≤ 容量；
//   · 零活跃 visible=false、寿命结束后自然衰亡再隐藏（不硬切）。
//
// ⚠️ GPU 侧（TSL 在 GPU 求值）证明不了 → `tests/ignis-spike.spec.mjs` 的 Tier 4
// 像素实测兜住（藏掉焰魔本体 + **藏掉尖锥本身**做单变量对照）。
import * as THREE from 'three';
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, AssertionError,
} from './assert.js';
import { IGNIS_SPIKE, IGNIS_ATTACKS } from '../entities/ignis/ignis-config.js';
import { CINDER_FX } from '../render/cinder-fall-config.js';
import { SPIKE_FX, SpikeFxRenderer } from '../render/spike-fx.js';
import {
  SPIKE_SPARK_FX as FX, spikeSparkQuotaAt, spikeSparkSeeds,
} from '../render/spike-fx-config.js';
import {
  createSpikeSparkMaterial, createSpikeEmberMaterial, createSpikeSparkGeometry,
} from '../render/spike-fx-material.js';

/** assert.js 没有 assertClose（AGENTS.md 已记），本文件自带 */
function assertClose(actual, expected, eps, msg = '') {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new AssertionError(`${msg ? msg + ': ' : ''}Expected ~${expected} (±${eps}), got ${actual}`);
  }
}

/** 确定性 LCG：粒子是随机的，测试必须可复现 */
function makeRand(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 一根位于原点的刺（`spikeSparkSeeds` 的 spike 入参形状） */
const SPIKE_AT_ORIGIN = { x: 0, y: 5, z: 0 };

function makeRenderer(scene = new THREE.Scene()) {
  return new SpikeFxRenderer({ scene, rand: makeRand(7) });
}

/** 取真正的 TSL 函数体（vertexNode/colorNode 外面包着 VarNode，直读 jsFunc 恒 undefined） */
function nodeSource(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (typeof node.jsFunc === 'function') return String(node.jsFunc);
  for (const k of ['node', 'shaderNode']) {
    if (node[k]) {
      const s = nodeSource(node[k], depth + 1);
      if (s) return s;
    }
  }
  return '';
}

/**
 * 去掉注释后的节点源码。
 *
 * ⚠️⚠️ **必需**（本轮实测踩到）：TSL 的 `Fn` 体经 `toString()` 会**带着注释**，
 * 而两个 pass 共用同一个工厂函数（`if (streak)` 分流）⇒ 源码里**两支都在**。
 * 注释里写的「不是圆形 mask」「不做速度拉伸」会让 assertFalse 恒红（假红），
 * 而 assertTrue 又恒绿（假绿）。去掉注释后两支仍在 ⇒ 源码级判据只能钉
 * 「两支线都存在」与「参数真的取自常量」，**分流正确性由像素实测守**。
 */
function nodeCode(node) {
  return nodeSource(node)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// ==================== 常量与派生关系 ====================

test('spike spark: 常量冻结，几何/节奏派生自 IGNIS_SPIKE（同一事实不得两份）', () => {
  assertTrue(Object.isFrozen(FX), '常量须冻结（渲染层不得改写）');
  assertEqual(FX.height, IGNIS_SPIKE.height);
  assertEqual(FX.radius, IGNIS_SPIKE.radius);
  assertEqual(FX.riseMs, IGNIS_SPIKE.riseMs);
  assertEqual(FX.lifeMs, IGNIS_SPIKE.lifeMs);
  assertEqual(FX.shrinkFrom, SPIKE_FX.shrinkFrom);
  // 负向锚点：在本表另写一份 height/riseMs ⇒ 上面必 FAIL（刺与火星会长在不同尺度上）
});

test('spike spark: 配色直接引 Cinder 火焰色阶（不另写一套橙）', () => {
  for (const k of ['colorSparkA', 'colorSparkB', 'colorSparkC', 'colorSparkD']) {
    assertEqual(FX[k], CINDER_FX[k], `${k} 须与 Cinder 同源`);
  }
  for (const k of ['colorEmberA', 'colorEmberB', 'colorEmberC', 'colorEmberD']) {
    assertEqual(FX[k], CINDER_FX[k], `${k} 须与 Cinder 同源`);
  }
  // 暖色身份：r > b（Storm Lance 是冷蓝白，两者不得混）
  for (const k of ['colorSparkB', 'colorSparkC', 'colorEmberB', 'colorEmberC']) {
    const c = new THREE.Color(FX[k]);
    assertTrue(c.r > c.b, `${k} 必须是暖色（r=${c.r} b=${c.b}）`);
  }
});

test('spike spark: 绘制序号与闪电/Cinder/火圈同档（水面顺序不变式）', () => {
  assertEqual(FX.renderOrder, CINDER_FX.renderOrder);
  assertTrue(FX.renderOrder > 2, '必须排在海面(1)与曳光(2)之后');
});

test('spike spark: 三段速率单调递减（破土猛迸 → 保持期渐稀 → 缩回停）', () => {
  assertTrue(FX.burstRate > FX.trickleRate,
    `破土速率 ${FX.burstRate} 必须 > 保持期 ${FX.trickleRate}（否则读不出「猛迸」）`);
  assertTrue(FX.trickleRate > 0, '保持期须仍有零星余烬（用户裁定「渐稀」不是「归零」）');
  assertTrue(FX.burstRate >= FX.trickleRate * 4,
    '两段须拉开量级（4 倍以上），否则整段读作匀速冒烟');
  // 缩回起点必须 = 尖锥开始缩零的那一刻（火星跟着刺走，不得刺没了还在喷）
  assertClose(FX.lifeMs * FX.shrinkFrom, SPIKE_FX.lifeMs * SPIKE_FX.shrinkFrom, 1e-9);
});

test('spike spark: 余烬往上飘、火星受重力下坠（两者符号相反）', () => {
  assertTrue(FX.emberRise > 0, `余烬浮力须为正（往上飘），实得 ${FX.emberRise}`);
  assertTrue(FX.sparkGravity < 0, `火星重力须为负（抛物线下坠），实得 ${FX.sparkGravity}`);
  // 负向锚点：余烬照抄火星的 −9 ⇒ 它往下掉，读作「碎屑落地」而不是「烧着往上飘」
});

test('spike spark: 火星是条状拉伸 + 屏幕尺寸硬钳（缺一就退回「爆米花」）', () => {
  assertTrue(FX.sparkStretch > 0, '拉伸系数必须 >0（否则是圆点，用户读作爆米花）');
  assertTrue(FX.sparkMaxScreen > 0 && FX.sparkMaxScreen < 0.05,
    '屏幕尺寸上限必须存在且远小于屏高（玩家可能站在刺上，粒子离相机 0.3 格）');
  assertTrue(FX.emberMaxScreen > 0 && FX.emberMaxScreen < FX.sparkMaxScreen,
    '余烬是圆点，屏幕上限须比火星更紧（否则近处糊成大光斑）');
});

test('spike spark: 余烬数量少于火星（用户裁定「少量上浮余烬」）', () => {
  const sparkTotal = spikeSparkQuotaAt(FX.lifeMs * FX.shrinkFrom, 'spark');
  const emberTotal = spikeSparkQuotaAt(FX.lifeMs * FX.shrinkFrom, 'ember');
  assertTrue(emberTotal > 0, '余烬不得为 0（那就只剩条状火星）');
  assertTrue(emberTotal < sparkTotal * 0.5,
    `余烬 ${emberTotal} 须少于火星 ${sparkTotal} 的一半`);
});

test('spike spark: 池账 —— 按**真实重叠窗口**算容量（不是拍一个数）', () => {
  // ☠️ **总根数 = count × 方向数**（v3.27）—— `IGNIS_SPIKE.count` 是**每方向**根数（6）。
  // 按 count 算的形态是「账按 6 根算而实际喷 30 根」，把容量改小也仍然绿（判别力丢失）。
  const totalSpikes = IGNIS_SPIKE.count * IGNIS_SPIKE.directionsDeg.length;
  // 同一只焰魔两刀的最小间隔 = 第二命中帧 − 第一命中帧
  const gapMs = (IGNIS_SPIKE.secondHitFrame - IGNIS_ATTACKS.spikeSlash.hitFrameSeconds) * 1000;
  // 一次 spawn 的粒子最长命 = 最后一根的延迟 + 缩回起点 + 最长余烬寿命
  // ⚠️ 延迟只跟**半径序号**挂钩（同圈 5 根同帧）⇒ 最大延迟仍是 (count−1)×50，
  // **不要乘方向数** —— 乘了会把最长命算成 1.5s+，池账虚高。
  const longestMs = (IGNIS_SPIKE.count - 1) * IGNIS_SPIKE.delayPerSegmentMs
    + FX.lifeMs * FX.shrinkFrom + FX.emberLifetime * 1.3 * 1000;
  // ☠️ 实测：最长命 2115ms **大于**两刀间隔 1225ms ⇒ 两批确实会重叠
  // ⇒ 池容量必须按「重叠批数」算，不能只算一次 spawn。
  assertTrue(longestMs > gapMs,
    '本招两批粒子确实重叠（若将来不重叠了，该简化池账而不是留着多余的容量）');
  const overlap = Math.ceil(longestMs / gapMs);
  const perCast = totalSpikes
    * (spikeSparkQuotaAt(FX.lifeMs * FX.shrinkFrom, 'spark')
      + spikeSparkQuotaAt(FX.lifeMs * FX.shrinkFrom, 'ember'));
  assertTrue(perCast * overlap <= FX.capacity,
    `重叠 ${overlap} 批 × 每批 ${perCast} 颗 = ${perCast * overlap} 须 ≤ 池容量 ${FX.capacity}`);
  // 单类也要各自装得下（两个池容量相同）
  const perCastSpark = totalSpikes * spikeSparkQuotaAt(FX.lifeMs * FX.shrinkFrom, 'spark');
  assertTrue(perCastSpark * overlap <= FX.capacity,
    `火星单独也要装得下：${perCastSpark * overlap} ≤ ${FX.capacity}`);
});

// ==================== 累计配额（唯一权威） ====================

test('spike spark: 配额单调不减，两端精确（0 与总量）', () => {
  for (const kind of ['spark', 'ember']) {
    assertEqual(spikeSparkQuotaAt(-100, kind), 0, `${kind} 破土前不得有配额`);
    assertEqual(spikeSparkQuotaAt(0, kind), 0, `${kind} t=0 配额 0`);
    const stop = FX.lifeMs * FX.shrinkFrom;
    const total = spikeSparkQuotaAt(stop, kind);
    assertTrue(total > 0, `${kind} 总量须 >0`);
    // 缩回后不再增长（火星跟着刺走）
    assertEqual(spikeSparkQuotaAt(FX.lifeMs, kind), total, `${kind} 缩回段不得再发`);
    assertEqual(spikeSparkQuotaAt(FX.lifeMs * 3, kind), total, `${kind} 寿命外不得再发`);
    let prev = -1;
    for (let t = 0; t <= FX.lifeMs; t += 7) {
      const q = spikeSparkQuotaAt(t, kind);
      assertTrue(q >= prev, `${kind} t=${t} 配额 ${q} 比前一步 ${prev} 小（累计量不得回退）`);
      prev = q;
    }
  }
});

test('spike spark: 破土段吃掉大部分配额（不是匀速撒）', () => {
  const stop = FX.lifeMs * FX.shrinkFrom;
  const atRise = spikeSparkQuotaAt(FX.riseMs, 'spark');
  const total = spikeSparkQuotaAt(stop, 'spark');
  const ratio = atRise / total;
  assertTrue(ratio > 0.5,
    `升起段（${FX.riseMs}ms / 共 ${stop}ms）须已撒出过半火星，实得 ${(ratio * 100).toFixed(1)}%`);
  // 负向锚点：写成全程匀速 ⇒ ratio ≈ riseMs/stop = 0.286 ⇒ FAIL
});

test('spike spark: 累计差值不超发（逐帧 16ms 推进的总量 == 配额终值）', () => {
  // ⚠️ 渲染器用「累计差值」而不是 ceil(perBatch)×n —— 后者在不能整除时会静默超池。
  for (const kind of ['spark', 'ember']) {
    let emitted = 0;
    let sum = 0;
    for (let t = 0; t <= FX.lifeMs; t += 16) {
      const want = spikeSparkQuotaAt(t, kind);
      sum += want - emitted;
      emitted = want;
    }
    assertEqual(sum, spikeSparkQuotaAt(FX.lifeMs, kind), `${kind} 逐帧累加须等于终值`);
  }
});

// ==================== 出生数据（纯函数，rand 注入） ====================

test('spike spark: 火星出生在破土环上（不是刺心一个点）', () => {
  const pts = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'spark', 80, makeRand(3));
  assertEqual(pts.length, 80);
  let min = Infinity;
  let max = -Infinity;
  const angles = new Set();
  for (const p of pts) {
    const dx = p.pos[0] - SPIKE_AT_ORIGIN.x;
    const dz = p.pos[2] - SPIKE_AT_ORIGIN.z;
    const r = Math.hypot(dx, dz);
    min = Math.min(min, r); max = Math.max(max, r);
    assertTrue(r <= FX.radius * FX.ringSpread + 1e-9, `到刺心距离 ${r} 须落在破土环内`);
    angles.add(`${dx >= 0 ? '+' : '-'}${dz >= 0 ? '+' : '-'}`);
  }
  assertTrue(max > FX.radius * 0.5, '须有点落在环外沿（否则全挤在刺心 = 定点星爆）');
  assertTrue(min < FX.radius * 0.9, '须有点落在环内沿');
  assertEqual(angles.size, 4, `须绕整圈四象限，实得 ${[...angles].join(',')}`);
});

test('spike spark: 出生高度贴着地面（升起进度 0 时在脚底，不是半空中）', () => {
  const at = { x: 2, y: 7, z: -3 };
  const ground = spikeSparkSeeds(at, 0, 'spark', 40, makeRand(5));
  for (const p of ground) {
    assertTrue(p.pos[1] >= at.y - 1e-9, '不得低于地面（那会埋在土里）');
    assertTrue(p.pos[1] <= at.y + FX.height * 0.25,
      `进度 0 时出生高度 ${p.pos[1]} 须贴地（刺还没长出来）`);
  }
  // 升起过半后出生点跟着锥面上移（读作「火星从正在长出的刺上迸出」）
  const mid = spikeSparkSeeds(at, 0.6, 'spark', 40, makeRand(5));
  const meanGround = ground.reduce((a, p) => a + p.pos[1], 0) / ground.length;
  const meanMid = mid.reduce((a, p) => a + p.pos[1], 0) / mid.length;
  assertTrue(meanMid > meanGround + FX.height * 0.2,
    `进度 0.6 的出生高度 ${meanMid.toFixed(3)} 须明显高于进度 0 的 ${meanGround.toFixed(3)}`);
});

test('spike spark: 火星初速朝上朝外（不是往刺里吸、也不是贴地滑行）', () => {
  const pts = spikeSparkSeeds({ x: 0, y: 0, z: 0 }, 0, 'spark', 60, makeRand(11));
  let up = 0;
  for (const p of pts) {
    assertTrue(p.vel[1] > 0, `竖直分量须为正：${p.vel[1]}`);
    const dot = p.vel[0] * p.pos[0] + p.vel[2] * p.pos[2];
    assertTrue(dot > 0, '水平速度须朝环外（往刺里吸会读作吸入粒子）');
    if (p.vel[1] > Math.hypot(p.vel[0], p.vel[2])) up++;
  }
  assertTrue(up > pts.length * 0.5, '多数火星须以向上为主（读作破土迸射）');
});

test('spike spark: 余烬比火星慢、比火星活得久（分工不同）', () => {
  const sp = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'spark', 40, makeRand(9));
  const em = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'ember', 40, makeRand(9));
  const speed = (arr) => arr.reduce((a, p) => a + Math.hypot(...p.vel), 0) / arr.length;
  const life = (arr) => arr.reduce((a, p) => a + p.life, 0) / arr.length;
  assertTrue(speed(em) < speed(sp) * 0.7,
    `余烬均速 ${speed(em).toFixed(2)} 须明显慢于火星 ${speed(sp).toFixed(2)}`);
  assertTrue(life(em) > life(sp) * 1.3,
    `余烬均寿 ${life(em).toFixed(2)} 须明显长于火星 ${life(sp).toFixed(2)}（慢慢飘）`);
  for (const p of em) assertTrue(p.vel[1] > 0, '余烬竖直分量须为正');
});

test('spike spark: rand 注入可复现（同 seed 逐位相同）', () => {
  const a = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0.3, 'spark', 20, makeRand(42));
  const b = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0.3, 'spark', 20, makeRand(42));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < 3; j++) {
      assertEqual(a[i].pos[j], b[i].pos[j], `第 ${i} 颗 pos[${j}]`);
      assertEqual(a[i].vel[j], b[i].vel[j], `第 ${i} 颗 vel[${j}]`);
    }
    assertEqual(a[i].life, b[i].life);
    assertEqual(a[i].size, b[i].size);
  }
});

test('spike spark: 颗数 0 / 负数返回空数组（不产生 NaN 粒子）', () => {
  assertEqual(spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'spark', 0, makeRand(1)).length, 0);
  assertEqual(spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'ember', -5, makeRand(1)).length, 0);
});

// ==================== 几何 ====================

test('spike spark 几何: 六个出生属性齐全、初始全部已死', () => {
  const g = createSpikeSparkGeometry(32);
  try {
    assertEqual(g.instanceCount, 32);
    for (const name of ['aOrigin', 'aVel', 'aSpawn', 'aLife', 'aSize', 'aSeed']) {
      const attr = g.getAttribute(name);
      assertTrue(!!attr, `缺属性 ${name}`);
      assertEqual(attr.count, 32, `${name} 长度`);
      assertTrue(attr.isInstancedBufferAttribute === true, `${name} 必须是 instanced 属性`);
    }
    // ⚠️ aVel 是 STREAK 拉伸的输入：只写位置不写速度会让全部火星退化成圆点
    assertEqual(g.getAttribute('aVel').itemSize, 3);
    const spawn = g.getAttribute('aSpawn');
    const life = g.getAttribute('aLife');
    for (let i = 0; i < 32; i++) {
      assertTrue(spawn.getX(i) < -100, `slot ${i} 初始须已死（aSpawn 远在过去）`);
      assertTrue(life.getX(i) > 0 && life.getX(i) < 0.01, `slot ${i} 初始寿命须极小`);
    }
    // 包围球取大值：几何在单位立方内而实际被 shader 摆到几十格外
    assertTrue(g.boundingSphere.radius > 100, '包围球须足够大（否则被误剔除）');
  } finally {
    g.dispose();
  }
});

// ==================== 材质（TSL 口径） ====================

test('spike spark 材质: 火星沿速度拉伸 + 条状轮廓（两者缺一都退回圆点）', () => {
  const { spark, uniforms } = createSpikeSparkMaterial();
  try {
    const vs = nodeCode(spark.vertexNode);
    const fs = nodeCode(spark.colorNode);
    assertTrue(vs.length > 20 && fs.length > 20, '须真的取到两个节点函数体（否则下面恒真）');
    assertTrue(/aVel/.test(vs), '顶点必须读 aVel（拉伸的输入）');
    /**
     * ⚠️⚠️ **必须钉「stretch 真的随速度变」，不能只钉「有个叫 stretch 的东西」**
     *（本轮负向验证实测：把 `stretch` 改成常量 1 后，`/stretch/i` 仍全绿）。
     * 同理不能钉字面量 `0.18`：它在同一个函数里又被 jitter 项用到（假绿）。
     * 正解：钉**表达式结构** —— stretch 必须是 `1 + k·|velNow|`。
     */
    assertTrue(/stretch\s*=\s*float\(1\)\.add\(/.test(vs),
      'stretch 必须是「1 + 速度项」（写成常量 1 = 退回圆点，用户读作爆米花）');
    assertTrue(/length\(velNow\)/.test(vs),
      '拉伸量必须取**当前速度**的模（取初速会让末段仍拉长）');
    assertTrue(/FX\.sparkStretch/.test(vs),
      '拉伸系数必须取自常量 FX.sparkStretch（写死字面量 = 第二个权威）');
    assertTrue(/abs\(/.test(fs) && /3\.4/.test(fs),
      '片元必须是条状轮廓（横向窄核 ×3.4），不是圆形羽化 mask');
    // 屏幕尺寸硬钳（近相机时不糊成大光斑）
    assertTrue(/min\(/.test(vs), '顶点必须有 min（屏幕尺寸硬钳）');
    assertTrue(/sCap/.test(vs) && /depth/.test(vs),
      '硬钳必须按视图深度算（固定世界尺寸会在近相机处糊成大光斑）');
    assertEqual(spark.blending, THREE.AdditiveBlending, '火星是小白热亮点 ⇒ additive');
    assertFalse(spark.depthWrite);
    assertTrue(spark.transparent);
    assertEqual(spark.fog, false, '远处火星不得被雾洗成天空色');
    assertTrue(!!uniforms.uTime, '须有 uTime（与 aSpawn 同一时钟）');
  } finally {
    spark.dispose();
  }
});

test('spike spark 材质: 余烬是圆点上浮（gravity 取正的 emberRise）', () => {
  const { ember, uniforms } = createSpikeEmberMaterial();
  try {
    const vs = nodeCode(ember.vertexNode);
    const fs = nodeCode(ember.colorNode);
    assertTrue(vs.length > 20 && fs.length > 20, '须真的取到两个节点函数体');
    assertTrue(/length\(vUv\)/.test(fs), '余烬须用圆形羽化掩膜');
    // ⚠️⚠️ **重力/阻力/屏幕上钳都经 `P` 表取值** ⇒ 常量字面量不在源码里
    //（实测：源码只有 `float(P.gravity)` / `float(P.cap)`）。故这里只钉
    // 「公式结构存在」，**符号正确性由下面的 CPU 复刻用例守**。
    assertTrue(/P\.gravity/.test(vs) && /P\.drag/.test(vs) && /P\.cap/.test(vs),
      '顶点须按 P 表取重力/阻力/屏幕上钳（写死字面量 = 第二个权威）');
    assertEqual(ember.blending, THREE.AdditiveBlending);
    assertTrue(!!uniforms.uTime);
  } finally {
    ember.dispose();
  }
});

test('spike spark 材质: 两组 uniform 互不共享（各自独立时钟句柄）', () => {
  const a = createSpikeSparkMaterial();
  const b = createSpikeEmberMaterial();
  try {
    assertTrue(a.uniforms.uTime !== b.uniforms.uTime,
      '两次构造须各返回自己的 uniform（模块级单例会让两个池互相覆写）');
    a.uniforms.uTime.value = 12.5;
    assertEqual(b.uniforms.uTime.value, 0, '写一组不得影响另一组');
  } finally {
    a.spark.dispose();
    b.ember.dispose();
  }
});

// ==================== GPU 运动的 CPU 复刻（closed form） ====================
//
// ⚠️⚠️ **为何需要它**：两个 pass 共用同一个工厂函数，重力/阻力/屏幕上钳都经
// `P` 表取值 ⇒ **常量字面量根本不出现在 shader 源码里**（实测：源码里只有 `P.cap`）。
// 源码级判据对「余烬照抄了火星的重力符号」零判别力。
// 正解：把 shader 的位移公式在 CPU 侧算一遗，钉**观感事实**（往上飘 / 抛物线）。
// 公式权威：`spike-fx-material.js:makeParticlePass` 的
//   pos = origin + vel·(1−e^(−drag·t))/drag + (0, g·t²/2, 0)

/** 按 shader 公式算粒子在 t 秒时相对出生点的位移 */
function particleOffset(seed, t, drag, gravity) {
  const integ = (1 - Math.exp(-drag * t)) / drag;
  return [
    seed.vel[0] * integ,
    seed.vel[1] * integ + gravity * t * t * 0.5,
    seed.vel[2] * integ,
  ];
}

test('spike spark 运动: 余烬全程往上飘（照抄火星重力会让它往下掉）', () => {
  const seeds = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'ember', 40, makeRand(21));
  let minDy = Infinity;
  for (const s of seeds) {
    // 量到**最长寿命**（0.95 × 1.3）而不是只看开头：照抄负重力时开头仍向上，
    // 后半程才转负 ⇒ 只量 t=0.1 的判据零判别力。
    for (let t = 0.05; t <= FX.emberLifetime * 1.3; t += 0.05) {
      const dy = particleOffset(s, t, FX.emberDrag, FX.emberRise)[1];
      minDy = Math.min(minDy, dy);
    }
  }
  assertTrue(minDy > 0,
    `余烬全程竖直位移须为正（最低点 ${minDy.toFixed(4)}）—— 负值 = 读作碎屑落地`);
  // 负向锚点（同一批种子、只换重力符号）：必须真的出现下沉
  let minDyWrong = Infinity;
  for (const s of seeds) {
    for (let t = 0.05; t <= FX.emberLifetime * 1.3; t += 0.05) {
      minDyWrong = Math.min(minDyWrong, particleOffset(s, t, FX.emberDrag, FX.sparkGravity)[1]);
    }
  }
  assertTrue(minDyWrong < 0,
    `负向锚点失效：换成 sparkGravity 后最低点 ${minDyWrong.toFixed(4)} 仍 ≥ 0 ⇒ 上面那条没判别力`);
});

test('spike spark 运动: 火星走抛物线（先升后降，不是一直往上飞）', () => {
  const seeds = spikeSparkSeeds(SPIKE_AT_ORIGIN, 0, 'spark', 40, makeRand(21));
  let turned = 0;
  for (const s of seeds) {
    const life = s.life;
    const peakT = Math.min(life, Math.abs(s.vel[1] / FX.sparkGravity));
    const atPeak = particleOffset(s, peakT, FX.sparkDrag, FX.sparkGravity)[1];
    const atEnd = particleOffset(s, life, FX.sparkDrag, FX.sparkGravity)[1];
    assertTrue(atPeak > 0, `火星顶点须在地面之上：${atPeak.toFixed(3)}`);
    if (atEnd < atPeak) turned++;
  }
  assertTrue(turned > seeds.length * 0.5,
    `多数火星须在寿命内回落（${turned}/${seeds.length}）—— 否则读作一直往上飞的烟花`);
});

// ==================== 渲染池 ====================

test('spike spark 渲染: 三个 mesh，构造后全部 visible=false（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = makeRenderer(scene);
  try {
    assertEqual(r.meshes.length, 3, '尖锥 + 火星 + 余烬');
    assertEqual(scene.children.length, 3);
    for (const m of r.meshes) {
      assertFalse(m.visible, `${m.name} 构造后必须隐藏`);
      assertFalse(m.frustumCulled, `${m.name} 须关剔除（包围球按零 scale 算会误剔）`);
    }
    assertEqual(r.activeCount, 0);
    r.update(1000);
    for (const m of r.meshes) assertFalse(m.visible, `${m.name} 空转后仍须隐藏`);
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 粒子用 Mesh + InstancedBufferGeometry，不是 InstancedMesh', () => {
  const r = makeRenderer();
  try {
    // ⚠️ InstancedMesh 的 instanceMatrix 会接管 modelViewMatrix，把由 aOrigin 定位的
    // 粒子全塌到原点（v3.21 实测：落点变一条白色竖糊，而 visible/计数/draw call 全绿）。
    for (const m of [r.sparkMesh, r.emberMesh]) {
      assertFalse(m.isInstancedMesh === true, `${m.name} 不得是 InstancedMesh`);
      assertTrue(m.geometry.isInstancedBufferGeometry === true, `${m.name} 几何须 instanced`);
    }
    assertTrue(r.mesh.isInstancedMesh === true, '尖锥本体仍是 InstancedMesh（它靠实例矩阵摆位）');
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 延迟未到不发火星（火星跟着那一根的破土时刻）', () => {
  const r = makeRenderer();
  try {
    r.spawn([{ x: 0, y: 5, z: -8, delayMs: 200 }], 1000);
    r.update(1000 + 100);      // 仍在递延期
    assertFalse(r.sparkMesh.visible, '递延期不得喷火星（否则刺还没出来就先冒火）');
    assertFalse(r.emberMesh.visible);
    r.update(1000 + 260);      // 已过延迟 + 60ms 升起
    assertTrue(r.sparkMesh.visible, '破土后须喷火星');
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 单根总量 == 配额终值，且分多批（不是一次性星爆）', () => {
  const r = makeRenderer();
  try {
    const counts = [];
    const orig = r._emitSparks.bind(r);
    r._emitSparks = (s, kind, progress, count, tSec) => {
      if (kind === 'spark') counts.push(count);
      return orig(s, kind, progress, count, tSec);
    };
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
    for (let ms = 0; ms <= SPIKE_FX.lifeMs; ms += 16) r.update(1000 + ms);
    const total = counts.reduce((a, b) => a + b, 0);
    assertEqual(total, spikeSparkQuotaAt(FX.lifeMs, 'spark'), '总颗数须等于配额终值');
    assertTrue(counts.length >= 5, `须分多批沿升起过程撒，实得 ${counts.length} 批`);
    assertTrue(counts[0] > counts[counts.length - 1],
      `首批（破土）须多于末批（渐稀）：${counts[0]} vs ${counts[counts.length - 1]}`);
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 5 根各自的火星落在自己的落点上（不共用第一根的位置）', () => {
  const r = makeRenderer();
  try {
    const pts = [];
    for (let i = 0; i < 5; i++) pts.push({ x: 0, y: 5, z: -2 - 2 * i, delayMs: i * 50 });
    r.spawn(pts, 1000);
    r.update(1000 + 400);      // 全部过延迟且已过升起段
    const origin = r._sparkGeo.getAttribute('aOrigin');
    const spawn = r._sparkGeo.getAttribute('aSpawn');
    const zs = new Set();
    for (let i = 0; i < origin.count; i++) {
      if (spawn.getX(i) < 0) continue;      // 未用过的 slot
      zs.add(Math.round(origin.getZ(i)));
    }
    assertTrue(zs.size >= 4, `火星须分布在多根刺上，实得 z 集合 ${[...zs].join(',')}`);
    // 负向锚点：全部从 pts[0] 发射 ⇒ zs.size = 1 ⇒ FAIL
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 缩回段不再发火星（刺没了不得还在喷）', () => {
  const r = makeRenderer();
  try {
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
    const stop = SPIKE_FX.lifeMs * SPIKE_FX.shrinkFrom;
    r.update(1000 + stop);
    const emittedAtStop = r._sparkSlot;
    r.update(1000 + SPIKE_FX.lifeMs - 1);
    assertEqual(r._sparkSlot, emittedAtStop, '缩回段不得再写新粒子');
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: 尖锥回收后粒子自然衰亡再隐藏（不硬切）', () => {
  const r = makeRenderer();
  try {
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
    r.update(1000 + SPIKE_FX.lifeMs * 0.5);
    const lastEmitMs = r._sparkLastEmit * 1000;
    assertTrue(r.sparkMesh.visible);

    r.update(1000 + SPIKE_FX.lifeMs + 1);
    assertEqual(r.activeCount, 0, '尖锥到期须回收');
    assertFalse(r.mesh.visible, '尖锥回收后不得提交');
    assertTrue(r.sparkMesh.visible, '在飞的火星不得被硬切');

    r.update(lastEmitMs + FX.particleIdleSeconds * 1000 + 10);
    assertFalse(r.sparkMesh.visible, '空闲超时后火星层须隐藏（draw call 回基线）');
    assertFalse(r.emberMesh.visible, '余烬层同理');
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: aSpawn 与 uTime 同一个时钟（绝对秒）', () => {
  const r = makeRenderer();
  try {
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 12_000);
    r.update(12_060);
    const spawn = r._sparkGeo.getAttribute('aSpawn');
    let found = -1;
    for (let i = 0; i < spawn.count; i++) if (spawn.getX(i) > 0) { found = spawn.getX(i); break; }
    assertTrue(found > 0, '须有已写入的粒子');
    // ⚠️ aSpawn 是 **Float32** 属性 ⇒ 12.06 存进去变成 12.0600004196167。
    // 容差取 1e-5（float32 在 12 量级的精度约 1e-6），而不是 1e-9。
    // 判据意图不变：写毫秒（12060）与写秒（12.06）差 3 个量级，这条仍分得开。
    assertClose(found, 12.06, 1e-5, 'aSpawn 须是绝对秒（nowMs/1000）');
    assertClose(r._sparkUniforms.uTime.value, 12.06, 1e-9, 'uTime 同源');
    assertClose(r._emberUniforms.uTime.value, 12.06, 1e-9, '余烬 uTime 同源');
    // 负向锚点：aSpawn 写 nowMs（毫秒）⇒ age 恒负 ⇒ 粒子全灭而计数全绿
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: NaN nowMs / NaN 落点不污染粒子属性', () => {
  const r = makeRenderer();
  try {
    r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], NaN);
    r.spawn([{ x: NaN, y: 5, z: -2, delayMs: 0 }], 1000);
    assertEqual(r.activeCount, 0);
    r.update(1016);
    assertFalse(r.sparkMesh.visible, '没有合法刺就不得喷火星');
    r.spawn([{ x: 1, y: 5, z: -4, delayMs: 0 }], 1000);
    r.update(1060);
    const origin = r._sparkGeo.getAttribute('aOrigin');
    const vel = r._sparkGeo.getAttribute('aVel');
    for (let i = 0; i < origin.count; i++) {
      assertTrue(Number.isFinite(origin.getX(i)) && Number.isFinite(origin.getY(i))
        && Number.isFinite(origin.getZ(i)), `aOrigin[${i}] 含 NaN`);
      assertTrue(Number.isFinite(vel.getX(i)), `aVel[${i}] 含 NaN`);
    }
  } finally {
    r.dispose();
  }
});

test('spike spark 渲染: dispose 摘除全部三个 mesh 并释放几何/材质', () => {
  const scene = new THREE.Scene();
  const r = makeRenderer(scene);
  r.spawn([{ x: 0, y: 5, z: -2, delayMs: 0 }], 1000);
  r.update(1060);
  assertEqual(scene.children.length, 3);
  r.dispose();
  assertEqual(scene.children.length, 0, 'dispose 必须把三个 mesh 全部移出场景');
});