# 焰魔行为优化设计（v2.62）：转向延迟 / 减速 / 台阶缓动 / 防卡 / 双飞跃 / 阻挡玩家 / 绕行朝向

> **v2.63 迭代（2026-11-06 同日）见 §8** —— 用户验收后提的三项反馈：绕行卡住的根因修复
>（脱困方向改随机）、速度再降 1/3、玩家位置感知间隔（1~2 秒）。§2 的 v2.62 设计仍是基础，
> §8 记录在它之上的三处修订与各自的根因。

用户 2026-11-06 提出八项焰魔（Ignis）行为缺陷/需求（原文逐条见 §1）。本设计为全部八项的
统一方案，用户已裁定三处方案选择均取推荐项（§1.1）。

**素材佐证**（`~/jaylli/cataclysm1.19.2modding`，Cataclysm mod Java 源码，2026-11-06 实测读取）：

| 本设计项 | 原版对应实现 | 出处 |
|---|---|---|
| ① 不始终面向玩家 | `LookAtPlayerGoal(this, Player.class, 8.0F)` + `RandomLookAroundGoal` —— 原版只在 8 格内转头看玩家，其余时间随机张望，**本来就不是炮塔式追踪** | `Ignis_Entity.java:271-272` |
| ⑥ 飞跃劈砍 | `PredictiveChargeAttackAnimationGoal` —— 蓄力期记录玩家位移、tick=charge 时**预判**玩家位置并 `setDeltaMovement` 冲过去 | `AI/PredictiveChargeAttackAnimationGoal.java` |
| ⑦ 不被玩家推动 | `KNOCKBACK_RESISTANCE = 1.0`（完全免疫击退） | `Ignis_Entity.java:508` |

**⚠️ 本设计不烘焙、不新增任何美术资源**：飞跃期间复用现有 `idle` 姿态（抛物线位移本身就是
「飞跃」的观感），落地接现有 `attack` 劈砍动画。源素材 84 条动画中没有独立的「跳跃」条目。

---

## 1. 用户原始需求（八项，2026-11-06）

1. **转向延迟**：焰魔只要没在做动作就始终面向玩家，不自然。「可以加一个延迟，玩家跑开几秒后，
   焰魔再转身面向玩家进行追击」。
2. **减速**：「行进速度降低三分之一」。
3. **台阶缓动**：「上台阶的动作没有缓动的动画，要像丧尸一样……而不是闪现到台阶之上」。
4. **防卡死**：「身体和方块发生穿模的时候，有时候就卡住不动了，让焰魔不要因为和方块发生
   重叠或穿模就卡住」。
5. **卡住飞跃**：「卡住不动的时候，比如卡住 4 秒钟，就飞跃出来……执行一个飞跃的动作来脱困」。
6. **跳跃劈砍**：「靠近玩家过程中，距离玩家一定的距离，就执行一个飞跃向前的动作，落点刚好
   就在玩家的面前，飞跃到快触碰到地面的时候，执行当前的劈砍的动作」。
7. **阻挡玩家**：玩家跑向焰魔时焰魔退让，显得「玩家推着焰魔走」。「焰魔作为一个巨大的存在，
   如果焰魔不动，焰魔是可以挡住玩家前进的……玩家奔跑向焰魔，撞到焰魔的身体，焰魔应该不动
   如山，玩家也应当停止前进，就类似撞到实心方块一样」。
8. **绕行朝向**：「绕过障碍物追击玩家的时候，脸部方向要面向前进方向，而不是面向玩家贴着墙
   进行『侧滑』」。

### 1.1 用户裁定的三处方案选择（2026-11-06，ask_user_question）

| 选择 | 裁定 | 含义 |
|---|---|---|
| A. 阻挡玩家的实现 | **(a)** `PlayerPhysics` 注入 `IgnisService`，玩家 AABB 与焰魔身体盒重叠即视为实心（与 `minecarts` 注入同手法） | 撞墙式二分回退停住 |
| B. 两种飞跃的关系 | **(a)** 统一为一个 `leap` 模式 + `leapKind`（`escape`/`attack`），共用抛物线物理 | 触发条件与落地转态分叉 |
| C. 转向延迟作用范围 | **(a)** 只门控 `idle → chase` 的重新锁定；idle 保持最后朝向不追踪 | 近身战斗不迟钝 |

追问裁定（同轮）：**转向延迟 = 1.5 秒**；**跳跃劈砍触发距离 = 8~14 格**；**脱困飞跃 =
抛物线物理**（给初速度走现有重力/碰撞，不是固定弧线瞬移）。

---

## 2. 逐项设计

### 2.1 ① 转向延迟（idle 不追踪 + 重新锁定需 1.5s）

**现状**：`idle` 分支每帧 `yaw = _steerYaw(yaw, _angleTo(player))` —— 炮塔式追踪；
且 `idle → chase` 无延迟（玩家一进 `sightRange` 立即转身追）。

**改法**：
- **删除 idle 的 yaw 追踪**：待机时保持最后的朝向（玩家绕着它走，它不转头）。
- 新增 state 字段 `acquireT`（秒）：`idle` 中玩家处于 `sightRange` 内时累加，离开立即清零；
  `acquireT ≥ IGNIS_AI.turnDelay`（**1.5s**）才转 `chase`。
- `chase`/`attack`/`leap` 中的朝向按 §2.8 与各自规则处理，不受此延迟影响（已在战斗中
  面向玩家/前进方向是自然的）。

**语义**：玩家跑开 → 焰魔保持原朝向站着 → 玩家在视野内待满 1.5s → 焰魔才转身追击。
对应原版「8 格外不盯着玩家」的观感。

### 2.2 ② 追击速度降 1/3

`IGNIS_AI.chaseSpeed: 6.6 → 4.4`。

