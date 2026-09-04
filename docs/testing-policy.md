# 测试分级策略（harness 分级规范）

> 本文是**测试分级的唯一权威**。CLAUDE.md 的「测试工作流」章节引用本文，不再自述分级细节。
> 定稿日期：2026-09-03（第一阶段 M0~M3 收尾后、M4 开始前）。
>
> **制定动机**：此前全部改动一律走 RED-GREEN-REFACTOR，连「改一个贴图地址」「修正一个 alias
> 映射」都要先写失败测试。这类改动的正确性肉眼即可判定，TDD 只增加成本不增加保障。
> 本文把测试要求按**改坏后的可发现性与修复成本**分级，把 TDD 投入集中到底层机制。

---

## 1. 分级判据

分级的唯一判据是：**改坏了会发生什么、多久能被发现**。不是「改动大小」，也不是「文件位置」。

| 级别 | 改坏了会怎样 | 发现方式 | 修复成本 | 测试要求 |
|---|---|---|---|---|
| **Tier 1** | 静默的数据错误 / 性能回退 / 架构红线回退 / 跨模块契约破裂 | **肉眼玩不出来的**，只能靠断言 | 高（污染存档、破坏确定性、要回滚） | **必须 TDD** + 门禁 |
| **Tier 2** | 约定值不一致（集合口径、资源引用悬空） | 立刻可见（图标空槽、方块消失） | 低（改回去） | **需要门禁断言，免 TDD 流程** |
| **Tier 3** | 观感/文案不对 | 立刻可见 | 极低（改回去） | **免测试** |
| **Tier 4** | GPU 渲染结果不对 | 单测测不到（TSL 节点在 GPU 求值） | 中 | **像素级实测**，不宣称目视验证 |

**核心原则**：越底层越要保护，越表层越不要保护。判据不是行数，是「错误能否逃逸到玩家手里且不被察觉」。

---

## 2. Tier 1 — 必须 TDD（机制性 / 架构 / 性能 / API / 稳定性）

### 2.1 适用范围

| 类别 | 具体对象 | 为什么必须 TDD |
|---|---|---|
| **纯函数算法** | `mesh/mesher.js`、`mesh/lighting.js`、`mesh/iso-icon.js`、`player/raycast.js`、`player/physics.js`、`gen/terrain.js`、`gen/caves.js`、`gen/structures/*`、`player/orientation.js` | 输出是 typed array / 顶点缓冲，错了肉眼看不出来（AO 算错、面剔除漏面、洞穴连通性断裂、朝向旋转错位），会静默污染渲染与存档 |
| **版本协议 / 竞态** | `voxel/chunk-column.js` 的 columnVersion、`core/scheduler.js` 队列语义、`core/worker-pool.js` RPC | 竞态错误只在特定时序出现，玩十局可能都不复现；红线 7 明确「禁止为竞态打补丁」，必须有断言钉住协议 |
| **数据模型契约** | `player/inventory.js` 的 `Slot`/`Inventory` 语义、`save/persistence.js` edits round-trip、`voxel/block-registry.js` 注册序 | 语义错了会污染存档（红线 2「存档只存 edits diff」）；`registry.all()` 顺序是物品集合的权威，错序会让快捷栏错位 |
| **性能冻结断言** | `src/bench/baseline.mjs` + `npm run bench -- --check`、fps/draw call/编辑 p95 | 性能回退是**渐进**的，单次改动看不出，累积到掉帧才发现。红线 3「重计算离开主线程」靠这些断言守住 |
| **架构红线** | 12 条重构红线的静态特征（依赖方向、禁止类名、workers 不 import three、gen/mesh 同构） | 红线回退是 mc-lite 病根的复活路径，**代码能跑但架构已死**。必须有静态门在改动当场拦住 |
| **跨模块 API** | `world.getBlockMeta()`、`WorldEditor.setBlock(id, meta)`、`registry.orientationModesTable` | 多个消费者共用同一签名，改坏了下游静默拿到错值（M3.2 就踩过：Task 6 若退化为只传 id 会丢朝向） |

### 2.2 TDD 流程要求（Tier 1 不变）

1. **RED**：先写失败测试 → 2. **验证 RED**：运行确认按预期失败 → 3. **GREEN**：最小实现
→ 4. **验证 GREEN**：全部通过 → 5. **REFACTOR**：重构保持绿。

