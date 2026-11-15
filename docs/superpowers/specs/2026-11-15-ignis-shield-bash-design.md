# 焰魔第四招：举盾向前砸（Shield Bash）设计

> 状态：**已经用户批准并实施中**（2026-11-15 批准权重与音效两项）。本文档是设计裁定与实测依据。
> 实施计划：`docs/superpowers/plans/2026-11-15-ignis-shield-bash.md`。分支：`feat/ignis-shield-bash`。
> 关联：`2026-11-05-ignis-boss-design.md`（本体）、`2026-11-07-ignis-spin-attack-design.md`（第二招）、
> `2026-11-13-ignis-shield-smash-design.md`（第三招持盾冲撞）、
> **`docs/ignis-shield-slam-migration-failure-report.md`（v3.02 失败复盘，本设计的判据来源）**。

## 0. 本轮为什么重开：上一轮错在选招，不在执行

用户 2026-11-15：「我希望进一步引入焰魔的持盾攻击的动作，我已经做了这方面的一次尝试，但是失败了」。

失败报告的结论是「迁移执行没问题，错在决策 —— 两轮都选错了对象」。本报告**接受这个结论**，
并按它 §7 的六条「最小事实清单」重做选招，特别是第 6 条：

> 选招式的判据必须包含**原版语义**：触发 goal / 连招衔接（首帧是否 `startKeyframe(0)`）/
> 伤害来源 / 武器骨骼是否被驱动。纯几何筛选（盾最低最高）无法区分「攻击」与「号令」。

### 0.1 本报告对失败报告的一处纠正（实测，不是推断）

失败报告 §2.2 的盾几何只取了 `shield` + `shield_root` 的 **32 角点**。
`ModelIgnis.java:235~248` 里盾还有两块**副盾板** `right` / `left`（各 3 个立方体，
带 `setRotationAngle(±0.0865, −0.0114, ±0.1304)`），Bedrock 侧对应 `shield_right` / `shield_left`。
**完整盾几何是 80 角点**（4 骨骼 × 各立方体 8 角）。

补上副盾板后，`SHIELD_SMASH_ATTACK` 的盾顶峰值从报告的 4.291 变成 **4.758 格**。
这不改变报告的结论方向（它确实举过了头顶），但**所有数字都要用新口径重标** ——
本文档全部数字都是 80 角点口径。

## 1. 需求与裁定

用户诉求（沿用 2026-11-15 澄清）：**焰魔举起盾牌向前砸向玩家**。

本轮三项裁定（`ask_user_question`，2026-11-15）：

| # | 议题 | 裁定 |
|---|---|---|
| ① | 选哪一招 | **`ULTIMATE_ATTACK` / 素材 `attack11`** |
| ② | 前 3.35s 举盾蓄力段 | **保留但压缩**（不整段删、不原样保留） |
| ③ | 已在库的 `shieldSmash`（持盾冲撞） | **保留**，新招作为**第四招** |

沿用 v3.01 的既有裁定（本轮不推翻）：

- **只扣血**：不做击退 / 碎石特效 / 破玩家盾 / 眩晕 / 屏幕震动 / 原版火焰柱与 8 段火焰喷射。
- **零新增美术资源**：`attack11` 早在入库素材的 84 条动画里，盾几何与贴图早在产物里（v2.83 合成）。
  本轮只是让烘焙器多取一条已入库动画。**不新增方块、不新增贴图、不画任何新素材、不新增音效文件。**

## 2. 选招依据：几何 + 语义双判据（全量扫描 40 条 Java 动画）

### 2.1 探针口径（这次先验取样点，再验矩阵链）

失败报告 §4.2 的教训是「矩阵链正确 ≠ 取样点正确」。本轮的取样点**全部是真实几何角点**：

| 部件 | 骨骼 | 角点数 |
|---|---|---|
| 盾 | `shield` / `shield_root` / `right` / `left`（Bedrock：`shield_right` / `shield_left`） | **80** |
| 头 | `head` | 16 |
| 剑 | `sword` / `blade` / `blade2` / `blade_mid` | 48 |

