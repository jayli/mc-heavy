# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

本文件为 mc-heavy 仓库（`~/jaylli/mc-heavy`）的协作规范。所有解释、说明、对话请使用中文，代码注释尽量使用中文。

## 项目定位

mc-heavy 是一个**从零重写**的 Minecraft 风格体素游戏引擎。功能对标姊妹仓库
[mc-lite](/Users/bachi/jaylli/mc-lite)（995 次提交、约 5.5 万行 JS、124 种方块），但架构完全不同：

- mc-lite 是「功能驱动 + 补丁叠加」长出来的，性能天花板已锁死（视距 2~3 chunk、预生成数十秒、
  扩图卡顿、奔跑掉帧）；
- mc-heavy 的目标是**保持同样的玩法功能**，用更鲁棒、更可扩展、更高性能的引擎底座重做一遍；
  第一阶段做引擎底座（M0~M3）。M3 性能报告验收后，第二阶段先按 M4 玩家武器 → M5 实体运行时
  → M6 丧尸 → M7 玩家放置丧尸巢穴的独立 Epic 链推进；矿车、炮塔、TNT、创造台等继续按后续阶段加入。

**mc-lite 的地位是「功能与数据来源」，不是「实现蓝本」。** 读它的代码时只提取
「功能语义、算法、数据、视觉风格」，禁止照搬它的架构组织方式（详见下文「对标 mc-lite」）。

## 当前进度

**项目进度的唯一总览是 [`docs/roadmap.md`](docs/roadmap.md)**（里程碑总表 M0~M9 + 第二阶段
依赖链 + 第三阶段依赖链（M8→M9）+ 后续扩展点）。本文件不复制进度表 ——
同一事实的多个副本会漂移。

一句话现状：第一阶段 M0~M3 + 两个收尾补丁项已完成；**第二阶段 M4~M7 全部完成并验收**
（M7 玩家放置丧尸巢穴，验收报告 `docs/m7-zombie-nests-acceptance-report.md`）——
Epic 链 M4→M5→M6→M7 已全部交付。**第三阶段 M8（TNT 爆炸 / 炮塔弹丸）与 M9（创造台）
均已完成并验收**（验收报告 `docs/m8-tnt-turret-acceptance-report.md` /
`docs/m9-playground-acceptance-report.md`）。**M9 之后的矿车 Epic 也已交付**
（验收报告 `docs/minecart-acceptance-report.md`，2026-10-01 补写 —— Epic 交付时漏写，
由 issue #3 审核指出）。**矿车之后的太阳阴影（shadow map）也已落地**（独立改动 v1.44，
及 v1.45/v1.46/v1.47 三次实玩反馈修复）；此后 **v1.48 补上了第一人称手臂与跑动视角晃动**，**v1.49** 按实玩反馈上调了晃动幅度
并补上相机 roll/pitch、把手臂挥动改为原版双曲线多轴；**v1.50** 再把晃动幅度回调
（0.09→0.07，旋转同步降）并把挖掘挥手改为「试图即挥手」（挖空气/挖基岩也挥）；
**v1.51** 按实玩反馈去掉镜头晃动的全部旋转（只保留位置平移 —— 跑动时地平线永不歪）；
**v1.52** 把晃动改为**距离驱动**、频率对齐原版疾跑步频（1.684Hz / 每步 297ms），
振幅按原版口径（x=sin·bob·0.5、y 只向下）；**v1.53** 按实玩反馈把幅度上调到 0.13；
**v1.54** 把步频放慢到 1.5Hz，**v1.55** 再降一档到 1.35Hz（每步 370ms，已接近「在跑」下界）；
**v1.56** 给手臂加了烘焙面明暗（保持 unlit），**v1.57** 修掉「手臂颜色过于暗」（明暗系数直接
乘基色会把肤色压到 0.20~0.48 → 改为「参考色锚定」重映射 + sRGB→线性）并把晃动幅度提到 0.15；
**v1.58** 给体素材质接了**太阳 N·L 方向光**（修掉「光影平淡」的根因：unlit 下方块六面亮度
完全相同），并搬入 mc-lite 的**天空盒**（白天云图 / 夜空星空双立方图交叉淡入）+ 日轮月轮。
**v1.59** 接了**雾色融入天空**（面板左列「环境风格」下方「雾色」开关，默认关）：雾色不再是固定 `0x87ceeb`，
而是按**方位角**采样天空盒（俯角一律归到地平线带）——远景方块融进它背后那片天。
**v1.60** 重做了**夜空天空盒**（mc-lite `skyBox1` 六面各自独立生成 → 12 条共享边平均 RMS 落差
41.09 而白天只有 1.90 → 天空被笔直暗线切成方块感；改为方向空间加权重采样重烘焙，接缝 1.865）。
**v1.61** 修了**夜间雾色失效**（night 风格 `fogScale=4.0` 把雾距推到 608 格 > 世界加载半径 160 →
夜里无物可染；统一为 1.0）。
进度与实测数据一律查 roadmap。里程碑状态、验收报告、遗留 TODO 的
完整清单**一律查 roadmap** —— 此处不复制（复制就会漂移）。

**历次 bugfix / 改造的完整记录不在本文件。** 权威副本：**第一阶段独立改动**在设计文档修订说明 +
`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`（版本区间见 roadmap 的改动表）；
M4 之后的实玩反馈修正在各里程碑验收报告的偏离表 + roadmap 的「遗留 TODO」段
（**不进**设计文档修订说明，也不 bump 设计文档版本号 —— 那是架构口径变更专用）。
本文件只保留**会影响后续实现决策的活跃约束**（下节）。

测试现状：Playwright spec 全量 + 浏览器内单元测试全绿。**用例计数以 `npm run check:data`
输出为准，不在文档硬编码**（同一事实的多个副本属「改动放大器」，违反红线 1 精神）。
⚠️ **三条计时型 spec 在高负载下偶发贴线 flaky，单独复跑通过**（不改断言、不放宽阈值）：
`m1-acceptance`（放挖 p95，16.7±1e-6 / 2.1ms）、`m3-rain`（截图差分）、
`weapons-world-edit`（200 次射击计数 —— 等待 95ms vs 冷却 90ms，余量 5ms < 一个 vsync 量子
8.33ms，少渲染一帧就计 199）。同类根因还有 bench 的两条计时门禁：场景 ④ frameP95
（9↔10 的 vsync 量子边界）与场景 ③ uploadMsP95/fastRemeshP95（**抖动源是 GC 与 0.1ms
测量精度，不是 vsync** —— `src/ui/hotbar.js:40` 早已记录 GC 压力令 fast-remesh p95
1.1→1.3ms；基线 0.6/1.1ms 对 10% 容差只剩 0.06/0.11ms 余量）。**门禁阻断时先做交替对照，
不要看单次数值**（实测：MOD/BASE 交错各 3 轮，两侧中位相同、各阻断 1/3 轮）。
完整清单与四次实例见 roadmap「M8 / M9 之后的遗留 TODO」首条。

### 活跃约束（历次改动沉淀，会影响后续实现决策）

这些不是历史记录，是**仍在生效的口径**。违反会引入回归或与设计文档冲突。

- **实例原点换算基准（极易误判几何差异）**：mc-lite 几何以**块中心**为原点，四条放置路径全部
  `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
  `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。
  **比对 mc-lite 几何数字时必须 +0.5 换算。**
- **对齐上游须实测其运行时行为，不能读定义推断**：mc-lite 床材质的 `offset:[0,0.5]` /
  `rotation:-π/2` 全仓**零消费点**（死字段），照字段名实现会渲错。与「诊断 bug 不猜」同一原则。
- **六处已知的有意偏离 mc-lite**（视觉比对时勿按其原样判定）—— ①~⑤ 的完整清单与理由在设计文档
  §4.3 / §4.5.4，索引见 roadmap「活跃约束详情」的渲染与容量段：① `vine` 落格内；② 吊灯 UV 分区 +
  绳单色深灰；③ 背包图标离线烘焙等轴测；④ `lilypad` 模板 y=-0.48 + 格位 `SEA_Y+1`；
  ⑤ `getAO` 去掉对角门控（副作用**全局**：所有「仅对角遮挡」顶点暗一档）。⑥ **不在设计文档那两节**，
  理由在独立 spec `docs/superpowers/specs/2026-09-20-sky-tree-design.md` §2.6.3：`sky_leaves` 遮挡 AO /
  阻断 blocklight / 阻挡炮塔 LOS（mc-lite 因 `isTransparent=true` 三者皆不）—— v1.42 方案 C
  （`opaqueTable=1`）的连带效应。
- **lilypad 的几何与格位是耦合的，改一处必须同时改另一处** —— 细节见 roadmap 同段。
- **水面遮罩判据的唯一权威 = `src/render/ocean-mask.js`**（阈值 + 五点纵深 + 城市 bounds
  门控）：`ocean.js` 的 TSL 着色器是**同构实现**（TSL 无法调 JS 函数），数值常量须从
  `gen/terrain.js` 的 `TERRAIN_HEIGHT_PARAMS` 与 `gen/noise.js` 的 `BIOME_PARAMS` 读 ——
  各写一份字面量会漂移出「单测说该渲染、GPU 实际没渲染」的撕裂（红线 1；M6 同教训）。
  **遮罩高度 = 真实生成高度 `generateHeight`（不是 mc-lite 的基础噪声近似）**，阈值 = `SEA_Y`
  —— 整数高度下 `h < SEA_Y` ⟺ `h <= SEA_Y-1`，正是 `fillColumn` 的水体方块判据（判据同源，
  不需要「floor 余量」这类补偿项）。**改水体判据/地形高度公式时须同步标定遮罩阈值**，
  否则会漂移出「陆地上出现假水面 / 真实湖泊失去水面」。这是一处新的有意偏离 mc-lite
  （**不并入** §4.3 / §4.5.4 那个视觉比对专用清单）—— 理由与实测数据见设计文档 §4.7。
- **城市 bounds 门控与 `generateCity` 的水体补实是耦合的，改一处必须同时改另一处**：
  门控「bounds 内一律不渲水面」零误伤的前提 = bounds 内确实无水体，而这靠
  `generateCity` 补实缺口区间 `[naturalH+1, min(coverBottomY-1, SEA_Y)]` 保证。
  ⚠️ **勿按「城内真实水方块 = 0」的旧口径写注释** —— 那只对城堡 ±16 核心区成立；
  bounds 全域实测曾有 16600 格残留水体（其中 56 格暴露）。补实材料须用城市岩石材料，
  **不能清成 air**（会在城市地下造出空洞，玩家挖下去掉进洞里比看到水更糟）。
- **结构撒布有四条路径 + 四处有意偏离 mc-lite**（勿照原样改回）—— 实测细节见
  [`docs/roadmap.md`](docs/roadmap.md)「活跃约束详情」的结构撒布段。唯一权威 =
  `src/gen/structures/scatter.js`；候选在 region layout 层算一次（DR-13）。
- **代码生成撒布类型的派生基准 = `CODE_GENERATED_SCATTER_TYPES`（勿写成 `t !== 'house'`）**：
  `SCATTER_JSON_TYPES`、`apply.js` 的预载循环与 `CODE_GENERATORS` 映射表、`check:data` 门禁的
  `jsonTypes` 全部从它派生（红线 1）。当前两项：`house` / `ship`。写成字面量排除会让加第二个
  代码生成类型时门禁**误报**（要求它有 JSON 映射 + 磁盘文件），或该类型没被识别 → 走
  `rasterizeStructure` → cache 未命中 → **结构静默消失**（方块层面看不出差别）。
- **ship 沉船不看 biome/occupied（勿「补齐」门控）**，且**落地测试须用桅杆判据**
  （不能用 footprint 范围判据 —— 会被海底地形污染成恒真）—— 实测细节见 roadmap 同段。
- **cutout 扩容是离散 ×1.5 跳增，容量须留足余量**：往 cutout 通道加方块量（新植被/新结构）
  时须重测峰值并重标定 `CAPACITY.cutout.active`（当前 550）—— 差一点就会触发扩容撞破内存
  预算。实测数据见 roadmap 同段。
- **背包物品集合口径 116 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项功能性方块）−
  `HIDDEN_FROM_INVENTORY`（6 项可放置但不进背包：chimney + 床三项 + **M9 创造台两项**）。
  ⚠️ 门禁 `[物品集合]` 打印的「排除 N」是**两个集合之和**（当前 `排除 10`），与
  「`HIDDEN_FROM_INVENTORY` 6 项」不是一个口径，勿混写。**两个集合语义互斥，勿混为一处**
  —— 把可放置方块塞进 `NON_PLACEABLE_ITEMS` 会让集合语义失真。
  ⚠️ 本条是「现状快照」（可带数字）；**其余文档与代码注释一律不硬编码计数**，以
  `npm run check:data` 的 `[物品集合]` 输出为准（M9 已把代码注释里 8 处硬编码计数改掉）。
- **床渲染镂空问题未修**（床侧面一个面无贴面 → 透视穿帮）。当前靠「不入背包 → 玩家选不到 →
  实际不会被放置」**规避而非修复**；TODO 标注在 `src/mesh/mesher.js`，归属床/宝箱/门多方块 Epic。
- **背包图标是离线烘焙产物**（`assets/icons-atlas.png`）。改**背包内方块**的贴图地址或 mesher
  几何后须重跑 `npm run icons`，否则图标静默过期（渲染旧形状/旧配色，肉眼看不出）；忘跑会被
  `npm run check:data` 的指纹检查抓到。改**非背包方块**的贴图无需重跑。
- **形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（`TEMPLATES` / `FACE_VERTICES` / `FACE_UVS`）。
  图标烘焙与等轴测投影只 import，**禁止手写第二份几何定义**（红线 1）。按方块单独 hack 图标的
  **几何**做不到 —— 那会在 `TEMPLATES` 之外开第二份形状权威。
- **多方块结构的占位物品走平面图标路径（`FLAT_BLOCKS`），不是等轴测立方体**：
  `zombie_nest_alias_block` 在背包里代表整个 38 方块结构（放置走 `player.js` 的物品名路由），
  立方体是错的表达 → 加进 `tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS` 并跑 `npm run icons`。
  mc-lite 同口径：`ItemIconUtils.getCustomIconPath()` 把 `zombie_nest_alias_block` /
  `turret_alias_block` / `bed_alias_block` / `mine_cart` 一起映射到手工图，**绕过**
  `HUD.generateIcon()` 的立方体生成。⚠️ 该清单里它**唯一** `solid: true` —— 走平面的理由是
  「多方块结构的占位物品」而非「非实心」，勿按「非实心」口径修正它。
  **炮塔/床/宝箱等同类 alias 物品加进来时同理**（`player.js` 的 `CREATIVE_SPECIALS` 注释有清单）。
- **方块放置朝向不看玩家 yaw**：三分支为门控关闭→恒 0 / 原位重建同类型→`+1 % 4` / 有类型记忆→沿用 /
  无记忆→0。真实手感是「转身不改朝向，要转 90° 就在原位挖掉再放回去」。
  **M4 Task 6 改走 `editor.setBlock(...)` 时须保留朝向分支**（不得退化为只传 id）。
- **等轴测图标的深度度量 = `x+y+z`**（由投影轴叉乘得法线 `(-1,-1,-1)` 推出），且遮挡判定必须
  **逐像素深度测试** —— 面平均深度只能用于排序，对被整片遮住的面无能为力。
- **丢弃玩家改动的唯一入口 = `Game._discardEdits()`**（取消在途 flush + 清各 column **内存**
  edits + 清 IndexedDB store 与 `editsCache`）。消费者 `newWorld`（换 seed）/ `clearSave`
  （保留 seed 与设置，设置面板「删除缓存」）。**禁止只清 IndexedDB 不清内存** —— 内存 edits
  是写盘源，残留会在任何来得及提交的时机把旧改动写回刚清空的 store。
- **面板 UI 档位与钳制范围是两套口径，勿混为一处**：`VIEW_DISTANCE_OPTIONS`（面板按钮档位，
  当前 `[8,12,16]`）只是**快捷选择子集**，`clampVD` 的钳制范围 **2~16** 才是架构口径
  （M1 测试/调试依赖 `vd=2`、既有 spec 用 `vd=4`）。故面板必须容错「当前值不在档位内」
  （URL/旧存档带来 `vd=4` → 无按钮高亮）；**刻意不做「就近高亮」** —— 那会让按钮宣称一个
  非生效值。契约断言在 `src/tests/test-ui.js`（档位须落在钳制范围内 + 默认值在档位中）。
- **设置面板新配置先量当前两列高度再选列，不要机械往右列填**：面板是两列盒
  （`.mc-columns` + `.mc-combined` 合并盒，mc-lite 同款手法但分配按本仓库档位重排）。
  历史上右列余量大（左列曾被两组合并盒 + 四档风格撑高），故出过「新配置往右列填」的口径；
  **v1.63 实测该前提已反转**：右列已有六行（视距/帧预算/TNT 破坏/创造台/进度/世界）且是
  **决定面板高度的那一列**，左列只剩三行。把「背景音乐」加进右列后：面板 653px、内容 706px
  > 可视 645px → 出现纵向滚动条、「世界」行被裁；改放左列则面板高度不变、零文本溢出。
  **判据 = 不抬高面板高度的那一列**（先读两列 `getBoundingClientRect().height`，量法见
  roadmap「活跃约束详情」），而不是哪一列名字上「余量更大」。两组两按钮档位仍优先用合并盒共用一行。
  **音量档当前不在面板**（默认 100%），但字段仍持久化 + `?volume=` URL 可达 —— 背景音乐
  （v1.63）用的是**独立的**开关、音量固定 mc-lite 原值 0.15，**不消费** `volume`；将来把音量档
  加回面板时不必改数据模型。
- **面板的破坏性按钮文案与列分隔线规则各有单一口径** —— 细节见 roadmap
  「活跃约束详情」的面板与 UI 段。其中**CSS 特异性 bug 须 `getComputedStyle` 读四边定位**
  （只有某一边缺 = 特异性覆盖的特征），不要凭观感猜。
