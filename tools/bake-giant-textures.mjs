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
 * 默认孔洞密度（树叶）：alphaTest 0.3 下被剔除的像素占比。
 *
 * **为什么需要这个旋钮（2026-10-23 用户反馈）**：巨树叶走 cutout 通道后，源图原样的
 * 孔洞密度（13/256 = 5.1%）在观感上远超普通树 —— 普通树叶因为树小、背景天然近，
 * 不容易察觉；巨树树冠巨大且 `opaqueTable=1` 不画叶背内面，孔洞后面往往是空的，
 * 看起来就“太稀”。用户要求「给巨树叶单独做一张更密的镂空图（孔洞更小），观感更茂盛，
 * 几何完全不变」。
 *
 * 做法：从源图**已被 alphaTest 剔除的那批像素**（alpha<77，共 80 个）里按**低差异序列**选前 N 个作孔洞
 * （alpha 归 0），其余像素 alpha 抬到 255。两个设计点：
 *   ① **只在源图的孔洞集合里选** —— 不是在叶面上随机挖洞，所以保留的孔洞位置仍符合原图的叶片脉络；
 *   ② **低差异序列（R2）而非「alpha 最小优先」** —— 后者实测会把孔洞聚成一块
 *      （前 8 个全落在左上角），而 R2 能把它们铺开到 14/16 行，观感才是「疏密有致」而不是「边上缺一块」。
 *
 * 取值 0.15（= 38/256）：源图是 31%（80/256）—— 降到不足一半，叶面覆盖率 68.8% → 85.2%。
 * 试过 0.03（8 个）与 0.08（20 个）：前者几乎无孔洞（像实心彩色塑料），后者孔洞太零散。
 * ⚠️ 改这个值会改变渲染观感，但**几何/顶点数完全不变**（只是 alpha 二值化得更密）。
 */
const DEFAULT_HOLE_RATIO = 0.15;

/**
 * 压缩孔洞：从源图「会被 alphaTest 剔除」的像素（alpha < HOLE_ALPHA）里
 * 按低差异序列（R2）选前 `ratio×像素数` 个作孔洞（alpha 归 0），其余全部抬到 255。
 * 返回新的 alpha 数组（长度 = 像素数）与孔洞数。
 * 源图孔洞不够 `ratio` 所需时，用全部源孔洞（不额外挖叶面）。
 */
export function compactHoles(src, ratio) {
  const n = src.width * src.height;
  const srcHoles = [];
  for (let i = 0; i < n; i++) if (src.data[i * 4 + 3] < HOLE_ALPHA) srcHoles.push(i);
  // R2 低差异序列：给每个源孔洞一个「空间铺开」的优先级（确定性，不依赖随机数）
  const frac = (v) => v - Math.floor(v);
  const prio = (i) => {
    const x = i % src.width, y = Math.floor(i / src.width);
    return frac(x * 0.7548776662466927 + y * 0.5698402909980532);
  };
  const ranked = [...srcHoles].sort((a, b) => prio(a) - prio(b) || a - b);
  const holeCount = Math.max(0, Math.min(srcHoles.length, Math.round(n * ratio)));
  const alpha = new Uint8Array(n).fill(255);
  for (let k = 0; k < holeCount; k++) alpha[ranked[k]] = 0;
  return { alpha, holeCount };
}

/**
 * 烘焙表。`src` 相对 assets/textures；`base` = 受光最亮那档叶面的目标 RGB；`contrast` = 明暗调制增益。
 *
 * 树叶基色的标定口径（2026-10-23 换源时重标）：
 *   ① **目标 = 输出可见像素均值 ≐ 现在的巨树叶色**（用户：「根据巨树叶方块的颜色取一个贴近的值」）
 *      —— 所以 base = 当前均值 ÷ `meanK`（本源图在 contrast=1 下的平均亮度比 = 0.878）。
 *   ② **削顶取舍（2026-10-23 用户裁定：鲜艳度优先）**：最高亮度比 1.086 来自一个源孔洞像素
 *      → 任一通道 `base × 1.086 > 255` 就会在那几个像素上顶到 255，把「最亮那档叶面」压平。
 *      原方案为了零削顶，把每个通道封顶在 `floor(255 / 1.086) = 234`。**实测后果**：只有 cherry 的 R
 *      （需 269）与 birch 的 G（需 248）碰到该线，而 cherry 的 R=234 使贴图均值 R 从 236 降到 205
 *      （−13%），用户实玩反馈「粉叶颜色变暗了、不如原来鲜艳」→ **cherry R 改回 255**。
 *      代价：最亮那档粉叶像素 R 削顶（少一点层次），换来整体鲜艳度 —— 用户明确选这个取舍。
 *      birch 的 G 保持 234（用户未反馈白桦观感问题，不无谓改动）。
 *   ③ 树叶 `contrast = 1`：`k = Y/Y_ref` 是**纯亮度比**，输出与源图的明暗结构严格同构
 *      （烘焙会打印皮尔逊相关系数，实测 1.000；可见像素亮度序**零反转**）。
 *   ④ 树干 `giant_mangrove_log` 保持 `contrast = 0.6` **逐字节不变**（本次需求只针对树叶）。
 */
