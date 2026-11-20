// src/render/cinder-fall-geometry.js — Cinder Fall 的火焰尾巴与粒子几何（v3.21b）
//
// 用户 2026-11-19：「他的实现是一个黑色的燃烧的火球，**有拖拽的一个火焰尾巴**，
// 爆炸的时候**蹦出的火星粒子很多**，是爆炸的样子，而不是现在一样像烟花」。
//
// ## 核心手法照抄本仓已验证的 Storm Lance（**顶点里没有任何米数**）
//
// ribbon 顶点只是 `(t, side, 0)`：`t` 沿尾巴 0→1（0 = 尾端，1 = **鼻锥尖端**），
// `side` 为 ±1。真正的世界坐标由顶点着色器每帧从 `uTail → uHead` 重建
// ⇒ 改弧高 / 长度 / 粗细都不需要重建几何（上游「拖滑块能重塑已在空中的火」同一分工）。
//
// ⚠️⚠️ **采样必须在头部加密**（用户报「前面是平的」的第二个成因）：
// 鼻锥只占整条尾巴约 1.15/8.15 ≈ 14% 的参数区间，均匀采样时那一段只有 5~6 个环，
// 椭圆收拢会被画成**多边形折线**（读作斜切平头）。
//
// ⚠️⚠️ **幂指数必须 <1**（首版写 1.6 弄反了，实测只有 4 个环）：
// `t = u^b` 在 u<1 时，**b 越大 t 越小** ⇒ 采样反而远离头部。
// b=1.6 实测鼻锥内 4 环（比均匀的 5.5 还少）；b=0.5 实测 **11 环**。
// 顶点总数不变 ⇒ 零额外成本。
//
// 粒子 quad 沿用 `storm-lance-geometry.js:createSparkGeometry` 的六个出生属性：
// CPU 只写 origin/vel/spawn/life/size/seed，运动与颜色全在 GPU。
//
// ⚠️ **`aSpawn` 与 shader 的 `uTime` 必须同一个时钟（绝对秒）** —— 混用两个时基的形态是
// 「粒子在某个瞬间全部消失」而相位/可见性/draw call 判据全绿（v3.20 实测）。
//
// ⚠️ **`boundingSphere` 取 1e4**：几何自身在参数空间（单位立方内），实际被 shader 摆到
// 几十格外 ⇒ 正常包围球会让它被误剔除。渲染器另设 `frustumCulled=false` 双保险。
//
// **主线程专用**：构造 BufferGeometry 必然依赖 three。归属 `render/`。
import * as THREE from 'three';

/**
 * 火焰尾巴的条带（参数空间）。顶点 `(t, side, 0)`，shader 把它摆到 tail→head 之间
 * 并朝相机展开。
 *
 * @param {number} nodes 沿尾巴采样数（火舌细节上限）
 * @returns {THREE.BufferGeometry}
 */
export function createFlameRibbonGeometry(nodes = 40, headBias = 0.5) {
  const steps = Math.max(2, Math.round(nodes));
  // ⚠️ 上限 1（=均匀）：>1 会把采样推离头部，与意图相反（见文件头）
  const bias = Math.min(1, Math.max(0.05, headBias));
  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    // 幂重分布（bias<1）：u 均匀 ⇒ t 在头部（t→1）密集。两端仍精确落在 0 与 1。
    const t = Math.pow(i / (steps - 1), bias);
    const o = i * 6;
    positions[o + 0] = t; positions[o + 1] = -1;
    positions[o + 3] = t; positions[o + 4] = 1;
  }
  const indices = new Uint16Array((steps - 1) * 6);
  for (let i = 0; i < steps - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o + 0] = a; indices[o + 1] = a + 1; indices[o + 2] = a + 2;
    indices[o + 3] = a + 1; indices[o + 4] = a + 3; indices[o + 5] = a + 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 粒子的 billboard quad + 六个逐实例出生属性（火星 / 余烬 / 烟共用同一份结构）。
 *
 * ⚠️ **`aVel` 是 STREAK 拉伸的输入**：shader 用它算屏幕空间方向与拉伸倍数。
 * 只写位置不写速度会让全部火星退化成圆点（用户读作「冒爆米花」）。
 *
 * @param {number} capacity 环形缓冲容量
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createCinderParticleGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const mk = (name, itemSize) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * itemSize), itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  };
  mk('aOrigin', 3);
  mk('aVel', 3);
  mk('aSpawn', 1);
  mk('aLife', 1);
  mk('aSize', 1);
  mk('aSeed', 1);

  // 初始全部「已死」：aSpawn 远在过去、aLife 极小 ⇒ age/life > 1 ⇒ shader 缩零
  const spawn = geometry.getAttribute('aSpawn');
  const life = geometry.getAttribute('aLife');
  for (let i = 0; i < cap; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}