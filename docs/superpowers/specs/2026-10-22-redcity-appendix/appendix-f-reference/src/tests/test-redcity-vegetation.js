// RedCity 植被避让（Tier 1，真实 GEN）：被吞并地标不留悬空树 / core⊕3 无扎根植物 / ring 保留植被且落点正确 / 树冠半径前提
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getRedCityInfo } from '../gen/structures/redcity-layout.js';
import { ringSurfaceY, landmarkErased } from '../gen/structures/redcity-surface.js';
import { landmarkHalfExtent } from '../gen/structures/landmarks.js';
import { generateTree } from '../gen/structures/vegetation.js';
import { REDCITY_VEG_CLEARANCE, TREE_CANOPY_RADIUS } from '../gen/structures/region-config.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

const reg = (() => { const r = createRegistry(); for (const d of BLOCKS) r.register(d.name, d); r.freeze(); return r; })();
const nameOf = (id) => reg.nameOf(id);
const layoutCache = new Map();
const layoutOf = (rx, rz, seed) => { const k = `${seed}:${rx},${rz}`; if (!layoutCache.has(k)) layoutCache.set(k, computeRegionLayout(rx, rz, seed)); return layoutCache.get(k); };
const layoutsFor = (cx, cz, seed) => neighborRegionKeys(cx, cz).map((k) => layoutOf(...k.split(',').map(Number), seed));
const redCityOf = (seed) => layoutOf(0, 0, seed).redCity;
async function gen(seed, cx, cz, redCity) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg); carveCaves(col, seed);
  await applyStructuresToColumn(col, seed, reg, layoutsFor(cx, cz, seed), redCity);
  return col;
}
const LOGS = new Set(['wood', 'birch_log', 'dark_oak', 'azalea_log']);
const ROOTED_PLANTS = new Set(['short_grass', 'flower', 'allium', 'azure_bluet', 'dead_bush', 'oxeye_daisy', 'red_mushroom', 'cactus', 'lilypad']);
const SNOWISH = new Set(['snow_leaves', 'snow_block', 'snow_grass', 'snow', 'ice']);
const regionsAround = (inf, seed) => {
  const out = [];
  for (let rx = Math.floor(inf.minX / 400) - 1; rx <= Math.floor(inf.maxX / 400) + 1; rx++) for (let rz = Math.floor(inf.minZ / 400) - 1; rz <= Math.floor(inf.maxZ / 400) + 1; rz++) out.push(layoutOf(rx, rz, seed));
  return out;
};

test('被吞并的冰山/雪原区域不得长出悬空树：影响域外、且不在任何未被吞并地标内的 column——无悬空树干、无雪系方块（seed 1–8）', async () => {
  // 缺陷形态：阶段 1/2 不再生成雪原/冰山，pointContext 却仍按「地标存在」判 kind='snow'/'fm'，树基点取地标高度公式
  // → 实测 60 个 seed 里 46 个出现，190 棵雪桦树 149 棵悬空（最高 24 格）。
  let columns = 0, floating = 0, snowish = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rc = redCityOf(seed), inf = rc.influence;
    const all = [];
    for (const L of regionsAround(inf, seed)) for (const kind of ['pyramid', 'frozenMountain', 'snowLand', 'island', 'plainLand']) if (L[kind]) all.push({ kind, c: L[kind], fp: landmarkHalfExtent(kind), erased: landmarkErased(kind, L[kind], rc) });
    const alive = all.filter((a) => !a.erased).map((a) => ({ minX: a.c.cx - a.fp.halfX - 4, maxX: a.c.cx + a.fp.halfX + 4, minZ: a.c.cz - a.fp.halfZ - 4, maxZ: a.c.cz + a.fp.halfZ + 4 }));
    for (const L of all.filter((a) => a.erased && (a.kind === 'frozenMountain' || a.kind === 'snowLand'))) {
      for (let cx = Math.floor((L.c.cx - L.fp.halfX) / 16); cx <= Math.floor((L.c.cx + L.fp.halfX) / 16); cx++) {
        for (let cz = Math.floor((L.c.cz - L.fp.halfZ) / 16); cz <= Math.floor((L.c.cz + L.fp.halfZ) / 16); cz++) {
          const x0 = cx * 16, z0 = cz * 16;
          if (!(x0 + 15 < inf.minX - 4 || x0 > inf.maxX + 4 || z0 + 15 < inf.minZ - 4 || z0 > inf.maxZ + 4)) continue;   // 影响域内/贴边：走 RedCity 分支
          if (alive.some((q) => !(x0 + 15 < q.minX || x0 > q.maxX || z0 + 15 < q.minZ || z0 > q.maxZ))) continue;       // 与未被吞并的地标重叠：雪方块合法
          const col = await gen(seed, cx, cz, rc); columns++;
          for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) for (let y = WORLD_MIN_Y + 1; y < WORLD_MAX_Y; y++) {
            const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]);
            if (SNOWISH.has(nm)) snowish++;
            if (LOGS.has(nm) && col.blocks[blockIndex(lx, y - 1, lz)] === 0) floating++;
          }
        }
      }
    }
  }
  assertTrue(columns > 100, `扫描了 ${columns} 个被吞并地标范围内的 column`);
  assertEqual(floating, 0, '悬空树干块数');
  assertEqual(snowish, 0, '被吞并地标范围内的雪系方块数');
});

