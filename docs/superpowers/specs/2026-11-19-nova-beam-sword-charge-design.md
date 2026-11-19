> ⚠️ **本文档已作废（2026-11-19）。** 用户实玩后改选型：「干脆改成 storm lance 算了，
> 这个是最简单的特效。你不要参照 nova bean 了。」现行设计见
> `2026-11-19-storm-lance-sword-charge-design.md`。**保留本文仅为留存实测结论**
> （WebGPU 无 ShaderMaterial / bloom 0.03 / toneMapped 不存在 / 爆炸伤害只打丧尸等），
> 其中的六 pass 架构与玩法数值**一律不再实施**。

# 持剑蓄力大招：Nova Beam（新星光束）

> 用户 2026-11-19 需求 + `ask_user_question` 三条裁定 + 方案 A 批准。本文是设计文档，实施计划另出
> （`docs/superpowers/plans/2026-11-19-nova-beam-sword-charge.md`）。

## 1. 意图与由来

用户原话：

> 我想给玩家持剑的时候增加一个攻击特效，长按鼠标后松开时触发这个特效，短按鼠标就是普通的
> 挥剑攻击，长按鼠标 2 秒后松开就会触发这个新特效。新特效是 Nova Beam，特效来自
> `~/jaylli/LinearAbiltyCastingThreeJS` 项目里……这个特效的攻击范围攻击到的 boss 或者丧尸，
> 掉血的幅度等同于被炸弹炸到的效果。

**为什么值得做**：剑目前只有 50 伤害 / 3 格射程的近战一刀，对 Boss（焰魔 3500 / 守卫 2000 /
飞龙 3000）要 60~70 刀。玩家缺一个「攒一下、打一发大的」的节奏。Nova Beam 给的正是这个：
**用 2 秒不动的蓄力换一次 26 格的远程范围打击**，风险回报与近战贴脸相反。

### 1.1 本轮裁定（`ask_user_question` 实测回答）

| 问题 | 用户选择 |
|---|---|
| 光柱伤害怎么算 | **每个实体扣一次 50**（= 恰好一颗炸弹；燃烧期不重复扣血） |
| 要不要破坏沿途方块 | **不破坏，只打实体**（与剑一致；遇墙按 DDA 截断） |
| 要不要常驻调参坞 | **不要，只加准心蓄力环** |

### 1.2 方案选择（用户批准 A）

- **A（采纳）六 pass 全量 TSL 重写**：同一根参数化管画三遍（CORE/SHELL/HALO）+ 金色螺旋带
  + 冲击盘 + 蓄力光球，再加火花池 / 落点爆壳 / 地面冲击环。共 9 个 mesh，空闲全部
  `visible=false` ⇒ **0 draw call**。
- B（否决）三 pass 管 + 光球，砍掉线圈/冲击盘/粒子：约 1/3 工作量，但上游 README 明说
  「柱身刻意压暗，眼睛实际跟随的是金色线圈」——砍掉后剩一根发光塑料管，Nova Beam 的身份没了。
- C（否决）复用 `spike-fx` 那套 `InstancedMesh` + `MeshBasicMaterial`：additive 纯色柱体没有
  体积积分（三层加权才是「白热实心棒」的来源），出来是半透明塑料棒，与「特效来自那个项目」相背。

### 1.3 三条附带裁定（用户同意）

- **不做震屏、不做全屏闪白**（沿用 2026-11-15 对焰魔「不碰相机」的裁定）。
- **音效零新增素材**：蓄力起手 `emp_activated`、蓄满 `gun_load`、释放 `dragon_fire`、
  落点 `explosion` —— 四个全部已在 `SOUND_IDS` 里。
- **不做地面焦痕 / dust 贴花**（要新开贴花池 + 逐帧地面查询）；落点由爆壳 + 冲击环 + 火花承担。

## 2. 上游调研结论（实测读源，不是猜的）

### 2.1 Nova Beam 的真实构成

| 层 | 文件 | 实测内容 |
|---|---|---|
| 玩法/节奏 | `src/abilities/BeamAbility.js`（720 行） | 四拍：`charge` 0.42s 双手蓄力球 → `travel` 前沿 150 m/s 推进 → `impact` **落点持续燃烧 1.15s** → `fade` 0.4s 收成细丝熄灭 |
| 着色 | `src/materials/BeamMaterial.js` | **六个 pass**：CORE / SHELL / HALO（同一管三个半径）+ COIL（螺旋带，instanced）+ RING（冲击盘，instanced）+ ORB（噪声侵蚀球） |
| 几何 | `src/assets/ProceduralGeometry.js` | `createBeamTubeGeometry(96,26)` / `createBoltRibbonGeometry(128,8)` / `createBeamRingGeometry(12,44)`，**全部参数化**（顶点里没有任何米数） |
| 噪声 | `src/shaders/lib/noise.glsl.js` | Ashima simplex + `ridged`（4 octave `1−|snoise|`） |
| 参数 | `src/config/settings.js:876-1125` | 176 个旋钮 |

