// src/player/weapons/weapon-controller.js — 主线程武器玩法状态机（M4 规格 §4.2）
// 接收玩家提供的相机姿态（plain arrays）、缓存的 DDA 命中、WorldEditor 与只读 BlockQuery；
// 处理切枪、冷却、持续射击、普通 hitscan 与 MAG7 变更列表；返回纯效果事件（曳光/音效/后坐），
// 不创建 three 对象、不播放声音、不 import three。
import { WEAPON_IDS, WEAPONS } from './weapon-catalog.js';
import { isWeaponDestructible } from './weapon-target-policy.js';
import { collectMag7Changes } from './mag7-pattern.js';
import { stormChargeProgress, stormLanceAxis, cinderChargeProgress, chargeStageAt } from './storm-lance.js';
import { cinderLaunch } from './cinder-fall.js';

/** 无 DDA 命中时曳光延伸距离（mc-lite 40 格 hitscan 语义） */
const MISS_RANGE = 40;
/**
 * MAG7 曳光终点距离（准心轴上）：= 准心命中距离与扫描范围上限的较小者；准心无命中时取上限。
 * **终点恒在准心轴上**，与「有没有扫到可破坏候选」无关 —— 候选在 right/up 基底上散布 ±1 格，
 * 拿候选当终点会让曳光斜向偏转、与枪管方向不对齐。
 * 上限直接派生自 catalog 的 `scan.max`（mc-lite `raycaster.far=10` 同口径），不另写一份字面量。
 */
const MAG7_MISS_RANGE = WEAPONS[WEAPON_IDS.MAG7].scan.max;

