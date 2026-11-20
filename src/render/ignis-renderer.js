// src/render/ignis-renderer.js — 焰魔（v2.55）：SkinnedMesh 渲染（受控发布层）
//
// 只读 pose 的**受控发布层**（同 `dragon-renderer.js` / `zombie-renderer.js` 序言）：
// 不回写 state、不调 `world.setBlock`、不作命中真相（实体命中只由 `EntityManager.raycast()`
// → `ignisDefinition.raycastAabb` 给出 —— 红线 6 禁止 Raycaster）。
//
// **为什么是 SkinnedMesh 单几何**：素材的 80 个立方体全部**刚性归属单根骨骼**（无蒙皮权重），
// 故 skinWeight 恒 1 —— SkinnedMesh 只是「骨骼驱动刚性块」的载体。80 盒合并成
// **一个 BufferGeometry**（1920 顶点）→ 每只焰魔 **1 个 draw call**；无焰魔时全部实例
// `visible = false` → 0（M6「常驻 mesh 空载必须隐藏」口径）。
//
// ## 实例池（与飞龙同手法，容量不同）
//
// 池容量 = `IGNIS.maxAlive`（2）。**共享几何与贴图，逐实例独立骨骼 + 独立材质**：
// - 几何/贴图共享：它们是烘焙产物的只读副本，N 份不会漂移。
// - **骨骼必须逐实例独立**：骨骼是 Object3D 层级，`bind()` 会把 skeleton 绑到具体 mesh；
//   共享骨骼会让所有焰魔摆同一个姿势。
// - **材质必须逐实例独立**：红闪是材质级 `color`。共享一份材质会让打中一只焰魔时
//   **所有焰魔一起变红**。
//
// ## 三处与飞龙渲染器的差异
//
// 1. **池容量 2**（不是 4）。
// 2. **脚底补偿**：几何的 y 原点**不是脚底** —— 烘焙期扫遍全部动画帧得到「动画全程
//    最低点」，把它记在产物的 `metrics.feetOffsetY` 里，渲染器直接把 mesh 抬高这个量，
//    「最低顶点」就恰好落在 `state.position.y`（脚底）。
//    ⚠️ **不得用 `IGNIS_MODEL_CENTER`（身体核心中心）做这件事** —— 那是命中盒的语义，
//    混用的形态是整个模型陷入地下 1.7 格（用户 2026-11-05 缺陷 A）。
// 3. **动画由 `attackAnimT` 选择**：`> 0` 走 `attack`（播完停末帧），否则走 `idle`（循环）。
//    飞龙是 `sampleDragonPose` 内部的状态机，这里没有。v2.75 起 `attackKind` 再在 `attack` /
//    `spin` 间选片段。**v2.76 起来源切换不再硬切**：逐实例的 `IgnisPoseTransition` 把上一帧发布的
//    姿态冻结成起点，在 `IGNIS_POSE_BLEND.seconds`（0.2s）内淡入新来源的实时采样（旋斩的 t=0 姿态
//    与 idle 差 177°，硬切就是用户看到的「站定 → 一帧闪成旋转举刀」）。纯视觉层，权威 state 仍瞬时。
//
// ⚠️ **骨骼增量必须从 bind 快照起算**（每帧 `bone.quaternion = bindQuat * deltaRot`）：
// 动画帧是「相对 bind pose 的增量」。若直接 `bone.quaternion *= delta` 会**逐帧累积**
// → 焰魔越挥越散架（实测形态：几秒后骨骼旋转数圈）。
//
// ⚠️ **材质 unlit（`MeshBasicMaterial`）**：与丧尸/矿车/飞龙同口径 —— 本仓灯光只为 PBR
// 武器而设，受光材质会吃环境光漂移。
//
// ⚠️ **`DoubleSide` 是必需的**：素材有零厚薄片（被跳过的 8 个）与 2px 实心盾面，
// 单面渲染会从某些角度看穿。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';
import {
  IGNIS, IGNIS_STEP_LIFT, IGNIS_POSE_BLEND, ignisBlendSeconds,
} from '../entities/ignis/ignis-config.js';
import { StepLift } from '../player/step-lift.js';
import { KnockbackEase } from './knockback-ease.js';
import { sampleIgnisAnim, sampleIgnisAttack, IgnisPoseTransition } from './ignis-model.js';

