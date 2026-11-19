# Storm Lance 持剑蓄力大招 设计文档（v3.20）

> **本文档取代同日的 `2026-11-19-nova-beam-sword-charge-design.md`。**
> 用户 2026-11-19 实玩 Nova Beam 后裁定：「干脆改成 storm lance 算了，这个是最简单的特效。
> 你不要参照 nova beam 了。我们从最简单的开始实现。」
> 并追加四条要求（见 §1）。Nova Beam 的九个 pass 全部废弃。

## 1. 用户要求（逐条，全部是硬约束）

| # | 原话 | 落地口径 |
|---|---|---|
| R1 | 「按下一秒后开始启动蓄力，蓄力时间是一秒，这样从按下挥刀动作开始到最终发出招数就是 2 秒」 | 按下 → **立刻挥一刀**（零回归）→ 静默 **1.0s** → 蓄力 **1.0s** → 松手发射。静默期**不得有任何蓄力视觉**（用户：「不然我只需要挥刀的时候也会触发蓄力的动画，画面就太乱了」） |
| R2 | 「碰撞到 boss 身体要立即爆炸」「就在击中碰撞身体的位置爆炸，而不是穿过身体到 boss 身体后方的方块触碰处爆炸」 | `length` 截到**首个命中实体的表面**；落点 = 该表面点。方块遮挡只在**没有实体更近**时生效 |
| R3 | 「曳光效果丢了」 | 火花必须是**速度拉伸的条状**（上游 `ParticleShape.STREAK` + `stretch:true`），不是圆形羽化 quad |
| R4 | 「爆炸的体感视觉冲击力不强……好像火球击中地面后再往外冒爆米花一样软绵绵，这个是爆炸，要有冲击力，要有冲击波」 | 完整复刻上游 `BurstMode.STORM` + `DecalType.SHOCKWAVE`：噪声位移壳 + 疾走电弧 + `outQuint` 猛扩 + 冲击环 |
| R5 | 「蓄力的球也有点太大，改小点」 | 蓄力球半径显著小于 Nova Beam 的 0.39 |

### 沿用的既有裁定（不重新讨论）
- 每个实体**只扣一次** 50（= `EXPLOSION_DAMAGE`，派生不复制）；燃烧期不重复结算。
- **不破坏方块**、**不击退**（炸弹不击退）。
- **不做震屏 / 全屏闪白**（用户此前明确否决，上游有但本仓不移植）。
- **不做地面焦痕 / dust 贴花**（同上）。
- **音效零新增素材**；**不做调参坞**，只保留准心蓄力环。

## 2. 为什么 Storm Lance 更简单（实测对比，不是感觉）

Storm Lance = 上游 `src/abilities/ThunderAbility.js` + `materials/LightningMaterial.js`。

| 维度 | Nova Beam（已废弃） | Storm Lance |
|---|---|---|
| 柱身 pass 数 | 6（HALO/SHELL/CORE/COIL/RING/ORB） | **2**（GLOW/CORE，同一份 ribbon 几何画两遍） |
| 几何种类 | tube / coil / ring / orb 四种参数化 | **ribbon 一种**（`(t, side)` + `aStrand`） |
| 相位 | charge → travel → burn → fade（四拍） | travel → hold → fade（**三拍**） |
| 视觉总时长 | 1.773s | **1.179s**（24/105 + 0.45 + 0.5） |
| 噪声家族 | 平滑 Perlin（`mx_noise_float`） | **分段线性 value noise**（尖角是身份） |

⚠️ **噪声家族不可混用**（上游注释原文）：「the bolt's noise is piecewise-linear so it keeps
its corners; every noise term here is smooth … because a beam that kinks is a bolt」。
换成平滑噪声 ⇒ 闪电退化成「扭动的管子」。这是本特效的身份，单测钉住。

## 3. 上游数值（唯一来源，逐项抄自 `settings.thunder`）

