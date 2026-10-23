// RedCity 完整 GEN 管线（含阶段 3 植被，Tier 1）：core 纯度 / core 边缘 / ring 构造 / 吞并 ≡ 地标不存在 / 对照实验。
// 这五条的判据都包含植被阶段的输出（树冠外溢、被吞并地标的植被上下文），所以必须等 pointContext 接线（RedCity 计划 Task 7）后才成立；
// 与 test-redcity-apply.js（RedCity 计划 Task 6，不依赖阶段 3）分开，是为了让每个 Task 都有干净的 RED→GREEN。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { fillColumn, generateHeight, surfaceBlocksOfBiome } from '../gen/terrain.js';
import { getBiome } from '../gen/noise.js';
import { carveCaves } from '../gen/caves.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getRedCityInfo } from '../gen/structures/redcity-layout.js';
import { ringSurfaceY } from '../gen/structures/redcity-surface.js';
import { landmarkHalfExtent } from '../gen/structures/landmarks.js';
import { prepareRedCityModel, setRedCityData, getRedCityData, forEachRedCityBlock } from '../gen/structures/redcity-data.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, SEA_Y, blockIndex } from '../voxel/constants.js';

const reg = (() => { const r = createRegistry(); for (const d of BLOCKS) r.register(d.name, d); r.freeze(); return r; })();
const nameOf = (id) => reg.nameOf(id);
const layoutCache = new Map();
const layoutOf = (rx, rz, seed) => { const k = `${seed}:${rx},${rz}`; if (!layoutCache.has(k)) layoutCache.set(k, computeRegionLayout(rx, rz, seed)); return layoutCache.get(k); };
const layoutsFor = (cx, cz, seed) => neighborRegionKeys(cx, cz).map((k) => layoutOf(...k.split(',').map(Number), seed));
const redCityOf = (seed) => layoutOf(0, 0, seed).redCity;

/** 与 world-worker.js 的 gen 同序：fillColumn → carveCaves → applyStructuresToColumn（→ 光照，这里不需要） */
async function gen(seed, cx, cz, redCity, layouts = layoutsFor(cx, cz, seed)) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg); carveCaves(col, seed);
  await applyStructuresToColumn(col, seed, reg, layouts, redCity);
  return col;
}
let _model = null;
async function realModel() {
  if (!_model) _model = prepareRedCityModel(await (await fetch('/assets/redcity/redcity.json')).json());
  return _model;
}
/** 注入真实产物跑 fn，结束后还原模块缓存（单测之间不串扰） */
async function withModel(fn, model = null) {
  const prev = getRedCityData();
  setRedCityData(model || await realModel());
  try { return await fn(getRedCityData()); } finally { setRedCityData(prev); }
}
const SKY = /^cloud|^sky_/;

test('core 纯度（真实 GEN，3 个 seed）：全深度实心无洞穴无水；地面之上除烘焙内容与空中结构外全空；烘焙内容不被覆盖（阶段 2.9 后写胜）', () => withModel(async (model) => {
  let cells = 0, solidViol = 0, foreign = 0, overwritten = 0, skyCells = 0;
  for (const seed of [12345, 1, 7]) {
    const rc = redCityOf(seed);
    for (const [ox, oz] of [[138, 141], [20, 20], [230, 20], [20, 270], [230, 270], [125, 8]]) {
      const cx = Math.floor((rc.core.minX + ox) / 16), cz = Math.floor((rc.core.minZ + oz) / 16);
      const col = await gen(seed, cx, cz, rc);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const info = getRedCityInfo(cx * 16 + lx, cz * 16 + lz, rc);
        if (!info || info.zone !== 'core') continue;
        cells++;
        const g = rc.baseY + model.ground[info.oz * model.width + info.ox];
        const baked = new Map(); forEachRedCityBlock(model, info.ox, info.oz, (dy, name) => baked.set(rc.baseY + dy, name));
        for (let y = WORLD_MIN_Y + 1; y <= g; y++) { const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]); if (nm === 'air' || nm === 'water') { solidViol++; break; } }
        for (let y = g + 1; y < WORLD_MAX_Y; y++) {
          const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]); const want = baked.get(y);
          if (want) { if (nm !== want) overwritten++; } else if (nm !== 'air') { if (SKY.test(nm)) skyCells++; else foreign++; }
        }
      }
    }
  }
  assertTrue(cells > 4000, `抽样核心格 ${cells}（够多才有说服力）`);
  assertEqual(solidViol, 0, '[WORLD_MIN_Y+1, ground] 内不得有空气/水（洞穴与水体被全深度实心盖掉）');
  assertEqual(foreign, 0, '地面之上不得有自然树/残丘/水/植被——只允许烘焙内容与空中结构');
  assertEqual(overwritten, 0, '烘焙内容不得被云/空岛覆盖（2.9 在 2.5 之后）');
  assertTrue(skyCells > 0, '前提：RedCity 空域里确实写过云/空岛（否则「不被覆盖」是空洞的通过）');
}));

