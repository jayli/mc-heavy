// src/render/storm-lance-geometry.js — Storm Lance 的参数化几何（v3.20）
//
// 照上游 `~/jaylli/LinearAbiltyCastingThreeJS/src/assets/ProceduralGeometry.js`
// 的 `createBoltRibbonGeometry`，外加火花 quad / 爆壳 icosphere / 冲击环 quad。
//
// ## 核心手法：顶点里**没有任何米数**
//
// ribbon 的每个顶点是 `(t, side, 0)`：`t` 沿束 0→1，`side` 为 ±1（带宽方向）。
// 真正的世界坐标由顶点着色器每帧算 —— 故一份几何服务任意长度、任意粗细、任意 kink 形状，
// 改 jitter/spread 不需要重建几何（上游「拖动滑块能重塑已在空中的闪电」就是这个分工）。
//
// ## ⚠️ Storm Lance 只有**一种**柱身几何
//
// Nova Beam 需要 tube/coil/ring/orb 四种；Storm Lance 的 GLOW 与 CORE 两个 pass
// **共用同一份 ribbon**（上游 `ThunderAbility.createShaders` 逐字如此），
// 只有 `widthScale` 与 `passOpacity` 不同。这是它「最简单」的实质。
//
// ⚠️ **`boundingSphere` 取 1e4**：几何自身包围盒在参数空间（单位立方内），
// 而实际几何被 shader 摆到几十格外 ⇒ 正常包围球会让它被误剔除。
// 渲染器另设 `frustumCulled = false` 双保险（同 tracer / spike-fx 池口径）。
//
// **主线程专用**：构造 BufferGeometry 必然依赖 three。归属 `render/`。
import * as THREE from 'three';

/**
 * 闪电束的条带（参数空间）。一个 instance = 一条丝，`aStrand` 是它的序号。
 * 顶点 `(t, side, 0)`；shader 把它 kink 成闪电并朝相机展开。
 *
 * GLOW 与 CORE 两个 pass 共用这一份（见文件头）。
 *
 * @param {number} nodes 沿束采样数（kink 细节上限）
 * @param {number} strands instance 容量
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createBoltRibbonGeometry(nodes = 72, strands = 24) {
  const steps = Math.max(2, Math.round(nodes));
  const count = Math.max(1, Math.round(strands));

  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
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

  const strandIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) strandIndex[i] = i;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aStrand', new THREE.InstancedBufferAttribute(strandIndex, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 火花的 billboard quad + 六个逐实例出生属性。
 *
 * **CPU 只写出生数据**（origin/vel/spawn/life/size/seed），运动/尺寸曲线/颜色渐变/淡出
 * 全在 GPU（同上游 `ParticleSystem` 的分工）。
 *
 * ⚠️ `aSpawn` 与 shader 的 `uTime` **必须是同一个时钟**（绝对秒）。混用两个时基的形态是
 * 「蓄力期写入的吸入粒子在释放瞬间全部消失」，而相位/可见性/draw call 判据全绿。
 * f32 精度：绝对秒跑一小时 = 3600，有效位约 7 位 ⇒ 分辨率约 0.0002s，远小于寿命 0.5s。
 * （用**毫秒**才会丢精度。）
 *
 * ⚠️ **`aVel` 是 STREAK 拉伸的输入**（R3）：shader 用它算屏幕空间方向与拉伸倍数。
 * 只写位置不写速度的写法会让全部火花退化成圆点。
 *
 * @param {number} capacity 环形缓冲容量
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createSparkGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  // quad 四角（视图空间偏移，shader 里乘尺寸后加到中心点的视图坐标上）
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

  // 初始全部「已死」：aSpawn 远在过去、aLife 极小 ⇒ age/life > 1 ⇒ shader 里缩零
  const spawn = geometry.getAttribute('aSpawn');
  const life = geometry.getAttribute('aLife');
  for (let i = 0; i < cap; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/**
 * 爆壳（单位 icosphere）。渲染器摆位置与缩放，shader 做噪声位移 + 电弧 + fresnel。
 *
 * 上游 `BurstSphere` 用 `IcosahedronGeometry(1, 4)`；本仓取 detail 3
 * （顶点数 642 vs 2562）—— 位移与电弧都在 shader 里按法线求值，
 * 细分只影响位移的轮廓平滑度，detail 3 在 3 格半径下已足够。
 *
 * @returns {THREE.IcosahedronGeometry}
 */
export function createBurstGeometry() {
  return new THREE.IcosahedronGeometry(1, 3);
}

/**
 * 冲击环（单位 XZ 平面 quad）。渲染器摆位置/朝向与缩放，shader 画径向亮带。
 *
 * ⚠️ **不在这里 rotateX**：命中实体时环要**朝向玩家**而不是贴地（R2），
 * 朝向由渲染器每帧写 matrix 决定。几何保持 XY 平面，shader 用 `length(position.xy)`。
 *
 * @returns {THREE.PlaneGeometry}
 */
export function createShockGeometry() {
  return new THREE.PlaneGeometry(2, 2);
}