```
range 24 / speed 105 / lifetime(hold) 0.45 / fadeTime 0.5
handHeight 1.28 / handForward 0.55 / handSide 0.16 / endHeight 0.35 / sag 0.22
strands 9 / spread 0.75 / spreadNear 0.05 / spreadCurve 1.6
twist 0.45 / twistSpeed 0.8 / branchDim 0.72
jitter 0.34 / jitterScale 0.85 / octaves 4 / jitterFalloff 0.55 / crawl 3.2
pinch 0.14 / converge 0.8
width 0.025 / widthTip 0.43 / widthCurve 1.09 / coreWidth 1.31 / coreSharp 4.95
glowWidth 5.7 / glowFalloff 2.4 / glowOpacity 0.49
restrike 24 / flicker 0.3 / flickerSpeed 34 / strandFlash 0.5
tipGlow 2.0 / tipLength 0.08 / glow 2.3 / opacity 1.0
colorCore #ffffff / colorInner #c9ecff / colorOuter #3aa0ff / colorHalo #0b3fc8
sparkRate 240 / sparkSize 0.16 / sparkSpeed 9.0 / sparkLifetime 0.5
sparkGravity -12.0 / sparkStretch 0.18
colorSparkA #ffffff / B #ffffff / C #c9ecff / D #1e5b95
muzzleSize 0.55 / muzzleIntensity 1.9
burstSize 3.0 / burstIntensity 1.4 / burstSparks 170
shockRadius 6.5 / colorShockA #c9ecff / colorShockB #ffffff
colorBurstA #3aa0ff / B #c9ecff / C #ffffff
```

### 本仓必须重标的三处（照抄会错）
1. **`toneMapped:false` 在 WebGPU 不存在**（`three.webgpu.js` 全文 0 次）⇒ 上游 `glow 2.3`
   会被 ACES 削白。统一增益 `gain` 由 Tier 4 像素实测标定。
2. **深度软相交不移植**：`viewportDepthTexture()` 会 `currentPass.end()` 重开 pass
   （`three.webgpu.js:86491`）⇒ 撞 v3.17 水面倒影时序红线。只用 `depthTest:true` 硬遮挡。
3. **手点/落点高度**：上游 `handHeight/endHeight` 是「离地板的绝对米数」（沙盒地板恒 y=0）。
   本仓地形起伏 ⇒ 必须改成**相对相机的偏移**（`handOffset`）与**沿轴线的落点**，
   否则在山上/洞里整条闪电会插进地里或飘在空中。

## 4. 玩法数值（唯一权威 = `weapon-catalog.js` 的 `stormLance`）

```js
stormLance: {
  chargeDelaySeconds: 1.0,   // R1：按下后的静默期（挥刀动画期内不蓄力）
  chargeSeconds: 1.0,        // R1：蓄力时长
  range: 24, speed: 105, holdSeconds: 0.45, fadeSeconds: 0.5,
  cooldown: 2.0,
  damage: EXPLOSION_DAMAGE,  // 50，派生
  radius: 0.75,              // = 上游 spread，命中截面半宽
  handOffset: [0.28, -0.22, 0.55],
  // 音效全部复用既有素材
  chargeSound:'emp_activated', readySound:'gun_load',
  fireSound:'dragon_fire', impactSound:'explosion',
}
```

**单槽前提（载荷性推导）**：视觉 `24/105 + 0.45 + 0.5 = 1.179s` <
最小施法间隔 `chargeDelay + charge = 2.0s` ⇒ 两道闪电不可能重叠 ⇒ 渲染器只需 1 槽。
抬 `range`/`holdSeconds` 必须同步改冷却或改多槽，单测用关系式钉住。

**DPS 核算**：50 伤害 / 4 秒一轮（2s 蓄 + 2s 冷却）= 12.5 DPS，远低于剑的 100 DPS。
它的价值是「安全距离的范围清场」，不是更强的单体输出。

## 5. 命中与爆炸位置（R2，本版最关键的行为改动）

### 现状缺陷
`novaBeamSweep` 的 `length` 取**轴线 DDA 距离**，实体命中只用于扣血 ⇒ 光柱穿过 Boss
身体、在它身后的方块上炸。用户实测报告的就是这条。

### 新口径
```
axisLength = min(range, 轴线方块 DDA 距离)
firstHit   = 五条射线全部命中里 dist 最小的那个
if (firstHit && firstHit.dist < axisLength)
    length = firstHit.dist          // ← 截到实体表面
    impact = 该命中点
    impactKind = 'entity'
else
    length = axisLength
    impactKind = 'block' | 'air'
```

