# 雨天光栅晃动根因修复 + 四项水下排除

日期：2026-11-22
状态：**已实施完成**（版本号 **v3.30g** —— `v3.30f` 已被曳光重标占用）

> **实施期修正（计划外的真缺陷，全部由实测抓到）**：
> 1. `rainStopY` 的水面扫描起点要与 `rainShelterY` 同口径钳到 `RAIN_CEILING_Y`，
>    否则玩家飞高时窗口够不到水体 ⇒ 水门静默失效。
> 2. 雨丝的水下门**必须 GPU 逐顶点判**：`aShelter` 是 10Hz 采样，而雨丝在 18 格
>    循环盒里跑 ⇒ 实测 994 滴水下雨丝照样上屏。新增逐实例 `aWaterCol`（列级，变化慢）
>    + uniform `uWaterY`，GPU 算 `mix(1, step(uWaterY, p.y), aWaterCol)`。
>    不能无条件按 y 判 —— 干坑/峡谷（无水列）的雨是合法的。
> 3. 落叶的水面扫描**不能拿全局 `WATER_SURFACE_Y` 做下界**（它只对天然地形成立，
>    玩家造的水可在 y=56）；且要加「身体那一格真的是水」以免误杀湖底干洞穴。
> 4. 判据要量**可见性**（GPU 真实 fade）而不是位置；负向验证要同时退回**两道门**
>    才能穿透多层防御。

## 一、光栅晃动：根因已证实（不是远景雨幕）

远景雨幕在 v3.30e 已整层删除，屏幕上的竖纹**不是它**。真凶是后处理链的**胶片颗粒（film grain）**。

**代码级根因**：`src/render/storm-grade.js:203` 写的是

```js
const g = hash(floor(screenUV.mul(screenSize)).add(vec2(t, t))).sub(0.5);
```

但 three r185.1 的 TSL `hash` 是 **PCG 标量哈希**（`vendor/three/three.webgpu.js:36670`）：

```js
const state = seed.toUint().mul(747796405).add(2891336453);
```

`seed.toUint()` 对 `vec2` 走 `ConvertNode` → `builder.format()`（`:53789`）的
`fromTypeLength > toTypeLength` 分支 ⇒ **`snippet.x`**。⇒ **y 分量被整条丢掉**：
颗粒只随屏幕 **x** 与时间变，沿 **y 恒定** ⇒ 每一列整列同亮同暗 = 竖纹；
`fract(uTime*7.31)*113` 每帧重掷种子 ⇒ 竖纹逐帧乱跳 = 用户看到的「CRT 扫描线在动」。

**上游为什么没有**：`bj-shooting-game/night-heron-src/src/gfx/renderer.js:165` 的
`FXAA_FRAG` 自带一个**真二维** `hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); … }`。
移植时把上游那个自定义 hash 换成了 vendor 的同名 `hash`，而两者签名不同 ——
这正是「上游能看的层在本仓必然错」的第三个根因（前两个是硬格子、欠采样走样）。

### 实测证据（真实 GPU 像素，非目视）

| 判据 | 缺陷态 | 对照 |
|---|---|---|
| 列均值的时间 std（整幅，grain 开/关单变量） | **5.192** | grain 关 **0.048**（108×） |
| 行均值的时间 std（同一批帧） | **0.09** | — |
| 隔离 grain 层：列内沿 y std / 行内沿 x std | **0.783 / 7.161**（≈1:9） | 各向同性应 ≈1:1 |
| 同一列内像素完全相同的比例（天空带） | **85.7%** | — |
| `page.route` 单变量注入真二维标量种子后 | 列内/行内 **3.498 / 3.988**、列均值 std **3.55→0.556** | 竖纹消失 |

用户视频 `/Users/bachi/ttt/bug/光栅晃动.mov` 的独立测量与之吻合：
列剖面时间 std **4.71**、行剖面 **0.22**。

**第二个偏差（用户已裁定一并修）**：颗粒现在加在 **ACES 之前的线性空间**，
且 `grainDarkBoost` 让暗部更强 ⇒ 暗部噪声被 ACES 放大。上游是在 FXAA 之后的
**显示空间**加，且用的是 `m.a`（显示 luma）。

---

## 二、四项水下排除：现状与口径

