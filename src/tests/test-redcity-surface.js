// RedCity 地表与吞并判定（Tier 1）：过渡环台阶钳制（可证明上界）/ 边缘衔接 / 地标外包范围 / 吞并判定
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import { buildCityLayout } from '../gen/structures/city-layout.js';
import { buildRedCityLayout, getRedCityInfo } from '../gen/structures/redcity-layout.js';
import {
  ringMaxDelta, ringSurfaceY, getRedCitySurfaceY, landmarkErased, erasedFlags, shapeRedCityCore, shapeRedCityRing,
} from '../gen/structures/redcity-surface.js';
import {
  landmarkHalfExtent, getPyramidInfo, getFrozenMountainInfo, getSnowLandInfo, getIslandInfo, getPlainLandInfo,
} from '../gen/structures/landmarks.js';
import { generateHeight } from '../gen/terrain.js';
import { REDCITY_TRANSITION, REDCITY_SIZE } from '../gen/structures/region-config.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { SEA_Y, WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

const E = (n) => Math.max(n, SEA_Y + 1);       // 有效自然高度：水域按海平面+1 计（水一律变陆地）

test('ringMaxDelta：外缘 0，向内每 3 格多允许 1 格；非增', () => {
  const want = { 1: 7, 3: 7, 4: 6, 6: 6, 7: 5, 21: 1, 22: 0, 24: 0 };
  for (const [d, m] of Object.entries(want)) assertEqual(ringMaxDelta(Number(d)), m, `d=${d}`);
  for (let d = 2; d <= REDCITY_TRANSITION; d++) assertTrue(ringMaxDelta(d) <= ringMaxDelta(d - 1), `非增 @${d}`);
});

test('ringSurfaceY：外缘恒等于有效自然高度（含水域 → SEA_Y+1）；baseY 落在带内则取 baseY；否则贴带缘', () => {
  for (let n = -12; n <= 16; n++) assertEqual(ringSurfaceY(REDCITY_TRANSITION, n, 4), E(n), `d=24 n=${n}`);
  assertEqual(ringSurfaceY(1, -9, 4), 4, '湖底(-9)→水域按 -1 计，d=1 带宽 7：4 在 [-8,6] 内 → 取 baseY');
  assertEqual(ringSurfaceY(20, 14, 4), 13, 'd=20 带宽 1：自然 14 比 baseY 高 → 只允许降 1 格');
  assertEqual(ringSurfaceY(20, -9, 8), 0, 'd=20：e=-1，baseY=8 比带高 → 只允许升 1 格');
  assertTrue(ringSurfaceY(5, -9, 4) >= SEA_Y + 1, '任何情形 s >= SEA_Y+1：s 以上不会残留水');
});

/** 在 influence 外扩一圈的网格上预算有效自然高度（每格只调一次 generateHeight） */
function ringGrid(seed) {
  const rc = buildRedCityLayout(seed, buildCityLayout(seed)); const c = rc.core; const W = REDCITY_TRANSITION;
  const x0 = c.minX - W, z0 = c.minZ - W, w = REDCITY_SIZE.X + 2 * W, h = REDCITY_SIZE.Z + 2 * W;
  const e = new Int16Array(w * h), s = new Int16Array(w * h).fill(-9999), d = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const info = getRedCityInfo(x0 + i, z0 + j, rc); const k = j * w + i;
    e[k] = E(generateHeight(x0 + i, z0 + j, seed));
    if (info && info.zone === 'ring') { d[k] = info.edgeDistance; s[k] = ringSurfaceY(info.edgeDistance, generateHeight(x0 + i, z0 + j, seed), rc.baseY); }
  }
  return { rc, w, h, e, s, d };
}

