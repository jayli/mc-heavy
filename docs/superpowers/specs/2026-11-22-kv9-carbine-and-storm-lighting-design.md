# KV-9 卡宾枪 + 雨天光影档（v3.30）设计稿

日期：2026-11-22
分支：`feat/kv9-carbine-and-rainy-lighting`
上游：`~/jaylli/bj-shooting-game`（NIGHT HERON // 滨城巷战，完全开源，用户确认无版权问题）

---

## 1. 意图与为什么

用户要把姊妹开源 FPS 的两块能力搬进 mc-heavy：

1. **一把真正的枪**（KV-9 卡宾枪）：曳光、命中特效、开火动效、换弹动作全部与上游一致；
   30 发打光自动换弹、无限子弹、不做按键换弹；掉血与既有机枪完全一样。
2. **一个「雨天光影」设置**：开启后把既有循环雨滴换成持续下雨，并移植上游的
   地面湿滑反光、体积雾、Bloom、色差、暗角；音效直接复用上游。

**为什么值得做**：本仓此前的枪是「GLB 模型 + 瞬现圆柱曳光 + 白闪碎块」，
缺少 FPS 的核心手感（后坐/换弹/弹壳/hit stop）；雨天只有 267 根线段，
没有湿地面与大气感。上游这两块都是**已调好的成品**，移植比从零设计便宜得多。

## 2. 目标 / 非目标 / 反目标

**目标**
- KV-9 的形体、开火动效、换弹时间线、曳光与命中特效与上游逐项一致；
- 30 发自动换弹、无限子弹；掉血 = 加特林（35）；
- 后坐力、枪口火光、弹壳、命中火花、hit stop、轻微镜头震动；
- 雨天档：持续雨（雨丝 + 水花）、湿地面反光、体积雾、Bloom、色差、暗角、上游雨声；
- **室内不生效**：雨被屋顶拦住；**树叶/云/空岛不拦**；**雨幕高度不高于云朵**；
- 性能：默认关；开启后雨丝/水花/bloom 级数按分辨率档减；关闭时零成本。

**非目标**
- 不做按键换弹（R 键仍是循环切枪）；
- 不做 ADS 机瞄（右键仍是放方块）；
- 不做弹孔（用户第二轮明确「单孔可以不要」）；
- 不移植上游的城市氛围音（车流/警笛/霓虹嗡鸣）—— 那是滨城巷战的身份，不是 Minecraft 的；
- 不新建地面 mesh（红线 4/5）；不新建第二个 reflector（会撕天空）。

**反目标（做成了也算失败）**
- 同一发画两条曳光（旧池 + 新池）；
- 换弹动画与补弹时刻分家（枪还在摆而弹药已满）；
- 雨被树叶/云拦住，或雨跑到云上面；
- 室内仍下雨/地面仍湿；
- 关闭雨天档后画面与改动前有任何差异。

## 3. 约束（本仓红线）

| 红线 | 本设计的落点 |
|---|---|
| 1 单一权威 | 伤害派生自加特林常量；弹匣/射速/换弹时长在 `carbine.js`；遮挡判据在 `rain-shelter.js`；日夜/太阳方向复用体素 uniform 实例 |
| 4/5 单一 meshing 管线 | 湿地面是**体素材质的一个 mix 分支**，不新建地面几何 |
| 6 体素 DDA | 抖动后的弹道仍走 `player/raycast.js` 那一条 DDA |
| 9 WebGPU 唯一后端 | 后处理用 `RenderPipeline` + TSL，不用 WebGL 那套 FullScreenQuad |
| 10 Worker 不 import three | 全部新代码在 `render/` 与 `player/weapons/`（主线程） |
| 红线 1（反射） | 湿地面复用 `ocean.js` 的**同一个** reflector 纹理节点 |

## 4. 方案取舍（Approaches）

### 4.1 枪的视图模型
- **A（选）**：程序化几何（上游 `buildGun` 的盒/柱批次）+ `MeshStandardNodeMaterial`
  + 逐顶点 roughness/metalness。四个独立 mesh（gun/mag/armL/armR）⇒ 换弹能单独动。
