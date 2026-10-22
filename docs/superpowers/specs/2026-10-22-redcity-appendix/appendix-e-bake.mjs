// 附录 E：烘焙主流程与输入指纹
//
// 实施时本文件的内容要落到：
//   - 主流程 + 不变量断言 + 写盘 → `tools/bake-redcity.mjs`（`npm run redcity`）
//   - 指纹逻辑 → `tools/redcity-fingerprint.mjs`（**共享模块**：烘焙脚本与 `check:data`
//     同一份逻辑，红线 1 —— 两处漂移会误判过期。同 `icon-fingerprint.mjs` /
//     `zombie-head-fingerprint.mjs` / `turret-armor-fingerprint.mjs` / `night-sky-fingerprint.mjs` 四个先例）
//
// 与那四个先例的**一处关键差异**：它们的指纹对象是「图案参数 + 源图内容」，本文件的指纹对象是
// 「烘焙参数 + skin/映射清单 + **schematic 内容哈希**」。schematic 是 808 KB 的外部输入，
// 必须进指纹 —— 否则换一份模型而不重烘，产物会静默过期（渲染旧地图，方块层面看不出差别）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');

/**
 * 产物路径（唯一权威；`check:data` 从这里读）。
 *
 * 单文件：数据 + 指纹 + 不变量实测值同居 `redcity.json`（同 `icons.json` / `head.json` /
 * `armor.json` / `night-sky.json` 四个先例的「产物 + 伴随指纹」口径）。
 * 指纹只占 ~64 字节，Worker fetch 时多带它无成本；拆两个文件反而让 `check:data`
 * 要读两处、且两者可能不同步（红线 1）。
 */
export const REDCITY_JSON = path.join(ROOT, 'assets', 'redcity', 'redcity.json');
export const REDCITY_SCHEM = path.join(ROOT, 'assets', 'redcity', 'src', 'SakuraSpawn.schematic');

/**
 * 烘焙参数（唯一权威）。
 *
 * ⚠️ 这七个值是**实测/实玩标定值**，不是推导值（同 `SKY_TREE_CHANCE`、`BOB.amplitude` 的性质）：
 *   - `relief` 0.34：竖直压缩系数。实测它对预算几乎无影响（0.2/0.25/0.34/0.5 下 opaque 占比
 *     108/108/108/109%），**纯观感参数** —— 调它只为「宝塔不被压扁」与「台阶不太陡」的平衡。
 *   - `K` 2：地面往下保留层数。K=1 会让挑檐底部露空；K=3 多留 58,554 块但几何成本涨 5%。
 *   - `groundFloor` -5：= `REDCITY_GROUND_FLOOR`（`region-config.js`）。实测下限必须是 -5：
 *     取 -12 时边界台阶>2 的占比中位约 54%（撞破 R4），取 -5 时中位 0% / 最差 4.0%。
 *   - `decay` 2：岛外地面外推「每 2 格降 1」。
 *   - `pad` 1：建筑 footprint 外扩（平台化范围）。
 *   - `minComp` 30：小于 30 块的建筑连通体不做刚性平移（碎片不值得）。
 *   - `borderKeep` 8：距矩形边缘 8 格内的连通体不刚性（边缘地面必须收敛到 0，见 I2）。
 *
 * **改任何一个都必须重跑 `npm run redcity`**，否则产物静默过期（`check:data` 的指纹环节会抓）。
 */
export const REDCITY_BAKE_PARAMS = Object.freeze({
  relief: 0.34,
  K: 2,
  groundFloor: -5,
  decay: 2,
  pad: 1,
  minComp: 30,
  borderKeep: 8,
});

/** 出生点判据参数（spec §13.6.1） */
export const REDCITY_SPAWN_PARAMS = Object.freeze({
  headroom: 24,     // 本列头顶净空
  wallClear: 3,     // 5×5 邻域每列头顶净空（防贴墙/树冠）
  flatRange: 1,     // 5×5 内 ground 极差上限
  halfWin: 2,       // 5×5 窗口半宽
});

/**
 * 输入指纹：烘焙参数 + skin/映射清单 + schematic 内容哈希。
 *
 * @param {Object} deps 注入项（便于单测替换）
 * @param {Object} deps.params `REDCITY_BAKE_PARAMS`
 * @param {Object} deps.spawnParams `REDCITY_SPAWN_PARAMS`
 * @param {Object} deps.skin `{ anyMeta: number[], metaOnly: Object }`
 * @param {Array} deps.mappingRules `MAPPING_RULES`
 * @param {string} deps.defaultBlock `DEFAULT_BLOCK`
 * @param {Buffer} deps.schemBytes schematic 原始字节
 * @returns {string} sha256 hex（前 16 位入库，全量用于比对）
 */
