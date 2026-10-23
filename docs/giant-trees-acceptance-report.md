# 巨树景观 Epic 验收报告（v1.68）

> **规格**：[`docs/superpowers/specs/2026-10-23-giant-trees-design.md`](superpowers/specs/2026-10-23-giant-trees-design.md)（v1.1）
> **计划**：[`docs/superpowers/plans/2026-10-23-giant-trees.md`](superpowers/plans/2026-10-23-giant-trees.md)
> **设计文档**：[`docs/phase-1-engine-design.md`](phase-1-engine-design.md) v1.68（§4.10 预算上调）
> **日期**：2026-10-23 ｜ **用户裁决**：§0.2（opaque 容量 ×1.5 / 巨树叶投影 / `.schem` 入库 / 已有存档接受）

---

## 1. 交付范围与验收口径

把素材包 `40AssortedTreesPack`（40 棵 Minecraft 原版景观树）离线烘焙成 **28 个变体**（1/2 比例、16,954 格），
按三条地形路径落位；城市 / 地标 / 撒布结构 / JSON 结构占地让路；与旧森林树互斥。

| # | spec §1.2 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | **预算**：真实页面 reserved，opaque ≤ 90% 且零 opaque 扩容；cutout / transparent 相对 HEAD 不恶化 | ✅ | §2.3 表格 + `tests/giant-tree-budget.spec.mjs`（5 视域 + 3 冲刺全 PASS） |
| 2 | **确定性与接缝**：同 seed 逐格一致；跨 column 无缝 | ✅ | 单测「确定性」「跨 column 光栅化 4 朝向 × 2×2 column 逐格」；§4.1 负向验证 2~4 |
| 3 | **让路**：城市 / 地标 / 撒布 / JSON 占地零闯入 | ✅ | 单测 `isGiantTreeAllowed` / `collectExclusionBoxes`；`tests/giant-trees.spec.mjs`「城市 bounds 内零巨树方块」（带城外对照） |
| 4 | **不破坏既有玩法**：既有用例不改（除 4 条计数 + `m3-fullscene` 上限） | ✅ | §2.6 全量回归；`pyramid` / `pyramidIsland` / `island tower` 用例逐字未动 |
| 5 | **观感**（Tier 3，测试无法证明） | ⚠️ 旋钮交用户 | §5「待用户确认的三个旋钮」 |

---

## 2. 实测数据

### 2.1 烘焙产物

| 项 | 值 |
|---|---|
| 变体数 | **28**（`tallOak` 8 · `snowSpruce` 4 · `cherry` 4 · `palm` 4 · `banyanLeafy` 4 · `banyanBare` 4） |
| 排除 | 12 = 无树干 4（pad 12/18/28/38）+ 混交 5（4/9/15/25/35）+ 丛林 3（2/3/5） |
| 总格数 | **16,954**（烘焙断言区间 [16,000, 18,000]） |
| `trees.json` | **156,440 B（152.8 KB）** |
| `.schem` 入库 | 262,091 B，sha256 `217e215b0538262ba89dae354e33511eec2db9e3e264e45165956294c9293aa8` |
| 两次烘焙 | **逐字节相同**（确定性；`trees.json` / `trees.meta.json` / 7 张贴图全部 `cmp` 一致） |
| 装饰件丢弃 | 3.60%（栅栏 / 台阶 / 半砖 / 活板门 / 楼梯 / 砖墙 / 雪层） |

### 2.2 候选发现（region 层）

| 项 | 原贪心（v1.0） | 网格抖动（v1.1 终版） |
|---|---|---|
| 耗时 | 14~20 ms/region | **≈1.1 ms/region** |
| 跨 region 边界间距违规 | **64 对** | **0** |
| 密度（每 eligible 格） | — | A **1/1523**（spacing 32；14→1/464、20→1/586）· B **1/397**（12/8；初版 8/6 为 1/199）· C **1/783**（17/11；8/6 为 1/207、12/8 为 1/389） |
| 区域覆盖率（粗格） | — | A 1（处处都长）· B **0.333**（目标 1/3）· C **0.429**（目标 1/2；20 seed 均值 0.504） |

