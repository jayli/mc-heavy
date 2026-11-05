# 焰魔（Ignis）Boss 导入设计（v2.55）

用户 2026-11-05：「我想给高台地带增加第二个 Boss（第一个 boss 是祭坛飞龙），第二个 boss 叫焰魔，
模型在 `[苦力怕论坛]v1.3.0-焰魔.mcaddon`。你分析这里的模型数据，完成焰魔的导入。」

**焰魔 = 高台地带（TARN）的 Boss slot 1**。飞龙仍是 slot 0（召唤顺序：先飞龙、后焰魔，
沿用 `boss-registry.js`「按 slot 升序找第一个空槽」的既有框架，零改动）。

---

## 1. 用户裁定（六项，2026-11-05）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 战斗形态 | **地面巨兽**（不走飞行） |
| 2 | 导入动画范围 | **只导待机 + 1 个攻击** |
| 3 | 战斗深度 | **近战攻击 + 玩家伤害 + 死亡**（Boss 被打死即消失） |
| 4 | 火焰闪烁贴图 | **只取一张静态贴图**（不做 8 帧序列） |
| 5 | 玩家掉血到 0 | **停在 0 不动**（不做死亡界面、不重生、不回血） |
| 6 | 模型缩放 | **原生 1 倍**（约 3.96 格高） |

近战判据（追加裁定）：**动画命中帧 + 前方锥** —— 挥剑动画播到命中帧那一刻，才对「前方锥内
且视线通」的玩家结算一次伤害。

---

## 2. 素材实况（实测，不是推测）
`[苦力怕论坛]v1.3.0-焰魔.mcaddon` 是 **Bedrock 附加包**（zip 内两个目录，文件名与内部路径是
GBK 编码；`焰魔BP/` + `焰魔RP/`）。与飞龙的 Blockbench `.bbmodel` **格式完全不同**。

### 2.0 两个素材源的对照（2026-11-05 追加）

用户提供了第二份素材：`~/jaylli/cataclysm1.19.2modding/`（Cataclysm mod 的 **Java 1.19.2**
源码）。两份是**同一个 mod 的两个平台移植**，已逐项实测对比（不是目测）：

| 项 | Bedrock `.mcaddon` | Java `cataclysm1.19.2modding` | 结论 |
|---|---|---|---|
| 模型定义 | `ignis.geo.json`（53 骨骼 / 88 立方体） | `ModelIgnis.java`（3551 行，53 骨骼 / 88 addBox） | **同一套几何**，但骨骼命名不同 |
| 剑/盾骨骼 | `sword_blade` `sword_core` `sword_guard` `shield_left` `shield_right` | `blade` `core` `upper_guard` `lower_guard` `handle_core` `left` `right` | **不同建模迭代**（Java 版剑盾拆得更细） |
| 贴图 | 256²，idle 0~7（8 帧） | 256²，idle 1~4（4 帧） | **逐像素相同**：`shield` / `soul_shield` / `armor_crack1` / `shield_crack1` 的 diffBytes = **0**；idle 仅帧数不同 |
| 音效 | 18 个（含 `sword1/2` `stomp` `theme` `burst`） | 17 个（含 `shield01~03` `earthquake`） | 17 个重叠，各 3~4 个独有 |
| 格式 | Bedrock JSON（`geometry.null.ignis`） | Java 手写 `AdvancedModelBox` | |

**采纳：仍用 Bedrock `.mcaddon` 作为烘焙输入。** 理由（三条，均为实测）：

1. **覆盖同一几何，而且更完整** —— 两者都是 53 骨骼 / 88 立方体，但 Bedrock 版是**更新**的
   建模（剑盾拆成 9 根骨骼而不是 5 根），资产名也对得上贴图（`sword_blade3` 对应
   `textures/.../ignis_idle_0.png` 的剑身区）。
2. **解析不引入新风险** —— Bedrock 是纯 JSON；Java 要解析 3551 行手写 Java（`setPos` 是相对
   父骨骼的局部坐标，比 Bedrock 的好处少一道旋转修正，但**必须解析源码**——那是脆弱的文本
   解析，且换了版本就失效）。
3. **贴图逐像素相同** —— 不存在「Java 版贴图更好」这张牌。

**Java 版的真正可用之处（已入本设计的采纳项）：**

- **⭐ 原作者的真实战斗数值**（`Ignis_Entity.java`，2026-11-05 实测读取）—— 这比凭空估
  的初版强得多，**已全部采纳并覆盖 spec §5 的初稿**：

  | 属性 | 作者真实值 | 出处 |
  |---|---|---|
  | `MAX_HEALTH` | **450** | `ignis()` 属性表；与 Bedrock `ignis.json` 的 `minecraft:health` 450 一致 |
  | `ATTACK_DAMAGE` | **14** | 同上 |
  | `MOVEMENT_SPEED` | **0.33** | 同上 |
  | `FOLLOW_RANGE` | **50** | 同上 |
  | `ARMOR` | 10 | 同上（本 v1 不做护甲减伤） |
  | `KNOCKBACK_RESISTANCE` | 1.0 | 同上（本仓实体本就无击退） |

