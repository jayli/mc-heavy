// src/render/view-weapon.js — 第一人称视图模型（M4 规格 §4.2）
// 只在主线程引入 three：把已加载模型 clone 后挂到 camera（单个相机子节点，
// 不新增地形渲染通道 / InstancedMesh / BatchedMesh，也不污染 M3 draw-call 基线）。
// 每次只有当前一把枪存在；模型缓存只保存只读模板（由 WeaponModelLoader 持有），装备时 clone。
// 加特林视图节点在应用绕局部 x 轴的枪管旋转前设 rotation.order='YXZ'（避免万向锁）。
import * as THREE from 'three';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

/**
 * 近战挥砍曲线（v2.70：只有「扫向准心 + 收回」两段，且**纯平移、不旋转**）。
 *
 * **为何是纯平移**（用户 2026-11-06 第三轮）：「不管你怎么设计动画，都要把剑柄藏在
 * 屏幕下放，剑尖尽量指向十字准心，**剑体不要旋转**，保持跟开始时旋转姿态一致」。
 * 之前两轮都是靠旋转实现挥砍 —— 旋转必然改变剑的朝向（用户能直接看出来），
 * 而且绕手的半径会把剑尖甩到屏外。改成平移后，姿态逐位等于 catalog 的基础值，
 * 只有位置在动：剑柄始终在屏幕下方外，剑尖扫到准心。
 *
 * **两段**（第二轮：「我只需执行两个动作，一个是向前挥砍，一个是挥砍结束后收回」）：
 * `strike` 单调 0→1（扫向准心），`recover` 单调 1→0（沿原路收回）。
 * 用 1−(1−t)² 而不用 sin：sin 会 0→1→0 形成一个自动回位的完整弧，
 * 两段就变成三段；单调曲线才对应「一刀扫出去、再收回来」。
 */
const SWORD_SWING_CURVES = Object.freeze({
  /**
   * 挥砍段曲线：`end` 之前 0→1 单调递增（砍出去），之后交给收回段。
   * 用 1−(1−t)² 而不是 sin：sin 会 0→1→0 形成一个「抡出去再自己抽回来」的完整弧，
   * 两段变三段；单调曲线才对应「一刀砍到底」。
   */
  strike: (p, end) => (p >= end ? 1 : 1 - Math.pow(1 - p / end, 2)),
  /** 收回段曲线：`end` 之后 1→0 单调退回；走平缓的 cos 避免收刀太快像弹回 */
  recover: (p, end) => (p <= end ? 1 : 1 - Math.sin(((p - end) / (1 - end)) * Math.PI / 2)),
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
    // 在触发挥砍时写入（写第二份时长字面量就是红线 1，调参时会漂移成「动画与判据不同长」）。
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
      // 时长唯一权威 = catalog 的 `swingSeconds`（缺省 0.225 只作纵深防御，
      // 正常路径下近战武器必定带这个字段）
      this._swingDuration = WEAPONS[this.selectedId]?.swingSeconds ?? 0.225;
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

    // ---- 非近战（枪）：原路径逐位不变 ----
    if (!weapon.melee) {
      this.node.position.set(px, py - drawOffset, pz + this._recoil);
      this.node.rotation.set(rx + (weapon.spin ? this._spinRotation : 0), ry, rz);
      this.node.scale.set(sx, sy, sz);
      return;
    }

    // ---- 近战：向前劈砍（绕相机 X 轴、以剑柄为支点，**不绕剑身长轴自转**）----
    //
    // 用户 2026-11-06 最终口径：「你要向前挥刀，不是向左摆刀」。
    // 历史：v2.67 绕模型中心（螺旋桨）→ v2.68 绕握点但轴向错 → v2.69 纯平移（没有砍的动作）
    // → 绕相机 Z 在屏幕平面内扇形摆（**向左摆刀**，被否掉）→ 本版绕相机 X。
    //
    // 「剑体不要旋转」的准确含义（用户澄清）：**不绕剑柄方向的轴自转**（不拧腕），
    // 但砍击弧线必须有 —— 所以旋转轴选相机 X（屏幕水平轴），
    // 负角度把剑尖朝**屏幕纵深**砍出（实测 tipZ −1.331 → −2.756，前进 1.42 格）。
    // 支点在剑柄（`swingPivot`），剑柄在相机空间里钉住不动、始终在屏幕下方外。
    //
    // ⬜ 不写 `wrist`/绕剑轴的分量：那就是用户说的「剑轴自转」，已删除。
    const pivot = weapon.swingPivot ?? [0, 0, 0];
    const swinging = weapon.swing && this._swingElapsed < this._swingDuration;
    if (swinging) {
      this._swingElapsed = Math.min(this._swingDuration, this._swingElapsed + dt);
      const p = this._swingElapsed / this._swingDuration;
      const w = weapon.swing;
      // 两段：0→strikeEnd 砍出去（strike 0→1），strikeEnd→1 收回（recover 1→0）
      const amount = p <= w.strikeEnd
        ? SWORD_SWING_CURVES.strike(p, w.strikeEnd)
        : SWORD_SWING_CURVES.recover(p, w.strikeEnd);
      const baseM = new THREE.Matrix4().compose(
        new THREE.Vector3(px, py - drawOffset, pz + this._recoil),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
        new THREE.Vector3(sx, sy, sz),
      );
      // 绕相机 X（屏幕水平轴）向前劈 + 绕相机 Y（垂直轴）向左扫：
      // dR = R_y(amount·yaw) · R_x(amount·arc) —— 先劈后扫的复合旋转（顺序不能反）。
      // 平移版（旧 `shift`）剑身姿态不变，看起来只是整把剑横着挪；旋转才是真挥扫。
      const dR = new THREE.Matrix4().makeRotationY(amount * (w.yaw ?? 0))
        .multiply(new THREE.Matrix4().makeRotationX(amount * w.arc));
      const P = new THREE.Vector3(...pivot);
      const p0 = P.clone().applyMatrix4(baseM);
      const c = p0.clone().applyMatrix4(dR.clone().invert()).applyMatrix4(baseM.clone().invert()).sub(P);
      // 左移（平移）叠在**最外层**：在相机空间直接把整个挥扫区域递向左，
      // 不改变旋转支点（`c` 的补偿）的行为。与 `yaw` 叠加 = 先左移到位、再向左挥扫。
      const shift = amount * (w.shift ?? 0);
      const M = new THREE.Matrix4().makeTranslation(shift, 0, 0)
        .multiply(dR).multiply(baseM).multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
      M.decompose(this.node.position, this.node.quaternion, this.node.scale);
      return;
    }
    this.node.position.set(px, py - drawOffset, pz + this._recoil);
    this.node.rotation.set(rx, ry, rz);
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
