// src/tests/test-shallow-tarn-gen.js — 浅水高台接线 Tier 1：真实 column GEN
//
// 钉的是「纯函数全绿但世界里什么都不长 / 长错位置」这一类缺陷（M7 教训）：
//   · `apply.js` 阶段 2.45 漏了第 ④ 步调用 → 缓坡一格植物都没有，而纯函数单测全绿；
//   · 调用放在 `fillShallowTarnBasin` **之前** → 整形把植物一起削平；
//   · 调用放在 `paintShallowTarnGrass` **之前** → 无所谓，但放在整段循环**之外**只算第一个 layout
//     → 多 layout 时静默漏（同 `tarnLayouts` 的既有教训）。
//
// 断言落点一律是**真实 `applyStructuresToColumn` 写出的世界方块**，不是纯函数返回值。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { blockIndex } from '../voxel/constants.js';
import {
  computeShallowTarnAnchor, clearShallowTarnCache, SHALLOW_TARN_OUTER_RADIUS,
  BEACH_WIDTH, SLOPE_WIDTH, shallowTarnShapePhase, shallowTarnLakeRadiusAt,
} from '../gen/structures/shallow-water-tarns.js';
import {
  shallowTarnSurfaceYAt, shallowTarnSurfaceBlock, shallowTarnPlantAt,
  clearShallowTarnTerrainCache,
} from '../gen/structures/shallow-water-terrain.js';

const SEED = 12345;

/** 查询域内的邻域布局（与 StructureIndex 下发的 3×3 邻域一致） */
function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

/** 模块级单例：完整 GEN 成本高（每 column ≈ fillColumn + caves + 9 个 region 布局），
 *  多条用例共用。⚠️ 安全：`applyStructuresToColumn` 是纯函数（同 seed 结果确定），
 *  且本文件**只读**世界、从不修改它。 */
let _worldPromise = null;
function buildWorld() {
  if (!_worldPromise) _worldPromise = buildWorldOnce();
  return _worldPromise;
}

/**
 * 采样区 = 湖心 + 缓坡带（**网格步长 16 列**，即每个 column 取一个点）。
 *
 * ⚠️ **必须按 column 复用**（`new ChunkColumn` 每次约 0.4ms）：逐格新建
 * 24024 次实测 10.7s（竞技场踩过）。这里按 column 缓存，30~60 次即可。
 */
async function buildWorldOnce() {
  const reg = await buildDefaultRegistry();
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(SEED);
  assertTrue(!!a, '默认 seed 必须有浅水高台锚点（否则本文件用例恒真）');
  const R = Math.ceil(SHALLOW_TARN_OUTER_RADIUS);
  const cols = new Map();
  const cxMin = Math.floor((a.wx - R) / 16), cxMax = Math.floor((a.wx + R) / 16);
  const czMin = Math.floor((a.wz - R) / 16), czMax = Math.floor((a.wz + R) / 16);
  for (let cx = cxMin; cx <= cxMax; cx++) {
    for (let cz = czMin; cz <= czMax; cz++) {
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, SEED, reg);
      carveCaves(col, SEED);
      await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
      cols.set(`${cx},${cz}`, col);
    }
  }
  const get = (wx, wy, wz) => {
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = cols.get(`${cx},${cz}`);
    if (!col) return 0;
    return col.blocks[blockIndex(wx - cx * 16, wy, wz - cz * 16)];
  };
  return { reg, a, cols, get, R };
}

const offsetAt = (a, wx, wz) => Math.hypot(wx - a.wx, wz - a.wz) - shallowTarnLakeRadiusAt(
  Math.atan2(wz - a.wz, wx - a.wx), shallowTarnShapePhase(SEED),
);
const inSlopeBand = (e) => e > BEACH_WIDTH && e <= BEACH_WIDTH + SLOPE_WIDTH;

