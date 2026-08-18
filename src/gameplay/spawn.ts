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
