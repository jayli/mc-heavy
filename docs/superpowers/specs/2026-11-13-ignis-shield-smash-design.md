# 焰魔第三招：持盾冲撞（Shield Smash）设计

> 状态：**待用户审阅**。本文档是设计裁定与实测依据，不含实施步骤（实施计划另出）。
> 关联：`2026-11-05-ignis-boss-design.md`（焰魔本体）、`2026-11-07-ignis-spin-attack-design.md`（第二招旋斩，本招照它的架构同构）、
> roadmap v2.75 / v2.77 / v2.79 / v2.83。

## 1. 需求与裁定

用户 2026-11-13：「我要把盾击招式整合进 mc-heavy 的焰魔的招式里」。

五项裁定（`ask_user_question`，2026-11-13）：

| # | 议题 | 裁定 |
|---|---|---|
| ① | 范围 | **只加持盾冲撞这一招**。不做持盾格挡正面免疫、不做盾耐久/破盾阶段、不做举盾待机姿态 |
| ② | 触发 | ~~**玩家贴近时才抽**~~ **已于 2026-11-14 被用户实玩推翻** ⇒ 见 §1.1 |
| ③ | 附加效果 | **只扣血**。不做击退、不做碎石特效、不做破玩家盾、不做眩晕/减速 |
| ④ | 冷却冲突 | **抬高全局冷却下限** `attackCooldownMin` 3.5 → 4.0 |
| ⑤ | 起手音 | **入库 `sword_stomp.ogg`**（从 cataclysm 素材拷入，接成 `ignis_attack_smash`） |

**零新增美术资源**：盾的几何与贴图早在产物里（v2.83 已合成），动画 `ignis.attack1` 早在入库素材的 84 条里。
本轮只是让烘焙器多取一条动画 + 拷一个现成音效文件。**不新增方块、不新增贴图、不画任何新素材。**

### 1.1 二次裁定（用户 2026-11-14 实玩后，推翻裁定②与权重方案）

用户原文：「我测试了下，未发现焰魔可以盾击」→ 查明触发链后 → 「出发条件过于苛刻，**不要限制在严格 3 格内，
改成和其他两个攻击技能一样的生效距离**，比如砍的动作在距离玩家几格内生效，就改成盾击几个内生效，
**生效比例平分挥砍的动作的发生概率**」。

**为什么初版几乎遇不到**（实测 + 几何算清）：焰魔主动保持 `standoffRange` 5.0 且**不主动贴近**
（「不动如山」）⇒ 玩家站着不动时 `hDist` 恒在 4.25~5.0，`smashEngageRange` 3.0 的门**永不打开**。
玩家必须自己走进 [1.22, 3.0) 这条约 1.78 格宽的带子里，持盾冲撞才进候选集（概率 20~26%）。
实测把玩家钉在 2.5 格时 100 秒内 8 次起手里 3 次持盾冲撞（37.5%）⇒ **代码无缺陷，是门槛太苛刻**。

落地口径（三项）：

| 项 | 初版 | 二次裁定 |
|---|---|---|
| 贴身门 `IGNIS_AI.smashEngageRange` | 3.0 | **删除**（常量不存在，`_rollAttackKind` 回到单参） |
| `shieldSmash.hitRange` | 4.85（原版） | **6.5**（与横扫/旋斩同值，消除 `[4.85, 5.0]` 盲区） |
| 权重 | swing 0.56 / spin 0.24 / smash 0.20 | **swing 0.35 / spin 0.30 / smash 0.35** |

⚠️ **权重方案的取舍**：用户只说「平分挥砍的概率」，未提旋斩 ⇒ 取「原 swing 0.7 一分为二、spin 保持 0.3」，
和仍为 1。若用户要的是「三招各 1/3」，改两个数即可。

⚠️ **锥宽未改**：仍是半角 22.5°（用户只要求改「生效距离」）。

### 1.2 三次裁定：改名「持盾冲撞」（用户 2026-11-14 录像后，裁定 A）

用户看实玩录像（`焰魔-持盾冲撞bug.mov`，5.4s @120fps）后指出：

> 「我看到的所谓『盾击』的效果就是拿头来撞的一个动画，完全没有盾牌砸地的动作，
> 你看看是不是我们理解的不一致？我理解盾击就是拿盾牌攻击，是有一个盾牌砸地的动作的，
> 你确认是这个吗？还是迁移错了？」

