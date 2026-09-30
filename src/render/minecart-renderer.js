// src/render/minecart-renderer.js — 矿车渲染（2 个 InstancedMesh，设计文档 §5）
//
// **为什么是 2 个 InstancedMesh 而不是每车 5 个 mesh**：mc-lite 也是 InstancedMesh，
// 本仓库照 M6/M8 手法：车斗 1 个 + 车轮 1 个（容量 ×4），差集驱动 slot，
// 零实例时 `visible=false`（否则恒增 2 个 draw call —— M6 实测教训）。
//
// ⚠️ **车斗纹理是运行时 canvas 生成**（用户选定，设计文档 §6 偏离 5）：无指纹门禁保护，
// 纹理算法改动靠 Tier 4 像素实测兜底（记入 roadmap 遗留 TODO）。
import * as THREE from 'three';
import { MINECART, MINECART_TYPE, rotationAngleOf } from '../entities/minecarts/minecart-config.js';

// 复用的临时对象（避免每帧分配 —— 50 车 × 5 实例 × 60fps）
const _dummy = new THREE.Object3D();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** 车轮相对车中心的四个偏移（mc-lite `updateWheelMatrices` 的 wheelOffsets 逐位）。 */
const WHEEL_OFFSETS = Object.freeze([
  Object.freeze({ x: -MINECART.trackWidth / 2, z: MINECART.wheelbase / 2 }),   // 左前
  Object.freeze({ x: MINECART.trackWidth / 2, z: MINECART.wheelbase / 2 }),    // 右前
  Object.freeze({ x: -MINECART.trackWidth / 2, z: -MINECART.wheelbase / 2 }),  // 左后
  Object.freeze({ x: MINECART.trackWidth / 2, z: -MINECART.wheelbase / 2 }),   // 右后
]);

/**
 * 倒梯形开口车斗几何（mc-lite `createTrapezoidGeometry` 顶点逐位移植）。
 * 顶 0.9×0.9、底缩 0.8 倍、高 0.8、**无顶面**（开口车斗）、5 个四边形。
 * 几何中心在原点（渲染时按 `position + (0.5, bodyHeight/2 + wheelRadius, 0.5)` 摆放）。
 */
