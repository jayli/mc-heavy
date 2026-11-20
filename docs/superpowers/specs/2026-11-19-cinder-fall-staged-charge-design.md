# Cinder Fall 分段蓄力（第三秒大招）设计文档（v3.21）

> **前置**：v3.20 Storm Lance 已交付（`2026-11-19-storm-lance-sword-charge-design.md`）。
> 本文档**不取代**它 —— Storm Lance 的观感、命中口径、单槽推导全部沿用；本次只在它上面
> **加一个第三秒阶段**，并把该阶段的招式实现为 Cinder Fall（扔出去的燃烧岩石）。

## 1. 用户要求（逐条，全部是硬约束）

原话（2026-11-19）：

> 「我刚刚引入了 storm lance 的攻击动作，现在我要引入一个新的攻击动作，按住三秒的时候发出，
> 即按住第一秒时只计时不蓄力，按到第二秒时松开是发送 storm lance 动作，按到第三秒时发出时，
> 执行 cinder fall 的攻击动作，蓄力球跟 storm lance 一样，也就是说，蓄力的动作是完全一样的，
> 不同阶段发出的攻击动作不同。」
>
> 「请注意，扔出去的球只要碰到实体方块（和 storm lance 一样）或者碰到丧尸或者 boss 都爆炸。」

| # | 要求 | 落地口径 |
|---|---|---|
| **R1** | 第一秒只计时不蓄力 | 沿用 v3.20 的 `chargeDelaySeconds = 1.0`，**一行不改** |
| **R2** | 第二秒松手 → Storm Lance | 进入第二秒即可发（**不必蓄满**，用户已裁定，见 §2） |
| **R3** | 第三秒松手 → Cinder Fall | 进入第三秒即可发；第三秒是**第二段蓄力** |
| **R4** | 蓄力动作完全一样 | **蓄力球 / 光晕 / 吸入粒子 / 起手音全部共用同一套**，不新增第二套蓄力视觉 |
| **R5** | 扔出去的球碰到实体方块或丧尸或 Boss 都爆炸 | 岩石是**飞行实体**，逐步判定：方块 DDA（只看 solid）+ 实体 AABB 射线；命中即在该点炸 |

### 沿用的既有裁定（不重新讨论）
- 伤害派生自 `EXPLOSION_DAMAGE`（50），**每个实体一次施法只扣一次**。
- **不破坏方块**、**不击退**（炸弹不击退）。
- **不震屏 / 不全屏闪白**（用户此前明确否决，上游 `impactShake` / `impactFlash` 不移植）。
- **不做地面焦痕 / 熔岩裂缝贴花**（同上）。
- **音效零新增素材**；不做调参坞，只有准心蓄力环。
- 短按（<1s）仍是普通挥剑，零回归。

## 2. 阶段门：用户已裁定「进入那一秒就能发」

两种读法都合理，用户 2026-11-19 明确选了第一种：

| 读法 | 行为 | 取舍 |
|---|---|---|
| **A（取）进入即发** | 1~2s 松手 → Storm Lance；≥2s 松手 → Cinder Fall | Storm Lance 最快 1 秒就能发（今天必须蓄满 2s），光球刚冒头就松手也会发出去 |
| B（弃）蓄满才发 | 2s 蓄满才发 Storm Lance；3s 蓄满第二段才发 Cinder Fall | 「必须蓄满」的既有手感不动，但要按满 3 秒才拿得到 Cinder Fall |

**时间轴（A）**：

```
按下 ──── 1.0s ────────── 2.0s ────────── 3.0s ───→
 │挥一刀   │ 静默期        │ 第二段        │ 第二段满
 │        │ 零蓄力视觉    │ 蓄力(冷蓝)    │ 蓄力(暖橙)
 └ 松手=普通挥剑          └ 松手=Storm    └ 松手=Cinder
                            Lance           Fall
```

⚠️ **第二段在 3.0s 蓄满后不再增长**（`p2` 钳在 1）。继续按住不自动发射 —— 与 Storm Lance
同口径（必须松手）。

