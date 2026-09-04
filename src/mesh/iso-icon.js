// src/mesh/iso-icon.js — 等轴测投影图标（§4.5.4 v1.24 建、v1.26 扩全量）
//
// 把 mesher.js 的几何投影成背包图标。**形状与 UV 的唯一权威在 mesher.js**
// （红线 1：数据只有一份权威）——本文件不含任何几何定义，只 import 并消费：
//   - 异形方块 → `TEMPLATES[geometry]`（v1.24 已导出）
//   - 实心方块 → `cubeQuads()`（v1.26，由 mesher 的 `FACE_VERTICES`/`FACE_UVS` 派生）
//
// 同构纯函数（红线 8）：无 DOM、无 three、无 node 依赖 —— 烘焙脚本（tools/）与浏览器
// 单测（src/tests/）共用同一份代码。像素写入返回 Uint8ClampedArray RGBA，落盘 PNG 由
// 调用方负责（tools/bake-icon-atlas.mjs 用 pngjs）。
//
// 为什么离线烘焙而非运行时合成：运行时只需一行 `icon.style.background = manifest[name]`
// （裁剪数学也预生成掉），与其余项同一条路径、确定性（固定算法无随机）、
// 符合红线 3（重计算离开运行时）。代价是几何/贴图变更需重跑 `npm run icons`。
import { FACE_VERTICES, FACE_UVS } from './mesher.js';

// 2:1 等轴测投影（图标惯例，Minecraft 同款观感）：
//   sx = x - z          （+X 向右下、+Z 向左下）
//   sy = (x+z)/2 - y    （抬升 y → 屏幕上移）
// 不是世界渲染的相机投影——图标是固定视角的 UI 资产。
export function projectIso(x, y, z) {
  return [x - z, (x + z) / 2 - y];
}

/**
 * 视线方向上的深度（越大越靠近观察者）。
 *
 * 推导：两个投影轴 u=(1,0,-1)、v=(0.5,-1,0.5) 叉乘得投影平面法线
 * `n = u × v = (-1,-1,-1)` → 视线从 (+,+,+) 看向原点 → **正确深度 = x+y+z**。
 *
 * **历史 bug（v1.28 修）**：曾写 `x+z-y`，y 符号反了。与正确度量差 `2y`，对只在 y 上
 * 不同的两点判定**完全相反**（`(0,1,0)` vs `(0,0,0)`：判成 -1 < 0 = 高处更远）。实心
 * 方块三个可见面互不重叠，排序不影响结果 → 长期未被发现；异形方块（台阶/栏杆/柱子）
 * 的面会重叠，错度量直接导致遮挡判定反了。
 */
