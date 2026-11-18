// tools/bake-jungle-fortress.mjs — 丛林要塞：离线 jigsaw 拼装 → 结构 JSON
//
// 用法：npm run junglefortress                烘焙（Task 2 起）
//       npm run junglefortress -- --census    只拼装 + 普查 + 断言，不写产物
//
// ## 为什么需要「离线拼装」这一步（本结构独有）
// 既有 8 个烘焙结构的素材都是**固定偏移拼合**（废弃堡垒 18 片、大竞技场 8 片）。
// 丛林要塞的素材是 **jigsaw 动态拼装**：17 个件 + 权重池 + 10 层递归，
// 每次生成形状都不同。用户裁定「先离线拼定版布局再烘焙」⇒ 本脚本复刻
// PieceLimitedJigsawManager 的语义，用固定 PRNG 种子拼出**一个**定版布局。
//
// ## 七条语义（逐条对照 PieceLimitedJigsawManager.java）
//   ① 起始件 = start_pool 唯一元素 center_room，随机旋转
//   ② BFS 队列（不是递归），size=10 ⇒ 最大深度 10
//   ③ 连接口判据是 jigsaw 的 `target === 'connection'`（**不是 name**，name 恒为 empty）
//   ④ 权重抽签；抽到 empty 该口终止；放不下则剔除重抽
//   ⑤ 旋转对齐：候选口 front 与父口 front 反向、target 名相同
//   ⑥ AABB deflate 0.25 不重叠
//   ⑦ maxDistanceFromCenter 缺省 80 ⇒ 件中心不超 ±80
//
// ⚠️ ③ 是静默失效点：按 name 过滤会让 8/8 seed 只拼出 1 件（center_room），无报错。
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { NbtReader } from './nbt-reader.mjs';
// 臂方向 ↔ (方块, 朝向) 的**唯一权威**在 arena.js（从 mesher 的 TEMPLATES 派生，红线 1）。
import { railPlacementFor, railArmSet } from '../src/gen/structures/arena.js';
import {
  JUNGLE_FORTRESS_SOURCE_DIR, JUNGLE_FORTRESS_PIECES,
  JUNGLE_FORTRESS_ASSEMBLE, JUNGLE_FORTRESS_POOL_WEIGHTS, JUNGLE_FORTRESS_POOL_FALLBACK,
  JUNGLE_FORTRESS_METRICS, jungleFortressInputFingerprint, FACING_TO_ORIENT,
  JUNGLE_FORTRESS_JSON, JUNGLE_FORTRESS_META, JUNGLE_FORTRESS_VINE,
} from './jungle-fortress-fingerprint.mjs';

/**
 * 拼装器 PRNG：LCG（与探针逐位一致，冻结值 193 件由它产出）。
 * ⚠️ **不要换成 mulberry32**：换 PRNG 会换掉整个布局（实测 193→38 件）。
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * 变体分配 PRNG：mulberry32（与探针的石砖族抽签逐位一致）。
 * ⚠️ **与拼装器的 LCG 是两条独立流**，不得共用一个函数 ——
 * 实测共用 LCG 会让 mossy_stone 从 30503 变 30235（268 格静默漂移，总数不变）。
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** 读一片 nbt → {size, cells, jigs}（cells 含 props；jigs 保留 feature 池供 Task 3） */
function readPiece(file) {
  const raw = fs.readFileSync(path.join(JUNGLE_FORTRESS_SOURCE_DIR, file));
  const r = new NbtReader(gunzipSync(raw));
  r.u1();      // root tag type (10)
  r.str();     // root name
  const root = r.payload(10);
  const pal = root.palette;
  const cells = [];
  const jigs = [];
  for (const b of root.blocks) {
    const e = pal[b.state];
    const nm = String(e.id).replace(/^minecraft:/, '');
    if (nm === 'jigsaw') {
      const d = b.nbt || {};
      jigs.push({
        pos: b.pos,
        orientation: e.properties?.orientation,
        pool: String(d.pool || '').split('/').pop(),
        name: String(d.name || '').replace(/^minecraft:/, ''),
        target: String(d.target || '').replace(/^minecraft:/, ''),
        final: String(d.final_state || '').replace(/^minecraft:/, ''),
      });
      continue;
    }
    cells.push({ pos: b.pos, nm, props: e.properties || {} });
  }
  return { size: root.size, cells, jigs };
}

/** 全部 17 片（模块级缓存，一次读） */
const PIECES = new Map();
for (const f of JUNGLE_FORTRESS_PIECES) {
  PIECES.set(f.replace(/\.nbt$/, ''), readPiece(f));
}
export { PIECES };

/** 绕 Y 四档旋转（与 vanilla StructureTemplate 一致） */
export function rotPos([x, y, z], rot, [sx, , sz]) {
  switch (rot) {
    case 1: return [sz - 1 - z, y, x];
    case 2: return [sx - 1 - x, y, sz - 1 - z];
    case 3: return [z, y, sx - 1 - x];
    default: return [x, y, z];
  }
}

/** 旋转后的件尺寸（奇数档交换 x/z） */
function rotSize(size, rot) {
  return (rot % 2 === 0) ? size : [size[2], size[1], size[0]];
}

/** 方向向量绕 Y 旋转（与 rotPos 同一约定） */
function rotDir([x, y, z], rot) {
  switch (rot) {
    case 1: return [-z, y, x];
    case 2: return [-x, y, -z];
    case 3: return [z, y, -x];
    default: return [x, y, z];
  }
}

const DIRV = Object.freeze({
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0],
});

/** jigsaw 的 orientation 串 "<front>_<up>" → front 方向名 */
function frontOf(j) {
  return String(j.orientation || 'north_up').split('_')[0];
}

/**
 * 连接口判据 —— **载荷性**：判 `target` 不是 `name`。
 * 源 nbt 里 name 恒为 `minecraft:empty`，target 才是 `minecraft:connection`。
 */
const isConnector = (j) => j.target === 'connection';

/**
 * 离线拼装（spec §2.2 七条语义）。
 * @returns {{placed: Array<{name:string, rot:number, o:number[], size:number[], depth:number}>}}
 */
