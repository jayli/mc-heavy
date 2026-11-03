# 祭坛飞龙 AI 与火球攻击设计（v2.44）

> 状态：待批准
> 前置：`docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（v2.41~v2.43 龙本体 / Boss 召唤框架）
> 用户需求（2026-11-03）：给飞龙加智能 —— 看到玩家就追击、递近后喷火球、玩家静止时飞跃玩家再
> 盘旋回头、脱离视线返回轨道；火球击中玩家或实体方块爆炸，破坏方块与否跟 TNT 开关走。
> **架构指令（用户）**：把这套 AI 抽成独立的 Boss 智能体类，与原有逻辑尽量解耦 —— 后续会有很多
> Boss，每个 Boss 都有自己的智能体类。

## 1. 背景与目标

v2.41~v2.43 的祭坛飞龙只有「绕地图中心固定圆轨道盘旋」一条行为，是纯景观实体（`dragon-system.js`
头注：「龙不与方块交互、不碰撞、不寻路、不受重力」）。用户希望它有 Boss 级的互动：

1. **发现**：龙与玩家之间视线未被「实心不透明方块」遮挡、且水平距离 ≤ 60 格时，开始追击。
2. **追击**：恒定半高高空（y=30）水平飞向玩家。
3. **攻击**：递近玩家后喷火球。脑袋朝向玩家（±20° 锥内）即可发射；发射有频率限制，
   **间隔随机 5~10 秒**（不是机关枪）。
4. **飞跃**：玩家静止不动时，龙递近到很近（≤6 格）就飞跃玩家，飞出去一段后盘旋回头再次递近。
5. **脱离**：玩家离开龙的视线后，龙返回原始高度，恢复绕圈盘旋。
6. **自由盘旋**：盘旋不再死板画圆，半径按角度正弦调制（左右拐弯），显得不那么单调。
7. **火球**：火焰颜色的圆球，直线飞向玩家（发射瞬间的位置，无追踪），速度 15 格/秒。
   击中玩家身体或实体方块（含树叶/玻璃等半透明方块）即爆炸。
8. **爆炸**：破坏范围与一个 TNT 相同（3×3×3），是否真破坏方块由 `canTntDestroyBlocks` 开关决定；
   连锁 TNT、对丧尸伤害、矿车摧毁、音效、特效全部与 TNT 同口径。
9. **玩家不掉血**：玩家目前没有血量概念，火球命中玩家只爆炸不掉血（以后再做）。

**非目标**：玩家血量 / 受伤反馈、龙的寻路避障（龙在空中飞，不撞方块）、火球追踪、第二种攻击
（喷火柱）。

## 2. 架构：BossAgent 抽象（用户的解耦指令）

后续会有很多 Boss、每个都有自己的智能体，故把「Boss 的行为决策」从「Boss 的数据/渲染」里抽出来，
形成独立的智能体类层级：

```
src/entities/bosses/
├─ boss-map.js          （v2.43 已有：玩家所在地图判定）
├─ boss-registry.js     （v2.43 已有：地图 → Boss 名册）
├─ boss-agent.js        （新增：BossAgent 抽象基类 + 共用工具）
└─ dragon-boss-agent.js （新增：DragonBossAgent，飞龙四态机 AI）
```

- **`BossAgent`（基类）**：定义 `update(state, dt, ctx) → newState` 抽象接口 + 收纳所有 Boss 共用
  的工具（视线判定、角度差、冷却、水平距离）。它**不 import three、不 import DOM**（同构层，
  `check:arch` 的 `ISOMORPHIC_DIRS` 守）。
- **`DragonBossAgent`（子类）**：飞龙专属的四态机。它**只读 state 与 ctx，返回全新 state**，
  不持有跨帧可变成员（所有跨帧状态都在 state 里）—— 与 M5「物理推进返回全新 state」同一不变式。
- **与 `dragon-system.js` 的关系**：`dragonDefinition.update` 委托给 `DragonBossAgent`。
  `dragon-system.js` 保留轨道/动画/AABB 纯函数 + `DragonService`（召唤/伤害/查询），**不写 AI**。
  这样「龙的数据与服务」和「龙的行为」彻底分离 —— 换一个 Boss 就是换一个 Agent 子类，
  `dragon-system.js` 的服务形状可被未来的 Boss 服务复用。

⚠️ **无循环依赖**：`DragonBossAgent` 返回的是 plain state 对象，由 `dragonDefinition.update` 用
`dragon-system.js` 的 `createState` 包裹校验。Agent 不 import `dragon-system.js`（避免环）。

⚠️ **AI 读 ctx，但不生成实体**：`DragonBossAgent.update` 读 `ctx.world / ctx.registry / ctx.player`
做视线与距离判定，但它**不直接 spawn 火球、不改世界** —— 它把「要开火」写进返回 state 的
`fireRequest` 字段，由 `game.js` 在 `entities.update` 之后统一消费（生成火球实体）。理由：
生成实体 / 改世界是主线程装配层职责（要读 `canTntDestroyBlocks`、调 `explodeTnt` 链路），
entities/ 同构层不得碰。这与矿车 `pendingPlayerLift`（definition 算意图、game.js 执行）同一先例。

## 3. 四态机

龙 state 新增 `mode` 字段：`'orbit' | 'chase' | 'attack' | 'return'`。

| 模式 | 行为 | 转移到 |
|---|---|---|
| `orbit` | 绕地图中心盘旋，**半径按 θ 正弦调制 ±5 格**（左右拐弯）；不攻击 | 视线通 + 水平距 ≤60 → `chase` |
| `chase` | 恒定 y=30 水平追玩家，速度 9 格/秒；yaw 指向玩家；可开火 | 距 ≤20 → `attack`；视线断 → `return` |
| `attack` | 子态 `approach`（冲向玩家）↔ `turn`（飞过玩家后向外飞 22 格再掉头）；可开火 | 视线断 / 距 >78 → `return` |
| `return` | 飞回轨道圆心，高度回到 y=30 | 到达（距圆心 ≤ orbit.radius）→ `orbit` |

### 3.1 发现与视线（orbit → chase）

- 视线判据**复用** `turret-system.js` 的 `hasLineOfSight({world, registry, from, to})`
  （红线 1：不写第二份 LOS）。其遮挡判据 `isProjectileOccluding`（`solid && opaque`）正是用户说的
  「实心不透明方块」。
- `from` = 龙的位置（身体中心），`to` = 玩家胸部（`player.position + [0, 1.0, 0]`）。
- **视线缓存 10Hz**：LOS 每帧全查太贵（60 格 × 多条龙），故 state 里存 `losTimer`/`losVisible`，
  每 0.1 秒重查一次。但**开火瞬间做一次新鲜 LOS 复查**（防止隔着墙喷火）。
- 触发 = `losVisible && 水平距离 ≤ 60`。

### 3.2 追击（chase）

- 水平朝玩家飞，速度 `DRAGON_AI.chaseSpeed = 9` 格/秒（略快于玩家跑步 8，玩家跑不掉但能周旋）。
- y 恒 = `orbit.y`（30）。龙不俯冲、不爬升（用户裁定「在半高的高空盘旋」）。
- yaw 平滑转向玩家（用 `shortestAngleDiff` 插值，转向速率 `DRAGON_AI.turnRate` rad/秒）。
- 可开火（见 §3.4）。
- 距 ≤20 → `attack`；视线断 → `return`。

### 3.3 攻击与飞跃（attack）

- 子态 `approach`：冲向玩家（同 chase 的移动），直到水平距 ≤ `DRAGON_AI.flyoverDistance = 6`
  → 子态 `turn`（此刻龙的水平投影正好飞过玩家头顶）。
- 子态 `turn`：沿当前方向继续向外飞，累计 `turnDist`；到 `DRAGON_AI.turnAroundDistance = 22` 格
  → 掉头回 `approach`。这形成「递近 → 飞跃 → 拉远 → 回头 → 再递近」的循环，正是用户描述的
  「玩家静止时飞跃玩家、盘旋回头再次递近」。
- 可开火（见 §3.4）。
- 视线断 或 水平距 > `DRAGON_AI.disengageDistance = 78`（= 60 × 1.3 滞回，防边界抖动）→ `return`。

### 3.4 开火条件（chase 与 attack 共用）

同时满足四条才喷火球：
1. **脑袋朝向玩家**：龙 yaw 与「指向玩家的方向」夹角 ≤ `DRAGON_AI.fireConeDeg = 20°`。
2. **冷却到点**：`fireCooldown ≤ 0`。开火后重置为 `5 + rng() × 5` 秒（**随机 5~10 秒**，用户要求）。
   `rng` 可注入（默认 `Math.random`），测试钉区间。冷却用 **dt 倒计时**（不是绝对时间戳），
   绕开 `Date.now()`/`performance.now()` 混用陷阱。
3. **新鲜视线通**：开火瞬间重新查一次 `hasLineOfSight`（不用缓存）。
4. **距离合理**：水平距 ≤ `DRAGON_AI.fireRange = 60`（太远不浪费火球）。

火球方向 = 归一化(玩家胸部 − 火球出生点)，即**精确瞄准玩家**（龙的脑袋大致朝向玩家 ±20°，
火球本身指哪打哪）。

### 3.5 返回（return）

- 水平飞回轨道圆心 `(orbit.cx, orbit.cz)`，y 回到 `orbit.y`。
- 到达判据：距圆心 ≤ `orbit.radius` → 切 `orbit`，并从当前位置反解 θ 重置轨道时钟
  （`θ = atan2(z−cz, x−cx)`），`orbitBlend = 0`（半径从当前值平滑过渡到调制值，防跳变）。

### 3.6 自由盘旋的半径调制（orbit）

- `radius(θ) = orbit.radius + wobbleAmp × sin(wobbleFreq × θ + wobblePhase)`，
  `wobbleAmp = 5`、`wobbleFreq = 3`（每圈半径起伏 3 次）、`wobblePhase` 召唤时随机。
- **yaw 用调制路径的解析切线** `atan2(−dx/dθ, −dz/dθ)`；`wobbleAmp = 0` 时**逐位退回** `π − θ`
  （既有「yaw 是切线方向」用例不破）。
- wobble 参数进 `orbit`（`summon` 生成），故轨道仍是 `(seed, 时间)` 的纯函数 —— 但**只在 orbit 模式**；
  chase/attack/return 的位置由 AI 积分决定（依赖玩家位置，本就非确定），龙是临时实体不进存档，无碍。

## 4. 火球系统（新 `entities/dragons/fireball-system.js`）

火球是**临时实体**（`persistent: false`），type = `'fireball'`，与炮塔弹丸同构但独立
（速度、遮挡判据、命中语义都不同，不复用 `projectile-system.js` 的数值）：

- **速度** `FIREBALL.speed = 15` 格/秒（用户裁定）；**最远** `FIREBALL.maxDistance = 80` 格。
- **推进**：`fireballDefinition.update` 直线积分（同 `projectileDefinition.update` 手法，返回全新 state）。
- **判定** `judgeFireball({next, world, registry, player, stepLen})`，顺序照 `judgeProjectile`
  （超距 → 方块 → 玩家）：
  1. 超距（`traveled ≥ 80`）→ 消失，**不爆炸**（没撞到东西）。
  2. **方块阻挡**：DDA 遍历本步穿越线段（复用 `raycastVoxel`，红线 6），遮挡判据
     **`registry.solidTable[id] === 1`**（只看 solid）—— 树叶/玻璃/台阶/半砖都挡，水/花草/藤不挡。
     ⚠️ 这**有意不同于** `isProjectileOccluding`（solid && opaque）：玻璃 `opaqueTable=0` 会被那个
     判据放过，但用户明确火球要「击中树叶、玻璃等半透明方块」也爆炸。命中 → 在 `blockPos` 爆炸。
  3. **玩家命中**：`raycastAabbSlab`（复用，红线 1）打玩家盒 → 爆炸，**不掉血**。
     玩家盒由调用方（game.js）经 `ctx.playerAabb` 注入 —— 形状是 `{position:[x,y,z], aabb:{min,max}}`，
     `position` = 玩家脚底中心（`physics.pos` 语义）、`aabb` = `playerHitboxLocal()` 的局部盒。
     ⚠️ **entities/ 不得 import player/**（矿车先例：`PlayerPhysics.minecarts` 由 Player 注入，
     反向不成立）⇒ 玩家尺寸的唯一权威仍在 `physics.js`，火球侧只消费注入值（红线 1）。
- **爆炸**：调 `Game._applyExplosion(x, y, z)`（见 §5）。

## 5. 爆炸复用：抽出 `_applyExplosion`

从 `Game.explodeTnt` 抽出公共爆炸执行 `_applyExplosion(x, y, z)`：
`computeExplosion`（3×3×3 破坏 + 5×5×5 连锁）→ 受 `canTntDestroyBlocks` 门控的破坏事务 →
连锁 TNT 入队 → 半径 4 内丧尸 50 伤 → 矿车摧毁 → 音效 → 两层特效（序列帧 + 球体扩张）。

- `explodeTnt(x,y,z)` = **去重**（`_ignitingTnt`）+ **移除引爆格自身 TNT** + `_applyExplosion`。
- **火球直接调 `_applyExplosion`，不经过 `explodeTnt`**。

⚠️ **为什么必须抽函数、不能让火球直接调 `explodeTnt`**：`explodeTnt` 的去重集合 `_ignitingTnt`
以「格坐标」为键，语义是「这个 TNT 格已引爆过」。火球爆炸的格**不是 TNT**，若走 `explodeTnt`
会把那个格的键永久留在 `_ignitingTnt` 里 —— 之后玩家在同一格放 TNT 引爆会返回 false 静默不爆。
抽出的 `_applyExplosion` 不碰去重集合，火球用它就干净。

## 6. 渲染：`FireballRenderer`（新 `src/render/fireball-renderer.js`）

- `InstancedMesh` 球体池（`SphereGeometry(0.45)`），火焰色 unlit（`MeshBasicMaterial`，
  与矿车/丧尸同口径 —— 不吃为枪标定的 PBR 灯光）。
- 容量从 `FIREBALL.poolSize` 派生；**零实例时 `visible = false`** → draw call 归零
  （照 `projectile-renderer.js` / `tracer-renderer.js` 手法，AGENTS.md「常驻实例池」约束）。
- `sync(entities)` 差集驱动 slot（同 `ProjectileRenderer.sync`）。
- game.js 帧循环在 `entities.update` 后调 `fireballRenderer.sync(this.entities.entities())`。

## 7. 数据结构与接口契约

### 7.1 龙 state 新增字段（`dragon-system.js` 的 `createState`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `'orbit'\|'chase'\|'attack'\|'return'` | 四态机，缺省 `'orbit'` |
| `attackPhase` | `'approach'\|'turn'` | 仅 attack 有意义 |
| `fireCooldown` | number（秒） | dt 倒计时 |
| `losTimer` / `losVisible` | number / boolean | 视线缓存（10Hz） |
| `orbitBlend` | number（0~1） | 返回轨道时半径过渡 |
| `turnDist` | number | turn 子态已飞距离 |
| `fireRequest` | `{position, direction} \| null` | **瞬态**：serialize 跳过，game.js 消费 |

`orbit` 新增可选 `wobbleAmp / wobbleFreq / wobblePhase`（缺省 = 无调制，逐位兼容旧行为）。

### 7.2 `BossAgent` 接口

```js
export class BossAgent {
  update(state, dt, ctx) { throw new Error('BossAgent.update 是抽象方法'); }
  // 受保护工具（子类用）：
  //   _hasLos(ctx, from, to)      → 复用 turret-system.hasLineOfSight
  //   _angleTo(from, to)          → 水平指向角
  //   _shortestAngleDiff(a, b)    → 复用 turret-system.shortestAngleDiff
  //   _horizontalDist(a, b)
}
```

### 7.3 `DragonBossAgent.update` 返回

`{ ...新 state 各字段 }`（plain 对象，含 `fireRequest`）。`dragonDefinition.update` 用 `createState`
包裹后返回给 `EntityManager`。**fireRequest 不进 serialize**（瞬态）。

### 7.4 game.js 装配改动

- `entities.update(dt, ctx)` 的 ctx **已含** `world / registry / player`（现有形状），龙 AI 直接用，
  不改 ctx 形状。
- `entities.update` 之后：遍历龙读 `state.fireRequest` → 非 null 则 spawn 火球实体。
- 新增 `_updateFireballs(nowMs, dt)`（仿 `_updateProjectiles`）：判定 + 爆炸 + despawn。
- 注册 `FIREBALL_TYPE` + `fireballDefinition`；装配 `FireballRenderer`。
- 抽出 `_applyExplosion`，`explodeTnt` 改调它。

## 8. 文件清单

| 文件 | 动作 |
|---|---|
| `src/entities/bosses/boss-agent.js` | 新增：BossAgent 基类 + 共用工具 |
| `src/entities/bosses/dragon-boss-agent.js` | 新增：DragonBossAgent 四态机 |
| `src/entities/dragons/fireball-system.js` | 新增：火球 definition + judgeFireball + 常量 |
| `src/render/fireball-renderer.js` | 新增：火球 InstancedMesh 池 |
| `src/entities/dragons/dragon-config.js` | 加 `DRAGON_AI` / `FIREBALL` 常量 |
| `src/entities/dragons/dragon-system.js` | state 加字段；`dragonPoseAt` 支持 wobble；`update` 委托 Agent |
| `src/player/physics.js` | 新增导出 `playerHitboxLocal()`（相对脚底中心的局部盒，由 `PLAYER_WIDTH/HEIGHT` 派生）—— **entities/ 不得 import player/**（矿车先例），故由 game.js 装配层读取后注入火球判定 |
| `src/core/game.js` | 抽 `_applyExplosion`；fireRequest 消费；`_updateFireballs`；装配 |
| `src/tests/test-dragon-boss-agent.js` | 新增：四态机 + 开火条件单测 |
| `src/tests/test-fireball.js` | 新增：火球推进/判定/爆炸口径单测 |
| `tests/dragon-ai.spec.mjs` | 新增：E2E（追击/火球/爆炸） |

## 9. 测试策略（Tier 1，TDD）

- **四态机转移**：构造 ctx（假 world/registry/player），逐态驱动 `DragonBossAgent.update`，
  断言转移条件与滞回（60 进 / 78 出）。
- **开火条件四条**：分别注入「锥外 / 冷却未到 / 视线断 / 超距」，断言不喷火；全满足才喷。
  冷却区间钉 `[5, 10]`（注入确定性 rng）。
- **yaw 切线退化**：`wobbleAmp = 0` 时 `dragonPoseAt` 的 yaw 与 `π − θ` 逐位相等（既有不破）。
- **火球判定**：超距不爆 / 撞实心爆 / 撞玻璃爆（solid）/ 穿水不爆 / 命中玩家盒爆且不掉血。
- **爆炸口径**：`_applyExplosion` 与 TNT 同破坏范围；开关关时不破坏方块；火球不走 `explodeTnt`
  的去重集合（负向：火球爆过的格之后放 TNT 仍能爆）。
- **负向验证**：注入「火球直接调 explodeTnt」→ 断言去重集合被污染（真 FAIL）。
- **E2E**：召龙 → 把玩家放到 60 格内 → 断言龙进入 chase（mode 变化）→ 等待开火 → 断言火球生成 →
  火球撞地 → 断言爆炸（开关开时方块被破坏）。

## 10. 偏离与取舍

1. **视线能透过玻璃、火球会被玻璃挡**：玻璃 `opaqueTable=0`（视线穿过）但 `solidTable=1`（火球挡住）。
   效果 = 龙隔着玻璃看见玩家、喷出的火球在玻璃上炸开。逻辑自洽（玻璃透明看得见，但火球是实体），
   是有意的，不是 bug。
2. **树叶挡视线**：`leaves` 是 `opaque:true`（v1.42 方案 C），故龙看不见树冠下的玩家 —— 与炮塔 LOS
   同口径，是既有后果，不是本次引入。
3. **龙不碰撞方块**：龙在 y=30 飞，不寻路不避障（用户未要求）。火球会撞方块，龙不会。
4. **玩家不掉血**：火球命中玩家只爆炸不掉血（用户明确，血量以后做）。
5. **AI 非确定**：chase/attack 的位置依赖玩家位置与 `Math.random` 冷却，不是 seed 纯函数 ——
   龙是临时实体不进存档，可接受。orbit 模式仍是纯函数。
6. **火球无追踪**：直线飞向发射瞬间的玩家位置，玩家能躲（速度 15 格/秒，飞 40 格约 2.7 秒）。

## 11. 数值参数表（`DRAGON_AI` / `FIREBALL`，config 单一权威）

| 参数 | 值 | 说明 |
|---|---|---|
| `DRAGON_AI.sightRange` | 60 | 发现距离（水平，格） |
| `DRAGON_AI.chaseSpeed` | 9 | 追击/攻击速度（格/秒） |
| `DRAGON_AI.attackRange` | 20 | chase → attack 距离 |
| `DRAGON_AI.flyoverDistance` | 6 | 飞跃触发距离 |
| `DRAGON_AI.turnAroundDistance` | 22 | 飞跃后外飞距离 |
| `DRAGON_AI.disengageDistance` | 78 | 脱离视线距离（60×1.3 滞回） |
| `DRAGON_AI.fireConeDeg` | 20 | 喷火锥半角 |
| `DRAGON_AI.fireCooldownMin/Max` | 5 / 10 | 开火间隔（秒，随机） |
| `DRAGON_AI.fireRange` | 60 | 开火最大距离 |
| `DRAGON_AI.turnRate` | 3.0 | yaw 转向速率（rad/秒） |
| `DRAGON_AI.wobbleAmp/Freq` | 5 / 3 | 盘旋半径调制 |
| `DRAGON_AI.losInterval` | 0.1 | 视线缓存周期（秒） |
| `FIREBALL.speed` | 15 | 火球速度（格/秒） |
| `FIREBALL.maxDistance` | 80 | 火球最远距离 |
| `FIREBALL.radius` | 0.45 | 火球渲染半径 |
| `FIREBALL.poolSize` | 16 | 渲染池容量 |