- **⭐ 近战判据的真实语义**（`AreaAttack(range, height, arc, damage, hpdamage, ...)`，
  `Ignis_Entity.java:1431`）—— 与我原先猜的「前方锥 + 距离」相比，两处必须改：

  | 项 | 作者真实值 | 我原先的猜值 | 怎么改 |
  |---|---|---|---|
  | 攻击范围 | **6.5 格**（`SWING_ATTACK`） | 3.5 | 改成 6.5 —— 巨兽持剑横扇，6.5 格合理 |
  | 前方角 | **arc = 70°（半角 35°）** | 45（半角） | 改成半角 35° |
  | 命中帧 | `SWING_ATTACK` 的 tick **24** | `attack1` 的 t=1.75s | **见下面的动画配对** |

  ⚠️ `AreaAttack` 的 `arc` 是**总角度**（代码里判 `entityRelativeAngle <= arc/2`），
  搬到本仓时一律用**半角**（本仓 `fireConeDeg` / `hitConeDeg` 的口径是半角）——
  直接把 70 当半角填会让焰魔打出一个 140° 的扇面，**静默变强**。

- **⭐ Android 与 Bedrock 动画的 tick 配对表**（按 `animation_length × 20` 与
  `Animation.create(tick)` 双向匹配，**28 个长度值精确对上**）—— 这是把 Java 的攻击语义
  搬到 Bedrock 动画上的**唯一依据**，不要重新猜：

  | tick | Java 动画 | Bedrock 动画 |
  |---|---|---|
  | 37 | `SWING_ATTACK_BERSERK` | `berserk.attack6a/b` |
  | 44 | `HORIZONTAL_SMALL_SWING_ATTACK` | `attack8a1/b1` |
  | 55 | **`SWING_ATTACK`** | **`attack6a/b`** |
  | 58 | `HORIZONTAL_SWING_ATTACK_SOUL` | `attack7a/b`, `soul.attack7a/b` |
  | 61 | `COUNTER` | `attack13a` |
  | 64 | `SHIELD_BREAK_STRIKE` | `attack4_2a/b` |
  | 68 | `HORIZONTAL_SWING_ATTACK`, `PHASE_2` | （Bedrock 无 68t 条） |
  | 70 | `SHIELD_SMASH_ATTACK` | `attack1`, `phase_soula/b/c` |
  | 87 | `BREAK_THE_SHIELD` | `BTSa/b` |
  | 102 | `COMBO1` | `attack12` |
  | 105 | `SMASH_IN_AIR` | `attack9a/b`, `soul.attack10Sb` |
  | 114 | `ULTIMATE_ATTACK` | `attack11` |
  | 115 | `REINFORCED_SMASH(_SOUL)` | `attack10Sa/b` |
  | 120 | `PHASE_3` | `phase_berserka/b/c` |
  | 138 | `EARTH_SHUDDERS_ATTACK` | `attack3a/b` |
  | 162 | `REINFORCED_SMASH_IN_AIR(_SOUL)` | `attack10a/b` |

  ⇒ **本 v1 选的近战动画 = Bedrock `attack6a`（55 tick），不是 `attack1`（70 tick）**。
  `attack1` 对应的是 `SHIELD_SMASH_ATTACK`（盾碎），不是普通挥砍。

  命中帧换算：Java 在 `SWING_ATTACK` 的 tick 24 结算（`Ignis_Entity.java:782`）
  ⇒ **本仓烘焙的 `attack6a` 命中时刻 = 24/20 = 1.20 秒**，而不是我原先写的 1.75 秒。

  > ⚠️ 这条纠正了一个真bug：按原计划把 `attack1` 的 t=1.75 当命中帧，玩家会在
  > **盾碎动画播到一半时莫名其妙掉血**，而挥砍动画里反而没有伤害。
  > 错配的证据：`attack1` 的 `root.rotation.y` 峰值只到 **30°**（小幅转身），
  > 而 `attack6a` 到 **−65°**（大幅度横扫）—— 65° 才配得上「arc 70° 的横扫」。

