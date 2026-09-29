import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  computeSkyCandidates, writeSingleCloudLayer, writeCloudClusters, writeIslands,
  applySkyStructures, computeClusterCells, SINGLE_CLOUD_Y, CLOUD_CLUSTER_Y,
  islandLayerRadius, writeSkyTrees, SKY_TREE_CHANCE, SKY_TREE_SALT,
} from '../gen/structures/sky-structures.js';
import { computeRegionLayout } from '../gen/structures/structure-layout.js';
import { noise, seededRandom } from '../gen/noise.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { generateTree } from '../gen/structures/vegetation.js';

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

test('writeIslands: 跨 column 重组逐格一致 —— 顶 sky_grass、身 sky_stone、无 chest', () => {
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

// ---- islandLayerRadius：岛层半径的单一权威（红线 1）----

test('islandLayerRadius: 与 mc-lite 逐层收窄公式一致 + 顶层等于 radius', () => {
  // 直接对照 mc-lite Island.js:41 的 `Math.floor(radius * Math.pow(y / height, 0.7))`
  for (const radius of [5, 6, 7, 8, 9]) {
    for (const height of [5, 6, 7]) {
      for (let y = 0; y <= height; y++) {
        const want = Math.floor(radius * Math.pow(y / height, 0.7));
        assertEqual(islandLayerRadius(radius, y, height), want, `r=${radius} h=${height} y=${y}`);
      }
      // 顶层（y === height）半径必须恰为 radius —— Task 3 的树基点圆依赖这条
      assertEqual(islandLayerRadius(radius, height, height), radius, `顶层 r=${radius} h=${height}`);
    }
  }
  assertEqual(islandLayerRadius(7, 0, 5), 0, '底层 y=0 → 半径 0（单格）');
});

// ---- 天空树（M2-7 有意删除项回补，spec §2/§3）----

/** 独立重算某岛的期望树干基点集合（不复用 writeSkyTrees 的实现路径） */
function expectedTrunkCells(cand) {
  const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
  const topY = cand.bottomY + cand.height;
  const r = islandLayerRadius(cand.radius, cand.height, cand.height); // === cand.radius
  const out = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue;
      const wx = centerX + dx, wz = centerZ + dz;
      if (seededRandom(wx, wz, SEED + SKY_TREE_SALT) < SKY_TREE_CHANCE) {
        out.push({ wx, wz, baseY: topY + 1 });
      }
    }
  }
  return out;
}

/**
 * 忠实写入顺序模拟（spec §2.5.1）：按与实现**相同的顺序**逐棵树 generateTree，
 * 后写覆盖（Map.set 天然后写胜）—— 与 makeColumnSetter 的无守卫覆盖语义一致。
 * ⚠️ 这是「世界实际长什么样」的忠实模型，**不是**「每棵树都完整」的理想模型：
 * 树干格会被后写树冠覆盖，覆盖率**随密度变**（实测 region [-2,2]²：密度 0.1 时 21.4%、
 * 当前 0.05 时 13.2%），理想模型的断言在两种密度下都必然 FAIL。
 * 返回值：Map<'x,y,z', id>（仅树格，id ∈ {sky_wood, sky_leaves}）。
 */
function simulateIslandTrees(cand, woodId, leavesId) {
  const sim = new Map();
  const setBlock = (x, y, z, name) => sim.set(`${x},${y},${z}`, name === 'sky_wood' ? woodId : leavesId);
  for (const t of expectedTrunkCells(cand)) {
    generateTree(t.wx, t.baseY, t.wz, setBlock, SEED, 'skyTree');
  }
  return sim;
}

/** 对覆盖某岛 AABB（含树冠外扩 2）的每个 column 独立生成，重组为世界坐标 → id */
function reassembleIslandWorld(cand, reg, fn) {
  const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
  const span = cand.radius + 2; // 树冠外扩（spec §2.4）
  const skyCandidates = [computeSkyCandidates(
    Math.floor(cand.originCx / 25), Math.floor(cand.originCz / 25), SEED)];
  const world = new Map();
  for (let cx = Math.floor((centerX - span) / 16); cx <= Math.floor((centerX + span) / 16); cx++) {
    for (let cz = Math.floor((centerZ - span) / 16); cz <= Math.floor((centerZ + span) / 16); cz++) {
      const column = new ChunkColumn(cx, cz);
      fn(column, skyCandidates, reg);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        for (let y = cand.bottomY; y <= cand.bottomY + cand.height + 6; y++) {
          const id = column.get(lx, y, lz);
          if (id !== 0) world.set(`${cx * 16 + lx},${y},${cz * 16 + lz}`, id);
        }
      }
    }
  }
  return world;
}

