# 太阳方向光着色 + mc-lite 天空盒（设计）

> 版本：v1 ｜ 日期：2026-10-20 ｜ 状态：已批准（用户四项选型确认后定稿）
> 目标仓库：mc-heavy ｜ 关联：设计文档 §4.4.3（天空/日夜）、§4.4.4（阴影）、§4.6（光照与 AO）

## 1. 问题与目标

用户实玩反馈：「目前的光影效果还是有点平淡，比如太阳光照到的表面要更亮一些，光的背面要更暗一些」，
并补充「mc-lite 的天空盒还有天空的贴图，你也照搬过来」。

**根因不在日夜参数。** mc-heavy 的体素材质是 unlit 管线（`src/render/materials.js` 的
`MeshBasicNodeMaterial`），顶点 shade 只有一项：

```
shade = max(skylight/15 × uSkyDim, blocklight/15 × uBlockBoost) × aoFactor
```

户外 skylight 恒 15（DR-14），于是**一个方块的六个面亮度完全相同** —— 不存在任何朝向差异。
`VISUAL_STYLES` 的三种风格只改 `skyDim`/`blockBoost`/天空色，都是**全局乘数**，怎么调都不会
出现「迎光面亮、背光面暗」。

值得注意的是，mesher 早已把世界面索引写进 packed bit10-12（`mesher.js:450/514`），但渲染侧
**至今零消费点**。通道是通的，缺的只是着色器里那一步。

**目标**：
1. 加入真实的 N·L 方向光项，使太阳照到的面更亮、背面更暗，方向随日夜循环连续变化。
2. 搬入 mc-lite 的天空盒（白天云图 + 夜空星空），在连续日夜循环下交叉淡入。
3. 日轮/月轮 sprite 一并搬入（与天空盒同一来源）。
4. **不移植** ACES tone mapping / 每风格 exposure / canvas CSS 色彩分级（用户明确否决）。

## 2. 方向光模型（核心决策）

### 2.1 公式

在**顶点阶段**解码 packed bit10-12 得到面法线 `n`（六个轴向常量之一），片元阶段合成：

```
sunDot     = max(dot(n, uSunDirection), 0)                    // 顶点 varying，逐 quad 常量
shadowKill = clamp((shadowFactor − SHADOW_FLOOR)/(1 − SHADOW_FLOOR), 0, 1)   // 见 2.3
sunTerm    = SUN_AMBIENT + SUN_INTENSITY × sunDot × uSunStrength × shadowKill
shadeLit   = max(vSkyShade × sunTerm, vBlockShade)
```

- `sunDot` 在顶点阶段算、走 float varying。四个顶点同面同值 → 插值结果恒为常量，
  不会出现色块。**不得**在片元读 packed（`three.webgpu.js:65404` 对 int varying 强制 flat）。
- blocklight 项**不吃太阳**：`max(sky×sunTerm, block)` 保持「火把在洞里照样亮」的语义。
- transparent 通道（水/玻璃）**不接** sunTerm —— 海面已有自己的太阳高光
  （`ocean.js` 的 Blinn-Phong），且该通道恰是零回归的安全垫。

### 2.2 标定：两个常数不是拍的

| 常数 | 取值 | 来源 |
|---|---|---|
| `SUN_AMBIENT` | 0.5 | **恒等于 `SHADOW_FLOOR`**（同一语义：太阳完全被拿走后的环境光地板） |
| `SUN_INTENSITY` | `(1 − SUN_AMBIENT) / noonSunY` = 0.5 / 0.8 = **0.625** | 由 `VISUAL_STYLES.noon.sunDirection` 归一化后**派生**，不写字面量 |

派生而非硬编码的理由（红线 1）：改风格太阳方向时强度自动跟着走，否则「正午顶面亮度 = 1.0」
这条不变式会静默失效。

**硬不变式（本设计的验收锚点）：**

