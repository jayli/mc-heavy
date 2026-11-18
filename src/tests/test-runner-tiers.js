// src/tests/test-runner-tiers.js — 分档执行器的 Tier 1 契约（v3.15）
//
// **为什么这个文件必须存在**：runner 是门禁本身的机制。它错了会「放行错误」——
// 最危险的形态是 `?only=` 拼错一个名字 ⇒ 少跑两千例而 `failed===0` 依旧全绿
// （docs/testing-policy.md §2.7 的「静默不跑」类）。故失配必须硬失败，且要有断言钉住。
//
// 判据一律落在**纯函数** `parseTierQuery` / `selectSuites` 上（不依赖真 location），
// 另有一条钉「真实注册路径的文件归属」——那是 `?only=` 能工作的前提。
import { test, parseTierQuery, selectSuites, getRegisteredSuites } from './runner.js';
import { assertEqual, assertTrue, assertThrows, assertDeepEqual } from './assert.js';

/** 造一批带文件归属与档位的假 suite（只含 selectSuites 消费的字段） */
const fake = (file, tier = 'fast', n = 1) => ({ file, tier, tests: new Array(n).fill(0) });

test('runner 分档: parseTierQuery 解析 only 与 tier，缺省 tier=fast', () => {
  assertDeepEqual(parseTierQuery(''), { only: [], tier: 'fast' });
  assertDeepEqual(parseTierQuery('?only=test-mesher.js,test-physics.js'),
    { only: ['test-mesher.js', 'test-physics.js'], tier: 'fast' });
  // 空项与空格要被清掉（'?only=a,,b,' 这种手写串很常见）
  assertDeepEqual(parseTierQuery('?only=a,,%20b%20,'), { only: ['a', 'b'], tier: 'fast' });
  assertDeepEqual(parseTierQuery('?tier=slow'), { only: [], tier: 'slow' });
  assertDeepEqual(parseTierQuery('?tier=all&only=x.js'), { only: ['x.js'], tier: 'all' });
});

test('runner 分档: 缺省只跑 fast，slow 用例默认不跑', () => {
  const suites = [fake('a.js'), fake('b.js', 'slow')];
  const picked = selectSuites(suites, { only: [], tier: 'fast' });
  assertEqual(picked.length, 1, '缺省档只跑 fast');
  assertEqual(picked[0].file, 'a.js');
});

test('runner 分档: tier=slow 只跑慢档，tier=all 两者都跑', () => {
  const suites = [fake('a.js'), fake('b.js', 'slow')];
  assertEqual(selectSuites(suites, { only: [], tier: 'slow' }).length, 1);
  assertEqual(selectSuites(suites, { only: [], tier: 'slow' })[0].file, 'b.js');
  assertEqual(selectSuites(suites, { only: [], tier: 'all' }).length, 2, 'all 不得漏任何一档');
});

test('runner 分档: only 按文件名筛，且支持与 tier 组合', () => {
  const suites = [fake('a.js'), fake('b.js'), fake('c.js', 'slow')];
  const p = selectSuites(suites, { only: ['a.js', 'b.js'], tier: 'fast' });
  assertDeepEqual(p.map((s) => s.file), ['a.js', 'b.js']);
  // 指定慢档文件必须显式带 tier，否则硬失败（下一条）
  assertEqual(selectSuites(suites, { only: ['c.js'], tier: 'slow' })[0].file, 'c.js');
  assertEqual(selectSuites(suites, { only: ['c.js'], tier: 'all' })[0].file, 'c.js');
});

test('runner 分档: only 支持档位名（展开成文件清单）', () => {
  const suites = [fake('a.js'), fake('b.js'), fake('c.js')];
  const groups = { light: ['a.js', 'b.js'] };
  const p = selectSuites(suites, { only: ['light'], tier: 'fast' }, groups);
  assertDeepEqual(p.map((s) => s.file), ['a.js', 'b.js']);
});

// ==================== 失配硬失败（本文件的核心判别力） ====================

