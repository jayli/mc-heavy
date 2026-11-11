// src/render/guardian-renderer.js — 末影守卫：SkinnedMesh 渲染（受控发布层）
//
// 只读 pose 的**受控发布层**：不回写 state、不调 `world.setBlock`、不作命中真相
// （实体命中只由 `EntityManager.raycast()` → `guardianDefinition.raycastAabb` 给出 —— 红线 6）。
//
// **为什么是 SkinnedMesh 单几何**：素材 24 个立方体全部刚性归属单根骨骼（无蒙皮权重），
// skinWeight 恒 1 —— SkinnedMesh 只是「骨骼驱动刚性块」的载体。24 盒合并成一个
// BufferGeometry（576 顶点）⇒ 每只守卫 **1 个 draw call**；无守卫时实例 `visible=false` → 0。
//
// ## 与焰魔渲染器的四处差异（别照抄）
//
// 1. **池容量 = `GUARDIAN.maxAlive`（1）**。
// 2. **脚底补偿 = 产物 `metrics.feetOffsetY`（+1.6243，正值）**。
// 3. **动画按 `state.attackKind` 在四条片段间选**（焰魔两条）。
// 4. ⚠️⚠️ **骨骼位置公式 = `localPosition + delta.pos`**（口径 A，spec §2.2.1）。
//    焰魔那行是 `pivot − R_current·pivot + delta.pos` —— 那是 **Bedrock 绝对顶点**才需要的
//    修正。守卫产物是 **Java 局部顶点 + pivot 恒零**，旋转天然绕骨骼局部原点。
//    照搬那行会把每个部件多平移一个 `pivot − R·pivot`（pivot 为零时退化成「丢掉 localPosition」），
//    形态是**模型炸成碎片**，而骨骼数/盒数/顶点数/指纹全对。故本类**不缓存 pivot**。
//
// ## 程序化 idle（产物里没有 idle 片段）
//
// 原版守卫的待机/行走是 `setupAnim` 里的程序化 `walk()` / `flap()`，**无关键帧**：
//   walk(left_leg/right_leg/left_arm/right_arm, speed 0.5, degree 0.5×1.2, 左右反相)
//   flap(root, speed 0.5, degree 0.5×0.2)
// 本渲染器按移动相位做同样的 `Math.sin` 摆动（幅度取原版值），攻击片段期间**不叠加**
// （否则两套打架）。与 `zombie-renderer.js` 的步态同一手法。
//
// ⚠️ **骨骼增量必须从 bind 快照起算**（每帧 `bone.quaternion = bindQuat * deltaRot`）：
// 直接 `*= delta` 会逐帧累积 ⇒ 守卫越挥越散架。
// ⚠️ **材质 unlit + DoubleSide**：y 翻转让三角形绕序反向，单面会从某些角度看穿。
// ⚠️ **零实例时 visible=false**（否则恒增 1 个 draw call）。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';
import {
  GUARDIAN, GUARDIAN_ATTACK_IDS, GUARDIAN_STEP_LIFT, GUARDIAN_POSE_BLEND, guardianBlendSeconds,
} from '../entities/guardian/guardian-config.js';
import { StepLift } from '../player/step-lift.js';
import { KnockbackEase } from './knockback-ease.js';
import {
  sampleGuardianAttack, GuardianPoseTransition,
} from './guardian-model.js';

/** 红闪色（与丧尸/飞龙/焰魔同口径：纯红乘贴图） */
const FLASH_COLOR = 0xff0000;
/** 常态基色（白 —— 有贴图时基色必须白，否则「深色 × 纹理」变暗） */
const BASE_COLOR = 0xffffff;

/**
 * 程序化 idle 的参数 —— 取自原版 `ModelEnder_Guardian.setupAnim`：
 * `walkSpeed = 0.5F`、`walkDegree = 0.5F`，四肢用 `walkDegree × 1.2`、root 用 `× 0.2`。
 *
 * ⚠️ 原版的 `limbSwing` 是「肢体摆动相位」（由移动距离驱动），`limbSwingAmount` 是幅度包络。
 * 本仓用 `idleTime × WALK_SPEED` 作相位、按是否在移动给幅度（与丧尸渲染器同口径）。
 */
