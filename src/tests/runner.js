// src/tests/runner.js
/**
 * 测试运行器
 * 提供测试套件的注册、执行功能（移植自 mc-lite，删除 DOM 报告部分，
 * 保留 runAllTests 返回结构 { suites, passed, failed, total, duration, passRate }）
 *
 * v3.15 分档执行（docs/superpowers/specs/2026-11-18-test-tiering-and-runtime-design.md）：
 *   · 每个 suite 带**文件归属**（`file`）与**档位**（`tier`，缺省 fast）
 *   · `?only=<文件名|档位名,…>` 与 `?tier=fast|slow|all` 只过滤**执行**，不过滤 import
 *     —— 实测六个重 GEN 文件 import 期合计仅 209ms 而执行期 217.7s，成本全在 test 体内，
 *     故 `index.html` 的静态 import 清单一字不改（`check:data` 的注册门因此不受影响）。
 *   · **失配一律硬失败**：未知文件名/档位名、过滤后为空都抛错。
 *     否则「少跑 2000 例仍 failed===0」= 静默不跑，比测试失败更危险。
 */

import { AssertionError } from './assert.js';

// 全局测试状态
const testResults = {
  passed: 0,
  failed: 0,
  suites: []
};

// 当前测试套件
let currentSuite = null;

/** 显式指定的当前文件（Node 快档逐文件 import 时设它；浏览器侧走栈解析） */
let currentFile = null;

/**
 * 从调用栈里取**最外层**的测试文件名。
 *
 * ⚠️ **取最外层而不是第一个**（实测）：若用例在 helper 文件里注册，栈是
 * `[helper.js, owner.js]` —— 取第一个会归到 helper（错），取最外层得 owner（对）。
 * 当前仓内无跨文件注册，这一条是防将来静默归错。
 *
 * 两侧栈格式都带模块 URL（实测）：
 *   浏览器 `at http://host/src/tests/test-x.js:3:17`
 *   Node    `at file:///repo/src/tests/test-x.js:9:16`
 */
function fileFromStack() {
  const lines = (new Error().stack || '').split('\n');
  let found = null;
  for (const line of lines) {
    const m = line.match(/\/src\/tests\/((?:test|tmp)-[^:?)]+\.js)/);
    if (m) found = m[1];   // 不 break：一路覆盖到最外层
  }
  return found;
}

/** 供 Node 快档显式声明「接下来注册的用例属于哪个文件」 */
export function setCurrentFile(name) {
  currentFile = name;
}

/**
 * 只读注册表快照（不执行任何用例）。
 *
 * 用途：① Node 快档做 per-file 例数对账；② 分档器自测钉「文件归属真的生效」。
 * ⚠️ **自测不得用 `runAllTests()` 观测自己**（实测踩过）：用例本身就在 runAllTests 里，
 * 内层再跑会递归执行包括自己在内的全部 suite ⇒ 4GB 堆 OOM。
 */
export function getRegisteredSuites() {
  return testResults.suites.map((s) => ({ name: s.name, file: s.file, tier: s.tier, count: s.tests.length }));
}

