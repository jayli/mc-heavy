# M9 创造台（playground）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 mc-lite 的创造台：54×54 平坦平台（玩家可在上面雕模型）+ 中心标记块锚点持久层 + 模型 JSON 导入导出 + 设置面板动作按钮与 toast 提示。

**Architecture:** 复用 M4~M7 底座 —— `WorldEditor.setBlocks()` 是唯一世界写入入口（平台生成与关闭都走它）；中心块的 `blockEntity` 是持久真相（M7 的方块锚定装置模式），经 `listBlockEntities('playground')` 扫库恢复与判上限。**不维护 mc-lite 的 `playgroundBlocks` 方块集合副本**（红线 1）—— 平台是规则矩形，坐标由 `origin + size` 确定性重算。平台方块登记 `indestructible` 并移出背包（复用 M8 交付的 `registry.indestructibleTable`）。

**Tech Stack:** ES2022 ESM、JSDoc、blockEntities、IndexedDB、浏览器内单测 + Playwright。

**Spec:** `docs/superpowers/specs/2026-09-11-m9-playground-design.md`（**计划从规格推论，执行者两份都要读**）

## Global Constraints

- **前置 = M8 已交付** `registry.indestructibleTable` 与 `registry.isIndestructible(id)`（本计划复用，不新建机制）。若 M8 未交付则本计划 Task 1 无法开工。
- **红线 1**：数据只有一份权威。禁止维护「平台有哪些方块」的第二份副本（mc-lite 的 `playgroundBlocks: Set` 不移植）；派生状态（`origin`/`size`）可确定性重算。
- **红线 2**：seed 确定性。创造台是玩家放置的装置（不参与世界生成），故无确定性生成要求；但锚点 id 须确定性派生（不用 `Math.random()`）。
- **时间基准一律 `performance.now()`**，禁止 `Date.now()`。
- **创造台写入是本 Epic 最大的单次编辑量（2916 格）** —— 须实测 REMESH 收敛期帧率，跌破门禁则改分帧提交并停下来报告。
- **`_hasOverlap` / `exportModel` 是主线程大体积扫描** —— 须按规格 §2.1 做增量优化并实测耗时。
- **先 RED 后 GREEN**；Tier 1 改动禁止跳步或省略失败验证。**每个提交都必须等用户明确授权。**
- 计划中标注「冻结」的断言数字实测不符时**停下来报告，不要擅自改断言或静默放宽**。

---

## 文件责任图

```text
Task 0（文档同步，无代码）
  docs/phase-1-engine-design.md    DR-17 回填 playground kind / §4.5.4 物品集合口径 / §9 扩展点
  docs/roadmap.md                  里程碑总表加 M9 行
  CLAUDE.md                        「背包物品集合口径 118 项」→ 116 项 + M9 活跃约束

Task 1（不可破坏两项 + 移出背包）
  src/voxel/blocks-data.js         playground_block / playground_center_block 加 indestructible
  src/player/inventory.js          HIDDEN_FROM_INVENTORY 加创造台两项
  tools/check-data.mjs             新增 [创造台] 环节
  assets/icons-atlas.png + icons.json  npm run icons 重烘焙
  src/tests/test-block-registry.js 表契约 + 移出背包断言

Task 2（创造台服务）
  src/entities/playground/playground-config.js / playground-service.js
  src/core/game.js                 playground 装配 + 测试 API
  tools/check-data.mjs             [创造台] 环节补平台尺寸/锚点契约
  src/tests/test-playground.js     选址 / 关闭判据 / 导入导出单测
  tests/playground.spec.mjs        生成 + reload 恢复 + 导入导出 E2E

Task 3（创造台 UI）
  src/ui/toast.js                  轻量非模态提示
  src/ui/settings-panel.js         创造台 / 导出 / 导入三个动作按钮（右列）
  src/tests/test-ui.js             文案单一口径 + toast 非模态

Task 4（验收）
  docs/m9-playground-acceptance-report.md  实测数据 + 偏离表 + 负向验证清单
  docs/roadmap.md                  回填 M9 commit hash
```

---

### Task 0: 设计文档与协作规范同步

**Files:**

- Modify: `docs/phase-1-engine-design.md`（DR-17 回填 `playground` kind / §4.5.4 物品集合口径 / §9 扩展点表）
- Modify: `docs/roadmap.md`（里程碑总表加 M9 行 + 后续扩展点表划掉创造台行）
- Modify: `CLAUDE.md`（「背包物品集合口径 118 项」→ 116 项 + M9 活跃约束）

**Interfaces:**

- Consumes: M9 规格 §1~§4（本 Epic 的新机制 = `playground` blockEntity kind + 物品集合口径变更）
- Produces: 后续任务引用设计文档时的章节号（实施中若发现章节号不符，按实际章节走并在验收报告记录）

本任务是 CLAUDE.md 规则「需要新增机制/改动设计时，先更新设计文档再动代码」的落实，**无代码改动**，故不走 TDD。

- [ ] **Step 1: 在 DR-17 的 blockEntity 通道段回填 `playground` kind**

DR-17 原文已写「后续炮塔/床/宝箱等同类装置可直接复用此通道」。M8 已回填 `turret`，M9 追加 `playground`：

```markdown
> **第三批消费者由 M9 落地**：`playground`（创造台中心块 `{kind:'playground', id, origin:[x,y,z], size}`）。
> 三个 kind（zombie-nest / turret / playground）共用同一 edits 通道与
> `Persistence.listBlockEntities(kind)` cursor 扫库判上限，未引发 schemaVersion 变更 ——
> DR-17 当初预留的形状经三批消费者验证够用。
```

⚠️ **实体运行时不在编号子系统里**（设计文档 §4.6 是光照与 AO；M5 的 `EntityManager` 只出现在 §9 扩展点表与 DR 记录中），落点须查实际章节，勿照本表硬写。

- [ ] **Step 2: 更新 §4.5.4 物品集合口径**

物品集合从 118 变为 116（创造台两项加进 `HIDDEN_FROM_INVENTORY`）。⚠️ **门禁打印的「排除 N」是两个排除集合之和**（`NON_PLACEABLE_ITEMS.length + HIDDEN_FROM_INVENTORY.length`）：当前 `排除 8` → 改后 `排除 10`（`HIDDEN_FROM_INVENTORY` 自身 4→6）。

说明本仓库物品集合是**派生集合**（registry − 排除集合），而 mc-lite 是手工列举（`Game.js:206-321` 实测 107 行匹配、2 行被注释 → **有效 105 项**，不含 playground）—— 这是派生口径与上游手工列举的差异，须在修订说明里记一句。

- [ ] **Step 3: 划掉 §9 扩展点表的创造台行**

`| 创造台 | mesher 顶点模板机制 |` 改为「✅ M9 已交付」，并订正接入点表述：本计划走 `editor.setBlocks` 的**真实方块路径**（平台是可挖可放的真实方块，不是 mesher 顶点模板）。

- [ ] **Step 4: bump 设计文档版本号 + 写修订说明**

⚠️ 本 Epic 属**架构口径变更**（新数据通道消费者 + 物品集合口径），须进修订说明并 bump 版本号（**目标版本号 = v1.40**（现 v1.35；roadmap 的独立改动表已占用 v1.36/v1.37/v1.38，故 M8 取 v1.39、M9 取 v1.40 —— 避免撞号））。

- [ ] **Step 5: 同步 roadmap 与 CLAUDE.md**

roadmap 里程碑总表加 M9 行（状态「📝 待实施」/ 关键 commit 留空待回填）；后续扩展点表划掉创造台行。

⚠️ **CLAUDE.md 有一条硬编码数字的活跃约束须改写**：「背包物品集合口径 **118 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项）− `HIDDEN_FROM_INVENTORY`（4 项）」。Task 1 把创造台两项加进 `HIDDEN_FROM_INVENTORY` 后变为 **116 项**。⚠️ 改写时须同时更新两个数字：物品集合 `118 → 116`、`HIDDEN_FROM_INVENTORY` 项数 `4 → 6`。**不要只写「排除集合 4→6」** —— 门禁实际打印的是**两个集合之和**（`排除 8 → 排除 10`），与「4→6」不是一个口径（上一轮 B1 的同一个坑）。该条须同步改写，否则后续实现者按过期口径判断集合大小。

⚠️ **审查中9：CLAUDE.md 的「118」共有三处，本步骤必须全部改写**（只改一处会留下两个
静默过期的副本 —— 正是 CLAUDE.md 自己警告的「同一事实多个副本会漂移」）：

| 行 | 内容 | 改为 |
|---|---|---|
| `:69` | 「背包物品集合口径 **118 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项）− `HIDDEN_FROM_INVENTORY`（4 项）」 | 物品集合 118→116、`HIDDEN_FROM_INVENTORY` 4→6（门禁打印「排除 8→10」） |
| `:221` | 「`zombie_nest_alias_block` 在背包集合 **118 项**内」 | 118→116 |
| `:380` | 目录树注释「全量背包图标离线烘焙（npm run icons）：**118 项**×两套尺寸」 | 118→116 |

⚠️ 改完后用 `rg -n "118" CLAUDE.md` 复核 —— 应无残留（除非有别处合法引用）。

⚠️ **CLAUDE.md 的「文档同步」规则还要求同步「目录结构清单 + 开发命令清单 + 现状声明」三类文档**（本任务不可漏 —— 漏了即违反 CLAUDE.md 硬规则）。M9 新增的产物须进对应清单：

- **目录结构清单**（设计文档 §5）：`src/entities/playground/`（config / service）、`src/ui/toast.js`、`tests/playground.spec.mjs`；
- **开发命令清单**：M9 无新增 npm 命令（创造台不涉及烘焙）；
- **现状声明**：CLAUDE.md 的「一句话现状」须加上 M9（创造台已交付），roadmap 的里程碑总表 M9 行状态改「✅ 完成」+ 回填 commit hash（Task 4 做）。

⚠️ **`docs/m9-playground-acceptance-report.md`** 由 Task 4 产出，也须进目录结构清单。

同时新增一条 M9 活跃约束（放在 M8 段之后）：

```markdown
### M9 创造台沉淀的活跃约束（后续同类装置 Epic 必读）

- **创造台不维护「平台有哪些方块」的副本**（红线 1）：mc-lite 的 `playgroundBlocks: Set<'x,y,z'>`
  （2916 个字符串键）不移植。平台是规则 54×54 矩形，坐标由 `origin + size` 确定性重算 →
  关闭时枚举即可，不需要记录。
- **创造台方块登记 indestructible 且移出背包，两者必须成对**：只登记不移出会产出
  「玩家放得出来但挖不掉、TNT 也炸不掉」的撕裂状态（M8 拆分时实测分析过）。
- **`_hasOverlap` / `exportModel` 是主线程大体积扫描**：须做增量优化（逐层扫描 + 只扫实际模型
  高度区间）并实测耗时，不要每层重扫全 11 层净空。
```

