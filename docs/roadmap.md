# mc-heavy 总路线图

> 本文档是**项目进度的唯一总览**。它只回答三个问题：做到哪了、下一步做什么、去哪找细节。
> **不重复内容** —— 架构决策见设计文档，历次改动记录见其修订说明，任务级执行清单见
> `docs/superpowers/plans/`。

最后更新：2026-09-30

## 一句话现状

第一阶段引擎底座（M0~M3）**全部完成并验收达标**，两个收尾补丁项（M3.1 背包 / M3.2 方块朝向）
也已落地。此后是一串独立 bugfix 与改造（v1.19~v1.42，v1.37/v1.38 补齐了 M2 遗留的
**结构撒布**——草地/城市里的房子·花坛·亭子·高井此前完全看不到；最新一条 **v1.42** 回补了
M2-7 有意删除的**空岛天空树**并修正 `sky_leaves` 的渲染通道声明）。第二阶段 **M4 玩家武器已完成并验收**
（验收报告 `docs/m4-weapons-acceptance-report.md`），M4 阶段遗留 TODO——设置面板「破坏方块」
开关按钮——已落地（见下节）；**M5 实体运行时已完成并验收**（验收报告
`docs/m5-entity-runtime-acceptance-report.md`），**M6 丧尸已完成并验收**（验收报告
`docs/m6-zombies-acceptance-report.md`：默认 20 上限 / 20Hz 单条 WorkerPool `ai` RPC /
25·35·999 三把枪伤害 / 六部件固定 slot 渲染；丧尸不攻击玩家，无 PlayerVitals），
**M6 阶段遗留 TODO 两项也已补齐**（实体间排斥 / 头部马赛克图案，见下节）；
**M7 玩家放置丧尸巢穴已完成并验收**（验收报告
`docs/m7-zombie-nests-acceptance-report.md`：全局最多 8 个 / 8 秒节流 / 八偏移 × 六层刷怪 /
关键 `gold_block` 被破坏即失效），**M7 遗留 TODO 也已补齐**（背包里的巢穴图标改走平面路径 ——
此前是立方体等轴测图，错的表达，见下节）。**第二阶段 Epic 链（M4→M5→M6→M7）全部交付。**

**第三阶段 M8 → M9 全部完成并验收**：**M8 TNT 爆炸 / 炮塔弹丸**（验收报告
`docs/m8-tnt-turret-acceptance-report.md`：TNT 3×3×3 破坏 + 5×5×5 连锁 + 4 格 50 伤害 /
炮塔方块锚定装置 20 上限 + 主线程索敌 + 8 部件实例渲染 / 弹丸走 M5 临时实体、DDA 阻挡 +
实体 raycast 命中 + 三发 34 伤害）；**M9 创造台**（验收报告
`docs/m9-playground-acceptance-report.md`：54×54 平台 2916 格一次事务写入（2 帧收敛）/
中心块 `blockEntity` 锚点重启恢复 / 平台方块 `indestructible` + 移出背包（物品集合 118→116）/
模型 JSON 导入导出格式与 `assets/structures/*.json` 一致 / 面板动作按钮 + 本仓首个非模态
toast）。M9 依赖 M8 交付的 `indestructibleTable` —— 登记两项与移出背包**成对做**，
避免「放得出来但挖不掉」的撕裂状态。

**矿车 Epic 已完成**（2026-09-30）：`mine_cart` 从「背包里一个什么都不做的平面图标」做成
完整可玩实体 —— M5 持久实体（`minecartDefinition`）+ `MinecartService`（放置 / 拾取 /
激活 / 连挂列车）/ 移动·转弯·碰撞·连挂同构纯函数 / 2 个 InstancedMesh 渲染（车斗 + 4 轮）/
玩家 ctrl 激活 · 左键拾取 · 站上乘坐 · 空格下车 / TNT 爆炸摧毁。行为语义对齐 mc-lite，
架构走 M5 实体运行时（不复活 mc-lite 的 ShadowStore/Dispatcher 补丁架构）。

## 里程碑总表

| 里程碑 | 内容 | 状态 | 关键 commit |
|---|---|---|---|
| **M0 骨架** | 脚手架 / Worker 池 RPC / BlockRegistry / atlas / WebGPU 发布路径实测（6 项冻结断言） | ✅ 完成 | `7788751` 起 |
| **M1 体素核心闭环** | 地形生成 / section meshing 双路径 / BatchedMesh 通道级合批 / 玩家物理（step-up + 相机缓动）/ DDA 射线 / 放块挖块 / 最小存档 / 光照（skylight + AO + blocklight + 异步收敛） | ✅ 完成 | `40b73ff` 验收 |
| **M2 结构与世界完整性** | StructureIndex 确定性布局 / 5 地标（城市·金字塔·冰封山·雪地·海岛）/ 树木植被 / 洞穴 / 水面特效 / 日夜循环三风格 / 空中结构（悬浮空岛 + 云层） | ✅ 完成（2026-08-31 关闭） | `4794586` 关闭 |
| **M3 性能达标与收尾** | 全量场景稳态 120fps / 帧预算双档（`src/core/budget.js`）/ 雨效 / HUD + 设置面板 + 随机种子新世界 / 基线脚本 + 回归门禁 / 性能报告 | ✅ 完成（2026-09-02） | `82da106` |
| **M3.1 背包**（M3 收尾补丁项） | 创造模式无限背包 1000 槽（照搬 mc-lite `Slots.js` 语义）/ Z 键面板 / 快捷栏改读 `slots[0..4]` / `uiModal` 模态栈 + keydown 守卫 | ✅ 完成（2026-09-02） | `b19029f` |
| **M3.2 方块朝向放置交互**（M3 收尾补丁项） | mc-lite 三分支放置朝向（门控 / 原位挖放转 90° / 类型记忆）/ 挖块记朝向 / `world.getBlockMeta()` | ✅ 完成（2026-09-03） | `c512cd3` |
| **M4 玩家第一人称武器** | `WorldEditor` 批量编辑 / DDA hitscan / 受控 GLB 相机视图模型 / 曳光 / 音效 / 可选方块破坏 | ✅ 完成（2026-09-05，验收报告 `docs/m4-weapons-acceptance-report.md`） | `ed9a271` |
| **M5 实体运行时** | `EntityManager` / 实体 AABB raycast / 受控渲染层 / 临时与持久实体分离 + `entities` snapshot | ✅ 完成（2026-09-07，验收报告 `docs/m5-entity-runtime-acceptance-report.md`） | `c9f7086` |
| **M6 丧尸** | 默认 20 上限 / 20Hz 单条 WorkerPool `ai` RPC / 实体与体素最近命中比较 / 25·35·999 三把枪伤害 / 六部件固定 slot 渲染 / X 键调试生成 | ✅ 完成（2026-09-08，验收报告 `docs/m6-zombies-acceptance-report.md`） | `afb88ad` |
| **M7 玩家放置丧尸巢穴** | 最高 `gold_block` 的 `blockEntity` 为持久真相 / `block-changed` 失效 / 八 offset × 六层刷怪 / 全局最多 8 个 / 背包图标按物品名路由放置整个 38 方块结构 + `put` 音效 | ✅ 完成（2026-09-10，验收报告 `docs/m7-zombie-nests-acceptance-report.md`） | `e72560d` |
| **M8 TNT 爆炸 / 炮塔弹丸** | `indestructible` 单一权威（只登记 bedrock）/ TNT 3×3×3 破坏 + 5×5×5 连锁 + 4 格 50 伤害 / 炮塔方块锚定装置（20 上限）+ 主线程索敌 + 8 部件实例渲染 / 弹丸走 M5 临时实体（DDA + 实体 raycast + 三发 34 伤害） | ✅ 完成（2026-09-11，验收报告 `docs/m8-tnt-turret-acceptance-report.md`） | `1b74281` |
| **M9 创造台（playground）** | 54×54 平台 + 中心块 `blockEntity` 锚点 / 复用 M8 的 `indestructible` 表追加创造台两项 + 移出背包 / 模型 JSON 导入导出 / 面板动作按钮 + toast | ✅ 完成（2026-09-12，验收报告 `docs/m9-playground-acceptance-report.md`） | `aa6cabb` 登记 / `db31ef8` 服务 / `57ca13f` UI |
| **矿车 Epic** | M5 持久实体（`minecartDefinition`）+ `MinecartService`（放置 / 拾取 / 激活 / 连挂）/ 移动·转弯·碰撞·连挂同构纯函数（统一 round 判据 + 帧前快照 + deferred 跨车写入）/ 2 个 InstancedMesh 渲染（车斗 canvas 纹理 + 4 轮）/ 玩家乘坐（分轴障碍检测）/ TNT 爆炸摧毁 / `Persistence.deleteEntity`（首个可单独销毁的持久实体） | ✅ 完成（2026-09-30，设计文档 `docs/superpowers/specs/2026-09-30-minecart-design.md` + 计划 `docs/superpowers/plans/2026-09-30-minecart.md`） | 待提交（零 commit 模式） |

## M4 之后的遗留 TODO（M4 阶段 bugfix）

| 事项 | 状态 | 要点 |
|---|---|---|
| 设置面板添加「破坏方块」开关按钮（对齐 mc-lite 配置面板的「枪械破坏设置」，`UIManager.js:160` 开/关两按钮 → `canGunsDestroyBlocks` + HUD 提示） | ✅ 完成（`3fe8626`） | mc-heavy 当前只有 API 入口 `game.setGunBlockDamage(enabled)`（M4 规格 §4.4：「M3 HUD 若已实现设置面板，可直接绑定该 API」）。已落地：`src/ui/settings-panel.js` 照既有 `_makeRow`/按钮组模式加一行，点击调既有 API，不新增机制；默认 `false`（与 mc-lite 一致，破坏开关默认关闭） |

M4 交付后的实玩反馈修正（已落地，记录在验收报告偏离表）：相机入 scene（R 切武器可见）、
pointer-lock 拒绝捕获、曳光粗细对齐 mc-lite + 起点世界空间冻结（v1.33）、武器灯光（v1.34）、
MAG7 曳光终点回归准心轴（v1.36，原用扫描候选当终点导致斜射——移植偏差，非有意偏离）。

## M6 之后的遗留 TODO

