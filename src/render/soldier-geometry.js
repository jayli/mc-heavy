// src/render/soldier-geometry.js — 士兵的程序化几何（主线程，依赖 three）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/game/enemies.js` 的
// `soldierGeometries()`（+ `game/weapon.js` 的 `capsule()`、`world/build.js` 的 `Batch`）。
// **每一个盒/胶囊/球的位置、尺寸、颜色、粗糙度、金属度、自发光都逐字取自上游**。
//
// ## 与上游的两处必要改写（不是重新设计）
//
// ① **Batch → 直接合并 BufferGeometry**：上游 Batch 把顶点摊成
//    position/normal/uv/aColor/aMat 五属性配它自己的 ShaderMaterial。本仓走
//    `turret-metal.js` 的金属 TSL（读太阳方向 uniform），故把「逐部件颜色 + 粗糙度 +
//    金属度 + 自发光」映射成**逐顶点 color / aSurf / aGlow**（照 `carbine-geometry.js`
//    的 Parts 手法）。形体与配色不变，只是换了承载方式。
// ② **5 份 unique 几何 → 7 个渲染部件**：左右腿共用同一份 thigh/shin 几何
//    （上游也是共用 `GEO.thigh` / `GEO.shin`，只是挂在两个父节点上）。
//
// ⚠️ **零贴图**：全部纯色盒/胶囊/球（上游也是），不需要任何烘焙产物、不进 atlas。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** 上游的四种材质风格（`enemies.js:14` 的 ARMOR / PLATE / CLOTH / BLACK） */
export const SOLDIER_COLORS = Object.freeze({
  ARMOR: 0x353c45,
  PLATE: 0x4a545f,
  CLOTH: 0x262b32,
  BLACK: 0x15171a,
});

const ARMOR = { c: SOLDIER_COLORS.ARMOR, r: 0.55, m: 0.1 };
const PLATE = { c: SOLDIER_COLORS.PLATE, r: 0.4, m: 0.35 };
const CLOTH = { c: SOLDIER_COLORS.CLOTH, r: 0.85 };
const BLACK = { c: SOLDIER_COLORS.BLACK, r: 0.45, m: 0.3 };

/** 7 个渲染部件（顺序载荷性：与渲染器的矩阵链一致） */
export const SOLDIER_PARTS = Object.freeze([
  'pelvis', 'torso', 'head', 'thighL', 'thighR', 'shinL', 'shinR',
]);

/** 部件 → unique 几何键（左右腿共用） */
export const SOLDIER_GEOMETRY_OF = Object.freeze({
  pelvis: 'pelvis', torso: 'torso', head: 'head',
  thighL: 'thigh', thighR: 'thigh', shinL: 'shin', shinR: 'shin',
});

/**
 * 各部件相对**父级**的局部偏移（上游构造器的 `mk(...)` 位置）。
 * pelvis/torso/thigh 挂 body；head 挂 torso；shin 挂各自的 thigh。
 */
export const SOLDIER_PIVOTS = Object.freeze({
  pelvis: Object.freeze([0, 0.94, 0]),
  torso: Object.freeze([0, 1.0, 0]),
  head: Object.freeze([0, 0.6, 0]),
  thighL: Object.freeze([-0.1, 0.9, 0]),
  thighR: Object.freeze([0.1, 0.9, 0]),
  shinL: Object.freeze([0, -0.44, 0]),
  shinR: Object.freeze([0, -0.44, 0]),
});