- **`settings-panel.js` 的 `PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**
  （会提前终止模板字符串 → 整个模块解析失败 → **游戏页白屏加载不出来**，不是面板样式错，
  是整个页面挂；实测一度误判为「服务端口有问题」）。改完 `src/**/*.js` 先跑 `npm run lint`
  （能抓解析错误）再做实测。
- **判断方块渲染语义必须读 mc-lite 的 `MaterialManager`（材质层）+ `BlockData`（数据层），
  不能只看 mc-heavy 的 `cullMode`** —— 后者是前者的转换产物，转换规则
  （`blocks-data.js:6`「名字含 leaves → cutout」）本身可能有偏差。`cullMode`（渲染通道）与
  `isTransparent`（面剔除语义）是两套口径。实测踩坑：`sky_leaves` 被误判为镂空材质并据此
  做了一整节容量分析，实际 mc-lite 是 `mkMat('#FF69B4', 0.9)` 无 `alphaTest`
  → **是用户凭观感质疑才发现**（「对齐上游须实测其运行时行为，不能读定义推断」的又一实例）。
- **`opaqueTable=1` 有四项后果，不止面剔除**：① `mesher.js:464` 邻居面剔除（收益）
  ② AO 遮挡 ③ blocklight 阻断（`lighting.js:165`）④ 炮塔 LOS / 弹丸阻挡
  （`turret-system.js:31`）。改任何方块的 `cullMode` 到 opaque 前须评估后三项。
  **只要 ① 不要 ②③④ 时用 `cloud` 的手法**：`cullMode:"opaque"` + `opaque:false` +
  `mesher.js:288` 的 `SAME_TYPE_CULL` 加名字。⚠️ 该手法**治不了 GEN 侧成本** —— GEN 阶段
  根本不读 `cullMode`（v1.42 实测确认，spec §5.3 的回退选项因此不含「治 genP95」）。
- **反向情形（四项全不要）= 只加 `"opaque":false`，不动 `SAME_TYPE_CULL`**：`chimney`
  （2026-09-30 修）是第二个实例 —— 它因材质不透明被转换规则归进 opaque 通道，连带被误判成
  「占满整格、可剔除邻居面」→ **mesher 剔掉烟囱下方屋顶块的顶面**（用户报告「烟囱底部接触的
  方块面是透明的」）。几何上它是 r=0.15 的细圆柱，本就不占满整格。⚠️ **与 cloud 的区别**：
  cloud 要同类互剔（云簇内部不出面）故须加 `SAME_TYPE_CULL`；chimney 不需要（两个相邻烟囱
  各自都是细柱，互不遮挡）→ **只加 `opaque:false`，加进 `SAME_TYPE_CULL` 是错的**。
  ⚠️ 实测本仓库**全部非 box 几何方块的 opaqueTable 都是 0**（cutout 通道），唯二漏网是
  `chimney`（已修）与 `bed_head`/`bed_tail`（half_block，**暂不修** —— 已从背包移除、
  实际不会被放置，属既有规避策略）。⚠️ 加新的非 box 几何方块时须显式声明 `"opaque":false`，
  否则转换规则会按 cullMode 误推 opaqueTable=1（同类 bug 会重犯）。
- **`seededRandom` 的 salt 占用须程序化扫描，不能 grep 字面量** —— 带 `+ step`/`+ k`/`+ y`
  偏移的调用点占用的是**区间**（云簇 frontier 的「`seed+58`」实际占 **58..107**，
  `landmarks` 的「`seed+302+y`」实际占 **270..397**）。用错 salt 是**静默的确定性污染**
  （两个系统共用随机流 → 相关，且单测全绿）。实测占用表与空闲带见 roadmap
  「活跃约束详情 · seededRandom 的 salt 分配」。
- **cutout 通道每格顶点成本约为 opaque 实心团的 3 倍**（cutout 之间**不互相剔除**：
  `mesher.js:464` 判据要 `opaqueTable[neighbor]===1`，cutout 方块是 0）。实测纯 3×3×3
  叶团 cutout 648 顶点 vs 同体积 stone 216 顶点。**往 cutout 加方块量前须先算这笔账**
  （与既有那条「cutout 扩容是离散 ×1.5 跳增」配套）。
- **BatchedMesh 的 draw call 不是「每通道 1 次」**：WebGPU 后端对**每个可见 geometry slot
  各发一次 draw**（`three.webgpu.js:85531`）。实测 v1.42 天空树让 bench 场景 ④ draw
  530 → **545（+15）** —— 新增可见 slot 即增 draw；勘查期按「合批进既有 3 通道」推断
  「draw call +0」**已被实测证伪**。往通道里加新几何前不要假设 draw 不变。
- **Node 侧的 A/B 时间比较必须交替顺序 + 多轮取中位**（推广自 `bench` 的既有要求）：
  首轮顺序测量（先 HEAD 后改动）得出「改动反而快 60ms」而面数明明增加 —— JIT 预热的
  顺序效应。改交替后得 +0.4%。**出现机制上不可能的数值先怀疑测量方法**（同本文件
  既有的「对照脚本」条目）。
- **结构写入无占用格守卫（后写胜），与 mc-lite 偏离 —— 既有的全局偏离，v1.42 实测量化**：
  `makeColumnSetter`（`landmarks.js:268-278`）**无条件覆盖**目标格，而 mc-lite 的
  `fakeChunk.add`（`WorldWorker.js:532-538` / `:1508-1518`）**有守卫**：该格已有非空气方块则
  `return`（先写胜）。实测后果：天空树的树干格被邻树树冠覆盖成 `sky_leaves` 的比例是
  **13.2%**（密度 `SKY_TREE_CHANCE=0.05`，region [-2,2]² 实测 1300 岛 / 10057 树 /
  40228 树干格中 5309 被覆盖）；密度 0.1（mc-lite 口径）时为 **21.4%**（spec §2.5.1 的原始实测）
  —— **该比例随密度变，引用时须注明密度口径**。⚠️ 这**不是天空树任务引入的**（地面树/所有结构路径走同一个
  `makeColumnSetter`），**本次不修**（加守卫会改变全部结构路径的行为与既有世界内容 →
  视觉比对基准变化），但**写结构类断言时不得假设「每个结构都完整」**（用忠实写入顺序
  模拟，spec §6.2 第 4 条）。若将来要对齐 mc-lite，需单独开 Epic 评估影响面。
  ⚠️ 该项**不进「六处偏离」清单** —— 那个清单是视觉比对专用，而占用格守卫是
  结构写入语义的全局偏离（不只空岛、不只视觉）。
- **写断言前必须先在真实数据上跑一次、打印实际值**（天空树评审沉淀，同
  `testing-policy.md` §2.6 第 ⑤ 条）—— 两处阻断缺陷均为「断言描述想象中的世界」：
  ① 「每棵树 4 格树干、每格都是 `sky_wood`」（实测 21.4% 被覆盖）；② 「树干底格下方是
  `sky_grass`」当作圆判据漂移的护栏（实测 0/300 个岛会 FAIL）。与本文件既有的
  「不凭感觉宣称通过」同源。
- **坐标类判据一律用非负取模或直接按足迹判**（天空树评审沉淀，同 `testing-policy.md`
  §2.6 第 ⑤ 条）—— `Math.min(wx % 16, 16 - (wx % 16))` 在 JS 里是**取余**而非取模，
  负坐标下恒返回负值 → 判据**恒真**。本仓世界无边界、负坐标是常态，`wx % 16` 是
  **高频陷阱**。修法优先「直接枚举足迹算 column 集合」；若非要用取模写
  `((wx % 16) + 16) % 16`。待办：全仓 grep 同类写法。
- **凡论证「A 优化与 B 优化等价/不冲突」，须在 A、B 各自的参数取值下分别实测一遍**
  （天空树二次审核沉淀，spec §9.2，同 `testing-policy.md` §2.6 第 ⑥ 条）—— 这类错误的
  形态特别隐蔽：**不是**数值错、也不是引用错，而是一句听起来完全合理的机制推理。
  实测踩坑：`vegetation.js:79` 的 `surrounded` 生成期跳过被论证为「反正都会被 mesh 剔除，
  早跳晚跳一样」—— 实测**方向相反**：cutout（`opaqueTable=0`）下跳过省 6 面/格，
  opaque（`opaqueTable=1`）下跳过反而**多** 6 面/格（region[-1,1]² 净增 32,430 面 / +2.8%）。
  错在**没区分通道** —— 而当时正在改的就是那个参数。与上一条同源（都是「先跑一遍再下
  结论」），但落点是**设计论证**而非测试断言，故单列。
- **文档同步**：新增产物或删除文件时，必须同步「目录结构清单」「开发命令清单」「现状声明」
  三类文档，历史记录段不动。文档里同一事实的多个副本会漂移（已发生三次版本号漂移）。
- **断言落点与负向验证的踩坑清单不在本文件** —— 权威副本是
  [`docs/testing-policy.md`](docs/testing-policy.md) §2.5~§2.7（生成类代码测试落点 /
  断言落点六类踩坑（含计时断言交替对照 / 导航监听武装顺序 / 指纹口径 / 竞态内存侧断言 /
  断言先跑真实数据 / 等价论证须双侧实测）/ 负向验证盲区高发区）。
  写测试前按它的判据确定本次改动属哪一级。

### M6 丧尸沉淀的活跃约束（M7 巢穴与后续实体类 Epic 必读）

- **`WorkerPool.call()` 返回 `{id, promise}` 而非 promise 本身**（`worker-pool.js:71`）。消费回包
  必须取 `.promise`；只判 `typeof result.then === 'function'` 会走同步分支拿到那个对象
  （无业务字段）→ 回包内容**静默丢失**。实测：AI RPC 发出 11 次、pending 归零，但丧尸 velocity
  恒 0、mode 恒 idle（原地不动），且**纯逻辑测试全绿** —— 因为 fake pool 返回裸 promise，
  测试与真实接线口径不一致。**写 fake pool 时必须返回 `{id, promise}` 与真实形状一致**。
- **时间基准统一用 `performance.now()`，禁止 `Date.now()`**：两者相差约 17 亿毫秒
  （实测 `Date.now()=1788847988963` vs `performance.now()=676.6`）。帧循环 `setAnimationLoop`
  回调传的 `nowMs` 是 performance 基准，任何「到期时间戳」比较（红闪 `nowMs < flashedUntil`、
  冷却、未来 buff/debuff）都必须同源，否则判定恒真 → **效果永不消退**。
- **物理推进必须返回全新 state + 全新数组**，不可原地改写后返回同一对象。
  `EntityManager.update()` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」；
  原地改写会让 before/after 从同一份已改位置算出 → 恒相等 → **索引永不迁移 → column 卸载漏
  回收实体**（浅拷贝也不够：position 数组引用相同仍会被污染）。开销约 1200 个小对象/秒，
  bench 实测无回退。M7 若新增会移动的持久实体，同一坑。
- **物理轴顺序：竖直先走再水平**（与 `player/physics.js` 同序）。step-up 依赖本步算出的
  `onGround`；把 `onGround = false` 放在水平移动之前会让 `tryStepUp` 永远拿不到 onGround →
  step-up 完全失效。另外**水平撞墙不得清零 velocity**（竖直必须清零防重力累积穿地抖动）——
  AI 意图每 0.05 秒才刷新而物理跑 60Hz，清零会让实体在两次 RPC 之间彻底卡住。
- **常驻实例池 mesh 须无活跃实例时 `visible=false`**：InstancedMesh 构造期 `count` 就是容量，
  即使全部 slot 零 scale 仍被提交渲染 → **每个常驻 mesh 恒增 1 个 draw call**。实测 M6 六个
  部件 mesh 让 bench 场景 ④ draw 530 → 536（恰好 +6）。同手法见 `tracer-renderer.js`。
- **`EntityManager.onDespawn()` 是单槽覆盖语义**（`_onDespawned = fn`），M5 已把它留给 Game
  装配渲染层回收。**第二个消费者不得再注册**（会静默覆盖前者，看不出谁生效）。M6 的 slot
  归还因此在三条回收路径上显式做（死亡 / `despawnColumn` / `dispose`）—— 新增回收路径须同步。
- **column 卸载回收顺序：先玩法服务、再 M5 commit**。`unload.commit()` 内部会调
  `entities.despawnColumn()` 回收临时实体，那条路径**绕过玩法服务** → 渲染 slot 不归还。
  Game 的 handle 里必须 `zombies.despawnColumn(key)` 先行（见 `game.js` 注释）。M7 巢穴刷怪
  同理：任何临时实体都要在 commit 前经自己的服务回收。
- **`findSpawnY`（`gen/terrain.js:98`）会把空中结构当出生点**（云层 `supportsPlayer=1` 但
  `solid=0` → 玩家可能出生在云面上）。后果：**云面上不会自然刷怪**，且测试落点扫描须
  **向下扫真实地面**而非用玩家 y±4。实测细节见 roadmap「活跃约束详情」的出生点与刷怪段。
- **负向验证若「注入后仍全绿」，先怀疑断言落点而非实现** —— 九类盲区高发区见
  [`docs/testing-policy.md`](docs/testing-policy.md) §2.7（含 M6 实测的 15 条无效盲区）。
- **从实例矩阵反解旋转必须用 `atan2(elements[8], elements[0])`，不能用 `Euler.setFromQuaternion`**
  （实测踩坑）：three 的 Euler 'XYZ' 序对 Y 轴用 `asin(m13)`，而 `asin(sin θ)` 在 `|θ| > π/2`
  时会**折叠**回 [-π/2, π/2] —— 实测 yaw=2.4805 读出 0.661。纯 Y 旋转下 `elements[0]=cos θ`、
  `elements[8]=sin θ`，`atan2(sin, cos)` 范围无关。测试若只在 `[-π/2, π/2]` 内取值会**侥幸通过**，
  换个方向就假失败 —— 补用例时须至少一个落在折叠区。M7 巢穴/炮塔等任何带朝向的实体同理。
- **两层共用的判定阈值必须落在 config 单一权威**（红线 1）：丧尸的「是否在移动」阈值有两个
  消费方 —— `zombie-system.js`（朝向派生）与 `zombie-renderer.js`（步态累积）。entities 层不得
  反向依赖 render，故常量放 `zombie-config.js`（`ZOMBIE_MOVING_EPSILON`）两层共用。各写一份字面量
  会漂移出「腿在摆但朝向没跟上」的撕裂状态，且**用远离阈值的输入测不出来**（实测：速度 1.2 对
  阈值 0.001 与 0.5 都判移动）—— 须在临界值附近断言两层同时生效。
- **移植 mc-lite 的速度/力值参数必须换算单位（格/帧 → 格/秒，×60）**：mc-lite 的
  `predictNextPosition` **不乘 dt** → 它的 velocity 是格/帧；mc-heavy 物理层乘 dt → 格/秒。
  `ZOMBIE.speed` 已换算（`0.02 × 60 = 1.2`）。**这类缺陷肉眼难辨**（实体照常在动，只是行为
  不对），须靠 A/B 对照实测。实测数据见 roadmap「活跃约束详情」的渲染与容量段。
- **移植时须检查上游「靠其它机制兜住」的隐含前提，不能只搬那一个函数**：mc-lite 的排斥力
  可以「完全重叠时跳过」，是因为它有 S 路线随机偏移角让丧尸不会精确同点；mc-heavy 没移植
  S 路线 → 照搬那个判定会**永久死锁**。实测细节见 roadmap 同段。
- **worker 消费共享纯函数，不得在 worker 里重写一份逻辑**：丧尸 AI 的全部逻辑抽成
  `zombie-system.js` 的 `computeAiUpdates()`，`world-worker.js` 的 `ai` 分支只调它（红线 8）。
  若在 worker 里重写，**浏览器内单测测不到真实接线**（单测直接调纯函数）—— 「worker 没接线」
  是静默失效（丧尸照常追逐、照常渲染，只是叠成一坨）。同 CLAUDE.md 已记的 fake pool 盲区。
  这类改动须补一条落在**真游戏页**的 E2E（注入「worker 不消费共享函数」→ 断言须真 FAIL）。
- **WebGPU 后端不支持「InstancedMesh + 材质数组 + `geometry.groups`」**（实测，红线 9「WebGPU 唯一
  后端」的连带后果）：六面恒用 `material[0]`，`groups` 与 `materialIndex` 被忽略 → 照 mc-lite 的
  「正面单独一张纹理」写法（`ZombieInstancedRenderer.js:237-254` `clearGroups`/`addGroup` +
  `:262-284` 材质数组）会**静默只渲染第一张**（正面看不到眼睛，不报错）。根因
  `three.webgpu.js:34592` `getMaterial()` 直接 `return material`，不遍历 `geometry.groups`、
  不取 `materialIndex`（WebGL 后端 `:30472` 则按 group 分次 draw → 是 WebGPU 后端**刻意不实现**，
  非整体不支持）。**替代 = 单材质 + 单纹理 + UV 分区**：纹理双区并排（左半无图案 / 右半有图案），
  几何的正面顶点 UV 改写到右半（`zombie-renderer.js` `applyHeadUV`）。M7 巢穴/炮塔等任何
  「不同面不同图案」的实体同理。**多区纹理不能用上下分区**（会把 N×N 图案压成 N×(N/2) → 比例失真），
  须横向并排。
- **`BoxGeometry` 各面的 `buildPlane` `vdir` 符号不同**（`three.core.js:29515-29519`：正面/侧面
  `-1`、顶面 `+1`）→ 跨面写「世界坐标 ← 归一化 u/v」换算**不能用同一套公式**（会在某些面把 v
  反向、偏一格）。跨面取样须用**纹理坐标**作统一参数。踩坑记录见 testing-policy §2.7 第 9 类。
- **Tier 4 像素实测的断言阈值须匹配 `outputColorSpace`** —— 口径与实测数据见
  testing-policy §5.2。
- **离线烘焙产物的过期门禁 = 输入指纹比对**（与图标同一手法）：图案参数/贴图内容进指纹，烘焙时写进
  伴随 JSON，门禁用当前参数重算比对 → 不匹配即报「跑 npm run xxx」。漏了会让产物**静默过期**
  （渲染旧图案，肉眼只觉得「颜色怪怪的」）。指纹逻辑放共享模块供烘焙脚本与门禁共用（红线 1：
  两处漂移会误判）。已知盲区：改**算法**而不动参数时指纹不变 → 这类改动须靠 Tier 4 兜住。

### M7 巢穴沉淀的活跃约束（炮塔/床/宝箱等方块装置 Epic 必读）

- **GEN 接管必须走 `restoreEdits`，不能只搬 typed buffer**（既有 bug，M7 修掉）：
  `Scheduler._onGenResult` 新建 column 时若留空 `column.edits`，玩家在该 column 新放一块后
  `flushNow()` 会用「只含新编辑」的 Map 整行 `put` 覆盖该 key 的存档 → **旧 edits（含锚点）
  静默丢失**。方块层面看不出差别（Worker 内 `applyEdits` 已把 edits 叠进 blocks/meta，渲染正确）
  —— 丢的是持久层。分工：`restoreEdits` = 主线程有状态重放（blocks/meta + `blockEntities` +
  `edits` 三者一起）；`applyEdits` = Worker 内无状态版本（只写 typed 数组）。
- **编辑热路径每格的坐标换算只做一次**：`getBlockId`/`getBlockMeta`/`getBlockEntity` 各自重算
  cx/cz/columnKey/Map.get/blockIndex —— 逐个调等于同一换算做三遍。实测后果：`bench --check`
  阻断 `[回退 11.1%] 场景 ④ frameP95 9→10`。改用 `WorldData.readCell(x,y,z)` 一次读出三项。
  改编辑路径前先看这个方法，**不要退化成分别调三个 getter**。
- **玩法服务的 controller 接线必须在 `_waitForColumn` 之前**（实测踩坑，极易重犯）：
  出生点 column 在 `_waitForColumn` 时 ready，`onColumnReady` 随之触发。若服务（`this.nests`）
  创建在其**之后**（如武器运行时装配段），回调跑时它还是 null → 第一行直接 return →
  reload 后 anchor 与索引都恢复了，但 controller 恒为 0（装置不工作）。对照 `this.zombies`：
  装配在 `_waitForColumn` 之前，同样的 column ready 路径正常 —— **顺序差异是唯一原因**。
  诊断手法：读「column.blockEntities 有锚点吗 / 索引有它吗 / controller 有它吗」三者，
  只有 controller 缺失即时序问题（不要猜）。
- **放置类装置须有「放置成功即建 controller」的回调**（`onPlaced`）：anchor column 此刻**已加载**，
  `onColumnReady` 早在放置前触发过了，不会再为新锚点触发一次 → 没有这条接线则新装置永不工作
  （方块全写对、anchor 也在、索引也登记了，肉眼看不出差别）。
- **多格结构的放置必须走「物品名路由」，不能只接测试 API**（M7 用户实玩发现的缺陷）：
  `zombie_nest_alias_block` 在背包物品集合内（计数以 `npm run check:data` 为准；与 mc-lite 同口径），
  玩家从背包面板选中图标后
  右键走的是 `placeBlock()` 的**常规单格 `editor.setBlock`** 路径 → 只放出一个贴了图案的正方体。
  修法 = 取背包槽后判 `CREATIVE_SPECIALS.has(slot.item)` → 命中则调实体放置并 `return`，
  **不回落到单格放置**。mc-lite 同手法：`PlayerInteraction.tryPlaceBlock()` 判
  `entityRegistry.isSpecialBlock(type)` → 交 placement handler（`:286-296`）。
  **炮塔/矿车站等同类装置同理。** ⚠️ 测试须走**背包选中路径**而非只走测试 API
  （M7 的 E2E 当时全绿却漏了这个缺陷，见验收报告 §3.7）。
- **多格结构的 origin = 命中方块 `blockPos`，不是 `prevPos`**：结构最低层须落在玩家脚下的地面格上。
  用 `prevPos`（空气格）会让结构整体上移一格悬空 —— 实测后果是 38 格里 30 格落在未清理的位置
  → 大面积放置失败。mc-lite `generateBlocks` 的 `y + block.y - 1` 与本仓库
  `origin.y + block.y`（origin=地面格）等价：两边最低层都落在 `地面.y + 1`。
  **两条放置路径（API 与背包分流）的 origin 语义必须一致**，否则测试用一条、玩家用另一条会撕裂。
- **派生 controller 的去重不能用 `controllers().size` 断言**（实测无效盲区）：它按 id 为键，
  重复创建会**覆盖写** → size 恒为 1，注入「不去重」后 size 断言仍全绿。去重的真实价值是防
  创建多余对象（旧对象没 `dispose` → world/zombies/editor 引用泄漏）。断言须比较**对象引用**
  （`first === second`）+ 原对象未被 dispose。
- **全局上限必须来自 edits store，不能来自已加载 controller 数量**：远处装置的 column 可能未加载
  （无 controller），用 controller 数判上限会让玩家走远再回来就能无限放置。走
  `Persistence.listBlockEntities(kind)` 的 IndexedDB cursor 扫库。⚠️ hydrate 是 `clear()+重建`：
  调用前必须先 `flushNow()`，否则库里没锚点 → 索引被清成 0（真实重启路径本就是
  flush → reload → hydrate）。
- **失效判定必须比对 `newId !== critical.id`，不能只看坐标覆盖**：装置每次刷怪都用
  `setBlockEntity` 写回时钟（`lastSpawnAt`），若判定只看「坐标覆盖关键格」，自己的时钟写回
  就会把装置杀掉。
- **`setBlockEntity` 必须构造新对象，不得原地改 anchor**：原地改会让 `column.blockEntities` 与
  `column.edits` 持有的同一引用被悄悄改写（两处状态看似独立实则共享，红线 1 精神）。
- **`bench --check` 的 frameP95 门禁会被 vsync 量子化噪声误报**（实测口径陷阱）：120Hz 锁帧下
  frameP95 按 8.33ms 一档量子化，基线 9ms 而实测在 9.6~10.1 随机浮动 → 9→10 只差一个量子就报
  「回退 11%」阻断。门禁阻断时先做**交替对照**（同会话内 `git stash` HEAD 与改动交错各跑 2~3 次）
  比两侧分布，而非看单次数值。⚠️ 不带 `--check` 跑 bench 会**自动重写** `docs/m3-baseline.*`
  —— 那是冻结基线，提交它会静默放宽门禁（p95 基准 9→9.9），诊断后须 `git checkout` 恢复。

### M8 TNT / 炮塔沉淀的活跃约束（后续同类装置 Epic 必读）

- **「哪些方块不可破坏」的唯一权威 = registry `indestructibleTable`**：mc-lite 用
  `ExplosionWorker.js:8` 的字面量数组（含 bedrock/barrier）与 `BlockData.js:244/252` 的
  `isIndestructible` 字段（**只标 playground 两项**）—— 两处**分散且不重合**，上游没有
  一个完整的「哪些不可破坏」清单。
  三个消费者（徒手挖块 / 枪械破坏 / 爆炸过滤）都读这张表，各写一份会漂移出
  「TNT 炸得掉但玩家挖不掉」的撕裂语义。**登记 indestructible 与「移出背包」必须成对做**
  —— 只登记不移出会产出「放得出来但挖不掉」的撕裂状态（M9 创造台两项因此与 M8 拆开）。
- **炮塔/弹丸的速度类参数不需要 ×60 换算**（与 `ZOMBIE.speed` 相反）：mc-lite 的
  `ROTATION_SPEED`/`PITCH_SPEED`/`PROJECTILE_SPEED` 都乘 `deltaTime`（已是格/秒与弧度/秒），
  而 `Zombie.js` 的 `predictNextPosition` 不乘 dt（格/帧）。**照搬前须逐项核对是否乘 dt** ——
  这类缺陷肉眼难辨（实体照常动，只是速度不对），须靠 A/B 对照实测。
- **爆炸计算在主线程是有意的**（152 次查询 + 须与音效同帧），不要「优化」成 Worker 任务 ——
  会引入回包延迟让方块先消失后爆炸。理由记在设计文档 §4.5.5。
- **炮塔索敌的 LOS 采样同样留在主线程**（同 §4.5.5 的边界判定）：LOS 必须读方块，而世界数据的
  唯一权威在主线程（红线 1）—— 把计算搬去 Worker 就必须把数据也搬去（每 RPC 约 1.28MB、
  8Hz → 每秒 10MB 结构化克隆）。⚠️ 若后续世界数据可后台化，这条立刻失效，届时须重新判定。
- **TNT 引爆的去重集合挂在唯一入口**（`Game.explodeTnt()`）而非各引爆路径：两条入口
  （徒手挖块 / 枪击命中）+ 连锁调度都要过同一集合，否则两格相距 ≤2 的 TNT 会 A→B→A→B
  **永久互炸**。⚠️ 「移除引爆格自身」必须**独立于**破坏开关（`canTntDestroyBlocks` 默认
  false 时被引爆的 TNT 仍须消失），否则连锁永不终止。mc-lite 侧同口径
  （`PlayerInteraction.js:683-688` 在破坏门控之外、`:617-618` 四个入口全先查后写）。
- **装置的「逻辑朝向」与「渲染朝向」必须同源，不得各写一套旋转公式**（红线 1，M8 实测踩坑）：
  炮塔 `muzzle()`（弹丸发射方向）自己算了 pitch 旋转，符号与渲染层的 `Rx(-pitch)` 矩阵相反 →
  炮塔朝下瞄准时**弹丸往天上飞**（丧尸恒 100 血，弹丸从未命中）。这类缺陷**肉眼难辨且单测测不到**
  —— 只读渲染矩阵的单测全绿，因为它验的是渲染层（对的），错的是另一套公式。断言必须落在
  **两条路径的交叉比对**上（`muzzle()` 方向 == 渲染矩阵变换出的炮口位置）。床/宝箱等后续带朝向
  的装置同理。
- **WebGPU 后端的序列帧切帧走 `texture.offset`（不是自己算 UV）**：mc-lite `ParticleSystem`
  的手法是逐帧改 `tex.offset`；WebGPU 后端确实消费它 —— `three.webgpu.js:13247`
  `TextureNode.update()` 在 `matrixAutoUpdate === true` 时调 `texture.updateMatrix()`，把
  offset/repeat 折进 `texture.matrix` 经 uniform 传 shader。**⚠️ 若这条不成立，序列帧会恒显
  第 0 帧 —— 特效照常播、照常扩张淡出，只是图案不动，肉眼几乎看不出差别（静默失效）**，故
  Tier 4 像素实测必须断言「不同帧采到不同区」，不能只看「特效播了」。
  ⚠️ **`repeat` 须在 `texture.clone()` 之前设置**：clone 复制参数快照，顺序反了则每个副本的
  repeat 丢失 → 采样整幅图集（10 帧叠在一起），观感是「一团糊」而非分帧。
  ⚠️ **每 slot 须有独立材质 + 独立纹理副本**（共享材质会让 offset 互相覆盖 → 只有一个 slot
  能切帧）。⚠️ `texture.clone()` **共享同一个 `Source`**（同一份 GPU 上传），只复制参数 ——
  故 N 份 clone **不构成红线 1 的第二份权威数据**（那条约束针对逻辑体素数据）。
  **后续补 mc-lite 的 `pick.png`（枪击击中）/ `block_crash.png`（徒手破坏）两个序列帧特效同理。**
- **Tier 4 像素判据的阈值须对着「屏幕实测值」读，不是图集像素统计值**（实测踩坑）：屏幕取样区
  固定大小，而 sprite 的 scale 随 progress 扩张（3→8）→ 同样大的屏幕区覆盖的**纹理区域越来越小**，
  越靠后的帧只采到纹理正中心那一小块。实测爆炸图集：帧 0 屏幕读 242.7 而帧 7 读 **0.0**，
  但图集像素统计帧 7 中心区是 20.4 —— 两个口径差一个数量级，按图集数字定阈值会假失败。
  对照还须**只差一个变量**：主判据选帧 0 与帧 7（两者 opacity 恒 1，差异纯来自切帧），
  不用末帧（它已进淡出段，会混入 opacity 这第二个变量）。

### 太阳方向光与天空盒沉淀的活跃约束（v1.58，后续光照/天空/日夜类改动必读）

- **「光影平淡」的根因是管线缺一层，不是风格参数**：体素材质是 unlit，顶点 shade 只有
  `max(skylight, blocklight) × ao`，户外 skylight 恒 15（DR-14）→ **一个方块六面亮度完全相同**。
  改 `VISUAL_STYLES` 的 `skyDim`/`blockBoost` 这类全局乘数**永远调不出**「迎光面亮、背光面暗」。
  朝向差异只能来自读取 packed bit10-12 的面法线（mesher 早已写入，v1.58 才首次有消费点）。
- **`SUN_INTENSITY` 必须从 `VISUAL_STYLES.noon.sunDirection` 派生，不得写字面量**：取值
  `(1 − SUN_AMBIENT)/noonSunY = 0.625` 是让 **`SUN_AMBIENT + SUN_INTENSITY×noonSunY ≡ 1.0`**
  成立的唯一值，即「正午顶面亮度 = 改动前」。⚠️ **改任何风格的太阳方向后必须重算它**，否则这条
  零回归不变式静默失效（表现只是「地面整体变亮/变暗一档」，没有任何断言之外的异常）。
  同理 `SUN_AMBIENT ≡ SHADOW_FLOOR`（两个身份同一语义，各写一份会让「背光面」与「影区」亮度撕裂）。
- **阴影只能乘在太阳项上，不得再乘整个 `vSkyShade`**：两边各乘一遍会让正午顶面在影区变成
  `0.5 + 0.625×0.8×0.5 = 0.75`（应为 0.5）→ 阴影变淡 50%，`sun-shadow.spec` 的冻结比值 0.735 崩。
  写法是把 `shadowFactor` 重标定成 `shadowKill = clamp((sf − FLOOR)/(1 − FLOOR), 0, 1)` 再只乘太阳项。
- **`uSunStrength = 0` 必须让 `sunTerm ≡ 1`（逐位回到无方向光的现状）**，不是退化成 `SUN_AMBIENT`
  —— 否则关掉方向光会把顶面从 1.0 压到 0.5、全场景暗一半。公式是 `mix(1, full, strength)`，
  方向不能反。Tier 4 的 A/B 自校准与 fixture 隔离都靠这个不变式。
- **`sunDot` 必须在顶点阶段算成 float varying**：片元读 packed 会被 `three.webgpu.js:65404`
  对 int 类型强制 `flat` 插值 → 色块（同 AO/light 的既有教训）。面法线六选一用 `select` 链
  （GLSL 无便携的动态常量数组索引）。
- **`sunTerm` 只能乘 skylight 项，不得乘 blocklight**；**transparent 通道不接太阳**
  （海面已有自己的 Blinn-Phong 高光）。前者保证「火把在洞穴里照样亮」，与阴影只衰减 skylight 同一道理。
- **Tier 4 的亮度比值是 sRGB 口径，不是线性口径**：线性 0.875/0.500 = 1.750，过 sRGB 传递函数后
  0.9429/0.7354 = **1.282**；叠上贴图基色的非线性，理论值域 **1.286~1.347**。按线性值定阈值会
  假失败（实测 1.313，我第一版按 1.75 写就把正确实现判成 FAIL）。同坑见 `test-view-bob.js`。
- **`cubeTexture(tex)` 做背景时不得自己传 uvNode**：要留空让 three 从上下文注入
  `backgroundRotation.mul(normalWorldGeometry)`（`three.webgpu.js:48924-48928`）。自己传方向会绕开
  它的 x 轴取反约定 → **天空左右镜像，肉眼极难察觉**。
  核验手法（已用过，可复用）：把 `scene.backgroundNode` 临时换成 `scene.background = cubeTexture`
  （three 默认路径）截同一帧，**逐像素 diff 必须为 0**。
- **混合因子从既有 `skyDim` 派生（`nightBlendOf()`），不要新增一份「夜有多深」的权威**：
  两个数字会漂移出「天空已黑但星星没出来」的撕裂。同理 `moonDirection` 与 `sunDirection`
  **必须走同一个 `normalizeDirection`、同一个归一化点**（`_apply` 只算一次并复用）。
- **不做 `backgroundBlurriness`**（夜 0.28）：它会让 three 走 `pmremTexture` 路径（`:55805` 判 `> 0`），
  需预滤波立方图 render target，与手工 `backgroundNode` 冲突。它本是 mc-lite **离散切风格**
  的补偿值，交叉淡入下星空该是清晰的 —— **移植上游参数前先确认它是否在补偿另一个缺陷**。
- **天空盒让「纯色天空」判据失效，四条 spec 已 pin `?skybox=0`**：`render-terrain` /
  `city-visual` / `sky-structures` / `m3-rain` 都用「像素落在 `0x87ceeb ±30` 内 = 天空」。
  实测天空盒上线后**天空区 99.4% 的像素**被误判成地形（`city` 0.881 → 0.938）→ 下界断言
  `> 0.05` 近乎恒真。同类：**绝对色类判据**（`test-sky-tree.html` 的 `ratioA`）在方向光下
  从 1.000 跌到 0 → 该 fixture 设 `uSunStrength = 0` 隔离。
  ⚠️ **加照片天空后再写「数地形像素 / 比绝对色」的断言，必须显式决定要不要 pin `?skybox=0`**
  —— 不 pin 的下场不是 FAIL（能看见），而是**判据失去判别力**（更坏）。
- **日轮/月轮的距离要与相机 far 联动、尺寸同比缩放**：mc-lite 固定 150 单位 + 固定尺寸是
  因为它视距固定；本仓视距 2~16 可变，照抄会在大视距下过小、在小视距下被推出远裁面（月亮消失）。
  三套风格的 `sunVisible` 原值全 false（`skyBox4` 贴图自带太阳光晕，再画一个变两个太阳）——**字段保留，勿「清理」**。
- **天空盒是 `scene.backgroundNode` + `scene.background = null` 双设**：three 的
  `getBackgroundNode()` 优先读 backgroundNode（`:55681`），而 `DayNight._apply` 的纯色路径判
  `scene.background && .set` → 置 null 正好让它自动跳过。降级路径必须把 background 恢复成 Color。

- **雾的可见性前提 = `fogFar` 必须落在世界加载半径之内**（v1.61）：`fogFar` 由
  `(viewDistance+2)*16*0.95` 再乘风格数据的 `fogScale` 得到；世界径向只加载
  `(viewDistance+2)*16`。**`fogScale > ~1.05` 就会把整个雾推到加载边缘之外 → 雾完全不可见**，
  而所有依赖雾的东西（「雾色」开关、远景色彩过渡）都会**静默失效**。实测：night 的
  `fogScale=4.0` → `fogFar=608`，开关切换像素变化 **0.0%**（白天 4.1%）。
  **改任何风格的 `fogScale` 前先算这条不等式。**
- **`night.fogScale=4.0` 是 mc-lite 的代偿手法，本仓不需要**：它要用雾把夜里的远处推成漆黑；
  本仓有夜空贴图 + 星点，推远只会让「雾色融入天空」无物可染。已改为 1.0（有意偏离 mc-lite）。
- **「Δ=0」这类异常读数，在任何风格/任何时刻下都应当先怀疑机制，不要先给它编解释**：
  v1.59 实测到「深夜 Δ=0」时被判成「夜里看不出差别是合理的」并据此收工，实际那是缺陷
  （同一份数据在白天会被判为缺陷，在夜里被解释成合理 —— **两边用了不同标准**）。
  这类「看起来能自圆其说的异常」是最容易溜过验证的形态。
- **Tier 4 用例要同时钉「根因条件」与「症状」两层**：只钉「开关切换后像素必须变」时，
  若哪天雾距正常而开关本身坏了，读数同样是 0 → 两者无法区分。故 `fog-color.spec` 的
  夜间用例先断言 `fogFar < 世界加载半径`（根因，不依赖像素），再断言远景变化 > 3（症状）。
- **`pinView(page, style)` 的 style 默认是 `noon`**：冻结日夜是为了消掉太阳 N·L 漂移，
  但一旦要测夜间行为就必须显式传 `'night'` —— 忘了传会得到一个「永远在正午」的假通过。

### 夜空天空盒无缝沉淀的活跃约束（v1.60，后续天空盒/立方图/全景贴图改动必读）

- **立方图接缝的判据必须归一化到「图像自身的面内噪声底」，不能看裸 RMS**：用户认可的
  **白天**天空盒裸接缝 RMS 是 **1.90** 而不是 0（JPEG 量化残差），肉眼却看不到 —— 因为
  它**并不比画面内部的普通相邻像素更粗糙**（面内相邻列噪声底 1.06 → 比值 1.786）。
  反过来夜空原图接缝 41.09 / 噪声底 8.96 → 比值 **4.561**，比画面内部粗糙 4.6 倍，所以
  肉眼能看出「有楞有角的盒子」。**判断「有没有接缝」只能问「接缝是否比画面内部更粗糙」**。
  实测三组：白天 1.786 / 烘焙夜空 0.308 / 原始夜空 4.561。
- **门禁不设绝对阈值**：试过 1.0 与 1.2，**两次都被白天基准 1.765 当场否决**（会把用户
  亲口说「看不到边角」的那套贴图判 FAIL）。正确判据 = 「夜空比值 ≤ 白天比值」，白天贴图
  本身就是用户认可的参照物 → 换贴图/改参数后**不需要重标**。
- **无缝靠「共用同一函数」构造，不靠羽化**：烘焙时每个输出像素 → 立方体方向 `dir` →
  六面各自按 `dir` 反算 uv 采样 → 按「离本面中心多近」加权。`dir` 与权重都跨面连续 →
  边界两侧算的是**同一条射线、同一组权重** → 接缝数学上精确为零。只做边缘羽化只能把
  硬缝变淡缝，星云结构仍跨不过边界。
- **采样参数用 `x/(SIZE-1)` 而不是硬件采样的 `(x+0.5)/SIZE`**：输出贴图的第一列/最后一列
  必须对应面的**完整边缘**（u=0 / u=1），否则边界两侧各自偏半像素、混合权重算出来不同。
  代价是整面图案相对硬件采样偏 0.5 像素（不可见）。
- **`ridged` 噪声（`1-|2n-1|`）不能用来做星云细丝**：它是**等值线** → 会闭合成一圈圈
  **白色轮廓环**（像大理石裂纹 / 地图等高线），与星云的弥散丝缕完全不同（实测验过）。
- **程序化重生成整套星云不可行**（虽然同样无缝）：实测观感明显偏暗偏糊 ——
  均值 `[9.8,21.2,42.9]` vs 原图 `[17.7,35.7,60.3]`，高频能量也低一档。**保原图细节
  必须走重采样**，不能重画。
- **屏幕级接缝判据被实测否决**（勿再加）：量「上半屏逐列均值的一阶差分，最大峰 / 中位」
  对原图是 **16.3**、对烘焙版是 **19.8**（反而更低）—— 画面里的地形与星点噪声淹没了该
  信号，判据**没有判别力**。接缝只能在**贴图层面**判（`tests/night-sky-seam.spec.mjs`）。
- **改任何烘焙参数后必须跑 `npm run nightsky`**，否则贴图**静默过期**（渲染旧图，肉眼看
  不出）。`check:data` 的 `[夜空]` 指纹环节会抓；node 侧无 JPEG 解码器，只能做指纹，
  像素判据在 Playwright spec 里（那里能解码）。
- **`assets/sky/night-src/` 是烘焙输入，不是渲染资源**（与 mc-lite 原图逐字节一致）。
  渲染读的是 `assets/sky/night/`。改前者而不重烘焙不会生效。

### 雾色融入天空沉淀的活跃约束（v1.59，后续雾/大气/远景类改动必读）

- **雾的 color 是任意节点，换雾色来源不需要新增渲染通道**：`fog(color, factor)` 的实现
  （`three.webgpu.js:42069`）是 `vec4(factor.mix(output.rgb, color.toVec3()), output.a)` ——
  color 可以直接是一个 `cubeTexture()` 采样节点。新增大气效果（高度雾、散射）前先看这条，
  不要一看到「需要方向相关」就去开 pass。
- **俯角（视线 y ≤ 0）一律归到地平线带，只保留方位角**（纯函数
  `src/render/fog-sky-direction.js`，mesher/materials 侧的 TSL 必须与它同构、ε 从其 import）。
  ⚠️ **直接用完整视线方向会让俯视时采样到立方图的天底那半张**：实测白天 negy 均值
  [97,125,186] vs 地平线 [207,216,232] → **雾色反向变暗**（实测 G −17 / B −12）。
  物理上远处地形该淡入的是地平线天色（空气被上方光照射，不是被地面照亮）。
  ⚠️ **垂直俯视没有方位角可保**（信息缺失）：取 +x 作确定性兼就；**不得返回天顶**
  （实测会让俯视雾色变暗）。
- **开关必须走 `mix()` 插值，不得写 `if` 分支**：`uFogColorMix = 0` 时要**逐位**回到旧行为。
  写分支会出两条代码路径，未测的那条静默劣化。实测往返：off `[184.9,201,214.3]` →
  on `[189.9,200.6,215.6]` → back **逐位相同**。
- **没有天空盒时不得谎报生效**：`?skybox=0` / 加载失败 / sky 为 null 时
  `setFogColorEnabled()` 必须返回 false 且 `uFogColorMix` 保持 0 —— 拿**未绑定的立方图**
  采样会读全黑，不是回退到固定色。面板在那种情况下**整组置灰**（否则玩家按了看不到变化）。
- **量雾色必须冻结三个变量 + 隐藏 HUD，且不要用 `pushModal` 冻物理**：
  ① 停 `physics.step`（**不是 `pushModal`** —— 它阻断玩家更新循环，相机不跟随新位置，
  换了机位但画面根本没变，实测整屏 Δ=0，一度误判为「雾色失效」）；
  ② `setVisualStyle('noon')` 冻结日夜（否则太阳方向插值 + 方向光让**整屏每一行**都在变，
  对照就不只差雾色这一个变量）；③ `setShadowsEnabled(false)`；④ 隐藏全部 HUD。
  先测**同状态重复截图的噪声底**，实测冻结干净后为 **0**；非零时必须按噪声底调阈值。
- **负向验证盲区实测：拿掉 y 钳制后「平视」机位仍然通过**（ΔR 从 5.0 只降到 3.5，仍 > 阈值 2）
  —— 平视时 `dir.y` 本就接近 0，钳与不钳几乎无差。**只有俯视机位能抓到该回归**
  （不钳制时 ΔR 变 **−3.3**，方向反转）。故 `fog-color.spec` 保留两条同判据、不同 pitch 的
  用例。写「方向采样」类特效的判据时，机位必须覆盖被测变量的极端区间。
- **雾带不是按屏幕高度划的**：站在地面平视时雾带落 y≈360~432（画面中下部），顶部天空与
  底部近景几乎不变；而从高空俯视时**整屏都是雾带**（远处地形铺满视野）。
  写「近景不变」类断言前先打印逐行变化量确认区间，不要拍脑袋按 1/3 划分。
- **雾色与天空背景必须共用同一个 `uNightBlend`**：各写一份混合因子会漂移出
  「雾是白天色、天是夜幕色」的撕裂。

### blocklight 区域语义沉淀的活跃约束（v1.64，后续光照/光源类改动必读）

- **区域重算的 column 集合必须是 3×3（`LIGHT_REGION_OFFSETS`），不是「中心 + 4 正交」**：
  光强度 15、每格 -1 → 最远照 **14 格**；column 边长 16 → 正交邻居最近格距本列边缘 1 格、
  **对角邻居 2 格（两者都必须参与）**，隔一列已 17 格（贡献恒 0）。plus-5 漏了 4 个对角列，
  实测（全量 BFS 作真值）最大误差 **10 级 / 982 格错**，表现为用户报告的「灯光有边界」。
  ⚠️ **`computeSkylightRegion` 与 `computeBlocklightRegion` 共用这一口径** —— 前者第一阶段
  恒 15、水平 BFS 是 no-op 才没暴露同一个漏洞，后续启用阳光遮挡时不改这里会立刻犯同样的错。
- **入队范围 ≠ 写回范围，这个不对称是载荷性的（改一处必须同时看另一处）**：
  写回只写**中心列**（3×3 只对中心列精确，邻列拿到的是截断结果 —— 写回邻列会 last-write-wins
  覆盖已收敛的好光，v1.8 已定口径）；但**入队必须覆盖 3×3** —— 灯放在 A 列，它的光锥会进入
  每个邻居列的角落。旧实现只入队编辑所在列 → 邻居列永远没有自己的 task → 永远是 0。
  实测（修前）：column 中心放灯后入队清单只有 `['17,7']`，四邻居 blocklight 非零格数
  全 0，剖面 `15,14,…,8,0,0,0` —— **恰好停在 column 边界上**。
- **结构性光源没有编辑事件，必须靠 `_onGenResult` 的 emissive 检测补入队**：GEN 只对本列算
  blocklight（截断），而房屋里的 glowstone / 地下 lava / 城市吊灯不会触发任何 `setBlock`。
  不补这条路 → 玩家「走远再回来」会再看到同一个边界（实测默认视距下 43 个发光方块的
  跨列邻居格 **126/134** 是 0，补后 19/19 达标）。扫描成本 9×32768 格 ≈ **0.286ms**（首次命中即退出）。
- **region 输入版本校验不能只查中心列**：灯放在邻列时，邻列的 blocks 变了但**中心列 version
  一动不动**，中心列校验抓不到 → 在途旧回包把中心列写回旧值（静默回退）。必须校验 region
  **全部输入列**的 version（沿用版本协议，**不引入** epoch/防抖，红线 7）。
- **脏标记必须逐 section 比对，不能「无条件全脏」**：入队扩到 3×3 后，粗口径会把 mesh churn
  放大 9 倍。邻列只在本列同 sy 确实变了时置脏（邻列的 −X/−Z 面 faceLight 采中心列的格）。
  实测：完全相同的结果置脏 0 个 section（旧写法 24 个）。
- **light RPC 只回中心列 light + 各输入列 version**（`world-worker.js` 的 `light()`）：邻列的
  3×3 结果本来就被丢弃，传它们纯属浪费 —— 入队扩到 3×3 会把 RPC 出参从 32KB 推到 288KB/次。
  实测往返：9 列 **7.8ms / 0.59MB 入**，25 列 9.8ms / 1.64MB —— **区域变大并未增加总载荷**，
  编辑 p95 仍 1.70ms（冻结门 < 2ms）。
- **写「光跨列」类判据时，对照侧必须排除被遮挡的方向与 opaque 目标格**：
  房屋里的 glowstone 隔 2 格就是墙（实测 10 个不达标方向里 9 个是这种）、opaque 格自身
  永远没有 blocklight。不排除 → 断言描述的是想象中的世界，修好的代码反而 FAIL。
  另：**整列非零格数不能当「源头已隔离」的判据** —— 世界里本来就有别的发光方块
  （实测隔两列有 1~3 格亮着，光来自 50~61 格外的其它 glowstone）。判据要落在被测灯
  的轴线上（或逐格距离判据）。

### M9 创造台沉淀的活跃约束（后续同类装置 Epic 必读）

- **创造台不维护「平台有哪些方块」的副本**（红线 1）：mc-lite 的 `playgroundBlocks: Set<'x,y,z'>`
  （2916 个字符串键）不移植。平台是规则 54×54 矩形，坐标由 `origin + size` 确定性重算 →
  关闭时枚举即可。把它记下来会引入第二份权威，且与 `blocks` typed array 必然漂移
  （玩家挖掉一格平台后，方块集合就成了谎话）。
- **创造台只用装置模式的「持久层半边」，不用 controller / 增量失效那半边**：它无运行时行为
  （不刷怪、不射击），`blockEntity` 只是「平台在哪、多大」的持久真相。⚠️ **后续「无行为的
  方块装置」**（如纯装饰结构）**同理** —— 别照 M7/M8 给它建 controller，那是无谓复杂度。
- **创造台方块登记 `indestructible` 且移出背包，两者必须成对**：只登记不移出会产出
  「玩家放得出来但挖不掉、TNT 也炸不掉」的撕裂状态（M8/M9 拆分的分界依据）。
  `check:data` 的 `[创造台]` 环节钉住三项同时成立（名字在 registry / 标 indestructible / 不在背包）。
- **平台方块的不可破坏门控是「零代码改动生效」**：`indestructibleTable` 的三个消费者
  （徒手挖块 / 枪械破坏 / 爆炸过滤）都读同一张表 → M9 只改了 `blocks-data.js` 两行声明，
  三处门控自动覆盖（M8 交付该表时的收益兑现）。**后续加新的不可破坏方块同理** ——
  只改声明，不要在消费者侧补字面量。
- **`_hasOverlap` / `exportModel` 是主线程大体积扫描，但实测不构成卡顿**（M9 实测：
  `_findSafeHeight` 最坏 28.3ms / `exportModel` 2500 格 5.9ms / `create()` 全流程 26.7ms）——
  `getBlockId` 是 O(1) typed-array 读，326 万次也只 28ms。**故按计划不做增量优化**
  （「实测数据决定是否优化，不预先优化」）。⚠️ 后续同类扫描先实测再决定，别预先优化。
- **2916 格单次 `setBlocks` 事务 2 帧即收敛、队列零积压**（M9 实测 `meshQueued`/`pendingMesh`
  峰值均 0）→ **无需分帧提交**。bench 场景 ④「批量删 500 块」是既有对照基线，2916 格约为其
  5.8 倍仍无积压。⚠️ 后续更大的批量编辑先实测收敛再决定是否分帧。

### 矿车沉淀的活跃约束（后续可移动持久实体 / 同类装置 Epic 必读）

- **跨车（跨实体）的同帧协调必须读「帧前快照」，不得读实时 state**：`EntityManager.update`
  里 `entity.state = next` 立即生效 → 同帧后跑的实体会看到前一辆已改的结果 → 行为**依赖遍历
  顺序**（实测 `[a,b]` ❌ / `[b,a]` ✅）。矿车的 `carsView()` / `carAtRound()` 都从 `beginFrame()`
  捕获的 `_frameView` 返回，故 `beginFrame()` **必须在 `entities.update` 之前**。
  ⚠️ **回落路径是陷阱**：`carAtRound` 若回落实时 state（或回落到 floor 基的 `carAt`），
  顺序依赖会**静默复活**且单测（单一插入顺序）抓不到 —— 须显式断言两种遍历顺序结果一致。
- **对他车的写入一律进 `deferred` 队列，`applyDeferred()` 必须在 `entities.update` 之后**
  （mc-lite 是单管理器循环直接改对象，本仓库的 definition 逐实体跑且要求返回全新 state）。
  放进 definition 里直接改 = 在遍历中改被遍历集合。
- **玩法服务在 `EntityManager.update` 之外改 `state.position` 时，必须显式调 `reindexColumn(id)`**
  —— 否则派生 column 索引永久停在旧 column（且**不自愈**：实体停住后 before===after 不触发迁移）
  → 旧 column 卸载会误回收实际已离开的实体（实体在玩家眼前消失）。矿车相向碰撞回弹
  `lastTrack` 可跨 column → 踩到；丧尸没踩到是因为它的 damage/setIntent 不改 position
  （物理在 definition.update 内跑）。`reindexColumn` 是 M5 `EntityManager` 为此新增的公开方法。
- **判据基准必须同源（round vs floor 混用会造出死锁）**：矿车的「前方格」用 `round(position)`，
  则相邻判定 / 索引查询也必须用 round。⚠️ **mc-lite 自身就是混用的**
  （`MinecartMovementSystem.js:479` round vs `MinecartCollisionSystem.js:55` floor）→
  **mc-lite 自己有相向碰撞死锁**（实测核实源码）。本仓库统一 round 是**有意偏离 mc-lite**
  （对齐其**意图**「相向 → 两车都停」而非其 bug）。
- **偶数间距对称接近时 round 格距从 2 直接跳到 0、永不等于 1** → 「查前方一格」会漏
  （两车互相穿过）。修法 = `frontX` 查不到时**回查本车当前 round 格**，且**仅反向运动车**
  视同相向（同向 `continue`，否则误伤同向列车）。mc-lite 不踩此坑是因为它 isHeadOn 与索引
  同为 floor 基（距离 2→1→0 渐变，=1 时被捕获）。
- **位置索引每帧 `syncIndex()` 全量重建**（floor 基 `_index` + round 基 `_roundIndex` 两份
  同时建）—— 增量要在 definition 里回调 service，把同构层与玩法入口耦合成环。50 车 × 每帧
  一次可忽略。
- **铁轨在车下方一格（`trackY = carY − 1`）是全部轨道判据的口径**，`hasTrackAt` 本身**不做**
  这层换算（mc-lite 同口径）—— 调用方漏减 1 会让「有没有轨」恒假 → 车放得下但永不激活。
- **矿车是单格实体，放置 origin 用 `prevPos`**（命中面的相邻空气格），与多格结构
  （巢穴/炮塔用 `blockPos`）**相反**。⚠️ 两条放置路径（`selectPlaceable` 与背包分流）的
  origin 语义必须一致，且 `prevPos` 可能为 null（射线起点就在方块内）→ 判空后再调。
- **乘坐的水平偏离判定要 +0.5 换算**（车中心 = `position + 0.5`，实例原点约束）——
  mc-lite 从**块角**量（`|player.x − minecart.position.x|`）而绑定判据是
  `getMinecartAt(floor(player.x), …)` → 玩家站在车的**远半格**（如 cx+0.7）时
  deviation=0.7 > 阈值 0.6 → **人还在车上就被自动下车**。本仓库从车中心量：cx+0.7 时
  deviation=0.2 → 保持乘坐；走到 cx+1.2（真离车）时 0.7 > 0.6 → 下车。
  符合设计文档 §4.4 的意图（「水平偏离车中心 > 0.6」）—— 有意偏离 mc-lite 的字面行为。
- **乘坐绑定有两个分支，第二个是本仓库必需的 fallback（mc-lite 不需要）**
  （2026-10-01 修「车撞静止玩家穿模」沉淀）：`ridingCarFor` ① 站在车顶
  （`floor(y−0.1)` 有车 + 容差 0.3）② **嵌在车体内**（脚底格 == 车格）。
  ⚠️ **mc-lite 靠重力段的「向下扫描找支撑面 `gy`，`if (y < gy) y = gy`」把玩家顶上车**
  （其 `isSolid` 含矿车格）；本仓库重力是 `_moveAxis` 向下 + 碰撞二分回退，
  **只阻止下落、不上抬** → 必须补 ②。
  实测根因：车在**前一格**跨轨道中心时经 `resolvePlayerBlocking` 把玩家抬到 `carY+0.9`，
  但玩家脚下那格**当时还没车** → 重力拉回轨面 `carY`。车走到玩家格时：
  `resolvePlayerBlocking` 只检查**前方格**（玩家已不在前方）→ 不再抬；而 ① 查
  `floor(carY−0.1) = carY−1` ≠ 车格 `carY` → **恒不命中** → 车从玩家身上开过去
  （实测 `clippedFrames=60` → 修后 2）。
  ⚠️ **① 的容差判定失败必须 fall through 到 ②，不得直接 `return null`** ——
  玩家脚底在车体中部（`carY+0.5`）时 ① 查到车但容差外，直接 return 会让 ② 永不执行。
  ⚠️ ** 不需头顶净空检查**：车能开到玩家格 = `resolvePlayerBlocking` 已在前一格查过净空
  （无净空则车停）；且玩家无法自己走进「车格内 + 头顶无净空」（车格对玩家实心 →
  `_tryStepUp` 内部有净空检查）。
  ⚠️ **穿模帧数断言不得贴实测值**：实测 2 帧（车入格帧 + 绑定帧不锁 y）是帧序结构性
  决定的，但阈值取 5 —— 贴线断言高负载下 flaky（同 `weapons-world-edit` 的 5ms 余量教训），
  而与修复前 60 帧仍差一个数量级 → 注入回退必 FAIL。
- **乘坐跟随必须分轴做障碍检测**（dx / dz 各自 `physics.collidesAt` 试探，被挡不推进）——
  对应 mc-lite `updateMinecartRiding` 的 `checkAABBExcludeMinecart`。**不做则玩家会被埋进
  实心块**：跟随只写 `p.x/p.z` 且乘坐期物理步被跳过 → 车穿低矮隧道把 1.8 高的玩家 AABB
  埋进天花板 → 下车后每次 `_moveAxis` 都碰撞、二分收敛到零位移 → **玩家卡死**
  （实测隧道用例 embeddedFrames=651 → 修后 0）。「其他矿车当障碍」那层**不做**
  （矿车-矿车碰撞已由 `planMinecartStep` 的相向/追尾逻辑处理）。
- **两个碰撞查询的分工是载荷性的，勿合并**（2026-10-01 修「玩家与矿车穿模」沉淀）：
  `_collides`（非乘坐：自主移动 / step-up）= 方块 **+ 矿车占据格**；`collidesAt`
  （乘坐跟随的分轴障碍检测）= **仅方块**。mc-lite 靠 `Physics.isSolid` 把矿车格当实心
  （cell-based，查 `minecartManager.getMinecartAt`）→ 玩家走进车被挡 + 既有 `tryStepUp`
  抬到 `carY+1`（与车顶 `carY+0.9` 差 0.1，被绑定容差 0.3 吸收）→ 自动绑定乘坐。
  本仓库同口径：`PlayerPhysics.minecarts` 由 Player 构造时注入（physics 不 import
  entities/，依赖方向 §3），`_collides` 的格子循环加一句 `carAt(x,y,z)`。
  ⚠️ **不需要「排除自己坐的车」**：`_collides` 只在非乘坐时被调（乘坐期 `physics.step`
  整段跳过），而 `ridingMinecartId` 非 null 时必然在乘坐 → 没有需要排除的车。
  ⚠️ **矿车格只能加进 `_collides`，不能加进 `collidesAt`** —— 后者加了会让乘客擦到
  另一辆车就被「挡停 → 偏离 > 0.6 → 自动下车」甩下车（上一条的裁定）。
  ⚠️ **绑定帧不锁 y**：绑定在未绑定分支发生，「y 锁车顶」在已绑定分支（下一帧才跑）
  —— mc-lite 同序。测试在检测到绑定的当帧读 y 会读到 step-up 落点 `carY+1`
  （实测 20 vs 车顶 19.9）→ 须多跑一帧再断言。
  ⚠️ 既有 E2E 用例是**把玩家 teleport 到车顶**再断言跟随，绕过了「走上去」这一步 →
  全绿却漏了穿模缺陷（同 M7「只测 API 漏玩家主路径」）。补的用例必须**从轨道上走进车**
  （`tests/minecarts.spec.mjs` 的「走进静止矿车」）。
- **空格下车是边沿触发，复位必须写在两个分支之前**（`_updateMinecartRiding` 函数顶部）：
  绑定成功时置 `_spaceReleased = false`（否则玩家跳上车时还按着空格 → 第一个乘坐帧就被弹下），
  但**若复位只写在未绑定分支**，一旦绑定成功就永远回不到 true → 空格下车彻底失效
  （状态机模拟实证；实施者修正了 controller 给的修法）。
- **M5 持久层原本没有「删除单个持久实体」的 API** —— `saveEntities` 是 upsert-only，唯一删除是
  整库 `clearAllEntities()`。矿车是**第一个可被单独销毁的持久实体**（炮塔/巢穴走 blockEntity
  edits store；弹丸/丧尸是临时实体）→ 首次暴露该缺口。后果（实测复现）：已销毁实体的
  snapshot 永久留在 store → ① 全局上限把死实体计入（50 次放/拾后**永久放不出车**，
  世界里一辆都没有却返回 `limit`）；② reload 复活。修法 = `Persistence.deleteEntity(id)`。
  **后续任何「可单独销毁的持久实体」同理**：`despawn` 必须配对 `deleteEntity`，否则静默泄漏存档行。
- **fake 必须建模真实对象的副作用，不能只是形状一致**（比 M6 的 fake WorkerPool 盲区更进一层）：
  假 `flushEntities` 写成 no-op（真实版会 upsert 进 `entitiesCache`）→ `count()===0` 断言**恒真**，
  漏掉上面那条上限泄漏。形状对了、副作用没建模，照样是盲区。
- **definition 的 context 契约形状必须与接线一致**（实测踩坑，单测全绿而真游戏页每帧抛错）：
  `planMinecartStep` 的契约是 `player: {position:[x,y,z]} | null`，而 game.js 一度传**裸数组**
  → `player.position` 为 undefined → 解构抛 TypeError → 帧循环中断 → **车永远停在起点**。
  ⚠️ 为什么单测漏掉：idle 车在步骤 ① 早退不读 player，且没有任何单测驱动 `definition.update`
  带真实 player context → 只有车**真的移动并跨中心**时才暴露。故须补一条「definition 层带真实
  player context」的单测钉住契约（`{position}` 形状 + `pendingPlayerLift` 生效）。
- **车斗纹理是运行时 canvas 生成 → 无指纹门禁**（用户选定「照 mc-lite 原样、不做离线烘焙」）：
  算法改动（渐变色 / 噪点数 / 拉丝间距）会静默生效，靠 Tier 4 像素实测兜底
  （`tests/minecart-render.spec.mjs`）。若改离线烘焙须同步补指纹门禁（手法见
  `tools/zombie-head-fingerprint.mjs`）。
- **矿车材质用 `MeshBasicMaterial`（unlit），mc-lite 的 `metalness`/`roughness` 是死字段**：
  mc-heavy 全场景 unlit 设计，灯光只为 PBR 武器模型而设（`zombie-renderer.js:32` 同口径：
  用受光材质会让实体吃到为枪标定的 2.3 环境光 → 偏亮且随日夜灯光漂移）。两个字段保留在
  `minecart-config.js` **仅作 mc-lite 出处记录**（与「床材质的 offset/rotation 是死字段」同类事实）。
- **矿车 `position` 是占据格坐标（块底角原点）→ AABB 是 `[0, width]` 而非 `[±width/2]`**：
  玩家/丧尸的 position 是「脚底**中心**」→ 盒相对中心对称（`PROBE_AABB` ±0.3）。
  **两种 position 语义不得混用**（混用会让命中盒偏半格 → 点不到车）。渲染层另有 `+0.5`
  的块中心换算，不影响命中盒。
- **`MINECART.speed = 2.0` 格/秒，不做 ×60 换算**（与 `ZOMBIE.speed` 相反）：mc-lite
  `MinecartMovementSystem.update` 的位移乘 `deltaTime` → 已是格/秒。**照搬前须逐项核对是否乘 dt**。
- **交互射程 15 格（`MINECART.interactRange`）与体素 DDA 的 `REACH = 40` 不是一个口径** ——
  实体交互更近，超出 15 格点不到车。拾取与激活共用本常量（红线 1）。
- **命中走 `EntityManager.raycast()`（实体 AABB slab），不得对 InstancedMesh 做
  `THREE.Raycaster.intersectObjects`**（红线 6）。遮挡口径可比性已核实：两侧距离同源同单位
  （raycast 归一化 dir → slab t 是世界距离；DDA 返回 `dist:t`；`camera.position` 正是 DDA 起点）。
- **放置不消耗物品、拾取不回背包**（创造模式口径，有意偏离 mc-lite 的生存模式语义）。
- **reload 恢复后车继续原方向**（`movementState` 进 snapshot），mc-lite 恢复后停成 IDLE ——
  有意偏离（玩家重启前正在开的车不该自己停下）。

### 背景音乐沉淀的活跃约束（v1.63，后续音频/音乐类改动必读）

- **效果音与背景音乐是两份清单（`SOUND_IDS` / `BGM_ID`），不得合并**：语义不同 —— 效果音是
  「事件触发、播完即止」，音乐是「循环、可开关」。混进去会让 `play(id)` 也可能播 254 秒循环音乐，
  且 `preload()` 的语义不再单一。`preload()` 默认参数包含两者，但白名单分开判。
- **起播是三个条件的对齐，不是某一个事件**：玩家意图（开关）/ buffer 已解码 / context 已 running。
  生产真实顺序是「先点一下（手势到位）→ 几秒后 4MB 才解码完」，所以 **`preload()` 末尾与
  `unlock()` 末尾各自都要调一次 `_syncMusic()`**。只写一处 = 另一半路径永远没声音，且**无任何报错**
  （设置面板显示「开启」、按钮高亮、就是没声音）。
- **`unlock()` 的唯一入口是 `Player` 的 canvas `onClick`**：mc-lite 挂的是 `document` 的 click，
  本仓既有 `onClick`（requestPointerLock 那个）就是同义的入口 —— **不得再挂一个全局监听**（会重复解锁）。
- **`bgmEnabled` 必须在 `start()` 里直接用 `this._settings || resolveSettings(...)` 解析**：
  `AudioManager` 构造在 `start()` 中段（:564），而 `this.settings` 的赋值在 `start()` **尾部**（:646）
  —— 读 `this.settings.bgm` 会抛 `Cannot read properties of undefined`，整个游戏白屏（实测）。
- **单测里不得 `AudioManager.dispose()`**：three 的 `AudioListener` 拿的是**全局单例** context
  （`three.core.js:50786` / `:49994` 的 `_context` 缓存），`dispose()` 的 `context.close()` 会把它
  关死 → 后续用例全报 `Cannot suspend a closed AudioContext`（实测一失败带倒三条）。单测收尾只拆
  listener、停音乐，不关 context。
- **写 BGM/音频类 E2E 前先确认两条环境事实**（两条都能让「全绿」变成无效盲区，已实测）：
  ① **Playwright 默认 `--autoplay-policy=no-user-gesture-required`**，新建 AudioContext 一上来就是
  `running` → 「手势未到」在生产里不会自发出现，用例必须主动 `ctx.suspend()` 造出来；
  ② **localhost 上 4MB mp3 可能几十毫秒就解码完** → 「先手势、后解码」这个真实顺序测不到，
  「preload 不补起播」的注入会**漏过**。修法 = `page.route` 把 mp3 推迟 1.5s 确定性造出该顺序。
- **`bgm.mp3` 是 4.0MB / 254 秒 / 128kbps（从 mc-lite 原样复制未重编码）**，进首屏预载队列
  —— 以后再加长音频前先想一下首屏流量。

### 第一人称手臂与跑动视角晃动沉淀的活跃约束（后续相机/第一人称观感类改动必读）

- **视角晃动必须按物理步推进，不能按渲染帧**：`player.update()` 里的物理是 60Hz 定步长 +
  accumulator，120Hz 渲染下**隔帧才走一步**。按渲染帧调 `viewBob.update()` 时，没走物理的那些帧
  位移为 0 → 全速判据判「没在动」→ 相位每帧归零 → **晃动永远起不来**（表现为「跑起来完全不晃」）。
  按物理步推进后相位严格为 `speed×60` rad/s，与渲染帧率无关。与之配套：`inputSpeed` 必须
  **在 `physics.step()` 之前**读 `vel.x/vel.z` —— step 末尾会把水平速度清零（无惯性手感）。
- **相机偏移必须融进那一次全量 `camera.position.set(...)`，不得写成 `+=`**：`player.update()`
  每帧重写相机位置，全量 set 天然幂等；改成累加会让上一帧的偏移被下一帧当基线继承 → 逐帧漂移
  （实测注入该形态后相机偏移单侧累积，E2E 真 FAIL）。
- **手臂材质用 unlit（`MeshBasicMaterial`），不跟随 mc-lite 的 `MeshStandardMaterial`**：
  本仓场景双灯（AmbientLight + DirectionalLight）只为枪的 PBR 模型而设；用受光材质会让肤色
  随日夜灯光漂移、且比同屏方块亮一档（`minecart-renderer.js` 用 MeshBasicMaterial 是先例）。
- **unlit 物体要有立体感 = 把明暗烘焙进顶点色；但明暗系数只能决定「哪面更亮」，
  绝不能让它们直接乘基色**（v1.56 踩，v1.57 修）：vanilla 面遮挡系数 × 固定光向 Lambert
  合出来的取值区间要**归一化后重映射**到一条「屏幕空间亮度带」（手臂 `shadeLow/shadeHigh`
  = 0.88 / 1.48），再乘沿长度/表面的渐变，最后 `srgbToLinear` 写进顶点色缓冲。
  ⚠️ **v1.56 的原始写法（三层直接相乘）就是用户反馈「手臂颜色过于暗」的根因**：
  线性基色被压到 0.20~0.48，静止姿态露出的底面/前面只剩 0.27/0.59 —— 像素实测屏幕均值
  RGB(163,146,134)，而参考肤色是 (238,187,153)，R−B 差从 85 掉到 29（不只是暗，还**发灰**）。
  v1.57 修后实测 (235,188,154)、R−B 81。
  ⚠️ **顶点色缓冲是线性工作色空间**（three `ColorManagement.workingColorSpace = LinearSRGB`）
  —— 把 sRGB 数值直接写进去会整体偏暗；反之要「屏幕上是某个颜色」就必须乘完再 `srgbToLinear`。
  ⚠️ **`shadeHigh` 超过 R 通道饱和点（1.07）是可以的**：上端只作用于被几何自身挡住的 +Y 顶面，
  那段余量用来拉开可见面的对比度；但**必须确认它真的不可见**，否则会顶出饱和色块。
  ⚠️ **第三层（沿长度渐变）是实测必需，不是锦上添花**：手臂 `rotation.x=-0.8`（≈46°）时只露出
  **两个面**，第三个面被几何自身挡住 → 只靠前两层时屏幕上只有两档亮度、**单面是纯色**
  （像素直方图 78.9%/19.6% 两个尖峰、中间空，观感就是「两块色板」）。
  ⚠️ 这一层**不参与面间归一化**，否则它的梯度会被压扁（实测并进去后单面内梯度只剩 5%，
  低于「有立体感」的 10% 门槛）。它现在同时承担「单面内梯度 ≥ 10%」这条断言的来源。
  ⚠️ 写这类断言时：**「对称面亮度相同」不成立**（加了光向后 +X 朝光、−X 背光）；
  **别取单顶点做跨面比较**（会被面内渐变带偏，用面内均值）；
  `BoxGeometry` 的顶/底面 4 个顶点 y 完全相同 → 面内梯度只能对**侧面**断言。
  ⚠️ **幂律重映射后「某面必须是最暗的那个」会变成伪约束**：线性空间里 ±X（面系数 0.6）与
  −Y（0.5）只差一点，重映射后 −Y 反而略高于 −X。要断言亮度排序就按 **sRGB** 断可见面
  （那才是玩家看到的），别在线性值上钉绝对最小值。
  ⚠️ **像素层判「面间差异」不能用 `p75−p25`**（面内渐变会把分位数拉进两峰之间，实测仅 6.3%），
  要用**直方图峰值间距**。
  ⚠️ **这几个参数是逐档实测试出来的，不是推导值**：改 `shadeLow/shadeHigh/lengthFade` 前先
  读屏幕像素（开/关手臂差分），至少同时满足「均值贴近参考色 / 面间双峰分离 / 单面内梯度 ≥10%」。

- **挥动时长用 dt 基定长（1/6 秒），不照搬上游的「每渲染帧 `swingTime--`」**：上游那个写法在
  120Hz 下挥动只有 60Hz 的一半时长，是帧率依赖缺陷。公式与幅度（`−0.8 − sin(p·π)·0.87`）不变。
- **手臂与持枪视图模型必须在同一处切换**（`Player.selectWeapon()`），不得两侧各判一次显隐 ——
  否则会出现「手臂和枪同时显示」或「切回徒手手臂不出来」的撕裂。
- **「实际位移 > 意图位移 × 0.95」已覆盖上游的 `!isObstructed`，不要新增「是否卡住」状态**：
  上游靠独立的 `isStuck` 标志排除撞墙，本仓没有那个状态；新增一份「是否卡住」的权威会与
  physics 的真实位移漂移（红线 1）。
- **晃动观感 = 位移 × 幅度 + 旋转分量，两者缺一都会「看着像在抖而不像在跑」**（v1.49 实玩反馈）：
  mc-lite 只做平移（`intensity 0.05`），实测在 70° FOV 下屏幕位移仅 1~2% → 用户反馈「小到看不出来」。
  修法是**同时**上调幅度（0.09）与补上 vanilla `bobView` 的旋转分量（roll `sin(t)` / pitch `|cos|` 双频）。
  ⚠️ **旋转必须叠加在已构造好的 yaw/pitch 之后（`rotateX`/`rotateZ` 局部轴），不得混进 `this.yaw`**
  —— 混进 yaw 会把「水平朝向」一起转，玩家会撞向侧面（roll 是镜头歪头，不是转头）。
  ⚠️ roll/pitch 幅度按 `amount/intensity` 缩放，静止时随振幅归零，否则停下后画面永久歪着。
- **相机晃动不得包含任何旋转分量（roll/pitch 恒 0）**（v1.51 用户硬要求）：
  「跑动时镜头始终是水平的……不要歪头」。roll（绕 Z）会让**地平线变斜**，这是被明确否掉的体验；
  pitch 一并归 0。`BOB.rollAmount` / `BOB.pitchAmount` **字段保留但置 0**（置 0 = 关闭，
  将来要开回来只改数值，不动代码结构）—— 不要"清理"掉这两个字段。
  ⚠️ **`player.js` 里不得另行添加旋转常量**：`rotateZ(this.viewBob.roll)` 是唯一接线点，
  在它旁边加 `+ 0.01` 这类偏移会让「零旋转」不变式静默失效，而只断言 `viewBob.roll === 0` 的
  单测抓不到（**断言必须落在相机的 `rotation` 上**，负向验证已证）。
  ⚠️ **`expect(camera.rotation.z).toBe(0)` 会被 `-0` 咬**：`rotateZ(0)` 可能产出 `-0`，
  而 `Object.is(-0, 0) === false` → 断言用 `Math.abs(x) === 0`，锁「量为零」而非「符号为正」。
- **晃动相位必须由「走过的距离」驱动，不能由时间驱动**（v1.52 用户反馈「频率要适配步伐节奏，
  现在太快了」）：原版是 `walkDist += 0.6×水平位移`、`phase = walkDist×π`。时间驱动会让频率与
  移动速度脱钩 —— 走慢、受阻时相位照涨，观感是「身体在飘」。
  **频率标定别照抄原版的 3.333 格/周期**：本仓 `SPEED = 8` 格/秒比原版疾跑（5.612）快 ~43%，
  照抄步幅会得到 2.400Hz（**更快**）。标定演进：v1.52 对齐原版疾跑 1.6836Hz（每步 297ms）→
  v1.54「稍微慢一点」1.5Hz → **v1.55「再慢一档」1.35Hz（每步 370ms）**
  = `phasePerBlock = 2π×1.35/8 = 1.0603 rad/格`。
  ⚠️ **下界已接近**：原版**走路**是 1.295Hz，1.35Hz 只剩 ~4% 余量。再往下降就落进走路的节奏，
  观感从「在跑」变成「在走」—— 那时应重新确认设计意图，而不是继续微调这个数。
  单测有「须快于原版走路 1.295Hz」硬护栏钉住这条界线。
  ⚠️ **改 `physics.js` 的 `SPEED` 时必须重算 `phasePerBlock`**（频率随速度漂移，且不会有任何断言之外
  的可见异常）。
  ⚠️ **改频率会连带改变实际幅度**：`smoothingRetention` 一阶低通的通过率随频率下降而**上升**
  （1.6836Hz → 0.8976；1.5Hz → 0.9161）→ 实际 y 峰 0.1177 → 0.1199。改完必须**重测实际峰值**。
- **振幅按原版口径：`x = sin(φ)·bob·0.5`、`y = −|cos(φ)|·bob`（y 只向下）**
  （v1.52）：`|cos|` 的 y 是**每步一次落地下沉**，双侧正弦看起来像「在飘」而不是「在跑」。
  x 只有 bob 的一半 —— 这也是「左右摆动体验不好」的正向修法。
- **凡「数周期 / 数过零」的断言，采样窗口必须按最低频率算够周期数**（v1.55 实测踩坑）：
  步频降到 1.35Hz 后，E2E 里 `180 帧 @120Hz ≈ 1.5s` 的窗口只剩 ~2 个周期，去掉渐入段只有 1 次过零
  → 断言**假失败**（不是实现缺陷）。改窗口为 360 帧（3s ≈ 4 周期）+ 跳过渐入。
  **调慢任何振荡类参数后，先检查所有「数周期」类断言的窗口是否还够。**
- **量晃动频率不能用「到原点的距离」或跨减速段的 timer span**：`timer` 在减速时按设计重置为 0，
  跨段相减会得到**负频率**（实测踩坑）。必须在**持续跑动的窗口内**用相位增量或过零计数。
- **晃动幅度是实玩标定的六轮值（0.05 → 0.09 → 0.07 → 0.1 → 0.13 → 0.15）**：v1.50 用户二次反馈
  「又太剧烈了」→ 三项一起降（旋转对观感的刺激远大于同量级位移）；v1.52 对齐原版 `bob` 上限 0.1
  （但那是在把 y 改成「只向下」之后 —— 同数值下「只向下」的观感比双侧正弦轻得多）；
  v1.53 用户「再稍微大一点，跑步的感觉不明显」→ **0.13**（有意偏离原版上限：原版 0.1 是配合
  它的步幅与速度标定的，本仓 `SPEED` 不同不能直接套）。
  ⚠️ **调这个数前先确认 y 的公式形态**，两种形态不能直接比数值。
  ⚠️ v1.57 用户「晃动幅度还不够大，可以稍微大一些」→ **0.15**。
  ⚠️ **观感上限已有护栏**（`intensity <= 0.2`）：y 峰逼近眼高的 11% 时会从「在跑」变成「晕」，
  单测钉住了这条上界，别再往上调。
  ⚠️⚠️ **标称值 ≠ 玩家看到的幅度**：`smoothingRetention`（0.7）是一阶低通，通过率随频率变
  （1.68Hz 处 0.8976、1.35Hz 处 **0.916**）→ 标称 0.15 实际 y 峰 ≈ **0.1375**。
  判断「够不够」必须用**扣掉平滑后的实际峰值**（单测/E2E 各有一条实测下界断言），
  只比标称值会系统性高估一成；**改步频后要重算这个通过率**。
- **挖掘挥手的调用位置必须在 `digBlock()` 顶部、所有早退之前**（v1.50 用户要求「试图即挥手」）：
  放在 `editor.setBlock()` 旁边时，上方三个早退分支（矿车命中 / `!this.target` / TNT 引爆 /
  `isIndestructible`）会让挥动**静默消失** —— 玩家按住连续挖空气/挖基岩时以为卡住了。
  mc-lite 同口径（它 `removeBlock()` 与未命中的 `else` 分支各调一次 `this.swing()`）。
  写这类「视觉反馈」接线时，判据是**玩家的意图**而不是**世界是否真的改变**。
- **手臂挥动不要用单对称曲线**（v1.49 实玩反馈「太生硬」）：mc-lite 的 `sin(p·π)` 峰在 p=0.5、
  前后等速，无论怎么调幅度都是「整体平移」。原版是**两条峰值错开的曲线**：
  `sin(√p·π)`（峰 p=0.25，快出，驱动 pitch/yaw）+ `sin(p²·π)`（峰 p≈0.707，滞后，驱动甩腕 roll）
  + 向前下探位移。**峰值错开才产生甩腕**。改幅度前先确认两条曲线的峰位没被改塌（断言钉在 p 轴上）。
- **写这类动画的断言必须落在「玩家实际看到的东西」上，不能只读内部状态量**：实测首版 E2E 只断言
  `viewBob.offset`，注入「bob 算对了但没写进 `camera.position`」后**仍然全绿** —— 改为同时断言
  「相机相对物理位置的偏移」并重做负向验证后才真 FAIL（testing-policy §2.7 的又一实例）。

### 太阳阴影沉淀的活跃约束（后续渲染/光照类 Epic 必读）

- **three.js r185.1 WebGPU 后端的 depth-compare 阴影路径是坏的，只能用 VSM**：PCFSoft/PCF/Basic
  三档全部 `GPUValidationError`（ShadowDepthTexture 同 scope 内 RenderAttachment 与 TextureBinding
  冲突）→ CommandBuffer 作废、画面全黑；**最小独立场景（plain Mesh、零游戏代码）同样复现** →
  与 BatchedMesh / packed 属性无关。VSM 因 `depthTexture.compareFunction = null`
  （`three.webgpu.js:45074`）绕开 comparison-sampler 而可用。**升级 three 前须重测**（若上游修了
  可换回 PCFSoft 对齐 mc-lite）；`castShadowNode` 路线对该 bug 大概率无效（bug 在阴影 map 的
  render pass 本身而非 filter 节点 —— 实施者分析，未实测）。VSM 不吃 bias/normalBias，软化参数
  是 radius + blurSamples；固有 light-bleeding 漏光伪影（用户已知悉接受）。
- **WebGPU 的阴影节流是 per-light 口径**：`light.shadow.autoUpdate` / `light.shadow.needsUpdate`
  （`ShadowNode.updateBefore` 判定），**不是** mc-lite WebGL 的 `renderer.shadowMap.autoUpdate` ——
  后者在本后端不生效。`renderer.shadowMap.enabled = true` 仍是硬门控（否则 castShadow 被忽略）。
- **VSM 下 receiveShadow 的对象也进阴影 pass**（`three.webgpu.js:44682` 判据 `castShadow ||
  (receiveShadow && VSM)`）→ opaque + cutout 两通道全进（v1.45 起 transparent 已改双 false，
  见下条）。后果：**重渲帧 drawCalls 尖峰**（vd=2 +220 / vd=8 +110），稳态零增量（按需刷新生效时
  稳态 drawCalls 与无阴影逐位相同）。→ **任何量 drawCalls 的 spec，若被测对象不是阴影，须先
  `setShadowsEnabled(false)` 隔离**（断言与阈值逐字不动，改的是被测 setup）。已隔离 5 份：
  render-terrain / daynight-visual / weapons-performance / zombies / m3-2-orientation。
- **transparent（水/玻璃）必须 cast + receive 双 false，只关 castShadow 不够**（v1.45）：
  VSM 下 `receiveShadow=true` 会把水/玻璃几何**渲进阴影深度图 → 照样投影**（上一条的判据）；
  且材质的 `shadow()` 节点**不受 `receiveShadow` 门控** —— 那个标志只门控 three 的**灯光管线**
  （`three.webgpu.js:46101` `if (builder.object.receiveShadow) setupShadow()`），而本仓体素材质是
  unlit + colorNode 里**显式**引用 `shadow(sunLight)` → 水面照样被压暗。故需**两侧同时做**：
  `render-world.js` 双 false + `materials.js` 的 `receivesShadow:false`（该通道材质不挂阴影因子）。
  mc-lite 对 water/glass 也是双 false（`GlobalInstancedMeshManager.js:76-84`）。
- **消费端门控的操作数顺序是载荷性的**：`if (this.shadowScheduler.tick(nowMs) &&
  this.sunLight.castShadow)`（game.js 帧循环）—— **勿交换两侧**：`castShadow` 在前会让 `tick()`
  被短路完全不跑 → `_pending` 永不被消费 → 打破 sun-shadow 用例 6 的观测口径（冻结断言
  `off.sawTrue === 0`，实测交换后 5/5 FAIL）。⚠️ 交换顺序**不会**让 draw 尖峰复活（交换后
  needsUpdate 恒 false → 阴影 pass 根本不触发）；会产生尖峰的是「**去掉** castShadow 门控」那种
  形态 —— 两种注入后果不同，勿混。
- **「关阴影 = 零开销」需三处协同，缺一处即静默失效**：① `sunLight.castShadow = false`（停阴影 pass）
  ② `uShadowStrength = 0`（视觉零影响）③ **DayNight 的 `shadowEnabled` 标志**（否则日夜循环每帧
  `_apply` 把 uShadowStrength 写回 skyDim → 关闭被静默覆写）。⚠️ ③ 的失效面 `daynight-visual`
  **测不出**（它走 override 模式 `update()` early-return），只有真实日夜循环才暴露。另有**请求源
  门控**：`editor.subscribe` / 移动阈值 / `onSunDirection` 三处的 `request()` 都要判 castShadow；
  消费端门控（上一条）是**单点权威兜底**，源侧门控是纵深防御 —— 只靠源侧则每加一个请求源都要补一次，
  漏一个就复发（本次缺陷成因正是 editor.subscribe 与消费端双双漏门控）。
- **光源必须跟随玩家**（`_updateSunPosition()`，移动超 5 格重定位）：阴影相机只有 ±30，不跟随则
  覆盖不到玩家周围的可见几何 → **阴影系统对整个可见世界静默失效**（Tier 4 闸门用例自己手动摆光源，
  测不出来，须靠「光源跟随」专用例钉住）。太阳方向从 `dayNight.params.sunDirection` 读（唯一权威，
  红线 1：不写字面量方向）。
- **太阳方向随日夜连续插值**（有意偏离 mc-lite 的风格切换离散变化）：`VISUAL_STYLES` 存 mc-lite 三组
  原值、`paramsAtHour` 返回归一化值、`_apply` 调回调前统一归一化 —— **归一化必须收在 `_apply`**
  （`setStyle` 传的是原值，night 长 0.9952 非单位长度；只在一处归一化会让两条路径的光源偏移不一致）。
- **阴影让 morning 与 noon 的整屏平均亮度趋同**（物理正确：低太阳角 → 长影 → 抵消 skyDim 亮度差）→
  撞 M2 冻结断言 `|morning-noon| > 0.01`。**用户裁定 = 隔离变量**（daynight-visual 量前调
  `setShadowsEnabled(false)`，断言与阈值逐字不动）。⚠️ 关键推论：**阴影本身就会让该断言收敛**
  （与 DR-6 浓度联动无关）→ 改 DR-6 也救不了，后续同类冲突只能隔离或重标。
- **Tier 4 像素判据两条踩坑**：① **perf HUD 的半透明黑底**（`perf-hud.js` `position:fixed` +
  `rgba(0,0,0,.55)`）会压暗屏幕左上象限 → 亮度采样必须**隐藏全部 HUD**（`#hud-root > *` +
  `#crosshair` + `#settings-btn`），否则暗区跟着屏幕走而非世界走（实测曾误判为渲染缺陷）；
  ② **不能直写 uniform 做像素判据**：`start()` 的首次 `needsUpdate` 早于关阴影 → 残留 shadow map
  **永久驻留**，强制 `uShadowStrength=1` 会把残留 map 采样回来 → 恒 FAIL。修法 = 同帧 A/B 比值 +
  **正向对照**（先开阴影断言有影证明判据有效，再关阴影断言无影）+ sanity floors（防黑屏恒真）。
