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
    /** 玩家修改稀疏层：index → {id, meta, blockEntity?}（持久化与重放用） */
    this.edits = new Map();
    /**
     * 方块实体富状态（DR-17，M7 落地首个消费者 = 丧尸巢穴锚点）：index → 富状态对象。
     * **不是第二份方块真相**（红线 1）—— 它只承载 typed 数组装不下的富状态（锚点 id /
     * origin / lastSpawnAt），方块本体仍唯一在 `blocks`。且它必须与 `edits` 同步写：
     * 持久化的载体是 edits entry 上的 `blockEntity` 字段，两处漂移则重启后 anchor 丢失。
     */
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

  /**
   * 写方块：blocks/meta + version + edits + 脏标记；y 越界静默忽略。
   *
   * `blockEntity` 语义（M7 DR-17 落地）：**默认清除该格旧 entity**，只有同一 change 显式给出
   * 新 entity 才保留。这是巢穴失效的唯一语义来源 —— 徒手挖掉关键方块、M4 武器破坏、未来
   * TNT 批量编辑走的是同一条写入路径，故三者必然同义（M7 规格 §1）。
   * 若反过来「不带参数时保留旧 entity」，破坏关键方块后 anchor 会残留 → 巢穴永不失效。
   * @param {number} lx @param {number} y @param {number} lz @param {number} id
   * @param {number} [meta] @param {Object|null} [blockEntity] undefined/null = 清除
   */
  set(lx, y, lz, id, meta = 0, blockEntity = undefined) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const idx = blockIndex(lx, y, lz);
    this.blocks[idx] = id;
    this.meta[idx] = meta;
    this.version++;
    const entry = { id, meta };
    if (blockEntity !== undefined && blockEntity !== null) {
      entry.blockEntity = blockEntity;
      this.blockEntities.set(idx, blockEntity);
    } else {
      this.blockEntities.delete(idx);
    }
    this.edits.set(idx, entry);
    this.dirtySections[sectionOf(y)] = 1;
  }

  /**
   * 只写该格的 blockEntity（M7）：不动 blocks/meta、**不 bump version**、不置脏。
   *
   * 为什么必须不 bump version：纯 entity 写不改变任何渲染输入，bump 会让在途 MESH/GEN
   * 回包被版本校验丢弃 → 白白重跑一轮（§4.9 版本协议）。也不置脏 section —— 否则
   * 每次巢穴刷怪写回 `lastSpawnAt` 都触发一次无意义的 REMESH。
   * 但仍记入 `this.edits`：edits 是持久化的唯一来源（DR-6），漏记则重启后 anchor 丢失。
   * @param {number} lx @param {number} y @param {number} lz @param {Object|null} value
   */
  setBlockEntity(lx, y, lz, value) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return;
    const idx = blockIndex(lx, y, lz);
    if (value !== undefined && value !== null) this.blockEntities.set(idx, value);
    else this.blockEntities.delete(idx);
    const entry = this.edits.get(idx);
    if (entry) {
      // 原地改同一 entry 对象：edits 的 index→entry 映射是唯一权威，不得复制第二份（红线 1）
      if (value !== undefined && value !== null) entry.blockEntity = value;
      else delete entry.blockEntity;
    } else if (value !== undefined && value !== null) {
      // 该格从未被编辑过、却要写 entity（纯 entity 写在一个未修改的方块上）：需建 entry 才能落盘。
      // id/meta 取当前 typed 数组值 —— 它们就是权威，不是副本。
      this.edits.set(idx, { id: this.blocks[idx], meta: this.meta[idx], blockEntity: value });
    }
    // value=null 且无 entry：无需建 edit 行（该格本就未被修改，无东西要删）
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
   * 无状态重放：只写 typed blocks/meta，不碰 `this.edits` / `blockEntities`。
   * **仅供 Worker GEN 用**（`world-worker.js`）—— 那边 edits 是下发参数，column 随后整包
   * 回传 typed buffer，主线程接管时才重建状态（见 `restoreEdits`）。
   * @param {Array<{index: number, id: number, meta: number}>} editsArray
   */
  applyEdits(editsArray) {
    for (const e of editsArray) {
      this.blocks[e.index] = e.id;
      this.meta[e.index] = e.meta;
    }
  }

  /**
   * **有状态**重放（主线程 GEN 接管时调用）：blocks/meta + `blockEntities` + `edits` Map
   * 三者一起重建，不 bump version、不置脏。
   *
   * 为什么必须重建 `edits` Map —— 这是 M7 修掉的真实数据丢失 bug：
   * `Scheduler._onGenResult` 新建 column 时只搬 typed buffer。若 `edits` Map 留空，
   * 玩家在该 column 新放一个方块后 `Persistence.flushNow()` 会用「只含新编辑」的 Map
   * 整行 `put` 覆盖该 columnKey 的存档 → **旧 anchor edit 静默丢失**（巢穴失效但方块还在，
   * 肉眼看不出差别）。重建 `edits` 后 flush 写回的是完整稀疏层。
   *
   * 与 `applyEdits` 的分工（红线 1：不留第二份权威）：`applyEdits` 是无状态版本，
   * 只在 Worker 内使用；主线程接管一律走本方法。
   * @param {Array<{index: number, id: number, meta: number, blockEntity?: Object}>} editsArray
   */
  restoreEdits(editsArray) {
    for (const e of editsArray) {
      this.blocks[e.index] = e.id;
      this.meta[e.index] = e.meta;
      const entry = { id: e.id, meta: e.meta };
      if (e.blockEntity !== undefined && e.blockEntity !== null) {
        entry.blockEntity = e.blockEntity;
        this.blockEntities.set(e.index, e.blockEntity);
      }
      this.edits.set(e.index, entry);
    }
  }
}
