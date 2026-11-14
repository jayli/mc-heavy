// src/tests/test-load-progress.js — 启动进度三阶段合成（v2.99）
//
// 失效形态（为什么必须单测）：**进度条撒谎不会让任何功能失败**，只会让玩家判断错 ——
//
//   ① P1 用 `n/total`：模块总数事前不可知（浏览器边解析边发现），分母只能猜；
//      猜错了进度条会在某个值上永久冻住，看着像卡死。
//   ② 阶段切换不取历史最大值：P1 渐近到 0.44 → 进 P2 从 0 起算 ⇒ 总进度**倒退**，
//      玩家以为重新开始加载。
//   ③ 百分比直接 `Math.round` 而不夹：99.6 → 100%（还没好），100.00000001 → 100.00000001%。
//
// 三者都不会红任何既有断言，故用纯函数单测钉住。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  PHASE_WEIGHTS, p1Fraction, p2Fraction, createProgressReporter, formatPercent,
  p2DisplayFraction, shouldShowStallPanel,
} from '../core/load-progress.js';

test('LoadProgress: 三阶段权重之和为 1', () => {
  assertEqual(PHASE_WEIGHTS.p1 + PHASE_WEIGHTS.p2 + PHASE_WEIGHTS.p3, 1);
});

test('LoadProgress: p1Fraction 是单调渐近曲线（24→0.5，72→0.75）', () => {
  assertEqual(p1Fraction(0), 0);
  assertEqual(p1Fraction(24), 0.5);
  assertEqual(p1Fraction(72), 0.75);
  // 严格递增，且永不达 1（还得留给 p2/p3）
  let prev = -1;
  for (const n of [1, 10, 24, 50, 100, 200, 874]) {
    const v = p1Fraction(n);
    assertTrue(v > prev, `n=${n} 必须比前一个大（实测 ${v} vs ${prev}）`);
    assertTrue(v < 1, `n=${n} 不得达到 1`);
    prev = v;
  }
});

test('LoadProgress: p2Fraction 用 (2vd+1)^2 作分母（实测 vd=2 → 25）', () => {
  assertEqual(p2Fraction(0, 25), 0);
  assertEqual(p2Fraction(23, 25), 23 / 25);
  assertEqual(p2Fraction(25, 25), 1);
  assertEqual(p2Fraction(30, 25), 1, '超出分母必须夹到 1，不得 >1');
  assertEqual(p2Fraction(5, 0), 0, '分母为 0 时返回 0（不产生 NaN）');
});

test('LoadProgress: 总百分比单调不倒退（阶段切换时取历史最大值）', () => {
  const r = createProgressReporter();
  r.report('p1', 0.9);              // 0.9 × 0.45 = 0.405
  const a = r.percent();
  assertTrue(Math.abs(a - 40.5) < 1e-9, `p1 0.9 → 40.5%，实际 ${a}`);
  // 阶段切换：P2 的基线本来就是 P1 的权重（0.45），所以这里会**前进**到 45%。
  // ⚠️ 本用例钉的是「不倒退」（`>=`），不是「不变」（`===`）。
  // 写 `===` 会与 DR-2 的权重定义直接冲突（P1 权权重 45% 就是 P2 的起点），
  // 且会把「前进到 45%」误判为缺陷。实测踩到过：断言报 `Expected 40.5, got 45`。
  r.report('p2', 0.0);
  assertEqual(r.percent(), 45, 'P2 起点 = P1 权重 45%（不是 0，也不是 40.5）');
  assertTrue(r.percent() >= a, '阶段切换不得让百分比倒退');
  r.report('p2', 0.5);              // 0.45 + 0.5 × 0.45 = 0.675
  assertTrue(r.percent() > 45, '真进展必须前进');
  assertTrue(Math.abs(r.percent() - 67.5) < 1e-9, `p2 0.5 → 67.5%，实际 ${r.percent()}`);
  r.report('p3', 1);
  assertEqual(r.percent(), 100, '三阶段全满 → 100');
});

test('LoadProgress: report 记录当前阶段与细节文案', () => {
  const r = createProgressReporter();
  r.report('p1', 0.2, '正在加载脚本 120 个');
  assertEqual(r.phase(), 'p1');
  assertEqual(r.detail(), '正在加载脚本 120 个');
  r.report('p2', 0.1, '正在生成世界 3/25');
  assertEqual(r.detail(), '正在生成世界 3/25');
});