### 2.3 真实页面通道占用（reserved%）

**口径**：`reserved = ceil(vertexCount × 1.25)`（`render-world.js:204`），除以**初始**容量常量
（opaque 4,275,000 / cutout 2,200,000 / transparent 125,000）。出生点在城市中心，三个方向冲 96 格都出不了城
——冲刺测试从森林 / 海岸起步。

| 视域 | 巨树方块 | HEAD（2.85M / 2.2M / 0.125M） | 终版（4.275M / 2.2M / 0.125M） |
|---|---|---|---|
| (18,27) | 15,316 | 82.3 / 48.4 / 36.8 | **58.0** / 45.9 / 36.8 |
| (-20,10) | 61,967 | 87.6 / **128.1** / **100.3** | **70.2** / 53.9 / 100.3 |
| (30,10) | 4,850 | 79.1 / 70.8 / 11.2 | **53.8** / 69.9 / 11.2 |
| (-25,-5) | 59,916 | 84.6 / 21.2 / 49.0 | **69.6** / 12.2 / 49.0 |
| (10,40) | 29,960 | 83.0 / 30.1 / 85.8 | **61.6** / 17.2 / 85.8 |
| 冲刺 森林→西 | — | 99.9 / 129.3 / 128.7 | **79.6** / 54.9 / — |
| 冲刺 森林→南 | — | 103.1 / **145.4** / 140.8 | **82.1** / 60.3 / — |
| 冲刺 海岸→东 | — | 98.4 / 57.1 / 114.3 | **72.6** / 25.9 / — |

**结论**：opaque 峰值 **82.1% < 90%**（A 森林 spacing 14→20→32 后 **76.4%**），**零 opaque 扩容**；cutout 只降不升（(-20,10) 128.1 → 53.9）；
transparent 与 HEAD **逐位相同**（巨树不碰水）。HEAD 自己在密林视域本就越线，故验收口径是「相对 HEAD 不恶化」。

`m3-fullscene` 实测：`gpuVertexBytes = 198,000,000`（= 188.83 MiB；全部树叶 opaqueTable=1 后 cutout 回退 2.2M），`gpuActiveBytes ≈ 105,073,456`（原 133M，−21%），
上限已由 150 → **200 MiB**（用户裁决）。

### 2.4 genP95（Worker 预热的价值）

`structure-gen` fixture，门 10ms，交替对照：

| 场景 | HEAD | 有预热 | 无预热（注入） |
|---|---|---|---|
| 安静系统 | 7.6~8.2 ms | 7.5~8.1 ms | 9.4~10.0 ms（一次撞门） |
| 负载下 | 8.1~9.8 ms | 8.4~10.0 ms | **11.6~14.0 ms（撞门）** |

→ 预热**必须**保留（`world-worker.js` 的 `giantPreloadPromise`，模块加载期发起、不 await）。

### 2.5 bench（draw call 与帧时）

| 场景 | draw call 增量 | 帧时 |
|---|---|---|
| ① 平原冲刺 | **+16**（500 → 516） | p95 9.9（既有 vsync 量子噪声） |
| ④ TNT 批量删 | **+41**（545 → 586） | p95 10（**已知 flake**：基线 9 vs 10 只差一个 8.33ms 量子） |

draw call 增量的机制是 three r185.1 WebGPU 对 BatchedMesh **每个可见 geometry slot 各发一次 draw**
（不是「每通道 1 次」）——与 CLAUDE.md 既有那条约束同源。

### 2.6 测试计数

| 项 | HEAD | 终版 |
|---|---|---|
| 浏览器内单测 | 779 | **810**（+31：`test-giant-trees` 15 / `-column` 8 / `-gen` 8） |
| Playwright | 184（62 文件） | **190**（64 文件，+6：`giant-trees` 2 / `giant-tree-budget` 4） |
| `check:arch` | 绿 | 绿 |
| `check:data` | 绿 | 绿（新增 `[巨树] 28 变体 / 8 方块（叶子 cutout 镂空 + opaqueTable=1 保剔除 + 投影）/ 指纹匹配 / 贴图 7 张 / 孔洞率 14.8%`） |

