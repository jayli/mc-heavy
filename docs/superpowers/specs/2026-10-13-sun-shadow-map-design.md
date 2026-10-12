# 太阳阴影（shadow map）设计文档

> 日期：2026-10-13 ｜ 状态：待用户审阅
> 上游对齐：mc-lite `src/core/Engine.js`（shadow map 配置）+ `src/world/World.js:227`（按需刷新节流）
> 设计文档影响：`docs/phase-1-engine-design.md` §4.4.4（实施时修订，v1.43 → v1.44）

## 1. 背景与目标

mc-heavy 现有三层光照：AO 墙角阴影（mesher 逐顶点）、日夜全局调制（`uSkyDim`/`uBlockBoost`）、
blocklight flood fill。**没有太阳方向光投影阴影** —— v1.9/DR-14 关掉的是体素 skylight 遮挡
（悬挑/洞穴下大片全黑 + 截断渐变环，用户明确否决），shadow map 则是设计文档 §4.4.4
已规划但从未实现的项。

**目标**：太阳把地形/树/建筑的影子投到地面与方块表面，视觉对齐 mc-lite（太阳方向随日夜
风格变化、PCFSoft 软阴影、按需刷新），性能不破坏 M3 冻结基线（120Hz ≥90fps）。

**明确不做**（防止范围膨胀）：

- 不动体素 skylight 管线（恒 15 不变，v1.9/DR-14 决策不推翻 —— shadow map 是纯渲染层
  叠加，与那条路线无关，两者视觉问题也不同：skylight 遮挡是「体素内部全黑」，shadow map
  是「表面投影」）；
- 实体（丧尸/矿车/炮塔/弹丸）不投射不接收 —— 本期只做体素世界；后续要加只需给对应
  InstancedMesh 开 `castShadow`/`receiveShadow`，接线点已在 §4 预留；
- 不进设置面板（用户决定）：代码级开关 + 默认开。

## 2. 现状与差距（实测勘查结论）

### 2.1 mc-lite 的阴影系统（对齐基准）

mc-lite `Engine.js`（WebGL 后端）：

- `DirectionalLight.castShadow = true` + `THREE.PCFSoftShadowMap`；
- 太阳方向**随视觉风格离散变化**（`Engine.js:74/99/122`）：morning `[0.18,0.45,0.88]` /
  overcast `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`；**不随小时连续转动**，风格切换时
  `requestShadowMapUpdate()`（`Engine.js:584-586`）；
- `mapSize 256`、阴影相机正交 `±30`、`near 0.1 / far 250`、`bias 0.00008 / normalBias 0.048 /
  radius 2.6`（`Engine.js:30-34, 168-182`）；
- `renderer.shadowMap.autoUpdate = false` + `needsUpdate = true` 按需刷新
  （`World.requestShadowMapUpdate`，200ms 节流，触发点：block-changed / chunk 拓扑变化 /
  风格切换 / 特殊实体增删）；
- 光源跟随玩家：`light.position = player + sunDirection × 60`、`target = player`
  （`Game.js:557-559`）；**移动阈值 5 格**（`distSq > 25`，`Game.js:537`）才更新光源位置
  并请求刷新阴影；
- 投射白名单 `isSolidShadowCaster = isSolid && isRendered !== false` → 32 种投射 /
  13 种不投射（花、草、藤、睡莲、灯等 `isSolid:false`）/ 5 种不渲染；
- mc-lite 是**每种方块一个 InstancedMesh**，故能按方块类型设 `castShadow`。

### 2.2 mc-heavy 的三个架构差异（决定方案形态）

1. 体素走 **3 个 BatchedMesh 通道**（opaque/cutout/transparent），不是按方块分 mesh →
   `castShadow` 只能按通道设，不能按方块类型；
