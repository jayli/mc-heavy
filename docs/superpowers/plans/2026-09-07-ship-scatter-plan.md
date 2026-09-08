# ship 沉船补齐实施计划

**日期**：2026-09-07
**分级**：Tier 1（生成算法 + 数据模型）→ 必须 TDD + 门禁
**分支**：直接在 `main` 实现（用户指定，不建独立分支）；**实现完不提交**，等用户确认

---

## 一、根因与范围

`ship`（沉船）是 mc-lite `WorldWorker.js:2987-2997` 的**代码生成方块结构**（无 JSON 文件），
门控在 `WorldWorker.js:988`。mc-heavy 完全没有 —— 设计文档里 grep `ship`/`沉船` **零命中**，
确认是 M2 从未提及的真欠账（不是有意删除，区别于 `skyTree` 的 M2-7 有意省略）。

本次**只补 ship**。rover/gun_man 推迟到 M6（它们是 GLB 模型实体，需要 mc-heavy 尚不存在的
碰撞/射线/破坏持久化基础设施，正是 M6 丧尸要建的同一套）。

---

## 二、mc-lite 语义（实测读出，非推断）

### 门控（`WorldWorker.js:988`）

```js
if (h < -6 && seededRandom(wx, wz, seed + 13) < 0.001 && safeForStructure) {
  structureQueue.push(() => generateStructure('ship', wx, h + 1, wz, fakeChunk, dPlaceholder, rovers));
}
```

| 条件 | 值 |
|---|---|
| 高度门控 | `h < -6`（深海；海平面 `SEA_Y = -2`） |
| salt / 概率 | `seed + 13` / `< 0.001` |
| `safeForStructure` | 参与（`lx/lz ∈ [3,12]`） |
| biome | **不看**（任何 biome 的深海都可能） |
| `occupied` | **不看** |
| 落点 y | `h + 1` |

### 几何（`WorldWorker.js:2987-2997`）

```js
} else if (type === 'ship') {
  for (let dz = -3; dz <= 3; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) === 2 || Math.abs(dz) === 3) {
      chunk.add(x + dx, y + 1, z + dz, 'wood', dObj);
      chunk.add(x + dx, y + 2, z + dz, 'planks', dObj);
    } else {
      chunk.add(x + dx, y, z + dz, 'planks', dObj);
    }
  }
  for (let i = 0; i < 5; i++) chunk.add(x, y + i, z, 'wood', dObj);   // 桅杆 5 格
  chunk.add(x, y + 1, z + 2, 'chest', dObj);
}
```

占地：`dx -2..2`（5）× `dz -3..3`（7）；高度：甲板 `y`、外围 `y+1/y+2`、桅杆 `y..y+4`。
→ `halfX = 2`、`halfZ = 3`。方块：`wood` / `planks` / `chest`（三者都已在 registry，实测确认）。

### 实测数据（seed=12345，扫 ±800）

| 项 | 值 |
|---|---|
| 深海内圈点（h<-6） | 136,399 |
| ship 命中 | **109**（涉及 106 个 column） |
| **占地跨 column** | **0%** |
| 深海 biome 分布 | PLAINS 83889 / FOREST 42574 / AZALEA 9330 / SWAMP 606（**无 DESERT** —— DESERT 高度被 `h*0.5+2` 抬高，不会低于 -6） |
| 桅杆顶相对海平面 | 水下 1~5 格（门控 `h<-6` → `y+4 ≤ -2`）→「沉船」名副其实 |

**跨 column 0% 是数学必然**：`safeForStructure` 保证 `lx/lz ∈ [3,12]`，而占地 `dx±2`/`dz±3`
→ `lx=3` 时 `x-2 = 1 ≥ 0`，`lz=12` 时 `z+3 = 15 ≤ 15`，永远完整落在单 column 内。
（仍要配 `SCATTER_FOOTPRINT.ship` —— `apply.js` 的 AABB 判定需要它，否则候选被静默跳过。）