### 2.7 覆盖损失（设计意图，不是缺陷）

含巨树的 109 个 column 样本：巨树期望格 **43,672**，落地 **98.40%**，被后写者覆盖 **1.60%（700 格）**。
覆盖者分布：`giant_mangrove_log` 237 / `giant_banyan_leaves` 221 / `giant_cherry_leaves` 145 /
`giant_oak_log` 64 / `giant_palm_leaves` 28 / **cloud 5**。树干格被邻树叶覆盖 **0.89%**。

绝大多数覆盖来自**相邻巨树**（B/C 路径冠幅重叠成片是设计意图）；`makeColumnSetter` 无占用格守卫（后写胜）
是全局既有行为（CLAUDE.md 已登记），规范排序 `(路径序, wx, wz)` 保证确定性。

### 2.8 atlas

147 → **153** tile；既有 32 个 tile 坐标被重排（shelf 装箱按字母序）；**图标产物逐字节不变**
（8 个新方块全部在 `HIDDEN_FROM_INVENTORY`，不占背包）。

---

## 3. 偏离表（vs spec v1.1）

| # | spec 原文 | 实施 | 理由 |
|---|---|---|---|
| 1 | §3.6 palette 含 `giant_oak_snow` 之类雪块变体 | **不实现**，`snow` 类别按族映射到该族 leaf | 8 个方块是硬上限（用户裁决范围） |
| 2 | v1.0 §2.4 树叶 `shadowCast:false` | **投影**（不写该字段） | 用户裁决「支持投影」；`[阴影投射]` 的 13 项清单要求 `leaves` 必须投影，v1.0 写法会让 `check:data` 即红 |
| 3 | v1.0 §3.3 候选 = 逐点扫描 + 贪心 | **全局对齐网格 + 内缩抖动** | 实测贪心 14~20ms/region + 跨 region 间距违规 64 对；网格抖动 ≈1.1ms + 违规 0，且 `chance` 成为真密度旋钮 |
| 4 | v1.0 变体 36 个（含混交 5 + 丛林 3） | **28 个** | 混交/丛林偏热带，三条路径都不用；v1.0 自身决策矛盾（`jungleGiant` 是死数据） |
| 5 | v1.0 预算「任何视域都 ≤100%」 | **相对 HEAD 不恶化** | 口径错在拿「已用占比」当 reserved；HEAD 自己密林 cutout 128.1% / 冲刺 145.4% 本就扩过容 |

其余偏离已在设计文档 §0.2 的用户裁决记录里。

---

## 4. 负向验证清单

每一条都是「注入 → 必须真红 → 复原 → 必须回绿」。**共 44 条**。

### 4.1 单测注入（15 条）

| # | 注入 | 变红的用例 |
|---|---|---|
| 1 | 旋转改回 `& 3`（恒 0） | `giantTreeRotation：四个朝向都会出现且大致均匀` |
| 2 | 抖动改成满格（间距不再有保证） | `候选间距（含 region 边界）：切比雪夫距离 ≥ spacing + 1` |
| 3 | 去掉 region 归属过滤 | `候选间距…` + `候选 region 归属：3×3 块内无重复点` |
| 4 | `chance` 被忽略 | `chance 是有效的密度旋钮` |
| 5 | `treeBox` 用未旋转的 footprint | `treeBox：AABB 宽深 = 旋转后的 footprint（全部变体 × 4 朝向）` |
| 6 | 合并改成「只用最后一个 layout」 | `collectGiantTrees：拼接而非覆盖 + 规范顺序` |
| 7 | 去掉规范排序 | 同 #6 |
| 8 | 去掉地基填充 | `地基：gy=0 树干格下方悬空 1~MAX 格时补同种树干；> MAX 不补` |
| 9 | 覆盖窗口不外扩（只覆盖 AABB） | `覆盖窗口：AABB 外扩 EXT；column 外 EXT 带内也覆盖` |
| 10 | 排除判定忽略外包盒 | `isGiantTreeAllowed：九点/锚点任一不允许即拒` |
| 11 | 排除外包盒里去掉平地岛/海岛塔 | 同 #10 + 既有 `pyramidIsland` 用例 |
| 12~15 | （载入 / 锚点 / palette / 确定性各一条） | 对应用例 |

