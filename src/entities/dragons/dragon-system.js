// src/entities/dragons/dragon-system.js — 祭坛飞龙（v2.41，v2.43 改为按需召唤）：
// 轨道/动画/AABB 纯函数 + definition + service
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
// 渲染层（`src/render/dragon-renderer.js`）只读本文件产出的 pose，不回写 state、不参与命中
// （命中唯一真相 = `dragonDefinition.raycastAabb`，红线 6）。
//
// 设计文档 `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（下称 spec）。
//
// ⚠️ **龙是「景观实体」而不是玩家资产**：位置是 `(seed, 时间)` 的纯函数，**不进存档**
// （红线 2）。故用 `persistent: false` spawn。
//
// ## v2.43 的三项语义变更（Boss 召唤框架）
//
// 1. **不再自动生成**：v2.41 的 `ensure()` 每帧跑、走到祭坛地带龙就在那儿。现在只有
//    按 C 才召唤（`summon()`）—— 否则「Boss1 已在 → 召唤 Boss2」永远命中「已在」。
// 2. **不再绑定祭坛地带**：轨道中心 = 召唤时玩家所在的那个高台地带圆心（动态传入）。
// 3. **去掉永久死亡**：v2.41 的 `meta.dragonDead` 已删 —— 用户裁定「只有 Boss 死掉后，
//    再按 C 才会召唤出 Boss」，即死后可重召。死亡标记失去作用（按 YAGNI 移除，
//    而不是改造成「按地带分别记」）。
//
// ⚠️ **已知取舍（用户 2026-11-03 接受）**：临时实体 + column 卸载回收 ⇒ 玩家走远、
// 地带中心 column 卸载时龙被回收、槽位清空，回来要重新按 C。
import { raycastAabbSlab, normalizePosition } from '../entity-types.js';
import { TARN_PLATEAU_Y } from '../../gen/structures/tarn-zone.js';
import { seededRandom } from '../../gen/noise.js';
import { DragonBossAgent } from '../bosses/dragon-boss-agent.js';
import {
  DRAGON, DRAGON_TYPE, DRAGON_MAX_ALIVE, DRAGON_ORBIT_SALT, DRAGON_CORE_OBB, DRAGON_ANIM,
  DRAGON_AI, dragonEntityIdFor,
} from './dragon-config.js';

// ==================== 纯函数 ====================

/**
 * 轨道 pose（spec §6.1；v2.44 加半径调制）。
 *
 * ⚠️ **`yaw = π − θ`，不是 spec §6.1 原文写的 `θ + π/2`** —— 原文那式子算出的前向与轨道
 * 切线**垂直**（龙会侧着身子飞）。推导：轨道切线 = `(−sin θ, cos θ)`（对 `x=cx+R cos θ`、
 * `z=cz+R sin θ` 求导），而本仓的 yaw→前向口径是 `(−sin yaw, −cos yaw)`（AGENTS.md
 * 「出生朝向与相机旋转的测量口径」表，源自 `camera.rotateY(yaw)`）。令两者相等：
 * `sin yaw = sin θ` 且 `cos yaw = −cos θ` ⇒ `yaw = π − θ`。
 * 判据落在 `test-dragon-system.js` 的「yaw 是切线方向」（点积 > 0.99），改公式必红。
 *
 * ## v2.44 的半径调制（用户：「可以左右拐弯，免得绕圈太固定显得单调」）
 *
 * `R(θ) = radius + wobbleAmp × sin(wobbleFreq × θ + wobblePhase)`，每圈起伏 `wobbleFreq` 次。
 *
 * ⚠️ **`wobbleAmp` 缺省 0 时必须走旧公式 `yaw = π − θ`，不得用解析切线**（实测裁定）：
 * 调制路径的切线是 `atan2(−dR/dθ·cos θ + R sin θ, −dR/dθ·sin θ − R cos θ)`，它在 A=0 时
 * 与 `π − θ` **数值等价但不逐位相等**（20000 采样里 15244 个不等，最大偏差 2π = 角度表示
 * 差异）。既有断言钉的是逐位相等 ⇒ 必须显式分支，否则「零回归」假失败。
 *
 * @param {{cx:number, cz:number, y:number, radius:number, omega:number, phase:number,
 *          wobbleAmp?:number, wobbleFreq?:number, wobblePhase?:number}} orbit
 * @param {number} t 轨道时钟（秒）
 * @returns {{position: [number,number,number], yaw: number}}
 */
