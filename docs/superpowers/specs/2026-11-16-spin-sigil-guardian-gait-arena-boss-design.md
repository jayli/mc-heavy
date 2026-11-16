# 旋斩地面法阵 + 末影守卫踱步 + 围场 Boss（三项独立改动，一次交付）

日期：2026-11-16　　状态：待用户批准

## 1. 意图与用户裁定

用户 2026-11-16 三条需求（原话）：

1. 「焰魔的**旋转攻击**我要求也要加上法阵的图案，跟盾击攻击一样，地面出现法阵的图案，
   图案的**位置也跟盾击攻击一样**。」
2. 「地堡里的 boss 末影守卫的**移动的过程中，双腿没有踱步的动作**，感觉不真实，
   移动的时候稍微让双腿有一个踱步的动作。」
3. 「在**围栏内**增加一个 boss 就是末影守卫，在围栏处**按 B** 召唤围栏 boss 末影守卫。」

本轮 `ask_user_question` 三项裁定：

| 议题 | 裁定 |
|---|---|
| 「围栏」指哪 | **围场**（城南门外草地竞技场 `gen/structures/arena.js`，41×79，外圈 236 格闭合栏杆环）。不是大竞技场、不是创造台 |
| 旋斩特效范围 | **只加法阵**。碎石圆环仍只属持盾冲撞 / 举盾砸击（旋斩保持现有的碎石，不新增） |
| 守卫摆腿幅度 | **原版减半 ≈ 17°**（0.6 rad → 0.3 rad）。节奏由我改为按移动距离驱动（约 1.6 步周期/秒） |

⚠️ 「盾击」在本仓的对应物是 **`shieldBash`（举盾砸击）** —— 它是唯一带地面法阵的招
（`game.js` 的 `_consumeIgnisFxRequests`）。`shieldSmash`（持盾冲撞）只有碎石无法阵。
用户说的「跟盾击一样」= 跟 `shieldBash` 一样。

## 2. 目标 / 非目标 / 反目标

**目标**
- 旋斩（`spin`）命中帧铺出与举盾砸击**逐字相同**的 4 段地面火焰法阵（首段在焰魔脚底）。
- 守卫追击/绕行/脱困跳的水平移动期间双腿（与双臂、root）交替摆动，停下即回 bind。
- 玩家站在围场占地内按 B → 召出末影守卫，落在场地中心可站面上。

**非目标**
- 不给旋斩新增碎石（它已有）、不新增法阵伤害与燃烧 debuff（沿用 v3.04 裁定③「只扣血」）。
- 不改任何招式数值（射程 / 锥角 / 命中帧 / 时长 / 权重 / 冷却一律不动）。
- 不改守卫的四招动画、伤害、AI 走位策略、脱困逻辑。
- 不新增方块、不新增贴图、不重烘任何产物（三项都是运行期代码改动）。
- 不给围场加第二个 Boss（用户只要守卫一个）。
- 不做 Boss 血条、不做设置面板开关。

**反目标（做成了也算失败）**
- 为旋斩另写一套法阵落点公式 ⇒ 第二份权威（红线 1），两招位置会漂。
- 只调摆腿幅度而不修「移动判定」⇒ 分支根本不执行，改了没有任何画面变化。
- 相位按 `dt` 推进 ⇒ 撞墙 / 被玩家挡住时原地滑步（腿动而身体不动）。
- 在 `Game.summonBoss()` 里写 `if (kind === 'ARENA')` 特例 ⇒ 名册应是数据。
- 常驻 draw call 增长（守卫池扩到 2 后，零实例必须仍 `visible=false`）。

## 3. 现状与实测约束

### 3.1 旋斩现在一个法阵都没有

`src/core/game.js` 的 `_consumeIgnisFxRequests`：

```js
if (req.kind !== 'shieldSmash' && req.kind !== 'shieldBash' && req.kind !== 'spikeSlash') continue;
… 碎石圆环（三招都出）…
if (req.kind === 'spikeSlash') { …尖锥 + 伤害…; continue; }
if (req.kind !== 'shieldBash' || !this.flameSigil || !this.world) continue;   // ← spin 在这里被挡
… 4 段法阵 …
```

