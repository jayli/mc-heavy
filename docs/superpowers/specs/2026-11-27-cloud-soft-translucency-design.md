# 云方块半透光观感（云专属着色地板）

设计日期：2026-11-27。用户裁定：只做「云自身着色柔和」+「先只做 cloud 本体」+「阴影完全不动」。

---

## 1. 要解决什么

用户原话：「现在云方块是完全不透明的，飘在天空会阻挡太阳光的透射，也有阴影，有阴影没问题，
但我希望给云方块增加一些半透光的光影效果……这样显得云方块组成的云朵不会这么硬
（像飘在空中的石头方块一样）。」

**「半透光」在本设计里的落地语义 = 云自身着色柔和**（用户从三个选项中选定），
不是「能看穿云」。具体是三件事：

1. 云的背光面 / 底面不再死暗（现在底面比顶面暗 44%）；
2. 云簇内部的凹角不再像石缝（现在凹角侧面掉到 99、底面掉到 81）；
3. **亮面（顶面、迎光面）逐位不动** —— 柔和不是整体提亮，不得过曝。

## 2. 非目标 / 反目标

| 不做 | 理由 |
|---|---|
| 改 `cloud.cullMode` 为 `transparent` / 做真 alpha | M2-7 勘误已实测：blended 通道 `depthWrite=false` 让云块侧面混叠成方格缝（`blocks-data.js:30`）。且用户选的是着色柔和，不是能看穿 |
| 改 `cloud.shadowCast` / 让云开始或停止投影 | 用户明确「阴影完全不动」 |
| 改巨型云结构的材质映射（marble/stone/clay/snow → cloud） | 用户选「先只做 cloud 本体」；且 `check-data.mjs:1842` 钉着 snow/sky_stone 保持不变（2026-10-29 裁定），`:1853` 钉着腰线以上岩石必须已变 cloud |
| 让云衰减 skylight / 在云下造投影 | skylight 第一阶段恒 15（DR-14），启用遮挡是另一个 Epic；用户没要求 |
| 改 `cloud.opaqueTable` | 它有四项链带后果（面剔除 / AO 遮挡 / blocklight 阻断 / 炮塔 LOS 与弹丸阻挡），最后一项改玩法。本设计只在**着色**层面加地板，不动这张表 |
| 重烘任何产物（atlas / icons / structures） | 本设计不改贴图、不改几何、不改方块声明 ⇒ 全部指纹不变 |
| 新增设置面板开关 | 用户没要求。`uCloudSoften` 只作测试旋钮与将来接入点，不进 UI、不进持久化 |

**反目标（做成了也算失败）**：云看起来「发灰 / 像毛玻璃 / 整体变亮一档」。
判据里必须有「顶面亮度不变」这一条正向对照，否则整体提亮会蒙过全部柔和判据。

## 3. 已实测的事实（不是推测）

| 事实 | 取证方式 | 值 |
|---|---|---|
| **云本来就不投影** | `blocks-data.js:44` 声明 `shadowCast:false` → mesher 写 packed bit14 → `materials.js:249` 的 `maskShadowNode` 在阴影 pass 逐片元 discard；`test-mesher.js:890` 钉住 | `registry.shadowCastTable[cloud] === 0` |
| 云不衰减体素光照 | `lighting.js` 的 `computeSkylightColumn` 全列恒 15（DR-14 第一阶段） | 云下方地面不因云变暗 |
| 云贴图零细节 | `assets/textures/procedural/cloud.png` 逐像素扫描 | 64×64 **全部** `[255,255,255,255]` |
| ⇒ 云的立体感 100% 来自与石头共用的着色公式 | 上一条 + `materials.js:199` 的 `shadeLit` | 「硬」的唯一来源是着色 |
| 巨型云材质构成 | 12 个产物 JSON 逐格解码 | 全部 110,260 格：cloud 35.1% / marble 29.2% / stone 13.8% / clay 7.8% / snow 6.3% / light_gray_cloth 4.1% |
| 巨型云**上半表面**构成 | 同上 + 六邻居暴露判定 | 16,826 格：cloud 38.6% / snow 33.3% / clay 8.7% / cloth 8.6% / iron 3.6% / 其余岩石 5.8% |
| ⇒ 只改 cloud 覆盖巨型云表面的 38.6% | 上两条 | 剩余 61.4% 保持原样（本轮范围裁定） |
| packed bit19 空闲 | 全仓 grep `shiftRight(19)` / `1 << 19` / `>>> 19` / `bit19` | 零占用（bit0–18 已用：light 0-7 / AO 8-9 / face 10-12 / emissive 13 / noShadowCast 14 / wetClass 15-18） |
| `cloud` 走立方体发射路径 | `TEMPLATES` 的 keys 里无 `box`/`cube`（Node 实测） | 只需改立方体分支那一处 `packeds.push` |
| 反射替身共享模块级 uniform | `render-world.js:203` 注释 + `test-puddle-reflect.js:81` | 新 uniform 若放模块顶层，替身自动跟随，无需同步 |