- **`sounds.json` 的语义映射** —— 它把音效按**用途**分了类，这是 Bedrock 的 `sound_definitions.json`
  里没有的语义信息。直接用它：

  | 用途 | Java 事件名 | 本仓该接的时机 |
  |---|---|---|
  | 近战挥剑 | `ignis_poke`（4 变体） | **攻击动画起手**（`IGNIS_ATTACK` 开始） |
  | 盾/甲碎裂 | `ignis_shield_break`（3 变体） | v2 做阶段切换时才用（本 v1 不做） |
  | 重击/落地 | `ignis_impact`（3 变体）、`ignis_earthquake` | v1 用于「命中玩家」那一帧 |
  | 咆哮/受击 | `ignis_hurt`（4 变体） | Boss 被打中时 |
  | 死亡 | `ignis_death` | Boss 死亡 |
  | 环境声 | `ignis_ambient` | 待机时循环（可选） |

  ⚠️ **Bedrock 版多出的 `sword1/sword2` 与 Java 的 `poke1~4` 是两种体系**：Java 的 `poke`
  在源码注释里是「剑刺」语义，Bedrock 的 `sword` 是同一事件的另一套采样。本仓**只用一套**
  （`sword1`），避免两套同时存在而变成「打一下响两次」。

- **`ignis_earthquake`（30 KB）可作为命中重音**：Bedrock 版没有这个音效（它只有 `stomp`
  205 KB，太长不适合做命中反馈）。

**不采纳项（避免以后重复调研发）：**

- ❌ **不换用 Java 模型**：剑盾骨骼数不同会让 `IGNIS_CORE_OBB` 等实测常量全部重标。
- ❌ **不用 Java 的 4 帧 idle 贴图**：本仓取单张静态贴图（用户裁定 4），帧数多少无关。
- ❌ **不引入 Java 的 `ignitium_*` 盔甲/武器掉落**：不在本 v1 范围（§8 非目标）。
- ❌ **不用 Java 的 `ignis_fireball*.png`**：v1 不做投射物（§8 非目标）；64² 尺寸也与
  飞龙火球渲染器的口径不同。

> ⚠️ **音效接入是可选步（Task 8）**：本仓 `assets/sounds/` 目前只有 mp3，而两份素材都是
> `.ogg`。转格式需要 ffmpeg（本机是否可用未验证），且 `audio-config.js` 的 `SOUND_IDS`
> 是一条需要同步改的清单。**故：v1 先不接音效，但把映射表留在本文档里**，将来接入时不用
> 重新调研。

### 2.1 几何（`焰魔RP/models/entity/ignis.geo.json`）

- 格式版本 `1.12.0`，几何键名 `geometry.null.ignis`（**不是** `minecraft:geometry` 数组）
- **53 骨骼 / 88 立方体 / 50 根带元素的骨骼**
- 贴图 **256 × 256**
- 立方体规格：`{origin, size, uv: [u, v], inflate?, mirror?}` —— UV 只有**起点**，四个面的
  矩形由尺寸自动铺开（Bedrock 的 `box` UV 布局）。**不是**每面独立矩形（飞龙是每面）
- **18 个立方体有 `inflate`**（外扩厚度）、**22 个有 `mirror`**（镜像 UV）、**8 个是零尺寸薄片**
  （如 `right_helmet` 的 `size:[0,5,7]`）
- 模型空间 bbox（忽略骨骼旋转）= **61.7 × 63.3 × 83.5 px** = **3.86 × 3.96 × 5.22 格**
  （含剑尖；16px/格）。Bedrock 自带碰撞盒 `1 × 3.25`

### 2.2 动画（`焰魔RP/animations/ignis.animation.json`）

- **84 条动画**。多数按 `variant` 切换（`attack1`~`attack13`、`soul.*`、`berserk.*`、`phase_*`）
- **待机（`generala` / `generalb`）用 Molang 表达式**，不是数值关键帧：

  | 动画 | 骨骼 | 表达式 |
  |---|---|---|
  | `generala` | `left_arm` | `Math.sin(q.life_time * 128) * -2.5` |
  | | `left_hand` | `2.5 + Math.sin(q.life_time * 128) * 2.5` |
  | | `right_arm` | `Math.sin(q.life_time * 128) * 2.5` |
  | | `right_hand` | `-2.5 + Math.sin(q.life_time * 128) * -2.5` |
  | `generalb` | `root`（position.y） | `Math.sin(q.life_time * 128 + (-96)) * 0.75` |
  | | `root`（rotation.y） | `q.target_y_rotation` |
  | | `head`（rotation.x） | `q.target_x_rotation` |

  **全部标识符只有 4 种**：`Math.sin`、`q.life_time`、`q.target_y_rotation`、`q.target_x_rotation`。
- **攻击是纯数值关键帧**（本 v1 采用 **`attack6a`**，2.75 秒 / 55 tick，9 根骨骼驱动 ——
  配对依据见 §2.0）。峰值在 t≈1.0：`root.rotation.y` 到 −65°（大幅横扫）、
  `right_arm_joint` 到 −102.96°
- 素材把待机拆成两条（手臂摆动 + 呼吸/转头），需**同时叠加**

### 2.3 与飞龙的格式差异（为什么不能复用烘焙器）

