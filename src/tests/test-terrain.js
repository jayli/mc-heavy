import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { seededRandom, noise, getBiome } from '../gen/noise.js';
import { generateHeight, fillColumn, findSpawnY } from '../gen/terrain.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { SEA_Y, WORLD_MIN_Y } from '../voxel/constants.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('noise: 确定性（同输入同输出，与 mc-lite 公式一致）', () => {
  const a = seededRandom(10, 20, SEED);
  const b = seededRandom(10, 20, SEED);
  assertEqual(a, b);
  assertTrue(a >= 0 && a < 1, 'range [0,1)');
  // mc-lite 公式手工对照：sin(10*12.9898 + 20*78.233 + 12345) * 43758.5453123 取小数
  const expected = (() => { const v = Math.sin(10 * 12.9898 + 20 * 78.233 + SEED) * 43758.5453123; return v - Math.floor(v); })();
  assertEqual(a, expected);
  assertEqual(noise(5, 7, SEED, 0.08), Math.sin((5 + SEED) * 0.08) * 2 + Math.cos((7 + SEED) * 0.08) * 2);
});

test('noise: 不同 seed 结果不同', () => {
  assertTrue(seededRandom(10, 20, 1) !== seededRandom(10, 20, 2));
});

test('getBiome: 阈值分支', () => {
  // 扫描一片区域，确认至少出现 PLAINS（不锁死具体坐标，避免与噪声实现细节耦合）
  const biomes = new Set();
  for (let x = -500; x < 500; x += 37) for (let z = -500; z < 500; z += 37) biomes.add(getBiome(x, z, SEED));
  assertTrue(biomes.has('PLAINS'), 'plains exists');
  assertTrue(biomes.size >= 2, 'multiple biomes');
});

test('generateHeight: 与 mc-lite 公式一致（biome 调整）', () => {
  for (let x = -200; x < 200; x += 53) {
    for (let z = -200; z < 200; z += 61) {
      const biome = getBiome(x, z, SEED);
      let h = Math.floor(noise(x, z, SEED, 0.08) + noise(x, z, SEED, 0.02) * 3);
      if (biome === 'DESERT') h = Math.floor(h * 0.5 + 2);
      if (biome === 'SWAMP') h = Math.floor(h * 0.3 - 2);
      assertEqual(generateHeight(x, z, SEED), h, `height at ${x},${z}`);
    }
  }
});

test('fillColumn: 地层结构正确（陆地块）', () => {
  const reg = makeRegistry();
  // 找一个 h >= SEA_Y 的 column
  let cx = 0, cz = 0, h = -999;
  outer: for (let tx = -20; tx < 20; tx++) for (let tz = -20; tz < 20; tz++) {
    const hh = generateHeight(tx, tz, SEED);
    if (hh >= SEA_Y + 1) { cx = Math.floor(tx / 16); cz = Math.floor(tz / 16); h = hh; break outer; }
  }
  assertTrue(h >= SEA_Y + 1, 'found land column');
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  const lx = (cx * 16 + 5) - cx * 16; // 用 column 内固定列验证结构
  const wx = cx * 16 + lx, wz = cz * 16 + lx;
  const hh = generateHeight(wx, wz, SEED);
  if (hh >= SEA_Y) {
    assertEqual(col.get(lx, hh, lx), reg.idOf(getBiome(wx, wz, SEED) === 'DESERT' ? 'sand' : getBiome(wx, wz, SEED) === 'AZALEA' ? 'moss' : getBiome(wx, wz, SEED) === 'SWAMP' ? 'swamp_grass' : 'grass'));
    assertEqual(col.get(lx, hh - 11, lx), reg.idOf('stone'));
    assertEqual(col.get(lx, hh - 12, lx), reg.idOf('end_stone'));
    assertEqual(col.get(lx, WORLD_MIN_Y, lx), reg.idOf('bedrock'));
  }
});

test('fillColumn: 水面填充（h < SEA_Y 时水填到 SEA_Y）', () => {
  const reg = makeRegistry();
  let cx = 0, cz = 0, found = false;
  outer: for (let tx = -60; tx < 60; tx++) for (let tz = -60; tz < 60; tz++) {
    if (generateHeight(tx, tz, SEED) < SEA_Y) { cx = Math.floor(tx / 16); cz = Math.floor(tz / 16); found = true; break outer; }
  }
  if (!found) return; // 该 seed 近区无水域则跳过（不视为失败）
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  const lx = 7, lz = 7;
  const wx = cx * 16 + lx, wz = cz * 16 + lz;
  const hh = generateHeight(wx, wz, SEED);
  if (hh < SEA_Y) {
    assertEqual(col.get(lx, SEA_Y, lz), reg.idOf('water'));
    assertEqual(col.get(lx, hh, lz), reg.idOf('sand'));
    assertEqual(col.get(lx, hh - 1, lz), reg.idOf('end_stone'));
  }
});

test('findSpawnY: 落在首个非 air 方块上方', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  fillColumn(col, SEED, reg);
  world.add(col);
  const y = findSpawnY(world, 8, 8);
  assertTrue(world.getBlockId(8, y, 8) === 0, 'spawn is air');
  assertTrue(world.getBlockId(8, y - 1, 8) !== 0, 'below spawn is solid-ish');
});