### 可见性前提（已核实）

- 玩家**能潜水**：`physics.js:24-28` 有 `inWater` 逻辑（重力 0.4×、上浮 `vel.y=4`、速度 0.6×）
- `water` 走 transparent 通道（`blocks-data.js:19`）→ 水下能看到沉船
- ship 方块通道：`wood`/`planks` = opaque，`chest` = cutout。数量极少（每 column 最多 1 个）
  → **不会触发 cutout 扩容**，无需动 `CAPACITY`

---

## 三、四处代码改动

### 改动 1：`src/gen/structures/scatter.js`

**1a. 引入「代码生成撒布类型」单一权威**（关键 —— 否则门禁会 FAIL）

现状：`SCATTER_JSON_TYPES = SCATTER_TYPES.filter((t) => t !== 'house')`（scatter.js:301），
门禁侧同样 `jsonTypes = SCATTER_TYPES.filter((t) => t !== 'house')`（check-data.mjs:297）。
ship 也是代码生成（无 JSON），若只加进 `SCATTER_TYPES` 而不改派生基准 →
门禁会要求 ship 有 `STRUCTURE_FILES` 映射 + 磁盘 JSON 文件 → **必然 FAIL**。

```js
/**
 * 代码生成的撒布类型（无 JSON 文件，走 generateCodeXxx）—— 单一权威。
 * 预载清单（SCATTER_JSON_TYPES）与 check:data 门禁的 jsonTypes 都从它派生（红线 1）。
 * 手写「排除清单」会漂移：漏一个 → 门禁要求它有 JSON 映射 → 误报；
 * 或该类型没被正确识别为代码生成 → 走 rasterizeStructure → cache 未命中 → 静默消失。
 */
export const CODE_GENERATED_SCATTER_TYPES = Object.freeze(['house', 'ship']);

export const SCATTER_JSON_TYPES = Object.freeze(
  SCATTER_TYPES.filter((t) => !CODE_GENERATED_SCATTER_TYPES.includes(t)));
```

**1b. `SCATTER_TYPES` 追加 `ship`**（追加到末尾，不改动已有类型的索引）

```js
export const SCATTER_TYPES = Object.freeze([
  'flowerBed', 'house', 'tallWell', 'pavilion',
  'desertPyramid', 'desertVillage', 'uglyHouse', 'tank', 'ship',
]);
```

**1c. 概率与 salt**

```js
OUTSIDE_SCATTER_CHANCE.ship = 0.001      // seed+13（mc-lite 口径，不降密度）
SALT.ship = 13
/** ship 的深海门控高度（mc-lite WorldWorker.js:988 `h < -6`） */
export const SHIP_DEEP_SEA_Y = -6;
```

**1d. 新增 `rollShipScatter(wx, wz, h, seed)` 判定函数**（纯函数，不读体素数据）

ship **不看 biome / 不看 occupied**，所以判定只需 `(wx, wz, h, seed)` —— 比陆地撒布廉价。

**1e. 新增 `generateCodeShip(x, y, z, setBlock)`**（照搬 mc-lite 几何，无 `Math.random`，
故无 v1.37 那种「材质随机」偏离问题）

**1f. 重排 `computeScatterCandidates` 的城市外循环**

现状顺序：`safeForStructure` → 概率预门控(desert+grass) → **biome+occupied** → `rollOutsideScatter`
→ `generateHeight` → 水下门控(`h <= SEA_Y` 跳过) → push。

改为：