- 原版侧：`tools/java-model-parse.mjs` 的 `parseBones` / `parseAnimation` / `evalKeyframes` / `javaWorld`
  （仓库已验证件，**未自写矩阵链**）。
- 产物侧：`src/tests/test-ignis-bake.js` 的 `probePoints` 口径（`R = bind·delta`，
  `position = pivot − R·pivot + deltaPos`）。
- **交叉自校验**：用「素材关键帧 + `bedrockRotation`」独立算 `attack1` 的盾 bbox，
  与已入库产物 `shieldSmash` 逐时刻比，最大偏差 **0.0814 格**（= 线性插值 vs 关键帧平台的口径差，
  非姿态差）⇒ 两条独立路径互证。
- 坐标：Bedrock 几何空间，y 向上、脚底 y≈0、**前方 = −z**，单位格。
- 时长一律取 `Animation.create(n) / 20`，**不是关键帧 n 之和**（后者会把 `resetKeyframe` 与
  `if/else` 两个分支重复计入 —— 本轮第一版扫描就踩到，`COUNTER` 被算成 6.10s 而实际 3.05s）。

### 2.2 候选终审表（80 角点口径，全部实测）

「峰后 0.6s」= 从盾顶最高那一刻往后 0.6 秒的位移，这是「砸向玩家」发生的位置。

| 招式 | 素材 | 秒 | 命中 t | 盾顶峰 | 过头顶 | 峰 t | **峰后前推** | **峰后下降** | 头/盾 | 盾底 min | 首帧 `startKeyframe(0)` | 驱动 sword |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `SHIELD_SMASH_ATTACK`（第三招，已在库） | attack1 | 3.50 | 1.70 | 4.76 | +1.47 | 1.00 | **0.14** | 0.61 | **1.22** | 0.01 | n | n |
| `SMASH`（v3.02 废弃） | attack9Sa | 2.35 | 0.25 | 4.97 | +1.63 | 0.00 | **−1.31** | 2.84 | 0.04 | −1.05 | **Y** | n |
| **`ULTIMATE_ATTACK`（本轮选定）** | **attack11** | **5.70** | **3.70** | **5.58** | **+2.26** | **3.35** | **+1.03** | **2.61** | **0.57** | **−0.70** | **n** | Y |
| `REINFORCED_SMASH` | attack10Sa | 5.75 | 0.25 | 5.24 | +2.01 | 0.00 | +0.93 | 1.69 | 0.27 | −0.12 | **Y** | Y |
| `REINFORCED_SMASH_IN_AIR` | attack10a | 8.10 | 1.15 | 5.24 | +2.01 | 4.60 | 0.00 | 0.00 | — | −0.64 | n | n |
| `STRIKE` | attack13Ta | 3.10 | 1.55 | 4.27 | +0.98 | 0.50 | **+4.18** | **0.51** | 0.08 | −0.09 | **Y** | n |
| `COUNTER` | attack13a | 3.05 | — | 4.33 | +1.05 | 0.40 | +0.70 | 0.11 | **1.57** | 0.01 | n | n |
| `COMBO1` | attack12 | 5.10 | 0.95 | 4.72 | +1.12 | 3.55 | −4.29 | 0.25 | 0.17 | −0.57 | n | n |
| `COMBO2` | **无同时长素材** | 6.55 | 1.70 | 5.18 | +1.88 | 1.75 | −3.69 | 1.37 | 0.03 | −0.73 | **Y** | Y |
| `SHIELD_BREAK_STRIKE` | attack4_2b（**不匹配**） | 3.20 | 2.20 | 5.02 | +1.70 | 0.60 | −2.25 | 1.33 | 0.33 | −0.60 | **Y** | n |
| `SHIELD_BREAK_COUNTER` | attack13b | 2.65 | — | 4.48 | +1.19 | 0.40 | 0.00 | 0.00 | — | −0.17 | n | n |

### 2.3 为什么是 `ULTIMATE_ATTACK`：四条判据同时成立，且只有它