- [ ] **Step 6: 提交（仅获授权后执行）**

```bash
git add docs/phase-1-engine-design.md docs/roadmap.md CLAUDE.md
git commit -m "docs(m9): 设计文档同步——playground kind / 物品集合口径 / DR-17 回填"
```

---

### Task 1: 创造台方块登记 indestructible + 移出背包

**Files:**

- Modify: `src/voxel/blocks-data.js`（两条加 `indestructible: true`）
- Modify: `src/player/inventory.js`（`HIDDEN_FROM_INVENTORY` 加两项）
- Modify: `tools/check-data.mjs`（新增 `[创造台]` 环节）
- Modify: `src/tests/test-block-registry.js`（表契约 + 移出背包断言）
- Modify: `src/tests/test-weapons.js`（⚠️ **翻转回改 M8 改过的三条 playground 断言**，见 Step 3）
- Modify: `src/tests/test-inventory.js`（⚠️ **4 处冻结断言会因物品集合 118→116 而 FAIL**，见 Step 3 的高5 说明）
- Modify: `assets/icons-atlas.png`, `assets/icons.json`（`npm run icons` 产物）

**Interfaces:**

- Consumes: M8 交付的 `registry.isIndestructible(id)`（复用，不新建）；既有 `buildItemNames(registry)`
- Produces: 创造台两项在 registry 内标记为 indestructible；物品集合从 118 → 116

⚠️ **前置依赖**：本任务复用 M8 交付的 `indestructibleTable`。若 M8 未交付，须先完成 M8 Task 1。

- [ ] **Step 1: 写失败的表契约与移出背包测试**

在 `src/tests/test-block-registry.js` 追加（`makeRegistry()` 照该文件既有 helper）：

```js
test('创造台两项登记 indestructible 且移出背包（成对）', () => {
  const registry = makeRegistry();
  // ① 登记 indestructible（复用 M8 的表）
  assertTrue(registry.isIndestructible(registry.idOf('playground_block')));
  assertTrue(registry.isIndestructible(registry.idOf('playground_center_block')));
  // ② 移出背包物品集合（派生集合自动跟随排除集合）
  const items = buildItemNames(registry);
  assertEqual(items.includes('playground_block'), false);
  assertEqual(items.includes('playground_center_block'), false);
  // ③ **临界值附近断言**：其他方块不受影响
  assertEqual(items.includes('tnt'), true);
  assertEqual(items.includes('turret_alias_block'), true);
});
```

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 两项未登记 indestructible、仍在物品集合内。

- [ ] **Step 3: 实现**

`src/voxel/blocks-data.js` —— 给两条加字段（其余不动）：

```js
{"name":"playground_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true},
{"name":"playground_center_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true},
```

`src/player/inventory.js` —— `HIDDEN_FROM_INVENTORY` 加两项（**不是** `NON_PLACEABLE_ITEMS`：它们本质能放能挖，只是不该出现在物品集合里，与 `chimney`/床三项同一语义）：

```js
export const HIDDEN_FROM_INVENTORY = [
  'chimney', 'bed_head', 'bed_tail', 'bed_alias_block',
  // M9：创造台平台方块。**既有偏差修正** —— 本仓物品集合是派生的（registry − 排除集合），
  // 而 mc-lite 是手工列举（`Game.js:206-321` 实测 107 行匹配、2 行被注释 → 有效 105 项，
  // **不含**这两项）。配上 indestructible 门控后，若留在背包
  // 会产出撕裂状态：玩家放得出来，但挖不掉、TNT 也炸不掉（只能靠关闭创造台批量删）。
  'playground_block', 'playground_center_block',
];
```

⚠️ **两项登记 indestructible 与移出背包必须同时做**（见 Step 1 断言）—— 只做一半会产出撕裂状态。

⚠️ **A8：翻转回改 M8 改过的既有断言**（跨 Epic 必改项，不做则本任务 GREEN 跑不过）。
M8 Task 1 因 playground 两项不在表里，把 `src/tests/test-weapons.js:90/91/97` 的三条断言
改成了 `assertTrue`。M9 登记两项后它们恢复不可破坏 → **改回 `assertFalse`**：

```js
test('weapon policy: bedrock/end_stone/创造台不可破坏，水与 end_stone_bricks 可破坏', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  assertFalse(isWeaponDestructible(ids.bedrock, registry));
  assertFalse(isWeaponDestructible(ids.endStone, registry));
  // M9 登记两项 → 恢复不可破坏（M8 期间曾是 assertTrue，见 M8 计划 Task 1 的 A8 说明）
  assertFalse(isWeaponDestructible(ids.playground, registry));
  assertFalse(isWeaponDestructible(registry.idOf('playground_center_block'), registry));
  assertFalse(isMag7Candidate(ids.playground, registry));
  // ...（其余断言不变）
});
```

同时把 `src/tests/test-block-registry.js` 里 M8 钉的
`assertEqual(registry.isIndestructible(idOf('playground_block')), false)` 改为 `assertTrue(...)`。

⚠️ **审查高5：`src/tests/test-inventory.js` 有 4 处冻结断言会因物品集合 118→116 而 FAIL**
（本任务把两项移出背包后，物品集合从 118 变 116）。这四处必须同步改写，否则本任务的 GREEN
跑不过：

| 行 | 既有断言 | 改为 |
|---|---|---|
| `:166` | `assertDeepEqual(HIDDEN_FROM_INVENTORY, ['chimney','bed_head','bed_tail','bed_alias_block'])` | 加上 `'playground_block','playground_center_block'` 两项 |
| `:175` | `assertEqual(names.length, 118, '126 - 4 - 4 = 118')` | `assertEqual(names.length, 116, '126 - 4 - 6 = 116')` |
| `:200` | `assertEqual(rest.length, 113, '118 - 5')` | `assertEqual(rest.length, 111, '116 - 5')` |
| `:225` | `assertEqual(filled.length, 118, '物品集合全量入包')` | `assertEqual(filled.length, 116, ...)`（并核对「首个空槽 = 下标 116」的注释） |

⚠️ **`:200` 那条还要核对注释里的算式**（`'118 - 5'` → `'116 - 5'`）。⚠️ 这些是 CLAUDE.md
说的「硬编码计数的冻结断言」—— 改数字须连注释一起改，否则注释与断言漂移。

- [ ] **Step 4: 验证 GREEN + 重烘焙图标**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 两条断言全绿。

物品集合从 118 变为 116 → 图标指纹少两项，须重烘焙：

Run: `npm run icons && npm run check`
Expected: `[物品集合] 116 项 = registry 126 − 排除 10`；图标指纹匹配。

⚠️ **文档里不得硬编码 118/116**（计数以 `npm run check:data` 输出为准）。

- [ ] **Step 5: 在 `tools/check-data.mjs` 新增 `[创造台]` 环节**

```js
/**
 * [创造台] 契约：两个方块名在 registry 内 + 都标了 indestructible + 都不在背包物品集合内。
 * 漏了会让「平台方块不可破坏」门控静默失效，或产出「放得出来但挖不掉」的撕裂状态。
 */
function checkPlaygroundContract() {
  const names = ['playground_block', 'playground_center_block'];
  const allNames = new Set(REGISTRY.all().map((e) => e.name));
  const items = buildItemNames(REGISTRY);
  for (const n of names) {
    if (!allNames.has(n)) failures.push(`[创造台] "${n}" 不在 registry 内（平台方块名拼错）`);
    if (!REGISTRY.isIndestructible(REGISTRY.idOf(n))) {
      failures.push(`[创造台] "${n}" 未标 indestructible（玩家/TNT 能破坏平台本体）`);
    }
    if (items.includes(n)) {
      failures.push(`[创造台] "${n}" 在背包物品集合内（玩家能放置不可破坏的平台方块 → 撕裂状态）`);
    }
  }
  infos.push(`[创造台] 平台方块 ${names.length} 项已登记 indestructible 并移出背包`);
}
```

⚠️ **负向验证**：① 注入「移除 `HIDDEN_FROM_INVENTORY` 里的两项」→ 该环节须真 FAIL；② 注入「移除 `indestructible` 字段」→ 须真 FAIL。两条配对断言缺一不可（只测一半会漏掉撕裂状态）。

⚠️ **审查 B3：必须在主流程加调用行，否则门禁永不执行**。`check-data.mjs` 的主流程
（`:392-400`）是**逐个显式调用**（`checkItemSetRelation();` 等），不是自动发现 ——
定义了函数但没加调用行，门禁就永远不跑。在主流程 `checkGeometryAuthority();` 之后加一行：

```js
checkPlaygroundContract();   // M9：创造台方块契约（唯一一次定义在 Task 1，Task 2 只扩展函数体）
```

⚠️ **本环节是 `[创造台]` 门禁的唯一函数定义**（Task 2 不再新建同名函数 —— 同名重复定义会让
后一个覆盖前一个，审查 B3）。Task 2 只在该函数体内**追加**平台尺寸契约。

- [ ] **Step 6: 提交（仅获授权后执行）**

```bash
git add src/voxel/blocks-data.js src/player/inventory.js tools/check-data.mjs \
  src/tests/test-block-registry.js assets/icons-atlas.png assets/icons.json
git commit -m "feat(playground): 创造台方块登记 indestructible + 移出背包"
```

---

### Task 2: 创造台服务（平台生成 / 关闭 / 锚点持久层 / 导入导出）

**Files:**

- Create: `src/entities/playground/playground-config.js`,
  `src/entities/playground/playground-service.js`, `src/tests/test-playground.js`,
  `tests/playground.spec.mjs`
- Modify: `src/core/game.js`（装配 + 测试 API）
- Modify: `tools/check-data.mjs`（新增 `[创造台]` 环节）
- Modify: `src/tests/index.html`（注册新单测文件）

**Interfaces:**

- Consumes: Task 1 的 `registry.isIndestructible(id)`（平台方块不可破坏）；
  既有 `editor.setBlocks(changes)` / `editor.setBlockEntity({x,y,z,value})` /
  `persistence.listBlockEntities('playground')` / `world.getBlockId(x,y,z)` / `world.hasColumn(cx,cz)`
- Produces（Task 3 依赖，签名必须一致）:

```js
// playground-config.js
export const PLAYGROUND = Object.freeze({
  size: 54, clearance: 10, distance: 10, heightSpan: 20,
});
export const PLAYGROUND_KIND = 'playground';

// playground-service.js
playground.create(playerPos);   // {ok:true, origin:[x,y,z]} | {ok:false, reason:'exists'|'no-safe-location'|'not-loaded'}
playground.close(playerPos);    // {ok:true} | {ok:false, reason:'not-active'|'player-in-playground'}
playground.isActive();          // boolean
playground.origin();            // [x,y,z] | null
playground.hydrate(persistence);// Promise<void>
playground.exportModel();       // {ok:true, json:string, blocks:number} | {ok:false, reason:'not-active'}
playground.importModel(jsonText);   // **同步**返回 {ok:true, placed, skipped, invalid} | {ok:false, reason}
playground.isPlayerInPlayground(playerPos);  // boolean

// game.js
game.createPlayground();        // 测试 API
game.closePlayground();         // 测试 API
game.playgroundDebugState();    // { active, origin }；只读测试钩子
```

