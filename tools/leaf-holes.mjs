// tools/leaf-holes.mjs — 树叶贴图的「孔洞压缩」共享逻辑（红线 1：两个烘焙脚本共用这一份）
//
// **消费者**：
//   - `tools/bake-giant-textures.mjs`（巨树叶，重着色 + 孔洞压缩）
//   - `tools/bake-leaf-textures.mjs`（普通树叶，只做孔洞压缩、不改颜色）
//   - `tools/check-data.mjs`（门禁按同一份逻辑复算孔洞率，防两处漂移）
//
// ## 为什么需要孔洞压缩（2026-10-23 用户需求）
//
// 树叶走 cutout 通道、`alphaTest = 0.3`（materials.js）→ `alpha < 77` 的像素被 discard。
// 源图那批「半透明」像素（alpha 1~76）会被一并剔掉，孔洞率高达 23%~78%，观感是「叶冠太稀」。
// 尤其是巨树冠巨大、普通树的 `oak_leaves_branch_medium` 甚至 77.6% 孔洞 —— 树叶几乎不成形。
//
// **做法**：从源图**已经被 alphaTest 剔除的那批像素**里按低差异序列选前 N 个作孔洞（alpha 归 0），
// 其余像素 alpha 抬到 255（完全实心）。两个设计点：
//   ① **只在源图的孔洞集合里选** —— 不是在叶面上随机挖洞，保留的孔洞位置仍符合原图的叶片脉络；
//   ② **低差异序列（R2）而非「alpha 最小优先」** —— 后者实测会把孔洞聚成一块（前 8 个全落左上角），
//      而 R2 能铺开到几乎每一行，观感才是「疏密有致」而不是「边上缺一块」。
//
// ⚠️ **几何/顶点数完全不变**（只改 alpha），所以不影响任何容量预算。

import { PNG } from 'pngjs';

/** cutout 材质的 alphaTest 阈值：alpha < 77 的像素会被 discard（materials.js 的 `alphaTest: 0.3`） */
export const HOLE_ALPHA = 77;

/**
 * 统一孔洞率（2026-10-23 用户裁定：普通树叶「跟巨树一样」）。
 * 实测：38/256 = 14.84%，叶面覆盖 85.2%。
 * 取值依据（巨树那次逐档试出来的，同一套看图比对）：
 *   · 0.03（8 个）→ 几乎无孔，像实心彩色塑料
 *   · 0.08（20 个）→ 孔洞太零散
 *   · 0.15（38 个）→ 疏密有致，铺开 14/16 行
 */
export const LEAF_HOLE_RATIO = 0.15;

/** 门禁允许的孔洞率区间（3%~25%；太小像实心色板，太接近源图就回到「叶冠太稀」） */
export const LEAF_HOLE_RATIO_MIN = 0.03;
export const LEAF_HOLE_RATIO_MAX = 0.25;

/**
 * 杜鹃树叶的孔洞率（2026-10-28 用户裁定：8%）。
 *
 * **为什么杜鹃叶要单独一档，不能沿用 `LEAF_HOLE_RATIO`（0.15）**
 * —— 同一个孔洞**率**在两张贴图上不是同一个观感，判据是**孔洞块的大小**而不是总量：
 *   实测 `azalea_leaves` 在 15% 时孔洞 22 块、**最大 4px**、≥3px 的块有 4 个；
 *   而普通树叶 `leaves` 在 15% 时 30 块、**最大只有 2px**、≥3px 的块 0 个。
 * 树冠越大，单层外壳上一个 4px 的大孔越容易直接透到背后的天空（内面被 `opaqueTable=1`
 * 剔掉了），所以普通树 5×5 冠幅看不出来、杜鹃树 8~13 冠幅就明显「镂空感强烈」。
 * 降到 8% 后两张杜鹃贴图的**最大孔洞块都收敛到 2px、≥3px 归零**，与普通树叶同档。
 *
 * ⚠️ **改这个值必须同时重跑 `npm run leaftextures` 与 `npm run atlas`**（贴图是 atlas 输入），
 * 且 `check:data` 的 `[树叶贴图]` 会按 `LEAF_HOLE_RATIO_AZALEA` 复算，不匹配即红。
 */
export const LEAF_HOLE_RATIO_AZALEA = 0.08;

/** R2 低差异序列：给像素一个确定性的「空间铺开」优先级（不依赖随机数） */
function r2Priority(i, width) {
  const x = i % width;
  const y = Math.floor(i / width);
  const v = x * 0.7548776662466927 + y * 0.5698402909980532;
  return v - Math.floor(v);
}

/**
 * 压缩孔洞：从源图「会被 alphaTest 剔除」的像素里按 R2 顺序选前 `ratio×像素数` 个作孔洞
 * （alpha 归 0），其余全部抬到 255。返回新的 alpha 数组与孔洞数。
 *
 * 源图孔洞不够 `ratio` 所需时用全部源孔洞（**不额外挖叶面**）。
 *
 * ⚠️⚠️ **未被选为孔洞的「源图孔洞像素」必须继续保持 alpha=0**（v1.29 修的缺陷）。
 * 旧实现对每个像素一律填 255 再抹掉选中的那几个 —— 而源图那些像素的 **RGB 往往是 (0,0,0)**
 * （`azalea_leaves` 实测 59 个纯黑源孔洞），抬成 255 就变成**不透明的纯黑噪点**。
 * 实测被污染 39 个（59 − 20 个选中的孔洞）。这个缺陷在图标上肉眼可见（叶面黑点），
 * 在世界渲染里只是零星黑像素、被当成“叶脉暗部”忽略了很多轮（2026-11-04 查图标时才发现）。
 *
 * @param {{width:number,height:number,data:Uint8Array}} src pngjs 解码后的 PNG
 * @param {number} ratio 目标孔洞率（占全部像素）
 * @returns {{alpha: Uint8Array, holeCount: number, srcHoleCount: number}}
 */
