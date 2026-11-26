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
    `trans:${p.transW}x${p.transH}`,
    `ms:${p.msSize}`,
  ].join(';');
}