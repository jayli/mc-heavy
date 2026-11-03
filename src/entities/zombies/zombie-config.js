// src/entities/zombies/zombie-config.js — M6：丧尸冻结玩法数据（M6 规格 §1）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// 本文件是丧尸玩法数值的**唯一权威** —— 系统、渲染器、武器目录与测试都从这里派生，
// 不得各自写字面量（红线 1：同一事实的多个副本会漂移）。数值逐项对齐 mc-lite
// （`Zombie.js` / `ZombieInstancedRenderer.js` 实测读源，非推断）。

/** 丧尸玩法数据（M6 规格 §1 表格） */
export const ZOMBIE = Object.freeze({
  /** 默认活动上限（mc-lite 默认值）。未来 30/50 档须重新验收容量与性能，不得静默复用本容量 */
  maxActive: 20,
  /** 生命（临时 state，不存档） */
  health: 100,
  /** AABB 0.6×1.8×0.6，position 为脚底 */
  width: 0.6,
  height: 1.8,
  /** 追逐速度 1.2 格/秒（mc-lite `0.02 格/帧` × 60Hz） */
  speed: 1.2,
  /** 感知范围 80 格（保留为 type 数据；超过则 AI 输出 idle/零速度） */
  perceptionRange: 80,
  /** AI 预算门：距玩家超过 60 格不进 AI 批次（**只冻结意图，不是销毁半径**） */
  aiSleepDistance: 60,
  /** AI 周期 0.05 秒 = 20Hz（等价 mc-lite 60fps 下每 3 帧一次） */
  aiPeriod: 0.05,
});

/** 受伤红闪时长（ms）：M6 规格 §3 保留 mc-lite 的受伤反馈 */
export const ZOMBIE_FLASH_MS = 200;

/**
 * 实体间排斥参数（mc-lite `EnemyWorker.js:133-134` `calculateSeparationForce` 内部硬编码）。
 *
 * 作用：所有丧尸朝同一玩家追逐会收敛到同一点，没有排斥就叠成一坨（用户实玩报告）。
 * 排斥力在 **AI 层**算并叠加进 velocity（mc-lite 同口径 `:218-220`），经主线程物理推进 ——
 * 不在 manager 层直接推挤位置（那会新增一条绕过物理层的位置改写路径）。
 *
 * ⚠️ `minDistance: 1.2` 是 mc-lite 注释里的「略大于丧尸宽度」，**不是** `ZOMBIE.width`（0.6）
 * 的两倍 —— mc-lite 里它是独立硬编码常量。故**不得派生**成 `ZOMBIE.width * 2`：改 AABB 宽度
 * 会连带改排斥半径，那不是同一个事实（红线 1 精神）。
 */
export const ZOMBIE_SEPARATION = Object.freeze({
  /** 最小安全距离：水平距离小于此值才产生排斥力 */
  minDistance: 1.2,
  /**
   * 排斥强度：`force = (minDistance - distance) / minDistance × repulsionStrength`。
   *
   * ⚠️ **单位换算**：mc-lite 是 `0.05`，但那是**格/帧**单位 —— 它的 `predictNextPosition`
   * 不乘 dt（`nextX = position.x + velocityX`，`Zombie.js:302-305`）。mc-heavy 物理层乘 dt
   * （`moveAxis(state, world, velocity[0] * dt, ...)`）→ velocity 是**格/秒**，故须 ×60 换算
   * （与 `ZOMBIE.speed` 的 `0.02 格/帧 × 60Hz = 1.2` 同一口径）。
   * **不换算的后果实测**：排斥力只有追逐力的 4%（0.05/1.2），压不住收敛 → 24 只丧尸最小间距
   * 仍降到 0.003、21 对视觉重叠（与无排斥的对照组几乎相同）。换算后降到 0.439、1 对重叠。
   */
  repulsionStrength: 3.0,
});