| 项 | 焰魔 | 飞龙 |
|---|---|---|
| 输入 | Bedrock `geo.json` + `animation.json` | Blockbench `.bbmodel` |
| 立方体 UV | 起点 + 自动铺开 | 每面独立矩形 |
| 修饰 | `inflate` / `mirror` / 零尺寸薄片 | 无 |
| 动画值 | 数值**与 Molang 表达式混合** | 纯数值 |
| 贴图 | 256² | 128² |

**结论：新建烘焙器，不回改 `bake-dragon.mjs`**（两者输入格式不同，硬塞分支会让飞龙那条
已冻结的管线承担与它无关的风险 —— 飞龙现有 2760 顶点 / 4140 索引的产物契约必须零变化）。

---

## 3. 架构

### 3.1 新增文件

| 文件 | 职责 | 层 |
|---|---|---|
| `tools/bake-ignis.mjs` | Bedrock geo/anim → 产物 | node |
| `tools/ignis-fingerprint.mjs` | 参数 / 度量 / 输入指纹（红线 1 共享模块） | node |
| `src/entities/bosses/molang.js` | Molang 子集求值器（烘焙期用；进 `src/` 以便单测） | 同构 |
| `src/entities/ignis/ignis-config.js` | 玩法数值唯一权威 | 同构 |
| `src/entities/ignis/ignis-system.js` | definition + `IgnisService` | 同构 |
| `src/entities/bosses/ignis-boss-agent.js` | 地面 AI 三态机（`BossAgent` 子类） | 同构 |
| `src/render/ignis-model.js` | 产物装载 + 动画采样 | 主线程（three-free 采样） |
| `src/render/ignis-renderer.js` | SkinnedMesh 渲染 | 主线程 |

产物：`assets/ignis/{ignis.json, ignis.png, ignis.meta.json}`；素材入库 `assets/ignis/src/`。

> ⚠️ **素材入库而不是读 Downloads**：与 `assets/dragon/src/` / `assets/arena/src/` 同口径 ——
> 指纹必须不依赖仓库外文件，任何机器 `npm run check` 才结果一致。

### 3.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/entities/bosses/boss-registry.js` | TARN 名册加 `{slot:1, type:IGNIS_TYPE, service:'ignises'}` |
| `src/entities/entity-types.js` | `WEAPON_HITTABLE_TYPES` 加 `'ignis'` |
| `src/player/health.js` | 新增 `applyDamage(health, amount)` 纯函数（钳制到 [0, MAX]） |
| `src/core/game.js` | 装配 service + renderer；`damageEntity` 路由加 ignis；挥剑命中结算 |
| `tools/check-data.mjs` | 新增 `[焰魔]` 契约环节 |
| `src/tests/index.html` | 注册 4 个新单测 |

### 3.3 数据流

```
按 C → bossMapAt → bossSlotsFor('TARN') → slot0 飞龙（已存在→跳过）→ slot1 焰魔
                                                              ↓
                                            IgnisService.summon(mapKey, cx, cz, 1)
                                                              ↓
            找地面上一个可站立点（地图中心附近）→ entities.spawn(IGNIS_TYPE, persistent:false)
                                                              ↓
   每帧 entities.update → ignisDefinition.update → IgnisBossAgent.update
                                                              ↓
   Agent 读 ctx.world/player → 三态机 → 返回全新 state + attackRequest（瞬态）
                                                              ↓
   game.js 消费 attackRequest → 检查前方锥 + 视线 → player.health -= damage
                                                              ↓
                        渲染层 IgnisRenderer.sync(ignises.activeEntities(), nowMs)
```

**`attackRequest` 与飞龙 `fireRequest` 同构**：Agent 只写意图，不改世界、不改玩家
（`entities/` 同构层不得 import `player/`）。伤害结算在 `game.js`（装配层）。

---

## 4. 关键设计决策

### 4.1 Molang 子集求值器（`src/entities/bosses/molang.js`）

**支持**：数字字面量、`q.life_time`、`q.target_y_rotation`、`q.target_x_rotation`、
`Math.sin`、`Math.cos`、`+ - * /`、括号、一元负号。

**不支持即抛错**（不是回 0）：遇到任何其它标识符或语法 → `throw`。理由：素材换了动画却
静默回 0 的形态是「巨兽站着不动」——只有实玩才能发现，而抛错会在 `check:data` 与
单测里当场红。表达式在**烘焙期**求值（不在运行期），所以抛错只影响一次烘焙。

⚠️ **`q.life_time` 的语义**：Bedrock 里是「实体存活时间（秒）」。烘焙时按采样时刻 t 求值
（待机的采样长度恰为 1 个表达式周期，见 §4.2），所以 `q.life_time` 直接取 t。

⚠️ **`q.target_*_rotation` 烘焙期取 0**（理由见 §4.2 末段）。

