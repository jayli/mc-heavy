# 末影守卫（Ender Guardian）Boss 导入设计 —— 废弃堡垒（ruined_citadel）

用户 2026-11-11：「我正在把灾变模组里的地形转移到 mc-heavy 里来，给末日地堡增加一个 boss，
把末日地堡的 boss 也转移进来，类似竞技场的焰魔。当玩家进入到末日地堡地界后，按 B 就可以召唤出这个 boss。」

经逐项核实（见 §2）：

- 「末日地堡」= 刚移植进 mc-heavy 的 **废弃堡垒 `ruined_citadel`**（城西沙漠，18 片 nbt，
  带 44 层地下地牢）。仓库与 `~/jaylli` 全量搜索 `末日地堡` 零命中，结合上下文唯一对应它。
- 「末日地堡的 boss」= **末影守卫 Ender Guardian**（用户记作「末日守卫」，mod `zh_cn.json`
  实测为 `entity.cataclysm.ender_guardian = 末影守卫`）。它是废弃堡垒的真 Boss：原版靠
  **虚空祭坛**（`altar_of_void`，在 `ruined_citadel5.nbt`）玩家靠近 6 格自动召唤、带紫色 Boss 血条。

**末影守卫 = 废弃堡垒（RUINED_CITADEL）的 Boss slot 0**（本图唯一 Boss）。沿用
`boss-registry.js`「名册是数据不是代码分支」的既有召唤框架。

---

## 1. 用户裁定（2026-11-11，逐项 `ask_user_question` 确认）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 选哪个 Boss | **末影守卫 Ender Guardian**（不是同堡的末影傀儡 Ender Golem） |
| 2 | 结构 | **就是废弃堡垒 ruined_citadel** |
| 3 | 召唤点 | ~~最深房间中心~~ → **上层房间中心**（2026-11-11 审阅后改判，见 §2.3） |
| 4 | 血量 | **2000**（原版 333，用户标定） |
| 5 | 招式范围 | **只保留三招**：左右重击、上勾拳、踩踏；其余 **13 个攻击动画**（黑洞/传送/湮灭/火箭拳/挥击/轻击/爆发击/狂暴变体等）先不做 |
| 6 | 弹丸 | **纯近战，不带弹丸**（上勾拳不发射炮弹、踩踏不冒尖牙） |
| 7 | 玩家位移效果 | **只扣血**，不做重力拉扯/挑飞/击退（跟焰魔一致，不碰玩家物理） |
| 8 | 头盔二阶段 | **不做**（不做破盔狂暴） |
| 9 | Boss 血条 | **不做**（跟焰魔一致，mc-heavy 连焰魔/飞龙都没有 Boss 血条） |
| 10 | 死亡表现 | **直接爆散**（跟焰魔一致，不烘焙 196 tick 的 FALLEN 倒地动画） |
| 11 | 脱困技能 | **要**，类似焰魔的脱困跳（`stuckLeap` / 强化跳） |
| 12 | 其余 | **「其他场景都参照原版迁移实现」** + 「烘焙肯定是需要的」 |

**裁定 3 的改判（2026-11-11，审阅实测后用户裁定）**：原裁定「最深房间中心」在实测中被证伪 ——
最深房间与外界**完全隔断**（§2.3），玩家走不下去、守卫也走不出来，Boss 战无法发生。
用户裁定改为**上层房间中心**（玩家从甲板竖井走 65 步约 8 秒可达）。这是本次唯一推翻原裁定的项。

近战判据（沿用焰魔口径）：**动画命中帧 + 前方锥 + 视线通** —— 动画播到命中帧那一刻，
才对「锥内且视线通」的玩家结算一次伤害。

---

## 2. 素材与现状实况（全部实测，不是推测）

### 2.1 模型：**只有 Java 源码，没有 Bedrock 素材**

这是本设计与焰魔移植（v2.55）**最根本的差异**。焰魔当时用的是 Bedrock 附加包的
`.geo.json` + `.animation.json`；末影守卫**没有**任何 Bedrock 几何/动画文件
（全机 `find *.geo.json / *.animation.json / *.bbmodel` 确认），只有 Java 侧：

| 文件 | 内容 | 实测规模 |
|---|---|---|
| `ModelEnder_Guardian.java` | Citadel `AdvancedModelBox` 骨骼 + `ModelAnimator` 关键帧 | **20 骨骼 / 24 盒**，1088 行 |
| `ender_guardian.png` | 主贴图 | 256²，23,752 不透明像素 |
| `ender_guardian_layer.png` | 发光眼睛层（`RenderType.eyes`） | 256²，2,749 不透明像素，主色紫 `(161,83,254)` |

**推论：焰魔那条「Bedrock 烘焙器」(`bake-ignis.mjs`) 不能直接复用**，必须新写一条
「**Java 模型源码 → mc-heavy 骨骼产物**」的烘焙器。

**关键利好（已实测）**：`tools/ignis-java-reference.mjs` **已经会解析这种 Java 格式**
（Citadel 的 `setPos` / `addBox` / `startKeyframe` / `rotate` / `move`，以及 Z→Y→X 旋转序、
欧拉角逐轴相加、sin 缓动的完整语义）—— 它当时是给焰魔做姿态诊断用的。新烘焙器是在它
**已验证的解析语义**上扩展成生产管线，不是从零写解析。

**已实测的三处必须改动**（审阅时在 `/tmp` 影子副本里真跑过，不是推测）：

1. `parseBones` 把构造函数名**硬编码**为 `public ModelIgnis()`，对 guardian 返回 0 骨骼。
   参数化后实测能完整解析出 guardian 的 **20 骨骼 / 24 盒**（见 §2.2）。
2. ⚠️ **`parseSwing` 对焰魔的 `if` 分支做了专属裁剪，不能直接丢掉**。焰魔的 `SWING_ATTACK`
   段内**有** `if (!entity.getIsShieldBreak()) { … } else { … }`，原实现靠它取非破盾分支。
   若按「遇到 `if` 就 throw」做通用守卫，**抽取后焰魔冻结表立刻红**（影子实测报
   `动画 SWING_ATTACK 段内出现 if 分支`）。故接口必须带**可选分支选择器**：
   `parseAnimation(text, name, { branch })` —— 传了就取该分支体，不传且段内有 `if` 才 throw。
3. ⚠️ **动画调用带类名前缀**。焰魔是 `animator.setAnimation(SWING_ATTACK);`，而守卫是
   `animator.setAnimation(Ender_Guardian_Entity.GUARDIAN_RIGHT_STRONG_ATTACK);`。
   按字面 `animator.setAnimation(<name>)` 匹配对守卫**一条都找不到**（影子实测）。
   匹配式必须容许 `[\w.]*\.` 前缀。

补上这两处接口后影子实测：焰魔冻结表 **67 行逐位不变**；守卫 `bones 20`、
`bbox 5.4176 × 4.2844 × 2.9017`、四条动画 `move` 数 **16/16/6/6 = 44**、
关键帧 tick **60/60/90/48** —— 本设计引用的这几个数字全部为真。

### 2.2 bind pose 包围盒与**坐标系口径**（用参数化后的 Java 解析实测）

```
非零立方体 24 个（mirror 7 个、inflate 非零 4 个（含 1 个负 inflate）、零尺寸 0 个）
bbox  x[−43.34, 43.34]  y[−24.00, 44.55]  z[−23.70, 22.73]  px
      （**仅翻转** 口径：y_bedrock = −y_java）
bbox  宽 × 高 × 深 = 5.4176 × 4.2844 × 2.9017 格
feetOffsetY = +1.6243 格（动画全程最低点在模型空间 y = −1.6243，扫遍 4 条动画全部帧实测）
```