/** 找一个顶层至少有 1 棵树的岛候选 */
function findIslandWithTree(seed, n = 3) {
  for (let r = 1; r <= n; r++) {
    for (const cand of collectIslands(seed, r)) {
      if (expectedTrunkCells(cand).length > 0) return cand;
    }
  }
  return null;
}

/**
 * 找一个顶层圆内**同时**含「随机值略低于阈值」与「略高于阈值」两类格的岛 ——
 * 用于在临界值附近验证判定（M6 教训：用远离阈值的输入测不出阈值写错）。
 * @returns {{cand: Object, topY: number, below: {wx,wz,v}, above: {wx,wz,v}}|null}
 */
function findIslandWithCriticalPair(seed, n = 2, eps = 0.002) {
  for (const cand of collectIslands(seed, n)) {
    const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
    const topY = cand.bottomY + cand.height;
    const r = islandLayerRadius(cand.radius, cand.height, cand.height);
    let below = null, above = null;
    for (let dx = -r; dx <= r && !(below && above); dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r) continue;
        const wx = centerX + dx, wz = centerZ + dz;
        const v = seededRandom(wx, wz, seed + SKY_TREE_SALT);
        if (!below && v < SKY_TREE_CHANCE && v > SKY_TREE_CHANCE - eps) below = { wx, wz, v };
        if (!above && v >= SKY_TREE_CHANCE && v < SKY_TREE_CHANCE + eps) above = { wx, wz, v };
        if (below && above) break;
      }
    }
    if (below && above) return { cand, topY, below, above };
  }
  return null;
}