**判据 A — 举盾过顶且盾面转向正前。** 盾面法线（盾板局部 +x 方向）与「前方 −z」的夹角：

| t(s) | 盾顶 y | 盾面法线前方分量 | 语义 |
|---|---|---|---|
| 0.00 | 2.64 | 0.00 | 盾侧挂左臂外（bind） |
| 0.90 | 4.74 | 0.92 | **盾举到头顶上方 1.42 格、盾面几乎正对玩家** |
| 1.65 | 4.42 | **0.97** | 盾面最朝前（夹角 13.4°） |
| 3.35 | **5.58** | 0.62 | 二次举盾到全场最高（过头顶 **2.26 格**） |
| 3.70 | 1.68 | 0.08 | **砸到底**：盾底 0.26、盾前缘 z **−3.73** |

`ULTIMATE_ATTACK` 的「盾面朝前（分量 > 0.5）」窗口是 **0.25~3.60s，共 68 tick** —— 全 40 条动画里最长。
对照：`SHIELD_SMASH_ATTACK` 峰值只有 **0.36**（盾始终侧着，是「拿盾挡在身前」而非「拿盾面朝玩家砸」），
`SMASH` 峰值 **0.14**，`COUNTER` **0.25**。

**判据 B — 同时向前 + 向下。** 峰后 0.6s：前推 **1.03 格**、下降 **2.61 格**。
- `SHIELD_SMASH_ATTACK` 前推只有 **0.14 格**（几乎不动），而**头前推 0.76 格**、头/盾位移比 **1.22**
  ⇒ 用户读作「头部撞击」，与用户观感一致。
- `SMASH` 前推是 **−1.31 格**（**后退**），方向相反。
- `STRIKE` 前推 4.18 格最大，但**下降只有 0.51 格**，且盾心 x 从 +2.46 扫到 −2.21（**行程 4.68 格**）
  ⇒ 那是**盾横扫**，不是砸。

**判据 C — 能独立成招（原版语义）。** 关键帧结构：

```
startKeyframe(18) → setStaticKeyframe(8) → startKeyframe(18) → setStaticKeyframe(8)
→ startKeyframe(15) → setStaticKeyframe(5) → startKeyframe(2) → setStaticKeyframe(20) → resetKeyframe(20)
   ↑ n=18：从静止缓入，不是 startKeyframe(0) 的连招衔接姿态
```

且 `attack11` 的 **t=0 帧十根骨骼的欧拉角全为 `[0,0,0]`**（实测）⇒ 起手就是 bind 姿态，
从站定切入没有硬切（对照 `SMASH` / `REINFORCED_SMASH` / `STRIKE` 都是 `startKeyframe(0)`）。

原版触发：`goalSelector.addGoal(1, new AttackAnimationGoal1<>(this, ULTIMATE_ATTACK, 72, true))`
（`Ignis_Entity.java:242`）—— **独立 goal**，不是接在别的动画后面。
`REINFORCED_SMASH` 则由 `Reinforced_Air_Smash` 在 `REINFORCED_SMASH_IN_AIR` tick>84 且落地时
`sendAnimationMessage` 触发（:2518~2521）⇒ **与 `SMASH` 同一个坑**。

**判据 D — 伤害来源与命中时刻。** `Ignis_Entity.java:1303~1348`：tick **74** 播
`STRONGSWING` + `ScreenShake` + `AreaAttack(6f, 6f, 45, 2.0f, 0.25f, 300, 5, brand, 7, false, 0)`
+ 8 段 `spawnFlameStrike` + 34×10 次 `UltimateAttack(...)`。
tick 74 ÷ 20 = **3.70s**，恰好是盾砸到底那一帧（盾顶 5.58 → 1.68 发生在 3.60~3.70）
⇒ **原版结算时刻与「盾砸到玩家」在画面上同步**，不是「摆姿势 + 别处扣血」。

### 2.4 素材配对（关键帧级，避开插值口径差）