**零贴图、零美术资源**（程序化扫描确认：`BeamAbility` / `BeamMaterial` / `ProceduralGeometry`
三个文件里没有任何 `TextureLoader` / `.png` / `.jpg`）。

### 2.2 三层加权的观感来源（上游 README §The beam）

- **HALO** 最宽，只有 rim 项 —— 被推开的空气。
- **SHELL** 边缘加权 ⇒ 读作**空心**，轮廓边最亮。
- **CORE** 窄，**反向加权**：视线沿管轴穿过时路径最长 ⇒ 最亮 ⇒ 中间读作实心白棒。

「外面 rim 加权、里面轴向加权、两面都叠加」= 一次廉价的体积积分。这是本特效的身份，
**不能简化成单层 additive 圆柱**。

### 2.3 三个硬约束（实测，会改变实施方式）

**① ⚠️⚠️ 上游是 raw GLSL `ShaderMaterial`，本仓一行都不能直接用。**

`vendor/three/three.webgpu.js:86728-86740` 的 `NodeMaterial` 库只注册 12 种内置材质
（`MeshPhong/Standard/Physical/Toon/Basic/Lambert/Normal/Matcap/LineBasic/LineDashed/Points/Sprite/Shadow`），
**没有 `ShaderMaterial`** ⇒ `fromMaterial()` 返回 null → `three.webgpu.js:53536` 报
`NodeBuilder: Material "ShaderMaterial" is not compatible.` 并回落空 `NodeMaterial`（画面什么都没有）。
红线 9 又是 WebGPU 唯一后端 ⇒ **六个 pass 必须用 TSL 重写**。这是本次工作量的主体。

**② ✅ 上游 bloom 强度实测只有 0.03（近乎关闭）** ⇒ 那个观感**不依赖后处理**。
（`settings.js:1788` `bloomStrength: 0.03`，注释原文「Strength is deliberately near zero」）。
本仓无 `PostProcessing`，也**不该加** —— 会撞水面倒影的 pass 时序红线（v3.17 实测：
额外 pass 后置会把 BatchedMesh 的 indirect 索引表覆写 → 天空撕成黑多边形）。
发光靠 additive + HALO pass 自己就够。

**③ ⚠️⚠️ 「等同炸弹伤害」的现有实现只打丧尸。**
`EXPLOSION_DAMAGE = 50` / `EXPLOSION_DAMAGE_RADIUS = 4`（`voxel/explosion.js:20-21`），
但 `game.js:_damageEntitiesInRadius` 只遍历 `zombies.activeEntities()` —— **TNT 现在压根打不到 Boss**。
用户要「Boss 或丧尸都掉血」⇒ 光柱必须走 `damageEntity()`（它按类型分发到
zombie/dragon/ignis/guardian），**不得复用那个丧尸专用函数**。

### 2.4 两处刻意不移植（本仓口径不同）

| 上游做法 | 本仓决定 | 理由 |
|---|---|---|
| `softFade(uSceneDepth, …)` 深度软相交 | **不移植**，只靠 `depthTest: true` 硬遮挡 | TSL 的对应物 `viewportDepthTexture()` 是 `ViewportTextureNode`，它的 `updateBefore` 会 **`currentPass.end()` + 重开 render pass**（`three.webgpu.js:86491`）。那正是 v3.17 撕天空那一类时机缺陷。硬遮挡是本仓曳光既有口径，零风险。 |
| `toneMapped: false` | **无法移植**（WebGPU 后端 `toneMapped` 出现次数实测 **0**） | 色调映射在 `_renderOutput` 的全屏 output pass 上做，材质级开关不存在。上游的 glow 8.0 / opacity 2.0 在本仓 ACES 下会削平成白 ⇒ **必须按像素实测重标增益**（见 §6.2）。 |

## 3. 目标 / 非目标 / 反目标

**目标**
- 持剑时**按下左键仍立刻挥一刀**（既有行为逐位不变），同时开始蓄力。
- 按住 **2.0 秒**蓄满，准心外的蓄力环走满并转为「就绪」配色 + 响一声 `gun_load`。
- 蓄满后**松开**左键 → 从剑侧射出一道光柱，沿准心方向最远 **26 格**，遇方块按 DDA 截断。
- 光柱扫到的**每个**丧尸/Boss 各扣 **50**（一次施法只扣一次），走 `damageEntity` ⇒
  红闪 / 伤害数字 / 死亡音效 / 死亡爆散全部自动跟上。
- 光柱落点持续燃烧 1.15s 后收成细丝熄灭（上游第四拍）。
- 空闲时 **0 draw call**；施放期间 9 个。

