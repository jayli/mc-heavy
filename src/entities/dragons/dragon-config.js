// src/entities/dragons/dragon-config.js — 祭坛飞龙（v2.41）冻结玩法数据的**唯一权威**
//
// 同构层：**无 DOM、无 three**（`npm run check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
// system / renderer / 测试都从这里派生，不得各自写字面量（红线 1）。
//
// 设计文档 `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（下称 spec）。
//
// ⚠️ 本文件**不 import 任何模块**：它是纯常量表。盘旋高度写成 `orbitYOffset`（相对
// `TARN_PLATEAU_Y` 的偏移）而不是绝对 y，由 `dragon-system.js` 在派生轨道时相加 ——
// 这样 config 保持零依赖，且「台地高度」的权威仍只在 tarn-zone.js 一处。

/** 实体类型名（`EntityManager.registerType` 与三处 predicate 共用） */
export const DRAGON_TYPE = 'dragon';

/**
 * 按「地图实例 + 槽位」派生实体 id（v2.43 Boss 召唤框架）。
 *
 * ⚠️ **取代 v2.41 的固定 `DRAGON_ENTITY_ID = 'dragon-altar'`**：龙现在可以在**任意**
 * 高台地带被召唤（用户裁定「按地图分别记槽位，可多条共存」），固定 id 会让
 * 「在 A 地带召了龙 → 走到 B 地带按 C」被 `EntityManager.spawn` 的撞 id 判据静默吃掉
 * （形态是「B 地带按 C 没反应」，而 A 的龙好好地在飞）。
 *
 * ⚠️ **派生而非自增序号**：id 是 `(mapKey, slot)` 的纯函数 ⇒ 同一张地图的同一个槽位
 * 恒同 id，「走远 column 卸载 → 回来重召」会复用同一个 id（幂等），不会攒出第二条。
 * 自增序号正是 v2.41 注释里警告过的那个坑。
 *
 * @param {string} mapKey `bossMapAt()` 返回的地图实例标识（如 `tarn:2:0`）
 * @param {number} slot 名册里的槽位下标（0 = Boss1，1 = Boss2）
 * @returns {string}
 */
export function dragonEntityIdFor(mapKey, slot) {
  return `dragon:${mapKey}:${slot}`;
}

/**
 * 同时存在的龙的上限（= 渲染池容量 = draw call 上限）。
 *
 * ⚠️ **这是 draw call 预算决策，不是玩法数值**：每条龙是一个独立 SkinnedMesh
 * （骨骼是 Object3D，无法像 InstancedMesh 那样合批）⇒ N 条龙 = N 个 draw call。
 * 4 是「玩家要亲自走到 4 个不同高台地带各按一次 C」才达得到的量，而 bench 场景 ④
 * 的 draw 基线是 586 ⇒ +4 = 0.68%，在噪声内。调大前须重测该基线。
 *
 * 超出时 `summon` 返回 `reason: 'limit'`（toast 提示），不静默丢弃。
 */
export const DRAGON_MAX_ALIVE = 4;

/**
 * 玩法数值。用户裁定见 spec §1。
 *
 * ⚠️ **`scale: 3` 与烘焙产物的 `metrics.scale` 是同一个事实**（`check:data` 的 `[龙]` 双向钉）。
 * 产物几何**已含**这一倍，运行时不再乘 —— 两处都乘会得到 9 倍。
 *
 * ⚠️ **`orbitRadius: 24` 是实测标定值，不是随手取的**（spec §6.2）：高台地带的 8 座高台
 * 最近格距圆心 **34.5**，而龙翼展 16.5 格 → 翼尖最远 `24 + 8.25 = 32.25 < 34.5`（余量 2.25 格）。
 * 调大轨道半径前必须重测这个净空，否则龙会穿进高台。
 *
 * ⚠️ **`orbitYOffset: 28` 是用户裁定「约 28 格高」**，且受武器射程约束：玩家站广场中心
 * （眼高 y=4.62）→ 斜距 33.9~36.0 格 < 步枪 `entityRange` 40（spec §6.2 实测表）。
 * 调高会让龙飞出射程，「可被武器击中」就名存实亡。
 */
export const DRAGON = Object.freeze({
  scale: 3,
  /** 生命。手枪 25 → 120 发；加特林 35 → 86 发；炮塔弹丸 34 → 89 发；MAG7 999 → 4 发 */
  health: 3000,
  orbitRadius: 24,
  /** 盘旋高度 = `TARN_PLATEAU_Y + orbitYOffset` = 2 + 28 = 30 */
  orbitYOffset: 28,
  /** 轨道线速度（格/秒）→ 周期 = 2π×24/6 ≈ 25 秒/圈 */
  orbitSpeed: 6,
  /** 竖直缓浮（纯观感）。⚠️ 调大会改变武器可达性（spec §6.2 的斜距表按 ±1.5 算） */
  bobAmplitude: 1.5,
  bobPeriod: 7,
  /** 盘旋内倾（渲染层消费，绕局部 Z 的 roll）。⚠️ 不得混进 yaw —— 那会改水平朝向 */
  bankRoll: 12 * Math.PI / 180,
  /** 受伤红闪时长（ms）。与 `ZOMBIE_FLASH_MS` 数值相同但**各自持有常量、不互相 import** */
  flashMs: 200,
});