### 4.2 待机动画的混叠与接缝

`Math.sin(q.life_time * 128)` 的角频率是 **128 rad/秒**，周期是
`2π / 128 = 0.0490874` 秒（约 20.4 Hz）。用飞龙的 30fps 重采样只剩 **1.47 样本/周期** →
严重混叠，出的是**拍频伪影**（观感是「抽帧抖动」而不是「火焰颤动」）。

**两条独立的约束，分别解：**

**① 采样密度**：≥ 10 样本/周期才看得出颤动。取 **1 个周期 12 帧**：

| fps | 1 周期帧数 | 判定 |
|---|---|---|
| 30 | 1.47 | 混叠 |
| 60 | 2.95 | 混叠 |
| 120 | 5.89 | 临界 |
| **12 帧 / 0.04909s** | **12** | **采用**（等效 240fps 密度） |

**② 循环接缝**：不靠「凑整数秒」，而是让**产物里的 `duration` 逐位等于表达式周期**：

```
period = 2π / 128                    // 0.0490873852… 秒（精确，不是取整值）
frameCount = 12
fps = frameCount / period            // 244.4577…（**不是整数，这是刻意的**）
duration = frameCount / fps          // ≡ period（逐位相等）
```

于是 `t mod duration` 循环时，末帧的下一帧正好是首帧**同一相位**。
接缝跳变在数学上**恒为 0**，不需要任何容差断言。

⚠️ **`fps` 不再是整数**：飞龙的产物 `fps` 恒为 30（`check-data` 里有 `fps !== 30` 的断言），
焰魔**不能照抄那条断言**。产物契约改为「`duration = frameCount / fps` 必须等于该动画
声明的 `periodSeconds`（误差 < 1e-12）」，待机与攻击各自成立：

| 动画 | frameCount | fps | duration | 来源 |
|---|---|---|---|---|
| `idle` | 12 | 244.4577… | `2π/128` = 0.0490874 s | 表达式自身周期 |
| `attack` | 105 | 30 | 3.5 s | 素材 `animation_length` |

⚠️ **待机与攻击的帧率不同是刻意的，不是疏漏**：待机有 20Hz 高频项需要高密度，攻击是
纯关键帧、30fps 足够。采样器按各自的 `fps` 换算（`sampleDragonAnim` 已是这个口径），
不引入新机制。

⚠️ **`q.life_time` 的语义**：Bedrock 里是「实体存活时间（秒）」。烘焙期取采样时刻 t；
因烘焙长度恰为 1 个表达式周期，运行期就表现为**无缝循环**的火焰颤动。

⚠️ **`q.target_y_rotation` / `q.target_x_rotation` 烘焙期按 0 处理**。取舍：这两项在待机里
只驱动 `root.rotation.y` 与 `head.rotation.x`，语义是「转向玩家」；而本仓的朝向已由
Agent 的 `_steerYaw` 控制，再叠一层物理头部朝向会双重叠加。
→ **在指纹与 `check-data` 里显式记下「这两项归零」**：将来若素材换了或要真做转头，
会在门禁里看到而不是静默失效。

### 4.3 烘焙器要点（`tools/bake-ignis.mjs`）

1. **骨骼**：`worldQuat` 累积 + `localPosition = R_parentWorld⁻¹ · (childPivot − parentPivot)`
   —— 与 `bake-dragon.mjs` 同一修正（Bedrock 的 `pivot` 同样是绝对模型空间坐标）。
2. **立方体几何**：`BoxGeometry(size + 2*inflate)`，`translate(inflate_offset + center)`。
   ⚠️ **`inflate` 是「向外均匀外扩」**：Bedrock 的语义是 origin 与 size 各减/加 `inflate`，
   即盒从 `origin - inflate` 到 `origin + size + inflate`。故盒中心仍在 `origin + size/2`，
   尺寸 = `size + 2*inflate`。
3. **UV 铺开（Bedrock `box` UV 布局）**：起点 `[u, v]`，六个面的矩形按以下顺序铺：
   ```
   east  : (u,            v + dz)
   north : (u + dz,       v + dz)
   west  : (u + dz + dx,  v + dz)
   south : (u + 2dz + dx, v + dz)
   up    : (u + dz,       v)
   down  : (u + dz + dx,  v)
   ```
   每个面 `(w, h)` = east/west `(dz, dy)`、north/south `(dx, dy)`、up/down `(dx, dz)`。
   ⚠️ **这是 Bedrock 的硬约定，必须用真实产物做像素比对验证**（写错形态是「贴图错位到
   邻面」，而格数/指纹/单测全绿 —— 与飞龙 spec §11 风险 1 同类）。验证手法：把产物渲染成
   六视图，与素材 `ignis_idle_0.png` 的已知特征（头部的金黄色角、盾的深色金属）比对。
