import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeSkyCandidates, writeSingleCloudLayer, writeCloudClusters, writeIslands,
  applySkyStructures, computeClusterCells, SINGLE_CLOUD_Y, CLOUD_CLUSTER_Y,
} from '../gen/structures/sky-structures.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { noise, seededRandom } from '../gen/noise.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 扫描 region [-n,n]² 收集全部空岛候选（返回 {originCx,originCz,bottomY,radius,height} 数组） */
function collectIslands(seed, n = 2) {
  const out = [];
  for (let rx = -n; rx <= n; rx++) {
    for (let rz = -n; rz <= n; rz++) {
      const { skyIslands } = computeSkyCandidates(rx, rz, seed);
      for (let i = 0; i < skyIslands.length; i += 5) {
        out.push({
          originCx: skyIslands[i], originCz: skyIslands[i + 1],
          bottomY: skyIslands[i + 2], radius: skyIslands[i + 3], height: skyIslands[i + 4],
        });
      }
    }
  }
  return out;
}

test('computeSkyCandidates: Int32Array stride 5 + 重复调用逐元素相等（确定性）', () => {
  for (const [rx, rz] of [[0, 0], [-2, 3], [5, -1]]) {
    const a = computeSkyCandidates(rx, rz, SEED);
    const b = computeSkyCandidates(rx, rz, SEED);
    assertTrue(a.skyIslands instanceof Int32Array, 'skyIslands Int32Array');
    assertTrue(a.cloudClusters instanceof Int32Array, 'cloudClusters Int32Array');
    assertEqual(a.skyIslands.length % 5, 0, 'skyIslands stride 5');
    assertEqual(a.cloudClusters.length % 5, 0, 'cloudClusters stride 5');
    assertEqual(a.skyIslands.length, b.skyIslands.length);
    assertEqual(a.cloudClusters.length, b.cloudClusters.length);
    for (let i = 0; i < a.skyIslands.length; i++) assertEqual(a.skyIslands[i], b.skyIslands[i], `island ${i}`);
    for (let i = 0; i < a.cloudClusters.length; i++) assertEqual(a.cloudClusters[i], b.cloudClusters[i], `cluster ${i}`);
  }
});

test('computeSkyCandidates: 空岛候选口径与 mc-lite chunkRandom salt +50/+51/+56/+57 一致', () => {
  const islands = collectIslands(SEED, 2);
  assertTrue(islands.length > 0, 'found island candidates');
  for (const cand of islands) {
    const { originCx: cx, originCz: cz } = cand;
    // 候选率 8%（salt +50）
    assertTrue(seededRandom(cx, cz, SEED + 50) < 0.08, `candidate roll at ${cx},${cz}`);
    // 底部 Y = 40 + floor(rand(+51) * 30) → 40..69
    assertEqual(cand.bottomY, 40 + Math.floor(seededRandom(cx, cz, SEED + 51) * 30), 'bottomY');
    assertTrue(cand.bottomY >= 40 && cand.bottomY <= 69, 'bottomY range');
    // 半径 = 5 + floor(rand(+56) * 5) → 5..9；高度 = 5 + floor(rand(+57) * 3) → 5..7
    assertEqual(cand.radius, 5 + Math.floor(seededRandom(cx, cz, SEED + 56) * 5), 'radius');
    assertEqual(cand.height, 5 + Math.floor(seededRandom(cx, cz, SEED + 57) * 3), 'height');
  }
});

