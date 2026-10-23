// tools/bake-giant-textures.mjs — 巨树景观贴图离线烘焙（docs/superpowers/plans/2026-10-23-giant-trees.md Task 2）
//
// 做法 = 「沿用现有镂空树叶的图案，只换色」：
//   - 源图 `assets/textures/leaves.png`（16×16，alpha 孔洞图案：59 个不透明 / 13 个全透明 / 其余半透明）。
//   - **alpha 通道逐字节保留**（镂空孔洞形状不变）；RGB 全部重算，**含 alpha=0 的像素**：
//     巨树叶走 opaque 通道（材质无 alphaTest，alpha 被忽略 → 孔洞处直接显示该像素的 RGB），
//     若把透明像素的 RGB 留成原来的绿色，粉叶上会渗出绿点；留成黑色则会出黑点。
//   - 重着色 = 亮度比乘法：out = base × k，k = max(MIN_K, 1 + CONTRAST × (Y_pixel / Y_ref − 1))，
//     三通道同乘一个标量，色相不变，保留源图的明暗斑驳；Y 取 Rec.709 在 sRGB 数值域上的值。
//     Y_ref = 可见像素（alpha ≥ HOLE_ALPHA）亮度的 p90，所以 `base` 是「受光最亮那档叶面」的颜色，
//     更亮的高光会在 R 通道饱和（偏淡粉）、更暗的变深 —— 整张的均值会比 base 略暗，
//     这是设计（烘焙时会打印实测均值）。
//   - CONTRAST < 1 是**有意压缩明暗**：源图是深绿叶，亮度比 Y/Y_ref 低到 0.55；
//     原样乘到亮粉上（CONTRAST=1）最暗处会变成发闷的紫褐色（Y=93），对樱花叶偏脏；
//     0.6 保留叶脉图案又不发闷（最暗 Y=123），0.4 几乎变平（丢图案）。可按观感调这一个常量。
//
// 输出目录：
//   默认        assets/textures/procedural/   —— 会被 `npm run atlas` 打进世界 atlas（Task 2 的终态位置）
//   --staging   assets/giant-trees/staging/   —— 暂存「备用」：**不在** assets/textures 下，
//                                                atlas 构建与 atlas.spec 的 PNG 计数都看不到它
//   ⚠️ 不能把暂存产物直接放进 assets/textures：build-atlas 会递归扫描整个目录，atlas.spec 断言
//      「atlas tile 数 ≡ 目录 PNG 数」，没重跑 `npm run atlas` 就会红。
//
// 确定性：同输入同参数 → 逐字节相同的 PNG（pngjs 的编码是确定性的）。
//
// 用法：node tools/bake-giant-textures.mjs [--staging] [--only name1,name2]
//   当前 TEXTURES 表只有 giant_cherry_leaves 一行（先烘焙备用）；Task 2 补全其余行后再跑全量，
//   并用 `cmp` 确认暂存的粉叶与终态产物逐字节相同。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_FINAL = path.join(TEX_DIR, 'procedural');
const OUT_STAGING = path.join(ROOT, 'assets', 'giant-trees', 'staging');

/**
 * cutout 材质的 alphaTest 阈值（materials.js：`alphaTest: 0.3`）。
 * alpha < 0.3×255 = 76.5 的像素在 cutout 通道会被丢弃 = 「镂空孔洞」。
 * 这里只用来统计与定义「可见像素」，不改任何像素。
 */
const HOLE_ALPHA = 77;

/** 明暗对比度增益（见头部说明）与亮度比下限（防止最暗像素过黑） */
const CONTRAST = 0.6;
const MIN_K = 0.45;

/**
 * 烘焙表。`src` 相对 assets/textures；`base` = 受光最亮那档叶面的目标 RGB。
 * 粉叶基色取 plan Task 2 的 (255,140,195)（樱粉）。
 */
