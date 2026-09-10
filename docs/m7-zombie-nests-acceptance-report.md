# M7 丧尸巢穴验收报告

**里程碑：** M7 玩家放置丧尸巢穴
**验收日期：** 2026-09-10
**结论：** ✅ 全部验收项达标；门禁全绿（`npm test` 89 passed / 1 failed —— 唯一失败是
`m1-acceptance` 既有 flaky，交替对照确认非本次回退；`bench --check` 通过）

> 本报告如实记录验收数据、负向验证实测、实施中发现并修掉的真实缺陷（含**两个自己引入的
> 回归**与**三个无效盲区**）、与 mc-lite 的有意偏离。性能数字为本机实测。
>
> ⚠️ **§4.7 是交付后用户实玩发现的缺陷**：我只接了 `selectPlaceable()` 测试 API 路径，
> 漏了**玩家从背包选中巢穴图标**这条真实主路径 → 右键只放出一个贴了巢穴图案的单格正方体。
> 我的 E2E 当时全绿（测试手工伪造了 target 且只走 API 路径），属于典型的「测试没覆盖真实接线」。
> 修法对齐 mc-lite 的物品名路由，详见该节。

## 1. 环境

| 项 | 值 |
|---|---|
| 设备 | macOS ARM（Darwin 25.5.0） |
| WebGPU 后端 | apple/metal-3（`channel: 'chromium'` 零 flag，本机真 GPU） |
| Node | v26.4.0 |
| Playwright | 1.62.1（chromium-1234） |
| three.js | r185.1（本地 `vendor/three/`） |
| 视距 | 压力段 `vd=8`（289 columns）；其余段 `vd=2` |

## 2. 验收项对照（M7 规格 §3）

| 验收项 | 实测 | 结论 |
|---|---|---|
| 放置 8 个成功，第 9 个无任何世界写入 | 8 个逐个放置成功（`ok:true`），第 9 个返回 `limit` 且 `editor.calls.length` 不变 | ✅ |
| 结构碰撞、越界、玩家重叠、无唯一关键方块均原子失败 | 四种 reason 各自命中（`occupied` / `bounds` / `player-overlap` / `invalid-blueprint`），失败路径 `editor.calls.length` 恒等于放置前 | ✅ |
| 最小创造模式选择 API 触发放置，成功后尝试播放 `put` | `selectPlaceable('zombie_nest_alias_block')` → true；`placeBlock()` 分流放置成功；`audioDebugState().playRequests.put` 由 0 → 1 | ✅ |
| **玩家主路径：背包选中图标 → 右键放置整个 38 方块结构** | 背包面板里有巢穴图标（alias 在 118 项内，mc-lite 同口径）；选中后右键 → 蓝图 38 格**全部落地**（`missingCount === 0`）+ 锚点建立 + controller 就位 | ✅（交付后补，见 §4.7） |
| M7 不宣称已实现背包或扩展 Hotbar | 五格 hotbar 语义不变（`hotbarIndex` 未变）；未新增背包 UI 代码 —— alias 走既有背包面板的常规选中，只多了**物品名路由** | ✅ |
| 关键方块被徒手/武器/TNT 批量破坏后 controller 立刻注销，锚点/索引删除 | 三种来源逐项断言 `{controllers:0, anchor:null, blockId:0, count:0}` —— 三者同义 | ✅ |
| 卸载/重载不会复活 | reload 两次后 `controllers` 恒为 1、`count` 恒为 1；column 卸载只销毁 controller，anchor 与索引保留 | ✅ |
| 8 秒节流、八个精确偏移、六层搜索、两格空腔、solid 支撑口径固定 | `update(7_999)` 不刷 / `update(8_000)` 才刷；首个合法位置 `[origin.x+0.5, origin.y+4, origin.z+3.5]`（偏移 `{0,3}` × `dy=3`）；最深 `dy=-2` 与最后偏移 `{-2,-2}` 均可达；头格被占判非法 | ✅ |
| 全局丧尸上限拒绝时不产生实体，但仍更新 `lastSpawnAt` | `zombies.spawn` 返回 null 时 `entityWrites[0].value.lastSpawnAt === 8_000` | ✅ |
| GEN 接管后对已有 blockEntity column 再编辑并 `flushNow()`，重启仍保留旧 edits 与 anchor | 重启两次后 anchor（`gold_block` + `blockEntity`）与普通 dirt edit 均在 | ✅ |
| 重启与 column 卸载后每个锚点只恢复一个 controller | `controllers.size === 1`；重复调 `_createNestController(id)` 后**对象引用不变**（见 §3.4） | ✅ |
| 默认 20 上限下无过期 Worker 回写或渲染 slot 泄漏 | 全量 E2E 89 passed（含 M6 默认 20 只压力验收） | ✅ |
| 8 巢穴/30 丧尸作联调压力 fixture，报告须标注非默认值 | 见 §5；**30 是中档 fixture，默认上限是 20** | ✅ |

**蓝图实测**：`assets/structures/zombie_nest.json` 展开后 **38 项**（`sand` 29 / `stone_diorite` 8 /
`gold_block` 1），唯一最高格 `[0,5,0]` 为 `gold_block`（registry id **73**）。