4. **`mirror`**：UV 的 u 方向翻转（`u' = u_start + u_width − u`）。
5. **零尺寸立方体**：`size` 有 0 分量 → 跳过（8 个薄片在 Bedrock 里是零厚度装饰，`BoxGeometry`
   对 0 尺寸会退化成退化三角形）。
6. **动画重采样**：`idle` 12 帧（`fps = 12 / (2π/128)`）、`attack` 105 帧 @ 30fps。
   详见 §4.2 的两条约束（采样密度 + 接缝精确为零）。

### 4.4 地面 AI（`ignis-boss-agent.js`）

三态机：

```
idle ──(视线通 + 水平距 ≤ sightRange)──▶ chase
chase ──(水平距 ≤ attackRange)──▶ attack ──(动画播完)──▶ chase
attack ──(水平距 > disengageRange)──▶ chase
```

- **重力 + 地面吸附**：复用 `zombie-system.js` 的 `physicsStep` 手法（`GRAVITY = -24`、
  分轴移动 + `tryStepUp`），**碰撞判据用 `zombie-navigation.js` 的 `zombieCollidesAt`**
  —— 但那函数写死了丧尸的 0.6×1.8 AABB。**故新增一个类型参数版**：
  `collidesAt(world, x, y, z, halfWidth, height)`，`zombieCollidesAt` 变成它的薄包装
  （红线 1：只留一份实现，丧尸行为零变化）。
- **寻路**：复用 `steerIntent()`（同样需要参数化 AABB）。**不做 A* / 寻路网格**
  （与丧尸同口径：局部绕行即可）。
- **转向**：`_steerYaw` 复用 `BossAgent` 基类（`turnRate` 限速）。
- **攻击击发**：`attackAnimT` 累积；`attackAnimT` 越过 `hitFrameSeconds`（**1.20 秒** =
  作者 `SWING_ATTACK` 的 tick 24）的那一帧置
  `attackRequest = { at: 命中帧序号 }`（瞬态，由 game.js 消费后 Agent 清空）。

### 4.5 命中结算（`game.js`）

```
attackRequest 非空 → 
  ① 玩家水平距 ≤ IGNIS_AI.hitRange（6.5 —— 作者 `AreaAttack` 的 `range`）
  ② |Δyaw| ≤ IGNIS_AI.hitConeDeg（35° —— 作者 `arc 70` 的**半角**）
  ③ 焰魔身体中心 → 玩家胸部：hasLineOfSight（与飞龙火球同一权威）
  三条全过 → player.health = applyDamage(player.health, IGNIS.attackDamage)
```

⚠️ **只在 `attackRequest` 那一帧判定**（不是每帧）：否则玩家站在旁边会被连续扣血。

### 4.6 玩家掉血（`src/player/health.js`）

新增纯函数：

```js
export function applyDamage(health, amount) {
  const hp = Number.isFinite(health) ? health : PLAYER_MAX_HEALTH;
  const dmg = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return Math.max(0, Math.min(PLAYER_MAX_HEALTH, hp - dmg));
}
```

**停在 0 不动**（用户裁定 5）：不写死亡标记、不重生、不回血。

⚠️ **血心 HUD 自动跟随**：它每帧读 `player.health`（`health-hud.js:119`），无需改。
⚠️ **不写存档**：`health.js` 的既有注释明确「值恒为 20，不入存档」。现在值会变，
但**仍不入存档** —— 重进游戏回满血。这是一个**有意的取舍**：把 `health` 写进 `meta` 行
需要 `settingsVersion` 迁移，而「重进游戏回满血」对「只扣血不死亡」的当前阶段是合理的
（用户没要求持久化）。

---

## 5. 玩法数值（`ignis-config.js`）

**v1 的数值不再是我猜的初稿 —— 全部取自 `Ignis_Entity.java` 的原作者真实属性**
（2026-11-05 实测读取，见 §2.0 的表）。只有 4 项（标「本仓标定」）是 Java 里没有、
必须由本仓自己定的。

### 5.1 直接取自作者（不得随意改）

| 常量 | 值 | 出处 |
|---|---|---|
| `IGNIS.health` | **450** | `ignis()` 的 `MAX_HEALTH`；与 Bedrock `ignis.json` 一致 |
| `IGNIS.attackDamage` | **14** | `ATTACK_DAMAGE`（玩家 20 格血 ⇒ 2 下即死，压迫感很强） |
| `IGNIS_AI.sightRange` | **50** | `FOLLOW_RANGE` |
| `IGNIS_AI.chaseSpeed` | **6.6** | `MOVEMENT_SPEED 0.33` × 20（MC 格/秒：0.33 格/tick × 20） |
| `IGNIS_AI.hitRange` | **6.5** | `AreaAttack` 的第一参 `range`（`SWING_ATTACK`） |
| `IGNIS_AI.hitConeDeg` | **35** | `AreaAttack` 的第三参 `arc = 70`，⚠️ **arc 是总角度 ⇒ 半角 35** |
| `IGNIS_AI.hitFrameSeconds` | **1.20** | Java 在 `SWING_ATTACK` 的 tick **24** 结算；24 / 20 = 1.20 秒 |
| `IGNIS_AI.attackAnimSeconds` | **2.75** | 对应 Java `SWING_ATTACK` = 55 tick；Bedrock `attack6a` = 2.75s |