export const TEXTURES = Object.freeze([
  { name: 'giant_birch_leaves', src: 'leaves.png', base: [160, 235, 150] },   // 白桦：亮黄绿
  { name: 'giant_spruce_leaves', src: 'leaves.png', base: [35, 95, 60] },     // 雪松：深蓝绿
  { name: 'giant_cherry_leaves', src: 'leaves.png', base: [255, 140, 195] },  // 樱花：樱粉
  { name: 'giant_palm_leaves', src: 'leaves.png', base: [45, 150, 55] },      // 椰子：亮绿
  { name: 'giant_banyan_leaves', src: 'leaves.png', base: [85, 185, 75] },    // 榕树：中绿
  { name: 'giant_mangrove_log', src: 'log_big_oak.png', base: [135, 65, 65] }, // 红树干：沿用 bark 明暗结构
]);

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 重着色：保留 alpha，RGB = base × (Y / Y_ref)。返回新 PNG 与统计量。 */
export function recolor(src, base) {
  const n = src.width * src.height;
  const ys = new Float64Array(n);
  const visibleYs = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    ys[i] = luma(src.data[o], src.data[o + 1], src.data[o + 2]);
    if (src.data[o + 3] >= HOLE_ALPHA) visibleYs.push(ys[i]);
  }
  visibleYs.sort((a, b) => a - b);
  // p90（最近秩法，确定性）：visibleYs 至少有几十个像素，不会越界
  const yRef = visibleYs[Math.min(visibleYs.length - 1, Math.floor(visibleYs.length * 0.9))];

  const out = new PNG({ width: src.width, height: src.height });
  let holes = 0, sr = 0, sg = 0, sb = 0, nv = 0, clippedR = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = Math.max(MIN_K, 1 + CONTRAST * (ys[i] / yRef - 1));
    for (let c = 0; c < 3; c++) {
      const v = Math.round(base[c] * k);
      if (c === 0 && v > 255) clippedR++;
      out.data[o + c] = Math.max(0, Math.min(255, v));
    }
    out.data[o + 3] = src.data[o + 3]; // alpha 逐字节保留
    if (src.data[o + 3] < HOLE_ALPHA) holes++;
    else { sr += out.data[o]; sg += out.data[o + 1]; sb += out.data[o + 2]; nv++; }
  }
  return {
    png: out,
    stats: { yRef, holes, visible: nv, clippedR, meanVisible: [sr / nv, sg / nv, sb / nv] },
  };
}

function main() {
  const args = process.argv.slice(2);
  const staging = args.includes('--staging');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
  const outDir = staging ? OUT_STAGING : OUT_FINAL;
  fs.mkdirSync(outDir, { recursive: true });

  for (const t of TEXTURES) {
    if (only && !only.has(t.name)) continue;
    const srcPath = path.join(TEX_DIR, t.src);
    const src = PNG.sync.read(fs.readFileSync(srcPath));
    const { png, stats } = recolor(src, t.base);

    // 自检：alpha 通道必须与源图逐字节相同（孔洞形状不变）
    for (let i = 3; i < src.data.length; i += 4) {
      if (png.data[i] !== src.data[i]) throw new Error(`${t.name}: alpha 与源图不一致（像素 ${(i - 3) / 4}）`);
    }
    // 自检：不得出现近黑像素（opaque 通道下孔洞处会直接露出 RGB → 黑点）
    for (let i = 0; i < png.data.length; i += 4) {
      if (luma(png.data[i], png.data[i + 1], png.data[i + 2]) < 40) {
        throw new Error(`${t.name}: 像素 ${i / 4} 亮度 < 40（opaque 下会成黑点）`);
      }
    }
    const dst = path.join(outDir, `${t.name}.png`);
    fs.writeFileSync(dst, PNG.sync.write(png));
    const m = stats.meanVisible.map((x) => x.toFixed(0)).join(',');
    console.log(`${t.name}: ${path.relative(ROOT, dst)}  ${src.width}×${src.height}  ` +
      `源=${t.src} base=(${t.base.join(',')})  Y_ref=${stats.yRef.toFixed(1)}  ` +
      `镂空像素(alpha<${HOLE_ALPHA})=${stats.holes}/${src.width * src.height}  ` +
      `可见像素均值RGB=(${m})  R 通道饱和=${stats.clippedR}`);
  }
}

// 仅在直接运行时执行（被 import 做单测/门禁时不烘焙）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
