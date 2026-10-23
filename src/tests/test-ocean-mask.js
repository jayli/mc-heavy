// 水面遮罩判据（Tier 1）：遮罩高度 = 真实生成高度 + 阈值对齐水体判据 + 城市门控
//
// 判据的唯一权威 = `src/render/ocean-mask.js`，ocean.js 的 TSL 着色器与之同构。
// 本文件测纯函数侧；GPU 求值侧的正确性由 water-visual spec 兜住。
//
// 实测依据（诊断脚本，10 seed × 城外 70080 采样点）：
//   近似噪声+阈值-0.8（mc-lite 原值）→ 假水面 19.3%，漏判真水 0.2%
//   真实高度+阈值 SEA_Y（本实现）    → 假水面  3.5%，漏判真水 0.0%
//   真实高度+阈值 SEA_Y-1（过严）    → 假水面  0.2%，漏判真水 13.1%
// 残留 3.5% 全是五点取样（±3.5 纵深）的有意侵入，判据偏差 = 0。
//
// ⚠️ 城市 bounds 门控的代价已随「城内残留水体缺口」一并修掉（landmarks.js generateCity）
// —— 修完后 bounds 内零暴露水体，门控零误伤。勿按「bounds 内真实水方块 = 0」的旧口径写注释。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  OCEAN_MASK_THRESHOLD, OCEAN_MASK_OFFSET,
  maskTerrainHeight, isOceanMasked, inCityBounds,
} from '../render/ocean-mask.js';
import { generateHeight, TERRAIN_HEIGHT_PARAMS } from '../gen/terrain.js';
import { buildCityLayout } from '../gen/structures/city-layout.js';
import { buildRedCityLayout } from '../gen/structures/redcity-layout.js';
import { getBiome, noise } from '../gen/noise.js';
import { SEA_Y } from '../voxel/constants.js';

/** 水体方块判据（fillColumn 的口径）：h <= SEA_Y-1 才真有水体方块 */
const WATER_BLOCK_MAX = SEA_Y - 1;

/** 从 buildCityLayout 取门控用的 bounds（着色器 uniform 同源） */
function cityBoundsOf(seed) {
  const city = buildCityLayout(seed);
  return { minX: city.minX, maxX: city.maxX, minZ: city.minZ, maxZ: city.maxZ };
}

/** 城堡位置（城市中心，用户报告的场景） */
function castleOf(seed) {
  const city = buildCityLayout(seed);
  const castle = city.placements.find((p) => p.type === 'castle');
  return castle ? { x: castle.x, z: castle.z } : { x: city.centerX, z: city.centerZ };
}

/**
 * 在给定 seed 下找一个真实海洋点（h <= WATER_BLOCK_MAX，有水体方块）。
 *
 * ⚠️ **必须排除城市 bounds** —— bounds 半宽可达 294，从城堡向外找到的第一个海洋点
 * 很可能仍在 bounds 内（被门控关掉是对的）。不排除会让断言测到门控而不是阈值，
 * 且 `findHighland` 若落在 bounds 内会因门控而**恒真通过**（testing-policy §2.7）。
 */
function findOceanPoint(seed, from) {
  const bounds = cityBoundsOf(seed);
  for (let r = 20; r <= 1200; r += 20) {
    for (let a = 0; a < 16; a++) {
      const x = from.x + Math.round(r * Math.cos((a * Math.PI) / 8));
      const z = from.z + Math.round(r * Math.sin((a * Math.PI) / 8));
      if (inCityBounds(x, z, bounds)) continue;
      if (generateHeight(x, z, seed) <= WATER_BLOCK_MAX) return { x, z };
    }
  }
  return null;
}

/** 在给定 seed 下找一个陆地高点（h >= SEA_Y + 4，远离海平面；同样排除城市 bounds） */
function findHighland(seed, from) {
  const bounds = cityBoundsOf(seed);
  for (let r = 20; r <= 1200; r += 20) {
    for (let a = 0; a < 16; a++) {
      const x = from.x + Math.round(r * Math.cos((a * Math.PI) / 8));
      const z = from.z + Math.round(r * Math.sin((a * Math.PI) / 8));
      if (inCityBounds(x, z, bounds)) continue;
      if (generateHeight(x, z, seed) >= SEA_Y + 4) return { x, z };
    }
  }
  return null;
}

