# 雨的逐点遮挡（棚下不下雨、棚外照常下）设计

**日期**：2026-11-23
**分支**：`feat/kv9-carbine-and-rainy-lighting`
**状态**：待用户批准

---

## 1. 意图与 why

用户原话（2026-11-23）：

> 「阻挡的实现比较机械，是整个世界停止下雨，雨天光影整体消失。正确的做法是，当玩家躲在
> 屋子里、屋檐下、棚子下的时候，棚子下面、屋檐下面、屋顶下面是不应该下雨的，但是外面
> 正常下雨呀……玩家待在屋里向外看，是能看到外面在下雨的。」

即：**遮挡是空间属性，不是玩家的属性**。现行实现把它当成了「玩家状态 → 全局开关」，
于是玩家一进屋，整个世界（包括窗外的雨、屋外的水汪）一起消失。

### 目标

- G1 玩家站屋内/檐下/棚下时，**仍能看见外面的雨丝、水花**；
- G2 屋顶正下方**没有雨丝、没有水花**；
- G3 屋顶正下方的地面**不湿、没有水汪、没有镜面反光**；屋外地面照常湿；
- G4 屋顶自身的外表面（顶面、朝屋外的墙面）**照常湿** —— 它确实淋到雨；
- G5 挖掉屋顶 / 搭起棚子，上述四项**当帧跟随**（世界可编辑，红线 2）。

### 非目标

- N1 不做雨的物理模拟（风向斜落穿过檐口的精确几何）；沿用既有竖直下落语义。
- N2 不做「湿地面慢慢变干」的时间过渡（既有湿表面无时钟，用户未要求）。
- N3 不改雨量、雨丝观感常量、水汪反光强度 —— 本轮只改**生效范围**。
- N4 不新增 render pass、不新增顶点属性、不改 packed 位段布局。

### 反目标（做到即失败）

- A1 「屋内不下雨」退化成「屋内看不见雨」——即用户报告的原缺陷换个位置复活；
- A2 干湿边界出现 16³ 方块状的硬台阶（section 粒度方案的症状）；
- A3 墙面/云层出现湿斑或光晕（v3.31 已修掉的缺陷，不得复活）；
- A4 关掉雨天光影后画面不逐位回到改动前。

---

## 2. 现状与实测取证

### 2.1 两个全局总闸（这是用户报告缺陷的直接原因）

| 位置 | 现行代码 | 后果 |
|---|---|---|
| `storm-rain.js` `update()` | `_underRoof = isUnderRoof(玩家头顶)`；为真 ⇒ 两个 mesh `visible=false` 并 `return` | 屋外的雨丝/水花全部不画 |
| `game.js` `_updateStorm()` | `wet.uWet.value = indoor ? 0 : WET_STRENGTH_MAX` | 全世界地面变干 |

水花生成（`_spawnSplashes`）**已经**是逐点 `isUnderRoof`，是唯一本来就正确的一项。

### 2.2 逐滴遮挡判据本身是坏的（被总闸掩盖）

`_resolveShelterBatch()` 用 `rainStopY(world, registry, wx, wz, **wy**, 24)` —— 扫描起点是
**雨滴自己当前的 y**。屋内 y=5 的滴往下扫，只会先撞到 y=0 的地板，**永远看不到 y=9 的屋顶**
⇒ `aShelter=0`、`aMinY=地板` ⇒ 雨照画在屋里。

⇒ **只删总闸会立刻变成「屋内下雨」**。锚点必须改成「从云层上界往下扫」的列级量。

### 2.3 挡雨判据漏掉 21 个方块（含全部台阶）

实测（`node` 直接跑 registry，口径写明以免歧义）：

| 集合 | 数量 |
|---|---|
| `solid ∧ cutout` 的方块 | **34** |
| └ 其中 `hollowOccluderTable=1`（树叶族，本就不该挡） | **13** |
| └ 其中非 hollow（**旧口径漏判、新口径新增**） | **21** |
| 旧口径判「不挡雨」的实心方块（含 cloud） | **35** = 13 树叶 + 1 cloud + 21 建材 |

⚠️ 旧稿写的「36」是错的，实为 **35**（已改）。它与「21」不是同一口径：
35 是「旧口径不挡雨的全部实心块」，21 是「其中真正应该挡雨的建材」。

新增挡雨的 21 个：

```
cactus handrail handrailA handrailB vertical_pillar horizontal_pillar chest
sand_step sand_slab half_block_updown planks_step planks_step_updown
cobblestone_step cobblestone_step_updown stone_diorite_step
obsidian_brick_step obsidian_brick_step_updown
end_stone_brick_step end_stone_brick_step_updown
obsidian_brick_slab end_stone_brick_slab
```

⇒ **木台阶棚子现在完全不挡雨**。既有 `test-rain-shelter.js` 的「屋顶类」清单里恰好
一个台阶都没有，所以这条从未被抓到。

### 2.4 湿表面没有逐点遮挡的通道

`uWet` 是全局标量，TSL 读不到体素。要「棚下干、棚外湿」必须给它一份**可采样的空间数据**。

### 2.5 扫描成本实测（决定预算，不是估算）

⚠️⚠️ **单位必须写明：「column」= 16×16×128 的区块，含 256 个「格列」（一格里垂直扫一遍）**。
旧稿把两者混用，导致同一张表内部差 256×（已重测修正）。

重测（seed 12345，4×4 column = **16 column = 4096 格列**，真实 `fillColumn` 地形，取 5 轮最快）：