> ⚠️ **`hitConeDeg` 的 35 不是 70**：`AreaAttack` 里判的是 `|relativeAngle| <= arc/2`。
> 本仓的 `fireConeDeg` / `hitConeDeg` 口径都是**半角**。填 70 会让扇面变成 140°，
> 玩家绕到侧面也躲不掉 —— 静默变强，且没有任何断言会红。

> ⚠️ **`attack6a` 而不是 `attack1`**：配对依据是 tick 数（见 §2.0 的配对表）。
> `attack1`（70 tick）对应的是 `SHIELD_SMASH_ATTACK`（盾碎），不是普通挥砍。
> 交叉证据：`attack6a` 的 `root.rotation.y` 到 −65°（大幅横扫，配得上 arc 70°），
> 而 `attack1` 只到 +30°。

### 5.2 本仓自己标定（Java 里没有对应项）

| 常量 | 值 | 依据 |
|---|---|---|
| `IGNIS_AI.attackRange` | 5.5 | 进入攻击的距离。比 `hitRange`(6.5) 小 1 格是**滞回**：在 6.5 边界来回走不会让「起步/取消」每帧抖动 |
| `IGNIS_AI.chaseSpeed` 的采用说明 | — | 6.6 格/秒 vs 玩家跑步 8 格/秒 ⇒ 跑得掉但甩不脱（作者原值就是「比你慢一点」） |
| `IGNIS_AI.turnRate` | 3.0 rad/秒 | 与飞龙同（作者未给常量，Java 的 `lookControl` 是 30°/tick 的转向插值，本仓用平滑限速更自然） |
| `IGNIS_AI.attackCooldownMin/Max` | 2.75 / 5.0 | 攻击动画本身 2.75 秒，加 0~2.25 秒间隔。⚠️ **不是**作者的 `HORIZONTAL_SWING_COOLDOWN = 160 tick`（那是横扫的专属冷却，本 v1 只有一个攻击） |
| `IGNIS_AI.losInterval` | 0.1 | 与飞龙同（10Hz 视线缓存） |
| `IGNIS_AI.disengageRange` | 60 | `sightRange`(50) × 1.2 的滞回上界，防边界抖动 |

### 5.3 尺寸与几何（实测）

| 常量 | 值 | 依据 |
|---|---|---|
| `IGNIS.halfWidth` | **0.5** | Bedrock `minecraft:collision_box` 的 `width: 1` |
| `IGNIS.height` | **3.25** | Bedrock `collision_box` 的 `height: 3.25` |
| `IGNIS.modelFeetOffsetY` | **0.3042** | 模型最低顶点在 y = −4.87px = −0.3042 格（软件光栅化实测），**不是 0** |
| `IGNIS_CORE_OBB.halfExtents` | **[0.8264, 1.421, 0.777]** | 躯干+头核心 bbox 实测（不含剑/盾/手臂外沿） |
| `IGNIS_CORE_OBB.center` | **[0, 0, 0]** | `position` 语义 = 身体核心中心（与飞龙同） |
| `IGNIS_MODEL_CENTER` | **[0, 1.7335, 0.0895]** | 核心 bbox 中心相对模型原点（单位格），渲染层摆 mesh 用 |
| 全模型包围盒（bind pose） | **4.8796 × 3.8346 × 5.1576** 格（宽×高×深） | 含剑尖与盾。**v2.58 重标**：旧值 3.7329 × 4.0668 × 5.1576 是错误旋转约定下的实测；新值由 `tools/ignis-java-reference.mjs` 直接解析 Java 源码独立复算，与修正后的产物逐位一致 |

> **v2.58 对本节常量的影响（实测，未采纳，留作后续命中盒对齐的数据）**：旧的 `IGNIS_CORE_OBB` / `IGNIS_MODEL_CENTER`
> 是在错误约定的 bind pose 上量的。按同一口径（`upperbody, head, lowerbody, lowerbody2, bodycore, right_chestplate,
> left_chestplate` 七根骨骼）在修正后的 bind pose 上复测：核心 bbox = x[−13.22, 13.22] y[5, 51.84] z[−14.75, 8.05] px
> ⇒ `halfExtents = [0.8264, 1.4637, 0.7125]`、模型空间中心 = `(0, 1.7762, −0.2095)` 格（躯干前倾使 z 向中心前移 0.30 格）。
> **本版没有改这两个常量**：它们的语义（`center = [0,0,0]` =「position 是身体核心中心」）与 v2.56 之后渲染器的「position = 脚底」
> 本就不一致（实测射线只在脚底 −1.4 ~ +1.4 格内命中，胸口 1.5 格以上全部打空），单改 `halfExtents` 只是装饰；
> 该不一致需要单独评估（见 roadmap v2.58 的「遗留」）。