### 2.1 ⚠️ 阶段判定必须复用 controller 已有的「跨越标志」，不能对浮点时间取边界

**这是 builder check 抓到的真缺陷，不是理论风险。** 既有 controller 推进蓄力用的是
`was <= delay && now > delay`（起手）与 `was < full && now >= full`（蓄满）—— 这两个
**跨越标志**对 dt 累积的浮点误差免疫。若新写的 `chargeStageAt(elapsed)` 直接写
`elapsed >= 2.0`，则 `hold(f, 2.0)`（40 × 0.05 累加）可能得到 `1.9999999999999998`
⇒ 判成 `'lance'` ⇒ **既有 6 个单测 + 全部 spec（`HOLD_MS = 2100` 侥幸避开，但 2.0 的单测会红）**
出现与机器相关的 flaky。

**正解（唯一权威仍在 controller 的跨越标志）**：

```js
// 纯函数：只描述「已进入第几段」，边界判定由调用方用跨越标志喂进来
chargeStageAt(elapsed, cfg)   // 供 UI / 诊断用，内部对边界取 1e-9 容差
```

controller 侧新增 `this._cinderStartFired`（照 `_novaStartFired` 同手法），
`pointerUp` 判 stage 时**优先读标志**：`_cinderStartFired ? 'cinder' : (_novaStartFired ? 'lance' : 'none')`。
纯函数 `chargeStageAt` 保留给 UI 与单测，内部用 `elapsed + 1e-9 >= 边界` 消除累积误差。

⚠️ **两者必须一致**：单测钉「`hold(f, 2.0)` 后 controller 判 cinder，且
`chargeStageAt(2.0)` 也判 cinder」。**不得只改一侧**。

### 2.2 进度与阶段的语义差别（刻意不同，不要「统一」）

`stormChargeProgress(1.0) === 0`（刚到边界还没蓄）而 `chargeStageAt(1.0) === 'lance'`
（已进入该秒）。**两者语义不同**：进度是「蓄了多少」，阶段是「松手发哪招」。
单测分别钉住，不得为了「看起来一致」把其中一个改成闭区间另一侧。

## 3. 为什么 Cinder Fall 要重做成飞行实体（上游不能照搬）

Cinder Fall = 上游 `~/jaylli/LinearAbiltyCastingThreeJS` 的
`src/abilities/MeteorAbility.js` + `src/materials/MeteorMaterial.js`（`ELEMENT_META.meteor.label`）。

### 3.1 三个方案（用户已批 A）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（取）飞行实体 + 复用既有特效层** | 注册临时实体 `cinder`，照飞龙火球 / 炮塔弹丸的既有分工推进与判定 | 与 R5 天然一致；判定口径复用两份已被测试守过的实现；零新管线 |
| B（弃）照搬上游闭式弧线 | `_arcPoint(s)` 在发射时定死 `s=1` 落点 | **与 R5 直接冲突**：上游落点是发射时算好的，飞过去才知道撞没撞 ⇒ 得再叠一套判定 = 两份权威（红线 1） |
| C（弃）体积火焰 raymarch + 熔岩裂缝 | `VolumetricFireMaterial`(833 行, 35 步/像素) + `GroundFissures`(612 行) | 帧预算与移植量都不成比例；且用户既有裁定是「从最简单的开始」 |

### 3.2 只移植身份三件

| 上游部件 | 本仓 | 理由 |
|---|---|---|
| 程序化岩石（icosphere + 切面 + 陨坑 + 熔岩缝） | **保留形状**：icosphere + 低频噪声位移 + 熔岩缝发光 | 这是「燃烧的石头」的身份 |
| 火焰拖尾（raymarch 体积） | **换成火球式光晕贴图 + 余烬火花** | 用户已裁定光晕照火球手法（v3.20c），零 shader |
| 落点 FIRE 爆壳 + SHOCKWAVE 环 | **复用 Storm Lance 的爆壳/冲击环几何与材质结构**，换暖色 | 已有 outQuint 猛扩 + 硬阈值电弧，被像素判据守过 |
| 碎块（chunk）| **复用 `block-hit-fx` 碎块池**（`spawnDeathBurst` 同手法） | 红线：不新开第二个碎块池 |
| 熔岩裂缝 / 焦痕 / 动态光 / 震屏闪白 / 4 套粒子 | **不做** | §1 既有裁定 |