export function dragonPoseAt(orbit, t) {
  const theta = orbit.phase + orbit.omega * t;
  const amp = Number.isFinite(orbit.wobbleAmp) ? orbit.wobbleAmp : 0;
  let x;
  let z;
  let yaw;
  if (amp === 0) {
    // 旧路径：逐位兼容 v2.41~v2.43（既有断言钉死）
    x = orbit.cx + orbit.radius * Math.cos(theta);
    z = orbit.cz + orbit.radius * Math.sin(theta);
    yaw = Math.PI - theta;
  } else {
    const freq = Number.isFinite(orbit.wobbleFreq) ? orbit.wobbleFreq : DRAGON_AI.wobbleFreq;
    const ph = Number.isFinite(orbit.wobblePhase) ? orbit.wobblePhase : 0;
    const w = freq * theta + ph;
    const R = orbit.radius + amp * Math.sin(w);
    // dR/dθ（调制路径的切线要用它）
    const dR = amp * freq * Math.cos(w);
    x = orbit.cx + R * Math.cos(theta);
    z = orbit.cz + R * Math.sin(theta);
    // 路径切线 = (dx/dθ, dz/dθ)；本仓 yaw 口径要求前向 (−sin yaw, −cos yaw) 与之同向
    // ⇒ yaw = atan2(−dx/dθ, −dz/dθ)
    const dx = dR * Math.cos(theta) - R * Math.sin(theta);
    const dz = dR * Math.sin(theta) + R * Math.cos(theta);
    yaw = Math.atan2(-dx, -dz);
  }
  const y = orbit.y + DRAGON.bobAmplitude * Math.sin((2 * Math.PI * t) / DRAGON.bobPeriod);
  return { position: [x, y, z], yaw };
}

/**
 * 动画状态机（spec §6.3）：fly 4.0s → 淡入 0.4s → glide 7.2s → 淡出 0.4s，周期 12s。
 *
 * ⚠️ **`primaryTime`/`secondaryTime` 都取周期内时刻 `tc`**（不是「段内相对时刻」）：
 * 素材动画自身时长（fly 1.2s / glide 3.0s）远短于状态机段长，渲染层采样时按
 * `frameCount/fps` 取模自动循环。用 `tc` 让两个动画在段边界处**连续**（切换瞬间采样时刻
 * 不跳变），改成段内相对时刻反而会在边界产生跳帧。
 *
 * @param {number} t 轨道时钟（秒，与 `dragonPoseAt` 同源）
 * @returns {{primary:'fly'|'glide', secondary:'fly'|'glide'|null, blend:number,
 *            primaryTime:number, secondaryTime:number}}
 */
export function dragonAnimStateAt(t) {
  const A = DRAGON_ANIM;
  const cycle = A.cycleSeconds;
  // 非负取模：t 为负时 JS 的 % 返回负值（AGENTS.md「坐标类判据一律用非负取模」同源陷阱）。
  // ⚠️ **只加一次 cycle，不做双重取模**：实测 `((4.4 % 12) + 12) % 12 = 4.3999999999999986`
  // （IEEE754 舍入）→ 恰好落在段边界上的时刻会掉进前一段（fly/glide 切换错帧）。
  const m = t % cycle;
  const tc = m < 0 ? m + cycle : m;
  const flyEnd = A.flySeconds;
  const blendInEnd = flyEnd + A.blendSeconds;
  const glideEnd = blendInEnd + A.glideSeconds;
  if (tc < flyEnd) {
    return { primary: 'fly', secondary: null, blend: 0, primaryTime: tc, secondaryTime: 0 };
  }
  if (tc < blendInEnd) {
    return {
      primary: 'fly', secondary: 'glide', blend: (tc - flyEnd) / A.blendSeconds,
      primaryTime: tc, secondaryTime: tc,
    };
  }
  if (tc < glideEnd) {
    return { primary: 'glide', secondary: null, blend: 0, primaryTime: tc, secondaryTime: 0 };
  }
  return {
    primary: 'glide', secondary: 'fly', blend: (tc - glideEnd) / A.blendSeconds,
    primaryTime: tc, secondaryTime: tc,
  };
}

/**
 * 身体核心 OBB 绕 `state.yaw` 旋转后的**轴对齐**包围盒。
 *
 * ⚠️ **返回的是「相对 `state.position` 的局部盒」**，不是世界盒 —— `raycastAabbSlab`
 * （`entity-types.js`）内部会做 `lo = aabb.min[axis] + position[axis]`。返回世界盒会让
 * position 被**加两次**（实测形态：y 方向的盒整体抬高一倍 → 水平射线永远打不中，
 * 而「盒尺寸」类断言全绿，因为尺寸不受平移影响）。
 *
 * ⚠️ **必须按 yaw 现算**：核心盒长轴 9.5625 vs 宽轴 2.25（差 4 倍多），龙在转向，
 * 用固定盒会在龙横过来时漏判/误判（「明明打中了却没掉血」）。
 *
 * ⚠️ 旋转用 three 的 Y 轴约定（`x' = x cosθ + z sinθ`、`z' = −x sinθ + z cosθ`）——
 * 与渲染层 `mesh.rotation.y = yaw` 同一口径。两处不同源会让「看到的龙」与「能打中的盒」错开。
 *
 * @param {{position:[number,number,number], yaw:number}} state
 * @returns {{min:number[], max:number[]}} 局部盒（调用方加 position 得世界盒）
 */