**实测结论：迁移正确，是「持盾冲撞」这个名字与原版动作不符。** 用户裁定 **A：改名「持盾冲撞」，
只改文案、保留这个动作**（不补反馈、不改动画）。

#### 判据：与原版 Java 逐点比世界坐标

口径**复用** `src/tests/test-ignis-bake.js` 的 `probePoints`（已验证的权威口径）：
`R = bind · delta`、`position = pivot − R·pivot + deltaPos`、`M = M(parent)·T(position)·R`，
探针点 = `pivot + Java局部偏移(y取反)/16`。Java 侧走 `tools/java-model-parse.mjs` 的
`parseAnimation('SHIELD_SMASH_ATTACK')` + `evalKeyframes` + `javaWorld`。

| 时刻 | 最大偏差 |
|---|---|
| bind pose | **0.00 px** |
| t=1.0 / 1.5（关键帧点） | **0.44 px** |
| t=1.7 / 1.75 / 2.0 / 2.75（压下保持） | 4.6~4.8 px |
| t=0.5（插值中段，剑尖） | **20.07 px** = 1.25 格 |
| t=3.5（收势） | 1.64 px |

关键帧点几乎逐位重合 ⇒ **素材配对、旋转约定、骨骼链全部正确**。中段那 20px 是
**线性插值 vs 原版 `sin(frac·π/2)` 缓动**的差异（烘焙器的既有选择，见 `bake-ignis.mjs`
的 `sampleChannel3` 注释），不是迁移缺陷。

#### 原版这一招本来就不是「盾砸地」

原版盾尖与头顶的 y 轨迹（px，y 向上；焰魔总高约 65px）：

| 时刻 | 盾尖 y | 头顶 y |
|---|---|---|
| 起手 / bind | 21.2 | 51.3 |
| 蓄力峰值 t=1.0~1.5 | **57.4** | 49.4 |
| 压下 t=1.75~2.75 | **38.9** | 49.4 |
| 收势 t=3.5 | 21.2 | 51.3 |

**盾尖最低只到 38.9px = 2.43 格 —— 大约在焰魔自己的胸腰高度，从未触地（y≈0）。**
头顶全程稳在 49~51px。蓄力→压下的位移：盾尖 **1.286 格** vs 头顶 **1.594 格**
⇒ **头动得比盾还多**（比值 0.81；本仓产物 0.98，同量级）。

所以原版动作是「**举盾过顶 → 连人带盾向前下方压过去**」= 持盾冲撞 / 压制，
不是「盾砸地板」。用户看着像「头部撞击」，是因为裁定③去掉了原版的
`ShieldSmashDamage` 飞石 + `ScreenShake_Entity` 震屏 + `ShieldSmashparticle` 碎石 ——
少了这些「撞中了」的反馈，画面上只剩身体前压。

#### ⚠️ 本节此前那版数字全部是错的（教训）

初版 §1.2 写的「`shield` 位移 3.559 格、Δy −2.493、从 y=3.47 砸到 y=0.98 脚前地面、
是头的 5.94 倍、`upperbody` 前倾 −83.6°」**全部作废**。那组数字出自一个临时探针，它
① 漏了 `−R·pivot` 项（把 pivot 直接加进偏移），② 原点口径没对齐（Java 侧输出 `24−y`、
本仓链原点在 `y=0`，差常量 1.5 格）。

**两条可复用的教训**：
1. **临时探针必须复用仓库里已验证的权威口径**，不要自己重写矩阵链 —— 漏一项就得出反向结论。
2. **「bind pose 对得上」不能证明探针对**：本例 bind 也差 1.2 格，正是它暴露了口径错。
   而「角度逐轴一致」同样不能证明世界坐标一致（AGENTS.md 已记的 v2.58 教训反过来也成立）。

#### 落地范围（只改文案）

- **代码标识符全部保留**：`shieldSmash`（档案键 / `attackKind` 取值）、`ignis_attack_smash`
  （音效 id）、`SHIELD_SMASH_ATTACK`（原版常量名）、产物 `animations.shieldSmash`。
  改它们要动产物指纹与音效表，属于行为改动，不在本次范围。
- **UI 层本来就没有玩家可见的招式名文案**（实测 `src/ui` / `src/save` / `index.html` 零匹配）
  ⇒ 本次改名落在注释、测试名与文档的中文措辞上。