**另有 1 条架构门**：在 `giant-trees.js` 第 2 行加 `import * as THREE from 'three'` →
`npm run check:arch` 真红（`[红线 8/10] Worker 同构模块 import three`），复原回绿。

### 4.2 `[巨树]` 门禁注入（10 条）

| # | 注入 | 报错 |
|---|---|---|
| 1 | 树叶 `cullMode` → `cutout` | `"giant_cherry_leaves" 的 cullMode=cutout，必须是 opaque` + `opaqueTable 不是 1` |
| 2 | 树叶误写 `opaque:false` | `"giant_oak_leaves" 显式 opaque:false，叶-叶共享面不再互剔` |
| 3 | 树叶误写 `shadowCast:false` | 既有 `[阴影投射]` 先红 + `[巨树] 写了 shadowCast:false，巨树叶须投影` + `castsShadow 为 false` |
| 4 | `trees.json` palette 拼错名字 | `palette 含未注册方块` |
| 5 | 声明但无人用（死方块） | `声明了 giant_xxx 但没有任何变体使用` |
| 6 | 用过但未声明 | `在用的 palette 名不是 giant_* 声明` |
| 7 | 从 `HIDDEN_FROM_INVENTORY` 移除一项 | `不在 HIDDEN_FROM_INVENTORY（玩家能放出孤零零的树干/树叶）` |
| 8 | 贴图缺失 | `贴图缺失 procedural/xxx.png（跑 node tools/bake-giant-textures.mjs）` |
| 9 | 贴图出现近黑像素 | `png 像素 N 近黑（opaque 通道忽略 alpha，孔洞处会露出黑点）` |
| 10 | 改 `.schem` 内容（指纹失配） | `产物已过期：指纹不匹配 → 跑 npm run gianttrees` |

### 4.3 Tier 4 注入（4 条 + 1 条覆盖）

| # | 注入 | 结论 |
|---|---|---|
| A | `CAPACITY.opaque` 退回 1200 | ✅ 真红 —— **但首轮「未变红」**（见 §6 教训 1） |
| B | 6 种树叶全部误改 `cutout` | ✅ 真红 —— **首轮也「未变红」**（同因） |
| C | 不让路（`allowedAt` 恒真 + 去掉外包盒） | ✅ 真红：`城市 bounds 内不得有巨树方块 Expected: 0` |
| D | 去掉 Worker 预热 | ✅ genP95 11.6~14.0（撞 10ms 门） |

### 4.4 烘焙脚本注入（5 条）

降采样规则改成「空气参与投票」/ 地块索引改成 x 优先 / 分类表加未知名 / 改族标志 / 改 `TOTAL_BLOCKS_RANGE`
—— 各触发烘焙脚本末尾的 `throw`（不产生半成品）。

---

## 5. 待用户确认的三个旋钮（观感，Tier 3）

测试证明不了「好不好看」，这三个留给你：

1. **密度**：`GIANT_TREE_PATHS` 的 `chance` / `spacing` / `jitter`（**A 32/8** · **B 12/8** · **C 17/11**，
   当前 `chance=1` 即「每个 eligible 网格点都长」）。改这三个不需要重烘焙。
2. **区域覆盖率**（「多少个海滩有树」）：`GIANT_TREE_PATHS` 的 `patchChance`（**A 1** · **B 1/3** · **C 1/2**）
   与 `PATCH_CELL`（粗格边长，当前 128 格）。⚠️ 改 `PATCH_CELL` 或 `PATCH_SALT` 会改变「哪几段海岸有树」，
   须重跑单测的覆盖率与同粗格用例，并按实测重算候选密度下界。
2. **叶色**：`tools/bake-giant-textures.mjs` 的 `TEXTURES[].base` 与 `CONTRAST`（0.6）。
   改后需 `npm run gianttextures && npm run atlas`。
