# 敌人士兵（soldier）移植设计 —— 方案 B：先简单实现

**日期**：2026-11-24
**状态**：待用户批准
**上游**：`~/jaylli/bj-shooting-game/night-heron-src/src/game/enemies.js` 的 `Soldier` 类与 `soldierGeometries()`
**用户裁定**：每发子弹扣玩家 **2 血**；材质走**炮塔那套金属 TSL**；**本轮不做士兵专属音效**；班组联动（互相报警 + 听枪声搜索）**完整移植**；掩体方案取 **B（不扫掩体，先简单实现）**。

---

## 1. 意图与理由

用户原话：「增加一种敌人，敌人士兵（soldier），造型和建模都来自 bj-shooting-game 里的敌人，端着枪可以发射子弹的，携带原始的 soldier 的 AI 行动能力，也可以被玩家击毙，被机枪、散弹枪、刀、卡宾枪等等现有武器击伤，包括 tnt 也可以击伤他们。按 C 键召唤 soldier，同时存活的 soldier 只可以召唤 10 个，让丧尸巢穴也可以生成 soldier，丧尸和 soldier 可以间隔生成。如果 soldier 已经无法再生成了（存活的 soldier 足够多了）就只好生成丧尸（如果丧尸还可以生成的话）。」

士兵与丧尸的玩法分工：**丧尸是贴身追逐的近战杂兵**（1.2 格/秒、无远程），**士兵是保持距离的远程射手**（点射、班组警戒、会蹲下）。这是本仓第一个会远程攻击玩家的普通敌人（此前只有飞龙火球与 Boss 近战）。

## 2. 目标 / 非目标 / 反目标

### 目标

1. 新实体类型 `soldier`：造型逐件取自上游 `soldierGeometries()`，端枪姿态、行走步态、蹲起、开火后坐、死亡倒地。
2. AI 取上游 `Soldier` 的状态机与班组联动：`patrol → notice(awareness) → combat → search`，含互相报警、听枪声搜索、点射节奏、同一时刻最多 2 名开火。
3. **C 键召唤**，同时存活上限 **10**（与丧尸的 20 各自独立计数）。
4. 丧尸巢穴**交替**产出 soldier / zombie；soldier 满额时回落 zombie，zombie 也满额则本次不产出（照旧写回时钟）。
5. 现有全部武器（手枪 / MAG7 / 加特林 / 剑 / KV-9 / Storm Lance / Cinder Fall）与 **TNT** 都能击伤它；炮塔也索敌它。
6. 士兵子弹命中玩家扣 **2 血/发**，走既有唯一入口 `_damagePlayer`（红闪 + `ignis_hurt` 自动跟上）。

### 非目标（明确不做）

- **不做掩体系统**（方案 A）：不扫体素找矮墙、不到掩体后蹲下探头、不做 `pickCover / coverBad / coverT`。上游那套依赖 `level.cover`（那张固定城市地图手写的 60 来个掩体点），本仓是无限程序化世界，无此数据。**B 用「保持距离环 + 侧向游走 + 周期蹲起」代替**。
- **不做巡逻路线**（上游 `def.route` 是手写 nav 图节点索引）：未接敌时在出生点附近小幅踱步。
- **不做无人机（Drone）**：上游同文件的另一类敌人，用户没要求。
- **不做士兵专属音效**（用户裁定）：开火 / 倒地 / 警戒都不新增音频文件、不新增烘焙配方。死亡音复用既有 `z_die`（理由见 §5.7）。
- **不做爆头判定**（上游 `rayHit` 有 head/body 分区与不同伤害）：本仓统一 AABB 命中，与丧尸/Boss 同口径。
- **不做士兵存档**：临时实体（`persistent: false`），与丧尸/Boss 一致（红线 2）。
- **不做士兵专属 HUD / 威胁指示器**（上游 `mgr.threat()`）：本轮不加 UI。
- **不动丧尸的任何既有行为**（`ZOMBIE_BEHAVIOR` 的犹豫/后退/徘徊全部原样）。

### 反目标（做成了也算失败）

- **士兵变成「会开枪的丧尸」**：若它直冲玩家、贴身站定、或从不蹲下，B 方案就退化成换个皮的丧尸。§5.3 的距离环是身份的载体。
- **判据恒真**：断言在缺陷注入后仍 PASS。§8 逐条给负向验证。
- **静默失效**：扣血/计数全对而画面上没士兵、或子弹不上屏、或巢穴只出丧尸。这三类各有一条专门判据。

## 3. 现状取证（HEAD `1845086`）

### 3.1 上游可移植的部分（读源，非推断）

| 上游位置 | 内容 | 本仓落点 |
|---|---|---|
| `enemies.js:16-48` `soldierGeometries()` | 5 个部件（pelvis/torso/head/thigh/shin）；torso 含**枪 + 双臂 + 手套**，全部刚性合并 | `render/soldier-geometry.js`（照 `carbine-geometry.js` 的 `Parts` 手法） |
| `:105-127` 构造器层级 | `root → body → {pelvis, torso → head, thL → shL, thR → shR}`；muzzle 在 torso 局部 `(0.07, 0.39, 0.98)` | InstancedMesh 逐部件矩阵链（照 `zombie-renderer.js` 的父×子） |
| `:80-88` `sees()` | eye→玩家胸/头双射线、fovCos 视锥、距离门 | `hasLineOfSight`（炮塔/Boss 共用权威）+ 视锥余弦 |
| `:90-124` `shootAt()` | **hitscan**：命中率骰子 → 命中则 `p.damage()`，未命中则朝散布点 `col.raycast` 找落点 | `entities/soldiers/soldier-shooting.js` 纯函数 |
| `:216-273` `thinkStep()` | awareness 累积、combat/search/patrol 转移、`since` 计时 | `entities/soldiers/soldier-agent.js` |
| `:275-380` `update()` | 沿 path 移动、stuck 重规划、yaw/aimPitch 缓动、点射、姿态 | 同上 + `soldier-system.js` 的 60Hz 物理 |
| `:565-576` `alertOthers()` | 34 格内同伴延迟 0.5~1.4s + d×0.03 进入 combat | `SoldierService.alertNearby()` |
| `:577-588` `hearShot()` | 48 格内非战斗士兵转 search 并走向声源 | `SoldierService.hearShot()` |
| `:601-618` `update()` 的 advancer / bursting | 每 2s 选一名推进者；**并发点射上限 2** | `SoldierService.update()` |

