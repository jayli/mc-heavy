import { describe, expect, it } from 'vitest';
import { resolveRainMinY } from '../../../src/render/rain';

describe('resolveRainMinY', () => {
  it('stops rain at the first solid floor below its drop column', () => {
    const solid = (x: number, y: number, z: number) => x === 3 && z === 4 && y === 10;

    expect(resolveRainMinY(solid, 3, 40, 4, 0)).toBeCloseTo(11.02, 5);
  });

  it('falls back below the player when no floor is found', () => {
    expect(resolveRainMinY(() => false, 1, 40, 2, 0, 8)).toBeCloseTo(-14.7, 5);
  });
});