## 4. 玩法数值（唯一权威 = `weapon-catalog.js` 的 `sword.cinderFall`）

```js
cinderFall: {
  chargeSeconds: 1.0,        // 第二段时长（第三秒）；第一段沿用 stormLance
  range: 20,                 // 上游 meteor.range
  speed: 18,                 // 上游 21，本仓略降（地形起伏 + 判定步长）
  arc: 1.5,                  // 中段拱起（格）—— 上游 2.6 是平地沙盒，本仓地形起伏取小
  arcCurve: 0.85,            // 上游 arcCurve
  radius: 0.5,               // 岩石半径 = 命中盒半边长（上游 0.8，本仓略小）
  spin: 3.4,                 // 上游 spin（自旋，rad/s）
  cooldown: 3.0,             // 推导见 §4.1
  damage: EXPLOSION_DAMAGE,             // 50，派生不复制
  blastRadius: EXPLOSION_DAMAGE_RADIUS, // 4，派生不复制
  poolSize: 4,               // 岩石渲染池容量（推导见 §7.3）
  debrisCount: 18,           // 落点碎块（上游 chunkCount 18；池账见 §7.2）
  handOffset: [0.28, -0.22, 0.55],       // 与 stormLance 同一手点
  chargeSound: 'emp_activated', chargeVolume: 0.3,
  readySound: 'gun_load', readyVolume: 0.4,
  fireSound: 'dragon_fire', fireVolume: 0.5,
  impactSound: 'explosion', impactVolume: 0.4,
}
```

### 4.1 `cooldown = 3.0` 是推导出来的（沿用 Storm Lance 的单槽关系式）

```
飞行时间   = range / speed = 20 / 18 = 1.111s
落点余烬   = 1.5s（碎块寿命 IMPACT_FX.debris.lifeMs 620ms，取保守 1.5s）
⇒ 单次施放最长视觉 ≈ 1.111 + 1.5 = 2.611s
最小施法间隔 = chargeDelay(1.0) + charge(1.0) + charge2(1.0) = 3.0s
3.0 > 2.611 ⇒ 落点特效单槽成立
```

⚠️ **这条推导是载荷性的**：抬 `range` / 降 `speed` / 抬余烬寿命都必须同步抬冷却或改多槽。
单测用关系式钉住（照 `test-storm-lance.js` 的既有写法）。

### 4.2 DPS 与定位

50 伤害 / (3s 蓄 + 3s 冷却) = 8.3 DPS 单体，但**半径 4 格内全部实体各扣 50** ⇒ 它是
「范围清场」，Storm Lance 是「直线穿透多个」，剑是「贴身单体 100 DPS」。三者不重叠。

## 5. 蓄力：共用一套视觉，只加一个进度

### 5.1 纯函数（`player/weapons/storm-lance.js` 追加，不新建模块）

```js
stormChargeProgress(elapsed, cfg)   // 既有，一行不改
cinderChargeProgress(elapsed, cfg)  // 新增：第二段，前 delay+charge 恒 0
chargeStageAt(elapsed, cfg)         // 新增：'none' | 'lance' | 'cinder'（含 1e-9 容差）
```

**`chargeStageAt` 真值表**（单测逐格钉）：`<1.0 → none`；`[1.0, 2.0) → lance`；`≥2.0 → cinder`。

### 5.2 渲染：同一个球，换色不换形

`StormLanceRenderer.setCharge(progress, origin, side, nowMs, cameraQuat, warm)`
追加第六参 `warm`（0=冷蓝 1=暖橙，缺省 0 ⇒ 既有调用逐位不变）：

- 第二段时装配层传 `progress = cinderChargeProgress(...)`、`warm = 1`；
- 球的**尺寸/呼吸/湍流/吸入粒子全部不变**（R4）；
- 只有配色 lerp 到暖橙白（新增 `uWarm` uniform，orb pass 与光晕贴图各一份）。

