// src/tests/test-storm-lance.js — Storm Lance 蓄力大招的纯函数与渲染契约（v3.20）
//
// 分三组：
//   ① 蓄力时序（R1：按下 1s 静默 + 1s 蓄力 = 2s）
//   ② 命中截断（R2：碰到实体立即在该处爆炸，不穿身）
//   ③ 观感身份（R3 条状火花 / R4 outQuint 猛扩 + 硬阈值电弧 / 分段线性 kink）
//
// ⚠️ 本文件同时在 Node 轻档与浏览器整页跑 ⇒ 不得 import node:* 模块。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { EXPLOSION_DAMAGE } from '../voxel/explosion.js';
import {
  stormChargeProgress, stormLanceAxis, stormLanceOffsets, stormLanceSweep,
  cinderChargeProgress, chargeStageAt,
} from '../player/weapons/storm-lance.js';

/** assert.js 没有 assertClose，本文件自带（AGENTS.md 已记） */
function assertClose(actual, expected, eps, msg) {
  assertTrue(Math.abs(actual - expected) <= eps,
    `${msg ?? 'assertClose'}: expected ${expected} ±${eps}, got ${actual}`);
}

const CFG = () => WEAPONS[WEAPON_IDS.SWORD].stormLance;
/** v3.21 第三秒大招（Cinder Fall）的玩法配置 */
const CINDER = () => WEAPONS[WEAPON_IDS.SWORD].cinderFall;
/**
 * 两招的**联合蓄力时序**（阶段判定与第二段进度都读它）。
 * ⚠️ 不在测试里另拼一份 `{delay, charge, charge2}` —— 那就是第二份权威，
 * 生产侧改了字段名而测试拼的对象没跟上时会静默全绿。
 */
const SEQ = () => ({ ...CFG(), cinderChargeSeconds: CINDER().chargeSeconds });

// ---------------------------------------------------------------- ① 蓄力时序

test('storm catalog: 蓄力时序 = 1s 静默 + 1s 蓄力，总 2s（R1）', () => {
  const c = CFG();
  assertTrue(!!c, '剑必须带 stormLance 配置');
  assertEqual(c.chargeDelaySeconds, 1.0);
  assertEqual(c.chargeSeconds, 1.0);
  assertClose(c.chargeDelaySeconds + c.chargeSeconds, 2.0, 1e-9, '按下到可发射必须 2s');
});

test('storm catalog: 伤害派生自 EXPLOSION_DAMAGE（红线 1，不写第二份 50）', () => {
  assertEqual(CFG().damage, EXPLOSION_DAMAGE);
});

test('storm charge: 静默期内进度恒 0（R1 的判别力所在）', () => {
  const c = CFG();
  // 用户：「不然我只需要挥刀的时候也会触发蓄力的动画，画面就太乱了」
  // ⇒ 前 1s 必须完全没有蓄力视觉。progress 是渲染层唯一的开关。
  for (const t of [0, 0.1, 0.225, 0.5, 0.9, 0.99, 0.999]) {
    assertEqual(stormChargeProgress(t, c), 0, `t=${t} 应仍在静默期`);
  }
});

test('storm charge: 1s 起开始爬，2s 满', () => {
  const c = CFG();
  assertClose(stormChargeProgress(1.0, c), 0, 1e-9, '刚到 1s 时为 0');
  assertClose(stormChargeProgress(1.5, c), 0.5, 1e-9, '1.5s 时半程');
  assertClose(stormChargeProgress(2.0, c), 1, 1e-9, '2s 蓄满');
  assertClose(stormChargeProgress(3.0, c), 1, 1e-9, '超过后钳在 1');
});

test('storm charge: 单调不减', () => {
  const c = CFG();
  let prev = -1;
  for (let t = 0; t <= 2.5; t += 0.05) {
    const p = stormChargeProgress(t, c);
    assertTrue(p >= prev - 1e-12, `progress 必须单调：${prev} → ${p} @t=${t}`);
    prev = p;
  }
});

test('storm charge: 非法输入钳到 0（静默失效比崩溃更难查）', () => {
  const c = CFG();
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, -5]) {
    assertEqual(stormChargeProgress(bad, c), 0, `bad=${bad}`);
  }
  assertEqual(stormChargeProgress(1.5, null), 0);
  assertEqual(stormChargeProgress(1.5, {}), 0);
});

test('storm: 单槽前提 —— 视觉总时长 < 最小施法间隔（载荷性推导）', () => {
  const c = CFG();
  const visual = c.range / c.speed + c.holdSeconds + c.fadeSeconds;
  const gap = c.chargeDelaySeconds + c.chargeSeconds;
  assertTrue(visual < gap,
    `视觉 ${visual} 必须 < 最小间隔 ${gap}，否则两道闪电重叠、单槽渲染器不成立`);
});

// ------------------------------------------------- ①b 分段蓄力（v3.21 Cinder Fall）
//
// 用户 2026-11-19：「按住第一秒时只计时不蓄力，按到第二秒时松开是发送 storm lance 动作，
// 按到第三秒时发出时，执行 cinder fall 的攻击动作，蓄力球跟 storm lance 一样」。
// 阶段门取「**进入那一秒就能发**」（用户在两个读法里明确选了它）。

test('cinder catalog: 第二段 1s，总按下 3s；伤害与半径都派生（红线 1）', () => {
  const c = CINDER();
  assertTrue(!!c, '剑必须带 cinderFall 配置');
  assertEqual(c.chargeSeconds, 1.0);
  assertClose(CFG().chargeDelaySeconds + CFG().chargeSeconds + c.chargeSeconds, 3.0, 1e-9,
    '按下到第三段满必须 3s');
  assertEqual(c.damage, EXPLOSION_DAMAGE, '伤害不得写第二份 50');
});

test('cinder charge: 前两段（<2s）进度恒 0，第三秒才爬', () => {
  const s = SEQ();
  for (const t of [0, 0.5, 0.99, 1.0, 1.5, 1.99]) {
    assertEqual(cinderChargeProgress(t, s), 0, `t=${t} 还没进第三秒`);
  }
  assertClose(cinderChargeProgress(2.0, s), 0, 1e-9, '刚到 2s 时为 0');
  assertClose(cinderChargeProgress(2.5, s), 0.5, 1e-9, '2.5s 时半程');
  assertClose(cinderChargeProgress(3.0, s), 1, 1e-9, '3s 蓄满');
  assertClose(cinderChargeProgress(9.0, s), 1, 1e-9, '超过后钳在 1');
});

