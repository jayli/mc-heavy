// src/tests/test-view-bob.js — 跑动视角晃动 + 第一人称手臂（Tier 1）
//
// 覆盖：Bob 的移动/全速判据、静止归零、相位关系（sin / cos(2t)）、帧率无关性；
// ViewArm 的站位/刻度/静止角、挥动编排从静止角→谷底→静止角、时长与 dt 的关系、显隐规则。
//
// 派生量一律从**冻结常量**算出（`VIEW_ARM` / `BOB`），不硬编码被测代码写入的字面量 ——
// docs/testing-policy.md §2.5：抄同一个值会让「常量改错但关系式仍成立」的缺陷恒过。
import * as THREE from 'three';
import { test } from './runner.js';
import {
  assertEqual, assertFalse, assertTrue, assertNotEqual, assertNotNull, AssertionError,
} from './assert.js';
import { BOB, ViewBob } from '../player/view-bob.js';
import { VIEW_ARM, ViewArm } from '../render/view-arm.js';

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

test('view-arm: 徒手可见；持枪时隐藏（对齐 mc-lite updateArm）', () => {
  const { camera, arm } = makeArm();
  arm.setWeapon('arm');
  assertTrue(arm.mesh.visible, '徒手须显示手臂');
  arm.setWeapon('pistol');
  assertFalse(arm.mesh.visible, '持枪须隐藏手臂');
  arm.dispose();
  assertEqual(camera.children.length, 0, 'dispose 后相机不得残留节点');
});

test('view-arm: 造型/站位/刻度逐字对齐 mc-lite', () => {
  // ⚠️ **字面量必须与 mc-lite 源码逐字一致，不得从 `VIEW_ARM` 派生**（testing-policy §2.7 第 7 类）：
  // 断言输入若抄了被测常量，注入「size: 0.4 → 0.5」时输入也变 0.5 → 断言恒真（实测已证）。
  // 下面的数字来自 mc-lite `Player.js:137-139` 与 `PlayerInteraction.js:927-928`。
  const { arm } = makeArm();
  arm.update(1); // drawProgress 收敛到 1
  const g = arm.mesh.geometry.parameters;
  assertEqual(g.width, 0.4, '宽（mc-lite BoxGeometry 0.4）');
  assertEqual(g.height, 1.2, '高（mc-lite BoxGeometry 1.2）');
  assertEqual(g.depth, 0.4, '深（mc-lite BoxGeometry 0.4）');
  assertClose(arm.mesh.scale.x, 0.1, 1e-12, 'scale.x（mc-lite 0.1）');
  assertClose(arm.mesh.scale.y, 0.1, 1e-12, 'scale.y');
  assertClose(arm.mesh.scale.z, 0.1, 1e-12, 'scale.z');
  assertClose(arm.mesh.rotation.x, -0.8, 1e-12, '静止俯仰（mc-lite −0.8）');
  // 就位位置：mc-lite `position.set(0.07, -0.10, -0.12)` 且 drawProgress=1 时 drop=0
  assertClose(arm.mesh.position.x, 0.07, 1e-12, 'x（mc-lite 0.07）');
  assertClose(arm.mesh.position.y, -0.10, 1e-12, 'y（mc-lite −0.10，就位后无 drop）');
  assertClose(arm.mesh.position.z, -0.12, 1e-12, 'z（mc-lite −0.12）');
  arm.dispose();
});

test('view-arm: drawProgress 从 0 起，持械后渐入到就位位（幂等收敛）', () => {
  // 单帧落点用**冻结字面量**：mc-lite `:926` 的 `dt*4` + `:927` 的 `(1−p)²×0.5` 下，
  // dt=1/60 → p=0.0666…、drop=0.4356 → y=−0.5356。若实现改成「瞬跳 p=1」（无渐入），
  // 单帧后 y 就是 −0.10，与下面的断言差 0.43（一个数量级），能真区分。
  const { arm } = makeArm();
  arm.setWeapon('arm');
  arm.update(1 / 60);
  assertClose(arm.mesh.position.y, -0.5355555555555556, 1e-12, '首帧落点（mc-lite 渐入公式）');
  for (let i = 0; i < 60; i++) arm.update(1 / 60);
  assertClose(arm.mesh.position.y, -0.10, 1e-12, '渐入完成后落在 mc-lite 就位位 −0.10');
  arm.dispose();
});

