// tools/bake-arena.mjs — 把 `.schematic` 素材烘焙成结构 JSON（palette 索引压缩 + 逐格朝向）
// 用法：npm run arena                烘焙 → assets/structures/arena_grass.json + arena.meta.json
//       npm run arena -- --census     只打印源方块普查与本仓映射结果，不写文件
//       npm run arena -- --ring       只打印栏杆环的臂集合 / (方块, 朝向) 分配，不写文件
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 4145 格逐字写对象约 320KB；palette 索引压缩后约 90KB。`structure-json.js` 的
// `loadStructure` 已支持三种形状，本产物用**第三种**（`stride: 5` 带逐格朝向）——
// 正是巨型金字塔为 1219 个台阶引入的格式：栏杆的「转角件要旋转到与两边匹配」全靠它。
//
// ## 为什么丢弃 barrier / bedrock
// 每个素材都自带两类容器方块（见 `CONTAINER_BLOCKS` 的注释）：`barrier` 是选区空心盒，
// `bedrock` 是垫底板。本仓没有 barrier 方块；bedrock 在本仓是基岩（不可破坏）—— 留着会
// 在地表造出 4 层不可破坏的岩石板。两者都不是美术内容。
//
// ## 栏杆环从哪来
// 环的位置 = 内容包围盒外扩 `RAIL_RING_INSET`（= 1）—— 实测这正是素材 `barrier` 环的
// 位置，也就是「作者画的选区边界」，语义上正是外圈栏杆该在的地方。
// 原图的 42 个 `fence` + 2 个 `fence_gate` 是**两段斜向折线**，而本仓三个栏杆件的臂**只沿
// ±X / ±Z**（无对角臂）→ 斜向段无解（spec DR-5，用户裁定改为外圈轴对齐闭合环）。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { NbtReader } from './nbt-reader.mjs';
import {
  ARENA_SOURCE_PATH, ARENA_JSON, ARENA_META, BLOCK_MAP, CONTAINER_BLOCKS, SUPERSEDED_BLOCKS,
  RAIL_RING_INSET, ARENA_METRICS, arenaInputFingerprint,
} from './arena-fingerprint.mjs';
// 栏杆臂方向的唯一权威在运行期模块里（从 TEMPLATES + mesher 的 rotateOffset 派生）。
// 烘焙侧 import 同一份，不写第二份几何表（红线 1）。
import { railArmSet, railPlacementFor } from '../src/gen/structures/arena.js';

/**
 * 数字方块 id → 名字（旧版 `.schematic` 的 `Blocks` 数组是数字 id，`AddBlocks` 未使用 →
 * 只覆盖 0~255）。只收录 Arena 素材可能出现的 id；未收录的 id **throw**（见 `classify`）。
 *
 * 来源：Minecraft 1.12 及以前（扁平化之前）的方块 id 表。Arena1 实际用到 15 种，
 * 但表故意留宽一点 —— 将来启用 Arena2~6 时（hclay / silverfish / nether 系列）
 * 不必重新查一遍；`--census` 会打印未覆盖项。
 */
