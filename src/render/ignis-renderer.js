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
// 2. **脚底补偿**：模型最低顶点在 `y = −0.3042` 格（剑尖/脚甲探到原点下方），
//    故 mesh 的 y 偏移要**加上** `IGNIS.modelFeetOffsetY`。不补偿的形态是
//    「焰魔半只脚陷进地面」（0.3 格，肉眼看得出但格数与指纹全对）。
// 3. **动画由 `attackAnimT` 选择**：`> 0` 走 `attack`（播完停末帧），否则走 `idle`（循环）。
//    飞龙是 `sampleDragonPose` 内部的状态机，这里没有。
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
import { IGNIS, IGNIS_MODEL_CENTER } from '../entities/ignis/ignis-config.js';
import { sampleIgnisAnim, sampleIgnisAttack } from './ignis-model.js';

/** 红闪色（与丧尸/飞龙 `FLASH_COLOR` 同口径：纯红乘贴图） */
const FLASH_COLOR = 0xff0000;
/** 常态基色（白 —— 有贴图时基色必须白，否则「深色 × 纹理」变暗） */
const BASE_COLOR = 0xffffff;

const _tmpQuat = new THREE.Quaternion();

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
    this._bindPos = asset.bones.map((b) => b.localPosition.slice());

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
    // 几何顶点是模型空间坐标（原点≈脚底），而 state.position 是**脚底** →
    // 把 mesh 局部偏移 −IGNIS_MODEL_CENTER（体心回到原点），再 +modelFeetOffsetY
    // 把「最低顶点在 −0.3042 格」的模型抬起来，脚底才与 position.y 对齐。
    // ⚠️ 挂在 yaw 父节点下（Group 承载旋转），偏移随朝向转，体心始终对准。
    mesh.position.set(
      -IGNIS_MODEL_CENTER[0],
      -IGNIS_MODEL_CENTER[1] + IGNIS.modelFeetOffsetY,
      -IGNIS_MODEL_CENTER[2],
    );
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.visible = false;   // 初始无焰魔
    this.scene.add(pivot);
    return { bones, material, mesh, pivot };
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
    const used = new Set();
    for (let i = 0; i < list.length && i < this._instances.length; i++) {
      const entity = list[i];
      const inst = this._instances[i];
      used.add(i);
      this._byId.set(entity.id, i);
      this._syncOne(inst, entity, nowMs);
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

  /** 发布单只焰魔 */
  _syncOne(inst, entity, nowMs) {
    const st = entity.state;
    inst.pivot.visible = true;
    inst.pivot.position.set(st.position[0], st.position[1], st.position[2]);
    // ⚠️ **欧拉顺序必须显式 'YXZ'**：three 默认 'XYZ' 下会先绕 X 再绕 Y，两个转动互相耦合。
    // 焰魔没有俯仰（地面实体），但保持与飞龙同一口径以免将来加俯仰时踩坑。
    inst.pivot.rotation.set(0, st.yaw, 0, 'YXZ');

    // 动画：attackAnimT > 0 → attack（播完停末帧），否则 idle（循环）
    const attackT = Number.isFinite(st.attackAnimT) ? st.attackAnimT : 0;
    const deltas = attackT > 0
      ? sampleIgnisAttack(this.asset.animations.attack, attackT)
      : sampleIgnisAnim(this.asset.animations.idle, idleTimeOf(st));
    for (const [bi, delta] of deltas) {
      const bone = inst.bones[bi];
      if (!bone) continue;
      const bq = this._bindQuat[bi];
      bone.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
      bone.quaternion.multiply(
        _tmpQuat.set(delta.rot[0], delta.rot[1], delta.rot[2], delta.rot[3]));
      const bp = this._bindPos[bi];
      bone.position.set(bp[0] + delta.pos[0], bp[1] + delta.pos[1], bp[2] + delta.pos[2]);
    }

    // 红闪：nowMs < flashedUntil → 纯红乘贴图（与丧尸/飞龙同口径）。
    // ⚠️ 时间基准 performance.now()（Date.now() 会让判定恒真 → 永久红闪）。
    inst.material.color.setHex(nowMs < st.flashedUntil ? FLASH_COLOR : BASE_COLOR);
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
