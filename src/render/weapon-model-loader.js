// src/render/weapon-model-loader.js — 受控 GLB 武器模型加载（M4 规格 §4.3）
// 只在主线程运行（依赖 three）：缓存只读模板，装备时 clone，避免切枪重复解析与 GPU 资源抖动。
// 归一化与 mc-lite 一致：Box3.setFromObject → 平移负中心 → rotation.y=Math.PI → 外层 group 按最大维度缩放到 1。
// 加载失败报出可识别的武器 id 与资源 URL，让玩家保持徒手可玩。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** 仓库受控的三件 glTF 2.0 .glb；禁止用户文件、外链、Draco/KTX2。 */
export const WEAPON_ASSET_URLS = Object.freeze({
  pistol: '/assets/models/weapons/pistol.glb',
  mag7: '/assets/models/weapons/mag7.glb',
  minigun: '/assets/models/weapons/minigun.glb',
});

export class WeaponModelLoader {
  /**
   * @param {{urls?: Record<string,string>, loader?: GLTFLoader}} [opts]
   *        测试可注入替换 url 或 loader。
   */
  constructor({ urls = WEAPON_ASSET_URLS, loader = new GLTFLoader() } = {}) {
    this.urls = urls;
    this.loader = loader;
    /** @type {Map<string, THREE.Group>} id → 归一化后的只读模板（共享 geometry/material） */
    this._templates = new Map();
    /** @type {Map<string, Promise<THREE.Group>>} id → 模板加载 promise（避免重复解析） */
    this._promises = new Map();
  }

  /**
   * 加载并返回可独立挂载的模板 clone（共享底层 geometry/material）。
   * @param {string} id 武器 id（pistol/mag7/minigun）
   * @returns {Promise<THREE.Group>}
   */
  load(id) {
    if (this._promises.has(id)) return this._promises.get(id).then((t) => t.clone());
    const url = this.urls[id];
    if (!url) return Promise.reject(new Error(`weapon asset ${id} failed: no url`));
    const promise = this.loader.loadAsync(url)
      .then((gltf) => {
        const template = this._normalize(gltf.scene);
        this._templates.set(id, template);
        return template;
      })
      .catch((err) => {
        this._promises.delete(id); // 失败不缓存，允许重试
        throw new Error(`weapon asset ${id} failed: ${url}: ${err?.message ?? err}`);
      });
    this._promises.set(id, promise);
    return promise.then((t) => t.clone());
  }

  /** mc-lite 归一化：居中 + 转向 + 按最大维度缩放到单位尺寸。 */
  _normalize(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -center.y, -center.z);
    model.rotation.y = Math.PI;
    const group = new THREE.Group();
    group.add(model);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 1.0 / (maxDim || 1);
    group.scale.set(scale, scale, scale);
    return group;
  }

  /** 释放全部模板的 geometry/material/texture；克隆体随之失效（游戏退出时调用）。 */
  dispose() {
    for (const template of this._templates.values()) {
      template.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry?.dispose();
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mats) {
          if (!m) continue;
          for (const key of Object.keys(m)) {
            const val = m[key];
            if (val && val.isTexture) val.dispose();
          }
          m.dispose();
        }
      });
    }
    this._templates.clear();
    this._promises.clear();
  }
}
