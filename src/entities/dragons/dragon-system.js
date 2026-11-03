// src/entities/dragons/dragon-system.js — 祭坛飞龙（v2.41）：轨道/动画/AABB 纯函数 + definition + service
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
// 渲染层（`src/render/dragon-renderer.js`）只读本文件产出的 pose，不回写 state、不参与命中
// （命中唯一真相 = `dragonDefinition.raycastAabb`，红线 6）。
//
// 设计文档 `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（下称 spec）。
//
// ⚠️ **龙是「景观实体」而不是玩家资产**：位置是 `(seed, 时间)` 的纯函数，**不进存档**
// （红线 2）。故用 `persistent: false` spawn，只有「死没死」这一个布尔进 `meta` 行。
// 代价 = column 卸载会被回收 → `ensure()` 重生（血量重置，spec §5.2 已记取舍）。
import { raycastAabbSlab, normalizePosition } from '../entity-types.js';
import { COLUMN_SIZE } from '../../voxel/constants.js';
import { findAltarTarnRegion, TARN_PLATEAU_Y } from '../../gen/structures/tarn-zone.js';
import { seededRandom } from '../../gen/noise.js';
import {
  DRAGON, DRAGON_TYPE, DRAGON_ENTITY_ID, DRAGON_ORBIT_SALT, DRAGON_CORE_OBB, DRAGON_ANIM,
} from './dragon-config.js';

// ==================== 纯函数 ====================

/**
 * 轨道 pose（spec §6.1）。
 *
 * ⚠️ **`yaw = π − θ`，不是 spec §6.1 原文写的 `θ + π/2`** —— 原文那式子算出的前向与轨道
 * 切线**垂直**（龙会侧着身子飞）。推导：轨道切线 = `(−sin θ, cos θ)`（对 `x=cx+R cos θ`、
 * `z=cz+R sin θ` 求导），而本仓的 yaw→前向口径是 `(−sin yaw, −cos yaw)`（AGENTS.md
 * 「出生朝向与相机旋转的测量口径」表，源自 `camera.rotateY(yaw)`）。令两者相等：
 * `sin yaw = sin θ` 且 `cos yaw = −cos θ` ⇒ `yaw = π − θ`。
 * 判据落在 `test-dragon-system.js` 的「yaw 是切线方向」（点积 > 0.99），改公式必红。
 *
 * @param {{cx:number, cz:number, y:number, radius:number, omega:number, phase:number}} orbit
 * @param {number} t 轨道时钟（秒）
 * @returns {{position: [number,number,number], yaw: number}}
 */
export function dragonPoseAt(orbit, t) {
  const theta = orbit.phase + orbit.omega * t;
  const x = orbit.cx + orbit.radius * Math.cos(theta);
  const z = orbit.cz + orbit.radius * Math.sin(theta);
  const y = orbit.y + DRAGON.bobAmplitude * Math.sin((2 * Math.PI * t) / DRAGON.bobPeriod);
  return { position: [x, y, z], yaw: Math.PI - theta };
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
 * 轨道参数的合法性校验（6 个字段全须有限）。
 * @returns {object|null} 冻结的 orbit，非法返回 null
 */
function normalizeOrbit(orbit) {
  if (!orbit || typeof orbit !== 'object') return null;
  const keys = ['cx', 'cz', 'y', 'radius', 'omega', 'phase'];
  for (const k of keys) if (!Number.isFinite(orbit[k])) return null;
  return Object.freeze({ cx: orbit.cx, cz: orbit.cz, y: orbit.y, radius: orbit.radius, omega: orbit.omega, phase: orbit.phase });
}

/**
 * 构造全新 state（**不原地改写** —— M5 不变式：`EntityManager.update` 的跨 column 索引迁移
 * 判据是「赋值前 position vs 赋值后 position」，原地改写会让 before/after 从同一份算出
 * → 恒相等 → 索引永不迁移 → column 卸载漏回收实体）。
 */
function createState({ position, yaw, orbit, orbitT, health, flashedUntil }) {
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
  };
}

// ==================== definition ====================

/**
 * 龙的 M5 definition。
 *
 * ⚠️ **`update` 不读 context**：轨道参数全在 state 里，龙不与方块交互（不碰撞、不寻路、
 * 不受重力）—— 它是纯景观实体。故 `entities.update(dt, ctx)` 传什么 ctx 都无所谓。
 */