const CYCLE_ORDER = [
  WEAPON_IDS.ARM, WEAPON_IDS.PISTOL, WEAPON_IDS.MAG7, WEAPON_IDS.MINIGUN, WEAPON_IDS.SWORD,
];

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
     * v3.20 Storm Lance：自按下左键起的秒数（**含前 1s 静默期**）。
     * 只对带 `stormLance` 的武器（剑）推进。
     * ⚠️ **按下边沿仍照旧路径挥一刀**（用户：「短按鼠标就是普通的挥剑攻击」）——
     * 蓄力是**叠加**在既有行为上的，不是取代它。
     * ⚠️ **静默期内不得发任何蓄力事件**（用户：「不然我只需要挥刀的时候也会触发
     * 蓄力的动画，画面就太乱了」）—— 起手事件推到越过 `chargeDelaySeconds` 那一帧。
     */
    this.novaChargeElapsed = 0;
    /** 起手事件是否已发（防每帧重复） */
    this._novaStartFired = false;
    /** 蓄满音是否已响过（防每帧重复响） */
    this._novaReadyFired = false;
    /**
     * v3.21 Cinder Fall：**第二段的两个跨越标志**。
     *
     * ⚠️⚠️ **阶段判定优先读它们，而不是对 `novaChargeElapsed` 取浮点边界**：
     * dt 逐帧累加会在边界两侧漂（实测 `60×0.05 = 2.9999999999999973` 落在 3 下方）。
     * 跨越比较（`was < 边界 && now >= 边界`）对累积误差免疫 —— 与既有
     * `_novaStartFired` / `_novaReadyFired` 同手法。纯函数 `chargeStageAt` 另有 1e-9
     * 容差供 UI/诊断，两者必须同侧（单测钉住）。
     */
    this._cinderStartFired = false;
    this._cinderReadyFired = false;
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
   *
   * v2.65 近战剑追加可选 `knockback(id, dist)`：把被砍中的实体沿「背离玩家」方向位移一小步
   * （方向由 Game 用玩家位置算 —— controller 不持有玩家位置，只传命中 id 与距离）。
   * 缺省 null → 无击退（fixture/旧测试不注入则走缺省，逐位不变）。
   *
   * @param {{raycast: (origin:number[], dir:number[], maxDist:number, predicate:Function)=>object|null,
   *          damage: (id:string, amount:number, nowMs:number)=>object|null,
   *          isHittable?: (entity:object)=>boolean,
   *          knockback?: (id:string, dist:number)=>boolean}} query
   * @returns {{raycast: Function, damage: Function, isHittable?: Function, knockback?: Function}}
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
    // v3.20：切武器丢弃蓄力（否则「持剑蓄一半 → 切枪 → 切回剑 → 松手」会凭空放一发）
    this.novaChargeElapsed = 0;
    this._novaStartFired = false;
    this._novaReadyFired = false;
    // v3.21：第二段同理
    this._cinderStartFired = false;
    this._cinderReadyFired = false;
    return true;
  }

  /**
   * R 键循环：徒手 → 手枪 → MAG7 → 加特林 → 剑 → 徒手（v2.65 追加剑）。@returns {string} */
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
   * v3.20：带 `stormLance` 的武器（剑）**仍照旧路径挥一刀**，蓄力从下一帧开始计时；
   * **起手事件不在这里发** —— 前 `chargeDelaySeconds` 秒是静默期（R1）。
   * @param {AimSnapshot} aim @returns {object[]} 本次产生的效果事件
   */
  pointerDown(aim) {
    this.triggerHeld = true;
    const effects = this._tryFire(aim);
    const weapon = WEAPONS[this.selectedId];
    if (weapon?.stormLance) {
      this.novaChargeElapsed = 0;
      this._novaStartFired = false;
      this._novaReadyFired = false;
      this._cinderStartFired = false;
      this._cinderReadyFired = false;
    }
    return effects;
  }

  /**
   * 左键抬起。
   *
   * v3.20：**新增可选 `aim`** —— 蓄满且冷却已到期时施放 Storm Lance。
   * ⚠️ **无 aim 时只清状态，不施法也不抛错**：既有 5 处单测/spec 都是 `pointerUp()` 无参调用，
   * 改成必填会让它们全部报错（向后兼容）。
   *
   * v3.21：**按阶段分流**（用户裁定「进入那一秒就能发」）：
   *   第二秒松手 → `storm-lance`；第三秒松手 → `cinder-fall`。
   * ⚠️ 阶段优先读**跨越标志**（对 dt 累积误差免疫，见 `_cinderStartFired` 注释）。
   *
   * @param {AimSnapshot} [aim] @returns {object[]}
   */
  pointerUp(aim) {
    this.triggerHeld = false;
    const weapon = WEAPONS[this.selectedId];
    const cfg = weapon?.stormLance;
    // 先取阶段再清状态（清完就读不到了）
    const stage = this._chargeStage();
    this.novaChargeElapsed = 0;
    this._novaStartFired = false;
    this._novaReadyFired = false;
    this._cinderStartFired = false;
    this._cinderReadyFired = false;
    if (!cfg || stage === 'none' || !aim || this.cooldown > 0) return [];
    if (stage === 'cinder' && weapon.cinderFall) return [this._fireCinderFall(aim, weapon)];
    return [this._fireStormLance(aim, weapon)];
  }

  /**
   * 当前蓄力阶段（v3.21）—— **跨越标志优先**。
   *
   * 标志没置上时才回落纯函数（fixture 直接写 `novaChargeElapsed` 而不跑 update 的情形）。
   * @returns {'none'|'lance'|'cinder'}
   */
  _chargeStage() {
    const weapon = WEAPONS[this.selectedId];
    const cfg = weapon?.stormLance;
    if (!cfg) return 'none';
    if (this._cinderStartFired) return 'cinder';
    if (this._novaStartFired) return 'lance';
    return chargeStageAt(this.novaChargeElapsed, {
      ...cfg, cinderChargeSeconds: weapon.cinderFall?.chargeSeconds ?? 0,
    });
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
    // v3.20：蓄力推进必须在 `automatic` 早退**之前** —— 剑无 `automatic`，
    // 放在后面的形态是「蓄力永不推进」而所有既有剑用例仍全绿（静默失效）。
    const effects = [];
    const cfg = weapon?.stormLance;
    if (cfg) {
      const was = this.novaChargeElapsed;
      this.novaChargeElapsed = was + dt;
      const full = cfg.chargeDelaySeconds + cfg.chargeSeconds;
      // 起手：越过静默期那一帧（**不在 pointerDown**，R1）
      if (!this._novaStartFired && was <= cfg.chargeDelaySeconds
        && this.novaChargeElapsed > cfg.chargeDelaySeconds) {
        this._novaStartFired = true;
        effects.push(this._emitNova({
          type: 'storm-charge-start', weapon,
          sound: cfg.chargeSound, volume: cfg.chargeVolume,
        }));
      }
      if (!this._novaReadyFired && was < full && this.novaChargeElapsed >= full) {
        this._novaReadyFired = true;
        effects.push(this._emitNova({
          type: 'storm-charge-ready', weapon,
          sound: cfg.readySound, volume: cfg.readyVolume,
        }));
      }
      /**
       * v3.21：第二段（第三秒）的起手与蓄满。
       * ⚠️ **第二段的边界是 `full`（= delay + charge）**，与第一段的蓄满点同一个时刻 ——
       * 那一刻既是「Storm Lance 蓄满」也是「Cinder Fall 起手」，两个事件同帧发是**正确的**
       * （一声提示「可以发 lance 了」+ 一声提示「开始蓄第二招」）。
       * ⚠️ 同样用**跨越比较**，不用 `elapsed >= 边界`（dt 累积误差，见字段注释）。
       */
      const c2 = weapon.cinderFall;
      if (c2) {
        const full2 = full + c2.chargeSeconds;
        if (!this._cinderStartFired && was < full && this.novaChargeElapsed >= full) {
          this._cinderStartFired = true;
          effects.push(this._emitNova({
            type: 'cinder-charge-start', weapon,
            sound: c2.chargeSound, volume: c2.chargeVolume,
          }));
        }
        if (!this._cinderReadyFired && was < full2 && this.novaChargeElapsed >= full2) {
          this._cinderReadyFired = true;
          effects.push(this._emitNova({
            type: 'cinder-charge-ready', weapon,
            sound: c2.readySound, volume: c2.readyVolume,
          }));
        }
      }
    }
    if (!weapon || !weapon.automatic) return effects;
    return effects.concat(this._tryFire(aim));
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
    const weapon = WEAPONS[this.selectedId];
    const cfg = weapon?.stormLance;
    const c2 = weapon?.cinderFall;
    const seq = cfg ? { ...cfg, cinderChargeSeconds: c2?.chargeSeconds ?? 0 } : null;
    return {
      selectedId: this.selectedId,
      cooldown: this.cooldown,
      triggerHeld: this.triggerHeld,
      shotsFired: this.shotsFired,
      lastEffect: this.lastEffect,
      // v3.20：蓄力进度（0..1，**静默期恒 0**）与「已蓄满」—— HUD 蓄力环与渲染器都读它。
      // 字段名沿用 novaCharge/novaCharged：它们是「蓄力」的通用诊断口径，
      // 改名会白白推翻既有 spec 与装配层的消费点。
      novaCharge: cfg ? stormChargeProgress(this.novaChargeElapsed, cfg) : 0,
      novaCharged: !!cfg
        && this.novaChargeElapsed >= cfg.chargeDelaySeconds + cfg.chargeSeconds,
      // v3.21：第二段进度与阶段（装配层每帧读轻量字段，不调本方法 —— 它是调试 API）
      cinderCharge: seq ? cinderChargeProgress(this.novaChargeElapsed, seq) : 0,
      cinderCharged: !!c2 && this._cinderReadyFired,
      chargeStage: this._chargeStage(),
    };
  }

  /**
   * v3.20：组装蓄力类事件（起手/蓄满）。
   *
   * ⚠️ **`recoil` 必须是 0而不是缺席**：`view-weapon.js:onShot` 对非 melee 事件写
   * `this._recoil = effect.recoil`，undefined 会让它变 NaN ⇒ 剑体位置 NaN ⇒ **剑从画面上消失**，
   * 而蓄力/光柱本身的判据全绿。（装配层另有一道分流不调 onShot，这里是纵深防御。）
   */
  _emitNova({ type, weapon, sound, volume }) {
    const effect = {
      type, weaponId: weapon.id, sound, volume, recoil: 0, impacts: [],
    };
    this.lastEffect = effect;
    this.onEffect(effect);
    return effect;
  }

  /**
   * v3.20：施放 Storm Lance。
   *
   * 命中与几何经注入的 `entityQuery.sweepLance(aim, cfg)`（Game 侧调纯函数 + 逐个 `damageEntity`）。
   * ⚠️ **未注入时仍发闪电但 `hits: []`**（fixture / 旧单测不注入则走缺省，不扣血也不报错）。
   * ⚠️ **不写方块、不击退**（用户裁定：等同炸弹，而炸弹不击退）。
   * ⚠️ **`impactKind` 必须透传**：渲染层靠它判「炸在实体身上」还是「炸在地上」
   * —— 丢掉它会让打 Boss 时冲击环画在脚下地面上（R2）。
   */
  _fireStormLance(aim, weapon) {
    const cfg = weapon.stormLance;
    const sweep = typeof this.entityQuery?.sweepLance === 'function'
      ? this.entityQuery.sweepLance(aim, cfg)
      : { ...stormLanceAxis(aim, cfg), impactKind: 'air', hits: [] };
    this.cooldown = cfg.cooldown;
    this.shotsFired++;
    const effect = {
      type: 'storm-lance',
      weaponId: weapon.id,
      sound: cfg.fireSound,
      volume: cfg.fireVolume,
      recoil: 0,
      impacts: [],
      origin: sweep.origin,
      target: sweep.target,
      side: sweep.side,
      length: sweep.length,
      impactKind: sweep.impactKind ?? 'air',
      hits: sweep.hits,
      // 纯视觉随机种子（不入存档，与上游 `_seed` 同口径）：让两次施放不画完全相同的形状
      seed: Math.random() * 100,
      impactSound: cfg.impactSound,
      impactVolume: cfg.impactVolume,
    };
    this.lastEffect = effect;
    this.onEffect(effect);
    return effect;
  }

  /**
   * v3.21：抛出 Cinder Fall 的燃烧岩石。
   *
   * 与 Storm Lance 的关键差别：**本方法不做命中判定也不扣血** —— 岩石是飞行实体，
   * 命中在后续帧由 `Game._updateCinders()` 逐步判定（用户：「扔出去的球只要碰到…都爆炸」）。
   * 在招的瞬间就扫一遍射线 = 上游那套闭式弧线的做法，与「飞行中碰到就爆」相背。
   *
   * ⚠️ **`recoil` 必须是 0 而不是缺席**（同 `_emitNova`）：`view-weapon.js:onShot` 对非 melee
   * 事件写 `this._recoil = effect.recoil`，undefined 会让剑体位置 NaN ⇒ 剑从画面上消失。
   * ⚠️ **不写方块、不击退**（用户裁定：等同炸弹，而炸弹不击退）。
   *
   * @param {AimSnapshot} aim @param {object} weapon @returns {object}
   */
  _fireCinderFall(aim, weapon) {
    const cfg = weapon.cinderFall;
    // 准心命中距离（无命中 ⇒ 回落射程）—— 岩石末端仍落在准心瞄准点
    const aimDistance = aim?.target?.hit ? aim.target.dist : cfg.range;
    const launch = cinderLaunch(aim, cfg, aimDistance);
    this.cooldown = cfg.cooldown;
    this.shotsFired++;
    const effect = {
      type: 'cinder-fall',
      weaponId: weapon.id,
      sound: cfg.fireSound,
      volume: cfg.fireVolume,
      recoil: 0,
      impacts: [],
      launch,
      // 纯视觉随机种子（不入存档，与 Storm Lance 同口径）：自旋轴/熔岩缝形状不重复
      seed: Math.random() * 100,
      impactSound: cfg.impactSound,
      impactVolume: cfg.impactVolume,
    };
    this.lastEffect = effect;
    this.onEffect(effect);
    return effect;
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
      : weapon.melee
        ? this._fireMelee(aim, weapon)
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
   * v2.65 近战剑：左键挥砍。与枪的三个刻意差异（用户 2026-11-06 裁定）：
   *
   * ① **不写方块**：剑不能破坏方块（不调 `editor.setBlock`，不读 `blockDamageEnabled`）。
   * ② **不发曳光**：effect 无 `start`/`end`/`tracer`（渲染层判 `tracer` 存在才 spawn）。
   * ③ **单发**：catalog 无 `automatic`，按住不放不连砍（同 MAG7 语义）。
   *
   * 命中判据与枪同口径：`_queryEntityHit`（DDA 方块遮挡 + `entityRange` 裁剪 +
   * `WEAPON_HITTABLE_TYPES` predicate）—— 丧尸/飞龙/焰魔都打得到（剑不破坏方块，
   * 故「实体被方块挡」仍生效：隔墙砍不中）。
   *
   * 命中时额外做两件事：
   *   · `entityQuery.knockback(id, dist)` —— 击退一小步（Game 算背离方向，见注入注释）；
   *   · effect 带 `hitSound`/`hitVolume` —— 砍中音（`emp_activated`），与挥砍音分开。
   *
   * @param {AimSnapshot} aim @param {object} weapon
   * @returns {object} 效果事件（type: 'melee' 或 'melee-hit'）
   */
  _fireMelee(aim, weapon) {
    const entityHit = this._queryEntityHit(aim, weapon);
    const base = {
      type: entityHit ? 'melee-hit' : 'melee',
      weaponId: weapon.id,
      sound: weapon.sound,
      volume: weapon.volume,
      recoil: weapon.recoil,
      impacts: [],
    };
    if (!entityHit) return base;
    // 击退：方向由 Game 用玩家位置算（controller 不持有玩家位置，只传 id 与距离）
    if (typeof this.entityQuery?.knockback === 'function') {
      this.entityQuery.knockback(entityHit.entityId, weapon.knockbackDistance ?? 0.4);
    }
    return {
      ...base,
      entityId: entityHit.entityId,
      entityDamage: entityHit.entityDamage,
      hitSound: weapon.hitSound ?? null,
      hitVolume: weapon.hitVolume ?? 1,
    };
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