```
SUN_AMBIENT + SUN_INTENSITY × noonSunY ≡ 1.0
```

即**正午 +Y 面亮度恒等于 1.0，与现状逐位相同**。落地效果（noon，uSunStrength=1，无阴影）：
顶面 1.000 / +Z 面 0.875 / ±X 面 0.725 / −Z、−X 面 0.500。对比度 2.0×，地面观感零回归，
变化全部集中在侧面朝向。

morning（y=0.4500 归一化后）则出现小幅过曝：+Z 面 0.5 + 0.625×0.8815 = 1.051。
这是「迎光面更亮」的正面收益，不是缺陷。

### 2.3 阴影与地板必须和 sunTerm 合成，不能各乘一遍

现状 `shadowFactor = mix(1, mix(SHADOW_FLOOR, 1, shadow()), uShadowStrength)` 直接乘在
整个 `vSkyShade` 上。若把 `SUN_INTENSITY × sunDot` 再乘一次它，正午顶面在影区会变成
`0.5 + 0.625×0.8×0.5 = 0.75`（应为 0.5）→ 阴影变淡 50%，`sun-shadow.spec` 的冻结比值
`0.735` 崩溃。

故把阴影因子**只作用在太阳项**上，且用 `shadowKill` 把它重标定到「完全拿走太阳」：

- 影区：`shadowFactor = 0.5` → `shadowKill = 0` → `sunTerm = 0.5`（与现状 0.5 逐位相同）
- 受光：`shadowFactor = 1` → `shadowKill = 1` → `sunTerm = 1.0`（与现状 1.0 逐位相同）
- 关阴影（`uShadowStrength = 0`）→ `shadowFactor = 1` → `shadowKill = 1` → 满强度太阳 ✓
- `sunLight = null`（fixture 路径）→ `shadowKill = 1`（无阴影可比），保持原路径契约

推论（会实测复核，不假设）：**`sun-shadow.spec` 的三个冻结比值数学上不变**，因为被测采样
点都在平台顶面（+Y，正午 dot=0.8 → 受光 1.0 / 影区 0.5）。

## 3. 天空盒：双图交叉淡入

### 3.1 资源

从 mc-lite 原样复制（不重编码、不缩放）：

| 源（mc-lite） | 目的（mc-heavy） | 体积 | 用途 |
|---|---|---|---|
| `src/assets/skyBox4/{posx,negx,posy,negy,posz,negz}.jpg` | `assets/sky/day/` | 912K | 白天云层 |
| `src/assets/skyBox1/{...}.jpg` | `assets/sky/night/` | 5.1M | 夜空星空 |

`skyBox2`（日落，356K）**不搬** —— mc-lite 自身零引用（`grep skyBox2 src/` 只有目录存在），
搬进来就是死资源。

### 3.2 混合

```js
scene.backgroundNode = mix(cubeTexture(nightCube, dirNode), cubeTexture(dayCube, dirNode), uNightBlend)
```

- `uNightBlend` 由**既有数据派生**，不新增权威：
  `nightBlendOf(skyDim) = clamp((1 − skyDim) / (1 − VISUAL_STYLES.night.skyDim), 0, 1)`
  → 正午 0、晨 0.267、夜 1，随关键帧插值连续变化。夜间程度与天空暗度天然同步。
- 采样方向用 three 背景网格提供的世界法线（`normalWorldGeometry`）。⚠️ 该节点的朝向必须
  实测校准（`CubeTextureNode.setupUV` 内部有 x 取反与 envRotation），不得凭读源码推断。
- `uNightBlend` 写入点在 `DayNight._apply`（与 `uSkyDim` 同一处），所以 `setStyle` 与日夜循环
  两条路径口径一致。

### 3.3 降级与开关

- 加载失败（网络/解码）→ `console.warn` + 退回现有纯色 `scene.background`（不阻断启动，
  与丧尸头部/炮塔装甲纹理同一容错口径）。
