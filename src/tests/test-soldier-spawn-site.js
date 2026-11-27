// src/tests/test-soldier-spawn-site.js — C 键落点选取（Tier 1，TDD）
//
// 用户 2026-11-27 实玩报告：「我在地上的时候，按 c，有时候会把 soldier 生成到地下矿洞里，
// 我希望生成 soldier 的时候，尽量生成在跟玩家一个水平线上的空间内，即便有高度差，
// 也要在一个联通的空间内，高度差不要太大，不要生成在高度差很多的地下矿洞，云层等地方。」
//
// ## 根因（实测，不是推断）
//
// 旧 `spawnSoldierNearPlayer` 逐行照 X 键丧尸：随机角度 2~10 格 + **从玩家高度向下扫 64 格**，
// 第一个「本格 air + 上格 air + 下格 solid」即采用。那条判据**只问这一格能不能站**，
// 不问它与玩家是否连通、差多少高度 ⇒ 洞穴顶板天然满足它。
// 实测（真实 seed 12345 + fillColumn + carveCaves，8 点 × 200 次）：最深 **−39 格**，
// 洞口密集点 11/200 落到 dy ≤ −8；浏览器真实按键 20 次里出现 −32 / −28 / −26。
//
// ## ☠️ 本文件最重要的一条实测教训（决定判据形状）
//
// **「在 ±N 格窗口里找可站面」不够** —— 实测在 4545 个洞内可站列上，朴素窗口会
// **穿过实心天花板**上浮 **5024 次**。所以「连通」必须显式验**空气通路**
// （从当前格高度到目标格高度的整段身体走廊无实心），不能只靠高度差上限。
// 本文件 §连通性 那组用例就是钉这一条的，注入掉空气通路判据后它们必须真 FAIL。
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertFalse, assertNull, assertNotEqual,
} from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { fillColumn, generateHeight } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { SOLDIER, SOLDIER_SPAWN } from '../entities/soldiers/soldier-config.js';
import { findSoldierSpawnSite } from '../entities/soldiers/soldier-spawn-site.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/**
 * 真实地形世界：x,z ∈ [-64, 80)。
 * ⚠️ **必须 `fillColumn` + `carveCaves` 两步**：只 fillColumn 的世界没有洞穴
 * ⇒ 缺陷根本不出现，所有断言恒真（本仓「夹具两侧共用同一个错误假设」那类坑）。
 */
function makeTerrainWorld(reg, radius = 4) {
  const world = new WorldData(reg);
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      const col = new ChunkColumn(cx, cz);
      fillColumn(col, SEED, reg);
      carveCaves(col, SEED);
      col.state = 'ready';
      world.add(col);
    }
  }
  return world;
}

/** 该列地表之上的脚底 y（结构可能覆盖，故从 h+8 往下找第一个可站面） */
function surfaceFootY(world, x, z) {
  const h = generateHeight(x, z, SEED);
  for (let y = h + 8; y >= h - 2; y--) {
    if (!world.isSolid(x, y, z) && !world.isSolid(x, y + 1, z) && world.isSolid(x, y - 1, z)) return y;
  }
  return null;
}

/**
 * **现行（缺陷）算法**的独立复刻 —— 只作对照，证明夹具有判别力。
 * ⚠️ 刻意不复用被测代码：两侧共用同一实现的话「两者一致」是假结论。
 */
function legacyPick(world, px, py, pz, rnd) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = rnd() * Math.PI * 2;
    const distance = rnd() * 8 + 2;
    const x = Math.floor(px + Math.cos(angle) * distance);
    const z = Math.floor(pz + Math.sin(angle) * distance);
    for (let y = Math.floor(py); y >= Math.floor(py) - 64; y--) {
      if (world.getBlockId(x, y, z) === 0
        && world.getBlockId(x, y + 1, z) === 0
        && world.isSolid(x, y - 1, z)) return y;
    }
  }
  return null;
}

/** 确定性 rng（不用 Math.random，让用例可复现） */
function lcg(seed = 12345) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** 本次实测的 8 个采样点（自然地形，含 4 个洞口密集点） */
const SPOTS = [[8, 8], [24, 30], [-20, 12], [40, -30], [-40, -40], [55, 55], [-55, 20], [12, -55]];