test('浅水高台 GEN：缓坡草地上真的长出了植物（接线通了，不只是纯函数对）', async () => {
  // ⚠️ **这是本文件的核心用例**：纯函数单测（`test-shallow-water-tarns.js` ⑤）
  // 已经验了判据与密度，但**验不到 `apply.js` 有没有真的调用它** ——
  // 漏了那一行，世界里一格植物都没有而纯函数单测全绿（M7「只测 API 漏玩家主路径」同类）。
  const { reg, a, cols, get, R } = await buildWorld();
  let grassCells = 0;
  let planted = 0;
  const kinds = new Map();
  for (let wx = a.wx - R; wx <= a.wx + R; wx += 1) {
    for (let wz = a.wz - R; wz <= a.wz + R; wz += 1) {
      const e = offsetAt(a, wx, wz);
      if (!inSlopeBand(e)) continue;
      const surfY = shallowTarnSurfaceYAt(wx, wz, SEED, a);
      if (shallowTarnSurfaceBlock(wx, wz, SEED, a, surfY) !== 'grass') continue;
      // 只统计确实有该 column 的点（采样区外接方形，四角会缺）
      if (!cols.has(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)) continue;
      grassCells++;
      const above = get(wx, surfY + 1, wz);
      if (above === 0) continue;
      planted++;
      const name = reg.nameOf(above);
      kinds.set(name, (kinds.get(name) || 0) + 1);
    }
  }
  assertTrue(grassCells > 3000, `缓坡草地采样太少（${grassCells}）—— 本用例无判别力`);
  assertTrue(planted > 200,
    `缓坡草地只长出 ${planted} 株植物（${grassCells} 列草地）—— `
    + '预期约 13%（PLAINS 全量口径，实测单 seed 1306 株）');
  // 三类都要出现（用户点名「草、花、蘑菇等」）
  assertTrue((kinds.get('short_grass') || 0) > 50, `short_grass 只有 ${kinds.get('short_grass') || 0} 株`);
  assertTrue((kinds.get('red_mushroom') || 0) > 0, `red_mushroom 必须出现（实得 ${kinds.get('red_mushroom') || 0}）`);
  const flowers = (kinds.get('allium') || 0) + (kinds.get('flower') || 0) + (kinds.get('azure_bluet') || 0);
  assertTrue(flowers > 20, `花只有 ${flowers} 株`);
  // 物种必须**全在** PLAINS 允许集合内（防止接线到别的 biome 分支）
  const allowed = new Set([
    'short_grass', 'allium', 'flower', 'azure_bluet', 'oxeye_daisy', 'red_mushroom', 'dead_bush',
  ]);
  for (const name of kinds.keys()) {
    assertTrue(allowed.has(name), `缓坡上出现了 PLAINS 分支之外的方块 "${name}"`);
  }
});

test('浅水高台 GEN：植物密度与 PLAINS 分支逐列对齐（不是只「有几株」）', async () => {
  // 上一轮已经验过「纯函数逐株相等」；这一轮验**接线后的世界**：
  // 每一列的实际方块必须等于 `shallowTarnPlantAt` 的返回值（漏写/多写都会红）。
  const { reg, a, get, R, cols } = await buildWorld();
  let checked = 0;
  let mismatched = 0;
  const samples = [];
  for (let wx = a.wx - R; wx <= a.wx + R; wx += 1) {
    for (let wz = a.wz - R; wz <= a.wz + R; wz += 1) {
      const e = offsetAt(a, wx, wz);
      if (!inSlopeBand(e)) continue;
      const surfY = shallowTarnSurfaceYAt(wx, wz, SEED, a);
      if (shallowTarnSurfaceBlock(wx, wz, SEED, a, surfY) !== 'grass') continue;
      if (!cols.has(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)) continue;
      checked++;
      const want = shallowTarnPlantAt(wx, wz, SEED, a);
      const gotId = get(wx, surfY + 1, wz);
      const got = gotId === 0 ? null : reg.nameOf(gotId);
      if (want !== got) {
        mismatched++;
        if (samples.length < 5) samples.push(`(${wx},${wz}) want=${want} got=${got}`);
      }
    }
  }
  assertTrue(checked > 3000, `采样太少（${checked}）`);
  assertEqual(mismatched, 0, `世界里的植物必须逐列等于判据（${mismatched}/${checked} 不一致：${samples.join('; ')}）`);
});

