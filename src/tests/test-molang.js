// src/tests/test-molang.js — Molang 子集求值器（v2.55 焰魔烘焙期用）
//
// 为什么需要：焰魔素材的待机动画（`generala` / `generalb`）不是数值关键帧，而是
// **Molang 表达式**（`Math.sin(q.life_time * 128) * -2.5`）。飞龙的烘焙器只吃数值
// 关键帧，所以必须有一个能求值表达式的模块。
//
// 设计口径（spec `2026-11-05-ignis-boss-design.md` §4.1）：
//   - **只支持素材里实际出现的 4 个标识符**：`q.life_time`、`q.target_y_rotation`、
//     `q.target_x_rotation`、`Math.sin`；
//   - **未知标识符一律抛错**，不静默回 0 —— 静默回 0 的形态是「巨兽站着不动」，
//     只有实玩才能发现。
//
// Tier 1（纯函数算法）⇒ 必须 TDD。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertThrows } from './assert.js';
import { compileMolang, MolangError } from '../../tools/molang-eval.mjs';

// ==================== 素材里实际出现的表达式 ====================

test('molang: generala 的手臂摆动两条求值', () => {
  // generala: left_arm = Math.sin(q.life_time * 128) * -2.5
  const leftArm = compileMolang('Math.sin(q.life_time * 128) * -2.5');
  // 用一个非零时刻，确保真的走了 sin 求值（t=0 时 sin=0，会掩盖乘法顺序的错误）
  const t = 0.0123;
  // ⚠️ Molang 的 sin 用**度**（v2.56 修正）：期望值要自己乘 π/180
  const deg = (x) => Math.sin(x * Math.PI / 180);
  assertEqual(leftArm({ lifeTime: t }), deg(t * 128) * -2.5);

  // generala: left_hand = 2.5 + Math.sin(q.life_time * 128) * 2.5
  const leftHand = compileMolang('2.5 + Math.sin(q.life_time * 128) * 2.5');
  assertEqual(leftHand({ lifeTime: t }), 2.5 + deg(t * 128) * 2.5);

  // t=0 时 sin(0)=0 ⇒ left_hand = 2.5（常量项不能丢）
  assertEqual(leftHand({ lifeTime: 0 }), 2.5);
});

test('molang: generalb 的带负常量偏移（root 的 y 位移）', () => {
  // generalb: root.position.y = Math.sin(q.life_time * 128 + (-96)) * 0.75
  const f = compileMolang('Math.sin(q.life_time * 128 + (-96)) * 0.75');
  const t = 0.007;
  // ⚠️ Molang 的 sin 用**度**，故期望值要自己换算（v2.56 修正）
  assertEqual(f({ lifeTime: t }), Math.sin((t * 128 - 96) * Math.PI / 180) * 0.75);
});

test('molang: q.target_y_rotation / q.target_x_rotation 读 scope', () => {
  const fy = compileMolang('q.target_y_rotation');
  const fx = compileMolang('q.target_x_rotation');
  assertEqual(fy({ lifeTime: 0, targetYaw: 17.5 }), 17.5);
  assertEqual(fx({ lifeTime: 0, targetPitch: -3.25 }), -3.25);
});

// 烘焙期玩家朝向不可知 ⇒ 这两项按 0 处理（spec §4.2 末段）
test('molang: 缺省的 target 旋转按 0（烘焙期它们不可知）', () => {
  assertEqual(compileMolang('q.target_y_rotation')({ lifeTime: 0 }), 0);
  assertEqual(compileMolang('q.target_x_rotation')({ lifeTime: 0 }), 0);
});

// ==================== 算术与语法 ====================

test('molang: 四则运算与优先级', () => {
  assertEqual(compileMolang('1 + 2 * 3')({}), 7);       // 乘法优先
  assertEqual(compileMolang('(1 + 2) * 3')({}), 9);     // 括号
  assertEqual(compileMolang('10 - 2 - 3')({}), 5);      // 左结合
  assertEqual(compileMolang('8 / 2 / 2')({}), 2);       // 左结合
});

test('molang: 一元负号（含连续负号与负数字面量）', () => {
  assertEqual(compileMolang('-5')({}), -5);
  assertEqual(compileMolang('- -5')({}), 5);
  assertEqual(compileMolang('3 * -2')({}), -6);
  assertEqual(compileMolang('-(1 + 2)')({}), -3);
});

test('molang: 小数字面量与科学计数', () => {
  assertEqual(compileMolang('0.5')({}), 0.5);
  assertEqual(compileMolang('1e2')({}), 100);
  assertEqual(compileMolang('2.5e-1')({}), 0.25);
});

// ==================== 不支持的写法必须抛错（不静默回 0）====================

test('molang: 未知查询标识符抛 MolangError', () => {
  // 这几个是「素材换了就会出现的真实候选」—— 抛错才能在烘焙期被发现
  assertThrows(() => compileMolang('q.ground_speed'), MolangError);
  assertThrows(() => compileMolang('q.is_powered'), MolangError);
  assertThrows(() => compileMolang('variable.foo * 2'), MolangError);
  assertThrows(() => compileMolang('q.life_time % 2'), MolangError);   // % 未实现
});

