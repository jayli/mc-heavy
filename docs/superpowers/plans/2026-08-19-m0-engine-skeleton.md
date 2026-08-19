# M0 引擎骨架实施计划（mc-heavy 第一阶段）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭好 mc-heavy 引擎骨架——项目脚手架 + WebGPU 启动 gate、浏览器测试 harness、perf 打点、Worker 池 RPC、BlockRegistry（124 方块移植）、纹理 atlas 构建，以及 WebGPU 发布路径语义实测（3-group vs 24-group vs BatchedMesh），产出设计文档 §7 M0 的验收物。

**Architecture:** 纯 JavaScript ES Modules + CDN import map（three@0.185.1 webgpu 构建），无构建步骤。单元测试沿用 mc-lite 的浏览器内 harness（describe/test/assert，`src/tests/index.html` 汇总运行），Playwright 作为无头运行器与渲染验收工具。Worker 侧代码不依赖 three，一律相对路径 import（module worker 不继承页面 import map，设计文档 §3 约束）。

**Tech Stack:** three@0.185.1（CDN jsdelivr，`three.webgpu.js`/`three.tsl.js`）、ES2022+、ESLint 9 flat config、Playwright（devDependency）、pngjs（atlas 离线打包，devDependency）、Node v26。

## Global Constraints

- 纯 JavaScript + JSDoc 类型注释，**禁止 TypeScript**，无编译/转译环节（设计文档 DR-9）。
- three.js 固定 **r185.1**，只经 import map 从 CDN 引入；**three 只在主线程使用**，`src/workers/` 下任何文件不得 import three（设计文档 §3）。
- WebGPU 唯一后端：启动检测 `navigator.gpu`，不支持时显示明确错误提示并中止，不做 WebGL2 降级（DR-10）。
- dev server 端口 **8081**（mc-lite 占用 8080，避免并行开发冲突）。
- 纹理 atlas：2048×2048，tile 间 **2px gutter**，UV 内缩半 texel；默认 `NearestFilter` 无 mipmap（像素风），模糊档位留接口（设计文档 §4.4.1）。
- 方块 ID：0 = air；`BlockRegistry` 预编译按 ID 索引的 typed 查找表，热路径无对象属性访问、无字符串比较（设计文档 §4.1）。
- 每个任务结束必须 commit；commit message 用 Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）。
- 所有断言数字（draw call 数、耗时阈值）来自设计文档 v1.7（draw call 口径在 v1.6 已源码核验定稿）的结论，实测结果与预期不符时**先停下来报告**，不要擅自改断言。

## File Structure

```
mc-heavy/
├─ package.json                  # scripts: start(8081)/test(playwright)/lint；devDeps: playwright, pngjs, eslint
├─ eslint.config.mjs             # 移植 mc-lite 配置 + tools/ 的 node globals
├─ playwright.config.mjs         # webServer 自动起 8081；chromium + WebGPU flags
├─ index.html                    # import map（three@0.185.1）+ 启动 gate + canvas + HUD 挂载点
├─ server-script/start-server.js # 静态服务器（移植 mc-lite，端口 8081）
├─ assets/textures/              # 从 mc-lite 复制（116 顶层 PNG + bed/ 6 张，保持文件名）
├─ assets/atlas.png              # tools/build-atlas.mjs 产物（提交入库）
├─ assets/atlas.json             # tile 名 → {x,y,w,h,u0,v0,u1,v1}（产物，提交入库）
├─ tools/build-atlas.mjs         # 离线 atlas 打包（pngjs，shelf 算法）
├─ src/
│  ├─ main.js                    # 启动入口：WebGPU gate → 空白场景渲染循环 + HUD
│  ├─ core/perf.js               # PerfMonitor：帧时采样 + p50/p95/p99
│  ├─ core/perf-hud.js           # PerfHUD：DOM 面板（fps/帧时分布/队列深度槽位）
│  ├─ core/worker-pool.js        # WorkerPool：RPC（call/cancel/broadcast）
│  ├─ voxel/block-registry.js    # BlockRegistry：name↔ID + typed 属性表
│  └─ mesh/atlas-loader.js       # loadAtlas()：atlas.png/json → THREE.Texture + tileRect()
├─ src/tests/
│  ├─ assert.js                  # 移植 mc-lite（assertEqual/assertTrue/…）
│  ├─ runner.js                  # 移植 mc-lite（describe/test/runAllTests，暴露 window.__MC_TEST_RESULTS__）
│  ├─ index.html                 # 汇总页（自动运行 + 结果挂 window）
│  ├─ test-perf.js               # PerfMonitor 单测
│  ├─ test-block-registry.js     # BlockRegistry 单测
│  └─ test-worker-pool.html      # WorkerPool 集成 fixture（Blob worker）
├─ src/bench/webgpu-publish.html # 发布路径语义基准页（暴露 window.__BENCH__）
└─ tests/
   ├─ harness.spec.mjs           # 跑 src/tests/index.html，断言 0 失败
   ├─ boot.spec.mjs              # 空白场景渲染非黑 + HUD 有 fps + 无 console error
   └─ webgpu-publish.spec.mjs    # 基准断言：3/24 draw、BatchedMesh 命令数、CPU 耗时阈值
```

**职责边界**：`core/` 不依赖 `voxel/`；`voxel/block-registry.js` 不依赖 three；`mesh/atlas-loader.js` 是唯一在 M0 接触 three 纹理的运行时模块；`src/bench/` 与 `tests/` 是验收设施，不进游戏运行时依赖图。

---

### Task 1: 项目脚手架 + WebGPU 启动 gate

**Files:**
- Create: `package.json`
- Create: `eslint.config.mjs`
- Create: `server-script/start-server.js`
- Create: `index.html`
- Create: `src/main.js`
- Create: `.gitignore`

**Interfaces:**
- Produces: `npm start` 起 8081 静态服务；`http://localhost:8081/` 渲染空白场景；`window.__MC_BOOT__` = `{ webgpu: boolean, rendererReady: boolean, error?: string }`（Task 7 的 Playwright 断言依赖它）。

- [ ] **Step 1: 写 package.json 与 .gitignore**

```json
{
  "name": "mc-heavy",
  "version": "0.1.0",
  "description": "Minecraft 重制版 —— 高性能体素引擎（第一阶段：引擎底座）",
  "type": "module",
  "scripts": {
    "start": "node server-script/start-server.js",
    "atlas": "node tools/build-atlas.mjs",
    "test": "playwright test",
    "lint": "eslint src tools tests"
  },
  "author": "jayli",
  "repository": "git@github.com:jayli/mc-heavy.git",
  "license": "ISC",
  "devDependencies": {
    "eslint": "^9.39.4",
    "playwright": "^1.62.1",
    "pngjs": "^7.0.0"
  }
}
```

`.gitignore`：

```
node_modules/
.DS_Store
test-results/
playwright-report/
```

- [ ] **Step 2: 安装依赖**

Run: `cd ~/jaylli/mc-heavy && npm install`
Expected: 成功，`node_modules/` 生成，无 peer 冲突报错。

> playwright 固定 1.62.1（而非 mc-lite 的 1.59.1）：本机 ms-playwright 缓存已有
> chromium-1234（1.62.1 对应的 revision，已实测存在），`npx playwright install chromium`
> 可复用缓存秒级完成；1.59.1 会要求额外下载 chromium-1217。

- [ ] **Step 3: 移植 eslint 配置**

复制 `~/jaylli/mc-lite/eslint.config.mjs` 到本仓库，做五处修改：
1. 顶部注释的项目名改为 `mc-heavy`；
2. 从 `ignores` 数组删除 `'src/tests/**'`——新测试文件必须参与 lint，否则 test-perf /
   test-block-registry 都不被检查；
3. 在主配置的 `globals` 里追加 `self: 'readonly'` 与 `postMessage: 'readonly'`
   （`src/core/worker-pool.js` 的 `installRpcHandler` 在 Worker 作用域运行，mc-lite 原配置
   只在 `src/workers/**` 块里开了这两个全局，覆盖不到 `core/`）；
4. 追加一个针对 `tools/**/*.mjs` 与 `tests/**/*.mjs` 的配置块（Node 环境 globals）：

