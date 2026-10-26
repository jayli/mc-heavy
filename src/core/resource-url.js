// src/core/resource-url.js — 资源 URL 的部署路径无关解析（v1.87）
//
// **为什么需要这一层**：`fetch('/assets/atlas.json')` / `new Worker('/src/workers/world-worker.js')`
// 这类字符串里开头的 `/` 表示 **origin 根**，与文档所在路径无关。因此把仓库挂在子路径下
// （`http://host/mc-heavy/`）时，全部资源请求会解析到上一级 → 全部 404，游戏页停在错误遮罩上。
// 实测（v1.87 修复前，仓库挂 `/mc-heavy/`）：`/src/workers/world-worker.js` ×多次、
// `/assets/atlas.png`、`/assets/atlas.json` 全 404，`window.__MC_GAME__` 不存在。
//
// **为什么用 `import.meta.url` 而不是「相对路径」或「运行时探测前缀」**：
//   - 纯相对路径（`'assets/atlas.json'`）按**文档基址**解析 —— fixture 页在 `/src/tests/` 下时
//     会去找 `/src/tests/assets/*`（404）。这正是本仓当初改成根绝对路径的原因。
//   - 运行时探测站点前缀要区分主线程 / Worker / 文档基址，而 **Worker 里没有 `document`**。
//   - `import.meta.url` 是**模块自己的 URL**：谁加载资源就相对它自己解析，与文档位置、
//     部署前缀、主线程还是 Worker 全都无关。本模块在 `src/core/`，故 `../../` 恒为仓库根。
//
// **本文件是资源 URL 的唯一权威**（红线 1）：`src/**` 下的资源引用一律经本模块，
// `npm run check:arch` 静态禁止出现 `'/assets/`、`'/src/`、`'/vendor/` 这类根绝对路径字面量。
// 非代码资源（`src/render/sky-config.js` 的 `SKY_DIR = 'assets/sky'`）保持**仓库相对路径**
// 不变 —— 它被 node 侧 `check:data` 用 `path.join(ROOT, ...)` 消费，URL 转换只发生在消费端。
//
// 无 three、无 DOM：主线程与 Worker（红线 8/10 同构层）都可安全 import。

/**
 * 本模块自身的 URL。**基址只有一个**：所有调用方都相对「本模块所在目录」上溯两级取仓库根，
 * 而不是相对各自的模块位置 —— 否则每加一个不同深度的调用方就要重算层级。
 */
const SELF_URL = import.meta.url;

/**
 * 纯函数：把**仓库相对路径**解析成绝对 URL（可注入模块 URL，故子路径部署语义可单测）。
 *
 * ⚠️ **必须剥前导斜杠**：`new URL('/assets/x', base)` 会丢弃 base 的**路径部分**退回 origin 根，
 * 正是本模块要消除的语义。剥掉后含 `/` 的路径才会相对仓库根正确拼接。
 *
 * @param {string} moduleUrl 本模块的绝对 URL（`import.meta.url`）
 * @param {string} relPath 仓库相对路径（如 `assets/atlas.json`、`src/workers/world-worker.js`）
 * @returns {string} 绝对 URL 串
 */
export function resourceUrlFrom(moduleUrl, relPath) {
  const repoRoot = new URL('../../', moduleUrl);
  return new URL(String(relPath).replace(/^\/+/, ''), repoRoot).href;
}

/**
 * 把仓库相对路径解析成可直接交给 `fetch` / `TextureLoader` / `new Worker` 的绝对 URL。
 *
 * 与部署路径无关：根路径部署得到 `http://host/assets/x`，子路径部署得到
 * `http://host/mc-heavy/assets/x` —— 两者都正确，调用方无需知道前缀。
 *
 * @param {string} relPath 仓库相对路径（如 `assets/atlas.json`）
 * @returns {string} 绝对 URL 串
 */
export function resourceUrl(relPath) {
  return resourceUrlFrom(SELF_URL, relPath);
}