2. 体素材质是 **unlit `MeshBasicNodeMaterial`**（亮度烘焙在顶点 shade），不吃灯光 →
   接收阴影需在 `materials.js` 的 colorNode 里手动乘 TSL `shadow()` 节点；
3. 已有一盏 `DirectionalLight`（`game.js:162` `weaponSun`，方向 `(0,0.8,0.6)` / 色
   `0xfffaf0` / 强度 3.2，本就是 mc-lite 口径，给枪 PBR 模型用），未开 castShadow。

### 2.3 技术可行性（r185.1 已核实）

- WebGPU 后端有完整 `ShadowNode` 支持；TSL 导出 `shadow(light, shadow?)` 节点函数
  （`three.webgpu.js:45536`）与 `PCFSoftShadowFilter`（`three.tsl.js:29`）；
- `BatchedMesh extends Mesh`（`three.core.js:26137`）→ `castShadow`/`receiveShadow` 可用；
  `perObjectFrustumCulled` 默认 true → 阴影 pass 用 shadow camera 逐 instance 剔除
  （`three.core.js:27495-27555`），只画玩家附近 section，不是全部 289 列；
- **节流口径与 mc-lite 不同**（WebGL vs WebGPU）：WebGPU 后端按 **per-light**
  `light.shadow.autoUpdate`（默认 true）/ `light.shadow.needsUpdate` 判定
  （`ShadowNode.updateBefore`，`three.webgpu.js:45480-45508`），**不是** mc-lite 的
  `renderer.shadowMap.autoUpdate`。`renderer.shadowMap.enabled` 仍须置 true（否则
  `light.castShadow` 被忽略，`three.webgpu.js:43563`）。

## 3. 设计决策

| # | 决策 | 理由 |
|---|---|---|
| DR-1 | shadow map 实时投影（非体素 skylight 遮挡） | 用户选定。skylight 遮挡是 v1.9 被否决的路线（大片全黑 + 截断渐变环）；mc-lite 实际用的就是 shadow map |
| DR-2 | **方案 A：按通道粗粒度投射**（opaque + cutout 投射，transparent 不投射） | mc-heavy 是通道级合批，按方块投射需改 mesher（packed 位 + castShadowNode 逐顶点 discard），是纯额外 GPU 开销，收益（花草不投影）肉眼不可辨。代价：cloud（opaque）与花草藤（cutout）会投影 —— cloud 在高空、花草阴影极小，可接受；玻璃不投影（mc-lite 投影，但玻璃阴影几乎看不出）。用户确认接受 |
| DR-3 | 复用 `weaponSun` 为太阳灯（改名 `sunLight`），不新建第二盏 | 它的方向/色/强度本就是 mc-lite 太阳口径（noon 值）；新建灯会让枪 PBR 模型被双倍照亮 |
| DR-3b | 太阳方向随日夜风格变化（对齐 mc-lite）：`VISUAL_STYLES` 加 `sunDirection` 三组值，关键帧插值里逐分量 lerp + normalize | 用户选定。mc-lite 是风格切换离散变化；mc-heavy 日夜是连续关键帧插值，方向向量逐分量插值是自然扩展。方向变化也触发阴影刷新（走同一 200ms 节流，日夜循环中最高 5Hz） |
| DR-4 | 参数照抄 mc-lite：mapSize 256 / 阴影相机 ±30 / near 0.1 / far 250 / bias 0.00008 / normalBias 0.048 / radius 2.6 | 设计文档 §4.4.4 原写「贴图 2048 / 覆盖视距 60%」是规划期估算，mc-lite 实测口径（小相机近处阴影更清晰）更优。实施时修订 §4.4.4（v1.44） |
| DR-5 | 节流用 `light.shadow.autoUpdate=false` + `needsUpdate`（WebGPU per-light 口径） | 实测 `ShadowNode.updateBefore` 的判定路径；mc-lite 的 `renderer.shadowMap.autoUpdate` 是 WebGL 口径，在 WebGPU 后端不生效 |
| DR-6 | 阴影浓度随日夜：新 uniform `uShadowStrength` = `skyDim` | 白天 1.0 全浓度；夜里全世界已压暗到 25%（`uSkyDim`），阴影浓度随之淡出。一行接线，不引入新参数 |
| DR-7 | 代码级开关（构造选项 + `setShadowsEnabled`），默认开，不进设置面板 | 用户决定 |
| DR-8 | 实体不投射不接收（本期） | 范围控制；接线点预留（§4.6） |

