import { test, expect } from 'playwright/test';

test('浏览器测试 harness 正常运行且 0 失败', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  // ⚠️ **窗口 150s（was 90s，再之前 30s）**：该值是被实测逼上来的一次性重标定，不是放宽门槛。
  // 历次重标（每次都附实测值，勿凭感觉改）：
  //   · 30s → 90s（2026-10-29）：干净 HEAD（c5adae2）整页就已 43.9s，v2.7 竞技场后 46.6s。
  //   · 90s → **150s**（2026-11-09，v2.85 大竞技场）：整页实测 **75.9s**（1836 例）。
  //     新增的 20 个大竞技场用例里有 5 个走**真实 column GEN**，每个都要对 115,381 格的
  //     产物做光栅化（占地跨 36 个 column），把套件从 63.6s 推到 75.9s ⇒ 90s 余量只剩
  //     1.19 倍，实测连吃两次超时。150s 取「实测 75.9s × ~2」，与历次重标同一口径。
  // ⚠️ **改这里必须同步 `playwright.config.mjs` 的全局 `timeout`**（AGENTS.md 已记该坑）：
  // 全局值小于本窗口时会**先触发**，spec 内的 150s 永远没机会生效，而报错文案是
  // 「Test timeout of Nms exceeded」，看起来像用例真的卡住。
  // ⚠️ **断言本身一个字未动**（`total > 0` / `failed === 0`），改的只是等待窗口 ——
  // 浏览器内用例失败仍然会让本用例红。
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 150_000 });
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.total).toBeGreaterThan(0);
  expect(results.failed).toBe(0);
});
