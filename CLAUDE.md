# CLAUDE.md

本文件为 mc-heavy 仓库（`~/jaylli/mc-heavy`）的协作规范。所有解释、说明、对话用中文，代码注释尽量用中文。

**本文件只是索引 + 高频坑清单。** 架构细节在 `docs/phase-1-engine-design.md`，进度与历次改动的
实测数据在 `docs/roadmap.md`，测试分级在 `docs/testing-policy.md`。三者与本文冲突时以它们为准。

## 项目定位

从零重写的 Minecraft 风格体素引擎，功能对标姊妹仓库 [mc-lite](/Users/bachi/jaylli/mc-lite)，
但架构完全不同。**mc-lite 的地位是「功能与数据来源」，不是「实现蓝本」**：只提取功能语义、算法、
数据、视觉风格，禁止照搬它的架构组织方式（`FaceCullingSystem` / `ChunkConsolidation` /
`RegionCache` 等多层容器是它的病根，见 `tools/check-architecture.mjs` 的 `FORBIDDEN_NAMES`）。

现状：第一阶段 M0~M3、第二阶段 M4~M7、第三阶段 M8~M9 全部交付；此后按独立改动推进
（矿车 / 太阳阴影 / 巨树 / 竞技场 / 浅水高台 / 中世纪船 / 祭坛之龙 + Boss AI / 丧尸本地寻路 /
音效与 BGM）。**具体做到哪一步、每版改了什么，一律查 `docs/roadmap.md` 的版本表。**

## 常用命令

全部在仓库根目录执行。前置：Node v26、`npm install`（只装 playwright / eslint / pngjs 三个 devDependency）。

```bash
npm start                       # 静态服务 http://localhost:8081（端口固定，无构建步骤）
npm run check                   # 日常最小门 = check:arch + check:data + lint
npm run check:arch              # 12 条重构红线可静态检查的部分（three 隔离/禁止类名/依赖方向/资源 URL）
npm run check:data              # 数据契约门（引用完整性/物品集合关系式/图标与烘焙产物指纹/测试注册）
npm run lint                    # eslint src tools tests（--no-error-on-unmatched-pattern）
npm test                        # Playwright 全部 spec（自带 webServer，端口 8081 已有服务则复用；workers:1 串行）
npx playwright test tests/dragon.spec.mjs          # 只跑一个 spec
npx playwright test tests/dragon.spec.mjs -g "血量" # 只跑一个用例
npm run bench                   # 4 场景性能基线 → docs/m3-baseline.{md,json}
npm run bench -- --check        # 回归门禁（回退 >10% 退出码 1）
```

**烘焙命令**（离线产物，改了输入不重跑 = 静默渲染旧内容，`check:data` 用指纹抓）：

```bash
npm run atlas          # 世界图集 assets/atlas.{png,json}（新增 textures 子目录会重排 tile 坐标）
npm run icons          # 背包图标（改背包内方块贴图/几何后必跑）
npm run water          # 水体贴图（改 ocean.js 水面配色后必须同步重算并重跑）
npm run leaftextures   # 树叶孔洞压缩 → procedural/leaf_*.png（之后要 atlas + icons）
npm run gianttextures  # 巨树贴图 → procedural/giant_*.png（之后要 atlas + icons）
npm run grasstextures  # 深/浅草贴图（无 jpeg 解码器，先把源图 sips 转 PNG）
npm run tarn           # Cloudland 套件四族（高台/拱洞/紫晶柱/巨型云）
npm run pyramid | arena | shallowtarns | ship | azaleatrees | gianttrees
npm run turret | zombieskin | dragon | nightsky | validate:weapon-assets
```

`pyramid` / `ship` / `arena` / `shallowtarns` / `tarn` 支持 `-- --census`（源方块普查）；
`pyramid` / `ship` 另有 `-- --census-orient`（用真实 mesher 重测台阶朝向映射）。
**烘焙 = 数据格式转换，不产生新美术资源** —— 用户对此敏感，提烘焙方案时第一句要说清它只换格式、
不新增方块/贴图。

## 代码地图

