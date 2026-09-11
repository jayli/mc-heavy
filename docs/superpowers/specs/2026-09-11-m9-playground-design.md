# M9 创造台（playground）设计

**状态：** 📝 待实施（从 M8 拆出，2026-09-11）
**定位：** 第三阶段第二个 Epic。mc-lite 的创造台（`PlaygroundService.js`）在 mc-heavy 用
M4~M7 建立的底座重做：`WorldEditor.setBlocks()` 唯一写入口 + M7 的方块锚定装置模式
（`blockEntity` 持久真相 + `listBlockEntities` 扫库判上限）。
**语义：** 保留 mc-lite 的玩法数值（54×54 平台 / 净空 10 / 距玩家 10 格 / 导入导出 JSON）；
架构按本仓库红线重写（见各节的「有意偏离」说明）。

> **为什么从 M8 拆出**：M8 的 TNT + 炮塔链（装置层 → AI → 渲染 → 弹丸）已经是四个严格串行的
> 子任务，加上创造台会让单个 Epic 过重。创造台与 TNT/炮塔**没有硬依赖** —— 唯一的交集是
> §1 的 `indestructible` 数据权威，而它已在 M8 交付（M8 只登记 `bedrock`）。
>
> ⚠️ **`indestructible` 的 playground 两项与「移出背包」必须成对做**（本规格 §1）：
> 只登记 `indestructible` 而不移出背包，会立刻产出「玩家放得出来但挖不掉、TNT 也炸不掉」
> 的撕裂状态。故两者一起留在 M9，M8 不碰。

## 依赖

- **前置 = M8 已交付的 `registry.indestructibleTable`**（本规格 §1 复用该表，不新建机制）。
- 与 M8 的 TNT / 炮塔无其他依赖，可独立实施。
- 复用 M7 的方块锚定装置模式（roadmap「M7 交付的可复用模式」段）。

## 1. 不可破坏方块的创造台两项 + 移出背包


mc-lite 用**两处字面量**表达同一件事：`ExplosionWorker.js:6` 的
`INDESTRUCTIBLE_BLOCKS = ['playground_block', 'playground_center_block', 'bedrock', 'barrier']`，
以及 `BlockData.js:244/252` 的 `isIndestructible: true` 字段（注释「不可被 TNT、机枪或玩家破坏」）。
两处漂移会产出「TNT 炸得掉但玩家挖不掉」或反之的撕裂语义。本仓库按红线 1 收敛成**单一权威**：

- `blocks-data.js` 每条声明新增可选字段 `indestructible: true`（缺省 false）。
  ⚠️ **登记三项**：`bedrock` / `playground_block` / `playground_center_block`。
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

⚠️ **测试落点**：属 Tier 1（静默的数据错误 —— 炸掉了不该炸的方块，肉眼玩不出来）。
断言须落在**三个消费者同时生效**处：注入「`digBlock` 改回字面量清单」须真 FAIL；
且须在临界值附近断言（`indestructible=false` 的方块必须可破坏，不能把整表当恒真判据）。
`check:data` 新增 `[不可破坏]` 环节：表里每个名字都在 registry 内（拼错则门控静默失效）。



**实测发现的既有偏差**：本仓背包物品集合 = registry 126 − `NON_PLACEABLE_ITEMS`(4) −
`HIDDEN_FROM_INVENTORY`(4) = **118 项**（派生集合），而 mc-lite 是**手工列举 107 项**
（`Game.js:206+` 的 `inventory.add(...)`，实测 `rg -c` = 107，**不含** `playground_block` /
`playground_center_block`）。派生口径下这两项**目前就在背包里**（未被任何排除集合排除）
→ 玩家能从背包选中并放置平台方块。

配上本节的不可破坏门控，这会产出**撕裂状态**：玩家放得出来，但挖不掉、TNT 也炸不掉
（只能靠「关闭创造台」批量删，而关闭只删平台层矩形内的格）。故 M8 必须把这两项加进
`HIDDEN_FROM_INVENTORY`（**不是** `NON_PLACEABLE_ITEMS` —— 它们本质能放能挖，只是不该出现在
物品集合里，与 `chimney`/床三项同一语义）。

