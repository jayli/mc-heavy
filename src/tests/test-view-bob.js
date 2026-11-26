// src/tests/test-view-bob.js — 跑动视角晃动 + 第一人称手臂（Tier 1）
//
// 覆盖：Bob 的移动/全速判据、静止归零、相位关系、帧率无关性；
// ViewArm（**v3.46 整体照抄 OpusCraft / vanilla**）的几何与 UV 契约、
// 11 步变换链的**相机空间锚点**、挥动编排、步态 bob、显隐规则。
//
// ⚠️ **判据不落在欧拉角上**：变换链是 11 步右乘复合，`mesh.rotation` 是 decompose
// 出来的等价欧拉角（随旋转序变化，同一姿态有多种表示）—— 钉它等于钉一个派生量。
//
// 派生量一律从**冻结常量**算出（`VIEW_ARM` / `BOB` / `VIEW_BOB`）；
// 而**上游字面量（几何尺寸 / UV 矩形 / 时长）反过来必须写死**，不从被测常量派生
//（docs/testing-policy.md §2.7 第 7 类：抄同一个值会让注入缺陷时断言恒真）。
import * as THREE from 'three';
import { test } from './runner.js';
import {
  assertEqual, assertFalse, assertTrue, assertNotEqual, assertNotNull,
  assertUndefined, AssertionError,
} from './assert.js';
import { BOB, ViewBob } from '../player/view-bob.js';
import { VIEW_ARM, ViewArm, ARM_POSE, PLAYER_SKIN_UV } from '../render/view-arm.js';
import { VIEW_BOB } from '../render/view-bob-config.js';

/** 浮点比较（sin/cos 与指数收敛无法精确等于字面量） */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

/**
 * 跑 n 帧。
 * @param {ViewBob} bob
 * @param {number} dt 秒
 * @param {number} n
 * @param {{dx?:number, dz?:number, input?:number}} [motion]
 *        `dx/dz` = 本帧**实际**位移；`input` = 玩家意图水平速度（格/秒）。
 *        缺省时按「全速顺畅移动」构造（实际位移 = 意图速度 × dt）。
 */
function run(bob, dt, n, motion = {}) {
  const speed = motion.input ?? 8;
  const dx = motion.dx ?? speed * dt;
  const dz = motion.dz ?? 0;
  for (let i = 0; i < n; i++) bob.update(dt, { dx, dz, inputSpeed: speed });
}

function makeArm() {
  const camera = new THREE.PerspectiveCamera();
  const arm = new ViewArm({ camera });
  return { camera, arm };
}

// ------------------------------------------------------------------ Bob

test('view-bob: 静止（无位移）时偏移恒 0 且相位归零', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 60, { dx: 0, dz: 0, input: 0 });
  assertEqual(bob.offset.x, 0, '静止时 x 偏移须为 0');
  assertEqual(bob.offset.y, 0, '静止时 y 偏移须为 0');
  assertEqual(bob.timer, 0, '静止时相位须归零（不得冻结在上一个相位）');
  assertEqual(bob.amount, 0, '静止时振幅须收敛到 0');
});

test('view-bob: 刚起步当帧即产生非零振幅（渐入从 0 起，非恒 0）', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 1);
  assertTrue(bob.amount > 0, `首帧振幅须 > 0，got ${bob.amount}`);
  assertTrue(bob.amount < BOB.intensity, '首帧振幅须小于目标值（渐入而非瞬跳）');
});

test('view-bob: 全速移动 1s 后振幅趋近 intensity，且不超过它', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 60);
  assertClose(bob.amount, BOB.intensity, BOB.intensity * 0.15,
    '1s 后振幅须接近 intensity');
  assertTrue(bob.amount <= BOB.intensity + 1e-12,
    `振幅不得超过 intensity，got ${bob.amount}`);
});

test('view-bob: 相位由**走过的距离**驱动（不是时间）—— 对齐原版 walkDist 口径', () => {
  // 原版：`walkDist += 0.6 × 水平位移`，`phase = walkDist × π` → 相位只取决于走了多远。
  // 这正是「晃动节奏自动贴合步伐」的机制：走慢则晃慢，不需要任何速度分支。
  // 断言：同样的**距离**、不同的帧率/步长 → 相位必须一致。
  const dt = 1 / 60;
  const dist = 0.5; // 每帧走 0.5 格
  const a = new ViewBob();
  for (let i = 0; i < 10; i++) a.update(dt, { dx: dist, dz: 0, inputSpeed: 8 });
  const b = new ViewBob();
  for (let i = 0; i < 20; i++) b.update(dt / 2, { dx: dist / 2, dz: 0, inputSpeed: 8 });
  assertClose(a.timer, b.timer, 1e-12, '同距离须同相位（与帧率/步长无关）');
  assertClose(a.timer, 10 * dist * BOB.phasePerBlock, 1e-9, '相位 = 总距离 × phasePerBlock');
});

test('view-bob: 相位推进帧率无关（过零次数与平均偏移在 60Hz/120Hz 下一致）', () => {
  // ⚠️ **不能断言两个帧率下某一时刻的 offset 相等**：`offset` 是一阶指数平滑的输出（
  // mc-lite `PlayerInteraction.js:899` 同式），其离散化误差天然是 O(dt) —— 实测 60Hz 与
  // 120Hz 的瞬时 offset 相差约 3~5%（正确实现下也如此），那不是缺陷。
  // 故钉住两个**严格帧率无关**的派生量：
  //   ① 过零次数 = sin 相位跑过的周期数，只取决于 `speed × 物理时长`（与帧率无关）；
  //   ② 采样序列的 |offset| 平均值。
  // 实测判别力（5s 窗口）：正确实现 crossings 18/18、avgAbs 相对差 0.14%；
  // 注入「相位每帧 +speed」（帧率依赖缺陷形态）后 crossings 18/37、avgAbs 相对差 23.7%。
  const SECONDS = 5;
  const collect = (dt) => {
    const bob = new ViewBob();
    const xs = [];
    const n = Math.round(SECONDS / dt);
    for (let i = 0; i < n; i++) {
      bob.update(dt, { dx: 8 * dt, dz: 0, inputSpeed: 8 });
      xs.push(bob.offset.x);
    }
    let crossings = 0;
    for (let i = 1; i < xs.length; i++) {
      if ((xs[i - 1] < 0) !== (xs[i] < 0)) crossings++;
    }
    const avgAbs = xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length;
    return { crossings, avgAbs };
  };
  const a = collect(1 / 60);
  const b = collect(1 / 120);
  assertEqual(a.crossings, b.crossings, '过零次数（相位周期数）须帧率无关');
  assertClose(a.avgAbs, b.avgAbs, a.avgAbs * 0.02, 'offset 平均幅度须帧率无关');
  // 前提断言：确实在振荡（防「两侧都是 0 次过零」使上面的相等断言恒真）
  assertTrue(a.crossings >= 4, `窗口内须确实振荡，got ${a.crossings} 次过零`);
  assertTrue(a.avgAbs > BOB.intensity * 0.2, `平均幅度须非零，got ${a.avgAbs}`);
});

