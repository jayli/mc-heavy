// src/tests/test-castle-heal.js — 回城回血的纯函数契约（生命系统）
//
// 用户 2026-11-28：「当玩家回到最初诞生时的城堡的位置，就自动回血完成，回血的过程是一个
// 动画……回到 City 中心的城堡时，就 100ms 半格血的速度回血，直到满血。」
// 后续裁定：「按你的判断做，每 100ms +1 格」⇒ 本仓「半格血」= 半颗心 = 1 格
//（一颗心 2 格的换算在 `player/health.js`，v3.29 起从未变过）。
//
// 按 docs/testing-policy.md：纯函数算法 = Tier 1，必须钉住边界与非法值。
// 装配层（`core/game.js` 的帧循环接线）由 `tests/castle-heal.spec.mjs` 覆盖 —— 那是
// 「漏接线就静默失效」型缺陷，纯函数单测拓不到。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { PLAYER_MAX_HEALTH } from '../player/health.js';
import {
  HEAL_INTERVAL_MS, HEAL_PER_TICK, CASTLE_HEAL_HALF, isInCastleHealZone, CastleHeal,
} from '../player/castle-heal.js';

const CENTER = { x: 283, z: 117 };   // seed 12345 的 City 中心（castle 固定在此）

test('castle-heal: 常量（100ms / 1 格 / 范围派生自城堡 footprint）', () => {
  assertEqual(HEAL_INTERVAL_MS, 100, '用户 2026-11-28 裁定：100ms 一次');
  assertEqual(HEAL_PER_TICK, 1, '「半格血」= 半颗心 = 1 格（心 2 格的换算在 health.js）');
  // 范围必须 ≥ 城堡 JSON 的半宽（halfX=23 / halfZ=26），否则站在城墙内侧也会漏
  assertTrue(CASTLE_HEAL_HALF >= 26, `回血半宽 ${CASTLE_HEAL_HALF} 必须覆盖城堡占地 23×26`);
});

test('castle-heal: 中心与边界（闭区间）在范围内', () => {
  assertTrue(isInCastleHealZone(CENTER.x, CENTER.z, CENTER), '中心点必须在范围内');
  const h = CASTLE_HEAL_HALF;
  for (const [dx, dz] of [[h, 0], [-h, 0], [0, h], [0, -h], [h, h], [-h, -h]]) {
    assertTrue(isInCastleHealZone(CENTER.x + dx, CENTER.z + dz, CENTER),
      `边界 (${dx},${dz}) 必须算在范围内（闭区间）`);
  }
});

test('castle-heal: 越界一格就出范围（判据不能松到整个城区）', () => {
  const h = CASTLE_HEAL_HALF;
  assertFalse(isInCastleHealZone(CENTER.x + h + 1, CENTER.z, CENTER), `x 超 ${h + 1} 格外`);
  assertFalse(isInCastleHealZone(CENTER.x, CENTER.z + h + 1, CENTER), `z 超 ${h + 1} 格外`);
  // 城市 halfSize 实测可达 283 ⇒ 城市边缘必然在范围外（否则「回到城堡」语义消失）
  assertFalse(isInCastleHealZone(CENTER.x + 200, CENTER.z, CENTER), '城内远处不得回血');
});

test('castle-heal: 只看水平距离，不看 y（玩家在城墙上/屋顶也回血）', () => {
  // 签名里没有 y —— 这里钉的是「调用方传 2D 点」这个接口约定：
  // 多传一个 y 不影响判定（纯函数忽略多余参数），这是刻意留的余量。
  assertTrue(isInCastleHealZone(CENTER.x, CENTER.z, CENTER, CASTLE_HEAL_HALF));
});

test('castle-heal: 非法坐标/中心一律 false（不抛异常，也不静默恒真）', () => {
  const bad = [NaN, Infinity, -Infinity, undefined, null, '283', {}];
  for (const v of bad) {
    assertFalse(isInCastleHealZone(v, CENTER.z, CENTER), `x=${String(v)} 必须 false`);
    assertFalse(isInCastleHealZone(CENTER.x, v, CENTER), `z=${String(v)} 必须 false`);
  }
  assertFalse(isInCastleHealZone(CENTER.x, CENTER.z, null), 'center=null 必须 false');
  assertFalse(isInCastleHealZone(CENTER.x, CENTER.z, undefined), 'center=undefined 必须 false');
  assertFalse(isInCastleHealZone(CENTER.x, CENTER.z, { x: NaN, z: 117 }), 'center.x=NaN 必须 false');
});

