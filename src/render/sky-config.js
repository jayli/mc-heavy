// src/render/sky-config.js — 天空盒立方图清单（**three-free** 纯数据）
//
// 为什么单独成模块：`tools/check-data.mjs`（node）要 import 它做资源完整性门禁，
// 而 `sky.js` 要用同一份清单去 `CubeTextureLoader`（红线 1：清单只有一份权威）。
// 资源来源 = mc-lite `src/assets/skyBox4`（白天云）/ `skyBox1`（夜空星空）/ `skyBox2`（日落），
// 均原样复制、未重编码。
// ⚠️ `skyBox2` 曾经因「mc-lite 自身零引用」而不搬（`grep -rn skyBox2 src/` 只有目录本身）；
// v1.71 用户明确要求用它做「傍晚」风格 → 该判断已作废，现在它是一等资源。

/** CubeTextureLoader 的固定面序（+X, −X, +Y, −Y, +Z, −Z）。顺序是载荷性的，勿调整。 */
export const SKY_FACE_FILES = Object.freeze([
  'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg',
]);

/** 天空盒根目录（相对站点根；静态服务器不剥离 assets 前缀）。 */
export const SKY_DIR = 'assets/sky';

/**
 * 两/三套立方图：day = 白天云层（mc-lite skyBox4）、night = 星空（mc-lite skyBox1）、
 * dusk = 日落（mc-lite skyBox2，v1.71 启用）。
 *
 * ⚠️ `dusk` 是**手动风格专用**：`DayNight` 用独立的 `uDuskBlend` 把它叠在最上层，
 * 自动日夜循环全程 `uDuskBlend = 0`（否则日夜会在某个时段突然变出日落贴图）。
 *
 * 接缝已实测（Tier 4 口径，同 `tests/night-sky-seam.spec.mjs`）：12 条共享边 RMS 均值 0.59 /
 * 面内噪声底 0.33 → 比值 **1.80**，与用户认可的白天基准 1.765 同量级 ⇒ 无需重烘焙。
 *
 * `rainy` = 阴雨天空：**纯天空背景**，不画地面/建筑/树 —— 那些由引擎渲染，
 * 画进贴图会与真实世界重影。同口径接缝实测 0.89 / 面内噪声底 0.703 → 比值 **1.265**，
 * 优于白天基准 1.765。当前仅资源入库与清单登记，**尚未接入日夜混合**。
 *
 * `normal` = 「普通」风格专用（v3.44，ASHLAR 光影移植）：**离线烘焙**上游大气散射
 * 公式的结果（`tools/bake-normal-sky.mjs`）。上游天空是程序化 LUT + 体积云，
 * **没有贴图文件可搬** ⇒ 只能把公式在 Node 里求值后烘成同规格的六面立方图。
 * 烘焙 = 数据格式转换，不产生新美术资源。同样是**纯天空背景**（天底半给中性地面色，
 * 不画地形）—— 上游 `skyColor(rd)` 在 rd.y<0 时另画「远处海面」，那部分不能搬进贴图。
 * ⚠️ `normal` 也是**手动风格专用**：`DayNight` 用独立的 `uNormalBlend` 叠在最上层，
 * 自动日夜循环全程 `uNormalBlend = 0`（与 dusk 同款不变式，单测钉死）。
 */
export const SKY_SETS = Object.freeze({
  day: `${SKY_DIR}/day`,
  night: `${SKY_DIR}/night`,
  dusk: `${SKY_DIR}/dusk`,
  rainy: `${SKY_DIR}/rainy`,
  normal: `${SKY_DIR}/normal`,
});