```js
  {
    // Node 侧脚本（atlas 构建工具 / Playwright 测试）
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', '*.config.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
```

5. 追加 `blocks-data.js` 的 camelcase 豁免（防御性：若转换产物采用对象键形式
   `{ cobblestone_step_updown: {...} }` 会触发 camelcase warning；def 数组 + 字符串值
   形式则不会命中——ESLint camelcase 不检查字符串值，保留豁免无害）：

```js
  {
    // 方块数据：防御性豁免（见上方说明）
    files: ['src/voxel/blocks-data.js'],
    rules: {
      'camelcase': 'off',
    },
  },
```

- [ ] **Step 4: 移植 dev server（端口 8081）**

**不要原样复制 mc-lite 的 `server-script/start-server.js`**：它是 CommonJS（`require`），
而本仓库 `package.json` 声明了 `"type": "module"`，直接复制会在 `npm start` 时抛
`require is not defined`。逻辑原样移植，只做 ESM 化 + 端口改动：

```js
// server-script/start-server.js — 静态文件服务器（设计文档 DR-7：无构建步骤）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8081;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    for (const alias of interfaces[devName]) {
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

const ROOT = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  const filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);

  // 防止目录遍历攻击
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end('500 Internal Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('Server running at:');
  console.log(`  - Local:   http://localhost:${PORT}/`);
  console.log(`  - Network: http://${localIP}:${PORT}/`);
  console.log('\nPress Ctrl+C to stop');
});
```

- [ ] **Step 5: 写 index.html（import map + 启动 gate）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mc-heavy</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
    #app-canvas { display: block; width: 100%; height: 100%; }
    #webgpu-error {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: #1a1a2e; color: #eee;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      align-items: center; justify-content: center; text-align: center;
      line-height: 1.8; padding: 24px;
    }
  </style>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.webgpu.js",
      "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.tsl.js",
      "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.webgpu.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/"
    }
  }
  </script>
</head>
<body>
  <canvas id="app-canvas"></canvas>
  <div id="webgpu-error">
    <div>
      <h2>需要 WebGPU 支持</h2>
      <p>mc-heavy 使用 WebGPU 渲染，当前浏览器不支持。</p>
      <p>请使用最新版 Chrome / Edge / Safari 26 打开。</p>
    </div>
  </div>
  <div id="hud-root"></div>
  <script type="module" src="./src/main.js"></script>
</body>
</html>
```

- [ ] **Step 6: 写 src/main.js（WebGPU gate + 空白场景）**

```js
// src/main.js — 启动入口：WebGPU gate → 空白场景渲染循环
import * as THREE from 'three';

window.__MC_BOOT__ = { webgpu: false, rendererReady: false, error: null };

async function boot() {
  if (!navigator.gpu) {
    window.__MC_BOOT__.error = 'navigator.gpu unavailable';
    document.getElementById('webgpu-error').style.display = 'flex';
    return;
  }
  window.__MC_BOOT__.webgpu = true;

  const canvas = document.getElementById('app-canvas');
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  await renderer.init();
  window.__MC_BOOT__.rendererReady = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb); // 天空蓝，验收"非黑屏"用

  const camera = new THREE.PerspectiveCamera(
    70, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 8, 16);
  camera.lookAt(0, 0, 0);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });
}

boot().catch((err) => {
  window.__MC_BOOT__.error = String(err);
  document.getElementById('webgpu-error').style.display = 'flex';
});
```

- [ ] **Step 7: 手动验证启动**

Run: `cd ~/jaylli/mc-heavy && npm start`（后台），浏览器开 `http://localhost:8081/`。
Expected: 页面显示天空蓝背景（WebGPU 正常）；控制台执行 `window.__MC_BOOT__` 得 `{ webgpu: true, rendererReady: true, error: null }`。

- [ ] **Step 8: lint 通过**

Run: `npm run lint`
Expected: 0 errors（warnings 可接受）。

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json eslint.config.mjs server-script index.html src/main.js .gitignore
git commit -m "feat(scaffold): 项目脚手架 + WebGPU 启动 gate + 空白场景"
```

---

### Task 2: 浏览器测试 harness + Playwright 运行器

**Files:**
- Create: `src/tests/assert.js`（移植 mc-lite）
- Create: `src/tests/runner.js`（移植 mc-lite + window 结果暴露）
- Create: `src/tests/index.html`
- Create: `playwright.config.mjs`
- Create: `tests/harness.spec.mjs`
- Test: `tests/harness.spec.mjs`（本任务自带验收）

**Interfaces:**
- Consumes: Task 1 的 dev server（8081）。
- Produces: `describe(name, fn)` / `test(name, fn)` / `runAllTests()`（后续所有 `src/tests/test-*.js` 的依赖）；`window.__MC_TEST_RESULTS__` = `{ passed, failed, total, passRate, suites }`（Playwright 断言依赖）；`npm test` 一键跑全部 Playwright 验收。

- [ ] **Step 1: 移植 assert.js 与 runner.js**

`assert.js` 从 `~/jaylli/mc-lite/src/tests/assert.js` 原样复制（`AssertionError`、`assertEqual`、`assertNotEqual`、`assertTrue`、`assertFalse`、`assertNull`、`assertUndefined`、`assertThrows` 全部保留）。

`runner.js` 从 `~/jaylli/mc-lite/src/tests/runner.js` 复制，做两处修改：
1. 删除 DOM 报告相关函数（`displayResults`/`generateHTMLReport`/`setProgressCallback` 等），只保留 `describe`/`test`/`runAllTests` 核心（mc-lite 版 `runAllTests` 返回 `{ suites, passed, failed, total, duration, passRate }`，保留该返回结构）；
2. 文件末尾追加结果暴露：

```js
// 供 Playwright 读取的机器可读结果
export async function runAndExpose() {
  const results = await runAllTests();
  window.__MC_TEST_RESULTS__ = results;
  return results;
}
```

- [ ] **Step 2: 写 src/tests/index.html（自动运行汇总页）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>mc-heavy 测试</title>
</head>
<body>
  <pre id="report"></pre>
  <script type="module">
    import { runAndExpose } from './runner.js';
    // 测试文件在此逐个 import（后续任务追加）：
    // import './test-perf.js';

    runAndExpose().then((r) => {
      document.getElementById('report').textContent =
        `passed=${r.passed} failed=${r.failed} total=${r.total} passRate=${r.passRate}%`;
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: 写 playwright.config.mjs**

```js
import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:8081',
    browserName: 'chromium',
    headless: true,
    // channel: 'chromium' 是必需项：默认的 headless shell 在零 flag 下拿不到 WebGPU
    // adapter，而完整 Chromium 新无头模式在本机（macOS ARM）零 flag 走 Metal。
    channel: 'chromium',
    launchOptions: {
      // 实测矩阵（macOS ARM + Chromium 151 + playwright 1.62.1，2026-08-19）：
      //   headless shell + 零 flag            → no-adapter
      //   headless shell + SwiftShader 组合   → vendor=google, arch=swiftshader
      //   channel:'chromium' + 零 flag        → vendor=apple, arch=metal-3（本机默认走这条）
      //   channel:'chromium' + SwiftShader 组 → vendor=google, arch=swiftshader（Linux CI）
      // 本地用真 GPU 性能数字才有代表性；Linux CI 无 Metal，用 SwiftShader 组合。
      // `--enable-features=Vulkan` 在 macOS 上无作用，已删除。
      args: process.env.CI
        ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-dawn-features=allow_unsafe_apis']
        : [],
    },
  },
  webServer: {
    command: 'npm start',
    port: 8081,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

- [ ] **Step 4: 写 tests/harness.spec.mjs（先失败——此时无任何测试文件）**

```js
import { test, expect } from 'playwright/test';

test('浏览器测试 harness 正常运行且 0 失败', async ({ page }) => {
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 30_000 });
  const results = await page.evaluate(() => window.__MC_TEST_RESULTS__);
  expect(results.total).toBeGreaterThan(0);
  expect(results.failed).toBe(0);
});
```

- [ ] **Step 5: 运行验证失败**

Run: `npx playwright install chromium && npm test`
Expected: FAIL —— `results.total` 为 0（还没有任何测试文件注册）。

- [ ] **Step 6: 加一个冒烟测试让 harness 跑通**

Create `src/tests/test-smoke.js`：

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';

test('harness 冒烟：断言库工作正常', () => {
  assertEqual(1 + 1, 2);
  assertTrue(true);
});
```

并在 `src/tests/index.html` 的 import 区追加：

```js
    import './test-smoke.js';
```

- [ ] **Step 7: 运行验证通过**

Run: `npm test`
Expected: PASS（total=1, failed=0）。

- [ ] **Step 8: Commit**

```bash
git add src/tests playwright.config.mjs tests
git commit -m "test(harness): 浏览器测试 harness 移植 + Playwright 运行器"
```

---

### Task 3: PerfMonitor + HUD 性能面板

**Files:**
- Create: `src/core/perf.js`
- Create: `src/core/perf-hud.js`
- Test: `src/tests/test-perf.js`

**Interfaces:**
- Consumes: Task 2 的 harness（describe/test/assert）。
- Produces: `class PerfMonitor` —— `tick(nowMs)`（每帧调用）、`mark(name, durationMs)`（子系统耗时打点）、`snapshot()` 返回 `{ fps, frameMs: {p50, p95, p99}, marks: Record<string, {count, avgMs, p95Ms}> }`（§4.9 HUD 与 §8 性能验收的数据源；M1 起 GEN/MESH 队列深度经 `mark()` 上报）；`class PerfHUD` —— `constructor(monitor, containerEl)`、`update()`（每帧节流刷新 DOM）。

- [ ] **Step 1: 写失败测试 src/tests/test-perf.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { PerfMonitor } from '../core/perf.js';

test('PerfMonitor: 100 帧 16.67ms 间隔 → fps ≈ 60', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 16.67; m.tick(t); }
  const s = m.snapshot();
  assertTrue(Math.abs(s.fps - 60) < 2, `fps=${s.fps}`);
});

test('PerfMonitor: 帧时分位数正确', () => {
  const m = new PerfMonitor();
  let t = 0;
  // 90 帧 10ms + 10 帧 30ms
  for (let i = 0; i < 90; i++) { t += 10; m.tick(t); }
  for (let i = 0; i < 10; i++) { t += 30; m.tick(t); }
  const s = m.snapshot();
  assertTrue(s.frameMs.p50 <= 11, `p50=${s.frameMs.p50}`);
  assertTrue(s.frameMs.p95 >= 25, `p95=${s.frameMs.p95}`);
});

test('PerfMonitor: mark 聚合 count/avg', () => {
  const m = new PerfMonitor();
  m.mark('mesh-upload', 2);
  m.mark('mesh-upload', 4);
  const s = m.snapshot();
  assertEqual(s.marks['mesh-upload'].count, 2);
  assertEqual(s.marks['mesh-upload'].avgMs, 3);
});

test('PerfMonitor: 窗口滚动，内存有界', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 5000; i++) { t += 16; m.tick(t); }
  // 内部采样窗口不应无限增长
  assertTrue(m._frameSamples.count <= m.windowSize, 'sample window bounded');
});
```

并在 `src/tests/index.html` 追加 `import './test-perf.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `../core/perf.js` 不存在（模块加载错误，harness 报 failed）。

- [ ] **Step 3: 实现 src/core/perf.js**

```js
// src/core/perf.js — 帧时采样 + 子系统打点（设计文档 §4.9）

/** 固定容量环形缓冲，避免 GC 压力 */
class RingBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.count = 0;
  }
  push(v) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  /** 返回升序拷贝的前 count 个样本 */
  sorted() {
    const arr = Array.from(this.data.subarray(0, this.count));
    arr.sort((a, b) => a - b);
    return arr;
  }
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

