// tools/bake-cloudland-kit.mjs — 把 CLOUDLAND 素材烘成四族 35 个结构 JSON
// 用法：npm run tarn → assets/structures/cloudland_{tarn,arch,spire,giant_cloud}_NN.json
//       + assets/structures/cloudland_kit.meta.json（尺寸 + 指纹）
//       node tools/bake-cloudland-kit.mjs --census → 只打印各族分量与源方块普查，不写文件
//
// 流程：gunzip → 最小 NBT 读取（Sponge Schematic v3）→ 剔除 y=0 地板层 → 26 连通分量
//   → 按 **palette 内容**判族（不是按 `.bp` 目录名）→ 族内按格数降序编号
//   → 以水平包围盒中心为原点、y 归一化到 1 → 逐格过 BLOCK_MAP（未命中 throw）
//   → palette 索引压缩 → 写 JSON。
//
// ## 为什么按 palette 判族而不是按 `.bp` 目录名
// `Landscape/` 有 11 个 `.bp` 且恰好对上 11 个 moss 族分量，但 `Cloud/` 只有 8 个 `.bp`
// 而 diorite+snow_block 族有 12 个分量，`ARC/` 有 11 个而灰岩族 5 个 + 紫晶柱族 7 个。
// `.bp` 也不参与烘焙（它只存 BlockCount 元数据 + 缩略图，不含方块数据）。
//
// ## 为什么剔除 y=0 层
// y=0 是素材的地板/道路层（70,099 格 black_terracotta + 2,307 格 dark_oak_planks 等），
// 不属于任何单个结构；不剔除会让 38 个分量连成一片。
//
// ## 为什么未知源方块必须 throw
// `makeColumnSetter` 对未注册名字是**静默 return**（landmarks.js:274）→ 那格变 air，
// 方块层面完全看不出是映射错了。所以映射缺失必须在烘焙期炸掉。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import {
  SCHEM_PATH, KIT_JSON_DIR, KIT_META, BLOCK_MAP, KIT_METRICS, KIT_VARIANTS,
  cloudlandKitInputFingerprint,
} from './cloudland-kit-fingerprint.mjs';
import { NbtReader } from './nbt-reader.mjs';

/** y=0 是素材的地板/道路层，不属于任何单个结构（见文件头） */
const GROUND_LAYER_Y = 0;

/** 拱洞族的碎屑门：格数 < 600 的分量（13 / 5 / 1）烘出来只是噪声 */
const ARCH_MIN_BLOCKS = 600;

/** 族 → 产物基名前缀（`KIT_VARIANTS` 的顺序与文件名都从这里派生） */
const FAMILY_PREFIX = Object.freeze({
  tarn: 'cloudland_tarn',
  arch: 'cloudland_arch',
  spire: 'cloudland_spire',
  giantCloud: 'cloudland_giant_cloud',
});

// ---------------------------------------------------------------- .schem 读取