`attack11` ↔ `ULTIMATE_ATTACK`：**108 个共有分量中 107 个逐轴 0 差**（99.1%），
唯一差异是 t=3.70 的 `sword.y`（Java 0° vs Bedrock 2.5°）。
`animation_length` 5.7 ≡ `Animation.create(114)/20`，驱动骨骼 10 根（含 `sword` 与 `left_fist`）。

⚠️ **配对精度只证明「搬对了」，不证明「选对了」**（失败报告 §4.5）。选招依据是 §2.3 的四条语义判据。

## 3. 时间压缩（裁定②）：三段 warp，只压蓄力、只拉砸下

### 3.1 为什么必须动时间

原版砸下段是 `startKeyframe(2)` = **2 tick = 100ms = 3 帧 @30fps**。
失败报告 §4.4 记着用户两次实玩反馈「感觉不完整呀？只有一个起手式？」——
100ms 的砸下在 60fps 画面上只有 6 帧，叠加淡入后几乎看不见。
同时原版本招全长 5.70s，其中 3.35s 是举盾/举剑蓄力（原版这段配火焰柱与震屏，按裁定③全部去掉）
⇒ **去掉特效后，3.35s 纯举盾会显得空**。

### 3.2 分段方案（冻结值）

| 段 | 源区间(s) | 源时长 | 产物时长 | 倍率 | 语义 |
|---|---|---|---|---|---|
| A 蓄力 | 0 ~ 3.35 | 3.35 | **1.34** | **×1/2.5**（压缩） | 举盾 + 举剑，加速 |
| B 峰值静止 | 3.35 ~ 3.60 | 0.25 | **0.25** | ×1（原速） | 举到最高点的定格 |
| C **砸下** | 3.60 ~ 3.70 | 0.10 | **0.30** | **×3**（拉长） | 盾向前下方砸 |
| D 砸后 + 收势 | 3.70 ~ 5.70 | 2.00 | **2.00** | ×1（原速） | 砸到底静止 1s + 收势 1s |

**产物总时长 = 3.89s**，帧数 `round(3.89 × 30) = 117`，实际 duration `117/30 = 3.90s`。
**命中帧 = A + B + C = 1.89s**（源 tick 74 的语义位置原样保留）。

源→产物映射（分段线性、单调、在三个段界处连续，实测校验通过）：

```
tSrc(tOut) = tOut × 2.5                      , tOut ≤ 1.34
           = 3.35 + (tOut − 1.34)            , 1.34 < tOut ≤ 1.59
           = 3.60 + (tOut − 1.59) × (0.10/0.30), 1.59 < tOut ≤ 1.89
           = 3.70 + (tOut − 1.89)            , tOut > 1.89
```

边界校验（实测）：`f(0)=0`、`f(1.34)=3.35`、`f(1.59)=3.60`、`f(1.89)=3.70`、`f(3.89)=5.70`；
1001 点采样单调性 ✓。

⚠️ **「砸下段 300ms」与 §6.1 的「500ms」不是同一个量，不要当成矛盾**：
- **300ms** = 段 C 的**关键帧区间时长**（源 `startKeyframe(2)` = 2 tick 拉长×3），是 warp 的**参数**。
- **500ms** = 画面上「盾顶从峰值 5.58 跌到 <2.0 格」的**可见过程时长**（产物 t=1.367→1.867），
  它跨了段 B 末尾的插值启动 + 整个段 C，是 §6.1 那条判据要量的**效果**。
  判据必须量后者（失败报告 §4.1：只量最终位置对「太快看不见」零判别力）。

### 3.3 三项约束的实测核对

| 约束 | 实测 | 结论 |
|---|---|---|
| `animSeconds < attackCooldownMin`（4.0） | 3.89 < 4.0，余量 **0.11s** | ✓ **不必抬冷却**（对照原样保留 5.70s 需抬到 6.0） |
| 派生 `attackAnimSeconds` = 各招最大 | max(2.75, 1.90, 3.50, **3.89**) = 3.89 | ✓ 不变式仍成立 |
| 派生 `hitFrameSeconds` = 各招最大 | max(1.20, 0.70, 1.70, **1.89**) = 1.89 | ✓ |
| 压缩后单帧最大骨骼角 ≤ 源自身合法上限 | 源 **30.00°** → 压缩后 **12.66°**（`right_arm_joint` @tOut=0.20） | ✓ 反而更平滑（0.42×） |
| 淡入必须在命中帧前走完 | 默认 0.2s ≪ 1.89s | ✓ 不新增淡入常量 |

