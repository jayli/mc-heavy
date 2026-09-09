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

**项目进度的唯一总览是 [`docs/roadmap.md`](docs/roadmap.md)**（里程碑总表 M0~M7 + 第二阶段
依赖链 + 后续扩展点）。本文件不复制进度表 —— 同一事实的多个副本会漂移。

一句话现状：第一阶段 **M0~M3 全部完成**并验收达标，两个收尾补丁项（M3.1 背包 / M3.2 方块朝向
放置交互）也已落地；此后是一串独立 bugfix 与改造（v1.19~v1.38）；第二阶段 **M4 玩家武器已完成
并验收**（含遗留 TODO「设置面板破坏方块开关」），**M5 实体运行时已完成并验收**（验收报告
`docs/m5-entity-runtime-acceptance-report.md`），**M6 丧尸已完成并验收**（验收报告
`docs/m6-zombies-acceptance-report.md`；丧尸**不攻击玩家**，无 PlayerVitals/近战/掉落/自然刷怪/
巢穴），M6 遗留 TODO 两项**已于 2026-09-09 补齐**（头部马赛克图案 —— 原预设的材质数组方案实测
不可行，改走单纹理 UV 分区；实体间排斥 —— M6 交付遗漏，照搬 mc-lite 的 AI 层排斥力但须换算
单位 + 补完全重叠 tie-break），**M7 玩家放置丧尸巢穴尚未开始**（规格与计划已备好，见「权威文档」）。

