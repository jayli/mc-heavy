import type { Vec3 } from '../domain/coords';
import type { WorldQuery } from '../world/world-query';

/** 返回出生列最高非空气方块顶部之上的玩家脚底坐标；整列皆空时返回 0。 */
export function surfaceFeetY(world: WorldQuery, x: number, z: number): number {
  const blockX = Math.floor(x);
  const blockZ = Math.floor(z);
  for (let y = 127; y >= 0; y -= 1) {
    if (world.getBlock({ x: blockX, y, z: blockZ }) !== 0) return y + 1;
  }
  return 0;
}

/** 在出生点附近寻找落点是实心方块、其上方为空气的干燥空地；找不到则回退到最高表面。 */
export function findSpawnPosition(world: WorldQuery, x: number, z: number, radius = 16): Vec3 {
  const originX = Math.floor(x);
  const originZ = Math.floor(z);
  for (let r = 0; r <= radius; r += 1) {
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const blockX = originX + dx;
        const blockZ = originZ + dz;
        const feet = surfaceFeetY(world, blockX, blockZ);
        if (feet <= 0) continue;
        const support = { x: blockX, y: feet - 1, z: blockZ };
        if (world.isSolid(support) && world.getBlock({ x: blockX, y: feet, z: blockZ }) === 0) {
          return { x: blockX + 0.5, y: feet, z: blockZ + 0.5 };
        }
      }
    }
  }
  return { x, y: surfaceFeetY(world, x, z), z };
}