⚠️ **必须取「五条射线的最小 dist」而不是「轴线那条的实体命中」**：Boss 体积大，
偏移射线常比轴线更早碰到它（守卫的盒随 yaw 旋转）。只查轴线会让「侧面擦到」仍穿身。

⚠️ **`impactKind` 决定冲击环朝向**：命中实体时冲击环**贴在命中点、法线朝玩家**
（读作「炸在它身上」）；命中地面时才贴地。共用一套会让打 Boss 时环画在脚下地面上。

### 伤害
仍走 `Game.damageEntity`（按类型分发到 zombie/dragon/ignis/guardian），
**不得用 `_damageEntitiesInRadius`**（只遍历丧尸，Boss 打不到）。
一次施法每实体只扣一次 —— 本函数只在 `pointerUp` 那帧调一次，天然不重复。

## 6. 渲染架构

### 6.1 文件
| 文件 | 职责 |
|---|---|
| `src/render/storm-lance-config.js` | 观感常量（three-free，玩法量从 catalog 派生） |
| `src/render/storm-lance-geometry.js` | ribbon `(t,side)`+`aStrand` / spark quad / burst icosphere / shock quad |
| `src/render/storm-lance-material.js` | 5 个 TSL 材质：GLOW / CORE / SPARK / BURST / SHOCK |
| `src/render/storm-lance-renderer.js` | 单槽相位机 + 火花池 + 爆壳/冲击环包络 |
| `src/player/weapons/storm-lance.js` | 纯函数：蓄力进度 / 轴线 / 五射线扫描（含 R2 截断） |

Nova Beam 的 4 个 render 模块 + `nova-beam.js` **删除**（同一 Epic 内未提交的产物，
不是他人工作）。`ui/nova-charge-ring.js` **保留并改名**为 `ui/charge-ring.js`（通用蓄力环）。

### 6.2 五个 pass
| pass | 几何 | 说明 |
|---|---|---|
| GLOW | ribbon ×9 inst | 宽 5.7×、`glowOpacity 0.49`，先画 |
| CORE | ribbon ×9 inst | 热丝本体，后画叠上去 |
| SPARK | quad ×768 inst | **速度拉伸条状**（R3） |
| BURST | Icosahedron | STORM 壳：噪声位移 + 电弧（R4） |
| SHOCK | Plane 2×2 | 冲击环（R4） |

全部 additive / `depthWrite:false` / `depthTest:true` / `DoubleSide` / `fog:false` /
`renderOrder 3` / `frustumCulled:false` / 空闲 `visible=false`。

### 6.3 闪电形状（三层叠加，逐字照 `LightningMaterial.js`）
1. **轴**：`mix(origin,target,t)` + `sag·sin(t·π)`。
2. **扇**：每条丝按 `aStrand` 在垂直面上取常量偏移，`spreadNear→spread` 随 `t^spreadCurve` 张开，
   并绕轴滚 `twist + twistSpeed·time`。
3. **kink**：5 个 octave 的**分段线性** value noise（`mix(hash(i),hash(i+1),fract(x))`，
   **不做 smoothstep**）。两端用 `pinch`/`converge` 钉直。

**restrike**：`floor(time·24)` 让全部丝每秒重新抽 24 次形状；`crawl` 在其间连续滑动。
两者缺一 ⇒ 保持期读作静态丝带。

### 6.4 火花 = STREAK（R3，用户报「曳光丢了」的根因）
上游 `ParticleSystem.js:461-467` 逐字：
```glsl
vec3 velView = (modelViewMatrix * vec4(vel,0)).xyz;
vec2 dir  = normalize(velView.xy + 1e-5);
vec2 perp = vec2(-dir.y, dir.x);
float stretch = 1.0 + uStretch * length(vel);
corner = dir*(position.y*size*stretch) + perp*(position.x*size);
```
轮廓（`:519-522`）：`core = 1−smoothstep(0,1,|c.x|·3.4)`，`len = 1−|c.y|`，`mask = core·len`。
⚠️ 我上一版用的是**圆形羽化 quad**（`ParticleShape.SOFT`）⇒ 读作爆米花。这是判别力所在。