### 3.1 现状与目标的屏幕亮度（CPU 按真实公式 + ACES 复算，正午、tex=255）

`shade = max(sky×hemi×sunTerm, block)`，`sunTerm = FL + I·N·L`（shadowKill=1），
`hemi = G + (1−G)(n.y/2+0.5)`，`aoFactor = 1 − (3−ao)/3×0.9`。
常量：`SHADOW_FLOOR=0.38` / `SUN_INTENSITY=0.775` / `HEMI_GROUND=0.6` / `NOON_SUN_DIR=[0,0.8,0.6]`。

**开阔面（ao=3）**

| | +X | −X | 顶 | 底 | +Z | −Z | 顶/底 | 迎/背 |
|---|---|---|---|---|---|---|---|---|
| 现状 | 166 | 166 | 226 | 145 | 212 | 166 | **1.559** | 1.277 |
| 目标 | 194 | 194 | **226** | 194 | **212** | 194 | **1.165** | 1.000 |

**云簇凹角（ao=1）**：+X 99→172、底 81→172、+Z 157→194。

顶面与迎光面（+Z）**逐位不变**，最亮像素仍 226 ⇒ 不引入新的过曝，也不动
`crosshair.spec` 的「最亮方块 < 200」（那条量的是低头看地面，亮面不变 ⇒ 读数不变）。

## 4. 三条路线（用户已选 A）

**A. 云专属着色地板（选中）** —— 给三个致暗因子各加一个地板，用 `max` 抬升暗面。
零通道变更、零新增顶点属性（塞 packed bit19）、零玩法变更、零烘焙。

**B. 重映射巨型云材质到 cloud（否决）** —— 撞 `check-data.mjs:1842` 的 snow/sky_stone
保持不变裁定，且会让整朵巨型云失去投影（cloud `shadowCast:false`）。

**C. 真 alpha 半透明（否决）** —— M2-7 已实测方格缝；云叠云还要额外排序方案；
且用户选的是着色柔和。

### 4.1 为什么是 `max(原值, 地板)` 而不是「改系数」或「wrap lighting」

三条都算过，`max` 是唯一同时满足两个硬要求的：

| 写法 | 亮面是否不动 | 问题 |
|---|---|---|
| 改 `hemiGround` / `shadowFloor` 系数 | ❌ | 顶面/迎光面一起变亮 ⇒ 过曝风险 + 撞 crosshair 阈值 |
| wrap lighting `(dot+w)/(1+w)` | ❌ | 顶面 dot=0.8 也被抬 ⇒ 线性 1.0775、屏幕 226→229；要保顶面恒 1 就得重标定 intensity，引入第二套派生 |
| **`max(原值, 地板)`** | ✅ **结构性保证** | 原值已高于地板的面 `max` 恒等返回，**逐位**不动，无需重标定 |

`max` 的另一个好处：**per-style 自动跟随**。地板由当前 `uShadowFloor` / `uHemiGround`
派生（不是字面量），所以「普通」档（floor 0.14 / hemi 0.12）下云同样被抬到合理水平，
而其余四档回落全局常量。实测 normal 档：顶面线性 0.6525 → **0.6525（不动）**、底面 0.0168 → 0.3433。

## 5. 实现

### 5.1 新模块 `src/render/cloud-shade.js`（three-free，纯数据 + CPU 参考实现）

