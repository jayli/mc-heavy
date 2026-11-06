// src/tests/test-block-hit-fx.js — 枪击方块命中特效（Tier 1：纯函数与曲线）
//
// 覆盖「改坏了肉眼看不出来」的部分：三种枪各自的碎块数量/速度/尺寸区间、碎块抛物线、
// 白闪包络、加特林「热度」累积的衰减。
//
// ⚠️ **GPU 侧证明不了**（实例矩阵/颜色、白闪立方体的透明度都在 GPU）→ 由
// `tests/block-hit-fx.spec.mjs` 的 Tier 4 像素实测兜住：主判据是**击石头与击草，碎屑
// 屏幕区域的颜色显著不同**（证明「按方块材质取色」真的到了 GPU），外加「MAG7 只有白闪、
// 不出碎块」与「白闪自己会消失」的门控对照。
//
// 本文件的职责是钉住**算术与区间**，负向锚点（注入退化实现须真 FAIL）放在每条断言的
// 注释里说明。
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertNotNull, assertNull, assertUndefined,
} from './assert.js';
import * as THREE from 'three';
import {
  IMPACT_FX, IMPACT_PROFILES, impactProfile, impactPosition, blockCenter, debrisCountFor,
  createDebrisSeeds, debrisOffset, debrisSizeAt, debrisSpinAngle, whiteFlashOpacityAt,
  staggerTimes, heatDecay,
  // v2.64：宿主实体死亡爆散（丧尸）
  DEATH_BURST, createDeathBurstSeeds, BlockHitFxRenderer,
} from '../render/block-hit-fx.js';