- 模型视觉高 ≈ **4.28 格**（含外张的手臂/肩甲尖刺）；**碰撞盒**取原版 `sized(2.5F, 3.8F)`
  = 宽 2.5 / 高 3.8（见 §5）。
- `feetOffsetY = +1.6243` 格：渲染器把 mesh **上移** 1.6243 格，让「最低顶点」落在 `state.position.y`。
  ⚠️ **符号是正的**（Task 3 实施时实测纠正）：`feetOffsetY = −lowestY`，而口径 A 下
  `root.localPosition = [0,−1.5,0]` 把整条链压低 ⇒ lowestY 为负 ⇒ 补偿量为正。
  早前写的 −1.5 其实是 **root.localPosition.y** 那个数，与 feetOffsetY 语义相反。
  另：1.5 只是 bind 站立时的值，出招时腿会再下沉 ⇒ 全程最低点是 1.6243 而不是 1.5。
  （脚底），与焰魔同口径（焰魔是 −0.2656）。

#### ⚠️ 2.2.1 两套坐标系必须选定一套（本设计选 **A：仅翻转**）

Java 与 Bedrock 的**顶点坐标语义不同**，这是烘焙器最易错的一处（实测确认）：

| | Java（Citadel） | Bedrock（焰魔素材） |
|---|---|---|
| `addBox` origin | **骨骼局部**坐标 | **绝对模型**坐标 |
| 骨骼变换 | `M = M(parent)·T(pos)·R` | `M = M(parent)·T(pivot)·R·T(−pivot)` |
| 地面基准 | `root.setPos(0, 24, 0)` | pivot 已含 `24 − y_java` |

实例（实测）：`left_leg` 的 Java 相对 pos `(11,−22,0)`、绝对 pivot `(11, 2, 0)`，
cube origin `(−4, 0, −8)` ⇒ 脚的绝对 `y_java = 2 + 0 = 2`，加 root 的 24 才是地面。
**直接把 Java 的 origin 当 Bedrock 绝对顶点写，所有部件会挤到模型原点附近。**

**本设计选口径 A（仅翻转，与现有 `ignis-java-reference.mjs` 一致）**：
- 顶点保持**骨骼局部**，只做 `y → −y`（x/z 不变）；
- `localPosition = pos/16`（y 取反）—— Java 的 `setPos` 已是相对父骨骼，**不需** Bedrock 那道
  `pivot − R·pivot` 修正；
- 产物的 `pivot` 字段在口径 A 下**语义变了**：不再是「绝对旋转中心」而是**零**（旋转已由
  骨骼层级天然绕局部原点发生）⇒ `guardian-renderer.js` **不得**照搬焰魔那行
  `bone.position = pivot − R_current·pivot + delta`，而是 `bone.position = localPosition + delta.pos`。
- `feetOffsetY = +1.6243`（口径 A）；若选口径 B（Bedrock 绝对 `24 − y_java`）则整体差 1.5 格，
  且顶点需 `origin + 绝对pivot`、`localPosition = pivot − R·pivot`。**两者差整整 1.5 格**，
  混用的形态是模型整体陷地或悬空 1.5 格，而骨骼数/盒数/顶点数/指纹全对。

⇒ 选 A 的理由：参考器（唯一独立守卫）已在口径 A 上验证过，且 Java 语义少一道变换。
代价是渲染器与焰魔**不同形**（一处），故 §10 明写该差异，并由 §11 的产物契约用例钉住。

### 2.3 废弃堡垒产物里的召唤点（**上层房间**，已逐格实测）

产物 `assets/structures/ruined_citadel.json`（`floorRow = 45`，世界 `y = floorY + (ny − 45)`）。

**世界坐标推导（实测验证）**：`apply.js` 调 `rasterizeStructure('ruinedCitadel', wx,
floorY − (floorRow − 1), wz, …)`，内部落在 `y + b.y − 1` ⇒ `ny` 的方块在世界
`y = floorY + ny − 45`（校验：ny=45 甲板 → `floorY` ✓；ny=63 塔顶 → `floorY+18` ✓）。

#### 2.3.1 ⚠️ 三层地牢**互不连通** —— 原「最深房间」方案被实测推翻

地下三层房间：空气层 `ny=23..29`（最深）/ `ny=31..36`（中层）/ `ny=39..43`（上层），
以 `ny=30` / `ny=37` 两个实心层分隔。

**原方案（最深房间）的可达性论证是错的**：当时算出「洪泛可达 27,992 格、ny 22..45」，
用的是**把台阶/半砖当可通行**的口径。本仓 `blocks-data.js:265` 起台阶族一律 `solid:true`
⇒ `registry.solidTable[id] === 1` ⇒ `WorldData.isSolid` 恒真 ⇒ **身体不能进入台阶格**，
台阶只能当支撑面。按引擎真实口径（AABB 逐格采样 + 竖直移动不得穿实心）重测：

| 起点 | 玩家（半宽 0.3 / 高 1.8） | 守卫（半宽 1.25 / 高 3.8，含强化跳 8 格） |
|---|---|---|
| 最深房间中心 | 仅 `ny23` 层 **1509 格** | **1173 格**，同层 |
| 中层房间 | `ny31..35`，1301 格 | 同层 |
| 上层房间 | `ny38..39`，**2032 格** | **290 格**（见 §2.3.2） |

- `ny30` / `ny37` 两个分隔层**全层零 air**（逐格普查）；房间内的「楼梯」是**装饰台阶**
  （`ny30` 一整行同高档、不递进，且台阶正下方 `ny29` 是实心黑曜石砖）。
- `ny37` 在房间内唯一的 4 格开口 `(14,−15)/(14,−14)/(15,−15)/(15,−14)` 在源 nbt 里是
  **`iron_trapdoor`**，而 `ruined-citadel-fingerprint.mjs:172` 把它**丢弃**（无对应几何的薄件）
  ⇒ 世界里那 4 格是天然岩层。
- 甲板唯一竖井 `(14,18)`（`ny45/44` 各 1 格 air）竖直下探止于 `ny38` ⇒ **只通到上层房间**。

⇒ **玩家从甲板只能走进上层房间**；要到中层/最深必须挖穿 `ny37/38` 与 `ny30`
（这些方块都无 `indestructible`，可挖，但那是「挖下去」不是「走下去」）。
**故召唤点定在上层房间**（用户 2026-11-11 裁定）。补地牢连通性是**独立 spec**，不在本次范围（§12）。

#### 2.3.2 上层房间的落点（全部实测）

- 房间 air bbox `x[−22,26] z[−26,22]`（49×49），几何中心 `(2,−2)`；地板 `ny=38`，
  净空 `ny=39..43` 共 **5 格**，天花板 `ny=44`（`end_stone_bricks`）。
- ⚠️ **几何中心 `(2,−2)` 守卫站不住**：3×3 footprint 里 `(3,39,−2)` 是非空气格。
- **落点取 `(x+1, z−2)`、脚底 `ny=39`** ⇒ 世界 **`y = floorY − 6`**。
  选它的判据（在全部 1114 个守卫可站中心点里穷举 14 个连通分量后取最优）：
  · 所在分量 **290 格**，是守卫可达范围最大的一个（次大 150）；
  · 该分量 **290 格全部**落在玩家可达集内（交集 290/290）⇒ 玩家能自己走进去近战；
  · 距房间几何中心 **1.00 格**，是所有分量里最靠中心的。
