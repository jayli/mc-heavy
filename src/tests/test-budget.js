// M3-2 预算参数标定（60Hz/120Hz 双档，roadmap Task M3-2 / 设计文档 §4.9 高刷适配）
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { BUDGET_PROFILES, detectRefreshHint, BudgetConfig } from '../core/budget.js';

test('budget: 双档冻结数值（120Hz=3/64，60Hz=6/128）', () => {
  assertEqual(BUDGET_PROFILES.high.meshUploadBudgetMs, 3);
  assertEqual(BUDGET_PROFILES.high.meshDispatchPerFrame, 64);
  assertEqual(BUDGET_PROFILES.low.meshUploadBudgetMs, 6);
  assertEqual(BUDGET_PROFILES.low.meshDispatchPerFrame, 128);
});

test('budget: detectRefreshHint 读 matchMedia(min-refresh-rate:120hz)', () => {
  const hit = detectRefreshHint({ matchMedia: (q) => ({ matches: q === '(min-refresh-rate: 120hz)' }) });
  assertEqual(hit, 'high');
  const miss = detectRefreshHint({ matchMedia: () => ({ matches: false }) });
  assertEqual(miss, null); // false 不可信（Chromium 不支持该 feature）→ 交由运行时测量
  const none = detectRefreshHint({});
  assertEqual(none, null);
});

test('budget: 显式 profile 立即生效，observeFrame 不改变', () => {
  const b = new BudgetConfig({ profile: 'low' });
  assertEqual(b.resolved, 'low');
  assertEqual(b.meshUploadBudgetMs, 6);
  assertEqual(b.meshDispatchPerFrame, 128);
  for (let i = 0; i < 200; i++) b.observeFrame(8.3);
  assertEqual(b.resolved, 'low'); // 显式档位不受运行时测量影响
  b.setProfile('high');
  assertEqual(b.meshUploadBudgetMs, 3);
  b.setProfile('low');
  assertEqual(b.meshDispatchPerFrame, 128);
});

test('budget: matchMedia 命中 high → auto 直接判 high', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: 'high' });
  assertEqual(b.resolved, 'high');
  assertEqual(b.meshUploadBudgetMs, 3);
});

test('budget: auto 未定档时默认 high 口径（§4.9 按 8.3ms 标定）', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  assertEqual(b.resolved, 'pending');
  assertEqual(b.meshUploadBudgetMs, 3);
  assertEqual(b.meshDispatchPerFrame, 64);
});

test('budget: auto 运行时测量——120Hz 帧间隔判 high（快帧比例判据）', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  for (let i = 0; i < 120; i++) b.observeFrame(8.3 + (i % 3) * 0.2);
  assertEqual(b.resolved, 'high');
  assertEqual(b.meshUploadBudgetMs, 3);
});

test('budget: 120Hz 重负载（帧间隔量化到 16.7/25ms 但偶发快帧）仍判 high', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  // 模拟启动 burst：90% 帧 16.7/25ms（vsync 量化），10% 帧 8.3ms
  for (let i = 0; i < 120; i++) b.observeFrame(i % 10 === 0 ? 8.3 : (i % 2 ? 16.7 : 25));
  assertEqual(b.resolved, 'high');
});

test('budget: auto 运行时测量——60Hz 帧间隔判 low（零快帧）', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  for (let i = 0; i < 120; i++) b.observeFrame(16.7 + (i % 3) * 0.2);
  assertEqual(b.resolved, 'low');
  assertEqual(b.meshUploadBudgetMs, 6);
  assertEqual(b.meshDispatchPerFrame, 128);
});

test('budget: auto 判档一次后锁定（防震荡），样本窗口有界', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  for (let i = 0; i < 120; i++) b.observeFrame(16.7);
  assertEqual(b.resolved, 'low');
  for (let i = 0; i < 5000; i++) b.observeFrame(8.3); // 后续快帧不再翻转
  assertEqual(b.resolved, 'low');
  assertTrue(b._samples === null, '判档后样本释放');
});

test('budget: 模糊区（零星快帧 <5%）保持未定档且窗口有界', () => {
  const b = new BudgetConfig({ profile: 'auto', hint: null });
  for (let i = 0; i < 600; i++) b.observeFrame(i % 119 === 0 ? 10 : 16.7); // 快帧 ~0.8% < 5%
  assertEqual(b.resolved, 'pending');
  assertEqual(b.meshUploadBudgetMs, 3); // 未定档维持 high 默认
  assertTrue(b._samples && b._samples.n <= 120, '样本窗口有界');
});