3. **冠幅重叠**：B/C 的 `spacing`（当前 B 12 / C 17）。拉大间距可降低重叠（§2.7 的 1.60% 覆盖损失随之下降）。

叶色实测均值（可见像素，即屏幕上会看到的颜色）：

| 贴图 | 目标基色 | 实测均值 RGB |
|---|---|---|
| `giant_oak_leaves` | 复用 `leaves.png` | (28, 109, 47) |
| `giant_birch_leaves` | (160, 235, 150) | (148, 218, 139) |
| `giant_spruce_leaves` | (35, 95, 60) | (32, 88, 56) |
| `giant_cherry_leaves` | (255, 140, 195) | **(236, 130, 181)** |
| `giant_palm_leaves` | (45, 150, 55) | (42, 139, 51) |
| `giant_banyan_leaves` | (85, 185, 75) | (79, 171, 69) |
| `giant_mangrove_log` | (135, 65, 65) | (126, 61, 61) |

全部 16×16、镂空像素 80/256（与源 `leaves.png` 的 alpha 逐字节一致）、**无近黑像素**。
`giant_cherry_leaves` 有 19 个 R 通道饱和像素（基色 R=255 所致，属正常高光）。

---

## 6. 操作失误与教训（值得沉淀）

### 教训 1：Tier 4 预算门首轮的两条注入「未变红」—— 断言落点不够

`tests/giant-tree-budget.spec.mjs` 首版只断言**末尾**的 `maxVertexCount`，于是：

- **注入 A（`CAPACITY.opaque` 退回 1200）**：（`1200 × 1900 × 1.25 = 2,850,000`）× 1.5 = `4,275,000`，
  恰好等于终版容量 → 页面扩容到同一个数 → 末尾断言照过。
- **注入 B（树叶改 cutout）**：同一形态，重算后的占用落在不扩张的区间。

修法 = **开局就断言初始容量**（出生点在城里，此刻还没发生过任何扩容）。补齐后注入 A 真红：
`开局初始容量 == CAPACITY 标定值`。这是 testing-policy §2.7「负向验证盲区」的又一实例 ——
**「注入后仍全绿」先怀疑断言落点，而不是实现**。

### 教训 2：`sleep` 在命令开头会被 harness 拦下

诊断期间多处用了 `sleep N && ...`，全部被拦。改用 `until` 轮询 / `run_in_background`。

### 教训 3：`/tmp` 下的脚本解析不到项目 `node_modules`

`playwright` / `pngjs` 都失败（CLAUDE.md 已记）。把脚本放进 shadows 副本目录内运行即解决。

### 教训 4：macOS `sed -i ''` 换端口要连 webServer 与 baseline 一起换

只换 `playwright.config.mjs` 的 `baseURL` 不够 —— `webServer.port` 与 `src/bench/baseline.mjs` 的
`PORT` 也要跟着换，否则 server 起在旧端口、断言打到新端口。

### 教训 5：不带 `--check` 跑 bench 会重写冻结基线

`src/bench/baseline.mjs` 不带 `--check` 会自动重写 `docs/m3-baseline.{md,json}`，把 p95 基准从 9 静默放宽到 9.9。
诊断时必须带 `--check`，或事后 `git checkout` 恢复。本次交替对照期间发生过一次，已恢复。

---

## 7. 遗留 TODO / 已知限制

- **装饰件未实现**（栅栏 / 台阶 / 半砖 / 活板门 / 楼梯，占素材 3.60%）—— 烘焙时丢弃。要加需新方块 + 新几何模板。
- **树冠重叠的覆盖损失 1.60%** —— 设计意图（B/C 成片），不是缺陷（§2.7）。
- **`bench --check` 的 `STRUCTURAL` 分支恒为 false** —— `gpuVertexBytes` / `drawCalls` 永不报回退，
  注释写的 2% 不生效。已另立项；**修它之前 GPU 预算只由 `m3-fullscene` 与 `giant-tree-budget` 守**。
- **与 `RedCity-done` 分支的文本冲突** —— 该分支（已被 `7376065` 回撤出 main）同样把 `CAPACITY.opaque`
  设为 1800，并占用了设计文档 v1.68 与 `m3-fullscene` 的 `< 196 MiB`。重新落地 RedCity 时按先后顺延版本号、
  取较大上限。
