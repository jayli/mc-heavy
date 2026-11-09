// tools/bake-burning-arena.mjs — 把 8 片 `.nbt` 素材烘焙成结构 JSON（palette 索引压缩 + 逐格朝向）
// 用法：npm run burningarena                烘焙 → assets/structures/burning_arena.json + .meta.json
//       npm run burningarena -- --census         只打印源方块普查与本仓映射结果，不写文件
//       npm run burningarena -- --census-orient  现场重测 orient → 台阶高侧方向（校验 FACING_TO_ORIENT）
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 115,381 格逐字写对象约 9MB；palette 索引压缩后约 1.4MB。`structure-json.js` 的
// `loadStructure` 已支持 `stride: 5` 带逐格朝向的形状（同巨型金字塔）。
//
// ## 为什么朝向进 `meta` 而不是进方块名
// 本仓台阶朝向的唯一机制是 `meta` 低 2 位（`mesher.js` 的 `orient = meta & 3` +
// `FACE_ROT`）。若按朝向拆成 4 个方块名，就要在 `blocks-data.js` / `faces-data.js` /
// 图标 / 背包里各增 4 份 —— 而既有 `cobblestone_step` 早已是这个机制，照抄即可。
//
// ## 熔岩分层（spec DR-2.1.5）
// 本仓 `lava` 是 `solid: true`（不可穿越）。素材地板层（归一化 y=10）有 937 格 lava，
// 直映会让碗内 13% 地面走不过去。故地板层 lava → `netherrack`，其余层保持 `lava`。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { NbtReader } from './nbt-reader.mjs';
import {
  BURNING_ARENA_SOURCE_DIR, BURNING_ARENA_PIECES, BURNING_ARENA_JSON, BURNING_ARENA_META,
  BLOCK_MAP, SLAB_BASE, FLOOR_ROW, FLOOR_LAVA_TARGET, BURNING_ARENA_METRICS,
  FACING_TO_ORIENT, burningArenaInputFingerprint,
} from './burning-arena-fingerprint.mjs';

/** 读一片 nbt，返回 {palette, blocks}（blocks 每项 {pos:[x,y,z], state}） */
function readPiece(file) {
  const raw = fs.readFileSync(path.join(BURNING_ARENA_SOURCE_DIR, file));
  const data = gunzipSync(raw);
  const r = new NbtReader(data);
  r.u1();          // root tag type (10)
  r.str();         // root name
  return r.payload(10);
}

/**
 * 一个 palette 条目 → `{block, meta} | null`；`null` = 丢弃（当作空气）。
 *
 * @param {string} name 剥掉 `minecraft:` 前缀的方块名
 * @param {object} props `Properties` 对象（可能为空对象）
 * @param {number} ny 归一化 y（熔岩分层用）
 *
 * 未知名字**一律 throw**，不许静默丢弃 —— `makeColumnSetter` 对未注册方块名是静默
 * `return`，那格变 air，而**方块层面完全看不出是映射错了**（只表现为"碗身上有个洞"）。
 */
function classify(name, props, ny) {
  // ① 熔岩分层（spec DR-2.1.5）：地板层 → netherrack，其余层保持 lava
  if (name === 'lava') {
    return { block: ny === FLOOR_ROW ? FLOOR_LAVA_TARGET : 'lava', meta: 0 };
  }

  // ② 直查映射表（air / structure_block / 各石材 / 光源 / 栏杆 / 藤蔓）
  if (Object.prototype.hasOwnProperty.call(BLOCK_MAP, name)) {
    const target = BLOCK_MAP[name];
    return target === '' ? null : { block: target, meta: 0 };
  }

  // ③ 台阶：直台阶与转角台阶统一到 cobblestone_step / cobblestone_step_updown，
  //    朝向取 facing = 高侧（实测）。`half=top` 时 orient +2 mod 4（倒置「颠倒+水平镜像」）。
  if (/_stairs$/.test(name)) {
    const facing = props.facing;
    const orient = FACING_TO_ORIENT[facing];
    if (orient === undefined) {
      throw new Error(`台阶 facing 未知：「${facing ?? '(缺失)'}」（源方块 ${name}）—— 补 FACING_TO_ORIENT`);
    }
    if (props.half === 'top') {
      return { block: 'cobblestone_step_updown', meta: (orient + 2) % 4 };
    }
    return { block: 'cobblestone_step', meta: orient };
  }

  // ④ 半砖：bottom = sand_slab；top / double = 基础整块（spec DR-2.3）。
  //    ⚠️ 不得剥 `_slab` 后缀查 BLOCK_MAP（nether_brick 单数查不到 nether_bricks）。
  if (/_slab$/.test(name)) {
    const base = SLAB_BASE[name];
    if (base === undefined) {
      throw new Error(`半砖 ${name} 未在 SLAB_BASE 收录 —— 补表`);
    }
    if (props.type === 'bottom') return { block: 'sand_slab', meta: 0 };
    return { block: base, meta: 0 };   // top / double → 整块
  }

  throw new Error(`未映射的源方块：${name}（补 BLOCK_MAP 或加分类分支后重跑）`);
}

