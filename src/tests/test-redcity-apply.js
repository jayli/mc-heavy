// RedCity GEN 接线 —— 阶段 1/2/2.7/2.9（Tier 1，真实 GEN 管线 + 真实产物）：core 整形 / 降级 / 尺寸不符 / 撒布过滤 / 阶段 2.9 放置。
// ⚠️ 判据里含植被阶段（阶段 3）输出的五条（core 纯度 / core 边缘 / ring 构造 / 吞并 ≡ 不存在 / 对照实验）在 test-redcity-gen-full.js（RedCity 计划 Task 7）；
// ring / core 的列整形函数本身由 test-redcity-surface.js 的直接单测（RedCity 计划 Task 4）钉住。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotEqual } from './assert.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { getRedCityInfo } from '../gen/structures/redcity-layout.js';
import { SCATTER_TYPES } from '../gen/structures/scatter.js';
import { prepareRedCityModel, setRedCityData, getRedCityData, forEachRedCityBlock, encodeRedCityJson } from '../gen/structures/redcity-data.js';
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
const SKY = /^cloud|^sky_/;
/** 注入真实产物跑 fn，结束后还原模块缓存（单测之间不串扰） */
async function withModel(fn, model = null) {
  const prev = getRedCityData();
  setRedCityData(model || await realModel());
  try { return await fn(getRedCityData()); } finally { setRedCityData(prev); }
}

test('core 整形（阶段 1 + 2.9，不依赖植被）：[WORLD_MIN_Y+1, ground] 全实心无洞穴无水；(ground, max(自然高度, SEA_Y)] 只剩烘焙内容（自然树/残丘/水体被清掉）', () => withModel(async (model) => {
  // 只看自然地表以下的高度带——植被阶段（阶段 3）的树从 n+1 起，不会落进这个带；完整高度的纯度见 test-redcity-gen-full.js（RedCity 计划 Task 7）
  let cells = 0, solidViol = 0, leftover = 0;
  for (const seed of [12345, 1, 7]) {
    const rc = redCityOf(seed);
    for (const [ox, oz] of [[138, 141], [20, 20], [230, 20], [20, 270], [230, 270], [125, 8]]) {
      const cx = Math.floor((rc.core.minX + ox) / 16), cz = Math.floor((rc.core.minZ + oz) / 16);
      const col = await gen(seed, cx, cz, rc);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
        const wx = cx * 16 + lx, wz = cz * 16 + lz;
        const info = getRedCityInfo(wx, wz, rc);
        if (!info || info.zone !== 'core') continue;
        cells++;
        const g = rc.baseY + model.ground[info.oz * model.width + info.ox];
        const top = Math.min(WORLD_MAX_Y - 1, Math.max(generateHeight(wx, wz, seed), SEA_Y));
        const baked = new Map(); forEachRedCityBlock(model, info.ox, info.oz, (dy, name) => baked.set(rc.baseY + dy, name));
        for (let y = WORLD_MIN_Y + 1; y <= g; y++) { const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]); if (nm === 'air' || nm === 'water') { solidViol++; break; } }
        for (let y = g + 1; y <= top; y++) { const nm = nameOf(col.blocks[blockIndex(lx, y, lz)]); if (nm !== 'air' && nm !== baked.get(y) && !SKY.test(nm)) leftover++; }
      }
    }
  }
  assertTrue(cells > 4000, `抽样核心格 ${cells}`);
  assertEqual(solidViol, 0, '[WORLD_MIN_Y+1, ground] 内不得有空气/水（洞穴与水体被全深度实心盖掉）');
  assertEqual(leftover, 0, '(ground, max(n, SEA_Y)] 内除烘焙内容与空中结构外必须是空气（自然残丘/水体被清掉）');
}));

test('降级路径：产物未注入时 GEN 不抛错——core 退化为 baseY 平地（全深度实心）、不写任何烘焙内容', async () => {
  const prev = getRedCityData(); setRedCityData(null);
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  try {
    const seed = 12345, rc = redCityOf(seed);
    const cx = Math.floor((rc.core.minX + 138) / 16), cz = Math.floor((rc.core.minZ + 141) / 16);
    const col = await gen(seed, cx, cz, rc);
    const lx = (rc.core.minX + 138) - cx * 16, lz = (rc.core.minZ + 141) - cz * 16;
    assertEqual(nameOf(col.blocks[blockIndex(lx, rc.baseY, lz)]), 'clay', 'baseY 及以下实心');
    assertEqual(nameOf(col.blocks[blockIndex(lx, rc.baseY + 1, lz)]), 'air', 'baseY 之上无内容');
    assertTrue(warned <= 1, '一次性 warn（不刷屏）');
  } finally { console.warn = warn; setRedCityData(prev); }
});

