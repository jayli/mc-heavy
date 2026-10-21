// src/render/tracer-renderer.js — 曳光渲染（M4 规格 §4.2，v1.32 重做）
// 一个固定 32 slot 的 THREE.InstancedMesh 渲染曳光，通过实例颜色和矩阵区分普通枪/MAG7。
// 池满时丢弃最旧的纯视觉曳光，绝不丢弃命中或世界编辑。该 InstancedMesh 是独立的短寿命
// 视觉对象，不是地形 InstancedMesh、BatchedMesh 或第二份体素状态；销毁时从 scene 移除并释放资源。
// 曳光起点/终点都在开火瞬间【冻结在世界空间】（v1.33，设计文档 §3 有意偏离 mc-lite）：
// mc-lite 每帧以当前相机基底重算起点（PlayerInteraction.js:859），起点在相机空间、
// 终点在世界空间的混合坐标系导致快速转镜头时弹道看上去歪斜。曳光是子弹已飞完的
// 真实弹道残影（寿命 0.02~0.0375s，v1.62 缩到 mc-lite 原值的 1/4），镜头移动时整条曳光应纹丝不动——枪管转开是自然的
// （子弹早已出膛），歪斜感从机制上消失。这也是 hitscan 曳光的标准做法（DOOM/Quake 类）。
//
// v1.32 重做要点（对齐 mc-lite 粗细口径 + 修正其共享材质淡出 bug）：
//   ① 粗细：mc-lite 曳光几何为 BoxGeometry(0.05,0.05,1)（Player.js:189），截面 = 0.05×thickness
//      世界单位（手枪 0.05 / 加特林 0.025 / MAG7 0.3）。本实现用半径 0.025 的圆柱
//      （直径 0.05）× thickness 缩放，同口径。旧实现把 thickness 直接当世界单位半径
//      → 截面 20 倍过粗，相机身处管内 + 圆柱内壁背面剔除 → 玩家看不到轨迹。
//   ② 淡出：mc-lite 每帧写【共享材质】的 opacity（PlayerInteraction.js:863），所有曳光
//      共享一个值、最后更新者覆盖全部——是 bug。本实现用逐实例颜色 × 寿命比例淡出
//      （instanceColor 是 per-instance 的），每条曳光独立衰减。
//   ③ 发光：全部曳光走加法混合 + depthWrite:false（mc-lite 只有 MAG7 用加法混合），
//      亮色轨迹无透明排序伪影；淡出时颜色趋黑 = 加法混合下自然消隐。
import * as THREE from 'three';
import { MAX_ACTIVE_TRACERS } from '../player/weapons/weapon-catalog.js';

// 曳光截面基准半径：直径 0.05 世界单位 × thickness（mc-lite BoxGeometry(0.05,...) 同口径）
const TRACER_BASE_RADIUS = 0.025;

// 复用的临时对象（避免每帧分配）
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _start = new THREE.Vector3();
const _end = new THREE.Vector3();
const _color = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0); // 空闲 slot：零 scale 不可见