与 `sun-shade.js` / `hemi-shade.js` 同手法（红线 1：TSL 与单测共用同一份公式，
不各写字面量）。**不 import 任何东西**（避免 `daynight ↔ sun-shade` 那类循环初始化）。

导出：

```js
/** 三个抬升比例，值域 [0,1]。0 = 该因子不抬（逐位回到现状），1 = 该因子完全不致暗。 */
export const CLOUD_SUN_LIFT  = 0.35;
export const CLOUD_HEMI_LIFT = 0.50;
export const CLOUD_AO_LIFT   = 2 / 3;

/** AO 曲线系数（与 materials.js 的 aoFactor 同源；本模块是它的 CPU 参考实现）。 */
export const AO_CURVE_K = 0.9;

/** ao ∈ 0..3 → AO 因子（开阔 3 → 1.0，墙角 0 → 0.1）。 */
export function aoFactorFor(ao)                    // 1 − (3−ao)/3 × AO_CURVE_K

/** 三个地板：由**当前生效的**全局/per-style 值派生，不写字面量。 */
export function cloudSunFloorFor(floor,  lift = CLOUD_SUN_LIFT)   // floor  + (1−floor)  × lift
export function cloudHemiFloorFor(ground, lift = CLOUD_HEMI_LIFT) // ground + (1−ground) × lift
export function cloudAoFloorFor(lift = CLOUD_AO_LIFT)             // aoFactorFor(0) + (1−aoFactorFor(0)) × lift

/** 单面最终 shade 的 CPU 参考实现（与 TSL 同公式，供 Tier 1 与 Tier 4 阈值标定共用）。 */
export function cloudShadeFor({ normalIndex, ao, sunDir, shadowKill,
                               shadowFloor, sunIntensity, hemiGround, soften })
```

`soften` ∈ [0,1] 是 `uCloudSoften`：0 ⇒ 三个 `max` 的地板逐位退回原值 ⇒ **整式逐位回到现状**。
实现上地板取 `lerp(原值, 地板, soften)` 而非 `if`（TSL 侧必须无分支，见 5.3）。

**派生实测值**（全局常量档 floor 0.38 / hemi 0.6）：
`cloudSunFloor = 0.597` / `cloudHemiFloor = 0.800` / `cloudAoFloor = 0.700`。
normal 档（floor 0.14 / hemi 0.12）：`0.441` / `0.560` / `0.700`（AO 地板与 style 无关）。

**三条不变式**（Tier 1 钉住）：
1. `lift = 0` ⇒ 三个地板逐位等于各自的原值（零回归锚点）；
2. `ao = 3` ⇒ `max(aoFactor, cloudAoFloor) === aoFactor`（开阔面不受 AO 地板影响）；
3. 正午顶面 `sunTerm = FL + I×0.8 = 1.0 ≥ cloudSunFloor` ⇒ `max` 恒等（顶面不动）。

### 5.2 `src/mesh/mesher.js`：cloud 写 packed bit19

在既有 `noShadowCastBit` / `wetClassBits` 旁新增逐方块常量：

```js
const CLOUD_SOFT_BIT = 1 << 19;   // 云专属着色（v3.49）
// 逐方块（与 blockEmissiveBit / noShadowCastBit 同一处）：
const cloudSoftBit = blockName === 'cloud' ? CLOUD_SOFT_BIT : 0;
```

⚠️ **为什么用名字而不是新声明字段**：与 `SAME_TYPE_CULL` / `EMISSIVE_MATERIALS` /
`DOUBLE_SIDE_CUBES` 同一性质 —— 这是**材质语义**（「这块的贴图是匀质白云」），
不是 `BlockData` 的方块属性。`blocks-data.js` 是 mc-lite `BlockData.js` 的转换产物，
不给它长一列渲染专用字段。`cloud` 已经在 `SAME_TYPE_CULL` 里按名字表达同类语义。

⚠️ **只需改立方体分支那一处**（`mesher.js:734` 的 `packeds.push`）：`cloud` 的
`geometry:'box'` 不在 `TEMPLATES` 里（Node 实测 keys 无 box/cube）⇒ 走立方体路径。
模板分支（`:655`）**不加**该位 —— 那里没有云，加了是死代码。

