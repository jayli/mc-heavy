# 焰魔第二招：整圈旋斩（Bedrock `attack8a3` / Java `SPIN_ATTACK`）设计

日期：2026-11-07 · 状态：待审阅 · 前置：`2026-11-05-ignis-boss-design.md`（v2.55）、`2026-11-06-ignis-behavior-polish-design.md`（v2.62/v2.63）

## 1. 需求与裁定

用户 2026-11-07：「焰魔的劈砍动作只有一个，就是蓄力→挥刀。想再增加一个焰魔的攻击动作……
`~/jaylli/cataclysm1.19.2modding` 里有焰魔的攻击动作，找一个和目前实现的劈砍动作**不同**的补充进来。」

三项裁定（用户答问，2026-11-07）：

| 问题 | 裁定 |
|---|---|
| 选哪一支 | **整圈旋斩** —— Java `SPIN_ATTACK`（38 tick）↔ Bedrock `attack8a3`（1.9s） |
| 何时用 | **每次起手按权重随机** |
| 数值口径 | **照原版**：同伤害（14）+ 原版射程/角度/命中帧 |

**本版零新增美术资源**：`assets/ignis/src/ignis.animation.json` 里本就含这 84 条动画，
本版只是让烘焙器多取其中一条（数据格式转换，与 `npm run ignis` 既有语义一致）。

## 2. 素材鉴别（实测，不是目测）

38 tick 在素材里有 4 条长度相同的候选，配对**必须按关键帧数值**定，不能按名字猜：

| 素材 | t=0 起手 `root.y` / `sword.x` | 与 Java 的对应 |
|---|---|---|
| **`attack8a3`** | −75° / 180° | **= `SPIN_ATTACK` 非破盾分支**（t=0.0 与 t=0.5 九个骨骼**逐位相等**） |
| `attack8b3` | −82.5° / 180° | = `SPIN_ATTACK` **破盾**分支（`getIsShieldBreak()` 那一支） |
| `attack8a2` / `attack8b2` | −27.5° / 0° | = `HORIZONTAL_SMALL_SWING_ALT_ATTACK2`（同 38 tick 的另一招） |

复现命令（本题已跑）：对 `attack8a3` / `attack8b3` / `attack8a2` / `attack8b2` 打印 `root`/`upperbody`/
`right_arm_joint`/`right_hand`/`right_fist`/`sword`/`head`/`left_arm_joint`/`left_hand` 在 t=0.0/0.5/0.85 的
关键帧，与 `ModelIgnis.java:2099` 起的 `animator.rotate(...)` 序列比对。`attack8a3` 在 t=0.0、0.5 全等；
t=0.85 的差异来自 Bedrock 把该段关键帧放在 0.9（重采样偏移），不是配对错误。

**为什么是它而不是 `attack3a`（地裂，138 tick）**：后者 6.9 秒，是阶段技（`EARTH_SHUDDERS_COOLDOWN = 800 tick`），
不适合当作普攻池里的第二招。

## 3. 招式形态（实测关键帧，单位度）

```
root.rotation.y      -75 ──0.3s──▶ +52.5 ──0.9s──▶ 357.5（= −2.5，净转角 +282.5°）
upperbody.rotation.y -37.5 ─▶ -10（躯干反向拧，避免跟着转一圈）
sword.rotation.x     180（横持，剑身与地面平行）──0.5s──▶ 0
```

剪影语义：起手把剑**横持于左后侧**、躯干左拧 −37.5°（蓄力），随后**整个身体绕竖轴扫一圈**把剑甩过身前，
末段回正。与现有 `attack6a`（前后方向的蓄力横扫、`root.y` 只走 +7.5 → −65）在剪影上几乎正交。

## 4. 玩法数值（取自 `Ignis_Entity.aiStep()` 的 `SPIN_ATTACK` 分支）