/** 红闪色（与丧尸/飞龙 `FLASH_COLOR` 同口径：纯红乘贴图） */
const FLASH_COLOR = 0xff0000;
/** 常态基色（白 —— 有贴图时基色必须白，否则「深色 × 纹理」变暗） */
const BASE_COLOR = 0xffffff;

const _tmpQuat = new THREE.Quaternion();
const _tmpVec = new THREE.Vector3();

/**
 * 焰魔的渲染器（实例池）。
 *
 * 池容量 = `IGNIS.maxAlive`；实例按**实体 id** 复用（`_byId` Map），焰魔消失即隐藏
 * （不销毁，下次召唤复用同一个实例）。
 */
export class IgnisRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {{scale:number, bones:Array, geometry:object, animations:object}} asset
   *        `loadIgnisAsset()` 的结果
   * @param {THREE.Texture|null} [texture] 焰魔贴图（缺省则内部加载）
   */
  constructor(scene, asset, texture = null) {
    this.scene = scene;
    this.asset = asset;
    this._texture = texture;
    this._ownsTexture = texture === null;
    // bind 快照（**全实例共享**：它是烘焙产物的只读数据，不是运行时状态）
    this._bindQuat = asset.bones.map((b) => b.bindQuaternion.slice());
    // ⚠️ **pivot 才是骨骼旋转中心**（绝对模型空间，单位格）。
    // 渲染时必须按**当前**旋转重算 position（见 `_syncOne`），不能用 bind 的 localPosition。
    this._pivot = asset.bones.map((b) => (b.pivot || [0, 0, 0]).slice());

    // ---- 合并几何（全实例共享一份）----
    const g = asset.geometry;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(g.normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(g.skinIndex, 4));
    // skinWeight 运行时生成：每顶点 [1,0,0,0]（刚性绑定）
    const weight = new Float32Array(g.skinIndex.length);
    for (let i = 0; i < weight.length; i += 4) weight[i] = 1;
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
    geometry.setIndex(g.index);
    this._geometry = geometry;

    // ---- 实例池（骨骼 + 材质 + SkinnedMesh 逐实例独立）----
    this._instances = [];
    for (let i = 0; i < IGNIS.maxAlive; i++) this._instances.push(this._makeInstance());
    /** @type {Map<string, number>} 实体 id → 实例下标 */
    this._byId = new Map();
    /**
     * 上次 `sync` 的时间戳（ms）—— 只为算出缓动用的 dt（调用方传的是时间戳，不是 dt）。
     * `null` = 首次（dt 给 0，与丧尸渲染器同口径）。
     */
    this._lastSyncMs = null;
  }

  /** 造一个实例：独立骨骼层级 + 独立材质 + SkinnedMesh + yaw 父节点 */
  _makeInstance() {
    const bones = this.asset.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.set(b.localPosition[0], b.localPosition[1], b.localPosition[2]);
      bone.quaternion.set(b.bindQuaternion[0], b.bindQuaternion[1], b.bindQuaternion[2], b.bindQuaternion[3]);
      return bone;
    });
    for (let i = 0; i < this.asset.bones.length; i++) {
      const p = this.asset.bones[i].parentIndex;
      if (p !== -1) bones[p].add(bones[i]);
    }

    // ⚠️ **材质逐实例独立**（红闪是材质级 color，共享会让所有焰魔一起变红）
    const material = new THREE.MeshBasicMaterial({
      color: BASE_COLOR,
      map: this._texture || undefined,
      alphaTest: 0.5,          // 零厚薄片与贴图镂空走 cutout 语义，免透明排序
      side: THREE.DoubleSide,  // 2px 盾面与薄片必须双面
    });

    const mesh = new THREE.SkinnedMesh(this._geometry, material);
    mesh.add(bones[0]);
    mesh.bind(new THREE.Skeleton(bones));
    // 几何顶点是模型空间坐标（原点在脚底附近），而 state.position 是**脚底** →
    // 只需把 mesh 抬高 `metrics.feetOffsetY`（烘焙期扫全部动画帧算出的最低点绝对值），
    // 使「动画全程的最低顶点」恰好落在 position.y。
    //
    // ⚠️⚠️ **这里曾经写成 `-IGNIS_MODEL_CENTER[1] + IGNIS.modelFeetOffsetY`**（-1.43），
    // 导致整个模型陷入地下 1.70 格（用户 2026-11-05 缺陷 A：「身体的下半截埋在地下」）。
    // 错因：把「身体核心 bbox 中心」（命中盒用，-1.7335）当成了「脚底」偏移。
    // `IGNIS_MODEL_CENTER` 与 `feetOffsetY` 是**两个不同语义的量**，不得混用。
    mesh.position.set(0, this.asset.metrics.feetOffsetY, 0);
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.visible = false;   // 初始无焰魔
    this.scene.add(pivot);
    return {
      bones, material, mesh, pivot,
      /**
       * 当前占用本实例的实体 id（`null` = 空闲）。
       *
       * ⚠️ **只为 P1-2 的缓动重置**：`sync` 按 list 下标分配实例，焰魔死亡后实例隐藏但
       * `prevY/lift.offset` 残留；重召时若 id 变了，必须把缓动状态清零，否则新焰魔
       * 出生会被当成一次「上台阶」陷进地面再 ease 上来。
       */
      entityId: null,
      /**
       * 上台阶视觉缓动（v2.62 用户缺陷③：「上台阶……而不是闪现到台阶之上」）。
       *
       * ⚠️ **逐实例一份**（共享会让多只焰魔互相打断）。衰减参数不写第二份 ——
       * 全部在 `StepLift` 里（红线 1，与玩家相机/丧尸同一手感）。
       */
      lift: new StepLift(),
      /**
       * 击退视觉补间（v2.81，用户缺陷：「boss 后退是瞬移的，不是缓动的」）。
       * 权威位置瞬时、只滞后渲染位置（见 `render/knockback-ease.js`）。逐实例一份。
       */
      knock: new KnockbackEase(),
      /**
       * 上一帧的物理 y（`null` = 未对齐）。**首帧必须不触发缓动** —— 实例初值在
       * y=0 附近，把「物理 y − 0」当成抬升量会让每只焰魔出生时都从世界底升上来
       *（丧尸渲染器实测踩过的同一个坑）。
       */
      prevY: null,
      /**
       * 姿态衔接（v2.76）：idle ↔ 攻击片段切换时的淡入淡出。**逐实例一份**（有状态：持有上一帧
       * 发布的姿态；共享会让两只焰魔互相拿对方的姿态当起点）。时长的唯一权威 = `IGNIS_POSE_BLEND`。
       */
      transition: new IgnisPoseTransition(IGNIS_POSE_BLEND.seconds),
    };
  }

  /**
   * 把一个实例的整副骨架恢复成 bind 姿态（四元数 + 位置）。
   *
   * 渲染器只写「当前来源驱动的骨骼」，所以实例复用给新实体时，上一只留下的姿态（尤其是只被攻击
   * 片段驱动的 sword / upperbody …）会残留在没被写到的骨骼上。与 `_makeInstance` 里骨骼的初值
   * 同一口径（同一份 `bindQuaternion` / `localPosition`）。
   */
  _restoreBindPose(inst) {
    for (let i = 0; i < inst.bones.length; i++) {
      const b = this.asset.bones[i];
      inst.bones[i].quaternion.set(
        b.bindQuaternion[0], b.bindQuaternion[1], b.bindQuaternion[2], b.bindQuaternion[3]);
      inst.bones[i].position.set(b.localPosition[0], b.localPosition[1], b.localPosition[2]);
    }
  }

  /** 加载贴图（构造时未传则调用）。走真实 `TextureLoader` 路径（flipY 口径，见下） */
  async loadTexture() {
    if (this._texture) return this._texture;
    const tex = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/ignis/ignis.png'));
    tex.colorSpace = THREE.SRGBColorSpace;
    // 像素风：nearest 采样保硬边（与丧尸皮肤/飞龙同口径）
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // ⚠️ **flipY 保持默认 true**：烘焙期的 v 轴换算（`v_three = 1 − v_px/256`）就是按这个
    // 前提做的。改成 false 会让整套贴图上下颠倒（AGENTS.md 已记两次该坑）。
    this._texture = tex;
    // 贴图可能在实例池建好之后才到 → 逐个材质补上
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
   * 焰魔贴图（`ignis.png`）。
   *
   * v3.24：尖刺剑纹直接复用这一张（零新增贴图）。**不得返回 null 以外的兜底值** ——
   * 调用方（`game.js` 的尖刺装配）靠 `?? null` 区分「有贴图」与「没加载上」，
   * 兜底一个占位贴图会把「贴图没加载」退化成「就是没纹理」而不可分辨。
   */
  get texture() { return this._texture; }

  /**
   * 每帧发布全部焰魔的 pose（game 帧循环在 `entities.update` 之后调）。
   *
   * ⚠️ **传数组而非单个实体**：调用方传 `ignises.activeEntities()`。
   * 不在池里的实体（消失的焰魔）其实例被隐藏 ⇒ draw call 归零。
   *
   * @param {Array<{id:string, state:{position:number[], yaw:number,
   *        flashedUntil:number, attackAnimT:number}}>} entities
   * @param {number} nowMs `performance.now()` 基准（红闪判定）
   */
  sync(entities, nowMs) {
    const list = entities || [];
    // 缓动用的 dt：调用方传的是时间戳（与丧尸渲染器同口径）
    const dt = this._lastSyncMs === null
      ? 0
      : Math.max(0, (nowMs - this._lastSyncMs) / 1000);
    this._lastSyncMs = nowMs;
    const used = new Set();
    for (let i = 0; i < list.length && i < this._instances.length; i++) {
      const entity = list[i];
      const inst = this._instances[i];
      used.add(i);
      this._byId.set(entity.id, i);
      // ⚠️ **实例复用给新实体时重置缓动**（final review P1-2）：`prevY` 只在 `_makeInstance()`
      //（构造期）设一次，而 `sync` 按 list 下标分配实例、隐藏时不清 `prevY/lift.offset`。
      // 于是：焰魔 A 在 y=10 死亡 → 实例隐藏、`prevY=10` 留存 → 在高原重召（y=46）→
      // `_advanceLift` 走分支②，`dy=36 > epsilon` ⇒ `trigger(36)` ⇒ 新焰魔出生头 ~190ms
      // 渲染在 y=45（陷进地面 1 格）再 ease 上来。两只焰魔且其中一只死亡时，
      // `activeEntities()` 顺序变化还会让另一只吃到这个伪抬升。
      // 丧尸侧没有这个问题：`acquireSlot` 每次 spawn 都重建 pose（`prevY: null`）。
      if (inst.entityId !== entity.id) {
        inst.entityId = entity.id;
        inst.prevY = null;
        inst.lift.offset = 0;
        // 击退补间同属「逐实例、隐藏时不清」的状态 —— 不清则新焰魔出生当帧被画在
        // 「上一只的位置」上（偏移量属于上一只的位移）。
        inst.knock.offsetX = 0;
        inst.knock.offsetZ = 0;
        // v2.76：姿态衔接同属「逐实例、隐藏时不清」的状态 —— 不清则新焰魔出生头 0.2s 从上一只的
        // 姿态淡出；骨架也要回 bind，否则上一只死于旋斩中途时，它的 sword/upperbody 会残留在新实体上。
        inst.transition.reset();
        this._restoreBindPose(inst);
      }
      this._syncOne(inst, entity, nowMs, dt);
    }
    // 未用到的实例一律隐藏（⚠️ draw call 归零，M6 口径）
    for (let i = 0; i < this._instances.length; i++) {
      if (!used.has(i)) this._instances[i].pivot.visible = false;
    }
    // 清掉已消失实体的 id 映射（避免 Map 无界增长）
    for (const [id, idx] of this._byId) {
      if (!used.has(idx) || !list.some((e) => e.id === id)) this._byId.delete(id);
    }
  }

  /**
   * 登记一次击退（由 `IgnisService.knockback` 经 Game 装配的注入钩子调用）。
   *
   * ⚠️ **不能改成「每帧比较渲染位置与物理位置、差得多就补间」**：焰魔 AI 每帧前进约
   * 0.09 格，而 0.9 格的击退可能被撞墙二分回退成 0.2 格 —— 阈值两侧都会误伤。
   * 故触发是显式事件，见 `render/knockback-ease.js`。
   *
   * @param {string} id 实体 id @param {number} dx @param {number} dz 实际水平位移（格）
   * @returns {boolean} false = 该 id 当前不在池里（未渲染，无需补间）
   */
  noteKnockback(id, dx, dz) {
    const idx = this._byId.get(id);
    if (idx === undefined) return false;
    const inst = this._instances[idx];
    if (!inst) return false;
    inst.knock.trigger(dx, dz);
    return true;
  }

  /** 发布单只焰魔 */
  _syncOne(inst, entity, nowMs, dt = 0) {
    const st = entity.state;
    inst.pivot.visible = true;
    // ---- 上台阶视觉缓动（v2.62）----
    // 为什么在渲染层而不是 Agent/物理：缓动**只服务观感**，权威 state 必须保持瞬时
    //（AABB 状态要精确，否则碰撞/实体射线/台阶净空全部错位）。与玩家的 `StepLift`
    //（`player.js` 消费 `physics.stepLiftAccum`）、丧尸的 `_advanceLift` 同一分工。
    this._advanceLift(inst, st.position[1], dt);
    // ---- 击退视觉补间（v2.81）：只滞后渲染位置（水平），权威 `state.position` 不动 ----
    inst.knock.update(dt);
    // ⚠️ **y 加 `lift.offset`、x/z 减 `knock.offset`**：两套缓动就落在这一处。写回 `st.position`
    // 会把缓动偏移污染成「物理位置」的副本（丧尸渲染器同一注释）。
    inst.pivot.position.set(
      st.position[0] - inst.knock.offsetX,
      st.position[1] + inst.lift.offset,
      st.position[2] - inst.knock.offsetZ,
    );
    // ⚠️ **欧拉顺序必须显式 'YXZ'**：three 默认 'XYZ' 下会先绕 X 再绕 Y，两个转动互相耦合。
    // 焰魔没有俯仰（地面实体），但保持与飞龙同一口径以免将来加俯仰时踩坑。
    inst.pivot.rotation.set(0, st.yaw, 0, 'YXZ');

    // 动画：按 `attackKind` 选片段（v2.75 二元，v3.01 三招，v3.03 四招）—— 四招形态完全不同，
    // 播错一支的形态是「旋斩演成横扫」/「举盾砸击演成持盾冲撞」，而「有动画在播」类断言全绿。
    //
    // ⚠️ **缺 `attackKind`（旧调用方）回落 `attack`**；`attackAnimT > 0` 仍是「是否在攻击」
    // 的判据 —— 两者不是同一件事：`attackKind` 只说哪一招，不表示现在在打。
    // ⚠️ **产物键存在性回落**：旧产物 + 新代码（`animations.shieldSmash` 为 undefined）时
    // 直接采样会 TypeError 或给出空姿态 ⇒ 回落 `attack`，不抛错（`test-ignis-render.js` 钉住）。
    const attackT = Number.isFinite(st.attackAnimT) ? st.attackAnimT : 0;
    const wantClip = st.attackKind === 'spin' ? 'spin'
      : st.attackKind === 'shieldSmash' ? 'shieldSmash'
        : st.attackKind === 'shieldBash' ? 'shieldBash'
          // v3.06：尖刺攻击按 `spikeSecond` 选单刀/双刀两条产物。
          // 两条的前 44 帧逐位相同 ⇒ 第一刀命中帧切换时姿态连续（无跳变）。
          : st.attackKind === 'spikeSlash' ? (st.spikeSecond ? 'spikeSlash2' : 'spikeSlash')
            : 'attack';
    const clipKey = this.asset.animations[wantClip] ? wantClip : 'attack';
    const sourceKey = attackT > 0 ? clipKey : 'idle';
    const target = attackT > 0
      ? sampleIgnisAttack(this.asset.animations[clipKey], attackT)
      : sampleIgnisAnim(this.asset.animations.idle, idleTimeOf(st));
    // ⚠️ **来源切换（idle ↔ 攻击片段）不得硬切**（v2.76 用户缺陷：旋斩起手 idle → spin(0) 单帧
    // 177°）。过渡器持有上一帧发布的姿态，切换时在 `IGNIS_POSE_BLEND.seconds` 内淡入新来源的实时采样。
    // 它是纯视觉层：权威 state（`attackAnimT` / 命中帧）仍瞬时，不受影响。
    // 时长按**目标来源**取（旋斩入场 0.6s、其余 0.2s，v2.77）；策略的单一权威是 `ignisBlendSeconds`。
    const deltas = inst.transition.step(sourceKey, target, dt, ignisBlendSeconds(sourceKey));
    for (const [bi, delta] of deltas) {
      const bone = inst.bones[bi];
      if (!bone) continue;
      const bq = this._bindQuat[bi];
      bone.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
      bone.quaternion.multiply(
        _tmpQuat.set(delta.rot[0], delta.rot[1], delta.rot[2], delta.rot[3]));
      // ⚠️⚠️ **骨骼原点必须按「当前」旋转重算**（用户 2026-11-05 缺陷 C：
      // 「挥舞兵刃的时候胳膊和身体分开了，特别是肩膀的部位」）。
      //
      // 骨骼的语义是「绕 pivot 旋转」：`M = T(pivot) · R · T(-pivot)`。
      // three 的 `Bone.position` 是父空间平移，故：
      //   `position = pivot − R_current · pivot + animDeltaPos`
      //
      // ⚠️ 用 **bind 的 localPosition**（烘焙产物里的那个）只能对 bind 姿态成立 ——
      // 动画一转，旋转中心就漂了。实测形态：right_arm 顶点落到 y=-3.2（躯干在 y=1.75~3.14），
      // 整条胳膊被甩到地下。
      const piv = this._pivot[bi];
      _tmpVec.set(piv[0], piv[1], piv[2]).applyQuaternion(bone.quaternion);
      bone.position.set(
        piv[0] - _tmpVec.x + delta.pos[0],
        piv[1] - _tmpVec.y + delta.pos[1],
        piv[2] - _tmpVec.z + delta.pos[2],
      );
    }

    // 红闪：nowMs < flashedUntil → 纯红乘贴图（与丧尸/飞龙同口径）。
    // ⚠️ 时间基准 performance.now()（Date.now() 会让判定恒真 → 永久红闪）。
    inst.material.color.setHex(nowMs < st.flashedUntil ? FLASH_COLOR : BASE_COLOR);
  }

  /**
   * 推进一只焰魔的 y 缓动（v2.62，与丧尸 `_advanceLift` 三分支逐条同义）。
   *
   * 三条分支都是**载荷性的**，任一条写错就退化成缺陷：
   * ① `prevY === null`（首帧 / 实例刚分配）→ **对齐不触发**（否则出生时从 y=0 升上来）；
   * ② `dy > epsilon`（上台阶）→ `trigger(dy)` 欠下一段负偏移，渲染 y 从旧高度 ease-out 追平；
   * ③ `dy < 0`（下落）→ **立即清零**，渲染直接跟随物理。下台阶的「动画」本来就来自
   *    重力，再叠一层缓动会让模型短暂陷进台阶下方。
   *
   * @param {object} inst `_instances[i]`
   * @param {number} physY 本帧物理 y（脚底）
   * @param {number} dt 距上一帧的秒数
   */
  _advanceLift(inst, physY, dt) {
    const prev = inst.prevY;
    inst.prevY = physY;
    if (prev === null) {
      inst.lift.offset = 0;                                        // ① 首帧对齐
    } else {
      const dy = physY - prev;
      if (dy > IGNIS_STEP_LIFT.epsilon) inst.lift.trigger(dy);      // ② 上台阶
      else if (dy < 0) inst.lift.offset = 0;                        // ③ 下落
    }
    inst.lift.update(dt);
  }

  /**
   * @param {number} index 实例下标
   * @returns {number} 只读测试钩子：当前 x 击退补间偏移（格，渲染位置 = 物理位置 − 该值）
   */
  knockOffsetXOf(index) {
    const inst = this._instances[index];
    return inst ? inst.knock.offsetX : 0;
  }

  /**
   * @param {number} index 实例下标
   * @returns {number} 只读测试钩子：当前 z 击退补间偏移（格）
   */
  knockOffsetZOf(index) {
    const inst = this._instances[index];
    return inst ? inst.knock.offsetZ : 0;
  }

  /**
   * @param {number} index 实例下标
   * @returns {number} 只读测试钩子：当前 y 缓动偏移（格，≤ 0）
   */
  liftOffsetOf(index) {
    const inst = this._instances[index];
    return inst ? inst.lift.offset : 0;
  }

  /**
   * @param {number} index 实例下标
   * @returns {number} 只读测试钩子：**实际发布到 pivot 矩阵**的 y = 物理 y + 缓动偏移。
   *
   * ⚠️ 只断言 `liftOffsetOf` 会漏掉「算对了但没写进矩阵」这个形态（v1.48 玩家晃动
   * 踩过：断言内部量时注入「算对但不写相机」仍全绿）。故另有一条用例直读
   * `instances[i].pivot.position.y` 交叉验证。
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

/**
 * 待机动画的采样时刻。
 *
 * 焰魔是**临时实体**（不进存档），state 里没有「存活时长」字段，故待机的相位用
 * `state.idleTime`（由 Agent 累加）—— 缺省 0。
 *
 * ⚠️ **不使用 `performance.now()`**：那会让「重新召唤的焰魔」继承上一只的相位，
 * 且纯函数的采样在单测里不可复现。相位属于实体状态，不属于渲染器。
 *
 * @param {object} st
 * @returns {number} 秒
 */
function idleTimeOf(st) {
  return Number.isFinite(st.idleTime) ? st.idleTime : 0;
}