⚠️ 这是对「作者原值」的**用户裁定偏离**（config 注释须同时保留作者原值 6.6 与偏离理由，
同 `standoffRange` 的注释手法）。`test-ignis-system.js` 的冻结断言
`assertEqual(IGNIS_AI.chaseSpeed, 6.6)` 同步改为 4.4 并注明裁定来源。

不变式复查（全部仍成立）：
- `standoffDeadband(0.75) > chaseSpeed/60 ≈ 0.073` ✓
- `attackRange(5.5) ≥ standoffRange(5.0) + 一步余量(4.4/60 ≈ 0.073)` ✓

### 2.3 ③ 上台阶视觉缓动（渲染层，物理不动）

与丧尸 v2.39 完全同构：物理 step-up 保持瞬时（AABB 精确），渲染 y 加 ease-out 滞后。

- `IgnisRenderer` 每个实例挂 `{lift: new StepLift(), prevY: null}`（复用
  `player/step-lift.js`，衰减参数不写第二份 —— 红线 1）。
- `sync()` 从 `nowMs` 差值算 dt（新增 `_lastSyncMs`，同丧尸渲染器）。
- 三分支与丧尸 `_advanceLift` 逐条同义：首帧对齐不触发 / `dy > epsilon` 触发 / `dy < 0`
  立即清零。epsilon 在 `ignis-config.js` 记 `IGNIS_STEP_LIFT.epsilon = 1e-4`（与丧尸同值，
  注释说明标定依据同源）。
- 发布：`pivot.position.y = state.position[1] + lift.offset`。
- 测试钩子：`liftOffsetOf(index)` / `renderYOf(index)`（同丧尸渲染器的钩子语义：只断言
  offset 会漏「算对但没写进矩阵」）。

### 2.4 ④ 穿模自解卡（`_resolveStuck`）

**机制分析**：焰魔被埋进方块的现实路径 = TNT/火球爆炸改地形、玩家放块、step-up 角落竞态。
被埋后所有水平移动二分回退到零位移 → 卡死。

**改法**（复刻玩家 `PlayerPhysics.resolveStuck` 的语义，判据复用 `aabbCollidesAt`）：
`update()` 顶部（移动意图之前）若 `_collides(world, px, py, pz)` 为真，从
`Math.ceil(py)` 起向上逐格扫，第一个不碰撞的整数 y 即新脚底，`vy = 0`；扫描上限
`IGNIS_AI.stuckResolveMaxRaise`（**16 格** —— 埋得更深属不可恢复，不静默抬半路）。
常态成本 = 一次 `_collides`（≤16 次 `isSolid`），位置逐位不变。

### 2.5 ⑤ 卡住 4 秒 → 飞跃脱困（`leap` / `escape`）

**卡住判据**：新增 state 字段 `stuckT`（秒）。本帧有**原始**水平移动意图（站定环/navDir
给出的 direct 向量，即 `steerIntentAabb` **之前**的意图）但实际水平位移 `< 15%` 的应走
位移（`|direct| × step`）时累加 `stuckT`，否则清零。（斜蹭墙仍算前进 —— 只有「基本没动」
才计时。）

⚠️ **必须用 pre-steering 的原始意图计量**（实施期预检发现）：若用 post-steering 的
`wantVx/wantVz`，四面围死时 `steerIntentAabb` 返回 `{vx:0,vz:0,blocked:true}` ⇒ 意图恒 0
⇒ `stuckT` 永不累计 ⇒ **用户报告的「卡住不动」形态恰好测不到也修不掉**。

**触发**：`stuckT ≥ IGNIS_AI.stuckLeapSeconds`（**4.0s**）且 `onGround` →
`mode = 'leap'`、`leapKind = 'escape'`，并：
- `vy = IGNIS_AI.leapJumpForce`（**11**，抛物线顶点 ≈ 2.5 格，越得过 2 格障碍）；
- `leapDir` = **卡住瞬间的移动意图方向**（`wantVx/wantVz`，即绕行/寻路后的最终意图）
  归一化 × `IGNIS_AI.leapSpeed`（**8 格/秒**）—— 朝它本来要去的方向跳，不是随机跳。
  滞空 ≈ 0.92s ⇒ 水平约 7 格。
- `stuckT = 0`。

**leap 模式规则**（两种 kind 共用）：
- 不转向玩家、不走站定环、不消费 navDir；每帧的水平意图 = **`leapDir`**（起跳时算定、
  空中不再改的常量向量，含长度）—— 碰撞/step-up 照常生效，撞墙就滑停（不是穿墙）。
- **防穿过玩家**：每个物理步若与玩家水平距 `< standoffRange − standoffDeadband`
  （4.25 格）→ **本步**水平意图清零（只保留下落），`leapDir` 本身不清 —— 玩家走开后
  继续飞。焰魔物理看不见玩家（玩家阻挡是单向的，§2.7），这条守卫防止飞跃落进玩家身体
  造成重叠。
- 落地（`onGround` 转真）→ `escape` 回 `chase`；`attack` 见 §2.6。
- 安全阀：`leapT > IGNIS_AI.leapMaxSeconds`（**3s**）强制结束回 `chase`（防异常滞空）。

### 2.6 ⑥ 跳跃劈砍（`leap` / `attack`）

**触发**（`chase` 中，全部满足）：
- `IGNIS_AI.leapAttackMin(8) ≤ hDist ≤ leapAttackMax(14)`；
- `onGround`、`losVisible`、`leapAttackCooldown ≤ 0`；
- **直路可通**：本帧 `steerIntentAabb` 对直接意图零偏角且未 blocked（正在绕行时跳会撞墙）。
  ⚠️ **复用本帧已算的 steering 结果**（`update` 里已经调过一次），不得为了这个判据
  再调一次 —— 两次调用之间没有状态变化，重复调用只是白付一次探针成本。

