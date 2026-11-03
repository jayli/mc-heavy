// src/render/fireball-renderer.js — 飞龙火球渲染（v2.44，固定 slot InstancedMesh）
//
// 与 `projectile-renderer.js` 同手法（差集驱动 slot + 零实例 visible=false），但**刻意独立**：
// 火球是球体（弹丸是圆柱）、火焰色（弹丸是灰白）、type 是 `fireball`（弹丸是 `projectile`）。
// 共用一个渲染器会让「火球被画成曳光弹」—— 两个 `sync` 都按 type 过滤，type 不同就互相看不见。
//
// ⚠️ **slot 用差集驱动，不用 M6 的「service 分配 + 三条路径显式归还」**：火球没有玩法服务
// （直接经 `entities.spawn/despawn`），故用「当前实体集合 vs 活动 slot」的差集驱动 ——
// 三条回收路径（命中爆炸 despawn / despawnColumn / dispose）自动覆盖，不需要逐条记账。
//
// ⚠️ 无活跃火球时 `visible=false`（否则恒增 1 个 draw call —— M6 实测教训）。
// ⚠️ 材质 unlit（`MeshBasicMaterial`）：本仓全场景 unlit 设计，灯光只为 PBR 武器模型而设
// （`zombie-renderer.js` / `minecart-renderer.js` 同口径）。火球是自发光的火焰，更不该吃环境光。
import * as THREE from 'three';
import { FIREBALL, FIREBALL_TYPE } from '../entities/dragons/dragon-config.js';

const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _quat = new THREE.Quaternion();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 火焰色（橙红）。
 *
 * ⚠️ **不用纯红 `0xff0000`**：纯红在 ACES 色调映射下会显得「塑料」，而火球要读作「一团火」。
 * 取 `0xff6a00`（橙）—— 与 TNT 爆炸序列帧的主色同色系，玩家会自然读作「火」。
 * ⚠️ 改这个值必须重跑 `tests/fireball-render.spec.mjs`（Tier 4 按「火焰色像素占比」判）。
 */
const FIREBALL_COLOR = 0xff6a00;

export class FireballRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number}} deps
   *        ⚠️ 缺省容量**从 `FIREBALL.poolSize` 派生**（不是硬编码）—— 单测不传 maxActive 时
   *        钉的是这个值（照 ProjectileRenderer 从 TURRET.projectilePoolSize 派生）。
   */
  constructor({ scene, maxActive = FIREBALL.poolSize }) {
    this.scene = scene;
    this.maxActive = maxActive;
    const geometry = new THREE.SphereGeometry(FIREBALL.radius, 12, 8);
    const material = new THREE.MeshBasicMaterial({ color: FIREBALL_COLOR });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'fireball:pool';
    // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；火球须无条件提交（同弹丸池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;              // ⚠️ 无活跃火球时不提交渲染
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
   * 与当前火球集合对齐：新实体分配 slot、已有实体更新矩阵、消失实体归还 slot。
   *
   * ⚠️ **球体不需要朝向**（各向同性），故矩阵只含平移 + 单位旋转 —— 与弹丸不同
   * （弹丸是圆柱，必须按 direction 定向）。保留 `_quat` 是为了将来加「拖尾/自转」时不改结构。
   *
   * @param {Iterable<{id: string, type: string, state: {position: number[]}}>} entities
   */
  sync(entities) {
    const live = new Set();
    for (const entity of entities) {
      if (entity.type !== FIREBALL_TYPE) continue;
      live.add(entity.id);
      let slot = this._slots.get(entity.id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(entity.id, slot);
      }
      const { position } = entity.state;
      _pos.set(position[0], position[1], position[2]);
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
    this.mesh.visible = this._slots.size > 0;   // ⚠️ 无火球时不提交渲染
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