依赖方向单向：`voxel ← gen ← mesh ← render`；`core/` 是装配层（可依赖任何层）；
`voxel/gen/mesh/workers/entities` 是 Worker 同构层，**不得 import three、不得自建 Worker**
（唯一入口 `core/worker-pool.js`；唯一白名单是 `mesh/atlas-loader.js`）。

| 目录 | 职责 |
|---|---|
| `src/core/` | `game.js` 装配全部子系统（仓库最大文件）/ `scheduler.js` 任务编排与版本协议 / `worker-pool.js` / `world-editor.js`（所有方块写入的唯一入口）/ `resource-url.js`（资源 URL 唯一权威）/ `perf*.js` |
| `src/voxel/` | `blocks-data.js` 方块声明（→ `block-registry.js` 派生各 table）/ `chunk-column.js` / `world-data.js`（主线程体素唯一权威）/ `constants.js` / `explosion.js` |
| `src/gen/` | `terrain.js`（`generateHeight` / `fillColumn` / 洞穴）/ `noise.js`（biome、`seededRandom`）/ `structure-index.js` / `structures/*`（`apply.js` = 结构层序总入口，`scatter.js` = 撒布唯一权威） |
| `src/mesh/` | `mesher.js`（形状与 UV 的唯一权威：`TEMPLATES`/`FACE_VERTICES`/`FACE_UVS`）/ `lighting.js` / `iso-icon.js` |
| `src/render/` | `render-world.js`（BatchedMesh 三通道发布层）/ `materials.js`（TSL）/ `sun-shade.js` + `hemi-shade.js`（光照标定常数，three-free）/ `ocean*.js` / `shadow-manager.js` / 各实体渲染器 / `audio-config.js`（three-free 清单） |
| `src/entities/` | `entity-manager.js`（动态实体唯一权威 + AABB raycast）/ `zombies` `turrets` `minecarts` `zombie-nests` `dragons` `bosses` `playground`（全部同构无 three） |
| `src/player/` | `player.js` / `physics.js` / `raycast.js`（体素 DDA）/ `place-ray.js` / `view-bob.js` |
| `src/ui/` `src/save/` | HUD / 背包 / 设置面板 / 迷你地图；IndexedDB edits + entities + 进度包编解码 |
| `src/tests/` `tests/` | 浏览器内单测（`test-*.js`，入口 `src/tests/index.html` 逐条 import）/ Playwright spec（`tests/*.spec.mjs`） |
| `tools/` | 烘焙脚本 + 指纹共享模块（`*-fingerprint.mjs`）+ 两道静态门 |

**一次列加载（GEN）**：`Scheduler` 派 `gen` RPC（带 `edits` + `layouts`）→ `world-worker` 里
`fillColumn → carveCaves → applyStructuresToColumn → applyEdits → computeSkylight/Blocklight` →
回传三份 typed array buffer → 主线程建 column → `mesh` RPC 逐 section（`buildSectionMesh`）→
三通道 packed 顶点入 `RenderWorld` 的 BatchedMesh。

**一次方块编辑**：`Player` → `WorldEditor.setBlock()`（唯一写入口，含 no-change / 基岩 / 边界过滤）
→ `WorldData.setBlock`（同步重算单列 skylight）→ `scheduler.remeshSections`（玩家挖放走主线程
快速路径，批量走 Worker）→ `enqueueLight` 异步收敛跨列光照 → `_emit` 发 `block-changed` 给装置 controller。

**`apply.js` 的阶段层序是载荷性的**：阶段 1 地形 → 2.45 浅水高台 → 2.4 高台地带 → 2 JSON 结构 →
2.7 撒布 → 2.75 高台 / 2.76 金字塔 / 2.8 巨树 / 2.85 杜鹃 / 2.9 竞技场 → 2.5 空中结构 → 3 植被。
调换会让「树冠打穿屋顶」「祭坛被广场材质盖回」这类**方块层面看不出因果**的缺陷复活。

## 不可违反的重构红线

1. **数据只有一份权威**：主线程 typed array 体素（`blocks`+`meta`+`blockEntities`）。网格/AO/光照缓存
   全是可重建的派生数据，禁止第二份逻辑副本或「渲染态与逻辑态分离」。