- **动作、数值、触发、音效一概不动**：`hitRange 6.5` / `hitConeDeg 22.5` /
  `hitFrameSeconds 1.70` / `animSeconds 3.50` / `weight 0.35` 全部原样。

## 2. 素材鉴别（实测扫描，不是按名字认定）

### 2.1 配对方法

沿用 v2.75 鉴别 `attack8a3` 的口径：**只比共有骨骼的关键帧数值（度）**，不比世界坐标。
理由：两侧素材是**不同的建模迭代**（剑/盾骨骼拆分不同，见 `ignis-fingerprint.mjs` 文件头），
绝对坐标本就不可比 —— 我第一版探针比世界坐标，在 **bind pose（t=0）就有 28px 偏差**，
那是坐标换算错误（Java 嵌套骨骼 `setPos` 是相对父骨骼），不是动画不匹配。

Bedrock 侧采样**直接复用烘焙器自己的 `collectChannel` / `sampleChannel3`**（`tools/bake-ignis.mjs`），
保证「对照脚本与被测代码只差一个变量」。Java 侧走 `tools/java-model-parse.mjs` 的
`parseAnimation` + `evalKeyframes`（Citadel `ModelAnimator` 语义）。

⚠️ 探针踩到的两个坑（记录下来，避免重犯）：
- 关键帧键 `"0.0"` 被 `Number()` 归一成 `"0"` 后回查取不到 ⇒ 必须**保留原始字符串键**（烘焙器 `collectChannel` 里已有同一条注释）。
- 素材 84 条里有 **2 条非 ignis 前缀**（`animation.null.altar_of_fire` / `animation.null.disable_rotation`），
  按前缀替换键名会得到 undefined ⇒ 扫描前必须先按前缀过滤。

### 2.2 扫描结果（全部 82 条 ignis 动画，采样 13 个时刻）

| 候选 | 时长 | 骨骼数 | 与 Java `SHIELD_SMASH_ATTACK` 最大逐轴差 |
|---|---|---|---|
| **`attack1`** | **3.5s** | **9** | **15.000°**（t=1 head） |
| `block` | 1s | 1 | 30.000° |
| `fire` | 2s | 1 | 30.000° |
| `attack2a` / `attack1_2` / `attack7_2a` / `attack13a` … | 3s 等 | 8~11 | 72.500° |

**对照组（证明探针有判别力）**：已确认的 `attack6a ↔ SWING_ATTACK` 最大差 **12.462°**，
与最优候选的 15.000° **同一量级**；第二名 30° 已是它的 2 倍，第三名 72.5° 是 4.8 倍。

⚠️ `attack8a3 ↔ SPIN_ATTACK` 在同一探针下报 288°，**这是预期的**：它的 `root` 在 t=1.4
写作 `{pre:[0,357.5,0], post:[0,-2.5,0]}`（整圈回绕），数值域比对必然报大差。
v2.75 已用「unwrap 后净转角」处理，本招不涉及该形态。

**结论：`ignis.attack1` = `SHIELD_SMASH_ATTACK`**，与 `ignis-config.js` 既有注释
（「`attack1`（70 tick = `SHIELD_SMASH_ATTACK`）」）一致 —— 但那条注释此前只是推断，本轮首次实测确证。

### 2.3 时长 3.5s（70 tick）的候选只有 4 条

`attack1`、`phase_soula`、`phase_soulb`、`phase_soulc`。后三条是**阶段转换**动画
（`phase_soul*` 对应 Java `PHASE_2`），骨骼集合与关键帧形状都不同，扫描里排在后面。
⇒ 不存在「等长候选歧义」，与 v2.75 旋斩的 4 条等长候选情形不同。

## 3. 招式形态（实测关键帧，单位度）

`attack1` 的 `root.rotation` 与 `left_arm_joint.rotation`（左臂 = 盾臂）：

| t(s) | root | left_arm_joint | 语义 |
|---|---|---|---|
| 0.0 | [0, 0, 0] | [0, 0, 0] | 起手 |
| 1.0 | [−5, **30**, 0] | [−30, −27.5, −20] | 蓄力到位：身体右拧 30°、盾臂后收 |
| 1.5 | [−5, 30, 0] | [−30, −27.5, −20] | 保持（静止段） |
| 1.75 | [**17.5**, 30, 0] | [**+35**, −27.5, −20] | **砸下**：盾臂从 −30° 抡到 +35°（65° 行程） |
| 2.75 | [17.5, 30, 0] | [35, −27.5, −20] | 保持 |
| 3.5 | [0, 0, 0] | [0, 0, 0] | 回位 |