测试一开始就通过，说明测试写错了或在测已有行为。**RED 阶段不得把新测试从 `src/tests/index.html`
临时移除来「通过」**（M4 plan Task 1 Step 2 已写明这条）。

### 2.3 冻结断言纪律（Tier 1 专属）

计划中标注「冻结」的断言数字（draw call 数、fps 阈值、p95 上限、`setGeometryAt` 阈值）
实测不符时 **停下来报告，不要擅自改断言或静默放宽**。

计时类断言 flaky 时的正确做法（本项目已三次踩坑，见 CLAUDE.md 实施记录）：
**分开按 spec 连跑拿数值分布，比均值与峰值** —— 仅凭「全量跑失败 / 单独跑通过」判定不够，
全量跑时不同 spec 会轮换失败，容易误读成「改动侧统计显著」。v1.24 实施时 HEAD 侧失败率
反而更高（3/4 vs 2/4），若只看全量跑就会得出相反结论。

---

## 3. Tier 2 — 需要门禁断言，免 TDD 流程（数据契约 / 集合口径）

### 3.1 适用范围

值是**约定**而非**算法**：改错了立刻可见，修复成本 = 改回去。这类改动**不需要 RED-GREEN**，
改完跑 `npm run check:data` 即可。

| 对象 | 例子 |
|---|---|
| 方块→贴图映射 | `voxel/faces-data.js` 的 tile 名 |
| 图标平面清单 | `tools/icon-fingerprint.mjs` 的 `FLAT_BLOCKS`（哪些方块走平面贴图而非等轴测） |
| 物品排除集合 | `NON_PLACEABLE_ITEMS` / `HIDDEN_FROM_INVENTORY` |
| atlas 产物 | tile 数、gutter、size |
| 资源路径常量 | `WEAPON_ASSET_URLS`（M4）之类 |

> **v1.26 变更**：`ui/hotbar.js` 的 `INVENTORY_ICONS` 图标表已删除（图标改为全量离线烘焙产物
> `assets/icons-atlas.png` + `icons.json`）。改背包内方块的贴图/几何后须重跑 `npm run icons`
> ——忘跑会被 `check:data` 的指纹检查抓到（见 §3.3）。

### 3.2 关键改造：关系型断言取代硬编码计数

**这是本次 harness 升级的核心。** 硬编码计数断言（`expect(count).toBe(156)`）是「改动放大器」：
新增一张贴图就要改 3 处（spec + CLAUDE.md + 设计文档），改的是**同一个事实的三个副本**
（违反红线 1 精神：数据只有一份权威）。

改为**关系型断言**——校验不变式，而非钉死数值：

| 旧（硬编码） | 新（关系型） | 好处 |
|---|---|---|
| `expect(count).toBe(156)`（历史断言） | `faces-data` 引用的每个 tile 都必须在 atlas 里 | 新增贴图**不用改断言**；悬空引用当场报错 |
| `expect(items).toBe(118)` | 物品集合 = `registry.all()` − 两个排除集合 | 改排除集合**自动跟上**（原型已实测验证） |
| `expect(iconCount).toBe(9)`（v1.24） | 图标**输入指纹**比对：几何顶点序列 + 贴图名 + 贴图内容哈希 | 改几何/贴图/换同名 PNG 忘跑 `npm run icons` → 当场报错（图标静默过期） |

> **v1.26 变更**：atlas 现为 147 tile（背包图标已独立到 `icons-atlas.png`）。第一行的 `toBe(156)`
> 是**历史反例**——它正是要批判的「硬编码计数」反模式，实际已改为与 `assets/textures` 的 PNG 数
> 比对（`atlas.spec.mjs`），新增贴图自动跟上。第三行的图标同步从「tile 计数」改为**指纹比对**
> （精确判定，含贴图内容哈希，能抓「换同名 PNG 内容」这条计数抓不到的路径）。

**保留硬编码的例外**：`size=2048`、`gutter=16` 是**设计常量**（§4.4.1 定稿），不是随改动漂移的
计数 → 保留 `toBe`。判据：这个数是「设计决策」还是「事实统计」？前者钉死，后者用关系式。

### 3.3 Tier 2 的门禁

`npm run check:data`（`tools/check-data.mjs`，~1s，无需浏览器）：
- **引用完整性**：`faces-data` + 平面图标手工 tile 引用的 tile 必须都存在于 `atlas.json`
- **物品集合关系式**：`buildItemNames(registry)` ≡ `registry.all()` − 排除集合
- **图标 manifest 覆盖**：背包集合与 `icons.json` 两套尺寸档**双向一致**（缺项 = 忘跑 icons；
  幽灵项 = 方块移出背包但 manifest 残留）
