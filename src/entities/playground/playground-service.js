// src/entities/playground/playground-service.js — M9 创造台服务（规格 §2）
// Worker 同构：本文件不得 import three（同构层，tools/check-architecture.mjs 静态门守）。
//
// **不维护 mc-lite 的 `playgroundBlocks: Set<'x,y,z'>` 副本**（红线 1：那是「平台有哪些方块」
// 的第二份权威，2916 个字符串键）。平台是规则的 54×54 矩形，坐标可纯计算得出 →
// 关闭时由 `origin + size` 确定性重算枚举。
//
// **重启恢复走锚点而非遍历已加载 chunk**（mc-lite `detectExistingPlayground` 遍历
// `world.chunks` → 远处未加载就扫不到）。本仓库走 M7 的 blockEntity 锚点模式：
// 中心块的 `{kind:'playground', id, origin, size}` 随 edits 落盘，经
// `listBlockEntities('playground')` cursor 扫库恢复。全局最多 1 个（mc-lite 单例语义），
// 上限判定同样走扫库而非已加载状态。
import {
  PLAYGROUND, PLAYGROUND_KIND, PLAYGROUND_BLOCK, PLAYGROUND_CENTER_BLOCK,
} from './playground-config.js';

export class PlaygroundService {
  /**
   * @param {{world: import('../../voxel/world-data.js').WorldData,
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          registry: ReturnType<import('../../voxel/block-registry.js').createRegistry>}} deps
   */
  constructor({ world, editor, registry }) {
    this.world = world; this.editor = editor; this.registry = registry;
    /** 派生状态：`{origin:[x,y,z], size:number} | null`。**不是**方块集合副本 */
    this._state = null;
  }

  isActive() { return this._state !== null; }
  origin() { return this._state ? [...this._state.origin] : null; }

  /**
   * 创建平台。选址顺序照搬 mc-lite `createPlayground()`：东侧 10 格 → 西侧 → 东侧(玩家 Y−20)
   * → 东侧(玩家 Y−5)，全部失败返回 `no-safe-location`。
   *
   * ⚠️ **未加载 column 必须视为重叠**：mc-lite 遍历 `world.chunks` 查已加载块；本仓库
   * `WorldData.getBlockId` 对未加载 column 返回 0（air）→ 会把未加载区域判为「安全」，
   * 然后在写入时因 column 缺失被 setBlocks 跳过 → 产出半个平台。故选址前先确认候选区域的
   * column 已加载（照 M7 `place()` 的 `hasColumn` 预检）。实测：平台距玩家 10~64 格，视距 8
   * 的加载半径 128 格 → 通常已加载；但视距 2（M1 测试口径）时部分未加载，这条判据是必需的。
   *
   * @param {{x:number, y:number, z:number}} playerPos
   * @returns {{ok:true, origin:[number,number,number]} |
   *           {ok:false, reason:'exists'|'no-safe-location'|'not-loaded'}}
   */
  create(playerPos) {
    if (this._state) return { ok: false, reason: 'exists' };   // 全局最多 1 个
    const px = Math.floor(playerPos.x), py = Math.floor(playerPos.y), pz = Math.floor(playerPos.z);
    const half = PLAYGROUND.size / 2;
    // 候选序列（mc-lite 同序）：东侧 → 西侧 → 东侧(玩家 Y−20) → 东侧(玩家 Y−5)。
    // 前两个从「玩家脚下地面高度」起搜；后两个直接用给定 startY（跳过地面搜索）。
    const candidates = [
      { x: px + PLAYGROUND.distance, z: pz - half, startY: null },
      { x: px - PLAYGROUND.distance, z: pz - half, startY: null },
      { x: px + PLAYGROUND.distance, z: pz - half, startY: py - 20 },
      { x: px + PLAYGROUND.distance, z: pz - half, startY: py - 5 },
    ];
    /** 是否曾有候选因 column 未加载被跳过（决定最终 reason，见循环后的 ⚠️） */
    let sawNotLoaded = false;
    for (const c of candidates) {
      // ① column 已加载预检（整片平台覆盖的 column 都须已加载）
      // ⚠️ **未加载 → `continue`（试下一个候选），不是 `return`**：东侧未加载时仍要
      // 试西侧 / Y−20 / Y−5（规格 §2.1 的选址顺序）。用 `return` 会在第一个候选就放弃，
      // 西侧永远不会被尝试。记录是否发生过未加载，供最终 reason 判定。
      if (!this._allColumnsLoaded(c.x, c.z)) { sawNotLoaded = true; continue; }
      // ② 从地面高度（或给定 startY）向上搜安全高度
      const startY = c.startY ?? this._findGroundLevelFromBelow(c.x, py, c.z);
      const y = this._findSafeHeight(c.x, startY, c.z);
      if (y === null) continue;   // 这个候选找不到 → 试下一个（mc-lite 同口径）
      return this._write(c.x, y, c.z);
    }
    // 全部候选失败：若曾因 column 未加载跳过 → 报 not-loaded（更准确的原因），
    // 否则报 no-safe-location（column 都加载了但找不到净空高度）
    return { ok: false, reason: sawNotLoaded ? 'not-loaded' : 'no-safe-location' };
  }

