// src/render/soldier-renderer.js — 士兵 7 部件实例渲染（受控发布层）
//
// 只读 pose：**不回写 state、不调 world.setBlock、不作命中真相**
// （实体命中只由 `EntityManager.raycast()` → `soldierDefinition.raycastAabb` 给出，红线 6）。
//
// ## 为什么是 7 个 InstancedMesh 而不是每兵一个 Group
//
// 与丧尸六部件同口径（M6 规格 §3 明令禁止 per-entity Group）。7 个固定容量实例池常驻
// scene，每只士兵占同一个索引 ⇒ **draw call 恒为 7，与士兵数无关**；
// 无士兵时全部 `visible=false` ⇒ draw call 回到基线。
//
// ## 容量 = 2×maxAlive（不是 maxAlive）
//
// ⚠️⚠️ **载荷性**：士兵**死后留尸 1.2s**，尸体仍占着 Service 的 slot ⇒ Service 的
// slot 池是 2×maxAlive。渲染器给少了会让 slot≥maxAlive 的士兵 `setMatrixAt` 静默写不进
// 缓冲 ⇒ **那些士兵完全不可见**，而所有计数判据全绿（Task 4 实测确立）。
//
// ## 材质：共用一份金属 TSL（与炮塔同源）
//
// 逐顶点色（`vertexColor`）+ 自发光（`glowAttribute: 'aGlow'`），红闪走 **instanceColor**
// ⇒ 7 个部件可共用一份材质（uniform 是共享的太阳方向）。这与焰魔/守卫「逐实例独立材质」
// 不同 —— 那两者红闪是材质级 color。
// ⚠️ three 自动 `instanceColor.mul(colorNode)` ⇒ 基色必须白，红闪时写红。
import * as THREE from 'three';
import {
  SOLDIER, SOLDIER_AI, SOLDIER_GAIT,
} from '../entities/soldiers/soldier-config.js';
import { StepLift } from '../player/step-lift.js';
import { KnockbackEase } from './knockback-ease.js';
import { createTurretMetalMaterial } from './turret-metal.js';
import {
  SOLDIER_PARTS, SOLDIER_GEOMETRY_OF, SOLDIER_PIVOTS, buildSoldierGeometries,
} from './soldier-geometry.js';

/** 红闪色（与丧尸/焰魔/守卫同口径） */
const FLASH_COLOR = 0xff0000;
/** 常态基色白（three 把 instanceColor 乘到 colorNode 上，非白会把顶点色乘暗） */
const BASE_COLOR = 0xffffff;
/** 上台阶缓动的噪声门（与丧尸同口径） */
const LIFT_EPSILON = 1e-4;

