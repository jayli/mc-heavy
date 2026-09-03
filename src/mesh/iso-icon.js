// src/mesh/iso-icon.js — 等轴测投影图标（§4.5.4 v1.24）
//
// 把 mesher.js 的 `TEMPLATES` 几何模板投影成背包图标。**形状的唯一权威是 TEMPLATES**
// （红线 1：数据只有一份权威）——本文件不含任何几何定义，只消费传入的 quad 数组。
//
// 同构纯函数（红线 8）：无 DOM、无 three、无 node 依赖 —— 烘焙脚本（tools/）与浏览器
// 单测（src/tests/）共用同一份代码。像素写入返回 Uint8ClampedArray RGBA，落盘 PNG 由
// 调用方负责（tools/bake-isometric-icons.mjs 用 pngjs）。
//
// 为什么离线烘焙而非运行时合成：运行时零开销（复用既有 CSS background 裁剪路径）、
// 与其余 109 项图标同一条渲染路径、确定性（固定算法无随机）、符合红线 3（重计算离开运行时）。
// 代价是几何变更需重跑 `npm run icons && npm run atlas`。

// 2:1 等轴测投影（图标惯例，Minecraft 同款观感）：
//   sx = x - z          （+X 向右下、+Z 向左下）
//   sy = (x+z)/2 - y    （抬升 y → 屏幕上移）
// 不是世界渲染的相机投影——图标是固定视角的 UI 资产。
export function projectIso(x, y, z) {
  return [x - z, (x + z) / 2 - y];
}

// 三面明暗系数（**UI 图标惯例，不是世界渲染的 shade 口径**）：
// 世界渲染的 shade 是 `light × AO`（§4.3 顶点阶段 float varying），背包图标不参与光照
// 系统，用固定三面系数表达立体感。二者不可复用（与 §4.3 吊灯 blocklight 源 vs 材质
// 自发光的区分同理）。键 = mesher 面索引（0:+X, 2:+Y, 4:+Z）。
export const ISO_SHADE = { 0: 0.75, 2: 1.0, 4: 0.55 };

// 只取朝向观察者的三个面：+X(0) / +Y(2) / +Z(4)。
// -X/-Y/-Z 背向观察者，画出来会被前面的面完全遮挡（painter 算法也会覆盖掉），
// 提前剔除省一半扫描线填充。
const VISIBLE_FACES = new Set([0, 2, 4]);

/**
 * quad 数组 → 投影多边形数组（按深度远→近排序，供 painter 算法依次覆盖）。
 * @param {Array<{v:number[][],face:number}>} quads TEMPLATES 条目（格内 0..1 局部坐标）
 * @returns {Array<{v:number[][],face:number,depth:number}>} `v` 已是投影后的 [sx,sy]
 */
export function isoPolygons(quads) {
  const polys = [];
  for (const q of quads) {
    if (!VISIBLE_FACES.has(q.face)) continue;
    // 深度 = x + z - y（越大越靠近观察者）。除以顶点数取平均即可——只用于排序，
    // 不需要绝对尺度。
    let depth = 0;
    const v = [];
    for (const [x, y, z] of q.v) {
      v.push(projectIso(x, y, z));
      depth += x + z - y;
    }
    // `uv` 透传：模板自带自定义 UV 的（吊灯绳/灯体棱柱）优先于按面查表
    polys.push({ v, face: q.face, depth: depth / q.v.length, uv: q.uv });
  }
  polys.sort((a, b) => b.depth - a.depth); // 远的先画 → 近的覆盖
  return polys;
}

