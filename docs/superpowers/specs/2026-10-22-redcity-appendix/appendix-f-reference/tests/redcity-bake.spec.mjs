import { test, expect } from 'playwright/test';
import fs from 'node:fs';

// RedCity 烘焙核心（Tier 1，**Node 侧**，不开浏览器）。
//
// 为什么是 Playwright spec 而不是 src/tests 的浏览器单测：被测的 tools/*.mjs 要在浏览器里 import，
// 但静态服务器的 MIME 表没有 `.mjs`（→ application/octet-stream），Chromium 对 module script 做严格 MIME 检查，
// 实测 `import('/…/xxx.mjs')` 直接 "Failed to fetch dynamically imported module"。烘焙核心是 Node-only 的离线工具，
// 本来也不该进浏览器。本文件不用 `page` fixture，所以不会启动浏览器；可单文件运行：
//   npx playwright test tests/redcity-bake.spec.mjs
//
// 全部用「合成小网格」（毫秒级），不读 76 MB 的真实 schematic；最后一条才跑真实模型（~1 s）做黄金比对。

const core = await import('../tools/redcity-bake-core.mjs');
const cfg = await import('../tools/redcity-config.mjs');
const fp = await import('../tools/redcity-fingerprint.mjs');
const { REDCITY_BASE_Y_MAX, REDCITY_DY_MAX_BUDGET, REDCITY_GROUND_FLOOR } = await import('../src/gen/structures/region-config.js');

/** 合成网格：索引 (y*L+z)*W+x，格值 = (id<<4)|meta */
function makeGrid(W, H, L) {
  const grid = new Uint16Array(W * H * L);
  const idx = (x, y, z) => (y * L + z) * W + x;
  const api = {
    W, H, L, grid,
    set(x, y, z, id, meta = 0) { grid[idx(x, y, z)] = (id << 4) | meta; return api; },
    box(x0, x1, y0, y1, z0, z1, id, meta = 0) { for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) api.set(x, y, z, id, meta); return api; },
  };
  return api;
}
// 小模型要放宽的两个参数：碎片阈值（真实 30）与贴边保护（真实 8）；其余与产物一致
const SMALL = { ...cfg.REDCITY_BAKE_PARAMS, minComp: 4, borderKeep: 2 };
const bake = (g, params = SMALL) => core.bakeRedCityCore(g, {
  isEmpty: cfg.isEmpty, isSkin: cfg.isSkin, isBuilding: cfg.isBuildingMat, nameOf: (k) => cfg.mappingOf(k).name, params,
});
const CLAY = 82, PLANKS = 5, LEAVES = 18, GLASS = 20, STONE = 1;
const colEntries = (b, ox, oz, minX, minZ) => b.ents.filter((e) => e.c === (oz - minZ) * b.width + (ox - minX)).map((e) => e.y).sort((a, c) => a - c);

test('地面 = 外部可达的最低 skin 表面：拱洞/桥下通道不被填实（不是「每列最高 skin」）', () => {
  // 12×12 的 clay 地台（顶面 y=3）+ 一座横跨 z 向的桥面（x∈[6,9] 的 y=6..7）；桥下 y=4..5 两端通向外部空气
  const g = makeGrid(16, 12, 16).box(2, 13, 0, 3, 2, 13, CLAY).box(6, 9, 6, 7, 2, 13, CLAY);
  const b = bake(g);
  // 桥下列 (7,7)：地面是地台顶 y=3 → 保留 y=2,3（K=2）与桥面 y=6,7；中间 y=4,5 是通道，必须是空的（yRel 1,2 缺席）
  expect(colEntries(b, 7, 7, 2, 2)).toEqual([-1, 0, 3, 4]);
  // 若误取「每列最高 skin」(=7)：保留的会是 [6,7] 且地面抬高 → 通道被运行时的全深度实心填死。上面的断言就是钉这个。
});

test('保留规则：地面往下只留 K=2 层，地面以上全部保留', () => {
  const g = makeGrid(12, 10, 12).box(1, 10, 0, 5, 1, 10, CLAY);                 // 10×10 平板，顶面 y=5，厚 6 层
  const b = bake(g);
  expect(b.ents.length).toBe(2 * 10 * 10);                                       // 每列恰 2 个（y=4,5）
  expect(b.stats.groundMin).toBe(0); expect(b.stats.groundMax).toBe(0);          // 全岛同高 → ground′ 恒 0
  g.set(5, 8, 5, LEAVES);                                                        // 地面之上的悬空叶子
  expect(bake(g).ents.length).toBe(2 * 10 * 10 + 1);
});

test('I3 ground 下限 + 压缩：高低两半的地台，低半被钳到 GROUND_FLOOR', () => {
  const g = makeGrid(14, 40, 8).box(1, 6, 0, 10, 1, 6, CLAY).box(7, 12, 0, 30, 1, 6, CLAY);   // 左半顶 y=10，右半顶 y=30
  const b = bake(g);
  expect(b.stats.groundMax).toBe(0);                                             // 右半 = 中位（sMed=30）→ 0
  expect(b.stats.groundMin).toBe(REDCITY_GROUND_FLOOR);                          // 左半 rel=-20 → round(-6.8)=-7 → 钳到 -5
});

