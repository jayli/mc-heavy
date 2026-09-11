# M8 TNT 爆炸 / 炮塔弹丸设计

**状态：** 📝 待实施（起草 2026-09-11）
**定位：** 第三阶段第一个 Epic。两个功能均为 mc-lite 已有玩法，在 mc-heavy 用 M4~M7 建立的底座重做：
`WorldEditor` 批量编辑（M4）、`EntityManager` + 实体 raycast（M5）、`ZombieService.damage()`（M6）、
方块锚定装置模式（M7）。
**语义：** 保留 mc-lite 的玩法数值与手感；架构按本仓库红线重写（见各节的「有意偏离」表）。

> **依赖关系**：TNT 与炮塔之间无硬依赖。建议顺序：§1（共同前置）→ §2（TNT）→ §3~§5（炮塔三层）。
>
> ⚠️ **创造台已拆到 M9**（`docs/superpowers/specs/2026-09-11-m9-playground-design.md`）。
> 拆分理由：TNT + 炮塔链（装置层 → AI → 渲染 → 弹丸）已是四个严格串行的子任务，加上创造台
> 会让单个 Epic 过重。创造台与 TNT/炮塔无硬依赖，唯一交集是 §1 的 `indestructible` 数据权威
> —— M8 交付该表（只登记 `bedrock`），M9 复用并追加创造台两项。

## 1. 不可破坏方块的数据权威（共同前置）

mc-lite 用**两处字面量**表达同一件事：`ExplosionWorker.js:6` 的
`INDESTRUCTIBLE_BLOCKS = ['playground_block', 'playground_center_block', 'bedrock', 'barrier']`，
以及 `BlockData.js:244/252` 的 `isIndestructible: true` 字段（注释「不可被 TNT、机枪或玩家破坏」）。
两处漂移会产出「TNT 炸得掉但玩家挖不掉」或反之的撕裂语义。本仓库按红线 1 收敛成**单一权威**：

- `blocks-data.js` 每条声明新增可选字段 `indestructible: true`（缺省 false）。
  ⚠️ **M8 只登记一项**：`bedrock`（TNT 爆炸过滤需要）。
  **`playground_block` / `playground_center_block` 两项移交 M9** —— 理由见下方 ⚠️。
  **不含 mc-lite 清单里的 `barrier`** —— 该方块在本仓 registry 里**不存在**
  （`blocks-data.js` 实测无此条目，它对应的是 mc-lite 的 `collider` 系碰撞体方块）；
  照搬会登记一个不存在的名字 → 门控静默失效，且 `check:data` 的名字存在性断言会报。
  `collider`/`realistic_trunk_collider` 已在 `NON_PLACEABLE_ITEMS` 里（不可放置 → 世界内
  不会出现玩家放的实例），**不登记进本表**：那是「不进背包」的事实，不是「不可破坏」的事实
  （两个集合语义互斥，勿混为一处，同 CLAUDE.md 对 `NON_PLACEABLE_ITEMS` 的既有口径）；
- `block-registry.js` 新增 `indestructibleTable`（`Uint8Array(MAX_BLOCKS)`），与既有
  `solidTable`/`opaqueTable`/`cullTable` 同一手法，主线程与 Worker 同构可用；
- **三个消费者全部读这张表**，不得各写字面量数组：① `Player.digBlock()` 的挖块门控；
  ② `weapon-controller` 的可选方块破坏门控（与既有 `canGunsDestroyBlocks` 开关叠加）；
  ③ §2 的爆炸破坏过滤。

`bedrock` 已由 `WorldEditor.setBlock/setBlocks` 的 `reason:'bedrock'` 门控兜住（写不进去），
登记进本表是**语义对齐**而非新增防护 —— 让「哪些方块不可破坏」只有一个查询入口。
本表不改变 `blocks-data.js` 的既有字段，不新增第二份方块清单。

⚠️ **创造台两项为何不在 M8 登记**（移交 M9 的理由，实测分析）：
`indestructible` 的登记与「移出背包」**必须成对做**。M8 期间若只登记 `indestructible`
而不移出背包，会立刻产出撕裂状态 —— 玩家在背包里选得到这两项（当前未被任何排除集合排除），
放得出来但挖不掉、TNT 也炸不掉（只能靠「关闭创造台」批量删，而 M8 没有创造台功能）。
反过来，若两项都不登记也不移出（M8 的现状）则**无害**：玩家放得出来也挖得掉。
故两项一起留在 M9（**M9 规格 §1.2** 的移出背包 + §1.1 的登记 indestructible 同任务完成），M8 不碰。

⚠️ **测试落点**：属 Tier 1（静默的数据错误 —— 炸掉了不该炸的方块，肉眼玩不出来）。
断言须落在**三个消费者同时生效**处：注入「`digBlock` 改回字面量清单」须真 FAIL；
且须在临界值附近断言（`indestructible=false` 的方块必须可破坏，不能把整表当恒真判据）。
`check:data` 新增 `[不可破坏]` 环节：表里每个名字都在 registry 内（拼错则门控静默失效）。

## 2. TNT 引爆与爆炸