/** 确定性 LCG：同一 seed 产出同一序列（特效是随机的，测试必须可复现） */
function makeRand(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// ---------- 配置目录 ----------

test('impact profile: 三种枪各有 profile，徒手与未知武器为 null', () => {
  assertNotNull(impactProfile('pistol'));
  assertNotNull(impactProfile('minigun'));
  assertNotNull(impactProfile('mag7'));
  assertNull(impactProfile('arm'));
  assertNull(impactProfile('shotgun-x'));
});

test('impact profile: 手枪与加特林出碎块，MAG7 一件碎块都不出（用户 2026-10-23 拍板）', () => {
  const pistol = impactProfile('pistol');
  const minigun = impactProfile('minigun');
  const mag7 = impactProfile('mag7');
  // 尺寸下界：碎块边长须肉眼可见（方块 = 1）—— 实测踩坑：早期取 0.055~0.11，在 6 格外的
  // 游戏画面里几乎看不到（碎块飞散像没发生）。这条把「太小」钉成回归。
  assertTrue(pistol.size[0] > 0.1, `手枪碎块边长须肉眼可见：${pistol.size[0]}`);
  assertTrue(pistol.debrisCount > 0, '手枪须出碎块');
  assertTrue(minigun.debrisCount > 0, '加特林须出碎块');
  // 负向锚点：给 MAG7 配 debrisCount > 0（或退回旧的 16 块）会让这三条 FAIL。
  assertEqual(mag7.debrisCount, 0);
  assertEqual(mag7.dustCount, 0);
  // MAG7 不再是「更大的碎块」：profile 里不该留 size/speed/spin 这些碎块字段
  // （留着就是死字段，改碎块参数时会被误以为生效）。
  assertUndefined(mag7.size);
  assertUndefined(mag7.speed);
  assertUndefined(mag7.spin);
});

test('impact profile: 冲击波环与球形闪光已移除（MAG7 只剩白闪）', () => {
  // 用户 2026-10-23：「把手枪和机枪的闪光球形改掉」「MAG7 的碎片散落与光晕扩散去掉」。
  // 负向锚点：任何一把枪重新声明 ring / flashScale / flashLifeMs 都会让这条 FAIL ——
  // 它们是**已删除的渲染层**的字段，留着会让读者以为那一层还在。
  for (const id of ['pistol', 'minigun', 'mag7']) {
    const profile = impactProfile(id);
    assertUndefined(profile.ring);
    assertUndefined(profile.ringRadius);
    assertUndefined(profile.flashScale);
    assertUndefined(profile.flashLifeMs);
    assertUndefined(profile.flashColor);
  }
});

test('impact profile: 白闪节奏由单一常量给出，保持段短于淡出段总时长', () => {
  const { holdMs, totalMs } = IMPACT_FX.whiteFlash;
  assertTrue(holdMs > 0, `纯白保持段须为正：${holdMs}`);
  assertTrue(totalMs > holdMs, `总时长 ${totalMs} 须长于保持段 ${holdMs}`);
  // 白闪必须远短于碎块寿命：否则「闪」会盖住碎块飞散的全过程（观感变成「一块白板」）。
  assertTrue(totalMs < IMPACT_FX.debris.lifeMs / 2,
    `白闪 ${totalMs}ms 须远短于碎块寿命 ${IMPACT_FX.debris.lifeMs}ms`);
  // 旧的球形闪光/面闪/冲击波参数已移除（负向锚点：留着会让「还有那一层」的错觉复活）
  assertUndefined(IMPACT_FX.flash);
  assertUndefined(IMPACT_FX.faceFlash);
  assertUndefined(IMPACT_FX.shockwave);
});

// ---------- 命中点 ----------

test('impact position: 命中点 = 块中心 + 法线 × 0.5（贴在命中面上）', () => {
  const top = impactPosition([2, 0, 0], [0, 1, 0]);
  assertEqual(top[0], 2.5);
  assertEqual(top[1], 1);    // 0 + 0.5 + 0.5（顶面）
  assertEqual(top[2], 0.5);
  const west = impactPosition([2, 0, 0], [-1, 0, 0]);
  assertEqual(west[0], 2);   // 2 + 0.5 − 0.5（西面）
  assertEqual(west[1], 0.5);
  // 法线缺失（例如测试里手工构造的 target）→ 退回块中心，不产出 NaN
  const none = impactPosition([2, 0, 0], null);
  assertEqual(none[0], 2.5);
  assertEqual(none[1], 0.5);
  assertEqual(none[2], 0.5);
});

test('block center: 白闪落在块中心（不是命中面上，也不是朝外偏半格）', () => {
  const c = blockCenter([2, 7, -3]);
  assertEqual(c[0], 2.5);
  assertEqual(c[1], 7.5);
  assertEqual(c[2], -2.5);
  // 负向锚点：误用 `impactPosition` 会让白立方贴到命中面上（半个方块偏移）
  assertFalse(c[0] === impactPosition([2, 7, -3], [-1, 0, 0])[0]);
});

// ---------- 碎块 ----------

test('debris seeds: 数量与 profile 一致，同 rand 可复现，异 rand 有差异', () => {
  const profile = impactProfile('pistol');
  const a = createDebrisSeeds(profile, [0, 1, 0], makeRand(7));
  const b = createDebrisSeeds(profile, [0, 1, 0], makeRand(7));
  const c = createDebrisSeeds(profile, [0, 1, 0], makeRand(99));
  assertEqual(a.length, profile.debrisCount);
  // 可复现（负向锚点：把 rand 写死成常量会让这条 FAIL）
  assertEqual(JSON.stringify(a), JSON.stringify(b));
  // 但不同 rand 必须真的不同（负向锚点：忽略 rand 直接返回固定表会让这条 FAIL）
  assertFalse(JSON.stringify(a) === JSON.stringify(c));
});

test('debris seeds: 全部碎块朝法线外侧飞（不穿进方块内部）', () => {
  for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const seeds = createDebrisSeeds(impactProfile('pistol'), normal, makeRand(3));
    for (const s of seeds) {
      // 法线方向分量必须为正 —— 负向锚点：方向只按「球面均匀」取会让某些法线整簇 FAIL
      assertTrue(dot(s.velocity, normal) > 0,
        `法线 ${normal} 的碎块速度 ${s.velocity} 须朝外`);
    }
  }
});