export function assembleJungleFortress() {
  const { seed, size: maxDepth, boxRange, startPiece } = JUNGLE_FORTRESS_ASSEMBLE;
  const rand = lcg(seed);
  const ri = (n) => Math.floor(rand() * n);

  const placed = [];
  const boxes = [];

  // ① 起始件 + 随机旋转
  const startRot = ri(4);
  const startProto = PIECES.get(startPiece);
  const sSize = rotSize(startProto.size, startRot);
  placed.push({ name: startPiece, rot: startRot, o: [0, 0, 0], size: sSize, depth: 0 });
  boxes.push([0, 0, 0, sSize[0] - 1, sSize[1] - 1, sSize[2] - 1]);

  // ⑥ AABB deflate 0.25 不重叠
  const overlaps = (bx) => boxes.some((o) =>
    bx[0] + 0.25 <= o[3] - 0.25 && bx[3] - 0.25 >= o[0] + 0.25 &&
    bx[1] + 0.25 <= o[4] - 0.25 && bx[4] - 0.25 >= o[1] + 0.25 &&
    bx[2] + 0.25 <= o[5] - 0.25 && bx[5] - 0.25 >= o[2] + 0.25);

  // ⑦ 件中心不超 ±boxRange
  const outOfRange = (bx) =>
    Math.max(...bx.slice(0, 3).map(Math.abs), ...bx.slice(3).map(Math.abs)) > boxRange;

  /** 试放一个候选件：返回 true 表示已放入队列 */
  const tryPlace = (cand, parent, jp, front, targetName, depth) => {
    const rots = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const k = ri(i + 1); [rots[i], rots[k]] = [rots[k], rots[i]]; }
    for (const rot of rots) {
      const cSize = rotSize(cand.size, rot);
      for (const cj of cand.jigs) {
        if (!isConnector(cj)) continue;
        if (cj.target !== targetName) continue;
        const cFront = rotDir(DIRV[frontOf(cj)], rot);
        // ⑤ front 必须反向
        if (cFront[0] !== -front[0] || cFront[1] !== -front[1] || cFront[2] !== -front[2]) continue;
        const cjp = rotPos(cj.pos, rot, cand.size);
        const o = jp.map((v, k) => v - cjp[k]);
        const bx = [o[0], o[1], o[2], o[0] + cSize[0] - 1, o[1] + cSize[1] - 1, o[2] + cSize[2] - 1];
        if (overlaps(bx) || outOfRange(bx)) continue;
        boxes.push(bx);
        placed.push({ name: cand.name, rot, o, size: cSize, depth: depth + 1 });
        return true;
      }
    }
    return false;
  };

  // ② BFS 队列
  const queue = [0];
  let guard = 0;
  while (queue.length && guard++ < 20000) {
    const pi = queue.shift();
    const P = placed[pi];
    if (P.depth >= maxDepth) continue;
    const proto = PIECES.get(P.name);
    const conns = proto.jigs.filter(isConnector);
    // vanilla getShuffledJigsawBlocks
    for (let i = conns.length - 1; i > 0; i--) { const k = ri(i + 1); [conns[i], conns[k]] = [conns[k], conns[i]]; }

    for (const j of conns) {
      const pool = JUNGLE_FORTRESS_POOL_WEIGHTS[j.pool];
      if (!pool) continue;
      const jp = rotPos(j.pos, P.rot, proto.size).map((v, k) => v + P.o[k]);
      const front = rotDir(DIRV[frontOf(j)], P.rot);
      // vanilla：目标格已落在任何已放件 bbox 内 ⇒ 该连接口作废
      const target = jp.map((v, k) => v + front[k]);
      if (boxes.some((o) => target[0] >= o[0] && target[0] <= o[3] &&
          target[1] >= o[1] && target[1] <= o[4] && target[2] >= o[2] && target[2] <= o[5])) continue;

      // ④ 权重抽签 + 放不下剔除重抽
      let cands = pool.map((e) => ({ ...e }));
      let done = false;
      while (cands.length && !done) {
        const total = cands.reduce((a, c) => a + c.w, 0);
        let r = rand() * total;
        let chosen = cands[0];
        for (const c of cands) { r -= c.w; if (r <= 0) { chosen = c; break; } }
        if (chosen.loc === null) break;         // empty_pool_element ⇒ 该口终止
        const cand = PIECES.get(chosen.loc);
        if (!cand) { cands = cands.filter((c) => c !== chosen); continue; }
        if (tryPlace({ ...cand, name: chosen.loc }, P, jp, front, j.target, P.depth)) {
          queue.push(placed.length - 1);
          done = true;
        } else {
          cands = cands.filter((c) => c !== chosen);
        }
      }

      // 池空 → fallback（terminator）：等权抽一件，固定旋转序 0..3，只试一轮
      if (!done) {
        const fbName = JUNGLE_FORTRESS_POOL_FALLBACK[j.pool];
        const fb = fbName ? JUNGLE_FORTRESS_POOL_WEIGHTS[fbName] : null;
        const opts = fb ? fb.filter((e) => e.loc) : [];
        if (opts.length) {
          const chosen = opts[ri(opts.length)];
          const cand = PIECES.get(chosen.loc);
          if (cand) {
            for (const rot of [0, 1, 2, 3]) {
              const cSize = rotSize(cand.size, rot);
              let ok = false;
              for (const cj of cand.jigs) {
                if (!isConnector(cj) || cj.target !== j.target) continue;
                const cFront = rotDir(DIRV[frontOf(cj)], rot);
                if (cFront[0] !== -front[0] || cFront[1] !== -front[1] || cFront[2] !== -front[2]) continue;
                const cjp = rotPos(cj.pos, rot, cand.size);
                const o = jp.map((v, k) => v - cjp[k]);
                const bx = [o[0], o[1], o[2], o[0] + cSize[0] - 1, o[1] + cSize[1] - 1, o[2] + cSize[2] - 1];
                if (overlaps(bx) || outOfRange(bx)) continue;
                boxes.push(bx);
                placed.push({ name: chosen.loc, rot, o, size: cSize, depth: P.depth + 1 });
                queue.push(placed.length - 1);
                ok = true; break;
              }
              if (ok) break;
            }
          }
        }
      }
    }
  }
  return { placed };
}

/** 件数直方图（键按字母序，便于逐档比对） */
export function pieceHistogram(placed) {
  const h = new Map();
  for (const p of placed) h.set(p.name, (h.get(p.name) || 0) + 1);
  return Object.fromEntries([...h.entries()].sort());
}