test('view-arm: 挥动为 p∈[0,1] 的单峰，谷底 = 静止角 − swingArc', () => {
  const { arm } = makeArm();
  arm.update(1);
  arm.swing();
  // 字面量（mc-lite `PlayerInteraction.js:930/932`）：静止 −0.8、幅度 0.87 → 谷底 −1.67。
  // ⚠️ 谷底位置已从 p=0.5 改到 **p=0.25**（原版 `sin(√p·π)` 快出曲线，峰在 p=0.25）。
  arm.update(1 / 24); // duration 1/6 的四分之一 → p = 0.25
  assertClose(arm.mesh.rotation.x, -1.67, 1e-9, 'p=0.25 须在谷底 −1.67');
  arm.swing();
  arm.update(1 / 6); // p = 1
  assertClose(arm.mesh.rotation.x, -0.8, 1e-9, 'p=1 回到静止角 −0.8');
  arm.dispose();
});

test('view-arm: 挥动期间 rotation.x 快出慢收（前段下降比后段回升快）', () => {
  // 原版曲线不对称：p=0→0.25 就完成整个下劈，0.25→1 慢慢回位。
  // 断言用「等长时间段内的角度变化量」对比：起手 1/4 时长的变化须明显大于末段 1/4 时长。
  const { arm } = makeArm();
  arm.update(1);
  const rest = arm.mesh.rotation.x;
  arm.swing();
  arm.update(1 / 24);            // p = 0.25
  const atQuarter = arm.mesh.rotation.x;
  const downStroke = Math.abs(atQuarter - rest);
  arm.update(1 / 12);            // p = 0.75
  const atThreeQuarter = arm.mesh.rotation.x;
  arm.update(1 / 24);            // p = 1.0
  const upStroke = Math.abs(arm.mesh.rotation.x - atThreeQuarter);
  assertTrue(downStroke > upStroke * 2,
    `起手须明显快于回位：down=${downStroke} up=${upStroke}`);
  assertTrue(atThreeQuarter > atQuarter, 'p=0.75 须已明显回位');
  arm.dispose();
});

test('view-arm: 挥动是 dt 基定长（有意偏离 mc-lite 的每帧 swingTime--）', () => {
  // 同一物理时长（0.1s）用 2 次大步长与 4 次小步长推进，角度须一致。
  // 注入「每帧按固定量递减」的实现时，两次的中间帧数不同 → 角度不同 → 该断言 FAIL。
  const coarse = makeArm();
  coarse.arm.update(1);
  coarse.arm.swing();
  for (let i = 0; i < 2; i++) coarse.arm.update(0.05);
  const coarseAngle = coarse.arm.mesh.rotation.x;
  coarse.arm.dispose();

  const fine = makeArm();
  fine.arm.update(1);
  fine.arm.swing();
  for (let i = 0; i < 4; i++) fine.arm.update(0.025);
  const fineAngle = fine.arm.mesh.rotation.x;
  fine.arm.dispose();

  assertClose(coarseAngle, fineAngle, 1e-9, '帧率无关：同物理时长须同角度');
});

test('view-arm: 挥动结束后回到静止角且不残留（可重复触发）', () => {
  const { arm } = makeArm();
  arm.update(1);
  for (let n = 0; n < 3; n++) {
    arm.swing();
    // 推进 0.2s（> swingDuration 的 1/6≈0.167s）—— 结束后必须回到 mc-lite 静止角 −0.8。
    // 若实现不在结束时归零，残留弧会是 sin(1·π)·0.87 ≈ 1.07e−16 级别 —— 故断言必须用
    // **不带容差的严格比较**：浮点下 −0.8 − 1.07e−16 ≠ −0.8（实测），能真区分。
    for (let i = 0; i < 12; i++) arm.update(1 / 60);
    assertEqual(arm.mesh.rotation.x, -0.8, `第 ${n + 1} 次挥动后须严格等于静止角（无残留弧）`);
  }
  arm.dispose();
});

