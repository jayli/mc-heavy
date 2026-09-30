// src/save/progress-codec.js — 进度包编解码（设置面板「导出进度 / 导入进度」的核心逻辑）
//
// 什么时候用：把当前世界的完整存档写成 JSON 文件、以及把这样的文件读回持久层。
// 本仓的世界 = **seed + 玩家改动的稀疏差异**（红线 2：地形由 seed 确定性重算，存档只存 diff），
// 故「进度」= seed + edits（`columnKey → [{index, id, meta, blockEntity?}]`）+ 持久实体 snapshot。
// **不导出逐格地形** —— 视距 8 的 289 个 column 全量约上亿字符，而地形本就由 seed 决定。
//
// 为什么逻辑放在这个纯函数模块、而不是 `Game` 里：坐标编解码与坏条目分类是「改坏了肉眼玩不出来」
// 的部分（写错一格就是方块错位、写 air 就是静默删掉玩家已有的方块），必须能被浏览器内单测直接
// 钉住。`Game` 只负责文件 I/O 与落盘，不含任何算术。
//
// 持久层一致：`decodeProgress` 的输出形状与 `Persistence.saveColumnEdits` 的入参**同构**
// （`edits[].index` 是列内 typed array 索引），调用方拿到即可落盘，不做第二次换算。
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex, decodeBlockIndex } from '../voxel/constants.js';

/** 包标识：导入时先认这个字段，避免把别的游戏的 JSON 当进度读 */
export const PROGRESS_FORMAT = 'mc-heavy-progress';
/**
 * 包版本。**导入只接受 `<=` 当前版本**：更高的版本意味着有本代码不认识的字段，
 * 猜着读会静默丢数据 → 报 `unsupported-version` 让用户更新代码，而不是丢一半进世界。
 */
export const PROGRESS_VERSION = 1;

/** column key `"cx,cz"` → `{cx, cz}`；非法返回 null（防御：包可能被手改过） */
function parseColumnKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split(',');
  if (parts.length !== 2) return null;
  const cx = Number(parts[0]), cz = Number(parts[1]);
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) return null;
  return { cx, cz };
}

/**
 * 编码进度包。
 *
 * 方块用**名字**而不是数字 id：id 是注册顺序的产物（`blocks-data.js` 增删方块会整体移位），
 * 用 id 存盘的包在版本之间会静默错位成别的方块。未知名字在 `decodeProgress` 侧计入 invalid 跳过。
 * 坐标为**世界坐标**（`column.cx * 16 + lx`），人类可读、便于手工核对。
 *
 * @param {{seed: number, spawn: [number, number]|null,
 *          columns: Array<{columnKey: string, edits: Array<{index: number, id: number, meta: number, blockEntity?: Object}>}>,
 *          entities: Array<{id: string, type: string, state: Object}>}} input
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 * @returns {string} JSON 文本
 */
export function encodeProgress({ seed, spawn, columns = [], entities = [] }, registry) {
  const outColumns = [];
  for (const { columnKey, edits } of columns) {
    const parsed = parseColumnKey(columnKey);
    if (!parsed || !Array.isArray(edits) || edits.length === 0) continue; // 空 column 不产出空行
    const cells = [];
    for (const edit of edits) {
      const { lx, y, lz } = decodeBlockIndex(edit.index);
      const cell = {
        x: parsed.cx * 16 + lx,
        y,
        z: parsed.cz * 16 + lz,
        type: registry.nameOf(edit.id),
        meta: edit.meta ?? 0,
      };
      if (edit.blockEntity !== undefined && edit.blockEntity !== null) {
        cell.blockEntity = edit.blockEntity; // 巢穴/炮塔/创造台的锚点真相，丢了装置就不工作
      }
      cells.push(cell);
    }
    if (cells.length) outColumns.push({ key: columnKey, cells });
  }
  const json = JSON.stringify({
    format: PROGRESS_FORMAT,
    version: PROGRESS_VERSION,
    exportedAt: new Date().toISOString(),
    seed,
    spawn: Array.isArray(spawn) ? [spawn[0], spawn[1]] : null,
    columns: outColumns,
    entities,
  }, null, 2);
  return json;
}