**真实刷怪实测**（真游戏页 `vd=8`，放置 8 个巢穴后等 10 秒）：
- `zombies.count() === 16` = 8 巢穴 × 2 轮（10s 内两次 8 秒节流）
- 实体 `state.source` 实测为 `["nest-1","nest-2","nest-3","nest-4","nest-5"]` → **source 正确传播为巢穴 id**
- 刷怪坐标带 `.5` 偏移（如 `[89.32, 0.00, 81.21]`），符合规格 `[baseX+.5, footY, baseZ+.5]`

## 3. 负向验证实测（Tier 1 必需环节）

共 **19 条注入**，全部确认真 FAIL；自查发现并修掉 **3 个无效盲区**（见 §3.5 / §3.6 / §3.7）。
其中第 19 条（移除背包物品名分流）由**用户实玩缺陷**暴露 —— 我的测试原先根本没覆盖那条路径。

### 3.1 Task 1：blockEntities edits 与 GEN 接管重放（3 条）

| 注入 | 断言落点 | 实测 |
|---|---|---|
| 接管不重建 `edits` Map（删 `restoreEdits` 调用） | spec：`editsSize > 0` | ✅ 真 FAIL（`Expected >0, got 0`） |
| `flushNow` 丢 `blockEntity` 字段（回到 M7 前的硬编码 `{index,id,meta}`） | spec：`entitiesSize === 1` | ✅ 真 FAIL（`Received: 0`） |
| 去掉 `?? null` 归一化 → no-change 判定失效 | 单测：重复写同 id/meta 判 no-change | ✅ 真 FAIL（`Expected ["no-change"], got []`） |

### 3.2 Task 2：蓝图校验、原子放置、创造模式入口与音频（7 条）

| 注入 | 断言落点 | 实测 |
|---|---|---|
| 去掉 `limit` 门控 | 单测：第九个返回 `limit` | ✅ 真 FAIL（`Expected limit, got undefined`） |
| `player-overlap` 误报为 `occupied` | 单测：玩家重叠返回 `player-overlap` | ✅ 真 FAIL（`Expected player-overlap, got occupied`） |
| `selectPlaceable` 不校验 `CREATIVE_SPECIALS` | spec：未知物品返回 false | ✅ 真 FAIL（`Received: true`） |
| 不播放 `put` 音效 | spec：`putAfter === putBefore+1` | ✅ 真 FAIL（`Received: 0`） |
| 去掉「恰一个最高格」校验 | 单测：两个最高格抛错 | ✅ 真 FAIL（`Expected true, got false`） |
| 去掉「最高格必须是 gold_block」校验 | 单测：最高格不是 gold 抛错 | ✅ 真 FAIL（`Expected true, got false`） |
| 去掉未知方块名校验 | 单测：未知名字抛错 | ⚠️ **首次全绿（无效盲区）** → 修后真 FAIL（见 §3.5） |

### 3.3 Task 3：事件失效、六层刷怪、column 生命周期（4 条）

| 注入 | 断言落点 | 实测 |
|---|---|---|
| 失效判定不比对 `newId`（只看坐标覆盖） | 单测：同格写回同 id 不误触发 | ✅ 真 FAIL（`Expected null, got nest-a`） |
| 上限改用 `controllers.size` 而非索引 | spec：hydrate 后第九次返回 `limit` | ✅ 真 FAIL（`count` 收到 9） |
| `spawnDyBottom` 改 -1（只五层） | 单测：最深 `dy=-2` 可达 | ✅ 真 FAIL（`Expected 1, got 0`） |
| 前两个偏移顺序互换（**保持 8 项不变**） | 单测：4 条偏移顺序断言 | ✅ 真 FAIL（4 条，`Expected 8.5, got 11.5`） |

> ⚠️ 注入「偏移顺序互换」时若连**项数**一起改（如注释掉两项），测的就不是顺序而是「少了两个
> 偏移」—— 会掩盖真实盲区。实测踩坑：首次 perl 替换把后续两项吞进注释，已改为保持 8 项。

### 3.4 Task 4：reload 去重与压力 fixture（4 条）

| 注入 | 断言落点 | 实测 |
|---|---|---|
| 去掉 controller 去重判定 | spec：`controllers().size === 1` | ⚠️ **首次全绿（无效盲区）** → 改用引用比较后真 FAIL（见 §3.6） |
| renderer 容量退回默认 20 | spec：`meshCapacity === 30` | ✅ 真 FAIL（`Received: 20`） |
| `flushNow` 只写带 entity 的 edit（丢普通 edit） | spec：reload 后普通 dirt edit 恢复 | ✅ 真 FAIL（`Received: 0`） |

### 3.5 自查发现并修掉的无效盲区 ①（蓝图未知方块名）

**注入后仍全绿** → 断言没落在被测路径。根因：原测试的蓝图**只有一个方块且它就是最高格**，
去掉未知名校验后下游的「最高格不是 gold」校验仍会抛错 → 断言恒真。

**修法**：让未知名字落在**非最高格**（最高格是合法 `gold_block`），这样 gold 校验兜不住它。
修后同一条注入真 FAIL。

### 3.6 自查发现并修掉的无效盲区 ②（controller 去重）

**注入后仍全绿** → 两层原因：

① `page.reload()` 创建全新 game 实例，controller map 每次都是空的，去重路径根本没被走到；

② 更根本的：`_controllers` 是**按 id 为键的 Map**，重复创建会**覆盖写** → `size` 恒为 1。
去重的真实价值不是 size，而是**防止创建多余 controller 对象**（旧对象没被 `dispose` →
world/zombies/editor 引用泄漏）。故 `controllers().size` 这个断言**测不到**去重。