- **构造顺序与 null 分支**：`sunLight` 必须先于 `RenderWorld` 创建（材质的 `shadow()` 节点在构建时
  固定 light 引用）；`createVoxelMaterials(atlasTexture, sunLight = null)` 的 **null 分支必须保持
  原路径**（5 个 fixture 不传 sunLight：`test-render-world` / `test-lamp-compare` /
  `test-sky-tree` / `test-ao-corner` / `test-ao`）。
- **阴影 pass 不消费 alphaTest** → 树冠投影是实心立方轮廓（Minecraft 原版同款）。若观感不可接受，
  升级为 `castShadowNode` + alphaTest（但对上面那条 depth-compare bug 大概率无效）。
- **实体不投射不接收**（本期范围外）：后续给实体加阴影 = InstancedMesh 开 castShadow + 材质乘
  `shadow()` 节点同手法（实体材质是 unlit MeshBasicMaterial，接收阴影同样需乘 shadow 节点）。
- **日夜循环下的阴影刷新频率口径（v1.47 改）**：刷新请求有三个源 —— 世界编辑 / 玩家移动超 5 格 /
  太阳方向变化。前两个是事件驱动（不变）；**第三个 v1.47 起加了角度阈值门控**
  （`SUN_DIR_GATE_DEG=0.5°`，太阳 0.3°/秒 → 约 **0.6Hz**，此前是每帧 120 次/秒重定位）。
  所有请求仍经 `ShadowScheduler` 的 200ms 节流 → 实际重渲上限 5Hz。
  ⚠️ **200ms 这个值不要改**（实测单次刷新成本与频率无关：强制 100/200/400/800/1600ms 下刷新帧中位
  8.74/8.74/8.82/9.04/9.12ms → 降频不让刷新变便宜，只增加阴影覆盖滞后）。
  ⚠️ **量阴影成本不能用聚合 p95**：5Hz 刷新帧只占 4.2%（30/722），刚好落在 600 帧窗口的 p95
  阈值**之下** → 聚合 p95 抓不到尖峰（「用聚合指标回答分组问题」）。须按「该帧是否刷新」分组统计
  （实测：稳态帧 8.3ms 与关阴影 8.33ms 逐位相同，刷新帧 9.0ms，摊平 ≈ 0.03ms/帧）。
  ⚠️ 另：`m3-2-orientation.spec.mjs:283` 的 `meshInflight === 0` 是 HEAD 既有
  独立 flake（与阴影无关，未修；实测频率 HEAD 2/30、门控后 7/30，小样本可能是噪声但值得观察）→
  全量回归若该断言 FAIL，先做交替对照判定。