/**
 * 解码进度包。
 *
 * **校验先于产出**：format / version / seed 三项任一不合法即返回 `{ok:false, reason}`，
 * 且**不带任何 edits/entities 字段** —— 调用方据此知道「失败时零输出」，不会写半个世界。
 * 单条 cell 不合法只计入 `invalid` 并跳过（不中止整包），与 M9 导入的分类语义一致。
 *
 * @param {string} jsonText
 * @param {ReturnType<import('../voxel/block-registry.js').createRegistry>} registry
 * @returns {{ok:true, seed:number, spawn:[number,number]|null,
 *            edits:Array<{columnKey:string, edits:Array<{index:number,id:number,meta:number,blockEntity?:Object}>}>,
 *            entities:Array<Object>, invalid:number, skipped:number}
 *           | {ok:false, reason:string}}
 */
export function decodeProgress(jsonText, registry) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!data || typeof data !== 'object' || data.format !== PROGRESS_FORMAT) {
    return { ok: false, reason: 'invalid-format' };
  }
  const version = Number(data.version);
  if (!Number.isInteger(version) || version < 1) return { ok: false, reason: 'invalid-format' };
  if (version > PROGRESS_VERSION) return { ok: false, reason: 'unsupported-version' };
  // seed 必须是正整数（1..0xFFFFFF，与 randomSeed 同口径）—— 0 会让噪声退化、负数不在口径内。
  const seed = Number(data.seed);
  if (!Number.isInteger(seed) || seed <= 0) return { ok: false, reason: 'invalid-seed' };

  const spawn = (Array.isArray(data.spawn) && data.spawn.length === 2
    && Number.isFinite(data.spawn[0]) && Number.isFinite(data.spawn[1]))
    ? [data.spawn[0], data.spawn[1]]
    : null; // 非法 spawn 回落 null → 调用方保留既有 meta.spawn（不写 NaN 进存档）

  const edits = [];
  let invalid = 0, skipped = 0;
  const rawColumns = Array.isArray(data.columns) ? data.columns : [];
  for (const column of rawColumns) {
    if (!column || typeof column !== 'object') { invalid++; continue; }
    const parsed = parseColumnKey(column.key);
    if (!parsed) { invalid++; continue; }
    const cells = Array.isArray(column.cells) ? column.cells : [];
    const rows = [];
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') { invalid++; continue; }
      const x = Number(cell.x), y = Number(cell.y), z = Number(cell.z);
      const type = typeof cell.type === 'string' ? cell.type.trim() : '';
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !type) {
        invalid++; continue;
      }
      const id = registry.idOf(type);
      // ⚠️ 未知方块名 → invalid 且**跳过，绝不写 air**（id 0 会静默删掉玩家已有的方块）
      if (id === undefined) { invalid++; continue; }
      // y 越界按本仓库边界判（[-32, 96)），与 mc-lite 的 0~255 不同
      if (y < WORLD_MIN_Y || y >= WORLD_MAX_Y) { invalid++; continue; }
      // lx/lz 必须落在 key 自己的 column 内 —— 否则该 index 会写进 key 的 column 却带着
      // 另一列的世界坐标语义 → 方块出现在不该出现的位置（key 是归属权威，不做「按 x 反推」）。
      const lx = x - parsed.cx * 16, lz = z - parsed.cz * 16;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) { invalid++; continue; }
      const meta = Number.isInteger(Number(cell.meta)) ? ((Number(cell.meta) % 256) + 256) % 256 : 0;
      const row = { index: blockIndex(lx, y, lz), id, meta };
      if (cell.blockEntity && typeof cell.blockEntity === 'object') row.blockEntity = cell.blockEntity;
      rows.push(row);
    }
    if (rows.length === 0) { if (cells.length) skipped++; continue; } // 整列都被判无效 → 不产空行
    edits.push({ columnKey: column.key, edits: rows });
  }

  const entities = [];
  const rawEntities = Array.isArray(data.entities) ? data.entities : [];
  for (const snapshot of rawEntities) {
    // 持久实体 snapshot 的形状校验交回 M5 的 `restorePersistent`（它已按类型/可反序列化过滤），
    // 这里只做最小结构检查，避免把明显不是 snapshot 的东西写进 entities store。
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string'
      || typeof snapshot.type !== 'string') { invalid++; continue; }
    entities.push({ id: snapshot.id, type: snapshot.type, state: snapshot.state });
  }

  return { ok: true, seed, spawn, edits, entities, invalid, skipped };
}