test('runner 分档: 未知文件名必须抛错，不得静默少跑', () => {
  const suites = [fake('a.js'), fake('b.js')];
  // ⚠️ 这条是「拼错一个字母 ⇒ 少跑一半用例仍全绿」的唯一防线
  const err = assertThrows(() => selectSuites(suites, { only: ['a.js', 'typo.js'], tier: 'fast' }),
    '既不是档位名也不是已注册的测试文件');
  assertTrue(err.message.includes('typo.js'), '错误文案必须点名是哪个 token 错了');
});

test('runner 分档: 未知档位名必须抛错', () => {
  const suites = [fake('a.js')];
  const err = assertThrows(() => selectSuites(suites, { only: ['nosuchgroup'], tier: 'fast' }, { light: ['a.js'] }),
    '既不是档位名也不是已注册的测试文件');
  assertTrue(err.message.includes('nosuchgroup'), '错误文案必须点名未知档位名');
});

test('runner 分档: 未知 tier 值必须抛错（只接受 fast/slow/all）', () => {
  const suites = [fake('a.js')];
  assertThrows(() => selectSuites(suites, { only: [], tier: 'FAST' }), '未知 tier');
  assertThrows(() => selectSuites(suites, { only: [], tier: '' }), '未知 tier');
});

test('runner 分档: 过滤后为空必须抛错，空集合不得当全绿', () => {
  // 全部是慢档而 tier=fast ⇒ 一个都跑不到。若返回空数组，调用方会算出 failed=0 全绿。
  const suites = [fake('slow1.js', 'slow'), fake('slow2.js', 'slow')];
  assertThrows(() => selectSuites(suites, { only: [], tier: 'fast' }), '空集合');
});

test('runner 分档: only 指定的文件在该 tier 下没跑到也要抛错', () => {
  // 形态：写了 ?only=heavy.js 但忘了 ?tier=slow ⇒ 该文件被 tier 过滤掉
  // 若不抛错，spec 会「跑了一堆别的用例然后全绿」，而目标用例一条没跑。
  const suites = [fake('a.js'), fake('heavy.js', 'slow')];
  // 全空 ⇒ 空集合报错
  assertThrows(() => selectSuites(suites, { only: ['heavy.js'], tier: 'fast' }), '空集合不得当成全绿');
  // 混合选择：a.js 跑到了但 heavy.js 没跑到 ⇒ 必须点名那个文件（不能只报空集合）
  const err = assertThrows(() => selectSuites(suites, { only: ['a.js', 'heavy.js'], tier: 'fast' }),
    '没有用例被跑到');
  assertTrue(err.message.includes('heavy.js'), '错误文案必须点名没跑到的文件');
});

test('runner 分档: 无 file 归属的 suite 不会被 only 误选（防归错档）', () => {
  // 取不到文件名时 file=null；only 指定具体文件时它不该被算进去
  const suites = [fake(null), fake('a.js')];
  const p = selectSuites(suites, { only: ['a.js'], tier: 'fast' });
  assertEqual(p.length, 1);
  assertEqual(p[0].file, 'a.js');
});

// ==================== 真实注册路径的文件归属 ====================

test('runner 分档: 本文件的裸 test() 真的带上了文件归属（?only= 的前提）', () => {
  // ⚠️ 不能只测纯函数：`?only=` 能工作的**前提**是真实注册时 file 非空。
  // 原先全部 suite 都叫 'Default Suite' 且无 file ⇒ 按文件过滤结构上不可能。
  //
  // ⚠️ **不得在用例内调 `runAllTests()`**（实测踩到）：本用例本身就是被
  // `runAllTests()` 跑的，内层再跑会把包括自己在内的全部 suite 再跑一遍 ⇒ **无限递归**
  // ⇒ 实测 34s 后 4GB 堆 OOM。改成直接读注册表（只读，不执行任何用例）。
  const reg = getRegisteredSuites();
  const mine = reg.filter((s) => s.file === 'test-runner-tiers.js');
  assertTrue(mine.length > 0,
    `真实注册路径必须解析出本文件名（实得前几个：${JSON.stringify(reg.slice(0, 3).map((s) => s.file))}）`);
  assertTrue(mine.every((s) => s.name === 'test-runner-tiers.js'),
    '裸 test() 的 suite 名必须是文件名，不得再是 Default Suite');
  assertTrue(mine.every((s) => s.tier === 'fast'), '本文件用例缺省属 fast 档');
});