| 读路径 | 每 column | 每格列 | **8 column/帧** | 整窗 1024 column |
|---|---|---|---|---|
| `column.blocks` 直读（**本设计采用**） | 0.0122 ms | 0.048 µs | **0.098 ms** | **12.5 ms** |
| 逐格 `world.getBlockId`（对照） | 0.2886 ms | 1.127 µs | 2.309 ms | 295.6 ms |

⇒ **直读快 23.6 倍**（每格 `getBlockId` 要重算 cx/cz + 字符串 columnKey + Map.get）。
⇒ **`rain-shelter-map.js` 必须缓存 column 引用后直读 `col.blocks`**，不得逐格走 `getBlockId`。
⇒ 预算单位是 **column**：8 column/帧 = 2048 格列 = **0.098 ms**。
⇒ 整窗（512×512 格列 = 32×32 = **1024 column**）全扫 12.5 ms ⇒ **不能首帧全扫**（见 §4.4b）。

**等价性**：单遍首命中（挡雨块顶面 ∨ 暴露水面，取先遇到的那个）与既有
`max(rainShelterY, waterSurfaceYAt)` **数学等价**：两者都是自上而下第一个「实心顶面或暴露水面」。
4000 个采样点实测 **0 处不符**。
⚠️ 坐标必须取整：`getBlockId` 传小数 ⇒ `blockIndex` 算出小数下标 ⇒ undefined ⇒ 整列读成 air，
而两侧共用同一个错误假设时会得出「两者一致」的假结论（已记入 pitfalls）。

---

## 3. 三条候选方案（用户已选 A）

### A. 动态遮挡高度图 ✅ 用户 2026-11-23 选定

CPU 维护一张 **512×512 RGBA8** 环形窗口纹理，每格列存「从云层上界往下第一个截停面的高度」
与「该列有无暴露水面」。三个消费方共用这一份：

- 雨丝 / 水花：CPU 直接查表（零体素扫描，比现状**更便宜**）；
- 湿表面：片元里按世界坐标 `textureLoad` 采一个 texel，与探针高度比较。

**取舍**：+1 次 nearest/load 纹理采样（与 atlas 同机制，无新 pass）；窗口有边界
（±256 格，vd16 对角最远 272 格，角落落在雾外，见 §4.5）；云层之上（y > 34）盖的屋子
判为「湿」——但那里**本来也没有雨**（既有约束③），语义自洽。

### B. 逐 section 粗粒度（否决）

每 16³ section 一个湿度系数。房子远小于 section ⇒ 半间屋湿半间干，方块状硬边界。
便宜但观感不可接受（反目标 A2）。

### C. 3D 占用纹理 + 片元向上 march（否决）

任意高度都精确，但需 2MB 三维纹理 + 逐片元循环，与本仓「重计算离开主线程 / 不加 pass」
的口径冲突，且是本仓从未用过的 GPU 机制，风险高一档。

---

## 4. 设计（方案 A）

### 4.1 权威与分层

```
voxel/rain-occlusion-data.js   （新，three-free）  窗口尺寸/编码/纯函数 —— 唯一权威
render/rain-shelter.js         （改）              blocksRain 判据修正（屋顶语义）
render/rain-shelter-map.js     （新，three-free）  扫描 + 缓存 + 失效 + 纹理字节填充
render/rain-shelter-texture.js （新，three）       DataTexture 封装（上传节流）
render/wet-surface.js          （改）              片元遮挡门
render/storm-rain.js           （改）              删总闸、查表
core/game.js                   （改）              装配、每帧推进、删 uWet 室内门
```

依赖方向合法：`render → voxel`（向下），`core → 全部`（装配层）。
`rain-shelter-map.js` **不 import three** ⇒ Node 单测可直接跑扫描与失效逻辑。

### 4.2 数据编码（`voxel/rain-occlusion-data.js`）

| 项 | 值 | 理由 |
|---|---|---|
| `SHELTER_MAP_SIZE` | 512 | 窗口 ±256 格；512×512×4 = **1 MiB** |
| 通道 R | `(stopY - (WORLD_MIN_Y - 1)) * 2` | 半格分辨率（水面 = y+0.5），0 = 无截停面 |
| 通道 G | `hasWater ? 255 : 0` | 雨丝水下门的列级因子（沿用既有 `aWaterCol` 语义） |
| 通道 B/A | 0 | 预留 |

- R 值域（实测派生，不写死）：stopY ∈ [−31, 35] ⇒ 编码 ∈ **[4, 136]**，
  上界 = `(RAIN_CEILING_Y + 1 - (WORLD_MIN_Y - 1)) * 2`，**远未溢出 255**。
  ⇒ 留了 119 的余量，将来云层抬高也不会静默截顶（单测钉上界关系式）。
- `encodeStopY(null) = 0`；`decodeStopY(0) = null`。**0 是哨兵，不是「世界底」**
  —— 实测探针第一版把 stopY=0 编成 0，导致 470/4000 处误判为 null（本设计已避开）。
- GPU 解码：`stopY = R * 255 / 2 + (WORLD_MIN_Y - 1)`（= `R*127.5 - 33`）。常量由 JS 侧导出，
  TSL 侧读同一份（红线 1）。
  ⚠️ **f32 往返实测**（已跑）：133 个合法编码全部解出比真值**偏大** 0~3.78e-6，
  无一个偏小。本设计的探针恒在 ±0.5 格处（不共面）⇒ 3.8e-6 不会翻判。
  但为了不给将来留陷阱，比较式加 **`SHELTER_EPS = 1/512`**（半格的 1/256）：
  `shelter = step(probe.y, stopY + EPS)`。实测：共面与半格之下两种边界均 0 失败。
  CPU 同构函数 `wetShelterGate` 必须读同一个 EPS（红线 1）。