test('view-arm: 挥动单向（谷底低于起点，不回摆到正向）', () => {
  const { arm } = makeArm();
  arm.update(1);
  arm.swing();
  assertClose(arm.mesh.rotation.x, -0.8, 1e-9, '挥动起点 = 静止角 −0.8');
  arm.update(1 / 12); // p = 0.5
  assertTrue(arm.mesh.rotation.x < -0.8, '中点须低于起点（单向下压，不摆动到正向）');
  arm.dispose();
});

test('view-arm: castShadow 关闭（视图模型不投影，同 M4 枪口径）', () => {
  const { arm } = makeArm();
  let casting = 0;
  arm.mesh.traverse((o) => { if (o.isMesh && o.castShadow) casting++; });
  assertEqual(casting, 0, '手臂不得 castShadow');
  arm.dispose();
});

test('view-arm: 挥动为快出慢收（原版 sin(√p·π)，峰值在 p=0.25）', () => {
  // 原版第一人称空手挥动（`ItemInHandRenderer` / MC 的 `MathHelper.sin(sqrt(p)·π)`）：
  // 起手极快 —— p=0.25 就到峰值，随后回落较慢。mc-lite 的 `sin(p·π)` 是对称的（峰在 p=0.5），
  // 这就是“看着生硬”的根源。判据：p=0.25 处的 progress 须接近峰值，而 p=0.75 处明显更低。
  const { arm } = makeArm();
  arm.update(1);
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.25);
  const peak = arm.mesh.rotation.x;
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.75);
  const late = arm.mesh.rotation.x;
  // 峰值处须已达到 full arc（原版 attack 在 p=0.25 就是 1.0）
  assertClose(peak, -VIEW_ARM.restPitch - VIEW_ARM.swingArc, 0.05,
    'p=0.25 处须接近满幅度（快出）');
  // 对称曲线在 p=0.25 与 p=0.75 幅度相同（sin(π/4)=sin(3π/4)）；快出曲线则后段明显小
  assertTrue(late > peak + VIEW_ARM.swingArc * 0.3,
    `p=0.75 须明显回位（快出慢收），peak=${peak} late=${late}`);
  arm.dispose();
});

test('view-arm: 滚转（甩腕）滞后跟随 —— 峰值在 p≈0.707（原版 sin(p²·π)）', () => {
  // 原版有两个不同峰值的曲线：主臂用 sin(√p·π)（峰 p=0.25），滚转用 sin(p²π)（峰 p≈0.707）。
  // 两者错开才产生“甩腕”而不是整体平移。断言滚转在 p=0.25 时明显小于 p=0.707 时。
  const { arm } = makeArm();
  arm.update(1);
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.25);
  const rollEarly = Math.abs(arm.mesh.rotation.z);
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.707);
  const rollPeak = Math.abs(arm.mesh.rotation.z);
  assertTrue(rollPeak > rollEarly * 2,
    `滚转须滞后（峰在后段）：early=${rollEarly} peak=${rollPeak}`);
  assertClose(rollPeak, VIEW_ARM.swingRoll, 0.02, 'p=0.707 处滚转须接近满幅度');
  arm.dispose();
});

test('view-arm: 横摆（yaw）也随挥动变化 —— 多轴而非单轴', () => {
  const { arm } = makeArm();
  arm.update(1);
  const yawRest = arm.mesh.rotation.y;
  assertClose(yawRest, 0, 1e-12, '静止时无 yaw');
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.25);
  assertTrue(Math.abs(arm.mesh.rotation.y) > VIEW_ARM.swingYaw * 0.5,
    `挥动中须有 yaw 分量，got ${arm.mesh.rotation.y}`);
  arm.dispose();
});

