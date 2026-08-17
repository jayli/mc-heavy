import { describe, expect, it } from 'vitest';
import { Inventory } from '../../../src/gameplay/inventory';
import { PlayerController } from '../../../src/gameplay/player-controller';
import { PlayerInteraction } from '../../../src/gameplay/player-interaction';
import { InMemoryWorld } from '../../../src/world/world-query';

const origin = { x: 0.5, y: 0.5, z: 0.5 };
const direction = { x: 1, y: 0, z: 0 };

const interactionAt = (world: InMemoryWorld, position = { x: 0.5, y: 1, z: 0.5 }) => {
  const inventory = new Inventory();
  const player = new PlayerController(world, position);
  const interaction = new PlayerInteraction(inventory, player);
  return { inventory, player, interaction };
};

describe('PlayerInteraction', () => {
  it('removes the DDA hit block and gives exactly one matching inventory item', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
    const { inventory, interaction } = interactionAt(world);

    expect(interaction.breakBlock(world, origin, direction)).toBe(true);
    expect(world.getBlock({ x: 2, y: 0, z: 0 })).toBe(0);
    expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
  });

  it('places the selected block on the entered face', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
    const { inventory, interaction } = interactionAt(world);
    inventory.add(5, 1);

    expect(interaction.placeBlock(world, origin, direction, 5)).toBe(true);
    expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(5);
    expect(inventory.selected()).toBeNull();
  });

  it('does not place when the requested material is unavailable or not selected', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
    const { inventory, interaction } = interactionAt(world);
    inventory.add(1, 1);

    expect(interaction.placeBlock(world, origin, direction, 5)).toBe(false);
    expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(0);
    expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
  });

  it('does not place a block overlapping the player AABB', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
    const { inventory, interaction } = interactionAt(world, { x: 1.5, y: 0.5, z: 0.5 });
    inventory.add(5, 1);

    expect(interaction.placeBlock(world, origin, direction, 5)).toBe(false);
    expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(0);
    expect(inventory.selected()).toEqual({ blockId: 5, count: 1 });
  });

  it('does not mutate inventory or world when no solid block is hit', () => {
    const world = new InMemoryWorld();
    const { inventory, interaction } = interactionAt(world);
    inventory.add(5, 1);

    expect(interaction.breakBlock(world, origin, direction)).toBe(false);
    expect(interaction.placeBlock(world, origin, direction, 5)).toBe(false);
    expect(inventory.selected()).toEqual({ blockId: 5, count: 1 });
  });

  it('rejects a hit with no uniquely entered face', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 1, z: 0 }, blockId: 1 }]);
    const { inventory, interaction } = interactionAt(world);
    inventory.add(5, 1);

    expect(interaction.placeBlock(world, origin, { x: 1, y: 1, z: 0 }, 5)).toBe(false);
    expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(0);
    expect(inventory.selected()).toEqual({ blockId: 5, count: 1 });
  });

  it('persists wood orientation 3 when the player faces negative z', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 1 }]);
    const { inventory, player, interaction } = interactionAt(world);
    inventory.add(5, 1);
    player.setFacing({ x: 0, z: -1 });

    expect(interaction.placeBlock(world, origin, direction, 5)).toBe(true);
    expect(world.getOrientation({ x: 1, y: 0, z: 0 })).toBe(3);
  });

  it('clears a stored orientation when its block is broken to air', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 2, y: 0, z: 0 }, blockId: 5, orientation: 3 }]);
    const { interaction } = interactionAt(world);

    expect(interaction.breakBlock(world, origin, direction)).toBe(true);
    expect(world.getOrientation({ x: 2, y: 0, z: 0 })).toBeUndefined();
  });
});