export function redcityInputFingerprint({ params, spawnParams, skin, mappingRules, defaultBlock, schemBytes }) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(params));
  h.update(JSON.stringify(spawnParams));
  h.update(JSON.stringify(skin));
  h.update(JSON.stringify(mappingRules));
  h.update(defaultBlock);
  h.update(schemBytes);
  return h.digest('hex');
}

/**
 * `dyMax` 的烘焙期预算上限。
 *
 * ⚠️ **为什么需要这个常量**：I4（`baseY + dyMax < WORLD_MAX_Y`）的完整判据依赖 `baseY`，
 * 而 `baseY` 是**布局期**按 seed 算的（`redcity-layout.js`）—— 烘焙期不知道它。故 I4 拆两半：
 *   - **烘焙期**（本文件）：断言 `dyMax <= REDCITY_DY_MAX_BUDGET`；
 *   - **布局期**（Task 3）：断言 `baseY + doc.dyMax < WORLD_MAX_Y`。
 * 两半合起来才等价于完整 I4。只写烘焙期那一半会漏掉「baseY 意外变大」的情形。
 *
 * 取值依据：实测 1500 个 seed 的 `baseY` 最大 = **5**（仅 2 个 seed > 4；下限
 * `SEA_Y+1-GROUND_FLOOR = 4` 几乎总是生效）。取 8 留 3 格余量。
 *
 * ⚠️ **`WORLD_MAX_Y = 96` 是独占上界**（合法 y 最大 95），故预算必须满足
 * `REDCITY_BASE_Y_MAX + REDCITY_DY_MAX_BUDGET <= 95`，**不是 < 96 就算对**。
 * 实测当前产物 `dyMax = 80` → 在 `baseY ≤ 7` 时余量 ≥ 8 格。
 */
export const REDCITY_DY_MAX_BUDGET = 87;

/**
 * 布局期 `baseY` 的假定上界（与 `REDCITY_DY_MAX_BUDGET` 配对：8 + 87 = 95 = WORLD_MAX_Y - 1）。
 *
 * 实测 1500 seed 的 `baseY` 最大为 5，取 8 留余量。**布局期（Task 3）必须断言
 * `baseY <= REDCITY_BASE_Y_MAX`** —— 否则本文件的烘焙期断言失去前提（两半合起来才是完整 I4）。
 */
export const REDCITY_BASE_Y_MAX = 8;

/**
 * 不变量断言（spec §13.4.2 / §13.4.4）。任一不成立即抛错 —— **烘焙不得产出违约产物**。
 *
 * @param {Object} bake `bakeRedCityCore` 的返回
 * @param {Object} opt
 * @param {number} opt.worldMaxY `WORLD_MAX_Y`（96）
 * @param {number} opt.contactBreakRatioMax I5 的占比上限（0.001 = 0.1%）
 */