| 事项 | 状态 | 要点 |
|---|---|---|
| 丧尸**互相重叠**（多只挤成一坨，重叠到一起看起来像一只） | ✅ 完成（2026-09-09） | **根因**：mc-heavy 完全没有实体间互斥 —— `collides()` 只查方块、worker AI 从不两两比较、`spawn()` 无位置门控 → 所有丧尸朝同一玩家收敛到同一点且无排斥。**mc-lite 实现在 AI 层（worker）**：`EnemyWorker.js:131-155` `calculateSeparationForce`（`minDistance 1.2` / `repulsionStrength 0.05`，线性衰减 × 归一化方向，O(n²) 无空间索引）+ `:218-220` **叠加进 velocity**（`velocity = aiVelocity + separationForce`），不是 manager 层推挤位置。落地：`zombie-system.js` 抽 `separationForce()` + `computeAiUpdates()` 两个**同构纯函数**（红线 8：worker 与浏览器内单测共用同一份，避免「测试与真实接线口径不一致」盲区），`world-worker.js` 的 `ai` 分支改为调 `computeAiUpdates`。**两处有意偏离 mc-lite（都实测必需）**：① **`repulsionStrength` 换算 ×60**（`0.05` → `3.0`）—— mc-lite 是**格/帧**单位（`predictNextPosition` 不乘 dt，`Zombie.js:302-305`），mc-heavy 物理层乘 dt → 格/秒，与 `ZOMBIE.speed` 的 `0.02×60=1.2` 同口径。**不换算实测**：排斥力只有追逐力的 4%，压不住收敛 → 24 只最小间距仍降到 0.003、21 对重叠（与无排斥对照组几乎相同）；换算后 0.439 / 1 对。② **补完全重叠 tie-break** —— mc-lite 判定 `distance > 0.001` → 完全重叠时跳过不推开，这在 mc-lite 无害（它有 S 路线随机偏移角让丧尸不会精确同点），但 mc-heavy 的 AI 是纯直线追逐 → **永久死锁**（实测 20 只强制同点生成后 3 秒仍 min=0、190 对全重叠）。用 **id 派生的确定性方向**（黄金角散列 + id 序定符号 → 同位置两只必然朝相反方向）而非 `Math.random()`：可测 + 无帧间抖动。验证：单测 **413 全绿**（新增 12 条排斥用例）+ E2E 新增「强制同点生成后须散开」（实测 20 只 min 0→0.578、重叠对 190→1）+ **8 条负向验证全部真 FAIL**（含「worker 不消费共享函数」→ min 恒 0，正是这条 E2E 存在的理由）；自查发现 **1 条无效盲区**：边界测试的输入从被测常量派生 → 注入「`<` 改 `<=`」仍全绿（且 `distance == minDistance` 时 `force` 本就为 0 → 数学等价，不是真实缺陷）→ 改用字面量 1.2 + 前提断言，并补「略小于半径须有排斥」配对钉住边界语义。全量 E2E **79 passed / 1 failed**（`m1-acceptance` 既有 flaky，**交替对照**：HEAD 侧 4/4 全失败 vs 改动侧 2/4，HEAD 失败率更高、失败值同为 16.7 贴线，未改断言未放宽阈值）。 |
| 丧尸**头部无图案**（mc-lite 头部是马赛克纹理 + 黑色眼睛，mc-heavy 此前是纯色 `0x406b30`） | ✅ 完成（2026-09-09） | **半成品核查：此前记的半成品已不存在**（`assets/zombie/` 与 `.tmp-neg/` 都不存在、从未入库）→ 从头制作。**⚠️ 原 TODO 预设的方案实测不可行**：TODO 标注的「未验证前提」答案是**不支持** —— 实测（红/绿两材质 + 读渲染像素）正面像素是 `[255,0,0]` 红而非绿，即六面恒用 `material[0]`；根因 `three.webgpu.js:34592` `getMaterial()` 直接 `return material`，不遍历 `geometry.groups`、不取 `materialIndex`（WebGL 后端 `:30472` 则按 group 分次 draw → 是 WebGPU 后端**刻意不实现**，非整体不支持）。故改走 TODO 预留的备选：**单材质 + 单纹理 + UV 分区**。落地：`tools/bake-zombie-head.mjs`（`npm run zombie`）烘焙 **128×64 双区并排**（左半无眼睛 / 右半有眼睛 —— 不能用上下分区，会把 8×8 马赛克压成 8×4）+ `tools/zombie-head-fingerprint.mjs`（图案参数与指纹的单一权威，烘焙脚本与门禁共用，红线 1）+ `src/render/zombie-head-texture.js`（加载）+ `zombie-renderer.js` 的 `applyHeadUV`（正面顶点 16-19 → 右半）+ `game.js` 接线。连带修正：`head.color` `0x406b30` → `0xffffff`（白底乘纹理色）、**draw call 仍是 6**（不是原预测的 7 —— 单材质单 draw range）、验收报告 §6 那条偏离已反转。**两处有意偏离 mc-lite**：① 固定种子 mulberry32（mc-lite `Math.random()` → 每次加载图案都不同，违反红线 2）；② 两区共用同一份马赛克背景（mc-lite 两次独立随机 → 正面与侧面是两张不同随机图，那是 `Math.random` 的副作用非设计意图）。**图案参数实测自 mc-lite `:99-119`**：8×8 格 × 8px / `base=[64,107,48]` / 三种噪点色 / **`> 0.7` 才用噪点 → 实际仅 30%**（照字段名理解会把图案画反；烘焙后实测噪点比例 32.8% 证实语义没反）/ 眼睛网格 (2,3) 与 (5,3)。验证：浏览器内单测 **401 全绿**（新增 UV 分区 + 纹理退回 + 白底三条）+ **Tier 4 像素实测**（正面眼睛 `[0,0,0]` / 非眼睛 `[65,106,49]` ≈ 纹理参数 / 顶面侧面非黑 / 红闪 `[65,0,0]` 暗红 —— head 有 map → 红 × 深绿马赛克，非纯红，mc-lite 既有行为）+ `check:data` 新增 `[丧尸头部]` 三环节契约 + **12 条负向验证全部真 FAIL**（单测 5 + Tier 4 4 + 门禁 2 + game.js 接线 1；含自查发现的 **1 条无效盲区**：顶面/侧面的取样点没对准眼睛格位置 → 注入「眼睛画进左半」仍全绿；根因是三个面 `buildPlane` 的 `vdir` 符号不同（正面/侧面 `-1`、顶面 `+1`），用同一套公式会在某些面把 v 反向偏一格 → 改用**纹理坐标**作统一参数消除陷阱）。 |

## M7 之后的遗留 TODO

| 事项 | 状态 | 要点 |
|---|---|---|
| 背包里的巢穴图标是**立方体等轴测图**（错的表达 —— 该物品代表整个 38 方块结构，不是一个方块） | ✅ 完成（2026-09-10） | **不新增烘焙脚本、不新增运行时分支**：mc-heavy 的图标烘焙**已有平面路径**（`tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`，`mine_cart` 已在此），语义与 mc-lite 的 `ItemIconUtils.getCustomIconPath()` 手工图标表**完全一致** —— 都是「绕过立方体生成、直接用手工图」。故只需把 `zombie_nest_alias_block` 加进 `FLAT_BLOCKS` + 跑 `npm run icons`：运行时仍是 1 行 `icon.style.background = ICON_CSS[name]`，指纹门禁自动覆盖，`FLAT_ICON_TILE` 无需加条目（`faces-data.js:109` 已映射同名 tile 且该 tile 在 atlas 内 → 引用完整性门禁不报）。**mc-lite 实测口径**：`getCustomIconPath()` 把 `zombie_nest_alias_block` / `turret_alias_block` / `bed_alias_block` / `mine_cart` 一起映射到手工图，`global.css:46` `.slot img { width:32px; height:32px; image-rendering:pixelated }` → nearest 降采样。**降采样算法单变量对照**（同尺寸只换算法）：单点 nearest 40px 得 57% 不透明 / 799 色（= 源图 74.7% 透明占比的等比结果，保像素风锐利，与 mc-lite `pixelated` 等价）；区域平均得 86% / 426 色（会糊 → 未采用）。**判据用机制而非像素统计**：像素统计区分度不够（HEAD 版立方体也是 63% 不透明 / 435 色 —— alias 的贴图本身就是整张示意图，立方体等轴测采样它也保留 alpha）→ 改用「atlas 内该矩形**逐像素等于源图 nearest 降采样**」：改动侧 **100.0%**（1024/1024 与 1600/1600），HEAD 侧 **7.6% / 6.5%**（只有全透明像素碰巧相同）。**负向验证真 FAIL**：注入「移除 `FLAT_BLOCKS` 条目」→ 指纹回到 `geom:box`、判据降到 7.6%/6.5%。⚠️ **注入第一次没生效**（perl 模式要求 `'mine_cart', 'hanging_lamp',` 前有缩进，实际它接在 `'vine', 'lilypad', ` 后 → 未匹配，指纹仍是 `flat;`）—— 这正是「注入后仍全绿先怀疑落点」的**另一面**：先确认注入真的改了源码，否则「全绿」是假信号。**未加门禁断言**（`CREATIVE_SPECIALS ⊆ FLAT_BLOCKS` 不是必然不变式：未来若有「需特殊放置逻辑但仍是单格方块」的物品，立方体图标恰恰是对的 → 断言会误报，而门禁误报比无门禁更糟）；剩余失效路径属**立刻可见**（打开背包就看到），Tier 3 判据不需门禁。防重犯落在**改动入口注释**（`player.js` 的 `CREATIVE_SPECIALS` —— 做炮塔的人必先改它）+ CLAUDE.md 活跃约束。**连带修正 `player.js` 一段错注释**：原写「不进 Hotbar、不进背包面板」，实测 alias **就在**背包集合 118 项内（槽位索引 75）—— 那个错前提正是 M7「背包放置只放一格」缺陷的根因（验收报告 §3.7 纠正了文档，代码注释没跟上）。验证：`npm run check` 全绿（图标过期 118 项指纹匹配、形状权威 103 等轴测 + 15 平面）+ 浏览器内单测 **451 全绿** + M7 spec **10 passed**；改动不碰热路径（`tools/` + 注释 + 烘焙产物）→ 按门禁分层不需 bench。 |

## M8 / M9 之后的遗留 TODO