/** 全部件的包围盒（含空气，按件尺寸算） */
export function placedBBox(placed) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const p of placed) {
    mnx = Math.min(mnx, p.o[0]); mxx = Math.max(mxx, p.o[0] + p.size[0] - 1);
    mny = Math.min(mny, p.o[1]); mxy = Math.max(mxy, p.o[1] + p.size[1] - 1);
    mnz = Math.min(mnz, p.o[2]); mxz = Math.max(mxz, p.o[2] + p.size[2] - 1);
  }
  return { mnx, mxx, mny, mxy, mnz, mxz, w: mxx - mnx + 1, h: mxy - mny + 1, d: mxz - mnz + 1 };
}

// ---------------------------------------------------------------- 栏杆朝向（手拉手）

/**
 * 栏杆朝向 pass —— 用户 2026-11-18 裁定：
 * 「只要是能手拉手的相邻栏杆，就换成我修改的样子……请注意栏杆的方向，让他们方向正确，做到手拉手」。
 *
 * 用户手工样例（进度包 seed 3183162，43 格）反推出的规则，**43/43 几何吻合**：
 *   · **共线两臂** → `handrailA`（直段件，横杆贯通整格 ⇒ 首尾相连成排）；
 *   · **垂直两臂** → `handrail`（转角件）；
 *   · **单臂**（排的端头）→ **沿自身轴延伸成直段**，不在端头拐角
 *     （第一版按「支撑信号配垂直臂」会在端头出转角，与用户样例 2 格不符）；
 *   · **孤立**（0 臂，窗内竖条）→ 支撑信号里的共线对，否则该轴直段。
 *
 * ⚠️ **按 (x,z) 分柱、柱内 y 连续切段，段内共用一个朝向**：逐格独立算会在竖直柱内
 * 左右摇摆（同 `bake-ruined-citadel.mjs` 的既有口径）。
 *
 * ⚠️ **臂方向 ↔ (方块, 朝向) 的唯一权威是 `arena.js` 的 `railPlacementFor`**
 * （从 mesher 的 TEMPLATES 派生）。不得在本脚本手写「orient=1 是 +X-Z」这类表 ——
 * 形状权威改动后这里会自动跟上，手写表会静默漂移（红线 1）。
 *
 * ⚠️ **`handrailA` 的 0≡2、1≡3 几何等价**（臂集合都是 ±X 或 ±Z，实测 `railArmSet` 逐位相同）。
 * 故与用户样例比对必须按**臂集合**而不是 orient 数值，否则会把等价写法误判成不符。
 *
 * ⚠️ **刻意不用 `handrailB`**：其臂只伸到 ±0.25（格中心），与邻居在格边界断开 ⇒ 排上出现
 * 看不见的缺口（`test-arena.js` / `test-medieval-ship.js` 已钉住这条约束）。
 */
const RAIL_DIRS = Object.freeze([['+X', 1, 0], ['-X', -1, 0], ['+Z', 0, 1], ['-Z', 0, -1]]);
const RAIL_ARMS = Object.freeze(['+X', '-X', '+Z', '-Z']);
const RAIL_OPP = Object.freeze({ '+X': '-X', '-X': '+X', '+Z': '-Z', '-Z': '+Z' });
const railAxis = (a) => (a === '+X' || a === '-X' ? 'X' : 'Z');

/**
 * 算出每个栏杆格的 (方块, 朝向)。
 *
 * @param {Map<string,{block:string,meta:number}>} cells 已映射的产物（栏杆此时是 vertical_pillar）
 * @returns {Map<string,{name:string,orient:number}>}
 */
export function computeRailOrientations(cells) {
  const isRail = (x, y, z) => cells.get(`${x},${y},${z}`)?.block === 'vertical_pillar';
  // ⚠️ 实心邻居判据必须排除 air 与 vine（藤蔓不是支撑）
  const isSolid = (x, y, z) => {
    const b = cells.get(`${x},${y},${z}`)?.block;
    return b !== undefined && b !== 'air' && b !== 'vine';
  };

  // 按 (x,z) 分柱，柱内按 y 连续切段
  const columns = new Map();
  for (const [k, c] of cells) {
    if (c.block !== 'vertical_pillar') continue;
    const [x, y, z] = k.split(',').map(Number);
    const ck = `${x},${z}`;
    if (!columns.has(ck)) columns.set(ck, []);
    columns.get(ck).push(y);
  }
  const segments = [];
  for (const [ck, ys] of columns) {
    const [x, z] = ck.split(',').map(Number);
    ys.sort((a, b) => a - b);
    let cur = [ys[0]];
    for (let i = 1; i < ys.length; i++) {
      if (ys[i] === ys[i - 1] + 1) cur.push(ys[i]);
      else { segments.push({ x, z, ys: cur }); cur = [ys[i]]; }
    }
    segments.push({ x, z, ys: cur });
  }

  const out = new Map();
  for (const seg of segments) {
    const conn = { '+X': 0, '-X': 0, '+Z': 0, '-Z': 0 };
    const sup = { '+X': 0, '-X': 0, '+Z': 0, '-Z': 0 };
    for (const y of seg.ys) {
      for (const [a, dx, dz] of RAIL_DIRS) {
        if (isRail(seg.x + dx, y, seg.z + dz)) conn[a] += 1;
        if (isSolid(seg.x + dx, y, seg.z + dz)) sup[a] += 1;
      }
    }
    const connArms = RAIL_ARMS.filter((a) => conn[a] > 0);
    let hit = null;
    if (connArms.length === 1) {
      // 单臂 = 排的端头 ⇒ 沿自身轴延伸成直段（手拉手），不拐角
      const a = connArms[0];
      hit = railPlacementFor([a, RAIL_OPP[a]]);
    } else if (connArms.length >= 2) {
      const order = connArms.slice().sort((a, b) => conn[b] - conn[a] || RAIL_ARMS.indexOf(a) - RAIL_ARMS.indexOf(b));
      for (const a of order) {
        if (conn[RAIL_OPP[a]] > 0) { hit = railPlacementFor([a, RAIL_OPP[a]]); break; }
      }
      if (!hit) {
        outer: for (let i = 0; i < order.length; i++) {
          for (let j = i + 1; j < order.length; j++) {
            if (railAxis(order[i]) === railAxis(order[j])) continue;
            hit = railPlacementFor([order[i], order[j]]);
            break outer;
          }
        }
      }
    } else {
      // 孤立（窗内竖条）：支撑信号里的共线对，否则该轴直段
      const order = RAIL_ARMS.filter((a) => sup[a] > 0)
        .sort((a, b) => sup[b] - sup[a] || RAIL_ARMS.indexOf(a) - RAIL_ARMS.indexOf(b));
      for (const a of order) {
        if (sup[RAIL_OPP[a]] > 0) { hit = railPlacementFor([a, RAIL_OPP[a]]); break; }
      }
      if (!hit && order.length) hit = railPlacementFor([order[0], RAIL_OPP[order[0]]]);
      if (!hit) hit = railPlacementFor(['+X', '-X']);
    }
    for (const y of seg.ys) out.set(`${seg.x},${y},${seg.z}`, hit);
  }
  return out;
}

