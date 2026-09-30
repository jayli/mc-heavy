# 设置面板：导入进度 / 导出进度（2026-09-30）

## 目标

在设置面板右列的创造台行增加「导入进度 / 导出进度」两个按钮，行标题由「创造台」改为
「创造台和进度管理」。

- **导出进度**：把当前世界的完整存档写成 JSON 文件下载 —— `seed` + **全部**玩家改过的方块
  （含未加载 column，`edits` store 里有的都在）+ 持久实体（矿车）+ 炮塔/巢穴/创造台的
  `blockEntity` 锚点。
- **导入进度**：选一个 JSON 文件，**覆盖式**恢复：清空当前改动 → 写入包里的 seed 与改动 →
  重载世界（走「新世界 / 删除缓存」的既有路径）。
- 按钮排布（用户已确认）：第一行 `[打开创造台(变窄)][导入进度][导出进度]` 常驻可见；
  第二行 `[导出模型][导入模型]` 仍只在创造台激活时显示。

## 现状与约束（勘查结论）

- 本仓世界 = **seed + 玩家改动差异**（红线 2：地形由 seed 确定性重建，存档只存 diff）。
  「进度」= `meta.seed` + `edits` store（`columnKey → [{index,id,meta,blockEntity?}]`）
  + `entities` store（持久实体 snapshot）。逐格导出地形既不必要也不可行（视距 8 的 289 列
  全量约上亿字符）。
- 面板右列宽约 351px（v1.35 实测），「打开创造台」5 个汉字约 68px；5 个按钮挤一行会换行。
- `PANEL_CSS` 是 **JS 模板字面量** —— 注释里禁用反引号（会提前终止模板串 → 整页白屏）。
- `PANEL_CSS` 按钮基线 `flex: 1`（等宽铺满）→「变窄」须在面板作用域内覆写，不能改基线
  （`.mc-footer` 的「确定」按钮依赖它）。
- 导入要重载，走 `Game._discardEdits()`（**唯一丢弃入口**：取消在途 flush + 清内存 edits
  + 清两个 store）→ 与 `newWorld`/`clearSave` 共用，不新写第二份丢弃逻辑。
- M5 持久层只有 `listBlockEntities(kind)` 这种按 kind 的 cursor 扫描，**没有全量枚举 edits
  的 API** → 需补 `listEdits()`。

## 关键设计决策

1. **文件格式（自有格式 `mc-heavy-progress` v1）**：方块用**名字**而非数字 id（跨版本稳定；
   未知名字在导入时计入 `invalid` 并跳过，**绝不写 air** —— M9 导入踩过同一个坑）。cells 用
   `columnKey + 列内局部坐标 (lx,y,lz)`（与存储层同构，导出/导入各只做一次算术）。
2. **逻辑抽成 codec 纯函数**（`encodeProgress` / `decodeProgress`），`Game` 只做 I/O 与落盘
   → 校验与坐标映射可被 Tier 1 单测覆盖，不必靠 E2E 兜。
3. **导出前必须先 `flushNow(world)`**：刚建的房子还在内存 edits 里（5s 防抖未到），不先落库
   会导出一份旧进度。这是最容易漏的一步，会有单测 + 负向验证钉住。
4. **导入 = 覆盖式**（清空当前改动）。包自带 `format`/`version`，version 高于当前 →
   `unsupported-version`，拒绝而不是猜着读。
5. **不做的事（如实登记）**：不导出玩家位置（消费它需要改出生点逻辑，与既有 `meta.spawn`
   语义冲突；导入后仍出生在城市中心）；不做二次确认（导入前可先导出兜底）；不对超大文件做
   资源预检（解析全程在 try/catch 内，失败报错而非静默）；不兼容 mc-lite 存档（那是 roadmap
   的「存档迁移」扩展点）。
6. **非原子性**：导入分步写（discard → meta → edits → entities → reload），中途 IndexedDB
   报错则世界停在「空改动」状态并 toast 报错；重新点一次导入即可（幂等）。不引入临时 store
   交换（要 DB 版本升级，成本远超收益）。

## 改动清单

**新增 `src/save/progress-codec.js`**（纯函数，无 DOM/three）
- `PROGRESS_FORMAT = 'mc-heavy-progress'`、`PROGRESS_VERSION = 1`
- `encodeProgress({seed, spawn, columns, entities}, registry)` → JSON 字符串。
  `columns` = `[{columnKey, edits}]`，index 经 `decodeBlockIndex` 反解为坐标。
- `decodeProgress(jsonText, registry)` → `{ok:true, seed, spawn, edits, entities, invalid, skipped}`
  （`edits` = `[{columnKey, edits:[{index,id,meta,blockEntity?}]}]`，可直接喂 `saveColumnEdits`）；
  失败 → `{ok:false, reason: 'invalid-json'|'invalid-format'|'unsupported-version'|'invalid-seed'}`。
  校验全部在同一步完成，**失败时零输出**。