export class PerfMonitor {
  /** @param {number} windowSize 采样窗口（帧数） */
  constructor(windowSize = 600) {
    this.windowSize = windowSize;
    this._frameSamples = new RingBuffer(windowSize);
    this._lastTick = -1;
    this._marks = new Map(); // name -> RingBuffer
  }

  /** 每帧调用一次，nowMs = performance.now() */
  tick(nowMs) {
    if (this._lastTick >= 0) {
      this._frameSamples.push(nowMs - this._lastTick);
    }
    this._lastTick = nowMs;
  }

  /** 子系统耗时打点（GEN/MESH/上传等） */
  mark(name, durationMs) {
    let buf = this._marks.get(name);
    if (!buf) {
      buf = new RingBuffer(this.windowSize);
      this._marks.set(name, buf);
    }
    buf.push(durationMs);
  }

  snapshot() {
    const frames = this._frameSamples.sorted();
    const avg = frames.length
      ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
    const marks = {};
    for (const [name, buf] of this._marks) {
      const arr = buf.sorted();
      if (arr.length === 0) continue;
      marks[name] = {
        count: arr.length,
        avgMs: arr.reduce((a, b) => a + b, 0) / arr.length,
        p95Ms: percentile(arr, 95),
      };
    }
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: {
        p50: percentile(frames, 50),
        p95: percentile(frames, 95),
        p99: percentile(frames, 99),
      },
      marks,
    };
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（test-perf 4 个用例全过）。

- [ ] **Step 5: 实现 src/core/perf-hud.js 并挂进 main.js**

```js
// src/core/perf-hud.js — HUD 性能面板（设计文档 §4.9）
export class PerfHUD {
  /** @param {import('./perf.js').PerfMonitor} monitor @param {HTMLElement} containerEl */
  constructor(monitor, containerEl) {
    this.monitor = monitor;
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:50;padding:6px 10px;' +
      'background:rgba(0,0,0,.55);color:#0f0;font:12px/1.6 monospace;' +
      'border-radius:4px;pointer-events:none;white-space:pre;';
    containerEl.appendChild(this.el);
    this._lastUpdate = 0;
  }

  /** 每帧调用；内部 250ms 节流刷新 DOM */
  update(nowMs) {
    if (nowMs - this._lastUpdate < 250) return;
    this._lastUpdate = nowMs;
    const s = this.monitor.snapshot();
    const lines = [
      `fps ${s.fps.toFixed(0)}`,
      `frame p50 ${s.frameMs.p50.toFixed(1)} p95 ${s.frameMs.p95.toFixed(1)} p99 ${s.frameMs.p99.toFixed(1)} ms`,
    ];
    for (const [name, m] of Object.entries(s.marks)) {
      lines.push(`${name} n=${m.count} avg ${m.avgMs.toFixed(2)} p95 ${m.p95Ms.toFixed(2)} ms`);
    }
    this.el.textContent = lines.join('\n');
  }
}
```

在 `src/main.js` 渲染循环接入（`renderer.setAnimationLoop` 回调内）：

```js
import { PerfMonitor } from './core/perf.js';
import { PerfHUD } from './core/perf-hud.js';

const perf = new PerfMonitor();
const hud = new PerfHUD(perf, document.getElementById('hud-root'));

renderer.setAnimationLoop((nowMs) => {
  perf.tick(nowMs);
  hud.update(nowMs);
  renderer.render(scene, camera);
});
```

- [ ] **Step 6: 手动验证 HUD**

浏览器开 `http://localhost:8081/`，Expected: 左上角绿色面板显示 `fps 60`（或高刷屏 120）与 frame 分位数。

- [ ] **Step 7: Commit**

```bash
git add src/core/perf.js src/core/perf-hud.js src/main.js src/tests/test-perf.js src/tests/index.html
git commit -m "feat(perf): PerfMonitor 帧时采样 + HUD 性能面板"
```

---

### Task 4: WorkerPool + RPC

**Files:**
- Create: `src/core/worker-pool.js`
- Create: `src/tests/test-worker-pool.html`
- Create: `tests/worker-pool.spec.mjs`

**Interfaces:**
- Consumes: Task 1 脚手架、Task 2 harness。
- Produces: `class WorkerPool` —— `constructor({ workerUrl, size })`（size 默认 `Math.max(3, hardwareConcurrency - 1)`，设计文档 §4.2）；`call(method, payload, { transfer }) → { id, promise }`（轮询挑最闲 worker，payload 经 structured clone + transfer list 传递；返回 callId 供 cancel 用）；`cancel(callId)`（丢弃在途结果，设计文档 §4.2「任务可取消」）；`broadcast(method, payload)`（布局广播用，§4.2 DR-13）；`dispose()`。RPC 协议：请求 `{ __rpc: true, id, method, payload }`，响应 `{ __rpc: true, id, ok, result }` 或 `{ __rpc: true, id, ok: false, error }`。worker 侧用 `installRpcHandler(handlers)` 注册（同文件导出，worker 脚本 import 使用）。

- [ ] **Step 1: 写失败测试 tests/worker-pool.spec.mjs + fixture**

`src/tests/test-worker-pool.html`（fixture 页，Blob worker 避免额外文件依赖）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>worker-pool fixture</title></head>
<body>
<script type="module">
  import { WorkerPool } from '../core/worker-pool.js';