const IDLE_WALK_SPEED = 0.5 * 4;      // 原版 limbSwing 每格约推进 4 弧度量级，取 2 rad/s 的观感
const IDLE_LIMB_AMPLITUDE = 0.5 * 1.2;   // 四肢摆幅（弧度）
const IDLE_ROOT_AMPLITUDE = 0.5 * 0.2;   // root 起伏摆幅（弧度）
/** 「在移动」的速度阈（与丧尸 `ZOMBIE_MOVING_EPSILON` 同量级） */
const MOVING_EPSILON = 0.001;

const _tmpQuat = new THREE.Quaternion();

/** 程序化 idle 驱动的四肢（左右反相）与 root。下标在构造时解析成产物骨骼索引 */
const IDLE_LIMBS = Object.freeze([
  { name: 'left_leg', sign: 1 },
  { name: 'right_leg', sign: -1 },
  { name: 'left_arm', sign: -1 },
  { name: 'right_arm', sign: 1 },
]);

/**
 * 守卫渲染器（实例池）。池容量 = `GUARDIAN.maxAlive`；实例按实体 id 复用，消失即隐藏。
 */
export class GuardianRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {{scale:number, bones:Array, geometry:object, animations:object, metrics:object}} asset
   * @param {THREE.Texture|null} [texture] 缺省则内部加载
   */
  constructor(scene, asset, texture = null) {
    this.scene = scene;
    this.asset = asset;
    this._texture = texture;
    this._ownsTexture = texture === null;
    // bind 快照（**全实例共享**：烘焙产物的只读数据，不是运行时状态）
    this._bindQuat = asset.bones.map((b) => b.bindQuaternion.slice());
    // ⚠️ **不缓存 pivot**：口径 A 下它恒零，骨骼位置直接用 localPosition（见文件头 ④）
    this._localPos = asset.bones.map((b) => b.localPosition.slice());
    // 程序化 idle 的骨骼下标（产物骨骼名 → 索引）
    const idxOf = (n) => asset.bones.findIndex((b) => b.name === n);
    this._idleLimbs = IDLE_LIMBS
      .map((l) => ({ index: idxOf(l.name), sign: l.sign }))
      .filter((l) => l.index >= 0);
    this._idleRoot = idxOf('root');

    // ---- 合并几何（全实例共享一份）----
    const g = asset.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(g.skinIndex, 4));
    const weight = new Float32Array(g.skinIndex.length);
    for (let i = 0; i < weight.length; i += 4) weight[i] = 1;   // 刚性绑定
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    geometry.setIndex(g.index);
    this._geometry = geometry;

    this._instances = [];
    for (let i = 0; i < GUARDIAN.maxAlive; i++) this._instances.push(this._makeInstance());
    /** @type {Map<string, number>} 实体 id → 实例下标 */
    this._byId = new Map();
    /** 上次 sync 的时间戳（ms），只为算缓动 dt。null = 首次（dt 给 0） */
    this._lastSyncMs = null;
  }

  /** 造一个实例：独立骨骼层级 + 独立材质 + SkinnedMesh + yaw 父节点 */
  _makeInstance() {
    const bones = this.asset.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.set(b.localPosition[0], b.localPosition[1], b.localPosition[2]);
      bone.quaternion.set(
        b.bindQuaternion[0], b.bindQuaternion[1], b.bindQuaternion[2], b.bindQuaternion[3]);
      return bone;
    });
    for (let i = 0; i < this.asset.bones.length; i++) {
      const p = this.asset.bones[i].parentIndex;
      if (p !== -1) bones[p].add(bones[i]);
    }

    // ⚠️ 材质逐实例独立（红闪是材质级 color，共享会让所有守卫一起变红）
    const material = new THREE.MeshBasicMaterial({
      color: BASE_COLOR,
      map: this._texture || undefined,
      alphaTest: 0.5,          // 贴图镂空走 cutout 语义，免透明排序
      side: THREE.DoubleSide,  // y 翻转让绕序反向 ⇒ 必须双面
    });

    const mesh = new THREE.SkinnedMesh(this._geometry, material);
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    // ⚠️ **脚底对齐用产物 feetOffsetY**（守卫是 +1.6243）：几何 y 原点不是脚底
    //（口径 A 下 root.localPosition = [0,−1.5,0] 把整条链压低了）。
    // 不得用核心盒中心 `GUARDIAN_CORE_OBB.center` —— 那是命中盒语义（焰魔缺陷 A 同源）。
    mesh.position.set(0, this.asset.metrics.feetOffsetY, 0);
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.visible = false;
    this.scene.add(pivot);
    return {
      bones, material, mesh, pivot,
      /** 当前占用本实例的实体 id（null = 空闲）。只为实例复用时的缓动重置 */
      entityId: null,
      /** 上台阶视觉缓动（逐实例一份；衰减参数的唯一权威在 StepLift） */
      lift: new StepLift(),
      /** 击退视觉补间（权威位置瞬时，只滞后渲染位置） */
      knock: new KnockbackEase(),
      /** 上一帧物理 y（null = 未对齐）。首帧必须不触发缓动 */
      prevY: null,
      /** 姿态衔接（逐实例一份，有状态） */
      transition: new GuardianPoseTransition(GUARDIAN_POSE_BLEND.seconds),
      /** 程序化 idle 的相位累积（秒）—— 逐实例，静止时归零 */
      idlePhase: 0,
    };
  }

  /** 把整副骨架恢复成 bind 姿态（实例复用给新实体时调用，防上一只的姿态残留） */
  _restoreBindPose(inst) {
    for (let i = 0; i < inst.bones.length; i++) {
      const b = this.asset.bones[i];
      inst.bones[i].quaternion.set(
        b.bindQuaternion[0], b.bindQuaternion[1], b.bindQuaternion[2], b.bindQuaternion[3]);
      inst.bones[i].position.set(b.localPosition[0], b.localPosition[1], b.localPosition[2]);
    }
  }

  /** 加载贴图（走真实 TextureLoader 路径，flipY 口径见下） */
  async loadTexture() {
    if (this._texture) return this._texture;
    const tex = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/guardian/guardian.png'));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;   // 像素风保硬边
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // ⚠️ **flipY 保持默认 true**：烘焙期 v 轴换算（`1 − v_px/256`）就是按这个前提做的。
    // 改成 false 会让整套贴图上下颠倒。
    this._texture = tex;
    for (const inst of this._instances) {
      inst.material.map = tex;
      inst.material.needsUpdate = true;
    }
    return tex;
  }

  /** 实例池（供测试读 visible / geometry / skeleton） */
  get instances() { return this._instances; }
  /** 池容量（= draw call 上限） */
  get capacity() { return this._instances.length; }

  /**
   * 每帧发布全部守卫的 pose（在 `entities.update` 之后调）。
   *
   * @param {Array<{id:string, state:object}>} entities `guardians.activeEntities()`
   * @param {number} nowMs `performance.now()` 基准（红闪判定）
   */
  sync(entities, nowMs) {
    const list = entities || [];
    const dt = this._lastSyncMs === null ? 0 : Math.max(0, (nowMs - this._lastSyncMs) / 1000);
    this._lastSyncMs = nowMs;
    const used = new Set();
    for (let i = 0; i < list.length && i < this._instances.length; i++) {
      const entity = list[i];
      const inst = this._instances[i];
      used.add(i);
      this._byId.set(entity.id, i);
      // ⚠️ **实例复用给新实体时重置全部逐实例状态**：不重置会把「死了又召」的高度差
      // 当成一次上台阶（出生头 ~190ms 陷地），并继承上一只的击退偏移与姿态。
      if (inst.entityId !== entity.id) {
        inst.entityId = entity.id;
        inst.prevY = null;
        inst.lift.offset = 0;
        inst.knock.offsetX = 0;
        inst.knock.offsetZ = 0;
        inst.transition.reset();
        inst.idlePhase = 0;
        this._restoreBindPose(inst);
      }
      this._syncOne(inst, entity, nowMs, dt);
    }
    for (let i = 0; i < this._instances.length; i++) {
      if (!used.has(i)) this._instances[i].pivot.visible = false;
    }
    for (const [id, idx] of this._byId) {
      if (!used.has(idx) || !list.some((e) => e.id === id)) this._byId.delete(id);
    }
  }

  /**
   * 登记一次击退（由 `GuardianService.knockback` 经装配层的注入钩子调用）。
   *
   * ⚠️ 不能改成「每帧比较渲染位置与物理位置、差得多就补间」：AI 每帧位移与击退位移
   * 分帧后同一量级，阈值两侧都会误伤。触发必须是显式事件。
   *
   * @returns {boolean} false = 该 id 当前不在池里
   */
  noteKnockback(id, dx, dz) {
    const idx = this._byId.get(id);
    if (idx === undefined) return false;
    const inst = this._instances[idx];
    if (!inst) return false;
    inst.knock.trigger(dx, dz);
    return true;
  }

  /** 发布单只守卫 */
  _syncOne(inst, entity, nowMs, dt = 0) {
    const st = entity.state;
    inst.pivot.visible = true;
    this._advanceLift(inst, st.position[1], dt);
    inst.knock.update(dt);
    // ⚠️ y 加 lift.offset、x/z 减 knock.offset：两套缓动只落在这一处，
    // 写回 st.position 会把缓动偏移污染成「物理位置」的副本。
    inst.pivot.position.set(
      st.position[0] - inst.knock.offsetX,
      st.position[1] + inst.lift.offset,
      st.position[2] - inst.knock.offsetZ,
    );
    // ⚠️ 欧拉顺序显式 'YXZ'（守卫无俯仰，但与飞龙/焰魔同口径）
    inst.pivot.rotation.set(0, st.yaw, 0, 'YXZ');

    // ---- 动画来源：四条攻击片段 or 程序化 idle ----
    const attackT = Number.isFinite(st.attackAnimT) ? st.attackAnimT : 0;
    const clipKey = GUARDIAN_ATTACK_IDS.includes(st.attackKind)
      ? st.attackKind : GUARDIAN_ATTACK_IDS[0];
    const attacking = attackT > 0;
    const sourceKey = attacking ? clipKey : 'idle';
    const target = attacking
      ? sampleGuardianAttack(this.asset.animations[clipKey], attackT)
      : this._idlePose(inst, st, dt);
    // ⚠️ 来源切换不得硬切：过渡器持有上一帧发布的姿态，在 guardianBlendSeconds(key) 内淡入。
    // 纯视觉层 —— 权威 state（attackAnimT / 命中帧）仍瞬时。
    const deltas = inst.transition.step(sourceKey, target, dt, guardianBlendSeconds(sourceKey));

    // 先把整副骨架复位到 bind（位置 + 旋转）。
    // ⚠️⚠️ **旋转也必须复位，不只是位置**（实测真缺陷）：程序化 idle 的 target 在
    // 「移动 → 静止」时从非空变**空 Map**，而来源 key 两边都是 'idle'
    // ⇒ 过渡器不认为发生了切换 ⇒ 不走淡入 ⇒ 那几根骨骼直接从输出里消失
    // ⇒ 永远**冻结在最后一个摆臂姿态**（守卫停下后腿一直抬着）。
    // 焰魔没这个问题：它的 idle 是烘焙片段，始终驱动同一批骨骼。
    // 复位后再写本帧驱动的骨骼 ⇒ 未被驱动的回到 bind（与过渡器的并集语义一致）。
    for (let i = 0; i < inst.bones.length; i++) {
      const lp = this._localPos[i];
      const bq = this._bindQuat[i];
      inst.bones[i].position.set(lp[0], lp[1], lp[2]);
      inst.bones[i].quaternion.set(bq[0], bq[1], bq[2], bq[3]);
    }
    for (const [bi, delta] of deltas) {
      const bone = inst.bones[bi];
      if (!bone) continue;
      const bq = this._bindQuat[bi];
      bone.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
      bone.quaternion.multiply(
        _tmpQuat.set(delta.rot[0], delta.rot[1], delta.rot[2], delta.rot[3]));
      // ⚠️⚠️ **口径 A**：`position = localPosition + delta.pos`。
      // **不是**焰魔的 `pivot − R_current·pivot + delta.pos`（那是绝对顶点口径的修正）。
      // 守卫的顶点已是骨骼局部坐标、pivot 恒零 ⇒ 旋转天然绕骨骼原点，无需重算。
      const lp = this._localPos[bi];
      bone.position.set(lp[0] + delta.pos[0], lp[1] + delta.pos[1], lp[2] + delta.pos[2]);
    }

    inst.material.color.setHex(nowMs < st.flashedUntil ? FLASH_COLOR : BASE_COLOR);
  }

  /**
   * 程序化 idle 姿态（产物里没有 idle 片段）。
   *
   * 复刻原版 `setupAnim` 的 `walk()` / `flap()`：四肢绕 X 轴反相摆动、root 轻微起伏。
   * ⚠️ **静止时相位归零、幅度归零**（不是冻结在上一个摆幅）—— 与丧尸渲染器同口径。
   * ⚠️ 只在非攻击态调用（攻击期间叠加会让两套打架）。
   *
   * @returns {Map<number, {rot:number[], pos:number[]}>} 增量姿态
   */
  _idlePose(inst, st, dt) {
    const v = Array.isArray(st.velocity) ? st.velocity : [0, 0, 0];
    const moving = Math.abs(v[0]) > MOVING_EPSILON || Math.abs(v[2]) > MOVING_EPSILON;
    if (moving) {
      inst.idlePhase += dt * IDLE_WALK_SPEED;
    } else {
      inst.idlePhase = 0;
    }
    const out = new Map();
    if (!moving) return out;   // 静止 = bind 姿态（原版 limbSwingAmount 为 0）
    const s = Math.sin(inst.idlePhase);
    for (const limb of this._idleLimbs) {
      const ang = s * IDLE_LIMB_AMPLITUDE * limb.sign;
      // 绕 X 轴的增量四元数
      out.set(limb.index, {
        rot: [Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)],
        pos: [0, 0, 0],
      });
    }
    if (this._idleRoot >= 0) {
      const ang = s * IDLE_ROOT_AMPLITUDE;
      out.set(this._idleRoot, {
        rot: [Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)],
        pos: [0, 0, 0],
      });
    }
    return out;
  }

  /**
   * 推进 y 缓动（三分支与丧尸/焰魔逐条同义）：
   * ① prevY===null（首帧）→ 对齐不触发；② dy>epsilon（上台阶）→ trigger；
   * ③ dy<0（下落）→ 立即清零。
   */
  _advanceLift(inst, physY, dt) {
    const prev = inst.prevY;
    inst.prevY = physY;
    if (prev === null) {
      inst.lift.offset = 0;
    } else {
      const dy = physY - prev;
      if (dy > GUARDIAN_STEP_LIFT.epsilon) inst.lift.trigger(dy);
      else if (dy < 0) inst.lift.offset = 0;
    }
    inst.lift.update(dt);
  }

  /** @returns {number} 只读测试钩子：x 击退补间偏移（格） */
  knockOffsetXOf(index) {
    const inst = this._instances[index];
    return inst ? inst.knock.offsetX : 0;
  }

  /** @returns {number} 只读测试钩子：z 击退补间偏移（格） */
  knockOffsetZOf(index) {
    const inst = this._instances[index];
    return inst ? inst.knock.offsetZ : 0;
  }

  /** @returns {number} 只读测试钩子：y 缓动偏移（格，≤0） */
  liftOffsetOf(index) {
    const inst = this._instances[index];
    return inst ? inst.lift.offset : 0;
  }

  /**
   * @returns {number} 只读测试钩子：**实际发布到 pivot 矩阵**的 y。
   * ⚠️ 只断言 liftOffsetOf 会漏掉「算对了但没写进矩阵」这个形态。
   */
  renderYOf(index) {
    const inst = this._instances[index];
    return inst ? inst.pivot.position.y : 0;
  }

  dispose() {
    for (const inst of this._instances) {
      this.scene.remove(inst.pivot);
      inst.material.dispose();
    }
    this._instances.length = 0;
    this._byId.clear();
    this._geometry.dispose();
    if (this._ownsTexture && this._texture) this._texture.dispose();
  }
}