`spin` 已经产生 `attackFxRequest`（`fireHitFrame()` 无条件产，五招共用），也已经出碎石。
**缺的只是最后那道招式过滤放行**。

法阵本体 `src/render/flame-sigil.js` 与落点算法 `Game._findSigilGroundY` 都是现成的：
`FLAME_SIGIL` = radius 2.0 / lifeMs 3000 / segments 4 / spacing 4.25 / **firstOffset 0**
⇒ 距离 **0 / 4.25 / 8.5 / 12.75**（首段在脚底，v3.04b 用户裁定），延迟 `floor(1.5l)×50ms`
= 0 / 50 / 150 / 200ms。旋斩复用这两个函数 ⇒ 位置口径**结构上不可能与举盾砸击不同**。

旋斩命中帧 `IGNIS_ATTACKS.spin.hitFrameSeconds = 0.70`，举盾砸击 1.89 —— 时机不同是招式本身
的语义，不在本轮改动范围。

### 3.2 守卫双腿不动 = 两处缺陷叠加（不是幅度问题）

**缺陷 A（主因，接线断裂）**：`src/entities/bosses/guardian-boss-agent.js:400` 返回

```js
velocity: [0, vy, 0],
```

水平意图 `wantVx/wantVz` 只喂给 `_physicsStep`，**从不写回 state**。而
`src/render/guardian-renderer.js` 的 `_idlePose`：

```js
const moving = Math.abs(v[0]) > MOVING_EPSILON || Math.abs(v[2]) > MOVING_EPSILON;
if (!moving) return out;   // 空 Map ⇒ 全骨架回 bind
```

⇒ `moving` **恒为 false**，原版 `walk()` 那套四肢反相摆动（`IDLE_LIMBS` + root）从未执行过。
对照：焰魔 Agent 返回 `velocity: [vx, vy, vz]`（虽然它的 vx/vz 也恒 0，但焰魔有烘焙 idle 片段，
不依赖这条判据）。丧尸走的是「AI 意图写进 `state.velocity`」的口径（`zombie-system.js` 文件头
②：不另设 intent 容器，否则「渲染看到的移动」与「物理实际的移动」分家）。

**缺陷 B（节奏）**：`IDLE_WALK_SPEED = 0.5 * 4 = 2 rad/s` ⇒ 一个完整步周期 π 秒 ≈ **3.14s**。
守卫 `chaseSpeed = 5.4` 格/秒 ⇒ 一个周期走 **17 格**。原版 `limbSwing` 是**按移动距离**推进的
（`walkAnimation(distance, partialTick)`），不是按时间。即便修好 A，节奏仍是慢动作。

**原版数值**（`ModelEnder_Guardian.setupAnim`，已逐行读过）：

```java
float walkSpeed = 0.5F, walkDegree = 0.5F;
walk(left_leg,  walkSpeed, walkDegree*1.2F, true,  …, limbSwing, limbSwingAmount);
flap(root,      walkSpeed, walkDegree*0.2F, false, …);
walk(right_leg, walkSpeed, walkDegree*1.2F, false, …);
walk(left_arm,  walkSpeed, walkDegree*1.2F, false, …);
walk(right_arm, walkSpeed, walkDegree*1.2F, true,  …);
```

⇒ 四肢摆幅 0.6 rad（34.4°）、root 0.1 rad（5.7°）、左右反相。本轮四肢取 **0.3 rad（17.2°）**、
root 按原比例 ×0.5 取 **0.05 rad（2.9°）**。

**产物侧无 idle 片段**：`assets/guardian/guardian.json` 只有 `strong_right / strong_left /
uppercut / stomp` 四条攻击片段（20 骨骼 / 24 盒 / 576 顶点），且四条都驱动 `left_leg/right_leg`
（实测最大腿摆角 12.5~17.5°）⇒ **攻击期间不得叠加步态**（两套打架），现有
`attacking ? sampleGuardianAttack(...) : this._idlePose(...)` 的分工保持不变。