⚠️ **bit19 不得挤占 bit0–18**：挤进去会翻转既有语义（例如云开始投影）。
由 `test-wet-surface.js` 的位段隔离用例同款手法钉住。

### 5.3 `src/render/materials.js`：顶点阶段三个 `max`

四个 uniform 的定义与导出见 **§5.5**（`CLOUD_SURFACE_UNIFORMS`，模块顶层单例
⇒ 反射替身自动跟随）。本节只讲三处接线，全部在**顶点阶段**
（红线 11：shade 必须顶点算成 float 经 float varying 传片元）：

1. **AO**（`:37` 附近）：`aoFactor` 的字面量 `0.9` 换成 import 的 `AO_CURVE_K`（红线 1），
   之后加 `aoSoft = mix(aoFactor, max(aoFactor, uCloudAoFloor), cloudT)`，
   `vSkyShade` / `vBlockShade` **两项都**改吃 `aoSoft`。
   ⚠️ 只改 sky 会让火把照亮的云凹角与太阳照亮的不一致。
2. **半球**（`:121`）：`hemiFactor` 之后加 `hemiSoft = mix(hemiFactor, max(hemiFactor, uCloudHemiFloor), cloudT)`。
3. **太阳项**（`:197` 之后、`:199` 之前）：`sunTerm` 之后加
   `sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloor), cloudT)`。
   ⚠️ **必须在 `sunTerm` 之后**（已含色温与 shadowKill），不是在 `vSunDot` 上 ——
   在 dot 上抬会把阴影因子绕过去（阴影语义被改，用户明确不动阴影）。

其中 `cloudBit = float(packed.shiftRight(19).bitAnd(1))`（与 `noShadowCastBit` 同款解包），
`cloudT = mul(cloudBit, uCloudSoften)`。**逐顶点常量**（同 quad 四顶点同值）
⇒ 走 `vertexStage` float varying 即可。

`shadeLit` 改吃 `hemiSoft` 与 `sunTermSoft`；`shadeUnlit`（transparent = 水/玻璃）
只改 `hemiSoft` 保持口径一致 —— 该通道没有云，`cloudT` 恒 0 ⇒ 该项逐位恒等。

⚠️ **`mix` 而非 `if`**：`cloudT = 0` 时取左端 ⇒ 逐位零回归（已预验 `mix(a,b,0)===a`）。
写 `if` 会出两条代码路径，未测的那条静默劣化（本仓 `setupFog` 已记这条教训）。

⚠️ **TSL 口径**（`wet-surface.js` 文件头七条）：节点不与裸数字算术（一律 `.mul()/.add()`）、
不用 `.toVar()/.assign()`（`makeMaterial` 里直接调，无 stack）、多层 mix 嵌套不链式。

### 5.4 `src/render/daynight.js`：`_apply` 写三个地板 uniform

`_apply` 是所有风格写入的唯一收口点。既有写法（`daynight.js:671-676`）是**内联三元**：

```js
const uShadowFloor = this.voxelUniforms.uShadowFloor;
if (uShadowFloor) uShadowFloor.value = typeof p.shadowFloor === 'number' ? p.shadowFloor : SHADOW_FLOOR;
```

本改动把那两个值**提成局部常量**再复用（不是重新读一遍 `p`）：

```js
const floor  = typeof p.shadowFloor === 'number' ? p.shadowFloor : SHADOW_FLOOR;
const ground = typeof p.hemiGround  === 'number' ? p.hemiGround  : HEMI_GROUND;
// 既有三行改吃这两个局部量（值逐位不变）
// 新增：句柄缺失时跳过 —— 与 uShadowFloor 同一容错口径
if (uCloudSunFloor)  uCloudSunFloor.value  = cloudSunFloorFor(floor);
if (uCloudHemiFloor) uCloudHemiFloor.value = cloudHemiFloorFor(ground);
```

`uCloudAoFloor` 与 style 无关 ⇒ 只由模块初值提供，`_apply` 不写。

