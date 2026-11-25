# mc-heavy 第一阶段实施设计文档：游戏引擎原型

> 版本：v2.2 ｜ 日期：2026-10-28 ｜ 状态：定稿（经十五轮逐条核验修订 + M3.2 实施回填 + 异形方块渲染勘误 + 背包物品集合口径 + 吊灯材质自发光 + 吊灯 UV 分区 + 背包图标表 + 等轴测图标 + 测试分级策略与静态门禁 + 全量背包图标离线烘焙 + 背包槽位点选抖动修复 + 等轴测图标遮挡修复 + 删除缓存按钮 + 沼泽睡莲水洞与沉水修复 + AO 去掉对角门控 + 设置面板两列布局与档位精简 + M8 TNT/炮塔的三项架构口径变更 + M9 创造台的两项架构口径变更 + 水面遮罩判据的两项架构口径变更 + 天空树回补与 sky_leaves 通道修正 + 进度包导入导出 + 太阳阴影 shadow map + 阴影混合模型对齐 mc-lite + 阴影纹素对齐与太阳方向门控 + 第一人称手臂与跑动视角晃动 + 晃动幅度上调与手臂挥动对齐原版 + 晃动回调与挖掘挥手时机 + 相机零旋转 + 晃动改距离驱动 + 晃动幅度上调至 0.13 + 步频放慢至 1.5Hz → 1.35Hz + 手臂烘焙面明暗 + 手臂配色对齐 mc-lite 与晃动幅度上调至 0.15 + 太阳 N·L 方向光与 mc-lite 天空盒 + 雾色融入天空 + 夜空天空盒无缝重烘焙 + 夜间雾距统一 + 背景音乐与面板开关 + 光照区域语义修正（blocklight 3×3） + 光照变化的脏 section 传播修正（mesh 依赖集合 / 丢弃重发 / 输入集合校验） + 巨树景观与 opaque 容量 ×1.5 + 巨树叶改 cutout 通道（镂空渲染）与 cutout 容量 2.4M + 光影真实感（ACES 色调映射 / 环境地板 0.38 / 阴影覆盖 ±48 与 1024² / 半球环境光） + Cloudland 高台（新增 apply 阶段 2.75 / 一块沙漠一个） + 高台改用天然岩层与沙漠金字塔概率 ÷3 + 雾色开关默认开启 + 玩家飞行 + 海面配色压深压灰与高光乘算 + 海面配色对齐真实海面（深青绿 / 不透明度 0.92） + 水色转干净海蓝与体素水贴图对齐 + 水色更深更蓝与水体 alpha 提至 0.90 + 台阶亚体素 AO + 资源 URL 部署路径无关 + 高台地带（region 级景观取代沙漠孤立高台） + 云方块改实心（不可穿越） + 设置面板两处合并盒 + 杜鹃树改用 asset_oak 十档烘焙造型 + 杜鹃树干间距与密度面积调整)
>
> v2.2 修订说明：**杜鹃树高矮错落**（2026-10-28，§2 世界生成）—— 用户「要高树和矮树错略相间一些，
> 别一下子高树扎堆，或者矮树扎堆」。**口径**：档位不再独立抽签，改为「类别由 cell 坐标的周期环决定、
> 类别内再随机」—— `AZALEA_CLASS_RING` 长度 10、三类精确 3:3:4，系数 (4,5) 实测标定（同时压低正交与
> 对角相邻的同类率），另加低频相位扰动避免同余线上的斜向同高带。判据取 **8 邻域同类率**（独立抽签
> 理论值 Σp² = 0.34），实测 0.365 → **0.289**；⚠️ **全局三类分布原本就是对的**，只看它会误判成没问题。
> 错落判据**不读邻居**（候选层拿不到 apply 阶段的落树集合，且会循环依赖），故跨 column 仍逐位一致。

> v2.1 修订说明：**杜鹃树叶贴图孔洞率 8%（孔径判据）**（2026-10-28，§4.3 树叶材质）——
> 用户「杜鹃花树的树叶方块镂空感太强烈，参照普通树的树叶，减少镂空感」。**口径变更**：树叶贴图的
> 密度判据从「孔洞**率**」改为「孔洞**块的大小**」—— 同为 15% 时杜鹃叶最大孔块 4px（普通树叶 2px），
> 而杜鹃树冠幅 8~13 远大于普通树 5×5，单层外壳上的大孔直透背后天空（内面被 `opaqueTable=1` 剔掉）。
> 新增 `LEAF_HOLE_RATIO_AZALEA = 0.08`（只作用于两张杜鹃贴图，普通树叶仍 0.15），
> 并首次把 `azalea_flowers` 纳入孔洞压缩（此前它因名字不含 `leaves` 而被门禁清单漏掉、
> 一直指向未压缩原图，导致同一棵树两种稀疏度）。门禁从「区间」升级为「区间 + 带 ratio 的项精确等值」。

> v2.0 修订说明：**杜鹃树干间距 ≥6 格 + 密度 C=13 + AZALEA 面积 ×1.45**（2026-10-28，§2 世界生成）——
> 用户裁定「杜鹃花树容易跟其他树相交混合……树叶可以相交但树干要隔开适当距离」+「密度让树丛像密林」+
> 「地图范围扩大 50%」。**架构口径**：① 间距判据落在**树干列集合**上而非锚点（素材各档 y=0 层树干
> 1~6 列、相对锚点偏 ±2，巨树 1~19 列、偏 ±5 —— 只用锚点实测漏判到 1 格）；
> ② 跨 column 协调必须用**与 column 无关的固定候选全集**（本列 3×3 邻域 region 全部杜鹃候选，
> 按 `(wx,wz)` 规范顺序贪心）—— 按 column 各自贪心时两棵相邻 column 的树各自主张「第一名」，合起来只隔 1 格；
> ③ 「其他树」只含**纯函数可预测**的两类（空岛树基点、巨树树干列），因为阶段 2.85 跑在
> 阶段 2.5/3 之前、那时它们还没写进 column；普通树在 AZALEA biome 恒空。
> **锚点判据与树冠判据分离**：锚点要求 AZALEA biome 陆地，树冠九点只要求「不被地标占住」
> （用同一个严格判据判九点会拒掉 70% 候选、密林落空）。密度 C=16→13，面积 `AZALEA_TEMP_MIN`
> 0.6→0.35（4.6%→6.66%，只吃 PLAINS）。实测最密视域 36 棵、cutout ≈114K（容量 5.2%，零扩容）。

> v1.99 修订说明：**杜鹃树改用 asset_oak 的 10 档烘焙造型**（2026-10-28，§2 世界生成 / §5 目录结构）——
> 用户裁定废弃程序化杜鹃树（`vegetation.js` 的 `azalea` 分支，高 6~8 / 冠 5×5 / 约 34 格），
> 改用 `asset_oak.schem` 杜鹃主题行的 10 档造型（高 12~29 / 冠 8~13 / 223~1352 格），**1:1 原生尺度**；
> 树干换 `azalea_log`、叶子沿用 `azalea_leaves`/`azalea_flowers` 按 **30% 概率相间**。
> **架构口径**：新增 `src/gen/structures/azalea-trees.js`，与 `giant-trees.js` **同构但不复用**
> （巨树是多族多路径系统，硬套会引入无消费的死字段），落位走**全局对齐网格 + 内缩抖动**
> （spacing 10 / jitter 6 → C=16，间距 ≥ 11 由构造保证）。这取代旧实现的
> 「逐格 4.5% 独立抽签」——旧概率是为 5×5 冠幅标定的，新造型冠幅 8~13 会叠成不透光的叶子山。
> 生成层新增 `apply.js` **阶段 2.85**（巨树之后、空中结构之前）；`layout` 加 `azaleaTrees` 字段；
> 旧 `rollVegetation` 的 AZALEA 分支停用（返回空），否则新旧树会叠在树冠里。
> **花叶相间的实现基础**：烘焙把三种叶（oak/azalea/flowering_azalea）全部映射到 `LEAF` 哨兵槽，
> 光栅化时按世界坐标纯函数掷花（跨 column 一致）——**不在烘焙阶段区分花叶**，否则花位被素材作死，
> 与「沿用 30% 概率」的裁定冲突。素材的 `pink_petals`/`short_grass` 装饰丢弃（本仓无这两个方块）。
> 实测：视域内约 13 棵、cutout 顶点 ≈ 50K（初始容量 2.3%，**零扩容**，不动 `CAPACITY`）。

> v1.96 修订说明：**cloud 改 solid=true（云不可穿越）**（2026-10-28，§2 世界生成 / §4.1 方块注册表）——
> 用户裁定「让云变得不可穿越」（多选已确认：只要「不能穿过」这一个后果；Y=55 覆盖率 28~30% 的
> 薄云毯「跳上去被挡住」符合预期）。**改动只有一行声明**（`blocks-data.js` 的 cloud 行
> `solid:false → true`），因为 `solidTable` 是单一权威、六个消费方零代码改动跟着变：
> ① 玩家物理 `_collides`（水平撞云墙 / 向上撞云底 / step-up）② 丧尸物理与站立判据
> ③ **炮塔 LOS + 弹丸阻挡**（`isProjectileOccluding = solid && opaque`，云两项都是 1 → 开始挡
> 视线挡子弹，是最易漏的玩法后果）④ 矿车前方实心与玩家头顶净空 ⑤ 雨滴地面截停
> ⑥ 放置兜底遮挡 / 结构 ground-support 探地。
> **刻意不改**：`supportsPlayer:true` 保留（与 `solid` 是**叠加**关系，可站立语义原样不动；
> 删它会改动向下碰撞的分支组合，属无收益变更）、`opaque`、`shadowCast:false`（云仍不投影）。
> **实测数据**：Y=55 单云层覆盖率 seed 12345 = 28.1% / seed 424242 = 30.3%（400×400 采样）；
> 出生点 City 中心 ±8 格 **0** 个云列、雨幕半径 18 内 **0** 个云列（地面附近体验不变）；
> Y=35 云簇 ±2 region 共 3169 个、其中 695 个落在城市 bounds 内。
> **刻意不做**：`findSpawnY`（`gen/terrain.js:98`）仍会把 Y=55 云毯当「地面」—— 实测默认 seed
> 出生点不受影响，且它是 CLAUDE.md 已记录的既有已知坑，修改会变更 `spawnY` 语义，属计划外。
> **测试**：翻转 3 条「穿云」物理断言（上跳/水平/下落）+ 新增 5 条新语义门禁
> （`solidTable[cloud]` / `isProjectileOccluding(cloud)` / `place-ray` 贴云 / `hasSolidAt(cloud)` /
> 标题措辞）—— 负向验证（改回 `solid:false`）实测 6 条**真 FAIL**。
> ⚠️ 上跳那条的阈值必须落在两侧实测值之间（被挡 **2.2008** / 自由跳跃 **3.0**，取中点 2.6）：
> 写成「< 云底 4」是**无效盲区** —— 自由跳跃的 3.0 也 < 4，注入回退照样全绿（实测确认）。
>
> v1.88 修订说明：**高台地带（Cloudland Tarn Zone）取代沙漠孤立高台**（2026-10-26，§2 世界生成 / §4.3 渲染几何 / §5 目录结构）——
> 用户要求把「每块沙漠一个孤立高台」换成一张 **region 级**景观：水池 + 8 座高台环形分布 + 5 个拱洞
> + 7 个紫晶巨柱 + 4 朵巨型云，每 ~3 个 region 出现一处（`TARN_ZONE_CHANCE = 1/3`）。
> **四项新架构口径**：
> ① **地带判定唯一权威 = `isTarnZone(regionX, regionZ, seed)`**（`src/gen/structures/tarn-zone.js`），
> 六处下游全部调它（候选层 / apply 让路 / 雪原让路 / `pointContext` / 巨树 `allowedAt` / 海面遮罩）；
> `CITY_REGION (0,0)` 恒 false。
> ② **高台/拱洞/紫晶柱全部轴对齐摆放，不旋转** —— `rasterizeStructure` 签名不动。
> 「加 4 向旋转让高台朝心」已被实测否决（档位公式 `(w≤d)?0:1` 与环上角度 θ 无关，
> L3 四角伸出池外 4.44 格）；轴对齐的固有代价是真实间距只有 ~5 格（`TARN_GAP` 旧10 → **4**）。
> ③ **池面平面用 `positionNode` 局部抬升**（`waterY+0.5`），且 `PlaneGeometry` 必须 64×64 分段 ——
> 默认 1×1 只有 4 个顶点，顶点级抬升在池心无处可抬（实测抬 +50 格画面差异仍 0.0）。
> ④ **雪原让路落在 `apply.js` 阶段 1**（不是 layout 层置 null）：`layout.snowLand` 有 6 处既有
> 消费方直接解引用 `.cx`，置 null 会让 28 条既有用例抛 TypeError。
> **容量实测（不扩容，用户裁定）**：transparent 峰值 **114,525 / 125,000 = 91.6%**
> （解析估算只有 78.6%，差因是 mesher 实际发面数受池边缘与台地交界影响）；
> genP95 中位 **8.30ms** < 10ms 门。
> **删除**：`mesa.js` / 烘焙脚本与指纹 / 产物 / 3 个测试文件；`regionLandmarkCenters` 搬到
> `landmark-circles.js`（`giant-pyramid.js` 仍需，不搬会白屏）。
> 细节见 `docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md`（DR-1~DR-14）
> 与 `docs/superpowers/plans/2026-10-26-cloudland-tarn-zone.md`。
>
> v1.87 修订说明：**资源 URL 改为部署路径无关**（2026-10-26，§3 分层 / §5 目录结构）——
> 用户报告仓库挂在子路径下（`http://127.0.0.1:8080/mc-heavy/`）时页面加载不出来。
> **根因**：`src/**` 里 15 处资源引用写成站点根绝对路径（`/assets/...`、
> `/src/workers/world-worker.js`、`/vendor/...`）—— 开头的 `/` 是 **origin 根**而非仓库根，
> 与文档所在路径无关。**新增架构口径**：资源 URL 的**唯一权威 = `src/core/resource-url.js` 的
> `resourceUrl(仓库相对路径)`**，它相对**本模块自己的** `import.meta.url` 解析（只用 `URL`，
> 无 three、无 DOM → 同构层可 import）。两个被否决的替代：纯相对路径按**文档基址**解析
> （fixture 页在 `/src/tests/` 下会 404，这正是当初改成根绝对路径的原因）、运行时探测前缀
> （Worker 里没有 `document`）。`src/render/sky-config.js` 的 `SKY_DIR` 保持**仓库相对字符串**
> 不变（node 侧 `check:data` 用 `path.join(ROOT, ...)` 消费它，URL 转换只在消费端做）。
> 静态门禁：`check:arch` 新增「`src/**` 不得出现站点根绝对路径字面量」（零例外）。
> 实测：子路径部署下游戏页 0 错误 + 16 个 fixture/bench 页 0 错误 + 单测 953/0；
> 根部署全量 spec 零回归；两组负向验证均真 FAIL。
>
> v1.85 修订说明：**水色更深更蓝 + 水体 alpha 提至 0.90**（2026-10-26，§4.7）—— 第四轮实玩反馈。
> 用户「水方块的颜色太浅了，还是变得更蓝一些；远看没被波纹覆盖到的地方几乎呈透明色，还是要有水的颜色，
> 不要那么清晰的看到海底；水波纹的颜色也稍微变蓝一些」。**两个独立问题**：
> ① **颜色偏浅偏青** → 体素水贴图均值 `95/140/168` → `70/115/155`、平面基色 `0x2a5f85` → `0x22598a`、
>    雾色 → `0x6b9cc0`（平面 B−G 33 → **43**）。
> ② **透明度不够**（新发现的一类问题）→ 源图 alpha 175（0.686）时水下地形透上来 31% =
>    「远看几乎呈透明色、能清楚看到海底」；`WATER_TARGET_ALPHA.water = 230`（0.90）→ 透上来降到 10%。
>    ⚠️ **alpha 的失效是静默的**（颜色全对、门禁全绿，只是远看能看见海底）→ `[水体贴图]` 单独钉 alpha。
> 实测：平面近处 `76/123/166` vs 未被平面覆盖的远岸带 `75/125/164` → **逐通道差 6**
> （v1.84 是 17，再前一版 85）。
>
> v1.84 修订说明：**水色转干净海蓝 + 体素水贴图对齐**（2026-10-26，§4.7）—— 第三轮实玩反馈。
> 用户「又太暗了，显得水很脏，稍微再蓝一些亮一些显得干净」+「水方块的颜色和水面差异有点大，
> 让二者接近」。**像素数据支持前者**：v1.83 的 `69/98/107` luma 只有 92 → 浊水观感。
> ⚠️ **三轮反馈不矛盾**：前两轮要「不要白」、本轮要「不要脏」，而**亮度与饱和度是两个自由度**，
> 泛白的反义词不是发暗；参照图是阴天（海区 luma 100）而游戏是正午晴天，直接取其亮度就会脏
> → **可信锚点只有色相**。后者是**新增的一类问题**：海面平面（着色器）与水方块（贴图）是
> 两套独立颜色源，源图是高饱和紫蓝，与平面差 85 → 新增 `npm run water` 烘焙对齐（详见 §4.7）。
>
> v1.83 修订说明：**海面配色对齐真实海面**（2026-10-26，§4.7）—— 两轮实玩反馈的收尾。
> 第一轮用户「波纹泛白，要深一些、灰一些」：根因是**基色 + 纯白高光加法叠加且该项全程非零**
> （平静水面 k≈0.20，不是只在高光斑才加），基色 B 在线性空间已 0.776 → 进 ACES 压缩区 →
> 水区众数峰 luma **187**。改为基色 `0x707f89` + 高光**乘法混色**（有界）→ 148。
> 第二轮用户「还是太泛白，参照这个海的图片」（`/Users/bachi/ttt/bug/海.png`）：**量参照图得
> 海区 67/107/124（G−R +40、B−G +17）⇒ 真实海面是青绿而非蓝**；而上一版是 `133/149/178`
> （G−R 仅 +16、且亮 60 的灰蓝）→ 光「压暗」永远修不到位。三处联动：基色 → 深青绿
> `0x0c342f`、高光 → 偏青绿 `[0.66,0.90,0.92]`、**`WATER_OPACITY` 0.7 → 0.92**（平面半透明，
> 底下蓝色体素水透上来 30%，是「改基色仍泛白」的第二个根因）、雾色 → `0x556e7e`。
> 实测近处水面 177 → 148 → **92**（`67/98/109`）。**这是一处新增的有意偏离 mc-lite**，
> 连同它带出的「`water-visual` 判据两次重写」一并记在 §4.7。
>
> v1.81 修订说明：**新增玩家飞行（创造模式口径）**（2026-10-25，§4.5.1）。
> 用户要求「实现玩家会飞的能力，参照我的世界原版」。键位经用户裁定为 `F` 单击切换（原版双击空格
> 需要 350ms 时间窗，且第一次按空格会先跳，与本仓空格键上的矿车下车边沿检测争键位）；水平速度按
> 「走路 2 倍」取 16 格/秒、垂直 8 格/秒、不设疾跑加速档（均为用户裁定）。落地退出取 **Java 口径**
> （触地即退出，Bedrock 不是）。状态唯一权威在 `PlayerPhysics.flying`，`Player` 只做按键边沿与
> 垂直输入分流。`_stepFlying` 的 `onGround` 必须先清零再移动 —— 「清零 → 移动 → 判 onGround」
> 等价于「本步向下且触地」，不清零会让贴地悬停带着上一步的 `true` 被立即踢出飞行。
>
> v1.78 修订说明：**「雾色」开关默认改为开启**（2026-10-25，§4.4.3 的一条默认值口径变更）。
> 用户要求：「游戏启动的时候默认就开启『雾色』按钮」。
> v1.59 交付时默认关是「默认值 = 旧行为」的通用口径（与 `?shadows=0` / `?skybox=0` 同源），
> 但实玩后天空盒是常态、固定 `0x87ceeb` 的远景反而与照片天空对不上（实测 R 差 54）——
> 融入天空才是正常观感，故翻转默认值。
> **变的是默认值，不是机制**：`uFogColorMix` 仍是 0/1 的 `mix()` 插值，关闭路径完整保留
> （面板「关闭」按钮 + `?fog=0` → 逐位回到 v1.58 的固定色，`fog-color.spec` 的往返用例照旧）。
> 启动时的接线改为**无条件**调 `setFogColorEnabled(this.settings.fogColor)`：材质初值恒 0，
> 所以「关」也不是空操作，两条路径都落到同一个入口；无天空盒（`?skybox=0` / 加载失败）时
> 该方法仍返回 false 并把 uniform 压回 0（**不得谎报生效**，`fog-color.spec` 已钉住「意图是开、
> 但启动时 mix 必须已被压回 0」）。
> **连带修正一处观测口径**：`sun-shadow.spec` 的「远端闪烁」用例（sanity floor 要求采样亮度
> <170，天空≈192）在雾色默认开后读数从 <170 抬到 **170.6** —— 远处平台的雾色不再是固定
> 0x87ceeb。按「只差一个变量」原则给它 pin `&fog=0`，**断言与阈值逐字未动**（改的是被测 setup，
> 与既有 4 份 spec pin `?skybox=0` 同手法）。
> 测试口径：`fog-color.spec` 的四条既有用例显式传 `?fog=0` 取关闭起点（**断言不依赖默认值怎么变**，
> 否则默认一翻就假失败）；新增一条「启动默认开启」用例钉住 默认值 / 启动 mix=1 / 面板 active 高亮 /
> `?fog=0` 仍可关闭；`test-ui.js` 新增 1 条用例（`resolveSettings` 三道入口 + 脏值回落共 6 断言）。
> **旧存档迁移（`migrateStored()`，用户 2026-10-25 裁定）**：`DEFAULT_SETTINGS` 新增
> `settingsVersion`（当前 2），反序列化后、merge 前执行一步迁移 —— **没有版本号或版本 < 2**
> 的旧存档丢弃其 `fogColor` 字段并写上新版本号。
> 为什么不能只改默认值：面板**任何一次**点击都会把**整个设置对象** `JSON.stringify` 落盘
> （`saveStoredSettings(this.settings)`），所以旧存档里的 `fogColor: false` 绝大多数不是
> 「玩家特意关的」，而是「默认值是关时顺带写下的假值」—— 不迁移的话，本次需求对**所有用过
> 面板的人**（包括本次提出需求的人）都不生效。代价：曾特意关过雾色的玩家会被翻回开（存储层
> 分不出这两类，用户已裁定接受），他们只需再点一次「关闭」—— 迁移已写上新版本号，不会重跑。
> ⚠️ 迁移只动 `fogColor` 一个字段（单测钉住视距/画质/背景音乐逐值不变），且 URL 仍优先于一切。
>
> v1.77 修订说明：**两处用户实玩反馈**（2026-10-24）。
> ① **沙漠金字塔（`desertPyramid`）概率降到原来的 1/3**（`OUTSIDE_SCATTER_CHANCE` 0.00016 → ÷3），
> 纯观感标定、非性能代偿；实测 seed=12345 / region ±6 从 **326 → 110** 个。
> ⚠️ 旧断言「`desertVillage` < `desertPyramid`」（大 JSON 更稀）在此**刻意倒置**（pyramid 现在更稀），
> `test-scatter.js` 已按新的实测关系改写 —— 不是删除、也不是放宽数值。
> ② **高台 `BLOCK_MAP` 改用天然岩层**：去掉全部砖块族（`tuff_bricks`/`mud_bricks`/`nether_bricks_1`/
> `stone_bricks`/`polished_blackstone_bricks`，原占 **61.4%**）与木族（`acacia_planks`/`wood`/`birch_log`），
> 改为 `stone`/`clay`/`deepslate`/`stone_diorite`/`cobblestone`/`polished_deepslate`/`mossy_stone`/`iron_ore`
> 的天然明度分层；palette 16 → **11 种**，`moss` 台顶苔藓层按用户要求**不动**。
> 判据落两处（`test-mesa.js` 单测 + `check:data` 的 `[高台]` 环节），用**名字模式**匹配砖/木，
> 不留第二份方块清单（红线 1）。
>
> v1.76 修订说明：**新增 apply 阶段 2.75「Cloudland 高台」**（2026-10-24，§4.2）。
> 素材 `~/Downloads/CLOUDLAND` 的 `Landscape/9`（20×43×21、10,712 方块）经离线烘焙成
> `assets/structures/cloudland_mesa_small.json`（palette + 扁平数组格式，`structure-json.js`
> 两种形状归一化），落点为**每块沙漠至多 1 个**（`MESA_MIN_SPACING=384` 邻域去重，实测沙漠连通块
> 最大跨度 368 格）。层序插在撒布结构（2.7）之后、巨树（2.8）之前 —— 巨树有 `allowedAt` 可避让。
> 方块全部映射到既有 registry（16 种，全 opaque 通道），**零新增方块/贴图/图标**，不动任何容量常量。
> 设计文档：`docs/superpowers/specs/2026-10-24-cloudland-mesa-design.md`。
>
> v1.75 修订说明：**新增环境风格「傍晚」（第四种视觉风格）+ 色温管线**（2026-10-24，§4.4.3）。
> 起因：用户要求「增加一个环境风格『傍晚』，天空盒就用 mc-lite `skyBox2`……根据图里的傍晚色调调试出一个
> 温暖的傍晚，阳光的色温也调成傍晚合适的色温，光影效果也适合于傍晚的氛围。设置面板中的傍晚按钮放在正午
> 右边。**只增加环境风格，其他逻辑不要做变动**」。
> **四处口径变更**：① **天空从两张立方图扩成三张**（`mix(mix(day,night,uNightBlend), dusk, uDuskBlend)`，
> 雾色采样同步 —— 否则开「雾色」时雾是白天色、天是傍晚色）；② **新增色温管线**：`uSunColor` / `uAmbientColor`
> 两个 uniform，`sunTerm` 从标量变逐通道（环境项吃环境色、直射项吃直射色）；③ **`nightBlend` 可由风格数据
> 显式指定**（dusk 的 `skyDim 0.78` 会让派生公式倒算出 0.293 → 天空混进 30% 星空）；④ 设置面板「环境风格」
> 增加第四个档位（`dusk` 紧挨「正午」右边）。
> **载荷性约束（后续改光影/天空必读）**：
> · **中性色温必须逐位回到 v1.70**：三种既有风格的 `sunColor`/`ambientColor` 恒 `[1,1,1]`，`sunTermFor`
>   退化成 `sunTermRGBFor` 的中性白 R 通道（不留第二份公式）。`sun-darkness` 的冻结比值 0.549 实测不变。
> · **`dusk` 不参与自动日夜循环**：`KEYFRAMES` 一行未动 → 循环里 `duskBlend ≡ 0`。用户只要求「增加一个
>   环境风格」，不是「日夜循环多一个时段」。
> · **判色相必须用屏幕口径**（`srgbEncode` + `acesFilmic`，与 GPU 同公式）：线性比值与观感差一个数量级
>   （同 `shadow.radius` 的既有教训）。
> · **`uniform(new THREE.Vector3())` 的 `.value` 没有 `setRGB`**（那是 `Color` 的方法）——写成 `.setRGB()`
>   会让**整个游戏页白屏**，而 stub 单测测不出来（fake 盲区）。
>
> v3.40 调研记录：**阴影缺陷未修复；本轮全部源码改动已回退（源码 = HEAD）**（2026-11-25，§4.4.4）。
> 起因：用户「一棵树就在玩家眼前，跑动的时候一会有影子一会没有影子」+「移动到某个位置突然
> 整个沙漠上全都是阴影」+「身边的影子不应该随移动变化，要刷新也只是刷新视野边缘处的物体」。
>
> ☠️☠️ **本轮引入两处真回归，用户实玩证伪后已全部回退**：
> ① **把光源沿 dir 分量钉死在首次定位锚点**（`depthStableCenter`）会把阴影深度推出远平面。
>   沿 −Z（用户实际走的方向）实测同一固定世界点 `shadowCoord.z`：HEAD 恒 **0.20774**，
>   改动后 100/200/300/400 格 ⇒ **0.4078 / 0.60787 / 0.80794 / 1.008**；lightDist 60→120/180/240/300。
>   `z>1` ⇒ VSM `frustumTest`（要求 z≤1）失败 ⇒ `shadow()` 恒 1 ⇒ **整片明暗错乱、树影消失**。
>   ⚠️ **DR-4 的既有设计「光源 = 玩家位置 + dir×60」是载荷性的**：它保证光源到玩家的距离恒 60，
>   从而深度分布始终落在 near 0.1 / far 300 的中段。**不得把沿 dir 分量钉死**。
> ② **新增「新 section 发布 → request()」在奔跑时疯狂触发**：同一条 200 帧冲刺，
>   request 次数 HEAD **18** vs 改动 **134**（7.4×）—— streaming 几乎每帧发布 ⇒ 几乎每帧请求。
>   ⚠️ DR-5 的三个请求源都以「低频事件」为前提；streaming 是**高频持续事件**，不能直接挂 request。
>
> ☠️☠️ **验证为什么没抓到（最该记住的一条）**：探针一直沿 **+X** 走，而
> `sunDir=(0,0.8,0.6)` 的 **X 分量是 0** ⇒ 那条路径根本不经过被改动的深度轴。
> 于是「zSpread=0 / flips=0 / 13/13 全绿」全部取自一条 **bug 无法出现**的路线。
> **改动的轴与夹具的运动轴必须对齐**，否则绿灯毫无意义。
>
> **已证实但未解决的机制（③）**：相机 XY 平移使同一固定世界点采到 **6 个不同纹素**
> （503→526→552→578→603→629）。VSM 模糊邻域（radius 2.6 纹素）在不同纹素上覆盖不同几何
> ⇒ `mean` 变 ⇒ `step(z,mean)` **间歇**翻转（数据相关，故用户说「时有时无」）。
> 试过的粗格吸附 cell=64 入生产后**同时**打破既有门禁（target 停在玩家 6.06 格外，容差 0.153）
> 且仍 2 次翻转 ⇒ 亦回退。③ 需要「保持已投影内容纹素映射不变」的相机投影策略，
> 且必须同时满足「相机覆盖玩家所在几何」，不是格长/频率这类参数能解决的。
>
> **另有三条假设被实测推翻**：矩阵上传时序（**测量伪象**：在 `renderer.render()` 入口读矩阵
> 而 GPU 未上传；正确口径 = `_bindings.updateForRender` 之后读 `uniformsGroup.values`，desync 恒 0）、
> 方向门控不同步（那轮 `cycleSeconds=120` 比默认 1200 **快 10 倍**）、
> 刷新间隔（**是现象不是根因**，用户当场驳回「治标不治本」）。
>
> **回退后验证**：z 恒 0.20774 / lightDist 60 / requests 18（与 HEAD 逐项一致）；
> `check:arch` ✓、lint 0 error、Node 31 例 ✓、`sun-shadow.spec` **11/11**；
> `src/` 与 `tests/` 的 git diff 为空。详见
> `.pi/plans/2026-11-25-shadow-matrix-desync-and-upload-refresh.md` 与 `pitfalls.md` 两节。
>
> v3.39 修订说明：**阴影覆盖 ±48 → ±96（贴图仍 1024²、far 仍 300）**（2026-11-25，§4.4.4）。
> 起因：用户实玩反馈「阳光阴影有一定的生效距离，会导致阴影一会有一会无，跟着玩家扫过大面积
> 的地形，就很奇怪」。**根因就是覆盖半径**：正交阴影相机只在 ±E 的方盒内采样，盒外没影子。
> 实测（12 组）：影子实际到 ±48→**30 格** / ±96→**90 格** / ±144→120 格。
> **选 96 而非其它值的依据**：雾区间 = `[vd×16×0.75, (vd+2)×16×0.95]`，vd=8 默认 → 96~152 格，
> ±96 的边界恰好压在雾的起点（再往外看不到硬边）。
> **成本实测几乎为零**（交替对照各 3~5 轮，包装 `renderer.render` 提交计时）：刷新帧 1.1→1.4ms
> （城市）/ 1.3→1.7ms（几何最密处），摊到每帧 **+0.017ms ≈ 帧预算 0.2%**；稳态帧逐位不变。
> 阴影视锥内实例涨 2.7~3.3× 而耗时只涨 30% —— 成本由 VSM 固定开销（两份模糊 pass）主导。
> ⚠️ **降贴图分辨率换取更大范围这条路已实测否决**：±96/512²、±144/512²、±192/512² **全部
> 测不到影子**（影区/开阔区比值 0.886 / 0.992 / 0.992）。VSM 的 `radius` 单位是**纹素**，
> 512² 下 ±144 的一纹素 0.563 格，半影宽度比被测石柱本身还宽 ⇒ 影子被糊掉。
> ⚠️ **远端闪烁用例（`sun-shadow` 用例 9）在 ±96 下判别力下降（已登记为已知缺口）**：
> 它的夹具靠手动推远光源把平台移出阴影视锥，但推远后 `onBeforeShadow` 根本不被调用
> （整块平台被完全剔除 ⇒ 覆写无从发生）⇒ 三点 sd=0 是「什么都没发生」而非「守卫生效」。
> 多种注入方式（源级开关 / 实例替换 / 不推远）均未能复现闪烁，**未得到真红**。
> 该用例仍保留（它至少验证了接线与不回归），但**不得据此断言「守卫仍被有效覆盖」**。
>
> v1.70 修订说明：**光影真实感 —— ACES 色调映射 + 环境地板 0.5→0.38 + 阴影覆盖 ±30→±48 / 贴图 256²→1024² + 半球环境光**（2026-10-24，§4.4.3 / §4.4.4 / §4.6）。
> 起因：用户实玩反馈「光影效果有些平淡，阳光或月光在场景中的体现不太多」+「减少一点卡通感，增加一些真实感」，
> 并给出参考图（电影感色调映射 + 强方向光 + 长影 + 天空/地面反射的光照差异）。**用户明确追加范围约束：
> 只改颜色与光影，地形生成/结构高度等游戏逻辑一律不动。**
> 实测根因三层，互相独立：① **无色调映射**（线性亮度直接过 sRGB 传递函数 → 高光削顶 **0.44%**、暗部挤在低端）；
> ② **太阳项动态范围不足**（`sunTerm ∈ [0.5, 1.0]`，背光面恒有满亮面一半亮度）；③ **阴影几乎不可见**
> （±30 格覆盖 + 0.234 格纹素 → 真实场景开/关阴影的整屏差异只有 **1.19% 像素**）。
> 四项落地（均有实测标定，详见 `docs/superpowers/specs/2026-10-24-lighting-realism-design.md`）：
> ① `renderer.toneMapping = ACESFilmicToneMapping` + 每风格 `toneMappingExposure`（morning/noon **1.0**、
> night **1.6**，由 `DayNight._apply` 单一收口写出，风格间线性插值）；② `SHADOW_FLOOR ≡ SUN_AMBIENT`
> **0.5 → 0.38**，`SUN_INTENSITY` 派生值自动 → 0.775（**零回归不变式 `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0`
> 保持不变**，即正午顶面方向光项仍是 1.0）；③ 阴影相机 ±48 / 贴图 1024²（纹素 0.234 → **0.094 格**，
> 覆盖 60 → 96 格；**v3.39 已再扩到 ±96 / 覆盖 192 格、纹素 0.188 格**，见上方 v3.39 修订说明）；④ **半球环境光**：新增 `src/render/hemi-shade.js`（three-free 纯函数，`HEMI_GROUND = 0.6`）
> → `materials.js` 的 `uHemiGround` uniform + `vHemi` varying，朝上 1.0（与现状逐位相同）、朝下 0.6。
>
> **三处有意偏离 mc-lite，不属被否决项回滚**：
> · **ACES 否决被推翻**：v1.58 的 spec §7 曾以「用户否决」为由不移植 ACES → v1.70 用户重新拍板，**该否决作废**。
> · **noon exposure 用 1.0 而非 mc-lite 的 1.25**：实测 1.25 会把天空冲到近纯白、云层细节丢失（mc-lite 是受光材质、
>   光照强度基准不同 —— 「移植上游参数前须检查它是否在补偿另一个差异」的又一实例）。
> · **morning exposure 用 1.0 而非 mc-lite 的 1.35**：1.35 会把 `skyDim 0.8` 的晨昏变暗**完全抵消**
>   （实测 |morning−noon| 从 **0.0609 塌到 0.0036**）→ 晨昏感必须由既有 skyDim/天空色表达，不靠曝光重复表达。
>
> **载荷性约束（后续改光影必读）**：
> · `shadow.radius` 是 **纹素单位** —— 贴图 256²→1024² 后同样的 2.6 只相当于原来的 ~1 纹素，半影窄 2.5×。
>   **用户拍板保持 2.6**（更硬的影子更像日光）；若实玩觉得生硬，处置是按比例升到 ~6.5 的单次标定，
>   **不得把阴影覆盖改回去**。
> · 半球因子**只乘 skylight 项、不乘 blocklight**，且**与太阳无关**（`uSunStrength = 0` 时仍生效）——
>   接进太阳项会让「关掉方向光 → 半球差异一起消失」且夜间朝下面不暗。
> · 地板值改动会**连带改变影区亮度比值**：`sun-shadow.spec` 的冻结值 0.735 按新实测 **0.549** 重标，
>   且**保留双侧断言**（上界 0.72 / 下界 0.40）—— 只钉上界抓不到「影区纯黑」（v1.45 教训）。
> · 纹素尺寸类判据**必须从 `shadow.mapSize` / `shadow.camera` 读配置**：`sun-shadow.spec` 的纹素对齐用例曾硬编码
>   `c * 256` 算相位，改 1024² 后得到只取 0/0.25/0.5/0.75 的**假相位**（实测 phaseSpread 0.75 而亮度 spread 恰为 0）。
> · **ACES 会改变所有像素**：涉及绝对亮度/对比度的断言须按 sRGB 口径重算理论值域（旧「1.286~1.347」是
>   0.5 地板 + 无色调映射时代，已作废；含 ACES 后实测方向光对比度 1.847、理论值域 1.83~2.24）。
>
> v1.69 修订说明：**巨树叶由 opaque 通道改走 cutout 通道（用户裁决 2026-10-23）；随后全部树叶 opaqueTable=1，cutout 容量回退 2.20M**。
> 起因：用户实玩反馈「巨树树叶都不镂空、表面完全不透光」。**贴图本身早就是镂空的**（与 `leaves.png` 逐像素同构：
> 13 个 a=0 + 67 个半透明 + 176 个实心），根因是 `cullMode:"opaque"` → opaque 通道材质 `alphaTest=0` → alpha 被完全忽略。
> 修法 = `cullMode:"cutout"`（拿到 `alphaTest 0.3`）+ **显式 `"opaque":true`**（保住 `opaqueTable=1`）。
> 
> **两套口径分离是载荷性的**：`cullMode` 选渲染通道（决定镂空），`opaque` 决定 `opaqueTable`（决定面剔除/AO/
> blocklight/炮塔 LOS）。实测同一片 8³ 叶团总顶点：纯 opaque 1584 / **cutout + opaqueTable=1 → 1584（零增长）** /
> cutout + opaqueTable=0 → **12316（×7.78）**。故漏写 `opaque:true` 是静默的容量灾难（巨树叶占巨树方块量 80.6%）。
> 
> **验收口径变更（重要）**：A/B 严格对照（只改 leaves 声明）实测 5 个固定视域的**总顶点逐位守恒**
> （3,478,025 / 4,810,025 / 3,831,985 / 3,233,170 / 3,192,705 前后完全相同）—— 纯通道搬运，零额外顶点。
> 但两通道容量基数不同（opaque 4.275M vs cutout 2.2M，差 1.94 倍），同一批顶点搬过去后百分比被放大，
> 逐通道判据会误报（实测曾误判为「(-25,-5) 超线 6.7 点」，实际该视域总量分毫未变）。
> 故 `tests/giant-tree-budget.spec.mjs` 的主判据改为 **总顶点**（与通道归属无关），逐通道只留
> 「cutout 不得扩容」「transparent 不比 HEAD 更糟」「opaque ≤ 90%」。
> `CAPACITY.cutout.active` 曾因巨树叶改道抬到 600（2.40M），**同日又回退为 550（2.20M）** ——
> 因为用户随即裁定「**普通树叶的 opaqueTable 也设为 1**」：全部 14 个树叶族都变成叶-叶共享面互剔，
> cutout 占用大幅下降（5 视域实测峰值 35.1% → 回退后 38.3% = 842,400 顶点，零扩容）。
> 三通道静态合计回到 **188.83 MiB**（(4.275M+2.20M+0.125M)×30B）。
> 原文「巨树只把旧森林树的 cutout 叶替换成 opaque 叶，cutout 只降不升」**因本次换道失效**，作废。
> 门禁与单测同步：`[巨树]` ⑤ 改为「必须是 cutout 且 opaqueTable=1」双向钉死；
> `test-giant-trees.js` 新增 2 条（通道契约 + 顶点守卫，前者防通道错、后者防漏写 `opaque:true`）。
> ⚠️ 顶点守卫的初始写法有盲区（对照侧也读被测声明 → 两条路径都不剔除 → 仍相等 → 注入后仍绿），
> 负向验证拓出后改为对照侧**强制写死 `opaqueTable=1`**，注入实测得 `12316 vs 1584（差 10732）`真红。
>
> v1.68 修订说明：**巨树景观 Epic —— opaque 通道容量 ×1.5，§4.10 的 150MiB 冻结预算有意上调到 188.83 MiB（v1.69 中途曾到 194.55 MiB，最终回退 188.83，见上节）**
> （用户裁决 2026-10-23；规格 `docs/superpowers/specs/2026-10-23-giant-trees-design.md` v1.1 §0.2 / DR-10 / DR-17）。
> 引入 28 个原版景观树变体（森林 / 海边 / 草地沙漠交界三条落位路径；树叶 `opaque` 且投影 —— **v1.69 起改为 cutout 通道，仍 `opaqueTable=1` 且投影**）。opaque 叶使 opaque 通道
> 在密林视域的 reserved 占用抬高：终版参数在原容量 2.85M 下折算 (-20,10) 视域 105%、森林冲刺 123%（→ 必然 ×1.5 扩容），
> 抬到 4.275M 后最高 82.1%（零 opaque 扩容）。
> ⚠️ **口径修正**：容量判据是 **reserved**（= 1.25 × 已用顶点，`render-world.js:204`）相对**初始**容量常量，不是已用占比
> （Node 侧「注入树 + 真 mesher」得到的已用占比比真实页面系统性低 1.20~1.24 倍）；HEAD 自己在密林视域就越线
> （cutout 128.1%、森林冲刺 cutout 145.4% / transparent 140.8%，会触发 ×1.5 扩容），所以验收口径写成「真实页面 reserved：
> opaque ≤ 90% 且零扩容；cutout / transparent 相对 HEAD 不恶化」，而不是「任何视域都不扩容」。
> 变更点：`CAPACITY.opaque.active` 1200→1800（maxVerts 2.85M→**4.275M**）；三通道静态顶点缓冲
> `(4.275M+2.20M+0.125M)×30B = 198,000,000 B = 188.83 MiB`（原 148.06 MiB；`memoryStats().gpuVertexBytes` 实测同值）；
> `tests/m3-fullscene.spec.mjs` 的 `gpuVertexBytes` 上限 150→200 MiB（188.83 + 一次 transparent 扩容的兜底余量）。
> ⚠️ 原文「cutout / transparent 容量不变（cutout 只降不升）」**已被 v1.69 作废** —— 见下节：巨树叶由 opaque 改走 cutout。
> 新增模块（Worker 同构）：`src/gen/structures/giant-trees.js`（region 层「全局对齐网格 + 内缩抖动」候选 +
> column 层合并邻域候选 / 排除 / 光栅化 / 地基 / 覆盖窗口）；离线烘焙 `npm run gianttrees` / `npm run gianttextures`；
> 新门禁 `check:data` 的 `[巨树]`。已有存档里的森林会长出巨树（用户接受，不 bump DB 版本）。
> `bench --check` 的 `STRUCTURAL` 分支恒为 false（GPU 预算不会被它拦下），故由 `m3-fullscene` 与 `giant-tree-budget` 守。
>
>
> v1.65 修订说明：**光照变化的脏 section 传播修正**（v1.64 之后用户复测：「还是没有彻底修复，灯光还是有
> 明显的边界」+「把灯删除后，刚才被照亮的方块面不变暗」）。真游戏页对照（只差一个变量逐层缩小）实测：
> **light 数据层已完全正确**（整图参考 BFS 对比 0 个格子不一致，光确实越过了边界），问题在**派生的网格层**
> —— 实际上传的网格有 6 个 section 是旧的。三处独立缺口（按发现顺序）：
> ① **脏标记只给「light 字节真变了」的同 sy 置脏**（v1.64 引入）。mesher 对 section S 的 light 依赖 =
> **S 自身 16³ + 六个面外各 1 格厚的 halo**（faceLight 读面外邻格；模板方块读自身格；棱/角 halo 格只读
> blocks 算 AO、不读 light）。地表恰好在 section 最上层（y=-1 的沙滩）时，顶面读的是 `sy+1` 最底层的
> 那一格 —— 那格变了，地面所在 section 没人通知 → **放灯后一部分地面不亮（边界 = column 边界）、
> 删灯后被照亮的面不变暗**。修法：新增纯函数 `lightDirtyMasks(prev,next)`（`lighting.js`，Worker 同构），
> 返回「本列 self（含 ly=0/15 时的上下相邻 section）+ 4 个**正交**邻列（只在 lx/lz∈{0,15} 时）」的掩码，
> `_onLightResult` 按掩码置脏；对角列不依赖本列 light，不再置脏。**它与 mesher 的 light 采样规则是一对耦合
> 约定**，单测用 pocket 世界做「预测集合 == mesher 实测变化集合」的交叉比对（将来 mesher 改平滑光照会立刻红）。
> ② **在途 mesh 回包因同 column `version++` 被丢弃后无人重发**：该 section 的脏标记在派发前已被
> `takeDirty` 消费 → 数据对、画面旧（真游戏页确定性构造 3/3 复现）。版本协议丢弃的是**结果**，不是这份
> **工作**：`_onMeshResult` 与 `_processUploadQueue` 两处丢弃点都把该 section 重新置脏（与 `_onLightResult`
> 「丢弃并重新入队」同一语义，不是 epoch/防抖补丁）。
> ③ **light 回包只校验输入列的版本、不校验输入列的集合**：在途期间 3×3 里新到达的就绪列不在 `inputs` 里，
> 版本比对看不见它，而它到达时的 `enqueueLight` 又因本列「在途」被跳过 → 永远缺它的光。`_onLightResult`
> 补第三层校验（3×3 内现已就绪但不在 `inputs` 的列 → 丢弃并重新入队）。
> 实测：`lightDirtyMasks` 每次约 0.02~0.04ms（每次写回一次，每帧至多一次 light 任务，远低于 1ms/帧光照预算）。

> v1.64 修订说明：**光照区域语义修正**（用户实玩报告「灯光有边界」）。v1.63 及之前
> `computeBlocklightRegion` / `computeSkylightRegion` 的 column 集合只取「中心 + 4 正交邻居」
> （5 列），而 blocklight 强度 15、每格 -1、最远照 **14 格**，column 边长 16 →
> 正交邻居最近格距本列边缘 1 格、**对角邻居 2 格（两者都必须参与）**，隔一列已 17 格
> （贡献恒 0）。正确区域恰好是 **3×3**，plus-5 漏了 4 个对角列 —— 全量 BFS 作真值实测
> 最大误差 **10 级 / 982 格错**。同时修掉的第二处：`enqueueLight` 只入队编辑所在列，
> 而写回只写中心列 → 灯的邻居列永远没有自己的 task（入队范围与写回范围**不相等**，
> 这是载荷性的不对称）；以及 `_onGenResult` 对「3×3 内有 emissive」的列补入队
> （结构性光源没有编辑事件）、写回前校验 **region 全部输入列**的版本（邻列 blocks 变了
> 但中心列 version 没动的情况，中心列校验抓不到）。区域重算改 3×3 后实测 RPC 往返
> （9 列 7.8ms / 0.59MB 入）并不高于原 5 列口径，编辑 p95 仍 1.70ms（门禁 < 2ms）。
>
> 目标：在 mc-heavy 仓库从零重建一个功能对标 mc-lite、性能提升一个数量级的体素游戏引擎。
> 第一阶段只做"引擎底座"：渲染、体素数据、即时地图生成、玩家交互、种子地图、存档原型。
> 矿车、炮塔、丧尸、TNT、创造台等功能在引擎稳定后按阶段加入（本文档第 9 节给出扩展点设计）。
>
> v1.1 修订说明：依据对 mc-lite 实际代码的逐条核验，修正了渲染发布粒度（§4.4.2 改 column 级合批）、
> 跨 region 结构溢出（§4.2 邻区索引查询）、结构布局缓存（§4.2 布局单点计算广播）、
> section 边界依赖生命周期（§4.3）、skylight/blocklight 模型（§4.6），并补齐内存预算（§4.10）
> 与若干数字勘误（方块 124 种、纹理 122 张、Worker 8 个、blockData 现状结构）。
>
> v1.2 修订说明：修复合批机制的 draw call 陷阱（§4.4.2 明确 channel-major 3-group 布局与
> 变长 slot 打包策略，引入 BatchedMesh/sector 候选与 M1 决策门）、内存数字自相矛盾
> （§4.10/DR-8 统一为 128KB/column）、skylight 边界声明错误（§4.6 纯垂直模型不含水平依赖），
> 以及 halo 协议内外圈矛盾、normal 编码定死、布局计算移出主线程等收尾勘误。

> v1.3 修订说明：发布层选型反转——经 r185.1 源码核验，`BatchedMesh` 走 GPU multi-draw
> （一个 BatchedMesh 内 N 个 geometry 合成 1 次 GPU draw），且 `reservedVertexCount`/
> `setGeometryAt`/`setGeometrySize` 官方 API 原生覆盖了 v1.2 手工设计的 slot 打包机制，
> 故候选 B（BatchedMesh）升为默认实现、候选 A（column 3-group）降为 fallback（§4.4.2/DR-11/M1）。
> 补齐三个边界定义：transparent 通道静态排序策略（§4.4.1）、卸载滞回 + 重入 LRU 缓存
> （§4.9/§4.10/DR-16）、边界方块编辑的最坏重建范围（§4.5.3）。收尾勘误：`updateRanges` →
> `addUpdateRange()`（r185 实际 API）、顶点格式改 24B 对齐、blocklight 重算覆盖邻 column。

> v1.4 修订说明：权威数据源补齐**方块实体（block entity）通道**——宝箱库存、告示牌文字、
> 灯开关等富状态无法塞进 8bit meta，mc-lite 已有 `_saveChestStates()`（ChunkConsolidation.js:597）
> 证明该需求真实存在。§4.1 ChunkColumn 增加 `blockEntities` 稀疏 Map，§4.5.3 edits 条目扩为
> `{id, meta, blockEntity?}`，§4.8 持久化携带，§9 床/宝箱/门改指向 block entity 通道，
> 新增 DR-17。同时澄清 light 数组是**可从 blocks+emissive 重算的派生缓存**而非 gameplay 真相
> 来源（§4.1）。本阶段只预留通道，不实现任何消费者。

> v1.5 修订说明：对 v1.3 引入的 BatchedMesh 发布层做逐行源码核验，修正 4 处实现级
> API 语义错误——① 补齐 geometry+instance 两层结构（漏掉 instance 层会不渲染，
> §4.4.2）；② 纠正溢出处理：`setGeometrySize` 是整批重建/收缩且会 throw，非单 slot
> 扩容，正确路径为 deleteGeometry→addGeometry→addInstance（§4.4.2）；③ 补构造函数
> 容量预估口径（视距 8 = 2312 slot/通道）；④ transparent 排序默认路径改用 BatchedMesh
> 内置 `sortObjects` 运行时逐 section 排序，静态排序降级为 fallback 候选 A 专用（§4.4.1）。

> v1.6 修订说明：纠正 v1.3 的核心口径错误——经 WebGPUBackend.js:1806-1824 源码核验，
> r185.1 的 **WebGPU 后端对 BatchedMesh 不走 multi-draw**（JS 循环逐可见 instance 发
> drawIndexed；renderMultiDraw 只在 WebGL 后端），「3~9 次 GPU draw」口径删除，选型理由
> 重写为「draw 数量同量级、单命令成本低一个量级 + 剔除/排序/增量更新官方内置」（§4.4.2/DR-11）。
> 三处实现级修正：① 构造容量公式改为「预期活跃非空 section 数 × 平均顶点数 × 1.25」
> （v1.5 按全部 2312 slot 会数倍过度预留显存至 ~555MB/通道），运行时用 unusedVertexCount
> 监控；② 顶点格式由 interleaved 改 flat 三属性（避开 copyAttributeData 的 interleaved
> 慢拷贝路径），packed 必须 uint32（WebGPU arrayStride 须 4 字节倍数，uint16 会 validation
> error；flat 化收益是拷贝快路径而非省显存，每顶点仍 24B）（§4.3）；③ 删除「构造函数支持
> 多通道」误导（BatchedMesh 无 groups，传材质数组零 render item）。候选 A draw 数纠正为
> 固定 ~867（`_projectObject` 不看 group.count，v1.5 的 300~500 低估）。M0 新增两项
> BatchedMesh 120fps 风险点实测（逐 instance 剔除/排序 CPU 循环、setGeometryAt 端到端耗时）。

> v1.7 修订说明：两处依据实测的勘误。① atlas 贴图尺寸口径修正（§4.4.1）：mc-lite 的
> 122 张纹理实际分布为 113 张 16×16 + 2 张 32×32 + 7 张 250~362px 特殊几何/实体贴图
> （handrail/pillar/turret/zombie_nest 等，PIL 实测，不存在 64×64），大图打包时按
> 128×128 入图（2048² atlas 余量充足，缩到 64×64 会破坏 M2 结构轮廓/配色验收）；
> ② 无头 WebGPU 环境实测
> （§8）：本机（macOS ARM，Chromium 151，playwright 1.62.1）实测矩阵——完整 Chromium
> 新无头模式（`channel:'chromium'`）**零 flag 即走 Metal 拿到 adapter**，而 Playwright
> 默认的 headless shell 零 flag 拿不到 adapter；SwiftShader 组合（`--enable-unsafe-webgpu`
> + `--use-angle=swiftshader`）为 Linux CI 兜底；`--enable-features=Vulkan` 在 macOS 上
> 无作用，已从测试配置删除。

> v1.8 修订说明：skylight 模型与 light 任务写回协议勘误（§4.6/DR-14）。① 模型升级同步：
> 纯垂直模型在实玩中不可接受（任何高处实心方块把正下方整列截断为 0 → 悬挑/上凹角全黑），
> 已升级为 Minecraft 同款「垂直落下不衰减 + 水平 BFS 每格 -1」，区域 = 中心 column +
> 4 正交邻居，编辑快路径保留垂直单列做即时反馈（只升不降），水平扩散交异步 light 任务收敛。
> ② **写回协议改为中心 column 权威**：旧实现把区域结果写回全部 5 列（last-write-wins），
> 但每个 task 的 region 所含光源不同（如房屋东窗的光源在 D 列，A 中心 task 的 region 不含 D），
> 后到的「region 不完整」task 会先清零低/高 4 位再用不完整光源重算，覆盖邻列已收敛的好光
> → 实玩偶现大片全黑面 + 黑核周围一圈圈截断渐变（dispatch 顺序随计时变化 → 偶现）。
> 5-column region 对**中心列**充分（15 的光水平最远影响 14 格 < 16），故每列 light 只由
> 以它为中心的 task 写回；邻列只参与计算、不写回，仅置脏重 mesh 收敛边界脸。

> v1.9 修订说明：**第一阶段不实现阳光遮挡投影**（产品决策，实玩验收驱动）。
> v1.8 的 Minecraft 式遮挡阴影在实玩中不可接受：大悬空平台/洞穴下方超过扩散距离
> 就是大片全黑 + 截断渐变环，与 mc-lite 视觉基线（无体素阳光阴影、仅 AO 墙角阴影）
> 冲突，用户明确不要阳光投影效果。故第一阶段 skylight 恒 15（`computeSkylightColumn`
> 不遮挡），视觉明暗只来自 **AO 墙角阴影 + 日夜全局调制**；blocklight 数据管线与
> light 任务/中心权威写回机制**完整保留**（遮挡原实现保留为
> `computeSkylightColumnOccluded`），后续阶段启用阴影时切回（§4.6/DR-14）。

> v1.10 修订说明：登记第二阶段首个独立 Epic **M4 玩家第一人称武器**。M4 不改变
> 第一阶段 M2/M3 的编号、范围或冻结验收；它在 M3 性能报告验收后，以 `WorldEditor`、DDA
> hitscan、受控 GLB 视图模型为垂直切片落地（§4.5.3/§9）。详见
> `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md` 与
> `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`。

> v1.11 修订说明：M4 后的实体路线拆为 M5 实体运行时、M6 丧尸、M7 玩家放置丧尸巢穴。
> 巢穴不是确定性地标：其蓝图最高 `gold_block`（而非只作放置触发的
> `zombie_nest_alias_block`）上的锚点 `blockEntity` 为持久真相，运行时控制器订阅 `WorldEditor`
> 的 `block-changed`，故徒手、武器和 TNT 均可使关键方块破坏立即失效。

> v1.12 修订说明：M5–M7 规格与计划按 mc-lite 逐项复核后收紧。M6 固定为“追逐、受武器
> 伤害、死亡回收”的临时敌人：默认上限 20，手枪/加特林/MAG7 的实体伤害与射程分别为
> `25/40`、`35/40`、`999/10`，无 `PlayerVitals`、近战、死亡/重生；AI 为 20Hz 单条批量 WorkerPool
> RPC，60 格外只冻结 AI。M7 的刷怪搜索明确为八个精确 offset、`dy=3..-2` 的六层；GEN 接管必须
> `restoreEdits()` 同时恢复 blockEntity 与内存 edits，防止后续 flush 覆盖旧存档。玩家生存战斗
> 保持独立后续 Epic（**v1.16 勘误**：本句原写「背包、完整 Hotbar 与玩家生存战斗均保持独立
> 后续 Epic」，与 §4.5.4 冲突；背包与完整 Hotbar 已定稿归 M3.1，推迟范围收窄为生存战斗与
> 物品消耗规则，详见 v1.16 修订说明）。

> v1.13 修订说明：M5 的持久实体卸载改为可取消的两阶段协议，以修正 Scheduler 同帧同步
> `world.remove()` 与 IndexedDB 异步写入不能排序的矛盾。column 超过卸载半径后仍保留 world/render，
> 先冻结持久实体并保存 snapshot；仅在保存成功后的下一帧、且仍超界时，才同步释放实体并删除 column。
> 保存失败或玩家重入均取消并解冻，禁止静默丢失；pending 状态只保存卸载生命周期，不复制体素数据。

> v1.14 修订说明：M2 增补 **M2-7 空中结构（悬浮空岛与云层）**，补齐此前从 mc-lite 漏列的
> `world/entities/Island.js` 与 `Cloud.js` 语义。它们是静态、seed 驱动的体素结构，归入
> StructureIndex + Worker GEN + column 裁剪管线；禁止复活 mc-lite 的 `structureCenters`、跨 chunk
> 补刷或运行期实体容器。保留空岛的 8% chunk 候选、Y=40..69、sky_stone/sky_grass 岛体，以及
> 单云/连通云簇的视觉语义；按产品范围删除空岛宝箱与天空树。云通过 BlockRegistry 的通用
> `supportsPlayer` 属性实现“可站立但非实心”，不在物理代码中按方块名特判。M2 关闭与 M3 冻结
> 基线均纳入空中结构场景。

> v1.15 修订说明：M3 实施落地口径回填（2026-09-02，实现细节详见 roadmap M3 条目与
> `docs/m2-m3-performance-report.md`）。① §4.7 增补**雨效与天气状态机**（M3-3）：mc-lite
> 真实实现在 `src/world/effects/RainEffect.js`（LineSegments + TSL GPU 下落，非 Engine.js
> weather 段）；mc-heavy 保留其算法与视觉参数（267 滴/半径 18/速度 24/dropLength 0.5/
> isSolid 地面截停/30Hz 距离检查 + 64 滴每帧分批迁移削峰），并按 roadmap 验收口径新增
> mc-lite 没有的**自动天气状态机**（晴 60~180s → 雨 30~90s 随机周期、5s 淡入淡出、
> force 手动覆盖同语义；周期数值为本次新定，无上游来源）。mc-lite 无天空压暗/雾距联动，
> 未引入。② §4.8 **设置持久化落点改 localStorage**（M3-4）：画质/音量/视距等设置是
> 设备级而非世界级（新世界/换存档应保留），存 `mc_heavy_settings_v1` 独立 key，
> 合并优先级 URL > 存储 > 默认；player 记录（位置/朝向/背包）仍按原设计归第二阶段，
> 第一阶段 Persistence 维持 meta+edits 两 store 不变。③ §4.9 **帧预算双档标定**（M3-2）：
> 8.3ms 标定值即 high 档（120Hz：上传 3ms/帧、mesh 下发 64/帧）；60Hz 帧间隔翻倍，
> 预算等比放宽为 low 档（6ms/128），保证两档设备世界填充速度一致。判档：
> `matchMedia('(min-refresh-rate:120hz)')` 静态检测（Chromium 未实现恒 false，不可信时
> 返回 null）→ 运行时「快帧(<11ms)比例 ≥5%」判据兜底（60Hz 物理上产生不了 <11ms 帧间隔，
> 120Hz 重负载只是量化到 16.7/25ms 仍偶发快帧；中位数判据会被启动 burst 污染误判 low）。
> 判档一次锁定防震荡；设置面板/`?budget=` 可显式覆盖。④ 视距/blur 档切换为**持久化 +
> 带参重载**：BatchedMesh maxInstances 与 WebGPU 纹理 mip level 数均在构造期固定
> （运行时翻 generateMipmaps 不重建 mip 链），重载是无副作用路径。

> v1.16 修订说明：**消除背包归属的口径矛盾并定稿 M3.1**（2026-09-02）。v1.12 曾写「背包、
> 完整 Hotbar 与玩家生存战斗均保持独立后续 Epic」，而 §4.5.4 同期写「第一阶段实现创造模式
> 无限背包」——二者冲突，且 M3-4 实施时按 v1.12 口径只落地了快捷栏 5 格（展示层 +
> `HOTBAR_ITEMS` 常量数组），物品数据模型缺位。本次定稿：① **背包归 M3.1**，插在 M3（已验收）
> 与 M4 之间，§4.5.4 由一句话扩写为完整规格（物品模型、槽位语义、物品集合、DOM 样式表、
> 输入门控）；② v1.12 那句中「背包、完整 Hotbar」的推迟范围**收窄为仅玩家生存战斗与物品
> 消耗规则**（`PlayerVitals`、掉落/拾取、count 递减仍是独立后续 Epic）；③ §4.1 补记
> `BlockRegistry.all()` 遍历接口（背包物品集合构建的唯一消费方，禁入热路径）；④ 修正
> `uiModal` 门控漏洞：模态打开期间 `Player._bindInput()` 的 keydown 不受拦截，M3.1 加守卫，
> 该守卫同时是 M4 Task 6（`KeyR` 切武器挂同一段 keydown）的前置条件。M4 与背包在数据层解耦
> （M4 spec 明确排除「弹药/装填/背包消耗」，武器切换走独立 `WeaponController`），排序依据是
> 共用 keydown 入口的工程效率，非依赖关系。

> v1.17 修订说明：**方块朝向放置交互定稿归 M3.2**（2026-09-02）。v1.16 前 §4.3 写「交互侧放置
> 语义仍属第二阶段」，roadmap 亦记「朝向交互侧暂不实现：第二阶段随床/宝箱/门落地」——即它此前
> **没有排进任何已编号里程碑**（M4~M7 spec/plan 经 grep 核实均不含方块朝向）。本次把它从
> 床/宝箱/门 Epic 中拆出独立实施：① §4.3 新增「朝向放置交互」小节，写完整规格（三分支算法、
> 门控字段复用、Player 两个交互状态、明确不照搬项、对 M4 的影响）；② 实测证据：mc-lite
> `orientationEnabled=true` 与 mc-heavy `orientationModes>0` 的方块集合**完全一致（40 项，零差异）**，
> 故直接复用 `orientationModesTable` 作门控，不新增字段；③ 更正一处此前误述——mc-lite 的放置朝向
> **不按玩家 yaw 计算**（`getPlacementOrientation(x,y,z,type)` 无朝向参数），手感是「原位挖掉再放
> 回去转 90°」，本次照搬；④ §4.1 读路径 API 补 `world.getBlockMeta(x,y,z)`（M4 plan Task 2 亦
> 计划新增，M3.2 提前交付）；⑤ roadmap 第 211 行「朝向交互侧暂不实现」改为已由 M3.2 落地，
> 床/宝箱/门 Epic 范围相应收窄为多方块结构 + `blockEntities` 富状态（朝向已独立交付）。

> v1.18 修订说明：**M3.2 实施回填的两处口径校正**（2026-09-03）。本次为实施期实测发现，
> 不改变 v1.17 的任何设计决策：① §4.3 门控集合的 false 计数勘误——v1.17 写「40 项 true，
> **84 项 false**，零差异」，实测 mc-heavy 侧是 **86 项**（126 方块 vs mc-lite 124；差额为
> M2-7 新增的 `sky_stone`/`sky_grass`，门控均为 0）。**true 集合零差异的结论不变**（各 40 项），
> 门控字段复用决策不受影响；84 是 mc-lite 侧计数，v1.17 误将其当作 mc-heavy 侧数字沿用。
> ② 三分支签名与记忆键的表示口径补记：mc-lite 用方块 **name** 作身份键，mc-heavy 世界权威是
> 数字 **id**，故签名统一为 `getPlacementOrientation(x,y,z,id,...)`、记忆键为 `Map<id, orientation>`
> （id↔name 一一对应，「按方块类型记忆」的语义等价；`registry.idOf(name)` 在 `placeBlock()` 内
> 已取到，无需额外转换）。单测 `src/tests/test-orientation.js` 已钉死 40/86 这两个数字。

> v1.19 修订说明：**异形方块渲染勘误**（2026-09-03，M3.2 收尾后的独立 bugfix）。
> 起因是「vine 向上溢出半格、疑似与 mc-lite 不一致」的观感报告；用 vendored three 精确复现
> mc-lite `geomMap` 几何构造实测包围盒后，发现**三个前提与实测相反**，据此改了 §4.3 三处：
> ① **实例原点换算基准**补记——mc-lite 以块中心为原点（四条放置路径全部 +0.5），mc-heavy 以
> 块底角为原点（0→1），比对时必须 +0.5 换算。此前文档与代码注释均未写明，容易误判几何差异。
> ② **vine 属「双方共同的溢出」而非 mc-heavy 缺陷**：mc-lite `geoVine` 世界 y∈[0.5,1.5]，
> 与 mc-heavy 原实现完全一致；其源码注释「使几何体从y=0到y=1」说的是局部坐标，误导。
> 经确认改为 y∈[0,1] 落在格内——**已知的有意偏离**，§4.3 已标注。
> ③ **床 UV 是真实 bug**：mc-lite 床材质的 `offset`/`rotation` 字段**全仓无消费点**（死字段），
> 实际只生效 `repeat:[1,0.5]` → 采样贴图下半；原实现照字段名与注释实现了「取上半 + 顶面旋转」，
> 而上半实测仅 32 个不透明像素（下半 92），opaque 通道下渲成深色块。已改为 `vLowerHalf` +
> 顶面不旋转。**教训写入 §4.3**：对齐上游须实测其运行时行为，读定义推断会引入回归。
> 附带：hanging_lamp 绳从 0.03 宽 cross 近似改为 `CylinderGeometry(0.015,…,8)` 等价的八段棱柱
> （复用 chimney 同款 `prismQuads`，UV 方向已与 three 实测核对：顶→v=1）。cactus 五盒逐格比对
> 两侧完全一致，未改。

> v1.20 修订说明：**背包物品集合口径变更**（2026-09-03，§4.5.4）。`chimney`（烟囱）移出背包
> 物品集合，**122 项 → 121 项**（填充 121 槽、其余 879 槽留空）。
> ① **不并入 `NON_PLACEABLE_ITEMS`**：该集合语义是「非玩家可放置的功能性方块」，而烟囱
> `solid:true` + 有 `faces-data` + 能放能挖，是正常可放置方块；放进去会让集合语义失真。
> 故新增独立常量 `HIDDEN_FROM_INVENTORY`（语义：可放置但不进背包），二者互斥。
> ② 对齐依据实测核对：mc-lite 背包清单是 `Game.js:206+` **手工列举 107 项**，chimney 不在其中。
> ③ **顺带实测记录两侧集合差异（本次未处理）**：mc-heavy 121 项 vs mc-lite 107 项，差集 16 项
> （含 `sky_*` 等 M2-7 本仓库独有内容、`bed_head`/`bed_tail` 等尚未实施的床 Epic 方块）+
> 反向差集 1 项 `gold`（mc-heavy 无此方块）。详见 §4.5.4 引用块——全面对齐需单独决策，
> 不宜简单删除。
> 附：本次还修了 `tests/m3-2-orientation.spec.mjs` 末尾队列断言的实现缺陷（等待归零后未再次
> 等待就采样，中间同步断言期间世界可能又开始加载 → 概率性读到 `meshInflight=32`；
> 改为再次等待收敛后断言，「无永久积压」语义与检查强度不变）。

> v1.21 修订说明：**吊灯（hanging_lamp）材质自发光**（2026-09-03，§4.3）。新增 packed
> **bit13 = 材质自发光标记**，对齐 mc-lite `MeshStandardNodeMaterial` 的 `emissive` +
> `emissiveIntensity`。
>
> 起因是「吊灯的贴图图案看起来像背包图标贴在方块上」的观感报告。实测核对后确认**根因不是贴图
> 错误**：mc-lite 的 `hanging_lamp` 材质（`MaterialManager.js:1197-1220`）确实有
> `textureGenerator`（画绳/灯体/发光区/高光），世界渲染用了这张程序化贴图；而背包图标
> （`HUD.js:117-152` 的 `generateIcon()`）取的正是**同一个材质**的 `mat.map` —— 即 mc-lite
> 的背包图标与世界贴图**同源同一张**。mc-heavy 的 `bake-procedural-textures.mjs:204-212`
> 逐行复刻了同样的绘制参数，贴图内容一致。
>
> **真实差异是材质自发光缺失**：mc-lite 材质有 `emissive:'#FFE4B5'` + `emissiveIntensity:0.8`
> （灯体看起来发光的暖黄色），而 mc-heavy 三通道材质是 `MeshBasicNodeMaterial`（贴图色 × shade，
> 无自发光）→ 贴图图案静态呈现，观感像「图标贴在方块上」。注意 `blocks-data.js:142` 的
> `emissive:15` 是 **blocklight 光照源**（照亮周围），**不是材质自发光**，两个概念不可复用。
>
> 实测 mc-lite **只有 hanging_lamp 一处**有材质自发光（其余材质 emissive 均为默认 0），故
> **不能给整个 cutout 通道加自发光**（会让 vine/flower/leaves/cactus 全部发光），必须按方块
> 区分 → 用顶点 bit13 传递（详见 §4.3 顶点格式段）。发布粒度不变（红线 5，仍是三通道）。
>
> v1.22 修订说明：**吊灯 UV 分区与 quad 级自发光**（2026-09-03，§4.3）——**已知的有意偏离
> mc-lite**（照 vine 先例）。起因是「绳应为单色深灰、灯体发光、灯面不应有绳图案」的观感要求。
> **实测确认 mc-lite 并非如此**（用 vendored three 实跑几何 UV + Playwright 真实渲染 + 像素级
> 分析定论）：
>
> | 实测项 | mc-lite 实际值 | 出处 |
> |---|---|---|
> | 绳几何 UV | u∈[0,1] v∈[0,1]，**采样整张贴图** | `ChunkConsolidation.js:216-227`（`CylinderGeometry(0.015,0.015,0.4,8)` 实跑） |
> | 灯体几何 UV | u∈[0,1] v∈[0,1]，**采样整张贴图** | 同上（`BoxGeometry(0.3,0.3,0.3)` 实跑） |
> | 贴图布局 | 64×64 canvas：背景 `#aaa49a` 填满全图 + 绳 `#333333`(col30~33,row0~19) + 灯体 `#FFE4B5`(col18~45,row20~47) + 发光区 `#FFF5E6` + 高光 `#FFFFFF` | `MaterialManager.js:1197-1220` |
> | 按部件拆分 UV | **无** —— 四条放置路径只设 position/rotation，不改 UV | `ChunkConsolidation.js:529` / `Chunk.js:2464` / `ChunkGenerator.js:175,224` |
> | 真实渲染的绳色 | rgb(231,224,209) —— emissive 加项淹没贴图图案，绳**不呈深色** | 三样本像素分析（mc-lite 原样 ≡ 纯背景色贴图，证明图案被冲淡） |
>
> 即 mc-lite 的绳采样整张图（含灯体图案）、灯体四个面也采样整张图（含绳图案），且
> `emissive:'#FFE4B5' × 0.8` 的加项把深色冲淡到与灯体同亮。**mc-heavy 此前已逐格忠实复刻
> mc-lite**（几何/UV/贴图/emissive 五项全等，包围盒实测相同），故本次改动即为**偏离**。
>
> 目标外观：绳单色深灰、灯体发光暖黄、灯体四个面不含绳图案。实现见 §4.3「吊灯 UV 分区」。
> **视觉比对 mc-lite 时勿按其原样判定**（与 vine 的 y∈[0,1] 同类：已知的有意偏离）。

> v1.23 修订说明：**背包专用图标表**（2026-09-03，§4.5.4）。起因是「台阶类方块（`planks_step`/
> `cobblestone_step`/`stone_diorite_step`/`cobblestone_step_updown`）的背包图标与其表面贴图完全
> 一样，是一张铺满正方形的贴图，无法从图标上看出横截面阶梯形状，与母方块（`planks`/`cobblestone`
> 等）撞脸」的观感报告。
>
> **根因（实测定位，非推测）**：`tileOfName()` 只查 `faces-data`，而台阶方块在 `faces-data` 里映射的
> 是**母方块贴图**：
>
> | 方块 | `faces-data` 映射 | 后果 |
> |---|---|---|
> | `planks_step` | `planks_birch` | 图标与 `planks` 撞脸 |
> | `cobblestone_step` | `Cobblestone` | 图标与 `cobblestone` 撞脸 |
> | `cobblestone_step_updown` | `Cobblestone` | 同上（且与正置台阶撞脸） |
> | `stone_diorite_step` | `stone_diorite` | 图标与 `stone_diorite` 撞脸 |
>
> **mc-lite 的做法（v1.24 勘误：v1.23 原文有误，勿再引用）**：v1.23 曾写「`HUD.js:117-152` 的
> `generateIcon()` 是『显式图标表 + `switch(name)` 分支』结构，台阶走 `getStepMaterial(name)`
> 换材质（`if (name.endsWith('_step')) return this.getStepMaterial(name)`）」——**这两处论断
> 均不成立**。实测核实（v1.24）：`generateIcon()` **无 `switch`、无任何按 name 的分支**，
> 是统一流程（取 `materials.getMaterial(item)` 的 `map` → `drawImage` 进 32×32 canvas →
> 描边 → `toDataURL` + `iconCache`）；`getStepMaterial` 与 `endsWith('_step')` 在 mc-lite
> **全仓零命中**（`grep -rn` 核实）。
>
> **mc-lite 真正的专用图标机制在 `src/utils/ItemIconUtils.js:11` 的 `getCustomIconPath()`**
> （v1.23 漏查了此文件），是一张 14 项的「方块名 → PNG 路径」表，`createItemIcon()` 命中即
> 直接 `img.src = customIconPath`、否则回落 `HUD.generateIcon()`。台阶 4 项与矿车在该表内，
> **故 v1.23 采纳的 tile 名是对的**，只是机制描述错了——它们来自这张图标表而非
> `generateIcon()` 的分支。mc-lite 贴图目录里确实没有名字带 step/stair/slab 的 PNG，
> 台阶图标是手工绘制的专用图标贴图（这一点 v1.23 无误）。
>
> **关键发现：这些图标早已在 atlas 里躺着，只是没人引用。** 实测 atlas 有 **13 个 orphan tile**
> （`faces-data` 从未引用），其中 5 个正是背包图标：
>
> | orphan tile | 尺寸 | 对应方块 |
> |---|---|---|
> | `Oak_Planks_step` | 16×16 | `planks_step` |
> | `Cobblestone_step` | 16×16 | `cobblestone_step` |
> | `Cobblestone_step_updown` | 16×16 | `cobblestone_step_updown` |
> | `stone_diorite_step` | 16×16 | `stone_diorite_step` |
> | `Invicon_Minecart` | 32×32 | `mine_cart`（此前渲染空槽） |
>
> 像素差异率证实这些确实是台阶图案贴图而非重复的普通贴图（图标 vs 母方块贴图）：
> `Oak_Planks_step` **256/256（100%）**、`Cobblestone_step` 64/256（25%，**后 8 行完全相同、
> 前 8 行重绘**）、`stone_diorite_step` 59/256（23%，同样后 8 行相同）、
> `Cobblestone_step_updown` 218/256（85%，全幅重绘）。
> 「后 8 行保留原贴图、前 8 行重绘」正是台阶横截面的表达方式——下半部是完整方块面、
> 上半部画出阶梯。
>
> 其余 8 个 orphan tile 中，`handrail`/`handrailA`/`handrailB`/`pillar`/`pillar_horizontal`/`turret`
> 是 **128×128 世界渲染贴图**（非图标），`gold`/`leaves_original` 是 16×16 备用贴图。
> mc-lite 只为台阶与矿车做了专用图标，`handrail`/`pillar`/`cactus` 等异形方块**两边都没有图标**。
> 故本次图标表的覆盖范围 = mc-lite 的全部专用图标范围（5 项），不是「所有异形方块」。
>
> **⚠️ v1.24 勘误（上述两条论断均错，勿再引用）**：实测核实 mc-lite
> `src/utils/ItemIconUtils.js:11` 的 `getCustomIconPath()` 是 14 项专用图标表，
> `handrail`/`handrailA`/`handrailB`/`vertical_pillar`/`horizontal_pillar`/`turret_alias_block`
> **都在表内**——即那 6 个 128×128 orphan tile 正是 **mc-lite 的专用背包图标**
> （326×326 PNG 按 128×128 入图、透明背景占 48.5%~69.3%），不是世界渲染贴图；
> 「异形方块两边都没有图标」也不成立。故「覆盖范围 = mc-lite 全部专用图标范围（5 项）」
> 这个推理的**前提有误**，mc-lite 的实际图标范围是 14 项。v1.23 落地的 5 项仍是对的
> （当时只修台阶 + 矿车，属用户指定的范围），但**理由需更正**。这 6 个 orphan tile 在
> v1.24 起由等轴测图标取代（见 v1.24 修订说明）。
>
> 方案取舍（三方案对照页 `src/tests/test-step-icon-methods.html` 实测渲染比对）：
> - **A 用 atlas 现成 tile（采纳）**：资产已就位、零新增文件、走既有 CSS background 裁剪路径、
>   观感对齐 mc-lite。代价是手工贴图需随方块贴图同步维护。
> - B canvas 合成遮罩：自动跟随贴图变化、可扩展到所有异形方块，但假明暗非真实几何光照、
>   观感偏离 mc-lite，且引入运行期合成逻辑。
> - C CSS `clip-path` 裁剪：纯 CSS 零资产，但只有轮廓没有明暗，辨识度最弱。
>
> 实现见 §4.5.4「背包专用图标表」。

> v1.24 修订说明：**异形方块等轴测投影图标**（2026-09-03，§4.5.4）。起因是「`handrail`/
> `handrailA`/`handrailB`/`vertical_pillar`/`horizontal_pillar` 这 5 个非立方体方块在背包里
> 显示为一个铺满正方形的平面贴图，看不出几何形状」的观感报告，并附带要求给出比 mc-lite
> 手工贴图**更优的表达方式**（用户评价 v1.23 的手工图标「虽然可以辨识，但确实有点丑陋」）。
>
> **根因（实测定位，比观感报告更严重）**：这 5 个方块在 `faces-data` 里映射的是
> `procedural/*` 程序化贴图，实测贴图内容**几乎全是纯色底**：
>
> | 方块 | `faces-data` 贴图 | 实测不同色数 | 主色占比 |
> |---|---|---|---|
> | `handrail` | `procedural/handrail` | **2** | rgb(185,142,91) 占 3734/4096 px |
> | `handrailA` | `procedural/handrailA` | **2** | 3429/4096 px |
> | `handrailB` | `procedural/handrailB` | **2** | 3269/4096 px |
> | `vertical_pillar` | `procedural/pillar` | 38 | 3730/4096 px（其余为木纹噪点） |
> | `horizontal_pillar` | `procedural/pillar_horizontal` | 40 | 3724/4096 px |
>
> 故这 5 个图标**不仅看不出形状，彼此之间也几乎无法区分**（三张栏杆贴图只差深色噪点
> 数量、两张柱子贴图只差噪点分布）。观感报告说的「看不出形状区别」成立，实际问题还包含
> 「5 个图标互相撞脸」。
>
> **顺带定位了 v1.23 手工图标「丑陋」的真正根因（用户评价，实测确认）**：mc-lite 的手工
> 图标 PNG 与游戏内方块**颜色不一致**——实测 mc-lite 图标 `handrail.png` 平均色
> **rgb(195,163,5)（金黄色，B 分量几乎为 0）**，而游戏内世界贴图 `procedural/handrail.png`
> 平均色 **rgb(181,138,89)（木色）**；柱子同理（图标 rgb(193,160,9) vs 世界贴图
> rgb(184,141,90)）。即背包里是金黄色栏杆、游戏里放出来是木色栏杆 —— **观感割裂**。
> 台阶 4 项的手工图标（v1.23 采纳的那批 16×16）同样是人手绘制的图案，配色与母方块贴图
> 未必一致。等轴测方案**采样游戏内实际贴图**（`faces-data` 指向的那张），从机制上不可能
> 出现这个割裂——这是采纳等轴测而非沿用手工贴图的第二条理由（第一条是形状信息量）。
>
> **mc-lite 的做法（实测核实）**：mc-lite 的专用图标逻辑在 `src/utils/ItemIconUtils.js:11`
> 的 `getCustomIconPath()`（**不在 `HUD.js`**），是一张 14 项的「方块名 → PNG 路径」表，
> `createItemIcon()` 命中即直接用该 PNG、否则回落 `HUD.generateIcon()`（取材质 `map` 画进
> 32×32 canvas）。**这 5 个方块 mc-lite 确实有专用图标**：`handrail`/`handrailA`/`handrailB`
> → `handrail{,A,B}.png`、`vertical_pillar` → `pillar.png`、`horizontal_pillar` →
> `pillar_horizontal.png`。实测这些 PNG 是 **326×326 透明背景手工图标**（透明像素占
> 48.5%~69.3%、2192~4859 种颜色），与 `faces-data` 引用的 `procedural/handrail`（64×64、
> **仅 2 种颜色**、世界渲染贴图）是**两套同名但完全不同**的 PNG。
> mc-lite **没有**等轴测/离屏渲染缩略图机制。**故本次仍是 mc-heavy 的独立改进**
> （用户明确要求比 mc-lite 手工贴图更优的表达），但理由不是「mc-lite 无图标」而是
> 「mc-lite 的手工贴图观感不佳」——**已知的有意偏离**（与 v1.22 吊灯 UV 分区、§4.3 vine
> 同类），视觉比对 mc-lite 时勿按其原样判定。
>
> **关键论据：形状的唯一权威已存在，图标不得有第二份几何定义。** 这 5 个方块的几何
> 已完整定义在 `src/mesh/mesher.js` 的 `TEMPLATES`（§4.3，逐格复刻 mc-lite `geomMap`）：
> `handrail` = 中柱 0.5² + 东/北把手（3 个 `boxQuads`）、`handrailA` = 柱 0.3² + 全长 X 横杆、
> `handrailB` = 柱 0.3² + Z 横杆 0.5 长、`vertical_pillar` = `boxQuads(0.35,0,0.35,0.65,1,0.65)`、
> `horizontal_pillar` = `boxQuads(0,0.35,0.35,1,0.65,0.65)`。**图标烘焙脚本必须 import
> `TEMPLATES`，禁止手写第二份几何定义**（红线 1 精神：数据只有一份权威）——几何改了图标
> 自动跟着改，不会出现「图标与真实形状不符」的静默偏差。
>
> **渲染算法（原型实测验证）**：2:1 等轴测投影 + 逐像素深度测试 + 三面明暗 + 按局部 UV
> 采样贴图 + 透明背景：
>
> ```
> 投影:  sx = x - z,  sy = (x+z)/2 - y      （2:1 等轴测，图标惯例）
> 深度:  x + y + z                          （视线方向 = 投影平面法线 (-1,-1,-1)）
> 可见面: 只取 +X(0) / +Y(2) / +Z(4) 三个朝向观察者的面
> 遮挡:  逐像素深度测试（重心插值真深度，z-buffer 语义）；排序仅决定深度并列时的胜负
> 明暗:  +Y 顶面 ×1.0、+X 侧面 ×0.75、+Z 侧面 ×0.55
> 贴图:  重心坐标插值 quad 的 UV → 采样源 PNG（nearest）
> 背景:  alpha=0 透明（形状轮廓可见，不铺满正方形）
> span:  包围盒归一化系数 1.12（形状占约 89% 画布）
> ```
>
> **深度与遮挡口径（v1.28 修，勿照旧文档口径实现）**：曾写 `x+z-y`（y 符号反了）+ painter
> 整面覆盖 → 异形方块（台阶/栏杆/柱子）的面重叠时遮挡判定反了，被遮住的面反而覆盖可见面。
> 详见 v1.28 修订说明。**面平均深度只能用于排序，不能用于遮挡判定**。
>
> **明暗系数是「UI 图标惯例」，不是世界渲染的 shade 口径**：世界渲染的 shade 是
> `light × AO`（§4.3 顶点阶段 float varying），背包图标不参与光照系统，用固定三面系数
> 表达立体感。二者不可复用（与 §4.3 吊灯 `emissive:15` blocklight 源 vs 材质自发光的
> 区分同理）。
>
> **原型实测结果**（32/64px 双档均验证）：
>
> | 方块 | 不透明占比 | 不同色数 | 形状辨识度 |
> |---|---|---|---|
> | `vertical_pillar` | 37.8% | **53**（保留木纹噪点） | 竖长柱体 |
> | `horizontal_pillar` | 34.1% | — | **横扁横梁**，与竖柱一眼可分 |
> | `handrail` | 52.4% | 7 | 中柱 + **两侧把手突出** |
> | `handrailB` | 37.9% | — | 中柱 + 短横杆 |
> | `handrailA` | — | — | 中柱 + 全长横杆 |
> | `planks_step` | 56.5% | 25 | **L 形阶梯轮廓清晰** |
>
> 等轴测投影能一眼区分这 5 个形状（竖长/横扁/双侧把手/全长横杆/短横杆），且台阶的 L 形
> 立体轮廓比 v1.23 的平面横截面图案信息量更足。
>
> **端到端视觉验证**（截图在本环境无法目视——Read 只返回 URL 不渲染成图像，故改用
> 像素级实测代替，与 v1.22/v1.23 同口径）：逐槽位图标元素截图 → canvas 读像素 →
> 轮廓包围盒 + 行分布剖面。**判据是「图标形状必须与 mesher `TEMPLATES` 几何定义对应」**：
>
> | 方块 | 包围盒 | 填充% | 上部宽/下部宽 | 对应几何定义 | 判定 |
> |---|---|---|---|---|---|
> | `vertical_pillar` | 13×29 | 32.1 | 9.6/9.6 | `boxQuads(0.35,0,0.35,0.65,1,0.65)` 全高 0.3 宽 | ✓ 竖长 |
> | `horizontal_pillar` | 29×21 | 33.5 | 9.6/9.6 | `boxQuads(0,0.35,0.35,1,0.65,0.65)` 全长 X 0.3 高 | ✓ 横扁 |
> | `handrail` | 27×29 | 47.9 | 11.9/11.9 | 中柱 0.5² + 东/北把手 | ✓ 把手额外覆盖 |
> | `handrailA` | 25×29 | 37.4 | **12.7/9.6** | 柱 + 全长 X 横杆（上部更宽） | ✓ 上下不对称 |
> | `handrailB` | 15×29 | 33.0 | **10.3/9.6** | 柱 + Z 横杆 0.5 长（比 A 窄） | ✓ 上下不对称 |
> | `planks_step` | 29×29 | 55.5 | **11.7/13** | `STEP_QUADS` 下半全幅 + 左上 1/4 柱 | ✓ 底宽顶窄 |
> | `cobblestone_step_updown` | 29×29 | 55.5 | **13/11.7** | `STEP_UPDOWN_QUADS` 上半全幅 + 右下 1/4 柱 | ✓ 顶宽底窄 |
> | `stone`/`planks`（对照） | 32×32 | **100** | 32/32 | 无模板 = 单位立方体 | ✓ 铺满正方形 |
>
> 最强一条：`planks_step` 与 `cobblestone_step_updown` 的行剖面**完全相反**（11.7/13 vs
> 13/11.7）→ 正置/倒置台阶图标形状与几何定义严格对应，不是「恰好看起来不同」。
> `handrailA`（全长横杆 12.7）比 `handrailB`（0.5 长横杆 10.3）上部更宽 → 横杆长度差异
> 在图标上可辨。对照组 `stone`/`planks` 填充 100% 而异形方块 32~48% → 透明背景生效、
> 轮廓可见。
>
> **方案取舍（离线烘焙 vs 运行时合成）**：
> - **A 离线烘焙入 atlas（采纳）**：运行时**零开销**（复用既有 CSS background 裁剪路径）、
>   与其余 109 项图标**完全同一条渲染路径**（不引入第二套）、确定性（固定算法无随机）、
>   符合红线 3（重计算离开运行时）。代价：几何变更需重跑脚本 + `npm run atlas`。
> - B 运行时 canvas 合成：几何变更自动生效，但背包打开时要为每个图标合成（118 项）、
>   引入第二套图标渲染路径、违反红线 3（主线程做可后台化的重计算）。
>
> 采纳 A。`mesher.js` 可在 Node 下 import（无 three/DOM 依赖，符合红线 8 同构纯函数），
> 只需给 `TEMPLATES` 加 `export`。透明像素可直接入 atlas——实测 `PNG.bitblt` 保留
> `alpha=0`，`build-atlas.mjs` **无需改动**。
>
> **覆盖范围（9 项）**：`handrail`×3 + `vertical_pillar`/`horizontal_pillar` + 台阶 4 项
> （`planks_step`/`cobblestone_step`/`cobblestone_step_updown`/`stone_diorite_step`）。
> 台阶一并换成等轴测以统一表达口径（避免同一背包里「平面横截面图案」与「立体等轴测」
> 两套风格并存）。保持平面贴图现状：`cactus`/`vine`/`lilypad`/`hanging_lamp`/`flower` 系
> 7 个方块；跳过 `chimney`/床三项（不在背包 118 项内，见 §4.5.4 `HIDDEN_FROM_INVENTORY`）。
>
> **`stone_diorite_step` 的 geometry 是 `cobblestone_step`**（mc-lite 同口径，
> `BlockData.js:283` 的 `geometryType: 'cobblestone_step'`，实测核实**非 bug**），但贴图是
> `stone_diorite` → 图标烘焙必须**按方块名组织**：几何查 `BLOCKS[].geometry` 字段、
> 贴图查 `faces-data`，二者不必同名。
>
> **两处既有断言口径变更（随事实更新，非擅自放宽）**：
> 1. `tests/atlas.spec.mjs` 钉死 tile 数 **147 → 156**（新增 9 张图标 PNG）。断言语义是
>    「atlas 覆盖全部纹理」，新增图标 PNG 属覆盖范围的正当扩展；`procCount`（`procedural/`
>    前缀 23）不受影响——新图标放独立目录 `assets/textures/inventory-icons/`，前缀不同。
> 2. v1.23 的 4 个台阶手工图标 tile（`Oak_Planks_step`/`Cobblestone_step`/
>    `Cobblestone_step_updown`/`stone_diorite_step`）改为等轴测后**变成 orphan**（PNG 与
>    tile 都保留、atlas 总数只增不减，只是没有消费方）。`Invicon_Minecart` 仍被引用
>    （`mine_cart` 不在本次 9 项内）。保留理由：删除会让 atlas 计数与 mc-lite 纹理清单
>    口径脱钩，且这些是 mc-lite 的手工图标资产（有对照价值）。
>
> **门禁对照（未凭文档结论免责）**：
> - `npm run lint`：0 error（16 warnings，新增 2 个 camelcase 来自 `vertical_pillar`/
>   `horizontal_pillar` 作对象键，与既有方块名 warning 同性质——`eslint.config.mjs`
>   豁免清单未含 `hotbar.js`，项目接受此类 warning，未擅自改配置）；
>   顺带补配 `createImageBitmap` 全局（标准浏览器 API，图标单测解码 PNG 需它，
>   配置里已有同性质的 `Blob`/`FileReader`/`fetch` → 属漏配而非规则问题）；
> - 浏览器单测 **270 全绿**（257 + 13 新增）；
> - Playwright **44/44**（`atlas.spec.mjs` 计数更新后全绿）；
> - `bench --check` 通过（fps 111.64~120.02、draw 489~545，无回退）；
> - `m1-acceptance` 放挖 p95 首次全量跑失败（`placeP95=2.0` 撞 `< 2` 断言）——
>   **经 HEAD stash 对照各连跑 4 次证实为既有抖动，非本次引入**：
>   HEAD 侧 `2.1/1.9/1.9/1.8`（均值 **1.925**，**3 failed / 1 passed**）、
>   改动侧 `1.7/1.8/1.9/2.0`（均值 **1.85**，**2 failed / 2 passed**）——
>   **HEAD 侧失败率更高、峰值更高（2.1 vs 2.0）、均值也更高**。
>   机制上不可能影响：本次未碰 `mesher.js` 几何（只加 `export`）与 `materials.js`，
>   `atlas.png` 是离线资产不参与编辑快路径（放/挖走 typed array + REMESH）。
>   **教训**：仅凭「全量跑失败 / 单独跑通过」判定不够——全量跑时 `sky-structures` 与
>   `m1-acceptance` 轮换失败，容易误读成「改动侧统计显著」。必须**分开按 spec 连跑
>   拿数值分布比均值与峰值**才能定论。
> - `sky-structures` p95 首次全量跑 23.5（断言 < 16.75）：单独跑 3 次均 16.6/16.7/16.7
>   全通过，HEAD 侧全量同样 16.7 通过 → 全量负载抖动（与 CLAUDE.md 既有记录一致）。
>
> **已知取舍：新增 atlas 目录会重排已有 tile 坐标**。`build-atlas.mjs` 的 `collectPngs`
> 按字母序排序、shelf 装箱，`inventory-icons/` 插入序列 → 实测 `procedural/handrail`
> 坐标 x=672 → x=1280、`procedural/pillar` x=1152 → x=1760（`handrail`/`Oak_Planks_step`
> 所在 shelf 未受影响）。**不影响正确性**（`atlas.json` 同步更新，mesher 读 json 的 UV
> 而非硬编码坐标），但 `atlas.png` 像素内容确实重排、体积 +28KB（229733 → 258628）。
> 若未来有人依赖 tile 坐标做断言，需注意这一副作用。
>
> 实现见 §4.5.4「等轴测投影图标」。
>
> v1.25 修订说明：**测试分级策略与静态门禁**（2026-09-03，M3 收尾后、M4 开始前）。起因是
> 「任何小改动全都用 TDD 驱动，连改一个贴图地址、修正一个 alias 映射都要先写失败测试」——
> 这类改动的正确性肉眼即可判定，TDD 只增加成本不增加保障。分级判据不是「改动大小」也不是
> 「文件位置」，而是**改坏了会怎样、多久能被发现**：
> - **Tier 1**（机制/架构/性能/API/稳定性）改坏了是**静默的数据错误**（AO 算错、面剔除漏面、
>   版本协议竞态、性能回退），肉眼玩不出来、只能靠断言 → **必须 TDD**；
> - **Tier 2**（数据契约/集合口径）改坏了立刻可见（图标空槽、方块消失）、修复成本 = 改回去
>   → **门禁断言，免 TDD 流程**；
> - **Tier 3**（文案/资源引用/观感）→ **免测试**，只需 lint；
> - **Tier 4**（GPU 渲染结果，TSL 节点在 GPU 求值主线程读不到）→ **像素级实测**，不宣称目视。
>
> **核心改造：关系型断言取代硬编码计数**。硬编码计数（`expect(count).toBe(156)`）是
> 「改动放大器」——新增一张贴图就要改 spec + CLAUDE.md + 设计文档**三处**（同一个事实的三个
> 副本，违反红线 1 精神）。改为校验不变式：`atlas.spec.mjs` 的 tile 数改为与
> `assets/textures` 的实际 PNG 数比对（build-atlas 的契约：每张 PNG 打成一个 tile）；
> `m3-1-inventory.spec.mjs` 的物品集合改为 **Node 侧 `buildItemNames()` 与浏览器侧真实
> 背包装配两侧独立计算比对**。实测验证：把 `gold_block` 加进 `HIDDEN_FROM_INVENTORY`
> （118 → 117），**spec 未做任何改动即通过**——旧设计下同一变更要同步改三处文档。
> 保留硬编码的例外是 `size=2048`/`gutter=16` 这类**设计常量**（§4.4.1 定稿）：判据是
> 「这个数是设计决策还是事实统计」，前者钉死、后者用关系式。
>
> **新增两个静态门**（`tools/check-*.mjs`，均经正负向验证）：`check:arch` 守 12 条重构红线中
> 可静态检查的部分（three 隔离用**双层判定**——目录默认 + 自声明一致性，实测精确文件列表会让
> 新增的 `src/mesh/*.js` 绕过检查；禁止类名**只查非注释行**——`mesher.js:51` 引用
> `ChunkConsolidation.js:530` 是算法出处注释必须放行；依赖方向含白名单）；`check:data` 守数据
> 契约（引用完整性 / 物品集合关系式 / 图标同步 / 测试注册完整性）。
>
> **两处文档漂移勘误**（本次 review 发现）：§4.4.1 曾写「atlas 合计 147 tile」而实测 156
> （v1.24 加图标时改了 spec 断言却漏了这句）；roadmap「测试现状」曾写「246 个浏览器内单元
> 测试」而实测 270。两处均改为**指向门禁输出**，文档不再携带硬编码计数。
> 另勘误 CLAUDE.md 的分层声明「`core/` 不依赖 `voxel/`」——与实测不符
> （`game.js`/`scheduler.js` 都 import voxel），`core/` 是**装配层**，依赖任何层合法。
>
> **已知例外（白名单，均注明理由）**：① `mesh/atlas-loader.js` import three——它不是同构模块
> （只被 `core/game.js` 消费，运行时加载 atlas 纹理必然依赖 three），分层归属本应在 `render/`
> 但历史放在 `mesh/`，**不移动**（属架构改动，须设计文档先行）；② `voxel/world-data.js`
> 依赖 `mesh/lighting.js`——红线 11 要求编辑快路径同步重算垂直单列，而 `lighting.js` 是
> Worker 同构纯函数（不 import three、无 DOM），故是**算法依赖不是渲染依赖**，voxel 仍
> 「不知道渲染存在」。把 `recomputeSkylightAt` 挪进 voxel 层属架构改动，须先改本节分层图。
>
> 分级策略的唯一权威是 [`docs/testing-policy.md`](testing-policy.md)，本文档不自述分级细节。
>
> v1.26 修订说明：**全量背包图标离线烘焙**（2026-09-03，§4.5.4）。起因是用户要求「预生成每个
> 方块的立体缩略图，运行时直接引用，简化渲染逻辑」。实测确认思路成立且**运行时确实简化**
> ——我第一轮判断错了（漏了「预生成可以连裁剪数学一起预生成掉」这层）：
> - 旧路径「`tileOfName()` 两级查表 + `tileStyle()` 裁剪数学 + 写 4 个样式属性 +
>   `INVENTORY_ICONS` 例外表」→ 新路径 1 行 `icon.style.background = css`
>   （实测约 91 行 → 1 行，预生成串与旧路径 computed style **逐项相等**，已实测验证）；
> - **按显示尺寸烘焙**（快捷栏 40px / 背包 32px 两套）→ 运行时零缩放、像素风锐利；
> - **独立 `icons-atlas.png`**（1024²，占 29.5%）而非入世界 atlas → v1.24 记录的「新增
>   textures 子目录重排世界 tile 坐标」副作用消失，UI 不必加载 2048² 只为裁图标；
> - 覆盖全量 **118 项**（等轴测 104 + 平面 14）。平面清单 = 非实心方块（用户指定：等轴测
>   立方体对植被/水/云不合适），`mine_cart` 保留 mc-lite 手工图标（实体不是方块）。
>
> **Tier 1 改造（TDD）**：① 采样回调加第三参数 `face` 做**逐面采样**——实测实心 104 项里
> 17 项是多面不同贴图（`grass` 顶绿侧土），旧单面采样会让 `grass` 顶面渲成土色（负向验证：
> 注入「只采 face 0」→ 顶面变土色被抓）；② `cubeQuads()` 复用 mesher 的
> `FACE_VERTICES`/`FACE_UVS`（97 个实心方块无模板 → fallback 单位立方体；红线 1：形状与 UV
> 只有一份权威）；③ 消除 `ISO_FACE_UVS` 第二份副本（实测与 mesher `FACE_UVS` 的 face 0/2/4
> 完全相同）→ 改 import。`mesher.js` 为此导出 `FACE_VERTICES`/`FACE_UVS`（不改几何定义）。
>
> **一个测试弱点（实测发现，已写进注释）**：`cubeQuads` 顶点比对断言钉的是**值**，「手写一份
> 数值完全相同的第二份定义」会通过——它抓的是漂移不是「存在第二份定义」。真正保证来自
> `iso-icon.js` 走 import（结构上不可能漂移：实测改 mesher 的 +X 顶点，`cubeQuads()` 自动跟上）。
>
> **图标过期门禁**：指纹 = 几何顶点序列 + 三个可见面贴图名 + **贴图内容哈希**。实测发现并修掉
> 一个真实缺陷：只钉贴图名会**漏报**「换同名 PNG 内容」（最危险方向）+ **误报**无关方块
> （改 `stone.png` 误报 `mine_cart`，因 faces-data 里 `mine_cart` 的 face0 是 `stone`）。
> 修正后三种失效路径负向验证全过。指纹逻辑放共享模块（烘焙脚本与门禁同一份，红线 1）。
>
> **顺带清掉死资产**：删 `tools/bake-isometric-icons.mjs` + `assets/textures/inventory-icons/`
> 9 张 PNG（零运行时消费方），世界 atlas 156 → **147** tile。`atlas.spec.mjs` 的关系型断言
> 自动跟上（无需改断言）。
>
> **门禁对照（HEAD stash 分开按 spec 连跑拿分布）**：`placeP95` HEAD 侧均值 1.94 / 改动侧 1.92；
> `fastRemeshP95` HEAD 侧 1.14 / 改动侧 1.16——分布重叠、无回退，**未擅改断言**。全量 E2E 两侧
> 均偶发 1 failed 且失败 spec 轮换不同（HEAD: `m3-rain` / 改动侧: `m1-acceptance`），单独跑全绿。
>
> 实现见 §4.5.4「背包图标」。
>
> v1.27 修订说明：**背包槽位点选抖动修复**（2026-09-03，§4.5.4）。起因是用户观感报告
> 「点选一个方块后，下一行方块会下移一两个像素」。根因实测定位（非推测）：`.mc-slot` 是
> `width:48px; height:48px` 且未声明 `box-sizing` → 默认 `content-box`，边框加在尺寸之外，
> 故总盒 = 未选中 52×52、选中 54×54（`.selected` 边框 2px→3px）。`#inventory-grid` 是 grid，
> 行高由内容决定 → 选中格撑高 2px → **该行变高 2px → 下一行整体下移 2px**。
> 修法：`box-sizing:border-box` + 尺寸显式写 **52**（= 改前的等价总盒，故未选中态像素级不变），
> 选中时边框往内吃 1px 而不撑大盒子。`transition: border-color 0.1s` 只过渡**颜色** → 印证
> 边框增粗是无意引入的副作用，不是设计意图。快捷栏无此问题（`hotbar.js` 高亮只改 `borderColor`）。
> **实测验证**（DOM 几何，非截图目视）：HEAD 侧第二行 top 262 → 260（**位移 2px，抖动确认存在**）；
> 改动侧第二行 top 260 恒定、选中第三行后仍未变、第二行 8 个槽位 top 逐项相等 → **零抖动**。
> 顺带实测两条并据此改了代码注释（原注释有一句凭推理写的断言，实测证伪后已删除）：
> 32px 图标在内容区 48/46 两种情况下都放得下；**图标中心始终不偏移**（偏移实测 0/0）——
> 原因是边框四边等宽 → flex 居中的内容区始终居中于外框，故「content-box 下图标中心会随边框
> 增粗偏移」这一推测**不成立**，两侧都不偏移。
>
> v1.28 修订说明：**等轴测图标遮挡修复**（2026-09-03，§4.5.4）。起因是用户观感报告
> 「背包里 `cobblestone_step_updown` 渲染出来的几何形状跟真实方块有出入，看着奇怪」。
> **先核实几何本身没问题**（勿凭观感直接改几何）：与 mc-lite `ChunkConsolidation.js:188`
> `geoCobblestoneStepUpdown` 逐格核对 —— 上半块 `BoxGeometry(1,0.5,1)` translate(0,0.25,0)
> → y∈[0.5,1] 全幅、下半柱 `BoxGeometry(0.5,0.5,1)` translate(0.25,-0.25,0) →
> x∈[0.5,1] y∈[0,0.5]，+0.5 换算后与 `mesher.js` 的 `STEP_UPDOWN_QUADS` **完全相同**。
> 故问题在**图标投影算法**，不在几何。两个 bug：
>
> **① 深度度量的 y 符号反了。** 投影轴 u=(1,0,-1)、v=(0.5,-1,0.5) 叉乘得投影平面法线
> `(-1,-1,-1)` → 视线从 (+,+,+) 看向原点 → **正确深度 = x+y+z**。代码用的是 `x+z-y`，
> 与正确度量差 `2y`，对只在 y 上不同的两点判定**完全相反**（`(0,1,0)` vs `(0,0,0)`：
> 判成 -1 < 0 = 高处更远）。**实心方块长期不暴露**：三个可见面互不重叠，排序不影响结果；
> 异形方块的面会重叠 → 错度量直接导致遮挡判定反了。
>
> **② painter 用「面平均深度」排序，对被整片遮住的面无能为力。** 决定性对照（实测）：
> 真顶面（y=1）现度量 depth=0.00、下半柱顶面（y=0.5）depth=0.75 → **判定被遮住的面更近**。
> 该柱顶面被上半块**完全遮住**（x/z 范围完整覆盖它）→ 现实中根本看不见，但
> `VISIBLE_FACES` 只按面索引过滤、不知道它被遮挡，照样发射，且平均深度更大 → painter
> 把它画在柱侧面之后、覆盖掉本该可见的柱侧面，渲成一片亮楔形（顶面 shade 1.0 最亮，
> 柱侧面 0.75/0.55）。这就是「形状看着奇怪」的来源。
>
> **只改度量不够**（实测，三方案逐面占据像素对照）：
>
> | 方案 | 柱顶面占据像素（32px） |
> |---|---|
> | ① 现状：错度量 + painter | **88px**（幻影） |
> | ② 仅改度量 + painter | **仍 88px**（幻影未消失） |
> | ③ 正确度量 + 逐像素深度测试 | **4px**（仅深度并列的边界残留） |
>
> 故两处一起改：`isoDepth(x,y,z)=x+y+z` + `scanFill` 加逐像素深度测试（重心插值每个像素的
> 真深度，与 GPU z-buffer 同语义）。排序仍保留（`>` 而非 `>=` → 深度并列时后画的不覆盖先画的，
> 保持 painter 既有语义）。
>
> **blast radius 实测**（未凭推测）：异形方块 10 项内部面归属修正、**轮廓 alpha 差异全为 0**
> （`cobblestone_step_updown` 179px / `cactus` 149px / 台阶×3 各 76px / `handrailA` 30px /
> `handrailB` 27px / `handrail` 23px / `horizontal_pillar` 13px / `vertical_pillar` 1px）；
> 实心方块 94 项最大色差异 **5px**、轮廓零变化（三面不重叠，排序本就无关）。
> 按方块单独 hack 做不到 —— 那会在 `TEMPLATES` 之外开第二份形状权威（违反红线 1）。
>
> **TDD（Tier 1：纯函数算法）+ 两条互为镜像的回归防线**。RED 阶段 3 个新用例全部失败
> （实测数值与断言一致：88px 幻影、depth 0.75 > 0.00）。判据用恒色贴图下的三面亮度反推
> 像素归属（顶面 100 / +X 75 / +Z 55），无需暴露面占据统计。两条断言合起来才精确表达正确语义
> —— 单独任一条都能被「全砍顶面」或「全留顶面」的粗暴修法骗过：
> - 「倒置台阶下半部不得出现顶面」（幻影消失：88px → 4px）；
> - 「正置台阶阶梯踏面必须保留」（`planks_step` 的柱顶面在 y=1，是**外部面** = 阶梯踏面，
>   修正后反而露出更多：84px → 109px）；
> - 「屏幕位置最高的顶面 depth 最大」（钉深度度量方向，防写回 `x+z-y`）。
>
> **像素级验证**（截图在本环境无法目视）：烘焙产物行剖面 `planks_step` 上部 18.2 / 下部 21.0
> （底宽顶窄）、`cobblestone_step_updown` 上部 21.0 / 下部 18.2（顶宽底窄）→ 与
> `STEP_QUADS` / `STEP_UPDOWN_QUADS` 几何定义严格对应，且二者互为镜像。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 通过（arch 全绿 + data 7 项契约一致，
> 含**图标过期指纹**确认已重烘同步 + lint 0 error、9 个既有 camelcase warning）；单测
> 270→**273**（+3）全绿；`bench --check` 通过（fps 111.02~120、draw 489~545，基线文件未被覆写）。
> Playwright 全量 43 passed / 1 failed（`m1-acceptance` 的 `placeP95`），经 **HEAD stash 对照
> 各连跑 8 次**：HEAD 侧 `1.8,1.7,1.7,1.9,1.9,1.8,1.8,1.8`（均值 **1.80**）、改动侧
> `2.0,2.3,2.2,1.6,1.8,1.9,1.8,1.9`（均值 **1.94**）—— **后 4 次两侧分布完全重叠**，
> 改动侧偏高集中在前 4 次，峰值 2.3 仅 run2 出现一次；`digP95` 两侧几乎相同。机制上不可能影响：
> `grep -rn "iso-icon" src/ui src/core src/render` **零命中** → 运行时不加载该模块
> （只被离线烘焙脚本 `tools/bake-icon-atlas.mjs`、单测、指纹门禁引用）。
>
> v1.29 修订说明：**设置面板「删除缓存」按钮**（2026-09-04，§4.8）。起因是用户要求在配置面板
> 增加一个「删除缓存」按钮。先澄清语义再动手（用户提问「点随机种子是不是就等于缓存全清了」）：
> 不是 —— `newWorld` 只清 edits，**保留 meta**（seed/spawn）且**完全不动 localStorage**。
> 项目里真正存在的本地持久化只有两处（grep 确认无 service worker / Cache Storage）：
> IndexedDB `mc_heavy_saves` 的 `edits` + `meta` 两个 store，与 localStorage
> `mc_heavy_settings_v1`。故「删除缓存」与「新世界」**语义不重叠**，二者区别如下：
>
> | | seed | edits | localStorage 设置 |
> |---|---|---|---|
> | 新世界（`newWorld`） | **换新** + 写回 meta | 清空 | 不动 |
> | 删除缓存（`clearSave`） | **保留** | 清空 | 不动 |
>
> 用户选定「只清存档改动（保留 seed）」→ 重载后地形回到该世界的**未修改原始版本**
> （红线 2：地形只由 seed 决定，edits 是叠加层）。实现上把 `newWorld` 原有的三步竞态防护
> 抽成 `Game._discardEdits()`，与 `clearSave` **共用一份** —— 写两份会漂移（红线 1 精神）。
> UI 侧为破坏性操作加 **armed 二次确认**（第一次点击只切到「确认删除？」，第二次才执行；
> 打开面板时复位，防 armed 态跨会话残留）。
>
> **竞态防护的实测口径修正（勿照推理实现）**。原注释写「不清内存 edits 就会被
> `beforeunload → flushNow` 写回」，**实测证伪了它的强度**：对照脚本只差一个变量
> （reload 前是否 await flushNow）—— 给卸载事务一点时间（多一次 evaluate 往返）确实写回
> （`savedColumns` 0→1）；紧跟 `location.reload()` 立即卸载则事务来不及提交就被中止、读回 0。
> 故该缺陷在生产路径上**时序不定**，端到端断言会碰巧读到 0 而让缺陷静默逃逸
> （负向验证实测：注释掉 `col.edits.clear()` 后 E2E 仍全绿）。
> **正确门禁 = 内存侧断言**：`tests/clear-save.spec.mjs` 直接断言 `_discardEdits()` 后
> `memEdits===0 && savedColumns===0 && editsCache.size===0`。负向验证实测：移除该步后
> 内存断言 FAIL（Received 1）、端到端断言仍 PASS → **印证两条断言的职责分工**。
>
> **另两处测试缺陷（RED 阶段实测暴露，均非产品 bug）**：
> ① 地形指纹不能用 `i += 997` 步长采样（`m3-hud`/`persistence` spec 的口径）—— 那边是
> 「换 seed」场景（整片地形全变）。本场景只改**一格**，采样和不变（实测基线与改动侧同为
> 50533）→ 改全量求和；② 导航监听必须在 click **之前**武装：`waitForLoadState('load')`
> 写在 click 之后会踩竞态（导航未开始 → 看到「当前页已是 load 态」立即返回 → `READY` 在
> **旧页**本就为真 → 读到 clear 之前的世界），表现为四项断言通过、只有 fp 多出一个
> stoneId（实测差值恰为 **48** = `stoneId`）。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 通过（arch 全绿 + data 7 项契约一致
> + lint 0 error、9 个既有 camelcase warning）；核心回归 7 passed
> （`clear-save` 2 + `m3-hud` 3 + `persistence` 2，`newWorld` 重构未破坏）。全量 44 passed /
> 2 failed（`m1-acceptance` 的 `placeP95`、`structure-gen` 的 `gen p95`），**交替对照实测
> 两侧分布重合**：改动侧 `1.7/2.0/1.9/1.8`（2 轮 4 次：3 通过 1 失败）、HEAD 侧
> `2.0/1.7/1.8/1.9`（1 通过 3 失败 —— **HEAD 侧失败率反而更高**）；`structure-gen` 两侧
> 各 3/3 全通过。机制上不可能影响：`clearSave`/`_discardEdits` 只在点击时执行一次，
> **不进主循环**（无热路径改动 → 不需 `bench --check`）。
>
> v1.30 修订说明：**沼泽睡莲（lilypad）水洞与沉水修复**（2026-09-05，§4.3）。用户报告两个
> 视觉缺陷：① 睡莲「镶嵌在沼泽水中」—— 自身无水、周围一圈水包围，像水洞而非浮在水面；
> ② 睡莲叶面与沼泽水方块**底面**对齐 → 沉在水面之下。用户同时提出修复思路（生成高度 +1
> 且叶面下移半格贴合水面）—— **思路可行，数值经实测验证正确**。
>
> **根因是两个独立问题，实测确认**（诊断脚本，落点 `(-600,-270)`，SEED=12345）：
>
> | 问题 | 位置 | 实测数据 |
> |---|---|---|
> | ① 水洞 | `apply.js:206` `setBlock(wx, SEA_Y, wz, 'lilypad')` | `fillColumn` 水面填充区间 `(h, SEA_Y]` → 沼泽落点 h=-3 时 **`y=-2` 就是最高一层水格**，被 lilypad 覆盖 → 该格水消失、四周水还在。附带：`lilypad.solid=false` → 玩家踩上去掉进洞里 |
> | ② 沉水 | `mesher.js` `TEMPLATES.lilypad` y=0.02 | 叶面 = 实例原点(块底角 -2) + 0.02 = **-1.98**；暴露水面顶面 = `(SEA_Y+1)` − `WATER_SURFACE_SINK`(0.5) = **-1.50** → 低 **0.48** |
>
> **为什么 mc-lite 沉水更严重却没被发现**：其实例原点 = `Math.floor(y)+0.5` = 块**中心**
> （`Chunk.js:2474`，对照 CLAUDE.md「+0.5 换算」口径），几何 `translate(0,-0.48)` →
> 叶面世界 y = **-1.98**，沉在整格水面顶面 -1.0 之下 **0.98**（mc-lite 自身即有此缺陷）。
> mc-heavy 的水面下沉 0.5 把差距缩到 0.48，反而更扎眼。且 mc-lite 的 lilypad 是**装饰实体**
> （`EntityManager.js:412`）**不占体素格** → 天然无水洞；是 mc-heavy 搬成体素方块才引入的。
>
> **修复须两处耦合改，单独改任一处都错**（只改几何 → 悬空半格；只改格位 → 贴块底仍沉水）：
> 模板 y `0.02` → `-0.48`，生成格位 `SEA_Y` → `SEA_Y+1`。详见 §4.3 lilypad 段。
>
> **落点判定的方法论坑（诊断实测，勿照直觉选测试落点）**：`pointContext` 里 city/island/
> pyramid/plainLand/snow/fm **六个地标判定都在 water 分支之前**，被地标吞掉的点 `ctx.kind`
> 不是 `'water'` → 根本不放 lilypad。实测只按「biome=SWAMP + h<SEA_Y + rand<0.08」三条件筛出
> **12 个候选点**，完整 GEN 后 **落地 0 个**（全被 clay/sand 地标方块覆盖）。必须复现优先级链
> 才能找到真实落点 —— 首个真实落点是 `(-600,-270)`。
>
> **Tier 1 门禁（`mesher.js`/`apply.js` 均在 testing-policy §2.1「纯函数算法」明确列举）**：
> 4 个新测试 RED → 验证 RED → GREEN（**277/277 全绿**）→ **双向负向验证**：
> 回退生成格位（`SEA_Y+1`→`SEA_Y`）→ 2 个生成侧测试 FAIL（均 `Expected 2(water), got
> 27(lilypad)`）而 mesher 几何测试 PASS；回退模板 y（`-0.48`→`0.02`）→ 3 个几何/高度测试
> FAIL 而「生成位置」测试 PASS。两侧各自独立钉住自己的不变式，职责分工清晰。
>
> **自查发现自己测试的恒真弱点并修掉（负向验证的第二轮）**：初版「叶面高度」测试把生成格位
> **硬编码**为 `SEA_Y + 1` 来算 `lilyY`，而这正是 `apply.js` 里写入的值 → 测试与被测代码
> **共用同一个假设**。实测证实弱点：回退格位到 `SEA_Y` 后该测试**仍 PASS**（拿硬编码值算出
> 「叶面 -1.48 > 水面 -1.50」）→ 缺陷静默逃逸。改为**从实际生成数据里扫描出 lilypad 的真实
> 格位**再算高度，并加「水面格 y=SEA_Y 须仍是水」前置断言。重做负向验证：回退格位后
> **两个**生成侧测试都 FAIL（强化前只有 1 个）。这是 CLAUDE.md「对照脚本与被测代码必须只差
> 一个变量」同一原理在**测试内部**的体现，判据见 testing-policy §2.5。
>
> **Tier 4 像素级实测（用户报的是视觉 bug，单测数值对不等于渲染呈现对）**：睡莲贴图主色
> `rgb(34,139,34)`（51% 不透明）作像素基准，传送到落点上方 6 格垂直俯视截图。**担心的风险**：
> `ocean.js` 无限海面平面在 y=-1.5、`renderOrder=1`（体素透明通道之后绘制）、
> `depthWrite=false`，而叶面在 -1.48 只高出 0.02 → 若海面盖住 cutout 通道的 lilypad，
> 单测全绿但玩家仍看不到睡莲。实测**未盖住**（lilypad 在 cutout 通道写深度）：
>
> | | 格位 | 画面中心睡莲绿 | 全画面 |
> |---|---|---|---|
> | HEAD（旧） | `atSea=lilypad / atSeaPlus1=air` | **30**/14641（0.20%）| 1752 |
> | 改动侧 | `atSea=water / atSeaPlus1=lilypad` | **266**/14641（1.82%）| 5243 |
>
> 中心区域 **8.9 倍**差异：HEAD 侧睡莲沉在水下（y=-1.98）被水体遮挡只剩残影。断言 `>100`
> 在 HEAD 侧 FAIL(30)、改动侧 PASS(266) → **像素断言有真实区分度，非恒真**。
>
> **文档同步**：§4.3 新增 lilypad 有意偏离段（第 ④ 项）+ 顶点模板清单 y 值勘误；
> CLAUDE.md「三处已知有意偏离」→ **四处**、新增「lilypad 几何与格位耦合」活跃约束；
> 两处「`structures/*.json` 原样复用」约定（CLAUDE.md + 附录 A 映射表）标注 `big_house.json`
> **唯一例外**。
>
> **全量门禁**：`npm run check` 全绿（check:arch + check:data 8 项契约 + lint 0 error /
> 9 个既有 camelcase warning）。`npm test` **45 passed / 1 failed**，失败的是 `m1-acceptance`
> 的 `placeP95`（CLAUDE.md 点名的已知贴线 flaky）。**交替对照实测**（各连跑 3 次，阈值是
> 冻结断言故未放宽）：改动侧 `placeP95 1.9/1.6/1.7`（**全部 <2ms 通过**，1 次全绿、2 次失败
> 均为 `frameMs.p95` 贴 16.7±1e-6）、HEAD 侧 `placeP95 1.8/1.9/2.0` + `digP95 2.0/2.1/1.9`
> （**3/3 全部失败**）。**HEAD 侧失败率 100% > 改动侧 33%**，且失败断言位置在轮换
> （placeP95/digP95/frameMs.p95 都出现过）→ 非本次改动引入。机制上不可能：改动只碰 GEN 期
> 格位与几何 y 值，**都不进主线程每帧热路径**（无热路径改动 → 不需 `bench --check`）。

> v1.31 修订说明：**AO 去掉对角门控**（2026-09-05，§4.3）。用户报告实玩观感缺陷：方块两个
> 面（如东+南）都是墙角时，两条阴影各沿凹角向外**垂直延伸**，而**东南对角的地面格完全不
> 参与** → 阴影在对角处断开，露出一条「阴影的边」。用户明确希望消除该断层。
>
> **根因实测定位（未猜）**：`mesher.js` `getAO` 的对角门控 `const c = (side1 || side2) ?
> (corner ? 1 : 0) : 0`（mc-lite `AOUtils.getAOValue` 逐行一致，Minecraft 原版语义——对角
> 方块物理上不太遮挡该顶点，故两侧都开阔时对角遮挡不计入）。隔离场景实测（y=0 整片地面 +
> `(8,1,8)` 单个墙角块 B）：
>
> | 地面格 | 相对 B 方位 | 靠 B 那两角 AO |
> |---|---|---|
> | `(9,0,8)` | 东 | **2**（有阴影）|
> | `(8,0,9)` | 南 | **2**（有阴影）|
> | `(9,0,9)` | **东南对角** | **3**（全亮，断层成因）|
>
> **同一空间顶点 `(9,1,9)` 在不同 quad 里 AO 不一致**（块 `(9,0,8)` 顶面算 2、块 `(9,0,9)`
> 顶面算 3）—— 这是断层的直接机制证据（AO 逐顶点写入，共享顶点各块各算一份）。
>
> **修复**：去掉门控 → `return 3 - (side1 + side2 + (corner ? 1 : 0))`。实测对角格该顶点
> AO 由 3 → **2**，同一空间顶点在所有 quad 统一为 2，阴影连成环。
>
> **已知的有意偏离 mc-lite（第 ⑤ 项）**：副作用是**全局**的，不只墙角 —— 所有「两侧开阔、
> 仅对角遮挡」的顶点都会暗一档（悬浮方块斜对角、台阶斜接处等），原版 Minecraft 故意让这些
> 不变暗。实测副作用范围有限（多数对角遮挡都伴随至少一侧遮挡）。**视觉比对 mc-lite 时勿按
> 其原样判定**。
>
> **Tier 1 TDD**（AO 属 testing-policy §2.1「纯函数算法」，改坏了是静默视觉错误）：
> 新测试「AO 仅对角遮挡顶点 AO=2」RED → 验证 RED（`Expected 2, got 3`，用例数 277→278
> 确认已注册在跑）→ GREEN（**278/278 全绿**）。断言刻意避开两个恒真陷阱（§2.5）：
> ① 期望值 2 由「3 − (0+0+对角遮挡1)」手算得出，**非**硬编码被测代码写入的值；
> ② 按「位置 + 顶面 face 位」定位顶点而非依赖顶点序，并断言**跨 quad 一致**。
> **踩坑记录**：首版断言误用世界坐标定位顶点，而 `positions` 是 **section 局部坐标**
> （mesher 推 `lx/ly/lz`）→ 前置断言 `count>=3` 拿到 0，得到的是「定位失败」而非「AO 失败」
> —— 这不是有效 RED。改为显式推导 `lyTop = y0 - WORLD_MIN_Y + 1` 后才拿到真实 RED。
>
> **Tier 4 像素实测**（`tests/ao-corner-visual.spec.mjs` + fixture `src/tests/test-ao-corner.html`）：
> 取样点由 fixture **投影世界坐标**暴露（`window.__AO_PROJ__`），spec 不硬编码像素位置。
> **取样必须紧邻角顶点** —— AO 逐顶点插值，顶面**中心**是四角平均（≈2.75），信号被稀释
> （首版取顶面中心 → `ratio=0.994` 恒真，无区分度）。断言用「同相对位置的开阔对照」
> （`(5,5)` 角同样位置但四周无遮挡 → 恒 AO=3）排除「靠近格角本身就暗」的混淆变量：
>
> | | `nearCorner` | `controlCorner` | 比值 |
> |---|---|---|---|
> | HEAD（门控）| 69.23 | 64.87 | **1.067**（无阴影，比对照更亮）|
> | 改动侧 | 55.22 | 64.87 | **0.851**（有阴影）|
>
> 约 **19%** 差异，HEAD 侧 FAIL、改动侧 PASS → 像素断言有真实区分度、非恒真。
> **被否决的一条断言（记录以免重犯）**：曾试图断言「穿过 `z=9` 块边界的扫描线亮度连续」，
> 实测 `maxJump=0.1399` FAIL —— 但这**不是 bug**：块 `(9,0,8)` 沿 `x=9` 边有**两个**暗角
> （`(9,1,8)` 被 side 遮挡 + `(9,1,9)` 对角），块 `(9,0,9)` 只有**一个**对角暗角 → 跨界亮度
> 回升是**正确行为**，不是断层伪影。改为断言「阴影梯度延伸进对角格内部」。
>
> **门禁**：`npm run check` 全绿（0 error / 9 个既有 camelcase warning；图标指纹检查通过 →
> **无需重跑 `npm run icons`**，图标烘焙不吃 AO）。`npm test` **46 passed / 1 failed**（新增 ao-corner-visual spec 后用例数 45→46），
> 失败的仍是 `m1-acceptance` 的 `frameMs.p95`（`16.700000762939453` vs 门限 16.7，超出
> **7.6e-7**，即 float32 表示 16.7 的下一个可表示值）。**交替对照**：HEAD 侧连跑 3 次
> **同样失败、数值完全一致** → 与本次改动无关（v1.30 修订说明已记录同一现象：HEAD 侧失败率
> 100%）。改动侧 bench **`--check` 通过**（fps=120、draw call 489~545 与基线一致）—— mesher
> 属热路径故按门禁分层加跑。

> v1.35 修订说明：**设置面板改两列布局 + 精简档位**（2026-09-07，§4.8）。起因是用户反馈
> 面板「按钮过于拥挤」——后续第二阶段（M5~M7 实体/丧尸/巢穴）会持续加入新配置项，
> 单列布局每加一组就增高一行，版面撑不住。
>
> **布局**：改为 mc-lite 同款两列盒（`.settings-columns` + `.setting-combined-item` →
> 本仓库 `.mc-columns` / `.mc-combined`），但行列分配按 mc-heavy 当前档位需要重排，
> **不沿用 mc-lite 的分配**（mc-lite 左列塞了画质/贴图模糊/色调偏移/丧尸数量/TNT 破坏等
> 本仓库尚无的功能）。最终分配：左列 = 画质+枪械破坏合并盒 / 环境风格；
> 右列 = 视距 / 帧预算 / 世界操作。**后续新配置优先往右列填**（纵向余量更大）。
>
> **档位精简**（三项，均不改变生效语义）：
> ① **视距 UI 档位 5 档 → 3 档**（`[4,6,8,12,16]` → `[8,12,16]`）。注意 `clampVD` 的钳制
> 范围 **2~16 不动** —— 那是架构口径（M1 测试/调试依赖 `vd=2`、既有 spec 用 `vd=4`），
> 面板档位只是「快捷选择」子集，两套口径不可混为一处。故面板须容错「当前值不在档位内」
> （URL 或旧存档带来 `vd=4` → 无按钮高亮）；**刻意不做「就近高亮」**，那会让按钮宣称
> 一个非生效值。② **音量档移出面板**（默认 100% 开启）。`settings.js` 仍持久化该字段、
> `?volume=` URL 仍可达 —— 音频消费方接线（§9 扩展点）时不必改数据模型。
> ③ **新世界 + 删除缓存共用一行**，语义区别落在下方一行小字（原各占一行 + 各带一行说明）。
>
> **顺带修掉一处文案漂移**：`_resetDangerArmed()` 把「删除缓存」按钮文案**写死成旧长文案**，
> 覆盖了构造时写入的短文案 → 面板打开后按钮显示的是复位那份，构造代码里的短文案形同虚设。
> 抽成共用常量 `CLEAR_SAVE_LABEL`（写两处会漂移，红线 1 精神），并在
> `tests/clear-save.spec.mjs` 补常态文案断言钉住。
>
> **测试代理档位替换**：两个 spec 原用「音量 50%」按钮作「改设置」的代理，档位移除后须换。
> `m3-hud` 换帧预算 60Hz 档（同为「运行时即时 + 持久化」，验证路径等价）；
> `clear-save` 换环境风格 night —— **不用帧预算档**，因为 `low` 档会降低 scheduler 每帧
> 预算、拖慢该 spec 的 `STABLE` 收敛（地形指纹断言依赖世界稳定）。
>
> **合并盒上边框缺失（用户报告，本次改动引入）**。两列布局的分隔线规则写成
> `#settings-modal .mc-column > :first-child { border-top: none }` —— 意图只是「去掉列首项
> 的分隔线」，但它**通配了所有子项**：合并盒恰是左列首项，且其装饰边框规则
> `#settings-modal .mc-combined`（特异性 **1,1,0**）被 `:first-child` 那条（**1,2,0**）压过
> → 上边框被置 `none`，方框缺一边。**根因实测定位（未猜）**：`getComputedStyle` 读四边得
> `Top: 0px/none`、其余三边 `1px/solid` —— 只有上边缺，正是特异性覆盖的特征。
> 修复：分隔线规则只作用于 `.mc-item`（行型，`.mc-column > .mc-item` +
> `> .mc-item:first-child`），合并盒的四边框不再被波及。
> **CSS 特异性 bug 肉眼看不出根因**（观感上只是「少一条线」），改 CSS 时极易再踩，
> 故补断言钉住「合并盒四边都是 solid」+ **负向验证**（回退通配写法 → 该断言 FAIL，
> 其余用例不受影响）。
>
> **一处自己的失误（记录以免重犯）**：修上面这条时，在 CSS 注释里用**反引号**包裹标识符
> （`` `.mc-item` ``），而 `PANEL_CSS` 是 **JS 模板字面量** → 反引号提前终止模板字符串，
> 整个模块解析失败（`node --check` 报 `Unexpected token :`）。**后果是游戏页直接白屏
> 加载不出来**（不是面板样式错，是整个页面挂），一度误判为「服务端口有问题」。
> 教训：模板字面量内的注释禁用反引号包裹；改完 `src/**/*.js` 先跑 `npm run lint`
> （lint 能抓解析错误，比 `node --check` 更贴近门禁口径）再做实测。
>
> **门禁对照**（未凭文档结论免责）：`npm run check` 全绿（arch + data 7 项契约 + lint
> 0 error / 9 个既有 camelcase warning）；单测 **296 全绿**（新增「视距 UI 档位落在钳制
> 范围内 + 默认值在档位中」契约断言）。**负向验证**：把档位临时改为 `[8,12,20]` → 该断言
> FAIL（`档位 20 不被钳制改写: Expected 20, got 16`，其余 295 条不受影响）→ 印证它钉的
> 正是「按钮宣称非生效值」这条失效路径。合并盒四边框断言同样做了负向验证（回退通配写法
> → 该断言 FAIL，其余用例不受影响）。**布局经 DOM 几何实测确认**（截图无法目视）：
> 面板 818×398、两列各 375×255（等高）、合并盒四边 `1px/solid` + 两组按钮同 y（共用一行）、
> 世界两按钮同 y、音量档已消失、视距档位 `[8,12,16]`、删除缓存常态文案 `删除缓存`、
> **零文本溢出**（逐元素 `scrollWidth > clientWidth` 检查全空）。
>
> **全量 E2E 55 passed / 1 failed**，失败的 `m1-acceptance` 的 `digP95 < 2` 是**已知 flaky
> 计时断言**（2ms 贴线，v1.30/v1.31 修订说明已记录同类现象）。**未凭「机制上不相关」免责**，
> 按 testing-policy 做了**交替对照**（每轮 HEAD 一次 → 改动侧一次，消除单侧连跑的负载累积
> 顺序效应；注意首次单侧连跑的数据因顺序效应不可比）。`digP95` 各 9 样本：HEAD
> `2.4,1.7,1.8,1.8,1.7,1.6,1.8,1.7,2.0`（均值 **1.833**，失败 3/9）、改动侧
> `2.1,2.1,1.9,1.7,1.7,1.9,2.0,2.3,1.7`（均值 **1.933**，失败 5/9）—— **两侧都会失败、
> 分布重叠**。改动侧略高约 0.1ms，方向一致但样本量小；**未宣称「已排除」**，只能说无机制
> 相关性（`grep` 确认放挖热路径 `world.setBlock`/`scheduler.remeshSections` 零命中面板代码，
> spec 用 `vd=8` 在新旧档位列表中都存在 → 无钳制差异，且两列布局 DOM 节点比原来更少）。

> v1.39 修订说明：**M8 TNT / 炮塔弹丸的三项架构口径变更**（2026-09-11，§4.1 / §4.5.5 /
> DR-17 / §9）。属第三阶段第一个 Epic 的设计同步（规格
> `docs/superpowers/specs/2026-09-11-m8-tnt-turret-design.md`）。与 M4~M7 的实玩反馈修正
> 不同（那些**不进**修订说明），本节的三项是**新数据通道 / 新子系统边界**，故进修订说明并
> bump 版本号。⚠️ **v1.36~v1.38 已被 roadmap 的「第一阶段独立改动」表占用**，故 M8 取
> v1.39、M9 取 v1.40（避免撞号）。
>
> ① **`indestructibleTable` —— registry 的第 8 张 typed 属性表**（§4.1）。「哪些方块不可被
> 破坏」此前散落在三个消费者各自的字面量里（徒手挖块 / 枪械破坏 / 爆炸过滤），收敛成单一
> 权威。mc-lite 侧的证据是「分散且不重合」：`ExplosionWorker.js:8` 的字面量数组含
> bedrock/barrier/playground 四项，而 `BlockData.js:244/252` 的 `isIndestructible: true`
> **只标了 playground 两项** —— 上游没有一个完整清单，照搬任一处都会漏。M8 只登记
> `bedrock`；创造台两项移交 M9（登记 indestructible 与「移出背包」必须成对做，只登记不移出
> 会产出「放得出来但挖不掉」的撕裂状态）。顺带补齐文档欠账：§4.1 此前只在散文里点名过
> 2 张属性表，现写出 8 张完整清单。
>
> ② **爆炸计算与炮塔 LOS 留在主线程 —— 红线 3 的边界判定例外**（新增 §4.5.5）。爆炸 =
> 152 次 `getBlockId`（比 M7 放 38 格结构还轻）且须与音效/特效**同帧**；炮塔 LOS 依赖世界
> 数据，而世界数据的唯一权威在主线程（红线 1）—— 把计算搬去 Worker 就必须把数据也搬去
> （每 RPC 约 1.28MB、8Hz → 每秒 10MB 结构化克隆）。两者都抽成无 DOM、无 three 的同构纯
> 函数（`check:arch` 静态门守），浏览器内单测可直接调 —— 与红线 8 的目的（可测性）一致，
> 只是执行侧不同。归属 `src/voxel/` 而非 `src/gen/`（爆炸是体素层查询，不是生成）。
>
> ③ **DR-17 的 blockEntity 通道经第二批消费者验证**（DR-17 回填 + §9 扩展点表）。
> `turret` 锚点（`{kind:'turret', id, origin, critical, rotation, lastFireAt}`）复用 M7 的
> 装置模式（`block-changed` 增量失效 + `listBlockEntities(kind)` 扫库判上限），未引发
> schemaVersion 变更。§9 的 TNT / 炮塔两行标为「✅ M8 实施中」，并把接入点表述改成实际
> 路径：TNT 走 `setBlocks(batch)` + REMESH + **球体扩张特效**（mc-heavy 无粒子系统，
> 不移植 mc-lite 的 2D Billboard 爆炸粒子 —— 属可感知偏离，已记进 M8 偏离表）；炮塔走
> M5 `EntityManager` + 实体射线 + **M7 方块锚定装置模式**。创造台那行留给 M9（届时改写为
> `setBlocks` 真实方块路径，不是「mesher 顶点模板机制」）。

> v1.40 修订说明：**M9 创造台的三项架构口径变更**（2026-09-12，§4.5.4 / §5 / DR-17 / §9）。
> 属第三阶段第二个 Epic 的设计同步（规格
> `docs/superpowers/specs/2026-09-11-m9-playground-design.md`）。本节两项同样是**新数据通道
> 消费者 + 物品集合口径**变更，故进修订说明并 bump 版本号（v1.39 已被 M8 占用）。
>
> ① **DR-17 的 blockEntity 通道经第三批消费者验证**（DR-17 回填 + §9 扩展点表）。
> `playground` 锚点（`{kind:'playground', id, origin, size}`）复用 M7 装置模式的**持久层
> 半边**（`listBlockEntities(kind)` 扫库恢复 + 判上限），但**不复用 controller / 增量失效
> 那半边** —— 创造台不刷怪、不射击、无运行时行为，它的 `blockEntity` 只是「平台在哪、多大」
> 的持久真相（关闭时由 `origin + size` 确定性重算枚举，见本节 ③）。三个 kind
> （zombie-nest / turret / playground）共用同一 edits 通道，未引发 schemaVersion 变更。
> §9 的创造台那行标为「✅ M9 已交付」，并把接入点表述订正为实际路径：走
> `WorldEditor.setBlocks` 的**真实方块**（平台是可挖可放的真实体素），
> **不是**「mesher 顶点模板机制」（原表述是 M8 之前留下的规划语，与实际实现不符）。
>
> ② **物品集合口径 118 → 116**（§4.5.4）。创造台两项（`playground_block` /
> `playground_center_block`）加进 `HIDDEN_FROM_INVENTORY`（4 → 6 项），门禁打印的
> 「排除 N」是两个排除集合之和（8 → 10）。**这不是「新增排除项」的常规改动，而是一处既有
> 偏差修正**：本仓物品集合是**派生集合**（registry − 排除集合），而 mc-lite 是**手工列举**
> （`Game.js:206-321` 实测 107 行 `inventory.add(...)` 匹配，其中 2 行被注释掉
> （`handrailB` / `cloud`）→ **有效 105 项**）且天然不含这两项。派生口径下它们此前就在背包里
> → 玩家能从背包选中并放置平台方块；配上 M9 的 `indestructible` 登记会产出**撕裂状态**
> （放得出来但挖不掉、TNT 也炸不掉，只能靠「关闭创造台」批量删）。故登记与移出**必须成对做**
> —— 这也是 M8 / M9 拆分的分界依据（M8 期间两项都不碰 → 无害）。
> 这是一处新的有意偏离 mc-lite（**不并入** §4.3 / §4.5.4 那个视觉比对专用的编号清单）。
>
> ③ **平台方块集合不维护副本 —— 红线 1 的具体应用**（§4.1 数据权威 / DR-17）。mc-lite 的
> `playgroundBlocks: Set<'x,y,z'>`（2916 个字符串键）不移植：平台是规则 54×54 矩形，
> 坐标由 `origin + size` 纯计算得出 → 关闭时枚举即可。把它记下来会引入「平台有哪些方块」的
> 第二份权威（且与 `blocks` typed array 必然漂移 —— 玩家挖掉一格平台后方块集合就成了谎话）。
>
> v1.41 修订说明：**水面遮罩判据的两项架构口径变更**（2026-09-12，§4.7）。
> 由用户实玩反馈触发（「city 城堡附近下挖一两个方块就看到水面」），属**架构口径变更**
> （新增判据权威文件 + 跨层共享常量 + 与 mc-lite 的有意偏离），故进修订说明并 bump 版本号。
> 完整判据口径、实测数据与偏离理由见 **§4.7 的「水面遮罩判据」与「城市内无水体残留」两段**
> （此处不复制数字 —— 同一事实的多个副本会漂移）。两项变更：
>
> ① **遮罩高度改为真实生成高度 `generateHeight` + 阈值取 `SEA_Y`**，并新增判据唯一权威
> `render/ocean-mask.js`（CPU 版供单测断言，`ocean.js` 的 TSL 版同构实现共用其数值常量）。
> 数值常量提到 `gen/terrain.js` 的 `TERRAIN_HEIGHT_PARAMS` 与 `gen/noise.js` 的 `BIOME_PARAMS`
> —— TSL 无法调 JS 函数只能同构实现，各写一份字面量会漂移出「生成侧的地形与遮罩判的
> 不是同一套高度」（红线 1；M6 同教训：两层共用的阈值须落在单一权威）。
> 这是一处新的有意偏离 mc-lite（mc-lite 用基础噪声近似 + 阈值 -0.8，实测城外假水面 19.3%）。
>
> ② **`generateCity` 补实城市内的水体残留缺口**，对齐 mc-lite 分支链语义（城内不填水体）。
> 根因是架构差异：mc-lite 的 elif 链让「城市」与「填水体」互斥；mc-heavy 是
> `fillColumn` 无条件填整列 + `generateCity` 覆写，覆写不到的水体残留。这是①的城市 bounds
> 门控能「零误伤」的前提（bounds 内确实无水体）。⚠️ 勿按「城内真实水方块 = 0」的旧口径写注释
> —— 那只对城堡 ±16 核心区成立，bounds 全域曾有 16600 格残留（其中 56 格暴露）。
>
> v1.42 修订说明：**天空树回补 + `sky_leaves` 通道修正**（2026-09-20 起草 / 2026-09-29 实施，
> §4.1 / §4.2）。由用户实玩报告触发（「空岛之上没有树」，mc-lite 有）。
>
> ① **部分反转 v1.14**：M2-7 按当时产品范围删除的「空岛宝箱与天空树」中，**天空树回补**
> （mc-lite `Island.js:44-50` 的顶层逐格 10%；⚠️ **本仓取其一半 5%** —— 用户 2026-09-29 指令
> 「生成密度减少到原来的一半」，故 `SKY_TREE_CHANCE = 0.05` 是**有意偏离 mc-lite**，
> 观感从 mc-lite 的「连绵叶团」变为「疏朗树木」）；**宝箱仍不迁移**。实现为
> `sky-structures.js` 的 `writeSkyTrees()`，追加进既有固定层序（云 → 岛体 → 树），
> 树基点 `topY+1` 与岛体几何不重叠。salt 取 **113**（程序化扫描确认空闲；**不能用 59** ——
> 云簇 frontier 的 `seed+58+step` 在 `size ∈ [30,50]` 下实际占用 **58..107 连续区间**）。
> 岛层半径抽出单一权威 `islandLayerRadius()`（红线 1）；候选 AABB 门控比岛体**宽 2 格**
> （树冠外扩 ±2，否则跨界树冠在相邻 column 断裂缺角、而岛体看起来完全正常 → 难归因）。
>
> ② **§4.1 cullMode 勘误段补记 `sky_leaves`**：`sky_leaves` 由 `cutout` 改 `opaque`。根因是 M2-7
> 按「名字含 leaves」归类（`blocks-data.js:6` 的转换规则），而 mc-lite 的材质是
> `mkMat('#FF69B4', 0.9)` = `transparent + opacity`，**无 `alphaTest`** → 不是镂空。
> 且 cutout 通道 `alphaTest=0.3` 且无 `transparent` → 贴图 alpha 0.902 全保留不混合，
> **实际渲染自 M2-7 起就是不透明纯粉**（atlas tile 中心实测 `[255,105,180,230]`），
> 故改 opaque **视觉零变化**，只让声明与实际一致。收益：`opaqueTable[sky_leaves]` 0→1
> 使 `mesher.js:464` 的通用面剔除对叶-叶相邻面生效 → 总面数 735,576→700,064（−4.8%）。
> 代价（三项有意偏离 mc-lite，详见 spec §2.6.3）：`sky_leaves` 开始遮挡 AO
> （mc-lite `AOUtils.js:376` 的 `isOccluding = !isTransparent` → 不遮挡）、阻断 blocklight、
> 阻挡炮塔 LOS / 弹丸（mc-lite `Turret.js:565` 同判据 → 不阻挡）。
>
> ③ **容量口径不变**：三通道 `CAPACITY` 与 §4.10 的 150MiB 预算**均不放宽**（实测三通道
> `_capacity.*.maxVertexCount` 全部等于标定值 = 零扩容；`gpuVertexBytes` **148.06MiB** < 150MiB，
> 余量 1.94MiB）。⚠️ **占用百分比口径**（vd=8 / seed=12345，实测数，非勘查期估算）：
> 稳态（289 列队列全收敛）opaque **82.9%** / cutout **72.3%** / transparent **10.6%**；
> 冲刺峰值（12s 奔跑、250ms 采样）opaque **93.8%** / cutout **81.9%** / transparent **11.2%**。
> 其中 cutout 的高占用是 **HEAD 既有状态**（撒布补齐 `87cd571` 后花/树叶进 cutout），本次把
> `sky_leaves` **移出** cutout 反而使其降低；transparent 的 41%（spec §4.3 勘查值）是**冲刺态**
> 水面大量暴露的数字，不是 289 列稳态数字。⚠️ opaque 冲刺峰值余量已收窄到 6.2%，
> 后续往 opaque 通道加量前须重测。
>
> ④ **性能实测（含一处冻结断言的用户裁决放宽）**：全场景 GEN p95 **1.534ms**（HEAD 1.206ms，
> **+0.33ms**，远低于 §4.2 预算 → 未撞线）；MESH **+0.4%**（交替对照，vd=6/169 列各 5 轮取中位）。
> ⚠️ **`structure-gen` fixture 的「含结构 genP95」门曾撞线，密度减半后已回落**：
> 密度 0.1 时实测 **8.5~8.8ms**（4 次单独复跑分布极窄 → 非负载噪声），机制 = 该 fixture 的测量域是
> **空岛密集区**（region `(-4,-4)` 金字塔 column 周围 4×4 column 内实测 3 个空岛、圆内 563 顶层格
> → 约 56 棵树集中进这 16 个 column 的 GEN 计时路径），树密度远高于全场景平均 → +0.33ms 的
> 平均增量在岛密区被放大到约 +1ms（基线 7.7 → 实测 8.5~8.8）。**用户 2026-09-29 裁决放宽该冻结
> 断言 8ms → 10ms**（只改 `test-structure-gen.html` 的含结构门；`test-worker-gen.html` 的**无结构**门
> 逐字未改，仍守 8ms）。§4.2 档位口径澄清：本文 §4.2 原文「单 column GEN（**无大结构**）目标 < 8ms；
> 含城市结构切片 < 25ms」—— 8ms 档本就是「无大结构」口径，而该 fixture 的 GEN 调用**携带 `layouts`**
> （含结构注入）属 25ms 档，故 **10ms 相对 §4.2 原文是保守值**。
> ⚠️ **同日密度减半（0.1→0.05）后该域树数 ≈28，genP95 实测回落到 7.6~7.8ms（已回到原 8ms 预算内）**。
> 用户裁决**保留 10ms 作余量**而不收回 8ms —— 理由：本门是**单样本 p95**（无平均、无舍入），
> 7.6~7.8 对 8ms 只剩 2.5% 余量，高负载下会贴线抖动。**故 10ms 现在的性质是「保守余量」
> 而非「撞线所需」** —— 后人读到这条不要以为当前密度仍在撞线。若天空树密度或 GEN 成本再涨，
> 该门须**重新实测**而非再次静默放宽。
> 另 **draw call 不是 +0**：bench 场景 ④ 实测 MOD **545** vs HEAD **530**（**+15**）——
> WebGPU 后端对 BatchedMesh 的**每个可见 geometry slot 各发一次 draw**
> （`three.webgpu.js:85531`），天空树新增可见 opaque slot 即增 draw。spec §4.3 勘查期写的
> 「draw call +0」是**按「合批进既有 3 通道」推断**，已被实测证伪（该值不在门禁
> LOWER_IS_BETTER 集合内，不阻断）。
>
> 规格 `docs/superpowers/specs/2026-09-20-sky-tree-design.md`（§10 有完整实施结果回填）。
>
> v1.43 修订说明：**进度包导入导出**（2026-09-30，§4.8 / §4.5.4）。由用户要求在设置面板
> 增加「导入进度 / 导出进度」两个按钮触发（放在「打开创造台」右侧，该行标题改为
> 「创造台和进度管理」；后按用户实玩反馈改为**进度另起独立一行**「进度管理」，见 §4.8 的 ⑧ 条）。
>
> ① **「进度」的定义 = seed + 玩家改动差异 + 持久实体**（§4.8）。本仓世界由 seed 确定性生成
> （红线 2），存档只存 diff，故进度包 = `meta.seed` + `edits` store 全量 + `entities` store
> 全量。**不导出逐格地形**：视距 8 的 289 个 column 全量约上亿字符，而地形本就由 seed
> 重算得出。也**不导出玩家位置**（消费它需要改出生点逻辑，与既有 `meta.spawn` 语义冲突，
> 导入后仍出生在城市中心），也**不导出设置**（设置是设备级的、存 localStorage，见 v1.15 ②）。
>
> ② **格式是 mc-heavy 自有格式（`format: mc-heavy-progress` + `version: 1`）**，不复用
> mc-lite 的存档格式（那是 roadmap 的「存档迁移」扩展点，两者目标不同：进度包是**同版本内**
> 的存档搬运与备份，迁移工具要处理**跨版本**的方块与结构语义变化）。方块存**名字**而非数字
> id —— id 是注册顺序的产物，用 id 存盘的包在 `blocks-data.js` 增删方块后会**静默错位成别的
> 方块**。坐标存**世界坐标**（导出侧由 `decodeBlockIndex` 反解 index、导入侧由 `blockIndex`
> 回写，编码与其逆同放 `voxel/constants.js` 以杜绝两处算术漂移）。导入侧**未知方块名计
> invalid 并跳过，绝不写 air**（id 0 会静默删掉玩家已有的方块，与 M9 模型导入同一坑）；
> `version` 高于当前 → `unsupported-version` 拒绝，不猜着读。
>
> ③ **逻辑与 I/O 分离**：编解码是 `save/progress-codec.js` 的纯函数（无 DOM/three），
> `Game.exportProgress()` / `Game.importProgress()` 只做「落库读盘 → 编解码 → 文件 / 持久层
> 写入」。这样坐标换算与坏条目分类能被浏览器内单测直接钉住（`src/tests/test-progress.js`），
> 面板只负责文件 I/O 与 toast。
>
> ④ **两条接线口径**（都是「方块层面看不出差别」的静默失效类）：
> **导出前必须 `flushNow(world)`** —— 内存 edits 才是真相，5s 防抖到期前刚放下的方块还没进
> `edits` store，不先落库就导出一份旧进度（文件照样合法，只有导入后才发现少方块）；
> **导入必须走 `Game._discardEdits()`**（v1.29 建立的**唯一丢弃入口**）—— 否则旧世界的改动
> 残留，重载后新旧方块混在一起。
>
> ⑤ **导入是覆盖式且非原子**：清空当前全部改动 → 写 `meta` → 写各 column edits → 写 entities
> → 重载。中途 IndexedDB 写失败会停在「已清空」状态并 toast 报错；重新导入一次即可（幂等）。
> **不引入临时 store 交换**（那需要 DB 版本升级，成本远超收益）。**无二次确认**（用户批准
> 方案时已知）：导入前可先导出备份。
>
> 测试：`src/tests/test-progress.js`（codec 往返 / 分类 / 零输出，Tier 1）+ `tests/progress.spec.mjs`
> （E2E：导出下载内容含刚放进内存的方块、导入写入包里的 seed 且清掉旧改动、四个坏文件被拒且
> 不重载、busy 锁、面板两行布局与按钮几何）。
>
> ⑧ **面板布局按用户要求改过一次（2026-09-30 同日，用户实玩反馈）**：交付版是「创造台 +
> 进度」合一行（`[打开创造台(窄)][导入进度][导出进度]` / `[导出模型][导入模型]`），用户要求
> **拆开**：进度另起一个独立行（标题「进度管理」、在创造台行**下方**），创造台行**不再有第二行**
> —— 模型两个按钮**挤进主按钮同一行**，未激活时「打开创造台」**独占满行**，激活后三按钮由
> `flex:1` 平分该行，关闭后模型按钮消失、主按钮恢复满行。`.mc-narrow`（88px 变窄）与
> `mc-playground-models` 第二行随之下线，**行标题回到「创造台」**、新增 `PROGRESS_ROW_TITLE`。
> 理由：进度管整个世界的存档、创造台管平台与模型，两者功能域不同，合在一行会让玩家分不清
> 按钮归属。E2E 判据同步改写为**结构 + 几何双向**：两行是两个不同 `.mc-item` 且进度行在下方 /
> 模型按钮与主按钮 `parentElement` 相同（同一按钮组）/ 未激活时主按钮宽 ≥ 组宽（独占满行）/
> 激活后三按钮 `top` 相同且两两宽度差 ≤2px / 关闭后再量主按钮回到满行宽。
>
> ⑥ **负向验证（5 条逐条实测确认真 FAIL）**：① 去掉导出前的 `flushNow` → 导出包里不含「仅在
> 内存」的方块（注：第一版脚本在别处已 flush 过的旧格上验证，得出「仍找得到」的假结论 —— 改用
> **新放的**一格才成立，是「对照侧与被测侧必须只差那一个变量」的又一实例）；② 注入「导入不调
> `_discardEdits`」→ 库里旧 column 残留（`savedColumns` 1→2）；③ codec 未知方块名写 air 的注入版
> → 产出条数 1→2；④ `decodeBlockIndex` 列宽写错（16→32）→ 互逆率 32768/32768 → 2048/32768；
> ⑤ 面板布局断言对「模型按钮另起一行 / 主按钮变窄」敏感（实测几何：主按钮 88px、
> 两个进度按钮各 127px、`scrollWidth <= clientWidth` 文案不换行、面板外框 818px 未变）。
> ⚠️ 该条对应的是**拆分前的交付版布局**（⑧ 之后 `mc-narrow` 已下线）—— 保留作历史记录，
> 现行判据见 ⑧。
>
> ⑦ **实测发现一个既有缺陷（已登记，本任务未修）**：远离出生点的 column 的持久 edits
> **不会应用到世界**（走远 → 重启 → 回去，方块没了；store 里的行仍在）。根因 = `Game.start`
> 只对出生点视距窗口 `preloadEdits`（`game.js:428`），而 `Scheduler` 的 `getEdits` 是**同步**读
> `editsCache`，窗口外必然未命中 → GEN 拿到空 edits。**A/B 实测在 HEAD 上同样复现**（纯正常路径、
> 无本次新代码）→ 不是 v1.43 引入。详见 roadmap 遗留 TODO（含修法方向）。因此本任务的 E2E
> **刻意不断言「换 seed 后包里的方块出现在世界里」** —— 那会被该缺陷干扰；世界写入路径的验证
> 改由「导出含刚放入内存的方块」+ codec 往返单测承担。
>
> v1.44 修订说明：**太阳阴影 shadow map 落地 —— §4.4.4 的规划期估算全部改为实测口径**
> （2026-10-13，§4.4.4 / DR-14）。§4.4.4 原文（「贴图 2048 / shadow camera 覆盖半径 = 视距的 60% /
> 投射接收由 BlockRegistry 属性驱动」）是**规划期估算，从未实现**；本次落地后三项全部与原文不同，
> 且每一项的差异都是实测或架构决定的，不是偏好。规格
> `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md`（DR-1~DR-8 + DR-4b + §9 六条偏离），
> 任务级实测记录见 `.superpowers/sdd/2026-10-13-sun-shadow-map/task-{3,5,6b1,6b2}-report.md`。
>
> ① **档位改用 `VSMShadowMap`，不用 mc-lite 的 `PCFSoftShadowMap` —— three.js r185.1 WebGPU 后端的
> depth-compare 阴影路径是坏的**（本次最重要的发现，闸门实测）。错误原文：
> `GPUValidationError: [Texture "ShadowDepthTexture"] usage (TextureBinding|RenderAttachment) includes
> writable usage and another usage in the same synchronization scope` → 整个 CommandBuffer 作废 →
> **画面全黑**。**在只有 plain `Mesh`、零游戏代码的最小独立场景里同样复现** → 与 BatchedMesh /
> 自定义 `packed` 属性布局 / per-instance 剔除**无关**（spec §8 原把这列为「最大未知数」，已被证伪）。
> Basic(0) / PCF(1) / PCFSoft(2) 三种 depth-compare 档位全坏；**VSM(3) 有影 + 0 错误**，因为
> `three.webgpu.js:45074` 显式 `depthTexture.compareFunction = null`（"VSM does not use
> textureSampleCompare()"）绕开了 comparison-sampler 路径 —— bug 精确定位在该路径。
> DR-5 的按需刷新**不能**绕开（错误发生在同一 encoder 内，与刷新频率无关）。属 three.js 已知问题类
> （#33048 / #34081 / #34053 / #33898）。**代价四项**：VSM 不吃 `bias`/`normalBias`（改吃 `radius 4` +
> `blurSamples 8`，实测出影值）/ 固有 light-bleeding 漏光伪影（用户已知悉接受）/ 多 2 个模糊 render
> target（垂直+水平 pass）/ **`receiveShadow` 的对象也进阴影 pass**（见 ②）。⚠️ **升级 three 前须重测
> 这条**：若上游修了 comparison-sampler 路径，可换回 PCFSoft 对齐 mc-lite。spec §8 的另一条回退选项
> `castShadowNode` 对本 bug **大概率无效**（它改的是 filter 节点，bug 在阴影 map 的 render pass 本身 ——
> 实施者分析，**未实测验证**）。
>
> ② **投射是通道级（opaque + cutout cast / transparent 不 cast / 三通道全 receive），不是原文的
> 「BlockRegistry 属性驱动白名单」**。mc-heavy 是 BatchedMesh 通道级合批（红线 5），逐方块投射需改
> mesher（packed 位 + `castShadowNode` 逐顶点 discard）= 纯额外 GPU 开销，而收益（花草不投影）肉眼
> 不可辨 → 不做（DR-2，用户确认接受）。⚠️ **VSM 下 `receiveShadow` 的对象也进阴影 pass**
> （`three.webgpu.js:44682` 判据 `castShadow === true || (receiveShadow && shadowType === VSMShadowMap)`）
> → 三通道全进，不只 cast 的两个。**后果是重渲帧的 drawCalls 尖峰**（vd=2 实测 53→273 即 +220；
> vd=8 实测 514→624 即 +110），故 **DR-5 的按需刷新不是可选优化而是硬约束**（稳态 drawCalls 实测值
> 见 roadmap v1.44 行）。连带测试口径：**任何量 drawCalls 的 spec，若被测对象不是阴影，
> 须先 `setShadowsEnabled(false)` 隔离**（已隔离 5 份：render-terrain / daynight-visual /
> weapons-performance / zombies / m3-2-orientation；断言与阈值逐字未动，改的是被测 setup）。
>
> ③ **节流口径是 per-light，不是 mc-lite 的 renderer 级**：WebGPU 后端经 `light.shadow.autoUpdate` /
> `light.shadow.needsUpdate` 判定（`ShadowNode.updateBefore`），mc-lite WebGL 的
> `renderer.shadowMap.autoUpdate` 写法**在本后端不生效**；`renderer.shadowMap.enabled = true` 仍是硬门控
> （不开则 `castShadow` 被忽略，`three.webgpu.js:43563`）。三个请求源（世界编辑 `block-changed` /
> 玩家移动超 5 格 / 日夜太阳方向变化）→ `ShadowScheduler` 200ms 节流 → 帧循环 `tick()` 放行。
> ⚠️ **消费端门控的操作数顺序是载荷性的**：`if (this.shadowScheduler.tick(nowMs) &&
> this.sunLight.castShadow)` —— **勿交换两侧**。`castShadow` 在前会让 `tick()` 被短路完全不跑 →
> `_pending` 永不被消费 → 打破 sun-shadow 用例 6 的观测口径（冻结断言 `off.sawTrue === 0`，实测交换后
> 5/5 FAIL、现顺序 5/5 PASS）。⚠️ 交换顺序**不会**让 draw 尖峰复活（交换后 `needsUpdate` 恒 false →
> 阴影 pass 根本不触发，实测 `needsUpdate` 0/8、draw 恒 168）；会产生尖峰的是「**去掉** `castShadow`
> 门控」那种形态（实测 drawCalls 168→402）—— 两种注入的后果不同，勿混。
>
> ④ **「关阴影 = 零开销」需三处协同，缺一处即静默失效**：(1) `sunLight.castShadow = false`（停阴影
> pass）(2) `uShadowStrength = 0`（视觉零影响 —— `shadow()` 节点仍在 node graph 里）(3) **DayNight 的
> `shadowEnabled` 标志**（否则日夜循环每帧 `_apply` 把 `uShadowStrength` 写回 `skyDim` → 关闭被静默
> 覆写）。⚠️ (3) 的失效面 `daynight-visual` spec **测不出**（它走 override 模式，`update()` early-return），
> 只有真实日夜循环才暴露。另有**请求源门控**：`editor.subscribe` / 移动阈值 / `onSunDirection` 三处的
> `request()` 都要判 `castShadow`（否则关阴影后仍每 200ms 重渲，实测尖峰帧占比 6.5%）；③ 的**消费端
> 门控是单点权威兜底**，源侧门控是纵深防御 —— 只靠源侧则每加一个请求源都要补一次，漏一个就复发
> （本次缺陷的成因正是 `editor.subscribe` 与消费端双双漏门控）。
>
> ⑤ **太阳方向随日夜连续插值**（有意偏离 mc-lite 的离散风格切换，spec §9 偏离⑤）：mc-lite 是风格切换时
> 离散变化，mc-heavy 的日夜是连续关键帧插值 → 方向逐分量 lerp + normalize。`VISUAL_STYLES` 存 mc-lite
> 三组**原值**（morning `[0.18,0.45,0.88]` / noon `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`），
> `paramsAtHour` 返回归一化值，`_apply` 调 `onSunDirection` 回调前统一归一化 —— **归一化必须收在 `_apply`**
> 而非只在 `paramsAtHour`：`setStyle`（设置面板切风格）传的是原值，night 长 0.9952 非单位长度，两条路径
> 不归一化会让「太阳方向 × 60」的光源偏移在两条路径下不一致。方向本身由 `_updateSunPosition()` 从
> `dayNight.params.sunDirection` 读（唯一权威，红线 1：不写字面量方向）。
>
> ⑥ **阴影让 morning 与 noon 的整屏平均亮度趋同 —— 物理正确，但撞 M2 的冻结断言**。机制：morning 的
> 太阳方向比 noon 更低 → 影子更长 → 屏幕上被影覆盖的地形更多 → 抵消掉 `skyDim 1.0 vs 0.8` 的亮度差。
> 实测（光源就位后）`|morning-noon|`：HEAD 无阴影 0.0340 / 阴影不参与 0.0300 / 恒全浓度 0.0107（余量仅
> 7%，贴线）/ DR-6 现状（`uShadowStrength = skyDim`）**0.0044**（断言阈值 0.01 → FAIL）。
> ⚠️ **关键推论：阴影本身就会让该断言收敛**（0.0300 → 0.0107），与 DR-6 无关 → 改 DR-6 也救不了，
> 只能隔离或重标。**用户 2026-10-13 裁定 = 隔离变量**：`daynight-visual` 量 `|morning-noon|` 前调
> `setShadowsEnabled(false)`，**断言与阈值 0.01 逐字不动**（改的是被测 setup —— 该 spec 的被测对象是
> 日夜风格系统，阴影是新引入的独立变量，正是「对照只差一个变量」原则）。
>
> ⑦ **Tier 4 像素判据的两条踩坑**（判据本身无效，不是实现有 bug）：
> **(a) 侧视采样两区不在同一表面** —— 无阴影接线、无柱、y=80 全 stone 平台（skylight 恒 15）下亮度仍硬
> 分裂 2×（−Z≈138 / +Z≈61），边界恰在相机自身 Z 平面；镜像相机 → 明暗侧随相机翻转（阴影不可能跟随
> 相机）。**根因 = perf HUD 的半透明黑底**（`perf-hud.js` 的 `position:fixed;top:8px;left:8px;
> background:rgba(0,0,0,.55)`）压暗屏幕左上象限 → 暗区跟着**屏幕**走而非世界走。修法 = 俯视相机 +
> 高空均匀平台 + **隐藏全部 HUD**（`#hud-root > *` + `#crosshair` + `#settings-btn`），实测隐藏后 25 点
> 全 156.0、spread 0.0。**(b) 不能直写 uniform 做像素判据** —— 强制 `uShadowStrength = 1` 时影区照样暗到
> 0.670 → 用例恒 FAIL。根因：`start()` 的首次 `needsUpdate = true` 早于 `setShadowsEnabled(false)`，
> map 里已烘好带柱深度的数据；关阴影后无人再置 `needsUpdate`，这份 map **永久驻留**，而 `shadow()` 节点
> 只读 uniform → 强制置 1 就把残留 map 采样回来。修法 = 同帧 A/B 比值 + **正向对照**（先开阴影断言
> A/B < 0.85 证明判据有效，再关阴影断言 A/B > 0.85）+ sanity floors（两区 > 40 防黑屏恒真）。
>
> ⑧ **与 v1.9 / DR-14 是两条独立路线，本决策不推翻 DR-14**：DR-14 撤销的是「体素 skylight 遮挡投影」
> （悬挑/洞穴下大片全黑 + 截断渐变环，用户明确否决），skylight 恒 15 口径**不变**（§4.6 未动）；
> shadow map 是纯渲染层的表面投影，视觉问题不同。DR-14 保留的遮挡模型与 light 任务写回机制**仍不启用**。
>
> ⑨ **开关是代码级、不进设置面板**（DR-7，用户决定）：构造选项 `shadows`（默认 true）+ `?shadows=0`
> URL 入口 + `Game.setShadowsEnabled()` / `shadowsEnabled` getter，不持久化。
>
> ⑩ **本期范围外（接线点已预留）**：实体（丧尸/矿车/炮塔/弹丸）不投射不接收 —— 后续加只需给对应
> InstancedMesh 开 `castShadow` + 材质乘 `shadow()` 节点（实体材质同为 unlit，接收也需手动相乘），
> 与体素同手法。阴影 pass **不消费 alphaTest** → 树冠投影是实心立方轮廓（Minecraft 原版同款表现）；
> 若观感不可接受，升级为 `castShadowNode` + alphaTest（但对 ① 的 bug 大概率无效）。
> 日夜循环下 5Hz 重渲是**正确行为**（太阳方向连续变），稳态帧时实测无影响；若后续 bench 显示 VSM 成本
> 成问题再考虑降频。
>
> 测试：`src/tests/test-shadow-manager.js`（节流纯函数，Tier 1）+ `src/tests/test-daynight.js`
> （方向插值连续性 / 归一化 / `uShadowStrength` 联动，Tier 1）+ `tests/sun-shadow.spec.mjs`
> （接线 / Tier 4 有影 / 光源跟随 / 关阴影不被日夜覆写 / 按需刷新 / 门控 / URL 入口 / 重开恢复）。
> 验收实测数据（Tier 4 亮度比 / drawCalls / 帧时 / 全量 E2E / bench 交替对照 / 负向验证）见 roadmap
> 独立改动表的 v1.44 行。
>
> v1.45 修订说明：**太阳阴影「黑乎乎一片」修复 —— 混合模型对齐 mc-lite + 逐方块投射排除**
> （2026-10-14，§4.4.4）。用户实玩报告「阴影的部分都是黑乎乎的一片」，对照 mc-lite 定位到
> **两个独立缺陷**（都不是参数调得不好，是模型错）。规格
> `docs/superpowers/specs/2026-10-13-sun-shadow-map-design.md` 的 DR-2 / DR-4 相应条目已作废。
>
> ① **阴影因子被乘在最终颜色上 → 影区亮度归零（根因）**。v1.44 的实现是
> `rgb = texColor.rgb × vShade × shadowFactor`，而 `shadow()` 在影区返回 0 → **整个 rgb 归零**。
> mc-lite 的体素材质是受光的 `MeshStandardNodeMaterial`（`MaterialManager.js:268`），three 的阴影
> **只乘在方向光贡献上**，而 `AmbientLight(0xddeeff, 2.3)`（`Engine.js:194`）**不参与阴影** →
> 影区仍被环境光完整照亮。mc-heavy 是 unlit 管线，`vShade` 里烘焙的 skylight 就是它唯一的「环境光」，
> 这一乘把它也乘没了 —— **这是两边观感差异的直接来源**。修法见 §4.4.4「接收靠 TSL 节点手动相乘」段
> （sky/block 分开传片元 + 只衰减 sky 项 + `SHADOW_FLOOR=0.5` 地板 + 两层 mix 嵌套顺序载荷性）。
> ② **cloud 等 13 种方块被通道级粗粒度误投影**。v1.44 的 DR-2 判断「cloud 在高空、投影可接受」
> **与 mc-lite 实际口径不符**：mc-lite 明确把 cloud 排除在投影外（`BlockData.isShadowEnabled:false`，
> 实测解析其 124 键 = 102 项投影 / 20 项不投影）。mc-heavy 的 cloud 在 **opaque 通道**
> （`blocks-data.js`，M2-7 为修侧面混叠从 transparent 挪过去的）→ 通道级 `castShadow` 让云全部投影，
> 而 Y=35/55 的云簇完全在阴影相机 far=250 视锥内 → **地面出现大面积移动云影黑斑**。
> 修法 = 逐方块排除（`shadowCast:false` → `shadowCastTable` → packed bit14 → `maskShadowNode`），
> 见 §4.4.4「投射是通道级 + 逐方块排除两层」段。
> ③ **`radius` 从 4 修回 mc-lite 原值 2.6**：4 是缺陷 ① 时代的补偿值（阴影纯黑须糊开才不刺眼），
> 修好 ① 后 radius=4 反而把阴影冲淡（实测谷底比值 0.852 vs r=2.6 的 0.726，半影宽度两者同为 4/8 点）。
> ④ **transparent 通道改为 cast + receive 双 false**（v1.44 是 cast=false / receive=true）：
> VSM 下 `receiveShadow` 的对象也进阴影 pass（`:44682`）→ 水/玻璃**照样投影**；且材质的 `shadow()`
> 节点不受 `receiveShadow` 门控（该标志只门控灯光管线，`:46101`）→ 水面照样被压暗。mc-lite 对
> water/glass 也是双 false。连带：transparent 通道的材质**不挂 shadow 因子**（`receivesShadow:false`）。
> ⑤ **测试口径缺陷（比实现缺陷更值得记）**：v1.44 的 Tier 4 判据只有上界 `ratioA < 0.85`
> （「影区须比基线暗」），而**纯黑（实测 0.675）也满足这个断言** → 该用例结构上就抓不到缺陷 ①。
> 负向验证实测：把 `SHADOW_FLOOR` 改回 0（= 旧的乘到纯黑行为）后 `ratioA = 0.122`（影区几乎纯黑），
> 而旧断言**仍全绿**。故 v1.45 补**下界 `> 0.5`**（实测修好 0.735 / 破坏态 0.122，两侧都不贴线）。
> 同 `testing-policy.md` §2.7「负向验证盲区」与 CLAUDE.md「写断言前必须先在真实数据上跑一次」。
>
> 实测数据（2026-10-14，同一平台/同一相机，只改被测变量）：
> - 影区比值 `ratioA`：**0.675（v1.44 纯黑）→ 0.735（v1.45 地板 0.5 + radius 2.6）**；
>   开阔区 `ratioB` 恒 1.000（阴影是局部的，不是全屏压暗）；关阴影 A/B = 0.992（零视觉影响）。
> - 0.735 与 mc-lite 理论影区亮度 **0.71** 几乎重合（ambient 2.3/(2.3+sun 3.2×NdotL 0.8)=0.4733
>   线性 → sRGB 0.71）→ 地板值与 radius 都对齐上游观感，不是凑数。
> - cloud 投影验证：cloud 柱逐点扫描比值**恒 1.000**（dz0/dz1 读到 209/226 = 云柱自身，明亮且不投影），
>   对照 stone 柱同点位 0.852（radius=4 时）/ 0.726（radius=2.6 时）。
> - radius 扫描（只改 radius）：r=1 → 0.724 / r=2 → 0.724 / **r=2.6 → 0.726** / r=3 → 0.769 /
>   r=4 → 0.852 / r=4+bs16 → 0.826；半影宽度 r=2.6 与 r=4 同为 4/8 点（边缘不更硬）；0 个 GPU 错误。
> - 浏览器内单测 645/645 全绿（含新增 6 条：registry `shadowCastTable` 双向一致 / 13 项排除清单 /
>   未知 id 防御 / mesher bit14 三向）。
>
> v1.46 修订说明（实玩修正，不改架构口径，故不 bump 版本号，仅在此补记）：**远端闪烁修复**
> —— three r185.1 的 BatchedMesh 主 pass 与阴影 pass 共用一份 multi-draw 列表，阴影 pass 覆写后
> 主 pass 读到被 ±30 视锥裁剪过的列表 → 视锥外几何每次刷新一帧消失（透出天空）。修法 =
> `render-world.js _installShadowListGuard`（快照/恢复）。详见 roadmap v1.46 行与 CLAUDE.md 活跃约束。
>
> v1.47 修订说明：**阴影「随移动微微晃动」修复 —— 纹素对齐 + 太阳方向角度阈值门控**
> （2026-10-17，§4.4.4）。用户实玩报告「阴影随着玩家的移动会微微晃动，幅度不大但能察觉」，
> 并质疑「200ms 刷新频率是否过高、对性能影响有点大」。排查结论：
>
> ① **晃动的根因是纹素量化，不是太阳方向在变**。阴影相机 ±30 / 贴图 256² → 每纹素 ≈ 0.234 格；
> 相机连续跟随玩家时，世界点相对纹素网格每次重渲错位一个**分数**纹素 → 所有影子边缘跳动最多
> 半纹素 ≈ 0.1 格（与「幅度不大但能察觉」吻合）。太阳方向每帧只转 0.0025°，不是主因。
> ② **200ms 的性能前提不成立，故不改 200ms**。探针实测（vd=8，逐帧按「是否刷新」分组）：
> 稳态帧中位 8.3ms（与关阴影的 8.33ms 逐位相同 → 常驻成本为零），刷新帧中位 9.0ms，刷新帧只占
> 4.2%（30/722），摊平 ≈ 0.03ms/帧，fps 恒 120。且强制 100/200/400/800/1600ms 对照显示
> **单次刷新成本与频率无关**（8.74/8.74/8.82/9.04/9.12ms）→ 降频不会让每次刷新变便宜，只是让它
> 更少发生，还会引入阴影覆盖滞后。⚠️ 既有验收用 p95（600 帧窗口）：5Hz 刷新帧只占 4.2%，
> 刚好落在 p95 阈值**之下** → 聚合 p95 抓不到刷新尖峰（「用聚合指标回答分组问题」的口径错误）。
> ③ **修法 = 纹素对齐（texel snapping）**：`shadow-manager.js` 新增纯函数 `texelSnapOffset`，
> `_updateSunPosition()` 把相机中心吸附到纹素边界（偏移同时加到 position 与 target → 方向严格不变）。
> ④ **顺带修真实浪费 = 太阳方向角度阈值门控**：`onSunDirection` 加 `sunDirectionChanged`
> （`SUN_DIR_GATE_DEG=0.5°`）→ 日夜循环下的光源重定位从每帧 120 次/秒降到约 0.6Hz。
> 附带消除**重定位路径上**的额外 `params` 读取（门控前每帧 2 次：门控自己 1 次 +
> `_updateSunPosition()` 1 次；`get params()` 每次调用新分配 2 个小对象）。
> ⚠️ **门控比较用回调入参 `dir`，不得读 `dayNight.params`**（入参是 DayNight 已算好的同值，
> 零额外分配；初版门控自己读 params → 被门控掉的帧仍每帧分配，白做一半）。
> ⚠️ `DayNight._apply` 自身的每帧分配（`paramsAtHour` + 末尾 `normalizeDirection`）
> **不在本门控范围内**，属日夜循环固有成本，本次未动。
> 门控**只加在 onSunDirection 路径**，不加到移动阈值路径（玩家移动必须让阴影相机跟上）。
>
> 两项都是**有意偏离 mc-lite**（它无连续日夜循环，光源只在移动超 5 格时重定位，无纹素对齐）。
>
> 实测数据（2026-10-17，同一平台/同一相机，只改被测变量）：
> - 纹素对齐 Tier 4（固定世界点 + 分数纹素步长 0.05 格 × 12 步 + 每步强制刷新）：
>   对齐 ON 亮度恒 112.63（spread **0.00**）、纹素相位恒 0.6（spread 0.00）；
>   对齐 OFF 亮度 118.77↔123.79（spread **5.02**）、相位 0.013~0.947（spread 0.93）。
>   阈值取 spread ≤ 1.0（与破坏态 5.02 差 5×，不贴线）。
> - 方向门控：cycleSeconds=60（太阳 6°/秒）下 `_updateSunPosition()` 调用 **11 次/秒**
>   （理论 6°/秒 ÷ 0.5° = 12）；阈值归零时 **120 次/秒**（每帧，= 门控前）。
> - 浏览器内单测 656/656 全绿（含新增 11 条：sunDirectionChanged 首次/同向/临界/大跳变，
>   texelSnapOffset 网格对齐/方向不变/幂等/幅度/退化/非法 texelSize/双基）。
> - sun-shadow.spec 11/11 全绿（含新增 2 条：纹素对齐 Tier 4 回归门 + 方向门控频率；改 1 条：
>   光源跟随容差从硬编码 0.1 改为从配置推导的半纹素对角 0.166 —— 行为变了导致几何口径变了，
>   非「放宽断言」）。

> v1.48 修订说明：**第一人称手臂与跑动视角晃动**（2026-10-17，§4.5.6）。用户要求对标 mc-lite
> 补上三件第一人称观感：跑动时的视角晃动、默认可见的手臂、挖/放时的手臂挥动。
>
> 三项产品口径经用户当面确认：① 手臂造型**逐字对齐 mc-lite**（单方块 `0.4×1.2×0.4` + `scale 0.1`
> + 肤色 `0xeebb99`），不另做两段式；② 晃动**只作用于相机**（手臂与持枪不叠加反相摆动）；
> ③ 挥动只在**挖块成功与放置成功**时触发（枪击继续走既有的后坐，不另加）；④ **不进设置面板**
> （常开，不新增配置项与持久化字段）。
>
> 三条实现口径（已写入 §4.5.6，改动前必读）：
> ① **晃动按物理步推进，不按渲染帧**。物理是 60Hz 定步长 + accumulator，120Hz 渲染下隔帧才走一步
> —— 按帧推进时没走物理的帧位移为 0 → 判据判「没在动」→ 相位每帧归零，晃动永远起不来。
> 按步推进后相位严格为 `speed×60` rad/s，与渲染帧率无关。
> ② **偏移融进那一次全量 `camera.position.set(...)`，不得写成 `+=`** —— 否则上一帧的偏移被下一帧
> 当基线继承 → 逐帧漂移。
> ③ **手臂用 unlit 材质**（`MeshBasicMaterial`），不跟 mc-lite 的 `MeshStandardMaterial`：
> 本仓场景双灯只为枪的 PBR 模型而设，受光手臂会让肤色随日夜灯光漂移且比同屏方块亮一档
> （`minecart-renderer.js` 同手法）。挥动时长从上游的「每渲染帧减 1」改为 **dt 基定长 1/6 秒**
> （上游 120Hz 下挥动只有 60Hz 的一半时长，是帧率依赖缺陷）。
>
> 两处**等价实现**（不改行为，故不登记为偏离）：上游 `shouldBob` 的 `!isObstructed` 那半条判据，
> 本仓由「实际位移 > 意图位移 × 0.95」天然覆盖（撞墙即位移不足）——**不新增「是否卡住」状态**，
> 新增一份会与 physics 的真实位移漂移（红线 1）。
>
> 模块归属：手臂在 `src/render/view-arm.js`（依赖 three，与 `view-weapon.js` 同层、互斥显示）；
> 晃动逻辑在 `src/player/view-bob.js`（**纯函数、无 three/无 DOM**，与 `step-lift.js` 同手法，
> 供浏览器内单测直接驱动）。两者均不新增渲染通道/InstancedMesh/BatchedMesh。
>
> 实测数据（2026-10-17）：
> - 浏览器内单测 **678 全绿**（含新增 22 条 `test-view-bob.js`：Bob 的静止归零/全速判据/
>   相位公式/帧率无关/跳跃与受阻不晃；Arm 的对齐 mc-lite 的造型站位/挥动单峰/dt 基定长/
>   显隐/castShadow）。
> - **18 条负向验证注入中 17 条真 FAIL**；唯一条仍绿的是「删 `inputSpeed>0` 守卫」——
>   它与紧随的 `expected>0` 重叠，被后者兜住；组合删两条后同一用例**真 FAIL**（已证非恒真断言）。
> - E2E `tests/view-bob.spec.mjs` **6/6**：相机偏移实测 x 峰值 **0.0436**（≤ intensity 0.05）、
>   y ±**0.0179**（≤ intensity×0.5=0.025）、静止恒 0、停下后收敛到 ~1e-8；相机偏移与
>   `viewBob.offset` 逐帧偏差 <1e-9（防「算对了没写入相机」）；挖块后 swingProgress 1→0、
>   谷底达 −1.67、回位到 −0.8；放置走背包选中路径同样触发挥动；挖空与命中 bedrock **不挥**。
> - 负向验证（E2E 侧）：删 `digBlock` 的 swing / 删放置的 swing / 切枪不切手臂显隐 /
>   默认不 `setWeapon(arm)` / 相机不吃 bob.x / 相机不吃 bob.y / bob 每帧改为累加 —— **全部真 FAIL**。
>   ⚠️ 首版「跑动晃动」用例只断言了 `viewBob.offset`（内部量），注入「算对但不写进相机」后
>   **仍全绿** → 改为同时断言相机相对物理位置的偏移，重做负向验证后才真 FAIL（testing-policy §2.7）。
> - 回归：`npm run check` 通过（0 error）；浏览器内单测 678/678；render-terrain（drawCalls 54，
>   门禁 <100）、weapons-performance、interaction、m3-hud、sun-shadow 11/11、minecart-render、
>   m3-2-orientation 全绿。`weapons-world-edit` 的「200 次射击计数」FAIL 属**已知 flaky**：
>   HEAD 侧（`git stash` 掉本次改动）同样 FAIL（199 vs 200），与本改动无关（CLAUDE.md 在列）。

> v1.49 修订说明：**晃动幅度上调 + 手臂挥动对齐原版 Minecraft**（2026-10-17，§4.5.6）。
> 两条都来自用户实玩反馈（看过 v1.48 的效果之后）。
>
> ① **晃动「小到看不出来在跑」**。排查后是两个原因叠加，不是单纯数值偏小：
> · 数值：mc-lite 的 `bobbingIntensity = 0.05` 在 70° FOV 下只有 ±0.05 格平移，
>   折合屏幕约 1~2% 的画面位移 → **上调到 0.09**（与 vanilla `bobView` 奔跑时的
>   `f1×0.5` ≈ 0.05~0.1 格同量级）。
> · **缺旋转分量（更本质）**：mc-lite 只做平移，而 vanilla `GameRenderer.bobView()` 除位移外
>   还施加 `camera.rotation.z`（roll，来自 cameraYaw）与 `camera.rotation.x`（pitch，
>   `|cos|` 双频 → 一个步态周期两次上下）。只放大平移，观感仍是「镜头在抖」而非「人在跑」。
>   本仓没有 cameraYaw，故 roll 直接跟相位走（`sin(t)`，0.022 rad ≈ 1.26°），
>   pitch 跟 `|cos(t)|`（0.012 rad ≈ 0.69°，刻意比 roll 小 —— 它直接改变「看地上多少」，
>   大了立刻晕）。**两者都按 `amount/intensity` 缩放**，静止时随振幅归零，不会残留歪头。
>
> ② **挥动「有点太生硬」**。mc-lite 用 `sin(p·π)` 单曲线：峰在 p=0.5、前后等速、只有 rotation.x。
> 原版第一人称是**两条峰值错开的曲线 + 多轴**：
> · `attack = sin(√p·π)` —— **峰在 p=0.25**（快出）。主劈 pitch 与横摆 yaw 跟这条。
> · `whip = sin(p²·π)` —— **峰在 p≈0.707**（滞后）。甩腕 roll 跟这条。
> · 外加向前下探的位移（原版 `swingX/swingY/swingZ` 在骨骼空间，本仓等比缩到 0.05/0.035 格）。
> 两条曲线错开才产生「甩腕」；单曲线无论怎么调幅度都是「整体平移」，这就是生硬的根源。
> 幅度：roll 用原版的 20°（=0.349 rad），yaw 取 0.14 rad（原版 70° 是整条手臂骨骼空间的角度，
> 直接搬会过头），pitch 幅度与静止角 −0.8/−0.87 保持不变（已与 mc-lite 对齐，未受影响）。
>
> 实测（2026-10-17，同一平台/同一 URL）：
> · 相机平移 x 峰值 **0.0436 → 0.0784**（intensity 0.09 下见到的实际峰值）；
>   y 峰值 0.0179 → **0.0322**；新增 roll 峰值 **0.02193 rad**、pitch 峰值 **0.01198 rad**；
>   相机 roll 与 `viewBob.roll` 逐帧偏差 **3.5e-18**；静止时三项全 0；停下后收敛到 ~1e-10。
> · 挥动轨迹实测（逐帧）：`p=0.25` 时 rotX 已到 **−1.67**（谷底，快出），
>   `p=0.697` 时 rotZ 到峰 **0.3487**（滞后甩腕），`p=1` 时 rotX/rotY/rotZ 严格回 `−0.8/0/0`。
> · 浏览器内单测 **686/686**（+8 条：快出峰位、甩腕滞后、yaw 多轴、位移分轴、幅度上调区间、
>   roll/pitch 公式与归零、pitch 非负双频）。
> · E2E `tests/view-bob.spec.mjs` **6/6**（新增断言：主劈谷底须在 p≤0.35、滚转峰须在 p≥0.5、
>   yaw/向前位移须发生、三轴结束时严格归零；跑动用例新增 roll/pitch 的上下界与归零）。
> · **11 条负向验证全部真 FAIL**（振幅退回 0.05 / 去掉 roll+pitch / pitch 改成正弦 /
>   主劈退回对称曲线 / 甩腕改同一曲线 / 去掉 yaw / 去掉位移 / 结束不归零 /
>   相机不写 roll / 相机不写 pitch / roll 写进 yaw）。
>   ⚠️ 首版「挥动带位移」断言写成 `|Δz| + |Δy| > 0.01`，注入「去掉向前位移」后**仍全绿**
>   （Y 轴下探独立让总和过阈值）→ 改成分轴断言后才真 FAIL（testing-policy §2.7 的又一实例）。

> v1.50 修订说明：**晃动幅度回调 + 挖掘挥手时机改为「试图即挥手」**（2026-10-17，§4.5.6）。
> 两条都来自用户看过 v1.49 效果后的实玩反馈。
>
> ① **「相机晃动又太剧烈了，稍微缓和一些」**。三项一起回调：
> `intensity 0.09 → 0.07`、`rollAmount 0.022 → 0.014`（1.26° → 0.80°）、
> `pitchAmount 0.012 → 0.007`（0.69° → 0.40°）。
> ⚠️ **只降平移是错的**：观感刺激几乎全来自旋转（同量级的角度变化比位移明显得多），
> 保留原旋转只降平移仍会「歪得明显」。实测回调后 camX 峰 0.0784 → **0.0610**、
> camY 0.0322 → **0.0250**、roll 0.0219 → **0.0140**、pitch 0.0120 → **0.0070**。
>
> ② **「只要试图消除方块就挥动，不管有没有成功」**。v1.49 把 `swing()` 放在
> `editor.setBlock()` 旁边，而 `digBlock()` 上方有三个早退分支（矿车命中 / `!this.target` /
> TNT 引爆 / `isIndestructible`）→ 挖空气、挖基岩、点 TNT 时**挥动静默消失**。
> 修法 = 把 `swing()` 提到**函数顶部、所有早退之前**。这与 mc-lite 完全同口径：
> 它的 `PlayerInteraction.js:199-200` 是 `removeBlock(hit, true); this.swing();`（顺序执行，
> 不看 removeBlock 的返回值），**未命中**走 `:207` 的 `else { this.swing(); }` 也挥。
> 代价是越肩挖空气也挥手 —— 原版就是这样，且挖掘是按住连续点，无反馈会让玩家以为卡住了。
>
> 实测与验证（2026-10-17）：
> · 浏览器内单测 **687/687**（+1 条：`roll/pitch 也与 intensity 一起回调`；改 3 条为回调区间断言）。
> · E2E `tests/view-bob.spec.mjs` **7/7**（原「挖空不挥动」用例**反转**为「挖空也挥动」，
>   并新增一条 `挖掘触发的挥动不依赖世界是否真的改变`，用逐帧轨迹证明挖空气走的是**同一个**
>   挥动实现（谷底 p≤0.35、甩腕 roll ≥0.85 幅度、结束严格回位），不是「只置了进度但姿态不动」）。
> · **5 条负向验证全部真 FAIL**：intensity 退回 0.09 / 退回 0.05 / roll 退回 0.022 /
>   pitch 退回 0.012 / 把挥手移回 `setBlock` 旁边（复现 v1.49 行为）。
> · 回归：`npm run check` 0 error；interaction / weapon-view / render-terrain 全绿。

> v1.51 修订说明：**相机零旋转 —— 跑动时镜头不歪头**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「这个镜头晃动，左右摆动的体验很不好，跑动的时候镜头始终是水平的，身体再晃动，
> 所有镜头晃动的时候不要『歪头』。」
>
> 经确认选项后定为：**旋转全部去掉**（不只 roll，pitch 也归 0）、**保留左右平移**
> （位置微移不改变任何朝向，地平线永远水平）。
> 落地 = `BOB.rollAmount` / `BOB.pitchAmount` 由 0.014 / 0.007 **置 0**。
> **字段保留而非删除**：它们仍是「可配置的旋转幅度」，置 0 = 关闭；将来若要开回来只改数值。
> 这是一处**新的有意偏离 MC 原版**（原版 `GameRenderer.bobView()` 确实施加 roll 与 pitch）。
>
> 实测（2026-10-17，180 帧跑动采样）：相机 `rotation.z` 峰值 **0**、`rotation.x` 峰值 **0**、
> `rotation.y` 恒等于 `player.yaw`（朝向未被污染）；同时左右平移仍在
> （`camX` 峰值 **0.0610**、`camY` 峰值 **0.0250**）→ 证明「零旋转」不是靠关掉整个晃动达成的。
>
> 验证：
> · 浏览器内单测 **686/686**（改 4 条：`roll/pitch` 幅度须为 0、新增「跑动全程零旋转」硬不变式、
>   静止用例改为「旋转恒 0 且平移保留」、删掉已无意义的 `pitch |cos| 双频` 用例并替换为
>   「平移相位关系保持」）。
> · E2E **7/7**（跑动用例的旋转断言由「须有 roll/pitch」**反转**为「必须为 0」，并在注释里
>   写明为何必须断言相机侧而非 `viewBob` 内部量）。
> · **5 条负向验证全部真 FAIL**：roll 幅度退回 0.014 / pitch 退回 0.007 / roll 公式写死常量 /
>   **`player.js` 自加 roll 常量**（绕过 bob）/ **`player.js` 自加 pitch 常量** ——
>   后两条证明相机侧断言确实能抓「bob 对了但接线又加回来」的缺陷。
> · 回归：`npm run check` 0 error；interaction / weapon-view / render-terrain 全绿。
> ⚠️ 踩坑：`expect(x).toBe(0)` 对 `rotateZ(0)` 产出的 `-0` **会 FAIL**
> （`Object.is(-0, 0) === false`）→ 改用 `Math.abs(x) === 0`，锁「量为零」而非「符号为正」。
>
> 一并修正 v1.48 的两条断言（行为变了，不是放宽）：「谷底在 p=0.5」→ **p=0.25**；
> 「BOB.intensity == 0.05」→ 改为断言「已上调且不在 mc-lite 原值」。
> v1.52 修订说明：**晃动改距离驱动，频率对齐原版疾跑步频**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「跑动就是左一步右一步的晃动，晃动的频率要适配跑动的步伐节奏，
> 你现在晃动的太快了……参考原版我的世界玩家跑动时的特效，特别是晃动幅度和节奏。」
>
> **根因**：相位是**时间**驱动（`timer += speed·dt·60`）→ 晃动频率与移动速度脱钩，
> 走慢/受阻时相位照涨；而原版用**走过的距离**驱动，天然贴合步伐。
>
> **原版机制**（`GameRenderer.bobView()` 经 `minecraft-renderer` 的 `computeCameraBob`
> 逐行核对，两侧公式一致）：
> `walkDist += 0.6 × 水平位移`、`phase = walkDist × π`；
> `bob → min(0.1, 水平速度)`（0.4/tick 缓动）；
> `position.x = sin(φ)·bob·0.5`、`position.y = −|cos(φ)|·bob`（**只向下**，每步一次下沉）、
> `rotation.z = sin(φ)·bob·3°`、`rotation.x = |cos(φ−0.2)|·bob·5°`（后两者本仓按 v1.51 关闭）。
>
> **频率标定（关键结论，别照抄步幅）**：原版一个 bob 周期 = `2/0.6 = 3.3333 格`；
> 原版疾跑 5.612 格/秒 → **1.6836 Hz**（周期 594ms，每步 297ms）；走路 4.317 → 1.295 Hz。
> 本仓 `SPEED = 8` 格/秒（比原版快 ~43%）——
> **照抄 3.333 格/周期会得到 8/3.3333 = 2.400 Hz，比原版更快，与「太快了」的反馈方向相反**。
> 故按**节奏时间**对齐原版疾跑：`phasePerBlock = 2π / (8 × 3.3333/5.612) = 1.3223 rad/格`
> → **1.6836 Hz**（比修复前的 1.910Hz 慢 11.8%）。
> ⚠️ **改 `physics.js` 的 `SPEED` 时必须重算 `phasePerBlock`**（频率会随速度漂移）。
>
> **同时对齐原版振幅口径**：`intensity` 0.07 → **0.1**（原版 `bob` 上限）；
> `x` 幅度 = `intensity × 0.5`（±0.05，比修复前的 ±0.07 更小 —— 对「左右摆动体验不好」
> 的反馈也是正向）；`y` 改为 `−|cos(φ)|×intensity`（**只向下**、每步一次下沉），
> 取代 mc-lite 的 `cos(2t)×0.5`（双侧）。
>
> 实测（2026-10-17，真游戏页逐帧）：
> · 每步位移 0.1333 格 → 相位 0.1765 rad/步 → **phasePerBlock 实测 1.3241**（配置 1.3223）；
> · **频率 1.6821 Hz、一步 297.2ms、每周期走过 4.7453 格** —— 与目标 1.6836Hz / 297ms 吻合；
> · `maxX` **±0.0446**（≤ intensity×0.5）、`minY` **−0.0905**（≤ intensity）、**y 恒非正**；
> · roll/pitch 仍恒为 0（v1.51 的零旋转不变式未被破坏）。
> · 浏览器内单元 **687/687**（+2 条：距离驱动不变式（同距离不同帧率→同相位）、
>   频率对齐原版疾跑 1.6836Hz + 振幅原版口径；改 4 条旧断言）。
> · E2E **7/7**（上界改为原版口径 x≤intensity×0.5、y≤intensity，新增「y 只向下」断言）。
> · **6 条负向验证全部真 FAIL**：`phasePerBlock` 照抄原版步幅（1.8850，会变快）/
>   退回时间驱动等效值（1.5）/ 相位改回时间驱动 / y 改回双侧 cos(2t) /
>   x 不乘 lateralRatio / intensity 退回 0.07。
> v1.53 修订说明：**晃动幅度上调 0.1 → 0.13**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「晃动幅度再稍微大一点，现在的跑步的感觉不是很明显」。
>
> **这一轮最有价值的发现：标称值 ≠ 玩家看到的幅度**。
> `smoothingRetention = 0.7` 是一阶低通，在 1.6836Hz 处**通过率只有 0.8976**（实测）——
> 标称 0.1 时**实际** y 峰只有 −0.0898、x 峰 ±0.0449。前几轮都在按标称值讨论「够不够」，
> 实际相当于每次都少给了一成。故：
> · `intensity` 0.1 → **0.13**（**有意偏离原版 `bob` 上限 0.1**：原版上限是配合它的步幅与
>   速度标定的，本仓 `SPEED` 不同，不能直接套）；
> · 实测 y 峰 **−0.1177**（+31%）、x 峰 **±0.0580**；`y` 仍恒非正、`roll/pitch` 仍恒 0。
>
> **判定口径改为「扣掉平滑后的实际峰值」**：单测里加了一条实测断言（y 峰 > 0.1、x 峰 > 0.05），
> E2E 里加了 `maxCamY > 0.1`。只比标称值的话，「标称调大了但平滑把增幅吃掉」这类静默失效
> 抓不到（本次 RED 阶段就是靠它抓到实际 y 峰 0.0907 未过 0.1）。
>
> 验证：
> · 浏览器内单测 **687/687**（改 2 条：标定值 0.13 + 「须高于原版上限」；新增「实际峰值」下界）。
> · E2E **7/7**（新增 `maxCamY > 0.1` 的实际可感下界）。
> · **4 条负向验证全部真 FAIL**：intensity 退回 0.1 / 退回 0.07 / 过冲到 0.3 /
>   x 不乘 `lateralRatio`。
> · 回归：`npm run check` 0 error；interaction / render-terrain 全绿。
> v1.54 修订说明：**步频放慢 1.6836 Hz → 1.5 Hz**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「步频稍微慢一点」。
>
> · 目标取值：原版疾跑 1.6836Hz（每步 297ms）→ **1.5 Hz**（每步 **333ms**，慢 10.9%）。
>   **为什么不是更慢**：1.5Hz 仍明显快于原版**走路**的 1.295Hz，保留「在跑」的节奏感；
>   再往下降会滑向走路的观感（用户前几轮的诉求一直是「跑步的感觉」）。
> · 换算：`phasePerBlock = 2π × f / SPEED = 2π × 1.5 / 8 = **1.1781** rad/格`
>   → 一整个 bob 周期走过 `2π / 1.1781 = 5.3333 格`。
> · ⚠️ **改频率会连带改变实际幅度**：一阶平滑（`smoothingRetention 0.7`）的通过率随频率下降
>   而上升（1.6836Hz 时 0.8976 → 1.5Hz 时 **0.9161**）→ 实际 y 峰 0.1177 → **0.1199**。
>   这类耦合只能靠**实测**发现，纯看参数看不出来。
>
> 实测（2026-10-17）：
> · 探针在真游戏页实测 **`phasePerBlock = 1.1781`、`blocksPerCycle = 5.3333`** —— 与设计值
>   逐位相同 → 频率 **1.5000 Hz、每步 333.3ms**。
> · 幅度：`maxCamY` **0.1199**、`maxCamX` **0.0592**（频率降低带来的 +2% 已含在内）；
>   `y` 仍恒非正、`roll/pitch` 仍恒 0（v1.51/v1.52 的不变式均未破坏）。
> · 浏览器内单测 **687/687**（频率用例改写为 1.5Hz，并新增「须快于原版走路 1.295Hz」
>   与「`phasePerBlock` 须与目标频率自洽」两条护栏 —— 前者防「慢到像走路」，
>   后者防「改了 phasePerBlock 却忘了同步频率意图」）。
> · E2E **7/7**（E2E 只断言幅度与零旋转，不绑定频率 —— 频率标定归单测，因为 E2E 的
>   采样窗口会被减速重置打断，实测踩过这个坑：`timer` 在停下时按设计归零，
>   跨减速段算 span 会得到**负**频率）。
> · **3 条负向验证全部真 FAIL**：`phasePerBlock` 退回 1.3223（1.684Hz）/
>   照抄原版步幅 1.8850（2.4Hz）/ 相位改回时间驱动。
> · 回归：`npm run check` 0 error。
> ⚠️ **探针经验（第二次踩）**：用真游戏页的 `timer` 跨度量频率，必须保证窗口内**玩家一直在跑**
>   —— 撞墙/减速会让 `timer` 重置为 0，`span` 甚至变负。可靠做法是旁路累计「判据通过时」的
>   相位增量与路程，或者直接用 `phasePerBlock × SPEED / 2π` 核算，再用纯量
>   （`blocksPerCycle`）交叉验证。
> v1.55 修订说明：**步频再降一档 1.5 Hz → 1.35 Hz**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「再慢一档」。
>
> · 取值：1.5 Hz（每步 333ms）→ **1.35 Hz（每步 370ms）**，同档位步长 +11%。
> · **下界依据（这条比数值本身更重要）**：原版**走路**是 1.295 Hz，1.35 Hz 只剩 **~4% 余量**。
>   再往下就会落进走路的节奏里 —— 观感从「在跑」变成「在走」，届时应该重新确认设计意图，
>   而不是继续微调这个数。单测里有一条「须快于原版走路 1.295Hz」作为硬护栏钉住这条界线。
> · 换算：`phasePerBlock = 2π × 1.35 / 8 = **1.0603** rad/格` → 一周期走过 `2π/1.0603 = 5.9259 格`。
> · 平滑通过率继续上升（0.9161 → **0.9304**）→ 实际 y 峰 0.1199 → **0.1203**。
>
> 实测（2026-10-17）：
> · 真游戏页旁路累计（判据通过时的相位增量 / 路程）实测：
>   **`phasePerBlock = 1.0603`、`blocksPerCycle = 5.9259`** —— 与设计值**逐位相同**
>   → 频率 **1.3500 Hz、每步 370.4 ms**。
> · 幅度：`maxCamY` **0.1203**、`maxCamX` **0.0603**；`y` 仍恒非正、`roll/pitch` 仍恒 0。
> · 浏览器内单测 **687/687**（频率用例改写为 1.35Hz；保留「须快于原版走路」护栏，
>   新增「须慢于上一档 1.5Hz」）。
> · **4 条负向验证全部真 FAIL**：`phasePerBlock` 退回 1.1781（上一档）/
>   落到走路节奏 1.0210（1.3Hz，被「须快于走路」抓到）/ 照抄原版步幅 1.8850 / 相位改回时间驱动。
> · ⚠️ **E2E 踩坑（本轮唯一一次失败）**：「相机 x 须反复过零（周期性）」在 1.35Hz 下**假失败** ——
>   原窗口 180 帧 @120Hz ≈ 1.5s 只有 ~2 个周期，去掉渐入段后只剩 1 次过零。
>   **这是采样窗口没跟上参数变化，不是实现缺陷**。改为 360 帧（3s ≈ 4 周期）、跳过前 90 帧渐入。
>   教训：**凡是「数周期/数过零」的断言，窗口必须按最低频率算够周期数**，否则调慢节奏就会假失败。
> · 回归：`npm run check` 0 error；E2E 7/7；另做了「相位改成单向漂移」的注入，确认周期性断言仍有效。
> v1.56 修订说明：**手臂烘焙面明暗 —— 消除「一个颜色、没有立体感」**（2026-10-17，§4.5.6）。
> 用户实玩反馈：「手臂的横面和竖面没有光影效果，感觉就是一个颜色，没有立体感，要有一点光影效果。」
>
> **不做的事**：不换成受光材质。本仓全场景 unlit（场景双灯只为枪的 PBR 模型而设），
> 换受光材质会让肤色随日夜灯光漂移、且比同屏方块亮一档 —— v1.48 已记录该取舍
> （`minecart-renderer.js` 用 `MeshBasicMaterial` 是先例）。
>
> **做法 = 顶点色烘焙三层明暗相乘**（`view-arm.js` 的 `bakeFaceShading`）：
> 1. **vanilla 方块面遮挡系数**（`faceShade`：顶 1.0 / 前后 0.8 / 左右 0.6 / 底 0.5）；
> 2. **固定光向的 Lambert 项**（`lightDir=(0.35,0.85,0.4)` 归一化，抬到 `[ambient,1]`=`[0.45,1]`
>    防背光面全黑）；
> 3. **沿长度渐变**（`lengthFade=0.78`，远端保留 78%）。
> 材质色改为白色，颜色全部来自顶点色 —— 明暗与基色是同一份数据，不会出现两份权威（红线 1）。
>
> **第 3 层是实测必需，不是锦上添花**：`rotation.x = -0.8`（≈46°）时手臂只露出**两个面**
> （底面 + 前面），第三个面被几何自身挡住。只靠前两层时屏幕上仍只有两档亮度、**单面是纯色**
> —— 像素直方图实测 **78.9% / 19.6% 两个尖峰、中间几乎无过渡**，观感就是「两块色板」。
> 加沿长度渐变后每个面内部都有梯度，分布变成 11 档连续过渡。
>
> 实测（1280×720，noon 冻结，隐藏 HUD，逐帧 `drawImage` 读像素，开/关手臂差分取手臂像素）：
> · 修复前：**2 个亮度档**、最大单色占比 **78.9%**；
> · 修复后：**11 个亮度档**、最大单色占比 **46.8%**、面间双峰相距 **26%**（155 vs 115）。
>
> 验证：
> · 浏览器内单测 **689/689**（+2 条：六面亮度两两不同且顶最亮/底最暗 + 侧面内须有厚度梯度；
>   面明暗常量与 vanilla 系数逐项一致、光向偏上、ambient 在 (0,1)）。
> · E2E **8/8**（新增像素用例：亮度档位 ≥6、最大单色占比 <65%、第二个峰存在且峰距 >15%）。
> · **4 条负向验证**：撤销顶点色烘焙 / 去掉长度渐变 / 去掉 Lambert 项 —— 单元与像素**双双真 FAIL**；
>   把六面系数全设 1 —— 单元 2 条真 FAIL，**像素层仍绿**（这是**正确行为**，不是盲区：
>   Lambert 单项本身就能提供 **50.9%** 的面对比度，画面确实有立体感；能抓「面系数丢失」的
>   是单元断言，两层分工明确）。
> ⚠️ **断言踩坑**：
> ① 「对称面亮度相同」不成立 —— 加入光向后 +X 朝光、−X 背光，天然不同；
> ② 取「每面第一个顶点」做跨面比较会被长度渐变带偏 → 改**面内均值**；
> ③ `BoxGeometry` 顶面/底面 4 个顶点 y 完全相同（实测 `[0.60,0.60,0.60,0.60]`），
>   沿 y 的渐变在它们上面恒为常数 → 「面内须有梯度」只对**侧面**（0/1/4/5）断言；
> ④ 像素层不能用 `p75−p25` 判面间差异（面内渐变把分位数拉进两峰之间，实测仅 6.3%），
>   改用**直方图峰值间距**（26%）。
> · 回归：`npm run check` 0 error；weapon-view / render-terrain 全绿。
> · 回归：`npm run check` 0 error；interaction / render-terrain / weapon-view 全绿。
> ⚠️ 探针踩坑：用「到原点的距离」或跨减速段的 `timer` span 量频率会得到**负值**
> （`timer` 在减速时按设计重置为 0）→ 必须在**持续跑动的窗口内**用相位增量或过零计数。
> v1.57 修订说明：**手臂配色对齐 mc-lite 的屏幕观感 + 晃动幅度再上调**（§4.5.6）。
> 用户实玩反馈两条：① 「玩家的手臂的颜色过于暗了，手臂的配色你参照 mc-lite 里默认手臂的颜色配置」；
> ② 「玩家跑动过程中的晃动幅度还不够大，可以稍微大一些」。
>
> **① 偏暗的根因不是色号选错**（`0xeebb99` 与 mc-lite `Player.js:137` 逐字一致），而是 v1.56 的
> 三层系数**直接相乘**把线性基色压到 0.20~0.48 —— 静止姿态（`rotation.x=-0.8`）露出的
> 底面 / 前面分别只剩 0.27 / 0.59。像素实测屏幕均值 **RGB(163,146,134)**，而参考肤色是
> (238,187,153)：不只整体暗一档，还因三通道被压得不一样而**发灰**（R−B 差 85 → 29）。
> 另有第二处：`0xeebb99` 的 **sRGB 数值被直接写进线性顶点色缓冲**
> （three `ColorManagement.workingColorSpace = LinearSRGB`），未做 sRGB→线性转换。
>
> **修法 = 把 `color` 的口径从「线性基色」改为「屏幕上的参考色」**：①②两层只决定面与面的
> **相对强弱**，其取值区间归一化后重映射到 `shadeLow..shadeHigh`（屏幕空间亮度带，
> 当前 **0.88 / 1.48**），再乘屏幕空间的沿长度渐变（`lengthFade` 0.78 → **0.88**），
> 最后 `srgbToLinear` 写进顶点色缓冲。于是「参考色」与「显示结果」是同一份数据
> （红线 1：明暗与基色同源）。
>
> ⚠️ **这三个参数是逐档实测试出来的，不是推导值**：扫描 `shadeLow × shadeHigh × lengthFade`
> 共 40 组屏幕读数，取「① 均值贴近参考色 ② 面间双峰仍分离 ③ 单面内梯度 ≥ 10%」三条件
> 同时成立的点。改数值前先量像素。
> ⚠️ `shadeHigh > 1.07`（R 通道饱和点）是**有意的**：上端只作用于 +Y 顶面，而顶面在静止与
> 挥动谷底都被几何自身挡住，玩家看不到 → 那段余量用来拉开可见面的对比度。
>
> 实测（口径同 v1.56：1280×720，noon 冻结，隐藏 HUD，开/关手臂差分）：
> · 屏幕均值 **RGB(163,146,134) → (235,188,154)**（参考色 238,187,153）；
> · R−B 差 **29 → 81**；亮度档位 2 → **16**；最大单色占比 78.9% → **43.7%**；
> · 面间峰距 **19.5%**（阈值 15%，两侧都不贴线）。
> · 独立探针复核参考值：同几何换 mc-lite 的 `MeshStandardMaterial(0xeebb99)`，本仓双灯下屏幕
>   p50 **255,231,191**、暗面 **179,151,133** —— 上游肤色在屏幕上是明亮的，不是暗棕，
>   故「参照 mc-lite 配色」的正确落点是提亮而非换色号。
>
> **② `BOB.intensity` 0.13 → 0.15**。判定仍用**扣掉一阶平滑后的实际峰值**：1.35Hz 处
> 通过率 ≈ 0.916 → 实际 y 峰 ≈ **0.1375**、x 峰 ≈ **0.0687**（上一档实测 0.1203 / 0.0603）。
> 新增**观感上限护栏**（`intensity <= 0.2`：再往上 y 峰逼近眼高的 11%，会从「在跑」变成「晕」）。
>
> 验证：
> · 浏览器内单测 **690/690**：新增「显示色阶落在参考肤色附近」回归门（近端亮度 ≥ 参考色 82%、
>   R−B 差 ≥ 参考色 60%、可见面保留明暗差）；改 1 条六面亮度断言（见下）。
> · E2E `view-bob.spec` **9/9**（像素用例全绿；跑动用例的 `INTENSITY` 常量同步 0.15）。
> · **4 条负向验证全部真 FAIL**：`shadeLow/High` 退回 0..1（亮度 23.2% vs 阈 82%）/
>   完整退回 v1.56 旧实现（75.9%）/ 只去掉 `srgbToLinear`（R−B 差 44 vs 阈 51）/
>   `shadeHigh` 收成 0.95 窄带（可见面亮度比 0.965 vs 阈 0.93）；bob 另两条（退回 0.13、越过 0.2）。
> ⚠️ **断言踩坑**：v1.56 的「底面须最暗（严格等于最小值）」在幂律重映射下是**伪约束** ——
>   线性空间里 ±X（面系数 0.6）与 −Y（0.5）差得很少，重映射后 −Y 反而略高于 −X。
>   改为「底面须属于最暗一档（与最暗值差 < 面间跨度的 15%）」，可见面的排序改按 **sRGB**
>   在新增用例里断言（那才是玩家看到的）。
> · 回归：`npm run check` 0 error；weapon-view / interaction / render-terrain 全绿。


> v1.58 修订说明：**体素材质接太阳 N·L 方向光 + mc-lite 天空盒**（2026-10-20，§4.4.3）。
> 用户实玩反馈：「目前的光影效果还是有点平淡，比如太阳光照到的表面要更亮一些，光的背面要更暗一些」，
> 并补充「mc-lite 的天空盒还有天空的贴图，你也照搬过来」。四项选型由用户拍板：
> ① **真实 N·L 方向光**（而非固定六面亮度表）② 天空盒**双图交叉淡入**（而非按小时硬切）
> ③ 日轮/月轮**一起搬** ④ **不移植** ACES / exposure / CSS 色彩分级。
>
> **根因不在日夜参数**：体素材质是 unlit，顶点 shade 只有 `max(skylight, blocklight) × ao`，
> 户外 skylight 恒 15（DR-14）→ **一个方块六面亮度完全相同**；三种风格只改 `skyDim` 这类
> 全局乘数，怎么调都不会出现朝向差异。而 mesher 早已把世界面索引写进 packed bit10-12，
> **渲染侧至今零消费点** —— 通道是通的，缺的只是着色器里那一步。
>
> **① 方向光的标定是两个推导值，不是拍的**：`SUN_AMBIENT ≡ SHADOW_FLOOR = 0.5`（同一语义）；
> `SUN_INTENSITY = (1 − 0.5) / noonSunY = 0.625` —— 这是让
> **`SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0`** 成立的唯一取值，即**正午顶面亮度恒等于
> 改动前的 1.0**。实测（`tests/sun-directional.spec.mjs`，`uSunStrength` 0↔1 自校准）：
> 顶面像素 **138.9 → 138.9（逐位不变）**，而墙面 +Z/−Z 从 **120.9/119.9（比 1.008）** 变为
> **113.4/86.4（比 1.313）** —— 朝向差异真的出现了，地面观感零回归。
> `SUN_INTENSITY` **从 `VISUAL_STYLES.noon.sunDirection` 派生**而非写字面量：改风格太阳方向时
> 强度自动跟上，否则「顶面 = 1.0」这条不变式会静默失效。
>
> **② 阴影与方向光必须合成，不能各乘一遍**（这是本改动最容易错的一处）：旧实现把
> `shadowFactor` 直接乘在 `vSkyShade` 上；若把 `SUN_INTENSITY × N·L` 再乘一次它，正午顶面在
> 影区会变成 `0.5 + 0.625×0.8×0.5 = 0.75`（应为 0.5）→ 阴影变淡 50%。
> 修法 = 先把 `shadowFactor` 重标定到「太阳被拿走的比例」`shadowKill`，**只乘太阳项**。
> 实测 **`sun-shadow.spec` 的冻结比值 ratioA 仍为 0.735，与改动前逐位相同**。
>
> **③ 天空盒**：两套立方图（`skyBox4` 白天云 912K / `skyBox1` 星空 5.1M）原样复制到
> `assets/sky/{day,night}/`，`scene.backgroundNode = mix(day, night, uNightBlend)`。
> 混合因子**从既有 `skyDim` 派生**（`nightBlendOf()`，正午 0 / 晨 0.267 / 黄昏 0.274 / 夜 1），
> 不新增权威。**朝向风险用严格等价对照排除**：自定义 `backgroundNode` 路径 vs three 默认
> `scene.background = cubeTexture` 路径 **逐像素相同（diff = 0 / 172800）**。
> `skyBox2`（日落）**不搬** —— mc-lite 自身零引用。
> 有意偏离 mc-lite 两条：不做 `backgroundBlurriness`（它走 pmrem 路径，与手工 backgroundNode
> 冲突；且本是离散切风格的补偿值）；天空随连续日夜插值而非硬切。
>
> **④ 日轮/月轮**：canvas 径向渐变（同 `Engine.js:429-495`），位置 = 相机 + 方向 ×
> `camera.far×0.55`、尺寸同比缩放（mc-lite 固定 150 单位 + 固定尺寸，照抄会在小视距下把
> sprite 推出远裁面）。三套风格的 `sunVisible` 原值全是 false（贴图自带光晕）。
>
> **⑤ 不移植**（用户否决）：ACES tone mapping / 每风格 exposure / CSS 色彩分级。
>
> 验证：
> · 浏览器内单测 **702/702**（新增 `test-sun-shade.js` 8 条 + `test-daynight.js` 4 条夜间混合/月亮方向）。
> · 新增 Tier 4 两条：`sun-directional.spec`（迎光/背光/零回归三组判据）、
>   `skybox.spec`（贴图在渲染/日夜混合/月轮可见性 + `?skybox=0` 对照）。
> · 负向验证真 FAIL：`nightBlendOf` 漏除法（2 条单测）/ 双图混合写死 0（天空盒用例）。
> · `sun-shadow.spec` 11/11、`ao-visual` / `ao-corner-visual` / `render-world` / `weapon-view` 全绿。
> · **⚠️ 观测口径隔离（断言与阈值逐字未动，只改被测 setup）**：四份 spec pin `?skybox=0`
>   （`render-terrain` / `city-visual` / `sky-structures` / `m3-rain` —— 实测天空区 **99.4%** 的
>   像素被「±30 内等于 0x87ceeb」判据误判成地形，下界断言近乎恒真）；
>   `test-sky-tree.html` 设 `uSunStrength = 0`（绝对叶色判据 ratioA 从 1.000 跌到 **0**，
>   该 fixture 测的是通道语义而非光照）。
> · `m1-acceptance` 放挖 p95 贴线为**已有 flaky**：交替对照 HEAD vs 改动各 3 轮，
>   两侧 p95 中位同为 **2.00**、编辑耗时中位同为 **0.80ms** → 非本次回归（阈值未动）。
> · `npm run check` 0 error。


> v1.61 修订说明：**夜间雾距统一 —— 让「雾色融入天空」在夜里也生效**（2026-10-21，§4.4.3）。
>
> **问题**：用户实玩反馈「从白天切换成黑夜模式后，远方的雾色和天空盒的颜色渐变嵌入就没有了」。
>
> **根因是风格数据里的 `fogScale`，不是雾色机制**：mc-lite 的 night 风格是 `fogScale = 4.0`
> （morning / noon 都是 1.0），而 `daynight.js:_apply` 把它乘到雾距上 → vd=8 时 `fogFar`
> 从 **152 格变成 608 格**，而世界径向只加载约 `(viewDistance+2)*16 = 160` 格
> → **视野内没有任何方块到达雾区**，雾根本不参与渲染，`uFogColorMix` 即使为 1
> 也没有东西可染。
>
> **实测证据（只差一个变量）**：黑夜默认 `fogFar=608` → 开关切换 **0.0%** 像素变化；
> 仅把 `fogNear/fogFar` uniform 改回正午口径（**不动任何代码**）→ **4.0% / 最大三通道和差 184**。
> 修复（`night.fogScale` → 1.0）后：黑夜 **4.0% / 184**、正午不受影响（4.1% / 63）、
> 天空区逐位不变、开关往返逐位还原。
>
> **保留 4.0 是 mc-lite 的代偿手法**：它要用雾把夜里的远处推成漆黑。本仓有夜空贴图与星点，
> 不需要这个代偿 —— 雾色与天色一致时，远景观感反而更自然。
>
> ⚠️ **诊断过程的教训（比缺陷本身更值得记）**：上一轮实测到「深夜 Δ=0」时，我把它解释成
> 「夜里看不出差别是合理的」并据此收工。**这是把测量的异常读数当成预期** —— 同一份数据
> （Δ=0）在白天会被我判为缺陷，在夜里却被解释成合理，**两边用的是不同标准**。
> 正确做法是：Δ=0 在任何风格下都应当先怀疑机制，而不是先给它编一个解释。
>

> v1.63 修订说明：**背景音乐 + 面板开关**（2026-10-21，§4.4 / §9 设置持久化）。
>
> **问题**：mc-lite 进游戏即有背景音乐（`Player.js:296` `audioManager.playBGM('bgm', 0.15)`，
> 单曲 `bgm.mp3` 254 秒循环），mc-heavy 的 `AudioManager` 只接了事件型效果音，没有音乐。
>
> **实现要点（三条都是「不这样做就静默失效」的口径）**：
> ① **`BGM_ID` 与 `SOUND_IDS` 分开两份清单**：效果音是事件触发、播完即止；音乐是循环、可开关。
>    混进 `SOUND_IDS` 会让 `play(id)` 也能播它（一次射击音效换成 254 秒循环音乐）。
> ② **起播取决于三个条件对齐**（玩家意图 / buffer 已解码 / context 已 running），而不是某一个
>    事件。生产里的真实顺序是「先点一下（手势到位）→ 几秒后 4MB 音乐才解码完」，故 `preload()`
>    末尾与 `unlock()` 末尾**各自**都要调一次 `_syncMusic()`。只在一处尝试 = 另一半路径永远没声音。
> ③ **`unlock()` 的唯一入口是 `Player` 的 canvas `onClick`**（mc-lite 挂在 `document` 的 click 上；
>    本仓既有 `onClick` 就是那个入口，再挂一个会重复解锁）。
>
> **面板落位 = 左列（雾色下方），不是右列** —— CLAUDE.md「新配置往右列填」的**适用前提已经变了**：
> 那条约束当初的理由是「左列被两组合并盒 + 四档风格撑高，右列余量更大」，而现在右列已堆到
> 六行、是**决定面板高度的那一列**。实测把本行加在右列：面板 653px、内容 706px > 可视 645px
> → 出现纵向滚动条、「世界」行被裁到折线以下；放左列则面板高度不变（左列 231→300，仍远低于
> 右列 571）、零文本溢出。故更新的是**判断依据**（不抬高面板），不是它的字面。
>
> **默认开、音量固定 0.15**（mc-lite 原值）。不接 `settings.volume`：那是全局音效档，
> 本改动不扩大它的语义。`?bgm=0|1` 与 `?fog=` 同口径（调试 / Tier 4 隔离入口）。
>
> **验证**：浏览器内单测 6 条（状态机，716/716 全绿）+ E2E 2 条（真游戏页接线）。
> **负向验证三处注入全部真 FAIL**：① `preload` 完成不补起播 → 用例③超时；
> ② `Player.onClick` 不调 `unlock` → 用例②超时；③ 面板按钮只存设置不调 `game` → 用例④超时。
>
> ⚠️ **两条实测踩坑（都是「断言描述了一个不存在的世界」）**：
> a. **localhost 上 4MB mp3 可能几十毫秒就解码完** → 「先手势、后解码」这个真实顺序测不到，
>    「preload 不补起播」的注入**漏过**（首版 E2E 全绿但无效）。修法 = `page.route` 把 mp3 推迟
>    1.5s，确定性地造出该顺序。
> b. **Playwright 默认 `--autoplay-policy=no-user-gesture-required`**，新建 AudioContext 一上来就是
>    `running` → 「手势未到」不会自发出现。修法 = 用例主动 `ctx.suspend()`。
> c. **three 的 `AudioListener` 用全局单例 context**（`three.core.js:50786` / `:49994` 的 `_context`
>    缓存），单测里 `dispose()` 会 `close()` 掉它 → 后续用例全部 `Cannot suspend a closed
>    AudioContext`（实测 3 条假失败）。单测收尾只能拆 listener、不能关 context。
>
> **新增 Tier 4 用例**（`tests/fog-color.spec.mjs` 的「夜间雾色同样生效」）钉两层：
> ① `fogFar < 世界加载半径`（直接钉根因，不依赖像素）；② 开关打开后远景必须变化 > 3
> （实测通道差 41）。负向验证：注入 `fogScale = 4.0` → 用例真 FAIL。
> v1.60 修订说明：**夜空天空盒无缝重烘焙**（2026-10-21，§4.4.3）。
>
> **问题**：用户实玩反馈「黑夜的天空盒的拼接图片效果不好，天空盒的各个边界没有很好的相互
> 融合衔接，出现了明显的衔接边界，看上去就是一个有楞有角的盒子」，要求「类似白天的天空盒
> 的样子，是看不到边和角的」。
>
> **根因在素材本身，不在接线**。实测 mc-lite `skyBox1` 六面：12 条共享边平均 RMS 落差
> **41.09**，而用户认可的白天 `skyBox4` 只有 **1.90**（差 22 倍）；各面平均亮度也互不相同
> （`posx` [19.3,40.4,67.6] vs `negz` [15.2,26.2,44.1]）。**白天之所以看不出边角**：它下半部
> 是近乎均匀的渐变，边缘本来就很平缓；夜晚的高对比星云一直铺到四边，而六面图案各自独立生成。
>
> **做法 = 方向空间加权重采样重烘焙**（`npm run nightsky`，产物 `assets/sky/night/`）：
> 输出像素 → 立方体方向 `dir` → 六面各自按 `dir` 反算 uv 并双线性采样 → 按「离本面中心
> 多近」加权平均。因 `dir` 跨面连续、权重也连续，**边界两侧算的是同一条射线、同一组权重**
> → 接缝数学上**精确为零**（实测 1.865，与白天 1.897 同量级）；面中心只有本面权重 → 原图
> 细节完整保留（高频能量 7.44 vs 原图 10.61）。源图归档在 `assets/sky/night-src/`（与 mc-lite
> 逐字节一致，md5 已核验），烘焙参数唯一权威 = `tools/night-sky-fingerprint.mjs`。
> 体积 5.1MB → 1.34MB（JPEG 质量 0.92 + 混合后更平滑）。
>
> **判据口径（本节最重要的沉淀）**：不能看裸 RMS，必须归一化到图像自身的**面内相邻列噪声底**。
> 白天接缝裸 RMS 是 1.90 而非 0（JPEG 量化残差），肉眼看不到是因为它**并不比画面内部更粗糙**
> （噪声底 1.06 → 比值 **1.786**）。实测：烘焙后 1.865/6.048 → 比值 **0.308**；原始夜空
> 41.094/9.009 → 比值 **4.561**。即新图比用户认可的白天基准**还平滑 5.7 倍**。
> 门禁因此**不设绝对阈值**（试过 1.0 与 1.2，两次都被白天基准 1.765 当场否决），而是
> 「夜空比值 ≤ 白天比值」—— 换贴图/改参数后不需要重标。
>
> **被否决的三个方案**：① 程序化重新生成整套星云（六面同源 fBm，虽也无缝但观感差得远，
> 实测偏暗偏糊：均值 [9.8,21.2,42.9] vs 原图 [17.7,35.7,60.3]）；② ridged 噪声做细丝
> （`1-|2n-1|` 是等值线 → 会闭合成**白色轮廓环**，像大理石裂纹）；③ 只做边缘羽化
> （星云结构仍跨不过边界）。
>
> **新增契约**：`npm run nightsky` 烘焙 + `check:data` 的 `[夜空]` 指纹校验（改参数忘烘焙
> → 报错）；`tests/night-sky-seam.spec.mjs` 的 Tier 4 无缝断言（含白天对照用例）。
> ⚠️ **屏幕级判据被实测否决并删除**：量「列均值一阶差分最大峰/中位」对原图是 16.3、
> 对烘焙版是 19.8（反而更低）—— 画面里地形/星点噪声淹没该信号，留着就是假断言。

> v1.59 修订说明：**雾色融入天空（按方位角采样天空盒）**（2026-10-21，§4.4.3）。
> 用户反馈：天空盒落地后「远方的方块变成了原来天空颜色的方块，停留在了天空盒图案的前面，显得十分突兀」。
> 需求经两轮澄清**收窄为开关**（用户原话：「太复杂了，我干脆简化掉算了，你在设置面板里给我一个选项」）：
> ① 开启时**按方位角采样天空盒**作为雾色（不是单色、不是全天穹均值）；
> ② 面板**新增独立一行，落地在左列「环境风格」正下方**（用户 2026-10-21 追加指定；
>   **不替掉**环境风格的「自动」——它是 `daynight.setStyle(null)` 恢复日夜循环的唯一 UI 入口，
>   且被 `sun-shadow.spec` / `daynight-visual.spec` 的 `setVisualStyle(null)` 用例依赖）；
> ③ 默认关闭（与 `?shadows=0` / `?skybox=0` 同口径：默认值 = 旧行为）。
>   ⚠️ **v1.78 起翻转为默认开**（用户 2026-10-25 裁定）；关闭路径完整保留（面板「关闭」+ `?fog=0`）。
>
> **根因是「雾色来源与天空已不是同一个东西」**，不是雾算法太简单：`setupFog` 的雾色是一个
> **单一 uniform**（`0x87ceeb`），而天空已是照片立方图；两者的唯一联系在 `daynight.js`
> （`fogColor` 与 `sky` 赋同一个 hex）。天空盒一开，这条「同色」前提就断了。
> 实测差距：固定雾色 **sRGB [134,205,234]** vs 天空盒在雾带仰角处的实际色 **[188,202,229]**
> —— **R 通道差 54**，而 R 恰是「蓝天 vs 灰白 wash」的区别，故远景像贴了一块蓝板子。
>
> **实现不新增渲染通道**：`fog(color, factor)` 的 **color 参数本就是任意节点**
> （`three.webgpu.js:42069` = `vec4(factor.mix(output.rgb, color.toVec3()), output.a)`），
> 所以换掉雾色来源即可。开关走 `mix()` 插值（`uFogColorMix` 0/1）而非 `if` 分支 ——
> 关闭时才能**逐位**回到 v1.58。
>
> ⚠️ **方向换算的关键规则：俯角（y ≤ 0）一律归到地平线带，只保留方位角**
> （纯函数 `src/render/fog-sky-direction.js`，着色器同构、ε 从其 import）。
> 初版直接用完整视线方向 → 俯视时采样到立方图的**天底那半张**（实测白天 negy 均值
> [97,125,186] vs 地平线 [207,216,232]）→ **雾色反向变暗**（实测 G −17 / B −12）。
> 物理上远处地形该淡入的是地平线天色：空气被上方光照射，不是被地面照亮。
> 保留水平分量则留下方位角差异 —— 那才是本功能的价值。
> ⚠️ **垂直俯视没有方位角可保**（信息缺失）：取 +x 作确定性兼就，不返回天顶
> （返回天顶会让俯视雾色变暗，实测已证）。
>
> 实测（960×600，noon 冻结，停物理，隐藏 HUD，开/关雾色差分）：
> · 同状态重复截图**噪声底 = 0**（冻干净后画面逐像素稳定）；
> · 平视机位（pitch −0.08）：雾带 R **184.9 → 189.9（ΔR +5.0）**，
>   `maxTop = 0`、`maxBottom = 0`、`maxAll = 14.95` → 变化**只**在雾带；
> · 俯视机位（pitch −0.55）：R **195.1 → 204.3（ΔR +9.2）**；
> · 开关往返：off `[184.9,201,214.3]` → on `[189.9,200.6,215.6]` → back **逐位相同**；
> · **天空区与近景区逐位不变**（雾不污染天空、近处不在雾带）。
> · bench 四个场景 draw call 与改动前**逐位相同**（500 / 559 / 559 / 545）——
>   雾色是片元内采样，不新增绘制批次。
>
> 验证：浏览器内单测 **709/709**（新增 `test-fog-sky-direction.js` 7 条）；
> `fog-color.spec` **5/5**；回归 `skybox`/`sun-shadow`/`sun-directional`/`render-terrain`/
> `daynight-visual` **16/16**；`npm run check` 0 error。
> **3 条负向验证全部真 FAIL**：① `uFogColorMix` 写死 0（ΔR 0.0）② 去掉 y 钳制
> （俯视 ΔR **−3.3**，方向反转）③ 纯函数侧去掉钳制（单测 3 条 FAIL）。
> ⚠️ **负向验证盲区实测**：去掉 y 钳制后，**平视**机位仍然通过（ΔR 从 5.0 只降到 3.5，
> 仍 > 阈值 2）—— 因为平视时 `dir.y` 本就接近 0。**只有俯视机位能抓到该回归**，
> 故 `fog-color.spec` 特意保留两条不同机位的用例（同判据、不同 pitch）。


---

## 1. 背景与目标

mc-lite 是一个基于 Three.js（r184 WebGPU）的纯前端体素游戏，995 次提交、约 5.5 万行 JS。
功能完整（124 种方块、城市/金字塔/海岛等地标、武器、矿车、炮塔、存档、天气、光影），
但架构是"功能驱动 + 补丁叠加"长出来的，性能天花板已经锁死：

- 可视距离只有 2~3 个 chunk（32~48 格），扩大一圈立即卡顿；
- 新档需要阻塞预生成 56×56 个 chunk 的大地图，启动极慢；
- 触碰 region 边界后台扩图时明显掉帧；
- 玩家奔跑过程中帧率不稳，高刷设备跑不满。

**第一阶段目标（验收口径）**：

| 指标 | mc-lite 现状 | mc-heavy 目标 |
|---|---|---|
| 冷启动到可玩 | 预生成数十秒~分钟级 | < 2 秒可操作（出生点邻域先就绪，视距内后台填充） |
| 默认可视距离 | 2~3 chunk（32~48 格） | 8 chunk（128 格），架构支持 16+ |
| 奔跑帧率（视距 8） | 扩大即卡顿 | 60 fps 稳定；120Hz 设备 ≥ 90 fps |
| 跨 region 边界 | 明显卡顿 | 无感知 |
| 放块/挖块响应 | 依赖 consolidation 异步收敛 | 单帧内视觉生效（< 16ms） |
| 存档体积 | 整块 blockData 序列化 | 仅存玩家修改（diff），KB 级 |

设计原则：

1. **数据只有一份权威**：主线程内存中的 typed array 体素数据。其余一切（网格、AO、可见面、碰撞）都是可随时重建的派生数据。mc-lite 的 WorldBlockDataStore / RegionCache / WorldChunkPayloadRegistry / WorldChunkRegistry / solidBlocks / visibleKeys / instanceIndexMap 等多层容器全部不再需要。
2. **重计算全部离开主线程**：地形生成、网格化、光照计算在 Worker 池完成；主线程每帧只做输入、物理、调度、上传、渲染。
3. **确定性生成**：地形 + 结构完全由 seed 决定，任何时候可以按需重算。这是"干掉预生成"的前提，也是存档只存 diff 的前提。
4. **同步响应、异步优化**：玩家操作必须当帧视觉生效（主线程快速路径），后台再做高质量重算（Worker 精修路径）。两条路径用统一的版本号协议收敛，从架构上消灭 mc-lite 里反复打补丁的竞态问题。

---

## 2. mc-lite 瓶颈诊断（重构依据）

对 5 个指定问题逐一给出根因分析。这些结论直接决定新引擎的设计取舍。

### 2.1 地图预生成慢、边界卡顿

**现状链路**：`WorldGenerationService.generateInitialWorld()` 新档阻塞生成 7×7 region = 56×56 chunk，
逐 chunk 发给单个 WorldWorker 生成（每 chunk 内部还要跑完整结构队列、AO、面剔除），结果按 region 写 IndexedDB；
接近边界时 `WorldBoundsController` 触发后台扩图，扩图期间与玩家操作争抢同一个 Worker 和主线程装配预算。

**根因**：
- 预生成本质是"把随时可以算出来的东西提前算完并存盘"。因为 mc-lite 的地形生成是确定性的（seed 驱动），预生成在信息论上是冗余的——唯一不可再生的是玩家修改。
- 单 Worker 串行生成 + 主线程逐 chunk 装配（`BlockScatterManager` 分发 + `ChunkAssemblyScheduler` 预算内装配），生成吞吐被主线程装配上限锁死。
- 结构（城市、金字塔）跨 chunk 溢出（overflowChunks / crossRegionOverflowMap）导致生成必须以 region 为单元批量做，进一步放大单次任务体积。

**新引擎对策**（详见 §4.2）：彻底删除预生成。chunk 进入加载半径才生成；结构布局由确定性索引按 region 计算、按 chunk 裁剪注入。
注意：跨 **chunk** 的溢出被生成期裁剪吸收（每个 chunk 只写自己范围内的块），但跨 **region** 的溢出是真实需求
（地标随机中心偏移 100~400 + 半尺寸 40~80 会越过 400 格 region 边界），由邻区索引查询解决（§4.2），
而非 mc-lite 的 `crossRegionOverflowMap` 运行期暂存。

### 2.2 奔跑帧率低、视距无法扩大

**根因（按影响排序）**：

1. **渲染几何模型低效**。mc-lite 的"面剔除"只决定**方块**是否可见（visibleKeys），但每个可见方块仍然渲染**完整立方体**（6 面 12 三角形）——一个只露出顶面的泥土块照样画 6 个面。且按方块类型分 InstancedMesh（`geomMap` + 每类型一个 mesh），124 种方块 × 每 chunk 若干类型 × 视距内几百 chunk = 数千 draw call，且无法用纹理图集合批。这是视距扩一大就崩的第一原因。
2. **交互走 THREE.Raycaster 与 InstancedMesh 求交**（`PlayerInteraction.js` 每帧 `intersectObjects(targets, true)`）。对 instanced mesh 求交要逐实例逆矩阵变换，视距内实例数以万计，奔跑时每帧射线检测是主线程大头。
3. **主线程装配/合并开销**。动态方块的"先独立 Mesh、后 consolidation 合并"双层渲染、AO 防抖覆写、跨 chunk 补丁分批刷入（`GLOBAL_INSTANCE_FLUSH_*` 一整组预算常量）都在帧内抢时间。
4. **数据结构低效**。blockData 经最近重构后是 `Map<chunkKey, Map<encodeCoord(number), entry>>`
   （`WorldBlockDataStore` 三层容器，数字键 Map，混合少量旧 string 档），`solidBlocks` 仍是字符串 Set。
   高频读写路径（物理碰撞每帧数十次查询）走双层哈希 + 对象分配，且 chunk 级 Map 无法做 O(1) 的
   坐标算术索引与连续内存遍历。结论（哈希 + 对象分配是热路径瓶颈）不变，但按现状表述。

**新引擎对策**：逐面网格化 + 纹理图集（§4.3/§4.4）、体素 DDA 射线（§4.5）、typed array 数据层（§4.1）、主线程零重计算（§4.9）。

### 2.3 大型建筑打散逻辑

**现状**：结构在 Worker 里整体生成后"打散"成 scatteredBlocks，由 `BlockScatterManager` 按坐标分发到各 chunk buffer，
再有 `pendingCrossChunkPatchBuffers` 延迟跨 chunk 补刷、`structureCenters` 合并、ready/flush 状态机等一系列补丁。
打散是为了"结构不整体出现、避免近距离闪现"，代价是结构实体消失、所有交互都对着散块，且分发/补刷/去重逻辑成为长期 bug 源。

**诊断**：打散解决的真问题是"跨 chunk 结构的生成结果如何落到各 chunk"。这是一个**生成期**问题，mc-lite 把它推到了**运行期**用 buffer 分发解决，才需要这么多层状态。

**新引擎对策**：生成期解决。每个 chunk 生成时，通过确定性结构索引查询"所有 AABB 覆盖本 chunk 的结构"，直接把结构方块裁剪写入本 chunk 数据。结构从来不是实体，也不需要 buffer 分发——每个 chunk 落地即完整，天然没有闪现，`BlockScatterManager` 整层删除。

### 2.4 face culling / consolidation / instanced mesh 归一化

**现状**：三套机制各自为政——
- FaceCullingSystem（主线程 + FaceCullingWorker）算可见性；
- Consolidation（脏块 ≥50 或 1000ms 防抖）把整 chunk blockData 发 Worker 重算重建 InstancedMesh；
- GlobalInstancedMeshManager 把各 chunk 的同类型实例归一到全局 TypeBuffer，带容量增长、脏区上传、chest 状态迁移等复杂簿记。

**诊断**：这三者本质是同一件事（"体素数据 → 可渲染几何"）被拆成三条互不信任的路径，于是需要 epoch、防抖、AO 旧值保留、脏集、竞态 guard 等补丁缝合。冗余确认属实。

**新引擎对策**：统一为单一 meshing 管线（§4.3）。面剔除是 meshing 的内部步骤；consolidation 不存在（没有"临时 mesh"中间态）；InstancedMesh 退出地形渲染（保留给矿车/丧尸等动态实体）。

### 2.5 可视距离扩展性

**现状**：渲染距离硬编码 2~3，扩大即帧率崩（原因见 2.2）。

**新引擎对策**：视距在新架构里只是一个配置项。关键支撑：
- 逐面网格化 + atlas 后，**单位面积**渲染成本大幅下降（全立方 12 tri/块 → 暴露面 2~8 tri/块，
  平均约 2~4×、理论上限 6×）。注意：视距 8 的可见**面积**约为视距 3 的 7 倍，总三角形数仍会高于 lite 视距 3，
  所以收益口径是"每方块/单位面积"而非"总量持平"——真正的瓶颈与解法在 draw call（§4.4.2）；
- 生成/网格化全在 Worker 池，视距扩大只增加后台任务量，不增加主线程帧内成本；
- 预留 LOD 接口（§4.4.5）：远圈 chunk 可降级为合并粗模，主线程 draw call 增长有上限。

---

## 3. 总体架构

```
┌────────────────────────────────────────────────────────────────┐
│                        主线程（帧循环）                          │
│                                                                │
│  Input → Player/Physics(定步长) → Systems → Scheduler → Render │
│                                        │                       │
│  WorldData（唯一权威）                   │ 帧预算控制器           │
│  ├─ ChunkColumn: Uint16Array 体素       │ (上传/重建 ≤ N ms)    │
│  ├─ Edits: 玩家修改稀疏层               ▼                       │
│  └─ LightData: 光照数组          Mesh 上传 / Section 快速重建    │
└───────────────────────────────┬────────────────────────────────┘
                                │ Transferable（零拷贝）
                                ▼
┌────────────────────────────────────────────────────────────────┐
│                     Worker 池（N = CPU-1）                       │
│                                                                │
│  任务类型（按优先级调度，可取消，版本校验）：                       │
│  ① GEN     地形+结构生成（seed 确定性）                          │
│  ② MESH    section 网格化（面剔除+AO+顶点缓冲构建）               │
│  ③ LIGHT   光照/AO 增量精修                                     │
│  ④ REMESH  批量修改（爆炸等）后的区域重建                         │
└────────────────────────────────────────────────────────────────┘
```

分层与依赖方向（单向，禁止反向依赖）：

```
voxel(数据) ← gen(生成) ← mesh(网格化) ← render(渲染)
     ↑                        ↑
  player/物理/交互          save(持久化)
```

- `voxel` 不知道渲染存在；`mesh` 只读体素数组产出顶点缓冲；`render` 只消费缓冲。
- `gen` 与 `mesh` 的核心函数是**主线程/Worker 同构**代码（纯函数、无 DOM 依赖），
  这保证：单块修改可以在主线程 1~2ms 内同步重建一个 section（快速路径），
  同时 Worker 可以异步产出同质量的完整结果（精修路径），两者输出格式完全一致。

技术选型（延续 mc-lite 的开发体验）：
- **纯 JavaScript（ES2022+ ES Modules），不使用 TypeScript**，无编译/转译环节；
  类型信息用 JSDoc 注释表达（关键数据结构与公共 API 加 `@param/@returns/@typedef`），
  配合 ESLint 保证质量，延续 mc-lite 的工具链；
- Three.js **r185.1**（2026-07 最新稳定版，mc-lite 为 r184，API 兼容直接升级），
  **WebGPU 唯一后端**（详见 §4.4.6，不做 WebGL2 降级）；import map + ES Modules，**无构建步骤**；
- Module Worker（`new Worker(url, {type:'module'})`）；
  注意：module worker **不继承**页面的 import map（浏览器支持参差），因此 worker 内一律用
  相对路径 import 本项目模块；three.js 只在主线程使用，world-worker 不依赖 three，实际影响小，
  但作为约束写明，避免后续踩坑；
- 持久化 IndexedDB（延续 mc-lite 的 SaveConfig 命名，便于老存档迁移工具后续接入）。

---

## 4. 核心子系统设计

### 4.1 体素数据层（src/voxel/）

**坐标与尺寸**
- 世界高度固定 128：`WORLD_MIN_Y = -32, WORLD_MAX_Y = 96`。
  与 mc-lite 坐标兼容（海平面 y=-2、基岩 y=-13、地标结构原样移植无需平移）。
  下界取 -32 而非 -16 的原因：mc-lite 地形柱填充最低到 `h-12`，而噪声高度 h 理论下界约 -16，
  最低块可达 -28；`MIN_Y=-16` 会截断极端地形。-32..96 仍是 8 个 16 格 section 整除。
- ChunkColumn：16 × 16 × 128，世界数据与存档的基本单元（对应 mc-lite 的 "cx,cz" chunk）。
- Section：16 × 16 × 16，网格化与脏标记的基本单元。每 column 8 个 section（sy = 0..7）。

**存储**

```js
class ChunkColumn {
  cx; cz;                          // column 坐标
  blocks: Uint16Array(16*16*128);  // 方块 ID，索引 = x + z*16 + (y-MIN_Y)*256
  meta:   Uint8Array(16*16*128);   // orientation(3bit) + 保留位（发光强度等）
  edits:  Map<index, {id, meta, blockEntity?}>;  // 玩家修改稀疏层（生成时叠加，卸载时序列化）
  blockEntities: Map<index, object>;  // 方块实体富状态（宝箱库存/告示牌文字/灯开关等），
                                      // 稀疏，仅对有状态的方块存在；第一阶段只预留通道
  light:  Uint8Array(16*16*128);   // 高4位 skylight，低4位 blocklight（§4.6）
  sections: Section[8];            // 派生：网格状态（dirty/mesh/version）
  state: 'empty'|'generating'|'ready';
  version: number;                 // 每次 blocks/meta 数据变更 +1，所有异步结果校验用；纯 blockEntity 状态不进 Worker
}
```

- `blocks` 是"terrain + edits 叠加后"的最终数据（生成完毕即叠加），保证读路径零分支。
  `edits` 仅用于持久化与 column 重生成（卸载后内存释放，再进入视距时 terrain 重算 + edits 重放）。
- **权威边界澄清**：gameplay 的真相来源只有 `blocks` + `meta`（+ `blockEntities` 富状态）。
  `light` 数组是**可从 blocks + emissive 重算的派生缓存**（为渲染免重算而常驻），
  不是权威——任何光照不一致都可通过重算收敛，实现时不得把 light 当真相来源。
  mesh/AO/可见性/碰撞同理，全是派生数据（§1 设计原则 1）。
- **方块实体通道（v1.4 补齐，只预留不实现消费者）**：宝箱库存、告示牌文字、熔炉进度、
  可开关灯的亮灭等状态**无法塞进 8bit meta**，需要每位置任意结构化数据。
  mc-lite 已有该需求的证据：`ChunkConsolidation.js:597 _saveChestStates()` 在 mesh 重建时
  迁移 `instanceIndexMap['chest']` 的状态（用 InstancedMesh userData 暂存，是补丁式实现）。
  新引擎把它做成数据模型的一等公民：`blockEntities` 稀疏 Map，key 与 blocks 同索引，
  value 为任意可序列化对象。第一阶段不实现任何消费者（宝箱/告示牌属后续阶段），
  但 edits 条目、持久化 schema、重放逻辑现在就把形状定好，避免后续回填引发
  存档 schemaVersion + edits 重放的二次重构。
- 方块 ID 0 = air。`BlockRegistry`（src/voxel/block-registry.js）负责 string name ↔ ID 映射与属性表：

```js
registry.register('grass_block', {
  solid: true, opaque: true,
  faces: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, // atlas tile 名
  cullMode: 'opaque',        // opaque | cutout | transparent | none
  emissive: 0,               // 发光强度 0-15（灯/萤石/岩浆）
  geometry: 'cube',          // cube | cross(花/草) | slab | 自定义模型
  orientationModes: 0,       // 支持朝向的数量（沿用 mc-lite OrientationUtils 语义）
});
```

- 属性全部预编译为按 ID 索引的 typed 查找表（`opaqueTable[id]`, `cullTable[id]`…），
  网格化热路径无对象属性访问、无字符串比较。mc-lite 的 BlockData.js（124 种方块）整体迁移为注册表数据。

**registry 的属性表（8 张 typed 表，主线程与 Worker 同构可用）**：`solidTable` /
`opaqueTable` / `cullTable` / `emissiveTable` / `geometryTable` / `orientationModesTable` /
`supportsPlayerTable` / **`indestructibleTable`（M8 新增）**。每张表由 `register(name, def)`
从声明派生，`freeze()` 后不可变。

**`indestructibleTable`（M8 新增）**：「哪些方块不可被破坏」的唯一权威。
三个消费者全部读这张表，不得各写字面量：① `Player.digBlock()` 徒手挖块门控；
② `weapon-target-policy.js` 枪械可破坏判定（与 `settings.gunBlockDamage` 开关叠加，链路：
`game.setGunBlockDamage()` → `weaponController.setBlockDamage()`；
   该模块另有一个「武器专属收紧」名单 `WEAPON_ONLY_IMMUNE`，⚠️ **v2.90 起已清空** ——
   原本只有 `end_stone`，用户裁定「end_stone 也可以被枪械消灭」后移除；名单机制保留作扩展点）；
③ `computeExplosion()` 爆炸过滤。
mc-lite 的表达是**分散且不重合**的：`ExplosionWorker.js:8` 的字面量数组
`['playground_block','playground_center_block','bedrock','barrier']`，与
`BlockData.js:244/252` 的 `isIndestructible: true` 字段 —— 后者**只标了 playground 两项**
（bedrock/barrier 只在字面量里）。即「哪些不可破坏」在上游没有一个完整清单，
本仓库收敛成一处权威。
**M8 只登记一项：`bedrock`**（TNT 爆炸过滤需要）。`playground_block` /
`playground_center_block` 两项移交 M9 —— 登记 indestructible 与「移出背包」必须成对做
（只登记不移出会产出「放得出来但挖不掉」的撕裂状态），故两项一起留在 M9。
⚠️ **不含 mc-lite 清单里的 `barrier`** —— 该方块在本仓 registry 里不存在（它对应 mc-lite 的
`collider` 系碰撞体方块），照搬会登记一个不存在的名字 → 门控静默失效。

- **查询接口**（v1.16 补记）：`idOf(name)` / `nameOf(id)` / `geometryNameOf(id)` /
  `supportsPlayer(id)`，以及 `all()` —— 按注册顺序返回 `{id, name}[]` 只读快照。
  `all()` 由 §4.5.4 背包物品集合构建消费（冷路径，一次性），**禁止**进入 meshing/物理热路径
  （热路径仍走 typed 表 + 数字 ID）。冻结后 `all()` 结果不变，可安全缓存。
- **cullMode 语义勘误（M2 bug 修复）**：cullMode 是**渲染通道**选择（opaque/cutout/transparent
  三材质之一），必须对齐 mc-lite 的**材质**透明度（MaterialManager 注册的 transparent/alphaTest），
  而不是 BlockData 的 `isTransparent`（那是面剔除语义：「不剔除邻居面」）。M0 转换曾把二者混同，
  导致台阶/栏杆/柱子/宝箱等 12 个不透明材质方块落入 blended 通道（depthWrite=false）——
  L 形台阶自身面片无深度互遮，凹角透视穿帮。已修正：上述方块改 cutout（alphaTest 0.3 对
  全不透明贴图无副作用、深度写入恢复）；剔除语义由 `opaqueTable` 独立承担，不受影响。
  真混合通道仅留 water/swamp_water/cloud/glass_block/glass_blink。
  ⚠️ **补记（v1.42）**：`sky_leaves` 同属本勘误族 —— M2-7 按「名字含 leaves」归为 cutout，
  但 mc-lite 材质是 `mkMat('#FF69B4', 0.9)` = `transparent + opacity`、**无 `alphaTest`** → 不是镂空；
  且 cutout 通道 `alphaTest=0.3` 且无 `transparent` → alpha 0.902 全保留不混合，实际渲染本就是
  不透明纯粉 → v1.42 改为 `opaque`（声明与实际一致）。详见
  `docs/superpowers/specs/2026-09-20-sky-tree-design.md` §2.6。
  ⚠️ **补记（2026-09-30，同族反方向实例）**：`chimney` 是「两套口径被混同」的**另一个方向** ——
  sky_leaves 错在**通道**（该 opaque 却归 cutout），chimney 错在**剔除语义**：registry 按
  `cullMode === 'opaque'` 推 `opaqueTable`（`block-registry.js:43`），于是它因材质不透明进了
  opaque 通道，**连带**被误判成「占满整格、可剔除邻居面」→ mesher 剔掉烟囱下方屋顶块的顶面
  （用户报告「烟囱底部接触的方块面是透明的」）。实测本仓库**全部非 box 几何方块的
  `opaqueTable` 都是 0**（它们 cullMode 都是 cutout），唯二漏网是 `chimney` 与
  `bed_head`/`bed_tail`（half_block）。修法 = `cloud` 同款手法（cullMode 与 opaque 解耦）：
  显式 `"opaque":false`，cullMode 仍 `opaque`。⚠️ **与 cloud 的区别**：cloud 要同类互剔
  （云簇内部不出面）故须加 `SAME_TYPE_CULL`；chimney 不需要（两个相邻烟囱各自都是细柱，
  互不遮挡）→ 只加 `opaque:false`。⚠️ **后续加非 box 几何方块须显式声明 `"opaque":false`**，
  否则转换规则会按 cullMode 误推 `opaqueTable=1`（同类 bug 重犯）。连带效应（均为修正）：
  chimney 不再遮挡 AO / 阻断 blocklight / 挡炮塔 LOS —— r=0.15 的细圆柱本就不该完全遮光挡视线。

- **镂空遮挡体表 `hollowOccluderTable`（v1.70，派生表，非声明字段）**：
  `hollowOccluderTable[id] = (cullMode === 'cutout' && opaqueTable[id] === 1)` —— 当前 13 个树叶族。
  语义 = 「贴图有孔洞（alphaTest 逐片元 discard），所以不能被当作实心遮挡体」的方块。
  唯一消费方 = mesher 的面剔除：**邻居是镂空体、而本方块不是**时，不剔本方块朝向邻居的那一面
  （否则玩家透过叶孔看到背后的空气）。镂空体自身朝实心方块的面照旧剔（避免 z-fighting）；
  叶-叶共享面照旧互剔（双方都是镂空体）。
  ⚠️ **派生而非声明**（红线 1）：不新增「哪些是树叶」名单，新增镂空方块时只要声明
  `cullMode:'cutout'` + `opaque:true` 就自动落入本表；反过来，任何被误归的实心方块都会让
  全部方块的面不再互剔（顶点灾难），故 `check:data` 的 `[树叶剔除]` 双向钉住两侧。
  ⚠️ 与 `chimney` 的 `opaque:false`（cloud 手法）**不同**：chimney 是「完全不剔除任何邻居面」；
  镂空体是「只退一半」—— 它仍剔除自己朝实心块的面，只是要求对方保留朝向它的面。

**读路径 API**（物理/射线/meshing 共用）

```js
world.getBlockId(x, y, z)      // O(1)，越界返回 0（air）或基岩（y < MIN_Y）
world.getBlockMeta(x, y, z)    // O(1)，越界/缺列返回 0（M3.2 补记：挖块存朝向记忆需读旧 meta；
                               // M4 plan Task 2 亦计划新增，M3.2 提前交付，口径一致）
world.isSolid(x, y, z)         // opaqueTable 直查，无字符串
world.setBlock(x, y, z, id, meta)  // 见 §4.5.3 编辑管线；meta 低 2 位 = orientation（§4.3）
```

跨 column 读取由 WorldData 维护的 column 索引完成。meshing 的 halo 视图统一为 **section 级**：
`getSectionView(cx, sy, cz)` 返回 18×18×18 的连续体素视图（中心 section + 1 格 halo，
跨 column/跨 section 边界自动拼接）。column 级 18×144×18 视图不再作为接口暴露，
避免与 section meshing 粒度矛盾；GEN 任务内部如需整柱数据直接使用 `column.blocks`。

### 4.2 地形与结构生成（src/gen/，Worker 侧，完全按需）

**核心决策：删除预生成。** 世界没有边界（safeBounds/expandTargetBounds/WorldBoundsController 全部删除），
玩家走到哪里生成到哪里，seed 相同则世界相同。

**生成管线（每个 chunk column 一个任务）**：

```
GEN 任务(cx, cz, seed, edits)
  1. heightmap(16×16)     多层噪声 + biome（移植 mc-lite TerrainGen/MathUtils 噪声）
  2. 3D 填充              地层（bedrock/stone/dirt/表层）、洞穴（保留 rooms 逻辑）、水面填充
  3. 结构注入             StructureIndex.query(cx, cz) → 逐个结构 rasterize 并裁剪到本 column
  4. 叠加 edits           玩家修改覆盖生成结果（仅 blocks/meta，typed array 路径）
  5. 输出 Transferable    blocks/meta 的 ArrayBuffer + 结构元数据（光源点、实体挂点）
```

注：edits 重放在 Worker 侧只覆盖 `blocks`/`meta`（typed array，随 Transferable 回传）；
`blockEntities` 是对象 Map，不进 Worker，由主线程在 GEN 完成接管数据时从 edits 恢复
（§4.1），保持 typed array 传输路径干净。

**结构系统（对 mc-lite 的继承与改造）**：

- 布局确定性：`StructureIndex` 以 region（400×400，沿用 RegionMapConfig）为键，
  由 seed 确定性产出该 region 的地标清单与位置（金字塔/冰封山/雪地/海岛/城市/树木候选，
  以及 M2-7 的悬浮空岛与连通云簇候选）。单云层是逐 column 的纯噪声判定，无候选缓存。
  mc-lite 已有 `StructureCandidateIndex` + `RegionCenterUtils` + 各 maps（CityMap/Pyramid/…），
  这套"候选发现"逻辑**整体移植**，只改输出端：从"scatter 分发"改为"每 chunk 查询 + 裁剪"。
- **跨 region 溢出（真实需求，必须处理）**：mc-lite 地标随机中心偏移为 BASE 100 + SCALE 300
  （`RegionCenterUtils.CENTER_OFFSET`），叠加地标半尺寸 40~80，会越过 400 格 region 边界——
  `crossRegionOverflowMap` 不是冗余补丁而是真实需求。City 固定 [0,0] 且 224 宽不跨界，
  但金字塔/冰封山/海岛等会跨界。新引擎的解法：`StructureIndex.query(cx, cz)` 同时查询
  **本 region + 相邻 8 个 region**（邻区布局用同 seed 确定性重算，结果一致），把覆盖本 chunk
  的结构全部裁剪注入。不给地标加硬 margin（那会改变与 lite 的世界布局、破坏同 seed 对比）。
- **结构布局缓存（多 Worker 池的关键约束）**：N 个 Worker 各自持有 StructureIndex LRU 会导致
  同 region 的数百个 chunk 任务落在不同 Worker 上重复跑 City 布局（候选扫描很重），冷启动和
  进城时成为新卡点。解法：**布局在单个 Worker（或池内带布局锁的任务）里算一次，主线程
  只转发**——City 候选扫描较重，不能放主线程（会卡帧）；StructureIndex 的 region 布局
  结果体积小且确定性，布局 Worker 算好后由主线程随 GEN 任务参数下发给各 Worker，Worker 只做
  rasterize + 裁剪，不重复跑候选发现。**依赖规则**：某 region 的 GEN 任务必须等该 region
  及相邻 region（跨 region 查询最多涉及 9 份布局）的布局全部就绪后才下发。
- 结构光栅化：JSON 结构（src/world/structures/*.json 整体复用）与代码结构
  （城市排布、金字塔、tank 等，移植 WorldWorker 内各 generate* 函数）统一实现
  `Structure.rasterize(aabb) → blocks` 接口，输入任意 AABB 输出裁剪后的方块列表。
- **闪现问题的新解法**：结构块随 chunk 一起生成、一起进视距，远圈 chunk 未就绪时
  该区域就是"未加载"（雾遮挡），不存在"玩家跑到跟前结构突然蹦出来"——
  因为加载半径 ≥ 视距 + 生成提前量（§4.9 调度保证），结构永远在玩家看见之前就绪。
- **空中结构（M2-7）**：悬浮空岛和连通云簇的候选按其来源 chunk 的 `(cx, cz, seed)`
  纯 hash 在 region layout 中一次计算；`StructureIndex.query(cx, cz)` 仍查询本 region 与相邻 8 个
  region，再按候选 AABB 与当前 column 相交性过滤。岛体/云簇/**天空树**只把落入当前 column 的体素写入
  `blocks`，不存结构中心、不创建 entity、不发跨 column 补刷。原 mc-lite 的 `Math.random` 连通云
  游走改为同一 hash 序列，确保任意加载顺序结果一致。Y=55 的单云层直接由 `(wx,wz,seed)`
  噪声生成；Y=35 的连通云簇由 region layout 候选驱动。
  `cloud` 的属性（**v1.96 起 `solid:true`** —— 云不可穿越，有意偏离 mc-lite 的 `isSolid:false`）：
  - `solid:true` → 玩家/丧尸/弹丸/矿车都不能穿云；连带炮塔 LOS、雨滴地面截停、放置兜底遮挡、
    结构 ground-support 探地全部跟着变（`solidTable` 是单一权威，消费方零代码改动）。
  - `supportsPlayer:true` → 可站立（M2-7）。与 `solid` 是**叠加**关系：`isSolid` 先命中，
    该表成为向下碰撞的冗余第二道门，语义不变。
  - `cullMode:'opaque'` + `opaqueTable=1`（M2-7 通道勘误）/ `shadowCast:false`（不投影）/
    不遮光 —— 三项均**未**被 v1.96 改动。
  天空树（v1.42 回补）在岛体之后写：顶层每个岛格按 `seededRandom(wx,wz,seed+113) < 0.05`
  独立判定（⚠️ **有意偏离 mc-lite 的 0.1**，用户指令减半，单一权威 = `SKY_TREE_CHANCE`），
  命中则以 `(wx, topY+1, wz)` 为基点调 `generateTree(..., 'skyTree')`。
  候选 AABB 门控比岛体宽 2 格（树冠外扩 ±2），否则跨界树冠会在相邻 column 断裂。

**生成性能预算**：
- 单 column GEN（无大结构）目标 < 8ms（Worker 时间）；含城市结构切片 < 25ms。
- Worker 池并行（默认 `hardwareConcurrency - 1`，下限 3），按"距玩家切比雪夫距离 + 视线方向加权"排序。
- 任务可取消：玩家移动导致 chunk 出圈时，队列中未开始的任务直接丢弃。
- 冷启动：**出生点邻域（3×3 column）先就绪即可玩**，视距内其余 (2×8+1)²=289 个 column
  后台填充。注意"看到 128 格"需要 289 个 column 全部 GEN，所以"冷启动 < 2s"的口径是
  "可操作、可移动"，而非"视距内全部渲染完成"——后者在后台数秒内补齐。
- **出生点安全**：复刻 mc-lite 的"spawn on dry ground"逻辑——出生点向下搜索首个非 air 方块，
  在其上方生成，避免出生落水或悬空（上一版 TS 实现已验证此逻辑必要）。

### 4.3 网格化管线（src/mesh/，唯一的面剔除/合并实现）

**输入**：一个 section 的体素 + 1 格 halo + 光照数据。
**输出**：三个顶点缓冲（opaque / cutout / transparent），直接可上传。

**面剔除规则（meshing 内部步骤，不再有独立 FaceCullingSystem）**：

```
对每个非 air 方块的每个面：
  neighbor = 邻居方块
  emitFace = neighborCullMask[neighbor.id] < faceOpacity[face]
  特例：water/glass 同类型相邻不画面；cutout（树叶/花）按配置决定是否自剔除
```

**顶点格式（flat 三属性，v1.6 由 interleaved 改为 flat）**：

```
position: Float32BufferAttribute ×3  （section 局部坐标，mesh.position 挂 chunk 世界偏移）
uv:       Float32BufferAttribute ×2  （atlas 坐标，构建时写入）
packed:   Uint32BufferAttribute ×1   （bit0-7: light = skylight<<4 | blocklight，§4.6；
                                      bit8-9: AO 值 0-3，经典四角 AO，移植 mc-lite AOUtils 算法
                                              （v1.31 去掉对角门控，有意偏离 mc-lite，见下）；
                                      bit10-12: 面索引 0-5，供着色器取法线——不依赖导数技巧，M1 前定死；
                                      bit13: 材质自发光标记（v1.21 新增，见下））
```

**bit13 = 材质自发光标记（v1.21 新增）**：对齐 mc-lite `MeshStandardNodeMaterial` 的
`emissive` + `emissiveIntensity`（材质层属性）。实测 mc-lite **只有 `hanging_lamp` 一处**有
材质自发光（`MaterialManager.js:1199`，`emissive:'#FFE4B5'` × 0.8），其余材质的 `emissive`
都是默认 `0x000000`，故**不能给整个 cutout 通道加自发光**（会让 vine/flower/leaves/cactus
等全部发光），必须按方块区分 → 用顶点位传递。

- **与 `blocks-data.js` 的 `emissive:15` 是不同概念，不可复用**：后者是 **blocklight 光照源**
  （照亮周围方块，`mesh/lighting.js:127` 消费 `registry.emissiveTable` 做 flood fill）；
  本位是**材质自发光**（材质本身发亮，与周围光照无关）。四个发光方块
  （glowstone/ochre_froglight/lava/hanging_lamp）都有 blocklight 源，但只有 hanging_lamp
  有材质自发光——所以两个集合不同，不能用 emissiveTable 判断本位。
- **为什么用 hardcoded Set 而非 blocks-data 字段**：这是 **mc-lite 材质层属性**的移植
  （`MaterialManager.js` 的材质定义），与 `DOUBLE_SIDE_CUBES`（mc-lite 材质 `side` 属性）、
  `SAME_TYPE_CULL`（mc-lite 材质语义）同一性质——mesher 用 hardcoded Set 表达，不入
  `blocks-data.js`（后者是 BlockData.js 的方块属性转换产物）。
- **发布粒度不变**（红线 5）：不新增材质、不新增通道，仍是 opaque/cutout/transparent 三通道
  BatchedMesh；自发光在片元阶段按顶点位分支，代价是一次位运算 + 一次混合。
- **粒度：quad 级可覆盖（v1.22）**：默认按方块判定（`EMISSIVE_MATERIALS`），但模板 quad 可用
  可选字段 `em` 覆盖（`true`/`false`），未声明时走方块级默认 → 既有模板行为零变化。吊灯用它
  令「绳不发光、灯体发光」（见下）。`materials.js` 的 `vEmissive` 本就是逐顶点 float varying，
  bit13 降到 quad 级后自动生效，无需改材质。

**台阶的亚体素 AO（v1.86 新增）**：AO 的遮挡判据从「整格是否 `opaqueTable`」换成
「采样点所在的 1/2 子格是否被占据」。**只有台阶族纳入**，其余方块行为逐位不变。

- **问题**：台阶是 `cullMode:"cutout"` 且未声明 `opaque` → `opaqueTable=0`。旧口径下台阶
  **既拿不到自己的凹角阴影**（3 邻居采样只认整格，台阶 0.5 高度面不在范围内），
  **也投不出阴影给邻居**。实测孤立 `planks_step` 的 48 个顶点几乎全是 AO=3。
- **判据**：每个方块有一张 8 位八分区掩码（bit i = 子格 `(i&1, (i>>1)&1, (i>>2)&1)`），
  由 `STEP_BOXES` 的盒列表派生；`opaqueTable=1` 的方块恒 `0xFF`。采样点 =
  顶点 + `0.25×(法线 + 切向1 + 切向2)` —— 0.25 是载荷性的：顶点分量在 `{0, 0.5, 1}` 时，
  采样点每个分量恒落在 `±0.25 / 0.75 / 1.25`（子格中心或其镜像），**永不落在 1/2 边界**，
  故无取整歧义。
- **零回归的机制**：整格面（顶点 ∈ {0,1}）经上式得到的落格与旧口径逐项相同，且 opaque
  方块掩码恒 `0xFF` ⇒ 纯实心世界新旧逐位相同（实测 5 视域 opaque/cutout 全 0 差异）。
- **第 4 样本 `front`（载荷性）**：经典 3 样本的前提是「法线正对的邻格是空气」——否则该面
  会被面剔除。台阶 `opaqueTable=0` **打破了这个前提**：邻居朝它的面照旧发射，而 3 样本只从
  邻格再往切向斜偏，**永远采不到邻格本体** → 台阶给邻居的「衔接阴影」会漏。故补一个
  「正对格中心、贴近本面那一侧」的子格采样；整格/空气格显式跳过（`m===0 || m===0xff`）。
- **纳入集合 = `STEP_BOXES` 的键**（`planks_step` / `cobblestone_step` /
  `cobblestone_step_updown` 三种几何，共 5 个方块）。**半砖（`half_block`）与装饰几何
  （仙人掌/栏杆/花）刻意不纳入** —— 它们的「暗部」没有明确物理意义，纳入只会产生无意义暗块。
- **形状权威仍是一份**：`STEP_BOXES` 的盒列表同时派生 `TEMPLATES` 的 quad 与八分区掩码
  （红线 1），不再是「96 个 quad 反推盒」。
- **性能**：探针输出写进复用数组（不逐顶点分配），实心世界 −7%~−24%、含台阶世界 −6%
  相对改动前（交替 3 轮中位）。
- 断言见 `src/tests/test-mesher.js` 的四条台阶 AO 用例（含「纳入集合边界」对照）。

**吊灯 UV 分区（v1.22 新增，有意偏离 mc-lite）**：模板 quad 的可选字段 `uvRegion: [u0,v0,u1,v1]`
把该 quad 的 UV 线性重映射到 tile 内子区域（`remapRegion(u,v,r) = [r[0]+(r[2]-r[0])*u,
r[1]+(r[3]-r[1])*v]` 纯函数），令同一方块的不同部件采样贴图的不同区域：

```js
// 区域边界按 texel 中心对齐（不是像素边界）：fillRect(30,0,4,20) 填 col 30~33 / row 0~19，
// texel 中心在 30.5~33.5 / 0.5~19.5 → NearestFilter 下采样点落在纯色区内，不会采到相邻背景。
// atlas 的 v 轴翻转（build-atlas.mjs:103 `v0 = 1-(shelfY+h)/SIZE`）→ canvas row r 对应
// tile 局部 v = 1 - r/64。
const LAMP_ROPE_REGION = [30.5/64, 1-19.5/64, 33.5/64, 1-0.5/64];   // 绳图案 → 单色 #333333
const LAMP_BODY_REGION = [18.5/64, 1-47.5/64, 45.5/64, 1-20.5/64]; // 灯体图案 → 不含绳图案
```

- 绳（`prismQuads` 8 段棱柱）→ `uvRegion: LAMP_ROPE_REGION` + `em: false`：整段绳只采样
  4 texel 宽的绳图案区 → 呈单色深灰；不吃 emissive → 不被暖黄加项冲淡。
  `prismQuads` 的侧面/顶盖/底盖共用同一 `uv` 数组，故三者统一落到绳区域。
- 灯体（`boxQuads` 6 面）→ `uvRegion: LAMP_BODY_REGION` + `em: true`：v 只覆盖 row 20~47，
  **不含 row 0~19 的绳图案** → 灯体四个面无绳图案；吃 emissive → 发光暖黄。
- **几何坐标不变**（120 顶点、绳 r=0.015/y∈[0.6,1.0]、灯体 0.3³ 块中心），只改 UV 与 bit13。
- 回归防线：单测钉死「绳 quad UV 全落在绳区域、灯体 quad UV 全落在灯体区域」，并反向钉死
  「绳区域不含灯体图案区」——若有人把区域常量写成全幅会立刻被抓到。

**为什么 flat 而非 interleaved（v1.6 源码核验）**：`setGeometryAt` 的 `copyAttributeData`
（BatchedMesh.js:97-110，已核验）对 `isInterleavedBufferAttribute` 走逐分量
`getComponent/setComponent` 慢路径（重 section 十多万次带边界检查的调用），会吃掉
<2ms 快速路径预算；flat 属性走 `dst.array.set()` 快路径。BatchedMesh 内部本来就是 flat 属性。
**packed 必须是 uint32 而非 uint16**：WebGPU 规范要求顶点 `arrayStride` 是 4 字节倍数
（规范原文已核验），flat 的 uint16（itemSize=1）stride=2 字节会在 pipeline 创建时
validation error；uint32 stride=4 合法，且 13bit 实际用量余余充足。**不要为了"省 2 字节"
改回 uint16**。每顶点 12+8+4 = 24B，与 interleaved 版总量持平（flat 化的收益是拷贝快路径，
不是省显存）。
每面 4 顶点 6 索引（uint32 index buffer）。一个典型地形 section 约 1~4k 面 → 缓冲 100~400KB 级别，
上传走 `BufferAttribute.addUpdateRange(start, count)` 只传变化段（r185 正式 API，
配合 `clearUpdateRanges()`；不要直接改 `updateRanges` 数组）。

**两条重建路径（统一输出格式，版本号收敛）**：

| 路径 | 触发 | 执行位置 | 延迟 |
|---|---|---|---|
| 快速路径 | 单块放置/挖掘 | 主线程同步重建该 section（±邻居面） | < 2ms，当帧生效 |
| 精修路径 | chunk 首次就绪、光照变化、批量修改 | Worker MESH 任务 | 1 帧~数十帧，结果按 column.version 校验后原子替换 |

快速路径保证手感；精修路径保证最终质量（完整 AO/光照）。两者产出同构缓冲，
替换时按 slot 写回 + updateRange 增量上传（§4.4.2），无 mc-lite 式"动态 Mesh ↔ 合并 Mesh"双状态。
**consolidation 机制由此整体删除。**

**section 边界依赖的生命周期（halo 邻居协议）**：

面剔除与 AO 需要 1 格 halo，邻居 column 晚生成会导致边界面错误/接缝闪烁，必须显式管理：

1. **GEN 顺序**：调度按切比雪夫距离排序，保证内圈 column 先就绪；
2. **MESH 前置条件**：section 的 MESH 任务仅在其 4 个水平邻居 column **在加载半径内但尚未生成**
   时保持 pending，不产出半成品网格；半径外的缺失方向不 pending，直接走第 4 条的保守出块。
   （对角邻居只影响 AO，用"未加载=实心"近似，见第 5 条）；
3. **邻居到达触发重 mesh**：column B 就绪时，调度器把与 B 相邻的已 mesh column 的
   **边界 section**（贴 B 的那一排）置脏并重新入队 MESH。触发方是调度器（不是 column 自己），
   收敛依据是 column.version——重 mesh 结果携带触发时的邻居版本号，过期即丢弃；
4. **视距最外圈兜底**：最外圈 column 的 halo 之外是未加载区，面剔除按"未加载=不剔除"
   （保守出块）处理，玩家永远看不到未加载区的内部面；雾距覆盖该圈，视觉上无接缝。
5. **对角 AO 近似是永久性的**：对角 column 到达**不触发**重 mesh（只触发正交邻居），
   接受 column 角上 AO 的轻微偏差。若后续视觉验收不接受，再加"对角到达 → 角 section 重 mesh"触发。

**非立方体方块**：花/草（cross）、台阶、栏杆、烟囱、床、活塞头等 mc-lite geomMap 的特殊几何，
在 mesher 内按 `geometry` 类型展开预定义顶点模板（每种模板 = 一组面 + UV 映射），
仍然合入同一 atlas 材质——不再为每种形状维护独立 geometry/material。

**顶点模板已落地清单（M2 对齐 mc-lite，坐标逐格复刻 ChunkConsolidation.js geomMap）**：
flower/short_grass 等（0.7 cross，y∈[-0.1,0.6]）、vine（0.8 cross，y∈[0,1] 格内）、
lilypad（0.8×0.8 水平 quad，y=-0.48，**有意溢出格下半格**，见下）、cactus（主干+4 侧枝盒）、chimney（8 段棱柱高 2）、
handrail/A/B、vertical/horizontal_pillar、planks/cobblestone(_updown)/stone_diorite_step（L 形）、
half_block（床，1×0.5×1）、hanging_lamp（绳 8 段棱柱 r=0.015 + 灯体盒 0.3³）。

  **实例原点口径（换算基准，勿凭印象改）**：mc-lite 几何以**块中心**为原点，四条放置路径
  全部 `position.set(x+0.5, y+0.5, z+0.5)`（`ChunkConsolidation.js:529` / `Chunk.js:2474` /
  `WorldWorker.js:181,416,457`）；mc-heavy 模板坐标以**块底角**为原点（0→1）。故 mc-lite
  局部坐标须 **+0.5** 才可与 mc-heavy 模板值比对。上表数字均已换算为格内坐标。

  **vine 有意偏离 mc-lite（2026-09-03 勘误）**：mc-lite `geoVine` 为 `PlaneGeometry(0.8,1.0)`
  + `translate(0,0.5,0)`，局部 y∈[0,1]，加实例原点 +0.5 → **世界 y∈[0.5,1.5]**，向上溢出半格。
  其源码注释「向上偏移0.5，使几何体从y=0到y=1」说的是**局部**坐标，是误导——藤蔓挂在方块
  上方半格，不贴合方块边界。mc-heavy 改为 y∈[0,1] 落在格内。这是**已知的有意偏离**，
  比对 mc-lite 视觉时勿按 y∈[0.5,1.5] 判定。

  **lilypad 有意偏离 mc-lite（2026-09-05，bug 修复）**：模板 y 从 `0.02` 改为 `-0.48`
  （叶面落在块底之下半格），生成侧同时从 `SEA_Y` 改放 `SEA_Y+1`。**两处必须一起改，
  单独改任一处都错**（只改几何 → 叶面悬空半格；只改格位 → 叶面贴块底仍沉水）。
  换算与实测（诊断脚本，落点 `(-600,-270)`）：

  | | 世界 y |
  |---|---|
  | 叶面 = 实例原点(块底角 `SEA_Y+1` = -1) + 模板偏移(-0.48) | **-1.48** |
  | 暴露水面顶面 = `(SEA_Y+1)` − `WATER_SURFACE_SINK`(0.5) | **-1.50** |
  | 差 | **+0.02**（紧贴水面之上，不沉水）|

  - **为什么 mc-lite 沉水更严重却没人发现**：其 lilypad 是**装饰实体**（`EntityManager.js:412`），
    实例原点 = `Math.floor(y)+0.5` = 块**中心**，几何 `translate(0,-0.48)` → 叶面世界 y = **-1.98**，
    沉在整格水面顶面 -1.0 之下 **0.98**（mc-lite 自身即有此缺陷）。mc-heavy 的水面下沉 0.5
    把差距缩到 0.48，反而更扎眼。
  - **为什么不能放 `SEA_Y`**：`fillColumn` 水面填充区间是 `(h, SEA_Y]` → `y=SEA_Y` 是**水格**，
    覆盖它会挖出「水洞」（四周水还在、该格没水），且 `lilypad.solid=false` → 玩家踩上去掉进洞里。
    实测负向数据：改前该格 `atSea=lilypad / atSeaPlus1=air`，改后 `atSea=water / atSeaPlus1=lilypad`。
  - **陆地 lilypad 同口径贴合**：`jungle_pyramid.json` 的 4 个 lilypad 下方是 `cobblestone_step`
    （顶面 y=1.50）→ 叶面 1.52，贴合（原 y=0.02 时叶面 2.02，反而悬空半格 → 本次一并修正）。
  - **`big_house.json` 的 3 个草地 lilypad 已移除**（`x=-16/-14/-12, y=2, z=-13`）：其下方是 `grass`，
    顶面 y=2.00 是**整格高**，而水面/台阶顶面是**半格高**，两者差半格 → 同一份几何无法同时贴合，
    保留会让睡莲沉进草地 0.48。睡莲是水生植物，长在草地上本身是 mc-lite 数据怪异。
    这是**对「`assets/structures/*.json` 原样复用」约定的有意例外**之一（另一处是
    `tall_well.json` 删孤立悬空 chest，见 2026-09-30 修复记录）。
- **面 UV 口径 = three.js BoxGeometry buildPlane**（vendor/three r185.1 源码核验）：
  +X: u=1-z,v=y；-X: u=z,v=y；+Y: u=x,v=1-z；-Y: u=x,v=z；+Z: u=x,v=y；-Z: u=1-x,v=y。
  与 mc-lite InstancedMesh 一致（历史 bug：±X 用统一 UV → 东西面贴图旋转 90°，已修）。
- **双面口径**：mc-lite 植被/藤蔓/睡莲与 realistic_oak_leaves 为 DoubleSide，其余 FrontSide。
  单材质通道内用「双向绕线」复刻双面（不拆通道、不加材质）。cutout 材质 alphaTest=0.3
  （mc-lite 树叶族口径，树冠内表面背向剔除 → 堆积不过密）。
- **床 UV 变换（2026-09-03 勘误：原口径把 mc-lite 的「定义」误当作「行为」）**：
  mc-lite 床侧面材质定义 `repeat:[1,0.5]` + `offset:[0,0.5]`、顶面定义 `rotation:-π/2`，
  注释写「只使用纹理下半部分」「顺时针旋转90度」。**但 `offset` 与 `rotation` 全仓无任何
  消费点**（`grep -rn "\.offset\.set\|texture\.rotation" src/` 零命中；`_createMaterial`
  只消费 `repeat`，`preloadTextures` 只调 `_applyTextureSampling`）——它们是死字段。
  实测生效的 uvTransform 是 `v' = 0.5*v`（顶点 v∈[0,1] → 采样 v'∈[0,0.5]）= 贴图**下半**
  （PNG 行 8~15，实测 92 个不透明像素）；顶面**不旋转**、整图采样。
  本仓库据此实现 `vLowerHalf`（vv = 0.5*vv）与 `uFlip`（对应 `repeat:[-1,0.5]`，
  RepeatWrapping 下与纯镜像 uu=1-uu 等价，边界 u=0/u=1 采样同一 texel，已实测核对），
  顶面不加变换。
  **教训**：原实现照 mc-lite 的字段名与注释实现了「取上半 + 顶面旋转」，而上半（行 0~8）
  实测仅 32 个不透明像素、RGB 均 rgb(40,25,25)，床走 opaque 通道 alpha 不参与混合
  → 床侧面渲成一块深色而非床侧纹理。**对齐上游时必须实测其运行时行为，不能读定义推断**
  （与「诊断 bug 不猜」同一原则）。
- **模板不做面剔除**（mc-lite 实例级渲染同口径）；光照读自身格；AO 按顶点推导（子格取最近格角）。

**朝向渲染消费（M2 bug 修复阶段提前落地）**：
- meta 低 2 位 = orientation 0-3（mc-lite OrientationUtils 语义：yaw = orientation × 90°，
  俯视为逆时针；EAST=0/SOUTH=1/WEST=2/NORTH=3）。渲染侧**无条件消费**（meta&3 非零即旋转，
  与 mc-lite ChunkConsolidation.js:530 逐实例应用 b.orientation 一致——结构 JSON 会给
  bed/planks 等 orientationEnabled=false 的方块写非零 direction）；`orientationModes`
  只管放置交互（见下「朝向放置交互」），不参与渲染门控。
- mesher 按「模型面迭代」实现：tile/床 UV 变换查**模型面**（贴图随方块转）；顶点绕块中心
  (0.5,0.5,0.5) 按 yaw 旋转（o=1: (dx,dy,dz)→(dz,dy,-dx)；o=2/3 类推）；面剔除/光照/AO/
  packed face 位用**世界面**（模型面经同一旋转映射，双射）。BoxGeometry UV 约定旋转自洽，
  侧面无需额外 UV 变换，顶底面随顶点旋转自动正确。绕线在旋转下保持，FrontSide 语义不变。
- 数据流：`getSectionView` 增打 meta（Uint8Array 18³）；MESH 任务随 data/light transfer；
  主线程快速路径与 Worker 精修同构消费。orientation=0（绝大多数）走零开销原路径。
- 结构 JSON 的 direction 经 structure-json.js 写入 meta（既有），本机制是其首个渲染消费者。

**朝向放置交互（M3.2，v1.17 定稿）**：渲染消费侧 M2 已通，本节补齐玩家放置/挖掘侧的朝向语义，
照搬 mc-lite `PlayerInteraction.js:413 getPlacementOrientation` + `OrientationUtils.js`。

- **门控字段复用**：mc-lite 用 `orientationEnabled`（`BlockData.js` 默认 true），M0 转换后
  在 mc-heavy 名为 `orientationModes`。**启用集合两侧零差异（各 40 项）**，故直接复用
  `registry.orientationModesTable[id]`（>0 即启用朝向），不新增字段、不改 blocks-data。
  （**v1.18 勘误**：本句原写「完全一致（40 项 true，84 项 false，零差异）」——true 集合确实零差异，
  但 false 计数两侧不同：mc-lite 124 方块中 84 项不参与旋转，mc-heavy 126 方块中 **86** 项。
  差额是 M2-7 新增的 `sky_stone`/`sky_grass`（门控均为 0），mc-lite 无此二方块。原文沿用了
  mc-lite 的 84 未换算，实施时实测校正。）
- **放置朝向三分支**（`src/player/orientation.js` 纯函数，无 DOM/three）：
  ```
  getPlacementOrientation(x, y, z, id, orientationModesTable, lastRemovedBlock, memory):
    ① orientationModes[id] === 0           → 0（86 个方块恒 EAST，不参与旋转）
    ② lastRemovedBlock 且 x/y/z/id 全等     → nextOrientation(lastRemovedBlock.orientation)，并 memory.set(id, 该值)
    ③ memory.has(id)                        → memory.get(id)（沿用该类型的上次朝向）
    ④ 否则                                  → 0（EAST）
  nextOrientation(o) = (o + 1) % 4          // 顺时针 90°
  ```
  **关键语义**：放置朝向**不看玩家 yaw**（mc-lite 签名 `getPlacementOrientation(x,y,z,type)` 无朝向参数）。
  转身不改朝向；玩家要转 90° 的手感是「原位挖掉再放回去」——这正是分支 ②。
  （**v1.18 补记**：mc-lite 用方块 name 作身份键，mc-heavy 世界权威是数字 id，故上述签名与记忆键
  统一改用 `id`（`registry.idOf(name)` 已在 `placeBlock()` 内取到，无需再转换）。语义与 mc-lite
  「按方块类型记忆」一致——id 与 name 一一对应，等价。）
- **Player 两个交互状态**（对齐 mc-lite `Player.js:164,168`）：
  - `lastRemovedBlock = {x,y,z,id,orientation}`：`digBlock()` 挖前读 `world.getBlockMeta()` 记下；
    `placeBlock()` 成功后清空；
  - `placementOrientationMemory = Map<id, orientation>`：按**方块类型**记忆，跨位置、本次会话内持久。
  二者都是 UI 交互态，**不入世界数据、不持久化**（世界权威只有 meta 通道；player 记录归第二阶段，v1.15 ②）。
- **读接口补记**：`world.getBlockMeta(x,y,z)`（越界/缺列返回 0）——挖块存记忆需读旧朝向。
  该方法 M4 plan Task 2 亦计划新增，M3.2 提前交付（见 M4 plan 注意事项）。
- **持久化免费**：`chunk-column.set()` 的 `edits.set(idx,{id,meta})` 早已带 meta，带朝向方块存档/重载
  自动正确，无 schema 变更。
- **明确不照搬 mc-lite 的部分**（各撞已定决策或属他 Epic）：
  ① `inventory.remove(type,1)` 放置消耗——M3.1 定稿创造模式无限背包不消耗；
  ② `audioManager.playSound('put')`——第一阶段无音频消费方（M4 Task 4 才有 AudioManager）；
  ③ `tryPlaceBed()` 床的多方块放置（按玩家位置算床尾）——属床/宝箱/门 Epic，且 bed_head/bed_tail
     在 mc-lite 本就 orientationEnabled=false，不走本节三分支。
- **对 M4 的影响**：M4 Task 6 将 `digBlock()`/`placeBlock()` 改走 `editor.setBlock(...)`
  （`WorldEditor.setBlock` 已支持 meta 参数，M4 plan:332），重写时须保留本节朝向分支；
  非依赖关系，M4 spec 全程不含方块朝向（已核实 M5/M6/M7 spec 亦不含）。

### 4.4 渲染管线（src/render/）

**4.4.1 纹理图集**
- 启动时把 mc-lite 现有散纹理（src/assets/textures/*.png，122 张：113 张 16×16 +
  2 张 32×32 + 7 张 250~362px 特殊几何/实体贴图按 128×128 入图）
  打包进一张 2048×2048 atlas（离线脚本生成 atlas.json：tile 名 → UV 矩形；运行时也保留 Canvas 合成 fallback）。
- **程序化贴图烘焙（M2 对齐 mc-lite）**：mc-lite MaterialManager 约 21 种材质是运行时
  canvas 程序化绘制（mkMat/mkProceduralMat/mkDetailMat，无 PNG）。`tools/bake-procedural-textures.mjs`
  逐行复刻其绘制参数离线烘焙到 `assets/textures/procedural/`（vine/flower/lilypad/cactus/marble/
  handrail/pillar/chimney/hanging_lamp/cloud/playground 等），随机源固定种子（确定性红线）。
  atlas 合计 147 tile（126 方块 + 23 程序化，M2-7 空岛 sky_stone/sky_grass +2）。
  **v1.26 起背包图标独立于本 atlas**（`assets/icons-atlas.png`，§4.5.4），二者不再互相影响。
  **权威计数以 `npm run check:data` 输出为准**（关系型断言，新增贴图自动跟上，勿在文档/spec 硬编码）。
  faces-data.js 全量 126 方块六面映射对齐 MaterialManager。
- **atlas 渗色防护**：2048 atlas + mipmap 会跨 tile 渗色。tile 之间留 16px gutter，打包时每 tile
  边缘像素向外 bleed 8px 回填（build-atlas.mjs），UV 内缩半 texel；默认 blur=0 时用 NearestFilter +
  关闭 mipmap（mc-lite 默认即像素风），模糊档位（`?blur=1`，M3-4 设置面板接线）开启时才启用
  三线性 mipmap + anisotropy 8（此时 gutter/bleed 生效，覆盖接缝导数尖峰的 mip 足迹）；
  匀质 tile（cloud）UV 收缩到 tile 中央 1/4，使 wrap 尖峰足迹永不跨 tile。
- 全部不透明方块 = 1 个材质。cutout 用 alphaTest 同 atlas 第二材质（FrontSide + alphaTest 0.3，
  mc-lite 树叶族口径；双面需求由 mesher 双向绕线解决，见 §4.3）；
  玻璃/水单独透明材质。
- **transparent 通道排序策略（必须显式定义）**：
  - **默认 BatchedMesh 路径**：`BatchedMesh.sortObjects` 默认 `true`，内置**逐 section
    运行时距离排序**（源码核验 BatchedMesh.js:221/1578），比静态排序更强——粒度更细、
    随相机自适应。直接用内置能力，无需自实现。
  - **fallback 候选 A 路径**：three.js 只做 object 级排序，不排一个缓冲内部的面。
    此时 meshing 把 transparent 通道的面按「到 column 中心距离」做静态排序（零运行时成本），
    column 间交界处的少量混合次序 artifact 接受（Minecraft 通行口径）。
  - 两条路径都不做逐**面**运行时排序（成本不可接受）。
- mc-lite 的纹理模糊档位（NearestFilter ↔ mipmap）在 atlas 级别保留实现。

**4.4.2 渲染发布粒度：section 重建、合批发布（BatchedMesh 默认 + 可插拔发布层）**

**决策**：section 继续作为重建与脏标记的最小粒度（快速路径 <2ms 不变），
但**发布层合批**。发布层做成可插拔接口（`PublishStrategy`），M1 用微基准做最终确认，
但默认实现已由 r185.1 源码核验定型为 **BatchedMesh**（v1.3 反转 v1.2 的默认值）。

**默认实现：BatchedMesh 通道级合批（v1.3 源码核验后升级）**

- **draw 提交模型（v1.6 纠正 v1.3 的核心错误）**：r185.1 的 **WebGPU 后端对 BatchedMesh
  不走 multi-draw**——`WebGPUBackend.js:1806-1824`（已核验）对 `isBatchedMesh` 是 JS 循环，
  每个可见 instance 各发一次 `passEncoderGPU.drawIndexed(counts[i], 1, starts[i]/bytesPerElement, 0, i)`。
  `_indirectTexture` 的真实用途是着色器侧按 instance 读矩阵（batch() 节点），不是 draw 提交；
  单次 `renderMultiDraw` 只存在于 WebGL 后端（WebGLRenderer.js:1321，依赖 `WEBGL_multi_draw`
  扩展），我们是 WebGPU 唯一后端，享受不到。
- **因此「3 个 BatchedMesh ≈ 3~9 次 GPU draw」不成立（v1.6 删除该口径）**。真实情况：
  3 个 render item、每通道 1 个 pipeline，但 **GPU 命令数 = 可见 section 数**（视距 8
  预计数百次，具体看视锥与地形）。选型理由相应改写（见 DR-11）：BatchedMesh 与候选 A
  的 draw 数量**同量级**，但 BatchedMesh 循环内所有 drawIndexed **共享同一 pipeline、
  同一 bind group、同一顶点缓冲，命令间零状态切换**；空 section 无 instance、零命令；
  per-instance 视锥剔除与透明逐 section 排序官方内置。
- **构造函数只接受单个 Material（v1.6 纠正）**：BatchedMesh 从不创建 geometry groups
  （全文件无 addGroup/groups 赋值，已核验），传 material 数组会在 `_projectObject` 里
  遍历空 groups → **一个 render item 都不产生**。多通道只能靠「每通道一个 BatchedMesh」，
  不存在"一个 BatchedMesh 挂多材质"的用法。
- **两层结构（geometry + instance，v1.5 源码核验补齐，必须写死）**：`BatchedMesh` 是
  geometry slot + instance 两层。`addGeometry()` 只注册 geometry slot，**不会渲染**；
  必须再 `addInstance(geometryId)` 创建 instance 并 `setMatrixAt(instanceId, matrix)`
  定位后才进入渲染（源码示例 BatchedMesh.js:164-175 明确）。本设计每个 section 恰好
  一个 geometry + 一个 instance（1:1），instance 矩阵 = section 世界偏移的平移矩阵。
  首次实现若漏掉 instance 层会"加了 geometry 但画面什么都没有"。
- 布局：**每通道一个 BatchedMesh**（opaque/cutout/transparent 各一），每个 section 占一个
  geometry slot + 一个 instance。视距 8 全场景 = **3 个 render item**，GPU drawIndexed
  命令数 = 可见非空 section 数（数百量级，命令间零状态切换）。
- **构造容量预估（v1.6 纠正过度预留）**：`new BatchedMesh(maxInstanceCount, maxVertexCount,
  maxIndexCount, material)`。
  - `maxInstanceCount`：视距 8 = 289 column × 8 section = 2312 slot/通道，取 2312 × 1.2
    （instance 元数据是矩阵纹理，便宜）。
  - `maxVertexCount`/`maxIndexCount`：**按"预期活跃非空 section 数/通道 × 平均 section
    顶点数 × 1.25"预估，不是按全部 2312 slot**（v1.5 公式会数倍过度预留显存：按 P95 8k
    顶点算，2312×8000×1.25×24B ≈ 555MB/通道，与 §4.10 的 ~100MB 总口径矛盾）。
    视距 8 典型活跃非空 section：opaque ~800、cutout ~300、transparent ~100；
    opaque 通道约 800×4000×1.25×24B ≈ 96MB，与 §4.10 吻合。
  - 运行时用 `unusedVertexCount`/`unusedIndexCount` getter（BatchedMesh.js:316/328，已核验）
    监控余量；满了走 `setGeometrySize` 整批扩容重建兜底（低频）。
- 视锥剔除：`perObjectFrustumCulled = true`（默认值，per-instance 包围盒剔除，r185.1 内置），
  剔除粒度 = section（16³ AABB），比 column 级更细。
- 增量替换：`setGeometryAt(geometryId, geom)` 原地替换 slot 内容（**超出预留会 throw**，
  见下方溢出处理）；`setVisibleAt(instanceId, visible)` 控制可见性（卸载/LOD 切换）。

**fallback：column 级 3-group 合批（候选 A，仅当 BatchedMesh 实测不达标时启用）**

- 每 column 一个 Mesh，缓冲区 **channel-major 布局**：opaque/cutout/transparent 各一段，
  **恰好 3 个 geometry group**（section 在各通道内是连续子区间）。
- **draw call 陷阱（3-group 语义必须写死）**：three.js `Renderer._projectObject`
  （r185.1 Renderer.js:3149-3158，已核验）在 material 为数组时**每个 group 各 push 一个
  renderList 条目**，即每 group 一次 draw。若按 8 section × 3 通道切成 24 个 group，
  每 column 是 24 次 draw（289 × 24 ≈ 7000 次），比每 section 一个 Mesh 还差。
  只有 channel-major 3-group 才能拿到每 column ≤3 draw（视距 8 上限 289×3≈867，
  **固定 ~867**——`_projectObject` 不看 group.count，空通道也照样入 render list，
  v1.5 写的「实际 300~500」低估了，v1.6 纠正为固定 867 上限）。
- 注意：three.js 对透明 object 排序、不透明按深度排序，column 级 object 数 289 本身不是
  问题，问题只在 group draw 数——实现时不要误判。

**M1 决策门（确认而非选型）**：默认 BatchedMesh；仅当实测出现以下情况才退回候选 A——
① BatchedMesh 的逐 instance JS 循环 draw 提交在目标硬件 p95 反而比候选 A 的固定
   867 条 group draw 更差；
② `setGeometryAt` 增量替换有正确性坑（版本/可见性竞态）；
③ `onBeforeRender` 的逐 instance 剔除/排序 CPU 循环（~2312 instance，sortObjects 默认
   true 不透明通道也每帧排序）吃掉 120fps 帧预算。
对比口径不变：120fps 基线下放挖压力场景的 p95 帧时。
**选型理由（v1.6 重写）**：BatchedMesh 与候选 A 的 draw 数量同量级（数百 vs 固定 867），
但 BatchedMesh 循环内所有 drawIndexed 共享同一 pipeline/bind group/顶点缓冲、命令间零
状态切换，空 section 零命令，剔除/排序/增量更新官方内置——综合单命令成本与工程复杂度占优。

**变长 section 的打包策略（优先用官方 API，不再手工造轮子）**：

单块编辑重建后该 section 顶点数会变。v1.2 手工设计的「slot 预留 + offset 表 + repack」
恰好就是 BatchedMesh 官方 API 的语义，直接用官方实现：

- **预留**：`addGeometry(geom, reservedVertexCount = 实际顶点数 × 1.25, reservedIndexCount 同理)`。
- **增量写回**：重建后若未溢出预留区间，`setGeometryAt(geometryId, newGeom)` 原地替换
  （内部走 `addUpdateRange` 增量上传）。**注意**：`setGeometryAt` 在新 geometry 超出
  该 slot 预留区间时**直接 throw**（"Reserved space not large enough"，源码核验），
  故调用前必须先比对顶点/索引数与 reserved。
- **溢出处理（v1.5 纠正 setGeometrySize 语义错误）**：单 slot 溢出**不能**用
  `setGeometrySize`——它是**整批缓冲重建/收缩**，且当现有用量超过目标容量时直接 throw，
  不是单 slot 扩容。正确的单 slot 溢出路径（源码核验 BatchedMesh.js:825 deleteGeometry
  会级联删除关联 instance）：
  1. `deleteGeometry(geometryId)`（自动级联删该 section 的 instance）；
  2. `addGeometry(newGeom, reservedVertexCount = 新顶点数 × 1.25)` 拿新 slot；
  3. `addInstance(newGeometryId)` + `setMatrixAt` 重建 instance。
  单块编辑极少连续溢出，此路径摊销成本可忽略。整批容量不足（addGeometry throw）时才
  重建整个 BatchedMesh（低频）。所有重建结果携带 column.version，回传时版本校验，
  原子切换，无视觉空洞。
- 候选 A（若启用）保留 v1.2 的手工 offset 表 + 整列 Worker repack 方案作为对照实现。

**其他约束**：

- **纠正一个前提**："WebGPU 每 draw 的 CPU 成本远低于 WebGL"不成立——three.js 的
  WebGPURenderer 在 pipeline/bind group 哈希与 render list 排序上的每 draw CPU 开销
  通常不低于 WebGL。draw call 数量必须作为一级约束控制，不能指望后端红利。
- **历史参照的适用边界**：本仓库上一版 TS 实现（a7feb44^，已清空）验证过 120fps，
  但它当时只流式加载约 3 个垂直 section；新设计是 8 个 section，工作量约 2.67 倍，
  其结论只能作为量级参照，M1 必须重新跑基线确认。
- `RenderSectionPool`（缓冲/geometry 复用）只省 CPU 分配与 GC，**不省显存**；
  显存控制靠滞回卸载 + 重入 LRU（§4.9/§4.10）。

**4.4.3 天空/雾/日夜**（v1.58 实测口径，2026-10-20：**体素方向光 + 天空盒** 落地；
v1.75 新增第四种风格「傍晚」与**色温**）

- 四套视觉风格（morning / noon / **dusk** / night）：既有三套移植 mc-lite `Engine.js` 的
  `visualStyles` 参数（`skyDim` / `blockBoost` / `sunDirection` / 雾色与雾距系数），**dusk 是
  v1.75 新增的纯手动风格**（由 mc-lite `skyBox2` 贴图反推标定，没有上游参数）；`paramsAtHour()`
  按关键帧线性插值。
- **「傍晚」不参与自动日夜循环**：`KEYFRAMES` 只引用 morning/noon/night → 循环里
  `duskBlend ≡ 0`、色温恒中性。这是本项最重要的不变式（单测逐时刻钉死）。
- **天空是三张立方图三层混合**（v1.75）：
  `mix(mix(day, night, uNightBlend), dusk, uDuskBlend)`。`uDuskBlend=0` 时内层就是 v1.58 的
  原表达式 → 其余风格**逐位不变**。⚠️ 嵌套顺序是载荷性的，别改成别的等价写法。
- **色温（v1.75）**：v1.70 之前太阳项是**纯标量**，色相信息进不到着色器 —— 「暖橙直射 +
  冷蓝紫环境」在架构上不可表达。现在：
  ```
  full_c    = SUN_AMBIENT × ambientColor_c + SUN_INTENSITY × N·L × shadowKill × sunColor_c
  sunTerm_c = mix(1, full_c, uSunStrength)
  ```
  `sunColor` / `ambientColor` 是**均值 ≈1 的相对乘数**（只改色相不改曝光），三种既有风格
  全是 `[1,1,1]` → 中性时公式**逐位等于** v1.70 的标量版。唯一权威 = `sun-shade.js` 的
  `sunTermRGBFor`（`sunTermFor` 是它在中性白下的 R 通道，不留第二份公式）。
  ⚠️ **环境项吃环境色、直射项吃直射色** —— 两者都用直射色的话阴影里也会变暖，就没了「暖光冷影」。
  ⚠️ 判「暖/冷」必须用**屏幕口径**（`sun-shade.js` 导出 `srgbEncode` / `acesFilmic` 供单测复用）：
  线性比值与屏幕观感差一个数量级（同 `shadow.radius` 的既有教训）。
- **dusk 的标定值**（sRGB + ACES 口径，受控石墙考证实测）：`skyDim 0.78` / `toneMappingExposure 1.20` /
  `sunColor [1.50, 1.02, 0.58]` / `ambientColor [0.86, 0.93, 1.20]` / `sunDirection` = azim +44° /
  elev 12° → 迎光面屏幕 R−B **+24.3**、背光面 **−13.4**、整屏亮度为正午的 **0.786**、为夜的 **2.354**。
  ⚠️ **太阳仰角 12° 是用户裁定的有意偏离**（贴图实测 5.5°）：5.5° 时地面只剩一半亮度、8 格树投
  83 格影，赶路时偏暗；12° 保留很长的影子但地面可辨认，**方位角不动**（地平线那轮暖日仍在原处）。
- **`nightBlend` 可由风格数据显式指定**（v1.75）：`nightBlendOf` 原本从 `skyDim` 派生，dusk 的
  0.78 会倒算出 **0.293** → 傍晚天空混进 30% 星空（实测暖度被拉成 R−B=−14）。dusk 显式写
  `nightBlend: 0`；**缺省仍走派生**（其余三风格逐位不变）。
- **雾距与视距联动**（mc-lite 硬编码 `FOG_NEAR=30` / `FAR=70`，本仓按 `renderDistance × 16` 推导）。
- **太阳方向光（N·L）—— 本仓的核心光影层次**：
  根因：体素材质是 unlit，顶点 shade 只有 `max(skylight, blocklight) × ao`；户外 skylight 恒 15
  （DR-14）→ **一个方块六面亮度完全相同**，不存在任何朝向差异。三种风格只改 `skyDim` 这类
  **全局乘数**，怎么调都不会出现「迎光面亮、背光面暗」。而 `mesher` 早已把世界面索引写进
  packed bit10-12（§4.3），此前**零消费点** —— 通道是通的，缺的只是着色器里那一步。

  公式（`materials.js`，标定常数与 CPU 参考实现的唯一权威 = `sun-shade.js`）：
  ```
  sunDot     = max(dot(faceNormal, uSunDirection), 0)          // 顶点阶段，float varying
  shadowKill = clamp((shadowFactor − SHADOW_FLOOR)/(1 − SHADOW_FLOOR), 0, 1)
  sunTerm    = mix(1, SUN_AMBIENT + SUN_INTENSITY × sunDot × shadowKill, uSunStrength)
  shade      = max(vSkyShade × sunTerm, vBlockShade)
  ```
  标定（**两个常数都是推导值，不是拍脑袋**）：`SUN_AMBIENT ≡ SHADOW_FLOOR = 0.5`（同一语义：
  太阳被拿走后剩下的环境光）；`SUN_INTENSITY = (1 − SUN_AMBIENT) / noonSunY = 0.5/0.8 = 0.625`
  —— 这是让 **`SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0`** 成立的唯一取值，即
  **正午顶面亮度恒等于改动前的 1.0**（零回归不变式；实测 `uSunStrength` 0↔1 时顶面像素
  138.9 → 138.9）。落地：顶面 1.000 / +Z 0.875 / ±X 0.725 / −Z、−X 0.500。

  ⚠️ **`sunDot` 必须在顶点阶段算**（同 AO/light 的道理）：片元读 packed 会被
  `three.webgpu.js:65404` 对 int 类型强制 `flat` 插值 → 色块。面法线六选一走 `select` 链
  （GLSL 无便携的动态常量数组索引；结果逐顶点常量，编译期可折叠）。
  ⚠️ **阴影只乘在太阳项上，不得再乘 `vSkyShade`**：两边各乘一遍会让正午顶面在影区变成
  `0.5 + 0.625×0.8×0.5 = 0.75`（应为 0.5）→ 阴影变淡 50%，`sun-shadow.spec` 的冻结比值 0.735 崩。
  改后实测 **ratioA 仍为 0.735，与改动前逐位相同**（被测点是顶面：受光 1.0 / 影区 0.5）。
  ⚠️ **`sunTerm` 只能乘 skylight，不得乘 blocklight**（火把在洞穴里照样亮，与阴影同一道理）。
  ⚠️ **transparent 通道不接太阳**（海面已有自己的 Blinn-Phong 高光，见 §4.7）。
  ⚠️ **fixture 路径（`createVoxelMaterials(tex)` 不传 sunLight）不得崩**：`shadowKill` 退化为 1。

  **Tier 4 阈值口径**：像素比值是 **sRGB 口径，不是线性口径**。线性 shade 比值 0.875/0.500 =
  1.750，但过 sRGB 传递函数后是 0.9429/0.7354 = **1.282**；再算上贴图基色（不同基色的 sRGB
  曲线非线性不同），理论值域 **1.286（亮贴图）~1.347（暗贴图）**，实测 1.313（stone 基色
  ≈0.1 线性）。断言区间取 [1.20, 1.45]，围绕理论值域而非实测值。
  （同类坑见 `test-view-bob.js` 的「屏幕读数须按 sRGB 断」。）

- **天空盒（v1.58）**：两套立方图 —— 白天云层（mc-lite `skyBox4`，912K，原样复制未重编码）
  与夜空星空（`skyBox1` 六面**在方向空间加权重采样重烘焙**，v1.60，见 §4.4.3 与修订说明 ——
  原图六面各自独立生成、12 条边平均 RMS 落差 41.09 会看出盒子感）；清单唯一权威 =
  `src/render/sky-config.js`（node 可 import，供 `check:data` 的 `[天空盒]` 环节断言 12 张齐全）。
  ⚠️ `skyBox2`（日落）**不搬** —— mc-lite 自身零引用。
  **夜空的无缝烘焙（v1.60）**：`tools/bake-night-sky.mjs` 从 `assets/sky/night-src/`
  （mc-lite 原图，逐字节一致）出发，按立方体方向 `dir` 对**六个源面**各自反算 uv 并双线性采样，
  再按「离本面中心多近」加权平均 → 边界两侧取的是同一条射线、同一组权重，接缝精确为零。
  烘焙参数唯一权威 = `tools/night-sky-fingerprint.mjs`；`check:data` 的 `[夜空]` 环节比对指纹。
  ⚠️ 该文件里的 `blendPad` / `blendPower` 是**实玩观感标定值**：改大 → 过渡更宽但细节更柔。
  装配：`scene.backgroundNode = mix(cubeTexture(day), cubeTexture(night), uNightBlend)`。
  ⚠️ **`cubeTexture(tex)` 不传 uvNode** —— 让 three 从上下文注入
  `backgroundRotation.mul(normalWorldGeometry)`（`three.webgpu.js:48924-48928` →
  `CubeTextureNode.setupUV` 走 `builder.context.getUV`）。自己传方向会绕开它的 x 轴取反约定
  → **天空左右镜像**（肉眼很难察觉）。
  **实测核验（严格等价对照）**：自定义 `backgroundNode` 路径与 three 默认的
  `scene.background = cubeTexture` 路径**逐像素相同**（480×360 全图 diff = **0 / 172800**）
  → 采样朝向已被正确复用，不存在镜像。
  **混合因子从既有 `skyDim` 派生，不新增权威**：`nightBlendOf()` =
  `clamp((1 − skyDim)/(1 − nightSkyDim), 0, 1)` → 正午 0 / 晨 0.267 / 黄昏（19h）0.274 / 夜 1，
  随关键帧插值**连续变化**（无硬切换跳帧）。写入点是 `DayNight._apply`（与 `uSkyDim` 同一处），
  故 `setStyle` 与日夜循环两条路径口径一致。
  ⚠️ **有意偏离 mc-lite ①**：不做 `backgroundBlurriness`（夜 0.28）。它会让 three 走
  `pmremTexture` 路径（`:55805` 判 `> 0`），需预滤波立方图 render target，与手工
  `backgroundNode` 冲突；且那本是 mc-lite **离散切风格**的补偿值，交叉淡入下星空该是清晰的。
  ⚠️ **有意偏离 mc-lite ②**：天空随连续日夜插值，而非点风格按钮时硬切换（与本仓日夜模型一致，
  同 v1.44 的太阳方向）。
  **日轮/月轮**：canvas 径向渐变生成（同 `Engine.js:429-495` 的绘制参数），位置 =
  `相机位置 + 方向 × (camera.far × 0.55)`、尺寸同比缩放（`size × dist/150`）——
  mc-lite 固定 150 单位 + 固定尺寸，照抄会在小视距下把 sprite 推出远裁面（月亮消失）。
  ⚠️ 三套风格的 `sunVisible` 原值**全是 false**：`skyBox4` 贴图自带太阳光晕，再画一个会变成
  两个太阳（mc-lite 同口径）。改一个字段即可打开。
  ⚠️ 位置刷新只在**既有重定位节奏**（移动 >5 格 / 太阳方向过 0.5° 门控），不得每帧调。
  **降级**：加载失败 → `console.warn` + 退回纯色（不阻断启动，同丧尸头部/炮塔装甲纹理口径）；
  `?skybox=0` → 完全不加载、退回纯色（观测口径与 v1.57 逐位相同）。

- **不移植**（用户明确否决）：ACES tone mapping / 每风格 `toneMappingExposure` /
  canvas CSS 饱和度·对比度·亮度分级。

> ⚠️ **照片天空会让「纯色天空」判据失效**：`render-terrain` / `city-visual` /
> `sky-structures` 用「像素落在 `0x87ceeb ±30` 内 = 天空」来数地形占比。天空盒上线后实测
> **天空区 99.4% 的像素**被误判成地形（`city` nonSkyRatio 0.881 → 0.938），下界断言
> `> 0.05` 近乎恒真。故四条 spec（含 `m3-rain` 的白雨滴压在白云上）pin `?skybox=0`，
> **断言与阈值逐字不动**。同理 `test-sky-tree.html` 的绝对叶色判据（`ratioA`）在方向光下
> 从 1.000 跌到 **0** → 该 fixture 内设 `uSunStrength = 0`（它测的是通道语义，不是光照）。

**4.4.4 阴影**（v1.47 实测口径，2026-10-13 落地 / 2026-10-14 混合模型修正 / 2026-10-17 纹素对齐 + 方向门控。原规划期估算「贴图 2048 / shadow camera 覆盖半径 =
视距的 60% / 投射接收由 BlockRegistry 属性驱动白名单」三项**全部作废**，理由见 v1.44 修订说明）

- **太阳灯 = 复用给枪 PBR 用的那盏 `DirectionalLight`**（`game.js` 的 `sunLight`，原 `weaponSun`），
  不新建第二盏（新建会让枪模型被双倍照亮）。阴影相机正交 `±96` / `near 0.1` / `far 300` /
  `mapSize 1024`（**v3.39 口径**；mc-lite 原值是 ±30 / far 250 / mapSize 256，
  v1.70 先扩到 ±48，v3.39 再扩到 ±96 —— 两次扩大的实测依据见上方修订说明）。
  跟随玩家：`position = player + sunDirection × 60`、
  `target = player`（mc-lite `Game.js:556-558`），移动超 5 格（`distSq > 25`，mc-lite `Game.js:537`）
  才重定位。
  ⚠️ **v1.47 纹素对齐（texel snapping，有意偏离 mc-lite）**：上述 `position`/`target` 都再叠加一个
  世界空间偏移 `texelSnapOffset(player, sunDir, texelSize)`（`shadow-manager.js` 纯函数），把阴影相机
  中心吸附到贴图像素边界。根因：相机 ±30 / 贴图 256² → 每纹素 ≈ 0.234 格，相机连续跟随玩家时
  世界点相对纹素网格错位分数纹素 → 影子边缘随移动抖动（shimmer，用户实玩可察觉）。
  **载荷性**：偏移必须**同时**加到 position 与 target —— 两者之差平行于相机 Z 轴，加同一向量
  方向严格不变；只加一侧会改「position − target」→ 枪 PBR 高光漂移。`texelSize` 从
  `(camera.right − camera.left) / mapSize.width` 读（红线 1：不写字面量）。mc-lite 无连续日夜循环
  且光源只在移动超 5 格时重定位 → 无此抖动，故无此机制。
  ⚠️ **v1.47 太阳方向角度阈值门控（有意偏离 mc-lite）**：日夜循环下 `DayNight.update()` 每帧
  `_apply` → `onSunDirection` 每帧触发，而太阳每帧只转 0.0025°（256² 贴图上不可见）→ 门控前每帧
  重定位 120 次/秒。`onSunDirection` 加 `sunDirectionChanged(lastDir, dir, SUN_DIR_GATE_DEG=0.5°)`
  门控 → 约 0.6Hz（太阳 0.3°/秒）。附带消除重定位路径上的额外 `params` 读取（`get params()`
  每次调用新分配 2 个小对象；门控比较用回调入参 `dir` 而非 `params`，零额外分配）。
  ⚠️ **门控只加在 `onSunDirection` 这条路径，不得加到帧循环的移动阈值路径**（玩家移动必须让
  阴影相机跟上，加了会「走 5 格后影子钉在原地」）。mc-lite 无连续日夜循环 → 无此门控需求。
- **档位 = `VSMShadowMap`，不是 mc-lite 的 `PCFSoftShadowMap`** —— three.js r185.1 WebGPU 后端的
  depth-compare 阴影路径（Basic/PCF/PCFSoft）有 `GPUValidationError` bug，最小独立场景同样复现
  （v1.44 修订说明 ①）。VSM 不吃 `bias`/`normalBias`，软化参数是 **`radius 2.6`（mc-lite 原值）+
  `blurSamples 8`**。⚠️ 升级 three 前须重测该 bug 是否已修。
  ⚠️ **radius 曾误用 4**（v1.45 修回 2.6）：4 是「阴影乘在最终颜色上（影区纯黑）」时代的补偿值 ——
  那时须把阴影糊开才不致于全黑；改成「只衰减 skylight 项 + 地板」后 radius=4 反而把阴影冲淡
  （实测谷底比值 0.852 vs r=2.6 的 0.726，而半影宽度两者同为 4/8 点）。**0.726 与 mc-lite 的理论
  影区亮度 0.71 几乎重合**（ambient 2.3/(2.3+sun 3.2×NdotL 0.8)=0.4733 线性 → sRGB 0.71）。
- **投射是「通道级 + 逐方块排除」两层**（v1.45 修订，原 DR-2 的「纯通道级」已作废）：
  `opaque` + `cutout` 通道 `castShadow = true`，`transparent`（水/玻璃）**cast + receive 双 false**。
  ⚠️ **transparent 必须 receive 也为 false**：VSM 下阴影 pass 判据是 `castShadow ||
  (receiveShadow && VSM)`（`three.webgpu.js:44682`）→ receive=true 会把水/玻璃几何渲进阴影深度图
  （**照样投影**）；且材质的 `shadow()` 节点**不受 `receiveShadow` 门控**（该标志只门控 three 的
  灯光管线，`three.webgpu.js:46101`）→ 水面照样被压暗。mc-lite 对 water/glass 也是双 false
  （`GlobalInstancedMeshManager.js:76-84`）。
  **逐方块排除走 `maskShadowNode`**（不是原 DR-2 预估的 `castShadowNode`）：声明侧
  `blocks-data.js` 的 `shadowCast:false` → `registry.shadowCastTable` → mesher 写 **packed bit14** →
  `materials.js` 的 `mat.maskShadowNode = noShadowCastBit.equal(0)` 在**阴影 pass** 逐片元 discard。
  ⚠️ `maskShadowNode` 只被阴影 pass 消费（`_getShadowNodes`，`three.webgpu.js:62528/62573`），
  主 pass 的 `setupDiffuseColor` 只读 `maskNode` → **这些方块在主渲染里照常显示，只是不写阴影深度**。
  ⚠️ `castShadowNode` 不适用：它要求 `shadowMap.transmitted === true`（`:62546` 警告），
  而 `maskShadowNode` 无此要求。
  排除清单 = mc-lite `BlockData.isShadowEnabled:false` 的 20 项中**落在 opaque/cutout 通道的 13 项**
  （cloud / 7 种花草菇 / vine / lilypad / 创造台两项 / hanging_lamp）；其余 7 项在 mc-heavy 走
  cullMode 'none'/'transparent' 或不是方块 → 通道级已排除。**cloud 是必须项**（Y=35/55 在阴影相机
  far=250 视锥内 → 地面出现大面积移动云影黑斑；实测修复后 cloud 柱投影比值恒 1.000）。
- **接收靠 TSL 节点手动相乘，且阴影只衰减 skylight 项**（v1.45 修订 —— 这是「阴影黑乎乎一片」的根因修复）：
  体素材质是 unlit `MeshBasicNodeMaterial`（不吃灯光），故在 colorNode 里手动乘阴影因子。
  **混合模型必须对齐 mc-lite**：mc-lite 的体素材质是受光的 `MeshStandardNodeMaterial`
  （`MaterialManager.js:268`），three 的阴影**只乘在方向光贡献上**，而 `AmbientLight(0xddeeff, 2.3)`
  （`Engine.js:194`）**不参与阴影** → 影区仍被环境光完整照亮，观感是「暗一档」而非全黑。
  mc-heavy 的 unlit 管线里 `vShade` 烘焙的 skylight 就是它唯一的「环境光」，**把阴影因子乘在最终
  颜色上等于把这份环境光也乘没了**（影区 ×0 → 纯黑）。故：
  - **sky / block 两项分开传片元**（`vSkyShade` / `vBlockShade`；`max(sky,block)×ao ≡
    max(sky×ao, block×ao)`，ao≥0 → 拆分无损），片元只把阴影因子乘进 sky 项再取 max
    → **火把照亮的洞穴/室内不会被太阳阴影压暗**（mc-lite 无 blocklight 故无此问题，但语义上
    太阳阴影本就不该影响点光源照明）；
  - **影区地板 `SHADOW_FLOOR = 0.5`**（`materials.js` 导出常量）：由 mc-lite 的影区亮度推导
    （ambient/(ambient+sun·NdotL) = 2.3/(2.3+3.2×0.8) = **0.4733** 顶面 ~ 0.55 侧面，取 0.5）。
  - **两层 mix 的嵌套顺序是载荷性的**：`mix(1, mix(FLOOR, 1, shadow()), strength)` —— 内层给地板、
    外层调浓度。⚠️ 写成单层 `mix(FLOOR, 1, shadow() × strength)` 是错的：strength=0 时 mix 取左端
    = FLOOR → **关掉阴影反而把全世界压到 50% 亮度**，「关阴影 = 零视觉影响」的不变式静默失效。
  - 自发光加项（packed bit13 吊灯）在阴影相乘**之后**（灯在影里照样亮）。
  `createVoxelMaterials(atlasTexture, sunLight = null)` 的 **null 分支必须保持原路径**
  （5 个 fixture 不传 sunLight：`test-render-world` / `test-lamp-compare` / `test-sky-tree` /
  `test-ao-corner` / `test-ao`）。⚠️ **灯光必须先于 `RenderWorld` 创建** ——
  `shadow()` 节点在材质构建时固定 light 引用。
- **刷新是 per-light 按需**：`light.shadow.autoUpdate = false` + 三个请求源（世界编辑 `block-changed` /
  玩家移动超 5 格 / 日夜太阳方向变化）→ `ShadowScheduler` 200ms 节流（mc-lite
  `World.requestShadowMapUpdate` 同构）→ 帧循环 `tick()` 放行才置 `needsUpdate`（必须在 render 之前 ——
  `ShadowNode.updateBefore` 在本帧渲染前读它）。⚠️ 这**不是可选优化而是硬约束**：VSM 下每帧重渲会把
  稳态 drawCalls 从 53 打到 428。⚠️ 消费端门控 `tick() && castShadow` 的**操作数顺序是载荷性的**
  （v1.44 修订说明 ③）。
- **阴影浓度随日夜淡出**：`uShadowStrength = skyDim`（白天 1.0 / 夜里 0.25，DR-6）。
- **太阳方向随日夜连续插值**（有意偏离 mc-lite 的离散风格切换）：`VISUAL_STYLES` 存 mc-lite 三组原值
  （morning `[0.18,0.45,0.88]` / noon `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`），关键帧逐分量 lerp 后
  normalize（归一化收在 `_apply`，全路径一致）。
- **开关是代码级**（构造选项 `shadows` 默认 true + `?shadows=0` URL 入口 + `Game.setShadowsEnabled()`），
  不进设置面板、不持久化（DR-7）。⚠️ 关闭须**三处协同**（`castShadow` / `uShadowStrength` / DayNight 的
  `shadowEnabled` 标志），缺一处即静默失效（v1.44 修订说明 ④）。
- **与 v1.9 / DR-14 是两条独立路线**：DR-14 撤销的是「体素 skylight 遮挡投影」（skylight 恒 15 口径
  **不变**，§4.6 未动），shadow map 是纯渲染层的表面投影，两者视觉问题不同（前者是体素内部大片全黑 +
  截断渐变环，后者是地表影子）。本决策**不推翻** DR-14，其保留的遮挡模型仍不启用。
- **实体不投射不接收**（本期范围外，DR-8）：后续给实体加阴影 = 对应 InstancedMesh 开 `castShadow` +
  材质乘 `shadow()` 节点（实体材质同为 unlit，接收也需手动相乘），与体素同手法。
- ⚠️ 阴影 pass **不消费 alphaTest** → 树冠投影是实心立方轮廓（Minecraft 原版同款表现）。若观感不可接受，
  升级为 `castShadowNode` + alphaTest（但对上面那条 depth-compare bug 大概率无效）。

**4.4.5 LOD 预留（第一阶段只留接口，不实现）**
- `MeshingRequest` 带 `lod` 字段；RenderTree 按 `(cx,cz)` 聚合，
  未来视距 > 12 时外圈可切换为 4×4 column 合并的粗网格（只保留高度表层 + 结构轮廓）。
  默认 BatchedMesh 路径下 LOD 切换 = 外圈 section slot `setVisibleAt(false)` +
  粗网格 geometry `setGeometryAt` 换入（或独立 LOD BatchedMesh），接口天然兼容。
- 第一阶段视距 8~10 不需要 LOD，但数据/调度接口按此预留，避免二次重构。

**4.4.6 WebGPU 唯一后端（渲染基线）**

新引擎以 `WebGPURenderer` 为**唯一**渲染后端（three/webgpu 构建，TSL 可用），
**第一阶段不做 WebGL2 降级**。理由：

- WebGPU 覆盖面已足够：Chrome/Edge（2023+）、Safari 26（2025）均原生支持；
  Firefox 141 仅 Windows 默认开启，macOS ARM 要到 147，Intel Mac 需手动 flag——
  但目标用户（自己玩 + 小范围分享）以 Chrome/Edge/Safari 为主，实际影响可忽略；
- mc-lite 已在 r184 验证 WebGPU 主路径可行，无需再背兼容包袱；
- 核心架构（逐面网格化、section mesh、TSL NodeMaterial）在 WebGPU 上是原生最优路径，
  砍掉 fallback 不动摇任何架构决策；
- 双后端的渲染正确性/性能/材质行为双重验证成本是实打实的负担，砍掉即减负。

启动时做 WebGPU 能力检测（`navigator.gpu` gate），不支持则显示明确提示
（"请用支持 WebGPU 的浏览器打开"），不做静默降级。该 gate 不锁死架构，
未来如需 WebGL2 兜底仍可后补（NodeMaterial 双后端通用）。

mc-lite 已在 r184 完成 WebGPU 迁移（含 renderAsync），mc-heavy 直接站在 r185.1 上，
并显式利用以下能力：

- **显式管理 draw call（不是指望后端红利）**：纠正一个常见误解——three.js 的
  WebGPURenderer 在 pipeline/bind group 哈希与 render list 排序上的每 draw CPU 开销
  通常**不低于** WebGL。WebGPU 的真正优势在于命令缓冲的批量提交与更少的驱动状态切换，
  但 draw call 数量仍必须作为一级约束：这正是 §4.4.2 采用 BatchedMesh 通道级合批发布
  （而非每 section/column 一个 Mesh）的原因。
- **renderAsync 异步渲染循环**：帧循环用 `renderer.setAnimationLoop` + async 语义，
  渲染提交与主线程调度解耦，配合 §4.9 帧预算控制器。
- **BufferAttribute.addUpdateRange(start, count)**：section 网格重建后只上传变化段，
  避免整缓冲重传（r185 正式 API；BatchedMesh 的 `setGeometryAt` 内部即走此路径）。
- **TSL NodeMaterial**：天空、水面、雾、色调映射全部用节点材质实现
  （mc-lite 的 TSL 水面/天空盒方案整体移植，r185 节点库更完整）。
- **frustumCulled + 预计算包围盒**：section 包围盒在 meshing 时算好随缓冲回传。
  默认 BatchedMesh 路径用内置 `perObjectFrustumCulled`（per-section 剔除，零运行时计算）；
  fallback 候选 A 逐 column（16×16×128 AABB）。
- **预留（第二阶段+）**：compute shader 做 GPU 驱动剔除/LOD 选择、indirect draw 进一步
  压缩 draw 提交。注意 r185.1 的 WebGPU 后端对 BatchedMesh **不是** multi-draw/indirect
  提交（v1.6 核验，§4.4.2），这条路真要压缩命令数得自己做，第一阶段不引入。

兼容性基线：仅支持原生 WebGPU 的浏览器（Chrome/Edge/Safari 26；Firefox 视平台而定，不作承诺）。
HUD 显示当前后端为 WebGPU；不支持时启动 gate 拦截并提示。

### 4.5 玩家与交互（src/player/）

**4.5.1 物理**
- 移植 mc-lite Physics 的 AABB 碰撞语义（0.6×1.8×0.6 玩家盒、台阶/云块特判等），
  但碰撞查询全部走 `world.isSolid()` typed 读路径。定步长 60Hz 累加器，渲染帧率与物理解耦
  （120Hz 屏幕不会让移动速度翻倍——mc-lite 已有帧率无关动画修正，延续）。
- **飞行（创造模式，v1.81）**：状态唯一权威 = `PlayerPhysics.flying`（`src/player/physics.js`），
  `Player` 不复制一份 —— 重力/积分/碰撞/step-up 全在物理层，放上层就会被迫重复判定。
  - 键位（**有意偏离原版**）：`F` 单击切换。原版是双击空格，但那需要 350ms 时间窗，且第一次按空格会先跳，
    与本仓空格键上的「矿车下车边沿检测」争同一键位。空格升、Shift 降、WASD/方向键水平移动。
  - 速度：水平 = `SPEED × FLY_SPEED_MULT`（= 16 格/秒，用户裁定的「走路 2 倍」；原版是走路 2.5×，
    但本仓 `SPEED = 8` 已是原版疾跑的 1.43 倍）；垂直恒 `FLY_VERTICAL_SPEED`（8 格/秒，**标定初值**）。
    **不设疾跑加速档**（用户裁定）。
  - 落地退出（Java 口径）：`_stepFlying` 每步先清 `onGround` 再移动，向下触地即 `flying = false`；
    顶到天花板不退出（只把 `vel.y` 归零）。撞方块边缘**不做**自动上台阶。
  - 与既有系统的耦合：飞行中 `onGround` 恒 false → `player.js` 既有的 `jumping: !onGround` 判据
    自动让跑动晃动为 0（**不新增判据**）；乘坐矿车期间物理步整段跳过 → `F` 键在乘坐期忽略
    （偏离原版「进矿车不解除飞行」，理由是避免「视觉在车上、状态说在飞」的分裂）；
    飞行状态**不持久化**（不进存档与进度包 —— 它是瞬时移动状态，不是世界状态）。

**4.5.2 体素射线（替换 THREE.Raycaster）**
- Amanatides-Woo DDA 体素遍历：`world.raycast(origin, dir, maxDist)`，
  O(距离) 次 `getBlockId`，40 格射线约 60 次查表（mc-lite 的 mesh 求交是数万次矩阵运算）。
- 返回 `{ hit, blockPos, normal, prevPos }`：挖掘用 blockPos，放置用 prevPos。
- 每帧最多 1 次主射线 + 少量实体射线（子弹，第二阶段）。枪的 40 格 far 语义保留。

**4.5.3 方块编辑管线（唯一写入口）**

```
world.setBlock(x, y, z, id, meta)
  1. column.blocks[idx] = id；meta 写入；column.version++
  2. column.edits.set(idx, {id, meta, blockEntity?})  ← 持久化层（blockEntity 见 §4.1）
  3. 标记受影响 section dirty（见下方最坏范围定义）
  4. 快速路径：同步重建几何实际变化的 section（单块 < 2ms）
  5. 光照增量更新（§4.6，异步）
  6. 事件广播：'block-changed'（物理/实体/音效/粒子订阅）
```

**边界方块编辑的最坏重建范围（必须写死）**：位于 section 角上的方块最多影响 8 个 section
（AO 是对角 1 格依赖）。若快速路径全量同步重建 8 个 section，最坏 8×2ms=16ms，
直接爆 120fps 帧预算。规则：
- **快速路径只同步重建几何实际变化的 section**（面增删只发生在正交相邻 section，
  通常 1~2 个，<2ms）；
- **仅受 AO 影响的对角 section 置脏走精修路径**（Worker MESH，1 帧内收敛——
  AO 延迟一帧肉眼不可见），与 §4.3 halo 协议「对角 AO 是永久近似」的口径一致。

批量编辑由 `WorldEditor.setBlocks(batch)` 协调 `WorldData.setBlocks(batch)`：每个有效格仍写入
`column.edits`，每个变更 column 仅递增一次版本，合并脏 section，并对变更 column 与边界邻居
入 `scheduler.enqueueLight()`；批量路径跳过快速路径、统一走 Worker REMESH，主线程只做调度与
缓冲替换。mc-lite 的 batchFaceCullingTimeout / isBatch 补丁语义被原生吸收。该能力由第二阶段
M4 玩家武器先行实现，也同时是 TNT/爆炸的共享入口；M4 的范围、DDA 与受控资产约束见
`docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`。

**4.5.4 背包/快捷栏（M3.1，v1.16 定稿）**

创造模式无限背包。**权威数据只有一份**：`player.inventory`（`src/player/inventory.js`），
快捷栏不是独立容器，而是背包前 9 格的视图（v2.96 起；M3.1 定稿时为 5 格）。mc-lite 同构
（`HUD.renderHotbar()` 读 `inventory.slots[i]`，i < 5）—— 格数有意多于 mc-lite，见下方槽位语义。
**权威数据只有一份**：`player.inventory`，本设计不引入第二份物品状态。

物品模型照搬 mc-lite `src/actors/player/Slots.js` 语义：

```js
Slot { id, item /* string|null */, count, meta }   // set/clear/isEmpty
Inventory(size)  // slots[]、selectedSlot、add/remove/has/getSelected/selectSlot
```

- `isEmpty()` = `item === null || count <= 0`；`add()` 先堆叠到同类物品槽、再找空位；
- **两个数字不要混淆**：`Inventory(size = 1000)` 的 `size` 是**槽位数**（mc-lite `Slots.js:57`），
  `DEFAULT_INVENTORY_COUNT = 1500` 是创造模式填充时**每格的 count**（mc-lite `GameConfig.js:9`）。
  本设计文档 v1.16 前的 §4.5.4 曾写「mc-lite 默认 1500 格语义」，把二者混为一谈，已勘误。
  M3.1 实际填充 122 槽（物品集合大小），其余 878 槽留空供后续生存 Epic 的掉落/拾取使用。
  口径历经两次变更：**2026-09-03 → 118 槽**（排除 `chimney` 与床三项）、
  **2026-09-12（M9）→ 116 槽**（再排除创造台两项，见下方物品集合段落），其余槽位留空。
  ⚠️ **实际填充槽数 = 物品集合大小**，计数以 `npm run check:data` 的 `[物品集合]` 输出为准
  （本文件不携带硬编码计数 —— 同一事实的多个副本会漂移）；
- **创造模式不消耗**：`count` 仅为占位字段，放块/挖掘不递减，`remove()` 保留供后续生存
  Epic 使用；**UI 不渲染数量**（无限背包语义，显示 1500 是噪声）。mc-lite 显示 count，
  此处为产品决策差异，非遗漏。

槽位语义（与 mc-lite 一致）：

- **快捷栏 = `slots[0..HOTBAR_SIZE-1]`**（v2.96 起 9 格，对齐原版 1~9），数字键 1-9 → `selectSlot(0..8)`；
- `selectedSlot` **可越出 9**：背包面板点击任意非空槽即选中，此时快捷栏 9 格**无高亮**
  （mc-lite 同行为），放块取 `getSelected()` 的物品；
- `Player.placeBlock()` 从 `inventory.getSelected().item` 解析方块 ID，**不再索引常量数组**。

物品集合：BlockRegistry 全部条目，排除两类（**派生集合**，计数以 `npm run check:data` 的
`[物品集合]` 输出为准；2026-09-12 起为 **116 项** = registry 126 − 排除 10）：
- `air`、`collider`、`calcite`、`realistic_trunk_collider`（**非玩家可放置的功能性方块**；
  mc-lite 背包同样排除这 4 项）；
- `chimney`、`bed_head`、`bed_tail`、`bed_alias_block`、`playground_block`、
  `playground_center_block`（**可放置但不进背包**，归 `HIDDEN_FROM_INVENTORY` 常量，共 6 项；
  前四项 2026-09-03 新增，后两项 **M9 新增**）——
  - `chimney`（烟囱）：`solid:true` + 有 `faces-data` + 能放能挖，是正常可放置方块。对齐依据：
    mc-lite 背包清单是 `Game.js:206+` **手工列举 107 项**，实测核对 `chimney` 不在其中（非推测）。
  - `bed_head`/`bed_tail`/`bed_alias_block`（床）：**床渲染存在未修复的镂空透视问题**
    （床侧面有一个面无贴面 → 透视穿帮，详见 §4.3 顶点模板段 mesher 里的 TODO）。此处是
    **规避而非修复**：靠「不入背包 → 玩家选不到 → 实际不会被放置」避免暴露该问题，床渲染本身
    仍待专门解决（归属床/宝箱/门多方块 Epic）。mc-lite 手工清单同样不含 `bed_head`/`bed_tail`；
    `bed_alias_block` mc-lite **含**，本仓库一并移除是因为它 `cullMode:'none'`（不渲染、无法出
    图标），放进背包只会渲染一个空槽。
  - **为什么这些可放置方块不并入上面那 4 项的集合**：那 4 项语义是「非玩家可放置的功能性方块」，
    把可放置的方块放进去会让集合语义失真（后续若有人读该集合判断「能否放置」会得出错误结论）。
    故用独立的 `HIDDEN_FROM_INVENTORY` 常量表达（语义：**可放置但不进背包**），二者语义互斥。

**背包图标（v1.26 起为全量离线烘焙）**：图标是**离线预生成产物**，运行时只读一行 CSS 串。
演进路径：v1.23 手工图标表 → v1.24 异形方块等轴测（9 项，入世界 atlas）→ **v1.26 全量 118 项
独立 atlas + 预生成 CSS 串**（v1.26 修订说明）。

产物：`assets/icons-atlas.png`（1024²，**独立于世界 atlas**）+ `assets/icons.json`
（每个方块一条完整 `background` 串，含位置/尺寸/no-repeat，另存输入指纹）。
运行时（`src/ui/icons.js` 的 `loadIconManifest()`）：

```js
// 快捷栏 40px 档 / 背包 32px 档（按显示尺寸烘焙 → 运行时零缩放）
icon.style.background = manifest.hotbar[name];   // 1 行
```

取代 v1.24 之前的「`tileOfName()` 两级查表 + `tileStyle()` 裁剪数学 + 写 4 个样式属性 +
`INVENTORY_ICONS` 例外表」（实测约 91 行 → 1 行；预生成串与旧路径 computed style 逐项相等）。
**独立 atlas 的额外收益**：消除 v1.24 记录的「新增 textures 子目录重排世界 tile 坐标」副作用，
且 UI 不必加载 2048² 世界 atlas 只为裁图标。

**形状与 UV 的唯一权威 = `src/mesh/mesher.js`**（红线 1）：烘焙脚本
（`tools/bake-icon-atlas.mjs`）import 该模块，**禁止手写第二份几何/UV 定义**：

- 异形方块 → `TEMPLATES[geometry]`（v1.24 已导出）；
- 实心方块（104 项，无模板）→ `cubeQuads()`，由 mesher 的 `FACE_VERTICES`/`FACE_UVS`
  派生（v1.26 导出这两个常量）。`mesher.js` 可在 Node 下 import（无 three/DOM，红线 8）。

**逐面采样贴图**（v1.26 关键修正）：采样回调签名为 `(u, v, face)`，按面取 `getFaceTile(name, face)`。
实测背包实心 104 项里 17 项是多面不同贴图（`grass` 顶绿侧土、`chest`/`tnt` 顶侧不同），
旧的单面采样会让 `grass` 顶面渲成土色。

**覆盖范围（物品集合全量，2026-09-12 起 = 等轴测 100 项 + 平面 16 项）**：⚠️ 计数以
`npm run check:data` 的 `[物品集合]` 与 `[图标]` 输出为准（历史漂移记录：v1.26 成文时是
「118 = 等轴测 104 + 平面 14」，M7/M8 加两个 alias 方块与 M9 移出创造台两项后为
「116 = 100 + 16」）。平面清单
（`tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`，用户指定口径）= `water`/`swamp_water`/`cloud`/
`flower`/`short_grass`/`allium`/`azure_bluet`/`dead_bush`/`oxeye_daisy`/`red_mushroom`/`vine`/
`lilypad`/`mine_cart`/`hanging_lamp` —— 等轴测立方体对植被/水/云不合适（植被贴图有透明像素，
实测 `flower` 86% / `vine` 76%；水/云无几何语义），保持平面贴图并**保留 alpha**。
`mine_cart` 走平面路径采 mc-lite 手工图标 `Invicon_Minecart`（是**实体**不是方块，
mesher 无其几何模板 → 等轴测不适用）。

**图标过期门禁（v1.26）**：图标是派生产物，权威输入是 mesher 几何 + `faces-data` 贴图。
改背包内方块的贴图地址或几何后须重跑 `npm run icons`，否则图标**静默过期**（渲染旧形状/旧配色，
肉眼看不出）。`npm run check:data` 用**输入指纹**比对当场抓到：指纹 = 几何顶点序列 + 三个可见面
的贴图名 + **贴图内容哈希**（只钉贴图名会漏掉「换同名 PNG 内容」这条最常见路径，实测踩过）。
指纹逻辑放共享模块 `tools/icon-fingerprint.mjs`（烘焙脚本与门禁同一份，红线 1）。

> **两侧集合仍有差异（2026-09-03 实测记录，未处理）**：mc-heavy 118 项 vs mc-lite 手工清单
> 107 项。差集中除已排除的 chimney/床三项外还有：`swamp_water`、`sky_wood`/`sky_stone`/
> `sky_grass`/`sky_leaves`（M2-7 空岛新增，mc-lite 清单成文时这些方块尚不存在）、`azalea_log`、
> `vine`、`lilypad`、`realistic_oak_leaves`/`realistic_yellow_leaves`/`swamp_leaves`、
> `playground_block`/`playground_center_block`；反向差集 1 项 `gold`（mc-heavy 无此方块）。
> **本次只按指令排除 chimney + 床三项**，其余差异项未动——若要全面对齐 mc-lite 的 107 项清单，
> 需单独决策（`sky_*` 是本仓库独有的 M2-7 内容，不宜简单删除）。
>
> **2026-09-12（M9）更新**：上表差集里的 `playground_block` / `playground_center_block`
> **已对齐 mc-lite**（加进 `HIDDEN_FROM_INVENTORY`，见 v1.40 修订说明 ②）；其余差异项仍未动。
> ⚠️ 该段引用的 mc-lite 侧计数须实测复核（`Game.js:206-321` 实测 107 行匹配、其中 2 行被
> 注释掉 → **有效 105 项**）；此处保留历史原文不追改。

**物品顺序（冻结）**：`slots[0..8]` = `stone`、`dirt`、`grass`、`sand`、`cobblestone`、
`wood`、`glass_block`、`tnt`、`leaves`（即 `HOTBAR_ITEMS`，保持快捷栏默认观感与
既有测试断言稳定），其余 135 项按 `registry.all()` 注册顺序追加（确定性构建，不依赖 Map
迭代顺序以外的因素）。
> **2026-11-14 变更**：第 9 项 `mine_cart` → `leaves`（用户裁定「第九号方块中放的是矿车，
> 我不要放矿车，换成 leaves 方块」）。`mine_cart` **仍在背包集合内**（它由注册序带入，不在
> 排除集合），矿车玩法入口按物品名在背包里找槽，不受影响。
理由：`blocks-data.js` 注册序前几位是 `water`/`swamp_water`/`cloud`/`glass_block`/
`glass_blink`（非玩家常用建材），纯注册序会让快捷栏第 6~9 格变成
`water`/`swamp_water`/`cloud`/`glass_block`，既不合理也破坏视觉基线。mc-lite 用
`Game.js:206+` 手工列举 107 条（`stone` 居首）达到同样效果；
本设计以「前置常量 + 注册序补全」表达，集合成员与 mc-lite 的差集为 v1.16 起的
BlockRegistry 新增方块（如 `sky_stone`/`sky_grass`），属预期扩展。

> **v2.96 修订**：快捷栏由 5 格扩到 9 格（用户 2026-11-12：「把游戏底部默认的显示的可选择的方块的数量
> 从五个调整成 9 个」），对齐原版 1~9 键位。前置冻结序随之从 5 项扩到 9 项（后 4 项是用户选定的
> 常用物品，不是注册序的自然延伸）；物品集合总成员不变（仍是 registry − 排除集合），只有顺序变。

背包面板（`src/ui/inventory.js`，DOM 方案照搬 mc-lite `src/style/global.css`）：

| 项 | 值 |
|---|---|
| 触发 | `Z` toggle、`Escape` 关闭（仅打开态响应） |
| 遮罩 | `position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:80`（高于设置面板的 70：两个模态可共存于栈，后开的背包在上层） |
| 内容框 | 600×400、`#c6c6c6` 底 + 4px `#555` 边 + `box-shadow:5px 5px 0 #000` |
| 网格 | `grid-template-columns:repeat(8,1fr)`、gap 8、`overflow-y:auto` |
| 槽位 | 52×52 **总盒**（`box-sizing:border-box`，= 48 内容区 + 2px 边框 × 2）、`#8b8b8b` 底、左上白/右下 `#373737` 斜角浮雕边；`.selected` 3px `#FFFF00` + `#a0a0a0` 底；`:hover` `#999`。**必须 border-box**：选中边框 2px→3px 在 content-box 下会把总盒撑到 54×54 → grid 该行变高 2px → 下一行整体下移（点选抖动，实测位移 2px）；border-box 下边框往内吃、总盒恒 52 → 零抖动 |
| 图标 | 32×32、`image-rendering:pixelated`、读预生成的 `background` 串（v1.26，`icons.json` 的 `inventory` 档）；**按显示尺寸烘焙 → 运行时零缩放** |
| 名称 | `.item-name` 绝对定位顶部、10px 白字 + `text-shadow:1px 1px 0 #000`、溢出省略号 |
| 空槽 | 不渲染（只列非空槽，mc-lite 同行为） |
| hover 浮层 | 挂 `body` 的单例、`position:fixed` 跟随光标、`pointer-events:none`、`z-index:85`（`TOOLTIP_Z_INDEX`，v2.17）。**必须高于背包自己的 80 与设置面板的 70** —— 浮层与两个模态同在根层叠上下文（`#hud-root` 无 CSS、不建层叠上下文），原值 60 会被不透明的内容框整个盖住；仍低于 toast 的 90 |

**输入门控（M3.1 修正既有漏洞）**：`Z`/`Escape` 与设置面板共用一套模态协议 —— 打开时
`document.exitPointerLock()` + 清空 `player.keys` + `game.uiModal = true`，关闭时
恢复 pointer lock（见下）+ `uiModal = false`。

`game.uiModal` 原先只在主循环 `if (!this.uiModal) this.player.update(dt)` 生效，
而 `Player._bindInput()` 的 `window.keydown` **不受门控**：模态打开期间新按的键仍会
写入 `keys`、改 `hotbarIndex`。M3.1 在 `keydown` 入口加 `uiModal` 守卫（`digit` 选中一并
拦截）。该守卫是 M4 Task 6 的前置条件 —— M4 在同一段 `keydown` 挂 `KeyR` 切武器，
若无守卫则面板打开时按 R 会切武器并播 `gun_load` 音效。

**模态栈（M3.1 新增，收口单一布尔标志的多面板竞争）**：`uiModal` 原先是**可写布尔**，
只有设置面板一个消费者时够用；背包加入后二者会互相踩 —— 设置面板开着时按 Z 开背包、
再关背包会把 `uiModal` 置 false，令仍在显示的设置面板**失去输入门控**（WASD 恢复移动、
`player.update` 恢复）。故 M3.1 把它改为**模态栈**：

```js
game.uiModal          // getter：栈非空即 true（读取侧完全不变）
game.pushModal(owner) // 打开时调用；owner 为面板标识（'settings' | 'inventory'）
game.popModal(owner)  // 关闭时调用；**只移除自己的 owner**，不误清他人的门控
```

`uiModal` 不再可写（写入抛错或忽略），`tests/m3-hud.spec.mjs` 的读取断言不受影响。
mc-lite 没有面板互斥（`UIManager.js` 里背包与设置各自独立 toggle、互不感知），
但它也没有共享的门控标志 —— 本仓库的 `uiModal` 是 M3-4 引入的，故互斥责任落在这里。

**pointer lock 恢复（口径与 mc-lite 不同，有意）**：mc-lite `Inventory.toggle()` 关闭时
`document.body.requestPointerLock()`；本仓库的 lock 目标是 **canvas**
（`Player._bindInput()` 的 `canvas.click` 入口 + `document.pointerLockElement !== this._canvas`
守卫），锁 body 会让视角与放挖全部失效。故 M3.1 关闭面板时 lock 回 `player.canvas`，
与设置面板统一。**注意**：浏览器的 pointer lock 需要用户手势，程序化 `requestPointerLock()`
可能因 `SecurityError` 失败（尤其无头环境）—— 调用处必须 try/catch 吞掉，
失败时回落到既有交互：用户点击画面即重新锁定（canvas click 入口已在）。
设置面板原 `close()` 未做 lock 恢复，M3.1 一并补齐以统一两个面板的语义。

样式表按 `settings-panel.js` 同法注入（组件自带、`mc-` 前缀防污染、重复构造只注入一次）：
`.slot:hover`/`.selected` 等伪类与状态类无法用 inline style 表达。

**4.5.5 爆炸计算（M8）**

`src/voxel/explosion.js` 的 `computeExplosion()` 是**同构纯函数**，在主线程同步执行，
**不走 Worker**。判定依据：计算量 = 27 + 125 = **152 次 `getBlockId`**
（3×3×3 破坏 + 5×5×5 连锁搜索），比 M7 放置 38 格结构还轻；且爆炸的方块破坏、音效、
特效必须**同帧**发生 —— 走 Worker 要等回包，玩家会先看到方块消失再听到爆炸声。
红线 3 禁的是「全量 meshing/AO/结构布局」这类主线程重计算，不含此类交互级查询。

归属 `src/voxel/` 而非 `src/gen/`：它是纯体素层查询，不是生成；且 voxel 是分层图最底层
（`voxel ← gen ← mesh ← render`），三个消费者（`player/`、`core/`、`entities/`）都能 import
而不触发依赖方向门（`check-architecture.mjs` 的 §3 规则）。

**4.5.6 第一人称手臂与跑动视角晃动（v1.48）**

两块纯视觉层，都不碰体素数据、不新增渲染通道：

- **手臂** `src/render/view-arm.js`（主线程，three）：单个 `Mesh` 挂 camera 下，
  与 `view-weapon.js`（持枪视图模型）**互斥** —— 徒手时显示手臂、持枪时隐藏，
  由 `Player.selectWeapon()` 统一驱动（同一处切换，不得两侧各判一次）。
  造型/站位/静止角/挥动公式逐字对齐 mc-lite（`Player.js:137-141` +
  `PlayerInteraction.js:923-933`）：`BoxGeometry(0.4,1.2,0.4)`、`scale 0.1`、
  `rotation.x=−0.8`、`position (0.07, −0.10−(1−drawProgress)²·0.5, −0.12)`、
  挥动 `rotation.x = −0.8 − sin(p·π)·0.87`。
- **跑动晃动** `src/player/view-bob.js`（**纯逻辑，无 three/无 DOM**）：对齐 mc-lite
  `PlayerInteraction.updateCameraBob()` 的判据与公式（移动 + 全速 + 不跳跃；
  `bobX=sin(t)·amount`、`bobY=cos(2t)·amount·0.5`，`amount` 指数渐入/衰减）。

**v1.49 两项实玩反馈修正（均是有意偏离 mc-lite，方向来自原版 Minecraft）**：

- **晃动幅度 0.05 → 0.09，并新增相机 roll/pitch 两个旋转分量**。用户反馈「幅度稍小，小到
  看不出来在跑」。根因不止是数值：mc-lite 只做平移，画面像「平移」而不是「跑步」—— 缺了
  vanilla `GameRenderer.bobView()` 的 `camera.rotation.z`（roll）与 `camera.rotation.x`
  （pitch，`|cos|` 双频）。只放大平移而不加旋转，观感仍是「镜头在抖」而非「人在跑」。
- **手臂挥动改为原版双曲线**（取代 mc-lite 的对称单曲线 `sin(p·π)`）：
  `attack = sin(√p·π)`（**峰在 p=0.25**，快出）驱动主劈 pitch 与 yaw，
  `whip = sin(p²·π)`（**峰在 p≈0.707**，滞后）驱动甩腕 roll，外加向前下探的位移。
  两条曲线峰值错开才产生「甩腕」而非整体平移；mc-lite 的对称曲线（峰在 p=0.5、前后等速）
  正是「看着生硬」的根源。

**v1.50 两项实玩反馈修正**：

- **晃动幅度回调**：0.09 → **0.07**，roll 0.022 → **0.014**，pitch 0.012 → **0.007**（三项一起降）。
  用户在看 v1.49 效果后反馈「又太剧烈了」。**钜烈的砚觉根源在旋转而不在平移** —— 同量级旋转对
  砚觉的刺激远大于平移，故只降平移而保留原旋转仍会「歪得明显」。
- **挖掘挥手时机改为「试图即挥手」**：v1.49 把 `swing()` 放在 `setBlock()` 旁边，而 `digBlock()`
  上面有三个早退分支（矿车命中 / 无 target / TNT 引爆 / 不可破坏）→ 挥动静默消失。
  现提到**函数顶部、所有早退之前**，与 mc-lite 同口径（它命中路径与 `else` 分支各调一次
  `this.swing()`）。代价是越肩挖空气也会挥手，但这正是原版行为，且挖掘是按住连续点，
  无反馈会让玩家以为卡住了。

**v1.51 相机零旋转（实玩反馈：不要歪头）**：

- 用户反馈「这个镜头晃动，左右摆动的体验很不好，跑动的时候镜头始终是水平的，身体再晃动，
  所有镜头晃动的时候不要『歪头』」→ **`rollAmount` 与 `pitchAmount` 双双置 0**（用户选
  「旋转全部去掉」而非只去 roll）。跑动感全部由**位置平移**提供 —— 平移不改变任何朝向，
  地平线永远水平。
- **字段保留而非删除**：它们仍是「可配置的旋转幅度」，置 0 = 关闭；将来若要开回来只改数值，
  不动代码结构。这处**有意偏离 MC 原版**（原版 `bobView` 确实带 roll/pitch）。
- 断言必须落在**相机**的 `rotation` 上，不能只断言 `viewBob.roll/pitch` ——
  「bob 算成 0 了但 `player.js` 另加一个常量」这类注入只有相机侧能抓到（负向验证已证）。

**v1.52 晃动改距离驱动（对齐原版节奏）**：

- 用户反馈「左一步右一步的晃动，频率要适配跑动步伐节奏，现在太快了」。
- **根因：相位由时间驱动**（`timer += speed·dt·60`），于是晃动频率与移动速度脱钩 ——
  走慢/撞墙时相位照涨，而原版天然贴合步伐。
- **原版机制**（`GameRenderer.bobView` + `minecraft-renderer` 的 `computeCameraBob` 逐行核对）：
  `walkDist += 0.6 × 水平位移`、`phase = walkDist × π` → **相位只取决于走过的距离**。
  振幅 `bob → min(0.1, 水平速度)`；`x = sin(φ)·bob·0.5`、`y = −|cos(φ)|·bob`（**只向下**，
  一个周期两次下沉 = 每步一次落地）。
- **频率标定（关键，别照抄步幅）**：原版一周期 = `2/0.6 = 3.333 格`；原版疾跑 5.612 格/秒
  → **1.6836 Hz**（每步 297ms）。但本仓 `SPEED = 8` 格/秒（比原版快 ~43%），
  **照抄 3.333 格/周期会得到 2.400 Hz —— 比原版更快，与反馈方向相反**。
  故按**节奏时间**对齐：`phasePerBlock = 2π / (8 × 3.3333/5.612) = 1.3223 rad/格`
  → 1.6836 Hz。⚠️ 改 `physics.js` 的 `SPEED` 时**必须重算这个值**。

**v1.53 晃动幅度上调（0.1 → 0.13）**：

- 用户反馈「晃动幅度再稍微大一点，现在的跑步的感觉不是很明显」。
- **关键发现：标称值 ≠ 玩家看到的幅度**。`smoothingRetention`（0.7）是一阶低通，在 1.6836Hz
  处**通过率只有 0.8976**（实测）→ 标称 0.1 时实际 y 峰只有 **−0.0898**、x 峰 ±0.0449。
  这是之前没算清的一层衰减：前几轮按标称值讨论「够不够」，实际相当于少给了一成。
- 故上调到 **0.13** → 实测 y 峰 **−0.1177**（+31%）、x 峰 **±0.0580**。
  这处**有意偏离原版 `bob` 上限 0.1**（原版上限是配合它的步幅/速度标定的，本仓速度不同）。
- **判定口径必须用「扣掉平滑后的实际峰值」**（单测与 E2E 各有一条下界断言），
  否则「标称调大了但平滑把增幅吃掉」这类静默失效抓不到。

**v1.54 步频放慢（1.6836 Hz → 1.5 Hz）**：

- 用户反馈「步频稍微慢一点」。原版疾跑 1.6836Hz（每步 297ms）→ 本仓取 **1.5 Hz**
  （每步 **333ms**，慢 10.9%）。选 1.5 而不是更慢：仍明显快于原版**走路**的 1.295Hz，
  保留「在跑」的节奏感；再慢会滑向走路的观感。
- 换算：`phasePerBlock = 2π × 1.5 / 8 = **1.1781** rad/格` → 一周期走过 `5.3333 格`。
- ⚠️ **频率降低会让一阶平滑通过率上升**（0.8976 → 0.9161），实际幅度随之略增：
  y 峰 0.1177 → **0.1199**。改频率时要**重测实际峰值**，不能假设幅度不变。

**v1.55 步频再降一档（1.5 Hz → 1.35 Hz）**：

- 用户「再慢一档」→ 1.5 Hz → **1.35 Hz**（每步 370ms，比上一档 +11%）。
- **下界依据（重要）**：原版**走路**是 1.295 Hz，1.35 Hz 只剩 **~4% 余量** ——
  再往下降就会落进走路的节奏里，观感从「在跑」变成「在走」，届时需要重新确认设计意图
  而不是继续调这个数。单测里有一条「须快于原版走路 1.295Hz」钉住这条界线。
- 换算：`phasePerBlock = 2π × 1.35 / 8 = **1.0603** rad/格` → 一周期走过 `5.9259 格`。
- 平滑通过率继续上升（0.9161 → 0.9304）→ 实际 y 峰 0.1199 → **0.1203**。

**v1.56 手臂烘焙面明暗（立体感）**：

- 用户反馈「手臂的横面和竖面没有光影效果，感觉就是一个颜色，没有立体感」。
- **保持 unlit**（不换受光材质）：本仓全场景 unlit，受光材质会让肤色随日夜灯光漂移、
  且比同屏方块亮一档（v1.48 已记录的取舍）。改为把明暗**烘焙进顶点色**，三层相乘：
  1. **vanilla 方块面遮挡系数**（顶 1.0 / 前后 0.8 / 左右 0.6 / 底 0.5）；
  2. **固定光向 Lambert 项**（`lightDir=(0.35,0.85,0.4)`，抬到 `[0.45,1]` 防全黑）；
  3. **沿长度渐变**（远端 78%）—— ⚠️ **这一层是实测必需**：`rotation.x=-0.8`（≈46°）时
     手臂只露出**两个面**（底面 + 前面），第三个面被几何自身挡住 → 只靠前两层的话屏幕上
     仍只有两档亮度、单面是纯色（直方图实测 79%/19.6% 两个尖峰、中间空）。
- 实测（像素直方图）：修复前 **2 个亮度档、最大单色占比 78.9%** → 修复后
  **11 档、最大单色占比 46.8%**、面间双峰相距 26%。

**三条口径（改动前必读）**：

1. **晃动必须按物理步推进，不能按渲染帧**。物理是 60Hz 定步长 + accumulator，120Hz 渲染下
   隔帧才走一步 —— 按帧推进时没走物理的帧位移为 0 → 判据判「没在动」→ 相位每帧归零，
   晃动永远起不来。按步推进后相位严格为 `speed×60` rad/s，与渲染帧率无关。
2. **偏移必须融进那一次全量 `camera.position.set(...)`，不得写成 `+=`**。`player.update()`
   每帧重写相机位置，全量 set 天然幂等；改成累加会让上一帧的偏移被下一帧当基线继承 →
   逐帧漂移。
3. **手臂材质用 unlit（`MeshBasicMaterial`），不跟随 mc-lite 的 `MeshStandardMaterial`**。
   本仓的场景双灯（Ambient + Directional）只为枪的 PBR 模型而设；用受光材质会让肤色
   随日夜灯光漂移、且比同屏方块亮一档（`minecart-renderer.js` 用 MeshBasicMaterial 是先例）。
   挥动时长也从 mc-lite 的「每渲染帧减 1」改为 dt 基定长 1/6 秒（上游 120Hz 下挥动只有
   60Hz 的一半时长，是帧率依赖缺陷）。

归属：手臂在 `src/render/`（依赖 three，与 `view-weapon.js` 同层）；晃动逻辑在 `src/player/`
（纯函数，与 `step-lift.js` 同手法，供浏览器内单测直接驱动）。

⚠️ **这是红线 3 的边界判定例外**（同类先例是 §4.5.3 的编辑快路径同步重建）。同类判定还有一处：
炮塔索敌的 LOS 采样（`src/entities/turrets/turret-system.js`）同样留在主线程 ——
LOS 必须读方块，而世界数据的唯一权威在主线程（红线 1），把计算搬去 Worker 就必须把数据
也搬去（每 RPC 约 1.28MB、8Hz → 每秒 10MB 结构化克隆），那是更大的红线违规。

破坏写入一律走 `editor.setBlocks()` 的**单次批量事务**（§4.5.3），不为爆炸另开路径。
连锁延迟用 `center` 坐标派生的**确定性抖动**（`[500, 1100]`ms）而非 `Math.random()`
（红线 2：同 seed 两次结果须一致）。到期判定用 `performance.now()`，禁止 `Date.now()`。

### 4.6 光照与 AO（src/mesh/lighting.js，Worker 侧）

第一阶段模型（对齐 mc-lite 的视觉效果，补齐其缺失的体素光照）：

- **AO**：经典四角 AO（移植 AOUtils 的 side/corner 判定），meshing 时计算，无独立 AO Worker/脏集——
  mc-lite 的 AOWorker/AOBridge/AONodeSystem/dirtyAOPositions 整套删除，
  因为 AO 在新管线里是 meshing 的免费副产品。
- **skylight（v1.9：第一阶段不启用阳光遮挡投影）**：`computeSkylightColumn` 恒写 15，
  悬挑/洞穴下不产生阴影；视觉明暗只来自 **AO 墙角阴影 + 日夜全局调制**（对齐 mc-lite
  视觉基线；实玩验收驱动的产品决策——遮挡阴影在大悬空平台下产生大片全黑 + 截断渐变，
  用户明确不要）。**机制完整保留**供后续阶段启用：遮挡模型 = ① 垂直 pass 15 遇 opaque 停
  ② 水平 BFS 每格 -1（原实现 `computeSkylightColumnOccluded`）；区域重算（light 任务）的
  column 集合 = **`LIGHT_REGION_OFFSETS`（3×3，v1.64 修正，见下条 blocklight 的推导）**。
  **写回协议（中心权威，v1.8）**：每列 light 只由以它为中心的 task 写回；邻列只参与计算
  不写回（只置脏重 mesh）——旧「写回全部 5 列 last-write-wins」会让 region 不完整的后到
  task 覆盖邻列已收敛的好光（blocklight 黑核根因）。第一阶段 skylight 恒 15 时该检测
  （空气格 skylight=0）恒不触发，light 任务仅由编辑触发。
  **编辑快路径**：`recomputeSkylightAt` 单列 O(128) 置 15（守 2ms 预算）。
- **blocklight**：emissive 方块（灯/萤石/岩浆，移植 LightSourceManager 的方块清单）
  做 flood fill（强度 15 逐级 -1 衰减）。**放置**光源用增量 BFS 即可；
  **删除**光源时的降光是全流程最难的一步（需撤销传播路径），第一阶段不追求增量删除，
  采用**全 column 重算**（或小半径局部重算）兜底，增量删除 BFS 明确放到后续阶段。
  **重算区域 = 3×3（v1.64 修正，2026-10-21）**：光强度 15、每格 -1 → 最远照 14 格；
  column 边长 16 → 正交邻居最近格距本列边缘 1 格、**对角邻居 2 格（两者都必须参与）**，
  隔一列已达 17 格（贡献恒 0）。v1.63 及之前只取「中心 + 4 正交」的 5 列，漏了 4 个对角列——
  实测（全量 BFS 作真值）最大误差 **10 级 / 982 格错**，表现为用户报告的「灯光有边界」。
  **入队范围 ≠ 写回范围（载荷性不对称）**：写回只写中心列（3×3 只对中心列精确，邻列是
  截断结果），但**入队必须覆盖 3×3** —— 灯放在 A 列，它的光锥会进入每个邻居列的角落。
  旧实现只入队编辑所在列 → 邻居列永远没有自己的 task，它们的 light 永远是 GEN 的截断值。
  另：`_onGenResult` 需对「3×3 内存在 emissive」的列入队（结构性光源没有编辑事件），
  否则「走远再回来」会再看到同一个边界。
  重算触发相关 section 精修重建。**脏 section = mesher 的 light 依赖者，不是「light 字节变了的 section」
  （v1.65 修正，2026-10-21）**：section S 的网格读 S 自身 16³ + 六个面外各 1 格厚的 halo 的 light
  （faceLight 读面外邻格；模板方块读自身格；棱/角 halo 格不读 light），所以格 (lx,ly,lz) 的 light 变化
  要通知：① 它所在 section；② ly=0/15 时的下/上相邻 section；③ lx/lz∈{0,15} 时的 4 个**正交**邻列同 sy
  （对角列不依赖）。纯函数 `lightDirtyMasks(prev,next)`（`lighting.js`）是这条规则的唯一实现；
  只脏「字节变了的同 sy」会漏掉地表在 section 顶/底层时的地面（放灯不亮、删灯不暗），而「9 列 × 8 section
  无条件全脏」又会把 mesh churn 放大 9 倍 —— 两头都不对。
  **回包校验三层**（都是「task 手里的输入已不是当前输入」→ 丢弃并重新入队）：中心列版本 / 全部输入列版本 /
  输入列**集合**（在途期间新到达的就绪列）。
- 视觉效果上保留 mc-lite 的 PointLight 挂灯方案作为**可选增强**（镜面高光），
  但基础照度不再依赖它，避免光源数量增长拖垮渲染。

### 4.7 水面与特效

- **全局海面**：移植 mc-lite 的 800×800 水面平面 + TSL 波纹/边缘淡出 shader，
  跟随玩家平移（海面是平面不是体素，成本 O(1)，这是 mc-lite 做对的地方，保留）。
- **海面配色与高光合成（v1.82 → v1.83，与 mc-lite 有意偏离）**：
  **v1.82**（用户「波纹泛白，要深一些、灰一些」）：旧公式
  `uColor + white × (diffuse + scatter + spec + fresnel×0.1)` 里那一项**每个像素都非零**
  （平静水面 k≈0.20，不是只在高光斑才加），基色 B 在线性空间已 0.776，再加就进 ACES 压缩区
  → 众数峰 luma **187**。故高光改为「**乘进基色到白的剩余量**」
  （`base + highlight × t × (1 − base)`，天然有界）。只改基色不改高光时只降到 168（已负向验证）。
  **v1.83**（用户「还是太泛白，参照真实大海」）：**量参照图 `/Users/bachi/ttt/bug/海.png`
  得海区 `67/107/124` —— G−R **+40**、B−G **+17**，真实海面是青绿而非蓝**。上一版
  `133/149/178` 是 G−R 只有 +16 的灰蓝 → **只压亮度永远修不到位，缺的是色相**。三处联动：
  ① 基色 → **`0x0c342f`**（深青绿）；② 高光 → **`[0.66, 0.90, 0.92]`**（偏青绿，权重 0.42）；
  ③ **`WATER_OPACITY` 0.7 → 0.92** —— 海面平面是半透明的，底下还有一层**体素水方块**
  （实测均值 `123/142/198`，偏蓝且亮），0.7 时 30% 直接透上来把青绿拉回蓝并抬亮，
  这是「改完基色还泛白」的**第二个根因**（实测同一基色下 0.70 → 近处 `86/111/146`、
  0.82 → `76/103/130`、**0.92 → `67/95/112`**）。远雾色 `0xa7d1e2` → `0x8aacbe` → **`0x556e7e`**
  （`fogNear=20/fogFar=70` ⇒ 远处海面几乎全是它；屏幕 `93/131/152` 正对参照图远处 `94/132/152`）。
  最终实测（noon / 海岸机位 / 冻结物理+日夜+阴影+HUD+波纹）：近处水面
  **177 → 148 → 92**（`67/98/109`，G−R 31、B−G 11），波纹动画变化占比 0.40。
  **v1.84**（用户「又太暗发脏，再蓝一些亮一些；水方块和水面差异太大」）：
  v1.83 的 `69/98/107` luma 仅 92 → 观感是浊水。改基色 **`0x2a5f85`**（海蓝）、高光偏蓝、
  雾色 `0x7aa4c4` → 近处水面 **123**（`85/130/163`）。
  ⚠️ **三条反馈不矛盾**：前两轮要「不要白」、本轮要「不要脏」——**亮度与饱和度是两个自由度**，
  泛白的反义词不是发暗；参照图是**阴天**（海区 luma 仅 100），游戏里是正午晴天，
  直接取其亮度必然发脏。**可信的锚点只有色相（B ≥ G > R），亮度须按本仓光照单独标定。**
  **v1.85**（用户「水方块太浅要更蓝；远看几乎呈透明色、能清楚看到海底；波纹也变蓝一些」）：
  两个独立问题。① 颜色：体素水贴图均值 → **`70/115/155`**、平面基色 → **`0x22598a`**、
  雾色 → `0x6b9cc0`（平面 B−G 33 → 43）。② **透明度**（本轮新发现的一类问题）：
  源图 alpha 175（0.686）时水下地形透上来 31% → 「远看几乎呈透明色」；
  `WATER_TARGET_ALPHA.water = 230`（0.90）→ 降到 10%。
  ⚠️ **alpha 的失效是静默的** —— 颜色全对、门禁全绿，只是远看能看见海底 → `[水体贴图]` 必须单独钉 alpha
  （负向验证：注入 alpha=175 → 门禁报 `产物 alpha=175，应为 230`）。
  实测：平面近处 `76/123/166` vs 未被平面覆盖的远岸带 `75/125/164` → **差 6**（v1.84 是 17）。
  ❚ **标定踩坑**：批量烘焙多个候选再逐个截图会**全部读到最后一个 atlas**（四个变体读数逐位相同）
  → 必须「烘一个 → 测一个」串行，否则会误判成「贴图不生效」。
  **另一件事（本轮新增的一类问题）**：海面平面与水方块是**两套独立颜色源** ——
  源图 `assets/textures/water.png` 是高饱和紫蓝（均值 `47/102/211`），渲染后 `59/100/190`，
  而平面是 `92/133/164` → 逐通道差 **85**，海岸线上是「亮紫蓝水带浮在浅蓝水面上」。
  新增 **`npm run water`**（`tools/bake-water-textures.mjs` + 共享 `water-texture-fingerprint.mjs`）：
  对贴图做**通道平移**（逐像素同偏移 → 完整保留源图 24 种色阶，不重画成纯色），
  均值拉到 `95/140/168`，产物落 `assets/textures/procedural/water.png`（源素材不动，
  与树叶孔洞压缩 / 巨树贴图同一口径），`faces-data.js` 指向它 → 差距 **85 → 17**。
  ⚠️ **改 `ocean.js` 的水面配色后必须重算 `WATER_TARGET_MEAN` 并重跑 `npm run water` + `npm run atlas`**，
  否则两者又会分家。`check:data` 的 `[水体贴图]` 环节钉住「faces-data 指向产物 + 产物均值对齐目标」。
  ⚠️ **`water-visual` 的判据随本轮改了三次**：最初「蓝像素占比 > 0.05」在压灰后**恒真**
  （隐藏海面后比值反而更高）→ 换「众数峰 luma 双侧带」→ v1.83 发现 luma 带也拦不住
  「压暗但仍偏蓝」（灰蓝态 148，与目标的差别在**色相**不在亮度）→ 新增**青绿色相判据**
  （`G−R ≥ 24` 且 `B−G ≤ 22`）→ v1.84 发现它还会放过「又绿又暗」，改为**三相判据**
  （`G−R ≥ 24`、`B−G ≥ 8`、`B−G ≤ 45`）+ 亮度双侧带 [105, 140]。同时**水体像素判据必须跟着色相改**：
  旧的 `b > r+30 && b > g+30` 要求 B 显著高于 G，会把青绿/灰蓝海面整个排除
  （实测可采样本降到 0），现用 `b > r+12 && g > r+12`。
- **水面遮罩判据（v1.41 变更，与 mc-lite 有意偏离）**：判据唯一权威 =
  `render/ocean-mask.js`（CPU 版供单测断言），`render/ocean.js` 的 TSL 版同构实现并共用
  其数值常量。三项口径：
  1. **遮罩高度 = 真实生成高度 `generateHeight`**（不是 mc-lite 的基础噪声近似）。
     mc-lite 用近似噪声是因为写在着色器里图省事，代价是判据与真实地形偏差
     +1.39~+6.71（DESERT `×0.5+2` / SWAMP `×0.3-2` 的调整没算进去）→ 实测城外假水面 19.3%。
  2. **阈值 = `SEA_Y`**。`generateHeight` 返回整数 → `h < SEA_Y` ⟺ `h <= SEA_Y-1`，
     正是 `fillColumn` 的水体方块判据（判据同源，无需「floor 余量」这类补偿项）。
     实测三档对照（10 seed × 城外 70080 采样点）：
     | 方案 | 假水面 | 漏判真水 |
     |---|---|---|
     | 近似噪声 + 阈值 -0.8（mc-lite 原值） | 19.3% | 0.2% |
     | **真实高度 + 阈值 SEA_Y（本实现）** | **3.5%** | **0.0%** |
     | 真实高度 + 阈值 SEA_Y-1（过严） | 0.2% | 13.1% |
     残留 3.5% 全是五点取样（±3.5 纵深）的**有意侵入**（水面沿海岸向内侵一小圈，
     mc-lite `Engine.js:672` 的 `offsetVal` 口径），判据偏差 = 0。
  3. **城市 bounds 门控**：`getBiome` 不含 CITY（它由结构系统按 bounds 叠加），
     所以遮罩算不出 CITY 压平调整 —— 城市把地面压到接近海平面
     （`CITY_MIN_SURFACE_Y` = SEA_Y+1），而水面平面在 SEA_Y+0.5 → 下挖 2 格洞底顶面
     降到 -2 就低于水面平面，玩家在**陆地**上挖出一汪假水。故城市必须靠 bounds 单独关掉。
     bounds 经 `ocean.setCityBounds()` 接线（`game.js` 复用 `waitForRegion(0,0)`，
     城市全世界唯一、固定 `CITY_REGION=[0,0]`）；未接线时取哨兵 bounds（判定恒假 → 门控关闭）。
     门控零误伤的前提 = bounds 内确实无水体 —— 见下条。
- **城市内无水体残留（v1.41 补，对齐 mc-lite 分支链语义）**：mc-lite 的列循环是 elif 链
  `if (inCity) → … → else if (h < wLvl)` 填水 —— 城市与填水体**互斥**，城内永不填水。
  mc-heavy 是两阶段：`fillColumn` 无条件填整列（含水体 `(naturalH, SEA_Y]`）+
  `generateCity` 覆写。覆写范围 = 地表填充 `[fillStartY, surfaceY]` + 岩石层
  `[surfaceY-12, surfaceY-1]`；当 `surfaceY-12 > naturalH`（城市地表被压高、自然地形是深海床）
  时水体会落在覆写范围之外 → 残留。实测：bounds 内残留水格 16600、其中 56 格暴露
  （顶面 -1.5 恰与水面平面同高，肉眼就是「陆地上挖出一汪水」）。
  修法 = `generateCity` 用城市岩石材料**补实**缺口区间 `[naturalH+1, min(coverBottomY-1, SEA_Y)]`
  —— 不清成 air（会在城市地下造出空洞，玩家挖下去掉进洞里比看到水更糟）。
  修完后 bounds 内零残留、零暴露 → 门控零误伤。
- **体素水**（swamp_water/河流湖泊）：transparent 材质组，meshing 时只生成与水/空气交界的面，
  顶面按邻居水位降低高度（简单水面高度图，避免 Z-fighting）。
- **雨效与天气状态机（M3-3，v1.15 增补）**：`render/weather.js` 晴 → 雨 → 晴随机周期状态机
  （晴 60~180s / 雨 30~90s / 过渡 5s 线性淡入淡出，intensity∈[0,1] 为唯一消费口径；
  force 手动覆盖与自动周期共用过渡语义，判档一次锁定）。`render/rain.js` 移植 mc-lite
  `src/world/effects/RainEffect.js`：LineSegments 每滴 2 顶点，下落/循环全在 TSL 顶点阶段
  （`(uTime×speed×speedScale+phase) mod cycleHeight`），主线程只做 30Hz 距离检查 +
  64 滴/帧分批雨幕迁移（削峰）；`world.isSolid` 向下搜索 56 格做地面截停（雨滴不穿地）。
  视觉参数冻结：267 滴 / 半径 18 / 速度 24 / dropLength 0.5 / opacity 0.6。
  intensity=0 时 LineSegments 隐藏（省 draw）。不引入 mc-lite 没有的天空压暗/雾距联动。
### 4.8 持久化（src/save/）

```
IndexedDB（沿用 mc-lite DB 名/版本约定）
  ├─ meta:    { seed, spawn, schemaVersion, savedAt }
  ├─ edits:   chunkKey → 压缩的修改列表（仅玩家改过的方块，条目 {id, meta, blockEntity?}，
  │           典型 KB 级/column；blockEntity 为可序列化对象，第一阶段恒为 undefined）
  ├─ player:  位置/朝向/背包（第二阶段；设置持久化已改落 localStorage，见 v1.15 ②。
  │           注：背包 UI 与物品模型本身已归 M3.1，见 §4.5.4；此处推迟的是其**持久化**——
  │           第一阶段背包内容确定性构建、无需落盘，玩家改动只体现在世界 edits 中）
  └─ entities:（M5 起：炮塔/矿车等持久运行时实体 snapshot；丧尸为临时实体，
                丧尸巢穴的锚点/冷却归对应 blockEntity）
```

- 写盘完全异步：edits 在内存中按 column 聚合，防抖 5s + 页面隐藏/退出时 flush（Worker 内序列化）。
- 加载 = 读 meta + 按需读 edits（column 生成时叠加），无"整图恢复"阶段。
- **进度包导入导出（v1.43）**：设置面板提供「导出进度 / 导入进度」——上表三个 store 的
  **可搬运副本**，供备份与跨设备搬运。包格式 `mc-heavy-progress` v1（`format` + `version` +
  `seed` + `spawn` + `columns[].cells[]` + `entities[]`），方块存**名字**、坐标存**世界坐标**；
  编解码在 `save/progress-codec.js`（纯函数），I/O 与落库在
  `Game.exportProgress()` / `Game.importProgress()`。两条硬口径：**导出前必须 `flushNow`**
  （内存 edits 才是真相）、**导入必须经 `_discardEdits()`**（唯一丢弃入口）。导入是
  **覆盖式**（清空当前改动）且非原子（失败重试即可，不引入临时 store 交换）。
  与「存档迁移」的区别：进度包是**同版本内**的搬运，迁移工具要处理**跨版本**的方块/结构
  语义变化，两者目标不同、格式也不共用。
- **丢弃玩家改动的统一入口 `Game._discardEdits()`**（v1.29）：取消在途防抖 flush + 清各
  column 的内存 edits + 清 IndexedDB `edits` store 与 `editsCache`。三个消费者共用同一份
  ——`newWorld`（换 seed + 写回 meta）/ `clearSave`（**保留 seed 与设置**，设置面板「删除缓存」）/
  `importProgress`（v1.43，覆盖式导入前先清空当前改动）。
  内存 edits 那步必要但风险窗口窄（卸载事务能否提交时序不定），详见 v1.29 修订说明。
- mc-lite 老存档迁移：提供一次性迁移脚本（第二阶段），读旧 region 记录提取 blockData diff。
- **M5 持久实体与流式卸载**：column 首次超出“加载半径 + 2”时，Scheduler 创建可取消的 pending
  unload；`EntityManager` 冻结该 column 的持久实体并把最小 snapshot 写入 `entities`。这段时间 world、
  render column 与临时实体仍保留。写入成功后的下一帧若仍超界，才同步通知 controller、失效实体 generation、
  回收实体并删除 column；写入失败或玩家重入则取消、解冻并保留一切运行时 state。pending 只记录 key/handle，
  不缓存 blocks/meta/light 或产生第二份世界数据。

### 4.9 调度与帧预算（src/core/scheduler.js）

**主线程每帧固定流程**：

```
1. input → player.step(定步长物理)
2. 世界调度：按玩家位置计算目标 column 集合（视距 + 2 生成提前量）
   - 新 column → 发 GEN 任务（Worker 池，按距离优先级）
   - GEN 完成 → 主线程接管数据（Transferable 零拷贝）→ 发 MESH 任务
   - MESH 完成 → 进入上传队列
   - 卸载走滞回带（见下方"卸载与重入"）
3. 帧预算消费（硬上限，超支顺延下帧）：
   - mesh 上传：≤ 3ms/帧（约 2~4 个 section 的增量段，默认 BatchedMesh 路径走
     `setGeometryAt` 增量替换；fallback 候选 A 按 section 区间写回）
   - 快速路径重建：≤ 2ms/帧（玩家操作优先，可透支单帧）
   - 光照增量：≤ 1ms/帧
4. 实体/特效 update（第一期为空/轻量）
5. render
```

- **版本协议**：所有异步任务携带 `(columnKey, columnVersion)`，结果回传时版本不匹配即丢弃。
  这是 mc-lite 用十几个补丁（assemblyEpoch/sourceEpoch/staging buffer/原子切换）才逼近的机制，
  新引擎作为基础设施一次做对。
  **丢弃的是结果，不是这份工作（v1.65）**：mesh 回包版本不符被丢弃时，该 section 必须**重新置脏**
  （`_redispatchDropped`），light 回包被丢弃时必须重新入队 —— 脏标记在派发前已被 `takeDirty` 消费，
  不重发就没有任何东西会再要求它，旧网格/旧光照会永久残留。重发只发生在被丢弃时、只重发被丢的那份，
  不是 epoch/防抖/staging。

- **卸载与重入（滞回 + LRU，v1.3 补齐）**：玩家在加载半径边界来回走（很常见）会造成
  GEN/MESH/上传全链路 thrashing。两条便宜规则：
  - **卸载半径 = 加载半径 + 2（滞回带）**：进圈立即加载、出圈延迟卸载；
  - **持久实体卸载门（M5 起）**：超出半径的含持久实体 column 先进入可取消的异步保存准备；在 snapshot
    成功的下一帧、且仍超界时才同步最终移除。准备时重入或写盘失败均取消/解冻并保留 column，不能把
    IndexedDB Promise 塞进最终移除通知或让失败后仍删除。
  - **重入 LRU**：刚卸载的 column 保留体素数据与 GPU 缓冲在短 TTL 缓存
    （5~10s 或 1~2 圈内存配额，先到先踢），重入时零成本恢复，跳过 GEN+MESH+上传。
    edits 本来就常驻，这条只多占一点显存，换来回头跑不卡。
  - 卸载的邻接副作用：column 卸载后，邻居边界 section 里「因它存在而被剔除的面」不会
    立即重 mesh——最外圈被雾遮住，可接受；玩家回移时由 GEN 就绪触发重 mesh 收敛
    （与 §4.3 第 3 条呼应）。
- **高刷适配**：渲染循环用 rAF 原生节奏（120Hz 设备自然 120 帧），
  物理/调度按 dt 归一；预算常量按 8.3ms（120fps）帧间隔标定，保证高刷下仍有帧内余量。
- **HUD 性能面板**：移植 mc-lite 的打点体系（ChunkPerfMonitor 思路），
  输出 GEN/MESH 队列深度、上传耗时、section 数、draw call、帧时分布——性能验收靠它说话。
- **世界数据看板 + 调试开关（`src/core/debug-config.js`）**：HUD 追加体素/面剔除/合批统计区
  （方块数、候选面、出块面、剔除面与剔除率、3 通道 BatchedMesh 的 slot/顶点、draw call、
  锥内三角/总三角），2s 异步刷新（非实时，守帧预算）。统计采集由 `DEBUG_FLAGS.worldStats`
  统一门控：开发调试期默认开；URL `?stats=0` 关闭（对照基线用）。关闭时 mesher 热循环跳过计数、
  scheduler/renderWorld 不存统计、HUD 不显示世界数据区。开关经 `debug-flags` broadcast 同步 Worker，
  与主线程快速路径同构生效。`DEBUG_FLAGS.statsLog`（URL `?log=0` 可关）随 HUD 同节奏
  console.log 精确数值行 + 原始统计对象（无鼠标选取环境读数据用）。
  draw call/三角读 `_lastRenderInfo`（render 后快照），
  避免异步读撞上 three `info.autoReset` 每帧清零。

### 4.10 内存预算（视距 8 基线）

| 项 | 估算 | 说明 |
|---|---|---|
| 体素数据（CPU） | ~37 MB | 289 column × 128KB（blocks Uint16Array 64KB + meta/light 各 32KB；保留 Uint16 为 >255 方块留余量） |
| GPU 顶点缓冲 | **~100 MB 级（大头）** | 活跃 section 平均几十~几百 KB，城市区更重；视距 16 会到数百 MB |
| atlas 纹理 | ~22 MB | 2048² RGBA + mipmap 链 |

- GPU 顶点缓冲是内存大头，且随视距近似平方增长。**显存控制靠滞回卸载 + LRU 兜底**
  （§4.9：出圈 +2 滞回带延迟卸载，重入 LRU 短 TTL 保留缓冲，LRU 满则真正释放），
  不靠池化——`RenderSectionPool` 只省 CPU 分配与 GC，**不省显存**。
- 视距 16 前必须先做 §4.4.5 的 LOD（外圈粗模），否则显存与 draw call 双双失控。
- edits 稀疏层常驻内存（卸载 column 时序列化进 IndexedDB 后可释放），典型 KB 级/column。
- **（v1.68）静态分配口径与验收口径**：三通道 `BatchedMesh` 顶点缓冲是**静态预分配**（`CAPACITY`，见 `render-world.js`
  注释），与上表「活跃 section」口径不同。巨树景观后静态分配 **188.83 MiB**（opaque 4.275M + cutout 2.20M +
  transparent 0.125M，×30B；原 148.06 MiB），实测活跃 `gpuActiveBytes` ≈ 127 MiB；M3-1 的「1.5× 余量红线」断言相应
  放宽到 200 MiB。**扩容是黏性的离散 ×1.5 跳增**（`_ensureCapacity`），验收一律读 reserved 相对**初始**容量，
  不读当前 `maxVertexCount`。

---

## 5. 目录结构

```
mc-heavy/
├─ index.html                  # import map（three@0.185.1 webgpu）+ 启动
├─ docs/
│  └─ phase-1-engine-design.md # 本文档
├─ tools/
│  └─ build-atlas.mjs          # 纹理 atlas 离线打包脚本
├─ assets/
│  ├─ textures/                # 从 mc-lite 复制（保持文件名）
│  ├─ atlas.png + atlas.json   # 生成产物
│  └─ structures/              # 从 mc-lite 复制 JSON 结构
└─ src/
   ├─ core/        # Game.js(主循环) Engine.js(渲染器/相机/天空) scheduler.js worker-pool.js perf.js
   ├─ voxel/       # block-registry.js chunk-column.js world-data.js edits.js explosion.js（M8 爆炸计算）
   ├─ gen/         # noise.js biome.js terrain.js structure-index.js structures/*.js（Worker 同构）
   ├─ mesh/        # mesher.js（Worker/主线程同构） lighting.js section-mesh.js atlas.js
   ├─ render/      # render-world.js sky.js water.js shadows.js materials.js
   │               # M8：turret-renderer.js turret-metal.js turret-top-geometry.js projectile-renderer.js explosion-renderer.js
   ├─ player/      # player.js physics.js raycast.js interaction.js inventory.js
   ├─ save/        # persistence.js codec.js
   ├─ ui/          # hud.js hotbar.js inventory-ui.js toast.js（M9 非模态提示）
   └─ workers/     # world-worker.js（GEN/MESH/LIGHT 统一入口，池化）
```

**第二/三阶段新增的顶层产物**（§4 子系统之外的资产与工具）：

- `assets/sounds/`（M4 起）+ M8 新增 `explosion.mp3` / `turret_gun_fire.mp3`（从 mc-lite 拷入）；
- `assets/turret/`（**M8 新增**）：源模型 `src/TankCannon.obj` + 烘焙几何产物
  `turret-top.json` / `turret-top.meta.json`（伴随 JSON 存参数与指纹，供门禁比对过期）。
  ⚠️ **v3.14 删除了整套 armor 贴图管线**（三张源图 / `armor.png` / `armor.json`）：
  炮头改走**三档冷灰金属颜色渲染**（色值在 `turret-config.js` 的 `TURRET_TONE_COLOR`，
  逐顶点 `tone` 属性选档），零贴图；
- `tools/bake-turret-top.mjs`（`npm run turretop`）+ `tools/turret-top-fingerprint.mjs`
  + `tools/turret-top-parse.mjs`（纯函数，浏览器单测可 import）—— 烘焙参数/指标/指纹的
  单一权威，烘焙脚本与 `check:data` 门禁共用。
  （旧的 `bake-turret-armor.mjs` / `turret-armor-fingerprint.mjs` / `npm run turret` 已随 v3.14 删除）；
- `src/entities/`（M5 起）+ **M8 新增 `src/entities/turrets/`**：
  `turret-config.js` / `turret-blueprint.js` / `turret-service.js` / `turret-controller.js` /
  `turret-system.js`（同构纯函数索敌）/ `projectile-system.js`；
- **M9 新增 `src/entities/playground/`**：`playground-config.js`（冻结数值）/
  `playground-service.js`（平台生成 / 关闭 / 锚点持久层 / 导入导出）；
- **M9 新增 `src/ui/toast.js`**：轻量非模态提示（不进 `uiModal` 模态栈 —— 提示期间玩家仍须能
  操作世界）。首个消费者是创造台的成功/失败提示，后续 Epic 可复用；
- **M9 新增测试产物**：`src/tests/test-playground.js`（浏览器内单测）+
  `tests/playground.spec.mjs`（E2E）；
- **M9 新增验收报告** `docs/m9-playground-acceptance-report.md`（与 M4~M8 同结构：
  实测数据 / 偏离表 / 负向验证清单）；
- **v1.58 新增 `assets/sky/{day,night}/`**：天空盒双立方图（各 6 面 × 1024²，从 mc-lite
  `skyBox4` / `skyBox1` 原样拷入、未重编码）。**不在 `assets/textures/` 下**（那里会进世界 atlas）；
  清单唯一权威 = `src/render/sky-config.js`（three-free，供 `check:data` 的 `[天空盒]` 环节）；
- **v1.58 新增 `src/render/` 三文件**：`sun-shade.js`（太阳方向光的标定常数与纯函数，
  **three-free**：Tier 1 单测与 `materials.js` 的 TSL 必须共用同一份常数）/ `sky.js`
  （天空盒双图交叉淡入 + 日轮月轮）/ `sky-config.js`（立方图清单）；
- **v1.58 新增测试产物**：`src/tests/test-sun-shade.js`（浏览器内单测）+
  `tests/sun-directional.spec.mjs` / `tests/skybox.spec.mjs`（Tier 4 像素实测）。
- **巨树景观新增 `assets/giant-trees/`**：`src/40AssortedTreesPack.schem`（烘焙输入，入库，与 `assets/sky/night-src/` 同口径：
  **不是渲染资源**）+ 烘焙产物 `trees.json` / `trees.meta.json`（28 变体 + 尺寸与输入指纹）；`tools/bake-giant-trees.mjs`
  （`npm run gianttrees`）+ `tools/giant-trees-fingerprint.mjs`（参数与指纹单一权威，烘焙脚本与 `check:data` 共用）+
  `tools/bake-giant-textures.mjs`（`npm run gianttextures`，6 张贴图 → `assets/textures/procedural/giant_*.png`，
  沿用现有镂空叶图案只换色）；
- **巨树景观新增 `src/gen/structures/giant-trees.js`**（Worker 同构，无 three）：region 层候选 + column 层光栅化；
  测试产物 `src/tests/test-giant-trees{,-column,-gen}.js`（浏览器内单测 31 条）+ `tests/giant-trees.spec.mjs` /
  `tests/giant-tree-budget.spec.mjs`（Tier 4）。

与 mc-lite 的关键差异：没有 FaceCullingSystem / ChunkConsolidation / BlockScatterManager /
GlobalInstancedMeshManager / WorldBoundsController / WorldGenerationService(预生成) /
AOBridge / AOWorker / 八个 Worker 文件——它们的职责被 §4 的四个子系统吸收。

---

## 6. 关键设计决策记录（DR）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| DR-1 | 删除预生成，纯按需生成 | 预生成提速/分区懒加载 | 生成是确定性的，预生成是冗余计算；按需生成 + 提前量调度后边界问题不存在 |
| DR-2 | 逐面网格化 + 纹理 atlas | 沿用 InstancedMesh 优化 | 单位面积三角形数平均降 2~4×、理论上限 6×（全立方 12 tri/块 → 暴露面 2~8 tri/块），配合合批发布（DR-11）把 draw call 压到数百级，是视距扩展的根本前提 |
| DR-3 | section(16³) 为网格单元 | 整 column 网格 | 单块修改重建成本 < 2ms，当帧生效；column 级重建需 5~15ms 且上传体积大 |
| DR-4 | 体素 DDA 射线 | 优化 Raycaster（BVH 等） | 体素世界射线有解析解，O(距离)；任何 mesh 求交方案都是数量级劣势 |
| DR-5 | 单 Worker 池多任务类型 | 每类专属 Worker（mc-lite 8 个） | 池化消除"AO Worker 空闲而生成排队"的负载不均；任务同构代码复用 |
| DR-6 | edits 稀疏层 + terrain 可再生 | 存全量 chunk 数据 | 存档 KB 级；加载无恢复阶段；天然支持"重生 chunk 不丢修改" |
| DR-7 | 无构建步骤 + 本地 vendor import map | Vite 构建 / CDN import map | 延续 mc-lite 开发体验；three.js r185.1 本地化（vendor/three/）避免 CDN 网络依赖，离线可用 |
| DR-8 | 世界高度 128（-32..96） | -16..112 / 64 / 256 | 兼容 mc-lite 坐标（结构零改造移植）；128 对齐 8 个 section 整除；内存 128KB/column 可控；下界 -32 给地形填充（最低 h-12，h 下界约 -16 → 最低块 -28）留足余量，避免截断 |
| DR-9 | 纯 JavaScript + JSDoc，不用 TypeScript | TS + 构建工具链 | 与 mc-lite 技术栈一致，零迁移成本；无编译环节，Worker/主线程同构代码直接共享；类型表达靠 JSDoc + ESLint 足够 |
| DR-10 | WebGPU 唯一后端（three r185.1），不做 WebGL2 降级 | WebGPU 优先 + WebGL2 兜底 | 目标用户全在现代浏览器，fallback 收益趋近于零；mc-lite 已验证 WebGPU 主路径；砍掉双后端的正确性/性能双重验证负担；架构不被锁死，未来可后补 |
| DR-11 | 渲染发布粒度：section 重建、BatchedMesh 通道级合批（默认，M1 实测确认；fallback 为 column 3-group） | 每 section 独立 Mesh / column 3-group 为默认 | v1.6 纠正 v1.3 的核心口径：r185.1 **WebGPU 后端对 BatchedMesh 不走 multi-draw**（WebGPUBackend.js:1806-1824 JS 循环逐可见 instance 发 drawIndexed；renderMultiDraw 只在 WebGL 后端），故 draw 数量与候选 A 同量级（数百 vs 固定 867），选型理由是**单命令成本低一个量级**（循环内共享同一 pipeline/bind group/顶点缓冲、命令间零状态切换、空 section 零命令）+ 剔除/排序/增量更新官方内置。geometry+instance 两层结构（漏 instance 层不渲染）；构造函数只接受单 Material（BatchedMesh 无 groups，传材质数组零 render item）；`reservedVertexCount`/`setGeometryAt` 覆盖 slot 打包，单 slot 溢出走 deleteGeometry→addGeometry→addInstance（`setGeometrySize` 是整批重建/收缩会 throw，非单 slot 扩容）；per-instance 视锥剔除与 `sortObjects` 运行时排序内置。section 独立 Mesh 视距 8 上限约 3600 draw 不可接受；column 3-group（固定 ~867，`_projectObject` 不看 group.count）仅作实测不达标时的 fallback。three.js WebGPU 每 draw CPU 开销不低于 WebGL，draw call 必须一级管控；material 数组逐 group 发 draw（Renderer.js:3149-3158 已核验），fallback 必须 channel-major 3-group 布局 |
| DR-12 | 跨 region 结构：邻区索引查询（本 region + 8 邻区） | 地标加硬 margin 禁止跨界 | 地标中心偏移 100~400 + 半尺寸 40~80 必然跨 400 格 region 边界；硬 margin 会改变与 lite 的世界布局、破坏同 seed 对比；邻区布局同 seed 确定性重算，成本由布局广播（DR-13）兜住 |
| DR-13 | 结构布局单 Worker 算一次、主线程转发广播 | 每 Worker 各持 LRU 缓存 / 主线程直接计算 | City 候选扫描很重：N Worker 重复跑会成为冷启动/进城新卡点，放主线程会卡帧；布局体积小且确定性，单点计算 + 广播成本可忽略；GEN 任务依赖布局就绪（最多 9 份邻区布局） |
| DR-14 | 第一阶段**不启用阳光遮挡投影**：skylight 恒 15，视觉明暗 = AO 墙角阴影 + 日夜全局调制（v1.9 产品决策）；遮挡模型（垂直 pass + 水平 BFS）与 light 任务中心权威写回机制保留，后续阶段启用。⚠️ **v1.44 落地的太阳阴影 shadow map（§4.4.4）是另一条独立路线**（纯渲染层表面投影，不进体素光照数据），**不启用**本条保留的 skylight 遮挡模型，skylight 恒 15 口径不变 | 高度图以下衰减近似 / Minecraft 式遮挡阴影（v1.8） | 高度图衰减在洞穴/悬挑下错误；Minecraft 式遮挡阴影实玩不可接受——大悬空平台/洞穴下方超扩散距离即大片全黑 + 截断渐变环，与 mc-lite 视觉基线冲突，用户明确不要阳光投影。机制保留：5-column region 对中心列充分（15 水平最远 14 格）；写回 5 列 last-write-wins 会覆盖邻列好光（v1.8 已修，中心权威） |
| DR-15 | 逐面网格化，不用 greedy meshing | greedy meshing | 上一版 mc-heavy（已清空）用过 greedy；逐面在 AO/编辑增量更新/UV 映射上显著更简单，三角形多 2~3× 但当前瓶颈是 draw call 而非三角形（WebGPU 下三角形吞吐充裕）；视距 16+ 若三角形成为瓶颈再评估 greedy 或 LOD |
| DR-16 | 卸载滞回（加载半径 +2）+ 重入 LRU（短 TTL 保留体素与 GPU 缓冲） | 出圈即释放 | 玩家在加载半径边界来回走会造成 GEN/MESH/上传全链路 thrashing；滞回带 + LRU 重入零成本恢复，只多占一点显存，回头跑不卡；显存上限由 LRU 配额兜底（§4.9/§4.10） |
| DR-17 | 权威数据源含方块实体通道：`blocks`+`meta`+`blockEntities` 稀疏 Map；light 为派生缓存非权威 | 富状态塞 meta / 用 InstancedMesh userData 暂存（mc-lite 补丁） | 宝箱库存/告示牌文字/灯开关等富状态塞不进 8bit meta；mc-lite 已有 `_saveChestStates()`（ChunkConsolidation.js:597）证明需求真实，但用 userData 暂存是补丁式实现。做成数据模型一等公民：edits 条目、持久化 schema、重放逻辑现在定形状，第一阶段只预留不实现消费者，避免后续回填引发 schemaVersion + edits 重放二次重构。light 可从 blocks+emissive 重算收敛，不得当真相来源（§4.1）。**首个消费者已由 M7 落地（2026-09-10）**：丧尸巢穴锚点（`{kind:'zombie-nest', id, origin, critical, lastSpawnAt}`）随 edits 落盘，验证了当初预留的形状够用 —— 无需 schemaVersion 变更、无需二次重构（预留收益已兑现）。**第二批消费者已由 M8 落地**：炮塔锚点（`{kind:'turret', id, origin, critical, rotation, lastFireAt}`）。**第三批消费者已由 M9 落地（2026-09-12）**：创造台锚点（`{kind:'playground', id, origin, size}`）—— 它只用该通道的**持久层半边**（`listBlockEntities(kind)` 扫库恢复 + 判上限），不复用 controller / 增量失效那半边（创造台无运行时行为，见 v1.40 修订说明 ①）。三个 kind（zombie-nest / turret / playground）共用同一 edits 通道与 `Persistence.listBlockEntities(kind)` cursor 扫库判上限，未引发 schemaVersion 变更 —— DR-17 当初预留的形状经第三批消费者验证够用。后续床/宝箱等同类装置可直接复用此通道，见 roadmap「M7 交付的可复用模式」段 |

---

## 7. 第一阶段里程碑

每个里程碑独立可玩、可验收，全部 TDD（延续 mc-lite 的 Playwright 测试工作流）。

**M0 骨架（0.5 周）**
- 项目脚手架、import map、Worker 池与 RPC、perf 打点、BlockRegistry + atlas 构建。
- **WebGPU 发布路径实测**：① 构造 3-group 单 Mesh 与 24-group 单 Mesh 对比，确认
  WebGPURenderer 逐 group 发 draw 的行为与 CPU 开销（为 fallback 候选 A 的 3-group 写死
  提供实测依据）；② 构造单 BatchedMesh 挂 ~2312 instance，确认 WebGPU 后端逐 instance
  drawIndexed 的真实命令数与 CPU 开销（v1.6 已确认非 multi-draw，此项验证量级）；
  ③ **BatchedMesh 两项 120fps 风险点实测（v1.6 新增）**：~2312 instance 时
  `onBeforeRender` 的逐 instance 剔除/排序 CPU 循环耗时（sortObjects 默认 true，
  不透明通道也每帧排序），以及 `setGeometryAt` 单块编辑的端到端耗时（flat 属性
  array.set 快路径是否真达到 <2ms）。
- 验收：空白场景渲染 + HUD 帧率面板；atlas 覆盖 mc-lite 全部纹理。

**M1 体素核心闭环（1~1.5 周）**
- WorldData/ChunkColumn/edits；地形生成（无结构）；section meshing（快速+精修双路径）；
  玩家移动/物理/DDA 射线/放块挖块；最小存档（edits 读写）。
- **发布层确认门（硬）**：默认实现 §4.4.2 BatchedMesh 通道级合批（含 `reservedVertexCount`
  预留 + `setGeometryAt` 增量替换落地）；在同一放挖压力场景下对比 120fps 基线的 p95 帧时，
  仅当逐 instance draw 提交 p95 更差、增量替换有正确性坑、或剔除/排序 CPU 循环吃帧预算时，
  才退回候选 A（column 3-group）。
- 验收：平原地形无限行走不掉帧；放块挖块当帧生效；重启后修改保留。

**M2 结构与世界完整性（1~1.5 周）**
- StructureIndex + 城市/金字塔/冰封山/雪地/海岛/树木移植；悬浮空岛与云层；biome 全量；洞穴；
  光照（skylight/AO/blocklight）；水面（海面+体素水）；日夜与三种视觉风格。
- 验收：出生点可见城市天际线；地标（含悬浮空岛与云层）与 mc-lite 结构轮廓/配色基调一致（同 seed 同位置截图人工比对，
  不做像素级 diff，因高度与光照模型不同）；
  跨 region 行走无卡顿。

**M3 性能达标与收尾（1 周）**
- 视距 8 全量调优（包含 M2-7 空中结构）；预算参数标定（60Hz/120Hz 双档）；雨效；HUD 完善；
  性能回归基线脚本（Playwright 自动跑图采样帧时）。
- 验收：§1 目标表全部达标；输出性能报告。

> **M4 不属于第一阶段里程碑。** M3 的性能报告与冻结基线验收后，第二阶段按
> **M4 玩家第一人称武器 → M5 实体运行时 → M6 丧尸 → M7 玩家放置丧尸巢穴** 的依赖链推进。
> M4 交付三把受控 GLB 武器、DDA hitscan、视图模型、曳光、音效与可选方块破坏；M5–M7 依次把
> 动态实体、临时敌人与方块锚定刷怪器接入既有数据/事件管线；M5 持久实体先以可取消 snapshot 保存完成
> 卸载准备，才会同步删除 column。M6 默认最多 20 只丧尸，保留
> 25/35/999 的三把枪实体伤害和六部件实例渲染，不新增玩家生命或近战；M7 保留玩家放置/全局 8 个/
> 关键方块失效语义。炮塔飞行弹丸、玩家生存战斗和用户模型导入继续后置。
> 各 Epic 的规格与实施计划见 `docs/superpowers/{specs,plans}/2026-08-23-m4-player-weapons-*`、
> `2026-08-23-m5-entity-runtime*`、`2026-08-23-m6-zombies*`、
> `2026-08-23-m7-zombie-nests*`。

---

## 8. 性能验证方案

- **自动跑图**：Playwright 脚本驱动玩家沿固定路线奔跑（含跨 region、进城市、贴墙转向），
  采集帧时分布（p50/p95/p99）、GEN/MESH 队列、上传耗时，输出对比报告。
  注意：本机（macOS ARM，Chromium 151）实测 Playwright 默认的 headless shell 零 flag
  **拿不到 adapter**，必须用完整 Chromium 新无头模式（`channel: 'chromium'`）才能零 flag
  走 Metal（本地跑图用真 GPU）；Linux CI 无 Metal，用 SwiftShader 组合（`--enable-unsafe-webgpu`
  + `--use-angle=swiftshader`）。CI 上帧率采样不稳定——**CI 自动跑图只作为门禁参考
  （趋势监控），本机设备矩阵才是硬验收**。
- **基线场景**：① 平原冲刺（视距 8）② 城市中心环视（最坏 draw call）③ 连续放/挖 200 块
  ④ 模拟 TNT 批量删除 500 块（M3 用 REMESH 路径验证）。
- **设备矩阵**：本机高刷屏（120Hz 目标 ≥90fps）+ 中端设备 profile（60fps 目标）。
- **视觉对比口径**：与 mc-lite 做**结构轮廓、配色基调**的视觉对比（同 seed 同位置截图人工比对），
  不做像素级 diff——新引擎的高度模型与光照模型与 lite 不同，像素级一致既不现实也不必要。
- 每个里程碑结束跑一次基线，性能回退 >10% 即阻断合入。

---

## 9. 后续功能扩展点（第一阶段只留接口）

| 功能（mc-lite 已有） | 引擎接入点 | 第一阶段预留 |
|---|---|---|
| M4 玩家第一人称武器 | `WorldEditor` + DDA hitscan + 相机视图模型 + 受控 GLB/Audio | 第二阶段首个 Epic；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m4-player-weapons-*` |
| TNT/爆炸 ✅ **M8 实施中** | `WorldEditor.setBlocks(batch)` + REMESH + **球体扩张特效**（mc-heavy 无粒子系统，不移植 mc-lite 的 2D Billboard 爆炸粒子） | M4-0 批量编辑 API、事件接口；爆炸计算为同构纯函数 `src/voxel/explosion.js`（§4.5.5） |
| M5 实体运行时 | EntityManager + 实体 raycast + 受控渲染层 + entities snapshot | 第二阶段实体底座；临时 entity 随 column 的“视距 +2”最终卸载回收，持久 entity 先可取消地冻结/保存最小 snapshot，成功后的下一帧才最终移除；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m5-entity-runtime*` |
| M6 丧尸 | M5 临时 entity + WorkerPool AI + 武器距离比较 + 6 部件 InstancedMesh | 默认 20；20Hz 单 batch AI、60 格外冻结、手枪/加特林/MAG7 为 25/35/999 伤害与 40/40/10 格；不含 PlayerVitals/近战；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m6-zombies*` |
| M7 玩家放置丧尸巢穴 | `WorldEditor` + blockEntities + M6 ZombieService | 最多 8 个，蓝图最高 `gold_block` 破坏即失效（alias 只作最小创造模式放置触发）；8 offset × 六层搜索，`restoreEdits()` 保持 anchor 存档；规格/计划见 `docs/superpowers/{specs,plans}/2026-08-23-m7-zombie-nests*` |
| 炮塔/飞行弹丸 ✅ **M8 实施中** | M5 EntityManager + 实体射线 + 8 部件 InstancedMesh（单材质单纹理 UV 分区）+ **M7 方块锚定装置模式** | M8 Epic；装置层（`blockEntity` 锚点 + `block-changed` 增量失效）/ AI（主线程同构纯函数，见 §4.5.5 的 LOS 判定）/ 渲染 / 弹丸四步串行 |
| 玩家生存战斗 | M5 EntityManager + 玩家状态/HUD + 事件 | 独立 PlayerVitals Epic；定义近战、伤害、无敌、死亡与重生后才实施，不夹带入 M6 |
| 矿车/轨道 | 方块属性（track 类型）+ 实体运动系统 | BlockRegistry 的 `interact`/`onStep` 钩子 |
| 创造台 ✅ **M9 已交付** | `WorldEditor.setBlocks` **真实方块**（54×54 平台）+ `blockEntity` 锚点（M7 装置模式的持久层半边）+ 模型 JSON 导入导出 + 面板动作按钮与 toast | 平台方块登记 `indestructible` 并移出背包（v1.40 修订说明 ②）；**不维护方块集合副本**（红线 1，v1.40 ③）。⚠️ 原「mesher 顶点模板机制」是 M8 前的规划语，与实际实现不符 —— 平台是可挖可放的真实体素 |
| 灯/光源 | emissive 属性 + blocklight flood fill | 光照管线已含 |
| 床/宝箱/门 | 多方块结构 + 朝向 + 交互钩子 + 富状态（库存/文字） | meta/orientation 位、`blockEntities` 通道（§4.1）、交互事件 |
| 存档迁移 | save/codec 版本字段 | schemaVersion 机制 |
| 音频（挖掘/爆炸/环境音） | AudioManager + 事件订阅 | `block-changed`/交互事件总线（音频挂事件即可） |
| 输入/指针锁定/相机 | InputManager + PointerLock + 第一人称相机 | 第一阶段已实现基础版，后续武器/载具复用 |
| 设置持久化（画质/音量/视距） | save/player 记录扩展 | player 记录已含画质设置字段。**音量档当前不在面板**（默认 100%，字段仍持久化 + `?volume=` URL 可达，v1.35）—— 音频接线时在此处加回档位即可，不必改数据模型 |
| 出生点安全选择 | spawn 逻辑（§4.2 已含 dry ground 搜索） | 已实现，后续存档复活点复用 |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 城市结构移植量大（WorldWorker 3296 行） | M2 延期 | 结构按"候选索引先行、光栅化逐个移植"推进，每移植一个结构跑一次同 seed 结构轮廓/配色视觉对比 |
| WebGPU 在目标设备不可用 | 无法启动 | 启动 gate 检测 `navigator.gpu`，不支持则显示明确提示引导换浏览器；目标用户均在现代浏览器，实际影响面极小；架构保留未来后补 WebGL2 的可能 |
| 120Hz 下主线程余量不足 | 高刷目标落空 | 预算按 8.3ms 标定；上传/光照严格让帧；必要时 section 上传降为隔帧 |
| 老存档不兼容 | 玩家资产丢失 | 第二阶段提供迁移工具；本阶段 meta 保留 worldId/seed 字段对齐 |

---

## 附录 A：与 mc-lite 模块映射表（移植清单）

| mc-lite 模块 | mc-heavy 去向 |
|---|---|
| TerrainGen / MathUtils(noise,biome) | src/gen/noise.js, biome.js（算法照搬，接口重写） |
| workers/maps/*（CityMap/Pyramid/…） | src/gen/structures/*（光栅化接口改造） |
| world/entities/Island.js / Cloud.js | M2-7 `src/gen/structures/sky-structures.js`（确定性 rasterize，非 entity） |
| structure-index/* | src/gen/structure-index.js（整体移植） |
| structures/*.json | assets/structures/（原样复用；两处有意例外：`big_house.json` 删 3 个草地 lilypad（见 §4.3）、`tall_well.json` 删 1 个孤立悬空 chest（2026-09-30）） |
| BlockData.js | src/voxel/block-registry.js（数据化重写） |
| AOUtils.js | src/mesh/mesher.js 内联（算法照搬） |
| OrientationUtils.js | src/voxel/meta.js + mesher 旋转模板 |
| Engine.js（天空/雾/视觉风格/水面 shader） | src/render/*（移植，参数随视距推导） |
| Physics.js | src/player/physics.js（语义照搬，读路径换 typed） |
| PlayerInteraction.js | src/player/interaction.js（Raycaster → DDA 重写） |
| RainEffect / ParticleSystem | src/render/effects/*（M3 移植） |
| Inventory/HUD/UIManager | src/ui/*（DOM 方案移植） |
| PersistenceService/WorldStore | src/save/*（edits 模型重写） |
| FaceCullingSystem/ChunkConsolidation/BlockScatterManager/GlobalInstancedMeshManager/AO* 全家桶 | **删除**，职责并入 meshing 管线 |