/** sRGB hex → 线性 RGB（顶点色缓冲是线性工作色空间，同 carbine-geometry 口径） */
function linearRGB(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * 部件收集器（照 `carbine-geometry.js` 的 `Parts`）。
 * 逐顶点属性：position / normal（three 标准）+ color（线性 RGB）
 * + aSurf(vec2 roughness,metalness) + aGlow(float，上游 e/8)。
 * ⚠️ 不用 uv：全部纯色 ⇒ 省一个属性（WebGPU maxVertexBuffers=8）。
 */
class Parts {
  constructor() { this.list = []; }

  add(geometry, matrix, style) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const [r, gg, b] = linearRGB(style.c ?? 0x808080);
    const col = new Float32Array(n * 3);
    const surf = new Float32Array(n * 2);
    const glow = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
      surf[i * 2] = style.r ?? 0.7;
      surf[i * 2 + 1] = style.m ?? 0;
      glow[i] = Math.min(1, (style.e ?? 0) / 8);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 2));
    g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
    this.list.push(g);
    if (g !== geometry) geometry.dispose();
    return this;
  }

  /** 轴对齐盒（上游 `b.box(x,y,z,sx,sy,sz,style)`） */
  box(x, y, z, sx, sy, sz, style) {
    return this.add(new THREE.BoxGeometry(sx, sy, sz), new THREE.Matrix4().makeTranslation(x, y, z), style);
  }

  /** 两点之间的胶囊（上游 `capsule()`，用于四肢与袖子） */
  capsule(ax, ay, az, bx, by, bz, radius, style) {
    const a = new THREE.Vector3(ax, ay, az);
    const c = new THREE.Vector3(bx, by, bz);
    const d = c.clone().sub(a);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.CapsuleGeometry(radius, len, 3, 8), m, style);
  }

  build() {
    const merged = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

/** 平移+旋转矩阵（上游 `props.js` 的 `mat(x,y,z,rx,ry,rz,sx,sy,sz)` 的本模块用法） */
function mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

/**
 * 5 份 unique 几何（上游 `soldierGeometries()` **逐行**）。
 *
 * ⚠️ 保持上游顺序便于逐行对照 —— 将来上游改了某个尺寸，diff 能一眼对上。
 * ⚠️ **枪与双臂都在 torso 里**（上游同）：枪随躯干俯仰整体动，不做枪独立轴
 * （与炮塔「刚性一体」同一裁定）。
 *
 * @returns {{pelvis:THREE.BufferGeometry, torso:THREE.BufferGeometry,
 *            head:THREE.BufferGeometry, thigh:THREE.BufferGeometry, shin:THREE.BufferGeometry}}
 */
export function buildSoldierGeometries() {
  // ---- pelvis（上游 4 盒）----
  const pelvis = new Parts();
  pelvis.box(0, 0, 0, 0.34, 0.2, 0.22, CLOTH);
  pelvis.box(0, 0.06, 0, 0.38, 0.07, 0.25, BLACK);
  pelvis.box(0.19, -0.02, 0.02, 0.07, 0.16, 0.12, PLATE);
  pelvis.box(-0.19, -0.04, 0, 0.06, 0.12, 0.14, ARMOR);

  // ---- torso（上游 15 盒 + 1 add + 4 胶囊；原点在腰，+Z 朝前）----
  const torso = new Parts();
  torso.box(0, 0.11, 0, 0.32, 0.24, 0.2, CLOTH);
  torso.box(0, 0.37, 0, 0.43, 0.36, 0.26, ARMOR);
  torso.box(0, 0.37, 0.14, 0.3, 0.27, 0.05, PLATE);
  torso.box(0, 0.2, 0.135, 0.3, 0.1, 0.06, { c: 0x22272d, r: 0.7 });
  torso.box(0, 0.36, -0.18, 0.27, 0.32, 0.12, { c: 0x20252b, r: 0.75 });
  torso.box(0.24, 0.52, 0, 0.14, 0.1, 0.2, PLATE);
  torso.box(-0.24, 0.52, 0, 0.14, 0.1, 0.2, PLATE);
  torso.box(0, 0.57, 0, 0.14, 0.08, 0.14, CLOTH);
  // 胸灯（自发光 e=2.5）
  torso.box(-0.13, 0.47, 0.145, 0.05, 0.03, 0.02, { c: 0xff3020, e: 2.5, r: 0.4 });
  // 双臂（4 胶囊）
  torso.capsule(0.22, 0.48, 0, 0.25, 0.28, 0.2, 0.062, CLOTH);
  torso.capsule(0.25, 0.28, 0.2, 0.1, 0.35, 0.42, 0.052, CLOTH);
  torso.capsule(-0.22, 0.48, 0, -0.21, 0.27, 0.3, 0.062, CLOTH);
  torso.capsule(-0.21, 0.27, 0.3, -0.02, 0.33, 0.6, 0.052, CLOTH);
  // 手套
  torso.box(0.1, 0.34, 0.44, 0.07, 0.08, 0.09, BLACK);
  torso.box(-0.02, 0.32, 0.62, 0.07, 0.07, 0.1, BLACK);
  // 步枪（5 件）
  torso.box(0.07, 0.385, 0.5, 0.05, 0.085, 0.46, { c: 0x16181b, r: 0.4, m: 0.8 });
  torso.box(0.07, 0.39, 0.82, 0.03, 0.03, 0.3, { c: 0x2c3034, r: 0.35, m: 0.9 });
  torso.box(0.07, 0.38, 0.2, 0.045, 0.07, 0.16, { c: 0x1c1f22, r: 0.6 });
  torso.add(new THREE.BoxGeometry(0.035, 0.16, 0.06), mat(0.07, 0.28, 0.47, 0.2, 0, 0), { c: 0x22262a, r: 0.5, m: 0.6 });
  torso.box(0.07, 0.445, 0.5, 0.03, 0.035, 0.1, BLACK);

  // ---- head（上游 4 盒 + 1 球；原点在颈）----
  const head = new Parts();
  head.box(0, 0.11, 0, 0.19, 0.22, 0.21, { c: 0x101214, r: 0.85 });
  head.add(new THREE.SphereGeometry(1, 10, 7), mat(0, 0.18, -0.005, 0, 0, 0, 0.135, 0.115, 0.15), { c: 0x232930, r: 0.5, m: 0.3 });
  // 护目镜（自发光 e=4.5 —— 士兵的身份视觉）
  head.box(0, 0.115, 0.108, 0.17, 0.036, 0.02, { c: 0xff2a1c, e: 4.5, r: 0.3 });
  head.box(0.105, 0.1, 0, 0.03, 0.09, 0.08, BLACK);
  head.box(-0.105, 0.1, 0, 0.03, 0.09, 0.08, BLACK);

  // ---- thigh（上游 1 胶囊 + 1 盒）----
  const thigh = new Parts();
  thigh.capsule(0, 0, 0, 0, -0.4, 0, 0.088, CLOTH);
  thigh.box(0, -0.4, 0.06, 0.13, 0.12, 0.07, PLATE);

  // ---- shin（上游 1 胶囊 + 2 盒）----
  const shin = new Parts();
  shin.capsule(0, 0, 0, 0, -0.36, 0, 0.07, CLOTH);
  shin.box(0, -0.43, 0.05, 0.12, 0.11, 0.27, BLACK);
  shin.box(0, -0.18, 0.06, 0.1, 0.22, 0.04, ARMOR);

  return {
    pelvis: pelvis.build(),
    torso: torso.build(),
    head: head.build(),
    thigh: thigh.build(),
    shin: shin.build(),
  };
}