- **可达性已验证**：玩家从甲板竖井底 `(14,39,18)` 到落点最短路 **65 步**（跑速 8 格/秒 ≈ **8.1 秒**）；
  站定环死区 `[2.75, 3.5]` 内有 **13 格**同时「玩家可达 + 守卫可站」⇒ 站定环有真实回旋空间。
- **体形适配**：上层房间 `ny39` 的 2032 个空气格里 **1114 格（54.8%）**能容纳守卫的 3×3×4 身体。

#### 2.3.3 ⚠️ 改落点带出的两条新约束（必须写进实现）

**① `HEADROOM` 必须 ≤ 4，不能取 5。** 上层房间净空只有 5 格（`ny39..43`），而焰魔式
`_findGroundY` 要求「脚底格 + 其上 `HEADROOM` 格」全空气。实测同一列的候选：

| HEADROOM | 单列候选 ny | `refY = floorY − 6` 选中 |
|---|---|---|
| 3 | 23 / 31 / **39** | 39 ✓ |
| 4 | 23 / 31 / **39** | 39 ✓ |
| **5** | 23 / 31（**39 被判死**） | **31 ✗ 召到中层** |

⇒ 取 `HEADROOM = Math.ceil(GUARDIAN.height) = 4`（**不 +1**）。守卫高 3.8 ⇒ 占 `ny39..42`
四层，`ny43` 是余量。原计划的 `Math.ceil(height) + 1 = 5` 会让落点静默落到中层（差 8 格）。

**② 脱困跳在本房间跳不起来 —— 已知边界，不做补丁。** 净空 5 格 − 身高 3.8 = **脚底只能升 1.20 格**
（3×3 footprint 内最低天花板同为 `ny44`，实测）。而普通脱困跳顶点 2.52、强化跳 4~8 格
⇒ **全部撞天花板**。这是「大体型 Boss 放进 5 格净空地牢」的物理必然，不是缺陷：
碰撞/二分回退照常生效，守卫升 1.2 格后落回，`leapMaxSeconds` 安全阀保证它回 `chase`。
脱困能力的验收**必须放在开阔地形的围栏里**（§11），不得在本房间断言「跳出去了」。

### 2.4 原版玩法数值（`Ender_Guardian_Entity.java` 1450 行 + `CMConfig.java` 实测）

| 属性 | 作者原值 | 出处 |
|---|---|---|
| `MAX_HEALTH` | 333（**本设计按用户裁定改 2000**） | `ender_guardian()` |
| `ATTACK_DAMAGE` | 16 | 同上 |
| `FOLLOW_RANGE` | 50 | 同上 |
| `MOVEMENT_SPEED` | 0.27 格/tick × 20 = **5.4 格/秒** | 同上 |
| `ARMOR` | 20 | 同上（本仓无护甲机制，仅记录） |
| `KNOCKBACK_RESISTANCE` | 1.0 | 同上。**⚠️ 本仓不引入**（v2.95）：原版该属性指击退附魔/爆炸位移（本仓无此机制），而「被剑砍后不后退」是另一件事 —— 用户 2026-11-11 要求守卫也要有受击后退（与焰魔同口径） |
| `maxUpStep` | 1.75（**本仓取 1.0**，见 §5 的实测） | 构造函数 |
| 碰撞盒 | `sized(2.5F, 3.8F)` | `ModEntities.java:41` |

**三招的 `AreaAttack(range, height, arc, damage, hpdamage, …)` 原值**（arc 是全角，本仓口径取半角）：

| 招 | Java 动画（时长） | 命中 tick | range | arc(全角) | damage 乘数 |
|---|---|---|---|---|---|
| 右重击 | `GUARDIAN_RIGHT_STRONG_ATTACK`（60t = 3.0s） | 29 | 5.15 | 70° | 1.0 |
| 左重击 | `GUARDIAN_LEFT_STRONG_ATTACK`（60t = 3.0s） | 34 | 5.15 | 70° | 1.0 |
| 上勾拳 | `GUARDIAN_UPPERCUT_AND_BULLET`（关键帧合计 90t = 4.5s） | 27 | 6.25 | 60° | 1.4 |
| 踩踏 | `GUARDIAN_STOMP`（48t = 2.4s） | 32 | —（原版生成尖牙，见 §4.4） | — | — |

⚠️ **`GUARDIAN_UPPERCUT_AND_BULLET` 声明 `Animation.create(100)` 但关键帧只合计 90 tick**
（实测 `[start15,setSt10,start5,setSt20,start5,setSt20,reset15]` = 90）。烘焙以**关键帧实际
合计 90 tick = 4.5s** 为准（声明的 100 是作者留的余量，无对应姿态数据）。

⚠️ **`hpdamage`（按目标最大血量百分比追加扣血）刻意不取**，与焰魔同口径：本仓玩家血量固定
20 格，百分比伤害不直观。只取 `damage` 项（见 §5 伤害口径）。

### 2.5 音效（mod 自带 ogg，可直接入库）

`assets/cataclysm/sounds/entity/` 实测存在三个文件。**原版的 id → 文件链路已查清**
（`ModSounds.java` + `sounds.json`，不是按名字猜）：

| 用途 | 原版 `SoundEvent` id | `sounds.json` 指向的文件 |
|---|---|---|
| 拳击（三招起手） | `enderguardianattack` | `entity/ender_guardian_fist_attack.ogg` |
| 受击 | `enderguardianhurt` | `entity/golemhurt.ogg`（**复用**） |
| 死亡 | `enderguardiandeath` | `entity/golemdeath.ogg`（**复用**） |

⚠️ **入库不是「拷文件」一步，要走完四步**（漏任一步都是静默无声或门禁红）：
1. 拷三个 ogg 进 `assets/sounds/`，改名为本仓 id：`guardian_attack.ogg` / `guardian_hurt.ogg` / `guardian_die.ogg`；
2. `src/render/audio-config.js` 的 `SOUND_IDS` 加这三个 id；
3. 同文件 `SOUND_EXT_OVERRIDES` 加三条 `'ogg'`（**不在表里一律按 `.mp3`** ⇒ fetch 404 被
   `preload()` 的 catch 吞成 `console.warn`，页面照常能玩但没声）；
4. `SOUND_VOLUMES` 加三档音量（照焰魔 0.5）。

`check:data` 的 `[音效]` 环节从 `SOUND_IDS` + `soundFileName(id)` 派生（红线 1），
故第 2/3 步漏了会直接报「音效 xxx.ogg 缺失」—— 这是好事，不得绕过。

**受击音的例外**：玩家被守卫打中仍走 `Game._damagePlayer` → `ignis_hurt`（用户裁定
「不管被谁击中」的唯一入口，§4.4）；`guardian_hurt` 是**守卫自己挨打**时的声音，
接在 `damageEntity` 的守卫分支（与焰魔不同：焰魔受击不发声，本次新增）。

BGM 沿用 mc-heavy 既有 `bgm_boss.ogg`（与焰魔/飞龙同一首战斗曲，`_syncBossAudio` 按实体计数
自动淡入，见 §7）。

---

## 3. 总体架构：照搬焰魔五层，零新流程

末影守卫与焰魔的**运行时架构完全同构**——地面实体、重力+step-up 物理、三态 AI、
SkinnedMesh 渲染、按 B 召唤、临时实体（`persistent:false`）。这些 mc-heavy 全部现成。
逐层对应：