- B：把上游几何烘成 GLB 走既有 `WeaponModelLoader`。**否**：GLB 是单一 clone，
  换弹要单独移动弹匣与左臂 ⇒ 做不到；且烘焙引入产物指纹负担。
- C：复用 `ViewWeapon` 加字段。**否**：它的路径是「GLB + 单一节点 + 通用后坐」，
  塞进换弹时间线会让四把既有枪的路径全部变复杂（回归面太大）。

### 4.2 曳光
- **A（选）**：独立池（上游「沿线推进的亮条」，速度 320 格/秒）。
- B：复用 `TracerRenderer`。**否**：那是「整条瞬现后淡出的圆柱」，观感不同；
  共用会让其中一方静默退化。catalog 里 KV-9 **无 `tracer` 字段** ⇒ 天然不进旧池。

### 4.3 音效
- **A（选）**：把上游 Web Audio 合成配方**离线烘焙成 wav**（12 个产物 + 指纹门禁）。
- B：运行时合成。**否**：690rpm 下每秒 ~70 个 Web Audio 节点，与「重计算离开主线程」相背。
- C：找相似素材替代。**否**：用户要「保持一致」，且上游没有音频文件可拷 —— 能拷的是配方。

**烘焙的实测教训（已写进代码注释）**：`OfflineAudioContext` 的节点图在长产物上
**逐次运行输出不同字节**（12s 雨声床 / 6.4s 雷声不稳定；≤0.62s 短音效恰好稳定）。
去掉压缩器、去掉随机相位、每产物独立 RNG 流后仍不稳定 ⇒ 整条链改成确定性 JS
（RBJ biquad + 逐样本指数扫频 + FFT 卷积混响）。三轮重烘 12 个产物逐字节一致。

### 4.4 雨的遮挡
- **A（选）**：`rain-shelter.js` 三个纯函数（`blocksRain` / `rainShelterY` / `isUnderRoof`）
  + 高度上界 `RAIN_CEILING_Y = CLOUD_CLUSTER_Y − 1`。判据 = 实心 ∧ 非 cutout ∧ 非 cloud。
- B：沿用 `world.isSolid`。**否**：那会把树叶与云都当屋顶（v1.96 起 cloud.solid=true）。
- C：烘一张 shelter 贴图（上游做法）。**否**：本仓世界可挖可放，静态贴图会过期。

### 4.5 湿地面反光
- **A（选）**：体素 opaque 材质的一个 mix 分支 + 复用 `ocean.js` 的同一个 reflector。
- B：新建地面 mesh（上游做法）。**否**：红线 4/5。
- C：新建第二个 reflector。**否**：两条 pass 互相覆写 BatchedMesh 的 indirect 索引表
  ⇒ 天空整片撕成黑多边形（v3.17 已实测）。
- **代价（明说）**：既有 reflector 的镜面高度是海平面（−1.5），而地面随地形起伏
  ⇒ 湿地面反射是**近似投影**，高处地面会有偏移。用户要的是「地面映出周围景物」，
  不是逐格精确镜面；偏移由扰动柔化。
- **⚠️⚠️ 实施期抓到的硬冲突（本轮最大收获）**：反射 pass 把 RT 当渲染目标（写），
  而湿分支在同一 pass 里采样它（读）⇒ WebGPU 报「writable usage and another usage
  in the same synchronization scope」。**「反射期间藏掉 opaque 通道」能消错但是错的修法**：
  单变量 A/B 实测藏掉后水面倒影映的全是天空 ⇒ 水色真的变了（morning 130→127 /
  noon 99→146 / share 4600→12000，撞冻结色阶）。上游反射时也藏 groundMeshes，
  但它的湿地面**不采样同一张 RT**（用独立 env cube 兑底）—— 照抄会错。
  **正解**：给湿分支一个 reflector.clone()（共享 base / 同一张 RT，但 value 独立），
  反射 pass 期间把 clone 的 value 换成 1×1 占位图。⚠️ 直接改原节点 value 无效：
  reflector 内部每帧写回真 RT。⚠️ uniform 乘 0 也不能消除「节点被采样」的事实。