**非目标**
- 不破坏方块（用户裁定）。
- 不做持续伤害（用户裁定「每个实体扣一次」）。
- 不做震屏 / 全屏闪白 / 地面焦痕贴花（§1.3）。
- 不做调参坞（用户裁定）。
- 不给枪/徒手加蓄力（只有剑）。
- 不改 TNT 的伤害口径（`_damageEntitiesInRadius` 只打丧尸这件事**本轮不动** —— 它是既有行为，
  改它属于另一个需求）。

**反目标（做成了也算失败）**
- 短按左键的行为发生任何变化（挥砍时机/伤害/音效/动画）。
- 空闲时多出 draw call，或透明队列里多出常驻项（会破 `water-order.spec` 的顺序不变式）。
- 蓄力环成为 `#crosshair` 的子节点（`tests/crosshair.spec.mjs` 钉死它只有两笔 2px 笔画）。
- 光柱在雾里被洗白（`scene.fogNode` 存在 ⇒ 材质必须显式 `fog: false`）。
- 光柱伤害只打丧尸（用户明确要 Boss 也掉血）。

## 4. 玩法与数值

### 4.1 唯一权威落点

`weapon-catalog.js` 的 `WEAPONS[sword].novaBeam`（与 `swing` / `knockbackDistance` 同级）。
伤害**派生**自 `EXPLOSION_DAMAGE`，不写第二份 `50`：

```js
import { EXPLOSION_DAMAGE } from '../../voxel/explosion.js';
// …
novaBeam: {
  chargeSeconds: 2.0,      // 用户明确「长按 2 秒」
  range: 26,               // 上游 settings.beam.range
  speed: 150,              // 上游前沿速度（格/秒）
  burnSeconds: 1.15,       // 上游 lifetime
  fadeSeconds: 0.4,        // 上游 fadeTime
  cooldown: 2.0,           // 见 §4.3 的推导
  damage: EXPLOSION_DAMAGE,// = 50，红线 1
  radius: 0.77,            // 上游落点半宽
  radiusNear: 0.16,        // 上游枪口半宽
  radiusCurve: 1.27,
  handOffset: [0.28, -0.22, 0.55],  // 相机空间 right/up/forward
  chargeSound: 'emp_activated', chargeVolume: 0.3,
  readySound: 'gun_load',        readyVolume: 0.4,
  fireSound: 'dragon_fire',      fireVolume: 0.5,
  impactSound: 'explosion',      impactVolume: 0.4,
}
```

### 4.2 各实体的「几发致死」

| 实体 | 血量 | Nova Beam 发数 | 对照：剑 | 对照：TNT |
|---|---|---|---|---|
| 丧尸 | 100 | **2** | 2 刀 | 2 次 |
| 焰魔 | 3500 | 70 | 70 刀 | **打不到** |
| 守卫 | 2000 | 40 | 40 刀 | **打不到** |
| 飞龙 | 3000 | 60 | 60 刀 | **打不到** |

⇒ 单发伤害与剑相同，**价值在射程（3 → 26 格）与范围（一次打多个）**，不在 DPS。
蓄力 2 秒 + 冷却 2 秒 ⇒ 4 秒一发 = 12.5 DPS，远低于剑的 100 DPS。这是有意的：
它是「安全距离的范围清场」，不是「更强的单体输出」。

### 4.3 冷却 2.0 秒是推导出来的，不是拍的

释放后的总视觉时长 = `travel` + `burn` + `fade`：
- travel = `range / speed` = 26 / 150 = **0.173s**（前沿有个 0.05s 的 outQuad 起步缓动，
  实际 ≈ 0.198s，取上界 0.2s）
- burn 1.15s + fade 0.4s
- 合计 ≤ **1.75s**

而两次施法最少间隔 = `chargeSeconds` = **2.0s**（必须先按住 2 秒）。
`2.0 > 1.75` ⇒ **两道光柱在时间上不可能重叠** ⇒ 渲染器只需要 **1 个光束槽位**，
不需要池、不需要覆盖最旧逻辑。冷却取 2.0 与蓄力同值，让「松手 → 立刻可以再按住」成立。

⚠️ 这条推导是**载荷性的**：若将来把 `range` 抬到 60 或 `burnSeconds` 抬到 2.0，
总时长会超过 2.0s ⇒ 必须同时抬冷却或改多槽位。单测钉住
`chargeSeconds >= range/speed + 0.05 + burnSeconds + fadeSeconds`。

### 4.4 蓄力状态机（`WeaponController`，纯逻辑无 three）