| 事项 | 状态 | 要点 |
|---|---|---|
| **远处 column 的持久 edits 不会应用到世界**（走远→重启/回走→方块消失，**既有缺陷**） | 📝 待处理（v1.43 发现并登记） | **现象**：在距出生点较远的 column 改方块、落库后 reload，**再走回去时方块不见了**；store 里的行仍在（未被删）。**根因（已实测）**：`Game.start` 只对**出生点视距窗口**调 `preloadEdits`（`game.js:428`），而 `Scheduler` 的 `getEdits` 是**同步**读 `persistence.editsCache`（`getEditsSync`）；窗口外的 column GEN 时缓存必然未命中 → `edits=[]` 下发给 Worker → `applyEdits` 无事可做 → 方块是地形原值。`column.edits` 也就重建为空（`restoreEdits` 拿到 `[]`）。**后果**：不只视觉——该 column 后续任何 edit 落盘时 `flushNow` 会用「只含新编辑」的 Map 整行 `put`，把该 column 的全部旧 edits 顶掉。**A/B 实测**：在 HEAD（无本次改动）上用纯正常路径复现（444 格外放 stone → flushNow → reload → 回去）：`blockId=0`、`columnEditsInMemory=0`、`savedColumns=1`，与改动侧完全一致 → **不是 v1.43 引入**。`docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md:2760` 当时写的「M1 简化：启动时 preloadEdits 视距内全部 column key，GEN 时缓存必命中」对**跑出窗口后又回来的 column 不成立** —— 这是 M1 就埋下的假设错位。**修法方向（未实施）**：让 GEN 前能等一次异步读盘（如把未命中的 key 先 `await loadColumnEdits` 再下发 GEN，或 GEN 阶段改用 `loadColumnEdits`），或对未命中的 key 在读到后对该 column 触发重 GEN。⚠️ 属 Tier 1 改动（改 GEN 下发协议/时序），须单独立项 + 负向验证，不在 v1.43 内做 |
| **计时型断言的余量小于一个测量/调度量子 → 间歇性翻转**（bench 场景 ④ frameP95 + 场景 ③ uploadMsP95/fastRemeshP95 + `weapons-world-edit` 射击计数；M8 / M9 / 2026-09-30 共四次遇到） | 📝 待处理 | **三条同类合并**（原为两行 TODO + 2026-09-30 新增一例）。共同形态：断言余量小于一个量子（vsync 8.33ms / 测量精度 0.1ms）→ 单次采样随机翻转，**与具体改动无关**；但**抖动源各不相同，勿混为一谈**：<br>① **bench 场景 ④ frameP95**（M8/M9）：120Hz 锁帧下 p95 按 **8.33ms 一档量子化**，基线 9ms、实测 9.6~10.2 随机浮动 → 9→10 只差一个量子就报「回退 11%」；交错对照实测 M9 期间 HEAD 侧同样阻断（10 / 10 / 10.2），两侧分布完全重叠。<br>② **bench 场景 ③ uploadMsP95 / fastRemeshP95**（2026-09-30）：抖动源是 **GC 压力与 0.1ms 测量精度**，不是 vsync —— `src/ui/hotbar.js:40` 早已记录「GC 施压实测令 fast-remesh p95 从 1.1ms 涨到 1.3ms」（与本次阻断值完全吻合）。基线 0.6 / 1.1ms、10% 容差上界 0.66 / 1.21ms → 实测在 0.6/0.7 与 1.1~1.2 间跳档即越界。**交替对照**（MOD/BASE 交错各 3 轮，`--out` 写 /tmp 不污染基线）：两侧中位完全相同（0.6 / 1.2）、draw 557 vs 559、fps 差 −0.7%；用门禁自身判据逐轮复算 → **两侧各阻断 1/3 轮、阻断值相同**（0.6→0.7）→ 噪声实锤。<br>③ **`weapons-world-edit.spec.mjs` 射击计数**（M9）：200 次射击之间 `setTimeout(95)` vs 手枪冷却 90ms（`weapon-catalog.js` `cooldown: 0.09`，靠帧循环累加 `dt` 递减）→ 余量 5ms < 一个 vsync 量子（8.33ms），少渲染一帧就计 199。同一份代码单独复跑 3/3 全通过 → 间歇性。<br>**建议**（按载体分两类，不是按抖动源）：**bench 门禁（①②）** 把判据改成**交替对照**（而非单次数值）—— ① 也可改成「按量子档容忍」；**Playwright spec（③）** 把余量抬到一个量子以上（等待改 ≥100ms）或把判据改成「≥199」。⚠️ 四次均**未改断言、未放宽阈值、未重写基线** |
| 创造台导入的「先清模型区」语义（mc-lite `collectModelAreaBlocksToClear`） | 📝 有意未移植 | mc-lite 导入前会把玩家已有模型全删（破坏性操作，须用户授权）。当前口径：同坐标冲突时**后写入者胜出**（`setBlocks` 的 `lastByPos` 去重），不产生撕裂状态。若用户需要「导入即替换整个模型」，须单独确认后再实现 |
| `tools/bake-procedural-textures.mjs` 的 `textures.turret_alias_block` 生成代码已无消费者 | 📝 待清理 | M8 把炮塔图标改指向 mc-lite 手工原图后遗留（低优先级） |
| **mc-lite 的另两个序列帧特效未移植**：`pick.png`（枪击击中方块，1400×840 / 5×3=15 帧）与 `block_crash.png`（徒手破坏方块，2800×942 / 5×3=15 帧） | 📝 待补 | mc-lite `ParticleSystem` 有三个序列帧池，**爆炸那个已补齐**（`src/render/explosion-sprite.js`，见下方「已补齐的实玩反馈修正」）。序列帧基础设施已建成（图集加载 + Sprite 池 + 逐帧 offset + Tier 4 像素判据），这两个是同套东西换参数 + 换接线点（`weapon-controller` 命中路径 / `player.digBlock` 路径）。⚠️ 素材须放 `assets/effects/`（**不能**放 `assets/textures/` —— 会被 `build-atlas` 扫进世界 atlas 并重排所有 tile 坐标） |
| **矿车车斗纹理是运行时 canvas 生成，无指纹门禁**（设计文档 §6 偏离 ⑤） | 📝 已记录 | mc-lite `createMinecartBodyTexture` 是运行时 canvas 程序（渐变 + 上沿压边 + 底部阴影 + 420 金属噪点 + 竖向拉丝），用户选定「照 mc-lite 原样、不做离线烘焙」→ 没有可供 `check:data` 比对的输入指纹。纹理算法改动（渐变色 / 噪点数 / 拉丝间距）会**静默生效**（每次加载游戏都重新生成，指纹检查抓不到），靠 Tier 4 像素实测兜底（`tests/minecart-render.spec.mjs` 车斗区采金属灰 + 两朝向投影不同）。若未来改离线烘焙，须同步补指纹门禁（手法见 `tools/zombie-head-fingerprint.mjs`） |

### 已补齐的实玩反馈修正（M8 / M9 之后）

不 bump 设计文档版本号（CLAUDE.md 口径：版本号 bump 是架构口径变更专用）。

| 事项 | 要点 |
|---|---|
| **悬空宝箱删除 + 烟囱下方透明面修复**（2026-09-30） | 两个用户报告的 bug 同批修。① **悬空宝箱**：根因 = `tall_well.json` 的孤立 `chest@(24,51,20)`（mc-lite 上游数据异常，井体本身只到 y=16）—— 它在 y=51 完全悬空，每个 tallWell 候选都渲染一个 → 「天空中好多悬空宝箱」。实测复现（fetch stub + 真实 GEN，seed=12345）：候选 `(40,7,-53)` 在 `(64,57,-33)` 产出 chest、下方 `air/cloud/air`。修法 = 删 JSON 条目（315→314 块，属数据勘误，同 big_house 删 lilypad）；**footprint 24/20 刻意保留不收缩**：收缩到真实包围盒 5/4 会缩小 `isFirstInFootprint` 抑制范围 → 井密度 70→103（+47% 实测），增加 cutout 压力且改变用户当前看到的世界。防回归 = `check:data` 新增 `[结构 JSON]` 孤立块契约（负向验证：HEAD 原始文件命中 1 个、修复后 0）+ `test-scatter.js` 的 `SCATTER_Y_EXTENT.tallWell` 51→16。② **烟囱下方透明面**：根因 = registry 按 `cullMode === 'opaque'` 推 `opaqueTable`，而 cullMode 是**渲染通道**语义、opaqueTable 是**面剔除**语义（两套口径）→ chimney 因材质不透明进了 opaque 通道，连带被误判成「占满整格、可剔除邻居面」→ mesher 剔掉烟囱下方屋顶块的顶面。实测本仓库全部非 box 几何方块的 opaqueTable 都是 0，chimney 与 bed_head/bed_tail 是唯二漏网。修法 = cloud 同款手法：`blocks-data.js` chimney 行加显式 `"opaque":false`（opaqueTable=0，cullMode 仍 opaque）。连带效应（均为修正）：chimney 不再遮挡 AO / 阻断 blocklight / 挡炮塔 LOS —— 细圆柱本就不该完全遮光。bed_head/bed_tail 同类漏网**暂不修**（已从背包移除、实际不会被放置）。验证：新增 Tier 1 mesher 用例（RED 29 面 → GREEN 30 面，对照组 stone+stone 仍 10 面）+ `check` 全绿 + 浏览器内单测全绿 |
| **爆炸序列帧特效补齐** | mc-lite `World.js:1296 spawnExplosionParticles` 是**两层叠加**：① 序列帧 billboard（`ParticleSystem.js:177`，`big_blow.png` 500×200 / 5×2=10 帧 / 0.5s / AdditiveBlending / scale 3→8 / 前 80% 全亮末 20% 淡出）② 球体扩张（`World.js:1301-1311`，注释原文「作为底层增强」）。**M8 当时只移植了 ②**（`explosion-renderer.js` 文件头如实记录了这次裁剪），实玩反馈「爆炸少了原始图分帧播放」→ 补 ①：新增 `src/render/explosion-sprite.js`（照搬 mc-lite 的 Sprite 池手法 —— Sprite 自动 billboard + 逐 sprite `visible=false` 同样还原 draw call 基线）+ `assets/effects/big_blow.png`。两层在 `game.js` 的 `explodeTnt()` 同帧触发（billboard 先、球体后，mc-lite 就是这个顺序）。**Tier 1 单测钉帧映射算术 + Tier 4 像素实测证明切帧真在生效**（`tests/explosion-sprite.spec.mjs`）+ 真游戏页接线断言（`tests/tnt.spec.mjs`）。三处负向验证均实测通过（注入 bug 后真 FAIL） |

## M3.2 之后的独立 bugfix / 改造（v1.19 ~ v1.43）

这些不属于任何已编号里程碑，是实玩反馈驱动的独立改动。**完整记录在设计文档的修订说明**
（每条含根因、实测数据、门禁对照）与 `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`
（v1.19~v1.21 独立章节、v1.22~v1.31 表格）。此处只列状态与一句话要点：