  /** 整片平台覆盖的 column 是否都已加载（未加载 → 选址判为重叠，见 create() 注释） */
  _allColumnsLoaded(originX, originZ) {
    const size = PLAYGROUND.size;
    const cx0 = Math.floor(originX / 16), cx1 = Math.floor((originX + size - 1) / 16);
    const cz0 = Math.floor(originZ / 16), cz1 = Math.floor((originZ + size - 1) / 16);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        if (!this.world.hasColumn(cx, cz)) return false;
      }
    }
    return true;
  }

  /**
   * 从 startY **向下**扫第一个实心方块，返回其上方一格（平台落点）—— mc-lite
   * `findGroundLevelFromBelow` 同语义（⚠️ 它是向下扫，不是向上；找不到返回 null）。
   * ⚠️ **偏离计划正文**：计划把它写成向上扫（`y < maxSearchY`），与 mc-lite 相反 ——
   * 本实现按 mc-lite 的向下扫语义落地，记进验收报告偏离表。
   */
  _findGroundLevelFromBelow(x, startY, z) {
    for (let y = Math.floor(startY); y >= PLAYGROUND.minSearchY; y--) {
      if (this.world.getBlockId(x, y, z) !== 0) return y + 1;
    }
    return null;
  }

  /** 向上搜第一个「平台层 + 净空区域全为空」的高度（mc-lite `findSafePlaygroundHeight`） */
  _findSafeHeight(originX, startY, originZ) {
    if (startY === null) return null;
    for (let y = startY; y <= PLAYGROUND.maxSearchY; y++) {
      if (!this._hasOverlap(originX, y, originZ)) return y;
    }
    return null;
  }

  /** 平台层与上方净空区域是否有非空气方块（mc-lite `hasOverlapWithWorld` 同语义） */
  _hasOverlap(originX, y, originZ) {
    const size = PLAYGROUND.size;
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        // 平台层（dy=0）+ 净空 clearance 格（dy=1..clearance）
        for (let dy = 0; dy <= PLAYGROUND.clearance; dy++) {
          const yy = y + dy;
          if (yy >= PLAYGROUND.maxSearchY) return true;   // 超出世界顶视为重叠
          if (this.world.getBlockId(originX + dx, yy, originZ + dz) !== 0) return true;
        }
      }
    }
    return false;
  }

  /** 一次事务写入 2916 格 + 中心块锚点 */
  _write(originX, y, originZ) {
    const size = PLAYGROUND.size;
    const centerDx = Math.floor(size / 2), centerDz = Math.floor(size / 2);
    const blockId = this.registry.idOf(PLAYGROUND_BLOCK);
    const centerId = this.registry.idOf(PLAYGROUND_CENTER_BLOCK);
    // 全局最多 1 个 → 固定 id（hydrate 后同口径，不会冲突；不用 Math.random —— 红线 2）
    const id = `${PLAYGROUND_KIND}-1`;
    const changes = [];
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        const x = originX + dx, z = originZ + dz;
        const isCenter = dx === centerDx && dz === centerDz;
        const change = { x, y, z, id: isCenter ? centerId : blockId, meta: 0 };
        if (isCenter) {
          change.blockEntity = {
            kind: PLAYGROUND_KIND, id, origin: [originX, y, originZ], size,
          };
        }
        changes.push(change);
      }
    }
    const report = this.editor.setBlocks(changes);
    // ⚠️ **回滚判据不能只看 `skipped.length > 0`** —— `world-data.js` 把 **no-change 也推进
    // skipped**（某格已是目标值时）。2916 格里只要有一格已是 `playground_block` 就会触发
    // 整批回滚，且误报成 'not-loaded'。真正的失败只有三种硬失败：
    // `column-missing` / `out-of-bounds` / `bedrock`。no-change 是**正常**的（幂等放置）。
    const hardSkipped = report.skipped.filter((sk) =>
      sk.reason === 'column-missing' || sk.reason === 'out-of-bounds' || sk.reason === 'bedrock');
    if (hardSkipped.length > 0) {
      // 部分写入（硬失败）→ 回滚，绝不留下半个平台。
      // ⚠️ 此路径在 column 已加载预检之后基本不可达（防御性兜底）。
      this.editor.setBlocks(changes.map((c) => ({ x: c.x, y: c.y, z: c.z, id: 0 })));
      const reason = hardSkipped[0].reason === 'column-missing' ? 'not-loaded' : 'no-safe-location';
      return { ok: false, reason };
    }
    this._state = { origin: [originX, y, originZ], size };
    return { ok: true, origin: [originX, y, originZ] };
  }

  /**
   * 玩家在平台区域内（mc-lite `isPlayerInPlayground`）：XZ 在范围内 +
   * Y 在 `[origin.y, origin.y + heightSpan)`。⚠️ `heightSpan`(20) > `clearance`(10) ——
   * 玩家可在净空区往上叠模型，判据须用更宽的跨度，否则站在自己雕的高处就能关掉脚下平台。
   * @param {{x:number,y:number,z:number}} playerPos @returns {boolean}
   */
  isPlayerInPlayground(playerPos) {
    if (!this._state) return false;
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    return playerPos.x >= ox && playerPos.x < ox + size &&
           playerPos.z >= oz && playerPos.z < oz + size &&
           playerPos.y >= oy && playerPos.y < oy + PLAYGROUND.heightSpan;
  }

  /**
   * 关闭平台。玩家在区域内则拒绝（防止把玩家脚下的地面抽掉）。
   * ⚠️ **只删平台层方块，不删玩家雕的模型**（mc-lite 同口径：`playgroundBlocks` 只含平台格）。
   * 坐标由 `origin + size` **确定性重算**（不维护方块集合副本 —— 红线 1）。
   * @param {{x:number,y:number,z:number}} playerPos
   */
  close(playerPos) {
    if (!this._state) return { ok: false, reason: 'not-active' };
    if (playerPos && this.isPlayerInPlayground(playerPos)) {
      return { ok: false, reason: 'player-in-playground' };
    }
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    const changes = [];
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) changes.push({ x: ox + dx, y: oy, z: oz + dz, id: 0 });
    }
    // 一次事务（中心块的 blockEntity 随方块改写为 air 自动清除 —— setBlocks 不带 entity 即清除）
    this.editor.setBlocks(changes);
    this._state = null;
    return { ok: true };
  }

  /**
   * 从存档恢复（走锚点，不遍历已加载 chunk）。
   * ⚠️ **启动期 hydrate 前不需要 flushNow** —— M7 的 `nests.hydrate`（`game.js`）就没有这个
   * 前置（`listBlockEntities` 走 cursor 扫库，不依赖预热）。`flushNow` 是**测试侧 reload 前**
   * 才调用的（把内存 edits 落库，reload 后 hydrate 才读得到）。
   */
  async hydrate(persistence) {
    const anchors = await persistence.listBlockEntities(PLAYGROUND_KIND);
    this._state = null;
    for (const { blockEntity } of anchors) {
      if (!blockEntity?.origin) continue;
      this._state = { origin: [...blockEntity.origin], size: blockEntity.size ?? PLAYGROUND.size };
      break;   // 全局最多 1 个
    }
  }

  /**
   * 导出模型：枚举平台上方（`origin.y+1` 起至世界顶）的非平台方块 → 相对中心坐标。
   * 输出格式**与 `assets/structures/*.json` 完全一致**（mc-lite 同口径 → 导出的模型可直接
   * 当结构 JSON 用）。⚠️ **dimensions 键名 = `width`/`height`/`depth`**（实测 27 个结构 JSON
   * 全部用这三个键，如 `big_house.json` → `{width,height,depth}`）。
   * @returns {{ok:true, json:string, blocks:number} | {ok:false, reason:'not-active'}}
   */
  exportModel() {
    if (!this._state) return { ok: false, reason: 'not-active' };
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    // 中心 = 几何中心（mc-lite `getModelBlocks` 用 `origin + size/2`，相对坐标以此为原点）
    const cx = ox + size / 2, cz = oz + size / 2;
    const blockId = this.registry.idOf(PLAYGROUND_BLOCK);
    const centerId = this.registry.idOf(PLAYGROUND_CENTER_BLOCK);
    const blocks = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let dx = 0; dx < size; dx++) {
      for (let dz = 0; dz < size; dz++) {
        const x = ox + dx, z = oz + dz;
        for (let y = oy + 1; y < PLAYGROUND.maxSearchY; y++) {
          const id = this.world.getBlockId(x, y, z);
          if (id === 0 || id === blockId || id === centerId) continue;
          const name = this.registry.nameOf(id);
          blocks.push({
            x: Math.round(x - cx), y: Math.round(y - oy), z: Math.round(z - cz),
            type: name, direction: this.world.getBlockMeta(x, y, z),
          });
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
      }
    }
    const json = JSON.stringify({
      blocks,
      metadata: {
        created: new Date().toISOString(),
        dimensions: blocks.length === 0
          ? { width: 0, height: 0, depth: 0 }
          : { width: maxX - minX + 1, height: maxY - minY + 1, depth: maxZ - minZ + 1 },
      },
    }, null, 2);
    return { ok: true, json, blocks: blocks.length };
  }

  /**
   * 导入模型（mc-lite `importModelFromJson` 语义照搬，但**不做「先清模型区」** —— 见下）。
   * ⚠️ **未知方块名（registry 里没有）必须计 `invalid` 并跳过，不得写 0（air）** ——
   * 那会静默删掉玩家已有的方块。
   * ⚠️ **Y 越界判据用本仓库的 `WORLD_MIN_Y/WORLD_MAX_Y`**（mc-lite 是 `y < 0 || y > 255`）。
   * ⚠️ **有意偏离：不移植 `collectModelAreaBlocksToClear`（先清平台上方模型区）** ——
   * 清空会删掉玩家已有模型（破坏性操作，须用户授权）。记进验收报告偏离表。
   * @param {string} jsonText
   * @returns {{ok:true, placed:number, skipped:number, invalid:number} | {ok:false, reason:string}}
   */
  importModel(jsonText) {
    if (!this._state) return { ok: false, reason: 'not-active' };
    let data;
    try { data = JSON.parse(jsonText); } catch { return { ok: false, reason: 'invalid-json' }; }
    if (!data || !Array.isArray(data.blocks)) return { ok: false, reason: 'invalid-format' };
    const [ox, oy, oz] = this._state.origin;
    const size = this._state.size;
    const cx = ox + size / 2, cz = oz + size / 2;
    let skipped = 0, invalid = 0;
    const pending = new Set();
    const changes = [];
    for (const block of data.blocks) {
      if (!block || typeof block !== 'object') { invalid++; continue; }
      const relX = Number(block.x), relY = Number(block.y), relZ = Number(block.z);
      const type = typeof block.type === 'string' ? block.type.trim() : '';
      if (!Number.isFinite(relX) || !Number.isFinite(relY) || !Number.isFinite(relZ) || !type) {
        invalid++; continue;
      }
      const id = this.registry.idOf(type);
      if (id === undefined) { invalid++; continue; }   // ⚠️ 未知方块名 → invalid，不写 air
      const x = Math.round(cx + relX), y = Math.round(oy + relY), z = Math.round(cz + relZ);
      if (y < PLAYGROUND.minSearchY || y >= PLAYGROUND.maxSearchY) { invalid++; continue; }
      // cullMode:'none' 的不可渲染方块跳过（mc-lite `!props.isRendered` 同口径）
      if (this.registry.cullTable[id] === 3) { skipped++; continue; }
      const key = `${x},${y},${z}`;
      if (pending.has(key)) { skipped++; continue; }   // 同坐标重复只保留首次
      pending.add(key);
      // direction → orientation（mc-lite `convertDirectionToOrientation`：取水平四方向）
      const dir = Number(block.direction);
      const meta = Number.isFinite(dir) ? ((Math.trunc(dir) % 4) + 4) % 4 : 0;
      changes.push({ x, y, z, id, meta });
    }
    if (changes.length === 0) return { ok: true, placed: 0, skipped, invalid };
    const report = this.editor.setBlocks(changes);
    // no-change 也算正常写入尝试，只把硬失败计入 skipped（与 _write 同口径）
    const hardSkipped = report.skipped.filter((sk) =>
      sk.reason === 'column-missing' || sk.reason === 'out-of-bounds' || sk.reason === 'bedrock');
    skipped += hardSkipped.length;
    return { ok: true, placed: report.changes.length, skipped, invalid };
  }
}
