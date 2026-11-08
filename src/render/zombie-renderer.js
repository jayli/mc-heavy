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
// 部件尺寸/轴心/退回色的**权威在 `zombie-model.js`**（原版 Minecraft 人形口径：头 8³ /
// 躯干 8×12×4 / 肢 4×12×4，总共 32px = 2.0 格，脚底贴地 0）。本文件只做投影 +
// 渲染层专属的两个东西：臂的基准前伸角、步态摆幅。
//
// **两处必须照搬的细节**：
// ① 臂/腿的几何做了 `translate(0, -height/2, 0)`（`pivotAtTop`）→ 几何原点在**关节那一端**
//    （肩/髄）而非盒中心，故 offset 是轴心高度、盒体向下延伸整段。不做 translate 则肢体随摆动
//    平移（像踩高跷），而不是绕关节扫弧线 —— 行走动画的关键。
// ② 有纹理时六部件的 instanceColor 必须是**白底**（`0xffffff`）—— 真实颜色由皮肤给。
//    乘上任何深色基色都会「深色 × 深色」严重变暗。
//
// **皮肤：单纹理 + 单材质 + 每面 UV 矩形，而非材质数组 + geometry.groups**。
// **本仓库的 WebGPU 后端不支持材质数组** —— 实测（红/绿两材质 + 读渲染像素）：正面像素是
// `[255,0,0]` 红而非绿，即六面恒用 `material[0]`。根因在 `three.webgpu.js:34592`
// `getMaterial()` 直接 `return material`，不遍历 `geometry.groups`、不取 `materialIndex`
// （WebGL 后端 `:30472` 则按 group 分次 draw → 是 WebGPU 后端**刻意不实现**，非整体不支持）。
// 故走**标准 64×64 皮肤 + 每面 UV 矩形**（`ZOMBIE_SKIN_UV`）：一个纹理、一个材质、6 个 draw call。
//
// 材质用 `MeshBasicMaterial`（unlit）而非 mc-lite 的 `MeshLambertMaterial`：mc-heavy 全场景
// 是 unlit 设计，灯光只为 PBR 武器模型而设（`game.js` 的 Ambient/Directional 注释）。用 Lambert
// 会让丧尸吃到为枪标定的 2.3 环境光强度 → 偏亮且随日夜灯光漂移。与 ocean/rain/tracer 同口径。
import * as THREE from 'three';
import {
  ZOMBIE, ZOMBIE_FLASH_MS, ZOMBIE_WALK_SPEED, ZOMBIE_SWING, ZOMBIE_MOVING_EPSILON,
  ZOMBIE_ARM_SWING, ZOMBIE_HEAD_SWAY, ZOMBIE_STEP_LIFT,
} from '../entities/zombies/zombie-config.js';
import { StepLift } from '../player/step-lift.js';
import { KnockbackEase } from './knockback-ease.js';
import {
  ZOMBIE_MODEL_DEFS, ZOMBIE_SKIN_UV, ZOMBIE_UV_FACES, remapFaceUV,
} from './zombie-model.js';

/** 六部件顺序（M6 规格 §3）。测试断言其长度与集合，勿增删部件 */
export const ZOMBIE_PARTS = Object.freeze([
  'head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
]);

/**
 * head 几何的**正面顶点索引**（UV 分区用）。
 *
 * `BoxGeometry` 面序 `[右,左,上,下,前,后]`，每面 4 顶点 → 正面（pz）是顶点 **16-19**。
 * 实测钉住（探测：给正面单独改 UV，读渲染像素确认生效）—— 面序错了会让眼睛画到侧面/顶面。
 */
export const HEAD_FRONT_VERTICES = Object.freeze([16, 17, 18, 19]);

/**
 * 部件定义（渲染层面向的表）。
 *
 * **尺寸/轴心/退回色全部派生自 `zombie-model.js`**（红线 1：同一事实只有一份权威，
 * 渲染器与单测都从它投影）。这里只额外持有**渲染层专属**的东西：臂的基准前伸角
 * （原版丧尸的手往前伸，不是垂在体侧）、以及腿的 `rotation: null`（摆幅由步态给）。
 *
 * `offset` = 模型轴心（`pivot`）：头/躯干是盒中心，臂/腿是关节所在那一端。
 */