test('debris seeds: 速度/尺寸/自旋落在 profile 区间内且不是同一份拷贝', () => {
  const profile = impactProfile('pistol');
  const seeds = createDebrisSeeds(profile, [0, 1, 0], makeRand(11));
  const speeds = new Set();
  for (const s of seeds) {
    const speed = Math.hypot(s.velocity[0], s.velocity[1], s.velocity[2]);
    assertTrue(speed >= profile.speed[0] - 1e-9 && speed <= profile.speed[1] + 1e-9,
      `速度 ${speed} 须落在 [${profile.speed[0]}, ${profile.speed[1]}]`);
    assertTrue(s.size >= profile.size[0] - 1e-9 && s.size <= profile.size[1] + 1e-9,
      `尺寸 ${s.size} 须落在 [${profile.size[0]}, ${profile.size[1]}]`);
    assertTrue(s.spinRate >= profile.spin[0] - 1e-9 && s.spinRate <= profile.spin[1] + 1e-9);
    speeds.add(speed.toFixed(4));
  }
  // 负向锚点：所有碎块用同一个速度会让这条 FAIL
  assertTrue(speeds.size > 1, '碎块速度须有差异');
});

test('debris offset: 起点为零，受重力下坠', () => {
  const seed = { velocity: [0, 2, 0], spinRate: 3, size: 0.1, spinAxis: [1, 0, 0], tone: 1 };
  const at0 = debrisOffset(seed, 0);
  assertEqual(at0[0], 0);
  assertEqual(at0[1], 0);
  assertEqual(at0[2], 0);
  // 初速向上 2 m/s：50ms 仍在上方，寿命末段已明显低于起点（负向锚点：不加重力会让第二条 FAIL）
  const early = debrisOffset(seed, 50);
  const late = debrisOffset(seed, IMPACT_FX.debris.lifeMs);
  assertTrue(early[1] > 0, `50ms 时应仍在起点上方，实得 y=${early[1]}`);
  assertTrue(late[1] < early[1], `末段须已下坠：${early[1]} → ${late[1]}`);
  assertTrue(late[1] < 0, `末段应低于起点，实得 y=${late[1]}`);
});

test('debris size: 前段保持，末段收缩到 0（收尾靠缩零，不用透明排序）', () => {
  const seed = { size: 0.12 };
  assertEqual(debrisSizeAt(seed, 0), 0.12);
  const beforeShrink = debrisSizeAt(seed, IMPACT_FX.debris.lifeMs * IMPACT_FX.debris.shrinkFrom - 1);
  assertTrue(Math.abs(beforeShrink - 0.12) < 1e-9, `收缩前须保持原尺寸，实得 ${beforeShrink}`);
  const mid = debrisSizeAt(seed, IMPACT_FX.debris.lifeMs * 0.9);
  assertTrue(mid < 0.12 && mid > 0, `收缩段须变小且未消失，实得 ${mid}`);
  assertTrue(debrisSizeAt(seed, IMPACT_FX.debris.lifeMs * 1.01) === 0, '到期须归零');
});

test('debris spin: 自旋角随时间线性增长（到期前不为常数）', () => {
  const seed = { spinRate: 5 };
  assertEqual(debrisSpinAngle(seed, 0), 0);
  assertTrue(debrisSpinAngle(seed, 100) > 0);
  assertTrue(debrisSpinAngle(seed, 200) > debrisSpinAngle(seed, 100));
});

// ---------- 白闪 ----------

test('white flash stagger: 多格白闪按索引在 staggerMs 内均匀铺开（不周一时刻出现）', () => {
  // 用户 2026-10-23：「每个方块消失过程中设定一个定时器，不要同一时刻消失，
  // 比如用 600ms 的时间依次让应该消失的方块白闪后消失」—— 该时长后被实玩反馈下调为 150ms。
  // 本条测纯函数算术（参数注入），波浪用哪个时长由配置决定。
  const times = staggerTimes(40, 600, 1000);
  assertEqual(times.length, 40);
  assertEqual(times[0], 1000, '第一个必须在命中瞬间出现（否则命中感失真）');
  assertEqual(times[39], 1600, '最后一个落在 now + staggerMs');
  // 严格递增（负向锚点：全部用 now 会让这条 FAIL —— 即用户抱怨的「同一时刻消失」）
  for (let i = 1; i < times.length; i++) {
    assertTrue(times[i] > times[i - 1], `启动时刻须递增：${times[i - 1]} → ${times[i]}`);
  }
  // 均匀：相邻间隔恒定
  const gap = times[1] - times[0];
  for (let i = 2; i < times.length; i++) {
    assertTrue(Math.abs(times[i] - times[i - 1] - gap) < 1e-9, '间隔须均匀');
  }
});