⚠️ **压缩不改命中判据的语义位置**：命中帧仍是「盾刚砸到底」那一刻，只是到达它的墙钟时间变短。

### 3.4 已知代价（用户已接受）

- **偏离原版节奏**：蓄力 ×1/2.5、砸下 ×3。这是裁定②的明确选择，不是「为了让测试通过」的调参。
  与 v3.02 失败的第 3 轮调参的区别：**那次是在错误的招式上拉长时间，这次是在正确的招式上按用户裁定压缩**。
- 蓄力段的举剑动作会变快（剑尖从 0.97 升到 6.88 格的过程从 3.35s 压到 1.34s）。

## 4. 玩法档案（新招 `shieldBash`）

| 字段 | 值 | 来源 |
|---|---|---|
| `hitRange` | **6.5** | 与另三招同值（沿用 v3.01 二次裁定「不要窄距离门」；原版 `AreaAttack` 第一参是 6.0） |
| `hitConeDeg` | **22.5** | 原版 `arc 45` 的**半角**（同另三招口径，⚠️ 不是 45） |
| `hitFrameSeconds` | **1.89** | §3.2 的 A+B+C（源 tick 74 的语义位置） |
| `animSeconds` | **3.89** | §3.2 产物总时长 |
| `weight` | **0.20** | 见 §4.1 |

### 4.1 四招权重（本仓标定，需用户确认）

现有三招 0.35 / 0.30 / 0.35（和 = 1）。新招加入后**从横扫与持盾冲撞各让出一半的让出量**：

| 招 | 现值 | 新值 | 理由 |
|---|---|---|---|
| `swing` | 0.35 | **0.25** | 让出 0.10 |
| `spin` | 0.30 | **0.30** | **不动**（用户历次裁定都未要求改旋斩） |
| `shieldSmash` | 0.35 | **0.25** | 让出 0.10 |
| `shieldBash` | — | **0.20** | 新招 |

和 = 1.00。⚠️ **这是本仓标定，不是原版数值**（原版 ULTIMATE 有 1200 tick = 60s 独立冷却，
本仓不引入这么长的冷却）。若用户要别的分配，改四个数即可。

**不新增独立冷却**：全局 `attackCooldownMin` 4.0 已控住节奏（同 `shieldSmash` 的处理）。

### 4.2 命名

- 档案键 / 产物动画键：**`shieldBash`**
- 中文名：**举盾砸击**（与第三招「持盾冲撞」区分：那一招是身体前压，这一招是盾砸）

⚠️ **不复用 `shieldSlam`**：那是 v3.02 废弃分支用过的键名，复用会让历史文档与代码对不上。

## 5. 连带影响（必须同步，否则静默失效）

### 5.1 `feetOffsetY` 会变 ⇒ 命中盒中心必须重标

烘焙器扫**全部动画所有帧的身体骨骼**（排除 `/^(sword|shield)/`）取最低点。实测：

| 动画 | 身体最低点 y（模型空间，格） |
|---|---|
| idle | 0.26562500 |
| attack | 0.31250000 |
| spin | 0.27862744 |
| shieldSmash | 0.22286010 ← **现 feetOffsetY 的来源** |
| **shieldBash（warp 后）** | **0.04808981** ← 新来源（@产物 t=1.90s，`right_fist`） |

⇒ `feetOffsetY` 从 **−0.22286010** 变成 **−0.04808981**（上移 0.1748 格）。

⇒ `IGNIS_CORE_OBB.center[1]` = `IGNIS_MODEL_CENTER[1] + feetOffsetY` = 1.7762 + (−0.0480898)
= **1.7281**（现 1.5534）。`halfExtents` 与 `MODEL_CENTER` 来自 bind pose，**不变**。

