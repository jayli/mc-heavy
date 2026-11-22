// src/render/rain-shelter.js — 雨的**遮挡与高度规则**（three-free，可 Tier 1 单测）
//
// 用户 2026-11-22 裁定（本轮唯一新增约束）：
//   「如果是室内场景，这个雨的特效就不要生效了，雨要被房屋的屋顶拦住，
//     但不要被树叶、云彩、空岛所拦住，雨特效生效的高度不应该高于云朵。」
//
// ## 三条规则的实现口径
//
// ① **屋顶拦雨**：从雨幕上界往下扫，遇到「挡雨方块」就停在它的顶面。
//    挡雨判据 = `solid && cullMode ∈ {opaque, transparent}` —— 即**实心且非镂空**。
//    房屋屋顶（石砖/木板/台阶/玻璃）全部命中；玻璃也算屋顶（室内不该下雨）。
// ② **树叶/云/空岛不拦**：
//    · 树叶族 = `cullMode === 'cutout'`（镂空通道）⇒ 排除；
//    · 云 = `cloud`（有 `supportsPlayer:true` 且 `shadowCast:false` 的实心块）⇒ 排除；
//    · 空岛 = 岛体本身是石头/泥土（会挡雨），但**岛在云上**（底 Y ∈ [40,70]）
//      ⇒ 被规则③的高度上界整体排除，不需要单独识别岛体方块。
// ③ **高度上界 = 最低云层之下**：雨幕上界钳到 `CLOUD_CLUSTER_Y - 1`（= 34）。
//    云簇在 Y=35、单云层在 Y=55 ⇒ 雨永远在云之下，云与空岛都不参与遮挡扫描。
//
// ⚠️⚠️ **为什么不能直接用 `world.isSolid`**（既有 `rain.js` 的做法）：
// 那会把**树叶与云**都当成屋顶。v1.96 起 `cloud.solid = true`（云不可穿越），
// 而树叶族也是 `solid:true` ⇒ 既有雨效在树下/云上会停住。用户明确要求这三种不拦。
//
// ⚠️ **判据走 registry 的表而不是名字白名单**（红线 1）：新增方块只要按既有口径声明
// （屋顶类 = opaque/transparent 实心；树叶类 = cutout）就自动纳入，不需要改本文件。
// 唯一的例外是 `cloud` —— 它按声明是 opaque 实心，必须显式排除（它是「云」不是「屋顶」）。
//
// 本文件不 import three（Node 单测直接构造 registry + 假 world 即可断言）。
import { WORLD_MIN_Y } from '../voxel/constants.js';
import { CLOUD_CLUSTER_Y } from '../gen/structures/sky-structures.js';

/**
 * 雨幕的**绝对高度上界**（世界 y，开区间上界）。
 *
 * = 最低云层（云簇 Y=35）之下一格 ⇒ **34**。
 * ⚠️ 派生自 `CLOUD_CLUSTER_Y`（唯一权威在 gen/structures/sky-structures.js）——
 * 写死 34 会在云层高度改动时静默漂移（雨跑到云上面去）。
 */
export const RAIN_CEILING_Y = CLOUD_CLUSTER_Y - 1;