- **BatchedMesh 的主 pass 与阴影 pass 共用一份 multi-draw 列表 → 每次阴影刷新会让阴影视锥外的
  几何整帧消失（远端闪烁），必须装守卫**（v1.46 修，用户实玩报告「远端闪烁」）：three r185.1 的
  `BatchedMesh.onBeforeRender()` 把逐 instance 剔除结果写进**实例字段**
  （`_multiDrawStarts`/`_multiDrawCounts`/`_multiDrawCount`/`_indirectTexture`，`three.core.js:27504-27634`），
  而 `onBeforeShadow()` 直接转调 `onBeforeRender(null, **阴影相机**)`（`:27636`）。一帧内真实顺序
  （钩子实测）：① 主 `onBeforeRender(主相机)` 建列表=453 → ② 阴影 pass `onBeforeShadow` **覆写同一列表**
  =142（只剩 ±30 阴影视锥内的 instance）→ ③ 主 `backend.draw` 读 `_multiDrawCount`（`three.webgpu.js:85522`）
  读到 142 → 主视锥内、阴影视锥外的几何该帧不绘制 → 透出天空。只在 `needsRefresh` 帧发生
  → 表现为「每次刷新一帧亮闪」。修法 = `render-world.js _installShadowListGuard`：`onBeforeShadow`
  入口快照主 pass 列表、`onAfterShadow` 出口恢复（+ 重置 `_indirectTexture.needsUpdate` 让 GPU 重传）。
  **实测证据**（探针 P17/P18/P19/P22/P23，平台 + 强制 5Hz 刷新 + 逐帧读像素）：亮闪次数==刷新次数
  （9 刷新→9 亮闪）且**只**在阴影视锥外采样点出现（视锥内 sd=0）；亮闪值恒 **192** == noon 天空亮度
  (135+206+235)/3 → 证明几何确实消失而非变亮；修法后远端 sd=0/jumps=0，drawCalls 与基线**逐位相同**
  （vd=8 实测 630）。回归门 = `sun-shadow.spec.mjs` 用例 9（负向验证：去守卫后 jumps=18/sd≈11/range≈54
  真 FAIL，与阈值 ≤3/<2/<3 差一个数量级）。
  ⚠️ **不能用 `perObjectFrustumCulled = false` 修**（更短的一行）：那会同时关掉**主 pass** 的逐 instance
  剔除 → drawCalls vd2 48→183、vd8 467→1785（实测 3.8×），撞破 `render-terrain` 冻结断言 `drawCalls<100`。
  ⚠️ **为什么 mc-lite 没有这个问题**：mc-lite 地形走 `InstancedMesh`（`GlobalInstancedMeshManager.js:56` /
  `ChunkGenerator.js:177,228`），它**没有**逐 instance multi-draw 列表（`onBeforeShadow` 是 Object3D 空实现
  `three.core.js:12151`）→ 阴影 pass 无从覆写主 pass 绘制状态。本仓按红线 5 用 BatchedMesh 通道级合批
  才暴露该上游缺陷。**后续任何「BatchedMesh + 阴影/多 pass 渲染」同理**（第二个投影 pass、反射 pass 等）。
  ⚠️ 本项**不进「六处偏离」清单**（那是视觉比对专用），是 three 上游缺陷 + 红线 5 选型的连带后果。
