// src/render/zombie-renderer.js — M6：丧尸六部件实例渲染（M6 规格 §3）
//
// 只读 pose 的**受控发布层**：不回写 state、不调 `world.setBlock`、不作命中真相
// （实体命中只由 `EntityManager.raycast()` 给出 —— 红线 6 禁止 Raycaster）。
//
// 为什么是六个固定容量 20 的 `InstancedMesh` 而不是每尸一个 Group：M5 的
// `entity-render-layer.js` 已注明「每实体一个 Group 在 20+ 实体时是性能反模式」，
// M6 规格 §3 明令不得为每只丧尸创建 Group、不得导入 GLB。六个部件 mesh 常驻 scene，
// 每只丧尸占同一个索引，死亡/卸载/dispose 对称归还 —— draw call 恒为 6，与丧尸数无关。
//
// 部件尺寸/偏移/旋转/配色全部实测自 mc-lite `src/actors/enemy/ZombieInstancedRenderer.js`
// （`:28-82` 常量表 + `:176-210` 几何构造 + `:548-566` 矩阵计算），非凭字段名推断。
// **两处必须照搬的细节**（照字段名实现会渲错）：
// ① leg 几何做了 `translate(0, -height/2, 0)`（mc-lite `:203`）→ 几何原点在大腿**根部**而非
//    盒中心，故 offset `y=0.9` 是轴心高度、盒体向下延伸 1.0。不做 translate 则整条腿随摆动
//    平移（像踩高跷），而不是绕髋部扫弧线 —— 行走动画的关键。
// ② head 的 `ZOMBIE_COLORS.head = 0xffffff` 是**白底乘纹理色**（mc-lite 六面材质 color 全是
//    白色，真实颜色由马赛克纹理给，`headPalette.base = [64,107,48]`）。本仓库不做 CanvasTexture
//    （M6 规格 §3 只要求「配色沿 mc-lite」），故直接用其视觉色 `0x406b30` —— 照 `0xffffff`
//    实现会渲染成纯白头。这是**有意偏离**（无纹理），已在此标注。
//
// 材质用 `MeshBasicMaterial`（unlit）而非 mc-lite 的 `MeshLambertMaterial`：mc-heavy 全场景
// 是 unlit 设计，灯光只为 PBR 武器模型而设（`game.js` 的 Ambient/Directional 注释）。用 Lambert
// 会让丧尸吃到为枪标定的 2.3 环境光强度 → 偏亮且随日夜灯光漂移。与 ocean/rain/tracer 同口径。
import * as THREE from 'three';
import { ZOMBIE, ZOMBIE_FLASH_MS, ZOMBIE_WALK_SPEED, ZOMBIE_SWING, ZOMBIE_MOVING_EPSILON } from '../entities/zombies/zombie-config.js';

/** 六部件顺序（M6 规格 §3）。测试断言其长度与集合，勿增删部件 */
export const ZOMBIE_PARTS = Object.freeze([
  'head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
]);

/**
 * 部件定义（mc-lite `BODY_PART_SIZES` / `BODY_PART_OFFSETS` / `BODY_PART_ROTATIONS` /
 * `ZOMBIE_COLORS` 逐项对应）。offset 是部件相对丧尸脚底的本地偏移（腿为轴心，其余为盒中心）。
 */
export const ZOMBIE_PART_DEFS = Object.freeze({
  head: { size: [0.6, 0.6, 0.6], offset: [0, 1.8, 0], rotation: [0, 0, 0], color: 0x406b30 },
  body: { size: [0.55, 0.63, 0.45], offset: [0, 1.15, 0], rotation: [0, 0, 0], color: 0x037c7c },
  leftArm: { size: [0.23, 0.8, 0.23], offset: [-0.43, 1.3, 0.3], rotation: [-Math.PI / 2.4, 0, 0], color: 0x699058 },
  rightArm: { size: [0.23, 0.8, 0.23], offset: [0.43, 1.3, 0.3], rotation: [-Math.PI / 2.7, 0, 0], color: 0x699058 },
  leftLeg: { size: [0.26, 1.0, 0.26], offset: [-0.14, 0.9, 0], rotation: null, color: 0x322b71 },
  rightLeg: { size: [0.26, 1.0, 0.26], offset: [0.14, 0.9, 0], rotation: null, color: 0x322b71 },
});

/** 受伤红闪色（mc-lite `ZOMBIE_COLORS.flash`） */
const FLASH_COLOR = 0xff0000;
// 红闪用**独立** Color 实例：若复用 `_color`，上一个部件写的基色会污染它 ——
// 当前恰好不出错只因「同一 pose 的红闪对六部件一致」，改部件顺序即引入 bug。
const _flashColor = new THREE.Color(FLASH_COLOR);

