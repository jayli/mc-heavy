// src/voxel/rain-occlusion-data.js — 雨的逐点遮挡：**编码与索引的唯一权威**（three-free）
//
// 三个消费方共用这一份常量与判据（红线 1）：
//   · render/rain-shelter-map.js   —— CPU 扫描后按本文件编码写字节
//   · render/wet-surface.js        —— TSL 片元按本文件解码 + 格顶判据
//   · render/wet-surface-config.js —— CPU 同构纯函数（单测与 GPU 逐位同构）
//
// ⚠️ 本文件属 Worker 同构层（红线 8/10）：**不得 import three、不得碰 DOM**。
import { WORLD_MIN_Y } from './constants.js';

/** 遮挡窗口边长（格列数）。512 ⇒ ±256 格；512×512×4 = 1 MiB */
export const SHELTER_MAP_SIZE = 512;

/** 窗口每边多少个 column（16 格一个 column）⇒ 32×32 = 1024 column */
export const SHELTER_WINDOW_COLS = SHELTER_MAP_SIZE / 16;

/**
 * 高度编码基准。取 `WORLD_MIN_Y - 1`（= −33）而不是 `WORLD_MIN_Y`：
 * 这样「世界底那一格的顶面」（y = WORLD_MIN_Y + 1）编码为 4 > 0，
 * **0 才能当「未知 / 无截停面」的哨兵**。
 * ⚠️ 用 WORLD_MIN_Y 当基准会把 stopY=0 编成 0 ⇒ 与哨兵撞车（实测 470/4000 处误判 null）。
 */
export const SHELTER_Y_BASE = WORLD_MIN_Y - 1;

/**
 * 比较容差（半格的 1/256）。
 *
 * f32 往返实测：133 个合法编码经 `Float32Array(enc/255)` 再 `×127.5` 解出，
 * 全部比真值**偏大** 0 ~ 3.78e-6，无一偏小。格顶判据本身已把「共面」排除在遮挡之外，
 * EPS 只是不给将来（编码分辨率提高 / 基准变化）留翻判陷阱。
 * ⚠️ CPU 与 GPU 必须读同一个 EPS。
 */
export const SHELTER_EPS = 1 / 512;

/**
 * 截停面高度 → R 通道编码（半格分辨率，水面 = y + 0.5 需要它）。
 * @param {number|null} y 截停面世界 y；null = 无截停面
 * @returns {number} 0 = 哨兵（未知/无截停）；否则 ∈ [4, 136]
 */
export function encodeStopY(y) {
  if (y === null || y === undefined) return 0;
  return Math.round((y - SHELTER_Y_BASE) * 2);
}

/**
 * R 通道编码 → 截停面高度。
 * @param {number} enc
 * @returns {number|null} 0 ⇒ null（未知）
 */
export function decodeStopY(enc) {
  if (enc <= 0) return null;
  return enc / 2 + SHELTER_Y_BASE;
}

/**
 * 世界格坐标 → texel 序号（字节偏移 = ×4）。
 *
 * ⚠️⚠️ **绝对索引，不接窗口原点**：
 * 相对索引 `(floor(x) - originX) & 511` 会让原点一动**整窗 262144 个 texel 全部失效**
 * （texel 5 从「绝对 x=5」变成「绝对 x=21」）—— 那根本不是环形缓冲。
 * 绝对索引下 texel 永远装同一个绝对格列（模 512）⇒ 真正的环形窗口，
 * 且 GPU 侧**不需要原点 uniform**。
 *
 * ⚠️ 负坐标：JS 的 `&` 走二进制补码 ⇒ `-1 & 511 = 511`，
 * 与 GPU 侧 `int(floor(x)).bitAnd(511)` 逐位同构（**先 int 再位与**，
 * 先 uint 会把负 float 转成未定义值）。
 *
 * @param {number} x @param {number} z 世界坐标（可带小数，内部 floor）
 * @returns {number} texel 序号 ∈ [0, 262143]
 */
export function shelterTexelIndex(x, z) {
  const mask = SHELTER_MAP_SIZE - 1;
  return (Math.floor(x) & mask) + ((Math.floor(z) & mask) << 9);
}