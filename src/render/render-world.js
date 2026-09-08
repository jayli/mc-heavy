// src/render/render-world.js — 发布层：3×BatchedMesh 通道级合批（§4.4.2 默认实现，DR-11）
// 每个 section = 1 geometry slot + 1 instance（1:1）；instance 矩阵 = section 世界偏移平移。
import * as THREE from 'three';
import { createVoxelMaterials } from './materials.js';
import { WORLD_MIN_Y, SECTION_SIZE, SECTIONS_PER_COLUMN } from '../voxel/constants.js';
import { DEBUG_FLAGS } from '../core/debug-config.js';

const CHANNELS = ['opaque', 'cutout', 'transparent'];
// 视距 8 容量口径（§4.4.2 v1.6；M3-1 按实测峰值重标定）：
// instance 元数据便宜按全 slot 预留；顶点按预期活跃非空 section × 平均顶点 × 1.25。
// maxVerts = active × avgVerts × 1.25 必须 ≥ 全量场景（城市+空岛+云层+洞穴+水面+撒布结构）
// 稳态 sum(reservedV)，否则加载/奔跑期触发 setGeometrySize 整批扩容（重建+拷贝 = 帧卡顿）。
// 实测（seed 12345，视距 8，奔跑 323 列）：opaque reserved 2.59M，cutout reserved 1.80M
// （撒布补齐后；flowerBed/pavilion/tallWell 的花与树叶走 cutout），transparent reserved 16K。
// 标定值给峰值 ~22% 余量（跨 seed 城市/林地密度浮动 + optimize() 回收前的瞬时高点）。
//
// ⚠️ cutout 扩容是**离散 ×1.5 跳增**（_ensureCapacity）：reserved 峰值只要超过 maxVerts
// 一个顶点就整批跳到 ×1.5。撒布补齐把 cutout 峰值推到 1.80M —— 旧标定 maxVerts=1.80M
// （450×3200×1.25）只比峰值高 0，奔跑 323 列实测峰值 1,802,230 超线 → 跳到 2.70M →
// GPU 顶点缓冲 170MB，撞破 §4.10 的 150MB 冻结预算。故 active 450→550（maxVerts→2.20M），
// 三通道合计 (2.85M+2.20M+0.125M)×30B = 148MB < 150MB。cutoutSlots 实测 498，active 550 覆盖。
// 旧值 opaque 4M 过度分配、cutout 562K 偏小导致运行时 3× 扩容，M3-1 一并修正。
const CAPACITY = {
  opaque:      { active: 1200, avgVerts: 1900 },
  cutout:      { active: 550, avgVerts: 3200 },  // 撒布补齐后 450→550（吸收 cutout 峰值，守 150MB）
  transparent: { active: 100, avgVerts: 1000 },
};

function slotKey(cx, sy, cz, channel) { return `${cx},${sy},${cz},${channel}`; }

export class RenderWorld {
  /**
   * @param {Object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Texture} opts.atlasTexture
   * @param {number} [opts.viewDistance]
   * @param {Object} [opts.capacity] 测试注入口：按通道覆盖 CAPACITY（{channel: {active, avgVerts}}）
   */
  constructor({ scene, atlasTexture, viewDistance = 8, capacity }) {
    this.scene = scene;
    const materials = createVoxelMaterials(atlasTexture);
    this.materials = materials;
    const maxInstances = Math.ceil((2 * viewDistance + 1) ** 2 * SECTIONS_PER_COLUMN * 1.2);
    /** @type {Object<string, THREE.BatchedMesh>} */
    this.meshes = {};
    /** @type {Map<string, {channel: string, geometryId: number, instanceId: number, reservedV: number, reservedI: number}>}
     *  key = `${cx},${sy},${cz},${channel}`（一个 section 可同时有 opaque/cutout/transparent 几何） */
    this.slotMap = new Map();
    /** 当前各通道缓冲预算（扩容后随之增长；无公开 getter，自行跟踪） */
    this._capacity = {};
    /**
     * M4：已通过 Scheduler 版本校验后发布的 section 版本（key=`${cx},${sy},${cz}`）。
     * 只读派生状态——不是体素副本，不参与调度分支，不改 Worker 协议；只让 Playwright
     * 对「队列收敛后发布版本 == 权威 column 版本」作直接断言（weapons-world-edit）。
     */
    this._sectionVersions = new Map();

    for (const channel of CHANNELS) {
      const cap = (capacity && capacity[channel]) || CAPACITY[channel];
      const maxVerts = Math.ceil(cap.active * cap.avgVerts * 1.25);
      const maxIdx = maxVerts * 1.5;
      const bm = new THREE.BatchedMesh(maxInstances, maxVerts, maxIdx, materials[channel]);
      bm.frustumCulled = false; // 整体不剔除，per-instance 剔除由 perObjectFrustumCulled 负责
      this._initAttributeLayout(bm);
      scene.add(bm);
      this.meshes[channel] = bm;
      this._capacity[channel] = { maxVertexCount: maxVerts, maxIndexCount: maxIdx };
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
  uploadSection(cx, sy, cz, channel, geomData, version) {
    const key = slotKey(cx, sy, cz, channel);
    // M4：记录本次发布的 section 版本（按 section 而非 channel——三个 channel 同一 version）。
    // 在零顶点删除与正常上传前都写入，使 getSectionVersion 反映最近一次发布。
    this._sectionVersions.set(`${cx},${sy},${cz}`, version);
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
        if (DEBUG_FLAGS.worldStats) {
          existing.vertexCount = geomData.vertexCount;
          existing.indexCount = geomData.indexCount;
        }
      } else {
        bm.deleteGeometry(existing.geometryId); // 级联删 instance
        const gid = this._addGeometrySafe(bm, channel, geom, reservedV, reservedI);
        const iid = bm.addInstance(gid);
        this._setInstanceMatrix(bm, iid, cx, sy, cz);
        this.slotMap.set(key, this._makeSlot(channel, gid, iid, reservedV, reservedI, geomData));
      }
    } else {
      const gid = this._addGeometrySafe(bm, channel, geom, reservedV, reservedI);
      const iid = bm.addInstance(gid);
      this._setInstanceMatrix(bm, iid, cx, sy, cz);
      this.slotMap.set(key, this._makeSlot(channel, gid, iid, reservedV, reservedI, geomData));
    }
  }