test('white flash stagger: 配置值为 150ms（用户 2026-10-23 由 600ms 下调，嫌太慢）', () => {
  // ⚠️ 这是**实玩标定值**，不是推导值：600ms 的波浪被用户判为「太慢」→ 150ms。
  // 负向锚点：改回 600 会让 Tier 4 的波浪用例（以及本条）FAIL。
  assertEqual(IMPACT_FX.whiteFlash.staggerMs, 150);
  // 波浪总跨度（最后一格完全消失）= staggerMs + totalMs。150 + 150 = 300ms，
  // 必须短于一次 MAG7 装填间隔（cooldown 1.5s），否则连发时波浪会叠在一起。
  assertTrue(IMPACT_FX.whiteFlash.staggerMs + IMPACT_FX.whiteFlash.totalMs < 1500,
    '波浪全跨度须短于 MAG7 冷却');
  // 与单格白闪寿命同量级：40 格摊开后每格仅隔 ~3.8ms → 观感是「一大片同时变白、边缘略有先后」
  const gapPerCell = IMPACT_FX.whiteFlash.staggerMs / 39;
  assertTrue(gapPerCell > 0 && gapPerCell < IMPACT_FX.whiteFlash.totalMs,
    `每格间隔 ${gapPerCell.toFixed(2)}ms 须短于单格白闪寿命`);
});

test('white flash stagger: 边界 —— 0/1 格、staggerMs=0 都不产 NaN', () => {
  assertEqual(staggerTimes(0, 600, 1000).length, 0);
  // 只有一格时不能除以 n-1=0
  const one = staggerTimes(1, 600, 1000);
  assertEqual(one.length, 1);
  assertEqual(one[0], 1000);
  // staggerMs=0 → 全部同一时刻（退化为旧行为，但不崩）
  const zero = staggerTimes(3, 0, 1000);
  assertTrue(zero.every((t) => t === 1000), `staggerMs=0 须全部等于 now，实得 ${zero}`);
});

test('white flash: 先满白再淡出，到期 done 且 opacity 归 0', () => {
  const { holdMs, totalMs } = IMPACT_FX.whiteFlash;
  // 命中瞬间必须是**满白**（用户原话「让被击中的方块变成白色闪一下」）——
  // 负向锚点：写成「一开始就淡出」会让这条 FAIL。
  assertEqual(whiteFlashOpacityAt(0).opacity, 1);
  assertEqual(whiteFlashOpacityAt(holdMs - 1).opacity, 1);
  // 淡出段：单调下降且严格落在 (0,1)
  let prev = 1;
  for (const p of [0.1, 0.3, 0.5, 0.8]) {
    const age = holdMs + (totalMs - holdMs) * p;
    const v = whiteFlashOpacityAt(age).opacity;
    assertTrue(v < prev, `淡出须单调下降：${prev} → ${v}（age=${age}）`);
    assertTrue(v > 0, `淡出段内不得归零（会读成「闪断成两截」）：age=${age}`);
    prev = v;
  }
  const end = whiteFlashOpacityAt(totalMs);
  assertEqual(end.done, true);
  assertEqual(end.opacity, 0);
});

test('white flash: 返回值是复用对象（每帧每 slot 调用，不得分配）', () => {
  const out = { opacity: 0, done: false };
  const got = whiteFlashOpacityAt(10, out);
  assertTrue(got === out, '须写入调用方提供的对象并返回它');
});

// ---------- 加特林热度 ----------