⚠️ **光晕是贴图不是 shader**（v3.20c）⇒ 换色要**第二张渐变贴图**（暖橙版），
按 `warm` 切 `haloMaterial.map`。**不新建第二个 mesh**（两个 mesh 必然漂移）。

⚠️ **`_charge` 不得被第二段归零**：`setCharge` 里 `p<=0` 会隐藏球。第二段起步时
`cinderChargeProgress` 恰好是 0 ⇒ 必须传 **`max(p1, p2)`** 作为尺寸进度，
否则第三秒开始的瞬间球会**闪断一下**（静默观感缺陷，数值判据拓不到）。

### 5.3 蓄力环：第二圈

`ChargeRing.update(progress, warm)` 追加第二参：
- `warm=1` 时主环满格 + **第二条弧**（r=22）从 0 扫到满，颜色暖橙 `#ff8a3c`（上游 meteor accent）；
- 主环仍在（读作「第一段已满」）。
- ⚠️ **z-index 仍 50、仍挂 `document.body`**（`crosshair.spec` 钉死准心只有两笔）。

## 6. 飞行与命中（R5 的核心）

### 6.1 实体：`src/entities/cinder/cinder-system.js`（新建，同构层）

照 `dragons/fireball-system.js` 逐条对应，**四处刻意不同**：

| 维度 | 飞龙火球 | Cinder |
|---|---|---|
| 轨迹 | 直线 | **抛物线**（`arc` 拱起） |
| 命中对象 | 玩家（注入盒直调 slab） | **丧尸 + 三种 Boss**（走 `entities.raycastAll`） |
| 爆炸语义 | `_applyExplosion`（破坏方块） | **只扣血 + 视觉**，不写方块 |
| 遮挡判据 | `solidTable`（玻璃树叶都挡） | **同口径**（用户「和 storm lance 一样」） |

⚠️ **实体命中必须走 `entities.raycastAll`**，不得手工注入盒：`fireball-system.js`
文件头已写明这条边界（玩家不是 EntityManager 成员才例外；丧尸/Boss **是**成员）。

⚠️ **判定线段必须是本步实际穿越的那段**：`from = 步后 position − 本步位移`。
抛物线下位移方向每步都变，故 state 要存 **`prevPosition`**（上一步位置），
判定用 `from = prevPosition`、`dir = normalize(position − prevPosition)`、`stepLen = |位移|`。
**不能用「position − velocity×dt」**（那是直线弹丸的口径，抛物线下会算出错误的线段）。

⚠️ **必须返回全新 state + 全新数组**（M5 不变式）：原地改写会让 `EntityManager` 的
跨 column 索引迁移判据恒相等 ⇒ column 卸载漏回收。

### 6.2 抛物线口径（末端仍落在准心瞄准点）

```
水平：从 origin 沿 aim.forward 的水平分量推进，总水平距离 = 瞄准点水平距离
竖直：y(t) = lerp(y0, yTarget, t) + arc · sin(t·π)^arcCurve
t = 已飞行水平距离 / 总水平距离
```

⚠️ **不用上游的 `handHeight`/`endHeight`**（那是离地板的绝对米数，本仓地形起伏）——
与 Storm Lance 同一条教训。`origin` 走 `handOffset`（相对相机），`yTarget` 取瞄准点。

⚠️ **仰视/俯视时抛物线仍要成立**：竖直项是**叠加在 origin→target 直线上的拱起**，
不是「先抛后落」的独立弹道 ⇒ 朝天上扔时它照样飞向准心，只是中段更高。

⚠️ **水平距离为 0（垂直朝上/下）时退化**：`t` 分母为 0 ⇒ 必须回落到「沿 forward 直线飞」，
不抛异常（缺陷形态是静默画错，不是崩溃）。

### 6.3 判定顺序（顺序载荷性）

```
① 方块 DDA（solidTable）→ 在该格爆炸
② 实体 raycastAll（WEAPON_HITTABLE_TYPES）→ 在命中点爆炸
③ 掉出世界底 / 下落超时 → `void`，**静默消失不爆**（防实体泄漏）
```

