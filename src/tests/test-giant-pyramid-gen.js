// src/tests/test-giant-pyramid-gen.js — 巨型金字塔接线 Tier 1：真实 column GEN 逐格落位
//
// 钉的是「纯函数全绿但世界里什么都不长」这一类缺陷（M7 的教训：只测纯函数会漏掉接线）：
//   · STRUCTURE_FILES 漏映射 → rasterizeStructure 静默 return（0 个方块，无报错）
//   · apply 阶段 2.76 漏了 / y 差一格 → 塔体被地形覆盖（方块层面看不出是 y 错了）
//   · needTypes 漏预载 → cache 未命中 → 同样静默
//
// 断言落点一律是**真实 applyStructuresToColumn 写出的世界方块**，不是纯函数返回值。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { computeRegionLayout, neighborRegionKeys } from '../gen/structures/structure-layout.js';
import { applyStructuresToColumn } from '../gen/structures/apply.js';
import { loadStructure } from '../gen/structures/structure-json.js';
import { buildDefaultRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { blockIndex, WORLD_MIN_Y } from '../voxel/constants.js';
import { PYRAMID_HALF, PYRAMID_HEIGHT } from '../gen/structures/giant-pyramid.js';

const SEED = 12345;

/** 找一个确实有锚点的 region（**不硬编码 region 坐标** —— 密度参数一改它就会变） */
export function findRegionWithAnchor() {
  for (let rx = -3; rx <= 3; rx++) {
    for (let rz = -3; rz <= 3; rz++) {
      const l = computeRegionLayout(rx, rz, SEED);
      if (l.giantPyramid) return l;
    }
  }
  return null;
}

/** 与 Worker 真实路径一致的完整 GEN（fillColumn + caves + applyStructures，不含 edits/light） */
async function genColumn(reg, cx, cz) {
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, SEED, reg);
  carveCaves(col, SEED);
  await applyStructuresToColumn(col, SEED, reg, layoutsFor(cx, cz));
  return col;
}

/** 查询域内的邻域布局（与 StructureIndex 下发的 3×3 邻域一致） */
function layoutsFor(cx, cz) {
  const out = [];
  for (const key of neighborRegionKeys(cx, cz)) {
    const [rx, rz] = key.split(',').map(Number);
    out.push(computeRegionLayout(rx, rz, SEED));
  }
  return out;
}

test('巨型金字塔 GEN：锚点 column 内出现 sand_step 与 sand（特征方块在位）', async () => {
  const layout = findRegionWithAnchor();
  assertTrue(layout !== null, '必须找到有锚点的 region（否则本文件所有用例恒真）');
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = await genColumn(reg, cx, cz);

  const sandStepId = reg.idOf('sand_step');
  const sandId = reg.idOf('sand');
  let steps = 0, sands = 0;
  for (let i = 0; i < col.blocks.length; i++) {
    if (col.blocks[i] === sandStepId) steps++;
    else if (col.blocks[i] === sandId) sands++;
  }
  assertTrue(steps > 0, `锚点 column 必须有 sand_step（实际 ${steps}）`);
  assertTrue(sands > 500, `锚点 column 必须有大量 sand（实际 ${sands}）`);
});

test('巨型金字塔 GEN：塔身方块落在 floorY+1 .. floorY+PYRAMID_HEIGHT（y 换算正确）', async () => {
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('giantPyramid');
  assertTrue(data.blocks.length === 16207, `产物必须能加载且格数为 16207（实际 ${data.blocks.length}）`);

  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = await genColumn(reg, cx, cz);
  const sandId = reg.idOf('sand'), stepId = reg.idOf('sand_step'), slabId = reg.idOf('sand_slab');
  const inSet = (id) => id === sandId || id === stepId || id === slabId;

  // 该 column 内、金字塔占地下、y 在塔身范围内的沙系方块数
  let inRange = 0;
  const loY = a.floorY + 1, hiY = a.floorY + PYRAMID_HEIGHT;
  for (let y = loY; y <= hiY; y++) {
    const ly = y - WORLD_MIN_Y;
    if (ly < 0 || ly >= 128) continue;
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (Math.abs(wx - a.wx) > PYRAMID_HALF || Math.abs(wz - a.wz) > PYRAMID_HALF) continue;
      if (inSet(col.blocks[blockIndex(lx, y, lz)])) inRange++;
    }
  }
  assertTrue(inRange > 500, `塔身范围内的沙系方块数 > 500（实际 ${inRange}）`);
  // 塔顶上方一格必须是空气（否则说明 y 整体上移，塔被地形/别的东西覆盖）
  let topSolid = 0;
  const topY = hiY + 1;
  for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
    const wx = cx * 16 + lx, wz = cz * 16 + lz;
    if (Math.abs(wx - a.wx) > 2 || Math.abs(wz - a.wz) > 2) continue;   // 只看塔尖附近
    const id = col.blocks[blockIndex(lx, topY, lz)];
    if (id !== 0 && reg.solidTable[id] === 1) topSolid++;
  }
  assertEqual(topSolid, 0, `塔顶上方不得有实心方块（实际 ${topSolid}）—— 非 0 说明 y 换算错`);
});