test('cinder charge: 非法输入钳到 0（静默失效比崩溃更难查）', () => {
  const s = SEQ();
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, -5]) {
    assertEqual(cinderChargeProgress(bad, s), 0, `bad=${bad}`);
  }
  assertEqual(cinderChargeProgress(2.5, null), 0);
  assertEqual(cinderChargeProgress(2.5, {}), 0);
});

test('charge stage: 真值表逐格（进入那一秒就能发）', () => {
  const s = SEQ();
  const table = [
    [0, 'none'], [0.5, 'none'], [0.99, 'none'], [0.999, 'none'],
    [1.0, 'lance'], [1.2, 'lance'], [1.99, 'lance'],
    [2.0, 'cinder'], [2.5, 'cinder'], [3.0, 'cinder'], [10, 'cinder'],
  ];
  for (const [t, want] of table) {
    assertEqual(chargeStageAt(t, s), want, `t=${t} 的松手招式`);
  }
});

test('charge stage: 非法输入 → none；缺配置 → none', () => {
  const s = SEQ();
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, -5]) {
    assertEqual(chargeStageAt(bad, s), 'none', `bad=${bad}`);
  }
  assertEqual(chargeStageAt(2.5, null), 'none');
  assertEqual(chargeStageAt(2.5, {}), 'none');
});

test('charge stage: 边界对 dt 累积误差免疫（实测 60×0.05 = 2.9999999999999973）', () => {
  const s = SEQ();
  // ⚠️ 这条不是理论风险：`hold(f, 3.0)` 走 60 次 0.05 累加，实测落在 3 的**下方**。
  // 裸 `elapsed >= 3` 会判「还没蓄满」⇒ 与 controller 的跨越标志分裂。
  let acc = 0;
  for (let i = 0; i < 60; i++) acc += 0.05;
  assertTrue(acc < 3.0, '前提：累加值确实落在边界下方（否则本用例无判别力）');
  assertClose(cinderChargeProgress(acc, s), 1, 1e-9, '累加到 3s 必须算蓄满');
  assertEqual(chargeStageAt(acc, s), 'cinder');
  let acc2 = 0;
  for (let i = 0; i < 40; i++) acc2 += 0.05;
  assertEqual(chargeStageAt(acc2, s), 'cinder', '累加到 2s 必须已进第三秒');
});

test('charge stage: 与进度语义刻意不同（刚到边界进度 0、阶段已进入）', () => {
  const s = SEQ();
  // 进度 = 「蓄了多少」；阶段 = 「松手发哪招」。不得为了看着一致把一侧改成另一侧。
  assertClose(stormChargeProgress(1.0, s), 0, 1e-9);
  assertEqual(chargeStageAt(1.0, s), 'lance');
  assertClose(cinderChargeProgress(2.0, s), 0, 1e-9);
  assertEqual(chargeStageAt(2.0, s), 'cinder');
});

test('cinder: 第一段进度逐位不变（负向：加第二段不得改坏 Storm Lance）', () => {
  const s = SEQ();
  // 冻结表：v3.20 的既有口径，加了第二段之后必须逐位相同
  const frozen = [
    [0, 0], [0.5, 0], [0.99, 0], [1.0, 0], [1.25, 0.25],
    [1.5, 0.5], [1.75, 0.75], [2.0, 1], [3.0, 1],
  ];
  for (const [t, want] of frozen) {
    assertClose(stormChargeProgress(t, s), want, 1e-12, `t=${t} 第一段进度`);
  }
});

// ---------------------------------------------------------------- ② 命中截断

/**
 * 造一个假 world。
 * ⚠️ **必须匹配 `raycastVoxel` 的真实契约**：它读 `world.registry.idOf('water')`
 * 与 `world.getBlockId(x,y,z)`，**不是** `isSolid`（后者是玩家物理的口径）。
 * 拿 `isSolid` 造假会拿到 `Cannot read properties of undefined (reading 'idOf')`。
 */
function fakeWorld(solidAt) {
  return {
    registry: { idOf: (name) => (name === 'water' ? 9 : 1) },
    getBlockId: (x, y, z) => (solidAt(x, y, z) ? 1 : 0),
  };
}

/** 造一个假 entities，只实现 raycastAll */
function fakeEntities(hits) {
  return {
    raycastAll(origin, dir, maxDist) {
      return hits
        .filter((h) => h.dist <= maxDist)
        .map((h) => ({
          id: h.id, type: h.type ?? 'zombie', dist: h.dist,
          point: [origin[0] + dir[0] * h.dist, origin[1] + dir[1] * h.dist, origin[2] + dir[2] * h.dist],
        }));
    },
  };
}