## 4. 组件与接线

### 4.1 太阳灯（`src/core/game.js`）

现有 `weaponSun` 改名 `sunLight`，开 `castShadow`，配置阴影相机：

```js
const sunLight = new THREE.DirectionalLight(0xfffaf0, 3.2);
sunLight.position.set(0, 0.8, 0.6);        // 初始 = noon 方向（DR-3b 起随日夜变化）
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(256, 256);
sunLight.shadow.camera.left = -30;  sunLight.shadow.camera.right = 30;
sunLight.shadow.camera.top = 30;    sunLight.shadow.camera.bottom = -30;
sunLight.shadow.camera.near = 0.1;  sunLight.shadow.camera.far = 250;
sunLight.shadow.bias = 0.00008;
sunLight.shadow.normalBias = 0.048;
sunLight.shadow.radius = 2.6;
sunLight.shadow.autoUpdate = false;        // DR-5：按需刷新
sunLight.shadow.needsUpdate = true;        // 启动渲染一次
this.scene.add(sunLight.target);
this.scene.add(sunLight);
```

renderer 侧：`this.renderer.shadowMap.enabled = true;`（`three.webgpu.js:43563` 门控）。

**阴影相机跟随玩家**（mc-lite `Game.js:557-559` 同口径，偏移距离 60）：

```js
// 玩家移动超阈值（5 格，distSq > 25）时：
sunLight.position.copy(playerPos).addScaledVector(sunDirection, 60);
sunLight.target.position.copy(playerPos);
```

**太阳方向随日夜**（DR-3b）：`daynight.js` 的 `VISUAL_STYLES` 加 `sunDirection`：
morning `[0.18,0.45,0.88]` / noon `[0,0.8,0.6]` / night `[0.08,0.25,0.96]`（mc-lite
morning/overcast/night 原值，三风格对应关系已按 fogColor 比对确认）。`lerpParams`
逐分量插值方向向量，消费侧 normalize。`DayNight` 需持有 `sunLight` 引用（构造注入），
`_apply(p)` 里更新 `sunLight.position`（沿新方向重算）并请求阴影刷新。

### 4.2 投射（`src/render/render-world.js`）

```js
this.meshes.opaque.castShadow = true;      // 地形/建筑/树干/树叶（opaque 通道）
this.meshes.cutout.castShadow = true;      // 花草/藤/台阶/栏杆/箱子（cutout 通道）
// transparent（水/玻璃）不投射
for (const ch of CHANNELS) this.meshes[ch].receiveShadow = true;
```

⚠️ **阴影 pass 不消费 alphaTest**：树冠投影是实心立方轮廓（Minecraft 原版同款表现），
可接受。若后续要 alphaTest 投影，走 `castShadowNode`（方案 B 路线，本期不做）。

### 4.3 接收（`src/render/materials.js`）

三通道材质的 colorNode 乘 TSL `shadow()` 节点。自发光加项（hanging_lamp，bit13）
保持在阴影相乘**之后**（灯在阴影里照样亮）：

```js
import { shadow, PCFSoftShadowFilter } from 'three/tsl';

// createVoxelMaterials(atlasTexture, sunLight) —— 新增 sunLight 参数
const uShadowStrength = uniform(1.0);   // 日夜联动（DR-6）
const shadowFactor = mix(float(1), shadow(sunLight, PCFSoftShadowFilter), uShadowStrength);
// rgb = texColor.rgb × vShade × shadowFactor（+ emissive 加项在后）
```

