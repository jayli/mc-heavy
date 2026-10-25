// tools/water-texture-fingerprint.mjs — 体素水贴图烘焙参数与指纹**共享模块**（红线 1）
//
// 两个消费者：
//   ① `tools/bake-water-textures.mjs`（`npm run water`）—— 按这些参数烘焙产物；
//   ② `tools/check-data.mjs` 的 `[水体贴图]` 环节 —— 用**同一份**参数重算指纹，
//      比对仓库里的产物是否过期。
//
// 两处各写一份清单/参数会漂移出「门禁说产物是最新的、实际渲染的是旧图」的静默过期
// （与 `icon-fingerprint.mjs` / `giant-trees-fingerprint.mjs` 同一手法）。
//
// ## 参数从哪来（不是拍脑袋）
//
// 2026-10-26 用户第三轮反馈：「水方块的颜色和这个水面的颜色差异有点大，让二者接近一些」。
// 对齐目标必须来自**海面平面的实测屏幕色**（`ocean.js`，noon / ACES exp=1.0）：
//   海面平面近处实测 `92/133/164` L127；体素水实测 `59/100/190` L98（差 85）。
// 由「体素水渲染 ≈ fwd(贴图均值 × alpha 混合)」反推 → 贴图均值取 `95/140/168` 时
// 体素水渲染落在 `100/140/162` L133，与平面的差降到 **17**（实测）。
//
// ⚠️ **改了 `src/render/ocean.js` 的水面配色就要重算这组目标** —— 否则两者又会分家。
// 反推口径：屏幕色 ↔ 贴图均值的关系是「sRGB → 线性 → ACES → sRGB」，见 `src/render/sun-shade.js`
// 的 `srgbEncode` / `acesFilmic`；alpha 混合还要算上 `WATER_OPACITY` 与水下背景。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 源素材（mc-lite 入库原图，**不改**）→ 产物落 `assets/textures/procedural/<name>.png` */
export const WATER_TEX_SOURCES = {
  water: 'water.png',
  swamp_water: 'swamp_water.png',
};

/**
 * 每张贴图的目标 RGB 均值（通道平移的落点）。
 *
 * `water`：对齐海面平面的实测屏幕色（见上）；`swamp_water` 沿用原图均值 —— 沼泽水是
 * **另一套配色**（浑浊绿褐），用户反馈针对的是普通海面，不要顺手把沼泽一起改蓝。
 *
 * 演进：v1.84 `95/140/168`（与当时的浅海蓝平面对齐）→ **v1.85 `70/115/155`**
 * （用户第四轮「水方块颜色太浅，要更蓝一些」+ 平面同时转深蓝 → 两者一起降）。
 * 实测（noon / ACES / 海岸机位）v1.85：平面近处 `76/122/166` vs 未被平面覆盖的远岸带
 * `75/125/164` → **逐通道差 6**（v1.84 是 17，再前一版 85）。
 */
export const WATER_TARGET_MEAN = {
  water: [70, 115, 155],
  swamp_water: [62, 120, 140],
};

/**
 * 每张贴图的目标 alpha（0~255）。`null` = 保留源图 alpha。
 *
 * **为什么需要它**（2026-10-26 用户第四轮反馈）：「远看的时候，没有被波纹水面覆盖到的地方
 * 几乎呈透明色了，还是要有水的颜色，不要那么清晰的看到海底」。
 * 源图 alpha 是 175（0.686）→ 体素水只有 68.6% 不透明，水下地形透上来 31% → 远看发白、
 * 海底清晰可见。这与 mc-lite 的口径也不同：它是 `mkMat('#205099', 0.6)` —— **纯色深蓝**
 * 而非带纹理的浅蓝，靠颜色本身压住海底。
 *
 * 提到 **230（0.90）**：既明显盖住海底（透上来降到 10%），又保留「水是半透明的」这一观感。
 * ⚠️ 不要提到 255：完全不透明会让水面变成一块蓝色板子，失去水面应有的通透感。
 * （v1.84 先用 220，用户第四轮仍反馈「远看几乎呈透明色、能清楚看到海底」→ v1.85 提到 230。）
 */
export const WATER_TARGET_ALPHA = {
  water: 230,
  swamp_water: null,
};

/** 产物路径（相对仓库根）；`faces-data.js` 必须指向这里 */
export const WATER_TEX_OUT = Object.fromEntries(
  Object.keys(WATER_TEX_SOURCES).map((n) => [n, `procedural/${n}`]),
);

/**
 * 烘焙输入的指纹：源图字节 + 目标均值 + 源文件名。
 * 改任一输入而忘了 `npm run water` → 指纹不符 → 门禁报「跑 npm run water」。
 * @returns {string} sha256 十六进制
 */
export function waterTextureFingerprint() {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const h = crypto.createHash('sha256');
  for (const [name, file] of Object.entries(WATER_TEX_SOURCES).sort()) {
    h.update(name);
    h.update(file);
    h.update(String(WATER_TARGET_MEAN[name]));
    h.update(String(WATER_TARGET_ALPHA[name]));
    const p = path.join(root, 'assets', 'textures', file);
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from('MISSING'));
  }
  return h.digest('hex');
}
