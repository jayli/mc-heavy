import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { computeSkylightColumn } from '../mesh/lighting.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WORLD_MIN_Y, SEA_Y, blockIndex } from '../voxel/constants.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

function genColumnWithCaves(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  return col;
}

/** 统计 column 内洞穴空气格（地表-4 以下、基岩+4 以上） */
function countCaveAir(col) {
  let n = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const h = generateHeight(col.cx * 16 + lx, col.cz * 16 + lz, SEED);
    const top = Math.min(h - 4, 90);
    for (let y = WORLD_MIN_Y + 4; y <= top; y++) {
      if (col.blocks[blockIndex(lx, y, lz)] === 0) n++;
    }
  }
  return n;
}

test('洞穴存在：采样 column 有地表以下空气格', () => {
  const reg = makeRegistry();
  let total = 0;
  for (let cx = 0; cx < 6 && total === 0; cx++) {
    for (let cz = 0; cz < 6 && total === 0; cz++) {
      total = countCaveAir(genColumnWithCaves(reg, cx, cz));
    }
  }
  assertTrue(total > 0, `cave air cells: ${total}`);
});

test('洞穴不穿透基岩：WORLD_MIN_Y+3 以下无空气', () => {
  const reg = makeRegistry();
  for (let cx = 0; cx < 6; cx++) {
    for (let cz = 0; cz < 6; cz++) {
      const col = genColumnWithCaves(reg, cx, cz);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        for (let y = WORLD_MIN_Y; y <= WORLD_MIN_Y + 3; y++) {
          assertTrue(col.blocks[blockIndex(lx, y, lz)] !== 0, `bedrock intact at ${y}`);
        }
      }
    }
  }
});

test('洞穴不破坏地表：h-3 以上地层完整（surface 未被挖穿）', () => {
  const reg = makeRegistry();
  for (let cx = 0; cx < 4; cx++) {
    for (let cz = 0; cz < 4; cz++) {
      const col = genColumnWithCaves(reg, cx, cz);
      for (let lx = 0; lx < 16; lx += 5) for (let lz = 0; lz < 16; lz += 5) {
        const h = generateHeight(col.cx * 16 + lx, col.cz * 16 + lz, SEED);
        if (h >= SEA_Y) assertTrue(col.blocks[blockIndex(lx, h, lz)] !== 0, `surface at ${h} intact`);
      }
    }
  }
});

test('洞穴内全黑：封闭洞穴 skylight=0', () => {
  const reg = makeRegistry();
  let caveCell = null;
  let col = null;
  for (let cx = 0; cx < 6 && !caveCell; cx++) {
    for (let cz = 0; cz < 6 && !caveCell; cz++) {
      col = genColumnWithCaves(reg, cx, cz);
      for (let lx = 0; lx < 16 && !caveCell; lx++) for (let lz = 0; lz < 16 && !caveCell; lz++) {
        const h = generateHeight(col.cx * 16 + lx, col.cz * 16 + lz, SEED);
        for (let y = WORLD_MIN_Y + 4; y <= Math.min(h - 4, 90); y++) {
          if (col.blocks[blockIndex(lx, y, lz)] === 0) { caveCell = { lx, y, lz }; break; }
        }
      }
    }
  }
  assertTrue(caveCell !== null, 'found cave cell');
  computeSkylightColumn(col, reg);
  assertEqual(col.light[blockIndex(caveCell.lx, caveCell.y, caveCell.lz)] >> 4, 0, 'cave skylight 0');
});

test('洞穴确定性：两次 carve 逐格一致', () => {
  const reg = makeRegistry();
  const a = genColumnWithCaves(reg, 1, 1);
  const b = genColumnWithCaves(reg, 1, 1);
  for (let i = 0; i < a.blocks.length; i++) assertEqual(a.blocks[i], b.blocks[i], `block ${i}`);
});
