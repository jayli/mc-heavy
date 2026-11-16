// src/entities/guardian/guardian-config.js — 末影守卫（Ender Guardian）玩法数值冻结表
//
// 本文件属 Worker 同构层（红线 8）：**不 import 任何模块**（纯常量表），
// 与 `ignis/ignis-config.js` 同口径。烘焙度量在 `tools/guardian-fingerprint.mjs`（node 侧），
// 两者语义不同（顶点计数 vs 玩法数值），故不互相 import。
//
// ## 数值来源
//
// | 常量 | 出处 |
// |---|---|
// | `health: 2000` | **用户裁定**（原版 `MAX_HEALTH 333`，用户要求更耐打） |
// | `attackDamage: 16` | `Ender_Guardian_Entity.java` 的 `ATTACK_DAMAGE 16` |
// | `halfWidth / height` | 原版 `sized(2.5F, 3.8F)` ⇒ 半宽 1.25、高 3.8 |
// | `sightRange: 50` | 原版 `FOLLOW_RANGE 50` |
// | `chaseSpeed: 5.4` | 原版 `MOVEMENT_SPEED 0.27` 格/tick × 20 |
// | 四档 `hitRange / hitConeDeg` | 原版 `AreaAttack(range, damage, arc, …)`，**arc 是总角 ⇒ 半角取一半** |
// | 四档 `hitFrameSeconds` | `Ender_Guardian_Entity.aiStep()` 的 `getAnimationTick() == N` 结算点 |
// | 四档 `animSeconds` | `ModelEnder_Guardian.java` 的关键帧 tick 合计 ÷ 20 |
// | `GUARDIAN_CORE_OBB` | 烘焙产物核心四骨骼 bind pose 包围盒**实测**（spec §8） |
// | 站定环 / 脱困 / 感知间隔 | 本仓标定（沿用焰魔的同名语义，体形相关项另标） |
//
// ⚠️ **原版 `maxUpStep 1.75F` 刻意不取**，见 `GUARDIAN_AI.maxStep` 的注释。
// ⚠️ **原版 `ARMOR 20` / `KNOCKBACK_RESISTANCE 1.0` 不引入**：本仓无护甲减伤系统。
// ⚠️ **后者的另一层语义（v2.95 已裁定）**：原版该属性只指击退附魔/爆炸位移（本仓无此机制），
// **不包含**「被剑砍有无受击反馈」—— 守卫被砍会后退一小步（与焰魔同口径，走 `GuardianService.knockback`）。
// 它与「不动如山」（`_ringIntent` 死区站定：玩家贴身推它时不主动退让）是两件事，不矛盾。

/** 实体 type（`EntityManager` 的注册键，也是 id 前缀） */
export const GUARDIAN_TYPE = 'guardian';

/**
 * 实体 id 由 `(mapKey, slot)` 确定性派生。
 *
 * ⚠️ **不用 `Math.random()`**：走远卸载 → 回来重召必须得到同一个 id，否则会攒出第二条。
 */
export function guardianEntityIdFor(mapKey, slot) {
  return `${GUARDIAN_TYPE}:${mapKey}:${slot}`;
}

/** 体形与基础数值 */
export const GUARDIAN = Object.freeze({
  /** 血量 —— 用户裁定 2000（原版 333） */
  health: 2000,
  /** 碰撞盒半宽（格）= 原版 `sized(2.5F, …)` 的一半 */
  halfWidth: 1.25,
  /** 碰撞盒高（格）= 原版 `sized(…, 3.8F)` */
  height: 3.8,
  /** 单击伤害 = 原版 `ATTACK_DAMAGE` */
  attackDamage: 16,
  /** 红闪时长（ms），与焰魔/丧尸同口径 */
  flashMs: 200,
  /**
   * 同时存活上限 —— **两张地图各一只**（废弃堡垒 + 围场，v3.09），
   * 与 `IGNIS.maxAlive` 同口径。用户 2026-11-16 给围场也加了守卫。
   *
   * ⚠️ **不得回到 1**：那会让「先在堡垒召了守卫，再走到围场按 B」得到
   * `{ok:false, reason:'limit'}` ⇒ toast「Boss 数量已达上限」，用户要的功能直接不可用。
   * ⚠️ 渲染池容量从本常量派生 ⇒ 2 个 SkinnedMesh（几何/贴图共享，骨骼与材质逐实例独立）；
   * 零实例时 `pivot.visible=false` ⇒ **常驻 draw call 不增**。
   */
  maxAlive: 2,
});