⚠️ `raycastVoxel` 未命中返回 `{hit:false}`（truthy），必须判 `.hit`。

#### 6.3.2 爆炸中心 = **表面接触点**（用户 2026-11-19 第二条裁定）

用户原话：「火球抛物线**触碰到方块表面就爆炸**，而不是跑到方块内部爆炸，
或者触碰到 boss 或者丧尸**接触的时候**就爆炸」。

旧口径：`judgeCinder` 返回 `blockPos`（**格坐标**），装配层 `_cinderBlast` 再 `+0.5`
⇒ 爆心落在**块心**。浏览器实测 `centerInsideSolid: true`，离顶面 0.5 格
（爆壳/冲击环/碎块全在实心内部，读作「钻进地里炸」）。

新口径：**`at` 统一为世界坐标的表面接触点**（block 与 entity 同一口径），
装配层**不得再 `+0.5`**；另回 `normal`（命中面法线）供冲击环定向。

⚠️⚠️ **DDA 的 `dist` 分两种情形，只取 `from+dir×dist` 不够**（实测）：

| 情形 | DDA 返回 | 做法 |
|---|---|---|
| 起点在**空气**里 | `dist` 精确（纯−Z 射线得 z=−5.000000）、`normal` 有效 | 直接用 |
| 起点已在**实心**内 | 恒 `dist=0`、`normal=[0,0,0]` | 沿−dir 粗退找首个空气点 → 二分逐近表面 |

⚠️ **只要 `from` 在实心内，DDA 必返 `dist=0`**（它先查起点格）—— 探针实测确认。
故「刚跨进一格」与「穿坡时已埋在土里」是**同一条分支**（曾为此写第三条分支，
探针证明不可达 ⇒ 已删，不留死代码）。

⚠️⚠️ **回退不能只退到「命中格的最近边界」**（浏览器实测拓到）：穿坡时命中格
六个面全是实心（`outwardSolid=true` 且 `inwardSolid=true`），退到那个面**仍在土里**。
必须退到真正露天的那一面；判据 = **沿法线往外 1e-3 必须是空气**。

冲击环朝向改为按 `normal` 贴**命中面**（地面/墙面/天花板），不再恒贴地
（撞墙时恒贴地会把环画进墙里）。

#### 6.3.1 飞满瞄准点后转重力下落（用户 2026-11-19 裁定）

用户原话：「**cinder fall 的火球要求碰到地面才爆炸，而不是空中爆炸**」。

两版错误口径都已被实测否定，**正解是同一个**：

| 口径 | 形态 | 实测 |
|---|---|---|
| 超距静默消失（照搬直线弹丸） | 朝地面扔时「球飞到了但没炸」 | t≈150ms despawn 而 blasts=0 |
| 末端自爆 `end-of-flight` | **空中爆炸** | 离地 4.76 格（平视）/ 10.39 格（仰视）|
| **转重力下落（现行）** | 落地给 `block` | 三个机位 airGap 均 **−1**（= 落在顶部实心格内）|

实现：`update` 在 `traveled` 触顶时置 `falling`，交接速度取**弹道末端真实切向**
（数值微分 × `speed/distance`）⇒ 位置与速度都连续，不会「顿一下再垂直掉」；
之后纯重力积分（`fallGravity: 24`，梯形积分）。**判定器零特例** —— 落地自然就是 ①。

⚠️ `fallGravity` **不得复用 `DEBRIS_GRAVITY=18`**（枪击/死亡爆散/砸击共享的观感常量）。
⚠️ 兜底回收必需：未加载列 `getBlockId` 恒 0 ⇒ 岩石会一路掉穿，不回收就是实体泄漏
（池只 4 slot，满后新岩石静默生成失败）。

### 6.4 爆炸伤害（装配层 `Game._cinderBlast`）

```
直接命中者（若有）             → damageEntity(id, 50)
落点半径 blastRadius(4) 内实体 → damageEntity(id, 50)，**去重**（直接命中者不重复扣）
```