test('view-bob: 位移公式为原版口径（x=sin φ·bob·0.5、y=−|cos φ|·bob）', () => {
  // φ = distance × phasePerBlock（原版 phase = walkDist×π）。
  // 用一个大步长把 φ 精确推到 π/2：sin=1 → x 达正峰；|cos|=0 → y 回到 0。
  const bob = new ViewBob();
  const dt = 1 / 60;
  const dist = (Math.PI / 2) / BOB.phasePerBlock;
  bob.update(dt, { dx: dist, dz: 0, inputSpeed: 8 });
  assertClose(bob.timer, Math.PI / 2, 1e-9, '相位须落在 π/2');
  assertTrue(bob.amount > 0, '单步大 dt 下振幅须已累积');
  // t=π/2：sin=1、|cos|=0
  assertTrue(bob.offset.x > 0, `t=π/2 时 x 须为正，got ${bob.offset.x}`);
  // ⚠️ 单步后 offset 只是**朝目标值走了一步**（一阶平滑，k = 1−0.7^3.6 ≈ 0.3），
  // 不等于目标值。故断言「方向一致 + 严格小于目标」（不许越过），不用等式。
  const targetX = Math.sin(bob.timer) * bob.amount * BOB.lateralRatio;
  assertTrue(bob.offset.x < targetX, `x 须朝目标收敛（未越过），actual=${bob.offset.x} target=${targetX}`);
  assertTrue(bob.offset.x > targetX * 0.2, `x 须明显朝目标推进，actual=${bob.offset.x}`);
  // t=π/2 处 |cos|=0 → y 的目标值就是 0；单步后 y 从 0 出发仍是 0（数值零，非负值）
  assertTrue(Math.abs(bob.offset.y) < 1e-12,
    `t=π/2 时 y 须为 0（|cos|=0），got ${bob.offset.y}`);
});

test('view-bob: 静止后偏移在 ~0.5s 内收敛到视觉不可见', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 60);
  run(bob, 1 / 60, 30, { dx: 0, dz: 0, input: 0 });
  assertTrue(Math.abs(bob.offset.x) < 1e-3, `x 须收敛，got ${bob.offset.x}`);
  assertTrue(Math.abs(bob.offset.y) < 1e-3, `y 须收敛，got ${bob.offset.y}`);
});

test('view-bob: 实际位移不足意图速度 95%（撞墙/半速）不累积相位', () => {
  // 期望位移 = 8 格/秒 × dt；实际只走了 50% → 判据不成立 → 相位归零
  const bob = new ViewBob();
  run(bob, 1 / 60, 10, { dx: 8 * (1 / 60) * 0.5, input: 8 });
  assertEqual(bob.timer, 0, '受阻/半速时相位须归零');
  assertEqual(bob.amount, 0, '受阻/半速时振幅须收敛到 0');
});

// ---- walking（脚步声判据，v2.54）----
// 背景：脚步声（`_updateFootsteps`）与镜头晃动（相机 offset）在 v2.51 共用 `active`。
// 但本仓物理有**水中阻力**（`physics.js` 的 `WATER_DRAG = 0.6`，mc-lite 没有）：
// 水中实际位移 = 意图速度 × 0.6 × dt，actual/expected 恒为 0.6 < fullSpeedRatio 0.95
// → `active` 恒 false → 水中脚步声永不播（用户报告：「进入水里行走没有声音」）。
// （当时的 id 是 `running_water`，v3.37 已改名 `running_wet`）
// 修法（用户裁定 2026-11-05：**只让声音响、镜头保持不晃**）：新增 `walking` 标志专供脚步声，
// 全速判据按 drag 折算期望位移；`active`（驱动镜头）保持原判据不动。

test('view-bob: walking 陆地全速为 true，与 active 一致', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 5);
  assertTrue(bob.active, '陆地全速 active 须为 true');
  assertTrue(bob.walking, '陆地全速 walking 须为 true（脚步声判据）');
});

test('view-bob: walking 水中（drag=0.6）为 true，而 active 保持 false（镜头不晃）', () => {
  // 水中物理实测：inputSpeed = SPEED×0.6 = 4.8，实际位移 = 4.8 × 0.6 × dt（drag 再乘一次）。
  // 旧实现 active 用「未折算」的期望位移 → 0.6 < 0.95 恒 false → 脚步声永不播。
  const bob = new ViewBob();
  const dt = 1 / 60;
  const inputSpeed = 8 * 0.6;
  for (let i = 0; i < 5; i++) {
    bob.update(dt, { dx: inputSpeed * 0.6 * dt, dz: 0, inputSpeed, drag: 0.6 });
  }
  assertFalse(bob.active, '镜头判据不变：水中 actual/expected=0.6 < 0.95 → 不晃');
  assertTrue(bob.walking, '脚步声判据按 drag 折算后须为 true（否则水中脚步声永不播）');
});

test('view-bob: walking 水中受阻（实际位移远低于 drag 折算期望）为 false', () => {
  // 下界守卫：drag 折算不是「一律放行」—— 水中撞墙/原地不动时 actual 远低于
  // inputSpeed×drag×dt，walking 必须为 false（否则卡在水里脚步声一直响）。
  const bob = new ViewBob();
  const dt = 1 / 60;
  const inputSpeed = 8 * 0.6;
  for (let i = 0; i < 5; i++) {
    bob.update(dt, { dx: inputSpeed * 0.6 * dt * 0.3, dz: 0, inputSpeed, drag: 0.6 });
  }
  assertFalse(bob.walking, '实际位移仅达折算期望的 30% → 判受阻，脚步声不播');
});

