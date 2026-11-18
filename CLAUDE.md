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
音效与 BGM / 大竞技场 + 废弃堡垒移植 / 末影守卫 Boss）。**具体做到哪一步、每版改了什么，一律查 `docs/roadmap.md` 的版本表。**

**下阶段 TODO：丰富地图的多样性。** 选型依据（哪些地形能力可从上游 Tectonic 抽离、拿过来的真实代价、
哪些不要碰）已调研成文：`docs/tectonic-terrain-migration-survey.md`。**动地形生成前先读它** ——
尤其是与 `genP95` 冻结预算、红线 1（水面遮罩 TSL 同构）、40 个 `generateHeight` 消费方的冲突实测。

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
npm run turretop | zombieskin | dragon | nightsky | validate:weapon-assets
npm run stonebricks    # 原版石砖三变体 + 紫珀方块贴图（v3.19；之后要 atlas + icons）
npm run guardian       # 末影守卫（Java 模型 → 20 骨骼/24 盒/4 条攻击动画 + 眼睛层合成）
```

⚠️ **`npm run turret`（装甲贴图烘焙）已随 v3.14 删除** —— 炮头改走三档冷灰金属颜色渲染，
零贴图。炮塔只剩 `npm run turretop`（几何 + 逐顶点 `tone` 档位）。

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
| `src/entities/` | `entity-manager.js`（动态实体唯一权威 + AABB raycast）/ `zombies` `turrets` `minecarts` `zombie-nests` `dragons` `ignis` `guardian` `bosses` `playground`（全部同构无 three） |
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
2.7 撒布 → 2.75 高台 / 2.76 金字塔 / 2.8 巨树 / 2.85 杜鹃 / 2.9 竞技场 / 2.93 大竞技场 /
2.94 废弃堡垒 → 2.5 空中结构 → 3 植被。
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
- **地下结构的「空气格」必须写进烘焙产物**（废弃堡垒 v2.89）：nbt 里房间是**显式 air**，
  而 `rasterizeStructure` 只写产物里的格 ⇒ 不写空气则 `fillColumn`+`carveCaves` 的天然岩层
  会填满整个地牢（22.6 万格白搬）。做法：palette 加 `air` 条目（id=0、`cullMode:'none'`
  不渲染任何面），`setBlock(…,'air')` → `blocks[idx]=0` 清空格。**零运行期代码改动**。
  ⚠️ 失效形态是静默的：格数/类型/指纹全对，只有挖下去才发现 ⇒ 必须用**内容级判据**
  （air 格数）钉住，指纹拓不到。
- **产物 bbox ≠ footprint bbox**（废弃堡垒 v2.89）：写进产物的空气会把包围盒撑大
  （实测 106×63×108 → 107×63×110）。AABB 早退 / 避让 / 压制 / 干燥判据一律用**非空气 bbox**
  （= footprint，HALF_X/HALF_Z），用产物 bbox 会各多算 1 格。
- **从 mod 素材看「柱」不能只看外观**：`end_stone_pillar` 在 mod 里是 `cube_column`
  （顶/底 `_top` + 四侧 side）= **完整正六面体**，不是细柱。用户口述「半粗石柱」是视觉误读，
  必须读 mod 的 `models/block/*.json` 定几何（本仓按 `geometry:'box'` + 六面贴图数组烘焙）。

**坐标与旋转**
- 实例原点两套口径：mc-lite 几何以**块中心**为原点（`position.set(x+.5,...)`），本仓模板以**块底角**。
  比对上游几何数字时必须 +0.5。
- 从实例矩阵反解旋转用 `atan2(m[8], m[0])`，**不能** `Euler.setFromQuaternion`（`asin` 在 |θ|>π/2 折叠）。
  判「相机歪头」读基向量（`up.y`/`right.y`），不能读 `camera.rotation.x/z`（yaw=π 时是等价表示）。
- 坐标类判据一律非负取模：`wx % 16` 在负坐标返回负值 → 判据恒真。
- **锚点搜索的「方向」是载荷性的，照抄另一侧的判据会 8/8 seed 全返回 null**（废弃堡垒 v2.89）：
  大竞技场在城东，城市净距判据是 `wx - HALF <= city.maxX + CLEAR → 拒绝`；废弃堡垒在城西，
  必须是 `wx + HALF_X >= city.minX - CLEAR → 拒绝`。第一版照抄了城东那行 ⇒ 每个候选都被
  city 判据拒掉，9ms 就退出（结构永不生成，且**没有任何报错**）。同理瞬移落点：城东结构落在
  **西**缘外、城西结构落在**东**缘外（都是「靠 City 的那一侧」），照抄 `toBeLessThan` 会恒红。
- 三层 v 方向翻转（BoxGeometry 各面 `vdir` 符号不同 + `TextureLoader.flipY=true` + 皮肤矩形按图左上
  原点写），调试时必须走**真实加载路径**（`DataTexture` 的 `flipY` 与 `TextureLoader` 相反，用它造探针会得出假结论）。
- **Bedrock/Java 骨骼旋转的数值 ≠ 标准右手系的 `Euler(x,y,z,'XYZ')`**（焰魔 v2.58，曾误诊为「设计幅度大」）：
  矩阵是 `Rz·Ry·Rx`，关键帧与 bind **欧拉角逐轴相加**，且 Bedrock 几何 y 与 Java 相反 ⇒ 落到 Bedrock 几何空间必须取
  `Rz(−θz)·Ry(+θy)·Rx(−θx)`（`bake-ignis.mjs` 的 `bedrockRotation` 是唯一入口，飞龙是 bbmodel，不适用）。
  **两侧「数值逐帧一致」证明不了姿态一致** —— 症状（蓄力向身后抡、劈砍变尖刺、躯干后仰）只在比对**世界坐标**时现形：
  用 `tools/ignis-java-reference.mjs` + `test-ignis-bake.js` 的冻结表；动画「看着不对」时先比世界坐标，**不要加衰减补丁**。
- ⚠️⚠️⚠️ **SkinnedMesh 的顶点必须是「绝对模型坐标」，不能用骨骼局部坐标**（守卫 v2.93 实测）：
  skinning 公式 `bindMatrixInverse · (bone.matrixWorld · boneInverse) · bindMatrix · p`，
  **bind 姿态下 `bone.matrixWorld · boneInverse ≡ I`** ⇒ **顶点原样返回**。
  skinning 只做「相对 bind 的**形变**」，**不做「骨骼局部 → 模型空间」的摆放**。
  用局部顶点的形态：24 个盒全堆在原点 —— 用户描述是「**腿没分开 / 脑袋长到肚子上 / 手臂进入身体**」
  （实测最大误差 **3.29 格**、两腿间隙 **−0.5**、正面宽高比 **0.877** 而不是 1.26）。
  修法：烘焙时顶点**预乘该骨骼的 bind 世界矩阵**（`vertexConvention: 'java-model-absolute'`）。
  焰魔的 Bedrock 顶点本来就是绝对的，所以它没这个问题 —— **不是 bind 时序问题**
  （`bind()` 内部已 `updateMatrixWorld(true)` + `calculateInverses()`，两种时序结果逐位相同）。
  ⚠️ **离线轮廓光栅化对这类缺陷零判别力**（它直接乘世界链，绕过了 skinning）：
  判据必须落在 three 自己的 `SkinnedMesh.applyBoneTransform` 上（`test-guardian-skinning.js`），
  且要钉**解剖学关系**（腿间隙/头高/臂位置）而不只是顶点数。
  ⚠️ 探针里 `mesh.bind()` 必须在**bind 姿态**下调用（先摆回 bind → bind → 再摆到目标帧），
  否则 boneInverses 把动画姿态当 bind，造成 3.5 格假失配。
- **Java 与 Bedrock 的顶点坐标系不同，渲染器公式也不同**（守卫 v2.91）：Java `addBox` 的 origin 是
  **骨骼局部**坐标，Bedrock 是**绝对模型**坐标。本仓守卫取口径 A（保留局部顶点 + 仅 `y→−y`）
  ⇒ `localPosition = pos/16`（y 取反）、`pivot` 恒零、渲染器 `bone.position = localPosition + delta.pos`。
  **照搬焰魔的 `pivot − R_current·pivot + delta` 会把模型炸成碎片**（pivot 为零时它退化成「丢掉 localPosition」），
  而骨骼数/盒数/顶点数/指纹全对。哨兵：`root.localPosition === [0,−1.5,0]`（`check:data` 钉住）。
  ⚠️ **`feetOffsetY` 是「相对脚底」的量，会随它变**：核心盒 `center[1]` 同理 —— 改了烘焙器就得重算两者。
- ⚠️⚠️ **box UV 铺开：Bedrock 与 Citadel（Java）不是同一套表，不得互照**（守卫 v2.92 实测）：
  把 `bake-ignis` 的 `boxUVRects` 照搬到守卫 ⇒ **576 角中 480 个 UV 错**（±X / ±Z / −Y 全错，+Y 恰好对），
  而骨骼数/盒数/顶点数/索引数/UV 值域/指纹**全部通过** —— 只有画面能看出（躯干亮面朝下、
  护甲渐变上下颠倒、侧面整体错位）。权威在 `tools/citadel-box-uv.mjs`，判据在 `test-guardian-uv.js`（逐角）。
  三条非显然的子坑：
  · **mirror 的 `positionsIn[j] ↔ positionsIn[i-1-j]` 搬的是整个 `{position, uv}` 元素**
    ⇒ 「角位置↔UV」配对**不变**（只改绕序）。**只对调 UV 会把 7 个 mirror 盒上下翻转**（168 角）；
    mirror 对 UV 的真正影响**只来自** `swap(x, f)`。
  · **面法线必须由角位置推，不能查静态表**：`swap(x,f)` 让标为 EAST(+X) 的四角落在 x **最小**侧
    ⇒ 静态表会让 7 个 mirror 盒共 80 角失配。
  · **按角位置查 UV 必须先按法线筛面**：每角被 3 个面共用 ⇒ 24 顶点里同一位置出现 3 次、UV 各不同，
    在全量里 `find` 会取到别面的 UV（实测 304 个假失配）。角匹配容差取 **1e-6**（负 inflate 盒的浮点往返差 ~1e-16）。
  ⚠️ **Citadel 源码的 8 角变量名后缀与声明顺序差一**（`...vertex7` 是第 1 个角）—— 手抄索引极易错，
  用程序化提取（本次调查手抄连错 5 版）。
- **旋转约定已验证无缺陷，不要“顺手修”**（守卫 v2.92）：口径 A（顶点翻 y + localPosition 翻 y +
  `Rz(−z)Ry(+y)Rx(−x)`）与「整条链在 Java 空间全正号算完再乘 `F=diag(1,−1,1)`」**逐点等价**
  （bind/strongR/stomp/uppercut 四姿态 576 顶点最大差 **0.000000**）。形态不对时先查 UV，别动旋转。
- **Java `move` 关键帧的 y 符号**：Java y 向下，`move(leg,0,−9,−9)` 是**抬腿** 9px
  ⇒ 产物 `pos.y = +0.5625`。转反的形态是「出招时身体往反方向纩」，而计数类判据全对。
- **动画帧数取「关键帧 tick 合计」而不是 `Animation.create(n)` 的声明值**：守卫上勾拳声明 100
  但关键帧只到 **90** ⇒ 照声明值烘焙会多出 0.5s 静止尾巴。
- **解析 Java 角度时 `Math.toRadians` 的后缀正则必须大小写都认（`/i`）**：守卫混用 `5f` 与 `32.5F`，
  而焰魔素材全大写。只写 `F?` 时小写那批解成 **null** → 四元数 NaN（JSON 落 null），
  实测 1415/2730 个四元数报废而骨骼数/帧数/指纹全对 ⇒ 靠**归一化断言**拓。
- **程序化 idle 的「空姿态」不会触发过渡器切换**（守卫）：移动→静止时 target 从非空变空 Map，
  而来源 key 两边都是 'idle' ⇒ 不走淡入 ⇒ 那几根骨骼从输出里消失 ⇒ **永远冻结在最后一个摆臂姿态**。
  渲染器必须每帧把整副骨架（位置**和旋转**）复位到 bind 再写本帧驱动的骨骼。
  （焰魔没这问题：它的 idle 是烘焙片段，始终驱动同一批骨骼。）

**UI 层级**（改任一层必须重核这条不等式）：hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 =
血心 50 < 伤害数字 55 < 设置按钮 60 < 设置面板 70 < 背包 80 < 背包 hover 浮层 85 < toast 90 <
启动 loading 95 < 启动错误遮罩 100。**不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。toast 与浮层都是
`pointer-events:none` → 判「在最上层」只能走像素，`elementFromPoint` 会跳过它们。
面板里「点了没反应」的报告先查这一条。血心与看板同层（常驻信息）；伤害数字高于看板
（可能飘到面板底色上方）、低于一切交互元素。

**渲染与 GPU**
- ⚠️⚠️⚠️ **反射/阴影类额外 pass 必须在主 `renderer.render()` 之前跑**（水面倒影 v3.17 实测）：
  把 three 的 `reflector()` 挂在水面材质上让它**自动触发**时，它在 **transparent 队列末尾**才跑，
  而 BatchedMesh 的 instance 索引走 `_indirectTexture`（**GPU 纹理**）、一帧内**最后一次写入胜出**
  ⇒ 主 pass 的 `drawIndexed` 执行时读到反射相机的索引表 ⇒ **地平线以上整片天空撕成黑多边形**
  （近黑占比 **1.26% → 11.66%**），而 draw call / 三角数 / 帧时 / uniform 值**全对**。
  **三条假修法已实测排除，勿重试**：① 快照/恢复 multi-draw 列表（v1.46 阴影那套）——
  主 pass 已先 draw 完，快照时机不对；② 改 `renderOrder`（1→99）—— blackTop 逐位不变；
  ③ 改 `bounces` true/false —— 同样撕。**正解**：`updateBeforeType = NONE` + 装配层在主 render 前手动调。
  隔离手法：只加 target / 换常量色 / 采样但不跑 pass 三档均不撕，挂 opaque 材质不撕 ⇒ 锁定是**时机**。
- ⚠️⚠️ **水面加倒影必然提亮水面，「降强度」治不了**（v3.17）：固定掩膜均值实测
  **纯倒影 luma 185.9 = 天空亮度**、无倒影水面 127.4 ⇒ 反射亮天空就会把水抬白（物理正确，
  但撞用户四轮标定的冻结色阶 108~124）。强度扫描 0.5→155 / 0.15→137 / 0.08→133，
  要入带得压到几乎 0 = 倒影没了。**正解是新增「水面吸收」反射率**（水面不是理想镜面）。
  ⚠️ **吸收率必须随环境亮度减弱**：反射 RT 里的世界**已是夜景**（吃 `uSkyDim` + night 立方图），
  按白昼标定的吸收率再乘一次 = 双重压暗 ⇒ 固定吸收率时 TINT 0.18~0.30 扫下来 **night 恒 65~69**
  （下界 70，怎么调都出不了带）。有效吸收率按 `1 − 均值(uWaterTint)` 向 1 回升后 night → **73**，
  而晨/午 tint 中性 ⇒ 回升项 ≡0 ⇒ 那两档逐位不变。
- ⚠️ **「水面在不在视野里」不能用包围球判**（v3.17）：水面是 800×800 巨平面且**每帧跟随相机**，
  它的包围球**永远**与视锥相交 ⇒ `frustum.intersectsSphere` 恒真、门控形同虚设（实测 gateSkip 恒 0）。
  必须用**相机高度 + 俯仰**这两个真实自由度（`reflectVisible`）。
- ⚠️⚠️ **量额外 pass 的成本必须绕开 vsync**（v3.17）：rAF 下 120fps 锁帧会把 +0.9ms 的 GPU 成本
  掩盖成「帧时一点没变」。正解是**连续同步 `renderer.render()` 压测**取均值。
  另两个探针坑：① 包 `node.updateBefore` 得 `renders=0` 却看到画面变了 —— three 在 build 期已绑定
  原函数，**「零成本」是假象**，要包 `renderer.render` 才量得到；② `texture(node.value, …)` 捕获的是
  **占位 RT**（`updateBefore` 每帧把真 RT 写进 `node.value`）⇒ 画面只变暗没有倒影，
  正解是直接把 `ReflectorNode` 当纹理节点用（它本身就是 TextureNode，自带正确 UV）。
- ⚠️ **降反射 RT 分辨率几乎不省钱**（v3.17 实测）：0.125 与 0.5 只差 **0.1ms** —— 成本在
  反射 pass 的 **draw call 数**（vd16 发 1546 次），不在像素数。⇒ **朦胧靠 mip、省钱靠节流**
  （每 2 帧刷把 vd16 的 +0.93ms 降到 +0.36ms）。把倍率往下压是无效优化，只白损失倒影形体。
- ⚠️ **用众数峰量「参数敏感性」会得出假结论**（v3.17）：强度 0.5→0.18 时众数 luma 只从 160 降到 142，
  看着「几乎不敏感」——那是直方图**跳档**（不同强度下选中不同簇）。改**固定掩膜均值**
  （用基准帧选像素、两侧量同一批）后严格单调：155.4 / 146 / 137.5 / 133 / 127.4。
- ⚠️⚠️ **`vec3(new THREE.Color(hex))` 在 WebGPU 后端输出纯黑且零报错零警告**（炮塔三档色调 v3.14 实测）：
  装甲 6 部件**整片消失**，而 tone 属性/长度/值域/冻结表/材质无 map/有 colorNode/集合关系式/指纹
  **全部通过**。根因：`vec3` 单参数走「转成 vec3」路径，而 `getValueType(Color)` 返回 `'color'`
  不是 `'vec3'`（`three.webgpu.js:1146`）⇒ 转换拿不到分量。**正解：显式拆分量 `vec3(c.r, c.g, c.b)`**
  （`color(hex)` / `uniform(Color)` / `vec3(...C)` 也都可用）。逐写法实测非黑像素数：
  `vec3(Color)` **0** / 其余四种均 **10455**。⇒ **凡新增 TSL 常量色必须配像素实测**，
  节点构造类判据对这类缺陷零判别力。
- ⚠️⚠️ **多档着色的像素亮度判据对「分类退化」与「色值全等」都零判别力**（v3.14 负向验证实测）：
  三个取样面**法线不同**，即使 tone 全相同或三档色值全等，N·L/环境/菲涅尔仍造出
  亮度差（实测顶−侧 24.6 / 侧−底 29.5，均 >20 ⇒ 仍绿）。必须另加两道：
  （a）**不依赖光照的内容级判据** —— 从 GPU 上传的几何属性读三档分布比冻结表；
  （b）**同法线单变量对照** —— 把同一个面的 tone 依次改 0/1/2（几何/相机/太阳全不动），
  色值全等时三个读数逐位相同。基线实测差 28.59/24.48。
- ⚠️ **多档色调部件的「关方向光后是均匀色」判据不成立**（v3.14）：单色炮管关光后 p90==median，
  而三档装甲即使关掉方向光，三档基色仍不同（实测差 23.3）—— 那是正确行为。
  装甲侧要钉「max−p90 < 3（无超出三档的高光尖）」+「p90−median > 5（层次仍在）」。
- ⚠️ **「高光随太阳方向变」不能只看 p90**（v3.14）：大平面集合（颊舱）换太阳方向时高光带位置
  滑动但 p90 几乎不变（187→186.7），而 median 差 36.7；曲面（炮管）p90 差 7。
  取 **median 与 p90 的最大差**，两类几何才有判别力。
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
- ⚠️ **「新方块必须是数组最后一项」这类断言会被下一次正当追加推翻（v3.19）**：
  真意图是「旧方块的 id 不得位移」⇒ 钉**绝对下标**（如 bush_grass ≡ 154）+ 「新增项在它之后」，
  而不是钉「它是最后一项」。同形坑：背包槽数类断言在 `test-inventory-ui.js` 里还有第二处
  （「空槽不列出」用例的 145/144/143）—— **该文件不在 Node 白名单**（需 DOM），
  只跑 `run-unit-node` 拓不到它 ⇒ 改方块数后必须跑一次 `tests/unit-fast.spec.mjs`。
- ⚠️⚠️ **末尾追加方块不得清档（v3.19）**：`registry.fingerprint()` 是「名字有序清单」的哈希，
  在 `BLOCKS` **末尾追加**时既有 id 逐位未变（旧 edits 完全可读）而指纹会变
  （实测 155→159 项：`fc6212f5 → 16d99151`）⇒ 旧判据（全等）会白白清掉玩家手工建造。
  正解：meta 行记 `blockCount`，用 `registry.fingerprintOfPrefix(oldCount)` 判「旧清单是当前清单的前缀」。
  **中间插入/删除/换序仍必须清档**（前缀指纹会变，单测逐条钉）；旧存档无 `blockCount` → 回落全等口径。
  哈希算法只得一份（`fingerprint()` 转调 `fingerprintOfPrefix(count)`）。
- ⚠️⚠️ **从放大图还原 16×16 贴图必须带「众数一致性」自检（v3.19）**：用户给的 512×512 图
  不透明 bbox 是 `[25,486]²`（462×462，每 texel **28.875px 非整数**）。origin/span 取错时
  产物仍是「16×16 的紫色图」，**尺寸/色数/均值都可能看着合理**而图案整体错位。
  判据 = 逐 texel「中心取样色 == 该区域不透明像素众数」（实测 0/256 不符，区域纯度 98.29%）。
  ⚠️ **单测里用整数 step 造「错一格」拓不到**（step=8 时 origin+4 仍是每格正中心，分区跟着平移）
  ⇒ 要用**奇数 step** 造半格漂移。
- ⚠️ **「等色重映射」类烘焙要钉图案分区签名，不能只比色数（v3.19）**：blockrender 的 vanilla
  贴图与 wiki 现版渲染图**图案逐格一致、色板差一层**（mossy 的 `8b898b` vs `888688`）。
  反解口径：wiki 300×300 等轴测图的**顶面**三角 `tv=(148,0) / rv=(282,66) / lv=(14,66)`
  （实测拟合；换成「看着对」的 (150,2)/(284,76)/(16,76) 会让每个源色映到 9~24 个渲染色）。
  判据两条：① 每个源色**只能映到一个**渲染色（否则 throw）；② 重映射前后 `patternSignature` 逐格相等。
- **资源路径只能走 `resourceUrl()`**（`src/core/resource-url.js`），禁止站点根绝对路径（`'/assets/`、
  `'/src/`、`'/vendor/`）—— 仓库挂子路径部署时会全 404，而本机 dev server 恒为根路径所以测不出来。
  HTML 的 import map 无法调函数：`index.html` 写 `./vendor/...`，`src/tests/*.html` 写 `../../vendor/...`。
- `assets/textures/` 被 `build-atlas` **递归扫描** → 任何源图/中间物/logo 放进去都会变成一个巨型 tile。
  烘焙输入放各自的 `assets/<topic>/src/`，UI 素材放 `assets/ui/`。
- 被 node 工具 import 的路径常量（如 `sky-config.js` 的 `SKY_DIR`）保持仓库相对字符串，URL 转换只在消费端。

**丧尸行为层（v3.11，全部是静默失效型）**
- ⚠️⚠️ **「离墙太近就退开」的几何判据没有判别力**（实测推翻直觉）：贴墙滑行与 L 形墙角的
  侧向净空**逐位相同（都 0.60 格）**，而 1 格宽门洞只有 **0.10** ⇒ 任何「净空小于阈值就后退」
  都会让丧尸**不敢进门**。「该不该退」只能由**时间维度（走没走动）**判定。
- ⚠️⚠️ **卡住判据必须带「到达门」**（`ZOMBIE_BEHAVIOR.arriveDistance`）：丧尸**成功追到玩家
  身边后本来就零位移**（贴身时 `steerIntent` 判 blocked）。没这道门 ⇒ 把「追到了」误判成
  「卡住了」⇒ **每只追上玩家的丧尸都开始后退**（实测开阔地 191 帧误触发）。正常抵达距离
  恒 **0.48~0.67**、真卡死 **11.59**，门取 1.5。它要写在**状态机入口**（三个信号之前），
  只写在信号 A 里则 B/C 仍会在贴身时误触发。
- **转身限速只能接 `_applyIntent`，不得接 `setIntent`**（与 v2.40「避障探针只能接 `_applyIntent`」
  同一条边界）：后者是通用意图写入口，物理用例/调试代码直接下令，限速长在里面会偷换
  「想让它朝哪就朝哪」的语义。dt 用 `aiPeriod`（0.05s）**不用帧 dt**（它由 20Hz 导航驱动）。
- **行为层的 `nowMs` 必须由 `update()` 一路转发**：不转发时 `_stepNavigator` 落回
  `performance.now()`，与单测的仿真时间**混用两个时基** ⇒ 滚动窗口永铺不满、卡住判据恒不成立
  （纯函数全绿而接线完全失效）。同理：**单测里循环调 `update()` 必须同时推进 `nowMs`**，
  否则 N 拍在同一毫秒内跑完 ⇒ 起步加速因子恒 0 ⇒ 速度永远起不来。
- **速度包络只乘导航分量，排斥力全额叠加**；乘到「导航+排斥力」合成向量上会把排斥力一起缩小
  ⇒ 20 只同点生成散不开。**转向减速每拍独立算，不得累乘**（累乘会让丧尸在连续绕行中越来越慢）。
- **写「倍率不累积」类断言要用绝对值，不能用比值**：比值会约掉衰减（实测：注入「lastDir 只设一次」
  后倍率 0.999→0.874→0.749→0.699 逐拍下滑，而比值判据仍全绿）。且**用例不得自己写 `b.lastDir`**
  —— 那会掩盖「生产代码是否每拍更新它」这个被测行为。
- **判「replan 真的清了缓存」不能用 `cachedPathOf(id) === null`**：不可达场景的 `_path` 本就是 null
  ⇒ 清与不清都读到 null（恒真）。用 `pathCache.debugState().size === 0`。
- ⚠️⚠️ **`backoff` 必须有硬超时，两个「自然」退出判据在封闭死胡同里会同时失效**（v3.11b 用户实玩）：
  ① 「退够目标距离」—— 口袋里退 1.27 格就撞墙，`walked` 永远卡在 1.268 < 1.5；
  ② 「本拍没动 ⇒ 撞墙」—— `steerIntent` 把撞墙意图修成**沿墙侧滑**，每拍都在动（vx ±0.66 交替）。
  实测 backoff 持续 **27.13s**、占 94% 帧，永不 replan/wander ⇒ 用户看到「一群丧尸卡在胡同里循环」。
- **后退要「面朝玩家倒着退」**（用户明确要求）：行为层 backoff 相位给 `faceYaw`，`_applyIntent` 拿它当限速目标。
  ⚠️ **yaw 覆写判据只能与 `cur.state.yaw` 比**：`setIntent` 已先把 yaw 写成速度派生值（后退时 180°、侧滑时 ±60° 摆），
  用 `limited !== targetYaw`（一步到位时跳过写入）或 `limited !== prevYaw`（结果等于旧朝向时跳过）**都会把脏值留下**，
  实测两种写法都仍单帧跳 180°。这条我改了两次才对。
- **朝向类判据要跳过转身过渡段**：540°/s 转 180° 需 0.33s，进入 backoff 首帧本来就背对；
  实测残留背对帧全在 ≤0.1s 内且角度单调收敛 ⇒ 判「稳定段（>0.5s）不得背对」，不是从第一帧就要 0。
- ⚠️⚠️ **「N 轮失败后进入某状态」的功能必须直接钉那个状态真的出现过**（v3.11 final review 实测）：
  `behaviorPhases.hesitate/backoff > 0` 全绿，而 **wander 从未发生**（40s 相位 wander=0、failCount 恒 0）。
  根因：replan 结算紧跟 backoff，backoff 自己刚走 1~2 格 ⇒ 滚动窗口仍显示「在动」⇒ 误判「有路」⇒ 计数归零。
  ⇒ **「有没有路」要问 A\* 的 `step.reachable`（几何可达性），不能问「这几秒动没动」**；
  同理 wander 的退出判据**不得叠 `!stuck.stuck`** —— 它自身小范围踱步 ⇒ 净位移天然 <0.35 ⇒ 永远出不来。
- ⚠️ **`cruiseScaleMin` 不被既有 12s 绕墙 E2E 守住**（实测 0.92→0.70 仍 PASS）：那个探针量的是
  「**全程恒定倍率**」，而真实包络是正弦漂移×起步×转向，只在波谷瞬时接近下界。调它要自己重测。

**丛林要塞（v3.13，离线 jigsaw 拼装 + 整形，全部静默失效型）**
- ⚠️⚠️ **jigsaw 连接口判据是 `target === 'connection'`，不是 `name`**（name 恒为 `minecraft:empty`）。
  写错 ⇒ 8/8 seed 只拼出 **1 件**（center_room）且**无任何报错**。
- ⚠️ **两条 PRNG 流必须分开**：拼装器用 **LCG**（冻结的 193 件由它产出，换 mulberry32 → 38 件），
  石砖族变体用 **mulberry32**。共用一个函数名会让 mossy_stone 静默漂移 **268 格**
  （30235 vs 30503）而**总数 60692 不变** ⇒ 极难发现。
- ⚠️⚠️ **空气分层用「同 y 层水平洪泛」，竖直不传播**。四档实测（空气总 29803）：
  全写 29803 / 上方顶盖 10599 / 四向8格撞实心 5681 / **洪泛 16358**。
  跨层共享 seen 会让 16358 → **0**（屋顶破洞把整间房判成天空 ⇒ 房间被岩层填满）。
- ⚠️ **支撑柱必须「遇保留空气即停」**，否则 **173 格**穿房间地板（air 16358→16185）。
- ⚠️ **台阶朝向冻结值是产物口径 24/51/69/12（合计 156）**，不是逐件累加的 159：
  源里 3 个台阶格次被后写件覆盖（后写胜）。写 159 那套会让门禁钉一个永远达不到的数。
- ⚠️ **藤蔓三个钳制缺一即静默退化**：缺 footprint 钳制 → HALF_Z 77→**78**（bbox 撑大）；
  缺「地下只在 keep 内」→ **582 格**被整形填石埋掉；只允许 keep 内生长 → 2029→**829**
  （更严的写法只出 218）—— **藤蔓本来就长在墙外天空里**（498 个 vines 点里 317 个在天空）。
- ⚠️ **缓坡插值分母是「逐列带宽 w」不是固定 16**（遇湿即止）。固定 16 时 777/4242/8888
  分别有 **123/100/140 列** target 不同；而 seed 12345/99999 **无差异** ⇒ 调它要跑多 seed。
  该口径同时保证零水格 ⇒ **不需要改 `ocean-mask.js` / `ocean.js`**。
- ⚠️ **`neighborRegionKeys` 返回 `"rx,rz"` 字符串数组**，不是坐标数组。
  按 `.map(([rx,rz]) => …)` 解构 ⇒ rx/rz 变成字符 ⇒ layout 全 null、结构 **0 格**且无报错。
  正确写法：`key.split(',').map(Number)`。
- ⚠️ **Node 侧探针验不了光栅化**：`loadStructure` 走 `fetch`，Node 无 fetch ⇒ catch 兼底
  静默返回空结构。凡「结构格数」类判据只能在**浏览器**里验；拿探针的 0 当缺陷会去改本来正确的代码。
- ⚠️ **跑浏览器套件期间不要改它读的文件**（会造成竞态假 FAIL，本轮踩到两次）。
  负向验证用 **`page.route` 在浏览器侧换文件内容**或独立副本，不碰工作树。
- ⚠️⚠️ **`AGENTS.md` 是 `CLAUDE.md` 的符号链接**：`git add AGENTS.md` 只会暂存**链接本身**，
  内容改动根本不会进提交（本轮 9 条高频坑就这么漏了一个 commit）。
  改高频坑一律 `git add CLAUDE.md`，并用 `git show --stat` 核对它真的在里。

**丛林要塞空地植被与栏杆（v3.13b，用户实玩反馈）**
- ⚠️⚠️ **树冠外溢要用「写入口守卫」解，不要靠降密度**：big 树冠 ±2、birchTree 产物跨度 −2..2
  ⇒ 紧邻墙 1~2 格的树干会把叶摆到墙上（实测一个 column 内 **36 格**植被落在结构实心列上）。
  若改成「要求树冠半径内全空地」，树从 **912→741 棵**（密度 3.754%→3.050%，砍 19%），
  与用户「密度同森林一样」相背。正解：`jfVegSetter` 在 setBlock 时跳过要塞占位的格
  ⇒ 保住全部 912 棵且零穿模。
- ⚠️⚠️⚠️ **「让位」必须逐格判，绝不能逐列**（v3.13c 用户截图报的 bug，我上一轮亲手引入）：
  列级判据（该 (x,z) 列任何一格有实心就禁写整列）会把**矮墙/台阶列的高处空气**也禁掉
  ⇒ 树冠贴墙那侧被**垂直切一刀**。实测：误杀 **3837 格（5.56%）**而真占位仅 **503 格**
  （误杀是它的 7.6 倍）；产物 10501 个含实心列里 **3378 列实心格 ≤3**。
  用户裁定：「树叶的位置被城堡方块占位了，这时才让位」⇒ 逐格 `jfCellFreeAt(px,ny,pz)`。
  **树干/草的落点仍用列级**（它们贴地）—— 两套口径分工，不要「统一成一套」。
  换算 `ny = wy − floorY + floorRow` 必须与光栅化同口径，拿世界 y 直查会退化成「全部放行」。
- ⚠️⚠️ **判「树冠有没有被切」不能拿「紧邻有叶的空格」当基准**（v3.13c 实测推翻直觉）：
  `generateTree` 自己会稀疏化（default 树 `rand>0.3` 才写）且 `_addOptimized` 跳过
  「六面全被树块包围」的叶 ⇒ 树冠内部本来就有合法空洞。那个判据在**修好之后反而从 297 涨到 414**
  （补上的叶让更多空格变成「紧邻有叶」）⇒ 零判别力。
  正解：用**同一个 `generateTree` 收集意图格**，逐格比对世界实际结果。
  另：**两棵树冠重叠时后写胜** ⇒ 判「是任何一种树叶」而不是「叶品种相等」（否则误报 1 格）。
- ⚠️⚠️ **像素机位必须按数据选，凭感觉选会得到假阴性**（v3.13c 三次选机位实测）：
  「东侧边缘外朝西」增量只 **16 像素（0.02%）**、「误杀最密簇俯视」+1.37%，
  而「**误杀最多的单棵树**平视」是 **+67.5%（54191→90758）**。
  做法：先用纯函数算出「缺陷会误杀哪些格」→ 按树/簇排序 → 站在那棵树旁边拍。
- ⚠️ **密度判据的分母必须是「空地列」不是「整形区全部列」**：后者含 30% 建筑占地，
  会把真实的 3.754% 算成 2.62%，看起来「密度不够」而去调本来正确的阈值。
  判据要带**抽样噪声尺度**：n=24295 时 σ≈0.126 点，与 FOREST 基准差 0.233 点 = 1.86σ（同密度）。
- ⚠️⚠️ **`handrailA` 的 orient 0≡2、1≡3 几何等价**（`railArmSet` 逐位相同）。
  与用户手工样例比对必须按**臂集合**而不是 orient 数值，否则 15 格等价写法会被误判成不符。
- ⚠️ **栏杆单臂端头要「沿自身轴延伸成直段」**，不是按支撑信号配垂直臂
  （后者会在排的端头出转角，与用户样例 2 格不符）。段级定向（按 (x,z) 分柱、y 连续切段）。
- ⚠️ **新需求会推翻旧断言，要按新语义改写而不是放宽**：用户要求空地植树植草后，
  「占地内零植被」与「整形地表以上必须清空」两条直接矛盾。改写成「植被只在空地 +
  必须有树/矮草/高草」与「以上不得残留原山体地形方块」，两条都保留真判别力。
- ⚠️ **门禁的「禁单」不得与用户裁定相反**：初版把 `handrail/handrailA` 列进禁单
  （理由是 cutout 成本），而用户明确要求换成它们 ⇒ 重烘必红。禁单只留
  iron（堵死窗洞）/ stone_diorite_step（亮 76）/ handrailB（接不上）/ vertical_pillar（未转手拉手）。
- ⚠️⚠️ **跑浏览器验证前必须核对端口归属**（v3.13e 实测踩到）：并发会话会抢占端口 ——
  我临时用的 8080 中途被**另一个 worktree（feat/turret-top-model）的服务接管**，
  于是我对着别人的代码跑测试。形态是「该结构的用例数 0、单测总数 2382→2380」而**零报错**
  （对面代码里根本没这些用例）。核法：`lsof -ti:<port>` 拿 PID → `lsof -p <pid>` 看 cwd，
  再 `curl …/<新用例文件> | grep -c <关键字>` 核内容。优先用本仓 `npm start`（**不发缓存头**）。
  ⚠️ **v3.19 起端口可配**：`MC_PORT=8082 npm start` + `MC_PORT=8082 npx playwright test …`
  （`playwright.config.mjs` 的 baseURL 与 webServer.port 同源切，默认仍 8081）。
  不加它时 `reuseExistingServer: true` 会**直接复用主仓的 8081 服务** ⇒ 在 worktree 里跑测试
  却对着主仓代码（本轮实测：8081 的 PID cwd = `~/jaylli/mc-heavy`）。
- ⚠️⚠️ **通用静态服务器的 `max-age=3600` 会让用户「修了看不到」**（v3.13d）：
  本仓 `server-script/start-server.js` 刻意**不发 `Cache-Control`**（注释写明「本地 dev 无缓存
  更能立刻看到改动」）；而 http-server 类工具发 1 小时强缓存 ⇒ 服务端已更新但浏览器仍跑旧模块。
  用户报「没修好」时先确认他开的是哪个端口 / 要不要硬刷新，再查代码。
- ⚠️ **salt 占用扫描必须解析 `seed + 常量名`**（v3.13e）：只匹 `seed + 数字` 字面量
  会把 `JF_GRASS_SALT`(1045)/`JF_BUSH_SALT`(1046) 误判成空闲 ⇒ 错用盐是静默的确定性污染。
- ⚠️ **降密度类需求要分清「局部稀疏」与「改共享概率」**（v3.13e）：用户说「丛林要塞的树
  密度减半」时**不得改 `rollVegetation` 的 FOREST 概率**（那是全地图森林的共享权威，
  改它会把世界各处森林一起砍半）；只在本结构分支加一道独立盐的逐列抽签。
  且**只降用户点名的那一类**（只说树 ⇒ 草/花不动）；用独立抽签而不是「隔一列种一棵」
  （后者在地图上留规则条纹）。判据钉**区间**（[0.40,0.60]）而不是精确 0.5（伯努利抽样必 flaky）。
- ⚠️ **降密度会让「每个候选都必须有」类旧断言失效**（v3.13e）：要把它们改回**真意图**
  （「贴墙树不被整类禁写」⇒ 钉 `hasTrunk > 100`，列级缺陷下恒 0）；同时「意图集」类判据
  必须**同步稀疏抽签**，否则把被稀疏掉的树当成缺陷（实测假红 1739 格）。

**丛林要塞地形耦合（v3.18，全部是实测推翻直觉型）**
- ⚠️⚠️ **裙边必须向「内外两侧」做包络，只外侧或只内部都错**：只抬外侧 ⇒ 内侧自然边缘列
  （nat=0）紧邻外侧裙边（9~11）形成 **9~11 格沟槽**（8 seed 实测 max 9~10）；全域抬内部 ⇒
  基座被埋回去（可见率 **45.8%→22.2%**），违背「地下部分裸露」诉求。正解：只动「边缘环 +
  内侧 R=12 + 外侧 BW=22」，内部非带列一律 nat。
- ⚠️ **三屏障里「保护列」在当前产物上是冗余的**（实测 218/202 个保护列 **100% 都是建筑列**）
  ⇒ 单独去掉它零判别力（注入后 4/4 seed 仍绿）。保留作防御（换产物/换地形后可能出现非建筑保护列），
  但「露出 air 零被埋」的负向验证要钉**建筑屏障**（建筑列被抬 355~380 列）。
- ⚠️⚠️ **漏底修补必须读世界方块，不能用 `noise3D > CAVE_THRESHOLD` 重算**：`carveCaves` 挖
  **两类**洞 —— 3D 噪声大洞 **与 rooms 空腔**（LCG）。seed 777 的 (38,6,-5) 下方 noise=0.4378 < 0.72
  但世界确实是 air（rooms 挖的）⇒ 只查噪声会静默漏补、地板仍漏空。
- ⚠️⚠️ **漏底不得加 `wy ≤ h−4` 范围门**：那是 `carveCaves` 的挖洞上限，不是漏底格的位置上限。
  半埋房间的地板**本就高于自然地表**（正是用户要的裸露）：seed 777 的 (69,9,-56) nat=2、
  地板 wy=5、漏底格 wy=4 > h−4=−2 ⇒ 加门会静默漏补。
- ⚠️ **「修补不填竖井」判据要钉「遇到的产物 air 仍是空气」，不是「零遇到」**：产物里本就有
  **1101 处**「房间格下方是产物 air」的正常相邻关系 ⇒ 钉零遇到在正确实现下恒红。
- ⚠️⚠️ **模块级产物引用不得写在「写入函数」里**（本轮引入的真缺陷）：`jfSkirtData` 原写在
  `fillJungleFortressSkirt` 内 ⇒ **纯查询路径**（瞬移落点/单测/尚未写到裙边的 column）拿到 nat 而非 T
  ⇒ 同一函数两种返回值 = 第二份权威（红线 1）。修法：`noteJungleFortressData()` 由装配层在
  `await loadStructure` 后**立即登记**，与 GEN 写到哪一 column 无关。
  ⚠️ 它的**测试形态是「单文件跑绿、全量跑红」**：单文件时产物未登记 ⇒ surfaceYAt 退回 nat ⇒
  「全区恒等 nat」恒真（假绿）；全量档里前面用例登记了产物才暴露。凡「恒等自然值」类判据
  都要先确认**被测变量真的生效**，并配一条「确实改动了」的正向判据（如抬升列 >100）。
- ⚠️ **`?skybox=0` 的真实天空色是 (169,208,219)**（雾化色），**不是** (135,206,235)。
  实测顶部像素众数 169,208,219 占 212/240。用旧值会把天空计入 stone/green ⇒
  造成「要塞 0.065 vs 对照 0.082」这类假红。像素判据的天空色必须**当场实测**。
- ⚠️⚠️ **像素机位必须按数据搜索，spec 里写死的坐标可能落在湿列**：本轮 spec 机位⑥ z=53 的
  nat=−1 ≤ SEA_Y ⇒ 裙边在那里零抬升（湿屏障正确生效）、画面 20% 是水 ⇒ **零判别力**。
  正解：运行期搜索「墙高≥5 + 相机到墙脚全干燥无建筑遮挡 + 抬升列≥4 + 每步≤1」，
  seed 12345 选出 z=21 / (-214,4,238)（裙边 T 从 1 逐级抬到 10，每步恰 1 格）。
- ⚠️ **对照组必须同机位单变量**：旧 spec 用「远处森林 (40,30,40)」当对照 —— 不同机位不同地形，
  灰石占比不可比。改用 `page.route` 换 baseY/R/BW 后**重拍同一机位**：
  俯瞰 base 0.2488 vs 埋回 0.0304（8.2×）、裙边视廊 base 0.3877 vs 无裙边 0.0464（8.4×）。
- **墩格不需要单独进植被让位索引**：它们恒在「该列屋顶下方」，已被 `jfCellFreeAt` 的②挡住
  （实测 763 个树冠意图∩墩格零穿模）；**裙边格必须进**（实测 1 格穿模）。
- **`anchor.floorY` 语义 = baseY（75 分位）**，五处消费方（光栅化/瞬移/植被/单测/spec）同改；
  `minH` 保留旧语义。`percentile75` 是**独立纯函数**，单测喂合成数组钉住，不硬编码 9。
- **层序：先光栅化 → 后墩 → 后裙边**（裙边读墩顶作为包络源）。
- ⚠️⚠️ **重活必须在 `world-worker.js` 的 layout 入口预热**（仓库已有四个锚点的同款手法）：
  裙边包络场首次 **130~209ms**，不预热就落进首个 GEN（genP95 门 10ms）。
  且**缓存要在函数入口**：只在 `surfaceYAt` 侧缓存、让位索引侧直调 ⇒ 再全量重算 40ms。
  实测修后一次性成本 **82.4ms → 1.8ms**（A/B 交替 3 轮）。
- ⚠️⚠️ **Worker 脚本不走 `page.route`**：用它换 GEN 模块做对照组**完全无效**
  （实测 base/noskirt 五个机位读数逐位相同）。GEN 类对照要用**不依赖注入的独立真值**
  （如「同一列的 `generateHeight`」），或在主线程侧用 `registerHooks` 注入跑同构 GEN。
- ⚠️ **像素阈值必须在 spec 的真实 viewport 下标定**：Playwright 默认 **1280×720**，
  探针自设 960×600 会因视野更宽而稀释占比（同机位 0.3736 vs 0.0397，差 9.4×）。
- ⚠️ **`gotoAndView` 类夹具在 STABLE 后必须重钉一次位置**：等 column 加载期间物理已在跑，
  玩家会从未加载的空中坠落（实测 y 从 4 掉到 −23）⇒ 截图机位与请求不符、像素判据随机漂。
- ⚠️ **「世界地面」判据要钉「T 那一格是否实心」**，不用「从高处向下扫第一个非空气」
  —— 后者会命中树冠/树干（实测把 T=2 读成 4，假红）。

**确定性**
- `seededRandom` 的 salt 占用必须**程序化扫描**，grep 字面量抓不到 `seed + N` 形式的区间占用。
  已占 1020~1040 段（1028 是被跳过的洞，保守避开）。用错 salt 是静默的确定性污染。
- 结构写入无占用格守卫（`makeColumnSetter` 后写胜，与 mc-lite 先写胜不同；未注册名字**静默 return**
  → 那格变 air）。**写结构类断言不得假设「每个结构都完整」**。

**UI 布局**
- **瞬移行的按钮文案上限随按钮数递减**（v2.89 实测）：左列 375px + `.mc-btn-group` 平分，
  六按钮 4 字、七按钮 3 字（靠本行专属 `gap:4px`）、**八按钮只剩 2 字**（每只文字可用 31.4px，
  3 字 36px 折行，即使 gap 收到 0px 也只有 34.9px ⇒ 无解）。加按钮前先量真实布局
  （`Range.getClientRects()` 行盒数），`scrollWidth <= clientWidth` 对折行无判别力（折行时两者仍相等）。

**门禁与测试**
- `src/tests/test-*.js` 必须同时出现在 `src/tests/index.html` 的 import 里 —— 漏注册是
  **测试静默不跑**（全绿假象），`check:data` 的 `[测试注册]` 环节双向钉住。
- **地牢可达性不得把台阶当可通行**（守卫 v2.91 实测推翻了直觉）：本仓台阶族一律 `solid:true`
  ⇒ `isSolid` 恒真 ⇒ 身体不能进入（楼梗是装饰，不可爬）。把台阶当 air 会算出「27,992 格连通」
  的假结论；真实口径下废弃堡垒三层房间**互不连通**（ny30/37 全层零 air，ny37 唯一开口是遭丢弃的
  `iron_trapdoor`）。另：洪泛探针的竖直移动必须**逐格检查通道**，否则会算出穿墙的假路径。
- **`HEADROOM` 与房间净空耦合，取 `ceil(height)` 而不是 `+1`**：上层房间净空只有 5 格，
  守卫高 3.8 ⇒ `ceil(3.8)+1 = 5` 会把落点判死而**静默召到下一层（差 8 格）**，所有计数/状态全对。
- **`maxStep` 在现有实现下是死值**：`zombieStepUpY(y) = floor(y+0.01)+1` 恒抬 1 格，
  `maxStep` 只做「抬升量 ≤ maxStep」的门控 ⇒ **1.75 与 1.0 逐位等价**。写 1.75 只得到一个看着生效
  实际无效的值；「验证 >1 格台阶」的探针两侧都无判别力。真要支持得改 `zombieStepUpY` 本身
  （影响丧尸/焰魔/玩家三方，是独立改动）。
- **判定器顺序用例的 seed 清单不能跳结构照搬**：大竞技场那八个 seed 在废弃堡垒上**零重叠**
  （净距 64~98 格 > 盒半宽 28）⇒ `checked > 0` 直接红。堡垒用 2096/2644/3740/4151/4973。
- **推出距离不是「最大绝对半宽 + 玩家半宽」**（守卫 `EJECT_MAX` 复核）：推出走**最近的一个面**，
  四方向取 min 后再对盒内站位取 max。守卫实测 **1.900**（yaw 42°），而「最大绝对半宽 1.905 + 0.3」
  算出 2.205 会误报超限。核心盒不对称（`center.z ≠ 0`）时两个口径差很多。
- **`_collides()` 漏加新 Boss 判据的形态很隐蔽**：`_collides` 返 false 而 `overlapsAabb` 返 true
  ⇒ 玩家走进盒内，再被 `_ejectFromBoss` 每帧外推一点、下一步又走回来 ⇒ 净效果是「停在盒内
  0.12 格深处」而不是盒外（守卫实测踩到）。新 Boss 必须同时接 `_collides` 顶部与 `_ejectFromBoss`。
- Playwright 必须 `channel: 'chromium'`：默认 headless shell 零 flag 拿不到 WebGPU adapter。
  `playwright.config.mjs` 全局 timeout 200s 必须 ≥ 各 spec 自己的等待窗口（`harness.spec` 等 150s）。
- 计时型 spec 在高负载下会贴线 flaky（`m1-acceptance` 放挖 p95、`m3-rain` 截图差分、
  `weapons-world-edit` 计数、bench 的 frameP95）。**判据看交替对照的分布，不看单次红绿**（不改阈值）。
- 写像素类断言必须**同时钉上下界**（只钉「变暗」抓不到「纯黑」），且先测同状态重复截图的噪声底。
- **像素颜色判据必须带对照组校准**（废弃堡垒 v2.89 实测）：
  · 「末地石主色」用 `g>=r && g>b*1.25 && lum>60` —— `g>=r` 排除沙漠沙（sand_side 193,183,144
    是 r>g），否则「只是沙漠没有结构」也命中，断言失去判别力（实测判别力 18×：0.419 vs 0.023）；
  · 「水体」用 `b>r+25 && g>r+12 && lum∈[95,150]` —— 漏 `g>r+12` 会让**紫色方块**误报
    （void_stone 120,31,225；v2.90 前 amethyst 141,103,197 也是，现已改映 deepslate 120,120,145
    —— 但 deepslate 的 g−r 恒为 0，等比缩放后仍被 `g>r+12` 排除），漏亮度门会让**雾化天空**（168,208,216，
    lum 197；`skybox=0` 的纯天蓝是 135,206,235，±30 容差抓不到它）与**暗 obsidian**（32,72,120，
    lum 75）误报（实测分别误报 11.83% 与 0.82%）。
- ⚠️⚠️ **发光特效的像素判据：必须先把「自带同色的宿主」藏掉**（焰魔法阵 v3.04 实测）：
  焰魔本体是**火焰橙皮肤**，自己就满足「金黄 = `r>g && r−b>100`」，且 idle 动画让它在 1.5s 内
  波动 **±18000 像素**，而法阵真实贡献只有 **≈2833** ⇒ 判据被宿主噪声淹没。
  **失效形态是「注入退化后仍 PASS」**：把 `update` 里的 `visible` 强制成 false（法阵永不上屏），
  第一版 Tier 4 照样绿（onCount 40261 > noiseFloor+3000）。来源分解实测：
  焰魔可见+无法阵 **34526→53108** / 焰魔隐藏+无法阵 **616** / 焰魔隐藏+有法阵 **3449**。
  修法：两侧都先 `inst.mesh.visible=false` 藏掉宿主，只留特效这一个变量 ⇒ 基线 **554/554/554**
  （零噪声）、特效帧 **2885**。凡「暖色特效贴在暖色实体旁」都要先做这个来源分解。
- **贴地特效的 E2E 夹具：宿主必须与玩家同高**（v3.04 实测）：`ignises.summon` 的 `_findGroundY`
  取「离参考高度最近的可站位置」，起伏开阔地会把焰魔放到 **y=12** 而玩家 **y=4**（差 8 格）
  ⇒ 贴地法阵落在 y=11~14，**全在相机（y=5.62）上方**，俯视根本看不到 ⇒ 像素零变化（569→569）。
  夹具要把宿主 state.position 钉到玩家同高。另：开阔地传送必须用 `g._teleportTo(x,45,z)`
  （它会加载目标 column），`player.spawn` 不加载 ⇒ 玩家悬在未加载空列里，等落地 30s 超时。
- **`assertEqual` 是 `===`，不能断言数组**（v3.04 实测）：`assertEqual([0,50,150,200],[0,50,150,200])`
  恒 FAIL 且错误信息是「Expected 0,50,150,200, got 0,50,150,200」（看着完全一样）⇒ 极易误判成
  生产代码缺陷。数组用 `assertDeepEqual`；`assertClose` **不在 `assert.js` 里**（它是
  `test-zombies.js` 的文件内局部函数），要用得自己定义。
- **负向锚点自己也要验判别力**（v3.04 实测）：为「碎石环心前移」写的锚点
  「`|到脚底距离 − radius| > 0.5`」只查 `pts[0]`，而 i=0 时 `angle=yaw` ⇒ 该点恰好落在离脚底
  **1.453** 处（forward 2.75 − radius 1.3），与 radius 1.3 太近 ⇒ **正确实现下也 FAIL**。
  改取「全部点到脚底的最大距离 > radius+2」（前移后 ≈4.05、未前移恒 1.3）两侧才有判别力。
- ⚠️⚠️ **多 slot 特效的「逐段淡出」不能写共享 `material.opacity`**（焰魔法阵 v3.04b）：
  取「活跃段 opacity 最大值」会让**先淡出的段被后段拖着满亮**，直到最后一段淡完才整体消失
  ⇒ 纯函数（`sigilOpacityAt`）的淡出曲线**在画面上基本不生效**，而它的单测全绿。
  修法：additive 下「颜色 × alpha」等价调亮度 ⇒ 用 `setColorAt` 做逐实例亮度，
  判据必须落在真实 `instanceColor` 上（`getColorAt`）而不是纯函数返回值。
  （`explosion-renderer` 的共享 opacity 手法只适用于「所有实例同生同死」的场景。）
- **新增 lint warning 不得称作「既有基线」**（v3.04 实测踩过）：本轮把 `61 warnings`
  当成基线写进 roadmap，实际 v3.01 记的是 **60** —— 那 +1 就是自己引入的未用 import。
  判据：改动后跑 `npx eslint <改过的文件>` 单独看它有没有 warning，别只看全仓总数。
- **地面/落点扫描类方法要单测「窗口两侧越界」**（v3.04b）：`_findSigilGroundY` 的
  `脚底+4 → 脚底−8` 窗口，只测「正常平地」时把起点退回 `base`（丢掉 +4）仍全绿；
  必须同时测**凸起地形**（贴凸起顶面）与**悬空平台**（取平台而不是真地面）。
  造壳手法：`Object.create(Game.prototype)` + 只注入 `world.isSolid`（同 `test-tnt-chain.js`）。
- ⚠️ **「跳起高度×N」不等于「初速×N」**（v3.04c 碎石调参）：`debrisOffset` 竖直项是
  `vy·t − ½·g·t²` ⇒ 峰高 **`h = vy²/(2g)`**，h 与 vy 是**平方**关系。
  用户要「高度增加两倍」⇒ speed **×√2**；写 ×2 会得到 **4 倍**高度。
  `DEBRIS_GRAVITY`（=18）是枪击/死亡爆散/砸击**共享**的，不得为单一特效改它。
  另要核对**到峰时刻 < 缩零起点**（`vy/g` vs `shrinkFrom×lifeMs`），否则弹起还没看到就被缩掉。
- **像素阈值探针失效时要换几何口径**（v3.04c 实测）：用「亮度+饱和度」圈碎块像素，
  三档参数的 bbox 高度全是 **410 = 整个 clip 高度**（把地形也圈进去了）⇒ 零判别力。
  改读 **`getMatrixAt` 的世界 y / 列向量长度**（真实实例矩阵）才有判别力，
  且能直接量出「抬升/块边长」这类观感比值（实测 1.194 ⇒ 确实跳得比自身高）。
  ⚠️ 探针里多次 spawn 前要确认 slot 已回收：`reset()` 不归零 `_nextDebrisSlot`，
  紧接着读前 N 个 slot 会取到空 slot（实测抬升 −4 / 边长 0）。
- **A/B 单变量对照要先确认「变量真的被改动了」**：`ocean.js` 的海面平面 mesh **没有 `name`**，
  用 `scene.traverse` 按名字匹配会一个都找不到 ⇒ 两侧数字相同是假象，会得出「与海面平面无关」
  的错误结论。必须用 `game.ocean.plane`（`setupOcean` 的返回值）。
- **烘焙产物的「朝向分布」必须逐档比对，不能只比格数**（废弃堡垒 v2.89）：去掉台阶
  `half=top` 的 `meta=(orient+2)%4` 时，格数/palette/包围盒/**指纹全部不变**（只改 meta 值），
  而 `--census-orient` 验的是 mesher 几何语义（「+2 这个假设成立」），不验 classify 有没有用它
  ⇒ 缺陷静默通过（实测四档 60/54/58/52 → 58/52/60/54，楼梯高侧全差 180°）。
  既有 4 个烘焙产物都只把 `stepOrientationCounts` 写进 meta 而不断言 —— 新增产物要补上。
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
| **地形高度公式 / biome 判定 / 地图多样性（含从 Tectonic 迁移）** | `docs/tectonic-terrain-migration-survey.md`（三档可移植性 + `genP95` 预算与红线 1 冲突）+ `src/gen/terrain.js` 的 `TERRAIN_HEIGHT_PARAMS` 注释 + `src/render/ocean.js` 的 `getTerrainHeight` TSL 同构实现 |
| 地形/高台地带/浅水高台/祭坛/拱桥/竞技场/大竞技场/废弃堡垒/金字塔/中世纪船 | 各自的 `docs/superpowers/specs/<日期>-*design.md` + roadmap 同版本行 |
| 光照 / 阴影 / 天空 / 雾 / 水面 / 色温 | `2026-10-13-sun-shadow-map-design.md`、`2026-10-20-sun-shading-and-skybox-design.md`、`2026-10-24-lighting-realism-design.md` + roadmap「活跃约束详情·光影真实感 / 渲染与容量」 |
| 结构撒布 / 巨树 / 杜鹃树 / 植被 | roadmap「结构撒布」「巨树」「树叶与镂空遮挡体」段 + `2026-10-23-giant-trees-design.md` |
| 龙 / Boss / 火球 / 实体伤害 | `2026-11-03-altar-dragon-design.md` + `2026-11-03-dragon-boss-ai-design.md` + roadmap v2.41~v2.48 |
| 末影守卫（废弃堡垒 Boss） | `2026-11-11-ender-guardian-boss-design.md` + `plans/2026-11-11-ender-guardian-boss.md` + roadmap v2.91（口径 A / 上层房间落点 / HEADROOM=4 / 眼睛层阈值） |
| 丧尸 AI / 寻路 | `plans/2026-11-04-zombie-pathfinding.md`、`2026-11-02-zombie-obstacle-avoidance-design.md`、`2026-11-04-zombie-model-rebuild-design.md` + roadmap v2.46~v2.50 |
| **丧尸行为层（犹豫/后退/徘徊/速度包络/转身限速）** | `2026-11-16-zombie-behavior-realism-design.md` + roadmap v3.11（到达门 / 侧向净空无判别力 / 两个时基 / 限速接 `_applyIntent`） |
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
- **`_ignitingTnt` 的键必须在 `explodeTnt` 出口无条件释放**（v2.97）：只在该格「确实是 tnt」时删
  会让连锁幽灵项 / 枪击落空 / column 未加载的分支把键永久留下 —— 该格之后放的 TNT 被
  `has(key)` 静默拒爆（方块永远炸不掉、也永远不消失，用户报告的正是这条）。
  另外连锁入队必须按格去重，且去重不能只扫 `_tntChain`：`_updateTntChain` 逐项引爆前把本帧到期的
  项**整批**抽走 ⇒ 同批两项互相看不见。权威集合是 `_tntScheduled`（「已排期未引爆」），
  `explodeTnt` 若命中已排期格要撤掉它的排期项（否则多一次空爆炸）。
  ⚠️ **不要用「到期时先验证该格仍是 TNT」来替代去重** —— 那是 mc-lite 刻意没有的偏离，且会顺带变成
  「玩家能在延迟窗口内拆引信」这个没被要求的玩法变更。
- 所有玩法服务在 `EntityManager.update` 之外改 `state.position` 时，必须显式 `reindexColumn(id)`，
  否则实体停在旧 column 索引上不自愈。
- 击退（剑砍中）的**权威位移必须瞬时**，观感滞后只许落在渲染位置（`render/knockback-ease.js`，
  与上台阶只缓动渲染 y 同一分工）。触发必须走服务层的**显式上报告诉实际位移**，不能用
  「渲染位置与物理位置差得多就补间」—— 丧尸 AI 每帧 0.02 格与 0.9 格击退分帧后同一量级，阈值两侧都会误伤。
- 「绑定在某个 column 的派生 controller」的装配必须早于 `_waitForColumn`，否则首个 ready 回调
  拿不到 service（形态：装置不工作，而锚点、索引、方块全对）。多格结构的 origin 用命中格
  `blockPos`，单格实体（矿车）用 `prevPos`。
- **多格结构的 origin 必须先归一到地面格**（v3.13 炮塔悬空）：主射线对「非空气且非水」一律命中
  ⇒ 地面长草时 `blockPos` 是**草格**，直接当 origin 会让底座落在「草格+1」= 地面+2 而悬空。
  归一（`isPlant` 则下沉一格，**只一格**）与「蓝图格允许覆盖植物」都写在**服务层** `place()` 入口，
  不写 `Player.placeBlock()` —— `game.placeTurret()` 与背包分流是两个入口，写 player 里只修一条。
  `registry.isPlant` 派生自 `solidTable=0 && cullTable=cutout`（不写名字白名单，新植物自动纳入）；
  水与 alias 刻意不算（否则炮塔会沉到水底）。⚠️ 巢穴的同类判据尚未改。
- 玩家位置/设置的持久化字段写进既有 `meta` 行并 **merge** 后整行 put；`_discardEdits()` 必须把
  「位置写盘」置为未启用，否则换世界/清档后 `beforeunload` 会把旧世界坐标写回新世界。
- 翻转一个设置的**默认值**时要带 `settingsVersion` 迁移：旧存档里那个值是「默认值为旧值时顺带写下的」，
  只改 `DEFAULT_SETTINGS` 对所有点过面板的人都不生效。新增字段（旧存档没有它）则不需要迁移。

## 生成物（不要手改）

`assets/atlas.{png,json}`、`assets/icons-atlas.png` + `icons.json`、`assets/structures/*`（烘焙得到的
那几个）、`assets/{zombie,dragon,turret,ignis,guardian,giant-trees,azalea-trees,sky/night}/` 里的产物、
`assets/textures/procedural/*`、`assets/textures/{mossy_stone_bricks,cracked_stone_bricks,chiseled_stone_bricks,purpur_block}.png`
+ `stone_bricks.meta.json`（v3.19，`npm run stonebricks`）、`docs/m3-baseline.*`（冻结基线，`npm run bench` 不带 `--check` 会自动
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