export function dragonAabbFor(state) {
  const h = DRAGON_CORE_OBB.halfExtents;
  const c = DRAGON_CORE_OBB.center;
  const cos = Math.cos(state.yaw), sin = Math.sin(state.yaw);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const lx = c[0] + sx * h[0];
        const ly = c[1] + sy * h[1];
        const lz = c[2] + sz * h[2];
        const rx = lx * cos + lz * sin;
        const ry = ly;
        const rz = -lx * sin + lz * cos;
        if (rx < min[0]) min[0] = rx;
        if (ry < min[1]) min[1] = ry;
        if (rz < min[2]) min[2] = rz;
        if (rx > max[0]) max[0] = rx;
        if (ry > max[1]) max[1] = ry;
        if (rz > max[2]) max[2] = rz;
      }
    }
  }
  return { min, max };
}

// ==================== state 构造 ====================

/**
 * 轨道参数的合法性校验（6 个核心字段全须有限；wobble 三项可选，缺省 = 无调制）。
 * @returns {object|null} 冻结的 orbit，非法返回 null
 */
function normalizeOrbit(orbit) {
  if (!orbit || typeof orbit !== 'object') return null;
  const keys = ['cx', 'cz', 'y', 'radius', 'omega', 'phase'];
  for (const k of keys) if (!Number.isFinite(orbit[k])) return null;
  const out = { cx: orbit.cx, cz: orbit.cz, y: orbit.y, radius: orbit.radius, omega: orbit.omega, phase: orbit.phase };
  // wobble 三项：给了就必须有限，缺省 = 0（`dragonPoseAt` 对 amp=0 走旧公式，逐位兼容）
  for (const k of ['wobbleAmp', 'wobbleFreq', 'wobblePhase']) {
    if (orbit[k] !== undefined) {
      if (!Number.isFinite(orbit[k])) return null;
      out[k] = orbit[k];
    }
  }
  return Object.freeze(out);
}

/**
 * 构造全新 state（**不原地改写** —— M5 不变式：`EntityManager.update` 的跨 column 索引迁移
 * 判据是「赋值前 position vs 赋值后 position」，原地改写会让 before/after 从同一份算出
 * → 恒相等 → 索引永不迁移 → column 卸载漏回收实体）。
 *
 * v2.44 起新增 AI 字段（全部有缺省，旧调用不破）：mode / attackPhase / fireCooldown /
 * losTimer / losVisible / turnDist / fireRequest。
 */
function createState({
  position, yaw, orbit, orbitT, health, flashedUntil,
  mode, attackPhase, fireCooldown, losTimer, losVisible, turnDist, fireRequest,
}) {
  const p = normalizePosition(position);
  const o = normalizeOrbit(orbit);
  if (!p || !o) return null;
  return {
    position: p,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    orbit: o,
    orbitT: Number.isFinite(orbitT) ? orbitT : 0,
    health: Number.isFinite(health) ? health : DRAGON.health,
    flashedUntil: Number.isFinite(flashedUntil) ? flashedUntil : 0,
    // ---- v2.44 AI 字段（缺省 = 盘旋态）----
    mode: mode === 'chase' || mode === 'attack' || mode === 'return' ? mode : 'orbit',
    attackPhase: attackPhase === 'turn' ? 'turn' : 'approach',
    fireCooldown: Number.isFinite(fireCooldown) ? fireCooldown : 0,
    losTimer: Number.isFinite(losTimer) ? losTimer : 0,
    losVisible: losVisible === true,
    turnDist: Number.isFinite(turnDist) ? turnDist : 0,
    // ⚠️ **瞬态**：serialize 跳过；由 game.js 在 entities.update 之后消费（生成火球）
    fireRequest: fireRequest || null,
  };
}

// ==================== definition ====================

/**
 * 模块级单例 AI（无跨帧成员，多龙共用安全）。poseAt 注入本文件的 `dragonPoseAt`
 * （轨道唯一权威）—— Agent 不 import 本文件，避免环。
 */