function loadSchematic() {
  const root = (() => {
    const r = new NbtReader(zlib.gunzipSync(fs.readFileSync(SCHEM_PATH)));
    const t = r.u1();
    r.str();
    return r.payload(t);
  })();
  const S = root.Schematic || root;
  const { Width: W, Height: H, Length: L } = S;
  // Sponge v2/v3 的字段名有两种：v3 用 Blocks.Palette / Blocks.Data，v2 用 Palette / BlockData
  const paletteSrc = S.Blocks ? S.Blocks.Palette : S.Palette;
  const dataSrc = S.Blocks ? S.Blocks.Data : S.BlockData;
  const pal = [];
  for (const [name, id] of Object.entries(paletteSrc)) {
    pal[id] = name.replace('minecraft:', '').split('[')[0];
  }
  const data = dataSrc;
  const blocks = new Uint16Array(W * H * L);
  let p = 0, n = 0;
  while (p < data.length) {
    let v = 0, sh = 0, b;
    do { b = data[p++]; v |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
    blocks[n++] = v;
  }
  if (n !== W * H * L) throw new Error(`Data 长度 ${n} ≠ ${W}×${H}×${L}`);
  const s = { W, H, L, pal, blocks, paletteEntryCount: Object.keys(paletteSrc).length };
  assertIndexZeroIsAir(s);
  return s;
}

/**
 * palette 索引 0 必须是 `air`。
 *
 * ⚠️ 这不是格式化洁癖：`connectedComponents()` 把 `blocks[i] !== 0` **直接**当「实心」用
 * （`solid` 就是索引真值），而那个假设成立的全部依据就是本条。素材被换成「索引 0 不是
 * 空气」的那天，整层空气会被当实心 → 38 个分量并成一个巨型分量 → **35 个产物被就地覆盖**，
 * 而脚本只会打印一条「与固化值不一致」的警告、照常写盘（静默）。故硬断言、且越早越好。
 * @param {{pal: string[]}} s
 */
function assertIndexZeroIsAir(s) {
  if (s.pal[0] !== 'air') {
    throw new Error(`palette 索引 0 是 "${s.pal[0]}" 而不是 air —— 连通分量把索引 0 当空气，`
      + '继续跑会把整层空气当实心（38 个分量并成 1 个）并覆盖全部产物；请确认素材格式');
  }
}

// ---------------------------------------------------------------- 连通分量（26 邻接）

/**
 * 对 y ≥ 1 的实心格做 26 连通分量。返回每个分量的 {cells, x0..z1, n}。
 * 26 邻接（含对角）而非 6：素材里的岩石结构靠角相连（只走正交会把它切成碎块）。
 */
function connectedComponents(s) {
  const { W, H, L } = s;
  const N = W * H * L;
  const solid = new Uint8Array(N);
  for (let y = GROUND_LAYER_Y + 1; y < H; y++) {
    const base = y * L * W;
    solid.set(s.blocks.subarray(base, base + L * W), base);
  }
  const seen = new Uint8Array(N);
  const comps = [];
  const stack = [];
  for (let i = 0; i < N; i++) {
    if (!solid[i] || seen[i]) continue;
    seen[i] = 1;
    stack.push(i);
    const cells = [];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const y = Math.floor(c / (W * L));
      const r = c - y * W * L;
      const z = Math.floor(r / W);
      const x = r - z * W;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny <= GROUND_LAYER_Y || ny >= H) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= L) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= W) continue;
            const j = (ny * L + nz) * W + nx;
            if (solid[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
          }
        }
      }
    }
    comps.push({ cells, n: cells.length, x0, x1, y0, y1, z0, z1 });
  }
  return comps;
}

// ---------------------------------------------------------------- 判族

/** 分量用到的源方块名集合（按 palette 判族，不看 `.bp` 目录名） */
function paletteNamesOf(s, comp) {
  const set = new Set();
  for (const c of comp.cells) set.add(s.pal[s.blocks[c]]);
  return set;
}

/**
 * 四族判定（设计文档 §2.2）。顺序是载荷性的：高台先判（只有它含 moss_block），
 * 巨型云次之（diorite + snow_block 是它的签名），紫晶柱第三（紫色系 / light_blue_terracotta /
 * chorus_plant），剩下的灰岩结构归拱洞族。
 * @param {Set<string>} names
 * @returns {'tarn'|'arch'|'spire'|'giantCloud'}
 */
function familyOf(names) {
  if (names.has('moss_block')) return 'tarn';
  if (names.has('diorite') && names.has('snow_block')) return 'giantCloud';
  for (const n of names) {
    if (n.includes('purple') || n === 'light_blue_terracotta' || n === 'chorus_plant') return 'spire';
  }
  return 'arch';
}

/** 族内按格数降序排序（顺序必须固定，产物文件名与顺序绑定） */
function sortByBlocksDesc(a, b) {
  if (b.n !== a.n) return b.n - a.n;
  // 同格数时用几何坐标兜底，保证跨运行稳定（不依赖 Map/遍历顺序）
  return (a.y0 - b.y0) || (a.x0 - b.x0) || (a.z0 - b.z0) || (a.x1 - b.x1);
}

/** 跑一遍「加载 → 分量 → 判族 → 排序」，返回四族的分量数组（census 与烘焙共用） */
function classify() {
  const s = loadSchematic();
  const comps = connectedComponents(s);
  const groups = { tarn: [], arch: [], spire: [], giantCloud: [] };
  const droppedArch = [];
  for (const comp of comps) {
    const family = familyOf(paletteNamesOf(s, comp));
    if (family === 'arch' && comp.n < ARCH_MIN_BLOCKS) {
      droppedArch.push(comp);
      continue;
    }
    groups[family].push(comp);
  }
  for (const key of Object.keys(groups)) groups[key].sort(sortByBlocksDesc);
  return { s, comps, groups, droppedArch };
}