窗口原点 `originX/originZ`（整数格，16 对齐）**只用于 CPU 侧判「哪些 column 在窗内」**；
texel 索引走**绝对坐标** `tx = floor(x) & 511`、`tz = floor(z) & 511`（环形，负坐标天然正确）。
⚠️ **不得写成 `(floor(x) - originX) & 511`** —— 那会让原点一动整窗失效（见 §4.4）。
⇒ GPU 侧**无需原点 uniform**。

### 4.3 挡雨判据修正（`rain-shelter.js`）

```
blocksRain(id) = solidTable[id]===1
              && hollowOccluderTable[id]!==1     ← 改这一项（原为 cullTable!==1）
              && id!==cloudId
```

`hollowOccluderTable` 是 registry **派生**表（`cullMode==='cutout' && opaqueTable===1`），
实测恰好命中 13 个树叶族，不含台阶/栏杆/柱子。⇒ 仍是「读表不写名字白名单」（红线 1）。

**实测差异**（已跑）：新增 21 个挡雨方块（§2.3 清单），**丢失 0 个**。
唯一边界：`sky_leaves` 声明是 `cullMode:'opaque'`（天空树 Epic 有意偏离），仍挡雨
—— 它在 y ∈ [40,70] 的空岛上，被高度上界整体排除，行为不变。

⚠️ 既有 `test-rain-shelter.js` 的两条用例（「全部树叶族不挡雨」「判据 = 实心且非 cutout」）
断言的是**旧口径**，必须同步改成新口径；这不是放宽断言，是判据本身修正（附实测清单）。

### 4.4 扫描与失效（`render/rain-shelter-map.js`）

**扫描**：逐 column（16×16 格列）单遍自上而下，起点 `RAIN_CEILING_Y`，终点 `WORLD_MIN_Y`。
首个 `blocksRain` ⇒ `stop = y+1`；首个暴露水体（上方非 opaque 且非同种水，与 mesher 同式）
⇒ `stop = y+1-SINK`。两者取**先遇到的**（§2.5 已证与 `max` 等价）。
用 `Uint8Array` 查表（`rainTab`/`waterTab`，按 registry 建一次），热循环只读字节。

**失效**：`Map<columnKey, version>` 记已扫版本。每帧检查窗口内 column：
- 不存在 / version 变了 ⇒ 入重扫队列；
- 新进入窗口的 column ⇒ 入队。

**预算**：每帧最多 **8 个 column**（= 2048 格列，实测 **0.098 ms**），队列按到玩家的距离排序（近处优先）。
另有 `invalidateColumn(cx,cz)`：由 `editor.subscribe` 的 `block-changed` 事件调用，
把该列**插到队首**（玩家挖放当帧就重扫，不等轮到）。

**索引必须是绝对坐标，不是相对原点**（本轮审阅连带抳出的真缺陷）：

```
tx = floor(x) & 511        // ✅ 绝对
tx = (floor(x) - originX) & 511   // ❌ 相对 —— 原点一动，每个 texel 的含义都变了
```

相对索引下，`originX` 从 0 移到 16 后 texel 5 从「绝对 x=5」变成「绝对 x=21」
⇒ **整窗 262144 个 texel 全部失效**，根本不是环形缓冲。
绝对索引下，texel 永远装同一个绝对格列（模 512）⇒ 真正的环形窗口，
且实测确认：**离开窗口的旧列与新进入的列占用同一批 texel**（任意 origin 下均成立）。
⇒ GPU 侧**不需要 `uShelterOrigin`**（只需 CPU 侧用 origin 判断哪些 column 在窗内）。

**窗口平移**：原点沿某轴 +16 时，清零条带 =
**`(originX_OLD & 511) .. +15`（环形取模）**，并把这批 texel 对应的 column 入重扫队列。

⚠️ 两个错写法都要避：
- 原稿的固定 `[0,15]` —— 只在 `originX ≡ 0 (mod 512)` 时才对；
- 审阅建议的 `((originX+16) & 511) .. +15` —— **偏了 16**（实测：O=0 时应清 0..15，它给 16..31）。

清零后 GPU 读到 `R=0` ⇒ 未知 ⇒ 不遮挡，**GPU 侧不需要任何有效性判据**。
⚠️ **清零必须伴入队**：只清零不入队会让那批 texel 永远停在未知。

⚠️ **不用哈希判有效性**（本轮否决的写法）：哈希碰撞会静默读到别的列的高度，
而「高度看起来也合理」⇒ 数值判据全绿而遮挡位置错。清零是精确的、无碰撞的。

未知一律按**不遮挡**处理（安全失败：顶多多下一点雨，不会把露天判成室内）。

### 4.4b 预热与收敛（本轮审阅 P0-3）

开档第一帧不能全窗扫（1024 column × 0.0122 ms = **12.5 ms ⇒ 爆帧**），
也不能只扫 8 column 就宣称「预热完成」。分两步：

| 阶段 | 扫什么 | 成本 | 效果 |
|---|---|---|---|
| **开档当帧预热** | 玩家周围 **3×3 = 9 column**（覆盖 ±24 格） | **0.11 ms** | 近处立即正确 |
| 其余 | 8 column/帧渐进 | 0.098 ms/帧 | 整窗 ~128 帧 ≈ **2.1 s** 收敛 |

⇒ Tier 4 夹具取样区在玩家半径 ~7 格内 ⇒ **预热已覆盖，C3 不会红**。
⇒ 远处窗口在 ~2.1 s 内按「不遮挡」，那是安全失败方向且远处有难。
⚠️ **不得写成「首帧满预算 tick」**（满预算=8 column，不足以覆盖 3×3）——
预热是独立的 9 column 路径，不走每帧预算。
⚠️ Tier 4 仍应在 `setStormLighting(true)` 后等 ≥1 帧再取样（预热同步完成，但上传需一帧）。

