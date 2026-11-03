// src/render/dragon-renderer.js — 祭坛飞龙（v2.41）：SkinnedMesh 渲染（受控发布层）
//
// 只读 pose 的**受控发布层**（同 `zombie-renderer.js` 序言）：不回写 state、不调
// `world.setBlock`、不作命中真相（实体命中只由 `EntityManager.raycast()` →
// `dragonDefinition.raycastAabb` 给出 —— 红线 6 禁止 Raycaster）。
//
// **为什么是 SkinnedMesh 单几何**：素材 115 个元素全部**刚性归属单个骨骼**（无蒙皮权重、
// 无 inflate），故 skinWeight 恒 1 —— SkinnedMesh 只是「骨骼驱动刚性块」的载体。115 盒合并成
// **一个 BufferGeometry**（2760 顶点）→ 整条龙 **1 个 draw call**；无龙时 `visible = false`
// → 0（M6「常驻 mesh 空载必须隐藏」口径）。已实测 WebGPU 后端蒙皮可用（spec §2.4 探针：
// 2 骨骼 + 旋转 45° → 左右像素不对称 6025/5145，零页面错误）。
//
// ⚠️ **骨骼增量必须从 bind 快照起算**（每帧 `bone.quaternion = bindQuat * deltaRot`）：
// 动画帧是「相对 bind pose 的增量」（spec §2.2）。若直接 `bone.quaternion *= delta` 会
// **逐帧累积** → 龙越飞越散架（实测形态：几秒后骨骼旋转数圈）。
//
// ⚠️ **材质 unlit（`MeshBasicMaterial`）**：与丧尸/矿车/海面同口径 —— 本仓灯光只为 PBR
// 武器而设，受光材质会吃 2.3 环境光漂移。
//
// ⚠️ **`DoubleSide` 是必需的**：翼膜是 1px 薄片（spec §2.1），单面渲染会从下方看穿
// （形态：龙从头顶飞过时翅膀消失）。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';
import { DRAGON, DRAGON_MODEL_CENTER } from '../entities/dragons/dragon-config.js';
import { sampleDragonPose } from './dragon-model.js';

/** 红闪色（与丧尸 `FLASH_COLOR` 同口径：纯红乘贴图） */
const FLASH_COLOR = 0xff0000;
/** 常态基色（白 —— 有贴图时基色必须白，否则「深色 × 纹理」变暗） */
const BASE_COLOR = 0xffffff;

/**
 * 龙的渲染器。一条龙 = 一个 SkinnedMesh（全世界恰好一条，spec §1 第 4 行）。
 */