/**
 * 步态常量（mc-lite `WALK_ANIMATION`：`speed: 10` / `legSwingAngle: Math.PI / 8`）。
 *
 * 驱动口径 = **按时间累积**（mc-lite `calculateWalkAnimation`：移动中 `_walkTime += deltaTime`，
 * 摆幅 `sin(_walkTime × speed) × legSwingAngle`，静止时 `_walkTime = 0` 归零而非冻结）。
 * 勿改成「按移动距离累积」—— 那是另一种手感，与 mc-lite 不一致。
 */
export const ZOMBIE_WALK_SPEED = 10;
export const ZOMBIE_SWING = Math.PI / 8;

/**
 * 「是否在移动」的判定阈值（mc-lite `calculateWalkAnimation` 与 `setDesiredVelocity` 同用 0.001）。
 *
 * **放在 config 而不是各层各写一份**（红线 1：同一事实的多个副本会漂移）。两个消费方都在用它，
 * 且必须同值 —— 若步态判定与朝向派生用不同阈值，会出现「腿在摆但朝向没跟上」或反之：
 * ① `zombie-renderer.js`（render 层）：步态相位累积的 moving 判定；
 * ② `zombie-system.js`（entities 同构层）：朝向派生的 moving 判定。
 * entities 层不得反向依赖 render，故常量必须落在两层都能 import 的 config 里。
 */
export const ZOMBIE_MOVING_EPSILON = 0.001;

/**
 * 手臂摆动的幅度（弧度）。
 *
 * 与原版一致的关系是「腿跨步 > 臂前后甩 > 头轻摆」—— 手臂挂在肩上、跨幅小于腿的
 * 髋部扫弧；过头会让丧尸走起来像在挥手。
 *
 * ⚠️ **必须小于 `ZOMBIE_SWING`（π/8）**（单测钉住）。数值是实玩标定值，与
 * `ZOMBIE_SWING` 的多轮调参同性质：先按原版比例取 π/12（15°），实玩觉得不自然再调。
 */
export const ZOMBIE_ARM_SWING = Math.PI / 12;

/**
 * 头部左右轻摆的幅度（弧度）。
 *
 * 与手臂的差别有两处：**幅度更小**（π/24 = 7.5°，头部惯性小、摆大了像抽搐），
 * 且**频率减半**（`sin(phase × 0.5)` —— 走一个完整步周期才摆一次，避免与腿同频抖动）。
 * 只在绕 Y 轴摆（左右晃），不低头不歪头（`rotation.x/z` 恒 0）。
 */
export const ZOMBIE_HEAD_SWAY = Math.PI / 24;

/**
 * 上台阶视觉缓动的配置（v2.39）。
 *
 * **背景**：`tryStepUp` 把脚底**一帧**抬到上一格整数面（物理必须瞬时 —— AABB 状态要精确），
 * 而渲染层若把 `state.position` 原样发布成实例平移，画面上就是**瞬移**（用户实玩报告）。
 * 下台阶没这问题，因为重力天然一帧一帧下落（实测 19 帧 / 283ms）。
 *
 * **修法只在渲染层**：`zombie-renderer.js` 复用玩家相机的 `StepLift`（`player/step-lift.js`）
 * 给整体 y 加 ease-out 滞后。物理 / 射线 / 存档一律不动。
 *
 * ⚠️ **不在这里重复衰减率 / 归零阈值 / 滞后上限**：那三份都在 `StepLift` 里（`DECAY_RATE=12`
 * → 190ms 到 10%、`CUTOFF=0.004`、`MAX_LAG=1.0`）。写第二份就是同一事实的第二个副本（红线 1），
 * 调参时会漂移成「玩家和丧尸的台阶缓动手感不一样」。
 */
