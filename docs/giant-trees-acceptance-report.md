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
| 两次烘焙 | **逐字节相同**（确定性；`trees.json` / `trees.meta.json` / 6 张贴图全部 `cmp` 一致） |
| 装饰件丢弃 | 3.60%（栅栏 / 台阶 / 半砖 / 活板门 / 楼梯 / 砖墙 / 雪层） |

### 2.2 候选发现（region 层）

| 项 | 原贪心（v1.0） | 网格抖动（v1.1 终版） |
|---|---|---|
| 耗时 | 14~20 ms/region | **≈1.1 ms/region** |
| 跨 region 边界间距违规 | **64 对** | **0** |
| 密度（每 eligible 格） | — | A **1/1523**（spacing 32；14→1/464、20→1/586）· B **1/397**（12/8；初版 8/6 为 1/199）· C 1/200 |

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

`m3-fullscene` 实测：`gpuVertexBytes = 198,000,000`（= 188.83 MiB），`gpuActiveBytes ≈ 133,144,308`，
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
| `check:data` | 绿 | 绿（新增 `[巨树] 28 变体 / 8 方块（叶子 opaque 且投影）/ 指纹匹配 / 贴图 6 张`） |

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

1. **密度**：`GIANT_TREE_PATHS` 的 `chance` / `spacing` / `jitter`（**A 32/8** · **B 12/8** · C 8/6，
   当前 `chance=1` 即「每个 eligible 网格点都长」）。改这三个不需要重烘焙。
2. **叶色**：`tools/bake-giant-textures.mjs` 的 `TEXTURES[].base` 与 `CONTRAST`（0.6）。
   改后需 `npm run gianttextures && npm run atlas`。
3. **冠幅重叠**：B/C 的 `spacing`（当前 8）。提到 10~12 约降 1/3~1/2 的重叠（§2.7 的 1.60% 覆盖损失随之下降）。

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