- **阴影相机必须做纹素对齐（texel snapping），否则影子边缘随玩家移动抖动**（v1.47 修，用户实玩报告
  「阴影随着玩家的移动会微微晃动，幅度不大但还是能察觉」）：阴影相机 ±30 / 贴图 256² → 每纹素
  ≈ 0.234 格；相机连续跟随玩家时，世界点在贴图上的 UV **分数部分**连续变 → 双线性滤波结果变
  → 同一世界点的阴影值抖动（shimmer），幅度最多半纹素 ≈ 0.1 格。修法 = `shadow-manager.js`
  的纯函数 `texelSnapOffset(center, sunDir, texelSize)`，`game.js _updateSunPosition()` 把相机中心
  吸附到纹素边界（相机基由 sunDir 构造，与 three `lookAt` 同口径：zAxis=sunDir、
  xAxis=normalize(cross(worldUp,zAxis))、yAxis=cross(zAxis,xAxis)）。
  ⚠️ **载荷性：偏移必须同时加到 `position` 与 `target`** —— 两者之差平行于相机 Z 轴，加同一向量
  方向严格不变；**只加一侧会改「position − target」→ 枪的 PBR 高光漂移**（那个方向就是太阳方向，
  也是 `_updateSunPosition()` 刻意不受 `castShadow` 门控的原因）。断言落在两条路径的交叉比对上
  （`normalize(position − target)` 逐分量 == `dayNight.params.sunDirection`，容差 1e-9）。
  ⚠️ `texelSize` 从 `(camera.right − camera.left) / mapSize.width` **读配置**，不写字面量（红线 1）。
  ⚠️ 退化保护：`sunDir` 平行 worldUp 时 cross 为零向量 → 返回 `[0,0,0]`（不对齐、不产 NaN）；
  `texelSize ≤ 0` 同理。本仓三组 `VISUAL_STYLES.sunDirection` 的 y 分量均 < 1，不会走到，但纯函数须自守。
  **实测**（探针 P25 + Tier 4 用例 10，固定世界点 + 分数纹素步长 0.05 格 × 12 步 + 每步强制刷新）：
  对齐 ON 亮度恒 112.63（spread **0.00**）、纹素相位恒 0.6（spread 0.00）；对齐 OFF 亮度
  118.77↔123.79（spread **5.02**）、相位 spread 0.93。阈值 spread ≤ 1.0（差 5×，不贴线）。
  ⚠️ **sanity floor 不能用「相位在变」**：对齐生效时相位**恒定**正是被测不变式 —— 拿它做下界会让
  修好的代码反而 FAIL。改用「阴影相机 target 的世界位移 > 0.2 格」证明玩家真的动了。
  ⚠️ **Tier 4 逐帧读像素必须在 rAF 回调内**：WebGPU swapchain canvas 在 rAF 外 `drawImage` 读到
  **黑屏**（探针 P25 首版踩坑：整条亮度剖面全 0，一度误判为「平台上没阴影」）。
  ⚠️ **有意偏离 mc-lite**：它无连续日夜循环（`sunDirection` 只在点风格按钮时变）且光源只在移动超
  5 格时重定位 → 无此抖动，故无此机制。
