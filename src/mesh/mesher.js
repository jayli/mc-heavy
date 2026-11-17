// src/mesh/mesher.js — 逐面网格化（§4.3，DR-15）
// Worker/主线程同构：本文件不得 import three。
import { getFaceTile } from '../voxel/faces-data.js';
import { SECTION_SIZE } from '../voxel/constants.js';
import { DEBUG_FLAGS } from '../core/debug-config.js';

// 面方向：0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
const FACE_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

// 每面的 4 个顶点（section 局部坐标，单位 cube）
// 顶点顺序：逆时针（从面外向内看）
// v1.26 导出：背包图标烘焙（tools/bake-icon-atlas.mjs）需要单位立方体的顶点与 UV——
// 97 个实心方块无 TEMPLATES 模板，等轴测图标走 cubeQuads() fallback。**形状与 UV 的
// 唯一权威在这里**（红线 1），iso-icon.js 只 import 不另写第二份定义。
// 加 export 不改任何几何定义，不影响 buildSectionMesh 的消费路径（与 v1.24 给
// TEMPLATES 加 export 同模式）。
export const FACE_VERTICES = [
  // +X
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
  // -X
  [[0,0,1],[0,1,1],[0,1,0],[0,0,0]],
  // +Y
  [[0,1,1],[1,1,1],[1,1,0],[0,1,0]],
  // -Y
  [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],
  // +Z
  [[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  // -Z
  [[1,0,0],[0,0,0],[0,1,0],[1,1,0]],
];

// 每面的 UV 角点（对应 FACE_VERTICES 的 4 个顶点）。
// 口径 = three.js BoxGeometry buildPlane（vendor/three r185.1 源码核验），与 mc-lite
// InstancedMesh 的 UV 一致：+X: u=1-z, v=y；-X: u=z, v=y；+Y: u=x, v=1-z；
// -Y: u=x, v=z；+Z: u=x, v=y；-Z: u=1-x, v=y。
// （历史 bug：±X 曾用统一 [0,0],[1,0],[1,1],[0,1] → 东西面贴图旋转 90°。）
// v1.26 导出：iso-icon.js 的等轴测图标复用此表（消除 v1.24 的 ISO_FACE_UVS 第二份副本）。
export const FACE_UVS = [
  [[1,0],[1,1],[0,1],[0,0]], // +X
  [[1,0],[1,1],[0,1],[0,0]], // -X
  [[0,0],[1,0],[1,1],[0,1]], // +Y
  [[0,0],[1,0],[1,1],[0,1]], // -Y
  [[0,0],[1,0],[1,1],[0,1]], // +Z
  [[0,0],[1,0],[1,1],[0,1]], // -Z
];

function viewIdx(dx, dy, dz) { return dx + dz * 18 + dy * 324; }

// atlas 完全缺失时的兜底 UV（防 tile 查表落空 crash；正常路径总有 tiles['stone']）
const DEFAULT_TILE = { u0: 0, v0: 0, u1: 0.01, v1: 0.01 };

// ---------------------------------------------------------------------------
// 朝向渲染消费（§4.3）：meta 低 2 位 = orientation 0-3，yaw = orientation × 90°
// （mc-lite OrientationUtils 语义，俯视逆时针）。渲染侧无条件消费——与 mc-lite
// ChunkConsolidation.js:530 逐实例应用 b.orientation 一致。
// 实现口径：按「模型面」迭代——tile/床 UV 变换查模型面（贴图随方块转）；顶点绕
// 块中心旋转；面剔除/光照/AO/packed face 位用世界面（模型面经同一旋转映射，双射）。
// ---------------------------------------------------------------------------

/**
 * 局部偏移（相对块中心）按 90° 步长绕 Y 轴旋转：o=1: (dx,dy,dz)→(dz,dy,-dx)
 *
 * **导出供烘焙脚本复用**（`tools/bake-arena.mjs` 的栏杆臂方向推导）：这是「朝向 → 几何」
 * 的唯一权威。烘焙侧若自己写一份旋转公式，会漂移出「产物写 orient=1、渲染转到另一个
 * 方向」的静默缺陷 —— 方块层面完全看不出，只有栏杆断口能看出（红线 1 精神）。
 */
export function rotateOffset(dx, dy, dz, o) {
  switch (o) {
    case 1: return [dz, dy, -dx];
    case 2: return [-dx, dy, -dz];
    case 3: return [-dz, dy, dx];
    default: return [dx, dy, dz];
  }
}

/** 格内顶点（0..1 局部坐标）绕块中心 (0.5,0.5,0.5) 旋转 */
function rotateVertex(x, y, z, o) {
  const [rx, ry, rz] = rotateOffset(x - 0.5, y - 0.5, z - 0.5, o);
  return [rx + 0.5, ry + 0.5, rz + 0.5];
}

// 模型面 → 世界面映射（面方向向量随 rotateOffset 同转）：
// o=1: +X→-Z, -X→+Z, +Z→+X, -Z→-X, ±Y 不变；o=2/3 类推。
const FACE_ROT = [
  [0, 1, 2, 3, 4, 5],
  [5, 4, 2, 3, 0, 1],
  [1, 0, 2, 3, 5, 4],
  [4, 5, 2, 3, 1, 0],
];

function getAO(side1, side2, corner, front = 0) {
  // 四角 AO。**有意偏离 mc-lite**（§4.3 第 ⑤ 项）：mc-lite AOUtils.getAOValue 有对角
  // 门控 `(side1||side2)?corner:0`（Minecraft 原版语义——对角方块物理上不太遮挡该顶点），
  // 本仓库去掉该门控，让「仅对角遮挡」也计入 AO。
  //
  // **为什么去掉**：门控会让两侧开阔、仅对角遮挡的顶点恒为 AO=3（最亮）。实玩可见的
  // 后果是一个方块的两面（如东+南）都是墙角时，两条阴影各沿凹角向外垂直延伸，而**东南
  // 对角的地面格完全不参与** → 阴影在对角处断开，露出一条阴影断层（实测：对角格顶面
  // 靠墙角块那两角 AO=3，东/南相邻格同位置顶点 AO=2）。去掉门控后对角格该顶点 AO=2，
  // 阴影连成环。
  //
  // 副作用：所有「两侧开阔、仅对角遮挡」的顶点都会暗一档（悬浮方块斜对角、台阶斜接处等），
  // 原版 Minecraft 故意让这些不变暗。实测副作用范围有限（多数对角遮挡都伴随至少一侧遮挡）。
  // 断言见 src/tests/test-mesher.js「AO 仅对角遮挡顶点 AO=2」。
  //
  // `front` = 第 4 样本（法线正对格的亚体素占用）。整格方块恒传 0 → 上式逐位不变；
  // 只有台阶这类「不参与面剔除、却占半格」的方块会让它非零，用于让邻居看见它的实体。
  if (side1 && side2) return 0; // 两侧都遮挡 → 0（最暗，与 mc-lite 同）
  return 3 - (side1 + side2 + (corner ? 1 : 0) + (front ? 1 : 0));
}

/**
 * AO 探针：把该顶点所在面的 4 个遮挡采样值写进 `out` = [s1, s2, corner, front]。
 *
 * 遮挡判据 = 「采样点所在的 1/2 子格是否被占据」（取代整格二值的 `opaqueTable`）。
 * 这样台阶这类「只占半格」的方块既能拿到自己的凹角阴影，也能把阴影投给邻居。
 *
 * 采样点 = 顶点 + 0.25 × (法线 + 切向1 + 切向2)。0.25 是载荷性的：顶点分量在
 * {0, 0.5, 1} 时，采样点每个分量恒落在 ±0.25 / 0.75 / 1.25 —— 恰好是子格中心或
 * 「子格中心的镜像」，永不落在 1/2 边界上，因此不存在「点落在边界该算哪边」的歧义。
 *
 * **零回归的关键**：整格面（顶点 ∈ {0,1}）经上式得到的落格与旧口径（整格 3 邻居采样）
 * **完全一致**（逐项实测），而 opaque 方块的八分区掩码恒为 0xFF（八个子格全占）→
 * 纯实心世界里新旧口径逐位相同。台阶等亚体素方块才有差异。
 *
 * ⚠️ 采样范围仍是「面外 1 格 + 两个切向邻格 + 正对格」，全部落在 section 的 1 格 halo 内，
 * 故 `lighting.js` 的 `lightDirtyMasks` 依赖集合不变（那对耦合约定只跟 light 采样有关）。
 *
 * @param {Uint16Array} data section halo 视图
 * @param {Uint8Array|null} meta
 * @param {number} vx @param {number} vy @param {number} vz 发射格的 halo 视图坐标
 * @param {number} face 世界面 0-5
 * @param {number[]} v 顶点格内坐标（已按 orient 旋转）
 * @param {number[]|null} bmin @param {number[]|null} bmax 该 quad 的 bbox（整格面传 null）
 * @param {Uint8Array} occTable id*4+orient → 八分区掩码（opaque 方块为 0xFF）
 * @param {number[]} out 长度 ≥4 的复用缓冲（热路径不逐顶点分配）
 * @returns {number[]} 同一个 `out`
 */
function aoProbes(data, meta, vx, vy, vz, face, v, bmin, bmax, occTable, out) {
  const n = FACE_DIRS[face];
  // 法线轴 na（±X → 0，±Y → 1，±Z → 2）；切向 = 另外两个轴（升序）
  const na = n[0] !== 0 ? 0 : n[1] !== 0 ? 1 : 2;
  const t1 = na === 0 ? 1 : 0;
  const t2 = na === 2 ? 1 : 2;
  // 切向 ± ：整格面按 0.5（= 面中心），亚体素面按该 quad 的 bbox 中点。
  // 两者对整格面给出相同结果，故 bmin/bmax 为 null 时走更快的 0.5。
  const e1 = (bmin ? v[t1] >= (bmin[t1] + bmax[t1]) * 0.5 : v[t1] >= 0.5) ? 1 : -1;
  const e2 = (bmin ? v[t2] >= (bmin[t2] + bmax[t2]) * 0.5 : v[t2] >= 0.5) ? 1 : -1;
  // 三次采样。每个采样点 = v + 0.25*(n + ±e1·ê_t1 + ±e2·ê_t2)。
  // 用「切向轴单位向量的那一分量」把 e1/e2 折进逐轴增量，避免三次数组构造。
  const d1x = t1 === 0 ? e1 : 0, d1y = t1 === 1 ? e1 : 0, d1z = t1 === 2 ? e1 : 0;
  const d2x = t2 === 0 ? e2 : 0, d2y = t2 === 1 ? e2 : 0, d2z = t2 === 2 ? e2 : 0;
  for (let k = 0; k < 3; k++) {
    // k=0 → 只用 +e1（side1）；k=1 → 只用 +e2（side2）；k=2 → 两者都用（corner）
    const u1 = k === 1 ? -1 : 1;
    const u2 = k === 0 ? -1 : 1;
    const px = v[0] + 0.25 * (n[0] + u1 * d1x + u2 * d2x);
    const py = v[1] + 0.25 * (n[1] + u1 * d1y + u2 * d2y);
    const pz = v[2] + 0.25 * (n[2] + u1 * d1z + u2 * d2z);
    const gx = Math.floor(px), gy = Math.floor(py), gz = Math.floor(pz);
    const oct = (px - gx >= 0.5 ? 1 : 0) | (py - gy >= 0.5 ? 2 : 0) | (pz - gz >= 0.5 ? 4 : 0);
    const vi = viewIdx(vx + gx, vy + gy, vz + gz);
    const orient = meta ? (meta[vi] & 3) : 0;
    out[k] = (occTable[data[vi] * 4 + orient] >> oct) & 1;
  }
  // 第 4 样本：**法线正对格**本身的亚体素占用（只在下半格/上半格这类方块上非零）。
  // 为什么需要它：经典 3 样本的前提是「法线正对的邻格是空气」（否则该面会被面剔除）。
  // 台阶 `opaqueTable=0` → 邻居朝它的面**不会被剔除** → 这个前提被打破，而 3 样本
  // 只从邻格再往切向斜偏，永远采不到邻格本体 → 台阶给邻居的「衔接阴影」会漏。
  // 整格方块不受影响：正对格若 opaque 则面早已被剔除，走不到这里；即使走到，
  // 取的是「正对格中心那个子格」，对 0xFF 恒为 1 —— 但为守住零回归，显式跳过非亚体素格。
  {
    const vi = viewIdx(vx + n[0], vy + n[1], vz + n[2]);
    const orient = meta ? (meta[vi] & 3) : 0;
    const m = occTable[data[vi] * 4 + orient];
    if (m === 0 || m === 0xff) out[3] = 0;
    else {
      const oct = (n[0] < 0 ? 1 : 0) | (n[1] < 0 ? 2 : 0) | (n[2] < 0 ? 4 : 0);
      out[3] = (m >> oct) & 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 非立方体顶点模板（§4.3）：坐标逐格复刻 mc-lite ChunkConsolidation.js geomMap
// （几何定义）+ 实例原点块中心（+0.5）。quad = {v: 4 顶点, face, ds, uv?}；
// ds = 双面（mc-lite DoubleSide 材质，用双向绕线实现，保持单材质单通道）。
// ---------------------------------------------------------------------------

/** 轴对齐 cross（mc-lite buildCrossGeo/geoVine：两个正交平面）。
 *  顶点序必须与 FACE_VERTICES[face] 一致（按索引查 FACE_UVS），否则贴图横躺。 */
function crossQuads(width, y0, y1) {
  const w2 = width / 2;
  const a = 0.5 - w2, b = 0.5 + w2;
  return [
    // 朝 Z 平面：(x,y) 序 (0,0),(1,0),(1,1),(0,1) = FACE_VERTICES[4] 口径
    { v: [[a,y0,0.5],[b,y0,0.5],[b,y1,0.5],[a,y1,0.5]], face: 4, ds: true },
    // 朝 X 平面：(y,z) 序 (0,0),(1,0),(1,1),(0,1) = FACE_VERTICES[0] 口径
    { v: [[0.5,y0,a],[0.5,y1,a],[0.5,y1,b],[0.5,y0,b]], face: 0, ds: true },
  ];
}

/** 子格立方体 6 面（绕线/UV 与单位立方体同口径） */
function boxQuads(x0, y0, z0, x1, y1, z1) {
  const quads = [];
  for (let face = 0; face < 6; face++) {
    quads.push({
      v: FACE_VERTICES[face].map(([x, y, z]) => [
        x0 + x * (x1 - x0), y0 + y * (y1 - y0), z0 + z * (z1 - z0),
      ]),
      face,
      ds: false,
    });
  }
  return quads;
}

/** 8 段棱柱 + 上下盖（mc-lite CylinderGeometry(…, 8)：烟囱/吊灯绳） */
function prismQuads(cx, cz, r, y0, y1, segs = 8) {
  const quads = [];
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI * 2, t1 = ((i + 1) / segs) * Math.PI * 2;
    const ax = cx + r * Math.sin(t0), az = cz + r * Math.cos(t0);
    const bx = cx + r * Math.sin(t1), bz = cz + r * Math.cos(t1);
    const uv = [[i / segs, 0], [(i + 1) / segs, 0], [(i + 1) / segs, 1], [i / segs, 1]];
    // 侧面（外法线，绕线已按径向叉乘核验）
    quads.push({ v: [[ax,y0,az],[bx,y0,bz],[bx,y1,bz],[ax,y1,az]], face: 4, ds: false, uv });
    // 顶盖（+Y）：中心 → b → a（绕线核验 sin(t0-t1)<0 需反向）
    quads.push({ v: [[cx,y1,cz],[bx,y1,bz],[ax,y1,az],[ax,y1,az]], face: 2, ds: false, uv });
    // 底盖（-Y）
    quads.push({ v: [[cx,y0,cz],[ax,y0,az],[bx,y0,bz],[bx,y0,bz]], face: 3, ds: false, uv });
  }
  return quads;
}

// ---------------------------------------------------------------------------
// 台阶族：盒列表 → quad + 八分区占用掩码（一份声明喂两个消费者，红线 1）
//
// **为什么台阶需要「八分区掩码」**：台阶是 `cullMode:"cutout"` 且未声明 `opaque`
// （`blocks-data.js`）→ `opaqueTable=0`，而 AO 的遮挡判据只读 `opaqueTable`。后果是台阶
// **既拿不到自己的凹角阴影**（旧口径只采整格邻居，台阶的 0.5 高度面不在采样范围
// 内），**也投不出阴影给邻居**。实测 HEAD 下孤立台阶 48 个顶点几乎全是 AO=3。
//
// 修法 = 把「这个采样点被遮挡吗」从「整格是否 opaque」换成「采样点所在的 1/2 子格是否被
// 该方块占据」。掩码 8 位，bit i 表示子格 (i&1, (i>>1)&1, (i>>2)&1) 被占据。
//
// **纳入范围只有台阶族**（下方 STEP_BOXES 的四项几何）。半砖（half_block /
// half_block_updown）与装饰几何（仙人掌/栏杆/花等）**不纳入**，逐位保持原样 ——
// 它们的「暗部」没有明确物理意义。
// ---------------------------------------------------------------------------
const STEP_BOXES = {
  // 下半全幅 + 上半 -X 半幅（mc-lite geoPlanksStep）
  planks_step: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]],
  cobblestone_step: [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]],
  // 上半全幅 + 下半 +X 半幅（mc-lite geoCobblestoneStepUpdown）
  cobblestone_step_updown: [[0, 0.5, 0, 1, 1, 1], [0.5, 0, 0, 1, 0.5, 1]],
  // 上半全幅 + 下半 -X 半幅 —— `planks_step` 的**精确上下颠倒**（中世纪船 Epic）。
  //
  // ⚠️ **与 `cobblestone_step_updown` 刻意不同**：那个是「上下颠倒 + 水平镜像」（下半在 +X），
  // 本几何只做上下颠倒（下半仍在 -X）。这样 `planks_step` 与 `planks_step_updown` 在
  // **同一个 orient 下高侧方向相同**，只是竖直翻转 —— 映射 Minecraft stairs 的
  // `half=bottom/top` 时 facing→orient 表可以完全共用一份（红线 1 精神）。
  // 若复用 `cobblestone_step_updown`，top/bottom 两种台阶的 orient 表会差一个水平镜像，
  // 是「方向搞错」的高发源（用户明确要求「台阶方块有方向，别错了」）。
  planks_step_updown: [[0, 0.5, 0, 1, 1, 1], [0, 0, 0, 0.5, 0.5, 1]],
};

/** 盒列表 → 2×2×2 八分区占用掩码（取每格中心点是否落在任一盒内） */
function octantMaskOf(boxes) {
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    const cx = (i & 1) ? 0.75 : 0.25;
    const cy = (i & 2) ? 0.75 : 0.25;
    const cz = (i & 4) ? 0.75 : 0.25;
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && cz >= z0 && cz <= z1) { mask |= 1 << i; break; }
    }
  }
  return mask;
}