### 5.4 刻意不做

- **不做护甲减伤**（作者的 `ARMOR = 10`）：本仓武器伤害模型里没有护甲概念，
  加一层会让焰魔的实际血量变成 450 × 1.4 ≈ 630，与玩家武器的数值体系脱节。
- **不做掉落的 `ignitium_*` 装备**（见 §8）。
- **不做作者的 `hpdamage` 百分比伤害**：`AreaAttack` 的第五参 `hpdamage` 是「按目标最大血量
  百分比扣」，本仓玩家血量是固定 20 格，百分比伤害会变成「百分比 × 20」的不直观数值。
  **只取 `damage` 那一项**。

---

## 6. 测试计划（按 `docs/testing-policy.md` 分级）

### Tier 1（必须 TDD）

| 测试文件 | 覆盖 |
|---|---|
| `src/tests/test-molang.js` | 求值器：4 个标识符、四则、括号、负号、**非法标识符抛错**、除零 |
| `src/tests/test-ignis-bake.js` | 产物契约：骨骼/立方体/顶点计数、UV 在 [0,1]、`inflate` 生效、`mirror` 翻转、零尺寸被跳过、`idle` 12 帧 / `attack` 105 帧、**`duration` 逐位等于声明的 `periodSeconds`**（接缝恒 0） |
| `src/tests/test-ignis-system.js` | `createState` 校验、`IgnisService.summon` 幂等、`damage` 死亡即 despawn |
| `src/tests/test-ignis-boss-agent.js` | 三态机转移、`attackRequest` 只在命中帧出现一次、重力/落地、视线断则脱离、`zombieCollidesAt` 参数化后丧尸零回归 |
| `src/tests/test-health.js`（改） | `applyDamage` 钳制（负数/NaN/上限/下限） |

### Tier 2（门禁断言）

`tools/check-data.mjs` 新增 `[焰魔]`：产物存在 + PNG 256² + 骨骼 53 / 立方体 88 减 8 零尺寸 /
顶点索引数 + 动画清单 `idle,attack` + 帧数 + 指纹。

### Tier 3

`npm run check`（arch + data + lint）。

### Tier 4（像素实测）

`tests/ignis.spec.mjs`：真实游戏页召唤焰魔，截图对照：
- 焰魔出现在地图中心的地面上（不是悬空、不在地下）
- 挥剑动画在 t≈1.75 时手臂/剑的姿态与 bind pose 显著不同（像素差异 > 噪声底）
- 玩家被砍后血心减少（像素比较血心行）

---

## 7. 风险与未决

| 风险 | 处理 |
|---|---|
| **Bedrock UV 铺开写错** | 六视图像素比对（§4.3 第 3 条）。单测只能钉「UV 在 [0,1]」，钉不住「铺对了」 |
| **待机接缝跳变** | §4.2 已从数学上消除（`duration ≡ 2π/128`），单测钉 `duration` 逐位相等即可 |
| **地面 AI 卡在拱洞/高台上** | 复用丧尸的 `steerIntent` 局部绕行；不做 A*。已知取舍与丧尸一致 |
| **`zombieCollidesAt` 参数化改动** | 必须保证丧尸零回归（既有 40 个 dragon/zombie 用例全绿 + `tests/` 的 spec） |
| **焰魔与飞龙同名 ID 冲突** | `ignisEntityIdFor(mapKey, slot)` 与 `dragonEntityIdFor` 同手法，前缀不同 |
| **`WEAPON_HITTABLE_TYPES` 加 ignis** | 炮塔索敌会自动开始打焰魔（`turret-system.js` 消费同一份表）—— 这是**要的**（用户可建炮塔助战），但须在文档里记一句 |

---

## 8. 非目标

- 不做焰魔的投射物（火球/火墙）—— 素材里有，但用户裁定 v1 只做近战
- **v1 不接音效**（§2.0）—— 映射表已留档，接入时不用重新调研
- 不做阶段切换（护盾破碎/狂暴）—— 素材有 `phase_soul` / `phase_berserk`，留待 v2
- 不做 8 帧火焰贴图序列
- 不做玩家死亡/重生
- 不做焰魔的装备掉落（素材有 `ignitium_*` 盔甲与剑）
- 不离线烘焙素材里的 `altar_of_fire` / `ignitium_block` 方块（用户没要求新增方块）
