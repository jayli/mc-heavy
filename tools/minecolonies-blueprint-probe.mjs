// tools/minecolonies-blueprint-probe.mjs — MineColonies 蓝图普查的离线探针（调研报告的可复现依据）
//
// 配套文档：docs/minecolonies-migration-survey.md（§1 容器格式 / §2 构成 / §3 方块缺口 /
// §4 逐分类占位块占比 / §5 附加数据）
// 上游：~/jaylli/minecolonies（GPLv3 代码 + assets/minecolonies/LICENSE = All Rights Reserved）
//
// ⚠️ **这是调研探针，不是生产实现，也不是冻结基线**：
//   · 只读 `.blueprint`（gzip + 未压缩 NBT），不解 mod 语义、不查 minecolonies 的 Java 类型；
//   · 「mc-heavy 能表达」= 直接同名 ∪ 手写短名映射表（`RENAME`），后者是人工核对的**近似**，
//     不是形式化等价 —— 例如 `grass_block → swamp_grass` 只是「本仓有一个草方块可用」；
//   · 占位块（`structurize:blocksubstitution`）的最终材料由上游的建筑配置决定，**不在仓库里**
//     ⇒ 本文关于它的所有数字都只是「量」，不含「它该变成什么」；
//   ⇒ 输出的绝对数值是**数量级依据**。落地实现须重测并按 Tier 2/Tier 4 钉住。
//
// 用法：node tools/minecolonies-blueprint-probe.mjs [blueprintsRoot] [--json]
// 默认 root = ~/jaylli/minecolonies/src/main/resources/blueprints/minecolonies
// 只读：不写任何文件、不改世界、不依赖 three / DOM。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEFAULT_BP = path.join(os.homedir(), 'jaylli/minecolonies/src/main/resources/blueprints/minecolonies');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const bpRoot = argv.find((a) => !a.startsWith('--')) || DEFAULT_BP;

// ---------------------------------------------------------------- NBT（tag 1~12）

/**
 * 解析一份已 gunzip 的 NBT buffer，返回根复合标签。
 * `.blueprint` 的根是 TAG_Compound，顶层键见 §1 的表。
 */
function parseNbt(buf, wantRaw = false) {
  let p = 0;
  const str = () => { const n = buf.readUInt16BE(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s; };
  function pl(t) {
    switch (t) {
      case 1: return buf[p++];
      case 2: { const v = buf.readInt16BE(p); p += 2; return v; }
      case 3: { const v = buf.readInt32BE(p); p += 4; return v; }
      case 4: { const v = Number(buf.readBigInt64BE(p)); p += 8; return v; }
      case 5: { const v = buf.readFloatBE(p); p += 4; return v; }
      case 6: { const v = buf.readDoubleBE(p); p += 8; return v; }
      case 7: { const n = buf.readInt32BE(p); p += 4 + n; return wantRaw ? buf.subarray(p - n, p) : null; }
      case 8: return str();
      case 9: { const et = buf[p++]; const n = buf.readInt32BE(p); p += 4; const o = []; for (let i = 0; i < n; i++) o.push(pl(et)); return o; }
      case 10: { const o = {}; for (;;) { const t2 = buf[p++]; if (t2 === 0) break; const k = str(); o[k] = pl(t2); } return o; }
      case 11: { const n = buf.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) { a.push(buf.readInt32BE(p)); p += 4; } return a; }
      case 12: { const n = buf.readInt32BE(p); p += 4 + 8 * n; return null; }
      default: throw new Error(`未知 NBT tag ${t} @ ${p}`);
    }
  }
  buf[p++]; str();
  return { root: pl(10), consumed: p, total: buf.length };
}

function readBlueprint(file) {
  const raw = gunzipSync(fs.readFileSync(file));
  const { root, consumed, total } = parseNbt(raw);
  root.__consumed = consumed;
  root.__total = total;
  return root;
}

function walkBp(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir)) {
    const q = path.join(dir, e);
    if (fs.statSync(q).isDirectory()) walkBp(q, base, out);
    else if (e.endsWith('.blueprint')) out.push(q.slice(base.length + 1));
  }
  return out;
}

/**
 * `blocks` 是 int 数组，每 int 打包**两个 15 位调色板下标**（高 16 位在前）。
 * 解包后长度 = `size_x*size_y*size_z`（奇数体积时上游按 `ceil(vol/2)` 存，末位补 0）。
 */