⚠️ **必须走 `damageEntity`，不得用 `_damageEntitiesInRadius`**：后者只遍历丧尸，
Boss 打不到（用户明确要 Boss 也掉血）。这条与 Storm Lance 同源。

**半径查询**：枚举 `entities.entities()` + `WEAPON_HITTABLE_TYPES` 过滤，
中心 y = `state.position[1] + 该类型高度/2`。高度按类型分发读各 config
（`ZOMBIE.height` / `DRAGON` / `IGNIS.height` / `GUARDIAN.height`）——
与 `damageEntity` 同一手法（装配层按类型分发），**不是第二份权威**。

⚠️ **不破坏方块、不击退、不走 `_applyExplosion`**（后者会破坏方块 + 引爆连锁 TNT）。

## 7. 渲染架构

### 7.1 文件

| 文件 | 职责 | 新建/改动 |
|---|---|---|
| `src/player/weapons/cinder-fall.js` | 弹道与命中纯函数（three-free / DOM-free） | 新建 |
| `src/entities/cinder/cinder-system.js` | 实体 definition + judge（同构层） | 新建 |
| `src/render/cinder-fall-config.js` | 观感常量（three-free，玩法量从 catalog 派生） | 新建 |
| `src/render/cinder-fall-renderer.js` | 岩石 + 火焰光晕 + 落点爆壳/冲击环 | 新建 |
| `src/player/weapons/storm-lance.js` | 追加 `cinderChargeProgress` / `chargeStageAt` | 改动 |
| `src/player/weapons/weapon-catalog.js` | 追加 `sword.cinderFall` | 改动 |
| `src/player/weapons/weapon-controller.js` | `pointerUp` 按 stage 分流 + `_cinderStartFired` | 改动 |
| `src/render/storm-lance-renderer.js` | `setCharge` 追加 warm（换色 + 第二张光晕贴图） | 改动 |
| `src/render/storm-lance-material.js` | orb pass 追加 `uWarm` | 改动 |
| `src/ui/charge-ring.js` | `update` 追加 warm（第二圈） | 改动 |
| `src/core/game.js` | 注册实体 / 判定 / 伤害 / 装配 / 倒影 hidden | 改动 |
| `src/player/player.js` | `_applyWeaponEffect` 分流 `cinder-fall` 事件 | 改动 |
| `src/core/perf-hud.js` | 操作说明行文案（**行宽必须实测 < 310px**） | 改动 |

### 7.2 渲染 pass（4 个 mesh，全部池化）

| pass | 几何 | 说明 |
|---|---|---|
| ROCK | IcosahedronGeometry(1,2) ×4 inst | 噪声位移 + 熔岩缝（TSL），随飞行自旋 |
| HALO | PlaneGeometry ×4 inst | **火球式径向渐变贴图** billboard（暖橙），零 shader |
| BURST | Icosahedron ×1 | 落点爆壳，复用 Storm Lance 的 STORM 结构换暖色 |
| SHOCK | Plane 2×2 ×1 | 冲击环，同上 |

余烬碎块**复用 `block-hit-fx` 碎块池**（`spawnDeathBurst` 同手法，暖色）。

⚠️ **碎块池账**（池容量 128）：Cinder 18 + 焰魔死亡 32 + 焰魔砸击 42 = **92 ≤ 128** ✓。
抬 `debrisCount` 必须重算这笔账（超池会 FIFO 绕回，观感「只炸出半边」，静默）。

⚠️ 全部 `fog:false` / `depthWrite:false`（岩石除外）/ `DoubleSide` / additive（岩石除外）/
`renderOrder 3` / `frustumCulled:false` / **空闲 `visible=false`**。

⚠️ **TSL 常量色必须显式拆分量 `vec3(c.r,c.g,c.b)`**（`vec3(Color)` 在 WebGPU 输出纯黑且零报错）。

### 7.3 池容量 `poolSize = 4` 的推导

冷却 3.0s、单发最长飞行 1.111s ⇒ 理论上同时最多 1 发在飞。取 4 是 **4 倍余量**
（照 `FIREBALL.poolSize = 16` 对理论峰值 4~5 的 3 倍余量手法）——
装不下时渲染器回收最早 slot，形态是「岩石半路消失」（静默），故留足。