**这是一处新的有意偏离 mc-lite**（注意：设计文档 §4.3/§4.5.4 那个编号清单是**视觉比对专用**
—— vine / 吊灯 / 图标烘焙 / lilypad / AO 五项，本项是物品集合口径偏离，**不并入那个编号序列**）：
mc-lite 靠手工列举天然不含它们，本仓是派生集合故须显式排除。物品集合从 **118 → 116**；
`check:data` 的 `[物品集合]` 门禁是**关系型断言**
（registry − 排除集合，改排除集合自动跟上）故不会误报，但图标指纹检查会少两项 →
须重跑 `npm run icons`。⚠️ 文档里不得硬编码 118/116 这两个数字（CLAUDE.md：计数以
`npm run check:data` 输出为准）。


---


## 2. 创造台服务

### 2.1 平台生成

照搬 mc-lite `PlaygroundService.createPlayground()` 语义：**54×54 平台**（2916 格）+
中心 `playground_center_block` 标记块 + 其余 `playground_block`。选址顺序照搬：
玩家**东侧 10 格**优先（从地面高度向上搜安全高度，净空 10 格）→ 失败改**西侧** →
仍失败用玩家 Y−20 起搜 → 最后用玩家 Y−5 起搜 → 全部失败返回 `NO_SAFE_LOCATION`。

⚠️ **搜索上界改为本仓库的 `WORLD_MAX_Y=96`**（mc-lite 是 `maxY=200`，它的世界高度 0~255；
本仓库 `-32~96`）。照搬 200 会让搜索恒超出世界顶 → 永不返回安全高度。

`hasOverlapWithWorld` 判据照搬：平台层与上方净空区域必须全为空（非空气方块即视为重叠）。
⚠️ **未加载 column 的处理**：mc-lite 遍历 `world.chunks` 查已加载块；本仓库 `WorldData`
对未加载 column 的 `getBlockId` 返回 0（air）→ 会把未加载区域判为「安全」。故选址前须
确认候选区域的 column 已加载（照 M7 `place()` 的 `hasColumn` 预检），未加载则视为重叠。

写入走一次 `editor.setBlocks()` 事务（2916 格）。⚠️ **这是本 Epic 最大的单次编辑量** ——
须实测 REMESH 收敛期的帧率与队列深度（bench 场景 ④「批量删 500 块」是既有对照基线，
2916 格约为其 5.8 倍）。若帧率跌破门禁，改走**分帧提交**（每帧 N 格，照 mesh 下发预算
`budget.meshDispatchPerFrame` 的手法），并在验收报告标注。

### 2.2 关闭与方块集合

mc-lite 维护 `playgroundBlocks: Set<'x,y,z'>` 副本（2916 个字符串键）用于关闭时删除。
本仓库**不维护这份副本**（红线 1：它是「平台有哪些方块」的第二份权威）。关闭时由
`origin + size` **确定性重算枚举** —— 平台是规则的 54×54 矩形，坐标可纯计算得出，
不需要记录。

关闭判据照搬：玩家在平台区域内（`isPlayerInPlayground`：XZ 在范围内 + Y 在
`[origin.y, origin.y+20)`）则拒绝关闭（`PLAYER_IN_PLAYGROUND`），防止把玩家脚下的地面抽掉。
删除走一次 `editor.setBlocks()` 事务（全部置 air）。⚠️ **只删平台层方块，不删玩家在上面
雕的模型**（mc-lite 同口径：`playgroundBlocks` 只含平台格）。

### 2.3 重启恢复

mc-lite 靠遍历已加载 chunk 找 `playground_center_block`（`detectExistingPlayground`）——
远处未加载就扫不到。本仓库走 M7 的锚点模式：中心块的 blockEntity
`{kind:'playground', id, origin:[x,y,z], size}` 随 edits 落盘，
`Persistence.listBlockEntities('playground')` 扫库恢复。**全局最多 1 个创造台**
（mc-lite 的 `isPlaygroundActive` 单例语义），上限判定同样走扫库而非已加载 controller。

平台方块**全部登记 `indestructible: true`**（§1）—— 玩家与 TNT 都不得破坏平台本体
（mc-lite `BlockData.js:244/252` 同口径）。模型方块（玩家雕的）不在此列，可正常破坏。

