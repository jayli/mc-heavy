// tests/enemy-roster.mjs — 敌人/Boss 接线完整性门的**名册**（只被测试消费）
//
// 设计稿：docs/superpowers/specs/2026-11-23-enemy-wiring-completeness-gate-design.md
//
// ## 为什么在 tests/ 而不在 src/entities/
//
// `src/entities/**` 是 Worker 同构层（红线 8/10），当前**零 render/ 依赖**；而死亡音的
// 权威在 `render/audio-config.js`。表若建在 entities/ 并读它，就新开一条
// `entities → render` 反向边 —— 而 `check-architecture.mjs` 的 LAYER_ORDER 只含
// [voxel,gen,mesh,render]，**entities 不在其中 ⇒ 方向门直接跳过、抓不到**；
// three 隔离门只查本文件 import，间接依赖也抓不到。world-worker.js import 了
// zombie-system.js，链路接上会把 three 拉进 Worker（白屏）。故表放测试侧。
//
// ## 期望值必须独立派生（反目标：第二套语义）
//
// 一律从各 config 的常量算出，**禁止 import game.js 的公式或抄它的三元链** ——
// 抄一份就是「对照脚本与被测代码共享同一个错误假设」，会得出「两者一致」的假结论。
import { ZOMBIE } from '../src/entities/zombies/zombie-config.js';
import { IGNIS } from '../src/entities/ignis/ignis-config.js';
import { GUARDIAN } from '../src/entities/guardian/guardian-config.js';
import { SOLDIER } from '../src/entities/soldiers/soldier-config.js';
import { DRAGON_CORE_OBB } from '../src/entities/dragons/dragon-config.js';
import { TURRET } from '../src/entities/turrets/turret-config.js';
import { EXPLOSION_DAMAGE_RADIUS } from '../src/voxel/explosion.js';
import { BOSS_HIT_SOUND } from '../src/render/audio-config.js';

/**
 * 每个可击中类型的「必须接线项」登记。
 *
 * ⚠️ **`semantics` 是三个 Y 口径的唯一输入**（spec §4.2 实测）：
 *   · `feet`   —— state.position 是脚底 ⇒ 中心 = y + height/2、头顶 = y + height
 *   · `center` —— state.position 已是身体中心 ⇒ 中心 = y、头顶 = y + coreHalfY
 * 三个脚底类型满足「头顶 = 2×中心」，**龙不满足**（0 vs 1.875）⇒ 不能合成单一
 * bodyOffsetY 字段，否则龙那两支会被静默改错。
 *
 * ⚠️ **`aimOffsetY` 与身高无关**：炮塔瞄准缺省取 `TURRET.enemyBodyOffsetY`（1.2，
 * mc-lite ENEMY_BODY_OFFSET_Y 的胸部常量），龙显式传 0（position 已是体心）。
 *
 * ⚠️ **`boss` 字段是必需的判据，不是装饰**：`game.js` 的 `bossAlive` 只求和三个 Boss，
 * **丧尸在场不触发战斗 BGM**。合并循环时若遍历全表，丧尸会把 Boss 曲拉起来 = 玩法变更。
 *
 * ⚠️ **`burst: false`（龙）是刻意不做爆散**（用户未要求），**不是遗漏** ——
 * 与 boss-registry.js 刻意不为无 Boss 地图写空数组同一手法。
 *
 * ⚠️ **`blocksPlayer`**：只有焰魔/守卫的身体盒阻挡玩家（physics.js 的 `_collides`），
 * 丧尸不阻挡是实测现状（physics.js 里零 zombie 盒判定）。
 */
