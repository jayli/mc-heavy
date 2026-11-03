// src/player/weapons/weapon-controller.js — 主线程武器玩法状态机（M4 规格 §4.2）
// 接收玩家提供的相机姿态（plain arrays）、缓存的 DDA 命中、WorldEditor 与只读 BlockQuery；
// 处理切枪、冷却、持续射击、普通 hitscan 与 MAG7 变更列表；返回纯效果事件（曳光/音效/后坐），
// 不创建 three 对象、不播放声音、不 import three。
import { WEAPON_IDS, WEAPONS } from './weapon-catalog.js';
import { isWeaponDestructible } from './weapon-target-policy.js';
import { collectMag7Changes } from './mag7-pattern.js';

/** 无 DDA 命中时曳光延伸距离（mc-lite 40 格 hitscan 语义） */
const MISS_RANGE = 40;
/**
 * MAG7 曳光终点距离（准心轴上）：= 准心命中距离与扫描范围上限的较小者；准心无命中时取上限。
 * **终点恒在准心轴上**，与「有没有扫到可破坏候选」无关 —— 候选在 right/up 基底上散布 ±1 格，
 * 拿候选当终点会让曳光斜向偏转、与枪管方向不对齐。
 * 上限直接派生自 catalog 的 `scan.max`（mc-lite `raycaster.far=10` 同口径），不另写一份字面量。
 */
const MAG7_MISS_RANGE = WEAPONS[WEAPON_IDS.MAG7].scan.max;

const CYCLE_ORDER = [WEAPON_IDS.ARM, WEAPON_IDS.PISTOL, WEAPON_IDS.MAG7, WEAPON_IDS.MINIGUN];

export class WeaponController {
  /**
   * @param {{registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>,
   *          blockQuery: {getBlockId: (x: number, y: number, z: number) => number},
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          onEffect?: (effect: object) => void}} deps
   */
  constructor({ registry, blockQuery, editor, onEffect = () => {}, onIgniteTnt = null }) {
    this.registry = registry;
    this.blockQuery = blockQuery;
    this.editor = editor;
    this.onEffect = onEffect;
    /**
     * M8 枪击引爆回调（Game 注入）。缺省 null → 命中 TNT 不引爆也不破坏（fixture 单独构造时）。
     * ⚠️ 引爆**不受** `blockDamageEnabled` 门控 —— mc-lite 同口径
     * （`PlayerInteraction.js:1048-1057` 的 tnt 分支在 `canGunsDestroyBlocks` 判定之前）。
     * @type {((x:number,y:number,z:number)=>boolean)|null}
     */
    this.onIgniteTnt = onIgniteTnt;
    this.selectedId = WEAPON_IDS.ARM;
    this.cooldown = 0;
    this.triggerHeld = false;
    this.shotsFired = 0;
    this.blockDamageEnabled = false; // 保留 mc-lite 的安全默认值
    this.lastEffect = null;
    /**
     * M6 实体查询（Game 装配时注入）。**缺省 null → 不查实体**：徒手/无丧尸场景照常开火，
     * 向后兼容（既有 M4 测试与交互不受影响）。注入而非 import entities —— controller 是纯
     * 逻辑层，不依赖 entities/render（依赖方向 §3）。
     *
     * v2.41：`damage` 改为 Game 的 `damageEntity`（按实体类型分发到 Zombie/Dragon service）；
     * 新增可选 `isHittable`（读 `WEAPON_HITTABLE_TYPES`），缺省回落「只认 zombie」。
     * @type {{raycast: Function, damage: Function, isHittable?: Function}|null}
     */
    this.entityQuery = null;
  }