**关档时零成本**：`setStormLighting(false)` ⇒ 不推进扫描、不上传纹理。

### 4.5 窗口边界

512 格窗口 = ±256。vd16 加载半径 (16+2)×16 = 288，雾在 273.6 完成，
对角最远 √2×256 = 362 格 —— 角落在雾外。

⚠️ **绝对索引下窗口外的坐标会 wrap 到窗内某个 texel**（模 512），
而那个 texel 装的是 512 格外的另一个格列 ⇒ 高度可能不对（不是「未知」）。
**处置**：湿表面门额外乘一个**水平距离门**：`length(probe.xz - cameraPosition.xz) > 256 ⇒ 不遮挡`。
它是安全失败方向（远处照常湿），且与雾距一致 ⇒ 观感无差异。
CPU 侧 `stopAt/waterAt` 则先判「该坐标在不在窗内」，不在 ⇒ 直接返回未知（不查表）。

**判据**：Tier 1 单测钉「窗口外查询返回未知」；Tier 4 不测雾外。

### 4.6 GPU 侧遮挡门（`wet-surface.js`）

```
probe   = wp + faceNormal * 0.5            // 探针推到面外半格
texel   = textureLoad(shelterMap, ivec3(tx, tz, 0))
stopY   = texel.r * 255 / 2 + (WORLD_MIN_Y - 1)      // 格顶口径，与 rainShelterY 同源
known   = step(0.5/255, texel.r)           // R=0 ⇒ 未知/无截停 ⇒ 不遮挡
// ★ 判据：截停面是否**严格高于探针所在格的格顶**
shelter = known * step(floor(probe.y) + 1 + SHELTER_EPS, stopY)
        // TSL step(edge,x) = x>=edge?1:0 ⇒ edge=格顶、x=stop，**不取反**
gate    = mix(1, 1 - shelter, uWetShelter) // 0 ⇒ 逐位回到 v3.33
```

⚠️ **方向写反会得到完全 inverted 的门**（露天全干、棚下全湿）。
本轮 CPU 同构校验实测：套 `oneMinus(step(...))` 的写法 **7/8 关键场景判反**，已修。
CPU 纯函数与 TSL 必须同方向，由 Tier 1 的 8 个场景 + 1032 例穷举钉住。

#### ⚠️⚠️ 为何不能用 `probe.y <= stopY`（本轮审阅抓到的机制错误）

`stopY` 是**格顶**（`y+1`，与既有 `rainShelterY` 同源，对雨丝是对的），
而探针落在**几何顶面**外半格。两者对整格方块恰好差 0.5，但对**非整格顶面**的方块会共面：

实测（真实 `TEMPLATES` 逐顶点算）—— 挡雨方块里几何顶面 ≠ 1.0 的共 **8 个**：

| 方块 | geometry | 几何顶面 |
|---|---|---|
| `sand_slab` / `obsidian_brick_slab` / `end_stone_brick_slab` | `half_block` | **0.5** |
| `bed_head` / `bed_tail` | `half_block` | **0.5** |
| `horizontal_pillar` | `horizontal_pillar` | **0.65** |
| `cactus` | `cactus` | **1.05** |
| `chimney` | `chimney` | **1.5** |

三款 slab：几何顶面 0.5 ⇒ 探针 `0.5+0.5 = 1.0`，而 `stop = 1` ⇒ `probe <= stop` 成立
⇒ **露天半砖永远不湿**（静默缺陷）。
⚠️ 审阅只点出 3 款 slab，实测还有 `horizontal_pillar`、`bed_head/tail`（共 5 个顶面 <1），
以及 `cactus`/`chimney`（顶面 >1，反向安全）。

#### 候选判据实测对照（11 个关键场景）

| 场景 | `probe<=stop`（原式） | `probe<stop`（严格） | **`stop>floor(probe)+1`（采用）** |
|---|---|---|---|
| 露天半砖顶面（应湿） | ✗ 干 | ✓ 湿 | ✓ 湿 |
| 露天整格石顶面（应湿） | ✓ | ✓ | ✓ |
| 露天横柱 0.65（应湿） | ✓ | ✓ | ✓ |
| 仙人掌 1.05（应湿） | ✓ | ✓ | ✓ |
| 屋内地板，屋顶 y=4（应干） | ✓ | ✓ | ✓ |
| **屋顶自身顶面 y=4（应湿）** | **✗ 干** | **✗ 干** | **✓ 湿** |
| 半砖棚顶自身 y=4（应湿） | ✗ 干 | ✓ 湿 | ✓ 湿 |
| 半砖棚下地板（应干） | ✓ | ✓ | ✓ |
| 烟囱顶面 1.5（应湿） | ✓ | ✓ | ✓ |
| 内墙面（法线朝屋内，应干） | ✓ | ✓ | ✓ |
| 外墙面（法线朝屋外，应湿） | ✓ | ✓ | ✓ |

⚠️ **原式还有一个审阅没点出的缺陷：屋顶自身顶面也被判干**
（probe 5.5、stop 5 ⇒ 5.5<=5 假 ⇒ 湿？—— 表中 roof 行的 probe 是 `cellY+top+0.5 = 4+1+0.5 = 5.5`，
但**半砖棚顶**是 `4+0.5+0.5 = 5.0` ⇒ 共面 ⇒ 干）。
⇒ 审阅建议的「严格 `<`」修了 slab 但**修不了屋顶自身共面**的情形；
**只有格顶判据全部 11 例通过**。

