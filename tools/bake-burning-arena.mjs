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
// 臂方向 ↔ (方块, 朝向) 的**唯一权威**在 arena.js（从 mesher 的 TEMPLATES 派生，红线 1）。
// ⚠️ 不得在本脚本里手写「orient=1 是 +X-Z」这类朝向表 —— 形状权威改动后这里会自动跟上，
// 手写表则会静默漂移（同 bake-arena.mjs / bake-medieval-ship.mjs 的口径）。
import { railPlacementFor, railArmSet } from '../src/gen/structures/arena.js';

/** 平移原点：x/z 取 85 宽的中心 42（与本仓「锚点 = 宽/2」约定一致） */
const ORIGIN_X = 42;
const ORIGIN_Z = 42;

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
 *
 * ⚠️ export 同 `computeRailOrientations`：验证脚本要拿真实素材跑同一份算法。
 */
export function assemble() {
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

// ---------------------------------------------------------------- 栏杆朝向
//
// ## 为什么需要这一 pass
// 素材的栏杆来自 5 种源方块（`nether_brick_fence` / 三种 `*_wall` / `chain`），`BLOCK_MAP`
// 把它们统一映到 `handrail`。但 `handrail` 是**转角件**（两臂垂直），直排栏杆需要
// `handrailA`（**直段件**，两臂共线）。直查表 ⇒ 3,311 格栏杆全部 meta=0，全渲染成
// +X+Z 转角 —— 方块层面看不出错（格数、类型全对），只有看画面才发现栏杆互相拧着。
//
// ## 判据（用户 2026-11-09 的 200 格手工修正样例反推，实测吻合率见下）
//   · **2 臂** → 共线对给直段件、垂直对给转角件（样例 142/142 吻合）；
//   · **chain** → 直段件（素材里 chain 是吊挂装饰、无连接 props；样例 8/8 吻合）；
//   · **0/1 臂**（占 85%，是垂直堆叠的栏杆柱）→ **整段统一朝向**：同一 (x,z) 柱内
//     y 连续的一截算一段，段内所有格同一个 (方块, 朝向)。逐格独立算会在柱内左右摇摆
//     （实测逐格 85.7% → 段级 92.6%）；
//   · **兜底顺序**：声明的连接 props（Minecraft 权威，权重 2）→ 实际栏杆邻居（权重 1）
//     → 实心邻居（「靠在墙上」的支撑信号）→ 完全孤立时取靠内轴的直段件。
//     用户原话：「如果在边缘位置万一没办法让栏杆的抓手和两边连接，也没关系，
//     尽量让抓手的位置靠内即可」⇒ 单臂时配**朝中心**的垂直臂。
//
// ⚠️ **不新增/删除任何格**：本 pass 只改 (方块名, meta)，格数与包围盒不变。
// ⚠️ **刻意不用 `handrailB`**：其实测臂只伸到 ±0.25（格中心），与邻居在格边界断开
//     → 环上出现看不见的缺口（`test-arena.js` / `test-medieval-ship.js` 已钉住这条约束）。

/** 源方块名 → 臂方向（fence 用 `true/false`，wall 用 `none/low/tall`，两者键名相同） */
const ARM_OF_KEY = Object.freeze({ east: '+X', west: '-X', south: '+Z', north: '-Z' });

/** 四个水平臂方向（与 `railPlacementFor` 吃的方向串同口径） */
const ARMS = Object.freeze(['+X', '-X', '+Z', '-Z']);

/** 臂 → 反向臂 */
const OPPOSITE_ARM = Object.freeze({ '+X': '-X', '-X': '+X', '+Z': '-Z', '-Z': '+Z' });

/** 臂 → 所在轴（共线判定用） */
const axisOf = (arm) => (arm === '+X' || arm === '-X' ? 'X' : 'Z');

/** 水平邻居偏移 */
const DIRS = Object.freeze([['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1]]);

/**
 * 哪些源方块是「栏杆」—— 从 `BLOCK_MAP` 反推（映射到 `handrail` 的就是），不另写一份名单。
 * 将来往 `BLOCK_MAP` 加一种新墙/栅栏，它会自动参与朝向计算。
 */
const RAIL_SOURCES = new Set(
  Object.entries(BLOCK_MAP).filter(([, target]) => target === 'handrail').map(([src]) => src),
);

/** 一个 palette 条目声明的连接臂（`chain` 只有 axis，返回空数组） */
function propsArms(props) {
  const out = [];
  for (const [key, arm] of Object.entries(ARM_OF_KEY)) {
    const v = props[key];
    if (v === 'true' || v === 'low' || v === 'tall') out.push(arm);
  }
  return out;
}

/** 朝竞技场中心的臂（「抓手靠内」的判据）；正中心返回空数组 */
function inwardArms(x, z) {
  const out = [];
  const lx = x - ORIGIN_X, lz = z - ORIGIN_Z;
  if (lx < 0) out.push('+X'); else if (lx > 0) out.push('-X');
  if (lz < 0) out.push('+Z'); else if (lz > 0) out.push('-Z');
  return out;
}

/**
 * 从权重表挑一个 (方块, 朝向)。
 *
 * 优先级：① 共线对 → 直段件（栏杆能首尾相连成排，这是主意图）
 *         ② 垂直对 → 转角件（权重高的臂优先）
 *         ③ 单臂   → 配朝中心的垂直臂（抓手靠内）；中心方向与该臂同轴时退化成直段件
 *
 * @param {{'+X':number,'-X':number,'+Z':number,'-Z':number}} w 臂权重（0 = 无信号）
 * @param {string[]} inward 朝中心的臂
 * @returns {{name:string, orient:number}|null} 全 0 权重返回 null
 */
function pickFromWeights(w, inward) {
  const order = ARMS.filter((a) => w[a] > 0).sort((a, b) => w[b] - w[a] || ARMS.indexOf(a) - ARMS.indexOf(b));
  if (order.length === 0) return null;

  // ① 共线对 → 直段件
  for (const a of order) {
    if (w[OPPOSITE_ARM[a]] > 0) {
      const hit = railPlacementFor([a, OPPOSITE_ARM[a]]);
      if (hit) return hit;
    }
  }
  // ② 垂直对 → 转角件（order 已按权重降序，故先试到的是权重最高的组合）
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      if (axisOf(order[i]) === axisOf(order[j])) continue;
      const hit = railPlacementFor([order[i], order[j]]);
      if (hit) return hit;
    }
  }
  // ③ 单臂：不在这里兜底 —— 调用方要先拿支撑信号配垂直臂（见 computeRailOrientations）
  return null;
}

/**
 * 算出每个栏杆格该用的 (方块, meta)。
 *
 * ⚠️ **export 是为了让验证脚本共用同一份算法**（红线 1）：核对用户修正样例的吻合率时
 * 不得另写一份判据，否则「算法 vs 样例」的比对会变成「两份手写实现互相比对」。
 *
 * @param {Array<{x:number,y:number,z:number,name:string,props:object}>} cells `assemble()` 的输出
 * @returns {Map<string, {block:string, meta:number}>} 键 = `${x},${y},${z}`（组装后绝对坐标）
 */
export function computeRailOrientations(cells) {
  const occupied = new Set();
  const railAt = new Map();
  for (const c of cells) {
    const k = `${c.x},${c.y},${c.z}`;
    occupied.add(k);
    if (RAIL_SOURCES.has(c.name)) railAt.set(k, c);
  }
  const isRail = (x, y, z) => railAt.has(`${x},${y},${z}`);
  const isSolid = (x, y, z) => occupied.has(`${x},${y},${z}`);

  // ① 按 (x,z) 分柱，柱内按 y 连续切段（上下两层竞技场的同名柱会被切开，不会串味）
  const columns = new Map();
  for (const c of railAt.values()) {
    const ck = `${c.x},${c.z}`;
    if (!columns.has(ck)) columns.set(ck, []);
    columns.get(ck).push(c);
  }
  const segments = [];
  for (const arr of columns.values()) {
    arr.sort((a, b) => a.y - b.y);
    let seg = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].y === arr[i - 1].y + 1) seg.push(arr[i]);
      else { segments.push(seg); seg = [arr[i]]; }
    }
    segments.push(seg);
  }

  // ② 逐段定朝向，段内所有格共用
  const out = new Map();
  for (const seg of segments) {
    const head = seg[0];
    const inward = inwardArms(head.x, head.z);

    // chain 段：素材里是吊挂装饰（无连接 props），用户样例统一给 X 轴直段件
    let hit = seg.every((c) => c.name === 'chain') ? railPlacementFor(['+X', '-X']) : null;

    if (!hit) {
      const conn = { '+X': 0, '-X': 0, '+Z': 0, '-Z': 0 };
      const sup = { '+X': 0, '-X': 0, '+Z': 0, '-Z': 0 };
      for (const c of seg) {
        // 声明的连接是 Minecraft 权威（同 bake-medieval-ship.mjs 的口径），权重高于「查邻居」
        for (const arm of propsArms(c.props)) conn[arm] += 2;
        for (const [arm, dx, dz] of DIRS) {
          if (isRail(c.x + dx, c.y, c.z + dz)) conn[arm] += 1;
          if (isSolid(c.x + dx, c.y, c.z + dz)) sup[arm] += 1;
        }
      }
      const connArms = ARMS.filter((a) => conn[a] > 0);
      if (connArms.length === 1) {
        // 单臂柱：唯一连接臂已定，垂直臂的选择顺序是
        //   ① 支撑垂直臂（「靠在墙上」，用户样例实测优先于靠内）
        //   ② 靠内垂直臂（「抓手靠内」）
        //   ③ 退化成直段件
        const a = connArms[0];
        const supPerp = ARMS
          .filter((arm) => sup[arm] > 0 && axisOf(arm) !== axisOf(a))
          .sort((p, q) => sup[q] - sup[p] || ARMS.indexOf(p) - ARMS.indexOf(q));
        if (supPerp.length > 0) hit = railPlacementFor([a, supPerp[0]]);
        if (!hit) {
          for (const inArm of inward) {
            if (axisOf(inArm) === axisOf(a)) continue;
            hit = railPlacementFor([a, inArm]);
            if (hit) break;
          }
        }
        if (!hit) hit = railPlacementFor([a, OPPOSITE_ARM[a]]);
      } else {
        hit = pickFromWeights(conn, inward) || pickFromWeights(sup, inward);
      }
    }

    // 完全孤立（四周全空）→ 靠内轴的直段件；正中心无靠内方向时取 X 轴
    if (!hit) hit = railPlacementFor(inward.some((a) => axisOf(a) === 'Z') ? ['+Z', '-Z'] : ['+X', '-X']);

    for (const c of seg) out.set(`${c.x},${c.y},${c.z}`, { block: hit.name, meta: hit.orient });
  }
  return out;
}

