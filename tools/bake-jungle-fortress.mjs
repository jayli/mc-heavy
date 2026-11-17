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
import {
  JUNGLE_FORTRESS_SOURCE_DIR, JUNGLE_FORTRESS_PIECES,
  JUNGLE_FORTRESS_ASSEMBLE, JUNGLE_FORTRESS_POOL_WEIGHTS, JUNGLE_FORTRESS_POOL_FALLBACK,
  JUNGLE_FORTRESS_METRICS, jungleFortressInputFingerprint,
} from './jungle-fortress-fingerprint.mjs';

/** 确定性 PRNG（不用 Math.random —— 定版布局必须可复现） */
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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
  const rand = mulberry32(seed);
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

  console.log(`\n指纹 ${jungleFortressInputFingerprint().input}`);
  if (failures.length) {
    console.log(`\n✗ ${failures.length} 项不符：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ 拼装冻结值全部匹配');
  }
}

// ---------------------------------------------------------------- 入口

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--census')) {
    census();
  } else {
    console.log('产物烘焙在 Task 2 实现；当前只支持 --census');
    process.exitCode = 1;
  }
}