test('巨型金字塔 GEN：塔身内部不得出现结构类方块（撒布结构已被剔除）', async () => {
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  const cx = Math.floor(a.wx / 16), cz = Math.floor(a.wz / 16);
  const col = await genColumn(reg, cx, cz);

  // ⚠️ 判据用**坐标 + 方块族**，不用「某个特征方块是否存在」：
  // desertPyramid 的 stone_bricks 与城市/其它结构共享名字 → 那种判据会恒真（既有踩坑）。
  // 这里只看「塔身范围内（高度也限定在塔身）出现的结构类手工材料」。
  const allowed = new Set(['sand', 'sand_step', 'sand_slab']);
  const suspicious = [];
  const loY = a.floorY + 2, hiY = a.floorY + PYRAMID_HEIGHT;
  for (let y = loY; y <= hiY; y++) {
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx, wz = cz * 16 + lz;
      if (Math.abs(wx - a.wx) > PYRAMID_HALF - 1 || Math.abs(wz - a.wz) > PYRAMID_HALF - 1) continue;
      const id = col.blocks[blockIndex(lx, y, lz)];
      if (id === 0) continue;
      const name = reg.nameOf(id);
      if (allowed.has(name)) continue;
      // 只关心「结构类手工材料」（地形/洞穴的是 stone/dirt/grass 等，不在这个模式里）
      if (/brick|plank|wool|cloth|glass|wood|log|coral|amber|floatato/i.test(name)) {
        suspicious.push(`${wx},${y},${wz}:${name}`);
      }
    }
  }
  assertEqual(suspicious.length, 0,
    `塔身内不得出现结构类方块（实测前 5 个：${suspicious.slice(0, 5).join(' | ')}）`);
});

test('巨型金字塔 GEN：塔基各列下方 6 格内有实心（洞穴挖空 ≤1%，实测 0.104%）', async () => {
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();

  // 塔基 49×49 跨多个 column，逐个生成（枚举实际需要哪些 column）
  const cols = new Set();
  for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
    for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      cols.add(`${Math.floor((a.wx + dx) / 16)},${Math.floor((a.wz + dz) / 16)}`);
    }
  }
  const built = new Map();
  for (const key of cols) {
    const [cx, cz] = key.split(',').map(Number);
    built.set(key, await genColumn(reg, cx, cz));
  }

  let checked = 0, voids = 0;
  for (let dz = -PYRAMID_HALF; dz <= PYRAMID_HALF; dz++) {
    for (let dx = -PYRAMID_HALF; dx <= PYRAMID_HALF; dx++) {
      const wx = a.wx + dx, wz = a.wz + dz;
      const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
      const col = built.get(`${cx},${cz}`);
      if (!col) continue;
      checked++;
      let solid = false;
      for (let k = 1; k <= 6; k++) {
        const id = col.blocks[blockIndex(wx - cx * 16, a.floorY + 1 - k, wz - cz * 16)];
        if (id !== 0 && reg.solidTable[id] === 1) { solid = true; break; }
      }
      if (!solid) voids++;
    }
  }
  assertTrue(checked > 2000, `应检查 ≥2000 列（实际 ${checked}）`);
  assertTrue(voids / checked <= 0.01,
    `塔基悬空列占比 ${(voids / checked * 100).toFixed(3)}% 必须 ≤ 1%（实测 0.104%，洞穴所致；实测 ${voids}/${checked}）`);
});

test('巨型金字塔 GEN：跨 column 无缝（各列只写自己那部分，拼接后与整座一致）', async () => {
  const layout = findRegionWithAnchor();
  const a = layout.giantPyramid;
  const reg = await buildDefaultRegistry();
  const data = await loadStructure('giantPyramid');

  // 需要覆盖的 column 集合
  const cols = new Set();
  for (const b of data.blocks) {
    const wx = a.wx + b.x, wz = a.wz + b.z;
    cols.add(`${Math.floor(wx / 16)},${Math.floor(wz / 16)}`);
  }
  assertTrue(cols.size >= 9, `49×49 应跨 ≥9 个 column（实际 ${cols.size}）`);

  const built = new Map();
  for (const key of cols) {
    const [cx, cz] = key.split(',').map(Number);
    built.set(key, await genColumn(reg, cx, cz));
  }

  // 逐格核对：产物里每个方块都必须在对应 column 里出现（y = floorY + b.y）
  let matched = 0, air = 0, wrongType = 0;
  for (const b of data.blocks) {
    const wx = a.wx + b.x, wz = a.wz + b.z;
    const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
    const col = built.get(`${cx},${cz}`);
    if (!col) continue;
    const got = col.blocks[blockIndex(wx - cx * 16, a.floorY + b.y, wz - cz * 16)];
    if (got === 0) air++;
    else if (got === reg.idOf(b.type)) matched++;
    else wrongType++;
  }
  // 允许极少数被后写阶段覆盖（云/空岛/植被/其它结构），但必须绝大多数命中
  assertTrue(matched >= data.blocks.length * 0.95,
    `跨 column 汇总应写出 ≥95% 的塔身方块（实际 ${matched}/${data.blocks.length}，空气 ${air}，类型错 ${wrongType}）`);
});