**起跳参数**（仿原版 `PredictiveChargeAttackAnimationGoal` 的预判）：
- 预判玩家位置 = `playerPos + playerVel × T`（`T = IGNIS_AI.leapAttackAirtime`，**0.9s**；
  玩家速度由装配层注入 ctx，§3.2）。
- 落点 = 预判位置朝焰魔方向外推「站定环内缘」距离：`standoffRange − standoffDeadband/2`
  （≈4.6 格）——「落在玩家面前」且落进挥砍范围（4.6 < hitRange 6.5）。
- 水平速度 = (落点 − 焰魔位置) / T；
- 竖直初速按抛物线精确解：`vy = (Δy + ½|g|T²) / T`（Δy = 落点y − 脚底y），钳制
  `[8, 14]` —— 玩家站在高台上也跳得上去。
- 起跳即置 `leapAttackCooldown = IGNIS_AI.leapAttackCooldown`（**8s**，独立于普攻冷却）。
- 记录 `leapTargetY` = 落点 y。

**「快触地时起劈」**：leap(attack) 期间每帧检查，满足其一即转 `attack`（`attackAnimT = 0`，
yaw 立即对准玩家）：
- 下落中（`vy < 0`）且 `py ≤ leapTargetY + IGNIS_AI.leapSlashLead`（**0.5 格**）；
- 或已落地（`onGround`，兜底：预判偏差大时落地才起劈）。

转 `attack` 后**水平动量保留**：`leapDir` 继续作为水平意图直到 `onGround`（劈砍前 0.2s
左右的滑行 = 「砸落」观感），随后 `leapDir = null`，进入正常站定挥砍。命中结算完全复用
现有链路（`hitFrameSeconds` 1.20s 时 `attackRequest`，game.js 锥判据）—— 落地时距玩家
≈4.6 格、朝向对准 ⇒ 命中的几何条件满足。

### 2.7 ⑦ 焰魔不动如山：阻挡玩家 + 移除退让

**两半改动，缺一不可**：

**(a) 玩家物理把焰魔身体当实心**（裁定方案 A）：
- `PlayerPhysics` 新增注入字段 `this.ignises = null`（同 `this.minecarts` 手法；
  `player/` 不得 import `entities/` —— 依赖方向）。
- `IgnisService` 新增查询方法 `overlapsAabb(box)`：`box` 是调用方给的
  `{minX,maxX,minY,maxY,minZ,maxZ}`，对每只存活焰魔用 `ignisAabbFor(state)` +
  `state.position` 算世界盒，严格不等式相交判定（贴面不算，同 `overlapsBlock` 口径）。
  **玩家尺寸权威仍在 `physics.js`**（传自己的 `aabb()`），焰魔盒权威仍在 ignis 模块 ——
  两侧都不复制对方的量。
- `_collides()` 末尾追加：`if (this.ignises && this.ignises.overlapsAabb(this.aabb())) return true;`
- 连带效果（全部是想要的）：玩家撞焰魔 = 二分回退停住；`_tryStepUp` 抬升后仍与焰魔盒相交
  ⇒ 玩家**爬不上**焰魔（盒高 2.97 格 > 玩家抬升后头顶）。

**(b) 移除站定环的退让分支**（v2.60 的 retreat）：
- `_ringIntent` 三档变两档：`d < inner(4.25)` → **站住不动**（`{vx:0, vz:0, tooClose:true}`，
  原来是背离退让）；死区 → 站住；`d > standoff` → 走向环上最近点。
- `retreating` 标志更名 `tooClose`，语义不变地守住原守卫：`tooClose` 时**不消费 navDir**
  （否则看不见玩家时寻路会让焰魔朝玩家撞过去 —— v2.60 修掉的缺陷换形式复活）。
- 玩家贴近的观感：焰魔站定 → 玩家撞上身体盒被挡住（(a)）⇒「不动如山」。
- ⚠️ v2.60 的单测「玩家贴上来 → 焰魔后退让位」改写为「玩家贴上来 → 焰魔原地不动」。

**已知边界（v2.62 final review 后修正）**：玩家传送/矿车下车恰好落进焰魔盒内时，
`resolveStuck` 走 `collidesAt`（只查方块）不感知焰魔。**⚠️ 这曾是一个真软锁**：
玩家侧 `_collides()` 恒真 ⇒ 四轴全冻结（走不开也落不下），而焰魔侧「去退让」后
`d < inner` 站定 + `tooClose` 禁 navDir ⇒ 它永不主动离开，且意图恒 0 ⇒ `stuckT` 不累计
⇒ 脱困飞跃也不触发 ⇒ 玩家被冻在 Boss 身体里、Boss 处于 attack 循环持续砍人。
**修法**：`_ringIntent` 增加「真重叠例外后退」档 —— `d < IGNIS_AI.overlapEscapeDist`(1.15
= 身体盒最大水平半宽 0.8264 + 玩家半宽 0.3) 时背离玩家退开自愈。这只反转「重叠」
这一个退化情形，**不反转用户第⑦项**：玩家被身体盒挡在外面的正常距离（E2E 实测
minDist ≈ 1.36）远大于该阈 ⇒ 仍站定不动如山。守卫：`test-ignis-boss-agent.js` 的
「重叠自愈」+「未重叠时仍站定」阳性对照两条。

> **v2.78 补记**：上面这个固定距离阈值覆盖不全 —— 阻挡盒随焰魔朝向变形，玩家贴在斜角外被转身的盒子扫到时
> `d≈1.4` 自愈永不触发，仍会永久软锁（用户缺陷「跑太近就卡死」）。已由玩家物理兜底，见本文 §9。

### 2.8 ⑧ 绕行时面向前进方向

