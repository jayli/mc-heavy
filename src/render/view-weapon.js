// src/render/view-weapon.js — 第一人称视图模型（M4 规格 §4.2）
// 只在主线程引入 three：把已加载模型 clone 后挂到 camera（单个相机子节点，
// 不新增地形渲染通道 / InstancedMesh / BatchedMesh，也不污染 M3 draw-call 基线）。
// 每次只有当前一把枪存在；模型缓存只保存只读模板（由 WeaponModelLoader 持有），装备时 clone。
// 加特林视图节点在应用绕局部 x 轴的枪管旋转前设 rotation.order='YXZ'（避免万向锁）。
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

/**
 * 近战剑挥砍动画参数（v2.65）。曲线与 `view-arm.js` 的 attack/whip 同口径：
 *   · `attack = sin(√p·π)` —— 峰值在 p≈0.25（快出慢收），主下劈跟这条；
 *   · `whip   = sin(p²·π)` —— 峰值在 p≈0.707（滞后），甩腕（roll）跟这条。
 * 时长由 catalog 的 `swingSeconds`（0.3s）给，不在这里写第二份。
 */
const SWORD_SWING = Object.freeze({
  /** 下劈幅度（弧度，绕 x 轴）：从举起姿态向前下砍 */
  arc: 1.4,
  /** 甩腕幅度（弧度，绕 z 轴）：滞后于主劈，给「手腕一抖」的质感 */
  roll: 0.35,
  /** 挥砍时向前探的位移（格） */
  forward: 0.2,
  /** 挥砍时向下的位移（格） */
  drop: 0.1,
});

export class ViewWeapon {
  /**
   * @param {{camera: import('three').PerspectiveCamera,
   *          modelLoader: import('./weapon-model-loader.js').WeaponModelLoader}} deps
   */
  constructor({ camera, modelLoader }) {
    this.camera = camera;
    this.modelLoader = modelLoader;
    this.selectedId = WEAPON_IDS.ARM;
    /** @type {import('three').Group | null} 当前挂在 camera 上的视图节点 */
    this.node = null;
    this._token = 0; // 异步加载竞态守卫：只有最新 select 的结果才挂载
    this._recoil = 0;
    this._drawProgress = 1; // 举枪进度（0=收起，1=就位）
    this._spinRotation = 0; // 加特林枪管累计转角
    this._spinVelocity = 0; // 加特林枪管角速度 rad/s
    // v2.65 近战剑挥砍：_swingElapsed ≥ _swingDuration 表示未在挥砍。
    // ⚠️ 时长**不在这里写字面量**：唯一权威是 catalog 的 `swingSeconds`，由 `onShot()`
    // 在触发挥砍时写入（写第二份 0.3 就是红线 1，调参时会漂移成「动画与判据不同长」）。
    this._swingElapsed = Infinity;
    this._swingDuration = Infinity;
  }

  /**
   * 切换视图模型。arm 时移除现有节点；其他 id 异步加载 clone，
   * 仅当请求 token 仍为最新时才挂载（防止快速切枪的加载竞态）。
   * @param {string} id @returns {Promise<string>} 当前实际选中的 id
   */
  async select(id) {
    const token = ++this._token;
    if (id === WEAPON_IDS.ARM) {
      this._removeNode();
      this.selectedId = WEAPON_IDS.ARM;
      return this.selectedId;
    }
    if (!WEAPONS[id]) return this.selectedId; // 非法 id 不改变状态
    const clone = await this.modelLoader.load(id);
    if (token !== this._token) return this.selectedId; // 已被更新的 select 取代，丢弃本次 clone
    this._removeNode();
    const weapon = WEAPONS[id];
    if (weapon.transform.rotationOrder) clone.rotation.order = weapon.transform.rotationOrder;
    this.selectedId = id;
    this.node = clone;
    this._drawProgress = 0; // 从收起状态举起
    this._recoil = 0;
    this._spinRotation = 0;
    this._spinVelocity = 0;
    this._swingElapsed = Infinity; // 切枪时不在挥砍中
    this.camera.add(clone);
    this.update(0, { shooting: false }); // 立即写入 catalog transform
    return this.selectedId;
  }

