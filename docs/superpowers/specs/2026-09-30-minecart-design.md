# 矿车 Epic 设计文档

日期：2026-09-30
状态：设计定稿（brainstorming 产出，待实施计划）
对标：mc-lite `src/actors/minecart/`（2381 行，7 文件）+ `Player.js` 乘坐段 + `PlayerInteraction.js` 交互段

## 0. 问题与目标

**现状缺陷**：`mine_cart` 在 mc-heavy 里只是一个背包平面图标物品（`Invicon_Minecart`）。
右键放置后**什么都不会发生** —— 没有实体、没有渲染、没有任何玩法。玩家报告
「放置矿车，矿车所在的位置什么都没有」。

**目标**：把矿车做成完整可玩实体，**行为语义 100% 对齐 mc-lite**（移动、转弯、碰撞、
激活、连挂列车、拾取、玩家乘坐、爆炸摧毁、子弹穿透），但**架构走 mc-heavy 已有的
M5 实体运行时**（不复活 mc-lite 的 ShadowStore/Dispatcher 补丁架构 —— 那在
CLAUDE.md「禁止搬」清单里，且违反红线 1/6）。

**用户已确认的三个关键选择**（brainstorming 环节）：
1. 范围 = 完整对齐 mc-lite（含连挂列车与乘坐系统）；
2. 键位 = 照搬 mc-lite（ctrl+左键激活、左键拾取、站上自动乘坐、空格下车）；
3. 车斗纹理 = 运行时 canvas 程序化生成（照 mc-lite 原样，不做离线烘焙）。

## 1. 总体架构（方案 A：M5 持久实体 + MinecartService + InstancedMesh）

### 1.1 模块布局

```
src/entities/minecarts/          # 同构层（无 three、无 DOM；check:arch 静态门守）
├─ minecart-config.js            # 冻结玩法数据唯一权威
└─ minecart-system.js            # 移动/转弯/碰撞/连挂同构纯函数 + MinecartService 玩法入口
src/render/minecart-renderer.js  # 2 个 InstancedMesh（车斗 + 4 轮），照 M6 手法
```

改动既有文件：`src/core/game.js`（装配 + 帧序 + 爆炸摧毁）、`src/player/player.js`
（放置路由 + 拾取/激活分流 + 乘坐）、`src/player/physics.js`（`_collides` 把矿车占据格
视为实心 —— 2026-10-01 修订：原文写「乘坐期障碍检测排除自身车，若需要」，实测该需求
不存在：乘坐期障碍检测走 `collidesAt`（仅方块），不经 `_collides`，故无需排除任何车）。
详见 §4.4。

### 1.2 权威与派生（红线 1）

- **state 唯一权威 = M5 `EntityManager`**，注册 `minecartDefinition`
  （create/update/raycastAabb/serialize/deserialize 五个纯函数）。
- `MinecartService` **不持有第二份实体集合**，只持有**派生位置索引**
  `Map<"x,y,z", id>`（可随时从 EntityManager 全量重建 —— 诊断口径与 M7 索引同性质）。
- **命中唯一入口 = `EntityManager.raycast()`**（红线 6 / M5 规格 §2）：拾取与激活都用
  实体 AABB 射线，与 DDA 方块命中做最近距离比较（M6 统一遮挡口径），**不碰 three
  Raycaster、不对 InstancedMesh 求交**。
- 渲染层只读 state 发布实例矩阵，不回写（M5 约束）。

### 1.3 帧序（game.js `setAnimationLoop` 内）

```
player.update(dt)                      # 乘坐跟随：读上帧车位（mc-lite 同序）
minecarts.beginFrame()                 # 清 frameReservations / pendingTargetCell 到期清理
entities.update(dt, {world, minecarts})# minecartDefinition.update 跑移动（M6 先例：
                                       #   物理在 definition、编排在 service）
...（既有 scheduler / 渲染）...
minecartRenderer.sync(entities)        # 帧序最后一步，与 zombieRenderer.sync 并列
```