现在这四项**完全没有水下判据**：`rain-shelter.js` 只判「挡雨方块」
（水 `solid=false` ⇒ 第一条就排除，注释还写着「雨落进水里是对的」）；
`leaf-fx.js` 用 `isSolid` 找地面（水非实心 ⇒ 穿过水停在湖底）；
`wet-ground.js` 只有 `uWet` 总强度与室内门。

**新增唯一权威**：`src/render/water-surface.js`（three-free，Tier 1 可单测）。
判据走 registry 派生而非名字白名单 —— 实测 159 个方块里
`非实心 ∧ transparent 通道` **恰好只有 `water` 与 `swamp_water`**（玻璃是 `solid:true`），
与 `isPlant` 的「派生而非声明」同一手法。

导出三个纯函数：

- `isWaterLike(id, registry)` —— `solidTable=0 ∧ cullTable=2`；
- `waterSurfaceYAt(world, registry, x, z, fromY, depth)` —— 从 `fromY` 往下找
  **最上层暴露水面**的顶面 y（= 该格 y+1 − `WATER_SURFACE_SINK`）；
  沉在水下的水格不算水面（上方还是水）。`WATER_SURFACE_SINK=0.5` 现在是
  `mesher.js` 的模块私有常量，**提到 `voxel/constants.js`** 供 mesher 与本模块共用
  （红线 1，不写第二份 0.5）；
- `isBelowWater(world, registry, x, y, z)` —— 该点是否在水面之下。

### 四项落点

用户裁定：**只剔除水下个体，不整池停**；湖面**要**生成水花。

| # | 要求 | 改法 |
|---|---|---|
| ① | 落叶不在水下 | `leaf-fx.js` 的 `_resolveGroundY` 之上加水面判定：出生点/迁移点若在水下 ⇒ **跳过该片**（同既有「地面扫不到就跳过」口径，不回落）；已播种的叶子在 `_recycle` 里按当前 y 判水下 ⇒ alpha 归 0 |
| ② | 雨滴不在水下 | `storm-rain.js` 的 `_resolveShelterBatch`：截停面取 `max(挡雨面, 水面)` ⇒ 雨丝在水面截停；`aMinY` 已是逐实例属性，**零新增属性**（WebGPU 8 buffer 上限） |
| ③ | 地面反光不在水下 | `wet-ground.js` 新增 `uWetWaterY`（水面高度）uniform ⇒ 片元 `wp.y < 水面` 时 `wet=0`（mix 取左端，逐位回到原色）。**不能只靠 CPU 总强度** —— 站在岸上看湖底是「相机在水上、片元在水下」 |
| ④ | 水花不在水下 | `_spawnSplashes` 的落点 y 取 `max(挡雨面, 水面)` ⇒ 被淹的湖底不生成；**湖面生成水花**（用户裁定），落在 `waterSurfaceYAt` 给的顶面 |

③ 的逐片元判据需要「水面高度」。**取法**：TSL 无体素访问 ⇒ 走**世界高度基准**。
本仓所有暴露水面都严格共面于 `SEA_Y + 0.5 = -1.5`（`fillColumn` /
`fillShallowTarnBasin` / `fillTarnPlateau` 三处写水都以 `SEA_Y` 为上界，
mesher 统一下沉 0.5，海面平面也在 −1.5）。⇒ `uWetWaterY` 是**常量** `WATER_LEVEL_OFFSET`，
判据 `wp.y < WATER_LEVEL_OFFSET` 即「在水面以下」。

⚠️ **这一条要在实现时用真实体素数据验证共面性**（读若干列的水格顶面），不靠推断。

---

## 三、改动清单