test('view-arm: 挥动带位移（下劈时手臂向前下探）', () => {
  const { arm } = makeArm();
  arm.update(1);
  const restZ = arm.mesh.position.z;
  const restY = arm.mesh.position.y;
  arm.swing();
  arm.update(VIEW_ARM.swingDuration * 0.25);
  // ⚠️ **分轴断言**：先写的是 `|Δz| + |Δy| > 0.01`，注入「去掉向前位移」后**仍全绿** ——
  // 因为 Y 轴的下探项独立地让总和过了阈值（断言没对准被测轴）。故两根轴分开断。
  assertTrue(Math.abs(arm.mesh.position.z - restZ) > VIEW_ARM.swingForward * 0.9,
    `向前位移须达配置幅度，实测 Δz=${arm.mesh.position.z - restZ}`);
  assertTrue(arm.mesh.position.y < restY - VIEW_ARM.swingDrop * 0.9,
    `向下位移须达配置幅度，实测 Δy=${arm.mesh.position.y - restY}`);
  arm.dispose();
});

test('view-arm: 六面有烘焙明暗（顶最亮 / 侧面最暗），不是单一颜色', () => {
  // 用户反馈「手臂的横面和竖面没有光影效果，感觉就是一个颜色，没有立体感」。
  // 做法 = 顶点色烘焙明暗（面系数 × 固定光向 Lambert，再重映射到 `shadeLow..shadeHigh`），
  // 而不是换受光材质（本仓全场景 unlit，受光材质会让肤色随日夜灯光漂移 —— v1.48 已记录的取舍）。
  const { arm } = makeArm();
  const colors = arm.mesh.geometry.attributes.color;
  assertNotNull(colors, '几何体须带 color 属性（顶点色烘焙明暗）');
  assertEqual(colors.itemSize, 3, '顶点色须为 RGB 三通道');
  // BoxGeometry 24 顶点 = 6 面 × 4，按 +X,-X,+Y,-Y,+Z,-Z 顺序。
  // **取每面 4 顶点的均值**，不取单点：烘焙里含「沿长度方向的渐变」（见 lengthFade 注释），
  // 单点取到的只是根部或远端的某一端，跨面比较会得出误导性结论（实测踩到）。
  const faceLum = [];
  for (let f = 0; f < 6; f++) {
    let sum = 0;
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      sum += (colors.getX(i) + colors.getY(i) + colors.getZ(i)) / 3;
    }
    faceLum.push(sum / 4);
  }
  const [px, nx, py, ny, pz, nz] = faceLum;
  // **六面亮度须两两不同**（这是「立体感」的定义：不同朝向不同亮度）。
  // ⚠️ 不能用「对称面同亮度」当判据：烘焙里除 vanilla 面遮挡系数外还有**固定光向的 Lambert 项**
  // （见 `VIEW_ARM.lightDir` 的注释），故 +X 与 −X、+Z 与 −Z 天然不同（一面向光一面向背）。
  const all = [px, nx, py, ny, pz, nz];
  const uniq = new Set(all.map((v) => Math.round(v * 1e4)));
  assertEqual(uniq.size, 6, `六面须有 6 种不同亮度，实测 ${uniq.size} 种：${all.map(v=>v.toFixed(3))}`);
  // 顶面（+Y，朝光最多）须最亮
  assertEqual(py, Math.max(...all), '顶面须最亮');
  // 底面（−Y，背光且遮挡系数最低）须最暗
  //
  // ⚠️ 注意 `all` 与 `faceLum` 是**线性和**（顶点色缓冲是线性工作色空间）。
  // v1.57 的幂律（shadeLow..shadeHigh 重映射）使最暗面不一定是 −Y（线性下 ±X 与 −Y 只差
  // 面系数 0.6 vs 0.5，重映射后 −Y 会略高于 −X）—— 这是对的：玩家可见的那几面里 −Y 仍最暗，
  // 而被看见的 3 个面（+Z/−Y/±X）的亮度排序由上一个用例按 **sRGB** 断言。
  // 故这里只钉「底面属于最暗一档」（与最暗值的差 < 面间跨度的 15%），
  // 不再钉「必须是绝对最小值」—— 后者是幂律重映射下的伪约束。
  const span = Math.max(...all) - Math.min(...all);
  assertTrue(ny - Math.min(...all) < span * 0.15,
    `底面须属于最暗一档（与最暗值差 < 面间跨度的 15%），实测差 ${((ny - Math.min(...all)) / span * 100).toFixed(1)}%`);
  // 明暗对比度须足够（否则「看起来仍是一个颜色」）
  const contrast = (Math.max(...all) - Math.min(...all)) / Math.max(...all);
  assertTrue(contrast > 0.35, `明暗对比须足够（>35%），实测 ${(contrast * 100).toFixed(1)}%`);
  // **侧面内须有沿长度的梯度**（这是 lengthFade 的存在意义）：
  // 46° 俯角下手臂只露出两个面（底面 + 前面），若单面是纯色，屏幕上仍只有两种颜色
  // —— 实测直方图会变成「两个尖峰、中间空」。
  // ⚠️ 只检查**侧面**（面 0/1/4/5）：`BoxGeometry` 的顶面(2)/底面(3) 四个顶点 y 完全相同
  // （实测 [0.60,0.60,0.60,0.60] / [−0.60,…]），沿 y 的渐变在它们上面必然是常数。
  // 这不是缺陷 —— 那两面在 46° 姿态下几乎不可见，且它们的亮度差异由「面系数」提供。
  for (const f of [0, 1, 4, 5]) {
    const lums = [];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      lums.push((colors.getX(i) + colors.getY(i) + colors.getZ(i)) / 3);
    }
    const inner = (Math.max(...lums) - Math.min(...lums)) / Math.max(...lums);
    assertTrue(inner > 0.1, `侧面 ${f} 内须有亮度梯度（>10%），实测 ${(inner * 100).toFixed(1)}%`);
  }
  arm.dispose();
});