export function assertInvariants(bake, { worldMaxY = 96, contactBreakRatioMax = 0.001 } = {}) {
  const s = bake.stats;
  const fail = [];

  // I1 岛外相邻格 |Δground| ≤ 1（岛外无断崖）
  if (s.outsideAdjMax > 1) fail.push(`I1 岛外相邻高差 ${s.outsideAdjMax} > 1`);
  // I2 矩形边界一圈 ground == 0（核心边缘高度恒为 baseY，过渡环只需处理 baseY 与自然地形之差）
  if (s.borderNonZero !== 0) fail.push(`I2 边界非零 ground 列数 ${s.borderNonZero} ≠ 0`);
  // I3 岛内 ground ≥ GROUND_FLOOR（岛最低处是干地）
  if (s.groundMin < REDCITY_BAKE_PARAMS.groundFloor) {
    fail.push(`I3 groundMin ${s.groundMin} < GROUND_FLOOR ${REDCITY_BAKE_PARAMS.groundFloor}`);
  }
  // I4（烘焙期半）：dyMax 不超预算 → 保证 baseY ≤ REDCITY_BASE_Y_MAX 时装得进世界。
  // 完整 I4 的另一半（baseY + dyMax < WORLD_MAX_Y）在布局期断言，见 REDCITY_DY_MAX_BUDGET 注释。
  if (bake.dyMax > REDCITY_DY_MAX_BUDGET) {
    fail.push(`I4 dyMax ${bake.dyMax} > 预算 ${REDCITY_DY_MAX_BUDGET}（baseY=${REDCITY_BASE_Y_MAX} 时会顶穿 WORLD_MAX_Y=${worldMaxY}）`);
  }
  if (REDCITY_BASE_Y_MAX + REDCITY_DY_MAX_BUDGET > worldMaxY - 1) {
    fail.push(`I4 常量自相矛盾：BASE_Y_MAX(${REDCITY_BASE_Y_MAX}) + DY_MAX_BUDGET(${REDCITY_DY_MAX_BUDGET}) = ${REDCITY_BASE_Y_MAX + REDCITY_DY_MAX_BUDGET} > WORLD_MAX_Y-1(${worldMaxY - 1})`);
  }
  // I5 建筑体内相邻块相对高差保持（刚性平移的验收口径 = 占比，不是绝对 0）
  //    实测 84 / 151,392 = 0.055%：都发生在连通体 footprint 边缘（涂色地面与分量 S 交界处），
  //    是刚性平移的固有产物，不是缺陷。
  const ratio = s.verticalContacts ? s.contactBreaks / s.verticalContacts : 0;
  if (ratio > contactBreakRatioMax) {
    fail.push(`I5 相邻块平移不一致 ${s.contactBreaks}/${s.verticalContacts} = ${(ratio * 100).toFixed(3)}% > ${(contactBreakRatioMax * 100).toFixed(1)}%`);
  }
  if (fail.length) throw new Error(`redcity: 烘焙不变量违约\n  - ${fail.join('\n  - ')}`);
  return {
    i1: s.outsideAdjMax, i2: s.borderNonZero, i3: s.groundMin,
    i4DyMax: bake.dyMax, i4Budget: REDCITY_DY_MAX_BUDGET, i5Ratio: ratio,
  };
}

/**
 * 映射覆盖率统计（spec §13.5.3 ③）。
 *
 * 门禁：块数 ≥50 的 (id:meta) 必须全部被显式映射（`explicit: true`）；
 * 未覆盖（落入 `DEFAULT_BLOCK`）的合计占比 ≤ 0.5%。
 *
 * ⚠️ 这条本可以抓到 `252:8`（37 万块，岛体最大头）在调研草稿里缺席 —— 故必须进指纹环节。
 *
 * ⚠️ **只统计被保留的方块**：`air`(0) 与 `barrier`(166) 是**有意丢弃**的（spec §13.5.4 第 3 条），
 * 不算「未覆盖」。否则 barrier 的 17,804 块会污染占比（实测 1.23% → 排除后 < 0.01%）。
 * 同理，被丢弃的还有「地面以下 K 层之外的 skin」—— 但那些是 skin（已显式映射），不影响覆盖率。
 *
 * @param {Object} deps
 * @param {(key:number)=>{name:string,explicit:boolean}} deps.mappingOf
 * @param {Uint16Array} deps.grid schematic 网格
 * @param {number} [deps.minCount=50]
 * @returns {{covered:number, uncovered:number, uncoveredRatio:number, bigUncovered:Array}}
 */