test('core 边缘：外溢树冠/植物不得侵入 core（沿四条边各抽 9 个 column，5 个 seed）', () => withModel(async (model) => {
  let cells = 0, intrude = 0;
  for (const seed of [12345, 1, 7, 2, 3]) {
    const rc = redCityOf(seed), c = rc.core; const cols = new Set();
    for (let t = 0; t <= 1; t += 0.125) {
      const x = c.minX + (c.maxX - c.minX) * t, z = c.minZ + (c.maxZ - c.minZ) * t;
      for (const [px, pz] of [[x, c.minZ], [x, c.maxZ], [c.minX, z], [c.maxX, z]]) cols.add(`${Math.floor(px / 16)},${Math.floor(pz / 16)}`);
    }
    for (const key of cols) {
      const [cx, cz] = key.split(',').map(Number); const col = await gen(seed, cx, cz, rc);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const info = getRedCityInfo(cx * 16 + lx, cz * 16 + lz, rc); if (!info || info.zone !== 'core') continue; cells++;
        const g = rc.baseY + model.ground[info.oz * model.width + info.ox]; const baked = new Map();
        forEachRedCityBlock(model, info.ox, info.oz, (dy, name) => baked.set(rc.baseY + dy, name));
        for (let y = g + 1; y < WORLD_MAX_Y; y++) { const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]); if (nm !== 'air' && !SKY.test(nm) && baked.get(y) !== nm) intrude++; }
      }
    }
  }
  assertTrue(cells > 10000, `抽样核心边缘格 ${cells}`);
  assertEqual(intrude, 0);
}));

/** 单地标布局：只含一个地标（其余地标挪到天边），无 city/sky/scatter，便于对照「被吞并 ≡ 不存在」 */
function singleLandmarkLayout(kind, center, present) {
  const far = { cx: 10_000_000, cz: 10_000_000 };
  const L = { regionX: 0, regionZ: 0, pyramid: far, frozenMountain: far, snowLand: far, island: null, plainLand: null, city: null, sky: null, scatter: null, redCity: null };
  if (present) L[kind] = kind === 'plainLand' ? { ...center, baseHeight: 5 } : center;
  return L;
}

test('吞并 ≡ 地标不存在：五类地标逐类——影响域外的 column，「被吞并」与「根本没有该地标」逐字节相同（含地形、JSON 结构、植被）', async () => {
  const seed = 12345, rc = redCityOf(seed), inf = rc.influence;
  for (const kind of ['pyramid', 'frozenMountain', 'snowLand', 'island', 'plainLand']) {
    const fp = landmarkHalfExtent(kind);
    const center = { cx: inf.minX - 6, cz: Math.floor((inf.minZ + inf.maxZ) / 2) };      // AABB 必与 influence 相交
    const LA = singleLandmarkLayout(kind, center, true), LB = singleLandmarkLayout(kind, center, false);
    let compared = 0, differsWhenPresent = 0;
    for (let cx = Math.floor((center.cx - fp.halfX) / 16); cx <= Math.floor((inf.minX - 5) / 16); cx++) {
      for (let cz = Math.floor((center.cz - fp.halfZ) / 16); cz <= Math.floor((center.cz + fp.halfZ) / 16); cz++) {
        if (cx * 16 + 15 > inf.minX - 5) continue;                                            // 离 influence ≥4 格（树冠外溢余量）
        const erased = await gen(seed, cx, cz, rc, [LA]);
        const absent = await gen(seed, cx, cz, rc, [LB]);
        const present = await gen(seed, cx, cz, null, [LA]);                                  // 不带 RedCity：地标真实存在
        compared++;
        for (let i = 0; i < erased.blocks.length; i++) {
          if (erased.blocks[i] !== absent.blocks[i] || erased.meta[i] !== absent.meta[i]) throw new Error(`${kind}: column (${cx},${cz}) 被吞并 ≠ 不存在 @${i}`);
        }
        for (let i = 0; i < present.blocks.length; i++) if (present.blocks[i] !== absent.blocks[i]) { differsWhenPresent++; break; }
      }
    }
    assertTrue(compared > 0, `${kind}: 有可比 column`);
    assertTrue(differsWhenPresent > 0, `${kind}: 判据有效性——地标真实存在时这些 column 必须与「不存在」不同（否则对照是空洞的）`);
  }
});