**采用判据**：`shelter ⟺ stopY > floor(probe.y) + 1 + EPS`
语义：「截停面严格高于探针所在那一格的顶」= 探针头上真的有盖，
而不是「探针撞到了自己这一格的表面」。它把「自身格表面」从「遮挡」里结构性地排除。

**穷举验证**：全部 129 个挡雨方块 × 放在 y=0..3 × 有/无上方屋顶 ⇒ **1032 例，0 处不符**。

**法线偏移仍是核心**（不是可选优化）：

| 面 | 探针落点 | 结果 |
|---|---|---|
| 屋内地板顶面（y=P+1，屋顶 y=P+4） | 格 P+1，格顶 P+2；stop=P+5 > P+2 | **干** ✓ |
| 屋外地板顶面 | 格 P+1，格顶 P+2；stop=P+1 不> P+2 | **湿** ✓ |
| 屋顶自身顶面（y=P+5） | 格 P+5，格顶 P+6；stop=P+5 不> P+6 | **湿** ✓ |
| 半砖露天顶面（几何 0.5） | probe=1.0 ⇒ 格 1，格顶 2；stop=1 不> 2 | **湿** ✓ |
| 外墙侧面（法线朝屋外） | 屋外那一列，stop=地面 | **湿** ✓ |
| 内墙侧面（法线朝屋内） | 屋内那一列，stop=屋顶 > 探针格顶 | **干** ✓ |
| 屋檐下的外墙（檐口外挑） | 檐下那一列 | **干** ✓ |
| 底面（法线朝下） | 下方 | 本来 `orient=0` ⇒ 不湿，门不改行为 |

- 用 **`textureLoad`（nearest，无插值）**：高度场插值会在屋檐边缘产生「半湿」渐变带，
  且相邻列高度差可达十几格，线性插值出来的中间高度是**物理上不存在的面**。

#### 纹理构造与节点写法（已实测 PASS 的完整配方，不得凭直觉改）

⚠️ 审阅担心「`DataTexture` 默认 sampler 是 true，`textureLoad` 需要不可采样纹理」——
**不需要**。vendor 里 `textureLoad = ( ...params ) => texture( ...params ).setSampler( false )`
⇒ 它**自己关采样器**，直接喂普通 `DataTexture` 即可，不需 `storageTexture`、不需 `unwrap`。

```js
// 构造（模块级单例，初值全 0 = 全窗未知 = 不遮挡）
const tex = new THREE.DataTexture(
  new Uint8Array(SHELTER_MAP_SIZE * SHELTER_MAP_SIZE * 4),
  SHELTER_MAP_SIZE, SHELTER_MAP_SIZE,
  THREE.RGBAFormat, THREE.UnsignedByteType,
);
tex.flipY = false;                 // 显式写死（上传时 three 按它决定是否翻面）
tex.generateMipmaps = false;
tex.minFilter = THREE.NearestFilter;
tex.magFilter = THREE.NearestFilter;
tex.needsUpdate = true;

// 采样（片元）—— 坐标差可能为负 ⇒ 先 int 再 bitAnd（int 位与是补码，与 JS 同构）
const tx = int(floor(probe.x)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const tz = int(floor(probe.z)).bitAnd(int(SHELTER_MAP_SIZE - 1));
const sh = textureLoad(tex, ivec3(tx, tz, int(0)));
```

上述配方已由 §4.6b 的探针 B 实验证实（64/64 texel 三通道字节全对）。
⚠️ **探针收尾会删**，故配方必须留在本文档里作为唯一参照样本。
- **纹理走模块级单例**（照 `WET_SURFACE_UNIFORMS` 同一手法），由 `wet-surface.js` 直接 import
  ⇒ **不改 `RenderWorld` / `createVoxelMaterials` 的构造签名**，也不依赖装配顺序。
  初值全 0（= 全窗口未知 = 不遮挡）⇒ 未接线时逐位等于 v3.33。
- ⚠️ **`uWet=0` 时这次采样仍会发生**（`mix(baseRgb, lit, uWet)` 两侧都求值，既有湿分支
  的两次 perlin + pow + normalize 本来也是无条件求值）⇒ 边际成本是一次无滤波 load。
  由 `bench --check` 兜住（见 §5）。
- `DataTexture` 必须 `flipY = false`（默认）、`generateMipmaps = false`、
  `minFilter = magFilter = NearestFilter`。⚠️ WebGPU 的 `isFlipY()` 恒 false，
  但 three 上传时仍按 `texture.flipY` 决定是否翻转 ⇒ 显式写死 false。
- `uWetShelter` 默认 1，写 0 ⇒ **第四级零回归锚点**（前三级：`uWet` / `uWetPuddleRefl` / `uPuddleReflect`）。
- 门乘在 **`wet`** 上（不是只乘 puddle）⇒ 压暗/水膜反光/水汪镜面/真倒影/太阳高光**五项一起归零**。
- ⚠️ **上传必须早于本帧所有 render pass**（含反射 pass 与阴影 pass）：
  遮罩纹理是模块级单例，反射替身材质也采样它 ⇒ 若在 pass 中途 `needsUpdate`，
  同一帧内不同 pass 会读到不同版本的高度图 ⇒ 主画面与 RT 干湿不一致。
  装配顺序：`map.tick()` → `uploadShelterTexture()` → `_renderWaterReflection()` → `renderer.render()`。

**反射 pass 的替身材质**：`beginReflectMaterialSwap()` 重建材质时同样消费遮罩纹理
（它是模块级单例，不是构造参 ⇒ 替身自动拿到同一份；它也不是 RT，无读写冲突）
⇒ RT 里的干湿分布与主画面一致。

### 4.6b 已实测验证的 GPU 机制（本轮探针）