/** 八分区位按 90° 步长绕 Y 轴旋转（与 rotateOffset 同一变换：o=1: (dx,dy,dz)→(dz,dy,-dx)） */
function rotateOctantBit(i, o) {
  const dx = (i & 1) ? 1 : -1;
  const dy = (i & 2) ? 1 : -1;
  const dz = (i & 4) ? 1 : -1;
  let rx = dx, rz = dz;
  if (o === 1) { rx = dz; rz = -dx; } else if (o === 2) { rx = -dx; rz = -dz; } else if (o === 3) { rx = -dz; rz = dx; }
  return (rx > 0 ? 1 : 0) | (dy > 0 ? 2 : 0) | (rz > 0 ? 4 : 0);
}

// 纳入亚体素 AO 的几何（= STEP_BOXES 的键）。**半砖与装饰几何刻意不在其中**：它们的
// 「暗部」没有明确物理意义（实测纳入仙人掌/栏杆会产生无意义暗块），逐位保持原样。
const SUBVOXEL_AO_GEOMS = new Set(Object.keys(STEP_BOXES));

/** 几何名 → [mask(orient 0..3)]；每格方块按自身 `meta & 3` 取一项 */
const STEP_MASKS = {};
for (const [geom, boxes] of Object.entries(STEP_BOXES)) {
  const m0 = octantMaskOf(boxes);
  STEP_MASKS[geom] = [0, 1, 2, 3].map((o) => {
    let out = 0;
    for (let i = 0; i < 8; i++) if ((m0 >> i) & 1) out |= 1 << rotateOctantBit(i, o);
    return out;
  });
}

