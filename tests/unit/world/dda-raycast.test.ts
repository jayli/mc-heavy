import { describe, expect, it } from 'vitest';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('InMemoryWorld raycast', () => {
  it('hits the first solid voxel on the ray and returns the entered face normal', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);

    expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 8)).toMatchObject({
      block: { x: 2, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 0 }, blockId: 1,
    });
  });

  it('does not hit a block beyond the maximum ray distance', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);

    expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 1, y: 0, z: 0 }, 1.49)).toBeNull();
  });

  it('steps along the ray axis that reaches the next voxel boundary first', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 0, y: 2, z: 0 }, blockId: 1 }]);

    expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 1, z: 0 }, 8)).toMatchObject({
      block: { x: 0, y: 2, z: 0 }, normal: { x: 0, y: -1, z: 0 }, blockId: 1,
    });
  });
});