// ---- 阈值取值：须与水体方块判据同源推导，不是拍脑袋 ----

test('遮罩阈值 = SEA_Y（等价于水体方块判据，非 mc-lite 的 -0.8）', () => {
  // 遮罩高度 = generateHeight（整数）→ `h < SEA_Y` ⟺ `h <= SEA_Y-1`，
  // 正是 fillColumn 的水体方块判据。取 SEA_Y 即 -2。
  // mc-lite 的 -0.8 相当于只要 近似 < -0.8 就渲水面 → 实测城外假水面 19.3%。
  assertEqual(OCEAN_MASK_THRESHOLD, SEA_Y, '阈值须等于 SEA_Y（推导见上方注释）');
  assertTrue(OCEAN_MASK_THRESHOLD < -0.8, '须比 mc-lite 原值 -0.8 更严');
});

test('遮罩取样纵深保持 mc-lite 口径（五点 ±3.5 = 水面侵入地形的纵深）', () => {
  // mc-lite Engine.js:672 的 offsetVal=3.5 —— 这是「水面侵入地形纵深」的来源，不移植就会
  // 让水面范围退化成单点判定（边界锯齿）。
  assertEqual(OCEAN_MASK_OFFSET, 3.5);
});

// ---- 城市门控：用户报告的场景 ----

test('城市城堡处不渲染水面平面（陆地不该挖出假水）', () => {
  // 用户报告的 bug：city 中心城堡附近下挖 1~2 格就看到水面。
  // 城市地表被 CITY_MIN_SURFACE_Y(= SEA_Y+1 = -1) 钳制，水面平面在 SEA_Y+0.5 = -1.5 →
  // 挖 2 格洞底顶面降到 -2 就低于水面平面。而城市其实是被压平的陆地，不是海。
  let checked = 0;
  for (const seed of [0, 1234, 7777, 9998, 4194304]) {
    const castle = castleOf(seed);
    const bounds = cityBoundsOf(seed);
    assertTrue(isOceanMasked(castle.x, castle.z, seed, bounds) === false,
      `seed=${seed} 城堡(${castle.x},${castle.z}) 不该渲染水面平面`);
    checked++;
  }
  assertEqual(checked, 5, '五个 seed 全部断言到');
});

test('城市门控覆盖整个 bounds：城内点一律不渲染（含核心区与边缘）', () => {
  // bounds 半宽可达 294，门控按矩形全域关掉水面平面。
  // 必要性 = 城市把地面压平到接近海平面（CITY_MIN_SURFACE_Y = SEA_Y+1），挖 2 格就露出
  // 水面平面；而遮罩算不出 CITY 调整（getBiome 不含 CITY）。
  // 零误伤的前提 = bounds 内确实无水体 —— 由 `generateCity` 的水体补实保证
  // （见 test-landmarks.js 的「城市内无水体残留」两条断言）。
  // ⚠️ 勿写「城内真实水方块实测为 0」—— 那只对城堡 ±16 核心区成立；bounds 全域
  // 曾有 16600 格残留水体（其中 56 格暴露），是靠生成侧补实修掉的，不是本来就没有。
  for (const seed of [1234, 7777]) {
    const city = buildCityLayout(seed);
    const bounds = cityBoundsOf(seed);
    const castle = castleOf(seed);
    let coreGated = 0, edgeGated = 0;
    // 核心区（城堡 ±40）+ 边缘区（bounds 四角内 60 格）都须被门控覆盖
    for (let dx = -40; dx <= 40; dx += 8) {
      for (let dz = -40; dz <= 40; dz += 8) {
        const x = castle.x + dx, z = castle.z + dz;
        if (x < city.minX || x > city.maxX || z < city.minZ || z > city.maxZ) continue;
        assertTrue(isOceanMasked(x, z, seed, bounds) === false,
          `seed=${seed} 城内核心(${x},${z}) 不该渲染水面平面`);
        coreGated++;
      }
    }
    for (const [bx, bz] of [[city.minX + 30, city.minZ + 30], [city.maxX - 30, city.maxZ - 30],
      [city.minX + 30, city.maxZ - 30], [city.maxX - 30, city.minZ + 30]]) {
      assertTrue(isOceanMasked(bx, bz, seed, bounds) === false,
        `seed=${seed} 城内边缘(${bx},${bz}) 不该渲染水面平面`);
      edgeGated++;
    }
    assertTrue(coreGated > 0 && edgeGated > 0,
      `seed=${seed} 核心区(${coreGated})与边缘区(${edgeGated})都须被门控覆盖`);
  }
});

