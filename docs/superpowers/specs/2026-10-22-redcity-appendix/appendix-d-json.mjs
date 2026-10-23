// ⚠️ v1.2：本附录是**算法的独立可复现参考**；落地形态见 `appendix-f-reference/src/gen/structures/redcity-data.js`（计划以后者为准）。 落地版比本附录多 3 类校验（`col` 越界 / `dy` 越界 / palette 下标越界），并把「按 col 升序」加强为「(col, dy) 严格升序」；以落地版为准。
// 附录 D：JSON 产物格式与加载器
//
// 用户裁定（2026-10-22）：产物用 **JSON**，不用自定义二进制。理由：
//   - 复用 `structure-json.js` 已验证几个 Epic 的加载/光栅化路径，少维护一种格式；
//   - 实测形状②（扁平数组 + palette 下标）已把代价压到可接受：
//       raw 2.85 MiB / gzip 0.62 MiB / parse 4.6 ms / heap +6.4 MiB
//     对比对象数组（castle.json 同款形状）：raw 10.19 MiB / parse 18.2 ms / heap +18.8 MiB
//     对比 RCY2 二进制：raw 1.0 MiB / decode 0.64 ms / heap +2.8 MiB
//   - 14 个 Worker 各自持一份：JSON 形状② 约 6.4 MiB × 14 ≈ 90 MiB（可接受）；
//     对象数组则要 18.8 × 14 ≈ 263 MiB（GC 压力显著）。
//
// ⚠️ **形状②是实测选出的，不是随手写的**：`blocks` 用扁平 `[col, dy, pal]` 三元组而非
// `[{x,y,z,type}]` 对象数组 —— 后者体积 3.6 倍、parse 慢 4 倍、堆占用 3 倍。
// 改形状前必须重跑本文件末尾的自检。
//
// 实施时本文件的内容要落到：
//   - 产物形状与写出 → `tools/bake-redcity.mjs`
//   - 加载 + 列索引 + 按列展开 → `src/gen/structures/redcity-data.js`（Worker 同构，无 three/DOM）

/** 产物格式版本（进指纹；改形状必须 bump） */
export const REDCITY_JSON_FORMAT = 1;

/**
 * 把烘焙结果编码为产物文档（纯数据，可直接 `JSON.stringify`）。
 *
 * @param {Object} bake `bakeRedCityCore` 的返回
 * @param {{ox:number, oz:number, dy:number}} spawn `pickSpawn` 的返回
 * @returns {Object} 见下方「产物形状」
 *
 * ## 产物形状
 * ```
 * {
 *   format: 'redcity-json', version: 1,
 *   width, length,            // 250 × 289（core 尺寸，= REDCITY_SIZE）
 *   dyMin, dyMax,             // 内容相对地面的行号域（-6 .. 80）
 *   spawn: { ox, oz, dy },    // 出生点（相对 core 原点与 baseY）
 *   palette: string[],        // 方块名表（实测 28 项 = 实际出现的目标方块；映射规则的目标共 29 种），blocks 里存下标
 *   ground: number[],         // 每列地面高度（相对 baseY，Int8 范围 -5..43）
 *   island: string,           // 每列是否岛内，'0'/'1' 串（比数组省 3 倍体积）
 *   blocks: number[],         // 扁平三元组 [col, dy, pal]，按 (col, dy) 升序
 *                             //   ⚠️ dy 是相对 baseY 的行号（世界 y = baseY + dy），
 *                             //   地面方块恰在 dy === ground[col]（见 forEachRedCityBlock 注释）
 *   stats: {...},             // 烘焙统计（不变量实测值，check:data 复核用）
 * }
 * ```
 *
 * ⚠️ `blocks` **必须按 (col, dy) 升序** —— 加载器建列索引靠这个前提做单遍前缀和；
 * 乱序会让 `colStart` 算错 → 展开时静默错位（方块出现在错的列，肉眼像「地图花了」）。
 */
