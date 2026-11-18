// src/tests/test-water-reflect.js — 水面倒影的节流与门控（Tier 1 纯函数）
//
// 覆盖「改坏了肉眼玩不出来」的三处：
//   ① 节流窗口边界（差一帧 = 成本翻倍或倒影延迟翻倍，帧时判据抓不到）；
//   ② 首帧必刷（漏了 = 启动首帧水面采到空 RT，纯黑倒影，而所有计数全对）；
//   ③ 可见性门控（判据写反 = 抬头看天时白跑整个反射 pass，或平视海面时倒影消失）。
//
// ⚠️ 全部无时钟依赖（tick 只吃一个布尔），故完全确定性、不受机器负载影响。
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual } from './assert.js';
import {
  ReflectScheduler, reflectVisible, reflectDistortAt, normalizeEvery,
  REFLECT_RESOLUTION_SCALE, REFLECT_MIP_LEVEL, REFLECT_STRENGTH, REFLECT_DISTORT,
  REFLECT_DISTORT_NEAR, REFLECT_DISTORT_FAR, REFLECT_REFRESH_EVERY, REFLECT_FAR_SCALE, REFLECT_TINT,
} from '../render/water-reflect-config.js';

const close = (a, b, eps = 1e-9) => assertTrue(Math.abs(a - b) <= eps, `期望 ${b}，实得 ${a}`);

test('ReflectScheduler：首帧恒放行（否则启动首帧是空 RT 的黑倒影）', () => {
  const s = new ReflectScheduler({ every: 3 });
  assertTrue(s.tick(true), '第 1 帧必须刷新');
  assertEqual(s.refreshes, 1);
});

test('ReflectScheduler：every=2 时隔帧刷（窗口边界是 >= 而不是 >）', () => {
  const s = new ReflectScheduler({ every: 2 });
  const got = [];
  for (let i = 0; i < 8; i++) got.push(s.tick(true));
  // 帧号 1..8：刷新落在 1/3/5/7
  assertEqual(got.join(','), 'true,false,true,false,true,false,true,false');
  assertEqual(s.refreshes, 4);
});

test('ReflectScheduler：every=1 时每帧刷（不是恒 false）', () => {
  const s = new ReflectScheduler({ every: 1 });
  for (let i = 0; i < 5; i++) assertTrue(s.tick(true), `every=1 第 ${i + 1} 帧应刷新`);
  assertEqual(s.refreshes, 5);
});

test('ReflectScheduler：不可见时不推进配额（一低头就该立刻看到新倒影）', () => {
  const s = new ReflectScheduler({ every: 2 });
  assertTrue(s.tick(true));            // 帧 1 刷
  assertFalse(s.tick(true));           // 帧 2 不刷
  // 中间 10 帧水面不可见：不该消耗配额
  for (let i = 0; i < 10; i++) assertFalse(s.tick(false), '不可见帧恒不刷');
  assertEqual(s.refreshes, 1);
  assertTrue(s.tick(true), '回到可见的第一帧就该刷（配额未被不可见帧吃掉）');
});

test('ReflectScheduler：invalidate 后下一可见帧必刷（瞬移/切风格不留旧倒影）', () => {
  const s = new ReflectScheduler({ every: 4 });
  assertTrue(s.tick(true));
  assertFalse(s.tick(true));
  s.invalidate();
  assertTrue(s.tick(true), 'invalidate 之后必须立刻刷一次');
});

test('ReflectScheduler：setEvery 立即生效且归一化非法值', () => {
  const s = new ReflectScheduler({ every: 4 });
  s.setEvery(1);
  assertTrue(s.tick(true));
  assertTrue(s.tick(true), '改成 every=1 后应每帧刷');
  s.setEvery(0);
  assertEqual(s.every, 1, '0 归一化为 1（不是恒不刷）');
  s.setEvery(-3);
  assertEqual(s.every, 1);
  s.setEvery(NaN);
  assertEqual(s.every, 1);
  s.setEvery(2.6);
  assertEqual(s.every, 3, '小数四舍五入');
});

test('normalizeEvery：非法输入一律回落 1', () => {
  assertEqual(normalizeEvery(undefined), 1);
  assertEqual(normalizeEvery(null), 1);
  assertEqual(normalizeEvery('abc'), 1);
  assertEqual(normalizeEvery(Infinity), 1);
  assertEqual(normalizeEvery(2), 2);
});

// ---- 可见性门控 ----
// 水面高度取 −1.5（WATER_LEVEL_OFFSET 的实测值）；相机高度与俯仰是真实自由度。
const WATER_Y = -1.5;
const HALF_FOV = (70 * Math.PI / 180) / 2;   // 本仓相机 fov=70

test('reflectVisible：站在水面上方平视 → 可见（最常见机位，不得丢倒影）', () => {
  // 相机 y=6（岸上眼高），前向水平 ⇒ forwardY = 0
  assertTrue(reflectVisible(6, WATER_Y, 0, HALF_FOV));
});

test('reflectVisible：俯视水面 → 可见', () => {
  assertTrue(reflectVisible(12, WATER_Y, -0.2, HALF_FOV));
  assertTrue(reflectVisible(12, WATER_Y, -0.9, HALF_FOV));
});

test('reflectVisible：相机在水面之下 → 不可见（水下抬头看到的是膜）', () => {
  assertFalse(reflectVisible(-3, WATER_Y, 0, HALF_FOV));
  assertFalse(reflectVisible(WATER_Y, WATER_Y, -0.5, HALF_FOV), '恰好共面也算不可见');
});