/**
 * 四档招式档案。**结算必须逐招读这里**，不得读 `GUARDIAN_AI` 的派生最大值。
 *
 * ⚠️⚠️ **`hitConeDeg` 是半角**：原版 `AreaAttack` 判的是 `|relativeAngle| <= arc/2`。
 * 右/左重击的 `arc 70` ⇒ 半角 **35**；上勾拳 `arc 60` ⇒ **30**。
 * 直接填 arc 会让扇面翻倍，而**没有任何断言会红**（只是「打得更宽」）。
 *
 * ⚠️⚠️ **踩踏刻意取 180（全向）**：原版这一招是召唤尖牙（`EvokerFangs` 环形铺开），
 * 本仓改造成环形近战（spec §4.3 用户裁定「只做三招近战、不做弹丸/召唤」）⇒ 全向惩罚。
 * 故**不得照搬焰魔「半角必须 < 180」的守卫**。
 *
 * ⚠️ **`animSeconds` 取关键帧 tick 合计，不是 `Animation.create(n)` 的声明值**：
 * 上勾拳声明 100 但关键帧只到 **90** ⇒ 4.5s（照声明值会多 0.5s 静止尾巴）。
 *
 * ⚠️ **`cooldownSeconds = 0` 表示「无额外独立冷却」**（两档普攻），只受全局
 * `attackCooldownMin/Max` 约束。非零项必须 > 本招 `animSeconds` 且 ≥ **一次完整普攻周期**
 * （最短招动画 + 空档下限），否则冷却被动画吃掉 / 比普攻还频繁，两者都是「数值看着对但不起作用」。
 * ⚠️ **v3.10：不得直接拿本值与 `attackCooldownMin` 比** —— 那个常量现在只是 1.0s 的
 * 空档（不含动画），直接比会恒真。判据已改成与「普攻周期」比（`test-guardian-config.js`）。
 *
 * ⚠️ **独立冷却在起手当帧置位**（不是命中帧）：玩家跑掉不命中时，按命中帧计会让
 * 那一招反复抽中却一次也打不出去。
 */
export const GUARDIAN_ATTACKS = Object.freeze({
  /** 右重击：Java `GUARDIAN_RIGHT_STRONG_ATTACK`，60 tick，tick 29 结算 */
  strong_right: Object.freeze({
    hitRange: 5.15, hitConeDeg: 35, hitFrameSeconds: 29 / 20, animSeconds: 3.0,
    weight: 0.30, cooldownSeconds: 0,
  }),
  /** 左重击：Java `GUARDIAN_LEFT_STRONG_ATTACK`，60 tick，tick 34 结算 */
  strong_left: Object.freeze({
    hitRange: 5.15, hitConeDeg: 35, hitFrameSeconds: 34 / 20, animSeconds: 3.0,
    weight: 0.30, cooldownSeconds: 0,
  }),
  /** 上勾拳：Java `GUARDIAN_UPPERCUT_AND_BULLET`，关键帧 90 tick，tick 27 结算（不取弹丸） */
  uppercut: Object.freeze({
    hitRange: 6.25, hitConeDeg: 30, hitFrameSeconds: 27 / 20, animSeconds: 4.5,
    weight: 0.25, cooldownSeconds: 9.0,
  }),
  /** 踩踏：Java `GUARDIAN_STOMP`，48 tick，tick 32 结算（原版尖牙 → 环形近战） */
  stomp: Object.freeze({
    hitRange: 4.5, hitConeDeg: 180, hitFrameSeconds: 32 / 20, animSeconds: 2.4,
    weight: 0.15, cooldownSeconds: 12.0,
  }),
});

/** 招式清单（顺序即抽签累加顺序）。唯一权威 = `GUARDIAN_ATTACKS` 的键。 */
export const GUARDIAN_ATTACK_IDS = Object.freeze(Object.keys(GUARDIAN_ATTACKS));

/** 各招的派生最大值 —— 只服务「最远/最宽/最长能到多少」这类读法 */
const ATTACK_MAX = Object.freeze({
  hitRange: Math.max(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitRange)),
  hitConeDeg: Math.max(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitConeDeg)),
  hitFrameSeconds: Math.max(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitFrameSeconds)),
  animSeconds: Math.max(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].animSeconds)),
});