/**
 * 轨道相位的随机 salt。
 *
 * ⚠️ **1040 是程序化扫描后的取值**（spec §6.1）：实测已占 1020~1027、1029~1039。
 * **1028 虽空闲但属被跳过的洞**（可能有历史原因），保守避开取 1040。
 * 用错 salt 是**静默的确定性污染**（两个系统共用随机流 → 相关，且单测全绿）。
 * 加新 salt 前必须重新扫描（含「带 `+ step`/`+ y` 偏移的区间式占用」，不能只 grep 字面量）。
 */
export const DRAGON_ORBIT_SALT = 1040;

/**
 * 身体核心的命中盒（**相对 `state.position` 的局部空间**，已含 3 倍，单位格）。
 *
 * 用户裁定「只算身体核心」（不含翅膀与尾巴）：实测 body+spine+neck+head+jaw 的模型空间
 * bbox = 12 × 20 × 51 px → 3 倍后 **2.25 × 3.75 × 9.5625 格**（spec §5.1）。
 *
 * ⚠️ **`center` 恒 `[0,0,0]`，因为 `state.position` 的语义就是「身体中心 = 轨道点」**
 * （spec §11 风险 3）。这也是炮塔索敌给龙传 `bodyOffsetY: 0` 的前提 —— 丧尸的 position 是
 * 脚底所以要 +1.2 抬到胸部，龙的 position 已经是身体中心，不需要偏移。
 *
 * ⚠️ **spec §5.1 原文把 `center` 写成了模型空间体心 `[0, 4.125, -2.53125]`，与它自己
 * §11「position = 身体中心」的裁定自相矛盾** —— 实施时按后者收敛（center 归零），
 * 模型空间体心另存为下面的 `DRAGON_MODEL_CENTER` 供渲染层摆放 mesh 用。两者语义不同：
 * 这个是「命中盒相对 position 的偏移」（恒 0），那个是「模型原点到体心的偏移」（非 0）。
 *
 * ⚠️ **AABB 必须按 `state.yaw` 现算**（`dragonAabbFor`）：龙在转向，固定盒会在龙横过来时
 * 漏判/误判。长轴 9.5625 vs 宽轴 2.25 差 4 倍多，不旋转的误差是肉眼可见的「打不中」。
 */
export const DRAGON_CORE_OBB = Object.freeze({
  halfExtents: Object.freeze([1.125, 1.875, 4.78125]),
  center: Object.freeze([0, 0, 0]),
});

/**
 * 模型空间里「身体核心 bbox 的中心」相对模型原点的偏移（已含 3 倍，单位格）。
 *
 * 实测：核心 bbox 在模型空间是 x[−6,6] y[12,32] z[−39,12] px → 中心 (0, 22, −13.5) px
 * → ×3/16 = **(0, 4.125, −2.53125)** 格。
 *
 * **渲染层专用**：几何顶点是模型空间坐标（模型原点≈脚底），而 `state.position` 是身体中心
 * ⇒ 渲染器把 mesh 局部偏移 `−DRAGON_MODEL_CENTER`（挂在 yaw 父节点下），体心就正好落在
 * `state.position`。**命中判定不用它**（用上面的 `DRAGON_CORE_OBB`）。
 */
export const DRAGON_MODEL_CENTER = Object.freeze([0, 4.125, -2.53125]);

/**
 * 动画状态机参数（用户裁定「fly + glide 交替」，spec §6.3）。
 *
 * 周期 12 秒 = fly 4.0 + 淡入 0.4 + glide 7.2 + 淡出 0.4。
 * ⚠️ **四段之和必须精确等于 `cycleSeconds`**（`dragonAnimStateAt` 按此分段；不等会让
 * 末段溢出或留空洞）。改任一个值都要重算 cycleSeconds。
 *
 * ⚠️ 这里的秒数是**状态机时长**，与素材动画自身时长（fly 1.2s / glide 3.0s）是两件事：
 * 素材动画在状态机段内**循环播放**（渲染层按 `frameCount/fps` 取模），故 fly 段 4 秒里
 * 素材的 1.2 秒拍翅循环约 3.3 次。
 */
export const DRAGON_ANIM = Object.freeze({
  cycleSeconds: 12,
  flySeconds: 4.0,
  glideSeconds: 7.2,
  blendSeconds: 0.4,
});