const stepQuadsOf = (geom) => STEP_BOXES[geom].flatMap(([x0, y0, z0, x1, y1, z1]) => boxQuads(x0, y0, z0, x1, y1, z1));

/**
 * 八分区占用表：`id * 4 + orient` → 8 位掩码。opaque 方块恒 0xFF（整格，与旧口径等价），
 * 台阶族取 `STEP_MASKS`，其余方块 0（不参与亚体素 AO）。
 * 按 registry 缓存一次（registry 冻结后不变）—— 不进入逐 section 的热路径。
 */
const OCC_TABLE_CACHE = new WeakMap();
function octantOccupancyOf(registry) {
  let table = OCC_TABLE_CACHE.get(registry);
  if (table) return table;
  table = new Uint8Array(512 * 4);
  for (let id = 0; id < registry.count; id++) {
    const opaque = registry.opaqueTable[id] === 1;
    const masks = opaque ? null : STEP_MASKS[registry.geometryNameOf(id)];
    for (let o = 0; o < 4; o++) {
      table[id * 4 + o] = opaque ? 0xff : (masks ? masks[o] : 0);
    }
  }
  OCC_TABLE_CACHE.set(registry, table);
  return table;
}

const STEP_QUADS = stepQuadsOf('planks_step');

// 吊灯 UV 分区常量（§4.3 v1.22，有意偏离 mc-lite）：把绳与灯体的 UV 限制到贴图各自的
// 图案区，令「绳呈单色深灰、灯体发光暖黄、灯体四个面不含绳图案」。
// 区域边界按 **texel 中心**对齐（不是像素边界）：贴图的 fillRect(30,0,4,20) 填 col 30~33 /
// row 0~19，texel 中心在 30.5~33.5 / 0.5~19.5 → NearestFilter 下采样点落在纯色区内，
// 不会采到相邻背景 #aaa49a。灯体图案区同理取 col 18~45 / row 20~47。
// atlas 的 v 轴翻转（build-atlas.mjs:103 `v0 = 1-(shelfY+h)/SIZE`）→ canvas row r
// 对应 tile 局部 v = 1 - r/64。
const LAMP_ROPE_REGION = [30.5 / 64, 1 - 19.5 / 64, 33.5 / 64, 1 - 0.5 / 64];
const LAMP_BODY_REGION = [18.5 / 64, 1 - 47.5 / 64, 45.5 / 64, 1 - 20.5 / 64];