  /**
   * 开火时由控制器调用：把当前后坐设为效果事件的后坐值。
   * v2.65：近战效果（`melee`/`melee-hit`）不产生后坐，而是触发挥砍动画。
   */
  onShot(effect) {
    if (effect.type === 'melee' || effect.type === 'melee-hit') {
      this._swingElapsed = 0;
      // 时长唯一权威 = catalog 的 `swingSeconds`（缺省 0.3 只作纵深防御，
      // 正常路径下近战武器必定带这个字段）
      this._swingDuration = WEAPONS[this.selectedId]?.swingSeconds ?? 0.3;
      return;
    }
    this._recoil = effect.recoil;
  }

  /**
   * 每帧推进：举枪缓动、后坐衰减、加特林枪管旋转，并把 catalog transform 写入节点。
   * 帧率无关：插值系数用 Math.pow(retention, dt*60) 折算到 60Hz 口径。
   * @param {number} dt 秒 @param {{recoil?: number, shooting?: boolean}} [opts]
   */
  update(dt, { shooting = false } = {}) {
    if (!this.node) return;
    const weapon = WEAPONS[this.selectedId];
    if (!weapon) return;
    // 举枪：drawProgress 向 1 收敛，未就位时下移 pow(1-p,2)*1.2
    this._drawProgress = Math.min(1, this._drawProgress + dt * 4);
    const drawOffset = Math.pow(1 - this._drawProgress, 2) * 1.2;
    // 后坐衰减（mc-lite 60Hz 0.8 口径折算）
    this._recoil *= Math.pow(0.8, dt * 60);
    // 加特林枪管：射击时向 targetRadiansPerSecond 插值，停火时向 0 插值
    if (weapon.spin) {
      const retention = shooting
        ? weapon.spin.shootingRetentionAt60Hz
        : weapon.spin.idleRetentionAt60Hz;
      const target = shooting ? weapon.spin.targetRadiansPerSecond : 0;
      this._spinVelocity += (target - this._spinVelocity) * (1 - Math.pow(retention, dt * 60));
      this._spinRotation += this._spinVelocity * dt;
    }
    const [px, py, pz] = weapon.transform.position;
    const [rx, ry, rz] = weapon.transform.rotation;
    const [sx, sy, sz] = weapon.transform.scale;

    // v2.65 近战剑挥砍：推进进度并叠加弧线运动（枪无此分支，逐位不变）
    let swingDrop = 0;
    let swingForward = 0;
    let swingArc = 0;
    let swingRoll = 0;
    if (weapon.melee && this._swingElapsed < this._swingDuration) {
      this._swingElapsed = Math.min(this._swingDuration, this._swingElapsed + dt);
      const p = this._swingElapsed / this._swingDuration;
      const attack = Math.sin(Math.sqrt(p) * Math.PI); // 快出曲线（主下劈）
      const whip = Math.sin(p * p * Math.PI);          // 滞后曲线（甩腕）
      swingDrop = attack * SWORD_SWING.drop;
      swingForward = attack * SWORD_SWING.forward;
      swingArc = attack * SWORD_SWING.arc;
      swingRoll = whip * SWORD_SWING.roll;
    }

    this.node.position.set(px, py - drawOffset - swingDrop, pz + this._recoil - swingForward);
    // rotation.x = baseRotationX + spinRotation（加特林）− swingArc（剑下劈）；
    // Euler order 在 select 时已设
    this.node.rotation.set(
      rx + (weapon.spin ? this._spinRotation : 0) - swingArc,
      ry,
      rz + swingRoll,
    );
    this.node.scale.set(sx, sy, sz);
  }

  /** @returns {{selectedId: string, loaded: boolean, rotationOrder: string | undefined, swingProgress: number}} */
  get state() {
    // 挥砍进度（0..1，1 = 未在挥砍）—— 供测试断言「挥砍动画已触发」
    const swingProgress = this._swingElapsed >= this._swingDuration
      ? 1
      : this._swingElapsed / this._swingDuration;
    return {
      selectedId: this.selectedId,
      loaded: this.node !== null,
      rotationOrder: this.node ? this.node.rotation.order : undefined,
      swingProgress,
    };
  }

  /** 从 camera 移除视图节点；不 dispose WeaponModelLoader 的共享 geometry/material。 */
  dispose() {
    this._token++; // 让在途的异步加载结果作废
    this._removeNode();
    this.selectedId = WEAPON_IDS.ARM;
  }

  _removeNode() {
    if (this.node) {
      this.camera.remove(this.node);
      this.node = null;
    }
  }
}