const dragonAgent = new DragonBossAgent({ poseAt: dragonPoseAt });

/**
 * 龙的 M5 definition。
 *
 * ⚠️ **v2.44 起 `update` 委托给 `DragonBossAgent`**（用户的解耦指令：行为决策抽成独立
 * 智能体类）。无玩家上下文（ctx 缺 player）时 Agent 只盘旋 —— 与 v2.41~v2.43 的景观行为
 * 逐位一致（`test-dragon-system.js` 的「update 无玩家上下文时仍走轨道」钉住）。
 */
export const dragonDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  /**
   * 委托 AI 推进一帧，返回值经 `createState` 包裹（校验 + 冻结 orbit）。
   * @returns {object} 全新 state（含全新 position 数组）
   */
  update(entity, dt, context) {
    const next = dragonAgent.update(entity.state, dt, context || {});
    if (!next) return null;
    return createState(next);
  },

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, dragonAabbFor(state)),

  /**
   * 临时实体不走存档，最小 snapshot（保留 orbitT 以便调试/未来持久化）。
   *
   * ⚠️ **`fireRequest` 刻意不进 snapshot**（瞬态）：它是「本帧要开火」的意图，由 game.js
   * 在 `entities.update` 之后立即消费。写进快照的形态是「陈旧请求复活」—— 若将来龙改成
   * 持久化，重启后会凭空喷一发火球（且 snapshot 里攒一堆无人消费的请求）。
   */
  serialize(state) {
    if (!state) return null;
    const p = normalizePosition(state.position);
    if (!p) return null;
    return { position: p, yaw: state.yaw, orbitT: state.orbitT, health: state.health };
  },

  /**
   * 反序列化。⚠️ **AI 字段一律回缺省（orbit 态）**：snapshot 不含 mode/冷却等，回来就是
   * 「重新开始盘旋」—— 临时实体本就不走存档，这是可接受的语义。
   * ⚠️ **`fireRequest` 必须显式为 `null`**（不是 undefined）：消费方判 `!== null`，
   * undefined 会被当成「有请求」而解构报错。
   */
  deserialize(raw) {
    if (!raw) return null;
    const p = normalizePosition(raw.position);
    if (!p) return null;
    return {
      position: p,
      yaw: Number.isFinite(raw.yaw) ? raw.yaw : 0,
      orbitT: Number.isFinite(raw.orbitT) ? raw.orbitT : 0,
      health: Number.isFinite(raw.health) ? raw.health : DRAGON.health,
      mode: 'orbit',
      attackPhase: 'approach',
      fireCooldown: 0,
      losTimer: 0,
      losVisible: false,
      turnDist: 0,
      fireRequest: null,
    };
  },
});

// ==================== service ====================

/**
 * 龙的玩法入口（形状对齐 `ZombieService`：spawn 编排 / damage / 只读查询）。
 *
 * ⚠️ **不 import three、不 import DOM**（同构层）。
 *
 * ## v2.43 起的接口（Boss 召唤框架）
 *
 * - `summon(mapKey, cx, cz, slot)`：在指定地图中心召唤一条龙（取代 v2.41 的 `ensure()`）；
 * - `activeEntities()`：全部存活的龙（渲染器与炮塔目标集合消费，取代单实例 `active()`）；
 * - `damage(id, …)`：不变（死亡即 despawn，**不再有永久死亡标记**）。
 */
