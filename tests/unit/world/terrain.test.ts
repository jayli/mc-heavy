import { describe, expect, it } from 'vitest';
import { createGenerator } from '../../../src/world/terrain';

describe('deterministic terrain generator', () => {
  it('returns the same feature manifest irrespective of request order', () => {
    const generator = createGenerator(42);
    const first = generator.featuresForSupercell(0, 0);

    generator.featuresForSupercell(8, -3);

    expect(generator.featuresForSupercell(0, 0)).toEqual(first);
  });

  it('generates identical blocks for identical seed and position', () => {
    const first = createGenerator(42);
    const second = createGenerator(42);
    const pos = { x: -391, y: 18, z: 744 };

    expect(first.blockAt(pos)).toBe(second.blockAt(pos));
  });

  it('uses water below terrain surface and air above it', () => {
    const generator = createGenerator(42);
    const waterColumn = Array.from({ length: 32 }, (_, index) => ({
      x: index * 16,
      z: index * -16,
    })).find(({ x, z }) => generator.blockAt({ x, y: 24, z }) === 3);

    expect(waterColumn).toBeDefined();
    expect(generator.blockAt({ ...waterColumn!, y: 25 })).toBe(0);
  });
});
