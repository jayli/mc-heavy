# 资源 URL 改为部署路径无关（子路径部署修复）

日期：2026-10-26 ｜ slug：`deploy-relative-asset-urls` ｜ 目标版本：v1.87

## 1. 问题

mc-heavy 的所有资源 URL 都写成**站点根绝对路径**（以 `/` 开头）：`/assets/...`、
`/src/workers/world-worker.js`、`/vendor/...`。浏览器把开头的 `/` 解释成**服务器根**，
与文档所在路径无关。于是把仓库挂在 `/mc-heavy/` 子路径下（例如在上级目录
`/Users/bachi/jaylli/` 起一个静态服务，访问 `http://127.0.0.1:8080/mc-heavy/`）时，
全部请求解析到上一级 → 404，游戏页停在错误遮罩上。

**已复现取证**（临时服务器把仓库挂到 `http://127.0.0.1:8099/mc-heavy/`）：

```
404  http://127.0.0.1:8099/src/workers/world-worker.js   （×多次，Worker 池全部起不来）
404  http://127.0.0.1:8099/assets/atlas.png
404  http://127.0.0.1:8099/assets/atlas.json
STATE: {"hasGame":false,"ready":false,"errVisible":"flex"}
```

用户看到的是 `atlas.json` / `atlas.png` 两条，但实际 404 面更广：Worker 入口、天空盒、
icon manifest、枪 GLB、音效、结构 JSON、巢穴蓝图、巨树 `trees.json` 都是同一根因，
只是 atlas 先抛。

## 2. 根因

`fetch('/assets/atlas.json')`、`new Worker('/src/workers/world-worker.js')` 这类字符串里，
开头的 `/` 表示「origin 根」。项目一直只在 `http://localhost:8081/` 根路径下跑，
所以从未暴露。

`src/tests/index.html` 与各 fixture 页当初改成绝对路径，是因为它们自己在 `/src/tests/` 下、
相对路径会解析到 `/src/tests/assets/*`。**`import.meta.url` 相对解析能同时满足两种场景**，
而根绝对路径只能满足其中一个。

## 3. 方案

不做「运行时探测前缀再拼串」（还要区分主线程 / Worker / 文档基址，且 Worker 里没有
`document`）。改用 **`import.meta.url` 派生**：谁加载资源，就相对**它自己这个模块的 URL**
解析。与部署路径彻底解耦 —— 根路径、任意子路径、fixture 子目录全都成立。

### 3.1 新增唯一权威模块 `src/core/resource-url.js`

```js
// 部署路径无关的资源 URL 解析：相对本模块自身的 import.meta.url（src/core/）取仓库根，
// 再拼仓库相对路径。node 与浏览器、主线程与 Worker 全都成立。
const RESOURCE_ROOT_URL = new URL('../../', import.meta.url);
export function resourceUrl(relPath) {
  return new URL(String(relPath).replace(/^\/+/, ''), RESOURCE_ROOT_URL).href;
}
```

- 入参统一是**仓库相对路径**（`assets/atlas.json`、`src/workers/world-worker.js`），
  前导 `/` 被剥掉 —— 调用方无法再把根绝对路径引回来。
- 只用 `URL` + `import.meta.url`：无 three、无 DOM，Worker 同构层可安全 import
  （`check:arch` 红线 8/10 不受影响；`core/` 已被 `mesh/mesher.js`、
  `render/render-world.js`、`workers/world-worker.js` 跨层 import，有既有先例）。

### 3.2 全部资源引用改走 `resourceUrl(...)`（12 个源文件）

| 文件 | 现状 |
|---|---|
| `src/mesh/atlas-loader.js` | `fetch('/assets/atlas.json')`、`loadAsync('/assets/atlas.png')` |
| `src/core/game.js` | `workerUrl: '/src/workers/world-worker.js'`、两处 `fetch('/assets/atlas.json')` |
| `src/ui/icons.js` | `MANIFEST_URL` / `ATLAS_URL` 常量（CSS 串里的 `url(...)` 仍由运行时替换成解析后的绝对 URL，产物「不绑死部署路径」的口径不变） |
| `src/render/sky.js` | `CubeTextureLoader().setPath(dir)` 按**文档基址**解析相对串 ——
  **实测**：fixture 页（`/src/tests/`）下会解析成 `/src/tests/assets/sky/day/posx.jpg`（404）。
  子路径部署的游戏页反而正常（文档基址已含前缀）→ 这一处是**顺带修的旧隐患**，不是本次缺陷的成因。 |
| `src/render/audio-manager.js` | `/assets/sounds/${id}.mp3` |
| `src/render/weapon-model-loader.js` | `WEAPON_ASSET_URLS` 三项 |
| `src/render/zombie-head-texture.js` | `/assets/zombie/head.png` |
| `src/render/turret-armor-texture.js` | `/assets/turret/armor.png` |
| `src/render/explosion-sprite.js` | `/assets/effects/big_blow.png` |
| `src/gen/structures/structure-json.js` | `/assets/structures/${...}` |
| `src/gen/structures/giant-trees.js` | `/assets/giant-trees/trees.json`（Worker 内 fetch） |
| `src/entities/zombie-nests/nest-blueprint.js` | `BLUEPRINT_URL` |