### 3.3 围场没有登记任何 Boss

`src/entities/bosses/boss-map.js` 的 `DETECTORS` = city / tarn / burningArena / ruinedCitadel /
snow / shallowTarn —— **没有围场**。`BOSS_ROSTER` 只有 `TARN / BURNING_ARENA / RUINED_CITADEL`。
⇒ 站在围场里按 B 得到 `no-map` → toast「这里没有可召唤的 Boss」。

**实测（本轮跑的，18 个 seed）**：围场锚点中心与 CITY bounds / TARN 圆 / SNOW 盒（±28）/
SHALLOW_TARN 整形区 / BURNING_ARENA / RUINED_CITADEL 占地 **零重叠**，18/18 seed 都有围场锚点。
结构层本来互斥（`arena.js` 的 `fixedBlockers` 避开地标，`shallow-water-tarns.js:418` 与
`ruined-citadel.js:231` 反过来避开围场）⇒ 加判据不会抢走别处的 B 键。
`computeArenaAnchor` 冷调用实测 avg **71ms** / worst **114ms**（带 64 项 seed 缓存），
而 `bossMapAt` **只在按 B 时调一次**、不进帧循环 ⇒ 成本可接受，**不新增预热**。

**围场落点实测**（读 `assets/structures/arena_grass.json`，stride 5 / floorRow 3）：
- 中心列 `(0,0)` = `[sand(y1), water(y2), glass_block(y3)]` —— 中心是**水池的玻璃盖**，
  `glass_block` 声明 `solid:true` ⇒ 脚底 `floorY+1` 站得住（与 `teleportToArena` 同口径）。
- 中心 **15 格**半径内无任何实心装饰（干草柱在 x=±16、树在 z≈±28、chest 在 x=±16）；
  17×17 范围地板层 3003 格满铺、零缺口。守卫半宽 1.25 / 高 3.8 ⇒ `HEADROOM=ceil(3.8)=4`
  的净空要求满足。
- ⇒ 召唤点取**几何中心** `(a.wx, a.wz)`，`summonY = a.floorY + ARENA_SUMMON_FEET_DY(=1)`。

### 3.4 守卫存活上限必须一起提

`GUARDIAN.maxAlive = 1`（`guardian-config.js:53`，注释「废弃堡垒只有一个」）。
守卫现在要同时服务**两张地图** ⇒ 不提上限的形态是：玩家先在堡垒召了守卫，再走到围场按 B
得到 `{ok:false, reason:'limit'}` → toast「Boss 数量已达上限」，**用户要的功能直接不可用**。

取 **2**（与 `IGNIS.maxAlive = 2` 同口径：两张地图各一只）。派生影响：
- `GuardianRenderer` 池容量 = `GUARDIAN.maxAlive` ⇒ 1→2 个 SkinnedMesh。
  几何/贴图共享，骨骼与材质逐实例独立（现有实现已如此）；零实例时 `pivot.visible=false`
  ⇒ **常驻 draw call 不增**。
- 玩家物理 `_collides` / `_ejectFromBoss` 经 `GuardianService.overlapsAabb` 遍历
  `_guardianIds` ⇒ 两只都生效，无需改动。
- Boss BGM `bossAlive` 已含 `count(GUARDIAN_TYPE)` ⇒ 无需改动。

### 3.5 其它约束

- 三项都不碰热路径（mesher / materials / render-world / scheduler / physics 一行不改）。
- `src/entities/**` 同构层不得 import three；`boss-map.js` 加 import `gen/structures/arena.js`
  属同层向下依赖（已有 `burning-arena` / `ruined-citadel` 先例）。
- 新常量落在两层都能 import 的 config 里（`guardian-config.js`），不在 render 里写第二份。
- `src/tests/test-*.js` 必须注册进 `src/tests/index.html`（漏注册 = 静默不跑）。
- 时间基准 `performance.now()`；坐标判据非负取模。

## 4. 方案取舍（Approaches）

### 4.1 旋斩法阵

