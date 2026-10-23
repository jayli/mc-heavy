# mc-heavy 总路线图

> 本文档是**项目进度的唯一总览**。它只回答三个问题：做到哪了、下一步做什么、去哪找细节。
> **不重复内容** —— 架构决策见设计文档，历次改动记录见其修订说明，任务级执行清单见
> `docs/superpowers/plans/`。

最后更新：2026-10-23

## 一句话现状

第一阶段引擎底座（M0~M3）**全部完成并验收达标**，两个收尾补丁项（M3.1 背包 / M3.2 方块朝向）
也已落地。此后是一串独立 bugfix 与改造（v1.19~v1.63，v1.37/v1.38 补齐了 M2 遗留的
**结构撒布**——草地/城市里的房子·花坛·亭子·高井此前完全看不到；**v1.42** 回补了
M2-7 有意删除的**空岛天空树**并修正 `sky_leaves` 的渲染通道声明；**v1.44** 落地了
**太阳阴影 shadow map**（设计文档 §4.4.4 从规划期估算变实测口径），**v1.45** 修复了
实玩报告的「阴影黑乎乎一片」（混合模型对齐 mc-lite + 逐方块投射排除），**v1.46** 修复了
「远端闪烁」（three r185.1 BatchedMesh 与阴影 pass 共用 multi-draw 列表的上游缺陷），
**v1.47** 修复了「随移动微微晃动」（纹素对齐 + 太阳方向角度门控），最新一条
**v1.48** 补上了**第一人称手臂与跑动视角晃动**（徒手默认可见手臂 / 跑动相机周期晃动 /
挖·放时手臂挥动 —— mc-lite 有而本仓此前完全缺失），**v1.49** 按实玩反馈
**上调晃动幅度并补上相机 roll/pitch**、并把手臂挥动从 mc-lite 的对称单曲线
**改为原版 Minecraft 的双曲线多轴**（快出主劈 + 滞后甩腕），**v1.50** 再把
**晃动幅度回调**（0.09→0.07，旋转同步降）并把**挖掘挥手改为「试图即挥手」**（挖空气/挖基岩也挥），
**v1.51** 按实玩反馈**去掉镜头晃动的全部旋转**（只保留位置平移 —— 跑动时地平线永不歪），
**v1.52** 把晃动**改为距离驱动、频率对齐原版疾跑步频 1.684Hz**（每步 297ms）并按原版口径
调整振幅（x=sin·bob·0.5、y 只向下），**v1.53** 再按实玩反馈把**幅度上调到 0.13**（实测 y 峰 +31%），
**v1.54** 把**步频放慢到 1.5Hz**，**v1.55** 再降一档到 **1.35Hz**（每步 370ms —— 只比原版走路的 1.295Hz 快 4%，已接近「在跑」的下界），
**v1.57**：按实玩反馈修掉「手臂颜色过于暗」（v1.56 的三层系数直接相乘把肤色压到 0.20~0.48 →
改为「参考色锚定」：面间差重映射到 `shadeLow..shadeHigh` 屏幕空间带 + sRGB→线性转换）
并把晃动幅度 0.13 → 0.15。**v1.56** 给手臂加了**烘焙面明暗**（顶点色三层相乘，消除「一个颜色、没立体感」）。
**v1.58** 给体素材质接了太阳 N·L 方向光 + mc-lite 天空盒。**v1.59**：天空盒落地后
「远景方块被染成固定 `0x87ceeb`」与照片天空对不上（像一排蓝板子贴在天空前）→ 面板右列新增
**「雾色」开关**（默认关），开启后雾色**按方位角采样天空盒**，远景融进它背后那片天。
**v1.60**：按实玩反馈重做**夜空天空盒** —— mc-lite `skyBox1` 六面各自独立生成，
12 条共享边平均 RMS 落差 **41.09**（白天只有 1.90）→ 天空被笔直暗线切成方块感。
改为**方向空间加权重采样**重新烘焙（接缝 **1.89**，与白天同量级；配色与细节均保住原图观感）。
最新一条 **v1.61**：实玩反馈「从白天切换成黑夜模式后，远方的雾色和天空盒的颜色渐变嵌入就没有了」
—— 根因是 mc-lite 的 night 风格 **`fogScale = 4.0`** 把雾距拉到 **608 格**（白天 152 格），
而世界径向只加载约 160 格 → **视野内没有任何方块到达雾区** → 雾色开关在夜里**无物可染**
（实测切换的像素变化 **0.0%**，白天是 4.1%）。改为统一雾距（`fogScale = 1.0`）。
最新一条 **v1.62**：实玩反馈「奔跑时连续射击会出现射向远方的很多条火线的残影」
—— 曳光世界空间冻结 + 不随相机移动而缩短 → 寿命期内每发都在身后攒一条火线。寿命缩到 1/4
（手枪 0.025 / MAG7 0.0375 / 加特林 0.02 秒），颜色与粗细不动。最新一条 **v1.63**：按 mc-lite 加上
**背景音乐**（单曲 `bgm.mp3` 254 秒循环，音量 0.15 = 上游原值），面板新增「背景音乐」开关（默认开），
`?bgm=0|1` 可覆盖 —— 起播需「玩家意图 + 已解码 + 手势已解锁」三个条件对齐。第二阶段 **M4 玩家武器已完成并验收**
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

**矿车 Epic 已完成**（2026-09-30，乘坐碰撞修复 2026-10-01）：`mine_cart` 从「背包里一个什么都不做的平面图标」做成
完整可玩实体 —— M5 持久实体（`minecartDefinition`）+ `MinecartService`（放置 / 拾取 /
激活 / 连挂列车）/ 移动·转弯·碰撞·连挂同构纯函数 / 2 个 InstancedMesh 渲染（车斗 + 4 轮）/
玩家 ctrl 激活 · 左键拾取 · 站上乘坐 · 空格下车 / TNT 爆炸摧毁。行为语义对齐 mc-lite，
架构走 M5 实体运行时（不复活 mc-lite 的 ShadowStore/Dispatcher 补丁架构）。
2026-10-01 补「玩家走进车自动站上」（`_collides` 矿车格实心，issue #3 审核后补全偏离登记），
验收报告 `docs/minecart-acceptance-report.md`。

**太阳阴影（shadow map）已落地**（2026-10-13，独立改动 v1.44；**2026-10-14 v1.45 修复了实玩报告的
「阴影黑乎乎一片」；2026-10-16 v1.46 修复了「远端闪烁」；2026-10-17 v1.47 修复了「随移动微微晃动」**）：太阳把地形/树/建筑的影子投到地面与方块表面 —— 设计文档 §4.4.4 规划了但从未
实现的项。闸门实测发现 **three.js r185.1 WebGPU 后端的 depth-compare 阴影路径是坏的**（最小独立场景
同样复现）→ 用户拍板改用 `VSMShadowMap`（唯一实测可用档位，有意偏离 mc-lite 的 PCFSoft）。
⚠️ **v1.44 的阴影混合模型是错的**（把阴影因子乘在最终颜色上 → 影区归零），v1.45 改为对齐 mc-lite
的「阴影只衰减方向光/skylight 项 + 环境光地板」，并补上逐方块投射排除（cloud 等 13 项）。
⚠️ **v1.46 修复「远端闪烁」**：three r185.1 的 BatchedMesh 主 pass 与阴影 pass 共用一份 multi-draw
列表，阴影 pass 覆写后主 pass 读到被阴影视锥剔除过的列表 → 远端几何每次刷新一帧消失（透出天空）；
mc-lite 用 InstancedMesh 无此问题。修法 = `render-world.js _installShadowListGuard`（快照/恢复）。
⚠️ **v1.47 修复「随移动微微晃动」**：根因是纹素量化（相机 ±30 / 贴图 256² → 每纹素 0.234 格，
相机连续跟随玩家时世界点相对纹素网格错位分数纹素 → 影子边缘抖动）；修法 = 纹素对齐
（`texelSnapOffset` 把相机中心吸附到纹素边界，偏移同时加到 position 与 target 以保方向不变）。
另顺带修了日夜循环下每帧无谓的光源重定位（太阳方向角度门控 0.5° → 约 0.6Hz）。
⚠️ **200ms 刷新节流不改**：实测单次刷新成本与频率无关，降频不省性能只增加阴影滞后。
规格 `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md`（⚠️ 其 DR-2 / DR-4 的 radius 条目
已被 v1.45 作废），详见下方独立改动表 v1.44 / v1.45 / v1.46 / v1.47 行。

**v1.48 第一人称手臂与跑动视角晃动**：mc-lite 有、本仓此前完全缺失的三件观感 ——
徒手默认可见手臂、跑动时相机周期性轻微晃动、挖块/放置成功时手臂挥动。手臂与持枪视图模型
互斥、晃动只作用于相机、常开不进设置面板。两条易踩的坑已沉淀为 CLAUDE.md 活跃约束
（**晃动必须按物理步推进**、**偏移须融进全量 `camera.position.set` 而非 `+=`**），
详见设计文档 §4.5.6 与下方独立改动表 v1.48 行。

**v1.49 晃动幅度与手臂挥动**（2026-10-17 实玩反馈）：幅度 0.05 → 0.09 并补上相机 roll/pitch；
挥动改为原版双曲线（`sin(√p·π)` 快出主劈 + `sin(p²·π)` 滞后甩腕）多轴 + 位移。
详见独立改动表 v1.49 行。

**v1.50 晃动回调与挖掘挥手时机**：幅度 0.09 → 0.07（roll/pitch 同步降 —— 剧烈的根源是旋转）；
`swing()` 提到 `digBlock()` 顶部，只要试图挖掘就挥手（对齐 mc-lite 的无条件 `this.swing()`）。
详见独立改动表 v1.50 行。

**v1.51 相机零旋转**：`rollAmount`/`pitchAmount` 置 0（字段保留，置 0 = 关闭），
跑动时地平线恒水平；左右平移保留。详见独立改动表 v1.51 行。

**v1.52 晃动距离驱动**：相位改由「走过的距离」累积（原版 `walkDist` 口径），
频率 `phasePerBlock = 1.3223 rad/格` → **1.6836Hz / 每步 297ms**（对齐原版疾跑，不是照抄步幅）；
振幅按原版 `x=sin·bob·0.5`、`y=−|cos|·bob`（只向下）。详见独立改动表 v1.52 行。

**v1.53 晃动幅度上调**：`intensity` 0.1 → **0.13**（实测 y 峰 −0.1177、x ±0.0580）；
关键教训：**标称值 ≠ 实际幅度**（一阶平滑在 1.68Hz 处通过率 0.8976）。详见独立改动表 v1.53 行。

**v1.54 步频放慢**：`phasePerBlock` 1.3223 → **1.1781 rad/格**（1.5Hz / 每步 333ms）；
改频率会连带改变实际幅度（平滑通过率 0.8976 → 0.9161，y 峰 0.1177 → 0.1199）。详见独立改动表 v1.54 行。

**v1.55 步频再降一档**：`phasePerBlock` 1.1781 → **1.0603 rad/格**（1.35Hz / 每步 370ms，
只比原版走路 1.295Hz 快 4% —— 已接近「在跑」的下界）。详见独立改动表 v1.55 行。

**v1.56 手臂立体感**：顶点色烘焙三层明暗（vanilla 面系数 × 固定光向 Lambert × 沿长度渐变），
保持 unlit。像素实测：亮度档位 2 → **11**、最大单色占比 78.9% → **46.8%**。详见独立改动表 v1.56 行。

**v1.57 手臂配色 + 晃动幅度**：`color` 口径改为「屏幕上的参考色」（面间差重映射到
`shadeLow..shadeHigh`，再 `srgbToLinear`），像素均值 RGB(163,146,134) → **(235,188,154)**
（参考色 238,187,153）；`BOB.intensity` 0.13 → **0.15**（实际 y 峰 0.1203 → 0.1375）。
详见独立改动表 v1.57 行。

**v1.58 太阳 N·L 方向光 + mc-lite 天空盒**：修「光影平淡」的**根因**（unlit 管线下方块六面亮度
完全相同，三种风格只是全局乘数）—— 顶点阶段解码 packed bit10-12 的面法线做 N·L，
`SUN_INTENSITY` 从 `VISUAL_STYLES.noon.sunDirection` **派生**（保证正午顶面亮度恒为 1.0，实测像素
138.9 → 138.9 逐位不变），迎光面/背光面像素比 **1.008 → 1.313**；阴影改为**只乘太阳项**
（`sun-shadow` 冻结比值 ratioA 仍 **0.735** 逐位未变）。天空盒 = 白天云图 + 夜空星空双立方图
**交叉淡入**（混合因子从既有 `skyDim` 派生，正午 0 / 黄昏 0.274 / 夜 1），日轮/月轮一并搬入。
详见独立改动表 v1.58 行。

**v1.59 雾色融入天空**：天空盒落地后，「远景方块染成固定 `0x87ceeb`」与照片天空对不上 →
远看像「一排蓝板子贴在天空前」（实测固定雾色 sRGB [134,205,234] vs 天空盒雾带实际色
[188,202,229]，**R 差 54**）。修法 = 雾的 `color` 换成**按方位角采样天空盒**的节点
（`fog(color, factor)` 的 color 本就是任意节点 → **不新增渲染通道**，bench 四场景 draw call 逐位相同）；
俯角一律归到地平线带（否则俯视会采样到天底那半张 → 雾色**反向变暗**，实测 ΔR −3.3）。
面板**左列环境风格下方**新增「雾色」开关，**默认关**（关闭逐位回到 v1.58）。实测平视 ΔR +5.0 / 俯视 +9.2，
天空与近景逐位不变。详见独立改动表 v1.59 行。