`src/render/sky-config.js` **不动**：`SKY_DIR = 'assets/sky'` 已是仓库相对路径，且被 node 侧
`check:data` 的 `[天空盒]` 环节用 `path.join(ROOT, ...)` 消费 —— 改成 URL 会打断那条门禁。
转换只发生在消费端（`sky.js`）。

### 3.3 12 个 HTML 的 import map 改为相对

`src/tests/*.html`（11 个）+ `src/bench/webgpu-publish.html` 的
`"three": "/vendor/three/..."` → `"../../vendor/three/..."`（这些文件都恰好比仓库根深 2 层）。
`index.html` 本来就是 `./vendor/`，不动。import map 的值按**文档基址**解析，这里必须相对形式。

### 3.4 `src/tests/**` 同类引用一并改（约 13 处）

`test-ui.js`（含一条断言 `css.includes("/assets/icons-atlas.png")` → 改断言含
`resourceUrl('assets/icons-atlas.png')`，更强：验的是「解析成了部署路径下的地址」）、
`test-mesher.js`、`test-iso-icon.js`、`test-giant-trees.js`、`test-structure-json.js`、
`test-worker-gen.html`、`test-structure-gen.html`、`test-light-init.html`、`test-ao.html`、
`test-ao-corner.html`、`test-render-world.html`、`test-sky-tree.html`、
`test-lamp-compare.html`、`test-block-hit-fx.html`、`test-step-icons.html`、
`test-step-icon-methods.html`。

这样 `src/**` 全域口径统一，门禁才没有例外要记。

### 3.5 新增静态门禁（防回归）

`tools/check-architecture.mjs` 加一条：`src/**/*.js` 与 `src/**/*.html` 的**非注释代码行**
不得出现 `'/assets/`、`"/assets/`、`'/src/`、`"/src/`、`'/vendor/`、`"/vendor/`。
违反即报「资源路径必须走 resourceUrl()（站点根绝对路径在子路径部署下 404）」。

理由：这是同一类缺陷的**唯一**结构防线 —— 现有 15 个文件靠人肉记规矩；不加门禁，
下次新加一个资源加载点就会静默复发，而且只在「别人用子路径部署」时暴露，本机永远测不到。
`tests/*.spec.mjs` 不在扫描范围（Playwright 侧固定打 repo 根，`baseURL` 就是根）。

### 3.6 文档同步

- `docs/roadmap.md`：改动表加 `v1.87` 一行，写清根因、复现数据、门禁。
- `docs/phase-1-engine-design.md`：首行版本号 + 修订说明加 v1.87 段（架构口径变更：
  资源 URL 唯一权威 = `src/core/resource-url.js`）。
- `AGENTS.md`：目录结构 `core/` 补 `resource-url.js`；「活跃约束」加一条
  （资源 URL 只能走 `resourceUrl()`，`check:arch` 有此门）。

## 4. 验证

1. **主判据（真缺陷场景）**：仓库挂在 `http://127.0.0.1:8099/mc-heavy/`（临时服务器 +
   临时探针 spec，`.gitignore` 已忽略 `tests/tmp-*`），断言：**0 个 4xx/5xx 响应**、
   `window.__MC_GAME__.worldReady === true`、无 pageerror。
2. **根部署零回归**：`npm run check`（check:arch 新门 + check:data + lint）exit 0；
   浏览器内全量单测（`harness.spec.mjs`）0 失败。
3. **消费资源的 spec 抽跑**（按 testing-policy「该 spec 是否消费被改的变量」选最小充分集）：
   `atlas`、`render-terrain`、`m3-1-inventory`、`weapon-assets`、`zombie-head`、
   `turret-render`、`explosion-sprite`、`m3-rain`（天空盒）、`giant-trees`（Worker 内 trees.json）。
4. **负向验证（必须真 FAIL）**：把 `src/mesh/atlas-loader.js` 临时改回
   `'/assets/atlas.json'` → ① 子路径探针须重新出现 404 且 `hasGame:false`；
   ② `npm run check:arch` 须报违规。用 `cp` 副本还原（不对含未提交改动的文件用
   `git checkout`），`diff` 逐位核对还原。
5. **实测记录**：把子路径探针改造前后的 404 清单与 `worldReady` 读数写进 roadmap 那一行。

## 5. 不做

- 不改 `server-script/start-server.js`（开发服务器仍只服务根路径；本次修的是**客户端解析**）。
- 不改 `tests/*.spec.mjs` 的 `page.goto('/...')`（Playwright 固定打 repo 根，无对应收益）。
- 不加 `?base=` 之类运行时前缀参数（`import.meta.url` 已覆盖所有部署形态，
  多一个旋钮就多一条没被测过的路径）。