落点爆壳/冲击环沿用**单槽**（§4.1 关系式）。

## 8. 测试策略

### 8.1 ⚠️ 既有测试会因新语义而红 —— 按新语义改写，不放宽

**builder check 实测清单**（`hold(f, 2.0)` 在 A 口径下变成 cinder）：

| 既有用例 | 现状 | 改法 |
|---|---|---|
| `storm ctrl: 按住 2s 松开恰好一个 storm-lance…` | `hold 2.0` → 期待 lance | 改 `hold 1.5`（**真意图是「第二秒松手发 lance」**） |
| `storm ctrl: 每个实体只扣一次 50…` | `hold 2.0` | 改 `hold 1.5` |
| `storm ctrl: 冷却未到期不得再施法` | `hold 2.0` ×2 | 改 `hold 1.5` ×2 |
| `storm ctrl: pointerUp() 无 aim…` | `hold 2.0` | 改 `hold 1.5`，并**加断言 cinder 也不得施放** |
| `storm ctrl: 未注入 sweepLance 仍发视觉…` | `hold 2.0` | 改 `hold 1.5` |
| `storm ctrl: 三种新事件的 recoil 恒 0` | `hold 2.0` | 改 `hold 1.5`，并把 `cinder-fall` 加进类型清单 |
| `storm ctrl: 蓄满不松开不施法` | `hold 4.0` 断言 `novaCharged` | 保留，**加断言 cinder 也不自动发** |
| `storm ctrl: 起手/蓄满音各只一次` | `hold 5.0` | 保留，**加 cinder 起手/蓄满音各一次** |
| `tests/storm-lance.spec.mjs` 全部 | `HOLD_MS = 2100` | 改 **1500**（第二秒内），否则全部打到 cinder 上 |

⚠️ **`tests/storm-lance.spec.mjs` 的 `chargeOnly`（蓄力球两组像素用例）例外**：
它要的是「满蓄力态」，`HOLD_MS` 改成 1500 后 `state.charge` 会是 0.5 而不是 1 ⇒
该夹具**单独传 2100 并断言 `warm=1`**（第三秒的球，形状与第一段相同）。
⚠️ 它的 `edgeGrad < 60` 阈值**必须重新实测**（暖色贴图的梯度与冷蓝不同）。

### 8.2 Tier 1（TDD，先 RED 后 GREEN）

**`src/tests/test-storm-lance.js` 追加**：
- `chargeStageAt` 真值表逐格（0 / 0.99 / 1.0 / 1.99 / 2.0 / 3.0 / 10）
- `cinderChargeProgress`：2.0s 时 0；2.5s 时 0.5；3.0s 时 1；超过钳 1
- **第一段不受影响**（负向：`stormChargeProgress` 在既有 7 个采样点逐位不变）
- **浮点边界**：`hold(f, 2.0)`（40×0.05 累加）后 controller 与纯函数**都**判 cinder
- controller：1.5s 松手发 `storm-lance`、2.5s 松手发 `cinder-fall`、0.5s 松手只挥剑
- controller：冷却未到期不得施放；切武器丢弃两段蓄力
- controller：`cinder-fall` 事件 `recoil === 0`、`impacts` 为空

**`src/tests/test-cinder-fall.js` 新建**：
- 抛物线末端 = 瞄准点（水平与竖直都要，容差 1e-6）
- 中段拱起 > 0 且 ≈ `arc`（t=0.5 时）
- 仰视 45° 时末端仍落在瞄准点（不是「先抛后落」）
- 垂直朝上（水平距离 0）不抛异常，退化成直线
- 方块命中：墙在 10 格 ⇒ 在墙格炸；**玻璃也挡**（判别性用例，与火球同口径）
- 实体命中：丧尸在 8 格、墙在 20 格 ⇒ 在 8 格炸，`reason='entity'`
- Boss 命中：焰魔/守卫（盒随 yaw 旋转）也要命中
- dt 尖峰不穿墙（dt=0.2 ⇒ 3.6 格步长，1 格墙仍命中）
- 超距不爆炸（`reason='max-distance'`，无 `at`）
- 跨 column 索引迁移（照 `test-projectiles.js` 的既有写法）
- 单槽关系式：最长视觉 < 最小施法间隔
- 伤害派生：`cfg.damage === EXPLOSION_DAMAGE`、`cfg.blastRadius === EXPLOSION_DAMAGE_RADIUS`
- 碎块池账：`debrisCount + 32 + 42 <= IMPACT_FX.debris.maxActive`