```js
if (!safeForStructure(wx, wz)) continue;
const shipHit = seededRandom(wx, wz, seed + SALT.ship) < OUTSIDE_SCATTER_CHANCE.ship;
const desertHit = ...;  // 不变
const grassHit = ...;   // 不变
if (!shipHit && !desertHit && !grassHit) continue;

const h = generateHeight(wx, wz, seed);   // 提前：ship 与水下门控都需要它

// ship 走水下分支：门控 h < -6，不看 biome/occupied（mc-lite 口径）
if (shipHit && rollShipScatter(wx, wz, h, seed)) {
  outsideOut.push(wx, h + 1, wz, TYPE_INDEX.ship);
  continue;   // 一个点最多一个结构（与 rollOutsideScatter 的单一返回语义一致）
}

// 陆地撒布：水下不撒（v1.37 的有意偏离，保留）
if (h <= SEA_Y) continue;
const biome = getBiome(wx, wz, seed);
const occupied = !!rollVegetation(wx, wz, biome, seed).plant;
const type = rollOutsideScatter(wx, wz, biome, surfaceTypeOfBiome(biome), occupied, seed);
if (!type) continue;
outsideOut.push(wx, h + 1, wz, TYPE_INDEX[type]);
```

**注意这不是「独立分支」而是同一循环内的水下/陆地两条路径** —— ship 的门控（水下）与
陆地撒布的门控（`h > SEA_Y`）互斥，用 `h` 一次计算分流，避免重复算 `generateHeight`。

附带收益（行为等价的重构）：`biome`/`occupied` 的计算移到水下门控**之后** →
水下点不再白付 biome+植被代价（原本算了就被 `continue` 丢弃）。陆地撒布的判定逻辑与
结果完全不变（水下点本来就会被丢弃）。

### 改动 2：`src/gen/structures/region-config.js`

```js
export const SCATTER_FOOTPRINT = Object.freeze({
  ...现有 8 项...,
  ship: { halfX: 2, halfZ: 3 },   // dx -2..2 (5) × dz -3..3 (7)
});
```

### 改动 3：`src/gen/structures/apply.js`

阶段 2.7 的分支从 `if (type === 'house') ... else rasterizeStructure(...)`
改为**映射表**（可扩展，避免 if/else if 链）：

```js
const CODE_GENERATORS = Object.freeze({ house: generateCodeHouse, ship: generateCodeShip });
...
const codeGen = CODE_GENERATORS[type];
if (codeGen) codeGen(x, y, z, setBlock, seed);
else rasterizeStructure(type, x, y, z, setBlock, column, registry, seed, GROUND_SUPPORT_TYPES.has(type));
```

惰性预载循环里的 `if (t !== 'house') needTypes.add(t)` 改为
`if (!CODE_GENERATED_SCATTER_TYPES.includes(t)) needTypes.add(t)`（从同一权威派生）。

`GROUND_SUPPORT_TYPES` **不加 ship**（mc-lite 的 ship 走 `generateStructure`，
不是 `generateStructureWithGroundSupport`）。

### 改动 4：`tools/check-data.mjs`

`jsonTypes` 的派生基准从「排除 house」改为「排除 `CODE_GENERATED_SCATTER_TYPES`」：

```js
const { SCATTER_TYPES, CODE_GENERATED_SCATTER_TYPES } = await import('../src/gen/structures/scatter.js');
const jsonTypes = SCATTER_TYPES.filter((t) => !CODE_GENERATED_SCATTER_TYPES.includes(t));
```

---

## 四、测试（Tier 1 TDD）

### 浏览器单测（追加到 `src/tests/test-scatter.js`）

| 用例 | 断言口径 |
|---|---|
| ship 概率口径 | 关系型断言（不硬编码数值，§2.5 陷阱②） |
| **ship 只在深海出现** | 扫实际命中点，验证每个 `h < SHIP_DEEP_SEA_Y`（断言落在实际命中点上，§2.5 陷阱①） |
| ship 不看 biome/occupied | 同一坐标在不同 biome 下判定一致 |
| ship 判定确定性 | 同 seed 两次一致（红线 2） |
| `generateCodeShip` 几何 | 桅杆 5 格 `wood`（y..y+4）、`chest` 在 `(x, y+1, z+2)`、外围 `wood`/`planks` 分布、甲板 `planks` —— 派生量从实际生成数据读出 |
| `CODE_GENERATED_SCATTER_TYPES` 契约 | `SCATTER_JSON_TYPES` 不含 house/ship；`SCATTER_TYPES` 含两者 |
| 端到端：完整 GEN 后 ship 真落地 | **坐标判据**（`countStructureBlocksAt`），不用特征方块 —— `chest` 与 house 共享、`wood`/`planks` 与树共享，特征方块判据会恒真（v1.37 已踩过的坑） |

