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
const FACE_VERTICES = [
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
const FACE_UVS = [
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

/** 局部偏移（相对块中心）按 90° 步长绕 Y 轴旋转：o=1: (dx,dy,dz)→(dz,dy,-dx) */
function rotateOffset(dx, dy, dz, o) {
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

function getAO(side1, side2, corner) {
  // 经典四角 AO（mc-lite AOUtils.getAOValue 语义逐行一致）：
  // 只有当侧边存在时才考虑对角；两侧都遮挡 → 0（最暗）
  const c = (side1 || side2) ? (corner ? 1 : 0) : 0;
  if (side1 && side2) return 0;
  return 3 - (side1 + side2 + c);
}

/**
 * 从顶点坐标推导 AO 邻居（不查表——mc-lite AOUtils 的偏移表绑定其自身顶点序，
 * 直接搬会错位；此处按"顶点相对面法线的两个切向 ± 方向"推导，与顶点序无关）。
 * 切向 ± 侧按四舍五入到最近格角（>=0.5 → +1）：单位立方体顶点（0/1）行为不变，
 * 子格模板顶点（台阶/栏杆等 0.25/0.875…）取最近格角，与 mc-lite 整格 AO 口径一致。
 * @param {number} face 面索引 0-5
 * @param {number[]} v 顶点局部坐标 [fx,fy,fz]
 * @returns {number[][]} [side1Offset, side2Offset, cornerOffset]（各 3 分量）
 */
function aoOffsetsFor(face, v) {
  const n = FACE_DIRS[face]; // 面法线（±1 单轴）
  // 两个切向轴 = 非法线的轴
  const axes = [0, 1, 2].filter((a) => n[a] === 0);
  const offs = [];
  for (const a of axes) {
    const o = [n[0], n[1], n[2]];
    o[a] = v[a] >= 0.5 ? 1 : -1; // 顶点在该切向的 ± 侧
    offs.push(o);
  }
  const corner = [
    offs[0][0] + offs[1][0] - n[0],
    offs[0][1] + offs[1][1] - n[1],
    offs[0][2] + offs[1][2] - n[2],
  ];
  return [offs[0], offs[1], corner];
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

// 台阶 L 形（mc-lite geoPlanksStep：下半全幅 + 左上 1/4 柱）
const STEP_QUADS = [
  ...boxQuads(0, 0, 0, 1, 0.5, 1),
  ...boxQuads(0, 0.5, 0, 0.5, 1, 1),
];
// 上下颠倒台阶（geoCobblestoneStepUpdown：上半全幅 + 右下 1/4 柱）
const STEP_UPDOWN_QUADS = [
  ...boxQuads(0, 0.5, 0, 1, 1, 1),
  ...boxQuads(0.5, 0, 0, 1, 0.5, 1),
];

const TEMPLATES = {
  // 花/草：0.7×0.7 cross，y∈[-0.1,0.6]（geoFlower：中心偏移 -0.25）
  flower: crossQuads(0.7, -0.1, 0.6),
  // 藤蔓：0.8 宽 × 1.0 高 cross，y∈[0.5,1.5]（geoVine：translate +0.5，堆叠连续）
  vine: crossQuads(0.8, 0.5, 1.5),
  // 睡莲：0.8×0.8 水平 quad，y=0.02（geoLily：贴块底 = 贴水面）
  // (x,z) 序 (0,1),(1,1),(1,0),(0,0) = FACE_VERTICES[2] 口径（缺口朝向与 mc-lite 一致）
  lilypad: [{ v: [[0.1,0.02,0.9],[0.9,0.02,0.9],[0.9,0.02,0.1],[0.1,0.02,0.1]], face: 2, ds: true }],
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
  cobblestone_step: STEP_QUADS,
  cobblestone_step_updown: STEP_UPDOWN_QUADS,
  // 半高块（床）：1×0.5×1 底贴块底（geoHalfBlock）
  half_block: boxQuads(0, 0, 0, 1, 0.5, 1),
  // 吊灯：细绳 cross（r=0.015 亚像素，用 0.03 宽 cross 近似）+ 灯体 0.3³（geoHangingLamp）
  // 绳朝 X 平面顶点序同 crossQuads（FACE_VERTICES[0] 口径，防贴图横躺）
  hanging_lamp: [
    { v: [[0.485,0.6,0.5],[0.515,0.6,0.5],[0.515,1.0,0.5],[0.485,1.0,0.5]], face: 4, ds: true },
    { v: [[0.5,0.6,0.485],[0.5,1.0,0.485],[0.5,1.0,0.515],[0.5,0.6,0.515]], face: 0, ds: true },
    ...boxQuads(0.35, 0.35, 0.35, 0.65, 0.65, 0.65),
  ],
};

// mc-lite 材质为 DoubleSide 的立方体方块（MaterialManager 注册 side 字段）：
// 唯一 realistic_oak_leaves。单材质通道内用双向绕线复刻。
const DOUBLE_SIDE_CUBES = new Set(['realistic_oak_leaves']);

// 暴露水面下沉（issue #2 遗留）：water/swamp_water 上方无 opaque/同类水覆盖时，
// 顶面与侧面顶边下沉 0.5，与海面平面（SEA_Y+0.5）共面，消除俯视可见的蓝色顶面模。
// 方块逻辑/物理仍占整格，仅渲染几何下沉。
const WATER_LIKE = new Set(['water', 'swamp_water']);
const WATER_SURFACE_SINK = 0.5;

// 床 UV 变换（mc-lite repeat/offset/rotation → 等价角点变换，three setUvTransform 核验）：
// vHalf = repeat[1,0.5]+offset[0,0.5]（取图像上半）；uFlip = repeat[-1,…]+offset[1,…]；
// rot = rotation -π/2 →（u,v）→(1-v,u)。
const BED_UV = {
  bed_head: { 0: { uFlip: true, vHalf: true }, 1: { vHalf: true }, 2: { rot: true }, 4: { vHalf: true } },
  bed_tail: { 0: { uFlip: true, vHalf: true }, 1: { vHalf: true }, 5: { vHalf: true } },
};

function transformUV(blockName, face, u, v) {
  const t = BED_UV[blockName]?.[face];
  if (!t) return [u, v];
  let uu = u, vv = v;
  if (t.rot) { const nu = 1 - vv; vv = uu; uu = nu; }
  if (t.uFlip) uu = 1 - uu;
  if (t.vHalf) vv = 0.5 + 0.5 * vv;
  return [uu, vv];
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
  const nameOf = registry.nameOf.bind(registry);
  const tiles = atlasMeta.tiles || atlasMeta;

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
            if (!tileName) continue; // null 面（床连接面）不渲染
            const tile = tiles[tileName] || tiles['stone'] || DEFAULT_TILE;
            const worldFace = FACE_ROT[orient][q.face];
            const positions = [];
            const uvs = [];
            const packeds = [];
            for (let vi = 0; vi < 4; vi++) {
              const [qx, qy, qz] = q.v[vi];
              const [rx, ry, rz] = orient === 0 ? [qx, qy, qz] : rotateVertex(qx, qy, qz, orient);
              positions.push([lx + rx, ly + ry, lz + rz]);
              const [cu, cv] = q.uv ? q.uv[vi] : FACE_UVS[q.face][vi];
              const [uu, vv] = transformUV(blockName, q.face, cu, cv); // 模型面 UV 变换（床）
              uvs.push([tile.u0 + (tile.u1 - tile.u0) * uu, tile.v0 + (tile.v1 - tile.v0) * vv]);
              // AO 按世界面 + 旋转后顶点（遮挡是世界空间语义）
              const [s1o, s2o, co] = aoOffsetsFor(worldFace, [rx, ry, rz]);
              const s1 = opaqueTable[data[viewIdx(vx + s1o[0], vy + s1o[1], vz + s1o[2])]] === 1 ? 1 : 0;
              const s2 = opaqueTable[data[viewIdx(vx + s2o[0], vy + s2o[1], vz + s2o[2])]] === 1 ? 1 : 0;
              const co_ = opaqueTable[data[viewIdx(vx + co[0], vy + co[1], vz + co[2])]] === 1 ? 1 : 0;
              const ao = q.ds ? 3 : getAO(s1, s2, co_); // 植被 cross 开阔 AO=3（原口径）
              packeds.push(selfLight | (ao << 8) | (worldFace << 10));
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

          // 面剔除：邻居 opaque 则剔除；同类型 transparent 相邻剔除（世界面判定）
          if (opaqueTable[neighborId] === 1) { if (collect) culledFaces++; continue; }
          if (neighborId === id && cullMode >= 2) { if (collect) culledFaces++; continue; } // water/glass 同类相邻

          const tileName = getFaceTile(blockName, modelFace); // 模型面：贴图随方块转
          if (!tileName) continue; // null 面不渲染
          if (collect) faces++; // 通过剔除，实际出块
          const tile = tiles[tileName] || tiles['stone'] || DEFAULT_TILE;

          // 面亮度读"面朝向的邻居（空气）格"光照，不是方块自身格——
          // opaque 方块自身格 skylight=0（top-down 光遇 opaque 停止），读自身会全黑。
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
              tile.u0 + (tile.u1 - tile.u0) * uu,
              tile.v0 + (tile.v1 - tile.v0) * vv,
            ]);
            // AO：世界面 + 旋转后顶点（遮挡是世界空间语义）
            const [s1o, s2o, co] = aoOffsetsFor(worldFace, [rx, ry, rz]);
            const s1 = opaqueTable[data[viewIdx(vx + s1o[0], vy + s1o[1], vz + s1o[2])]] === 1 ? 1 : 0;
            const s2 = opaqueTable[data[viewIdx(vx + s2o[0], vy + s2o[1], vz + s2o[2])]] === 1 ? 1 : 0;
            const co_ = opaqueTable[data[viewIdx(vx + co[0], vy + co[1], vz + co[2])]] === 1 ? 1 : 0;
            const ao = getAO(s1, s2, co_);
            packeds.push(faceLight | (ao << 8) | (worldFace << 10));
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