export class TracerRenderer {
  /**
   * @param {{scene: import('three').Scene, maxActive?: number}} deps
   */
  constructor({ scene, maxActive = MAX_ACTIVE_TRACERS }) {
    this.scene = scene;
    this.maxActive = maxActive;
    // 共享 cylinder geometry（直径 0.05，沿 +Y，开口无端帽）；一个 InstancedMesh 承载全部曳光
    this.geometry = new THREE.CylinderGeometry(TRACER_BASE_RADIUS, TRACER_BASE_RADIUS, 1, 6, 1, true);
    // 加法混合 + 不写深度：发光观感、无透明排序伪影；深度测试保留（穿墙段正常遮挡）
    this.material = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, maxActive);
    this.mesh.frustumCulled = false;
    // 无活跃曳光时整体隐藏：常驻 scene 的透明 mesh 会进入透明渲染列表，其锚点
    // （世界原点）随镜头转动与体素水/海面的排序锚点交叉，干扰 issue#2 的绘制顺序
    // 不变式（water-order.spec）。visible=false 时不提交渲染，列表回到无曳光基线。
    this.mesh.visible = false;
    // 初始化每个 slot 的 instance matrix 为零 scale（不可见）
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
    /** @type {Array<{slot:number,lifetime:number,maxLifetime:number,start:number[],end:number[],thickness:number,color:number} | null>} */
    this._slots = new Array(maxActive).fill(null);
    this._freeSlots = [];
    for (let i = maxActive - 1; i >= 0; i--) this._freeSlots.push(i); // 低位优先分配
    this._activeOrder = []; // 活跃 slot 的顺序（用于池满时回收最旧者）
  }

  /**
   * 生成一条曳光。优先取空闲 slot，满时先回收最旧者（第 33 条必定淘汰最旧）。
   * @param {{start:number[], localStart:number[], end:number[],
   *          tracer:{color:number, thickness:number, lifetime:number}}} effect
   * @returns {boolean}
   */
  spawn(effect) {
    let slot;
    if (this._freeSlots.length > 0) {
      slot = this._freeSlots.pop();
    } else {
      slot = this._activeOrder.shift(); // 回收最旧
    }
    this._slots[slot] = {
      slot,
      lifetime: effect.tracer.lifetime,
      maxLifetime: effect.tracer.lifetime,
      start: [...effect.start], // 世界空间冻结（开火瞬间的枪口世界坐标，不随相机移动）
      end: [...effect.end],
      thickness: effect.tracer.thickness,
      color: effect.tracer.color,
    };
    this._activeOrder.push(slot);
    // 实例矩阵在 spawn 时一次写入：世界起点 → 世界终点（此后 update 不再重算，v1.33）
    _start.set(effect.start[0], effect.start[1], effect.start[2]);
    _end.set(effect.end[0], effect.end[1], effect.end[2]);
    _dir.subVectors(_end, _start);
    const length = _dir.length();
    if (length > 0) {
      _dir.divideScalar(length);
      _quaternion.setFromUnitVectors(_up, _dir);
      _position.copy(_start).add(_end).multiplyScalar(0.5); // 中点
      // 截面 = 0.05×thickness 世界单位（mc-lite 口径）；长度 = 起点到终点距离
      _scale.set(effect.tracer.thickness, length, effect.tracer.thickness);
      _matrix.compose(_position, _quaternion, _scale);
      this.mesh.setMatrixAt(slot, _matrix);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    this._writeColor(slot, 1.0); // 出生满亮度
    this.mesh.visible = true; // 有活跃曳光才参与渲染（见构造器注释）
    return true;
  }

  /** @returns {number} 当前活跃曳光数 */
  get activeCount() {
    return this._activeOrder.length;
  }

  /**
   * 每帧推进：寿命衰减、逐实例颜色淡出、寿命到 0 归还 slot。
   * 起点/终点都是开火瞬间冻结的世界坐标，矩阵只在 spawn 后首次 update 写入一次即可，
   * 此后与相机无关（v1.33 世界空间冻结语义）。
   * @param {number} dt 秒
   * @param {{origin:number[], forward:number[], right:number[], up:number[]}} [_cameraBasis]
   *        保留形参兼容调用方签名；世界空间冻结后不再消费
   */
  update(dt, _cameraBasis) {
    let matrixDirty = false;
    let colorDirty = false;
    for (let i = this._activeOrder.length - 1; i >= 0; i--) {
      const slot = this._activeOrder[i];
      const rec = this._slots[slot];
      rec.lifetime -= dt;
      if (rec.lifetime <= 0) {
        this.mesh.setMatrixAt(slot, _zero);
        this._slots[slot] = null;
        this._activeOrder.splice(i, 1);
        this._freeSlots.push(slot);
        matrixDirty = true;
        continue;
      }
      // 逐实例淡出：颜色 × 寿命比例（加法混合下趋黑 = 消隐；修正 mc-lite 共享 opacity bug）
      this._writeColor(slot, rec.lifetime / rec.maxLifetime);
      colorDirty = true;
    }
    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // 全部曳光到龄后整体隐藏（回到无曳光基线，不占透明渲染列表，见构造器注释）
    if (this._activeOrder.length === 0) this.mesh.visible = false;
  }

  /** 写 slot 的实例颜色：基础色 × 淡出系数。 */
  _writeColor(slot, fade) {
    _color.setHex(this._slots[slot].color).multiplyScalar(fade);
    this.mesh.setColorAt(slot, _color);
  }

  /** 从 scene 移除这一个 mesh，并 dispose 共享 geometry/material。 */
  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this._slots.fill(null);
    this._activeOrder.length = 0;
  }
}