为什么移动在 `definition.update`：`EntityManager.update` 负责跨 column 派生索引迁移
（M5 规格 §2），而帧循环已调它；若 service 也跑移动会推进两遍（M6 同款理由）。
跨车协调（相向碰撞 / 激活 / 帧预占位）经 `context.minecarts`（service 注入）+
每帧共享的 reservations Map 完成；**跨车写入一律排队、循环后统一生效**（守
「update 返回全新 state」不变式，见 §3.4）。

## 2. state 形状与持久化

### 2.1 state

```js
{
  position: [x, y, z],        // 占据格坐标（静止=整数格角，移动中带小数）
  orientation: 0-3,           // EAST/SOUTH/WEST/NORTH（与方块 meta 朝向同枚举）
  movementState: 'idle'|'forward'|'backward',
  lastTrack: [x,y,z]|null,    // 最近轨道格（停止吸附/回弹用）
  // ---- 瞬态字段（不入 snapshot）----
  pendingTargetCell: null,    // 跨帧目标格声明（mc-lite 同名语义）
  linked: [],                 // 连挂 id 集合（激活时重建，不持久）
}
```

⚠️ **实例原点换算**：mc-lite 渲染位置 `position + 0.5`（块中心原点），mc-heavy 实体
position 用占据格坐标（块底角原点），渲染时 +0.5 —— 与炮塔 `pivot()` 同口径
（CLAUDE.md 活跃约束）。

### 2.2 持久化（白拿 M5 全套，零新持久化代码）

- **持久实体**（`spawn({persistent: true})`）。snapshot 只含
  `position/orientation/movementState/lastTrack`（mc-lite `toJSON` 同口径；
  mc-lite 还存 movementState 非 idle 时的值，本仓库一律存，恢复后继续走 ——
  mc-lite `stopMinecartsForChunk` 是卸载时停走，本仓库 M5 两阶段卸载的**冻结**
  语义天然覆盖：冻结即停推进，snapshot 落盘，commit 回收；恢复后 movementState
  照旧，车继续走。这是与 mc-lite 的**行为差异**：mc-lite 卸载会把车停成 IDLE，
  本仓库恢复后继续原方向。**记入偏离表**（更合理，且 mc-lite 停走只是为了
  写盘一致性，本仓库冻结已解决）。
- 白拿的生命周期：entities store 写盘（`flushEntities` / column 卸载）、column ready
  恢复（`entitiesForColumn` → `restorePersistent`）、`_discardEdits` 换 seed 清理
  （`despawnPersistent` —— `entity-manager.js` 注释已明写「未来炮塔/矿车」）。
- **全局上限 50 的判定来源 = `persistence.entitiesCache` 数 `type==='minecart'`**
  （M7 活跃约束：上限必须来自 store 而非已加载数量 —— 走远再回来不能无限放置）。
- id 确定性派生 `minecart-N`：从现有索引 + entitiesCache 取最大数字后缀 +1
  （同炮塔 `_nextId` 手法；红线 2 不用 Math.random）。

## 3. 移动与碰撞（逐条对齐 mc-lite 语义）

移植 `MinecartMovementSystem` + `MinecartCollisionSystem` + `MinecartLinkDetector`
的**行为语义**，抽成同构纯函数（无 three、无 DOM）。速度 `MINECART_SPEED = 2.0`
格/秒 —— mc-lite 该处乘 deltaTime（已是格/秒），**无需 ×60 换算**（M8 活跃约束，
已逐项核对：`ZOMBIE.speed` 才需要换算，矿车不需要）。

### 3.1 单车移动（`update` 主循环）

1. `movementState === 'idle'` → 不动（清 pendingTargetCell）。
2. 轨道判定基准 = **最近轨道中心**（`Math.round(position)`，mc-lite 注释：避免
   floor 的 0.5 格偏差）；位置索引用 floor（与占用索引一致）。
3. 跨越轨道中心时（方向轴上 local 坐标穿 0）做终点检查：
   - 前方格无轨道 → **转弯检测（左优先）**：左有轨道转左，否则右，否则
     **停止并吸附到当前轨道格中心**（`stopMinecartAtCell`）；
   - 前方格被他车 `pendingTargetCell` 声明 → 本帧等待；
   - 前方格有车 → 见 §3.2；
   - 前方格有玩家 → 见 §3.3；
   - 前方格是实心方块（即使有轨道）→ 停；
   - 全通过 → 声明 `pendingTargetCell = 前方格`。