/** AI 行为常量 */
export const GUARDIAN_AI = Object.freeze({
  // ==================== 取自作者（勿改）====================

  /** 发现距离（水平，格）= 原版 `FOLLOW_RANGE` */
  sightRange: 50,
  /**
   * 追击速度（格/秒）= 原版 `MOVEMENT_SPEED 0.27` × 20。
   *
   * ⚠️ **这是玩家跑速（8 格/秒）的 67%**，比焰魔减速后的 2.93 快得多。焰魔曾因过快被
   * 用户两次裁定降速（v2.62 / v2.63）。**实玩后若觉得快，改这一个常量即可** ——
   * 站定环的三条不变式（死区 > 单帧位移、环上落点 ≤ attackRange）在更慢时余量更大，
   * 不会因降速而失效；但**提速**必须重核那三条。
   */
  chaseSpeed: 5.4,
  /** 命中水平距（格）—— **各招最大值**（派生）。单刀判定读 `GUARDIAN_ATTACKS[kind]` */
  hitRange: ATTACK_MAX.hitRange,
  /** 命中前方半角（度）—— **各招最大值**（派生，踩踏的 180）。单刀判定读档案 */
  hitConeDeg: ATTACK_MAX.hitConeDeg,
  /** 命中时刻（秒）—— **各招最大值**（派生，左重击 1.70） */
  hitFrameSeconds: ATTACK_MAX.hitFrameSeconds,
  /**
   * 动画时长（秒）—— **各招最大值**（派生，上勾拳 4.5）。
   *
   * ⚠️ **v3.10 起不再服务「冷却下限靠它保护」**：冷却改成「收势后空档」口径后，
   * 收势是显式加数，不会被吃掉。本值只服务「最长的一招多长」这类读法。
   */
  attackAnimSeconds: ATTACK_MAX.animSeconds,

  // ==================== 本仓标定 ====================

  /**
   * 进战攻击态的水平距离（格）。
   *
   * ⚠️⚠️ **必须 < 各招 hitRange 的最小值（4.5，踩踏）**，不是只小于派生最大值 6.25。
   * 照抄焰魔的 5.5 会让守卫停在 5 格外出踩踏而**永远打不中**，而
   * 「`standoffRange ≤ hitRange`」那条不变式仍全绿（它读的是 6.25）。
   * ⚠️ 又必须 ≥ `standoffRange` + 一步余量（5.4/60 = 0.09），否则追到环上既不走也不起手。
   */
  attackRange: 4.25,
  /**
   * 站定环半径（格）—— 守卫**主动保持**的与玩家水平距离。
   *
   * 语义与焰魔一致（进环即停、只转向；玩家主动贴上来时**站定不动**，不退让 ——
   * 用户裁定「巨大的存在应当挡住玩家」）。半径按守卫最短的一招（踩踏 4.5）收紧到 3.5。
   */
  standoffRange: 3.5,
  /**
   * 站定环死区半宽（格）。
   *
   * 必须 > 单帧位移（5.4/60 = 0.09），否则环边界振荡；
   * 且 `standoffRange − deadband`（2.75）必须 > 身体盒半宽 + 玩家半宽（1.55），
   * 否则「玩家碰得到它」这条不成立。
   */
  standoffDeadband: 0.75,
  /** 脱离追击距离（格）—— 与 `sightRange` 构成滞回 */
  disengageRange: 60,
  /** yaw 转向上限（弧度/秒） */
  turnRate: 3.0,
  /**
   * 两招之间的**空档下限**（秒）—— **从「本招动画播完」起算**，不是从命中帧起算。
   *
   * ## v3.10：语义从「命中间隔」改成「收势后空档」（用户 2026-11-17 裁定）
   *
   * 用户原文：「末影守卫的攻击时机太晚了，末影守卫移动到玩家身旁，应当立即展开攻击，
   * 而不是等几秒钟再开始攻击」。
   *
   * ⚠️⚠️ **旧语义（v2.91~v3.09）是「从命中帧起算 [5.0, 7.5]」**，而命中帧到动画结束
   * 还有一段收势（`animSeconds − hitFrameSeconds`，四招各不同：0.80~3.15s）
   * ⇒ 玩家看到的「两招之间站着不动」实测是 **3.45~6.70s 四种不同长度**；
   * 上一招刚打完就走回玩家身旁时，到位（进入 attackRange）后还要干等
   * **0~4.75s（中位 2.52s）**才起手 —— 同一份常量在四招上观感不统一，
   * 正是「数值看着对、手感不对」的形态。
   *
   * ⇒ 现在 `attackCooldown = 本招收势剩余 + [min, max]`，于是空档在四招上**恒等于**
   * [1.0, 1.5]，与招式长短无关。冷却字段本身仍从命中帧开始倒数（装配层无需改动），
   * 只是把收势那一段计进去了。实测修后：到位干等恒 **0s**（走 14 格需 1.81s > 空档上限），
   * 四招空档 **0.983~1.467s**，40 秒内出招从 5~7 次升到 8~11 次。
   *
   * ⚠️ **取值与焰魔 `IGNIS_AI.attackCooldownMin/Max` 同口径**（用户裁定）。
   * 单击伤害仍 16 不变 ⇒ 出招频率翻倍就是玩家 DPS 压力上升，属预期内的连带效应。
   *
   * ⚠️ **帧量子化：实测空档比常量短 1~2 帧**（0.983 / 1.150 / 1.333 / 1.467）——
   * 动画结束判据、冷却到期、减 step 补扣三个帧边界叠加所致。**不加取整补丁**
   * （焰魔 v3.07 试过 `ceil(tail*60)`，反而把「各招一致」弄坏），判据取 ±0.04s 容差。
   *
   * ⚠️ **旧不变式 `attackCooldownMin > attackAnimSeconds` 随之作废**：那条约束存在的理由是
   * 「冷却不能被收势吃掉」，而现在收势是**显式加数**，结构上不可能被吃掉。
   * 新的不变式只有一条：`attackCooldownMin > 0`（=0 就是无间隔连招）。
   */
  attackCooldownMin: 1.0,
  /**
   * 两招之间的空档上限（秒）⇒ 收势播完后随机等 [1.0, 1.5] 秒再起手。
   * ⚠️ 必须 > `attackCooldownMin`（相等就没有随机性，`rng` 两端的判据会失去判别力）。
   */
  attackCooldownMax: 1.5,
  /** 视线复查间隔（秒）= 10Hz，不每帧重查 */
  losInterval: 0.1,
  /** 重力（格/秒²），与丧尸/焰魔/玩家同口径 */
  gravity: -24,
  /**
   * 自动上台阶的最大抬升（格）。
   *
   * ⚠️⚠️ **取 1.0，不取原版 `maxUpStep 1.75F`** —— 已实测定案，不是待验证项：
   * `zombie-navigation.js` 的 `zombieStepUpY(y) = Math.floor(y + 0.01) + 1` **恒抬 1 格**，
   * `maxStep` 只做「抬升量 ≤ maxStep」的门控 ⇒ **1.75 与 1.0 逐位等价**
   * （实测 2 格高台阶下 `_tryStepUp` 与 `isWalkable` 两侧均 false）。
   * 写 1.75 只会得到一个看着生效实际无效的死值。
   *
   * 真要支持 >1 格台阶得改 `zombieStepUpY` 本身 —— 那是影响丧尸/焰魔/玩家三方的独立改动。
   */
  maxStep: 1.0,
  /** 寻路节流周期（秒） */
  navPeriod: 0.05,
  /** idle → chase 的重新锁定累计时长（秒）：玩家跑开几秒后才转身追 */
  turnDelay: 1.5,
  /** 卡住多久后触发脱困跳（秒） */
  stuckLeapSeconds: 4.0,
  /**
   * 棘轮式卡住判据的净位移阈（格）。
   *
   * ⚠️ 判据是「距上次确认有进展的锚点走开了多少」，**不看意图** ——
   * 「有意图但没走成」的旧判据在「意图恒为零」的卡死态下永不累计（焰魔 v2.63 真缺陷）。
   */
  stuckNetDist: 1.5,
  /** 被埋时向上解卡的最大抬升（格）；超过则放弃并原地不动 */
  stuckResolveMaxRaise: 16,
  /** 普通脱困跳的竖直初速（格/秒）⇒ 顶点 = 11²/(2×24) ≈ 2.52 格 */
  leapJumpForce: 11,
  /** 脱困跳的水平速度（格/秒） */
  leapSpeed: 8,
  /** 飞跃安全阀（秒）：超过则强制结束，防永久停在 leap 态 */
  leapMaxSeconds: 3.0,
  /** 前 N 次脱困跳用普通跳，第 N+1 次起升级强化跳 */
  escapeLeapEscalateAfter: 3,
  /**
   * 强化跳顶点下限（格）。
   *
   * ⚠️ 必须**严格 >** 普通跳顶点（2.52），否则「跳更高」静默失效。
   * ⚠️ 保底是必需的：被 4 格高围墙困住时玩家高差 ≈ 0，纯按高差算会得到与普通跳同高。
   */
  escapeLeapApexMin: 4,
  /**
   * 强化跳顶点上限（格）。
   *
   * ⚠️ 滞空 `2√(2H/g)` 必须显著 < `leapMaxSeconds`，否则那一跳被安全阀打断（白跳）。
   */
  escapeLeapApexMax: 8,
  /** 强化跳顶点的高差余量（格）：顶点 = clamp(max(Δy + margin, apexMin), apexMin, apexMax) */
  escapeLeapApexMargin: 1,
  /**
   * 「玩家还在上方」的容差（格）。
   *
   * 失败计数清零要叠加竖直判据：深坑底部往往很宽，坑里水平乱走 1.5 格也能刷满棘轮，
   * 只看净位移会让计数被反复清零 ⇒ 永远等不到强化跳。
   */
  escapeLevelTolerance: 2,
  /**
   * 玩家已**重叠**进身体盒的判定距离（格）—— 此时例外后退自愈。
   *
   * ⚠️⚠️ **按旋转后核心 OBB 的最大水平半宽算，不是碰撞盒半宽**：
   * 核心盒 halfExtents `[1.25, ·, 1.0313]` 绕 yaw 旋转后的最大轴对齐半宽 = **1.6205**
   * 再 + 玩家半宽 0.3 ⇒ 下界 1.9205，取 **1.95**。
   * 用 `GUARDIAN.halfWidth`（1.25）算会低估阈值，重现焰魔 v2.78 的「玩家冻在 Boss 身体里」软锁。
   */
  overlapEscapeDist: 1.95,
  /** 玩家位置感知间隔下限（秒）—— 用户裁定「最快 1 秒检测一次」 */
  senseIntervalMin: 1.0,
  /** 玩家位置感知间隔上限（秒） */
  senseIntervalMax: 2.0,
});

