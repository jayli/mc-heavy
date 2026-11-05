// src/entities/ignis/ignis-config.js — 焰魔（Ignis, v2.55）冻结玩法数据的**唯一权威**
//
// 同构层：**无 DOM、无 three、无 Worker**（`npm run check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
// system / agent / renderer / 单测都从这里派生，不得各自写字面量（红线 1）。
//
// ## 数值来源：素材原作（不是猜的）
//
// 大部分数值**直接取自 Cataclysm mod 的作者实现** `Ignis_Entity.java` 的
// `ignis()` 属性表与 `AreaAttack(...)` 调用点（2026-11-05 实测读取）：
//
// | 本仓常量 | 作者原值 | 出处 |
// |---|---|---|
// | `IGNIS.health` | 450 | `Attributes.MAX_HEALTH` |
// | `IGNIS.attackDamage` | 14 | `Attributes.ATTACK_DAMAGE` |
// | `IGNIS_AI.sightRange` | 50 | `Attributes.FOLLOW_RANGE` |
// | `IGNIS_AI.chaseSpeed` | 6.6 | `MOVEMENT_SPEED 0.33` 格/tick × 20 |
// | `IGNIS_AI.hitRange` | 6.5 | `AreaAttack(range=6.5, ...)` |
// | `IGNIS_AI.hitConeDeg` | 35 | `AreaAttack(..., arc=70, ...)` 的**半角** |
// | `IGNIS_AI.hitFrameSeconds` | 1.20 | `SWING_ATTACK` 的 tick 24 ÷ 20 |
// | `IGNIS_AI.attackAnimSeconds` | 2.75 | `SWING_ATTACK` = 55 tick（↔ Bedrock `attack6a`） |
//
// ⚠️ **动画配对依据**（spec §2.0 的 tick 表）：Java `SWING_ATTACK` 是 55 tick，
// 对应 Bedrock 的 **`attack6a`**（2.75 秒），**不是** `attack1`（70 tick = `SHIELD_SMASH_ATTACK`）。
// 交叉证据：`attack6a` 的 `root.rotation.y` 到 −65°（配得上 arc 70° 的横扫），`attack1` 只到 +30°。
//
// ⚠️ 本文件**不 import 任何模块**：纯常量表。几何度量（`IGNIS_CORE_OBB` /
// `IGNIS_MODEL_CENTER`）是软件光栅化实测值，与 `tools/ignis-fingerprint.mjs` 的烘焙度量
// **语义不同**（那个是顶点/骨骼计数，这个是空间尺寸），故不互相 import。

/**
 * 实体类型名（`EntityManager.registerType` 与各处 predicate 共用）。
 *
 * ⚠️ **刻意不复用 `'dragon'`**：两种 Boss 的 AI（空中轨道 vs 地面行走）、物理
 * （无重力 vs 有重力 + step-up）、渲染器（4 实例池 vs 2）全不同。共用 type 会让
 * 渲染器与 `damageEntity` 路由互相抢到对方的实体（`sync` 都按 type 过滤）。
 */
export const IGNIS_TYPE = 'ignis';

/**
 * 按「地图实例 + 槽位」派生实体 id（与 `dragonEntityIdFor` 同手法）。
 *
 * ⚠️ **派生而非自增序号**：id 是 `(mapKey, slot)` 的纯函数 ⇒ 同一张地图的同一个槽位
 * 恒同 id，「走远 column 卸载 → 回来重召」会复用同一个 id（幂等），不会攒出第二条。
 *
 * @param {string} mapKey `bossMapAt()` 返回的地图实例标识（如 `tarn:2:0`）
 * @param {number} slot 名册里的槽位下标（高台地带的焰魔是 1）
 * @returns {string}
 */
export function ignisEntityIdFor(mapKey, slot) {
  return `${IGNIS_TYPE}:${mapKey}:${slot}`;
}

/**
 * 焰魔的玩法数值。
 *
 * ⚠️ **`position` 语义是「脚底中心」**（与丧尸一致，与飞龙的「身体中心」不同）：
 * 焰魔是地面实体，靠重力 + step-up 移动，脚底语义才能让物理与碰撞盒对齐。
 * 渲染层的脚底补偿量来自**烘焙产物的 `metrics.feetOffsetY`**（扫全部动画帧算出的
 * 最低点绝对值），不在这里写第二份（红线 1：同一事实只有一个权威）。
 */
