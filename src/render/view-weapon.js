// src/render/view-weapon.js — 第一人称视图模型（M4 规格 §4.2）
// 只在主线程引入 three：把已加载模型 clone 后挂到 camera（单个相机子节点，
// 不新增地形渲染通道 / InstancedMesh / BatchedMesh，也不污染 M3 draw-call 基线）。
// 每次只有当前一把枪存在；模型缓存只保存只读模板（由 WeaponModelLoader 持有），装备时 clone。
// 加特林视图节点在应用绕局部 x 轴的枪管旋转前设 rotation.order='YXZ'（避免万向锁）。
import * as THREE from 'three';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

/**
 * 近战挥砍曲线（v2.69 按用户裁定重建：「挥剑是从上向下挥，抡一个半圆，然后收回」）。
 *
 * **挥砍旋转定义在相机空间，不是节点局部欧拉角**（v2.69 的根因修复）：
 * 局部欧拉轴的屏幕语义**随姿态漂移** —— 探针实测旧姿态 `x+ = 剑尖上 / y+ = 左`，
 * 换了静止姿态后变成 `x+ = 右上 / y+ = 右下 / z+ = 左下`，同一组挥砍参数在新姿态下
 * 合成出「直直向下捅」、剑体整把出屏。用户已两次改姿态，第三次必须解耦：
 * 把挥砍旋转 ΔR **前乘**到基础矩阵上（`M = ΔR · M_base · T(c)`），则
 *   · 相机 X− = 下劈（屏幕水平轴，X+ = 上）
 *   · 相机 Y+ = 横扫（屏幕垂直轴，右→左）
 *   · 绕剑身长轴 = 拧腕
 * 永远成立，与姿态无关。`T(c)` 是支点补偿：使握点（catalog `swingPivot`）在相机空间
 * 不动 —— 绕模型中心转是「螺旋桨」，用户 v2.67 已否掉。
 *
 * **半圆的合成**（相机空间，探针实测轴语义）：
 *   · 相机 **Z+ = 屏幕平面内逆时针**（剑尖从右上 → 正上 → 左上 → 左下）
 *   · 蓄力与主挥**同号**（连续逆时针）：右上 → 抬到正上 → 继续斜劈到左下，
 *     这就是右手持剑「从上向下抡一个半圆」
 *   · 收刀不走原弧（单标量 roll 0→A→0 会原路翻回屏顶）：收刀段加相机 **Y+**
 *     把回位路径沿屏底拉回，再归位
 * 甩腕 `whip` 滞后于主挥，收刀时才拧腕。
 */
const SWORD_SWING_CURVES = Object.freeze({
  /** 主挥：`end` 之后 0→1→0，快出慢收（√ 把峰值前移到 p≈0.44） */
  sweep: (p, end) => (p <= end ? 0 : Math.sin(Math.sqrt((p - end) / (1 - end)) * Math.PI)),
  /** 滞后甩腕：峰在 p≈0.707（收刀段） */
  whip: (p) => Math.sin(p * p * Math.PI),
  /** 蓄力：前 `end` 段 0→1→0（抬剑后拉），之后归 0 交给主挥 */
  windup: (p, end) => (p >= end ? 0 : Math.sin((p / end) * Math.PI)),
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

    // ---- 非近战（枪）：原路径逐位不变 ----
    if (!weapon.melee) {
      this.node.position.set(px, py - drawOffset, pz + this._recoil);
      this.node.rotation.set(rx + (weapon.spin ? this._spinRotation : 0), ry, rz);
      this.node.scale.set(sx, sy, sz);
      return;
    }

    // ---- 近战：相机空间挥砍（绕握点） ----
    //
    // ΔR 前乘到基础矩阵：挥砍轴 = 相机轴（X− 下劈 / Y+ 横扫 / 剑轴拧腕），与姿态解耦。
    // 支点补偿 T(c)：c = M_base⁻¹ · ΔR⁻¹ · p0 − P（p0 = M_base · P = 握点相机位置），
    // 使 M · P = p0 恒成立 ⇒ 握点在相机空间不动。
    const pivot = weapon.swingPivot ?? [0, 0, 0];
    const swinging = weapon.swing && this._swingElapsed < this._swingDuration;
    if (swinging) {
      this._swingElapsed = Math.min(this._swingDuration, this._swingElapsed + dt);
      const p = this._swingElapsed / this._swingDuration;
      const w = weapon.swing;
      const windup = SWORD_SWING_CURVES.windup(p, w.windupEnd);
      const sweep = SWORD_SWING_CURVES.sweep(p, w.windupEnd);
      const whip = SWORD_SWING_CURVES.whip(p);
      // 蓄力 = 相机 Z+ 抬剑到右上；主挥 = Z+ 继续逆时针斜劈（右上 → 左 → 左下），
      // 收刀 = 相机 Y+ 把回位路径沿屏底拉回（不走原弧翻回屏顶）。
      const roll = windup * w.windupRoll + sweep * w.roll;
      const chop = sweep * w.chop;      // 相机 X（带一点深度）
      const sweepYaw = sweep * w.sweep + whip * w.returnSweep; // 相机 Y（横扫横移 + 收刀）
      const wrist = whip * w.wrist;
      const baseM = new THREE.Matrix4().compose(
        new THREE.Vector3(px, py - drawOffset, pz + this._recoil),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
        new THREE.Vector3(sx, sy, sz),
      );
      // 剑身长轴（相机空间，基础姿态下）= 拧腕轴。模型 +Y 是柄→尖（几何唯一权威），
      // 用基础四元数旋到相机空间 —— 不在 catalog 写第二份轴常量。
      const axis = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')))
        .normalize();
      const dR = new THREE.Matrix4()
        .makeRotationFromQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, wrist))
        .multiply(new THREE.Matrix4().makeRotationZ(roll))
        .multiply(new THREE.Matrix4().makeRotationX(chop))
        .multiply(new THREE.Matrix4().makeRotationY(sweepYaw));
      const P = new THREE.Vector3(...pivot);
      const p0 = P.clone().applyMatrix4(baseM);
      const c = p0.clone().applyMatrix4(dR.clone().invert()).applyMatrix4(baseM.clone().invert()).sub(P);
      const M = dR.multiply(baseM).multiply(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z));
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