| 项 | 作者原值 | 本仓落地 |
|---|---|---|
| 命中时刻 | `getAnimationTick() == 14` | `hitFrameSeconds = 14/20 = 0.70` 秒 |
| 射程 | `AreaAttack(6.5, ...)` | `hitRange = 6.5`（与横扫同值，**不是巧合**：两招同一 `area` 口径） |
| 角度 | `arc = 310` | **`hitConeDeg = 155`**（半角；`AreaAttack` 判的是 `|Δ| ≤ arc/2`） |
| 伤害 | `damage = 1.0` × `ATTACK_DAMAGE(14)` | **14**（与横扫同值 ⇒ 仍是「两下必死」） |
| 动画时长 | 38 tick | `animSeconds = 1.9`（= 产物 `frameCount / fps`） |

⚠️ **310 不是 360**：作者刻意留了 50° 的**死角**（背向）。半角必须写 155 而不是 180 —— 写成 180 会让
「绕到背后」这一唯一的安全位置消失，而**没有任何断言会红**（`test-ignis-system.js` 只守了 `hitConeDeg < 70`
这一条防「把 arc 当半角」的守卫，需要为旋斩补一条对应的守卫）。

⚠️ **同伤害 + 更大角度 ⇒ 旋斩严格更强**，这是用户裁定的「照原版」。代价是它更慢（起手到命中 0.70s 但
总时长 1.9s，且 `spinCooldownSeconds = 8.0` 独立冷却，约等于两次普攻间隔一次）。

## 5. 架构改动

红线 1（同一事实只有一份权威）决定四个数字（命中帧 / 射程 / 角度 / 时长）必须来自**同一张表**，
而不是各写两处常量。故把 `IGNIS_AI` 里那四项重构成「攻击档案表 + 派生」：

```
IGNIS_ATTACKS = {                // 唯一权威：每招的全部玩法数值
  swing: { hitRange: 6.5, hitConeDeg: 35, hitFrameSeconds: 1.20, animSeconds: 2.75, weight: 0.7 },
  spin:  { hitRange: 6.5, hitConeDeg: 155, hitFrameSeconds: 0.70, animSeconds: 1.90, weight: 0.3 },
}
IGNIS_AI.hitRange/hitConeDeg/hitFrameSeconds/attackAnimSeconds  // 保留 = 各招的**最大值**派生
```

**为什么保留 `IGNIS_AI.hitRange` 等四个字段**：它们已被既有断言、E2E、注释大量引用，且既有语义是
「最宽的那一招」（玩家读作「最远/最宽能打到多远」）。改成派生（`Math.max(...)`）比删掉它们更安全：
删掉会让 6 处既有断言与 3 处 E2E 直接找不到字段。

改动清单（文件级）：

| 文件 | 改什么 |
|---|---|
| `tools/ignis-fingerprint.mjs` | `IGNIS_ANIM_PERIODS` 加 `spin: 1.9`；`IGNIS_ANIM_SOURCES` 加 `spin: ['attack8a3']`；`IGNIS_ANIM_PERIODS.attack` → 改名不必要，但新增 `ATTACK_KEYS` 一致性守卫 |
| `tools/bake-ignis.mjs` | 泛化「attack 段」为对 `IGNIS_ANIM_SOURCES` 里每个攻击键各跑一次 `resampleAnimation`；`footscan` 扫全部动画（本来就是） |
| `tools/check-data.mjs` | 动画清单断言 `attack,idle` → `attack,idle,spin`；每条的 `frameCount == round(period × fps)` 循环校验 |
| `src/entities/ignis/ignis-config.js` | 新增 `IGNIS_ATTACKS` + `IGNIS_ATTACK_IDS`；`IGNIS_AI` 的四项改为派生；新增 `spinCooldownSeconds`、`spinWeight` |
| `src/entities/bosses/ignis-boss-agent.js` | state 增 `attackKind`（`'swing' \| 'spin'`）；起手时按权重抽签 + 各自冷却；命中帧/时长/角度改为读**本招**的档案 |
| `src/entities/ignis/ignis-system.js` | `createState` 增 `attackKind`（含非法值回落 `'swing'` 的守卫） |
| `src/render/ignis-model.js` | 新增导出 `sampleIgnisAttackOnce` 的泛化（现有 `sampleIgnisAttack` 已足够 —— 它按传入的 `anim` 采样，不需要改；只补注释） |
| `src/render/ignis-renderer.js` | 动画选择：`attackKind === 'spin'` → `animations.spin`，否则 `animations.attack` |
| `src/core/game.js` | `_consumeIgnisAttackRequests` 读 `req.kind` 决定用哪套 `hitRange` / `hitConeDeg` |
| 测试 | 见 §7 |

