// tools/bake-medieval-ship.mjs — 把 Medieval Ship `.litematic` 烘焙成结构 JSON
// 用法：npm run ship                    烘焙 → assets/structures/medieval_ship.json + .meta.json
//       npm run ship -- --census        只打印源方块普查与本仓映射结果，不写文件
//       npm run ship -- --census-orient 现场重测 orient → 台阶高侧方向（校验 FACING_TO_ORIENT）
//
// ## 产物是什么（避免「烘焙 = 新美术资源」的误会）
// **不产生任何新贴图、不产生任何新几何定义**：只是把外部 `.litematic` 转成紧凑 JSON
// （palette 索引 + 扁平数组，stride 5 带朝向），映射目标全部是 registry 现有方块
// （唯二的 `planks_step_updown` / `half_block_updown` 是用户批准的新声明，它们复用
// 既有 `planks_birch` 贴图与既有盒式几何）。与 `bake-giant-pyramid.mjs` 同口径。
//
// ## 为什么输出 palette 扁平数组而不是 {x,y,z,type}
// 1264 格逐字写对象约 90KB；palette 索引压缩后约 20KB。`structure-json.js` 的
// `loadStructure` 已支持该形状（与巨型金字塔 / 高台地带同一格式）。
//
// ## 为什么朝向进 `meta` 而不是进方块名
// 本仓台阶朝向的唯一机制是 `meta` 低 2 位（`mesher.js` 的 `orient = meta & 3` + `FACE_ROT`）。
// 按朝向拆成 4 个方块名要在 blocks-data / faces-data / 图标 / 背包各增 4 份。
//
// ## 有意偏离素材的四处（详见 spec）
// ① **转角台阶**（`shape=inner_left/inner_right`，8 格）→ 直台阶近似：本仓 `TEMPLATES`
//    只有 L 形直台阶，新造转角几何属「按 Minecraft 定义推断」。与巨型金字塔同一取舍。
// ② **孤立 glass 格**（1 格，在 (0,0,9)）→ 丢弃：它距船体 15 格，是素材里的孤立标记物。
//    保留会把包围盒从 26 格拉宽到 37 格、让船心偏移 5 格（落点判据与 AABB 全跟着错）。
// ③ **台阶材质统一为木**：素材的 `smooth_sandstone_stairs`（71 格，浅色石）也映射到
//    `planks_step*`。理由 = 用户只批准了**一个**倒置台阶方块（木色），若按材质分流则
//    浅色石的倒置台阶要再加一个方块；且船体 570/1264 格是木，统一木色读作「全木船」。
// ④ **半砖颜色统一为浅木/沙色**：`sand_slab`（下半）与 `half_block_updown`（上半）
//    两者实测色距仅 24，故半砖的**轮廓**（半高）被忠实保留，但**逐材质颜色**不保留
//    （素材的 dark_oak_slab 是深色）。要按材质分流需再加 2 个半砖方块，用户未批准。
import fs from 'node:fs';
import path from 'node:path';
import { readLitematic, litematicIndex } from './litematic-reader.mjs';
import { rotateOffset } from '../src/mesh/mesher.js';
import { MEDIEVAL_SHIP_VARIANTS, MEDIEVAL_SHIP_METRICS } from '../src/gen/structures/medieval-ship-data.js';
import {
  LITEMATIC_PATH, SHIP_JSON, SHIP_META, BLOCK_MAP, SHIP_METRICS,
  FACING_TO_ORIENT, medievalShipInputFingerprint, readUserFixOverlay,
} from './medieval-ship-fingerprint.mjs';

/** Minecraft 方位 → 本仓 (dx, dz)（北 = -Z，与 `FACING_TO_ORIENT` 的高侧口径同源） */
const FACING_DXZ = Object.freeze({
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
});

/** 栅栏「臂方向」→ 本仓方向串（`railPlacementFor` 吃 `+X/-X/+Z/-Z`） */
const FENCE_ARM = Object.freeze({ east: '+X', west: '-X', south: '+Z', north: '-Z' });

