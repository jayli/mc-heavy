# 高台地带扎堆修复：邻域最小间距（TARN_MIN_SPACING）

日期：2026-11-16
触发：用户报告 seed 11984370 小地图上「同框 5 座高台」

## 1. 问题与根因

### 症状
seed 11984370，小地图（51 样本 × 20 格 = 跨度 1000）窗口内出现 **5 座**高台地带。

### 复现（纯函数，不启游戏）
截图拟合出玩家窗口 `Px=-200, Pz=1060`。该窗口内地带 region：
`(-1,1) (0,2) (-2,3) (-1,3) (0,3)` §其中 `rz=3` 是**三连相邻**。

三座中心相距整 400 格（= `REGION_SIZE`），地带直径 276 ⇒ 圆几乎相切、互不重叠，
几何自检不报错。

### 不是这些原因（已实测排除）
| 假设 | 实测 | 结论 |
|---|---|---|
| `seededRandom` 在整数网格上成团 | 相邻 region「双双命中率」3.99%（理论 4%） | 排除 |
| 1/5 抽签失效 | 全域每 7.53 个 region 一座，40 seed 中位 7.5 | 排除 |
| 资格判据没生效 | 该 seed 资格率 68.6%，与 `hasTarnEligibility` 一致 | 排除 |
| 小地图画错（多画了不存在的地带） | 用 `isTarnZone` 反算的网格与截图逐点吻合 | 排除 |

### 根因
`isTarnZone` = **逐 region 独立抽签**（1/5）+ 资格判据，**没有邻域间距项**。
「每 7.6 个 region 一座」的期望值数学上必然产生「3×3 窗口 5 座」这类成团
（15 seed × 50 窗口实测概率 0.7%）。

仓库先例：巨型金字塔正是为此加了 `PYRAMID_MIN_SPACING = 384` 的单向去重
（`giant-pyramid.js:306-327`）。高台地带缺这一层。

## 2. 方案

### 2.1 新常量 `TARN_MIN_SPACING = 800`

口径 = **中心切比雪夫距离**（格）。地带中心固定在 region 中心、间距恒为 400 的整数倍
⇒ 800 ≡ 「不允许 8 邻域相邻」≡「任何 2×2 region 块里至多 1 座」。

取 800 而非 1200 的实测依据（15 seed × 625 region，每 seed 50 个视野采样）：

| 口径 | 每 N region 一座 | 视野均值 | ≥3 座 | ≥4 座 | ≥5 座 |
|---|---|---|---|---|---|
| 现状（无间距） | 7.5 | 1.12 | 9.2% | 2.8% | **0.7%** |
| **800（本方案）** | **12.6** | **0.67** | **0.2%** | **0.0%** | **0.0%** |
| 1200 | 47.8 | 0.19 | 0.0% | 0.0% | 0.0% |

1200 会让视野内常常 0 座（过于罕见），不取。

### 2.2 `isTarnZone` 判据链

```
① CITY_REGION 恒 false
② seededRandom(rx, rz, seed + TARN_ZONE_SALT) < TARN_ZONE_CHANCE   （1/5，不变）
②b hasTarnEligibility(...)                                          （③④⑤⑥，不变）
③ 邻域去重：任一「字典序更小」且合格的邻居，中心切比雪夫距离 < 800 → false
```

三条载荷性约束（均抄自 `giant-pyramid.js` 的已验证实现）：
1. **去重必须比较「未过门」的邻居**：只比已过门的会漏判。实现上缓存的是 ①②b 的结果
   （即 `hasTarnEligibility` 之后、间距判定之前）。
2. **单向比较**（只跟字典序更小的 region 比）：互相让位会让相邻两个双双放弃 →
   整块空地（`giant-pyramid.js:308-311` 记过的坑）。
3. **邻居必须先过廉价门再算资格**：单次 `hasTarnEligibility` 实测 **21.4 µs**，
   邻域 24 个全算 ≈ 500 µs。先跑 `seededRandom`（0.046 µs）挡掉 80% ⇒
   实测增量 **14.9 µs/次查询**。

### 2.3 缓存

`isTarnZone` 的最终结果用紧凑 LRU（键 `Sseed|rx|rz`，容量 4096）：
`snowLandSuppressedByTarn` 每 column 调 49 次、`minimapRegionContext` 一次 2601 次重绘，
不缓存会把邻域开销乘上去。

## 3. 改动清单

| 文件 | 改什么 |
|---|---|
| `src/gen/structures/tarn-zone.js` | 新常量 `TARN_MIN_SPACING`（含标定依据注释）；`isTarnZone` 插入邻域去重（`passesTarnGates` + 8192 条结果缓存）；更新判据表注释 |
| `src/tests/test-tarn-zone.js` | ① 既有「每 6~14 个 region 一座」带宽重标为 `[10, 18]`（加间距后实测 12.0~13.3，中位 12.6），按既有惯例在注释里记版本演变；② 新增「任意两座地带中心切比雪夫距离 ≥ `TARN_MIN_SPACING`」；③ 新增「任意 2×2 region 块里至多 1 座」；④ 既有「合格集命中率 ≈1/5」保持不变（去重在合格集统计之外） |
| `docs/roadmap.md` | 新版本行：根因、实测表、`TARN_MIN_SPACING` 标定依据 |
| `docs/superpowers/specs/2026-10-26-cloudland-tarn-zone-design.md` | DR-2 判据表补「⑦ 邻域间距 ≥ 800」 |

## 4. 验证

1. `npm run check`（arch + data + lint）
2. `npx playwright test tests/tarn-zone.spec.mjs`
3. 浏览器单测 `/src/tests/index.html` 全量（`window.__MC_TEST_RESULTS__`）
4. `npx playwright test tests/teleport.spec.mjs`（`findNearestTarnZone` 依赖 `isTarnZone`）
5. `npx playwright test tests/tarn-altar.spec.mjs`（祭坛选「离 City 最近的地带」，密度变后落点会变）
6. `npm run bench -- --check`（`isTarnZone` 在 GEN 热路径上）
7. **负向验证**：把 `TARN_MIN_SPACING` 注入 0 → 第 3 节两条新用例必须**真 FAIL**
8. 复算 seed 11984370 那个窗口：5 座 → 2 座（`(-1,1) (-2,3)`）

## 5. 用户裁定（待执行时确认）

- 抽签门 `TARN_ZONE_CHANCE = 1/5` **不动**（2026-10-28 用户明文裁定「五块草地才有一个」
  是绝对需求，不因本次改动推翻）。
- 间距取 **800**（非 1200）。
- 接受平均密度从「每 7.6 个 region 一座」降到「每 12.6 个」——
  这是「不扎堆」的必然代价：同平均密度下不可能既不成团又不稀疏。