export function encodeRedCityJson(bake, spawn) {
  const palette = [...new Set(bake.ents.map((e) => e.name))].sort();
  const palId = new Map(palette.map((n, i) => [n, i]));
  const blocks = [];
  for (const e of bake.ents) {
    blocks.push(e.c, e.y, palId.get(e.name));
  }
  return {
    format: 'redcity-json',
    version: REDCITY_JSON_FORMAT,
    width: bake.width,
    length: bake.length,
    dyMin: bake.dyMin,
    dyMax: bake.dyMax,
    spawn: { ox: spawn.ox, oz: spawn.oz, dy: spawn.dy },
    palette,
    ground: Array.from(bake.ground),
    island: Array.from(bake.island).join(''),
    blocks,
    stats: { ...bake.stats },
  };
}

/**
 * 解析产物并建列索引（运行时唯一入口）。
 *
 * 返回的对象是**运行时模型**：在产物字段之外多一个 `colStart`（前缀和，由 `blocks` 现算，
 * 不落盘 —— 落盘会引入第二份权威，红线 1）。
 *
 * @param {Object} doc `JSON.parse` 的结果
 * @returns {Object} 运行时模型
 */
export function prepareRedCityModel(doc) {
  if (!doc || doc.format !== 'redcity-json') throw new Error('redcity: 不是 redcity-json 产物');
  if (doc.version !== REDCITY_JSON_FORMAT) throw new Error(`redcity: 不支持的产物版本 ${doc.version}`);
  const N = doc.width * doc.length;
  if (doc.ground.length !== N) throw new Error('redcity: ground 长度与 width*length 不符');
  if (doc.island.length !== N) throw new Error('redcity: island 长度与 width*length 不符');
  if (doc.blocks.length % 3 !== 0) throw new Error('redcity: blocks 不是三元组的整数倍');

  const colStart = new Uint32Array(N + 1);
  const blocks = doc.blocks;
  // 单遍计数 + 顺序校验（依赖 blocks 按 col 升序；乱序会让 colStart 与实际位置错位）
  let prevCol = -1;
  for (let i = 0; i < blocks.length; i += 3) {
    const c = blocks[i];
    if (c < prevCol) throw new Error('redcity: blocks 未按 col 升序（列索引前缀和不成立）');
    prevCol = c;
    colStart[c + 1]++;
  }
  for (let c = 0; c < N; c++) colStart[c + 1] += colStart[c];
  if (colStart[N] * 3 !== blocks.length) {
    throw new Error('redcity: 列索引总数与 blocks 长度不符');
  }
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

/**
 * 按列展开：对 (ox, oz) 列的每个方块回调 `cb(dy, blockName)`。
 *
 * GEN 阶段 2.9 的唯一消费口。
 *
 * ⚠️ **`dy` 是相对 `baseY` 的行号，不是相对该列地面的偏移** —— 世界 y = `baseY + dy`。
 * 实测验证：地面方块恰好在 `dy === ground[col]`（烘焙核心的 `yRel = y - sMed + S`，
 * 而 `ground[c] = gY[c] - sMed + S[c]` → 地表块的 yRel 就是 ground）。
 * **写成 `baseY + ground + dy` 会把内容整体抬高 `ground` 格**（最大 43 格 → 顶穿世界顶
 * `WORLD_MAX_Y=96`，且与阶段 1 整形好的地面脱节）。`ground` 数组只用于：
 * ① 阶段 1 的 core 填充高度；② ring 过渡环混合；③ 出生点。**不参与方块放置**。
 */
export function forEachRedCityBlock(model, ox, oz, cb) {
  const c = oz * model.width + ox;
  const blocks = model.blocks;
  for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
    const i = k * 3;
    cb(blocks[i + 1], model.palette[blocks[i + 2]]);
  }
}

// ==================== 自检（跑本文件即执行）====================