test('view-bob: walking 跳跃中为 false（与 active 同判据）', () => {
  const bob = new ViewBob();
  const dt = 1 / 60;
  for (let i = 0; i < 5; i++) {
    bob.update(dt, { dx: 8 * dt, dz: 0, inputSpeed: 8, jumping: true });
  }
  assertFalse(bob.walking, '跳跃中不得播脚步声');
});

test('view-bob: walking 缺省 drag=1（陆地路径零回归）', () => {
  // 不传 drag 时行为与 active 完全一致（既有调用方不受影响）。
  const bob = new ViewBob();
  run(bob, 1 / 60, 5);
  assertEqual(bob.walking, bob.active, '缺省 drag 时 walking 与 active 同步');
});

test('view-bob: 完全无意图（inputSpeed=0）但有位移不产生晃动', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 10, { dx: 0.5, dz: 0, input: 0 });
  assertEqual(bob.amount, 0, '无输入意图不晃');
  assertEqual(bob.timer, 0, '无输入意图相位归零');
});

test('view-bob: 跳跃期间不晃（垂直载荷交给重力）', () => {
  const bob = new ViewBob();
  for (let i = 0; i < 10; i++) {
    bob.update(1 / 60, { dx: 8 / 60, dz: 0, inputSpeed: 8, jumping: true });
  }
  assertEqual(bob.amount, 0, '跳跃时不累积振幅');
  assertEqual(bob.timer, 0, '跳跃时相位归零');
});

test('view-bob: 水中/减速输入按实际位移判据自动不晃（无独立 speed 分支）', () => {
  // 水中 SPEED×0.6 → 实际位移与意图位移仍匹配 → 照常晃（判据看相对比值，不看绝对速度）
  const bob = new ViewBob();
  run(bob, 1 / 60, 10, { dx: 8 * 0.6 * (1 / 60), input: 8 * 0.6 });
  assertTrue(bob.amount > 0, '减速但位移匹配时仍须晃');
});

test('view-bob: BOB 常量冻结；speed 沿 mc-lite，intensity 为实玩标定值', () => {
  assertTrue(Object.isFrozen(BOB), 'BOB 须冻结');
  // v1.52：相位改距离驱动，`speed`（时间角速度）已不存在，改为 `phasePerBlock`（rad/格）
  assertEqual(BOB.speed, undefined, 'v1.52 起不再有时间角速度字段');
  assertTrue(BOB.phasePerBlock > 0, 'phasePerBlock 须为正');
  assertTrue(BOB.phasePerBlock < 12 / 8, '相位/格 须低于旧实现等效值（旧 12rad/s ÷ 8格/秒 = 1.5）');
  // intensity 是**有意偏离** mc-lite 的 0.05，v1.52 对齐原版的 0.1。
  assertNotEqual(BOB.intensity, 0.05, 'intensity 已偏离 mc-lite 原值');});

test('view-bob: 步频 1.35 Hz（一步 370ms）—— 按实玩逐档放慢，仍快于走路', () => {
  // 推导链（每步都要能复现）：
  //   · 原版口径：一个 bob 周期 = 走过 `2 / 0.6 = 3.3333 格`（phase = walkDist×π，walkDist += 0.6×dist）
  //   · 原版疾跑 5.612 格/秒 → 1.6836 Hz（每步 297ms）← v1.52 采用
  //   · v1.54「步频稍微慢一点」→ 1.5 Hz（每步 333ms）
  //   · **v1.55「再慢一档」→ 1.35 Hz（每步 370ms）**（同档位步长约 +11%）
  //   · 本仓 SPEED = 8 格/秒 → phasePerBlock = 2π × 1.35 / 8 = 1.0603 rad/格
  // ⚠️ 不能照抄原版 3.333 格/周期：那会得到 2.4 Hz（更快），方向与实玩反馈相反。
  const TARGET_HZ = 1.35;
  const SPEED = 8;                                   // = physics.js 的 SPEED
  const dt = 1 / 60;
  const bob = new ViewBob();
  for (let i = 0; i < 60; i++) bob.update(dt, { dx: SPEED * dt, dz: 0, inputSpeed: SPEED });
  const hzFromPhase = (bob.timer / (2 * Math.PI)) / 1.0;   // 1 秒内跑了几个 2π
  assertClose(hzFromPhase, TARGET_HZ, 0.01,
    `频率须为 ${TARGET_HZ}Hz，实测 ${hzFromPhase.toFixed(4)}Hz`);
  // 每步时长（半个周期 = 一步）≈ 370ms
  assertClose(1000 / hzFromPhase / 2, 370, 3, '一步时长');
  // **仍须快于原版走路（1.295Hz）** —— 这是「跑」与「走」的分界，也是本档的下界依据。
  // 余量已收窄到 ~4%：再往下降就会落进走路的节奏里（届时需要重新和用户确认设计意图）。
  const MC_WALK_HZ = 4.317 / (2 / 0.6);
  assertTrue(hzFromPhase > MC_WALK_HZ, `须快于原版走路 ${MC_WALK_HZ.toFixed(3)}Hz`);
  // 且必须慢于上一档 1.5Hz
  assertTrue(hzFromPhase < 1.5, '须慢于上一档 1.5Hz');
  // 换算自洽：phasePerBlock 必须对得上目标频率
  assertClose(BOB.phasePerBlock, (2 * Math.PI * TARGET_HZ) / SPEED, 1e-4,
    'phasePerBlock 须与目标频率自洽');
});