| 版本 | 事项 | 状态 | 要点 |
|---|---|---|---|
| v1.19 | 异形方块渲染勘误 | ✅ `c307885` | 补记实例原点换算基准（mc-lite 块中心 vs mc-heavy 块底角，比对须 +0.5）；vine 改落格内（有意偏离）；床 UV 取贴图下半修真实 bug |
| v1.20/v1.21 | 背包物品集合口径变更 | ✅ `c307885` | 122 → **118 项**；`chimney` + 床三项移出背包（独立 `HIDDEN_FROM_INVENTORY` 常量）。床渲染镂空问题**未修**，靠不入背包规避 |
| v1.21 | 吊灯材质自发光 | ✅ `c307885` | packed bit13 材质自发光标记 + cutout 通道 emissive 加项，对齐 mc-lite |
| v1.22 | 吊灯 UV 分区与 quad 级自发光 | ✅ `b9b8699` | **已知有意偏离 mc-lite**：绳单色深灰 + 灯体发光暖黄 + 灯面无绳图案 |
| v1.23 | 背包专用图标表 | ✅ `245fb4d` | 台阶类图标与母方块撞脸 → 用 atlas 里 5 张现成手工图标 tile |
| v1.24 | 异形方块等轴测图标 | ✅ `cd0d7d4` | 9 项异形方块改离线烘焙等轴测投影；**形状权威 = mesher `TEMPLATES`** |
| v1.25 | 测试分级策略与静态门禁 | ✅ `8e9f721` | Tier 1~4 判据 + `check:arch` / `check:data` 两个静态门；关系型断言取代硬编码计数 |
| v1.26 | 全量背包图标离线烘焙 | ✅ `176e419` + `c8e9dc9` | **运行时约 91 行 → 1 行**；独立 `icons-atlas.png`；覆盖全量 118 项；`check:data` 加图标过期指纹检查 |
| v1.27 | 背包槽位点选抖动修复 | ✅ `65254f9` | `box-sizing: border-box` 消除选中边框撑高 grid 行（实测位移 2px） |
| v1.28 | 等轴测图标遮挡修复 | ✅ `f76055b` | 深度度量 y 符号修正（`x+y+z`）+ 逐像素深度测试取代 painter 整面覆盖 |
| v1.29 | 设置面板「删除缓存」按钮 | ✅ `598f10b` | `Game.clearSave()` 清 edits **保留 seed 与设置**（与 `newWorld` 换 seed 语义不重叠）；竞态三步抽成共用 `_discardEdits()`；armed 二次确认 |
| v1.30 | 沼泽睡莲水洞与沉水修复 | ✅ `c491e8a` | `TEMPLATES.lilypad` y `0.02`→`-0.48` + 生成格位 `SEA_Y`→`SEA_Y+1`（**两处耦合，单独改任一处都错**）；叶面 -1.48 紧贴水面 -1.50；`big_house.json` 删 3 个草地 lilypad（几何无法同时贴合半格水面与整格草地）。Tier 1 TDD + 双向负向验证 + Tier 4 像素实测（中心 8.9 倍差异） |
| v1.31 | AO 去掉对角门控（凹角阴影连成环） | ✅ `2462e7f` | 用户报告：方块两面都是墙角时，两条阴影各沿凹角垂直延伸，而**东南对角地面格完全不参与** → 阴影在对角处断开露出「阴影的边」。根因实测定位：`mesher.js` `getAO` 对角门控 `(side1\|\|side2)?corner:0`（mc-lite/MC 原版语义）→ 两侧开阔、仅对角遮挡的顶点恒 AO=3。隔离场景实测：对角格 `(9,0,9)` 靠 B 角 AO=3（全亮）、东/南格同位置 AO=2（有阴影），且同一空间顶点 `(9,1,9)` 在不同 quad 里 AO 不一致（2 vs 3）。修复：去门控 → 对角格 AO=2，阴影连成环。**有意偏离 mc-lite 第 ⑤ 项**，副作用全局（所有「仅对角遮挡」顶点暗一档）。Tier 1 TDD（RED `Expected 2, got 3` → GREEN 278/278）+ Tier 4 像素实测（HEAD 1.067 vs 改动侧 0.851，约 19% 差异，双向有效）+ bench `--check` 通过 |

