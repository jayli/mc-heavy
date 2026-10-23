// tools/bake-giant-textures.mjs — 巨树景观贴图离线烘焙（docs/superpowers/plans/2026-10-23-giant-trees.md Task 2）
//
// 做法 = 「沿用现有镂空树叶的图案，只换色」：
//   - 源图 `assets/textures/leaves_original.png`（16×16，alpha 孔洞图案：59 个不透明 / 13 个全透明 / 其余半透明）。
//     用户 2026-10-23 指定以它为基底（与旧基底 `leaves.png` **图案同构**：alpha 逐字节相同、
//     亮度相关系数 0.999，差别只是整体亮约 14%）→ 换源不会改变镂空形状与明暗纹理结构。
//   - **alpha 通道逐字节保留**（镂空孔洞形状不变）；RGB 全部重算，**含 alpha=0 的像素**：
//     巨树叶走 opaque 通道（材质无 alphaTest，alpha 被忽略 → 孔洞处直接显示该像素的 RGB），
//     若把透明像素的 RGB 留成原来的绿色，粉叶上会渗出绿点；留成黑色则会出黑点。
//   - 重着色 = 亮度比乘法：out = base × k，k = max(MIN_K, 1 + contrast × (Y_pixel / Y_ref − 1))，
//     三通道同乘一个标量，色相不变，保留源图的明暗斑驳；Y 取 Rec.709 在 sRGB 数值域上的值。
//     Y_ref = 可见像素（alpha ≥ HOLE_ALPHA）亮度的 p90，所以 `base` 是「受光最亮那档叶面」的颜色，
//     整张的均值会比 base 暗一档（本源图上均值/基色 ≈ 0.878，基色标定已按这一点折算，见 TEXTURES）。
//   - `contrast` **逐条**给（不是全局常量）：
//     * 树叶一律 `contrast = 1` —— 用户要求「保留跟原来一样的表面像素深浅」，此时
//       `k = Y/Y_ref` 是**纯亮度比**，输出的相对明暗结构与源图严格同构（会打印实测相关系数）。
//       旧实现用 0.6 压缩过明暗（为了让樱粉最暗处不发闷），那是**换源之前**的补偿；
//       换到 `leaves_original` 之后按要求改成精确保留。
//     * 树干 `giant_mangrove_log` 保持 `contrast = 0.6` **逐字节不变**（本次需求只针对树叶，
//       不顺手改动已验收的树皮观感）。
//   `contrast < 1` 会压平整张图的明暗（同一张源图上，0.6 时 Y 展布 30%、1.0 时 49%），只在需要时用。
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
//   默认写终态（assets/textures/procedural/，需再跑 `npm run atlas` 才进世界图集）；
//   `--staging` 写 assets/giant-trees/staging/，供「先看效果、确认后再替换」的预览流程：
//   预览通过后用 `cp` 拷进终态目录，再跑 `npm run atlas` + `npm run check`。
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

/** 明暗调制的亮度比下限（防最暗像素过黑）。本源图上不生效：最低亮度比 0.536 > 0.45。 */
const MIN_K = 0.45;

/**
 * 烘焙表。`src` 相对 assets/textures；`base` = 受光最亮那档叶面的目标 RGB；`contrast` = 明暗调制增益。
 *
 * 树叶基色的标定口径（2026-10-23 换源时重标）：
 *   ① **目标 = 输出可见像素均值 ≐ 现在的巨树叶色**（用户：「根据巨树叶方块的颜色取一个贴近的值」）
 *      —— 所以 base = 当前均值 ÷ `meanK`（本源图在 contrast=1 下的平均亮度比 = 0.878）。
 *   ② **零削顶**：最高亮度比 1.086 来自一个 alpha=0 的孔洞像素（opaque 通道照样渲染它）
 *      → 任一通道 `base × 1.086 > 255` 就会在那几个像素上顶到 255，把「最亮那档叶面」压平。
 *      而「保留表面像素深浅」正是本次需求 → 每个通道封顶在 `floor(255 / 1.086) = 234`。
 *      实测只有 birch 的 G（需 248）与 cherry 的 R（需 269）会碰到这条线，代价是输出均值
 *      分别低 13 / 31；其余三个通道完全命中当前均值（Δ=0）。
 *   ③ 树叶 `contrast = 1`：`k = Y/Y_ref` 是**纯亮度比**，输出与源图的明暗结构严格同构
 *      （烘焙会打印皮尔逊相关系数，实测 1.000；可见像素亮度序**零反转**）。
 *   ④ 树干 `giant_mangrove_log` 保持 `contrast = 0.6` **逐字节不变**（本次需求只针对树叶）。
 */
