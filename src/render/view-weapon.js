// src/render/view-weapon.js — 第一人称视图模型（M4 规格 §4.2）
// 只在主线程引入 three：把已加载模型 clone 后挂到 camera（单个相机子节点，
// 不新增地形渲染通道 / InstancedMesh / BatchedMesh，也不污染 M3 draw-call 基线）。
// 每次只有当前一把枪存在；模型缓存只保存只读模板（由 WeaponModelLoader 持有），装备时 clone。
// 加特林视图节点在应用绕局部 x 轴的枪管旋转前设 rotation.order='YXZ'（避免万向锁）。
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

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
    this.camera.add(clone);
    this.update(0, { shooting: false }); // 立即写入 catalog transform
    return this.selectedId;
  }

  /** 开火时由控制器调用：把当前后坐设为效果事件的后坐值。 */
  onShot(effect) {
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
    this.node.position.set(px, py - drawOffset, pz + this._recoil);
    const [rx, ry, rz] = weapon.transform.rotation;
    // rotation.x = baseRotationX + spinRotation（加特林）；Euler order 在 select 时已设
    this.node.rotation.set(rx + (weapon.spin ? this._spinRotation : 0), ry, rz);
    const [sx, sy, sz] = weapon.transform.scale;
    this.node.scale.set(sx, sy, sz);
  }

  /** @returns {{selectedId: string, loaded: boolean, rotationOrder: string | undefined}} */
  get state() {
    return {
      selectedId: this.selectedId,
      loaded: this.node !== null,
      rotationOrder: this.node ? this.node.rotation.order : undefined,
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