test('view-bob: 振幅口径对齐原版（x ±bob·0.5、y 只向下 |cos|·bob）', () => {
  // 原版：`bob = min(0.1, 水平速度)`（带 0.4 缓动），
  //       `position.x = sin(φ)·bob·0.5`、`position.y = −|cos(φ)|·bob`。
  // 关键差异：**y 只向下**（−|cos| 恒非正）→ 一个周期两次下沉，这才像“脚步落地”。
  // 本仓 `intensity` 承担原版 `bob` 的角色（速度上限 0.1）。
  const dt = 1 / 600;
  const bob = new ViewBob();
  const ys = [];
  const xs = [];
  for (let i = 0; i < 600; i++) {
    bob.update(dt, { dx: 8 * dt, dz: 0, inputSpeed: 8 });
    ys.push(bob.offset.y);
    xs.push(bob.offset.x);
  }
  // y 恒非正（下探），x 双侧对称
  assertTrue(ys.every((v) => v <= 1e-9), `y 须只向下，实测最大值 ${Math.max(...ys)}`);
  assertTrue(ys.some((v) => v < -0.01), 'y 须确实下探');
  assertTrue(xs.some((v) => v > 0.005) && xs.some((v) => v < -0.005), 'x 须双侧摆动');
  // 幅度上界 = 原版口径
  assertTrue(Math.max(...ys.map(Math.abs)) <= BOB.intensity + 1e-9,
    `y 幅度不得超过 intensity（原版 bob 上限），实测 ${Math.max(...ys.map(Math.abs))}`);
  assertTrue(Math.max(...xs.map(Math.abs)) <= BOB.intensity * 0.5 + 1e-9,
    `x 幅度须为 intensity×0.5（原版），实测 ${Math.max(...xs.map(Math.abs))}`);
  // **实际可感幅度**（这才是玩家看到的）：一阶平滑在 1.68Hz 处只通过 ≈0.8976，
  // 故 y 实测峰 ≈ intensity×0.8976，x 峰 ≈ intensity×0.5×0.8976。
  // 断言下界，防止「标称调大但平滑把增幅吃掉」这类静默失效。
  const yPeak = Math.max(...ys.map(Math.abs));
  const xPeak = Math.max(...xs.map(Math.abs));
  assertTrue(yPeak > 0.1, `实际 y 峰须明显可感（>0.1 格），实测 ${yPeak}`);
  assertTrue(xPeak > 0.05, `实际 x 峰须明显可感（>0.05 格），实测 ${xPeak}`);
});

test('view-bob: 晃动强度落在「可感但不钜烈」区间', () => {
  // 历史：mc-lite 原值 0.05 → 「小到看不出来在跑」（v1.49 上调到 0.09）→ 「又太钜烈」
  // （v1.50 回调）。现在须落在两者之间：不能回到看不出的 0.05，也不能是 0.09。
  assertTrue(BOB.intensity > 0.05, `不得回到看不出的量级，got ${BOB.intensity}`);
  // v1.53：用户「再稍微大一点，跑步的感觉不明显」→ 0.1 → 0.13（有意偏离原版 bob 上限 0.1）。
  // v1.57：用户「晃动幅度还不够大，可以稍微大一些」→ 0.13 → **0.15**。
  // ⚠️ 判定口径要扣掉一阶平滑的衰减（1.35Hz 处通过率 ≈ 0.916）：
  //    标称 0.15 时**实际** y 峰只有 ≈ 0.1375，用户感知的是后者而非标称值。
  assertEqual(BOB.intensity, 0.15, 'v1.57 上调后的标定值');
  assertTrue(BOB.intensity > 0.13, `须大于上一档 0.13（用户要求更大），got ${BOB.intensity}`);
  // 上限护栏：再往上会从「在跑」变成「晕」（y 峰已接近眼高的 11%）
  assertTrue(BOB.intensity <= 0.2, `不得越过观感上限 0.2，got ${BOB.intensity}`);
  // v1.51：旋转分量全部归零（用户要求「不要歪头」），平移保留
  assertEqual(BOB.rollAmount, 0, 'roll 须为 0（地平线必须水平）');
  assertEqual(BOB.pitchAmount, 0, 'pitch 须为 0（旋转全部去掉）');
});

test('view-bob: 跑动全程零旋转（roll/pitch 恒为 0，地平线始终水平）', () => {
  // v1.51 用户要求：「跑动的时候镜头始终是水平的……所有镜头晃动的时候不要『歪头』」。
  // roll（绕 Z 轴）会让地平线变斜 —— 这是被明确否掉的体验；pitch 一并归零（用户选了
  // 「旋转全部去掉」）。**平移保留**：位置左右微移不改变任何朝向。
  // 这条是**硬不变式**：只要相位在跑、振幅在涨，两个旋转量就必须逐帧严格为 0。
  const bob = new ViewBob();
  const dt = 1 / 60;
  let maxRoll = 0;
  let maxPitch = 0;
  let sawAmount = 0;
  for (let i = 0; i < 300; i++) {
    bob.update(dt, { dx: 8 * dt, dz: 0, inputSpeed: 8 });
    maxRoll = Math.max(maxRoll, Math.abs(bob.roll));
    maxPitch = Math.max(maxPitch, Math.abs(bob.pitch));
    sawAmount = Math.max(sawAmount, bob.amount);
  }
  // 前提：确实在“跑”（振幅涨到目标值附近）—— 否则「旋转为 0」可能只是因为根本没动
  assertTrue(sawAmount > BOB.intensity * 0.9, `前提：须确实跑起来，got amount=${sawAmount}`);
  assertEqual(maxRoll, 0, '跑动全程 roll 须严格为 0');
  assertEqual(maxPitch, 0, '跑动全程 pitch 须严格为 0');
});

test('view-bob: 静止时旋转仍为 0；平移归零但左右平移本身保留', () => {
  const bob = new ViewBob();
  run(bob, 1 / 60, 60);
  // 跑动中：平移确实发生（保留左右平移的证明），旋转为 0（v1.51 的硬要求）
  assertTrue(Math.abs(bob.offset.x) > 0, '跑动中须有左右平移（这是保留的分量）');
  assertEqual(bob.roll, 0, '跑动中 roll 须为 0');
  assertEqual(bob.pitch, 0, '跑动中 pitch 须为 0');
  run(bob, 1 / 60, 60, { dx: 0, dz: 0, input: 0 });
  assertTrue(Math.abs(bob.offset.x) < 1e-3, `静止后平移须归零，got ${bob.offset.x}`);
  assertEqual(bob.roll, 0, '静止后 roll 仍为 0');
  assertEqual(bob.pitch, 0, '静止后 pitch 仍为 0');
});


