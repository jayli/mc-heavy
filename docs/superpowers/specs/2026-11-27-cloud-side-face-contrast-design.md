# 云方块侧面 / 顶底面的明暗分离（面间对比）

设计日期：2026-11-27。用户裁定：路线 **A（侧提亮 + 顶底压暗）**、范围 **只做 cloud 本体**、
幅度 **侧 ×1.38 / 顶 ×0.95 / 底 ×0.72**（本文 §4 的实测表就是批准的那一份）。

---

## 1. 要解决什么

用户原话（附两张截图）：

> 「这张图是从底向上看云朵，一个大的云岛下方有一小片云朵，就在十字准心对准的方向，
> 小云朵就模糊不清，几乎分辨不出来，因为云朵底色、垂直的面的颜色和背后的大云岛的底色
> 完全一样，肉眼分辨不出来。我希望让云方块的侧面的四个面（非顶面和底面）在颜色上比顶面
> 和底面更亮一些、更白一些……这样看上去云朵更有立体感，就像这张图一样（MC 原版）。」

- 缺陷图 `~/ttt/bug/cloud.png`（998×630）
- 参考图 `~/ttt/bug/cloud_ori.png`（1920×1080，MC 原版逆光仰视）

## 2. 根因：一个恒等式，不是参数没调够

`render/cloud-shade.js` 的半球地板取 `CLOUD_HEMI_LIFT = 0.50`：

```
cloudHemiFloorFor(g, 0.5) = g + (1−g)×0.5 = (1+g)/2
hemiFactor(侧面)          = g + (1−g)×(0/2+0.5) = (1+g)/2   ← 逐位相等
```

⇒ **半球地板恰好等于四个侧面的 hemi 因子**（g=0.6 时两边都是 0.8；g=0.12 时都是 0.56）。
同时正午太阳 `[0, 0.8, 0.6]` 下侧面与底面的 `N·L` 都 ≤ 0 ⇒ 太阳项双双落到同一地板
`cloudSunFloorFor(0.38) = 0.597`。两项相乘 ⇒ **底面与四个侧面逐位同色**。

AO 项在开阔面（ao=3）恒 1，也不提供差异。这就是「小云朵与大云岛底色糊在一起」的机制。

### 2.1 实测证据（不是推断）

| 量 | 值 | 取证 |
|---|---|---|
| 缺陷图大云岛底面 | **160.9**（rgb 153.7/159.5/169.4） | `cloud.png` 区域 (400,250) r=10 均值 |
| 缺陷图准心处小云朵 | **152.1**（144.8/151/160.6） | 同图 (660,270) r=6 |
| 参考图云体底面 | **182**（168/178/200） | `cloud_ori.png` (1080,430) r=10 |
| 参考图侧面亮带 | **218**（204/214/236） | 同图 (1010,430)，逐行扫描确认是侧面窄带 |
| ⇒ 原版侧/底屏幕比 | **1.198** | 218 / 182 |
| 本仓五档侧/底比 | **全部 1.000** | CPU 按真实公式 + ACES 逐档算（noon/morning/dusk/night/normal） |

## 3. 非目标 / 反目标

| 不做 | 理由 |
|---|---|
| 扩到巨型云的 snow / clay / marble / cloth 面 | 用户裁定沿用 v3.50 的「先只做 cloud 本体」。扩范围要逐结构标记（烘焙 stride 4→5），且撞 `check-data.mjs` 的「snow/sky_stone 保持不变」 |
| 改 mesher / packed 位段 | 面类别由已有的 `faceNormalNode.y` 判，bit19 已足够 ⇒ **零 mesher 改动、零新增顶点属性** |
| 改 `cloud.cullMode` / `opaqueTable` / `shadowCast` | 与 v3.50 同口径，玩法与阴影不动 |
| 重烘任何产物 | 不改贴图、几何、方块声明 ⇒ 全部指纹不变 |
| 新增设置面板开关 | 用户没要求；`uCloudFaceContrast` 只作测试旋钮与将来接入点 |
| 给云加「上限 cap」 | **实测否决**：`min(v, 1)` 会把 night +Z 面的 R−B 从 −32.4 抹成 **0**（等比钳 `min(v, base×k)` 则吃掉对比增益）。正解是把幅度取在安全上界内（§4.2） |

**反目标（做成了也算失败）**：
1. 云被抹成中性灰（带色偏的重映射）—— 用户要的是「更白」，不是「换个颜色」；
2. 任何一个面过曝削顶（线性 > 1 ⇒ ACES 钳平三通道 ⇒ 色相消失）；
3. 整体提亮冒充面间对比（顶底必须真的变暗）。

## 4. 方案（路线 A，已批准）

在 `shadeLit` / `shadeUnlit` 上乘一个**逐面类别的灰阶 gain**：