| 层 | 焰魔（既有） | 末影守卫（新增） |
|---|---|---|
| 冻结数值 | `entities/ignis/ignis-config.js` | `entities/guardian/guardian-config.js` |
| definition + service | `entities/ignis/ignis-system.js` | `entities/guardian/guardian-system.js` |
| AI 状态机 | `entities/bosses/ignis-boss-agent.js` | `entities/bosses/guardian-boss-agent.js` |
| 模型装载/采样 | `render/ignis-model.js` | `render/guardian-model.js` |
| SkinnedMesh 渲染 | `render/ignis-renderer.js` | `render/guardian-renderer.js` |
| 装配 | `core/game.js` | 同文件加 guardian 接线 |

全部顺着既有召唤框架：`Game.summonBoss()` 对 Boss 类型一无所知，只读 `bossMapAt()` 与
`bossSlotsFor()`，**不动**。新增只在 `boss-map.js` / `boss-registry.js` 各加一行 + 对应 service。

**同构层约束（红线 8）**：`guardian-config.js` / `guardian-system.js` / `guardian-boss-agent.js`
属 Worker 同构层，无 DOM、无 three、不新增 Worker、不碰音频（音频由 `game.js` 的
`_syncBossAudio` / 攻击音效差分统一负责，与焰魔同一分工）。

---

## 4. 三招的具体设计（纯近战，只扣血）

所有招共用焰魔的命中结算口径（`_consumeIgnisAttackRequests` 的守卫版）：**命中帧那一帧**，
对「水平距 ≤ 本招 `hitRange` **且** |Δyaw| ≤ 本招 `hitConeDeg`（半角）**且** 胸部视线通」的
玩家结算一次伤害。伤害统一走 `Game._damagePlayer`（扣血 + `ignis_hurt` 受击音的唯一入口）。

### 4.1 左/右重击（strong）
- 锥形：`hitRange 5.15`、半角 `35°`（= 作者 arc 70° 的一半）。
- 命中帧：右 29 tick = 1.45s；左 34 tick = 1.70s。动画时长各 3.0s。
- **原版的「重力拉扯」（出招前把玩家往拳头拽）不做**（属玩家位移效果，用户裁定只扣血）。
- 左右是两条独立动画（镜像），抽签时各占一档，观感不重复。

### 4.2 上勾拳（uppercut）
- 锥形：`hitRange 6.25`、半角 `30°`（= 作者 arc 60° 的一半）。
- 命中帧 27 tick = 1.35s；动画时长 4.5s（关键帧合计 90t，见 §2.4 的 100 vs 90 说明）。
- **原版命中后把玩家挑飞 + tick 54 发射 9 发炮弹，都不做**（用户裁定纯近战、只扣血）。

### 4.3 踩踏（stomp）—— 唯一一处「偏离原版」，必须说明
- **原版的踩踏伤害完全来自「虚空符文尖牙」**：`StompAttack()` 只调 `spawnFangs` 在脚下生成
  三圈（半径 2.5/3.5/4.5）+ 三条射线的延迟破土尖牙，**没有任何近战 `AreaAttack`**。
- 用户裁定不要弹丸 ⇒ 尖牙不做。为让踩踏仍有伤害，改成**以自身为中心的环形近战**：
  `hitRange 4.5`（= 原版尖牙最外圈半径）、**半角 180°（全向 360°）**、命中帧 32 tick = 1.6s、
  动画时长 2.4s。
- 这是本设计**唯一**偏离原版的招式机制，根源是「原版踩踏=尖牙」与「不要弹丸」两条裁定的
  交集；其余三招的判据全部照原版 `AreaAttack` 数值。

⚠️⚠️ **三招的 `hitConeDeg` 都是半角**（与焰魔同口径，`AreaAttack` 判 `|相对角| ≤ arc/2`）。
其中**踩踏刻意是 180°（全向）**，而重击/上勾拳是 35°/30° —— 故**不得**照搬焰魔那条
「半角 < 180」的守卫（那是为旋斩的 155° 背向死角设的）；本设计的锥角断言必须**逐招钉住
各自的值**，否则「踩踏从全向退化成前方锥」或「重击从 35° 扩成 180°」都会静默通过。

### 4.4 伤害口径（统一）
沿用焰魔先例：**所有招共用一个 `attackDamage = 16`**（作者 `ATTACK_DAMAGE`），不按招收
`damage` 乘数、不加 `hpdamage`。理由：① 与焰魔「同伤害」裁定同口径；② 不做挑飞/拉扯后，
上勾拳的 1.4× 乘数失去配套语义；③ 单一常量便于用户实玩后标定。**三招（= 4 条动画：
左右重击各一条镜像）**的差异由**射程/锥角/命中帧/动画**体现，不由伤害体现。

---

## 5. 玩法数值冻结表（`guardian-config.js`）

| 常量 | 值 | 出处 |
|---|---|---|
| `GUARDIAN_TYPE` | `'guardian'` | 新增（全仓 grep 无命名冲突） |
| `health` | **2000** | 用户裁定（原版 333） |
| `attackDamage` | 16 | 原版 `ATTACK_DAMAGE` |
| `halfWidth` | 1.25 | 原版 `sized(2.5,…)` 的一半 |
| `height` | 3.8 | 原版 `sized(…,3.8)` |
| `sightRange` | 50 | 原版 `FOLLOW_RANGE` |
| `chaseSpeed` | 5.4 | 原版 `MOVEMENT_SPEED 0.27×20`（⚠️ 见下） |
| `maxStep` | **1.0** | 原版 1.75，**本仓实现上限 1.0**（⚠️ 见下） |
| `gravity` | −24 | 与焰魔/丧尸同口径 |
| `flashMs` | 200 | 与焰魔同 |
| `maxAlive` | 1 | 废弃堡垒只有一个（= 渲染池容量 = draw call 上限） |

⚠️ **`chaseSpeed = 5.4` 的风险提示**：这是玩家跑速（8 格/秒）的 67%。焰魔曾因「过快」被
用户两次降速（6.6 → 4.4 → 2.93）。本设计按用户「参照原版」裁定取原值 5.4，**实玩后若觉得
过快，按焰魔先例调低**（改一个常量）。

⚠️ **`maxStep` 取 1.0 而不是原值 1.75（已实测，不是风险推测）**：
`zombie-navigation.js` 的 `zombieStepUpY(y) = Math.floor(y + 0.01) + 1` —— **抬升量恒为 1 格**，
`maxStep` 只做「抬升量 ≤ maxStep」的门控。实测（造 2 格高台阶 + 守卫体型）：

| maxStep | `_tryStepUp`（从 y=10 上 2 格） | `isWalkable(5,10,0)` |
|---|---|---|
| 1.0 | false | false |
| 1.75 | **false** | **false** |

⇒ **1.75 与 1.0 在现有实现下逐位等价**。写 1.75 只会得到一个「看着生效实际无效」的常量，
且会让「验证 maxStep 1.75 是否支持」那类探针得到假结论（1 格台阶恒 PASS、2 格恒 FAIL，
两侧都没有判别力）。故直接取 **1.0** 并在注释里写明原因；真要支持 >1 格台阶得改
`zombieStepUpY` 本身，那是**独立改动**（会影响丧尸/焰魔/玩家三方，不在本次范围）。
对可达性无影响：上层房间的守卫活动区（290 格）全在同一层 `ny39`，不需跨台阶。

**站定环 / 脱困 / 感知间隔等行为常量**：照搬焰魔 `IGNIS_AI` 的同名常量**语义**
（`standoffDeadband` / `stuckLeapSeconds` / `stuckNetDist` / `escapeLeap*` / `senseInterval*` /
`turnDelay` / `disengageRange` / `turnRate` / `losInterval` / `gravity` / `navPeriod`），
但**与体形和射程相关的四项必须重算，不得照抄焰魔的数**：