4. 同帧 frameReservations（`"x,y,z"→id`）：目标格已被他车本帧预占 → 不进入
   （防转角并发入格穿模）。
5. 位移 `position += dir × 2.0 × dt`；进新格时更新 service 位置索引 + `lastTrack`。

### 3.2 车-车交互（mc-lite 同分支）

- **相向**（`isHeadOn`：A 前方是 B 且 B 前方是 A）→ 两车都停 + 回弹 `lastTrack`。
- **运动撞静止** → 尝试激活静止车（`canActivateStaticMinecart`：继承方向后前方
  无实心阻挡，且前方有轨道或左右可转）；激活成功本帧不推进自己（避免重叠入格）。
- **追尾运动车** → 等待（前车转向时后车后续帧跟上，mc-lite 注释原意）。
- **其余**（激活失败等）→ 自己停。

### 3.3 车-玩家交互（`checkPlayerCollision` 逐行语义）

玩家在车前方格内（XZ 重叠 + Y 重叠）：
- 玩家脚底已在车顶之上（≥ 车顶 − 0.1）→ 不处理，车照走；
- 否则检查玩家头顶 3 格净空（排除矿车自身）：有空间 → **把玩家抬到车顶**
  （`playerY = 车Y + 0.9`，vel.y=0），车继续；无空间 → 停车。

### 3.4 跨车写入的排队约束（mc-heavy 特有，mc-lite 无此问题）

mc-lite 是单管理器循环直接改对象；mc-heavy 的 `EntityManager.update` 逐实体调
`definition.update` 且要求**返回全新 state**（M6 活跃约束：原地改写会让跨 column
索引迁移判据失效）。故：
- 本车自身的停/转/移动 → 由 update 返回值表达；
- **对他车的写入**（相向碰撞停对方、激活静止车、连挂同步）→ 写入
  `context.minecarts` 的**待生效队列**，由 game.js 帧循环在 `entities.update(...)`
  **之后紧邻一行**调 `minecarts.applyDeferred()` 统一生效（每条都经 `createState`
  重建新 state）。不得放进 `definition.update` 内部 —— 那会在遍历中改动被遍历的集合。
- 断言落点：注入「不排队直接原地改」→ 跨 column 迁移必须真 FAIL（testing-policy
  §2.7 负向验证）。

### 3.5 连挂列车（LinkDetector 语义照搬）

- 激活一辆车时：沿 orientation 前后递归找**相邻格、同朝向**的车（上限
  `MAX_LINKED_MINECARTS = 10`），先 `alignMinecartToTrack` 校验领头车可走，
  再逐辆对齐朝向（领头方向优先，其次反向，其次任一可用），全部置同一
  movementState。
- 拾取/移除一辆车时 `breakLinks`：连挂车全部停 + 清链接。
- 移动期的朝向同步：mc-lite 的 `syncLinkedMinecartsOrientation` 实为 no-op
  （注释：让每辆车到自己交叉点独立转弯）—— **照搬 no-op 语义**，不「优化」。

### 3.6 世界查询口径（同构）

- 铁轨判定：`TRACK_BLOCK_TYPES = ['sand_train_track', 'sand_train_track_corner']`
  （config 单一权威；消费方 = 移动系统 + 放置预检，不得各写字面量 —— 红线 1）。
  铁轨在**车下方一格**（`trackY = carY − 1`，mc-lite 同口径）。
- 实心判定：`registry.solidTable[id]`；方块读取 `world.getBlockId` +
  `registry.nameOf`（同构层不 import three）。

## 4. 玩家交互与乘坐（键位照搬 mc-lite）

### 4.1 放置（右键持 mine_cart）

- `mine_cart` 加入 `CREATIVE_SPECIALS` 物品名路由（M7 模式）——**两条路径语义一致**：
  背包选中后右键（玩家主路径）与 `selectPlaceable` 测试 API。
  ⚠️ M7 活跃约束：只接测试 API 会漏掉玩家主路径（当时 E2E 全绿仍漏缺陷）。