⚠️ **设计期预估 0.07736861 / 1.6988 已被产物实测推翻**：预估脚本用「源关键帧 + 自建采样」，
而烘焙器逐帧重采样（含帧间 slerp）⇒ 最低点落在 `right_fist` 而非预估的位置。
**以产物为准**（AGENTS.md：冻结断言重标实测值）。

⚠️⚠️ **命中盒底面随之从 0.0897 抬到 0.2644，射线用例必须重标**（实测发现）：
用 CPU 蒙皮口径量画面里的核心躯干（bind pose）最低点 = **0.2644**，与新盒底完全一致；
旧值 0.0897 反而比画面低 0.17 格。故 `+0.1` 的射线现在落在真实躯干之下：
正例取样抬到 **+0.3**，并把 **+0.1 加进负例** —— 两条夹住盒底，判别力比原来更强。

⚠️ 这条链是 v3.01 踩过的：`test-ignis-system.js` 的「产物独立复算」用例会红，
**必须重标而不是放宽容差**（`frozen-assertion-rebaseline-over-widening`）。

### 5.2 音效：从 mod 素材拷一个现成文件（与 v3.01 同一手法）

**原版这招播什么**（`Ignis_Entity.java:1303~1348`，逐行读）：
- tick 74：`ModSounds.STRONGSWING`（= 本仓 `ignis_attack_swing.ogg` 的同一素材）
- 同一 tick 末尾：`earthquakesound(10f)` ⇒ 该方法（:1820）播的是 **`SoundEvents.TOTEM_USE`**
  （Minecraft 原版音，本仓与 mod 素材里都没有这个文件）
- ⚠️ **`ModSounds.IGNIS_EARTHQUAKE` 虽然在 `ModSounds.java:116` 注册了，但全仓没有任何
  `IGNIS_EARTHQUAKE.get()` 调用点**（程序化扫描确认）⇒ `ignis_earthquake.ogg` 是**未使用素材**，
  不能声称它是「这招的原音」。

**四招音必须两两不同**（`test-bgm.js:427` 的 `new Set(ids).size === ids.length`）。
现有三音已占满 `ignis_attack_swing` / `ignis_attack_circle` / `ignis_attack_smash`
⇒ 新招**必须新增一个 id**，否则那条断言必红。

**取 `ignis_impact.ogg`**（mod 素材 `sounds/entity/ignis_impact.ogg`，9023 字节，
`sounds.json:161` 的 `ignis_impact` 事件用它，语义是「焰魔撞击」）：

| 项 | 值 |
|---|---|
| 新 id | `ignis_attack_bash` |
| 文件 | `assets/sounds/ignis_attack_bash.ogg` = mod `ignis_impact.ogg` **逐字节副本**（未转码） |
| 扩展名表 | `SOUND_EXT_OVERRIDES.ignis_attack_bash = 'ogg'`（漏加 = 静默无声） |
| 音量 | `SOUND_VOLUMES.ignis_attack_bash`，与 `ignis_attack_smash` 同档 |

⚠️ **这是近似替代，不是原版该招的音**（原版是 `STRONGSWING` + `TOTEM_USE`）。
与 v3.01 拷 `sword_stomp.ogg` 完全同一手法：**零新增美术资源** —— 不下载、不转码、不录制，
只把姊妹仓库里已有的 ogg 拷进来。

⚠️ **不选「同素材两个 id」**（把 `ignis_attack_smash.ogg` 再拷一份改名）：那会让两招听起来一模一样，
满足断言但失去「听声辨招」的实际意义 —— 断言的意图是「加了招式要接不同的音」，不是「id 字符串不同」。

### 5.3 需要改动的清单（唯一权威原则）