/** 解析 URL 查询串里的分档参数（纯函数，可单测；不读全局 location） */
export function parseTierQuery(search) {
  const q = new URLSearchParams(search || '');
  const only = (q.get('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const tier = q.get('tier') || 'fast';
  return { only, tier };
}

/**
 * 按 only/tier 选出要跑的 suite。**失配硬失败**。
 *
 * @param {Array} suites 全部已注册 suite（每个带 file / tier）
 * @param {{only: string[], tier: string}} sel
 * @param {Record<string, string[]>} groups 档位名 → 文件名清单（可空）
 * @returns {Array} 选中的 suite
 */
export function selectSuites(suites, sel, groups = {}) {
  const { only, tier } = sel;
  if (!['fast', 'slow', 'all'].includes(tier)) {
    throw new Error(`未知 tier "${tier}"（只接受 fast / slow / all）`);
  }
  // only 里的每一项必须是「已知档位名」或「已注册的文件名」
  const knownFiles = new Set(suites.map((s) => s.file).filter(Boolean));
  const expanded = [];
  for (const token of only) {
    if (groups[token]) expanded.push(...groups[token]);
    else if (knownFiles.has(token)) expanded.push(token);
    else throw new Error(`only 里的 "${token}" 既不是档位名也不是已注册的测试文件`
      + ` —— 拼错会静默少跑用例，故硬失败`);
  }
  const wantFiles = expanded.length ? new Set(expanded) : null;
  const picked = suites.filter((s) => {
    if (wantFiles && !wantFiles.has(s.file)) return false;
    if (tier !== 'all' && (s.tier || 'fast') !== tier) return false;
    return true;
  });
  if (!picked.length) {
    throw new Error(`过滤后没有任何用例可跑（only=${JSON.stringify(only)} tier=${tier}）`
      + ' —— 空集合不得当成全绿');
  }
  // only 指定了文件却因 tier 不符而一个都没跑到 ⇒ 也要硬失败（防「指定了慢档文件但忘了 tier=slow」）
  if (wantFiles) {
    const ranFiles = new Set(picked.map((s) => s.file));
    const missing = [...wantFiles].filter((f) => !ranFiles.has(f));
    if (missing.length) {
      throw new Error(`only 指定的这些文件在 tier=${tier} 下没有用例被跑到：${missing.join(', ')}`
        + ' —— 若它们属慢档请显式加 ?tier=slow 或 ?tier=all');
    }
  }
  return picked;
}

/**
 * 测试套件类
 */
class TestSuite {
  constructor(name, file = null, tier = 'fast') {
    this.name = name;
    this.file = file;
    this.tier = tier;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.results = [];
  }

  addTest(name, fn) {
    this.tests.push({ name, fn });
  }
}

/**
 * 定义一个测试套件
 * @param {string} name - 套件名称
 * @param {Function} fn - 套件函数，接收 test 参数
 * @param {{tier?: 'fast'|'slow'}} [opts] - 档位（缺省 fast）
 */
export function describe(name, fn, opts = {}) {
  const suite = new TestSuite(name, currentFile || fileFromStack(), opts.tier || 'fast');
  currentSuite = suite;

  // 提供 test 函数给套件函数使用
  const test = (testName, testFn) => {
    suite.addTest(testName, testFn);
  };

  fn(test);
  testResults.suites.push(suite);
  currentSuite = null;
}

/**
 * 定义一个测试用例
 * @param {string} name - 测试名称
 * @param {Function} fn - 测试函数
 * @param {{tier?: 'fast'|'slow'}} [opts] - 档位（缺省 fast；慢档用 ?tier=slow 才跑）
 */
export function test(name, fn, opts = {}) {
  if (currentSuite) {
    currentSuite.addTest(name, fn);
  } else {
    // 裸 test()：每条自成一个 suite，名字用**文件名**（取不到时回落 Default Suite）
    // —— 原先全叫 'Default Suite'，整页失败时看不出是哪个文件，也无法按文件过滤。
    const file = currentFile || fileFromStack();
    const suite = new TestSuite(file || 'Default Suite', file, opts.tier || 'fast');
    suite.addTest(name, fn);
    testResults.suites.push(suite);
  }
}

/**
 * 运行单个测试
 * @param {Object} testObj - 测试对象 {name, fn}
 * @returns {Promise<Object>} 测试结果
 */
async function runSingleTest(testObj) {
  const startTime = performance.now();

  try {
    await testObj.fn();
    const endTime = performance.now();

    return {
      name: testObj.name,
      status: 'passed',
      duration: endTime - startTime,
      error: null
    };
  } catch (error) {
    const endTime = performance.now();

    return {
      name: testObj.name,
      status: 'failed',
      duration: endTime - startTime,
      error: error instanceof AssertionError ? error.message : error.toString()
    };
  }
}

/**
 * 运行测试套件
 * @param {TestSuite} suite - 测试套件
 * @returns {Promise<Object>} 套件执行结果
 */
async function runSuite(suite) {
  const results = {
    name: suite.name,
    file: suite.file,
    tier: suite.tier,
    tests: [],
    passed: 0,
    failed: 0,
    duration: 0
  };

  const suiteStartTime = performance.now();

  for (const testObj of suite.tests) {
    const result = await runSingleTest(testObj);
    results.tests.push(result);

    if (result.status === 'passed') {
      results.passed++;
    } else {
      results.failed++;
    }
  }

  results.duration = performance.now() - suiteStartTime;
  suite.passed = results.passed;
  suite.failed = results.failed;
  suite.results = results.tests;

  return results;
}

/**
 * 运行已注册的测试
 *
 * @param {{only?: string[], tier?: string, groups?: Record<string,string[]>}} [sel]
 *   缺省从 `location.search` 读（浏览器）；Node 侧无 location ⇒ 缺省全跑。
 *   显式传入时以它为准（Node 快档与单测用）。
 * @returns {Promise<Object>} 总体测试结果
 */
export async function runAllTests(sel = null) {
  // 重置结果
  testResults.passed = 0;
  testResults.failed = 0;

  const selection = sel
    ? { only: sel.only || [], tier: sel.tier || 'all', groups: sel.groups || {} }
    : (typeof location !== 'undefined'
      ? { ...parseTierQuery(location.search), groups: (typeof window !== 'undefined' && window.__MC_TEST_GROUPS__) || {} }
      : { only: [], tier: 'all', groups: {} });
  // ⚠️ 浏览器缺省 tier=fast（日常门），Node/显式缺省 all（不漏跑）
  const chosen = selectSuites(testResults.suites, selection, selection.groups);

  const allResults = [];
  const totalStartTime = performance.now();

  for (const suite of chosen) {
    const suiteResults = await runSuite(suite);
    allResults.push(suiteResults);
    testResults.passed += suiteResults.passed;
    testResults.failed += suiteResults.failed;
  }

  const totalDuration = performance.now() - totalStartTime;

  return {
    suites: allResults,
    passed: testResults.passed,
    failed: testResults.failed,
    total: testResults.passed + testResults.failed,
    duration: totalDuration,
    // 分档对账用：实际跑到的文件集 / 档位 / 注册总数（spec 钉「≡ 清单」靠它）
    selection: { only: selection.only, tier: selection.tier },
    files: [...new Set(allResults.map((s) => s.file).filter(Boolean))].sort(),
    registered: testResults.suites.reduce((n, s) => n + s.tests.length, 0),
    passRate: testResults.passed + testResults.failed > 0
      ? ((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(2)
      : 0
  };
}

// 供 Playwright 读取的机器可读结果
// ⚠️ **失败也要 expose**：`?only=` 失配时 selectSuites 抛错，若不写 window 则 spec 只能
// 看到「等 RESULTS 超时」—— 报错文案会把「配置拼错」伪装成「用例卡死」（本仓踩过同类坑）。
export async function runAndExpose() {
  try {
    const results = await runAllTests();
    window.__MC_TEST_RESULTS__ = results;
    return results;
  } catch (err) {
    window.__MC_TEST_RESULTS__ = {
      suites: [], passed: 0, failed: 1, total: 1, duration: 0, passRate: '0.00',
      selectionError: String(err && err.message || err),
    };
    throw err;
  }
}