/** 栏杆朝向分布直方图（写进 meta.json 供门禁逐档比对） */
function railHistogram(orient) {
  const h = new Map();
  for (const { name, orient: o } of orient.values()) {
    const k = `${name}:${o}`;
    h.set(k, (h.get(k) || 0) + 1);
  }
  return Object.fromEntries([...h.entries()].sort());
}
// ---------------------------------------------------------------- 物化（空气分层 / 支撑柱 / 变体）

/** 源方块名 → 目标方块名。空串 = 丢弃。未收录的名字一律 throw（不静默变 air） */
export const BLOCK_MAP = Object.freeze({
  stone_bricks: 'stone_bricks',       // 后续由 STONE_VARIANTS 四色分配
  iron_bars: 'vertical_pillar',       // 0.3² 通高细柱，4 向对称 ⇒ orient 恒 0，无朝向 pass
  stone_brick_stairs: 'cobblestone_step',
  mossy_stone_brick_stairs: 'cobblestone_step',
  coarse_dirt: 'dirt',
  red_mushroom: 'red_mushroom',
  brown_mushroom: 'red_mushroom',
  chest: 'chest',
  water: 'water',
  cave_air: 'air',
  air: 'air',
  red_stained_glass: 'stone_bricks',  // pillar_processor 的占位符
  spawner: '',                        // 本仓无刷怪笼系统
  structure_void: '',
});

/**
 * 石砖族四色分配（把上游 jungle_main.json 的生成期随机固化成确定性）。
 * 上游概率：mossy 50% / cracked 25% / chiseled 5% / 纯石砖 20%。
 * 本仓无 mossy_stone_bricks / cracked / chiseled 贴图 ⇒ 映到同色系既有方块。
 * 加权均色 113,116,107（g−r=3 略偏绿）—— 对照纯石砖 122,122,122。
 */
export const STONE_VARIANTS = Object.freeze({
  seed: 20261117,
  bands: Object.freeze([
    { p: 0.50, block: 'mossy_stone' },
    { p: 0.25, block: 'cobblestone' },
    { p: 0.05, block: 'tuff_bricks' },
    { p: 0.20, block: 'stone_bricks' },
  ]),
});

/** 地板层在**结构坐标**里的 y（center_room 的满铺实心层）。归一化后 = 13。 */
export const STRUCT_FLOOR_Y = 6;

/**
 * 藤蔓参数（spec §6 开放项 → 用户裁定纳入本期）。
 *
 * 上游 `StructureVineAndLeaves`：attempts 10 / length 3 / xz_range 3 / y = ri(4)−1。
 *
 * ⚠️ **有意偏离**：上游的 `vine_breakage` 是**另一个算法**
 * （`StructureVineBreakage`：attempts 15 / length 4 / y = ri(5)−1，且要求起点是实心块
 * 并**把它打成 cave_air**——实测会打掉 265 格石砖 + 21 格栏杆）。
 * 本仓**不移植破洞语义**（那超出「加藤蔓」范围、会破坏墙体完整性），
 * 两个池统一用 vines 的参数只长藤蔓。要破洞观感需独立改动。
 */
const VINE_PARAMS = JUNGLE_FORTRESS_VINE;

const SOLID_SRC = (nm) => nm !== undefined && nm !== 'cave_air' && nm !== 'air'
  && nm !== 'structure_void' && nm !== 'red_stained_glass';
const isAirSrc = (nm) => nm === 'cave_air' || nm === 'air';

/** 把已拼装的件展平成世界格 Map（含 jigsaw 的 final_state 落格） */
export function materializeRaw(placed) {
  const map = new Map();
  for (const p of placed) {
    const proto = PIECES.get(p.name);
    for (const c of proto.cells) {
      const w = rotPos(c.pos, p.rot, proto.size).map((v, k) => v + p.o[k]);
      map.set(w.join(','), c.nm);
    }
    // vanilla：组装后 jigsaw 被 final_state 替换；structure_void = 不放置
    for (const j of proto.jigs) {
      const w = rotPos(j.pos, p.rot, proto.size).map((v, k) => v + p.o[k]);
      const fin = j.final || 'cave_air';
      if (fin === 'structure_void') continue;
      map.set(w.join(','), fin);
    }
  }
  return map;
}

/** 格 Map 的包围盒 */
function cellBBox(map) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const k of map.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  return [mnx, mxx, mny, mxy, mnz, mxz];
}

/**
 * 空气分层判据 D：**同 y 层水平洪泛**。
 *
 * 从「贴 bbox 边界的空气格」起洪泛，可通 = 空气格 或 nbt 未写格（都是天空），
 * 遇实心停。洪泛到的 = 天空（丢弃）；没到的 = 房间内腔（写 air）。
 *
 * ⚠️ **只在同 y 层做，竖直不传播**：屋顶破洞（breakage feature）若让洪泛竖直传播，
 * 会把整间房判成天空 ⇒ 房间被天然岩层填实。
 *
 * 四档对照实测（含 final_state，空气总 29,803）：
 *   A 全写 29,803 / B 顶盖 10,599 / C 四向8格 5,681 / **D 16,358**。
 */
export function floodAir(map, bbox) {
  const [mnx, mxx, , , mnz, mxz] = bbox;
  const keep = new Set();
  let sky = 0;
  const byLayer = new Map();
  for (const [k, nm] of map) {
    if (!isAirSrc(nm)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (!byLayer.has(y)) byLayer.set(y, []);
    byLayer.get(y).push([x, z, k]);
  }
  for (const [y, arr] of byLayer) {
    const seen = new Set();
    const stack = [];
    for (const [x, z, k] of arr) {
      if (x === mnx || x === mxx || z === mnz || z === mxz) { seen.add(k); stack.push([x, z]); }
    }
    while (stack.length) {
      const [x, z] = stack.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < mnx || nx > mxx || nz < mnz || nz > mxz) continue;
        const kk = `${nx},${y},${nz}`;
        if (seen.has(kk)) continue;
        const v = map.get(kk);
        if (v !== undefined && !isAirSrc(v)) continue;   // 实心 ⇒ 不通
        seen.add(kk); stack.push([nx, nz]);
      }
    }
    for (const [, , k] of arr) { if (seen.has(k)) sky++; else keep.add(k); }
  }
  return { keep, sky };
}

