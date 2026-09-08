# M2 结构撒布补齐计划（flower_bed / pavilion / tall_well / house / 沙漠结构）

**日期**：2026-09-07
**分级**：Tier 1（生成算法 + 数据模型）→ 必须 TDD（RED→验证 RED→GREEN→验证 GREEN→REFACTOR）+ 门禁
**根因**：M2 阶段只搬了「城市 placement」与「植被撒布」两条路径，mc-lite 的**结构撒布**路径完全未搬

---

## 一、根因与欠账清单（实测确认）

`assets/structures/` 有 27 个 JSON，但 `STRUCTURE_FILES`（`structure-json.js:9`）只映射 20 个。
**零消费的 7 个**：

| 文件 | mc-lite 归属 | 本次处理 |
|---|---|---|
| `flower_bed.json` | 城市撒布（seed+823） | ✅ 补 |
| `pavilion.json` | 城市撒布（seed+824） | ✅ 补 |
| `tall_well.json` | 城市撒布（seed+826） | ✅ 补 |
| `desert_pyramid.json` | 城市外撒布（seed+25） | ✅ 补 |
| `bed.json` | 床多方块 Epic | 已有欠账标注，不动 |
| `turret.json` | M6/M7 炮塔 | 后续阶段 |
| `zombie_nest.json` | M7 巢穴 | 后续阶段 |

另外 **2 类代码生成结构**（非 JSON）也未搬：
- `generateStructure('house')`（`WorldWorker.js:2946`）—— 草地上的小房子，seed+4 千分之一
- `resolveLargeStaticStructureType`（`WorldWorker.js:136`）—— desertPyramid / desertVillage / uglyHouse / tank

**与 M5 无关**：`git show --stat c9f7086` 里 `src/gen/**` 一行未动。

---

## 二、mc-lite 三条路径的门控（算法语义，逐条实测读出）

### 路径 ① 城市撒布（`WorldWorker.js:881` / `:892` / `:1132` / `:1136`）

```js
// flowerBed
cityInfo.transitionFactor === 0
  && seededRandom(wx,wz,seed+823) < 0.0005          // CITY_FLOWER_BED_CHANCE
  && !isPointNearCityStructure(wx,wz,seed,terrainGen,1)

// house（城市 filler，代码生成）
seededRandom(wx,wz,seed+812) < 0.0007
  && !nearMajorBuilding(4) && !nearOtherHouse(12) && !nearTree(8) && !nearTallTree(10)

// pavilion（region 后置填充，候选点 = cityCoreCandidates）
seededRandom(candidate.x,candidate.z,seed+824) < 0.003   // = 0.0005*6
  && canPlaceCityPavilion(...)   // 门控见下

// tallWell
seededRandom(candidate.x,candidate.z,seed+826) < 0.0015  // = 0.0005*3
  && canPlaceCityTallWell(...)
```

`canPlaceCityPavilion` 门控（`WorldWorker.js:669`）：
```js
!nearMajorBuilding(pavilionRadius+1) && !nearFillerHouse(+3) && !nearFlowerBed(+5)
  && !nearTree(+4 五种树) && !isPavilionFootprintReserved(...) && isPavilionSpaceClear(...)
```
`isPavilionSpaceClear`：逐格 `transitionFactor===0` + `|surfaceY+1-centerY|<=1` + `centerY..centerY+2` 净空。

**兜底逻辑**（`WorldWorker.js:1141`）：城市中心 chunk 内若一个都没撒中 → 按 score 排序强制放一个。

### 路径 ② 城市外 house（`WorldWorker.js:1108`）

```js
seededRandom(wx,wz,seed+4) < 0.001 && safeForStructure
// safeForStructure = x>=3 && x<=12 && z>=3 && z<=12（chunk 内圈，防跨 chunk 切割）
```
几何（`WorldWorker.js:2946`）：5×5 stone 地基 →  perimeter 3 层墙（`bricks`/`planks` 二选一）
→ 两侧 `glass_block` 窗 → 3 层递减屋顶（`dark_planks`/`oak_planks`）→ y+5 脊 →
1/3 概率烟囱 → `bookbox`(x-1,y,z-1) + `chest`(x+1,y,z-1)。