⚠️️ **`standoffRange` 由「最短的那一招」决定，不是由体形决定**（本设计实测发现的真缺陷）：
守卫四招的 `hitRange` 是 5.15 / 5.15 / 6.25 / **4.5**（踩踏最短），而焰魔两招都是 6.5。
若照抄焰魔的 `standoffRange = 5.0`，守卫会停在 5.0 格处出踩踏（4.5）⇒ **永远打不中**，
而所有常量看上去都对、单测的「`standoffRange ≤ hitRange`」也全绿（因为那条读的是派生
**最大值** 6.25）。故约束必须按**最小** `hitRange` 写：

```
attackRange < min(hitRange) = 4.5        （滞回，相等会在边界抖动）
standoffRange + 一步(5.4/60 ≈ 0.09) ≤ attackRange
standoffRange − standoffDeadband > 身体盒半宽(1.25) + 玩家半宽(0.3) = 1.55
⇒ standoffRange 3.5 / standoffDeadband 0.75 / attackRange 4.25
   校验：2.75 > 1.55 ✓ ；4.25 ≥ 3.59 ✓ ；4.25 < 4.5 ✓
```

`attackCooldownMin` 必须 > `attackAnimSeconds`（= 最长的上勾拳 4.5s）⇒ 取 **5.0**，
`attackCooldownMax` 取 **7.5**（命中间隔 [5.0, 7.5] 秒，动画 4.5 已含在内）。

**抽签权重（本仓标定，四档之和 = 1）**：`strong_right 0.3` / `strong_left 0.3` /
`uppercut 0.25` / `stomp 0.15`。理由：左右重击是主手段（共 60%，与焰魔「普攻为主」同口径），
上勾拳最长（4.5s）且射程最远故略少，踩踏是全向惩罚招（绕后也挨打）取最低避免压迫感过强。

**每招独立冷却（新增字段，焰魔只有旋斩一项）**：`cooldownSeconds` 写进 `GUARDIAN_ATTACKS`
每一档 —— `strong_right 0` / `strong_left 0`（两档普攻无额外冷却，只受全局
`attackCooldownMin/Max` 约束）/ `uppercut 9.0` / `stomp 12.0`。
取值约束（照焰魔 `spinCooldownSeconds` 的三条）：
① 必须 > 本招 `animSeconds`（否则冷却被动画吃掉，数值上不起作用）；
② 必须 ≥ `attackCooldownMin`（5.0），否则比普攻还频繁；
③ 取命中间隔中位数（6.25）的 1.4~1.9 倍 ⇒ 玩家能读出「砍两下、插一下大招」的节奏。
⚠️ **起手当帧就置位**（不是命中帧）：玩家跑掉不命中时，按命中帧计会让同一招反复抽中。
⚠️ **冷却未好时降级而不是白放**：抽签只在「冷却已好」的档里按权重归一化抽（焰魔同手法）。

`overlapEscapeDist` 按旋转后的身体盒算（见 §8）⇒ **1.95**（焰魔是 1.15）。

⚠️ **`EJECT_MAX` 必须复核（本次新增的连带项）**：`player/physics.js` 的推出探测上限
现为 **2.0 格**（当时按焰魔身体盒标定）。守卫盒更大且 `center.z = −0.4063` 使旋转后 AABB
**不对称**（yaw45° 时 x ∈ [−1.900, 1.326]）。扫全 yaw × 盒内玩家位置实测「沿 ±X/±Z 推出所需
最大距离」：**守卫 1.900 格**（焰魔 1.376）。⇒ 2.0 仍够，但**余量只剩 0.100 格**
（焰魔是 0.624）。故：① 不得再调大 `GUARDIAN_CORE_OBB`；② 单测要钉住这条余量
（`EJECT_MAX > 实测最深陷入`），将来改核心盒尺寸时它会红。

---

## 6. 召唤点 + boss-map / boss-registry 接线

### 6.1 `boss-map.js` 加 `RUINED_CITADEL` 判定器
转调既有权威（红线 1，不自写判据）：`computeRuinedCitadelAnchor(seed)` +
`inRuinedCitadelFootprint(wx, wz, [anchor])`。返回：

```js
{ kind: 'RUINED_CITADEL',
  cx: a.wx + RUINED_CITADEL_SUMMON_DX,    // +1
  cz: a.wz + RUINED_CITADEL_SUMMON_DZ,    // −2
  key: 'ruinedcitadel:0',
  summonY: a.floorY + RUINED_CITADEL_SUMMON_FEET_DY }   // −6，上层房间地板顶面，见 §2.3.2
```

⚠️ **`summonY` 恒为「上层房间」**（用户 2026-11-11 改判），与玩家所在高度无关 —— 同大竞技场
「任意层按 B 都召到固定那一层」的口径。`summonY` 用 `floorY − 6` 派生，**不复算**房间几何
（`floorY` 是锚点权威，`−6` 是 §2.3.2 实测的 ny 偏移：ny39 − 45）。

⚠️ **`cx/cz` 必须是房间落点而不是锚点中心**：落点相对锚点 `(x+1, z−2)`（§2.3.2 实测）。
三个偏移均作为 `ruined-citadel.js` 的导出常量（唯一权威），`boss-map.js` 只消费不复算。
⚠️ **房间几何中心 `(2,−2)` 守卫站不住**（3×3 footprint 撞格）—— 不得图方便直接用几何中心。

⚠️ **判定器优先级**：`RUINED_CITADEL` 插在 `BURNING_ARENA` 之后、`SNOW` 之前。理由与
大竞技场相同 —— 雪原盒是 region 级包围盒（±28）可伸进堡垒占地（±53/54），且堡垒锚点搜索
已对雪原地标做压制（`ruinedCitadelSuppressedLandmarks`），故必须先判堡垒再判雪原，否则
重叠点会被误判成 SNOW 召到几十格外。

⚠️⚠️ **守卫用例的 seed 清单必须用实测有重叠的那几个，不能照搬大竞技场的**（审阅实测）：
大竞技场那条用例的 8 个 seed（`12345 / 99999 / 1249026 / 20260101 / 777 / 4242 / 31337 / 8888`）
在**堡垒上零重叠**（最近雪原中心到占地净距 64~98 格，远超盒半宽 28）⇒ `checked > 0` 直接 FAIL。
另扫 40 个 seed 找到 7 处重叠，取其中 5 处验证当前 `bossMapAt` 均返回 SNOW（缺陷真实）：

| seed | 重叠点 | 堡垒锚点 | 雪原被堡垒压制 | 当前 `bossMapAt` |
|---|---|---|---|---|
| **2096** | (−327,124) | (−278,113) | **true** | `{kind:'SNOW', cx:−299, cz:152}` |
| **4151** | (−469,−101) | (−443,−47) | **true** | `{kind:'SNOW', cx:−441, cz:−103}` |
| 2644 | (−247,107) | (−194,161) | false | `{kind:'SNOW', cx:−272, cz:126}` |
| 3740 | (−268,259) | (−215,313) | false | `{kind:'SNOW', cx:−275, cz:274}` |
| 4973 | (−241,353) | (−188,343) | false | `{kind:'SNOW', cx:−266, cz:381}` |

⇒ **用这 5 个 seed**（`2096 / 2644 / 3740 / 4151 / 4973`）。其中 2096 与 4151 那座雪原
**世界里根本不存在**（已被堡垒压制），正是「按 B 召到几十格外一座不存在的雪原中心」那类。
扫 40 个 seed 实测耗时 3.6s，5 个 seed 在单测里可接受。