- 预检顺序（失败零写入）：
  ① 目标格是空气。**目标格 = `target.prevPos`**（命中面的相邻空气格）—— 矿车是
     **单格实体**，与多格结构的 `blockPos` 语义不同（M7 那条「origin 用 blockPos」
     的约束针对的是「结构最低层要落在玩家脚下地面格」，矿车没有这个需求：它要落在
     准心指向的空气格里，脚下那格正是铁轨）。玩家准心对着铁轨顶面 → prevPos =
     铁轨上方空气格，与 mc-lite `_getBlockPositionFromHit` 的结果一致；
  ② **下方一格是铁轨**（TRACK_BLOCK_TYPES）；
  ③ 该格无车（位置索引）；④ 未达上限 50（entitiesCache 口径，§2.2）。
- 朝向 = 下方铁轨的 meta 朝向（`world.getBlockMeta`），再按「最近可用轨道方向」
  修正（mc-lite `createMinecart` 的 bestDir 逻辑）。
- 成功：`spawn(persistent)` + 播 `put` 音效（音量 0.3，mc-lite 同值）。
- **不消耗物品**（mc-heavy 创造模式口径：背包槽 count 恒为 DEFAULT_INVENTORY_COUNT）。
  ⚠️ **有意偏离 mc-lite**（它 `consumeItem('mine_cart', 1)`）—— 记入偏离表。

### 4.2 拾取（徒手左键）

- `digBlock()` 前置分流：以准心发起 `EntityManager.raycast`（predicate 只放行
  minecart），**实体命中且比方块 DDA 命中更近** → 拾取：breakLinks + despawn +
  更新位置索引。mc-lite 同语义（左键优先拾取矿车再挖块）。
- **交互射程 = 15 格**（mc-lite `hits[0].distance < 15` 同值），写进
  `minecart-config.js`（`interactRange`）—— 拾取与激活共用同一常量，不得各写字面量。
  ⚠️ 与体素 DDA 的 `REACH = 40` 不是一个口径：实体交互更近，超出 15 格的车点不到。
- **不加回背包**（创造模式口径）。⚠️ **有意偏离 mc-lite**（它 `inventory.add`）
  —— 记入偏离表。
- 持枪时：`weapon-controller` 的 predicate 只放行 zombie（既有口径），子弹穿透
  矿车 —— 与 mc-lite「子弹穿透矿车不做处理」**天然一致，零改动**。

### 4.3 激活（ctrl+左键）

- `mousedown` 捕获 `ctrlKey/shiftKey` 传入分流：ctrl+左键命中矿车（同 §4.2 的
  射线口径）→ 激活：`alignMinecartToTrack` 可走才置 forward（+shift → backward），
  并经 §3.5 带出整列连挂车。mc-lite 同键位（`PlayerInteraction.js:167`）。
- ctrl+左键未命中矿车 → 落回既有 digBlock（含 TNT 引爆分支）。

### 4.4 乘坐（mc-lite `updateMinecartRiding` 语义）

在 `player.update` 内（自主移动之前）：
- **走上车（2026-10-01 补）**：`PlayerPhysics._collides` 把**矿车占据格视为实心**
  （mc-lite `Physics.isSolid` 的 MinecartManager 分支同口径，cell-based）。玩家走进车 →
  水平碰撞 → 既有 `_tryStepUp` 抬到 `carY+1` → 与车顶 `carY+0.9` 差 0.1，被下面的
  绑定容差 0.3 吸收 → 自动绑定。**不需要新机制**：step-up 与绑定判据都是既有的，
  缺的只是「车格是实心」这一条。
  ⚠️ **落点 `carY+1` 与 mc-lite 一致，不是偏离**（实测核实，2026-10-01）：mc-lite
  `tryStepUp` 虽有矿车专用分支（`Physics.js:241-248`，抬到 `carY+0.9`），但其查询坐标是
  `feetY = floor(player.y − 0.01)` —— 走进车场景玩家脚底 y=2.0 → `feetY=1` ≠ `carY=2`
  → **专用分支 MISS**，mc-lite 同样走通用循环抬到 `carY+1`（逐行复刻上游
  `tryStepUp`+`isSolid`+`checkAABB` 实测确认）。唯一差异在「下车后仍在车顶」场景，
  见 §6 偏离 ⑧。
  ⚠️ **不需要「排除自己坐的车」**：`_collides` 只在非乘坐时被调（乘坐期 `physics.step`
  整段跳过），而 `ridingMinecartId` 非 null 时必然在乘坐 → 没有需要排除的车。
  ⚠️ **连带效应**：`_tryStepUp` 内部的 `this._collides()`（「目标位站得住吗」判据）现在
  也把矿车格算作实心 —— 这是本改动的必然结果（同一判据不得有两份），已写进其 JSDoc。
