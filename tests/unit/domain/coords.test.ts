import { describe, expect, it } from 'vitest';
import { localIndex, localPos, sectionOf } from '../../../src/domain/coords';

describe('voxel coordinates', () => {
  it('maps the block at -1, 0, -17 to its negative section and local cell', () => {
    expect(sectionOf({ x: -1, y: 0, z: -17 })).toEqual({ x: -1, y: 0, z: -2 });
    expect(localIndex({ x: -1, y: 0, z: -17 })).toBe(255);
  });

  it('round-trips the highest local cell', () => {
    expect(localPos(4095)).toEqual({ x: 15, y: 15, z: 15 });
  });
});