⚠️ **必须复用同一个 floor/ground 局部量**，不得在云地板那两行重新写一遍三元 ——
两处各算一遍会漂移（本仓 `uShadowFloor` 同时当影区地板与 `shadowKill` 分母那轮的教训：
两个端点一致而半影撕裂，全部数值判据全绿）。

⚠️ `daynight.js` 已 import `SHADOW_FLOOR` / `HEMI_GROUND`（来自 `shade-params.js`），
新增 import 只加 `cloud-shade.js` 的两个函数 —— 后者零依赖，不可能成环。

### 5.5 `src/render/materials.js` 返回值：透出句柄

四个 uniform 定义成**模块顶层导出常量** `CLOUD_SURFACE_UNIFORMS`
（与 `src/render/wet-surface.js:81` 的 `WET_SURFACE_UNIFORMS` 逐字同款）：

```js
export const CLOUD_SURFACE_UNIFORMS = {
  uCloudSoften: uniform(1.0),
  uCloudSunFloor: uniform(cloudSunFloorFor(SHADOW_FLOOR)),
  uCloudHemiFloor: uniform(cloudHemiFloorFor(HEMI_GROUND)),
  uCloudAoFloor: uniform(cloudAoFloorFor()),
};
```

为什么导出而不是只放返回值里：① Node 单测可直接 import 它断言初值
（`createVoxelMaterials` 要 atlasTexture，Node 侧构造成本高且无必要）；
② 模块级单例 ⇒ 反射替身自动共享（§3 已核实）。

`createVoxelMaterials` 返回值：`dayNight` 对象里加 `uCloudSoften`（与既有 `uHemiGround` 并列），
新增 `cloud: CLOUD_SURFACE_UNIFORMS`（与既有 `wet: WET_SURFACE_UNIFORMS` 同款）。

spec 经 `g.renderWorld.materials.cloud.uCloudSoften.value` 写 —— **不改 `game.js`**
（`renderWorld` 已经挂在 `__MC_GAME__` 上，`materials.wet` 就是这么用的）。

## 6. 验证策略

分级依据 `docs/testing-policy.md`：mesher 位段 = **Tier 1**（静默数据错误，必须 TDD）；
GPU 着色 = **Tier 4**（TSL 在 GPU 求值，必须像素实测）。

### 6.1 Tier 1：`src/tests/test-cloud-shade.js`（新增，Node 轻档）

纯函数不变式（全部已在 CPU 上跑过，值见 §5.1）：

1. `lift=0` ⇒ 三个地板逐位等于原值（零回归锚点）；
2. `ao=3` ⇒ `max(aoFactorFor(3), cloudAoFloorFor()) === aoFactorFor(3)`；
3. 正午顶面 `sunTerm ≡ 1.0` 且 `≥ cloudSunFloor` ⇒ `max` 恒等；
4. `soften=0` ⇒ `cloudShadeFor` 逐位等于现状公式。**输入必须含非整比值**
   （floor 0.2713 / ground 0.4319 / intensity 0.6173 / shadowKill 0.3719 / 非轴向 sunDir）——
   整数与整比输入下重建缺陷恒等，测不出来。**已预跑：7,776 组组合最大偏差 0**；
5. `soften=1` ⇒ 底面/背光面严格变亮、顶面/迎光面**逐位不变**、**任何面都不得变暗**
   （已预跑：6 面 × 4 个 AO = 24 组 → 变亮 20 / 逐位不变 4 / 变暗 **0**）；
6. 三个地板随 `floor`/`ground` 单调，且 normal 档（0.14/0.12）下顶面仍不动；
7. `cloudShadeFor` 与 `sun-shade.js` 的 `sunTermRGBFor` + `hemi-shade.js` 的 `hemiFactorFor`
   在 `soften=0` 时交叉一致（不留第二份公式）。

⚠️ **零回归的实现形式已预验**：TSL 侧写 `mix(原值, max(原值, 地板), cloudBit × uCloudSoften)`，
而 `mix(a,b,0) = a + (b−a)×0` 在 9 组非整比输入上**逐位等于 `a`**（已跑）。
非云方块 `cloudBit=0` ⇒ t 恒 0 ⇒ 结构性零回归，不靠「应该相等」。