**现状**：`chase` 一开始就 `yaw = _steerYaw(yaw, _angleTo(player))`，与移动方向无关 ⇒
贴墙绕行时「侧滑着盯玩家」。

**改法**：yaw 转向移到**最终意图确定之后**（站定环 → 局部绕行 → navDir 覆盖 全部完成）：
- 有水平意图（`wantVx/wantVz` 非零）→ 面向速度方向：`yaw_target = atan2(−wantVx, −wantVz)`
  （由本仓前向口径 `(−sin yaw, −cos yaw)` 反解，与 `_angleTo` 同源）；
- 无意图（死区站定）→ 面向玩家。
- `attack` 中**不逐帧改 yaw**（与原版挥砍期锁朝向同口径）；起手前 chase 已对准玩家，
  跳劈落地那一刻做**一次性**对准（§2.6），之后锁住。
- `leap` 中面向 `leapDir`（escape kind 全程如此；attack kind 在转 attack 的那一帧改对玩家）。

---

## 3. 架构

### 3.1 state 新字段（`createState` 全部带缺省，旧调用不破）

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `acquireT` | number | 0 | idle 重新锁定累计秒数（①） |
| `stuckT` | number | 0 | 「有意图无进展」累计秒数（⑤） |
| `leapKind` | `null\|'escape'\|'attack'` | null | 飞跃类别（⑤⑥） |
| `leapDir` | `[vx,vz]\|null` | null | 飞跃期水平速度（常量） |
| `leapT` | number | 0 | 飞跃已持续秒数（安全阀） |
| `leapTargetY` | `number\|null` | null | attack 飞跃的预判落点 y（起劈触发） |
| `leapAttackCooldown` | number | 0 | 跳跃劈砍冷却剩余秒数（⑥） |

`MODES` 增加 `'leap'`。`attackRequest` / `navDir` / `needsPath` 语义不变。
`_physAccum` 不变（⚠️ 既有注释的载荷性警告仍适用：新字段同样必须经 `createState` 保留）。

### 3.2 config 变更（`ignis-config.js`，唯一权威）

| 常量 | 值 | 来源 |
|---|---|---|
| `chaseSpeed` | **4.4**（原 6.6） | 用户裁定 2026-11-06：降 1/3 |
| `turnDelay` | 1.5 | 用户裁定（追问） |
| `stuckLeapSeconds` | 4.0 | 用户原文「卡住 4 秒钟」 |
| `stuckProgressRatio` | 0.15 | 本仓标定：实际位移 < 应走位移 15% 算「没动」 |
| `stuckResolveMaxRaise` | 16 | 本仓标定：解卡上扫上限 |
| `leapJumpForce` | 11 | 本仓标定：顶点 ≈2.5 格（v²/2g），越 2 格障碍 |
| `leapSpeed` | 8 | 本仓标定：escape 水平速（滞空 0.92s ⇒ ~7 格） |
| `leapMaxSeconds` | 3.0 | 本仓标定：飞跃安全阀 |
| `leapAttackMin` / `leapAttackMax` | 8 / 14 | 用户裁定（追问）；在 attackRange(5.5) 外、sightRange(50) 内 |
| `leapAttackAirtime` | 0.9 | 本仓标定：与 leapJumpForce 的自由滞空同量级 |
| `leapAttackCooldown` | 8.0 | 本仓标定：约两次普攻间隔一次跳劈 |
| `leapSlashLead` | 0.5 | 本仓标定：落点上方 0.5 格起劈（「快触地」） |
| `IGNIS_STEP_LIFT.epsilon` | 1e-4 | 与丧尸 `ZOMBIE_STEP_LIFT.epsilon` 同值同标定依据 |

数值不变式（新增守卫，进单测）：
- `leapAttackMin > attackRange`（跳劈是「够不着时的接近手段」，不能与原地起手距离重叠抖动）；
- `leapAttackMax ≤ sightRange`；
- 落点距离 `standoffRange − standoffDeadband/2 < hitRange`（跳完砍得到）。

### 3.3 装配层接线（`game.js`）

1. `this.player.physics.ignises = this.ignises`（Player 构造之后；`IgnisService` 已在
   :665 先建好 —— 实施时核对该顺序）。
2. `entities.update` 的 ctx.player 增加 `velocity`：**用位置差分实测**
   （`(本帧pos − 上帧pos)/dt`，game.js 存 `_prevPlayerPos`），不读 `physics.vel`
   —— `step()` 末尾把 vel.x/z 清零，读它恒近 0。dt=0 时给 `[0,0,0]`。

### 3.4 帧序（不变）

`ignises.update`（寻路拍）→ `entities.update`（Agent + 物理）→ 消费 `attackRequest`
→ 渲染 `sync`。新行为全部在 Agent/渲染层内部，不新增帧序依赖。