### 6.5 爆炸 = STORM 壳（R4，用户报「软绵绵」的根因）
上游 `BurstSphere.js` STORM 分支逐字：
```glsl
fil   = ridged(vNormalW*(5+age*7) + seed*9 + vec3(0,time*3.4,0), 4);
arcs  = smoothstep(0.80,0.97,fil) * (1−age*0.6);
rim   = pow(fres,1.6);
color = mix(A,B,heat*0.5); color = mix(color,C,arcs);
color += C*rim*1.2 + C*arcs*2.4;
alpha *= (1−age)*(rim*0.55 + arcs*0.9);
```
顶点位移（`:44-51`）：`amount = displace*(0.35+age*0.9)`，`pos += normal*n*amount`。
扩张（`:304`）：`radius + (endRadius−radius)*outQuint(t)`，`scale=(s, s*squash, s)`。

⚠️ **`outQuint` 是冲击力的来源**：我上一版用 `outCubic` 且起始 0.18 ⇒ 慢胀。
`outQuint` 前 20% 就冲到 ~67% ⇒ 读作「炸开」。**这是载荷性差异，单测钉住曲线**。

⚠️ **`arcs` 阈值必须硬**（0.80~0.97）：上游注释「a wide band here fills the shell in
and it immediately reads as a rock」。放宽 ⇒ 实心球 ⇒ 又变回软绵绵。

### 6.6 冲击环（R4「要有冲击波」）
上游 `DecalType.SHOCKWAVE`：`radius 6.5 / life 0.6 / width 0.05`，环带随时间外扩。
本仓：`radius` 从 0 猛扩到 `shockRadius`，带宽 `width` 恒定（薄环），亮度 `1−inCubic`。
命中实体时环**朝向玩家**（见 §5），命中地面时贴地。

## 7. UI
蓄力环沿用 `#mc-nova-charge` 的 DOM 契约（改名 `#mc-charge-ring`）：
挂 `document.body`、z-index 50、`pointer-events:none`，**不得挂 `#crosshair`**
（`crosshair.spec` 钉死其 children 恰为 `['20x2','2x20']`）。
静默期（前 1s）环**不出现**（R1）。

## 8. 测试策略

### Tier 1（TDD，`src/tests/test-storm-lance.js`）
- 蓄力时序：0.99s 时 progress=0；1.0s 起开始爬；2.0s 满。
- **静默期零视觉**：`novaChargeProgress` 在 delay 内恒 0（R1 的判别力所在）。
- R2 截断：实体在 8 格、墙在 20 格 ⇒ `length=8`、`impactKind='entity'`。
- R2 负向：拆掉截断 ⇒ `length=20`（证明判据有判别力）。
- 偏移射线先命中：轴线无实体但偏移射线有 ⇒ 仍截断。
- kink 噪声**分段线性**：中点值 ≠ smoothstep 值（身份判据）。
- `outQuint` 曲线：t=0.2 时 >0.6（vs outCubic 0.488）。
- 单槽关系式：视觉总时长 < 最小施法间隔。
- 伤害派生：`cfg.damage === EXPLOSION_DAMAGE`。

### Tier 4（像素实测，`tests/storm-lance.spec.mjs`）
- 差分像素（同机位同地形，只差 fire），两侧先藏 `viewWeapon.node`。
- **条状判据（R3）**：火花簇的**长宽比** > 2（圆形 quad 恒 ~1）。
- **爆炸判据（R4）**：命中后 0.1s 内亮像素面积**猛增**（outQuint），且壳内存在
  暗区（arcs 是细弧不是实心）⇒ 钉「亮像素占比 < 0.9」防实心球。
- **R2 判据**：Boss 在 8 格时，爆炸亮簇的**深度**落在 8 格附近而非 20 格。
- draw call：空闲=基线 / 施放中增加 / 结束后回基线。
- 既有回归：sword / crosshair / water-order / player-flight / unit-fast 零回归。

## 9. 风险与预案
| 风险 | 预案 |
|---|---|
| 分段线性噪声在 TSL 里写不出尖角 | `mix(hash(floor(x)),hash(floor(x)+1),fract(x))` 逐字重建，单测钉中点值 |
| `hash` 的 TSL 版与上游 `hash11` 不同分布 | 自己用 `fract` 链重建 `hash11`，不用 vendor 的 `hash` |
| STREAK 在视图空间拉伸后出现 NaN | `normalize(velView.xy + 1e-5)` 保底（上游同写法） |
| 冲击环朝向实体时穿模 | 环沿命中法线偏移 0.02，且 `depthTest:true` |