test('产物尺寸与布局不符 → 抛错（不会静默错位放置）', async () => {
  const bake = { width: 2, length: 2, ground: new Int16Array(4), island: new Uint8Array(4).fill(1), ents: [{ c: 0, y: 0, name: 'stone' }], dyMin: 0, dyMax: 0, stats: {} };
  const small = prepareRedCityModel(JSON.parse(JSON.stringify(encodeRedCityJson(bake, { ox: 0, oz: 0, dy: 0 }))));
  const seed = 12345, rc = redCityOf(seed);
  let threw = false;
  await withModel(async () => {
    try { await gen(seed, Math.floor(rc.core.minX / 16), Math.floor(rc.core.minZ / 16), rc); } catch (e) { threw = /尺寸/.test(String(e.message)); }
  }, small);
  assertTrue(threw, '2×2 的产物配 250×289 的布局必须抛「产物尺寸…不符」');
});

/** 单地标布局：只含一个地标（其余地标挪到天边），无 city/sky/scatter，便于对照「被吞并 ≡ 不存在」 */
function singleLandmarkLayout(kind, center, present) {
  const far = { cx: 10_000_000, cz: 10_000_000 };
  const L = { regionX: 0, regionZ: 0, pyramid: far, frozenMountain: far, snowLand: far, island: null, plainLand: null, city: null, sky: null, scatter: null, redCity: null };
  if (present) L[kind] = kind === 'plainLand' ? { ...center, baseHeight: 5 } : center;
  return L;
}

test('撒布过滤：footprint 与 influence 相交的候选整体丢弃（连影响域外的那一部分也不生成）；不相交的照常生成', async () => {
  const seed = 12345, rc = redCityOf(seed), inf = rc.influence, zMid = Math.floor((inf.minZ + inf.maxZ) / 2);
  const idx = SCATTER_TYPES.indexOf('desertPyramid');                                         // halfX=halfZ=12
  const withCandidate = (x) => ({ ...singleLandmarkLayout('pyramid', null, false), scatter: { cityScatter: new Int32Array(0), outsideScatter: Int32Array.from([x, generateHeight(x, zMid, seed) + 1, zMid, idx]) } });
  const none = singleLandmarkLayout('pyramid', null, false);
  const columnsOf = (x) => { const out = []; for (let cx = Math.floor((x - 14) / 16); cx <= Math.floor((x + 14) / 16); cx++) for (let cz = Math.floor((zMid - 14) / 16); cz <= Math.floor((zMid + 14) / 16); cz++) out.push([cx, cz]); return out; };
  const diff = async (x, redCity) => {
    let n = 0;
    for (const [cx, cz] of columnsOf(x)) {
      if (cx * 16 + 15 > inf.minX - 5) continue;                                              // 只比影响域外的列
      const a = await gen(seed, cx, cz, redCity, [withCandidate(x)]), b = await gen(seed, cx, cz, redCity, [none]);
      for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) { n++; break; }
    }
    return n;
  };
  const xTouch = inf.minX - 8;                                  // AABB 东端 minX+4 > influence.minX → 相交
  assertEqual(await diff(xTouch, rc), 0, '相交的候选带 RedCity 时：影响域外那部分也不得生成');
  assertTrue(await diff(xTouch, null) > 0, '判据有效性：不带 RedCity 时同一候选确实会生成');
  const xFar = inf.minX - 60;                                   // AABB 东端 minX-48 < influence.minX → 不相交
  assertTrue(await diff(xFar, rc) > 0, '不相交的候选带 RedCity 时照常生成');
});

test('阶段 2.9 放置：世界 y = baseY + dy（地面方块恰在 baseY+ground，不是 baseY+ground+dy）；越界 y 静默丢弃不抛错', () => withModel(async (model) => {
  const seed = 12345, rc = redCityOf(seed); const { ox, oz } = model.spawn;
  const cx = Math.floor((rc.core.minX + ox) / 16), cz = Math.floor((rc.core.minZ + oz) / 16);
  const col = await gen(seed, cx, cz, rc);
  let checked = 0;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const info = getRedCityInfo(cx * 16 + lx, cz * 16 + lz, rc); if (!info || info.zone !== 'core') continue;
    const g = model.ground[info.oz * model.width + info.ox]; let groundBlock = null;
    forEachRedCityBlock(model, info.ox, info.oz, (dy, name) => {
      if (rc.baseY + dy >= WORLD_MAX_Y) return;
      assertEqual(nameOf(col.blocks[blockIndex(lx, rc.baseY + dy, lz)]), name, `(${info.ox},${info.oz}) dy=${dy}`);
      if (dy === g) groundBlock = name; checked++;
    });
    assertNotEqual(groundBlock, null, '每个岛内列在 dy===ground 处有地面方块');
  }
  assertTrue(checked > 200, `已核对 ${checked} 个烘焙方块`);
  // 越界：把 baseY 硬抬到 90，dyMax=80 → 大量 y>=96；不得抛错，且 y<96 的部分照常写入
  const high = { ...rc, baseY: 90 };
  const colHigh = await gen(seed, cx, cz, high);
  assertTrue(colHigh.blocks.length > 0);
}));
