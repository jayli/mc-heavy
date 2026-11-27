// tools/normal-sky-fingerprint.mjs — 「普通」天空立方图的烘焙参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1：参数只有一份权威），沿用
// `tools/night-sky-fingerprint.mjs` 的既有模式：
//   - `tools/bake-normal-sky.mjs` 烘焙时按本参数生成并写进 `assets/sky/normal/normal-sky.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run normalsky」
//
// ## 烘焙 = 数据格式转换，不产生新美术资源
//
// 输入是**上游 ASHLAR 的大气散射公式**（纯数值），输出是与既有四套同规格的六张立方图面。
// 上游天空是程序化 LUT + raymarch 体积云，**没有贴图文件可搬**
// （整个 generation 目录只有 8 张截图 PNG）⇒ 只能把公式在 Node 里求值后烘成贴图。
//
// node 侧模块（不进 src/，浏览器不消费）。

/** 立方图面序（与 `src/render/sky-config.js` 的 `SKY_FACE_FILES` 必须一致）。 */
export const NORMAL_SKY_FACES = Object.freeze([
  'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg',
]);

/** 产物指纹文件（相对仓库根）。烘焙脚本与 check:data 共用。 */
export const NORMAL_SKY_FINGERPRINT_JSON = 'assets/sky/normal/normal-sky.json';

/** 单面边长（与既有四套同尺寸）。 */
export const NORMAL_SKY_SIZE = 1024;

/**
 * 烘焙参数。
 *
 * ## 为什么固定一个时刻
 *
 * 「普通」是**手动风格**，不参与日夜轮转（用户 2026-11-27 裁定）⇒ 天空是静态的。
 * `hour` 取上游 `Sky.update(hours)` 的时刻口径，与 `VISUAL_STYLES.normal.sunDirection`
 * **必须同源**（那边写的是 h=8.5 的原值）—— 否则贴图里的太阳位置与地面影子方向对不上。
 *
 * ## 曝光为什么要单独给
 *
 * 大气辐射是 HDR：实测上半球 max **1.689**（太阳附近）、p95 1.100。
 * 8bit JPEG 削顶扫描：exp 0.50 → 0%、0.65 → 0.13%、0.80 → 0.94%、1.00 → **4.88%**。
 * ⇒ 取 0.55（削顶 0%，且暗部 p5 仍有 ~53 的层次）。
 *
 * ⚠️ 这个 exposure 是**烘焙曝光**（把 HDR 压进 8bit），与运行时的
 * `VISUAL_STYLES.normal.toneMappingExposure`（2.2，AgX 前的曝光）是**两个不同的量**，勿混。
 *
 * ## 天底半为什么给中性地面色
 *
 * 上游 `skyColor(rd)` 在 `rd.y < 0` 时另画「远处海面」（`sea = skyRadiance*fres + ...`）。
 * 纯大气在天底方向辐射≈0（实测 sRGB 11,18,29）⇒ 直接烘全方向会得到近黑的下半。
 * 用户红线：天空盒**只画天空**，地面景物由引擎渲染 ⇒ 天底半给中性地面色，
 * 取「地平线色 × groundFactor」（与雾色/背景天空共用同一份数据口径）。
 *
 * ⚠️ 所有字段都参与指纹：改任何一个都必须重跑 `npm run normalsky`。
 */