**v1.68 巨树景观**（用户裁决：opaque 通道容量 ×1.5 / 巨树叶投影 / `.schem` 入库 / 已有存档接受）：素材包 `40AssortedTreesPack.schem`
入库并离线烘焙成 28 个原版景观树变体（1/2 比例，16,954 格），按森林 / 海边 / 草地沙漠交界三条路径落位，城市·地标·撒布结构·JSON
结构占地让路，与旧森林树互斥。region 层候选 = 全局对齐网格 + 内缩抖动（间距由构造保证，≈1.1 ms/region）。**opaque 通道容量
2.85M → 4.275M，§4.10 的 150MiB 冻结预算有意上调到 188.83 MiB**；真实页面 reserved 口径最高 82.1%（A 森林两次调稀到 spacing 32 后 76.4%；零 opaque 扩容），
cutout / transparent 相对 HEAD 不恶化；bench draw call 场景 ① +16 / ④ +41。浏览器内单测 779→810，Playwright 184→190。
规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md`（v1.1），验收报告 `docs/giant-trees-acceptance-report.md`。

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
| **矿车 Epic** | M5 持久实体（`minecartDefinition`）+ `MinecartService`（放置 / 拾取 / 激活 / 连挂）/ 移动·转弯·碰撞·连挂同构纯函数（统一 round 判据 + 帧前快照 + deferred 跨车写入）/ 2 个 InstancedMesh 渲染（车斗 canvas 纹理 + 4 轮）/ 玩家乘坐（分轴障碍检测）/ TNT 爆炸摧毁 / `Persistence.deleteEntity`（首个可单独销毁的持久实体）；2026-10-01 补乘坐碰撞（走进车自动站上） | ✅ 完成（2026-09-30，验收报告 `docs/minecart-acceptance-report.md`） | `3410713` Epic / `f59699d`+`2c0e23b`+`0d03c04` 乘坐碰撞修复 |

## M4 之后的遗留 TODO（M4 阶段 bugfix）

| 事项 | 状态 | 要点 |
|---|---|---|
| 设置面板添加「破坏方块」开关按钮（对齐 mc-lite 配置面板的「枪械破坏设置」，`UIManager.js:160` 开/关两按钮 → `canGunsDestroyBlocks` + HUD 提示） | ✅ 完成（`3fe8626`） | mc-heavy 当前只有 API 入口 `game.setGunBlockDamage(enabled)`（M4 规格 §4.4：「M3 HUD 若已实现设置面板，可直接绑定该 API」）。已落地：`src/ui/settings-panel.js` 照既有 `_makeRow`/按钮组模式加一行，点击调既有 API，不新增机制；默认 `false`（与 mc-lite 一致，破坏开关默认关闭） |

M4 交付后的实玩反馈修正（已落地，记录在验收报告偏离表）：相机入 scene（R 切武器可见）、
pointer-lock 拒绝捕获、曳光粗细对齐 mc-lite + 起点世界空间冻结（v1.33）、武器灯光（v1.34）、
MAG7 曳光终点回归准心轴（v1.36，原用扫描候选当终点导致斜射——移植偏差，非有意偏离）、
曳光寿命缩到 1/4（v1.62，奔跑时残影不再连成一排火线）。

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

## M3.2 之后的独立 bugfix / 改造（v1.19 ~ v1.68）

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
| v1.43 | 进度包导入导出（设置面板） | ✅ 本次 | 用户要求在设置面板增加「导入进度 / 导出进度」，放在「打开创造台」右侧、该行标题改「创造台和进度管理」。**布局经用户同日实玩反馈改过一次**：交付版是「创造台 + 进度」合一行（`[打开创造台(窄)][导入进度][导出进度]` / `[导出模型][导入模型]`），用户要求**拆开** —— 进度另起独立一行「进度管理」（在创造台行下方）、创造台行不再有第二行，模型两个按钮**挤进主按钮同一行**（未激活时「打开创造台」独占满行，激活后三按钮 `${flex:1}` 平分该行，关闭后模型消失、主按钮恢复满行），`.mc-narrow` 与 `mc-playground-models` 随之下线。理由：进度管整个世界存档、创造台管平台与模型，两者功能域不同。**口径（用户选定）= 完整存档**：本仓世界由 seed 确定性生成（红线 2）、存档只存 diff，故进度包 = `meta.seed` + `edits` store 全量 + `entities` store 全量。**不导逐格地形**（视距 8 的 289 列全量约上亿字符，而地形本就由 seed 重算）、**不导玩家位置**（消费它需要改出生点逻辑，与 `meta.spawn` 语义冲突）、**不导设置**（设备级，存 localStorage）。格式 `mc-heavy-progress` v1，**方块存名字而非数字 id**（id 是注册顺序的产物 → `blocks-data.js` 增删方块会让 id 存盘的包静默错位成别的方块）。新增 `save/progress-codec.js`（纯函数 `encodeProgress`/`decodeProgress`，无 DOM/three）+ `voxel/constants.js` 的 `decodeBlockIndex`（`blockIndex` 的逆，编码与其逆同处以防两处算术漂移）+ `Persistence.listEdits()`（cursor 全量遍历）+ `Game.exportProgress()`/`Game.importProgress()`。**两条静默失效类口径**：导出前必须 `flushNow`（内存 edits 才是真相，5s 防抖未到时导出的文件照样合法、只有导入后才发现少方块）、导入必须走 `_discardEdits()`（v1.29 的唯一丢弃入口，否则旧改动残留）。导入**覆盖式**（清空当前改动）且非原子（失败重试即可，不引入临时 store 交换）、**无二次确认**（用户批准时已知）。Tier 1 TDD：新增 `src/tests/test-progress.js`（17 条：坐标互逆全 y 抽样 / blockEntity 深比较往返 / 未知名字与越界与 key 不自洽分类 / 8 个包格式失败分支的 reason 与**零输出**）+ `src/tests/test-ui.js` 文案常量断言；E2E `tests/progress.spec.mjs` 5 条（导出下载内容含**刚放进内存**的方块 / 导入换 seed 且旧改动清零 / 4 个坏文件被拒且不重载 / busy 锁 / 面板布局：两行分离 + 模型按钮同行 + 主按钮满行↔均分切换的实测几何）。负向验证见实施记录。⚠️ 实测踩坑：`PANEL_CSS` 注释里写反引号会把模板字面量提前终止（`footer` 报 no-undef）——正是 CLAUDE.md 已记的那条，本次再中一次。**全量 E2E 136 用例 / 135 passed / 1 failed**（`m1-acceptance` 放挖压力），已按 `testing-policy §2.6 ①` 做**交替对照**：两侧各起独立 server + 独立 worktree（MOD/BASE 只差本次代码），用**同一个 spec** 交错各 3 轮 → **MOD 1/3 通过、BASE 1/3 通过**，失败均为已登记的两条 timer 贴线签名（`digP95` 2.0~2.1 vs 阈值 2；`frameMs.p95` 16.7000007 vs 16.7，即 `16.7±1e-6` 量化踩线）。另用**只差 100 次放挖的等价负载脚本**交错 3 轮：`frameP95` 两侧逐轮**完全相同**（25.7/25.6、25.4/25.4、25.1/25.1），fps 无可辨别差异 → **未改断言、未放宽阈值** |。**口径（用户选定）= 完整存档**：本仓世界由 seed 确定性生成（红线 2）、存档只存 diff，故进度包 = `meta.seed` + `edits` store 全量 + `entities` store 全量。**不导逐格地形**（视距 8 的 289 列全量约上亿字符，而地形本就由 seed 重算）、**不导玩家位置**（消费它需要改出生点逻辑，与 `meta.spawn` 语义冲突）、**不导设置**（设备级，存 localStorage）。格式 `mc-heavy-progress` v1，**方块存名字而非数字 id**（id 是注册顺序的产物 → `blocks-data.js` 增删方块会让 id 存盘的包静默错位成别的方块）。新增 `save/progress-codec.js`（纯函数 `encodeProgress`/`decodeProgress`，无 DOM/three）+ `voxel/constants.js` 的 `decodeBlockIndex`（`blockIndex` 的逆，编码与其逆同处以防两处算术漂移）+ `Persistence.listEdits()`（cursor 全量遍历）+ `Game.exportProgress()`/`Game.importProgress()`。**两条静默失效类口径**：导出前必须 `flushNow`（内存 edits 才是真相，5s 防抖未到时导出的文件照样合法、只有导入后才发现少方块）、导入必须走 `_discardEdits()`（v1.29 的唯一丢弃入口，否则旧改动残留）。导入**覆盖式**（清空当前改动）且非原子（失败重试即可，不引入临时 store 交换）、**无二次确认**（用户批准时已知）。Tier 1 TDD：新增 `src/tests/test-progress.js`（17 条：坐标互逆全 y 抽样 / blockEntity 深比较往返 / 未知名字与越界与 key 不自洽分类 / 8 个包格式失败分支的 reason 与**零输出**）+ `src/tests/test-ui.js` 文案常量断言；E2E `tests/progress.spec.mjs` 5 条（导出下载内容含**刚放进内存**的方块 / 导入换 seed 且旧改动清零 / 4 个坏文件被拒且不重载 / busy 锁 / 面板两行布局与实测几何：主按钮 <100px、进度按钮各 >100px、`scrollWidth<=clientWidth` 文案不换行）。负向验证见实施记录。⚠️ 实测踩坑：`PANEL_CSS` 注释里写反引号会把模板字面量提前终止（`footer` 报 no-undef）——正是 CLAUDE.md 已记的那条，本次再中一次。**全量 E2E 136 用例 / 135 passed / 1 failed**（`m1-acceptance` 放挖压力），已按 `testing-policy §2.6 ①` 做**交替对照**：两侧各起独立 server + 独立 worktree（MOD/BASE 只差本次代码），用**同一个 spec** 交错各 3 轮 → **MOD 1/3 通过、BASE 1/3 通过**，失败均为已登记的两条 timer 贴线签名（`digP95` 2.0~2.1 vs 阈值 2；`frameMs.p95` 16.7000007 vs 16.7，即 `16.7±1e-6` 量化踩线）。另用**只差 100 次放挖的等价负载脚本**交错 3 轮：`frameP95` 两侧逐轮**完全相同**（25.7/25.6、25.4/25.4、25.1/25.1），fps 无可辨别差异 → **未改断言、未放宽阈值** |
| v1.44 | 太阳阴影 shadow map 落地 | ✅ `ed70b98` 起（至 `d97c6b4`） | 设计文档 §4.4.4 从规划期估算落地实现（首次实现）。**闸门实测的最重要发现：three.js r185.1 WebGPU 后端的 depth-compare 阴影路径是坏的**（`GPUValidationError: ShadowDepthTexture usage (TextureBinding\|RenderAttachment) 冲突` → CommandBuffer 作废、画面全黑；**plain Mesh 零游戏代码的最小独立场景同样复现** → 与 BatchedMesh 无关）→ 用户拍板改用 `VSMShadowMap`（唯一实测出影档位，有意偏离 mc-lite 的 PCFSoft，spec DR-4b）。落地：复用枪 PBR 的 DirectionalLight 为太阳灯（不新建第二盏）/ 通道级投射（opaque+cutout cast、transparent 不 cast、三通道全 receive）/ unlit 材质手动乘 TSL `shadow()` 节点（浓度 `uShadowStrength` 随日夜 skyDim 淡出）/ per-light 按需刷新（三请求源 → ShadowScheduler 200ms 节流 → `tick() && castShadow` 消费端门控，**操作数顺序载荷性**）/ 光源跟随玩家（移动超 5 格重定位）/ 太阳方向随日夜连续插值（有意偏离 mc-lite 离散切换）/ 代码级开关（`?shadows=0` + 构造选项 + `setShadowsEnabled`，不进设置面板）。**实测验收**：Tier 4 影区/开阔区亮度比 **0.675**（阈值 0.85，余量 26%）、开阔区 1.000；稳态 drawCalls **53**（与无阴影 HEAD 逐位相同，按需刷新生效），重渲帧 +220（vd=2）/ +110（vd=8）—— VSM 下 receiveShadow 对象也进阴影 pass（`three.webgpu.js:44682`）；稳态帧时阴影开/关 p95 **9.30 vs 9.20**（差 0.1ms = 1.1%，同场景交替各 2 轮）；全量 E2E **145/146**（唯一 FAIL = `sky-structures` frameMs.p95 17.5 vs 16.75 = 既有 vsync 量子贴线 flaky，单独复跑 3/3 通过 16.6/16.7/16.7）；bench `--check` 阻断经**交替对照**（MOD/BASE 交错各 3 轮）判定为既有门禁噪声：两侧各阻断 2/3 轮、阻断值逐字相同（场景③ uploadMsP95 0.6→0.7，round 2/3 叠加 fastRemeshP95 1.1→1.3），场景③ fps MOD 中位 108.1 不低于 BASE 106.39，draw 四场景逐轮逐位相同 → **未改断言、未放宽阈值、未重写基线**；**负向验证 7/7 真 FAIL、零无效盲区**；浏览器内单测全绿（计数以 harness 输出为准）。**两处冻结断言冲突均按用户裁定 = 隔离变量**（断言与阈值逐字不动，改的是被测 setup）：① 阴影让 morning/noon 整屏平均亮度趋同（物理正确：低太阳角 → 长影 → 抵消 skyDim 亮度差，且阴影本身就会让该断言收敛，与 DR-6 无关）→ daynight-visual 量前关阴影；② VSM 重渲帧 drawCalls 尖峰 → 5 份量 drawCalls 的 spec 隔离阴影。⚠️ 发现并修复既有缺陷：「关阴影 = 零开销」原只有源侧两处门控在守（`editor.subscribe` 与消费端双双漏门控 → 关阴影后世界编辑仍每 200ms 重渲）→ 补消费端单点权威门控 + 源侧纵深防御。⚠️ Tier 4 判据两条踩坑：perf HUD 半透明黑底压暗屏幕左上象限（采样须隐藏全部 HUD）/ 不能直写 uniform 做像素判据（残留 shadow map 永久驻留 → 恒 FAIL，改同帧 A/B 比值 + 正向对照）。遗留：实体不投射不接收（本期范围外，接线点已预留）/ 树冠投影实心轮廓（阴影 pass 不消费 alphaTest，Minecraft 同款）/ VSM light-bleeding（用户已知悉接受）。规格 `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md`（DR-1~DR-8 + DR-4b + §9 六条偏离），任务级实测记录 `.superpowers/sdd/2026-10-13-sun-shadow-map/task-{3,5,6b1,6b2}-report.md` |
| v1.45 | 阴影「黑乎乎一片」修复：混合模型对齐 mc-lite + 逐方块投射排除 | ✅ 本次 | 用户实玩报告「阴影的部分都是黑乎乎的一片」，对照 mc-lite 定位到**两个独立缺陷**（都不是参数调得不好，是模型错）。**① 阴影因子被乘在最终颜色上 → 影区亮度归零（根因）**：v1.44 是 `rgb = texColor × vShade × shadowFactor`，而 `shadow()` 影区返回 0 → 整个 rgb 归零。mc-lite 的体素材质是受光的 `MeshStandardNodeMaterial`（`MaterialManager.js:268`），three 的阴影**只乘方向光贡献**，`AmbientLight(0xddeeff, 2.3)`（`Engine.js:194`）**不参与阴影** → 影区仍被环境光完整照亮；mc-heavy 是 unlit 管线，`vShade` 烘焙的 skylight 就是它唯一的「环境光」，这一乘把它也乘没了。修法：sky/block 两项分开传片元（`vSkyShade`/`vBlockShade`，拆分无损），片元只把阴影因子乘进 sky 项再取 max（**火把照亮的洞穴不被太阳阴影压暗**）+ 影区地板 `SHADOW_FLOOR=0.5`（由 mc-lite 影区亮度推导：ambient/(ambient+sun·NdotL)=2.3/(2.3+3.2×0.8)=0.4733 顶面~0.55 侧面，取 0.5）+ 两层 mix 嵌套顺序载荷性（单层写法会让关阴影把全世界压到 50%）。**② cloud 等 13 种方块被通道级粗粒度误投影**：v1.44 的 DR-2「cloud 在高空、投影可接受」与 mc-lite 实际口径不符（mc-lite `BlockData.isShadowEnabled:false` 实测解析 = 102 投影/20 不投影，cloud 在不投影清单里）；mc-heavy 的 cloud 在 opaque 通道（M2-7 挪过去的）→ 通道级 castShadow 让云全部投影，而 Y=35/55 云簇完全在阴影相机 far=250 视锥内 → 地面大面积移动云影黑斑。修法：`blocks-data.js` 新增 `shadowCast:false`（13 项）→ `registry.shadowCastTable` → mesher 写 **packed bit14** → `materials.js` 的 `maskShadowNode`（**不是** `castShadowNode` —— 后者要求 `shadowMap.transmitted===true`）在阴影 pass 逐片元 discard（只被阴影 pass 消费，主 pass 不受影响）。**③ radius 从 4 修回 mc-lite 原值 2.6**（4 是缺陷①时代的补偿值，修好后反而把阴影冲淡：实测谷底 0.852 vs r=2.6 的 0.726，半影宽度两者同为 4/8 点）。**④ transparent 通道改 cast+receive 双 false**（v1.44 是 receive=true）：VSM 下 receiveShadow 对象也进阴影 pass（`:44682`）→ 水/玻璃照样投影；且 `shadow()` 节点不受 receiveShadow 门控（只门控灯光管线，`:46101`）→ 水面照样被压暗；mc-lite 对 water/glass 也是双 false。**⑤ 测试口径缺陷**：v1.44 的 Tier 4 判据只有上界 `<0.85`，而**纯黑（0.675）也满足** → 结构上抓不到缺陷①；负向验证实测 `SHADOW_FLOOR=0` 时 ratioA=0.122 而旧断言仍全绿 → 补**下界 `>0.5`**（实测修好 0.735 / 破坏态 0.122）。**实测验收**：影区比值 0.675（v1.44 纯黑）→ **0.735**（与 mc-lite 理论影区亮度 0.71 几乎重合），开阔区恒 1.000，关阴影 A/B=0.992（零视觉影响）；cloud 柱逐点扫描比值**恒 1.000**（对照 stone 柱 0.726）；radius 扫描 r=1→0.724 / r=2→0.724 / r=2.6→0.726 / r=3→0.769 / r=4→0.852，0 个 GPU 错误；sun-shadow.spec **8/8** 全绿；浏览器内单测 **645/645**（含新增 6 条：shadowCastTable 双向一致 / 13 项排除清单 / 未知 id 防御 / mesher bit14 三向）。改动面：`blocks-data.js`（13 项声明）/ `block-registry.js`（shadowCastTable + castsShadow）/ `mesher.js`（bit14）/ `materials.js`（sky/block 拆分 + 地板 + maskShadowNode）/ `render-world.js`（transparent 双 false）/ `game.js`（radius 2.6）/ `sun-shadow.spec.mjs`（重标定 + 下界）/ 设计文档 v1.45（§4.4.4 重写 + 修订说明）。⚠️ 遗留：实体不投射不接收（同 v1.44）/ VSM light-bleeding（同 v1.44） |
| v1.46 | 阴影「远端闪烁」修复：BatchedMesh multi-draw 列表守卫 | ✅ `31e5425` | 用户实玩报告「远端闪烁」，排查后定位为 **three r185.1 上游缺陷 + 红线 5 选型的连带后果**：`BatchedMesh.onBeforeRender()` 把逐 instance 剔除结果写进实例字段（`_multiDrawStarts/_multiDrawCounts/_multiDrawCount/_indirectTexture`，`three.core.js:27504-27634`），而 `onBeforeShadow()` 直接转调 `onBeforeRender(null, 阴影相机)`（`:27636`）→ 一帧内主 pass 建好列表（实测 453）后，阴影 pass **覆写同一列表**（实测 142，只剩 ±30 阴影视锥内的 instance），主 `backend.draw`（`three.webgpu.js:85522` 读 `_multiDrawCount`）读到被覆写的列表 → 阴影视锥外的几何该帧不绘制 → 透出天空。只在 `needsRefresh` 帧发生 → 「每次刷新一帧亮闪」。**为什么 mc-lite 没有**：它地形走 `InstancedMesh`（`GlobalInstancedMeshManager.js:56` / `ChunkGenerator.js:177,228`，无逐 instance multi-draw 列表，`onBeforeShadow` 是 Object3D 空实现 `three.core.js:12151`）→ 阴影 pass 无从覆写主 pass 状态；本仓按红线 5 用 BatchedMesh 通道级合批才暴露该缺陷。修法 = `render-world.js _installShadowListGuard`：`onBeforeShadow` 入口快照主 pass 列表、`onAfterShadow` 出口恢复（+ 重置 `_indirectTexture.needsUpdate` 让 GPU 重传）。**实测**（探针 P17~P23，平台 + 强制 5Hz 刷新 + 逐帧读像素）：亮闪次数==刷新次数（9→9）且**只**在阴影视锥外采样点出现（视锥内 sd=0）；亮闪值恒 **192** == noon 天空亮度 (135+206+235)/3 → 证明几何确实消失而非变亮；修法后远端 sd=0/jumps=0，drawCalls 与基线**逐位相同**（vd=8 实测 630）。⚠️ **不能用 `perObjectFrustumCulled=false` 修**（更短的一行）：会同时关掉主 pass 逐 instance 剔除 → drawCalls vd2 48→183 / vd8 467→1785（实测 3.8×），撞破 render-terrain 冻结断言 `drawCalls<100`。回归门 = `sun-shadow.spec.mjs` 用例 9（负向验证：去守卫后 jumps=18/sd≈11/range≈54 真 FAIL，与阈值 ≤3/<2/<3 差一个数量级）。bench `--check` 阻断经**交替对照**（MOD/BASE 交错各 3 轮）判定为既有门禁噪声：两侧各阻断 2/3 轮、阻断值同口径（场景③ uploadMsP95 0.6→0.7 / fastRemeshP95 1.1→1.3，CLAUDE.md 已记录的 GC+0.1ms 精度 flaky 门禁），fps 中位 MOD 108.34 vs BASE 109.29（差 1% 噪声）→ 守卫性能中性，**未改断言、未放宽阈值、未重写基线**。改动面：`render-world.js`（守卫 + 接线）/ `sun-shadow.spec.mjs`（用例 9 回归门）/ CLAUDE.md 活跃约束。**不进设计文档修订说明**（实玩反馈修正，非架构口径变更；three 上游缺陷的发布层 workaround，不改任何 DR） |
| v1.47 | 阴影「随移动微微晃动」修复：纹素对齐 + 太阳方向角度门控 | ✅ 已完成 | 用户实玩报告「阴影随着玩家的移动会微微晃动，幅度不大但能察觉」，并质疑「200ms 刷新频率是否过高、对性能影响有点大」。**① 晃动根因 = 纹素量化（不是太阳方向在变）**：阴影相机 ±30 / 贴图 256² → 每纹素 ≈ 0.234 格；相机连续跟随玩家时世界点相对纹素网格错位分数纹素 → 影子边缘抖动最多半纹素 ≈ 0.1 格（太阳每帧只转 0.0025°，不是主因）。修法 = `shadow-manager.js` 新增纯函数 `texelSnapOffset(center, sunDir, texelSize)`，`game.js _updateSunPosition()` 把相机中心吸附到纹素边界（相机基由 sunDir 构造，与 three lookAt 同口径）。⚠️ **载荷性：偏移必须同时加到 position 与 target**（两者之差平行相机 Z 轴，加同一向量方向不变；只加一侧会改光照方向 → 枪 PBR 高光漂移）；texelSize 从配置读（红线 1）；退化保护（sunDir 平行 worldUp / texelSize≤0 → 返回零偏移不产 NaN）。**② 200ms 性能前提不成立，故不改 200ms**：探针实测（vd=8 逐帧分组）稳态帧中位 8.3ms（与关阴影 8.33ms 逐位相同）、刷新帧 9.0ms、刷新帧只占 4.2%（30/722）、摊平 ≈ 0.03ms/帧、fps 恒 120；且强制 100/200/400/800/1600ms 对照显示**单次刷新成本与频率无关**（8.74/8.74/8.82/9.04/9.12ms）→ 降频不让刷新变便宜，只增加阴影滞后。⚠️ 既有验收用聚合 p95（600 帧窗口）：5Hz 刷新帧只占 4.2% 刚好落在 p95 阈值**之下** → 抓不到尖峰（用聚合指标回答分组问题）。**③ 顺带修真实浪费 = 太阳方向角度门控**：`onSunDirection` 加 `sunDirectionChanged(lastDir, dir, SUN_DIR_GATE_DEG=0.5°)` → 光源重定位从每帧 120 次/秒降到约 0.6Hz（太阳 0.3°/秒），并消除重定位路径上的额外 `params` 读取（`get params()` 每次调用新分配 2 个小对象；门控比较用回调入参 `dir` 而非 `params`，零额外分配。⚠️ `DayNight._apply` 自身的每帧分配不在本门控范围内，属日夜循环固有成本，本次未动）。⚠️ 门控**只加在 onSunDirection 路径**，不加到移动阈值路径（玩家移动必须让相机跟上，加了会「走 5 格后影子钉在原地」）。**实测**：纹素对齐 Tier 4（固定世界点 + 分数纹素步长 0.05 格×12 步 + 每步强制刷新）ON 亮度恒 112.63（spread **0.00**）/相位恒 0.6，OFF 亮度 118.77↔123.79（spread **5.02**）/相位 spread 0.93，阈值 ≤1.0（差 5×）；方向门控 cycleSeconds=60 下 `_updateSunPosition()` 调用 **11 次/秒**（理论 12），阈值归零时 **120 次/秒**（每帧）。⚠️ 两条测试口径踩坑：① sanity floor 不能用「相位在变」（对齐生效时相位恒定正是不变式，拿它做下界会让修好的代码 FAIL），改用「target 世界位移 >0.2」；② 测方向门控须把 hour 设进插值段（启动 hour=12 落 noon 平台段方向恒定 → 门控永不放行，实测 cycleSeconds=60 仍 0/47 假阴性）。⚠️ Tier 4 逐帧读像素必须在 rAF 回调内（WebGPU swapchain 在 rAF 外 drawImage 读黑屏）。两项都是**有意偏离 mc-lite**（它无连续日夜循环、光源只在移动超 5 格时重定位、无纹素对齐）。改动面：`shadow-manager.js`（两纯函数 + 阈值常量）/ `game.js`（接线两处）/ `test-shadow-manager.js`（+11 单测）/ `sun-shadow.spec.mjs`（+2 用例、改跟随容差为配置推导）/ 设计文档 v1.47（§4.4.4 + 修订说明）/ CLAUDE.md 活跃约束。实测：浏览器内单测 656/656、sun-shadow.spec 11/11、负向验证两条真 FAIL（对齐 OFF spread 4.87 / 阈值 0 计数 120） |
| v1.48 | 第一人称手臂与跑动视角晃动 | ✅ 已完成 | 用户要求对标 mc-lite 补上三件第一人称观感：跑动时的视角晃动、默认可见的手臂、挖/放时的手臂挥动。四项产品口径经用户当面确认：① 手臂造型**逐字对齐 mc-lite**（单方块 0.4×1.2×0.4 + scale 0.1 + 肤色 0xeebb99），不另做两段式；② 晃动**只作用于相机**（手臂与持枪不叠加反相摆动）；③ 挥动只在**挖块成功与放置成功**时触发（枪击继续走既有后坐）；④ **不进设置面板**（常开，不新增配置项与持久化字段）。新增 `src/render/view-arm.js`（单个 Mesh 挂 camera 下，与 `view-weapon.js` 互斥显示；忠实照抄上游的造型/站位/静止角 −0.8/挥动公式 −0.8−sin(p·π)·0.87）与 `src/player/view-bob.js`（**纯函数无 three/无 DOM**，与 `step-lift.js` 同手法，供单测直接驱动；判据 = 移动 + 全速 + 不跳跃，`bobX=sin(t)·amount` / `bobY=cos(2t)·amount·0.5`，amount 指数渐入衰减）。**三条实现口径（改动前必读，已写入设计文档 §4.5.6）**：① **晃动按物理步推进，不按渲染帧** —— 物理是 60Hz 定步长 + accumulator，120Hz 渲染下隔帧才走一步，按帧推进时没走物理的帧位移为 0 → 判据判「没在动」→ 相位每帧归零 → **晃动永远起不来**；② **偏移融进那一次全量 `camera.position.set(...)`，不得写成 `+=`** —— 否则上一帧偏移被下一帧当基线继承 → 逐帧漂移；③ **手臂用 unlit 材质**（`MeshBasicMaterial`）不跟上游的 `MeshStandardMaterial` —— 本仓场景双灯只为枪的 PBR 模型而设，受光手臂会让肤色随日夜灯光漂移且比同屏方块亮一档（`minecart-renderer.js` 同手法）；挥动时长从上游的「每渲染帧减 1」改为 **dt 基定长 1/6 秒**（上游 120Hz 下挥动只有 60Hz 的一半时长，是帧率依赖缺陷）。**两处等价实现**（不改行为，不登记为偏离）：上游 `shouldBob` 的 `!isObstructed` 由「实际位移 > 意图位移×0.95」天然覆盖 → **不新增「是否卡住」状态**（新增一份会与 physics 的真实位移漂移，红线 1）。**实测**：浏览器内单测 **678 全绿**（含新增 22 条）；**18 条负向验证注入中 17 条真 FAIL**，唯一条仍绿的是「删 `inputSpeed>0` 守卫」——它与紧随的 `expected>0` 重叠被后者兜住，**组合删两条后同一用例真 FAIL**（已证非恒真断言）；E2E `tests/view-bob.spec.mjs` **6/6**（相机偏移 x 峰值 **0.0436** / y ±**0.0179**，均 ≤ intensity 0.05；静止恒 0；停下后收敛到 ~1e-8；相机偏移与 `viewBob.offset` 逐帧偏差 <1e-9；挖块后 swingProgress 1→0、谷底 −1.67、回位 −0.8；放置走背包选中路径同样触发；挖空与命中 bedrock **不挥**）；E2E 侧负向验证 7 条全部真 FAIL（含删 digBlock/放置的 swing、切枪不切显隐、默认不 setWeapon(arm)、相机不吃 bob.x/bob.y、bob 改累加）。⚠️ **首版「跑动晃动」用例只断言 `viewBob.offset`（内部量），注入「算对但不写进相机」后仍全绿** → 改为同时断言相机相对物理位置的偏移，重做负向验证后才真 FAIL（testing-policy §2.7）。**回归**：`npm run check` 通过（0 error）；render-terrain（drawCalls **54**，门禁 <100）、weapons-performance、interaction、m3-hud、sun-shadow 11/11、minecart-render、m3-2-orientation 全绿；`weapons-world-edit` 的「200 次射击计数」FAIL 属**已知 flaky** —— HEAD 侧（`git stash` 掉本次改动）同样 FAIL（199 vs 200），与本改动无关（CLAUDE.md 在列）。 |
| v1.49 | 晃动幅度上调 + 手臂挥动对齐原版 Minecraft | ✅ 已完成 | 用户实玩反馈（看过 v1.48 效果后）两条：① 「跑动晃动幅度稍小，小到看不出来在跑」；② 「手臂挥动完全 follow mc-lite，动画有点太生硬，改仿原版 Minecraft」。**① 晃动 = 两个原因叠加，不只是数值**：数值上 mc-lite 的 `intensity 0.05` 在 70° FOV 下只有±0.05 格平移（屏幕上约 1~2%），上调到 **0.09**（与 vanilla `bobView` 奔跑时 `f1×0.5` ≈ 0.05~0.1 同量级）；**更本质的是缺旋转分量** —— vanilla `GameRenderer.bobView()` 除位移外还施加 `rotation.z`（roll）与 `rotation.x`（pitch，`|cos|` 双频），只放大平移观感仍是「镜头在抖」而非「人在跑」。本仓无 cameraYaw → roll 直接跟相位（`sin(t)`，0.022 rad≈1.26°），pitch 跟 `|cos(t)|`（0.012 rad≈0.69°，刻意比 roll 小：它直接改变「看地上多少」，大了立刻晕）；两者按 `amount/intensity` 缩放 → 静止随振幅归零，不残留歪头。**② 挥动 = 从对称单曲线改为原版双曲线 + 多轴**：mc-lite 是 `sin(p·π)`（峰 p=0.5、前后等速、只有 rotation.x）；原版第一人称是 `attack = sin(√p·π)`（**峰 p=0.25**，快出，驱动 pitch 与 yaw）+ `whip = sin(p²·π)`（**峰 p≈0.707**，滞后，驱动甩腕 roll）+ 向前下探位移。**两条曲线峰值错开才产生「甩腕」**；单曲线无论怎么调幅度都是整体平移 —— 这就是生硬的根源。幅度：roll 用原版 20°（0.349 rad）、yaw 取 0.14 rad（原版 70° 是整条手臂骨骼空间角度，直接搬会过头）。**实测**：相机平移 x 峰值 **0.0436 → 0.0784**、y 0.0179 → **0.0322**；新增 roll 峰 **0.02193 rad** / pitch 峰 **0.01198 rad**；相机 roll 与 `viewBob.roll` 偏差 **3.5e-18**；静止三项全 0、停下收敛 ~1e-10。挥动逐帧轨迹：`p=0.25` rotX 已到 **−1.67**（谷底）、`p=0.697` rotZ 到峰 **0.3487**、`p=1` 三轴严格回 `−0.8/0/0`。浏览器内单测 **686/686**（+8 条）；E2E `view-bob.spec` **6/6**（新增：谷底须在 p≤0.35、滚转峰须在 p≥0.5、yaw/向前位移须发生、三轴结束严格归零、roll+pitch 上下界与静止归零）；**11 条负向验证全部真 FAIL**。⚠️ 首版「挥动带位移」断言写 `\|Δz\|+\|Δy\|>0.01`，注入「去掉向前位移」后**仍全绿**（Y 轴下探独立让总和过阈值）→ 改成分轴断言后才真 FAIL。一并修正 v1.48 的两条断言（行为变了非放宽）：谷底 p=0.5 → **p=0.25**；`BOB.intensity==0.05` → 改断言「已上调且非原值」。**回归**：`npm run check` 0 error、render-terrain/weapon-view/interaction/m3-hud 全绿。 |
| v1.50 | 晃动幅度回调 + 挖掘挥手时机改为「试图即挥手」 | ✅ 已完成 | 用户看过 v1.49 效果后的两条反馈。**① 「相机晃动又太剧烈了，稍微缓和一些」**：三项一起回调 —— `intensity 0.09 → 0.07`、`rollAmount 0.022 → 0.014`（1.26°→0.80°）、`pitchAmount 0.012 → 0.007`（0.69°→0.40°）。⚠️ **只降平移是错的**：观感刺激几乎全来自旋转（同量级角度变化比位移明显得多），保留原旋转只降平移仍会「歪得明显」。实测 camX 峰 0.0784 → **0.0610**、camY 0.0322 → **0.0250**、roll 0.0219 → **0.0140**、pitch 0.0120 → **0.0070**。**② 「只要试图消除方块就挥动，不管有没有成功」**：v1.49 把 `swing()` 放在 `editor.setBlock()` 旁边，而 `digBlock()` 上方有三个早退分支（矿车命中 / `!this.target` / TNT 引爆 / `isIndestructible`）→ 挖空气、挖基岩、点 TNT 时**挥动静默消失**。修法 = 把 `swing()` 提到**函数顶部、所有早退之前**，与 mc-lite 完全同口径（它 `:199-200` 是 `removeBlock(hit,true); this.swing();` 顺序执行、不看返回值；未命中走 `:207` 的 `else { this.swing(); }` 也挥）。代价是越肩挖空气也挥手 —— 原版就是这样，且挖掘是按住连续点，无反馈会让玩家以为卡住了。**实测与验证**：浏览器内单测 **687/687**（+1 条 roll/pitch 同步回调；改 3 条为回调区间断言）；E2E **7/7**（原「挖空不挥动」用例**反转**为「挖空也挥动」，并新增「挖掘触发的挥动不依赖世界是否真的改变」用逐帧轨迹证明挖空气走的是**同一个**挥动实现：谷底 p≤0.35、甩腕 roll ≥0.85 幅度、结束严格回位 —— 防「只置了进度但姿态不动」）；**5 条负向验证全部真 FAIL**（intensity 退回 0.09 / 退回 0.05 / roll 退回 0.022 / pitch 退回 0.012 / 把挥手移回 setBlock 旁边复现 v1.49 行为）；`npm run check` 0 error，interaction/weapon-view/render-terrain 全绿。 |
| v1.51 | 相机零旋转 —— 跑动时镜头不歪头 | ✅ 已完成 | 用户实玩反馈：「这个镜头晃动，左右摆动的体验很不好，跑动的时候镜头始终是水平的，身体再晃动，所有镜头晃动的时候不要『歪头』」。经选项确认后定为 **旋转全部去掉**（不只 roll，pitch 也归 0）、**保留左右平移**（位置微移不改变任何朝向，地平线永远水平）。落地 = `BOB.rollAmount` / `BOB.pitchAmount` 由 0.014 / 0.007 **置 0**。**字段保留而非删除** —— 它们仍是「可配置的旋转幅度」，置 0 = 关闭，将来要开回来只改数值、不动代码结构；这是**新的有意偏离 MC 原版**（原版 `GameRenderer.bobView()` 确实施加 roll 与 pitch）。**实测**（180 帧跑动采样）：相机 `rotation.z` 峰值 **0**、`rotation.x` 峰值 **0**、`rotation.y` 恒等于 `player.yaw`（朝向未被污染）；同时左右平移仍在（camX 峰 **0.0610** / camY 峰 **0.0250**）→ 证明「零旋转」不是靠关掉整个晃动达成的。**验证**：浏览器内单测 **686/686**（改 4 条：roll/pitch 须为 0、新增「跑动全程零旋转」硬不变式、静止用例改为「旋转恒 0 且平移保留」、删掉已无意义的 pitch 双频用例换成「平移相位关系保持」）；E2E **7/7**（跑动用例的旋转断言由「须有 roll/pitch」**反转**为「必须为 0」，并注明为何必须断言相机侧而非 `viewBob` 内部量）；**5 条负向验证全部真 FAIL**（roll/pitch 幅度退回原值、roll 公式写死常量、**player.js 自加 roll 常量**、**player.js 自加 pitch 常量** —— 后两条证明相机侧断言能抓「bob 对了但接线又加回来」的缺陷）；`npm run check` 0 error，interaction/weapon-view/render-terrain 全绿。⚠️ 踩坑：`expect(x).toBe(0)` 对 `rotateZ(0)` 产出的 `-0` **会 FAIL**（`Object.is(-0,0) === false`）→ 改用 `Math.abs(x) === 0`，锁「量为零」而非「符号为正」。 |
| v1.52 | 晃动改距离驱动，频率对齐原版疾跑步频 | ✅ 已完成 | 用户反馈「跑动就是左一步右一步的晃动，频率要适配跑动步伐节奏，现在太快了；参考原版我的世界玩家跑动时的特效，特别是晃动幅度和节奏」。**根因 = 相位是时间驱动**（`timer += speed·dt·60`）→ 晃动频率与移动速度脱钩，走慢/受阻时相位照涨。原版用**走过的距离**驱动：`walkDist += 0.6×水平位移`、`phase = walkDist×π`（经 `minecraft-renderer` 的 `computeCameraBob` 逐行核对 `GameRenderer.bobView`）。**频率标定（关键，别照抄步幅）**：原版一周期 = `2/0.6 = 3.3333 格`，疾跑 5.612 格/秒 → **1.6836Hz**（每步 297ms）、走路 4.317 → 1.295Hz；但本仓 `SPEED = 8` 格/秒（比原版快 ~43%），**照抄 3.333 格/周期会得 2.400Hz —— 比原版更快，与「太快了」方向相反**，故按**节奏时间**对齐：`phasePerBlock = 2π/(8×3.3333/5.612) = 1.3223 rad/格` → 1.6836Hz（比修复前 1.910Hz 慢 11.8%）。⚠️ **改 `physics.js` 的 SPEED 时必须重算 `phasePerBlock`**。**同时对齐原版振幅口径**：`intensity` 0.07 → **0.1**（原版 bob 上限）；x 幅度 = intensity×0.5（±0.05，比修复前 ±0.07 更小 —— 对「左右摆动体验不好」也是正向）；y 改为 `−\|cos(φ)\|×intensity`（**只向下**、每步一次下沉），取代 mc-lite 的 `cos(2t)×0.5`（双侧）。**实测**（真游戏页逐帧）：每步位移 0.1333 格 → 相位 0.1765 rad/步 → phasePerBlock 实测 **1.3241**（配置 1.3223）；**频率 1.6821Hz、一步 297.2ms、每周期 4.7453 格**（与目标 1.6836Hz/297ms 吻合）；maxX **±0.0446**、minY **−0.0905**、**y 恒非正**；roll/pitch 仍恒 0（v1.51 不变式未破）。单元 **687/687**（+2 条：距离驱动不变式、频率+振幅原版口径；改 4 条旧断言）；E2E **7/7**（上界改原版口径，新增「y 只向下」）；**6 条负向验证全部真 FAIL**（phasePerBlock 照抄步幅 1.8850 / 退回 1.5 / 相位改回时间驱动 / y 改回双侧 / x 不乘 lateralRatio / intensity 退回 0.07）；`npm run check` 0 error，interaction/render-terrain/weapon-view 全绿。⚠️ 探针踩坑：用「到原点距离」或跨减速段的 timer span 量频率会得到**负值**（timer 在减速时按设计重置为 0）→ 必须在持续跑动窗口内用相位增量或过零计数。 |
| v1.53 | 晃动幅度上调 0.1 → 0.13 | ✅ 已完成 | 用户反馈「晃动幅度再稍微大一点，现在的跑步的感觉不是很明显」。**本轮最有价值的发现：标称值 ≠ 玩家看到的幅度** —— `smoothingRetention = 0.7` 是一阶低通，在 1.6836Hz 处**通过率只有 0.8976**（实测），故标称 0.1 时**实际** y 峰只有 −0.0898、x 峰 ±0.0449；前几轮都在按标称值讨论「够不够」，实际相当于每次少给一成。落地 = `intensity` 0.1 → **0.13**（**有意偏离原版 bob 上限 0.1**：原版上限配合它的步幅与速度，本仓 SPEED 不同不能直接套）。**实测** y 峰 **−0.1177**（+31%）、x 峰 **±0.0580**，y 仍恒非正、roll/pitch 仍恒 0。**判定口径改为「扣掉平滑后的实际峰值」**：单测加实测下界（y 峰 >0.1、x 峰 >0.05）、E2E 加 `maxCamY > 0.1` —— 只比标称值抓不到「标称调大了但平滑把增幅吃掉」（本次 RED 正是靠它抓到 y 峰 0.0907 未过 0.1）。单元 **687/687**；E2E **7/7**；**4 条负向验证全部真 FAIL**（退回 0.1 / 退回 0.07 / 过冲 0.3 / x 不乘 lateralRatio）；`npm run check` 0 error，interaction/render-terrain 全绿。 |
| v1.54 | 步频放慢 1.6836 Hz → 1.5 Hz | ✅ 已完成 | 用户反馈「步频稍微慢一点」。原版疾跑 1.6836Hz（每步 297ms）→ 取 **1.5Hz**（每步 **333ms**，慢 10.9%）。**为什么不是更慢**：1.5Hz 仍明显快于原版**走路**的 1.295Hz，保留「在跑」的节奏感；再降会滑向走路的观感。换算 = `phasePerBlock = 2π×1.5/8 = **1.1781** rad/格` → 一周期走过 5.3333 格。⚠️ **改频率会连带改变实际幅度**：一阶平滑（0.7）的通过率随频率下降而上升（0.8976 → **0.9161**）→ 实际 y 峰 0.1177 → **0.1199**（这类耦合只能实测发现）。**实测**：真游戏页实测 `phasePerBlock = 1.1781`、`blocksPerCycle = 5.3333` 与设计值逐位相同→ 频率 **1.5000Hz、每步 333.3ms**；`maxCamY` **0.1199**、`maxCamX` **0.0592**；y 恒非正、roll/pitch 恒 0（v1.51/v1.52 不变式均未破）。单元 **687/687**（频率用例改写为 1.5Hz，新增「须快于原版走路 1.295Hz」与「`phasePerBlock` 须与目标频率自洽」两条护栏）；E2E **7/7**（E2E 不绑定频率 —— 频率标定归单测，因为 E2E 采样窗口会被减速重置打断）；**3 条负向验证全部真 FAIL**（退回 1.3223 / 照抄步幅 1.8850 / 相位改回时间驱动）；`npm run check` 0 error。⚠️ **探针经验（第二次踩）**：用真游戏页 `timer` 跨度量频率必须保证窗口内一直在跑 —— 撞墙/减速会让 `timer` 重置为 0，span 甚至变负；可靠做法是旁路累计「判据通过时」的相位增量与路程，或用 `phasePerBlock × SPEED / 2π` 核算再以 `blocksPerCycle` 交叉验证。 |
| v1.55 | 步频再降一档 1.5 Hz → 1.35 Hz | ✅ 已完成 | 用户反馈「再慢一档」。1.5Hz（每步 333ms）→ **1.35Hz（每步 370ms）**，同档位步长 +11%。**下界依据（比数值本身更重要）**：原版**走路**是 1.295Hz，1.35Hz 只剩 **~4% 余量** —— 再往下降就会落进走路的节奏里，观感从「在跑」变成「在走」，届时应重新确认设计意图而非继续微调；单测有「须快于原版走路 1.295Hz」硬护栏钉住这条界线。换算 `phasePerBlock = 2π×1.35/8 = **1.0603** rad/格` → 一周期走过 **5.9259 格**。平滑通过率继续上升（0.9161 → **0.9304**）→ 实际 y 峰 0.1199 → **0.1203**。**实测**：真游戏页旁路累计实测 `phasePerBlock = 1.0603`、`blocksPerCycle = 5.9259` 与设计值**逐位相同** → 频率 **1.3500Hz、每步 370.4ms**；`maxCamY` **0.1203**、`maxCamX` **0.0603**；y 恒非正、roll/pitch 恒 0。单元 **687/687**（频率用例改写为 1.35Hz，保留走路护栏 + 新增「须慢于上一档」）；**4 条负向验证全部真 FAIL**（退回 1.1781 / 落到走路节奏 1.0210 / 照抄步幅 1.8850 / 相位改回时间驱动）。⚠️ **E2E 踩坑（本轮唯一失败）**：「相机 x 须反复过零（周期性）」在 1.35Hz 下**假失败** —— 原窗口 180 帧 @120Hz ≈ 1.5s 只有 ~2 周期，去掉渐入后仅 1 次过零。**这是采样窗口没跟上参数变化，不是实现缺陷**；改为 360 帧（3s ≈ 4 周期）+ 跳过前 90 帧。教训：**凡「数周期/数过零」的断言，窗口必须按最低频率算够周期数**。`npm run check` 0 error，E2E 7/7（另用「相位单向漂移」注入确认周期性断言仍有效）。 |
| v1.56 | 手臂烘焙面明暗（消除「一个颜色、没立体感」） | ✅ 已完成 | 用户反馈「手臂的横面和竖面没有光影效果，感觉就是一个颜色，没有立体感」。**不换受光材质**（本仓全场景 unlit，换受光会让肤色随日夜灯光漂移、比同屏方块亮一档 ——v1.48 已记录该取舍），改为把明暗**烘焙进顶点色**，三层相乘：① vanilla 方块面遮挡系数（顶 1.0 / 前后 0.8 / 左右 0.6 / 底 0.5）；② 固定光向 Lambert（`lightDir=(0.35,0.85,0.4)`，抬到 `[0.45,1]` 防全黑）；③ **沿长度渐变 0.78**。材质色改白色、颜色全来自顶点色（避免两份权威）。⚠️ **第 3 层是实测必需**：`rotation.x=-0.8`（≈46°）时手臂只露出**两个面**（底面+前面），第三个面被几何挡住 → 只靠前两层时屏幕上仍只有两档、**单面是纯色**（直方图 78.9%/19.6% 两个尖峰、中间空）。**实测（1280×720，noon 冻结，隐藏 HUD，开/关手臂差分）**：修复前 **2 档 / 最大单色 78.9%** → 修复后 **11 档 / 46.8%**、面间双峰相距 **26%**。单元 **689/689**（+2 条：六面亮度两两不同且顶最亮底最暗 + 侧面内须有梯度；常量与 vanilla 系数一致）；E2E **8/8**（像素用例：档位 ≥6、最大单色 <65%、第二峰存在且峰距 >15%）。**4 条负向验证**：撤销烘焙 / 去长度渐变 / 去 Lambert —— 单元+像素**双双真 FAIL**；面系数全设 1 —— 单元 2 条真 FAIL、**像素仍绿（正确行为**：Lambert 单项本身有 50.9% 面对比度，画面确实有立体感；抓「面系数丢失」归单元断言）。⚠️ **断言踩坑**：①「对称面同亮度」不成立（+X 朝光 −X 背光）；② 取单顶点跨面比会被长度渐变带偏→ 改面内均值；③ `BoxGeometry` 顶/底 4 顶点 y 全相同 → 面内梯度只对侧面断言；④ 像素层不能用 `p75−p25` 判面间差异（面内渐变把分位数拉进两峰间，实测仅 6.3%）→ 改直方图峰距。`npm run check` 0 error，weapon-view/render-terrain 全绿。 |
| v1.57 | 手臂配色对齐 mc-lite + 晃动幅度再上调 | ✅ 已完成 | 用户实玩反馈两条：① 「玩家的手臂的颜色过于暗了，手臂的配色你参照 mc-lite 里默认手臂的颜色配置」；② 「玩家跑动过程中的晃动幅度还不够大，可以稍微大一些」。**① 手臂偏暗的根因不是配色常量选错**（`0xeebb99` 与 mc-lite `Player.js:137` 逐字一致），而是 **v1.56 的三层系数直接相乘把线性基色压到 0.20~0.48**：静止姿态（`rotation.x=-0.8`）露出的底面 / 前面分别只有 0.27 / 0.59。像素实测屏幕均值 **RGB(163,146,134)、亮度 147.7**，而参考肤色是 (238,187,153) —— 不但整体暗一档，还因为三通道被压得不一样而**发灰**（R−B 差 85 → 29）。另有一处：`bakeFaceShading` 把 `0xeebb99` 的 **sRGB 数值直接写进线性顶点色缓冲**（three r185.1 `ColorManagement.workingColorSpace = LinearSRGB`），未做 sRGB→线性转换。**修法 = 把 `color` 的口径从「线性基色」改成「屏幕上的参考色」**：①②两层（vanilla 面系数 × 固定光向 Lambert）**只决定面与面的相对强弱**，其取值区间归一化后重映射到新的 `shadeLow..shadeHigh`（屏幕空间亮度带，当前 **0.88 / 1.48**），再乘屏幕空间的沿长度渐变（`lengthFade` 0.78 → **0.88**），最后 `srgbToLinear` 写进顶点色缓冲。于是「参考色」与「显示结果」是同一份数据（红线 1：明暗与基色同源）。**这三个参数是逐档实测试出来的，不是推导值**：扫描 `shadeLow × shadeHigh × lengthFade` 共 40 组，取「① 均值贴近参考色 ② 面间双峰仍分离 ③ 单面内梯度 ≥ 10%」三条件同时成立的点。**实测（1280×720，noon 冻结，隐藏 HUD，开/关手臂差分）**：屏幕均值 **RGB(163,146,134) → (235,188,154)**（参考色 238,187,153）、R−B 差 **29 → 81**、亮度档位 2 → **16**、最大单色占比 78.9% → **43.7%**、面间峰距 **19.5%**（阈 15%）。⚠️ `shadeHigh > 1.07`（R 通道饱和点）是**有意的**：上端只作用于 +Y 顶面，而顶面在静止与挥动谷底都被几何自身挡住，玩家看不到 → 那段余量用来拉开可见面的对比度，否则可见两面只能挤在窄带里、立体感退化。**② 晃动幅度 0.13 → 0.15**（`BOB.intensity`）。⚠️ 判定仍用**扣掉一阶平滑后的实际峰值**：1.35Hz 处通过率 ≈ 0.916，故标称 0.15 → 实际 y 峰 ≈ **0.1375**、x 峰 ≈ **0.0687**（上一档实测 0.1203 / 0.0603）。同时加了**观感上限护栏**（`intensity <= 0.2`：再往上 y 峰逼近眼高的 11%，会从「在跑」变成「晕」）。**验证**：浏览器内单测 **690/690**（新增 1 条「显示色阶落在参考肤色附近」回归门 —— 近端亮度 ≥ 参考色 82%、R−B 差 ≥ 参考色 60%、可见面保留明暗差；改 1 条六面亮度断言，见下）；E2E `view-bob.spec` **9/9**（像素用例全绿，跑动用例的 INTENSITY 常量同步 0.15）。**4 条负向验证全部真 FAIL**：shadeLow/High 退回 0..1（亮度 23.2% vs 阈 82%）/ 完整退回 v1.56 旧实现（亮度 75.9%）/ 只去掉 `srgbToLinear`（R−B 差 44 vs 阈 51）/ shadeHigh 收成 0.95 窄带（可见面亮度比 0.965 vs 阈 0.93）；另 bob 两条（退回 0.13 / 越过观感上限 0.3）。⚠️ **断言踩坑**：v1.56 的「底面须最暗（严格等于最小值）」是幂律重映射下的**伪约束** —— 线性空间里 ±X（面系数 0.6）与 −Y（0.5）差得很少，重映射后 −Y 会略高于 −X。改为「底面须属于最暗一档（与最暗值差 < 面间跨度的 15%）」，可见三面的排序改按 **sRGB** 在新增用例里断言（那才是玩家看到的）。另有独立探针复核参考值：同几何换 mc-lite 的 `MeshStandardMaterial(0xeebb99)` 得屏幕 p50 **255,231,191** / 暗面 **179,151,133** —— 上游肤色在屏幕上是明亮的，不是暗棕，故「参照 mc-lite 配色」的正确落点是提亮而非换色号。`npm run check` 0 error，weapon-view/interaction/render-terrain 全绿。 |
| v1.58 | 太阳 N·L 方向光 + mc-lite 天空盒 | ✅ 已完成 | 用户反馈「目前的光影效果还是有点平淡，比如太阳光照到的表面要更亮一些，光的背面要更暗一些」+「mc-lite 的天空盒还有天空的贴图，你也照搬过来」。**根因不在日夜参数**：体素材质是 unlit，顶点 shade 只有 `max(skylight,blocklight)×ao`，户外 skylight 恒 15（DR-14）→ **一个方块六面亮度完全相同**；三种风格只改 `skyDim` 这类全局乘数。而 mesher 早已把世界面索引写进 packed bit10-12，**渲染侧此前零消费点** —— 通道是通的，缺的只是着色器那一步。**四项选型由用户拍板**：① 真实 N·L 方向光（非固定六面表）② 天空盒双图交叉淡入（非按小时硬切）③ 日轮/月轮一并搬 ④ **不移植** ACES/exposure/CSS 色彩分级。**标定是两个推导值**：`SUN_AMBIENT ≡ SHADOW_FLOOR = 0.5`（同一语义）、`SUN_INTENSITY = (1−0.5)/noonSunY = 0.625` —— 让 `SUN_AMBIENT + SUN_INTENSITY×noonSunY ≡ 1.0` 成立的唯一取值，即**正午顶面亮度恒等于改动前的 1.0**（实测 `uSunStrength` 0↔1 时顶面像素 **138.9 → 138.9 逐位不变**）。落地：顶面 1.000 / +Z 0.875 / ±X 0.725 / −Z、−X 0.500；墙面 +Z/−Z 像素比 **1.008（关闭）→ 1.313（开启）**。⚠️ **阴影与方向光必须合成，不能各乘一遍**：旧实现把 shadowFactor 直接乘 `vSkyShade`，若把 N·L 再乘一次，正午顶面在影区会变成 0.5+0.625×0.8×0.5=**0.75**（应为 0.5）→ 阴影变淡 50%。修法 = 先把 shadowFactor 重标定成 `shadowKill`（太阳被拿走的比例）**只乘太阳项** → 实测 `sun-shadow` 冻结比值 ratioA 仍 **0.735 逐位未变**。⚠️ **Tier 4 阈值是 sRGB 口径不是线性口径**：线性 0.875/0.500=1.750，过 sRGB 传递函数后 0.9429/0.7354=**1.282**，叠上贴图基色非线性后理论值域 **1.286~1.347**（实测 1.313）→ 断言区间取 [1.20,1.45]。**天空盒**：`skyBox4`（白天云 912K）/ `skyBox1`（星空 5.1M）原样复制到 `assets/sky/{day,night}/`，`scene.backgroundNode = mix(cubeTexture(day), cubeTexture(night), uNightBlend)`；混合因子从既有 `skyDim` 派生（`nightBlendOf()`，正午 0 / 晨 0.267 / 黄昏 0.274 / 夜 1），连续插值无硬切。**朝向风险用严格等价对照排除**：自定义 backgroundNode 路径 vs three 默认 `scene.background = cubeTexture` 路径**逐像素相同（diff = 0 / 172800）**。`skyBox2`（日落）**不搬**（mc-lite 自身零引用）。有意偏离 mc-lite 两条：不做 `backgroundBlurriness`（它走 pmrem 路径，与手工 backgroundNode 冲突；且本是离散切风格的补偿值）、天空随连续日夜插值。**日轮/月轮** canvas 径向渐变，位置 = 相机 + 方向 × `camera.far×0.55`、尺寸同比缩放（mc-lite 固定 150 单位 + 固定尺寸，照抄会在小视距下把 sprite 推出远裁面）；三套风格 `sunVisible` 原值全 false（贴图自带光晕）。**验证**：浏览器内单测 **702/702**（新增 12 条）；新增 Tier 4 两条 `sun-directional.spec` / `skybox.spec`；负向验证真 FAIL（`nightBlendOf` 漏除法 2 条、双图混合写死 0）；`sun-shadow` 11/11 + `ao-visual`/`ao-corner-visual`/`render-world`/`weapon-view` 全绿。⚠️ **观测口径隔离（断言与阈值逐字未动，只改被测 setup）**：四份 spec pin `?skybox=0`（`render-terrain`/`city-visual`/`sky-structures`/`m3-rain` —— 实测天空区 **99.4%** 像素被「±30 内等于 0x87ceeb」判据误判成地形，下界断言近乎恒真）；`test-sky-tree.html` 设 `uSunStrength=0`（绝对叶色判据 ratioA 从 1.000 跌到 **0**，该 fixture 测的是通道语义而非光照）。`m1-acceptance` 放挖 p95 贴线为**已有 flaky**：交替对照 HEAD vs 改动各 3 轮，两侧 p95 中位同为 **2.00**、编辑耗时中位同为 **0.80ms** |
| v1.59 | 雾色融入天空（按方位角采样天空盒） | ✅ 已完成 | 用户反馈「天空盒之后，远方的方块变成了原来天空颜色的方块，停留在天空盒图案的前面，显得十分突兀」。**根因是雾色来源与天空已不是同一个东西**（不是雾算法太简单）：`setupFog` 的雾色是**单一 uniform** `0x87ceeb`，而天空已是照片立方图；两者唯一联系在 `daynight.js`（两个字段赋同一个 hex）—— 天空盒一开这条「同色」前提就断了。实测差距：固定雾色 sRGB **[134,205,234]** vs 天空盒在雾带仰角处的实际色 **[188,202,229]**，**R 通道差 54**（R 恰是「蓝天 vs 灰白 wash」之别）。需求经两轮澄清**收窄为开关**（用户：「太复杂了，我干脆简化掉算了，你在设置面板里给我一个选项」）：① 按方位角采样（非单色、非全天穹均值）② 面板**新增独立一行**不替掉「自动」（替掉会失去日夜循环自动档）③ **默认关**。**不新增渲染通道**：`fog(color, factor)` 的 color 本就是任意节点（`three.webgpu.js:42069` = `vec4(factor.mix(output.rgb, color.toVec3()), output.a)`），开关走 `mix()` 插值（`uFogColorMix` 0/1）而非分支 → 关闭时**逐位**回到 v1.58。⚠️ **方向换算的关键规则：俯角（y ≤ 0）一律归到地平线带、只保留方位角**（纯函数 `src/render/fog-sky-direction.js`，TSL 同构并 import 其 ε）：初版直接用完整视线方向 → 俯视时采样到立方图的**天底那半张**（实测白天 negy [97,125,186] vs 地平线 [207,216,232]）→ **雾色反向变暗**（实测 G −17 / B −12）；垂直俯视无方位角可保，取 +x 作确定性兼就（**不得返回天顶**，实测会让俯视变暗）。**实测**（960×600，noon 冻结，停物理，隐藏 HUD）：同状态重复截图**噪声底 = 0**；平视雾带 R **184.9→189.9（ΔR +5.0）**、`maxTop=0`/`maxBottom=0`/`maxAll=14.95`（变化**只**在雾带）；俯视机位 R **195.1→204.3（ΔR +9.2）**；开关往返 off `[184.9,201,214.3]`→on `[189.9,200.6,215.6]`→back **逐位相同**；**天空区与近景区逐位不变**；bench 四场景 draw call 与改动前逐位相同（500/559/559/545）。**验证**：浏览器内单测 **709/709**（新增 7 条）；`fog-color.spec` **5/5**；回归 `skybox`/`sun-shadow`/`sun-directional`/`render-terrain`/`daynight-visual` **16/16**；**3 条负向验证真 FAIL**（`uFogColorMix` 写死 0 → ΔR 0.0；去掉 y 钳制 → 俯视 ΔR **−3.3** 方向反转；纯函数去掉钳制 → 单测 3 条 FAIL）。⚠️ **负向验证盲区实测**：去掉 y 钳制后**平视机位仍通过**（ΔR 5.0→3.5 仍 > 阈值 2，因平视时 `dir.y` 本就接近 0）→ **只有俯视机位能抓到该回归**，故 spec 特意保留两条同判据、不同 pitch 的用例 |
| v1.60 | 夜空天空盒无缝重烘焙 | ✅ 已完成 | 用户反馈「黑夜的天空盒的拼接图片效果不好……出现了明显的衔接边界，看上去就是一个有楞有角的盒子」，要求「类似白天的天空盒的样子，是看不到边和角的」。**根因在素材本身，不在接线**：mc-lite `skyBox1` 的六面是**各自独立生成**的图，12 条共享边平均 RMS 落差 **41.09**，而用户认可的白天 `skyBox4` 只有 **1.90**（差 22 倍）；各面平均亮度也互不相同（`posx` [19.3,40.4,67.6] vs `negz` [15.2,26.2,44.1]）。**白天之所以看不出边角**：它下半部是近乎均匀的渐变，边缘本来就很平缓。**做法 = 方向空间加权重采样重烘焙**（`npm run nightsky`）：输出像素 → 立方体方向 `dir` → 六面各自按 `dir` 反算 uv 并双线性采样 → 按「离本面中心多近」加权平均。`dir` 跨面连续 + 权重连续 → 边界两侧算的是**同一条射线、同一组权重** → 接缝数学上**精确为零**；面中心只有本面权重 → 原图细节完整保留。**判据的关键教训**：不能看裸 RMS，必须归一化到图像自身的**面内相邻列噪声底** —— 白天接缝裸 RMS 是 1.90 却不是 0（JPEG 量化残差），肉眼看不到是因为它**并不比画面内部更粗糙**（噪声底 1.06 → 比值 **1.786**）。实测：烘焙后接缝 **1.865** / 噪声底 6.048 → 比值 **0.308**；原始夜空 **41.094** / 9.009 → 比值 **4.561**。即新图**比用户认可的白天基准还平滑 5.7 倍**。配色与细节同样保住（均值 [17.7,35.7,60.4] vs 原图 [17.7,35.7,60.3]；高频能量 7.44 vs 10.61）。体积 5.1MB → 1.34MB。**被否决的方案**：① 程序化重新生成整套星云（六面同源 fBm，虽也无缝但观感差得远 —— 实测偏暗偏糊，均值 [9.8,21.2,42.9]）；② ridged 噪声做细丝（会产生**闭合白轮廓环**，像大理石裂纹）；③ 只做边缘羽化（星云结构仍跨不过边界）。**负向验证**：把原图放回 `assets/sky/night/` → spec 真 FAIL（比值 4.561 > 白天 1.765）。⚠️ **屏幕级判据被实测否决并删除**：量「列均值一阶差分的最大峰/中位」对原图是 16.3、对烘焙版是 19.8（**反而更低**）→ 画面里地形/星点噪声淹没该信号，判据没有判别力，留着就是假断言 |
| v1.61 | 夜间雾距统一（雾色在夜里生效） | ✅ 已完成 | 用户实玩反馈「从白天切换成黑夜模式后，远方的雾色和天空盒的颜色渐变嵌入就没有了」。**根因是风格数据里的 `fogScale`，不是雾色机制**：mc-lite 的 night 风格是 `fogScale = 4.0`（morning/noon 都是 1.0），而 `daynight.js:_apply` 把它乘到雾距上 → vd=8 时 `fogFar` 从 **152 格变成 608 格**，世界径向只加载约 `(8+2)*16 = 160` 格 → **视野内没有任何方块到达雾区**，雾不参与渲染，`uFogColorMix` 即使为 1 也没有东西可染。**实测证据（只差一个变量）**：黑夜默认 `fogFar=608` → 开关切换 **0.0%** 像素变化；仅把 `fogNear/fogFar` uniform 改回正午口径（不动代码）→ **4.0% / 最大三通道和差 184**。修复后黑夜 **4.0% / 184**、正午不受影响（4.1% / 63）、天空区逐位不变、开关往返逐位还原。**保留 4.0 是 mc-lite 的代偿手法**（它要用雾把夜里的远处推成漆黑），本仓有夜空贴图与星点，不需要这个代偿 —— 雾色与天色一致时远景观感反而更自然。⚠️ 诊断过程教训：上一轮实测到「深夜 Δ=0」时我误判成「夜里看不出差别是合理的」并据此收工，**这是把测量的异常读数当成预期** —— 同一份数据（Δ=0）在白天是缺陷、在夜里被我解释成合理，两边用的是不同标准。新增 Tier 4 用例钉了两层：① `fogFar < 世界加载半径`（直接钉根因）② 开关打开后远景必须变化 >3（实测通道差 41），负向验证（注入 `fogScale=4.0`）真 FAIL |
| v1.62 | 曳光寿命缩到 1/4 | ✅ 已完成 | 用户实玩反馈「机枪和加特林开火的时候会有一条子弹射出的火线……会有一定的延迟再消失，就导致玩家在奔跑的过程中火线的残影会停留住一段短暂的时间，奔跑时连续射击，就会出现射向远方的很多条火线的残影」。**根因不是残留 bug，是两个已定口径的叠加**：① 曳光起点/终点冻结在开火瞬间的**世界空间**（v1.33）；② 寿命虽只有 0.08~0.15s，但**不随相机移动而缩短** —— 玩家以 8 格/秒奔跑时 0.08s 已移动约 0.64 格，残影留在出发点不动 → 每发都在身后攒一条朝远方伸展的火线。**修法只改 catalog 的 `tracer.lifetime` 一个字段**（渲染层读 `effect.tracer.lifetime`，无第二份权威）：mc-lite 原值 0.10 / 0.15 / 0.08 **× 1/4** → 手枪 **0.025** / MAG7 **0.0375** / 加特林 **0.02**；**颜色与粗细不动**。真游戏页探针实测（单发后逐帧读 `activeTracers`）：手枪 **2 帧 / 21.0ms**、MAG7 **4 帧 / 35.1ms**、加特林 **2 帧 / 17.8ms**，三个 `maxActive` 均为 1 → 曳光**确实还在渲染**，不是缩到看不见。回归：`weapon-view` 3/3 + `weapons` 1/1 全绿、`npm run check` 0 error。⚠️ 这是**实玩观感标定的第一档**（用户「先降为原来的四分之一，我先看看效果如何」），后续可能继续微调 —— 调数前先确认「世界空间冻结」口径不变，两者是耦合的。 |
| v1.63 | 背景音乐 + 面板开关 | ✅ 已完成 | 用户要求「仿照 mc-lite 加上背景音乐，并在面板里加一个背景音乐的开关」。mc-lite 的实现极简（`AudioManager.playBGM(name, vol)` = `setLoop(true)` + `play()`，唯一触发点是 `Player.js:296` 的 document click，`bgmStarted` 一次性），故本改动**不是新子系统**，是在既有 `AudioManager` 上补一条循环通道。**三个接线点漏一个就是静默失效**（面板显示开启、按钮高亮、就是没声音，无任何报错）：① `BGM_ID` 与 `SOUND_IDS` 分开两份清单（语义不同：事件音效 vs 循环音乐）；② 起播 = 「意图 + 已解码 + 手势已解锁」三条件对齐 → **`preload()` 末尾与 `unlock()` 末尾各自都要调一次 `_syncMusic()`**（真实玩家顺序是「先点一下、几秒后 4MB 才解码完」，只写一处就断一半）；③ `unlock()` 的唯一入口 = `Player` 既有 canvas `onClick`（不另挂 document 监听）。**面板落位 = 左列（雾色下方），不是右列** —— 「新配置往右列填」的前提已反转：实测加右列后面板 653px、内容 706px > 可视 645px → 出滚动条、「世界」行被裁；放左列面板高度不变且零文本溢出。默认开（mc-lite 进游戏即播）、音量固定 **0.15**（上游原值，**不消费** `settings.volume`）。验证：单测 6 条（716/716 全绿）+ E2E 2 条；**负向验证三处注入全部真 FAIL**（preload 不补起播 / onClick 不 unlock / 面板不调 game）。⚠️ 两条实测踩坑使首版 E2E 成为**无效盲区**：localhost 上 4MB mp3 几十毫秒就解码完（→ `page.route` 推迟 1.5s 造真实顺序）、Playwright 默认 `--autoplay-policy=no-user-gesture-required`（→ 用例主动 `ctx.suspend()`）；另有单测里 `dispose()` 会关掉 three 的**全局单例** AudioContext、带倒后续三条用例。限制：不做歌单/随机/淡入淡出；BGM 进首屏预载（4.0MB）。详见设计文档 v1.63 修订说明与 CLAUDE.md「背景音乐沉淀的活跃约束」。 |
| v1.64 | 光照跨 column 边界修复（blocklight 区域 3×3） | ✅ 已完成 | 用户实玩报告「放置灯具后照明区域有一条笔直边界，但紧挨边界再放一盏灯光又能跨过去」，两条截图佐证。**边界就是 column（16×16）边界**。根因两处，都属「区域语义」：① `computeBlocklightRegion`/`computeSkylightRegion` 的 column 集合只取「中心 + 4 正交邻居」（5 列），而光强度 15、每格 -1、最远照 **14 格**、column 边长 16 → 正交邻居最近格距本列边缘 1 格、**对角邻居 2 格**（两者都必须参与），隔一列已 17 格（恒 0）→ 正确区域是 **3×3**，plus-5 漏了 4 个对角列。全量 BFS 作真值实测：最大误差 **10 级 / 982 格错**（3×3 与 5×5 都是 0）。② `enqueueLight` 只入队编辑所在列，而写回协议只写中心列 → 灯的邻居列**永远没有自己的 task**，light 永远是 GEN 的截断值 0（实测放灯后入队清单只有 `['17,7']`，四邻居非零格数全 0）。**入队范围 ≠ 写回范围，这个不对称是载荷性的**。连带修掉两处：`_onGenResult` 对「3×3 内有 emissive」的列补入队（结构性光源没有任何编辑事件，实测 43 个发光方块的跨列邻居格 126/134 是 0）；写回前校验 **region 全部输入列**的版本（邻列 blocks 变了而中心列 version 没动，中心列校验抓不到 → 旧回包静默回退）。脏标记改为逐 section 比对（只脏真正变了的 sy），否则入队扩到 3×3 会把 mesh churn 放大 9 倍。light RPC 回包改为「只回中心列 light + 各输入列 version」——9 列实测 7.8ms/0.59MB 入，**不高于**原 5 列口径。**验证**：单测 5 条新增（对角邻居必须照进 / 3×3 == 全量 BFS 真值 / 隔列仍为 0 / enqueueLight 覆盖 3×3 / 邻列版本不符必须丢弃）+ 只脏变化 section；E2E 新增 3 条（`light-spread` 轴向剖面无断裂跳变 + 四邻居列都亮 + 隔两列轴线上仍为 0；对角方向判据；`light-structures` 结构性光源）。**负向验证四处注入全部真 FAIL**：region→plus5（单测 3 条 FAIL、E2E 对角判据 0/11）、enqueueLight→单列（E2E 剖面 `…8,0,0,0` 复现用户截图）、去 region 版本校验（stale 回包把中心列压成 0）、去 GEN emissive 收敛（19 判据里 15 个失效）。`m1-acceptance` 编辑 p95 **1.70ms**（冻结门 <2ms）/ fps 120 / drawCalls 528 不变。详见设计文档 v1.64 修订说明与 CLAUDE.md「blocklight 区域语义」。 |
| v1.65 | 光照变化的脏 section 传播修正（「灯光有边界」第二次修 + 「删灯后不变暗」） | ✅ 已完成 | v1.64 之后用户复测：「还是没有彻底修复，灯光还是有明显的边界」（截图 `灯光有边界2.png`，坐标 278.5/160.0 站在 z=160 的 column 边界上）+「把灯删除后，刚才被照亮的方块面不变暗」。**真游戏页三层对照（只差一个变量逐层缩小）**：① 数据层——整图参考 BFS（不做区域截断）vs 每列 `light`：**0 个格子不一致**，光确实越过了边界；② 网格层——拦截 `renderWorld.uploadSection` 记录实际上传的 packed，对照 `buildSectionMesh(当前数据)`：**6 个 section 过期**，全是 `sy=1`（沙滩 y=-1 所在 section 的最上层）；③ 画面层——夜景截图：放灯后沙地没被照亮，强制重建后才亮，删灯后沙地仍亮。**结论：数据是对的，网格是旧的**（所以 v1.64 的 E2E 只断言 `column.light` 全绿却没挡住）。**三处独立缺口**：① v1.64 引入的「只给 light 字节真变了的同 sy 置脏」漏了 mesher 的真实依赖——section S 读 S 自身 16³ + 六个面外 1 格厚的 halo 的 light，地表在 section 最上层时顶面读的是 `sy+1` 最底层那格，那格变了地面没人通知；同时对 8 个邻列一律按同 sy 置脏（含根本不依赖的对角列）。修法：纯函数 `lightDirtyMasks(prev,next)`（`lighting.js`），本列含上下相邻 section、邻列只含 4 个正交列且只在 lx/lz∈{0,15} 时置脏；② **在途 mesh 回包因同 column `version++` 被丢弃后无人重发**（脏标记在派发前已被 `takeDirty` 消费）→ 数据对画面旧，**偶现**；真游戏页确定性构造 3/3 复现，`_onMeshResult` 与 `_processUploadQueue` 两处丢弃点改为 `_redispatchDropped`（丢弃的是结果不是工作，与 `_onLightResult` 的「丢弃并重新入队」同一语义）；③ light 回包只校验输入列版本、不校验输入列**集合**：在途期间 3×3 里新到达的就绪列不在 `inputs` 里，而它到达时的 `enqueueLight` 因本列「在途」被跳过 → 永远缺它的光。补第三层校验。**验证**：单测新增 19 条（纯函数与 mesher 交叉比对 9 条，含 pocket 世界「预测集合 == mesher 实测变化集合」逐项相等 + 随机稀疏世界 ⊆ 预测；写回协议与丢弃重发 10 条，含两个丢弃点、输入集合、对角列不得置脏、内部变化不波及邻列），722 → 741 全绿；E2E 新增 `tests/light-mesh-sync.spec.mjs` 2 条（夹具 = 顶面 y=79 的整片石头地面，与地形/seed 无关；断言落在「上传网格 == 现算网格」上；竞态用例在 `scheduler.update` 接缝处挂钩子确定性构造）。**负向验证三处各自撤销全部真 FAIL**：撤销 Y 方向传播（E2E 两条红、7 条单测红，且复现了 `darkAgain=14` 即删灯后仍亮）；撤销丢弃重发（竞态 E2E 红、Y 方向 E2E 仍绿 —— 两条相互独立）；撤销输入集合校验（单测红，实际队列 `0,-1\|1,-1\|1,0\|0,1\|1,1` 唯独缺中心列）。修复后同一批复现脚本：放灯/删灯后过期 section 6→0；快速连放连删 16 轮（40/8/0ms 间隔）0 不一致；边走边加载 4 次 × 648 section 0 不一致；放灯→存盘→刷新后画面与强制重建的画面**逐像素相同**。`lightDirtyMasks` 每次 0.02~0.04ms。详见设计文档 v1.65 修订说明、`.pi/plans/2026-10-21-light-mesh-sync-fix.md` 与 CLAUDE.md「blocklight 区域语义沉淀」。 |

| v1.67 | 枪击命中特效收敛为两层 + MAG7 全格白闪波浪 | ✅ 已完成 | v1.66 交付后用户两轮实玩反馈。**第一轮**：「散弹枪 MAG7 的击碎效果不好，把碎片散落效果和光晕扩散效果给去掉」「手枪和机枪的击碎方块的效果很好，但是闪光效果不好，闪光效果不要用一个球形闪光球了，直接让被击中的方块变成白色闪一下，然后消失，同时伴随着你已经实现好了的碎片散落的效果」。**第二轮**（本次）：「Mag7 击中的方块的特效，现在是中心的一个方块做白闪，改成所有伴随着消失的方块都做白闪后消失。为了确保更好的效果，每个方块消失过程中设定一个定时器，不要同一时刻消失，比如用 600ms 的时间依次让应该消失的方块白闪后消失，模拟一个有扩散过程的击中效果」（第三轮实玩后追加「太慢，改为 150ms」，即 `whiteFlash.staggerMs` = 150）。**用户三条拍板**：MAG7 保留「白方块闪一下」（与手枪同一套反馈，差异只剩玩法上的 3×3 范围破坏）；面闪灭去掉（白闪取代它，两套闪并存只会互相打架）；白闪形态 = 整格白立方。第二轮追加两条：世界**立即**删除（不延后，碰撞/射线/存档即时生效，零玩法风险）；扩散顺序 = **由命中点向外**。**改动**：`IMPACT_PROFILES.mag7` 的 `debrisCount`/`dustCount` 归零、`size`/`speed`/`spin` 删掉（死字段），全部 profile 的 `ring`/`ringRadius`/`flashScale`/`flashLifeMs`/`flashColor` 删除；`IMPACT_FX.flash`/`faceFlash`/`shockwave` 三组参数删除，新增 `whiteFlash = {holdMs:55, totalMs:150, staggerMs:150, maxActive:48}`；新增纯函数 `blockCenter`（白闪落块心）、`whiteFlashOpacityAt`（前 55ms 恒 1 → 线性淡出）、`staggerTimes`（多格在 `staggerMs` 内均匀铺开的时刻表，当前 150ms）；`_fireMag7` 从「只报最近一格」改为「一个 impact + 全量 `stagger` 波浪列表」；渲染器把白闪重建为**逐 slot 独立材质的白立方 Mesh 池**，未到时刻的 slot 先挂起（`opacity=0`/`visible=false`）由 `update()` 按 `startAt` 放行；`game.js` 撤掉只给面闪用的 `tileRect`/`atlasTexture` 接线。**四个载荷性细节**：① 白闪必须是**块心**不是命中面（贴命中面会半个方块偏移、只发白半边）；② 白闪走 NormalBlending —— 命中格此时往往是空气洞，加法混合叠到天空上会烧成白团（v1.66 实测结论）；③ 同格白闪去重（150ms 内再次命中重启该 slot）：两个完全重合的半透明白立方深度相等 → 闪烁/z-fighting；④ **不能用 `setTimeout` 做错开** —— 定时器与渲染帧不同源且页面隐藏时被节流，故用「排队 + `update()` 比对 `startAt`」，与所有池的到期判定同一时间基准。**排序键踩坑（实测推翻既有口径）**：`collectMag7Changes` 原按距离组 `group = floor((d-1)/2)` 排序，但那是**沿视线**的采样距离分组，同组内 3×3 截面九格彼此距离差很大 → 白闪波浪实测相邻两项 1.732 → 1.414（反而变近），观感是「先向外扩散一小圈又收回来」。改为按**到命中点的真实几何距离**（新字段 `centerDist`）排序。破坏行为不受影响（只依赖哪些格被删，不依赖次序）。**验证**：单测 779/779 全绿（`test-block-hit-fx.js` 新增 `staggerTimes` 3 条 + 池容量 1 条 + 配置值 150ms 1 条；`test-weapons.js` 改写波浪覆盖全量格 + 真实距离单调两条）。Tier 4 新增「MAG7 白闪波浪逐个亮起」1 条，判据用**已启动格数**而非可见白闪数 —— 后者是「进入−消退」净流水（实测剖面 `1,9,10,10,9,4`），寿命 150ms ÷ 40 格摊 600ms（间隔 15.4ms）→ 任何时刻最多约 10 格并存（理论值与实测峰值都是 10）；换成 150ms 波浪后间隔 3.8ms → 约 39 格并存（几乎全亮）→ **可见数阈值随时长立刻失效**，故判据只能落在「已启动格数」上。另：波浪采样窗须覆盖 `staggerMs + totalMs`（150+150=300ms），只采到 200ms 时末格仍在淡出段（实测尾部残留 26 个）。**负向验证两处注入全部真 FAIL**：`staggerTimes` 全部返回 `now`（＝用户抱怨的「同一时刻全消失」）→ `t=0 不得全部亮起：40`；控制器只报一格 → `白闪波浪须覆盖全部被毁格，实得 1 格`。真游戏页端到端（10 层厚墙 = 90 格，MAG7 上限 40，600ms 口径实测）：`waveCells=40`、`deletedImmediately=40`（世界**同帧**全删，不是延后）、白闪可见数 t=16ms 为 2 → 中段稳定 10（= 寿命/间隔）→ t=900ms 归零。下调到 150ms 后波浪更密（间隔 3.8ms），**负向验证**把 `staggerMs` 改回 600 会让 Tier 4 该用例真 FAIL（`扩散时长须为 150ms`）。`weapons-world-edit`（200 次手枪 + 20 次 MAG7，版本与队列收敛）照常通过。 **⚠️ 操作失误记录**：负向验证期间对 `weapon-controller.js` 用了 `git checkout <file>` 撤销注入，把用户**上一轮尚未提交**的 v1.64 `impacts` 接线一并回退（该文件当时含未提交工作）。已按 diff 重建并核验（778 全绿 + 44 行插入与丢失前一致）。之后的注入改为一律 `cp` 备份再 `cp` 还原，不再对含未提交改动的文件用 `git checkout`。 |
| v1.68 | 巨树景观（28 变体 × 三条落位路径） | ✅ 已完成 | 素材 `40AssortedTreesPack.schem`（入库）→ 离线烘焙（2×2×2 降采样规则写死 / 24 个源方块名显式分类 / 地块索引 (minZ,minX) / 族标志反向校验）→ 28 个变体；`giant-trees.js`：region 层候选 = 全局对齐网格 + 内缩抖动，column 层合并 3×3 邻域候选（拼接 + 规范排序）→ 排除（城市 / 地标 / 撒布 / JSON 占地）→ 光栅化 + 地基 → 覆盖窗口抑制旧森林树。8 个 `giant_*` 方块（树叶 opaque 且投影、不进背包），6 张贴图沿用 `leaves.png` 图案只换色。**opaque 容量 ×1.5（用户裁决）**：2.85M→4.275M，GPU 静态 148.06→188.83 MiB。真实页面 reserved：5 视域 + 3 冲刺最高 opaque 82.1%（A 森林 spacing 14→20→32 后 76.4%）、零 opaque 扩容；cutout 只降不升（(-20,10) 128.1→53.9）；draw call ①+16 / ④+41。规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md`，计划 `docs/superpowers/plans/2026-10-23-giant-trees.md`，验收报告 `docs/giant-trees-acceptance-report.md`。 |
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