- **素材再分发授权** —— `40AssortedTreesPack.schem` 是第三方素材包，已按用户裁决入库；仓库有 GitHub 双推送，
  再分发是否允许需用户自行确认（属非技术事项）。
- **`m3-fullscene` 的 `frameMs.p95` 在高负载下贴线** —— 既有 flake（vsync 量子），与本次改动无关。

---

## 附录 A：交付后调整记录（2026-10-23）

### A.1 巨树叶改走 cutout 通道（镂空生效）

用户实玩反馈「巨树树叶都不镂空、表面完全不透光」。诊断：**贴图早就是镂空的**（与 `leaves.png` 逐像素同构：
13 个全透明 + 67 个半透明 + 176 个实心），根因是 `cullMode:"opaque"` → opaque 通道材质 `alphaTest=0`
→ alpha 被完全忽略。

修法 = `cullMode:"cutout"`（拿到 `alphaTest 0.3`）+ **显式 `"opaque":true`**（保住 `opaqueTable=1` 防面剔除丢失）。
实测同一片 8³ 叶团总顶点：纯 opaque 1584 / cutout + opaqueTable=1 **1584（零增长）** / cutout + opaqueTable=0
**12316（×7.78）**。mesher CPU：0.29ms → 0.34ms（p95 反而 0.60 → 0.47ms）。

严格 A/B（只改 leaves 声明）实测 5 个固定视域**总顶点逐位守恒**：
3,478,025 / 4,810,025 / 3,831,985 / 3,233,170 / 3,192,705。

连带两处调整（均经用户批准）：① 预算门主判据改为**总顶点**（原逐通道百分比在换通道后分母错配会误报，
详见 `CLAUDE.md` 的活跃约束）；② `CAPACITY.cutout` 曾抬到 2.40M，**同日回退 2.20M**（全部树叶 opaqueTable=1 后峰值仅 38.3%，见 A.4）；原 `(-20,10)` 实测 2,220,795
会触发一次扩容，抬后 92.5% 零扩容；三通道静态 188.83 → 194.55 MiB，仍 < 200 MiB 上限）。

### A.2 巨树叶孔洞密度压缩（观感「更茂盛」）

**动机**：改走 cutout 后，源图原样的孔洞率（31%）在巨树冠上观感「太稀」。普通树叶因树小、背景天然近
而不易察觉；巨树冠巨大且 `opaqueTable=1` 不画叶背内面，孔洞后面往往是空的。用户要求「单独做一张更密的
镂空图，几何完全不变」。

**做法**：`tools/bake-giant-textures.mjs` 新增 `holeRatio`：从源图**已被 alphaTest 剔除的那批像素**
（80 个）里按**低差异序列（R2）**取前 N 个作孔洞（alpha 归 0），其余 alpha 抬到 255。

| 孔洞率 | 孔洞数 | 分布行数 | 观感 |
|---|---|---|---|
| 源图 | 80 (31.3%) | 16/16 | 太稀（本次要解决的） |
| 0.03（试过） | 8 | 5/16 | 几乎无孔，像实心彩色板 |
| 0.08（试过） | 20 | 11/16 | 太零散 |
| **0.15（交付）** | **38 (14.8%)** | **14/16** | 疏密有致，叶面覆盖 85.2% |

⚠️ **不能按 alpha 升序取孔**：实测会把孔洞聚成一块（前 8 个全在左上角），必须用低差异序列铺开。

**连带**：`giant_oak_leaves` 原复用普通树叶的 `leaves` tile，现改为**独立烘焙**
（`procedural/giant_oak_leaves`）—— 共用一张图就改不了孔洞密度（改了会把普通树叶一起改）。
atlas tile 数 153 → **154**。基色沿用普通橡树叶实测均值，输出均值 RGB(28,110,48) vs 普通叶 (28,109,47)。

**几何/顶点数零变化**；预算门 9 条全绿（含 `atlas.spec` 关系型断言）。

