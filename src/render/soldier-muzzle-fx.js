// src/render/soldier-muzzle-fx.js — 士兵枪口火光池（受控发布层）
//
// 材质**复用** `muzzle-flash-material.js`（与 KV-9 同一份，Task 7 提取）——
// 两侧各写一份会漂移出「士兵的火光是方块而玩家的不是」（v3.30b 修过的缺陷）。
//
// ## 池账（推导，不是拍的）
//
// 并发点射 ≤ `SOLDIER_SHOT.maxConcurrentBursts`(2) 名 × 火光寿命 0.045s
// ÷ 发间隔 0.105s ⇒ 理论并发 ≤ 2。取 **4** = 2 倍余量（照本仓其余池的留余量手法）。
//
// ⚠️ **短命特效**：0.045s 的火光，断言必须**开火后同步立刻取样** ——
// 任何 `await`（含 dynamic import）都会让它自然过期（本仓已记的教训）。
// ⚠️ 空载 `visible=false`（否则恒增 draw call 且进透明排序列表，干扰水面顺序不变式）。
// ⚠️ 每帧零分配：临时对象都是模块级常量。
import * as THREE from 'three';
import { createMuzzleFlashMaterial } from './muzzle-flash-material.js';
import { CARBINE_FLASH_QUADS } from './carbine-geometry.js';

/** 火光寿命（秒）—— 上游 `lights.flash(..., 0.07, 1)` 的观感量级，取 KV-9 同档 */
const FLASH_LIFE = 0.045;
/** 池容量（推导见文件头） */
const CAPACITY = 4;

const _m = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class SoldierMuzzleFx {
  /**
   * @param {{scene:THREE.Scene, capacity?:number}} deps
   */
  constructor({ scene, capacity = CAPACITY }) {
    this.scene = scene;
    this.capacity = capacity;
    /** 每个 slot 一组独立 uniform（共享会让多只士兵的火光同步亮灭） */
    this._slots = [];
    this.meshes = [];
    for (let i = 0; i < capacity; i++) {
      const { material, uniforms } = createMuzzleFlashMaterial();
      const group = new THREE.Group();
      // 星芒 + 两片沿枪管的十字 blade（照 KV-9 的三片结构）
      const star = new THREE.Mesh(
        new THREE.PlaneGeometry(CARBINE_FLASH_QUADS.star[0], CARBINE_FLASH_QUADS.star[1]), material);
      const b1 = new THREE.Mesh(
        new THREE.PlaneGeometry(CARBINE_FLASH_QUADS.blade[0], CARBINE_FLASH_QUADS.blade[1]), material);
      const b2 = new THREE.Mesh(
        new THREE.PlaneGeometry(CARBINE_FLASH_QUADS.blade[0], CARBINE_FLASH_QUADS.blade[1]), material);
      b1.position.z = CARBINE_FLASH_QUADS.bladeOffsetZ;
      b2.position.z = CARBINE_FLASH_QUADS.bladeOffsetZ;
      b2.rotation.z = Math.PI / 2;
      for (const mesh of [star, b1, b2]) {
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        group.add(mesh);
      }
      group.visible = false;
      this.scene.add(group);
      this._slots.push({
        group, material, uniforms,
        geometries: [star.geometry, b1.geometry, b2.geometry],
        bornAt: -1e9, active: false,
      });
      this.meshes.push(group);
    }
    this._cursor = 0;
    this._nowMs = 0;
  }

  /**
   * 开一发火光。
   * @param {number[]} position 枪口世界坐标
   * @param {number} nowMs `performance.now()` 基准
   * @param {THREE.Quaternion} [cameraQuat] 传入则 billboard 朝相机
   */
  fire(position, nowMs, cameraQuat = null) {
    if (!Array.isArray(position) || !position.every((n) => Number.isFinite(n))) return;
    const slot = this._slots[this._cursor];
    this._cursor = (this._cursor + 1) % this.capacity;
    slot.bornAt = Number.isFinite(nowMs) ? nowMs : this._nowMs;
    slot.active = true;
    slot.group.position.set(position[0], position[1], position[2]);
    if (cameraQuat) slot.group.quaternion.copy(cameraQuat);
    slot.uniforms.uSeed.value = Math.random();
    slot.uniforms.uPower.value = 1;
    slot.group.visible = true;
  }

  /**
   * 每帧推进（到期隐藏）。
   * @param {number} nowMs
   */
  update(nowMs) {
    this._nowMs = Number.isFinite(nowMs) ? nowMs : this._nowMs;
    for (const slot of this._slots) {
      if (!slot.active) continue;
      const age = (this._nowMs - slot.bornAt) / 1000;
      if (age >= FLASH_LIFE) {
        slot.active = false;
        slot.uniforms.uPower.value = 0;
        slot.group.visible = false;
        continue;
      }
      // 线性淡出（火光是瞬态闪光，不做复杂包络）
      slot.uniforms.uPower.value = Math.max(0, 1 - age / FLASH_LIFE);
    }
  }

  /** @returns {number} 当前活跃数（测试/HUD） */
  activeCount() { return this._slots.reduce((n, s) => n + (s.active ? 1 : 0), 0); }

  dispose() {
    for (const slot of this._slots) {
      this.scene.remove(slot.group);
      for (const g of slot.geometries) g.dispose();
      slot.material.dispose();
    }
    this._slots.length = 0;
    this.meshes.length = 0;
  }
}

export { FLASH_LIFE as SOLDIER_FLASH_LIFE };