### 面板与 UI（v1.35 / v1.63）

**破坏性按钮的常态文案只有一份**（`settings-panel.js` 的 `CLEAR_SAVE_LABEL`）：构造与
`_resetDangerArmed()` 复位共用同一常量。实测踩坑：复位函数写死旧长文案会覆盖构造时的短文案
→ 面板打开后显示复位那份，构造代码形同虚设（肉眼看不出哪个是「真相」）。

**面板列分隔线规则只作用于 `.mc-item`，不得通配所有子项**：写 `.mc-column > :first-child`
会连带抹掉 `.mc-combined` 合并盒自己的装饰边框（特异性 1,2,0 压过 1,1,0 → 上边框 `none`，
方框缺一边；用户实玩报告，观感上只是「少一条线」，肉眼看不出是特异性冲突）。往面板加新容器
类型时须同步考虑这条选择器。

**面板按钮基线是 `flex: 1`（等宽铺满），「变窄」只能在作用域内覆写**：`.mc-footer` 的「确定」
按钮与全部档位按钮都靠这条基线，改基线会连带改掉它们的宽度。v1.43 首版曾用 `.mc-narrow`
（`flex: 0 0 88px`）把创造台主按钮固定变窄，**该手法已随布局拆分下线**（2026-09-30 用户实玩反馈：
模型按钮要挤进主按钮同一行，而不是主按钮变窄 + 模型另起一行）—— 现在是「不激活时主按钮靠
基线 `flex:1` 独占整行，激活后三按钮各自由 `flex:1` 平分该行」。面板每列约 351px，
三按钮均分时各约 111px，「关闭创造台」5 个汉字约 68px 仍换不了行。