const AIM = () => ({
  origin: [0, 5, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
  target: null,
});

test('storm sweep: 无遮挡时 length = range', () => {
  const c = CFG();
  const r = stormLanceSweep({
    world: fakeWorld(() => false), entities: fakeEntities([]), aim: AIM(), cfg: c,
  });
  assertClose(r.length, c.range, 1e-9);
  assertEqual(r.impactKind, 'air');
  assertDeepEqual(r.hits, []);
});

test('storm sweep: 实体在 8 格 ⇒ length 截到 8 且 impactKind=entity（R2 核心）', () => {
  const c = CFG();
  // 墙在 20 格、Boss 在 8 格。用户：「就在击中碰撞身体的位置爆炸，
  // 而不是穿过身体到 boss 身体后方的方块触碰处爆炸」
  const world = fakeWorld((x, y, z) => z <= -20);
  const r = stormLanceSweep({
    world, entities: fakeEntities([{ id: 'boss1', type: 'guardian', dist: 8 }]),
    aim: AIM(), cfg: c,
  });
  assertClose(r.length, 8, 1e-9, '必须截到实体表面，不是墙的 20');
  assertEqual(r.impactKind, 'entity');
  assertEqual(r.hits.length, 1);
  assertEqual(r.hits[0].id, 'boss1');
  // 落点必须就在实体表面
  assertClose(r.target[2], r.origin[2] - 8, 1e-6, '落点 z 必须在 8 格处');
});

test('storm sweep: 方块更近时仍按方块截断（实体在墙后不算命中）', () => {
  const c = CFG();
  const world = fakeWorld((x, y, z) => z <= -6);
  const r = stormLanceSweep({
    world, entities: fakeEntities([{ id: 'z1', dist: 12 }]),
    aim: AIM(), cfg: c,
  });
  // ⚠️ DDA 返回的是到墙**近端面**的距离，不是格中心：
  // 首个实心格 z=-6，其近端面在 z=-5；手点 z=-handOffset[2]=-0.55
  // ⇒ dist = -0.55 - (-5) = 4.45。写 6 是「断言描述想象中的世界」（AGENTS.md 已记）。
  const wallFace = -0.55 - (-5);
  assertClose(r.length, wallFace, 1e-9);
  assertTrue(r.length < 12, '必须比实体近，否则本用例没测到遮挡');
  assertEqual(r.impactKind, 'block');
  assertDeepEqual(r.hits, [], '墙后的实体不得掉血');
});

test('storm sweep: 多个实体 ⇒ 截到最近那个，但全部命中都掉血', () => {
  const c = CFG();
  const r = stormLanceSweep({
    world: fakeWorld(() => false),
    entities: fakeEntities([{ id: 'far', dist: 15 }, { id: 'near', dist: 5 }]),
    aim: AIM(), cfg: c,
  });
  assertClose(r.length, 5, 1e-9, '截到最近的');
  assertEqual(r.impactKind, 'entity');
  assertEqual(r.hits.length, 2, '范围内的都要掉血');
  assertEqual(r.hits[0].id, 'near', '按 dist 升序');
});

test('storm sweep: 偏移射线先命中也要截断（Boss 盒大，轴线可能擦不到）', () => {
  const c = CFG();
  // 只有偏移射线能命中的实体：raycastAll 按 origin 的 x 偏移区分
  const entities = {
    raycastAll(origin, dir, maxDist) {
      // 轴线（x≈handOffset.x）不命中；偏移射线命中于 7 格
      const offAxis = Math.abs(origin[0] - 0.28) > 0.1;
      if (!offAxis) return [];
      if (7 > maxDist) return [];
      return [{ id: 'side', type: 'ignis', dist: 7, point: [origin[0], origin[1], origin[2] - 7] }];
    },
  };
  const r = stormLanceSweep({
    world: fakeWorld(() => false), entities, aim: AIM(), cfg: c,
  });
  assertClose(r.length, 7, 1e-9, '偏移射线的命中必须参与截断');
  assertEqual(r.impactKind, 'entity');
});

test('storm sweep: 命中点坐标 = 轴线上的截断点（不是偏移射线自己的点）', () => {
  const c = CFG();
  const r = stormLanceSweep({
    world: fakeWorld(() => false),
    entities: fakeEntities([{ id: 'b', dist: 9 }]),
    aim: AIM(), cfg: c,
  });
  // 落点必须在轴线上（光柱本体沿轴线），否则爆壳会画歪
  assertClose(r.target[0], r.origin[0], 1e-9, 'target.x 必须与 origin.x 同（轴线）');
  assertClose(r.target[1], r.origin[1], 1e-9, 'target.y 必须与 origin.y 同（轴线）');
});

test('storm offsets: 十字五条，首条恒为轴线', () => {
  const o = stormLanceOffsets(CFG());
  assertEqual(o.length, 5);
  assertDeepEqual(o[0], [0, 0]);
  const r = CFG().radius;
  assertDeepEqual(o[1], [r, 0]);
  assertDeepEqual(o[2], [-r, 0]);
  assertDeepEqual(o[3], [0, r]);
  assertDeepEqual(o[4], [0, -r]);
});

test('storm axis: 手点按 handOffset 偏移（读作从剑尖射出）', () => {
  const c = CFG();
  const a = stormLanceAxis(AIM(), c);
  const [hr, hu, hf] = c.handOffset;
  assertClose(a.origin[0], hr, 1e-9);
  assertClose(a.origin[1], 5 + hu, 1e-9);
  assertClose(a.origin[2], -hf, 1e-9);
  assertDeepEqual(a.side, [1, 0, 0]);
});

// ---------------------------------------------------------------- ③ 观感身份

test('storm fx: 常量层 three-free 且玩法量派生自 catalog', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  const c = CFG();
  assertEqual(FX.radius, c.radius);
  assertEqual(FX.holdSeconds, c.holdSeconds);
  assertEqual(FX.fadeSeconds, c.fadeSeconds);
  assertEqual(FX.speed, c.speed);
  assertEqual(FX.renderOrder, 3, '体素水 0 < 海面 1 < 曳光 2 < 闪电 3');
});

test('storm fx: 蓄力球显著小于 Nova Beam 的 0.39（R5）', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  assertTrue(FX.orbSize < 0.39 * 0.7,
    `蓄力球必须明显更小，实测 ${FX.orbSize}（旧 0.39）`);
  assertTrue(FX.orbSize > 0.05, '仍要肉眼可见');
});

test('storm fx: 火花是速度拉伸条状（R3，不是圆形 quad）', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  assertTrue(FX.sparkStretch > 0, 'stretch 必须 > 0，否则退回圆点（用户报「曳光丢了」）');
  assertEqual(FX.sparkShape, 'streak');
});

test('storm fx: 爆壳用 outQuint 猛扩（R4，冲击力的来源）', async () => {
  const { stormBurstScale } = await import('../render/storm-lance-config.js');
  // outQuint(0.2) = 1-(0.8)^5 = 0.67232；outCubic(0.2) = 0.488
  // 前 20% 就冲到 2/3 ⇒ 读作「炸开」而不是「慢慢胀」
  assertTrue(stormBurstScale(0.2) > 0.6,
    `outQuint 在 t=0.2 必须 >0.6，实测 ${stormBurstScale(0.2)}`);
  assertClose(stormBurstScale(0), 0, 1e-9);
  assertClose(stormBurstScale(1), 1, 1e-9);
  // 单调
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const s = stormBurstScale(t);
    assertTrue(s >= prev - 1e-12, '扩张必须单调');
    prev = s;
  }
});