### 2.4 模型导入导出

导出：枚举平台上方（`origin.y+1` 起至世界顶）的非平台方块，转成相对中心的坐标，
输出 `{blocks: [{x,y,z,type,direction}], metadata: {created, dimensions}}` ——
**格式与 `assets/structures/*.json` 完全一致**（mc-lite 同口径，故导出的模型可直接当
结构 JSON 用，例如喂给 `assets/structures/` 与撒布管线）。触发浏览器下载 `model.json`。

导入：解析 JSON → 校验（非法坐标/未知方块名计 `invalid`，`cullMode:'none'` 的不可渲染方块
计 `skipped`，同坐标重复只保留首次）→ 先清平台上方模型区 → 再一次事务写入。
`direction` → orientation 的换算照搬 mc-lite `convertDirectionToOrientation`
（`((intDir % 4) + 4) % 4`，取水平四方向）。⚠️ **Y 越界判据用本仓库的
`WORLD_MIN_Y/WORLD_MAX_Y`**（mc-lite 是 `y < 0 || y > 255`）。

未知方块名（registry 里没有）必须计 `invalid` 并**跳过**，不得写 0（air）进去 ——
那会静默删掉玩家已有的方块。


---


## 3. 创造台 UI

设置面板**右列**新增一组动作按钮（CLAUDE.md 活跃约束：面板新配置优先往右列填，纵向余量更大）：

- 「创造台」按钮：未激活 → 生成；已激活 → 关闭。文案随状态切换（mc-lite `UIManager.js:354-364`
  同手法）。⚠️ **文案单一口径**：构造与状态复位共用同一常量，不得写两处
  （v1.35 踩过的坑：`_resetDangerArmed()` 写死旧长文案覆盖了构造时的短文案）；
- 「导出模型」/「导入模型」按钮：仅创造台激活时可见（mc-lite 同手法 `style.display`）；
- 操作进行中须**防重复点击**（mc-lite `isPlaygroundOperationInProgress` 锁）—— 2916 格的
  写入是秒级操作，重复点击会产出两个平台或半删状态。

mc-heavy **目前没有 `showMessage`/toast 设施**（`CoordsHUD` 只显示坐标）。M8 新增一个轻量
toast（`src/ui/toast.js`）：屏幕中部短暂提示、自动淡出、不阻塞输入、不进 `uiModal` 模态栈
（它不是模态 —— 玩家须在提示期间仍能操作世界）。消费者 = 创造台的成功/失败提示
（`NO_SAFE_LOCATION` / `PLAYER_IN_PLAYGROUND` / `PLAYGROUND_EXISTS` 等），后续 Epic 可复用。

⚠️ **`settings-panel.js` 的 `PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**
（会提前终止模板字符串 → 整个模块解析失败 → 游戏页白屏）。改完先跑 `npm run lint`。

⚠️ **列分隔线规则只作用于 `.mc-item`，不得通配所有子项**（v1.35 踩坑：写
`.mc-column > :first-child` 会连带抹掉 `.mc-combined` 合并盒自己的装饰边框）。
往面板加新容器类型时须同步考虑这条选择器。


---

## 4. 验收口径


- 生成 54×54 平台（2916 格）+ 中心标记块；选址按东侧→西侧→Y−20→Y−5 顺序，找不到安全高度
  返回 `NO_SAFE_LOCATION` 且零世界写入。
- 平台方块不可被玩家挖、不可被 TNT 炸（`indestructible`）；玩家雕的模型方块可正常破坏。
- 玩家在平台区域内时拒绝关闭；区域外关闭只删平台层，保留模型。
- 导出 JSON 的格式与 `assets/structures/*.json` 一致（相对坐标 + type + direction），
  可被结构管线消费；导入时非法项计 `invalid`、不可渲染项计 `skipped`、未知方块名**不写 air**。
- 重启后从锚点恢复创造台状态（按钮显示「关闭创造台」），全局仍最多 1 个。
- 生成/关闭期间按钮锁定（防重复点击）；toast 提示对应结果且**不**阻塞世界操作。