test('computeSkyCandidates: 云簇候选口径与 mc-lite salt +52..+55 一致（本任务只产候选）', () => {
  let found = null;
  for (let rx = -2; rx <= 2 && !found; rx++) {
    for (let rz = -2; rz <= 2 && !found; rz++) {
      const { cloudClusters } = computeSkyCandidates(rx, rz, SEED);
      if (cloudClusters.length > 0) found = cloudClusters;
    }
  }
  assertTrue(found !== null, 'found cluster candidates');
  for (let i = 0; i < found.length; i += 5) {
    const [cx, cz, startX, startZ, size] = [found[i], found[i + 1], found[i + 2], found[i + 3], found[i + 4]];
    assertTrue(seededRandom(cx, cz, SEED + 52) < 0.20, 'cluster candidate roll');
    assertEqual(startX, cx * 16 + Math.floor(seededRandom(cx, cz, SEED + 53) * 16), 'startX');
    assertEqual(startZ, cz * 16 + Math.floor(seededRandom(cx, cz, SEED + 54) * 16), 'startZ');
    assertEqual(size, 30 + Math.floor(seededRandom(cx, cz, SEED + 55) * 21), 'size 30..50');
    assertTrue(size >= 30 && size <= 50, 'size range');
  }
});

test('computeRegionLayout: layout.sky 紧凑候选数组随布局派生', () => {
  const layout = computeRegionLayout(1, 2, SEED);
  assertTrue(layout.sky && layout.sky.skyIslands instanceof Int32Array, 'layout.sky.skyIslands');
  assertTrue(layout.sky.cloudClusters instanceof Int32Array, 'layout.sky.cloudClusters');
  const again = computeRegionLayout(1, 2, SEED);
  assertEqual(layout.sky.skyIslands.length, again.sky.skyIslands.length);
  for (let i = 0; i < layout.sky.skyIslands.length; i++) {
    assertEqual(layout.sky.skyIslands[i], again.sky.skyIslands[i], `layout sky ${i}`);
  }
});

test('writeSingleCloudLayer: noise(wx,wz,seed,0.03)>1.2 → Y=55 cloud（公式固定）', () => {
  const reg = makeRegistry();
  // 扫描找单云点与无云点
  let cloudPt = null, clearPt = null;
  for (let wx = 0; wx < 400 && (!cloudPt || !clearPt); wx++) {
    for (let wz = 0; wz < 400 && (!cloudPt || !clearPt); wz++) {
      const v = noise(wx, wz, SEED, 0.03);
      if (v > 1.2 && !cloudPt) cloudPt = [wx, wz];
      if (v <= 1.2 && !clearPt) clearPt = [wx, wz];
    }
  }
  assertTrue(cloudPt !== null && clearPt !== null, 'found cloud and clear points');
  const cx = Math.floor(cloudPt[0] / 16), cz = Math.floor(cloudPt[1] / 16);
  const column = new ChunkColumn(cx, cz);
  writeSingleCloudLayer(column, SEED, reg);
  assertEqual(column.get(cloudPt[0] - cx * 16, SINGLE_CLOUD_Y, cloudPt[1] - cz * 16),
    reg.idOf('cloud'), 'cloud at Y=55 where noise>1.2');
  // 同 column 的无云点不写
  if (Math.floor(clearPt[0] / 16) === cx && Math.floor(clearPt[1] / 16) === cz) {
    assertEqual(column.get(clearPt[0] - cx * 16, SINGLE_CLOUD_Y, clearPt[1] - cz * 16),
      0, 'no cloud where noise<=1.2');
  }
});

