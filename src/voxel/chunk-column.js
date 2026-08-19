// src/voxel/chunk-column.js — ChunkColumn：世界数据基本单元（设计文档 §4.1）
// typed 数组为唯一权威；edits 稀疏层仅用于持久化与重放（DR-6/DR-17）。
// Worker 同构：本文件不得 import three。
import {
  WORLD_MIN_Y, WORLD_MAX_Y, BLOCKS_PER_COLUMN, SECTIONS_PER_COLUMN,
  blockIndex, sectionOf,
} from './constants.js';

export class ChunkColumn {
  /** @param {number} cx @param {number} cz */
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = new Uint16Array(BLOCKS_PER_COLUMN);
    this.meta = new Uint8Array(BLOCKS_PER_COLUMN);
    /** 高4位 skylight，低4位 blocklight（派生缓存，可重算，§4.6） */
    this.light = new Uint8Array(BLOCKS_PER_COLUMN);
    /** 玩家修改稀疏层：index → {id, meta}（持久化与重放用） */
    this.edits = new Map();
    /** 方块实体富状态预留（DR-17）：M1 恒空，形状定好不实现消费者 */
    this.blockEntities = new Map();
    /** 每次数据变更 +1，异步结果版本校验用（§4.9） */
    this.version = 0;
    /** 'empty'|'generating'|'ready' */
    this.state = 'empty';
    /** 脏 section 位图（0/1），meshing 调度消费 */
    this.dirtySections = new Uint8Array(SECTIONS_PER_COLUMN);
  }

  /** @returns {number} 方块 ID；y 越界返回 0（air） */
  get(lx, y, lz) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0; // MAX_Y 是 exclusive 上界（128 层 = y ∈ [-32,95]）
    return this.blocks[blockIndex(lx, y, lz)];
  }

  /** 写方块：blocks/meta + version + edits + 脏标记；y 越界静默忽略 */
  set(lx, y, lz, id, meta = 0) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const idx = blockIndex(lx, y, lz);
    this.blocks[idx] = id;
    this.meta[idx] = meta;
    this.version++;
    this.edits.set(idx, { id, meta });
    this.dirtySections[sectionOf(y)] = 1;
  }

  markDirty(sy) {
    if (sy >= 0 && sy < SECTIONS_PER_COLUMN) this.dirtySections[sy] = 1;
  }

  /** @returns {number[]} 脏 section 序号列表（取后清零） */
  takeDirty() {
    const out = [];
    for (let sy = 0; sy < SECTIONS_PER_COLUMN; sy++) {
      if (this.dirtySections[sy]) { out.push(sy); this.dirtySections[sy] = 0; }
    }
    return out;
  }

  /**
   * 重放 edits（GEN 完成接管 / 存档加载时调用）。
   * 不记入 this.edits（重放源就是 edits 本身），不 bump version。
   * @param {Array<{index: number, id: number, meta: number}>} editsArray
   */
  applyEdits(editsArray) {
    for (const e of editsArray) {
      this.blocks[e.index] = e.id;
      this.meta[e.index] = e.meta;
    }
  }
}