### 4.6 后处理
- **A（选）**：`RenderPipeline` + `pass()` + `convertToTexture()` bloom mip 链。
- B：手写 RT + FullScreenQuad（上游做法）。**否**：那是 WebGL 路径，本仓 WebGPU 唯一后端。
- **ACES 不重复移植**：renderer 已设 ACESFilmicToneMapping（v1.70 用户拍板），
  `RenderPipeline.outputColorTransform = true` 在链尾接上它 ⇒ 只应用一次。
- **CA 与暗角照移植**：程序化扫描确认本仓此前**零实现**（`vignette|色差|chromatic`
  在 src/ 与 index.html 全无命中）⇒ 不存在用户说的「跟现在实现的类似」的情形。
- **不做 FXAA**：本仓 renderer 已开 MSAA（上游 antialias:false 才需要它）。
- **两处刻意简化**（成本取舍，注释写明）：bloom 用双线性 4 抽头（非上游 13 抽头，
  5 级 mip 链上质量差肉眼不可辨，采样少 3.25×）；视线方向用固定 fov 近似（低频效果）。

## 5. 用户裁定（逐条）

| # | 裁定 | 落点 |
|---|---|---|
| 1 | 掉血与机枪完全一样 | `MINIGUN_DAMAGE` 常量，两把枪共引 |
| 2 | 30 发打光自动换弹、无限子弹 | `CarbineMagazine`，无 reserve 字段 |
| 3 | 不做按键换弹 | 无 `reloadKey`；R 仍循环切枪 |
| 4 | 换弹动作与上游一致 | `carbineReloadPose` 三条曲线逐字 |
| 5 | 曳光与击中效果一致 | 五个池参数逐项取上游 |
| 6 | 后坐/火光/弹壳/火花/hit stop/轻微震动 | 全部实现，常量取上游 |
| 7 | 雨天开关在瞬移区域下面 | 左列 `_rowTeleport()` 之后 |
| 8 | 开启后关掉循环雨滴、改持续下雨 | `rain.setIntensity(0)` + `StormRain` |
| 9 | 地面湿滑反光复用 | 体素材质分支 + 同一 reflector |
| 10 | 体积雾/Bloom/ACES/色差/暗角 | ACES 已有；其余移植 |
| 11 | 音效直接拷贝 | 配方离线烘焙（上游无文件可拷） |
| 12 | 注意性能 | 默认关 + 档位减量 + 关闭零成本 |
| 13 | **室内不生效，屋顶拦雨** | `isUnderRoof` 门 + `blocksRain` |
| 14 | **树叶/云/空岛不拦** | cutout 排除 + cloud 排除 + 上界排除岛体 |
| 15 | **高度不高于云朵** | `RAIN_CEILING_Y = 34`（云簇 35 之下） |
| 16 | **弹孔不要** | `enableHoles = false`（池保留不启用） |
| 17 | CA/暗角若与现有类似可不移植 | 现有零实现 ⇒ 照移植 |

## 6. 文件清单

**新增（src）**
- `player/weapons/carbine.js` — 弹匣状态机 / 换弹时间线 / 散布（three-free）
- `render/carbine-geometry.js` — 程序化枪体/弹匣/手臂几何
- `render/carbine-view.js` — 视图模型 + 动效（rig 九项叠加）
- `render/carbine-fx-config.js` / `carbine-fx-material.js` / `carbine-fx.js` — 五个特效池
- `render/carbine-audio-recipes.js` / `carbine-audio-ext.js` — 合成配方（three-free）
- `render/rain-shelter.js` — 雨的遮挡与高度规则（three-free）
- `render/storm-rain-config.js` / `storm-rain-material.js` / `storm-rain.js` — 持续雨
- `render/wet-ground-config.js` / `wet-ground.js` — 湿地面分支
- `render/storm-grade-config.js` / `storm-grade.js` — 后处理链