**上游依赖但本仓没有的**：`G.level.cover`（掩体点）、`G.level.nav`（导航图）、`G.col.move/raycast/blocked`（连续碰撞体）、`G.lights`（动态点光）、`G.fx.*`（上游粒子池）。前者两个是 B 方案要绕开的，后三者本仓各有等价件（体素 AABB / `raycastVoxel` / unlit + 金属 TSL / `carbineFx`）。

### 3.2 本仓可复用的件（全部已实测过）

| 需求 | 复用 | 依据 |
|---|---|---|
| 寻路（长墙可达性） | `PathCache.plan` + `decideStep` + `steerIntentAabb` | 已按 `box{halfWidth,height,maxStep}` 参数化，焰魔/守卫在用；**士兵 0.6×1.8 与丧尸逐位同尺寸** ⇒ 可直接用 `zombieCollidesAt` |
| 60Hz 物理 + 一格 step-up | `zombie-system.js` 的 `physicsStep` 结构 | 同尺寸 ⇒ 同一份 `aabbCollidesAt`；⚠️ **不共用函数本体**（见 §5.2） |
| 实体命中 | `EntityManager.raycast/raycastAll` + `raycastAabbSlab` | 红线 6 |
| 方块遮挡 | `raycastVoxel`（DDA） | 红线 6 |
| 视线 | `hasLineOfSight`（solid && opaque） | 炮塔/Boss 共用；⚠️ 玻璃可穿透、树叶阻挡（实测 `leaves opaque=1`） |
| 曳光 / 火花 / 烟尘 | `CarbineFx`（**需新增三个公开薄方法**，见 §5.4） | 已过像素实测；池容量曳光 40 / 火花 360 / 烟 140。⚠️ `_fireTracer` / `_spawnSparks` / `_spawnPuff` **当前都是私有方法**，不是现成公开 API |
| 枪口火光 | `carbine-view.js` 的 `makeFlashMaterial` 形状（星芒 + 十字 blade） | 已过像素实测（NormalBlending，暖色 additive 会钳白）。⚠️ **该函数未导出** ⇒ 需提取成共享模块，见 §5.6 |
| 死亡爆散 | `blockHitFx.spawnDeathBurst` | 碎块池 128，不开第二池 |
| 红闪 / 伤害数字 / 击退 | `damageEntity` / `_emitDamageNumber` / `knockbackEntity` 分发器 | 接线门已覆盖 |
| 金属材质 | `createTurretMetalMaterial`（读 `dayNight.uSunDirection`） | 用户裁定；⚠️ 见 §5.6 的三处必要改写 |
| 上台阶 / 击退视觉缓动 | `StepLift` / `KnockbackEase` | 逐实例一份 |

### 3.3 接线点清单（漏一处的后果）

`docs/superpowers/specs/2026-11-23-enemy-wiring-completeness-gate-design.md` §1 已实测：9 处里 7 处静默失效。本次要动的：

| 文件 | 改什么 | 漏改后果 |
|---|---|---|
| `entities/entity-types.js` | `WEAPON_HITTABLE_TYPES` 加 `'soldier'` | 武器打不到（可见） |
| `core/game.js` `damageEntity` | 加 soldier 分支 | 打不掉血（可见） |
| `core/game.js` `knockbackEntity` | 加 soldier 分支 | 挨剑不后退（静默） |
| `core/game.js` `_onEntityDeath` | 加 soldier 分支（音 + 爆散） | 死亡无声无爆散（**静默**） |
| `core/game.js` `_emitDamageNumber` 的 `headY` | 加 soldier 分支 | 数字飘胸口（**静默**） |
| `core/game.js` `_cinderBlast` 的 `half` | 加 soldier 分支 | 溅射中心偏半身（**静默**） |
| `core/game.js` `_runTurretAi` | targets 加 soldier | 炮塔不打它（**静默**） |
| `core/game.js` `_damageEntitiesInRadius` | **改为遍历丧尸 + 士兵** | **TNT 打不到士兵**（用户明确要求） |
| `core/game.js` `bossAlive` | **不加** soldier | 加了会让士兵拉起 Boss 战 BGM（玩法变更） |
| `player/physics.js` `_collides` | **不加** soldier | 见 §5.5：10 个士兵会把玩家挤住 |
| `tests/enemy-roster.mjs` | 登记 soldier | 接线门静默跳过它 |
| `src/tests/test-weapons.js` | 那条「恰好四类型」断言改五项 | 门禁红（这是刻意的闸门） |
| `tools/test-tiers.mjs` | 新 spec 归档 | `check:data` 红 |

## 4. 关键约束