test('storm fx: 电弧阈值硬（0.80~0.97），放宽会让壳变实心球（R4）', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  assertClose(FX.burstArcLo, 0.80, 1e-9);
  assertClose(FX.burstArcHi, 0.97, 1e-9);
  assertTrue(FX.burstArcHi - FX.burstArcLo < 0.25,
    '带宽必须窄 —— 上游注释：a wide band fills the shell in and it reads as a rock');
});

test('storm kink: 分段线性噪声（尖角是闪电的身份，不得用 smoothstep）', async () => {
  const { stormKinkNoise } = await import('../render/storm-lance-config.js');
  // 线性插值的中点 = 两端平均；smoothstep 的中点也等于平均，
  // 但 t=0.25 处线性给 0.25 权重、smoothstep 给 0.15625 ⇒ 用 0.25 分辨
  const a = stormKinkNoise(0, 0);
  const b = stormKinkNoise(1, 0);
  const q = stormKinkNoise(0.25, 0);
  const linear = a + (b - a) * 0.25;
  const smooth = a + (b - a) * (0.25 * 0.25 * (3 - 2 * 0.25));
  assertClose(q, linear, 1e-9, '必须是线性插值');
  assertTrue(Math.abs(q - smooth) > 1e-6,
    '与 smoothstep 必须可区分，否则判据对「换成平滑噪声」零判别力');
});

test('storm kink: 同一 seed 确定性，不同 seed 不同形状', async () => {
  const { stormKinkNoise } = await import('../render/storm-lance-config.js');
  assertEqual(stormKinkNoise(3.7, 11), stormKinkNoise(3.7, 11));
  assertTrue(stormKinkNoise(3.7, 11) !== stormKinkNoise(3.7, 12));
});
// ---------------------------------------------------------------- ④ controller 状态机

import { WeaponController } from '../player/weapons/weapon-controller.js';
import { raycastAabbSlab, WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';

const HITTABLE = (e) => WEAPON_HITTABLE_TYPES.includes(e.type);

/** 合成 world：`"x,y,z" → id`，缺省 0（空气） */
function worldOf(blocks = new Map()) {
  return {
    registry: { idOf: (name) => (name === 'water' ? 99 : 0) },
    getBlockId: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? 0,
  };
}

/** 假 entities：内部用**真** raycastAabbSlab 求交，不自编返回值 */
function entitiesOf(list) {
  return {
    raycastAll(origin, dir, maxDist, predicate) {
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      const unit = [dir[0] / len, dir[1] / len, dir[2] / len];
      const out = [];
      for (const e of list) {
        if (predicate && !predicate(e)) continue;
        const dist = raycastAabbSlab(e.state, origin, unit, maxDist, e.aabb);
        if (dist === null || dist < 0 || dist > maxDist) continue;
        out.push({ id: e.id, type: e.type, dist, point: [0, 0, 0] });
      }
      return out.sort((a, b) => a.dist - b.dist);
    },
  };
}

function zombieAt(id, x, y, z) {
  return {
    id, type: 'zombie', state: { position: [x, y, z] },
    aabb: { min: [-0.3, 0, -0.3], max: [0.3, 1.8, 0.3] },
  };
}

/** 相机在 (0,1,0) 看向 −Z */
function aim0() {
  return { origin: [0, 1, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
}

/**
 * 夹具：真 WeaponController + 假 editor + 注入 `sweepLance`（内部调**真** stormLanceSweep）。
 * `withSweep:false` 用于负向对照（拆掉注入 ⇒ 仍有视觉但零伤害）。
 */
function fixture({ blocks = new Map(), entities = [], withSweep = true } = {}) {
  const effects = [];
  const damageCalls = [];
  const editor = {
    singleCalls: 0, batchCalls: 0,
    setBlock() { this.singleCalls++; return { changes: [{}] }; },
    setBlocks() { this.batchCalls++; return { changes: [{}] }; },
  };
  const controller = new WeaponController({
    registry: { idOf: () => 0, isIndestructible: () => false, nameOf: () => 'stone' },
    blockQuery: { getBlockId: () => 0 },
    editor,
    onEffect: (e) => effects.push(e),
  });
  const world = worldOf(blocks);
  const ents = entitiesOf(entities);
  const query = {
    raycast: () => null,
    damage: (id, amount, nowMs) => { damageCalls.push({ id, amount, nowMs }); return null; },
    knockback: () => true,
    isHittable: HITTABLE,
  };
  if (withSweep) {
    query.sweepLance = (aim, cfg) => {
      const r = stormLanceSweep({ world, entities: ents, isHittable: HITTABLE, aim, cfg });
      for (const h of r.hits) query.damage(h.id, cfg.damage, 0);
      return r;
    };
  }
  controller.setEntityQuery(query);
  controller.select('sword');
  return { controller, effects, damageCalls, editor, aim: aim0() };
}

function hold(f, seconds, dt = 0.05) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) f.controller.update(dt, f.aim);
}

function ofType(f, type) { return f.effects.filter((e) => e.type === type); }

test('storm ctrl: 短按（0.3s）只有 melee，无 storm-lance', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 0.3);
  f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'storm-lance').length, 0, '未蓄满不得施法');
  assertEqual(ofType(f, 'melee').length, 1, '按下边沿仍挥一刀（零回归）');
  assertEqual(f.controller.debugState().novaCharge, 0, '松开后蓄力归零');
});

test('storm ctrl: 静默期（0.9s）内零蓄力事件、零进度（R1）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 0.9);
  // 用户：「不然我只需要挥刀的时候也会触发蓄力的动画，画面就太乱了」
  assertEqual(f.controller.debugState().novaCharge, 0, '静默期进度必须 0');
  assertEqual(ofType(f, 'storm-charge-start').length, 0,
    '静默期不得发起手音/起手事件（否则渲染层会画光球）');
  f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'storm-lance').length, 0);
});

test('storm ctrl: 越过 1s 才发起手事件，2s 蓄满', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 1.05);
  assertEqual(ofType(f, 'storm-charge-start').length, 1, '1s 后起手一次');
  assertTrue(f.controller.debugState().novaCharge > 0, '开始爬');
  hold(f, 1.0);
  assertTrue(f.controller.debugState().novaCharged, '总 2s 后蓄满');
  assertEqual(ofType(f, 'storm-charge-ready').length, 1, '蓄满音只一次');
});