- `?skybox=0` URL 参数 → 完全不加载、不建 backgroundNode，观测口径与 v1.57 逐位相同。
  这是既有 spec 的隔离入口（见 §5）。

### 3.4 有意偏离 mc-lite（两条）

1. **不做 `backgroundBlurriness = 0.28`**。它会让 three 走 `pmremTexture` 路径（需预滤波立方图
   render target），与本方案的 `scene.backgroundNode` 自定义采样冲突；且那个值本是 mc-lite
   **离散切风格**时的补偿（0.28 是为了让星空不那么刺眼），交叉淡入下星星该是清晰的。
2. **天空盒随连续日夜插值**（mc-lite 只在点风格按钮时换贴图）。这是本仓库日夜模型的既定
   差异（v1.44 的太阳方向同理），非本次引入。

## 4. 日轮 / 月轮

- canvas 径向渐变生成（照 mc-lite `Engine.js:429-495` 的绘制参数：太阳三层暖色渐变，
  月亮先柔和月晕再画满月圆盘）。
- 位置 = `相机位置 + 方向 × (camera.far × 0.55)`，缩放 `= style.size × (distance / 150)`
  —— 等比缩放保证不随视距变形（mc-lite 固定 150 单位 + 固定尺寸，本仓库视距可从 2 变到 16）。
- **月轮**按 mc-lite 原值：仅 `night` 风格 `moonVisible: true`，尺寸 night 34 / morning 20 / noon 18。
- **日轮**创建并接线，但三套风格的 `sunVisible` 在原值里**全是 false** —— `skyBox4` 贴图本身
  烘焙了太阳光晕，再画一个会变成两个太阳。照原样保留，改一个字段即可打开。
- 位置刷新走既有 `_updateSunPosition()` 的调用节奏（玩家移动 >5 格 / 太阳方向过 0.5° 门控），
  不新增每帧成本。

## 5. 回归面与隔离

新增的方向光会改变**所有侧面**的屏幕亮度，新增的天空盒会让「纯色天空」判据失效。
按 `docs/testing-policy.md` 与既有 precedent（`daynight-visual` 量亮度前关阴影），
受影响者在**被测 setup** 里隔离，断言与阈值逐字不动：

| spec / fixture | 隔离方式 | 理由 |
|---|---|---|
| `render-terrain` / `city-visual` / `sky-structures` | 用例 URL 加 `&skybox=0` | 它们用「RGB ±30 内等于 0x87ceeb」数地形像素；照片天空会让该判据失去意义（下界会因污染而恒真）。**实测天空区 99.4% 的像素被误判成地形**（`city` nonSkyRatio 0.881 → 0.938） |
| `m3-rain` | 用例 URL 加 `&skybox=0` | 截图差分测白色雨滴，压在白云上会看不出 |
| `test-sky-tree.html` | fixture 内 `uSunStrength = 0` | 绝对叶色判据 `ratioA` 在方向光下从 **1.000 跌到 0**（该 fixture 测的是通语义，不是光照）。隔离后回到 1.000 |
| `ao-visual` / `ao-corner-visual` | **不改**（实测零漂移） | 采样区是顶面（dot=0.8 → sunTerm 恒 1.0），与零回归不变式一致 |

**不得**为了让断言通过去改阈值或删断言。若实测发现某条真的必须变，停下来报告并给交替对照。

## 6. 新增测试