export const ZOMBIE_PART_DEFS = Object.freeze({
  head: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.head.size,
    offset: ZOMBIE_MODEL_DEFS.head.pivot,
    rotation: Object.freeze([0, 0, 0]),
    color: ZOMBIE_MODEL_DEFS.head.fallbackColor,
  }),
  body: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.body.size,
    offset: ZOMBIE_MODEL_DEFS.body.pivot,
    rotation: Object.freeze([0, 0, 0]),
    color: ZOMBIE_MODEL_DEFS.body.fallbackColor,
  }),
  leftArm: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.leftArm.size,
    offset: ZOMBIE_MODEL_DEFS.leftArm.pivot,
    // 基准前伸角：原版丧尸的手**向身前平举**。臂的几何轴是 -Y（从肩往下），
    // 绕 **X 轴**转约 -π/2 把它从「朝下」转到「朝 +Z（身前）」；少转一点让手略微下垂。
    // Z 轴保持 0（不外张）：原版丧尸的双臂就是从肩上**向前直伸**、几乎平行。
    // ⚠️ 加外张角（实测试过 ±0.10π）会让双臂像企鹅一样摊开 —— 那不是原版观感。
    // 肩端的袖子本来就会被躯干挡住一半，这是正确的（原版也如此）。
    rotation: Object.freeze([-Math.PI / 2 + 0.12 * Math.PI, 0, 0]),
    color: ZOMBIE_MODEL_DEFS.leftArm.fallbackColor,
  }),
  rightArm: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.rightArm.size,
    offset: ZOMBIE_MODEL_DEFS.rightArm.pivot,
    rotation: Object.freeze([-Math.PI / 2 + 0.09 * Math.PI, 0, 0]),
    color: ZOMBIE_MODEL_DEFS.rightArm.fallbackColor,
  }),
  leftLeg: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.leftLeg.size,
    offset: ZOMBIE_MODEL_DEFS.leftLeg.pivot,
    rotation: null, // 摆幅由步态运行时给，不是静态旋转
    color: ZOMBIE_MODEL_DEFS.leftLeg.fallbackColor,
  }),
  rightLeg: Object.freeze({
    size: ZOMBIE_MODEL_DEFS.rightLeg.size,
    offset: ZOMBIE_MODEL_DEFS.rightLeg.pivot,
    rotation: null,
    color: ZOMBIE_MODEL_DEFS.rightLeg.fallbackColor,
  }),
});

/**
 * 按 `ZOMBIE_SKIN_UV` 把六个面的 UV 逐面重映射到皮肤矩形（标准 64×64 版式）。
 *
 * 取代旧版只改正面（`applyHeadUV`）的做法：旧版只有头有贴图，躯干四肢是纯色；
 * 现在六部件共用一张皮肤，每一面都从自己的矩形采样。
 * **支持反向矩形**（如 `body.py = [28,16,20,20]`）—— 规范化会让那些面水平镜像。
 */