`tnt` 方块**已在 registry 与 atlas 内**（`tnt_side` / `tnt_top` 贴图与 faces-data 映射齐全），
M8 只补引爆与爆炸逻辑，不动方块声明与贴图。

### 2.1 爆炸计算：同构纯函数，不走 Worker

mc-lite 用独立的 `ExplosionWorker.js` 算爆炸范围。本仓库**改为同构纯函数**
`src/voxel/explosion.js` 的 `computeExplosion({ world, registry, center })`：

```js
computeExplosion(...) → {
  center: [x, y, z],
  destroy: Array<{x, y, z}>,        // 3×3×3，过滤掉 indestructibleTable 命中项
  chain: Array<{x, y, z, delayMs}>, // 5×5×5 内的其他 tnt，delay = 500 + 确定性抖动 ∈ [500, 1100]
}
```

**为什么不下 Worker**（红线 3 的边界判定，须在验收报告里说明）：计算量 = 27 + 125 = **152 次
`getBlockId`**（3×3×3 破坏 + 5×5×5 连锁搜索），比 M7 放置 38 格结构还轻，且爆炸的方块破坏、
音效、特效必须**同帧**发生 —— 走 Worker 要等回包，玩家会先看到方块消失再听到爆炸声。
红线 3 禁的是「全量 meshing/AO/结构布局」这类主线程重计算，不含此类交互级查询。
函数本体无 DOM、无 three 依赖（`npm run check:arch` 静态门守），故浏览器内单测可直接调它。

**归属 `src/voxel/` 而非 `src/gen/`**：它的输入只有 `WorldData.getBlockId()` 与 registry 的
两张 typed 表（`indestructibleTable` + tnt 的 id），是纯**体素层查询**；`src/gen/` 的职责是
「地形与结构生成（Worker 侧）」（设计文档 §4.2），爆炸不是生成。放 voxel 层还有个附带好处：
它是分层图的最底层（`voxel ← gen ← mesh ← render`），`player/`、`core/`、`entities/`
三个消费者都能 import 而不触发依赖方向门（`check-architecture.mjs` 的 §3 规则）。

**连锁延迟用确定性抖动而非 `Math.random()`**（mc-lite 是 `500 + Math.random() * 600`）：
红线 2 要求同 seed 两次生成一致；用 `center` 坐标派生的散列（照 M6 排斥力 tie-break 的
黄金角散列手法）产出 `[500, 1100]` 内的延迟，效果等价且可测。

### 2.2 引爆入口与连锁

两条引爆路径，对齐 mc-lite 的两个入口（`PlayerInteraction.js:172` ctrl+左键、`:1048` 枪击命中）：

1. **左键挖块路径**：`Player.digBlock()` 命中方块 id === `tnt` 时不挖块，改为引爆；
2. **枪械命中路径**：`weapon-controller` 的体素命中判定到 `tnt` 时引爆（不消耗弹药以外的状态）。

两条路径都经**同一个去重集合**（`Player.ignitingTnt: Set<'x,y,z'>`），防止连锁回环把同一格
引爆两次（mc-lite 用 `player.ignitingTNTs` 同手法）。引爆顺序固定：① 记入去重集合 →
② `computeExplosion()` → ③ `editor.setBlock({x,y,z,id:0})` 移除引爆格自身 →
④ 提交破坏事务 → ⑤ 入队连锁定时引爆 → ⑥ 音效与特效。

**破坏写入走一次 `editor.setBlocks()` 事务**（roadmap 指定的 TNT 接入点：
`WorldEditor.setBlocks(batch)` + REMESH + 粒子）。它已是「每 column 只 bump 一次版本 +
统一转 Worker REMESH + 受影响 column 入异步 light 队列」的批量入口，不得为爆炸另开路径。
连锁引爆在 `Game` 帧循环里按 `performance.now()` 到期判定推进 —— **禁止 `Date.now()`**
（CLAUDE.md 活跃约束：两者相差约 17 亿毫秒，混用会让到期判定恒真 → 连锁立即全炸）。

### 2.3 破坏开关与实体伤害

`canTntDestroyBlocks` **默认 `false`**（mc-lite `Game.js` 实测同口径：初始化为 `false`，
即默认只伤害 + 连锁、不动地形）。开关进设置面板，与既有「枪械破坏」共用合并盒一行
（CLAUDE.md 活跃约束：两组两按钮档位优先用合并盒共用一行；面板新配置往右列填）。
字段随既有 settings 持久化 + `?tntDamage=` URL 可达，与 `volume` 同手法。

爆炸对丧尸的伤害：半径 **4 格**、伤害 **50**（mc-lite `PlayerInteraction.js:629-630` 实测值），
距离度量用丧尸 AABB 中心（mc-lite 用 `position.y + height/2`）。经
`ZombieService.damage(id, 50, nowMs)` —— M6 已实现红闪 + health ≤ 0 即 despawn，**不另写伤害路径**。
半径判定枚举 `zombies` 的活动实体（`ZombieService` 的 slot 表是单一权威），不扫
`EntityManager` 的全量集合（那会把未来其它实体类型也炸伤）。