| 文件 | 改什么 |
|---|---|
| `tools/ignis-fingerprint.mjs` | `IGNIS_ANIM_PERIODS.shieldBash`、`IGNIS_ANIM_SOURCES.shieldBash`、新增 `IGNIS_ANIM_TIME_WARP` + `ignisAnimOutputPeriod()` |
| `tools/bake-ignis.mjs` | `resampleAnimation` 接受 `timeWarp`；主循环按 `ignisAnimOutputPeriod` 定帧数 |
| `tools/check-data.mjs` | 帧数断言改用 `ignisAnimOutputPeriod(key)`（否则新招必红） |
| `src/entities/ignis/ignis-config.js` | `IGNIS_ATTACKS.shieldBash`、四招权重、`IGNIS_CORE_OBB.center[1]` 重标 |
| `src/render/ignis-renderer.js` | `wantClip` 增加 `shieldBash` 分支 |
| `src/render/audio-config.js` | `SOUND_IDS` / `SOUND_EXT_OVERRIDES` / `IGNIS_ATTACK_SOUNDS` 各加一条 |
| `assets/sounds/ignis_attack_bash.ogg` | 新增（mod `ignis_impact.ogg` 逐字节副本，9023 字节） |
| `assets/ignis/ignis.{json,png,meta.json}` | 重烘产物 |
| `src/tests/test-ignis-bake.js` | 新招契约 + 语义判据（真实角点，见 §6） |
| `src/tests/test-ignis-system.js` | 四招形状/权重/派生值/命中盒重标 |
| `src/tests/test-ignis-render.js` | 四招姿态互不相同 + 淡入 + 缺键回落 |
| `src/tests/test-ignis-boss-agent.js` | 抽签区间按四招重标 |
| `src/tests/test-bgm.js` | 四招音齐全、两两不同 |
| `tests/ignis.spec.mjs` | E2E：四招像素/骨骼互不相同、新招射程与锥宽 |
| `docs/roadmap.md` | 登记 v3.03 |

## 6. 验证策略（按失败报告的教训设计判据）

### 6.1 判据必须落在「真实几何 + 向前 + 语义」，不是单点 y

新增的烘焙产物用例（`test-ignis-bake.js`），全部用 **80 角点**盾几何。
下表的「产物实测」列是 **warp 后**的值（用素材关键帧 + `bedrockRotation` 在产物时间轴上重算，
与将来真烘焙出来的产物同口径）：

| 判据 | 阈值 | 产物实测 | 判别力（对照招式的同口径值） |
|---|---|---|---|
| 盾顶举过头顶 | 峰值 − 头顶峰 > **1.5 格** | **2.259** | shieldSmash 1.47 ✗ / spin 1.19 ✗ / strike 0.98 ✗ |
| **盾面向前** | 存在帧使法线前方分量 > **0.85** | **0.973** | shieldSmash 0.36 ✗ / smash 0.14 ✗（spin 0.98 ✓，靠下一条排除） |
| **向前砸**（同时约束 y 与 z） | 峰后 0.6s 内前推 > **0.6 格** 且下降 > **1.5 格** | **1.029 / 2.554** | shieldSmash 0.14/0.61 ✗ / strike 4.18/**0.51** ✗ / spin 3.26/**0.69** ✗ / smash **−1.31**/2.84 ✗ |
| 砸下段可见时长 | ≥ **250ms** | **500ms**（盾顶 5.58→<2.0） | 原版未 warp 时 ≈167ms ✗ |
| 独立成招 | t=0 帧十根骨骼欧拉角全 0（从 bind 起手） | ✓ | smash ✗ / reinforcedSmash ✗ / strike ✗ |

⚠️ **三条几何判据必须同时成立**：单看「面朝前」会放进 spin（0.98），单看「前推」会放进 strike（4.18），
单看「下降」会放进 smash（2.84）。**三条交集只有 shieldBash** —— 这就是「举盾 + 向前 + 砸」的完整语义。

⚠️ **每条都必须在「注入错误动画」的负向验证下变红**（把 `IGNIS_ANIM_SOURCES.shieldBash`
临时改成 `attack1` / `attack9Sa` / `attack13Ta` / `attack8a3`，逐条确认哪条抓住它）。
负向验证撤销时用 **`cp` 副本还原**，不用 `git checkout`（工作树有未提交改动）。

