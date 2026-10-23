// tools/bake-redcity.mjs — RedCity 离线烘焙（npm run redcity）：schematic → assets/redcity/redcity.json
//
// 「烘焙」不产生任何新方块或新贴图——映射表用的全是 registry 现有方块；它只是把 76 MB 解压体的 schematic
// 离线转成紧凑数据（运行时现算要 ~0.9 s + 643 MiB RSS，且 Worker 池有 14 个各算一遍）。spec §13.5.5。
//
// 用法：node tools/bake-redcity.mjs     （加 --check：只烘焙+断言，不写盘）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchematic } from './redcity-schematic.mjs';
import {
  isEmpty, isSkin, isBuildingMat, mappingOf, SKIN_ANY_META, SKIN_META_ONLY, MAPPING_RULES, DEFAULT_BLOCK,
  REDCITY_BAKE_PARAMS, REDCITY_SPAWN_PARAMS,
} from './redcity-config.mjs';import { bakeRedCityCore, pickSpawn } from './redcity-bake-core.mjs';
import {
  assertInvariants, computeMappingCoverage, assertMappingCoverage, redcityInputFingerprint,
  REDCITY_JSON, REDCITY_SCHEM,
} from './redcity-fingerprint.mjs';
import { encodeRedCityJson } from '../src/gen/structures/redcity-data.js';
import { REDCITY_SIZE, REDCITY_FILL_BLOCK } from '../src/gen/structures/region-config.js';

/**
 * 玻璃在 mc-heavy registry 里的方块名。
 * ⚠️ 必须与 `MAPPING_RULES` 里玻璃那几行一致（`95:*` / `20:*` / `102:*` / `160:*` → 本值）；
 * `check:data` 的 `[RedCity]` 环节有一条关系式守着（「窗框判据用的名字必须在 palette 里」）。
 */
export const GLASS_BLOCK = 'glass_block';

/**
 * 烘焙并断言（不写盘）。Node 侧回归 spec 与 `check:data` 复用它——「重烘结果必须与入库产物一致」的比对就靠它。
 * @param {string} [schemPath]
 */
export function bakeFromSchematic(schemPath = REDCITY_SCHEM) {
  const sch = loadSchematic(schemPath);
  const bake = bakeRedCityCore(sch, {
    isEmpty, isSkin, isBuilding: isBuildingMat, nameOf: (key) => mappingOf(key).name, params: REDCITY_BAKE_PARAMS,
    fillBlock: REDCITY_FILL_BLOCK, glassBlock: GLASS_BLOCK,
  });
  if (bake.width !== REDCITY_SIZE.X || bake.length !== REDCITY_SIZE.Z) {
    throw new Error(`redcity: 烘焙包围盒 ${bake.width}×${bake.length} ≠ region-config 的 REDCITY_SIZE ${REDCITY_SIZE.X}×${REDCITY_SIZE.Z}`);
  }
  const spawn = pickSpawn(bake, REDCITY_SPAWN_PARAMS);
  if (!spawn) throw new Error('redcity: 找不到满足判据的出生点');
  const invariants = assertInvariants(bake);
  const coverage = assertMappingCoverage(computeMappingCoverage({ mappingOf, grid: sch.grid }));
  const fingerprint = redcityInputFingerprint({
    params: REDCITY_BAKE_PARAMS, spawnParams: REDCITY_SPAWN_PARAMS,
    skin: { anyMeta: SKIN_ANY_META, metaOnly: SKIN_META_ONLY },
    mappingRules: MAPPING_RULES, defaultBlock: DEFAULT_BLOCK, schemBytes: fs.readFileSync(schemPath),
  });
  const doc = {
    ...encodeRedCityJson(bake, spawn),
    params: REDCITY_BAKE_PARAMS, spawnParams: REDCITY_SPAWN_PARAMS, invariants,
    coverage: { uncovered: coverage.uncovered, uncoveredRatio: coverage.uncoveredRatio, bigUncovered: coverage.bigUncovered },
    fingerprint,
    // 不写 bakedAt：其它四个烘焙产物都没有时间戳；时间戳会让每次重烘产生无意义 diff，也让「重烘应字节一致」的校验失去意义
  };
  return { doc, bake, spawn, invariants, coverage, fingerprint };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const { doc, bake, spawn, invariants, coverage, fingerprint } = bakeFromSchematic();
  console.log(`烘焙 ${Date.now() - t0} ms`);
  console.log(`不变量 I1=${invariants.i1} I2=${invariants.i2} I3=${invariants.i3} I4 dyMax=${invariants.i4DyMax}/预算${invariants.i4Budget} I5=0(严格) I5′=${(invariants.i5Ratio * 100).toFixed(3)}%`);
  console.log(`映射覆盖：未覆盖 ${coverage.uncovered} 块（${(coverage.uncoveredRatio * 100).toFixed(2)}%），块数≥50 未映射 ${coverage.bigUncovered.length} 项`);
  console.log(`产物 ${doc.width}×${doc.length}，${bake.ents.length} 块，palette ${doc.palette.length} 项`);
  console.log(`spawn ox=${spawn.ox} oz=${spawn.oz} dy=${spawn.dy}（距中心 ${spawn.d.toFixed(2)} 格）`);
  console.log(`指纹 ${fingerprint.slice(0, 16)}`);
  if (process.argv.includes('--check')) {
    console.log('（--check：未写盘）');
  } else {
    fs.mkdirSync(path.dirname(REDCITY_JSON), { recursive: true });
    fs.writeFileSync(REDCITY_JSON, JSON.stringify(doc));
    console.log(`已写出 ${path.relative(process.cwd(), REDCITY_JSON)}（${(fs.statSync(REDCITY_JSON).size / 1048576).toFixed(2)} MiB）`);
  }
}