test('刚性平移：斜坡地形上的建筑，所有块共用同一平移量（顶层仍是平的）；严格 I5 恒 0', () => {
  // 台阶地形：顶面 y = 10 + floor((x-2)/3)；3×3 木塔立在 x∈[6,8]、z∈[6,8]，从各列地面+1 一路盖到 y=17
  const g = makeGrid(16, 24, 16);
  for (let x = 2; x <= 13; x++) g.box(x, x, 0, 10 + Math.floor((x - 2) / 3), 2, 13, CLAY);
  for (let x = 6; x <= 8; x++) g.box(x, x, 10 + Math.floor((x - 2) / 3) + 1, 17, 6, 8, PLANKS);
  const b = bake(g);
  expect(b.stats.rigid).toBe(1);
  expect(b.checks.intraCompBreaks).toBe(0);
  const topY = Math.max(...b.ents.filter((e) => e.name === 'planks').map((e) => e.y));
  const topLayer = b.ents.filter((e) => e.name === 'planks' && e.y === topY);
  expect(topLayer.length).toBe(9);                                               // 源 y=17 的 9 块仍在同一高度（没被逐列剪成台阶）
});

test('贴边的建筑不做刚性平移（边缘地面必须收敛到 0，见 I2）', () => {
  const g = makeGrid(16, 24, 16).box(2, 13, 0, 8, 2, 13, CLAY).box(2, 4, 9, 14, 2, 4, PLANKS);   // 木塔贴着包围盒边（距边 0 < borderKeep 2）
  const b = bake(g);
  expect(b.stats.nearBorder).toBe(1);
  expect(b.stats.rigid).toBe(0);
});

test('外推：岛外地面每 decay 格降 1 并收敛到 0；I1/I2/I3 成立；岛贴着包围盒边且地面非 0 → assertInvariants 抛 I2', () => {
  const lone = (g, x, z) => g.set(x, 12, z, LEAVES);                              // 孤立叶子：撑开包围盒，所在列无地面
  // 岛面：x∈[20,34] 顶 y=30（占多数 → sMed=30，ground′=0），x∈[35,39] 顶 y=10（rel=-20 → 钳到 -5）；包围盒 60×60，
  // 低半离右边界 20 格 ≥ 2×5（-5 每 2 格收 1 → 10 格归零），所以 I2 成立。
  const g = makeGrid(60, 50, 60).box(20, 34, 0, 30, 20, 39, CLAY).box(35, 39, 0, 10, 20, 39, CLAY);
  lone(g, 0, 0); lone(g, 59, 59);
  const b = bake(g);
  expect(b.stats.borderNonZero).toBe(0);
  expect(b.stats.outsideAdjMax).toBeLessThanOrEqual(1);
  expect(b.stats.groundMin).toBeGreaterThanOrEqual(REDCITY_GROUND_FLOOR);
  expect(() => fp.assertInvariants(b)).not.toThrow();
  // 反例：低半地台直接贴着包围盒左边 → 边界 ground = -5 ≠ 0
  const g2 = makeGrid(30, 50, 20).box(0, 9, 0, 10, 2, 17, CLAY).box(10, 19, 0, 30, 2, 17, CLAY);
  const b2 = bake(g2);
  expect(b2.stats.borderNonZero).toBeGreaterThan(0);
  expect(() => fp.assertInvariants(b2)).toThrow(/I2/);
});

test('同格冲突去重 + 确定性：产物无重复 (列, yRel)；两次烘焙逐条目相同', () => {
  const g = makeGrid(16, 24, 16).box(2, 13, 0, 8, 2, 13, CLAY).box(6, 8, 9, 14, 6, 8, PLANKS).box(7, 7, 9, 11, 9, 9, GLASS);
  const b1 = bake(g), b2 = bake(g);
  const seen = new Set();
  for (const e of b1.ents) { const k = `${e.c}|${e.y}`; expect(seen.has(k), `重复格 ${k}`).toBe(false); seen.add(k); }
  expect(JSON.stringify(b2.ents)).toBe(JSON.stringify(b1.ents));
});

/** 出生点：手工构造烘焙模型（width×length 的平地，ents 只含地面方块） */
function flatModel(w, l, extra = []) {
  const N = w * l, ground = new Int16Array(N), island = new Uint8Array(N).fill(1), ents = [];
  for (let c = 0; c < N; c++) ents.push({ c, y: 0, name: 'stone' });
  return { width: w, length: l, ground, island, ents: ents.concat(extra) };
}
const SP = cfg.REDCITY_SPAWN_PARAMS;
const at = (w, x, z) => z * w + x;

test('出生点：取距中心最近的合格列；本列头顶 24 格有东西 → 排除（v1.0「上方 2 格空气」会选中的屋顶形态）', () => {
  const w = 21, l = 21;
  const roof = [{ c: at(w, 10, 10), y: 10, name: 'oxidized_cut_copper' }];     // 正中心上方 10 格有屋顶块——v1.0 弱判据会选它
  const m = flatModel(w, l, roof);
  const s = core.pickSpawn(m, SP);
  expect(s).not.toBeNull();
  expect(`${s.ox},${s.oz}`).not.toBe('10,10');                                  // 中心被屋顶盖住 → 不能选
  expect(Math.hypot(s.ox - 10, s.oz - 10)).toBeGreaterThan(0);
  expect(s.dy).toBe(0);
});

