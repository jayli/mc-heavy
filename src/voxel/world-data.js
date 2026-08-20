// src/voxel/world-data.js — WorldData：column 索引 + 跨柱读路径 + halo 视图（§4.1/§4.3）
// Worker 同构：本文件不得 import three。
import {
  WORLD_MIN_Y, WORLD_MAX_Y, blockIndex, columnKey,
} from './constants.js';
import { recomputeSkylightAt } from '../mesh/lighting.js';

const VIEW = 18; // section halo 视图边长（16 + 2×1）

export class WorldData {
  /** @param {ReturnType<import('./block-registry.js').createRegistry>} registry */
  constructor(registry) {
    this.registry = registry;
    /** @type {Map<string, import('./chunk-column.js').ChunkColumn>} */
    this.columns = new Map();
  }

  getColumn(cx, cz) { return this.columns.get(columnKey(cx, cz)); }
  hasColumn(cx, cz) { return this.columns.has(columnKey(cx, cz)); }
  add(column) { this.columns.set(columnKey(column.cx, column.cz), column); }
  remove(key) { this.columns.delete(key); }

  /**
   * O(1) 读方块。column 缺失或 y 越上界 → 0（air）；y 低于世界底 → bedrock（防穿底）。
   */
  getBlockId(x, y, z) {
    if (y < WORLD_MIN_Y) return this.registry.idOf('bedrock');
    if (y >= WORLD_MAX_Y) return 0; // MAX_Y exclusive 上界
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return 0;
    return col.blocks[blockIndex(x - cx * 16, y, z - cz * 16)];
  }

  isSolid(x, y, z) { return this.registry.solidTable[this.getBlockId(x, y, z)] === 1; }
  isOpaque(x, y, z) { return this.registry.opaqueTable[this.getBlockId(x, y, z)] === 1; }

  /**
   * 唯一写入口（§4.5.3）。跨 column 定位；返回受影响 section 列表
   * （本 section + 贴边时相邻 column 的边界 section——AO/面剔除最坏范围）。
   * @returns {{column: import('./chunk-column.js').ChunkColumn, index: number, sy: number,
   *            affected: Array<{cx: number, cz: number, sy: number}>} | null} column 缺失返回 null
   */
  setBlock(x, y, z, id, meta = 0) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return null;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return null;
    const lx = x - cx * 16, lz = z - cz * 16;
    col.set(lx, y, lz, id, meta);
    // 光照收敛（§4.6）：skylight 纯垂直传播，单块编辑只影响同 (lx,lz) 垂直列，
    // 增量重算 O(128)。不重算则新暴露面读到旧 light=0 → 全黑（挖块黑面 bug）。
    // blocklight 增量删除放后续阶段（M1 快捷栏无发光方块，正常游玩不触发 region 重算）。
    recomputeSkylightAt(col, lx, lz, this.registry);
    const sy = (y - WORLD_MIN_Y) >> 4;
    const affected = [{ cx, cz, sy }];
    const yInSection = y - WORLD_MIN_Y - sy * 16;
    // 贴边 → 相邻 column 的边界 section 置脏（面剔除依赖）
    if (lx === 0) affected.push({ cx: cx - 1, cz, sy });
    if (lx === 15) affected.push({ cx: cx + 1, cz, sy });
    if (lz === 0) affected.push({ cx, cz: cz - 1, sy });
    if (lz === 15) affected.push({ cx, cz: cz + 1, sy });
    // 贴 section 上下边 → 本 column 相邻 section（AO 对角影响走精修路径，§4.5.3）
    if (yInSection === 0 && sy > 0) affected.push({ cx, cz, sy: sy - 1 });
    if (yInSection === 15 && sy < 7) affected.push({ cx, cz, sy: sy + 1 });
    return { column: col, index: blockIndex(lx, y, lz), sy, affected };
  }

  /**
   * section halo 视图：18×18×18（中心 section + 1 格 halo），跨 column/section 拼接。
   * 任一水平邻居 column 缺失 → missing=true（缺失方向按 air 填充，调用方决策保守出块，§4.3）。
   * @returns {{data: Uint16Array, light: Uint8Array, missing: boolean}}
   */
  getSectionView(cx, sy, cz) {
    const data = new Uint16Array(VIEW * VIEW * VIEW);
    const light = new Uint8Array(VIEW * VIEW * VIEW);
    let missing = false;
    const baseY = WORLD_MIN_Y + sy * 16 - 1; // halo 起点世界 y
    for (let dy = 0; dy < VIEW; dy++) {
      const wy = baseY + dy;
      if (wy < WORLD_MIN_Y || wy > WORLD_MAX_Y) continue; // 上下 halo 越界保持 air
      for (let dz = 0; dz < VIEW; dz++) {
        const wz = cz * 16 + dz - 1;
        const ncz = Math.floor(wz / 16);
        for (let dx = 0; dx < VIEW; dx++) {
          const wx = cx * 16 + dx - 1;
          const ncx = Math.floor(wx / 16);
          const col = this.columns.get(columnKey(ncx, ncz));
          if (!col) {
            if (ncx !== cx || ncz !== cz) missing = true;
            continue;
          }
          const idx = blockIndex(wx - ncx * 16, wy, wz - ncz * 16);
          const vi = dx + dz * VIEW + dy * VIEW * VIEW;
          data[vi] = col.blocks[idx];
          light[vi] = col.light[idx];
        }
      }
    }
    return { data, light, missing };
  }
}