/** 该格头顶到世界顶是否全程无实心（「见天」；云也算遮挡，只用于分类） */
function openSky(world, x, y, z) {
  for (let yy = y + 1; yy < 96; yy++) if (world.isSolid(x, yy, z)) return false;
  return true;
}

// ---------------------------------------------------------------- 常量契约

test('落点常量: 高度带 ±3（用户裁定）/ 放宽档 ±8 / 每步抬升派生自 SOLDIER.maxStep', () => {
  assertEqual(SOLDIER_SPAWN.maxDy, 3, '常态高度差上限（用户 2026-11-27 裁定 ±3）');
  assertEqual(SOLDIER_SPAWN.relaxedDy, 8, '放宽档（用户裁定「放宽高度差再试一次」）');
  assertTrue(SOLDIER_SPAWN.relaxedDy > SOLDIER_SPAWN.maxDy, '放宽档必须真的更宽');
  assertEqual(SOLDIER_SPAWN.stepPerCell, SOLDIER.maxStep,
    '每步抬升必须派生自士兵台阶能力，不写第二份字面量（红线 1）');
  assertEqual(SOLDIER_SPAWN.minDist, 2, '取距下界与既有口径逐位相同');
  assertEqual(SOLDIER_SPAWN.maxDist, 10, '取距上界与既有口径逐位相同');
  assertTrue(SOLDIER_SPAWN.radius > SOLDIER_SPAWN.maxDist, '洪泛半径须覆盖取距上界');
});

// ---------------------------------------------------------------- 核心回归

test('真实地形 8 点 × 200 次: 落点高度差恒在 ±3 内（核心回归）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const bad = [];
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    assertNotEqual(sy, null, `采样点 ${x},${z} 必须有地表可站面`);
    for (let i = 0; i < 200; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      assertNotEqual(r, null, `采样点 ${x},${z} 第 ${i} 次必须选出落点`);
      const dy = r.position[1] - sy;
      if (Math.abs(dy) > SOLDIER_SPAWN.maxDy) bad.push({ at: [x, z], dy });
    }
  }
  assertEqual(bad.length, 0, `不得出现 |dy| > ${SOLDIER_SPAWN.maxDy} 的落点：${JSON.stringify(bad.slice(0, 5))}`);
});

test('判别力对照: 同一夹具跑旧算法必须真的落到深洞（否则上一条恒真）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  let deep = 0;
  let minDy = 0;
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 200; i++) {
      const y = legacyPick(world, x + 0.5, sy, z + 0.5, rnd);
      if (y === null) continue;
      const dy = y - sy;
      if (dy <= -8) deep++;
      if (dy < minDy) minDy = dy;
    }
  }
  // 实测：deep = 38/1600，minDy = −39。这里只钉「缺陷真的存在」，不冻结具体计数。
  assertTrue(deep > 0, `旧算法必须真的落到 dy ≤ −8（实测 ${deep} 次，最深 ${minDy}）`);
  assertTrue(minDy <= -8, `旧算法最深落差必须 ≤ −8（实测 ${minDy}）`);
});

test('落点必须真的可站: 脚格 air + 头格 air + 脚下 solid（与 service.spawn 门同源）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 40; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      const [bx, by, bz] = [Math.floor(r.position[0]), r.position[1], Math.floor(r.position[2])];
      assertEqual(world.getBlockId(bx, by, bz), 0, '脚格必须 air');
      assertEqual(world.getBlockId(bx, by + 1, bz), 0, '头格必须 air');
      assertTrue(world.isSolid(bx, by - 1, bz), '脚下必须实心');
    }
  }
});

test('落点水平距恒在 2~10 格内（与既有取距口径逐位相同）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 40; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      const d = Math.hypot(r.position[0] - (x + 0.5), r.position[2] - (z + 0.5));
      assertTrue(d >= SOLDIER_SPAWN.minDist - 1e-9 && d <= SOLDIER_SPAWN.maxDist + 1e-9,
        `水平距 ${d.toFixed(2)} 须在 [2,10]`);
    }
  }
});

// ---------------------------------------------------------------- 连通性