**修法**：新增一条测试比较**对象引用** —— 重复调 `_createNestController(id)` 后断言
`first === second`（引用相同）且原 controller 未被 `dispose`。修后同一条注入真 FAIL
（`sameRef` 收到 false）。

### 3.7 用户实玩缺陷暴露的无效盲区 ③（背包放置路径未被测试覆盖）

**注入「移除背包物品名分流」后仍全绿** —— 这正是 §4.7 用户报告的缺陷，说明我的测试
**根本没覆盖它发生的那条路径**。根因两层：

① 原测试手工伪造 `player.target`（只给 `prevPos`、无 `blockPos`），且**只走
`selectPlaceable()` 测试 API 路径** —— 玩家真实走的「背包选中图标 → 右键」路径完全没覆盖；

② 把背包路径测试与 API 测试**合并到同一个 test** 时，前面调用过的 `selectPlaceable()`
会残留 `_selectedPlaceable` 标志 → `placeBlock` 优先走 API 分支而非背包分流分支 →
注入的缺陷（在背包分支）不被触发，断言恒真。

**修法**：
- 断言落在**蓝图核对**上 —— 用 `loadNestBlueprint` 取 38 个期望格逐个比对
  `world.getBlockId() === expected.id`，断言 `missingCount === 0`（缺陷时实测 **38**，
  不是 37：退化的单格放置落在 `blockPos` = 地面格，而该格本就是 solid → 38 个期望格无一匹配）；
- **必须独立成 test**（新 page = 新 game 实例，无残留状态）。修后同一条注入真 FAIL。

> 这一条与前两个盲区的共同模式：**断言落在「我自己构造的路径」而非「用户真实走的路径」**。
> 写接线类测试时须先问「玩家实际会怎么触发这个功能」，再决定测试从哪进入。

## 4. 实施中发现并修掉的真实缺陷

### 4.1 GEN 接管不重建 `edits` Map → 旧存档被覆盖（Task 1 核心，**既有 bug**）

**现象**：`Scheduler._onGenResult` 新建 column 时只搬 typed buffer，`column.edits` 留空。
玩家在该 column 新放一个方块后，`Persistence.flushNow()` 会用「只含新编辑」的 Map
整行 `put` 覆盖该 columnKey 的存档 → **旧 edits（含巢穴锚点）静默丢失**。

**为何肉眼看不出**：旧 anchor 的 `gold_block` 仍在渲染、巢穴照常刷怪，只在「接管后再编辑一次 +
flush + 重启」时暴露。Worker 侧 `applyEdits` 已把 edits 叠进 blocks/meta（`world-worker.js:76`），
故方块值正确 —— 丢的是**持久层**而非渲染层。

**修法**：新增 `ChunkColumn.restoreEdits()`（重建 blocks/meta + `blockEntities` + `edits` 三者），
接管时调用；`applyEdits` 保留为 Worker 内的无状态版本（分工明确，不留第二份权威）。

### 4.2 no-change 判定失效（Task 1，**我自己引入的回归**）

**根因**：我给 `setBlock`/`setBlocks` 加 blockEntity 通道时，`getBlockEntity` 缺省返回 **null**
而未传 entity 的 change 是 **undefined**，`null === undefined` 恒 false →
**重复放同一方块不再被判为 no-change**（影响 M4 武器破坏路径，不只是巢穴）。

**修法**：`?? null` 归一化 + 在 `test-world-editor.js` 补契约断言钉住这个回归点
（此前无任何 no-change 断言，正是它能溜进来的原因）。

### 4.3 批量编辑热路径回退 11.1%（Task 1，**我自己引入的性能回退**）

**根因**：`setBlocks` 循环里每格调 `getBlockId`/`getBlockMeta`/`getBlockEntity`，三个函数各自
重算 cx/cz/columnKey/Map.get/blockIndex —— 同一换算做三遍。

**门禁证据**：`bench --check` 阻断 —— `[回退 11.1%] ④ 模拟 TNT 批量删 500 块 · frameP95: 9 → 10`。

**修法**：新增 `WorldData.readCell(x,y,z)` 一次换算读出 id/meta/blockEntity，编辑路径共用；
`setBlocks` 循环内直接读 typed array 与 Map。修后 `bench --check` 通过（场景 ④ p95 = 9.3）。

### 4.4 新放置的巢穴永不刷怪（Task 2/3，**架构缺口**）

**根因**：`place()` 成功后没有创建 controller，而 anchor column **此刻已加载** →
`onColumnReady` 早在放置前就触发过了，不会再为新锚点触发一次。

**现象**：方块全写对、anchor 也在、索引也登记了，但 `controllers.size` 恒为 0 → 巢穴不刷怪。
肉眼看不出差别（结构完整可见）。

**修法**：service 新增 `onPlaced` 回调（Game 注入 `_createNestController`），与
`onColumnReady` 两条路径共用同一个创建方法。

### 4.5 reload 后 controller 缺失（Task 4，**装配时序缺口**）

**根因实测定位**（诊断脚本读实际数据，不靠猜）：
- `colEntitiesSize: 1` + `kindsInColumn: ["zombie-nest"]` → column 的 blockEntities **有**锚点
- `indexHasId: true`、`count: 1` → hydrate **成功**
- `controllers: 0` → controller **没创建**