export const TEXTURES = Object.freeze([
  // ⚠️ giant_oak_leaves 必须**独立烘焙**，不能复用普通树叶的 `leaves` tile：
  //   两者共用同一张图就无法给巨树单独做更密的孔洞图案。基色沿用普通橡树叶的实测均值（RGB 28,109,47）。
  { name: 'giant_oak_leaves', src: 'leaves_original.png', base: [32, 124, 54], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO },
  { name: 'giant_birch_leaves', src: 'leaves_original.png', base: [169, 234, 158], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO },  // 白桦：浅绿（G 封顶）
  { name: 'giant_spruce_leaves', src: 'leaves_original.png', base: [36, 100, 64], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO },   // 雪松：深绿
  { name: 'giant_cherry_leaves', src: 'leaves_original.png', base: [255, 148, 206], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO }, // 樱花：粉红（R 提到 255 保鲜艳度，见下）
  { name: 'giant_palm_leaves', src: 'leaves_original.png', base: [48, 158, 58], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO },     // 椰子：亮绿
  { name: 'giant_banyan_leaves', src: 'leaves_original.png', base: [90, 195, 79], contrast: 1, holeRatio: DEFAULT_HOLE_RATIO },   // 榕树：中绿
  // 红树干：沿用 bark 明暗结构（不动；contrast 与基色都保持旧值）。树干没有镂空概念 → 不传 holeRatio
  { name: 'giant_mangrove_log', src: 'log_big_oak.png', base: [135, 65, 65], contrast: 0.6 },
]);

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * 重着色：保留/替换 alpha，RGB = base × k，`k = max(MIN_K, 1 + contrast × (Y / Y_ref − 1))`。
 * @param {object} src 源 PNG
 * @param {number[]} base 受光最亮那档叶面的目标 RGB
 * @param {number} contrast 明暗调制增益
 * @param {Uint8Array} [alphaIn] 外部指定的 alpha（长度 = 像素数）；缺省 = 逐字节沿用源图。
 *   传了它则「可见像素」集合按它算 Y_ref，且输出的 alpha 就是它（与 RGB 基准同源）。
 */
export function recolor(src, base, contrast, alphaIn) {
  const n = src.width * src.height;
  const alphaOf = (i) => (alphaIn ? alphaIn[i] : src.data[i * 4 + 3]);
  const ys = new Float64Array(n);
  const visibleYs = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    ys[i] = luma(src.data[o], src.data[o + 1], src.data[o + 2]);
    if (alphaOf(i) >= HOLE_ALPHA) visibleYs.push(ys[i]);
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
    out.data[o + 3] = alphaOf(i);
    outY[i] = luma(out.data[o], out.data[o + 1], out.data[o + 2]);
    if (alphaOf(i) < HOLE_ALPHA) holes++;
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
    // 孔洞压缩：按源 alpha 升序取前 N 个作孔洞，其余抬到 255（只有树叶传 holeRatio）
    const compacted = t.holeRatio !== undefined ? compactHoles(src, t.holeRatio) : null;
    const { png, stats } = recolor(src, t.base, t.contrast, compacted?.alpha);

    // 自检：输出 alpha 必须符合预期（无 holeRatio = 与源图逐字节相同；有 = 只有 0/255 两种值）
    if (compacted) {
      for (let i = 0; i < png.data.length; i += 4) {
        const a = png.data[i + 3];
        if (a !== 0 && a !== 255) throw new Error(`${t.name}: alpha 应为 0/255 二值，像素 ${i / 4} 为 ${a}`);
      }
      if (compacted.holeCount !== stats.holes) throw new Error(`${t.name}: 孔洞数 ${stats.holes} ≠ 预期 ${compacted.holeCount}`);
    } else {
      for (let i = 3; i < src.data.length; i += 4) {
        if (png.data[i] !== src.data[i]) throw new Error(`${t.name}: alpha 与源图不一致（像素 ${(i - 3) / 4}）`);
      }
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
    const holeNote = compacted
      ? `孔洞率=${t.holeRatio}（${stats.holes}/${src.width * src.height}，源图 ${src.width * src.height - stats.visible}）`
      : `孔洞像素(alpha<${HOLE_ALPHA})=${stats.holes}/${src.width * src.height}`;
    console.log(`${t.name}: ${path.relative(ROOT, dst)}  ${src.width}×${src.height}  ` +
      `源=${t.src} base=(${t.base.join(',')}) contrast=${t.contrast}  Y_ref=${stats.yRef.toFixed(1)}  ` +
      `${holeNote}  ` +
      `可见像素均值RGB=(${m})  明暗相关系数=${stats.lumaCorr.toFixed(3)}  ` +
      `通道饱和RGB=${stats.clipped.join('/')}`);
  }
}

// 仅在直接运行时执行（被 import 做单测/门禁时不烘焙）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