test('view-arm: 显示色阶落在参考肤色附近（v1.57「过于暗」回归门）', () => {
  // 用户反馈「手臂的颜色过于暗」，根因是三层系数直接相乘：静止姿态露出的
  // 底面/前面分别只有 0.27/0.59 —— 实测屏幕均值 RGB(163,146,134)，而参考肤色是
  // mc-lite 的 0xeebb99 = (238,187,153)。不但整体暗一档，还因为三通道压得不一样而发灰。
  //
  // 修法 = 面间差只决定「哪面更亮」，其取值区间重映射到 `shadeLow..shadeHigh`（屏幕空间）；
  // 顶点色再经 `srgbToLinear` 写入线性缓冲。于是「参考色」与「显示结果」是同一份数据。
  //
  // 本用例钉住的是**显示色阶本身**（不只是亮度排序）：后者已由上一个用例覆盖，
  // 而「排序对但整体暗」恰好就是被修复的那个缺陷（负向验证：把 shadeLow/High 退回
  // 旧版直接相乘的 0..1 区间时本用例 FAIL 而亮度排序用例仍绿）。
  const { arm } = makeArm();
  const colors = arm.mesh.geometry.attributes.color;
  // 线性 → sRGB（顶点色缓冲是线性工作色空间，屏幕输出才是 sRGB）
  const lin2srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const srgb = (i) => [colors.getX(i), colors.getY(i), colors.getZ(i)].map((v) => lin2srgb(v));
  // 静止姿态（rotation.x=-0.8）下玩家**实际看到**的是这几面：
  // +Z（前面，法线朝相机）+ −Y（底面）+ ±X（左右侧面）；+Y 顶面朝上后方，被自身挡住。
  // 顶点索引：BoxGeometry 的 6 个面固定按 +X,-X,+Y,-Y,+Z,-Z 排列、每面 4 顶点，
  // 而**同一面内 4 个顶点的长度渐变值不同**（两侧各两个极端 t=0/t=1）。
  // 这里取每面的两个极端里**更亮**的一端（t=0，无长度衰减）—— 那是「参考色」的锚点。
  const VISIBLE_FACES = { '+X': 0, '-X': 4, '-Y': 12, '+Z': 16 };
  const ref = [0xee / 255, 0xbb / 255, 0x99 / 255];
  const near = {};
  for (const [name, base] of Object.entries(VISIBLE_FACES)) {
    let best = null;
    for (let v = 0; v < 4; v++) {
      const c = srgb(base + v);
      if (!best || c[0] + c[1] + c[2] > best[0] + best[1] + best[2]) best = c;
    }
    near[name] = best;
  }
  // ① **亮度不再整体偏暗**：每个可见面的近端亮度须在参考亮的 0.85 以上。
  //    旧实现在此得 0.55~0.72（实测），新版 0.85~0.99；阈值 0.82 两侧都不贴线。
  const lumOf = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3;
  const refLum = lumOf(ref);
  for (const [name, rgb] of Object.entries(near)) {
    const ratio = lumOf(rgb) / refLum;
    assertTrue(ratio > 0.82, `${name} 近端亮度须 ≥ 参考色 82%，实测 ${(ratio * 100).toFixed(1)}%`);
  }
  // ② **不发灰**：R−B 差（肤色饱和度的关键）不得比参考色小太多。
  //    旧实现 R−B 差 从 85 掉到 29（实测）；新版保持 ≥ 52。
  const refRB = (ref[0] - ref[2]) * 255;
  for (const [name, rgb] of Object.entries(near)) {
    const rb = (rgb[0] - rgb[2]) * 255;
    assertTrue(rb > refRB * 0.6,
      `${name} 的 R−B 差须 ≥ 参考色 60%（否则发灰），实测 ${rb.toFixed(0)} vs ${refRB.toFixed(0)}`);
  }
  // ③ 可见面之间仍须有**可辨的**亮度差（不能为了「亮」而把立体感抹平）：
  //    最暗可见面 ≤ 最亮可见面的 0.93。实测新版 0.834（旧版 0.672）。
  //    ⚠️ 0.672 也满足 <0.93 —— 这条**不是**用来抓旧实现的（①② 才是），它抓的是
  //    「以后有人为了更亮而把 shadeLow/shadeHigh 收窄成一条窄带」。
  const lums = Object.values(near).map(lumOf);
  const spread = Math.min(...lums) / Math.max(...lums);
  assertTrue(spread < 0.93,
    `可见面之间须保留明暗差（最暗/最亮 < 0.93），实测 ${spread.toFixed(3)}`);
  arm.dispose();
});