test('地表玩家的落点不得在洞内（头顶必须有天）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const buried = [];
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 60; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      const bx = Math.floor(r.position[0]), bz = Math.floor(r.position[2]);
      if (!openSky(world, bx, r.position[1], bz)) buried.push([bx, r.position[1], bz]);
    }
  }
  assertEqual(buried.length, 0, `地表玩家的落点必须见天：${JSON.stringify(buried.slice(0, 5))}`);
});

test('☠️ 玩家坐标不带 .5（整数）时，取距仍须从真实位置算', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  /**
   * ☠️☠️ **本轮 E2E 抓到的真缺陷，Node 夹具结构上抓不到**：
   * 洪泛本来从**种子格心**（`sx+0.5`）算距离，而玩家 `physics.pos`
   * **不一定带 .5**（传送/解卡后常见整数坐标，实测 903.0）。
   * 半格系统偏差 ⇒ 选出真实距 **1.58 格** 的落点（声称 ≥2），形态是「士兵贴脸生成」。
   * 上面所有用例都传 `x + 0.5` ⇒ 两侧基准重合，永远测不出。
   */
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (const [ox, oz] of [[0, 0], [0.5, 0.5], [0.25, 0.75], [0.9, 0.1]]) {
      const px = x + ox, pz = z + oz;
      const rnd = lcg(11);
      for (let i = 0; i < 40; i++) {
        const r = findSoldierSpawnSite(world, [px, sy, pz], { rng: rnd });
        assertNotEqual(r, null, `玩家 ${px},${pz} 须能选出落点`);
        const d = Math.hypot(r.position[0] - px, r.position[2] - pz);
        assertTrue(d >= SOLDIER_SPAWN.minDist - 1e-9 && d <= SOLDIER_SPAWN.maxDist + 1e-9,
          `玩家 ${px},${pz} 的落点真实水平距 ${d.toFixed(3)} 须在 [2,10]`);
      }
    }
  }
});

test('☠️ 落点必须是真正的 air：水/花/草等非实心非空气方块不得入选', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  /**
   * ☠️☠️ **本轮浏览器实测抓到的真缺陷**：洪泛只用 `isSolid` 判可站，
   * 而 `SoldierService.spawn` 的门是 `getBlockId === 0`（**严格 air**）。
   * 水 / 花 / 草 / 藤蔓 / 睡莲 / 吊灯 / 矿车 等 **15 种方块非实心但非 air**
   * ⇒ 洪泛选中它们、service 静默拒收。
   * 实测形态：玩家站在水里（y=−2 = SEA_Y）时 **24 次真实 C 键只成功 6 次**，
   * 而落点算法自认为全部成功（stage=1 / dy 合法）。
   */
  const nonSolidNonAir = BLOCKS
    .map((d) => ({ name: d.name, id: reg.idOf(d.name) }))
    .filter((d) => d.id > 0 && reg.solidTable[d.id] !== 1);
  assertTrue(nonSolidNonAir.length >= 10, `前置：仓内须有多种非实心非空气方块（实测 ${nonSolidNonAir.length}）`);
  const badIds = new Set(nonSolidNonAir.map((d) => d.id));

  // ① 真实地形（含水体与植被）上大量取样，脚格/头格都不得是非 air
  const bad = [];
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 60; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      if (r === null) continue;
      const bx = Math.floor(r.position[0]), bz = Math.floor(r.position[2]);
      const foot = world.getBlockId(bx, r.position[1], bz);
      const head = world.getBlockId(bx, r.position[1] + 1, bz);
      if (foot !== 0 || head !== 0) bad.push({ at: [bx, r.position[1], bz], foot, head });
    }
  }
  assertEqual(bad.length, 0, `脚格/头格必须是 air：${JSON.stringify(bad.slice(0, 3))}`);

  // ② 直接造一个「水面上的可站面」：玩家站水底，水层上方无任何空气脚位
  //    ⇒ 不得把水格当落点（旧实现会）
  const waterWorld = new WorldData(reg);
  for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) waterWorld.add(new ChunkColumn(cx, cz));
  const stone = reg.idOf('stone');
  const water = reg.idOf('water');
  for (let x = 0; x < 48; x++) {
    for (let z = 0; z < 48; z++) {
      waterWorld.setBlock(x, 0, z, stone);           // 水底
      for (let y = 1; y <= 3; y++) waterWorld.setBlock(x, y, z, water);
      for (let y = 4; y <= 10; y++) waterWorld.setBlock(x, y, z, 0);
    }
  }
  // 玩家站水底（脚格 y=1 是水）—— 四周没任何「air 脚位 + 实心支撑」的格
  const r2 = findSoldierSpawnSite(waterWorld, [10.5, 1, 24.5], { rng: lcg(3) });
  if (r2 !== null) {
    const bx = Math.floor(r2.position[0]), bz = Math.floor(r2.position[2]);
    assertFalse(badIds.has(waterWorld.getBlockId(bx, r2.position[1], bz)),
      '不得把水格当脚位');
  }
});