test('浅水高台 GEN：沙滩 / 湖盆 / 水下坡不长植物（只长在草地上）', async () => {
  const { reg, get, a, R, cols } = await buildWorld();
  // ⚠️ **必须排除五座高台的 AABB**：台地底座坐湖底、台体占满整列，
  // 那几列的 `shallowTarnSurfaceYAt` 仍是湖底高度，但 `surfY+1` 是台地的 `clay`/`marble`
  // 而不是植物。第一版没排除 → 4562 格台地方块被误判成「沙滩上长了东西」。
  // （Tier 4 的 `shallow-water-tarns.spec.mjs` 出于同一理由也排除了台地 AABB。）
  const m0 = await import('../gen/structures/shallow-water-tarns.js');
  const platformBoxes = m0.computeShallowTarnLayout(SEED).map((p) => {
    const px = Math.round(a.wx + p.cx), pz = Math.round(a.wz + p.cz);
    return { minX: px - p.loX, maxX: px + p.hiX, minZ: pz - p.loZ, maxZ: pz + p.hiZ };
  });
  const inPlatform = (x, z) => platformBoxes.some(
    (b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
  );
  let platformSkipped = 0;
  let sandCells = 0;
  let bad = 0;
  // 桥面格也要排除（v2.24）：桥跨越湖面，两端头落在**沙滩带上**，
  // 那里 `surfY + 1` 就是桥面格（`cloud`/`ice`/`sky_stone`/...）而不是植物。
  // 实测不排除 → 31 格桥面方块被误判成「沙岸上长了东西」。
  // ⚠️ **宽度从 `BRIDGE_WIDTH` 派生，不写 `[-1,0,1]`**（红线 1：宽度只有一份权威）。
  const bridgeM = await import('../gen/structures/shallow-water-bridge.js');
  const bridge = bridgeM.computeShallowTarnBridge(SEED, new Map());
  const BRIDGE_HALF = (bridgeM.BRIDGE_WIDTH - 1) / 2;
  const bridgeCells = new Set();
  if (bridge) {
    for (let s = -bridge.halfN; s <= bridge.halfP; s++) {
      const y = bridgeM.shallowTarnBridgeDeckY(s, bridge);
      for (let off = -BRIDGE_HALF; off <= BRIDGE_HALF; off++) {
        const x = a.wx + bridge.ux * s + (-bridge.uz) * off;
        const z = a.wz + bridge.uz * s + bridge.ux * off;
        bridgeCells.add(`${x},${y},${z}`);
      }
    }
  }
  let bridgeSkipped = 0;
  // 中世纪船（Medieval Ship Epic）：船坐在湖盆里（`e ≤ 0`），而湖盆的 `surfY + 1`
  // 恰好就是船底那一层（`LAKE_FLOOR_Y + 1 = SEA_Y`）—— 不排除会把 57 格船体方块
  // 误判成「沙滩上长了东西」。与高台 / 桥面同一条理由，同一个手法。
  const shipM = await import('../gen/structures/medieval-ship.js');
  const ship = shipM.computeMedievalShipPlacement(SEED);
  const inShip = (x, z) => !!ship &&
    x >= ship.wx - ship.loX && x <= ship.wx + ship.hiX &&
    z >= ship.wz - ship.loZ && z <= ship.wz + ship.hiZ;
  let shipSkipped = 0;
  const badAt = [];
  for (let wx = a.wx - R; wx <= a.wx + R; wx += 1) {
    for (let wz = a.wz - R; wz <= a.wz + R; wz += 1) {
      if (inPlatform(wx, wz)) { platformSkipped++; continue; }
      if (inShip(wx, wz)) { shipSkipped++; continue; }
      const e = offsetAt(a, wx, wz);
      // ⚠️ 必须先按 `e` 出局：整形区外（外接方形的四角）是**自然地形**，
      // 那里海洋/沙滩的 `shallowTarnSurfaceBlock` 也会返回 `sand`
      // （`shallowTarnSurfaceYAt` 在区外回落到 `generateHeight`）—— 但那一格不归本地图管。
      // 实测第一版漏了这条判据 → 4593 格自然海底 sand 被误判成「本地图沙滩长了植物」。
      if (e > BEACH_WIDTH + SLOPE_WIDTH) continue;
      const surfY = shallowTarnSurfaceYAt(wx, wz, SEED, a);
      if (shallowTarnSurfaceBlock(wx, wz, SEED, a, surfY) === 'grass') continue;
      if (!cols.has(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)) continue;
      sandCells++;
      const above = get(wx, surfY + 1, wz);
      if (above === 0) continue;
      // 沙滩/水下坡的上一格可能是水（湖盆上方就是 SEA_Y 的水）—— 那不是植物
      const name = reg.nameOf(above);
      if (name === 'water') continue;
      // 桥面格（v2.24）：桥两端顺坡落到沙滩/缓坡上，那里 surfY+1 是桥材质
      if (bridgeCells.has(`${wx},${surfY + 1},${wz}`)) { bridgeSkipped++; continue; }
      bad++;
      if (badAt.length < 5) badAt.push(`${wx},${wz}(${name})`);
    }
  }
  assertTrue(sandCells > 3000, `沙滩/湖盆采样太少（${sandCells}）—— 无判别力`);
  assertTrue(bridgeSkipped > 0, `桥面格一个都没跳过（${bridgeSkipped}）—— 桥没接进 GEN 或判据失效`);
  assertTrue(platformSkipped > 1000, `台地 AABB 内跳过 ${platformSkipped} 列（防「全部被跳过导致本用例恒真」）`);
  // ⚠️ 船落点存在时必须真的跳过了一些列（否则上面的排除是空操作，静默退化）
  if (ship) {
    assertTrue(shipSkipped > 0,
      `船 AABB 内一列都没跳过（${shipSkipped}）—— 排除判据失效或船没接进 GEN`);
  }
  assertEqual(bad, 0, `沙岸/水下坡地上方不得出现植物类方块（实得 ${bad}：${badAt.join('; ')}）`);
});

test('浅水高台 GEN：五座高台的顶面不长植物（只长缓坡自然草，模型里的深浅草不长）', async () => {
  // ⚠️ 这是用户第一轮提问的裁定：范围 = **只长在缓坡自然草地上**。
  // 高台模型里的 `dark_grass` / `light_grass` 顶面必须一株不长 —— 它们是人工建造面。
  // 判据用「高台 AABB 内的最顶层草系方块上方」而不是「e 落在缓坡带」，
  // 因为高台可以伸进湖盆（`e < 0`），两者的分类口径不同。
  const { reg, a, get, cols } = await buildWorld();
  const m = await import('../gen/structures/shallow-water-tarns.js');
  const layout = m.computeShallowTarnLayout(SEED);
  const GRASSY = new Set(['dark_grass', 'light_grass']);
  const PLANT_NAMES = new Set([
    'short_grass', 'allium', 'flower', 'azure_bluet', 'oxeye_daisy', 'red_mushroom', 'dead_bush',
  ]);
  let platformGrass = 0;
  let plantedOnPlatform = 0;
  const badAt = [];
  for (const p of layout) {
    const wx0 = Math.round(a.wx + p.cx), wz0 = Math.round(a.wz + p.cz);
    for (let dx = -p.loX; dx <= p.hiX; dx += 1) {
      for (let dz = -p.loZ; dz <= p.hiZ; dz += 1) {
        const wx = wx0 + dx, wz = wz0 + dz;
        if (!cols.has(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`)) continue;
        // 自上而下找第一个非空方块（高台顶面）
        let topY = null, topName = null;
        for (let y = a.lakeFloorY + 64; y >= a.lakeFloorY; y--) {
          const id = get(wx, y, wz);
          if (id === 0) continue;
          topY = y; topName = reg.nameOf(id);
          break;
        }
        if (topName === null || !GRASSY.has(topName)) continue;
        platformGrass++;
        const above = get(wx, topY + 1, wz);
        if (above !== 0 && PLANT_NAMES.has(reg.nameOf(above))) {
          plantedOnPlatform++;
          if (badAt.length < 5) badAt.push(`${wx},${topY + 1},${wz}(${reg.nameOf(above)})`);
        }
      }
    }
  }
  assertTrue(platformGrass > 500, `高台草地顶面采样太少（${platformGrass}）—— 无判别力（实测约 3100 格）`);
  assertEqual(plantedOnPlatform, 0,
    `高台模型的深浅草顶面不得长植物（实得 ${plantedOnPlatform} 株：${badAt.join('; ')}）—— `
    + '用户裁定范围只有缓坡自然草');
});