/**
 * 一个 palette 条目 → `{block, meta}`；`null` = 丢弃（当作空气）。
 *
 * 未知名字**一律 throw**，不许静默丢弃 —— `makeColumnSetter` 对未注册方块名是静默
 * `return`，那格变 air，而**方块层面完全看不出是映射错了**（只表现为"船身上有个洞"）。
 *
 * ⚠️ 栅栏臂方向取**声明的 Properties**（`p[k]==='true'`），不查邻居 —— Minecraft 把
 * fence 的连接存进方块状态，那是权威；查邻居会因「邻居是原木/羊毛」而丢臂（实测素材里
 * 有 26 格 fence 声明连向非 fence 方块）。
 */
export function classify(name, props) {
  const p = props || {};

  // ① 台阶：half 决定正置/倒置，facing 决定 orient（两者共用同一张 FACING_TO_ORIENT）
  if (/_stairs$/.test(name)) {
    const orient = FACING_TO_ORIENT[p.facing];
    if (orient === undefined) {
      throw new Error(`台阶 facing 未知：「${p.facing ?? '(缺失)'}」（源方块 ${name}）—— 补 FACING_TO_ORIENT`);
    }
    // shape=inner_*/outer_* → 直台阶近似（偏离 ①）
    return { block: p.half === 'top' ? 'planks_step_updown' : 'planks_step', meta: orient };
  }

  // ② 半砖：bottom → 贴底半砖；top → 贴顶半砖；double → 对应整块
  if (/_slab$/.test(name)) {
    if (p.type === 'double') {
      const full = DOUBLE_SLAB_FULL[name];
      if (!full) throw new Error(`double 半砖未登记整块目标：${name}`);
      return { block: full, meta: 0 };
    }
    if (p.type === 'top') return { block: 'half_block_updown', meta: 0 };
    if (p.type === 'bottom') return { block: 'sand_slab', meta: 0 };
    throw new Error(`半砖 type 未知：「${p.type ?? '(缺失)'}」（源方块 ${name}）`);
  }

  // ③ 活板门：素材里全部是 `half=top`（甲板上的舱口盖）→ 贴顶半砖
  if (/_trapdoor$/.test(name)) {
    if (p.half !== 'top') throw new Error(`活板门 half 非 top：「${p.half}」（${name}）—— 补分支`);
    return { block: 'half_block_updown', meta: 0 };
  }

  // ④ 栅栏：按**声明的连接臂**反查栏杆件（臂方向权威在 arena.js，从 TEMPLATES 派生）
  if (/_fence$/.test(name)) {
    const arms = ['east', 'west', 'south', 'north']
      .filter((k) => p[k] === 'true')
      .map((k) => FENCE_ARM[k]);
    // 恰好两臂 → 直段（对向）或转角（垂直）；其余（0/1/3 臂）→ 纯立柱
    if (arms.length === 2) {
      const hit = railPlacementFor(arms);
      if (hit) return { block: hit.name, meta: hit.orient };
    }
    return { block: 'vertical_pillar', meta: 0 };
  }

  // ⑤ 梯子：本仓无梯子方块 → 细立柱（桅杆上的攀爬梯读作一根竖杆）
  if (name === 'ladder') return { block: 'vertical_pillar', meta: 0 };

  // ⑥ 名字直查映射表
  if (Object.prototype.hasOwnProperty.call(BLOCK_MAP, name)) {
    const target = BLOCK_MAP[name];
    return target === '' ? null : { block: target, meta: 0 };
  }

  throw new Error(`未映射的源方块：${name}（补 BLOCK_MAP 或加分类分支后重跑）`);
}

/** `type=double` 的半砖 → 整块（按材质就近，实测色距见 --census） */
const DOUBLE_SLAB_FULL = Object.freeze({
  oak_slab: 'oak_planks',
  smooth_sandstone_slab: 'sand',
});

// `railPlacementFor` 在 arena.js（臂方向从 TEMPLATES 派生的唯一实现，红线 1）。
// ⚠️ 顶层 import 会让 `--census` 也加载 mesher —— 那是纯函数模块，无副作用，可接受。
import { railPlacementFor } from '../src/gen/structures/arena.js';

// ---------------------------------------------------------------- 普查模式