**`src/voxel/constants.js`**：新增 `decodeBlockIndex(index)` → `{lx, y, lz}`，紧跟 `blockIndex`
放（编码与其逆同一处，避免两处算术漂移）。

**`src/save/persistence.js`**：新增 `listEdits()`（cursor 全量遍历，返回
`[{columnKey, edits}]`），与 `listBlockEntities` 同一手法。

**`src/core/game.js`**
- `async exportProgress()`：`flushNow` → `listEdits()` → 合并持久实体（以 `entitiesCache` 为底，
  用 `entities.serializePersistent()` 覆盖同 id，保证活跃实体状态最新）→ codec 编码 →
  `{ok, json, columns, cells, entities}`。
- `async importProgress(jsonText)`：codec 解码 → `_discardEdits()` → 写 meta（seed/spawn）→
  逐 column `saveColumnEdits` → `saveEntities` → `location.reload()`；失败返回
  `{ok:false, reason}` 且不碰世界。
- 两者都不新增持久化路径、不持有世界数据副本（红线 1）。

**`src/ui/settings-panel.js`**
- 导出常量 `PLAYGROUND_ROW_TITLE = '创造台和进度管理'`、`PROGRESS_IMPORT_LABEL = '导入进度'`、
  `PROGRESS_EXPORT_LABEL = '导出进度'`（与 `PLAYGROUND_OPEN_LABEL` 同一手法：单一口径）。
- `_rowPlayground()` 改题 + 两行结构：`.mc-playground > (`.mc-btn-group.primary` 常驻组 +
  `.mc-btn-group.models` 模型组)。
- 主按钮 `#btn-playground` 由 `flex:1` 改 `flex:0 0 88px`（面板作用域内覆写），
  两个进度按钮各约 127px。
- 新增 `_onExportProgress()`（busy 期间 disabled；下载用既有 Blob/createObjectURL 手法，
  文件名 `mc-heavy-progress-<seed>-<时间戳>.json`）与 `_onImportProgress()`（file input →
  `file.text()` → `importProgress` → toast；**异步读取完成才释放锁**）。
- 复用 `_playgroundBusy` 锁（一个面板一套重活锁）；字段名
  `_playgroundBtn`/`_exportBtn`/`_importBtn` **保持不变**（既有 E2E 依赖）。

**测试**
- 新增 `src/tests/test-progress.js` + 注册进 `src/tests/index.html`：codec 往返（含
  blockEntity 深比较）、未知方块名 → invalid 且不写 air、越界/非整数 → invalid、非法 JSON /
  错误 format / 高 version → 对应 reason 且零输出、`decodeBlockIndex ∘ blockIndex` 全量往返。
- `src/tests/test-ui.js`：三条文案常量断言（与既有 `PLAYGROUND_OPEN_LABEL` 断言同处）。
- 新增 `tests/progress.spec.mjs`（E2E）：① 点「导出进度」→ 捕获 download → 断言 JSON 含刚放的
  方块与正确 seed（**含内存 edits 已 flush**）；② 用改过 seed 的包导入 → 导航监听先武装 →
  断言重载后方块在、seed 变了、`savedColumns>0`；③ 导入坏文件 → 不重载、世界不变；
  ④ 面板几何实测：两行按钮、主按钮宽度 < 100px、两个进度按钮各 > 100px、行标题文案、
  模型组仍只在激活时可见。
- 负向验证（注入后必须**真 FAIL**）：去掉导出前的 `flushNow`（导出缺一格）；codec 未知名字写
  id 0（单测）；导入不调 `_discardEdits`（旧改动残留）；进度按钮挪到左列（布局断言）；
  `decodeBlockIndex` 用错移位（往返断言）。

**文档同步**：`docs/phase-1-engine-design.md` 加 v1.43 修订说明 + §4.8 补「进度导入导出」段
（格式、覆盖语义、非原子性、不做项）+ 首行版本号与状态串；`docs/roadmap.md` 独立改动表加
v1.43 行、扩展点表「存档迁移」行注明与进度包的关系；`CLAUDE.md` 目录结构清单加新文件行。

## 验证方式

1. Tier 1 TDD：先写单测 → 确认 RED → 实现 → 确认 GREEN（`npm test -- tests/harness.spec.mjs`）。
2. `npm run check`（check:arch + check:data + lint；lint 能抓模板字面量解析错误 → 白屏类事故）。
3. `npx playwright test tests/progress.spec.mjs` + `tests/playground.spec.mjs` +
   `tests/clear-save.spec.mjs`。
4. 五条负向验证逐条实测并记录结果。
5. 不跑 bench（未触碰热路径）。最后跑一次全量 `npm test` 并如实报告 flaky 项。

## 已知取舍（用户批准计划即认可）

- 导入后玩家出生在城市中心，不是导出时站的位置。
- 导入会清空当前世界的方块改动（覆盖语义），无二次确认。
- 包是 mc-heavy 自有格式，读不了 mc-lite 的存档文件。
