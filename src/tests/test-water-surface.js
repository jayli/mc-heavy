// src/tests/test-water-surface.js — 水面高度与水下判据（Tier 1，用户 2026-11-22 裁定）
//
// 四项要求的共同判据：落叶 / 雨滴 / 水花 / 湿地面反光都不得出现在水面以下。
// 判据走 registry 的表（非实心 ∧ transparent 通道 = 水体），**不写名字白名单**（红线 1）。
//
// ⚠️ 水面顶面 = 水格 y+1 − WATER_SURFACE_SINK（mesher 的暴露水面下沉），
// 与海面平面 WATER_LEVEL_OFFSET 严格共面 —— 本文件用**真实 fillColumn** 钉住这件事，
// 而不是拿常量互推（那样恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertNull } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { SEA_Y, WORLD_MIN_Y, WATER_SURFACE_SINK } from '../voxel/constants.js';
import {
  isWaterLike, waterSurfaceYAt, isBelowWater, WATER_SURFACE_Y,
} from '../render/water-surface.js';

const REG = createRegistry();
for (const def of BLOCKS) REG.register(def.name, def);
REG.freeze();
const id = (n) => REG.idOf(n);

/** 假 world：按 Map<'x,y,z', blockId> 回答，其余 air */
function fakeWorld(cells) {
  return {
    getBlockId(x, y, z) {
      if (y < WORLD_MIN_Y) return id('bedrock');
      return cells.get(`${x},${y},${z}`) ?? 0;
    },
  };
}
function put(cells, x, y, z, name) { cells.set(`${x},${y},${z}`, id(name)); }

// ---------- 水体判据（派生而非名字白名单）----------

test('water surface: 水体判据 = 非实心 ∧ transparent 通道，恰好命中两种水', () => {
  const hit = BLOCKS.filter((b) => isWaterLike(id(b.name), REG)).map((b) => b.name).sort();
  assertEqual(hit.join(','), 'swamp_water,water',
    `水体集合必须恰好是两种水（实得 ${hit.join(',')}）`);
});

test('water surface: 玻璃不算水体（它是 transparent 但 solid=true）', () => {
  for (const n of ['glass_block', 'glass_blink']) {
    assertEqual(REG.cullTable[id(n)], 2, `${n} 确实是 transparent 通道`);
    assertFalse(isWaterLike(id(n), REG), `${n} 是实心玻璃，不是水`);
  }
});

test('water surface: 空气 / 云 / 树叶 / 花草都不算水体', () => {
  for (const n of ['air', 'cloud', 'leaves', 'flower', 'short_grass', 'stone', 'sand']) {
    assertFalse(isWaterLike(id(n), REG), `${n} 不该被判成水`);
  }
});

test('water surface: 非法 id 不崩、返回 false', () => {
  for (const bad of [-1, 0, 99999, NaN, undefined, null, 1.5]) {
    assertFalse(isWaterLike(bad, REG), `${bad} 应返回 false`);
  }
});

// ---------- 水面高度 ----------

test('water surface: 暴露水面顶面 = 水格 y+1 − SINK（不是格顶）', () => {
  const cells = new Map();
  put(cells, 4, SEA_Y, 4, 'water');
  put(cells, 4, SEA_Y - 1, 4, 'sand');
  const w = fakeWorld(cells);
  const y = waterSurfaceYAt(w, REG, 4.5, 4.5, SEA_Y + 6);
  assertEqual(y, SEA_Y + 1 - WATER_SURFACE_SINK,
    '水面顶面必须扣掉 mesher 的下沉量（否则雨丝会停在半格空气里）');
});

