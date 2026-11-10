// tools/bake-ruined-citadel.mjs — 把 18 片 `.nbt` 素材烘焙成结构 JSON（palette 索引压缩 + 逐格朝向 + 空气格）
// 用法：npm run ruinedcitadel                烘焙 → assets/structures/ruined_citadel.json + .meta.json
//       npm run ruinedcitadel -- --census         只打印源方块普查与本仓映射结果，不写文件
//       npm run ruinedcitadel -- --census-orient  现场重测 orient → 台阶高侧方向（校验 FACING_TO_ORIENT）
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 288,824 格逐字写对象约 22MB；palette 索引压缩后约 3.7MB。`structure-json.js` 的
// `loadStructure` 已支持 `stride: 5` 带逐格朝向的形状（同巨型金字塔 / 大竞技场）。
//
// ## 为什么朝向进 `meta` 而不是进方块名
// 本仓台阶朝向的唯一机制是 `meta` 低 2 位（`mesher.js` 的 `orient = meta & 3` +
// `FACE_ROT`）。若按朝向拆成 4 个方块名，就要在 `blocks-data.js` / `faces-data.js` /
// 图标 / 背包里各增 4 份 —— 而既有 `cobblestone_step` 早已是这个机制，照抄即可。
//
// ## 空气格写进产物（spec DR-2，本结构与大竞技场最大的不同）
// 地牢房间在 nbt 里是**显式空气**。若不写空气，`fillColumn` + `carveCaves` 生成的天然
// 岩层会填满整个 44 层地牢（22.6 万格白搬）。故：
//   · 产物 palette 里加 `"air"` 条目（`air` 已注册且 id=0，`cullMode:'none'` ⇒ 不渲染任何面）；
//   · **甲板以下**（组装 y<0）的空气写进 `blocks`；光栅化时 `setBlock(…,'air')` →
//     `makeColumnSetter` 查 `registry.idOf('air') === 0` → `blocks[idx] = 0` ⇒ 清空格；
//   · **甲板以上**（y≥0）的 230,205 格空气是天空，刻意丢弃（写了 JSON 从 3.7MB 涨到 17MB+）。
// ⚠️ `rasterizeStructure` 不需要改：`air` 只是一个恰好 id=0 的普通 palette 条目。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { NbtReader } from './nbt-reader.mjs';
import {
  RUINED_CITADEL_SOURCE_DIR, RUINED_CITADEL_PIECES, RUINED_CITADEL_JSON, RUINED_CITADEL_META,
  BLOCK_MAP, SLAB_BASE, STAIR_TARGETS, SLAB_BOTTOM, FLOOR_ROW, RUINED_CITADEL_METRICS,
  FACING_TO_ORIENT, ruinedCitadelInputFingerprint,
} from './ruined-citadel-fingerprint.mjs';
// 臂方向 ↔ (方块, 朝向) 的**唯一权威**在 arena.js（从 mesher 的 TEMPLATES 派生，红线 1）。
// ⚠️ 不得在本脚本里手写「orient=1 是 +X-Z」这类朝向表 —— 形状权威改动后这里会自动跟上，
// 手写表则会静默漂移（同 bake-burning-arena.mjs / bake-medieval-ship.mjs 的口径）。
import { railPlacementFor, railArmSet } from '../src/gen/structures/arena.js';

/**
 * 平移原点：结构中心 (17, 18)。
 *
 * 由**非空气**包围盒 x∈[-35,70]、z∈[-35,72] 取中：(-35+70)/2 = 17.5 → 17，
 * (-35+72)/2 = 18.5 → 18（spec §2.2）。与本仓「锚点 = 占地中心」约定一致。
 *
 * ⚠️ 也是栏杆朝向 pass 的 `inwardArms`（「抓手靠内」）的中心。
 */
const ORIGIN_X = 17;
const ORIGIN_Z = 18;