// 复用的临时对象（避免每帧分配，与 tracer-renderer.js 同口径）
const _local = new THREE.Object3D();
const _parent = new THREE.Object3D();
const _matrix = new THREE.Matrix4();
const _color = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0); // 空闲 slot：零 scale 不可见

export class ZombieRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number}} deps
   */
  constructor({ scene, maxActive = ZOMBIE.maxActive }) {
    this.scene = scene;
    this.maxActive = maxActive;
    /** @type {Object<string, THREE.InstancedMesh>} part → 固定容量实例池 */
    this.meshes = {};
    /** @type {Object<string, THREE.BoxGeometry>} 各部件几何（dispose 时释放） */
    this._geometries = {};

    for (const part of ZOMBIE_PARTS) {
      const def = ZOMBIE_PART_DEFS[part];
      const geometry = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
      // 腿：轴心移到大腿根部（mc-lite `:203`）。见文件头「必须照搬的细节」①
      if (part === 'leftLeg' || part === 'rightLeg') geometry.translate(0, -def.size[1] / 2, 0);
      // 材质基色白：真实颜色走 instanceColor（mc-lite 同口径 —— 六面材质 color 全是 0xffffff）
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mesh = new THREE.InstancedMesh(geometry, material, maxActive);
      mesh.name = `zombie:${part}`; // 受控标识：测试与调试据此定位节点
      mesh.frustumCulled = false;   // 丧尸可能在视锥边缘可见（mc-lite 同款）
      // **无活跃丧尸时整体隐藏**（与 tracer-renderer.js 同一手法与理由）：
      // InstancedMesh 的 `count` 在构造期就是 maxActive=20，即使全部 slot 是零 scale，
      // mesh 仍会被提交渲染 → **六个常驻 mesh 恒增 6 个 draw call**（bench 实测
      // 场景 ④ draw 530 → 536）。绝大多数游玩时间里场上没有丧尸，这 6 个 draw call 纯属浪费。
      // `visible=false` 时不提交渲染，draw call 回到无丧尸基线；有丧尸才置 true。
      mesh.visible = false;
      // 初始化每个 slot 为零 scale（不可见）+ 基色，避免首帧残留未初始化矩阵
      for (let i = 0; i < maxActive; i++) {
        mesh.setMatrixAt(i, _zero);
        mesh.setColorAt(i, _color.setHex(def.color));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this.meshes[part] = mesh;
      this._geometries[part] = geometry;
      mesh.userData.material = material; // dispose 需要（InstancedMesh.dispose 不释放材质）
    }

    /** @type {Map<string, number>} entityId → slot（由 ZombieService 分配，本层只接收） */
    this._slots = new Map();
    /** @type {Array<{walkTime: number, swing: number, flashing: boolean, position: number[], yaw: number}|null>} */
    this._poses = new Array(maxActive).fill(null);
    /** @type {number} 上次 sync 的时间戳（ms），用于算 dt 累积步态相位 */
    this._lastSyncMs = null;
  }

  /**
   * 占用一个 slot（由 `ZombieService.spawn` 的 `onSpawn` 钩子调用）。
   * **slot 单一权威在 service**（它管 20 上限）—— 本层不自建第二份 slot 池（红线 1）。
   * @param {string} id @param {number} slot
   */
  acquireSlot(id, slot) {
    this._slots.set(id, slot);
    this._poses[slot] = { walkTime: 0, swing: 0, flashing: false, position: [0, 0, 0], yaw: 0 };
    for (const part of ZOMBIE_PARTS) this.meshes[part].visible = true; // 有丧尸才提交渲染
  }

  /** 归还 slot（由 `ZombieService` 的三条回收路径调用）：清空六部件矩阵，不留残影 */
  releaseSlot(id) {
    const slot = this._slots.get(id);
    if (slot === undefined) return;
    this._slots.delete(id);
    this._poses[slot] = null;
    for (const part of ZOMBIE_PARTS) {
      this.meshes[part].setMatrixAt(slot, _zero);
      this.meshes[part].instanceMatrix.needsUpdate = true;
    }
    // 全部丧尸归还后回到隐藏基线（draw call 不再恒增 6，见构造器注释）
    if (this._slots.size === 0) {
      for (const part of ZOMBIE_PARTS) this.meshes[part].visible = false;
    }
  }

  /** @param {string} id @returns {number|null} 只读测试接口 */
  slotOf(id) {
    const slot = this._slots.get(id);
    return slot === undefined ? null : slot;
  }

  /** @returns {number} 当前活动 slot 数（恒等于丧尸数 —— 生命周期对称） */
  activeCount() { return this._slots.size; }

  /**
   * 每帧发布 pose：位置/朝向 + 步态 + 红闪。
   *
   * 步态口径 = mc-lite `calculateWalkAnimation`：移动中 `walkTime += dt`，摆幅
   * `sin(walkTime × WALK_SPEED) × SWING`，静止时归零（**不是冻结在上一个摆幅**）。
   * dt 从 `nowMs` 与上次 sync 的差值算出 —— 调用方传的是时间戳，不是 dt。
   *
   * @param {import('../entities/zombies/zombie-system.js').ZombieService} zombies 只读枚举
   * @param {number} nowMs 时间戳（ms）；红闪判定 `nowMs < flashedUntil` 也用它
   */
  sync(zombies, nowMs) {
    const dt = this._lastSyncMs === null ? 0 : Math.max(0, (nowMs - this._lastSyncMs) / 1000);
    this._lastSyncMs = nowMs;

    for (const [id, slot] of this._slots) {
      const state = zombies.get(id);
      if (!state) continue; // 已回收但 slot 未归还：releaseSlot 负责清矩阵
      const pose = this._poses[slot];
      pose.position = [...state.position];
      pose.yaw = state.yaw;

      // 步态：水平速度非零才算移动（mc-lite `Math.abs(velocity.x) > 0.001`）
      const moving = Math.abs(state.velocity[0]) > ZOMBIE_MOVING_EPSILON
        || Math.abs(state.velocity[2]) > ZOMBIE_MOVING_EPSILON;
      if (moving) {
        pose.walkTime += dt;
        pose.swing = Math.sin(pose.walkTime * ZOMBIE_WALK_SPEED) * ZOMBIE_SWING;
      } else {
        pose.walkTime = 0;
        pose.swing = 0;
      }
      pose.flashing = nowMs < state.flashedUntil;
      this._writeSlot(slot, pose);
    }
  }

  /** @param {number} slot @param {'leftLeg'|'rightLeg'} [part] @returns {number} 只读测试接口 */
  legSwingOf(slot, part = 'leftLeg') {
    const pose = this._poses[slot];
    if (!pose) return 0;
    return part === 'rightLeg' ? -pose.swing : pose.swing;
  }

  /** @param {number} slot @returns {boolean} 只读测试接口：该 slot 当前是否红闪 */
  isFlashing(slot) { return !!this._poses[slot]?.flashing; }

  /** @param {number} slot @returns {{position: number[], yaw: number}|null} 只读测试接口 */
  poseOf(slot) {
    const pose = this._poses[slot];
    return pose ? { position: [...pose.position], yaw: pose.yaw } : null;
  }

  /** 写一个 slot 的六部件矩阵与颜色（父级 yaw × 部件本地偏移/旋转，mc-lite `:548-566` 同构） */
  _writeSlot(slot, pose) {
    _parent.position.set(pose.position[0], pose.position[1], pose.position[2]);
    _parent.rotation.set(0, pose.yaw, 0);
    _parent.updateMatrix();
    const flash = pose.flashing;

    for (const part of ZOMBIE_PARTS) {
      const def = ZOMBIE_PART_DEFS[part];
      _local.position.set(def.offset[0], def.offset[1], def.offset[2]);
      if (part === 'leftLeg') _local.rotation.set(pose.swing, 0, 0);
      else if (part === 'rightLeg') _local.rotation.set(-pose.swing, 0, 0); // 右腿取反
      else _local.rotation.set(def.rotation[0], def.rotation[1], def.rotation[2]);
      _local.scale.set(1, 1, 1);
      _local.updateMatrix();
      _matrix.multiplyMatrices(_parent.matrix, _local.matrix);
      const mesh = this.meshes[part];
      mesh.setMatrixAt(slot, _matrix);
      mesh.setColorAt(slot, flash ? _flashColor : _color.setHex(def.color));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 反向释放：从 scene 移除六部件并释放几何/材质，slot 全部清空 */
  dispose() {
    for (const part of ZOMBIE_PARTS) {
      const mesh = this.meshes[part];
      this.scene.remove(mesh);
      mesh.dispose();
      this._geometries[part].dispose();
      mesh.userData.material?.dispose?.();
    }
    this._slots.clear();
    this._poses.fill(null);
  }
}

/** 供测试/调试读取的冻结常量（避免各处重复字面量） */
export { ZOMBIE_FLASH_MS };