```
pointerDown(aim)  → triggerHeld=true; chargeElapsed=0; 照旧 _tryFire（剑=挥一刀）
                    若 weapon.novaBeam → 追加 'nova-charge-start' 事件（起手音）
update(dt, aim)   → cooldown -= dt
                    若 triggerHeld && weapon.novaBeam:
                      chargeElapsed += dt
                      首次越过 chargeSeconds → 追加 'nova-charge-ready' 事件（蓄满音）
                    automatic 连射逻辑不变（剑无 automatic ⇒ 不连砍）
pointerUp(aim)    → triggerHeld=false
                    若 weapon.novaBeam && chargeElapsed >= chargeSeconds && cooldown<=0 && aim:
                      → _fireNovaBeam(aim)（扣冷却、结算伤害、发 'nova-beam' 事件）
                    chargeElapsed = 0
select(id)        → chargeElapsed = 0（切武器丢弃蓄力）
```

**兼容性**：`pointerUp()` 现在**可以不带 aim** 调用（既有 5 处单测/spec 都这么调）——
无 aim 时只清 `triggerHeld` 与 `chargeElapsed`，不施法。`fireOnce()` 语义完全不变
（它是「立刻开一枪/砍一刀」，不参与蓄力）。

### 4.5 命中判定：五射线截面扫描（复用 MAG7 手法）

光柱是**有粗细的柱体**，单条轴线射线会漏掉「偏离轴心但在柱半径内」的敌人。
本仓已有现成手法：`collectMag7Changes` 在相机 `right/up` 基底上取 3×3 截面。
这里取**十字 5 条**（轴线 + `±radius` 的 right/up 四条），逐条：

1. `raycastVoxel(world, origin_i, forward, range)` 取该条的方块遮挡距离 `blockDist_i`；
2. `entities.raycastAll(origin_i, forward, min(range, blockDist_i), isHittable)`
   取该条上**全部**实体命中（新加的方法，见 §5.2）；
3. 按实体 id 并集去重，保留最近 dist。

**为什么不用「AABB 膨胀 + 单射线」**：`definition.raycastAabb` 各自闭包了自己的 AABB
（`ignisAabbFor` / `guardianAabbFor` 还随 yaw 旋转），`EntityManager` 无法从外部注入膨胀量。
五射线复用**同一个** `raycastAabb` 权威，零第二份几何。

**为什么十字而不是 3×3 九条**：柱截面是圆，十字的四端恰在圆周上，九条的四个角
（`√2·r ≈ 1.09` 格）落在圆外 ⇒ 会打到柱外的敌人。十字是圆的内接采样，宁可略保守。

**成本**：一次施法 5 次 DDA（26 格 × 3 步 ≈ 78 次 `getBlockId`）+ 5 次 `raycastAll`
（每次遍历 ≤28 个实体）⇒ 约 390 + 140 次查询，**一次性**，不进帧循环。

**视觉长度** = 轴线那条的 `min(range, blockDist_0)`（不是五条的最小值 —— 光柱本体沿轴线，
偏移射线只用于命中采样）。

### 4.6 不击退

炸弹不击退（`_applyExplosion` 只扣血），用户要「等同被炸弹炸到」⇒ 光柱也不击退。
剑的 `knockbackDistance` 只作用于普通挥砍，本轮不动。

## 5. 架构与文件

### 5.1 分层（依赖方向单向，红线 8/10）

| 文件 | 层 | three | 职责 |
|---|---|---|---|
| `src/player/weapons/nova-beam.js` | player | **无** | 纯函数：蓄力进度、手点/轴线、五射线扫描 |
| `src/player/weapons/weapon-catalog.js` | player | 无 | `novaBeam` 数值唯一权威（改） |
| `src/player/weapons/weapon-controller.js` | player | 无 | 蓄力状态机 + `_fireNovaBeam`（改） |
| `src/entities/entity-manager.js` | entities | 无 | 新增 `raycastAll`（改） |
| `src/render/nova-beam-geometry.js` | render | 有 | 三个参数化几何 + 火花 quad |
| `src/render/nova-beam-config.js` | render | **无** | `NOVA_BEAM_FX` 观感常量（Tier 1 单测可直接 import，不必过 GPU） |
| `src/render/nova-beam-material.js` | render | 有 | TSL 九个材质 |
| `src/render/nova-beam-renderer.js` | render | 有 | 单槽生命周期 + 粒子发射 + uniform 同步 |
| `src/ui/nova-charge-ring.js` | ui | 无 | 准心蓄力环（DOM/SVG） |
| `src/core/game.js` | core | 有 | 装配 + 注入 sweep + 帧循环 + dispose（改） |

`player/` 与 `ui/` 不参与 `check:arch` 的方向检查；`render/` 不在 `ISOMORPHIC_DIRS` 里。
`nova-beam.js` 只 import `player/raycast.js`（同层）与 `voxel/explosion.js`（catalog 侧），
不 import three、不 import render。

### 5.2 `EntityManager.raycastAll`（新增，不动既有 `raycast`）

