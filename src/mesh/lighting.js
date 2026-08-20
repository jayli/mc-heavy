// src/mesh/lighting.js — skylight top-down + blocklight flood fill（§4.6/DR-14）
// skylight：纯垂直逐列传播，无水平依赖；封闭洞穴正确，侧开口洞穴偏暗（接受）。
// blocklight：删除光源不做增量降光，全 column 区域重算兜底（§4.6 第一阶段口径）。
// Worker 同构：本文件不得 import three。
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

/**
 * skylight：从顶向下逐列传播，初始 15，遇 opaque 停止（该格及下方为 0）。
 * 只写 column.light 高 4 位（保留低 4 位 blocklight）。
 * 注意：WORLD_MAX_Y 是排他上界，循环从 WORLD_MAX_Y - 1 起（y ∈ [MIN_Y, MAX_Y)）。
 */
export function computeSkylightColumn(column, registry) {
  const opaque = registry.opaqueTable;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      let sky = 15;
      for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
        const idx = blockIndex(lx, y, lz);
        if (opaque[column.blocks[idx]] === 1) sky = 0;
        column.light[idx] = (column.light[idx] & 0x0F) | (sky << 4);
      }
    }
  }
}

/**
 * skylight 单列增量重算：只重算 (lx, lz) 这一根垂直列（O(128)）。
 * 用于单块编辑后的增量更新——skylight 纯垂直传播，单块编辑只影响同 (lx,lz) 列，
 * 不影响其他列（与 computeSkylightColumn 的全列口径完全一致，只是范围收窄）。
 */
export function recomputeSkylightAt(column, lx, lz, registry) {
  const opaque = registry.opaqueTable;
  let sky = 15;
  for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
    const idx = blockIndex(lx, y, lz);
    if (opaque[column.blocks[idx]] === 1) sky = 0;
    column.light[idx] = (column.light[idx] & 0x0F) | (sky << 4);
  }
}

/**
 * blocklight：region 内所有 emissive 源 flood fill（强度 -1/格，opaque 阻挡）。
 * region = 中心 column + 4 正交邻居（光泄漏过界，§4.6）；邻居缺失则截断。
 * 先清零 region 内低 4 位，再 BFS。
 */
export function computeBlocklightRegion(world, cx, cz, registry) {
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const cols = [];
  for (const [dx, dz] of offsets) {
    const col = world.getColumn(cx + dx, cz + dz);
    if (col) cols.push(col);
  }
  if (cols.length === 0) return;
  // 清零低 4 位
  for (const col of cols) {
    for (let i = 0; i < col.light.length; i++) col.light[i] &= 0xF0;
  }
  const emissive = registry.emissiveTable;
  const opaque = registry.opaqueTable;
  const setLight = (x, y, z, level) => {
    const cx2 = Math.floor(x / 16), cz2 = Math.floor(z / 16);
    const col = world.getColumn(cx2, cz2);
    if (!col) return false;
    const idx = blockIndex(x - cx2 * 16, y, z - cz2 * 16);
    if ((col.light[idx] & 0x0F) >= level) return false;
    col.light[idx] = (col.light[idx] & 0xF0) | level;
    return true;
  };
  /** BFS 队列元素：[worldX, y, worldZ, level] */
  const queue = [];
  for (const col of cols) {
    for (let i = 0; i < col.blocks.length; i++) {
      const e = emissive[col.blocks[i]];
      if (e > 0) {
        const lx = i & 15, lz = (i >> 4) & 15, y = WORLD_MIN_Y + (i >> 8);
        const wx = col.cx * 16 + lx, wz = col.cz * 16 + lz;
        setLight(wx, y, wz, e); // 光源自身格子写入强度
        queue.push([wx, y, wz, e]);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [x, y, z, level] = queue[head++];
    if (level <= 1) continue;
    const next = level - 1;
    const neighbors = [
      [x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of neighbors) {
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue; // MAX_Y 排他上界
      const ncx = Math.floor(nx / 16), ncz = Math.floor(nz / 16);
      const ncol = world.getColumn(ncx, ncz);
      if (!ncol) continue;
      const nidx = blockIndex(nx - ncx * 16, ny, nz - ncz * 16);
      if (opaque[ncol.blocks[nidx]] === 1) continue; // opaque 阻挡
      if (setLight(nx, ny, nz, next)) queue.push([nx, ny, nz, next]);
    }
  }
}

/**
 * 全量重算（GEN 完成 / 光源增删时调用）。
 * @returns {string[]} 受影响的 columnKey 列表（供调度器置脏重 mesh）
 */
export function recomputeLight(world, cx, cz, registry) {
  const col = world.getColumn(cx, cz);
  if (!col) return [];
  computeSkylightColumn(col, registry);
  computeBlocklightRegion(world, cx, cz, registry);
  const keys = new Set([`${cx},${cz}`]);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.getColumn(cx + dx, cz + dz)) keys.add(`${cx + dx},${cz + dz}`);
  }
  return [...keys];
}
