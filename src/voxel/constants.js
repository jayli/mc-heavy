// src/voxel/constants.js — 世界几何常量（设计文档 §4.1，DR-8）
// Worker 同构：本文件不得 import three。

export const WORLD_MIN_Y = -32;
export const WORLD_MAX_Y = 96;
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y; // 128
export const COLUMN_SIZE = 16;
export const SECTION_SIZE = 16;
export const SECTIONS_PER_COLUMN = WORLD_HEIGHT / SECTION_SIZE; // 8
export const SEA_Y = -2; // 与 mc-lite 坐标兼容（海平面）
export const BLOCKS_PER_COLUMN = COLUMN_SIZE * COLUMN_SIZE * WORLD_HEIGHT; // 32768
export const BLOCKS_PER_SECTION = COLUMN_SIZE * COLUMN_SIZE * SECTION_SIZE; // 4096

/** column 内局部坐标 → typed array 索引（lx/lz ∈ [0,16)） */
export function blockIndex(lx, y, lz) {
  return lx + lz * COLUMN_SIZE + (y - WORLD_MIN_Y) * COLUMN_SIZE * COLUMN_SIZE;
}

/** 世界 y → section 序号（0..7）；越界调用方自行处理 */
export function sectionOf(y) {
  return (y - WORLD_MIN_Y) >> 4;
}

export function columnKey(cx, cz) {
  return cx + ',' + cz;
}