1. **同构层纪律**（红线 8/10）：`entities/soldiers/**` 不得 import three、不碰 DOM、不自建 Worker。
2. **只读 state 返回全新对象**（M5 不变式）：`EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让索引永不迁移 → column 卸载漏回收。**新数组也要新建**（浅拷贝不够）。
3. **跨帧量必须留在 state**：`_physAccum` / awareness / 各计时器 / burst 计数丢掉任一 ⇒ 每帧重置 ⇒ 该机制永不生效而数值看着全对（焰魔/守卫已各踩一次）。
4. **不生成实体、不改世界、不写玩家血量**：Agent 只写 `shotRequest` 意图，由 `game.js` 在 `entities.update` 之后结算（照 `attackRequest` / `fireRequest`）。
5. **时间基准 `performance.now()`**，禁 `Date.now()`（红闪判定会恒真）。
6. **常态零分配门控**：每帧跑的方法在场上无士兵时只做一次 `entities.count()`（`_updateFireballs` 的教训：无门控把 fastRemeshP95 从 1.1 抬到 4.5）。⚠️ 门控必须区分「已知为 0」与「未知」。
7. **空载 draw call 回基线**：无士兵时全部 InstancedMesh `visible=false`。
8. **不改既有冻结数值**：`ZOMBIE.*` / `TURRET.*` / `NEST.spawnIntervalMs` / `CARBINE.*` 一个不动。

## 5. 设计

### 5.1 文件结构

| 文件 | 职责 | 层 |
|---|---|---|
| `src/entities/soldiers/soldier-config.js`（新） | 玩法数值唯一权威：`SOLDIER` / `SOLDIER_AI` / `SOLDIER_GAIT` / `SOLDIER_SHOT` / `SOLDIER_STEERING` / `soldierEntityIdFor` | 同构 |
| `src/entities/soldiers/soldier-shooting.js`（新） | 纯函数：`soldierHitChance` / `soldierMissPoint` / `judgeSoldierShot`（DDA + 玩家盒） | 同构 |
| `src/entities/soldiers/soldier-agent.js`（新） | 状态机：awareness / combat / search / patrol、距离环意图、点射节奏、aimPitch/yaw 缓动、死亡倒地进度 | 同构 |
| `src/entities/soldiers/soldier-system.js`（新） | `soldierDefinition`（create/update 物理/raycastAabb/serialize）+ `SoldierService`（spawn/damage/knockback/班组/寻路拍/slot） | 同构 |
| `src/render/soldier-geometry.js`（新） | 上游 `soldierGeometries()` 逐行 → 5 个合并 BufferGeometry + 逐顶点色 + `aSurf`/`aGlow`；`SOLDIER_ANCHORS.muzzle` | render |
| `src/render/soldier-renderer.js`（新） | 5 个固定容量 10 的 InstancedMesh + 材质 + 步态/蹲姿/后坐/死亡倒地/红闪 | render |
| `src/render/muzzle-flash-material.js`（新） | 从 `carbine-view.js` **提取**的枪口火光材质（两侧共用） | render |
| `src/render/soldier-muzzle-fx.js`（新） | 士兵枪口火光池 | render |
| `src/render/carbine-view.js`（改） | 改为 import 提取出去的火光材质（纯提取，参数不变） | render |
| `src/render/carbine-fx.js`（改） | 加三个公开薄方法 + `clear({keepWorldFx})` 可选参数 | render |
| `src/core/perf-hud.js`（改） | 操作说明加 C 键（行宽须实测） | 装配 |
| `src/tests/test-perf.js`（改） | 同步 HELP_LINES 文案断言 | 测试 |
| `src/entities/entity-types.js`（改） | 可击中集合加一项 | 同构 |
| `src/core/game.js`（改） | 装配 + 7 处接线 + `_consumeSoldierShots` + C 键回调 + `spawnSoldierNearPlayer` | 装配 |
| `src/player/player.js`（改） | `KeyC` 绑定 + `onSpawnSoldier` 注入 + 玩家开火时通知 `hearShot` | player |
| `src/entities/zombie-nests/zombie-nest-controller.js`（改） | 交替产出 + 满额回落 | 同构 |
| `src/entities/zombie-nests/nest-config.js`（改） | 加 `spawnOrder`（交替序列的唯一权威） | 同构 |
| `src/core/perf-hud.js`（改） | 操作说明加 C 键（行宽须实测） | 装配 |
| `src/tests/test-soldier*.js`（新，3 个） | 纯函数 + service + 渲染契约 | 测试 |
| `tests/soldier.spec.mjs`（新） | 真实页面：召唤/上限/AI/开火/武器与 TNT 伤害/巢穴交替 | 测试 |
| `tests/enemy-roster.mjs`（改） | 登记 soldier | 测试 |
| `src/tests/index.html` + `tools/test-tiers.mjs`（改） | 注册与归档（`check:data` 双向钉住） | 门禁 |

### 5.2 实体与物理

**尺寸**：`width 0.6 / height 1.8`，position = 脚底（与丧尸、玩家同口径）。上游 `radius 0.32 / height 1.8` ⇒ 直径 0.64，取 0.6 与丧尸对齐，这样 `zombieCollidesAt` / `steerIntentAabb` / `PathCache` 的缺省 box **逐位可用**，零新几何。

**为什么不复用 `zombieDefinition.update` 本体**：士兵 state 形状不同（多 awareness / burst / crouch / deadT 等），且 `createState` 的白名单不同。但**物理算法必须同源** —— 故把 `zombie-system.js` 里私有的 `physicsStep` / `moveAxis` / `tryStepUp` 三件**提取到 `zombie-navigation.js` 并导出**（参数化 halfWidth/height/maxStep），两边都调。这是纯提取重构，丧尸行为逐位不变（由既有 `test-zombies.js` + `zombies.spec.mjs` 守）。

> ⚠️ 若提取时发现丧尸版有士兵不需要的分支（如 `zeroVelocityOnHit` 的轴差异），**保留参数不改语义**。宁可多一个参数，不要两份实现。

**死亡**：上游死后留尸 1.2s 播倒地动画再消失。本仓照做 —— `health<=0` 时**不立即 despawn**，置 `dead=true` + `deadT=0`，`deadT>=1.2` 才 despawn。⚠️ 这与丧尸/Boss 的「立即 despawn」不同，故：
- `damage()` 返回 `{dead:true}` 的语义仍是「本次致死」（死亡音/爆散照旧当帧触发）；
- **`dead` 的士兵必须从可击中集合里排除**（否则鞭尸还扣血、还弹伤害数字）⇒ `soldierDefinition.raycastAabb` 在 `state.dead` 时返回 null；
- ⚠️⚠️ **上限判定不能用 `entities.count(SOLDIER_TYPE)`**（自审抓到的真陷阱）：它数的是**全部实体含留尸的**。留尸 1.2s 内 `count()` 仍报 10 ⇒ 玩家打死一个后 1.2s 内召不出新的，形态是「按键没反应」而数值全对。⇒ 上限走 `SoldierService.count()`（自己遍历只数 `!state.dead`），与丧尸的 `_active` 计数同一分工；
- 留尸期间 `despawnColumn` / `dispose` 照常回收（临时实体，不写盘）。

### 5.3 AI（方案 B 的核心）

状态机四态，与上游同名：

```
patrol ──awareness≥1──▶ combat ──12s 无视线──▶ search ──7s──▶ patrol
   ▲                      │                      │
   └── awareness 衰减 ─────┘◀── 重新看见 ─────────┘
