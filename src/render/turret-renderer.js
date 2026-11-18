// src/render/turret-renderer.js — 炮塔渲染（8 部件固定容量实例池）
//
// **为什么是每部件一个 InstancedMesh 而不是每炮塔 8 个 mesh**：mc-lite 每炮塔创建 8 个
// `THREE.Mesh` 挂在两级 Object3D 上；20 炮塔 = 160 个 scene 节点 + 160 个 draw call。
// 本仓库用 8 个固定容量 20 的 InstancedMesh，每实例矩阵 =
// `T(pivot) × R_y(yaw) × R_x(-pitch)`，等价 mc-lite 的层级但不产生 per-turret 节点。
//
// ⚠️⚠️ **几何来自烘焙产物**（`assets/turret/turret-top.json`，`npm run turretop` 生成）：
// 塔顶换成了坦克模型的楔形颊舱 + 中央炮座 + 转台环 + 车体鼻段 + 主炮管 + 两组副武器。
// 顶点**已含世界化坐标**（定标 + pivot 平移烘进产物）⇒ **部件局部变换是恒等**，
// 8 个部件乘同一个 pivot 矩阵。这是用户裁定的**刚性一体**：炮管与炮头一起转，
// 不得给任何部件加独立旋转轴/俯仰轴（实测分层会让炮管在 ±45° 时飞出塔身）。
//
// ⚠️⚠️ **UV 权威在烘焙侧，本文件不得改写 UV**：产物 uv 已按面压进三区
// （`u' = zoneIndex/3 + u/3`）。旧版本这里有 `applyZoneUV`，若保留会把已压区的 u
// 再压一次（`z/3 + (z/3+u/3)/3`）⇒ 全部采到 front 区左侧，而顶点数/指纹全对（静默失效）。
//
// ⚠️ **贴图/纯色分支靠 `def.textured`，不是 `def.zone`**：新几何逐面分区，
// 部件级 `zone` 恒 null ⇒ 旧判据 `!!def.zone` 恒假，会让装甲全部退化成纯色。
//
// ⚠️ 无活跃炮塔时 8 个 mesh 全部 `visible=false`（否则恒增 8 个 draw call）。
import * as THREE from 'three';
import {
  TURRET, TURRET_PARTS, TURRET_PART_DEFS, TURRET_TOWER_COLOR,
} from '../entities/turrets/turret-config.js';

// 复用的临时对象（避免每帧分配）—— 20 炮塔 × 60fps 若在循环内 `new` 会产生大量小对象。
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** 从产物数据建 BufferGeometry（照 guardian-renderer.js 的 setAttribute 手法）。 */
function buildPartGeometry(data) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
  g.setIndex(data.index);
  return g;
}

