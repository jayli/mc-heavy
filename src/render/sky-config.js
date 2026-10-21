// src/render/sky-config.js — 天空盒立方图清单（**three-free** 纯数据）
//
// 为什么单独成模块：`tools/check-data.mjs`（node）要 import 它做资源完整性门禁，
// 而 `sky.js` 要用同一份清单去 `CubeTextureLoader`（红线 1：清单只有一份权威）。
// 资源来源 = mc-lite `src/assets/skyBox4`（白天云）/ `skyBox1`（夜空星空），原样复制、未重编码。
//
// ⚠️ `skyBox2`（日落，356K）**不搬** —— mc-lite 自身零引用（`grep -rn skyBox2 src/` 只有目录本身）。

/** CubeTextureLoader 的固定面序（+X, −X, +Y, −Y, +Z, −Z）。顺序是载荷性的，勿调整。 */
export const SKY_FACE_FILES = Object.freeze([
  'posx.jpg', 'negx.jpg', 'posy.jpg', 'negy.jpg', 'posz.jpg', 'negz.jpg',
]);

/** 天空盒根目录（相对站点根；静态服务器不剥离 assets 前缀）。 */
export const SKY_DIR = 'assets/sky';

/** 两套立方图：day = 白天云层（mc-lite skyBox4），night = 星空（mc-lite skyBox1）。 */
export const SKY_SETS = Object.freeze({
  day: `${SKY_DIR}/day`,
  night: `${SKY_DIR}/night`,
});
