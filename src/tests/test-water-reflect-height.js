// src/tests/test-water-reflect-height.js — 倒影的高度衰减（Tier 1 纯函数，v3.17b）
//
// 用户口径：「当玩家距离水面一定高度后，倒影应该越来越弱甚至消失」。
// 这条判据**兼任性能门**（fade=0 时反射 pass 整个不跑），所以写错有两种后果：
//   · 写反/恒 1 → 飞到高空仍每帧跑反射 pass（白付成本，帧时判据抓不到「本可以不跑」）；
//   · 恒 0 → 倒影永远不出现，而所有计数类判据全对（静默失效）。
// 故必须两侧都钉，且钉在**边界与单调性**上而不是单点值。
import { test } from './runner.js';
import { assertTrue } from './assert.js';
import {
  reflectHeightFade,
  REFLECT_HEIGHT_FULL, REFLECT_HEIGHT_ZERO, REFLECT_GRAZE,
} from '../render/water-reflect-config.js';

const WATER_Y = -1.5;               // WATER_LEVEL_OFFSET 的实测值
const close = (a, b, eps = 1e-9) => assertTrue(Math.abs(a - b) <= eps, `期望 ${b}，实得 ${a}`);
/** 相机高度 = 水面 + 相对高度（避免每个用例手写 −1.5 的加法） */
const at = (h) => reflectHeightFade(WATER_Y + h, WATER_Y);

test('高度衰减：岸上眼高与已验收机位必须满强度（不得偷偷削弱既有观感）', () => {
  close(at(1.62), 1);   // 站在水面边的眼高
  close(at(4), 1);      // 岸上地表 + 眼高
  close(at(13.5), 1);   // 调研截图机位（y=12）
  close(at(REFLECT_HEIGHT_FULL), 1);
});

test('高度衰减：超过归零高度必须恰好 0（这是反射 pass 的性能门）', () => {
  close(at(REFLECT_HEIGHT_ZERO), 0);
  close(at(REFLECT_HEIGHT_ZERO + 1), 0);
  close(at(200), 0);
});

test('高度衰减：中间段严格单调递减且落在开区间 (0,1)', () => {
  const a = at(REFLECT_HEIGHT_FULL + 4);
  const b = at((REFLECT_HEIGHT_FULL + REFLECT_HEIGHT_ZERO) / 2);
  const c = at(REFLECT_HEIGHT_ZERO - 4);
  assertTrue(a > b && b > c, `应单调递减，实得 ${a} / ${b} / ${c}`);
  assertTrue(a < 1 && c > 0, `中间段必须在 (0,1) 内，实得 ${a} / ${c}`);
});

test('高度衰减：中点恰好半幅（smoothstep 对称性，钉住不是线性也不是阶跃）', () => {
  const mid = (REFLECT_HEIGHT_FULL + REFLECT_HEIGHT_ZERO) / 2;
  close(at(mid), 0.5, 1e-12);
});

test('高度衰减：阈值两侧只差 0.01 的对照（证明边界真有判别力）', () => {
  assertTrue(at(REFLECT_HEIGHT_FULL - 0.01) === 1, '满强度区内恒 1');
  assertTrue(at(REFLECT_HEIGHT_FULL + 0.01) < 1, '刚过下阈必须已开始衰减');
  assertTrue(at(REFLECT_HEIGHT_ZERO - 0.01) > 0, '未到上阈仍应有残留倒影');
  assertTrue(at(REFLECT_HEIGHT_ZERO + 0.01) === 0, '刚过上阈必须归零');
});

test('高度衰减：水下与共面返回 0（与 reflectVisible 同口径，两处都要判）', () => {
  close(at(0), 0);
  close(at(-1), 0);
  close(at(-20), 0);
});

test('高度衰减：非法输入返回 0，不产 NaN', () => {
  close(reflectHeightFade(NaN, WATER_Y), 0);
  close(reflectHeightFade(6, NaN), 0);
  close(reflectHeightFade(Infinity, WATER_Y), 0);
});

test('高度衰减：非法阈值区间退化为阶跃而不是 NaN（面板互相钳制的兜底）', () => {
  // full == zero（区间宽 0）：不得除零
  const eq = reflectHeightFade(WATER_Y + 10, WATER_Y, 20, 20);
  assertTrue(Number.isFinite(eq), `退化区间必须给有限值，实得 ${eq}`);
  close(eq, 1);   // 10 <= 20 → 满强度
  close(reflectHeightFade(WATER_Y + 30, WATER_Y, 20, 20), 0);
  // full > zero（写反）：同样不崩
  const rev = reflectHeightFade(WATER_Y + 10, WATER_Y, 40, 20);
  assertTrue(Number.isFinite(rev), `写反的区间必须给有限值，实得 ${rev}`);
});

test('高度衰减：自定义阈值生效（面板拖动真的改了曲线，不是摆设）', () => {
  // 收窄到 [4, 8]：6 格处应为半幅
  close(reflectHeightFade(WATER_Y + 6, WATER_Y, 4, 8), 0.5, 1e-12);
  close(reflectHeightFade(WATER_Y + 3, WATER_Y, 4, 8), 1);
  close(reflectHeightFade(WATER_Y + 9, WATER_Y, 4, 8), 0);
});

test('高度常量：默认区间必须覆盖已验收机位、且上界能真正省到性能', () => {
  assertTrue(REFLECT_HEIGHT_FULL >= 14,
    `满强度上界 ${REFLECT_HEIGHT_FULL} 必须 ≥ 14（调研机位相对高度 13.5，否则等于削弱已认可观感）`);
  assertTrue(REFLECT_HEIGHT_ZERO > REFLECT_HEIGHT_FULL, '两个阈值不得写反或重合');
  assertTrue(REFLECT_HEIGHT_ZERO <= 120,
    `归零高度 ${REFLECT_HEIGHT_ZERO} 过大则飞行时仍白跑反射 pass`);
});

test('掠射权重：默认留地板（垂直俯视不得让倒影完全消失）', () => {
  assertTrue(REFLECT_GRAZE > 0, '为 0 则视角完全不影响倒影，与「更拟真」的诉求相背');
  assertTrue(REFLECT_GRAZE < 1,
    `权重 ${REFLECT_GRAZE} 为 1 时垂直俯视 fresnel→0 ⇒ 脚下倒影完全消失，与用户要的朦胧映照相背`);
  // 地板 = 1 − GRAZE，必须 ≥ 0.3（俯视仍看得见倒影）
  assertTrue(1 - REFLECT_GRAZE >= 0.3, `掠射地板 ${1 - REFLECT_GRAZE} 过低`);
});