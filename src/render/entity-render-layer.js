// src/render/entity-render-layer.js — M5：受控实体渲染层（M5 规格 §2）
//
// 职责只有一条：把 EntityManager 的**只读 pose** 发布成 scene 节点。它是派生发布层，
// 不是第二份实体真相（红线 1）—— 不得回写 state、不得调 `world.setBlock`、不得以 three mesh
// 作为命中真相（实体命中只由 `EntityManager.raycast()` 给出，地形命中只由 `raycastVoxel()` 给出）。
//
// 为什么是「受控节点」而不是任意 mesh：每个实体的 scene 节点由 layer 创建/更新/销毁，
// 节点不回写 state —— scene 节点只是 pose 的投影。改节点位置不会改变实体逻辑（实测钉在
// entities.spec.mjs：手动改 node.position 后 entity.state 不变）。
//
// probe 的 node 是单个受控 THREE.Group（本任务的 render contract fixture）。
// **未来丧尸改用自己的实例渲染器**（M6 六部件 InstancedMesh），不复用 per-entity Group ——
// 每实体一个 Group 在 20+ 实体时是性能反模式，M5 只为单 probe 验证发布/回收对称性。
import * as THREE from 'three';

export class EntityRenderLayer {
  /**
   * @param {{scene: THREE.Scene}} deps
   */
  constructor({ scene }) {
    this.scene = scene;
    /** @type {Map<string, {createNode: Function, applyPose: Function, disposeNode: Function}>} type → 渲染定义 */
    this._types = new Map();
    /** @type {Map<string, {type: string, node: THREE.Object3D}>} entityId → 活动节点（派生缓存） */
    this._nodes = new Map();
  }

  /**
   * 注册一种实体类型的渲染定义。
   * @param {string} type
   * @param {{createNode: () => THREE.Object3D,
   *          applyPose: (node: THREE.Object3D, entity: Readonly<object>) => void,
   *          disposeNode: (node: THREE.Object3D) => void}} def
   */
  register(type, def) {
    for (const fn of ['createNode', 'applyPose', 'disposeNode']) {
      if (typeof def?.[fn] !== 'function') {
        throw new Error(`EntityRenderLayer: 类型 "${type}" 缺少 ${fn}`);
      }
    }
    this._types.set(type, def);
  }

  /**
   * 与 EntityManager 的当前集合对齐：新实体建节点、已有实体更新 pose、消失实体销毁节点。
   *
   * **只读枚举** —— `entities` 是 `manager.entities()` 的只读迭代器，layer 不得写回。
   * 用「当前集合 vs 活动节点」的差集驱动增删，使节点数恒等于实体数（生命周期对称，
   * entities.spec.mjs 钉这条：spawn→1 / despawn→0 / dispose→0）。
   * @param {Iterable<Readonly<object>>} entities
   */
  sync(entities) {
    const seen = new Set();
    for (const entity of entities) {
      seen.add(entity.id);
      const def = this._types.get(entity.type);
      if (!def) continue; // 未注册渲染的类型：实体存在但不渲染（不报错 —— M6 类型未接线时合法）
      let entry = this._nodes.get(entity.id);
      if (!entry) {
        const node = def.createNode();
        node.name = `entity:${entity.id}`; // 受控标识：测试与调试据此定位节点
        this.scene.add(node);
        entry = { type: entity.type, node };
        this._nodes.set(entity.id, entry);
      }
      def.applyPose(entry.node, entity);
    }
    // 差集回收：活动节点里不在当前集合的 → 销毁（despawn / column 卸载的对称回收）
    for (const [id, entry] of [...this._nodes]) {
      if (seen.has(id)) continue;
      this._disposeNode(entry);
      this._nodes.delete(id);
    }
  }

  /** @param {string} type @returns {number} 当前活动节点数（按类型） */
  activeCount(type) {
    let n = 0;
    for (const entry of this._nodes.values()) if (entry.type === type) n++;
    return n;
  }

  /** 单个节点的对称销毁：从 scene 移除 + 调 disposeNode 释放该节点的几何/材质 */
  _disposeNode(entry) {
    this.scene.remove(entry.node);
    const def = this._types.get(entry.type);
    if (def) def.disposeNode(entry.node);
  }

  /** 反向释放（Game.dispose 调用）：销毁全部活动节点，scene 不留任何实体节点 */
  dispose() {
    for (const [, entry] of [...this._nodes]) this._disposeNode(entry);
    this._nodes.clear();
  }
}

/**
 * probe 类型的渲染定义（M5 render contract fixture）。
 * 节点是单个 THREE.Group，pose = 实体的 position（无朝向/缩放语义 —— probe 无玩法）。
 * @returns {{createNode: Function, applyPose: Function, disposeNode: Function}}
 */
export function createProbeRenderDef() {
  return {
    createNode: () => new THREE.Group(),
    applyPose: (node, entity) => {
      const [x, y, z] = entity.state.position;
      node.position.set(x, y, z);
    },
    disposeNode: (node) => {
      // Group 本身无几何/材质；释放其子节点（probe fixture 无子节点，但口径要对齐未来类型）
      for (const child of [...node.children]) {
        child.geometry?.dispose?.();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
          else child.material.dispose?.();
        }
        node.remove(child);
      }
    },
  };
}