```
faceK = 顶面(N.y > 0.5) ? 0.95 : 底面(N.y < −0.5) ? 0.72 : 1.38
gain  = mix(1, faceK, cloudBit × uCloudFaceContrast)
shade = 原 shade × gain
```

三个常量（`render/cloud-shade.js`，**不是冻结常量**，职责分离）：

```js
export const CLOUD_SIDE_FACE_GAIN = 1.38;   // 四个侧面（|N.y| < 0.5）
export const CLOUD_TOP_FACE_GAIN  = 0.95;   // 顶面
export const CLOUD_BOTTOM_FACE_GAIN = 0.72; // 底面
```

### 4.1 为什么是灰阶 gain 而不是改 lift / 改地板

三条都算过（五档 × 6 面 × 4 AO = 120 组 CPU 扫描）：

| 写法 | 问题 |
|---|---|
| 只压暗底面（底 ×0.60，侧顶不动） | noon 侧/底 1.171 达标，但**侧面没变白**，与用户「侧面更亮更白」的字面要求不符 |
| 改三个 lift 让地板按面分档 | 保持纯 `max`（亮面结构性恒等），但 normal 档底面掉到 **93**、侧/底 **1.98** ⇒ 档间失衡 |
| **逐面灰阶 gain（选中）** | 五档侧/底 ∈ [1.175, 1.502]，最小差 **33 灰阶**；灰阶 r=g=b ⇒ 保色相 |

⚠️ **灰阶是载荷性的**：`sunTermSoft` 是 vec3（含色温），gain 必须是标量乘整个 vec3
（等比缩放 ⇒ 色相不变）。逐通道给不同 gain 会把云拉出色偏，与「更白」相背。

### 4.2 1.38 是实测的安全上界，不是随手取的

侧面 gain 扫描（顶 0.95 / 底 0.72 固定，全 5 档 × 6 面 × 4 AO 取最大线性值）：

| 侧 gain | 最大线性 | 位置 | 判定 |
|---|---|---|---|
| 1.30 | 0.9500 | noon 顶 ao3 | 安全 |
| 1.35 | 0.9634 | dusk +Z ao3 | 安全 |
| **1.38** | **0.9848** | dusk +Z ao3 | **选中**（留 1.5% 余量） |
| 1.40 | 0.9990 | dusk +Z ao3 | 贴线，不留余量 |
| 1.42 | **1.0133** | dusk +Z ao3 | ❌ 削顶 |
| 1.45 | **1.0347** | dusk +Z ao3 | ❌ 削顶 |

⇒ **不加 cap**，靠幅度本身保证不削顶。这条上界必须写成 Tier 1 断言（改幅度时当场红）。

### 4.3 必须新增独立 uniform，不能复用 `uCloudSoften`

`uCloudSoften = 0` 会**同时关掉 v3.50 的三个地板** ⇒ 那不是本轮的单变量对照。
故新增 `uCloudFaceContrast`（初值 1）：

- `= 0` ⇒ `gain = mix(1, faceK, 0) = 1` ⇒ **逐位回到 v3.50**（CPU 实测最大屏幕差 **0**）；
- `= 1` ⇒ 满档面间对比。

Tier 4 的 A/B 唯一变量就是它。

### 4.4 批准幅度的逐档实测（CPU 真实公式 + ACES，tex=255）

| 档 | 侧面 | 顶面 | 底面 | 侧/底 | Δ灰阶 | 底面 R−B（现状） |
|---|---|---|---|---|---|---|
| noon | 203.6 → **217.9** | 231.6 → 230.2 | 203.6 → **185.4** | **1.175** | 33 | 0 → 0 |
| morning | 191.6 → 208.4 | 212.8 → 210.5 | 191.6 → 171.1 | 1.218 | 37 | 0 → 0 |
| dusk | 189.2 → 206.4 | 203.4 → 200.8 | 189.2 → 168.4 | 1.226 | 38 | −19.2 → −22.3 |
| night | 111.3 → 134.3 | 129.1 → 125.4 | 111.3 → 89.4 | 1.502 | 45 | −16.6 → −15.0 |
| normal | 163.0 → 184.1 | 217.0 → 215.0 | 163.0 → 139.6 | 1.319 | 45 | −21.7 → −22.9 |

凹角面（ao=1）侧/底差 40~47 灰阶。最大色相偏移 **4.3 灰阶**（dusk +Z ao0，21.7 → 17.4），
方向不变（暖侧仍暖、冷侧仍冷）。

⚠️ 这些是 ACES 口径的 CPU 预测；**normal 档走自定义 AgX + 曝光 2.2**，其屏幕值必须在
Tier 4 里实测重标，不得拿本表当 normal 档的阈值。

## 5. 实现

