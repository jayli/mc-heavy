// src/tests/test-shadow-manager.js — 太阳阴影刷新节流（Tier 1 纯函数）
// 本文件覆盖「改坏了肉眼玩不出来」的部分：节流窗口的边界判定（≥ 而不是 >）、
// pending 补刷不丢请求（丢请求 = 放块后影子停在原地，只有像素实测才看得出来）。
//
// ⚠️ 时间参数显式传入（tick(nowMs) 无时钟依赖），故用例完全确定性 —— 不受机器负载影响。
import { test } from './runner.js';
import { assertTrue, assertFalse, assertEqual } from './assert.js';
import {
  ShadowScheduler,
  SUN_DIR_GATE_DEG,
  sunDirectionChanged,
  texelSnapOffset,
} from '../render/shadow-manager.js';
import { VISUAL_STYLES } from '../render/daynight.js';

/** 归一化（测试自有算术，不消费实现里的函数 —— 同 test-daynight.js 口径） */
function norm(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function assertVecClose(actual, expected, eps, message) {
  assertTrue(Array.isArray(actual), `${message}: expected array, got ${actual}`);
  assertEqual(actual.length, 3, `${message}: length`);
  for (let i = 0; i < 3; i++) {
    assertTrue(
      Math.abs(actual[i] - expected[i]) < eps,
      `${message}: component ${i} expected ${expected[i]}, got ${actual[i]}`,
    );
  }
}

/**
 * 由 sunDir 构造阴影相机基（与 three `lookAt` 同口径：相机 -Z 朝向 target，
 * 故 zAxis = sunDir）。测试自算一份，不消费实现里的基构造。
 */
function cameraBasis(sunDir) {
  const zAxis = norm(sunDir);
  const xAxis = norm(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  return { xAxis, yAxis, zAxis };
}

test('shadow：首次 request 后 tick 立即刷新', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首次请求无历史刷新时刻，应立即刷新');
});

test('shadow：200ms 内的重复请求被节流', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首帧刷新');
  s.request();
  assertFalse(s.tick(1100), '距上次刷新仅 100ms < 200ms，应被节流');
});

test('shadow：节流期内的请求不丢（pending 补刷）', () => {
  const s = new ShadowScheduler();
  s.request();
  assertTrue(s.tick(1000), '首帧刷新');
  s.request();
  assertFalse(s.tick(1100), '节流期内不刷新');
  assertTrue(s.tick(1250), '距 1000 已 250ms ≥ 200ms，补刷挂起的请求');
});

test('shadow：无请求时 tick 恒 false', () => {
  const s = new ShadowScheduler();
  assertFalse(s.tick(5000), '从未 request，不应刷新');
  s.request();
  assertTrue(s.tick(5001), '有请求则刷新');
  assertFalse(s.tick(9999), '刷新后无新请求，恒 false');
});

test('shadow：minIntervalMs 可配', () => {
  const s = new ShadowScheduler({ minIntervalMs: 50 });
  s.request();
  assertTrue(s.tick(0), '首次刷新');
  s.request();
  assertFalse(s.tick(49), '49 < 50，节流');
  assertTrue(s.tick(50), '50 ≥ 50，边界应放行');
});

// ---------------------------------------------------------------------------
// sunDirectionChanged（v1.47）：日夜循环下太阳方向请求的角度阈值门控。
// 背景：`DayNight.update()` 每帧 `_apply` → `onSunDirection` 每帧触发，而太阳每秒只转
// 0.3°（每帧 0.0025°，在 256² 贴图上不可见）→ 绝大部分重定位是白做的，且每帧
// `paramsAtHour()` 新分配 2~3 个小对象（GC 压力源）。
// ⚠️ 阈值断言必须在**临界值附近**取点（CLAUDE.md：「用远离阈值的输入测不出来」）。
// ---------------------------------------------------------------------------

const NOON = norm(VISUAL_STYLES.noon.sunDirection);
const NIGHT = norm(VISUAL_STYLES.night.sunDirection);

test('sunDirectionChanged：lastDir 为 null 时恒 true（首次必通过）', () => {
  assertTrue(sunDirectionChanged(null, NOON, SUN_DIR_GATE_DEG), '启动首次须通过，否则阴影相机不定位');
  assertTrue(sunDirectionChanged(undefined, NOON, SUN_DIR_GATE_DEG), 'undefined 同义（字段初值）');
});