## 6. 关键判据与陷阱

1. **`attackKind` 是跨帧累积量**（同 `leapKind` 的教训）：命中结算发生在动画中段，必须知道「这一刀是哪一招」。
   ⚠️ 但 **命中判据不能只靠 state 字段**：`attackRequest` 已经是一个瞬态对象，把 `kind` 一起装进去
   （`{ at, yaw, kind }`）比让结算方回读 state 更安全 —— 回读会在「下一帧 state 已切回 chase」时读到错值。
   **两者都写**：`state.attackKind` 供渲染器选动画，`attackRequest.kind` 供结算方取值。
2. ~~**`feetOffsetY` 会因新动画漂移**~~ —— **该预测已被真实烘焙实测否决，保留记录作为教训**。
   设计期的推演：现有 −0.265625 来自 idle；旋斩最低身体顶点 0.26347 ⇒ 全局最低点从 0.265625 降到
   0.26347 ⇒ 需把 `IGNIS_CORE_OBB.center[1]` 从 1.5106 重标到 1.5131。
   **实测（2026-11-07 `npm run ignis`）：`feetOffsetY` 仍是 −0.265625，一个数都没动。**
   错因：那个探针把「动画增量四元数」当成「总旋转」直接用，算出了另一组姿态；烘焙器走的是
   `bind × delta` 还原总旋转，idle 的 0.265625 仍是全局最低点（旋斩那一帧是 0.26347，**高于** idle）。
   **教训**：设计期用自写探针推出的「冻结值会变」必须在真实烘焙器上复核一次再写进文档 —— 否则
   下游会照着不存在的需要去改冻结基线（那等于偷偷改基线）。
3. **冷却分轨**：`attackCooldownMin/Max` 仍是普攻冷却；旋斩用 `spinCooldownSeconds = 8.0`（叠加在普攻
   冷却之上）。⚠️ 若只用一个冷却，「每次起手按权重随机」退化成「冷却一好就抽签」，抽中旋斩的概率被
   普攻的高频重复放大 ⇒ 观感是「旋斩连着放」。
4. **权重必须可注入**：`rng()` 已是构造参数，抽签走 `rng()`，测试钉两个端点（`rng()=0` ⇒ 恒 swing，
   `rng()=0.999` ⇒ 恒 spin）。
5. **`attackAnimSeconds` 的派生语义**：既有断言 `attackCooldownMin > attackAnimSeconds`（3.5 > 2.75）
   在派生为 `max(2.75, 1.9) = 2.75` 后仍成立；若旋斩动画更长（本版不是），该不变式会保护它。
6. **渲染层按 `attackKind` 选动画**：`spin` ⇒ `animations.spin`，否则 `animations.attack`；`attackAnimT > 0`
   仍是「是否在攻击」的门控（两者不是同一件事）。缺 `attackKind`（旧调用方）回落 `attack`。
   ⚠️ 只判 `attackAnimT > 0` 的形态是「旋斩演成横扫」，而「有动画在播」类断言全绿。
7. **`attackRequest` 的瞬态性有两个下游后果**（实测踩到）：
   - 结算方必须读 `req.kind`，**不能回读 `state.attackKind`**（下一帧可能已切回 chase）；
   - **E2E 不能靠「往 state 里塞 request」驱动**：`ignisDefinition.update` 每帧返回
     `attackRequest: null`，会把注入值覆写掉 —— 实测形态是「注入后所有角度都不掉血（含 0°）」，
     当时误以为是锥宽算错。正确做法：塞进去 → **同步**调一次 `game._consumeIgnisAttackRequests()`。
8. **`{pre, post}` 关键帧形态**（本版新发现的素材特性）：`attack8a3` 的 `root` 在 t=1.4 写作
   `{"pre": [0, 357.5, 0], "post": [0, -2.5, 0]}`（同一朝向的两种表示：转完一圈写成归零）。
   烘焙器取 **post** ⇒ 0.9→1.4 的插值是净转一圈的弧；取 pre 会变成「倒着转回去」。
   全素材共 8 处这种形态，`attack6a` 一处也没有（旧烘焙器从未遇到，直接 `fail`）。