test('storm ctrl: 按住 1.5s 松开恰好一个 storm-lance，且截到实体（R2）', () => {
  const f = fixture({ entities: [zombieAt('z0', 0, 0, -8)] });
  f.controller.pointerDown(f.aim);
  // v3.21：阶段门改成「进入那一秒就能发」⇒ 第二秒内松手才是 lance（2.0s 已是 cinder）
  hold(f, 1.5);
  f.controller.pointerUp(f.aim);
  const beams = ofType(f, 'storm-lance');
  assertEqual(beams.length, 1);
  assertEqual(beams[0].weaponId, 'sword');
  assertEqual(beams[0].hits.length, 1);
  assertEqual(beams[0].impactKind, 'entity');
  assertTrue(beams[0].length < CFG().range, '必须截到实体表面而不是跑满射程');
  assertTrue(Number.isFinite(beams[0].seed));
});

test('storm ctrl: 每个实体只扣一次 50，不破坏方块不击退', () => {
  const f = fixture({ entities: [zombieAt('z0', 0, 0, -8), zombieAt('z1', 0.5, 0, -10)] });
  f.controller.pointerDown(f.aim);
  hold(f, 1.5);
  f.controller.pointerUp(f.aim);
  // 燃烧期再推 2 秒，确认不重复结算
  hold(f, 2.0);
  assertEqual(f.damageCalls.length, 2, '两个实体各一次，燃烧期不重复');
  for (const d of f.damageCalls) assertEqual(d.amount, EXPLOSION_DAMAGE);
  assertEqual(f.editor.singleCalls, 0, '不得写方块');
  assertEqual(f.editor.batchCalls, 0, '不得批量写方块');
});

test('storm ctrl: 蓄满不松开不施法', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 4.0);
  assertEqual(ofType(f, 'storm-lance').length, 0, '必须松开才触发');
  assertTrue(f.controller.debugState().novaCharged);
});

test('storm ctrl: 起手/蓄满音各只一次（不得每帧重复）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 5.0);
  assertEqual(ofType(f, 'storm-charge-start').length, 1);
  assertEqual(ofType(f, 'storm-charge-ready').length, 1);
});

test('storm ctrl: select 切武器清蓄力', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 1.5);
  assertTrue(f.controller.debugState().novaCharge > 0);
  f.controller.select('pistol');
  assertEqual(f.controller.debugState().novaCharge, 0);
  f.controller.select('sword');
  f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'storm-lance').length, 0, '切武器丢弃蓄力后不得施法');
});

test('storm ctrl: 冷却未到期不得再施法', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim); hold(f, 1.5); f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'storm-lance').length, 1);
  f.controller.cooldown = 5;
  f.controller.pointerDown(f.aim); hold(f, 1.5); f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'storm-lance').length, 1, '冷却未到期不得再施法');
});

test('storm ctrl: pointerUp() 无 aim 不抛错不施法（向后兼容）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 1.5);
  f.controller.pointerUp();
  assertEqual(ofType(f, 'storm-lance').length, 0);
  assertEqual(f.controller.debugState().novaCharge, 0);
  // v3.21：第三段同理 —— 无 aim 时 cinder 也不得抛出
  f.controller.pointerDown(f.aim);
  hold(f, 2.5);
  f.controller.pointerUp();
  assertEqual(ofType(f, 'cinder-fall').length, 0, '无 aim 时 cinder 也不得施放');
});

test('storm ctrl: 未注入 sweepLance 仍发视觉但零伤害（fixture 兼容）', () => {
  const f = fixture({ entities: [zombieAt('z0', 0, 0, -8)], withSweep: false });
  f.controller.pointerDown(f.aim);
  hold(f, 1.5);
  f.controller.pointerUp(f.aim);
  const beams = ofType(f, 'storm-lance');
  assertEqual(beams.length, 1, '仍发视觉');
  assertDeepEqual(beams[0].hits, [], '但不扣血');
  assertEqual(f.damageCalls.length, 0);
});

test('storm ctrl: 三种新事件的 recoil 恒 0（防 onShot 写出 NaN 让剑消失）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 1.5);
  f.controller.pointerUp(f.aim);
  for (const t of ['storm-charge-start', 'storm-charge-ready', 'storm-lance']) {
    for (const e of ofType(f, t)) {
      assertEqual(e.recoil, 0, `${t} 的 recoil 必须是 0 而不是缺席`);
      assertDeepEqual(e.impacts, [], `${t} 不得带方块命中记录`);
    }
  }
});

// ------------------------------------------------ ④b 分段施放（v3.21 Cinder Fall）

test('cinder ctrl: 1.5s 松手发 lance、2.5s 松手发 cinder（阶段门）', () => {
  const a = fixture();
  a.controller.pointerDown(a.aim); hold(a, 1.5); a.controller.pointerUp(a.aim);
  assertEqual(ofType(a, 'storm-lance').length, 1, '第二秒松手 → Storm Lance');
  assertEqual(ofType(a, 'cinder-fall').length, 0);

  const b = fixture();
  b.controller.pointerDown(b.aim); hold(b, 2.5); b.controller.pointerUp(b.aim);
  assertEqual(ofType(b, 'cinder-fall').length, 1, '第三秒松手 → Cinder Fall');
  assertEqual(ofType(b, 'storm-lance').length, 0, '不得两招都发');
});

test('cinder ctrl: 恰好 2.0s（40×0.05 累加）必须已进第三段（与纯函数一致）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 2.0);
  f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'cinder-fall').length, 1, '跨越标志与 chargeStageAt 必须同侧');
  assertEqual(chargeStageAt(2.0, SEQ()), 'cinder');
});

test('cinder ctrl: 短按（0.5s）只挥剑，两招都不发', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim); hold(f, 0.5); f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'melee').length, 1);
  assertEqual(ofType(f, 'storm-lance').length, 0);
  assertEqual(ofType(f, 'cinder-fall').length, 0);
});

test('cinder ctrl: 第二段起手/蓄满音各只一次，且不在第一段重复', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 1.9);
  assertEqual(ofType(f, 'cinder-charge-start').length, 0, '第一秒内不得发第二段起手');
  hold(f, 0.2);
  assertEqual(ofType(f, 'cinder-charge-start').length, 1, '越过 2s 发一次');
  hold(f, 3.0);
  assertEqual(ofType(f, 'cinder-charge-start').length, 1, '不得每帧重复');
  assertEqual(ofType(f, 'cinder-charge-ready').length, 1, '3s 蓄满音只一次');
  // 第一段的事件也不得被第二段重复触发
  assertEqual(ofType(f, 'storm-charge-start').length, 1);
  assertEqual(ofType(f, 'storm-charge-ready').length, 1);
});