test('molang: 未实现的 Math 函数抛 MolangError', () => {
  // ⚠️ v2.56 起 `Math.cos` **是**支持的（按度，与 sin 同口径）—— 见下方度制用例。
  // 仍然不支持的（素材没用、且加了会让「不知从哪来的表达式」静默通过）：
  assertThrows(() => compileMolang('Math.abs(q.life_time)'), MolangError);
  assertThrows(() => compileMolang('Math.floor(q.life_time)'), MolangError);
  assertThrows(() => compileMolang('Math.clamp(q.life_time, 0, 1)'), MolangError);
});

test('molang: 语法错误抛 MolangError', () => {
  assertThrows(() => compileMolang('1 +'), MolangError);
  assertThrows(() => compileMolang('(1'), MolangError);
  assertThrows(() => compileMolang('1)'), MolangError);
  assertThrows(() => compileMolang(''), MolangError);
  assertThrows(() => compileMolang('   '), MolangError);
  assertThrows(() => compileMolang('* 2'), MolangError);
});

test('molang: 非字符串输入抛 MolangError', () => {
  assertThrows(() => compileMolang(null), MolangError);
  assertThrows(() => compileMolang(undefined), MolangError);
  assertThrows(() => compileMolang(42), MolangError);
});

test('molang: MolangError 的消息里带原表达式（烘焙期一眼看出是哪条）', () => {
  const err = assertThrows(() => compileMolang('q.unknown_field + 1'), MolangError);
  assertTrue(err.message.includes('q.unknown_field'), `message: ${err.message}`);
});

// ==================== 编译产物是纯函数 ====================

test('molang: 同一表达式的闭包可反复调用且结果一致（无内部状态）', () => {
  const f = compileMolang('Math.sin(q.life_time * 128) * 2.5');
  const a = f({ lifeTime: 0.01 });
  const b = f({ lifeTime: 0.01 });
  assertEqual(a, b);
  // 换了 scope 就该变
  assertTrue(f({ lifeTime: 0.02 }) !== a, '换了 lifeTime 结果却没变');
});

test('molang: 除零得到 Infinity 而不是抛错（Bedrock 的浮点语义）', () => {
  assertEqual(compileMolang('1 / 0')({}), Infinity);
});

// ==================== v2.56 缺陷 B：三角函数用「度」不是「弧度」====================
//
// 用户 2026-11-05 实玩报告：「焰魔移动的过程中，身体是抖动的」。
// 根因：Molang 的 `math.sin/cos` **以度为单位**（见 `IGNIS_ANIM_PERIODS.idle` 的推导），
// 而我最初按弧度求值 ⇒ `sin(q.life_time * 128)` 变成 **20.4 Hz** 的剧烈抖动
// （128 rad/s ÷ 2π），而素材的原意是 128°/s（周期 2.81 秒的缓慢呼吸）。
//
// ⚠️ **这条必须在求值器层测**：产物层无法区分（见 `test-ignis-bake.js` 的说明）。

test('molang(v2.56): Math.sin 的参数按「度」解释（Bedrock 口径）', () => {
  const f = compileMolang('Math.sin(90)');
  // 90 度 → 1（若按弧度解释，sin(90)=0.894）
  assertTrue(Math.abs(f({}) - 1) < 1e-9, `Math.sin(90) = ${f({})}，应为 1（度制）`);
  assertTrue(Math.abs(compileMolang('Math.sin(180)')({}) - 0) < 1e-9, 'Math.sin(180) 应为 0');
  assertTrue(Math.abs(compileMolang('Math.sin(30)')({}) - 0.5) < 1e-9, 'Math.sin(30) 应为 0.5');
});

test('molang(v2.56): 素材的待机表达式在度制下是缓慢呼吸（不是 20Hz 抖动）', () => {
  // 素材：Math.sin(q.life_time * 128) * -2.5
  const f = compileMolang('Math.sin(q.life_time * 128) * -2.5');
  // 度制下周期 = 360/128 = 2.8125 秒。取 t=0.703125（1/4 周期）应为峰值 −2.5
  assertTrue(Math.abs(f({ lifeTime: 360 / 128 / 4 }) - (-2.5)) < 1e-6,
    `1/4 周期处应为 −2.5，实测 ${f({ lifeTime: 360 / 128 / 4 })}`);
  // 半周期处应回到 0
  assertTrue(Math.abs(f({ lifeTime: 360 / 128 / 2 })) < 1e-6, '半周期处应为 0');
  // 一个周期后回到起点
  assertTrue(Math.abs(f({ lifeTime: 360 / 128 })) < 1e-6, '整周期处应回到 0');
});

test('molang(v2.56): Math.cos 同样按度（素材目前没用，但单位口径必须一致）', () => {
  const f = compileMolang('Math.cos(60)');
  assertTrue(Math.abs(f({}) - 0.5) < 1e-9, `Math.cos(60) = ${f({})}，应为 0.5（度制）`);
});