/**
 * 组装 8 片 → 全局坐标格子列表（未映射，原始 name+props+ny）。
 * 返回 {cells, minY}，cells 每项 {x, y, z, name, props}（y 为组装后的绝对 y）。
 */
function assemble() {
  const cells = [];
  let minY = Infinity;
  for (const piece of BURNING_ARENA_PIECES) {
    const root = readPiece(piece.file);
    const palette = root.palette || [];
    for (const b of root.blocks || []) {
      const entry = palette[b.state];
      const rawName = entry.Name || '';
      const name = rawName.replace(/^minecraft:/, '');
      if (name === 'air') continue;
      const x = piece.ox + b.pos[0];
      const y = piece.oy + b.pos[1];
      const z = piece.oz + b.pos[2];
      if (y < minY) minY = y;
      cells.push({ x, y, z, name, props: entry.Properties || {} });
    }
  }
  return { cells, minY };
}

// ---------------------------------------------------------------- 普查模式

function census() {
  const { cells, minY } = assemble();
  const M = BURNING_ARENA_METRICS.burningArena;

  console.log(`素材：${BURNING_ARENA_PIECES.length} 片，共 ${cells.length} 个非空气格（minY=${minY}）`);
  console.log(`归一化 y = 组装 y − ${minY} + 1；地板层 floorRow=${FLOOR_ROW}\n`);

  // 按源方块名 + props 聚合
  const bySource = new Map();
  for (const c of cells) {
    const ny = c.y - minY + 1;
    const key = `${c.name}|${JSON.stringify(c.props)}|${ny === FLOOR_ROW ? 'floor' : 'other'}`;
    if (!bySource.has(key)) bySource.set(key, { name: c.name, props: c.props, ny, count: 0 });
    bySource.get(key).count++;
  }

  let unmapped = 0;
  const byTarget = new Map();
  let cutout = 0, opaque = 0;
  // 读 blocks-data 的 cullMode 以统计通道
  const bd = fs.readFileSync(path.resolve(import.meta.dirname, '../src/voxel/blocks-data.js'), 'utf8');
  const cullOf = {};
  for (const m of bd.matchAll(/\{"name":"([a-z_0-9]+)"[^}]*?"cullMode":"([a-z]+)"/g)) cullOf[m[1]] = m[2];

  for (const [, v] of [...bySource.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const ny = v.ny;
    let res;
    try {
      res = classify(v.name, v.props, ny);
    } catch (e) {
      unmapped++;
      console.log(`  ${String(v.count).padStart(6)}  ${v.name.padEnd(34)} ${JSON.stringify(v.props).padEnd(60)} → 【未映射】${e.message}`);
      continue;
    }
    const label = res === null ? '丢弃（当空气）' : `${res.block}${res.meta ? ` meta=${res.meta}` : ''}`;
    console.log(`  ${String(v.count).padStart(6)}  ${v.name.padEnd(34)} ${JSON.stringify(v.props).padEnd(60)} → ${label}`);
    if (res !== null) {
      byTarget.set(res.block, (byTarget.get(res.block) || 0) + v.count);
      if (cullOf[res.block] === 'cutout') cutout += v.count; else opaque += v.count;
    }
  }

  console.log('\n目标方块合计：');
  for (const [k, v] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
  const total = [...byTarget.values()].reduce((a, b) => a + b, 0);
  console.log(`  实心合计 ${total}（METRICS.contentCells = ${M.contentCells}）`);
  console.log(`  opaque ${opaque} / cutout ${cutout}（METRICS: ${M.opaqueCells} / ${M.cutoutCells}）`);

  // 包围盒
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const c of cells) {
    if (c.x < mnx) mnx = c.x; if (c.x > mxx) mxx = c.x;
    if (c.y < mny) mny = c.y; if (c.y > mxy) mxy = c.y;
    if (c.z < mnz) mnz = c.z; if (c.z > mxz) mxz = c.z;
  }
  console.log(`\n包围盒 ${mxx - mnx + 1}×${mxy - mny + 1}×${mxz - mnz + 1}（METRICS ${M.width}×${M.height}×${M.depth}）`);

  if (unmapped) {
    console.log(`\n✗ ${unmapped} 个源方块条目未映射 —— 补映射后重跑`);
    process.exitCode = 1;
  } else {
    console.log('\n全部已映射');
  }
}

// ---------------------------------------------------------------- orient 现场校验

/**
 * 现场重测 `orient → 台阶高侧方向`，同时校验正台阶与倒置台阶。
 *
 * 手法：给临时方块（几何 = `cobblestone_step` 与 `cobblestone_step_updown`）分别设
 * orient 0~3，用**真实 mesher** 发射顶点，取「上半部」的 bbox，看高侧落在哪个方向。
 * 这是校验 `FACING_TO_ORIENT` 的唯一可靠办法 —— 不要从任何模块的「定义」推。
 */
async function censusOrient() {
  const { buildSectionMesh } = await import('../src/mesh/mesher.js');
  const { createRegistry } = await import('../src/voxel/block-registry.js');
  const { BLOCKS } = await import('../src/voxel/blocks-data.js');

  const reg = createRegistry();
  for (const d of BLOCKS) reg.register(d.name, d);
  reg.register('probe_step', {
    name: 'probe_step', solid: true, cullMode: 'cutout', opaque: false,
    orientationModes: 4, geometry: 'cobblestone_step',
  });
  reg.register('probe_step_ud', {
    name: 'probe_step_ud', solid: true, cullMode: 'cutout', opaque: false,
    orientationModes: 4, geometry: 'cobblestone_step_updown',
  });
  reg.freeze();

  const VIEW = 18;
  const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) }) };
  const idx = (x, y, z) => x + z * VIEW + y * VIEW * VIEW;
  const LX = 8, LY = 8, LZ = 8;

  const short = (s) => s.split('(')[0];
  const expected = Object.fromEntries(Object.entries(FACING_TO_ORIENT).map(([f, o]) => [o, f]));

  for (const [probeName, geoLabel, isUpdown] of [
    ['probe_step', '正台阶 cobblestone_step', false],
    ['probe_step_ud', '倒置 cobblestone_step_updown', true],
  ]) {
    console.log(`\n=== ${geoLabel} ===`);
    const id = reg.idOf(probeName);
    const found = {};
    for (let orient = 0; orient < 4; orient++) {
      const data = new Uint16Array(VIEW ** 3);
      const meta = new Uint8Array(VIEW ** 3);
      const light = new Uint8Array(VIEW ** 3).fill(0xFF);
      data[idx(LX + 1, LY + 1, LZ + 1)] = id;
      meta[idx(LX + 1, LY + 1, LZ + 1)] = orient;
      const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;

      // 正台阶取上半部（y ≥ 0.5）；倒置台阶取下半部（y ≤ 0.5）的高侧
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (let i = 0; i < g.positions.length; i += 3) {
        const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
        if (isUpdown ? y >= LY + 0.5 - 1e-6 : y <= LY + 0.5 + 1e-6) continue;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const spanX = mxx - mnx, spanZ = mxz - mnz;
      let side;
      if (spanX < 0.75 && spanZ > 0.75) side = ((mnx + mxx) / 2 - LX) < 0.5 ? 'west(-X)' : 'east(+X)';
      else if (spanZ < 0.75 && spanX > 0.75) side = ((mnz + mxz) / 2 - LZ) < 0.5 ? 'north(-Z)' : 'south(+Z)';
      else side = `不确定（spanX=${spanX.toFixed(2)} spanZ=${spanZ.toFixed(2)}）`;
      found[orient] = side;
      console.log(`  orient=${orient}  高半部 x[${(mnx - LX).toFixed(2)},${(mxx - LX).toFixed(2)}] ` +
        `z[${(mnz - LZ).toFixed(2)},${(mxz - LZ).toFixed(2)}]  → 高侧 ${side}`);
    }

    let bad = 0;
    for (let o = 0; o < 4; o++) {
      // 倒置台阶的 meta = (orient+2)%4，故实测 orient o 对应声明的 (o+2)%4 的 facing
      const declOrient = isUpdown ? (o + 2) % 4 : o;
      if (short(found[o]) !== expected[declOrient]) {
        console.log(`  ✗ orient=${o} 实测 ${found[o]}，FACING_TO_ORIENT 声明 ${expected[declOrient]}`);
        bad++;
      }
    }
    console.log(bad ? `  ✗ ${bad} 项不符 —— 修正映射` : '  ✓ 与 FACING_TO_ORIENT 一致');
    if (bad) process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- 烘焙

function bake() {
  const { cells, minY } = assemble();
  const M = BURNING_ARENA_METRICS.burningArena;

  // 平移原点：x/z 取 85 宽的中心 42（与本仓「锚点 = 宽/2」约定一致）；y 归一化到 1。
  const OX = 42, OZ = 42;

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();
  const metaCounts = new Map();

  // 按 y→z→x 排序保证 palette 首次出现顺序确定
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const c of sorted) {
    const ny = c.y - minY + 1;
    const res = classify(c.name, c.props, ny);
    if (res === null) continue;

    let tpi = paletteIndex.get(res.block);
    if (tpi === undefined) {
      tpi = palette.length;
      palette.push(res.block);
      paletteIndex.set(res.block, tpi);
    }
    // 归一化：x/z 相对中心，y 从 minY 变 1。
    // ⚠️ **第 5 项 direction 必填**（stride=5）：台阶靠它携带 orient。
    blocks.push(c.x - OX, ny, c.z - OZ, tpi, res.meta);
    counts.set(res.block, (counts.get(res.block) || 0) + 1);
    if (res.block === 'cobblestone_step' || res.block === 'cobblestone_step_updown') {
      const k = `${res.block}:${res.meta}`;
      metaCounts.set(k, (metaCounts.get(k) || 0) + 1);
    }
  }

  // ---- 断言（产物契约，与 check:data 同口径但这里先自守一道）----
  const STRIDE = 5;
  const n = blocks.length / STRIDE;
  if (n !== M.contentCells) {
    throw new Error(`方块数 ${n} ≠ METRICS.contentCells ${M.contentCells}（源改动？先跑 --census 核映射）`);
  }
  if (palette.length !== M.paletteSize) {
    throw new Error(`palette 有 ${palette.length} 种（${palette.join(', ')}）≠ METRICS.paletteSize ${M.paletteSize}`);
  }
  const wantCounts = {
    nether_bricks: 78913, polished_diorite: 9171, obsidian: 7075, netherrack: 4882,
    polished_deepslate: 3477, handrail: 3311, lava: 1179,
    cobblestone_step_updown: 2053, cobblestone_step: 1426,
    polished_blackstone_bricks: 1389, glowstone: 942, deepslate: 540, sand_slab: 504,
    nether_bricks_1: 184, vine: 168, hanging_lamp: 125, gold_block: 37, debris: 4, chest: 1,
  };
  for (const [k, v] of Object.entries(wantCounts)) {
    const got = counts.get(k) || 0;
    if (got !== v) throw new Error(`"${k}" 格数 ${got} ≠ 冻结值 ${v}`);
  }

  // bbox 与地板层
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  let floorCells = 0;
  for (let i = 0; i < blocks.length; i += STRIDE) {
    const bx = blocks[i], by = blocks[i + 1], bz = blocks[i + 2];
    if (bx < mnx) mnx = bx; if (bx > mxx) mxx = bx;
    if (by < mny) mny = by; if (by > mxy) mxy = by;
    if (bz < mnz) mnz = bz; if (bz > mxz) mxz = bz;
    if (by === FLOOR_ROW) floorCells++;
  }
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  if (W !== M.width) throw new Error(`宽 ${W} ≠ ${M.width}`);
  if (H !== M.height) throw new Error(`高 ${H} ≠ ${M.height}`);
  if (D !== M.depth) throw new Error(`深 ${D} ≠ ${M.depth}`);
  if (mny !== 1) throw new Error(`最低点 y=${mny} ≠ 1（归一化失败）`);
  if (floorCells !== M.floorCells) throw new Error(`地板层格数 ${floorCells} ≠ METRICS.floorCells ${M.floorCells}`);

  // ---- 写盘 ----
  const json = { version: 1, stride: STRIDE, floorRow: FLOOR_ROW, palette, blocks };
  const fp = burningArenaInputFingerprint();
  const meta = {
    version: 1,
    width: W, height: H, depth: D,
    blocks: n,
    floorRow: FLOOR_ROW,
    floorCells,
    paletteSize: palette.length,
    stepOrientationCounts: Object.fromEntries([...metaCounts.entries()].sort()),
    origin: { cx: OX, cz: OZ },
    fingerprints: fp,
  };

  fs.mkdirSync(path.dirname(BURNING_ARENA_JSON), { recursive: true });
  fs.writeFileSync(BURNING_ARENA_JSON, JSON.stringify(json));
  fs.writeFileSync(BURNING_ARENA_META, `${JSON.stringify(meta, null, 2)}\n`);

  const kb = (fs.statSync(BURNING_ARENA_JSON).size / 1024).toFixed(1);
  console.log(`灾变竞技场 JSON ${kb} KB，${n} 格，${W}×${H}×${D}，palette ${palette.length} 种，` +
    `地板层 ${floorCells} 格（floorRow=${FLOOR_ROW}）`);
  console.log(`台阶朝向分布：${JSON.stringify(meta.stepOrientationCounts)}`);
  console.log(`指纹 ${fp.input}`);
}

// ---------------------------------------------------------------- 入口

const args = process.argv.slice(2);
if (args.includes('--census')) {
  census();
} else if (args.includes('--census-orient')) {
  await censusOrient();
} else {
  bake();
}