```js
raycastAll(origin, dir, maxDist, predicate) → Array<{id, type, dist, point}>  // 按 dist 升序
```

与 `raycast` **共用同一份** `definition.raycastAabb` 与归一化逻辑（红线 1）。
既有 `raycast` 一行不改 ⇒ 武器/弹丸/炮塔行为逐位不变。

### 5.3 伤害结算在装配层，几何在纯函数

`novaBeamSweep({ world, entities, isHittable, aim, cfg })` 是纯函数，返回
`{ origin, target, side, length, hits }`，**不扣血**。
`Game._novaBeamSweep(aim, cfg)` 调它，然后对每个 hit 调 `damageEntity(id, cfg.damage, nowMs)`。
controller 经注入的 `entityQuery.sweepBeam(aim, cfg)` 拿到结果 —— 与 `knockback` 同一手法
（controller 不持有 world/entities/玩家位置）。

未注入时（fixture / 旧单测）`sweepBeam` 缺席 ⇒ controller 走 `novaBeamAxis` 拿几何、
`hits = []`，**不扣血也不报错**（向后兼容，与 `entityQuery` 缺省 null 同口径）。

## 6. 渲染设计

### 6.1 九个 pass

| # | pass | 几何 | 混合 | 说明 |
|---|---|---|---|---|
| 1 | HALO | tube(96,26) | additive | 宽 2.75×，只有 rim |
| 2 | SHELL | 同上 | additive | 1.0×，rim 加权（空心感） |
| 3 | CORE | 同上 | additive | 0.2×，**轴向**加权（实心白棒） |
| 4 | COIL | ribbon(128) × 4 instance | additive | 金色螺旋带 |
| 5 | RING | annulus(44) × 10 instance | additive | 冲击盘沿柱下滑 |
| 6 | ORB | Icosahedron(1,4) | additive | 蓄力球（噪声侵蚀 + 丝状纹） |
| 7 | SPARK | quad × 768 instance | additive | GPU 模拟：火花/浮尘/吸入三用 |
| 8 | BURST | Sphere(1,24,16) | additive | 落点压缩空气壳 |
| 9 | SHOCK | Plane(2,2) 贴地 | additive | 落点地面冲击环 |

全部 `transparent: true` / `depthWrite: false` / `depthTest: true` / `side: DoubleSide` /
**`fog: false`** / `renderOrder = 3`（体素水 0 < 海面 1 < 曳光 2 < 光柱 3）/ `frustumCulled: false`。

**为什么 renderOrder 3**：与曳光同理 —— 海面 `depthWrite=true`，光柱排在它之后才能被水面
正确遮挡（入水段），而水面上方保持可见。空闲 `visible=false` ⇒ 透明队列回到基线，
`water-order.spec` 的顺序不变式不受影响。

### 6.2 TSL 重写的四条口径

**① 世界空间顶点：用 `vertexNode` 而不是 `positionNode`。**
参数化几何的 `position` 是 `(t, a, 0)`，不是坐标。`positionNode` 的返回值会被
`modelViewMatrix` 再乘一次 ⇒ 依赖「mesh 矩阵恒等」这个隐式前提。改用
`material.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(here, 1)))`
显式输出 clip 位置，**不依赖任何矩阵前提**。火花走视图空间 billboard：
`cameraProjectionMatrix.mul(vec4(centerView + quadOffset, 1))`。

**② 噪声家族换 Perlin，但保住「平滑、沿流向拉长、向下游爬」的特征。**
`mx_noise_float` / `mx_fractal_noise_float` 已在 vendor 里（实测 `three.tsl.js` 导出齐全）。
上游 `ridged(p, 4)` = `Σ a·(1−|snoise|)`，用 `Fn` + `Loop(4)` 逐字重建：

```js
const ridgedFbm = Fn(([p]) => {
  const q = vec3(p).toVar(); const amp = float(0.5).toVar(); const sum = float(0).toVar();
  Loop(4, () => {
    sum.addAssign(amp.mul(float(1).sub(abs(mx_noise_float(q)))));
    q.mulAssign(2.06); amp.mulAssign(0.5);
  });
  return sum;
});
```

上游 README 明确「beam 的噪声必须平滑，kink 了就变成闪电」⇒ **不得**换成分段线性噪声。

**③ `smoothstep` 的反向写法要改成 `1 − smoothstep`。**
上游 `smoothstep(uProgress, uProgress - tip, vT)` 依赖 `edge0 > edge1`（GLSL 未定义行为）。
本仓写 `oneMinus(smoothstep(uProgress.sub(tip), uProgress, vT))`，语义等价且定义良好。