function unpackIndices(blocks) {
  const out = new Array(blocks.length * 2);
  for (let i = 0; i < blocks.length; i++) {
    out[i * 2] = (blocks[i] >>> 16) & 0xffff;
    out[i * 2 + 1] = blocks[i] & 0xffff;
  }
  return out;
}

// ---------------------------------------------------------------- mc-heavy 侧

const blocksDataSrc = fs.readFileSync(path.join(ROOT, 'src/voxel/blocks-data.js'), 'utf8');
const MCH = new Set([...blocksDataSrc.matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1]));

/**
 * mc-heavy 的短名 → 原版名（**人工核对的近似映射，不是形式化等价**）。
 * 只列「本仓确实有一个语义接近的方块」的情况；空数组表示「名字登记了但没有对应方块」。
 */
export const RENAME = Object.freeze({
  planks: ['oak_planks'], wood: ['oak_log'], grass: ['grass_block'], sand_step: ['sandstone_stairs'],
  sand_slab: ['sandstone_slab'], marble: ['quartz_block'], planks_step: ['oak_stairs'],
  planks_step_updown: ['oak_stairs'], cobblestone_step: ['cobblestone_stairs'],
  cobblestone_step_updown: ['cobblestone_stairs'], smooth_stone_1: ['smooth_stone'],
  oak_planks_1: ['oak_planks'], dark_planks: ['dark_oak_planks'], dark_oak: ['dark_oak_log'],
  leaves: ['oak_leaves'], swamp_leaves: ['oak_leaves'], snow_leaves: ['spruce_leaves'],
  flower: ['poppy'], bush_grass: ['short_grass'], glass_block: ['glass'],
  emerald: ['emerald_block'], amethyst: ['amethyst_block'], debris: ['ancient_debris'],
  iron: ['iron_block'], diamond: ['diamond_block'], moss: ['moss_block'],
  hay_bale: ['hay_block'], bookbox: ['bookshelf'], swamp_grass: ['grass_block'],
  stone_diorite: ['diorite'], mossy_stone: ['mossy_cobblestone'], block_of_quartz: ['quartz_block'],
  light_gray_cloth: ['light_gray_wool'], nether_bricks_1: ['nether_bricks'],
  lilypad: ['lily_pad'], white_planks: ['white_wool'], blue_planks: ['blue_wool'],
  green_planks: ['green_wool'],
});
const EXPRESSIBLE = new Set();
for (const n of MCH) {
  if (RENAME[n]) RENAME[n].forEach((m) => EXPRESSIBLE.add(m));
  else EXPRESSIBLE.add(n);
}

/** 几何族：决定 mc-heavy 是否已有对应 TEMPLATES（而不是只缺一张贴图）。 */
function familyOf(n) {
  for (const [suf, fam] of [
    ['_stairs', '楼梯'], ['_slab', '半砖'], ['_wall', '墙'], ['_fence_gate', '栅栏门'],
    ['_fence', '栅栏'], ['_pane', '玻璃板'], ['_trapdoor', '活板门'], ['_door', '门'],
    ['_carpet', '地毯'], ['_bed', '床'], ['_wall_torch', '火把'], ['_torch', '火把'],
    ['_wall_banner', '旗帜'], ['_banner', '旗帜'], ['_wall_sign', '挂牌'], ['_sign', '立牌'],
    ['_candle', '蜡烛'], ['_terracotta', '陶瓦'], ['_concrete', '混凝土'],
    ['_stained_glass', '彩色玻璃'], ['_wool', '羊毛'], ['_log', '原木'],
    ['_planks', '木板'], ['_leaves', '树叶'],
  ]) if (n === suf.slice(1) || n.endsWith(suf)) return fam;
  return '单件';
}

// ---------------------------------------------------------------- 主扫描

const files = fs.existsSync(bpRoot) ? walkBp(bpRoot).sort() : [];
if (!files.length) {
  console.error(`找不到 .blueprint：${bpRoot}`);
  process.exit(1);
}