**新增（tools）**
- `tools/carbine-synth.mjs` — 确定性离线合成器（纯 JS）
- `tools/bake-carbine-audio.mjs` / `carbine-audio-fingerprint.mjs` — 烘焙 + 指纹

**新增（测试）**
- `src/tests/test-carbine.js`（32 例）/ `test-carbine-fx.js`（19 例）
- `src/tests/test-rain-shelter.js`（21 例）/ `test-storm-rain.js`（22 例）
- `tests/carbine.spec.mjs`（7 例）/ `tests/storm-lighting.spec.mjs`（9 例）

**修改**
- `player/weapons/weapon-catalog.js` — KV-9 条目 + MINIGUN 常量抽取
- `player/weapons/weapon-controller.js` — 弹匣门 / 抖动 DDA / 换弹事件 / wasKilled
- `player/player.js` — 视图模型互斥切换 / 后坐弹簧 / 效果分流 / aim 带 grounded+speed
- `core/game.js` — 装配 / hitstop / trauma / 雨天档五件事 / 反射门放宽 / 帧循环
- `render/materials.js` / `render-world.js` / `ocean.js` — 湿分支接线 + 反射句柄
- `render/rain.js` — 遮挡改走 rain-shelter + 出生高度钳云层
- `render/audio-config.js` — 12 个新音 id（派生自配方清单）
- `ui/settings.js` / `settings-panel.js` / `main.js` — 雨天档设置 + 开关 + `?storm=`
- `tools/check-data.mjs` / `test-tiers.mjs` / `package.json` — 门禁 + 分档 + 烘焙命令

**产物**：`assets/sounds/carbine_*.wav` ×10 + `rain_storm.wav` + `rain_thunder.wav` + `carbine.json`

## 7. 验证口径

- `npm run check`（arch + data + lint）：0 error；
- `npm run test:unit`：115 文件全绿（含新增 94 例）；
- `tests/carbine.spec.mjs` 7 例：含 Tier 4 枪体像素（右下暗像素占比 2%~75%）；
- `tests/storm-lighting.spec.mjs` 9 例：含 Tier 4 开关差分（实测 74% 像素变化）、
  室内门、树叶/云/空岛不拦、高度钳制、关闭零回归、雨声互斥；
- 负向验证：改 `CARBINE_AUDIO_MASTER_GAIN` 后 `check:data` 真的 FAIL（已实测，cp 还原）；
- 烘焙确定性：三轮重烘 12 个产物逐字节一致（已实测）。

## 8. 留给实施者/后续

- 湿地面反射的镜面高度是海平面近似（见 §4.5 代价）；若实玩觉得高处偏移明显，
  处置是**给湿地面单独一个低频反射 pass**（须先解决索引表覆写），不是改回新建 mesh。
- bloom 的 4 抽头简化若实玩觉得有带状伪影，处置是换回 13 抽头（成本 ×3.25）。
- 弹孔池已实现但不启用；要开回来只改 `enableHoles`。
---

## 9. v3.30b 修订（用户实玩报告的两个缺陷）

用户 2026-11-22 实玩后报告：① 枪口火光是「纸片一样的方块」而不是柔光；② 雨天湿地面反光没呈现。
按 systematic-debugging 做了 9 轮 GPU 像素探针逐层取证，两个缺陷各有明确根因，**都不是 WebGPU
后端不支持，而是上游 WebGL 夜景口径 → 本仓 WebGPU 亮场景口径的适配缺口**。

### 9.1 火光白方块（两个叠加根因）

**根因 A：uv 口径错。** `PlaneGeometry(0.24, 0.24)` 的 `position.xy` 是**真实尺寸 ±0.12**，
不是单位 quad。原实现 `vUv = positionGeometry.xy.mul(2)` 只到 ±0.24 ⇒ `r = length(vUv) ≤ 0.34`，
**永远到不了 0.7~1.0 的边缘门** ⇒ `edge ≡ 1`、`core = exp(−r²·9) ≈ 1` 恒亮 ⇒ 整片 quad 满亮。
上游 `vUv = uv`（∈[0,1]），片元里 `c = vUv*2−1`（∈±1）⇒ r 真正覆盖 0..1.41。