- **自动绑定（两个分支，2026-10-01 补第二个）**：未绑定且不在 0.25s 重绑冷却内时——
  ① **站在车顶**（mc-lite 原口径）：查脚下格（`floor(pos.x), floor(pos.y−0.1), floor(pos.z)`）
     有车且 `|playerY − (车Y+0.9)| < 0.3` → 绑定；
  ② **嵌在车体内**（脚底格 == 车格）→ 直接绑定。
  ⚠️ ** 是本仓库必需的 fallback，mc-lite 不需要**（它靠重力段的「向下扫描找支撑面」
  把玩家顶上车，而本仓库重力是 `_moveAxis` 向下 + 碰撞二分回退，**只阻止下落、不上抬**）。
  实测根因（车撞静止玩家场景）：车在**前一格**跨轨道中心时经 `resolvePlayerBlocking` 把玩家
  抬到 `carY+0.9`，但玩家脚下那格**当时还没车** → 重力把玩家拉回轨面 `carY`。等车走到
  玩家格时：`resolvePlayerBlocking` 只检查**前方格**（玩家已不在前方）→ 不再抬；而 ① 查
  `floor(carY−0.1) = carY−1` ≠ 车格 `carY` → **恒不命中** → 永不绑定 → 车从玩家身上开过去
  （实测 `clippedFrames=60` → 修后 2）。
  ⚠️ **① 的容差判定失败必须 fall through 到 ②，不得直接 `return null`** —— 玩家脚底在
  车体中部（如 `carY+0.5`）时 ① 会查到车但容差外，若直接 return 则 ② 永不执行。
  ⚠️ ** 不需要头顶净空检查**：车能开到玩家格 = `resolvePlayerBlocking` 已在**前一格**检查过
  净空（无净空则车停）；且玩家无法自己走进「车格内 + 头顶无净空」—— 车格对玩家实心
  （`_collides`）→ 水平移动触发 `_tryStepUp`，其内部有净空检查。
  ⚠️ **绑定帧不锁 y**：绑定发生在未绑定分支，「y 锁车顶」在已绑定分支（下一帧才跑）
  —— mc-lite 同序同行为。测试若在检测到绑定的当帧读 y，读到的是 step-up 落点
  `carY+1`（实测 20 vs 车顶 19.9），须多跑一帧再断言。
- **跟随**：绑定后按车位移增量推玩家（分轴，各轴单独做障碍检测 —— 障碍判定
  排除自己乘坐的这辆车），y 锁 `车Y + 0.9`；记录 lastMinecartPosition。
- **乘坐期间**：跳过自主移动输入与重力段（mc-lite 同分支）。
- **空格下车**：起跳（jumpForce）+ 解绑 + 0.25s 重绑冷却（防空格下车立即重绑）。
- **自动下车**：水平偏离 > 0.6 格。⚠️ **偏离基准是本仓库口径（车中心 `position+0.5`），
  不是 mc-lite 的**（它从车格角量）—— 见 §6 偏离 ⑨。
- **两个碰撞查询的分工（载荷性区分，勿合并）**：
  - `_collides`（非乘坐：自主移动 / step-up）= 方块 **+ 矿车格**（上面那条）；
  - `collidesAt`（乘坐跟随的分轴障碍检测）= **仅方块**，矿车不当障碍。
  mc-lite 在 `checkAABBExcludeMinecart` 里把**其他矿车也当障碍**（只排除自己坐的那辆）。
  本仓库乘坐跟随**不做**这层：矿车-矿车碰撞已由 `planMinecartStep` 的相向/追尾逻辑处理
  （两车都停）→ 玩家跟随自然停下。⚠️ 若把矿车加进 `collidesAt`，乘客擦到另一辆车就会
  被「挡停 → 偏离 > 0.6 → 自动下车」甩下车。见 §6 偏离 ⑦。
  （原文写「不动 `_collides` 主路径」—— 2026-10-01 已证伪：走上车正是靠改 `_collides`。）

