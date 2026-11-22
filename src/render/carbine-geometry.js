// src/render/carbine-geometry.js — KV-9 卡宾枪的**程序化视图模型几何**（主线程，依赖 three）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/game/weapon.js` 的
// `buildGun()` / `buildMag()` / `buildArms()` + `src/world/build.js` 的 `Batch`。
// **每一个盒/柱的位置、尺寸、颜色、粗糙度、金属度都逐字取自上游** —— 用户要求
// 「这把枪发射时的动效也和那个游戏保持一样」，枪本身的形体是那个动效的载体。
//
// ## 与上游的两处必要改写（不是重新设计）
//
// ① **Batch → 直接合并 BufferGeometry**：上游 `Batch` 把顶点摊成
//    position/normal/uv/aColor/aMat 五个属性，配它自己的 ShaderMaterial。
//    本仓视图模型走 `MeshStandardNodeMaterial`（吃场景双灯，与既有三把 GLB 枪同口径），
//    故把「逐部件颜色 + 粗糙度 + 金属度」映射成 **顶点色 + 逐顶点 roughness/metalness 属性**，
//    再由 TSL 读它们（见 `carbine-view.js`）。形体与配色不变，只是换了承载方式。
// ② **不做 holo 瞄准镜的 reticle shader**：上游用独立的 `RETICLE_FRAG` + 自定义投影矩阵
//    （`uVMProj`，把视图模型压到近裁剪面附近防穿墙）。本仓相机 near=0.1、枪在 −0.31，
//    不穿墙；reticle 改用一个**自发光小 quad**（同样的环+点+刻度形状由 TSL 画），
//    观感一致而少一套投影矩阵。
//
// ⚠️ **三个部件必须分开建**（gun / mag / armL / armR）：换弹动画要单独移动弹匣与左臂
// （上游 `this.mag.position` / `this.armL.position` 逐帧写）。合并成一个 mesh 就没法动。
//
// ⚠️ **零贴图**：全部是纯色盒/柱（上游也是），故不需要任何烘焙产物、不进 atlas。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * 上游的五种材质风格（`weapon.js` 顶部的 GUNMETAL / POLY / STEEL / GLOVE / SLEEVE）
 * 与各处内联的 `{c,r,m,e}`。`e` = emissive 强度（上游 `/8` 归一后进 aMat.z）。
 */
const GUNMETAL = { c: 0x555b62, r: 0.44, m: 1.0 };
const POLY = { c: 0x1f2327, r: 0.5, m: 0.0 };
const STEEL = { c: 0x8a9098, r: 0.42, m: 1.0 };
const GLOVE = { c: 0x1b1e22, r: 0.6 };
const SLEEVE = { c: 0x2d3742, r: 0.82 };