/** 读一片 nbt，返回 root（`{size, palette, blocks}`） */
function readPiece(file) {
  const raw = fs.readFileSync(path.join(RUINED_CITADEL_SOURCE_DIR, file));
  const data = gunzipSync(raw);
  const r = new NbtReader(data);
  r.u1();          // root tag type (10)
  r.str();         // root name
  return r.payload(10);
}

/**
 * 一个 palette 条目 → `{block, meta} | null`；`null` = 丢弃（当作空气，不写进产物）。
 *
 * @param {string} name 剥掉 `minecraft:` 前缀的方块名
 * @param {object} props `Properties` 对象（可能为空对象）
 * @param {number} y **组装后的绝对 y**（空气分层判据用，见下）
 *
 * 未知名字**一律 throw**，不许静默丢弃 —— `makeColumnSetter` 对未注册方块名是静默
 * `return`，那格变 air，而**方块层面完全看不出是映射错了**（v1.80 高台烘焙教训）。
 *
 * ⚠️ **空气分层判据用组装 y 而不是归一化 ny**（spec DR-2 的表述口径）：
 * `y < 0` = 甲板以下 = 地牢内部空间 → 写进产物；`y >= 0` = 甲板以上的天空 → 丢弃。
 * 二者等价（ny = y + 46，故 y<0 ⟺ ny<46 ⟺ ny ≤ FLOOR_ROW(45)），这里用 y 是因为
 * 「甲板以下」在素材坐标里就是 y<0，读代码时不需要先算归一化。
 */
function classify(name, props, y) {
  // ① 空气分层（spec DR-2）：甲板以下写进产物挖出地牢，甲板以上是天空 → 丢弃
  if (name === 'air') {
    return y < 0 ? { block: 'air', meta: 0 } : null;
  }

  // ② 直查映射表（各石材 / 新烘整块 / 光源 / 栏杆 / 藤蔓 / 丢弃项）
  if (Object.prototype.hasOwnProperty.call(BLOCK_MAP, name)) {
    const target = BLOCK_MAP[name];
    return target === '' ? null : { block: target, meta: 0 };
  }

  // ③ 台阶：按**源族**分流（两族有新烘台阶，三族只能映既有石台阶），
  //    朝向取 facing = 高侧（实测）。`half=top` 时 orient +2 mod 4（倒置「颠倒+水平镜像」）。
  //    ⚠️ `shape`（inner/outer，实测 318 格 = 8%）统一按直台阶处理（pyramid/arena 同款裁定）。
  if (/_stairs$/.test(name)) {
    const fam = STAIR_TARGETS[name];
    if (fam === undefined) {
      throw new Error(`台阶 ${name} 未在 STAIR_TARGETS 收录 —— 补表`);
    }
    const facing = props.facing;
    const orient = FACING_TO_ORIENT[facing];
    if (orient === undefined) {
      throw new Error(`台阶 facing 未知：「${facing ?? '(缺失)'}」（源方块 ${name}）—— 补 FACING_TO_ORIENT`);
    }
    if (props.half === 'top') {
      return { block: fam.top, meta: (orient + 2) % 4 };
    }
    return { block: fam.bottom, meta: orient };
  }

  // ④ 半砖：bottom 按族分流（有新烘半砖的用新半砖，其余用 sand_slab）；
  //    top / double → SLAB_BASE 的基础整块（spec DR-4）。
  //    ⚠️ 不得剥 `_slab` 后缀查 BLOCK_MAP（obsidian_brick 单数查不到 obsidian_bricks）。
  if (/_slab$/.test(name)) {
    const type = props.type || 'bottom';
    if (type === 'bottom') {
      const target = SLAB_BOTTOM[name];
      if (target === undefined) {
        throw new Error(`半砖 ${name} 未在 SLAB_BOTTOM 收录 —— 补表`);
      }
      return { block: target, meta: 0 };
    }
    const base = SLAB_BASE[name];
    if (base === undefined) {
      throw new Error(`半砖 ${name} 未在 SLAB_BASE 收录 —— 补表`);
    }
    return { block: base, meta: 0 };   // top / double → 整块
  }

  throw new Error(`未映射的源方块：${name}（补 BLOCK_MAP 或加分类分支后重跑）`);
}

