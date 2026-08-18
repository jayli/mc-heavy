import { describe, expect, it } from 'vitest';
import {
  PLAYER_EYE_HEIGHT,
  PLAYER_JUMP_FORCE,
  PLAYER_TERMINAL_VELOCITY,
  PlayerController,
} from '../../../src/gameplay/player-controller';
import { InMemoryWorld } from '../../../src/world/world-query';

describe('PlayerController', () => {
  it('stops horizontal movement before entering a solid voxel', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 1, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });

    expect(player.step({ x: 1, z: 0 }, 1).x).toBeLessThan(0.7);
  });

  it('moves freely along an unobstructed horizontal axis', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    expect(player.step({ x: 0, z: -1 }, 0.25)).toEqual({ x: 0.5, y: 1, z: -0.5 });
  });

  it('uses the whole player width when stopping movement along z', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 1, z: 1 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.8, y: 1, z: 0.5 });

    expect(player.step({ x: 0, z: 1 }, 1).z).toBeLessThan(0.7);
  });

  it('does not enter a solid voxel when stepping positive x from exact contact', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 1, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.7, y: 1, z: 0.5 });

    expect(player.step({ x: 1, z: 0 }, 1).x).toBeLessThan(0.7);
  });

  it('does not enter a solid voxel when stepping positive z from exact contact', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 0, y: 1, z: 1 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.7 });

    expect(player.step({ x: 0, z: 1 }, 1).z).toBeLessThan(0.7);
  });

  it('allows a player with a gap to advance until the solid voxel boundary', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 1, y: 1, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.69, y: 1, z: 0.5 });

    const position = player.step({ x: 1, z: 0 }, 1);
    expect(position.x).toBeGreaterThan(0.69);
    expect(position.x).toBeLessThan(0.7);
  });

  it('defaults to a level look facing negative z', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    expect(player.yaw).toBe(0);
    expect(player.pitch).toBe(0);
    expect(player.facing).toEqual({ x: 0, z: -1 });
    expect(player.viewDirection).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('looks straight up at pitch pi/2 and clamps out-of-range pitch', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    player.setLook(0, Math.PI / 2);
    const direction = player.viewDirection;
    expect(direction.x).toBeCloseTo(0);
    expect(direction.y).toBeCloseTo(1);
    expect(direction.z).toBeCloseTo(0);
    expect(player.pitch).toBe(Math.PI / 2);

    player.setLook(0.5, 2);
    expect(player.pitch).toBe(Math.PI / 2);
    player.setLook(0.5, -2);
    expect(player.pitch).toBe(-Math.PI / 2);
  });

  it('turns by the literal 0.002 radians per pixel sensitivity', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    player.turn(100, -100);

    // Mouse right is +movementX and must turn the view toward +X; mouse up is
    // -movementY and must pitch the view up.
    expect(player.yaw).toBeCloseTo(-0.2, 5);
    expect(player.pitch).toBeCloseTo(0.2, 5);
    expect(player.facing.x).toBeGreaterThan(0);
  });

  it('derives yaw from setFacing and stops overwriting look from movement input', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    player.setFacing({ x: 1, z: 0 });
    expect(player.yaw).toBeCloseTo(-Math.PI / 2, 5);
    expect(player.facing.x).toBeCloseTo(1);
    expect(player.facing.z).toBeCloseTo(0);

    player.step({ x: 0, z: -1 }, 0.25);

    expect(player.facing.x).toBeCloseTo(1);
    expect(player.facing.z).toBeCloseTo(0);
    expect(player.yaw).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('rejects non-finite look values and turn deltas', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 1, z: 0.5 });

    expect(() => player.setLook(Number.NaN, 0)).toThrow('finite');
    expect(() => player.setLook(0, Number.POSITIVE_INFINITY)).toThrow('finite');
    expect(() => player.turn(Number.NaN, 0)).toThrow('finite');
  });

  it('falls under gravity and settles on a solid floor', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 3, z: 0.5 });

    for (let frame = 0; frame < 240; frame += 1) player.applyVerticalPhysics(1 / 60);

    expect(player.position.y).toBeCloseTo(1, 5);
    expect(player.isOnGround).toBe(true);
    expect(player.verticalVelocity).toBe(0);
  });

  it('jumps only from the ground and falls back under gravity', () => {
    const world = new InMemoryWorld();
    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 1 }]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });

    player.applyVerticalPhysics(1 / 60);
    player.requestJump();
    player.applyVerticalPhysics(1 / 60);

    expect(player.verticalVelocity).toBe(PLAYER_JUMP_FORCE);
    expect(player.isOnGround).toBe(false);
    player.applyVerticalPhysics(1 / 60);
    expect(player.verticalVelocity).toBeLessThan(PLAYER_JUMP_FORCE);
  });

  it('keeps step horizontal and bounds falling velocity at the terminal value', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 80, z: 0.5 });

    player.step({ x: 1, z: 0 }, 0.25);
    expect(player.position.y).toBe(80);
    for (let frame = 0; frame < 200; frame += 1) player.applyVerticalPhysics(1 / 20);
    expect(player.verticalVelocity).toBeGreaterThanOrEqual(PLAYER_TERMINAL_VELOCITY);
  });

  it('stops an upward jump at a ceiling and settles back on the ground', () => {
    const world = new InMemoryWorld();
    world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: 1 },
      { pos: { x: 0, y: 2, z: 0 }, blockId: 1 },
    ]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });
    player.applyVerticalPhysics(1 / 60);
    player.requestJump();

    for (let frame = 0; frame < 120; frame += 1) player.applyVerticalPhysics(1 / 60);

    expect(player.position.y).toBeLessThan(2);
    expect(player.isOnGround).toBe(true);
  });

  it('exposes the eye position above the feet', () => {
    const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 25, z: 0.5 });

    expect(player.eyePosition).toEqual({ x: 0.5, y: 25 + PLAYER_EYE_HEIGHT, z: 0.5 });
  });

  it('steps up onto a one-block ledge while walking', () => {
    const world = new InMemoryWorld();
    world.applyEdits([
      { pos: { x: 0, y: 0, z: 0 }, blockId: 1 },
      { pos: { x: 1, y: 1, z: 0 }, blockId: 1 },
    ]);
    const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });
    player.applyVerticalPhysics(1 / 60);

    player.step({ x: 1, z: 0 }, 1);

    expect(player.position.x).toBeGreaterThan(1);
    expect(player.position.y).toBe(2);
  });
});