test('sunDirectionChanged：同一方向不触发', () => {
  assertFalse(sunDirectionChanged(NOON, NOON, SUN_DIR_GATE_DEG), '方向未变，不应重定位');
  assertFalse(sunDirectionChanged(NOON, NOON.slice(), SUN_DIR_GATE_DEG), '等值副本也不应触发');
});

test('sunDirectionChanged：临界值附近取点（阈值内 false / 超阈值 true）', () => {
  // 绕与 sunDir 垂直的轴旋转指定角度，构造精确的角度差
  const { xAxis } = cameraBasis(NOON);
  const rotateBy = (deg) => {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    // Rodrigues：v' = v·cosθ + (k×v)·sinθ + k·(k·v)(1−cosθ)，k=xAxis、v=NOON、k·v=0
    return norm(add(scale(NOON, c), scale(cross(xAxis, NOON), s)));
  };
  // 阈值 0.5°：取 0.4°（内）/ 0.6°（外）—— 两侧都贴临界，不用远离阈值的输入
  assertFalse(sunDirectionChanged(NOON, rotateBy(0.4), SUN_DIR_GATE_DEG),
    '0.4° < 0.5° 阈值，应被门控吸收');
  assertTrue(sunDirectionChanged(NOON, rotateBy(0.6), SUN_DIR_GATE_DEG),
    '0.6° > 0.5° 阈值，应放行重定位');
  // 阈值可配（单一权威不是硬编码）
  assertTrue(sunDirectionChanged(NOON, rotateBy(0.6), 0.5),
    '显式传 0.5 与常量同口径');
  assertFalse(sunDirectionChanged(NOON, rotateBy(0.6), 1.0),
    '阈值改 1.0° 后 0.6° 应被吸收（证明阈值真的被消费）');
});

test('sunDirectionChanged：noon→night 大跳变必触发', () => {
  assertTrue(sunDirectionChanged(NOON, NIGHT, SUN_DIR_GATE_DEG),
    '风格切换是大角度跳变，必须放行（否则切风格后阴影相机不跟新方向）');
});

// ---------------------------------------------------------------------------
// texelSnapOffset（v1.47）：把阴影相机中心吸附到贴图像素边界，消除「随移动晃动」。
// 根因：相机 ±30 覆盖 60 格、贴图 256² → 每纹素 0.234 格；相机连续跟随玩家时
// 世界相对纹素网格错位分数纹素 → 影子边缘跳动最多半纹素 ≈ 0.1 格。
// ⚠️ 两条载荷性不变式：① 偏移必须在 xAxis/yAxis 上都是 texelSize 的整数倍
// ② 偏移必须**垂直于 sunDir**（否则 position−target 方向被改 → 枪 PBR 高光漂移）。
// ---------------------------------------------------------------------------

const TEXEL = 60 / 256; // 阴影相机 (right−left)=60 / mapSize.width=256 ≈ 0.234 格

test('texelSnapOffset：吸附后中心落在纹素网格上（X/Y 轴投影为 texelSize 整数倍）', () => {
  for (const dir of [NOON, NIGHT, norm(VISUAL_STYLES.morning.sunDirection)]) {
    const { xAxis, yAxis } = cameraBasis(dir);
    for (const center of [[0, 0, 0], [12.37, 22.11, -45.83], [-100.5, 8.25, 200.75]]) {
      const off = texelSnapOffset(center, dir, TEXEL);
      // ⚠️ 断言落在 **center + offset**（吸附结果）而不是 offset 本身：
      // offset 是「到最近网格线的余量」，本身一般不是整数倍（实测 center[0]=12.37 →
      // offset·xAxis = 0.0519，而 12.37+0.0519 = 12.4219 = 53 × texel）。
      const snapped = add(center, off);
      const u = dot(snapped, xAxis) / TEXEL;
      const v = dot(snapped, yAxis) / TEXEL;
      assertTrue(Math.abs(u - Math.round(u)) < 1e-6,
        `dir=${JSON.stringify(dir)} center=${JSON.stringify(center)}: 吸附后 X 轴投影 ${u} 不是整数倍`);
      assertTrue(Math.abs(v - Math.round(v)) < 1e-6,
        `dir=${JSON.stringify(dir)} center=${JSON.stringify(center)}: 吸附后 Y 轴投影 ${v} 不是整数倍`);
    }
  }
});

