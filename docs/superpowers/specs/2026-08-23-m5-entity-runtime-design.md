# M5 实体运行时设计

**状态：** 已实施、已验收（2026-09-07；验收报告 `docs/m5-entity-runtime-acceptance-report.md`）
**定位：** 第二阶段的动态实体底座；依赖 M4 的 `WorldEditor` 事件，但不交付炮塔、矿车、丧尸或巢穴玩法。
**关联：** `docs/phase-1-engine-design.md` §4.5.2、§4.8、§9；后续 M6 丧尸、M7 丧尸巢穴。

## 1. 目标与边界

M5 交付可管理、可查询、可渲染、可卸载/恢复的运行时实体底座。`EntityManager` 是动态实体
state 的唯一权威；体素世界仍只有 `blocks + meta + blockEntities` 一份权威。M5 不创建任何具体
敌人、飞行弹丸、轨道或方块结构，避免把这些玩法耦合进首个实体任务。

实体分两类：

- **临时实体**（例如 M6 丧尸）不写 `entities` store；它所在 column 被 Scheduler 以“加载半径 + 2”
  的既有滞回规则**最终卸载**前销毁。实体越过 column 边界时只更新派生 column 索引；不以“距离玩家多少
  格”作另一套生命周期真相。这个随流式世界卸载而销毁的规则是相对 mc-lite 的有意架构调整。
- **持久实体**（未来炮塔/矿车）用 `Persistence` 的独立 `entities` object store 保存最小 JSON
  snapshot；超出卸载半径时走“可取消的异步保存准备 → 同步最终卸载”两阶段流程，只有 snapshot 成功
  写盘后才能删除 world column，重入加载半径时仅恢复一次。

方块锚定装置的结构和持久配置一律留在 `blockEntities`；实体管理器只持有由锚点重建的运行时
controller，绝不复制方块状态。

## 2. 架构与公开契约

`src/entities/entity-manager.js` 维护 `Map<id, entity>`、由 `position` 派生的 column 索引和类型注册表。
类型定义和 state 均没有 DOM/three 依赖；渲染层只消费只读 pose。

```js
manager.registerType(type, definition); // 重复 type 抛错；definition 无 three
manager.spawn({ id, type, state, persistent = false }); // Entity | null
manager.despawn(id, reason); // boolean
manager.get(id); // Readonly<Entity> | null（测试查询；调用方不得写回）
manager.count(type); // number
manager.entities(); // Iterable<Readonly<Entity>>；仅供渲染层枚举
manager.entitiesInColumn(columnKey); // Iterable<Readonly<Entity>>；卸载协调只读查询
manager.update(dt, context);
manager.despawnColumn(columnKey, 'column-unloaded'); // 临时实体；Scheduler 最终卸载前调用
manager.beginColumnUnload(columnKey);
// { snapshots: Array<{id,type,state}>, commit(): number, cancel(): void }
// 持久实体在 begin 到 commit/cancel 之间冻结；commit 回收该 column 的运行时实体
manager.applyAsyncPose({id, generation, position}); // boolean；过期回包返回 false
manager.raycast(origin, dir, maxDist, predicate); // null | {id,type,dist,point}
manager.serializePersistent(); // Array<{id,type,state}>
manager.restorePersistent(snapshots); // 只恢复已注册、可反序列化且未存在的 snapshot
```

`definition` 只提供纯函数 `create`、`update`、`raycastAabb`、`serialize`、`deserialize`。`generation`
随同一 id 的每次成功 spawn 单调递增；任何后续异步消费者必须回传 `{id,generation}`，manager 查不到
实体或 generation 不符即丢弃。空间索引、generation 表和渲染 slot 均是从唯一实体 state 派生的缓存，
不得成为第二份逻辑真相。

`src/render/entity-render-layer.js` 可为每种 type 注册一个受控 render node 或实例池：

```js
layer.register(type, { createNode, applyPose, disposeNode });
layer.sync(manager.entities());
layer.dispose();
```

它不得调用 `world.setBlock`、执行碰撞或以 three mesh 作为命中真相。实体与地形相交/碰撞查询仍走
`world.isSolid()`；地形射线仍只用 `raycastVoxel()`，实体 AABB 命中只由 `EntityManager.raycast()` 给出。

`Game` 的一帧顺序固定为 `player.update → entities.update → scheduler.update → entityLayer.sync → render`。
Scheduler 为流式卸载提供两个阶段的生命周期契约：