/** 栏杆朝向分布直方图（`handrail:0` → 格数），写进 meta.json 供门禁逐档比对 */
function railOrientationHistogram(cells) {
  const orient = computeRailOrientations(cells);
  const hist = new Map();
  for (const { block, meta } of orient.values()) {
    const k = `${block}:${meta}`;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  return Object.fromEntries([...hist.entries()].sort());
}

/**
 * 「抓手指向空气」统计 —— 用户「尽量让抓手靠内」要求的可量化口径。
 *
 * 臂方向用 `railArmSet`（mesher 派生的唯一权威），不自己推。
 * @returns {{total:number, air:number}} total = 全部栏杆格的臂数（每格 2 臂）
 */
function railArmAirStats(cells) {
  const orient = computeRailOrientations(cells);
  const occupied = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
  let total = 0, air = 0;
  for (const c of cells) {
    const ro = orient.get(`${c.x},${c.y},${c.z}`);
    if (!ro) continue;
    for (const arm of railArmSet(ro.block, ro.meta)) {
      total++;
      const d = DIRS.find(([a]) => a === arm);
      if (!occupied.has(`${c.x + d[1]},${c.y},${c.z + d[2]}`)) air++;
    }
  }
  return { total, air };
}

// ---------------------------------------------------------------- 普查模式

async function census() {
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
  // 通道统计用 registry 的 cullTable（红线 1）。
  // ⚠️ 旧写法是正则扫 blocks-data 源码，名字模式 `[a-z_0-9]+` 匹配不到带大写的
  // `handrailA` → 它被归进 opaque，cutout 少算 1,550 格（格数/类型/指纹全对，静默偏）。
  const { createRegistry } = await import('../src/voxel/block-registry.js');
  const { BLOCKS } = await import('../src/voxel/blocks-data.js');
  const reg = createRegistry();
  for (const d of BLOCKS) reg.register(d.name, d);
  reg.freeze();
  const isCutout = (name) => {
    const id = reg.idOf(name);
    return id !== undefined && reg.cullTable[id] === 1;
  };

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
      if (isCutout(res.block)) cutout += v.count; else opaque += v.count;
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

  // 栏杆朝向普查（与 bake() 同一份算法，红线 1）：看直段件/转角件比例与朝向分布
  const railHist = railOrientationHistogram(cells);
  const railTotal = Object.values(railHist).reduce((a, b) => a + b, 0);
  console.log(`\n栏杆朝向（共 ${railTotal} 格）：`);
  for (const [k, v] of Object.entries(railHist)) console.log(`  ${k.padEnd(16)} ${v}`);
  if (railTotal !== 3311) {
    console.log(`  ✗ 栏杆总格数 ${railTotal} ≠ 3311 —— 朝向 pass 增删了格`);
    process.exitCode = 1;
  }
  // 「抓手指向空气」比例：用户要求「尽量让抓手的位置靠内」，这个比例是它的可量化口径
  const armStats = railArmAirStats(cells);
  console.log(`  抓手指向空气：${armStats.air}/${armStats.total} = ${(100 * armStats.air / armStats.total).toFixed(1)}%` +
    `（用户修正样例区实测 9.0%，全结构含大量孤立柱故偏高）`);

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

  // 栏杆朝向 pass（见文件头「栏杆朝向」节）：只改 (方块, meta)，不增删格
  const railOrient = computeRailOrientations(cells);

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();
  const metaCounts = new Map();
  const railCounts = new Map();

  // 按 y→z→x 排序保证 palette 首次出现顺序确定
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const c of sorted) {
    const ny = c.y - minY + 1;
    let res = classify(c.name, c.props, ny);
    if (res === null) continue;

    // 栏杆格：用朝向 pass 的 (方块, meta) 覆盖 classify 的直查结果（handrail:0）
    const ro = railOrient.get(`${c.x},${c.y},${c.z}`);
    if (ro) {
      if (res.block !== 'handrail') {
        throw new Error(`栏杆朝向 pass 命中了非 handrail 映射：(${c.x},${c.y},${c.z}) ${c.name} → ${res.block}（RAIL_SOURCES 与 BLOCK_MAP 漂移？）`);
      }
      res = ro;
    }

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
    if (res.block === 'handrail' || res.block === 'handrailA') {
      const k = `${res.block}:${res.meta}`;
      railCounts.set(k, (railCounts.get(k) || 0) + 1);
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
    polished_deepslate: 3477, lava: 1179,
    cobblestone_step_updown: 2053, cobblestone_step: 1426,
    polished_blackstone_bricks: 1389, glowstone: 942, deepslate: 540, sand_slab: 504,
    nether_bricks_1: 184, vine: 168, hanging_lamp: 125, gold_block: 37, debris: 4, chest: 1,
  };
  for (const [k, v] of Object.entries(wantCounts)) {
    const got = counts.get(k) || 0;
    if (got !== v) throw new Error(`"${k}" 格数 ${got} ≠ 冻结值 ${v}`);
  }
  // 栏杆：朝向 pass 把 3,311 格拆成 handrail（转角件）+ handrailA（直段件），
  // 各自格数随算法浮动，但**总数不变**（只改朝向不增删格）。
  const railTotal = (counts.get('handrail') || 0) + (counts.get('handrailA') || 0);
  if (railTotal !== 3311) {
    throw new Error(`栏杆格数 handrail+handrailA = ${railTotal} ≠ 3311（朝向 pass 增删了格？）`);
  }
  if (palette.includes('handrailB')) {
    throw new Error('产物含 handrailB —— 它的臂只伸到格中心、接不上邻居，不得用作栏杆件');
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
    railOrientationCounts: Object.fromEntries([...railCounts.entries()].sort()),
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
  console.log(`栏杆朝向分布：${JSON.stringify(meta.railOrientationCounts)}`);
  console.log(`指纹 ${fp.input}`);
}

// ---------------------------------------------------------------- 入口

// ⚠️ 必须判 main module：验证脚本会 import 本文件的 `assemble` / `computeRailOrientations`
// （红线 1：共用同一份算法），不判的话 import 会直接触发 bake()。
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--census')) {
    await census();
  } else if (args.includes('--census-orient')) {
    await censusOrient();
  } else {
    bake();
  }
}