test('环内相邻格：|Δs| ≤ |Δe|+1 恒成立（可证明上界）；|Δs|>1 的占比 ≤ 2%（20 个 seed，实测最差 0.69%）', () => {
  // ⚠️ 不能断言「环内相邻格高差 ≤ 1」：自然生物群系边界本身就有最大 11 格的台阶，环只是继承它（seed 12345 就有 98 对 >1）。
  // 环能保证的是「不比自然地形多造出超过 1 格的高差」。
  for (let seed = 1; seed <= 20; seed++) {
    const { w, h, e, s } = ringGrid(seed);
    let pairs = 0, big = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i; if (s[k] === -9999) continue;
      for (const k2 of [i + 1 < w ? k + 1 : -1, j + 1 < h ? k + w : -1]) {
        if (k2 < 0 || s[k2] === -9999) continue;
        pairs++;
        const ds = Math.abs(s[k] - s[k2]), de = Math.abs(e[k] - e[k2]);
        if (ds > de + 1) throw new Error(`seed ${seed} 违反 |Δs| ≤ |Δe|+1：Δs=${ds} Δe=${de} @k=${k}`);
        if (ds > 1) big++;
      }
    }
    assertTrue(big / pairs <= 0.02, `seed ${seed}: |Δs|>1 占比 ${(big / pairs * 100).toFixed(2)}% <= 2%`);
  }
});

test('R4 衔接：core 边缘一圈（d=1）对 baseY 的台阶 >2 的占比 ≤ 5%（seed 1–80，实测最差 3.88%）；外缘(d=24)连续', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const rc = buildRedCityLayout(seed, buildCityLayout(seed)); const c = rc.core;
    let n = 0, bad = 0;
    const cell = (x, z, d) => { n++; if (Math.abs(ringSurfaceY(d, generateHeight(x, z, seed), rc.baseY) - rc.baseY) > 2) bad++; };
    for (let x = c.minX - 1; x <= c.maxX + 1; x++) { cell(x, c.minZ - 1, 1); cell(x, c.maxZ + 1, 1); }
    for (let z = c.minZ; z <= c.maxZ; z++) { cell(c.minX - 1, z, 1); cell(c.maxX + 1, z, 1); }
    assertTrue(bad / n <= 0.05, `seed ${seed}: 边缘台阶>2 占比 ${(bad / n * 100).toFixed(2)}% <= 5%`);
  }
});

test('getRedCitySurfaceY：core = baseY + ground（取注入模型）；模型缺失 → baseY；ring = ringSurfaceY；影响域外 = 有效自然高度', () => {
  const seed = 12345; const rc = buildRedCityLayout(seed, buildCityLayout(seed)); const c = rc.core;
  const ground = new Array(REDCITY_SIZE.X * REDCITY_SIZE.Z).fill(0); ground[3 * REDCITY_SIZE.X + 5] = 7;
  const model = { width: REDCITY_SIZE.X, length: REDCITY_SIZE.Z, ground };
  assertEqual(getRedCitySurfaceY(c.minX + 5, c.minZ + 3, rc, seed, model), rc.baseY + 7);
  assertEqual(getRedCitySurfaceY(c.minX + 6, c.minZ + 3, rc, seed, model), rc.baseY);
  assertEqual(getRedCitySurfaceY(c.minX + 5, c.minZ + 3, rc, seed, null), rc.baseY, '模型未注入：core 退化为 baseY（防御路径）');
  const rx = c.maxX + 10, rz = c.minZ + 40;
  assertEqual(getRedCitySurfaceY(rx, rz, rc, seed, model), ringSurfaceY(10, generateHeight(rx, rz, seed), rc.baseY));
  const ox = c.maxX + REDCITY_TRANSITION + 5;
  assertEqual(getRedCitySurfaceY(ox, rz, rc, seed, model), E(generateHeight(ox, rz, seed)));
});

/** 暴力扫描：info 非空的偏移集合是否都落在 landmarkHalfExtent 内；并返回 info 实际覆盖的最大 |dx| / |dz| */
function scanInfo(infoFn, range = 70) {
  let maxX = 0, maxZ = 0;
  for (let dx = -range; dx <= range; dx++) for (let dz = -range; dz <= range; dz++) {
    if (infoFn(dx, dz)) { maxX = Math.max(maxX, Math.abs(dx)); maxZ = Math.max(maxZ, Math.abs(dz)); }
  }
  return { maxX, maxZ };
}

