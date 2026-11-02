// tools/night-sky-fingerprint.mjs — 夜空立方图的烘焙参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1：参数只有一份权威），沿用
// `tools/zombie-skin-fingerprint.mjs` / `tools/icon-fingerprint.mjs` 的既有模式：
//   - `tools/bake-night-sky.mjs` 烘焙时按本参数生成并写进 `assets/sky/night/night-sky.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run nightsky」
//
// 产物是**派生产物**，权威输入 = `assets/sky/night-src/` 的六张原图（mc-lite `skyBox1`）
// + 本文件的烘焙参数。改了任一者却忘跑烘焙，贴图会**静默过期**。
//
// node 侧模块（不进 src/，浏览器不消费）。

/** 立方图面序（与 `src/render/sky-config.js` 的 `SKY_FACE_FILES` 必须一致）。 */
export const NIGHT_SKY_FACES = Object.freeze([
  'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg',
]);

/** 产物指纹文件（相对仓库根）。烘焙脚本与 check:data 共用，避免两处各写一份。 */
export const NIGHT_SKY_FINGERPRINT_JSON = 'assets/sky/night/night-sky.json';

/** 单面边长（与白天 `assets/sky/day` 同尺寸） */
export const NIGHT_SKY_SIZE = 1024;

/**
 * 烘焙参数。
 *
 * ## 为什么要烘焙（v1.60）
 *
 * mc-lite `skyBox1` 的六面是**各自独立生成**的图：12 条共享边的平均 RMS 落差 **41.09**
 * （白天 `skyBox4` 只有 1.90，差 22 倍）。游戏里表现为天空被几条**笔直的暗线**切成方块
 * （用户 2026-10-21：「有明显的衔接边界，看上去就是一个有楞有角的盒子」）。
 *
 * ## 做法：方向空间加权重采样
 *
 * 对每个输出像素：像素 → 立方体方向 dir → 六个**源面**各自按 `dir` 反算 uv 并双线性采样
 * → 按「该 uv 离本面中心多近」加权平均。
 *   - 面中心处只有本面贡献 → 原图细节 100% 保留（实测高频能量 7.37 vs 原图 10.61）
 *   - 面边缘处两侧各贡献 50% → **边界两侧取到同一组加权值 → 接缝精确为零**（实测 RMS 0.02）
 *   - 权重是 uv 的连续函数，且 dir 在立方体几何上跨面连续 → 数学上无缝，不靠羽化糊
 *
 * 相比「程序化重新生成整套星云」：那个方案虽然也无缝，但**观感与原图差得远**
 * （实测偏暗偏糊：均值 [9.8,21.2,42.9] vs 原图 [17.7,35.7,60.3]，高频能量明显更低）。
 * 本方案保住原图的星云形态与配色（均值 [17.2,35.2,59.8]，几乎一致）。
 *
 * ⚠️ 所有字段都参与指纹：改任何一个都必须重跑 `npm run nightsky`。
 */
export const NIGHT_SKY_PARAMS = Object.freeze({
  /** 混合带宽度（以半面为 1 的越界量）。越大过渡越宽、细节越柔；0 = 不混合（保留原接缝） */
  blendPad: 0.35,
  /** 权重曲线的幂次：>1 让面中心区域更"纯"（细节更锐），边缘过渡更集中在边界处 */
  blendPower: 1.6,
  /** JPEG 编码质量 */
  jpegQuality: 0.92,
});

/**
 * 输入指纹 = 全部烘焙参数（与烘焙脚本读的东西一一对应）。
 *
 * 已知盲区（与 `icon-fingerprint.mjs` 同类）：改**烘焙算法**而不动参数时指纹不变 ——
 * 这类改动须靠 `tests/night-sky-seam.spec.mjs` 的无缝断言与 Tier 4 观感兜住。
 * 注意源图**不在**指纹里（它是不变的原始素材）；换源图须手改本文件以免指纹失效。
 */
export function nightSkyFingerprint() {
  const p = NIGHT_SKY_PARAMS;
  return [
    `size:${NIGHT_SKY_SIZE}`,
    `src:skyBox1`,
    `pad:${p.blendPad}`,
    `pw:${p.blendPower}`,
    `q:${p.jpegQuality}`,
  ].join(';');
}
