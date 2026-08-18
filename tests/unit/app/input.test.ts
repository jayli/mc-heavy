import { describe, expect, it } from 'vitest';
import { movementInputFromKeys } from '../../../src/app/input';

describe('movementInputFromKeys', () => {
  it('maps W and D to forward and strafe at the default yaw', () => {
    expect(movementInputFromKeys(new Set(['w']), 0)).toEqual({ x: 0, z: -1 });
    expect(movementInputFromKeys(new Set(['d']), 0)).toEqual({ x: 1, z: 0 });
    expect(movementInputFromKeys(new Set(['w', 'd']), 0)).toEqual({ x: 1, z: -1 });
  });

  it('maps S and A to backward and strafe-left at the default yaw', () => {
    expect(movementInputFromKeys(new Set(['s']), 0)).toEqual({ x: 0, z: 1 });
    expect(movementInputFromKeys(new Set(['a']), 0)).toEqual({ x: -1, z: 0 });
  });

  it('rotates forward with the camera yaw instead of using fixed world axes', () => {
    const west = movementInputFromKeys(new Set(['w']), Math.PI / 2);
    expect(west.x).toBeCloseTo(-1, 10);
    expect(west.z).toBeCloseTo(0, 10);

    const south = movementInputFromKeys(new Set(['w']), Math.PI);
    expect(south.x).toBeCloseTo(0, 10);
    expect(south.z).toBeCloseTo(1, 10);
  });

  it('treats arrow keys as the same forward, back, left and right input', () => {
    expect(movementInputFromKeys(new Set(['arrowup']), 0)).toEqual({ x: 0, z: -1 });
    expect(movementInputFromKeys(new Set(['arrowdown']), 0)).toEqual({ x: 0, z: 1 });
    expect(movementInputFromKeys(new Set(['arrowleft']), 0)).toEqual({ x: -1, z: 0 });
    expect(movementInputFromKeys(new Set(['arrowright']), 0)).toEqual({ x: 1, z: 0 });
  });

  it('returns zero movement when no movement key is pressed', () => {
    expect(movementInputFromKeys(new Set(), 0.7)).toEqual({ x: 0, z: 0 });
  });
});