与 Java 语句序列逐条对应（`parseAnimation` 输出）：
`startKeyframe 20` → `rotate root [−5,30,0]` / `left_arm_joint [−30,−27.5,−20]` → `endKeyframe`
→ `setStaticKeyframe 10` → `startKeyframe 5` → `rotate root [17.5,30,0]` / `left_arm_joint [35,−27.5,−20]`
→ `endKeyframe` → `setStaticKeyframe 20` → `resetKeyframe 15`。
合计 20+10+5+20+15 = **70 tick = 3.5s** ✓

⚠️ **`root.y` 只到 +30°**（对比横扫 `attack6a` 的 −65°）：这是「盾在左臂、身体只需小幅侧拧」的形态，
不是横扫那种大幅转身。**判据不能用「root.y 幅度大」来验持盾冲撞**，要看 `left_arm_joint.x` 的 65° 行程。

## 4. 玩法数值（取自 `Ignis_Entity.aiStep()` 的 `SHIELD_SMASH_ATTACK` 分支）

Java 原文（第 884~897 行）：

```java
if (this.getAnimation() == SHIELD_SMASH_ATTACK) {
    if (this.getAnimationTick() == 34) {
        this.playSound(SoundEvents.TOTEM_USE, 1.5f, ...);
        ScreenShake_Entity.ScreenShake(...);
        AreaAttack(4.85f, 2.5f, 45, 1.5f, 0.15f, 200, 0, 0, 5, false, 0);
        ShieldSmashparticle(1.3f, 2.75f, -0.1f);
    }
    for (int i = 34, j = 4; i <= 40; i = i + 3, j++) {
        if (this.getAnimationTick() == i) {
            ShieldSmashDamage(2, j, 1.5f, 2.75f, false, 0, 1, 0.02f, 0.1f);
        }
    }
}
```

⇒ 本招档案：

| 字段 | 值 | 来源 |
|---|---|---|
| `hitRange` | **4.85** | `AreaAttack` 第一参 `range` |
| `hitConeDeg` | **22.5** | `arc 45` 的**半角**（`AreaAttack` 判 `|相对角| ≤ arc/2`） |
| `hitFrameSeconds` | **1.70** | tick 34 ÷ 20 |
| `animSeconds` | **3.50** | `Animation.create(70)` ÷ 20 |
| `weight` | **0.2** | 本仓标定（见 §5.2） |

⚠️⚠️ **`hitConeDeg` 是半角 22.5，不是 45**：与横扫 35（=70/2）、旋斩 155（=310/2）同一口径。
写成 45 会让扇面变成 90°，**没有任何断言会红**（只是「打得更宽」）。守卫见 §7。

⚠️ **伤害不在档案表里**：三招共用 `IGNIS.attackDamage = 14`（用户 2026-11-07 裁定「照原版：同伤害」）。
原版 `AreaAttack` 的 `damage=1.5` 与 `hpdamage=0.15` 两项**都不取** —— 与既有两招同一口径
（`IGNIS.attackDamage` 注释已记：本仓玩家血量固定 20，百分比伤害不直观）。

### 4.1 原版的三段飞石伤害不取

`ShieldSmashDamage` 在 tick 34/37/40 各掀一圈脚下方块（`Cm_Falling_Block_Entity`）并造成
`damage=1, hpdamage=0.02` 的额外伤害。裁定③「只扣血，不加任何附加」⇒ **本轮不取**。
本仓也没有 `Cm_Falling_Block_Entity` 的对应物（`BlockHitFxRenderer` 的碎块是纯表现层，不造成范围伤害）。

## 5. 架构改动

### 5.1 与既有两招完全同构（红线 1）

第三招走 v2.75 已建好的「档案表 + 清单化烘焙」轨道，**不新增任何子系统**：