返回值加 `dayNight: { uSkyDim, uBlockBoost, uShadowStrength }`。

⚠️ **`shadow()` 节点的 light 引用在材质构建时固定**：`createVoxelMaterials` 在
`RenderWorld` 构造时调用（`render-world.js:41`），须把 `sunLight` 传进去。若材质先于
灯光创建，需调整 `game.js` 的构造顺序（灯光先建）。

### 4.4 更新时机（性能核心）

新增 `src/render/shadow-manager.js`（或并入 game.js 帧循环，实施时定）：

- **世界编辑**：`editor.subscribe()` 收到 `block-changed` → 请求刷新
  （放块/挖块/TNT/炮塔破坏共用 WorldEditor 入口 → 一处接线全覆盖）；
- **玩家移动**：每帧检查，距上次更新移动超 **5 格**（`distSq > 25`，mc-lite `Game.js:537`
  实测值）才更新光源位置并请求刷新；
- **太阳方向变化**（DR-3b）：日夜循环中方向连续变化 → 每帧请求刷新，由节流压到 5Hz；
  风格切换（`setStyle`）时方向离散跳变 → 立即请求刷新（mc-lite `Engine.js:586` 同口径）；
- **节流**：两次刷新最小间隔 200ms（mc-lite `World.requestShadowMapUpdate` 同口径），
  节流期内的请求挂 `pendingShadowUpdate`，节流过后补刷一次；
- **启动**：`needsUpdate = true` 渲染一次。

静止不动时阴影 pass 零开销；移动/编辑时最高 5Hz。代价：移动中阴影最多滞后 200ms
（mc-lite 同款表现）。

### 4.5 日夜联动（`src/render/daynight.js`）

`_apply(p)` 里加一行：`this.voxelUniforms.uShadowStrength.value = p.skyDim;`
（白天 1.0 / 夜里 0.25，阴影浓度随天光淡出）。

### 4.6 实体预留（本期不实现）

后续给实体加阴影只需：`zombieRenderer.meshes.*.castShadow = true` 等。
实体材质是 `MeshBasicMaterial`（unlit）→ 接收阴影同样需要乘 `shadow()` 节点，
与体素同手法，届时单独评估。

### 4.7 枪模型

保持 `castShadow = false`（视图模型挂相机上，投影子没意义，mc-lite 武器同口径）；
PBR 材质自动接收阴影（mc-lite 武器 `receiveShadow = true` 同效果）。

## 5. 开关

- `Game` 构造选项 `shadows`（默认 `true`）；
- `Game.setShadowsEnabled(bool)`：关闭 = `sunLight.castShadow = false`（停阴影 pass）
  + `uShadowStrength.value = 0`（视觉零影响）；开启反之 + `needsUpdate = true`；
- 测试/调试用，不进设置面板（DR-7）。

## 6. 性能模型

| 成本项 | 大小 | 说明 |
|---|---|---|
| CPU：instance 遍历 | O(n)，n≈5181 | `perObjectFrustumCulled=true` 时每次 render 遍历全部 instance（`three.core.js:27477`）。阴影 pass 是第二次 render → 这笔 CPU 遍历付两遍 |
| GPU：阴影 pass 绘制 | 小 | shadow camera ±30 正交相机，逐 instance 剔除后只画玩家附近 ~2×2 column 的 section |
| GPU：主 pass 阴影采样 | 小 | 每片元多一次 shadow map 纹理采样 + 比较 |
| **节流** | `autoUpdate=false` | 阴影 pass 不是每帧跑，只在 needsUpdate 时跑（玩家移动 / 方块编辑），静止时零开销 |

验收：`npm run bench -- --check` 无 >10% 回退（材质是热路径，门禁分层要求）。

## 7. 测试策略