/** 投影多边形的包围盒（用于归一化到画布，也用于单测断言形状辨识度） */
export function isoBBox(polys) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (const [sx, sy] of p.v) {
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * quad 顶点序 → UV 角点。与 mesher.js 的 `FACE_UVS` 同口径（three.js BoxGeometry
 * buildPlane 语义，M2 已核验）：±X 面 u=1-z/z、v=y；±Y 面 u=x、v=1-z/z；±Z 面 u=x/1-x、v=y。
 * 只列三个可见面（其余不参与图标）。
 * 按顶点索引对应，故与 `TEMPLATES` 的顶点序一致——模板若带自定义 `uv`（如吊灯棱柱）
 * 由 renderIsoIcon 优先采用。
 */
const ISO_FACE_UVS = {
  0: [[1, 0], [1, 1], [0, 1], [0, 0]], // +X
  2: [[0, 0], [1, 0], [1, 1], [0, 1]], // +Y
  4: [[0, 0], [1, 0], [1, 1], [0, 1]], // +Z
};

// 扫描线填充：把多边形覆盖到的像素标记为 owner（后画的覆盖前画的 = painter 算法）。
// 返回 { owner, bary }：owner[y][x] = 多边形索引（-1 = 无覆盖），bary[y][x] = UV 插值权重。
function scanFill(polys, size, toPx) {
  const owner = new Int32Array(size * size).fill(-1);
  const bary = new Array(size * size);
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    const pts = p.v.map(toPx);
    // quad 拆两三角形（A,B,C) 与 (A,C,D)），各自重心坐标插值 UV。
    // 模板顶点序是逆时针（从面外向内看），拆法固定。
    const tris = [[0, 1, 2], [0, 2, 3]];
    for (let y = 0; y < size; y++) {
      const xs = [];
      for (let i = 0; i < 4; i++) {
        const a = pts[i], b = pts[(i + 1) % 4];
        // 半边规则：只取「上边不含、下边含」的交点，避免水平边与共享顶点重复计入
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const x0 = Math.round(xs[i]), x1 = Math.round(xs[i + 1]);
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || x >= size) continue;
          const idx = y * size + x;
          owner[idx] = pi;
          bary[idx] = baryWeights(p, pts, tris, x + 0.5, y + 0.5);
        }
      }
    }
  }
  return { owner, bary };
}

// 像素中心落在哪个三角形、对应重心权重（用于 UV 插值）。返回 null = 落空（退化三角形）。
function baryWeights(p, pts, tris, px, py) {
  for (const [i, j, k] of tris) {
    const A = pts[i], B = pts[j], C = pts[k];
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(den) < 1e-9) continue; // 退化三角形（面积 0）
    const w1 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
    const w2 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
    // 容差 0.01：像素中心恰在三角形边上时避免因浮点误差落空
    if (w1 >= -0.01 && w2 >= -0.01 && w1 + w2 <= 1.01) return { w: [1 - w1 - w2, w1, w2], idx: [i, j, k] };
  }
  return null;
}

/**
 * 渲染等轴测图标 → RGBA 像素缓冲（透明背景）。
 *
 * 贴图采样走**重心坐标插值 UV**：按像素在多边形内的位置插值 quad 的 UV 角点，得到
 * 该点的 tile 局部 UV，再采样源贴图（nearest）。这样图标用的是**游戏内实际贴图**
 * （`faces-data` 指向的那张），配色与世界渲染一致——不会出现 mc-lite 手工图标那种
 * 「背包金黄色栏杆、游戏内木色栏杆」的割裂（§4.5.4 v1.24）。
 *
 * @param {Array<{v:number[][],face:number,uv?:number[][]}>} quads TEMPLATES 条目
 * @param {number} size 画布边长（px，图标烘焙用 64）
 * @param {(u:number,v:number)=>number[]} sampleTex 贴图采样回调：tile 局部 UV(0..1) → [r,g,b]
 *        （单测传恒色回调验证明暗分层；烘焙脚本传 PNG nearest 采样）
 * @param {number} [spanPad=1.12] 包围盒归一化留白系数（形状占约 89% 画布）
 * @returns {Uint8ClampedArray} RGBA 缓冲，长度 size²×4
 */
export function renderIsoIcon(quads, size, sampleTex, spanPad = 1.12) {
  const polys = isoPolygons(quads);
  const bb = isoBBox(polys);
  // 按最长边归一化（保持宽高比，不拉伸变形）
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * spanPad;
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const toPx = ([sx, sy]) => [
    ((sx - cx) / span) * size + size / 2,
    ((sy - cy) / span) * size + size / 2,
  ];
  const { owner, bary } = scanFill(polys, size, toPx);

  const out = new Uint8ClampedArray(size * size * 4); // 默认全 0 = 全透明
  for (let idx = 0; idx < size * size; idx++) {
    const pi = owner[idx];
    if (pi < 0) continue; // 形状外 → alpha 0（轮廓可见）
    const p = polys[pi];
    const o = idx << 2;
    // UV：模板自带 uv 优先（吊灯棱柱等自定义 UV），否则按面查表
    const uvs = p.uv ?? ISO_FACE_UVS[p.face];
    let u = 0, v = 0;
    const bw = bary[idx];
    if (bw && uvs) {
      for (let k = 0; k < 3; k++) {
        u += bw.w[k] * uvs[bw.idx[k]][0];
        v += bw.w[k] * uvs[bw.idx[k]][1];
      }
    }
    const [r, g, b] = sampleTex(u, v);
    const shade = ISO_SHADE[p.face];
    out[o] = Math.round(r * shade);
    out[o + 1] = Math.round(g * shade);
    out[o + 2] = Math.round(b * shade);
    out[o + 3] = 255;
  }
  return out;
}