**面板的行是「一行一个功能域」，不要再把两个功能域合进一行再加第二行**（v1.43，用户实玩反馈）：
创造台行（平台+模型，模型按钮与主按钮**同一按钮组**，靠 `display` 切换可见性）与进度管理行
（`_rowProgress()`，两个常驻按钮）是**两个独立的 `.mc-item`**，进度行在创造台行下方。
合写一行的代价：玩家分不清「导出进度」与「导出模型」属于哪个功能域，且为装下 5 个按钮
必须把主按钮压窄 88px。**后续往面板加按钮时按此口径归行**，不要重新合并。

**同一行里的两个「重活」按钮不得共用一把 busy 锁**：面板已有 `_playgroundBusy`
（创造台 2916 格写入），进度导入导出另有 `_progressBusy`。共用会让模型导入/导出的
**异步文件读取**与进度操作互相吞掉对方的操作（先点的那次被后来者直接 `return` 掉），
而按钮看上去均已被点过。

**两列高度的实测结果（v1.63，推翻了「新配置往右列填」的前提）**：

| 面板列 | 行（自上而下） | 高度 |
|---|---|---|
| 左列 | 画质+枪械破坏合并盒 / 环境风格 / 雾色 / **背景音乐（v1.63）** | 231 → **300** |
| 右列 | 视距 / 帧预算 / TNT 破坏 / 创造台 / 进度管理 / 世界 | **571**（决定面板高度） |