export function createBodyGeometry() {
  const tw = MINECART.bodyWidth / 2;
  const td = MINECART.bodyDepth / 2;
  const bw = MINECART.bodyWidth * MINECART.bodyShrinkRatio / 2;
  const bd = MINECART.bodyDepth * MINECART.bodyShrinkRatio / 2;
  const h = MINECART.bodyHeight / 2;
  const p = {
    bbl: [-bw, -h, -bd], bbr: [bw, -h, -bd], bfr: [bw, -h, bd], bfl: [-bw, -h, bd],
    tbl: [-tw, h, -td], tbr: [tw, h, -td], tfr: [tw, h, td], tfl: [-tw, h, td],
  };
  const positions = [];
  const uvs = [];
  const indices = [];
  const addFace = (a, b, c, d) => {
    const base = positions.length / 3;
    for (const v of [a, b, c, d]) positions.push(v[0], v[1], v[2]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);   // 统一四边形 UV（mc-lite 同口径）
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  addFace(p.bbl, p.bbr, p.bfr, p.bfl);   // 底
  addFace(p.bfl, p.bfr, p.tfr, p.tfl);   // 前
  addFace(p.bbr, p.bbl, p.tbl, p.tbr);   // 后
  addFace(p.bbl, p.bfl, p.tfl, p.tbl);   // 左
  addFace(p.bfr, p.bbr, p.tbr, p.tfr);   // 右
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 车斗纹理（mc-lite `createMinecartBodyTexture` 逐行移植：渐变 + 上沿压边 + 底部阴影
 * + 420 金属噪点 + 竖向拉丝）。⚠️ **运行时生成 → 无指纹门禁**（设计文档 §6 偏离 5）。
 * @returns {THREE.CanvasTexture|null} 无 2D context 时返回 null（材质退回纯色）
 */
export function createMinecartBodyTexture() {
  const size = MINECART.textureSize;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, '#a7afb8');
  gradient.addColorStop(0.5, '#c0c6ce');
  gradient.addColorStop(1, '#8f98a2');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(58, 63, 70, 0.8)';                       // 顶部深色压边
  ctx.fillRect(0, 0, size, Math.floor(size * 0.14));
  ctx.fillStyle = 'rgba(40, 45, 52, 0.2)';                       // 底部阴影
  ctx.fillRect(0, Math.floor(size * 0.85), size, Math.floor(size * 0.15));
  for (let i = 0; i < 420; i++) {                                 // 金属噪点
    const x = (Math.random() * size) | 0;
    const y = (Math.random() * size) | 0;
    const v = 155 + ((Math.random() * 60) | 0);
    const alpha = 0.1 + Math.random() * 0.2;
    ctx.fillStyle = `rgba(${v}, ${v}, ${v}, ${alpha.toFixed(3)})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.strokeStyle = 'rgba(235, 240, 245, 0.08)';                  // 竖向拉丝
  for (let x = 0; x < size; x += 6) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export class MinecartRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number}} deps
   *        `maxActive` 缺省 = `MINECART.maxMinecarts`（**必须从 config 派生**，红线 1）
   */
  constructor({ scene, maxActive = MINECART.maxMinecarts }) {
    this.scene = scene;
    this.maxActive = maxActive;
    this._texture = createMinecartBodyTexture();
    this._bodyGeometry = createBodyGeometry();
    this._wheelGeometry = new THREE.CylinderGeometry(
      MINECART.wheelRadius, MINECART.wheelRadius, MINECART.wheelHeight, 8);
    // ⚠️ **材质用 `MeshBasicMaterial`（unlit）而非 mc-lite 的 `MeshStandardMaterial`** ——
    // mc-heavy 全场景是 unlit 设计，灯光只为 PBR 武器模型而设（`zombie-renderer.js:32` 同口径：
    // 用受光材质会让实体吃到为枪标定的 2.3 环境光强度 → 偏亮且随日夜灯光漂移）。
    // 故 mc-lite 的 metalness/roughness 两个字段在本仓库**无消费点**（保留在 config 里仅作
    // mc-lite 出处记录，不参与渲染）—— 与「床材质的 offset/rotation 是死字段」同一类事实。
    this._bodyMaterial = new THREE.MeshBasicMaterial({
      color: MINECART.bodyColor,
      map: this._texture,
      side: THREE.DoubleSide,   // 开口车斗：内壁也要可见（mc-lite 同口径）
    });
    this._wheelMaterial = new THREE.MeshBasicMaterial({ color: MINECART.wheelColor });
    this.meshes = {
      body: this._createMesh(this._bodyGeometry, this._bodyMaterial, maxActive, 'minecart:body'),
      wheel: this._createMesh(this._wheelGeometry, this._wheelMaterial,
        maxActive * WHEEL_OFFSETS.length, 'minecart:wheel'),
    };
    /** @type {Map<string, number>} minecartId → slot（差集驱动，炮塔同手法） */
    this._slots = new Map();
    this._nextSlot = 0;
  }

  _createMesh(geometry, material, count, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;                 // 受控标识：测试与调试据此定位节点
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;       // 实例池包围球按 slot 0 算 → 会被误剔除（炮塔同口径）
    mesh.visible = false;             // ⚠️ 无活跃矿车时不提交渲染
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _zero);
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    return mesh;
  }

  /** 只读 slot 数（测试钩子）。 */
  slotCount() { return this._slots.size; }

  /**
   * 发布 pose（只读 state → 实例矩阵）。**差集驱动 slot**：新 id 分配、消失 id 归还。
   * ⚠️ 渲染层不回写 state（M5 约束）。
   * @param {Iterable<import('../entities/entity-manager.js').Entity>} entities
   */
  sync(entities) {
    const live = new Set();
    for (const entity of entities) {
      if (entity.type !== MINECART_TYPE) continue;
      const id = entity.id;
      live.add(id);
      let slot = this._slots.get(id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(id, slot);
      }
      const [x, y, z] = entity.state.position;
      // ⚠️ **原点换算 +0.5**（块底角 → 块中心；CLAUDE.md 活跃约束）
      const px = x + 0.5;
      const pz = z + 0.5;
      const ry = rotationAngleOf(entity.state.orientation);
      // 车斗：y = 车Y + bodyHeight/2 + wheelRadius（mc-lite `updateBodyMatrix`）
      _dummy.position.set(px, y + MINECART.bodyHeight / 2 + MINECART.wheelRadius, pz);
      _dummy.rotation.set(0, ry, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      this.meshes.body.setMatrixAt(slot, _dummy.matrix);
      // 4 个车轮（mc-lite `updateWheelMatrices`：rotation = (0, ry + π/2, π/2)）
      for (let w = 0; w < WHEEL_OFFSETS.length; w++) {
        const offset = WHEEL_OFFSETS[w];
        _dummy.position.set(px + offset.x, y + MINECART.wheelRadius, pz + offset.z);
        _dummy.rotation.set(0, ry + Math.PI / 2, Math.PI / 2);
        _dummy.updateMatrix();
        this.meshes.wheel.setMatrixAt(slot * WHEEL_OFFSETS.length + w, _dummy.matrix);
      }
    }
    // 归还消失 id 的 slot（清矩阵，不留残影）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      this.meshes.body.setMatrixAt(slot, _zero);
      for (let w = 0; w < WHEEL_OFFSETS.length; w++) {
        this.meshes.wheel.setMatrixAt(slot * WHEEL_OFFSETS.length + w, _zero);
      }
      this._slots.delete(id);
    }
    this.meshes.body.instanceMatrix.needsUpdate = true;
    this.meshes.wheel.instanceMatrix.needsUpdate = true;
    const anyActive = this._slots.size > 0;
    this.meshes.body.visible = anyActive;
    this.meshes.wheel.visible = anyActive;
  }

  dispose() {
    for (const key of ['body', 'wheel']) {
      this.scene.remove(this.meshes[key]);
      this.meshes[key].dispose();
    }
    this._bodyGeometry.dispose();
    this._wheelGeometry.dispose();
    this._bodyMaterial.dispose();
    this._wheelMaterial.dispose();
    if (this._texture) this._texture.dispose();
    this._slots.clear();
  }
}