## 7. 测试计划（Tier 1 TDD + Tier 2 门禁 + Tier 4 像素）

| 级别 | 用例 |
|---|---|
| Tier 2（产物契约） | `test-ignis-bake.js`：动画清单 = `attack,idle,spin`；spin 帧数 = `round(1.9 × 30)`；spin 的 `root.y` 净转角 > 270°（钉住「真的转了一圈」，防止误接成 `attack8a1` 这类同族小横扫） |
| Tier 1（配置） | `test-ignis-system.js`：`IGNIS_ATTACKS.spin.hitConeDeg === 155` 且 `< 180`（死角守卫）；两招 `animSeconds == frameCount/fps` 对账；派生四项 = 各招最大值 |
| Tier 1（状态机） | `test-ignis-boss-agent.js`：`rng=0` 恒选 swing / `rng=0.999` 恒选 spin；旋斩命中帧 = 0.70±0.03；命中后 `attackRequest.kind === 'spin'`；旋斩播完回 chase 且 `attackKind` 清空；旋斩冷却期间不再选旋斩 |
| Tier 4（画面） | `tests/ignis.spec.mjs`：`attackKind='spin'` 时画面与 `attack6a` **显著不同**（差分 > 阈值，且变化横跨身体左右两侧 —— 旋斩的剑会扫到左半屏，横扫不会） |

负向验证（手工，单变量注入）：把 `spin` 档案的 `hitConeDeg` 改成 180 ⇒ 死角守卫必须红；把渲染器选动画
改回恒 `attack` ⇒ 像素差分用例必须红。

## 8. 不做的事

- 不做破盾变体（`attack8b3`）、不做 SOUL / 狂暴阶段（本仓尚无阶段机）。
- 不做「连击收招」（`CanSpin ≥ 2` 触发）—— 用户已裁定按权重随机。
- 不改命中伤害（仍是 14，两下必死，用户已确认）。
## 9. 起手衔接（v2.76，用户缺陷：旋斩起手一帧硬切）

**用户 2026-11-07**（录像 `焰魔旋转.mov` 1.13s）：「身体本来是站定的，突然就切换到身体旋转举刀的形态了，
中间没有补间过渡 …… 我要求有一个过渡动画，不要闪动切过去，导致的身体动作不连贯」。

### 9.1 根因（实测，不是目测）

| 证据 | 内容 |
|---|---|
| 录像逐帧（原生时间戳） | n=9（t=1.117s）站定 → n=10（t=1.133s）已是旋斩起手姿态：**相邻两帧（16.7ms）整副骨架跳变** |
| 真实烘焙产物 + 真实采样函数 | idle → spin(t=1/60) 单帧最大骨骼角 **177.1°**（`sword`；`right_hand` 86°、`root` 75°、`left_arm_joint` 74°）；旋斩自身最快的合法单帧仅 **24.5°**（`root`，快旋段）。对照：挥砍入场 5.0°，挥砍/旋斩离场 5.3°/6.0° —— **只有旋斩入场暴露** |
| 代码 | `ignis-renderer.js` 按 `attackAnimT > 0` 在 idle 与攻击片段间**硬切**，渲染层没有任何混合状态 |
| 原版（`~/jaylli/cataclysm1.19.2modding`） | `ModelIgnis.java:2101` `SPIN_ATTACK` 的**首关键帧是 `startKeyframe(0)`**（瞬间到位；对比 `SWING_ATTACK` 首关键帧 `startKeyframe(12)` = 0.6s 从静止缓入）；`Ignis_Entity.java:2297-2299`：旋斩**只会**由 `HORIZONTAL_SMALL_SWING_ALT_ATTACK2` 在 `follow_through_tick` 且 `CanSpin >= 2` 时接上 |

**结论**：不是烘焙错、也不是素材错。旋斩的 t=0 姿态（`root.y −75°` / `sword.x 180°` / `upperbody.y −37.5°` …）本来就是
「接在上一招收势后面」的**衔接姿态**；原版从不让它从站立起手。本仓按用户裁定「每次起手按权重随机」（§1）让它从站立
直接起手，暴露了原版靠连招藏住的瞬切。挥砍没有这个问题，是因为它的首关键帧本来就是从静止姿态缓入（已烘进 `attack` 的数据）。