// ---- 不误伤真实水体 ----

test('真实海洋点仍渲染水面平面（门控与阈值都不误伤真水）', () => {
  // 判据：generateHeight <= SEA_Y-1 的点确有水体方块，必须有水面平面覆盖。
  // 阈值取 SEA_Y-1（过严）会漏掉 13.1% 真水 —— 这条断言钉住代价上限。
  // ⚠️ 前置断言「点确实在 bounds 外」必要：若 helper 返回 bounds 内的点，
  // 城市门控会让 isOceanMasked 恒为 false → 断言方向反了会假失败，
  // 而下面那条「陆地不该渲染」则会因门控而**恒真通过**（测不到阈值）。
  let checked = 0;
  for (const seed of [0, 1234, 4567, 7777, 9998, 12345]) {
    const castle = castleOf(seed);
    const bounds = cityBoundsOf(seed);
    const ocean = findOceanPoint(seed, castle);
    assertTrue(ocean !== null, `seed=${seed} 须能找到真实海洋点`);
    assertTrue(inCityBounds(ocean.x, ocean.z, bounds) === false,
      `seed=${seed} 海洋点(${ocean.x},${ocean.z}) 须在 bounds 外（否则测的是门控不是阈值）`);
    assertTrue(isOceanMasked(ocean.x, ocean.z, seed, bounds) === true,
      `seed=${seed} 海洋点(${ocean.x},${ocean.z}) 真实高度=${generateHeight(ocean.x, ocean.z, seed)} 须渲染水面`);
    checked++;
  }
  assertEqual(checked, 6, '六个 seed 全部断言到');
});

test('陆地高点不渲染水面平面（远离海平面的地方不该有水面）', () => {
  // 实测偏差来源：DESERT/SWAMP 的 biome 调整让真实高度比基础噪声高 1.39~6.71，
  // mc-lite 的近似遮罩 + 阈值 -0.8 在这些点判「近海」→ 假水面 19.3%。
  // ⚠️ 前置断言「点确实在 bounds 外」必要 —— 否则城市门控会让断言恒真通过，
  // 测不到阈值本身（负向验证的盲区：注入「回退阈值」后仍全绿）。
  let checked = 0;
  for (const seed of [0, 1234, 4567, 7777, 9998]) {
    const castle = castleOf(seed);
    const bounds = cityBoundsOf(seed);
    const high = findHighland(seed, castle);
    assertTrue(high !== null, `seed=${seed} 须能找到陆地高点`);
    assertTrue(inCityBounds(high.x, high.z, bounds) === false,
      `seed=${seed} 陆地高点(${high.x},${high.z}) 须在 bounds 外（否则断言恒真，测不到阈值）`);
    assertTrue(isOceanMasked(high.x, high.z, seed, bounds) === false,
      `seed=${seed} 陆地高点(${high.x},${high.z}) 真实高度=${generateHeight(high.x, high.z, seed)} 不该渲染水面`);
    checked++;
  }
  assertEqual(checked, 5, '五个 seed 全部断言到');
});

// ---- 遮罩高度与水体判据同源 ----