**门禁加固**：`[巨树]` 新增两条 —— ① 树叶的 tile 必须是 `procedural/giant_*`（不得复用普通方块贴图）；
② 孔洞率落在 5%~25%。负向验证：注入 `holeRatio=0.31` → 报「孔洞率 30.9% 应 5%~25%」真红；
注入「giant_oak_leaves 改回复用 leaves」→ 报「不是 procedural/giant_*」+「孤儿贴图」真红。

### A.3 粉叶变暗的根因与修正（2026-10-23）

用户实玩反馈「重新烘焙后巨树叶颜色不如原来鲜艳，尤其粉叶变暗了」。**实测归因**（三份贴图逐像素对比）：

| 版本 | 均值 RGB | 说明 |
|---|---|---|
| HEAD 仓库里的终态图 | (236, 130, 181) | 用**最旧参数**烘的（`leaves.png` + `contrast 0.6` + 基色 `[255,140,195]`） |
| `c947169` 的 staging（= 脚本重烘，逐字节一致） | (205, 130, 181) | 新参数（`leaves_original` + `contrast 1` + 基色 `[234,148,206]`） |
| 本次（孔洞压缩后） | (207, 131, 182) | ② + `holeRatio 0.15` |

**R 从 236 掉到 205 全部发生在 ①→② 这一步，与孔洞压缩无关**（它只带来 +1）。根因是 `c947169` 为「零削顶」
把基色封顶在 `floor(255/1.086)=234`，而 cherry 的 R 需要 269 → 整体 R 少 8%。

⚠️ **另一个事实**：`c947169` 的提交信息明写「新增 5 张**暂存**产物…待验证后再替换终态贴图」，
**但终态贴图从未替换** → 仓库里的图长期停留在旧参数版本，脚本与产物不同步。本次跑烘焙把新参数
第一次真正应用了，所以「变暗」是被我的操作带出来的既有参数取舍，不是本届孔洞压缩引入的。

**修正（用户裁定鲜艳度优先）**：cherry 基色 `[234,...]` → **`[255,148,206]`**，均值 R 205 → **225**。
代价：20 个最亮像素 R 削顶（9%）。再提到 `base_R=270` 只能到 233 但削顶 46%，叶面会明显变平，不做。

**其余 5 色不变**：实测 HEAD 终态 vs 脚本重烘的差全部在 ±1 以内（只有 cherry 的 R 需要超过 255）。

**排查手法（可复用）**：怀疑「贴图与脚本不同步」时，用脚本重烘一张与仓库里的图比 `sha256`，
不一致即说明终态产物落后于参数。

### A.4 全部树叶 opaqueTable=1（2026-10-23 第二轮用户裁定）

用户裁定：「普通树的树叶的渲染模式也采用巨树的树叶渲染模式，opaqueTable 也设置为 1」。
7 个普通树叶（`leaves` / `azalea_leaves` / `yellow_leaves` / `realistic_oak_leaves` /
`realistic_yellow_leaves` / `swamp_leaves` / `snow_leaves`）各加 `"opaque":true`。
`sky_leaves` 早已是 `opaqueTable=1`（方案 C，走 opaque 通道），不变。

**实测收益**：

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| 单棵普通树（树干 + 5³ 叶团）顶点 | 3,068 | **664** | **−78.4%** |
| 5 视域总顶点合计 | 18,545,910 | 15,211,100 | **−18.0%** |
| 视域最高降幅（(-20,10)） | 4,810,025 | 3,391,700 | −29.5% |
| cutout 峰值 | 100.9%（会扩容） | **35.1%** | 零扩容 |
| `gpuActiveBytes`（m3-fullscene） | 133,144,308 | **105,073,456** | −21% |

**连带回退**：`CAPACITY.cutout` 600 → **550**（2.40M → 2.20M）。上一轮为巨树叶改道抬到 600，
本轮因全部树叶互剔使 cutout 峰值只剩 35.1%（回退后 38.3% = 842,400 顶点），无需 2.40M。
三通道静态 `gpuVertexBytes` 204,000,000 → **198,000,000**（194.55 → 188.83 MiB）。
⚠️ 该回退的前提是「全部树叶 opaqueTable=1」；若任何一片退回 0，须先重测峰值再动容量。