// 复用的临时对象（每帧零分配）
const _root = new THREE.Object3D();
const _body = new THREE.Object3D();
const _local = new THREE.Object3D();
const _parent = new THREE.Object3D();   // head/shin 的二级父节点（每帧复用，不在循环里 new）
const _matrix = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _color = new THREE.Color();
const _flashColor = new THREE.Color(FLASH_COLOR);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class SoldierRenderer {
  /**
   * @param {{scene:THREE.Scene, maxActive?:number,
   *          sunDirection?:object, sunStrength?:object, sunColor?:object}} deps
   *   `maxActive` 缺省 = **2×SOLDIER.maxAlive**（含留尸余量，见文件头）。
   *   三个 sun uniform 建议传 `renderWorld.materials.dayNight` 的句柄（与炮塔同源）；
   *   不传则退回纯色 MeshBasic（单测 fixture / 无太阳句柄路径）。
   */
  constructor({ scene, maxActive = SOLDIER.maxAlive * 2, sunDirection = null, sunStrength = null, sunColor = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    const geos = buildSoldierGeometries();
    this._geometries = geos;
    /** 共用材质（红闪走 instanceColor，故可共享） */
    this._material = sunDirection
      ? createTurretMetalMaterial({
        color: 0xffffff, sunDirection, sunStrength, sunColor,
        vertexColor: true, glowAttribute: 'aGlow',
      })
      : new THREE.MeshBasicNodeMaterial({ vertexColors: true, side: THREE.DoubleSide });

    /** @type {Object<string, THREE.InstancedMesh>} */
    this.meshes = {};
    for (const part of SOLDIER_PARTS) {
      const mesh = new THREE.InstancedMesh(geos[SOLDIER_GEOMETRY_OF[part]], this._material, maxActive);
      mesh.name = `soldier:${part}`;
      mesh.frustumCulled = false;   // 实例池包围球按零 scale 算，会被误剔除
      mesh.visible = false;         // 空载不提交渲染
      for (let i = 0; i < maxActive; i++) {
        mesh.setMatrixAt(i, _zero);
        mesh.setColorAt(i, _color.setHex(BASE_COLOR));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this.meshes[part] = mesh;
    }

    /** @type {Map<string,number>} id → slot（差集驱动，本层自己分配） */
    this._slots = new Map();
    this._nextSlot = 0;
    /**
     * 空闲 slot 栈（低位优先）—— **分配不得抢占仍被占用的 slot**。
     *
     * ⚠️⚠️ **用户 2026-11-25 实玩报告「soldier 已经被消灭了，计数器还残留 1 或 2」的真因**：
     * 旧写法是 `slot = this._nextSlot; this._nextSlot = (…+1) % maxActive`，**不检查占用**
     * ⇒ 指针绕回时新实体拿到一个仍被活实体占用的 slot，把后者的 7 个实例矩阵覆盖掉；
     * 而那个新实体死后差集回收又把该 slot 清零 ⇒ **仍在场的那只也跟着不画了**。
     * 形态：3 只活着只画出 2 只，或「都杀完了画面上还站着 1~2 只」—— 用户读作「计数器残留」。
     * 计数本身实测逐位正确（HUD ≡ `soldiers.count()`），错的是画面。
     *
     * ⚠️ **不能用 `_nextSlot` 扫描 + “跳过已占”代替显式空闲栈**：回收路径必须把 slot 真的
     * 归还，否则池会被“曾经用过”的 slot 占死（与 Service 的 slot 池同口径）。
     * `_nextSlot` 保留作只读诊断（旧测试与探针读它）。
     */
    this._freeSlots = [];
    for (let i = maxActive - 1; i >= 0; i--) this._freeSlots.push(i);
    /** 逐 slot 的渲染态（缓动/相位/上一帧物理量） */
    this._poses = new Array(maxActive).fill(null).map(() => ({
      entityId: null,
      lift: new StepLift(),
      knock: new KnockbackEase(),
      prevY: null,
      walkPhase: 0,
      bodyTilt: 0,
      renderY: 0,
    }));
    this._lastSyncMs = null;
  }

  /**
   * 每帧发布 pose（在 `entities.update` 之后调）。
   * @param {Array<{id:string,state:object}>} entities `soldiers.activeEntities()`（**含留尸**）
   * @param {number} nowMs `performance.now()` 基准（红闪判定）
   */
  sync(entities, nowMs) {
    const list = entities || [];
    const dt = this._lastSyncMs === null ? 0 : Math.max(0, (nowMs - this._lastSyncMs) / 1000);
    this._lastSyncMs = nowMs;
    const live = new Set();
    for (const e of list) {
      live.add(e.id);
      let slot = this._slots.get(e.id);
      if (slot === undefined) {
        // 从空闲栈取（**不抢占已占用的 slot**，见构造器里那条 ⚠️⚠️）。
        // 池容量 = 2×maxAlive = Service 的 slot 池容量 ⇒ 正常情况下不可能耗尽；
        // 耗尽就是真 bug（回收路径漏归还），故招回一个已占 slot 以外的唯一出路是报错。
        slot = this._freeSlots.pop();
        if (slot === undefined) {
          throw new Error('SoldierRenderer: slot 池耗尽（回收路径漏归还）');
        }
        this._slots.set(e.id, slot);
        this._nextSlot = (slot + 1) % this.maxActive;
      }
      const pose = this._poses[slot];
      // 实例复用给新实体：重置全部逐实例状态（否则继承上一只的缓动与相位）
      if (pose.entityId !== e.id) {
        pose.entityId = e.id;
        pose.prevY = null;
        pose.lift.offset = 0;
        pose.knock.offsetX = 0;
        pose.knock.offsetZ = 0;
        pose.walkPhase = 0;
      }
      this._writeSlot(slot, pose, e.state, nowMs, dt);
    }
    // 归还消失 id 的 slot（三条回收路径自动覆盖）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      for (const part of SOLDIER_PARTS) {
        this.meshes[part].setMatrixAt(slot, _zero);
        this.meshes[part].instanceMatrix.needsUpdate = true;
      }
      this._poses[slot].entityId = null;
      this._slots.delete(id);
      // 归还空闲栈（与 Service 的 `_releaseSlot` 同口径）。去重守卫：同一 slot 不得进两次，
      // 否则两个实体会拿到同一个 slot ⇒ 又回到互相覆盖。
      if (!this._freeSlots.includes(slot)) this._freeSlots.push(slot);
    }
    const any = this._slots.size > 0;
    for (const part of SOLDIER_PARTS) this.meshes[part].visible = any;
  }

  /** 写一个 slot 的 7 部件矩阵与颜色 */
  _writeSlot(slot, pose, state, nowMs, dt) {
    const crouch = Number.isFinite(state.crouch) ? state.crouch : 0;
    const speed = Math.hypot(state.velocity[0], state.velocity[2]);
    const k = Math.min(1, speed / 3);   // 上游 `clamp(speedCur / 3)`

    // 上台阶缓动（首帧对齐 / 上升触发 / 下落立即清零，与丧尸三分支同口径）
    const physY = state.position[1];
    if (pose.prevY === null) pose.lift.offset = 0;
    else {
      const dy = physY - pose.prevY;
      if (dy > LIFT_EPSILON) pose.lift.trigger(dy);
      else if (dy < 0) pose.lift.offset = 0;
    }
    pose.prevY = physY;
    pose.lift.update(dt);
    pose.knock.update(dt);

    // 步态相位（按移动距离累积，真停下时归零 —— 与丧尸「静止归零」同口径）
    if (speed > 1e-3) pose.walkPhase += speed * dt * SOLDIER_GAIT.phasePerBlock;
    else pose.walkPhase = 0;
    const sw = Math.sin(pose.walkPhase);

    // 死亡倒地（上游：0.55s 内 smoothstep 到 −1.5 rad，身体同时下沉/后移）
    let tilt = 0, deadDrop = 0, deadBack = 0;
    if (state.dead) {
      const t = Math.min(1, (state.deadT ?? 0) / 0.55);
      const ease = t * t * (3 - 2 * t);
      const dir = state.fallDir === -1 ? -1 : 1;
      tilt = -ease * 1.5 * dir;
      deadDrop = -ease * 0.72;
      deadBack = -ease * 0.5 * dir;
    }
    pose.bodyTilt = tilt;

    // root：世界位置 + yaw（缓动只影响渲染，权威 state 不动）
    _root.position.set(
      state.position[0] - pose.knock.offsetX,
      physY + pose.lift.offset,
      state.position[2] - pose.knock.offsetZ,
    );
    _root.rotation.set(0, state.yaw, 0);
    _root.scale.set(1, 1, 1);
    _root.updateMatrix();
    pose.renderY = _root.position.y;

    // body：蹲姿下沉 + 行走起伏 + 倒地倾倒
    const bob = -Math.abs(Math.cos(pose.walkPhase)) * SOLDIER_GAIT.bobAmplitude * k;
    _body.position.set(0, -crouch * SOLDIER_AI.crouchDrop + bob + deadDrop, deadBack);
    _body.rotation.set(tilt, 0, 0);
    _body.scale.set(1, 1, 1);
    _body.updateMatrix();
    _tmp.multiplyMatrices(_root.matrix, _body.matrix);

    const flash = nowMs < state.flashedUntil;
    for (const part of SOLDIER_PARTS) {
      const pivot = SOLDIER_PIVOTS[part];
      _local.position.set(pivot[0], pivot[1], pivot[2]);
      _local.scale.set(1, 1, 1);
      if (part === 'torso') {
        // 躯干俯仰 = 瞄准角 + 蹲姿前倾（上游 `-aimPitch + cr*0.12`）
        _local.rotation.set(-(state.aimPitch ?? 0) + crouch * 0.12, 0, sw * 0.03 * k);
      } else if (part === 'head') {
        _local.rotation.set((state.aimPitch ?? 0) * 0.3, 0, 0);
      } else if (part === 'thighL') {
        _local.rotation.set(sw * SOLDIER_GAIT.thighSwing * k + crouch * SOLDIER_GAIT.crouchThighL, 0, 0);
      } else if (part === 'thighR') {
        _local.rotation.set(-sw * SOLDIER_GAIT.thighSwing * k + crouch * SOLDIER_GAIT.crouchThighR, 0, 0);
      } else if (part === 'shinL') {
        _local.rotation.set(
          Math.max(0, -Math.cos(pose.walkPhase)) * SOLDIER_GAIT.shinSwing * k + crouch * SOLDIER_GAIT.crouchShinL, 0, 0,
        );
      } else if (part === 'shinR') {
        _local.rotation.set(
          Math.max(0, Math.cos(pose.walkPhase)) * SOLDIER_GAIT.shinSwing * k + crouch * SOLDIER_GAIT.crouchShinR, 0, 0,
        );
      } else {
        _local.rotation.set(0, 0, 0);
      }
      _local.updateMatrix();
      // head 挂 torso、shin 挂各自的 thigh ⇒ 需要再乘一层父级
      if (part === 'head') {
        const p = SOLDIER_PIVOTS.torso;
        _parent.position.set(p[0], p[1], p[2]);
        _parent.rotation.set(-(state.aimPitch ?? 0) + crouch * 0.12, 0, sw * 0.03 * k);
        _parent.scale.set(1, 1, 1);
        _parent.updateMatrix();
        _matrix.multiplyMatrices(_parent.matrix, _local.matrix);
        _matrix.premultiply(_tmp);
      } else if (part === 'shinL' || part === 'shinR') {
        const thighPart = part === 'shinL' ? 'thighL' : 'thighR';
        const p = SOLDIER_PIVOTS[thighPart];
        _parent.position.set(p[0], p[1], p[2]);
        const sign = part === 'shinL' ? 1 : -1;
        const crouchThigh = part === 'shinL' ? SOLDIER_GAIT.crouchThighL : SOLDIER_GAIT.crouchThighR;
        _parent.rotation.set(sign * sw * SOLDIER_GAIT.thighSwing * k + crouch * crouchThigh, 0, 0);
        _parent.scale.set(1, 1, 1);
        _parent.updateMatrix();
        _matrix.multiplyMatrices(_parent.matrix, _local.matrix);
        _matrix.premultiply(_tmp);
      } else {
        _matrix.multiplyMatrices(_tmp, _local.matrix);
      }
      const mesh = this.meshes[part];
      mesh.setMatrixAt(slot, _matrix);
      mesh.setColorAt(slot, flash ? _flashColor : _color.setHex(BASE_COLOR));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** 登记击退（Service 经装配层注入的钩子调） */
  noteKnockback(id, dx, dz) {
    const slot = this._slots.get(id);
    if (slot === undefined) return false;
    this._poses[slot].knock.trigger(dx, dz);
    return true;
  }

  /** @param {string} id @returns {number|null} 只读 slot */
  slotOf(id) {
    const s = this._slots.get(id);
    return s === undefined ? null : s;
  }

  /** @returns {number} 当前活动 slot 数（含留尸） */
  activeCount() { return this._slots.size; }

  /** @returns {number} 只读：实际发布的 root y */
  renderYOf(slot) { return this._poses[slot]?.renderY ?? 0; }

  /** @returns {number} 只读：当前倒地倾倒角（弧度） */
  bodyTiltOf(slot) { return this._poses[slot]?.bodyTilt ?? 0; }

  /** @returns {number} 只读：当前 x 击退补间偏移 */
  knockOffsetXOf(slot) { return this._poses[slot]?.knock.offsetX ?? 0; }

  dispose() {
    for (const part of SOLDIER_PARTS) {
      const mesh = this.meshes[part];
      this.scene.remove(mesh);
      mesh.dispose();
    }
    // 5 份 unique 几何各释放一次（左右腿共用，不能重复 dispose）
    for (const g of Object.values(this._geometries)) g.dispose();
    this._material.dispose();
    this._slots.clear();
    this._freeSlots.length = 0;
  }
}