**④ 增益必须按像素重标（`toneMapped` 在 WebGPU 不存在）。**
上游柱身 `glow 0.74 / opacity 0.29`（刻意压暗，给线圈让位），线圈 `glow 8.0 / opacity 2.0`。
本仓 ACES + exposure 会把 8.0 直接削成白 ⇒ 观感常量表 `NOVA_BEAM_FX` 里给一个
**统一增益 `gain`**，初值 1.0，由 Tier 4 像素实测标定。判据不是「够亮」而是
**「柱身偏青白、线圈偏金、两者可区分」**（见 §7.3）。

**⑤ 常量色必须显式拆分量。**
`vec3(new THREE.Color(hex))` 在 WebGPU 输出纯黑且零报错（v3.14 炮塔实测）⇒
一律 `vec3(c.r, c.g, c.b)` 或 `uniform(new THREE.Color(hex))`。

### 6.3 配色（取自上游，不新造）

| 用途 | hex | 出处 |
|---|---|---|
| 轴心白热 | `#ffffff` | `colorCore` |
| 内层 | `#d3f4ff` | `colorInner` |
| 鞘外层 | `#3ec6ff` | `colorOuter` |
| 宽晕 | `#0d3ce0` | `colorHalo` |
| 线圈主色 | `#ffdc8c` | `colorCoil` |
| 线圈边 | `#ff6a12` | `colorCoilEdge` |
| 冲击盘 | `#9ceeff` | `colorRing` |
| 爆壳 | `#3ec6ff → #d3f4ff → #ffffff` | `colorBurstA/B/C` |
| 冲击环 | `#3ec6ff → #ffffff` | `colorShockA/B` |

**冷青柱身 + 暖金线圈**是这个特效的身份（上游注释：「colour split 是让它们不融进鞘里的原因」）。

### 6.4 粒子：一个系统三种发射

768 slot 环形缓冲，CPU **只写出生数据**（origin/vel/spawn/life/size/seed/kind），
运动/尺寸曲线/颜色渐变/淡出全在 GPU。三种 kind：

- **吸入**（蓄力期）：在手点周围球壳上生成，速度指向手点，壳半径随进度收紧（`1 → 0.45`）。
- **柱身喷溅**（travel/burn）：在柱面随机 `t` 处沿径向外抛 + 沿流向前拖。
- **落点回溅**（burn）：从落点**逆着**柱方向 + 向上抛（读作「正在钻穿什么东西」）。

颜色按 age 走四停靠渐变（白 → 淡青 → 青 → 深蓝），与上游 `colorSparkA~D` 一致。

### 6.5 生命周期（单槽，§4.3 已证不重叠）

```
setCharge(progress, handPoint, side)   每帧（蓄力中）；progress=0 → ORB 隐藏
fire({origin,target,side,length,seed}, nowMs)
   → phase='travel', front=0, 释放爆壳 + 70 火花 + ORB 开始 0.15s 淡出
update(nowMs, dt)
   travel: front += speed·outQuad(since/0.05)·dt；u=front/length；u≥1 → phase='burn'
   burn:   持续 burnSeconds，落点回溅 + 周期爆壳 + 地面冲击环
   fade:   持续 fadeSeconds，fade=1−inCubic(k)，widthFade=max(0.04, 1−outCubic(k)·0.94)
   done:   柱身八个 mesh 立即 visible=false；**火花走自然衰亡窗口**（两个最长寿命 1.1s）
```

**widthFade 与 fade 分开**是上游的关键观感：宽度先收（`outCubic`），亮度后消（`inCubic`）
⇒ 读作「柱子啪一下缩成细丝再熄灭」，而不是「粗柱子慢慢变暗」。

**⚠️ 火花不得在 `done` 时硬切**（实测修正）：fade 只 0.4s 而火花寿命 0.55s ⇒ 结束时还有
火花在飞，硬切会让尾巴上的火花凭空消失。故 `sparkMesh` 交给 idle 分支的衰亡窗口收。

**⚠️ 爆壳与冲击环各自一个 fade uniform**（`uBurstFade` / `uShockFade`，实测修正）：
不得共用柱身的 `uFade` —— 后者在 burn 期恒 1，共用会让这两个**只缩不淡**，
寿命到时在满亮度上硬 pop 消失。两者均按 `1−inCubic(k)` 写，末帧归零。

### 6.6 从水面倒影里隐身

`_renderWaterReflection` 的 `hidden` 列表追加光柱的 9 个 mesh。理由：反射 pass 的成本主杠杆
是 **draw call 数**（v3.17 实测），多 9 个是白付；且 additive 特效在镜像相机下的观感未标定。
与 `viewArm` / `viewWeapon` 同一手法（它们也是挂 camera 的第一人称物件）。

## 7. UI：准心蓄力环

### 7.1 硬约束

- **不得挂进 `#crosshair`**：`tests/crosshair.spec.mjs:99` 钉死 `ch.children` 恰好两笔
  `['20x2','2x20']`。故独立元素 `#mc-nova-charge`，挂 `document.body`（与 crosshair 同级）。