| v1.35 | 设置面板两列布局 + 档位精简 | ✅ `49e7cce` | 用户反馈面板拥挤，且第二阶段（M5~M7）会持续加配置项。改 mc-lite 同款两列盒（`.mc-columns` / `.mc-combined` 合并盒），**行列分配按本仓库档位需要重排、不沿用 mc-lite 分配**（后续新配置优先往右列填）。档位精简三项：① 视距 UI 档位 5→3（`[8,12,16]`），但 `clampVD` 钳制范围 **2~16 不动**（架构口径，测试依赖 `vd=2`）→ 面板须容错「当前值不在档位内」，**刻意不做就近高亮**；② 音量档移出面板（默认 100%，字段仍持久化 + `?volume=` 可达）；③ 新世界 + 删除缓存共用一行。顺带修掉文案漂移：`_resetDangerArmed()` 写死旧长文案覆盖了构造时的短文案 → 抽 `CLEAR_SAVE_LABEL` 共用常量。**用户随后报告合并盒上边框缺失**（本次改动引入）：分隔线规则 `> :first-child` 通配所有子项、特异性 (1,2,0) 压过 `.mc-combined` 的 (1,1,0) → 列首合并盒上边框被置 none；改为只作用 `.mc-item` + 补四边 solid 断言 + 负向验证。单测 296 全绿 + 档位契约断言负向验证（改 `[8,12,20]` → FAIL `Expected 20, got 16`）+ DOM 几何实测（面板 818×398、两列等高 375×255、合并盒四边 solid、零文本溢出）。全量 E2E **55 passed / 1 failed** —— 失败的 `m1-acceptance` `digP95` 是已知 flaky 计时断言（2ms 贴线抖动），**交替对照**实测两侧分布重叠（HEAD 均值 1.833 vs 改动侧 1.933，各 9 样本），机制上不相关（放挖热路径零命中面板代码，spec 用 `vd=8` 在新旧档位都存在） |
| v1.37 | 结构撒布补齐（M2 欠账） | ✅ `87cd571` | 用户报告**草地与城市里看不到房子/花坛/亭子/高井**。根因实测定位：`assets/structures/` 27 个 JSON 里 **7 个零消费**（`flower_bed`/`pavilion`/`tall_well`/`desert_pyramid` 4 个是真实 M2 欠账，`bed`/`turret`/`zombie_nest` 3 个有意预留），且 mc-lite 的**三条撒布路径完全未搬**（城市装饰物逐点撒布 / 城市外代码生成 `house` / 城市外大型静态结构）。补齐后城内 797 个撒布（house 152/pavilion 446/tallWell 77/flowerBed 122）、城外每 region 约 25 个。新增 `src/gen/structures/scatter.js`（撒布判定 + `generateCodeHouse`，Worker 同构）；候选在 **region layout 层**算一次（DR-13），`apply.js` 阶段 2.7 只做 AABB 裁剪光栅化。**四处有意偏离 mc-lite**（`Math.random`→`seededRandom` 守红线 2 / 判定不带 occupied 参数防跨 column 接缝断裂 / 避开树半径 2 而非 8~10 / 不撒水下），详见下方「活跃约束详情 · 结构撒布」。**撒布密度刻意低于 mc-lite**（城市基值减半 + 两个大 JSON 减半）以守两条冻结断言，并配合 `CAPACITY.cutout.active` 450→550（扩容是离散 ×1.5 跳增，峰值 1.80M 差 2230 顶点就跳到 170MB）。Tier 1 TDD：单测 **341 全绿** + **17 条负向验证全部确认真 FAIL**（含自查发现的 2 个无效盲区：特征方块跨结构重叠导致断言恒真、tank 门控用错参数路径未触达）+ 新增 `check:data` `[撒布结构]` 三环节契约（含磁盘文件存在性 —— 浏览器里 fetch 404 会被吞成空结构，只有门禁能抓）。`genP95` 6.8~7.7ms（6/6）/ `gpuVertexBytes` 148MB / bench 通过 fps 111~120 / 全量 E2E **66 passed**（唯一失败 = `m1-acceptance` 既有 flaky，交替对照改动侧 3/5 vs HEAD 侧 4/5，改动侧失败率更低） |
| v1.38 | ship 沉船补齐（M2 欠账，v1.37 的延续） | ✅ `aee7072` | 用户追问「还有哪些 mc-lite 实体没搬」。调研后确认：JSON 结构两边都是 27 个（一致），但 `ship`（沉船，mc-lite `WorldWorker.js:988/:2987` 的**代码生成方块结构**、无 JSON）在 mc-heavy 完全没有 —— 设计文档 grep `ship`/`沉船` 零命中，是真欠账（区别于 `skyTree` 的 M2-7 有意删除，已保留）。**rover/gun_man 推迟到 M6**：它们是 GLB 模型实体（gun_man.glb 16 primitives / free_car 12），需要 mc-heavy 尚不存在的碰撞（`physics.js` 不查实体）/ 射线（未接 `EntityManager.raycast`，M6 规格 `:61` 才接）/ 破坏持久化基础设施，正是 M6 丧尸要建的同一套；现在补只能做到「看得见」。ship 是方块结构，走现有 mesher + BatchedMesh 管线，天然合批（bench 实测 draw=496 与 v1.37 持平）、有碰撞、可挖掉。门控 `h<-6` + 概率 + `safeForStructure`，实测 109 个命中（视距 8 内 3 个，最近距出生点 98 格）、**跨 column 0%**（内圈 + 占地 dx±2/dz±3 数学必然落在单 column 内）、深海无 DESERT。门控与 v1.37 陆地水下门控**方向相反**，在同一循环内用 `h` 一次计算分流。引入 `CODE_GENERATED_SCATTER_TYPES` 单一权威（红线 1：派生基准勿写成 `t !== 'house'`，否则门禁误报或结构静默消失）。Tier 1 TDD：单测 **351 全绿** + **10 条负向验证全部真 FAIL**（含自查发现的 1 个无效盲区：footprint 范围判据被海底地形污染恒真 → 改桅杆中心列判据）。`check:data` 门禁扩展到覆盖代码生成类型的占地 / bench 通过 fps 108~120 无回退 / 全量 E2E **67 passed**（这次 m1-acceptance 也通过） |
| v1.42 | 天空树回补 + `sky_leaves` 通道修正 | ✅ `13ce699` | 用户报告**空岛之上没有树**（mc-lite 有）。勘查发现两部分：① **天空树是 M2-7 有意删除项**（设计文档 v1.14「按产品范围删除空岛宝箱与天空树」），但零件全部就位（方块注册 / 程序化贴图 / atlas tile / 背包图标 / `generateTree(...,'skyTree')` 完整算法，**零调用点**）→ 只差接线；② **`sky_leaves` 的 `cullMode:"cutout"` 是 M2-7 移植偏差** —— 转换规则按「名字含 leaves」归类（`blocks-data.js:6`），而 mc-lite 材质是 `mkMat('#FF69B4', 0.9)` = `transparent + opacity`、**无 `alphaTest`** → 不是镂空。atlas 实测印证：tile 中心 `[255,105,180,230]`，cutout 通道 `alphaTest=0.3` 且无 `transparent` → alpha 0.902 全保留不混合，**自 M2-7 起实际渲染就是不透明纯粉**（那个 0.9 从未被消费）。落地：`sky-structures.js` 新增 `writeSkyTrees()` + `islandLayerRadius()`（岛层半径单一权威，红线 1）+ `SKY_TREE_CHANCE`/`SKY_TREE_SALT` 导出常量，追加进既有层序（云→岛体→树）；`blocks-data.js` 一行 `cullMode` cutout→opaque。**salt 取 113 而非 59**（程序化扫描发现云簇 frontier 的 `seed+58+step` 在 `size∈[30,50]` 下实际占用 **58..107 连续区间**，注释只写「seed+58」会误导）；**AABB 门控比岛体宽 2 格**（树冠外扩 ±2，否则跨界树冠在相邻 column 断裂缺角、而岛体看起来完全正常 → 难归因）。四方案实测对比后用户选定 **C（opaque + opaqueTable=1）**：总面数 735,576→**700,064**（−4.8%，叶-叶相邻面开始互剔）、三通道容量**全守住**、`gpuVertexBytes` **148.06MiB**（< §4.10 的 150MiB，余量 1.94MiB） → **不动 `CAPACITY`、不放宽 §4.10**（容量全部守住，**不是靠降密度换来的**）。⚠️ **密度另有一次用户指令的减半**：`SKY_TREE_CHANCE` 交付后按用户指令由 mc-lite 的 **0.1 减半为 0.05**（2026-09-29，**有意偏离 mc-lite**，与容量无关；观感从「连绵叶团」变「疏朗树木」，实测每岛 10→4 棵、opaque 顶点 −29,236、draw −5）。⚠️ **占用百分比用实测数，不照抄 spec §4.3 的勘查估算 79/55/41**（口径不对号）：稳态（289 列队列全收敛）opaque **82.9%** / cutout **72.3%** / transparent **10.6%**；冲刺峰值（12s 奔跑、250ms 采样）**93.8% / 81.9% / 11.2%**；三通道 `_capacity.*.maxVertexCount` 全部等于标定值（**零扩容**）。cutout 的高占用是 **HEAD 既有状态**（撒布补齐 `87cd571` 后花/树叶进 cutout），本次把 `sky_leaves` **移出** cutout 反而使其降低；transparent 的 41% 是**冲刺态**数字（水面大量暴露），不是 289 列稳态数字。⚠️ opaque 冲刺峰值余量已收窄到 6.2%，后续往 opaque 加量前须重测。**性能（实测）**：全场景 GEN p95 **1.534ms**（HEAD 1.206ms，+0.33ms，未撞线）/ MESH **+0.4%**（交替对照）/ **draw call +15**（bench 场景④ MOD 545 vs HEAD 530 —— WebGPU 后端对 BatchedMesh 每个可见 geometry slot 各发一次 draw，`three.webgpu.js:85531`；spec §4.3 勘查期写的「draw call +0」是按「合批进既有 3 通道」推断，**已被实测证伪**；该值不在门禁 LOWER_IS_BETTER 集合内，不阻断）。⚠️ **一处冻结断言经用户裁决放宽**：`structure-gen` fixture 的「含结构 genP95」门实测撞线 **8.5~8.8ms**（4 次单独复跑分布极窄 → 非负载噪声），机制 = 该 fixture 的 4×4 测量域是**空岛密集区**（3 个空岛 / 圆内 563 顶层格 → 密度 0.1 时约 56 棵树集中进这 16 个 column 的 GEN 计时路径），+0.33ms 的全场景平均增量在岛密区被放大到约 +1ms。**用户 2026-09-29 裁决放宽 8ms → 10ms**（只改 `test-structure-gen.html` 的含结构门；`test-worker-gen.html` 的**无结构**门逐字未改仍守 8ms）。档位口径澄清：设计文档 §4.2 原文「单 column GEN（**无大结构**）目标 < 8ms；含城市结构切片 < 25ms」—— 8ms 档本就是「无大结构」口径，含结构属 25ms 档，故 **10ms 相对 §4.2 原文是保守值**。放宽后 3/3 通过（探针实测 8.20~8.40ms）。⚠️ **同日密度减半（0.1→0.05）后该域树数 ≈28，genP95 实测回落到 7.6~7.8ms（已回到原 8ms 预算内）；用户裁决保留 10ms 作余量而不收回 8ms**（本门是单样本 p95、无平均无舍入，7.6~7.8 对 8ms 只剩 2.5% 余量 → 高负载下会贴线抖动）。**故 10ms 现在的性质是「保守余量」而非「撞线所需」**；若树密度或 GEN 成本再涨须**重新实测**而非再次静默放宽。**三项有意偏离 mc-lite**（`sky_leaves` 开始遮挡 AO / 阻断 blocklight / 阻挡炮塔 LOS —— mc-lite 因 `isTransparent=true` 三者皆不；已登记为 CLAUDE.md 视觉比对偏离清单第 ⑥ 项）。⚠️ **勘查期两个自身错误已记入 spec §9**：只读 mc-heavy 声明就推断 mc-lite 材质语义（违反既有约束「对齐上游须实测其运行时行为」，是用户凭观感质疑才发现）；用 vd=10（加载半径 `R+2`）论证 cutout 撞破，而 CAPACITY 是「视距 8 容量口径」（HEAD 在 vd=10 下 opaque 本就 111% → 属奔跑态瞬时扩容的正常设计）。Tier 1 TDD：浏览器内单测**全绿**（计数以 harness 输出为准）+ **7 条有效负向验证逐条实测确认真 FAIL**（spec §6.3：Task 4 门控 radius+2→radius → `missing=12` / Task 5 未接线 → E2E `treeWood`→0 而**单测全绿**（盲区实证）/ Task 8 半径-1 → `baseAir` 3/5 处为 air / CHANCE=0 → 单测+E2E 双侧 / cutout 回退 → **三处冗余断言全部命中**（registry + mesher + Tier 4）/ 全部树叶族改 opaque → 「leaves 仍 cutout」反向断言 / salt 写字面量 → 5/5 处为 air）；另有 1 条「层序倒置」注入经实测确认**不是真实失效模式**（几何不重叠 + 注入点也够不到被测路径）→ 已从清单移除，不为凑负向验证而编造无效注入。+ 新增 Tier 4 像素实测（不透明性 `wallDist=266` + cutout 单变量对照 `channelDelta=0`）+ E2E 接线负向验证（单测测不到「没接线」）。全量 E2E **120 用例 / 117 passed / 3 failed** → 三处处置：① `structure-gen` genP95 = 上述用户裁决（已修，3/3 通过）；② `m1-acceptance` placeP95 在 2ms 边界振荡（1.7~2.1，`--repeat-each=3` → 1 failed/5 passed）= **既有 flaky**（CLAUDE.md 在列）；③ `sky-structures` frameMs.p95 16.9 vs 16.75 = **vsync 量子贴线**（单独复跑 3/3 通过：16.7/16.6/16.7）。三处均**未改断言、未放宽阈值**（除①的用户裁决）。`turrets` 6/6、`projectiles` 4/4 全通过 —— §2.6.3 第 4 项连带效应（`sky_leaves` 阻挡炮塔 LOS）**未在既有 E2E 体现**（两者都钉地面 `vd=2&seed=12345`，树在高空空岛）。⚠️ **评审发现并修正了两处「断言描述想象中的世界」的缺陷**（[`docs/superpowers/reviews/2026-09-20-sky-tree-review.md`](superpowers/reviews/2026-09-20-sky-tree-review.md)）：① 「每棵树 4 格树干」断言必然 FAIL（实测 21.4% 树干被后写树叶覆盖，因 `makeColumnSetter` 无占用格守卫 → 与 mc-lite 偏离）→ 改用忠实写入顺序模拟逐格比对；② 跨 column 用例的取模选点判据在负坐标下恒真（`%` 是取余）→ 改按真实足迹判跨度（实测修正后注入 radius → missing=901 → 真 FAIL）。两条都沉淀为 CLAUDE.md 活跃约束 + `testing-policy.md` §2.6 的第 ⑤/⑥ 条。 |
| v1.43 | 进度包导入导出（设置面板） | ✅ 本次 | 用户要求在设置面板增加「导入进度 / 导出进度」，放在「打开创造台」右侧、该行标题改「创造台和进度管理」（按钮分两行：`[打开创造台(窄)][导入进度][导出进度]` / `[导出模型][导入模型]`，第二行仍仅创造台激活时可见）。**口径（用户选定）= 完整存档**：本仓世界由 seed 确定性生成（红线 2）、存档只存 diff，故进度包 = `meta.seed` + `edits` store 全量 + `entities` store 全量。**不导逐格地形**（视距 8 的 289 列全量约上亿字符，而地形本就由 seed 重算）、**不导玩家位置**（消费它需要改出生点逻辑，与 `meta.spawn` 语义冲突）、**不导设置**（设备级，存 localStorage）。格式 `mc-heavy-progress` v1，**方块存名字而非数字 id**（id 是注册顺序的产物 → `blocks-data.js` 增删方块会让 id 存盘的包静默错位成别的方块）。新增 `save/progress-codec.js`（纯函数 `encodeProgress`/`decodeProgress`，无 DOM/three）+ `voxel/constants.js` 的 `decodeBlockIndex`（`blockIndex` 的逆，编码与其逆同处以防两处算术漂移）+ `Persistence.listEdits()`（cursor 全量遍历）+ `Game.exportProgress()`/`Game.importProgress()`。**两条静默失效类口径**：导出前必须 `flushNow`（内存 edits 才是真相，5s 防抖未到时导出的文件照样合法、只有导入后才发现少方块）、导入必须走 `_discardEdits()`（v1.29 的唯一丢弃入口，否则旧改动残留）。导入**覆盖式**（清空当前改动）且非原子（失败重试即可，不引入临时 store 交换）、**无二次确认**（用户批准时已知）。Tier 1 TDD：新增 `src/tests/test-progress.js`（17 条：坐标互逆全 y 抽样 / blockEntity 深比较往返 / 未知名字与越界与 key 不自洽分类 / 8 个包格式失败分支的 reason 与**零输出**）+ `src/tests/test-ui.js` 文案常量断言；E2E `tests/progress.spec.mjs` 5 条（导出下载内容含**刚放进内存**的方块 / 导入换 seed 且旧改动清零 / 4 个坏文件被拒且不重载 / busy 锁 / 面板两行布局与实测几何：主按钮 <100px、进度按钮各 >100px、`scrollWidth<=clientWidth` 文案不换行）。负向验证见实施记录。⚠️ 实测踩坑：`PANEL_CSS` 注释里写反引号会把模板字面量提前终止（`footer` 报 no-undef）——正是 CLAUDE.md 已记的那条，本次再中一次。**全量 E2E 136 用例 / 135 passed / 1 failed**（`m1-acceptance` 放挖压力），已按 `testing-policy §2.6 ①` 做**交替对照**：两侧各起独立 server + 独立 worktree（MOD/BASE 只差本次代码），用**同一个 spec** 交错各 3 轮 → **MOD 1/3 通过、BASE 1/3 通过**，失败均为已登记的两条 timer 贴线签名（`digP95` 2.0~2.1 vs 阈值 2；`frameMs.p95` 16.7000007 vs 16.7，即 `16.7±1e-6` 量化踩线）。另用**只差 100 次放挖的等价负载脚本**交错 3 轮：`frameP95` 两侧逐轮**完全相同**（25.7/25.6、25.4/25.4、25.1/25.1），fps 无可辨别差异 → **未改断言、未放宽阈值** |