// ------------------------------------------------------------------ ViewArm
//
// **v3.46 整体重标**：手臂从 mc-lite 的素色小盒换成 OpusCraft / vanilla 口径
//（4×12×4 像素 + 皮肤贴图 + 11 步变换链）。旧的「静止角 −0.8 / 谷底 −1.67 /
// 顶点色六面明暗 / 参考肤色 0xeebb99」整套判据**描述的是已不存在的实现**，
// 留着对后来者是陷阱 ⇒ 按新口径重写（对照表见设计稿 §4.5）。
//
// ⚠️ **判据落在相机空间坐标与 UV 契约上，不落在欧拉角上**：
// 变换链是 11 步右乘复合，`mesh.rotation` 是 decompose 出来的等价欧拉角 ——
// 它随旋转序变化，且同一个姿态可以有多种欧拉表示。钉欧拉角等于钉一个派生量。

test('view-arm: 徒手可见；持枪时隐藏；dispose 无残留', () => {
  const { camera, arm } = makeArm();
  arm.setWeapon('arm');
  assertTrue(arm.mesh.visible, '徒手须显示手臂');
  arm.setWeapon('pistol');
  assertFalse(arm.mesh.visible, '持枪须隐藏手臂');
  arm.dispose();
  assertEqual(camera.children.length, 0, 'dispose 后相机不得残留节点');
});

test('view-arm: 几何是 vanilla 4×12×4 像素盒 + 袖子（合并成一个 Mesh）', () => {
  // ⚠️ **字面量取自上游 `model.ts:161` 的 cube，不从 VIEW_ARM 派生**（policy §2.7 第 7 类）：
  // 断言输入若抄被测常量，注入「w: 4 → 5」时输入也变 5 → 断言恒真。
  const { arm } = makeArm();
  const pos = arm.mesh.geometry.attributes.position;
  // 手臂 24 顶点 + 袖子 24 顶点 = 48（合并几何，一份材质一个 Mesh）
  assertEqual(pos.count, 48, '手臂 + 袖子共 48 顶点（两个 BoxGeometry 合并）');
  assertNotNull(arm.mesh.geometry.attributes.uv, '须带 UV（皮肤贴图）');
  assertNotNull(arm.mesh.geometry.attributes.color, '须带灰阶顶点色（面间亮度，v3.46b）');

  // 手臂本体（前 24 顶点）的包围盒 = cube/16：x[-3,1]/16, y[-2,10]/16, z[-2,2]/16
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < 24; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  assertClose(x1 - x0, 4 / 16, 1e-6, '手臂宽 = 4px/16 = 0.25 格');
  assertClose(y1 - y0, 12 / 16, 1e-6, '手臂长 = 12px/16 = 0.75 格');
  assertClose(z1 - z0, 4 / 16, 1e-6, '手臂厚 = 4px/16 = 0.25 格');
  assertClose(x0, -3 / 16, 1e-6, '最小角 x = −3px/16');
  assertClose(y0, -2 / 16, 1e-6, '最小角 y = −2px/16');

  // 袖子（后 24 顶点）各向外扩 0.25px ⇒ 每维比手臂大 0.5px/16
  let sx0 = Infinity, sx1 = -Infinity;
  for (let i = 24; i < 48; i++) { sx0 = Math.min(sx0, pos.getX(i)); sx1 = Math.max(sx1, pos.getX(i)); }
  assertClose((sx1 - sx0) - (x1 - x0), 0.5 / 16, 1e-6, '袖子比手臂宽 0.5px/16（inflate 0.25 两侧）');
  assertTrue(sx0 < x0, '袖子须包住手臂（外侧）');
  arm.dispose();
});

test('view-arm: 六面 UV 落在皮肤图内，且手臂/袖子各取自己的段', () => {
  const { arm } = makeArm();
  const uv = arm.mesh.geometry.attributes.uv;
  const S = 64;
  // 全部 UV 必须在 [0,1]（越界会采到别的部件或 wrap 到边缘）
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    assertTrue(u >= 0 && u <= 1 && v >= 0 && v <= 1, `UV[${i}] 越界：(${u},${v})`);
  }
  // 手臂段（前 24）：u ∈ [40,56]/64，v_tex ∈ [1−32/64, 1−16/64] = [0.5, 0.75]
  for (let i = 0; i < 24; i++) {
    const u = uv.getX(i) * S, vPx = (1 - uv.getY(i)) * S;
    assertTrue(u >= 40 - 1e-6 && u <= 56 + 1e-6, `手臂 u 须在 [40,56]，实测 ${u}`);
    assertTrue(vPx >= 16 - 1e-6 && vPx <= 32 + 1e-6, `手臂 v_px 须在 [16,32]，实测 ${vPx}`);
  }
  // 袖子段（后 24）：v_px ∈ [32,48]
  for (let i = 24; i < 48; i++) {
    const vPx = (1 - uv.getY(i)) * S;
    assertTrue(vPx >= 32 - 1e-6 && vPx <= 48 + 1e-6, `袖子 v_px 须在 [32,48]，实测 ${vPx}`);
  }
  arm.dispose();
});

test('view-arm: 侧面几何上端 ↔ 贴图上行（v 轴不翻、前后面不镜像）', () => {
  // ⚠️ 这条抓的是 **v 轴翻转 + 面映射**两个静默失效：
  //   · v 不翻 ⇒ 整条手臂上下颠倒（所有计数判据全绿）；
  //   · front/back 写反 ⇒ 前后两面对调。
  // ⚠️ **v3.46b 后整条都是肤色**（用户裁定），故本条不再靠「袖口在哪一端」判，
  // 而是直接钉 **几何 y ↔ 贴图 v_px 的对应关系**（与配色无关，更稳）。
  const { arm } = makeArm();
  const pos = arm.mesh.geometry.attributes.position;
  const uv = arm.mesh.geometry.attributes.uv;
  const S = 64;
  // 只看手臂本体的四个侧面（|ny| < 0.5），按 y 分成上端/下端两组
  const nor = arm.mesh.geometry.attributes.normal;
  let topMaxV = -Infinity;   // 几何上端顶点的 v_px 最大值
  let bottomMinV = Infinity; // 几何下端顶点的 v_px 最小值
  const yMid = (-2 + 12 / 2) / 16;
  for (let i = 0; i < 24; i++) {
    if (Math.abs(nor.getY(i)) > 0.5) continue;   // 跳过顶/底面
    const vPx = (1 - uv.getY(i)) * S;
    if (pos.getY(i) > yMid) topMaxV = Math.max(topMaxV, vPx);
    else bottomMinV = Math.min(bottomMinV, vPx);
  }
  // 侧面 v_px 跨度 20..32（12 行）；几何上端 ↔ 贴图上行（v_px 小）
  assertClose(topMaxV, 20, 1e-6, '几何上端须对应贴图 v_px=20（侧面起始行）');
  assertClose(bottomMinV, 32, 1e-6, '几何下端须对应贴图 v_px=32（侧面末行）');
  arm.dispose();
});