两个一次性探针（不入库，收尾删）：

**探针 A** `tests/tmp-shelter-rawbytes.spec.mjs` —— `copyTextureToBuffer` 读回 GPU 原始字节：
三种 `colorSpace`（默认 / `NoColorSpace` / `SRGBColorSpace`）下均与 CPU 写入**逐位相同**
（`[4,0,77,255, 6,255,77,255, ...]`）⇒ **上传侧无问题，数据纹理不被 sRGB 解码**。

**探针 B** `tests/tmp-shelter-texload.spec.mjs` —— 片元 `textureLoad` 取回并当颜色输出，
逐像素读回比对全 64 个 texel。

⚠️ **本轮在探针 B 上踩了三个测量错误（全是判据的错，不是机制的错）**：

| # | 错误写法 | 观测 | 为何误导 | 正解 |
|---|---|---|---|---|
| ① | 直接比「屏幕字节 == 编码值」 | 64/64 不符 | ACES+sRGB 把 4→15、64→152、136→201 | 探针里关显示变换（`NoToneMapping` + `LinearSRGB`），并用常量灰阶标定作**前提断言** |
| ② | 用 6 点标定 LUT 反查最近邻 | 63/64 不符 | ACES 压缩段太密，相邻编码映到同一字节 | 放弃反推，走① |
| ③ | 取样行按 OpenGL 习惯翻转 | R 看起来「恒偏 +112」而 G 完全正确 | WebGPU 的 `screenCoordinate.y` **自顶向下**（与 PNG 行号同向）⇒ 读到对面那一行；编码是等差序列⇒ 读错行恰好表现为常量偏置；而 G 的 0/255 交替因 SIZE=8 是偶数而奇偶性不变 ⇒ 误读成「只有 R 通道坏了」 | **不翻行**，且读**全部 64 个 texel**（只读一行发现不了） |

③ 的定位证据：把观测值反查编码表，8 个采样点**全部精确落在 `ty=7`**（本应 `ty=0`），
且 G 的奇偶性逐点匹配 ⇒ 不是通道偏置而是**行错位**。

⇒ **结论（实测 PASS，不是推测）**：`DataTexture` + `textureLoad` 在本仓 WebGPU 路径上可用且字节精确。
探针 B 最终读数：**badR=0 / badG=0 / badB=0（64/64 texel 全对）**，
标定恒等（0→0、4→4、64→64、136→136、255→255），零 GPU 验证错误。
⇒ 方案 A 的核心机制已验证。

⇒ 本轮 Tier 4 的干湿判据用的是**差分**（同一变换下两态相减），对显示变换不敏感；
但**任何「把数据当颜色读回」的探针必须先关变换、先确认行方向**。
三条均已记入 `docs/pitfalls.md`。

### 4.7 雨丝与水花（`storm-rain.js`）

- **删除** `update()` 里的 `isUnderRoof` 总闸（G1）。`_underRoof` 字段保留，但语义改为
  「玩家所在处是否被遮挡」，**只喂雨声衰减与远雷门**（听感正确，与视觉解耦）。
- `_resolveShelterBatch()`：不再逐滴扫体素，改为**逐滴查表**：
  `stop = map.stopAt(wx, wz)`、`hasWater = map.waterAt(wx, wz)`。
  `aMinY = stop ?? -1e9`、`aShelter = (stop !== null && wy < stop) ? 1 : 0`。
  ⇒ 判据从「滴自己的 y 往下扫」改成「列级绝对高度」，§2.2 的缺陷同时修掉。

⚠️ **`aWaterCol` 语义有意收窄**（必须写明，否则会被当成 bug「修回去」）：
单遍扫描在遇到屋顶时就停了，**不会再往下找水** ⇒ 「屋顶盖住的水面」列 `hasWater=0`
（旧口径 `waterSurfaceYAt` 独立扫描会给 1）。

**本轮审阅质疑这条是「不可达」，声称「玩家在水下 + 头顶有桥」会漏水下雨丝。
已用穷举判定：不成立。**

**机制证明**：单遍自上而下，若先撞到挡雨块，则该块在**所有暴露水面之上**
⇒ `水面 < stop`；而雨丝可见要求 `wy >= stop`（`aShelter=0`）
⇒ `wy >= stop > 水面` ⇒ **不可能同时在水下**。

**穷举取证**（`baseY × waterTop × roofY × playerY` 全组合）：

| 量 | 读数 |
|---|---|
| 新旧口径结果不同的列 | **5684** |
| 其中 `stop > 该列水面` | **5684（全部）** |
| 其中 `stop < 该列水面` | **0** |
| 真·水下且可见的案例 | **0** |

⚠️⚠️ **判定这条时我自己先踩了一个测量错误**（值得记进 pitfalls）：
第一版穷举用**全局常量** `WATER_SURFACE_Y = -1.5` 当「水下」界，得出 **14585 个可达案例**，
看起来坑实了审阅的意见。但那些案例全是「深坑里的合法空气滴」—— 坑底水面在 −18.5，
滴在 −16 确实在**该列水面之上**，只是低于海平面。
改用**该列自己的水面**作判据后，可达案例归零。
⇒ 这正是既有 `storm-rain-material.js` 注释里写的「干坑/峡谷」情形，
也正是它为何要 `aWaterCol` 而不是无条件用全局高度门的原因。