### 5.1 `src/render/cloud-shade.js`（three-free，零 import 不变）

新增三个常量（§4）+ 一个纯函数：

```js
/** 面类别 gain：normalIndex 0..5（FACE_NORMALS 同序）。contrast=0 ⇒ 恒 1。 */
export function cloudFaceGainFor(normalIndex, contrast = 1)
```

实现口径：按 `CLOUD_FACE_NORMALS[normalIndex][1]` 分档（>0.5 顶 / <−0.5 底 / 否则侧），
返回 `1 + (faceK − 1) × contrast`（与 TSL 的 `mix(1, faceK, t)` 同形，保 `contrast=0` 逐位）。

`cloudShadeFor` 增加可选入参 `faceContrast = 0`（**缺省 0 = 逐位回到现有行为**，
既有 7 组不变式与 7776 组零回归用例一字不动），末尾乘 `cloudFaceGainFor(normalIndex, faceContrast)`。

### 5.2 `src/render/materials.js`

1. `CLOUD_SURFACE_UNIFORMS` 加 `uCloudFaceContrast: uniform(1.0)`（模块顶层单例 ⇒ 反射替身自动跟随）；
2. 面类别 gain 节点（**复用已有的 `faceNormalNode`**，不新增属性）：
   ```js
   const cloudFaceK = select(faceNormalNode.y.greaterThan(0.5), float(CLOUD_TOP_FACE_GAIN),
     select(faceNormalNode.y.lessThan(-0.5), float(CLOUD_BOTTOM_FACE_GAIN), float(CLOUD_SIDE_FACE_GAIN)));
   const cloudFaceGain = mix(float(1), cloudFaceK, mul(cloudBit, uCloudFaceContrast));
   ```
3. `shadeLit` 与 `shadeUnlit` **两处都**乘 `cloudFaceGain`（只改一处会让 transparent 通道口径不一致；
   该通道无云 ⇒ 逐位恒等，但源码级断言要钉住两处）；
4. 返回值 `dayNight` 与 `cloud` 句柄都透出 `uCloudFaceContrast`。

⚠️ TSL 口径（`wet-surface.js` 文件头七条）：不与裸数字算术、不用 `.toVar()/.assign()`、
select 嵌套不链式。`select` / `mix` / `float` 已在既有 import 列表里。

⚠️ **gain 必须乘在 `max(sky×hemi×sunTerm, block)` 之外**（整个 shade 上），
不是只乘 sky 项 —— 只乘 sky 会让火把照亮的云面不参与面间对比。

### 5.3 `daynight.js`：**不改**

三个 gain 与 style 无关（灰阶比例），只由模块初值提供。
`_apply` 不写它（与 `uCloudAoFloor` 同口径，既有断言「`_apply` 不得写 uCloudAoFloor」同款手法可加一条）。

## 6. 验证策略

分级：纯函数 = **Tier 1**（必须 TDD）；GPU 着色 = **Tier 4**（像素实测）。

### 6.1 Tier 1 新增（`src/tests/test-cloud-shade.js`）

1. `contrast=0` ⇒ 六面 gain **逐位** 1；`cloudShadeFor` 缺省与显式 0 都逐位等于现有公式；
2. `contrast=1` ⇒ 四侧面 gain 逐位 1.38、顶 0.95、底 0.72；
3. **侧/底屏幕比 ≥ 1.15**（五档 × ao∈{1,3}），且侧面变亮 / 顶面变暗 / 底面变暗**同时**成立
   （只判比值会被「整体压暗」蒙过）；
4. **削顶上界**：五档 × 6 面 × 4 AO 的最大线性值 **< 1.0**（实测 0.9848）；
   并钉「侧 gain 取 1.42 时该扫描 > 1」——证明这条判据有判别力；
5. **保色相**：dusk/night/normal 三档底面 R−B 符号不变且 |偏移| < 8 灰阶；
6. `cloudShadeFor` 的 gain 与独立参考实现交叉一致（不留第二份公式）。

### 6.2 Tier 1 旧断言的语义重标（**不是放宽容差**）

`test-cloud-shade.js` 现有「soften=1 时任何面都不得变暗」与「顶面逐位不变」两条，
在 `faceContrast` 缺省 0 下**仍应逐位成立**（本轮不改 soften 语义）⇒ **不动**。
新增用例只覆盖 `faceContrast=1` 的新语义。

### 6.3 Tier 4（`tests/cloud-softness.spec.mjs` 扩充）

夹具沿用已验证口径（两块 13×13×2 悬空厚板 cloud/stone、真实 `camera.project` 算取样点、
光源手动摆到板上方、隐藏全部 HUD、`waitWorldSettled`）。**新增侧面机位**：
相机与板同高、水平偏置，视线看向板的侧面（`camera.up` 保持 (0,1,0)，避免 lookAt 退化）。