### 2.4 爆炸视觉与音效

mc-lite 有 `ParticleSystem` + 球体扩张池两层。mc-heavy **没有粒子系统**，只移植球体扩张层：
固定 slot 的 `InstancedMesh`（照 `tracer-renderer.js` 手法 —— 独立短寿命视觉对象、池满丢弃最旧、
`dispose` 释放材质），扩张 0.3 秒至 targetScale 5.0、`opacity` 1→0（mc-lite
`World.js:1301-1311` 数值照搬）。⚠️ **无活跃实例时 `visible=false`**（CLAUDE.md 活跃约束：
InstancedMesh 构造期 count 即容量，恒增 1 个 draw call —— M6 实测六部件 mesh 让 bench 场景 ④
draw 530→536）。

音效：`assets/sounds/explosion.mp3` 从 mc-lite 拷入，加进 `AudioManager` 的 `SOUND_IDS`
catalog（音量 0.4，mc-lite 同口径）。`turret_gun_fire.mp3` 同批拷入供 §5 使用。

### 2.5 有意偏离 mc-lite

| # | mc-lite | mc-heavy | 理由 |
|---|---|---|---|
| ① | 独立 `ExplosionWorker` | 主线程同构纯函数 | 计算量 152 次查询，比 M7 放 38 格还轻；爆炸须与音效/特效同帧。见 §2.1 |
| ② | Raycaster 命中 mesh 判定 TNT（`hit.object.userData.type`） | DDA 命中方块的 `blockPos` | 红线 6：地形交互一律体素 DDA，禁止 `Raycaster.intersectObjects` |
| ③ | `INDESTRUCTIBLE_BLOCKS` 字面量 + `isIndestructible` 两处 | registry `indestructibleTable` 单表 | 红线 1。见 §1 |
| ④ | 连锁延迟 `Math.random()` | center 坐标派生确定性抖动 | 红线 2：同 seed 两次生成须一致 |
| ⑤ | 矿车销毁分支（`:645-670`） | 不实现 | 矿车是后续 Epic，mc-heavy 尚无该实体类型 |

## 3. 炮塔装置层（M7 模式复用）

炮塔是**方块锚定的持久装置**，直接套用 roadmap「M7 交付的可复用模式」，不另开持久化路径。

### 3.1 结构与锚点

结构照搬 mc-lite `TurretPlacementHandler.place()`：**3×3 `iron_ore` 底座**（y=origin.y）+
中心两格 **`obsidian`** 柱（y+1、y+2），合计 **11 格**。锚点 = 唯一最高的 obsidian 上格
（`[origin.x, origin.y+2, origin.z]`），承载唯一持久状态：

```js
{ kind: 'turret', id, origin: [x,y,z], critical: {x,y,z,id}, rotation, lastFireAt }
```

`rotation` = 放置时的默认朝向（无目标时回归它），派生自玩家相对炮塔的方向、取最近的四方向之一
（mc-lite `DIRECTIONS` 的 NORTH/EAST/SOUTH/WEST 语义照搬）。⚠️ **这不是「方块放置朝向不看玩家
yaw」那条约束的反例** —— 那条说的是**单格方块**的 meta 朝向（M3.2 三分支），炮塔的默认朝向是
装置运行态、存在 blockEntity 里，两者不是同一事实。

放置走**一次 `editor.setBlocks()` 事务**（11 格 + 锚点富状态同批），失败时没有部分方块、没有
anchor、没有索引条目。预检顺序照 M7：`bounds` → `occupied` → `player-overlap` → `limit`
（位置合法性先于全局上限，理由见 M7 规格 §2）。⚠️ **origin = 命中方块 `blockPos`，不是
`prevPos`**（CLAUDE.md 活跃约束：底座最低层要落在玩家脚下的地面格上；两条放置路径的 origin
语义必须一致）。

### 3.2 失效与上限

失效走 `block-changed` **增量事件**，判据 = 坐标覆盖关键格且 **`newId !== critical.id`**
（M7 同口径：装置每次开火都用 `setBlockEntity` 写回 `lastFireAt`，只看坐标覆盖会被自己的
时钟写回杀掉）。**不轮询完整性** —— mc-lite 是每 30 帧轮询 `checkIntegrity()`
（`Turret.js:398-430`），本仓库改走事件：轮询在主线程是常驻开销且失效有延迟（M7 规格 §1 已定）。

全局上限 **20**（mc-lite `TurretManager.maxTurrets`），经 `Persistence.listBlockEntities('turret')`
扫库判定 —— **不能用已加载 controller 数量**（远处炮塔的 column 可能未加载 → 玩家走远再回来
就能无限放置）。⚠️ hydrate 是 `clear()+重建`：调用前必须先 `flushNow()`。

`setBlockEntity` 必须构造**新对象**（不得原地改 anchor —— `column.blockEntities` 与
`column.edits` 持有同一引用，原地改会让两处状态看似独立实则共享）。

### 3.3 公开契约

