// tools/bake-giant-pyramid.mjs — 把 `.litematic` 素材烘焙成结构 JSON（palette 索引压缩）
// 用法：npm run pyramid          烘焙 → assets/structures/giant_pyramid.json + .meta.json
//       npm run pyramid -- --census         只打印源方块普查与本仓映射结果，不写文件
//       npm run pyramid -- --census-orient  现场重测 orient → 台阶高侧方向（校验 FACING_TO_ORIENT）
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 16207 格逐字写 `{x,y,z,type,direction}` 对象约 1.1MB；palette 索引压缩后约 320KB。
// `structure-json.js` 的 `loadStructure` 已支持两种形状（`data.palette` + `data.blocks`），
// 与高台 `cloudland_mesa_small.json` 同一格式。
//
// ## 为什么朝向进 `meta` 而不是进方块名
// 本仓台阶朝向的唯一机制是 `meta` 低 2 位（`mesher.js` 的 `orient = meta & 3` +
// `FACE_ROT`）。若按朝向拆成 4 个方块名，就要在 `blocks-data.js` / `faces-data.js` /
// 图标 / 背包里各增 4 份 —— 而既有 `planks_step` 早已是这个机制，照抄即可。
//
// ## 三处有意偏离（详见 spec §6）
// ① 转角台阶（outer_left/outer_right，63 格）→ **直台阶近似**：本仓 `TEMPLATES` 只有
//    L 形直台阶，新造转角几何要自己定义形状（属「按 Minecraft 定义推断」，违本仓纪律）。
//    观感差异 = 路口内侧缺一个 0.5³ 的角，用户已接受。
// ② `barrier` 1759 格 → 空气：本仓无对应方块；实测无一格构成可站立通道，不影响可走性。
// ③ `smooth_sandstone*` → `sand` / `sand_step` / `sand_slab`：用户要求「用沙子方块构建」。
import fs from 'node:fs';
import path from 'node:path';
import { readLitematic, litematicIndex } from './litematic-reader.mjs';
import {
  LITEMATIC_PATH, PYRAMID_JSON, PYRAMID_META, BLOCK_MAP, PYRAMID_METRICS,
  FACING_TO_ORIENT, giantPyramidInputFingerprint,
} from './giant-pyramid-fingerprint.mjs';

/**
 * 一个 palette 条目 → `{block, meta}`；`null` = 丢弃（当作空气）。
 *
 * 未知名字**一律 throw**，不许静默丢弃 —— `makeColumnSetter` 对未注册方块名是静默
 * `return`，那格变 air，而**方块层面完全看不出是映射错了**（只表现为"塔身上有个洞"）。
 */
export function classify(paletteName, props) {
  const p = props || {};

  // ① 名字直查映射表（air / barrier / smooth_sandstone）
  if (Object.prototype.hasOwnProperty.call(BLOCK_MAP, paletteName)) {
    const target = BLOCK_MAP[paletteName];
    return target === '' ? null : { block: target, meta: 0 };
  }

  // ② 台阶：直台阶与转角台阶统一到 sand_step（偏离 ①），朝向取 facing = 高侧（实测）
  if (/_stairs$/.test(paletteName)) {
    const orient = FACING_TO_ORIENT[p.facing];
    if (orient === undefined) {
      throw new Error(`台阶 facing 未知：「${facing ?? '(缺失)'}」（源方块 ${paletteName}）—— 补 FACING_TO_ORIENT`);
    }
    return { block: 'sand_step', meta: orient };
  }

  // ③ 半砖：double = 整格；bottom = 半砖。top 不应存在（出现即数据异常）
  if (/_slab$/.test(paletteName)) {
    if (p.type === 'double') return { block: 'sand', meta: 0 };
    if (p.type === 'bottom') return { block: 'sand_slab', meta: 0 };
    throw new Error(`半砖 type 未知：「${p.type ?? '(缺失)'}」（源方块 ${paletteName}）`);
  }

  throw new Error(`未映射的源方块：${paletteName}（补 BLOCK_MAP 或加分类分支后重跑）`);
}

// ---------------------------------------------------------------- 普查模式