test('view-arm: 面间亮度是灰阶（只改亮度不改色相）且两可见面拉开', () => {
  /**
   * v3.46b：用户裁定「整条手臂全肤色」后，Tier 4 实测到**78.6% 像素挤在同一
   * 亮度桶、无双峰** —— 即 v1.56「一个颜色、没立体感」的回归。根因：静止姿态下
   * 只有两个面可见（实测屏幕面积 +Z 3.57 / −X 2.09），而两面采同一张贴图
   * ⇒ 面间零明暗差。修法 = 烘焙**灰阶**面间亮度。
   *
   * ⚠️ **灰阶（r=g=b）是载荷性的**：用户要的是「跟手臂一样的色调」，
   * 任何带色偏的系数都会把肤色拉向另一个颜色（旧版 v1.57 那套幂律重映射就改色相）。
   */
  const { arm } = makeArm();
  const colors = arm.mesh.geometry.attributes.color;
  assertNotNull(colors, '几何须带 color 属性（面间亮度）');
  assertEqual(colors.itemSize, 3, '顶点色须为 RGB 三通道');
  // ① **逐顶点严格灰阶**
  for (let i = 0; i < colors.count; i++) {
    const r = colors.getX(i), g = colors.getY(i), b = colors.getZ(i);
    assertTrue(r === g && g === b,
      `顶点 ${i} 须是灰阶（不改色相），实测 (${r},${g},${b})`);
    assertTrue(r > 0.5 && r <= 1.0, `面亮度须在 (0.5,1]（不发黑），实测 ${r}`);
  }
  // ② **静止姿态的两个可见面（+Z 与 −X）须拉开**。
  // 实测屏幕面积 +Z 3.57 / −X 2.09，其余四面被几何自身挡住
  // ⇒ 它俩的差就是玩家能看到的全部立体感。
  const nor = arm.mesh.geometry.attributes.normal;
  const shadeOf = (pred) => {
    for (let i = 0; i < 24; i++) {
      if (pred(nor.getX(i), nor.getY(i), nor.getZ(i))) return colors.getX(i);
    }
    return null;
  };
  const pz = shadeOf((x, y, z) => z > 0.5);
  const nx = shadeOf((x) => x < -0.5);
  assertNotNull(pz, '需找到 +Z 面');
  assertNotNull(nx, '需找到 −X 面');
  const gap = (pz - nx) / pz;
  // 实测：pz=0.94 / nx=0.78 ⇒ gap 17.0%；阈 10% 两侧都不贴线。
  // 注入「六面同值」⇒ gap=0 ⇒ 真红（那正是本轮实测到的变平形态）。
  assertTrue(gap > 0.10,
    `两可见面亮度差须 > 10%（否则读作一个色块），实测 ${(gap * 100).toFixed(1)}%`);
  // ③ 顶面最亮、底面最暗（vanilla 面遮挡的方向不得写反）
  const py = shadeOf((x, y) => y > 0.5);
  const ny = shadeOf((x, y) => y < -0.5);
  assertTrue(py >= pz && py >= nx, '顶面须最亮');
  assertTrue(ny <= pz && ny <= nx, '底面须最暗');
  arm.dispose();
});

test('view-arm: 静止姿态的相机空间锚点（上游变换链在本仓相机下可直接用）', () => {
  // ⚠️ **锚点是实测值，不是从 VIEW_ARM 算出来的**（policy §2.7 第 7 类）。
  // 来源：复刻上游 11 步链投影手臂盒 8 角（fov 70 / near 0.1）的离线探针，
  // 见设计稿 §4.3 的表。这里判**手端中心**（几何 y 最小端的中心）与**肩端中心**。
  const { arm } = makeArm();
  arm.update(1);   // drawProgress → 1，equip = 0
  const m = new THREE.Matrix4().compose(arm.mesh.position, arm.mesh.quaternion, arm.mesh.scale);
  // 手臂盒局部角：手端 y = −2/16，肩端 y = 10/16；x/z 中心 = (−3+1)/2/16 与 0
  const hand = new THREE.Vector3((-3 + 2) / 16, -2 / 16, 0).applyMatrix4(m);
  const shoulder = new THREE.Vector3((-3 + 2) / 16, 10 / 16, 0).applyMatrix4(m);
  // 实测（swing=0）：整盒 z ∈ [−1.185, −0.438]，全部顶点在近平面之外
  assertTrue(hand.z < -0.1, `手端须在相机前方（z < −0.1），实测 ${hand.z}`);
  assertTrue(shoulder.z < -0.1, `肩端须在相机前方，实测 ${shoulder.z}`);
  assertTrue(hand.z > -1.6 && hand.z < -0.3, `手端 z 须落在实测带 [−1.6,−0.3]，实测 ${hand.z}`);
  // 手臂在**右侧**（相机空间 x > 0）且偏下（y < 0）—— 原版第一人称右手的方位
  assertTrue(hand.x > 0, `右手须在相机空间右侧，实测 x=${hand.x}`);
  assertTrue(hand.y < 0, `右手须偏下，实测 y=${hand.y}`);
  arm.dispose();
});