```js
turrets.place({ origin, playerAabb }); // {ok, id?, reason?:'limit'|'bounds'|'occupied'|'player-overlap', anchor?}
turrets.hydrate(persistence);          // Promise<void>；恢复全局 id/anchor 索引
turrets.controllers();                 // ReadonlyMap<string, TurretController>（只读测试接口）
turrets.destroy(id);                   // boolean
```

### 3.4 背包放置分流

`turret_alias_block` **已在背包集合 118 项内**（与 mc-lite 同口径）。玩家从背包选中它的图标后
右键走的是 `placeBlock()` 的常规单格 `editor.setBlock` 路径 → 只放出一个贴了图案的正方体
（M7 实玩发现的同类缺陷）。修法 = 把 `turret_alias_block` 加进 `player.js` 的
`CREATIVE_SPECIALS`，命中则调装置放置并 `return`，**不回落到单格放置**。

连带两件事（CLAUDE.md 已记的口径）：① 加进 `tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`
并跑 `npm run icons` —— 它代表整个 11 格结构，立方体等轴测图是错的表达（mc-lite
`ItemIconUtils.getCustomIconPath()` 把 `turret_alias_block` 映射到手工图 `turret.png`，
绕过立方体生成）；② ⚠️ **测试须走背包选中路径**而非只走测试 API（M7 的 E2E 当时全绿却漏了
这个缺陷，见 M7 验收报告 §3.7）。

### 3.5 接线时序

controller 接线必须在 `_waitForColumn` **之前**（CLAUDE.md 活跃约束：出生点 column 在
`_waitForColumn` 时 ready、`onColumnReady` 随之触发；若服务创建在其后，回调跑时它还是 null →
第一行直接 return → reload 后 anchor 与索引都恢复了但 controller 恒为 0）。对照 `this.zombies`
与 `this.nests`：都装配在 `_waitForColumn` 之前。

另需「放置成功即建 controller」的 `onPlaced` 回调（anchor column 此刻已加载，`onColumnReady`
早在放置前触发过了，不会再为新锚点触发一次）。

⚠️ **column 卸载回收顺序：先玩法服务、再 M5 commit**（`unload.commit()` 内部调
`entities.despawnColumn()` 会绕过玩法服务）。炮塔本身不是实体（装置 controller 不进
EntityManager），但其弹丸是 —— 见 §5.3 的回收路径。

## 4. 炮塔 AI（同构纯函数，主线程执行）

### 4.1 为什么**留在主线程**（起草时的方案已推翻）

mc-lite 在主线程每帧跑 LOS 采样（`hasLineOfSightToEnemy`：50 格范围 ÷ 0.5 步长 = 最多 100 次
`getBlock` 调用 × 每炮塔 × 每帧），靠 `TARGET_LOS_RECHECK_INTERVAL=100ms` 降频兜住。

**起草时打算把它搬进 Worker（`turret-ai` 分支），实测事实推翻了这个方案**。索敌必须做 LOS
判定，而 LOS 必须读方块 —— 但 **Worker 内没有持久世界数据**：`world-worker.js:178` 明确写
「worker 里没有世界数据，也不该有」，每个 GEN/MESH/LIGHT 任务都临时 `new WorldData(registry)`
再 `world.add(column)` 用完即弃。三个选项的实测对比：

| 选项 | 代价 | 判定 |
|---|---|---|
| ① LOS 留在主线程（同构纯函数） | 20 炮塔 × 8Hz × 最坏 20 丧尸 × 100 采样 = 每秒约 32 万次 **O(1) typed-array 读**，摊到每帧约 5300 次（≈0.002ms） | ✅ **采用** |
| ② 传局部体素 view 给 Worker | 每 RPC 20 column × 64KB = **1.28MB**，8Hz → **每秒 10MB 结构化克隆**；且 M6 的 `ai` 分支明确「不传局部体素 view」 | ❌ 传输开销远超计算本身 |
| ③ Worker 内持久化一份世界数据 | 引入**第二份体素权威** | ❌ 直接违反红线 1 |

故炮塔 AI 抽成同构纯函数 `computeTurretUpdates()`（`src/entities/turrets/turret-system.js`），
**在主线程执行**，不新增 Worker 分支。它仍是无 DOM、无 three 的纯函数（`check:arch` 守），
故浏览器内单测可直接调 —— 与「worker 消费共享纯函数」的红线 8 目的（可测性）一致，
只是执行侧不同。

⚠️ **这是红线 3 的第二个边界判定例外**（第一个是 §2.1 的爆炸计算），须在验收报告与设计文档
§4.5 说明理由：LOS 依赖世界数据，而世界数据的唯一权威在主线程（红线 1）—— 把计算搬去
Worker 就必须把数据也搬去，那是更大的红线违规。红线 3 禁的是「全量 meshing/AO/结构布局」
这类**可后台化**的重计算；LOS 不是（它的数据源不可后台化）。

**成本兜底**：索敌降频到 **8Hz**（`TURRET.aiPeriodMs=125`，对齐 mc-lite 的
`TARGET_REACQUIRE_INTERVAL=120ms`），且只对「距 pivot ≤ 检测范围」的丧尸做 LOS
（mc-lite `findTarget` 同口径：先 `distSq` 粗筛再 LOS）。验收须实测最坏情况
（20 炮塔 × 20 丧尸）的单帧开销并记进报告。