const LEGACY_ID = Object.freeze({
  0: 'air', 1: 'stone', 2: 'grass', 3: 'dirt', 4: 'cobblestone', 5: 'planks',
  6: 'sapling', 7: 'bedrock', 8: 'flowing_water', 9: 'water', 10: 'flowing_lava',
  11: 'lava', 12: 'sand', 13: 'gravel', 14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore',
  17: 'log', 18: 'leaves', 19: 'sponge', 20: 'glass', 24: 'sandstone', 25: 'noteblock',
  29: 'sticky_piston', 31: 'tall_grass', 32: 'deadbush', 33: 'piston', 35: 'wool',
  37: 'dandelion', 38: 'poppy', 39: 'brown_mushroom', 40: 'red_mushroom', 41: 'gold_block',
  42: 'iron_block', 43: 'double_stone_slab', 44: 'stone_slab', 45: 'brick_block',
  46: 'tnt', 47: 'bookshelf', 48: 'mossy_cobblestone', 49: 'obsidian', 50: 'torch',
  52: 'mob_spawner', 53: 'oak_stairs', 54: 'chest', 57: 'diamond_block', 58: 'crafting_table',
  60: 'farmland', 64: 'wooden_door', 65: 'ladder', 66: 'rail', 67: 'stone_stairs',
  69: 'lever', 70: 'stone_pressure_plate', 72: 'wooden_pressure_plate', 76: 'redstone_torch',
  77: 'stone_button', 78: 'snow_layer', 79: 'ice', 80: 'snow', 81: 'cactus', 82: 'clay',
  83: 'reeds', 84: 'jukebox', 85: 'fence', 86: 'pumpkin', 87: 'netherrack', 88: 'soul_sand',
  89: 'glowstone', 90: 'portal', 91: 'lit_pumpkin', 95: 'stained_glass', 96: 'trapdoor',
  97: 'silverfish', 98: 'stonebrick', 99: 'brown_mushroom_block', 100: 'red_mushroom_block',
  101: 'iron_bars', 102: 'glass_pane', 103: 'melon_block', 104: 'pumpkin_stem',
  106: 'vine', 107: 'fence_gate', 108: 'brick_stairs', 109: 'stone_brick_stairs',
  110: 'mycelium', 111: 'waterlily', 112: 'nether_brick', 113: 'nether_brick_fence',
  114: 'nether_wart', 115: 'nether_wart', 116: 'enchanting_table', 118: 'cauldron',
  120: 'end_portal_frame', 121: 'end_stone', 123: 'lit_redstone_lamp', 124: 'redstone_lamp',
  125: 'double_wooden_slab', 126: 'wooden_slab', 128: 'sandstone_stairs',
  129: 'emerald_ore', 133: 'emerald_block', 134: 'spruce_stairs', 135: 'birch_stairs',
  136: 'jungle_stairs', 137: 'command_block', 139: 'cobblestone_wall', 141: 'carrot',
  142: 'potato', 143: 'wooden_button', 145: 'anvil', 146: 'trapped_chest',
  152: 'redstone_block', 153: 'quartz_ore', 154: 'hopper', 155: 'quartz_block',
  156: 'quartz_stairs', 159: 'stained_hardened_clay', 160: 'stained_glass_pane',
  161: 'leaves2', 162: 'log2', 163: 'acacia_stairs', 164: 'dark_oak_stairs',
  168: 'prismarine', 169: 'sea_lantern', 170: 'hay_block', 171: 'carpet',
  172: 'hardened_clay', 173: 'coal_block', 174: 'packed_ice', 175: 'double_plant',
  179: 'red_sandstone', 180: 'red_sandstone_stairs', 181: 'double_stone_slab2',
  182: 'stone_slab2', 188: 'spruce_fence', 189: 'birch_fence', 190: 'jungle_fence',
  191: 'dark_oak_fence', 192: 'acacia_fence', 198: 'end_rod', 199: 'chorus_plant',
  201: 'purpur_block', 202: 'purpur_pillar', 203: 'purpur_stairs', 205: 'purpur_slab',
  206: 'end_bricks', 208: 'grass_path', 210: 'repeating_command_block',
  216: 'bone_block', 251: 'concrete', 252: 'concrete_powder', 255: 'structure_block',
  // ⚠️ 166 = barrier：Sponge 格式里 barrier 属于「被扁平化后重编号」的方块，
  // 本表按 WorldEdit 1.12 兼容口径收录（实测该素材的选区盒就是它）。
  166: 'barrier',
});

/** 读取 `.schematic`：gzip + NBT（`Blocks` 8 位 + `Data` 半字节）。 */
function readSchematic(file) {
  const raw = fs.readFileSync(file);
  const buf = gunzipSync(raw);
  const r = new NbtReader(buf);
  const tagType = r.u1();
  r.str();                       // root name（恒 'Schematic'）
  const root = r.payload(tagType);
  const W = root.Width, H = root.Height, L = root.Length;
  const B = root.Blocks, D = root.Data;
  return {
    width: W, height: H, length: L,
    idAt: (x, y, z) => B[(y * L + z) * W + x],
    dataAt: (x, y, z) => {
      const i = (y * L + z) * W + x;
      return (D[i >> 1] >> ((i & 1) * 4)) & 0xF;
    },
  };
}

/**
 * 源方块 → 目标方块名（`null` = 丢弃）。未知名字 **throw**。
 *
 * ⚠️ **未知源方块必须抛**：`makeColumnSetter` 对未注册名字是**静默 return**
 * （`landmarks.js`），那格会变成 air —— 方块层面完全看不出是映射错了（v1.80 高台教训）。
 *
 * `SUPERSEDED_BLOCKS`（原图斜向栏杆）与 `CONTAINER_BLOCKS` 都返回 null —— 两者都被
 * 主动丢弃，但语义不同（见各自定义处注释）。
 */