/** sRGB hex → 线性 RGB（顶点色缓冲是线性工作色空间，同 view-arm.js 的口径） */
function linearRGB(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/**
 * 部件收集器：把若干变换后的几何 + 风格攒成一个合并几何。
 *
 * 逐顶点属性：
 *   position / normal（three 标准）
 *   color      线性 RGB（上游 aColor 的等价物）
 *   aSurf      vec2 = (roughness, metalness)
 *   aGlow      float = emissive 强度（上游 e，已 /8 归一）
 *
 * ⚠️ **不用 uv**：全部纯色，没有贴图采样 ⇒ 省一个属性（WebGPU maxVertexBuffers=8）。
 */
class Parts {
  constructor() { this.list = []; }

  /** 加一个几何（matrix 可选）+ 风格 */
  add(geometry, matrix, style) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    // 纯色件不需要 uv；mergeGeometries 要求属性集合一致 ⇒ 统一删掉
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

  /** 轴对齐盒（上游 `g.box(x,y,z,sx,sy,sz,style)`） */
  box(x, y, z, sx, sy, sz, style) {
    return this.add(new THREE.BoxGeometry(sx, sy, sz), new THREE.Matrix4().makeTranslation(x, y, z), style);
  }

  /** 绕 X 旋转的盒（上游 `B(..., rx)` 那一支） */
  boxRotX(x, y, z, sx, sy, sz, style, rx) {
    const m = new THREE.Matrix4().makeTranslation(x, y, z)
      .multiply(new THREE.Matrix4().makeRotationX(rx));
    return this.add(new THREE.BoxGeometry(sx, sy, sz), m, style);
  }

  /** 两点之间的胶囊（上游 `capsule()`，用于袖子） */
  capsule(ax, ay, az, bx, by, bz, radius, style) {
    const a = new THREE.Vector3(ax, ay, az);
    const c = new THREE.Vector3(bx, by, bz);
    const d = c.clone().sub(a);
    const len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    const m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.add(new THREE.CapsuleGeometry(radius, len, 3, 8), m, style);
  }

  /** 合并成一个 BufferGeometry（调用方负责 dispose） */
  build() {
    const merged = mergeGeometries(this.list, false);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

/** 平移+绕X旋转矩阵（上游 `props.js` 的 `mat(x,y,z,rx,ry,rz)` 的本模块用法） */
function mat(x, y, z, rx = 0, ry = 0, rz = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * 枪体（上游 `buildGun()` **逐行**）。
 *
 * ⚠️ 顺序不影响观感（都是不透明盒），但**保持上游顺序**便于逐行对照 ——
 * 将来上游改了某个尺寸，diff 能一眼对上。
 */
export function buildCarbineGun() {
  const g = new Parts();
  const B = (x, y, z, sx, sy, sz, st, rx = 0) => (rx
    ? g.boxRotX(x, y, z, sx, sy, sz, st, rx)
    : g.box(x, y, z, sx, sy, sz, st));
  // receiver + rail
  B(0, 0, -0.05, 0.054, 0.076, 0.34, GUNMETAL);
  B(0, 0.044, -0.09, 0.03, 0.012, 0.32, { c: 0x3c4148, r: 0.5, m: 1.0 });
  for (let i = 0; i < 9; i++) B(0, 0.052, -0.23 + i * 0.034, 0.032, 0.006, 0.016, POLY);
  B(0.029, 0.008, -0.02, 0.006, 0.03, 0.09, { c: 0x0c0d0f, r: 0.5, m: 0.6 });   // 抛壳口
  B(-0.03, 0.012, 0.03, 0.008, 0.016, 0.03, STEEL);                            // 快慢机
  // handguard with vents
  B(0, -0.002, -0.33, 0.05, 0.06, 0.25, POLY);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) B(sx * 0.0255, 0.004, -0.42 + i * 0.055, 0.004, 0.022, 0.034, { c: 0x08090a, r: 0.6 });
  }
  B(0, -0.036, -0.33, 0.03, 0.012, 0.2, STEEL);
  B(0, -0.052, -0.39, 0.03, 0.03, 0.07, { c: 0x16181b, r: 0.5, m: 0.5 });      // 战术灯模块
  B(0, -0.052, -0.427, 0.02, 0.02, 0.006, { c: 0x9fe8ff, e: 1.2, r: 0.3 });    // 灯窗（自发光）
  // barrel + muzzle device
  g.add(new THREE.CylinderGeometry(0.011, 0.011, 0.14, 10), mat(0, 0.006, -0.52, Math.PI / 2), STEEL);
  g.add(new THREE.CylinderGeometry(0.021, 0.021, 0.12, 12), mat(0, 0.006, -0.63, Math.PI / 2), { c: 0x15171a, r: 0.42, m: 0.9 });
  g.add(new THREE.CylinderGeometry(0.0225, 0.0225, 0.012, 12), mat(0, 0.006, -0.6, Math.PI / 2), STEEL);
  B(0, 0.04, -0.44, 0.012, 0.03, 0.014, GUNMETAL);                             // 准星
  // stock
  B(0, -0.004, 0.2, 0.044, 0.062, 0.18, POLY);
  B(0, 0.03, 0.2, 0.04, 0.02, 0.13, { c: 0x2c3136, r: 0.7 });
  B(0, -0.012, 0.3, 0.05, 0.1, 0.03, { c: 0x101113, r: 0.8 });
  // grip + trigger guard
  B(0, -0.085, 0.055, 0.034, 0.1, 0.046, POLY, 0.3);
  B(0, -0.05, -0.005, 0.01, 0.006, 0.07, GUNMETAL);
  B(0, -0.035, -0.04, 0.01, 0.03, 0.006, GUNMETAL);
  B(0, -0.03, 0.0, 0.006, 0.022, 0.008, STEEL, -0.3);
  // mag well
  B(0, -0.05, -0.1, 0.046, 0.03, 0.074, GUNMETAL);
  // holo sight: base + hood
  B(0, 0.064, -0.06, 0.036, 0.02, 0.075, GUNMETAL);
  B(-0.0195, 0.097, -0.06, 0.003, 0.05, 0.045, GUNMETAL);
  B(0.0195, 0.097, -0.06, 0.003, 0.05, 0.045, GUNMETAL);
  B(0, 0.1225, -0.06, 0.042, 0.003, 0.045, GUNMETAL);
  // accent stripe（橙条，上游的身份色）
  B(0.0275, -0.012, -0.12, 0.002, 0.008, 0.12, { c: 0xff8426, r: 0.5 });
  return g.build();
}

/** 弹匣（上游 `buildMag()` 逐行）。⚠️ 独立几何 —— 换弹时要单独移动它。 */
export function buildCarbineMag() {
  const g = new Parts();
  g.add(new THREE.BoxGeometry(0.034, 0.17, 0.058), mat(0, -0.085, 0, 0.14), { c: 0x2a2e33, r: 0.5, m: 0.6 });
  g.add(new THREE.BoxGeometry(0.038, 0.02, 0.064), mat(0, -0.172, -0.012, 0.14), { c: 0x16181b, r: 0.6 });
  g.add(new THREE.BoxGeometry(0.004, 0.09, 0.02), mat(0.0185, -0.08, 0, 0.14), { c: 0xff8426, e: 0.4, r: 0.5 });
  return g.build();
}

/**
 * 两只手臂（上游 `buildArms()` 逐行）。
 * @returns {{left: THREE.BufferGeometry, right: THREE.BufferGeometry}}
 */
export function buildCarbineArms() {
  const L = new Parts();
  const R = new Parts();
  // 左手：托在护木下
  L.box(-0.004, -0.05, -0.3, 0.07, 0.034, 0.1, GLOVE);
  L.box(-0.04, -0.018, -0.3, 0.022, 0.07, 0.095, GLOVE);
  L.box(0.034, -0.03, -0.31, 0.02, 0.04, 0.05, GLOVE);
  for (let i = 0; i < 4; i++) L.box(-0.046, 0.012, -0.335 + i * 0.023, 0.016, 0.022, 0.019, { c: 0x1b1e21, r: 0.6 });
  L.box(-0.015, -0.075, -0.245, 0.08, 0.05, 0.04, { c: 0x3a4450, r: 0.8 });     // 袖口
  L.capsule(-0.02, -0.085, -0.22, -0.2, -0.3, 0.2, 0.043, SLEEVE);
  // 右手：握把
  R.add(new THREE.BoxGeometry(0.052, 0.09, 0.062), mat(0.004, -0.09, 0.06, 0.3), GLOVE);
  R.box(0.03, -0.035, 0.02, 0.016, 0.02, 0.07, GLOVE);
  R.box(0.006, -0.135, 0.085, 0.07, 0.04, 0.06, { c: 0x3a4450, r: 0.8 });
  R.capsule(0.014, -0.15, 0.1, 0.13, -0.33, 0.44, 0.046, SLEEVE);
  return { left: L.build(), right: R.build() };
}

/**
 * 枪口 / 抛壳口 / 弹匣挂点的**rig 局部坐标**（除枪口外均取上游同名 Object3D 的 position）。
 *
 * ⚠️ **唯一权威**：`carbine-view.js` 建三个空 Object3D 用它们，
 * `carbine-fx.js` 取枪口世界坐标作曳光起点与火光位置。各处写字面量会漂移出
 * 「曳光从枪管旁边射出」（数值判据全绿，只有画面能看出）。
 *
 * ⚠️ **`muzzle` 是本仓有意偏离上游的唯一一项**（用户实玩后指定，见其注释）；
 * 其余四项与上游逐字相同。`flash`（火光组）与 `muzzle`（曳光起点）是
 * **两个独立锚点**（上游也如此：-0.72 vs -0.7）—— 改 muzzle **不会**带动火光位置。
 */
export const CARBINE_ANCHORS = Object.freeze({
  /**
   * 枪口。上游原值是 `this.muzzle.position.set(0, 0.006, -0.7)`；
   * **本仓有意偏离到 `(0, 0.009, -0.5)`**（用户 2026-11-22 实玩后指定）。
   *
   * ⚠️ **改这个值就是改曳光与枪口火光的起点**（唯一旋钮）：
   * `carbine-view.js` 拿它建空锚点 → `muzzleWorld()` → `player.js` 传给
   * `carbineFx.spawnFromEffect` 的 `ctx.muzzle` → 写进曳光池的 `aA`。
   *
   * ⚠️ **坐标是 rig 局部空间**（单位 = 格）：x 右、y 上、**z 负值朝枪口方向**。
   * 枪管几何的轴向范围是 **[-0.69, -0.57]**（上方两段圆柱），
   * 故 -0.5 落在枪管**后方**的护木/机匣段 —— 这是用户选定的位置，
   * 不是笔误；若将来要回到“从枪管末端射出”，z 应取 ≤ -0.69。
   *
   * ⚠️ **与 catalog 的 `localStart` / `muzzleOffset` 是两回事**：后者是 controller
   * 纯逻辑层的回落值（无视图模型的 fixture 用），真实开火走本锚点。
   * 改这里后若要保持两者一致，需同步 catalog 的那两个数（换算见其注释）。
   *
   * ⚠️ **改完跑 `tests/carbine-tracer-origin.spec.mjs`**：它钉「起点逐位等于枪口」
   * 与「屏幕投影距枪管末端 ≤2px」—— 后一条在本偏离下会红（几何上必然），
   * 那是判据在描述上游口径而不是缺陷；要接受本偏离就得按新锚点重标那条。
   */
  muzzle: Object.freeze([0, 0.009, -0.5]),
  /** 抛壳口（上游 `this.port.position.set(0.04, 0.012, -0.02)`） */
  port: Object.freeze([0.04, 0.012, -0.02]),
  /** 弹匣就位位置（上游 `this.mag.position.set(0, -0.058, -0.1)`） */
  mag: Object.freeze([0, -0.058, -0.1]),
  /** 火光组位置（上游 `this.flash.position.set(0, 0.006, -0.72)`） */
  flash: Object.freeze([0, 0.006, -0.72]),
  /** holo reticle 位置（上游 `this.reticle.position.set(0, 0.097, -0.062)`） */
  reticle: Object.freeze([0, 0.097, -0.062]),
});

/**
 * 火光的三片 quad 尺寸（上游 `PlaneGeometry(0.24,0.24)` 星芒 +
 * 两片 `PlaneGeometry(0.14,0.34)` 沿枪管的十字 blade）。
 */
export const CARBINE_FLASH_QUADS = Object.freeze({
  star: Object.freeze([0.24, 0.24]),
  blade: Object.freeze([0.14, 0.34]),
  /** blade 相对火光组的 z 偏移（上游 `b1.position.z = -0.12`） */
  bladeOffsetZ: -0.12,
});

/** reticle quad 尺寸（上游 `PlaneGeometry(0.036, 0.044)`） */
export const CARBINE_RETICLE_SIZE = Object.freeze([0.036, 0.044]);