## 活跃约束详情（历次改动沉淀的实测细节）

CLAUDE.md 只保留「会影响后续实现决策的活跃约束」的**结论**，实测细节与根因叙事在这里。
违反这些约束会引入回归或与设计文档冲突 —— 改相关代码前先查本段。

> **持续生效的架构口径仍在 CLAUDE.md**（形状唯一权威、`_discardEdits` 唯一入口、
> `WorkerPool.call` 返回形状、WebGPU 后端限制等）—— 那些不是历史记录，是实现约束，
> 不该搬进进度文档（没人改代码前去查进度文档找约束）。本段只承接**改动沉淀的实测细节**。

### 结构撒布（v1.37 / v1.38）

**四条撒布路径**（前三条是 M2 欠账，v1.37 补齐）：

| 路径 | 内容 |
|---|---|
| ① 城市撒布 | `flowerBed` / `pavilion` / `tallWell` / 城市 filler `house` |
| ② 城市外 `house` | 代码生成、非 JSON —— **草地上的房子在这里**（mc-lite `WorldWorker.js:2946`） |
| ③ 城市外大型静态结构 | `desertPyramid` / `desertVillage` / `uglyHouse` / `tank` |
| ④ `ship` 沉船 | 代码生成、**有意的水下结构**（v1.38） |

候选在 **region layout 层**算一次（`computeScatterCandidates`，DR-13「各 GEN Worker 只做
rasterize」），`apply.js` 阶段 2.7 只做 AABB 裁剪光栅化。唯一权威 = `src/gen/structures/scatter.js`。

**四处有意偏离 mc-lite，勿照原样改回**：

① `generateCodeHouse` 的材质/烟囱用 `seededRandom` 而非 mc-lite 的 `Math.random()`
（照搬会让同 seed 两次生成配色不同 → 违反红线 2）；

② 判定函数**不带「同类已占用」参数** —— mc-lite 靠 chunk 局部运行期 Set 防重叠，
移植成参数会让同一坐标在不同 column 得出不同结论 → 跨 column 光栅化接缝断裂（半个亭子）。
取舍依据实测：mc-lite 单 chunk 内同类命中 ≥2 仅 0.75% / 1.42%；

③ **「避开树」半径 = 2**（mc-lite house 8/10、pavilion-tallWell 5~7）—— mc-heavy 城市树
**无互斥**，密度 1.39%（mc-lite 约 0.44%，高 3 倍），照搬大半径会把撒布结构**全部挡掉**。
实测各半径保留率：`2→66~72%` / `7→2~3%` / `8~9→0%`；

④ **陆地**城市外候选一律不撒在水下（mc-lite 无此门控，会产出水下房子）。但 `ship` 沉船是
**有意的水下结构**（门控 `h < -6`，桅杆顶仍在水下 1~5 格）—— 两类门控**方向相反**，
勿把水下门控挪到 ship 判定之前（实测：挪了之后 ship 永不落地）。

**撒布密度刻意低于 mc-lite（勿调回去，会撞破冻结预算）**：城市撒布基值
`flowerBed 0.0005→0.00025`（`pavilion`/`tallWell` 按 ×6/×3 派生自动跟随），城市外大 JSON
`desertVillage 0.00016→0.00008` / `uglyHouse 0.00008→0.00004`。原因是两条**冻结断言**：
`structure-gen` 的 `genP95 < 8ms`（设计文档 §4.2）—— 大 JSON 1181/719 方块是光栅化大头；
`m3-fullscene` 的 `gpuVertexBytes < 150MB`（§4.10）—— 花坛/亭子的花与树叶走 cutout 通道。
**`house` 两类都不降**（opaque + 代码生成，不吃 cutout 预算、不是 p95 大头）。

**`ship` 沉船不看 biome/occupied（勿「补齐」门控）**：mc-lite 门控只有 `h < -6` + 概率 +
`safeForStructure`。实测 109 个命中里有 11 个（10%）带植被、分布在 4 个 biome
（AZALEA / FOREST / PLAINS / SWAMP，**无 DESERT** —— DESERT 高度被 `h*0.5+2` 抬高，
不会低于 -6）。给它补 biome/occupied 门控会让命中数掉到 98 且沙漠永不出沉船。

**`ship` 的落地测试须用桅杆判据，不能用 footprint 范围判据**：footprint 5×7 覆盖多格、
每格地形高度不同（有些高到 y+3），海底 `clay`/`sand`/`end_stone` 会落进扫描范围 → 判据恒 >0
（实测踩坑：注入「`CODE_GENERATORS` 漏 ship」后仍全绿，无效负向验证；排除 water 也不够）。
正确判据 = 桅杆中心列 `(x, y..y+4, z)` 的 5 格 `wood`（门控保证地形顶 ≤ y-1，桅杆必在地形上）。

### 渲染与容量（v1.42 / v1.37 / v1.30 / v1.31）

**cutout 扩容是离散 ×1.5 跳增，容量须留足余量**：`render-world.js _ensureCapacity` 里
reserved 峰值只要超过 `maxVerts` **一个顶点**就整批跳到 ×1.5（1.8M→2.7M = +27MB，且粘性不回缩）。
撒布把 cutout 峰值推到 1.80M，故 `CAPACITY.cutout.active` 从 450 调到 **550**
（maxVerts→2.2M，三通道合计 148MB < 150MB，余量 22%）。往 cutout 通道加方块量
（新植被/新结构）时须重测峰值并重标定 —— 差一点就会触发扩容撞破内存预算。

**lilypad 的几何与格位是耦合的，改一处必须同时改另一处**（v1.30）：只改模板 y → 叶面悬空半格；
只改生成格位 → 叶面贴块底仍沉水。水面下沉 0.5 后暴露水面顶面只有**半格高**，与陆地整格顶面差
半格 —— 同一份几何无法同时贴合，故 `big_house.json` 的 3 个草地 lilypad 已移除
（「`assets/structures/*.json` 原样复用」的唯一有意例外）。

**六处已知的有意偏离 mc-lite**（视觉比对时勿按其原样判定）：①~⑤ 的完整清单与理由在设计文档
§4.3 / §4.5.4，此处只列索引 —— ① `vine` 落格内 y∈[0,1]；② 吊灯 UV 按部件分区 + 绳呈单色
深灰；③ 背包图标用离线烘焙等轴测投影；④ `lilypad` 模板 y=-0.48 + 生成格位 `SEA_Y+1`；
⑤ `getAO` 去掉对角门控（副作用**全局**：所有「仅对角遮挡」顶点暗一档 —— 悬浮方块斜对角、
台阶斜接处，原版 MC 故意让这些不变暗）。⑥ **不在设计文档那两节** —— 理由在独立 spec
[`2026-09-20-sky-tree-design.md`](superpowers/specs/2026-09-20-sky-tree-design.md) §2.6.3：
`sky_leaves` 遮挡 AO / 阻断 blocklight / 阻挡炮塔 LOS（mc-lite 因 `isTransparent=true` 三者皆不），
是 v1.42 方案 C（`opaqueTable=1`）的连带效应。

**丧尸头部图案走单纹理 UV 分区，不是材质数组 + groups**（2026-09-09）：实测
`three.webgpu.js:34592` `getMaterial()` 直接 `return material`，不遍历 `geometry.groups`、
不取 `materialIndex` → 六面恒用 `material[0]`，照 mc-lite 的「正面单独一张纹理」写法会
**静默只渲染第一张**（正面看不到眼睛，不报错）。WebGL 后端 `:30472` 则按 group 分次 draw
→ 是 WebGPU 后端刻意不实现。替代 = 单材质 + 单纹理 + UV 分区（纹理双区并排 128×64，
正面顶点 UV → 右半）。连带好处：draw call 仍是 6，不是材质数组方案的 7。
图案参数实测自 mc-lite `:99-119`，注意 **`noiseProbability: 0.7` 的判定是 `> 0.7` 才用噪点
→ 实际仅 30%**（照字段名理解会把图案画反；烘焙后实测噪点比例 32.8% 证实语义没反）。

**丧尸互斥须换算单位 + 补完全重叠 tie-break**（2026-09-09）：mc-lite 的排斥力在 AI 层
（`EnemyWorker.js:131-155`，`minDistance 1.2` / `repulsionStrength 0.05`）叠加进 velocity。
照搬有两个实测必需的偏离：

① **`repulsionStrength` 换算 ×60**（`0.05` → `3.0`）—— mc-lite 是**格/帧**单位
（`predictNextPosition` 不乘 dt，`Zombie.js:302-305`），mc-heavy 物理层乘 dt → **格/秒**，
与 `ZOMBIE.speed` 的 `0.02×60=1.2` 同口径。不换算实测：排斥力只有追逐力的 4% → 压不住收敛
（24 只最小间距仍降到 0.003、21 对重叠，与无排斥对照组几乎相同）；换算后降到 0.439 / 1 对；

② **补 tie-break** —— mc-lite 判定 `distance > 0.001` 完全重叠时跳过不推开，在它那侧无害
（靠 S 路线随机偏移角 `:186-207` 让丧尸不会精确同点），但 mc-heavy 的 AI 是纯直线追逐 →
**永久死锁**（实测 20 只强制同点生成后 3 秒仍 min=0、190 对全重叠）。补法 = id 派生确定性方向
（黄金角散列 + id 序定符号 → 同位置两只必然朝相反方向；用 id 派生而非 `Math.random()`：
可测 + 无帧间抖动）。

**天空树 / `sky_leaves` 通道（v1.42）**：

- **判断方块的渲染语义必须同时读 mc-lite 的 `MaterialManager` 注册（材质层）与 `BlockData`
  （数据层），不能只看 mc-heavy 的 `cullMode`** —— 后者是前者的**转换产物**，而转换规则
  （`blocks-data.js:6`「名字含 leaves → cutout」）本身可能有偏差。`cullMode`（渲染通道）与
  `isTransparent`（面剔除语义）是**两套口径**（M2 勘误已记）。实测踩坑：`sky_leaves` 被
  判定为镂空材质并据此做了一整节容量分析，实际 mc-lite 是 `mkMat(...,0.9)` 无 `alphaTest`
  → 是用户凭观感质疑（「我记得有点半透明效果」）才发现。**同 CLAUDE.md 既有约束
  「对齐上游须实测其运行时行为，不能读定义推断」。**
- **`sky_leaves` 的贴图 alpha 0.9 不被消费，保留不改**：opaque 通道材质 `transparent=false`
  → 不做 alpha 混合。改成 255 视觉完全相同，但会改变 tile 像素 → 触发 atlas 重打包 +
  图标指纹变化 + 重跑 `npm run atlas`/`npm run icons`，**收益为零**。
  `bake-procedural-textures.mjs:139` 已加注释说明，勿「顺手修正」。