| 文件 | 改动 |
|---|---|
| `src/voxel/constants.js` | 新增导出 `WATER_SURFACE_SINK = 0.5`（从 mesher 提级，唯一权威） |
| `src/mesh/mesher.js` | 改为 import 该常量，删本地字面量（几何行为逐位不变） |
| `src/render/water-surface.js` | **新增**：`isWaterLike` / `waterSurfaceYAt` / `isBelowWater`（three-free） |
| `src/render/storm-grade.js` | grain 种子改真二维标量（`gp.x.add(gp.y.mul(65536))`，实测已验证有效）；grain 从 `gradeNode`（线性）**移到 `gradeTailNode`（显示空间）**，暗部权重改用显示 luma；文件头补第三个根因的实测记录 |
| `src/render/storm-grade-config.js` | `grainDarkBoost` 注释改为「按显示 luma」（语义随位置变） |
| `src/render/rain-shelter.js` | 新增 `rainStopY` 收口（挡雨面与水面取 max），保持 `blocksRain` 语义不变 —— 水仍不「挡雨」，但**截停**雨 |
| `src/render/storm-rain.js` | `_resolveShelterBatch` / `_spawnSplashes` 消费水面截停 |
| `src/render/leaf-fx.js` | 出生/迁移/回收三处加水下剔除 |
| `src/render/wet-ground.js` | 新增 `uWetWaterY` + 片元水下门（`wet` 乘门控） |
| `src/render/wet-ground-config.js` | 新增水下门常量与纯函数（可单测） |
| `src/core/game.js` | 装配层接线（水面 uniform 写入；`_updateStorm` 的室内门与水下门并列） |
| `src/tests/test-water-surface.js` | **新增** Tier 1（真实 registry + 假 world，钉共面性/暴露水面/水下判定边界） |
| `src/tests/index.html` | 注册新单测（漏注册 = 静默不跑） |
| `src/tests/test-rain-shelter.js` / `test-storm-rain.js` / `test-ambient-fx.js` | 补水下相关断言 |
| `tests/storm-rain-visual.spec.mjs` | 新增「grain 各向同性」Tier 4 用例（列内/行内 std 比值 + 列均值时间 std）；现有两条竖纹用例的 `uGrain=0` 前置**保留**（它们量的是别的层） |
| `tests/storm-lighting.spec.mjs` | 新增四项水下排除的 Tier 4 用例（真实入水，像素差分） |
| `docs/pitfalls.md` / `docs/roadmap.md` | 记第三个根因与四项水下口径 |

**不做**：不动远景雨幕（已删，不补齐）；不改既有 `blocksRain` 的「水不挡雨」语义
（那是屋顶判据，与截停面是两件事）；不加面板开关；不改 grain 强度 0.045（上游值）。

---

## 四、验证（按 testing-policy 分级，最小充分集）

1. **Tier 1 TDD（先 RED）**：`test-water-surface.js` 的水面/水下判定；
   grain 各向同性无法在 Node 判 ⇒ 走 Tier 4。
2. `npm run check`（5.4s，每次改动都跑）。
3. `npm run test:unit`（改了纯函数/常量）。
4. **只跑消费本改动的 spec**：`storm-rain-visual` / `storm-lighting` / `ambient-fx` /
   `carbine-flash-wet`（共享 wet 装配段）+ `tests/unit-fast.spec.mjs`（mesher 常量提级）。
5. **Tier 4 像素实测**（GPU 求值，不得宣称目视）：
   - grain：列内 std / 行内 std 比值 ∈ [0.7, 1.4]，列均值时间 std < 行内 std 的 1/4；
   - 四项水下：入水前后同机位差分，水下区域的雨丝/落叶/水花/反光贡献必须归零，
     水上区域不变。
6. **负向验证（必做）**：用 `page.route` 在浏览器侧把 grain 种子改回 `hash(vec2)`
   ⇒ 新判据必须真 FAIL；把水下门去掉 ⇒ 四项用例必须真 FAIL。
   **不碰工作树**（并发会话安全），撤销用 `cp` 副本而非 `git checkout`。
7. **不跑全套**（本改动不是全局基础设施；mesher 常量提级是纯提级、几何逐位不变，
   用 `test-mesher` + `unit-fast` 覆盖）。若 mesher 常量提级实测出几何差异，停下来报告。

**风险与停机条件**：`WATER_SURFACE_SINK` 提级若让任何 mesher 断言变化 ⇒ 停下报告，
不擅自改断言。水面共面性若实测不成立（存在非 −1.5 的暴露水面）⇒ ③ 的常量方案不成立，
停下来改用逐列方案并报告。

---

## 五、用户裁定记录（2026-11-22）

1. **颗粒修法** = 修成真二维颗粒 + 移到显示空间（不是整层删除、不是静止图案）。
2. **湖面生成水花**（被水淹住的湖底不生成）。
3. **相机潜水时只剔除水下个体**，水面之上的雨丝照常 —— 不整池停。