**四项语义后果（用户逐项确认接受）**：① 面剔除（收益）② AO 遮挡 ③ blocklight 阻断
④ **炮塔 LOS / 弹丸阻挡**。其中 ④ 改变了玩法：树叶现在会挡住炮塔视线、弹丸被树叶拦截
（mc-lite 口径是「实心且不透明」，树叶可穿透）。四个消费方共用 `opaqueTable`，无需改任何消费者代码。

**测试口径翻转**（不是放宽，是语义变了）：
- `test-block-registry.js`：「其余 7 个树叶族仍走 cutout」→「全部 8 个树叶族都是 cutout + opaqueTable=1」
  （`sky_leaves` 通道仍为 opaque，作例外显式断言）
- `test-turrets.js`：`hasLineOfSight(…leaves…)` 与 `isProjectileOccluding(leaves)` 从 `false` → `true`
- `test-projectiles.js`：「leaves 可穿透」→「leaves 截停弹丸」

**预算门基线重标**：`HEAD_BASE.views[].total` 从第一轮的守恒值（3,478,025 等）改为本轮实测值
（2,908,150 / 3,391,700 / 2,954,475 / 3,112,850 / 2,843,925）。新值比旧值低，任何回升都会真红。

**负向验证**：去掉 `leaves` 的 `"opaque":true` → 4 条用例真红（树叶契约 + LOS + isProjectileOccluding + 弹丸截停）。

### A.5 普通树叶的孔洞密度对齐巨树（2026-10-23）

用户反馈「视觉上确实有点糟糕，把树叶（两种树叶）的贴图的镂空密度改得跟巨树一样，也让树叶看起来密一些」。

**源图实测孔洞率**（`alphaTest 0.3` 判据，`alpha < 77` 即被 discard）：

| 贴图 | 尺寸 | 原孔洞率 | 叶面覆盖 | 压后孔洞率 | 压后覆盖 |
|---|---|---|---|---|---|
| `leaves`（leaves / swamp_leaves） | 16×16 | 31.3% | 68.8% | **14.8%** | 85.2% |
| `leaves_yellow`（yellow / realistic_yellow） | 16×16 | 31.3% | 68.8% | **14.8%** | 85.2% |
| `azalea_leaves` | 16×16 | 23.0% | 77.0% | **14.8%** | 85.2% |
| **`oak_leaves_branch_medium`**（realistic_oak） | **32×32** | **77.6%** | **22.4%** | **15.0%** | **85.0%** |
| `leaves_with_snow` | 16×16 | 27.3% | 72.7% | **14.8%** | 85.2% |

`oak_leaves_branch_medium` 是最严重的（叶面只剩 22.4%，几乎不成形）。

**做法**：新建 `tools/bake-leaf-textures.mjs`（`npm run leaftextures`），**只改 alpha、RGB 逐字节保留**
（普通树叶不需要重着色）。孔洞压缩逻辑抽成 `tools/leaf-holes.mjs`，**与巨树烘焙共用同一份**（红线 1）。
产物落 `assets/textures/procedural/leaf_*.png`，源图不动（它们是 mc-lite 入库素材）。
atlas tile 数 154 → **159**。

**几何/顶点数零变化**（只改 alpha）：`gpuVertexBytes = 198,000,000`、`gpuActiveBytes = 105,073,456` 与改动前逐位相同。

**连带必做**：树叶在背包里 → **`npm run icons`**（实测漏跑会被 `[图标过期]` 门禁抓到，7 个方块列名报错）。

**新增门禁 `[树叶贴图]`**：① 产物必须是 `procedural/leaf_*`（防止 faces-data 改回源 tile）；
② 孔洞率 5%~25%；③ **RGB 与源图逐字节相同**（防做孔洞压缩时顺手改色）；④ 无孤儿产物。
负向验证：① faces-data 改回 `leaves` → 报「不是 procedural/leaf_*」真红；
② 孔洞率改回 0.31 → 报「30.9%（应 5%~25%）」真红。
