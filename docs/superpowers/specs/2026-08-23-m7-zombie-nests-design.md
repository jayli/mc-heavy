# M7 玩家放置丧尸巢穴设计

**状态：** ✅ 已实施并验收（2026-09-10，验收报告 `docs/m7-zombie-nests-acceptance-report.md`）
**定位：** 第二阶段的方块锚定刷怪器；依赖 M4 `WorldEditor`、M5 实体运行时及 M6 `ZombieService`。
**语义：** 保留 mc-lite：玩家放置、全局最多 8 个、关键顶端方块被破坏即失效。

> **实施记录**：本规格 §1~§3 全部达标（逐项对照见验收报告 §2）。实施中发现并修掉
> **5 个真实缺陷**（含 2 个自己引入的回归、1 个既有存档覆盖 bug、2 个架构/时序缺口）与
> **2 个无效盲区**，详见验收报告 §3~§4。两处与本规格描述的有意实现差异（均实测必需）：
> ① 失效判定除坐标覆盖外还须比对 `newId !== critical.id`（否则巢穴自己的时钟写回会杀掉自己）；
> ② 失效走 `block-changed` 增量事件而非 mc-lite 的轮询完整性检查（规格 §1 本就要求，已落实）。

## 1. 数据权威与生命周期

巢穴不是地形地标，也不是永久运行时实体。`assets/structures/zombie_nest.json` 是只读蓝图；
`zombie_nest_alias_block` 只是玩家触发放置的创造模式物品，不写入巢穴结构。放置成功后，38 个结构方块
经一次 `WorldEditor.setBlocks()` 写入世界；蓝图唯一最高的 `gold_block`（相对原点 `[0,5,0]`）既是 mc-lite
的关键方块，也是承载状态的锚点。其 `blockEntities` 保存唯一持久状态：

```js
{ kind: 'zombie-nest', id, origin: [x, y, z], critical: { x, y, z, id }, lastSpawnAt }
```

`ZombieNestController` 是由已加载锚点重建的派生对象。它索引关键方块坐标并订阅一次
`WorldEditor` 的 `block-changed` 事件；若 change 覆盖关键坐标且 `newId !== critical.id`，在同一事件
处理内删除锚点 blockEntity、注销 controller 与全局索引。徒手、M4 武器和未来 TNT 批量编辑因此走同一
失效语义；禁止轮询 mesh、维护影子方块表或另开破坏路径。

## 2. 放置、刷怪与加载

公开契约统一如下：

```js
nests.place({ origin, playerAabb }); // {ok:boolean, id?:string, reason?:'limit'|'bounds'|'occupied'|'player-overlap'|'invalid-blueprint', anchor?:[x,y,z]}
nests.hydrate();                     // Promise<void>；恢复全局 id/anchor 计数索引
nests.controllers();                 // ReadonlyMap<string, ZombieNestController>（只读测试接口）
nests.destroy(id);                   // boolean；删除锚点、controller 和派生全局索引
zombies.spawn(position, { source }); // string | null；M6 已定义
```

`place()` 在写世界前验证巢穴数小于 8、所有蓝图位置在 world 边界且为空、结构不与玩家 AABB 重叠，且蓝图
恰有一个最高关键方块。结构写入与关键 `gold_block` 上的 blockEntity 必须属于一次 `WorldEditor` 事务；
失败时没有部分方块、anchor 或 controller。`blockEntity` 是持久化编辑的一部分：每个 edits 条目形状为
`{index,id,meta,blockEntity?}`，纯 blockEntity 写入不 bump column version、不触发 remesh/light；方块 id
变更会删去该格旧 blockEntity，除非同一 change 显式给出新的 blockEntity。

GEN 接管 column 后必须调用 `ChunkColumn.restoreEdits(edits)`，使 blocks/meta、`blockEntities` 与内存
`column.edits` 一同重建；不能只 `applyEdits()`。这是持久化正确性的必要修复：否则后续 flush 会以空的
edits Map 覆盖该 column 的旧存档。Worker 仍只收 typed array，不传对象 Map。