| 层 | 文件 | 改动 |
|---|---|---|
| 烘焙参数 | `tools/ignis-fingerprint.mjs` | `IGNIS_ANIM_SOURCES` 加 `shieldSmash: ['attack1']`；`IGNIS_ANIM_PERIODS` 加 `shieldSmash: 3.5` |
| 烘焙器 | `tools/bake-ignis.mjs` | **零改动**（`IGNIS_ATTACK_ANIM_KEYS` 自动派生，逐招导出） |
| 玩法数值 | `src/entities/ignis/ignis-config.js` | `IGNIS_ATTACKS` 加第三档；`attackCooldownMin` 3.5 → 4.0；新增贴身阈值常量 |
| AI | `src/entities/bosses/ignis-boss-agent.js` | `_rollAttackKind` 增加「贴身才纳入持盾冲撞」的候选过滤 |
| 渲染 | `src/render/ignis-renderer.js` | `clipKey` 三分支（当前是 `spin ? 'spin' : 'attack'` 二元） |
| 衔接 | `src/entities/ignis/ignis-config.js` | `ignisBlendSeconds` 支持第三个来源键 |
| 音效 | `src/render/audio-config.js` + `assets/sounds/` | 入库 `sword_stomp.ogg` → id `ignis_attack_smash`；`SOUND_IDS` / `SOUND_EXT_OVERRIDES` / `SOUND_VOLUMES` / `IGNIS_ATTACK_SOUNDS` 各加一条 |
| 结算 | `src/core/game.js` | **零改动**（`_consumeIgnisAttackRequests` 已按 `req.kind` 取档案） |
| 门禁 | `tools/check-data.mjs` | **零改动**（动画清单与帧数按 `IGNIS_ATTACK_ANIM_KEYS` 逐招校验） |

⚠️ **`IGNIS_AI` 的四项派生最大值会自动变**（`ATTACK_MAX` 从档案表算）：
`hitRange` 6.5（不变）、`hitConeDeg` 155（不变）、`hitFrameSeconds` **1.20 → 1.70**、
`attackAnimSeconds` **2.75 → 3.50**。既有断言读的是派生关系而非字面量，故自动跟上；
但 `test-ignis-system.js` 里若有写死 1.20 / 2.75 的地方需按新口径改写（实施时逐条核对）。

### 5.2 抽签：贴身才纳入持盾冲撞

裁定②的落地。新增常量（本仓标定，非作者原值）：

```
IGNIS_AI.smashEngageRange = 3.0
```

来源：Java `tick()` 第 754 行的触发条件 `distanceTo(target) < 3F`。

`_rollAttackKind` 的候选集从「是否屏蔽旋斩」一维扩成两维：

| 条件 | 候选集 |
|---|---|
| `hDist < 3.0` 且旋斩冷却已好 | swing / spin / shieldSmash |
| `hDist < 3.0` 且旋斩冷却未好 | swing / shieldSmash |
| `hDist ≥ 3.0` 且旋斩冷却已好 | swing / spin |
| `hDist ≥ 3.0` 且旋斩冷却未好 | swing |

⚠️ **必须「从候选集里去掉」而不是「抽中了再改判」**：后者会让剩余概率全堆到第一个档案上，
权重语义变味（v2.75 已踩过，`_rollAttackKind` 注释里有）。

⚠️ **这条不改「不动如山」**：`_ringIntent` 完全不动。玩家站在 5.0 格环上时焰魔照常 swing/spin；
只有玩家自己走进 3 格内，持盾冲撞才进入抽签池。焰魔**不会为了出持盾冲撞而贴近**。

**权重方案**：持盾冲撞 0.2，其余按原 7:3 比例缩放到 0.8 ⇒ `swing 0.56 / spin 0.24 / shieldSmash 0.20`（和 = 1）。
这样「非贴身时的相对手感」与现状完全一致（0.56:0.24 = 7:3）。

⚠️ 持盾冲撞**不加独立冷却**：它的触发条件本身就是低频门（玩家必须主动贴脸），
再叠独立冷却会让它几乎不出现。与旋斩不同 —— 旋斩无距离门，故需要 `spinCooldownSeconds` 压频。

### 5.3 冷却下限 3.5 → 4.0（裁定④）

**为什么必须改**：现有不变式 `attackCooldownMin > attackAnimSeconds`（`test-ignis-boss-agent.js:1540`）。
加入持盾冲撞后 `attackAnimSeconds` 派生成 3.50，与旧下限 3.5 **恰好相等** ⇒ 不变式破。

不改的形态（既有注释已记）：冷却从**命中时刻**起算，持盾冲撞命中后动画还剩 `3.50 − 1.70 = 1.80` 秒；
若下限 ≤ 1.80，冷却在动画播完前走完 ⇒ 下一次起手间隔等于动画时长，`attackCooldownMin` 数值上不起作用。
取 4.0 时余量 `4.0 − 1.80 = 2.20` 秒，充足。

