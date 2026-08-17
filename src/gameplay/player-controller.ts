import type { Vec3 } from '../domain/coords';
import type { WorldQuery } from '../world/world-query';

export type HorizontalDirection = Readonly<{ x: number; z: number }>;

export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_BELOW_POSITION = 1;
export const PLAYER_ABOVE_POSITION = 0.8;

const WALK_SPEED = 4;
const LOOK_SENSITIVITY = 0.002;
const HALF_PI = Math.PI / 2;
const COLLISION_EPSILON = 0.0001;

export class PlayerController {
  private positionValue: Vec3;
  private yawValue = 0;
  private pitchValue = 0;

  constructor(
    private readonly world: WorldQuery,
    initialPosition: Vec3,
  ) {
    this.positionValue = { ...initialPosition };
  }

  get position(): Vec3 {
    return Object.freeze({ ...this.positionValue });
  }

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  get facing(): HorizontalDirection {
    return Object.freeze({
      x: -Math.sin(this.yawValue) + 0,
      z: -Math.cos(this.yawValue),
    });
  }

  get viewDirection(): Vec3 {
    const facing = this.facing;
    const horizontal = Math.cos(this.pitchValue);
    return Object.freeze({
      x: facing.x * horizontal,
      y: Math.sin(this.pitchValue),
      z: facing.z * horizontal,
    });
  }

  setLook(yaw: number, pitch: number): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      throw new Error('Player look values must be finite');
    }
    this.yawValue = yaw;
    this.pitchValue = clampPitch(pitch);
  }

  turn(deltaYawPixels: number, deltaPitchPixels: number): void {
    if (!Number.isFinite(deltaYawPixels) || !Number.isFinite(deltaPitchPixels)) {
      throw new Error('Player turn deltas must be finite');
    }
    this.yawValue += deltaYawPixels * LOOK_SENSITIVITY;
    this.pitchValue = clampPitch(this.pitchValue - deltaPitchPixels * LOOK_SENSITIVITY);
  }

  setFacing(direction: HorizontalDirection): void {
    const length = Math.hypot(direction.x, direction.z);
    if (!Number.isFinite(length) || length === 0) {
      throw new Error('Player facing direction must be finite and non-zero');
    }
    const x = direction.x / length;
    const z = direction.z / length;
    this.yawValue = Math.atan2(-x, -z);
  }

  step(input: Readonly<{ x: number; z: number }>, dtSeconds: number): Vec3 {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return this.position;
    const inputLength = Math.hypot(input.x, input.z);
    if (!Number.isFinite(inputLength) || inputLength === 0) return this.position;

    const movement = {
      x: (input.x / inputLength) * WALK_SPEED * dtSeconds,
      z: (input.z / inputLength) * WALK_SPEED * dtSeconds,
    };
    const afterX = { ...this.positionValue, x: this.moveAlongX(movement.x) };
    this.positionValue = { ...afterX, z: this.moveAlongZ(afterX, movement.z) };
    return this.position;
  }

  private moveAlongX(distance: number): number {
    if (distance === 0) return this.positionValue.x;

    const { y, z } = this.positionValue;
    if (distance > 0) {
      const first = Math.floor(this.positionValue.x + PLAYER_HALF_WIDTH + COLLISION_EPSILON);
      const last = Math.floor(this.positionValue.x + PLAYER_HALF_WIDTH + distance);
      for (let x = first; x <= last; x += 1) {
        if (this.solidColumnAlongX(x, y, z)) return x - PLAYER_HALF_WIDTH - COLLISION_EPSILON;
      }
    } else {
      const first = Math.floor(this.positionValue.x - PLAYER_HALF_WIDTH) - 1;
      const last = Math.floor(this.positionValue.x - PLAYER_HALF_WIDTH + distance);
      for (let x = first; x >= last; x -= 1) {
        if (this.solidColumnAlongX(x, y, z)) return x + 1 + PLAYER_HALF_WIDTH + COLLISION_EPSILON;
      }
    }
    return this.positionValue.x + distance;
  }

  private moveAlongZ(position: Vec3, distance: number): number {
    if (distance === 0) return position.z;

    if (distance > 0) {
      const first = Math.floor(position.z + PLAYER_HALF_WIDTH + COLLISION_EPSILON);
      const last = Math.floor(position.z + PLAYER_HALF_WIDTH + distance);
      for (let z = first; z <= last; z += 1) {
        if (this.solidColumnAlongZ(position.x, z, position.y)) return z - PLAYER_HALF_WIDTH - COLLISION_EPSILON;
      }
    } else {
      const first = Math.floor(position.z - PLAYER_HALF_WIDTH) - 1;
      const last = Math.floor(position.z - PLAYER_HALF_WIDTH + distance);
      for (let z = first; z >= last; z -= 1) {
        if (this.solidColumnAlongZ(position.x, z, position.y)) return z + 1 + PLAYER_HALF_WIDTH + COLLISION_EPSILON;
      }
    }
    return position.z + distance;
  }

  private solidColumnAlongX(x: number, y: number, z: number): boolean {
    const minY = Math.floor(y - PLAYER_BELOW_POSITION + COLLISION_EPSILON);
    const maxY = Math.floor(y + PLAYER_ABOVE_POSITION - COLLISION_EPSILON);
    const minZ = Math.floor(z - PLAYER_HALF_WIDTH + COLLISION_EPSILON);
    const maxZ = Math.floor(z + PLAYER_HALF_WIDTH - COLLISION_EPSILON);
    for (let blockZ = minZ; blockZ <= maxZ; blockZ += 1) {
      for (let blockY = minY; blockY <= maxY; blockY += 1) {
        if (this.world.isSolid({ x, y: blockY, z: blockZ })) return true;
      }
    }
    return false;
  }

  private solidColumnAlongZ(x: number, z: number, y: number): boolean {
    const minX = Math.floor(x - PLAYER_HALF_WIDTH + COLLISION_EPSILON);
    const maxX = Math.floor(x + PLAYER_HALF_WIDTH - COLLISION_EPSILON);
    const minY = Math.floor(y - PLAYER_BELOW_POSITION + COLLISION_EPSILON);
    const maxY = Math.floor(y + PLAYER_ABOVE_POSITION - COLLISION_EPSILON);
    for (let blockX = minX; blockX <= maxX; blockX += 1) {
      for (let blockY = minY; blockY <= maxY; blockY += 1) {
        if (this.world.isSolid({ x: blockX, y: blockY, z })) return true;
      }
    }
    return false;
  }
}

const clampPitch = (pitch: number): number => Math.max(-HALF_PI, Math.min(HALF_PI, pitch));
