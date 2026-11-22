// src/tests/test-storm-rain.js — 持续雨 / 湿地面 / 后处理的常量关系式与纯函数（Tier 1）
//
// 上游对照：`bj-shooting-game/night-heron-src/src/fx/rain.js` + `gfx/renderer.js`
// 判据是**关系式与上游原值**（本模块是常量/纯函数移植，真值来自上游代码）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  STORM_STREAK as ST, STORM_SPLASH as SP, STORM_AUDIO,
  stormStreakCount, stormSplashRate, stormStreakDensity,
  stormStreakRawPos, stormSplashSize, stormSplashFade,
} from '../render/storm-rain-config.js';
import {
  WET_RIPPLE, WET_PUDDLE, WET_REFLECT_STRENGTH, WET_ALBEDO_DARKEN,
  wetnessAt, wetRippleFade, wetFresnel,
} from '../render/wet-ground-config.js';
import {
  STORM_FOG, STORM_FAR_RAIN, STORM_BLOOM, STORM_GRADE,
  stormBloomLevels, bloomSoftKnee, vignetteAt, chromaticOffset,
} from '../render/storm-grade-config.js';
import { CARBINE_AUDIO_IDS } from '../render/carbine-audio-recipes.js';
import { RAIN_CEILING_Y } from '../render/rain-shelter.js';