  const workerCode = `
    import { installRpcHandler } from '${location.origin}/src/core/worker-pool.js';
    installRpcHandler({
      echo: (payload) => ({ got: payload }),
      slow: async (payload) => { await new Promise(r => setTimeout(r, payload.ms)); return { done: true }; },
      boom: () => { throw new Error('task-failed'); },
      sumTransfer: (payload) => ({ sum: payload.arr.reduce((a, b) => a + b, 0), detached: payload.arr.length === 0 }),
    });
  `;
  const blobUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));

  async function run() {
    const results = { passed: 0, failed: 0, errors: [] };
    const check = (name, cond) => {
      if (cond) results.passed++;
      else { results.failed++; results.errors.push(name); }
    };

    const pool = new WorkerPool({ workerUrl: blobUrl, size: 2 });
    await pool.ready;

    // 1. 基本 RPC 往返
    const r1 = await pool.call('echo', { v: 42 }).promise;
    check('echo roundtrip', r1.got.v === 42);

    // 2. 并发分发到两个 worker（两个 slow 应并行，总耗时 < 2×ms）
    const t0 = performance.now();
    await Promise.all([pool.call('slow', { ms: 100 }).promise, pool.call('slow', { ms: 100 }).promise]);
    check('parallel dispatch', performance.now() - t0 < 190);

    // 3. worker 抛错 → promise reject
    let rejected = false;
    try { await pool.call('boom', {}).promise; } catch (e) { rejected = /task-failed/.test(e.message); }
    check('error propagation', rejected);

    // 4. Transferable 零拷贝（transfer 后主线程 buffer 被 detach）
    const buf = new Float32Array([1, 2, 3]).buffer;
    const r4 = await pool.call('sumTransfer', { arr: new Float32Array(buf) }, { transfer: [buf] }).promise;
    check('transfer result', r4.sum === 6);
    check('buffer detached', buf.byteLength === 0);

    // 5. cancel：取消在途任务后，其结果回传被丢弃（promise 永不 settle 也不报错）
    const c = pool.call('slow', { ms: 50 });
    pool.cancel(c.id);
    let settled = false;
    c.promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 120));
    check('cancelled call dropped', settled === false);

    // 6. cancel 后池子仍健康
    const r6 = await pool.call('echo', { i: 1 }).promise;
    check('pool healthy after cancel', r6.got.i === 1);

    pool.dispose();
    window.__WORKER_POOL_RESULTS__ = results;
  }
  run().catch((e) => { window.__WORKER_POOL_RESULTS__ = { passed: 0, failed: 1, errors: [String(e)] }; });
</script>
</body>
</html>
```

`tests/worker-pool.spec.mjs`：

```js
import { test, expect } from 'playwright/test';

test('WorkerPool RPC 全部用例通过', async ({ page }) => {
  await page.goto('/src/tests/test-worker-pool.html');
  await page.waitForFunction(() => window.__WORKER_POOL_RESULTS__ !== undefined, null, { timeout: 30_000 });
  const r = await page.evaluate(() => window.__WORKER_POOL_RESULTS__);
  expect(r.errors).toEqual([]);
  expect(r.failed).toBe(0);
  expect(r.passed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `worker-pool.js` 不存在，fixture 页 catch 到模块加载错误（failed=1）。

- [ ] **Step 3: 实现 src/core/worker-pool.js**

```js
// src/core/worker-pool.js — Worker 池 + RPC（设计文档 §3/§4.9）
// 主线程与 worker 侧共用本文件：WorkerPool 在主线程用，installRpcHandler 在 worker 用。
// 注意：本文件不得 import three（worker 侧无 import map，设计文档 §3 约束）。

let _nextCallId = 1;

export class WorkerPool {
  /**
   * @param {Object} opts
   * @param {string} opts.workerUrl worker 入口 URL
   * @param {number} [opts.size] 池大小，默认 max(3, hardwareConcurrency - 1)
   */
  constructor({ workerUrl, size }) {
    const n = size ?? Math.max(3, (navigator.hardwareConcurrency || 4) - 1);
    this._workers = [];
    this._pending = new Map(); // callId -> { resolve, reject }
    this._inflight = new Array(n).fill(0); // 每 worker 在途任务数
    for (let i = 0; i < n; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      w.addEventListener('message', (ev) => this._onMessage(i, ev.data));
      w.addEventListener('error', (err) => this._onWorkerError(i, err));
      this._workers.push(w);
    }
    this.ready = Promise.resolve(); // 预留：未来如需 worker 握手可改异步
  }

  _onMessage(workerIdx, msg) {
    if (!msg || msg.__rpc !== true) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return; // 已 cancel
    this._pending.delete(msg.id);
    this._inflight[workerIdx]--;
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'worker task failed'));
  }

  _onWorkerError(workerIdx, err) {
    // worker 崩溃：reject 该 worker 所有在途任务
    for (const [id, p] of this._pending) {
      if (p.workerIdx === workerIdx) {
        this._pending.delete(id);
        p.reject(new Error(`worker crashed: ${err.message || err}`));
      }
    }
  }

  _pickWorker() {
    let best = 0;
    for (let i = 1; i < this._inflight.length; i++) {
      if (this._inflight[i] < this._inflight[best]) best = i;
    }
    return best;
  }

  /**
   * @param {string} method
   * @param {*} payload
   * @param {Object} [opts]
   * @param {Transferable[]} [opts.transfer]
   * @returns {{id: number, promise: Promise<*>}} callId + 结果 promise
   */
  call(method, payload, { transfer } = {}) {
    const id = _nextCallId++;
    const workerIdx = this._pickWorker();
    this._inflight[workerIdx]++;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, workerIdx });
      this._workers[workerIdx].postMessage(
        { __rpc: true, id, method, payload }, transfer || []);
    });
    return { id, promise };
  }

  /** 取消在途任务：删除 pending 并回退该 worker 的在途计数（结果回传时无处投递即丢弃，
   *  设计文档 §4.2「任务可取消」；不回退计数会让该 worker 永久显得忙，污染最闲调度） */
  cancel(callId) {
    const pending = this._pending.get(callId);
    if (pending) {
      this._pending.delete(callId);
      this._inflight[pending.workerIdx] = Math.max(0, this._inflight[pending.workerIdx] - 1);
    }
  }

  /** 广播到所有 worker（结构布局广播用，§4.2 DR-13） */
  broadcast(method, payload) {
    for (const w of this._workers) {
      w.postMessage({ __rpc: true, id: 0, method, payload, broadcast: true });
    }
  }

  dispose() {
    for (const w of this._workers) w.terminate();
    this._workers = [];
    this._pending.clear();
  }
}

/**
 * worker 侧：注册 RPC handler。
 * @param {Record<string, (payload: *) => * | Promise<*>>} handlers
 */
export function installRpcHandler(handlers) {
  self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.__rpc !== true) return;
    const handler = handlers[msg.method];
    if (!handler) {
      self.postMessage({ __rpc: true, id: msg.id, ok: false, error: `unknown method: ${msg.method}` });
      return;
    }
    try {
      const result = await handler(msg.payload);
      self.postMessage({ __rpc: true, id: msg.id, ok: true, result });
    } catch (err) {
      self.postMessage({ __rpc: true, id: msg.id, ok: false, error: String(err && err.message || err) });
    }
  };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `npm test`
Expected: PASS（worker-pool spec 5 个 check 全过）。

- [ ] **Step 5: Commit**

```bash
git add src/core/worker-pool.js src/tests/test-worker-pool.html tests/worker-pool.spec.mjs
git commit -m "feat(core): WorkerPool + RPC（call/cancel/broadcast）"
```

---

### Task 5: BlockRegistry（124 方块移植）

**Files:**
- Create: `src/voxel/block-registry.js`
- Create: `src/voxel/blocks-data.js`（124 方块声明数据，从 mc-lite BlockData.js 转换）
- Test: `src/tests/test-block-registry.js`

**Interfaces:**
- Consumes: Task 2 harness；mc-lite `src/constants/BlockData.js`（124 方块源数据）与 `src/core/LightSourceManager.js`（4 个发光方块：hanging_lamp/glowstone/ochre_froglight/lava）。
- Produces: `registry`（单例）—— `register(name, def)`、`idOf(name) → number`、`nameOf(id) → string`、`count → number`；typed 查找表（按 ID 索引）：`solidTable: Uint8Array`、`opaqueTable: Uint8Array`、`cullTable: Uint8Array`（0=opaque 1=cutout 2=transparent 3=none）、`emissiveTable: Uint8Array`（0-15）、`geometryTable: Uint8Array`（geometryType 枚举索引）、`orientationModesTable: Uint8Array`；`registry.freeze()` 后所有表只读、`register` 抛错。M1 的 mesher/物理/射线全部依赖这些表。

- [ ] **Step 1: 写失败测试 src/tests/test-block-registry.js**

```js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertThrows } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

test('BlockRegistry: air 恒为 ID 0', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.idOf('air'), 0);
});