/**
 * 飞龙 AI 数值（v2.44，spec §11）。**唯一权威在此** —— Agent / 单测 / E2E 都从这里派生。
 *
 * ## 用户裁定的四项（2026-11-03）
 *
 * - `sightRange = 60`：发现距离。略大于步枪 `entityRange` 40 ⇒ 飞龙先手，玩家得先挨近才能反击。
 * - `fireCooldownMin/Max = 5/10`：开火间隔**随机 5~10 秒**（用户原话「不能像机关枪一样连续发射，
 *   要至少间隔五到十秒」）。⚠️ 随机数走可注入的 `rng`（默认 `Math.random`）—— 测试钉区间两端。
 * - 攻击高度**固定 y = `orbit.y`**（= 30）：用户裁定「飞向玩家时依然在半高的高空盘旋」。
 *   故 chase/attack 都**不俯冲不爬升**，`playerAimOffsetY` 只用于瞄准点，不改龙的高度。
 * - 火球速度 15 格/秒（在 `FIREBALL` 里）。
 *
 * ## 我自己标定的（用户未指定，实玩后可调）
 *
 * - `chaseSpeed = 9`：略快于玩家跑步 `SPEED = 8` ⇒ 玩家跑不掉但能周旋。调大就成了「必中」。
 * - `disengageDistance = 78`（= sightRange × 1.3）：**滞回**。若脱离阈值也取 60，玩家在 60 格
 *   边界附近走动会让龙在 chase/orbit 之间每帧抖动（形态是「龙原地抽搐」）。
 * - `flyoverDistance = 6` / `turnAroundDistance = 22`：飞跃触发距离与飞跃后外飞距离。
 *   外飞 22 格 ≈ 2.4 秒，给玩家留出「看着龙飞远再掉头回来」的节奏。
 * - `fireConeDeg = 20`：喷火锥半角。用户要求「脑袋冲着玩家发射」—— 20° 是「大致对准」的口径，
 *   取 0 会因为 yaw 平滑插值而几乎永不满足（龙永远喷不出火）。
 * - `turnRate = 3.0` rad/秒：yaw 平滑转向速率。约 172°/秒 ⇒ 掉头（180°）约 1 秒。
 * - `wobbleAmp = 5` / `wobbleFreq = 3`：盘旋半径调制（用户「可以左右拐弯，免得绕圈太固定显得单调」）。
 *   ⚠️ **`wobbleAmp` 会改变翼尖净空**：`orbitRadius 24 + wobbleAmp 5 + 半翼展 8.25 = 37.25`，
 *   而高台最近格距圆心 **34.5** ⇒ 调制到最外时翼尖会扫过高台边缘 2.75 格。
 *   龙不碰撞方块（spec §10 取舍 3），故只是视觉擦过；**调大 `wobbleAmp` 前须重测这个净空**。
 * - `losInterval = 0.1`：视线缓存周期（10Hz）。60 格 LOS 每帧全查 × 多条龙太贵（红线 3）。
 *   ⚠️ **开火瞬间必须做一次新鲜复查**，不能用这个缓存（否则隔着墙喷火）。
 * - `playerAimOffsetY = 1.0`：玩家胸部（视线终点 + 火球瞄准点）。玩家 `position` 是脚底，
 *   身高 1.8 ⇒ 1.0 ≈ 胸。与炮塔打丧尸的 `enemyBodyOffsetY`（1.2）同一思路。
 */
export const DRAGON_AI = Object.freeze({
  /** 发现距离（水平，格）：视线通 + 水平距 ≤ 此值 → 追击 */
  sightRange: 60,
  /** 追击/攻击的水平速度（格/秒） */
  chaseSpeed: 9,
  /** chase → attack 的水平距离（格） */
  attackRange: 20,
  /** 飞跃触发距离（格）：approach 递近到此值就飞过玩家头顶 */
  flyoverDistance: 6,
  /** 飞跃后向外飞多远才掉头（格） */
  turnAroundDistance: 22,
  /** 脱离距离（格）：> sightRange 的滞回上界，防边界抖动 */
  disengageDistance: 78,
  /** 喷火锥半角（度）：yaw 与「指向玩家」的夹角 ≤ 此值才算「脑袋冲着玩家」 */
  fireConeDeg: 20,
  /** 开火间隔下限（秒） */
  fireCooldownMin: 5,
  /** 开火间隔上限（秒） */
  fireCooldownMax: 10,
  /** 开火最大水平距离（格）：太远不浪费火球 */
  fireRange: 60,
  /** yaw 平滑转向速率（rad/秒） */
  turnRate: 3.0,
  /** 盘旋半径调制振幅（格） */
  wobbleAmp: 5,
  /** 盘旋半径调制频率（每圈起伏次数） */
  wobbleFreq: 3,
  /** 视线缓存周期（秒） */
  losInterval: 0.1,
  /** 玩家胸部相对脚底 position 的 y 偏移（视线终点 + 火球瞄准点） */
  playerAimOffsetY: 1.0,
});