### 6.2 Tier 1：mesher 位段（加进既有 `src/tests/test-mesher.js`）

1. `cloud` 每个顶点 bit19 = 1；
2. `stone` / `snow` / `marble` / `leaves` 每个顶点 bit19 = 0（**判别性用例**：
   若实现写成「整个 opaque 通道都置位」，这条真红）；
3. `cloud` 的 bit0–18 语义不变：light 位 = 0xF0、AO ≤ 3、face ≤ 5、bit14 = 1（不投影）、
   wetClass = 0（NONE）—— 与 `test-wet-surface.js:202` 同款隔离手法。

### 6.3 Tier 4：`tests/cloud-softness.spec.mjs`（新增）

**夹具照抄 `tests/hemisphere-ambient.spec.mjs` 已验证的口径**（不重造）：
悬空厚板 + 顶/底两个机位 + 真实 `camera.project` 算取样点 + 光源手动摆到被测物上方
+ 隐藏全部 HUD + `waitWorldSettled`。

几何：**两块同尺寸悬空厚板**，一块 `cloud`、一块 `stone`，水平错开互不遮挡。
⇒ 同机位同法线下「云 vs 石头」是**单变量对照**（避免 `wet-surface.spec` 记的
「不同法线下 N·L 造出亮度差，分类退化也全绿」那个盲区）。

唯一变量 = `uCloudSoften` 0↔1。判据四条**同时**成立：

| # | 判据 | 缺陷态会怎样 |
|---|---|---|
| ① | 云底面亮度显著上升（`softOn/softOff > 1.15`） | 只判这条会被「整体提亮」蒙过 |
| ② | **云顶面逐位不变**（比值 ∈ [0.99, 1.01]） | 整体提亮 / 改系数 / wrap lighting 都会让它变 ⇒ 真红 |
| ③ | **石头板顶面与底面都逐位不变** | bit19 误置到整个通道 ⇒ 真红 |
| ④ | sanity floor：四支读数都是几何（>20 且 <185），且云顶 ≠ 云底（>5） | 取到天空/黑屏时「不变」恒真 |

⚠️ 阈值须在真实机位上**先打印实际值再定**（testing-policy §2.6 第⑤条）。
§3.1 的 CPU 表是标定起点，不是最终阈值 —— 真实机位有额外衰减（crosshair 实测 181 vs CPU 226）。

### 6.4 负向验证（必需，两条）

1. `page.route` 把 mesher 的 `blockName === 'cloud'` 注入成 `false`（bit19 恒 0）
   ⇒ 判据①必须真 FAIL。**注入后读回浏览器侧源码确认落地**（用 `edit` 而非 `sed`），
   还原用 `cp` 副本，**不用 `git checkout`**。
2. 把 `max(原, 地板)` 注入成 `原 + 地板×0.3`（整体提亮）⇒ 判据②必须真 FAIL。
   这条证明「顶面不变」不是恒真判据。

### 6.5 消费方 spec（grep 出的最小充分集）

改 mesher + materials + daynight ⇒ 经 `game.js` 装配段消费它们的 spec：
`wet-surface`（云区零光晕，**本改动不动云区亮度 ⇒ 应仍绿**）、`sun-directional`、
`hemisphere-ambient`（都用 stone，bit19=0 ⇒ 应逐位不变）、`crosshair`（亮面不动）、
`normal-style`（四档零回归）、`sun-shadow`（阴影语义未动）。

### 6.6 门禁

```bash
npm run check                                    # 每次改动
npm run test:unit                                # Tier 1 纯函数 + mesher
npx playwright test tests/cloud-softness.spec.mjs tests/wet-surface.spec.mjs \
  tests/hemisphere-ambient.spec.mjs tests/sun-directional.spec.mjs \
  tests/crosshair.spec.mjs tests/normal-style.spec.mjs tests/sun-shadow.spec.mjs
npm run bench -- --check                         # 碰了 mesher/materials 热路径
```

**不跑 `npm test`**：本改动不是全局基础设施（不改注册序 / runner / 分档清单的判据逻辑，
只往清单里加两个新文件名），最小集在结构上成立。

