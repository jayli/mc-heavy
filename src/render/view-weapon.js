// src/render/view-weapon.js — 第一人称视图模型（M4 规格 §4.2）
// 只在主线程引入 three：把已加载模型 clone 后挂到 camera（单个相机子节点，
// 不新增地形渲染通道 / InstancedMesh / BatchedMesh，也不污染 M3 draw-call 基线）。
// 每次只有当前一把枪存在；模型缓存只保存只读模板（由 WeaponModelLoader 持有），装备时 clone。
// 加特林视图节点在应用绕局部 x 轴的枪管旋转前设 rotation.order='YXZ'（避免万向锁）。
import * as THREE from 'three';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

/**
 * 近战挥砍曲线（v2.67 按原版 `ItemInHandRenderer` 重建）。
 *
 * **为何要绕「握点」转，而不是绕模型中心**（用户 2026-11-06：「原来的挥剑动作你也给
 * 简化了，也是不对的，要有一个合理的挥剑动作」）：v2.65/v2.66 只对节点做整体
 * `rotation.x -= arc`，而节点原点在**模型中心** ⇒ 整把剑绕自己的腰线像螺旋桨一样转，
 * 剑柄也跟着飞 —— 那不是挥砍，是转棍子。真实挥砍的支点是**手（握点）**，剑身在支点
 * 外侧成弧扫过。
 *
 * **三段式（不是单一 sin）**：
 *   · `attack = sin(√p·π)` —— 峰在 p≈0.25，快出慢收 ⇒ 主下劈
 *   · `whip   = sin(p²·π)` —— 峰在 p≈0.707，滞后 ⇒ 甩腕
 *   · `windup` —— 前 30% **反向抬手蓄力**，之后才砍下去
 * 四段齐（蓄力 → 快劈 → 滞腕 → 回位）才像一刀；只一个正弦峰值就是「摆了一下」。
 */
const SWORD_SWING_CURVES = Object.freeze({
  /** 快出慢收：下劈主曲线 */
  attack: (p) => Math.sin(Math.sqrt(p) * Math.PI),
  /** 滞后：甩腕曲线 */
  whip: (p) => Math.sin(p * p * Math.PI),
  /** 蓄力：前 `end` 段抬手（正），之后归 0 */
  windup: (p, end) => (p >= end ? 0 : Math.sin((p / end) * Math.PI)),
});

/** 蓄力段占比（前 30% 抬手，后 70% 砍下去） */
const SWORD_WINDUP_END = 0.3;

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

    // ---- 近战：绕「握点」挥砍 ----
    //
    // 支点 = catalog 的 `swingPivot`（**节点局部坐标**，= 剑柄末端位置 × scale）。
    // 真挥砍的支点是手，不是剑的中心 —— 绕中心转的形态是「螺旋桨」，用户已明确指出。
    // 数学：目标变换 = T(t) · R · T(−pivot)，使 pivot 在相机空间里保持不动：
    //   新位置 = 基础位置 + pivot − R · pivot
    const pivot = weapon.swingPivot ?? [0, 0, 0];
    let swingPitch = 0;
    let swingRoll = 0;
    let swingYaw = 0;
    let swingDrop = 0;
    let swingForward = 0;
    const swinging = weapon.swing && this._swingElapsed < this._swingDuration;
    if (swinging) {
      this._swingElapsed = Math.min(this._swingDuration, this._swingElapsed + dt);
      const p = this._swingElapsed / this._swingDuration;
      const attack = SWORD_SWING_CURVES.attack(p);
      const whip = SWORD_SWING_CURVES.whip(p);
      const windup = SWORD_SWING_CURVES.windup(p, SWORD_WINDUP_END);
      const w = weapon.swing;
      // 蓄力抬手（反向）+ 下劈（正向）—— 两段方向相反，合成后才是「拉起再劈」
      swingPitch = -windup * w.windupArc + attack * w.arc;
      swingRoll = whip * w.roll;
      swingYaw = whip * w.yaw;
      swingDrop = attack * w.drop;
      swingForward = attack * w.forward;
    }
    const euler = new THREE.Euler(rx + swingPitch, ry + swingYaw, rz + swingRoll, 'XYZ');
    // ⚠️ **直支点补偿只在真正挥砍时施加**：静止时必须逐位等于 catalog 的 position
    // （曾经的缺陷：无条件加 `pivot − R·pivot`，而 R 是**基础朝向**下的旋转 ⇒ 静止也把节点
    // 拉偏 (−1.195, 0.026, −2.802) vs 设定值 (−0.336, 0.719, −1.387)，剑体飞到画面中间）。
    let posX = px;
    let posY = py - drawOffset;
    let posZ = pz + this._recoil;
    if (swinging) {
      const rot = new THREE.Matrix4().makeRotationFromEuler(euler);
      const pv = new THREE.Vector3(pivot[0], pivot[1], pivot[2]);
      const rp = pv.clone().applyMatrix4(rot);
      // 目标：支点在相机空间保持不动。绕**基础**朝向的支点位置为 pv；绕当前朝向为 rp。
      // 两者之差补回节点位置，支点就不动。
      const base = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(rx, ry, rz, 'XYZ'),
      );
      const rp0 = pv.clone().applyMatrix4(base);
      posX += rp0.x - rp.x;
      posY += rp0.y - rp.y;
      posZ += rp0.z - rp.z;
    }
    this.node.position.set(posX, posY - swingDrop, posZ - swingForward);
    this.node.rotation.copy(euler);
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