test('出生点：5×5 ground 极差 >1 排除；5×5 内任一列头顶 3 格内有方块（贴墙/树冠）排除；脚下必须是烘焙出的岛面方块', () => {
  const w = 21, l = 21;
  const bumpy = flatModel(w, l); bumpy.ground[at(w, 10, 8)] = 2;                // 中心 5×5 内有一格抬高 2 → 极差 2
  const sb = core.pickSpawn(bumpy, SP);
  expect(Math.max(Math.abs(sb.ox - 10), Math.abs(sb.oz - 8))).toBeGreaterThan(2);    // 选中列的 5×5 窗口不含抬高的那格 (10,8)
  const walled = flatModel(w, l, [{ c: at(w, 12, 10), y: 2, name: 'stone_bricks' }]);   // (12,10) 头顶 2 格有墙
  const sw = core.pickSpawn(walled, SP);
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) expect(`${sw.ox + dx},${sw.oz + dz}`).not.toBe('12,10');
  const noSurface = flatModel(w, l); noSurface.ents = noSurface.ents.filter((e) => e.c !== at(w, 10, 10));   // 中心列没有地面方块
  const sn = core.pickSpawn(noSurface, SP);
  expect(`${sn.ox},${sn.oz}`).not.toBe('10,10');
  expect(core.pickSpawn(flatModel(4, 4), SP)).toBeNull();                       // 太小：5×5 窗口放不下 → null
});

test('映射：skin 与 building 清单无交集；规则顺序（meta 特例在通配前）；coverage 只统计保留的方块（barrier 不算未覆盖）', () => {
  for (let id = 0; id < 256; id++) for (let meta = 0; meta < 16; meta++) {
    const key = (id << 4) | meta;
    expect(cfg.isSkin(key) && cfg.isBuildingMat(key), `${id}:${meta} 同时是 skin 与 building`).toBe(false);
  }
  const wild = new Set();
  for (const [id, meta] of cfg.MAPPING_RULES) { if (meta === '*') wild.add(id); else expect(wild.has(id), `${id}:${meta} 特例排在通配之后（永不命中）`).toBe(false); }
  expect(cfg.mappingOf((95 << 4) | 6).name).toBe('glass_block');                // U3：粉色玻璃也是 glass_block（不是 pink_wool）
  expect(cfg.mappingOf((35 << 4) | 6).name).toBe('pink_wool');
  // 覆盖率：id 200 无规则 → 未覆盖；≥50 块列入 bigUncovered；barrier(166) 不计入
  const g = makeGrid(10, 10, 10);
  for (let i = 0; i < 60; i++) g.grid[i] = (200 << 4);
  for (let i = 100; i < 140; i++) g.grid[i] = (166 << 4);
  for (let i = 200; i < 300; i++) g.grid[i] = (CLAY << 4);
  const cov = fp.computeMappingCoverage({ mappingOf: cfg.mappingOf, grid: g.grid });
  expect(cov.uncovered).toBe(60); expect(cov.bigUncovered.map((x) => x.key)).toEqual(['200:0']);
  expect(() => fp.assertMappingCoverage(cov)).toThrow(/块数 ≥50/);
});

test('I4 常量自洽：BASE_Y_MAX + DY_MAX_BUDGET ≤ WORLD_MAX_Y-1（独占上界：合法 y 最大 95，< 96 不算对）', () => {
  expect(REDCITY_BASE_Y_MAX + REDCITY_DY_MAX_BUDGET).toBeLessThanOrEqual(95);
});

test('真实模型黄金比对：烘焙统计 = 评审实测值；重烘结果与已入库产物逐位一致（blocks/ground/island/palette/spawn/stats/指纹）', async () => {
  test.setTimeout(60_000);
  const { bakeFromSchematic } = await import('../tools/bake-redcity.mjs');
  const { REDCITY_JSON } = fp;
  const { doc, bake: b, invariants } = bakeFromSchematic();
  expect(b.stats).toMatchObject({ terrainColumns: 38636, comps: 134, rigid: 125, nearBorder: 9, retained: 244647, conflicts: 202, groundMin: -5, groundMax: 43, borderNonZero: 0, outsideAdjMax: 1, contactBreaks: 84 });
  expect(b.checks.intraCompBreaks).toBe(0);
  expect(invariants.i5Ratio).toBeLessThan(0.001);
  const committed = JSON.parse(fs.readFileSync(REDCITY_JSON, 'utf8'));
  for (const k of ['format', 'version', 'width', 'length', 'dyMin', 'dyMax', 'spawn', 'palette', 'ground', 'island', 'blocks', 'stats', 'fingerprint']) {
    expect(JSON.stringify(doc[k]), `产物字段 ${k} 与重烘不一致——改了算法/参数/映射却没重烘入库？`).toBe(JSON.stringify(committed[k]));
  }
});