---

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/entities/ignis/ignis-config.js` | §3.2 常量；`chaseSpeed` 改值 + 注释 |
| `src/entities/bosses/ignis-boss-agent.js` | 状态机加 `leap`；`_resolveStuck`；`acquireT/stuckT` 计时；yaw 逻辑重写（§2.1/2.8）；`_ringIntent` 去退让加 `tooClose`；两种飞跃的触发/空中/落地 |
| `src/entities/ignis/ignis-system.js` | `createState` 新字段；`overlapsAabb()` 查询 |
| `src/render/ignis-renderer.js` | StepLift 缓动 + dt + 测试钩子（§2.3） |
| `src/player/physics.js` | `this.ignises` 注入字段 + `_collides` 追加阻挡 |
| `src/core/game.js` | §3.3 两处接线 |
| `src/tests/test-ignis-boss-agent.js` | §5 用例（新增 + 改写 retreat 用例） |
| `src/tests/test-ignis-system.js` | chaseSpeed 断言改 4.4；`overlapsAabb` 用例；新字段保留用例 |
| `src/tests/test-ignis-render.js` | StepLift 三分支 + renderYOf 钩子用例 |
| `tests/ignis.spec.mjs` | E2E：阻挡玩家 / 跳劈命中 / 围困脱困 |

**不改**：烘焙器与产物（无新动画）⇒ 指纹门不受影响；`zombie-*`（复用不改语义）；
飞龙；命中结算链路（`hitRange/hitConeDeg/hitFrameSeconds` 全部不动）。

---

## 5. 测试计划（按 `docs/testing-policy.md` 分级）

### Tier 1（AI 热路径 ⇒ 必须 TDD，RED→GREEN→REFACTOR）

`test-ignis-boss-agent.js`（fake world / fake player 的纯函数驱动）：
1. idle 不追踪 yaw（玩家绕其移动，yaw 逐位不变）；
2. idle→chase 需 `turnDelay` 累计（1.4s 仍 idle / 1.6s 转 chase / 中途离开清零重来）；
3. 被埋 → `_resolveStuck` 抬到首个可站 y、vy 清零；未埋时位置逐位不变；
4. stuckT：有意图无进展累加、有进展清零；
5. stuckT ≥ 4s → leap(escape)：vy = leapJumpForce、水平 = 意图方向 × leapSpeed；
   落地回 chase、stuckT 已清；
6. leap 期与玩家距离 < inner → 水平意图清零（不穿过玩家）；
7. 跳劈触发窗：8~14 格内触发；<8 / >14 / 冷却中 / 无视线 / 非 onGround / 直路被挡 → 不触发；
8. 跳劈参数：静止玩家 ⇒ 水平速指向「玩家外侧 ≈4.6 格」、落点距玩家 ≈4.6；
   移动玩家 ⇒ 落点含速度预判（顺速度方向偏移 > 0）；
9. 跳劈落地前起劈：`vy<0 且 py ≤ leapTargetY+0.5` → attack + yaw 对准玩家；
   落地兜底同样进 attack；
10. 绕行朝向：navDir 侧向时 yaw 趋向速度方向（与玩家方向差 > 45°）；死区站定 yaw 趋向玩家；
11. 无退让：玩家贴到 inner 以内 → 意图为 0 且 `tooClose` 阻止 navDir 消费；
12. 数值不变式（§3.2 三条）。

`test-ignis-system.js`：
- `chaseSpeed === 4.4`（改冻结值，注释标裁定）；
- `overlapsAabb`：相交真 / 贴面假 / 无焰魔假 / 多焰魔逐一判定；
- `createState` 保留全部新字段（同 `_physAccum` 的既有用例手法）。

### Tier 4（渲染结果 ⇒ 实测，不得宣称目视）

`test-ignis-render.js`（浏览器内，真实 StepLift）：
- 物理 y 抬升 1 格 → `liftOffsetOf < 0` 且逐帧衰减归零；`renderYOf = physY + offset`；
- 物理 y 下降 → offset 立即 0；首帧（prevY=null）不触发；
- 负向验证：把 offset 写进 pivot 的那行去掉 → renderYOf 断言红。

### E2E（`tests/ignis.spec.mjs`，真实页面）

1. **不动如山**：召唤焰魔、玩家全速冲向它 3 秒 → 玩家中心距停在「身体盒表面 + 容差」
   （≥ ~1.0 格，钉上下界：也不得 > 3 格，防「根本没靠近」假绿）；焰魔位置漂移 < 0.5 格；
2. **跳跃劈砍**：玩家与焰魔相距 ~11 格站定 → 若干秒内出现 `mode==='leap' && leapKind==='attack'`，
   随后 `mode==='attack'`，且玩家最终被命中 ≥1 刀（每次命中后回满血防钳零）；
3. **围困脱困**：`editor.setBlock` 给焰魔垒一圈 3 格高石墙（它走不出也 step 不上）→
   8 秒内出现 `mode==='leap'`，且随后焰魔到墙外（或至少 y 升高越过墙顶）。

### 门禁

- `npm run check`（三门）+ 浏览器单测全量 + `tests/ignis.spec.mjs`；
- 动了 `player/physics.js`（热路径清单在列）⇒ 加跑 `npm run bench -- --check`
  （⚠️ frameP95 有 vsync 量子化噪声，回退判定用交替对照，不看单次红绿）；
- 负向验证（单变量、cp 副本还原）至少覆盖：retreat 加回 / turnDelay=0 /
  `_resolveStuck` 删除 / 跳劈触发窗去掉任一边界 / StepLift 不写矩阵。

---

## 6. 风险与已接受的边界

1. **跳劈落点是预判近似**：玩家急转/跳开时焰魔会落在空处 —— 这是原版
   `PredictiveCharge` 同款行为（预判固定时刻的位置），属玩法设计而非缺陷。
2. **escape 飞跃可能跳上玩家头顶高度**：水平守卫（§2.5）只限水平距；竖直重叠由
   落点物理决定，短暂重叠无伤害（焰魔无接触伤害），落地即分开。
3. **玩家传送进焰魔盒**：§2.7 已记，接受。
4. **两只焰魔互相穿越**：焰魔物理互不可见（与丧尸同口径），maxAlive=2 且站定环
   围绕同一玩家时可能重叠 —— 不在本次范围。
5. **移除 retreat 后玩家贴脸**：焰魔站定、玩家被身体盒挡住 —— 正是用户要的
   「不动如山」；玩家仍可绕后，焰魔转向受 turnRate 限制，符合巨兽手感。

## 7. 非目标

- 新动画/新音效/新烘焙（飞跃复用 idle 姿态 + 抛物线位移）；
- 焰魔破坏地形（垒墙困不住它的上限 = 跳得过的 2 格 + 寻路绕路）；
- 飞龙行为；焰魔的击退其他实体的能力；
- 多焰魔之间的分离力。

---

## 8. v2.63 迭代（用户验收后的三项反馈，2026-11-06）

用户原文三项：

1. 「焰魔绕行障碍物有 bug，绕行的时候有时候会卡住，当卡住的时候，**不管什么原因**，
   我要求焰魔都具备能主动脱困的能力，当卡住的时候，就**随机朝着一个方向大跳一下**，
   大跳的目的就是试图脱困，大跳完了之后继续回归到追逐玩家的逻辑上来。」
2. 「焰魔的行走速度还是过快，**再减少速度三分之一**。」
3. 「焰魔依然会在玩家跑动的过程中面向一直朝向玩家，我的要求是不要一直朝向玩家，加一个
   延迟，我想是不是可以这样做，这个延迟做成一个 **1 到 2 秒的时间间隔的对玩家位置的检测**，
   不是每时每刻都检测玩家位置，而是间隔最快 1 秒检测玩家位置，根据这个检测到的玩家位置
   进行位置移动和转向。」

### 8.1 绕行卡住的根因（systematic-debugging 定位，非猜测）

**根因**：v2.62 的 `stuckT` 判据要求「有非零意图但没走成」才计时，而存在一个**意图恒为零的
卡死态**：

| 条件 | 后果 |
|---|---|
| 焰魔与玩家的水平距恰好落在站定环死区 | `_ringIntent` 返回 `{vx:0, vz:0}` |
| 中间有墙 ⇒ `!losVisible` | `needsPath = true`，但… |
| A\* 给不出路线（玩家在另一层 / 超出 `PATHFIND.maxRadius` 24 格 / 四面围死） | `navMode='blocked'` ⇒ `navDir = null` |

⇒ 意图 0、位移 0、旧判据 `want > 1e-6` 恒假 ⇒ `stuckT` **永不累计** ⇒ 永久僵住。
复现用例：`test-ignis-boss-agent.js`「寻路无解（navDir=null）+ 死区内 → 仍会脱困」
（修复前 `stuckT` 恒 0，12 秒内不跳）。

**第二个根因**：v2.62 的脱困方向 = 「卡住瞬间的原始意图方向」—— 而那个方向正是**被挡住的
方向**（朝墙跳），跳完大概率仍在原地。这是「脱困跳了但没脱困」。

### 8.2 修法（三处）

**(a) `stuckT` 改棘轮式锚点**（`stuckAnchor` + `stuckNetDist = 1.5`）：不看意图，只看「有没有
真的走开」—— 距锚点 ≥ 1.5 格则把锚点推到当前位置并清零 `stuckT`，否则累计。覆盖两类旧判据
看不见的卡法：意图恒为零、贴墙振荡（每帧有位移但净位移 ≈ 0）。

**(b) 脱困方向改随机**（用户原文）：`theta = rng() × 2π`，`leapDir = [sin θ, cos θ] × leapSpeed`。
随机方向 + 落地回 chase（既有行为）= 「试一个方向，不行下次再试」，多次尝试后总能出来。

**(c) 「应该动却不动」门控**（⚠️ 实测踩到，三条用例同时红后加的）：光看净位移会把三种
**正确行为**误判成卡住：

| 误判场景 | 实测后果 |
|---|---|
| 死区站定（v2.60 用户明确要求「玩家站住不动就停住砍第二刀」） | 4 秒后随机跳，跳到 **4.18 格**（比 inner 4.25 还近，挤进玩家身体） |
| `idle` 态（玩家已逃出 `disengageRange`） | 站着不动是对的，却乱跳 |
| `attack` 态（作者原实现就是站定挥砍） | 挥砍中途乱跳 |

门控 = **`chase` 中，要么在走（意图非零），要么看得见玩家（随时能砍）** —— 两者都不满足才是
卡住。这恰好把 §8.1 的根因（死区 + 寻路无解 + **看不见**）与正常站定区分开：看不见 ⇒ 这一刀
砍不到 ⇒ 又不动 ⇒ 真的无事可做。

⚠️ **`stuckT` 语义随之变更**：从「卡住时长」变为「距上次确认进展的时长」。正常行走时它会在
`stuckNetDist / chaseSpeed ≈ 0.51s` 内锯齿波动（每走满 1.5 格棘轮重置）—— 故两条既有用例的
`stuckT === 0` 断言改为「峰值 < 阈值且永不触发脱困跳」（真正的契约）。

### 8.3 速度再降 1/3

`chaseSpeed: 4.4 → 2.93`（= 6.6 × 4/9，累计降 55.6%）。玩家跑步 8 格/秒 ⇒ 现在是焰魔的
**2.7 倍**（v2.62 时是 1.8 倍）。不变式复核：`standoffDeadband(0.75) > 2.93/60 ≈ 0.049` ✓；
`attackRange(5.5) ≥ standoffRange(5.0) + 0.049` ✓。

### 8.4 玩家位置感知间隔（1~2 秒）

**为什么 v2.62 的 `turnDelay` 没解决用户的问题**：它只门控了 `idle → chase` 的**重新锁定**，
一旦进入 chase 就每帧读真实玩家位置 ⇒ 追击途中仍然炮塔式跟着玩家转。用户要的是**追击途中
也不要实时跟随**。

**做法：感知快照 `sensedPlayer`** —— 每 `senseIntervalMin~Max`（1~2s，`rng` 随机取）采一次玩家
位置存进 state，**chase 的移动与转向一律读快照**，不读真实位置 ⇒ 焰魔追的是「1~2 秒前你在哪」，
转身也是一顿一顿的而不是连续跟随。

- ⚠️ **首次感知立即执行**（`sensedPlayer === null` 时不等间隔）：否则召唤后头 1~2 秒焰魔完全
  不动，且单帧驱动的既有用例会全部失效。
- ⚠️ **清空阈值用 `disengageRange`(60) 而不是 `sightRange`(50)**：两者之间是滞回带，焰魔仍在
  chase —— 此时清空快照会让它在这个带上完全停止移动（无目标）。

**两处例外用真实位置**（载荷性，不可改成快照）：

| 例外 | 理由 |
|---|---|
| 真重叠（`realDist < overlapEscapeDist`） | §2.7 的安全问题等不起 1~2 秒采样间隔 —— 玩家被冻在身体里时每多一秒就多挨一刀 |
| `attack` 起手当帧（`yaw` 立即对准真实玩家） | 快照最多陈旧 2 秒 × 玩家 8 格/秒 = **16 格误差**，用陈旧朝向起手会让命中锥（半角 35°）永远砍不中 —— 直接回退 v2.60 修的缺陷 |

语义上也说得通：**「追」是导航（可以迟钝），「砍」是已承诺的动作（必须准）**。

### 8.5 v2.63 新增/变更的常量与字段

| 项 | 值 | 说明 |
|---|---|---|
| `chaseSpeed` | 4.4 → **2.93** | 用户第二次裁定减速 |
| `stuckNetDist` | **1.5** | 取代 `stuckProgressRatio`（棘轮阈：4s 内走满 1.5 格才不算卡住） |
| `stuckProgressRatio` | ~~0.15~~ **删除** | 旧判据（意图 vs 位移）已被棘轮取代 |
| `senseIntervalMin` / `Max` | **1.0 / 2.0** | 用户原文「1 到 2 秒的时间间隔……最快 1 秒」 |
| state `stuckAnchor` | `[x,z]\|null` | 棘轮锚点（跨帧累积，必须在 `createState` 保留） |
| state `sensedPlayer` | `[x,y,z]\|null` | 感知快照（同上） |
| state `senseTimer` | number | 下次感知倒计时（同上） |

⚠️ 三个新字段都是**跨帧累积量**，丢掉任一个的后果：`stuckAnchor` ⇒ 每帧重初始化 ⇒ `stuckT`
永不累计 ⇒ 脱困失效；`sensedPlayer`/`senseTimer` ⇒ 每帧重采 ⇒ 感知间隔失效 ⇒ 用户报告的问题
原样复活。守卫：`test-ignis-system.js`「createState 保留全部行为新字段」。

### 8.6 v2.63 测试

**Tier 1 单测**（`test-ignis-boss-agent.js`）：根因复现（寻路无解 + 死区 → 仍脱困）、脱困方向
随机性（四个 rng 给四个不同方向 + 长度恒为 `leapSpeed`）、追逃跑玩家不误判、贴墙振荡算卡住、
感知快照（玩家瞬移后仍朝旧方向走 → 刷新后转身）、攻击用真实位置不用陈旧快照。

**E2E**（`tests/ignis.spec.mjs`「感知间隔」）三层判据：① 4 秒内快照刷新 ≤ 6 次（每帧刷新 =
机制失效）；② 快照与真实位置最大滞后 > 2 格；③ **行为**：`yaw` 与「朝真实玩家」的最大夹角
> 8.6°（每帧跟随时恒 ≈ 0）。实测：刷新 3 次 / 滞后 **15.87 格**（= 8 格/秒 × 2 秒，与间隔精确
吻合）/ 最大夹角 **45°**、平均 13.7°。

⚠️ **判据③的踩坑**：初版写「行进方向更贴近朝快照而不是朝真实玩家」—— 实测**假阴性**
（0.35 vs 0.25，方向反了）。根因：玩家横跑、焰魔纵追时，两个方向在 -Z 主轴上夹角都只有
0.2~0.3 rad，细微比较被 navDir/steering 噪声淹没。改为直接量用户抱怨的那个量（yaw 偏离）。


## 9. v2.78：玩家被身体盒「扫到」后四轴冻结（用户缺陷：跑太近就卡死）

**用户 2026-11-07**：「玩家跑进焰魔的时候，跑的太近就会和焰魔靠在一起，然后玩家就不能动弹了，跳也不行，
前后左右都无法动弹，是发生穿模了吗？……是玩家和焰魔靠的太近导致穿模，进而导致玩家被卡住了吗？」

### 9.1 回答：是穿模，但方向是「盒子穿过了玩家」

不是玩家自己跑进了焰魔 —— 玩家撞上盒子会被正常挡住（§2.7 (a)）。真正的路径是：**焰魔转身时它的阻挡盒变大、
扫过站得近的玩家，玩家变成「在盒子里面」**。玩家物理把盒子当实心，而「在盒子里面」时每个候选位置都仍然重叠，
所以前后左右和跳全部被拒 —— 玩家看上去就是被焊死在焰魔身上。

### 9.2 根因（真实游戏实测，不是几何推演）

| 环节 | 事实 |
|---|---|
| 盒子形状 | `ignisAabbFor` = 身体 OBB 绕 `yaw` 旋转后的**轴对齐包围盒**，随朝向变形。重叠区（玩家中心）单边：yaw=0° 时 X±1.13 / Z±1.22，**45° 时 ±1.54**（`IGNIS_CORE_OBB` 半长 `[0.8264, 1.4637, 0.7125]`、中心 z 偏 −0.2095） |
| 谁让盒子动 | 焰魔醒来 / 追击 / 起手都会转向玩家（实测 yaw 0° → −126°），盒子随之扫过去 |
| 玩家侧 | `_collides()` 把盒子当实心，**没有「已经在里面」的分支** ⇒ 每个候选位置都重叠 ⇒ 四轴 + 跳跃全拒。单步位移 `SPEED/60 = 0.133` 格，而斜角站位被扫到的陷入深度 **0.3~0.46 格**（朝向差 45°~60°），更深可到 0.73 |
| 焰魔侧自愈 | v2.62 的 `overlapEscapeDist = 1.15` 是个**固定距离的圆盘**、且仅 `chase` 态。它只盖住重叠区的 **54%（45°）~82%（0°）**；玩家贴在盒斜角外时 `d ≈ 1.4`，**永不触发**；`attack` 态焰魔站定更不会退 |
| 复现（seed=12345，真实 AI + 真实输入） | 玩家站在 yaw=0 盒的斜角外（`d = 1.397`，`overlap=false`），焰魔醒来转到 −126°：之后 **30/40 帧 `overlap=true`**，`d` 始终 1.397，W/S/A/D/Space 六个键位移**全是 0** —— 与用户描述一字不差 |

对照：同一场景只陷入 0.037 格（玩家贴在盒的正侧面）时，朝外的键仍能脱身（陷入 < 单步位移），沿 Z 的键冻结 ——
所以用户遇到的「全方向都不行」对应更深的陷入，即斜角站位。

### 9.3 修法：玩家物理自己兜底（`PlayerPhysics._ejectFromIgnis`）

`step()` 开头：若 `ignises.overlapsAabb(自己的盒)` 为真，沿 ±X / ±Z 四个方向各自探「第一次让该判据为假」的平移量，
取最短且不会嵌进方块的那个，以 `IGNIS_EJECT_SPEED · dt` 的上限推出去。

- **用同一个判据**：冻结的条件是 `overlapsAabb` 为真，推出的终点就是它第一次为假的位置 ⇒ 与阻挡判据**按构造一致**，
  不复制焰魔盒几何，也就不会再出现「自愈用的几何与阻挡用的几何对不上」（旧自愈的固定距离阈值正是这么失效的）。
- **有界速度**：`IGNIS_EJECT_SPEED = 9` 格/秒（0.15 格/步）。要快过盒子扫过来的速度（焰魔追击 4.4、转身时盒边约 3~4 格/秒），
  又要像被顶开而不是瞬移（0.35 格深约 50ms 推完）。
- **不嵌进方块**：出口位置用 `collidesAt`（只查方块）校验，被墙堵住的方向放弃、改走次近的。
- **不改「不动如山」**：朝盒子里走仍被 `_collides()` 挡住，本方法只处理「已经在里面」。
- **不重叠的帧只多一次 `overlapsAabb`**（`_ignisIds.size === 0` 时直接返回 false）。

**被否决的方案**

| 方案 | 否决理由 |
|---|---|
| 调大 `overlapEscapeDist` 去补这个洞 | 它是焰魔后退的触发阈值，调大会让焰魔在**正常贴近**时也后退 ⇒ 反转用户第⑦项「不动如山」；而且只在 `chase` 态生效、焰魔可能被墙堵着退不开 |
| 让阻挡盒不随 yaw 变形（取最坏情形的固定盒 / 圆柱） | 玩家在焰魔 yaw=0 时会隔空被挡 0.4 格，违背既有裁定「用身体盒（可见躯干）而不是粗碰撞盒，否则玩家隔空被挡」 |
| 已在盒内时允许任意方向移动（ghost until clear） | 玩家可以往盒子深处走；且 `_collides()` 要拿到旧位置比较陷入深度，改动面大于推出 |
| 服务侧新增解析 MTV 接口 | 要在 service 里再写一遍 AABB 相交数学，与阻挡判据成两份几何；探测法零新接口、按构造一致 |

### 9.4 测试与验证

- **单测**（`test-physics.js`，+5）：盒子扫过玩家后被推出且不再冻结（含朝盒里走仍被挡、起跳可离地）/ 走最近的面 /
  最近的面被墙堵住走次近的且不嵌进方块 / 不重叠含贴面时一动不动 / 盒边持续扫过时每一步都不冻死。
- **E2E**（`tests/ignis.spec.mjs`，+1）：真实 service + 真实键盘输入 + 真实物理，焰魔朝向钉在「已转身面向玩家」的终态。
  **修复后（3 次）重叠采样 0/40、玩家被推开 0.29~0.40 格（= 陷入深度）、S/A/D 位移 4.6~4.9 格、起跳抬升 1.56 格**，
  W 朝焰魔走沿盒面滑行（2.3~3.0 格）但不陷入；**关掉推出：一次 40/40 被罩住且五个键位移全 0，另一次 13/40
  （焰魔自己走开后才解除）**，两次都红。既有「不动如山」`minDist` 1.370 → 1.369（语义未变）。
  ⚠️ **初版让 AI 自然转身来制造「盒子扫到玩家」是非确定性的**（同一场景有的运行转到 −126°、有的转到 160°，
  后者盒子压根没扫到），负向对照实测**关掉修复后用例仍通过**（空洞）。故改为钉死朝向（每 20ms 重置）并显式断言
  「场景有效」（观察到重叠或玩家被推开 ≥ 0.1 格）；重叠判据钉「后 2 秒 0 次」+「全程 ≤ 4」（修复后 0 与修复前最小 13 之间）。
- **负向验证**：6 处单变量注入（不调用 / 不限速 / 方向反 / 不校验方块 / 探测上限过小 / 不重叠也推）每处至少一条变红，
  E2E 关掉推出即红；还原一律 `cp` 副本 + sha256 核对。

### 9.5 已知边界（未做）

- 玩家被夹在焰魔与墙之间、且四个水平方向的出口都被方块堵住时仍推不出（极端，维持原状：冻结）。竖直方向不处理（盒子竖直扫到
  玩家时水平推出已足够解冻）。
- `overlapEscapeDist` 与 Agent 侧后退保留不动，只是不再是唯一防线（见 `ignis-config.js` 里该常量的 v2.78 补记）。
