// src/tests/test-rain-shelter.js — 雨的遮挡与高度规则（Tier 1，用户 2026-11-22 裁定）
//
// 三条规则：① 屋顶（含玻璃）拦雨；② 树叶/云/空岛不拦；③ 雨幕上界不高于云层。
// 判据全部走 registry 的表 + 真实方块声明，**不写名字白名单**（红线 1）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { CLOUD_CLUSTER_Y, SINGLE_CLOUD_Y } from '../gen/structures/sky-structures.js';
import { WORLD_MIN_Y, SEA_Y } from '../voxel/constants.js';
import {
  RAIN_CEILING_Y, blocksRain, rainShelterY, rainStopY, isUnderRoof, rainBoxCenterY,
} from '../render/rain-shelter.js';
import { WATER_SURFACE_Y } from '../render/water-surface.js';

// ⚠️ buildDefaultRegistry 是 async（延迟 import 破循环依赖）⇒ 单测里同步建表。
const REG = createRegistry();
for (const def of BLOCKS) REG.register(def.name, def);
REG.freeze();
const id = (n) => REG.idOf(n);

/** 假 world：按 Map<'x,y,z', blockId> 回答，其余 air */
function fakeWorld(cells) {
  return {
    getBlockId(x, y, z) {
      if (y < WORLD_MIN_Y) return id('bedrock');   // 与 WorldData 同口径（防穿底）
      return cells.get(`${x},${y},${z}`) ?? 0;
    },
  };
}
function put(cells, x, y, z, name) { cells.set(`${x},${y},${z}`, id(name)); }

// ---------- 规则③：高度上界 ----------

test('rain shelter: 上界派生自最低云层，且严格低于云簇与单云层', () => {
  assertEqual(RAIN_CEILING_Y, CLOUD_CLUSTER_Y - 1);
  assertTrue(RAIN_CEILING_Y < CLOUD_CLUSTER_Y, '雨幕上界必须低于云簇');
  assertTrue(RAIN_CEILING_Y < SINGLE_CLOUD_Y, '雨幕上界必须低于单云层');
});

test('rain shelter: 雨幕盒心被钳到上界之下（玩家飞很高时雨不跟着上去）', () => {
  const H = 18;
  // 玩家在地面：盒心跟着玩家
  assertEqual(rainBoxCenterY(10, H), 10);
  // 玩家飞到云上：盒心钳住，盒顶恰好不超过上界
  const cy = rainBoxCenterY(80, H);
  assertTrue(cy + H / 2 <= RAIN_CEILING_Y, `盒顶 ${cy + H / 2} 超过上界 ${RAIN_CEILING_Y}`);
  // 玩家在云簇高度：同样钳住
  const cy2 = rainBoxCenterY(CLOUD_CLUSTER_Y, H);
  assertTrue(cy2 + H / 2 <= RAIN_CEILING_Y);
});

// ---------- 规则①②：哪些方块挡雨 ----------

test('rain shelter: 屋顶类方块全部挡雨（石/木/砖/台阶/玻璃）', () => {
  for (const n of ['stone', 'cobblestone', 'wood', 'stone_bricks', 'smooth_stone',
    'glass_block', 'glass_blink', 'end_stone_bricks', 'purpur_block', 'iron']) {
    assertTrue(blocksRain(id(n), REG), `${n} 应当挡雨（它是屋顶材料）`);
  }
});

test('rain shelter: 全部树叶族不挡雨（cutout 通道）', () => {
  const leaves = BLOCKS.filter((b) => b.cullMode === 'cutout' && /leaves|flowers/.test(b.name));
  assertTrue(leaves.length >= 8, `树叶族应至少 8 个，实际 ${leaves.length}`);
  for (const b of leaves) {
    assertFalse(blocksRain(id(b.name), REG), `${b.name} 是树叶/花，不该挡雨`);
  }
});

test('rain shelter: 云不挡雨（尽管 solid=true）', () => {
  assertEqual(REG.solidTable[id('cloud')], 1, '云确实是实心（v1.96 起不可穿越）');
  assertFalse(blocksRain(id('cloud'), REG), '云必须被显式排除 —— 用户要求云不拦雨');
});