⚠️ **mc-lite 用 `Math.random()` 选材质与烟囱** —— 照搬会违反 mc-heavy **红线 2（确定性）**。
必须改用 `seededRandom`。这是本次的**有意偏离**，须在代码注释与设计文档标注。

### 路径 ③ 城市外大型静态结构（`WorldWorker.js:136`）

```js
if (!safeForStructure || occupied) return null;
if (biome === 'DESERT') {
  if (seededRandom(wx,wz,seed+25) < 0.00016) return 'desertPyramid';
  if (seededRandom(wx,wz,seed+26) < 0.00016) return 'desertVillage';
  if (seededRandom(wx,wz,seed+23) < 0.00008) return 'uglyHouse';
  return null;
}
if (surfaceType === 'grass' && seededRandom(wx,wz,seed+5) < 0.0001) return 'tank';
return null;
```
`occupied` 来自同点的植被判定（cactus seed+21 / dead_bush seed+24 / gunman seed+0）。
mc-heavy 的 `rollVegetation` DESERT 分支已有 cactus+dead_bush，可直接推出 occupied。
`rover`（seed+22）是实体，归 M6/M7，本次跳过并标注。

---

## 三、架构改写：运行期 Set → 确定性纯函数

mc-lite 的门控依赖**运行期 Set**（`cityFlowerBedCenters` / `cityPavilionFootprintCells` /
`cityFillerHouseCenters` / 五种 tree centers），跨 chunk 累积。mc-heavy 是 column 级确定性
生成、Worker 间无共享状态（红线 2/3/8），必须改写。

### 3.1 同类防重叠 → column 内局部 Set（语义等价）

mc-lite 的 Set 本就是 **chunk 局部**的（每 chunk 独立生成，Set 不跨 chunk）。
mc-heavy 在单个 column 的双循环里用局部 Set 累积 → **语义等价**，且顺序确定（lx/lz 升序）。
跨 column 的同类防重叠 mc-lite 也没做，故不偏离。

### 3.2 跨 column 光栅化 → 扫描周边候选点 + AABB 裁剪

撒布结构会跨 column（desertPyramid 25×25、uglyHouse 41×15）。采用 mc-heavy 已有的
`pyramidIsland`/`tower` 模式（`apply.js:167`）：**每个 column 扫周边候选点 → 确定性判定 →
AABB 相交则光栅化本 column 部分**。判定是纯函数，任意 column 扫到同一候选点得同一结论 → 确定性 ✓。

### 3.3 实测占地（决定扫描范围）

| 结构 | 底层 footprint（mc-lite `getLoaderBottomFootprint` 口径） | 全量包围盒 | groundSupport |
|---|---|---|---|
| flower_bed | halfX=5 halfZ=3 | x[-4,5] y[1,3] z[-2,3] | ❌ |
| pavilion | halfX=5 halfZ=3 | x[-4,5] y[1,6] z[-2,3] | ❌ |
| tall_well | halfX=5 halfZ=4 | x[-5,24] y[1,51] z[-4,20] | ❌ |
| desert_pyramid | halfX=12 halfZ=12 | x[-12,12] y[1,16] z[-12,12] | ✅ |
| desert_village | — | x[-8,8] z[-8,8] | ✅（已在表内） |
| ugly_house | — | x[-6,4] z[-4,10] | ✅（已在表内） |
| tank | — | x[-12,9] z[-8,-2] | ❌ |
| house（代码生成） | 5×5 + 屋顶到 y+5 | — | ❌ |

→ **统一扫描范围 ±22**（覆盖最大的 uglyHouse halfX=20 + margin 2）。
方块类型全部已在 mc-heavy registry（实测 4 个 JSON 的 missing=none）。

---

## 四、实施步骤（TDD）

### Task 1：撒布判定纯函数（RED → GREEN）

