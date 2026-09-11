// src/render/turret-renderer.js — M8：炮塔渲染（8 部件固定容量实例池，规格 §5.1）
//
// **为什么是每部件一个 InstancedMesh 而不是每炮塔 8 个 mesh**：mc-lite 每炮塔创建 8 个
// `THREE.Mesh`（`getTurretResources()` 内）挂在两级 Object3D 上；20 炮塔 = 160 个 scene 节点
// + 160 个 draw call。本仓库用 8 个固定容量 20 的 InstancedMesh（M6 六部件同手法），
// 每实例矩阵 = `T(pivot) × R_y(yaw) × R_x(-pitch) × 部件局部变换`，等价 mc-lite 的层级但
// 不产生 per-turret 节点。
//
// **为什么单材质 + UV 分区**：WebGPU 后端不支持材质数组 + geometry.groups（CLAUDE.md
// 活跃约束；M6 实测）→ 照 mc-lite 的「每部件一张贴图」写法会静默只渲染第一张。
// 三张装甲贴图烘焙成 192×64 三区横向并排（`tools/bake-turret-armor.mjs`），几何按部件
// 归属改写 UV 到对应区。
//
// ⚠️ **跨面 UV 换算不能用同一套公式**（CLAUDE.md 活跃约束：`BoxGeometry` 各面的
// `buildPlane` `vdir` 符号不同 —— 正面/侧面 `-1`、顶面 `+1`）。故用**归一化 u** 作统一
// 参数：`u' = zoneIndex/3 + u/3`，不碰 v（每个部件几何独立 → 不存在跨面取样问题）。
//
// ⚠️ **部件定义与区序从 `turret-config.js` 导入，本文件内不得出现裸标识符 `ZONES`**
// （上一版审查发现三处误用裸 `ZONES.length`/`ZONES.indexOf` → ReferenceError）。
//
// ⚠️ 无活跃炮塔时 8 个 mesh 全部 `visible=false`（否则恒增 8 个 draw call）。
import * as THREE from 'three';
import {
  TURRET, TURRET_PARTS, TURRET_PART_DEFS, ARMOR_ZONES, TURRET_TOWER_COLOR,
} from '../entities/turrets/turret-config.js';

// 复用的临时对象（避免每帧分配）—— 20 炮塔 × 8 部件 × 60fps 若在循环内 `new` 会产生
// 每秒约 9600 个小对象（照 `tracer-renderer.js` 的同一口径）。
const _matrix = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _rotX = new THREE.Matrix4();
const _pivotMatrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 按部件归属把 UV 改写进对应区（横向三区）。
 * ⚠️ 只改 u、不碰 v —— 每个部件是独立几何，不存在跨面取样（规避 `buildPlane` vdir 陷阱）。
 * @param {THREE.BufferGeometry} geometry @param {number} zoneIndex 0..ARMOR_ZONES.length-1
 */
function applyZoneUV(geometry, zoneIndex) {
  const uv = geometry.getAttribute('uv');
  const offset = zoneIndex / ARMOR_ZONES.length;
  const span = 1 / ARMOR_ZONES.length;
  for (let i = 0; i < uv.count; i++) uv.setX(i, offset + uv.getX(i) * span);
  uv.needsUpdate = true;
}

/** 构造部件几何（含炮管的 `rotateX(π/2)` —— mc-lite `getTurretResources()` 同口径）。 */
function buildPartGeometry(def) {
  if (def.geo === 'cylinder') {
    const g = new THREE.CylinderGeometry(def.diameter / 2, def.diameter / 2, def.length, 12);
    g.rotateX(Math.PI / 2);   // 炮管沿 +Z（mc-lite 同口径）
    return g;
  }
  return new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
}