### 9.2 方案：渲染层「快照淡入」（纯视觉、时间中性）

逐实例的 `IgnisPoseTransition`（`ignis-model.js`）：来源（`idle` / `attack` / `spin`）切换时，把**上一帧实际发布的姿态**
冻结成起点，用 smoothstep 权重在 `IGNIS_POSE_BLEND.seconds`（0.2s）内混向新来源的**实时**采样。

- **时间中性**：片段时钟不被推迟 ⇒ `hitFrameSeconds`（0.70 / 1.20）、`animSeconds`、冷却**一概未动**，没有任何冻结数字变更。
- **起点取「上一帧的输出」而非「上一个来源的采样」**：淡入中途被再次打断也从当前混合结果起步，连续性对任意切换序列成立。
- **骨骼集合取并集，缺席一侧按单位增量**（与 `sampleDragonPose` 同口径）：idle 只驱动 6 根骨骼，旋斩驱动 9 根（其中 5 根 idle
  不驱动，如 `sword`）。渲染器只写「本帧姿态里出现的骨骼」，所以走满淡入的那一帧必须按并集 `w=1` 发布一次，让「起点驱动而目标
  不驱动」的骨骼以单位增量回到 bind，之后才可以离开输出。
- **纯视觉层**：权威 `state`（`attackAnimT` / 命中帧）仍瞬时，与 v2.62 上台阶缓动同一分工（红线 1）。入场与离场走同一条代码路径。

### 9.3 `IGNIS_POSE_BLEND.seconds = 0.2` 的取值推导（约束式）

真实烘焙产物 + 60fps + 8 档 idle 相位模拟（`smoothstep`，最坏骨骼均为 `sword`）：

| D（秒） | 0.10 | 0.12 | 0.15 | 0.18 | **0.20** | 0.25 | 0.30 |
|---|---|---|---|---|---|---|---|
| 补间期单帧最大骨骼角 | 39.8° | 32.6° | 25.0° | 19.8° | **17.2°** | 12.8° | 9.8° |

- **下界**：补间期单帧角 ≤ 旋斩自身合法上限 24.5°，否则补间自己成了新的「抖动」⇒ D ≥ ~0.155s（0.15s 时 25.0° 刚好越线）。
- **上界**：不得把「举刀蓄力」吃掉。旋斩起手 `sword` 绕 X 的角随 t 缓降：0.20s = 112°、0.25s = 90°、0.50s = 0°；淡入结束时剑若已落到
  90° 以下，观感是「还没举起来就开始转」⇒ D ≤ 0.25s。
- 取 **0.20s**：两侧都留余量（单帧角 = 合法上限的 70%；淡入结束时剑仍抬在 112°）。
- **v2.77 起旋斩入场改为 0.6s（用户裁定），上面「D ≤ 0.25s」的上界被这条裁定覆盖**，见 §9.8；本节推导仍适用于其余切换（0.2s）。

### 9.4 取舍（需要用户知道）与被否决的方案

**时间中性的代价**：起手最初 0.2s 里片段本身在往前走，所以「举刀」被混合稀释 —— 淡入结束时剑在 112° 而不是 P0 的 180°。
若想**先完整看到 P0 举刀再转**，要用下面的「预滚」，而它会改冻结数字（命中帧后移约 D）。
**用户 2026-11-07 裁定：保持时间中性淡入，不做预滚**（命中帧仍 0.70 / 1.20，冻结数字不动）。

| 方案 | 结论 |
|---|---|
| 给烘焙产物前缀一段「静止 → P0」补间（像 `SWING_ATTACK` 的 `startKeyframe(12)`） | 否决：命中帧后移 + 总时长变长（动 `hitFrameSeconds 0.70`、`animSeconds = frameCount/fps` 两个冻结口径），且要重烘焙 + 改指纹 |
| 渲染层「预滚」：先补间到 P0，再从 t=0 播片段 | 同上：命中帧后移约 D。若要完整的 P0 举刀，这是唯一不改素材的路径，需先裁定命中帧后移多少（**用户已裁定不做**） |
| 对片段做分段时间扭曲（压缩 0~0.55s 蓄力段，保住 0.70s 命中帧） | 否决：改写原作者的节奏，复杂度高于收益 |
| **渲染层快照淡入（采用）** | 零冻结数字变更、零素材变更、不重烘焙；覆盖入场/离场/被打断/实例复用 |