- [ ] **Step 1: 写失败的选址与关闭判据测试**

新建 `src/tests/test-playground.js`，并在 `src/tests/index.html` 追加
`import './test-playground.js';`：

```js
test('创造台：54×54 平台 + 中心标记块，一次事务写入', () => {
  const { playground, editor } = makePlaygroundFixture();
  const r = playground.create({ x: 10, y: 4, z: 10 });   // ⚠️ 入参是 {x,y,z}，不是数组（审查 B8）
  assertTrue(r.ok);
  assertEqual(editor.setBlocksCalls.length, 1);          // **一次**事务
  const changes = editor.setBlocksCalls[0];
  assertEqual(changes.length, 54 * 54);                   // 2916 格
  const centerId = playground.registry.idOf('playground_center_block');
  assertEqual(changes.filter((c) => c.id === centerId).length, 1);   // 恰一个中心块
  // 中心块带锚点 blockEntity
  const withEntity = changes.filter((c) => c.blockEntity);
  assertEqual(withEntity.length, 1);
  assertEqual(withEntity[0].blockEntity.kind, 'playground');
  assertEqual(withEntity[0].blockEntity.size, 54);
});

test('创造台：东侧 column 未加载时**继续尝试西侧**（不是立即放弃）', () => {
  // ⚠️ **断言必须能区分「试过西侧」与「第一个候选就 return」**（审查 B1 的无效盲区）：
  // 两侧都未加载时 reason 都是 not-loaded，区分不出 bug。故构造**东侧未加载、西侧已加载且有净空**
  // 的场景 —— 正确实现应经西侧成功创建；若 bug 存在（东侧 return）则报 not-loaded、零写入。
  const px = 10, py = 4, pz = 10;
  const westX = px - PLAYGROUND.distance;   // 西侧 = 0
  // fixture：东侧 column（cx=1）未加载，西侧 column（cx=0）已加载且平台区净空
  const { playground, world } = makePlaygroundFixture({
    loadedColumns: [[0, 0]],   // 只有西侧所在 column 加载
    clearArea: { x: westX, z: pz - PLAYGROUND.size / 2, y: py },   // 西侧区域全空
  });
  const r = playground.create({ x: px, y: py, z: pz });   // ⚠️ 入参是 {x,y,z}，不是数组（审查 B8）
  assertTrue(r.ok, '东侧未加载时须经西侧成功创建（若 return 而非 continue 则此处 FAIL）');
  // 平台落在西侧（origin.x === westX），证明西侧确实被尝试过
  assertEqual(r.origin[0], westX);
});

test('创造台：所有候选 column 都未加载 → not-loaded 且零写入', () => {
  const { playground, world } = makePlaygroundFixture({ loadedColumns: [] });
  const r = playground.create({ x: 10, y: 4, z: 10 });
  assertEqual(r.reason, 'not-loaded');
  assertEqual(world.getBlockId(20, 4, 10), 0);           // 零写入
});

test('创造台：玩家在平台区域内拒绝关闭', () => {
  const { playground } = makePlaygroundFixture();
  playground.create({ x: 10, y: 4, z: 10 })   // ⚠️ 入参是 {x,y,z}，不是数组（审查 B8）;
  const origin = playground.origin();
  // 玩家在平台内（XZ 在范围内 + Y 在 [origin.y, origin.y+20)）
  const inside = { x: origin[0] + 5, y: origin[1] + 1, z: origin[2] + 5 };
  assertEqual(playground.close(inside).reason, 'player-in-playground');
  // 平台外 → 关闭成功
  const outside = { x: origin[0] - 20, y: origin[1] + 1, z: origin[2] };
  assertTrue(playground.close(outside).ok);
  assertEqual(playground.isActive(), false);
});

test('创造台：平台方块不可破坏（indestructible 门控生效）', () => {
  const registry = makeRegistry();
  assertTrue(registry.isIndestructible(registry.idOf('playground_block')));
  assertTrue(registry.isIndestructible(registry.idOf('playground_center_block')));
});

test('创造台：导出 JSON 格式与 assets/structures/*.json 一致', () => {
  const { playground, world } = makePlaygroundFixture();
  playground.create({ x: 10, y: 4, z: 10 })   // ⚠️ 入参是 {x,y,z}，不是数组（审查 B8）;
  const origin = playground.origin();
  // 在平台上雕一个模型（放两格 stone 在平台上方的中心附近）
  const cx = origin[0] + 27, cz = origin[2] + 27;
  world.setBlock(cx, origin[1] + 1, cz, playground.registry.idOf('stone'));
  world.setBlock(cx + 1, origin[1] + 1, cz, playground.registry.idOf('stone'));
  const r = playground.exportModel();
  assertTrue(r.ok);
  const data = JSON.parse(r.json);
  assertTrue(Array.isArray(data.blocks));                // 与 structures JSON 同形状
  assertEqual(data.blocks.length, 2);
  assertTrue(data.blocks[0].type === 'stone');
  assertTrue(Number.isFinite(data.blocks[0].x));         // 相对坐标
  assertTrue(Number.isFinite(data.blocks[0].direction));
  assertTrue(data.metadata && data.metadata.dimensions);
  // ⚠️ **钉住 dimensions 的键名形状**（审查高6）：只查真值抓不到 `{x,y,z}` vs `{width,height,depth}`
  // 的漂移 —— 必须逐键断言，与 assets/structures/*.json 的实际口径一致。
  const dims = data.metadata.dimensions;
  assertTrue(Number.isFinite(dims.width) && Number.isFinite(dims.height) && Number.isFinite(dims.depth),
    'dimensions 必须是 {width,height,depth}（实测结构 JSON 口径），不是 {x,y,z}');
  assertEqual(dims.x, undefined, '不得有 x 键（旧形状）');
});

test('创造台：导入时未知方块名计 invalid 且**不写 air**', () => {
  const { playground, world } = makePlaygroundFixture();
  playground.create({ x: 10, y: 4, z: 10 })   // ⚠️ 入参是 {x,y,z}，不是数组（审查 B8）;
  const origin = playground.origin();
  const cx = origin[0] + 27, cz = origin[2] + 27;
  // 先在目标位置放一格 stone（若导入误写 air 会把它删掉）
  world.setBlock(cx, origin[1] + 1, cz, playground.registry.idOf('stone'));
  const r = playground.importModel(JSON.stringify({ blocks: [   // **同步**返回（规格 §2.4）
    { x: 0, y: 1, z: 0, type: 'no_such_block', direction: 0 },   // 未知方块名
  ] }));
  assertTrue(r.ok);
  assertEqual(r.invalid, 1);
  assertEqual(r.placed, 0);
  assertEqual(world.getBlockId(cx, origin[1] + 1, cz), playground.registry.idOf('stone')); // 未被删
});
```

⚠️ **`makePlaygroundFixture()` 须支持注入「已加载 column 集合」** —— 选址的未加载判据
是本任务的关键分支（见 Step 3 的理由），桩件 world 若一律返回「已加载」会测不到它。

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `PlaygroundService` 未定义。

- [ ] **Step 3: 实现 config 与 service**

`src/entities/playground/playground-config.js`：

```js
// src/entities/playground/playground-config.js — M9：创造台冻结数据（规格 §2）
// 同构层：**无 DOM、无 three**。数值逐项实测自 mc-lite `PlaygroundService.js`。
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';

export const PLAYGROUND = Object.freeze({
  /** 平台边长 54 格（mc-lite `playgroundSize = 54`，2916 格） */
  size: 54,
  /** 平台上方净空 10 格（mc-lite `requiredClearance = 10`） */
  clearance: 10,
  /** 距玩家 10 格（mc-lite `distance = 10`，东侧优先、失败改西侧） */
  distance: 10,
  /** 玩家在平台内的 Y 跨度 20 格（mc-lite `isPlayerInPlayground` 的 `maxY = origin.y + 20`） */
  heightSpan: 20,
  /**
   * ⚠️ **安全高度搜索上界 = 本仓库的 `WORLD_MAX_Y`（96），不是 mc-lite 的 200**。
   * mc-lite 世界高度 0~255；本仓库 `-32~96`。照搬 200 会让搜索恒超出世界顶 →
   * 永不返回安全高度（平台永远创建不出来）。
   */
  maxSearchY: WORLD_MAX_Y,
  minSearchY: WORLD_MIN_Y,
});

/** blockEntity 的 kind（与 zombie-nest / turret 并列，共用 edits 通道 —— DR-17） */
export const PLAYGROUND_KIND = 'playground';
/** 平台方块名（中心标记块 + 其余平台格） */
export const PLAYGROUND_BLOCK = 'playground_block';
export const PLAYGROUND_CENTER_BLOCK = 'playground_center_block';
```

`src/entities/playground/playground-service.js`：