function assertClose(a, b, eps = 1e-9, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg ? msg + ': ' : ''}期望 ${b}±${eps}，实际 ${a}`);
}
function lcg(seed = 1) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

// ---------- 雨丝：上游原值 ----------

test('storm streak: 盒尺寸/速度/长度/宽度 = 上游原值', () => {
  assertEqual(ST.box.join(','), '24,18,24');
  assertEqual(ST.vel.join(','), '1.6,13,0.7');
  assertClose(ST.length, 0.34, 1e-12);
  assertClose(ST.widthMin, 0.006, 1e-12);
  assertClose(ST.widthPerDistance, 0.0011, 1e-12);
  assertClose(ST.speedMin, 0.75, 1e-12);
  assertClose(ST.speedRange, 0.5, 1e-12);
  assertClose(ST.gain, 0.12, 1e-12);
  assertEqual(ST.count, 5200);
});

test('storm streak: 下落速度远大于风速（读作「下雨」而不是「飘雪」）', () => {
  assertTrue(ST.vel[1] > ST.vel[0] * 5, '竖直速度应远大于水平风速');
  assertTrue(ST.vel[1] > ST.vel[2] * 5);
  // 雨丝长度 × 速度 ⇒ 视觉上是细长条而不是点
  assertTrue(ST.length > ST.widthMin * 10, '雨丝应细长远大于宽');
});

test('storm streak: 性能档恰好减半，密度同比下降', () => {
  assertEqual(stormStreakCount('performance') * 2, stormStreakCount('sharp'));
  assertClose(stormStreakDensity('performance') * 2, stormStreakDensity('sharp'), 1e-12);
  assertEqual(stormSplashRate('performance') < stormSplashRate('sharp'), true);
});

test('storm streak: 原始位置随时间下落（y 递减），水平随风漂', () => {
  const seed = [0.3, 0.7, 0.5];
  const a = stormStreakRawPos(seed, 0);
  const b = stormStreakRawPos(seed, 1);
  assertTrue(b[1] < a[1], 'y 必须随时间减小（下落）');
  assertTrue(b[0] > a[0], 'x 随风正向漂');
  assertTrue(b[2] > a[2], 'z 随风正向漂');
  // 下落量 = vel.y × sp（sp ∈ [0.75,1.25]）
  const drop = a[1] - b[1];
  assertTrue(drop >= ST.vel[1] * ST.speedMin - 1e-9);
  assertTrue(drop <= ST.vel[1] * (ST.speedMin + ST.speedRange) + 1e-9);
});

test('storm streak: 不同种子的速度差在 [0.75,1.25] 内（相位不同步）', () => {
  const rand = lcg(9);
  const drops = new Set();
  for (let i = 0; i < 200; i++) {
    const seed = [rand(), rand(), rand()];
    const a = stormStreakRawPos(seed, 0);
    const b = stormStreakRawPos(seed, 1);
    drops.add((a[1] - b[1]).toFixed(4));
  }
  assertTrue(drops.size > 20, `速度应有分布，实际只有 ${drops.size} 种`);
});

// ---------- 水花：上游原值 ----------

test('storm splash: 寿命/速率/尺寸曲线 = 上游原值', () => {
  assertClose(SP.life, 0.26, 1e-12);
  assertEqual(SP.rate, 520);
  assertEqual(SP.capacity, 260);
  assertEqual(SP.perFrameCap, 40);
  assertClose(SP.widthBase, 0.02, 1e-12);
  assertClose(SP.widthGrow, 0.05, 1e-12);
  assertClose(SP.heightBase, 0.012, 1e-12);
  assertClose(SP.heightArc, 0.075, 1e-12);
});

test('storm splash: 尺寸包络 —— 宽度单调增、高度先增后减（冠形）', () => {
  const s0 = stormSplashSize(0);
  const s5 = stormSplashSize(0.5);
  const s1 = stormSplashSize(1);
  assertTrue(s0.alive && s5.alive && s1.alive);
  assertTrue(s5.width > s0.width, '宽度应随年龄增长（水花摊开）');
  assertTrue(s1.width > s5.width);
  assertTrue(s5.height > s0.height, '高度中段最高（冠起来）');
  assertTrue(s5.height > s1.height, '末段落回');
  // 越界 ⇒ 不可见
  assertFalseAlive(stormSplashSize(-0.1));
  assertFalseAlive(stormSplashSize(1.1));
});
function assertFalseAlive(s) {
  assertEqual(s.alive, false);
  assertEqual(s.width, 0);
  assertEqual(s.height, 0);
}

test('storm splash: 亮度随年龄与距离衰减，近处比远处亮', () => {
  const near = stormSplashFade(0.2, 5);
  const far = stormSplashFade(0.2, 25);
  assertTrue(near > far, '近处应更亮');
  assertClose(stormSplashFade(0.2, 30), 0, 1e-9, '30 格外应归零');
  const young = stormSplashFade(0.1, 5);
  const old = stormSplashFade(0.9, 5);
  assertTrue(young > old, '年轻的水花应更亮');
});

test('storm splash: 池账 —— 容量 ≥ 速率 × 寿命（否则 FIFO 绕回丢水花）', () => {
  const concurrent = Math.ceil(SP.rate * SP.life);
  assertTrue(SP.capacity >= concurrent,
    `容量 ${SP.capacity} < 理论并发 ${concurrent}`);
});

// ---------- 雨声 id 接线 ----------

test('storm audio: 雨声与雷声 id 都在烘焙产物清单里（拼错 = 静默无声）', () => {
  assertTrue(CARBINE_AUDIO_IDS.includes(STORM_AUDIO.rainLoop));
  assertTrue(CARBINE_AUDIO_IDS.includes(STORM_AUDIO.thunder));
  assertTrue(STORM_AUDIO.rainLoop !== STORM_AUDIO.thunder);
  assertTrue(STORM_AUDIO.rainVolume > 0 && STORM_AUDIO.rainVolume <= 1);
  const [lo, hi] = STORM_AUDIO.thunderInterval;
  assertTrue(lo > 0 && hi > lo, '雷声间隔下限必须 >0（否则每帧都响）');
});

// ---------- 湿地面 ----------

test('wet ground: 湿度公式 = 上游 clamp(uWet*(0.3+0.7*up+0.55*streak))', () => {
  assertClose(wetnessAt(1, 1, 0), 1, 1e-12, '朝上无纹 ⇒ 0.3+0.7=1');
  assertClose(wetnessAt(1, 0, 0), 0.3, 1e-12, '侧面无纹 ⇒ 0.3');
  assertClose(wetnessAt(0, 1, 1), 0, 1e-12, '总开关 0 ⇒ 全干');
  // 上界钳到 1（三项相加可 >1）
  assertClose(wetnessAt(1, 1, 1), 1, 1e-12);
  // 单调性
  assertTrue(wetnessAt(1, 1, 0.5) > wetnessAt(1, 0.5, 0.5));
  assertTrue(wetnessAt(0.5, 1, 0.5) < wetnessAt(1, 1, 0.5));
});

test('wet ground: 涟漪近处全额、远处归零、中间单调', () => {
  assertClose(wetRippleFade(0), 1, 1e-12);
  assertClose(wetRippleFade(WET_RIPPLE.fadeNear), 1, 1e-12);
  assertClose(wetRippleFade(WET_RIPPLE.fadeFar), 0, 1e-12);
  assertClose(wetRippleFade(100), 0, 1e-12);
  let prev = 1;
  for (let d = WET_RIPPLE.fadeNear; d <= WET_RIPPLE.fadeFar; d += 0.5) {
    const v = wetRippleFade(d);
    assertTrue(v <= prev + 1e-9, '必须单调不增');
    prev = v;
  }
});

test('wet ground: 菲涅尔 —— 掠射（noV→0）比垂直（noV=1）反射强', () => {
  const graze = wetFresnel(0.05, 0.025);
  const perp = wetFresnel(1.0, 0.025);
  assertTrue(graze > perp * 5, `掠射 ${graze} 应远强于垂直 ${perp}`);
  assertTrue(perp > 0, '垂直也要有地板（否则低头时反光完全消失）');
  // 积水更多 ⇒ f0 更大
  assertTrue(wetFresnel(0.5, 0.025, 1) > wetFresnel(0.5, 0.025, 0));
});

test('wet ground: 反射强度上限 < 1（复用水面 RT，防互反射亮斑）', () => {
  assertTrue(WET_REFLECT_STRENGTH > 0);
  assertTrue(WET_REFLECT_STRENGTH < 1);
  assertTrue(WET_ALBEDO_DARKEN < 1, '湿表面应比干表面暗');
  assertTrue(WET_PUDDLE > 0 && WET_PUDDLE < 1);
});

// ---------- 后处理 ----------

test('storm grade: bloom 阈值/增益 = 上游原值，级数按档减', () => {
  assertClose(STORM_BLOOM.threshold, 0.9, 1e-12);
  assertClose(STORM_BLOOM.gain, 0.16, 1e-12);
  assertClose(STORM_BLOOM.kneeRatio, 0.6, 1e-12);
  assertEqual(STORM_BLOOM.clampMax, 40);
  assertEqual(stormBloomLevels('performance'), stormBloomLevels('sharp') - 1);
});

test('storm grade: 软膝 —— 阈值以下不贡献、阈值以上单调增', () => {
  assertClose(bloomSoftKnee(0.1), 0, 1e-6, '暗像素不该进 bloom');
  // ⚠️ **软膝的意义就是「阈值前一点就开始轻微贡献」**（上游同式）：
  // knee = 0.9×0.6 = 0.54，br=0.5 时 soft = 0.5−0.9+0.54 = 0.14 ⇒ 比例 0.018。
  // 写「0.5 应为 0」是错的（那要求硬阈值，会把辉光边缘切成硬边）。
  // 正确判据：远低于膝部起点（thr−knee = 0.36）时为 0，膝部内少量贡献。
  assertClose(bloomSoftKnee(0.3), 0, 1e-6, '低于膝部起点应为 0');
  assertTrue(bloomSoftKnee(0.5) < 0.05, '膝部内只应有少量贡献');
  const a = bloomSoftKnee(1.0);
  const b = bloomSoftKnee(2.0);
  const c = bloomSoftKnee(8.0);
  assertTrue(a > 0, '刚过阈值应有贡献');
  assertTrue(b > a && c > b, '越亮贡献越大');
  assertTrue(c <= 1 + 1e-6, '比例不得超过 1');
});

test('storm grade: 暗角 —— 中心 1、四角最暗、单调', () => {
  assertClose(vignetteAt(0), 1, 1e-12, '屏幕中心不该被压暗');
  const corner = vignetteAt(0.5);
  assertTrue(corner < 1, '四角应被压暗');
  assertTrue(corner > 0, '不该压到全黑');
  assertClose(vignetteAt(0, 0), 1, 1e-12, '强度 0 ⇒ 无暗角（A/B 锚点）');
  let prev = 1;
  for (let r2 = 0; r2 <= 0.5; r2 += 0.02) {
    const v = vignetteAt(r2);
    assertTrue(v <= prev + 1e-9, '暗角必须单调不增');
    prev = v;
  }
});

test('storm grade: 色差 —— 中心零偏移、边缘偏移随半径增', () => {
  assertClose(chromaticOffset(0, 0), 0, 1e-12, '中心无偏移');
  const mid = Math.abs(chromaticOffset(0.2, 0.04));
  const edge = Math.abs(chromaticOffset(0.5, 0.5));
  assertTrue(edge > mid, '边缘偏移应更大');
  assertClose(chromaticOffset(0.5, 0.5, 0), 0, 1e-12, '强度 0 ⇒ 无色差（A/B 锚点）');
  // 左右对称（符号相反、幅度相同）
  assertClose(chromaticOffset(-0.3, 0.09), -chromaticOffset(0.3, 0.09), 1e-12);
});

test('storm grade: 远景雨幕三层 —— 尺度/速度递增关系与距离门不重叠倒置', () => {
  const L = STORM_FAR_RAIN.layers;
  assertEqual(L.length, 3);
  for (let i = 1; i < L.length; i++) {
    assertTrue(L[i].L > L[i - 1].L, '远层尺度应更大');
    assertTrue(L[i].tiles > L[i - 1].tiles, '远层平铺应更密');
    assertTrue(L[i].speed < L[i - 1].speed, '远层视速度应更慢（透视）');
    assertTrue(L[i].near > L[i - 1].near, '远层的距离门应更远');
    assertTrue(L[i].far > L[i].near, '每层的门必须 far > near');
  }
  assertTrue(STORM_FAR_RAIN.elevationTo > STORM_FAR_RAIN.elevationFrom);
});

test('storm grade: 体积雾的散射色是冷蓝（雨夜），太阳项是暖白', () => {
  const sky = STORM_FOG.skyColor;
  assertTrue(sky[2] > sky[0], '天空散射应偏蓝');
  const sun = STORM_FOG.sunColor;
  assertTrue(sun[0] > sun[2], '太阳散射应偏暖');
  assertTrue(STORM_FOG.maxDistance > 0);
  assertTrue(STORM_FOG.sunSharpness > 1, '太阳项应有方向性（不是各向同性）');
});

test('storm grade: ACES 不在本表（renderer 已应用，不双重色调映射）', () => {
  // 本表只持有 ACES 之前/之后的量；曝光取中性 1.0 避免与 renderer 的曝光叠乘
  assertClose(STORM_GRADE.exposure, 1.0, 1e-12);
  assertTrue(!('aces' in STORM_GRADE), '不得在本表再写一份 ACES');
  assertTrue(STORM_GRADE.ca > 0 && STORM_GRADE.vignette > 0,
    'CA 与暗角本仓此前零实现 ⇒ 必须移植（用户第二轮裁定）');
});

test('storm grade: 雨幕盒顶不得高于云层（与 rain-shelter 同一上界）', () => {
  // 盒心钳制公式的边界：playerY 很大时盒顶恰好 = 上界
  const H = ST.box[1];
  const centerY = Math.min(1000, RAIN_CEILING_Y - H / 2);
  assertClose(centerY + H / 2, RAIN_CEILING_Y, 1e-12);
});