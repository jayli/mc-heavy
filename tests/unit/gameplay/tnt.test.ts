import { describe, expect, it } from 'vitest';
import { blockByKey } from '../../../src/domain/blocks';
import { computeExplosion, createTntSystem } from '../../../src/gameplay/tnt';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('computeExplosion', () => {
  it('destroys a 3x3x3 area but keeps indestructible blocks', () => {
    const world = new InMemoryWorld();
    world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: blockByKey('tnt').id },
      { pos: { x: 1, y: 0, z: 0 }, blockId: blockByKey('stone').id },
      { pos: { x: 0, y: 1, z: 1 }, blockId: blockByKey('bedrock').id },
    ]);

    const event = computeExplosion(world, { x: 0, y: 0, z: 0 }, true);

    expect(event.destroyed).toContainEqual({ x: 1, y: 0, z: 0 });
    expect(event.destroyed).not.toContainEqual({ x: 0, y: 1, z: 1 });
    expect(event.destroyed.some((pos) => pos.x === 0 && pos.y === 0 && pos.z === 0)).toBe(true);
  });

  it('chains to tnt within 5 blocks and applies edits after the delay', () => {
    const world = new InMemoryWorld();
    const tnt = blockByKey('tnt').id;
    world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: tnt },
      { pos: { x: 2, y: 0, z: 0 }, blockId: tnt },
    ]);
    let now = 0;
    const scheduled: Array<{ delayMs: number; run(): void }> = [];
    const system = createTntSystem({
      world,
      destroyBlocks: true,
      now: () => now,
      schedule: (run, delayMs) => scheduled.push({ delayMs, run }),
      onExplode: () => {},
    });

    expect(system.ignite({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(scheduled.length).toBe(1);
    now += scheduled[0].delayMs;
    scheduled[0].run();
    expect(world.getBlock({ x: 2, y: 0, z: 0 })).toBe(0);
    system.dispose();
  });

  it('keeps surrounding blocks when destruction is disabled', () => {
    const world = new InMemoryWorld();
    const tnt = blockByKey('tnt').id;
    const stone = blockByKey('stone').id;
    world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: tnt },
      { pos: { x: 1, y: 0, z: 0 }, blockId: stone },
    ]);
    const system = createTntSystem({
      world,
      destroyBlocks: false,
      now: () => 0,
      schedule: () => {},
      onExplode: () => {},
    });

    system.ignite({ x: 0, y: 0, z: 0 });

    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(world.getBlock({ x: 1, y: 0, z: 0 })).toBe(stone);
    system.dispose();
  });
});