| 级别 | 用例 | 判据 |
|---|---|---|
| Tier 1（浏览器内单测） | `src/tests/test-sun-shade.js`（8 条） | ① `SUN_AMBIENT === SHADOW_FLOOR` ② 正午顶面 sunTerm ≡ 1.0（1e-9）③ `strength=0` 时六面全 ≡ 1.0 ④ 侧面严格单调：顶 > 迎光侧 > 背光侧 > 0 ⑤ 阴影只拿走太阳（shadowKill=0 → 地板）⑥ 太阳转向另一边时迎光/背光互换 ⑦ `FACE_NORMALS` 与 mesher 面序一致 |
| Tier 1 | `src/tests/test-daynight.js`（+4 条） | `nightBlendOf` 端点（noon 0 / night 1）/ 6→12 单调不增 / 钳制 [0,1]；`moonDirection` 三风格原值 + 插值后仍是单位向量；`uSunDirection`/`uNightBlend` 写入路径 + 句柄缺失容错 |
| Tier 4 | `tests/sun-directional.spec.mjs` | 平台 + 沿 x 的墙，固定相机；A/B `uSunStrength` 0↔1 — ①关掉时 +Z/−Z 两面等亮（∈[0.95,1.05]）②打开时迎光面显著亮于背光面（∈[1.20,1.45]，**sRGB 口径**）③顶面亮度不随开关变化（∈[0.99,1.01]） |
| Tier 4 | `tests/skybox.spec.mjs` | ①正午天空方差 > 4（纯色≈0）②夜间方差 > 1.5（防「夜间贴图没加载、只是深色纯色」）③夜间均值 < 正午×0.5 ④`uNightBlend` 正午 0 / 夜 1 / 黄昏居中且与 skyDim 反向单调 ⑤月轮仅夜间可见、日轮默认不可见 ⑥`?skybox=0` 对照组方差 < 1（反向证明①的方差判据真在测贴图） |
| Tier 2 | `tools/check-data.mjs` `[天空盒]` | 12 张 JPEG 齐全 + 清单唯一权威 = `src/render/sky-config.js` |

### 6.1 实测数据（2026-10-20）

**方向光**（`sun-directional.spec`，noon，1280×720）：

| 读数 | 值 |
|---|---|
| +Z 面 uSunStrength=0 / =1 | 120.9 → **113.4** |
| −Z 面 uSunStrength=0 / =1 | 119.9 → **86.4** |
| 关闭时两面比 | **1.008**（读法无偏） |
| 打开时两面比 | **1.313**（sRGB 理论 1.286~1.347） |
| 顶面 uSunStrength=0 / =1 | **138.9 → 138.9（逐位不变）** |

**天空盒**（`skybox.spec`，480×360 抬头看天）：

| 读数 | 正午 | 深夜 |
|---|---|---|
| 均值 | 201.6 | **38.3** |
| 方差 | 53.7 | 571.9 |
| `uNightBlend` | 0 | 1 |
| 月轮可见 | false | **true** |

对照：`?skybox=0` 纯色天空均值 192、方差 **0.00**。黄昏（19h）`uNightBlend = 0.274`、`skyDim = 0.794`（连续过渡，非二态）。

**朝向等价核验**：自定义 `backgroundNode` 路径 vs three 默认 `scene.background = cubeTexture` 路径，同机位同帧 **diff = 0 / 172800 像素**。

**冷启动**：`worldReady` **733ms**（未出现明显拖慢；6MB JPEG 由浏览器并行解码）。

## 7. 明确不做

- ACES tone mapping / 每风格 exposure / CSS 色彩分级（用户否决）。
- 实体投射/接收阴影、`castShadowNode`、水体反射采样天空盒、PMREM 环境光。
- 设置面板开关（只留 `?skybox=0` URL 参数）。

## 8. 风险

1. **`scene.backgroundNode` 采样朝向**：方向搞错的表现是「天空左右镜像」，肉眼容易过。先用最小
   fixture 探针确认，再用像素判据钉住。
2. **启动时间**：多 6MB JPEG + 两张 1024² 立方图解码。测 `worldReady` 耗时；超预期就改夜间纹理
   延迟加载。
3. **VRAM**：两张 cubemap 含 mip 约 33MB。无现成指标，只做帧时 + 目视。
4. **bench 结构门**：背景多 1 次 draw（489→490），结构类容差 2%，预期通过；用 `--check` 实测。