export function compactLeafHoles(src, ratio) {
  const n = src.width * src.height;
  const srcHoles = [];
  for (let i = 0; i < n; i++) if (src.data[i * 4 + 3] < HOLE_ALPHA) srcHoles.push(i);
  const ranked = [...srcHoles].sort((a, b) => r2Priority(a, src.width) - r2Priority(b, src.width) || a - b);
  const holeCount = Math.max(0, Math.min(srcHoles.length, Math.round(n * ratio)));

  // 基准：一律 255（叶面）。再从源图孔洞里按 R2 顺序挑出 `holeCount` 个作孔洞。
  const alpha = new Uint8Array(n).fill(255);
  for (let k = 0; k < holeCount; k++) alpha[ranked[k]] = 0;
  return { alpha, holeCount, srcHoleCount: srcHoles.length };
}

/**
 * **颜色漫溢（color bleed）**：给透明像素补上邻近叶面的颜色。
 *
 * 为什么必须有它：源图的透明像素**没有可信 RGB** —— `azalea_leaves` 的 59 个孔洞全是
 * `(0,0,0)`、`oak_leaves_branch_medium` 的 795 个也是。而 `compactLeafHoles` 会把其中一部分
 * **抬成不透明**（孔洞率从 77.6% 压到 15% 必然如此）—— 不补色就是“不透明的纯黑噪点”。
 * 实测污染量：`leaf_azalea_leaves` **39 个**（占叶面 16.5%）、`leaf_azalea_flowers` **31 个**。
 * 它们在世界上被当成“叶脉暗部”忽略了很多轮，但在 32px 背包图标里每颗 texel 约 1.5px，
 * 黑点是肉眼可见的噪点（用户 2026-11-04 报“镂空过去是黑色的”时就此暴露）。
 *
 * 做法 = 广度优先从透明↔不透明的边界向内漫溢（就近叶面色），多轮直到填满或达到上限。
 * 与图形管线的 alpha bleeding / alpha dilation 同一手法。
 *
 * ⚠️ **只用于“会被抬成不透明”的像素**：真正保留为孔洞的像素不需要颜色（alpha=0 不参与
 * 合成），不漫溢就不会白白改动源图的 RGB。
 *
 * @param {{width:number,height:number,data:Uint8Array}} src pngjs 解码后的 PNG
 * @param {Uint8Array} alpha 目标 alpha 数组（0 或 255）
 * @returns {Uint8Array} 新的 RGBA 数据（RGB 已对“透明→不透明”的像素补色）
 */
export function bleedPromotedColors(src, alpha) {
  const { width: w, height: h } = src;
  const n = w * h;
  const out = new Uint8Array(src.data);
  // 只有“源图不可信（透明）且目标变为不透明”的像素才需要补色
  const need = new Uint8Array(n);
  let pending = 0;
  for (let i = 0; i < n; i++) {
    if (src.data[i * 4 + 3] < HOLE_ALPHA && alpha[i] !== 0) { need[i] = 1; pending++; }
  }
  if (pending === 0) return out; // 无需要补色的像素 → 逐字节不变（既不改 RGB 也不改 alpha）

  // “可信颜色”集合 = **源图本来就不透明的像素**。
  // ⚠️ 不能写成“不需要补色的像素” —— 那会把“目标为孔洞（alpha=0）”的源孔洞像素也算成
  // 可信颜色源，而它们的 RGB 正是 (0,0,0) 填充值 → 扩散的第一轮就从纯黑取样，整片变黑
  // （实测：oak_leaves_branch_medium 的 641 个待补像素里有 460 个第一次扩散后仍是纯黑）。
  const trustworthy = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (src.data[i * 4 + 3] >= HOLE_ALPHA) trustworthy[i] = 1;

  // 逐轮从 8 邻域平均已知颜色（8 邻域让斜边也连续，避免十字状伪影）
  const filled = Uint8Array.from(trustworthy); // 已具备可信颜色的像素
  const MAX_ROUNDS = w + h; // 最坏情形从边界一路填到中心
  for (let round = 0; round < MAX_ROUNDS && pending > 0; round++) {
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!need[i] || filled[i]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!filled[j]) continue;
            r += out[j * 4]; g += out[j * 4 + 1]; b += out[j * 4 + 2]; c++;
          }
        }
        if (c) add.push([i, Math.round(r / c), Math.round(g / c), Math.round(b / c)]);
      }
    }
    if (!add.length) break; // 整个图都是透明的（无参照色）→ 保底留原值
    for (const [i, r, g, b] of add) {
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b;
      filled[i] = 1; pending--;
    }
  }
  return out;
}

/**
 * 按 pngjs 的 PNG 对象统计「会被 alphaTest 剔除」的像素比例（门禁用；与烘焙同一判据）。
 * @param {{width:number,height:number,data:Uint8Array}} png
 * @returns {{holes:number, total:number, ratio:number}}
 */
export function leafHoleStats(png) {
  const total = png.width * png.height;
  let holes = 0;
  for (let i = 0; i < total; i++) if (png.data[i * 4 + 3] < HOLE_ALPHA) holes++;
  return { holes, total, ratio: holes / total };
}

/**
 * 把一份 alpha 数组套到源图 RGB 上，生成新 PNG（RGB 逐字节保留，只改 alpha）。
 * 用于「只压孔洞、不改颜色」的普通树叶烘焙。
 */
export function applyAlpha(src, alpha) {
  const out = new PNG({ width: src.width, height: src.height });
  out.data.set(src.data);
  for (let i = 0; i < src.width * src.height; i++) out.data[i * 4 + 3] = alpha[i];
  return out;
}
