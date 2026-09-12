// src/render/explosion-renderer.js — M8：爆炸球体扩张特效（规格 §2.4）
// 固定 slot InstancedMesh，池满覆盖最旧。移植 mc-lite `World.js:1301-1311` 的球体扩张层
// （寿命 0.3s / targetScale 5.0 / opacity 1→0）。
//
// ⚠️ **这只是爆炸的两层之一**：mc-lite `World.js:1296 spawnExplosionParticles` 是两层叠加 ——
// ① 序列帧 billboard（`ParticleSystem.js:177`）② 球体扩张（本文件，注释原文「作为底层增强」）。
// M8 当时只移植了 ②，① 由 `explosion-sprite.js` 补齐。两层在 `game.js` 的 `explodeTnt()`
// 里同帧触发（billboard 先、球体后，mc-lite 就是这个顺序）。
//
// ⚠️ **有意偏离 mc-lite 的池实现**：mc-lite 是 15 个独立 `THREE.Mesh`（每个爆炸一个节点，
// `World.js:111-127`），本仓库改成一个固定容量 InstancedMesh —— 同 M6 丧尸六部件与曳光池的
// 手法（短寿命视觉对象用实例池，避免 per-burst scene 节点）。视觉结果等价。
//
// ⚠️ **无活跃实例时 `visible=false`**（两条理由，都是实测教训）：
// ① InstancedMesh 构造期 count 即容量，即使全部 slot 零 scale 仍被提交渲染 → 恒增 1 个
//    draw call（M6 实测：六个部件 mesh 让 bench 场景 ④ draw 530→536）。
// ② 透明 mesh 常驻会进入透明渲染列表，其锚点（世界原点）随镜头转动与体素水/海面的排序锚点
//    交叉，干扰水面绘制顺序不变式（`tracer-renderer.js` 同注释，water-order.spec 守）。
import * as THREE from 'three';

const BURST_LIFE_MS = 300;       // mc-lite `World.js:1307` 运行时覆盖值（池初始化是 0.6s）
const BURST_TARGET_SCALE = 5.0;  // mc-lite `World.js:1308` 运行时覆盖值（池初始化是 8.0）

// 复用的临时对象（避免每帧分配）
const _matrix = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0); // 空闲 slot：零 scale 不可见

export class ExplosionRenderer {
  /** @param {{scene: import('three').Scene, maxActive?: number}} deps */
  constructor({ scene, maxActive = 16 }) {
    this.scene = scene;
    this.maxActive = maxActive;
    // ⚠️ 几何/材质逐项照搬 mc-lite `World.js:113-127`（池初始化值，运行时**未**被覆盖）：
    // 半径 **1**（不是 0.5 —— 写 0.5 会让直径只有一半）、24×24 段、颜色 **0xffff00 黄**
    // （不是橙）、`depthWrite:false` + `side: DoubleSide`（mc-lite 注释：避免深度冲突，
    // 提升重叠球体的视觉效果）。
    const geometry = new THREE.SphereGeometry(1, 24, 24);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffff00, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；特效须无条件提交（同 tracer 池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;   // 无爆炸时不提交渲染（见文件头 ⚠️）
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
    /** @type {Array<{slot:number, startedAt:number, position:[number,number,number]}>} */
    this._bursts = [];
    this._nextSlot = 0;
  }

  /**
   * 起一次爆炸特效。池满时覆盖最旧 slot（纯视觉，丢弃无副作用）。
   * @param {[number,number,number]} position 世界坐标（块中心 = 块坐标 + 0.5）
   * @param {number} nowMs `performance.now()` 基准
   */
  burst(position, nowMs) {
    const slot = this._nextSlot;
    this._nextSlot = (this._nextSlot + 1) % this.maxActive;
    _matrix.makeTranslation(position[0], position[1], position[2]);
    this.mesh.setMatrixAt(slot, _matrix);
    const existing = this._bursts.find((b) => b.slot === slot);
    if (existing) { existing.startedAt = nowMs; existing.position = position; }
    else this._bursts.push({ slot, startedAt: nowMs, position });
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 每帧推进：按寿命比例扩张 + 淡出；全部结束后 `visible=false`（draw call 回到基线）。 */
  update(nowMs) {
    if (this._bursts.length === 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }
    let maxOpacity = 0;
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const b = this._bursts[i];
      const t = (nowMs - b.startedAt) / BURST_LIFE_MS;
      if (t >= 1) { this.mesh.setMatrixAt(b.slot, _zero); this._bursts.splice(i, 1); continue; }
      // 扩张与淡出照搬 mc-lite `World.js:1258-1263`：
      // scale = 0.1 + progress × targetScale（终值 ≈ 5.1）；淡出 = pow(1 − progress, 1.5)
      // （mc-lite 注释「指数函数实现先慢后快的透明度淡出」）—— **不是线性淡出**，
      // 线性会让特效前半段就明显变透明，观感与 mc-lite 不一致。
      const scale = 0.1 + t * BURST_TARGET_SCALE;
      // ⚠️ `makeScale` 会清掉位移 → 必须再 setPosition（照抄 makeTranslation 会丢位置）
      _matrix.makeScale(scale, scale, scale);
      _matrix.setPosition(b.position[0], b.position[1], b.position[2]);
      this.mesh.setMatrixAt(b.slot, _matrix);
      const opacity = Math.pow(1 - t, 1.5);
      if (opacity > maxOpacity) maxOpacity = opacity;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.material.opacity = maxOpacity;
    if (this._bursts.length === 0) this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();  // InstancedMesh.dispose 不释放材质
  }
}