/**
 * 局部绕行的偏角档位 —— **必须与 `ZOMBIE_STEERING` 同值**。
 *
 * 这些是**角度**，与体形宽度无关（宽度通过 `aabbCollidesAt` 的 `halfWidth` 参数生效）。
 * 另标一套会让「两个地面实体绕同一堵墙时走出不同路径」。
 */
export const GUARDIAN_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
});

/**
 * 核心命中盒（**相对脚底**的 OBB，格）—— 烘焙产物核心四骨骼
 * （`lowerbody` / `upperbody` / `helmet` / `head`，共 6 盒）bind pose 包围盒的实测值。
 *
 * ⚠️ 与 `GUARDIAN.halfWidth/height`（碰撞盒）**语义不同**：碰撞盒服务物理，
 * 核心盒服务「剑砍得到哪里」。两者都要留着。
 * ⚠️ `center[2] = −0.4062` 非零 ⇒ 盒子**前后不对称**，绕 yaw 旋转时中心的 z 偏移要跟着转
 * （只转半长会让斜角命中判定偏移）。
 *
 * ⚠️⚠️ **`center[1]` 是「相对脚底」的量，随 `metrics.feetOffsetY` 移动**（Task 3 实测发现）：
 * 模型空间里核心盒中心在 y = 1.0938，而脚底在 −1.6243 ⇒ 相对脚底 = 1.0938 + 1.6243 = **2.7181**。
 * 改烘焙器/素材 ⇒ `feetOffsetY` 变 ⇒ **本值必须同步重算**，否则命中盒与画面错位。
 * （审阅期冻结的 2.5938 是按 feetOffsetY = 1.5 算的，已过期。）
 *
 * ⚠️ **盒顶 3.9368 > 碰撞盒高 3.8**：头盔与动画下沉共同造成，属素材真实几何（不是缺陷）。
 * 含义：剑能砍到略高于碰撞盒顶的头盔 —— 与焰魔同口径（那边也是独立实测盒）。
 */