/**
 * 支撑柱（pillar_processor 语义）：红玻璃 → 石砖，并向下补到地板层。
 *
 * ⚠️ **「遇保留空气即停」是载荷性的**：不停的话柱子会穿过房间地板插进室内
 * （实测 seed=263 有 414 格穿房间）。加上这条后 0 格穿房间。
 */
function addPillars(out, raw, keep) {
  let roots = 0, cells = 0, maxLen = 0, intoRoom = 0;
  for (const [k, nm] of raw) {
    if (nm !== 'red_stained_glass') continue;
    const [x, y, z] = k.split(',').map(Number);
    roots++;
    let n = 0;
    for (let yy = y - 1; yy >= STRUCT_FLOOR_Y; yy--) {
      const kk = `${x},${yy},${z}`;
      if (SOLID_SRC(raw.get(kk))) break;
      // ⚠️ **不穿房间地板**：去掉这条会有 173 格柱格落进 keep（实测）。
      //    `intoRoom` 统计「**已写入的柱格** ∈ keep」（review M1：旧版声明后从未累加，
      //    是死指标）。注意不能统计「停住的那一格」—— 它本就没被写，永远不算穿房间。
      if (keep.has(kk)) break;
      if (!out.has(kk) || out.get(kk) === 'air') {
        out.set(kk, 'stone_bricks'); n++;
        if (keep.has(kk)) intoRoom++;
      }
    }
    cells += n;
    if (n > maxLen) maxLen = n;
  }
  return { roots, cells, maxLen, intoRoom };
}

/**
 * 石砖族四色分配（确定性）—— 作用在**已映射的目标名** `stone_bricks` 上。
 *
 * ⚠️ **阈值用累加后的字面量，不用浮点累加值**：0.5+0.25+0.05 在 IEEE754 下
 * 是 0.80000000000000004441，与 0.8 不同；而 `r < t` 的边界格会因此归档不同。
 * 实测两种写法差 **268 格**（mossy 30235 vs 30503）—— 总数相同、分布不同，
 * 是静默的确定性漂移。故阈值先 toFixed(10) 归整再比。
 */
function assignStoneVariants(cells) {
  const rand = mulberry32(STONE_VARIANTS.seed);
  const cum = [];
  let acc = 0;
  for (const b of STONE_VARIANTS.bands) {
    acc += b.p;
    cum.push({ t: Number(acc.toFixed(10)), block: b.block });
  }
  for (const [, c] of cells) {
    if (c.block !== 'stone_bricks') continue;
    const r = rand();
    let pick = cum[cum.length - 1].block;
    for (const b of cum) { if (r < b.t) { pick = b.block; break; } }
    c.block = pick;
  }
}

/**
 * 藤蔓（忠实复刻 StructureVineAndLeaves 的生长部分）。
 *
 * 三个钳制**都是载荷性的**，缺一条就静默退化（实测）：
 *   ① footprint 钳制：xz±3 偏移会伸到占地外 ⇒ bbox 159→160、HALF_X 80→81
 *     （AGENTS.md「产物 bbox ≠ footprint bbox」同形坑）；
 *   ② 地下 keep 约束：地板层以下的天空藤蔓会被地形整形填石埋掉（实测 582 格）；
 *   ③ 允许在**天空空气**里长（只要有水平实心邻居可依附）：
 *     只允许 keep 内生长 ⇒ vine 从 2029 掉到 829；更严的写法只出 218。
 *     藤蔓本来就长在墙外天空里（498 个 vines 点里 317 个在天空）。
 *
 * @param {Map} cells 基线产物（目标名，含 air / 实心 / 柱）
 * @param {Set} keep 房间内腔空气集合（结构坐标键）
 * @param {number[]} bbox [mnx,mxx,mny,mxy,mnz,mxz]
 */
function addVines(cells, keep, bbox, placed) {
  const [mnx, mxx, , , mnz, mxz] = bbox;
  const rand = mulberry32(VINE_PARAMS.seed);
  const ri = (n) => Math.floor(rand() * n);
  const { attempts, length, xzRange, ySpan, pools } = VINE_PARAMS;

  const solidAt = (x, y, z) => {
    const c = cells.get(`${x},${y},${z}`);
    return c !== undefined && c.block !== 'air' && c.block !== 'vine';
  };
  const freeAt = (x, y, z) => {
    const c = cells.get(`${x},${y},${z}`);
    return c === undefined || c.block === 'air';
  };
  const hasWall = (x, y, z) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solidAt(x + dx, y, z + dz));

  const spots = [];
  for (const p of placed) {
    const proto = PIECES.get(p.name);
    for (const j of proto.jigs) {
      if (!pools.includes(j.pool)) continue;
      spots.push(rotPos(j.pos, p.rot, proto.size).map((v, k) => v + p.o[k]));
    }
  }

  let count = 0, intoKeep = 0, sky = 0;
  for (const [ox, oy, oz] of spots) {
    for (let i = 0; i < attempts; i++) {
      const x = ox + ri(2 * xzRange + 1) - xzRange;
      const y = oy + ri(ySpan) - 1;
      const z = oz + ri(2 * xzRange + 1) - xzRange;
      if (x < mnx || x > mxx || z < mnz || z > mxz) continue;      // ① footprint 钳制
      if (y < STRUCT_FLOOR_Y && !keep.has(`${x},${y},${z}`)) continue;  // ② 地下只在房间内
      if (!freeAt(x, y, z)) continue;
      // 偏向上界（同上游）：length - ri(ri(length)+1)
      const maxLen = length - ri(ri(length) + 1);
      for (let yy = y; yy > y - maxLen; yy--) {
        if (yy < STRUCT_FLOOR_Y && !keep.has(`${x},${yy},${z}`)) break;
        if (!freeAt(x, yy, z)) break;
        if (!hasWall(x, yy, z)) break;                            // canSurvive
        const kk = `${x},${yy},${z}`;
        if (keep.has(kk)) intoKeep++; else sky++;
        cells.set(kk, { block: 'vine', meta: 0 });                // ③ 天空也可长
        count++;
      }
    }
  }
  return { spots: spots.length, count, intoKeep, sky };
}