export class DragonService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager, seed: number}} deps
   */
  constructor({ entities, seed }) {
    this.entities = entities;
    this.seed = seed;
  }

  /**
   * 在指定地图中心召唤一条龙（按 C 的唯一入口，v2.43）。
   *
   * ⚠️ **轨道中心是参数，不是「祭坛地带」**：v2.41 的龙硬绑定 `findAltarTarnRegion`，
   * 现在玩家站在哪个高台地带，龙就在哪个地带的圆心盘旋（用户裁定）。
   * `findAltarTarnRegion` 的 12.6ms 冷调用问题也随之消失（不再需要 `warm()`）。
   *
   * ⚠️ **不检查 column 是否加载**：龙是纯景观实体（不碰撞、不寻路、不受重力），
   * 在未加载区盘旋无害 —— 玩家召了它却因 column 未就绪而「没反应」才是坏体验。
   * （v2.41 的 hasColumn 门控是为了「自动生成时不放玩家看不见的实体」，召唤语义下不成立。）
   *
   * @param {string} mapKey 地图实例标识（`bossMapAt().key`，如 `tarn:2:0`）
   * @param {number} cx @param {number} cz 地图中心（Boss 的盘旋圆心）
   * @param {number} slot 名册槽位（0 = Boss1）
   * @returns {{ok: true, id: string} | {ok: false, reason: 'limit'|'exists'}}
   */
  summon(mapKey, cx, cz, slot) {
    if (this.entities.count(DRAGON_TYPE) >= DRAGON_MAX_ALIVE) {
      return { ok: false, reason: 'limit' };
    }
    const id = dragonEntityIdFor(mapKey, slot);
    if (this.entities.get(id)) return { ok: false, reason: 'exists' };
    const orbit = Object.freeze({
      cx, cz,
      y: TARN_PLATEAU_Y + DRAGON.orbitYOffset,
      radius: DRAGON.orbitRadius,
      omega: DRAGON.orbitSpeed / DRAGON.orbitRadius,
      // ⚠️ **相位按地图中心派生**（不是 v2.41 的 seed 级单值）：多条龙共存时各自相位不同，
      // 而同一张地图重召永远是同一个相位（确定性）。用错 salt 是静默的确定性污染。
      phase: seededRandom(cx, cz, this.seed + DRAGON_ORBIT_SALT) * Math.PI * 2,
      // v2.44：盘旋半径调制（用户「可以左右拐弯，免得绕圈太固定显得单调」）。
      // ⚠️ **wobblePhase 也按地图中心派生**：同一张地图重召逐位相同（确定性），
      // 不同地图的龙拐弯节奏不同（多条龙共存时不会同步摆动，观感不是复制粘贴）。
      // ⚠️ 复用同一个 salt + 同一个随机值派生两个量是**刻意**的：它们描述的是
      // 「这条龙在这张地图上的盘旋姿态」这一个事实，开第二个 salt 反而会让两者独立漂移。
      wobbleAmp: DRAGON_AI.wobbleAmp,
      wobbleFreq: DRAGON_AI.wobbleFreq,
      wobblePhase: seededRandom(cx, cz, this.seed + DRAGON_ORBIT_SALT) * Math.PI * 2,
    });
    const pose = dragonPoseAt(orbit, 0);
    const entity = this.entities.spawn({
      id,
      type: DRAGON_TYPE,
      state: createState({
        position: pose.position, yaw: pose.yaw, orbit, orbitT: 0,
        health: DRAGON.health, flashedUntil: 0,
      }),
      // ⚠️ **临时实体**（v2.41 裁定不变）：位置是纯函数，进存档就是第二份权威（红线 2）。
      // 代价 = column 卸载被回收 → 槽位清空、回来要重新按 C（用户 2026-11-03 接受的取舍）。
      persistent: false,
    });
    if (!entity) return { ok: false, reason: 'exists' };
    return { ok: true, id };
  }

  /**
   * 造成伤害。与 `ZombieService.damage` 同形状（红闪 + health ≤ 0 即 despawn）。
   *
   * ⚠️ **时间基准必须是 `performance.now()`**（调用方负责）：`Date.now()` 与它相差约
   * 17 亿毫秒，会让 `nowMs < flashedUntil` 恒真 → **龙永久红闪、永不消退**（AGENTS.md 已记）。
   *
   * ⚠️ **v2.43 起死亡不写任何标记**：v2.41 的 `meta.dragonDead` 已随「永久死亡」一起移除 ——
   * 死即槽位清空（实体消失 ⇒ `entities.get(id)` 为 null ⇒ 该槽位可再召）。
   *
   * @param {string} id @param {number} amount @param {number} nowMs
   * @returns {{dead: boolean, health: number}|null} 未知 id / 非龙实体返回 null
   */
  damage(id, amount, nowMs) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== DRAGON_TYPE) return null;
    const state = entity.state;
    const health = state.health - (Number.isFinite(amount) ? amount : 0);
    const flashedUntil = (Number.isFinite(nowMs) ? nowMs : 0) + DRAGON.flashMs;
    // 经 createState 重建（不原地改）：原地改会让 state 与任何持有它的引用悄悄同步
    entity.state = createState({ ...state, health, flashedUntil });
    if (health <= 0) {
      this.entities.despawn(id, 'killed');
      return { dead: true, health };
    }
    return { dead: false, health };
  }

  /**
   * 全部存活的龙（数组快照，与 `ZombieService.activeEntities` 同手法：
   * 调用方可能在遍历中调 `damage()` → despawn 改变底层集合，故返回快照而非迭代器）。
   * @returns {Array<import('../entity-manager.js').Entity>}
   */
  activeEntities() {
    const out = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === DRAGON_TYPE) out.push(entity);
    }
    return out;
  }

  dispose() {
    for (const entity of this.activeEntities()) {
      this.entities.despawn(entity.id, 'dispose');
    }
  }
}