```

**awareness（发现玩家）**：照上游 `thinkStep` 的速率表 —— 距离 <6 → 4.2/s、<13 → 1.7/s、<21 → 0.9/s、否则 0.5/s；玩家疾跑 ×1.5（本仓无疾跑档，用 `speed > 6` 判定）、search 态 ×1.8。看不见时 −0.28/s。视锥 `fovCos`：patrol 0.42、search 0.1、combat 不限（−2）。发现距离 patrol 27 / search 34。

**combat 的移动 = 距离环 + 侧向游走**（B 方案替代掩体）：

| 距玩家 | 意图 |
|---|---|
| > 20 格 | 朝玩家推进（上游 `toward = 1.5`） |
| 8 ~ 20 格 | **纯侧向游走**：绕玩家的切向，每 0.9~2.0s 换一次方向（上游 `strafe`） |
| < 8 格 | 后退拉开（上游 `toward = -1.5`） |

- 侧向 + 径向合成后过 `steerIntentAabb`（走得通的方向），再钳到 `SOLDIER_AI.combatSpeed`。
- **蹲起**：每 1.6~2.8s 站 / 0.8~1.9s 蹲交替（上游 `peekT`），**蹲下时移动意图为 0**（上游 `speed = crouching ? 0 : 4.0`）。这是 B 方案里「士兵不是丧尸」的第二个载体：它会站定蹲下开枪，而不是一直贴脸。
- **卡住重规划**：照上游 `stuckT > 0.7 && 净位移 < 0.25` → 清目标、反向 strafe。另接 `needsPath` 走 `PathCache`（与焰魔/守卫同帧序）。
- **advancer**：每 2s 选「离最后已知位置最近的 combat 士兵」，它在 `since > 2.5s` 时推进到最后已知位置（上游同口径）。

**search**：走向最后已知位置，7s 后回 patrol；`lookYaw` 每秒转 1.3 rad（原地扫视）。

**patrol**：出生点附近踱步（B 方案替代 route）—— 每 1.5~4s 在出生点半径 3 格内取一个随机点走过去。

**班组联动（用户裁定完整移植）**：
- `alertNearby(src, 34)`：34 格内非 combat 同伴按 `0.5~1.4s + d×0.03` 延迟进入 combat。
- `hearShot(pos)`：48 格内非 combat 士兵转 search（`searchT=6`、awareness≥0.45）并走向声源。**触发点 = 玩家开火**（`player._applyWeaponEffect` 里枪类事件），由 Game 注入回调。
- `lastKnown` / `lastSeenAny` 是**班组共享**的（上游 `mgr.lastKnown`）⇒ 存在 `SoldierService` 上，不是每只士兵一份。⚠️ 这不是第二份权威：它是「班组情报」这一件事实的唯一存放处，个体 state 只存自己的 `lastSeen`。

**压制射击**：无视线但 `0.6 < since < 8` 且自己不是 advancer ⇒ 朝最后已知位置盲射（上游 suppress）。

### 5.4 开火与命中

**点射节奏**（上游逐值）：`burst = floor(rand(3,6))` 发、发间隔 `0.105s`、一轮结束后 `nextBurst = 有视线 ? rand(0.8,1.7) : rand(1.4,2.6)`；首发命中率 0.4、后续 0.66；**同一时刻最多 2 名士兵在点射**（`bursting < 2`，否则 `nextBurst = rand(0.2,0.5)`）；开火要求 `crouch < 0.35`（站姿）且 `|yaw 误差| < 0.35`。

**命中率**（上游 `shootAt`）：
```
chance = clamp(accuracy − d×0.011 − playerSpeed×0.03 − (grounded ? 0 : 0.12), 0.06, 0.82)
```
命中 ⇒ 弹着点 = 玩家眼位下方 0.3；未命中 ⇒ 玩家周围随机散布点（半径 0.5~1.6）。

**判定链**（`judgeSoldierShot`，纯函数）：
1. 从枪口世界坐标沿方向发 `raycastVoxel`（遮挡判据 **`isProjectileOccluding`** = solid && opaque，与炮塔弹丸同源）。
2. 玩家盒：`raycastAabbSlab` + 装配层注入的 `playerHitboxLocal()`（火球已有的核准例外 —— 玩家不是 EntityManager 成员）。
3. 取两者更近者。**方块更近 ⇒ 不打玩家**（不能穿墙打人）。
4. 返回 `{end, normal, hitPlayer, blockPos}`；`hitPlayer && 命中率骰子通过` 才扣血。

> ⚠️ **命中骰子与几何判定是两件事，都要过**：骰子决定「这一发是否算打中玩家」，几何决定「弹道有没有被墙挡住」。上游只有骰子（它的 `hasLos` 已在 `sees()` 里判过）；本仓多一道 DDA 是因为体素世界随时可被玩家挖改，`sees()` 的结果可能已过期（10Hz 缓存）。

**伤害**：命中玩家 ⇒ `game._damagePlayer(SOLDIER_SHOT.playerDamage = 2, nowMs)`（唯一入口，红闪 + `ignis_hurt` 自动跟上）。

**视觉**：曳光走 `CarbineFx` 的曳光池（士兵色取上游 `[12, 3.5, 1.5]`，速度 170、半宽 0.013 —— 上游 `tracers.fire(..., 170, 0.013)`）；枪口火花 3 颗 + 命中火花 5 颗走火花池；枪口火光走新的小池（§5.6）。

**必须新增三个公开薄方法**（自审：那三个 `_` 方法当前是私有的，直接跨模块调私有方法会破坏封装且改名即崩）：
```js
spawnTracer(from, to, cfg, nowMs)      // 转调 _fireTracer
spawnSparksAt(seeds, floorY)           // 转调 _spawnSparks
spawnPuffAt(o)                         // 转调 _spawnPuff
```
三者都是**一行转调**，不含新逻辑 ⇒ 池管理与 CPU 模拟仍只有一份（红线 1）。

> ⚠️ **`CarbineFx` 目前是 KV-9 专属且切枪时 `clear()`**（`player.js:814`）。士兵借用它的池 ⇒ **玩家切枪会把正在飞的士兵曳光一起清掉**。
>
> **修法（自审后收窄）**：`clear()` 增加一个可选参数 `{ keepWorldFx = false }`，**缺省行为逐位不变**（全清）。只有士兵在场时的切枪路径传 `keepWorldFx: true` ⇒ 只清弹壳/弹孔，保留曳光/火花/烟。
> **为什么不直接改缺省**：`tests/carbine.spec.mjs:319` 实测钉着 `after.counts.sparks === 0`（切枪后火花必须清空）。改缺省会让那条既有用例红，而它守的是 KV-9 自己的正确行为 —— 不该为了士兵去放宽它。

**池账**（实算，不是估）：并发点射 ≤2 名 × 发间隔 0.105s × 单条曳光最长存活 `(45+9)/320 = 0.169s` ⇒ 并发 ≤ **4 条**，池容量 40，余量 10 倍。火花每发最多 8 颗 × 寿命 0.35s ⇒ 并发 ≤ 54，池 360。**无需扩容**。

### 5.5 与玩家的碰撞

**士兵不阻挡玩家**（与丧尸一致，不进 `physics._collides`）。理由：10 个士兵在 8~20 格环上游走，若每个都是实心盒，玩家会被围住推不动；且丧尸已有此先例（`ENEMY_ROSTER.zombie.blocksPlayer = false`）。

⇒ `ENEMY_ROSTER.soldier.blocksPlayer = false`，接线门的「玩家阻挡」项自动跳过它（那是刻意排除，不是遗漏）。

### 5.6 渲染

**5 个部件**（上游层级压平成 5 个 InstancedMesh，容量 10）：

| 部件 | 上游来源 | 父级 | 备注 |
|---|---|---|---|
| `pelvis` | `GEO.pelvis` | body | 4 盒 |
| `torso` | `GEO.torso` | body | **15 box + 1 add(BoxGeometry) + 4 capsule**，含枪与双臂（程序化扫描计数，非目测） |
| `head` | `GEO.head` | torso | 4 box + 1 add(SphereGeometry 10×7)，含红护目镜 |
| `thighL/R` | `GEO.thigh` | body | 各 1 胶囊 + 1 盒 |
| `shinL/R` | `GEO.shin` | thigh | 各 1 胶囊 + 2 盒 |

⇒ 实际是 **7 个 InstancedMesh**（左右腿各两段）。上游 torso 含枪 ⇒ 枪随躯干俯仰整体动（与炮塔「刚性一体」同一裁定，不做枪独立轴）。

**矩阵链**：`root(T(position) · R_y(yaw)) → body(T(0, −crouch×0.44 − bob, 0)) → 各部件`，照 `zombie-renderer.js` 的 `_parent × _local` 手法，逐实例复用模块级 scratch。

**材质**：`createTurretMetalMaterial` 的**参数化版本**。三处必要改写：
1. **逐顶点色**：士兵每个盒颜色不同（装甲 `0x353c45` / 板甲 `0x4a545f` / 布 `0x262b32` / 黑 `0x15171a` / 枪 `0x16181b`…）。炮塔那套是「三档 tone 选色」，士兵要的是**任意逐顶点色** ⇒ 给 `createTurretMetalMaterial` 加一个 `vertexColor: true` 分支，`base = attribute('color','vec3')`。⚠️ **不能用 `vertexColors:true` + `colorNode`**（three 把顶点色乘在 colorNode **之后**，高光/环境项会用材质基色染色 —— 炮塔注释已记这条实测）。
2. **自发光**：护目镜 `e=4.5`、胸灯 `e=2.5` ⇒ 逐顶点 `aGlow` 属性，`colorNode` 末尾加 `base × aGlow × k`（照 `carbine-view.js` 的 emissive 写法）。
3. **红闪**：炮塔材质无红闪。士兵受伤要红闪 ⇒ 逐实例 `instanceColor`。⚠️ three 自动 `instanceColor.mul(colorNode)` ⇒ **基色必须白**，红闪时写红。但那会把自发光也乘红 —— 与丧尸「有贴图时红闪呈暗红」同类，可接受（记进文档，不当缺陷）。

> ⚠️ **共享 vs 逐实例材质**：金属材质的 uniform 是共享的（太阳方向），红闪走 `instanceColor` ⇒ **5 个部件可共用一份材质**（与炮塔同）。这与焰魔/守卫「逐实例独立材质」不同 —— 那两者红闪是材质级 color。

**枪口火光池**：`soldier-muzzle-fx.js`，容量 4（并发点射 ≤2 × 火光寿命 0.045s ⇒ 理论并发 ≤2，取 2 倍余量）。

⚠️ **`makeFlashMaterial` 当前未导出**（自审核实：`carbine-view.js:158` 是模块私有函数）⇒ 把它**提取到 `render/muzzle-flash-material.js`**，`carbine-view.js` 与 `soldier-muzzle-fx.js` 都 import。纯提取、参数逐位不变（星芒 + 十字 blade、**NormalBlending**、片元算径向），由 `tests/carbine-flash-wet.spec.mjs` 守 KV-9 侧零回归。**不复制一份** —— 两份火光材质会漂移出「士兵的火光是方块而玩家的不是」（那正是 v3.30b 修过的缺陷）。⚠️ 短命特效（0.045s）的断言必须**开火后同步立刻取样**，任何 `await` 都会让它自然过期。

**空载**：7 个 mesh + 火光池全部 `visible=false` ⇒ draw call 回基线。有士兵时 +7（与丧尸 +6 同一口径，由 spec 精确断言）。

### 5.7 死亡音与爆散

用户裁定不做士兵专属音效，但接线门要求每个可击中类型有 `deathSound`。取**既有 `z_die`**（音量 0.3）：零新增文件、零烘焙、零门禁改动。爆散色取装甲灰 `0x353c45`（从 `soldier-geometry.js` 的常量派生，不写字面量），口径用 `DEATH_BURST`（丧尸体型，士兵同尺寸）。

> 这是**近似替代**，不是士兵该有的声音 —— 与 `ignis_attack_smash` 用 `sword_stomp.ogg` 同类，注释里写清楚，将来对照上游时不要当作原音。

### 5.8 召唤与巢穴交替

**C 键**：`player.js` 加 `KeyC && !e.repeat` → `onSpawnSoldier()`（Game 注入 `spawnSoldierNearPlayer()`），改调 `SoldierService.spawn`。

> ☠️☠️ **落点逻辑已于 v3.54 推翻重写**（用户 2026-11-27 实玩：「按 c 有时候会把 soldier 生成到地下矿洞里」）。
> 本节原写「落点逻辑照 `spawnZombieNearPlayer`（随机角度 + 2~10 格 + 向下扫 64 格找地面）」——
> **那条判据只问「这一格能不能站」，不问它与玩家是否连通** ⇒ 洞穴顶板天然满足它。
> 实测：真实按键 20 次出现 −32 / −28 / −26；洞口密集点 47/60 落到地下。
>
> **现行口径**：`entities/soldiers/soldier-spawn-site.js` 的 `findSoldierSpawnSite()` ——
> **从玩家脚格出发的有界连通洪泛** + 高度带 **±3 格**（用户裁定）+ 空气通路判据；
> 三级兜底（玩家脚底 → 自身列支撑面 → 放宽带 ±8），全空则不生成 + toast。
> 水平取距 2~10 格与返回值形状 `{spawned, position, attempts, count}` 逐位不变。
> 详见 `docs/roadmap.md` v3.54 行与 `.pi/plans/2026-11-27-soldier-spawn-connected-space.md`。
> **丧尸 X 键与巢穴刷怪仍用旧口径**（本轮未动）。

> ⚠️ C 键曾是 Boss 召唤键（v2.43 改为 B），现已空闲（全仓 grep `KeyC` 零命中）。

**上限**：`SOLDIER.maxAlive = 10`，`SoldierService.count()` 只数活着的（§5.2）。满额返回 null。

**巢穴交替**（`zombie-nest-controller.js`）：
- `NEST.spawnOrder = ['soldier', 'zombie']`（唯一权威，放 config）。
- controller 加 `_spawnIndex`（**跨帧保留，但不入 blockEntity** —— 它是派生节奏，column 卸载后从 0 重开可接受；写进存档会让 anchor 多一个字段且要迁移旧档）。
- 每次到期：按 `_spawnIndex` 取首选类型 → 尝试 spawn → **失败（满额）则试另一种** → 都失败则本次不产出。无论成败都写回 `lastSpawnAt`（既有口径不变）。
- `_spawnIndex` **只在真的产出一只后 +1**（否则满额时会空转推进，恢复后节奏错乱）。

> ⚠️ **既有 8 秒节流与 48 格扫描一行不改**（`NEST.spawnIntervalMs` / `spawnOffsets` / `spawnDy*` 全部冻结）。`src/tests/test-zombie-nests.js` 的 fake `zombies` 只有 `spawn` 方法 ⇒ controller 必须**容忍 `soldiers` 未注入**（缺省时退化为只产丧尸，既有 20 余条用例逐位不变）。

### 5.9 UI

`perf-hud.js` 的 `HELP_LINES` 第三行改为 `'Z：背包 | X：丧尸 | C：士兵 | R：换枪'`。
**行宽已估算**：237.60px（CJK 12px / ASCII 7.2px @12px monospace），< 内容区可用 310px，且小于既有最宽行 268.80px ⇒ 面板宽度不变。⚠️ **仍须实测**（`tests/player-flight.spec.mjs` E5 钉 `scrollWidth ≤ clientWidth`）。

⚠️ **既有用例钉着旧文案**（自审 grep 到）：`src/tests/test-perf.js:161` 断言 `helpEl.textContent.includes('Z：背包 | X：生成丧尸 | R：换枪')`。改文案必须同步改那条断言 —— 这是**有意识的文案改动**（X 键语义没变，只是缩写让位给 C 键），不是放宽判据。该文件不在 `UNIT_NODE_SAFE`（需 DOM）⇒ 由 `tests/unit-fast.spec.mjs` / `harness` 覆盖。

## 6. Approaches（考虑过的三条）

| | 做法 | 代价 | 观感 | 结论 |
|---|---|---|---|---|
| **A** | 实时扫体素派生掩体点（半径 12 格 / y±3 层 / 按上游打分选点），完整移植 `pickCover / coverBad / 探头` | +约 200 行纯函数 + 一组要实测标定的扫描参数；每只 5~9s 扫一次 | 上游完整掩体战 | 未选 |
| **B（本设计）** | 距离环（8~20 格）+ 侧向游走 + 周期蹲起，不扫掩体 | 省掉扫描与打分 | 会保持距离、会蹲下开枪，但不利用地形 | **用户选定：「B，先简单实现」** |
| C | 生成期预烘掩体索引 | — | — | **红线排除**：世界无边界、索引是第二份权威、玩家挖放后立刻过期 |

**B 的已知代价（诚实边界）**：士兵不会躲到矮墙后，玩家用方块搭的掩体对它没有「逼它换位置」的作用（但**仍会挡住它的子弹**，因为判定走 DDA）。若实玩后觉得「士兵还是太像丧尸」，升级到 A 是**增量的**：只需加一个 `pickCover` 纯函数并把 combat 的移动意图从「环」换成「去掩体」，其余（点射/班组/渲染/接线）全部不动。

## 7. 留给实施者的决定

- 物理三件（`physicsStep`/`moveAxis`/`tryStepUp`）提取到 `zombie-navigation.js` 时的确切签名（约束：丧尸行为逐位不变，由既有用例守）。
- `SoldierService` 的 slot 分配是否照丧尸的「id 与 slot 同编号」（建议照做：`s0`~`s9`，天然复用）。
- 士兵步态参数的具体标定（上游 `walk += speed×dt×2.6`、腿摆 0.62、膝弯 0.9 —— 先逐字取上游，实玩再调）。
- ~~`CarbineFx.clear()` 改动后既有测试是否需重标~~ —— **自审已定**：不改缺省行为，故既有断言一条不动（§5.4）。
- 三个公开薄方法的确切命名（建议 `spawnTracer` / `spawnSparksAt` / `spawnPuffAt`，与既有 `spawnFromEffect` 同风格）。

## 8. 验证判据

### 8.1 最小充分集（按 testing-policy）

```bash
npm run check                                  # 每次改动（arch + data + lint，5.4s）
npm run test:unit                              # 改了纯函数/协议/数据模型（本次是 Tier 1）
npx playwright test tests/soldier.spec.mjs tests/enemy-wiring.spec.mjs tests/enemy-roster.spec.mjs
npx playwright test tests/zombie-nests.spec.mjs tests/zombies.spec.mjs tests/tnt.spec.mjs
npx playwright test tests/carbine.spec.mjs tests/player-flight.spec.mjs
```

**消费方证明**（grep 得出，不是猜）：改 `zombie-navigation.js` ⇒ 消费方是 `zombie-system` / `zombie-pathfinder` / `ignis-*` / `guardian-*` ⇒ 加跑 `tests/ignis.spec.mjs tests/guardian.spec.mjs`。改 `carbine-fx.js` ⇒ `tests/carbine*.spec.mjs`。改 `perf-hud.js` ⇒ `tests/player-flight.spec.mjs`。

**不跑全套**（本次不是全局基础设施改动，`test-tiers.mjs` 只加一行）。
**跑 `bench --check`**：本次碰了 `entities.update` 热路径（新增一个每帧 Agent）与物理提取 ⇒ 按 policy 属热路径改动。

### 8.2 判据必须独立于被测代码

期望值从 `SOLDIER.*` / `ZOMBIE.*` / `TURRET.*` 常量算出，**不抄 `game.js` 的三元链**（接线门 §7.1 同口径）。

### 8.3 关键判据与它们的判别力

| 判据 | 为什么这么写 |
|---|---|
| C 键召唤 → `soldiers.count()` +1；连按 11 次 → 恰好 10 | 直接调 `service.spawn` 会漏掉「按键没接」这类缺陷 |
| **巢穴交替**：连续 4 次到期产出 `[soldier, zombie, soldier, zombie]` | 只断言「有士兵出生」抓不到「交替失效变成只出一种」 |
| **满额回落**：先把士兵召满 10 → 巢穴到期必须出丧尸 | 这是用户明确要求的分支；不测它就是静默失效 |
| **两者都满**：士兵 10 + 丧尸 20 → 到期不产出但仍写回时钟 | 防每帧重试扫描（既有口径） |
| 士兵子弹打玩家：命中后 `player.health` 恰好 −2 | 骰子注入定值 rng；不注入则读数随机不可断言 |
| **子弹不穿墙**：玩家与士兵之间砌实心墙 → 血量逐位不变 | 只测「开阔地能打中」抓不到穿墙 |
| 距离环：combat 态 30s 内距玩家始终 ∈ [6, 24] | **B 方案身份的判据**；退化成直冲则距离会掉到 0.6 |
| 蹲起：30s 内 `crouch` 既出现过 >0.9 也出现过 <0.1 | 只断言「有 crouch 字段」恒真 |
| 班组报警：一只进 combat → 34 格内同伴在 2s 内也进 combat | 上游身份的核心 |
| 听枪声：玩家开火 → 48 格内 patrol 士兵转 search | 同上 |
| 并发点射 ≤2：任意时刻 `burst>0` 的士兵数 ≤2 | 上游手感常量 |
| 死亡留尸：`dead` 后 1.2s 内实体仍在、之后 despawn | 且**期间不可被击中**（鞭尸不扣血） |
| draw call：无士兵时 = 基线；有士兵时 = 基线 +7 | 精确值；随士兵数增长说明走了 per-entity 节点 |
| 曳光上屏：开火后**同步立刻**取样 GPU 属性 | 0.045s 火光 / 0.169s 曳光，任何 await 都会过期 |
| TNT：半径内士兵掉血 50、半径外不掉、probe 对照不掉 | 照 `tnt.spec.mjs` 既有三件套 |
| 接线门 12 项 | 登记进名册即自动覆盖 |

### 8.4 负向验证（注入后必须真 FAIL；用 `edit` 注入并读回确认，`cp` 副本还原，禁 `git checkout`）

| 编号 | 注入 | 应红项 |
|---|---|---|
| N1 | `WEAPON_HITTABLE_TYPES` 去掉 soldier | 武器伤害 + 接线门双向钉住 |
| N2 | `_damageEntitiesInRadius` 退回只遍历丧尸 | TNT 用例 |
| N3 | 巢穴 controller 去掉交替（恒产丧尸） | 交替用例 |
| N4 | 去掉「满额回落」分支 | 回落用例 |
| N5 | 距离环改成「直冲玩家」 | 距离环用例（**B 方案的身份判据**） |
| N6 | 去掉蹲起切换（crouch 恒 0） | 蹲起用例 |
| N7 | `alertNearby` 空实现 | 班组报警用例 |
| N8 | `hearShot` 空实现 | 听枪声用例 |
| N9 | `judgeSoldierShot` 去掉 DDA（只判玩家盒） | 不穿墙用例 |
| N10 | 死亡立即 despawn | 留尸用例 |
| N11 | 渲染器空载不置 `visible=false` | draw call 基线用例 |
| N12 | `headY` / `half` 三元链漏 soldier | 接线门对应两项 |

> ⚠️ **N5 是本设计最关键的一条**：它证明「距离环」判据真的能区分 B 方案与「会开枪的丧尸」。若注入后不红，说明判据无判别力，而不是实现没问题。

### 8.5 Tier 4 像素实测（渲染必须过 GPU）

士兵是金属 TSL + 自发光护目镜 ⇒ 按 policy 属 Tier 4，**不得宣称目视**。三条：
1. **士兵上屏**：固定机位（照 `carbine.spec` 的冻结五动态源口径）+ 藏掉自带同色的宿主，量士兵屏幕区域的非背景像素数 > 阈值。
2. **护目镜自发光**：红通道显著高于装甲区（`e=4.5` 的直接后果）。注入 `aGlow` 恒 0 必须真红。
3. **枪口火光**：开火后同步取样暖色像素（`r > g`，照「暖色特效判据」的既有教训，不用差分计数）。

⚠️ 三条都要**先藏掉宿主实体**（士兵自身装甲是冷灰，火光暖色不受影响；但丧尸绿碎块会污染 —— 场上同时有丧尸时先清）。

## 9. 风险小结

| 风险 | 缓解 |
|---|---|
| **物理提取改坏丧尸** | 纯提取、参数化、丧尸侧传原值；既有 `test-zombies.js`（1726 行）+ `zombies.spec.mjs`（1315 行）+ `ignis/guardian` spec 全跑 |
| **`CarbineFx` 改动影响 KV-9** | `clear()` 缺省行为逐位不变（新增可选参数），`carbine.spec:319` 的 `sparks===0` 仍绿；三个新方法是纯转调 |
| **火光材质提取改坏 KV-9** | 纯提取、参数逐位不变；`carbine-flash-wet.spec` 守 |
| **巢穴 controller 改动影响既有 20 余条用例** | `soldiers` 未注入时退化为只产丧尸（fake fixture 逐位不变） |
| **金属材质加 vertexColor 分支影响炮塔** | 新分支缺省关闭，炮塔调用点一行不改；`turret-render.spec` 守 |
| **每帧新增 Agent 拖帧** | 常态零分配门控（无士兵时一次 count）；`bench --check` |
| **士兵 10 个 + 丧尸 20 个同时在场** | 30 个实体的寻路是 20Hz 节流 + 只给 `needsPath` 的跑 A*；`zombies.spec` 的 20 只压力用例 + 新增 30 只混合场景 |
| **B 方案观感不达预期** | §6 已写明升级到 A 是增量的，不推翻本设计 |

**一个必须声明的局限**：本文档未经独立审阅（本会话无委派授权，按 brainstorming 本该派 fresh 子代理做 builder check，改为自审）。自审抓不到「文档与作者共享同一个错误假设」这类问题。**所以「安全」的最终证据不是本文的声明，而是实施时那 12 条负向验证**：若某条注入后不红，说明判据有问题，而不是代码没问题。