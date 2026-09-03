// src/player/orientation.js — M3.2 方块朝向放置语义（设计文档 §4.3，v1.17 定稿）
// 照搬 mc-lite `PlayerInteraction.js:413 getPlacementOrientation` + `OrientationUtils.js`。
// 纯函数模块：无 DOM、无 three，Worker 同构（§4.3 红线 8）。
//
// 关键语义（勿照印象实现）：放置朝向**不看玩家 yaw**——mc-lite 的签名里没有朝向参数。
// 转身不改朝向；玩家要转 90° 的手感是「原位挖掉再放回去」，即下方分支 ②。
//
// 门控复用 `registry.orientationModesTable[id]`（>0 即启用朝向），不新增字段、不改 blocks-data。
// mc-lite 侧同名门控叫 `orientationEnabled`（`BlockData.js` 默认 true），两侧 true 集合零差异
// （实测 40 项；mc-heavy 126 方块中 86 项不参与旋转，mc-lite 124 方块中 84 项）。

/**
 * 方块朝向枚举（mc-lite `OrientationUtils.BlockOrientation`）：水平面四方向。
 * 0=EAST 是默认朝向，也是「不参与旋转」的方块恒定值。
 */
export const BlockOrientation = {
  EAST: 0,   // 朝东（默认，0°）
  SOUTH: 1,  // 朝南（90°）
  WEST: 2,   // 朝西（180°）
  NORTH: 3,  // 朝北（270°）
};

/**
 * 顺时针旋转 90° 后的下一个朝向（mc-lite `nextOrientation`）。
 * `(current || 0) + 1` 的 `||` 语义原样保留：null/undefined 回落 EAST。
 * @param {number} current 当前朝向 0-3
 * @returns {number} 下一个朝向 0-3
 */
export function nextOrientation(current) {
  return ((current || 0) + 1) % 4;
}

/**
 * 记录挖掉的方块（mc-lite `recordRemovedBlock`）——原位重放时的旋转依据。
 * @param {number} x @param {number} y @param {number} z
 * @param {number} id 方块 ID（mc-lite 用 name，本仓库世界权威是数字 ID）
 * @param {number} orientation 挖前从 `world.getBlockMeta()` 读出的旧朝向
 * @returns {{x: number, y: number, z: number, id: number, orientation: number}}
 */
export function recordRemovedBlock(x, y, z, id, orientation) {
  return { x, y, z, id, orientation };
}

/**
 * 放置朝向三分支（mc-lite `getPlacementOrientation`，分支顺序不得调整）。
 *
 * ① `orientationModes[id] === 0`     → 恒 0（不参与旋转的方块，也不写记忆）
 * ② lastRemovedBlock 且 x/y/z/id 四者全等 → `nextOrientation(旧朝向)`，并写入类型记忆
 * ③ `memory.has(id)`                 → 沿用该类型的上次朝向（跨位置）
 * ④ 否则                             → 0（EAST）
 *
 * 唯一副作用是 `memory.set()`（分支 ②）；不改写 lastRemovedBlock、不触碰世界数据。
 * @param {number} x @param {number} y @param {number} z 放置坐标
 * @param {number} id 方块 ID
 * @param {Uint8Array} orientationModesTable 门控表（`registry.orientationModesTable`）
 * @param {{x:number,y:number,z:number,id:number,orientation:number}|null} lastRemovedBlock
 * @param {Map<number, number>} memory 类型记忆（`player.placementOrientationMemory`）
 * @returns {number} 朝向 0-3
 */
export function getPlacementOrientation(x, y, z, id, orientationModesTable, lastRemovedBlock, memory) {
  // 分支 ①：门控关闭 → 恒 EAST（优先于原位重转与记忆）
  if (!orientationModesTable[id]) return BlockOrientation.EAST;

  // 分支 ②：原位重建同类型（x/y/z/id 四者全等）→ 顺时针旋转并更新记忆
  if (lastRemovedBlock &&
      lastRemovedBlock.x === x &&
      lastRemovedBlock.y === y &&
      lastRemovedBlock.z === z &&
      lastRemovedBlock.id === id) {
    const rotated = nextOrientation(lastRemovedBlock.orientation);
    memory.set(id, rotated);
    return rotated;
  }

  // 分支 ③：有类型记忆 → 沿用（用 has 而非 get 判空，记忆值 0 也算有记忆）
  if (memory.has(id)) return memory.get(id);

  // 分支 ④：无记忆 → 默认 EAST
  return BlockOrientation.EAST;
}
