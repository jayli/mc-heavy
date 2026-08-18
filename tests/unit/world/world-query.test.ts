import { describe, expect, it } from 'vitest';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('InMemoryWorld edits', () => {
  it('reports one changed section for two edits in that section', () => {
    const world = new InMemoryWorld();

    expect(world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: 1 },
      { pos: { x: 1, y: 0, z: 0 }, blockId: 1 },
    ]).changedSections).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it('makes an explicit air override hide a generated stone block in a negative section', () => {
    const world = new InMemoryWorld(() => 1);

    world.applyEdits([{ pos: { x: -1, y: 0, z: -1 }, blockId: 0 }]);

    expect(world.getBlock({ x: -1, y: 0, z: -1 })).toBe(0);
  });

  it('leaves the world unchanged when an edit in a batch has an unknown block id', () => {
    const world = new InMemoryWorld();

    expect(() => world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: 1 },
      { pos: { x: 1, y: 0, z: 0 }, blockId: 9_999 },
    ])).toThrow('Unknown block id: 9999');
    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);
  });
});
