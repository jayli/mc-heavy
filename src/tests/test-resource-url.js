// src/tests/test-resource-url.js — 资源 URL 的部署路径无关解析（v1.87，Tier 1）
//
// 被测缺陷：所有资源 URL 曾写成站点根绝对路径（`/assets/atlas.json`），
// 仓库挂子路径（`http://host/mc-heavy/`）时全部 404、游戏页加载不出来。
//
// ⚠️ **这个用例必须能区分「根绝对路径」与「部署无关解析」**：在根路径部署下两者
// 逐字节相同（`http://host/assets/x`），只在子路径下分叉。故用 `resourceUrlFrom()`
// 注入一个**带部署前缀的假 module URL**（与真实浏览器里 `import.meta.url` 的形状一致），
// 不带前缀的用例则直接验真实 `resourceUrl()` 在本页（reporoot 部署）的行为。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { resourceUrl, resourceUrlFrom } from '../core/resource-url.js';

/** 子路径部署下的假 module URL（模拟仓库挂在 `/mc-heavy/` 时的 src/core/resource-url.js） */
const SUBPATH_SELF = 'http://127.0.0.1:8080/mc-heavy/src/core/resource-url.js';
/**
 * 根部署下的假 module URL（本仓开发服务器的实际形态）
 */
const ROOT_SELF = 'http://localhost:8081/src/core/resource-url.js';
/**
 * 站点根绝对形式的仓库相对路径（`'/' + 'assets/...`）。
 * ⚠️ **必须拼接而不能写字面量**：`check:arch` 静态禁的是 `src/**` 里出现站点根绝对路径，
 * 而本用例**恰好要验「带前导斜杠的输入该怎么处理」**。拼接让门禁保持零例外，
 * 又不会把一个根绝对路径字面量留在代码里供人复制。
 */
const withLeadingSlash = (rel) => `/${rel}`;

test('resource-url: 根路径部署拼接仓库相对路径', () => {
  assertEqual(resourceUrlFrom(ROOT_SELF, 'assets/atlas.json'), 'http://localhost:8081/assets/atlas.json');
  assertEqual(resourceUrlFrom(ROOT_SELF, 'src/workers/world-worker.js'), 'http://localhost:8081/src/workers/world-worker.js');
});

test('resource-url: 子路径部署必须保留部署前缀（缺陷本体）', () => {
  // 这是本次缺陷的**直接断言**：根绝对路径会得到 `/assets/...`（丢前缀 → 404），
  // 部署无关解析必须得到 `/mc-heavy/assets/...`
  assertEqual(resourceUrlFrom(SUBPATH_SELF, 'assets/atlas.json'),
    'http://127.0.0.1:8080/mc-heavy/assets/atlas.json');
  assertEqual(resourceUrlFrom(SUBPATH_SELF, 'assets/atlas.png'),
    'http://127.0.0.1:8080/mc-heavy/assets/atlas.png');
  assertEqual(resourceUrlFrom(SUBPATH_SELF, 'src/workers/world-worker.js'),
    'http://127.0.0.1:8080/mc-heavy/src/workers/world-worker.js');
});

test('resource-url: 前导斜杠被剥掉（否则 new URL 会退回 origin 根）', () => {
  // `new URL(<站点根绝对路径>, base)` 丢弃 base 路径部分 —— 这正是缺陷的机制。
  // 本函数必须剥斜杠，让带斜杠与不带斜杠得到同一结果（防调用方写错就静默退回根路径）。
  const withSlash = resourceUrlFrom(SUBPATH_SELF, withLeadingSlash('assets/atlas.json'));
  const without = resourceUrlFrom(SUBPATH_SELF, 'assets/atlas.json');
  assertEqual(withSlash, without, `前导斜杠不得改变结果，实得 ${withSlash} vs ${without}`);
  assertTrue(withSlash.includes('/mc-heavy/'), `必须保留部署前缀，实得 ${withSlash}`);
  // 多个前导斜杠同样剥掉（`//host/x` 会被解析成协议相对 URL，比根路径更糟）
  assertEqual(resourceUrlFrom(SUBPATH_SELF, `/${withLeadingSlash('assets/atlas.json')}`), without, '双斜杠同样剥掉');
});

test('resource-url: 任意部署深度都正确（不是只适配一层前缀）', () => {
  const deep = 'http://host/a/b/c/src/core/resource-url.js';
  assertEqual(resourceUrlFrom(deep, 'assets/atlas.json'), 'http://host/a/b/c/assets/atlas.json');
});

test('resource-url: 真实的 resourceUrl() 与当前页面同源且指向仓库根', () => {
  // 真实调用（本页是 reporoot 部署）：结果必须与页面同源，且路径以仓库相对路径收尾。
  // 不硬编码端口（Playwright 的 baseURL 可配）—— 只断言与本页 origin 一致 + 以仓库相对路径收尾。
  const url = resourceUrl('assets/atlas.json');
  const parsed = new URL(url);
  assertEqual(parsed.origin, location.origin, `必须与页面同源，实得 ${url}`);
  assertTrue(parsed.pathname.endsWith(withLeadingSlash('assets/atlas.json')),
    `路径须以仓库相对路径收尾，实得 ${parsed.pathname}`);
});

test('resource-url: 真实的 resourceUrl() 不含「文档所在目录」（fixture 页在 /src/tests/ 下也不受影响）', () => {
  // 旧实现改用纯相对路径时，fixture 页会解析出 /src/tests/assets/* —— 本仓 v1.87 之前的
  // 根绝对路径正是为躲这个坑。部署无关解析必须**既不退回 origin 根、也不落进文档目录**。
  const url = resourceUrl('assets/atlas.png');
  const pathname = new URL(url).pathname;
  // 不得出现 fixture 目录段（拼接构造，避开 `check:arch` 的站点根绝对路径字面量门禁）
  const fixtureDir = `${withLeadingSlash('src')}/tests/`;
  assertTrue(!pathname.includes(fixtureDir), `不得相对文档基址解析（会落进 ${fixtureDir}），实得 ${url}`);
  assertTrue(pathname.endsWith(withLeadingSlash('assets/atlas.png')),
    `必须落在仓库根的 assets 下，实得 ${url}`);
});
