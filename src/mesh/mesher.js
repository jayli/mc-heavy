// src/mesh/mesher.js — 逐面网格化（§4.3，DR-15）
// Worker/主线程同构：本文件不得 import three。
import { getFaceTile } from '../voxel/faces-data.js';
import { SECTION_SIZE } from '../voxel/constants.js';

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

// 每面的 UV 映射（对应 FACE_VERTICES 的 4 个顶点）
const FACE_UVS = [[0,0],[1,0],[1,1],[0,1]];

function viewIdx(dx, dy, dz) { return dx + dz * 18 + dy * 324; }

// atlas 完全缺失时的兜底 UV（防 tile 查表落空 crash；正常路径总有 tiles['stone']）
const DEFAULT_TILE = { u0: 0, v0: 0, u1: 0.01, v1: 0.01 };

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
 * @param {number} face 面索引 0-5
 * @param {number[]} v 顶点局部坐标 [fx,fy,fz]（0 或 1）
 * @returns {number[][]} [side1Offset, side2Offset, cornerOffset]（各 3 分量）
 */
function aoOffsetsFor(face, v) {
  const n = FACE_DIRS[face]; // 面法线（±1 单轴）
  // 两个切向轴 = 非法线的轴
  const axes = [0, 1, 2].filter((a) => n[a] === 0);
  const offs = [];
  for (const a of axes) {
    const o = [n[0], n[1], n[2]];
    o[a] = v[a] === 1 ? 1 : -1; // 顶点在该切向的 ± 侧
    offs.push(o);
  }
  const corner = [
    offs[0][0] + offs[1][0] - n[0],
    offs[0][1] + offs[1][1] - n[1],
    offs[0][2] + offs[1][2] - n[2],
  ];
  return [offs[0], offs[1], corner];
}

/**
 * 构建单个 section 的三通道网格数据。
 * @param {{data: Uint16Array, light: Uint8Array, missing: boolean}} view
 * @param {*} registry
 * @param {Object} atlasMeta - tiles: { tileName: {u0,v0,u1,v1} }
 * @param {number} _cx @param {number} _sy @param {number} _cz section 世界坐标（M1 未用，保留接口对称）
 * @returns {{opaque: SectionGeomData, cutout: SectionGeomData, transparent: SectionGeomData}}
 */
export function buildSectionMesh(view, registry, atlasMeta, _cx, _sy, _cz) {
  const { data, light } = view;
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

  for (let ly = 0; ly < SECTION_SIZE; ly++) {
    for (let lz = 0; lz < SECTION_SIZE; lz++) {
      for (let lx = 0; lx < SECTION_SIZE; lx++) {
        // halo 视图坐标：中心 section 从 (1,1,1) 开始
        const vx = lx + 1, vy = ly + 1, vz = lz + 1;
        const id = data[viewIdx(vx, vy, vz)];
        if (id === 0) continue;

        const cullMode = cullTable[id];
        if (cullMode === 3) continue; // none：不渲染
        const channel = channelNames[cullMode]; // 0→opaque, 1→cutout, 2→transparent
        const ch = channels[channel];
        const blockName = nameOf(id);

        // 非立方体几何（§4.3 顶点模板）：flower/vine = cross 双 quad，lilypad = 水平单 quad。
        // 不做面剔除/AO（植被不遮挡、自身格即光照格）；DoubleSide 由 cutout 材质保证。
        const geom = registry.geometryNameOf(id);
        if (geom === 'flower' || geom === 'vine' || geom === 'lilypad') {
          const tile = tiles[getFaceTile(blockName, 4)] || tiles['stone'] || DEFAULT_TILE;
          const selfLight = light[viewIdx(vx, vy, vz)];
          const packed = selfLight | (3 << 8); // AO=3（开阔）
          const quads = geom === 'lilypad'
            ? [[0, 0.9375, 0, 1, 0.9375, 0, 1, 0.9375, 1, 0, 0.9375, 1, 2]]
            : [
              [0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 4],
              [1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0],
            ];
          for (const q of quads) {
            const face = q[12];
            const vertBase = ch.pos.length / 3;
            for (let vi = 0; vi < 4; vi++) {
              ch.pos.push(lx + q[vi * 3], ly + q[vi * 3 + 1], lz + q[vi * 3 + 2]);
              const [uu, vv] = FACE_UVS[vi];
              ch.uv.push(tile.u0 + (tile.u1 - tile.u0) * uu, tile.v0 + (tile.v1 - tile.v0) * vv);
              ch.packed.push(packed | (face << 10));
            }
            ch.idx.push(vertBase, vertBase + 1, vertBase + 2, vertBase, vertBase + 2, vertBase + 3);
          }
          continue;
        }

        for (let face = 0; face < 6; face++) {
          const [dx, dy, dz] = FACE_DIRS[face];
          const nx = vx + dx, ny = vy + dy, nz = vz + dz;
          const neighborId = data[viewIdx(nx, ny, nz)];

          // 面剔除：邻居 opaque 则剔除；同类型 transparent 相邻剔除
          if (opaqueTable[neighborId] === 1) continue;
          if (neighborId === id && cullMode >= 2) continue; // water/glass 同类相邻

          const tileName = getFaceTile(blockName, face);
          const tile = tiles[tileName] || tiles['stone'] || DEFAULT_TILE;

          const vertBase = ch.pos.length / 3;
          // 面亮度读"面朝向的邻居（空气）格"光照，不是方块自身格——
          // opaque 方块自身格 skylight=0（top-down 光遇 opaque 停止），读自身会全黑。
          const faceLight = light[viewIdx(nx, ny, nz)];
          for (let vi = 0; vi < 4; vi++) {
            const [fx, fy, fz] = FACE_VERTICES[face][vi];
            ch.pos.push(lx + fx, ly + fy, lz + fz);
            const [uu, vv] = FACE_UVS[vi];
            ch.uv.push(
              tile.u0 + (tile.u1 - tile.u0) * uu,
              tile.v0 + (tile.v1 - tile.v0) * vv,
            );
            // AO：四角 AO（从顶点坐标推导邻居，与顶点序无关）
            const [s1o, s2o, co] = aoOffsetsFor(face, FACE_VERTICES[face][vi]);
            const s1 = opaqueTable[data[viewIdx(vx + s1o[0], vy + s1o[1], vz + s1o[2])]] === 1 ? 1 : 0;
            const s2 = opaqueTable[data[viewIdx(vx + s2o[0], vy + s2o[1], vz + s2o[2])]] === 1 ? 1 : 0;
            const co_ = opaqueTable[data[viewIdx(vx + co[0], vy + co[1], vz + co[2])]] === 1 ? 1 : 0;
            const ao = getAO(s1, s2, co_);
            const packed = faceLight | (ao << 8) | (face << 10);
            ch.packed.push(packed);
          }
          ch.idx.push(vertBase, vertBase + 1, vertBase + 2, vertBase, vertBase + 2, vertBase + 3);
        }
      }
    }
  }

  // 转为 typed array
  const result = {};
  for (const [name, ch] of Object.entries(channels)) {
    const vertexCount = ch.pos.length / 3;
    const indexCount = ch.idx.length;
    result[name] = {
      positions: new Float32Array(ch.pos),
      uvs: new Float32Array(ch.uv),
      packed: new Uint32Array(ch.packed),
      indices: new Uint32Array(ch.idx),
      vertexCount,
      indexCount,
    };
  }
  return result;
}