export const dragonDefinition = Object.freeze({
  create(state) {
    if (!state) return null;
    return createState(state);
  },

  /**
   * 推进轨道时钟并重算 pose。
   * @returns {object} 全新 state（含全新 position 数组）
   */
  update(entity, dt) {
    const prev = entity.state;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const orbitT = prev.orbitT + step;
    const pose = dragonPoseAt(prev.orbit, orbitT);
    return createState({
      position: pose.position, yaw: pose.yaw, orbit: prev.orbit, orbitT,
      health: prev.health, flashedUntil: prev.flashedUntil,
    });
  },

  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, dragonAabbFor(state)),

  /** 临时实体不走存档，最小 snapshot（保留 orbitT 以便调试/未来持久化） */
  serialize(state) {
    if (!state) return null;
    const p = normalizePosition(state.position);
    if (!p) return null;
    return { position: p, yaw: state.yaw, orbitT: state.orbitT, health: state.health };
  },

  deserialize(raw) {
    if (!raw) return null;
    const p = normalizePosition(raw.position);
    if (!p) return null;
    return {
      position: p,
      yaw: Number.isFinite(raw.yaw) ? raw.yaw : 0,
      orbitT: Number.isFinite(raw.orbitT) ? raw.orbitT : 0,
      health: Number.isFinite(raw.health) ? raw.health : DRAGON.health,
    };
  },
});

// ==================== service ====================

/**
 * 龙的玩法入口（形状对齐 `ZombieService`：spawn 编排 / damage / 只读查询）。
 *
 * ⚠️ **不 import three、不 import DOM**（同构层）。`world` 只用 `hasColumn`（依赖注入，
 * 不 import `WorldData` 类）。
 */