export const GUARDIAN_CORE_OBB = Object.freeze({
  halfExtents: Object.freeze([1.2500, 1.2188, 1.0313]),
  center: Object.freeze([0.0000, 2.7181, -0.4062]),
});

/**
 * 上台阶的渲染缓动噪声门 —— 与 `IGNIS_STEP_LIFT` / `ZOMBIE_STEP_LIFT` 同值同依据。
 * 衰减参数仍在 `player/step-lift.js`，这里不写第二份。
 */
export const GUARDIAN_STEP_LIFT = Object.freeze({
  epsilon: 1e-4,
});

/**
 * 姿态衔接的淡入时长（秒）。
 *
 * ⚠️ **四招均用默认值，不引入焰魔旋斩那个 0.6s 特例**：必须 < **最短**命中帧
 * （上勾拳 1.35s），否则命中那一刻画面里还是没混完的站姿。
 */
export const GUARDIAN_POSE_BLEND = Object.freeze({
  seconds: 0.2,
});

/**
 * 程序化步态（v3.09）—— 渲染层与单测共用的唯一权威。
 *
 * 原版 `ModelEnder_Guardian.setupAnim`：四肢 `walkDegree×1.2 = 0.6 rad`、root `×0.2 = 0.1 rad`。
 * 用户 2026-11-16 裁定「稍微有一个踱步的动作」⇒ **两者都取原版一半**。
 *
 * ⚠️ **相位按移动距离推进，不按时间**：原版 `limbSwing` 由 `walkAnimation(distance)` 驱动。
 * 按 dt 推的形态是「撞墙 / 被玩家挡住时腿仍摆」（滑步），且步频与步幅随帧率脱钩。
 * `radiansPerBlock = 1.85` ⇒ 一步周期 2π/1.85 ≈ 3.40 格；chaseSpeed 5.4 格/秒 ⇒ **1.59 周期/秒**。
 * （原版 walkSpeed 0.5 配原版移速 0.27 格/tick 换算约 2.7 rad/格；本仓取 1.85 是观感标定值。）
 *
 * ⚠️ 四个字段都是**观感旋钮**，实玩觉得快/慢/大/小可微调；判据从常量派生 ⇒ 不用改断言。
 */