  /**
   * 注入实体查询（M6 规格 §2）。`raycast` = M5 `EntityManager.raycast()`（实体命中唯一入口，
   * 红线 6 禁止 Raycaster）；`damage` = Game 的 `damageEntity(id, amount, nowMs)`（v2.41：
   * 按实体类型分发到 `ZombieService.damage` / `DragonService.damage`，不再硬编码丧尸）；
   * `isHittable`（可选）= 读 `WEAPON_HITTABLE_TYPES` 的 predicate，缺省回落「只认 zombie」。
   * Game 只把这些函数注入，controller 不持有任何实体集合（红线 1）。
   * @param {{raycast: (origin:number[], dir:number[], maxDist:number, predicate:Function)=>object|null,
   *          damage: (id:string, amount:number, nowMs:number)=>object|null,
   *          isHittable?: (entity:object)=>boolean}} query
   * @returns {{raycast: Function, damage: Function, isHittable?: Function}}
   */
  setEntityQuery(query) {
    this.entityQuery = (query && typeof query.raycast === 'function' && typeof query.damage === 'function')
      ? query
      : null;
    return this.entityQuery;
  }

  /**
   * 选择武器（含徒手）。非法 id 返回 false 且不改变状态。
   * @param {string} id @returns {boolean}
   */
  select(id) {
    if (id !== WEAPON_IDS.ARM && !WEAPONS[id]) return false;
    if (id === this.selectedId) return true;
    this.selectedId = id;
    this.cooldown = 0;
    this.triggerHeld = false;
    return true;
  }

  /** R 键循环：徒手 → 手枪 → MAG7 → 加特林 → 徒手（与 mc-lite 一致）。@returns {string} */
  cycle() {
    const next = CYCLE_ORDER[(CYCLE_ORDER.indexOf(this.selectedId) + 1) % CYCLE_ORDER.length];
    this.select(next);
    return this.selectedId;
  }

  /** 设置普通枪（手枪/加特林）是否破坏方块；MAG7 不受此开关限制。@returns {boolean} */
  setBlockDamage(enabled) {
    this.blockDamageEnabled = !!enabled;
    return this.blockDamageEnabled;
  }

  /**
   * 左键按下边沿。手枪/加特林立即尝试一次并进入按住连射；MAG7 只在边沿射一发。
   * @param {AimSnapshot} aim @returns {object[]} 本次产生的效果事件
   */
  pointerDown(aim) {
    this.triggerHeld = true;
    return this._tryFire(aim);
  }

  /** 左键抬起。 */
  pointerUp() {
    this.triggerHeld = false;
  }

