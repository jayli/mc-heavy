// src/render/render-world.js — 发布层：3×BatchedMesh 通道级合批（§4.4.2 默认实现，DR-11）
// 每个 section = 1 geometry slot + 1 instance（1:1）；instance 矩阵 = section 世界偏移平移。
import * as THREE from 'three';
import { createVoxelMaterials } from './materials.js';
import { WORLD_MIN_Y, SECTION_SIZE, SECTIONS_PER_COLUMN } from '../voxel/constants.js';

const CHANNELS = ['opaque', 'cutout', 'transparent'];
// 视距 8 容量口径（§4.4.2 v1.6）：instance 元数据便宜按全 slot 预留；
// 顶点按预期活跃非空 section × 平均顶点 × 1.25
const CAPACITY = {
  opaque:      { active: 800, avgVerts: 4000 },
  cutout:      { active: 300, avgVerts: 1500 },
  transparent: { active: 100, avgVerts: 1000 },
};

function slotKey(cx, sy, cz, channel) { return `${cx},${sy},${cz},${channel}`; }

export class RenderWorld {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Texture} opts.atlasTexture
   * @param {number} [opts.viewDistance]
   */
  constructor({ scene, atlasTexture, viewDistance = 8 }) {
    this.scene = scene;
    const materials = createVoxelMaterials(atlasTexture);
    const maxInstances = Math.ceil((2 * viewDistance + 1) ** 2 * SECTIONS_PER_COLUMN * 1.2);
    /** @type {Object<string, THREE.BatchedMesh>} */
    this.meshes = {};
    /** @type {Map<string, {channel: string, geometryId: number, instanceId: number, reservedV: number, reservedI: number}>}
     *  key = `${cx},${sy},${cz},${channel}`（一个 section 可同时有 opaque/cutout/transparent 几何） */
    this.slotMap = new Map();

    for (const channel of CHANNELS) {
      const cap = CAPACITY[channel];
      const maxVerts = Math.ceil(cap.active * cap.avgVerts * 1.25);
      const maxIdx = maxVerts * 1.5;
      const bm = new THREE.BatchedMesh(maxInstances, maxVerts, maxIdx, materials[channel]);
      bm.frustumCulled = false; // 整体不剔除，per-instance 剔除由 perObjectFrustumCulled 负责
      this._initAttributeLayout(bm);
      scene.add(bm);
      this.meshes[channel] = bm;
    }
  }

  /**
   * 强制初始化 BatchedMesh 合并几何的属性布局（position/uv/packed + index）。
   * BatchedMesh 的属性缓冲在首次 addGeometry 时才由 _initializeGeometry 延迟创建，
   * 而 TSL 材质在首次 render 时编译——若此时属性尚不存在，attribute('packed') 绑定
   * 失败默认为 0 → 亮度=0 → 全黑。先 add 再 delete 一个 dummy 几何，确保属性布局
   * 在首次 render/材质编译前就绪（dummy 删除后不渲染，缓冲按 maxVertexCount 全量分配，
   * 与首次真实 addGeometry 的分配一致，无额外显存）。
   */
  _initAttributeLayout(bm) {
    const dummy = new THREE.BufferGeometry();
    dummy.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 3), 3));
    dummy.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(3 * 2), 2));
    dummy.setAttribute('packed', new THREE.BufferAttribute(new Uint32Array(3), 1));
    dummy.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const id = bm.addGeometry(dummy);
    bm.deleteGeometry(id);
  }

  /** 从 SectionGeomData 构造 three BufferGeometry（flat 属性，M0 bench 验证的快路径格式） */
  _toGeometry(geomData) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(geomData.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(geomData.uvs, 2));
    g.setAttribute('packed', new THREE.BufferAttribute(geomData.packed, 1));
    g.setIndex(new THREE.BufferAttribute(geomData.indices, 1));
    return g;
  }

  /**
   * 上传/替换 section 几何（版本由调用方校验后传入）。
   * 首次 → addGeometry+addInstance+setMatrixAt；已有 → setGeometryAt（溢出走重建路径）。
   */
  uploadSection(cx, sy, cz, channel, geomData, _version) {
    const key = slotKey(cx, sy, cz, channel);
    if (geomData.vertexCount === 0) {
      // 只删本通道的 slot（不影响同 section 其他通道）
      const existing = this.slotMap.get(key);
      if (existing) {
        this.meshes[channel].deleteGeometry(existing.geometryId);
        this.slotMap.delete(key);
      }
      return;
    }
    const bm = this.meshes[channel];
    const geom = this._toGeometry(geomData);
    const reservedV = Math.ceil(geomData.vertexCount * 1.25);
    const reservedI = Math.ceil(geomData.indexCount * 1.25);
    const existing = this.slotMap.get(key);

    if (existing) {
      // 增量替换：未溢出预留 → setGeometryAt 快路径；溢出 → 重建 slot
      if (geomData.vertexCount <= existing.reservedV && geomData.indexCount <= existing.reservedI) {
        bm.setGeometryAt(existing.geometryId, geom);
      } else {
        bm.deleteGeometry(existing.geometryId); // 级联删 instance
        const gid = bm.addGeometry(geom, reservedV, reservedI);
        const iid = bm.addInstance(gid);
        this._setInstanceMatrix(bm, iid, cx, sy, cz);
        this.slotMap.set(key, { channel, geometryId: gid, instanceId: iid, reservedV, reservedI });
      }
    } else {
      const gid = bm.addGeometry(geom, reservedV, reservedI);
      const iid = bm.addInstance(gid);
      this._setInstanceMatrix(bm, iid, cx, sy, cz);
      this.slotMap.set(key, { channel, geometryId: gid, instanceId: iid, reservedV, reservedI });
    }
  }

  _setInstanceMatrix(bm, instanceId, cx, sy, cz) {
    const m = new THREE.Matrix4().makeTranslation(
      cx * SECTION_SIZE, WORLD_MIN_Y + sy * SECTION_SIZE, cz * SECTION_SIZE);
    bm.setMatrixAt(instanceId, m);
  }

  removeSection(cx, sy, cz) {
    for (const channel of CHANNELS) {
      const key = slotKey(cx, sy, cz, channel);
      const slot = this.slotMap.get(key);
      if (!slot) continue;
      this.meshes[channel].deleteGeometry(slot.geometryId);
      this.slotMap.delete(key);
    }
  }

  removeColumn(cx, cz) {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this.removeSection(cx, sy, cz);
  }

  stats() {
    return { sections: this.slotMap.size };
  }
}
