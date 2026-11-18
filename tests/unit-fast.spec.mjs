import { test, expect } from 'playwright/test';
import { UNIT_LIGHT, UNIT_GROUPS } from '../tools/test-tiers.mjs';

// tests/unit-fast.spec.mjs — 浏览器内单测的**轻档**入口（v3.15，日常门）
//
// 与 `harness.spec.mjs` 的分工：
//   · harness    —— 默认档全集（含重 GEN 的抽样版），里程碑/提交前门
//   · 本 spec    —— 只跑轻档（白名单 − 6 个重 GEN 文件），日常改动的快速回归
//   · harness-slow —— 全量 GEN 扫描（`?tier=slow`），提交前门仍跑
//
// ⚠️ **三条防空转判据缺一不可**（docs/testing-policy.md §2.7「静默不跑」类）：
//   ① `failed === 0`；
//   ② **实际跑到的文件集合 ≡ 轻档清单** —— 只看 `total > 0` 时「少跑 90 个文件」仍全绿；
//   ③ `selectionError` 必须为空 —— runner 对未知文件名/空集合硬失败并写这个字段，
//      不检查它的话「配置拼错」会伪装成「用例通过」。
//
// ⚠️ **清单从 tools/test-tiers.mjs 读**（唯一权威），不在本文件写第二份。

test('浏览器内单测轻档：0 失败且跑到的文件集合 ≡ 轻档清单', async ({ page }) => {
  // 轻档实测（Node 侧串行）94 文件 1910 例 36.0s；浏览器侧同量级。
  // 窗口取 150s 与 harness 同口径（负载波动余量），**不是因为断言放宽**。
  test.setTimeout(200_000);
  // 档位清单经 addInitScript 注入，页面侧 runner 用它展开 `only=light`
  await page.addInitScript((groups) => { window.__MC_TEST_GROUPS__ = groups; }, UNIT_GROUPS);
  await page.goto('/src/tests/index.html?only=light');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 150_000 });
  const r = await page.evaluate(() => window.__MC_TEST_RESULTS__);

  expect(r.selectionError ?? null, '分档参数不得失配（拼错会静默少跑）').toBeNull();
  expect(r.failed, '轻档必须 0 失败').toBe(0);
  expect(r.total, '必须真的跑到用例').toBeGreaterThan(0);
  // ② 集合相等（双向）：漏跑与多跑都要红
  expect([...r.files].sort(), '实际跑到的文件集合必须 ≡ 轻档清单').toEqual([...UNIT_LIGHT].sort());
});