// export：背包图标烘焙（tools/bake-isometric-icons.mjs）复用此模板做等轴测投影——
// 形状的唯一权威在这里，图标不得有第二份几何定义（§4.5.4 v1.24，红线 1 精神）。
// 加 export 不改任何几何定义，不影响 buildSectionMesh 的消费路径。
export const TEMPLATES = {
  // 花/草：0.7×0.7 cross，y∈[-0.1,0.6]（geoFlower：中心偏移 -0.25）
  flower: crossQuads(0.7, -0.1, 0.6),
  // 矮草丛（v3.12）：0.805 宽 × 0.92 高 cross，y∈[-0.05,0.87]。
  //
  // ⚠️ **尺寸是按「实际草的 bbox」等比 +15% 定的，不是按 quad 尺寸**：
  //   · short_grass 贴图（double_plant_grass_carried）不透明 bbox x1..14 y0..15
  //     ⇒ 实际草宽 0.7×14/16 = **0.6125**、草高 0.7×16/16 = **0.700**
  //   · bush_grass 贴图（vanilla short_grass）bbox x0..15 y2..15（满宽、顶部空 2 行）
  //     ⇒ 实际草宽 0.805×16/16 = **0.805**、草高 0.92×14/16 = **0.805**
  //   ⇒ 草高 **+15%**、草宽 +31%（宽度差来自两张贴图的留白不同）。
  // 若按 quad 尺寸等比放大 15%（crossQuads(0.805,-0.115,0.69)），草高只 +0.6% ——
  // 几乎看不出，故那一档对「稍微更大」无效。判据见 test-bush-grass.js。
  // y0=-0.05：草底略入土（比 flower 的 -0.1 浅），防草浮空。
  'bush_grass': crossQuads(0.805, -0.05, 0.87),
  // 藤蔓：0.8 宽 × 1.0 高 cross，y∈[0,1] 落在格内。
  // 有意偏离 mc-lite：geoVine 局部 y[0,1] + 实例原点 +0.5 → 世界 y[0.5,1.5]，向上溢出
  // 半格（其源码注释「向上偏移0.5，使几何体从y=0到y=1」说的是局部坐标，误导）。本仓库改
  // 为贴合方块上下边界。详见 §4.3。
  vine: crossQuads(0.8, 0, 1),
  // 睡莲：0.8×0.8 水平 quad，y=-0.48（叶面落在块底之下半格）。
  // **为什么是 -0.48 而非 mc-lite 的 0.02 语义**：mc-lite 的 lilypad 是装饰实体
  // （EntityManager.js:412），实例原点 = `Math.floor(y)+0.5` = 块**中心**，几何 translate(0,-0.48)
  // → 叶面世界 y = -1.98，沉在整格水面顶面 -1.0 之下 0.98（mc-lite 自身即有此缺陷）。
  // 本仓库 lilypad 是体素方块、实例原点 = 块**底角**（0→1），故同一 -0.48 偏移得到
  // 「块底之下半格」。生成侧配合把 lilypad 放在水面格的上一格（apply.js）→ 叶面
  // (SEA_Y+1)-0.48 = -1.48，恰好高出下沉后的暴露水面顶面 (SEA_Y+1)-0.5 = -1.50 两厘米
  // → 紧贴水面、不沉水。陆地 lilypad（jungle_pyramid 台阶顶面 y=1.50）同口径贴合：叶面 1.52。
  // 详见 §4.3（有意偏离 mc-lite 第 ④ 项）。
  // (x,z) 序 (0,1),(1,1),(1,0),(0,0) = FACE_VERTICES[2] 口径（缺口朝向与 mc-lite 一致）
  lilypad: [{ v: [[0.1,-0.48,0.9],[0.9,-0.48,0.9],[0.9,-0.48,0.1],[0.1,-0.48,0.1]], face: 2, ds: true }],
  // 仙人掌：主干 0.65² + 四侧枝（geoCactus 逐盒复刻）
  cactus: [
    ...boxQuads(0.175, 0, 0.175, 0.825, 1, 0.825),
    ...boxQuads(-0.025, 0.475, 0.375, 0.225, 0.725, 0.625),
    ...boxQuads(-0.025, 0.65, 0.375, 0.225, 1.05, 0.625),
    ...boxQuads(0.775, 0.275, 0.375, 1.025, 0.525, 0.625),
    ...boxQuads(0.775, 0.45, 0.375, 1.025, 0.75, 0.625),
  ],
  // 烟囱：r=0.15 高 2 棱柱（geoChimney：块中心 ±1）
  chimney: prismQuads(0.5, 0.5, 0.15, -0.5, 1.5),
  // 栏杆：中柱 0.5² + 东/北把手（geoHandrail）
  handrail: [
    ...boxQuads(0.25, 0, 0.25, 0.75, 1, 0.75),
    ...boxQuads(0.625, 0.775, 0.425, 1.125, 0.925, 0.575),
    ...boxQuads(0.425, 0.775, 0.625, 0.575, 0.925, 1.125),
  ],
  // 栏杆 A：柱 0.3² + 全长 X 横杆（geoHandrailA）
  handrailA: [
    ...boxQuads(0.35, 0, 0.35, 0.65, 1, 0.65),
    ...boxQuads(0, 0.775, 0.425, 1, 0.925, 0.575),
  ],
  // 栏杆 B：柱 0.3² + Z 横杆 0.5 长（geoHandrailB）
  handrailB: [
    ...boxQuads(0.35, 0, 0.35, 0.65, 1, 0.65),
    ...boxQuads(0.425, 0.775, 0.25, 0.575, 0.925, 0.75),
  ],
  vertical_pillar: boxQuads(0.35, 0, 0.35, 0.65, 1, 0.65),
  horizontal_pillar: boxQuads(0, 0.35, 0.35, 1, 0.65, 0.65),
  planks_step: STEP_QUADS,
  cobblestone_step: stepQuadsOf('cobblestone_step'),
  cobblestone_step_updown: stepQuadsOf('cobblestone_step_updown'),
  planks_step_updown: stepQuadsOf('planks_step_updown'),
  // 半高块（床）：1×0.5×1 底贴块底（geoHalfBlock）
  half_block: boxQuads(0, 0, 0, 1, 0.5, 1),
  // 倒置半高块（中世纪船 Epic）：1×0.5×1 **顶贴块顶**。
  // 承载 Minecraft `slab[type=top]` 与 `trapdoor[half=top]`（船体曲线 / 舱口盖）。
  // ⚠️ **刻意不进 `STEP_BOXES`**：半砖的「暗部」没有明确物理意义（与 `half_block` 同口径，
  // 见上方 SUBVOXEL_AO_GEOMS 注释），纳入只会产生无意义暗块。
  half_block_updown: boxQuads(0, 0.5, 0, 1, 1, 1),
  // 吊灯：细绳八段棱柱 + 灯体 0.3³（几何逐格复刻 geoHangingLamp，坐标未变）
  // 绳逐格复刻 CylinderGeometry(0.015, 0.015, 0.4, 8) + translate(0,0.3,0)：局部
  // y[0.1,0.5] → 格内 y[0.6,1.0]，块中心 (0.5,0.5) 为轴。
  //
  // **UV 与自发光按部件分区（§4.3 v1.22，有意偏离 mc-lite）**：mc-lite 两个几何 UV 实测
  // 均为 u/v∈[0,1] 全幅（都采样整张贴图 → 灯面含绳图案、绳含灯体图案），且
  // emissive 加项把绳的深色冲淡到与灯体同亮。本仓库改为分区采样 + 逐部件自发光：
  //   绳   → uvRegion 绳图案区（单色 #333333）+ em:false（不吃 emissive → 保持深灰）
  //   灯体 → uvRegion 灯体图案区（不含绳图案）+ em:true（吃 emissive → 发光暖黄）
  hanging_lamp: [
    ...prismQuads(0.5, 0.5, 0.015, 0.6, 1.0)
      .map((q) => ({ ...q, uvRegion: LAMP_ROPE_REGION, em: false })),
    ...boxQuads(0.35, 0.35, 0.35, 0.65, 0.65, 0.65)
      .map((q) => ({ ...q, uvRegion: LAMP_BODY_REGION, em: true })),
  ],
};

