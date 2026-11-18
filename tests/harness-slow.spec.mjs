import { test, expect } from 'playwright/test';

// tests/harness-slow.spec.mjs — 浏览器内单测的**慢档**（全量 GEN 扫描，v3.15）
//
// **为什么它必须存在、且必须是普通 spec**：
// 最慢 6 条用例占整页 59% 时间（98.8s / 167.5s，实测）。日常门不该付这个钱，
// 但**提交前门不能丢这些判据** —— 否则就是「把最重的判据搬进一个默认不跑的入口」，
// 与「零判别力损失」直接冲突（本仓有先例：giant-tree-budget.spec 静默红六天，
// 就因为 `npm run check` 不跑它）。
//
// 做法：慢档用例用 `test(name, fn, { tier: 'slow' })` 注册，本 spec 以 `?tier=slow` 跑它们。
// 它是 `tests/` 下的普通 spec ⇒ `playwright test` **天然收集** ⇒ `npm test` 覆盖只增不减。
//
// ⚠️ 本 spec 在慢档用例尚未标注前会「过滤后为空」⇒ runner 硬失败。
// 那是**正确的**：空集合不得当成全绿（见 test-runner-tiers.js 的同名判据）。

test('浏览器内单测慢档：全量 GEN 扫描 0 失败', async ({ page }) => {
  // 全量 GEN 实测最慢单条 37.5s，六条合计 98.8s；窗口给 600s（负载余量，非放宽断言）
  test.setTimeout(700_000);
  await page.goto('/src/tests/index.html?tier=slow');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 600_000 });
  const r = await page.evaluate(() => window.__MC_TEST_RESULTS__);

  expect(r.selectionError ?? null, '分档参数不得失配').toBeNull();
  expect(r.failed, '慢档必须 0 失败').toBe(0);
  expect(r.total, '慢档必须真的跑到用例（空集合不得当全绿）').toBeGreaterThan(0);
  // 慢档的每个 suite 都必须真的是 slow 档（防「把 fast 用例误标成 slow 混进来」）
  const tiers = await page.evaluate(() => window.__MC_TEST_RESULTS__.suites.map((s) => s.tier));
  expect([...new Set(tiers)], '跑到的必须全是 slow 档').toEqual(['slow']);
});