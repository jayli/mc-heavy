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