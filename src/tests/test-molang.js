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
  assertEqual(leftArm({ lifeTime: t }), Math.sin(t * 128) * -2.5);

  // generala: left_hand = 2.5 + Math.sin(q.life_time * 128) * 2.5
  const leftHand = compileMolang('2.5 + Math.sin(q.life_time * 128) * 2.5');
  assertEqual(leftHand({ lifeTime: t }), 2.5 + Math.sin(t * 128) * 2.5);

  // t=0 时 sin(0)=0 ⇒ left_hand = 2.5（常量项不能丢）
  assertEqual(leftHand({ lifeTime: 0 }), 2.5);
});

test('molang: generalb 的带负常量偏移（root 的 y 位移）', () => {
  // generalb: root.position.y = Math.sin(q.life_time * 128 + (-96)) * 0.75
  const f = compileMolang('Math.sin(q.life_time * 128 + (-96)) * 0.75');
  const t = 0.007;
  assertEqual(f({ lifeTime: t }), Math.sin(t * 128 + (-96)) * 0.75);
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

test('molang: 未实现的 Math 函数抛 MolangError（Math.cos 故意不支持）', () => {
  // 只用到 sin 时加 cos 会让「素材悄悄换了函数」不被发现
  assertThrows(() => compileMolang('Math.cos(q.life_time)'), MolangError);
  assertThrows(() => compileMolang('Math.abs(q.life_time)'), MolangError);
  assertThrows(() => compileMolang('Math.floor(q.life_time)'), MolangError);
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
