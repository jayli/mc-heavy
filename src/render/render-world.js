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
//
// ⚠️ 巨树景观（用户裁决 2026-10-23，接受 opaque ×1.5）：opaque active 1200→1800（maxVerts 2.85M→4.275M）。
// 验收口径是 reserved（= 1.25 × 已用顶点）相对**初始**容量：终版参数实测 reserved 峰值 82.1%（森林冲刺，相对 4.275M，
// 零 opaque 扩容）；折算到 2.85M 为 (-20,10) 视域 105%、冲刺 123% → 必然 ×1.5 扩容，故抬容量而非压树量。
// 三通道合计 (4.275M+2.20M+0.125M)×30B = 188.83 MiB（§4.10 的 150MiB 冻结预算由此有意上调，见设计文档 §4.10）。
// cutout / transparent 不变：HEAD 在密林视域本就越线（cutout 128%），巨树只把旧森林树（cutout）替换成 opaque 叶，cutout 只降不升。
const CAPACITY = {
  opaque:      { active: 1800, avgVerts: 1900 },  // 巨树景观 1200→1800（用户裁决：opaque ×1.5，2.85M→4.275M）
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
   * @param {THREE.DirectionalLight} [opts.sunLight] 太阳灯（传入则三通道材质接收阴影；null 保持原路径）
   * @param {Object} [opts.capacity] 测试注入口：按通道覆盖 CAPACITY（{channel: {active, avgVerts}}）
   */
  constructor({ scene, atlasTexture, viewDistance = 8, sunLight = null, capacity }) {
    this.scene = scene;
    const materials = createVoxelMaterials(atlasTexture, sunLight);
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
      // 阴影投射/接收（§4.4.4 DR-2 通道粗粒度）：opaque + cutout 投射，transparent（水/玻璃）
      // **既不投射也不接收**。BatchedMesh extends Mesh → castShadow/receiveShadow 直接可用，
      // perObjectFrustumCulled 默认 true → 阴影 pass 用 shadow camera 逐 instance 剔除。
      // ⚠️ 只在 sunLight 非 null 时打开：无阴影接线时开 castShadow 会白付一次阴影 pass。
      // ⚠️ **transparent 必须 receiveShadow=false（不只 castShadow=false）**：VSM 档位的阴影
      // pass 判据是 `castShadow || (receiveShadow && VSM)`（three.webgpu.js:44682）—— receive
      // 为 true 会把水/玻璃几何**渲进阴影深度图 → 照样投影**（DR-4b 选 VSM 的连带后果）。
      // mc-lite 对 water/glass 也是 cast+receive 双 false（GlobalInstancedMeshManager.js:76-84），
      // 此处对齐：transparent 通道完全不参与阴影。
      if (sunLight) {
        const isTransparent = channel === 'transparent';
        bm.castShadow = !isTransparent;
        bm.receiveShadow = !isTransparent;
        // ⚠️ 投影通道必须装「multi-draw 列表守卫」—— 否则每次阴影刷新会让**远端几何整帧消失**
        // （肉眼是远处一闪一闪透出天空）。根因与实测见 _installShadowListGuard 的 JSDoc。
        if (bm.castShadow) this._installShadowListGuard(bm);
      }
      this._initAttributeLayout(bm);
      scene.add(bm);
      this.meshes[channel] = bm;
      this._capacity[channel] = { maxVertexCount: maxVerts, maxIndexCount: maxIdx };
    }
  }

  /**
   * 给投影通道的 BatchedMesh 装「阴影 pass 前后快照/恢复 multi-draw 列表」守卫。
   *
   * **根因（three r185.1 的 BatchedMesh 与阴影 pass 共用一份可变状态）**：
   * 主 pass 与阴影 pass 都调 `BatchedMesh.onBeforeRender()`，而它把剔除结果写进**同一组实例字段**
   * （`_multiDrawStarts` / `_multiDrawCounts` / `_multiDrawCount` / `_indirectTexture`，
   * three.core.js:27504-27634）。一帧内的真实顺序（钩子实测，探针 P19）：
   *   ① 主 `renderObject` → `onBeforeRender(主相机)` → 列表 = 453（主视锥内的 instance）
   *   ② `_nodes.updateBefore` → ShadowNode → 阴影 pass → `onBeforeShadow()`
   *      → `onBeforeRender(null, **阴影相机**)`（three.core.js:27636）→ **覆写同一列表 = 142**
   *      （只剩阴影相机 ±30 视锥内的 instance）
   *   ③ 回到主 `renderObject` → `backend.draw` 读 `_multiDrawCount`（three.webgpu.js:85522）
   *      → 读到 **142** → 主视锥内、但阴影视锥外的几何**整帧不绘制** → 透出天空
   * 只在 `needsRefresh` 为真的帧发生（② 仅在阴影刷新时跑）→ 表现为「每次刷新一帧亮闪」。
   *
   * **实测证据**（探针 P17/P18/P22，平台 + 强制 5Hz 刷新 + 逐帧读像素）：
   *   · 亮闪次数 == 刷新次数（9 次刷新 → 9 帧亮闪），且**只**出现在阴影相机视锥外的采样点
   *     （视锥内 sd=0）；亮闪值 192 == noon 天空亮度 (135+206+235)/3 → 该帧几何确实消失
   *   · 修法生效：远端逐帧亮度恒定（sd=0），且 drawCalls 与基线**逐位相同**（vd=8 实测 630）
   *
   * **为什么不用 `perObjectFrustumCulled = false`**（更短的一行）：那会同时关掉**主 pass** 的
   * 逐 instance 剔除 → drawCalls vd2 48→183、vd8 467→1785（实测 3.8×），撞破 render-terrain
   * 的冻结断言 `drawCalls < 100`。本守卫只隔离两个 pass 的状态，主 pass 剔除与 draw 数不变。
   *
   * **为什么 mc-lite 没有这个问题**：mc-lite 的地形走 `InstancedMesh`
   * （GlobalInstancedMeshManager.js:56 / ChunkGenerator.js:177,228），它**没有**逐 instance 的
   * multi-draw 列表（`onBeforeShadow` 是 Object3D 的空实现，three.core.js:12151）→ 阴影 pass
   * 无从覆写主 pass 的绘制状态。本仓库按红线 5 用 BatchedMesh 通道级合批，才暴露该上游缺陷。
   *
   * 快照缓冲复用（不每次 slice 新分配）：5Hz × 2 通道 × ~450 项，避免热路径 GC 压力。
   * @param {THREE.BatchedMesh} bm 投影通道的 BatchedMesh
   */
  _installShadowListGuard(bm) {
    const origBeforeShadow = bm.onBeforeShadow;
    const origAfterShadow = bm.onAfterShadow;
    // 复用缓冲：容量按当前 _multiDrawStarts 长度（= maxInstanceCount）；扩容后按需重建。
    let saved = null;
    bm.onBeforeShadow = function (...args) {
      const n = this._multiDrawCount;
      const starts = this._multiDrawStarts;
      const counts = this._multiDrawCounts;
      const indirect = this._indirectTexture.image.data;
      if (!saved || saved.starts.length < starts.length) {
        saved = { n: 0, starts: new Int32Array(starts.length), counts: new Int32Array(counts.length), indirect: new Uint32Array(indirect.length) };
      }
      saved.n = n;
      saved.starts.set(starts.subarray(0, n));
      saved.counts.set(counts.subarray(0, n));
      saved.indirect.set(indirect.subarray(0, n));
      return origBeforeShadow.apply(this, args);
    };
    bm.onAfterShadow = function (...args) {
      const r = origAfterShadow.apply(this, args);
      if (saved) {
        // 恢复主 pass ① 建好的列表，使 ③ 的 backend.draw 读到主视锥的剔除结果
        this._multiDrawCount = saved.n;
        this._multiDrawStarts.set(saved.starts.subarray(0, saved.n));
        this._multiDrawCounts.set(saved.counts.subarray(0, saved.n));
        this._indirectTexture.image.data.set(saved.indirect.subarray(0, saved.n));
        // 阴影 pass 末尾已置 needsUpdate（three.core.js:27630）；CPU 侧数据被我们改回，
        // 须再置一次让 GPU 重新上传（否则 shader 读到的 indirect 索引仍是阴影 pass 的）。
        this._indirectTexture.needsUpdate = true;
      }
      return r;
    };
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