- **`onSunDirection` 的角度阈值门控不得加到移动阈值路径上**（v1.47）：两条重定位路径语义不同 ——
  `onSunDirection`（日夜方向变化）加门控是对的（太阳每帧只转 0.0025°，256² 贴图上不可见，
  门控前每帧重定位 120 次/秒）；
  而帧循环的移动阈值路径（`distSq > 25`）**加了会「走 5 格后影子钉在原地」**（玩家移动必须让
  阴影相机跟上）。实测门控效果：`cycleSeconds=60`（太阳 6°/秒）下 `_updateSunPosition()` 调用
  **11 次/秒**（理论 6 ÷ 0.5 = 12）；阈值归零时 **120 次/秒**（每帧，= 门控前）。
  ⚠️ **门控比较必须用 `onSunDirection(dir)` 的入参，不得读 `dayNight.params`** —— `get params()`
  走 `paramsAtHour()` → `lerpParams()` + `normalizeDirection()`，**每次调用新分配 2 个小对象**。
  初版门控自己读 `params` 做比较 → 被门控掉的帧仍每帧分配，白做了一半（入参是 DayNight 已算好的
  同值，零额外分配）。⚠️ 本门控消除的是「**重定位路径上**的额外 params 读取」（门控前每帧 2 次：
  门控自己 1 次 + `_updateSunPosition()` 1 次 → 门控后约 0.6Hz 各 1 次）；`DayNight._apply` 自身的
  每帧分配（`paramsAtHour` + 末尾 `normalizeDirection`）**不在本门控范围内**，属日夜循环固有成本，
  本次未动（勿写成「消除了每帧分配」）。
  ⚠️ **观测口径必须是 `_updateSunPosition()` 调用次数，不是刷新次数** —— 200ms 节流在下游，
  会把「每帧重定位」与「0.6Hz 重定位」的刷新次数都压到 ~5/s → 刷新次数测不出门控。
  ⚠️ **测这条门控须把 hour 设进插值段**（如 7.5）：启动默认 hour=12 落在 `KEYFRAMES` 的
  **noon 平台段**（[9,noon]~[17,noon]），该段 `sunDirection` **恒定** → 无论怎么加速日夜循环
  门控都永不放行（实测 `cycleSeconds=60` 仍 0/47 假阴性）。同 P14/P15 探针踩过的同一个坑。
  ⚠️ 两个门控是**串联关系**（方向门控 → castShadow 门控 → 200ms 节流），测下游必须让上游放行，
  否则断言恒真（既有的「关阴影不请求刷新」用例因此须同时设 hour=7.5 + cycleSeconds=60）。