/** facing 随件旋转后再查 FACING_TO_ORIENT */
const FACING_VEC = Object.freeze({ west: [-1, 0], east: [1, 0], south: [0, 1], north: [0, -1] });
function rotatedFacing(facing, rot) {
  const d = FACING_VEC[facing];
  if (!d) throw new Error(`台阶 facing 未知：${facing}`);
  const [dx, dz] = [d[0], d[1]];
  let r;
  switch (rot) {
    case 1: r = [-dz, dx]; break;
    case 2: r = [-dx, -dz]; break;
    case 3: r = [dz, -dx]; break;
    default: r = [dx, dz];
  }
  return r[0] === -1 ? 'west' : r[0] === 1 ? 'east' : r[1] === 1 ? 'south' : 'north';
}

/**
 * 物化：拼装结果 → 目标方块格 Map（含空气分层 / 支撑柱 / 变体 / 台阶朝向）。
 * @returns {{cells:Map<string,{block:string,meta:number}>, stats:object}}
 */
export function materialize(placed) {
  const raw = materializeRaw(placed);
  const bbox = cellBBox(raw);
  const { keep, sky } = floodAir(raw, bbox);

  const out = new Map();
  for (const [k, nm] of raw) {
    if (isAirSrc(nm)) { if (keep.has(k)) out.set(k, 'air'); continue; }
    if (nm === 'structure_void' || nm === 'spawner') continue;
    out.set(k, nm === 'red_stained_glass' ? 'stone_bricks' : nm);
  }
  const pillarStats = addPillars(out, raw, keep);

  // 顺序载荷性：① 映射到目标名 → ② 算台阶朝向（此时台阶还是 cobblestone_step）
  // → ③ 石砖族四色分配（只改 block === 'stone_bricks'，不碰台阶）。
  // 把③提到②之前会让台阶被改名后再统计 ⇒ 朝向直方图出现 mossy_stone:1 这类假档。
  const cells = new Map();
  for (const [k, block] of out) {
    const mapped = BLOCK_MAP[block];
    if (mapped === undefined) throw new Error(`未映射的源方块：${block}`);
    cells.set(k, { block: mapped, meta: 0 });
  }
  // 台阶朝向：逐件逐格算（facing 要随件旋转）。
  // ⚠️ **只统计「最终仍是台阶」的格**：makeColumnSetter 后写胜，实测 159 个台阶格次里
  // 有 3 个被后写件盖掉 ⇒ 产物只剩 156。逐件累加会把那 3 个也计入，
  // 且它们的 cur.block 已是别人的方块 ⇒ 直方图出现 stone_bricks:1 这类假档。
  const stepOrient = new Map();
  for (const p of placed) {
    const proto = PIECES.get(p.name);
    for (const c of proto.cells) {
      if (!/_stairs$/.test(c.nm)) continue;
      const w = rotPos(c.pos, p.rot, proto.size).map((v, k) => v + p.o[k]);
      const k = w.join(',');
      const cur = cells.get(k);
      if (!cur || cur.block !== 'cobblestone_step') continue;   // 被后写胜盖掉 ⇒ 不计
      const orient = FACING_TO_ORIENT[rotatedFacing(c.props.facing, p.rot)];
      cur.meta = orient;
      const hk = `${cur.block}:${orient}`;
      stepOrient.set(hk, (stepOrient.get(hk) || 0) + 1);
    }
  }
  assignStoneVariants(cells);

  // 藤蔓（在变体分配之后：它只占 air/天空，不碰石砖族，顺序不敏感；
  // 但必须在台阶朝向之后，否则藤蔓可能盖掉台阶格）
  const vineStats = addVines(cells, keep, bbox, placed);

  // 栏杆朝向 pass（**必须在藤蔓之后**：支撑邻居判据要排除 vine，
  // 先算朝向会把还没长出的藤蔓当空气 ⇒ 孤立段兜底方向不同）。
  const railOrient = computeRailOrientations(cells);
  for (const [k, hit] of railOrient) {
    const cur = cells.get(k);
    if (!cur || cur.block !== 'vertical_pillar') {
      throw new Error(`栏杆朝向 pass 命中了非 vertical_pillar：${k} → ${cur?.block}`);
    }
    cur.block = hit.name;
    cur.meta = hit.orient;
  }

  return {
    cells, bbox, keep, sky,
    stats: {
      ...pillarStats,
      stepOrient: Object.fromEntries([...stepOrient.entries()].sort()),
      vine: vineStats,
      rail: railHistogram(railOrient),
      railTotal: railOrient.size,
    },
  };
}

// ---------------------------------------------------------------- 普查