  /**
   * 每帧推进：先扣冷却，再让按住的手枪/加特林在冷却结束后自动重复。
   * MAG7 不自动重复（单发语义）。
   * @param {number} dt 秒 @param {AimSnapshot} aim @returns {object[]}
   */
  update(dt, aim) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!this.triggerHeld) return [];
    const weapon = WEAPONS[this.selectedId];
    if (!weapon || !weapon.automatic) return [];
    return this._tryFire(aim);
  }

  /**
   * 自动化测试/公开 API 入口：走与键鼠完全相同的状态机，仍遵守冷却。
   * @param {AimSnapshot} aim @returns {object[]}
   */
  fireOnce(aim) {
    return this._tryFire(aim);
  }

  /**
   * @returns {{selectedId: string, cooldown: number, triggerHeld: boolean,
   *            shotsFired: number, lastEffect: object | null}}
   */
  debugState() {
    return {
      selectedId: this.selectedId,
      cooldown: this.cooldown,
      triggerHeld: this.triggerHeld,
      shotsFired: this.shotsFired,
      lastEffect: this.lastEffect,
    };
  }

  /** 内部：冷却未结束或徒手 → 无效果。 */
  _tryFire(aim) {
    if (this.selectedId === WEAPON_IDS.ARM) return [];
    if (this.cooldown > 0) return [];
    const weapon = WEAPONS[this.selectedId];
    this.cooldown = weapon.cooldown;
    this.shotsFired++;
    const effect = weapon.id === WEAPON_IDS.MAG7
      ? this._fireMag7(aim, weapon)
      : this._fireHitscan(aim, weapon);
    this.lastEffect = effect;
    this.onEffect(effect);
    return [effect];
  }

  /**
   * M6 统一遮挡口径（M6 规格 §2）：**实体命中 vs DDA 方块命中的最近距离比较**。
   *
   * 口径三要素（每条都由测试钉住）：
   * ① 先取 DDA 距离（无方块命中 = `Infinity`）；
   * ② 以该枪 `entityRange` 发起 `EntityManager.raycast()` —— maxDist 裁剪让超射程的实体
   *    根本不返回（不是「返回了再判距离」）；
   * ③ **仅实体距离严格小于 DDA 距离时**扣血 + 发 `entity-hit`。相等距离按**方块优先** ——
   *    保证实体不穿墙（墙正好贴在丧尸脸上时，子弹先打墙）。
   *
   * 返回 `null` 表示无实体命中（或实体被方块挡住）。**未注入 entityQuery 时直接返回 null**
   * —— 徒手/无丧尸场景照常开火（向后兼容）。
   *
   * @param {AimSnapshot} aim @param {object} weapon
   * @returns {null|{entityId: string, entityDamage: number, end: number[]}}
   */
  _queryEntityHit(aim, weapon) {
    if (!this.entityQuery) return null;
    const { origin, forward, target } = aim;
    // ① DDA 距离：无命中 → Infinity（实体永远「更近」，可正常受伤）
    const blockDist = target && target.hit ? target.dist : Infinity;
    // ② 以该枪射程发起实体射线。predicate 放行「可被武器击中的类型」（v2.41：丧尸 + 龙）。
    //    ⚠️ **缺省回落「只认 zombie」**（M4 行为逐位不变）：Game 装配时注入 `isHittable`
    //    （读 `WEAPON_HITTABLE_TYPES`），fixture/旧测试不注入则走缺省。controller 仍**不 import
    //    entities/**（自声明约束：注入而非 import，依赖方向 §3）—— 集合的权威在 entity-types.js，
    //    由 Game 注入进来，不在这里写第二份字面量。
    const hittable = this.entityQuery.isHittable ?? ((entity) => entity.type === 'zombie');
    const hit = this.entityQuery.raycast(origin, forward, weapon.entityRange, hittable);
    if (!hit) return null;
    // ③ 严格小于才命中（相等按方块优先）
    if (!(hit.dist < blockDist)) return null;
    // **时间基准必须是 `performance.now()`，不能用 `Date.now()`**（实测踩坑）：
    // `ZombieRenderer.sync(zombies, nowMs)` 的 nowMs 来自 game.js 帧循环的
    // `setAnimationLoop` 回调参数（= performance.now() 基准），红闪判定是
    // `nowMs < state.flashedUntil`。实测两个基准相差约 17 亿毫秒
    // （Date.now()=1788847988963 vs performance.now()=676.6）→ 若这里用 Date.now()，
    // `flashedUntil` 会是个天文数字，判定恒为 true → **丧尸永久红闪、永不消退**。
    this.entityQuery.damage(hit.id, weapon.entityDamage, performance.now());
    const end = [
      origin[0] + forward[0] * hit.dist,
      origin[1] + forward[1] * hit.dist,
      origin[2] + forward[2] * hit.dist,
    ];
    return { entityId: hit.id, entityDamage: weapon.entityDamage, end };
  }

  /**
   * 手枪/加特林：首个 DDA 方块阻挡并决定曳光终点；开关开启且可破坏才写世界。
   * M6：**实体更近时不写方块**（实体遮挡方块），且效果事件改为 `entity-hit`。
   *
   * v1.64：命中方块时在事件里带一条 `impacts` 记录（位置/命中面/方块 id/是否真被破坏）。
   * 这只是**报告**，不产生任何渲染对象 —— 白闪/碎块由 `render/block-hit-fx.js` 消费。
   */
  _fireHitscan(aim, weapon) {
    const entityHit = this._queryEntityHit(aim, weapon);
    if (entityHit) {
      // 实体挡在前面：不写方块世界（子弹被丧尸吃掉），曳光终点落在实体命中点
      return this._makeEffect(weapon, aim, entityHit.end, {
        type: 'entity-hit', entityId: entityHit.entityId, entityDamage: entityHit.entityDamage,
      });
    }
    const { origin, forward, target } = aim;
    let end;
    let impacts = [];
    if (target && target.hit) {
      end = [
        origin[0] + forward[0] * target.dist,
        origin[1] + forward[1] * target.dist,
        origin[2] + forward[2] * target.dist,
      ];
      const [bx, by, bz] = target.blockPos;
      const hitId = this.blockQuery.getBlockId(bx, by, bz);
      // M8：枪击命中 tnt → 引爆（mc-lite `PlayerInteraction.js:1048` 是 `executeShot()` 内的
      // 枪击命中路径；`:172` 才是 ctrl+左键）。本仓库简化为「命中即引爆」—— 有意偏离，
      // 规格 §2.2。去重在 `game.explodeTnt()` 内（单一权威），此处只透传。
      if (hitId === this.registry.idOf('tnt')) {
        if (this.onIgniteTnt) this.onIgniteTnt(bx, by, bz);
        return this._makeEffect(weapon, aim, end);   // 不走破坏分支
      }
      const destroyed = this.blockDamageEnabled && isWeaponDestructible(hitId, this.registry);
      if (destroyed) this.editor.setBlock({ x: bx, y: by, z: bz, id: 0 });
      // ⚠️ `blockId` 必须是**写入删除之前**读到的值：删完再读会恒为 air（0），
      // 白闪/碎块会退化成默认色 —— 特效照样播，只是与方块材质无关（静默失效）。
      impacts = [{
        blockPos: [bx, by, bz],
        normal: target.normal ?? null,
        blockId: hitId,
        destroyed,
      }];
    } else {
      end = [
        origin[0] + forward[0] * MISS_RANGE,
        origin[1] + forward[1] * MISS_RANGE,
        origin[2] + forward[2] * MISS_RANGE,
      ];
    }
    return this._makeEffect(weapon, aim, end, { impacts });
  }

  /**
   * MAG7：无视开关，一次批量编辑提交全部可破坏候选（M4 有意偏离 mc-lite 的分批定时器）。
   * 曳光终点必须在准心轴上（见 MAG7_MISS_RANGE 注释）：3×3 体积扫描的首个候选常在准心轴
   * 之外（right/up 基底上 i,j∈{-1,0,1}），拿它当终点会让曳光斜向偏转、与枪管方向不对齐。
   *
   * M6：**先完成 10 格实体命中，再按 M4 已定义的单发体积扫描提交方块** —— 它不是 projectile，
   * 也不把方块扫描改成实体射线（M6 规格 §2 的明确口径）。两步是同一发的独立动作：实体命中
   * 与方块破坏互不阻断（命中丧尸的同时仍然炸掉周围的墙）。
   */
  _fireMag7(aim, weapon) {
    const entityHit = this._queryEntityHit(aim, weapon);
    const changes = collectMag7Changes(aim, this.blockQuery, this.registry);
    if (changes.length > 0) this.editor.setBlocks(changes);
    // 终点距离 = 准心射线的命中距离（钳到扫描范围上限），无命中则取上限。
    // 不用普通枪的 target.dist 原值：主 DDA 的 REACH=40 远超 MAG7 的 1~10 格扫描范围，
    // 曳光延伸到 40 格会宣称「打到了扫描范围之外」。
    const { origin, forward, target } = aim;
    const dist = target && target.hit
      ? Math.min(target.dist, MAG7_MISS_RANGE)
      : MAG7_MISS_RANGE;
    const end = entityHit ? entityHit.end : [
      origin[0] + forward[0] * dist,
      origin[1] + forward[1] * dist,
      origin[2] + forward[2] * dist,
    ];
    // v1.67：一次 MAG7 仍然只是**一个** impact（一个命中点），但带上 `stagger` 波浪列表
    // —— 全部被毁格的块位置，顺序直接沿用 `collectMag7Changes` 已排好的「由近到远」
    // → 渲染层按同一次序错开启动时刻，就是「由命中点向外扩散」。
    // 用户 2026-10-23：「所有伴随着消失的方块都做白闪后消失……用 600ms 的时间依次让
    // 应该消失的方块白闪后消失」。
    //
    // ⚠️ 扩散时长不在事件里传递：唯一权威是渲染层的 `IMPACT_FX.whiteFlash.staggerMs`
    // （控制器不 import render，依赖方向 §3；再写一份字面量就是红线 1 的第二份权威）。
    const impacts = [];
    if (changes.length > 0) {
      impacts.push({
        // 首格 = 最靠近命中点的格 —— 单点特效（碎块等）用它。
        blockPos: [changes[0].x, changes[0].y, changes[0].z],
        normal: target?.normal ?? null,
        blockId: changes[0].sourceId,
        destroyed: true,        // MAG7 无视开关，进入 changes 即已提交删除
        radius: MAG7_MISS_RANGE,
        // 波浪：每一格各自的块位置（白闪逐格亮起），顺序 = 由近到远。
        stagger: changes.map((c) => ({ blockPos: [c.x, c.y, c.z] })),
      });
    }
    return entityHit
      ? this._makeEffect(weapon, aim, end, {
        type: 'entity-hit', entityId: entityHit.entityId, entityDamage: entityHit.entityDamage,
        impacts,
      })
      : this._makeEffect(weapon, aim, end, { impacts });
  }

  /**
   * 组装纯效果事件：start 按相机基底展开 localStart。
   * @param {object} weapon @param {AimSnapshot} aim @param {number[]} end
   * @param {{type?: string, entityId?: string, entityDamage?: number, impacts?: object[]}} [override]
   *        M6 实体命中时覆盖 type 为 `entity-hit` 并带上 entityId/entityDamage。
   *        v1.64 追加 `impacts`（命中特效的纯数据，见 `_fireHitscan`/`_fireMag7`）—— 缺省空数组，
   *        让渲染层的消费点不必判 undefined。
   *        曳光/音效/后坐/视图模型这些渲染消费字段**不变** —— 曳光终点已在调用侧改成实体命中点，
   *        其余口径与普通射击一致（命中实体仍有曳光与枪声）。
   */
  _makeEffect(weapon, aim, end, override = null) {
    const { origin, forward, right, up } = aim;
    const [lsx, lsy, lsz] = weapon.localStart;
    return {
      type: override?.type ?? 'shot',
      weaponId: weapon.id,
      sound: weapon.sound,
      volume: weapon.volume,
      start: [
        origin[0] + right[0] * lsx + up[0] * lsy - forward[0] * lsz,
        origin[1] + right[1] * lsx + up[1] * lsy - forward[1] * lsz,
        origin[2] + right[2] * lsx + up[2] * lsy - forward[2] * lsz,
      ],
      end,
      localStart: [...weapon.localStart],
      recoil: weapon.recoil,
      tracer: { ...weapon.tracer },
      impacts: override?.impacts ?? [],
      ...(override?.entityId !== undefined ? { entityId: override.entityId } : {}),
      ...(override?.entityDamage !== undefined ? { entityDamage: override.entityDamage } : {}),
    };
  }
}

/**
 * @typedef {{origin: number[], forward: number[], right: number[], up: number[],
 *            target: ({hit: boolean, blockPos?: number[], normal?: number[]|null,
 *                      dist?: number} | null)}} AimSnapshot
 */