export function computeMappingCoverage({ mappingOf, grid, minCount = 50 }) {
  const counts = new Map();
  for (let i = 0; i < grid.length; i++) {
    const key = grid[i];
    if (!key) continue;                       // air
    if ((key >> 4) === 166) continue;         // barrier：有意丢弃，不算未覆盖
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let covered = 0, uncovered = 0;
  const bigUncovered = [];
  for (const [key, n] of counts) {
    const { explicit } = mappingOf(key);
    if (explicit) covered += n;
    else {
      uncovered += n;
      if (n >= minCount) bigUncovered.push({ key: `${key >> 4}:${key & 15}`, count: n });
    }
  }
  const total = covered + uncovered;
  return {
    covered, uncovered,
    uncoveredRatio: total ? uncovered / total : 0,
    bigUncovered: bigUncovered.sort((a, b) => b.count - a.count),
  };
}

/** 覆盖率门禁断言（spec §13.5.3 ③）。不满足即抛错。 */
export function assertMappingCoverage(cov, { maxUncoveredRatio = 0.005 } = {}) {
  const fail = [];
  if (cov.bigUncovered.length) {
    fail.push(`块数 ≥50 的 (id:meta) 未显式映射：${cov.bigUncovered.map((b) => `${b.key}(${b.count})`).join(', ')}`);
  }
  if (cov.uncoveredRatio > maxUncoveredRatio) {
    fail.push(`未覆盖占比 ${(cov.uncoveredRatio * 100).toFixed(2)}% > ${(maxUncoveredRatio * 100).toFixed(1)}%`);
  }
  if (fail.length) throw new Error(`redcity: 映射覆盖违约\n  - ${fail.join('\n  - ')}`);
  return cov;
}

// ==================== 自检（跑本文件即执行完整烘焙）====================

if (process.argv[1] && process.argv[1].endsWith('appendix-e-bake.mjs')) {
  const { loadSchematic } = await import('./appendix-a-schematic.mjs');
  const { isSkin, isBuildingMat, mappingOf, SKIN_ANY_META, SKIN_META_ONLY, MAPPING_RULES, DEFAULT_BLOCK } =
    await import('./appendix-b-mapping.mjs');
  const { bakeRedCityCore, pickSpawn } = await import('./appendix-c-bake-core.mjs');
  const { encodeRedCityJson, REDCITY_JSON_FORMAT } = await import('./appendix-d-json.mjs');

  const t0 = Date.now();
  const sch = loadSchematic(REDCITY_SCHEM);
  const bake = bakeRedCityCore(sch, {
    isEmpty: (v) => (v >> 4) === 0 || (v >> 4) === 166,
    isSkin, isBuilding: isBuildingMat, nameOf: (v) => mappingOf(v).name,
    params: REDCITY_BAKE_PARAMS,
  });
  const spawn = pickSpawn(bake, REDCITY_SPAWN_PARAMS);
  if (!spawn) throw new Error('redcity: 找不到满足判据的出生点');

  const inv = assertInvariants(bake);
  const cov = assertMappingCoverage(computeMappingCoverage({ mappingOf, grid: sch.grid }));
  const doc = encodeRedCityJson(bake, spawn);
  const schemBytes = fs.readFileSync(REDCITY_SCHEM);
  const fingerprint = redcityInputFingerprint({
    params: REDCITY_BAKE_PARAMS, spawnParams: REDCITY_SPAWN_PARAMS,
    skin: { anyMeta: SKIN_ANY_META, metaOnly: SKIN_META_ONLY },
    mappingRules: MAPPING_RULES, defaultBlock: DEFAULT_BLOCK, schemBytes,
  });

  console.log(`烘焙 ${(Date.now() - t0)} ms`);
  console.log(`不变量 I1=${inv.i1} I2=${inv.i2} I3=${inv.i3} I4 dyMax=${inv.i4DyMax}/预算${inv.i4Budget} I5=${(inv.i5Ratio * 100).toFixed(3)}%`);
  console.log(`映射覆盖：未覆盖 ${cov.uncovered} 块（${(cov.uncoveredRatio * 100).toFixed(2)}%），块数≥50 未映射 ${cov.bigUncovered.length} 项`);
  console.log(`产物 ${doc.width}×${doc.length}，${bake.ents.length} 块，palette ${doc.palette.length} 项`);
  console.log(`spawn ox=${spawn.ox} oz=${spawn.oz} dy=${spawn.dy}（距中心 ${spawn.d.toFixed(2)} 格）`);
  console.log(`指纹 ${fingerprint.slice(0, 16)}`);
  console.log('✓ 不变量 I1–I5 与映射覆盖均通过（任一违约会在上方抛错并 exit 非 0）');

  if (process.env.WRITE) {
    fs.mkdirSync(path.dirname(REDCITY_JSON), { recursive: true });
    // 指纹与不变量写进同一份产物（运行时 `prepareRedCityModel` 忽略这些额外字段）
    const out = {
      ...doc,
      params: REDCITY_BAKE_PARAMS,
      spawnParams: REDCITY_SPAWN_PARAMS,
      invariants: inv,
      coverage: { uncovered: cov.uncovered, uncoveredRatio: cov.uncoveredRatio, bigUncovered: cov.bigUncovered },
      fingerprint,
      bakedAt: new Date().toISOString(),
    };
    fs.writeFileSync(REDCITY_JSON, JSON.stringify(out));
    console.log(`已写出 ${path.relative(ROOT, REDCITY_JSON)}（${(fs.statSync(REDCITY_JSON).size / 1048576).toFixed(2)} MiB）`);
  } else {
    console.log('（未写盘；加 WRITE=1 写出产物）');
  }
}