### 8.3 Tier 4（像素实测，`tests/cinder-fall.spec.mjs` 新建）

⚠️ 全部带 `?shadows=0&reflect=0`（量 draw call 必须关倒影，v3.20 实测教训）。
⚠️ 两侧先藏 `viewWeapon.node`（宿主噪声源）。
⚠️ 阈值在 **1280×720**（Playwright 默认 viewport）下实测标定。

- **岩石真的上屏**：差分掩膜内暖色簇（`r > b + 25 && r > 60`）数量 > 噪声底 + 阈值
- **飞行**：两次截图（间隔 0.3s）暖簇质心位移 > 阈值（证明它在动，不是贴在手上的静态球）
- **落点爆炸**：命中后 0.1s 内亮像素面积猛增（outQuint），且壳内有暗区（防实心球）
- **命中实体即在实体处炸**：Boss 在 8 格时爆壳质心深度 ≈ 8 格而非 20 格
- **蓄力换色**：第二秒冷蓝簇 / 第三秒暖橙簇（同机位单变量）
- draw call：空闲=基线 / 飞行中增加 / 结束后回基线
- **负向对照**：`page.route` 换 config 把 `arc` 归零 ⇒ 飞行轨迹变成直线（质心 y 不变）

### 8.4 既有回归（最小充分集）
`sword` / `storm-lance` / `crosshair` / `weapons` / `unit-fast` / `player-flight`
（面板行宽）/ `water-order`（新增透明 mesh）/ `block-hit-fx`（共用碎块池）。

### 8.5 分档注册（漏了 = 静默不跑）
- `src/tests/index.html` 加 `import './test-cinder-fall.js'`
- `tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 加 `'test-cinder-fall.js'`
- `tools/test-tiers.mjs` 的 `ENTITY` 加 `'cinder-fall'`
（`check:data` 的 `[测试注册]` 与 `[测试分档]` 双向钉住）

## 9. 风险与预案

| 风险 | 预案 |
|---|---|
| 浮点边界让阶段判定 flaky | 复用 controller 跨越标志 + 纯函数 1e-9 容差（§2.1），单测钉两侧一致 |
| 第三秒起步球闪断 | 尺寸进度传 `max(p1,p2)`（§5.2），像素用例钉「第三秒球仍可见」 |
| 抛物线在陡坡上插进地里 | 判定逐步做 DDA，撞地即炸（不会真的穿进去） |
| 抛物线下判定线段算错 | state 存 `prevPosition`，不用 `velocity×dt`（§6.1） |
| 暖色 TSL 常量写成 `vec3(Color)` ⇒ 纯黑 | Tier 4 像素实测 + 显式拆分量（§7.2） |
| 第二段改坏第一段 | Tier 1 负向：既有 7 个采样点逐位不变 |
| 新增透明 mesh 干扰水面顺序 | `renderOrder 3` + 空闲 `visible=false`，跑 `water-order` |
| 碎块池被吃满 | §7.2 池账 92 ≤ 128，单测钉关系式 |
| 面板行文案撑宽面板 | 改文案后实测行宽 < 310px（`player-flight.spec` 守） |

## 10. 自由度（实施时可自行决定，不必再问）

- 具体 varying 命名、模块内函数拆分、注释措辞。
- `gain` / 岩石噪声幅度 / 熔岩缝宽度的具体值（由像素实测标定）。
- 余烬碎块的具体数量（只要池账成立且像素可见）。
- 蓄力环第二圈的具体半径（只要不压住准心 20px 笔画）。