### 负向验证清单（逐条注入确认真 FAIL）

| # | 注入缺陷 | 期望 FAIL |
|---|---|---|
| 1 | ship 深海门控改成 `h < 0`（放宽） | 「只在深海」断言 FAIL |
| 2 | 去掉 `h < -6` 门控 | 同上 |
| 3 | ship 概率改大 | 关系型断言 FAIL |
| 4 | `generateCodeShip` 桅杆只写 3 格 | 几何断言 FAIL |
| 5 | `chest` 位置写错 | 几何断言 FAIL |
| 6 | `CODE_GENERATED_SCATTER_TYPES` 漏 ship | `SCATTER_JSON_TYPES` 契约 FAIL + **门禁 FAIL** |
| 7 | `SCATTER_FOOTPRINT` 漏 ship | 候选被静默跳过 → 端到端 FAIL |
| 8 | `apply.js` 的 `CODE_GENERATORS` 漏 ship | 走 rasterizeStructure → cache 未命中 → 端到端 FAIL |
| 9 | ship 用 `Math.random` 选材质 | 确定性断言 FAIL（若引入材质随机） |
| 10 | 水下门控 `h <= SEA_Y` 挪到 ship 判定之前 | ship 永不落地 → 端到端 FAIL |

### 门禁与 E2E

- `npm run check`（arch + data + lint）
- `npm test`（全量 E2E）
- `npm run bench -- --check`（改了 GEN 热路径 —— 虽然 ship 判定廉价，但循环重排须实测）
- **预期 draw call 影响极小**：ship 是方块，走 BatchedMesh 合批。参照 v1.37 实测
  （797 个方块结构 → draw +14 / +2.6%），109 个 ship 的增量应在噪声级

---

## 五、已知偏离与风险

1. **有意偏离 mc-lite：ship 不看 biome** —— mc-lite 也不看（门控只有 h + 概率 + safeForStructure），
   故这一条**不是偏离**，是照搬。但 mc-heavy 的陆地撒布看 biome，需在注释里说明 ship 为何不看
   （否则后人会「补齐」biome 门控 → 减少 ship 数量）。

2. **`h` 计算顺序变更**是行为等价重构（水下点原本算了 biome 就被丢弃），但须在注释里写明，
   否则后人看不出为何 `generateHeight` 被提前。

3. **ship 数量不降密度**（保持 mc-lite 的 0.001）—— 与 v1.37 的城市撒布/大 JSON 降密度不同。
   理由：ship 是 opaque+cutout 方块且数量少（109 个/全图，每 column ≤1），不吃 cutout 预算、
   不是 genP95 大头。实测后若 bench 有回退再议。

4. **玩家能否发现沉船**：深海在出生点（城市中心）附近可能不存在（实测视距 8 内 rover=0，
   说明附近无沙漠；深海分布需实测）。ship 是「探索型」内容，不保证出生点附近可见 ——
   这与 mc-lite 一致（mc-lite 视距上限只有 3，玩家通常看不到 rover）。

---

## 六、不做的事

- 不动 rover/gun_man（推迟到 M6）
- 不动 `skyTree`（保留 M2-7 有意删除决策）
- 不动 `CAPACITY`（ship 不会触发 cutout 扩容）
- 不引入第二份「代码生成类型」清单（红线 1）
- 不加 `GROUND_SUPPORT_TYPES.ship`（mc-lite 不走 groundSupport）