test('BlockRegistry: 124 方块全部注册且 ID 唯一', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.count, 124);
  const ids = new Set();
  for (const def of BLOCKS) ids.add(reg.idOf(def.name));
  assertEqual(ids.size, 124);
});

test('BlockRegistry: typed 表与声明一致', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const stone = reg.idOf('stone');
  assertEqual(reg.solidTable[stone], 1);
  assertEqual(reg.opaqueTable[stone], 1);
  const glass = reg.idOf('glass_block');
  assertEqual(reg.opaqueTable[glass], 0);       // 透明不遮光
  assertEqual(reg.cullTable[glass], 2);          // transparent 通道
  const leaves = reg.idOf('leaves');
  assertEqual(reg.cullTable[leaves], 1);         // cutout
  const lamp = reg.idOf('glowstone');
  assertEqual(reg.emissiveTable[lamp], 15);
  const air = reg.idOf('air');
  assertEqual(reg.solidTable[air], 0);
});

test('BlockRegistry: freeze 后 register 抛错', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertThrows(() => reg.register('late_block', { solid: true }), 'frozen');
});

test('BlockRegistry: nameOf 反查', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.nameOf(reg.idOf('dirt')), 'dirt');
});
```

并在 `src/tests/index.html` 追加 `import './test-block-registry.js';`。

- [ ] **Step 2: 运行验证失败**

Run: `npm test`
Expected: FAIL —— `block-registry.js`/`blocks-data.js` 不存在。

- [ ] **Step 3: 生成 blocks-data.js（从 mc-lite 转换）**

写一次性转换脚本（不入库，跑完即弃）：读 `~/jaylli/mc-lite/src/constants/BlockData.js` 的 `BLOCK_DATA`（124 键）与 `LIGHT_CONFIGS`（4 发光方块），输出 `src/voxel/blocks-data.js`。转换规则（**逐条写死，不许发挥**）：

```
mc-lite 字段                    → mc-heavy def 字段
isSolid                        → solid
isTransparent === true         → cullMode: 'transparent'（water/swamp_water/glass_block/glass_blink/cloud 等，
                                 但下方 cutout 名单优先）
cutout 名单（优先于 transparent）→ cullMode: 'cutout'：
  ① geometryType ∈ {flower, vine, lilypad, cactus} 的方块；
  ② 树叶族（名字含 leaves，恰好 8 个：leaves/azalea_leaves/yellow_leaves/sky_leaves/
     realistic_oak_leaves/realistic_yellow_leaves/swamp_leaves/snow_leaves；
     flowering_azalea_leaves 只是纹理不是方块，不在列）。对齐设计文档 §4.3「cutout（树叶/花）」。
其余                            → cullMode: 'opaque'
isTransparent && !isRendered   → cullMode: 'none'（air/collider：不渲染）
LIGHT_CONFIGS 中的 4 方块       → emissive: 15（hanging_lamp/glowstone/ochre_froglight/lava）
orientationEnabled             → orientationModes: 4（true）或 0（false）
geometryType                   → geometry 原样保留字符串（16 种取值：box/flower/vine/lilypad/cactus/
                                 half_block/planks_step/cobblestone_step/cobblestone_step_updown/
                                 chimney/handrail/handrailA/handrailB/vertical_pillar/
                                 horizontal_pillar/hanging_lamp）
```

> 简化说明（M0 占位，M1 必须重审）：`opaque` 暂由 `cullMode` 推导（cutout/transparent/none
> → opaque=0）。leaves 的「渲染走 cutout 通道」与「遮光性」是两回事（leaves 遮光）、water
> 走 transparent 通道且不遮光——`opaqueTable` 的最终语义由 M1 mesher/光照任务定义，
> 转换脚本在这里只保证 cullMode 正确，不声称 opaque 正确。

faces 纹理映射**不在本任务**（M1 mesher 任务处理，依赖 atlas.json）；本任务 def 只含上述字段 + `name`。输出文件头部注释注明来源与转换日期。

- [ ] **Step 4: 实现 src/voxel/block-registry.js**

```js
// src/voxel/block-registry.js — 方块注册表 + typed 属性表（设计文档 §4.1）
// 不依赖 three；主线程/Worker 同构可用。

const CULL_MODES = { opaque: 0, cutout: 1, transparent: 2, none: 3 };
const MAX_BLOCKS = 512; // Uint16 ID 空间内预留

export function createRegistry() {
  const nameToId = new Map();
  const idToName = new Array(MAX_BLOCKS).fill(null);
  const solidTable = new Uint8Array(MAX_BLOCKS);
  const opaqueTable = new Uint8Array(MAX_BLOCKS);
  const cullTable = new Uint8Array(MAX_BLOCKS);
  const emissiveTable = new Uint8Array(MAX_BLOCKS);
  const geometryTable = new Uint8Array(MAX_BLOCKS);
  const orientationModesTable = new Uint8Array(MAX_BLOCKS);
  const geometryNames = []; // index → geometryType 字符串
  let count = 0;
  let frozen = false;

  return {
    get count() { return count; },
    solidTable, opaqueTable, cullTable, emissiveTable, geometryTable, orientationModesTable,

    /**
     * @param {string} name
     * @param {{solid?: boolean, opaque?: boolean, cullMode?: string,
     *          emissive?: number, geometry?: string, orientationModes?: number}} def
     */
    register(name, def) {
      if (frozen) throw new Error('registry is frozen');
      if (nameToId.has(name)) throw new Error(`duplicate block name: ${name}`);
      if (count >= MAX_BLOCKS) throw new Error('block id space exhausted');
      const id = count++;
      nameToId.set(name, id);
      idToName[id] = name;
      solidTable[id] = def.solid ? 1 : 0;
      opaqueTable[id] = (def.opaque ?? (def.cullMode === 'opaque')) ? 1 : 0;
      cullTable[id] = CULL_MODES[def.cullMode ?? 'opaque'];
      emissiveTable[id] = def.emissive ?? 0;
      let gi = geometryNames.indexOf(def.geometry ?? 'cube');
      if (gi === -1) { gi = geometryNames.length; geometryNames.push(def.geometry ?? 'cube'); }
      geometryTable[id] = gi;
      orientationModesTable[id] = def.orientationModes ?? 0;
      return id;
    },

    freeze() { frozen = true; },
    idOf(name) { return nameToId.get(name); },
    nameOf(id) { return idToName[id]; },
    geometryNameOf(id) { return geometryNames[geometryTable[id]]; },
  };
}

