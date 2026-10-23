// tools/redcity-fingerprint.mjs — RedCity 输入指纹 + 烘焙不变量断言 + 映射覆盖统计
//
// **共享模块**：烘焙脚本（tools/bake-redcity.mjs）与 `check:data` 用同一份逻辑 —— 红线 1：两处漂移会误判过期。
// 同 `icon-fingerprint.mjs` / `zombie-head-fingerprint.mjs` / `turret-armor-fingerprint.mjs` / `night-sky-fingerprint.mjs` 四个先例。
//
// 与那四个先例的**一处关键差异**：它们的指纹对象是「图案参数 + 源图内容」，本文件的指纹对象是
// 「烘焙参数 + skin/映射清单 + **schematic 内容哈希**」。schematic 是 808 KB 的外部输入，
// 必须进指纹 —— 否则换一份模型而不重烘，产物会静默过期（渲染旧地图，方块层面看不出差别）。
// ⚠️ 指纹**不覆盖算法**：改算法而不动参数时指纹不变 —— 那一类由 `tests/redcity-bake.spec.mjs` 的黄金比对兜底。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REDCITY_BASE_Y_MAX, REDCITY_DY_MAX_BUDGET } from '../src/gen/structures/region-config.js';
import { REDCITY_BAKE_PARAMS } from './redcity-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

// I4 拆两半（`baseY` 是布局期按 seed 算的，烘焙期不知道它）：
//   - 烘焙期（本文件的 assertInvariants）：`dyMax <= REDCITY_DY_MAX_BUDGET`；
//   - 布局期（redcity-layout.js）：`baseY <= REDCITY_BASE_Y_MAX`（**钳制，不抛错**）且 `baseY + dyMax < WORLD_MAX_Y`。
// 两半合起来才等价于完整 I4；只写烘焙期那一半会漏掉「baseY 意外变大」的情形。
// 两个常量定义在 `src/gen/structures/region-config.js`（本文件是 Node-only 模块，布局层 Worker 同构、浏览器单测都不能 import 它）。
// ⚠️ `WORLD_MAX_Y = 96` 是**独占**上界（合法 y 最大 95），预算必须满足 `BASE_Y_MAX + DY_MAX_BUDGET <= 95`，不是 `< 96` 就算对。
// 〔实测〕1500 个 seed 的 `baseY` 最大 = 5（仅 599、1491 两个 > 4；下限 `SEA_Y+1-GROUND_FLOOR = 4` 几乎总是生效），当前产物 `dyMax = 80`。

/**
 * 不变量断言（spec §13.4.2 / §14.2）。任一不成立即抛错 —— **烘焙不得产出违约产物**。
 *
 * 口径一览（spec §14.2）：I1 / I2 / I3 / I4（烘焙半）/ **I5 严格**（刚性分量内部保形，=0）/ **I5′**（接触占比 <0.1%）。
 * **没有 I6**：旧版 I6「建筑 footprint 内 ground 极差 ≤ 1」与本算法矛盾（算法不压平地面，只统一平移量），
 * 实测 125 个刚性分量里 104 个违反，已由 spec §14.2 作废。勿再把它加回来。
 *
 * @param {Object} bake `bakeRedCityCore` 的返回
 * @param {Object} opt
 * @param {number} opt.worldMaxY `WORLD_MAX_Y`（96）
 * @param {number} opt.contactBreakRatioMax I5′ 的占比上限（0.001 = 0.1%）
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
  // I5（严格）：同一刚性分量内任意相邻块，烘焙后 yRel 差 == 源 y 差。by-construction 恒为 0，
  //    守的是发射路径——「逐列压缩/剪切」的退化实现会让它 > 0（注入实验：504）。
  //    ⚠️ 旧 I5 只数「竖向接触」，对逐列剪切**完全无感**（同列块共用同一 S，竖向邻居永不破坏；
  //    注入逐列平移后 contactBreaks 反而从 84 变成 0）——所以单靠 I5′ 钉不住「别退化成逐列」。
  const intra = bake.checks ? bake.checks.intraCompBreaks : 0;
  if (!bake.checks) fail.push('I5 缺 bake.checks.intraCompBreaks（bakeRedCityCore 返回形状不符）');
  else if (intra !== 0) fail.push(`I5 刚性分量内部保形被破坏 ${intra} 处（疑似退化成逐列平移）`);
  // I5′ 接触占比：块与其正下方保留块的平移量不一致占比（验收口径 = 占比，不是绝对 0）
  //    实测 84 / 151,392 = 0.055%：都发生在连通体 footprint 边缘（涂色地面与分量 S 交界处），
  //    是刚性平移的固有产物，不是缺陷。
  const ratio = s.verticalContacts ? s.contactBreaks / s.verticalContacts : 0;
  if (ratio > contactBreakRatioMax) {
    fail.push(`I5′ 竖向接触平移不一致 ${s.contactBreaks}/${s.verticalContacts} = ${(ratio * 100).toFixed(3)}% > ${(contactBreakRatioMax * 100).toFixed(1)}%`);
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