test('遮罩高度 ≠ mc-lite 的近似噪声（DESERT/SWAMP 处必须不同）', () => {
  // 负向对照：mc-lite 用近似噪声（基础噪声，不含 biome 调整），实测与真实地形偏差
  // +1.39~+6.71。若有人把遮罩高度改回近似噪声，这条断言会 FAIL。
  // 断言「不等于近似」而非「等于 generateHeight」—— 后者在 maskTerrainHeight
  // 直接复用 generateHeight 时是恒真陷阱（自己等于自己），测不出任何回归。
  let differs = 0, checked = 0;
  for (const seed of [4567, 987654]) {
    const castle = castleOf(seed);
    for (let dx = -400; dx <= 400; dx += 10) {
      for (let dz = -400; dz <= 400; dz += 10) {
        const x = castle.x + dx, z = castle.z + dz;
        const bio = getBiome(x, z, seed);
        if (bio !== 'DESERT' && bio !== 'SWAMP') continue;
        const approx = noise(x, z, seed, TERRAIN_HEIGHT_PARAMS.COARSE_SCALE)
          + noise(x, z, seed, TERRAIN_HEIGHT_PARAMS.FINE_SCALE) * TERRAIN_HEIGHT_PARAMS.FINE_WEIGHT;
        const mask = maskTerrainHeight(x, z, seed);
        checked++;
        // 近似未取整，故比较绝对差；biome 调整幅度 >= 0.3*|h| 必然大于 1
        if (Math.abs(mask - approx) > 0.5) differs++;
      }
    }
  }
  assertTrue(checked > 0, '须有 DESERT/SWAMP 采样点（否则断言是恒真陷阱）');
  assertTrue(differs > 0, '遮罩高度须与近似噪声不同（biome 调整已生效）');
});

test('阈值判据与水体方块判据等价（h < SEA_Y ⟺ h <= SEA_Y-1）', () => {
  // generateHeight 返回整数 → `h < SEA_Y` 与 `h <= SEA_Y-1` 是同一个判据。
  // 这保证「遮罩渲水面的地方」与「fillColumn 填了水方块的地方」一致（红线 1）。
  // 负向对照：若阈值取 SEA_Y-1（更严），会漏掉 h=-3 的浅水湖（实测 13.1%）。
  let bothTrue = 0;
  for (const seed of [0, 1234, 7777]) {
    const castle = castleOf(seed);
    for (let dx = -200; dx <= 200; dx += 5) {
      for (let dz = -200; dz <= 200; dz += 5) {
        const x = castle.x + dx, z = castle.z + dz;
        const h = maskTerrainHeight(x, z, seed);
        const byThreshold = h < OCEAN_MASK_THRESHOLD;
        const byWaterBlock = h <= SEA_Y - 1;
        assertEqual(byThreshold, byWaterBlock,
          `(${x},${z}) h=${h}：阈值判据与水体判据须一致`);
        if (byThreshold) bothTrue++;
      }
    }
  }
  assertTrue(bothTrue > 0, '须有水体点（否则这条断言是恒真陷阱）');
});

test('遮罩高度的 biome 调整参数落在单一权威（着色器同构实现须读同一份）', () => {
  // TSL 侧无法调 JS 函数 → 只能同构实现，数值常量须从 TERRAIN_HEIGHT_PARAMS /
  // BIOME_PARAMS 读。各写一份字面量会漂移出「生成侧与遮罩判的不是同一套高度」。
  // 这里断言 DESERT/SWAMP 的调整确实生效（遮罩高度 ≠ 基础噪声）。
  for (const seed of [4567, 987654]) {
    const castle = castleOf(seed);
    let desertChecked = 0, swampChecked = 0;
    for (let dx = -400; dx <= 400; dx += 10) {
      for (let dz = -400; dz <= 400; dz += 10) {
        const x = castle.x + dx, z = castle.z + dz;
        const bio = getBiome(x, z, seed);
        const h = maskTerrainHeight(x, z, seed);
        // 基础噪声（不含调整）
        const base = Math.floor(noise(x, z, seed, TERRAIN_HEIGHT_PARAMS.COARSE_SCALE)
          + noise(x, z, seed, TERRAIN_HEIGHT_PARAMS.FINE_SCALE) * TERRAIN_HEIGHT_PARAMS.FINE_WEIGHT);
        if (bio === 'DESERT') {
          assertEqual(h, Math.floor(base * TERRAIN_HEIGHT_PARAMS.DESERT_FACTOR
            + TERRAIN_HEIGHT_PARAMS.DESERT_OFFSET), `(${x},${z}) DESERT 调整须生效`);
          desertChecked++;
        }
        if (bio === 'SWAMP') {
          assertEqual(h, Math.floor(base * TERRAIN_HEIGHT_PARAMS.SWAMP_FACTOR
            + TERRAIN_HEIGHT_PARAMS.SWAMP_OFFSET), `(${x},${z}) SWAMP 调整须生效`);
          swampChecked++;
        }
      }
    }
    assertTrue(desertChecked > 0, `seed=${seed} 须有 DESERT 采样点（否则断言是恒真陷阱）`);
    assertTrue(swampChecked > 0, `seed=${seed} 须有 SWAMP 采样点（否则断言是恒真陷阱）`);
  }
});

