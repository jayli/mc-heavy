// src/gen/structures/redcity-data.js — RedCity 烘焙产物：形状定义 + 加载器 + 按列展开 + 模块级缓存
// Worker 同构：本文件不得 import three，无 DOM。
//
// 产物 = `assets/redcity/redcity.json`（spec §13.5.5，D8）。「写」（encodeRedCityJson，仅烘焙脚本用）与「读」
// （prepareRedCityModel）放同一个文件，让产物形状只有一份定义（红线 1）。

/** 产物格式版本（改形状必须 bump） */
export const REDCITY_JSON_FORMAT = 1;

/**
 * 烘焙结果 → 产物文档（纯数据，可直接 JSON.stringify）。
 * `blocks` 是扁平三元组 `[col, dy, pal]`，**必须按 (col, dy) 严格升序**（加载器的列索引靠这个前提；同格重复也会被拒收）。
 * ⚠️ `dy` 是相对 `baseY` 的行号：世界 y = `baseY + dy`（不是相对该列地面；地面方块恰在 `dy === ground[col]`）。
 */
export function encodeRedCityJson(bake, spawn) {
  const palette = [...new Set(bake.ents.map((e) => e.name))].sort();
  const palId = new Map(palette.map((n, i) => [n, i]));
  const blocks = [];
  for (const e of bake.ents) blocks.push(e.c, e.y, palId.get(e.name));
  return {
    format: 'redcity-json', version: REDCITY_JSON_FORMAT,
    width: bake.width, length: bake.length, dyMin: bake.dyMin, dyMax: bake.dyMax,
    spawn: { ox: spawn.ox, oz: spawn.oz, dy: spawn.dy },
    palette, ground: Array.from(bake.ground), island: Array.from(bake.island).join(''), blocks,
    stats: { ...bake.stats },
  };
}

/** 解析产物并建列索引（运行时唯一入口）。`colStart` 由 blocks 现算、不落盘（落盘 = 第二份权威）。 */
export function prepareRedCityModel(doc) {
  if (!doc || doc.format !== 'redcity-json') throw new Error('redcity: 不是 redcity-json 产物');
  if (doc.version !== REDCITY_JSON_FORMAT) throw new Error(`redcity: 不支持的产物版本 ${doc.version}`);
  const N = doc.width * doc.length;
  if (doc.ground.length !== N) throw new Error('redcity: ground 长度与 width*length 不符');
  if (doc.island.length !== N) throw new Error('redcity: island 长度与 width*length 不符');
  if (doc.blocks.length % 3 !== 0) throw new Error('redcity: blocks 不是三元组的整数倍');
  const colStart = new Uint32Array(N + 1);
  const blocks = doc.blocks, palN = doc.palette.length;
  let prevCol = -1, prevDy = -Infinity;
  for (let i = 0; i < blocks.length; i += 3) {
    const c = blocks[i], dy = blocks[i + 1], pal = blocks[i + 2];
    // ⚠️ 越界的 col 写进 Uint32Array 会被静默丢弃（不抛错）→ 方块凭空消失，必须显式拒收
    if (!Number.isInteger(c) || c < 0 || c >= N) throw new Error(`redcity: blocks[${i}] 的 col ${c} 不是 [0, ${N}) 内的整数`);
    if (!Number.isInteger(dy) || dy < doc.dyMin || dy > doc.dyMax) throw new Error(`redcity: blocks[${i + 1}] 的 dy ${dy} 不在 [${doc.dyMin}, ${doc.dyMax}] 内`);
    if (!Number.isInteger(pal) || pal < 0 || pal >= palN) throw new Error(`redcity: blocks[${i + 2}] 的 palette 下标 ${pal} 越界（palette 共 ${palN} 项）`);
    // 严格升序同时保证：列索引前缀和成立 + 同一格不会出现两条记录（后写胜会让产物的语义取决于顺序）
    if (c < prevCol || (c === prevCol && dy <= prevDy)) throw new Error('redcity: blocks 未按 (col, dy) 严格升序（列索引前缀和不成立或同格重复）');
    prevCol = c; prevDy = dy;
    colStart[c + 1]++;
  }
  for (let c = 0; c < N; c++) colStart[c + 1] += colStart[c];
  if (colStart[N] * 3 !== blocks.length) throw new Error('redcity: 列索引总数与 blocks 长度不符');
  return { ...doc, colStart };
}

/** 该列是否岛内（`island` 串的读出口，勿在消费者里另写索引运算） */
export function isIslandColumn(model, ox, oz) {
  return model.island.charCodeAt(oz * model.width + ox) === 49;   // '1'
}

/** 该列的地面高度（相对 `baseY`） */
export function groundAt(model, ox, oz) {
  return model.ground[oz * model.width + ox];
}

/** 按列展开：对 (ox, oz) 列的每个方块回调 `cb(dy, blockName)`。GEN 阶段 2.9 的唯一消费口。 */
export function forEachRedCityBlock(model, ox, oz, cb) {
  const c = oz * model.width + ox;
  const blocks = model.blocks;
  for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
    const i = k * 3;
    cb(blocks[i + 1], model.palette[blocks[i + 2]]);
  }
}

// ---- 模块级缓存：注入来源是主线程启动时的 broadcast（Worker）或 Game.start（主线程），不是懒 fetch ----
let _model = null;
/** 注入已解析的运行时模型（主线程与 Worker 共用同一入口；传 null 清空） */
export function setRedCityData(model) { _model = model; }
export function getRedCityData() { return _model; }