function census() {
  const r = readLitematic(fs.readFileSync(LITEMATIC_PATH));
  const { x: SX, y: SY, z: SZ } = r.size;

  console.log(`素材：${path.relative(process.cwd(), LITEMATIC_PATH)}`);
  console.log(`region「${r.regionName}」（共 ${r.regionCount} 个），尺寸 ${SX}×${SY}×${SZ}，TotalBlocks ${r.totalBlocks}`);

  // 逐格 classify（与 bake 同口径：栅栏臂取声明 Properties，不依赖邻居）
  let unmapped = 0;
  const bySource = new Map();   // 源名 → 格数
  const byTarget = new Map();   // 目标名 → 格数
  for (let i = 0; i < r.blocks.length; i++) {
    const pi = r.blocks[i];
    if (!pi) continue;
    const name = r.palette[pi];
    bySource.set(name, (bySource.get(name) || 0) + 1);
    let res;
    try {
      res = classify(name, r.paletteProps[pi]);
    } catch (e) {
      unmapped++;
      console.log(`  ${name.padEnd(28)} → 【未映射】${e.message}`);
      continue;
    }
    if (res !== null) byTarget.set(res.block, (byTarget.get(res.block) || 0) + 1);
  }

  console.log('\n源方块 → 目标：');
  for (const [name, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    let label;
    try {
      const res = classify(name, null);
      label = res === null ? '丢弃（当空气）' : res.block;
    } catch { label = '【按 props 分流】'; }
    console.log(`  ${String(n).padStart(5)}  ${name.padEnd(28)} → ${label}`);
  }

  console.log('\n目标方块合计：');
  for (const [k, v] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${v}`);
  const solid = [...byTarget.values()].reduce((a, b) => a + b, 0);
  console.log(`  实心合计 ${solid}（SHIP_METRICS.blocks = ${SHIP_METRICS.blocks}，差 = 孤立丢弃格）`);
  console.log(`  palette 种类 ${byTarget.size}（SHIP_METRICS.paletteSize = ${SHIP_METRICS.paletteSize}）`);

  if (unmapped) {
    console.log(`\n✗ ${unmapped} 格未映射 —— 补映射后重跑`);
    process.exitCode = 1;
  } else {
    console.log('\n全部已映射');
  }
}

// ---------------------------------------------------------------- orient 现场校验

/**
 * 现场重测 `orient → 台阶高侧方向`，**同时校验正置与倒置两种几何**。
 *
 * 手法与 `bake-giant-pyramid.mjs --census-orient` 相同：给一个临时方块分别设 orient 0~3，
 * 用**真实 mesher** 发射顶点，取「y > 0.5 那半部」的 bbox，看半幅层落在哪个方向。
 *
 * ⚠️ **倒置台阶的半幅层在下半**（y < 0.5），所以要分别量上/下两半、取「不是全幅」的那一半。
 * 这条校验是「正置与倒置共用同一张 FACING_TO_ORIENT」这个设计前提的唯一证据 ——
 * 若两者高侧不一致，映射表就必须分成两张（用户明确要求「方向别错了」）。
 */
async function censusOrient() {
  const { buildSectionMesh } = await import('../src/mesh/mesher.js');
  const { createRegistry } = await import('../src/voxel/block-registry.js');
  const { BLOCKS } = await import('../src/voxel/blocks-data.js');

  const reg = createRegistry();
  for (const d of BLOCKS) reg.register(d.name, d);
  reg.freeze();

  const VIEW = 18;   // 16 + 2 halo
  const atlasMeta = { tiles: new Proxy({}, { get: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }) }) };
  const idx = (x, y, z) => x + z * VIEW + y * VIEW * VIEW;
  const LX = 8, LY = 8, LZ = 8;

  /** 量某方块某 orient 的「上半 bbox」与「下半 bbox」，返回哪一半是半幅（= 高侧所在） */
  function measure(blockName, geom, orient) {
    // 用真实方块（几何已声明），不注册临时探针 —— 这样校验的就是产物实际用的几何
    if (reg.geometryNameOf(reg.idOf(blockName)) !== geom) {
      throw new Error(`${blockName} 的几何不是 ${geom}（声明改动了？）`);
    }
    const data = new Uint16Array(VIEW ** 3);
    const meta = new Uint8Array(VIEW ** 3);
    const light = new Uint8Array(VIEW ** 3).fill(0xFF);
    data[idx(LX + 1, LY + 1, LZ + 1)] = reg.idOf(blockName);
    meta[idx(LX + 1, LY + 1, LZ + 1)] = orient;
    const g = buildSectionMesh({ data, light, meta }, reg, atlasMeta, 0, 0, 0).cutout;

    const half = (wantUpper) => {
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, n = 0;
      for (let i = 0; i < g.positions.length; i += 3) {
        const x = g.positions[i] - LX, y = g.positions[i + 1] - LY, z = g.positions[i + 2] - LZ;
        const upper = y > 0.5 + 1e-6;
        const lower = y < 0.5 - 1e-6;
        if (wantUpper ? !upper : !lower) continue;
        n++;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      if (!n) return null;
      return { mnx, mxx, mnz, mxz, spanX: mxx - mnx, spanZ: mxz - mnz };
    };
    const side = (b) => {
      if (!b) return '(无顶点)';
      if (b.spanX < 0.75 && b.spanZ > 0.75) return ((b.mnx + b.mxx) / 2) < 0.5 ? 'west' : 'east';
      if (b.spanZ < 0.75 && b.spanX > 0.75) return ((b.mnz + b.mxz) / 2) < 0.5 ? 'north' : 'south';
      return 'full';
    };
    const up = half(true), lo = half(false);
    const su = side(up), sl = side(lo);
    // 高侧 = 半幅的那一层所在方向（正置台阶半幅在上半，倒置在下半）
    const high = su !== 'full' ? su : sl !== 'full' ? sl : '不确定';
    return { up: su, lo: sl, high };
  }

  const CASES = [
    ['planks_step', 'planks_step'],
    ['planks_step_updown', 'planks_step_updown'],
  ];
  const expected = Object.fromEntries(Object.entries(FACING_TO_ORIENT).map(([f, o]) => [o, f]));
  let bad = 0;
  for (const [blockName, geom] of CASES) {
    console.log(`\n=== ${blockName}（几何 ${geom}）===`);
    for (let o = 0; o < 4; o++) {
      const r = measure(blockName, geom, o);
      const ok = r.high === expected[o];
      if (!ok) bad++;
      console.log(`  orient=${o}  上半=${r.up.padEnd(6)} 下半=${r.lo.padEnd(6)} → 高侧 ${r.high.padEnd(6)}` +
        ` ${ok ? '✓' : `✗（FACING_TO_ORIENT 声明 ${expected[o]}）`}`);
    }
  }
  console.log(bad
    ? `\n✗ ${bad} 项不符 —— 正置/倒置台阶的高侧不一致，FACING_TO_ORIENT 必须分成两张表`
    : '\n✓ 正置与倒置台阶的高侧逐 orient 一致，FACING_TO_ORIENT 可共用（设计前提成立）');
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- 烘焙（4 个旋转变体）

/**
 * 为什么烘焙 **4 个旋转变体**（`medieval_ship_o0..o3`）而不是运行期旋转：
 * ① 旋转在烘焙期用 mesher 导出的 `rotateOffset`（「朝向 → 几何」的**唯一权威**，
 *    红线 1）做一次，运行期零旋转逻辑 —— 若运行期再写一份坐标旋转公式，
 *    两份漂移会让「船身朝向与台阶朝向不一致」（静默，方块层面看不出）。
 * ② 旋转是加法群（已实测：`rotate(rotate(v,a),b) ≡ rotate(v,(a+b)%4)`）⇒
 *    整船旋转 o 后每格的 `orient_new = (orient_old + o) % 4`，与 mesher 的
 *    `rotateVertex` 逐位等价。
 * ③ 能直接复用 `rasterizeStructure`（它不认旋转参数）。
 */
function bake() {
  const r = readLitematic(fs.readFileSync(LITEMATIC_PATH));
  const M = SHIP_METRICS;
  const { x: SX, y: SY, z: SZ } = r.size;

  const piAt = (x, y, z) => {
    if (x < 0 || x >= SX || y < 0 || y >= SY || z < 0 || z >= SZ) return 0;
    return r.blocks[litematicIndex(r.size, x, y, z)];
  };
  const srcNameAt = (x, y, z) => { const pi = piAt(x, y, z); return pi ? r.palette[pi] : null; };

  // ---- 第一遍：算包围盒（**排除偏离 ②**：孤立 glass 标记物）----
  // 判据 = 「与任何其它非空气格都不相邻（26 邻域）」的孤立格一律不计入 bbox。
  // ⚠️ 不用「按方块名排除」：那会把素材里合法的孤立装饰件也误删，且名字清单是第二份权威。
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
  const dropped = [];
  for (let y = 0; y < SY; y++) {
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        if (!piAt(x, y, z)) continue;
        let adjacent = false;
        for (let dy = -1; dy <= 1 && !adjacent; dy++) {
          for (let dz = -1; dz <= 1 && !adjacent; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy && !dz) continue;
              if (piAt(x + dx, y + dy, z + dz)) { adjacent = true; break; }
            }
          }
        }
        if (!adjacent) { dropped.push(`${srcNameAt(x, y, z)}@(${x},${y},${z})`); continue; }
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
    }
  }
  if (dropped.length !== M.droppedCells) {
    throw new Error(`孤立格 ${dropped.length} 个（${dropped.join(', ')}）≠ SHIP_METRICS.droppedCells ${M.droppedCells}`);
  }

  // 原点：x/z 取包围盒中心，y 归一化到 1（`rasterizeStructure` 按 `y + b.y - 1` 落位）
  const OX = Math.floor((mnx + mxx) / 2);
  const OZ = Math.floor((mnz + mxz) / 2);

  // ---- 第二遍：逐格映射成「基准朝向 o=0 的格列表」（按 y→z→x，palette 顺序确定）----
  //
  // ⚠️ 这一遍只存**方块名**（不存 palette 下标）：用户修复叠加层要在本遍之后施加，
  // 而它可能引入原 palette 里没有的方块名 ⇒ palette 必须等叠加层施加完才能定稿。
  const baseCells = [];   // {x, y, z, name, meta}（相对原点，y 已归一化）
  // 按**源方块类别**计数（不是按目标方块）：栅栏与梯子都落到 vertical_pillar，
  // 按目标数会把两者混在一起、失去判别力。⚠️ 这是**分类阶段**的计数，不受叠加层影响。
  const srcCounts = { stairs: 0, slab: 0, fence: 0, ladder: 0, trapdoor: 0 };

  for (let y = mny; y <= mxy; y++) {
    for (let z = mnz; z <= mxz; z++) {
      for (let x = mnx; x <= mxx; x++) {
        const pi = piAt(x, y, z);
        if (!pi) continue;
        // 孤立格跳过（与 bbox 同一判据；实测只有那 1 格）
        if (dropped.some((d) => d.endsWith(`@(${x},${y},${z})`))) continue;

        const name = r.palette[pi];
        const props = r.paletteProps[pi];
        const res = classify(name, props);
        if (res === null) continue;

        if (/_stairs$/.test(name)) srcCounts.stairs++;
        else if (/_slab$/.test(name)) srcCounts.slab++;
        else if (/_fence$/.test(name)) srcCounts.fence++;
        else if (name === 'ladder') srcCounts.ladder++;
        else if (/_trapdoor$/.test(name)) srcCounts.trapdoor++;

        baseCells.push({ x: x - OX, y: y - mny + 1, z: z - OZ, name: res.block, meta: res.meta });
      }
    }
  }

  // ---- 第二遍半：施加用户的手工修复叠加层（**旋转之前**）----
  //
  // 用户在真实游戏里逐格改好了一艘船（seed 14330926，抽到 o0 变体），要求
  // 「完全按照我修复的样子固化下来」。叠加层坐标空间 = **o0 产物的局部坐标**，
  // 而 o0 的重新居中偏移实测是 (0, 0)（bbox 关于原点对称：x[-18,18] / z[-5,5]）
  // ⇒ o0 产物坐标 == baseCells 坐标，可直接施加。
  //
  // ⚠️ **那个偏移是载荷性前提，必须显式断言**：若将来素材换了、bbox 变成偶数跨度，
  // 偏移会不再是 0，叠加层就会整体错位一格（**静默**：产物照样烘得出来、格数也对，
  // 只是栏杆长在了错的位置）。故这里算出偏移并 throw，而不是默默假设它是 0。
  //
  // ⚠️ **必须在旋转之前施加**：旋转是加法群（已实测），故施加在 baseCells 上 ⇒
  // 4 个变体自动带上同一份修复（坐标与 orient 一起转）。若在各变体上分别施加，
  // 就要为每个朝向各存一份叠加层（4 份会漂移，红线 1）。
  const overlay = readUserFixOverlay();
  const o0ShiftX = Math.floor((mnx - OX + mxx - OX) / 2);
  const o0ShiftZ = Math.floor((mnz - OZ + mxz - OZ) / 2);
  if (o0ShiftX !== 0 || o0ShiftZ !== 0) {
    throw new Error(
      `o0 的重新居中偏移是 (${o0ShiftX}, ${o0ShiftZ}) 而不是 (0, 0) —— `
      + '用户修复叠加层的坐标空间（= o0 产物局部坐标）与 baseCells 不再重合，'
      + '直接施加会整体错位。修法：把叠加层坐标加上这个偏移，或重新从用户存档导出叠加层。',
    );
  }

  const cellIndex = new Map();   // 'x,y,z' → baseCells 下标
  baseCells.forEach((c, i) => cellIndex.set(`${c.x},${c.y},${c.z}`, i));

  let overlaySet = 0;
  let overlayAdded = 0;
  for (const [x, y, z, name, meta] of overlay.set) {
    const key = `${x},${y},${z}`;
    const hit = cellIndex.get(key);
    if (hit === undefined) {
      baseCells.push({ x, y, z, name, meta });
      cellIndex.set(key, baseCells.length - 1);
      overlayAdded++;
    } else {
      baseCells[hit].name = name;
      baseCells[hit].meta = meta;
    }
    overlaySet++;
  }
  let overlayRemoved = 0;
  for (const [x, y, z] of overlay.remove) {
    const key = `${x},${y},${z}`;
    const hit = cellIndex.get(key);
    // ⚠️ **删除目标必须存在**：找不到就说明坐标空间算错了（或叠加层与素材不同步）。
    // 静默跳过会让「删掉那格」这个用户意图丢失，而产物看起来完全正常。
    if (hit === undefined) {
      throw new Error(`用户修复叠加层要删除 (${x},${y},${z})，但 baseCells 里没有这一格 —— 坐标空间不同步`);
    }
    cellIndex.delete(key);
    baseCells[hit] = null;   // 打洞，稍后过滤（避免 splice 让 cellIndex 的下标全部失效）
    overlayRemoved++;
  }
  const fixedCells = baseCells.filter(Boolean);
  // 恢复确定性顺序（叠加层新增的格挂在末尾，删除留下的洞已过滤）
  fixedCells.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);

  if (overlaySet !== M.userFixSetCells) {
    throw new Error(`叠加层 set ${overlaySet} 条 ≠ SHIP_METRICS.userFixSetCells ${M.userFixSetCells}`);
  }
  if (overlayRemoved !== M.userFixRemoveCells) {
    throw new Error(`叠加层 remove ${overlayRemoved} 条 ≠ SHIP_METRICS.userFixRemoveCells ${M.userFixRemoveCells}`);
  }

  // ---- palette 定稿 + 目标方块计数（**必须在叠加层之后**，否则计数是修复前的）----
  const palette = [];
  const paletteIndex = new Map();
  const counts = new Map();
  const stepOrientCounts = new Map();
  const railCounts = new Map();
  for (const c of fixedCells) {
    let tpi = paletteIndex.get(c.name);
    if (tpi === undefined) {
      tpi = palette.length;
      palette.push(c.name);
      paletteIndex.set(c.name, tpi);
    }
    c.tpi = tpi;
    counts.set(c.name, (counts.get(c.name) || 0) + 1);
    if (c.name === 'planks_step' || c.name === 'planks_step_updown') {
      const k = `${c.name}:${c.meta}`;
      stepOrientCounts.set(k, (stepOrientCounts.get(k) || 0) + 1);
    }
    if (c.name === 'handrail' || c.name === 'handrailA') {
      const k = `${c.name}:${c.meta}`;
      railCounts.set(k, (railCounts.get(k) || 0) + 1);
    }
  }
  console.log(`用户修复叠加层：写入 ${overlaySet} 格（其中新增 ${overlayAdded}）/ 删除 ${overlayRemoved} 格`);

  // ---- 产物契约断言（基准变体，与 check:data 同口径，这里先自守一道）----
  // ⚠️ 用 `fixedCells`（已施加用户修复）：修复净增 0 格（106 写入含 6 新增 − 6 删除），
  // 所以这个数与修复前相同 —— 但必须从修复后的集合算，否则「删了格却没反映到计数」拓不到。
  const n = fixedCells.length;
  if (n !== M.blocks) {
    throw new Error(`方块数 ${n} ≠ SHIP_METRICS.blocks ${M.blocks}（源方块/映射改动？先跑 --census）`);
  }
  if (palette.length !== M.paletteSize) {
    throw new Error(`palette 有 ${palette.length} 种（${palette.join(', ')}）≠ SHIP_METRICS.paletteSize ${M.paletteSize}`);
  }
  const W = mxx - mnx + 1, H = mxy - mny + 1, D = mxz - mnz + 1;
  if (W !== M.width || H !== M.height || D !== M.depth) {
    throw new Error(`包围盒 ${W}×${H}×${D} ≠ SHIP_METRICS ${M.width}×${M.height}×${M.depth}`);
  }
  const stepCells = (counts.get('planks_step') || 0) + (counts.get('planks_step_updown') || 0);
  const slabCells = (counts.get('sand_slab') || 0) + (counts.get('half_block_updown') || 0);
  const fenceCells = srcCounts.fence;
  if (stepCells !== M.stepCells) throw new Error(`台阶 ${stepCells} ≠ SHIP_METRICS.stepCells ${M.stepCells}`);
  if (srcCounts.stairs !== M.stepCells) throw new Error(`源台阶 ${srcCounts.stairs} ≠ stepCells ${M.stepCells}`);
  if (slabCells !== M.slabCells) throw new Error(`半砖 ${slabCells} ≠ SHIP_METRICS.slabCells ${M.slabCells}`);
  if (fenceCells !== M.fenceCells) throw new Error(`源栅栏 ${fenceCells} ≠ SHIP_METRICS.fenceCells ${M.fenceCells}`);
  if (srcCounts.ladder !== M.ladderCells) throw new Error(`源梯子 ${srcCounts.ladder} ≠ SHIP_METRICS.ladderCells ${M.ladderCells}`);
  // 朝向分布断言：倒置台阶（137 格）四向俱全；正置台阶（11 格）素材里只有 west/east
  // 两个 facing，故只断言「至少两个不同朝向」—— 写死四向会在素材不变时误报。
  // （只钉总数抓不到「全部 orient=0」这类静默缺陷，故仍要钉朝向多样性。）
  const updownOrients = new Set([0, 1, 2, 3].filter((o) => stepOrientCounts.has(`planks_step_updown:${o}`)));
  if (updownOrients.size !== 4) throw new Error(`倒置台阶朝向只有 ${[...updownOrients]}（应四向俱全）`);
  const stepOrients = new Set([0, 1, 2, 3].filter((o) => stepOrientCounts.has(`planks_step:${o}`)));
  if (stepOrients.size < 2) throw new Error(`正置台阶朝向只有 ${[...stepOrients]}（应至少两向）`);

  // ⚠️ **栏杆类目标计数是「叠加层有没有被施加」的唯一判据**（SHIP_METRICS.railCells 的注释）：
  // 用户修复的净效果是格数/bbox/源计数/palette 种类全部不变，只有栏杆三兄弟的目标分布变。
  // 漏掉叠加层时这里会报「handrail 21 ≠ 6」—— 正是想要的防线。
  for (const [name, want] of Object.entries(M.railCells)) {
    const got = counts.get(name) || 0;
    if (got !== want) {
      throw new Error(`栏杆类 "${name}" ${got} 格 ≠ SHIP_METRICS.railCells ${want}（用户修复叠加层没施加？跑 npm run ship）`);
    }
  }

  // ---- 生成 4 个旋转变体并写盘 ----
  const fp = medievalShipInputFingerprint();
  const STRIDE = 5;
  const variantMetas = {};
  for (let o = 0; o < 4; o++) {
    const variantName = MEDIEVAL_SHIP_VARIANTS[o];
    // 旋转每格：位置绕原点转 o，orient 加 o（加法群，已实测）。
    // ⚠️ 用 `fixedCells`（已施加用户修复）而不是原始 baseCells —— 这样 4 个变体
    // 都带上同一份修复（坐标与 orient 一起转）。
    const rotated = fixedCells.map((c) => {
      const [rx, , rz] = rotateOffset(c.x, 0, c.z, o);
      return { x: rx, y: c.y, z: rz, tpi: c.tpi, meta: (c.meta + o) & 3 };
    });
    // 旋转后重新居中：平移使 bbox 关于原点对称（与基准变体同口径）
    let rMnx = Infinity, rMxx = -Infinity, rMnz = Infinity, rMxz = -Infinity;
    for (const c of rotated) {
      if (c.x < rMnx) rMnx = c.x; if (c.x > rMxx) rMxx = c.x;
      if (c.z < rMnz) rMnz = c.z; if (c.z > rMxz) rMxz = c.z;
    }
    const shiftX = Math.floor((rMnx + rMxx) / 2);
    const shiftZ = Math.floor((rMnz + rMxz) / 2);
    const blocks = [];
    for (const c of rotated) {
      blocks.push(c.x - shiftX, c.y, c.z - shiftZ, c.tpi, c.meta);
    }
    const vW = rMxx - rMnx + 1, vD = rMxz - rMnz + 1;

    // 与 MEDIEVAL_SHIP_METRICS 双向断言（产物契约，防旋转逻辑改坏）
    const want = MEDIEVAL_SHIP_METRICS[variantName];
    if (vW !== want.width || vD !== want.depth || H !== want.height || n !== want.blocks) {
      throw new Error(`${variantName} 实测 ${vW}×${H}×${vD}/${n} 格 ≠ MEDIEVAL_SHIP_METRICS ${want.width}×${want.height}×${want.depth}/${want.blocks}`);
    }

    const json = { version: 2, stride: STRIDE, sourceBlocks: r.totalBlocks, palette, blocks };
    const jsonPath = SHIP_JSON.replace(/\.json$/, `_o${o}.json`);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(json));

    variantMetas[variantName] = {
      width: vW, height: H, depth: vD, blocks: n,
      originShift: { x: shiftX, z: shiftZ },
    };
    console.log(`  ${variantName}: ${vW}×${H}×${vD}，${n} 格，${(fs.statSync(jsonPath).size / 1024).toFixed(1)} KB`);
  }

  const meta = {
    version: 1,
    sourceBlocks: r.totalBlocks,
    regionName: r.regionName,
    width: W, height: H, depth: D,
    blocks: n,
    droppedCells: dropped.length,
    dropped: dropped,
    stepCells, slabCells, fenceCells,
    ladderCells: srcCounts.ladder,
    trapdoorCells: srcCounts.trapdoor,
    paletteSize: palette.length,
    // 用户修复叠加层的施加记录（供验收报告与诊断；门禁不读它，读的是产物本身）
    userFix: {
      set: overlaySet, added: overlayAdded, removed: overlayRemoved,
      source: 'assets/medieval-ship/src/user-fix-o0.json',
    },
    variants: variantMetas,
    counts: Object.fromEntries([...counts.entries()].sort()),
    stepOrientationCounts: Object.fromEntries([...stepOrientCounts.entries()].sort()),
    railOrientationCounts: Object.fromEntries([...railCounts.entries()].sort()),
    origin: { cx: OX, cz: OZ, minY: mny },
    fingerprints: fp,
  };
  fs.writeFileSync(SHIP_META, `${JSON.stringify(meta, null, 2)}\n`);

  console.log(`中世纪船 4 个旋转变体已写盘，基准 ${W}×${H}×${D}，palette ${palette.length} 种`);
  console.log(`  台阶 ${stepCells}（正置 ${counts.get('planks_step') || 0} / 倒置 ${counts.get('planks_step_updown') || 0}）` +
    ` 半砖 ${slabCells}（下 ${counts.get('sand_slab') || 0} / 上 ${counts.get('half_block_updown') || 0}，含活板门 ${srcCounts.trapdoor}）` +
    ` 栅栏 ${fenceCells} + 梯子 ${srcCounts.ladder}（handrail ${counts.get('handrail') || 0} / handrailA ${counts.get('handrailA') || 0} / 立柱 ${counts.get('vertical_pillar') || 0}）`);
  console.log(`  丢弃孤立格 ${dropped.length}：${dropped.join(', ')}`);
  console.log(`  台阶朝向分布：${JSON.stringify(meta.stepOrientationCounts)}`);
  console.log(`  栏杆朝向分布：${JSON.stringify(meta.railOrientationCounts)}`);
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