### 6.2 `boss-registry.js` 加名册
```js
RUINED_CITADEL: Object.freeze([
  Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
]),
```
本图唯一 Boss ⇒ slot 0（toast「已召唤 Boss1」）。

### 6.3 其余接线（`game.js`）
- `WEAPON_HITTABLE_TYPES` 加 `'guardian'`（剑/枪/炮塔可击中）。
- `_syncBossAudio` 的 `bossAlive` 计数加 `entities.count(GUARDIAN_TYPE)`（召出即淡入战斗曲、
  死了自动淡回，零新逻辑）；同方法内加守卫的「起手音 / 跳跃音」迁移差分
  （照焰魔那段的 `generation` 守卫，否则「死了又召」会构成假迁移）。
- `_runTurretAi` 的目标列表加守卫（`position` 是脚底 ⇒ 用缺省 `bodyOffsetY` 抬到胸部，
  与丧尸/焰魔同口径；飞龙的 position 是身体中心故显式传 0）。
  ⚠️ **光加 `WEAPON_HITTABLE_TYPES` 不够**：那张表只管「能不能被打中」，炮塔索敌是另一份清单。
- `_emitDamageNumber` 的 `headY` 加守卫分支（`y + GUARDIAN.height`）—— 漏了会落到飞龙口径
  （身体中心），数字飘在胸口而不是头顶，且首帧与逐帧锚点不一致（焰魔 v2.59 踩过）。
- 召唤音：`summonBoss` 成功分支已统一播 `ignis_burn`，**守卫沿用**（保持「唯一召唤入口
  一处配音」的既有约束，不为守卫开第二条分支）。
- 守卫受击音 `guardian_hurt` 接在 `damageEntity` 的守卫分支（§2.5）；死亡音 `guardian_die`
  接在 `_onEntityDeath`，与爆散色同位点。

---

## 7. AI 状态机 + 脱困技能（照搬焰魔三态机）

`guardian-boss-agent.js` 复用焰魔 `IgnisBossAgent` 的三态机骨架：

```
idle ──(玩家进 sightRange 且 turnDelay 到)──▶ chase
chase ──(距 ≤ attackRange)──▶ attack ──(动画播完)──▶ chase
chase/attack ──(距 > disengageRange 或视线断)──▶ idle
```

- **站定环**：追到「玩家外侧 `standoffRange` 格」的环即停、只转向；死区内不移动。守卫体形
  更宽，`standoffRange` / `overlapEscapeDist` 按 §8 重算。
- **攻击抽签**：三招按权重抽（左右重击各占一档 ⇒ 共 4 个抽签档位），每招独立冷却沿用焰魔
  「`attackCooldownMin > attackAnimSeconds`」的不变式（防冷却被动画吃掉）。
  ⚠️ 冷却下限必须按**最长的动画**（上勾拳 4.5s）定，否则上勾拳的冷却会被自己的动画吃掉。
- **脱困技能（用户点名要）**：完整照搬焰魔的 `stuckLeap`（卡住 `stuckLeapSeconds` 秒 →
  脱困飞跃）+ `escapeLeap*`（连续 N 次普通跳失败后按玩家高差强化跳）。
  ⚠️ **在上层房间里它跳不起来**（净空 5 格 − 身高 3.8 = 只能升 1.2 格，§2.3.3）——
  这是已知边界，**不得为它加补丁**（如「撞顶就换方向」或调小身高）；验收放开阔地形围栏。
- **感知间隔**（`senseIntervalMin/Max`）：照搬焰魔「追的是 1~2 秒前的玩家位置」，攻击用真实位置。

---

## 8. 玩家物理：身体盒阻挡 + 重叠推出（泛化焰魔那套）

焰魔 v2.60~v2.78 已建立「Boss 身体盒当实心挡玩家 + 真重叠时推出」的完整方案
（`PlayerPhysics._ejectFromIgnis` + `_collides()` 顶部的 `ignises.overlapsAabb`）。守卫照搬，
但**体形更宽**（半宽 1.25 vs 焰魔 0.5），两处必须泛化：

1. **注入**：`player.physics.guardians = this.guardians`（与 `ignises` 同手法）。
2. **`_collides()`**：把守卫身体盒并入 `overlapsAabb` 判定（`ignises` 或 `guardians` 任一命中即挡）。
3. **`overlapEscapeDist` = 1.95**（§8 实测推导：旋转后身体盒最大水平半宽 1.6205 + 玩家半宽 0.3）。
   比焰魔的 1.15 大 70%，因为守卫身体宽 51% 且核心盒更深。
4. **推出兜底**：`_ejectFromIgnis` 泛化成「对 ignis 与 guardian 两套身体盒都探最近不重叠出口」。

**核心 OBB（命中盒）—— 已用 Java 解析实测（不是估算）**：与焰魔同口径，取「身体核心」四根
骨骼（`lowerbody / upperbody / helmet / head`，共 6 个盒；不含外张的手臂/拳头/肩甲尖刺）
bind pose 的包围盒，**相对脚底**表达：

```
相对脚底 px  x[−20.000, 20.000]  y[22.000, 61.000]  z[−23.000, 10.000]
GUARDIAN_CORE_OBB.halfExtents = [1.2500, 1.2188, 1.0313]   （格）
GUARDIAN_CORE_OBB.center      = [0.0000, 2.7181, −0.4062]  （格）
```

⚠️ **`center.y = 2.59` 远大于焰魔的 1.51**：守卫的核心躯干（含头盔）整体更高，命中盒上沿到
脚底 3.81 格 ≈ 碰撞盒高 3.8 —— 即**核心盒几乎就是整个碰撞盒的高度**。焰魔 v2.59 那个
「盒以脚底为中心 ⇒ 胸口以上全打空」的缺陷在这里会以同样形态出现，故 `min[1] ≈ 1.375`
（= 2.7181 − 1.2188 = 1.4993）必须钉住「相对脚底」而不是「相对身体中心」。
⚠️ **`center[1]` 随 `feetOffsetY` 移动**（Task 3/4 实测）：模型空间中心 y = 1.0938，
脚底 −1.6243 ⇒ 相对脚底 2.7181。审阅期冻结的 2.5938 是按 feetOffsetY = 1.5 算的，已过期。
⚠️ **盒顶 3.9369 > 碰撞盒高 3.8**（头盔 + 动画下沉），属素材真实几何，断言上界取 height + 0.2。
⚠️ **`center.z = −0.41` 为负**：核心躯干相对脚底轴线偏向身前（−Z，yaw=0 的前向），
与焰魔同向但幅度更大（头盔向前伸）。`guardianAabbFor` 必须把 center 与半长**一起**绕
`state.yaw` 旋转。

**旋转后的最大水平半宽（`overlapEscapeDist` 的依据）**：核心盒水平半长 1.25 / 1.0313，
绕 yaw 旋转后的轴对齐包围盒最大值 = **√(1.25² + 1.0313²) = 1.6205**（在 39.5°，不是 45°；
45° 的值是 (1.25+1.0313)×√½ = 1.6131，略低估 —— Task 4 实测扫全圈纠正）。
故 `overlapEscapeDist ≈ 1.6205 + 玩家半宽 0.3 = 1.9205` ⇒ 取 **1.95**。
（焰魔是 0.8264 + 0.3 ≈ 1.13 → 1.15；守卫的身体宽 51%，这个阈值必须跟着涨，
否则玩家贴在盒斜角外被转身扫到时自愈永不触发 —— 焰魔 v2.78 的真软锁同源。）