test('view-arm: 挥动时长 = 上游 6 tick（0.1s），结束严格回位', () => {
  const { arm } = makeArm();
  arm.update(1);
  // 字面量 6/60（上游 `swingDuration()` 返回 6 tick @20tps）
  assertClose(VIEW_ARM.swingDuration, 0.1, 1e-12, '挥动时长须是 6 tick = 0.1s');
  const rest = arm.mesh.position.clone();
  const restQ = arm.mesh.quaternion.clone();
  arm.swing();
  assertEqual(arm.swingProgress, 0, 'swing() 后进度从 0 起');
  arm.update(0.1);
  assertEqual(arm.swingProgress, 1, '一个时长后进度到 1');
  // ⚠️ **逐位回位**（不是「接近」）：上游 swing=1 时四条曲线全部归零，
  // 变换链逐条与 swing=0 相同 ⇒ 矩阵逐位相同。
  assertClose(arm.mesh.position.distanceTo(rest), 0, 1e-12, '结束位置须逐位回到静止');
  assertClose(Math.abs(arm.mesh.quaternion.dot(restQ)), 1, 1e-12, '结束姿态须逐位回到静止');
  arm.dispose();
});

test('view-arm: 挥动中手端向前下方探出（快出曲线，峰值在前半段）', () => {
  const { arm } = makeArm();
  arm.update(1);
  const m = new THREE.Matrix4();
  const handZ = () => {
    m.compose(arm.mesh.position, arm.mesh.quaternion, arm.mesh.scale);
    return new THREE.Vector3((-3 + 2) / 16, -2 / 16, 0).applyMatrix4(m).z;
  };
  const restZ = handZ();
  arm.swing();
  const samples = [];
  // 20 等分采样（每步 0.005s = 时长 1/20）
  for (let i = 1; i <= 20; i++) {
    arm.update(0.1 / 20);
    samples.push({ p: arm.swingProgress, z: handZ() });
  }
  const deepest = samples.reduce((a, b) => (b.z < a.z ? b : a), samples[0]);
  // 手端须真的向前探（z 更负）—— 实测 swing=0.5 时整盒 zMin 从 −1.185 到 −1.533
  assertTrue(deepest.z < restZ - 0.05,
    `挥动须让手端向前探（Δz < −0.05），实测 rest=${restZ} deepest=${deepest.z}`);
  // 快出：峰值在前 60%（上游主摆动 `sin(√p·π)` 峰在 p=0.25，复合后实测偏后一点）
  assertTrue(deepest.p <= 0.6, `前探峰值须在前 60%（快出），实测 p=${deepest.p}`);
  arm.dispose();
});

test('view-arm: 挥动有横摆与甩腕（长轴真的转了，不是单轴下压）', () => {
  /**
   * ⚠️ **判据落在「手臂长轴的朝向」而不是「手端 x 位移」**（本轮实测踩到）：
   * 上游 `f2 = −0.3·sin(√p·π)` 的横向平移在**骨骼空间**，经 11 步链后落到相机空间
   * 只剩 **0.0357 格**（实测）—— 拿 0.05 当阈是假红。而真正读作「挥臂」的是
   * **长轴转向**：实测长轴夹角峰 **58.5°**、水平投影角峰 **69.3°**
   *（对应上游 `rotY(f·sin(√p·π)·70)` 的主摆动 70°）。
   */
  const { arm } = makeArm();
  arm.update(1);
  const m = new THREE.Matrix4();
  const at = (ly) => {
    m.compose(arm.mesh.position, arm.mesh.quaternion, arm.mesh.scale);
    return new THREE.Vector3(-1 / 16, ly, 0).applyMatrix4(m);
  };
  const axis = () => at(10 / 16).sub(at(-2 / 16)).normalize();
  const restAxis = axis();
  const restYaw = Math.atan2(restAxis.x, -restAxis.z);
  arm.swing();
  let maxAngle = 0; let maxYaw = 0; let peakP = 0;
  for (let i = 1; i <= 40; i++) {
    arm.update(0.1 / 40);
    const a = axis();
    const ang = a.angleTo(restAxis);
    if (ang > maxAngle) { maxAngle = ang; peakP = arm.swingProgress; }
    maxYaw = Math.max(maxYaw, Math.abs(Math.atan2(a.x, -a.z) - restYaw));
  }
  // 主摆动：上游 70°，实测长轴夹角峰 58.5° / 水平投影角峰 69.3°
  // 阈取 40°（两侧都不贴线）；注入「去掉 rotY(70°) 那一步」⇒ 长轴只剩 pitch 分量 ⇒ 真红。
  assertTrue(maxAngle > 40 * Math.PI / 180,
    `长轴夹角峰须 > 40°（上游主摆动 70°），实测 ${(maxAngle * 180 / Math.PI).toFixed(1)}°`);
  assertTrue(maxYaw > 40 * Math.PI / 180,
    `长轴水平投影角峰须 > 40°（横摆），实测 ${(maxYaw * 180 / Math.PI).toFixed(1)}°`);
  // 快出：主摆动峰在 p≈0.25（实测 0.27）
  assertTrue(peakP <= 0.45, `横摆峰须在前 45%（sin(√p·π) 峰在 0.25），实测 p=${peakP}`);
  arm.dispose();
});

test('view-arm: drawProgress 从 0 起渐入（equip 下移），完成后就位', () => {
  const { arm } = makeArm();
  arm.setWeapon('arm');
  const y0 = arm.mesh.position.y;
  arm.update(1 / 60);
  const y1 = arm.mesh.position.y;
  assertTrue(y1 > y0, `渐入须让手臂上移（equip 下移量减小），实测 ${y0} → ${y1}`);
  for (let i = 0; i < 60; i++) arm.update(1 / 60);
  const yRest = arm.mesh.position.y;
  arm.update(1 / 60);
  assertClose(arm.mesh.position.y, yRest, 1e-12, '就位后须幂等（不再移动）');
  arm.dispose();
});

test('view-arm: 帧率无关 —— 粗步长与细步长在同一时刻落到同一姿态', () => {
  const coarse = makeArm();
  const fine = makeArm();
  coarse.arm.update(1); fine.arm.update(1);
  coarse.arm.swing(); fine.arm.swing();
  // 粗：2 步 × 0.025s；细：25 步 × 0.002s ⇒ 同为 0.05s（p=0.5）
  for (let i = 0; i < 2; i++) coarse.arm.update(0.025);
  for (let i = 0; i < 25; i++) fine.arm.update(0.002);
  assertClose(coarse.arm.swingProgress, fine.arm.swingProgress, 1e-9, '进度须帧率无关');
  assertClose(coarse.arm.mesh.position.distanceTo(fine.arm.mesh.position), 0, 1e-9,
    '同一时刻位置须帧率无关');
  coarse.arm.dispose(); fine.arm.dispose();
});

