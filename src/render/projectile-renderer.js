// src/render/projectile-renderer.js — M8：弹丸渲染（固定 slot InstancedMesh，规格 §5.3）
// 几何照搬 mc-lite `InstancedProjectileRenderer.js:42`（圆柱 0.08 半径 × 2.0 长 × 8 段）。
// 朝向由 direction 派生（照 tracer-renderer 的 `setFromUnitVectors` 手法）。
//
// ⚠️ **slot 用差集驱动，不用 M6 的「service 分配 + 三条路径显式归还」**：
// M6 之所以要三条路径显式归还，是因为它的 slot 单一权威在 ZombieService，而
// `entities.despawnColumn()` 绕过 service → slot 不归还。弹丸没有玩法服务（直接经
// `entities.spawn/despawn`），故用「当前实体集合 vs 活动 slot」的差集驱动（M5
// `EntityRenderLayer.sync` 的同手法）—— 三条回收路径（命中 despawn / despawnColumn /
// dispose）自动覆盖，不需要逐条记账，也不会漏。
//
// ⚠️ 无活跃弹丸时 `visible=false`（否则恒增 1 个 draw call —— M6 实测教训）。
import * as THREE from 'three';
import { TURRET } from '../entities/turrets/turret-config.js';

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _dir = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 1, 0);   // CylinderGeometry 默认沿 +Y
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class ProjectileRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number}} deps
   *        ⚠️ 缺省容量**从 `TURRET.projectilePoolSize` 派生**（不是硬编码 64）——
   *        单测不传 maxActive 时钉的是这个值（照 ZombieRenderer 从 ZOMBIE.maxActive 派生）。
   */
  constructor({ scene, maxActive = TURRET.projectilePoolSize }) {
    this.scene = scene;
    this.maxActive = maxActive;
    const geometry = new THREE.CylinderGeometry(0.08, 0.08, 2.0, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xdddddd });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'projectile:pool';
    // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；弹丸须无条件提交（同曳光池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;              // ⚠️ 无活跃弹丸时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
    /** @type {Map<string, number>} entityId → slot（差集驱动，本层自己分配） */
    this._slots = new Map();
    this._nextSlot = 0;
    this._geometry = geometry;
    this._material = material;
  }

  /**
   * 与当前弹丸集合对齐：新实体分配 slot、已有实体更新矩阵、消失实体归还 slot。
   * @param {Iterable<{id: string, type: string, state: {position:number[], direction:number[]}}>} entities
   */
  sync(entities) {
    const live = new Set();
    for (const entity of entities) {
      if (entity.type !== 'projectile') continue;
      live.add(entity.id);
      let slot = this._slots.get(entity.id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(entity.id, slot);
      }
      const { position, direction } = entity.state;
      _pos.set(position[0], position[1], position[2]);
      _dir.set(direction[0], direction[1], direction[2]).normalize();
      _quat.setFromUnitVectors(_forward, _dir);
      _matrix.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(slot, _matrix);
    }
    // 归还消失实体的 slot（三条回收路径自动覆盖 —— 见文件头注释）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      this.mesh.setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = this._slots.size > 0;   // ⚠️ 无弹丸时不提交渲染
  }

  /** 只读 slot 数（测试钩子：验证三条回收路径都归还了 slot）。@returns {number} */
  slotCount() { return this._slots.size; }

  dispose() {
    this.scene.remove(this.mesh);
    this._geometry.dispose();
    this._material.dispose();   // InstancedMesh.dispose 不释放材质
    this.mesh.dispose();
    this._slots.clear();
  }
}