### 6.2 不得把错误目标固化成门禁

失败报告 §4.1 的教训：v3.02 把「盾必须触地（<0.15 格）」写成了永久断言，
而用户要的招不触地 ⇒ 正确目标在该门禁下必然红。

本轮**不写「必须触地」**：`shieldBash` 砸到底时盾底 **0.26 格**（不触地），
判据落在「**下降量 + 前推量**」这两个过程量上。

### 6.3 Tier 4 像素实测

`tests/ignis.spec.mjs` 新增：四招在同一时刻（取 t=1.0s）的截图两两不同 + 骨骼姿态两两距离 > 0.3；
新招在命中帧前后（t=1.59 / 1.89）截图差异显著（证明砸下段真的在画面上发生）。
⚠️ 先测同状态连拍的噪声底（必须为 0），再钉上下界。

### 6.4 门禁与基准

- `npm run check`（arch + data + lint）
- `npx playwright test tests/ignis.spec.mjs`、`tests/boss-audio.spec.mjs`
- 浏览器内单测 `/src/tests/index.html`（新增用例必须同时注册进 `index.html`，否则静默不跑）
- 不改热路径（mesher/materials/render/scheduler/physics）⇒ **不需要 `bench --check`**

## 7. 事实与推断的分界

**实测事实**（本轮重跑，可复现）：
- 盾完整几何 80 角点（4 骨骼）；`SHIELD_SMASH_ATTACK` 盾顶峰值 4.758 格（32 角点口径是 4.291）。
- `ULTIMATE_ATTACK` 盾顶 5.58 / 过头顶 2.26 / 盾面朝前峰 0.97（68 tick 窗口）/ 峰后前推 1.03 / 下降 2.61。
- `attack11` t=0 十根骨骼欧拉角全 `[0,0,0]`；关键帧结构首项 `startKeyframe(18)`。
- `attack11 ↔ ULTIMATE_ATTACK` 108 分量中 107 个 0 差，唯一差异 t=3.70 `sword.y` 2.5°。
- 原版 tick 74 结算 `AreaAttack(6f, 6f, 45, …)`；触发是独立 goal（`AttackAnimationGoal1`, look1=72）。
- warp 后产物 3.89s / 117 帧 / 命中 1.89s；单帧最大角 12.66° < 源 30.00°。
- **产物时间轴上的几何实测**（warp 后，80 角点）：盾顶 5.577 / 过头顶 2.259 / 面朝前峰 0.973 /
  峰后 0.6s 前推 1.029 下降 2.554 / 盾底 min −0.698 / 盾前 z min −3.728 /
  砸下段（盾顶 5.58→<2.0）**500ms**。
- warp 后身体最低点 **0.04808981** ⇒ `feetOffsetY` −0.04808981、`CORE_OBB.center[1]` **1.7281**
  （设计期预估 0.07736861 / 1.6988 被产物实测推翻，已重标）。
- 命中盒底面 0.0897 → **0.2644**，与画面核心躯干 bind 最低点逐位一致（CPU 蒙皮实测）。
- 两条独立路径（素材关键帧 vs 已入库产物）算 `attack1` 盾 bbox 最大差 0.0814 格。
- `ModSounds.IGNIS_EARTHQUAKE` 在全仓无调用点（程序化扫描）⇒ `ignis_earthquake.ogg` 是未使用素材。
- mod `ignis_impact.ogg` = 9023 字节，`sounds.json:161` 的 `ignis_impact` 事件引用它。

**本仓标定（非原版，需用户确认）**：
- 四招权重 0.25 / 0.30 / 0.25 / 0.20（§4.1）。
- 音效取 mod `ignis_impact.ogg`（§5.2；原版是 `STRONGSWING` + `TOTEM_USE`，后者无文件）。
- `hitRange` 6.5（原版 6.0）、`hitConeDeg` 22.5（原版 arc 45 的半角）。

**未做**：任何代码修改、任何提交、任何产物重烘、任何分支创建。