test('对照实验：距 influence ≥32 格（> 最大撒布半宽 24）且不在被吞并地标范围内的 column，加 RedCity 与不加逐字节相同', async () => {
  let same = 0, diffInErased = 0;
  for (const seed of [12345, 1]) {
    const rc = redCityOf(seed), r = rc.influence;
    const boxes = [];
    for (let rx = Math.floor(r.minX / 400) - 1; rx <= Math.floor(r.maxX / 400) + 1; rx++) for (let rz = Math.floor(r.minZ / 400) - 1; rz <= Math.floor(r.maxZ / 400) + 1; rz++) {
      const L = layoutOf(rx, rz, seed);
      for (const kind of ['pyramid', 'frozenMountain', 'snowLand', 'island', 'plainLand']) {
        const c = L[kind]; if (!c) continue; const fp = landmarkHalfExtent(kind);
        if (!(c.cx + fp.halfX < r.minX || c.cx - fp.halfX > r.maxX || c.cz + fp.halfZ < r.minZ || c.cz - fp.halfZ > r.maxZ)) boxes.push({ minX: c.cx - fp.halfX - 4, maxX: c.cx + fp.halfX + 4, minZ: c.cz - fp.halfZ - 4, maxZ: c.cz + fp.halfZ + 4 });
      }
    }
    for (let cx = Math.floor((r.minX - 160) / 16); cx <= Math.floor((r.maxX + 160) / 16); cx += 3) for (let cz = Math.floor((r.minZ - 160) / 16); cz <= Math.floor((r.maxZ + 160) / 16); cz += 3) {
      const x0 = cx * 16, z0 = cz * 16;
      if (!(x0 + 15 < r.minX - 32 || x0 > r.maxX + 32 || z0 + 15 < r.minZ - 32 || z0 > r.maxZ + 32)) continue;
      const a = await gen(seed, cx, cz, rc), b = await gen(seed, cx, cz, null);
      let eq = true; for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i] || a.meta[i] !== b.meta[i]) { eq = false; break; }
      const inErased = boxes.some((q) => !(x0 + 15 < q.minX || x0 > q.maxX || z0 + 15 < q.minZ || z0 > q.maxZ));
      if (eq) same++; else if (inErased) diffInErased++; else throw new Error(`seed ${seed} column (${cx},${cz}) 不在被吞并地标范围内却与基线不同（误伤）`);
    }
  }
  assertTrue(same > 200, `逐字节相同的 column ${same}`);
  assertTrue(diffInErased > 0, '判据有效性：被吞并地标范围内确实有变化（否则吞并根本没生效）');
});

test('ring 构造（真实 GEN，3 个 seed）：s≠n 时表层/次表层 = 该点 biome 的 surf/sub；s 以上无水；外缘(d=24) 地表 = max(自然,SEA_Y+1)；填方/挖方/水域转陆地三种情形都被覆盖到', async () => {
  const seen = { fill: 0, cut: 0, water: 0 }; let cells = 0, surfBad = 0, subBad = 0, waterAbove = 0, outerBad = 0, hollow = 0;
  for (const seed of [12345, 1, 7]) {
    const rc = redCityOf(seed), c = rc.core; const cols = new Set();
    const add = (x, z) => cols.add(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    for (const t of [0.2, 0.5, 0.8]) {
      const mx = c.minX + (c.maxX - c.minX) * t, mz = c.minZ + (c.maxZ - c.minZ) * t;
      for (const d of [4, 20, 36]) { add(mx, c.minZ - d); add(mx, c.maxZ + d); add(c.minX - d, mz); add(c.maxX + d, mz); }
    }
    for (const key of cols) {
      const [cx, cz] = key.split(',').map(Number); const col = await gen(seed, cx, cz, rc);   // 不注入产物：ring 不依赖产物
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz; const info = getRedCityInfo(wx, wz, rc); if (!info || info.zone !== 'ring') continue;
        cells++;
        const n = generateHeight(wx, wz, seed), s = ringSurfaceY(info.edgeDistance, n, rc.baseY);
        const [surf, sub] = surfaceBlocksOfBiome(getBiome(wx, wz, seed));
        if (s > n) {
          seen.fill++; if (n < SEA_Y) seen.water++;
          // 填方区间 (n, s-2] 必须是实心补实（水域转陆地时尤其不能清成 air，否则地下出空洞，玩家挖下去会掉进洞里）
          for (let y = n + 1; y <= s - 2; y++) if (col.blocks[blockIndex(lx, y, lz)] === 0) { hollow++; break; }
        } else if (s < n) seen.cut++;
        if (s !== n) {
          if (nameOf(col.blocks[blockIndex(lx, s, lz)]) !== surf) surfBad++;
          if (nameOf(col.blocks[blockIndex(lx, s - 1, lz)]) !== sub) subBad++;
        }
        if (info.edgeDistance === 24 && s !== Math.max(n, SEA_Y + 1)) outerBad++;
        for (let y = s + 1; y < WORLD_MAX_Y; y++) if (nameOf(col.blocks[blockIndex(lx, y, lz)]) === 'water') { waterAbove++; break; }
      }
    }
  }
  assertTrue(cells > 10000, `抽样环格 ${cells}`);
  assertTrue(seen.fill > 0 && seen.cut > 0 && seen.water > 0, `三种情形都要覆盖到（填方 ${seen.fill} / 挖方 ${seen.cut} / 水域转陆地 ${seen.water}）`);
  assertEqual(surfBad, 0, '表层方块');
  assertEqual(subBad, 0, '次表层方块');
  assertEqual(waterAbove, 0, 's ≥ SEA_Y+1 恒成立 → s 以上不会残留水');
  assertEqual(hollow, 0, '填方区间不得有空洞（水域转陆地用 clay 补实，不是清成 air）');
  assertEqual(outerBad, 0, '外缘与外侧自然地形衔接（含水域按 SEA_Y+1 计的岸壁）');
});