test('cinder ctrl: 蓄满不松开不施法（两招都是）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 6.0);
  assertEqual(ofType(f, 'cinder-fall').length, 0, '必须松开才招');
  assertEqual(ofType(f, 'storm-lance').length, 0);
  assertTrue(f.controller.debugState().cinderCharged, '第二段已蓄满');
});

test('cinder ctrl: 切武器丢弃两段蓄力', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  hold(f, 2.5);
  assertTrue(f.controller.debugState().cinderCharge > 0);
  f.controller.select('pistol');
  assertEqual(f.controller.debugState().cinderCharge, 0);
  f.controller.select('sword');
  f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'cinder-fall').length, 0, '切武器后不得凭空抛一发');
});

test('cinder ctrl: 冷却未到期不得抛出', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim); hold(f, 2.5); f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'cinder-fall').length, 1);
  f.controller.cooldown = 5;
  f.controller.pointerDown(f.aim); hold(f, 2.5); f.controller.pointerUp(f.aim);
  assertEqual(ofType(f, 'cinder-fall').length, 1, '冷却未到期不得再抛');
});

test('cinder ctrl: 事件带弹道与 recoil 0（装配层靠它 spawn 实体）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim); hold(f, 2.5);
  const evs = f.controller.pointerUp(f.aim);
  const ev = evs.find((e) => e.type === 'cinder-fall');
  assertTrue(!!ev, '必须有 cinder-fall 事件');
  assertEqual(ev.weaponId, 'sword');
  assertEqual(ev.recoil, 0, 'recoil 必须是 0 而不是缺席（否则剑体 NaN 消失）');
  assertDeepEqual(ev.impacts, []);
  assertTrue(!!ev.launch, '必须带弹道参数');
  assertTrue(Number.isFinite(ev.launch.distance) && ev.launch.distance > 0);
  assertTrue(Number.isFinite(ev.seed));
  assertTrue(ev.launch.origin.every(Number.isFinite));
  assertTrue(ev.launch.target.every(Number.isFinite));
});

test('cinder ctrl: 未注入 aimDistance 时回落射程（fixture 兼容，不抛错）', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim); hold(f, 2.5);
  const evs = f.controller.pointerUp(f.aim);
  const ev = evs.find((e) => e.type === 'cinder-fall');
  assertTrue(!!ev, '无 aim.target 仍须抛出');
  assertClose(ev.launch.distance, CINDER().range, 1e-9);
});

test('cinder ctrl: 四种蓄力/施放事件的 recoil 恒 0', () => {
  const f = fixture();
  f.controller.pointerDown(f.aim);
  // 蓄到 3.2s：越过第二段蓄满点（否则 cinder-charge-ready 根本不会出现）
  hold(f, 3.2);
  f.controller.pointerUp(f.aim);
  for (const t of ['cinder-charge-start', 'cinder-charge-ready', 'cinder-fall']) {
    const list = ofType(f, t);
    assertTrue(list.length > 0, `${t} 必须真的出现过（否则本例恒真）`);
    for (const e of list) {
      assertEqual(e.recoil, 0, `${t} 的 recoil`);
      assertDeepEqual(e.impacts, [], `${t} 不得带方块命中记录`);
    }
  }
});

// ---------------------------------------------------------------- ⑤ TSL 构造陷阱

test('storm mat: boltFrame 不得用 Fn 包（SplitNode 会让多键对象全 undefined）', async () => {
  // ⚠️⚠️ 实测缺陷：`Fn(() => ({dir,n1,n2,span}))` 的返回值被包成 **SplitNode**（swizzle），
  // 只认 x/y/z/w 四通道 ⇒ 四个自定义键**全部 undefined** ⇒ `n1.mul(...)` 抛
  // `Cannot read properties of undefined (reading 'mul')` ⇒ **整片 pass 不上屏**（lit=0），
  // 而材质构造、Node 单测、uniform 清单全绿。
  // 判据落在**源码**上：这是静态事实，且节点图在 GPU build 前无法遍历（Fn 返 Proxy）。
  const res = await fetch(new URL('../render/storm-lance-material.js', import.meta.url));
  const src = await res.text();
  const i = src.indexOf('function boltFrame(');
  assertTrue(i >= 0, 'boltFrame 必须是普通 function（不是 const boltFrame = Fn(...)）');
  const j = src.indexOf('const boltFrame');
  assertEqual(j, -1, 'boltFrame 不得写成 Fn 包装的箭头函数');
});

test('storm mat: Loop 必须传 {start,end,type} 而不是裸数字', async () => {
  // ⚠️⚠️ 实测缺陷：`Loop(5, ({i}) => …)` 的 5 被 nodeArray 包成 ConstNode（isNode=true），
  // 而 LoopNode.getProperties 只对 isNode!==true 的 param 建 inputs 键
  // ⇒ inputs={} ⇒ 解构的 i 是 undefined ⇒ float(i) 抛错 ⇒ 整片 pass 不上屏。
  const res = await fetch(new URL('../render/storm-lance-material.js', import.meta.url));
  const src = await res.text();
  // 只看**代码行**，跳过注释（文件头举了反例 `Loop(5, …)`，不能把它当成缺陷）
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // ⚠️ 不能用 `[^,]+` 匹第一参：`{start:0, end:5}` 内部就有逗号，会在第一个逗号处截断
  // ⇒ 匹不到任何东西 ⇒ 判据恒假。改成「要么一个花括号组，要么一串非逗号」。
  const withIndex = [...code.matchAll(/Loop\((\{[^}]*\}|[^,{}]+),\s*\(\{\s*i\s*\}\)/g)];
  assertTrue(withIndex.length > 0, '本材质应至少有一个用索引的 Loop');
  for (const m of withIndex) {
    assertTrue(m[1].trim().startsWith('{'),
      `带索引解构的 Loop 第一参必须是 {start,end,type}，实测 ${m[1].trim()}`);
  }
});