**新增** `src/gen/structures/scatter.js`（Worker 同构，无 three、无 DOM）：

```js
export const CITY_SCATTER_CHANCE = Object.freeze({
  flowerBed: 0.0005,   // seed+823
  house:     0.0007,   // seed+812
  pavilion:  0.003,    // seed+824（= flowerBed*6）
  tallWell:  0.0015,   // seed+826（= flowerBed*3）
});
export const OUTSIDE_SCATTER_CHANCE = Object.freeze({
  house:          0.001,   // seed+4
  desertPyramid:  0.00016, // seed+25
  desertVillage:  0.00016, // seed+26
  uglyHouse:      0.00008, // seed+23
  tank:           0.0001,  // seed+5
});

/** 城市撒布判定（确定性纯函数）。occupied = 本点已放置的同类中心集合 */
export function rollCityScatter(wx, wz, city, seed, occupiedCenters) → {type,x,y,z}|null

/** 城市外撒布判定（mc-lite resolveLargeStaticStructureType 等价） */
export function rollOutsideScatter(wx, wz, biome, surfaceType, occupied, seed) → type|null

/** safeForStructure：chunk 内圈门控（防跨 chunk 切割） */
export function safeForStructure(wx, wz) → boolean
```

**测试** `src/tests/test-scatter.js`：
- 判定确定性（同 seed 两次一致）
- 门控生效（`transitionFactor>0` → flowerBed 不出；`occupied` → 大型结构不出；
  `!safeForStructure` → house 不出）
- 互斥性（`rollOutsideScatter` 每点最多一个类型）
- 概率口径（关系型断言，**不硬编码计数** —— 避免 §2.5 陷阱②）

### Task 2：代码生成 house 几何（RED → GREEN）

**新增** `scatter.js` 内 `generateCodeHouse(x, y, z, setBlock, seed)`：
照搬 mc-lite 几何，但 **`Math.random()` → `seededRandom(x, z, seed+N)`**（红线 2）。
材质/屋顶/烟囱各用独立 salt，注释标注「有意偏离 mc-lite」。

**测试**：验证 house 方块组成（地基 25 stone / 墙 perimeter / 窗 glass_block /
屋顶 3 层递减 / bookbox + chest 位置），派生量从**实际生成数据读出**。

### Task 3：接线 apply.js（RED → GREEN）

**修改** `src/gen/structures/apply.js`：

1. `needTypes` 无条件加撒布结构（`flowerBed`/`pavilion`/`tallWell`/`desertPyramid`/
   `desertVillage`/`uglyHouse`/`tank`）—— 城市外撒布在非城市区域也要用，
   不能只在 `cityLayout` 存在时预载。
2. **新增阶段 2.7「撒布结构光栅化」**（在阶段 2 JSON 结构之后、阶段 2.5 空中结构之前）：
   - 扫描 column ±22 范围候选点
   - 城市内点 → `rollCityScatter`；城市外点 → `rollOutsideScatter`
   - column 内局部 Set 累积同类中心（防重叠，语义等价 mc-lite）
   - AABB 相交 → `rasterizeStructure(...)` 或 `generateCodeHouse(...)`
3. **兜底逻辑**：城市中心 column（`Math.floor(city.centerX/16)===cx`）内若未撒中
   pavilion/tallWell → 按 score 排序强制放一个。**简化实现**：只在城市中心 column
   判定与光栅化（pavilion 占地 11×7，大概率不跨 column），标注切割风险。

**修改** `src/gen/structures/structure-json.js`：
- `STRUCTURE_FILES` 加 4 项（`flowerBed`/`pavilion`/`tallWell`/`desertPyramid`）
- `GROUND_SUPPORT_TYPES` 加 `desertPyramid`（mc-lite 走 `generateStructureWithGroundSupport`）
- flowerBed/pavilion/tallWell **不加** groundSupport（mc-lite 走 `loader.generate`）

**修改** `src/gen/structures/region-config.js`：
- `CITY_STRUCTURE_FOOTPRINT` 加 `flowerBed`/`pavilion`/`tallWell`/`desertPyramid`
  （AABB 裁剪需要）