**根因 B：混合与 alpha 口径错。** 上游是 WebGL **夜景**（背景近黑）+ additive + `alpha=1`；
本仓正午天空 luma≈200 + ACES ⇒ additive 的 `dst+src`（src 是 flare×5+core×7 的 HDR）必钳白。
**改 NormalBlending 但 alpha 仍恒 1 也还是白方块**（整片不透明覆盖）。

**修法**：`vUv.assign(uv().mul(2).sub(1))` + **NormalBlending + alpha = gain**
（边缘 gain→0 自然羽化 = 柔光）+ `lights = false`。reticle 的同款 uv bug 一并修。

**实测三档对照**（同机位只改一个变量）：
| 配置 | fill | warm |
|---|---|---|
| additive + alpha1（原） | 1.00 | 0 |
| normal + alpha1 | 1.00 | 0 |
| **normal + alpha=gain + uv 口径** | **0.63** | **2342** |

**排除的假修法**（实测无效）：单独 lights=false、单独改混合、功率降 0.15、背景压黑 —— 全部仍白。

### 9.2 湿地面无反光（clone 的 value 不跟住真 RT）

`ReflectorNode.clone()` **只共享 base，`value` 是独立的**；reflector 内部每帧只把真 RT 写进
`base.textureNode.value` ⇒ clone 永远停在构造时的**默认占位 RT（从未被渲染）** ⇒ 反射项恒黑。

**取证**：`clone.value.uuid ≠ base.textureNode.value.uuid`，且 clone 不在 `base.renderTargets` 里；
手动把 clone.value 指向真 RT 后单变量 A/B diff 立刻 **0 → 860002**。

**修法**：反射 pass 后 `clone.value = base.textureNode.value` 同步一次。
⚠️ 不能同步成 pass 前存的 `savedTex`（那正是占位图）。仍保留 clone 的理由见 §4.5。

**判据必须是像素**：uWet=1 / uWetReflect=0.35 / hasUvNode / valueIsRT=true / RT 896×504 /
refreshes=51 **全部正常**，只有反射项开/关的画面差分能抓它（修后 69.3% 像素变化且全部变亮）。

### 9.3 新增判据坑

量「火光面积随功率衰减」不能用绝对 luma 阈值（火光变暗时亮天空露出来，计数反而变大
13756→16641）；绝对暖色阈值在 power<1 时又全落空（2325→0→0）。
**正解：先拍 power=0 基线，数相对基线的增量**（3274→2538→1394，单调）。

### 9.4 验证

新增 `tests/carbine-flash-wet.spec.mjs` **4 passed**；`npm run check` 0 error。

---

## 10. v3.30d 修订（雨雾光栅感 / 湿地面地下透射 / 全屏黑）

用户实玩报告三件事，按 systematic-debugging 做了 12 轮 GPU 像素与几何探针，
定位到 **6 个独立根因**（都不是 WebGPU 后端不支持）。

### 10.1 光栅感 = hash(floor(uv)) 硬格子

远景雨幕与体积雾都用 `hash(floor(uv*k))` ⇒ 每个 cell 整体亮/暗 ⇒ 轴对齐矩形块。
**实测雨幕层相邻像素完全相同 82.06%**（场景本身 4.6%）。

上游 `makeRainSheet()` 画的是 **900 条亚像素宽、带纵向渐变的细丝**，双线性 + mip 采样。
⇒ 烘焙 `assets/effects/rain-sheet.png`（`npm run rainsheet`，逐字移植 + 指纹门禁），
雾改**连续 perlin 两层 octave**。修后雨幕层 **15.9%** / 雾层 **16.7%**。

### 10.2 视线方向没转世界空间

旧实现用固定 fov 常量近似且**没过 cameraWorldMatrix** ⇒ 雨幕柱面坐标跟着屏幕转。
改用 screenUV → inverse projection → cameraWorldMatrix（上游 uInvProj + uCamWorld）。