```js
// src/entities/playground/playground-service.js — M9 创造台服务（规格 §2）
// 同构层：不得 import three。
//
// **不维护 mc-lite 的 `playgroundBlocks: Set<'x,y,z'>` 副本**（红线 1：那是「平台有哪些方块」
// 的第二份权威，2916 个字符串键）。平台是规则的 54×54 矩形，坐标可纯计算得出 →
// 关闭时由 `origin + size` 确定性重算枚举。
//
// **重启恢复走锚点而非遍历已加载 chunk**（mc-lite `detectExistingPlayground` 遍历
// `world.chunks` → 远处未加载就扫不到）。本仓库走 M7 的 blockEntity 锚点模式：
// 中心块的 `{kind:'playground', id, origin, size}` 随 edits 落盘，经
// `listBlockEntities('playground')` cursor 扫库恢复。全局最多 1 个（mc-lite 单例语义），
// 上限判定同样走扫库而非已加载状态。
import { PLAYGROUND, PLAYGROUND_KIND, PLAYGROUND_BLOCK, PLAYGROUND_CENTER_BLOCK }
  from './playground-config.js';

export class PlaygroundService {
  /**
   * @param {{world, editor, registry}} deps
   */
  constructor({ world, editor, registry }) {
    this.world = world; this.editor = editor; this.registry = registry;
    /** 派生状态：`{origin:[x,y,z], size:number} | null`。**不是**方块集合副本 */
    this._state = null;
  }

  isActive() { return this._state !== null; }
  origin() { return this._state ? [...this._state.origin] : null; }

  /**
   * 创建平台。选址顺序照搬 mc-lite：东侧 10 格 → 西侧 → 玩家 Y−20 → 玩家 Y−5。
   *
   * ⚠️ **未加载 column 必须视为重叠**：mc-lite 遍历 `world.chunks` 查已加载块；本仓库
   * `WorldData.getBlockId` 对未加载 column 返回 0（air）→ 会把未加载区域判为「安全」，
   * 然后在写入时因 column 缺失被 setBlocks 跳过 → 产出半个平台。故选址前先确认候选区域的
   * column 已加载（照 M7 `place()` 的 `hasColumn` 预检）。
   * 实测：平台距玩家 10~64 格，视距 8 的加载半径 128 格 → 通常已加载；但视距 2
   * （M1 测试口径）时部分未加载，这条判据是必需的。
   *
   * @param {{x:number, y:number, z:number}} playerPos
   * @returns {{ok:true, origin:[number,number,number]} |
   *           {ok:false, reason:'exists'|'no-safe-location'|'not-loaded'}}
   */
  create(playerPos) {
    if (this._state) return { ok: false, reason: 'exists' };   // 全局最多 1 个
    const px = Math.floor(playerPos.x), py = Math.floor(playerPos.y), pz = Math.floor(playerPos.z);
    const half = PLAYGROUND.size / 2;
    // 候选序列（mc-lite 同序）：东侧 → 西侧 → 东侧(玩家 Y−20) → 东侧(玩家 Y−5)
    const candidates = [
      { x: px + PLAYGROUND.distance, z: pz - half, startY: null },        // startY=null → 从地面高度起搜
      { x: px - PLAYGROUND.distance, z: pz - half, startY: null },
      { x: px + PLAYGROUND.distance, z: pz - half, startY: py - 20 },
      { x: px + PLAYGROUND.distance, z: pz - half, startY: py - 5 },
    ];
    /** 是否曾有候选因 column 未加载被跳过（决定最终 reason，见循环后的 ⚠️） */
    let sawNotLoaded = false;
    for (const c of candidates) {
      // ① column 已加载预检（整片平台覆盖的 column 都须已加载）
      // ⚠️ **未加载 → `continue`（试下一个候选），不是 `return`**：东侧未加载时仍要
      // 试西侧 / Y−20 / Y−5（规格 §2.1 的选址顺序）。用 `return` 会在第一个候选就放弃，
      // 西侧永远不会被尝试（审查 B1）。记录是否发生过未加载，供最终 reason 判定。
      if (!this._allColumnsLoaded(c.x, c.z)) { sawNotLoaded = true; continue; }
      // ② 从地面高度（或给定 startY）向上搜安全高度
      const startY = c.startY ?? this._findGroundLevelFromBelow(c.x, py, c.z);
      const y = this._findSafeHeight(c.x, startY, c.z);
      if (y === null) continue;   // 这个候选找不到 → 试下一个（mc-lite 同口径）
      return this._write(c.x, y, c.z);
    }
    // 全部候选失败：若曾因 column 未加载跳过 → 报 not-loaded（更准确的原因），
    // 否则报 no-safe-location（column 都加载了但找不到净空高度）
    return { ok: false, reason: sawNotLoaded ? 'not-loaded' : 'no-safe-location' };
  }

  /** 整片平台覆盖的 column 是否都已加载（未加载 → 选址判为重叠，见 create() 注释） */
  _allColumnsLoaded(originX, originZ) {
    const size = PLAYGROUND.size;
    const cx0 = Math.floor(originX / 16), cx1 = Math.floor((originX + size - 1) / 16);
    const cz0 = Math.floor(originZ / 16), cz1 = Math.floor((originZ + size - 1) / 16);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (!this.world.hasColumn(cx, cz)) return false;
      }
    }
    return true;
  }

  /** 从给定高度向上扫第一个非空气方块（mc-lite `findGroundLevelFromBelow` 同语义） */
  _findGroundLevelFromBelow(x, startY, z) {
    for (let y = Math.floor(startY); y < PLAYGROUND.maxSearchY; y++) {
      if (this.world.getBlockId(x, y, z) !== 0) return y + 1;
    }
    return null;
  }

  /** 向上搜第一个「平台层 + 净空区域全为空」的高度（mc-lite `findSafePlaygroundHeight`） */
  _findSafeHeight(originX, startY, originZ) {
    if (startY === null) return null;
    for (let y = startY; y <= PLAYGROUND.maxSearchY; y++) {
      if (!this._hasOverlap(originX, y, originZ)) return y;
    }
    return null;
  }

  /** 平台层与上方净空区域是否有非空气方块（mc-lite `hasOverlapWithWorld` 同语义） */
  _hasOverlap(originX, y, originZ) {
    const size = PLAYGROUND.size;
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        // 平台层 + 净空 10 格
        for (let dy = 0; dy <= PLAYGROUND.clearance; dy++) {
          const yy = y + dy;
          if (yy >= PLAYGROUND.maxSearchY) return true;   // 超出世界顶视为重叠
          if (this.world.getBlockId(originX + dx, yy, originZ + dz) !== 0) return true;
        }
      }
    }
    return false;
  }

  /** 一次事务写入 2916 格 + 中心块锚点 */
  _write(originX, y, originZ) {
    const size = PLAYGROUND.size;
    const centerDx = Math.floor(size / 2), centerDz = Math.floor(size / 2);
    const blockId = this.registry.idOf(PLAYGROUND_BLOCK);
    const centerId = this.registry.idOf(PLAYGROUND_CENTER_BLOCK);
    const id = `playground-1`;   // 全局最多 1 个 → 固定 id（hydrate 后同口径，不会冲突）
    const changes = [];
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        const x = originX + dx, z = originZ + dz;
        const isCenter = dx === centerDx && dz === centerDz;
        const change = { x, y, z, id: isCenter ? centerId : blockId, meta: 0 };
        if (isCenter) {
          change.blockEntity = {
            kind: PLAYGROUND_KIND, id, origin: [originX, y, originZ], size,
          };
        }
        changes.push(change);
      }
    }
    const report = this.editor.setBlocks(changes);
    // ⚠️ **审查高7：回滚判据不能只看 `skipped.length > 0`** —— `world-data.js:185` 把
    // **no-change 也推进 skipped**（某格已是目标值时）。2916 格里只要有一格已是
    // `playground_block` 就会触发整批回滚，且误报成 'not-loaded'。
    // 真正的失败只有三种：`column-missing` / `out-of-bounds` / `bedrock`（硬失败）。
    // no-change 是**正常**的（幂等放置），不算失败。
    const hardSkipped = report.skipped.filter((sk) =>
      sk.reason === 'column-missing' || sk.reason === 'out-of-bounds' || sk.reason === 'bedrock');
    if (hardSkipped.length > 0) {
      // 部分写入（硬失败）→ 回滚，绝不留下半个平台
      this.editor.setBlocks(changes.map((c) => ({ x: c.x, y: c.y, z: c.z, id: 0 })));
      // reason 按实际硬失败原因返回（不再一律 'not-loaded'）
      const reason = hardSkipped[0].reason === 'column-missing' ? 'not-loaded' : 'no-safe-location';
      return { ok: false, reason };
    }
    this._state = { origin: [originX, y, originZ], size };
    return { ok: true, origin: [originX, y, originZ] };
  }

  /**
   * 玩家在平台区域内（mc-lite `isPlayerInPlayground`）：XZ 在范围内 +
   * Y 在 `[origin.y, origin.y + heightSpan)`。
   * @param {{x:number,y:number,z:number}} playerPos @returns {boolean}
   */
  isPlayerInPlayground(playerPos) {
    if (!this._state) return false;
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    return playerPos.x >= ox && playerPos.x < ox + size &&
           playerPos.z >= oz && playerPos.z < oz + size &&
           playerPos.y >= oy && playerPos.y < oy + PLAYGROUND.heightSpan;
  }

  /**
   * 关闭平台。玩家在区域内则拒绝（防止把玩家脚下的地面抽掉）。
   * ⚠️ **只删平台层方块，不删玩家雕的模型**（mc-lite 同口径：`playgroundBlocks` 只含平台格）。
   * 坐标由 `origin + size` **确定性重算**（不维护方块集合副本 —— 红线 1）。
   * @param {{x:number,y:number,z:number}} playerPos
   */
  close(playerPos) {
    if (!this._state) return { ok: false, reason: 'not-active' };
    if (playerPos && this.isPlayerInPlayground(playerPos)) {
      return { ok: false, reason: 'player-in-playground' };
    }
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    const changes = [];
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) changes.push({ x: ox + dx, y: oy, z: oz + dz, id: 0 });
    }
    this.editor.setBlocks(changes);   // 一次事务（中心块的 blockEntity 随方块改写自动清除）
    this._state = null;
    return { ok: true };
  }

  /**
   * 从存档恢复（走锚点，不遍历已加载 chunk）。
   * ⚠️ **审查低12：启动期 hydrate 前不需要 flushNow** —— M7 的 `nests.hydrate`
   * （`game.js:266`）就没有这个前置（`listBlockEntities` 走 cursor 扫库，不依赖预热）。
   * `flushNow` 是**测试侧 reload 前**才调用的（把内存 edits 落库，reload 后 hydrate 才读得到）。
   * 照写「启动期 hydrate 前 flushNow」会加一段无意义的启动期 flush。
   */
  async hydrate(persistence) {
    const anchors = await persistence.listBlockEntities(PLAYGROUND_KIND);
    this._state = null;
    for (const { blockEntity } of anchors) {
      if (!blockEntity?.origin) continue;
      this._state = { origin: [...blockEntity.origin], size: blockEntity.size ?? PLAYGROUND.size };
      break;   // 全局最多 1 个
    }
  }

  /**
   * 导出模型：枚举平台上方（`origin.y+1` 起至世界顶）的非平台方块 → 相对中心坐标。
   * 输出格式**与 `assets/structures/*.json` 完全一致**（mc-lite 同口径 → 导出的模型可直接
   * 当结构 JSON 用）。
   * @returns {{ok:true, json:string, blocks:number} | {ok:false, reason:'not-active'}}
   */
  exportModel() {
    if (!this._state) return { ok: false, reason: 'not-active' };
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    const cx = ox + size / 2, cz = oz + size / 2;
    const blockId = this.registry.idOf(PLAYGROUND_BLOCK);
    const centerId = this.registry.idOf(PLAYGROUND_CENTER_BLOCK);
    const blocks = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        for (let y = oy + 1; y < PLAYGROUND.maxSearchY; y++) {
          const x = ox + dx, z = oz + dz;
          const id = this.world.getBlockId(x, y, z);
          if (id === 0 || id === blockId || id === centerId) continue;
          const name = this.registry.nameOf(id);
          blocks.push({
            x: Math.round(x - cx), y: Math.round(y - oy), z: Math.round(z - cz),
            type: name, direction: this.world.getBlockMeta(x, y, z),
          });
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
    const json = JSON.stringify({
      blocks,
      metadata: {
        created: new Date().toISOString(),
        // ⚠️ **审查高6：键名必须是 `width`/`height`/`depth`** —— 实测 27 个
        // `assets/structures/*.json` 全部用这三个键（如 `big_house.json` →
        // `{"width":37,"height":11,"depth":39}`）。写 `{x,y,z}` 会破坏「与结构 JSON
        // 格式完全一致」的声明 → 导出的模型喂给结构管线时 dimensions 对不上。
        dimensions: blocks.length === 0
          ? { width: 0, height: 0, depth: 0 }
          : { width: maxX - minX + 1, height: maxY - minY + 1, depth: maxZ - minZ + 1 },
      },
    }, null, 2);
    return { ok: true, json, blocks: blocks.length };
  }

  /**
   * 导入模型（mc-lite `importModelFromJson` 语义照搬）。
   * ⚠️ **未知方块名（registry 里没有）必须计 `invalid` 并跳过，不得写 0（air）** ——
   * 那会静默删掉玩家已有的方块。
   * ⚠️ **Y 越界判据用本仓库的 `WORLD_MIN_Y/WORLD_MAX_Y`**（mc-lite 是 `y < 0 || y > 255`）。
   * @param {string} jsonText
   */
  importModel(jsonText) {
    if (!this._state) return { ok: false, reason: 'not-active' };
    let data;
    try { data = JSON.parse(jsonText); } catch { return { ok: false, reason: 'invalid-json' }; }
    if (!data || !Array.isArray(data.blocks)) return { ok: false, reason: 'invalid-format' };
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    const cx = ox + size / 2, cz = oz + size / 2;
    let placed = 0, skipped = 0, invalid = 0;
    const pending = new Set();
    const changes = [];
    for (const block of data.blocks) {
      if (!block || typeof block !== 'object') { invalid++; continue; }
      const relX = Number(block.x), relY = Number(block.y), relZ = Number(block.z);
      const type = typeof block.type === 'string' ? block.type.trim() : '';
      if (!Number.isFinite(relX) || !Number.isFinite(relY) || !Number.isFinite(relZ) || !type) {
        invalid++; continue;
      }
      const id = this.registry.idOf(type);
      if (id === undefined) { invalid++; continue; }   // ⚠️ 未知方块名 → invalid，不写 air
      const x = Math.round(cx + relX), y = Math.round(oy + relY), z = Math.round(cz + relZ);
      if (y < PLAYGROUND.minSearchY || y >= PLAYGROUND.maxSearchY) { invalid++; continue; }
      // cullMode:'none' 的不可渲染方块跳过（mc-lite `!props.isRendered` 同口径）
      if (this.registry.cullTable[id] === 3) { skipped++; continue; }
      const key = `${x},${y},${z}`;
      if (pending.has(key)) { skipped++; continue; }   // 同坐标重复只保留首次
      pending.add(key);
      // direction → orientation（mc-lite `convertDirectionToOrientation`：取水平四方向）
      const dir = Number(block.direction);
      const meta = Number.isFinite(dir) ? ((Math.trunc(dir) % 4) + 4) % 4 : 0;
      changes.push({ x, y, z, id, meta });
    }
    if (changes.length === 0) return { ok: true, placed: 0, skipped, invalid };
    const report = this.editor.setBlocks(changes);
    placed = report.changes.length;
    skipped += report.skipped.length;
    return { ok: true, placed, skipped, invalid };
  }
}
```

⚠️ **`_hasOverlap` 与 `exportModel` 是主线程同步的大体积扫描**（UI 按钮触发 → 可能可感知卡顿）：
`_hasOverlap` 单次 = 54×54×11 ≈ **3.2 万次** `getBlockId`，而 `_findSafeHeight` **每个 y 迭代调一次**
（最坏从地面到世界顶约 100 次 → 320 万次）；`exportModel` = 54×54×约 90 ≈ **26 万次**。
对照：爆炸 152 次、LOS 每帧约 5300 次 —— 这两处是本 Epic **最大的主线程开销**，
规格 §2.1 只论证了「2916 格写入」，没覆盖它们。

**本任务先照朴素实现交付**（Step 3 的代码就是朴素全扫 —— 它是正确且完整的，
`getBlockId` 是 O(1) typed-array 读，320 万次约几十毫秒级）。⚠️ **不要在 Task 2 就改成增量版**
（那需要额外的测试与签名，且未经实测不知道是否真的需要）。**处理方式留到 Task 4 验收**：
① 实测 `_findSafeHeight`（最坏情况）与 `exportModel` 的耗时并记进报告（目标 < 50ms）；
② 若实测卡顿，再决定优化 —— `_findSafeHeight` 改逐层增量扫描（一旦某层发现重叠即提前放弃，
不必每次重扫全 11 层）、`exportModel` 只扫实际模型高度区间，或改走分帧
（照 `budget.meshDispatchPerFrame` 手法），并在报告标注。**实测数据决定是否优化，不预先优化。**

⚠️ **`_write` 是本 Epic 最大的单次编辑量（2916 格）** —— 须实测 REMESH 收敛期的帧率与
队列深度（bench 场景 ④「批量删 500 块」是既有对照基线，2916 格约为其 5.8 倍）。
若帧率跌破门禁，改走**分帧提交**（每帧 N 格，照 `budget.meshDispatchPerFrame` 的手法），
并在验收报告标注。

⚠️ **导入未做「先清平台上方模型区」**（mc-lite `collectModelAreaBlocksToClear`）——
本任务先不做，因为清空会删掉玩家已有模型（破坏性操作）。若验收时发现导入与已有模型
冲突需要清空语义，作为偏离记进验收报告并单独确认（破坏性操作须用户授权）。

`src/core/game.js` 装配（紧跟 `this.turrets` 之后、`_waitForColumn` 之前）：

```js
this.playground = new PlaygroundService({
  world: this.world, editor: this.editor, registry: this.registry,
});
// ⚠️ **启动期 hydrate 不需要 flushNow**（审查低12）—— M7 的 nests.hydrate 同口径
// （game.js:266 无此前置）。flushNow 是测试侧 reload 前调用的，见 E2E 的 reload 用例。
await this.playground.hydrate(this.persistence);