test('reflectVisible：抬头超过半视场角 → 不可见（视锥全在水平面之上）', () => {
  // 仰角 60° ⇒ forwardY = sin60 ≈ 0.866 > sin(35°) ≈ 0.574
  assertFalse(reflectVisible(6, WATER_Y, Math.sin(60 * Math.PI / 180), HALF_FOV));
});

test('reflectVisible：抬头但未超过半视场角 → 仍可见（视野下缘扫得到水面）', () => {
  // 仰角 20° ⇒ 0.342 < 0.574
  assertTrue(reflectVisible(6, WATER_Y, Math.sin(20 * Math.PI / 180), HALF_FOV));
});

test('reflectVisible：阈值两侧只差一点点的对照（钉住边界不是恒真/恒假）', () => {
  const limit = Math.sin(HALF_FOV);
  assertTrue(reflectVisible(6, WATER_Y, limit - 0.01, HALF_FOV), '略低于阈值应可见');
  assertFalse(reflectVisible(6, WATER_Y, limit + 0.01, HALF_FOV), '略高于阈值应不可见');
});

test('reflectVisible：非法输入不崩、返回 false', () => {
  assertFalse(reflectVisible(NaN, WATER_Y, 0, HALF_FOV));
  assertFalse(reflectVisible(6, WATER_Y, NaN, HALF_FOV));
});

// ---- 扰动衰减 ----

test('reflectDistortAt：近处全额、远处归零', () => {
  close(reflectDistortAt(0), REFLECT_DISTORT);
  close(reflectDistortAt(REFLECT_DISTORT_NEAR), REFLECT_DISTORT);
  close(reflectDistortAt(REFLECT_DISTORT_FAR), 0);
  close(reflectDistortAt(REFLECT_DISTORT_FAR + 100), 0);
});

test('reflectDistortAt：中间单调递减（不是阶跃，也不是反向）', () => {
  const a = reflectDistortAt(30);
  const b = reflectDistortAt(45);
  const c = reflectDistortAt(60);
  assertTrue(a > b && b > c, `应单调递减，实得 ${a} / ${b} / ${c}`);
  assertTrue(c > 0 && a < REFLECT_DISTORT, '中间段必须严格落在 (0, 全额) 内');
});

test('reflectDistortAt：中点恰好半幅（smoothstep 的对称性）', () => {
  const mid = (REFLECT_DISTORT_NEAR + REFLECT_DISTORT_FAR) / 2;
  close(reflectDistortAt(mid), REFLECT_DISTORT / 2, 1e-12);
});

// ---- 常量关系（设计决策，钉住口径而不是钉死观感） ----

test('倒影常量：口径关系式', () => {
  assertTrue(REFLECT_RESOLUTION_SCALE > 0 && REFLECT_RESOLUTION_SCALE <= 1, '倍率必须在 (0,1]');
  assertTrue(REFLECT_MIP_LEVEL >= 1, '朦胧感要求至少 1 级 mip（0 = 清晰镜面，与用户口径相背）');
  assertTrue(REFLECT_STRENGTH > 0 && REFLECT_STRENGTH < 1, '强度必须是真混合（0=无效果 / 1=纯镜子）');
  assertTrue(REFLECT_DISTORT > 0, '扰动为 0 时倒影不随波，与需求相背');
  assertTrue(REFLECT_DISTORT_FAR > REFLECT_DISTORT_NEAR, '衰减带的两个边界不得写反');
  assertTrue(REFLECT_REFRESH_EVERY >= 2, '默认必须节流（每帧刷是实测的成本大头）');
  assertTrue(REFLECT_FAR_SCALE > 0 && REFLECT_FAR_SCALE <= 1, '远裁面收缩系数必须在 (0,1]');
});

test('倒影常量：扰动幅度落在实测标定区间内', () => {
  // 实测（水区两帧变化占比）：0.01 → 3.82% / 0.02 → 9.25% / 0.04 → 19.85%
  // 用户要「朦胧特效」而非「散开的色块」⇒ 取 [0.01, 0.03] 这一档。
  assertTrue(REFLECT_DISTORT >= 0.01 && REFLECT_DISTORT <= 0.03,
    `扰动 ${REFLECT_DISTORT} 超出实测标定档 [0.01, 0.03]`);
});

test('反射率常量：水面必须吸收（否则把水抬成天空亮度，撞冻结色阶）', () => {
  // 实测（深海机位、固定掩膜 78794 像素均值）：
  //   无倒影水面 luma 127.4；纯倒影（理想镜面）luma 185.9 = 天空亮度。
  // 冻结断言（water-visual）钉 morning/noon 近处众数峰 luma ∈ (108,124)，
  // 故反射率必须明显小于 1（水面不是镜子）。
  assertTrue(REFLECT_TINT > 0, '反射率为 0 等于没有倒影');
  assertTrue(REFLECT_TINT <= 0.6,
    `反射率 ${REFLECT_TINT} 过高：实测会把水面 luma 抬出冻结带 (108,124)`);
});

// ⚠️ 「倒影不得再吃一次 waterTint」是 **GPU 侧顶序约束**，纯函数拓不到：
// 它由 `tests/water-visual.spec.mjs` 的四风格冻结色阶钉住（night 下界 70）。
// 实测过的错口径：把 tint 乘在「含倒影的整体」上 ⇒ night 65（RT 已是夜景，双重压暗）；
// 曾想用「反射率按 1−均值tint 回升」补偿，只能拉到 69/70 贴线 ⇒ 已废弃那个常量。
// 正确口径：水色支乘 tint（逐字即原式）、倒影支不乘，两支各自上雾后再混。