三者中只有 controller 缺失 → 是时序问题。`onColumnReady` 注册在 game.js:201，而 `this.nests`
创建在 :274（武器运行时装配段），中间隔着 `_waitForColumn`（:256）。出生点 column 就绪时
`this.nests` 还是 null，`_createNestControllers` 第一行直接 return。

**对照证据**：`this.zombies` 装配在 :232（早于 `_waitForColumn`），故同样的 column ready
路径正常工作 —— **顺序差异是唯一原因**。

**修法**：把 M7 装配块移到 zombies 装配之后、`_waitForColumn` 之前（已在代码注释中记录踩坑，
防后来者照直觉改回）。

### 4.6 测试侧根因（非产品缺陷，但会导致假失败）

| 现象 | 根因 | 修法 |
|---|---|---|
| 刷怪搜索三条测试 `spawn=0` | fixture 耦合缺陷：`supportAt` 在 `footY-1` 铺石头，而**相邻层的支撑格正是下一层的脚格** → 给上层铺支撑会填掉下层脚格，两层互相污染（数学必然：同一列最多只有一层合法） | 只铺目标层支撑；「头格被占」改用**同 dy、不同偏移**让头格成为唯一变量 |
| `skipped=true`，断言根本没跑到 | Playwright 每个 test 是全新 context = **新随机 seed**，出生点在城市里时房子/树密集，窄范围找不到天然全空落点；扩范围只降低概率，没消除 flaky | `findLegalOrigin` 两段式：先找天然全空，找不到才人为清理（清理不掩盖 `occupied` 判定 —— 那条由单测独立覆盖） |
| 第九次 place 返回 `bounds` 而非 `limit` | 预检顺序是 bounds → occupied → player-overlap → limit，用远处坐标（column 未加载）时先报 bounds | 改用真实合法落点测 limit |
| `nestCount` 收到 0 而非 4 | hydrate 走 `listBlockEntities` 扫 IndexedDB，未 flush 时库里没有锚点 → hydrate 的 `clear()+重建` 把索引清成 0 | 测试补 flush-before-hydrate（真实重启路径本就是 flush → reload → hydrate） |
| `hydrate` 用例单独跑通过、全量跑时 `expect(legal).not.toBe(null)` 失败 | **`waitWorldSettled` 只判队列瞬时归零**（项目记忆里早已记录的教训，我这次仍重犯）：`worldReady === true` 仅表示出生点邻域就绪，后台仍在填充 column；高负载下队列短暂归零而 column 未加载 → `findLegalOrigin` 对未加载位置读到 `getBlockId === 0` → `groundY === null` → 返回 null | 判据改为 **sections 连续两次采样不变** + 队列归零（`polling: 500`） |
| 「找到了 origin 却放置失败」（更难定位） | 未加载 column 的位置 `getBlockId` 恒为 0 → 被 `findLegalOrigin` **误判为天然全空的合法落点**，而 `place()` 随后以 `bounds` 拒绝 | `probe()` 加显式 `world.hasColumn()` 守卫 |

### 4.7 **玩家从背包选中巢穴图标只放出一个单格方块（用户实玩发现，交付后修复）**

**用户报告**：在背包里选择丧尸巢穴的图标 → 右键放置 → 放置的依然是一个贴了巢穴图案的
**单个正方体**，而不是整个 38 方块的结构。

**根因（实测读源确认，非推断）**：我只接了 `selectPlaceable()` **测试 API** 这条路径，
漏了玩家真实主路径。`zombie_nest_alias_block` 在 registry 里（126 项）但**不在**
`HIDDEN_FROM_INVENTORY`（只有 `chimney` + 三个床方块）→ 它落在背包集合 118 项内 →
玩家能从背包面板选中它 → `placeBlock()` 取背包选中槽 → 走**常规单格 `editor.setBlock`**
→ 放出一个单格方块。

**mc-lite 对照（`PlayerInteraction.tryPlaceBlock()` `:286-296`）**：mc-lite 的做法是在
**唯一放置路径里按物品名路由**到 entity registry 的 placement handler：

```js
if (game?.entityRegistry?.isSpecialBlock(type)) {
  const handler = game.entityRegistry.getHandler(type);
  if (handler) return handler.place(x, y, z);   // ZombieNestPlacementHandler → 放 38 个方块 + 建巢穴
}
```

`zombie_nest_alias_block` 在 mc-lite **就在背包里**（放置成功后 `inventory.remove(..., 1)`）。
所以正确修法不是把它移出背包，而是补上物品名路由 —— 与本仓库既有的 `bed_alias_block`
（已在 `HIDDEN_FROM_INVENTORY`，走 `tryPlaceBed`）是两种不同手法，巢穴按 mc-lite 走前者。

**修法**：`placeBlock()` 取背包槽后，先判 `CREATIVE_SPECIALS.has(slot.item)` → 命中则调
`_placeSpecial()`（一次 `setBlocks` 放 38 格 + 建锚点）并 `return`，**不回落到单格放置**。

**第二处连带缺陷（同一改动一并修掉）**：两条放置路径的 origin 语义不一致 ——
API 分支用 `target.prevPos`（空气格），而结构最低层须落在**地面格**。实测后果：38 格里
30 格落在未清理的位置 → 大面积放置失败。两条路径统一为 **`target.blockPos`（命中方块）**，
与 mc-lite `generateBlocks` 的 `y + block.y - 1`（最低层落在传入 y）同口径。