test('LoadProgress: reset() 清空历史最大值（换世界重建时才用）', () => {
  const r = createProgressReporter();
  r.report('p1', 0.9);
  const high = r.percent();
  r.reset();
  assertEqual(r.percent(), 0, 'reset 后归零');
  assertTrue(high > 0);
});

test('LoadProgress: formatPercent 取整并夹到 100', () => {
  assertEqual(formatPercent(0), '0%');
  assertEqual(formatPercent(42.4), '42%');
  assertEqual(formatPercent(99.6), '100%');
  assertEqual(formatPercent(100.00000001), '100%');
});

/**
 * v2.99 实测缺陷的回归（缺陷 A，见 ledger）：P2 阶段进度条曾冻在 39.2%，而资源一直在下载。
 *
 * 成因：`loadingPhase` 切到 'p2' 后只算 `p2Fraction(ready, total)`，而慢网络下
 * `scheduler.stats().ready` 长期为 0（GEN 要等 Worker 模块图到齐才跑）——
 * 于是资源从 161 个涨到 852 个，进度条一个字没动。
 *
 * 判据：**P2 阶段显示值必须至少反映已下载的脚本量**，且随 js 增长而前进。
 */
test('LoadProgress: p2DisplayFraction 在 GEN 未就绪时仍随脚本下载前进（缺陷 A 回归）', () => {
  const total = 25; // vd=2
  // GEN 一列都没好，但脚本在下：显示值必须 > 0 且随 js 增长
  const a = p2DisplayFraction({ jsLoaded: 100, readyColumns: 0, totalColumns: total });
  const b = p2DisplayFraction({ jsLoaded: 400, readyColumns: 0, totalColumns: total });
  const c = p2DisplayFraction({ jsLoaded: 800, readyColumns: 0, totalColumns: total });
  assertTrue(a > 0, `js=100 时显示值必须 > 0（不能像缺陷那样冻在 0），实际 ${a}`);
  assertTrue(b > a, 'js 增长必须让显示值前进');
  assertTrue(c > b, 'js 继续增长必须继续前进');
  // 且不得越过 P1+P2 的权重和（0.45 + 0.45）之外的错误值：这里返回的是**阶段内**归一值
  assertTrue(c <= 1, `阶段内归一值不得超过 1，实际 ${c}`);
});

test('LoadProgress: p2DisplayFraction 取 P1/P2 的较大者（GEN 先就绪时不倒退）', () => {
  // GEN 全好（P2=1）、脚本很少：必须取 1，而不是被 P1 的小值拖下来
  assertEqual(p2DisplayFraction({ jsLoaded: 0, readyColumns: 25, totalColumns: 25 }), 1);
  // 两边都半程：取较大者
  const byGen = p2Fraction(20, 25);          // 0.8
  const byDl = p1Fraction(200);              // ~0.893
  assertEqual(
    p2DisplayFraction({ jsLoaded: 200, readyColumns: 20, totalColumns: 25 }),
    Math.max(byDl, byGen),
  );
});

/**
 * 网络恢复后 stall 面板必须自动让位（v2.99 自审发现的 UX 缺陷）。
 *
 * 失效形态：`stallShown` 只在玩家点「继续等待」时复位 ⇒ 网络恢复、进度继续前进，
 * 面板仍显示「网络似乎已断开 · 已等待 60 秒无进展」—— 那是一句**过时的谎话**，
 * 而本 Epic 的全部意义就是不给玩家误导性诊断。
 *
 * 判据：进度真的前进了（js 增长）就必须收起面板，无论玩家是否点过按钮。
 */
test('LoadProgress: 进度前进后 stall 面板必须收起（网络恢复要不留误导）', () => {
  // 刚判 stall、之后零进展：保持展示
  assertEqual(shouldShowStallPanel({ stalled: true, jsGrewSinceStall: false }), true);
  // 判 stall 之后进度前进了：必须收起
  assertEqual(shouldShowStallPanel({ stalled: true, jsGrewSinceStall: true }), false);
  // 从未 stall：不展示
  assertEqual(shouldShowStallPanel({ stalled: false, jsGrewSinceStall: false }), false);
  assertEqual(shouldShowStallPanel({ stalled: false, jsGrewSinceStall: true }), false);
});