把「背景音乐」加在右列时的实测：面板 **653px**、内容 **706px** > 可视 **645px**（`.mc-content`
是 `max-height: 84vh; overflow: auto`）→ **出现纵向滚动条**，且「世界」行（含删除缓存这个
破坏性操作）被裁到折线以下。改放左列后：面板 635px、内容 627px = 可视 627px、**零滚动、
零文本溢出**（逐元素 `scrollWidth > clientWidth` 检查全空）。

⚠️ **量法**：`getBoundingClientRect()` 读两列高度 + `.mc-content` 的 `scrollHeight` vs
`clientHeight`；别只看截图（浏览器在 720p 下滚动条很细，容易漏）。判据是
**面板高度不增长的那一列**，而不是哪列「名字上余量更大」。

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

### 巨树景观（v1.68）

- **容量口径**：reserved = 1.25 × 已用顶点（`render-world.js:204`），相对**初始**容量常量；Node 侧「注入树 + 真 mesher」的已用占比比真实页面低 1.20~1.24 倍。HEAD 基线（初始容量 2.85M / 2.2M / 0.125M，reserved%）：出生点 81.6 / 72.3 / 10.6；(18,27) 82.3 / 48.4 / 36.8；(-20,10) 87.6 / **128.1** / **100.3**；(30,10) 79.1 / 70.8 / 11.2；(-25,-5) 84.6 / 21.2 / 49.0；(10,40) 83.0 / 30.1 / 85.8；森林冲刺→西 99.9 / 129.3 / 128.7、→南 103.1 / **145.4** / 140.8；海岸冲刺→东 98.4 / 57.1 / 114.3。
- **终版读数**（4.275M）：(18,27) 58.0 / 45.9 / 36.8；(-20,10) 70.2 / 53.9 / 100.3；(30,10) 53.8 / 69.9 / 11.2；(-25,-5) 69.6 / 12.2 / 49.0；(10,40) 61.6 / 17.2 / 85.8；冲刺 79.6 / 82.1 / 72.6（opaque）。transparent 与 HEAD **逐位相同**（巨树不碰水）。
- **候选算法对比**（7 个 region）：原贪心 14~20 ms/region、跨 region 边界间距违规 64 对；网格抖动 ≈1.1 ms/region、违规 0。密度（每 eligible 格）A 1/1523（spacing 32；14 时 1/464、20 时 1/586）· B 1/199 · C 1/207。
- **覆盖损失**：含巨树的 109 个 column 样本里，巨树期望格 43,672 个、98.40% 落地，1.60%（700 格）被后写者覆盖——绝大多数是相邻巨树（B/C 冠幅重叠成片是设计意图），云仅 5 格；树干格 0.89% 被邻树叶覆盖。`makeColumnSetter` 无占用格守卫（后写胜）是全局既有行为，规范排序保证确定性。
- **预热数据**：安静系统 genP95 HEAD 7.6~8.2 / 有预热 7.5~8.1 / 无预热 9.4~10.0（一次撞 10ms 门）；负载下 8.1~9.8 / 8.4~10.0 / 11.6~14.0。
- **atlas**：147 → 153 tile，既有 32 个 tile 坐标被重排；图标产物逐字节不变（8 个新方块全部隐藏）。

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
| 灯 / 光源 | emissive 属性 + blocklight flood fill（光照管线已含）。⚠️ **太阳方向光已落地（v1.58）**（`materials.js` 的 N·L 太阳项 + 天空盒），但那是**全局太阳**、不是点光源：光源 Epic 仍须走 blocklight flood fill，两者不重叠 |
| 床 / 宝箱 / 门 | 多方块结构 + meta/orientation 位 + `blockEntities` 通道 + 交互事件 |
| 音频 | AudioManager + `block-changed` / 交互事件总线。⚠️ **背景音乐已落地（v1.63）**，但它只是循环通道 + 面板开关，不涉及事件总线；挖掘/脚步/环境音等仍需挂事件，与它不重叠 |
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
| 矿车 Epic 的设计与任务级清单（含偏离 mc-lite 清单，§6）+ 验收报告（实测 / 偏离 / 负向验证 / 踩坑） | `docs/superpowers/specs/2026-09-30-minecart-design.md` + `docs/superpowers/plans/2026-09-30-minecart.md` + `docs/minecart-acceptance-report.md` |
| 太阳阴影（shadow map，独立改动 v1.44）的设计决策（DR-1~DR-8 + DR-4b）与六条偏离 mc-lite 清单 + 任务级实测记录 | `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md` + `docs/superpowers/plans/2026-10-13-sun-shadow-map.md` + `.superpowers/sdd/2026-10-13-sun-shadow-map/`（task 报告与 ledger） |
| 太阳 N·L 方向光与天空盒（独立改动 v1.58）的设计决策、标定推导、三处有意偏离 mc-lite、以及观测口径隔离清单 | `docs/superpowers/specs/2026-10-20-sun-shading-and-skybox-design.md` + `docs/superpowers/plans/2026-10-20-sun-shading-and-skybox.md` |
| 雾色融入天空（独立改动 v1.59）的方向换算规则、开关设计、负向验证盲区（为什么必须有俯视机位用例） | `src/render/fog-sky-direction.js` 的模块注释 + `tests/fog-color.spec.mjs` 头注释 + 设计文档 v1.59 修订说明 |
| 夜空天空盒无缝重烘焙（独立改动 v1.60）的做法与判据口径（为什么必须用「接缝/噪声底」而非裸 RMS、哪些方案被否决） | `tools/bake-night-sky.mjs` 头注释 + `tools/night-sky-fingerprint.mjs` 参数注释 + `tests/night-sky-seam.spec.mjs` 头注释 |
| 性能基线当前值 | `docs/m3-baseline.md`（`npm run bench` 自动生成，勿手改） |
| 测试用例数、图标项数等计数 | **以 `npm run check:data` 输出为准**，不在文档硬编码 |
