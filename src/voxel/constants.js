// src/voxel/constants.js — 世界几何常量（设计文档 §4.1，DR-8）
// Worker 同构：本文件不得 import three。

export const WORLD_MIN_Y = -32;
export const WORLD_MAX_Y = 96;
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y; // 128
export const COLUMN_SIZE = 16;
export const SECTION_SIZE = 16;
export const SECTIONS_PER_COLUMN = WORLD_HEIGHT / SECTION_SIZE; // 8
export const SEA_Y = -2; // 与 mc-lite 坐标兼容（海平面）
/**
 * 暴露水面的顶面下沉量（格）—— mesher 把水格顶边顶点下压这么多，
 * 让体素水面与海面平面（`SEA_Y + 0.5`）严格共面，消除俯视可见的蓝色顶面模。
 *
 * ⚠️ **方块逻辑/物理仍占整格**，只有渲染几何下沉。
 * ⚠️ v3.30g 从 `mesh/mesher.js` 的模块私有常量**提级到这里**：
 * `render/water-surface.js` 要按同一口径算水面高度（雨丝截停 / 水花落点 /
 * 落叶与湿地面反光的水下门），两处各写一份 0.5 会漂移出「雨停在半格空气里」。
 */
export const WATER_SURFACE_SINK = 0.5;
export const BLOCKS_PER_COLUMN = COLUMN_SIZE * COLUMN_SIZE * WORLD_HEIGHT; // 32768
export const BLOCKS_PER_SECTION = COLUMN_SIZE * COLUMN_SIZE * SECTION_SIZE; // 4096

/** column 内局部坐标 → typed array 索引（lx/lz ∈ [0,16)） */
export function blockIndex(lx, y, lz) {
  return lx + lz * COLUMN_SIZE + (y - WORLD_MIN_Y) * COLUMN_SIZE * COLUMN_SIZE;
}

/**
 * `blockIndex` 的逆：typed array 索引 → `{lx, y, lz}`。
 *
 * 为什么与 `blockIndex` 放在一起：进度包导出/导入要把坐标与索引互相换算，**编码与其逆写两处
 * 就会漂移**（一处用错列宽 → 方块整体错位，方块层面完全看不出来是哪里的问题）。
 * 调用方须保证 index 来自合法坐标（本函数不做范围校验）。
 */
export function decodeBlockIndex(index) {
  const perLayer = COLUMN_SIZE * COLUMN_SIZE; // 256 = 一层的格数
  const lz = Math.floor(index / COLUMN_SIZE) % COLUMN_SIZE;
  const lx = index % COLUMN_SIZE;
  const y = Math.floor(index / perLayer) + WORLD_MIN_Y;
  return { lx, y, lz };
}

/** 世界 y → section 序号（0..7）；越界调用方自行处理 */
export function sectionOf(y) {
  return (y - WORLD_MIN_Y) >> 4;
}

export function columnKey(cx, cz) {
  return cx + ',' + cz;
}

/**
 * 世界坐标 → 所属 column key（几何推导的唯一权威）。
 *
 * 为什么放在这里而不是各消费者自己算：实体运行时的派生 column 索引
 * （`src/entities/entity-manager.js`）与持久 snapshot 的 column 归属
 * （`src/save/persistence.js` 的 `entitiesForColumn`）必须用**同一个**判据 ——
 * 两份 `Math.floor(pos/16)` 会漂移，漂移的后果是 snapshot 归到错的 column、
 * 恢复时永远等不到（红线 1：同一事实只有一份权威）。
 */
export function columnKeyAt(x, z) {
  return columnKey(Math.floor(x / COLUMN_SIZE), Math.floor(z / COLUMN_SIZE));
}