### 阴影混合模型沉淀的活跃约束（v1.45，后续任何「unlit 材质 + 手动乘阴影/光照因子」必读）

- **unlit 材质接阴影时，阴影因子绝不能乘在最终颜色上**（v1.45 修的根因，用户实玩报告
  「阴影的部分都是黑乎乎的一片」）：`shadow()` 节点在影区返回 0 → `rgb × 0` = **纯黑**。
  mc-lite 自然的原因是它的体素材质是**受光的** `MeshStandardNodeMaterial`
  （`MaterialManager.js:268`），three 的阴影**只乘在方向光贡献上**，而 `AmbientLight(0xddeeff, 2.3)`
  （`Engine.js:194`）**不参与阴影** → 影区仍被环境光完整照亮，观感是「暗一档」而非全黑。
  mc-heavy 是 unlit 管线，`vShade` 里烘焙的 skylight 就是它唯一的「环境光」，乘在最终颜色上
  等于把这份环境光也乘没了。**修法 = 只衰减 skylight 项 + 给地板**：sky/block 两项分开传片元
  （`vSkyShade`/`vBlockShade`；`max(sky,block)×ao ≡ max(sky×ao, block×ao)`，ao≥0 → 拆分无损），
  片元只把阴影因子乘进 sky 项再取 max → **火把照亮的洞穴/室内不会被太阳阴影压暗**
  （mc-lite 无 blocklight 故无此问题，但语义上太阳阴影本就不该影响点光源照明）。
- **影区地板值要从上游的光照强度推导，不要拍脑袋**：`SHADOW_FLOOR = 0.5`（`materials.js` 导出）
  = mc-lite 的 `ambient/(ambient + sun·NdotL)` = `2.3/(2.3 + 3.2×0.8)` = **0.4733**（顶面）
  ~ 0.55（侧面）。实测修好后影区比值 **0.735**，与 mc-lite 的理论影区亮度 **0.71**
  （0.4733 线性 → sRGB 0.71）几乎重合 → 地板值对齐上游观感，不是凑数。
- **两层 mix 的嵌套顺序是载荷性的**：`mix(1, mix(FLOOR, 1, shadow()), strength)` —— 内层给地板、
  外层调浓度。⚠️ 写成单层 `mix(FLOOR, 1, shadow() × strength)` 是错的：strength=0（关阴影/夜里）时
  mix 取**左端 = FLOOR** → **关掉阴影反而把全世界压到 50% 亮度**，且「关阴影 = 零视觉影响」的
  不变式静默失效（spec 用例 7/8 的 `A/B > 0.85` 断言会 FAIL）。
- **逐方块排除投影走 `maskShadowNode`，不是 `castShadowNode`**：后者要求
  `shadowMap.transmitted === true`（`three.webgpu.js:62546` 会 warn），前者无此要求。
  `maskShadowNode` **只被阴影 pass 消费**（`_getShadowNodes`，`:62528/62573`），主 pass 的
  `setupDiffuseColor` 只读 `maskNode`（`:21595`）→ **这些方块在主渲染里照常显示，只是不写阴影深度**。
  链路：`blocks-data.js` 的 `shadowCast:false` → `registry.shadowCastTable` → mesher 写
  **packed bit14** → `mat.maskShadowNode = noShadowCastBit.equal(0)`。
  ⚠️ bit14 是 packed 里第一个超过 bit13（自发光）的位，Uint32 容量充足（现用 bit0-14）。
- **排除清单的唯一权威 = mc-lite `BlockData.isShadowEnabled:false`**（实测解析其 124 键 =
  **102 项投影 / 20 项不投影**）。那 20 项里在 mc-heavy 走 cullMode 'none'/'transparent' 或不是方块的
  （air/collider/water/swamp_water/realistic_trunk_collider/bed_alias_block/mine_cart）**通道级已排除**，
  故只需给落在 opaque/cutout 通道的 **13 项**声明 `shadowCast:false`：cloud / 7 种花草菇 /
  vine / lilypad / 创造台两项 / hanging_lamp。⚠️ **cloud 是必须项**：它在 mc-heavy 是 **opaque 通道**
  （M2-7 为修侧面混叠从 transparent 挪过去的）→ 通道级 castShadow 让云全部投影，而 Y=35/55 的云簇
  完全在阴影相机 far=250 视锥内 → **地面出现大面积移动云影黑斑**。实测修复后 cloud 柱逐点扫描
  比值**恒 1.000**（对照 stone 柱 0.726）。
- **`shadow.radius` 用 mc-lite 原值 2.6，不是 4**：原 4 是「阴影乘在最终颜色上（影区纯黑）」时代的
  **补偿值**（那时须把阴影糊开才不致于全黑）；改成「只衰减 skylight + 地板」后 radius=4 反而把阴影
  **冲淡**（实测谷底比值 0.852 vs r=2.6 的 0.726，而半影宽度两者同为 4/8 点 → 边缘不更硬）。
  ⚠️ **移植上游参数时须检查它是否在补偿另一个缺陷** —— 上游缺陷修好后，补偿值会变成新缺陷。
- **「影区须比基线暗」这类单侧断言抓不到「影区纯黑」**（v1.45 的测试口径缺陷，比实现缺陷更值得记）：
  v1.44 的 Tier 4 判据只有上界 `ratioA < 0.85`，而**纯黑（实测 0.675）也满足「比基线暗」** →
  该用例结构上就拓不到混合模型错误。负向验证实测：把 `SHADOW_FLOOR` 改回 0（= 旧的乘到纯黑行为）后
  `ratioA = 0.122`（影区几乎纯黑）而旧断言**仍全绿**。故须补**下界 `> 0.5`**（实测修好 0.735 /
  破坏态 0.122，两侧都不贴线且能真实区分修好/改坏）。同 `testing-policy.md` §2.7「负向验证盲区」：
  **写「变暗/变亮」类像素断言时必须同时钉上下界**，只钉一侧等于没钉。

## 权威文档（动手前必读）

按顺序读完再写代码：

1. [`docs/roadmap.md`](docs/roadmap.md) —— **项目进度唯一总览**（里程碑总表 M0~M9 + 第二阶段
   依赖链 + **第三阶段依赖链（M8→M9，待实施）** + 后续扩展点接入点 + 去哪找细节）。
   想知道「做到哪了、下一步做什么」先看它。
2. [`docs/phase-1-engine-design.md`](docs/phase-1-engine-design.md) —— **架构唯一权威**。
   所有子系统边界、DR 决策、验收口径都在这里；历次口径变更见其修订说明。
   **版本号以该文档自身首行为准，本文件不硬编码**（硬编码就是漂移源，已发生三次）。
3. [`docs/testing-policy.md`](docs/testing-policy.md) —— **测试分级的唯一权威**（Tier 1~4 判据 +
   门禁分层 + 红线静态门规则 + 与 M4~M7 的关系）。动手前先按它的判据确定本次改动属哪一级。