1. **放行招式过滤，复用 `sigilSpawnPoints` + `_findSigilGroundY`**（选中）
   一行判据改动 + 一条注释，位置与举盾砸击**结构上同源**。零新代码路径。
2. 为旋斩另写一套落点（例如环绕一圈）
   用户明确要「位置也跟盾击一样」⇒ 违背需求，且是第二份权威。**否决**。
3. 在 Agent 里给旋斩单独发一种 fx 请求类型
   同构层做装配层的决定（招式→特效映射在 `game.js`），且多一个字段要透传。**否决**。

### 4.2 守卫踱步

1. **Agent 写回水平意图 + 渲染器按实际水平位移推相位**（选中）
   A 修接线（与丧尸/焰魔同口径：意图写进 `state.velocity`，不另设容器）；
   B 用「本帧真实位移」推相位 ⇒ 撞墙/被挡时腿自然停住，且帧率无关。
   位移由渲染器自己差分 `st.position`（它已有 `prevY` 差分的先例），**不新增 state 字段**。
2. 只调幅度常量
   分支不执行 ⇒ 零画面变化。**否决**（这正是「看起来改了实际没改」的静默失效）。
3. 相位仍按 `dt` 推进，只把 `IDLE_WALK_SPEED` 调大
   实现最省，但撞墙 / 死区边缘微调时腿动而身体不动（滑步），且不同帧率下步频与步幅脱钩。
   **否决**。
4. 给守卫烘一条 walk 动画片段
   原版守卫的行走本来就是 `setupAnim` 程序化、**无关键帧** ⇒ 烘焙等于新造动画数据，
   且要重跑 `npm run guardian` + 指纹。**否决**（超出「稍微有个踱步动作」的范围）。

### 4.3 围场 Boss

1. **`boss-map.js` 加 `ARENA` 判据 + `boss-registry.js` 加一行名册**（选中）
   与既有五张地图完全同形；`Game.summonBoss()` **一行不改**（它本来就只读名册）。
2. 在 `summonBoss()` 里加围场特例
   违反「名册是数据不是代码分支」的既有设计（`boss-registry.js` 文件头）。**否决**。
3. 复用 `CITY` 判据把围场算进城市
   围场在城市 bounds **之外**（`computeArenaAnchor` 判据①要求出城），且城市本身没有 Boss。
   **否决**。

## 5. 设计

### 5.1 旋斩法阵（`src/core/game.js`）

`_consumeIgnisFxRequests` 的两处招式过滤各加 `spin`：

```js
// 入口 gate：spin 本来就在（碎石路径），不变
// 法阵段：
if ((req.kind !== 'shieldBash' && req.kind !== 'spin') || !this.flameSigil || !this.world) continue;
```

其余**一行不改** —— `sigilSpawnPoints(req.at, req.yaw)` 与 `_findSigilGroundY` 照旧。
注释写明「旋斩与举盾砸击共用同一套落点（用户 2026-11-16：位置也跟盾击一样），
不得为旋斩另写公式」。

⚠️ 尖刺分支的 `continue` 在法阵段之前，顺序不动（否则尖刺会多出法阵）。

### 5.2 守卫踱步

**`src/entities/bosses/guardian-boss-agent.js`**：返回值 `velocity: [wantVx, vy, wantVz]`。
- `wantVx/wantVz` 是**最终意图**（已经过局部绕行 + 寻路采纳 + 飞跃方向），与物理步喂的是同一份。
- `attack` / `idle` 态意图本就是 0 ⇒ 静止时仍回 bind，语义不变。
- ⚠️ Agent 顶部只读 `state.velocity[1]`（vy），**不读水平分量** ⇒ 写回不会形成反馈回路
  （已核实：`let vy = …state.velocity[1]`，无 vx/vz 读取）。

**`src/entities/guardian/guardian-config.js`** 新增冻结常量（渲染层与单测共用的唯一权威）：