2. **删除预生成**：世界无边界，地形+结构由 seed 确定性生成，存档只存玩家 edits diff。
3. **重计算全部离开主线程**：GEN/MESH/LIGHT 在 Worker 池；主线程只做输入、物理、调度、上传、渲染。
4. **单一 meshing 管线**：面剔除是 meshing 的内部步骤；禁止独立 FaceCulling、consolidation 中间态、
   地形 InstancedMesh、动态↔合并双状态。
5. **发布粒度** section(16³)；BatchedMesh 通道级合批（opaque/cutout/transparent 各一个），
   缓冲耗尽走三级兜底（`unusedVertexCount` → `optimize()` → `setGeometrySize()`）。
6. **体素 DDA 射线**（Amanatides-Woo），禁止对地形 mesh 用 `THREE.Raycaster`。
7. **Worker 池 + 版本协议**：任务带 `(columnKey, version)`，版本不符即丢弃并重新派发；
   禁止为竞态打 epoch/防抖/staging 补丁。
8. **主线程/Worker 同构纯函数**：gen/mesh 核心算法无 DOM 无 three，两条路径共用同一份代码。
9. **WebGPU 唯一后端**：three r185.1 本地 `vendor/three/`（import map），不做 WebGL2 降级。
10. **module worker 不继承 import map**，一律相对路径 import，禁止 import three。
11. **光照**：skylight 垂直不衰减 + 水平 BFS 每格 −1；编辑快路径只升不降（防黑闪）；
    AO/light 的 shade 必须在**顶点阶段**算成 float 经 float varying 传片元（int varying 被强制 flat）。
12. **玩家物理手感**：onGround 自动上台阶（MAX_STEP=1.0，物理瞬时、相机 StepLift 缓动）。

自检四问（任一「是」就停下找统一入口）：引入了第二份权威或新缓存层？把生成期问题推到运行期？
在主线程做了可后台化的重计算？绕过统一管线新开了专属 Worker/子系统？

## 测试分级与门禁

判据不是改动大小，而是**改坏了多久能被发现**（详见 `docs/testing-policy.md`）。

| 级别 | 典型改动 | 要求 |
|---|---|---|
| Tier 1 | 纯函数算法 / 协议 / 数据模型 / 热路径 | **必须 TDD**（RED→GREEN→REFACTOR）+ 门禁 |
| Tier 2 | 物品集合 / 图标表 / 烘焙产物 / 数据契约 | 门禁断言，免 TDD |
| Tier 3 | 文案 / 贴图地址 / alias | 免测试，只跑 `npm run check` |
| Tier 4 | GPU 渲染结果（TSL 在 GPU 求值） | **像素级实测**，不得宣称目视 |

门禁选择：Tier 3 → `npm run check`；Tier 1/2 → 加 `npm test`；改热路径（mesher/materials/render/
scheduler/physics）再加 `npm run bench -- --check`。计划里标「冻结」的数字不符时**停下来报告**，
不擅自改断言或放宽阈值。

调试入口：
- 浏览器内单测 `/src/tests/index.html`，结果在 `window.__MC_TEST_RESULTS__`
  （`{suites:[{tests:[]}], passed, failed, total}`，用例要 `suites.flatMap(s => s.tests)`）；
- 基准页 `/src/bench/webgpu-publish.html`（`window.__BENCH__`）；
- 游戏页暴露 `window.__MC_GAME__` 与 `window.__MC_BOOT__`，Playwright 经此编程驱动（无头无键鼠）；
- 一次性探针 spec 放 `tests/tmp-*.spec.mjs`（已 gitignore，勿提交）。
- URL 开关：`?vd= ?seed= ?style= ?fog=0 ?skybox=0 ?shadows=0 ?res=perf ?chunkpace= ?weather= ?stats=0 ?log=1`
  （完整清单见 `src/ui/settings.js` 的 `resolveSettings` 注释与 `src/main.js`）。

## 高频坑（非显然、会静默失效）

**编辑与数据**
- `WorkerPool.call()` 返回 **`{id, promise}`** 而不是 promise。只判 `typeof then` 会走同步分支拿到
  那个对象（无业务字段）→ 回包静默丢失。写 fake pool 时必须返回同形状。