/** 测试 API（Task 3 的 UI 按钮也调这两个） */
createPlayground() {
  const p = this.player.physics.pos;
  return this.playground.create({ x: p.x, y: p.y, z: p.z });
}
closePlayground() {
  const p = this.player.physics.pos;
  return this.playground.close({ x: p.x, y: p.y, z: p.z });
}
playgroundDebugState() { return { active: this.playground.isActive(), origin: this.playground.origin() }; }
```

- [ ] **Step 4: 在 `tools/check-data.mjs` **扩展** `[创造台]` 环节（补平台尺寸与锚点契约）**

⚠️ **审查 B3：不要新建同名函数** —— `checkPlaygroundContract()` 已由 Task 1 定义并在主流程
加了调用行。同名重复定义会让后一个**覆盖**前一个（Task 1 的「移出背包」断言静默失效）。
本任务只在**既有函数体内追加**平台尺寸契约（`PLAYGROUND` 常量由本任务的 config 提供）：

```js
// 在 Task 1 定义的 checkPlaygroundContract() 函数体内、`infos.push(...)` 之前追加：
//   （须先 import `PLAYGROUND` / `PLAYGROUND_BLOCK` / `PLAYGROUND_CENTER_BLOCK`
//     from '../../src/entities/playground/playground-config.js'，并把 Task 1 里硬编码的
//     `['playground_block','playground_center_block']` 换成这两个常量 —— 单一权威，红线 1）
  // 平台尺寸契约：service 用的尺寸与 config 单一权威一致
  if (PLAYGROUND.size !== 54) failures.push(`[创造台] PLAYGROUND.size = ${PLAYGROUND.size} ≠ 54（mc-lite 口径）`);
  // 锚点 kind 契约（与 service 的 hydrate 同源）
  if (PLAYGROUND_KIND !== 'playground') failures.push('[创造台] PLAYGROUND_KIND ≠ "playground"（hydrate 扫库会对不上）');
  infos.push(`[创造台] 平台 ${PLAYGROUND.size}×${PLAYGROUND.size} = ${PLAYGROUND.size ** 2} 格`);
```

⚠️ **主流程调用行已由 Task 1 加好**（`checkPlaygroundContract();`），本任务**不再加第二行**
（重复调用会让同一环节报两次）。⚠️ **负向验证**：① 注入「`PLAYGROUND.size` 改成 40」→
平台尺寸断言须真 FAIL；② 注入「`PLAYGROUND_KIND` 改成 'create-table'」→ kind 断言须真 FAIL。

- [ ] **Step 5: 写 Playwright E2E**

`tests/playground.spec.mjs`：

```js
// ⚠️ **没有共享 helper 模块** —— `boot` / `waitWorldSettled` 都是各 spec 自带的局部 helper
// （实测：`tests/` 下无共享 .js 模块，`boot` 在 m3-1-inventory/m3-rain/m3-2-orientation
// 各自定义）。本 spec 须把下面两个 helper **整段复制**进来（M8 计划已踩过同一个坑：
// 「没有 startGame 这个 helper，须整段复制」）。
// ⚠️ 不要照 `m3-1-inventory.spec.mjs:30` 的 `boot` —— 那个只 `goto + worldReady`，
// 不含 `waitWorldSettled`，而本 spec 的 reload 用例需要完整收敛等待。照 M8 计划 Task 2
// Step 8 的写法（两个 helper 都要）。
import { test, expect } from 'playwright/test';

/** 等世界真正稳定（判据 = sections 连续两次采样不变 + 队列归零）。
 *  ⚠️ 不能只判队列归零 —— 那是瞬时状态，高负载下队列可能短暂归零而 column 还在加载。
 *  整段照 `tests/zombie-nests.spec.mjs:25` 复制（含其注释与 90s timeout）。 */
async function waitWorldSettled(page) { /* 照 zombie-nests.spec.mjs 实现 */ }

/** 本 spec 的起手式：导航 + 等世界稳定。⚠️ 用 `?vd=2`（M1/M3 既有 spec 同口径）——
 *  创造台在 vd=2 下会触发「未加载视为重叠」判据，该 spec 正好覆盖到它。 */
async function boot(page) {
  await page.goto('/?vd=2');
  await waitWorldSettled(page);
}

