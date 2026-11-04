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

/**
 * cutout 阈值：贴图 alpha 低于它整片丢弃。
 *
 * **数值必须与世界渲染的 cutout 通道一致**（`materials.js` 的 `cutout: makeMaterial({
 * alphaTest: 0.3 })`）—— 否则背包里的树叶/玻璃镂空形状会与实际渲染的轮廓不同，
 * 玩家按图标判断“能看见背后多少”会被误导（红线 1：渲染语义只有一份权威）。
 */
export const ISO_ALPHA_TEST = 0.3;

/**
 * 图标渲染算法版本（进输入指纹）。
 *
 * **为什么需要它**：指纹只覆盖“烘焙读了什么”（几何 + 贴图内容），覆盖不到“怎么铺”。
 * v1.29 修掉重心权重错位后，同一份几何 + 贴图会烘出完全不同的像素（实测 114 个等轴测
 * 图标全部逐像素变化）—— 若指纹不变，“改了算法忘重烘”就是静默过期（玩家看到旧图标）。
 * 改任何影响输出的渲染细节（投影/插值/阴影系数/超采样）都要 bump 它。
 */
export const ISO_RENDER_VERSION = 'v1.29';

/**
 * alpha 处理模（与世界渲染的三条通道一一对应，不是另立的 UI 规则）：
 *   - `'opaque'`：opaque 通道 alphaTest=0 → **忽略**贴图 alpha（97 个实心方块走这条）
 *   - `'cutout'`：cutout 通道 alphaTest=0.3 → 低于阈值丢弃、其余归一为不透明
 *   - `'blend'`：transparent 通道 → 保留原 alpha（玻璃/水）
 */