## 10. 自由度（实施时可自行决定，不必再问）
- 具体 varying 命名、模块内函数拆分、注释措辞。
- `gain` 的具体数值（由像素实测标定）。
- 蓄力球半径的具体值（只要显著小于 0.39 且像素可见）。
## 11. v3.20b 蓄力球朦胧化（用户实玩反馈）

用户原话：「蓄力时的光球，边界太清晰，就有点像一个发光的鸡蛋，我希望这个光球边界不要那么清晰，
要朦胧一些，可以让这个光球再小一点，然后让他发出光，有一层光晕覆盖在光球上」。

### 「发光鸡蛋」的三个可定位成因（旧实现三个都中了）
| 成因 | 旧值 | 新值 | 为什么 |
|---|---|---|---|
| 基础 alpha 让整球不透明 | 0.2 | **0.04** | 实心 ⇒ 读作蛋 |
| rim 把轮廓边提得比中心亮 | 0.9 | **0.18** | 那就是一条亮硬边 |
| 噪声沿法线位移 | 0.24 | **0.08** | 把球捏成凹凸蛋形 |
| 核心半径 | 0.20 | **0.13** | 用户「再小一点」 |

并新增**中心热区** `pow(facing, 2.6)`（权重 0.5）把亮度从轮廓搬到中心 ——
发光体应当中心最亮、向外连续衰减。

### ⚠️⚠️ 但光靠调参数消不掉硬边
**闭合网格（球）的几何轮廓是硬截断**：轮廓内 alpha>0、轮廓外根本没有片元。
正解是新增第七个 pass：**屏幕对齐的 billboard quad 光晕**（`makeHaloPass`）——
半径归一到 [0,1]，alpha 按 `pow(1−r, 2.4)` **连续衰减到 0**，且 quad 比可见光晕大一圈
⇒ 几何边界落在完全透明处，看不见。叠三层：径向衰减 + 噪声侵蚀边缘（否则是完美圆盘）
+ 内圈热核外圈冷色。光晕尺度 = 核心 × **3.4**，呼吸相位与核心错开（×0.7 频率，
同相呼吸会让两层读作一个硬物体）。

### 判据（Tier 4，`tests/storm-lance.spec.mjs`）

**外缘梯度绝对值**（`edgeSharpness`）：先用增量阈值圈出亮区，只在「自己亮、四邻有不亮」
的**交界像素**上取中心差分梯度，取均值。硬边 ⇒ 外缘梯度大；柔和衰减 ⇒ 小。

实测（1280×720 / seed 12345 / 开阔地 / shadows=0 / reflect=0，三轮）：
| 态 | edgeGrad | litCount |
|---|---|---|
| 柔和（本版） | **86.9 / 91.5 / 110.4** | 4.9~7.3 万 |
| 旧「发光鸡蛋」（负向） | **173.3 / 184.4 / 169.9** | 12~13.6 万 |

阈值 **140**，两侧都有余量；6/6 绿（正向×3 + 负向×3）。

### ⚠️⚠️ 判据选型走了三次弯路（全部实测推翻，记下来避免重犯）

