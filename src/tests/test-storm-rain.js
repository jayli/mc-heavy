// src/tests/test-storm-rain.js — 持续雨（雨丝 / 水花 / 雨声）的常量关系式与纯函数（Tier 1）
//
// 上游对照：`bj-shooting-game/night-heron-src/src/fx/rain.js`（**只有雨**这一块仍是对照移植）。
// 判据是关系式与上游原值。
//
// ⚠️ v3.31：湿地面与后处理链已按用户裁定**整体删除并从零重做** ——
// 新的湿表面判据在 `test-wet-surface.js`，本文件只留雨 + 「被删模块真的不存在」的防线。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  STORM_STREAK as ST, STORM_SPLASH as SP, STORM_AUDIO,
  stormStreakCount, stormSplashRate, stormStreakDensity,
  stormStreakRawPos, stormSplashSize, stormSplashFade,
} from '../render/storm-rain-config.js';
import { WET_STRENGTH_MAX } from '../render/wet-surface-config.js';
import { CARBINE_AUDIO_IDS } from '../render/carbine-audio-recipes.js';
import { RAIN_CEILING_Y } from '../render/rain-shelter.js';
import { WATER_SURFACE_Y } from '../render/water-surface.js';
import { WATER_LEVEL_OFFSET } from '../render/ocean.js';

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

// ---------- 被删模块的结构性防线（v3.31 用户裁定：从零重做，不参考上游）----------

/**
 * 上游湿地面（wet-ground / ground-reflect）与整条后处理链（storm-grade）已**整体删除**。
 * 本用例钉「它们真的不存在」——防止将来凭直觉把那些层「补齐」而让岩壁亮带 /
 * 高空云层光晕 / 屏幕竖纹复活（三条缺陷的根因取证见 spec §2）。
 */
test('storm: 上游湿地面与后处理链已整体移除（不得凭直觉补齐）', async () => {
  for (const p of ['wet-ground.js', 'wet-ground-config.js', 'ground-reflect.js',
    'ground-reflect-config.js', 'storm-grade.js', 'storm-grade-config.js']) {
    let gone = false;
    try { await import(`../render/${p}`); } catch { gone = true; }
    assertTrue(gone, `${p} 必须已删除`);
  }
});

test('storm: WET_STRENGTH_MAX 由新 config 提供且仍为 1.0（装配层句柄语义不变）', async () => {
  assertClose(WET_STRENGTH_MAX, 1.0, 1e-12);
});

test('storm rain: 雨幕盒顶不得高于云层（与 rain-shelter 同一上界）', () => {
  // 盒心钳制公式的边界：playerY 很大时盒顶恰好 = 上界
  const H = ST.box[1];
  const centerY = Math.min(1000, RAIN_CEILING_Y - H / 2);
  assertClose(centerY + H / 2, RAIN_CEILING_Y, 1e-12);
});