新增文件必须登记（`check:data` 的 `[测试分档]` 门双向钉住）：
- `test-cloud-shade.js` → `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` + `src/tests/index.html`
- `cloud-softness` → `tools/test-tiers.mjs` 的 `PIXEL`

## 7. 已知风险与代价

1. **巨型云仍有 61.4% 的表面是硬的**（marble/clay/snow/cloth/iron）—— 本轮范围裁定，
   交付后实玩再定是否扩。扩的做法是逐结构标记（烘焙 stride 4→5 + meta bit2），
   不是换材质（会撞 §2 的两条门禁）。
2. **云簇凹角变亮 ~74%**（99→172）是三条地板叠加的结果。若实玩觉得「云内部失去层次」，
   处置是**降 `CLOUD_AO_LIFT`**（它单独控制凹角），不要动另两个 —— 三者职责分离。
3. **`uCloudSoften` 是常开的**（初值 1）。它不进面板，但 spec 会写它 ⇒ 若将来加面板开关，
   须遵守「翻转默认值时旧存档一起迁移」的既有裁定。
4. **bit19 用掉后 packed 只剩 bit20–31**（12 位）。下一个逐 quad 语义仍可塞进去，
   但要在 mesher 的位段注释里同步登记。
5. **`max` 让云在阴影里也变亮**？不会 —— 地板加在 `sunTerm` 之后，而 `sunTerm` 已含
   `shadowKill`；影区 `sunTerm` 落到 `FL`，再被抬到 `cloudSunFloor`。
   ⚠️ 这**确实**让「云在阴影里比石头亮」，但那正是「云半透光」的语义（云自己散射）。
   若用户实玩否掉，处置是把云地板乘 `shadowKill`（一行），而不是撤掉整个功能。

## 8. Builder check（自审，无委派授权）

按 `brainstorming` 的 builder-check 要求自审（本会话无委派授权，故自己扮演那个 builder）：

- **「三个 lift 的值怎么来的？」** → §3.1 的 CPU 扫描：`0.35/0.50/2⁄3` 让顶/底比落到
  1.165（柔和但仍有层次），且顶面/迎光面逐位不动。更柔的档（0.55/0.5 → 1.108）与更保守的
  （0.30/0.45 → 1.189）都算过，取中档。**这是可调参数，不是冻结常量** —— 计划里不标冻结。
- **「为什么不直接改 `hemiGround`？」** → §4.1 表：会动亮面。
- **「bit19 会不会撞别人？」** → §3 已 grep 全仓，零占用；且 §6.2 有隔离用例。
- **「新 uniform 会不会漏挂到反射替身？」** → 放模块顶层 ⇒ 替身共享（§3 已核实 `render-world.js:203`）。
- **「阈值从哪来？」** → §6.3 明确「先在真实机位打印再定」，CPU 表只是起点。
- **「会不会漏改 `vBlockShade`？」** → §5.3 第 1 条明确两项都要改。
- **留给实施者的**：TSL 具体节点写法（在七条口径约束内）、Tier 4 阈值的实测值、
  两块厚板的具体坐标（须满足互不遮挡 + 都入画）。

## 9. 交付物

| 文件 | 动作 |
|---|---|
| `src/render/cloud-shade.js` | 新增（three-free 常量 + CPU 参考实现） |
| `src/mesh/mesher.js` | 加 `CLOUD_SOFT_BIT` + 立方体分支置位 |
| `src/render/materials.js` | 三个 `max` + 四个 uniform + 透出 `cloud` 句柄 |
| `src/render/daynight.js` | `_apply` 写两个 per-style 地板 |
| `src/tests/test-cloud-shade.js` | 新增（Tier 1，7 组不变式） |
| `src/tests/test-mesher.js` | 加 3 条位段用例 |
| `tests/cloud-softness.spec.mjs` | 新增（Tier 4，4 条判据 + 2 条负向） |
| `tools/test-tiers.mjs` | 登记两个新文件 |
| `src/tests/index.html` | 注册 `test-cloud-shade.js` |
| `docs/roadmap.md` | 加 v3.49 行 |
| `docs/pitfalls.md` | 若实测踩到新坑则追加（否则不动） |

**零产物改动**：不跑任何烘焙命令，全部指纹不变。