export const TEXTURES = Object.freeze([
  { name: 'giant_birch_leaves', src: 'leaves_original.png', base: [169, 234, 158], contrast: 1 },  // 白桦：浅绿（G 封顶）
  { name: 'giant_spruce_leaves', src: 'leaves_original.png', base: [36, 100, 64], contrast: 1 },   // 雪松：深绿
  { name: 'giant_cherry_leaves', src: 'leaves_original.png', base: [234, 148, 206], contrast: 1 }, // 樱花：粉红（R 封顶）
  { name: 'giant_palm_leaves', src: 'leaves_original.png', base: [48, 158, 58], contrast: 1 },     // 椰子：亮绿
  { name: 'giant_banyan_leaves', src: 'leaves_original.png', base: [90, 195, 79], contrast: 1 },   // 榕树：中绿
  // 红树干：沿用 bark 明暗结构（本次不动；contrast 与基色都保持旧值）
  { name: 'giant_mangrove_log', src: 'log_big_oak.png', base: [135, 65, 65], contrast: 0.6 },
]);

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 重着色：保留 alpha，RGB = base × k，`k = max(MIN_K, 1 + contrast × (Y / Y_ref − 1))`。返回新 PNG 与统计量。 */
export function recolor(src, base, contrast) {
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
  let holes = 0, sr = 0, sg = 0, sb = 0, nv = 0;
  const clipped = [0, 0, 0];
  const outY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = Math.max(MIN_K, 1 + contrast * (ys[i] / yRef - 1));
    for (let c = 0; c < 3; c++) {
      const v = Math.round(base[c] * k);
      if (v > 255) clipped[c]++;
      out.data[o + c] = Math.max(0, Math.min(255, v));
    }
    out.data[o + 3] = src.data[o + 3]; // alpha 逐字节保留
    outY[i] = luma(out.data[o], out.data[o + 1], out.data[o + 2]);
    if (src.data[o + 3] < HOLE_ALPHA) holes++;
    else { sr += out.data[o]; sg += out.data[o + 1]; sb += out.data[o + 2]; nv++; }
  }

  // 明暗结构保真度：源图亮度 vs 输出亮度的皮尔逊相关系数（contrast=1 时应为 1.000）
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  const meanOut = outY.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varY = 0, varOut = 0;
  for (let i = 0; i < n; i++) {
    const a = ys[i] - meanY, b = outY[i] - meanOut;
    cov += a * b; varY += a * a; varOut += b * b;
  }

  return {
    png: out,
    stats: {
      yRef, holes, visible: nv, clipped, meanVisible: [sr / nv, sg / nv, sb / nv],
      lumaCorr: cov / Math.sqrt(varY * varOut),
    },
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
    const { png, stats } = recolor(src, t.base, t.contrast);

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
      `源=${t.src} base=(${t.base.join(',')}) contrast=${t.contrast}  Y_ref=${stats.yRef.toFixed(1)}  ` +
      `镂空像素(alpha<${HOLE_ALPHA})=${stats.holes}/${src.width * src.height}  ` +
      `可见像素均值RGB=(${m})  明暗相关系数=${stats.lumaCorr.toFixed(3)}  ` +
      `通道饱和RGB=${stats.clipped.join('/')}`);
  }
}

// 仅在直接运行时执行（被 import 做单测/门禁时不烘焙）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