- **改 `cullMode` 不需要重跑 `npm run icons`**：图标指纹只含 `geometry` + tile 地址 +
  tile 像素 hash（`tools/icon-fingerprint.mjs:118-134`），**不含 `cullMode`**；
  `iso-icon.js` 也不读 `opaqueTable`/`cullTable`（纯几何投影，无面剔除）。
- **cutout 与 cutout 之间不互相剔除**（`mesher.js:464` 判据是 `opaqueTable[neighborId]===1`，
  cutout 方块的 `opaqueTable=0`；`:465` 的同类剔除只对 `cullMode>=2` 或 `SAME_TYPE_CULL`
  （仅 `cloud`）生效）。实测：两格相邻 `sky_leaves`（cutout 时）= 48 顶点（6 面/格，零剔除），
  纯 3×3×3 叶团 = 648 顶点（162 面，**一面不剔**）；同体积实心 `stone` = 216 顶点（54 面）。
  **即 cutout 每格成本是 opaque 实心团的约 3 倍** —— 往 cutout 加方块量前须先算这笔账。
- **`opaqueTable=1` 会带来三项连带效应**（不止面剔除）：AO 遮挡（`mesher.js:436-438,500-502`）、
  blocklight 阻断（`lighting.js:165`）、炮塔 LOS / 弹丸阻挡（`turret-system.js:31`）。
  改任何方块的 `cullMode` 到 opaque 前须评估这三项。**若只要面剔除不要连带效应**，
  用 `cloud` 的手法：`cullMode:"opaque"` + `opaque:false`（→ `opaqueTable=0`）+
  `mesher.js:288` 的 `SAME_TYPE_CULL` 加该方块名（spec 的方案 E）。
  ⚠️ **方案 E 治不了 GEN 侧成本** —— GEN 阶段根本不读 `cullMode`，故它对 `writeSkyTrees`
  的生成耗时零影响（v1.42 实测确认，spec §5.3 的回退选项因此不含「治 genP95」）。
- **BatchedMesh 的 draw call 不是「每通道 1 次」**：WebGPU 后端对**每个可见 geometry slot
  各发一次 draw**（`three.webgpu.js:85531`）。实测 v1.42 天空树让 bench 场景 ④ 的 draw
  530 → **545（+15）** —— 树新增可见 opaque slot 即增 draw。⚠️ 勘查期按「合批进既有 3 通道」
  推断「draw call +0」，**已被实测证伪**：往通道里加新几何前不要假设 draw 不变。
- **`vegetation.js` 的 `surrounded` 生成期跳过在 opaque 叶块下是「反向悲观化」，但刻意不修**
  （v1.42 实测，spec §2.5.2）：被六邻树块包围的叶格 —— **写入**时自己 6 面全被剔 +
  邻居朝它的面也被剔 = **0 面**；**跳过（留 air）**时 6 个邻居各朝 air 出 1 面 = **6 面**。
  即 `opaqueTable=1` 后跳过反而**多**出 6 面/格（cutout 下方向相反，跳过是真优化）。
  实测规模：region[-1,1]² 的 7379 棵树净增 32,430 面（**+2.8%** 树面数）。
  **换算到验收口径（vd=8）只值约 780 面 ≈ 3.1K 顶点 = 总面数的 0.11%**，而修它须动
  Worker 同构层的共享函数（**地面树也走它**）+ 改变既有地面树方块数据 + 重跑全部勘定实测
  → **收益与代价不成比例，按「实测数据决定是否优化」取甲（零改动）**。
  ⚠️ 后人看到这条**不要当成漏掉的优化顺手补上**；若将来 opaque 通道逼近容量临界，
  另开任务做乙方案（条件化跳过：仅当叶块 `opaqueTable === 0` 时才跳）。
  ⚠️ **测试侧不得抄一份树叶判定**：模拟必须直接调真实 `generateTree`（红线 8 同源要求），
  否则将来改 `vegetation.js` 时测试会静默漂移出假失败。
- **结构写入无占用格守卫（后写胜），与 mc-lite 偏离 —— 既有的全局偏离，v1.42 实测量化**：
  `makeColumnSetter`（`landmarks.js:268-278`）**无条件覆盖**目标格，而 mc-lite 的
  `fakeChunk.add`（`WorldWorker.js:532-538` / `:1508-1518`）**有守卫**（该格已有非空气方块则
  `return`，先写胜）。实测后果：天空树的树干格被邻树树冠覆盖成 `sky_leaves`，
  **覆盖率随密度变**（region [-2,2]² 实测 1300 岛：密度 `SKY_TREE_CHANCE=0.05`（当前）时
  **13.2%**（40228 树干格中 5309 被覆盖）；密度 0.1（mc-lite 口径）时 **21.4%**
  —— spec §2.5.1 的原始实测）。⚠️ **引用该百分比须注明密度口径**。⚠️ 这**不是天空树任务引入的**（地面树/所有结构路径走同一个
  `makeColumnSetter`），**本次不修**（加守卫会改变全部结构路径的行为与既有世界内容 →
  视觉比对基准变化）。但**写结构类断言时不得假设「每个结构都完整」**（用忠实写入顺序模拟，
  spec §6.2 第 4 条）。若将来要对齐 mc-lite，需单独开 Epic 评估影响面。
  ⚠️ 该项**不进上面那个「六处偏离」清单** —— 那个清单是**视觉比对专用**，而占用格守卫是
  **结构写入语义**的全局偏离（影响全部结构路径，不只空岛、不只视觉）。

### seededRandom 的 salt 分配（v1.42）

**salt 占用不能按注释里的字面基值判断** —— 带 `+ step` / `+ k` / `+ y` 偏移的调用点实际占用的是
**区间**。新增随机量前须**程序化扫描**（展开所有派生区间），不能 grep 字面量。

| 来源 | 字面 | 实际占用区间 |
|---|---|---|
| `sky-structures.js` 云簇 frontier | `seed + 58 + step`，`step < size`，`size = 30 + floor(r*21)` | **58..107** |
| `terrain.js:100` 地层 | `seed + 100 + k`，`k = 2..12` | **102..112** |
| `landmarks.js:239` 岩石类型 | `seed + 302 + y`，`y ∈ [-32, 96)` | **270..397** |
| `landmarks.js:252` | `seed + 303 + k`，`k = 1..11` | 304..314 |
| `vegetation.js` treeRand | `seed + salt`，salt ∈ {401..407}；调用处再 `+ ly*7` | 401..407（+ 派生） |

实测（seed=12345，展开全部派生区间）：`1..500` 内共 **234 个已占用 salt**，连续空闲带为
`6..9`、`27..49`、`113..199`（87 个）、`202..269`（68 个）、`398..400`、`408..500`（93 个）。
天空树取 **113**（紧跟空中结构族：岛 50..57 / 云簇 58..107）。

⚠️ **实测踩坑**：`sky-structures.js` 的注释写「frontier 每一步 `seed+58` 加步号」，
容易读成「云簇只占用 58」→ 顺手取 59。**59 已被占用**（在 58..107 内）。
若真用了 59，树的位置判定会与云簇形状游走共用同一随机流 → 两者相关（不是崩溃，
是**静默的确定性污染**，且单测全绿 —— 因为两侧都用同一个错 salt）。

### 面板与 UI（v1.35）

**破坏性按钮的常态文案只有一份**（`settings-panel.js` 的 `CLEAR_SAVE_LABEL`）：构造与
`_resetDangerArmed()` 复位共用同一常量。实测踩坑：复位函数写死旧长文案会覆盖构造时的短文案
→ 面板打开后显示复位那份，构造代码形同虚设（肉眼看不出哪个是「真相」）。

**面板列分隔线规则只作用于 `.mc-item`，不得通配所有子项**：写 `.mc-column > :first-child`
会连带抹掉 `.mc-combined` 合并盒自己的装饰边框（特异性 1,2,0 压过 1,1,0 → 上边框 `none`，
方框缺一边；用户实玩报告，观感上只是「少一条线」，肉眼看不出是特异性冲突）。往面板加新容器
类型时须同步考虑这条选择器。

**面板按钮基线是 `flex: 1`（等宽铺满），「变窄」只能在作用域内覆写**（v1.43）：
`.mc-footer` 的「确定」按钮与全部档位按钮都靠这条基线，改基线会连带改掉它们的宽度。
创造台主按钮的做法是给它一个 `mc-narrow` 类 + `#settings-modal button.mc-narrow { flex: 0 0 88px; }`
（作用域内覆写，优先级由 id + class 保证）。实测：面板每列约 351px，
「打开创造台」5 个汉字约 68px；88px 下 `scrollWidth === clientWidth`（文案不换行）。

**同一行里的两个「重活」按钮不得共用一把 busy 锁**：面板已有 `_playgroundBusy`
（创造台 2916 格写入），进度导入导出另有 `_progressBusy`。共用会让模型导入/导出的
**异步文件读取**与进度操作互相吞掉对方的操作（先点的那次被后来者直接 `return` 掉），
而按钮看上去均已被点过。

### 出生点与刷怪（M6）

**`findSpawnY`（`gen/terrain.js:98`）会把空中结构当出生点**：它从世界顶向下扫第一个非空气方块
并返回 `y+1`，而 M2-7 云层 `supportsPlayer=1` 但 `solid=0` → 随机 seed 下玩家可能出生在云面上
（实测 6 次试验 1 次 y=56、`belowSolid=false`）。后果：**云面上不会自然刷怪**（丧尸 spawn
要求脚下 solid），且测试落点扫描须**向下扫真实地面**而非用玩家 y±4。
未改该函数（属 M1/M2 出生点口径，改动会牵动 M1 验收与既有 spec）。

### 方块锚定装置与 blockEntity 持久层（M7）

**GEN 接管必须走 `restoreEdits` 而非只搬 typed buffer**（既有 bug，M7 修掉）：
`Scheduler._onGenResult` 新建 column 时若留空 `column.edits`，玩家在该 column 新放一块后
`flushNow()` 会用「只含新编辑」的 Map 整行 `put` 覆盖该 key 的存档 → **旧 edits（含锚点）
静默丢失**。方块层面看不出差别（Worker 内 `applyEdits` 已把 edits 叠进 blocks/meta，
渲染正确）—— 丢的是持久层。分工：`restoreEdits` = 主线程有状态重放（重建 blocks/meta +
`blockEntities` + `edits` 三者）；`applyEdits` = Worker 内无状态版本（只写 typed 数组）。

**编辑热路径每格的坐标换算只做一次**：`getBlockId`/`getBlockMeta`/`getBlockEntity` 各自
重算 cx/cz/columnKey/Map.get/blockIndex —— 逐个调等于同一换算做三遍。实测后果：
`bench --check` 阻断 `[回退 11.1%] 场景 ④ frameP95 9→10`。改用 `WorldData.readCell(x,y,z)`
一次读出三项。改编辑路径前先看这个方法，**不要退化成分别调三个 getter**。