function census() {
  const { placed } = assembleJungleFortress();
  const hist = pieceHistogram(placed);
  const bb = placedBBox(placed);
  const M = JUNGLE_FORTRESS_METRICS.jungleFortress;
  const failures = [];

  console.log(`素材：${JUNGLE_FORTRESS_PIECES.length} 片`);
  console.log(`拼装：seed=${JUNGLE_FORTRESS_ASSEMBLE.seed} size=${JUNGLE_FORTRESS_ASSEMBLE.size} boxRange=${JUNGLE_FORTRESS_ASSEMBLE.boxRange}`);
  console.log(`\n件数 ${placed.length} / 件种 ${Object.keys(hist).length}`);
  console.log(`包围盒 ${bb.w}×${bb.h}×${bb.d}  x[${bb.mnx},${bb.mxx}] y[${bb.mny},${bb.mxy}] z[${bb.mnz},${bb.mxz}]`);
  console.log('\n件数直方图：');
  for (const [k, v] of Object.entries(hist)) console.log(`  ${k.padEnd(24)} ${v}`);

  // 逐件连接口数
  console.log('\n逐件连接口数（target=connection）：');
  for (const [nm, p] of PIECES) {
    console.log(`  ${nm.padEnd(24)} ${p.jigs.filter(isConnector).length}`);
  }

  // feature jigsaw 计数（Task 3 消费）
  const feat = new Map();
  for (const p of placed) {
    for (const j of PIECES.get(p.name).jigs) {
      if (isConnector(j)) continue;
      feat.set(j.pool, (feat.get(j.pool) || 0) + 1);
    }
  }
  console.log('\nfeature jigsaw（不参与拼装，Task 3 藤蔓消费）：');
  for (const [k, v] of [...feat.entries()].sort()) console.log(`  ${k.padEnd(24)} ${v}`);

  // 深度分布
  const dh = new Map();
  for (const p of placed) dh.set(p.depth, (dh.get(p.depth) || 0) + 1);
  console.log('\n深度分布：', JSON.stringify([...dh.entries()].sort((a, b) => a[0] - b[0])));

  // ---- 断言（Task 1 的冻结值）----
  if (placed.length !== M.pieceCount) failures.push(`件数 ${placed.length} ≠ ${M.pieceCount}`);
  if (Object.keys(hist).length !== M.pieceKinds) failures.push(`件种 ${Object.keys(hist).length} ≠ ${M.pieceKinds}`);
  const want = Object.fromEntries(Object.entries(M.pieceHist).sort());
  if (JSON.stringify(hist) !== JSON.stringify(want)) {
    failures.push(`件数直方图不符\n    实测 ${JSON.stringify(hist)}\n    冻结 ${JSON.stringify(want)}`);
  }
  if (Math.max(bb.w, bb.d) > 161) failures.push(`水平跨度 ${Math.max(bb.w, bb.d)} > 161（boxRange 失效？）`);

  // ---- 产物统计（Task 2 起）----
  const m = materialize(placed);
  const cnt = new Map();
  for (const [, c] of m.cells) cnt.set(c.block, (cnt.get(c.block) || 0) + 1);
  const [mnx, mxx, mny, mxy, mnz, mxz] = m.bbox;
  console.log("\n=== 产物 ===");
  console.log(`格数 ${m.cells.size}  air ${cnt.get("air")}  palette ${cnt.size}`);
  console.log(`bbox ${mxx-mnx+1}×${mxy-mny+1}×${mxz-mnz+1}  x[${mnx},${mxx}] y[${mny},${mxy}] z[${mnz},${mxz}]`);
  console.log(`天空空气丢弃 ${m.sky}  柱 ${m.stats.roots} 根 / ${m.stats.cells} 格（最长 ${m.stats.maxLen}，穿房间 ${m.stats.intoRoom}）`);
  console.log("palette:", JSON.stringify([...cnt.entries()].sort((a,b)=>b[1]-a[1])));
  console.log("台阶朝向:", JSON.stringify(m.stats.stepOrient));
  console.log(`栏杆 ${m.stats.railTotal} 格：${JSON.stringify(m.stats.rail)}`);
  console.log(`藤蔓 ${m.stats.vine.count} 格（keep 内 ${m.stats.vine.intoKeep} / 天空 ${m.stats.vine.sky}），源点 ${m.stats.vine.spots}`);
  if (M.contentCells !== undefined) {
    if (m.cells.size !== M.contentCells) failures.push(`产物格数 ${m.cells.size} ≠ ${M.contentCells}`);
    if ((cnt.get("air")||0) !== M.airCells) failures.push(`air 格数 ${cnt.get("air")||0} ≠ ${M.airCells}`);
    if (cnt.size !== M.paletteSize) failures.push(`palette ${cnt.size} ≠ ${M.paletteSize}`);
    for (const [k,v] of Object.entries(M.targetCounts||{})) {
      const got = cnt.get(k)||0;
      if (got !== v) failures.push(`"${k}" ${got} ≠ ${v}`);
    }
    const ws = Object.fromEntries(Object.entries(M.stepOrientationCounts||{}).sort());
    if (JSON.stringify(m.stats.stepOrient) !== JSON.stringify(ws)) {
      failures.push(`台阶朝向 ${JSON.stringify(m.stats.stepOrient)} ≠ ${JSON.stringify(ws)}`);
    }
  }

  console.log(`\n指纹 ${jungleFortressInputFingerprint().input}`);
  if (failures.length) {
    console.log(`\n✗ ${failures.length} 项不符：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ 拼装冻结值全部匹配');
  }
}

// ---------------------------------------------------------------- orient 现场校验

/**
 * 现场重测 orient → 台阶高侧方向（**真实 mesher**，不从任何定义推）。
 * AGENTS.md：台阶朝向只能用真实 mesher 实测定。
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
  const L = 8;
  const short = (s) => s.split('(')[0];
  const expected = Object.fromEntries(Object.entries(FACING_TO_ORIENT).map(([f, o]) => [o, f]));

  // 本结构实际用到的台阶方块（从 BLOCK_MAP 收集，不手写清单）
  const stepBlocks = [...new Set(Object.values(BLOCK_MAP).filter((b) => /_step$/.test(b)))].sort();
  let bad = 0;
  for (const name of stepBlocks) {
    const id = reg.idOf(name);
    if (id === undefined) { console.log(`✗ ${name} 未注册`); bad++; continue; }
    console.log(`\n=== ${name} ===`);
    const found = {};
    for (let orient = 0; orient < 4; orient++) {
      const data = new Uint16Array(VIEW ** 3);
      const meta = new Uint8Array(VIEW ** 3);
      const light = new Uint8Array(VIEW ** 3).fill(0xFF);
      data[idx(L + 1, L + 1, L + 1)] = id;
      meta[idx(L + 1, L + 1, L + 1)] = orient;
      const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (let i = 0; i < g.positions.length; i += 3) {
        const x = g.positions[i], y = g.positions[i + 1], z = g.positions[i + 2];
        if (y <= L + 0.5 + 1e-6) continue;      // 只取上半部（高侧）
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const spanX = mxx - mnx, spanZ = mxz - mnz;
      let side;
      if (spanX < 0.75 && spanZ > 0.75) side = ((mnx + mxx) / 2 - L) < 0.5 ? 'west(-X)' : 'east(+X)';
      else if (spanZ < 0.75 && spanX > 0.75) side = ((mnz + mxz) / 2 - L) < 0.5 ? 'north(-Z)' : 'south(+Z)';
      else side = `不确定(spanX=${spanX.toFixed(2)} spanZ=${spanZ.toFixed(2)})`;
      found[orient] = side;
      console.log(`  orient=${orient} → 高侧 ${side}`);
    }
    for (let o = 0; o < 4; o++) {
      if (short(found[o]) !== expected[o]) {
        console.log(`  ✗ orient=${o} 实测 ${found[o]}，FACING_TO_ORIENT 声明 ${expected[o]}`);
        bad++;
      }
    }
  }
  if (bad) { console.log(`\n✗ ${bad} 项不符`); process.exitCode = 1; }
  else console.log('\n✓ 全部与 FACING_TO_ORIENT 一致');
}

// ---------------------------------------------------------------- 烘焙

/**
 * 写产物：palette 索引压缩 + 逐格朝向（stride 5）。
 *
 * 归一化：x/z 相对结构中心（已是），y 从 minY 变 1。
 * ⚠️ **第 5 项 direction 必填**：台阶靠它携带 orient（stride 4 会静默丢朝向）。
 */
function bake() {
  const { placed } = assembleJungleFortress();
  const M = JUNGLE_FORTRESS_METRICS.jungleFortress;
  const m = materialize(placed);
  const [mnx, mxx, mny, mxy, mnz, mxz] = m.bbox;

  const palette = [];
  const paletteIndex = new Map();
  const blocks = [];
  const counts = new Map();

  // 按 y→z→x 排序保证 palette 首次出现顺序确定
  const sorted = [...m.cells.entries()].sort((a, b) => {
    const [ax, ay, az] = a[0].split(',').map(Number);
    const [bx, by, bz] = b[0].split(',').map(Number);
    return ay - by || az - bz || ax - bx;
  });
  for (const [k, c] of sorted) {
    const [x, y, z] = k.split(',').map(Number);
    if (c.block === '') continue;                 // 丢弃项
    let tpi = paletteIndex.get(c.block);
    if (tpi === undefined) { tpi = palette.length; palette.push(c.block); paletteIndex.set(c.block, tpi); }
    blocks.push(x, y - mny + 1, z, tpi, c.meta);
    counts.set(c.block, (counts.get(c.block) || 0) + 1);
  }

  const STRIDE = 5;
  const n = blocks.length / STRIDE;
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  const floorRow = STRUCT_FLOOR_Y - mny + 1;

  // ---- 产物契约断言（与 check:data 同口径，这里先自守一道）----
  const fail = [];
  if (n !== M.contentCells) fail.push(`格数 ${n} ≠ ${M.contentCells}`);
  if (palette.length !== M.paletteSize) fail.push(`palette ${palette.length} ≠ ${M.paletteSize}`);
  if (!palette.includes('air')) fail.push('palette 不含 air —— 房间会被天然岩层填满（DR-2）');
  if ((counts.get('air') || 0) !== M.airCells) fail.push(`air 格数 ${counts.get('air') || 0} ≠ ${M.airCells}`);
  if (W !== M.width || H !== M.height || D !== M.depth) fail.push(`bbox ${W}×${H}×${D} ≠ ${M.width}×${M.height}×${M.depth}`);
  if (floorRow !== M.floorRow) fail.push(`floorRow ${floorRow} ≠ ${M.floorRow}`);
  for (const [k, v] of Object.entries(M.targetCounts)) {
    const got = counts.get(k) || 0;
    if (got !== v) fail.push(`"${k}" 格数 ${got} ≠ 冻结 ${v}`);
  }
  const wantSteps = Object.fromEntries(Object.entries(M.stepOrientationCounts).sort());
  if (JSON.stringify(m.stats.stepOrient) !== JSON.stringify(wantSteps)) {
    fail.push(`台阶朝向 ${JSON.stringify(m.stats.stepOrient)} ≠ ${JSON.stringify(wantSteps)}`);
  }
  // 栏杆：朝向 pass 把 2682 格 vertical_pillar 拆成 handrailA（直段）+ handrail（转角），
  // 各自格数随算法浮动但**总数不变**（只改朝向不增删格）。
  const railTotal = (counts.get('handrail') || 0) + (counts.get('handrailA') || 0);
  if (railTotal !== M.railCells) fail.push(`栏杆总数 ${railTotal} ≠ ${M.railCells}（朝向 pass 增删了格？）`);
  if (m.stats.intoRoom !== 0) fail.push(`支撑柱穿房间 ${m.stats.intoRoom} 格 ≠ 0（「遇保留空气即停」被去掉？）`);
  if (palette.includes('handrailB')) fail.push('产物含 handrailB —— 其臂只伸到格中心、接不上邻居');
  if (palette.includes('vertical_pillar')) fail.push('产物仍含 vertical_pillar —— 栏杆朝向 pass 未生效');
  const wantRail = Object.fromEntries(Object.entries(M.railOrientationCounts).sort());
  if (JSON.stringify(m.stats.rail) !== JSON.stringify(wantRail)) {
    fail.push(`栏杆朝向 ${JSON.stringify(m.stats.rail)} ≠ ${JSON.stringify(wantRail)}`);
  }
  if (fail.length) {
    console.log('✗ 产物契约不符，不写盘：');
    for (const f of fail) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }

  const json = { version: 1, stride: STRIDE, floorRow, palette, blocks };
  const fp = jungleFortressInputFingerprint();
  const meta = {
    version: 1,
    width: W, height: H, depth: D,
    blocks: n,
    floorRow,
    airCells: counts.get('air') || 0,
    paletteSize: palette.length,
    pillarRoots: m.stats.roots,
    pillarCells: m.stats.cells,
    pillarMaxLen: m.stats.maxLen,
    skyAirDropped: m.sky,
    stepOrientationCounts: m.stats.stepOrient,
    railOrientationCounts: m.stats.rail,
    railCells: m.stats.railTotal,
    pieceCount: placed.length,
    pieceHist: pieceHistogram(placed),
    origin: { minY: mny },
    fingerprints: fp,
  };
  fs.mkdirSync(path.dirname(JUNGLE_FORTRESS_JSON), { recursive: true });
  fs.writeFileSync(JUNGLE_FORTRESS_JSON, JSON.stringify(json));
  fs.writeFileSync(JUNGLE_FORTRESS_META, `${JSON.stringify(meta, null, 2)}\n`);
  const mb = (fs.statSync(JUNGLE_FORTRESS_JSON).size / 1048576).toFixed(2);
  console.log(`丛林要塞 JSON ${mb} MB，${n} 格（含 air ${meta.airCells}），${W}×${H}×${D}，`);
  console.log(`palette ${palette.length} 种，floorRow ${floorRow}，柱 ${meta.pillarRoots} 根/${meta.pillarCells} 格（最长 ${meta.pillarMaxLen}）`);
  console.log(`台阶朝向：${JSON.stringify(meta.stepOrientationCounts)}`);
  console.log(`指纹 ${fp.input}`);
}

// ---------------------------------------------------------------- 入口

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--census')) {
    census();
  } else if (args.includes('--census-orient')) {
    await censusOrient();
  } else {
    bake();
  }
}