唯一变量 = `uCloudFaceContrast` 0↔1。判据：

| # | 判据 | 缺陷态 |
|---|---|---|
| ① | 云侧面亮度上升（on/off > 1.05） | 只判这条会被整体提亮蒙过 |
| ② | 云底面亮度下降（on/off < 0.97） | 整体提亮会让它上升 ⇒ 真红 |
| ③ | **侧/底比 ≥ 1.15**（用户诉求的直接判据） | gain 恒 1 ⇒ 1.000 ⇒ 真红 |
| ④ | 石头板顶/底/侧**逐位不变** | gain 误加到整个通道 ⇒ 真红 |
| ⑤ | sanity：各读数 > 20；石头 < 185；云顶 ≈ CPU 预测 ±12 | 取到天空/黑屏时「不变」恒真 |

⚠️ **阈值先在真实机位打印实测值再定**（testing-policy §2.6）。§4.4 的 CPU 表是标定起点。
⚠️ **sanity 上界是材质相关的**（v3.50 已踩：云顶 227 > 天空 192），不得照抄 stone 的 <185。

### 6.4 负向验证（两条，`page.route` 浏览器侧注入 + 读回代码行确认落地）

1. `cloudFaceGain` 注入成 `float(1)` ⇒ 判据③必须真 FAIL（侧/底回到 1.000）；
2. gain 注入成**逐通道不同值**（带色偏）⇒ 保色相判据必须真 FAIL。

还原用 `cp` 副本，**不用 `git checkout`**；磁盘源码不动（注入只在浏览器侧）。

### 6.5 门禁（最小充分集）

```bash
npm run check
npm run test:unit
npx playwright test tests/cloud-softness.spec.mjs tests/wet-surface.spec.mjs \
  tests/normal-style.spec.mjs tests/crosshair.spec.mjs tests/hemisphere-ambient.spec.mjs \
  tests/sun-directional.spec.mjs tests/sun-shadow.spec.mjs
npm run bench -- --check      # 碰了 materials 热路径
```

**不跑 `npm test`**：本改动不是全局基础设施，最小集在结构上成立。
新增文件：无（全部改既有文件）⇒ `test-tiers.mjs` / `index.html` 不需登记。

## 7. 已知代价与风险

1. **云顶面降 1.4 灰阶**（231.6 → 230.2）。v3.50 的「云顶面逐位不变」判据量的是
   `uCloudSoften` 的 A/B，本轮 gain 由独立 uniform 控制 ⇒ **那条判据不受影响**（已核对）。
2. **normal 档侧/底 1.319、night 1.502** 比 noon 的 1.175 大 —— 因为那两档底面本来更暗。
   这是 per-style 自动跟随的结果，不是缺陷；若实玩觉得夜里对比过强，处置是降侧面 gain
   （三个常量职责分离），不要动 v3.50 的三个 lift。
3. **巨型云仍有 61.4% 表面是硬的**（沿用 v3.50 的范围裁定）。
4. `bench --check` 的 frameP95 有 vsync 量子化噪声 ⇒ 若报回退用交替对照定性，不改阈值。

## 8. Builder check（自审，无委派授权）

- **「gain 为什么乘在 max 之外？」** → §5.2 第 3 条：只乘 sky 会漏掉火把照亮的云面。
- **「1.38 会不会在别的档削顶？」** → §4.2 已扫全 5 档 × 6 面 × 4 AO，最大 0.9848；且写成断言。
- **「为什么不加 cap 兜底？」** → §3 实测：`min(v,1)` 抹掉 night +Z 的色相（−32.4 → 0）。
- **「复用 uCloudSoften 行不行？」** → §4.3 实测：那会同时关掉 v3.50 地板，不是单变量。
- **「normal 档阈值能用 CPU 表吗？」** → 不能，它走 AgX + 曝光 2.2，必须屏幕实测（§4.4 注）。
- **留给实施者的**：TSL 具体节点写法（七条口径内）、Tier 4 侧面机位坐标与实测阈值。

## 9. 交付物

| 文件 | 动作 |
|---|---|
| `src/render/cloud-shade.js` | 三常量 + `cloudFaceGainFor` + `cloudShadeFor` 可选入参 |
| `src/render/materials.js` | `uCloudFaceContrast` + 面类别 gain + 两处 shade 相乘 + 透出句柄 |
| `src/tests/test-cloud-shade.js` | 新增 6 组不变式（含削顶上界与保色相） |
| `tests/cloud-softness.spec.mjs` | 侧面机位 + 5 条判据 + 2 条负向 |
| `docs/roadmap.md` | v3.51 行 |
| `docs/pitfalls.md` | 若实测踩到新坑则追加 |

**零产物改动、零 mesher 改动、零 daynight 改动。**