/**
 * 该方块是否**挡雨**（屋顶语义）。
 *
 * 判据三条（全部读 registry 的表，不写名字白名单）：
 *   ① `solidTable[id] === 1`（实心）；
 *   ② `cullTable[id] !== 1`（**非 cutout**）⇒ 排除全部树叶族与花草；
 *   ③ `id !== cloudId`（云不挡雨，尽管它 solid=true）。
 *
 * ⚠️ **transparent 通道算挡雨**：玻璃屋顶下的室内不该下雨（用户「室内不生效」）。
 * ⚠️ **水不挡雨**：`water.solid = false` ⇒ 第一条就排除（雨落进水里是对的）。
 *
 * @param {number} id
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function blocksRain(id, registry) {
  if (!Number.isInteger(id) || id <= 0) return false;
  if (registry.solidTable[id] !== 1) return false;
  // cullMode: opaque 0 / cutout 1 / transparent 2 / none 3
  if (registry.cullTable[id] === 1) return false;      // 树叶族 / 花草：镂空，不挡
  if (id === registry.idOf('cloud')) return false;      // 云：显式排除
  return true;
}

/**
 * 从 `fromY` 往下找**挡雨面**的顶面 y（雨滴/水花的落点）。
 *
 * ⚠️ **扫描上界钳到 `RAIN_CEILING_Y`**：云与空岛都在它之上 ⇒ 整体不参与。
 * ⚠️ **下界钳到 `WORLD_MIN_Y`**：`WorldData.getBlockId` 对 y < MIN_Y 返回 bedrock
 * （防穿底）⇒ 未加载列全 air 时扫描会一直命中世界底 ⇒ 雨停在 −32（本仓已记的教训）。
 * ⚠️ **x/z 必须取整**：`getBlockId` 用 `blockIndex(x - cx*16, …)`，小数坐标会算出
 * 小数数组下标 ⇒ undefined ⇒ 全读成 air（玩家坐标恒带 .5）。
 *
 * @param {{getBlockId:(x:number,y:number,z:number)=>number}} world
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 * @param {number} x @param {number} z
 * @param {number} fromY 扫描起点（会被钳到雨幕上界）
 * @param {number} [searchDepth=48] 最多往下扫几格
 * @returns {number|null} 挡雨面顶面 y；扫不到返回 null（调用方回落到默认循环底）
 */
export function rainShelterY(world, registry, x, z, fromY, searchDepth = 48) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const start = Math.min(Math.floor(fromY), RAIN_CEILING_Y);
  const end = Math.max(WORLD_MIN_Y, start - searchDepth);
  for (let y = start; y >= end; y--) {
    if (blocksRain(world.getBlockId(ix, y, iz), registry)) return y + 1;
  }
  return null;
}

/**
 * 该点是否**在室内**（头顶有挡雨面）—— 雨丝/水花/湿地面的门控判据。
 *
 * ⚠️ **判据是「头顶有屋顶」而不是「四周有墙」**：用户要的是「雨被屋顶拦住」，
 * 一个只有顶棚没有墙的凉亭同样不该下雨。反之，四面墙但没顶（天井）应该下雨。
 * ⚠️ **从玩家头顶往上扫**（不是往下）：室内判据问的是「我上方有没有盖」。
 *
 * @param {{getBlockId:Function}} world
 * @param {object} registry
 * @param {number} x @param {number} y @param {number} z 玩家眼睛/脚底位置
 * @param {number} [headroom=24] 往上最多扫几格（够覆盖任何建筑层高）
 * @returns {boolean}
 */
export function isUnderRoof(world, registry, x, y, z, headroom = 24) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const start = Math.floor(y) + 1;
  const end = Math.min(Math.floor(y) + headroom, RAIN_CEILING_Y);
  for (let yy = start; yy <= end; yy++) {
    if (blocksRain(world.getBlockId(ix, yy, iz), registry)) return true;
  }
  return false;
}

/**
 * 雨滴的出生高度（钳在雨幕上界之下）。
 *
 * 上游 `Rain` 的雨丝在一个绕相机的盒子里循环（`uBox`），盒顶可能高于云层。
 * 本仓把**整个盒子**钳到 `RAIN_CEILING_Y` 之下：盒心 y = min(玩家 y, 上界 − 半高)。
 *
 * @param {number} playerY
 * @param {number} boxHeight 雨幕盒的竖直边长（格）
 * @returns {number} 盒心 y
 */
export function rainBoxCenterY(playerY, boxHeight) {
  const half = boxHeight / 2;
  return Math.min(playerY, RAIN_CEILING_Y - half);
}