- **z-index 50**（= 坐标/性能面板 = 血心 = Boss 提示）。低于设置按钮 60 与一切模态，
  **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
- `pointer-events: none`（判「在最上层」只能走像素，`elementFromPoint` 会跳过它）。

### 7.2 形态

```
        ╭───╮          蓄力中：青色弧从 12 点顺时针扫过
      ╭─┤ + ├─╮        r=18px，环宽 3px，外径 48px（准心 20px 在中心）
        ╰───╯          蓄满：整环转金 + 外发光呼吸（1.2s 周期）
```

- SVG `<circle>` + `stroke-dasharray = C` / `stroke-dashoffset = C·(1−p)`，`rotate(-90)`。
- 进度 `p < 1`：`#7ff0ff`（上游 accent）；`p ≥ 1`：`#ffd75e`（本仓 Boss 提示的琥珀金）。
- `p = 0` 时 `opacity: 0; visibility: hidden`（不占绘制、不干扰像素测试）。
- 每帧只在进度变化 > 0.005 时写 DOM（与迷你地图同节流思路）。

### 7.3 性能面板操作说明

`perf-hud.js` 的 `HELP_LINES` 追加一行 `'剑长按2秒：Nova Beam'`。
**实测行宽 132.00px**（12px monospace，CJK 12px / ASCII 7.2px），
内容区可用 310px（330 − 20 padding）⇒ 不撑宽面板。
`tests/player-flight.spec.mjs:143` 的「面板宽度恒 330 + 无横向溢出」两条仍成立。

## 8. 测试策略（按 `docs/testing-policy.md` 分级）

### 8.1 Tier 1（必须 TDD）— `src/tests/test-nova-beam.js`

Node 白名单（无 DOM、无 GPU）：

1. **常量与派生**：`novaBeam.damage === EXPLOSION_DAMAGE`；冻结；
   `chargeSeconds >= range/speed + 0.05 + burnSeconds + fadeSeconds`（单槽不重叠的前提）。
2. **蓄力进度**：`novaChargeProgress` 在 0 / 1s / 2s / 3s 的取值与 ready 边界。
3. **手点与轴线**：`novaBeamAxis` 在 forward=(0,0,−1) / (−1,0,0) 下的 origin/target/side。
   ⚠️ 入参是 **aim 的 forward/right/up 基底**（不是 yaw）—— controller 拿到的就是 aim，
   在纯函数里再从 yaw 推一遍前向就是第二份权威（`player.js:_buildAim` 已经是唯一来源）。
4. **五射线扫描**：合成 world + 假 entities ⇒
   - 轴上敌人命中；偏离轴线 0.5 格（< radius）命中；偏离 1.5 格（> radius）不命中；
   - 墙后敌人不命中（DDA 截断）；
   - 同一敌人被多条射线命中只出现一次（去重）；
   - 超 26 格不命中；
   - `length` 取轴线 DDA 距离而非五条最小值。
5. **controller 状态机**：
   - 短按（0.3s）松开 → 只有 melee，无 nova；
   - 按住 2.0s 松开 → 恰好一个 `nova-beam` 事件；
   - 蓄满不松开 → 不施法；
   - 蓄满音只在越过阈值那一帧响一次；
   - `select` 切武器清蓄力；
   - 冷却期内蓄满松开不施法；
   - `pointerUp()` 无 aim 不抛错、不施法；
   - **既有剑行为零回归**：按下边沿仍砍一刀、按住不连砍。
6. **`raycastAll`**：多实体按 dist 升序、predicate 生效、maxDist 裁剪、空集合返回 `[]`；
   与 `raycast` 的最近项逐位一致。

### 8.2 Tier 4（像素实测）+ E2E — `tests/nova-beam.spec.mjs`

归入 `tools/test-tiers.mjs` 的 **ENTITY** 档（照 `ignis-spike` 先例：玩法 + 像素同 spec）。

1. **蓄力环**：短按不出现；按住 1s 出现且 `dashoffset` 单调递减；2s 后转就绪色；
   松开后消失。**不是** `#crosshair` 的子节点（DOM 契约）。
2. **Tier 4 光柱真的上屏**：同机位同地形，只差有没有 `fire` ⇒ 差分像素数 > 阈值。
   ⚠️ **必须藏掉宿主噪声源**：剑体本身是紫色且挥砍动画在动 ⇒ 两侧都先
   `viewWeapon.node.visible = false`（同焰魔法阵 v3.04 的「藏掉同色宿主」教训）。
3. **色彩判别力**：差分像素里**青白簇**（`b > r + 20 && g > r`）与**金色簇**
   （`r > g + 20 && g > b + 20`）**都**必须存在 —— 只钉「变亮」抓不到「线圈没画」
   与「三层塌成一根白棒」两类缺陷。