⇒ 收窄确实只影响不可达分支。**Tier 1 用一条穷举用例钉住这个论证**（不是只写注释）：
造「屋顶盖水」列，断言 `stop > 该列水面`，且不存在 `wy ∈ [stop, 该列水面)` 的区间。
⚠️ 判据必须用 `waterSurfaceYAt` 算**该列**水面，不得用全局 `WATER_SURFACE_Y`。
- `_spawnSplashes()`：落点改查表；`isUnderRoof` 那行删掉 —— 落点若来自屋顶顶面，
  它**本身就在屋顶上**（该淋雨），若来自屋内地板则该列 stop = 屋顶顶面 ≫ 落点
  ⇒ 用同一条 `y < stop` 判据跳过，与雨丝同源。
- 节流保持 10 Hz + 512/批（查表比扫描便宜得多，但不动既有节奏，避免引入新的时序变量）。

### 4.8 雨声（保持现状语义）

`_syncStormAudio` / `_maybeThunder` 继续读 `underRoof`（玩家所在处）——  indoors 小声、
不响雷是对的听感，且**不影响视觉**。这一项不改。

---

## 5. 判据（Tier 分级）

### Tier 1（Node 单测，必须 TDD）

新增 `src/tests/test-rain-shelter-map.js`（进 `UNIT_NODE_SAFE` + `index.html`）：
1. 编码往返：`decode(encode(y)) === y`，含半格水面与负 y；`encode(null)=0`、`decode(0)=null`；
2. **编码值域上界** ≤ 255（用 `RAIN_CEILING_Y+1` 这个最高可扫值算，不写死数字）；
3. **f32 往返 + EPS**：全合法编码经 `Float32Array` 量化后，格顶判据在共面/半格边界不翻判；
4. 单遍扫描 ≡ `rainStopY`：真实 `fillColumn` 地形上 ≥2000 个采样点逐位相等（坐标取整）。
   ⚠️ **这条钉的是「单遍首命中 ≡ 两遍取 max」这个合成关系，不是挡雨判据** ——
   两侧共用 `blocksRain`，故它对判据本身零判别力（那是第 5/6 条的职责）；
5. 屋顶下的格列 stop = 屋顶顶面（不是地板）—— §2.2 缺陷的判别力锚点；
6. 台阶/栏杆/柱子/箱子挡雨（§2.3 的 21 个，逐个断言）；树叶族（13）+ 云 + 水不挡雨；
7. 水体列：`waterAt` 为真且 `stopAt === WATER_SURFACE_Y`；
8. **屋顶盖水的列**：`waterAt` 为假，且 **`stop > 该列自己的水面`**（用 `waterSurfaceYAt` 算，
   禁用全局 `WATER_SURFACE_Y`）⇒ 钉住 §4.7 的不可达论证；
9. version 变化 ⇒ 该列重扫；`invalidateColumn` ⇒ 队首；
10. **绝对索引**：`shelterTexelIndex(-1,-1)` ≡ `511 + (511<<9)`；且原点平移后
    **同一绝对坐标的 texel 不变**（相对索引会在这里红）；
11. **平移清零条带**：`originX` 从任意值 +16，被清零的必须是 `(originX_OLD & 511)..+15`；
    取 `originX = 0 / 16 / 496 / 1008 / -32` 五个值逐个断言（固定 `[0,15]` 与 `+16` 两种错写均会红）；
12. 未知安全失败：从未扫过/窗外的坐标 `stopAt === null`、`waterAt === false`；
13. 预算：队列 > 8 时 `tick()` 返回 8（单位 **column**）；`tick(0)` 返回 0；
14. **预热**：`warmup(x,z)` 后玩家周围 3×3 column 均已扫（不是 8 个）；
15. 静止世界零成本：连扫两轮后第三次 `tick()` 返回 0。

改 `src/tests/test-rain-shelter.js`：两条旧口径用例改成新口径（附实测清单，不放宽）。

改 `src/tests/test-wet-surface.js`：加 CPU 同构纯函数 `wetShelterGate(probeY, stopEnc, strength)`：
- 未知 ⇒ 1、strength=0 ⇒ 1；
- **三款 slab 的露天顶面必须湿**（`sand_slab` / `obsidian_brick_slab` / `end_stone_brick_slab`，
  几何顶面 0.5、stop=1）—— P0-2 的判别力锚点；
- **`horizontal_pillar`（顶面 0.65）露天必须湿**；
- **屋顶自身顶面必须湿**（含半砖棚顶，探针恰好共面那一例）；
- 屋内地板/内墙 ⇒ 干；屋外地面/外墙 ⇒ 湿；
- **穷举**：全部挡雨方块 × cellY 0..3 × 有/无上方屋顶 ⇒ 顶面干湿与预期逐例相等
  （实测基准 **1032 例 0 不符**）。

### Tier 4（真实 GPU 像素，`tests/storm-lighting.spec.mjs` 重写「室内」那条）

**夹具**：玩家脚下铺一片抛光石地面（`smooth_stone`，POLISHED 类，水汪信号最强），
一半盖屋顶（`stone_bricks`，7×7），另一半露天。相机在屋内朝门口方向平视偏俯，
使**屋内地面**、**屋外地面**、**屋顶顶面**同帧入画。取样区由真实投影算出
（照 `puddle-reflect.spec` 口径，不写死屏幕坐标）。雨丝/水花在量湿表面时关掉（单变量）。

三态取样：`dry`（`uWet=0`，全干基线）、`gated`（`uWet=1, uWetShelter=1`）、
`ungated`（`uWet=1, uWetShelter=0`）。