test('writeIslands: 跨 column 重组逐格一致 —— 顶 sky_grass、身 sky_stone、无 chest/天空树', () => {
  const reg = makeRegistry();
  const islands = collectIslands(SEED, 2);
  const cand = islands[0];
  const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
  const maxY = cand.bottomY + cand.height;

  // 重组世界：对 AABB 覆盖的每个 column 独立生成，收集世界坐标 → id
  const skyId = new Set([reg.idOf('sky_stone'), reg.idOf('sky_grass')]);
  const world = new Map();
  const minX = centerX - cand.radius, maxX = centerX + cand.radius;
  const minZ = centerZ - cand.radius, maxZ = centerZ + cand.radius;
  const skyCandidates = [computeSkyCandidates(
    Math.floor(cand.originCx / 25), Math.floor(cand.originCz / 25), SEED)];
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++) {
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const column = new ChunkColumn(cx, cz);
      writeIslands(column, skyCandidates, reg);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let y = cand.bottomY; y <= maxY; y++) {
            const id = column.get(lx, y, lz);
            if (id !== 0) world.set(`${cx * 16 + lx},${y},${cz * 16 + lz}`, id);
          }
        }
      }
    }
  }

  // 独立重算期望形状：逐层圆（r = floor(radius*(y/height)^0.7)）
  let expected = 0;
  for (let y = 0; y <= cand.height; y++) {
    const r = Math.floor(cand.radius * Math.pow(y / cand.height, 0.7));
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r) continue;
        expected++;
        const key = `${centerX + dx},${cand.bottomY + y},${centerZ + dz}`;
        const id = world.get(key);
        const want = (y === cand.height) ? reg.idOf('sky_grass') : reg.idOf('sky_stone');
        assertEqual(id, want, `island block at ${key}`);
      }
    }
  }
  assertEqual(world.size, expected, 'no extra blocks');
  // 无 chest / 天空树 / 天空树叶
  for (const id of world.values()) assertTrue(skyId.has(id), 'only sky_stone/sky_grass');
});

test('覆盖层序: 与 Y=55 单云相交的岛体最终是岛而非 cloud（先确认为 cloud）', () => {
  const reg = makeRegistry();
  // 找一个 Y=55 落在岛体内、且该层存在单云点的岛
  let hit = null;
  for (let n = 2; n <= 6 && !hit; n++) {
    for (const cand of collectIslands(SEED, n)) {
      if (cand.bottomY > SINGLE_CLOUD_Y || cand.bottomY + cand.height < SINGLE_CLOUD_Y) continue;
      const yOff = SINGLE_CLOUD_Y - cand.bottomY;
      const r = Math.floor(cand.radius * Math.pow(yOff / cand.height, 0.7));
      const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
      for (let dx = -r; dx <= r && !hit; dx++) {
        for (let dz = -r; dz <= r && !hit; dz++) {
          if (dx * dx + dz * dz > r * r) continue;
          if (noise(centerX + dx, centerZ + dz, SEED, 0.03) > 1.2) {
            hit = { cand, wx: centerX + dx, wz: centerZ + dz };
          }
        }
      }
    }
  }
  assertTrue(hit !== null, 'found island crossing single cloud layer with cloud cell');
  const { cand, wx, wz } = hit;
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const skyCandidates = [computeSkyCandidates(
    Math.floor(cand.originCx / 25), Math.floor(cand.originCz / 25), SEED)];

  // 前置：空岛写入前该格确实是 cloud（单云层单独写入）
  const before = new ChunkColumn(cx, cz);
  writeSingleCloudLayer(before, SEED, reg);
  assertEqual(before.get(wx - cx * 16, SINGLE_CLOUD_Y, wz - cz * 16),
    reg.idOf('cloud'), 'cell is cloud before island pass');

  // 完整层序（先云后岛）：最终为岛体
  const after = new ChunkColumn(cx, cz);
  applySkyStructures(after, skyCandidates, SEED, reg);
  const id = after.get(wx - cx * 16, SINGLE_CLOUD_Y, wz - cz * 16);
  assertTrue(id === reg.idOf('sky_stone') || id === reg.idOf('sky_grass'),
    `island overwrites cloud, got id=${id}`);
});

/** 收集 region [-n,n]² 全部云簇候选 */
function collectClusters(seed, n) {
  const out = [];
  for (let rx = -n; rx <= n; rx++) {
    for (let rz = -n; rz <= n; rz++) {
      const { cloudClusters } = computeSkyCandidates(rx, rz, seed);
      for (let i = 0; i < cloudClusters.length; i += 5) {
        out.push({
          originCx: cloudClusters[i], originCz: cloudClusters[i + 1],
          startX: cloudClusters[i + 2], startZ: cloudClusters[i + 3], size: cloudClusters[i + 4],
          regionX: rx, regionZ: rz,
        });
      }
    }
  }
  return out;
}

