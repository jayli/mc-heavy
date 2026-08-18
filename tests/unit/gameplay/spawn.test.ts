import { describe, expect, it } from 'vitest';
import { findSpawnPosition, surfaceFeetY } from '../../../src/gameplay/spawn';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('surfaceFeetY', () => {
  it('places feet on top of the highest non-air block', () => {
    const world = new InMemoryWorld();
    world.applyEdits([
      { pos: { x: 0, y: 23, z: 0 }, blockId: 4 },
      { pos: { x: 0, y: 24, z: 0 }, blockId: 3 },
    ]);

    expect(surfaceFeetY(world, 0.5, 0.5)).toBe(25);
  });

  it('returns zero for an all-air column', () => {
    expect(surfaceFeetY(new InMemoryWorld(), 0.5, 0.5)).toBe(0);
  });

  it('prefers a dry column over a waterlogged one', () => {
    const world = new InMemoryWorld();
    world.applyEdits([
      { pos: { x: 0, y: 23, z: 0 }, blockId: 4 },
      { pos: { x: 0, y: 24, z: 0 }, blockId: 3 },
      { pos: { x: 1, y: 25, z: 0 }, blockId: 4 },
    ]);

    expect(findSpawnPosition(world, 0.5, 0.5, 3)).toEqual({ x: 1.5, y: 26, z: 0.5 });
  });
});