const R = {
  root: bpRoot,
  files: files.length,
  format: { topKeys: null, exact: 0, ceilOdd: 0, badVolume: 0, intsPerCell: new Set(), maxPalette: 0, maxVolume: 0, badIndex: 0, notGzip: 0, consistent: 0 },
  axis: { teFiles: 0, teTotal: 0, y: 0, x: 0, z: 0, yTot: 0, xTot: 0, zTot: 0, perFileWin: { y: 0, x: 0, z: 0, tie: 0 } },
  ns: new Map(), fam: new Map(), stairShape: new Map(), slabType: new Map(),
  vanillaFiles: new Map(), style: new Map(), cat: new Map(),
  teIds: new Map(), mcBlocks: new Map(), optionalKeys: new Map(),
  clean: [], vols: [], totalCells: 0,
  // 三档分解：① 纯原版调色板 ② 只有 structurize 占位块 ③ 含 domum/colony 方块
  // ⚠️ 这三档**互斥且穷尽**（按 palette 里出现的**命名空间集合**划分），
  // 是「哪些蓝图能立刻烘」这个问题唯一诚实的分解 —— 只报一个总数会把两个数量级的差别藏起来。
  tier: {
    pure: { files: 0, zeroGap: 0, hist: new Map(), list: [] },
    structurize: { files: 0, zeroGap: 0, hist: new Map() },
    otherMod: { files: 0, byStyle: new Map() },
  },
};