const ALPHA_MODES = new Set(['opaque', 'cutout', 'blend']);

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
 *
 * `size` 由调用方决定；超采样在上层（`renderIsoIcon`）以大尺寸跑本函数再降采样。
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
//
// **v1.29 修的错位 bug（用户报告「可见的三个面变花了」的根因）**：旧实现把
// `{ w: [1-w1-w2, w1, w2], idx: [i,j,k] }` 返回 —— 而 `w1`/`w2` 是顶点 **A** 与 **B**
// 的重心坐标（标准推导：`wA = ((B-C)×(P-C)) / ((B-C)×(A-C))`），`1-w1-w2` 才是 C 的。
// 配成 `[i,j,k]` 等于把权重**循环旋转**一位（A↔C、B↔A），三角形内部 UV 被斜向剪切：
// 贴图每块图案都被拉伸且方向错，观感就是“花了”。实心方块三面拼在一起时边界处错位最明显。
// **判据在 `test-iso-icon.js` 的“UV 按重心插值正确落到面内位置”**（从像素反解 UV 比对）。
function baryWeights(p, pts, tris, px, py) {
  for (const [i, j, k] of tris) {
    const A = pts[i], B = pts[j], C = pts[k];
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(den) < 1e-9) continue; // 退化三角形（面积 0）
    const wA = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
    const wB = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
    // 容差 0.01：像素中心恰在三角形边上时避免因浮点误差落空
    if (wA >= -0.01 && wB >= -0.01 && wA + wB <= 1.01) return { w: [wA, wB, 1 - wA - wB], idx: [i, j, k] };
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
 * **v1.29：alpha 传播 + 超采样**
 *   - 旧实现末尾硬编码 `out[o+3] = 255`，把贴图 alpha 完全丢弃。而 `Glass.png` 的透明
 *     像素 RGB 是 (0,0,0)、树叶孔涞处也残留暗色 → 玻璃渲成黑底、树叶孔变成黑点（用户
 *     报告“镂空过去是黑色的”）。现按 `alphaMode` 区分（与世界渲染三条通道一一对应）。
 *   - `samples` 超采样：把画布放大 `samples` 倍跑同一条扫描线/深度管线，再按 **alpha
 *     预乘平均**降采样 —— 预乘是必要的，否则轮廓像素的 RGB 会抳进“无覆盖”样本的黑 0，
 *     边缘发黑（与贴图 alpha 无关的第二条黑边来源）。
 *
 * @param {Array<{v:number[][],face:number,uv?:number[][]}>} quads TEMPLATES 条目或 cubeQuads()
 * @param {number} size 画布边长（px，按显示尺寸烘焙：快捷栏 40 / 背包 32）
 * @param {(u:number,v:number,face:number)=>number[]} sampleTex 贴图采样回调：
 *        tile 局部 UV(0..1) + 面索引 → `[r,g,b]` 或 `[r,g,b,a]`（单测传恒色回调验证明暗
 *        分层；烘焙脚本按 face 取 PNG 做 nearest 采样）。**三元素返回值按不透明处理**
 *        （向后兼容：旧调用方与单测无需改）。
 * @param {number} [spanPad=1.12] 包围盒归一化留白系数（形状占约 89% 画布）
 * @param {{alphaMode?: 'opaque'|'cutout'|'blend', samples?: number}} [opts]
 *        `alphaMode` 见模块顶部注释（默认 `'opaque'` = 旧行为）；`samples` 为超采样
 *        倍率（默认 1 = 不超采样）
 * @returns {Uint8ClampedArray} RGBA 缓冲，长度 size²×4
 */
export function renderIsoIcon(quads, size, sampleTex, spanPad = 1.12, opts = {}) {
  const alphaMode = opts.alphaMode ?? 'opaque';
  if (!ALPHA_MODES.has(alphaMode)) throw new Error(`未知的 alphaMode：${alphaMode}`);
  const samples = Math.max(1, Math.floor(opts.samples ?? 1));
  const ss = size * samples; // 超采样画布边长（samples=1 时就是 size）

  const polys = isoPolygons(quads);
  const bb = isoBBox(polys);
  // 按最长边归一化（保持宽高比，不拉伸变形）。⚠️ 归一化量与超采样倍数无关：
  // 先把世界坐标映到 `ss` 像素，再在降采样时回到 size —— 两条路径的几何完全重合。
  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * spanPad;
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
  const toPx = ([sx, sy]) => [
    ((sx - cx) / span) * ss + ss / 2,
    ((sy - cy) / span) * ss + ss / 2,
  ];
  const { owner, bary } = scanFill(polys, ss, toPx);

  // 中间缓冲（超采样分辨率）：RGB 已乘 shade，A = **逐样本的有效不透明度**。
  // ⚠️ “几何覆盖”与“贴图 alpha”是两件事，必须分开：旧实现直接把贴图 alpha 写进 A，
  // 于是 opaque 模式（世界 alphaTest=0，应完全忽略贴图 alpha）下 `Glass.png` 的透明
  // 像素会连带把**几何覆盖**也抹掉 → 整个图标消失。现按通道语义合成有效 alpha：
  //   opaque → 只看覆盖；cutout → 覆盖且贴图 alpha 达阈值；blend → 覆盖 × 贴图 alpha
  const pre = new Uint8ClampedArray(ss * ss * 4);
  for (let idx = 0; idx < ss * ss; idx++) {
    const pi = owner[idx];
    if (pi < 0) continue; // 形状外 → 全 0（轮廓可见）
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
    const texel = sampleTex(u, v, p.face);
    const shade = ISO_SHADE[p.face];
    // 第四分量缺省 = 不透明（向后兼容三元素回调）
    const texAlpha = (texel[3] === undefined ? 255 : texel[3]) / 255;
    const aEff = alphaMode === 'opaque' ? 1
      : alphaMode === 'cutout' ? (texAlpha >= ISO_ALPHA_TEST ? 1 : 0)
      : texAlpha; // blend
    pre[o] = Math.round(texel[0] * shade);
    pre[o + 1] = Math.round(texel[1] * shade);
    pre[o + 2] = Math.round(texel[2] * shade);
    pre[o + 3] = Math.round(aEff * 255);
  }

  if (samples === 1) {
    applyAlphaMode(pre, alphaMode);
    return pre;
  }

  // 降采样：alpha 预乘平均 → 再解预乘（避免轮廓像素被“无覆盖样本的黑 0”拉暗）
  const out = new Uint8ClampedArray(size * size * 4);
  const n = samples * samples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < samples; dy++) {
        for (let dx = 0; dx < samples; dx++) {
          const o = (((y * samples + dy) * ss) + (x * samples + dx)) << 2;
          const al = pre[o + 3] / 255;
          r += pre[o] * al;
          g += pre[o + 1] * al;
          b += pre[o + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) << 2;
      if (a > 0) { // 解预乘（a 是覆盖度之和，不是归一化 alpha）
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/**
 * 单样本（`samples: 1`）下的 alpha 归一。
 *
 * **降采样路径不能跑本函数**：那里的部分 alpha 是**几何覆盖度**（抗锯齿的来源），
 * 把它也按 0.3 二元化就变成硬阶梯（等于白做超采样）。二元化必须逐样本做
 * （已在渲染循环里按 `aEff` 完成），这里只负责单样本路径的收起。
 */
function applyAlphaMode(buf, alphaMode) {
  if (alphaMode === 'blend') return;
  for (let i = 3; i < buf.length; i += 4) {
    if (alphaMode === 'opaque') { if (buf[i] > 0) buf[i] = 255; }
    else buf[i] = buf[i] / 255 >= ISO_ALPHA_TEST ? 255 : 0; // cutout
  }
}
