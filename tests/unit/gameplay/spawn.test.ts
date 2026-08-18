import { describe, expect, it } from 'vitest';
import { surfaceFeetY } from '../../../src/gameplay/spawn';
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
});