- **图标 atlas 产物**：`icons-atlas.png` 存在且尺寸与 `icons.json` 的 `size` 一致
- **图标过期指纹**（v1.26 核心）：用当前源码重算每个方块的输入指纹与烘焙时写进 `icons.json`
  的比对，不匹配即报「跑 `npm run icons`」。指纹含**贴图内容哈希** → 能抓「换同名 PNG 内容」
- **几何路径正确性**：非实心方块必须在 `FLAT_BLOCKS`（否则被当实心立方体渲染，错）；异形
  geometry 指向缺失的 `TEMPLATES` 条目 → 静默 fallback 立方体（错）。`geometry='box'`/null 是
  正常的单位立方体标记，**不是缺陷**
- **测试注册完整性**：`src/tests/test-*.js` 必须全部出现在 `src/tests/index.html`
  （漏注册 = 测试静默不跑，比测试失败更危险）

**改指纹逻辑时须手动重跑的三条负向验证**（`tools/icon-fingerprint.mjs` 无自动化测试，见 §9 例外）：

| 路径 | 做法 | 预期 |
|---|---|---|
| 改几何 | 改 `mesher.js` 某个 `TEMPLATES` 条目的顶点 | 不跑 `npm run icons` 直接 `check:data` → 报该方块过期 |
| 改贴图映射 | 改 `faces-data.js` 某方块的 tile 名 | 同上 → 报该方块过期 |
| 换同名 PNG 内容 | 改一张贴图 PNG 的像素、不动 `faces-data` | 同上 → 报该方块过期（这条最易漏：只钉贴图名抓不到） |

验完把改动还原。第 3 条同时验证**不误报无关方块**（改 `stone.png` 时 `mine_cart` 不应被报）——
实测踩过这个缺陷，根因是平面路径的取图口径（`flatTile()`）与指纹不一致。

---

## 4. Tier 3 — 免测试（表层 / 文案 / 资源引用）

### 4.1 适用范围

改坏了肉眼立刻可见，修复成本 = 改回去。**不需要写测试，不需要 RED-GREEN**，只需 `npm run lint`。

- **贴图地址**：`faces-data.js` 里改 tile 名（如 `planks_step → planks_birch` 改成别的）
- **CSS / DOM 结构**：`ui/inventory.js` 的样式、`ui/hotbar.js` 的槽位尺寸、`index.html` 的准心样式
- **文案**：HUD 文字、设置面板标签、错误提示措辞
- **注释与文档措辞**：代码注释、设计文档行文
- **资源路径常量**：GLB / 音频 / PNG 的路径字符串

> **v1.26 后的新约束**：改**背包内方块**的贴图地址属于 Tier 3，但改完须重跑 `npm run icons`
> （图标是离线烘焙产物，采样源正是 `faces-data`）。忘跑会被 `check:data` 的指纹检查抓到。
> 改**非背包方块**的贴图无需重跑。

### 4.2 既有 Tier 3 型测试的处理

`src/tests/test-ui.js` 与 `test-inventory-ui.js` 曾有 **13 个**用例钉死具体 tile 名或 CSS 值
（如断言 `tileOfName('planks_step') === 'inventory-icons/planks_step'`）。这类用例的处置：

- **钉值的用例随事实更新或随载体删除**：v1.26 把图标改为离线烘焙产物后，`tileOfName()`/
  `INVENTORY_ICONS` 已删除 → 测它们的 9 个用例**一并删除**（不是「保留但降级」）。
  它们保护的失效路径「图标回落 `faces-data` → 撞脸」在新架构下**结构上不存在**
  （图标不再从 faces-data 派生，而是独立烘焙），等价保障改由两处承担：
  ① Tier 1 单测 `test-iso-icon.js` 钉「`grass` 顶面必须是草绿、不得采成土色」；
  ② `check:data` 的图标契约（manifest 与背包集合双向一致 + 指纹未过期）。
- **钉不变式的用例必须保留并迁移**：「异形方块图标必须与母方块不同」「竖柱 vs 横梁形状不同」
  「正置 vs 倒置台阶形状不同」这类是 **Tier 1 级**（防撞脸这类肉眼难辨的错误），不得放宽。
  v1.26 把它们从「读旧 PNG」迁到「读 `icons-atlas.png` 裁矩形」，判据不变。