### 10.3 全屏黑 = texture(uniform(Texture))

`TextureNode.setup` 要求 `value.isTexture === true`，传 UniformNode 会抛 NodeError
⇒ **整条链 build 失败 ⇒ 全屏黑（只剩 HUD）**。正解：真实 Texture 构造节点一次，
加载完成后改 `node.value`（`setRainSheet`）。⚠️ 只在收集 console 错误的探针里可见。

### 10.4 湿地面「地下透射」= 复用海平面 reflector 几何上不可能正确

上游地面 y=0、镜面 y=0 ⇒「压平到镜面再投影」是 **no-op**；
本仓地面 y≈22、水面镜面 −1.5 ⇒ 压平推低 **23.5 格** ⇒ 投影出画
⇒ 近处无反光、远处错位内容。**与采样坐标怎么写无关**。

⇒ 用户裁定「独立地面反射 pass」：`ground-reflect.js` 镜面 = 玩家脚下地面顶面
（平滑 12/s、瞬移 >8 格吸附），`ground-reflect-config.js` 四个纯函数 + 19 例单测。
修后近/中/远三带反光 **0.38 / 0.55 / 0.79**（缺陷态 near=0）。

**三个连带修复**：
1. `rfade`（涟漪 8~26 格衰减）被误乘进 reflTerm ⇒ 26 格外无反光，已移除；
2. **两条 reflector pass 各自套 multi-draw 守卫**（`beginReflectGuard/endReflectGuard`）
   —— 都走 renderer.render ⇒ 都覆写 BatchedMesh 索引表 ⇒ 天空撕黑（v3.17 同机制）；
3. **采样节点必须 `node.clone()`** —— `base.textureNode === node`，reflector 内部
   写回真 RT ⇒ pass 前的占位图被覆盖 ⇒ 同 pass 读写同一 RT ⇒ CommandBuffer 作废 ⇒ 全屏黑。

### 10.5 分级色彩空间

冷调与 S 曲线原在**线性空间**做，上游在 **ACES 之后的显示空间**
⇒ 暗部 `col²(3−2col)` 平方级压暗 ⇒ 天空近黑 **0.1436**。
改 `outputColorTransform=false` + 自己调 `renderOutput`，分级拆线性段/显示段。
暗角按本仓亮场景重标 **0.62 → 0.34**。

### 10.6 启动期挂死

`WET_UNIFORMS` 是 `Object.freeze` ⇒ 替换成员抛 `Cannot assign to read only property`
⇒ worldReady 永不 true。改为写入方持目标 uniform 引用、往 `.value` copy。

### 10.7 四条判据坑（全是测量方法错）

1. 「天空近黑」不能量整条上带（左侧 10% 是建筑，无链时 luma 54）⇒ 量**中心天空区**；
2. **后处理链必须预热两帧**（RTTNode 首帧才定尺寸/建缓存；首两次 diff 90%→37%
   而状态逐位相同，预热后 **0**）；
3. 两次取样间不得推进 player、不得让世界继续 streaming（等 slotMap.size 连续 3 次不变）；
4. 颗粒按 uTime 变 ⇒ 量雨幕稳定性要先关 uGrain。

### 10.8 验证

`tests/storm-rain-visual.spec.mjs` **5 passed** + `test-ground-reflect.js` **19 例**；
`npm run check` 0 error；烘焙两轮逐字节一致。

---

## 11. v3.30e 修订（屏幕竖纹 / 关档后雨声残留）

用户实玩报告两件事，按 systematic-debugging 做了 7 轮取证。

### 11.1 竖纹 = MSAA 不能替代 FXAA

移植时本设计稿写下「**不做 FXAA**：本仓 renderer 已开 MSAA（上游 antialias:false 才需要它）」。
**那条判断只对几何边缘成立**：MSAA 在光栅化阶段对三角形覆盖多点采样，
而 shader 内 `texture()` 采出的高频内容**每像素只算一次** ⇒ MSAA 对它完全无效。