**代价（需要用户知道）**：普攻与旋斩的命中间隔也一起从 [3.5, 6.0] 变成 [4.0, 6.0]，
Boss 压迫感略降。这是裁定④已接受的取舍。

`spinCooldownSeconds = 8.0` 不动（仍 ≥ 新下限 4.0，既有断言 `spinCooldown >= attackCooldownMin` 仍成立）。

### 5.4 起手衔接

`ignisBlendSeconds(sourceKey)` 当前是 `sourceKey === 'spin' ? spinInSeconds : seconds`。
持盾冲撞入场用**默认 0.2s**（与横扫同档），不新增常量。

依据：持盾冲撞起手是「身体右拧 30° + 盾臂后收」，**没有旋斩那种 177° 的单帧硬切**
（旋斩的问题是 `sword` 一帧甩 177°，持盾冲撞的 `root.y` 只到 30°、且是 1.0 秒缓入）。
硬约束「淡入必须在命中帧之前走完」：0.2 ≪ 1.70 ✓，余量极大。

⚠️ 实施时仍要用真实产物 + 60fps 模拟测一遍单帧最大骨骼角（照 v2.76 的口径），
**不凭这段推理直接宣称通过**。若实测超 24.5°（片段自身合法上限），再按实测调。

## 6. 关键判据与陷阱

1. **`hitConeDeg = 22.5` 是半角**。写成 45 ⇒ 扇面 90°，静默变宽。守卫：单测 `shieldSmash.hitConeDeg < 45`。
2. **`hitRange = 4.85 < standoffRange = 5.0`**。这是本招与既有两招最大的不同：
   玩家站在**环外沿 5.0 格**时持盾冲撞**打不中**（横扫/旋斩的 6.5 够得到）。
   ⇒ 「持盾冲撞能命中」的 E2E 必须让玩家站在 3 格内，照抄既有「站定环上被砍中」的用例会得到**恒红**
   （与废弃堡垒锚点方向照抄同类的坑）。

   ⚠️ **但不要写成「死区内恒不命中」**：死区是 `[4.25, 5.0]`，而 `4.85 > 4.25` ——
   玩家站在 **4.25~4.85** 之间时持盾冲撞**仍够得到**。只有 `[4.85, 5.0]` 这一段才是持盾冲撞的射程盲区。
   （自查时算错过一次，记录在此防止实施时照抄错判据。）

   另一半算术是安全的：`smashEngageRange 3.0 < hitRange 4.85` ⇒ **抽到持盾冲撞时玩家一定在射程内**，
   不会出现「抽中了却必然落空、白耗冷却」的情形。
3. **判形态要看 `left_arm_joint.x` 的 65° 行程，不是 `root.y` 幅度**。持盾冲撞 `root.y` 只到 30°，
   用「root 转角大」做判据会把它误判成小横扫。
4. **`attack1` 与 `attack1_2` 是两条不同动画**（后者 3s / 11 骨骼，扫描里差 72.5°）。
   键名相近，`IGNIS_ANIM_SOURCES` 写错一个字符 ⇒ 烘焙出另一招，而帧数/骨骼数判据可能仍通过。
   守卫：产物契约测试钉 `shieldSmash` 的 `frameCount = 105`（= round(3.5 × 30)）与 `boneIndices.length = 9`。
5. **音效键集合一致性**：`test-bgm.js:386` 断言 `IGNIS_ATTACK_SOUNDS` 的键与 `IGNIS_ATTACK_IDS` **完全一致**。
   加了第三招不加音 ⇒ 该断言红（这是好事，正是它要抓的）。
   另有「两招不得共用同一个音」的断言，需扩成三招两两不同。
6. **`sword_stomp.ogg` 不是原版持盾冲撞音**。原版播的是 Minecraft 原版 `SoundEvents.TOTEM_USE`，
   本仓没有那个文件。`sword_stomp.ogg` 是 mod 自带的**强化砸地踏步音**，用户裁定⑤选它作近似。
   ⚠️ 文档与代码注释都要写清这是**近似替代**，不是「原版持盾冲撞音」—— 否则将来对照原版会得出错误结论。