test('heat: 逐发累积并在停火后衰减到 0，碎块数量随热度增加', () => {
  const profile = impactProfile('minigun');
  const base = debrisCountFor(profile, 0);
  assertEqual(base, profile.debrisCount);
  const hot = debrisCountFor(profile, 1);
  assertTrue(hot > base, `热度满时碎块须更多：${base} → ${hot}`);
  // 钳制（负向锚点：不钳会让超界热度产出荒诞数量）
  assertEqual(debrisCountFor(profile, 5), hot);
  // 衰减：单调下降且 1.5 秒后归零
  const half = heatDecay(1, IMPACT_FX.heat.decayMs * 0.5);
  assertTrue(half < 1 && half > 0, `半衰期须落在 (0,1)，实得 ${half}`);
  assertEqual(heatDecay(1, IMPACT_FX.heat.decayMs), 0);
  assertEqual(heatDecay(0.4, 0), 0.4);
});

test('heat: 手枪与 MAG7 不吃热度（只有加特林是连续火力）', () => {
  const pistol = impactProfile('pistol');
  assertFalse(pistol.heat === true);
  assertTrue(impactProfile('minigun').heat === true);
  assertFalse(impactProfile('mag7').heat === true);
  // 非热度武器：无论热度多高，碎块数量恒定
  assertEqual(debrisCountFor(pistol, 1), pistol.debrisCount);
  // MAG7 恒 0（即便有人错误地给它开 heat，也不该产出碎块）
  assertEqual(debrisCountFor(impactProfile('mag7'), 1), 0);
});

// ---------- 配置自身的完整性 ----------

test('impact fx: 目录递归冻结，渲染层不得改写', () => {
  assertTrue(Object.isFrozen(IMPACT_FX));
  assertTrue(Object.isFrozen(IMPACT_FX.debris));
  assertTrue(Object.isFrozen(IMPACT_FX.whiteFlash));
  assertTrue(Object.isFrozen(IMPACT_PROFILES));
  assertTrue(Object.isFrozen(IMPACT_PROFILES.pistol.speed));
});

test('impact fx: 白闪池容量须装得下一次 MAG7 的全部格（否则尾部白闪静默丢失）', () => {
  // MAG7 扫描上限 40 格 —— 池小于它时，尾部那些格子会无处可放。
  // 去向：`_spawnWhiteFlash` 的 `?? this._flashSlots[0]` 回退会把**第一格**提前杀掉，
  // 观感是「扩散到一半就没了」。
  assertTrue(IMPACT_FX.whiteFlash.maxActive >= 40,
    `白闪池 ${IMPACT_FX.whiteFlash.maxActive} 须 >= MAG7 的 40 格上限`);
});

// ==================== v2.64：宿主实体死亡爆散（丧尸） ====================
//
// 用户 2026-11-07：「丧尸被击杀的时候是直接消失……我希望加一个丧尸死亡消失的特效」，
// 裁定形态 = **绿色碎块爆散**（复用本文件的碎块池，不开新渲染器/新池）。
//
// ⚠️ **与枪击碎块的关键差别是方向分布**：枪击碎块以命中面法线为轴取**半球**（永远朝被打的
// 那一面外飞，不穿进方块内部）；死亡爆散没有「命中面」这个概念 —— 丧尸是**整体炸开**，
// 必须**全球面**（上下左右都有碎块）。只撒半球的缺陷形态是「碎块全朝天上飞」或「全朝地里钻」，
// 而 `spawnDeathBurst` 照常返回、池照常推进 ⇒ 单看「有碎块出现」的断言抓不到。
// 故下面第二条用例直接钉「vy 有正有负」。

test('death burst: 数量与配置一致，同 rand 可复现，异 rand 有差异', () => {
  const a = createDeathBurstSeeds(makeRand(11));
  const b = createDeathBurstSeeds(makeRand(11));
  const c = createDeathBurstSeeds(makeRand(12));
  assertEqual(a.length, DEATH_BURST.count, '数量取配置（不得写死字面量）');
  assertEqual(JSON.stringify(a), JSON.stringify(b), '可复现（rand 必须真的被消费）');
  assertFalse(JSON.stringify(a) === JSON.stringify(c), '异 rand 必须真的不同');
  // 显式 count 覆盖（渲染器/测试用）
  assertEqual(createDeathBurstSeeds(makeRand(11), 5).length, 5);
});