export class TurretRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, armorTexture?: THREE.Texture|null}} deps
   *        `armorTexture` 可选：有则五块装甲板走贴图 + UV 分区；无则退回纯色
   *        `TURRET_TOWER_COLOR.MAIN/DARK` 与 `TURRET_GUN_COLOR.*`（单测 fixture 不需纹理也能跑）。
   */
  constructor({ scene, maxActive = TURRET.maxTurrets, armorTexture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    this._armorTexture = armorTexture;
    this.meshes = {};
    this._geometries = {};
    this._materials = {};
    for (const part of TURRET_PARTS) {
      const def = TURRET_PART_DEFS[part];
      const geometry = buildPartGeometry(def);
      const useMap = !!def.zone && !!armorTexture;
      if (useMap) applyZoneUV(geometry, ARMOR_ZONES.indexOf(def.zone));
      const material = new THREE.MeshBasicMaterial(useMap
        ? { color: 0xffffff, map: armorTexture }
        : { color: def.color ?? TURRET_TOWER_COLOR.MAIN });
      const mesh = new THREE.InstancedMesh(geometry, material, maxActive);
      mesh.name = `turret:${part}`;      // 受控标识：测试与调试据此定位节点
      // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；炮塔须无条件提交（同曳光池）
      mesh.frustumCulled = false;
      mesh.visible = false;              // ⚠️ 无活跃炮塔时不提交渲染（draw call 回基线）
      for (let i = 0; i < maxActive; i++) mesh.setMatrixAt(i, _zero);
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this.meshes[part] = mesh;
      this._geometries[part] = geometry;
      this._materials[part] = material;
    }
    /** @type {Map<string, number>} turretId → slot（**本层差集驱动分配**，见下方 sync 注释） */
    this._slots = new Map();
    this._nextSlot = 0;
  }

  /** 只读 slot 数（测试钩子：验证卸载/失效后 slot 都归还了）。@returns {number} */
  slotCount() { return this._slots.size; }

  /**
   * 发布 pose（只读 → 8 部件矩阵）。矩阵 = `T(pivot) × R_y(yaw) × R_x(-pitch) × 部件局部变换`。
   * ⚠️ **pitch 取反**（mc-lite `pitchObject.rotation.x = -this.currentPitch`，`Turret.js:656`：
   * three 旋转方向与 atan2 结果相反）。
   *
   * **差集驱动 slot**（M5 `EntityRenderLayer.sync` 同手法）：新 id 分配 slot、已有 id 更新矩阵、
   * 消失 id 归还 slot。炮塔不是 EntityManager 实体（是方块锚定装置），没有 `despawnColumn`
   * 绕过玩法服务的回收路径，故差集驱动自动覆盖全部回收场景（column 卸载 / 失效 / 放置）。
   *
   * @param {Map<string, {position:number[], yaw:number, pitch:number}>} poses
   */
  sync(poses) {
    const live = new Set();
    for (const [id, pose] of poses) {
      live.add(id);
      let slot = this._slots.get(id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(id, slot);
      }
      // pivot 变换**每个 pose 只算一次**（不是每部件算一次）—— 上一版计划里 `_pivotQuat`
      // 被放在部件循环内，20 炮塔 × 8 部件 = 每帧 160 次四元数计算，纯浪费。
      _pos.set(pose.position[0], pose.position[1], pose.position[2]);
      _euler.set(-pose.pitch, pose.yaw, 0, 'YXZ');   // 'YXZ'：先 yaw 后 pitch（等价 Object3D 层级）
      _quat.setFromEuler(_euler);
      _pivotMatrix.compose(_pos, _quat, _scale);
      for (const part of TURRET_PARTS) {
        const def = TURRET_PART_DEFS[part];
        // 部件局部变换：位置偏移 + 可选 rotX（前装甲板的倾斜）
        _local.makeTranslation(def.pos[0], def.pos[1], def.pos[2]);
        if (def.rotX !== undefined) {
          _euler.set(def.rotX, 0, 0);
          _rotX.makeRotationFromEuler(_euler);
          _local.multiply(_rotX);
        }
        _matrix.copy(_pivotMatrix).multiply(_local);
        this.meshes[part].setMatrixAt(slot, _matrix);
      }
    }
    // 归还消失 id 的 slot（清空 8 部件矩阵，不留残影）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      for (const part of TURRET_PARTS) this.meshes[part].setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    for (const part of TURRET_PARTS) this.meshes[part].instanceMatrix.needsUpdate = true;
    // ⚠️ 无炮塔时不提交渲染（否则 8 个常驻 mesh 恒增 8 个 draw call —— M6 实测教训）
    const anyActive = this._slots.size > 0;
    for (const part of TURRET_PARTS) this.meshes[part].visible = anyActive;
  }

  dispose() {
    for (const part of TURRET_PARTS) {
      const mesh = this.meshes[part];
      this.scene.remove(mesh);
      this._geometries[part].dispose();
      this._materials[part].dispose();   // InstancedMesh.dispose 不释放材质
      mesh.dispose();
    }
    if (this._armorTexture) this._armorTexture.dispose();
    this._slots.clear();
  }
}