⚠️ **但 1.6131 不是「推出所需距离」—— `center.z` 使 AABB 不对称**（审阅实测）：
`center.z = −0.4063` 让旋转后的盒偏心，yaw45° 时 x ∈ [−1.900, **1.326**]（不是 ±1.6131）。
扫全 yaw × 盒内玩家位置，「沿 ±X/±Z 推出所需最大距离」实测 **1.900 格**（焰魔 1.376）。
`player/physics.js` 的 `EJECT_MAX = 2.0` 仍够，但余量只剩 **0.100 格**（焰魔 0.624）。
⇒ 单测要钉 `EJECT_MAX > 1.900`，且**不得再调大核心盒尺寸**（调大就推不出来了）。

实施时由 `test-guardian-system.js` 的「产物独立复算」用例从 `assets/guardian/guardian.json`
重算并对账（防素材/烘焙器变了静默漂移）。⚠️ 复算时必须用**与烘焙器同一套坐标口径**
（§2.2.1 的 A：仅翻转 + 局部顶点），否则两侧差 1.5 格而对账恒红。

---

## 9. 烘焙管线（方案 A：扩展 Java 解析成生产烘焙器）

**新增** `tools/bake-guardian.mjs` + `tools/guardian-fingerprint.mjs`（参数与指纹的唯一权威，
与 `bake-ignis.mjs` / `ignis-fingerprint.mjs` 同一分工）。

- **输入**：`ModelEnder_Guardian.java` + `ender_guardian.png` + `ender_guardian_layer.png`。
- **输出**：`assets/guardian/guardian.{json,png,meta.json}`，**与 `ignis.json` 同格式**
  （`scale / bones / geometry / animations / metrics`）⇒ 运行时 loader/renderer 零格式改动。
- **解析**：抽成 `tools/java-model-parse.mjs` 共享模块，接口必须带 §2.1 的三处参数化：
  - `parseBones(text, ctorName)`；找不到构造函数一律 **throw**（不得静默返回空 Map）。
  - `parseAnimation(text, animConstName, { branch })`：`branch` 可选（焰魔传
    `'if (!entity.getIsShieldBreak()) {'`，守卫不传）；动画名匹配容许 `[\w.]*\.` 类名前缀。
  - `evalKeyframes(stmts, tau)` 返回 `{rot, pos}` 双通道（新增 `move` 分支）。
  - 骨骼树：`setPos`（相对父骨骼局部坐标）/ `addBox`（origin+size+inflate+mirror）/ `addChild` /
    `setRotationAngle`。
  - 旋转约定：`M = T(pos)·Rz·Ry·Rx`，关键帧欧拉角与 bind **逐轴相加**，缓动 `sin(frac·π/2)`。
  - **`move` 关键帧**：守卫 4 条目标动画共 44 个 `move`（实测 16/16/6/6）。产物动画帧格式已是
    **每骨每帧 7 值 = 四元数(4) + 平移(3)**（实测 `ignis.json` 的 `frames/(frameCount×bones)=7`），
    且 `sampleIgnisAnim` 已返回 `{rot, pos}` —— **平移通道现成支持**，无需改运行期采样。
  - ⚠️ **`move` 的 y 符号**：Java y 向下，口径 A 取反。实测例：踩踏的
    `move(left_leg, 0, −9, −9)` 是「抬腿 9px」⇒ 产物 `pos.y = +0.5625` 格。转错的形态是
    「出招时身体往反方向窜」，而骨骼数/帧数/指纹全对。
- **烘焙 4 条攻击动画**：`strong_right` / `strong_left` / `uppercut` / `stomp`（时长见 §2.4）。
- **idle 不烘焙关键帧**：守卫的 idle/行走是原版的**程序化** `walk()`/`flap()`（`setupAnim`），
  无关键帧。故 idle 用**程序化摆臂**（与丧尸 `zombie-renderer.js` 的 `Math.sin(phase)` 同手法），
  由移动相位驱动，不占烘焙产物。
- **眼睛层（≠ 焰魔盾的手法，审阅实测纠正）**：`ender_guardian_layer.png` 的 2,749 个非透明
  像素**直接覆盖**到主贴图。⚠️ **两张图是 100% 重叠的**（实测：主图不透明 23,752、
  layer 非透明 2,749、交集 **2,749**、layer 落在主图透明区 **0**）—— 因为它是原版的
  `RenderType.eyes` **叠加层**，本就画在身体上；而焰魔盾是「两块不相交的 UV 区」。
  ⇒ **不得照搬焰魔的「零重叠预检 + assertNoBodyPollution」**（那会在正确实现上报错）。
  不做独立发光通道（unlit 材质下眼睛与身体同亮度，观感可接受）。

  ⚠️⚠️⚠️ **阈值必须 `alpha > 0` 且拷贝时把 alpha 抬到 255**（Task 1 实施时实测新增，
  原文与焰魔同口径的 `alpha > 128` 是**错的**）：layer 的 alpha 只有三种取值
  `{0: 62787, 1: 145, 255: 2604}`，而 **alpha = 1 的那 145 个像素恰好就是全部真正改色的像素**
  （alpha = 255 的 2604 个与主图 RGB 逐位相同，一个也不改色）。双重陷阱：
  ① 用 `> 128` 筛 ⇒ 丢掉全部 145 个改色像素，合成退化成空操作；
  ② 原样拷 alpha = 1 ⇒ 渲染器 `alphaTest: 0.5` 在片元阶段 discard，效果等同于没合成。
  两种形态下骨骼数/顶点数/UV/指纹**全绿**。故合成语义定义为：
  `layer.alpha > 0` 处取 layer 的 RGB **并强制 alpha = 255**，否则保留主图。
  合成后实际变色 **145 像素**（其余 2,604 像素与主图同色），这就是眼睛的全部可见差异。
- **`feetOffsetY`**：扫 4 条动画全部帧的最低顶点（实测 lowestY = −1.6243 ⇒ 补偿量 **+1.6243**），
  写进 `metrics`，渲染器据此把脚底对齐 `position.y`。⚠️ 此值随坐标口径变（§2.2.1）。

**门禁**：`guardian-fingerprint.mjs` 记输入指纹 + 度量（骨骼数 20 / 盒数 24 / 各动画帧数 /
bind 包围盒 / **坐标口径标记**），`check:data` 加 `[末影守卫]` 环节守过期。

⚠️ **坐标口径必须进指纹参数**（照焰魔 `rotationConvention` 的先例）：取
`coordinateConvention: 'java-local-flipy'`。它不改任何输入文件，不进参数就是指纹盲区 ——
而换口径会改变每一个顶点与 `feetOffsetY`（§2.2.1）。

⚠️ **内容级断言必须用「与 layer 逐像素全等」而不是「紫色像素 > 0」**（审阅实测判别力）：

| 判据 | 漏合成（直接拷主图） | 正确合成 | 判别力 |
|---|---|---|---|
| 「产物紫色像素 > 0」 | 2885 | 2880 | **无**（两侧都 >0）✗ |
| 「与 layer RGB 逐像素全等的像素数 = 2749」（alpha>0 口径） | **2604** | **2749** | **有** ✓ |
| 「alpha>128 口径的全等数 = 2604」 | 2604 | 2604 | **无**（阈值选错就恒真）✗ |
| 「真正改色像素数 = 145」 | **0** | **145** | **有** ✓ |

（layer bbox 实测 `x[0,189] y[36,179]`；主贴图本身就有 2,885 个紫像素，故颜色类判据恒真。）
⇒ 冻结两条互补度量：`layerOpaquePixels: 2749`（覆盖完整）+ `layerChangedPixels: 145`（确实改色）。

---

## 10. 渲染（`guardian-renderer.js`）