export const NORMAL_SKY_PARAMS = Object.freeze({
  /** 上游时刻（与 VISUAL_STYLES.normal.sunDirection 同源，h=8.5） */
  hour: 8.5,
  /** 烘焙曝光（HDR → 8bit，见上方削顶扫描） */
  bakeExposure: 0.55,
  /**
   * 日轮角半径（弧度）—— 上游 `23_glsl_lighting.js` 的 `const float SR = 0.0105`。
   *
   * ⚠️ **为什么必须烘进贴图**：既有 `day` 立方图自带太阳光晕，所以四风格的
   * `sunVisible` 全是 false（再画一个 sprite 会变成两个太阳）。本档若只有大气散射
   * 而无日轮，玩家会看到「影子有方向但天上没太阳」—— 比观感偏差更糟。
   * 故沿用同一口径：日轮烘进贴图、`sunVisible` 保持 false。
   */
  sunAngularRadius: 0.0105,
  /**
   * 日轮峰值辐射（上游 `uSunDisc = transmittance × 820 × vis`）。
   * 它远高于天空背景（~1）⇒ 经烘焙曝光后必然削顶成白盘，
   * 那是对的（真实太阳就是个白盘）；削顶面积应极小（立体角 ~π×0.0105²）。
   */
  sunDiscGain: 820.0,
  /** 太阳辐照强度（上游 `U.uSunIllum` 原值 13.0） */
  sunIllum: 13.0,
  /** 观察点海拔（上游 skyPass 的 uAlt，单位 km；地面视角取 0.12） */
  altitude: 0.12,
  /** 天底半的中性地面色相对地平线色的比例 */
  groundFactor: 0.5,
  /** 上半球↔天底半的过渡带宽（以 dir.y 计，避免地平线处出现硬边） */
  groundBlend: 0.06,
  /** JPEG 编码质量（与夜空同档） */
  jpegQuality: 0.92,
  /** 透射率 LUT 尺寸（上游 transRT 256×64） */
  transW: 256,
  transH: 64,
  /** 多重散射 LUT 尺寸（上游 msRT 32×32） */
  msSize: 32,

  // ---------------------------------------------------------------- 体积云（v3.48）

  /**
   * 烘焙期色调映射的曝光（**与 `bakeExposure` 不是一回事**）。
   *
   * v3.47 用线性 `×bakeExposure(0.55) → srgbEncode`，那个口径对**纯渐变天空**有效
   * （上半球 max 1.689，削顶 0%）。但加了体积云之后：
   * - 云的线性亮度是天空的 21~50 倍 ⇒ 线性路线必然削顶成 255 死白（实测 lum 251）；
   * - 且真实 `skyRadiance` **跨 9 倍**（地平 1.21 → 天顶 0.137），不是平坦的一个值。
   *
   * ⇒ 改用 AgX+punch（与运行时 `ASLAR_TONE_MAPPING` 同一曲线）。
   *
   * ## 这个值怎么定的（⚠️ 上一轮踩过的坑）
   *
   * 第一次标定时探针里用了一个**乘过 bakeExposure 的假值** `[0.59,0.71,0.73]`
   * 当作天空，真实值其实跨 0.14~1.21 ⇒ 定出的 E=0.25 把天空压成 17~69 灰阶，
   * 烘出来的图黑得像黄昏（已实测确认）。
   * ⇒ **必须用真实 `skyRadiance` 标定。**

   * 用真实天空扫描后的 8bit（地平 10° / 25° / 40° / 天顶 85°）：
   *
   * | E | 10° | 25° | 40° | 85° |
   * |---|---|---|---|---|
   * | 2 | 156 | 139 | 115 | 50 |
   * | **3.5** | **183** | **169** | **149** | **77** |
   * | 6 | 215 | 204 | 185 | 113 |
   *
   * 取 **3.5**：地平足够亮、天顶仍保有梯度、云的高光还有可达余量。
   */
  bakeTonemapExposure: 3.5,
  /**
   * 云的直射亮度缩放（**不是**上游参数，是天空盒尺度下的标定值）。
   *
   * 上游 `G_CLOUD_FRAG` 里云的直射项是：
   *   `sunC × sun(三 lobe 相位和) × 7.2 × powder`
   * 其中 `sunC = uLightColor ≈ [11.6, 10.0, 8.0]`（透射率 × 辐照 13）。
   * 实测相位和在 `cosT=0.5` 时 0.194，在 `cosT=1`（正对太阳）时 **2.24**
   * ⇒ 直射项跨 **10 ~ 187**。
   *
   * 上游能容下它：整条管线是 HDR + bloom + AgX。天空盒是 **8bit 静态图**，容纳不了 ——
   * 实测 `E=0.25` 时云 251/254（几乎无层次）。
   *
   * ## 为什么调这个而不是接着降曝光
   *
   * 同一张图上还有天空背景（线性 0.69）。若把曝光降到能容下 187 的程度，
   * 天空会掉到个位数灰阶（实测 E=0.05 时天空只有 4）—— 两头不可兼得。
   * ⇒ 必须缩小**云自身**的绝对量级，而不是缩整张图。
   *
   * ## 取值依据
   *
   * 云的色调由「直射 : 环境」的比例决定（那是物理的，不能改）；
   * 只缩整体量级，让云的峰值落在 sky ≈ 0.69 的同一量级（云本来就是反射天空与阳光）。
   * 实测扫描确定取值，写进指纹 —— 改它必须重跑 `npm run normalsky`。
   */
  cloudGain: 0.15,
  /**
   * 云的「平均覆盖率」（上游 `uCloudCover`）。
   *
   * ⚠️ **这个数的含义已被校准过，勿按字面再次「修正」**：
   * 上游 `cloudWeather()` 把它映射成 `smoothstep(1-cover-0.2, 1-cover+0.26, n)`。
   * 实测该式在**整个上半球**上的输出均值只有 **0.284**（不是 0.35）——
   * 因为 smoothstep 的两端都不饱和，均值被两端拖低。
   *
   * 另有一个容易搞混的量：「`cov > 0` 的像素占比」= **55.6%**（含极淡的云）。
   * 它才是「有多少像素带一点云」，不是覆盖率。勿把它当覆盖率报。
   *
   * 用户 2026-11-27 裁定「照搬上游 0.35」⇒ 保留原值，阈值区间**不动**。
   */
  cloudCover: 0.35,
  /**
   * 云的密度倍率（上游 `uCloudDensity`，默认 1.0）。
   *
   * ⚠️ 上游默认 1.0 在**世界坐标 + 玩家视点**下成立；天空盒要铺满整个上半球，
   * 实测单点密度 0.73~0.76、且 `SIG=0.085` ⇒ 一旦有云就是实心白块，
   * 会把地平线渐变糊死。用户 2026-11-27 裁定降到 0.3。
   */
  cloudDensity: 0.3,
  /** march 步数上限（用户 2026-11-27 裁定 64；上游 ultra 档为 80） */
  cloudSteps: 64,
  /** 云的可见距离上限（上游 `uMaxDist = 6500`），超出部分淡出 */
  cloudMaxDist: 6500,
  /**
   * 烘焙用的相机高度（米）。
   *
   * 它决定云在天空中的视在大小与地平线附近被压缩的程度：
   * `t = (CB - camY) / sin(elev)`。取玩家典型眼高量级。
   * ⚠️ 这个值不参与运行时；只影响贴图里的云长什么样。
   */
  cloudCamY: 12,
  /** 地面反照率（给云底的 `ambBot` 用；上游从 `uBounce` 取） */
  cloudGroundAlbedo: [0.13, 0.12, 0.07],
});