```js
export const GUARDIAN_GAIT = Object.freeze({
  limbAmplitude: 0.3,        // 四肢摆幅（rad）= 原版 0.6 的一半，用户裁定 ≈17°
  rootAmplitude: 0.05,       // root 起伏（rad）= 原版 0.1 的一半，保持原版 1:6 比例
  radiansPerBlock: 1.85,     // 相位推进（rad/格）⇒ 一步周期 2π/1.85 ≈ 3.40 格
  movingEpsilon: 0.001,      // 与 ZOMBIE_MOVING_EPSILON 同值
});
```

`radiansPerBlock = 1.85` 的来历：chaseSpeed 5.4 格/秒 × 1.85 = 9.99 rad/s ⇒ **1.59 步周期/秒**
（用户批准的「约 1.6」）。原版 `walkSpeed 0.5` 配原版移速 0.27 格/tick 换算约 2.7 rad/格，
本仓取 1.85 是**观感标定值**（守卫体型大、步幅相应更大），不是原版语义改动。

**`src/render/guardian-renderer.js`**：
- 删掉 `IDLE_WALK_SPEED` / `IDLE_LIMB_AMPLITUDE` / `IDLE_ROOT_AMPLITUDE` / `MOVING_EPSILON`
  四个本地常量，改 import `GUARDIAN_GAIT`（红线 1：不留第二份）。
- 实例新增 `prevX / prevZ`（与既有 `prevY` 并列，实例复用时一并重置为 `null`）。
- `_idlePose`：
  ```js
  const intentMoving = |v[0]| > eps || |v[2]| > eps;      // 意图（Agent 写回）
  const dx = prevX === null ? 0 : x - prevX;  dz 同理;     // 实际位移
  const moved = Math.hypot(dx, dz);
  if (intentMoving && moved > eps) inst.idlePhase += moved * radiansPerBlock;
  else inst.idlePhase = 0;                                // 静止/撞墙 ⇒ 回 bind
  ```
  ⚠️ **两条都要**：意图为假直接归零（idle/attack 语义）；意图真但位移≈0（撞墙、被玩家挡住）
  也归零 —— 这是「不滑步」的判据。首帧 `prevX===null` ⇒ moved=0 ⇒ 不摆（与 `prevY` 同口径）。
- ⚠️ **`prevX/prevZ` 必须在 `_syncOne` 里更新，且用的是物理 `st.position`**，
  不是加了 lift/knock 偏移的渲染位置（否则击退补间会被当成移动而摆腿）。
- 四肢 / root 的四元数构造与 `IDLE_LIMBS` 的左右反相**不变**。
- 攻击期间不调 `_idlePose`（现有分工），但 `prevX/prevZ` 仍每帧更新 ⇒ 招式结束回 chase 时
  第一帧的位移基准是新的（不会把整段攻击期的位移一次性算成一大步）。

### 5.3 围场 Boss

**`src/gen/structures/arena.js`** 新增（与 `BURNING_ARENA_SUMMON_FEET_DY` 同手法）：

```js
/** 召唤落点脚底相对 floorY 的偏移：地板层坐落在 floorY ⇒ 站在它上面一格 */
export const ARENA_SUMMON_FEET_DY = 1;
```

**`src/entities/bosses/boss-map.js`**：
- `BOSS_MAP_KINDS` 插入 `'ARENA'`，位置在 `'RUINED_CITADEL'` 之后、`'SNOW'` 之前
  （地面级人工结构统一排在 region 级 SNOW 盒之前 —— 与两个竞技场同一条理由）。
- 新增 `arenaMapAt(wx, wz, seed)`：`computeArenaAnchor` + `inArenaFootprint`（**转调权威，
  不自己写 `Math.abs(dx) <= 20`**），返回
  `{kind:'ARENA', cx:a.wx, cz:a.wz, key:'arena:0', summonY:a.floorY + ARENA_SUMMON_FEET_DY}`。
- `DETECTORS` 同位置插入。

**`src/entities/bosses/boss-registry.js`**：

```js
ARENA: Object.freeze([
  Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
]),
```

**`src/entities/guardian/guardian-config.js`**：`maxAlive: 1 → 2`，注释改成
「两张地图各一只（废弃堡垒 + 围场），与 IGNIS.maxAlive 同口径」。