4. **伤害**：丧尸 100 → 50（一次，不是燃烧期多次）；焰魔 3500 → 3450。
   ⚠️ 焰魔那条**必须同步读**（Agent 每帧推进位置，插 await 会混入 AI 位移）。
5. **范围**：轴线两侧各 0.5 格的两只丧尸**都**掉血（证明不是单射线）。
6. **不破坏方块**：光柱穿过一片石头，`getBlockId` 逐格不变（即使 `gunBlockDamage` 开着）。
7. **遮挡**：墙后的丧尸不掉血，且 `length` 被截断。
8. **draw call**：空闲 = 基线；施放中 = 基线 + 9；结束后回基线。
9. **重复施放稳定**：连续 3 次蓄力 + 释放，无泄漏（mesh 数不变、draw call 回基线、
   粒子 slot 不越界）。
10. **负向对照**：把 `sweepBeam` 注入拆掉 → 伤害消失而视觉仍在（证明伤害判据不是视觉的假阳性）。

### 8.3 门禁

- `npm run check`（arch + data + lint）：新文件自动进「测试注册」双向门。
- `tools/test-tiers.mjs`：`test-nova-beam.js` 进 `UNIT_NODE_SAFE`；`nova-beam` 进 `ENTITY`。
- **不动 bench 冻结基线**：光柱空闲 0 draw call、0 顶点 ⇒ `m3-baseline` 逐位不变。
  仍跑一次 `npm run bench -- --check` 确认（改了 `game.js` 帧循环 ⇒ 属热路径边缘）。

## 9. 已知风险与预案

| 风险 | 形态 | 预案 |
|---|---|---|
| TSL 常量色纯黑 | 整片 pass 消失，零报错，计数全绿 | 一律 `vec3(c.r,c.g,c.b)`；Tier 4 双色彩簇判据 |
| ACES 把线圈削成白 | 金/青不可区分，「变亮」判据仍绿 | `NOVA_BEAM_FX.gain` 按像素重标；判据钉**两个色簇都在** |
| 忘了 `fog: false` | 远处光柱被雾洗成天空色 | 单测钉九个材质的 `fog === false` |
| `viewWeapon.onShot` 收到无 recoil 的新事件 | `_recoil = undefined` → NaN → **剑体消失** | 新事件一律带 `recoil: 0`，且 `_applyWeaponEffect` 对蓄力事件**不调 onShot** |
| 蓄力环挂进 crosshair | `crosshair.spec` 立刻红 | 独立元素 + spec 钉 DOM 契约 |
| 粒子 NaN 污染整池 | 一个 NaN 写进 instanced attribute ⇒ 全池消失 | spawn 前 `Number.isFinite` 逐项守卫（同法阵/尖刺口径） |
| 透明队列顺序漂移 | `water-order.spec` 红 | 空闲 `visible=false` + 固定 `renderOrder=3` |

## 10. 自检（builder check，本会话自审 —— 未获委派授权，不派子代理）

按 `brainstorming` 的 builder-check 口径逐条过了一遍，三类归置如下。

**已被本文或项目回答（补进文档）**
- 「几何/材质/渲染器怎么分文件」→ §5.1 已给表，并补 `nova-beam-config.js`（three-free，
  与 `water-reflect-config.js` / `sun-shade.js` 同手法，让 Tier 1 能直接断言观感常量）。
- 「纯函数吃 yaw 还是 aim」→ §8.1 第 3 条已改为 aim 基底，并写明理由（红线 1）。

**minor，我自己定（标注为我的决定）**
- 火花池容量 768：上游 sparks 5000 + motes 3600 是沙盒里连发十几个技能的量；本仓单槽、
  一次施法 ≤1.75s，768 足够且实例属性内存 < 40KB。**我的决定**。
- `renderOrder = 3`：紧接曳光 2，理由见 §6.1。**我的决定**。
- 蓄力环 r=18px / 环宽 3px：准心 20px，外径 48px 不压住准心笔画。**我的决定**。
- 十字 5 条而非 3×3 九条：§4.5 已给几何理由。**我的决定**。

**theirs（只有用户能答）→ 无**
三条会改变成品的口径（伤害/破坏/调参坞）已在 §1.1 由用户裁定；
方案 A 与三条附带裁定已批准。剩下的都是可逆的实现细节。

## 11. 留给实施者的自由度

- TSL 节点的具体组织方式（`Fn` 拆分粒度、varying 命名）。
- 火花 quad 的 billboard 实现细节（视图空间偏移 vs 世界空间基底）。
- 蓄力环的具体 SVG 结构与 CSS 过渡时长。
- 粒子发射率的微调（在「双色彩簇可区分」与「draw call 不超 9」两条硬判据内）。
- `NOVA_BEAM_FX.gain` 的最终标定值（由像素实测定，不预设）。