**装配时序：玩法服务的 controller 接线必须在 `_waitForColumn` 之前**（实测踩坑）：
出生点 column 在 `_waitForColumn` 时 ready，`onColumnReady` 回调随之触发。若 `this.nests`
创建在 `_waitForColumn` **之后**（如武器运行时装配段），回调跑时它还是 null →
`_createNestControllers` 第一行直接 return → reload 后 anchor 与索引都恢复了（`count=1`、
column.blockEntities 里有锚点），但 controller 恒为 0（装置不工作）。对照 `this.zombies`：
它装配在 `_waitForColumn` 之前，故同样的 column ready 路径正常 —— **顺序差异是唯一原因**。
诊断手法：读「column.blockEntities 有锚点吗 / 索引有它吗 / controller 有它吗」三者，
只有 controller 缺失即时序问题（不要猜）。

**派生 controller 的去重不能用 `controllers().size` 断言**（实测无效盲区）：
`_controllers` 是按 id 为键的 Map，重复创建会**覆盖写** → size 恒为 1，注入「不去重」后
size 断言仍全绿。去重的真实价值是防止创建多余 controller 对象（旧对象没 `dispose` →
world/zombies/editor 引用泄漏）。故断言须比较**对象引用**（`first === second`）+
原对象未被 dispose。

**上限判定必须来自 edits store，不能来自已加载 controller 数量**（M7 规格 §2）：
远处装置的 column 可能未加载（无 controller），用 controller 数判上限会让玩家走远再回来
就能无限放置。走 `Persistence.listBlockEntities(kind)` 的 IndexedDB cursor 扫库。
⚠️ hydrate 是 `clear()+重建`：调用前必须先 `flushNow()`，否则库里没有锚点 → 索引被清成 0
（真实重启路径本就是 flush → reload → hydrate）。

**失效判定必须比对 `newId !== critical.id`，不能只看坐标覆盖**：装置每次刷怪都用
`setBlockEntity` 写回时钟（`lastSpawnAt`），若判定只看「坐标覆盖关键格」，自己的时钟写回
就会把装置杀掉。

## 第二阶段依赖链

```
M4 玩家武器 ──▶ M5 实体运行时 ──▶ M6 丧尸 ──▶ M7 玩家放置丧尸巢穴
（WorldEditor      （EntityManager     （M5 临时实体     （blockEntities 锚点
  + DDA hitscan）    + 实体 raycast）    + M4 武器伤害）   + M6 刷怪）
```

四者**严格串行**（每个 Epic 依赖前一个的运行时底座）。**四个 Epic 已全部交付并验收**
（M4 2026-09-05 / M5 09-07 / M6 09-08 / M7 09-10）。每个 Epic 有成对的规格与计划：
`docs/superpowers/specs/2026-08-23-m{4,5,6,7}-*-design.md` +
`docs/superpowers/plans/2026-08-23-m{4,5,6,7}-*.md`，实测数据与偏离表在各自的
`docs/m{4,5,6,7}-*-acceptance-report.md`。

下方「跨 Epic 的已知前置条件」是 M4 实施时记录的、当时尚未交付的前置项 —— 现已全部满足，
保留作架构细节参照（后续同类改动仍须遵守，如放置路径不得退化为只传 id）。

**跨 Epic 的已知前置条件**（实施时勿遗漏）：

- M4 Task 6 将 `digBlock()`/`placeBlock()` 改走 `editor.setBlock(...)` 时**须保留朝向分支**
  （M3.2 交付的语义，不得退化为只传 id）；
- M4 Task 6 挂 KeyR 切武器依赖 M3.1 交付的 `uiModal` keydown 守卫；
- M4 plan Task 2 的 `getBlockMeta` 已由 M3.2 **提前交付**，改为「验证已交付 + 补断言」。

## 第三阶段依赖链（M8 → M9，已完成）

```
M8 TNT 爆炸 / 炮塔弹丸 ──▶ M9 创造台（playground）
（indestructibleTable 单一权威       （复用 M8 的 indestructibleTable，
  + WorldEditor.setBlocks 爆炸         追加创造台两项 + 移出背包；
  + 炮塔方块锚定装置 + M5 弹丸）        平台走 setBlocks 真实方块 + 锚点）
```

两者**串行且均已完成**：M9 依赖 M8 交付的 `indestructibleTable`。⚠️ **拆分依据**：M8 只登记 `bedrock`，
创造台两项留在 M9 —— 因为「登记 `indestructible`」与「移出背包」必须成对做，只登记不移出会
立刻产出「玩家放得出来但挖不掉、TNT 也炸不掉」的撕裂状态（M8 期间没有创造台功能可批量删）。
规格与计划（经四轮审查定稿）：
`docs/superpowers/specs/2026-09-11-m8-tnt-turret-design.md` +
`docs/superpowers/plans/2026-09-11-m8-tnt-turret.md`、
`docs/superpowers/specs/2026-09-11-m9-playground-design.md` +
`docs/superpowers/plans/2026-09-11-m9-playground.md`。
设计文档目标版本号：M8 → v1.39、M9 → v1.40（v1.36~v1.38 已被独立改动表占用）。

## 后续扩展点（M7 之后，按阶段加入）

| 功能 | 引擎接入点 |
|---|---|
| TNT / 爆炸 | `WorldEditor.setBlocks(batch)` + REMESH + 球体扩张特效（无粒子系统）—— **M8 已规划** |
| 炮塔 / 飞行弹丸 | M5 `EntityManager` + 实体 raycast + **M7 方块锚定装置模式**（见下）—— **M8 已规划** |
| 矿车 / 轨道 ✅ | **已交付**（2026-09-30）—— 实际走了 M5 实体运行时（`minecartDefinition` 持久实体 + `MinecartService` + InstancedMesh 渲染 + `EntityManager.raycast` 命中），**不是**表里原写的 `interact` / `onStep` 钩子（这两个钩子始终未实现，矿车交互走玩家输入分流 + 实体 raycast） |
| 创造台 ✅ | `WorldEditor.setBlocks` 真实方块 + `blockEntity` 锚点（M7 装置模式的持久层半边）—— **M9 已交付** |
| 灯 / 光源 | emissive 属性 + blocklight flood fill（光照管线已含） |
| 床 / 宝箱 / 门 | 多方块结构 + meta/orientation 位 + `blockEntities` 通道 + 交互事件 |
| 音频 | AudioManager + `block-changed` / 交互事件总线 |
| 存档迁移 | save/codec 的 `schemaVersion` 机制。⚠️ **与 v1.43 的「进度包」不是同一件事**（见独立改动表）：进度包是**同版本内**的存档搬运与备份（`mc-heavy-progress` v1），迁移工具要处理**跨版本**的方块/结构语义变化，两者目标不同、格式也不共用 |
| 玩家生存战斗 | M5 `EntityManager` + 玩家状态/HUD（独立 PlayerVitals Epic） |

**新功能必须通过上述接入点实现，不得绕过 meshing/数据/事件管线另开路径。**

### M7 交付的可复用模式：方块锚定装置（炮塔等可直接套用）

M7 建立了一套「方块锚定的持久装置」模式，未来炮塔 / 矿车站 / 创造台等同类装置可直接复用，
不必另开持久化路径：

（**M8 炮塔与 M9 创造台是这套模式的头两个具体消费者** —— M8 规格 §3 / M9 规格 §2 均按此模式
设计，复用 `blockEntity` 锚点 + `listBlockEntities` 扫库判上限，不另开持久化路径。）

- **持久真相 = 某格的 `blockEntity`**（经 edits diff 落盘，无需第二份 store —— 红线 1）；
- **派生 controller 只在 anchor column 已加载时存在**：column 卸载即销毁、重载即从 blockEntity
  恢复（`lastSpawnAt` 等运行态不重置）；
- **失效走 `block-changed` 增量事件**：徒手 / 武器 / TNT 批量编辑共用同一编辑入口 → 失效语义
  天然同义，无需为每种破坏方式写专属判定；
- **全局上限经 `listBlockEntities(kind)` 扫库判定**（跨 column 卸载与重启仍有效）；
- ⚠️ 接线时务必避开两条 M7 实测踩过的坑（详见「活跃约束详情 · 方块锚定装置」段）：
  ① controller 接线必须在 `_waitForColumn` 之前；② 去重断言不能用 `controllers().size`。

## 验收口径

第一阶段目标表（冷启动 <2s / 视距 8 chunk / 120Hz ≥90fps / 跨 region 无感知 / 放挖 <2ms /
存档 KB 级）见设计文档 §1，**6 项全达标**（实测报告 `docs/m2-m3-performance-report.md`，
= 冻结基线）。mc-lite 对比：视距 ~4×、启动数十~百倍、存档 ~千倍。

每个里程碑结束跑基线，**性能回退 >10% 即阻断合入**（结构类 2%）。

## 去哪找细节

| 想知道 | 看 |
|---|---|
| 架构决策、子系统边界、DR 决策、历次口径变更 | `docs/phase-1-engine-design.md`（**架构唯一权威**；版本号以文档自身首行为准，此处不硬编码以免漂移） |
| 某次改动为什么这么改、实测数据、门禁对照 | 设计文档对应版本的修订说明 + `docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md` |
| **历次改动沉淀的活跃约束实测细节**（撒布四处偏离 / cutout 标定 / ship 门控 / 丧尸互斥换算 / 天空树与 `sky_leaves` 通道 / seededRandom 的 salt 分配等） | 本文「活跃约束详情」段 |
| 任务级执行清单、依赖关系、验收步骤 | `docs/superpowers/plans/`（各里程碑计划） |
| 该不该写测试、跑哪个门禁、断言落点怎么避坑 | `docs/testing-policy.md`（**测试分级唯一权威**；§2.5~§2.7 是断言落点踩坑清单） |
| 重构红线、对标 mc-lite 的取舍、**持续生效的架构口径** | `CLAUDE.md`（协作规范） |
| 实测报告 | `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` / `docs/m2-m3-performance-report.md` / `docs/m2-seed12345-comparison.md` |
| M4~M7 验收报告（第二阶段各 Epic 实测 + 负向验证 + 偏离表） | `docs/m{4,5,6,7}-*-acceptance-report.md` |
| M8 / M9 验收报告（第三阶段各 Epic 实测 + 负向验证 + 偏离表 + 操作失误记录） | `docs/m8-tnt-turret-acceptance-report.md` / `docs/m9-playground-acceptance-report.md` |
| 矿车 Epic 的设计与任务级清单（含偏离 mc-lite 清单，§6 预登记） | `docs/superpowers/specs/2026-09-30-minecart-design.md` + `docs/superpowers/plans/2026-09-30-minecart.md` |
| 性能基线当前值 | `docs/m3-baseline.md`（`npm run bench` 自动生成，勿手改） |
| 测试用例数、图标项数等计数 | **以 `npm run check:data` 输出为准**，不在文档硬编码 |