test('地标外包范围权威：landmarkHalfExtent 与 getXxxInfo 的实际判定范围一致（暴力扫描；防漂移）', async () => {
  const seed = 12345, c = { cx: 0, cz: 0 };
  const det = {
    pyramid: scanInfo((x, z) => getPyramidInfo(x, z, c)),
    frozenMountain: scanInfo((x, z) => getFrozenMountainInfo(x, z, c, seed)),
    snowLand: scanInfo((x, z) => getSnowLandInfo(x, z, c, seed)),
    island: scanInfo((x, z) => getIslandInfo(x, z, c, seed)),
    plainLand: scanInfo((x, z) => getPlainLandInfo(x, z, { ...c, baseHeight: 0 })),
  };
  for (const kind of ['pyramid', 'frozenMountain', 'snowLand', 'island']) {
    const h = landmarkHalfExtent(kind);
    assertEqual(det[kind].maxX, h.halfX, `${kind} halfX：info 实际覆盖 === 声明（紧）`);
    assertEqual(det[kind].maxZ, h.halfZ, `${kind} halfZ`);
  }
  // 海岛真实范围是 ±25（getIslandInfo 入口 AABB）——apply.js 里的 `dist < 39` 永远到不了，不得据此取 39
  assertEqual(landmarkHalfExtent('island').halfX, 25);
  // 平原岛：地形 ±15，但它的 JSON 结构（pyramid_island.json）在阶段 2 一并光栅化，吞并必须两者一起算
  const pl = landmarkHalfExtent('plainLand');
  assertTrue(det.plainLand.maxX <= pl.halfX && det.plainLand.maxZ <= pl.halfZ, '地形范围 ⊂ 声明范围');
  for (const [file, kind] of [['pyramid_island.json', 'plainLand'], ['tower.json', 'island']]) {
    const blocks = (await (await fetch(`/assets/structures/${file}`)).json()).blocks;
    const h = landmarkHalfExtent(kind);
    let mx = 0, mz = 0; for (const b of blocks) { mx = Math.max(mx, Math.abs(b.x)); mz = Math.max(mz, Math.abs(b.z)); }
    assertTrue(mx <= h.halfX && mz <= h.halfZ, `${file} 实际占地 (${mx},${mz}) ⊂ ${kind} 声明范围 (${h.halfX},${h.halfZ})`);
  }
});

test('landmarkErased：与 influence 相交（含边界相接）→ true；不相交 → false；redCity/center 缺失 → false（null-safe）', () => {
  const redCity = { influence: { minX: 1000, maxX: 1299, minZ: 0, maxZ: 299 } };
  const fp = landmarkHalfExtent('pyramid');                                   // 28
  assertTrue(landmarkErased('pyramid', { cx: 1000 - fp.halfX, cz: 100 }, redCity), '恰好相接（闭区间）');
  assertFalse(landmarkErased('pyramid', { cx: 1000 - fp.halfX - 1, cz: 100 }, redCity), '差 1 格不相交');
  assertTrue(landmarkErased('pyramid', { cx: 1100, cz: 100 }, redCity), '完全在内');
  assertFalse(landmarkErased('pyramid', { cx: 1100, cz: 100 }, null), 'redCity=null（既有调用方都不传）');
  assertFalse(landmarkErased('island', null, redCity), '该 region 没有海岛');
  // 海岛真实范围 25：中心距 influence 30 格不相交（若误用 39 会被误吞）
  assertFalse(landmarkErased('island', { cx: 1000 - 30, cz: 100 }, redCity), '海岛 25 < 30 → 不吞');
  // 平原岛 z 向结构占地 20：地形 15 够不到、结构够得到 → 必须吞（否则 pyramidIsland 的碎块会留在 RedCity 里）
  assertTrue(landmarkErased('plainLand', { cx: 1100, cz: 0 - 18 }, redCity), '结构 z 占地 20 触到 influence.minZ=0');
  assertFalse(landmarkErased('plainLand', { cx: 1100, cz: 0 - 21 }, redCity));
});

test('erasedFlags：五类地标逐类给出；无 redCity 时全 false', () => {
  const layout = { pyramid: { cx: 1100, cz: 100 }, frozenMountain: { cx: -9999, cz: 0 }, snowLand: { cx: -9999, cz: 0 }, island: null, plainLand: null };
  const redCity = { influence: { minX: 1000, maxX: 1299, minZ: 0, maxZ: 299 } };
  assertDeepEqual(erasedFlags(layout, redCity), { pyramid: true, frozenMountain: false, snowLand: false, island: false, plainLand: false });
  assertDeepEqual(erasedFlags(layout, null), { pyramid: false, frozenMountain: false, snowLand: false, island: false, plainLand: false });
});