function census() {
  const raw = fs.readFileSync(LITEMATIC_PATH);
  const r = readLitematic(raw);
  const counts = new Map();
  for (const v of r.blocks) counts.set(v, (counts.get(v) || 0) + 1);

  console.log(`素材：${path.relative(process.cwd(), LITEMATIC_PATH)}`);
  console.log(`region「${r.regionName}」（共 ${r.regionCount} 个），尺寸 ${r.size.x}×${r.size.y}×${r.size.z}，TotalBlocks ${r.totalBlocks}`);

  let unmapped = 0;
  const byTarget = new Map();
  for (const [i, n] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const name = r.palette[i];
    const props = r.paletteProps[i];
    let res;
    try {
      res = classify(name, props);
    } catch (e) {
      unmapped++;
      console.log(`  ${String(n).padStart(6)}  ${name.padEnd(30)} → 【未映射】${e.message}`);
      continue;
    }
    const label = res === null ? '丢弃（当空气）' : `${res.block}${res.meta ? ` meta=${res.meta}` : ''}`;
    console.log(`  ${String(n).padStart(6)}  ${name.padEnd(30)} ${JSON.stringify(props || {}).padEnd(64)} → ${label}`);
    if (res !== null) byTarget.set(res.block, (byTarget.get(res.block) || 0) + n);
  }

  console.log('\n目标方块合计：');
  for (const [k, v] of byTarget) console.log(`  ${k.padEnd(12)} ${v}`);
  const solid = [...byTarget.values()].reduce((a, b) => a + b, 0);
  console.log(`  实心合计 ${solid}（PYRAMID_METRICS.blocks = ${PYRAMID_METRICS.blocks}）`);

  if (unmapped) {
    console.log(`\n✗ ${unmapped} 个 palette 条目未映射 —— 补映射后重跑`);
    process.exitCode = 1;
  } else {
    console.log('\n全部已映射');
  }
}

// ---------------------------------------------------------------- orient 现场校验