- 时间基准统一 `performance.now()`，禁止 `Date.now()`（相差约 17 亿毫秒，任何到期判定会恒真/恒假）。
- `WorldData.getSectionView()` 曾经逐格 `Map.get`（5508 次/次调用 × 每帧 64 次派发）是慢帧根因；
  改这里先解析 9 列再逐格取。**量帧只能用 `perf.snapshot().frameMs`**，用 rAF 包的另一个口径恒定偏高。
- 编辑热路径一次 `WorldData.readCell(x,y,z)` 读出 id/meta/entity，别分别调三个 getter（同一换算做三遍）。
- 光照类缺陷的断言必须落在**画面**上：数据层（`col.light`）对、网格层（上传的 packed）旧，两者会分裂。
  诊断顺序 = 整图参考 BFS → 拦截 `uploadSection` 比对 → 截图。

**方块语义**
- `opaqueTable=1` 有**四项**后果：面剔除、AO 遮挡、blocklight 阻断、炮塔 LOS/弹丸阻挡（改玩法）。
  只要面剔除就用 `cloud` 手法（`cullMode:"opaque"` + `opaque:false` + `SAME_TYPE_CULL`）；
  非 box 几何必须显式写 `"opaque":false`，否则转换规则会按 cullMode 误推 opaqueTable=1。
- 判断方块渲染语义读 mc-lite 的 `MaterialManager` + `BlockData`，不能只看本仓 `cullMode`。
- 朝向：台阶/栏杆的 facing→orient 映射**只能用真实 mesher 实测定**（给方块设 orient 读发射顶点
  的 bbox 跨度判断高侧），不能从 `orientation.js` 或 Minecraft 定义推。倒置台阶刻意不复用
  `cobblestone_step_updown`（那个是「颠倒 + 水平镜像」，高侧差 180°）。
- 碰撞类断言必须在两侧实测值之间取阈值（曾写「峰值 < 4」，而自由跳跃本身 3.0 → 注入回退仍全绿）。

**坐标与旋转**
- 实例原点两套口径：mc-lite 几何以**块中心**为原点（`position.set(x+.5,...)`），本仓模板以**块底角**。
  比对上游几何数字时必须 +0.5。
- 从实例矩阵反解旋转用 `atan2(m[8], m[0])`，**不能** `Euler.setFromQuaternion`（`asin` 在 |θ|>π/2 折叠）。
  判「相机歪头」读基向量（`up.y`/`right.y`），不能读 `camera.rotation.x/z`（yaw=π 时是等价表示）。
- 坐标类判据一律非负取模：`wx % 16` 在负坐标返回负值 → 判据恒真。
- 三层 v 方向翻转（BoxGeometry 各面 `vdir` 符号不同 + `TextureLoader.flipY=true` + 皮肤矩形按图左上
  原点写），调试时必须走**真实加载路径**（`DataTexture` 的 `flipY` 与 `TextureLoader` 相反，用它造探针会得出假结论）。
- **Bedrock/Java 骨骼旋转的数值 ≠ 标准右手系的 `Euler(x,y,z,'XYZ')`**（焰魔 v2.58，曾误诊为「设计幅度大」）：
  矩阵是 `Rz·Ry·Rx`，关键帧与 bind **欧拉角逐轴相加**，且 Bedrock 几何 y 与 Java 相反 ⇒ 落到 Bedrock 几何空间必须取
  `Rz(−θz)·Ry(+θy)·Rx(−θx)`（`bake-ignis.mjs` 的 `bedrockRotation` 是唯一入口，飞龙是 bbmodel，不适用）。
  **两侧「数值逐帧一致」证明不了姿态一致** —— 症状（蓄力向身后抡、劈砍变尖刺、躯干后仰）只在比对**世界坐标**时现形：
  用 `tools/ignis-java-reference.mjs` + `test-ignis-bake.js` 的冻结表；动画「看着不对」时先比世界坐标，**不要加衰减补丁**。