test('storm mat: 六个 pass 的 fog/depthWrite/renderOrder 口径一致', async () => {
  const { createStormLanceMaterials } = await import('../render/storm-lance-material.js');
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  const m = createStormLanceMaterials();
  for (const k of ['glow', 'core', 'spark', 'orb', 'burst', 'shock']) {
    const x = m[k];
    assertEqual(x.fog, false, `${k} 必须关雾（否则远处被洗成天空色）`);
    assertEqual(x.depthWrite, false, `${k} 不得写深度`);
    assertEqual(x.depthTest, true, `${k} 必须受地形遮挡`);
    assertEqual(x.transparent, true, `${k} 必须透明`);
    assertTrue(!!x.vertexNode, `${k} 必须显式设 vertexNode（参数化几何不能走 positionNode）`);
    assertTrue(!!x.colorNode, `${k} 必须有 colorNode`);
  }
  assertEqual(FX.renderOrder, 3);
});

test('storm renderer: 全部 mesh 空闲全隐藏，且名字带 storm: 前缀', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const scene = new THREE.Scene();
  const r = new StormLanceRenderer({ scene, haloTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
  // v3.20b：六个 pass + 蓄力光晕 = 7
  assertEqual(r.meshes.length, 7);
  for (const m of r.meshes) {
    assertEqual(m.visible, false, `${m.name} 空闲必须隐藏（否则恒增 draw call）`);
    assertEqual(m.frustumCulled, false);
    assertTrue(m.name.startsWith('storm:'), `名字前缀：${m.name}`);
  }
  assertEqual(r.phase, 'idle');
  assertEqual(r.active, false);
  r.dispose();
  assertEqual(scene.children.length, 0, 'dispose 必须清空 scene');
});

test('storm renderer: 爆壳走 outQuint 猛扩（R4 的判别力所在）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
  const args = {
    origin: [0, 5, 0], target: [0, 5, -20], side: [1, 0, 0],
    length: 20, seed: 3, impactKind: 'entity',
  };
  r.fire(args, 0);
  // 推到 hold（travel = 20/105 ≈ 0.19s）
  let t = 0;
  for (let i = 0; i < 12; i++) { t += 20; r.update(t, 0.02); }
  assertEqual(r.phase, 'hold');
  // 落点爆壳刚生成 ⇒ 量它在寿命 20% 时的半径比例
  const born = r._burstAt;
  const life = FX.burstLifeSeconds * 1000;
  r.update(born + life * 0.2, 0.02);
  const s20 = r.burstMesh.scale.x;
  const from = FX.burstSize * 0.2;
  const ratio = (s20 - from) / (FX.burstSize - from);
  assertTrue(ratio > 0.6,
    `outQuint 在 20% 寿命应已扩张 >60%，实测 ${(ratio * 100).toFixed(1)}%（outCubic 只 48.8%）`);
  r.dispose();
});

test('storm renderer: 冲击环朝向按 impactKind 分流（R2）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const mk = async (kind) => {
    const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
    r.fire({
      origin: [0, 5, 0], target: [0, 5, -20], side: [1, 0, 0],
      length: 20, seed: 3, impactKind: kind,
    }, 0);
    let t = 0;
    for (let i = 0; i < 14; i++) { t += 20; r.update(t, 0.02); }
    r.shockMesh.updateMatrixWorld(true);
    // 环面法线 = 局部 +Z 经世界矩阵变换后的方向
    const n = new THREE.Vector3(0, 0, 1).transformDirection(r.shockMesh.matrixWorld);
    const out = { y: n.y, z: n.z };
    r.dispose();
    return out;
  };
  const ent = await mk('entity');
  const blk = await mk('block');
  // 命中实体（束朝 −Z）⇒ 环法线朝玩家 = +Z
  assertTrue(ent.z > 0.8, `命中实体时环应朝玩家（+Z），实测 z=${ent.z}`);
  // 命中地面 ⇒ 环法线朝上 = +Y
  assertTrue(blk.y > 0.8, `命中地面时环应贴地（+Y），实测 y=${blk.y}`);
  assertTrue(Math.abs(ent.z - blk.z) > 0.5,
    '两种朝向必须可区分，否则本判据对「一律贴地」零判别力');
});

// ---------------------------------------------------------------- ⑥ 蓄力球朦胧化（v3.20b）
//
// 用户 2026-11-19 实玩：「蓄力时的光球，边界太清晰，就有点像一个发光的鸡蛋……
// 要朦胧一些，可以让这个光球再小一点，然后让他发出光，有一层光晕覆盖在光球上」。
//
// ⚠️ **闭合网格的几何边界是硬边，调参数消不掉** —— 必须另加一层屏幕对齐的
// billboard 光晕（alpha 从中心径向连续衰减到 0，无几何轮廓）。下面三条判据
// 分别钉住「更小」「有独立光晕层」「核心不再是实心+亮边」。

test('storm orb: 核心比 v3.20 更小（用户「再小一点」）', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  // v3.20 是 0.20，用户仍嫌大 ⇒ 必须显著更小
  assertTrue(FX.orbSize < 0.20 * 0.85,
    `orbSize 必须明显小于 0.20，实测 ${FX.orbSize}`);
  assertTrue(FX.orbSize > 0.04, '仍要肉眼可见');
});

test('storm orb: 光晕比核心大（覆盖在光球上），衰减够羽化', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  assertTrue(FX.orbHaloScale > 1.5,
    `光晕必须明显大于核心，实测倍率 ${FX.orbHaloScale}`);
});

test('storm orb: 核心不得再是「实心 + 亮轮廓边」（发光鸡蛋的两个成因）', async () => {
  const { STORM_LANCE_FX: FX } = await import('../render/storm-lance-config.js');
  // ① 基础 alpha（整球不透明 ⇒ 实心蛋）必须压到很低
  assertTrue(FX.orbBaseAlpha <= 0.06,
    `核心基础 alpha 必须 <=0.06（旧 0.2 ⇒ 实心蛋），实测 ${FX.orbBaseAlpha}`);
  // ② rim 提亮权重（轮廓边比中心亮 ⇒ 硬边）必须大幅降低
  assertTrue(FX.orbRimAlpha <= 0.25,
    `rim 的 alpha 权重必须 <=0.25（旧 0.9 ⇒ 亮轮廓边），实测 ${FX.orbRimAlpha}`);
  // ③ 噪声沿法线位移（把球捏成蛋形）必须减小
  assertTrue(FX.orbTurbulence <= 0.12,
    `法线位移必须 <=0.12（旧 0.24 ⇒ 蛋形凹凸），实测 ${FX.orbTurbulence}`);
});

