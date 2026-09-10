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

  /**
   * O(1) 读方块元数据（朝向等，§4.3）。column 缺失或 y 越界 → 0。
   * M3.2 交付：挖块存朝向记忆需读旧 meta；M4 plan Task 2 亦计划新增同名方法，口径一致
   * （提前交付，M4 改为验证已存在 + 补断言）。
   */
  getBlockMeta(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return 0;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return 0;
    return col.meta[blockIndex(x - cx * 16, y, z - cz * 16)];
  }

  /**
   * O(1) 读方块实体富状态（M7 DR-17）：巢穴锚点的持久真相。
   * column 缺失或 y 越界 → null（与 `getBlockId`/`getBlockMeta` 同一越界口径）。
   * @returns {Object|null}
   */
  getBlockEntity(x, y, z) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return null;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return null;
    return col.blockEntities.get(blockIndex(x - cx * 16, y, z - cz * 16)) || null;
  }

  /**
   * 一次换算读出该格的 id / meta / blockEntity（M7 性能修正）。
   *
   * 为什么需要它：`getBlockId` / `getBlockMeta` / `getBlockEntity` 各自都会重算
   * cx/cz/columnKey/Map.get/blockIndex —— 编辑热路径要同时读这三项，逐个调等于把同一换算
   * 做三遍。实测后果：bench 场景 ④（批量删 500 块）frameP95 9→10（回退 11.1%，门禁阻断）。
   * 本方法只做一次换算，语义与三个 getter 完全等价（越界口径同源：缺 column / y 越界 → 无）。
   *
   * **不要**把它退化成「分别调三个 getter」—— 那正是被门禁抓到的回退。
   * @returns {{column: import('./chunk-column.js').ChunkColumn|null, index: number,
   *            id: number, meta: number, blockEntity: Object|null}}
   */
  readCell(x, y, z) {
    // y 越下界与 `getBlockId` 同口径返回 bedrock（防穿底语义）。编辑路径调用前都已做过
    // y 越界检查（此处不可达），但公开接口必须与三个 getter **完全等价**，不留陷阱。
    if (y < WORLD_MIN_Y) return { column: null, index: -1, id: this.registry.idOf('bedrock'), meta: 0, blockEntity: null };
    if (y >= WORLD_MAX_Y) return { column: null, index: -1, id: 0, meta: 0, blockEntity: null };
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const column = this.columns.get(columnKey(cx, cz));
    if (!column) return { column: null, index: -1, id: 0, meta: 0, blockEntity: null };
    const index = blockIndex(x - cx * 16, y, z - cz * 16);
    return {
      column, index,
      id: column.blocks[index],
      meta: column.meta[index],
      blockEntity: column.blockEntities.get(index) || null,
    };
  }

  isSolid(x, y, z) { return this.registry.solidTable[this.getBlockId(x, y, z)] === 1; }
  isOpaque(x, y, z) { return this.registry.opaqueTable[this.getBlockId(x, y, z)] === 1; }
  /** 向下 Y 支撑（M2-7）：云可站立；物理仅在 Y 轴向下碰撞时查询 */
  supportsPlayer(x, y, z) { return this.registry.supportsPlayerTable[this.getBlockId(x, y, z)] === 1; }

  /**
   * 单格编辑的受影响 section 列表（本 section + 贴边时相邻 column 的边界 section
   * ——AO/面剔除最坏范围 + 贴 section 上下边时本 column 相邻 section）。
   * setBlock 与 setBlocks 共用，避免两种编辑在 section 边界的脏标记不同（M4-0）。
   */
  _affectedFor(cx, cz, lx, y, lz) {
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
    return affected;
  }

  /**
   * 唯一写入口（§4.5.3）。跨 column 定位；返回受影响 section 列表
   * （本 section + 贴边时相邻 column 的边界 section——AO/面剔除最坏范围）。
   * `blockEntity`（M7）透传给 `ChunkColumn.set`：**不带即清除该格旧 entity**（巢穴失效语义）。
   * @returns {{column: import('./chunk-column.js').ChunkColumn, index: number, sy: number,
   *            affected: Array<{cx: number, cz: number, sy: number}>} | null} column 缺失返回 null
   */
  setBlock(x, y, z, id, meta = 0, blockEntity = undefined) {
    if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) return null;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const col = this.columns.get(columnKey(cx, cz));
    if (!col) return null;
    const lx = x - cx * 16, lz = z - cz * 16;
    col.set(lx, y, lz, id, meta, blockEntity);
    // 光照收敛（§4.6）：skylight 纯垂直传播，单块编辑只影响同 (lx,lz) 垂直列，
    // 增量重算 O(128)。不重算则新暴露面读到旧 light=0 → 全黑（挖块黑面 bug）。
    // blocklight 增量删除放后续阶段（M1 快捷栏无发光方块，正常游玩不触发 region 重算）。
    recomputeSkylightAt(col, lx, lz, this.registry);
    const sy = (y - WORLD_MIN_Y) >> 4;
    return {
      column: col, index: blockIndex(lx, y, lz), sy,
      affected: this._affectedFor(cx, cz, lx, y, lz),
    };
  }

  /**
   * 批量原子写入（M4-0，设计文档 §4.5.3 / M4 规格 §4.1）。
   * 语义：同坐标「最后一次写入获胜」去重 → 过滤越界/缺 column/基岩目标/no-change →
   * 按 column 分组循环写 blocks/meta/edits/dirty section，每组结束后只 bump 一次 version
   * （禁止逐格调用 ChunkColumn.set —— 那会重复 bump version）。
   * 不做逐格同步光照（批量路径交异步 light 队列收敛，见 WorldEditor.setBlocks）。
   *
   * `blockEntity`（M7）：与 `setBlock` 同一语义 —— **不带即清除该格旧 entity**。一次事务里
   * 只有巢穴的 critical change 携带 entity，其余 37 个结构方块不带（它们不是锚点）。
   * 注意 `no-change` 判定必须把 entity 也算进去：否则「id/meta 相同但要写新 entity」的
   * change 会被静默跳过 → 锚点写不进世界却没有任何报错。
   * @param {Array<{x: number, y: number, z: number, id: number, meta?: number, blockEntity?: Object}>} rawChanges
   * @returns {{changes: Array<{x,y,z,oldId,oldMeta,newId,newMeta,oldBlockEntity?,newBlockEntity?}>,
   *            affected: Array<{cx,cz,sy}>, changedColumns: string[],
   *            skipped: Array<{x,y,z,id,reason: 'out-of-bounds'|'column-missing'|'bedrock'|'no-change'}>}}
   */
  setBlocks(rawChanges) {
    const lastByPos = new Map();
    for (const change of rawChanges) lastByPos.set(`${change.x},${change.y},${change.z}`, change);
    const byColumn = new Map();
    const changes = [], skipped = [], affected = new Map();
    const bedrock = this.registry.idOf('bedrock');

    for (const change of lastByPos.values()) {
      if (change.y < WORLD_MIN_Y || change.y >= WORLD_MAX_Y) { skipped.push({ ...change, reason: 'out-of-bounds' }); continue; }
      const cx = Math.floor(change.x / 16), cz = Math.floor(change.z / 16);
      const column = this.columns.get(columnKey(cx, cz));
      if (!column) { skipped.push({ ...change, reason: 'column-missing' }); continue; }
      // **坐标换算只做一次**（M7 性能修正）：`getBlockId`/`getBlockMeta`/`getBlockEntity`
      // 各自都会重算 cx/cz/column/index —— 批量路径每格调三次等于把同一换算做三遍。
      // 实测后果：bench 场景 ④（批量删 500 块）frameP95 9→10（回退 11.1%，门禁阻断）。
      // 这里直接读 typed array 与 blockEntities Map，语义完全等价、零重复换算。
      const lx = change.x - cx * 16, lz = change.z - cz * 16;
      const index = blockIndex(lx, change.y, lz);
      const sy = (change.y - WORLD_MIN_Y) >> 4;
      const oldId = column.blocks[index];
      if (oldId === bedrock && change.id !== bedrock) { skipped.push({ ...change, reason: 'bedrock' }); continue; }
      const oldMeta = column.meta[index];
      const newMeta = change.meta ?? 0;
      const oldBlockEntity = column.blockEntities.get(index);
      const newBlockEntity = change.blockEntity ?? undefined;
      // entity 参与 no-change 判定（见上方注释）：引用不同即视为有变更。
      // `?? null` 归一化不可省 —— Map 缺省返回 **undefined** 而未传 entity 也是 **undefined**，
      // 但 `getBlockEntity()` 公开口径返回 null；此处统一按 undefined 比较即可（两者都代表「无」）。
      if (oldId === change.id && oldMeta === newMeta && oldBlockEntity === newBlockEntity) {
        skipped.push({ ...change, reason: 'no-change' });
        continue;
      }
      const key = columnKey(cx, cz);
      if (!byColumn.has(key)) byColumn.set(key, { column, entries: [] });
      byColumn.get(key).entries.push({ index, sy, newId: change.id, newMeta, newBlockEntity });
      const record = { x: change.x, y: change.y, z: change.z, oldId, oldMeta, newId: change.id, newMeta };
      if (oldBlockEntity !== undefined) record.oldBlockEntity = oldBlockEntity;
      if (newBlockEntity !== undefined) record.newBlockEntity = newBlockEntity;
      changes.push(record);
      for (const section of this._affectedFor(cx, cz, lx, change.y, lz)) {
        affected.set(`${section.cx},${section.cz},${section.sy}`, section);
      }
    }
    for (const { column, entries } of byColumn.values()) {
      for (const entry of entries) {
        column.blocks[entry.index] = entry.newId;
        column.meta[entry.index] = entry.newMeta;
        const editEntry = { id: entry.newId, meta: entry.newMeta };
        if (entry.newBlockEntity !== undefined && entry.newBlockEntity !== null) {
          editEntry.blockEntity = entry.newBlockEntity;
          column.blockEntities.set(entry.index, entry.newBlockEntity);
        } else {
          column.blockEntities.delete(entry.index); // 不带 entity → 清除（失效语义）
        }
        column.edits.set(entry.index, editEntry);
        column.markDirty(entry.sy);
      }
      column.version++; // 每个受影响 column 只递增一次
    }
    return { changes, affected: [...affected.values()], changedColumns: [...byColumn.keys()], skipped };
  }

  /**
   * section halo 视图：18×18×18（中心 section + 1 格 halo），跨 column/section 拼接。
   * 任一水平邻居 column 缺失 → missing=true（缺失方向按 air 填充，调用方决策保守出块，§4.3）。
   * meta：朝向等元数据（mesher 朝向消费用，§4.3）；缺失 column 保持 0。
   * @returns {{data: Uint16Array, light: Uint8Array, meta: Uint8Array, missing: boolean}}
   */
  getSectionView(cx, sy, cz) {
    const data = new Uint16Array(VIEW * VIEW * VIEW);
    const light = new Uint8Array(VIEW * VIEW * VIEW);
    const meta = new Uint8Array(VIEW * VIEW * VIEW);
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
          meta[vi] = col.meta[idx];
        }
      }
    }
    return { data, light, meta, missing };
  }
}