### 4.5 爆炸摧毁

- `game.explodeTnt` 内追加（mc-lite `PlayerInteraction.js:646-668` 语义）：
  爆炸中心（+0.5 换算块中心）距车中心（`车pos + (0.5, 0.3, 0.5)`，mc-lite 同偏移）
  ≤ 4 格 → 移除矿车（不掉落物品）。经 `minecarts.destroyInRadius(center, 4)`。

### 4.6 铁轨被挖

车下铁轨消失 → 车原地 idle（无轨道则永不移动）。mc-lite 无专门处理，行为自然
等价，**不做额外失效逻辑**。

## 5. 渲染（M6 InstancedMesh 手法）

- `MinecartRenderer`：2 个 InstancedMesh —— 车斗（倒梯形开口盒，mc-lite
  `createTrapezoidGeometry` 顶点逐位移植：顶 0.9×0.9、底缩 0.8 倍、高 0.8、无顶面、
  双面）+ 车轮（`CylinderGeometry(0.2, 0.2, 0.1, 8)` × 4/车，轮距/轴距 0.6）。
  容量 = `maxMinecarts`（50）。
- 每车 5 实例（1 车斗 + 4 轮）；矩阵 = `position + (0.5, 0, 0.5)`，
  车斗 y = `车Y + 0.8/2 + 0.2`（轮半径），rotation.y = `orientation × π/2`；
  车轮旋转 `(0, ry + π/2, π/2)`（mc-lite `updateWheelMatrices` 逐位）。
- 车斗纹理：**运行时 canvas 程序化生成**（用户选定），照 mc-lite
  `createMinecartBodyTexture` 逐行移植（128² 渐变 + 上沿压边 + 底部阴影 + 420 噪点
  + 竖向拉丝；NearestFilter mag + mipmap min）。⚠️ **无指纹门禁**（运行时生成，
  烘焙门禁不适用）—— 记入遗留 TODO：纹理算法改动靠 Tier 4 像素实测兜底。
- **零实例时 `visible = false`**（M6 活跃约束：常驻 InstancedMesh 恒增 draw call）。
  bench 场景 ④ 预期 draw +2（仅当场景内有矿车）。
- `sync()` 差集驱动（炮塔手法）：新 id 分配实例、消失 id 归还；渲染层只读 state。

## 6. 有意偏离 mc-lite 清单（验收报告偏离表预登记）

| # | 偏离 | 理由 |
|---|------|------|
| 1 | 架构走 M5 EntityManager，不搬 MinecartManager+ShadowStore+Dispatcher | 红线 1/6；ShadowStore 在禁止搬清单 |
| 2 | 命中走实体 AABB raycast，不对 InstancedMesh Raycaster 求交 | 红线 6 / M5 规格 §2 |
| 3 | 放置不消耗物品 / 拾取不加回背包 | mc-heavy 创造模式口径（M7 同款） |
| 4 | column 卸载恢复后车继续原方向（mc-lite 停成 IDLE） | M5 冻结语义已保证写盘一致性，停走是 mc-lite 的补丁 |
| 5 | 车斗纹理无指纹门禁 | 运行时 canvas 生成（用户选择），Tier 4 兜底 |
| 6 | 跨车写入排队统一生效（mc-lite 直接改对象） | mc-heavy「update 返回全新 state」不变式 |
| 7 | 乘坐跟随的障碍检测**不把其他矿车当障碍**（mc-lite `checkAABBExcludeMinecart` 把其他车当障碍，只排除自己坐的那辆） | 车-车碰撞已由 `planMinecartStep` 的相向/追尾逻辑处理（两车都停）→ 跟随自然停下。若把车加进 `collidesAt`，乘客擦到另一辆车会被「挡停 → 偏离 > 0.6 → 自动下车」甩下车（矿车 Epic 既有裁定，2026-10-01 补登记） |
| 8 | `_tryStepUp` **无矿车专用分支**（mc-lite `Physics.js:241-248` 有：命中则抬到 `carY+0.9`）。仅在「玩家已在车顶（脚底 `carY+0.9`）且未绑定」时产生差异：mc-lite 专用分支 HIT → 抬升量 0；本仓库走通用路径 → 抬到 `carY+1`，抬升 0.1 触发一次相机缓动（`stepLiftAccum`）。**走进车的主路径两侧落点相同**（都是 `carY+1`，上游专用分支因 `feetY=carY−1` 而 MISS，实测确认） | 该场景 = 空格下车后 0.25s 重绑冷却期内站在车顶水平移动，而 `dismountJump`（初速 10）已把玩家弹离车顶 → 实际几乎不触发。补专用分支要改 `_tryStepUp` 语义 + 新增测试，收益不抵成本（YAGNI，2026-10-01 用户裁定）。实测数据见验收报告 |
| 9 | 自动下车的偏离基准 = **车中心**（`position + 0.5`）；mc-lite 从**车格角**量（`Player.js:603`，`minecart.position` 是格角而 `player.position` 是脚底中心） | mc-lite 口径下玩家站在车的**远半格**（如 `cx+0.7`）时 deviation=0.7 > 0.6 → **人还在车上就被自动下车**（上游缺陷）。本仓库从车中心量：`cx+0.7` 时 deviation=0.2 → 保持乘坐；走到 `cx+1.2`（真离车）时 0.7 > 0.6 → 下车。符合 §4.4 意图（矿车 Epic 既有裁定，代码注释与 CLAUDE.md 已登记，2026-10-01 补进本表） |

