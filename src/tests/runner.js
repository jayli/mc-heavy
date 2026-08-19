// src/tests/runner.js
/**
 * 测试运行器
 * 提供测试套件的注册、执行功能（移植自 mc-lite，删除 DOM 报告部分，
 * 保留 runAllTests 返回结构 { suites, passed, failed, total, duration, passRate }）
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

/**
 * 测试套件类
 */
class TestSuite {
  constructor(name) {
    this.name = name;
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
 */
export function describe(name, fn) {
  const suite = new TestSuite(name);
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
 */
export function test(name, fn) {
  if (currentSuite) {
    currentSuite.addTest(name, fn);
  } else {
    // 如果没有套件，创建一个默认套件
    const suite = new TestSuite('Default Suite');
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
 * 运行所有注册的测试
 * @returns {Promise<Object>} 总体测试结果
 */
export async function runAllTests() {
  // 重置结果
  testResults.passed = 0;
  testResults.failed = 0;

  const allResults = [];
  const totalStartTime = performance.now();

  for (const suite of testResults.suites) {
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
    passRate: testResults.passed + testResults.failed > 0
      ? ((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(2)
      : 0
  };
}

// 供 Playwright 读取的机器可读结果
export async function runAndExpose() {
  const results = await runAllTests();
  window.__MC_TEST_RESULTS__ = results;
  return results;
}