test('water surface: 多层水只取最上层水面（沉在水下的水格不算水面）', () => {
  const cells = new Map();
  for (let y = SEA_Y - 5; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  put(cells, 4, SEA_Y - 6, 4, 'sand');
  const w = fakeWorld(cells);
  const y = waterSurfaceYAt(w, REG, 4.5, 4.5, SEA_Y + 6);
  assertEqual(y, SEA_Y + 1 - WATER_SURFACE_SINK, '必须取最上层，不能取中间某层');
});

test('water surface: 无水列返回 null（不回落玩家 y 或世界底）', () => {
  const cells = new Map();
  put(cells, 4, 10, 4, 'stone');
  const w = fakeWorld(cells);
  assertNull(waterSurfaceYAt(w, REG, 4.5, 4.5, 20), '陆地列没有水面');
});

test('water surface: 水被实心方块盖住时不算暴露水面（屋内积水不该截停雨）', () => {
  const cells = new Map();
  put(cells, 4, SEA_Y, 4, 'water');
  put(cells, 4, SEA_Y + 1, 4, 'stone');   // 盖住
  const w = fakeWorld(cells);
  assertNull(waterSurfaceYAt(w, REG, 4.5, 4.5, SEA_Y + 6),
    '上方是实心 ⇒ 不是暴露水面（同 mesher 的 waterSurface 判据）');
});

test('water surface: x/z 必须取整（玩家坐标恒带 .5）', () => {
  const cells = new Map();
  put(cells, 4, SEA_Y, 4, 'water');
  const w = fakeWorld(cells);
  assertEqual(waterSurfaceYAt(w, REG, 4.9, 4.1, SEA_Y + 6), SEA_Y + 1 - WATER_SURFACE_SINK,
    '小数坐标必须落到同一格（不取整会读成 air ⇒ 判据恒 null）');
});

// ---------- 水下判定 ----------

test('water surface: 水下判定以水面为界（水面上方不算水下）', () => {
  const cells = new Map();
  for (let y = SEA_Y - 4; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  put(cells, 4, SEA_Y - 5, 4, 'sand');
  const w = fakeWorld(cells);
  const surf = SEA_Y + 1 - WATER_SURFACE_SINK;
  assertTrue(isBelowWater(w, REG, 4.5, surf - 0.2, 4.5), '水面之下 ⇒ 水下');
  assertFalse(isBelowWater(w, REG, 4.5, surf + 0.2, 4.5), '水面之上 ⇒ 非水下');
  assertFalse(isBelowWater(w, REG, 4.5, surf, 4.5), '恰好共面不算水下（边界不抖）');
});

test('water surface: 陆地上的点恒非水下（哪怕 y 很低）', () => {
  const cells = new Map();
  put(cells, 4, 0, 4, 'stone');
  const w = fakeWorld(cells);
  assertFalse(isBelowWater(w, REG, 4.5, -1, 4.5), '无水列 ⇒ 不是水下');
  assertFalse(isBelowWater(w, REG, 4.5, -20, 4.5), '再低也不是水下（没有水面）');
});

// ---------- 共面性：用真实 fillColumn 钉住，而不是常量互推 ----------

test('water surface: 真实地形的暴露水面恒共面于 WATER_SURFACE_Y（③ 常量方案的前提）', () => {
  const world = new WorldData(REG);
  const SEED = 12345;
  let waterCols = 0;
  const heights = new Set();
  // 扫一片区域找真的有水的列（seed 12345 出生带附近）
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, SEED, REG);
      world.add(col);
      // 该列是否有暴露水体
      let top = null;
      for (let lx = 0; lx < 16; lx += 5) {
        for (let lz = 0; lz < 16; lz += 5) {
          const wx = cx * 16 + lx, wz = cz * 16 + lz;
          const h = generateHeight(wx, wz, SEED);
          if (h >= SEA_Y) continue;
          const y = waterSurfaceYAt(world, REG, wx + 0.5, wz + 0.5, SEA_Y + 8);
          if (y !== null) { heights.add(y); top = y; }
        }
      }
      if (top !== null) waterCols++;
    }
  }
  assertTrue(waterCols > 0, `必须有真的含水列（实得 ${waterCols}），否则断言恒真`);
  assertEqual(heights.size, 1,
    `暴露水面必须只有一个高度（实得 ${[...heights].join(',')}）—— 否则 ③ 的常量门不成立`);
  assertEqual([...heights][0], WATER_SURFACE_Y, '该高度必须等于导出的 WATER_SURFACE_Y');
  assertEqual(WATER_SURFACE_Y, SEA_Y + 1 - WATER_SURFACE_SINK, '派生关系式');
});

test('water surface: 真实地形里湖底确实在水面之下（③ 有判别力）', () => {
  const world = new WorldData(REG);
  const SEED = 12345;
  let below = 0, above = 0;
  for (let cx = -6; cx <= 6; cx++) {
    for (let cz = -6; cz <= 6; cz++) {
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, SEED, REG);
      world.add(col);
      for (let lx = 0; lx < 16; lx += 5) {
        for (let lz = 0; lz < 16; lz += 5) {
          const wx = cx * 16 + lx, wz = cz * 16 + lz;
          const h = generateHeight(wx, wz, SEED);
          if (h < SEA_Y) {
            // 湖底地表（sand 顶面 = h+1）必须在水面之下
            if (isBelowWater(world, REG, wx + 0.5, h + 1, wz + 0.5)) below++;
          } else if (!isBelowWater(world, REG, wx + 0.5, h + 1, wz + 0.5)) above++;
        }
      }
    }
  }
  assertTrue(below > 0, `必须真的有「湖底在水下」的样本（实得 ${below}）`);
  assertTrue(above > 0, `必须真的有「陆地不在水下」的样本（实得 ${above}）`);
});