### 9.5 顺带收敛的两个既有缺陷（同一根因族）

根因都是「渲染器只写当前来源驱动的骨骼，没被写到的骨骼保持上一次的值」：

1. **攻击被中断后骨骼卡姿态**：旋斩播到一半被打断（LOS 丢失 / 玩家跑出 `disengageRange` ⇒ Agent 把 `attackAnimT` 清零）后，只被攻击片段
   驱动的 `sword` / `upperbody` / … 永远停在中途姿态直到下一次攻击（实测 `upperbody` 偏离 bind **29.1°**）。并集 + 单位增量一并解决。
2. **实例复用残留上一只的姿态**（与 v2.62 P1-2 的 `prevY/lift` 同类）：上一只死于旋斩中途时，新实体首帧实测残留 **112.4°**。
   复用时 `transition.reset()` + `_restoreBindPose()`。

### 9.6 测试与验证

- **单测**（`test-ignis-render.js`，+17）：混合数学（端点 / 并集 / 最短弧 / 不改入参）、过渡器语义（首帧 / 切换当帧 / 中点 / 缓入缓出 /
  并集骨骼不卡姿态 / 被打断 / 超长帧与 reset）、真实产物判据（入场 spin / 入场 swing / 离场 / 时长上界）、渲染器级（用户缺陷本体 /
  中断后回 bind / 实例复用 / 多实例独立）。既有 3 条用例（`attackAnimT>0 用 attack`、`attackKind=spin 选片段`、`bone position 随旋转重算`）
  原先依赖「同一 `nowMs=0` 下一次 `sync` 就得到攻击姿态」，现补「先走满淡入」的取稳态步骤，**断言本身未动**。
- **E2E**（`tests/ignis.spec.mjs`，+1；既有 2 条用例的 3 处「注入 state → 手动 `sync` → 读骨骼/截图」补了页面内取稳态辅助
  `installSettle`，断言未动）：真实游戏页自己的 rAF 循环经真实 `IgnisRenderer.sync(nowMs)` 发布，只读
  `bones[i].quaternion`，按真实帧间隔换算角速度。**实测**：带修复最大 **1585°/s**（上限 = 片段自身合法上限的 2 倍 = 2937°/s）；
  注入回退（绕过过渡器）**17502°/s**（单帧 178.5°）。
- **负向验证**：10 处单变量注入（绕过过渡器 / 走满帧丢并集 / dt 单位错 / 复用不 reset / 复用不恢复 bind / 多实例共享过渡器 /
  被打断仍从旧起点 / 线性权重 / 丢目标独有骨骼 / 切换不清 elapsed）+ E2E 1 处，**每处至少一条用例变红**；还原一律 `cp` 副本 + sha256 核对。
- **逐帧截图对照**（停游戏循环 + 合成 60fps 时钟，同一场景同一相机）：旧版起手第 1 帧（16.7ms）整副姿态已甩到蓄力形态；新版逐帧连续，
  第 20 帧（0.33s）与旧版画面一致（淡入走满后完全回到原片段）。

### 9.7 测试自身踩到的两个坑（负向验证与「出乎意料的数值先怀疑测量方法」找出来的）

1. **`2·acos(|dot|)` 在 1 附近病态**：两个**完全相同**、长度却为 `1−1e-16` 的四元数会得到约 1.7e-6° 的「假差异」，把「逐位相同」类断言
   （阈值 1e-9°）判红 —— 多实例用例在**旧代码**第 0 帧就红，而页面里读出的两份姿态 `|dot|=1`。改用相对旋转 `2·atan2(|r.xyz|, |r.w|)`。
