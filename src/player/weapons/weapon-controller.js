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
  constructor({ registry, blockQuery, editor, onEffect = () => {} }) {
    this.registry = registry;
    this.blockQuery = blockQuery;
    this.editor = editor;
    this.onEffect = onEffect;
    this.selectedId = WEAPON_IDS.ARM;
    this.cooldown = 0;
    this.triggerHeld = false;
    this.shotsFired = 0;
    this.blockDamageEnabled = false; // 保留 mc-lite 的安全默认值
    this.lastEffect = null;
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

  /** 手枪/加特林：首个 DDA 方块阻挡并决定曳光终点；开关开启且可破坏才写世界。 */
  _fireHitscan(aim, weapon) {
    const { origin, forward, target } = aim;
    let end;
    if (target && target.hit) {
      end = [
        origin[0] + forward[0] * target.dist,
        origin[1] + forward[1] * target.dist,
        origin[2] + forward[2] * target.dist,
      ];
      const [bx, by, bz] = target.blockPos;
      const hitId = this.blockQuery.getBlockId(bx, by, bz);
      if (this.blockDamageEnabled && isWeaponDestructible(hitId, this.registry)) {
        this.editor.setBlock({ x: bx, y: by, z: bz, id: 0 });
      }
    } else {
      end = [
        origin[0] + forward[0] * MISS_RANGE,
        origin[1] + forward[1] * MISS_RANGE,
        origin[2] + forward[2] * MISS_RANGE,
      ];
    }
    return this._makeEffect(weapon, aim, end);
  }

  /**
   * MAG7：无视开关，一次批量编辑提交全部可破坏候选（M4 有意偏离 mc-lite 的分批定时器）。
   * 曳光终点必须在准心轴上（见 MAG7_MISS_RANGE 注释）：3×3 体积扫描的首个候选常在准心轴
   * 之外（right/up 基底上 i,j∈{-1,0,1}），拿它当终点会让曳光斜向偏转、与枪管方向不对齐。
   */
  _fireMag7(aim, weapon) {
    const changes = collectMag7Changes(aim, this.blockQuery, this.registry);
    if (changes.length > 0) this.editor.setBlocks(changes);
    // 终点距离 = 准心射线的命中距离（钳到扫描范围上限），无命中则取上限。
    // 不用普通枪的 target.dist 原值：主 DDA 的 REACH=40 远超 MAG7 的 1~10 格扫描范围，
    // 曳光延伸到 40 格会宣称「打到了扫描范围之外」。
    const { origin, forward, target } = aim;
    const dist = target && target.hit
      ? Math.min(target.dist, MAG7_MISS_RANGE)
      : MAG7_MISS_RANGE;
    const end = [
      origin[0] + forward[0] * dist,
      origin[1] + forward[1] * dist,
      origin[2] + forward[2] * dist,
    ];
    return this._makeEffect(weapon, aim, end);
  }

  /** 组装纯效果事件：start 按相机基底展开 localStart。 */
  _makeEffect(weapon, aim, end) {
    const { origin, forward, right, up } = aim;
    const [lsx, lsy, lsz] = weapon.localStart;
    return {
      type: 'shot',
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
    };
  }
}

/**
 * @typedef {{origin: number[], forward: number[], right: number[], up: number[],
 *            target: ({hit: boolean, blockPos?: number[], dist?: number} | null)}} AimSnapshot
 */