if (process.argv[1] && process.argv[1].endsWith('appendix-d-json.mjs')) {
  const fs = await import('node:fs');
  const zlib = await import('node:zlib');
  const { loadSchematic } = await import('./appendix-a-schematic.mjs');
  const { isSkin, isBuildingMat, mappingOf } = await import('./appendix-b-mapping.mjs');
  const { bakeRedCityCore, pickSpawn } = await import('./appendix-c-bake-core.mjs');

  const sch = loadSchematic();
  const bake = bakeRedCityCore(sch, {
    isEmpty: (v) => (v >> 4) === 0 || (v >> 4) === 166,
    isSkin, isBuilding: isBuildingMat, nameOf: (v) => mappingOf(v).name,
    params: { relief: 0.34, K: 2, groundFloor: -5, decay: 2, pad: 1, minComp: 30, borderKeep: 8 },
  });
  const spawn = pickSpawn(bake);
  const doc = encodeRedCityJson(bake, spawn);
  const json = JSON.stringify(doc);

  console.log(`产物 raw ${(json.length / 1048576).toFixed(2)} MiB / gzip ${(zlib.gzipSync(json, { level: 9 }).length / 1048576).toFixed(2)} MiB`);
  console.log(`块数 ${bake.ents.length}，palette ${doc.palette.length} 项，size ${doc.width}×${doc.length}`);
  console.log(`spawn ox=${spawn.ox} oz=${spawn.oz} dy=${spawn.dy}`);

  // ---- 运行时路径计时 ----
  global.gc?.();
  const m0 = process.memoryUsage();
  const t0 = performance.now();
  const parsed = JSON.parse(json);
  const t1 = performance.now();
  const model = prepareRedCityModel(parsed);
  const t2 = performance.now();
  const m1 = process.memoryUsage();
  console.log(`parse ${(t1 - t0).toFixed(1)} ms + 建列索引 ${(t2 - t1).toFixed(1)} ms，heap +${((m1.heapUsed - m0.heapUsed) / 1048576).toFixed(1)} MiB`);

  let n = 0;
  const t3 = performance.now();
  for (let oz = 100; oz < 116; oz++) for (let ox = 100; ox < 116; ox++) forEachRedCityBlock(model, ox, oz, () => { n++; });
  console.log(`展开 1 个 column（16×16 格）${(performance.now() - t3).toFixed(3)} ms，${n} 块`);

  // ---- 往返无损校验 ----
  const want = new Map();
  const palId = new Map(doc.palette.map((nm, i) => [nm, i]));
  for (const e of bake.ents) want.set(e.c * 4096 + e.y + 2048, palId.get(e.name));
  let bad = 0, cnt = 0;
  for (let c = 0; c < doc.width * doc.length; c++) {
    for (let k = model.colStart[c]; k < model.colStart[c + 1]; k++) {
      const i = k * 3; cnt++;
      if (want.get(model.blocks[i] * 4096 + model.blocks[i + 1] + 2048) !== model.blocks[i + 2]) bad++;
    }
  }
  console.log(`往返 ${cnt} 块，不一致 ${bad} → ${cnt === bake.ents.length && bad === 0 ? '✓ 无损' : '✗ 有损'}`);

  // ---- 负向：坏产物必须抛错 ----
  const cases = [
    ['format 不符', () => prepareRedCityModel({ ...doc, format: 'nope' })],
    ['version 不符', () => prepareRedCityModel({ ...doc, version: 99 })],
    ['ground 长度不符', () => prepareRedCityModel({ ...doc, ground: [1, 2, 3] })],
    ['blocks 非三元组', () => prepareRedCityModel({ ...doc, blocks: [1, 2] })],
    ['blocks 乱序', () => prepareRedCityModel({ ...doc, blocks: [5, 0, 0, 1, 0, 0] })],
  ];
  for (const [name, fn] of cases) {
    try { fn(); console.log(`✗ ${name}：未抛错`); } catch (e) { console.log(`✓ ${name}：${e.message}`); }
  }

  // ---- 期望值（评审会话实测；参数改动后会变，不匹配时先确认 params 没被改）----
  const expect = { retained: 244647, groundMin: -5, groundMax: 43, borderNonZero: 0, outsideAdjMax: 1 };
  let ok = true;
  for (const [k, v] of Object.entries(expect)) {
    if (bake.stats[k] !== v) { console.log(`✗ ${k}: 实测 ${bake.stats[k]} ≠ 期望 ${v}`); ok = false; }
  }
  if (spawn.ox !== 138 || spawn.oz !== 141 || spawn.dy !== -3) { console.log(`✗ spawn 偏移`); ok = false; }
  console.log(ok ? '✓ 全部期望值复现' : '✗ 有偏差（见上）');

  // 可选：写出产物供人工检查（不入库；入库由 tools/bake-redcity.mjs 负责）
  if (process.env.WRITE_SAMPLE) fs.writeFileSync('/tmp/redcity-sample.json', json);
}