**历次 bugfix / 改造的完整记录不在本文件。** 权威副本分两处：① **第一阶段独立改动**
（v1.19~v1.31、v1.35）—— 设计文档的修订说明（每条含根因、实测数据、门禁对照）+
[`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
（v1.19~v1.21 独立章节、v1.22~v1.31 表格）+ [`docs/roadmap.md`](docs/roadmap.md) 表格；
② **M4 交付后的实玩反馈修正**（v1.32~v1.34、v1.36）—— 验收报告
`docs/m4-weapons-acceptance-report.md` 偏离表 + roadmap「M4 之后的遗留 TODO」段（**不进**
设计文档修订说明，也不 bump 设计文档版本号——那是架构口径变更专用）。本文件只保留
**会影响后续实现决策的活跃约束**（下节）—— 它们散落在历次改动中，读单个文件看不出来。

测试现状：Playwright spec 全量 + 浏览器内单元测试全绿。**用例计数以 `npm run check:data`
输出为准，不在文档硬编码**（同一事实的多个副本属「改动放大器」，违反红线 1 精神）。
`m1-acceptance` 计时断言在高负载下偶发贴线 flaky（16.7±1e-6 / 2.1ms），单独复跑通过。

### 活跃约束（历次改动沉淀，会影响后续实现决策）

这些不是历史记录，是**仍在生效的口径**。违反会引入回归或与设计文档冲突。

- **实例原点换算基准（极易误判几何差异）**：mc-lite 几何以**块中心**为原点，四条放置路径全部
  `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
  `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。
  **比对 mc-lite 几何数字时必须 +0.5 换算。**
- **对齐上游须实测其运行时行为，不能读定义推断**：mc-lite 床材质的 `offset:[0,0.5]` /
  `rotation:-π/2` 全仓**零消费点**（死字段），照字段名实现会渲错。与「诊断 bug 不猜」同一原则。
- **五处已知的有意偏离 mc-lite**（视觉比对时勿按其原样判定，均在 §4.3/§4.5.4 标注）：
  ① `vine` 落格内 y∈[0,1]（mc-lite 溢出半格 y∈[0.5,1.5]）；② 吊灯 UV 按部件分区 + 绳呈单色
  深灰（mc-lite 两几何 UV 全幅、绳吃 emissive 呈亮色）；③ 背包图标用离线烘焙等轴测投影
  （mc-lite 是手工绘制贴图，其图标与游戏内方块颜色不一致）；④ `lilypad` 模板 y=-0.48 +
  生成格位 `SEA_Y+1`（mc-lite 是装饰实体、原点为块中心 → 叶面 -1.98 沉水 0.98）；
  ⑤ `getAO` 去掉对角门控（mc-lite/MC 原版 `(side1||side2)?corner:0`，两侧都开阔时对角逐格不计入
  → 凹角东南对角格无阴影、露出「阴影的边」；去门控后对角格 AO=2，阴影连成环）。副作用是**全局**的：
  所有「仅对角遮挡」顶点暗一档（悬浮方块斜对角、台阶斜接处），原版 MC 故意让这些不变暗。
- **lilypad 的几何与格位是耦合的，改一处必须同时改另一处**（§4.3 标注）：只改模板 y →
  叶面悬空半格；只改生成格位 → 叶面贴块底仍沉水。水面下沉 0.5 后暴露水面顶面只有**半格高**，
  与陆地整格顶面差半格 —— 同一份几何无法同时贴合，故 `big_house.json` 的 3 个草地 lilypad 已移除
  （「`assets/structures/*.json` 原样复用」的唯一有意例外）。
- **结构撒布有四条路径，前三条是 M2 欠账（v1.37 补齐）**：① 城市撒布
  （`flowerBed`/`pavilion`/`tallWell`/城市 filler `house`）；② 城市外 `house`（代码生成，
  非 JSON —— **草地上的房子在这里**，mc-lite `WorldWorker.js:2946`）；③ 城市外大型静态结构
  （`desertPyramid`/`desertVillage`/`uglyHouse`/`tank`）。候选在 **region layout 层**算一次
  （`computeScatterCandidates`，DR-13「各 GEN Worker 只做 rasterize」），`apply.js` 阶段 2.7
  只做 AABB 裁剪光栅化。唯一权威 = `src/gen/structures/scatter.js`。
  **四处有意偏离 mc-lite，勿照原样改回**：
  ① `generateCodeHouse` 的材质/烟囱用 `seededRandom` 而非 mc-lite 的 `Math.random()`
  （照搬会让同 seed 两次生成配色不同 → 违反红线 2）；
  ② 判定函数**不带「同类已占用」参数** —— mc-lite 靠 chunk 局部运行期 Set 防重叠，
  移植成参数会让同一坐标在不同 column 得出不同结论 → 跨 column 光栅化接缝断裂
  （半个亭子）。取舍依据实测：mc-lite 单 chunk 内同类命中 ≥2 仅 0.75%/1.42%；
  ③ 「避开树」半径 = **2**（mc-lite house 8/10、pavilion-tallWell 5~7）—— mc-heavy 城市树
  **无互斥**，密度 1.39%（mc-lite 约 0.44%，高 3 倍），照搬大半径会把撒布结构**全部挡掉**
  （实测各半径保留率：2→66~72% / 7→2~3% / 8~9→**0%**）；
  ④ **陆地**城市外候选一律不撒在水下（mc-lite 无此门控，会产出水下房子）。但
  `ship` 沉船是**有意的水下结构**（门控 `h < -6`，桅杆顶仍在水下 1~5 格）—— 两类门控
  **方向相反**，勿把水下门控挪到 ship 判定之前（实测：挪了之后 ship 永不落地）。
- **撒布密度已刻意低于 mc-lite（勿调回去，会撞破冻结预算）**：城市撒布基值
  `flowerBed 0.0005→0.00025`（`pavilion`/`tallWell` 按 ×6/×3 派生自动跟随），城市外大 JSON
  `desertVillage 0.00016→0.00008` / `uglyHouse 0.00008→0.00004`。原因是两条**冻结断言**：
  `structure-gen` 的 `genP95 < 8ms`（§4.2）—— 大 JSON 1181/719 方块是光栅化大头；
  `m3-fullscene` 的 `gpuVertexBytes < 150MB`（§4.10）—— 花坛/亭子的花与树叶走 cutout 通道。
  **`house` 两类都不降**（opaque + 代码生成，不吃 cutout 预算、不是 p95 大头）。
- **代码生成撒布类型的派生基准 = `CODE_GENERATED_SCATTER_TYPES`（勿写成 `t !== 'house'`）**：
  `SCATTER_JSON_TYPES`、`apply.js` 的预载循环与 `CODE_GENERATORS` 映射表、`check:data` 门禁的
  `jsonTypes` 全部从它派生（红线 1）。当前两项：`house` / `ship`。写成字面量排除会让加第二个
  代码生成类型时门禁**误报**（要求它有 JSON 映射 + 磁盘文件），或该类型没被识别 → 走
  `rasterizeStructure` → cache 未命中 → **结构静默消失**（方块层面看不出差别）。
- **ship 沉船不看 biome/occupied（勿「补齐」门控）**：mc-lite 门控只有 `h < -6` + 概率 +
  `safeForStructure`。实测 109 个命中里有 11 个（10%）带植被、分布在 4 个 biome
  （AZALEA/FOREST/PLAINS/SWAMP，**无 DESERT** —— DESERT 高度被 `h*0.5+2` 抬高，不会低于 -6），
  给它补 biome/occupied 门控会让命中数掉到 98 且沙漠永不出沉船。
- **ship 的落地测试须用桅杆判据，不能用 footprint 范围判据**：footprint 5×7 覆盖多格、每格
  地形高度不同（有些高到 y+3），海底 `clay`/`sand`/`end_stone` 会落进扫描范围 → 判据恒 >0
  （实测踩坑：注入「`CODE_GENERATORS` 漏 ship」后仍全绿，无效负向验证；排除 water 也不够）。
  正确判据 = 桅杆中心列 `(x, y..y+4, z)` 的 5 格 `wood`（门控保证地形顶 ≤ y-1，桅杆必在地形上）。
- **cutout 扩容是离散 ×1.5 跳增，容量须留足余量**：`render-world.js _ensureCapacity` 里
  reserved 峰值只要超过 `maxVerts` **一个顶点**就整批跳到 ×1.5（1.8M→2.7M = +27MB，且
  粘性不回缩）。撒布把 cutout 峰值推到 1.80M，故 `CAPACITY.cutout.active` 从 450 调到
  **550**（maxVerts→2.2M，三通道合计 148MB < 150MB，余量 22%）。往 cutout 通道加方块量
  （新植被/新结构）时须重测峰值并重标定 —— 差一点就会触发扩容撞破内存预算。
- **背包物品集合口径 118 项** = registry 126 − `NON_PLACEABLE_ITEMS`（4 项功能性方块）−
  `HIDDEN_FROM_INVENTORY`（4 项可放置但不进背包）。**两个集合语义互斥，勿混为一处**
  —— 把可放置方块塞进 `NON_PLACEABLE_ITEMS` 会让集合语义失真。
- **床渲染镂空问题未修**（床侧面一个面无贴面 → 透视穿帮）。当前靠「不入背包 → 玩家选不到 →
  实际不会被放置」**规避而非修复**；TODO 标注在 `src/mesh/mesher.js`，归属床/宝箱/门多方块 Epic。
- **背包图标是离线烘焙产物**（`assets/icons-atlas.png`）。改**背包内方块**的贴图地址或 mesher
  几何后须重跑 `npm run icons`，否则图标静默过期（渲染旧形状/旧配色，肉眼看不出）；忘跑会被
  `npm run check:data` 的指纹检查抓到。改**非背包方块**的贴图无需重跑。
- **形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（`TEMPLATES` / `FACE_VERTICES` / `FACE_UVS`）。
  图标烘焙与等轴测投影只 import，**禁止手写第二份几何定义**（红线 1）。按方块单独 hack 图标
  做不到 —— 那会在 `TEMPLATES` 之外开第二份形状权威。
- **方块放置朝向不看玩家 yaw**：三分支为门控关闭→恒 0 / 原位重建同类型→`+1 % 4` / 有类型记忆→沿用 /
  无记忆→0。真实手感是「转身不改朝向，要转 90° 就在原位挖掉再放回去」。
  **M4 Task 6 改走 `editor.setBlock(...)` 时须保留朝向分支**（不得退化为只传 id）。
- **等轴测图标的深度度量 = `x+y+z`**（由投影轴叉乘得法线 `(-1,-1,-1)` 推出），且遮挡判定必须
  **逐像素深度测试** —— 面平均深度只能用于排序，对被整片遮住的面无能为力。
- **丢弃玩家改动的唯一入口 = `Game._discardEdits()`**（取消在途 flush + 清各 column **内存**
  edits + 清 IndexedDB store 与 `editsCache`）。消费者 `newWorld`（换 seed）/ `clearSave`
  （保留 seed 与设置，设置面板「删除缓存」）。**禁止只清 IndexedDB 不清内存** —— 内存 edits
  是写盘源，残留会在任何来得及提交的时机把旧改动写回刚清空的 store。
- **时序不定的竞态只能用内存侧断言钉住，端到端断言会让缺陷静默逃逸**。实测：`beforeunload →
  flushNow` 的 IndexedDB 事务能否提交取决于卸载快慢（多一次 evaluate 往返则提交；紧跟
  `location.reload()` 则被中止），故重载后的 `savedColumns` **碰巧**可能读到正确值
  （负向验证实测：注释掉清内存那步，E2E 仍全绿）。写竞态防护的测试时，断言要落在
  **同步可观测的内存状态**上，不要只断言重载后的落库结果。
- **面板 UI 档位与钳制范围是两套口径，勿混为一处**：`VIEW_DISTANCE_OPTIONS`（面板按钮档位，
  当前 `[8,12,16]`）只是**快捷选择子集**，`clampVD` 的钳制范围 **2~16** 才是架构口径
  （M1 测试/调试依赖 `vd=2`、既有 spec 用 `vd=4`）。故面板必须容错「当前值不在档位内」
  （URL/旧存档带来 `vd=4` → 无按钮高亮）；**刻意不做「就近高亮」** —— 那会让按钮宣称一个
  非生效值。契约断言在 `src/tests/test-ui.js`（档位须落在钳制范围内 + 默认值在档位中）。
- **设置面板新配置往右列填**：面板是两列盒（`.mc-columns` + `.mc-combined` 合并盒，mc-lite 同款
  手法但分配按本仓库档位重排）。左列 = 画质+枪械破坏合并盒 / 环境风格；右列 = 视距 / 帧预算 /
  世界操作。M5~M7 的新配置项优先往右列填（纵向余量更大），两组两按钮档位优先用合并盒共用一行。
  **音量档当前不在面板**（默认 100%），但字段仍持久化 + `?volume=` URL 可达 —— 音频接线时
  加回档位即可，不必改数据模型。
- **破坏性按钮的常态文案只有一份**（`settings-panel.js` 的 `CLEAR_SAVE_LABEL`）：构造与
  `_resetDangerArmed()` 复位共用同一常量。实测踩坑：复位函数写死旧长文案会覆盖构造时的短文案
  → 面板打开后显示复位那份，构造代码形同虚设（肉眼看不出哪个是「真相」）。
- **面板列分隔线规则只作用于 `.mc-item`，不得通配所有子项**：写 `.mc-column > :first-child`
  会连带抹掉 `.mc-combined` 合并盒自己的装饰边框（特异性 1,2,0 压过 1,1,0 → 上边框 `none`，
  方框缺一边；用户实玩报告，观感上只是「少一条线」，肉眼看不出是特异性冲突）。往面板加新
  容器类型时须同步考虑这条选择器。**CSS 特异性 bug 须 `getComputedStyle` 读四边定位**
  （只有某一边缺 = 特异性覆盖的特征），不要凭观感猜。
- **`settings-panel.js` 的 `PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**
  （会提前终止模板字符串 → 整个模块解析失败 → **游戏页白屏加载不出来**，不是面板样式错，
  是整个页面挂；实测一度误判为「服务端口有问题」）。改完 `src/**/*.js` 先跑 `npm run lint`
  （能抓解析错误）再做实测。
- **文档同步**：新增产物或删除文件时，必须同步「目录结构清单」「开发命令清单」「现状声明」
  三类文档，历史记录段不动。文档里同一事实的多个副本会漂移（已发生三次版本号漂移）。
- **计时类断言 flaky 时须分开按 spec 连跑拿数值分布比均值与峰值**，仅凭「全量跑失败/单独跑通过」
  判定不够（实测有 HEAD 侧失败率反而更高的情况，只看全量跑会得出相反结论）。
  **并发跑测试会导致计时断言系统性失败**（争抢 CPU 与端口 8081）。
  更可靠的做法是**交替对照**（改动侧 N 次 → HEAD 侧 N 次 → 反复），消除机器负载累积带来的
  顺序效应 —— 单侧连跑会让后跑的一侧承担更高负载。
- **测试指纹口径须匹配改动范围**：`i += 997` 步长采样只适合「换 seed」类整片变化；
  **单格改动必须全量求和**（实测踩坑：基线与改动侧同为 50533，断言恒真）。
- **重载类断言的导航监听必须在触发动作之前武装**：`waitForLoadState('load')` 写在 click 之后
  会看到「当前页已是 load 态」立即返回，随后 `READY` 在**旧页**本就为真 → 读到动作前的世界。
  正确写法是 `const nav = page.waitForNavigation(...)` 先建 promise，再 click，再 `await nav`。
- **给「生成类」代码写测试有两个恒真陷阱**（实测踩坑 lilypad，两处都会让缺陷静默逃逸）：
  ① **落点只按数据条件筛** —— 「biome=SWAMP + h<SEA_Y + rand<0.08」筛出 **12 个候选点**，
  完整 GEN 后**落地 0 个**（`pointContext` 的 city/island/pyramid/plainLand/snow/fm 六个地标
  判定都在 water 分支**之前**，这些点全被 clay/sand 地标方块吞掉）→ 断言根本不触发的分支；
  ② **测试里硬编码「被测代码写入的那个值」** —— 用 `SEA_Y+1` 算叶面高度，而 `SEA_Y+1` 正是
  `apply.js` 写入的格位 → 回退格位后该测试**仍 PASS**（拿硬编码值算出关系式成立）。
  正确做法：落点先用廉价脚本复现优先级链扫出、再跑完整 GEN 验证方块真落地；派生量从**实际
  生成数据里读出**真实格位再算，并补前置断言钉住前提。详见
  [`docs/testing-policy.md`](docs/testing-policy.md) §2.5。

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
- **`findSpawnY`（`gen/terrain.js:98`）会把空中结构当出生点**：它从世界顶向下扫第一个非空气
  方块并返回 `y+1`，而 M2-7 云层 `supportsPlayer=1` 但 `solid=0` → 随机 seed 下玩家可能出生
  在云面上（实测 6 次试验 1 次 y=56、`belowSolid=false`）。后果：**云面上不会自然刷怪**
  （丧尸 spawn 要求脚下 solid），且测试落点扫描须**向下扫真实地面**而非用玩家 y±4。
  本次未改该函数（属 M1/M2 出生点口径，改动会牵动 M1 验收与既有 spec）。
- **负向验证的盲区高发区**（M6 实测发现 15 条无效盲区，详见验收报告 §3）：① 门控落点落在
  未加载 column → 别道门控先拒绝，被测门控不被触发；② 断言读内存值而注入改的是实例矩阵；
  ③ fixture 显式传参覆盖了被测的默认参数 → 默认值路径无覆盖；④ fake 依赖立即完成 → 「在途」
  类断言不触发；⑤ 测试用 dt 恰等于步长 → accumulator 恒 0；⑥ worker 代码只在真游戏页加载，
  单测页跑不到 worker 注入；⑦ **测试输入从被测常量派生**（`micro = EPSILON / 2` → 注入把常量
  改成 0 时输入也变 0 → 断言恒真；须用字面量 + 前提断言）。
  **每条负向验证若「注入后仍全绿」，先怀疑断言落点而非实现**。
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
  `predictNextPosition` **不乘 dt**（`nextX = position.x + velocityX`，`Zombie.js:302-305`）→
  它的 velocity 是**格/帧**；mc-heavy 物理层乘 dt（`moveAxis(state, world, velocity[0]*dt, …)`）→
  **格/秒**。`ZOMBIE.speed` 已换算（`0.02 × 60 = 1.2`），照搬其它速度类常量时同理。
  **实测后果**：丧尸排斥强度照搬 mc-lite 的 `0.05` 后，排斥力只有追逐力的 4% → 压不住收敛
  （24 只最小间距仍降到 0.003、21 对重叠，与无排斥对照组几乎相同）；换算成 `3.0` 后降到
  0.439 / 1 对。**这类缺陷肉眼难辨**（丧尸照常在动，只是慢慢挤到一起），须靠 A/B 对照实测。
- **mc-lite 的「随机偏移」机制不能只移植一半**：mc-lite 丧尸靠 S 路线随机偏移角
  （`EnemyWorker.js:186-207` `targetOffsetAngle`，2% 概率每帧）让丧尸不会精确同点，故它的
  排斥力可以「完全重叠时跳过」（`distance > 0.001`）。mc-heavy 的 AI 是纯直线追逐、没移植
  S 路线 → 照搬那个跳过判定会**永久死锁**（两只同位置丧尸追逐速度完全相同 → 永远同步移动、
  永不分开；实测 20 只强制同点生成后 3 秒仍 min=0）。**移植时须检查上游的「靠其它机制兜住」
  的隐含前提**，不能只搬那一个函数。本仓库的补法 = id 派生确定性方向 tie-break（黄金角散列
  + id 序定符号 → 同位置两只必然朝相反方向；用 id 派生而非 `Math.random()`：可测 + 无帧间抖动）。
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
  `-1`、顶面 `+1`）→ 给多个面写「世界坐标 ← 归一化 u/v」换算时**不能用同一套公式**，会在某些面
  把 v 反向、偏一格（实测踩坑：丧尸头部 Tier 4 的顶面/侧面取样点落在格 4 而眼睛在格 3 → 注入
  「眼睛画进左半」仍全绿，无效负向验证）。跨面取样须用**纹理坐标**作统一参数，各面按轴向换算。
- **Tier 4 像素实测的断言阈值须匹配 `outputColorSpace`**：fixture 若用 `LinearSRGBColorSpace` 输出
  （ao-corner fixture 口径），读到的是纹理 sRGB→linear **解码后**的值（实测 `[64,107,48]` →
  `[13,37,8]`，三个值精确等于解码结果）→ 阈值得按 linear 写、不直觉且易错。丧尸头部 fixture 改用
  `SRGBColorSpace`（真实游戏口径）→ 读到的值接近原始纹理参数，阈值可对着图案参数读。
- **离线烘焙产物的过期门禁 = 输入指纹比对**（与图标同一手法）：图案参数/贴图内容进指纹，烘焙时写进
  伴随 JSON，门禁用当前参数重算比对 → 不匹配即报「跑 npm run xxx」。漏了会让产物**静默过期**
  （渲染旧图案，肉眼只觉得「颜色怪怪的」）。指纹逻辑放共享模块供烘焙脚本与门禁共用（红线 1：
  两处漂移会误判）。已知盲区：改**算法**而不动参数时指纹不变 → 这类改动须靠 Tier 4 兜住。

## 权威文档（动手前必读）

按顺序读完再写代码：

1. [`docs/roadmap.md`](docs/roadmap.md) —— **项目进度唯一总览**（里程碑总表 M0~M7 + 第二阶段
   依赖链 + 后续扩展点接入点 + 去哪找细节）。想知道「做到哪了、下一步做什么」先看它。
2. [`docs/phase-1-engine-design.md`](docs/phase-1-engine-design.md) —— **架构唯一权威**，
   当前 v1.35。所有子系统边界、DR 决策、验收口径都在这里；历次口径变更见其修订说明。
3. [`docs/testing-policy.md`](docs/testing-policy.md) —— **测试分级的唯一权威**（Tier 1~4 判据 +
   门禁分层 + 红线静态门规则 + 与 M4~M7 的关系）。动手前先按它的判据确定本次改动属哪一级。
4. [`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`](docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md)
   —— **任务级执行清单 + v1.19~v1.31 历次改造记录**（含各次 bugfix 的根因与实测数据）。
5. `docs/superpowers/plans/2026-08-19-m1-voxel-core-loop.md` —— M1 实施计划（已完成，架构细节参照）。
6. `docs/m0-bench-report.md` / `docs/m1-acceptance-report.md` / `docs/m2-m3-performance-report.md`
   （M3-6 第一阶段性能报告 = 冻结基线）—— 实测与验收报告。
7. M4~M7 开始前分别加读 `docs/superpowers/specs/2026-08-23-m{4,5,6,7}-*.md` 与
   `docs/superpowers/plans/2026-08-23-m{4,5,6,7}-*.md`（规格与计划已成对备好）。

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
- `src/world/structures/*.json` → `assets/structures/`（原样复用；**唯一例外**是 `big_house.json`
  删了 3 个草地 lilypad，理由见设计文档 §4.3 lilypad 段）；
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
│  ├─ phase-1-engine-design.md # 架构唯一权威（v1.35）
│  └─ testing-policy.md        # 测试分级唯一权威（Tier 1~4 判据 + 门禁分层）
├─ tools/build-atlas.mjs       # atlas 离线打包（npm run atlas）
├─ tools/bake-procedural-textures.mjs # 程序化贴图烘焙（mc-lite canvas 材质 → PNG）
├─ tools/bake-icon-atlas.mjs   # 全量背包图标离线烘焙（npm run icons）：118 项×两套尺寸
│                              #   → assets/icons-atlas.png + icons.json（预生成 CSS 串+指纹）
├─ tools/icon-fingerprint.mjs  # 图标输入指纹共享模块：烘焙脚本与 check:data 同一份逻辑（红线 1）
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
│  ├─ zombie/                  # 丧尸头部纹理（**不在 textures/ 下** —— 那里会进世界 atlas）
│  │  └─ head.png + head.json  # 128×64 双区并排（左半无眼睛/右半有眼睛）+ 尺寸与输入指纹
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
   │               #  weather.js（天气状态机）/ rain.js（雨效）/ entity-render-layer.js（M5 受控实体发布层）
   │               #  zombie-renderer.js（M6 六部件固定容量 InstancedMesh；无活跃丧尸时 visible=false；
   │               #    head 走单纹理 UV 分区 —— 正面顶点 16-19 采纹理右半「有眼睛」，见 applyHeadUV）
   │               #  zombie-head-texture.js（头部纹理加载，主线程专用；npm run zombie 烘焙产物）
   ├─ entities/    # entity-manager.js（动态实体唯一权威 + generation + AABB raycast）
   │               #  entity-types.js（probe 定义 + AABB slab 射线；Worker 同构，无 three）
   │               #  zombies/（M6，Worker 同构无 three）：zombie-config.js（冻结玩法数据唯一权威）
   │               #   + zombie-system.js（ZombieService 玩法入口 + zombieDefinition 含 60Hz 物理）
   ├─ player/      # player.js / physics.js / raycast.js / step-lift.js
   │               #  inventory.js（物品模型）/ orientation.js（朝向三分支纯函数）/ weapons/*（M4）
   ├─ ui/          # coords-hud.js / hotbar.js / settings-panel.js / settings.js
   │               #  inventory.js（背包面板：DOM 方案照搬 mc-lite）/ icons.js（图标 manifest 加载）
   ├─ save/        # persistence.js（IndexedDB edits + M5 entities store）
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

第二阶段 M4~M7 的规格与计划已成对备好（见「权威文档」清单末条的 `m{4,5,6,7}` 规格/计划）；
后续扩展点的引擎接入点（TNT/爆炸、炮塔弹丸、矿车轨道、创造台、灯/光源、床/宝箱/门、音频、
存档迁移、玩家生存战斗）见 [`docs/roadmap.md`](docs/roadmap.md) 的「后续扩展点」表格。
**新功能必须通过上述接入点实现，不得绕过 meshing/数据/事件管线另开路径。**

## 沟通与提交纪律

- 全部使用中文；解释设计取舍时引用设计文档章节号；
- 改动前说清楚「为什么」，改动后附验证证据（命令输出、帧时、draw call 数），不凭感觉宣称通过；
- 提交必须等用户明确指令，提交信息用 Conventional Commits。
- 诊断 bug 不猜：先在真实游戏/隔离环境复现、读实际数据（light 值/扫描线/队列状态）定位根因，
  再动手修。光照类 bug 尤其如此（垂直/扩散/快慢路径多，凭印象改会引入回归）。
- **写对照脚本做诊断时，对照侧与被测代码必须只差那一个要考察的变量** —— 两侧共用同一个错误假设
  会让对照恒等（得出「两者一致」的假结论），像素集合/统计口径不一致会得出机制上不可能的数值。
  出现机制上不可能的数值时先怀疑脚本本身。
