// src/gen/structures/apply.js — 结构注入：fillColumn 之后、光照之前叠加结构方块（设计文档 §4.2）
// M2-1 范围：金字塔；城市/冰封山/雪地/海岛/平地随地标移植（M2-2）按 mc-lite 优先级追加。
// Worker 同构：本文件不得 import three。
import { generateHeight } from '../terrain.js';
import { getPyramidInfo, generatePyramid, makeColumnSetter } from './landmarks.js';

/**
 * 将布局覆盖本 column 的结构方块裁剪写入 column（生成路径：不记 edits、不 bump version）。
 * mc-lite 列循环优先级：city > pyramid > island > plainLand > snowLand > frozenMountain。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 * @param {*} registry
 * @param {Array<Object>} layouts 查询域内全部 region 布局（StructureIndex.layoutsForColumn）
 */
export function applyStructuresToColumn(column, seed, registry, layouts) {
  if (!layouts || layouts.length === 0) return;
  const setBlock = makeColumnSetter(column, registry);

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx;
      const wz = column.cz * 16 + lz;
      const h = generateHeight(wx, wz, seed);

      for (const layout of layouts) {
        // M2-2 在此按优先级补 city/island/plainLand/snowLand/frozenMountain 分支
        const pyInfo = getPyramidInfo(wx, wz, layout.pyramid);
        if (pyInfo) {
          generatePyramid(wx, wz, h, pyInfo, setBlock, seed);
          break; // 每点至多一个地标（mc-lite elif 链语义）
        }
      }
    }
  }
}