```js
scheduler.onColumnUnloadRequested((key, column) => ({
  ready: Promise<void>, // 成功保存/冻结准备完成；reject 表示本次卸载失败
  commit() {},          // 仅在仍超出卸载半径、同步最终删除前调用
  cancel() {},          // 玩家重入或 ready reject 时恢复运行时状态
})); // 返回 unsubscribe
scheduler.onColumnWillRemove((key, column) => {}); // 只在 ready 成功后同步调用；返回值不等待
```

Scheduler 发现 column 超过“加载半径 + 2”时先登记 `_pendingColumnUnloads`；它只保存 key、Column 引用和
卸载 handle 的生命周期状态，不复制 blocks/meta/light，也不参与游戏逻辑。`Game` 的 requested listener 调
`manager.beginColumnUnload(key)`：其中的持久实体立即冻结、从冻结 state 取得 snapshot，并以
`Persistence.saveEntities(snapshots)` 作为 `ready`；临时实体在准备期间仍保留。Promise 成功后的**下一帧**，
若该 column 仍在卸载半径外，Scheduler 依次同步广播 `onColumnWillRemove`、调用每个 handle 的 `commit()`，
再 `world.remove()`、删除 render column 和清理调度派生队列。`commit()` 使 manager 先失效 generation，随后
回收冻结的持久实体及仍在该 column 的临时实体。

若玩家在保存期间回到范围内，Scheduler 调用 `cancel()` 并删除 pending 记录，持久实体解冻；已经完成的
IndexedDB 写入可保留，之后的状态变化/页面 flush 会覆盖它。若 `ready` reject，Scheduler 也调用 `cancel()`、
保留 column/world/render 与实体、记录可诊断错误，并在后续正常卸载周期重试；不得静默删除。最终
`onColumnWillRemove` 只负责释放 controller 等派生对象，不保存 column 副本，也不得返回异步工作。

## 3. 持久化、卸载与错误处理

`Persistence` 将 DB schema 升至 v2，新增 `entities` object store，snapshot 形状严格为
`{id,type,state}`。只在持久实体创建、销毁、显式状态变化或页面隐藏时异步 flush；不得扫描整世界。一次
column 卸载的 snapshot 必须来自 `beginColumnUnload()` 已冻结的 state，作为 Scheduler 的 `ready` Promise；
成功后才允许下一帧的同步最终回收。column ready 时按 `state.position` 过滤保存 snapshot 并只恢复该 column
的缺失 id。保存失败或玩家重入均取消本次最终回收，不能静默丢失。

- 未注册类型、重复 id、非法 state、反序列化失败的 snapshot：返回 `null` / 忽略该条，并且不产生
  scene、store 或部分恢复副作用。
- 临时实体卸载、死亡或 `dispose()`：必须先取消/失效其 generation，再从 manager 与 render layer 对称
  回收；不能留下 snapshot。
- 持久实体卸载：`beginColumnUnload()` 后冻结并写入当前最小 snapshot；只有 `ready` 成功、column 仍在
  卸载半径外才 `commit()`。写入失败或重入范围必须 `cancel()`、保留运行时实体并报告失败，不能静默丢失；
  同一 snapshot 只有在其 position 所属 column ready 时恢复一次。

M5 不新建 Worker。M6 的 AI 只能作为既有 WorkerPool 的一种统一 RPC 接入；manager 自己不承担 AI、
寻路或投射物计算。

## 4. 验收

- 同 id 不能重复 spawn；类型未注册、无效 snapshot 和已销毁实体均不产生渲染或持久化副作用。
- Probe fixture 可被 spawn、按 AABB 被 raycast；地形命中仍由 `raycastVoxel()` 决定。
- Scheduler 对 probe 所在 column 先完成可取消的持久 snapshot 保存，成功后的下一帧才同步回收临时/持久
  probe；保存期间重入会取消并恢复持久 probe，保存失败保留该 column；最终卸载后持久 probe 在重入时恰恢复一次。
- 迟到的 `{id,generation}` 结果不能改变已 despawn 或同 id 后续实例；`dispose()` 后 scene 无实体节点、
  renderer layer 无活动 instance、entities store 无悬挂 snapshot。
- 视距 8 空闲时相对 M3 冻结基线的性能回退不超过 10%。