test('storm renderer: 蓄力时核心与光晕都可见，静默期都隐藏', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
  assertTrue(!!r.haloMesh, '渲染器必须持有 haloMesh');
  assertEqual(r.haloMesh.visible, false, '空闲时光晕必须隐藏');
  assertEqual(r.orbMesh.visible, false, '空闲时核心必须隐藏');
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1000);
  assertEqual(r.orbMesh.visible, true, '蓄力时核心可见');
  assertEqual(r.haloMesh.visible, true, '蓄力时光晕可见');
  // 光晕必须比核心大（世界尺度）
  assertTrue(r.haloMesh.scale.x > r.orbMesh.scale.x * 1.5,
    `光晕尺度必须 >核心×1.5，实测 halo ${r.haloMesh.scale.x} vs orb ${r.orbMesh.scale.x}`);
  // 静默期（progress=0）两者都必须熄灭
  r.setCharge(0, null, null, 1100);
  assertEqual(r.orbMesh.visible, false);
  assertEqual(r.haloMesh.visible, false);
  r.dispose();
});

test('storm renderer: mesh 数 7（新增光晕层），dispose 清空', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const scene = new THREE.Scene();
  const r = new StormLanceRenderer({ scene, haloTexture: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
  assertEqual(r.meshes.length, 7, '六个 pass + 蓄力光晕 = 7');
  assertEqual(scene.children.length, 7);
  for (const m of r.meshes) assertEqual(m.visible, false, `${m.name} 空闲必须隐藏`);
  r.dispose();
  assertEqual(scene.children.length, 0);
});

test('storm halo: billboard 靠写入相机四元数（照火球分工）', async () => {
  const res = await fetch(new URL('../render/storm-lance-renderer.js', import.meta.url));
  const src = await res.text();
  assertTrue(src.includes('setCharge(progress, origin, side, nowMs, cameraQuat'),
    'setCharge 必须收 cameraQuat（渲染器不持有相机，由装配层传入）');
  assertTrue(src.includes('this.haloMesh.quaternion.copy(cameraQuat)'),
    '必须把相机朝向写进光晕 ⇒ 永远正对镜头');
  const g = await fetch(new URL('../core/game.js', import.meta.url));
  const gs = await g.text();
  assertTrue(gs.includes('this.camera.quaternion'),
    '装配层必须真的传了相机四元数（否则光晕是一张斜卡片）');
});

// ------------------------------------------------ ⑥ 蓄力球换色（v3.21 R4）
//
// 用户：「蓄力球跟 storm lance 一样，也就是说，蓄力的动作是完全一样的」
// ⇒ **同一个球、同一套尺寸/呼吸/吸入粒子**，只换颜色。不得新建第二个球 mesh。

test('cinder orb: warm=1 时球仍可见且**尺寸与冷蓝态逐位相同**（R4）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: tex(), warmHaloTexture: tex() });
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1000, null, 0);
  const coldOrb = r.orbMesh.scale.x;
  const coldHalo = r.haloMesh.scale.x;
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1000, null, 1);
  assertTrue(r.orbMesh.visible, '暖色态核心仍须可见');
  assertTrue(r.haloMesh.visible, '暖色态光晕仍须可见');
  assertClose(r.orbMesh.scale.x, coldOrb, 1e-12, '核心尺寸不得因换色而变');
  assertClose(r.haloMesh.scale.x, coldHalo, 1e-12, '光晕尺寸不得因换色而变');
  r.dispose();
});

test('cinder orb: warm 真的改了颜色（uniform 与光晕贴图两侧都要）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const cold = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const warm = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: cold, warmHaloTexture: warm });
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1000, null, 0);
  assertEqual(r.uniforms.uWarm.value, 0, '冷蓝态 uWarm=0');
  assertEqual(r.haloMesh.material.map, cold, '冷蓝态用冷色光晕贴图');
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1100, null, 1);
  assertEqual(r.uniforms.uWarm.value, 1, '暖橙态 uWarm=1');
  assertEqual(r.haloMesh.material.map, warm,
    '光晕是**贴图**不是 shader ⇒ 换色必须真的换 map（只改 uniform 拓不到它）');
  r.dispose();
});

test('cinder orb: 缺省 warm 参数时逐位回到 v3.20 行为（向后兼容）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const cold = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: cold });
  // 既有五参调用（spec 与装配层都这么写）
  r.setCharge(0.6, [0, 5, 0], [1, 0, 0], 1000);
  assertEqual(r.uniforms.uWarm.value, 0, '不传第六参 ⇒ 冷蓝（v3.20 行为）');
  assertEqual(r.haloMesh.material.map, cold);
  r.dispose();
});

test('cinder orb: 第二段起步（p2=0）不得闪断 —— 尺寸进度取 max(p1,p2)', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const r = new StormLanceRenderer({ scene: new THREE.Scene(), haloTexture: tex(), warmHaloTexture: tex() });
  // 第二秒末：p1=1
  r.setCharge(1, [0, 5, 0], [1, 0, 0], 2000, null, 0);
  const before = r.orbMesh.scale.x;
  // 第三秒首帧：p2 恰好是 0。若直接拿它当尺寸进度，球会**闪断一下**（静默观感缺陷）。
  // 装配层传 max(p1,p2)=1 ⇒ 尺寸不变。
  r.setCharge(Math.max(1, 0), [0, 5, 0], [1, 0, 0], 2016, null, 1);
  assertTrue(r.orbMesh.visible, '第二段起步时球不得消失');
  assertTrue(r.orbMesh.scale.x > before * 0.8, '尺寸不得塌下去');
  r.dispose();
});

test('cinder orb: 换色不新增 mesh（仍是 7 个，两个球必然漂移）', async () => {
  const THREE = await import('three');
  const { StormLanceRenderer } = await import('../render/storm-lance-renderer.js');
  const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const scene = new THREE.Scene();
  const r = new StormLanceRenderer({ scene, haloTexture: tex(), warmHaloTexture: tex() });
  assertEqual(r.meshes.length, 7, '不得为暖色态另开一个球/光晕 mesh');
  assertEqual(scene.children.length, 7);
  r.dispose();
});