  /** 构造 slot 记录；worldStats 开关开启时才附带顶点/索引计数（通道统计用，§4.9） */
  _makeSlot(channel, geometryId, instanceId, reservedV, reservedI, geomData) {
    const slot = { channel, geometryId, instanceId, reservedV, reservedI };
    if (DEBUG_FLAGS.worldStats) {
      slot.vertexCount = geomData.vertexCount;
      slot.indexCount = geomData.indexCount;
    }
    return slot;
  }

  /**
   * 容量保障后再 addGeometry（设计文档 §4.4.2 兜底）。
   * BatchedMesh.deleteGeometry 只标记 inactive、不回收缓冲空间，delete+add 循环
   * （section 重建 / column 流转）会累积空洞直至 addGeometry 抛
   * "Reserved space request exceeds the maximum buffer size"。
   * 三级兜底：① 空间够直接加；② optimize() 重排回收空洞；③ 仍不足则
   * setGeometrySize() 整批扩容（重建几何并拷贝现有数据）后重试。
   */
  _addGeometrySafe(bm, channel, geom, reservedV, reservedI) {
    this._ensureCapacity(bm, channel, reservedV, reservedI);
    return bm.addGeometry(geom, reservedV, reservedI);
  }

  /** 确保 BatchedMesh 有足够空闲顶点/索引空间；不足时先回收空洞、再整批扩容。 */
  _ensureCapacity(bm, channel, reservedV, reservedI) {
    if (bm.unusedVertexCount >= reservedV && bm.unusedIndexCount >= reservedI) return;
    // ① 回收 deleteGeometry 留下的空洞（_nextVertexStart 不自动回缩）
    bm.optimize();
    if (bm.unusedVertexCount >= reservedV && bm.unusedIndexCount >= reservedI) return;
    // ② 整批扩容：新预算 = max(1.5×当前, 现有占用 + 本次需求)
    const cap = this._capacity[channel];
    const usedV = cap.maxVertexCount - bm.unusedVertexCount;
    const usedI = cap.maxIndexCount - bm.unusedIndexCount;
    const newV = Math.max(Math.ceil(cap.maxVertexCount * 1.5), usedV + reservedV);
    const newI = Math.max(Math.ceil(cap.maxIndexCount * 1.5), usedI + reservedI);
    bm.setGeometrySize(newV, newI);
    cap.maxVertexCount = newV;
    cap.maxIndexCount = newI;
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
    this._sectionVersions.delete(`${cx},${sy},${cz}`); // 删完三个 channel 后清版本记录
  }

  removeColumn(cx, cz) {
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) this.removeSection(cx, sy, cz);
  }

  /**
   * M4：已发布 section 的版本（无记录时 undefined）。只读诊断，不得被游戏逻辑读取后作写入决定。
   * @returns {number | undefined}
   */
  getSectionVersion(cx, sy, cz) {
    return this._sectionVersions.get(`${cx},${sy},${cz}`);
  }

  stats() {
    return { sections: this.slotMap.size, capacity: this._capacity, channels: this.channelStats() };
  }

  /**
   * 通道级合批统计（HUD 世界数据看板，§4.4.2）：每通道 slot/instance 数、
   * 实际顶点/索引/三角形数。对应 mc-lite 面板「consolidation 后 InstancedMesh 数」
   * 的语义——新架构为 3 个 BatchedMesh（opaque/cutout/transparent 各一），
   * 每通道 1 次 draw call（per-instance 剔除不改变 draw 数）。
   */
  channelStats() {
    const out = {};
    for (const channel of CHANNELS) {
      out[channel] = { slots: 0, vertices: 0, indices: 0, triangles: 0 };
    }
    for (const slot of this.slotMap.values()) {
      const c = out[slot.channel];
      c.slots++;
      c.vertices += slot.vertexCount || 0;
      c.indices += slot.indexCount || 0;
      c.triangles += Math.floor((slot.indexCount || 0) / 3);
    }
    return out;
  }

  /** 释放 GPU 资源（几何 + 三通道 BatchedMesh）；材质/纹理归调用方管理。 */
  dispose() {
    for (const channel of CHANNELS) this.meshes[channel].dispose();
    this.slotMap.clear();
  }
}