/**
 * 输入指纹 = 全部烘焙参数（与烘焙脚本读的东西一一对应）。
 *
 * 已知盲区（与 `night-sky-fingerprint.mjs` 同类）：改**烘焙算法**而不动参数时指纹不变
 * ⇒ 这类改动须靠 `tests/normal-style.spec.mjs` 的接缝与内容断言兜住。
 */
export function normalSkyFingerprint() {
  const p = NORMAL_SKY_PARAMS;
  return [
    `size:${NORMAL_SKY_SIZE}`,
    'src:ashlar-atmosphere',
    `h:${p.hour}`,
    `exp:${p.bakeExposure}`,
    `sr:${p.sunAngularRadius}`,
    `sd:${p.sunDiscGain}`,
    `sun:${p.sunIllum}`,
    `alt:${p.altitude}`,
    `gnd:${p.groundFactor}`,
    `gb:${p.groundBlend}`,
    `q:${p.jpegQuality}`,
    `tmap:${p.bakeTonemapExposure}`,
    `trans:${p.transW}x${p.transH}`,
    `ms:${p.msSize}`,
    // 体积云（v3.48）——改任一个都必须重跑 npm run normalsky
    `cov:${p.cloudCover}`,
    `cgain:${p.cloudGain}`,
    `cdens:${p.cloudDensity}`,
    `csteps:${p.cloudSteps}`,
    `cmax:${p.cloudMaxDist}`,
    `ccamy:${p.cloudCamY}`,
    `cgalb:${p.cloudGroundAlbedo.join(',')}`,
  ].join(';');
}