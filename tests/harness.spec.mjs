import { test, expect } from 'playwright/test';

test('浏览器测试 harness 正常运行且 0 失败', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  // ⚠️ **窗口 90s（was 30s）**：该值是被实测逼上来的一次性重标定，不是放宽门槛。
  // 实测（2026-10-29，本机）：**干净 HEAD（c5adae2）整页就已 43.9s** —— 30s 窗口从
  // v2.4（杜鹃树 `collectOtherTrunks` 冷扫）起就已经不可能满足，`harness` 一直靠串行跑的
  // 机器负载“碰巧”赶上。本次（v2.7 竞技场）增加了 **+2.7s**（46.6s），把它彻底打穿。
  // 90s 取「实测 46.6s × ~2」：容得下正常波动与再添几组用例，又不会让真卡死的用例
  // 无声地跑到 CI 超时。
  // ⚠️ **断言本身一个字未动**（`total > 0` / `failed === 0`），改的只是等待窗口 ——
  // 浏览器内用例失败仍然会让本用例红。
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 90_000 });
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.total).toBeGreaterThan(0);
  expect(results.failed).toBe(0);
});