test('☠️ 落点必须允许高于玩家（空气通路区间不得把支撑块算进走廊）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  let up = 0;
  let total = 0;
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    for (let i = 0; i < 200; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      if (r === null) continue;
      total++;
      if (r.position[1] > sy) up++;
    }
  }
  /**
   * ☠️☠️ **本轮负向验证抓到的真缺陷**：空气通路区间写成 `[min, max+1]` 时
   * 把**目标格的支撑块**（它就是实心的）算进了走廊 ⇒ **任何向上的台阶都被判堵死**。
   * 实测：高于玩家 = **0 / 1600**，而 |dy|≤3 / 可站 / 见天 / 取距 全部全绿。
   * 修后实测 241/1600。这条就是钉它的 —— 没它那个缺陷会静默逃逸。
   */
  assertTrue(total > 1000, `前置：须采到足量落点（实测 ${total}）`);
  assertTrue(up > 0, `必须真的出现高于玩家的落点（实测 ${up}/${total}）`);
});

test('☠️ 厚盖沟渠：高度带内的可站面隔着岩石 ⇒ 不得入选（空气通路判据）', () => {
  const reg = makeRegistry();
  const world = new WorldData(reg);
  const stone = reg.idOf('stone');
  for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) world.add(new ChunkColumn(cx, cz));
  for (let x = 0; x < 48; x++) {
    for (let z = 0; z < 48; z++) for (let y = -4; y <= 12; y++) world.setBlock(x, y, z, 0);
  }
  // 玩家高台：x ≤ 15 实心到 y=2 ⇒ 脚位 y=3
  for (let x = 0; x <= 15; x++) {
    for (let z = 0; z < 48; z++) for (let y = -1; y <= 2; y++) world.setBlock(x, y, z, stone);
  }
  /**
   * 厚盖沟渠：地板 block y=0（脚位 1，**dy=−2 在带内**），空 y=1,2，**厚盖 y=3..6**。
   *
   * ☠️☠️ **这是空气通路判据唯一真有判别力的形态**（本轮实测找出来的）：
   * 沟渠脚位与玩家只差 2 格（带内）、AABB 也可站、每步抬升也够 ⇒ **高度带与台阶能力
   * 都拦不住它**，但从玩家脚位 3 降到 1 必须穿过 y=3 那层实心岩石。
   * 实测：空气通路判据 **开 = 0 / 关 = 110**（110 次穿岩生成）。
   *
   * ⚠️ 先前试过的三种夹具（封闭口袋 / 围墙高台 / 1 格厚盖沟渠）**全部零判别力** ——
   * 它们的阻挡靠的是 AABB 碰撞或高度带，注入掉空气通路判据后仍然全绿。
   */
  for (let x = 16; x < 40; x++) {
    for (let z = 0; z < 48; z++) {
      world.setBlock(x, 0, z, stone);
      for (let y = 3; y <= 6; y++) world.setBlock(x, y, z, stone);
    }
  }
  const rnd = lcg(7);
  let through = 0;
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const r = findSoldierSpawnSite(world, [14.5, 3, 24.5], { rng: rnd });
    if (r === null) continue;
    total++;
    if (r.position[0] >= 17.5 && r.position[1] === 1) through++;
  }
  assertTrue(total > 100, `前置：高台侧须有足量合法落点（实测 ${total}）`);
  assertEqual(through, 0, `不得穿岩生成到厚盖沟渠里（实测 ${through} 次）`);
});