远景雨幕把 512² 细丝纹理按柱面投影铺满屏幕，三层 tiles=12/25/50
⇒ 横向密度 **1.37 / 2.85 / 5.69 texel/像素**（上游 4.91，**同样欠采样**）。
上游靠链尾 FXAA（`uFxaa=1`）抹平走样，本仓抽掉那一环 ⇒ 必然粗糙。

**单变量像素实测**（走 `setRainSheet` 换纹理内容，唯一生效入口）：

| 变量 | 天空竖纹（符号翻转/行） | 中带 |
|---|---|---|
| 原图 512² | **83.5** | 158.2 |
| 64²（细丝被滤掉） | 63.5 | 126.7 |
| 16²（只剩大斑） | 36.8 | 82.7 |
| 纯灰常数图 | **33.1** | 76.1 |
| 只留纵向渐变 | **33.5** | 76.8 |
| 只留横向细丝 | **144.9** | 167.7 |
| 横向 blur R1/R2/R4/R8 | 72.2/64.3/52.3/**40.4** | 143.6/129.4/109/90.9 |
| mip 开/关/Nearest | 83.4/75.5/95.5 | — |

⇒ 竖纹 100% 来自纹理横向高频；mip 只帮一点忙，解决不了欠采样。

**用户裁定「远景雨幕整层去掉」**（原话「感觉还不如去掉呢」）。删除清单：
`farRainLayer` / 三层柱面投影 / `uRainGain` / `uRainSheetOn` / `setRainSheet` /
`STORM_FAR_RAIN` 整表 / `rain-sheet.js` / `bake-rain-sheet{,-params}.mjs` /
`assets/effects/rain-sheet.{png,json}` / `checkRainSheet` / `npm run rainsheet`。

**雨感由真实几何承担**：近景雨丝 5200 条 + 水花 + 体积雾 + 湿地面反光全部保留。

### 11.2 雨声残留 = 开关型档位没还原全局状态

开启时 `weather.force('rain')` 把天气状态机推成下雨；关闭时只停 `rain_storm`，
天气却**永久停在 rain** ⇒ 帧循环的 `_syncRainSound()` 按 `weather.intensity`
把旧的 `rain` 循环放出来。实测：开启前 `loops={}` → 关闭后 `rain` 音量 **0.12** → 4s 后 **0.2**。

**用户裁定「恢复开启前的天气」**：
- 首次开启时快照 `{kind, intensity, phase}`（**只存一次** —— 重复开启若覆盖，
  第二次会把自己推成的 rain 当「原状态」⇒ 永远还原不回晴天）；
- 关闭时 `_restoreWeatherBeforeStorm()` **直接写回稳态值**，不走 `force()` 的 5 秒过渡
  （否则雨声还响几秒，不符合「关掉就应当关闭」）；
- 一并复位 `_phase/_timer/_startIntensity/_targetIntensity/stateSeconds`
  （只改 kind/intensity 会留下「稳态但计时器停在过渡中」的不一致状态）；
- 关闭分支立即调 `_syncRainSound()` 对齐另一条音轨，不等下一帧。

### 11.3 两条新判据坑

1. **走样必须用「符号翻转次数」判**，不能用 v3.30d 的「相邻像素差为 0 的比例」——
   后者对走样**零判别力**（走样恰恰处处都不同，那个比例反而更低）。
2. **换纹理做 A/B 必须换整个 Texture 对象**：改 `tex.image` + `needsUpdate` 不重传
   （three 按 `source.version` 判定）。实测连换 64²/16²/纯灰三档读数**逐位不变**
   —— 读数逐位相同就是「注入没落地」的信号，不能读成「这个变量没影响」。

### 11.4 验证

新增 `tests/storm-audio-off.spec.mjs`（3 例）；`storm-rain-visual.spec.mjs` 首用例改为
「竖纹不得超过无链基线 +12」+ 结构性钉住三个 API 已删；`test-storm-rain.js` 的三层参数
用例改为钉 `STORM_FAR_RAIN` 不存在。`npm run check` 0 error。