export const IGNIS = Object.freeze({
  /** 生命。作者 `MAX_HEALTH`；与 Bedrock `ignis.json` 的 450 一致 */
  health: 450,
  /** AABB 半宽（Bedrock `collision_box.width: 1`） */
  halfWidth: 0.5,
  /** AABB 高（Bedrock `collision_box.height: 3.25`） */
  height: 3.25,
  /**
   * 近战伤害。作者 `ATTACK_DAMAGE`。
   *
   * ⚠️ **只取 `AreaAttack` 的 `damage` 项，不取 `hpdamage`**（第五参，按目标最大血量百分比扣）：
   * 本仓玩家血量是固定 20 格，百分比伤害会变成不直观的「百分比 × 20」。
   * 14 对 20 格血意味着**两下即死** —— 这是作者的原始压迫感，用户已确认「只扣血不死亡」。
   */
  attackDamage: 14,
  /** 受伤红闪时长（ms）。与 `DRAGON.flashMs` 数值相同但**各自持有常量、不互相 import** */
  flashMs: 200,
  /**
   * 同时存在的焰魔上限（= 渲染池容量 = draw call 上限）。
   *
   * 每条焰魔是一个独立 SkinnedMesh（骨骼是 Object3D，无法合批）⇒ N 条 = N 个 draw call。
   * 2 是「玩家要跑到 2 个不同高台地带各按两次 C」才达得到的量。
   */
  maxAlive: 2,
});

/**
 * 焰魔的地面 AI 数值。
 *
 * ⚠️ **前 8 项是作者真实值，不得随意改**（见文件头的来源表）；
 * 后 6 项是「作者没有对应常量、必须由本仓自己定」的（附各自的标定理由）。
 */
export const IGNIS_AI = Object.freeze({
  // ==================== 取自作者（勿改）====================

  /** 发现距离（水平，格）：视线通 + 水平距 ≤ 此值 → 追击。作者 `FOLLOW_RANGE` */
  sightRange: 50,
  /** 追击速度（格/秒）。作者 `MOVEMENT_SPEED 0.33` 格/tick × 20 */
  chaseSpeed: 6.6,
  /**
   * 命中判据的水平距离（格）。作者 `AreaAttack` 的第一参 `range`。
   * ⚠️ 6.5 是「持剑横扫能够到的范围」，比 `attackRange` 大（滞回，见下）。
   */
  hitRange: 6.5,
  /**
   * 命中判据的前方**半角**（度）。
   *
   * ⚠️⚠️ **35 = 作者 `arc 70` 的一半**，不是 70 本身。`AreaAttack` 里判的是
   * `|relativeAngle| <= arc/2`；本仓的 `fireConeDeg` / `hitConeDeg` 口径都是**半角**。
   * 直接填 70 会让扇面变成 **140°** —— 玩家绕到侧面也躲不掉，而且**没有任何断言会红**
   * （它只是「打得更宽」）。`test-ignis-system.js` 有一条 `hitConeDeg < 70` 的守卫。
   */
  hitConeDeg: 35,
  /**
   * 挥砍动画的命中时刻（秒）。作者在 `SWING_ATTACK` 的 **tick 24** 结算伤害
   * （`Ignis_Entity.java` 的 `aiStep()`：`getAnimationTick() == 24` → `AreaAttack(...)`）。
   * 24 ÷ 20 tick/秒 = **1.20 秒**。
   */
  hitFrameSeconds: 1.20,
  /**
   * 攻击动画时长（秒）= Java `SWING_ATTACK` 的 55 tick ÷ 20 = **2.75 秒**。
   * 与烘焙产物 `animations.attack` 的 `frameCount / fps` 同源。
   */
  attackAnimSeconds: 2.75,

  // ==================== 本仓标定（作者无对应常量）====================

  /**
   * 进入攻击态的水平距离（格）。
   *
   * ⚠️ **比 `hitRange`(6.5) 小 1 格是滞回**：两者相等时，玩家在边界上来回走会让状态机
   * 每帧在 chase/attack 之间抖动（形态是「焰魔原地反复起手又取消」）。
   */
  attackRange: 5.5,
  /**
   * 脱离追击的距离（格）。`sightRange`(50) × 1.2 的滞回上界，防边界抖动（同飞龙的
   * `disengageDistance` 手法）。
   */
  disengageRange: 60,
  /** yaw 平滑转向速率（rad/秒）。与飞龙同口径 */
  turnRate: 3.0,
  /**
   * 攻击冷却下限（秒）。**从「命中时刻」起算**（不是从动画结束起算）。
   *
   * ⚠️⚠️ **必须严格大于 `attackAnimSeconds`（2.75），否则冷却会被动画「吃掉」**：
   * 冷却从命中时刻开始计，而命中时动画还剩 `2.75 - 1.20 = 1.55` 秒。若下限 ≤ 动画时长，
   * 冷却在动画播完前就已走完 ⇒ 下一次起手的时间间隔等于动画时长，`attackCooldownMin`
   * **在数值上不起作用**（缺陷形态：焰魔无间隔连砍，而所有常量看上去都对）。
   *
   * 取 3.5 ⇒ 命中间隔 [3.5, 6.0] 秒（动画 2.75 已经包含在里面）。
   * 作者的 `HORIZONTAL_SWING_COOLDOWN = 160 tick`（8 秒）是横扫专属冷却，本 v1 只有一个
   * 攻击，用动画时长 + 余量的节奏更紧凑（用户实玩后可调）。
   */
  attackCooldownMin: 3.5,
  /** 攻击冷却上限（秒）⇒ 命中间隔 [3.5, 6.0] 秒随机 */
  attackCooldownMax: 6.0,
  /**
   * 视线缓存周期（秒）= 10Hz。
   * ⚠️ **开火（命中）瞬间必须做一次新鲜复查**，不能用这个缓存 —— 否则会隔着墙打到人。
   */
  losInterval: 0.1,
  /**
   * 重力加速度（格/秒²）。与 `zombie-system.js` 的 `GRAVITY` 和 `player/physics.js`
   * 同一口径（-24 = MC 的 0.08 格/帧² × 60²）—— 手感一致，不会飘。
   */
  gravity: -24,
  /** 一格台阶上限（格）。与 `ZOMBIE_MAX_STEP` 同口径 */
  maxStep: 1.0,
});