test('castle-heal: 满血时 advance 不动血量', () => {
  const h = new CastleHeal();
  let hp = PLAYER_MAX_HEALTH;
  for (let i = 0; i <= 30; i += 1) hp = h.advance({ health: hp, inZone: true, nowMs: i * 100 });
  assertEqual(hp, PLAYER_MAX_HEALTH, '满血不得溢出');
  assertFalse(h.active, '满血时不得标记为回血中');
});

test('castle-heal: 100ms 回 1 格（用户裁定的速率）', () => {
  const h = new CastleHeal();
  let hp = 1;                       // 用户举例：只剩一格血
  // 首帧只建立时间基准（dt=0），不回血
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  assertEqual(hp, 1, '首帧不凭空回血');
  // 每 100ms 恰好一格
  const samples = [];
  for (let i = 1; i <= 39; i += 1) {
    hp = h.advance({ health: hp, inZone: true, nowMs: i * 100 });
    samples.push(hp);
  }
  assertEqual(samples[0], 2, '第 100ms 回 1 格 → 1→2');
  assertEqual(samples[1], 3, '第 200ms 回第 2 格');
  assertEqual(samples[8], 10, '第 900ms → 10 格');
  assertEqual(hp, PLAYER_MAX_HEALTH, '39 次 × 1 格 ⇒ 从 1 回满 40（总耗时 3.9s）');
  assertFalse(h.active, '回满后 active 转 false');
});

test('castle-heal: 从 0 血回满需要 4.0 秒（40 格 × 100ms）', () => {
  const h = new CastleHeal();
  let hp = 0;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  let ticks = 0;
  let t = 0;
  while (hp < PLAYER_MAX_HEALTH && ticks < 200) {
    t += HEAL_INTERVAL_MS;
    hp = h.advance({ health: hp, inZone: true, nowMs: t });
    ticks += 1;
  }
  assertEqual(hp, PLAYER_MAX_HEALTH, '必须回满');
  assertEqual(ticks, PLAYER_MAX_HEALTH, '格数 = tick 数（每 tick 1 格）');
  assertEqual(t, PLAYER_MAX_HEALTH * HEAL_INTERVAL_MS, '总耗时 = 40 × 100ms = 4000ms');
});

test('castle-heal: 帧间隔不是 100ms 的整数倍也不漂（余数累积，不四舍五入）', () => {
  // 60fps 的 16.7ms 帧：100ms 不是它的整数倍 —— 用「重置为 0」的实现会每格慢 ~5%
  const h = new CastleHeal();
  let hp = 0;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  let ticks = 0;
  let t = 0;
  const FRAME = 16.7;
  while (t < 4000 && ticks < 100) {
    t += FRAME;
    const next = h.advance({ health: hp, inZone: true, nowMs: t });
    ticks += next - hp;
    hp = next;
  }
  // 4000ms / 100ms = 40 格；浮点余数累积允许 ±1 格（实测 40）
  assertTrue(ticks >= 39 && ticks <= 41,
    `4 秒内应回约 40 格（实测 ${ticks}）—— 偏离说明累积方式有漂移`);
  assertEqual(hp, PLAYER_MAX_HEALTH, '4 秒内必须回满');
});

test('castle-heal: 离开城堡立刻停止并清零（回来不续上旧进度）', () => {
  const h = new CastleHeal();
  let hp = 0;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  for (let i = 1; i <= 9; i += 1) hp = h.advance({ health: hp, inZone: true, nowMs: i * 100 });
  assertEqual(hp, 9, '前置：城堡里待 900ms → 9 格');
  // 走出城堡
  hp = h.advance({ health: hp, inZone: false, nowMs: 950 });
  assertEqual(hp, 9, '离开时不回血');
  assertFalse(h.active, '离开时必须 active=false');
  for (let i = 10; i <= 20; i += 1) hp = h.advance({ health: hp, inZone: false, nowMs: i * 100 });
  assertEqual(hp, 9, '离开期间血量不变（不是暂停累积）');
  // 回来：不得一次性补上离开期间的时长（`_lastMs` 必须已清）
  hp = h.advance({ health: hp, inZone: true, nowMs: 60_000 });
  assertEqual(hp, 9, '刚回来的首帧不得瞬间回血');
  hp = h.advance({ health: hp, inZone: true, nowMs: 60_100 });
  assertEqual(hp, 10, '回来后从零累积：100ms 后回 1 格');
});