function classify(sourceName) {
  if (CONTAINER_BLOCKS.includes(sourceName)) return null;
  if (SUPERSEDED_BLOCKS.includes(sourceName)) return null;
  if (!Object.prototype.hasOwnProperty.call(BLOCK_MAP, sourceName)) {
    throw new Error(`未映射的源方块：${sourceName}（补 BLOCK_MAP 后重跑）`);
  }
  return BLOCK_MAP[sourceName];
}

/**
 * 源方块普查（名字 → 格数，含容器方块与被取代的栅栏）。
 * 写进 meta 供 `check:data` 反向断言「素材里的每个源方块都有归处」。
 */
function countSourceBlocks(s) {
  const counts = new Map();
  for (let y = 0; y < s.height; y++) {
    for (let z = 0; z < s.length; z++) {
      for (let x = 0; x < s.width; x++) {
        const id = s.idAt(x, y, z);
        if (!id) {
          counts.set('air', (counts.get('air') || 0) + 1);
          continue;
        }
        const key = LEGACY_ID[id] ?? `id${id}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  }
  return counts;
}

/** 内容包围盒（丢弃容器方块后的非空范围）。 */
function contentBounds(s) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let y = 0; y < s.height; y++) {
    for (let z = 0; z < s.length; z++) {
      for (let x = 0; x < s.width; x++) {
        if (classify(LEGACY_ID[s.idAt(x, y, z)]) === null) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * 栏杆环：内容包围盒外扩 `RAIL_RING_INSET` 的矩形周长。
 * 返回环上每格 `{x, z, arms}`（arms = 该格在环上的正交邻居方向集合）。
 */
function railRingOf(b) {
  const minX = b.minX - RAIL_RING_INSET, maxX = b.maxX + RAIL_RING_INSET;
  const minZ = b.minZ - RAIL_RING_INSET, maxZ = b.maxZ + RAIL_RING_INSET;
  const onRing = (x, z) => x >= minX && x <= maxX && z >= minZ && z <= maxZ
    && (x === minX || x === maxX || z === minZ || z === maxZ);
  const cells = [];
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      if (!onRing(x, z)) continue;
      const arms = [];
      if (onRing(x + 1, z)) arms.push('+X');
      if (onRing(x - 1, z)) arms.push('-X');
      if (onRing(x, z + 1)) arms.push('+Z');
      if (onRing(x, z - 1)) arms.push('-Z');
      cells.push({ x, z, arms });
    }
  }
  return cells;
}

// ---------------------------------------------------------------- 普查模式

function census() {
  const s = readSchematic(ARENA_SOURCE_PATH);
  const counts = countSourceBlocks(s);
  const b = contentBounds(s);
  console.log(`素材：${path.relative(process.cwd(), ARENA_SOURCE_PATH)}`);
  console.log(`尺寸 ${s.width}×${s.height}×${s.length}；内容包围盒 ` +
    `x[${b.minX},${b.maxX}] y[${b.minY},${b.maxY}] z[${b.minZ},${b.maxZ}] ` +
    `= ${b.maxX - b.minX + 1}×${b.maxY - b.minY + 1}×${b.maxZ - b.minZ + 1}`);

  let unmapped = 0;
  for (const [name, n] of [...counts.entries()].sort((a, b2) => b2[1] - a[1])) {
    let target;
    try {
      target = classify(name);
    } catch (e) {
      console.log(`  ✗ ${name.padEnd(22)} ${String(n).padStart(6)} 格 → 未映射（${e.message}）`);
      unmapped += n;
      continue;
    }
    const label = target === null
      ? (SUPERSEDED_BLOCKS.includes(name) ? '（丢弃 / 由外圈栏杆环取代）' : '（丢弃 / 容器方块）')
      : target;
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(6)} 格 → ${label}`);
  }

  // 栏杆环普查
  const ring = railRingOf(b);
  const hist = new Map();
  for (const c of ring) {
    const hit = railPlacementFor(c.arms);
    const key = hit ? `${hit.name}:${hit.orient}` : `无解(${c.arms.join(' ')})`;
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  console.log(`\n栏杆环 ${ring.length} 格（内容包围盒外扩 ${RAIL_RING_INSET}）：`);
  for (const [k, n] of [...hist.entries()].sort()) console.log(`  ${k.padEnd(22)} ${n} 格`);
  const broken = [...hist.keys()].filter((k) => k.startsWith('无解'));
  if (broken.length) console.log(`  ✗ 有 ${broken.length} 种臂集合无解 —— 环不是简单矩形环，几何假设被破坏`);
  if (unmapped) console.log(`\n✗ 未被映射的源方块共 ${unmapped} 格 —— 补 BLOCK_MAP 后重跑`);
  if (unmapped || broken.length) process.exitCode = 1;
}

// ---------------------------------------------------------------- 环模式

function ringReport() {
  const s = readSchematic(ARENA_SOURCE_PATH);
  const b = contentBounds(s);
  const ring = railRingOf(b);
  const y = b.minY + 1;   // 栏杆在地板层之上 1 格（与素材原栏杆同层）
  let bad = 0;
  for (const c of ring) {
    const hit = railPlacementFor(c.arms);
    if (!hit) { bad++; console.log(`✗ (${c.x},${c.z}) 臂 [${c.arms.join(' ')}] 无解`); continue; }
    const want = [...c.arms].sort().join(' ');
    const got = railArmSet(hit.name, hit.orient).sort().join(' ');
    console.log(`(${String(c.x).padStart(2)},${String(c.z).padStart(2)}) y=${y}  需要 [${want.padEnd(6)}] → ${hit.name.padEnd(10)} orient=${hit.orient}  (实得 [${got}])`);
  }
  console.log(`\n环 ${ring.length} 格，无解 ${bad} 格`);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- 烘焙

function bake() {
  const s = readSchematic(ARENA_SOURCE_PATH);
  const M = ARENA_METRICS.arenaGrass;
  const b = contentBounds(s);

  const W = b.maxX - b.minX + 1, H = b.maxY - b.minY + 1, D = b.maxZ - b.minZ + 1;
  if (W !== M.width) throw new Error(`内容宽 ${W} ≠ ARENA_METRICS.width ${M.width}`);
  if (H !== M.height) throw new Error(`内容高 ${H} ≠ ARENA_METRICS.height ${M.height}`);
  if (D !== M.depth) throw new Error(`内容深 ${D} ≠ ARENA_METRICS.depth ${M.depth}`);

  // 原点：x/z 取内容包围盒中心（本仓「模板坐标以块底角为原点、锚点 = 中心」的约定）；
  // y 归一化到 1（`rasterizeStructure` 内部按 `y + b.y - 1` 落位，最低层 = 1）。
  // ⚠️ 奇数跨度必须用 `(W-1)>>1` 反推中心列，不能用 `(minX+maxX)>>1` —— 后者对
  // 「minX 为奇数、maxX 为偶数」的包围盒会偏半格（39 宽时 minX+maxX 是偶数才恰好等价，
  // 换个素材就错）。
  const cX = b.minX + ((W - 1) >> 1);
  const cZ = b.minZ + ((D - 1) >> 1);

  // 地板层 = 内容里**覆盖最完整**的那一层（39×77 满铺）。
  // ⚠️ **不能用「内容最低层」**：水池把最低两层挖成了沙底 + 水（实测源 y=2/3），
  // 最低层只有 115 格沙。地板层的存在是「竞技场能站人」的前提，必须先找出来。
  const cols = W * D;
  let floorSrcY = -1, floorCover = -1;
  for (let y = b.minY; y <= b.maxY; y++) {
    let cover = 0;
    for (let z = b.minZ; z <= b.maxZ; z++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        if (classify(LEGACY_ID[s.idAt(x, y, z)]) !== null) cover++;
      }
    }
    if (cover > floorCover) { floorCover = cover; floorSrcY = y; }
  }
  if (floorCover !== cols) {
    throw new Error(`最完整的一层只有 ${floorCover}/${cols} 格（地板不完整 → 水池/漏洞会漏下去）`);
  }
  const floorRow = floorSrcY - b.minY + 1;
  if (floorRow !== M.floorRow) {
    throw new Error(`地板层归一化后 y=${floorRow} ≠ ARENA_METRICS.floorRow ${M.floorRow}`);
  }

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();
  const railCounts = new Map();
  const addBlock = (wx, wy, wz, name, meta) => {
    let pi = paletteIndex.get(name);
    if (pi === undefined) { pi = palette.length; palette.push(name); paletteIndex.set(name, pi); }
    blocks.push(wx - cX, wy - b.minY + 1, wz - cZ, pi, meta);
  };

  // ① 内容逐格映射（丢弃容器方块与被取代的原图栅栏）
  for (let y = b.minY; y <= b.maxY; y++) {
    for (let z = b.minZ; z <= b.maxZ; z++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        const target = classify(LEGACY_ID[s.idAt(x, y, z)]);
        if (target === null) continue;
        addBlock(x, y, z, target, 0);
        counts.set(target, (counts.get(target) || 0) + 1);
      }
    }
  }

  // ② 栏杆环（地板层之上 1 格 —— 与素材原栏杆同层）
  const railRow = floorRow + 1;
  for (const c of railRingOf(b)) {
    const hit = railPlacementFor(c.arms);
    if (!hit) {
      throw new Error(`栏杆环 (${c.x},${c.z}) 需要臂 [${c.arms.join(' ')}]，无 (方块,朝向) 可表达`);
    }
    addBlock(c.x, b.minY + railRow - 1, c.z, hit.name, hit.orient);
    const k = `${hit.name}:${hit.orient}`;
    railCounts.set(k, (railCounts.get(k) || 0) + 1);
  }

  // ---- 产物契约（先自守一道，与 check:data 同口径）----
  const STRIDE = 5;
  const n = blocks.length / STRIDE;
  const railCells = [...railCounts.values()].reduce((a, v) => a + v, 0);
  if (railCells !== M.railCells) throw new Error(`栏杆格数 ${railCells} ≠ ${M.railCells}`);
  const contentCells = n - railCells;
  if (contentCells !== M.contentCells) {
    throw new Error(`内容格数 ${contentCells} ≠ ARENA_METRICS.contentCells ${M.contentCells}（源改动？先跑 --census）`);
  }
  // 地板层必须满铺（含栏杆环内的外圈一圈？不含 —— 栏杆在地板之上，地板是内容 39×77）
  const floorCols = new Set();
  for (let i = 0; i < blocks.length; i += STRIDE) {
    if (blocks[i + 1] === floorRow) floorCols.add(`${blocks[i]},${blocks[i + 2]}`);
  }
  if (floorCols.size !== M.floorCells) {
    throw new Error(`地板层 ${floorCols.size} 列 ≠ ${M.floorCells}`);
  }

  // ---- 写盘 ----
  const fp = arenaInputFingerprint();
  const json = { version: 1, stride: STRIDE, floorRow, palette, blocks };
  const meta = {
    version: 1,
    source: path.relative(path.resolve(import.meta.dirname, '..'), ARENA_SOURCE_PATH),
    sourceSize: { width: s.width, height: s.height, length: s.length },
    width: W, height: H, depth: D,
    floorRow,
    footprintWidth: M.footprintWidth, footprintDepth: M.footprintDepth,
    contentBounds: b,
    contentCells,
    floorCells: floorCols.size,
    railCells,
    railOrientationCounts: Object.fromEntries([...railCounts.entries()].sort()),
    blockCounts: Object.fromEntries([...counts.entries()].sort()),
    // 素材侧普查：`check:data` 用它反向断言「没有未知源方块被静默丢弃」
    sourceBlockCounts: Object.fromEntries([...countSourceBlocks(s).entries()].sort()),
    paletteSize: palette.length,
    origin: { cx: cX, cz: cZ },
    fingerprints: fp,
  };

  fs.mkdirSync(path.dirname(ARENA_JSON), { recursive: true });
  fs.writeFileSync(ARENA_JSON, JSON.stringify(json));
  fs.writeFileSync(ARENA_META, `${JSON.stringify(meta, null, 2)}\n`);

  const kb = (fs.statSync(ARENA_JSON).size / 1024).toFixed(1);
  console.log(`竞技场 JSON ${kb} KB，${n} 格（内容 ${contentCells} + 栏杆 ${railCells}），` +
    `${W}×${H}×${D}，floorRow ${floorRow}，palette ${palette.length} 种`);
  console.log(`栏杆朝向分布：${JSON.stringify(meta.railOrientationCounts)}`);
  console.log(`内容方块：${JSON.stringify(meta.blockCounts)}`);
  console.log(`指纹 ${fp.input}`);
}

// ---------------------------------------------------------------- 入口

const args = process.argv.slice(2);
if (args.includes('--census')) census();
else if (args.includes('--ring')) ringReport();
else bake();