/** 产物基名：族内序号从 1 起、两位补零（`cloudland_tarn_01` …） */
function variantName(family, index) {
  return `${FAMILY_PREFIX[family]}_${String(index + 1).padStart(2, '0')}`;
}

/** 尺寸（宽×高×深） */
function bboxOf(comp) {
  return {
    width: comp.x1 - comp.x0 + 1,
    height: comp.y1 - comp.y0 + 1,
    depth: comp.z1 - comp.z0 + 1,
  };
}

// ---------------------------------------------------------------- 普查模式

function census() {
  const { s, comps, groups, droppedArch } = classify();
  console.log(`.schem ${s.W}×${s.H}×${s.L}，palette ${s.paletteEntryCount} 条（剥前缀/属性后 ${new Set(s.pal).size} 种，含 air）`);
  console.log(`剔除 y=0 后的连通分量 ${comps.length} 个\n`);

  for (const [family, list] of Object.entries(groups)) {
    const total = list.reduce((acc, c) => acc + c.n, 0);
    console.log(`=== ${family}：${list.length} 个分量，合计 ${total} 格 ===`);
    for (const comp of list) {
      const b = bboxOf(comp);
      console.log(`  ${String(comp.n).padStart(6)} 格  ${b.width}×${b.height}×${b.depth}`
        + `  bbox x[${comp.x0},${comp.x1}] y[${comp.y0},${comp.y1}] z[${comp.z0},${comp.z1}]`);
    }
    // 族内源方块汇总（映射表的唯一事实来源：不凭规格表猜名字）
    const agg = new Map();
    for (const comp of list) {
      for (const c of comp.cells) {
        const name = s.pal[s.blocks[c]];
        agg.set(name, (agg.get(name) ?? 0) + 1);
      }
    }
    const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  源方块 ${sorted.length} 种：`);
    for (const [name, n] of sorted) {
      const mapped = BLOCK_MAP[name];
      console.log(`    ${String(n).padStart(6)}  ${name.padEnd(30)} → ${mapped ?? '【未映射】'}`);
    }
    console.log('');
  }

  if (droppedArch.length) {
    console.log(`拱洞族丢弃碎屑 ${droppedArch.length} 个：${droppedArch.map((c) => c.n).join(' / ')}`);
  }

  assertFullPaletteCoverage(s, groups, droppedArch);
}

// ---------------------------------------------------------------- 覆盖断言

/**
 * palette 里**不进产物**的源名白名单。
 *
 * 每条都带一个可机械验证的类别，`assertFullPaletteCoverage` 会逐条重测
 * （白名单说荒就 throw）—— 白名单不能变成掩盖真缺口的垃圾桶。
 *
 * ⚠️ 这是**审计口径**而非放宽判据：真正拦「换素材后未知名字」的闸门是
 * ①「四族并集必须 100% 映射」与 ② 烘焙循环里的逐格 throw，两者都是硬失败。
 */
const NON_CONSUMED_NAMES = Object.freeze({
  air: { kind: 'air', why: '索引 0 已被 `assertIndexZeroIsAir` 断言为 air（连通分量把索引 0 当空气）' },
  dark_oak_planks: { kind: 'y0', why: '只在 y=0 地板层，y=0 已整层剔除（见文件头）' },
  polished_granite: { kind: 'y0', why: '只在 y=0 地板层，同上' },
  glass: { kind: 'dropped', why: '只在拱洞族的丢弃碎屑里（格数 < 600 的分量不烘）' },
});

/**
 * 覆盖检查两段：① **四族并集必须 100% 映射**（硬闸门，throw）
 * ② palette 全集逐个审计并打印覆盖率，且白名单里每条理由都实测复核。
 */
function assertFullPaletteCoverage(s, groups, droppedArch) {
  // ① 硬闸门：真会被写进产物的每一个源名都必须有映射
  const consumed = new Set();
  for (const list of Object.values(groups)) {
    for (const comp of list) for (const n of paletteNamesOf(s, comp)) consumed.add(n);
  }
  const missingConsumed = [...consumed].filter((n) => !BLOCK_MAP[n]).sort();
  if (missingConsumed.length) {
    throw new Error(`四族有 ${missingConsumed.length} 个源名未映射：${missingConsumed.join(', ')} —— 补 BLOCK_MAP 后重跑`);
  }

  // ② 全集审计：palette 里每个剥过前缀/属性的名字都要有归属（映射 或 白名单）
  const all = [...new Set(s.pal)].sort();
  const missing = all.filter((n) => !BLOCK_MAP[n] && !(n in NON_CONSUMED_NAMES));
  console.log(`palette 全量覆盖：${all.length - missing.length}/${all.length} 源名有归属`
    + `（四族并集 ${consumed.size}/${consumed.size} 已映射）`);
  const nonConsumed = all.filter((n) => !BLOCK_MAP[n]).sort();
  if (nonConsumed.length) {
    console.log(`  不进产物的 ${nonConsumed.length} 个：`
      + nonConsumed.map((n) => `${n}（${NON_CONSUMED_NAMES[n].why}）`).join('；'));
  }
  if (missing.length) {
    throw new Error(`palette 有 ${missing.length} 个源名既未映射也未列入白名单：${missing.join(', ')}`
      + ' —— 补 BLOCK_MAP（不要静默跳过）');
  }

  // ③ 白名单的每条理由都必须与实测一致（否则白名单就是在掩盖一个真缺口）
  const stale = [...consumed].filter((n) => n in NON_CONSUMED_NAMES);
  if (stale.length) {
    throw new Error(`NON_CONSUMED_NAMES 里的 ${stale.join(', ')} 实际出现在四族产物里 —— 白名单失效`);
  }
  const aboveGround = new Map();
  for (let y = GROUND_LAYER_Y + 1; y < s.H; y++) {
    const base = y * s.L * s.W;
    for (let i = base; i < base + s.L * s.W; i++) {
      const n = s.pal[s.blocks[i]];
      aboveGround.set(n, (aboveGround.get(n) ?? 0) + 1);
    }
  }
  const droppedNames = new Set();
  for (const comp of droppedArch) for (const n of paletteNamesOf(s, comp)) droppedNames.add(n);
  for (const [name, entry] of Object.entries(NON_CONSUMED_NAMES)) {
    const above = aboveGround.get(name) ?? 0;
    // `air` 的契约是「索引 0 是空气」。`loadSchematic` 已查过一次（尽早失败），
    // 这里重查一遍是为了让**白名单表自己能独立失败** —— 将来若有别的入口构造 s
    // （如测试直接拼对象）而不经过 `loadSchematic`，这张表依旧是有效闸门。
    if (entry.kind === 'air') assertIndexZeroIsAir(s);
    if (entry.kind === 'y0' && above !== 0) {
      throw new Error(`白名单声称 "${name}" 只在 y=0 地板层，实测 y≥1 有 ${above} 格 —— 它会被烤进产物却没映射`);
    }
    if (entry.kind === 'dropped' && !droppedNames.has(name)) {
      throw new Error(`白名单声称 "${name}" 只在丢弃碎屑里，实测它不在任何碎屑分量里（y≥1 共 ${above} 格）—— 白名单失效`);
    }
  }
}

// ---------------------------------------------------------------- 烘焙

/**
 * 「腰部以上裸露的石头」要换成 `cloud` 的源材料集合。
 *
 * 用户 2026-10-29：「云的腰部以上**裸露的石头方块**都换成云朵方块（cloud），
 * **雪方块和 sky_stone 方块还保持不变**」。
 *
 * - `stone` / `marble` / `stone_diorite` / `smooth_stone` / `smooth_stone_1` / `calcite`
 *   = 岩石类（视觉上是「石头」）
 * - **不含** `snow`（用户明说保持不变）
 * - **不含** `sky_stone`（用户明说保持不变；它是云族的专用石材）
 * - **不含** `deepslate`（它整朵云都换 clay，见 `CLOUD_TO_CLAY`）
 * - **不含** `light_gray_cloth`（v1.94 的浅灰布，属装饰件不是「裸露岩石」）
 * - **不含** `clay`（同上：它是被换进来的目标，再换成 cloud 会让 deepslate 那批消失）
 */
const CLOUD_STONE_ABOVE_WAIST = new Set([
  'stone', 'marble', 'stone_diorite', 'smooth_stone', 'smooth_stone_1', 'calcite',
]);

/**
 * 巨型云的材料改写（用户 2026-10-29）。
 *
 * ## 两条规则
 *
 * | 条件 | 结果 |
 * |---|---|
 * | 源材料是 `deepslate` | → `clay`（**整朵云**，不看高度） |
 * | 源材料是 `debris`（v1.95：碎石，源方块 `gravel`） | → `sky_stone`（**整朵云**，不看高度） |
 * | 源材料是岩石类 **且** `by > waistY` | → `cloud`（腰部以上裸露的石头） |
 * | `snow` / `sky_stone` | **保持不变**（用户明确要求） |
 * | 其余 | 原样 |
 *
 * ## 「裸露」的判据
 *
 * 就是 `by > waistY`（腰部以上）。**不是**「四周有空气」那种表面判据 ——
 * 云朵是实心蘑菇形体，内部格在游戏里根本看不见；按表面判据会把内部
 * 岩石留在那里，观感是「云里埋着一块块石头」（玩家挖进去才看得见）。
 * 用户说的「裸露」= 「腰部以上看得见的那些」，按高度一刀切正是这个意思。
 *
 * ⚠️ **只作用于 `giantCloud` 族**（调用点按 `family` 分流）：
 * `deepslate` 同时是高台主体的主材（17.1%），全局改写会毁掉高台。
 *
 * ⚠️ **`debris` 走这里而不是改 `BLOCK_MAP` 的 `gravel → debris` 那条映射**：
 * 实测 `debris` 当前只出现在云族（12 个产物 / 638 格，tarn/arch/spire 全 0），
 * 改映射表在效果上等价；但映射表是**四族共用**的，将来别族用到 `gravel` 时
 * 会跟着变成 `sky_stone` —— 而 `sky_stone` 是云族的专用石材（`solid=true`、
 * 属「天空」语义），落在地面族上不合语义。放在族内分流里就不会有这个问题。
 *
 * @param {string} name 映射后的目标方块名
 * @param {number} by 归一化层高（最低层 = 1）
 * @param {number} waistY 该朵云的腰线层（最宽层）
 * @returns {string}
 */
function restyleCloud(name, by, waistY) {
  if (name === 'deepslate') return 'clay';
  if (name === 'debris') return 'sky_stone';   // v1.95：整朵云，不看高度
  if (by > waistY && CLOUD_STONE_ABOVE_WAIST.has(name)) return 'cloud';
  return name;
}

function bake() {
  const { s, groups, droppedArch } = classify();
  console.log(`高台 ${groups.tarn.length} 个 / 拱洞 ${groups.arch.length} 个 / `
    + `紫晶柱 ${groups.spire.length} 个 / 巨型云 ${groups.giantCloud.length} 个`
    + `（丢弃碎屑 ${droppedArch.length} 个：${droppedArch.map((c) => c.n).join(' / ')}）\n`);

  assertFullPaletteCoverage(s, groups, droppedArch);

  const metrics = {};
  const variants = { tarn: [], arch: [], spire: [], giantCloud: [] };
  let grandTotal = 0;
  const produced = [];

  for (const [family, list] of Object.entries(groups)) {
    list.forEach((comp, index) => {
      const base = variantName(family, index);
      // 以**水平包围盒中心**为原点（落点的 wx/wz 就是结构的水平中心，光栅化不必再做偏移换算）
      const OX = comp.x0 + Math.floor((comp.x1 - comp.x0) / 2);
      const OZ = comp.z0 + Math.floor((comp.z1 - comp.z0) / 2);

      const palette = [];
      const paletteIndex = new Map();
      const blocks = [];
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
      // 巨型云的材料改写需要**先知道腰线**（最宽层），所以先收集行、后统一过 `restyleCloud`。
      // 其余三族走原路径（`cloudWaistY = -1` 时 `restyleCloud` 恒等返回）。
      const isCloud = family === 'giantCloud';
      const rows = isCloud ? [] : null;
      for (const c of comp.cells) {
        const y = Math.floor(c / (s.W * s.L));
        const r = c - y * s.W * s.L;
        const z = Math.floor(r / s.W);
        const x = r - z * s.W;
        const srcName = s.pal[s.blocks[c]];
        const target = BLOCK_MAP[srcName];
        // 未知源方块必须 throw（静默跳过会让那格变 air，方块层面看不出是映射错了）
        if (!target) throw new Error(`${base}：源方块 "${srcName}" 不在 BLOCK_MAP 里 —— 补映射后重跑`);
        // y 相对最低层后 +1（既有结构 JSON 的约定：最低点归一化为 y=1）
        const by = y - comp.y0 + 1;
        if (isCloud) { rows.push({ bx: x - OX, by, bz: z - OZ, name: target }); continue; }
        let pi = paletteIndex.get(target);
        if (pi === undefined) { pi = palette.length; palette.push(target); paletteIndex.set(target, pi); }
        blocks.push(x - OX, by, z - OZ, pi);
        if (x - OX < mnx) mnx = x - OX;
        if (x - OX > mxx) mxx = x - OX;
        if (by < mny) mny = by;
        if (by > mxy) mxy = by;
        if (z - OZ < mnz) mnz = z - OZ;
        if (z - OZ > mxz) mxz = z - OZ;
      }

      if (isCloud) {
        // 腰线 = 该朵云**最宽的那一层**（蘑菇伞的下沿）。用户 2026-10-29 裁定：
        // 「腰线用最宽层，石头换成 cloud」。
        // 同面积时取**较低**的那层（`>=` 只在更宽时更新，故首次出现的最大层胜出）——
        // 小云（高 6）腰部以下只剩基础一两层，取低层不会把整朵云判成「腰部以上」。
        const widthAt = new Map();
        for (const row of rows) widthAt.set(row.by, (widthAt.get(row.by) ?? 0) + 1);
        let waistY = 1, waistW = -1;
        for (const [y, n] of [...widthAt].sort((a, b) => a[0] - b[0])) {
          if (n > waistW) { waistW = n; waistY = y; }
        }
        for (const row of rows) {
          const target = restyleCloud(row.name, row.by, waistY);
          let pi = paletteIndex.get(target);
          if (pi === undefined) { pi = palette.length; palette.push(target); paletteIndex.set(target, pi); }
          blocks.push(row.bx, row.by, row.bz, pi);
          if (row.bx < mnx) mnx = row.bx;
          if (row.bx > mxx) mxx = row.bx;
          if (row.by < mny) mny = row.by;
          if (row.by > mxy) mxy = row.by;
          if (row.bz < mnz) mnz = row.bz;
          if (row.bz > mxz) mxz = row.bz;
        }
      }

      const n = blocks.length / 4;
      const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
      // 归一化断言：最低点必须是 y=1
      if (mny !== 1) throw new Error(`${base}：最低点 y=${mny} ≠ 1（归一化失败）`);
      // 尺寸断言：产物 bbox 必须与源分量 bbox 一致（防原点算错导致整体偏移）
      const src = bboxOf(comp);
      if (W !== src.width || H !== src.height || D !== src.depth) {
        throw new Error(`${base}：产物 bbox ${W}×${H}×${D} ≠ 源分量 ${src.width}×${src.height}×${src.depth}`);
      }
      for (const name of palette) {
        if (name.includes('minecraft:') || name.includes('[')) {
          throw new Error(`${base}：palette 含未剥净的方块名 "${name}"`);
        }
      }

      const file = path.join(KIT_JSON_DIR, `${base}.json`);
      // 台顶材质自检（用户 2026-10-26 裁定：moss → grass）。
      // 放在写盘**之前**而不是整个 bake() 末尾：放末尾的话产物已落地，
      // 「忘了改四个 moss 源名」这类回归会留下 11 个坏产物再抛错（下一次任务读到旧文件）。
      if (family === 'tarn') assertTarnTopIsGrass(base, palette);
      fs.writeFileSync(file, JSON.stringify({ version: 1, palette, blocks }));
      metrics[base] = { width: W, height: H, depth: D, blocks: n };
      variants[family].push(base);
      grandTotal += n;
      produced.push({ base, family, n, W, H, D, paletteSize: palette.length });
    });
  }

  // ---- 与 src/gen/structures/cloudland-kit-data.js 的固化值比对 ----
  // ⚠️ 烘焙脚本**只读**那个文件、绝不写它（生成路径不得改源码）。
  // 首次烘焙时它是空的 → 打印待固化的内容，人工粘贴进去。
  const fresh = { metrics, variants };
  if (!sameAsFixed(fresh)) {
    console.log('\n⚠️ src/gen/structures/cloudland-kit-data.js 里的 KIT_METRICS/KIT_VARIANTS 与本次烘焙不一致。');
    console.log('   请把下面这段固化进该文件（它是纯数据文件，不能由烘焙脚本写入）：\n');
    console.log(formatDataFile(metrics, variants));
  }

  // ---- 逐产物打印 ----
  for (const p of produced) {
    console.log(`${p.base}.json`.padEnd(32) + `${String(p.n).padStart(6)} 格  ${p.W}×${p.H}×${p.D}`.padEnd(22) + ` palette ${p.paletteSize} 种`);
  }

  // ---- 与 brief / spec §2 的实测值交叉核对 ----
  const totals = Object.fromEntries(
    Object.entries(groups).map(([f, list]) => [f, list.reduce((a, c) => a + c.n, 0)]),
  );
  console.log(`\n共 ${produced.length} 个产物，合计 ${grandTotal} 格`);

  // ---- meta（尺寸 + 指纹）----
  const fp = cloudlandKitInputFingerprint();
  const meta = {
    version: 1,
    variants,
    metrics,
    familyTotals: totals,
    totalBlocks: grandTotal,
    fingerprints: fp,
    paletteEntryCount: s.paletteEntryCount,
  };
  fs.writeFileSync(KIT_META, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`指纹 ${fp.input}`);
  console.log(`meta → ${path.relative(process.cwd(), KIT_META)}`);
}

/**
 * 台顶材质断言：11 个高台产物的 palette 必须含 `grass`、不得含 `moss`。
 *
 * 用户 2026-10-26 裁定「高台顶部的方块原来是 moss，现在换成 grass」。四个源名
 * （`moss_block` / `green_terracotta` / `green_wool` / `lime_terracotta`）共 22,926 格，
 * 漏改时方块层面完全看不出错 —— 只有名字级断言能抓。
 * @param {string} base 产物基名
 * @param {string[]} palette 该产物的 palette
 */
function assertTarnTopIsGrass(base, palette) {
  if (palette.includes('moss')) {
    throw new Error(`${base} 的 palette 还含 moss —— moss_block / green_terracotta / `
      + 'green_wool / lime_terracotta 四个源名的映射没改成 grass');
  }
  if (!palette.includes('grass')) {
    throw new Error(`${base} 的 palette 不含 grass —— 台顶没映射到 grass（检查 BLOCK_MAP 的四个苔藓源名）`);
  }
}

/** 当前固化值是否与本次烘焙一致（首次烘焙时固化值是空表 → 返回 false） */
function sameAsFixed({ metrics, variants }) {
  const sameVariants = Object.keys(variants).every(
    (k) => JSON.stringify([...KIT_VARIANTS[k]]) === JSON.stringify(variants[k]),
  );
  const keys = Object.keys(metrics);
  const sameMetrics = keys.length === Object.keys(KIT_METRICS).length
    && keys.every((k) => {
      const a = KIT_METRICS[k];
      const b = metrics[k];
      return a && a.width === b.width && a.height === b.height && a.depth === b.depth && a.blocks === b.blocks;
    });
  return sameVariants && sameMetrics;
}

/** 把烘焙结果格式化成可直接粘贴进 cloudland-kit-data.js 的源码片段 */
function formatDataFile(metrics, variants) {
  const lines = ['export const KIT_METRICS = Object.freeze({'];
  for (const [base, m] of Object.entries(metrics)) {
    lines.push(`  ${base}: { width: ${m.width}, height: ${m.height}, depth: ${m.depth}, blocks: ${m.blocks} },`);
  }
  lines.push('});', '', 'export const KIT_VARIANTS = Object.freeze({');
  for (const [family, list] of Object.entries(variants)) {
    lines.push(`  ${family}: [`);
    lines.push(`    ${list.map((v) => `'${v}'`).join(',\n    ')},`);
    lines.push('  ],');
  }
  lines.push('});');
  return lines.join('\n');
}

// ---------------------------------------------------------------- 入口

const CENSUS = process.argv.includes('--census');
if (CENSUS) {
  census();
} else {
  bake();
}