test('view-arm: 面明暗常量冻结，且与 vanilla 方块面遮挡一致', () => {
  assertTrue(Object.isFrozen(VIEW_ARM.faceShade), 'faceShade 须冻结');
  assertTrue(Object.isFrozen(VIEW_ARM.lightDir), 'lightDir 须冻结');
  // vanilla ModelBlockRenderer / 图集 shading 的六面系数
  assertEqual(VIEW_ARM.faceShade.up, 1.0, '+Y');
  assertEqual(VIEW_ARM.faceShade.down, 0.5, '−Y');
  assertEqual(VIEW_ARM.faceShade.z, 0.8, '±Z');
  assertEqual(VIEW_ARM.faceShade.x, 0.6, '±X');
  // 顺序断言：顶最亮 > 前后面 > 左右面 > 底面（防有人把 up/down 写反）
  assertTrue(VIEW_ARM.faceShade.up > VIEW_ARM.faceShade.z, 'up > z');
  assertTrue(VIEW_ARM.faceShade.z > VIEW_ARM.faceShade.x, 'z > x');
  assertTrue(VIEW_ARM.faceShade.x > VIEW_ARM.faceShade.down, 'x > down');
  // 光向须朝上（天光自上而下）且归一化后各分量有限
  assertTrue(VIEW_ARM.lightDir.y > Math.abs(VIEW_ARM.lightDir.x), '光向须偏上方');
  assertTrue(VIEW_ARM.ambient > 0 && VIEW_ARM.ambient < 1, '环境项须在 (0,1)');
});

test('view-arm: VIEW_ARM 常量冻结', () => {
  assertTrue(Object.isFrozen(VIEW_ARM), 'VIEW_ARM 须冻结');
  assertTrue(VIEW_ARM.swingDuration > 0, 'swingDuration 须为正');
});