1. **径向剖面 + 找最亮像素定中心** —— 吸入粒子亮度与光球同量级，会把原点抢走。
   同一实现两轮 tailRatio 0.130/0.164，退化实现 0.190/**0.019**，**方向都反了**。
2. **径向剖面 + 相机投影定中心** —— 相机每帧被 viewBob 重写（`player.js:380`），
   而手点是 `setCharge` 那帧算的 ⇒ 截图后读到的是**新姿态配旧手点**，
   实测偏 **59px/96px**（峰值 700→197，量到了别处）。⚠️ 不是 pixelRatio 问题（实测=1）。
3. **整场梯度分位数** —— 光晕直径实测约 **454px**（占屏高 63%），内部平缓区样本远多于
   边界带 ⇒ 分位数被内部主导，柔和 0.098~0.139 与退化 0.096~0.143 **完全重叠**。

**两条通用教训**：
- **凡以「最亮点」或「投影」为原点的统计量，先问它稳不稳**；能不用中心就不用。
- **比值判据要当心分母漂移**：`edgeGrad/peak` 里 peak 随呼吸在 372~709 摆，
  柔和态第二轮比值 0.235 与旧鸡蛋 0.234 撞车 ⇒ 改用**绝对梯度**才稳定分离。

### ⚠️ 负向对照必须还原「用户真正看到的旧参数」
首版只藏光晕层 ⇒ 剩下的核心**也已被软化**（baseAlpha 0.04 / rim 0.18 / turbulence 0.08）
⇒ 与正向重叠，复现不出「发光鸡蛋」。正解：`page.route` 换 config 模块，
把 orbSize/orbTurbulence/orbBaseAlpha/orbRimAlpha 还原成 0.20/0.24/0.2/0.9 并关掉光晕。
⚠️ 常量编译进 shader ⇒ 浏览器侧改 FX 对象无效，必须换模块内容。

## 12. v3.20c 光晕改照火球手法（用户第三次反馈）

用户原话：「蓄力球是调小了，但是**你没加上光晕，边界依然很清晰**，你看看祭坛飞龙吐的火球的
外围一圈光晕是怎么加的，就那样加就行，**很简单，不要搞得太复杂**」。

### 我上一版错在哪
自己写了一个 TSL 噪声光晕 pass（径向衰减指数 + 噪声侵蚀 + 内热外冷三层，7 个常量）。
它**在画面上没读出来** —— 用户看到的仍是清晰边界。外缘梯度实测 87~110，
虽然比旧鸡蛋（170~184）低，但离「柔和」还差得远。

### 火球的做法（`fireball-renderer.js:57`，极简）
```
canvas.createRadialGradient(中心, 0 → 半径)
  0.0  rgba(255,244,214, 1.0)   白热中心
  0.3  rgba(255,166, 64, 0.85)  炽橙
  0.65 rgba(255, 96, 20, 0.32)  暗橙外圈
  1.0  rgba(255, 60,  0, 0.0)   ← 边缘 alpha 0，柔和边的全部来源
→ CanvasTexture → MeshBasicMaterial{map, additive, depthWrite:false, DoubleSide}
→ PlaneGeometry + billboard（每帧写 camera.quaternion）
```
**零 shader**。边缘柔和来自渐变本身，不需要衰减指数/噪声去调。

### 本版实现
- `makeStormHaloTexture()`：同结构，配色换冷蓝白（白 → `#c9ecff` → `#3aa0ff` → `#0b3fc8` alpha 0）。
- `MeshBasicMaterial` + `PlaneGeometry(1,1)`，尺寸由 `setCharge` 按 `orbSize × orbHaloScale` 缩放。
- `orbHaloScale` **直接等于 `FIREBALL_HALO_SCALE`（3.4）**，单测只钉 >1.5。
- billboard：`setCharge(..., cameraQuat)` 由装配层传 `this.camera.quaternion`
  （照 `fireballRenderer.sync(entities, camera.quaternion, nowMs)` 的分工，渲染器不持有相机）。
- `haloTexture` 可注入（单测传 `DataTexture` 免 canvas，照 FireballRenderer 同手法）。
- **删除**：`makeHaloPass` / `createHaloGeometry` / 5 个 shader 光晕常量 / `orbHaloOpacity`。

### 实测（外缘梯度绝对值，两轮）
| 态 | edgeGrad |
|---|---|
| v3.20b 自写 shader 光晕 | 87~110 |
| **v3.20c 火球式渐变贴图** | **11.6 / 12.5** |
| 旧「发光鸡蛋」（负向） | **193 / 194** |

柔和度提升约 **8 倍**，与退化态相差 **16 倍**。阈值按新实测重标为 **60**
（柔和侧 5 倍余量、退化侧 3 倍余量）。

### 教训
**先看仓库里有没有现成的同类实现，再决定要不要自己写。** 火球光晕已经在仓库里跑了很多版、
被像素判据守过；我却从零写了一个更复杂的 shader，结果观感更差。
用户「不要搞得太复杂」是对的 —— 简单方案不只是省事，它这里是**更有效**的那个。