/**
 * 身体核心的命中盒（**相对 `state.position` 的局部空间**，单位格）。
 *
 * 用户裁定「只算身体核心」（不含剑/盾/手臂外沿）：实测 body+head+上下身的模型空间 bbox
 * = **26.44 × 45.47 × 24.86 px** → ×1/16 = **1.6528 × 2.842 × 1.5539 格**
 * ⇒ 半长 `[0.8264, 1.421, 0.777]`。
 *
 * ⚠️ **`center` 恒 `[0,0,0]`**：`state.position` 的语义就是「身体核心中心」（与飞龙同）。
 * ⚠️ **AABB 必须按 `state.yaw` 现算**（`ignisAabbFor`）：焰魔在转向，固定盒会在它横过来时
 * 漏判/误判（「明明打中了却没掉血」）。
 */
export const IGNIS_CORE_OBB = Object.freeze({
  halfExtents: Object.freeze([0.8264, 1.421, 0.777]),
  center: Object.freeze([0, 0, 0]),
});

/**
 * 模型空间里「身体核心 bbox 的中心」相对模型原点的偏移（单位格）。
 *
 * 实测核心 bbox 在模型空间是 x[−13.22, 13.22] y[5, 50.47] z[−11, 13.86] px
 * → 中心 (0, 27.736, 1.431) px → ×1/16 = **(0, 1.7335, 0.0895)** 格。
 *
 * **渲染层专用**：几何顶点是模型空间坐标（模型原点在脚底附近），而 `state.position`
 * 是身体核心中心 ⇒ 渲染器把 mesh 局部偏移 `−IGNIS_MODEL_CENTER`，体心就正好落在
 * `state.position`。**命中判定不用它**（用上面的 `IGNIS_CORE_OBB`）。
 */
export const IGNIS_MODEL_CENTER = Object.freeze([0, 1.7335, 0.0895]);

/**
 * 盘旋（不适用）：焰魔是地面 Boss，没有轨道参数。
 *
 * 保留此注释只为说明「为什么 `dragon-config.js` 里那一大堆 orbit 字段这里一个都没有」——
 * 地面实体没有轨道中心/半径/角速度/bob，多写一个都是死字段。
 */

/**
 * 行走时的上下微晃振幅（格，纯观感）。
 *
 * 从烘焙产物的 idle 动画里已经能从 `root.position.y` 的 Molang 表达式（±0.75 px）拿到
 * 呼吸感，故这里**不再叠一层**程序化 bob —— 两套叠起来会让「呼吸」和「走路」互相打架。
 * 保留此常量是为了让「为什么没有 walk bob」有一个可搜索的答案。
 */
export const IGNIS_NO_WALK_BOB = 0;