SkinnedMesh 单几何（24 盒合并成一个 BufferGeometry）⇒ 每只守卫 **1 个 draw call**；
实例池容量 = `maxAlive = 1`，无守卫时 `visible=false` ⇒ 0 draw call。

- 共享几何/贴图，逐实例独立骨骼 + 独立材质（红闪是材质级 `color`，与焰魔同理）。
- 材质 unlit（`MeshBasicMaterial`）+ `DoubleSide`，与焰魔/丧尸/飞龙同口径。
- ⚠️⚠️ **骨骼位置公式与焰魔不同（坐标口径 A 的必然结果，§2.2.1）**：
  焰魔是 `bone.position = pivot − R_current·pivot + delta.pos`（Bedrock 绝对顶点）；
  守卫必须是 **`bone.position = localPosition + delta.pos`**（Java 局部顶点，旋转天然绕局部原点）。
  照搬焰魔那行会把每个部件多平移一个 `pivot − R·pivot`，形态是「模型炸成碎片」，
  而骨骼数/盒数/顶点数/指纹全对。产物的 `pivot` 字段在口径 A 下恒为零（保留仅为格式兼容）。
- ⚠️ **骨骼增量从 bind 快照起算**：每帧 `bone.quaternion = bindQuat × deltaRot`，
  直接 `*= delta` 会逐帧累积 ⇒ 守卫越挥越散架。
- 脚底补偿用产物 `metrics.feetOffsetY`（**不得**用命中盒中心，焰魔缺陷 A 的同源坑）。
- 上台阶视觉缓动复用 `StepLift`（与焰魔同一分工：权威 state 瞬时，渲染缓动），
  噪声门 `GUARDIAN_STEP_LIFT.epsilon = 1e-4`（与 `IGNIS_STEP_LIFT` / `ZOMBIE_STEP_LIFT` 同值同依据）。
- **姿态衔接**：`GuardianPoseTransition` + `guardianBlendSeconds(sourceKey)`，默认 0.2s
  （照焰魔 `IGNIS_POSE_BLEND.seconds`）。四招入场均用默认值（不引入焰魔旋斩那个 0.6s 特例）。
  **硬约束：淡入必须在命中帧之前走完** —— 最短命中帧是上勾拳 1.35s，0.2s 远小于它 ✓。
- **程序化 idle**：产物里没有 idle 片段（原版是 `walk()`/`flap()`），渲染器按移动相位做
  `Math.sin(phase)` 摆臂（照 `zombie-renderer.js` 手法），攻击片段期间**不叠加**。
- **死亡爆散**：血量归零 → 碎块爆散，基色取守卫主题紫（眼睛层主色 `(161,83,254)` ≈
  `[0.63, 0.33, 1.0]`），与焰魔「火焰橙」同位点。

---

## 11. 测试与门禁（按 `testing-policy.md` 分级）

| 层 | 内容 | 级别 |
|---|---|---|
| 烘焙产物契约 | 骨骼 20 / 盒 24 / 各动画帧数 60,60,90,48 / bind 包围盒 5.4176×4.2844×2.9017 / `feetOffsetY = +1.6243` 冻结；**眼睛层逐像素全等 2749**（内容级，§9） | Tier 2 |
| `test-guardian-config.js` | 数值不变式（`attackCooldownMin > attackAnimSeconds`、**`attackRange < min(hitRange)`**、`standoffDeadband > chaseSpeed/60`、**三招锥角逐招钉住**：重击 35° / 上勾拳 30° / 踩踏 180°、四档权重之和=1、每招 `cooldownSeconds > animSeconds`） | Tier 1（TDD） |
| `test-guardian-system.js` | 命中盒相对脚底（`min[1] ≈ 1.4993` / `max[1] ≈ 3.9369`）+ **产物独立复算**（同口径 A）+ yaw 现算 + `EJECT_MAX > 1.900` 余量 + 召唤幂等 | Tier 1 |
| `test-boss-map.js` | `RUINED_CITADEL` 判定器：锚点/边缘/外一格/**雪原重叠顺序（seed 2096/2644/3740/4151/4973，§6.1）**/名册 | Tier 1 |
| `test-ruined-citadel-gen.js` | 从产物重算三个落点常量（DX=1 / DZ=−2 / FEET_DY=−6）与 `HEADROOM ≤ 4` 的净空前提 | Tier 2 |
| Tier 4 E2E `guardian.spec.mjs` | 玩家进堡垒占地 → 真实 B 键 → 守卫落在**上层房间**（`y = floorY−6`、x/z = `a.wx+1`/`a.wz−2`、`onGround`、脚下实心、自身空气、id 带 `ruinedcitadel:0`）；三招命中扣血；boss 曲淡入；像素验收 | Tier 4（像素/状态实测，不得宣称目视） |
| Tier 4 脱困跳（**单独场景**） | 在**开阔地形的 4 格高围栏**里验收（照 `tests/ignis.spec.mjs`）—— 上层房间净空只 5 格，守卫只能升 1.2 格，**不得在堡垒内断言脱困**（§2.3.3） | Tier 4 |

⚠️ **E2E 的玩家路径已实测**：从甲板竖井底 `(14,39,18)` 到落点最短路 **65 步 ≈ 8.1 秒**
（跑速 8 格/秒）。若用真实行走驱动，等待窗口要 ≥ 20s；若用传送直接放进房间，
**必须另有一条「玩家自己走得进去」的断言**（否则只测了传送，没测可达性）。

⚠️ **单测基线**：当前 **1882/1882**（审阅时实跑确认）。harness 等待窗口 150s / 全局 timeout 200s
不需改（新增用例预计 <100 条，整页耗时增量远小于余量）。

门禁：`npm run check`（三门）+ `npm test`。守卫不进 bench 四场景的逐帧路径（召唤只在按 B
时算一次锚点，带 memo），故**不需** `bench --check`（与焰魔 v2.88 同口径）。

---

## 12. 明确不做（YAGNI，防止范围漂移）

- 其余 **13 个攻击动画**（实测 `getAnimations()` 共 19 条 = 1 条 NO_ANIMATION + **18 条具名**，
  其中 4 条烘焙、1 条 FALLEN 是死亡动画 ⇒ 18 − 4 − 1 = 13）：爆发击（BURST）、左/右轻击（LEFT/RIGHT_ATTACK）、
  湮灭（MASS_DESTRUCTION）、狂暴踩踏（RAGE_STOMP）、狂暴上勾拳（RAGE_UPPERCUT）、
  拥抱（HUG_ME）、传送打击（AIR_STRIKE1/2）、左/右挥击（LEFT/RIGHT_SWING）、
  黑洞（BLACKHOLE）、火箭拳（ROCKETPUNCH）—— 用户裁定只做三招。
- 上勾拳炮弹、踩踏尖牙（虚空符文）—— 一切弹丸实体。
- 重力拉扯、挑飞、击退 —— 一切玩家位移效果。
- 头盔二阶段（破盔狂暴）、`IS_HELMETLESS` 状态机。
- Boss 血条 HUD。
- 死亡倒地动画（FALLEN）。
- 方块破坏（`BlockBreaking`）、屏幕震动（`ScreenShake`）、粒子。
- **地牢连通性**（映射 `iron_trapdoor`、把楼梯做成可通行、让三层房间相连）—— 那是独立 spec，
  本次只把召唤点放在玩家真能走到的上层房间（§2.3）。
- **支持 >1 格台阶**（改 `zombieStepUpY`）—— 会影响丧尸/焰魔/玩家三方，独立改动（§5）。

以上任何一项要做，都是**新的独立 spec**，不在本次范围内。