/** 预填充全部方块的生产单例（main.js / worker 各自构建，数据同源） */
export function buildDefaultRegistry() {
  // 延迟 import 避免循环依赖；blocks-data.js 只含数据
  return import('./blocks-data.js').then(({ BLOCKS }) => {
    const reg = createRegistry();
    for (const def of BLOCKS) reg.register(def.name, def);
    reg.freeze();
    return reg;
  });
}
```

注意：`air` 必须是 `BLOCKS` 数组第一个元素（转换脚本保证），使 `idOf('air') === 0`。

- [ ] **Step 5: 运行验证通过**

Run: `npm test`
Expected: PASS（test-block-registry 5 个用例全过）。

- [ ] **Step 6: lint + Commit**

Run: `npm run lint`（0 errors）

```bash
git add src/voxel src/tests/test-block-registry.js src/tests/index.html
git commit -m "feat(voxel): BlockRegistry + 124 方块数据移植（typed 属性表）"
```

---

### Task 6: 纹理 atlas 构建 + 运行时加载

**Files:**
- Create: `tools/build-atlas.mjs`
- Create: `assets/textures/`（从 mc-lite 复制）
- Create: `assets/atlas.png` + `assets/atlas.json`（产物，提交入库）
- Create: `src/mesh/atlas-loader.js`
- Test: `tests/atlas.spec.mjs`

**Interfaces:**
- Consumes: Task 1 脚手架（静态服务 png/json）。
- Produces: `assets/atlas.json` 格式 `{ size: 2048, gutter: 2, tiles: { "<tileName>": { x, y, w, h, u0, v0, u1, v1 } } }`（UV 已内缩半 texel）；`loadAtlas()` → `Promise<{ texture: THREE.Texture, tileRect(name) → {u0,v0,u1,v1} }>`（M1 mesher 写 UV 的唯一入口）。tileName = 纹理文件名去扩展名（`bed/` 子目录用 `bed/<原名>`）。

- [ ] **Step 1: 复制纹理资产**

```bash
mkdir -p ~/jaylli/mc-heavy/assets
cp -R ~/jaylli/mc-lite/src/assets/textures ~/jaylli/mc-heavy/assets/textures
```

Expected: `assets/textures/` 含 116 个顶层 PNG + `bed/` 6 张（共 122 张）。

- [ ] **Step 2: 实现 tools/build-atlas.mjs**

```js
// tools/build-atlas.mjs — 离线 atlas 打包（设计文档 §4.4.1）
// 用法：npm run atlas。产物：assets/atlas.png + assets/atlas.json。
// 规则：2048×2048；tile 间 2px gutter；shelf 装箱；>128px 的大图（handrail/pillar/
// turret/zombie_nest 等 7 张 250~362px 特殊几何/实体贴图，与代码阈值 LARGE_TILE=128 一致）
// 按 128×128 入图（nearest 采样）——2048² atlas 余量充足（全部 tile 仅占 ~13%），
// 缩到 64×64 会白白损失细节，破坏 M2 的结构轮廓/配色对比验收。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const SIZE = 2048;
const GUTTER = 2;
const LARGE_TILE = 128;