for (const rel of files) {
  let nbt;
  try { nbt = readBlueprint(path.join(bpRoot, rel)); } catch { R.format.notGzip++; continue; }

  const { size_x: sx, size_y: sy, size_z: sz } = nbt;
  const vol = sx * sy * sz;
  const nInt = (nbt.blocks || []).length;
  R.format.maxVolume = Math.max(R.format.maxVolume, vol);
  R.format.maxPalette = Math.max(R.format.maxPalette, (nbt.palette || []).length);
  if (!R.format.topKeys) R.format.topKeys = Object.keys(nbt).filter((k) => !k.startsWith('__')).sort();
  R.format.intsPerCell.add((nInt * 2 === vol || vol % 2 === 1) ? 2 : 1);
  if (nInt * 2 === vol) R.format.exact++;
  else if (nInt === Math.ceil(vol / 2) && vol % 2 === 1) R.format.ceilOdd++;
  else R.format.badVolume++;
  if (nbt.__consumed === nbt.__total) R.format.consistent++;
  R.vols.push(vol);

  const pal = nbt.palette || [];
  const indices = unpackIndices(nbt.blocks || []);
  for (const i of indices) if (i >= pal.length && i !== 0) R.format.badIndex++;

  // ---- 轴序判据：tile_entity 的坐标必然落在非空气格上 ----
  // 与几何形状无关（不受「建筑本来就是多部件」干扰），也不受「y=0 层是否地板」影响。
  const tes = (nbt.tile_entities || []).filter((t) => Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.z));
  if (tes.length) {
    R.axis.teFiles++;
    const solidAt = (order, x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null;
      const idx = order === 'y' ? (y * sz + z) * sx + x
        : order === 'x' ? (x * sy + y) * sz + z
          : (z * sy + y) * sx + x;
      if (idx >= indices.length) return null;
      const e = pal[indices[idx]];
      return e && e.Name && e.Name !== 'minecraft:air' ? 1 : 0;
    };
    const score = { y: 0, x: 0, z: 0 };
    for (const t of tes) {
      R.axis.teTotal++;
      for (const o of ['y', 'x', 'z']) {
        const v = solidAt(o, t.x, t.y, t.z);
        if (v === null) continue;
        R.axis[`${o}Tot`]++;
        if (v) { R.axis[o]++; score[o]++; }
      }
    }
    const best = Math.max(score.y, score.x, score.z);
    const win = ['y', 'x', 'z'].filter((o) => score[o] === best);
    if (win.length === 1) R.axis.perFileWin[win[0]]++; else R.axis.perFileWin.tie++;
  }

  // ---- 构成普查 ----
  const bag = new Map();
  for (const i of indices) bag.set(i, (bag.get(i) || 0) + 1);
  const names = new Set();
  let cells = 0, modded = 0;
  for (const [i, c] of bag) {
    const e = pal[i]; if (!e) continue;
    const nm = (e.Name || '').replace(/^minecraft:/, '');
    if (!nm || nm === 'air') continue;
    cells += c; R.totalCells += c;
    const ns = e.Name.includes(':') ? e.Name.split(':')[0] : 'minecraft';
    R.ns.set(ns, (R.ns.get(ns) || 0) + c);
    if (ns !== 'minecraft' && ns !== 'structurize') modded++;
    const fam = ns === 'minecraft' ? familyOf(nm) : (ns === 'structurize' ? 'structurize 占位块' : `其他 mod（${ns}）`);
    R.fam.set(fam, (R.fam.get(fam) || 0) + c);
    names.add(nm);
    if (ns === 'minecraft') {
      R.vanillaFiles.set(nm, (R.vanillaFiles.get(nm) || 0) + 1);
      if (nm.endsWith('_stairs')) {
        const k = `${e.Properties?.half || '?'}/${e.Properties?.shape || '?'}`;
        R.stairShape.set(k, (R.stairShape.get(k) || 0) + c);
      }
      if (nm.endsWith('_slab') && e.Properties?.type) R.slabType.set(e.Properties.type, (R.slabType.get(e.Properties.type) || 0) + c);
    }
  }
  for (const te of nbt.tile_entities || []) R.teIds.set(te.id, (R.teIds.get(te.id) || 0) + 1);
  for (const e of pal) if ((e.Name || '').startsWith('minecolonies:')) R.mcBlocks.set(e.Name, (R.mcBlocks.get(e.Name) || 0) + 1);
  for (const k of Object.keys(nbt.optional_data || {})) R.optionalKeys.set(k, (R.optionalKeys.get(k) || 0) + 1);

  // ---- 逐风格 / 逐分类 ----
  const parts = rel.split('/');
  const style = parts[0];
  const cat = parts.slice(1, -1).join('/') || '(root)';
  const vanilla = [...names].filter((n) => !n.includes(':'));
  const miss = vanilla.filter((n) => !EXPRESSIBLE.has(n));
  const bump = (map, key) => {
    const a = map.get(key) || { files: 0, types: new Set(), miss: new Set(), cells: 0, subst: 0, vol: 0 };
    a.files++; a.cells += cells; a.vol += vol;
    for (const n of vanilla) { a.types.add(n); if (!EXPRESSIBLE.has(n)) a.miss.add(n); }
    for (const [i, c] of bag) if ((pal[i]?.Name || '').startsWith('structurize:')) a.subst += c;
    map.set(key, a);
    return a;
  };
  bump(R.style, style);
  bump(R.cat, cat);

  // ---- 三档分解（按 palette 的命名空间集合）----
  const nsSet = new Set();
  for (const e of pal) {
    const full = e.Name || '';
    if (!full || full === 'minecraft:air') continue;
    nsSet.add(full.includes(':') ? full.split(':')[0] : 'minecraft');
  }
  if (nsSet.size === 1) {
    const t = R.tier.pure;
    t.files++;
    t.hist.set(miss.length, (t.hist.get(miss.length) || 0) + 1);
    if (!miss.length) { t.zeroGap++; t.list.push(rel); }
  } else if (nsSet.size === 2 && nsSet.has('structurize')) {
    const t = R.tier.structurize;
    t.files++;
    t.hist.set(miss.length, (t.hist.get(miss.length) || 0) + 1);
    if (!miss.length) t.zeroGap++;
  } else {
    const t = R.tier.otherMod;
    t.files++;
    t.byStyle.set(style, (t.byStyle.get(style) || 0) + 1);
  }

  // ---- 「最干净」名单：小体量 ∧ 零其他 mod 依赖 ∧ 原版方块全部可表达 ----
  if (vol <= 2000 && modded === 0 && vanilla.length && !miss.length) {
    R.clean.push({ rel, vol, size: `${sx}×${sy}×${sz}`, types: vanilla.length });
  }
}

// ---------------------------------------------------------------- 输出

const pct = (a, b) => `${(b ? (a / b * 100) : 0).toFixed(1)}%`;
const rows = (map, total, fmt = (k) => k) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ k: fmt(k), c, pct: pct(c, total) }));
const q = (p) => { const s = [...R.vols].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };

if (AS_JSON) {
  console.log(JSON.stringify({
    files: R.files,
    format: { ...R.format, intsPerCell: [...R.format.intsPerCell] },
    axis: { ...R.axis, hitRate: { y: pct(R.axis.y, R.axis.yTot), x: pct(R.axis.x, R.axis.xTot), z: pct(R.axis.z, R.axis.zTot) } },
    namespace: rows(R.ns, R.totalCells),
    family: rows(R.fam, R.totalCells),
    stairShape: rows(R.stairShape, [...R.stairShape.values()].reduce((a, b) => a + b, 0)),
    slabType: rows(R.slabType, [...R.slabType.values()].reduce((a, b) => a + b, 0)),
    style: [...R.style.entries()].sort((a, b) => b[1].files - a[1].files).map(([k, a]) => ({ style: k, files: a.files, types: a.types.size, miss: a.miss.size })),
    category: [...R.cat.entries()].sort((a, b) => a[1].subst / a[1].cells - b[1].subst / b[1].cells).map(([k, a]) => ({ cat: k, files: a.files, avgVol: Math.round(a.vol / a.files), subst: pct(a.subst, a.cells), types: a.types.size, miss: a.miss.size })),
    gap: rows(new Map([...R.vanillaFiles].filter(([n]) => !EXPRESSIBLE.has(n))), 1).map((r) => ({ block: r.k, files: R.vanillaFiles.get(r.k), family: familyOf(r.k) })),
    tileEntities: rows(R.teIds, [...R.teIds.values()].reduce((a, b) => a + b, 0)),
    minecoloniesBlocks: rows(R.mcBlocks, 1).map((r) => ({ block: r.k, files: r.c })),
    coverage: { vanillaTypes: R.vanillaFiles.size, expressible: [...R.vanillaFiles.keys()].filter((n) => EXPRESSIBLE.has(n)).length, totalCells: R.totalCells },
    volume: { p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: Math.max(...R.vols) },
    tier: {
      pure: { files: R.tier.pure.files, zeroGap: R.tier.pure.zeroGap, hist: [...R.tier.pure.hist.entries()].sort((a, b) => a[0] - b[0]), list: R.tier.pure.list },
      structurize: { files: R.tier.structurize.files, zeroGap: R.tier.structurize.zeroGap, hist: [...R.tier.structurize.hist.entries()].sort((a, b) => a[0] - b[0]) },
      otherMod: { files: R.tier.otherMod.files, byStyle: [...R.tier.otherMod.byStyle.entries()].sort((a, b) => b[1] - a[1]) },
    },
    clean: R.clean,
  }, null, 1));
  process.exit(0);
}

const L = [];
const P = (s = '') => L.push(s);
const F = R.format;

P(`MineColonies 蓝图普查（root = ${bpRoot}）`);
P(`文件数 ${R.files}   非 gzip ${F.notGzip}`);
P();
P('=== §1 容器格式 ===');
P(`  顶层键: ${(F.topKeys || []).join(', ')}`);
P(`  体积校验: 精确 2格/int = ${F.exact}  奇数体积 ceil   = ${F.ceilOdd}  不符 = ${F.badVolume}`);
P(`  每 int 打包格数: ${[...F.intsPerCell].join('/')}`);
P(`  palette 最大条目 ${F.maxPalette}（15 位下标上限 32768，余量 ${32768 - F.maxPalette}）`);
P(`  单结构最大体积 ${F.maxVolume} 格`);
P(`  越界调色板下标 ${F.badIndex}   解压后逐字节读尽 ${F.consistent}/${R.files}`);
P(`  轴序（tile_entity 落在非空气格上的比例）: y-major ${pct(R.axis.y, R.axis.yTot)}  x-major ${pct(R.axis.x, R.axis.xTot)}  z-major ${pct(R.axis.z, R.axis.zTot)}`);
P(`    逐文件胜出: y=${R.axis.perFileWin.y}  x=${R.axis.perFileWin.x}  z=${R.axis.perFileWin.z}  并列=${R.axis.perFileWin.tie}  （含 tile_entity 的文件 ${R.axis.teFiles}，实体 ${R.axis.teTotal}）`);
P();
P('=== §2 命名空间 / 几何族（按格数加权）===');
for (const r of rows(R.ns, R.totalCells)) P(`  ${r.pct.padStart(6)}  ${r.c.toLocaleString('en-US').padStart(10)}  ${r.k}`);
P('  ---- 几何族 ----');
for (const r of rows(R.fam, R.totalCells)) P(`  ${r.pct.padStart(6)}  ${r.c.toLocaleString('en-US').padStart(10)}  ${r.k}`);
P();
P('=== §2 台阶 half/shape、半砖 type ===');
{
  const tot = [...R.stairShape.values()].reduce((a, b) => a + b, 0);
  for (const r of rows(R.stairShape, tot)) P(`  ${r.pct.padStart(6)}  ${r.k}`);
  P('  ---- 半砖 ----');
  const tot2 = [...R.slabType.values()].reduce((a, b) => a + b, 0);
  for (const r of rows(R.slabType, tot2)) P(`  ${r.pct.padStart(6)}  ${r.k}`);
}
P();
P(`=== §3 方块覆盖率（原版种类 ${R.vanillaFiles.size}）===`);
const exp = [...R.vanillaFiles.keys()].filter((n) => EXPRESSIBLE.has(n));
P(`  mc-heavy 可表达 ${exp.length}  (${pct(exp.length, R.vanillaFiles.size)})   非空气格总数 ${R.totalCells.toLocaleString('en-US')}`);
P('  ---- 缺口 Top 40（按出现在多少个文件里）----');
for (const r of rows(new Map([...R.vanillaFiles].filter(([n]) => !EXPRESSIBLE.has(n))), 1).slice(0, 40))
  P(`  ${String(R.vanillaFiles.get(r.k)).padStart(6)}  ${r.k.padEnd(28)} ${familyOf(r.k)}`);