/**
 * 组装 18 片 → 全局坐标格子列表（未映射，原始 name+props+y）。
 * 返回 {cells, minY}，cells 每项 {x, y, z, name, props}（y 为组装后的绝对 y）。
 *
 * ⚠️ **与大竞技场的 `assemble()` 关键不同：不跳过空气**（spec DR-2）。空气格要参与
 * classify 的分层判定，甲板以下的那 27,060 格是挖出地牢房间的唯一手段。
 *
 * ⚠️ export 同 `computeRailOrientations`：验证脚本要拿真实素材跑同一份算法（红线 1）。
 */
export function assemble() {
  const cells = [];
  let minY = Infinity;
  for (const piece of RUINED_CITADEL_PIECES) {
    const root = readPiece(piece.file);
    const palette = root.palette || [];
    for (const b of root.blocks || []) {
      const entry = palette[b.state];
      const rawName = entry.Name || '';
      const name = rawName.replace(/^minecraft:/, '');
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
// 素材的栏杆来自 4 种源方块（`cataclysm:obsidian_brick_wall` 350 / `end_stone_brick_wall` 215 /
// `cataclysm:chorus_fence` 123 / `cataclysm:purpur_wall` 20，合计 708 格，其中 533 格带连接
// props），`BLOCK_MAP` 把它们统一映到 `handrail`。但 `handrail` 是**转角件**（两臂垂直），
// 直排栏杆需要 `handrailA`（**直段件**，两臂共线）。直查表 ⇒ 708 格栏杆全部 meta=0，
// 全渲染成 +X+Z 转角 —— 方块层面看不出错（格数、类型全对），只有看画面才发现栏杆互相拧着。
//
// ## 判据（移植自 `bake-burning-arena.mjs`，用户 2026-11-09 的 200 格手工修正样例反推）
//   · **2 臂** → 共线对给直段件、垂直对给转角件；
//   · **0/1 臂**（垂直堆叠的栏杆柱）→ **整段统一朝向**：同一 (x,z) 柱内 y 连续的一截算一段，
//     段内所有格同一个 (方块, 朝向)。逐格独立算会在柱内左右摇摆；
//   · **兜底顺序**：声明的连接 props（Minecraft 权威，权重 2）→ 实际栏杆邻居（权重 1）
//     → 实心邻居（「靠在墙上」的支撑信号）→ 完全孤立时取靠内轴的直段件。
//     用户原话：「如果在边缘位置万一没办法让栏杆的抓手和两边连接，也没关系，
//     尽量让抓手的位置靠内即可」⇒ 单臂时配**朝中心**的垂直臂。
//
// ⚠️ **不新增/删除任何格**：本 pass 只改 (方块名, meta)，格数与包围盒不变。
// ⚠️ **刻意不用 `handrailB`**：其实测臂只伸到 ±0.25（格中心），与邻居在格边界断开
//     → 环上出现看不见的缺口（`test-arena.js` / `test-medieval-ship.js` 已钉住这条约束）。
// ⚠️ **本结构的 cells 含空气格**（DR-2），故 `occupied`（实心邻居判据）必须**只收非空气格**：
//     把空气算成「实心邻居」会让栏杆朝空气伸手，朝向 pass 整体失真。

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

/** 一个 palette 条目声明的连接臂 */
function propsArms(props) {
  const out = [];
  for (const [key, arm] of Object.entries(ARM_OF_KEY)) {
    const v = props[key];
    if (v === 'true' || v === 'low' || v === 'tall') out.push(arm);
  }
  return out;
}

/** 朝结构中心的臂（「抓手靠内」的判据）；正中心返回空数组 */
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
 *         ③ 单臂   → 调用方先拿支撑信号配垂直臂（见 computeRailOrientations）
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
  return null;
}

/**
 * 算出每个栏杆格该用的 (方块, meta)。
 *
 * ⚠️ **export 是为了让验证脚本共用同一份算法**（红线 1）：核对吻合率时不得另写一份判据，
 * 否则「算法 vs 样例」的比对会变成「两份手写实现互相比对」。
 *
 * @param {Array<{x:number,y:number,z:number,name:string,props:object}>} cells `assemble()` 的输出（含空气）
 * @returns {Map<string, {block:string, meta:number}>} 键 = `${x},${y},${z}`（组装后绝对坐标）
 */
export function computeRailOrientations(cells) {
  const occupied = new Set();
  const railAt = new Map();
  for (const c of cells) {
    // ⚠️ 空气格不算「实心邻居」（本结构 cells 含 27,060 格甲板下空气）
    if (c.name === 'air') continue;
    const k = `${c.x},${c.y},${c.z}`;
    occupied.add(k);
    if (RAIL_SOURCES.has(c.name)) railAt.set(k, c);
  }
  const isRail = (x, y, z) => railAt.has(`${x},${y},${z}`);
  const isSolid = (x, y, z) => occupied.has(`${x},${y},${z}`);

  // ① 按 (x,z) 分柱，柱内按 y 连续切段（上下两层地牢的同名柱会被切开，不会串味）
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

    let hit = null;
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
 * ⚠️ 空气格不计入 occupied（同 computeRailOrientations 的口径）。
 * @returns {{total:number, air:number}} total = 全部栏杆格的臂数（每格 2 臂）
 */
function railArmAirStats(cells) {
  const orient = computeRailOrientations(cells);
  const occupied = new Set();
  for (const c of cells) if (c.name !== 'air') occupied.add(`${c.x},${c.y},${c.z}`);
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

/** 通道名（`cullTable` 的值 → 名字，红线 1：不自己推） */
const CULL_NAMES = Object.freeze(['opaque', 'cutout', 'transparent', 'none']);

async function census() {
  const { cells, minY } = assemble();
  const M = RUINED_CITADEL_METRICS.ruinedCitadel;
  const frozen = Object.keys(M).length > 0;

  // 通道统计用 registry 的 cullTable（红线 1）。
  // ⚠️ 旧写法（正则扫 blocks-data 源码）会漏掉带大写的 `handrailA` → 它被归进 opaque，
  // cutout 少算（格数/类型/指纹全对，静默偏）。
  const { createRegistry } = await import('../src/voxel/block-registry.js');
  const { BLOCKS } = await import('../src/voxel/blocks-data.js');
  const reg = createRegistry();
  for (const d of BLOCKS) reg.register(d.name, d);
  reg.freeze();
  const cullOf = (name) => {
    const id = reg.idOf(name);
    if (id === undefined) throw new Error(`目标方块 "${name}" 未注册 —— makeColumnSetter 会静默把那格变 air`);
    return reg.cullTable[id];
  };

  console.log(`素材：${RUINED_CITADEL_PIECES.length} 片，共 ${cells.length} 格（含显式空气，minY=${minY}）`);
  console.log(`归一化 y = 组装 y − ${minY} + 1 = y + ${-minY + 1}；甲板层 floorRow=${FLOOR_ROW}（组装 y=-1）\n`);

  // 按源方块名 + props + 空气分层聚合（空气要按 y<0 / y>=0 分开，两者归宿不同）
  const bySource = new Map();
  for (const c of cells) {
    const layer = c.name === 'air' ? (c.y < 0 ? 'below-deck' : 'above-deck') : '-';
    const key = `${c.name}|${JSON.stringify(c.props)}|${layer}`;
    if (!bySource.has(key)) bySource.set(key, { name: c.name, props: c.props, y: c.y, layer, count: 0 });
    bySource.get(key).count++;
  }

  let unmapped = 0, missingFacing = 0;
  const byTarget = new Map();
  const channels = [0, 0, 0, 0];
  let dropped = 0, airKept = 0, airDropped = 0;
  const stairHalf = { bottom: 0, top: 0 };
  const slabType = { bottom: 0, top: 0, double: 0 };
  let railCells = 0;

  for (const [, v] of [...bySource.entries()].sort((a, b) => b[1].count - a[1].count)) {
    let res;
    try {
      res = classify(v.name, v.props, v.y);
    } catch (e) {
      unmapped++;
      if (/facing 未知/.test(e.message)) missingFacing++;
      console.log(`  ${String(v.count).padStart(7)}  ${v.name.padEnd(40)} ${JSON.stringify(v.props).padEnd(46)} → 【未映射】${e.message}`);
      continue;
    }
    // 统计口径
    if (v.name === 'air') { if (res === null) airDropped += v.count; else airKept += v.count; }
    else if (res === null) dropped += v.count;
    if (/_stairs$/.test(v.name)) stairHalf[v.props.half === 'top' ? 'top' : 'bottom'] += v.count;
    if (/_slab$/.test(v.name)) {
      const t = v.props.type || 'bottom';
      slabType[t === 'double' ? 'double' : (t === 'top' ? 'top' : 'bottom')] += v.count;
    }
    if (RAIL_SOURCES.has(v.name)) railCells += v.count;

    const label = res === null
      ? (v.name === 'air' ? '丢弃（甲板以上天空）' : '丢弃（当空气）')
      : `${res.block}${res.meta ? ` meta=${res.meta}` : ''}`;
    console.log(`  ${String(v.count).padStart(7)}  ${v.name.padEnd(40)} ${JSON.stringify(v.props).padEnd(46)} → ${label}`);
    if (res !== null) {
      byTarget.set(res.block, (byTarget.get(res.block) || 0) + v.count);
      channels[cullOf(res.block)] += v.count;
    }
  }

  const contentCells = [...byTarget.values()].reduce((a, b) => a + b, 0);
  const nonAir = cells.filter((c) => c.name !== 'air').length;

  console.log('\n目标方块合计：');
  for (const [k, v] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${v}`);

  console.log('\n=== 格数核算 ===');
  console.log(`  非空气格        ${nonAir}${frozen ? `（METRICS.sourceCells ${M.sourceCells}）` : ''}`);
  console.log(`  丢弃标记格      ${dropped}${frozen ? `（METRICS.droppedCells ${M.droppedCells}）` : ''}`);
  console.log(`  甲板下空气      ${airKept}${frozen ? `（METRICS.airCells ${M.airCells}）` : ''}`);
  console.log(`  甲板上空气(丢)  ${airDropped}`);
  console.log(`  产物格数        ${contentCells} = ${nonAir} − ${dropped} + ${airKept}` +
    `${frozen ? `（METRICS.contentCells ${M.contentCells}）` : ''}`);
  console.log(`  台阶 bottom/top ${stairHalf.bottom}/${stairHalf.top}（合计 ${stairHalf.bottom + stairHalf.top}）`);
  console.log(`  半砖 bottom/top/double ${slabType.bottom}/${slabType.top}/${slabType.double}` +
    `（合计 ${slabType.bottom + slabType.top + slabType.double}）`);
  console.log(`  墙/栅栏         ${railCells}`);
  console.log(`  通道分布        ${CULL_NAMES.map((n, i) => `${n} ${channels[i]}`).join(' / ')}`);

  // 包围盒：产物（含空气）与非空气分开报 —— 两者不同（spec §2.2 修订）
  const bboxOf = (arr) => {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const c of arr) {
      if (c.x < mnx) mnx = c.x; if (c.x > mxx) mxx = c.x;
      if (c.y < mny) mny = c.y; if (c.y > mxy) mxy = c.y;
      if (c.z < mnz) mnz = c.z; if (c.z > mxz) mxz = c.z;
    }
    return { mnx, mxx, mny, mxy, mnz, mxz, w: mxx - mnx + 1, h: mxy - mny + 1, d: mxz - mnz + 1 };
  };
  const productCells = cells.filter((c) => classify(c.name, c.props, c.y) !== null);
  const pb = bboxOf(productCells);
  const nb = bboxOf(cells.filter((c) => c.name !== 'air'));
  console.log(`\n=== 包围盒 ===`);
  console.log(`  产物（含甲板下空气） x[${pb.mnx},${pb.mxx}] y[${pb.mny},${pb.mxy}] z[${pb.mnz},${pb.mxz}]` +
    ` = ${pb.w}×${pb.h}×${pb.d}${frozen ? `（METRICS ${M.width}×${M.height}×${M.depth}）` : ''}`);
  console.log(`  非空气（= footprint）x[${nb.mnx},${nb.mxx}] z[${nb.mnz},${nb.mxz}] = ${nb.w}×${nb.d}` +
    ` ⇒ HALF_X=${Math.max(Math.abs(nb.mnx - ORIGIN_X), Math.abs(nb.mxx - ORIGIN_X))}` +
    ` HALF_Z=${Math.max(Math.abs(nb.mnz - ORIGIN_Z), Math.abs(nb.mxz - ORIGIN_Z))}`);

  // 甲板层格数（归一化 ny = FLOOR_ROW，即组装 y = -1）
  const deckY = FLOOR_ROW + minY - 1;
  const deckCells = productCells.filter((c) => c.y === deckY).length;
  console.log(`  甲板层（组装 y=${deckY} → ny=${FLOOR_ROW}）${deckCells} 格` +
    `（覆盖率 ${(100 * deckCells / (nb.w * nb.d)).toFixed(1)}%）` +
    `${frozen ? `（METRICS.deckCells ${M.deckCells}）` : ''}`);

  // 栏杆朝向普查（与 bake() 同一份算法，红线 1）
  const railHist = railOrientationHistogram(cells);
  const railTotal = Object.values(railHist).reduce((a, b) => a + b, 0);
  console.log(`\n栏杆朝向（共 ${railTotal} 格）：`);
  for (const [k, v] of Object.entries(railHist)) console.log(`  ${k.padEnd(16)} ${v}`);
  if (railTotal !== railCells) {
    console.log(`  ✗ 栏杆总格数 ${railTotal} ≠ 源墙栏格数 ${railCells} —— 朝向 pass 增删了格`);
    process.exitCode = 1;
  }
  const armStats = railArmAirStats(cells);
  console.log(`  抓手指向空气：${armStats.air}/${armStats.total} = ${(100 * armStats.air / armStats.total).toFixed(1)}%`);

  if (unmapped) {
    console.log(`\n✗ ${unmapped} 个源方块条目未映射（其中 facing 缺失 ${missingFacing}）—— 补映射后重跑`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ 全部已映射（源名 ${bySource.size} 个条目 / ${new Set(cells.map((c) => c.name)).size} 种方块名，facing 缺失 0）`);
  }
}

// ---------------------------------------------------------------- orient 现场校验

/**
 * 现场重测 `orient → 台阶高侧方向`，同时校验正台阶与倒置台阶。
 *
 * 手法：给**真实注册的台阶方块**分别设 orient 0~3，用**真实 mesher** 发射顶点，
 * 取「上半部」的 bbox，看高侧落在哪个方向。这是校验 `FACING_TO_ORIENT` 的唯一可靠办法
 * —— 不要从任何模块的「定义」推（AGENTS.md 已记：只能用真实 mesher 实测定）。
 *
 * ⚠️ 与大竞技场不同：本结构的台阶有 4 个几何族（新烘的 obsidian_brick / end_stone_brick
 * 各正倒两态 + 既有的 stone_diorite_step / cobblestone_step_updown），**逐个实测**，
 * 不假设「新烘台阶的朝向语义与 cobblestone_step 相同」。
 */
async function censusOrient() {
  const { buildSectionMesh } = await import('../src/mesh/mesher.js');
  const { createRegistry } = await import('../src/voxel/block-registry.js');
  const { BLOCKS } = await import('../src/voxel/blocks-data.js');

  const reg = createRegistry();
  for (const d of BLOCKS) reg.register(d.name, d);
  reg.freeze();

  const VIEW = 18;
  const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) }) };
  const idx = (x, y, z) => x + z * VIEW + y * VIEW * VIEW;
  const LX = 8, LY = 8, LZ = 8;

  const short = (s) => s.split('(')[0];
  const expected = Object.fromEntries(Object.entries(FACING_TO_ORIENT).map(([f, o]) => [o, f]));

  // 本结构实际用到的全部台阶方块（从 STAIR_TARGETS 收集，不手写清单）
  const stepBlocks = [...new Set(Object.values(STAIR_TARGETS).flatMap((f) => [f.bottom, f.top]))].sort();
  const UPDOWN = new Set(Object.values(STAIR_TARGETS).map((f) => f.top));

  let badTotal = 0;
  for (const blockName of stepBlocks) {
    const isUpdown = UPDOWN.has(blockName);
    const id = reg.idOf(blockName);
    if (id === undefined) {
      console.log(`\n✗ ${blockName} 未注册`);
      badTotal++;
      continue;
    }
    console.log(`\n=== ${blockName}${isUpdown ? '（倒置）' : '（正置）'} ===`);
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
    badTotal += bad;
  }
  if (badTotal) process.exitCode = 1;
}