4. [`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
   —— **任务级执行清单 + v1.19~v1.31 历次改造记录**（含各次 bugfix 的根因与实测数据）。
5. `docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md` —— M1 实施计划（已完成，架构细节参照）。
6. `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` / `docs/m2-m3-performance-report.md`
   （M3-6 第一阶段性能报告 = 冻结基线）—— 实测与验收报告。
7. M4~M7 **已全部交付**。规格 `docs/superpowers/specs/2026-08-23-m{4,5,6,7}-*.md` 与计划
   `docs/superpowers/plans/2026-08-23-m{4,5,6,7}-*.md` 仍是架构细节参照；各 Epic 的实测数据、
   偏离表与踩坑清单看对应验收报告 `docs/m{4,5,6,7}-*-acceptance-report.md`。
   做同类后续 Epic（炮塔/床/宝箱等方块装置）前先读 M7 报告的 §3~§4。
8. **矿车 Epic 已交付**（M9 之后）。规格 `docs/superpowers/specs/2026-09-30-minecart-design.md`
   + 主计划 `docs/superpowers/plans/2026-09-30-minecart.md` + 验收报告
   `docs/minecart-acceptance-report.md`（实测数据 / 偏离表 / 负向验证清单 / 操作失误）。
   乘坐碰撞修复的实施记录 = `docs/superpowers/plans/2026-10-01-minecart-ride-collision.md`。
   做**可移动持久实体**类 Epic 前先读矿车报告的 §4（偏离表）与 §8（操作失误）。
9. **太阳阴影（shadow map）已落地**（独立改动 v1.44）。规格
   `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md`（DR-1~DR-8 + DR-4b + §9 六条偏离）
   + 计划 `docs/superpowers/plans/2026-10-13-sun-shadow-map.md`。做**渲染/光照类** Epic 前先读
   本文件「太阳阴影沉淀的活跃约束」小节与设计文档 v1.44 修订说明。

规则：

- 设计与实现冲突时，**以设计文档为准**，不要用「实现方便」推翻已核验的设计决策；
- **Tier 1 改动**必须按计划的任务与步骤走（Red-Green-Refactor），禁止跳步或省略失败验证；
  **Tier 2/3 改动**免 TDD 流程，改完跑 `npm run check` 即可 —— 不要为了改一个贴图地址而先写失败测试；
- 计划中标注「冻结」的断言数字（draw call 数、fps 阈值、p95 上限等）实测不符时
  **停下来报告，不要擅自改断言或静默放宽**；
- 需要新增机制/改动设计时，先更新设计文档再动代码，不在代码里埋「计划外补丁」。

## 不可违反的重构红线

这些是 mc-heavy 与 mc-lite 的本质区别，任何实现都不得回退：

1. **数据只有一份权威**：主线程 typed array 体素数据（`blocks` + `meta` + `blockEntities`）。
   网格、AO、可见面、碰撞、光照缓存全是**可随时重建的派生数据**。禁止引入第二份逻辑副本、
   多层缓存、或「渲染态与逻辑态分离」的容器。
2. **删除预生成**：世界无边界、无 `safeBounds`。地形 + 结构由 seed 确定性生成，chunk 进加载半径
   才生成，何时何地重算结果一致。存档只存玩家修改（edits diff）。
3. **重计算全部离开主线程**：GEN/MESH/LIGHT/REMESH 在 Worker 池跑。主线程每帧只做
   输入、物理、调度、上传、渲染。禁止在主线程跑全量 meshing/AO/结构布局。
4. **单一 meshing 管线**：面剔除是 meshing 的内部步骤。禁止独立 FaceCullingSystem、
   consolidation 中间态、地形 InstancedMesh、动态 mesh↔合并 mesh 双状态。
5. **发布粒度**：section(16³) 是重建/脏标记单元；默认 BatchedMesh 通道级合批
   （opaque/cutout/transparent 各一个），fallback 为 column 级 channel-major 3-group。
   顶点格式为 flat 三属性 `position/uv/packed(uint32)`。
   BatchedMesh 缓冲耗尽走三级兜底：`unusedVertexCount` 检查 → `optimize()` 回收空洞 →
   `setGeometrySize()` 整批扩容（`render-world.js _ensureCapacity`）。
6. **体素 DDA 射线**：玩家对地形求交互用 Amanatides-Woo 遍历，禁止对地形 mesh 做
   `THREE.Raycaster.intersectObjects`。
7. **Worker 池 + 版本协议**：异步任务携带 `(columnKey, columnVersion)`，回传版本不符即丢弃。
   禁止为竞态打 epoch/防抖/staging 之类的补丁（这是 mc-lite 的病根）。
8. **主线程/Worker 同构纯函数**：gen/mesh 核心算法无 DOM、无 three 依赖，主线程快速路径与
   Worker 精修路径共用同一份代码、输出同构缓冲。
9. **WebGPU 唯一后端**：three **r185.1**，本地 `vendor/three/` 经 import map 引入；不做 WebGL2 降级；
   启动 `navigator.gpu` gate 不通过即明确提示中止。
10. **module worker 约束**：worker 不继承页面 import map，`src/workers/` 下任何文件
    **不得 import three**，一律相对路径 import 本项目模块。
11. **光照模型（M1 定稿）**：skylight = 垂直落下不衰减 + 水平扩散 BFS 每格 -1（Minecraft 模型）。
    编辑快路径同步重算垂直单列且**只升不降**（挖块立即提亮；放块不压暗，暗化交异步扩散收敛，
    防黑闪）；区域扩散走 Worker `light` 任务异步收敛（`scheduler.enqueueLight`，编辑/悬挑触发）。
    AO/light 的 shade 必须在**顶点阶段**算成 float 经 float varying 传片元（three.webgpu.js:65404
    对 int varying 强制 flat 插值，片元读 uint 属性无渐变）。
12. **玩家物理手感**：水平碰撞 + onGround 时自动上台阶（`_tryStepUp`，MAX_STEP=1.0，mc-lite 手感）；
    上台阶相机走 StepLift ease-out 缓动（物理瞬时、视觉平滑）。

### 重构评审四问（写代码前自检）

任何新改动若对下列任一问题回答「是」，先停下来对照设计文档找统一入口：

- 是否引入了第二份权威数据/新缓存层？
- 是否把生成期问题推到了运行期（buffer 分发、跨 chunk 补刷）？
- 是否在主线程做了可后台化的重计算？
- 是否绕过统一管线新开了一个专属 Worker/子系统？

## 对标 mc-lite：能搬什么、禁止搬什么

### 直接复用（数据 / 算法 / 视觉）

- `src/constants/BlockData.js` → `src/voxel/blocks-data.js`（124 方块声明，转换规则见计划 Task 5）；
- `src/assets/textures/` → `assets/textures/`（122 张：116 顶层 + `bed/` 6 张，文件名原样保留）；
- `src/world/structures/*.json` → `assets/structures/`（原样复用；**两处有意例外**：`big_house.json`
  删了 3 个草地 lilypad（理由见设计文档 §4.3 lilypad 段）；`tall_well.json` 删了 1 个孤立
  `chest@(24,51,20)`（mc-lite 上游数据异常，井体只到 y=16 → 该宝箱在 y=51 完全悬空，
  用户报告「天空中好多悬空宝箱」，2026-09-30 修））；
- `src/workers/maps/*`（CityMap/Pyramid/FrozenMountain/SnowLand/IslandMap/RegionCenterUtils）
  → `src/gen/structures/*`（**算法照搬，接口改为 `Structure.rasterize(aabb)`，按 chunk 裁剪**）；
- `AOUtils`（四角 AO）、`OrientationUtils`（朝向 0-3）、`MathUtils`（seededRandom/noise/biome）算法；
- `Physics.js` 的碰撞语义、`Inventory/HUD/UIManager` 的 DOM 方案、`Engine.js` 的天空/雾/日夜/水面 shader；
- `SaveConfig` 的 DB 命名约定（老存档迁移工具后续接入）。

### 必须重写（只保留功能语义）

- 体素存储：`Map<chunkKey, Map<encodeCoord, entry>>` → `Uint16Array` column + 稀疏 edits；
- 玩家交互：`THREE.Raycaster` 对 InstancedMesh 求交 → 体素 DDA；
- 地形渲染：每类型 InstancedMesh 全立方体 → 逐面 meshing + BatchedMesh 合批；
- 持久化：整块 blockData 序列化 → edits diff + 确定性重生成。

### 禁止搬（mc-lite 的补丁架构，职责已被新管线吸收）

`FaceCullingSystem`、`FaceCullingWorker`、`ChunkConsolidation`、`BlockScatterManager`、
`GlobalInstancedMeshManager`、`WorldBoundsController`、`WorldGenerationService`（预生成）、
`AOBridge`、`AOWorker`、`WorldBlockDataStore`、`RegionCache`、`WorldChunkPayloadRegistry`
等多层容器与运行期分发状态机——**这些层次在新引擎中不存在，禁止以任何形式复活**。
设计文档附录 A 有完整模块映射表，移植前先查表。

## 技术约束

- **纯 JavaScript（ES2022+ ES Modules）+ JSDoc，禁止 TypeScript，无编译/转译、无 bundler**；
- three.js **r185.1**，本地 `vendor/three/`（three.webgpu.js / three.tsl.js / three.core.js），
  import map 指向本地文件；
- 端口 **8081**（mc-lite 占 8080，避免并行开发冲突）；
- 纹理 atlas：2048×2048、gutter 16/bleed 8、半 texel UV 内缩；7 张 250~362px 大图按 128×128 入图；
- ESLint 9 flat config（以 mc-lite 配置为底，本仓库五处修改见计划 Task 1 Step 3）；
- Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）；
- 每个任务结束必须 commit；**未获明确指令不得自动提交**。

## 目录结构

```
mc-heavy/
├─ index.html                  # import map（本地 vendor/three）+ WebGPU 启动 gate + 准心
├─ vendor/three/               # three.js r185.1（three.webgpu.js / three.tsl.js / three.core.js）
├─ docs/
│  ├─ roadmap.md              # 项目进度唯一总览（里程碑总表 + 依赖链 + 扩展点）
│  ├─ phase-1-engine-design.md # 架构唯一权威（版本号见该文档首行）
│  ├─ testing-policy.md        # 测试分级唯一权威（Tier 1~4 判据 + 门禁分层）
│  ├─ m{0,1,2-m3,4,5,6,7}-*-report.md    # 第一阶段里程碑实测与验收报告（m3-* = 冻结性能基线）
│  ├─ m{4,5,6,7,8-tnt-turret,9-playground}-*-acceptance-report.md
│  │                            # 各 Epic 验收报告（实测数据 / 偏离表 / 负向验证清单 / 操作失误）
│  └─ minecart-acceptance-report.md      # 矿车 Epic 验收报告（2026-10-01 补写；不匹配上面的
│                              # m{...}-* 命名模式 —— 矿车不是 M 编号里程碑，是 M9 之后的独立 Epic）
├─ tools/build-atlas.mjs       # atlas 离线打包（npm run atlas）
├─ tools/bake-procedural-textures.mjs # 程序化贴图烘焙（mc-lite canvas 材质 → PNG）
├─ tools/bake-icon-atlas.mjs   # 全量背包图标离线烘焙（npm run icons）：物品集合全量×两套尺寸
│                              #   → assets/icons-atlas.png + icons.json（预生成 CSS 串+指纹）
├─ tools/icon-fingerprint.mjs  # 图标输入指纹共享模块：烘焙脚本与 check:data 同一份逻辑（红线 1）
├─ tools/bake-night-sky.mjs    # 夜空立方图无缝烘焙（npm run nightsky）：方向空间加权重采样
│                              #   源图 assets/sky/night-src/（mc-lite 原图）→ assets/sky/night/
├─ tools/night-sky-fingerprint.mjs # 夜空烘焙参数与指纹共享模块（烘焙脚本与 check:data 共用）
├─ tools/bake-zombie-head.mjs  # 丧尸头部马赛克纹理烘焙（npm run zombie）：128×64 双区并排
│                              #   → assets/zombie/head.png + head.json（尺寸+输入指纹）
├─ tools/zombie-head-fingerprint.mjs # 丧尸头部图案参数与指纹共享模块（同上，红线 1）
├─ tools/check-architecture.mjs # 静态架构门（npm run check:arch）：红线可静态检查的部分
├─ tools/check-data.mjs        # 数据契约门（npm run check:data）：关系型断言取代硬编码计数
│                              #   （含图标过期指纹检查）
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制（被 build-atlas 递归扫描进世界 atlas）
│  │  └─ procedural/           # 程序化贴图烘焙产物
│  ├─ atlas.png + atlas.json   # 世界渲染 atlas 生成产物，提交入库
│  ├─ icons-atlas.png          # 背包图标 atlas（独立于世界 atlas，1024²）
│  ├─ icons.json               # 图标 manifest：预生成 CSS 串 + 输入指纹
│  ├─ sky/                     # 天空盒立方图：day/ = mc-lite skyBox4 原图；night/ = 烘焙产物
│  │                           #   night-src/ 存 mc-lite skyBox1 原图（烘焙输入，勿当渲染资源）
│  ├─ zombie/                  # 丧尸头部纹理（**不在 textures/ 下** —— 那里会进世界 atlas）
│  │  └─ head.png + head.json  # 128×64 双区并排（左半无眼睛/右半有眼睛）+ 尺寸与输入指纹
│  ├─ sounds/                  # 音效（M4 四件武器音效 + M7 `put.mp3` + M8 `explosion`/`turret_gun_fire`）
│  │                           #   + v1.63 `bgm.mp3`（4.0MB / 254 秒循环背景音乐，从 mc-lite 原样复制）
│  │                           #   效果音 id 清单的唯一权威 = `render/audio-manager.js` 的 `SOUND_IDS`；
│  │                           #   背景音乐走独立的 `BGM_ID`（语义不同，不得混进 SOUND_IDS）
│  ├─ effects/                 # 序列帧特效图集（**不在 textures/ 下** —— 那里会进世界 atlas）
│  │  └─ big_blow.png          # TNT 爆炸序列帧（500×200，5×2=10 帧，从 mc-lite 原样复制）
│  ├─ sky/                     # 天空盒立方图（v1.58；**不在 textures/ 下**，不走世界 atlas）
│  │  ├─ day/                  # 白天云层：6 面 × 1024²（mc-lite skyBox4，912K，原样复制未重编码）
│  │  └─ night/                # 夜空星空：6 面 × 1024²（mc-lite skyBox1，5.1M）
│  │                           #   清单唯一权威 = `render/sky-config.js`（check:data 的 [天空盒] 环节）
│  └─ structures/              # 从 mc-lite 复制 JSON
└─ src/
   ├─ core/        # game.js / scheduler.js / worker-pool.js / budget.js / perf.js / perf-hud.js
   ├─ voxel/       # constants / block-registry / chunk-column / world-data / blocks-data / faces-data
   ├─ gen/         # noise.js / terrain.js / structure-index.js / structures/*（M2 地标与空中结构）
   │               #  scatter.js 结构撒布判定 + 代码生成 house/ship（唯一权威；Worker 同构）
   ├─ mesh/        # mesher.js / lighting.js / atlas-loader.js（Worker 同构）
   │               #  iso-icon.js 等轴测投影纯函数；mesher.js 导出 TEMPLATES / FACE_VERTICES /
   │               #  FACE_UVS 供图标烘焙复用——形状与 UV 的唯一权威，图标不得有第二份几何定义
   ├─ render/      # render-world.js（BatchedMesh 发布层）/ materials.js（TSL）
   │               #  sun-shade.js（v1.58 太阳方向光的**标定常数与纯函数**，three-free：
   │               #    SUN_AMBIENT / SUN_INTENSITY / FACE_NORMALS / sunTermFor；Tier 1 单测
   │               #    与 materials.js 的 TSL 必须共用同一份常数）
   │               #  sky.js（v1.58 天空盒双立方图交叉淡入 + 日轮/月轮）/ sky-config.js
   │               #    （立方图清单唯一权威，three-free，供 check:data 的 [天空盒] 环节）
   │               #  fog-sky-direction.js（v1.59 雾色方向换算**纯函数**，three-free：
   │               #    俯角一律归地平线带、只保留方位角；materials.js 的 TSL 同构并 import 其 ε）
   │               #  ocean.js（800×800 无限海面平面 + TSL 波纹/遮罩）/ ocean-mask.js
   │               #    （水面遮罩判据唯一权威：阈值 + 五点纵深 + 城市 bounds 门控；
   │               #      CPU 版供单测，ocean.js 的 TSL 版同构实现共用其数值常量）
   │               #  weather.js（天气状态机）/ rain.js（雨效）/ entity-render-layer.js（M5 受控实体发布层）
   │               #  shadow-manager.js（太阳阴影刷新节流 ShadowScheduler：200ms 最小间隔 + pending
   │               #    补刷，纯逻辑无 three；消费端 game.js 帧循环 tick + per-light needsUpdate）
   │               #  zombie-renderer.js（M6 六部件固定容量 InstancedMesh；无活跃丧尸时 visible=false；
   │               #    head 走单纹理 UV 分区 —— 正面顶点 16-19 采纹理右半「有眼睛」，见 applyHeadUV）
   │               #  zombie-head-texture.js（头部纹理加载，主线程专用；npm run zombie 烘焙产物）
   │               #  minecart-renderer.js（矿车 2 个 InstancedMesh：车斗 + 4 轮；零实例时
   │               #    visible=false；车斗纹理运行时 canvas 生成 → 无指纹门禁，靠 Tier 4 兜底）
   │               #  view-arm.js（第一人称手臂：单个 unlit Mesh 挂 camera 下，与 view-weapon.js
   │               #    互斥显示；徒手可见 + 挖/放挥动。**挥动用原版双曲线** sin(√p·π) 快出主劈
   │               #    + sin(p²·π) 滞后甩腕（v1.49，取代 mc-lite 的对称单曲线））
   ├─ entities/    # entity-manager.js（动态实体唯一权威 + generation + AABB raycast）
   │               #  entity-types.js（probe 定义 + AABB slab 射线；Worker 同构，无 three）
   │               #  zombies/（M6，Worker 同构无 three）：zombie-config.js（冻结玩法数据唯一权威）
   │               #   + zombie-system.js（ZombieService 玩法入口 + zombieDefinition 含 60Hz 物理）
   │               #  zombie-nests/（M7，Worker 同构无 three）：nest-config.js（巢穴玩法数据唯一权威）
   │               #   + nest-blueprint.js（只读 JSON → 坐标展开 + 唯一关键格校验）
   │               #   + zombie-nest-service.js（全局索引 / 预检 / 原子一次事务放置 / hydrate）
   │               #   + zombie-nest-controller.js（增量失效 + 8 秒节流六层刷怪 + column 生命周期）
   │               #  minecarts/（矿车 Epic，Worker 同构无 three）：minecart-config.js（冻结玩法
   │               #   数据与几何尺寸唯一权威）+ minecart-system.js（移动/转弯/碰撞/连挂同构
   │               #   纯函数 + MinecartService 玩法入口 + minecartDefinition 持久实体）
   ├─ player/      # player.js / physics.js / raycast.js / step-lift.js
   │               #  view-bob.js（跑动视角晃动：**纯函数无 three/无 DOM**，与 step-lift.js 同手法
   │               #    供单测直接驱动；判据 = 移动 + 全速 + 不跳跃。v1.49 起含相机 roll/pitch）
   │               #  inventory.js（物品模型）/ orientation.js（朝向三分支纯函数）/ weapons/*（M4）
   ├─ ui/          # coords-hud.js / hotbar.js / settings-panel.js / settings.js
   │               #  inventory.js（背包面板：DOM 方案照搬 mc-lite）/ icons.js（图标 manifest 加载）
   ├─ save/        # persistence.js（IndexedDB edits + M5 entities store）/ progress-codec.js
   │               #  （v1.43 进度包编解码纯函数：`mc-heavy-progress` v1 = seed + edits + entities；
   │               #    导出/导入的坐标换算与坏条目分类在此，面板只做文件 I/O）
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

依赖方向单向：`voxel ← gen ← mesh ← render`，反向依赖禁止（`npm run check:arch` 静态门守）。
`core/` 是**装配层**（`game.js` 组装全部子系统、`scheduler.js` 编排任务），依赖任何层合法。
`voxel/`/`gen/`/`mesh/`/`workers/`/`entities/`（M5）是 Worker 同构层，不得 import three、不得
自建 Worker（M5 规格 §3「不新建 Worker」；`check:arch` 静态门守，Worker 创建入口唯一 =
`core/worker-pool.js`）；例外 `mesh/atlas-loader.js`（主线程专用，运行时加载 atlas 纹理必然
依赖 three）见 `tools/check-architecture.mjs` 白名单。另有 `src/tests/`（浏览器内单测 + fixture）、
`src/bench/`（基准页）、`tests/`（Playwright spec）、`server-script/`（静态服务）。

## 开发命令

```bash
npm install                    # playwright 固定 ^1.62.1（复用本机 chromium-1234 缓存）
npm start                      # 静态服务 http://localhost:8081
npm run check                  # 日常最小门（2.6s 实测）= check:arch + check:data + lint
npm run check:arch             # 静态架构门（Tier 1，285ms）：12 条重构红线可静态检查的部分
                               #   three 隔离/禁止类名/依赖方向/发布层三级兜底，违规退出码 1
npm run check:data             # 数据契约门（Tier 2，277ms）：关系型断言取代硬编码计数
                               #   引用完整性/物品集合关系式/图标同步/测试注册完整性
npm test                       # Playwright 全部验收（tests/*.spec.mjs）
npx playwright test tests/<name>.spec.mjs   # 跑单个 spec（计时断言 flaky 时须单独连跑）
npm run bench                  # M3-5 性能基线跑图（4 场景 → docs/m3-baseline.{md,json}）
                               #   加 -- --check 为回归门禁（回退 >10% 阻断，退出码 1）
npm run lint                   # eslint src tools tests
npm run icons                  # 烘焙全量背包图标 → assets/icons-atlas.png + icons.json
                               #   改背包内方块的贴图地址或 mesher 几何后需跑，否则图标静默过期
npm run zombie                 # 烘焙丧尸头部马赛克纹理 → assets/zombie/head.png + head.json
npm run nightsky               # 烘焙无缝夜空立方图 → assets/sky/night/*.jpg + night-sky.json
                               #   改 tools/night-sky-fingerprint.mjs 参数后需跑，否则贴图静默过期
                               #   改 tools/zombie-head-fingerprint.mjs 的图案参数后需跑，
                               #   否则纹理静默过期（check:data 的 [丧尸头部] 指纹检查会抓）
npm run atlas                  # 重新生成 assets/atlas.png + atlas.json（世界渲染 atlas）
                               #   注：新增 textures 子目录会重排已有 tile 坐标（shelf 装箱按字母序）
```

**门禁分层**（何时跑什么，详见 [`docs/testing-policy.md`](docs/testing-policy.md) §6）：
改贴图地址/alias/文案（Tier 3）跑 `npm run check`；改物品集合/图标表/atlas（Tier 2）同左；
改纯函数算法/协议/数据模型（Tier 1）加 `npm test`；改热路径（mesher/materials/render/
scheduler/physics）再加 `npm run bench -- --check`。**不要**为改一个贴图地址跑全量 E2E 或 bench，
**也不要**改了 mesher 几何却只跑 `check`。

调试与测试入口：

- 浏览器内单测：`http://localhost:8081/src/tests/index.html`，runner 暴露
  `window.__MC_TEST_RESULTS__`（结构 `{suites:[{tests:[...]}], passed, failed, total}`，
  用例在 `suites[].tests[]` 里，须 `flatMap` 展开）；
- 性能基准页：`http://localhost:8081/src/bench/webgpu-publish.html`（暴露 `window.__BENCH__`）；
- 游戏入口暴露 `window.__MC_GAME__`（world/player/scheduler/registry + perfSnapshot/renderStats），
  Playwright 交互测试经此编程驱动（无头环境无真实键鼠/pointer lock）。

## 测试工作流（分级 TDD）

**分级策略的唯一权威是 [`docs/testing-policy.md`](docs/testing-policy.md)**，本节只给最小口径。
判据不是「改动大小」也不是「文件位置」，而是**改坏了会怎样、多久能被发现**：

| 级别 | 改坏了 | 发现方式 | 测试要求 |
|---|---|---|---|
| **Tier 1** 机制/架构/性能/API | 静默数据错误、性能回退、红线回退 | 肉眼玩不出来，只能靠断言 | **必须 TDD** + 门禁 |
| **Tier 2** 数据契约/集合口径 | 约定值不一致（图标空槽、方块消失） | 立刻可见 | **门禁断言，免 TDD 流程** |
| **Tier 3** 文案/资源引用/观感 | 观感不对 | 立刻可见 | **免测试**，只需 lint |
| **Tier 4** GPU 渲染结果 | 渲染不对 | 单测测不到（TSL 在 GPU 求值） | **像素级实测**，不宣称目视 |

**Tier 1 的 TDD 流程不变**（RED → 验证 RED → GREEN → 验证 GREEN → REFACTOR）。
测试一开始就通过，说明测试写错了或在测已有行为。RED 阶段不得把新测试从
`src/tests/index.html` 临时移除来「通过」。

修改 `src/**/*.js` 后任务结束前跑 `npm run lint`，保持新增代码 0 error（warning 可接受）。

## 性能验收口径（第一阶段）

目标表见设计文档 §1（冷启动 <2s / 视距 8 chunk / 120Hz ≥90fps / 跨 region 无感知 /
放挖 <2ms / 存档 KB 级）。主线程帧预算按 8.3ms（120fps）标定：mesh 上传 ≤3ms、
快速路径 ≤2ms、光照 ≤1ms/帧。性能回退 >10% 即阻断合入；CI 帧率采样只做趋势参考，
**本机设备矩阵才是硬验收**。

- **帧时口径**：120Hz vsync 锁帧下帧间隔被量化为 8.33ms，`frameMs.p95 < 8.3` 数学上不可满足
  （测的是 vsync 抖动而非渲染负载）。故以 **fps 为主断言**，`frameMs.p95 < 16.7` 作防跌破
  60fps 二级门。该口径在全部性能 spec 一致采用。

## 实测环境事实（2026-08-19，勿凭印象改）

- Playwright **1.62.1** 对应 chromium-1234（本机缓存已存在），不要降级到 1.59.1；
- headless WebGPU 矩阵：Playwright 默认 headless shell 零 flag **拿不到 adapter**；
  必须 `channel: 'chromium'` 才能零 flag 走 Metal（本机真 GPU）；
  Linux CI 用 `--enable-unsafe-webgpu --use-angle=swiftshader --enable-dawn-features=allow_unsafe_apis`；
  `--enable-features=Vulkan` 在 macOS 无作用，勿加。
- exec_command 会话之间后台进程会被杀：dev server 必须「启动 + 使用 + 关闭」在**同一条命令**内
  （`node server-script/start-server.js & SERVER_PID=$!; ...; kill $SERVER_PID`）。
  若 8081 已有本项目 server 在跑，直接复用不重启。
- 沙箱禁止 `rm`；临时脚本放 `/tmp` 或项目内 `.tmp.mjs` 后用 `mv` 清理。
- Node v26.4.0；`/tmp` 下的脚本无法解析项目 node_modules，需在项目目录内运行。
- **截图的 `Read` 只返回 URL、不渲染成图像** → 不能宣称目视验证，须改用像素级 / DOM 几何实测。

## 后续功能扩展点

第二阶段 M4~M7 与第三阶段 M8~M9 **已全部交付**，矿车 Epic 也已交付。
**哪些扩展点已交付 / 待做，以及每项的引擎接入点，一律查
[`docs/roadmap.md`](docs/roadmap.md) 的「后续扩展点」表格**（本文件不复制那份清单 ——
同一事实的多个副本会漂移，已发生过：矿车交付后本段仍把它列为未交付扩展点）。
待做的扩展点包括灯/光源、床/宝箱/门、音频、存档迁移、玩家生存战斗等。
**新功能必须通过 roadmap 表里的接入点实现，不得绕过 meshing/数据/事件管线另开路径。**

M7 交付了一套可复用的**「方块锚定装置」模式**（持久真相 = 某格 blockEntity / 派生 controller
只在 anchor column 已加载时存在 / 失效走 `block-changed` 增量事件 / 全局上限经
`listBlockEntities` 扫库判定）—— 炮塔、床、宝箱等同类方块装置可直接套用，不必另开持久化路径。
细节见 roadmap「M7 交付的可复用模式」段与本文件「M7 巢穴沉淀的活跃约束」段。

## 沟通与提交纪律

- 全部使用中文；解释设计取舍时引用设计文档章节号；
- 改动前说清楚「为什么」，改动后附验证证据（命令输出、帧时、draw call 数），不凭感觉宣称通过；
- 提交必须等用户明确指令，提交信息用 Conventional Commits。
- 诊断 bug 不猜：先在真实游戏/隔离环境复现、读实际数据（light 值/扫描线/队列状态）定位根因，
  再动手修。光照类 bug 尤其如此（垂直/扩散/快慢路径多，凭印象改会引入回归）。
- **写对照脚本做诊断时，对照侧与被测代码必须只差那一个要考察的变量** —— 两侧共用同一个错误假设
  会让对照恒等（得出「两者一致」的假结论），像素集合/统计口径不一致会得出机制上不可能的数值。
  出现机制上不可能的数值时先怀疑脚本本身。