**UI 层级**（改任一层必须重核这条不等式）：hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 =
血心 50 < 伤害数字 55 < 设置按钮 60 < 设置面板 70 < 背包 80 < 背包 hover 浮层 85 < toast 90 <
启动 loading 95 < 启动错误遮罩 100。**不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。toast 与浮层都是
`pointer-events:none` → 判「在最上层」只能走像素，`elementFromPoint` 会跳过它们。
面板里「点了没反应」的报告先查这一条。血心与看板同层（常驻信息）；伤害数字高于看板
（可能飘到面板底色上方）、低于一切交互元素。

**渲染与 GPU**
- 阴影只能用 **VSM**：three r185.1 WebGPU 的 depth-compare 路径（PCF/PCFSoft/Basic）会
  `GPUValidationError` → 画面全黑。transparent 必须 cast + receive **双 false**。
- BatchedMesh 的主 pass 与阴影 pass 共用一份 multi-draw 列表 → 每次阴影刷新会让阴影视锥外的几何
  整帧消失（远端闪烁）。守卫在 `render-world.js _installShadowListGuard`，不能换成
  `perObjectFrustumCulled = false`（draw call 涨 3.8×）。
- unlit 材质接阴影**不能把因子乘在最终颜色上**（影区纯黑）：只能乘 skylight 项并给影区地板
  （`SHADOW_FLOOR`），火把照亮的洞穴不受影响。两层 `mix(1, mix(FLOOR,1,shadow), strength)` 的嵌套
  顺序不能反（反了「关阴影」会把全世界压暗一半）。
- 序列帧切帧走 `texture.offset`（WebGPU 后端确认消费）；每个 slot 需独立材质 + 独立纹理 clone，
  `repeat` 要在 `clone()` **之前**设。
- 常驻实例池在零实例时必须 `visible = false`，否则每个 mesh 恒增 1 个 draw call。
- BatchedMesh 的 draw call **不是每通道一次**：每个可见 geometry slot 各发一次（加新几何前别假设 +0）。
- WebGPU canvas 的像素回读必须在 `renderer.render()` **之后**；Tier 4 逐帧读像素要在 rAF 回调内。

**通道容量与预算**
- 判据是 **reserved（= 1.25 × 已用顶点）相对初始容量常量**，不是已用占比。Node 侧估算先 ×1.25。
- 改 `CAPACITY`（`render-world.js`）必须同步 `tests/giant-tree-budget.spec.mjs` 的冻结常量 `INIT`
  —— 曾漏改，该 spec 静默红了六天（`npm run check` 不跑它）。
- 往 cutout 加内容要算账：cutout 每格顶点约为 opaque 实心团的 3 倍（cutout 之间不互相剔除）。
- 极简预算门 = `tests/m3-fullscene.spec.mjs` 的 `gpuVertexBytes < 200 MiB`。

**资源与目录**
- **资源路径只能走 `resourceUrl()`**（`src/core/resource-url.js`），禁止站点根绝对路径（`'/assets/`、
  `'/src/`、`'/vendor/`）—— 仓库挂子路径部署时会全 404，而本机 dev server 恒为根路径所以测不出来。
  HTML 的 import map 无法调函数：`index.html` 写 `./vendor/...`，`src/tests/*.html` 写 `../../vendor/...`。
- `assets/textures/` 被 `build-atlas` **递归扫描** → 任何源图/中间物/logo 放进去都会变成一个巨型 tile。
  烘焙输入放各自的 `assets/<topic>/src/`，UI 素材放 `assets/ui/`。
- 被 node 工具 import 的路径常量（如 `sky-config.js` 的 `SKY_DIR`）保持仓库相对字符串，URL 转换只在消费端。

**确定性**
- `seededRandom` 的 salt 占用必须**程序化扫描**，grep 字面量抓不到 `seed + N` 形式的区间占用。
  已占 1020~1040 段（1028 是被跳过的洞，保守避开）。用错 salt 是静默的确定性污染。
- 结构写入无占用格守卫（`makeColumnSetter` 后写胜，与 mc-lite 先写胜不同；未注册名字**静默 return**
  → 那格变 air）。**写结构类断言不得假设「每个结构都完整」**。

**门禁与测试**
- `src/tests/test-*.js` 必须同时出现在 `src/tests/index.html` 的 import 里 —— 漏注册是
  **测试静默不跑**（全绿假象），`check:data` 的 `[测试注册]` 环节双向钉住。