// ---------------------------------------------------------------- 烘焙

function bake() {
  const { cells, minY } = assemble();
  const M = RUINED_CITADEL_METRICS.ruinedCitadel;
  if (Object.keys(M).length === 0) {
    throw new Error('RUINED_CITADEL_METRICS 还是占位 —— 先跑 `npm run ruinedcitadel -- --census` 冻结实测值');
  }

  // 栏杆朝向 pass（见文件头「栏杆朝向」节）：只改 (方块, meta)，不增删格
  const railOrient = computeRailOrientations(cells);

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();
  const stepCounts = new Map();
  const railCounts = new Map();

  // 按 y→z→x 排序保证 palette 首次出现顺序确定
  const sorted = [...cells].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  for (const c of sorted) {
    const ny = c.y - minY + 1;
    let res = classify(c.name, c.props, c.y);
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
    // 归一化：x/z 相对结构中心，y 从 minY 变 1。
    // ⚠️ **第 5 项 direction 必填**（stride=5）：台阶靠它携带 orient。
    blocks.push(c.x - ORIGIN_X, ny, c.z - ORIGIN_Z, tpi, res.meta);
    counts.set(res.block, (counts.get(res.block) || 0) + 1);
    if (/_step(_updown)?$/.test(res.block)) {
      const k = `${res.block}:${res.meta}`;
      stepCounts.set(k, (stepCounts.get(k) || 0) + 1);
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
  // ⚠️ DR-2 的核心守卫：palette 必须含 air，且 air 格数 = 甲板下空气数。
  //    漏了这条，地牢会被天然岩层填满，而格数/类型/指纹全对（只有挖下去才发现）。
  if (!palette.includes('air')) {
    throw new Error('palette 不含 "air" —— 甲板以下空气没写进产物，地牢会被 fillColumn/carveCaves 填满（spec DR-2）');
  }
  if ((counts.get('air') || 0) !== M.airCells) {
    throw new Error(`air 格数 ${counts.get('air') || 0} ≠ METRICS.airCells ${M.airCells}（spec DR-2 内容级判据）`);
  }
  for (const [k, v] of Object.entries(M.targetCounts)) {
    const got = counts.get(k) || 0;
    if (got !== v) throw new Error(`"${k}" 格数 ${got} ≠ 冻结值 ${v}`);
  }
  // 栏杆：朝向 pass 把 708 格拆成 handrail（转角件）+ handrailA（直段件），
  // 各自格数随算法浮动，但**总数不变**（只改朝向不增删格）。
  const railTotal = (counts.get('handrail') || 0) + (counts.get('handrailA') || 0);
  if (railTotal !== M.railCells) {
    throw new Error(`栏杆格数 handrail+handrailA = ${railTotal} ≠ ${M.railCells}（朝向 pass 增删了格？）`);
  }
  if (palette.includes('handrailB')) {
    throw new Error('产物含 handrailB —— 它的臂只伸到格中心、接不上邻居，不得用作栏杆件');
  }
  // 台阶朝向分布逐档比对（负向验证 #6 的守卫）。
  // ⚠️ **为什么需要这一条**：`half=top` 的 `meta = (orient+2)%4` 若被去掉，格数/palette/
  //    包围盒/指纹**全部不变**（只改 meta 值），而 `--census-orient` 测的是 mesher 几何语义
  //    （它验证「+2」这个假设成立，不验证 classify 有没有用它）⇒ 缺陷静默通过。
  //    实测：去掉 +2 后 cobblestone_step_updown 四档从 60/54/58/52 变成 58/52/60/54，
  //    楼梯高侧全部差 180°（上下颠倒），只有逐档比对或看画面才发现。
  //    （既有 4 个烘焙产物都只把这份分布写进 meta 而不断言，本结构补上。）
  const wantSteps = Object.fromEntries(Object.entries(M.stepOrientationCounts).sort());
  const gotSteps = Object.fromEntries([...stepCounts.entries()].sort());
  if (JSON.stringify(gotSteps) !== JSON.stringify(wantSteps)) {
    throw new Error(`台阶朝向分布 ${JSON.stringify(gotSteps)} ≠ METRICS.stepOrientationCounts ${JSON.stringify(wantSteps)}`
      + '（half=top 的 +2 被改了？或改了朝向算法 —— 重跑 --census-orient 核实后按实测值重标基线，不要放宽断言）');
  }

  // bbox 与甲板层
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  let deckCells = 0;
  for (let i = 0; i < blocks.length; i += STRIDE) {
    const bx = blocks[i], by = blocks[i + 1], bz = blocks[i + 2];
    if (bx < mnx) mnx = bx; if (bx > mxx) mxx = bx;
    if (by < mny) mny = by; if (by > mxy) mxy = by;
    if (bz < mnz) mnz = bz; if (bz > mxz) mxz = bz;
    if (by === FLOOR_ROW) deckCells++;
  }
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  if (W !== M.width) throw new Error(`宽 ${W} ≠ ${M.width}`);
  if (H !== M.height) throw new Error(`高 ${H} ≠ ${M.height}`);
  if (D !== M.depth) throw new Error(`深 ${D} ≠ ${M.depth}`);
  if (mny !== 1) throw new Error(`最低点 y=${mny} ≠ 1（归一化失败）`);
  if (deckCells !== M.deckCells) throw new Error(`甲板层格数 ${deckCells} ≠ METRICS.deckCells ${M.deckCells}`);

  // ---- 写盘 ----
  const json = { version: 1, stride: STRIDE, floorRow: FLOOR_ROW, palette, blocks };
  const fp = ruinedCitadelInputFingerprint();
  const meta = {
    version: 1,
    width: W, height: H, depth: D,
    blocks: n,
    floorRow: FLOOR_ROW,
    deckCells,
    airCells: counts.get('air') || 0,
    paletteSize: palette.length,
    stepOrientationCounts: Object.fromEntries([...stepCounts.entries()].sort()),
    railOrientationCounts: Object.fromEntries([...railCounts.entries()].sort()),
    origin: { cx: ORIGIN_X, cz: ORIGIN_Z },
    fingerprints: fp,
  };

  fs.mkdirSync(path.dirname(RUINED_CITADEL_JSON), { recursive: true });
  fs.writeFileSync(RUINED_CITADEL_JSON, JSON.stringify(json));
  fs.writeFileSync(RUINED_CITADEL_META, `${JSON.stringify(meta, null, 2)}\n`);

  const kb = (fs.statSync(RUINED_CITADEL_JSON).size / 1024 / 1024).toFixed(2);
  console.log(`废弃堡垒 JSON ${kb} MB，${n} 格（含 air ${meta.airCells}），${W}×${H}×${D}，` +
    `palette ${palette.length} 种，甲板层 ${deckCells} 格（floorRow=${FLOOR_ROW}）`);
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