test('环带 d≤3：不得有扎根的植物/树干（树冠叶可外溢）；d≥4：保留植被，植物脚下实心、树干不悬空（3 个 seed）', async () => {
  let band = 0, bandLeaves = 0, rooted = 0, rootedBad = 0, floating = 0, cells = 0;
  for (const seed of [12345, 1, 7]) {
    const rc = redCityOf(seed), c = rc.core; const cols = new Set();
    const add = (x, z) => cols.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    for (const t of [0.2, 0.5, 0.8]) {
      const mx = c.minX + (c.maxX - c.minX) * t, mz = c.minZ + (c.maxZ - c.minZ) * t;
      for (const d of [4, 20, 36]) { add(mx, c.minZ - d); add(mx, c.maxZ + d); add(c.minX - d, mz); add(c.maxX + d, mz); }
    }
    for (const key of cols) {
      const [cx, cz] = key.split(',').map(Number); const col = await gen(seed, cx, cz, rc);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz; const info = getRedCityInfo(wx, wz, rc); if (!info || info.zone !== 'ring') continue; cells++;
        const s = ringSurfaceY(info.edgeDistance, generateHeight(wx, wz, seed), rc.baseY);
        for (let y = s + 1; y < WORLD_MAX_Y; y++) {
          const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]);
          if (nm === 'air') continue;
          const isLeaf = /leaves|flowers|vine/.test(nm);
          // 带宽取 TREE_CANOPY_RADIUS（树冠半径这个**事实**），不取被测常量 REDCITY_VEG_CLEARANCE 本身——后者被改小时带宽跟着缩，用例会变成空洞
          if (info.edgeDistance <= TREE_CANOPY_RADIUS) { if (ROOTED_PLANTS.has(nm) || LOGS.has(nm)) band++; else if (isLeaf) bandLeaves++; }
          if (LOGS.has(nm) && col.blocks[blockIndex(lx, y - 1, lz)] === 0) floating++;
          if (y === s + 1 && ROOTED_PLANTS.has(nm)) { rooted++; if (col.blocks[blockIndex(lx, s, lz)] === 0) rootedBad++; }
        }
      }
    }
  }
  assertTrue(cells > 10000, `抽样环格 ${cells}`);
  assertEqual(band, 0, `d≤${TREE_CANOPY_RADIUS} 环带内扎根的植物/树干（外溢树冠叶 ${bandLeaves} 片，允许）`);
  assertTrue(rooted > 100, `d≥4 保留了自然植被（植物 ${rooted} 株）——不是整圈都禁了`);
  assertEqual(rootedBad, 0, '植物基点 = 环带实际地表+1，脚下必须实心（不悬空）');
  assertEqual(floating, 0, '树干不悬空');
});

test('REDCITY_VEG_CLEARANCE ≥ 所有树型的最大水平半径（避让距离的载荷性前提；紧）', async () => {
  let maxR = 0;
  for (const type of ['default', 'big', 'azalea', 'swamp', 'skyTree']) {
    for (let seed = 1; seed <= 30; seed++) {
      generateTree(0, 10, 0, (x, y, z) => { maxR = Math.max(maxR, Math.abs(x), Math.abs(z)); }, seed, type);
    }
  }
  for (const file of ['brich_tree.json', 'brich_tree_with_snow.json']) {      // 文件名是上游拼写（brich），勿「纠正」
    for (const b of (await (await fetch(`/assets/structures/${file}`)).json()).blocks) maxR = Math.max(maxR, Math.abs(b.x), Math.abs(b.z));
  }
  assertTrue(maxR <= TREE_CANOPY_RADIUS, `树冠最大半径 ${maxR} <= TREE_CANOPY_RADIUS ${TREE_CANOPY_RADIUS}`);
  assertEqual(maxR, TREE_CANOPY_RADIUS, '取值是紧的（swamp 树冠到 3）：变松只会白白多禁植被，变小才会让树冠侵入 core');
  assertTrue(REDCITY_VEG_CLEARANCE >= maxR);
});