function isoDepth(x, y, z) {
  return x + y + z;
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
 *
 * **v1.28：额外带 `dv`（逐顶点深度）**。面平均深度 `depth` 只能用于排序，对被整片遮住
 * 的面无能为力（见 `renderIsoIcon` 的逐像素深度测试说明）；`dv` 供重心插值算出每个
 * 像素的真深度。
 *
 * @param {Array<{v:number[][],face:number}>} quads TEMPLATES 条目（格内 0..1 局部坐标）
 * @returns {Array<{v:number[][],face:number,depth:number,dv:number[]}>}
 *          `v` 已是投影后的 [sx,sy]；`dv[i]` 是 `v[i]` 对应顶点的视线深度
 */
export function isoPolygons(quads) {
  const polys = [];
  for (const q of quads) {
    if (!VISIBLE_FACES.has(q.face)) continue;
    // 深度 = x + y + z（越大越靠近观察者）。除以顶点数取平均即可——只用于排序，
    // 不需要绝对尺度。逐顶点深度另存于 `dv` 供逐像素测试。
    let depth = 0;
    const v = [], dv = [];
    for (const [x, y, z] of q.v) {
      v.push(projectIso(x, y, z));
      const d = isoDepth(x, y, z);
      dv.push(d);
      depth += d;
    }
    // `uv` 透传：模板自带自定义 UV 的（吊灯绳/灯体棱柱）优先于按面查表
    polys.push({ v, face: q.face, depth: depth / q.v.length, dv, uv: q.uv });
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
 * 单位立方体的三个可见面（v1.26）：97 个实心方块在 mesher 里**无 TEMPLATES 模板**，
 * 走 `mesher.js` 的默认路径（`FACE_VERTICES[modelFace]`）。图标烘焙必须复用同一份
 * 顶点与 UV —— **红线 1：形状与 UV 只有一份权威，本文件不得手写第二份定义**。
 *
 * 返回 `{v, face, uv}` 结构，与 `TEMPLATES` 条目同构 → 可直接喂给 `isoPolygons()`。
 * 顶点序与 `FACE_VERTICES[face]` 完全一致（未重排），故 `FACE_UVS[face]` 的角点按索引
 * 对应即可。带 `uv` 字段意味着 `renderIsoIcon` 走「模板自带 uv 优先」分支，不查表。
 *
 * @returns {Array<{v:number[][],face:number,uv:number[][]}>} 三个可见面（+X/+Y/+Z）
 */
export function cubeQuads() {
  return [0, 2, 4].map((face) => ({
    v: FACE_VERTICES[face].map((p) => p.slice()), // 拷贝：防调用方改动污染 mesher 的常量
    face,
    uv: FACE_UVS[face].map((p) => p.slice()),
  }));
}

/**
 * 扫描线填充 + **逐像素深度测试**（v1.28，取代 painter 的整面覆盖）。
 *
 * **为什么必须逐像素**：painter 用「面平均深度」排序后整面覆盖，对被**整片遮住**的面
 * 无能为力 —— 面 A 的平均深度可能比面 B 大（判 A 更近），但 A 的某些区域实际在 B 之后。
 * 实测载体 `cobblestone_step_updown`：下半柱在 y=0.5 的顶面被上半块完全遮住（现实中
 * 看不见），但它的平均深度大于柱侧面 → painter 把它画在后面、覆盖掉本该可见的柱侧面，
 * 渲成一片亮楔形。**仅修正深度度量（`isoDepth`）不够** —— 三方案实测（32px 画布，判据 =
 * 下半画布顶面亮度像素，与 `test-iso-icon.js` 同一口径）：
 * 错度量 + painter **88px** → 仅改度量 + painter **仍 88px** → 正确度量 + 逐像素 **4px**
 * （仅剩深度并列的边界像素）。
 *
 * 逐像素深度 = 重心插值该 quad 四个顶点的视线深度（`dv`），与 GPU 的 z-buffer 同语义。
 * 排序仍保留（`isoPolygons` 的远→近）：它决定**深度并列**时的胜负（`>` 而非 `>=`
 * → 后画的并列面不覆盖先画的，保持 painter 的既有语义）。
 *
 * 返回 { owner, bary }：owner[y][x] = 多边形索引（-1 = 无覆盖），bary[y][x] = UV 插值权重。
 */
function scanFill(polys, size, toPx) {
  const owner = new Int32Array(size * size).fill(-1);
  const bary = new Array(size * size);
  const zbuf = new Float64Array(size * size).fill(-Infinity);
  for (let pi = 0; pi < polys.length; pi++) {
    const p = polys[pi];
    const pts = p.v.map(toPx);
    // quad 拆两三角形（A,B,C) 与 (A,C,D)），各自重心坐标插值 UV 与深度。
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
          const bw = baryWeights(p, pts, tris, x + 0.5, y + 0.5);
          // 重心插值真深度；落空（退化三角形）回落面平均深度
          let d = p.depth;
          if (bw) {
            d = 0;
            for (let k = 0; k < 3; k++) d += bw.w[k] * p.dv[bw.idx[k]];
          }
          if (d <= zbuf[idx]) continue; // 已有更近的面占据 → 本面在此像素被遮挡
          zbuf[idx] = d;
          owner[idx] = pi;
          bary[idx] = bw;
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
 * **v1.26：采样回调收到第三个参数 `face`**（逐面采样）。实测背包实心 104 项里有 17 项
 * 是多面不同贴图（`grass` 顶绿侧土、`chest` 顶/侧/面三张、`tnt` 顶侧不同）。旧签名
 * `sampleTex(u, v)` 只能采单面 → 三个面全采同一张贴图，`grass` 的顶面会渲成土色。
 * 调用方按 face 取对应贴图即可（`getFaceTile(name, face)`）。向后兼容：忽略第三参的
 * 旧回调仍能工作（单测的恒色回调即如此）。
 *
 * @param {Array<{v:number[][],face:number,uv?:number[][]}>} quads TEMPLATES 条目或 cubeQuads()
 * @param {number} size 画布边长（px，按显示尺寸烘焙：快捷栏 40 / 背包 32）
 * @param {(u:number,v:number,face:number)=>number[]} sampleTex 贴图采样回调：
 *        tile 局部 UV(0..1) + 面索引 → [r,g,b]（单测传恒色回调验证明暗分层；
 *        烘焙脚本按 face 取 PNG 做 nearest 采样）
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
    // UV：quad 自带 uv 优先（cubeQuads 与吊灯棱柱等自定义 UV），否则按面查 mesher 的表
    // （13 个 TEMPLATES 条目不带 uv —— 实测核实，故查表分支必须保留）
    const uvs = p.uv ?? FACE_UVS[p.face];
    let u = 0, v = 0;
    const bw = bary[idx];
    if (bw && uvs) {
      for (let k = 0; k < 3; k++) {
        u += bw.w[k] * uvs[bw.idx[k]][0];
        v += bw.w[k] * uvs[bw.idx[k]][1];
      }
    }
    const [r, g, b] = sampleTex(u, v, p.face);
    const shade = ISO_SHADE[p.face];
    out[o] = Math.round(r * shade);
    out[o + 1] = Math.round(g * shade);
    out[o + 2] = Math.round(b * shade);
    out[o + 3] = 255;
  }
  return out;
}
