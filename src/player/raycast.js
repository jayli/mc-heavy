// src/player/raycast.js — Amanatides-Woo DDA 体素射线（§4.5.2，DR-4）
// O(距离) 次 getBlockId；替代 mc-lite 每帧 Raycaster.intersectObjects 数万次矩阵求交。

/**
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin [x,y,z]
 * @param {number[]} dir 归一化方向 [dx,dy,dz]
 * @param {number} [maxDist=40]
 * @returns {{hit: boolean, blockPos?: number[], normal?: number[], prevPos?: number[], dist?: number}}
 */
export function raycastVoxel(world, origin, dir, maxDist = 40) {
  let [x, y, z] = origin;
  let ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const [dx, dy, dz] = dir;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? ix + 1 - x : x - ix) * tDeltaX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? iy + 1 - y : y - iy) * tDeltaY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? iz + 1 - z : z - iz) * tDeltaZ) : Infinity;
  let normal = [0, 0, 0];
  let prev = [ix, iy, iz];
  let t = 0;
  const maxSteps = Math.ceil(maxDist * 3);
  const waterId = world.registry.idOf('water');

  for (let i = 0; i < maxSteps && t <= maxDist; i++) {
    const id = world.getBlockId(ix, iy, iz);
    if (id !== 0 && id !== waterId) {
      return { hit: true, blockPos: [ix, iy, iz], normal, prevPos: prev, dist: t };
    }
    prev = [ix, iy, iz];
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      ix += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      iy += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
    } else {
      iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
    }
  }
  return { hit: false };
}