test('writeSkyTrees: 树存在性 + 树块集合与忠实写入顺序模拟一致 + 两次生成确定性', () => {
  const reg = makeRegistry();
  const cand = findIslandWithTree(SEED, 3);
  assertTrue(cand !== null, '找到有树的岛（若为 null 说明 SKY_TREE_CHANCE/SALT 变了）');
  const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
  const topY = cand.bottomY + cand.height;

  const world = reassembleIslandWorld(cand, reg, (col, cands, r) => {
    writeIslands(col, cands, r);
    writeSkyTrees(col, cands, SEED, r);
  });
  const woodId = reg.idOf('sky_wood'), leavesId = reg.idOf('sky_leaves');

  // ① 存在性：树冠与树干都出现了
  let nWood = 0, nLeaves = 0;
  for (const [key, id] of world) {
    if (id === woodId) nWood++;
    else if (id === leavesId) nLeaves++;
    else assertTrue(id === reg.idOf('sky_stone') || id === reg.idOf('sky_grass'),
      `岛+树范围内只应出现 4 种方块，${key} 是别的`);
  }
  assertTrue(nWood > 0, '有 sky_wood 树干');
  assertTrue(nLeaves > 0, '有 sky_leaves 树冠');

  // ② 单一权威（spec §6.2 第 2 条）：每个**期望基点**处确实长了树（非 air），
  //    且基点下方是岛顶层 sky_grass（树长在岛上、不悬空）。
  //    ⚠️ 主判据是「基点非 air」—— 实测它才有检验力：注入「圆判据半径 -1」后 3/5 处基点变 air；
  //    而「下方须是 sky_grass」实测 0/300 个岛会因半径 -1 而 FAIL（半径缩 1 后基点仍在岛内），
  //    故只作辅助断言。**不得**用「岛顶层圆外不得出现树块」当判据（树冠外扩 ±2 本就超出岛圆，
  //    且扫描区含邻岛的树 → 基线就大量命中）。
  const expect = expectedTrunkCells(cand);
  assertTrue(expect.length > 0, '期望树干数 > 0');
  let baseAir = 0;
  for (const t of expect) {
    if (world.get(`${t.wx},${topY + 1},${t.wz}`) === undefined) { baseAir++; continue; }
    assertEqual(world.get(`${t.wx},${topY},${t.wz}`), reg.idOf('sky_grass'),
      `树干底格下方须是 sky_grass：${t.wx},${topY},${t.wz}`);
  }
  assertEqual(baseAir, 0,
    `每个期望基点处都该长树（${baseAir}/${expect.length} 处为 air → 圆判据与岛体漂移或判定写错）`);

  // ③ 树块集合与**忠实写入顺序模拟**一致（spec §6.2 第 4 条）。
  //    ⚠️ 不是「每棵树 4 格树干」：后写树的树冠会盖掉先写树的树干（spec §2.5.1；覆盖率随密度变，
  //    实测密度 0.1 时全图 21.4%、当前 0.05 时 13.2%）。本岛（当前密度 0.05）实测 2 棵树
  //    8 格树干全部存活（密度 0.1 时是 5 棵 20 格只剩 18 格）—— 覆盖是低频事件，故断言
  //    **不得**押「本岛一定发生覆盖」，只押「模拟 → 世界单向一致」（模拟已含同样的覆盖顺序）。
  //    ⚠️ 比对必须是**单向**（模拟 → 世界）：`reassembleIslandWorld` 的扫描区（span=radius+2）里
  //    含**邻岛**的树，反向比对会在基线就多出一大片格 → 假失败（实测 34,901 格）。
  //    ⚠️ 判据是「模拟的每格在世界里**存在且是树块**」，**不是逐格 id 精确相等** ——
  //    邻岛后写的树会把本岛的 wood 盖成 leaves（或反之），实测 400 个岛中 2 个会出现这种
  //    wood↔leaves 互换 → 精确相等会假失败。「存在且是树块」实测 400/400 零假失败、
  //    且对半径-1 / CHANCE=0 / 门控 radius 三种注入都敏感（与 Task 4 的 missing/notTree 同口径）。
  const sim = simulateIslandTrees(cand, woodId, leavesId);
  assertTrue(sim.size > 0, '模拟的树非空');
  let simMissing = 0, simNotTree = 0;
  const simSamples = [];
  for (const key of sim.keys()) {
    const got = world.get(key);
    if (got === undefined) { simMissing++; if (simSamples.length < 3) simSamples.push(`${key}=air`); }
    else if (got !== woodId && got !== leavesId) { simNotTree++; if (simSamples.length < 3) simSamples.push(`${key}=${got}`); }
  }
  assertEqual(simMissing, 0, `模拟的树格都应在世界里存在（缺 ${simMissing}，样例 ${simSamples.join(' ')}）`);
  assertEqual(simNotTree, 0, `模拟的树格都应是树块（非树块 ${simNotTree}，样例 ${simSamples.join(' ')}）`);

  // ④ 确定性：同一岛对同一组 column 两次独立生成，结果逐格相同
  const world2 = reassembleIslandWorld(cand, reg, (col, cands, r) => {
    writeIslands(col, cands, r);
    writeSkyTrees(col, cands, SEED, r);
  });
  assertEqual(world2.size, world.size, '两次生成格数相同');
  for (const [key, id] of world) assertEqual(world2.get(key), id, `两次生成逐格相同：${key}`);
});

test('writeSkyTrees: 树不覆盖岛体 + 树完全走 opaque 通道（不进 cutout）', () => {
  const reg = makeRegistry();
  const cand = findIslandWithTree(SEED, 3);
  const centerX = cand.originCx * 16 + 8, centerZ = cand.originCz * 16 + 8;
  const topY = cand.bottomY + cand.height;

  // 只写树、不写岛体：断言树的最低格是 topY+1（不侵占岛体任何一格）
  const treeOnly = reassembleIslandWorld(cand, reg, (col, cands, r) => {
    writeSkyTrees(col, cands, SEED, r);
  });
  let minY = Infinity;
  for (const key of treeOnly.keys()) minY = Math.min(minY, Number(key.split(',')[1]));
  assertEqual(minY, topY + 1, '树的最低格 = 岛顶 +1（不覆盖岛体）');

  // mesher 通道归属：树 mesh 后 cutout 顶点必须为 0（sky_leaves 已改 opaque，Task 1）
  const N = 18, vIdx = (dx, dy, dz) => dx + dz * N + dy * N * N;
  const data = new Uint16Array(N * N * N);
  const light = new Uint8Array(N * N * N).fill(0xF0);
  // 一棵树放进隔离 section：基点局部 (9,5,9)，树干 5..8、树冠 7..9
  const setBlock = (x, y, z, name) => { data[vIdx(x, y, z)] = reg.idOf(name); };
  generateTree(9, 5, 9, setBlock, SEED, 'skyTree');
  const result = buildSectionMesh({ data, light, missing: false }, reg, {}, 0, 0, 0);
  assertEqual(result.cutout.vertexCount, 0, '树不进 cutout 通道（方案 C）');
  assertTrue(result.opaque.vertexCount > 0, '树全部走 opaque 通道');
  assertEqual(result.transparent.vertexCount, 0, '树不进 transparent 通道');
});