test('☠️ 洞内玩家的落点不得穿天花板上浮到地表（空气通路判据的判别力）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  // 找洞内可站格（头顶到地表之间有实心 = 有盖）
  const caveSpots = [];
  for (let x = -50; x < 60 && caveSpots.length < 12; x += 3) {
    for (let z = -50; z < 60 && caveSpots.length < 12; z += 3) {
      const h = generateHeight(x, z, SEED);
      for (let sy = h - 6; sy > -28; sy--) {
        if (world.isSolid(x, sy, z) || world.isSolid(x, sy + 1, z) || !world.isSolid(x, sy - 1, z)) continue;
        let roof = false;
        for (let yy = sy + 2; yy <= h; yy++) if (world.isSolid(x, yy, z)) { roof = true; break; }
        if (roof) { caveSpots.push([x, sy, z]); break; }
      }
    }
  }
  assertTrue(caveSpots.length >= 6, `前置：须采到洞内可站格（实测 ${caveSpots.length}）`);
  const escaped = [];
  for (const [x, sy, z] of caveSpots) {
    for (let i = 0; i < 40; i++) {
      const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
      if (r === null) continue;
      const bx = Math.floor(r.position[0]), bz = Math.floor(r.position[2]);
      if (openSky(world, bx, r.position[1], bz)) escaped.push({ from: [x, sy, z], to: [bx, r.position[1], bz] });
    }
  }
  assertEqual(escaped.length, 0,
    `洞内玩家不得把 soldier 生成到露天地表（穿岩）：${JSON.stringify(escaped.slice(0, 3))}`);
});

// ---------------------------------------------------------------- 云

test('云: 地面玩家不得生成到云上；云上玩家可以（同一水平连通空间）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const cloud = reg.idOf('cloud');
  // 人工云板 y=56（真实云层在 35/55，这里取 56 便于与地形分离）
  for (let x = 20; x <= 40; x++) for (let z = 20; z <= 40; z++) world.setBlock(x, 56, z, cloud);

  const sy = surfaceFootY(world, 8, 8);
  for (let i = 0; i < 80; i++) {
    const r = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: rnd });
    assertTrue(r.position[1] < 50, `地面玩家的落点不得在云层（实测 y=${r.position[1]}）`);
  }
  // 玩家自己站在云上 ⇒ 云面就是它所在的水平面，允许
  const r2 = findSoldierSpawnSite(world, [30.5, 57, 30.5], { rng: rnd });
  assertNotEqual(r2, null, '云上玩家须能选出落点');
  assertEqual(r2.position[1], 57, '云上玩家的落点须与它同高');
  assertEqual(world.getBlockId(Math.floor(r2.position[0]), 56, Math.floor(r2.position[2])), cloud,
    '落点脚下须是云');
});

// ---------------------------------------------------------------- 兜底阶梯

test('兜底②: 玩家悬空（飞行）时取自己那一列的支撑面，仍走连通判据', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const sy = surfaceFootY(world, 8, 8);
  for (const dy of [5, 12, 25]) {
    const r = findSoldierSpawnSite(world, [8.5, sy + dy, 8.5], { rng: rnd });
    assertNotEqual(r, null, `悬空 +${dy} 须经兜底给出落点`);
    assertTrue(r.stage >= 2, `悬空 +${dy} 必须走兜底级（实测 stage=${r.stage}）`);
    assertTrue(Math.abs(r.position[1] - sy) <= SOLDIER_SPAWN.maxDy,
      `兜底落点须贴近真实支撑面（实测 dy=${r.position[1] - sy}）`);
  }
});

test('兜底③: 放宽档只在常态档为空时启用，且仍不进封死深洞', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  // 常态档就有候选的地表点 ⇒ 必须停在 stage 1（不得无脑放宽）
  for (const [x, z] of SPOTS) {
    const sy = surfaceFootY(world, x, z);
    const r = findSoldierSpawnSite(world, [x + 0.5, sy, z + 0.5], { rng: rnd });
    assertEqual(r.stage, 1, `地表点 ${x},${z} 常态档须命中`);
  }
  // 放宽档的安全性：即便走到 stage 3，落点也不得深入地下
  const sy = surfaceFootY(world, -55, 20);
  for (let i = 0; i < 40; i++) {
    const r = findSoldierSpawnSite(world, [-54.5, sy, 20.5], { rng: rnd, maxDy: SOLDIER_SPAWN.relaxedDy });
    assertTrue(r.position[1] - sy >= -SOLDIER_SPAWN.relaxedDy, '放宽档仍受高度带约束');
    assertTrue(openSky(world, Math.floor(r.position[0]), r.position[1], Math.floor(r.position[2])),
      '放宽档不得进封死深洞');
  }
});