### 4.2 数值口径（逐项对齐 mc-lite `TURRET_CONFIG`）

| 参数 | 值 | mc-lite 出处 |
|---|---|---|
| 检测范围 | 50 格 | `DETECTION_RANGE` |
| 旋转速度 | π/2 弧度/秒 | `ROTATION_SPEED` |
| 俯仰速度 | π/3 弧度/秒 | `PITCH_SPEED` |
| 开火冷却 | 500ms | `FIRE_COOLDOWN` |
| 射击角度阈值 | 0.26 弧度（≈15°） | `FIRE_ANGLE_THRESHOLD` |
| 最大俯仰角 | π/4（±45°） | `MAX_PITCH_ANGLE` |
| 瞄准点 Y 偏移 | 1.2（丧尸胸部） | `ENEMY_BODY_OFFSET_Y` |
| LOS 采样步长 | 0.5 格 | `LOS_SAMPLE_STEP` |
| 目标重选间隔 | 120ms | `TARGET_REACQUIRE_INTERVAL` |
| 弹丸速度 | 40 格/秒 | `PROJECTILE_SPEED` |
| 弹丸最大飞行距离 | 50 格 | `MAX_KILL_DISTANCE` |

⚠️ **单位换算须核对**：mc-lite 的 `ROTATION_SPEED`/`PITCH_SPEED`/`PROJECTILE_SPEED` 都乘
`deltaTime`（`Turret.js:637`、`Projectile.js:89`），即**已是格/秒与弧度/秒** —— 与
`ZOMBIE.speed` 那种「格/帧须 ×60」的情况不同（`Zombie.js` 的 `predictNextPosition` 不乘 dt）。
**逐项核对后照搬，不做 ×60 换算**；验收时须 A/B 对照实测（这类缺陷肉眼难辨：炮塔照常转、
弹丸照常飞，只是速度不对）。

### 4.3 分工

纯函数只算**意图**，controller 做视觉插值与节流：

- `computeTurretUpdates()`：目标选择（最近 + LOS 可见）、`targetYaw`/`targetPitch`；
- 主线程：朝向平滑插值（限角速度）、开火节流、弹丸发射、渲染发布。

返回形状 `{updates: Array<{id, targetYaw, targetPitch}>}`（**无 `generation`** —— 不走 RPC，
故红线 7 的版本协议不适用；同步调用不存在迟到回包）。AI 周期 **8Hz**（≈125ms，对齐
mc-lite 的 `TARGET_REACQUIRE_INTERVAL=120ms`），批次只含「anchor column 已加载」的炮塔。

⚠️ **`WorkerPool.call()` 返回 `{id, promise}` 那条活跃约束在本任务不适用**（不走 RPC），
但若后续把炮塔 AI 改成 Worker 任务（例如世界数据可后台化之后），它立刻生效。

### 4.4 朝向插值与时间基准

主线程插值用 `shortestAngleDiff` + 限角速度（mc-lite `updateRotation` 语义照搬），
`normalizeAngle` 收敛到 `[-π, π)`。⚠️ **从实例矩阵反解旋转必须用
`atan2(elements[8], elements[0])`**（CLAUDE.md 活跃约束：three 的 Euler 'XYZ' 序对 Y 轴用
`asin(m13)`，`asin(sin θ)` 在 `|θ| > π/2` 时折叠回 `[-π/2, π/2]`）。测试取值须至少一个落在
折叠区（如 yaw=2.48），只在 `[-π/2, π/2]` 内取值会侥幸通过。

时间基准统一 `performance.now()`（帧循环 `setAnimationLoop` 回调的 `nowMs`），禁止 `Date.now()`
—— 开火冷却判定 `nowMs - lastFireAt < 500` 若混用会恒真或恒假。mc-lite 用 `Date.now()`
（`Turret.js:669`），本仓库按自身口径改为 performance 基准。

## 5. 炮塔渲染与弹丸

### 5.1 炮塔渲染：单纹理 UV 分区 + 部件实例池

mc-lite 用 **8 个部件 mesh + 材质数组 + 三张装甲贴图**（`Turret.js:47-80`：
`turret_pic1.jpeg` 正面 / `turret_pic2.jpg` 侧面 / `turret_pic3.jpg` 顶面与背面）。
**WebGPU 后端不支持「InstancedMesh + 材质数组 + `geometry.groups`」**（CLAUDE.md 活跃约束，
M6 实测：`three.webgpu.js:34592` `getMaterial()` 直接 `return material`，不遍历 groups、
不取 `materialIndex` → 六面恒用 `material[0]`，静默只渲染第一张）。

故改走 M6 丧尸头部验证过的替代方案：**单材质 + 单纹理 + UV 分区**。