test('death burst: 全球面爆散（vy 有正有负），不是半球', () => {
  const seeds = createDeathBurstSeeds(makeRand(3), 64);
  let up = 0;
  let down = 0;
  for (const s of seeds) {
    assertTrue(Number.isFinite(s.velocity[0]) && Number.isFinite(s.velocity[1])
      && Number.isFinite(s.velocity[2]), '速度不得出现 NaN');
    const len = Math.hypot(...s.velocity);
    assertTrue(len > 0.1, `初速不得近零（碎块会原地不动）：${len}`);
    assertTrue(len <= DEATH_BURST.speed[1] * 1.001, `初速不得超上界：${len}`);
    if (s.velocity[1] > 0) up += 1;
    if (s.velocity[1] < 0) down += 1;
  }
  // 负向锚点：只对一个半球撒（例如恒用 +Y 法线）会让 down === 0 → 本条 FAIL。
  assertTrue(up >= 8 && down >= 8,
    `全球面覆盖：向上 ${up} / 向下 ${down}（只撒半球会有一侧为 0）`);
  // 水平方向也要铺开（不能全在竖直轴上）
  const horiz = seeds.filter((s) => Math.hypot(s.velocity[0], s.velocity[2]) > 0.5).length;
  assertTrue(horiz >= seeds.length * 0.5, `水平铺开：${horiz}/${seeds.length}`);
});

test('death burst: 碎块尺寸肉眼可见，且配置递归冻结', () => {
  assertTrue(DEATH_BURST.size[0] > 0.1,
    `碎块边长须肉眼可见（方块=1）：${DEATH_BURST.size[0]}`);
  assertTrue(DEATH_BURST.size[1] >= DEATH_BURST.size[0], '尺寸区间上下界不得倒置');
  assertTrue(DEATH_BURST.speed[1] > DEATH_BURST.speed[0], '速度区间上下界不得倒置');
  assertTrue(DEATH_BURST.count > 0, '至少出一块（0 = 特效静默不发生）');
  assertTrue(DEATH_BURST.count <= IMPACT_FX.debris.maxActive,
    `一次爆散须装得进碎块池（${DEATH_BURST.count} <= ${IMPACT_FX.debris.maxActive}），否则自己覆盖自己`);
  assertTrue(Object.isFrozen(DEATH_BURST));
  assertTrue(Object.isFrozen(DEATH_BURST.size));
});

test('death burst: 渲染器入口真的把碎块推进池（并置可见）', () => {
  const scene = new THREE.Scene();
  const fx = new BlockHitFxRenderer({ scene });
  try {
    assertEqual(fx.activeDebrisCount, 0, '前置：池空');
    assertFalse(fx.debrisMesh.visible, '前置：空闲池不得提交渲染（draw call 基线）');

    fx.spawnDeathBurst([10, 20, 30], [0.25, 0.42, 0.19], 1000);
    assertEqual(fx.activeDebrisCount, DEATH_BURST.count, '碎块全部入池');
    assertTrue(fx.debrisMesh.visible, '有碎块时必须可见');

    // 推进到寿命末尾 → 全部回收、池回到不可见（draw call 回基线）
    fx.update(1000 + IMPACT_FX.debris.lifeMs + 1);
    assertEqual(fx.activeDebrisCount, 0, '到期必须全部回收（不得泄漏 slot）');
    assertFalse(fx.debrisMesh.visible, '回收后回到不可见');
  } finally {
    fx.dispose();
  }
});

test('death burst: 池满时覆盖最旧，不抛异常也不静默丢弃新的', () => {
  const scene = new THREE.Scene();
  const fx = new BlockHitFxRenderer({ scene });
  try {
    // 连爆到超过池容量（一发 TNT 炸死一群丧尸 / 机枪连杀都会走到这里）
    const rounds = Math.ceil(IMPACT_FX.debris.maxActive / DEATH_BURST.count) + 2;
    for (let i = 0; i < rounds; i++) fx.spawnDeathBurst([i, 0, 0], [0.2, 0.5, 0.2], 1000 + i);
    assertTrue(fx.activeDebrisCount <= IMPACT_FX.debris.maxActive,
      `活跃数不得超过池容量：${fx.activeDebrisCount}`);
    assertTrue(fx.activeDebrisCount > 0, '池满时仍要有碎块在飞（不得整批丢弃）');
  } finally {
    fx.dispose();
  }
});