export const ENEMY_ROSTER = Object.freeze({
  zombie: Object.freeze({
    service: 'zombies', semantics: 'feet', height: ZOMBIE.height,
    boss: false, blocksPlayer: false, deathSound: 'z_die', burst: true,
  }),
  dragon: Object.freeze({
    service: 'dragons', semantics: 'center', coreHalfY: DRAGON_CORE_OBB.halfExtents[1],
    aimOffsetY: 0,
    boss: true, blocksPlayer: false, deathSound: 'ignis_die', burst: false,
  }),
  ignis: Object.freeze({
    service: 'ignises', semantics: 'feet', height: IGNIS.height,
    boss: true, blocksPlayer: true, deathSound: 'ignis_die', burst: true,
    hitSound: BOSS_HIT_SOUND,
  }),
  guardian: Object.freeze({
    service: 'guardians', semantics: 'feet', height: GUARDIAN.height,
    boss: true, blocksPlayer: true, deathSound: 'guardian_die', burst: true,
    hitSound: BOSS_HIT_SOUND,
  }),
  /**
   * 士兵（士兵 Epic）。三条刻意登记：
   * · `boss: false` —— 士兵在场**不得**拉起 Boss 战 BGM（与丧尸同）；
   * · `blocksPlayer: false` —— 10 个士兵在 8~20 格环上游走，若都是实心盒会把玩家围住（与丧尸同）；
   * · `deathSound: 'z_die'` —— 用户裁定本轮不做士兵专属音效，复用既有素材（近似替代，不是原音）。
   */
  soldier: Object.freeze({
    service: 'soldiers', semantics: 'feet', height: SOLDIER.height,
    boss: false, blocksPlayer: false, deathSound: 'z_die', burst: true,
  }),
});

/**
 * 取登记项。**未登记类型必须 throw，不静默返回 0** ——
 * 静默兜底会让「名册漏登记」退化成「按龙的口径算」，正是本门要防的静默失效。
 */
function entryOf(type) {
  const e = ENEMY_ROSTER[type];
  if (!e) throw new Error(`未登记的敌人类型: ${type}（名册漏登记 ⇒ 接线门会静默跳过它）`);
  return e;
}

/** 身体中心相对 state.position.y 的偏移（爆散锚点 / 溅射判定中心用）。 */
export function bodyCenterOffset(type) {
  const e = entryOf(type);
  return e.semantics === 'feet' ? e.height / 2 : 0;
}

/** 头顶相对 state.position.y 的偏移（伤害数字锚点用）。 */
export function headTopOffset(type) {
  const e = entryOf(type);
  return e.semantics === 'feet' ? e.height : e.coreHalfY;
}

/** 炮塔瞄准点相对 state.position.y 的偏移（缺省 = 胸部常量，与身高无关）。 */
export function aimOffset(type) {
  const e = entryOf(type);
  return e.aimOffsetY ?? TURRET.enemyBodyOffsetY;
}

/**
 * 溅射判别的**边界水平距离**（spec §7.2，本表唯一需要算法的函数）。
 *
 * ⚠️⚠️ **朴素写法恒真，实测过**：爆心放在实体正上方 h/2 处时，漏改（中心落 0）
 * 的 dist = h/2，而 zombie 0.9 / ignis 1.625 / guardian 1.9 **全部仍在半径 4 内**
 * ⇒ 漏改也扣血 ⇒ 判据零判别力。
 *
 * 正解：加水平偏移 r，使
 *   · 正确实现 dist = r ≤ R（在半径内 ⇒ 扣血）
 *   · 漏改     dist = sqrt(r² + c²) > R（超半径 ⇒ 不扣血）
 * 即 r ∈ (sqrt(R²−c²), R]，取中点。
 *
 * ⚠️ **体心语义（龙）无判别力**：c=0 ⇒ lo=R ⇒ 中点=R ⇒ hypot(R,0)=R 不 >R。
 * 龙的 half 分支本就返回 0，漏改与正确行为一致 ⇒ 消费方须排除 center 语义，
 * 那是刻意排除而不是遗漏。
 */
export function blastEdgeRadius(type) {
  const c = bodyCenterOffset(type);
  const R = EXPLOSION_DAMAGE_RADIUS;
  const lo = Math.sqrt(R * R - c * c);
  return (lo + R) / 2;
}