test('SKY_TREE_CHANCE 临界值：略低于阈值的岛格长树、略高于的不长（真的调 writeSkyTrees）', () => {
  const reg = makeRegistry();
  const hit = findIslandWithCriticalPair(SEED, 2);
  assertTrue(hit !== null,
    '找到含临界值对的岛（seed=12345 实测可找到；若 null 说明 CHANCE/SALT 变了或 eps 窗口太窄）');
  const { cand, topY, below, above } = hit;
  // 前提断言：两个样本确实分居阈值两侧且都极靠近阈值
  assertTrue(below.v < SKY_TREE_CHANCE && below.v > SKY_TREE_CHANCE - 0.002,
    `below 前提：v=${below.v} 略低于 ${SKY_TREE_CHANCE}`);
  assertTrue(above.v >= SKY_TREE_CHANCE && above.v < SKY_TREE_CHANCE + 0.002,
    `above 前提：v=${above.v} 略高于 ${SKY_TREE_CHANCE}`);

  // ⚠️ 关键：必须**真的调 writeSkyTrees 再读世界**。初版写成
  // `assertEqual(justBelow.r < SKY_TREE_CHANCE, true)` —— 那与选点条件同义反复（**恒真**），
  // 且根本不调实现代码：把实现的 `<` 写成 `<=`、用错 salt、或忘了判定都测不出来。
  // 实测注入：CHANCE 0.10 → {below 长树:true, above 长树:false}；
  //         改 0.101（阈值上移越过 above）→ above 长树变 true → **真 FAIL**。
  const world = reassembleIslandWorld(cand, reg, (col, cands, r) => {
    writeIslands(col, cands, r);
    writeSkyTrees(col, cands, SEED, r);
  });
  const woodId = reg.idOf('sky_wood'), leavesId = reg.idOf('sky_leaves');
  // topY+1 层只可能出现树干（树冠在 y+2..y+4）→ 该层有树块 ≡ 这里有棵树基点
  const grewTree = (p) => {
    const id = world.get(`${p.wx},${topY + 1},${p.wz}`);
    return id === woodId || id === leavesId;
  };
  assertEqual(grewTree(below), true, `略低于阈值（v=${below.v}）→ 长树`);
  assertEqual(grewTree(above), false, `略高于阈值（v=${above.v}）→ 不长树`);
});