export class DragonService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager,
   *          persistence: {saveDragonDead?: Function}|null,
   *          seed: number,
   *          world: {hasColumn: (cx:number, cz:number)=>boolean}}} deps
   */
  constructor({ entities, persistence = null, seed, world, findAltar = findAltarTarnRegion }) {
    this.entities = entities;
    this.persistence = persistence;
    this.seed = seed;
    this.world = world;
    /**
     * 祭坛地带定位函数（默认 `findAltarTarnRegion`，可注入以便测试 null 路径）。
     * ⚠️ 默认值就是与「高台」按钮同源的那个权威 —— 注入只用于单测，生产不传。
     */
    this.findAltar = findAltar;
    this._dead = false;
    /**
     * 轨道 memo（seed 级）。
     * ⚠️ **变量名里不得出现 `RegionCache` 子串** —— `check:arch` 的 `FORBIDDEN_NAMES` 是
     * **子串**匹配，而 `RegionCache` 是 mc-lite 的补丁架构类名（红线 2/4）。AGENTS.md 已记
     * v2.30 的 `_altarRegionCache` 被静态门当场拦下，故用 `memo` 词根。
     * @type {{seed: number, orbit: object|null}|null}
     */
    this._orbitMemo = null;
  }

  /**
   * 派生轨道参数（seed 的纯函数，memo 缓存）。
   *
   * ⚠️ **转调 `findAltarTarnRegion`，不自己写一份「哪个地带带祭坛」**（红线 1）：
   * 那个函数与设置面板「高台」按钮同源（`teleportToTarnZone` → `findNearestTarnZone`），
   * 两份判据漂移的形态是「按钮到的地带没有龙」。
   *
   * @returns {object|null} 全世界无祭坛地带时返回 null
   */
  _orbitFor() {
    if (this._orbitMemo && this._orbitMemo.seed === this.seed) return this._orbitMemo.orbit;
    const altar = this.findAltar(this.seed);
    const orbit = altar === null ? null : Object.freeze({
      cx: altar.cx,
      cz: altar.cz,
      y: TARN_PLATEAU_Y + DRAGON.orbitYOffset,
      radius: DRAGON.orbitRadius,
      omega: DRAGON.orbitSpeed / DRAGON.orbitRadius,
      // phase 用专属 salt（1040）：用错 salt 是静默的确定性污染（与别的系统共用随机流）
      phase: seededRandom(0, 0, this.seed + DRAGON_ORBIT_SALT) * Math.PI * 2,
    });
    this._orbitMemo = { seed: this.seed, orbit };
    return orbit;
  }

  /**
   * 预热轨道 memo（`Game.start()` 装配后调一次）。
   *
   * ⚠️ **为什么需要**：`findAltarTarnRegion` 冷调用实测 **12.6ms**（seed 12345；热调用
   * 8.4µs）。若不预热，这 12.6ms 会落在**第一个玩法帧**的 `ensure()` 里 —— 120Hz 下
   * 帧预算只有 8.3ms，开局直接掉一帧（而且玩家可能根本不去祭坛地带，白付）。
   * 放在 `start()` 的加载阶段就与 `computeArenaAnchor` 在 Worker layout 入口预热同一口径
   * （AGENTS.md：「在每个 Worker 的 layout 入口预热，不能落进 GEN 计时路径」）。
   *
   * 幂等：`_orbitFor()` 自带 seed 级 memo，重复调只是 8.4µs 的查表。
   */
  warm() {
    this._orbitFor();
  }

  /**
   * 每帧由 `game.js` 在 `entities.update` **之前**调（与 `zombies.update` 同段：先编排后推进）。
   *
   * 三个门控缺一不可：① 已死 → 不 spawn（用户裁定「永久死亡」）；② 已有实体 → 幂等；
   * ③ 祭坛地带中心 column 未就绪 → 不 spawn（避免在未加载区放一个玩家看不见的实体，
   * 也让「传送过去才出现」自然成立）。
   */
  ensure() {
    if (this._dead) return null;
    const existing = this.active();
    if (existing) return existing;
    const orbit = this._orbitFor();
    if (orbit === null) return null;
    if (this.world && typeof this.world.hasColumn === 'function') {
      const ccx = Math.floor(orbit.cx / COLUMN_SIZE);
      const ccz = Math.floor(orbit.cz / COLUMN_SIZE);
      if (!this.world.hasColumn(ccx, ccz)) return null;
    }
    const pose = dragonPoseAt(orbit, 0);
    const entity = this.entities.spawn({
      id: DRAGON_ENTITY_ID,
      type: DRAGON_TYPE,
      state: createState({
        position: pose.position, yaw: pose.yaw, orbit, orbitT: 0,
        health: DRAGON.health, flashedUntil: 0,
      }),
      // ⚠️ **临时实体**（spec 分叉二方案 A）：位置是 seed 的纯函数，进存档就是第二份权威
      // （红线 2）。代价 = column 卸载被回收 → 本方法重生（血量重置，spec §5.2 取舍）。
      persistent: false,
    });
    return entity || null;
  }

  /**
   * 造成伤害。与 `ZombieService.damage` 同形状（红闪 + health ≤ 0 即 despawn）。
   *
   * ⚠️ **时间基准必须是 `performance.now()`**（调用方负责）：`Date.now()` 与它相差约
   * 17 亿毫秒，会让 `nowMs < flashedUntil` 恒真 → **龙永久红闪、永不消退**（AGENTS.md 已记）。
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
      this._dead = true;
      // 死亡标记 merge 写进 meta 行（与 v2.29 `playerPos` 同一手法）。
      // ⚠️ 不 await、不挂 beforeunload：死亡是低频单次事件，且挂 unload 会有
      // 「旧世界标记写回新世界」的竞态（playerPos 需要 `_lastSavedPos = null` 正是为此）。
      if (this.persistence?.saveDragonDead) {
        Promise.resolve(this.persistence.saveDragonDead(true)).catch((err) => {
          console.warn('[dragon] saveDragonDead failed:', err);
        });
      }
      return { dead: true, health };
    }
    return { dead: false, health };
  }

  /** 当前龙实体或 null（渲染器与炮塔目标集合消费） */
  active() {
    return this.entities.get(DRAGON_ENTITY_ID);
  }

  /** @returns {boolean} 是否已永久死亡 */
  isDead() { return this._dead; }

  /**
   * 启动时从 meta 行恢复死亡标记（`game.start()` 读到 meta 后调一次）。
   *
   * ⚠️ **`hydrate({})` 是「复活」语义**：`newWorld`/`clearSave` 的 `saveMeta` 整行 put
   * 不含 `dragonDead` → 换 seed / 删存档后龙自然恢复（与 `playerPos` 同机制，
   * 不需要 settingsVersion 式迁移）。
   * @param {object|null} metaRow
   */
  hydrate(metaRow) {
    this._dead = !!(metaRow && metaRow.dragonDead);
  }

  dispose() {
    const entity = this.active();
    if (entity) this.entities.despawn(entity.id, 'dispose');
  }
}
