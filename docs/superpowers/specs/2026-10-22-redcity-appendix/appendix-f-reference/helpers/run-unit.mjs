// 可选辅助（不入仓库的构建链，勿提交）：跑浏览器内单测页，打印失败项与总数。
// 用法：node run-unit.mjs <端口> <超时毫秒> [用例标题过滤正则]
//   例：node run-unit.mjs 8081 60000            → 只列失败项 + 末行 RESULT total=N passed=N failed=N
//       node run-unit.mjs 8081 60000 "RedCity"   → 列出标题匹配的全部用例（含通过的）
// 末行 NO_RESULT = 页面没暴露 __MC_TEST_RESULTS__（通常是某个 import 失败导致整页模块加载中止 = RED 的「页面中止」形态）。
// 需要先 `npm start`（8081）；从仓库内任意位置运行均可（bare import 从本文件向上解析到仓库的 node_modules）。
import { chromium } from 'playwright';

const port = process.argv[2] || '8081';
const timeout = Number(process.argv[3] || 60000);
const filter = process.argv[4] ? new RegExp(process.argv[4]) : null;

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 240)); });
await page.goto(`http://localhost:${port}/src/tests/index.html`);
let ok = true;
try { await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout }); } catch { ok = false; }
if (ok) {
  const rs = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  for (const s of rs.suites) {
    for (const t of s.tests) {
      if (filter && !filter.test(t.name)) continue;
      if (t.status !== 'passed' || filter) console.log(`${t.status === 'passed' ? '✓' : '✗'} ${t.name.slice(0, 110)}${t.error ? '\n      ' + String(t.error).slice(0, 300) : ''}`);
    }
  }
  console.log(`RESULT total=${rs.total} passed=${rs.passed} failed=${rs.failed}`);
} else {
  console.log('NO_RESULT');
  if (errors.length) console.log('页面错误: ' + [...new Set(errors)].slice(0, 3).join(' | '));
}
await browser.close();
