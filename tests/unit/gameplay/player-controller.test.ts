import { describe, expect, it } from 'vitest';
import { PlayerController } from '../../../src/gameplay/player-controller';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('PlayerController', () => {
  it('stops horizontal movement before entering a solid voxel', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 0, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });

    expect(player.step({ x: 1, z: 0 }, 1).x).toBeLessThan(0.7);
  });

  it('moves freely along an unobstructed horizontal axis', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    expect(player.step({ x: 0, z: -1 }, 0.25)).toEqual({ x: 0.5, y: 1, z: -0.5 });
  });

  it('uses the whole player width when stopping movement along z', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 0, z: 1 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.8, y: 1, z: 0.5 });

    expect(player.step({ x: 0, z: 1 }, 1).z).toBeLessThan(0.7);
  });

  it('does not enter a solid voxel when stepping positive x from exact contact', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 0, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.7, y: 1, z: 0.5 });

    expect(player.step({ x: 1, z: 0 }, 1).x).toBeLessThan(0.7);
  });

  it('does not enter a solid voxel when stepping positive z from exact contact', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 0, y: 0, z: 1 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.7 });

    expect(player.step({ x: 0, z: 1 }, 1).z).toBeLessThan(0.7);
  });

  it('allows a player with a gap to advance until the solid voxel boundary', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 0, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.69, y: 1, z: 0.5 });

    const position = player.step({ x: 1, z: 0 }, 1);
    expect(position.x).toBeGreaterThan(0.69);
    expect(position.x).toBeLessThan(0.7);
  });
});