test('创造台：生成 54×54 平台 + 中心块，平台方块不可挖不可炸', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => window.__MC_GAME__.createPlayground());
  expect(r.ok).toBe(true);
  const origin = r.origin;
  // 平台格数（抽样验证：四角 + 中心）
  const blocks = await page.evaluate((o) => {
    const g = window.__MC_GAME__;
    const blockId = g.registry.idOf('playground_block');
    const centerId = g.registry.idOf('playground_center_block');
    return {
      corner: g.world.getBlockId(o[0], o[1], o[2]),
      center: g.world.getBlockId(o[0] + 27, o[1], o[2] + 27),
      blockId, centerId,
    };
  }, origin);
  expect(blocks.corner).toBe(blocks.blockId);
  expect(blocks.center).toBe(blocks.centerId);
  // 徒手挖平台方块 → 零写入（indestructible 门控）
  const digResult = await page.evaluate((o) => {
    const g = window.__MC_GAME__;
    g.player.target = { blockPos: [o[0], o[1], o[2]], prevPos: [o[0], o[1] + 1, o[2]],
      normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    return g.world.getBlockId(o[0], o[1], o[2]);
  }, origin);
  expect(digResult).toBe(blocks.blockId);   // 还在
});

test('创造台：reload 后从锚点恢复激活状态，全局仍最多 1 个', async ({ page }) => {
  // ⚠️ **flushNow 是测试侧 reload 前调用的**（审查低12）—— 把内存 edits 落库，
  // reload 后 hydrate 才读得到锚点。照 zombie-nests.spec.mjs 的 reload 手法。
  await boot(page);
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const r = g.createPlayground();
    if (!r.ok) throw new Error(`create failed: ${r.reason}`);
    await g.persistence.flushNow(g.world);   // 落库，供 reload 后 hydrate 读取
  });
  await page.reload();
  await waitWorldSettled(page);
  // 锚点恢复 → active === true
  const restored = await page.evaluate(() => window.__MC_GAME__.playgroundDebugState());
  expect(restored.active).toBe(true);
  // 再 create → 'exists'（全局最多 1 个）
  const second = await page.evaluate(() => window.__MC_GAME__.createPlayground());
  expect(second.reason).toBe('exists');
});

test('创造台：导出 JSON 可被结构管线消费（格式一致）', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const created = g.createPlayground();
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const o = created.origin;
    // 在平台上雕两格 stone 模型（平台上方一格）
    const stoneId = g.registry.idOf('stone');
    const cx = o[0] + 27, cz = o[2] + 27;
    g.editor.setBlocks([
      { x: cx, y: o[1] + 1, z: cz, id: stoneId },
      { x: cx + 1, y: o[1] + 1, z: cz, id: stoneId },
    ]);
    const exp = g.playground.exportModel();   // 同步返回（规格 §2.4）
    return { ok: exp.ok, json: exp.json, blocks: exp.blocks };
  });
  expect(result.ok).toBe(true);
  expect(result.blocks).toBe(2);
  const data = JSON.parse(result.json);
  // blocks 形状与 assets/structures/zombie_nest.json 一致（相对坐标 + type + direction）
  expect(Array.isArray(data.blocks)).toBe(true);
  expect(data.blocks.length).toBe(2);
  expect(data.blocks[0]).toHaveProperty('type', 'stone');
  expect(Number.isFinite(data.blocks[0].x)).toBe(true);
  expect(Number.isFinite(data.blocks[0].direction)).toBe(true);
  // ⚠️ dimensions 键名必须是 width/height/depth（审查高6，实测结构 JSON 口径）
  expect(data.metadata.dimensions).toHaveProperty('width');
  expect(data.metadata.dimensions).toHaveProperty('height');
  expect(data.metadata.dimensions).toHaveProperty('depth');
  expect(data.metadata.dimensions.x).toBeUndefined();   // 不得有旧形状的 x 键
});

test('创造台：玩家在平台内时拒绝关闭', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const created = g.createPlayground();
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const o = created.origin;
    // 雕一格模型（关闭后须保留 —— 只删平台层，不删模型）
    const stoneId = g.registry.idOf('stone');
    const cx = o[0] + 27, cz = o[2] + 27;
    g.editor.setBlock({ x: cx, y: o[1] + 1, z: cz, id: stoneId });
    // ① 玩家在平台内 → 拒绝关闭（把玩家传送到平台上）
    g.player.physics.pos.set(o[0] + 5, o[1] + 1, o[2] + 5);
    const inside = g.closePlayground();
    // ② 玩家移出平台 → 关闭成功
    g.player.physics.pos.set(o[0] - 20, o[1] + 1, o[2]);
    const outside = g.closePlayground();
    return {
      insideReason: inside.reason,
      outsideOk: outside.ok,
      platformGone: g.world.getBlockId(o[0], o[1], o[2]) === 0,   // 平台层变 air
      modelKept: g.world.getBlockId(cx, o[1] + 1, cz) === stoneId, // 模型保留
    };
  });
  expect(result.insideReason).toBe('player-in-playground');
  expect(result.outsideOk).toBe(true);
  expect(result.platformGone).toBe(true);
  expect(result.modelKept).toBe(true);   // ⚠️ 只删平台层，模型方块保留
});
```

⚠️ **负向验证**（全部须真 FAIL）：
① 注入「`_hasOverlap` 恒返回 false」→ 平台与地形重叠生成（须造一个有地形的场景断言重叠）；
② 注入「`_allColumnsLoaded` 恒返回 true」→ 视距 2 时产出半个平台（须在 `?vd=2` 下测）；
③ 注入「导入的未知方块名写 air」→ 玩家已有方块被删；
④ 注入「关闭时连模型区一起删」→ 模型方块消失（断言保留 FAIL）；
⑤ 注入「`maxSearchY` 改成 mc-lite 的 200」→ 搜索恒超出世界顶（平台创建不出来，
`reason === 'no-safe-location'`）。

- [ ] **Step 6: 验证 GREEN + 门禁 + bench**

Run: `npm run check && npx playwright test tests/playground.spec.mjs tests/harness.spec.mjs`
Expected: 全绿。

Run: `npm run bench -- --check`
Expected: 通过。⚠️ **2916 格单次编辑是本 Epic 最大的编辑量** —— 须实测并记进验收报告
（帧率 / REMESH 收敛期队列深度 / upload p95）。若 frameP95 回退 >10%，停下来报告并考虑
分帧提交，**不要擅自改断言或静默放宽**。

- [ ] **Step 7: 提交（仅获授权后执行）**

```bash
git add src/entities/playground/playground-config.js src/entities/playground/playground-service.js \
  src/core/game.js tools/check-data.mjs src/tests/test-playground.js \
  src/tests/index.html tests/playground.spec.mjs
git commit -m "feat(playground): 创造台——54×54 平台 / 锚点持久层 / 导入导出"
```

---

### Task 3: 创造台 UI（toast + 面板动作按钮）

**Files:**

- Create: `src/ui/toast.js`
- Modify: `src/ui/settings-panel.js`（创造台 / 导出 / 导入三个动作按钮）
- Modify: `src/tests/test-ui.js`（按钮文案单一口径 + toast 不进模态栈）

**Interfaces:**

- Consumes: Task 2 的 `game.createPlayground()` / `game.closePlayground()` /
  `game.playground.isActive()` / `game.playground.exportModel()` / `game.playground.importModel(jsonText)`
- Produces:

```js
Toast({ container? })   // .show(message, durationMs?) / .hide() / .dispose()
                        // 屏幕中部短暂提示、自动淡出、**不进 uiModal 模态栈**
```

- [ ] **Step 1: 写失败的 UI 契约测试（照仓库既有手法，不给面板开测试口子）**

⚠️ **`test-ui.js` 是纯函数单测**（只测 `ui/settings.js` 的 `resolveSettings`/`VIEW_DISTANCE_OPTIONS`
与 `ui/icons.js` 的 manifest 契约），**没有** `makeSettingsPanel` 这类面板 fixture，
`settings-panel.js` 也没有任何「测试用只读访问器」先例（公开成员只有
`constructor`/`open`/`close`/`toggle`/`get isOpen`）。故**不要**发明
`panel.playgroundLabel()` / `setPlaygroundActive()` 这类不存在的方法 —— 那会让 RED 永远不 GREEN。

改用仓库既有手法：**把两态文案提成导出常量，断言「构造与状态切换都派生自同一常量」**
（v1.35 的 `CLEAR_SAVE_LABEL` 就是这个套路 —— 它的失效路径正是「复位函数写死旧长文案
覆盖构造时的短文案」）。toast 的断言落在**它自己的纯函数接口**上，不碰面板。

在 `src/tests/test-ui.js` 追加：

```js
test('创造台按钮文案是导出的单一口径常量（两态 + 错误映射）', () => {
  // ⚠️ v1.35 踩坑：`_resetDangerArmed()` 写死旧长文案覆盖了构造时的短文案
  // → 面板打开后显示复位那份，构造代码形同虚设。
  // 钉法 = 断言常量**已导出**且值固定 —— 实现里的构造与状态切换都必须 import 这两个常量，
  // 不得在别处写字面量（Step 4 的实现据此写；写死字面量则本断言与实现脱钩）。
  assertEqual(PLAYGROUND_OPEN_LABEL, '打开创造台');
  assertEqual(PLAYGROUND_CLOSE_LABEL, '关闭创造台');
  // 错误文案映射同样是单一口径（不散落字面量）
  assertEqual(PLAYGROUND_ERRORS['player-in-playground'], '请离开创造台区域后再关闭');
  assertEqual(PLAYGROUND_ERRORS['exists'], '创造台已存在');
});

test('toast 不进模态栈（提示期间玩家仍能操作世界）', () => {
  // toast 的断言落在它自己的纯函数接口上（不需要面板 fixture，也不需要 game 实例）。
  // container 用一个最小的假 DOM 容器（`{ appendChild() {} }` 桩件即可 —— toast 只调它一次）。
  const toast = new Toast({ container: { appendChild() {} } });
  toast.show('创造台已创建');
  assertEqual(toast.isModal(), false);          // 不是模态
  assertTrue(toast.isVisible());
  // ⚠️ 「没进 uiModal 栈」这条**不在单测里断言** —— `uiModal` 是 Game 的状态，
  // 单测没有 game 实例。它由 toast 的实现保证（`show()` 里不调 `game.pushModal`），
  // 并在 Task 3 Step 5 的负向验证里用真游戏页兜住（注入「show 调 pushModal」→ E2E 须真 FAIL）。
});

