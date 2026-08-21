// src/gen/caves.js — 洞穴生成（M2-4）：3D 噪声挖空 + mc-lite rooms 空腔保留（设计文档 §4.2）
// 深度范围 y ∈ [WORLD_MIN_Y+4, 地表-4]；不穿透基岩；封闭洞穴 skylight=0 由垂直光照自动保证。
// Worker 同构：本文件不得 import three。
import { generateHeight } from './terrain.js';
import { WORLD_MIN_Y, WORLD_MAX_Y, blockIndex } from '../voxel/constants.js';

// ---- rooms（mc-lite WorldWorker LCG 空腔，逐 column 确定性）----
const ROOMS_PER_CHUNK = 2;
const MAX_ROOM_SIZE = 5;

/** mc-lite rooms 算法原样移植：room 的 Y 为地层深度 k（2 起） */
function computeRooms(cx, cz, seed) {
  const rooms = [];
  const roomSeed = Math.abs((cx * 73856093) ^ (cz * 19349663) ^ seed);
  let rRand = roomSeed;
  const nextRand = () => {
    rRand = (rRand * 1103515245 + 12345) & 0x7fffffff;
    return rRand / 0x7fffffff;
  };
  for (let i = 0; i < ROOMS_PER_CHUNK; i++) {
    const rx = Math.floor(nextRand() * 16);
    const rz = Math.floor(nextRand() * 16);
    const ry = 2 + Math.floor(nextRand() * (MAX_ROOM_SIZE - 1));
    const rw = 2 + Math.floor(nextRand() * (MAX_ROOM_SIZE - 1));
    const rh = 2 + Math.floor(nextRand() * (MAX_ROOM_SIZE - 1));
    const rd = 2 + Math.floor(nextRand() * (MAX_ROOM_SIZE - 1));
    rooms.push({
      minX: rx - Math.floor(rw / 2), maxX: rx + Math.floor(rw / 2),
      minY: ry, maxY: ry + rh,
      minZ: rz - Math.floor(rd / 2), maxZ: rz + Math.floor(rd / 2),
    });
  }
  return rooms;
}

// ---- 3D 值噪声（三线性插值，晶格哈希确定性）----
function lattice(x, y, z, seed) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
  return v - Math.floor(v);
}

function smooth(t) { return t * t * (3 - 2 * t); }

/** 3D 值噪声 ∈ [0,1]（水平尺度 ~1/16，垂直 ~1/10） */
export function noise3D(x, y, z, seed) {
  const xs = x / 16, ys = y / 10, zs = z / 16;
  const x0 = Math.floor(xs), y0 = Math.floor(ys), z0 = Math.floor(zs);
  const u = smooth(xs - x0), v = smooth(ys - y0), w = smooth(zs - z0);
  const c000 = lattice(x0, y0, z0, seed), c100 = lattice(x0 + 1, y0, z0, seed);
  const c010 = lattice(x0, y0 + 1, z0, seed), c110 = lattice(x0 + 1, y0 + 1, z0, seed);
  const c001 = lattice(x0, y0, z0 + 1, seed), c101 = lattice(x0 + 1, y0, z0 + 1, seed);
  const c011 = lattice(x0, y0 + 1, z0 + 1, seed), c111 = lattice(x0 + 1, y0 + 1, z0 + 1, seed);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0v = x00 + (x10 - x00) * v;
  const y1v = x01 + (x11 - x01) * v;
  return y0v + (y1v - y0v) * w;
}

/** 洞穴挖空阈值（> 则挖空；标定值：保证洞体连通且不过密） */
const CAVE_THRESHOLD = 0.72;

/**
 * 洞穴挖空（fillColumn 之后、结构注入之前调用；生成路径不记 edits/不 bump version）。
 * @param {import('../voxel/chunk-column.js').ChunkColumn} column
 * @param {number} seed
 */
export function carveCaves(column, seed) {
  const rooms = computeRooms(column.cx, column.cz, seed);

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = column.cx * 16 + lx;
      const wz = column.cz * 16 + lz;
      const h = generateHeight(wx, wz, seed);
      const top = Math.min(h - 4, WORLD_MAX_Y - 1);

      // 3D 噪声大洞
      for (let y = WORLD_MIN_Y + 4; y <= top; y++) {
        if (noise3D(wx, y, wz, seed) > CAVE_THRESHOLD) column.blocks[blockIndex(lx, y, lz)] = 0;
      }

      // rooms 空腔（mc-lite：地层深度 k ∈ [minY, maxY]）
      for (const r of rooms) {
        if (lx < r.minX || lx > r.maxX || lz < r.minZ || lz > r.maxZ) continue;
        for (let k = r.minY; k <= r.maxY; k++) {
          const y = h - k;
          if (y < WORLD_MIN_Y + 4 || y > top) continue;
          column.blocks[blockIndex(lx, y, lz)] = 0;
        }
      }
    }
  }
}