// ==================== 台阶朝向（用户 2026-10-25 提出：坡面方向必须对上）====================
//
// 钉的是「朝向静默丢失」这一类缺陷：产物若只写 `[x,y,z,paletteIndex]` 4 项，
// `loadStructure` 会把 `direction` 硬编码为 0 → **世界上所有 1219 个台阶全朝 orient=0**。
// 格数/尺寸/指纹全部对得上，只有画面错（四个坡面的台阶凹口全朝东）。

test('巨型金字塔产物：stride=5 且 step 的 direction 四向分布（朝向没有丢失）', async () => {
  const data = await loadStructure('giantPyramid');
  assertTrue(data.blocks.length === 16207, `格数应为 16207（实际 ${data.blocks.length}）`);

  const steps = data.blocks.filter((b) => b.type === 'sand_step');
  assertEqual(steps.length, 1219, 'sand_step 格数');
  const hist = [0, 0, 0, 0];
  for (const s of steps) {
    assertTrue(s.direction >= 0 && s.direction <= 3, `direction 必须 0-3（实际 ${s.direction}）`);
    hist[s.direction]++;
  }
  // 四向都要有：单一朝向 = 映射退化（塔的四面台阶会全朝同一方向）
  for (let o = 0; o < 4; o++) {
    assertTrue(hist[o] > 200, `orient=${o} 的台阶数应 > 200（实际 ${hist[o]}；实测 305/303/305/306）`);
  }
  // 非台阶方块不应带方向（保持 0，防有人给整格沙也写随机方向）
  const sands = data.blocks.filter((b) => b.type === 'sand');
  assertTrue(sands.every((b) => b.direction === 0), 'sand（整格）的 direction 应恒 0');
});

test('巨型金字塔朝向语义：facing = 高侧，凹口 = 反 facing（用户要求的「凹口朝坡外」）', async () => {
  // 实测链条（三步都验过，见 tools/bake-giant-pyramid.mjs --census-orient 与验收报告）：
  //   ① 真实 mesher：orient 0/1/2/3 → **凹口**朝 东/北/西/南
  //      （orient=0 上半部在 x[0,0.5] → 空缺在东；orient=1 上半部 z[0.5,1] → 空缺在北；
  //        orient=2 上半部 x[0.5,1] → 空缺在西；orient=3 上半部 z[0,0.5] → 空缺在南）
  //   ② 素材：`facing` 方向 = **高侧**（凹口在反方向）
  //      证据：北坡区（z<20）台阶 facing 分布 = {south:287, east:95, west:92} —— 北坡台阶
  //      若 facing 是凹口方向，它们该是 north；实测是 south（指向塔内）。而北坡凹口朝北（塔外）。
  //   ③ 故 facing=X → 凹口=反X → orient = NOTCH_TO_ORIENT[反X]
  //
  // ⚠️ 这里用**本地常量**，不 import tools/giant-pyramid-fingerprint.mjs ——
  // 那个模块在 tools/（不在 web 静态根的可 import 路径下）且依赖 node:fs。
  // 与烘焙脚本的一致性由另一条链路保证：check:data 的 [巨型金字塔] 环节验产物
  // 的 stride 与四向分布，而产物正是烘焙脚本用那张表生成的；端到端的
  // 「凹口真朝坡外」由 tests/giant-pyramid.spec.mjs 的真游戏页用例钉住。
  const NOTCH_TO_ORIENT = { east: 0, north: 1, west: 2, south: 3 };
  const OPP = { east: 'west', west: 'east', south: 'north', north: 'south' };
  const EXPECT = { west: 0, south: 1, east: 2, north: 3 };

  // 自证这张期望表是从 NOTCH_TO_ORIENT + OPP 推出来的（不是抄产物）
  for (const [facing, orient] of Object.entries(EXPECT)) {
    assertEqual(orient, NOTCH_TO_ORIENT[OPP[facing]],
      `facing=${facing} 应映射到 orient=${NOTCH_TO_ORIENT[OPP[facing]]}（凹口朝 ${OPP[facing]}）`);
  }
  // 临界对照：不得是恒等映射（恒等会让凹口朝 facing = 朝塔内，全反）
  assertTrue(EXPECT.east !== NOTCH_TO_ORIENT.east,
    'facing→orient 不得是恒等（否则凹口会朝塔内）');

  // 产物侧交叉验证：四个 orient 都必须真的被用到
  const data = await loadStructure('giantPyramid');
  const steps = data.blocks.filter((b) => b.type === 'sand_step');
  const used = new Set(steps.map((s) => s.direction));
  for (const [facing, orient] of Object.entries(EXPECT)) {
    assertTrue(used.has(orient),
      `产物里没有 orient=${orient} 的台阶（facing=${facing} 应当产生它）—— 朝向映射可能退化了`);
  }
});