test('texelSnapOffset：偏移垂直于 sunDir（不改光照方向）', () => {
  for (const dir of [NOON, NIGHT, norm(VISUAL_STYLES.morning.sunDirection)]) {
    const off = texelSnapOffset([12.37, 22.11, -45.83], dir, TEXEL);
    const along = Math.abs(dot(off, norm(dir)));
    assertTrue(along < 1e-9,
      `偏移在 sunDir 上的分量须为 0（否则 position−target 方向被改 → 枪 PBR 高光漂移），实测 ${along}`);
  }
});

test('texelSnapOffset：已在网格上时返回零偏移（幂等）', () => {
  const { xAxis, yAxis } = cameraBasis(NOON);
  // 构造一个已对齐的点：xAxis·3 + yAxis·5（整数倍纹素）
  const aligned = add(scale(xAxis, 3 * TEXEL), scale(yAxis, 5 * TEXEL));
  const off = texelSnapOffset(aligned, NOON, TEXEL);
  assertVecClose(off, [0, 0, 0], 1e-9, '已对齐的点不应再偏移');
  // 幂等：对同一 center 连算两次，第二次（已对齐）必为零
  const off2 = texelSnapOffset(add(aligned, off), NOON, TEXEL);
  assertVecClose(off2, [0, 0, 0], 1e-9, '吸附后再吸附应不动（幂等）');
});

test('texelSnapOffset：偏移幅度不超过半纹素对角', () => {
  const maxOff = 0.5 * TEXEL * Math.SQRT2 + 1e-9;
  for (const dir of [NOON, NIGHT, norm(VISUAL_STYLES.morning.sunDirection)]) {
    for (let i = 0; i < 40; i++) {
      // 分数纹素步长扫过整个网格相位（正是晃动的触发条件）
      const center = [i * 0.05, 22 + i * 0.037, -45 + i * 0.061];
      const off = texelSnapOffset(center, dir, TEXEL);
      const len = Math.sqrt(dot(off, off));
      assertTrue(len <= maxOff,
        `偏移幅度 ${len} 超过半纹素对角 ${maxOff}（吸附应取最近网格线）`);
    }
  }
});

test('texelSnapOffset：退化方向（平行 worldUp）返回零偏移不抛', () => {
  assertVecClose(texelSnapOffset([10, 20, 30], [0, 1, 0], TEXEL), [0, 0, 0], 1e-12,
    'sunDir 平行 worldUp 时 cross 为零向量，须退化为不对齐而非 NaN');
  assertVecClose(texelSnapOffset([10, 20, 30], [0, -1, 0], TEXEL), [0, 0, 0], 1e-12,
    '反向同理');
  // 退化时不得产出 NaN（NaN 会污染光源矩阵 → 阴影整体失效）
  const off = texelSnapOffset([10, 20, 30], [0, 1, 0], TEXEL);
  for (const c of off) assertFalse(Number.isNaN(c), '偏移不得为 NaN');
});

test('texelSnapOffset：texelSize 非法时返回零偏移（防御）', () => {
  assertVecClose(texelSnapOffset([10, 20, 30], NOON, 0), [0, 0, 0], 1e-12,
    'texelSize=0 会让 round 除零 → 须退化为不对齐');
  for (const c of texelSnapOffset([10, 20, 30], NOON, -1)) {
    assertFalse(Number.isNaN(c), '负 texelSize 不得产出 NaN');
  }
});

test('texelSnapOffset：noon 与 night 基不同 → 同一 center 偏移不同', () => {
  const center = [12.37, 22.11, -45.83];
  const a = texelSnapOffset(center, NOON, TEXEL);
  const b = texelSnapOffset(center, NIGHT, TEXEL);
  const diff = Math.sqrt(dot(sub(a, b), sub(a, b)));
  assertTrue(diff > 1e-6,
    `两个太阳方向的相机基不同，吸附结果应不同（否则说明基没被消费）：noon=${JSON.stringify(a)} night=${JSON.stringify(b)}`);
});