// ---- RedCity 门控（范围 = influence，含过渡环；与 City 门控同一理由、同一不等式）----

/** RedCity 的 influence 及其外 80 格带，步长 6 的采样格（覆盖内外两侧，≈ 4 千点） */
function redCitySamples(seed) {
  const city = buildCityLayout(seed);
  const rc = buildRedCityLayout(seed, city);
  const inf = rc.influence;
  const pts = [];
  for (let x = inf.minX - 80; x <= inf.maxX + 80; x += 6) {
    for (let z = inf.minZ - 80; z <= inf.maxZ + 80; z += 6) {
      pts.push({ x, z, inside: x >= inf.minX && x <= inf.maxX && z >= inf.minZ && z <= inf.maxZ });
    }
  }
  return { cityBounds: cityBoundsOf(seed), inf, pts };
}

test('RedCity 门控：influence 内一律不渲染水面（前置：关掉门控时这些点确有水面 —— 测的是门控不是阈值）', () => {
  // 〔实测〕6 个 seed，influence 内 2744 个采样点里无门控时有水面 765~1203 个（≈33~44%）：
  // core 全深度实心、ring 的水域已补实成陆地 → 区域内下挖到 y<-1.5 会挖出陆地上的假水。
  // ⚠️ 前置断言 wet > 300 必要：没有它，「全部熄灭」在一个本来就没有水面的 seed 上恒真。
  for (const seed of [12345, 1, 777]) {
    const { cityBounds, inf, pts } = redCitySamples(seed);
    let wet = 0, gated = 0;
    for (const p of pts) {
      if (!p.inside || !isOceanMasked(p.x, p.z, seed, cityBounds)) continue;
      wet++;
      if (isOceanMasked(p.x, p.z, seed, cityBounds, inf) === false) gated++;
    }
    assertTrue(wet > 300, `seed=${seed} 前置：influence 内关门控时应有大量水面点（实测 ${wet}）`);
    assertEqual(gated, wet, `seed=${seed} 开 RedCity 门控后 influence 内的水面点必须全部熄灭`);
  }
});

test('RedCity 门控只作用于 influence 内：外侧真实水域照常渲染（不误伤）', () => {
  // 〔实测〕influence 外 80 格带里有水面的点 499~1697 个，开门控后一个都不少。
  for (const seed of [12345, 1, 777]) {
    const { cityBounds, inf, pts } = redCitySamples(seed);
    let wetOut = 0, kept = 0;
    for (const p of pts) {
      if (p.inside || !isOceanMasked(p.x, p.z, seed, cityBounds)) continue;
      wetOut++;
      if (isOceanMasked(p.x, p.z, seed, cityBounds, inf) === true) kept++;
    }
    assertTrue(wetOut > 300, `seed=${seed} 前置：influence 外应有水面点（实测 ${wetOut}）`);
    assertEqual(kept, wetOut, `seed=${seed} influence 外的水面点开门控后必须一个不少`);
  }
});

test('RedCity 门控：第 5 参缺省 = 关闭（既有调用方行为不变）', () => {
  const seed = 12345;
  const { cityBounds, inf, pts } = redCitySamples(seed);
  let diff = 0;
  for (const p of pts) {
    if (isOceanMasked(p.x, p.z, seed, cityBounds) !== isOceanMasked(p.x, p.z, seed, cityBounds, undefined)) diff++;
  }
  assertEqual(diff, 0, '不传第 5 参与显式 undefined 结果一致');
  // 门控边界闭区间：influence 四角本身也被门控（与 inCityBounds 同一不等式）
  assertTrue(isOceanMasked(inf.minX, inf.minZ, seed, cityBounds, inf) === false, '左上角点在 influence 内');
  assertTrue(isOceanMasked(inf.maxX, inf.maxZ, seed, cityBounds, inf) === false, '右下角点在 influence 内');
});