test('rain shelter: 花草/水/空气不挡雨', () => {
  for (const n of ['air', 'water', 'swamp_water', 'flower', 'short_grass', 'vine', 'bush_grass']) {
    assertFalse(blocksRain(id(n), REG), `${n} 不该挡雨`);
  }
});

test('rain shelter: 判据是「实心且非 cutout 且非云」，不是名字白名单', () => {
  // 逐个方块核对：判据结果必须与三条声明完全一致
  for (const b of BLOCKS) {
    const bid = id(b.name);
    const expect = REG.solidTable[bid] === 1
      && REG.cullTable[bid] !== 1
      && b.name !== 'cloud';
    assertEqual(blocksRain(bid, REG), expect, `${b.name} 的挡雨判定与声明不一致`);
  }
});

// ---------- 屋顶扫描 ----------

test('rain shelter: 石屋顶下的雨停在其顶面', () => {
  const cells = new Map();
  put(cells, 4, 12, 4, 'stone_bricks');    // 屋顶在 y=12
  put(cells, 4, 0, 4, 'stone');            // 地面在 y=0
  const w = fakeWorld(cells);
  // 从 y=20 往下扫 ⇒ 停在屋顶顶面 13
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 20), 13);
});

test('rain shelter: 树叶不拦 —— 雨穿过树冠落到地面', () => {
  const cells = new Map();
  for (let y = 8; y <= 12; y++) put(cells, 4, y, 4, 'leaves');   // 五层树冠
  put(cells, 4, 0, 4, 'grass');
  const w = fakeWorld(cells);
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 20), 1, '应穿过树冠停在草地顶面');
});

test('rain shelter: 云不拦 —— 扫描上界本就在云之下', () => {
  const cells = new Map();
  put(cells, 4, CLOUD_CLUSTER_Y, 4, 'cloud');
  put(cells, 4, SINGLE_CLOUD_Y, 4, 'cloud');
  put(cells, 4, 0, 4, 'stone');
  const w = fakeWorld(cells);
  // 即使 fromY 给到 90（云上），扫描也从上界 34 起 ⇒ 云不参与
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 90), 1);
});

test('rain shelter: 空岛（云上石头）不拦雨', () => {
  const cells = new Map();
  // 空岛底 Y ∈ [40,70]，都在雨幕上界之上
  for (let y = 45; y <= 50; y++) put(cells, 4, y, 4, 'stone');
  put(cells, 4, 0, 4, 'sand');
  const w = fakeWorld(cells);
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 90), 1, '空岛在上界之上，不该拦雨');
});

test('rain shelter: 玻璃屋顶也拦雨（室内不该下雨）', () => {
  const cells = new Map();
  put(cells, 4, 10, 4, 'glass_block');
  put(cells, 4, 0, 4, 'stone');
  const w = fakeWorld(cells);
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 20), 11);
});

test('rain shelter: 未加载列（全 air）不得回落到世界底', () => {
  const w = fakeWorld(new Map());
  // 全 air ⇒ 扫不到挡雨面 ⇒ null（调用方回落默认循环底，而不是 −32）
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 20), null);
});

test('rain shelter: x/z 取整（小数坐标不得读成 air）', () => {
  const cells = new Map();
  put(cells, 4, 12, 4, 'stone');
  const w = fakeWorld(cells);
  assertEqual(rainShelterY(w, REG, 4.9, 4.1, 20), 13);
  assertEqual(rainShelterY(w, REG, 4.0, 4.0, 20), 13);
});

// ---------- 室内判据 ----------

test('rain shelter: 头顶有屋顶 ⇒ 室内（雨特效不生效）', () => {
  const cells = new Map();
  put(cells, 4, 8, 4, 'stone_bricks');
  const w = fakeWorld(cells);
  assertTrue(isUnderRoof(w, REG, 4.5, 2, 4.5), '头顶 6 格处有屋顶 ⇒ 室内');
});

test('rain shelter: 露天 ⇒ 非室内', () => {
  const cells = new Map();
  put(cells, 4, 0, 4, 'grass');
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, 1, 4.5), '头顶无盖 ⇒ 露天');
});