判据：**断言钉的是「值」还是「不变式」**？钉值 → 随载体存亡（载体删了就删，别为死代码留断言）；
钉不变式 → Tier 1，载体变了要迁移而不是删除。

---

## 5. Tier 4 — 视觉验证（GPU 渲染结果）

### 5.1 适用范围

正确性只在 GPU 渲染结果里，单测测不到（TSL 节点在 GPU 求值，主线程读不到片元输出）：
- `render/materials.js` 的片元逻辑（emissive 加项、bit13 解包）
- 图标的像素观感、吊灯 UV 分区效果、床的镂空问题

### 5.2 验证口径

- **像素级实测取代目视**：截图 → canvas 读像素 → 行剖面 / 亮度差 / 色数统计，
  判据是「形状必须与 `TEMPLATES` 几何定义对应」（v1.24 已建立此方法论）
- **必须标注环境限制**：本环境截图的 `Read` 只返回 URL、不渲染成图像 →
  **不能宣称目视验证**，须明确写「改用像素级实测代替」
- **像素级 diff 要有对照组**：改动侧 vs HEAD 的 diff 像素数 + 整体亮度均值，
  证明「只有目标局部变化」（吊灯 emissive 那次：2006 px 差异 / 亮度均值 150=150 不变）

---

## 6. 门禁分层与执行时机

| 层 | 命令 | 耗时（本机实测 2026-09-03） | 何时必须跑 |
|---|---|---|---|
| **静态架构门** | `npm run check:arch` | 285ms（扫 51 个源文件） | **每次改 `src/**`**（红线回退当场拦住） |
| **数据契约门** | `npm run check:data` | 307ms（7 项检查） | 改了 `faces-data` / `inventory` / `tools/` / atlas / 背包内方块的贴图或几何 |
| **lint** | `npm run lint` | 1.1s | 每次改 `src/**/*.js`（0 error，warning 可接受） |
| **单测** | `npm test`（`tests/harness.spec.mjs` 跑全部浏览器单测） | ~10s | 改了 Tier 1 对象 |
| **全量 E2E** | `npm test`（27 spec） | ~2.8min | 里程碑收尾、提交前 |
| **性能门禁** | `npm run bench -- --check` | ~5min | **碰了热路径**（mesher / materials / render-world / scheduler / physics） |

**便利入口**：`npm run check` = `check:arch` + `check:data` + `lint`（**2.6s 实测**，日常改动的最小门）。

### 6.1 分级 → 门禁映射

| 改动类型 | 最小必跑门禁 |
|---|---|
| 改贴图地址 / alias / 文案（Tier 3） | `npm run check` |
| 改物品集合 / `FLAT_BLOCKS` / atlas（Tier 2） | `npm run check` |
| 改纯函数算法 / 协议 / 数据模型（Tier 1） | `npm run check` + `npm test` |
| 改热路径（mesher/materials/render/scheduler/physics） | 上述 + `npm run bench -- --check` |
| 改 GPU 材质效果（Tier 4） | 上述 + 像素级实测 |

**不要**：为了改一个贴图地址而跑 5 分钟 bench 或全量 E2E。
**也不要**：改了 mesher 几何却只跑 `check`（热路径必须跑 bench）。

---

## 7. 静态架构门（`tools/check-architecture.mjs`）规则

对应 12 条重构红线中**可静态检查**的部分。检查失败即退出码 1。

| 红线 | 检查规则 | 备注 |
|---|---|---|
| 红线 3/8/10 | `src/workers/**` 不得 `import three` | module worker 不继承 import map |
| 红线 8 | `src/gen/**`、`src/mesh/mesher.js`、`src/mesh/lighting.js`、`src/voxel/**` 不得 import three | Worker 同构；`src/mesh/atlas-loader.js` 是例外（主线程专用，见 §7.1） |
| 红线 8 | 上述同构文件不得引用 `document` / `window` / `createImageBitmap` | 同构性的另一半 |
| 红线 4 | 不得出现 `FaceCullingSystem` / `ChunkConsolidation` / `BlockScatterManager` / `GlobalInstancedMeshManager` 等 mc-lite 补丁类名 | **只查非注释行**——`mesher.js:51` 的 `ChunkConsolidation.js:530` 是出处注释，必须放行 |
| 红线 2 | 不得出现 `safeBounds` / `WorldBoundsController` | 世界无边界 |
| 红线 6 | 不得出现 `Raycaster` / `intersectObjects`（`src/player/raycast.js` 的注释除外） | 地形交互走体素 DDA |
| 红线 5 | 顶点格式必须 flat 三属性；BatchedMesh 三级兜底存在 | 查 `_ensureCapacity` 存在性 |
| §3 分层 | 依赖方向单向：`voxel ← gen ← mesh ← render` | 见 §7.2 已知例外 |

