import { blockById, blockByKey } from '../domain/blocks';
import type { BlockPos } from '../domain/coords';
import type { WorldQuery } from '../world/world-query';

export type ExplosionEvent = Readonly<{
  center: BlockPos;
  destroyed: readonly BlockPos[];
  ignited: readonly Readonly<{ pos: BlockPos; delayMs: number }>[];
}>;

export type TntSystemDeps = Readonly<{
  world: WorldQuery;
  destroyBlocks: boolean;
  now(): number;
  schedule(run: () => void, delayMs: number): void;
  onExplode(event: ExplosionEvent): void;
}>;

export type TntSystem = Readonly<{
  ignite(pos: BlockPos): boolean;
  setDestroyBlocks(enabled: boolean): void;
  dispose(): void;
}>;

const samePosition = (left: BlockPos, right: BlockPos): boolean => (
  left.x === right.x && left.y === right.y && left.z === right.z
);

export function computeExplosion(
  world: WorldQuery,
  center: BlockPos,
  destroyBlocks: boolean,
): ExplosionEvent {
  const destroyed: BlockPos[] = [];
  const ignited: ExplosionEvent['ignited'][number][] = [];
  const tntId = blockByKey('tnt').id;

  if (destroyBlocks) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const pos = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
          const blockId = world.getBlock(pos);
          if (blockId === 0 || blockById(blockId).indestructible) continue;
          destroyed.push(pos);
        }
      }
    }
  }

  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const pos = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
        if (world.getBlock(pos) === tntId) {
          ignited.push({ pos, delayMs: 500 + Math.random() * 600 });
        }
      }
    }
  }

  return Object.freeze({
    center,
    destroyed: Object.freeze(destroyed),
    ignited: Object.freeze(ignited),
  });
}

export function createTntSystem(deps: TntSystemDeps): TntSystem {
  let destroyBlocks = deps.destroyBlocks;
  let disposed = false;

  const ignite = (pos: BlockPos): boolean => {
    if (disposed || deps.world.getBlock(pos) !== blockByKey('tnt').id) return false;
    const event = computeExplosion(deps.world, pos, destroyBlocks);
    const edits = [
      { pos, blockId: 0 },
      ...event.destroyed.filter((block) => !samePosition(block, pos)).map((block) => ({
        pos: block,
        blockId: 0,
      })),
    ];
    deps.world.applyEdits(edits);
    deps.onExplode(event);
    for (const chain of event.ignited) {
      deps.schedule(() => ignite(chain.pos), chain.delayMs);
    }
    return true;
  };

  return Object.freeze({
    ignite,
    setDestroyBlocks(enabled: boolean) {
      destroyBlocks = enabled;
    },
    dispose() {
      disposed = true;
    },
  });
}