P();
P('=== §4 逐功能分类（按占位块占比升序；占位块少的先能烘）===');
P('  文件   平均体积  占位块   原版种类  缺口  分类');
for (const [cat, a] of [...R.cat.entries()].sort((x, y) => x[1].subst / x[1].cells - y[1].subst / y[1].cells))
  P(`  ${String(a.files).padStart(4)}  ${String(Math.round(a.vol / a.files)).padStart(8)}  ${pct(a.subst, a.cells).padStart(6)}  ${String(a.types.size).padStart(8)}  ${String(a.miss.size).padStart(4)}  ${cat}`);
P();
P('=== §4 逐风格 ===');
P('  风格               文件  原版种类  mc-heavy缺');
for (const [st, a] of [...R.style.entries()].sort((x, y) => y[1].files - x[1].files))
  P(`  ${st.padEnd(18)} ${String(a.files).padStart(4)}  ${String(a.types.size).padStart(8)}  ${String(a.miss.size).padStart(9)}`);
P();
P(`=== §5 tile_entities（共 ${[...R.teIds.values()].reduce((a, b) => a + b, 0)} 个）===`);
for (const r of rows(R.teIds, [...R.teIds.values()].reduce((a, b) => a + b, 0))) P(`  ${r.pct.padStart(6)}  ${String(r.c).padStart(7)}  ${r.k}`);
P();
P(`=== §5 minecolonies:* 方块（${R.mcBlocks.size} 种）===`);
for (const [n, c] of [...R.mcBlocks.entries()].sort((a, b) => b[1] - a[1])) P(`  ${String(c).padStart(5)} 文件  ${n}`);
P();
P(`=== §4 三档分解（互斥且穷尽）===`);
P(`  ① 纯原版调色板：${R.tier.pure.files} 文件，其中原版方块零缺口 ${R.tier.pure.zeroGap}`);
P(`     缺 N 种分布: ${[...R.tier.pure.hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}种:${v}`).join('  ')}`);
P(`  ② 只有 structurize 占位块：${R.tier.structurize.files} 文件，其中原版方块零缺口 ${R.tier.structurize.zeroGap}`);
P(`     缺 N 种分布（前 10 档）: ${[...R.tier.structurize.hist.entries()].sort((a, b) => a[0] - b[0]).slice(0, 10).map(([k, v]) => `${k}种:${v}`).join('  ')}`);
P(`  ③ 含 domum_ornamentum / minecolonies 方块：${R.tier.otherMod.files} 文件`);
P(`     逐风格: ${[...R.tier.otherMod.byStyle.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`);
P();
P(`=== ① 零缺口的纯原版文件全清单（${R.tier.pure.list.length}）===`);
for (const f of R.tier.pure.list) P(`  ${f}`);
P();
P(`=== §4 最干净起手名单（体积 ≤2000 ∧ 零其他 mod 依赖 ∧ 原版方块全部可表达）共 ${R.clean.length} ===`);
for (const c of R.clean) P(`  ${String(c.vol).padStart(5)}  ${c.size.padEnd(12)} ${String(c.types).padStart(3)}种  ${c.rel}`);
P();
P(`=== 体量分位 ===`);
P(`  p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  p95 ${q(0.95)}  p99 ${q(0.99)}  max ${Math.max(...R.vols)}`);

console.log(L.join('\n'));