| 判据 | 期望 | 缺陷态 |
|---|---|---|
| C1 玩家在屋内时，屋外雨丝可见像素 | > 0 | 原缺陷：0（总闸） |
| C2 屋顶正下方雨丝可见数（读 GPU 属性算 fade） | = 0 | 只删总闸：> 0 |
| C3 屋内地面 `gated` vs `dry` **逐字节差** | ≈ 0（本来就干） | 门没接线：显著非零 |
| C4 屋内地面 `gated` vs `ungated` Δluma | 显著非零 | 门恒 0：零 |
| C5 屋外地面 `gated` vs `ungated` **逐字节差** | **= 0**（门不碰屋外） | 探针没偏移：非零 |
| C6 屋顶顶面 `gated` vs `ungated` **逐字节差** | **= 0**（屋顶自己淋雨） | 门爬到屋顶上：非零 |
| C7 `uWetShelter=0` 二次取样与首次 0 逐位相同 | 差 0 | 有状态残留 |
| C8 无 WebGPU 验证错误 | 空 | 纹理格式/绑定错 |

⚠️ **C5/C6 用位级而不是 luma 阈值**：墙面/屋顶 wet 幅度小，luma 阈值会被 8bit 量化吞掉
（本仓 `wet-surface.spec` 已记过这条教训）。

**负向验证**（注入后必须真 FAIL，用 `edit` 注入 + `cp` 副本还原，**不用 git checkout**）：
- 负向①：删掉探针的法线偏移（`probe = wp`）⇒ 屋外地面 `probe.y == stop` ⇒ 被判遮挡
  ⇒ **C5 变非零**（这是本设计核心机制的判别力锚点）；
- 负向②：把扫描起点改回「滴自己的 y」⇒ **C2 变非零**；
- 负向③：把 `blocksRain` 改回 `cullTable!==1` ⇒ 台阶棚子不挡雨（Tier 1 第 6 条红）；
- 负向④：把格顶判据改回 `probe.y <= stopY + EPS` ⇒ **slab 露头顶面用例红**（P0-2）；
- 负向⑤：把绝对索引改回相对索引 ⇒ **平移后同一绝对坐标 texel 不变用例红**（P0-4）。

每次注入后**读回源码确认注入落地**（本仓已记：`sed` 静默不匹配会让负向验证假通过）。

### 回归门（只跑消费本改动的 spec）

`npm run check` + `node tools/run-unit-node.mjs --only=test-rain-shelter.js,test-rain-shelter-map.js,test-wet-surface.js,test-storm-rain.js,test-mesher.js,test-water-surface.js`
+ `npx playwright test tests/storm-lighting.spec.mjs tests/storm-rain-visual.spec.mjs tests/storm-underwater.spec.mjs tests/wet-surface.spec.mjs tests/puddle-reflect.spec.mjs tests/m3-rain.spec.mjs`

`m3-rain` 必须跑：`rain.js` 共用 `rain-shelter.js`，判据修正会改它的截停面。

**必须加 `npm run bench -- --check`**（~5min）：本改动碰了 `materials.js` 的热路径
（每片元多一次 `textureLoad`，且 `uWet=0` 时也会求值 —— 既有湿分支本来就是无条件求值的）。
按 AGENTS.md「碰热路径才加 bench」，这次命中。回退 >10% 即门禁失败，须停下报告。

不改 packed 布局 / 顶点数 / 方块声明 ⇒ `check:data` 指纹不应变；若变了要停下报告。

---

## 6. 已知风险与处置

| 风险 | 处置 |
|---|---|
| `wet-surface.spec` / `puddle-reflect.spec` 的既有夹具在**露天**铺地面 ⇒ 新门应判「湿」，读数不变 | 若变红，先查是不是探针落点算错，**不放宽阈值** |
| `storm-underwater.spec` 读 `aMinY`/`aWaterCol` 的口径 | 语义不变（仍是列级截停面 + 列级水体），只换数据来源 |
| 台阶纳入挡雨后，既有「站在台阶下」的场景行为改变 | 这是**修缺陷**，不是回归；Tier 1 逐个钉住 |
| 非整格顶面方块（slab/横柱/床）露头顶面被判干 | **格顶判据**（§4.6），1032 例穷举钉住 + 负向④ |
| 纹理上传节流不当 ⇒ 每帧 1 MiB writeTexture | 只在「本帧真的重扫过 ≥1 column」时 `needsUpdate=true`；静止世界零上传；上传早于所有 pass |
| 窗口平移瞬间出现「未知」区 ⇒ 短暂多下雨 | 安全失败方向；平移 16 格新增 2 条 16×512 格带 = 64 column ⇒ 8/帧约 8 帧补齐（≈0.13s） |
| 开档首帧远处未扫 ⇒ 棚下也湿 | 预热 3×3 column（0.11ms）覆盖近处；远处 ~2.1s 渐进（§4.4b） |
| 单遍扫描不再报「屋顶下的水」 | 已穷举证明不可达（5684 列全 `stop>水面`，0 可达案例），Tier 1 钉住 |
| 每片元多一次 textureLoad（含关档态） | `bench --check` 门禁；回退 >10% 停下报告 |

---

## 7. 留给实施者的决定
- 队列的具体数据结构（数组 + 排序 vs 双端队列）——只要满足「近处优先 + 编辑插队 + 8 column/帧」；
- `rain-shelter-texture.js` 的上传时机细节——只要静止世界零上传且**早于本帧所有 pass**；
- 纯函数 `wetShelterGate` 的参数顺序与命名——只要 CPU/GPU 两侧读同一份常量与同一个判据。

**不可自行决定的**：窗口尺寸 512、编码公式、挡雨判据、探针法线偏移 0.5、
**格顶判据 `stopY > floor(probe.y)+1+EPS`**、**绝对 texel 索引**、
`uWetShelter` 作为第四级零回归锚点、每帧 8 column 预算、预热 3×3 column。

---

## 8. 实施计划

`docs/superpowers/plans/2026-11-23-rain-per-point-shelter.md`（6 个 Task，逐 Task 带 RED/GREEN/负向验证）。