2. **`1/60` 连加 12 次是 `0.19999999999999998`（< 0.2）**：「走满」被推迟一帧，而上一帧权重已是 `1−1e-16`、残留仅 ~1e-14°，
   把「走满帧丢掉并集」的注入**藏了起来**（注入后该用例仍绿）。改用 0.03s 一帧（0.21s 越线、上一帧权重 0.972、残留约 3°）。

### 9.8 v2.77：旋斩入场淡入 0.2s → 0.6s（用户裁定，只改入场）

**用户 2026-11-07**：「旋斩起手的动作过渡从 0.2s 改为 0.6s」。

**范围**：只改**旋斩入场**。挥砍入场、各招收招回 idle、被打断回 idle 仍是 0.2s。实现上「哪个来源用哪个时长」按**目标来源**取，
单一权威 `ignisBlendSeconds(sourceKey)`（`ignis-config.js`；渲染器与测试共用，测试不得各写一份映射）：
`IGNIS_POSE_BLEND.spinInSeconds = 0.6`（淡入 `'spin'`），其余 `IGNIS_POSE_BLEND.seconds = 0.2`。
`IgnisPoseTransition.step(key, target, dt, seconds)` 的第 4 个参数是**本次切换**的时长，**切换时锁定**、不传则用构造默认值。

**实测后果（真实产物，60fps，8 档 idle 相位）——这是有意的取舍，不是中性改动**

| 淡入时长 | 补间期单帧最大骨骼角 | 淡入期内**显示的** `sword` 峰值 | 淡入走完 |
|---|---|---|---|
| 0.2s | 17.2° | 117.5°（躯干 root 36°） | 0.20s |
| **0.6s** | 18.8°（已含 0.55s 起片段自身的快旋，仍 ≤ 合法上限 24.5°） | **34.4°**（root 53°） | 0.60s（命中帧 0.70s 之前 0.10s） |

0.6s 时「举刀」几乎不再露出（剑只抬到 34°），躯干扭转仍有 53°。§9.3 里我为保住举刀幅度自拟的上界「D ≤ 0.25s」被这条裁定覆盖。
**仍然成立的硬约束只剩一条：淡入必须在命中帧之前走完**（命中那一刻画面里要是完整的旋斩姿态）。想改回/微调只改 `spinInSeconds` 一个数。

**测试调整（断言口径随裁定变，不是放宽阈值）**

- 撤下「淡入结束时 `sword` 仍 ≥ 90°」的上界用例，换成：钉用户裁定值（`spinInSeconds === 0.6`、挥砍/回 idle 仍 0.2）+ 淡入必须短于命中帧。
- 新增 `step()` 第 4 参数的语义用例（切换时锁定、淡入途中传别的值不改动、时长不「粘」在过渡器上）。
- 渲染器级用例拉长到 0.8s：起手后 0.3s 姿态离纯片段仍远（>10°，0.2s 时为 0）、命中帧发布的是完整旋斩姿态、走满后精确等于片段。
- 「被打断」用例的前提改到淡入走完之后（0.75s，取旋斩独有骨骼里偏转最大的那根，`right_arm_joint` ≈ 61°）：0.6s 下 0.2s 时 `sword` 只显示 ~29°，
  且 0.5s 后片段里 `sword` 本就归零，原前提不再成立。
- E2E：观察窗口按**时间**取（起手后 1.2s，覆盖整个淡入 + 命中帧 + 快旋段）；非空洞判据由 `sword` 改看 `root`（命中帧前后转到 ~132°）。
  ⚠️ **时间戳改用 rAF 回调收到的帧时间戳 `ts`，不是回调里的 `performance.now()`**：后者相对游戏帧时间有抖动（实测相邻两条记录只差 5.1ms），
  把角速度虚高约 3 倍；窗口一旦覆盖片段自身的快旋段（24.5°/帧，合法动作）就会被放大成假红。改后真实游戏页最大角速度 **1469°/s**
  （= 片段自身合法最大值，淡入没有叠加额外运动），回退到硬切换 22900°/s。
- 负向验证 5 处（渲染器不传按来源时长 / `ignisBlendSeconds` 忽略 spin / `step()` 不锁定 / `spinInSeconds` 改回 0.2 / 改成 0.8 越过命中帧）每处至少一条变红。
