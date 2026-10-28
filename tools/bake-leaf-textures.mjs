// tools/bake-leaf-textures.mjs — 普通树叶的孔洞压缩烘焙（`npm run leaftextures`）
//
// ## 为什么需要它
//
// 2026-10-23 用户裁定：普通树叶的渲染口径对齐巨树（`cutout` 通道 + `opaqueTable=1`），
// 并要求「贴图的镂空密度改得跟巨树一样，让树叶看起来密一些」。
//
// 巨树叶的孔洞率是 14.8%（`bake-giant-textures.mjs` 的 `holeRatio`），而普通树叶的源图孔洞率是
// 23%~**77.6%**（`oak_leaves_branch_medium` 最严重，叶面只剩 22.4%）→ 观感「太稀」。
// 本脚本把它们统一压到 `LEAF_HOLE_RATIO`（14.8%）。
//
// **例外**：两张杜鹃贴图用 `LEAF_HOLE_RATIO_AZALEA`（8%）—— 同「孔洞率」下它们的孔洞块更大
// （最大 4px vs 普通树 2px），而杜鹃树冠幅 8~13 远大于普通树 5×5 → 大孔透天空、镂空感强烈
// （用户 2026-10-28 报告）。降到 8% 后最大孔块与普通树叶同档（2px）。
//
// ## 做法
//
// **只改 alpha，RGB 逐字节保留** —— 与巨树那次不同（巨树要重着色，普通树叶不需要，保持原色）。
// 孔洞压缩逻辑与巨树**共用同一份** `tools/leaf-holes.mjs`（红线 1）。
//
// ## 为什么要落进 procedural/ 而不是原地改
//
// `assets/textures/*.png` 是 mc-lite 的**入库源素材**，原地改会丢源、且 atlas 计数断言会漂。
// 产物写 `assets/textures/procedural/leaf_<name>.png`，`faces-data.js` 指向它；
// 源图保持不动，任何时候都能重新烘焙。
//
// ## 确定性
//
// 同输入同参数 → 逐字节相同的 PNG（pngjs 编码是确定性的；R2 序列无随机数）。
//
// 用法：node tools/bake-leaf-textures.mjs [--only name1,name2]
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAF_HOLE_RATIO, LEAF_HOLE_RATIO_AZALEA, compactLeafHoles, applyAlpha, leafHoleStats } from './leaf-holes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const OUT_DIR = path.join(TEX_DIR, 'procedural');

/**
 * 烘焙表：普通树叶用到的源 tile → 产物名。
 *
 * ⚠️ **只列需要压缩的**。`procedural/sky_leaves` 已经是 100% 叶面覆盖（mc-lite 材质是无 alphaTest 的纯粉，
 * 本就无镂空），不在本表内 —— `faces-data.js` 继续指向原 tile。
 *
 * ⚠️ `leaves_yellow` 同时被 `yellow_leaves` 与 `realistic_yellow_leaves` 引用 → 只烘焙一次、两个方块共用。
 * `leaves` 同时被 `leaves` 与 `swamp_leaves` 引用 → 同理。**不要按方块名烘 8 份**（会产生重复 tile）。
 */
export const LEAF_TEXTURES = Object.freeze([
  { src: 'leaves', out: 'leaf_leaves' },                                  // leaves / swamp_leaves
  { src: 'leaves_yellow', out: 'leaf_leaves_yellow' },                    // yellow_leaves / realistic_yellow_leaves
  // 杜鹃两项用**独立的 8% 孔洞率**（不是 15%）—— 理由见 `leaf-holes.mjs` 的
  // `LEAF_HOLE_RATIO_AZALEA` 注释：同一个「孔洞率」在杜鹃贴图上孔洞块更大（最大 4px vs 普通树 2px），
  // 而杜鹃树冠幅 8~13（普通树 5×5）→ 大孔直接透到天空，观感「镂空感太强烈」（用户 2026-10-28 报告）。
  { src: 'azalea_leaves', out: 'leaf_azalea_leaves', ratio: LEAF_HOLE_RATIO_AZALEA },   // azalea_leaves
  // ⚠️ `azalea_flowers` 之前**漏了**这张（`faces-data.js` 直接指向未压缩的原图 `flowering_azalea_leaves`
  // → 孔洞率 19.9%，比叶方块还稀）。带花的叶与纯叶必须同档，否则同一棵树上有两种稀疏度。
  { src: 'flowering_azalea_leaves', out: 'leaf_azalea_flowers', ratio: LEAF_HOLE_RATIO_AZALEA }, // azalea_flowers
  { src: 'oak_leaves_branch_medium', out: 'leaf_oak_leaves_branch_medium' }, // realistic_oak_leaves（32×32，源孔洞 77.6%）
  { src: 'leaves_with_snow', out: 'leaf_leaves_with_snow' },              // snow_leaves 的 5 个侧面
]);

function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const t of LEAF_TEXTURES) {
    if (only && !only.has(t.src)) continue;
    const srcPath = path.join(TEX_DIR, `${t.src}.png`);
    if (!fs.existsSync(srcPath)) throw new Error(`源图缺失：${srcPath}`);
    const src = PNG.sync.read(fs.readFileSync(srcPath));
    const before = leafHoleStats(src);
    const { alpha, holeCount } = compactLeafHoles(src, t.ratio ?? LEAF_HOLE_RATIO);
    const out = applyAlpha(src, alpha);

    // 自检 ①：alpha 必须是 0/255 二值（压缩后不存在半透明像素）
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a !== 0 && a !== 255) throw new Error(`${t.out}: alpha 应为 0/255 二值，像素 ${i / 4} 为 ${a}`);
    }
    // 自检 ②：孔洞数必须等于预期
    const after = leafHoleStats(out);
    if (after.holes !== holeCount) throw new Error(`${t.out}: 孔洞数 ${after.holes} ≠ 预期 ${holeCount}`);
    // 自检 ③：RGB 必须与源图逐字节相同（本脚本只动 alpha）
    for (let i = 0; i < out.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        if (out.data[i + c] !== src.data[i + c]) throw new Error(`${t.out}: RGB 被改了（像素 ${i / 4} 通道 ${c}）—— 本脚本只应改 alpha`);
      }
    }

    const dst = path.join(OUT_DIR, `${t.out}.png`);
    fs.writeFileSync(dst, PNG.sync.write(out));
    console.log(`${t.out}: ${path.relative(ROOT, dst)}  ${src.width}×${src.height}  ` +
      `源=${t.src}  孔洞 ${before.holes}/${before.total}（${(before.ratio * 100).toFixed(1)}%）` +
      ` → ${after.holes}/${after.total}（${(after.ratio * 100).toFixed(1)}%）  ` +
      `叶面覆盖 ${((1 - before.ratio) * 100).toFixed(1)}% → ${((1 - after.ratio) * 100).toFixed(1)}%` +
      (t.ratio ? `  [独立孔洞率 ${t.ratio}]` : ''));
  }
}

// 仅在直接运行时执行（被 import 做门禁时不烘焙）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