test('castle-heal: 后台切回的大步长只回 1 格（dt 上限 100ms）', () => {
  const h = new CastleHeal();
  let hp = 0;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  // 模拟标签页在后台 30 秒后回来：单帧 dt = 30000ms
  hp = h.advance({ health: hp, inZone: true, nowMs: 30_000 });
  assertEqual(hp, 1, '一帧最多回 1 格（dt 钳到 100ms），否则一帧瞬满');
});

test('castle-heal: 非法血量/时间戳不产生 NaN', () => {
  const h = new CastleHeal();
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '20']) {
    const out = h.advance({ health: bad, inZone: true, nowMs: 100 });
    assertTrue(Number.isFinite(out), `health=${String(bad)} 必须产出有限数（实测 ${out}）`);
    assertTrue(out >= 0 && out <= PLAYER_MAX_HEALTH, `health=${String(bad)} 必须落在 [0,${PLAYER_MAX_HEALTH}]`);
  }
  const h2 = new CastleHeal();
  const out = h2.advance({ health: 10, inZone: true, nowMs: NaN });
  assertEqual(out, 10, 'nowMs=NaN 时不回血（不得靠 NaN 累积）');
});

test('castle-heal: 血量钳制在 [0, maxHealth]（越界输入不放大）', () => {
  const h = new CastleHeal();
  assertEqual(h.advance({ health: 999, inZone: true, nowMs: 0 }), PLAYER_MAX_HEALTH, '超过上限按满血');
  const h2 = new CastleHeal();
  const neg = h2.advance({ health: -5, inZone: true, nowMs: 0 });
  assertEqual(neg, 0, '负血钳到 0，不是负数');
});

test('castle-heal: 满血后清余数（HUD 不多亮一拍）', () => {
  const h = new CastleHeal();
  let hp = PLAYER_MAX_HEALTH - 1;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  hp = h.advance({ health: hp, inZone: true, nowMs: 100 });
  assertEqual(hp, PLAYER_MAX_HEALTH, '回满');
  // 再喂 90ms 的余量：不得因为余数还在而在下次受伤后立刻回血
  h.advance({ health: hp, inZone: true, nowMs: 190 });
  hp = 30;   // 假设挨打掉到 30
  hp = h.advance({ health: hp, inZone: true, nowMs: 200 });
  assertEqual(hp, 30, '回满后余数已清 ⇒ 重新受伤时不立即回血');
});

test('castle-heal: reset() 清时间基准（传送/离开场景）', () => {
  const h = new CastleHeal();
  let hp = 0;
  h.advance({ health: hp, inZone: true, nowMs: 0 });
  hp = h.advance({ health: hp, inZone: true, nowMs: 100 });
  assertEqual(hp, 1, '前置：回了 1 格');
  h.reset();
  hp = h.advance({ health: hp, inZone: true, nowMs: 50_000 });
  assertEqual(hp, 1, 'reset 后首帧不回血（dt 基准已清）');
});

test('castle-heal: totalHealed 只统计真实写入的格数（不超上限）', () => {
  const h = new CastleHeal();
  let hp = PLAYER_MAX_HEALTH - 2;
  hp = h.advance({ health: hp, inZone: true, nowMs: 0 });
  for (let i = 1; i <= 10; i += 1) hp = h.advance({ health: hp, inZone: true, nowMs: i * 100 });
  assertEqual(hp, PLAYER_MAX_HEALTH, '回满');
  assertEqual(h.totalHealed, 2, `只回 2 格（实测统计 ${h.totalHealed}）—— 满血后不得继续计数`);
});