- `tools/bake-turret-armor.mjs`（`npm run turret`）把 mc-lite 的三张装甲贴图烘焙成**一张多区
  横向并排**纹理（正面区 / 侧面区 / 顶面区），写进 `assets/turret/armor.png` + 伴随
  `armor.json`（参数与指纹）。⚠️ **不能用上下分区**（会把图案压成 N×(N/2) → 比例失真）；
  ⚠️ **三张源贴图须先从 mc-lite 拷入本仓**（`src/assets/turret/turret_pic1.jpeg` 259×194 /
  `turret_pic2.jpg` 100×75 / `turret_pic3.jpg` 100×67，均为 RGB 无 alpha）—— 本仓
  `assets/textures/` 只有 `turret.png`（那张是 mc-lite `ItemIconUtils` 的**背包手工图标**，
  不是装甲贴图，两者用途不同勿混）。烘焙产物尺寸须在指纹里钉住（照丧尸头部 128×64 手法）；
- `tools/turret-armor-fingerprint.mjs` = 参数与指纹的**单一权威**，烘焙脚本与门禁共用
  （红线 1：两处漂移会误判）。指纹逻辑照 `zombie-head-fingerprint.mjs` 手法；
- 几何的每个部件按归属改写 UV 到对应区（照 `zombie-renderer.js` 的 `applyHeadUV`）。

⚠️ **跨面 UV 换算不能用同一套公式**（CLAUDE.md 活跃约束：`BoxGeometry` 各面的 `buildPlane`
`vdir` 符号不同 —— 正面/侧面 `-1`、顶面 `+1`）。跨面取样须用**纹理坐标**作统一参数。

**渲染层 = 每部件一个固定容量 `InstancedMesh`**（8 个部件 × 容量 20），照 M6 六部件手法：
每实例矩阵由 `T(pivot) × R_y(yaw) × R_x(-pitch) × 部件局部变换` 合成 —— 等价 mc-lite 的
两级 Object3D 层级（`pivotObject.rotation.y` + `pitchObject.rotation.x = -pitch`），
但不产生 per-turret scene 节点（每炮塔 8 个 mesh 在 20 炮塔时是性能反模式）。
部件尺寸/位置/颜色/炮管几何逐项照搬 `TURRET_CONFIG`（楔形装甲 5 板 + 炮管圆柱 + 根部 + 瞄准器）。
⚠️ 无活跃实例时 `visible=false`（8 个常驻 mesh 恒增 8 个 draw call，须记进验收报告的 draw 对照）。

### 5.2 弹丸：走 M5 实体运行时

弹丸是**临时实体**（roadmap 指定的接入点：M5 `EntityManager` + 实体 raycast）。注册
`projectile` 类型（`src/entities/turrets/projectile-system.js`）：

```js
state = { position: [x,y,z], direction: [dx,dy,dz], traveled, source }  // source = turretId
```

`projectileDefinition.update(entity, dt, context)` 做**直线推进**（无重力、无碰撞响应 ——
mc-lite 同口径：弹丸只判定命中后即消失，不弹跳、不下坠）。⚠️ **必须返回全新 state + 全新数组**
（CLAUDE.md 活跃约束：`EntityManager.update()` 的跨 column 索引迁移判据是「赋值前 vs 赋值后
position」，原地改写会让两者恒相等 → 索引永不迁移 → column 卸载漏回收实体）。
弹丸速度 40 格/秒 × 最大 50 格 → 寿命约 1.25 秒，跨 column 是常态，故这条尤其关键。

**两处判定按红线 6 重写**（有意偏离 mc-lite）：

| mc-lite | mc-heavy | 理由 |
|---|---|---|
| `checkCollisionWithBlocks`：起点/终点双点 `getBlock` 采样 | 体素 DDA（`raycastVoxel`）遍历本步线段 | 双点采样会漏穿薄墙与斜射角（一帧 0.67 格的步长下，斜射可能整步不落在同一格）。红线 6 口径：地形交互一律 DDA |
| `checkCollisionWithSegment`：点到线段距离 + 半径容差（`0.3 + 0.5`） | `EntityManager.raycast(origin, dir, maxDist)` 对实体 AABB | 红线 6：实体命中只由 `EntityManager.raycast()` 给出，不得自建第二套命中判定。M6 武器已走这条路 |

遮挡判据照搬 mc-lite：只有「实心且不透明」方块阻挡弹丸（`props.isSolid && !props.isTransparent`
→ 本仓库 `solidTable && opaqueTable`），透明方块（玻璃/水/云）可穿透。该判据做成同构纯函数
供弹丸与炮塔 LOS 共用（两个消费方，红线 1：各写一份会漂移出「看得见但打不着」的撕裂状态）。

**伤害换算**：mc-lite 的丧尸有**两套血量并存** —— `hitCount`/`maxHits=3`（`Zombie.js:163`，
炮塔 `takeHit` 走这条）与 `health=100` + `takeDamage(damage)`（`:526-536`，枪械与爆炸走这条）。
mc-heavy 只有后者（`ZOMBIE.health=100` + 数值伤害）。故 `PROJECTILE.damage = 34`
（三发 102 ≥ 100，保持 mc-lite 炮塔「三发杀死」语义）。命中经
`ZombieService.damage(id, 34, nowMs)` —— 红闪与 despawn 复用 M6，不另写。
⚠️ 该数值落在 `turret-config.js` 单一权威，测试须在**临界值附近**断言（两发不死、三发死），
远离阈值的输入测不出换算错误。