// mc-lite 材质为 DoubleSide 的立方体方块（MaterialManager 注册 side 字段）：
// 原本唯一成员是 realistic_oak_leaves。
//
// ⚠️ **2026-11-04：该方块已从 `blocks-data.js` 删除**（用户裁定「我不需要了」）→
// 本集合现在**为空**。机制与消费点（`doubleSide` 分支）**保留未动**：它是 mc-lite
// 材质 side 属性的转换口径，将来再加 DoubleSide 方块只需把名字放进来，不必重写绕线逻辑。
// 若确认永不使用，可连同下方消费分支一并删除（届时 `mesher.js` 少一个分支）。
const DOUBLE_SIDE_CUBES = new Set([]);

// 暴露水面下沉（issue #2 遗留）：water/swamp_water 上方无 opaque/同类水覆盖时，
// 顶面与侧面顶边下沉 0.5，与海面平面（SEA_Y+0.5）共面，消除俯视可见的蓝色顶面模。
// 方块逻辑/物理仍占整格，仅渲染几何下沉。
const WATER_LIKE = new Set(['water', 'swamp_water']);
const WATER_SURFACE_SINK = 0.5;
// 不透明通道但同类相邻仍剔除共享面：cloud（M2-7 通道勘误，opaque 材质语义；
// 云簇内部相邻面不发射，避免体素爆发；water/glass 走 cullMode>=2 同规则）
const SAME_TYPE_CULL = new Set(['cloud']);
// 材质自发光方块（§4.3 packed bit13，v1.21）：移植 mc-lite **材质层属性**
// （`MaterialManager.js:1199` hanging_lamp 的 `emissive:'#FFE4B5'` × 0.8）。实测 mc-lite
// **只有 hanging_lamp 一处**有材质自发光，其余材质 emissive 均为默认 0。
// 与 `DOUBLE_SIDE_CUBES`（mc-lite 材质 side 属性）、`SAME_TYPE_CULL`（材质语义）同一性质，
// 故用 hardcoded Set 表达，不入 `blocks-data.js`（后者是 BlockData.js 方块属性的转换产物）。
// **勿与 blocks-data 的 `emissive:15` 混淆**：那是 blocklight 光照源（照亮周围方块，
// `registry.emissiveTable` 消费）；本 Set 是材质自身发亮。四个发光方块都有 blocklight 源，
// 但只有 hanging_lamp 有材质自发光——两个集合不同，不能用 emissiveTable 判断。
const EMISSIVE_MATERIALS = new Set(['hanging_lamp']);