export const GUARDIAN_GAIT = Object.freeze({
  /** 四肢摆幅（rad）= 原版 0.6 的一半（用户裁定 ≈17°） */
  limbAmplitude: 0.3,
  /** root 起伏摆幅（rad）= 原版 0.1 的一半，保持原版 1:6 比例 */
  rootAmplitude: 0.05,
  /** 相位推进（rad/格）—— 一步周期 2π/1.85 ≈ 3.40 格 */
  radiansPerBlock: 1.85,
  /** 「在移动」的判定阈（与 `ZOMBIE_MOVING_EPSILON` 同值） */
  movingEpsilon: 0.001,
  /**
   * 「真的停下了」的宽限时长（秒）。
   *
   * ⚠️⚠️ **这一项是载荷性的，不得改成 0**（实测拓到的真缺陷）：
   * 物理是 **60Hz 固定步长 accumulator**，而渲染帧率与之不整除
   * ⇒ 移动中也有**近半数帧本帧没摊到物理步、位移为 0**
   *（实测：0.09 / 0 / 0.09 / 0 …交替）。若「位移 0 就立即归零相位」，
   * 腿永远在 0 ↔ sin(0.1665)×0.3 之间抖（峰值实测 **0.098** 而不是 0.3），
   * 观感是高频抖动而不是踱步。
   *
   * 取 0.15s：远大于一个物理步（1/60 = 0.0167）与常见帧间隔，
   * 又远小于人眼能读作「停下了还滑步」的时长。真撞墙 / 飞跃期贴近玩家时
   * 连续零位移超过它 ⇒ 相位归零、腿回 bind。
   */
  stopGraceSeconds: 0.15,
});

/**
 * 某个姿态源的淡入时长 —— 渲染器与测试共用的单一权威。
 * @param {string} _sourceKey 姿态源键（`idle` 或四档招式名）
 * @returns {number} 秒
 */
export function guardianBlendSeconds(_sourceKey) {
  return GUARDIAN_POSE_BLEND.seconds;
}