/**
 * 现场重测 `orient → 台阶高侧方向`。
 *
 * 手法：给一个临时方块（几何 = 既有 `planks_step`）分别设 orient 0~3，用**真实 mesher**
 * 发射顶点，取「y ≥ 0.5 那半部」的 bbox，看高侧落在哪个方向。
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
    orientationModes: 4, geometry: 'planks_step',
  });
  reg.freeze();

  const VIEW = 18;   // 16 + 2 halo
  const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) }) };
  const id = reg.idOf('probe_step');
  const idx = (x, y, z) => x + z * VIEW + y * VIEW * VIEW;
  const LX = 8, LY = 8, LZ = 8;   // section 内局部坐标（view 坐标 = +1）

  const found = {};
  for (let orient = 0; orient < 4; orient++) {
    const data = new Uint16Array(VIEW ** 3);
    const meta = new Uint8Array(VIEW ** 3);
    const light = new Uint8Array(VIEW ** 3).fill(0xFF);
    data[idx(LX + 1, LY + 1, LZ + 1)] = id;
    meta[idx(LX + 1, LY + 1, LZ + 1)] = orient;
    const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;

    // 只取上半部（y ≥ 0.5，**section 绝对坐标** LY+0.5 = 8.5）
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3) {
      const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
      if (y <= LY + 0.5 + 1e-6) continue;
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    // ⚠️ 判据必须用 **bbox 而不是中心点**：直台阶的 L 形上半部一端贴满 [0,1]、另一端只占半格。
    // 用中心点会在「高侧 x 半格 + z 满幅」时被 z 的中位 0.5 抢走（实测踩到：orient=0
    // 的 bbox 是 x[0,0.5] z[0,1]，中心 dx=0.25 dz=0.5 → 误判为南）。
    // 正确判据：哪一轴的跨度只有半格（0.5），高侧就在该轴的那个半边。
    const spanX = mxx - mnx, spanZ = mxz - mnz;
    let side;
    if (spanX < 0.75 && spanZ > 0.75) side = ((mnx + mxx) / 2 - LX) < 0.5 ? 'west(-X)' : 'east(+X)';
    else if (spanZ < 0.75 && spanX > 0.75) side = ((mnz + mxz) / 2 - LZ) < 0.5 ? 'north(-Z)' : 'south(+Z)';
    else side = `不确定（spanX=${spanX.toFixed(2)} spanZ=${spanZ.toFixed(2)}）`;
    found[orient] = side;
    console.log(`orient=${orient}  高半部 x[${(mnx - LX).toFixed(2)},${(mxx - LX).toFixed(2)}] ` +
      `z[${(mnz - LZ).toFixed(2)},${(mxz - LZ).toFixed(2)}]  → 高侧 ${side}`);
  }

  const expected = Object.fromEntries(Object.entries(FACING_TO_ORIENT).map(([f, o]) => [o, f]));
  // 声明的值用的是短名（west/south/east/north），实测值是 `side(轴)`，归一化后比较
  const short = (s) => s.split('(')[0];
  let bad = 0;
  for (let o = 0; o < 4; o++) {
    if (short(found[o]) !== expected[o]) {
      console.log(`✗ orient=${o} 实测 ${found[o]}，FACING_TO_ORIENT 声明 ${expected[o]}`);
      bad++;
    }
  }
  console.log(bad ? `\n✗ ${bad} 项不符 —— 修正 FACING_TO_ORIENT` : '\n✓ FACING_TO_ORIENT 与实测一致');
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- 烘焙

function bake() {
  const raw = fs.readFileSync(LITEMATIC_PATH);
  const r = readLitematic(raw);
  const M = PYRAMID_METRICS;

  // 尺寸断言先做（后面的坐标换算全靠它）
  if (r.size.x !== M.width || r.size.z !== M.depth) {
    throw new Error(`素材尺寸 ${r.size.x}×${r.size.z} ≠ PYRAMID_METRICS ${M.width}×${M.depth}`);
  }

  const { x: SX, y: SY, z: SZ } = r.size;
  // 平移原点：x/z 取 49 宽的中心 24（与本仓「模板坐标以块底角为原点、锚点 = SX/2」的约定一致，
  // 见 AGENTS.md「实例原点换算基准」）；y 归一化到 1（`rasterizeStructure` 按 `y - 1` 落位）。
  const OX = Math.floor(SX / 2);
  const OZ = Math.floor(SZ / 2);

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();   // 目标方块 → 格数
  const metaCounts = new Map(); // 'sand_step:1' → 格数（朝向分布，供验收报告）

  // 逐格映射。按 y→z→x 遍历，保证 palette 首次出现顺序与遍历顺序一致（确定性）
  for (let y = 0; y < SY; y++) {
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const pi = r.blocks[litematicIndex(r.size, x, y, z)];
        // 同一 palette 下标反复 classify 会重复算，但实测 60025 次 classify 是微秒级；
        // 用缓存避免重复 string 正则（也保证 throw 只在我们确实用到该条目时触发）
        let res = classifyCache.get(pi);
        if (res === undefined) {
          res = classify(r.palette[pi], r.paletteProps[pi]);
          classifyCache.set(pi, res);
        }
        if (res === null) continue;

        let tpi = paletteIndex.get(res.block);
        if (tpi === undefined) {
          tpi = palette.length;
          palette.push(res.block);
          paletteIndex.set(res.block, tpi);
        }
        // 归一化：x/z 相对中心，y 从 0 变 1。
        // ⚠️ **第 5 项 direction 必填**（stride=5）：巨型金字塔的 1219 个台阶靠它携带 orient。
        // 只写 4 项会让所有台阶静默按 orient=0（凹口朝东）渲染 —— 与素材里的四坡面朝向全部错位。
        blocks.push(x - OX, y + 1, z - OZ, tpi, res.meta);
        counts.set(res.block, (counts.get(res.block) || 0) + 1);
        if (res.block === 'sand_step') {
          const k = `sand_step:${res.meta}`;
          metaCounts.set(k, (metaCounts.get(k) || 0) + 1);
        }
      }
    }
  }

  // ---- 断言（产物契约，与 check:data 同口径但这里先自守一道）----
  const STRIDE = 5;
  const n = blocks.length / STRIDE;
  if (n !== M.blocks) {
    throw new Error(`方块数 ${n} ≠ PYRAMID_METRICS.blocks ${M.blocks}（源方块改动？先跑 --census 核映射）`);
  }
  if (palette.length !== M.paletteSize) {
    throw new Error(`palette 有 ${palette.length} 种（${palette.join(', ')}）≠ PYRAMID_METRICS.paletteSize ${M.paletteSize}`);
  }
  for (const want of ['sand', 'sand_step', 'sand_slab']) {
    if (!palette.includes(want)) throw new Error(`产物 palette 缺 "${want}"（映射表改坏了？）`);
  }
  const wantCounts = { sand: M.sandCells, sand_step: M.stepCells, sand_slab: M.slabCells };
  for (const [k, v] of Object.entries(wantCounts)) {
    const got = counts.get(k) || 0;
    if (got !== v) throw new Error(`"${k}" 格数 ${got} ≠ PYRAMID_METRICS ${v}`);
  }

  // bbox 与基座：最底层（归一化 y=1）必须是满铺 49×49
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  const baseCols = new Set();
  for (let i = 0; i < blocks.length; i += STRIDE) {
    const bx = blocks[i], by = blocks[i + 1], bz = blocks[i + 2];
    if (bx < mnx) mnx = bx; if (bx > mxx) mxx = bx;
    if (by < mny) mny = by; if (by > mxy) mxy = by;
    if (bz < mnz) mnz = bz; if (bz > mxz) mxz = bz;
    if (by === 1) baseCols.add(`${bx},${bz}`);
  }
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  if (W !== M.width) throw new Error(`宽 ${W} ≠ ${M.width}`);
  if (H !== M.height) throw new Error(`高 ${H} ≠ ${M.height}`);
  if (D !== M.depth) throw new Error(`深 ${D} ≠ ${M.depth}`);
  if (mny !== 1) throw new Error(`最低点 y=${mny} ≠ 1（归一化失败）`);
  if (baseCols.size !== M.baseCells) throw new Error(`基座列数 ${baseCols.size} ≠ ${M.baseCells}`);

  // ---- 写盘 ----
  const json = { version: 2, stride: STRIDE, sourceBlocks: r.totalBlocks, palette, blocks };
  const fp = giantPyramidInputFingerprint();
  const meta = {
    version: 1,
    sourceBlocks: r.totalBlocks,
    regionName: r.regionName,
    width: W, height: H, depth: D,
    blocks: n,
    sandCells: counts.get('sand') || 0,
    stepCells: counts.get('sand_step') || 0,
    slabCells: counts.get('sand_slab') || 0,
    baseCells: baseCols.size,
    paletteSize: palette.length,
    stepOrientationCounts: Object.fromEntries([...metaCounts.entries()].sort()),
    origin: { cx: OX, cz: OZ },
    fingerprints: fp,
  };

  fs.mkdirSync(path.dirname(PYRAMID_JSON), { recursive: true });
  fs.writeFileSync(PYRAMID_JSON, JSON.stringify(json));
  fs.writeFileSync(PYRAMID_META, `${JSON.stringify(meta, null, 2)}\n`);

  const kb = (fs.statSync(PYRAMID_JSON).size / 1024).toFixed(1);
  console.log(`金字塔 JSON ${kb} KB，${n} 格（sand ${meta.sandCells} / sand_step ${meta.stepCells} / sand_slab ${meta.slabCells}），` +
    `${W}×${H}×${D}，palette ${palette.length} 种，基座 ${baseCols.size} 列`);
  console.log(`台阶朝向分布：${JSON.stringify(meta.stepOrientationCounts)}`);
  console.log(`指纹 ${fp.input}`);
}

/** classify 结果缓存（同一 palette 下标只算一次；模块级，bake 单次运行内有效） */
const classifyCache = new Map();

// ---------------------------------------------------------------- 入口

const args = process.argv.slice(2);
if (args.includes('--census')) {
  census();
} else if (args.includes('--census-orient')) {
  await censusOrient();
} else {
  bake();
}
