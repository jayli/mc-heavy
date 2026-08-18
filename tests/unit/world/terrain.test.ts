import { describe, expect, it } from 'vitest';
import { hash2 } from '../../../src/world/features';
import { createGenerator, surfaceHeightAt } from '../../../src/world/terrain';

describe('deterministic terrain generator', () => {
  it('changes surface height by at most one block between adjacent columns', () => {
    for (const seed of [42, 0x5eed1234]) {
      for (let z = -48; z <= 48; z += 1) {
        for (let x = -48; x <= 48; x += 1) {
          expect(Math.abs(surfaceHeightAt(seed, x + 1, z) - surfaceHeightAt(seed, x, z))).toBeLessThanOrEqual(1);
          expect(Math.abs(surfaceHeightAt(seed, x, z + 1) - surfaceHeightAt(seed, x, z))).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('returns the same feature manifest irrespective of request order', () => {
    const generator = createGenerator(42);
    const first = generator.featuresForSupercell(0, 0);

    generator.featuresForSupercell(8, -3);

    expect(generator.featuresForSupercell(0, 0)).toEqual(first);
  });

  it('matches fixed hash, biome, surface, and sea-level fixtures', () => {
    const generator = createGenerator(42);
    const fixtures = [
      { x: 0, z: 0, biome: 'coast', y: 27, block: 4 },
      { x: 0, z: 64, biome: 'desert', y: 19, block: 4 },
      { x: 0, z: 128, biome: 'snow', y: 19, block: 1 },
      { x: 0, z: 512, biome: 'plains', y: 19, block: 2 },
    ] as const;

    expect(hash2(42, 0, 0)).toBe(0.09044192777946591);
    for (const fixture of fixtures) {
      expect(generator.biomeAt(fixture.x, fixture.z)).toBe(fixture.biome);
      expect(generator.blockAt({ x: fixture.x, y: fixture.y, z: fixture.z })).toBe(fixture.block);
    }
    expect(generator.blockAt({ x: 0, y: 20, z: 64 })).toBe(3);
    expect(generator.blockAt({ x: 0, y: 28, z: 0 })).toBe(0);
  });
});