### 5.3 弹丸渲染与回收

渲染 = 固定 slot `InstancedMesh`（mc-lite `InstancedProjectileRenderer`：
`CylinderGeometry(0.08, 0.08, 2.0, 8)` 共享材质，容量 100 → 本仓库按炮塔上限标定，见下），
朝向由 `direction` 派生（照 `tracer-renderer` 的 `_quaternion.setFromUnitVectors` 手法）。
⚠️ 无活跃实例时 `visible=false`。

**三条回收路径都须归还渲染 slot**（CLAUDE.md 活跃约束：`EntityManager.onDespawn()` 是单槽覆盖
语义，M5 已把它留给 Game 装配渲染层回收 → 第二个消费者不得再注册）：
① 命中丧尸 / 撞方块 / 超距 → `despawn`；② column 卸载 → `despawnColumn`；③ `dispose`。
另：炮塔被破坏时其**在途弹丸不强制回收**（mc-lite 同口径 —— 弹丸已出膛，炮塔消失不影响它飞完）。

### 5.4 容量与 draw call 标定

炮塔上限 20 → 部件实例池容量 20；弹丸池容量按「20 炮塔 × 开火冷却 500ms × 弹丸寿命 1.25s」
≈ 50，取 **64**（2 的幂便于实例池索引）。验收须实测峰值并重标定 —— 照 CLAUDE.md 的
cutout 容量教训（差一点就会触发扩容撞破内存预算）。炮塔与弹丸都是**独立 InstancedMesh**
（不进 BatchedMesh 体素通道），故不吃 `CAPACITY` 预算，但须记进 draw call 对照表。

音效：`assets/sounds/turret_gun_fire.mp3` 从 mc-lite 拷入 + 加进 `SOUND_IDS`（音量 0.25，
mc-lite `TurretManager.handleTurretFire` 同口径）。

## 6. 验收口径

### 6.1 TNT

- 引爆 TNT 后 3×3×3 内的可破坏方块消失，`indestructible` 方块（含 `bedrock`）保留；
  破坏走一次批量事务，REMESH 与 light 收敛无残留脏 section。
- 5×5×5 内的其他 TNT 在 500~1100ms 内依次引爆（确定性抖动：同 seed 两次引爆延迟序列一致）；
  同一格不被引爆两次（去重集合）。
- `canTntDestroyBlocks` 默认关闭时：地形不变、丧尸仍受伤、连锁仍发生；开启后地形被破坏。
  面板开关与持久化字段一致。
- 半径 4 格内的丧尸受 50 伤害（两只丧尸各 100 血 → 一只死一只剩 50），半径外不受影响；
  伤害经 `ZombieService.damage()`（红闪可见）。
- 爆炸特效与音效同帧触发；无爆炸时该 InstancedMesh `visible=false`（draw call 回到基线）。

### 6.2 炮塔

- 从**背包选中** `turret_alias_block` 右键 → 放置完整 11 格结构（底座 3×3 `iron_ore` +
  两格 `obsidian`）+ 建 controller + 播 `put` 音效；**不是**一个贴图案的正方体。
  背包图标是平面手工图（不是立方体等轴测）。
- 放置 20 个成功，第 21 个无任何世界写入；结构重叠、越界、玩家 AABB 重叠均原子失败
  （无部分方块、无 anchor、无索引条目）。
- 丧尸进入 50 格且有 LOS → 炮塔转向它（yaw/pitch 平滑插值，限角速度）；对准（夹角 < 15°）
  且冷却到期 → 开火。无目标时回归放置时的默认朝向。
- LOS 被实心不透明方块阻挡时不开火；透明方块（玻璃/水/云）不阻挡。
- 弹丸命中丧尸 → 掉血 34（三发死）；撞实心方块或飞满 50 格 → 消失并归还渲染 slot。
- 关键 `obsidian` 被徒手 / 武器 / TNT 破坏 → controller 立刻注销、锚点与索引删除；
  卸载/重载不复活。炮塔自身的 `lastFireAt` 时钟写回**不**触发失效。
- 重启后每个锚点只恢复一个 controller（对象引用相等，不是 `size` 断言）；远处炮塔的 column
  未加载时上限仍生效（走远再回来不能无限放置）。

### 6.3 回归与门禁

- `npm run check`（含 `check:arch` / `check:data`）+ `npm test`（浏览器内单测）+ 全量 Playwright
  spec 全绿。`check:data` 新增两个环节：`[不可破坏]`（表内名字都在 registry）、
  `[炮塔装甲]`（烘焙产物存在 + 尺寸 + 指纹匹配）。（`[创造台]` 环节属 M9 范围。）
- `npm run bench -- --check` 无回退（>10% 阻断；结构类 2%）。⚠️ 不带 `--check` 会**自动重写**
  冻结基线 —— 诊断后须 `git checkout` 恢复。门禁阻断时先做**交替对照**（vsync 量子化噪声
  会让 frameP95 误报）。