**为什么我的 E2E 当时全绿（测试盲区）**：原测试手工伪造了 `player.target`
（只给 `prevPos`、无 `blockPos`）且**只走 `selectPlaceable()` API 路径** —— 玩家真实走的
背包路径完全没覆盖。这是「测试没覆盖真实接线」的典型。

**修法与新增覆盖**：
- 新增**独立** test「玩家主路径：从背包选中巢穴图标 → 右键放置整个 38 方块结构」，
  用真实 `blockPos`/`prevPos` 形状 + 蓝图核对**全部 38 格落地**（`missingCount === 0`）；
- **必须独立成 test（新 page = 新 game 实例）**：与 API 测试合并时，残留的 `_selectedPlaceable`
  标志会让 `placeBlock` 走 API 分支而非背包分流分支 → 注入「移除背包分流」**仍全绿**
  （实测无效盲区，见 §3.7）。

### 4.8 背包里的巢穴图标是立方体等轴测图（用户实玩发现，交付后修复）

**现象**：背包面板里巢穴图标显示为一个立方体等轴测图，但该物品代表**整个 38 方块结构**
（放置走 §4.7 的物品名路由，不会真的放进世界一格）→ 立方体是错的表达。用户要求对齐 mc-lite：
直接用已有的那张示意图做占位图，**不新烘焙一张**。

**mc-lite 实测口径**（读源确认）：`src/utils/ItemIconUtils.js` 的 `getCustomIconPath()` 有一张
手工图标表，把 `zombie_nest_alias_block` → `zombie_nest_alias_block.png`、
`turret_alias_block` → `turret.png`、`bed_alias_block` → `bed/Bed_(front_texture)_JE2_BE2.png`、
`mine_cart` → `Invicon_Minecart.png` 一起映射，`createItemIcon()` 命中即**绕过**
`HUD.generateIcon()` 的立方体生成。CSS 是 `global.css:46`
`.slot img { width:32px; height:32px; image-rendering:pixelated }` → nearest 降采样。

**mc-heavy 已有等价机制，不需新增任何东西**：`tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`
平面路径正是这个语义 —— `mine_cart` 已在清单里，注释理由「是**实体**不是方块，mesher 无其几何
模板 → 等轴测不适用」。故只需把 `zombie_nest_alias_block` 加进 `FLAT_BLOCKS` + 跑
`npm run icons`。运行时仍是 1 行 `icon.style.background = ICON_CSS[name]`（无新增分支），
指纹门禁自动覆盖，`FLAT_ICON_TILE` **无需加条目**（`faces-data.js:109` 已映射同名 tile，
且该 tile 已在 `atlas.json` → 引用完整性门禁不报）。

**降采样算法的单变量对照**（同尺寸只换采样算法）：

| 算法 | 40px 不透明 | 40px 色数 | 判定 |
|---|---|---|---|
| 单点 nearest（既有平面路径口径） | 57% | 799 | ✅ 采用 —— 与 mc-lite `pixelated` 等价，保像素风锐利 |
| 区域平均 | 86% | 426 | ❌ 会糊（源图 250×208 → 40px 每格约 6×5 源像素） |

**判据用机制而非像素统计**：像素统计区分度不够 —— HEAD 版立方体等轴测也是 63% 不透明 / 435 色
（alias 的贴图本身就是整张示意图，立方体采样它也保留 alpha）。改用
**「atlas 内该矩形逐像素等于源图 nearest 降采样」**：

| 侧 | inventory 32px | hotbar 40px |
|---|---|---|
| 改动侧 | **100.0%**（1024/1024） | **100.0%**（1600/1600） |
| HEAD 侧 | 7.6%（78/1024） | 6.5%（104/1600） |

HEAD 侧只有全透明像素碰巧相同 —— 立方体不可能满足这个判据。指纹串也一眼可辨
（`flat;t:zombie_nest_alias_block#cjctfo` vs `geom:box;quads:3;...`）。

**负向验证真 FAIL**：注入「移除 `FLAT_BLOCKS` 条目」→ 指纹回到 `geom:box`、判据降到
7.6%/6.5%。⚠️ **注入第一次没生效**：perl 模式要求 `'mine_cart', 'hanging_lamp',` 前是两个
空格缩进，实际它接在 `'vine', 'lilypad', ` 之后 → 静默未替换，指纹仍是 `flat;`，判据仍 100%。
这是「注入后仍全绿先怀疑落点」的**另一面**：那边是「注入生效了但断言抓不到」，这边是
「断言没问题但注入没生效」。改用 Edit 工具（精确匹配，失败会报错）后注入才真正落地。
已记入 `docs/testing-policy.md` §2.7。

**未加门禁断言**：考虑过 `CREATIVE_SPECIALS ⊆ FLAT_BLOCKS` 的关系型断言但**否掉** ——
它不是必然不变式。未来若有「需特殊放置逻辑但仍是单格方块」的物品（如可旋转的装置），
它会进 `CREATIVE_SPECIALS` 而立方体图标恰恰是对的 → 断言会误报，而**门禁误报比无门禁更糟**。
剩余失效路径属**立刻可见**（打开背包就看到图标是立方体），Tier 3 判据不需门禁。
防重犯落在**改动入口注释**（`player.js` 的 `CREATIVE_SPECIALS` —— 做炮塔的人必先改它）
+ `CLAUDE.md` 活跃约束。