/** 对覆盖簇真实形状 bbox 的全部 column 生成，收集 Y=35 云块世界坐标集合 */
function reassembleCluster(cluster, reg) {
  const skyCandidates = [computeSkyCandidates(cluster.regionX, cluster.regionZ, SEED)];
  const expected = computeClusterCells(cluster.startX, cluster.startZ, cluster.size, SEED);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of expected) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const cells = new Map(); // "x,z" → {cx, cz} 来源列
  const touchedColumns = new Set();
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++) {
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const column = new ChunkColumn(cx, cz);
      writeCloudClusters(column, skyCandidates, SEED, reg);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          if (column.get(lx, CLOUD_CLUSTER_Y, lz) === reg.idOf('cloud')) {
            cells.set(`${cx * 16 + lx},${cz * 16 + lz}`, { cx, cz });
            touchedColumns.add(`${cx},${cz}`);
          }
        }
      }
    }
  }
  return { cells, touchedColumns, skyCandidates };
}

test('writeCloudClusters: 30..50 块 + 四邻接连通 + 起点在簇内（M2-7）', () => {
  const reg = makeRegistry();
  const clusters = collectClusters(SEED, 1);
  assertTrue(clusters.length > 0, 'found cluster candidates');
  for (const cluster of clusters.slice(0, 3)) {
    assertTrue(cluster.size >= 30 && cluster.size <= 50, `size ${cluster.size} in 30..50`);
    const { cells } = reassembleCluster(cluster, reg);
    assertEqual(cells.size, cluster.size, `cluster size exact (${cluster.size})`);
    assertTrue(cells.has(`${cluster.startX},${cluster.startZ}`), 'start cell in cluster');
    // 四邻接连通：BFS 从起点可达全部格
    const seen = new Set([`${cluster.startX},${cluster.startZ}`]);
    const queue = [[cluster.startX, cluster.startZ]];
    while (queue.length) {
      const [x, z] = queue.shift();
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        const k = `${nx},${nz}`;
        if (cells.has(k) && !seen.has(k)) { seen.add(k); queue.push([nx, nz]); }
      }
    }
    assertEqual(seen.size, cells.size, 'cluster is 4-connected');
  }
});

test('writeCloudClusters: 跨 column 逐格一致（独立列重生成 == 组合重生成）', () => {
  const reg = makeRegistry();
  // 找一个实际跨越 ≥2 个 column 的云簇
  let target = null, targetResult = null;
  for (const cluster of collectClusters(SEED, 2)) {
    const result = reassembleCluster(cluster, reg);
    if (result.touchedColumns.size >= 2) { target = cluster; targetResult = result; break; }
  }
  assertTrue(target !== null, 'found cluster crossing column boundary');
  // 逐格在单独重建的列中复现（组合重生成与独立列重生成逐格一致）
  for (const [keyStr, { cx, cz }] of targetResult.cells) {
    const [x, z] = keyStr.split(',').map(Number);
    const column = new ChunkColumn(cx, cz);
    writeCloudClusters(column, targetResult.skyCandidates, SEED, reg);
    assertEqual(column.get(x - cx * 16, CLOUD_CLUSTER_Y, z - cz * 16),
      reg.idOf('cloud'), `cell ${x},${z} reproduced in solo column`);
  }
  // 层序：applySkyStructures 后该簇格仍为 cloud（岛最低 Y=40，不覆盖 Y=35）
  const cx0 = target.startX >> 4, cz0 = target.startZ >> 4;
  const col = new ChunkColumn(cx0, cz0);
  applySkyStructures(col, targetResult.skyCandidates, SEED, reg);
  assertEqual(col.get(target.startX - cx0 * 16, CLOUD_CLUSTER_Y, target.startZ - cz0 * 16),
    reg.idOf('cloud'), 'cluster survives full layer order');
});