test('无合法落点: 独柱顶端 / 被墙围死 ⇒ 返回 null（不退回旧算法）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const stone = reg.idOf('stone');

  // ① 独柱：周围 12 格掏空
  const bx = 32, bz = 32;
  const top = generateHeight(bx, bz, SEED);
  for (let x = bx - 12; x <= bx + 12; x++) {
    for (let z = bz - 12; z <= bz + 12; z++) {
      if (x === bx && z === bz) continue;
      for (let y = top + 6; y >= -20; y--) world.setBlock(x, y, z, 0);
    }
  }
  assertNull(findSoldierSpawnSite(world, [bx + 0.5, top + 1, bz + 0.5], { rng: rnd }),
    '独柱顶端无连通落点 ⇒ 必须 null');

  // ② 围死：玩家四周砌 5 格高实心墙
  const wx = -20, wz = -20;
  const wtop = generateHeight(wx, wz, SEED);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue;
      for (let y = wtop + 1; y <= wtop + 5; y++) world.setBlock(wx + dx, y, wz + dz, stone);
    }
  }
  assertNull(findSoldierSpawnSite(world, [wx + 0.5, wtop + 1, wz + 0.5], { rng: rnd }),
    '被墙围死 ⇒ 必须 null');
});

// ---------------------------------------------------------------- 边界

test('未加载 column 不得当空气选中', () => {
  const reg = makeRegistry();
  // 只加载中心一列（16×16）⇒ 半径 11 的洪泛大部分邻列缺失
  const world = new WorldData(reg);
  const col = new ChunkColumn(0, 0);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  col.state = 'ready';
  world.add(col);
  const rnd = lcg();
  const sy = surfaceFootY(world, 8, 8);
  for (let i = 0; i < 40; i++) {
    const r = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: rnd });
    if (r === null) continue;
    const bx = Math.floor(r.position[0]), bz = Math.floor(r.position[2]);
    assertTrue(world.hasColumn(Math.floor(bx / 16), Math.floor(bz / 16)),
      `落点 ${bx},${bz} 所在 column 必须已加载`);
  }
});

test('非法输入: 世界缺失 / 坐标非有限 ⇒ null（不抛）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  assertNull(findSoldierSpawnSite(null, [8.5, 5, 8.5]), '无世界');
  assertNull(findSoldierSpawnSite(world, null), '无坐标');
  assertNull(findSoldierSpawnSite(world, [NaN, 5, 8.5]), 'NaN');
  assertNull(findSoldierSpawnSite(world, [8.5, Infinity, 8.5]), 'Infinity');
});

test('确定性: 同 rng 序列必得同落点（可复现，便于排查）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const sy = surfaceFootY(world, 8, 8);
  const a = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: lcg(999) });
  const b = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: lcg(999) });
  assertEqual(JSON.stringify(a.position), JSON.stringify(b.position), '同种子同结果');
});

test('落点真的多样（不是恒取同一格）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const rnd = lcg();
  const sy = surfaceFootY(world, 8, 8);
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const r = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: rnd });
    seen.add(`${r.position[0]},${r.position[2]}`);
  }
  assertTrue(seen.size > 10, `落点须多样（实测 ${seen.size} 个不同格）`);
});

test('返回值形状: position 是三元数组 + dy + stage（装配层消费）', () => {
  const reg = makeRegistry();
  const world = makeTerrainWorld(reg);
  const sy = surfaceFootY(world, 8, 8);
  const r = findSoldierSpawnSite(world, [8.5, sy, 8.5], { rng: lcg() });
  assertTrue(Array.isArray(r.position) && r.position.length === 3, 'position 须是三元数组');
  assertTrue(r.position.every((v) => Number.isFinite(v)), 'position 三项须有限');
  assertEqual(r.dy, r.position[1] - sy, 'dy 须等于落点与玩家脚底之差');
  assertTrue(Number.isInteger(r.stage) && r.stage >= 1, 'stage 须是 ≥1 的整数');
});