**连带修正 `player.js` 一段错注释**：原写「受控创造模式专属物品：**不进 Hotbar、不进背包面板**」，
实测 alias **就在**背包集合 118 项内（`buildItemNames()` 含它，槽位索引 75）。那个错前提正是
§4.7 缺陷的根因 —— 验收时纠正了文档（见 §6 的 ⚠️ 段）但**代码注释没跟上**。已改为
「放置走物品名路由，不落到常规单格 `editor.setBlock`」并补「加新项时的连带改动」清单
（平面图标 + origin 用 `blockPos`）。

**门禁**：`npm run check` 全绿（图标过期 118 项指纹匹配、形状权威 **103 等轴测 + 15 平面**、
CSS 串 0 项变更 —— 装箱顺序未变）+ 浏览器内单测 **451 全绿** + M7 spec **10 passed**。
改动不碰热路径（`tools/` + 注释 + 烘焙产物）→ 按门禁分层不需 `bench --check`。

## 5. 性能实测与交替对照

### 5.1 默认 20 上限稳态（`vd=8`，289 columns）

M7 未改变默认丧尸上限（仍是 20），故 M6 的默认压力验收结果继续有效（全量 E2E 中
`M6：默认 20 只丧尸压力验收` 通过）。

### 5.2 8 巢穴 / 30 丧尸**中档压力 fixture**（⚠️ 非默认配置）

**30 是 M7 联调压力 fixture，默认上限是 20** —— 用 `ZombieService({maxActive:30})` +
`ZombieRenderer({maxActive:30})` 显式扩容，验证容量可扩展且队列/slot 收敛。

| 指标 | 实测 |
|---|---|
| 蓝图 | 38 项 / critical `[0,5,0]` id=73 |
| 放置 | 8 个全部成功，第 9 个 `limit` |
| 30 只丧尸 | `spawned=30`、`zombieCount=30`、`activeSlots=30`、`meshCapacity=30`（六部件容量随 maxActive 扩） |
| 失效 4 个巢穴后 | `nestCount=4`、`nestControllers=4`、丧尸 slot 不变（`afterSlots === beforeSlots`，无泄漏）、`sceneChildren` 不变 |
| 反复 hydrate ×2 | 索引与 controller **不重复增长**（`nestCount` / `nestControllers` 恒为 4） |
| fps | 120.0 |
| frameP95 | 9.2 ms |
| draw | 536~588（随 seed 与 sections 数浮动；基线场景 ④ 为 530） |
| sections | 1634~1661 |
| **七项队列逐项断言** | `genInflight=0`、`meshInflight=0`、`meshQueued=0`、`pendingMesh=0`、`lightInflight=0`、`lightQueued=0`、`uploadQueue=0` —— **全部为 0** |

### 5.3 `bench --check` 交替对照（CLAUDE.md 要求的口径）

**重要发现**：`frameP95` 在 120Hz vsync 锁帧下是**量子化的**（8.33ms 一档），基线为 9ms，
实测在 **9.6~10.1 之间随机浮动** → 9→10 只差一个量子就报「回退 11%」阻断。

交替对照实测（同会话内 HEAD 与改动交错）：

| 轮次 | HEAD 侧 | 改动侧 |
|---|---|---|
| 第 1 轮 | p95 = 10.1 | p95 = 10 |
| 第 2 轮 | p95 = 9.7 | p95 = 9.9 |

**两侧几乎相同**（差 ≤0.2ms），且 HEAD 侧跑 `--check` 也会时通过时阻断 → 门禁阻断主要是
**采样抖动**，不是改动引入的回退。但 §4.3 的重复坐标换算是**真实回退**（已由 `readCell` 修掉）。

恢复冻结基线后重跑：`bench --check` **通过**（场景 ④ p95 = 9.3）。

> ⚠️ 我诊断时跑过不带 `--check` 的 bench，它会自动重新生成 `docs/m3-baseline.{md,json}`。
> 那是 **M3 冻结基线**，提交它会改变门禁基准 = 静默放宽门禁（p95 基准 9 → 9.9）。
> 已 `git checkout` 恢复，并在恢复后用冻结基线重跑 `--check` 确认通过。

### 5.4 全量 E2E 的 flaky 交替对照

两次全量跑：第一次 84 passed / 2 failed，第二次 85 passed / 1 failed（最终 89 passed / 0 failed）。

- `m1-acceptance` `digP95`：**既有 flaky**（CLAUDE.md / roadmap 已记录，2ms 贴线抖动）。
  单独复跑通过（实测 `digP95=1.8ms < 2ms`）。
- `m3-2-orientation` draw 受控：该断言注释本身就记录了「在完整回归负载下曾概率性失败」。
  **单独复跑 6/6 通过 + 第二次全量通过** → 间歇 flaky。M7 改动不碰 mesher/render/section 划分，
  机制上无关。

**均未改断言、未放宽阈值。**

## 6. 有意偏离 mc-lite（逐项实测读源，非凭字段名推断）