### 7.1 已知例外（白名单，需注明理由）

| 例外 | 理由 |
|---|---|
| `src/mesh/atlas-loader.js` import three | 它**不是** Worker 同构模块——只被 `core/game.js` 消费，负责运行时加载 atlas 纹理（必然依赖 three）。分层归属应为 `render/`，但历史放在 `mesh/`。**不移动**（属架构改动，需设计文档先行），在白名单注明 |
| `src/core/**` 依赖任何层 | `core/` 是**装配层**（`game.js` 组装全部子系统），必然依赖所有层。CLAUDE.md 原写「core/ 不依赖 voxel/」**是错的**，已修正 |

### 7.2 依赖方向的已知例外（待决策，不擅自修）

`src/voxel/world-data.js:6` → `import { recomputeSkylightAt } from '../mesh/lighting.js'`
是**反向依赖**（设计文档 §3 分层图：`voxel ← gen ← mesh`，voxel 不得依赖 mesh）。

- **为什么存在**：红线 11 要求「编辑快路径同步重算垂直单列且只升不降」，
  `WorldData.set()` 必须在主线程同步调光照算法
- **为什么不算红线回退**：`lighting.js` 是 Worker 同构纯函数（不 import three、无 DOM），
  这是**算法依赖不是渲染依赖**；voxel 仍「不知道渲染存在」
- **门禁处理**：列入白名单并注明理由，**不擅自重构**（把 `recomputeSkylightAt` 挪进 voxel 层
  属架构改动，须先改设计文档 §3 分层图再动代码）

---

## 8. 与未来 Epic 的关系（M4~M7）

M4~M7 的 plan 文档已按「全部任务 RED-GREEN」写成。本分级策略生效后：

- **Tier 1 部分不变**：`WorldEditor` 批量语义、DDA hitscan、`EntityManager` 版本协议、
  实体 AABB raycast、持久实体 snapshot 的可取消保存、`ZombieService` 20Hz AI 批次语义
  —— 全部仍须 RED-GREEN（这些是机制/API/稳定性，符合 §2.1 判据）
- **Tier 3 部分放宽**：`WEAPON_ASSET_URLS` 路径常量、武器视图模型的 transform 数值
  （`rotationOrder==='YXZ'`、`MAX_ACTIVE_TRACERS===32` 属**设计常量**保留；
  但 GLB 路径字符串改错免测试）、HUD 武器名文案
- **新增门禁要求**：M5 的 `src/entities/**` 不得 import three / 不得新增 Worker
  （M5 plan Task 1 已写 `rg -n "from 'three'|new Worker" src/entities`）→ 纳入 `check:arch` 白名单式检查

判据不变：**问「改坏了能不能玩出来」，而不是「这是不是新 Epic」**。

---

## 9. 本文的自检

本策略自身也须遵守分级：

- **本文属 Tier 3**（文档措辞）→ 改本文免测试，只需 lint
- **但 §6 的门禁映射表属 Tier 1**（它决定热路径是否跑 bench）→ 改这张表须谨慎，
  漏掉一个热路径目录会让性能回退静默逃逸
- `tools/check-*.mjs` 自身属 **Tier 1**（门禁脚本错了会放行错误）→ 须有断言覆盖其判定逻辑
  - **例外（用户决策，2026-09-03）**：`tools/icon-fingerprint.mjs` **不做自动化测试覆盖**。
    理由：正确性由「烘焙脚本与门禁共用同一份代码」这一结构保证（红线 1，不存在两份会漂移的实现），
    加上落地时的三条路径负向验证（改几何 / 改贴图映射 / 换同名 PNG 内容）。它是 `tools/` 离线脚本、
    非运行时热路径。**代价**：若将来改 `texHash()` 或 `FLAT_BLOCKS` 判定，须自行重跑那三条负向验证，
    没有测试会自动兜住——这是已知取舍，不是遗漏。
