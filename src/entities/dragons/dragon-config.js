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