test('view-arm: 连续挥动每次都从头开始，不残留上一次的弧', () => {
  const { arm } = makeArm();
  arm.update(1);
  const rest = arm.mesh.position.clone();
  for (let n = 0; n < 3; n++) {
    arm.swing();
    arm.update(VIEW_ARM.swingDuration);
    assertClose(arm.mesh.position.distanceTo(rest), 0, 1e-12,
      `第 ${n + 1} 次挥动后须逐位回到静止（无残留弧）`);
  }
  arm.dispose();
});

test('view-arm: 步态 bob 静止时严格归零，跑动时有位移与滚转', () => {
  const { arm } = makeArm();
  arm.update(1);
  const rest = arm.mesh.position.clone();
  const restQ = arm.mesh.quaternion.clone();
  // amp = 0（静止）⇒ 逐位等于无 bob
  arm.update(1 / 60, { bobPhase: 1.234, bobAmp: 0 });
  assertClose(arm.mesh.position.distanceTo(rest), 0, 1e-12, 'amp=0 时位置须逐位不变');
  assertClose(arm.mesh.quaternion.angleTo(restQ), 0, 1e-12, 'amp=0 时姿态须逐位不变');
  // amp = 1（全速）⇒ 位移与滚转都要发生
  let maxD = 0; let maxAngle = 0;
  for (let i = 0; i < 60; i++) {
    arm.update(1 / 60, { bobPhase: i * 0.2, bobAmp: 1 });
    maxD = Math.max(maxD, arm.mesh.position.distanceTo(rest));
    maxAngle = Math.max(maxAngle, arm.mesh.quaternion.angleTo(restQ));
  }
  // 幅度上界 = 两个平移分量的合成 **+ 滚转绕相机原点的杆臂效应**。
  // ⚠️ **不能只取 hypot(bobX, bobY)**（本轮实测踩到）：bob 的 roll 是绕**相机原点**
  // 转整个手臂，而手臂中心离原点 **1.168 格** ⇒ 额外带来 ≈ 1.168 × 0.018 = 0.021 格
  // 位移。实测总位移峰 **0.0283**，而纯平移上界只有 0.0184 ⇒ 旧阈是假红。
  const restLen = rest.length();
  const bound = Math.hypot(VIEW_ARM.bobX, VIEW_ARM.bobY) + restLen * VIEW_ARM.bobRoll;
  assertTrue(maxD > Math.hypot(VIEW_ARM.bobX, VIEW_ARM.bobY) * 0.5,
    `跑动位移须达平移量级，实测 ${maxD}`);
  assertTrue(maxD <= bound + 1e-9, `跑动位移不得超上界 ${bound}，实测 ${maxD}`);
  assertTrue(maxAngle > VIEW_ARM.bobRoll * 0.5,
    `跑动须有滚转（>${VIEW_ARM.bobRoll * 0.5} rad），实测 ${maxAngle}`);
  assertTrue(maxAngle <= VIEW_ARM.bobRoll + 1e-9,
    `滚转不得超配置上界 ${VIEW_ARM.bobRoll}，实测 ${maxAngle}`);
  arm.dispose();
});

test('view-arm: 步态 y 只向下（脚步落地的观感），x 双侧摆动', () => {
  const { arm } = makeArm();
  arm.update(1);
  const restY = arm.mesh.position.y;
  const restX = arm.mesh.position.x;
  let up = 0; let down = 0; let left = 0; let right = 0;
  for (let i = 0; i < 120; i++) {
    arm.update(1 / 120, { bobPhase: i * 0.1, bobAmp: 1 });
    const dy = arm.mesh.position.y - restY;
    const dx = arm.mesh.position.x - restX;
    if (dy > 1e-9) up++; else if (dy < -1e-9) down++;
    if (dx > 1e-9) right++; else if (dx < -1e-9) left++;
  }
  // 上游 `-|sin(ph)|*bobY*amp` ⇒ y 恒非正
  assertEqual(up, 0, `步态 y 须只向下，实测有 ${up} 帧向上`);
  assertTrue(down > 60, `步态 y 须确实下探，实测 ${down} 帧`);
  // 上游 `cos(ph)*bobX*amp` ⇒ x 双侧
  assertTrue(left > 20 && right > 20, `步态 x 须双侧摆动，实测 左${left}/右${right}`);
  arm.dispose();
});

test('view-arm: 常量冻结，且步态幅度与共享配置同源（红线 1）', () => {
  assertTrue(Object.isFrozen(VIEW_ARM), 'VIEW_ARM 须冻结');
  assertTrue(Object.isFrozen(VIEW_ARM.cube), 'cube 须冻结');
  assertTrue(Object.isFrozen(VIEW_ARM.pivot), 'pivot 须冻结');
  assertTrue(Object.isFrozen(ARM_POSE), 'ARM_POSE 须冻结');
  assertTrue(Object.isFrozen(PLAYER_SKIN_UV.arm), 'UV 表须冻结');
  // ⚠️ **同源断言**：三个视图模型（KV-9 / 手臂 / 剑）共用 VIEW_BOB，
  // 任一处写死字面量都会让这条 FAIL（那是「改一处另两处不跟」的静默漂移）。
  assertEqual(VIEW_ARM.bobX, VIEW_BOB.x, 'bobX 须来自 VIEW_BOB');
  assertEqual(VIEW_ARM.bobY, VIEW_BOB.y, 'bobY 须来自 VIEW_BOB');
  assertEqual(VIEW_ARM.bobRoll, VIEW_BOB.roll, 'bobRoll 须来自 VIEW_BOB');
  // 旧实现的常量必须**真的不存在**（留着就是死字段，改它们不会有任何可见变化）
  assertUndefined(VIEW_ARM.faceShade);
  assertUndefined(VIEW_ARM.lightDir);
  assertUndefined(VIEW_ARM.shadeLow);
  assertUndefined(VIEW_ARM.shadeHigh);
  assertUndefined(VIEW_ARM.lengthFade);
  assertUndefined(VIEW_ARM.restPitch);
  assertUndefined(VIEW_ARM.swingArc);
  assertUndefined(VIEW_ARM.color);
});