// ---- 列整形函数的直接单测（合成列，不经 GEN）：RedCity 计划 Task 4 就能钉住「填/挖/补实」三种构造，不必等 Task 6 的 GEN 接线 ----
const STONE = 1, WATER = 2, FILL = 3, SURF = 4, SUB = 5;
/** 自然列（x=3,z=4）：WORLD_MIN_Y+1..n 是 STONE，n+1..SEA_Y 是 WATER（n<SEA_Y 的水域） */
function naturalColumn(n) {
  const col = new ChunkColumn(0, 0);
  for (let y = WORLD_MIN_Y + 1; y <= n; y++) col.blocks[blockIndex(3, y, 4)] = STONE;
  for (let y = n + 1; y <= SEA_Y; y++) col.blocks[blockIndex(3, y, 4)] = WATER;
  return col;
}
const at = (col, y) => col.blocks[blockIndex(3, y, 4)];

test('shapeRedCityCore：[WORLD_MIN_Y+1, ground] 全填 fill（含原水域/洞穴位置）；(ground, max(n, SEA_Y)] 清空；再往上不动', () => {
  for (const [n, g] of [[10, 4], [4, 10], [SEA_Y - 3, -1], [SEA_Y - 3, 5], [300, 4]]) {
    const col = naturalColumn(Math.min(n, WORLD_MAX_Y - 2));
    col.blocks[blockIndex(3, 20, 4)] = col.blocks[blockIndex(3, 20, 4)] || 0;     // 不预置任何东西在 top 以上
    const nn = Math.min(n, WORLD_MAX_Y - 2);
    shapeRedCityCore(col, 3, 4, g, nn, FILL);
    const top = Math.min(WORLD_MAX_Y - 1, Math.max(nn, SEA_Y));
    for (let y = WORLD_MIN_Y + 1; y <= g; y++) assertEqual(at(col, y), FILL, `n=${nn} g=${g} y=${y} 应为 fill`);
    for (let y = g + 1; y <= top; y++) assertEqual(at(col, y), 0, `n=${nn} g=${g} y=${y} 应被清空（自然地形/水体）`);
    assertEqual(at(col, WORLD_MIN_Y), 0, '最底层(WORLD_MIN_Y)不写');
  }
});

test('shapeRedCityRing：填方(含水域转陆地) (n, s-2] 填 fill、s-1 次表层、s 表层；挖方 (s, max(n,SEA_Y)] 清空；s==n 不动；永不写出世界上下界', () => {
  const ids = { fill: FILL, sub: SUB, surf: SURF };
  // 填方：陆地 n=2 → s=6
  let col = naturalColumn(2); shapeRedCityRing(col, 3, 4, 6, 2, ids);
  for (let y = 3; y <= 4; y++) assertEqual(at(col, y), FILL, `填方 y=${y}`);
  assertEqual(at(col, 5), SUB); assertEqual(at(col, 6), SURF); assertEqual(at(col, 2), STONE, '自然表层及以下不动');
  // 水域转陆地：n=-9（湖底），s = SEA_Y+1 = -1：原水体 (-9, SEA_Y] 必须被 fill 补实而不是清成 air
  col = naturalColumn(-9); shapeRedCityRing(col, 3, 4, SEA_Y + 1, -9, ids);
  for (let y = -8; y <= SEA_Y + 1 - 2; y++) assertEqual(at(col, y), FILL, `水域补实 y=${y}（不得是 air=0 或 water=${WATER}）`);
  assertEqual(at(col, SEA_Y), SUB); assertEqual(at(col, SEA_Y + 1), SURF);
  // 挖方：n=12 → s=7
  col = naturalColumn(12); shapeRedCityRing(col, 3, 4, 7, 12, ids);
  for (let y = 8; y <= 12; y++) assertEqual(at(col, y), 0, `挖方 y=${y}`);
  assertEqual(at(col, 7), SURF); assertEqual(at(col, 6), SUB); assertEqual(at(col, 5), STONE, '次表层以下不动');
  // s == n：整列不动（保留自然表层）
  col = naturalColumn(5); const before = col.blocks.slice(); shapeRedCityRing(col, 3, 4, 5, 5, ids);
  assertTrue(col.blocks.every((v, i) => v === before[i]), 's==n 时整列逐字节不变');
  // 越界保护：把表层顶到世界顶也不写出范围
  col = naturalColumn(WORLD_MAX_Y - 4); shapeRedCityRing(col, 3, 4, WORLD_MAX_Y + 3, WORLD_MAX_Y - 4, ids);
  assertEqual(at(col, WORLD_MIN_Y), 0);
});