export class TurretRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, armorTexture?: THREE.Texture|null,
   *          topGeometry?: {parts: Record<string, object>}|null}} deps
   *        `topGeometry` = `loadTurretTopGeometry()` 的返回值。**缺失时不建 mesh**
   *        （几何是造型的唯一来源，没有它就没有可画的东西）；`sync` 空转并 warn 一次。
   *        `armorTexture` 可选：有则装甲部件走贴图；无则退回 `TURRET_TOWER_COLOR.MAIN`。
   */
  constructor({ scene, maxActive = TURRET.maxTurrets, armorTexture = null, topGeometry = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    this._armorTexture = armorTexture;
    this.meshes = {};
    this._geometries = {};
    this._materials = {};
    this._ready = false;
    // ⚠️ **守卫不能只判 `!!topGeometry`**（final review Important 4）：
    // 合法 JSON 但无 parts 会让 `topGeometry.parts[part]` 抛 TypeError ⇒ 崩启动。
    // 加载器已校验形状，本层再守一道（单测/调试可能直接传畸形对象）。
    const parts = topGeometry && typeof topGeometry === 'object' ? topGeometry.parts : null;
    if (!parts || typeof parts !== 'object' || Array.isArray(parts)) {
      console.warn('[turret] 塔顶几何缺失或形状不合契约，本层不装配炮塔外观（玩法仍正常）');
    } else {
      for (const part of TURRET_PARTS) {
        const def = TURRET_PART_DEFS[part];
        const data = parts[part];
        if (!data || !Array.isArray(data.position) || data.position.length === 0) {
          console.warn(`[turret] 产物缺部件 ${part}，跳过`);
          continue;
        }
        const geometry = buildPartGeometry(data);
        // ⚠️ 判据是 def.textured（不是 def.zone —— 后者恒 null）
        const useMap = def.textured && !!armorTexture;
        const material = new THREE.MeshBasicMaterial(useMap
          ? { color: 0xffffff, map: armorTexture }
          : { color: def.color ?? TURRET_TOWER_COLOR.MAIN });
        const mesh = new THREE.InstancedMesh(geometry, material, maxActive);
        mesh.name = `turret:${part}`;      // 受控标识：测试与调试据此定位节点
        // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；炮塔须无条件提交
        mesh.frustumCulled = false;
        mesh.visible = false;              // ⚠️ 无活跃炮塔时不提交渲染（draw call 回基线）
        for (let i = 0; i < maxActive; i++) mesh.setMatrixAt(i, _zero);
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
        this.meshes[part] = mesh;
        this._geometries[part] = geometry;
        this._materials[part] = material;
      }
      // 只有真的建出了 mesh 才算 ready（全部部件都缺时 sync 应空转）
      this._ready = Object.keys(this.meshes).length > 0;
    }
    /** @type {Map<string, number>} turretId → slot（**本层差集驱动分配**） */
    this._slots = new Map();
    this._nextSlot = 0;
  }

  /** 只读 slot 数（测试钩子：验证卸载/失效后 slot 都归还了）。@returns {number} */
  slotCount() { return this._slots.size; }

  /**
   * 发布 pose（只读 → 8 部件矩阵）。矩阵 = `T(pivot) × R_y(yaw) × R_x(-pitch)`。
   * ⚠️ **pitch 取反**（mc-lite `pitchObject.rotation.x = -this.currentPitch`）。
   * ⚠️ **8 部件共用同一个 `_matrix`**（刚性一体）：几何已含世界化坐标，局部变换恒等。
   *
   * **差集驱动 slot**：新 id 分配 slot、已有 id 更新矩阵、消失 id 归还 slot。
   * 炮塔不是 EntityManager 实体（是方块锚定装置），没有 `despawnColumn` 绕过玩法服务的
   * 回收路径，故差集驱动自动覆盖全部回收场景（column 卸载 / 失效 / 放置）。
   *
   * @param {Map<string, {position:number[], yaw:number, pitch:number}>} poses
   */
  sync(poses) {
    if (!this._ready) return;
    const parts = Object.keys(this.meshes);
    const live = new Set();
    for (const [id, pose] of poses) {
      live.add(id);
      let slot = this._slots.get(id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(id, slot);
      }
      // pivot 变换**每个 pose 只算一次**，8 部件共用（刚性一体）
      _pos.set(pose.position[0], pose.position[1], pose.position[2]);
      _euler.set(-pose.pitch, pose.yaw, 0, 'YXZ');   // 'YXZ'：先 yaw 后 pitch
      _quat.setFromEuler(_euler);
      _matrix.compose(_pos, _quat, _scale);
      for (const part of parts) this.meshes[part].setMatrixAt(slot, _matrix);
    }
    // 归还消失 id 的 slot（清空矩阵，不留残影）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      for (const part of parts) this.meshes[part].setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    for (const part of parts) this.meshes[part].instanceMatrix.needsUpdate = true;
    // ⚠️ 无炮塔时不提交渲染（否则 8 个常驻 mesh 恒增 8 个 draw call）
    const anyActive = this._slots.size > 0;
    for (const part of parts) this.meshes[part].visible = anyActive;
  }

  dispose() {
    for (const part of Object.keys(this.meshes)) {
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
