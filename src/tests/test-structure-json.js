import { test } from './runner.js';
import { assertTrue, assertNotNull } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blockIndex } from '../voxel/constants.js';
import { generateHeight } from '../gen/terrain.js';
import { ISLAND_SEA_LEVEL } from '../gen/structures/region-config.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

async function genColumn(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/** 找一个不被城市吞没的有效平地（中心 biome DESERT 已由布局期判定） */
function findPlainLand() {
  const city = computeRegionLayout(0, 0, SEED).city;
  for (let rx = -4; rx <= 4; rx++) {
    for (let rz = -4; rz <= 4; rz++) {
      const l = computeRegionLayout(rx, rz, SEED);
      if (!l.plainLand) continue;
      const { cx, cz } = l.plainLand;
      if (city && cx >= city.minX - 40 && cx <= city.maxX + 40 && cz >= city.minZ - 40 && cz <= city.maxZ + 40) continue;
      return l.plainLand;
    }
  }
  return null;
}

/** 找一个有效海岛（中心塔跨 column 的几何由 JSON 占地保证） */
function findIsland() {
  for (let rx = -4; rx <= 4; rx++) {
    for (let rz = -4; rz <= 4; rz++) {
      const l = computeRegionLayout(rx, rz, SEED);
      if (l.island) return l.island;
    }
  }
  return null;
}

/**
 * 按 JSON 光栅化语义计算期望方块（worldX/Z = center + offset，y 归一化最低点=1），
 * 按 column 分组逐块比对，验证结构跨 column 完整落块（不被 chunk 切割）。
 * @param {number} minMatchRate 每 column 最低匹配率；切割 bug 会让非中心 column 匹配率归零，
 *   海岛塔允许少量树冠覆盖（mc-lite towerExclusionRadius=5 原语义），取 0.9 口径。
 */
async function assertStructureSpan(reg, file, centerX, centerY, centerZ, label, minMatchRate) {
  const data = await (await fetch(`/assets/structures/${file}`)).json();
  let minY = Infinity;
  for (const b of data.blocks) if (b.y < minY) minY = b.y;

  const expected = new Map(); // "cx,cz" → [{lx, y, lz, type}]
  for (const b of data.blocks) {
    const wx = Math.floor(centerX + b.x);
    const wy = Math.floor(centerY + (b.y - minY));
    const wz = Math.floor(centerZ + b.z);
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const key = `${cx},${cz}`;
    if (!expected.has(key)) expected.set(key, []);
    expected.get(key).push({ lx: wx - cx * 16, y: wy, lz: wz - cz * 16, type: b.type });
  }

  assertTrue(expected.size >= 2, `${label} 占地应跨多个 column（实际 ${expected.size}）`);

  for (const [key, blocks] of expected) {
    const [cx, cz] = key.split(',').map(Number);
    const col = await genColumn(reg, cx, cz);
    let matched = 0;
    let detail = '';
    for (const e of blocks) {
      const got = col.blocks[blockIndex(e.lx, e.y, e.lz)];
      if (got === reg.idOf(e.type)) matched++;
      else if (!detail) detail = `column(${key}) (${e.lx},${e.y},${e.lz}) 期望 ${e.type} 实际 id=${got}`;
    }
    const rate = matched / blocks.length;
    assertTrue(rate >= minMatchRate, `${label} column(${key}) 匹配率 ${rate.toFixed(3)} < ${minMatchRate}：${detail}`);
  }
}

test('pyramidIsland：跨 column 完整光栅化（不被 chunk 切割）', async () => {
  const reg = makeRegistry();
  const pl = findPlainLand();
  assertNotNull(pl, 'found valid plainLand');
  const h = generateHeight(pl.cx, pl.cz, SEED);
  await assertStructureSpan(reg, 'pyramid_island.json', pl.cx, h + 1, pl.cz, 'pyramidIsland', 1.0);
});

test('island tower：跨 column 完整光栅化（不被 chunk 切割）', async () => {
  const reg = makeRegistry();
  const island = findIsland();
  assertNotNull(island, 'found valid island');
  await assertStructureSpan(reg, 'tower.json', island.cx, ISLAND_SEA_LEVEL + 1, island.cz, 'tower', 0.9);
});