| 偏离 | mc-lite 实测口径 | mc-heavy 口径 | 理由 |
|---|---|---|---|
| ① 失效判定 | **轮询**完整性检查，每 30 帧 `getBlock(criticalBlock)`（`ZombieNest.js:54-70`） | 订阅 M4 `block-changed` **增量事件** | 轮询在主线程是常驻开销且失效有延迟（最多 30 帧）；事件路径零常驻开销、破坏当帧即失效。规格 §1 明令「禁止轮询 mesh」 |
| ② 时间基准 | `Date.now()`（`ZombieNest.js:110`） | `performance.now()`（帧循环 `nowMs`） | CLAUDE.md 活跃约束：两者相差约 17 亿毫秒，混用会让到期判定恒真 → 每帧都刷怪（M6 已实测踩坑） |
| ③ 蓝图校验 | 无校验（只配置 `criticalBlock` 字段） | 「恰一个最高格且是 `gold_block`」否则抛 `invalid-blueprint` | 两个最高格时无法确定唯一锚点 → 失效语义无从谈起；蓝图损坏须显式失败而非静默放错 |
| ④ 放置预检 | 无 bounds/occupied/player-overlap/limit 预检（放置时无这些校验） | 四项预检，顺序 bounds → occupied → player-overlap → limit | 规格 §2 要求原子失败 + 固定 reason；位置合法性先于全局上限（位置非法时报告位置原因更有行动价值） |
| ⑤ 音效路径 | `put.mp3` 在 `src/assets/sound/`（**计划文档写的 `assets/sounds/put.mp3` 路径在上游不存在**） | 从 mc-lite `src/assets/sound/put.mp3` 复制为 `assets/sounds/put.mp3`，经 M4 AudioManager | 实测确认上游真实路径；音频失败只记诊断，**绝不回滚世界事务** |
| ⑥ 放置失败时不消耗物品 | `place()` 成功后才 `inventory.remove('zombie_nest_alias_block', 1)` | 创造模式不消耗（本仓库既有口径：`slot.count` 保持 `DEFAULT_INVENTORY_COUNT`） | 创造模式背包语义（M3.1），与 mc-lite 生存模式扣减不同属有意差异 |

> ⚠️ **本报告原先在偏离表里有一条「alias 不进背包面板」是错的**（我在交付后修复 §4.7 时才发现，
> 该条已删除并重新编号）：`zombie_nest_alias_block` **就在**背包集合 118 项内
> （126 registry − 8 排除，alias 未被排除），玩家从背包面板选中它 —— 与 mc-lite 一致
> （mc-lite 也把它注册进 entityRegistry 且放置成功后 `inventory.remove`）。
> 正确口径见下方「与 mc-lite 一致」段。`bed_alias_block` 则被 `HIDDEN_FROM_INVENTORY`
> 排除，那是 v1.21 的既有口径，与 M7 无关。
> 连带后果：`player.js` 的 `CREATIVE_SPECIALS` 注释也写着「不进背包面板」（同一错前提），
> 已在 §4.8 一并修正。

### 与 mc-lite **一致**（实测读源确认，不是偏离）

- **`destroy` 只删锚点，不清除 38 个结构方块** —— mc-lite 的 `handleNestDestroy`
  （`ZombieNestManager.js:225-245`）实测**只从 ShadowStore 与索引移除**，不清结构方块。
  我的实现与上游一致（结构方块清除是未来 TNT/爆炸 Epic 的职责）。
- **八偏移顺序与六层** —— mc-lite `SPAWN_OFFSETS`（`:13-22`）与
  `SPAWN_SEARCH_HEIGHT:3` / `SPAWN_SEARCH_DEPTH:2`（`:11-12`）逐项一致，`findSpawnPosition`
  （`:144-162`）的「外层偏移 × 内层 dy 降序、首个合法即返回」语义照搬。
- **无论成功/失败/满额都写回 `lastSpawnTime`** —— mc-lite `trySpawnZombie`（`:115-131`）三个
  分支都写回，照搬（否则无合法位置时退化成每帧重试 48 格搜索）。
- **两格空腔 + 脚下 solid** —— `isValidSpawnPosition`（`:169-184`）三判据照搬。
- **`SPAWN_INTERVAL: 8000`** —— 一致。
- **alias 在背包里 + 按物品名路由到实体放置**（交付后修复 §4.7 才对齐）—— mc-lite
  `PlayerInteraction.tryPlaceBlock()`（`:286-296`）在唯一放置路径里判
  `entityRegistry.isSpecialBlock(type)` → 命中则交 `ZombieNestPlacementHandler.place()`，
  否则才走常规单格放置。mc-heavy 照此在 `placeBlock()` 取背包槽后判 `CREATIVE_SPECIALS`。
- **巢穴最低层落在**传入的地面格** —— mc-lite `generateBlocks` 的 `y + block.y - 1`
  （`:100`）与 mc-heavy 的 `origin.y + block.y`（origin = 地面格）等价：两边最低层都落在
  `地面.y + 1`，结构立于地面之上而非悬空。

## 7. 门禁结果

| 门禁 | 结果 |
|---|---|
| `npm run check`（arch + data + lint） | ✅ 全部一致；lint **0 errors**（9 个既有 camelcase warning） |
| `npm run check:arch` | ✅ 架构红线全部守住（12 条，1 项已记录白名单例外） |
| `npm run check:data` | ✅ 数据契约全部一致（**31 个测试文件全部已注册**） |
| `npm test`（全量 Playwright） | ✅ **89 passed / 1 failed**（5.9 分钟）。唯一失败 = `m1-acceptance` 的 `digP95`，**既有 flaky**（CLAUDE.md/roadmap 已记录）：单独复跑通过（`digP95=1.8ms<2ms`），交替对照 3 轮 HEAD 1.7/1.9/1.9 vs 改动 1.7/1.9/1.9 —— **两侧分布相同**，非本次回退。未改断言、未放宽阈值 |
| `tests/zombie-nests.spec.mjs` | ✅ **10 passed / 0 failed**（含交付后补的玩家主路径用例） |
| `npm run bench -- --check` | ✅ 通过（用 HEAD 冻结基线比对；场景 ④ p95 = 9.3） |
| `git diff --check` | ✅ 无空白错误 |
| 浏览器内单测 | ✅ **451 passed / 0 failed** |
| Worker 同构红线 | ✅ `rg -n "blockEntities|restoreEdits" src/workers` **无匹配**（Worker 仍只处理 typed buffer） |