// 太阳阴影不投射标记（§4.4.4 packed bit14）：与 bit13 自发光同一手法（逐方块常量、
// 走 typed 表而非字面量名单）。权威 = `registry.shadowCastTable`（声明侧 `blocks-data.js`
// 的 `shadowCast:false`，对齐 mc-lite `BlockData.isShadowEnabled:false`）。
// 消费方 = `materials.js` 的 `maskShadowNode`（阴影 pass 逐片元 discard，主 pass 不受影响）。
// ⚠️ bit14 是 packed 里第一个超过 bit13 的位；Uint32 容量充足（现用 bit0-14）。
const SHADOW_CAST_BIT = 1 << 14;

// 床 UV 变换（2026-09-03 勘误：原口径照 mc-lite 字段名实现了「取上半 + 顶面旋转」，
// 但实测 mc-lite 的 offset/rotation 是死字段，故此处按**实际行为**而非字段定义实现）。
// 床侧面只取贴图下半：mc-lite 定义 `repeat:[1,0.5]` + `offset:[0,0.5]`，但 `offset` 全仓
// **无任何消费点**（MaterialManager._createMaterial 只消费 repeat；preloadTextures 只调
// _applyTextureSampling），故实际生效的 uvTransform 是 v'=0.5*v → 采样下半（PNG 行 8~15，
// 实测 92 个不透明像素）。上半（行 0~8）实测仅 32 个不透明像素、RGB 均 rgb(40,25,25)，
// 床走 opaque 通道 alpha 不参与混合 → 若采上半会渲成一块深色而非床侧纹理。
// uFlip 对应 mc-lite `repeat:[-1,0.5]`，RepeatWrapping 下与纯镜像 uu=1-uu 等价（边界
// u=0/u=1 采样同一 texel，已实测核对）。
// bed_head 顶面：mc-lite 定义 `rotation:-π/2` 但同样**无消费点**，实际不旋转 → 本仓库不加变换。
const BED_UV = {
  bed_head: { 0: { uFlip: true, vLowerHalf: true }, 1: { vLowerHalf: true }, 4: { vLowerHalf: true } },
  bed_tail: { 0: { uFlip: true, vLowerHalf: true }, 1: { vLowerHalf: true }, 5: { vLowerHalf: true } },
};

function transformUV(blockName, face, u, v) {
  const t = BED_UV[blockName]?.[face];
  if (!t) return [u, v];
  let uu = u, vv = v;
  if (t.uFlip) uu = 1 - uu;
  if (t.vLowerHalf) vv = 0.5 * vv;
  return [uu, vv];
}

/** quad 级 UV 子区域重映射（§4.3 v1.22，吊灯用）：把 tile 内 0~1 的 UV 线性映射到
 *  region = [u0,v0,u1,v1] 指定的子区域。同一方块的不同部件因此可采样贴图的不同区域。 */
function remapRegion(u, v, r) {
  return [r[0] + (r[2] - r[0]) * u, r[1] + (r[3] - r[1]) * v];
}

/** 发射一个 quad（packeds 为 4 个逐顶点 packed；ds=true 追加反向绕线 = 双面可见） */
function pushQuad(ch, positions, uvs, packeds, ds) {
  const vertBase = ch.pos.length / 3;
  for (let vi = 0; vi < 4; vi++) {
    ch.pos.push(positions[vi][0], positions[vi][1], positions[vi][2]);
    ch.uv.push(uvs[vi][0], uvs[vi][1]);
    ch.packed.push(packeds[vi]);
  }
  ch.idx.push(vertBase, vertBase + 1, vertBase + 2, vertBase, vertBase + 2, vertBase + 3);
  if (ds) ch.idx.push(vertBase, vertBase + 2, vertBase + 1, vertBase, vertBase + 3, vertBase + 2);
}

/**
 * 构建单个 section 的三通道网格数据。
 * @param {{data: Uint16Array, light: Uint8Array, missing: boolean}} view
 * @param {*} registry
 * @param {Object} atlasMeta - tiles: { tileName: {u0,v0,u1,v1} }
 * @param {number} _cx @param {number} _sy @param {number} _cz section 世界坐标（M1 未用，保留接口对称）
 * @returns {{opaque: SectionGeomData, cutout: SectionGeomData, transparent: SectionGeomData,
 *            stats: {blocks: number, candidateFaces: number, faces: number, culledFaces: number, vertices: number}}}
 */