- Playwright 必须 `channel: 'chromium'`：默认 headless shell 零 flag 拿不到 WebGPU adapter。
  `playwright.config.mjs` 全局 timeout 200s 必须 ≥ 各 spec 自己的等待窗口（`harness.spec` 等 150s）。
- 计时型 spec 在高负载下会贴线 flaky（`m1-acceptance` 放挖 p95、`m3-rain` 截图差分、
  `weapons-world-edit` 计数、bench 的 frameP95）。**判据看交替对照的分布，不看单次红绿**（不改阈值）。
- 写像素类断言必须**同时钉上下界**（只钉「变暗」抓不到「纯黑」），且先测同状态重复截图的噪声底。
- 断言前先在真实数据上跑一次打印实际值 —— 多处踩坑都是「断言描述想象中的世界」。
- 对照脚本与被测代码**只差一个变量**：两侧共用同一个错误假设会得出「两者一致」的假结论。
- `check:arch` 的 `ISOMORPHIC_DECLARED` 正则**扫全文（含注释）**：在 `core/game.js` 这类装配层文件里
  写「同构层（无 DOM 无 three）」这类**说明性**字样，会让该文件被误判成自声明同构模块 →
  架构门十几条误报（`import three` + 每处 DOM API）。描述别的模块是同构层时改措辞为
  「属 Worker 同构层（红线 8）」，不要照抄正则命中的原字样。

## 具体子系统的已知陷阱 —— 按路由表查

每个 Epic 都有几十条「实测标定的常量 + 反向验证教训」只存在文档里（**不要凭直觉改它们，也不要凭直觉
“补齐”看起来缺失的分支**）。碰到下面这些区域，先读对应文档：

| 要动的东西 | 先读 |
|---|---|
| 地形/高台地带/浅水高台/祭坛/拱桥/竞技场/金字塔/中世纪船 | 各自的 `docs/superpowers/specs/<日期>-*design.md` + roadmap 同版本行 |
| 光照 / 阴影 / 天空 / 雾 / 水面 / 色温 | `2026-10-13-sun-shadow-map-design.md`、`2026-10-20-sun-shading-and-skybox-design.md`、`2026-10-24-lighting-realism-design.md` + roadmap「活跃约束详情·光影真实感 / 渲染与容量」 |
| 结构撒布 / 巨树 / 杜鹃树 / 植被 | roadmap「结构撒布」「巨树」「树叶与镂空遮挡体」段 + `2026-10-23-giant-trees-design.md` |
| 龙 / Boss / 火球 / 实体伤害 | `2026-11-03-altar-dragon-design.md` + `2026-11-03-dragon-boss-ai-design.md` + roadmap v2.41~v2.48 |
| 丧尸 AI / 寻路 | `plans/2026-11-04-zombie-pathfinding.md`、`2026-11-02-zombie-obstacle-avoidance-design.md`、`2026-11-04-zombie-model-rebuild-design.md` + roadmap v2.46~v2.50 |
| 矿车 / 装置（巢穴、炮塔、创造台） | `2026-09-30-minecart-design.md`、M7/M8/M9 spec + roadmap「方块锚定装置」段 |
| 放置 / 交互 / 玩家物理 | `2026-10-30-place-nearest-first-design.md`、`2026-10-25-player-flight-design.md` |
| 面板 / HUD / 小地图 / 音效 | roadmap「面板与 UI」「渲染分辨率档位」段 + `plans/2026-10-29-minimap.md` |

**跨 Epic 但值得背下来的几条**（全部是静默失效型）：

- 岩阶族的东西（台阶 AO、倒置台阶、栏杆臂）的**形状权威只有 mesher 的 `TEMPLATES` / `STEP_BOXES`**，
  与 `orientation.js`（放置期朝向）是两套语义，不得互推。
- 台阶亚体素 AO：纳入集合 = `STEP_BOXES` 的键（**半砖与装饰几何刻意不纳入**），采样点
  `顶点 + 0.25×(法线+两切向)`，第 4 样本 `front` 不能删 —— 改任一项都要跑 `test-mesher` 的四条台阶用例。
