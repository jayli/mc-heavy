# 修复 City 里 house 悬空（底部不着地）

日期：2026-10-24
类型：Tier 1（生成层落位口径，静默数据错误，肉眼偶发可见）
状态：已批准，实施中

## 1. 问题

用户报告：City 地形中 house 有时飘在空中，底部不着地。

按真实 GEN 路径（`fillColumn → carveCaves → applyStructuresToColumn`）逐格扫描 5 个
seed、城市 bounds 内的全部 house，确认**两个独立成因**，都在 `src/gen/structures/`
生成层，都是「撒布结构」层落地起就有的缺陷（非近期引入）。

### 成因 ①（主因）：城市外撒布从未排除城市 bounds

`scatter.js:398-400` 注释承诺「由 apply.js 在光栅化时按实际 city bounds 过滤」，
但 `apply.js` 阶段 2.7 **完全没有这条过滤**（`git log -S` 确认自 87cd571 引入至今未实现）。

城市外撒布（`seed+4` house / `seed+5` tank / `seed+23` uglyHouse…）的落点高度
用**自然地形高度** `h+1`，而落点可能位于城市 bounds 内 —— 那里地面已被 `generateCity`
整形（中心压平到 baseHeight，过渡带抬升）。两者不一致即悬空。

实测城市 bounds 内的 house：

| seed | 数量 | 悬空 | 悬空率 | 最大悬空 |
|---|---|---|---|---|
| 12345 | 38 | 14 | 37% | 9 |
| 424242 | 48 | 17 | 35% | 6 |
| 777 | 39 | 35 | 90% | 11 |
| 20260820 | 42 | 30 | 71% | 15 |
| 31337 | 43 | 21 | 49% | 11 |

同类：desertPyramid / uglyHouse / tank 也有落进城市的（数量少）。

上游 mc-lite 是 `if (inCity) {城市分支} else {城市外撒布}` **互斥**
（`WorldWorker.js:793` 与 `:1084-1086`），本仓库移植时两路都跑 —— 这是偏离根因。

### 成因 ②（次因）：城市 filler house 只在中心点取地表高度

`generateCity` 的城市地表在 5×5 占地内有 1~2 格起伏（实测 seed 12345 `(7,217)`：
占地面 9~12，中心 11）。house 用中心点地表定 y，四周低一格的地基就悬空 1 格。

实测 5 seed：3% / 3% / 1% / 0% / 1% 轻微悬空（≤5 格）。

## 2. 修复方案

### 改动 1：城市外候选在 region 层排除城市 bounds（治 ①）

`src/gen/structures/scatter.js`：新增纯函数判定「候选点是否在城市 bounds 内」，
在 `computeScatterCandidates` 的城市外循环里、推入候选**之前**过滤。

放 region 层而非 apply 层：候选由 `computeScatterCandidates` 一次算出随 layout 下发
（DR-13），源头剔除不占 Int32Array 容量、不让 9 个 GEN Worker 各判一次；city 布局只有
region [0,0] 拿得到，两处判结论相同。

只排除**候选点**在 bounds 内的（与 mc-lite `if(inCity)/else` 互斥口径一致）。

### 改动 2：城市 filler house 落位取 5×5 占地最低城市地表（治 ②）

`rollCityScatter` 的 house 分支：`y = surfaceY + 1`（中心点）→
`y = min(占地面各格 getCityFinalSurfaceY) + 1`。

两个配套门控（实测缺一不可）：

- **footprint 必须全在城市 bounds 内** —— 否则伸出那格地面是自然地形（可高 15 格），
  按最低城市地表落位会把房子埋掉。
- **占地内地表高差 ≤ 3** —— 高差更大的是过渡带陡台阶（最大实测 15），落哪都一半悬空
  一半埋没，直接不撒。

实测对比（城市 filler house，5 seed 合计）：

| 口径 | 悬空 | 最大埋深 | 剔除 |
|---|---|---|---|
| 现状（中心地表） | 12 | 15 | 0 |
| 只改最低地表 | 6 | 15 | 0 |
| 最低地表 + 出界剔除 | 4 | 5 | 12 |
| **最低地表 + 出界剔除 + span≤3** | **0** | **≤3** | 16 |

选定最后一行：全 5 seed 零悬空，最坏埋深 3 格（一侧微陷，观感远好于飘空），
候选损失 16/693（2.3%）。

### 受影响文件

- `src/gen/structures/scatter.js` —— house 落位分支 + 城市外循环过滤；新判据作为纯函数
  导出供测试复用（红线 1）。
- `src/tests/test-scatter.js` —— 新增 Tier 1 用例。
- `CLAUDE.md` / `docs/roadmap.md` —— 补活跃约束（世界内容会变）。
- **不改** `structure-json.js`：groundSupport 是 JSON 结构补柱，house 是代码生成。

## 3. 验证口径

1. **Tier 1 单测**（RED → GREEN）：
   - 纯函数「候选点是否在城内」：城内 / 边界 / 跨界。
   - `computeScatterCandidates`：城市 bounds 内**零**城市外候选（5 seed 参数化）。
   - `rollCityScatter` house：落点 = 占地最低城市地表 + 1；出界候选、span>3 不产出。
   - **端到端（真实 GEN 数据）**：城市内所有 house 的 5×5 地基格正下方必须实心。
     当前实测 12 个悬空（最大 9）→ 真 FAIL；修好后 0。
   - 负向验证：分别回退改动 1 / 改动 2，该用例必须真 FAIL（①回退已实测 12 悬空）。
2. `npm test` 全量（世界内容会变，须确认既有 spec 不回归）。
3. `npm run check`（arch + data + lint）。
4. 不碰热路径，不需 `npm run bench -- --check`；但确认 `genP95` 不受影响。

## 4. 不做

- 不加「向下补支撑柱」（把悬空改成柱子，房子仍在半空）。
- 不在 apply 层加第二份过滤（红线 1，判据只在候选层一处）。