export function buildSectionMesh(view, registry, atlasMeta, _cx, _sy, _cz) {
  const { data, light, meta } = view;
  const cullTable = registry.cullTable;
  const opaqueTable = registry.opaqueTable;
  const hollowOccluderTable = registry.hollowOccluderTable;
  const shadowCastTable = registry.shadowCastTable;
  const nameOf = registry.nameOf.bind(registry);
  const tiles = atlasMeta.tiles || atlasMeta;
  const occTable = octantOccupancyOf(registry);

  const channels = {
    opaque: { pos: [], uv: [], packed: [], idx: [] },
    cutout: { pos: [], uv: [], packed: [], idx: [] },
    transparent: { pos: [], uv: [], packed: [], idx: [] },
  };
  const channelNames = ['opaque', 'cutout', 'transparent'];

  // 面剔除统计（HUD 世界数据看板用，§4.9 开关 worldStats）：candidateFaces = 立方体 ×6 候选面，
  // culledFaces = 被邻居遮挡剔除面，faces = 实际出块面（含模板 quad）。
  // 开关关闭时热循环跳过计数（collect 恒 false，分支预测稳定，零额外开销）。
  const collect = DEBUG_FLAGS.worldStats;
  let blocks = 0, candidateFaces = 0, faces = 0, culledFaces = 0;
  // aoProbes 的输出缓冲（逐顶点复用，避免每顶点分配一个 4 元数组 —— mesher 热路径）
  const AO_OUT = [0, 0, 0, 0];

  for (let ly = 0; ly < SECTION_SIZE; ly++) {
    for (let lz = 0; lz < SECTION_SIZE; lz++) {
      for (let lx = 0; lx < SECTION_SIZE; lx++) {
        // halo 视图坐标：中心 section 从 (1,1,1) 开始
        const vx = lx + 1, vy = ly + 1, vz = lz + 1;
        const id = data[viewIdx(vx, vy, vz)];
        if (id === 0) continue;
        if (collect) blocks++;

        const cullMode = cullTable[id];
        if (cullMode === 3) continue; // none：不渲染
        const channel = channelNames[cullMode]; // 0→opaque, 1→cutout, 2→transparent
        const ch = channels[channel];
        const blockName = nameOf(id);
        // 材质自发光标记（§4.3 bit13）：逐方块算一次作为**默认值**，模板 quad 可用
        // 可选字段 `em` 逐 quad 覆盖（v1.22：吊灯「绳不发光、灯体发光」）。
        const blockEmissiveBit = EMISSIVE_MATERIALS.has(blockName) ? (1 << 13) : 0;
        // 阴影不投射标记（§4.4.4 bit14）：逐方块算一次，两条发射路径（模板/立方体）共用。
        const noShadowCastBit = shadowCastTable[id] === 1 ? 0 : SHADOW_CAST_BIT;

        // 非立方体几何（§4.3 顶点模板）：不做面剔除（mc-lite 实例级渲染同口径）；
        // 光照读自身格（模板面在格内，无"邻居格"语义）；AO 按顶点推导。
        const geom = registry.geometryNameOf(id);
        const template = TEMPLATES[geom];
        // 朝向：meta 低 2 位（view 未打包 meta 时兜底 0——旧调用方/单测）
        const orient = meta ? (meta[viewIdx(vx, vy, vz)] & 3) : 0;
        if (template) {
          const selfLight = light[viewIdx(vx, vy, vz)];
          let emitted = 0;
          for (const q of template) {
            const tileName = getFaceTile(blockName, q.face); // 模型面：贴图随方块转
            // null 面（床连接面）不渲染。
            // TODO(床渲染，2026-09-03 搁置)：床方块有一个侧面**没有贴面**，导致该面出现
            // 镂空透视（可以看到方块内部/背景）。**根因未定位**，已排除的是 UV 采样方向问题
            // （实测 BoxGeometry 每面独立 UV v∈[0,1]，经 mc-lite 的 repeat[1,0.5] 后所有面
            // 都采样贴图下半，两侧一致）。
            //
            // 待验证的假设（未证实，别直接照此修）：`faces-data.js` 里 bed_head 缺 -Y/-Z、
            // bed_tail 缺 -Y/+Z 四面，本仓库是**直接不发射面**（真镂空）；而 mc-lite 那几面是
            // `transparent:true + opacity:0`（面**仍在**、只是全透明）。若 mc-lite 的透明材质
            // 保持默认 depthWrite，那些面仍会**写入深度缓冲**从而遮挡视线——与本仓库「没有面 →
            // 没有深度写入 → 看到内部」不等价。这可能是差异来源，但需要实际验证
            // （读 mc-lite 材质的 depthWrite 实际值 + 截图对比）。
            //
            // **当前规避方式**：bed_head/bed_tail/bed_alias_block 已从背包移除
            // （`player/inventory.js` 的 `HIDDEN_FROM_INVENTORY`）→ 玩家选不到 → 实际不会被
            // 放置，故不会暴露该问题。**这是绕过，不是修复**；床渲染本身归属床/宝箱/门
            // 多方块 Epic。
            if (!tileName) continue;
            const tile = tiles[tileName] || tiles['stone'] || DEFAULT_TILE;
            const worldFace = FACE_ROT[orient][q.face];
            // quad 级自发光覆盖（§4.3 v1.22）：`em` 未声明 → 方块级默认；声明了 → 逐 quad 定值。
            // 吊灯用它令「绳不发光、灯体发光」。逐 quad 算一次，供该 quad 4 顶点复用。
            const emissiveBit = q.em === undefined ? blockEmissiveBit : (q.em ? (1 << 13) : 0);
            // 台阶族走亚体素 AO（八分区占用 + 面中心切向）；其余模板方块保持整格口径。
            const subvoxelAO = SUBVOXEL_AO_GEOMS.has(geom) && !q.ds;
            const positions = [];
            const uvs = [];
            const packeds = [];
            // 台阶族需要该 quad 的 bbox 来定切向 ±（整格面退化成 v>=0.5，与旧口径逐位相同）
            let bmin = null, bmax = null;
            if (subvoxelAO) {
              bmin = [Infinity, Infinity, Infinity];
              bmax = [-Infinity, -Infinity, -Infinity];
              for (let k = 0; k < 4; k++) {
                const [qx, qy, qz] = q.v[k];
                const r = orient === 0 ? [qx, qy, qz] : rotateVertex(qx, qy, qz, orient);
                for (let a = 0; a < 3; a++) {
                  if (r[a] < bmin[a]) bmin[a] = r[a];
                  if (r[a] > bmax[a]) bmax[a] = r[a];
                }
              }
            }
            for (let vi = 0; vi < 4; vi++) {
              const [qx, qy, qz] = q.v[vi];
              const [rx, ry, rz] = orient === 0 ? [qx, qy, qz] : rotateVertex(qx, qy, qz, orient);
              positions.push([lx + rx, ly + ry, lz + rz]);
              const [cu, cv] = q.uv ? q.uv[vi] : FACE_UVS[q.face][vi];
              // quad 级 UV 子区域（§4.3 v1.22）：先按 region 重映射，再走方块级变换（床）
              const [ru, rv] = q.uvRegion ? remapRegion(cu, cv, q.uvRegion) : [cu, cv];
              const [uu, vv] = transformUV(blockName, q.face, ru, rv);
              uvs.push([tile.u0 + (tile.u1 - tile.u0) * uu, tile.v0 + (tile.v1 - tile.v0) * vv]);
              // AO 按世界面 + 旋转后顶点（遮挡是世界空间语义）。
              // 台阶族（subvoxelAO）传 quad 的 bbox，让切向 ± 按面内位置判定；
              // 其余模板方块传 null（退化成 0.5，与旧口径逐位相同）。
              // 植被 cross 是无厚度的双面 quad，保持开阔 AO=3（原口径）。
              let ao;
              if (q.ds) {
                ao = 3;
              } else {
                aoProbes(data, meta, vx, vy, vz, worldFace,
                  [rx, ry, rz], subvoxelAO ? bmin : null, subvoxelAO ? bmax : null, occTable, AO_OUT);
                ao = getAO(AO_OUT[0], AO_OUT[1], AO_OUT[2], AO_OUT[3]);
              }
              packeds.push(selfLight | (ao << 8) | (worldFace << 10) | emissiveBit | noShadowCastBit);
            }
            pushQuad(ch, positions, uvs, packeds, q.ds);
            emitted++;
          }
          if (collect) faces += emitted;
          continue;
        }

        if (collect) candidateFaces += 6; // 立方体 6 面进入剔除判定
        const doubleSide = DOUBLE_SIDE_CUBES.has(blockName);
        // 暴露水面：上方既无 opaque 覆盖也非同种水（顶面会被发射的表层水）
        let waterSurface = false;
        if (WATER_LIKE.has(blockName)) {
          const aboveId = data[viewIdx(vx, vy + 1, vz)];
          waterSurface = opaqueTable[aboveId] !== 1 && aboveId !== id;
        }
        for (let modelFace = 0; modelFace < 6; modelFace++) {
          const worldFace = FACE_ROT[orient][modelFace];
          const [dx, dy, dz] = FACE_DIRS[worldFace];
          const nx = vx + dx, ny = vy + dy, nz = vz + dz;
          const neighborId = data[viewIdx(nx, ny, nz)];

          // 面剔除：邻居 opaque 则剔除；同类型相邻剔除（世界面判定）。
          //
          // **镂空遮挡体例外（v1.70）**：镂空体（cutout + opaqueTable=1 = 13 个树叶族）的贴图有孔洞
          // （alphaTest 逐片元 discard），它不足以当实心遮挡体 —— 拿它剔除本方块朝向它的那一面，
          // 玩家就会透过叶孔看到背后的空气。故只有「本方块是实心体、邻居是镂空体」这一对
          // **不剔本方块的面**；镂空体自身朝实心方块的面照旧剔（避免 z-fighting，且它本就
          // 不透明到能看见）。叶-叶共享面仍互剔（双方都是镂空体 → 照旧剔），所以“叶团内部
          // 不外发面”的收益完整保留（实测单棵普通树 3068→664 顶点）。
          // 代价 = 每条「实心↔镂空体」接触面 +1 面（实测树冠内 +0.1%、坐在地面的树冠 +9.1%、
          // 粗树干被叶包 +13.2%、叶贴墙面 +22.8%）。
          if (opaqueTable[neighborId] === 1 && !(hollowOccluderTable[neighborId] === 1 && hollowOccluderTable[id] === 0)) { if (collect) culledFaces++; continue; }
          if (neighborId === id && (cullMode >= 2 || SAME_TYPE_CULL.has(blockName))) { if (collect) culledFaces++; continue; } // water/glass 同类相邻、cloud

          const tileName = getFaceTile(blockName, modelFace); // 模型面：贴图随方块转
          if (!tileName) continue; // null 面不渲染
          if (collect) faces++; // 通过剔除，实际出块
          const tile = tiles[tileName] || tiles['stone'] || DEFAULT_TILE;
          // cloud 是匀质白纹理：UV 收缩到 tile 中央 1/4。块面 UV 逐块 wrap 使接缝处
          // 导数尖峰，mip 足迹（aniso 8 下半长 ≤~16 texel）若跨 tile 边缘会采到邻 tile
          // 色 = 方格线；中央 1/4 距 tile 边缘 24 texel，尖峰足迹永远落在纯白区内。
          let tu0 = tile.u0, tu1 = tile.u1, tv0 = tile.v0, tv1 = tile.v1;
          if (blockName === 'cloud') {
            const m = 0.375;
            tu0 = tile.u0 + (tile.u1 - tile.u0) * m; tu1 = tile.u1 - (tile.u1 - tile.u0) * m;
            tv0 = tile.v0 + (tile.v1 - tile.v0) * m; tv1 = tile.v1 - (tile.v1 - tile.v0) * m;
          }

          // 面亮度读"面朝向的邻居（空气）格"光照，不是方块自身格——
          // opaque 方块自身格 skylight=0（top-down 光遇 opaque 停止），读自身会全黑。
          // ⚠️ **这里读哪些格 = light 变化时哪些 section 要重 mesh 的唯一依据**：当前依赖集合 =
          // section 自身 16³ + 六个面外各 1 格厚的 halo（上面模板方块读自身格，也在其中）。
          // `lighting.js` 的 `lightDirtyMasks` 镜像了这条规则（scheduler 写回 light 后据此置脏）；
          // 若改采样范围（例如平滑光照采顶点周围/对角格），必须同步扩大它 ——
          // `test-lighting.js` 的「与 mesher 交叉比对」两条用例会在那时变红。
          const faceLight = light[viewIdx(nx, ny, nz)];
          const positions = [];
          const uvs = [];
          const packeds = [];
          for (let vi = 0; vi < 4; vi++) {
            const [fx, fy, fz] = FACE_VERTICES[modelFace][vi];
            let [rx, ry, rz] = orient === 0 ? [fx, fy, fz] : rotateVertex(fx, fy, fz, orient);
            // 暴露水面下沉：顶边顶点（ry=1）下沉 0.5——顶面整体、侧面顶边；底面顶点 ry=0 不受影响
            if (waterSurface && ry === 1) ry -= WATER_SURFACE_SINK;
            positions.push([lx + rx, ly + ry, lz + rz]);
            const [uu, vv] = FACE_UVS[modelFace][vi]; // 模型面 UV 约定（BoxGeometry 旋转自洽）
            uvs.push([
              tu0 + (tu1 - tu0) * uu,
              tv0 + (tv1 - tv0) * vv,
            ]);
            // AO：世界面 + 旋转后顶点（遮挡是世界空间语义）。
            // 走探针口径（八分区占用）而非整格 opaqueTable —— 整格邻居的掩码恒 0xFF，
            // 落格与旧口径逐项一致，故实心世界零回归；台阶这类亚体素方块才产生差异。
            // ⚠️ 采样范围仍是「面外 1 格 + 两个切向邻格」（与旧口径同一集合），
            // 所以 `lighting.js` 的 `lightDirtyMasks` 依赖集合不变。
            aoProbes(data, meta, vx, vy, vz, worldFace, [rx, ry, rz], null, null, occTable, AO_OUT);
            const ao = getAO(AO_OUT[0], AO_OUT[1], AO_OUT[2], AO_OUT[3]);
            packeds.push(faceLight | (ao << 8) | (worldFace << 10) | blockEmissiveBit | noShadowCastBit);
          }
          pushQuad(ch, positions, uvs, packeds, doubleSide);
        }
      }
    }
  }

  // 转为 typed array
  const result = {};
  let totalVertices = 0;
  for (const [name, ch] of Object.entries(channels)) {
    const vertexCount = ch.pos.length / 3;
    const indexCount = ch.idx.length;
    totalVertices += vertexCount;
    result[name] = {
      positions: new Float32Array(ch.pos),
      uvs: new Float32Array(ch.uv),
      packed: new Uint32Array(ch.packed),
      indices: new Uint32Array(ch.idx),
      vertexCount,
      indexCount,
    };
  }
  // 面剔除统计（§4.3）：供 HUD 世界数据看板展示剔除效率；开关关闭时返回 null（零采集）
  result.stats = collect
    ? {
      blocks,           // 非空方块数（出块候选）
      candidateFaces,   // 候选面数（立方体 ×6）
      faces,            // 实际出块面数
      culledFaces,      // 被剔除面数
      vertices: totalVertices,
    }
    : null;
  return result;
}