## 7. 测试分层（testing-policy 判据）

- **Tier 1（TDD 必须）**：
  - 移动/转弯/碰撞/激活/连挂同构纯函数（浏览器内单测 `src/tests/test-minecart*.js`）；
    断言先在真实数据跑一遍再写（testing-policy §2.6 ⑤）；坐标判据用非负取模或直接
    枚举足迹（§2.6，`wx % 16` 陷阱）；
  - `minecartDefinition` serialize/deserialize 往返 + EntityManager 集成
    （spawn 去重 / 上限 / 两阶段卸载恢复）；
  - 负向验证注入后须真 FAIL（§2.7）：尤其「跨车写入不排队原地改」→ 跨 column
    迁移失效。
- **Tier 2**：`check:data` 加矿车契约 —— `mine_cart` 在 CREATIVE_SPECIALS 路由、
  TRACK_BLOCK_TYPES 单一权威来自 config、铁轨两方块仍在背包（铺轨可用性）。
- **E2E（Playwright）**：放置→渲染出现、激活→移动→停止吸附、ctrl+shift→后退、
  拾取→消失、reload 恢复位置与朝向、乘坐跟随与空格下车、爆炸摧毁。
  ⚠️ 放置用例必须走**背包选中路径**（M7 教训）。
- **Tier 4 像素实测**：车斗纹理渲染 + 朝向旋转（从实例矩阵反解 yaw 用
  `atan2(elements[8], elements[0])`，M6 活跃约束，勿用 Euler 反解）。
- **bench**：50 辆矿车场景 frameP95 / draw 对照（交替顺序多轮取中位；
  计时门禁 flaky 口径见 CLAUDE.md）。

## 8. 性能与容量

- 移动计算 O(车数 × 常数格查询)，50 辆 × 每帧 ~10 次 `getBlockId`（O(1) typed
  array 读）≈ 可忽略；**全部主线程**（同炮塔 LOS 口径：世界数据唯一权威在主线程，
  车数少无需后台化）。
- 渲染 +2 draw call（有矿车时）；实例矩阵每帧更新 50×5 = 250 个 Matrix4，
  与 M6 六部件同量级。
- 不新增 Worker（红线 3）、不新增持久化 store（M5 entities store 已覆盖）。

## 9. 遗留 TODO（本 Epic 不做）

- 车斗纹理算法改动无指纹门禁保护（靠 Tier 4 兜底）；
- mc-lite 的矿车音效（行驶/碰撞）未移植（mc-lite 本身也没有，只有放置 `put`）；
- 矿车与丧尸的物理碰撞（mc-lite 无此交互，丧尸追逐不避矿车 —— 保持同口径）。