| 层 | 内容 |
|---|---|
| Tier 1 单测 | 节流逻辑（200ms 内不重复刷新 / pending 补刷）、开关语义（关闭后 castShadow=false + strength=0）、日夜联动（uShadowStrength == skyDim）、方向插值（`paramsAtHour` 返回的 sunDirection 在风格边界连续 + normalize 后为单位向量） |
| Tier 4 像素实测 | ① 遮挡物（树/墙）旁地面像素比开阔处暗（有影）；② `setShadowsEnabled(false)` 后无影；③ 夜里（setTime(23)）影淡。判据阈值对着屏幕实测值定（CLAUDE.md 口径），不贴图集统计 |
| E2E | 走 `__MC_GAME__` 断言接线：`sunLight.castShadow === true`、BatchedMesh cast/receive 设置、`renderer.shadowMap.enabled === true` |
| bench | `npm run bench -- --check`（材质热路径） |
| 负向验证 | 注入「不订阅 block-changed」→ 放块后阴影不更新（像素实测）；注入「节流失效」→ 每帧刷新（帧时实测） |

## 8. 风险与回退

- **最大未知数**：WebGPU 阴影 pass 对 BatchedMesh（自定义 `packed` 属性布局 +
  per-instance 剔除）的兼容性，r185.1 无现成验证 → **实施 Task 1 先做最小接线实测**
  （一盏灯 + 一个方块 + shadow() 节点，读像素验证有影），不通则停下来重新评估
  （回退选项：castShadowNode 路线 / 放弃 shadow map 改回 skylight 遮挡讨论）；
- 树叶实心投影（§4.2 ⚠️）：若观感不可接受，升级为方案 B（castShadowNode + alphaTest），
  本期不做；
- 性能回退超 10%：优先调小阴影相机（±30 → ±20）或降刷新频率，而非关功能。

## 9. 与 mc-lite 的偏离（有意）

| # | 偏离 | 理由 |
|---|---|---|
| ① | 按通道投射（花草藤/cloud 会投影，玻璃不投影），非 mc-lite 的按方块白名单 | DR-2：通道级合批架构决定；视觉差异可忽略 |
| ② | 节流用 `light.shadow.autoUpdate`（per-light），非 mc-lite 的 `renderer.shadowMap.autoUpdate` | DR-5：WebGPU 后端口径不同，mc-lite 的写法在本后端不生效 |
| ③ | 阴影浓度随日夜淡出（`uShadowStrength = skyDim`） | mc-lite 无此联动（其阴影夜里也全浓度，但夜里整体压暗看不出来）；本方案显式联动更干净 |
| ④ | 实体不投射不接收（本期） | 范围控制，接线点预留 |
| ⑤ | 太阳方向随日夜**连续插值**（mc-lite 是风格切换离散变化） | mc-heavy 日夜是连续关键帧插值（`daynight.js`），方向向量逐分量插值 + normalize 是自然扩展；离散切换会在风格边界产生阴影方向跳变 |

## 10. 设计文档同步（实施时做，v1.43 → v1.44）

- §4.4.4「阴影」：原规划「贴图 2048 / 覆盖视距 60% / 投射由 BlockRegistry 属性驱动」
  改为本次实测口径（256 / ±30 / 通道级投射 / 太阳方向随日夜风格插值），并注明 v1.9/DR-14
  （skylight 遮挡）与 shadow map 是两条独立路线、本决策不推翻 DR-14；
- §4.6 不动（skylight 恒 15 口径不变）；
- `daynight.js` 的 `VISUAL_STYLES` 新增 `sunDirection` 字段（三组 mc-lite 原值）—— 属玩法
  数据口径变更，随设计文档修订说明一并记录；
- CLAUDE.md 活跃约束段：追加「shadow map 节流是 per-light 口径」「阴影 pass 不消费
  alphaTest」「材质构建须先有 sunLight」等实施中确认的载荷性口径。