test('toast 自动淡出（durationMs 后 hide）', async () => {
  const toast = new Toast({ container: { appendChild() {} } });
  toast.show('提示', 10);       // 极短时长便于单测
  assertTrue(toast.isVisible());
  await new Promise((r) => setTimeout(r, 30));
  assertEqual(toast.isVisible(), false);   // 定时器触发 hide
});
```

⚠️ **防重复点击（busy 锁）不在单测里断言** —— 它是面板的 DOM 状态，单测没有面板实例。
落在 Task 3 Step 5 的负向验证（真游戏页连续点击 → 断言只产出一个平台）。
⚠️ **无效盲区自查**：若只断言「第一次点击成功」，注入「去掉锁」仍全绿 ——
E2E 须断言「第二次点击在操作进行中被拒绝」（`reason === 'exists'` 或按钮 disabled）。
- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `Toast` 未定义（模块不存在）；`PLAYGROUND_OPEN_LABEL` / `PLAYGROUND_CLOSE_LABEL` /
`PLAYGROUND_ERRORS` 未导出。
⚠️ **不要断言不存在的面板方法**（`playgroundLabel()` 等）—— Step 1 已明确断言落纯函数接口。

- [ ] **Step 3: 实现 toast**

`src/ui/toast.js`（mc-heavy 目前**没有** `showMessage`/toast 设施，本任务新增）：

```js
// src/ui/toast.js — M9：轻量非模态提示（规格 §3）
// mc-heavy 此前没有 showMessage/toast 设施（CoordsHUD 只显示坐标）。消费者 = 创造台的
// 成功/失败提示（NO_SAFE_LOCATION / PLAYER_IN_PLAYGROUND / EXISTS），后续 Epic 可复用。
//
// ⚠️ **不进 `uiModal` 模态栈** —— 它不是模态：玩家须在提示期间仍能操作世界
// （主循环的 `if (!this.uiModal)` 会跳过 player.update，进栈会让玩家在提示期间无法移动）。
const TOAST_CSS = `
#mc-toast {
  position: fixed; left: 50%; top: 62%; transform: translateX(-50%);
  padding: 8px 16px; background: rgba(0, 0, 0, 0.72); color: #fff;
  font: 14px/1.4 monospace; border: 2px solid #555; pointer-events: none;
  opacity: 0; transition: opacity 0.2s; z-index: 40;
}
#mc-toast.mc-toast-visible { opacity: 1; }
`;

export class Toast {
  /** @param {{container?: HTMLElement}} [deps] 缺省挂 document.body */
  constructor({ container = null } = {}) {
    this._container = container;
    this._el = null;
    this._timer = null;
    this._install();
  }

  _install() {
    const root = this._container ?? document.body;
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    root.appendChild(style);
    this._el = document.createElement('div');
    this._el.id = 'mc-toast';
    root.appendChild(this._el);
    this._styleEl = style;
  }

  /** 显示一条提示，durationMs 后自动淡出。⚠️ 不调 `game.pushModal`（见文件头） */
  show(message, durationMs = 2200) {
    if (!this._el) return;
    this._el.textContent = message;
    this._el.classList.add('mc-toast-visible');
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.hide(), durationMs);
  }

  hide() {
    if (!this._el) return;
    this._el.classList.remove('mc-toast-visible');
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /** 只读诊断接口（单测用） */
  isVisible() { return !!this._el?.classList.contains('mc-toast-visible'); }
  /** **恒 false** —— toast 不是模态（见文件头理由）。单测据此钉住不进模态栈 */
  isModal() { return false; }

  dispose() {
    this.hide();
    this._el?.remove();
    this._styleEl?.remove();
    this._el = null; this._styleEl = null;
  }
}
```

- [ ] **Step 4: 面板动作按钮**

`src/ui/settings-panel.js` —— 右列新增一组（照既有 `_rowWorld()` 的同手法）。
⚠️ **审查 B2：下面 4 处必须一起做，缺一处即构造期 TypeError 或功能落空**：
① 构造函数里初始化 `_playgroundActive` / `_playgroundBusy` / `_toast` —— 既有构造存的是
**`this.game`**（`settings-panel.js:126`），不是 `this._game`，所有调用一律用 `this.game`；
② `_syncPlaygroundVisibility()` / `_onExport()` / `_onImport()` 必须定义（被调用但从未定义
→ TypeError）；③ `_rowPlayground()` 必须 append 到右列（挂载点 `settings-panel.js:164-168`，
既有 `right.appendChild(this._rowWorld())` 之后 —— 计划此前漏了这处修改）；
④ `this._toast` 必须真的赋值，否则 `this._toast?.show(...)` 静默不显示（规格 §3 验收项落空）。

**① 构造函数追加**（`constructor(root, game, settings)` 内，`this.game = game;` 之后）：

```js
    // M9：创造台面板状态 + toast 实例。⚠️ 字段名是 `this.game`（既有），不是 `this._game`
    this._playgroundActive = game.playground?.isActive() ?? false;   // 初值取服务真实状态
    this._playgroundBusy = false;                                    // 防重复点击锁
    this._toast = new Toast({});   // Toast 须 import（`import { Toast } from './toast.js';`）
```

**② 挂载点修改**（`settings-panel.js:164-168` 的右列 append 序列，**此前计划漏了这处**）：

```js
    left.appendChild(this._combinedBlurGunDamage()); // 画质 + 枪械破坏共用一行
    left.appendChild(this._rowVisualStyle());
    right.appendChild(this._rowViewDistance());
    right.appendChild(this._rowBudget());
    right.appendChild(this._rowWorld());             // 新世界 + 删除缓存共用一行
    right.appendChild(this._rowPlayground());        // M9：创造台（右列，纵向余量更大）
```

**③ 面板方法**（照既有 `_rowWorld()` 的同手法）：

```js
/** 「创造台」按钮的两态文案。**单一口径** —— 构造与状态切换共用这两份常量，
 *  不得在别处写字面量（v1.35 踩坑：复位函数写死旧长文案覆盖构造时的短文案）。 */
const PLAYGROUND_OPEN_LABEL = '打开创造台';
const PLAYGROUND_CLOSE_LABEL = '关闭创造台';
const EXPORT_LABEL = '导出模型';
const IMPORT_LABEL = '导入模型';

_rowPlayground() {
  const item = document.createElement('div');
  item.className = 'mc-item';
  const title = document.createElement('div');
  title.className = 'mc-title';
  title.textContent = '创造台';
  item.appendChild(title);

  const group = document.createElement('div');
  group.className = 'mc-btn-group';
  // 主按钮（两态）
  this._playgroundBtn = document.createElement('button');
  this._playgroundBtn.textContent = this._playgroundActive ? PLAYGROUND_CLOSE_LABEL : PLAYGROUND_OPEN_LABEL;
  this._playgroundBtn.onclick = () => this._onPlaygroundToggle();
  group.appendChild(this._playgroundBtn);
  // 导出 / 导入：仅创造台激活时可见（mc-lite `UIManager.js` 同手法）
  this._exportBtn = document.createElement('button');
  this._exportBtn.textContent = EXPORT_LABEL;
  this._exportBtn.onclick = () => this._onExport();
  this._importBtn = document.createElement('button');
  this._importBtn.textContent = IMPORT_LABEL;
  this._importBtn.onclick = () => this._onImport();
  group.appendChild(this._exportBtn);
  group.appendChild(this._importBtn);
  item.appendChild(group);
  this._syncPlaygroundVisibility();
  return item;
}

/** ⚠️ **防重复点击锁** —— 2916 格的写入是秒级操作，重复点击会产出两个平台或半删状态
 *  （mc-lite `isPlaygroundOperationInProgress` 同手法） */
async _onPlaygroundToggle() {
  if (this._playgroundBusy) return;
  this._playgroundBusy = true;
  this._playgroundBtn.disabled = true;
  try {
    const result = this._playgroundActive ? this.game.closePlayground() : this.game.createPlayground();
    if (result.ok) {
      this._playgroundActive = !this._playgroundActive;
      this._toast?.show(this._playgroundActive ? '创造台已创建' : '创造台已关闭');
    } else {
      this._toast?.show(PLAYGROUND_ERRORS[result.reason] ?? `操作失败：${result.reason}`);
    }
    this._syncPlaygroundVisibility();
  } finally {
    this._playgroundBusy = false;
    this._playgroundBtn.disabled = false;
  }
}

/** 导出/导入按钮的可见性同步：仅创造台激活时显示（mc-lite `UIManager.js:540-564` 同手法） */
_syncPlaygroundVisibility() {
  // 主按钮文案随状态切换（单一口径：两态都用导出常量，不写字面量）
  this._playgroundBtn.textContent =
    this._playgroundActive ? PLAYGROUND_CLOSE_LABEL : PLAYGROUND_OPEN_LABEL;
  // 导出/导入仅激活时可见（mc-lite `style.display` 同手法）
  const vis = this._playgroundActive ? '' : 'none';
  this._exportBtn.style.display = vis;
  this._importBtn.style.display = vis;
}

/** 导出模型 JSON 并触发浏览器下载（mc-lite `exportModel` + `UIManager.js:425` 同手法）。
 *  ⚠️ 规格 §2.4 要求「触发浏览器下载 model.json」—— 用 Blob + createObjectURL 实现，
 *  不是只返回 JSON 字符串。 */