function applySkinUV(geometry, part, flipY) {
  const uv = geometry.getAttribute('uv');
  const table = ZOMBIE_SKIN_UV[part];
  for (let faceIndex = 0; faceIndex < ZOMBIE_UV_FACES.length; faceIndex++) {
    remapFaceUV(uv, faceIndex, table[ZOMBIE_UV_FACES[faceIndex]], flipY);
  }
}

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
   * @param {{scene: THREE.Scene, maxActive?: number, skinTexture?: THREE.Texture|null}} deps
   *   `skinTexture` 可选（`loadZombieSkinTexture()` 的产物，标准 64×64 皮肤）：
   *   有则六部件都按 `ZOMBIE_SKIN_UV` 的矩形采样（头部的正面矩形里有眼睛）；
   *   无则六部件退回各自的纯色（单测 fixture 不需纹理也能跑）。
   */
  constructor({ scene, maxActive = ZOMBIE.maxActive, skinTexture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    /** @type {THREE.Texture|null} 全身皮肤（六部件共享同一实例；dispose 时**只释放一次**） */
    this._skinTexture = skinTexture;
    /** @type {Object<string, THREE.InstancedMesh>} part → 固定容量实例池 */
    this.meshes = {};
    /** @type {Object<string, THREE.BoxGeometry>} 各部件几何（dispose 时释放） */
    this._geometries = {};

    for (const part of ZOMBIE_PARTS) {
      const def = ZOMBIE_PART_DEFS[part];
      const geometry = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
      // 臂/腿：轴心移到关节那一端（肩/髄）。不移会让摆动时肢体整体**平移**而非扫弧线
      // （走起来像踩滑板）。`pivotAtTop` 的权威在 zombie-model.js
      if (ZOMBIE_MODEL_DEFS[part].pivotAtTop) geometry.translate(0, -def.size[1] / 2, 0);
      // 六部件都吃同一张皮肤：每面按 ZOMBIE_SKIN_UV 的矩形重映射（头部的正面矩形里有眼睛）
      const useMap = !!skinTexture;
      // flipY 从纹理读（three 的 TextureLoader 默认 true）—— 不传就会整套皮肤上下颠倒
      if (useMap) applySkinUV(geometry, part, skinTexture.flipY !== false);
      // 材质基色白：真实颜色走 instanceColor（有 map 时必白色，否则基色 × 纹理变暗）
      const material = new THREE.MeshBasicMaterial(useMap ? { color: 0xffffff, map: skinTexture } : { color: 0xffffff });
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
      const baseColor = this._baseColorOf(part);
      for (let i = 0; i < maxActive; i++) {
        mesh.setMatrixAt(i, _zero);
        mesh.setColorAt(i, _color.setHex(baseColor));
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
   * 部件的基色（instanceColor 用）。
   *
   * **有纹理时六部件必须全部白底**（`0xffffff`）—— 真实颜色由皮肤给，乘上任何深色
   * instanceColor 都会「深色 × 深色」严重变暗。**无纹理时退回各自的视觉色**
   * （`ZOMBIE_MODEL_DEFS[part].fallbackColor`），否则渲染成纯白方人。
   * @param {string} part @returns {number}
   */
  _baseColorOf(part) {
    if (this._skinTexture) return 0xffffff;
    return ZOMBIE_PART_DEFS[part].color;
  }

  /**
   * 占用一个 slot（由 `ZombieService.spawn` 的 `onSpawn` 钩子调用）。
   * **slot 单一权威在 service**（它管 20 上限）—— 本层不自建第二份 slot 池（红线 1）。
   * @param {string} id @param {number} slot
   */
  acquireSlot(id, slot) {
    this._slots.set(id, slot);
    this._poses[slot] = {
      walkTime: 0, swing: 0, armSwing: 0, headSway: 0,
      flashing: false, position: [0, 0, 0], yaw: 0,
      // v2.39 上台阶视觉缓动：`lift` 每次 trigger 欠下一段负偏移，逐帧 ease-out 归零。
      // 每只丧尸一个实例（共享一份会让多只互相打断）。
      lift: new StepLift(),
      /**
       * 击退视觉补间（v2.81，用户缺陷：「boss 后退是瞬移的，不是缓动的」）。
       *
       * 权威位置瞬时、只滞后**渲染位置**（理由与 `lift` 同一分工，见
       * `render/knockback-ease.js` 模块注释）。逐实例一份（共享会让多只互相打断）。
       */
      knock: new KnockbackEase(),
      /**
       * 上一帧的物理 y（`null` = 未对齐）。**首帧必须不触发缓动** ——
       * `position` 初值是 `[0,0,0]`，把「physicalY − 0」当成抬升量会让每只丧尸出生时
       * 都从 y=0 升到自己脚下（实现里必然踩到的坑）。
       */
      prevY: null,
    };
    for (const part of ZOMBIE_PARTS) this.meshes[part].visible = true; // 有丧尸才提交渲染
  }

  /**
   * 登记一次击退（由 `ZombieService.knockback` 经 Game 装配的注入钩子调用）。
   *
   * ⚠️ **不能改成「每帧比较渲染位置与物理位置、差得多就补间」**：丧尸 AI 每帧 0.02 格、
   * 击退 0.9 格分三帧走完时每帧只有 0.3 格 —— 阈值两侧都会误伤。故触发是显式事件，
   * 见 `render/knockback-ease.js`。
   *
   * @param {string} id 实体 id @param {number} dx @param {number} dz 实际水平位移（格）
   * @returns {boolean} false = 该 id 当前没有 slot（未渲染，无需补间）
   */
  noteKnockback(id, dx, dz) {
    const slot = this._slots.get(id);
    if (slot === undefined) return false;
    const pose = this._poses[slot];
    if (!pose) return false;
    pose.knock.trigger(dx, dz);
    return true;
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
   * @returns {boolean} 是否走皮肤纹理（只读测试接口）。
   * 供 E2E 断言钉住「game.js 确实传了纹理」—— 忘传会静默退回纯色（肉眼看得出但测试抓不到），
   * 故留一个同步可观测的开关状态。
   */
  hasSkinTexture() { return !!this._skinTexture; }

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

      // ---- v2.39 上台阶视觉缓动（物理瞬时，只平滑渲染 y）----
      // 为什么在这里而不是 `ZombieService` / 物理层：缓动**只服务观感**，权威 state 必须保持
      // 瞬时（AABB 状态要精确，否则碰撞/实体射线/台阶净空全部错位）。与玩家的 `StepLift`
      // （`player/player.js` 消费 `physics.stepLiftAccum`）同一分工。
      this._advanceLift(pose, state.position[1], dt);

      // 步态：水平速度非零才算移动（mc-lite `Math.abs(velocity.x) > 0.001`）
      const moving = Math.abs(state.velocity[0]) > ZOMBIE_MOVING_EPSILON
        || Math.abs(state.velocity[2]) > ZOMBIE_MOVING_EPSILON;
      if (moving) {
        pose.walkTime += dt;
        // 三条摆动共用同一个相位（与腿同源）：
        // 腿/臂用 sin(phase)，左右反相；头用 sin(phase × 0.5) —— 半频，走满一个步周期才摆一次
        const phase = pose.walkTime * ZOMBIE_WALK_SPEED;
        pose.swing = Math.sin(phase) * ZOMBIE_SWING;
        pose.armSwing = Math.sin(phase) * ZOMBIE_ARM_SWING;
        pose.headSway = Math.sin(phase * 0.5) * ZOMBIE_HEAD_SWAY;
      } else {
        // 静止时三者一并归零（不是冻结在上一个摆幅）
        pose.walkTime = 0;
        pose.swing = 0;
        pose.armSwing = 0;
        pose.headSway = 0;
      }
      pose.flashing = nowMs < state.flashedUntil;
      // ---- v2.81 击退视觉补间：只滞后渲染位置（水平），权威 `state.position` 不动 ----
      pose.knock.update(dt);
      this._writeSlot(slot, pose);
    }
  }

  /** @param {number} slot @param {'leftLeg'|'rightLeg'} [part] @returns {number} 只读测试接口 */
  legSwingOf(slot, part = 'leftLeg') {
    const pose = this._poses[slot];
    if (!pose) return 0;
    return part === 'rightLeg' ? -pose.swing : pose.swing;
  }

  /**
   * @param {number} slot @param {'leftArm'|'rightArm'} [part] @returns {number} 只读测试接口
   *   右臂返回取反值（与腿同一口径：左右反相摆动）
   */
  armSwingOf(slot, part = 'leftArm') {
    const pose = this._poses[slot];
    if (!pose) return 0;
    return part === 'rightArm' ? -pose.armSwing : pose.armSwing;
  }

  /** @param {number} slot @returns {number} 只读测试接口：头部左右摆动幅度 */
  headSwayOf(slot) {
    const pose = this._poses[slot];
    return pose ? pose.headSway : 0;
  }

  /** @param {number} slot @returns {boolean} 只读测试接口：该 slot 当前是否红闪 */
  isFlashing(slot) { return !!this._poses[slot]?.flashing; }

  /** @param {number} slot @returns {{position: number[], yaw: number}|null} 只读测试接口 */
  poseOf(slot) {
    const pose = this._poses[slot];
    return pose ? { position: [...pose.position], yaw: pose.yaw } : null;
  }

  /**
   * 推进一只丧尸的 y 缓动（v2.39）。
   *
   * 三条分支都是**载荷性的**，任一条写错就退化成缺陷：
   * ① `prevY === null`（首帧 / slot 刚分配）→ **对齐不触发**。初值 `[0,0,0]` 会让每只丧尸
   *    出生时从 y=0 升上来。
   * ② `dy > epsilon`（上台阶）→ `trigger(dy)` 欠下一段负偏移，渲染 y 从旧高度 ease-out 追平。
   * ③ `dy < 0`（下落）→ **立即清零**，渲染直接跟随物理。下台阶的「动画」本来就来自重力
   *    （实测 19 帧 / 283ms），再叠一层缓动会让模型短暂陷进台阶下方；而且「上升滞后 +
   *    下落滞后」会叠加成更长时间的错位。
   *
   * 传送/大幅瞬移同样走 ① 之外的 ②/③：② 只在大幅上升时触发一次、随即衰减；当前没有
   * 「瞬移丧尸」的玩法路径（AI RPC 只回 vx/vz/mode，不回 position）。
   *
   * @param {object} pose `_poses[slot]`
   * @param {number} physY 本帧物理 y（脚底）
   * @param {number} dt 距上一帧的秒数
   */
  _advanceLift(pose, physY, dt) {
    const prev = pose.prevY;
    pose.prevY = physY;
    if (prev === null) {
      pose.lift.offset = 0; // ① 首帧对齐
    } else {
      const dy = physY - prev;
      if (dy > ZOMBIE_STEP_LIFT.epsilon) pose.lift.trigger(dy);   // ② 上台阶
      else if (dy < 0) pose.lift.offset = 0;                      // ③ 下落（含重力与瞬移向下）
    }
    pose.lift.update(dt);
  }

  /** @param {number} slot @returns {number} 只读测试接口：当前 x 击退补间偏移（格，渲染位置 − 该值 = 物理位置） */
  knockOffsetXOf(slot) {
    const pose = this._poses[slot];
    return pose ? pose.knock.offsetX : 0;
  }

  /** @param {number} slot @returns {number} 只读测试接口：当前 z 击退补间偏移（格） */
  knockOffsetZOf(slot) {
    const pose = this._poses[slot];
    return pose ? pose.knock.offsetZ : 0;
  }

  /** @param {number} slot @returns {number} 只读测试接口：当前 y 缓动偏移（格，≤ 0） */
  liftOffsetOf(slot) {
    const pose = this._poses[slot];
    return pose ? pose.lift.offset : 0;
  }

  /**
   * @param {number} slot @returns {number} 只读测试接口：**实际发布到实例矩阵**的 y。
   *   = 物理 y + 缓动偏移。只断言 `liftOffsetOf` 会漏掉「测对了但没写进矩阵」这个形态
   *   （v1.48 玩家晃动踩过：断言内部量时注入「算对但不写相机」仍全绿）。
   */
  renderYOf(slot) {
    const pose = this._poses[slot];
    return pose ? pose.position[1] + pose.lift.offset : 0;
  }

  /** 写一个 slot 的六部件矩阵与颜色（父级 yaw × 部件本地偏移/旋转，mc-lite `:548-566` 同构） */
  _writeSlot(slot, pose) {
    // ⚠️ y 加 `lift.offset`：上台阶的视觉缓动就落在这一处（v2.39）。写回 `pose.position`
    // 会把缓动偏移污染成「物理位置」的副本 —— `poseOf()` 的语义是只读发布物理位置。
    // 水平减 `knock.offset`：击退的补间同理（v2.81）—— 触发当帧渲染位置仍在**旧位置**，
    // 再 ease-out 追平。
    _parent.position.set(
      pose.position[0] - pose.knock.offsetX,
      pose.position[1] + pose.lift.offset,
      pose.position[2] - pose.knock.offsetZ,
    );
    _parent.rotation.set(0, pose.yaw, 0);
    _parent.updateMatrix();
    const flash = pose.flashing;

    for (const part of ZOMBIE_PARTS) {
      const def = ZOMBIE_PART_DEFS[part];
      _local.position.set(def.offset[0], def.offset[1], def.offset[2]);
      if (part === 'leftLeg') _local.rotation.set(pose.swing, 0, 0);
      else if (part === 'rightLeg') _local.rotation.set(-pose.swing, 0, 0); // 右腿取反
      else if (part === 'leftArm') _local.rotation.set(def.rotation[0] + pose.armSwing, 0, 0);
      else if (part === 'rightArm') _local.rotation.set(def.rotation[0] - pose.armSwing, 0, 0);
      else if (part === 'head') _local.rotation.set(0, pose.headSway, 0); // 只左右摆，不低头不歪头
      else _local.rotation.set(def.rotation[0], def.rotation[1], def.rotation[2]);
      _local.scale.set(1, 1, 1);
      _local.updateMatrix();
      _matrix.multiplyMatrices(_parent.matrix, _local.matrix);
      const mesh = this.meshes[part];
      mesh.setMatrixAt(slot, _matrix);
      // 基色走 `_baseColorOf`（head 无纹理时退回视觉色）。**红闪 = 红 instanceColor × map**
      // → head 有纹理时红闪呈**暗红**（≈ 红 × 深绿马赛克），不是纯红 —— 这是 mc-lite 的既有
      // 行为（它同样 map × flash color），不是本次引入的偏离。其余五部件无 map，红闪仍纯红。
      mesh.setColorAt(slot, flash ? _flashColor : _color.setHex(this._baseColorOf(part)));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 反向释放：从 scene 移除六部件并释放几何/材质/纹理，slot 全部清空 */
  dispose() {
    for (const part of ZOMBIE_PARTS) {
      const mesh = this.meshes[part];
      this.scene.remove(mesh);
      mesh.dispose();
      this._geometries[part].dispose();
      mesh.userData.material?.dispose?.();
    }
    // head 纹理也要释放（`InstancedMesh.dispose` 与 `material.dispose` 都不释放 map）
    this._skinTexture?.dispose?.();
    this._skinTexture = null;
    this._slots.clear();
    this._poses.fill(null);
  }
}

/** 供测试/调试读取的冻结常量（避免各处重复字面量） */
export { ZOMBIE_FLASH_MS };