**`src/core/game.js`**：`summonBoss()` **不改**。装配段守卫注释补一句「也服务围场」。

### 5.4 冻结断言重标（按新裁定，不是放宽）

| 文件 | 旧 | 新 | 理由 |
|---|---|---|---|
| `test-guardian-config.js` | `maxAlive === 1` | `=== 2` | 用户新增围场 Boss |
| `test-guardian-system.js`「summon 幂等」 | `reason === 'limit'` | `=== 'exists'` | maxAlive=2 时同槽重召先命中 id 检查（与焰魔同形）。**场上仍只有一条**这条判据不动 |
| `test-guardian-system.js`「超出 maxAlive」 | 召第二张图即 limit | 循环召满 `maxAlive` 张后再召 → limit | 从常量派生，不写死 2 |
| `test-guardian-render.js` 池容量 | 读 `GUARDIAN.maxAlive` | 不变 | 已从常量派生 |

## 6. 验证

### Tier 1（必须 TDD，RED→GREEN）

**`src/tests/test-guardian-boss-agent.js`**（新增）
- chase 且玩家在环外 ⇒ 返回 state 的 `velocity[0]/[2]` 非零，且方向朝玩家；
- attack / idle / 死区站定 ⇒ 水平分量恒 0；
- 撞墙（四面实心）⇒ 意图仍非零（**不清零**，与丧尸同口径），但位移为 0
  —— 这条与渲染层的「不滑步」判据配对。

**`src/tests/test-guardian-render.js`**（新增）
- 移动中 `left_leg` 与 `right_leg` 的增量**反相**（一正一负），幅度 ≤ `limbAmplitude`；
- **相位按位移而非时间**：同一 dt 下「位移 1 格」与「位移 0.1 格」两帧，前者相位增量 ≈ 后者 10 倍；
- **撞墙不滑步**：意图非零但 `position` 逐帧不变 ⇒ 淡入走完后四肢回 bind；
- 静止 ⇒ 回 bind（既有用例保留）；
- 攻击期间不叠加步态（`attackAnimT > 0` 时腿姿态 == 片段采样值）；
- 实例复用给新实体 ⇒ `prevX/prevZ/idlePhase` 重置（新实体首帧不摆）；
- 池容量 2、两只守卫骨骼/材质独立、零实例 `visible=false`。

**`src/tests/test-boss-map.js`**（新增）
- 围场锚点 → `ARENA`，`cx/cz` = 锚点，`key='arena:0'`，`summonY = floorY + ARENA_SUMMON_FEET_DY`；
- 占地边缘判 ARENA、边缘外一格不判；
- `BOSS_MAP_KINDS` 含 ARENA 且排在 SNOW 之前；
- 名册 `ARENA` = 1 个 slot 0 守卫；
- **多 seed 互斥**：扫 ≥8 个 seed，围场中心不得被判成别的地图（实测零重叠，这条防空跑用
  `checked > 0` 钉住）。

**`src/tests/test-guardian-system.js`**：§5.4 三条重标 + 「两张不同地图各召一只成功、
第三张 limit」。

⚠️ 全部新 test 注册进 `src/tests/index.html`（既有的四个文件已注册，只需确认）。

### Tier 4（像素 / 真实消费路径实测，不得目视宣称）

**`tests/ignis-fx.spec.mjs`** 扩一条：旋斩走**真实帧循环**到命中帧 0.70s
（钉 `mode:'attack', attackKind:'spin', attackAnimT:0`，同既有 shieldBash 用例手法）
- `flameSigil.activeCount > 0` 且延迟过后 `mesh.visible === true`；
- **首段实例矩阵位移 == 焰魔脚底**（`getMatrixAt(0)` 读真实 `three.Matrix4`，
  `firstSegmentDist < 0.01`）—— 与举盾砸击同一条判据；