_onExport() {
  const result = this.game.playground.exportModel();   // **同步**返回（规格 §2.4）
  if (!result.ok) { this._toast?.show(PLAYGROUND_ERRORS[result.reason] ?? '导出失败'); return; }
  const blob = new Blob([result.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'model.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);   // 释放（mc-lite `UIManager.js:434-441` 同手法）
  this._toast?.show(`模型导出成功（${result.blocks} 方块）`);
}

/** 导入模型 JSON（文件上传）。⚠️ 文件读取是异步的，须在 finally 释放 busy 锁。 */
_onImport() {
  if (this._playgroundBusy) return;
  this._playgroundBusy = true;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';   // mc-lite `UIManager.js:447` 同手法
  input.onchange = async () => {
    try {
      const file = input.files?.[0];
      if (!file) return;
      const jsonText = await file.text();
      const result = this.game.playground.importModel(jsonText);   // **同步**返回（规格 §2.4）
      this._toast?.show(result.ok
        ? `导入完成：放置 ${result.placed}，跳过 ${result.skipped}，无效 ${result.invalid}`
        : (PLAYGROUND_ERRORS[result.reason] ?? '导入失败'));
    } finally {
      this._playgroundBusy = false;   // ⚠️ 异步读取完成才释放锁
    }
  };
  input.click();
}

/** 错误文案映射（单一口径，不散落字面量） */
const PLAYGROUND_ERRORS = {
  'exists': '创造台已存在',
  'no-safe-location': '无法找到合适的空间，请移动位置',
  'not-loaded': '附近区块尚未加载，请稍候重试',
  'not-active': '创造台未激活',
  'player-in-playground': '请离开创造台区域后再关闭',
};
```

⚠️ 三条 CLAUDE.md 活跃约束须遵守：
① **`PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**（会提前终止模板字符串 →
整个模块解析失败 → 游戏页**白屏**）。改完先跑 `npm run lint`；
② **列分隔线规则只作用于 `.mc-item`，不得通配所有子项**（v1.35 踩坑：写
`.mc-column > :first-child` 会连带抹掉 `.mc-combined` 合并盒自己的装饰边框）。本任务新增的
是 `.mc-item`，须补四边 `getComputedStyle` solid 断言；
③ **新配置往右列填**（纵向余量更大）。

⚠️ **导入的文件上传 UI**：用 `<input type="file" accept=".json">`（mc-lite 同手法），
读 `file.text()` 后调 `game.playground.importModel(jsonText)`，结果经 toast 提示
`放置 N，跳过 N，无效 N`。⚠️ 文件读取是异步的，须在 `finally` 里释放 busy 锁。

- [ ] **Step 5: 验证 GREEN + 负向验证**

Run: `npm run check && npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 文案单一口径、toast 非模态、busy 锁生效。

⚠️ **负向验证**（全部须真 FAIL）：① 注入「`_onPlaygroundToggle` 去掉 busy 锁」→
连续点击产出两个平台（`count` 或 `reason==='exists'` 断言 FAIL）；② 注入「toast 调
`game.pushModal('toast')`」→ `isModal()` / `uiModal` 断言 FAIL；③ 注入「导出/导入按钮
在未激活时也可见」→ 可见性断言 FAIL。

⚠️ **自查无效盲区**：若 busy 锁测试只断言「第一次点击成功」，注入「去掉锁」仍全绿 ——
须断言「第二次点击在操作进行中被拒绝」。

- [ ] **Step 6: 提交（仅获授权后执行）**

```bash
git add src/ui/toast.js src/ui/settings-panel.js src/tests/test-ui.js
git commit -m "feat(playground): 创造台 UI——面板动作按钮 + 非模态 toast"
```

---
---

### Task 4: 验收（全量回归 + 负向验证汇总 + 验收报告）

**Files:**

- Create: `docs/m9-playground-acceptance-report.md`
- Modify: `docs/roadmap.md`（回填 M9 commit hash + 状态改「✅ 完成」）
- Modify: `docs/superpowers/plans/2026-09-11-m9-playground.md`（实施状态 + 偏差表）

**Interfaces:**

- Consumes: Task 0~3 的全部产物
- Produces: 验收报告（实测数据 / 偏离表 / 负向验证清单）

- [ ] **Step 1: 跑全量门禁与测试**

```bash
npm run check                 # check:arch + check:data + lint
npm test                      # 全量 Playwright spec
npm run bench -- --check      # 性能回归门禁
```

Expected: 三者全绿。⚠️ 用例计数以 `npm run check:data` 输出为准，**不在报告里硬编码**。

⚠️ **不带 `--check` 跑 bench 会自动重写 `docs/m3-baseline.*`**（冻结基线）—— 若误跑须 `git checkout` 恢复。门禁阻断时先做**交替对照**（vsync 量子化噪声会让 frameP95 误报）。

⚠️ **`m1-acceptance` 的计时断言在高负载下偶发贴线 flaky**（既有问题）。若失败须单独复跑 + 交替对照，**不改断言、不放宽阈值**。

⚠️ **2916 格单次编辑是本 Epic 最大的编辑量** —— 须实测并记进报告（帧率 / REMESH 收敛期队列深度 / upload p95）。若 frameP95 回退 >10%，停下来报告并考虑分帧提交。

- [ ] **Step 2: 汇总负向验证清单**

逐条重跑 Task 1~3 标注的负向验证，确认每条都**真 FAIL**（做完须恢复源码）。按 `docs/testing-policy.md` §2.7 的**十二类**高发区自查无效盲区，特别检查：

- 断言落点是否落在真实接线上（而非桩件）；
- 恒真陷阱：注入后仍全绿的断言（Task 1 的 indestructible/移出背包两条配对断言）；
- 竞态断言落在内存侧而非重载后的落库结果（Task 2 的 hydrate）。

- [ ] **Step 3: 写验收报告**

`docs/m9-playground-acceptance-report.md`，照 M4~M8 验收报告的同结构：

- §1 交付摘要（创造台玩法口径）
- §2 规格逐项对照（规格 §1~§4 → 实测结果）
- §3 实测数据（2916 格写入的帧率与队列深度 / `_hasOverlap` 与 `exportModel` 耗时）
- §4 偏离表（规格已列的有意偏离 + 实施中新发现的偏离，每条附实测理由）—— 须含：
  ① 不维护 `playgroundBlocks` 副本（红线 1）；② 走 `editor.setBlocks` 真实方块而非 mesher 顶点模板；
  ③ 导入未做「先清平台上方模型区」（破坏性操作，须用户授权）；④ 安全高度搜索上界用本仓 `WORLD_MAX_Y=96` 而非 mc-lite 的 200
- §5 负向验证清单（条数 + 每条的注入与 FAIL 证据）+ 自查发现的无效盲区
- §6 遗留 TODO（若有）

⚠️ **实施中与计划的偏差须记进报告** —— 计划未预见的接线、实测必需的偏离、顺带修掉的既有缺陷都要写，不要静默吞掉。

- [ ] **Step 4: 回填 roadmap 与本计划的实施状态**

`docs/roadmap.md`：里程碑总表 M9 行填真实 commit hash、状态改「✅ 完成（日期）」；「一句话现状」段更新；后续扩展点表划掉创造台行；新增「M9 之后的遗留 TODO」段（若有）。

本计划文件头部加实施状态块（照 M7/M8 计划的同手法）。

- [ ] **Step 5: 提交（仅获授权后执行）**

```bash
git add docs/m9-playground-acceptance-report.md docs/roadmap.md \
  docs/superpowers/plans/2026-09-11-m9-playground.md
git commit -m "docs(m9): 验收报告与 roadmap 回填"
```
---

## 计划自检

**规格覆盖**（规格 §1~§4 逐项 → 任务）：

| 规格节 | 任务 | 状态 |
|---|---|---|
| §1 不可破坏两项 + 移出背包（§1.1 登记 / §1.2 成对移出 / §1.3 断言翻转） | Task 1 | ✅ 覆盖 |
| §2 创造台服务（平台生成 / 关闭 / 重启恢复 / 导入导出） | Task 2 | ✅ 覆盖（**一处偏离**：导入未做「先清平台上方模型区」—— mc-lite `collectModelAreaBlocksToClear` 未移植，理由是清空会删掉玩家已有模型，属破坏性操作；须记进验收报告 §4） |
| §3 创造台 UI（面板按钮 / toast） | Task 3 | ✅ 覆盖 |
| §4 验收口径 | Task 4 | ✅ 覆盖 |
| 设计文档同步（DR-17 / 物品集合口径 / 三类文档） | Task 0 | ✅ 覆盖 |

**类型一致性**（跨任务的签名须一致）：

- `registry.isIndestructible(id)` —— M8 交付，Task 1 复用 ✅
- `PLAYGROUND`（config）—— Task 2 定义，Task 2/3 消费 ✅
- `playground.create|close|exportModel|importModel|isActive|origin|hydrate|isPlayerInPlayground` —— Task 2 定义，Task 3 消费 ✅
  ⚠️ `importModel` 是**同步**返回（不是 Promise）—— Task 3 的测试不得 `await` 它
- `Toast({container})` → `.show/.hide/.isModal/.isVisible` —— Task 3 ✅
- 跨 Epic 断言翻转：`isWeaponDestructible(playground)` 在 M8 是 `assertTrue`、M9 改回 `assertFalse`（Task 1 认领）✅

**占位符扫描**：无 TBD / TODO / 「类似 Task N」/ 「添加适当的错误处理」等模式；每个代码步骤都给了完整代码块。

---

## 既有 API 实际签名对照表（减少执行者猜 API 的空间）

本计划消费既有接口。**下表是实测核对过的真实签名/返回值** —— 正文里凡引用这些 API 处，
以本表为准（M8 审查发现过 8 处凭印象写错的 API，都已在 M8 正文订正；本表是防再次猜错的
速查）。执行者遇到正文与本表不一致时，**以本表为准并停下来报告**。

| API | 实际签名 / 返回值 | 出处（实测） | 易错点 |
|---|---|---|---|
| `window.__MC_GAME__` | 全局测试钩子（不是 `window.game`） | `main.js:64` | spec 里一律用 `window.__MC_GAME__`；`window.game` 全仓零命中 |
| spec 起手式 | `await page.goto('/?vd=2')` + `await waitWorldSettled(page)` | `zombie-nests.spec.mjs:25` | **没有 `startGame(page)`**；`waitWorldSettled` 各 spec 各自定义（无共享 helper 模块）。⚠️ 创造台在 vd=2 下会触发「未加载视为重叠」判据（平台距玩家 10~64 格 > 加载半径 64 格边界），该 spec 用 `?vd=2` 即可触发到它 |
| `editor.setBlocks(changes)` | 返回 `{changes, affected, changedColumns, skipped}`；不带 `blockEntity` 即清除该格 entity | `world-editor.js` | close() 的「中心块 entity 自动清除」依赖此语义 |
| `editor.setBlockEntity({x,y,z,value})` | `value=null` 删除；不 bump version、不 remesh | `world-editor.js` | 纯 entity 写 |
| `world.hasColumn(cx, cz)` | boolean（column 是否已加载） | `world-data.js:19` | 选址预检用；未加载 column 的 `getBlockId` 返回 0（air）→ 会误判「安全」 |
| `world.getBlockId(x,y,z)` | number（column 缺失或越上界 → 0；越下界 → bedrock） | `world-data.js:24` | 未加载 column 返回 0，不是 null |
| `world.getBlockMeta(x,y,z)` | number（orientation） | `world-data.js` | 导出模型时读朝向 |
| `persistence.listBlockEntities(kind)` | `Promise<Array<{columnKey,index,blockEntity}>>` | `persistence.js:120` | hydrate 用；⚠️ **启动期 hydrate 不需要 flushNow**（M7 同口径）；flushNow 是测试侧 reload 前调用 |
| `registry.isIndestructible(id)` | boolean（M8 交付） | `block-registry.js` | Task 1 登记两项后自动生效于三个消费者 |
| `registry.cullTable[id]` | number（3 = `cullMode:'none'`，不渲染） | `block-registry.js` | 导入时跳过不可渲染方块 |
| `registry.idOf(name)` | number \| undefined（未知名字返回 undefined） | `block-registry.js` | ⚠️ 导入未知方块名 → 计 `invalid`，**不得写 0（air）** |
| `buildItemNames(registry)` | `string[]`（registry − 两个排除集合） | `inventory.js` | Task 1 移出背包后自动少两项 |
| 门禁 `[物品集合]` 打印 | `N 项 = registry 126 − 排除 {两集合之和}` | `check-data.mjs:104` | Task 1 后「排除 8」→「排除 10」（不是 6） |

⚠️ **mc-lite 侧引用**（正文已订正的行号，执行者复核时以此为准）：
`PlaygroundService.js` 的 `playgroundSize=54` / `requiredClearance=10` / `distance=10` /
`isPlayerInPlayground` 的 `maxY=origin.y+20` / `findSafePlaygroundHeight` 的 `maxY=200`
（本仓改 `WORLD_MAX_Y=96`）/ `collectModelAreaBlocksToClear`（未移植，记偏离）/
`convertDirectionToOrientation`（`((intDir%4)+4)%4`）/ `Game.js:206-321` 手工列举 107 行
（2 行被注释 → 有效 105 项，不含 playground）。
