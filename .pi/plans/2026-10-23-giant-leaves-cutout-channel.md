# 巨树叶改用 cutout 通道（拿到镂空渲染，保住面剔除）

日期：2026-10-23
状态：已批准，待实施

## 1. 问题

用户实玩反馈：「巨树的树叶都不是镂空的，表面都是完全不透光的」。用户已重烘焙了镂空贴图，要求应用到对应方块。

### 诊断结论（实测，非推断）

**贴图早就是镂空的**，不需要任何重烘焙。实测 6 张巨树叶贴图与 `leaves.png` 的 alpha 分布逐项一致：

| 贴图 | a=0（全透） | 0<a<77 | a≥77（实心） |
|---|---|---|---|
| `leaves.png` | 13 | 67 | 176 |
| `giant_birch_leaves.png` | 13 | 67 | 176 |
| `giant_spruce_leaves.png` | 13 | 67 | 176 |
| `giant_cherry_leaves.png` | 13 | 67 | 176 |
| `giant_palm_leaves.png` | 13 | 67 | 176 |
| `giant_banyan_leaves.png` | 13 | 67 | 176 |

（`giant_oak_leaves` 直接复用既有 `leaves` tile，见 `faces-data.js`。）

真正原因在 `src/voxel/blocks-data.js:188-193`：

```js
{"name":"giant_oak_leaves","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
```

`cullMode: "opaque"` → 进 opaque 通道 → 该通道材质 `alphaTest = 0`（`src/render/materials.js:189` 只有 cutout 才 `alphaTest: 0.3`）→ **alpha 被完全忽略**，13 个孔洞像素照常渲染出颜色 → 观感是「完全不透光的实心块」。

## 2. 关键取舍：改通道不能丢掉面剔除

巨树叶占巨树方块总量的 **80.6%**（13,662 / 16,954 格，实测 `assets/giant-trees/trees.json`）。
叶子当前 `opaqueTable=1`，叶-叶共享面互剔。实测同一片 8³ 叶团（18³ halo 视图，真实 atlas）：

| 组合 | opaque | cutout | 总顶点 | 备注 |
|---|---|---|---|---|
| 现状 `opaque` + `opaqueTable=1` | 1584 | 0 | **1584** | 基线 |
| **`cutout` + `opaque: true`** | 52 | 1532 | **1584** | **零增长（选定）** |
| `cutout` + `opaqueTable=0`（照抄既有 leaves） | 72 | 12244 | **12316** | ×7.78，撞破容量 |

第三行正是 `check-data.mjs:739` 那条失效路径警告的后果。

**选定方案 = 第二行**：`cullMode` 改成 `cutout`（拿到 alphaTest 镂空），同时显式写 `"opaque": true` 保住 `opaqueTable=1`（保住面剔除）。**顶点数一个不增。**

### 先例

`sky_leaves` 同样是 `opaqueTable=1`（v1.42 方案 C），已在 AGENTS.md 记录为「有意偏离 mc-lite」。

## 3. 为什么不影响其它四项后果

`opaqueTable=1` 的四个消费者：① 邻居面剔除 ② AO 遮挡 ③ blocklight 阻断（`lighting.js`）④ 炮塔 LOS / 弹丸阻挡。

**这四个现状本来就是 1**，本次只改渲染通道、不改 `opaqueTable` → 四支全部保持原样，不引入新行为。与 `chimney` 那种「从 1 改到 0」的坑方向相反。

投影不受影响：cutout 通道 `castShadow = true`（`render-world.js:82`），巨树叶继续投影，符合既有裁决与 `[阴影投射]` 口径。

## 4. 改动清单

### 4.1 `src/voxel/blocks-data.js`

6 个 `giant_*_leaves` 的 `cullMode: "opaque"` → `"cutout"`，各追加 `"opaque":true`。

同时更新文件头注释：现有注释写「名字含 leaves → cutout」，而这 6 项正是当年按用户裁决改成 opaque 的例外；现在改回 cutout 但保留 `opaque:true`，注释须反映现状（通道与剔除语义分离）。

### 4.2 `tools/check-data.mjs`

`checkGiantTrees()` 的第 ⑤ 段现钉 `def.cullMode !== 'opaque'` 即 FAIL，改为：

- `cullMode` 必须是 `cutout`（否则丢镂空 → FAIL）
- `def.opaque !== false` 且 `REGISTRY.opaqueTable[id] === 1`（否则顶点 ×7.78 → FAIL）

**这不是放宽门禁**，而是双向钉死：通道错回 opaque 丢镂空会红、漏写 `opaque:true` 会让顶点暴涨也会红。
同步更新该函数开头的 ① 号失效路径说明与末尾汇总信息的措辞（「叶子 opaque 且投影」→ 准确表述）。

### 4.3 `src/tests/test-giant-trees.js`

补契约用例，钉住 6 个树叶 `cullMode === 'cutout'` 且 `opaqueTable === 1`；并加顶点数守卫（同叶团在 cutout 通道下的总顶点应等于 opaque 口径，防止有人「顺手」删掉 `opaque:true`）。

### 4.4 容量预算（验证，非代码改动）

叶子从 opaque 移到 cutout，**总顶点不变但通道分布变了**：opaque 降、cutout 涨。

预估（2.99 顶点/格 × 森林视域约 46 棵）cutout 约增 62 万顶点 ≈ 28%，opaque 峰值约从 76% 降到 62%。

**必须实跑 `tests/giant-tree-budget.spec.mjs` 确认 cutout 不越过 HEAD 基线。**若越线，相应上调 `CAPACITY.cutout.active` 是另一次预算调整 —— 先报数据再动，不擅自改。

### 4.5 文档

- `docs/giant-trees-acceptance-report.md`：加一条偏离记录
- `CLAUDE.md` 巨树约束小节：把「叶子 opaque」措辞改成「叶子 cutout + opaqueTable=1」
- 设计文档 `docs/superpowers/specs/2026-10-23-giant-trees-design.md` 相应段落同步

## 5. alphaTest 阈值的说明（已知观感边界）

cutout 材质 `alphaTest = 0.3` → 会剔掉 67 个半透明像素，只留 176/256 实心像素（覆盖 68.75%）。

这与既有 `leaves` 方块**完全同口径**（你熟悉的普通树叶就是这个观感）。若实玩觉得巨树叶子太透太稀，那是另一个话题（需给巨树单独做材质或改贴图 alpha），本次先按与既有树叶一致的方式交付。

## 6. 验证

- `npm run check`（含改后的 `[巨树]` 门禁）
- 单测：现有 810 + 新增契约用例
- `tests/giant-trees.spec.mjs` + `tests/giant-tree-budget.spec.mjs`（Tier 4，重点看 cutout 峰值）
- 负向验证：分别注入 ① 改回 `opaque`、② 删掉 `opaque:true`，确认新门禁与顶点守卫各自真红（用副本还原，不用 `git checkout`）
- 真实页面截图对比（改动前后同机位，确认孔洞可见）