export class DragonRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {{scale:number, bones:Array, geometry:object, animations:object}} asset
   *        `loadDragonAsset()` 的结果
   * @param {THREE.Texture|null} [texture] 龙贴图（缺省则内部加载）
   */
  constructor(scene, asset, texture = null) {
    this.scene = scene;
    this.asset = asset;
    this._texture = texture;
    this._ownsTexture = texture === null;

    // ---- 骨骼层级 ----
    this._bones = asset.bones.map((b) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.set(b.localPosition[0], b.localPosition[1], b.localPosition[2]);
      bone.quaternion.set(b.bindQuaternion[0], b.bindQuaternion[1], b.bindQuaternion[2], b.bindQuaternion[3]);
      return bone;
    });
    for (let i = 0; i < asset.bones.length; i++) {
      const p = asset.bones[i].parentIndex;
      if (p !== -1) this._bones[p].add(this._bones[i]);
    }
    // bind 快照：每帧从它起算增量（⚠️ 不存快照会逐帧累积 → 龙散架）
    this._bindQuat = asset.bones.map((b) => b.bindQuaternion.slice());
    this._bindPos = asset.bones.map((b) => b.localPosition.slice());

    // ---- 合并几何 ----
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

    // ---- 材质 ----
    this._material = new THREE.MeshBasicMaterial({
      color: BASE_COLOR,
      map: this._texture || undefined,
      alphaTest: 0.5,          // 翼膜镂空（57% 透明像素）走 cutout 语义，免透明排序
      side: THREE.DoubleSide,  // 1px 翼膜必须双面
    });

    // ---- SkinnedMesh ----
    this._mesh = new THREE.SkinnedMesh(geometry, this._material);
    this._mesh.add(this._bones[0]);
    this._mesh.bind(new THREE.Skeleton(this._bones));
    // 几何顶点是模型空间坐标（原点≈脚底），而 state.position 是身体中心 →
    // 把 mesh 局部偏移 −DRAGON_MODEL_CENTER，体心正好落在 state.position。
    // ⚠️ 挂在 yaw 父节点下（下面用一个 Group 承载旋转），偏移随朝向转，体心始终对准。
    this._mesh.position.set(-DRAGON_MODEL_CENTER[0], -DRAGON_MODEL_CENTER[1], -DRAGON_MODEL_CENTER[2]);
    this._pivot = new THREE.Group();
    this._pivot.add(this._mesh);
    this._pivot.visible = false;   // 初始无龙
    this.scene.add(this._pivot);
  }

  /** 加载贴图（构造时未传则调用）。走真实 `TextureLoader` 路径（flipY 口径，见下） */
  async loadTexture() {
    if (this._texture) return this._texture;
    const tex = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/dragon/dragon.png'));
    tex.colorSpace = THREE.SRGBColorSpace;
    // 像素风：nearest 采样保硬边（与丧尸皮肤同口径）
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    // ⚠️ **flipY 保持默认 true**：烘焙期的 v 轴换算（`v_three = 1 − v_px/128`）就是按这个
    // 前提做的。改成 false 会让整套贴图上下颠倒（AGENTS.md 已记两次该坑）。
    this._texture = tex;
    this._material.map = tex;
    this._material.needsUpdate = true;
    return tex;
  }

  /** SkinnedMesh（供测试读 visible / geometry / skeleton） */
  get mesh() { return this._mesh; }
  /** 承载 yaw 的父节点（供测试读 rotation） */
  get pivot() { return this._pivot; }

  /**
   * 每帧发布 pose（game 帧循环在 `entities.update` 之后调）。
   *
   * @param {{id:string, state:{position:number[], yaw:number, orbitT:number, flashedUntil:number}}|null} entity
   * @param {number} nowMs `performance.now()` 基准（红闪判定）
   */
  sync(entity, nowMs) {
    if (!entity) {
      this._pivot.visible = false;   // ⚠️ draw call 归零（M6 口径）
      return;
    }
    this._pivot.visible = true;
    const st = entity.state;
    this._pivot.position.set(st.position[0], st.position[1], st.position[2]);
    this._pivot.rotation.set(0, st.yaw, 0);
    // 盘旋内倾：绕局部 Z 的 roll。⚠️ 不得混进 yaw（那会改水平朝向），也不得在
    // rotation.set 之外用欧拉叠加（会互相耦合）—— 用 rotateZ 在 yaw 之后叠加局部 roll。
    this._pivot.rotateZ(DRAGON.bankRoll);

    // 动画：采样增量 → 从 bind 快照起算（不累积）
    const deltas = sampleDragonPose(this.asset.animations, st.orbitT);
    for (const [bi, delta] of deltas) {
      const bone = this._bones[bi];
      if (!bone) continue;
      const bq = this._bindQuat[bi];
      bone.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
      bone.quaternion.multiply(
        _tmpQuat.set(delta.rot[0], delta.rot[1], delta.rot[2], delta.rot[3]));
      const bp = this._bindPos[bi];
      bone.position.set(bp[0] + delta.pos[0], bp[1] + delta.pos[1], bp[2] + delta.pos[2]);
    }

    // 红闪：nowMs < flashedUntil → 纯红乘贴图（与丧尸同口径）。
    // ⚠️ 时间基准 performance.now()（Date.now() 会让判定恒真 → 永久红闪）。
    this._material.color.setHex(nowMs < st.flashedUntil ? FLASH_COLOR : BASE_COLOR);
  }

  dispose() {
    this.scene.remove(this._pivot);
    this._geometry.dispose();
    this._material.dispose();
    if (this._ownsTexture && this._texture) this._texture.dispose();
  }
}

const _tmpQuat = new THREE.Quaternion();