**测试**：
- 完整 GEN 落地（扫大范围找撒中点 → 跑完整 GEN → 验证方块真落地，**不只按数据条件筛**
  —— 避免 §2.5 陷阱①）
- 跨 column 一致性（同一结构被多 column 光栅化，接缝无重叠/无缺失）
- 确定性（同 seed 两次 GEN 结果一致）

### Task 4：门禁与文档

- `npm run check`（arch + data + lint）
- `npm test`（全量 E2E）
- **`npm run bench -- --check`**（改 GEN 热路径，必须跑；扫描 ±22 = 3600 点/column，
  须实测不回退 >10%）
- 文档同步：`docs/roadmap.md`（遗留 TODO 段）、`CLAUDE.md`（活跃约束 + 有意偏离清单
  加第 ⑥ 条「代码生成 house 用 seededRandom 而非 Math.random」）、
  `docs/phase-1-engine-design.md` §4.3（撒布路径 + 偏离标注）

---

## 五、负向验证清单（Tier 1 必须，逐条注入缺陷确认真 FAIL）

| # | 注入缺陷 | 期望 FAIL |
|---|---|---|
| 1 | 去掉 `transitionFactor===0` 门控 | flowerBed 在过渡带也出 → 门控测试 FAIL |
| 2 | 去掉 `safeForStructure` 门控 | house 跨 chunk 切割 → 完整性测试 FAIL |
| 3 | 去掉 `occupied` 门控 | 结构与植被重叠 → 互斥测试 FAIL |
| 4 | `seededRandom` → `Math.random()` | 确定性测试 FAIL（两次生成不一致） |
| 5 | 改概率常量 | 关系型断言 FAIL |
| 6 | 去掉局部 Set 防重叠 | 同类结构重叠 → 间距测试 FAIL |
| 7 | AABB 裁剪去掉 | 跨 column 结构重复/缺失 → 一致性测试 FAIL |
| 8 | `GROUND_SUPPORT_TYPES` 漏 desertPyramid | 悬空无支撑 → 支撑测试 FAIL |
| 9 | flowerBed 误加 groundSupport | 多出支撑柱 → 方块组成测试 FAIL |
| 10 | 扫描范围缩小到 ±7 | uglyHouse/desertPyramid 跨 column 部分丢失 → 完整性 FAIL |

---

## 六、风险与开放问题

1. **性能**：扫描 ±22 = 3600 点/column × ~6 个 seededRandom ≈ 1.1ms/column（估算）。
   视距 8 → 289 column → 约 320ms 总 GEN（异步，不影响帧率）。**须 bench 实测确认**。
   若回退 >10%，备选方案：分层扫描（小 footprint 结构 ±7，大结构 ±22）。

2. **兜底 pavilion 切割风险**：简化实现只在城市中心 column 光栅化。若 pavilion 中心
   靠近 column 边缘（距边 <5），会被切割。备选：把兜底判定做成纯函数
   `resolveCityFallback(city, seed)`，任意 column 可复现（成本：扫城市中心 column 256 点）。

3. **rover / gunman 未搬**：mc-lite 的 `occupied` 链含 gunman（seed+0）与 rover（seed+22），
   都是实体（M6/M7 范畴）。本次 `occupied` 只由植被推出，与 mc-lite 有细微差异
   （mc-lite 的 gunman 会占用点位）。标注为后续阶段。

4. **uglyHouse 重复**：它既是 `CITY_STRUCTURE_CONFIGS` 成员（城市 placement count:3），
   又是城市外撒布（seed+23）。mc-lite 就是这样，照搬不偏离。

---

## 七、不做的事

- 不动 `bed.json` / `turret.json` / `zombie_nest.json`（已有归属）
- 不动 M5 实体运行时（本次纯 gen 层改动）
- 不改 `CITY_STRUCTURE_CONFIGS`（城市 placement 配额已与 mc-lite 逐字相同）
- 不引入运行期跨 column 状态（红线 2/3/8）