7. **权重和必须 = 1**（`test-ignis-system.js:181`）。三档 0.56/0.24/0.20 和为 1.00 ✓
8. **档案形状断言写死了键集合**：`test-ignis-system.js:172` 是 `assertEqual(Object.keys(IGNIS_ATTACKS).sort().join(','), 'spin,swing')`。
   加第三招必须同步改成 `'shieldSmash,spin,swing'`，否则恒红。

## 7. 测试计划

### Tier 1（TDD，`src/tests/`）

- `test-ignis-system.js`：持盾冲撞档案四项数值 + 半角守卫（< 45）+ 命中帧落在动画内 + 档案形状键集合 + 权重和 = 1 + 派生最大值关系。
- `test-ignis-boss-agent.js`：四象限候选集（贴身/非贴身 × 旋斩冷却好/未好）各一条；
  「非贴身时永不抽到持盾冲撞」用固定 rng 扫 100 次；冷却下限不变式按 4.0 重标。
- `test-ignis-bake.js`：`shieldSmash` 产物契约（105 帧 / 9 骨骼 / fps 30 / duration 3.5）；
  **形态判据**：`left_arm_joint.x` 在 t=1.0 与 t=1.75 之间行程 ≥ 60°（实测 65°）。
- `test-ignis-render.js`：渲染器按 `attackKind='shieldSmash'` 选 `animations.shieldSmash`；
  淡入 0.2s 在命中帧 1.70s 之前走完。
- `test-bgm.js`：三招键集合一致 + 三音两两不同 + `ignisAttackSound('shieldSmash')` 返回 `ignis_attack_smash` + 非法 kind 仍回落 swing。

### Tier 2（门禁）

`npm run check` 三门。`check:data` 的 `[焰魔]` 环节自动校验新动画的清单/帧数/fps/数组长度（零改动）。
指纹会因 `IGNIS_ANIM_SOURCES` / `IGNIS_ANIM_PERIODS` 变化而变 ⇒ 必须重跑 `npm run ignis`。

### Tier 4（像素 + 真实结算，`tests/ignis.spec.mjs`）

- **姿态差**：持盾冲撞 vs 横扫 vs 旋斩三两不同（像素级，冻结帧循环后截图，照 v2.83 的噪声底口径）。
- **真实结算**：玩家站 **2.5 格**处 ⇒ 持盾冲撞命中扣 14 血；站 **5.0 格**（环外沿）⇒ 持盾冲撞**打不中**
  （这条同时钉住 `hitRange 4.85` 与「贴身才抽」两条）。
  ⚠️ 不得取 4.5 格作「打不中」的样本 —— 它在射程内（`4.5 < 4.85`），会恒红。
- **锥宽**：侧向 40° 处持盾冲撞打不中（半角 22.5），而旋斩打得到（半角 155）。
- **起手音**：持盾冲撞起手播 `ignis_attack_smash` 且不播另两个（照 v2.79 的 rAF 逐帧探针口径）。

### 负向验证（单变量注入 + `cp` 副本还原 + sha256 核对）

至少四处：① 渲染器恒播 `attack`；② `hitConeDeg` 改 45；③ `_rollAttackKind` 不做贴身过滤；
④ `IGNIS_ANIM_SOURCES.shieldSmash` 改成 `attack1_2`。每处都要**真红**，且还原后逐位一致。

⚠️ 禁用 `git checkout` 还原含未提交改动的文件（已发生过真实数据丢失）。

## 8. 不做的事（裁定①③的边界）

- 持盾格挡正面免疫（`canBlockDamageSource`）
- 盾耐久 3 层裂纹 / `BREAK_THE_SHIELD` 破盾阶段 / 破盾后转持剑
- 举盾待机姿态（素材 `attackinga`）
- 击退玩家 / 碎石特效 / 破玩家盾 / 眩晕或减速
- 原版三段飞石范围伤害（`ShieldSmashDamage`）
- 屏幕震动（`ScreenShake_Entity`）

这些各自是独立改动，需要时另开 spec。

## 9. 调研探针（一次性，未入库）

本轮为鉴别素材写了 4 版探针（`/tmp/ignis-shield-pair*.mjs`），最终版复用烘焙器采样函数。
**它们不入库**（`tests/tmp-*.spec.mjs` 才是本仓一次性探针的位置，而这些是 node 脚本）。
鉴别结论已写进 §2，实施时若需复现，按 §2.1 的方法重写即可。

⚠️ 第一版探针的错误结论（bind pose 28px 偏差）**已被推翻**，不得引用。