export const ZOMBIE_STEP_LIFT = Object.freeze({
  /**
   * 上升判定的噪声门（格）：`dy > epsilon` 才当作一次上台阶。
   * **实测两侧都很远**：台阶抬升在 0.01~1.0 格；落地后与平地移动的物理 y **逐帧完全不变**
   * （实测 180 帧 `dy` 恒为 0）。故 1e-4 既不会把浮点噪声当台阶，也不会漏真实的抬升。
   * **不得放成 0.01 以上**：`tryStepUp` 在旧 y 已经贴整数面时抬升恰为 1.0，但斜蹭台阶边沿
   * 时 `oldY` 带小数 → 抬升量可以小到 0.01 量级（那也必须缓动，否则仍是瞬移）。
   */
  epsilon: 1e-4,
});

/**
 * 一格台阶上限（mc-lite `PHYSICS_CONFIG.MAX_STEP`，v2.40 从 `zombie-system.js` 的局部常量上移）。
 *
 * 物理的 `tryStepUp` 与避障探针共用这一份（红线 1：两份字面量会漂移成「探针以为能上台阶、
 * 物理抬不上去」→ 丧尸贴着台阶反复试探，静默且只能靠实玩发现）。
 */
export const ZOMBIE_MAX_STEP = 1.0;

/**
 * 局部避障参数（v2.40，用户裁定「贴身绕行即可」+「完全过不去时留在原地不追」）。
 *
 * `probeDistance = 1.2`（≈ 半宽 0.3 + 0.9 格行程）是**实玩标定值不是推导值**：嫌拐早/拐晚只改它。
 * ⚠️ 它现在**恰好等于** `ZOMBIE.speed`（1.2 格/秒 = 提前 1 秒）—— 那是巧合不是推导：
 * 若将来上调 `ZOMBIE.speed`（如 1.5），“提前约 1 秒”就不成立了，请同步看一眼这个值。
 *
 * `anglesDeg` 必须**升序**、且实现里每档「先 + 后 −」—— 否则取不到「能走通的最小偏角」，
 * 观感是丧尸在墙角大幅甩头。⚠️ 细档（22.5°）不是装饰：正前方一列墙的最小可通偏角是 45°
 * （几何：半宽 0.3 + 半格 0.5 需横向让开 0.8 格，`sinθ > 0.8/1.2 ⇒ θ > 41.8°`），
 * 但「斜擦」场景（探针落点横向恰好只压一列）22.5° 就够，少了它会直接跳到 45°。
 * ±90° 只在最后兜底沿墙蹭。
 */
export const ZOMBIE_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
});

/**
 * 在线 AI（Jev / TypeSafe System One）参数（spec §3.3 / §3.8 / §3.9）。
 *
 * ⚠️ **`windowSize = 9` 是实测标定值不是推导值**：7×7 与 11×11 在「长迷宫」地形上都会
 * 让模型 runaway（59 步不出），只有 9×9 在全部 5 个困难地形上通过（spec §2.5）。
 * ⚠️ **`endpoint` 不带 `?proxy=`**：实测直连 ~330ms，补 `?proxy=1087` 反而慢 10 倍。
 * ⚠️ **`decisionPeriodMs` 与 `timeoutMs` 是两个独立口径**：前者是「多久问一次」，
 * 后者是「一次最多等多久」。单次实测 330~800ms（中位 395），4000 只用于掐死挂住的请求。
 */
export const JEV_AI = Object.freeze({
  endpoint: 'https://js-perf.cn/typesafe/v1/systemone',
  /** 同一只丧尸两次决策的最小间隔（从上次**回包**算起，不是从发起算起） */
  decisionPeriodMs: 500,
  /** 同时在途的请求上限（超出排队） */
  maxConcurrent: 4,
  /** 单次请求超时（AbortController） */
  timeoutMs: 4000,
  /** 地面窗口边长（必须是奇数，保证丧尸在正中） */
  windowSize: 9,
  /** 连续失败多少次进入冷却 */
  maxFailures: 3,
  /** 冷却时长 */
  cooldownMs: 30000,
  /** 记忆里最多保留多少个「走过的格」 */
  maxVisits: 64,
  /** 记忆里最多保留多少步轨迹 */
  maxTrail: 12,
});