function collectPngs(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectPngs(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.png')) out.push(rel);
  }
  return out.sort();
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// nearest 缩放到 LARGE_TILE×LARGE_TILE（大图专用）
function downscale(src) {
  const dst = new PNG({ width: LARGE_TILE, height: LARGE_TILE });
  for (let y = 0; y < LARGE_TILE; y++) {
    for (let x = 0; x < LARGE_TILE; x++) {
      const sx = Math.floor((x / LARGE_TILE) * src.width);
      const sy = Math.floor((y / LARGE_TILE) * src.height);
      const si = (sy * src.width + sx) << 2;
      const di = (y * LARGE_TILE + x) << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

const atlas = new PNG({ width: SIZE, height: SIZE });
// 填不透明黑底，便于排查未覆盖区域
for (let i = 3; i < atlas.data.length; i += 4) atlas.data[i] = 255;

const tiles = {};
let shelfX = GUTTER, shelfY = GUTTER, shelfH = 0;

for (const rel of collectPngs(TEX_DIR)) {
  let img = readPng(path.join(TEX_DIR, rel));
  if (img.width > LARGE_TILE || img.height > LARGE_TILE) img = downscale(img);
  const w = img.width, h = img.height;
  if (shelfX + w + GUTTER > SIZE) { // 换行
    shelfX = GUTTER;
    shelfY += shelfH + GUTTER;
    shelfH = 0;
  }
  if (shelfY + h + GUTTER > SIZE) throw new Error(`atlas overflow at tile ${rel}`);
  PNG.bitblt(img, atlas, 0, 0, w, h, shelfX, shelfY);

  const name = rel.replace(/\.png$/, '');
  const halfTexel = 0.5 / SIZE;
  tiles[name] = {
    x: shelfX, y: shelfY, w, h,
    u0: shelfX / SIZE + halfTexel,
    v0: 1 - (shelfY + h) / SIZE + halfTexel, // PNG 行序翻转 → v 翻转
    u1: (shelfX + w) / SIZE - halfTexel,
    v1: 1 - shelfY / SIZE - halfTexel,
  };
  shelfX += w + GUTTER;
  shelfH = Math.max(shelfH, h);
}

fs.writeFileSync(path.join(ROOT, 'assets', 'atlas.png'), PNG.sync.write(atlas));
fs.writeFileSync(path.join(ROOT, 'assets', 'atlas.json'),
  JSON.stringify({ size: SIZE, gutter: GUTTER, tiles }, null, 1));
console.log(`atlas: ${Object.keys(tiles).length} tiles → assets/atlas.png (${SIZE}x${SIZE})`);
```

- [ ] **Step 3: 运行构建并验证产物**

Run: `npm run atlas`
Expected: 输出 `atlas: 122 tiles → assets/atlas.png (2048x2048)`；`assets/atlas.png`/`atlas.json` 生成。

- [ ] **Step 4: 实现 src/mesh/atlas-loader.js**

```js
// src/mesh/atlas-loader.js — atlas 运行时加载（设计文档 §4.4.1）
import * as THREE from 'three';

/**
 * @returns {Promise<{texture: THREE.Texture, tileRect: (name: string) => {u0:number,v0:number,u1:number,v1:number}}>}
 */
export async function loadAtlas() {
  const [meta, texture] = await Promise.all([
    fetch('./assets/atlas.json').then((r) => r.json()),
    new THREE.TextureLoader().loadAsync('./assets/atlas.png'),
  ]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter; // 默认像素风，无 mipmap（§4.4.1）
  texture.generateMipmaps = false;
  texture.flipY = false; // atlas.json 的 v 已按 PNG 行序预翻转

  const rects = new Map();
  for (const [name, t] of Object.entries(meta.tiles)) {
    rects.set(name, { u0: t.u0, v0: t.v0, u1: t.u1, v1: t.v1 });
  }
  return {
    texture,
    tileRect(name) {
      const r = rects.get(name);
      if (!r) throw new Error(`unknown atlas tile: ${name}`);
      return r;
    },
  };
}
```

- [ ] **Step 5: 写 Playwright 验收 tests/atlas.spec.mjs**

```js
import { test, expect } from 'playwright/test';

test('atlas 覆盖 mc-lite 全部 122 张纹理且 UV 合法', async ({ page }) => {
  await page.goto('/src/tests/index.html'); // 任意页面，只为同源 fetch
  const report = await page.evaluate(async () => {
    const meta = await (await fetch('/assets/atlas.json')).json();
    const names = Object.keys(meta.tiles);
    const bad = names.filter((n) => {
      const t = meta.tiles[n];
      return !(t.u0 < t.u1 && t.v0 < t.v1 &&
               t.u0 >= 0 && t.u1 <= 1 && t.v0 >= 0 && t.v1 <= 1);
    });
    // 抽查关键 tile 存在
    const need = ['stone', 'dirt', 'grass_carried', 'Bedrock', 'Glowstone',
                  'Glass', 'bed/Bed_(top_texture)_JE1_BE1'];
    const missing = need.filter((n) => !meta.tiles[n]);
    return { count: names.length, bad, missing, size: meta.size, gutter: meta.gutter };
  });
  expect(report.count).toBe(122);
  expect(report.bad).toEqual([]);
  expect(report.missing).toEqual([]);
  expect(report.size).toBe(2048);
  expect(report.gutter).toBe(2);
});

test('atlas 纹理可被 three 加载（WebGPU 环境）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const ok = await page.evaluate(async () => {
    const { loadAtlas } = await import('/src/mesh/atlas-loader.js');
    const { texture, tileRect } = await loadAtlas();
    const r = tileRect('stone');
    return texture.image.width === 2048 && r.u1 > r.u0;
  });
  expect(ok).toBe(true);
});
```

- [ ] **Step 6: 运行验证通过**

Run: `npm test`
Expected: PASS（atlas 两个用例全过）。

- [ ] **Step 7: Commit**

```bash
git add tools assets src/mesh tests/atlas.spec.mjs package.json
git commit -m "feat(render): 纹理 atlas 离线构建（122 tiles）+ 运行时加载"
```

---

### Task 7: WebGPU 发布路径语义实测（M0 决策依据）

**Files:**
- Create: `src/bench/webgpu-publish.html`
- Create: `tests/webgpu-publish.spec.mjs`

**Interfaces:**
- Consumes: Task 1（WebGPU 环境）、three import map。
- Produces: `window.__BENCH__` = `{ threeGroup, twentyFourGroup, batchedRaw, batchedCulled, setGeometryAt }`，渲染组每项 `{ drawCalls, cpuMs }`（`renderer.info.render.drawCalls` 每帧 GPU draw 数 + 100 帧渲染循环的 CPU 均值），`setGeometryAt` 为 `{ replaceAvgMs }`（主线程 slot 替换平均耗时）。这是设计文档 §4.4.2/M0 的实测依据，结果写入 M0 验收报告。

**预期断言**：
- 指标口径（r185.1 Info.js 已核验）：用 `renderer.info.render.drawCalls`（每帧 GPU draw 数，
  `reset()` 清零，后端在每次 `drawIndexed` 时经 `info.update()` 累加——WebGPUBackend.js:1832）。
  **不要**用 `info.render.calls`（累计值，reset 不清零）。
- **三条 drawCalls 断言来自 r185.1 源码核验，是冻结口径，实测不符即停下报告，不得擅改**：
  3-group 单 Mesh → `drawCalls === 3`（Renderer.js:3149-3158 逐 group push）；
  24-group 单 Mesh → `drawCalls === 24`；
  BatchedMesh 挂 N=2312 instance（关闭剔除/排序）→ `drawCalls === 2312`（WebGPUBackend.js:1806-1824 逐 instance drawIndexed，**非 multi-draw**）。
- **cpuMs 阈值是计划自定、环境相关**（本地真 GPU vs CI SwiftShader 软件光栅化差异大）：
  本地硬门槛 <4ms/帧（120fps 预算 8.3ms 的一半），CI 放宽为 <30ms 仅作趋势参考；
  断言用 `process.env.CI` 分支，不写死单一数字。
- **setGeometryAt 快路径（设计文档 §7 M0 ③，明确要求）**：flat 属性 `array.set` 快路径的
  单次替换 <2ms——这是纯主线程内存拷贝，不经过 GPU，因此该阈值环境无关，硬门槛。

- [ ] **Step 1: 实现 src/bench/webgpu-publish.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>webgpu publish bench</title></head>
<body>
<script type="module">
import * as THREE from 'three';

function makeSectionGeometry(seed) {
  // 一个"section"的语义替身：100 个三角形（flat 属性，与 §4.3 顶点格式同构）。
  // 只验证 draw 命令语义与 per-instance CPU 循环量级，不验证几何吞吐；
  // 几何吞吐/快路径由下方 benchSetGeometryAt 的 1000 面真实量级用例验证。
  const tri = 100, v = tri * 3;
  const pos = new Float32Array(v * 3);
  const uv = new Float32Array(v * 2);
  const packed = new Uint32Array(v);
  for (let i = 0; i < v; i++) {
    pos[i * 3] = ((i * 7 + seed) % 16);
    pos[i * 3 + 1] = ((i * 13 + seed) % 16);
    pos[i * 3 + 2] = ((i * 5 + seed) % 16);
    packed[i] = 0xFF;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('packed', new THREE.BufferAttribute(packed, 1));
  return g;
}

async function benchCase(name, buildScene) {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setSize(640, 480);
  document.body.appendChild(renderer.domElement);
  await renderer.init();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 640 / 480, 0.1, 2000);
  // 相机俯视网格中心（x/z ∈ [0,94] → 中心 (47,47)），裕量远大于斜视布置：
  // 远端角实例球心偏离视轴仅 ~19°，距 35° 半视锥有充足余量，杜绝边界剔除的 flaky。
  camera.position.set(47, 180, 47);
  camera.up.set(0, 0, -1); // 垂直俯视时默认 up=(0,1,0) 与视线平行会退化，必须改
  camera.lookAt(47, 0, 47);
  buildScene(scene);

  // 预热 10 帧
  for (let i = 0; i < 10; i++) renderer.render(scene, camera);
  renderer.info.autoReset = false;

  let cpuTotal = 0;
  let calls = 0;
  const frames = 100;
  for (let i = 0; i < frames; i++) {
    renderer.info.reset(); // drawCalls 每帧清零（calls 是累计值且 reset 不清，勿用）
    const t0 = performance.now();
    renderer.render(scene, camera);
    cpuTotal += performance.now() - t0;
    calls = renderer.info.render.drawCalls; // 每帧 GPU draw 数（后端逐 drawIndexed 累加）
  }
  renderer.info.autoReset = true;
  renderer.dispose();
  renderer.domElement.remove();
  return { name, drawCalls: calls, cpuMs: cpuTotal / frames };
}

// 设计文档 §7 M0 ③：setGeometryAt 单块编辑快路径（flat 属性 array.set 拷贝路径）
async function benchSetGeometryAt() {
  const renderer = new THREE.WebGPURenderer({ antialias: false });
  renderer.setSize(640, 480);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  // 真实量级 section 替身：约 1000 面 = 4000 顶点（flat 三属性，与 §4.3 顶点格式一致）
  const faces = 1000, v = faces * 4;
  const pos = new Float32Array(v * 3);
  const uv = new Float32Array(v * 2);
  const packed = new Uint32Array(v);
  for (let i = 0; i < v; i++) {
    pos[i * 3] = ((i * 7 + 1) % 16);
    pos[i * 3 + 1] = ((i * 13 + 2) % 16);
    pos[i * 3 + 2] = ((i * 5 + 3) % 16);
    packed[i] = 0xFFFF;
  }
  const idx = new Uint32Array(faces * 6);
  for (let f = 0; f < faces; f++) {
    const b = f * 4, o = f * 6;
    idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
    idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
  }
  const make = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('packed', new THREE.BufferAttribute(packed, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  };

  const scene = new THREE.Scene();
  const bm = new THREE.BatchedMesh(1, v * 2, idx.length * 2, new THREE.MeshBasicMaterial());
  const reservedVertices = Math.ceil(v * 1.25);
  const reservedIndices = Math.ceil(idx.length * 1.25);
  const gid = bm.addGeometry(make(), reservedVertices, reservedIndices);
  const iid = bm.addInstance(gid);
  bm.setMatrixAt(iid, new THREE.Matrix4().makeTranslation(0, 0, 0));
  scene.add(bm);

  const camera = new THREE.PerspectiveCamera(70, 640 / 480, 0.1, 100);
  camera.position.set(8, 24, 8);
  camera.lookAt(8, 8, 8);

  // 预热 + 首次上传
  for (let i = 0; i < 10; i++) renderer.render(scene, camera);

  // 预构造两份几何，交替 setGeometryAt；计时只含 slot 拷贝路径，不含 BufferAttribute 分配
  const gA = make(), gB = make();
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) bm.setGeometryAt(gid, i % 2 ? gA : gB);
  const replaceAvgMs = (performance.now() - t0) / N;

  renderer.dispose();
  renderer.domElement.remove();
  return { name: 'setGeometryAt', replaceAvgMs };
}

async function run() {
  const mat = new THREE.MeshBasicMaterial({ color: 0x88ccff });
  const mats = [mat, mat.clone(), mat.clone()];

  const threeGroup = await benchCase('3-group', (scene) => {
    const g = makeSectionGeometry(1);
    const n = g.attributes.position.count;
    const third = Math.floor(n / 3 / 3) * 3; // 每 group 整数个三角形
    g.clearGroups();
    g.addGroup(0, third, 0);
    g.addGroup(third, third, 1);
    g.addGroup(third * 2, n - third * 2, 2);
    scene.add(new THREE.Mesh(g, mats));
  });

  const twentyFourGroup = await benchCase('24-group', (scene) => {
    const g = makeSectionGeometry(2);
    const n = g.attributes.position.count;
    const unit = Math.floor(n / 24 / 3) * 3;
    g.clearGroups();
    for (let i = 0; i < 24; i++) {
      g.addGroup(i * unit, i === 23 ? n - 23 * unit : unit, i % 3);
    }
    scene.add(new THREE.Mesh(g, mats));
  });

  const N = 2312; // 视距 8 = 289 column × 8 section（设计文档 §4.4.2）
  // 共享 1 个 geometry + N 个 instance（正确用法：addGeometry 一次，addInstance N 次）；
  // 实例排成 48×48 网格、间距 2 格（x/z ∈ [0,94]），相机在网格中心正上方俯视，全部可见。
  function buildBatched(scene, { culled }) {
    const bm = new THREE.BatchedMesh(N, N * 300, N * 600, mat);
    bm.perObjectFrustumCulled = culled;
    bm.sortObjects = culled;
    const gid = bm.addGeometry(makeSectionGeometry(3));
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const iid = bm.addInstance(gid);
      m4.makeTranslation((i % 48) * 2, 0, Math.floor(i / 48) * 2);
      bm.setMatrixAt(iid, m4);
    }
    scene.add(bm);
  }

  // raw：关剔除/排序，验证逐 instance draw 命令数
  const batchedRaw = await benchCase('batched-raw', (scene) => buildBatched(scene, { culled: false }));
  // culled：开剔除+排序，测 per-instance CPU 循环成本（全部 instance 应可见）
  const batchedCulled = await benchCase('batched-culled', (scene) => buildBatched(scene, { culled: true }));

  // 设计文档 §7 M0 ③：setGeometryAt 快路径
  const setGeometryAt = await benchSetGeometryAt();

  window.__BENCH__ = { threeGroup, twentyFourGroup, batchedRaw, batchedCulled, setGeometryAt };
}

run().catch((e) => { window.__BENCH__ = { error: String(e) }; });
</script>
</body>
</html>
```

- [ ] **Step 2: 写 tests/webgpu-publish.spec.mjs**

```js
import { test, expect } from 'playwright/test';

test('WebGPU 发布路径语义实测（设计文档 v1.7 断言）', async ({ page }) => {
  await page.goto('/src/bench/webgpu-publish.html');
  await page.waitForFunction(() => window.__BENCH__ !== undefined, null, { timeout: 120_000 });
  const b = await page.evaluate(() => window.__BENCH__);
  expect(b.error).toBeUndefined();

  // 1. material 数组逐 group 发 draw（Renderer.js:3149-3158）
  expect(b.threeGroup.drawCalls).toBe(3);
  expect(b.twentyFourGroup.drawCalls).toBe(24);

  // 2. WebGPU 后端 BatchedMesh 非 multi-draw：逐 instance 一次 draw
  //    （WebGPUBackend.js:1806-1824）
  expect(b.batchedRaw.drawCalls).toBe(2312);

  // 3. 开剔除+排序且全部 instance 可见：命令数不变；CPU 循环阈值环境相关
  //    （本地真 GPU 硬门槛 4ms/帧 = 120fps 预算的一半；CI SwiftShader 放宽 30ms 趋势参考）
  expect(b.batchedCulled.drawCalls).toBe(2312);
  expect(b.batchedCulled.cpuMs).toBeLessThan(process.env.CI ? 30 : 4);

  // 4. setGeometryAt 快路径：纯主线程拷贝，环境无关，硬门槛 2ms（设计文档 §7 M0 ③）
  expect(b.setGeometryAt.replaceAvgMs).toBeLessThan(2);

  console.log('BENCH RESULT:', JSON.stringify(b));
});
```

- [ ] **Step 3: 运行实测**

Run: `npm test`
Expected: PASS。**若三条冻结 drawCalls 断言或 setGeometryAt < 2ms 断言失败**（例如 BatchedMesh
命令数 ≠ 2312，说明 three 版本行为与设计文档 v1.7 核验不符）：**停止，把实际数字报告给用户**，
由用户决定更新设计文档还是调整实现——不要擅自改断言。cpuMs 是环境相关阈值，超了只记录、
不阻塞（本地真 GPU 下超 4ms 需单独报告分析）。

- [ ] **Step 4: 把实测结果写入验收报告**

Create `docs/m0-bench-report.md`，记录：测试环境（浏览器/设备/刷新率/是否 SwiftShader）、
三组渲染路径 drawCalls/cpuMs 与 setGeometryAt 替换耗时实测值、与设计文档 v1.7 预期的对照结论。

- [ ] **Step 5: Commit**

```bash
git add src/bench tests/webgpu-publish.spec.mjs docs/m0-bench-report.md
git commit -m "perf(bench): WebGPU 发布路径语义实测（3-group/24-group/BatchedMesh/setGeometryAt）"
```

---

## M0 验收清单（设计文档 §7）

全部任务完成后逐项核对：

1. `npm start` → `http://localhost:8081/` 空白场景渲染（天空蓝），HUD 显示 fps 与帧时分位数；
2. `navigator.gpu` 缺失时显示明确错误提示（可临时在 DevTools 覆盖 `navigator.gpu = undefined` 验证）；
3. `npm test` 全绿：harness / worker-pool / atlas / webgpu-publish 四组 Playwright 验收 + 浏览器内单测（perf / block-registry / smoke）；
4. atlas 覆盖 mc-lite 全部 122 张纹理，2px gutter + 半 texel 内缩；
5. `docs/m0-bench-report.md` 产出三组渲染路径 drawCalls/cpuMs 与 setGeometryAt 替换耗时，与设计文档 v1.7 预期对照；
6. `npm run lint` 0 errors。

## Self-Review 记录

- **Spec 覆盖**：设计文档 §7 M0 全部交付一一对应——脚手架/import map（Task 1）、浏览器测试 harness（Task 2）、perf 打点 + HUD（Task 3）、Worker 池 RPC（Task 4）、BlockRegistry（Task 5）、atlas（Task 6）、WebGPU 语义实测三项 ① 3-group/24-group ② BatchedMesh 命令数与 CPU 循环 ③ setGeometryAt 快路径（Task 7 五组 bench 用例全覆盖）；验收口径（空白场景 + HUD + atlas 全覆盖 + bench 报告）→ M0 验收清单。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码；断言数字全部来自设计文档 v1.7 源码核验或本计划实测探针（124 方块、122 纹理、4 发光方块、16 geometryType、端口 8081、playwright 1.62.1/chromium-1234、channel:'chromium' 零 flag 走 Metal / headless shell 需 SwiftShader 的实测矩阵，均已对本机与 mc-lite 实际文件核验）。
- **类型一致性**：`PerfMonitor.snapshot()` 的 `{fps, frameMs:{p50,p95,p99}, marks}` 在 Task 3 定义、perf-hud 与后续 M1 消费一致；`WorkerPool.call(method, payload, {transfer})` 签名在 Task 4 定义、Task 4 fixture 与 M1 GEN/MESH 任务消费一致；`tileRect(name)` 在 Task 6 定义、M1 mesher 消费；`registry.solidTable/cullTable/...` 表名在 Task 5 定义与测试断言一致。
- **已知留白（非本计划范围）**：faces 纹理映射（M1 mesher 任务，依赖 atlas.json + BlockRegistry 双输入）；`buildDefaultRegistry()` 的异步 import 在 worker 侧的用法（M1 world-worker 任务落地时验证 module worker 相对路径约束）。