“全局最多 8 个”跨 column 卸载和重启仍有效：`Persistence.listBlockEntities('zombie-nest')` 从 edits store
枚举锚点，`nests.hydrate()` 建立仅含 `id/anchor` 的派生全局索引。加载/卸载 callback 只创建或销毁
controller，不增删索引；失效和放置在编辑持久化成功后才更新索引，不能以当前 controller 数量判断上限。

刷怪严格遵循 mc-lite：每 8 秒尝试一次，按以下顺序扫描四个距离 3 的正交偏移，再扫描四个距离 `2√2`
的对角偏移：

```js
[
  {x: 0, z: 3}, {x: 3, z: 0}, {x: 0, z: -3}, {x: -3, z: 0},
  {x: 2, z: 2}, {x: 2, z: -2}, {x: -2, z: 2}, {x: -2, z: -2},
]
```

每个偏移按 `footY = origin.y + 1 + dy`、`dy = 3..-2` 降序尝试，合计**六层**；脚和头必须为空、脚下必须
solid。首个合法位置以 `[baseX + .5, footY, baseZ + .5]` 调用 `ZombieService.spawn(position,{source:nestId})`。
全局丧尸满额或无合法位置仍写回 `lastSpawnAt`，避免每帧重试。column 卸载时销毁 controller 但保留 anchor；
再次加载后从 blockEntity 恢复，`lastSpawnAt` 不重置。

~~当前没有背包 UI~~ **（本条前提已失效）**：本规格写于 2026-08-23，而 M3.1（2026-09-02）已交付
1000 槽创造背包面板（`src/ui/inventory.js`）—— 玩家**能**从背包面板选中物品。这个过时前提导致
交付版只接了 `selectPlaceable()` 测试 API，漏了玩家真实主路径（详见验收报告 §4.7，用户实玩发现）。

**实际实现（交付后修正）**：`zombie_nest_alias_block` 留在背包集合内（与 mc-lite 同口径），
玩家从背包面板选中图标 → 右键 → `Player.placeBlock()` **按物品名路由**到实体放置
（对齐 mc-lite `PlayerInteraction.tryPlaceBlock()` 的 `entityRegistry.isSpecialBlock(type)` 分支），
一次性写入整个 38 方块结构 + 建锚点。`Player.selectPlaceable('zombie_nest_alias_block')` 作为
**受控测试 API** 保留（暴露给 `__MC_GAME__` 供 Playwright 编程驱动），两条路径共用
`_placeSpecial()`。现有五格 Hotbar 的 UI 和选择语义不变。M7 从 mc-lite 复制 `put.mp3` 至
`assets/sounds/put.mp3`，经 M4 `AudioManager` 在成功放置后播放；AudioContext 仍由已有用户手势
resume，声音加载/播放失败只记录诊断，绝不回滚世界事务。

M7 不实现完整 TNT Epic；验收以 `WorldEditor.setBlocks()` 的 TNT 等价批量变更验证失效事件。未来 TNT/爆炸
只能调用该入口，无需为巢穴增加专属兼容路径。

## 3. 验收

- 放置 8 个成功，第 9 个无任何世界写入；结构碰撞、越界、玩家重叠、无唯一关键方块均原子失败。
- 最小创造模式选择 API 能触发放置，成功后尝试播放 `put`；M7 不宣称已实现背包或扩展 Hotbar。
- 关键方块被徒手、武器或 TNT 批量破坏后 controller 立刻注销，锚点/索引删除；卸载/重载不会复活。
- 8 秒节流、八个精确偏移、六层搜索、两格空腔和 solid 支撑口径固定；全局丧尸上限拒绝时不产生实体，
  但仍更新 `lastSpawnAt`。
- GEN 接管后对已有 blockEntity column 再编辑并 `flushNow()`，重启仍保留旧 edits 与 anchor；重启与
  column 卸载后每个锚点只恢复一个 controller，scene 和 entity count 不重复增长。
- 默认 20 丧尸上限下无过期 Worker 回写或渲染 slot 泄漏；若以 8 巢穴/30 丧尸作联调压力 fixture，报告
  必须标注该 fixture 使用未来中档上限而非默认值。