## 8. 交付物清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/entities/zombie-nests/nest-config.js` | 巢穴玩法数据**单一权威**（8 上限 / 8 秒 / 八偏移 / 六层 / alias 名） |
| `src/entities/zombie-nests/nest-blueprint.js` | 只读 JSON → 坐标展开 + 唯一关键格校验（`parseNestBlueprint` 纯函数可测） |
| `src/entities/zombie-nests/zombie-nest-service.js` | 全局索引、四项预检、原子一次事务放置、hydrate/destroy |
| `src/entities/zombie-nests/zombie-nest-controller.js` | 增量失效、8 秒节流刷怪、六层搜索、column 生命周期 |
| `src/tests/test-zombie-nests.js` | 蓝图/持久化/刷怪搜索/事件失效单测（16 条） |
| `tests/zombie-nests.spec.mjs` | 浏览器事务、reload、三种破坏、TNT 等价、压力验收（9 条） |
| `assets/sounds/put.mp3` | 从 mc-lite 复制的放置音效 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/voxel/chunk-column.js` | `restoreEdits()`（有状态重放）/ `setBlockEntity()` / `set()` 的 blockEntity 通道与清理语义 |
| `src/voxel/world-data.js` | `getBlockEntity()` / `readCell()`（一次换算，修 §4.3 回退）/ `setBlock`+`setBlocks` 的 entity 通道与 no-change 归一化 |
| `src/core/world-editor.js` | `setBlockEntity()` / 事件携带 `oldBlockEntity`+`newBlockEntity` / persistence 注入 |
| `src/core/scheduler.js` | `_onGenResult` 接管时调 `restoreEdits`（修 §4.1） |
| `src/save/persistence.js` | flush 保留 `blockEntity` 字段 / `listBlockEntities(kind)`（cursor 扫库） |
| `src/core/game.js` | nests 装配（**时序在 `_waitForColumn` 之前**，修 §4.5）/ hydrate / 全局事件订阅 / column 生命周期接线 / `selectPlaceable` + `audioDebugState` 测试 API |
| `src/player/player.js` | `CREATIVE_SPECIALS` + `selectPlaceable()` + `placeBlock()` 的 alias 分流 + `_placeSpecial()` |
| `src/player/physics.js` | `aabb()`（尺寸派生自 `PLAYER_WIDTH`/`HEIGHT`，避免消费方重算 → 红线 1） |
| `src/render/audio-manager.js` | `SOUND_IDS` 追加 `put` |
| `src/tests/test-chunk-column.js` | `restoreEdits` / blockEntity 清理与替换断言（4 条） |
| `src/tests/test-world-editor.js` | no-change 契约断言（钉住 §4.2 回归点） |

## 9. 未交付项（M7 规格明确的非目标）

| 项 | 状态 | 归属 |
|---|---|---|
| Hotbar 扩展（五格 → 更多格） | 未交付（M7 刻意不改 —— 规格 §2 要求「现有五格 Hotbar 的 UI 和选择语义不变」） | 独立 Epic |
| 完整 TNT / 爆炸 | 未交付（验收以 `setBlocks()` 的 TNT 等价批量变更验证失效） | 独立 Epic（`WorldEditor.setBlocks(batch)` + REMESH + 粒子） |
| 设置面板的巢穴配置项 | 未交付（M7 不实现设置 UI） | 设置面板 Epic |
| 巢穴失效时清除结构方块 | 未交付（与 mc-lite 一致：只删锚点） | 未来 TNT Epic |
| 昼夜自然刷怪 | 未交付（M6 规格 §1 明确无昼夜刷怪） | — |

> ⚠️ **本表原先有一条「完整背包 / Hotbar 扩展 | 未交付」是错的**（2026-09-10 修正）：
> **背包面板已由 M3.1（2026-09-02）交付** —— 1000 槽创造背包面板 `src/ui/inventory.js`，
> 比 M7 早 8 天。这与规格 §2 已标注失效的「当前没有背包 UI」是**同一个过期前提**
> （规格标注了，本表没跟上）。准确口径：**背包面板已存在且玩家能从中选中巢穴图标**
> （M7 正是靠这条主路径放置，见 §4.7）；M7 未做的是**扩展 Hotbar 格数**（刻意不改，
> 见上表）。把两者混成一条会让「M7 未交付背包」读起来像缺陷，实则背包早已可用。

## 10. 后续可复用模式

**「方块锚定装置」的持久锚点 + 派生控制器模式已可供炮塔等方块装置复用**：

- 持久真相 = 某格的 `blockEntity`（经 edits diff 落盘，无需第二份 store）
- 派生 controller 只在 anchor column 已加载时存在，卸载即销毁、重载即恢复
- 失效走 `block-changed` 增量事件（徒手/武器/TNT 同一语义）
- 全局上限经 `listBlockEntities(kind)` 扫库判定（跨卸载与重启有效）
- ⚠️ **装配时序必须在 `_waitForColumn` 之前**（见 §4.5，这是踩坑记录）