- `SHADOW_FLOOR ≡ SUN_AMBIENT`（同一语义两个名字）；`SUN_INTENSITY` 必须从 `noon.sunDirection`
  派生，使 `SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0`（= 「正午顶面亮度与加方向光之前相同」）。
  改任何风格的太阳方向后必须重算它，否则这条零回归不变式静默失效。
- `uSunStrength = 0` 必须让 `sunTerm ≡ 1`（而不是退化成 `SUN_AMBIENT`）；半球环境光 `HEMI_GROUND`
  与太阳无关，关方向光时仍生效。
- 体素材质是 unlit：面的朝向差异只能来自 packed 的法线位，不要试图用 `skyDim`/`blockBoost` 这类
  全局乘数调出「迎光面亮、背光面暗」。
- 两套「能否被穿透」的判定刻意不同：视线/炮塔 LOS 用 `solid && opaque`（玻璃透得过），
  火球遮挡只看 `solidTable`（玻璃挡得住）。混用任一侧都会撕裂。
- 火球爆炸走 `_applyExplosion`，**不走 `explodeTnt`** —— 后者的按格去重集合会被污染，导致之后同格
  放的 TNT 静默不爆。
- 所有玩法服务在 `EntityManager.update` 之外改 `state.position` 时，必须显式 `reindexColumn(id)`，
  否则实体停在旧 column 索引上不自愈。
- 击退（剑砍中）的**权威位移必须瞬时**，观感滞后只许落在渲染位置（`render/knockback-ease.js`，
  与上台阶只缓动渲染 y 同一分工）。触发必须走服务层的**显式上报告诉实际位移**，不能用
  「渲染位置与物理位置差得多就补间」—— 丧尸 AI 每帧 0.02 格与 0.9 格击退分帧后同一量级，阈值两侧都会误伤。
- 「绑定在某个 column 的派生 controller」的装配必须早于 `_waitForColumn`，否则首个 ready 回调
  拿不到 service（形态：装置不工作，而锚点、索引、方块全对）。多格结构的 origin 用命中格
  `blockPos`，单格实体（矿车）用 `prevPos`。
- 玩家位置/设置的持久化字段写进既有 `meta` 行并 **merge** 后整行 put；`_discardEdits()` 必须把
  「位置写盘」置为未启用，否则换世界/清档后 `beforeunload` 会把旧世界坐标写回新世界。
- 翻转一个设置的**默认值**时要带 `settingsVersion` 迁移：旧存档里那个值是「默认值为旧值时顺带写下的」，
  只改 `DEFAULT_SETTINGS` 对所有点过面板的人都不生效。新增字段（旧存档没有它）则不需要迁移。

## 生成物（不要手改）

`assets/atlas.{png,json}`、`assets/icons-atlas.png` + `icons.json`、`assets/structures/*`（烘焙得到的
那几个）、`assets/{zombie,dragon,turret,giant-trees,azalea-trees,sky/night}/` 里的产物、
`assets/textures/procedural/*`、`docs/m3-baseline.*`（冻结基线，`npm run bench` 不带 `--check` 会自动
重写它 —— 诊断后要 `git checkout` 恢复，提交它等于静默放宽门禁）。

每个烘焙产物都有伴随 JSON 指纹 + `check:data` 的环节守住过期。**已知盲区：只改烘焙算法而不动参数时
指纹不变** → 靠产物契约测试与 Tier 4 兜住。

## 沟通与提交

- 设计取舍引用设计文档章节号；改动后附验证证据（命令输出、帧时、draw call），不凭感觉宣称通过。
- **提交必须等明确指令**，Conventional Commits（`feat:`/`test:`/`chore:`/`perf:`）。
- `origin` 配了**双 push**（GitHub + 内部 GitLab），串行推送，任一失败整体报错而另一个可能已推成功
  → 重跑即可，不要改 remote 配置绕开；fetch/pull 只走 GitHub。
- 诊断 bug 不猜：先复现、读实际数据（light 值/扫描线/队列状态）定位根因再改。
  出现机制上不可能的数值时先怀疑测量方法。
- 沙箱禁止 `rm` 时用 `mv` 清理；临时脚本放 `/tmp` 或项目内并即时删除，不要用 `.tmp-*` 通配符批量删。