test('rain shelter: 树冠下不算室内（树叶不挡雨）', () => {
  const cells = new Map();
  for (let y = 5; y <= 9; y++) put(cells, 4, y, 4, 'giant_oak_leaves');
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, 1, 4.5), '站在树下仍应下雨');
});

test('rain shelter: 云下不算室内', () => {
  const cells = new Map();
  put(cells, 4, CLOUD_CLUSTER_Y, 4, 'cloud');
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, 1, 4.5), '站在云下仍应下雨');
});

test('rain shelter: 只有顶棚没有墙也算室内（凉亭）', () => {
  const cells = new Map();
  put(cells, 4, 6, 4, 'wood');    // 只有一格顶棚，四周全空
  const w = fakeWorld(cells);
  assertTrue(isUnderRoof(w, REG, 4.5, 1, 4.5), '判据是头顶有盖，不是四周有墙');
});

test('rain shelter: 四面墙但无顶（天井）不算室内', () => {
  const cells = new Map();
  for (let y = 1; y <= 6; y++) {
    put(cells, 3, y, 4, 'stone'); put(cells, 5, y, 4, 'stone');
    put(cells, 4, y, 3, 'stone'); put(cells, 4, y, 5, 'stone');
  }
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, 1, 4.5), '天井应当下雨');
});

test('rain shelter: 室内判据的扫描上界也钳在云层之下', () => {
  const cells = new Map();
  // 唯一的「盖」是云 ⇒ 不算室内
  put(cells, 4, CLOUD_CLUSTER_Y, 4, 'cloud');
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, 30, 4.5, 64));
});

// ---------- 截停面 = max(挡雨面, 水面)（v3.30g 水下排除）----------

test('rain stop: 湖底被水淹住 ⇒ 雨停在水面而不是湖底', () => {
  const cells = new Map();
  // 湖底 sand 在 y=-8，水从 -7 填到 SEA_Y
  put(cells, 4, -8, 4, 'sand');
  for (let y = -7; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  const w = fakeWorld(cells);
  // 旧口径（只挡雨面）会穿过水落到湖底顶面 -7
  assertEqual(rainShelterY(w, REG, 4.5, 4.5, 20), -7, '挡雨面仍是湖底（语义不变）');
  // 新口径取水面
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), WATER_SURFACE_Y,
    '截停面必须是水面（否则雨丝全程在水下）');
  assertTrue(WATER_SURFACE_Y > -7, '水面确实高于湖底（判据有判别力）');
});

test('rain stop: 陆地无水面 ⇒ 与挡雨面逐位相同（零回归）', () => {
  const cells = new Map();
  put(cells, 4, 10, 4, 'grass');
  const w = fakeWorld(cells);
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), rainShelterY(w, REG, 4.5, 4.5, 20));
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), 11);
});

test('rain stop: 屋顶高于水面 ⇒ 取屋顶（屋内积水不把雨提到水面）', () => {
  const cells = new Map();
  put(cells, 4, -8, 4, 'sand');
  for (let y = -7; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  put(cells, 4, 12, 4, 'stone_bricks');   // 屋顶远高于水面
  const w = fakeWorld(cells);
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), 13, '取更高者 = 屋顶');
});

test('rain stop: 两者都扫不到 ⇒ null（不回落）', () => {
  const w = fakeWorld(new Map());
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), null);
});

test('rain stop: 只有水面（无实心地面）⇒ 取水面', () => {
  const cells = new Map();
  for (let y = -7; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  const w = fakeWorld(cells);
  assertEqual(rainStopY(w, REG, 4.5, 4.5, 20), WATER_SURFACE_Y);
});

test('rain stop: 水不算屋顶 —— 站在浅水里不被当成室内（用户：只剔个体不整池停）', () => {
  const cells = new Map();
  put(cells, 4, -8, 4, 'sand');
  for (let y = -7; y <= SEA_Y; y++) put(cells, 4, y, 4, 'water');
  const w = fakeWorld(cells);
  assertFalse(isUnderRoof(w, REG, 4.5, -6, 4.5),
    '头顶全是水 ⇒ 不是室内（把水写进 blocksRain 会让整片雨停掉）');
});