test('writeSkyTrees: 跨 column 的树冠无断裂（AABB 门控 +2 的专项验证）', () => {
  const reg = makeRegistry();
  const leavesId = reg.idOf('sky_leaves'), woodId = reg.idOf('sky_wood');

  // ① 选点：必须找到一棵**树冠真的越过 column 边界**的树，否则用例恒真
  //    （testing-policy §2.5 恒真陷阱）。判据 = **直接按真实足迹算它覆盖的 column 集合**。
  //    ⚠️ 不得用「到最近边界的距离」取模启发式（初版写的
  //    `Math.min(t.wx % 16, 16 - (t.wx % 16))`）：JS 的 `%` 是**取余**不是取模，
  //    本仓世界无边界、负坐标是常态 → `wx=-1197` 算出 `-13` → 恒 `<= 2` → **判据恒真**
  //    → 退化成「取第一个岛的第一棵树」（而那棵树不跨界）。按足迹判直接以
  //    「用例需要什么前提」为判据，不需维护位运算直觉。（若非要用取模：`((wx%16)+16)%16`）
  let picked = null;
  for (const cand of collectIslands(SEED, 3)) {
    for (const t of expectedTrunkCells(cand)) {
      // 树冠足迹 = 基点 ±2 → 枚举它覆盖的 column 集合，size ≥ 2 即跨界
      const cols = new Set();
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        cols.add(`${Math.floor((t.wx + dx) / 16)},${Math.floor((t.wz + dz) / 16)}`);
      }
      if (cols.size >= 2) { picked = { cand, trunk: t }; break; }
    }
    if (picked) break;
  }
  assertTrue(picked !== null, '找到一棵树冠跨界的树（若 null 则扩大 collectIslands 的 n）');
  const { cand, trunk } = picked;
  const trunkCx = Math.floor(trunk.wx / 16), trunkCz = Math.floor(trunk.wz / 16);
  // 前提断言（护栏，防选点退化）：这棵树的树冠确实覆盖到 ≥2 个 column
  const spannedColumns = new Set();
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    spannedColumns.add(`${Math.floor((trunk.wx + dx) / 16)},${Math.floor((trunk.wz + dz) / 16)}`);
  }
  assertTrue(spannedColumns.size >= 2,
    `前提：树冠跨 ${spannedColumns.size} 个 column（须 ≥2 才有检验力）`);
  // 实测（seed=12345，region [-3,3]²）：跨界树占全部树的 22.8% → 必然能选到，无需放宽判据。

  // ② 逐 column 独立生成后重组（真实路径：每个 column 只跑一次 writeSkyTrees）
  const world = reassembleIslandWorld(cand, reg, (col, cands, r) => {
    writeIslands(col, cands, r);
    writeSkyTrees(col, cands, SEED, r);
  });

  // ③ 期望形状：用**同一棵树的基点**在内存里一次性生成（不经 column 裁剪），
  //    作为「无断裂」的参照
  const expect = new Map();
  generateTree(trunk.wx, trunk.baseY, trunk.wz, (x, y, z, name) => {
    expect.set(`${x},${y},${z}`, name === 'sky_wood' ? woodId : leavesId);
  }, SEED, 'skyTree');
  assertTrue(expect.size > 0, '参照树非空');

  // ④ 逐格比对：参照树的每一格都必须在重组世界里**存在**且仍是**树块**（无缺角）。
  //    ⚠️ 不得断言逐格 id 相等：因后写覆盖（spec §2.5.1），参照树的树干格可能被
  //    邻树树冠写成 sky_leaves（实测 300 棵跨界树中 48.8% 有这类差异）→ 假失败。
  //    实测标定：基线 missing=0（16,347 格全命中且均为树块）；注入门控改回 radius → missing=901。
  //    ⚠️ 上述两个数是 spec 勘查期 **300 棵跨界树的聚合**标定值；本用例只比对**选中的那一棵**
  //    （约 50 格），Task 4 实测单棵注入 missing=**12** —— 复核注入时按单棵口径读，勿拿 901 对号。
  let missing = 0, notTree = 0;
  const missingKeys = [];
  for (const key of expect.keys()) {
    const got = world.get(key);
    if (got === undefined) { missing++; if (missingKeys.length < 5) missingKeys.push(key); }
    else if (got !== woodId && got !== leavesId) { notTree++; if (missingKeys.length < 5) missingKeys.push(`${key}=${got}`); }
  }
  assertEqual(missing, 0, `树冠无缺格（缺 ${missing}，样例 ${missingKeys.join(' ')}）`);
  assertEqual(notTree, 0, `树冠每格仍是树块（非树块 ${notTree}）`);

  // ⑤ 反向确认：这棵树确实有格落在**非树干所在 column**（证明检验力真实存在）
  let crossColumnCells = 0;
  for (const key of expect.keys()) {
    const [x, , z] = key.split(',').map(Number);
    if (Math.floor(x / 16) !== trunkCx || Math.floor(z / 16) !== trunkCz) crossColumnCells++;
  }
  assertTrue(crossColumnCells > 0,
    `前提：该树有 ${crossColumnCells} 格落在其它 column（须 >0，否则 ②③④ 无检验力）`);
});