- 金黄像素（`r > g && r − b > 100`，带沙漠沙对照）**上下界都钉**，先测同状态噪声底；
- ⚠️ **两侧都先藏掉焰魔实例**（`inst.mesh.visible=false`）—— 它自带火焰橙、idle 波动
  ±18000 像素会淹没判据（v3.04 实测教训）；
- 寿命结束后 `activeCount === 0` 且 `visible === false`。

**`tests/guardian.spec.mjs`** 扩两条：
1. **围场按 B**：`teleportToArena()` → 等 column ready → 派真实 `KeyB` →
   守卫 `activeEntities().length === 1`、`onGround === true`、
   `y === a.floorY + ARENA_SUMMON_FEET_DY`、`floor(x/z) === a.wx/a.wz`、
   `id` 含 `arena:0`、脚下实心 / 自身空气；再断言它**在栏杆环内**
   （切比雪夫距 < `ARENA_HALF_X/Z`）。
2. **踱步真的发生在画面上**：把守卫放在开阔地、玩家在 12 格外让它 chase，
   连续采样 `left_leg` 骨骼四元数与 `state.position`：
   - 位移 > 0 的帧里腿角度**有变化且左右反相**；
   - 角度峰值落在 `[0.5×limbAmplitude, limbAmplitude]`（弧度，从四元数反解）；
   - 玩家贴近到死区内站定后，淡入走完 ⇒ 腿回 bind。
   ⚠️ 判据落在**真实骨骼四元数**上（`instances[0].bones[i].quaternion`），不是纯函数返回值。

**负向验证（每条必须真 FAIL，用 `cp` 副本还原，禁用 git checkout）**
- 旋斩：把法阵段的 `spin` 去掉 ⇒ 旋斩用例红；
- 守卫 A：`velocity` 改回 `[0, vy, 0]` ⇒ 踱步用例红；
- 守卫 B：相位改回 `dt × 2` ⇒ 「位移 10 倍 ⇒ 相位 10 倍」用例红；
- 不滑步：去掉 `moved > eps` 门 ⇒ 撞墙用例红；
- 围场：`DETECTORS` 去掉 `arenaMapAt` ⇒ 按 B 用例红（`no-map`）。

### 门禁

`npm run check`（arch + data + lint）+ 浏览器内单测全量 + 上述两个 spec。
**不跑 `bench --check`**：三项都不碰热路径（testing-policy §6.1）。

⚠️ **守卫池 1→2 的 draw call 判据落在哪里**（已核对，不要凭名字选 spec）：
`tests/entities.spec.mjs` 只测 M5 的 column 卸载 / 保存 gate，**不读 drawCalls**，跑它对本轮
零判别力。真正的判据是两条：
- 单测：`GuardianRenderer` 零实例时**两个** `pivot.visible === false`（Tier 1，见上）；
- E2E：在 `tests/guardian.spec.mjs` 的围场用例里，**召守卫前**先 `setShadowsEnabled(false)`
  （VSM 下 receiveShadow 对象也进阴影 pass，不关会让 drawCalls 无关波动 —— 全仓 spec 同口径），
  读 `renderStats().drawCalls` 作基线；守卫 despawn 后再读一次，断言**回到基线**。

⚠️ 新增 lint warning 不得称作既有基线：改过的文件单独 `npx eslint <files>` 核对。

## 7. 留给实施者的决定

- `radiansPerBlock` 与两个 amplitude 是**观感旋钮**，实玩觉得快/慢/大/小可微调
  （改 `GUARDIAN_GAIT` 一处，判据从常量派生 ⇒ 不用改断言）。
- 围场召唤点若实玩觉得「站在水池玻璃盖上」不好看，可改成 `cz + 12`（实测该处 17×17 地板
  满铺、9 格内无装饰）——但那要同步改 `ARENA_SUMMON_*` 常量与用例，属独立调整。

## 8. 本轮明确不做

旋斩碎石新增 / 法阵伤害与燃烧 debuff / 任何招式数值改动 / 守卫四招动画改动 /
守卫 walk 动画烘焙 / 围场第二个 Boss / Boss 血条 / 设置面板开关 / 相机改动 /
其它地图的 Boss 名册变更。