- draw call 对照表须记录：炮塔 8 个部件 mesh + 弹丸池 + 爆炸球体池的增量，以及三者
  `visible=false` 时回到基线。
- 每条新增断言都做**负向验证**（注入缺陷 → 断言须真 FAIL），并自查无效盲区
  （`docs/testing-policy.md` §2.7 的十二类高发区）。特别地：接线时序缺陷（如炮塔 controller
  接线晚于 `_waitForColumn`）在纯逻辑测试里测不出来，须有落在真游戏页的 E2E 兜住
  （M6/M7 实测教训）。

## 7. 任务分解

| Task | 内容 | Tier | 门禁 |
|---|---|---|---|
| 0 | 设计文档同步（§8：新增机制先落文档再动代码） | — | — |
| 1 | `indestructible` 数据权威（registry typed 表 + 挖块/武器/TNT 三消费者接线）。**只登记 `bedrock`**，创造台两项移交 M9 | 1 | `check` + `test` |
| 2 | TNT 引爆与爆炸（纯函数 + 两条引爆路径 + 连锁 + 丧尸伤害 + 特效/音效 + 面板开关） | 1 | `check` + `test` + `bench --check` |
| 3 | 炮塔装置层（config / blueprint / `TurretService` / controller / 背包放置分流 + 平面图标） | 1 | `check` + `test` + `icons` |
| 4 | 炮塔 AI（同构纯函数 `computeTurretUpdates` 主线程执行 + controller 朝向插值 + 开火节流） | 1 | `check` + `test` |
| 5 | 炮塔渲染（8 部件实例池 + 装甲纹理烘焙 + 指纹门禁） | 1 + 4 | `check` + `test` + 像素实测 |
| 6 | 弹丸实体（`projectile` 类型 + DDA + 实体 raycast + 伤害 + 实例池渲染 + 音效） | 1 | `check` + `test` |
| 7 | 验收（E2E 走背包选中路径 + bench 回归 + 负向验证 + draw call 对照） | — | 全量 |

Task 1 是 Task 2 的前置。Task 3→4→5→6 严格串行（装置层 → AI → 渲染 → 弹丸），
与 M4→M5→M6→M7 的 Epic 链同构。TNT 链（Task 1→2）与炮塔链（Task 3→6）可并行。
**创造台已拆到 M9**（见 `docs/superpowers/specs/2026-09-11-m9-playground-design.md`）。

## 8. 设计文档同步（实施前完成）

CLAUDE.md 规则：「需要新增机制/改动设计时，**先更新设计文档再动代码**，不在代码里埋计划外补丁」。
M8 引入三项新机制，须在 `docs/phase-1-engine-design.md` 落地后再开工：

| 新机制 | 落点 | 要点 |
|---|---|---|
| `indestructible` 方块属性表 | §4.1 方块注册表 | 第 **8** 个 typed 属性表（代码里现有 7 张：solid / opaque / cull / emissive / geometry / orientationModes / supportsPlayer）；三个消费者共用单一权威。⚠️ §4.1 目前没有属性表清单（只描述 ChunkColumn 存储字段），须顺带补上完整清单 |
| 爆炸计算（同构纯函数，主线程） | §4.5 玩家与交互（新增小节）+ 红线 3 的边界判定 | 记清「152 次查询、须与音效同帧」的取舍依据，避免后人误判为红线 3 违规 |
| `turret` / `projectile` 两种 blockEntity kind 与实体类型 | DR-17 的 blockEntity 通道段 + §9 后续功能扩展点表 | DR-17 已写「后续炮塔/床/宝箱可直接复用此通道」—— M8 是第二个消费者，须回填实测结论。⚠️ 实体运行时**不在编号子系统里**（设计文档 §4.6 是光照与 AO；M5 的 `EntityManager` 只出现在 §9 扩展点表与 DR 记录中），落点须查实际章节，勿照本表硬写 |
（`playground` blockEntity kind 与物品集合口径变更属 **M9** 范围，其设计文档同步在 **M9 计划 Task 0** 里做 —— M9 规格本身只有 §1~§4，无独立的设计文档同步节。）

⚠️ **不 bump 设计文档版本号的例外**：M4~M7 的实玩反馈修正按 CLAUDE.md 口径**不进**设计文档修订
说明（那是架构口径变更专用）。本节的三项属**架构口径变更**（新数据通道 / 新子系统边界），
故须进修订说明并 bump 版本号。

另须同步三类文档（CLAUDE.md「文档同步」规则）：新增产物（`assets/turret/armor.png` +
伴随 JSON、`assets/sounds/{explosion,turret_gun_fire}.mp3`、三个 `tools/*.mjs` 烘焙与指纹脚本）
进「目录结构清单」；新增命令（`npm run turret`）进「开发命令清单」；roadmap 的里程碑总表加
M8 行 + 后续扩展点表划掉 TNT / 炮塔两行（创造台那行留给 M9）。

⚠️ **CLAUDE.md 的「背包物品集合口径 118 项」这条活跃约束 M8 不动** —— 创造台两项移出背包
属 M9 范围（M9 时该数字变为 116，届时再改写）。M8 期间物品集合仍是 118 项。
