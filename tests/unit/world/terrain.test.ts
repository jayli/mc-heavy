import { describe, expect, it } from 'vitest';
import { hash2 } from '../../../src/world/features';
import { createGenerator } from '../../../src/world/terrain';

describe('deterministic terrain generator', () => {
  it('returns the same feature manifest irrespective of request order', () => {
    const generator = createGenerator(42);
    const first = generator.featuresForSupercell(0, 0);

    generator.featuresForSupercell(8, -3);

    expect(generator.featuresForSupercell(0, 0)).toEqual(first);
  });

  it('matches fixed hash, biome, surface, and sea-level fixtures', () => {
    const generator = createGenerator(42);
    const fixtures = [
      { x: 0, z: 0, biome: 'coast', y: 17, block: 4 },
      { x: 0, z: 64, biome: 'desert', y: 28, block: 4 },
      { x: 0, z: 128, biome: 'snow', y: 21, block: 1 },
      { x: 0, z: 512, biome: 'plains', y: 16, block: 2 },
    ] as const;

    expect(hash2(42, 0, 0)).toBe(0.09044192777946591);
    for (const fixture of fixtures) {
      expect(generator.biomeAt(fixture.x, fixture.z)).toBe(fixture.biome);
      expect(generator.blockAt({ x: fixture.x, y: fixture.y, z: fixture.z })).toBe(fixture.block);
    }
    expect(generator.blockAt({ x: 0, y: 18, z: 0 })).toBe(3);
    expect(generator.blockAt({ x: 0, y: 25, z: 0 })).toBe(0);
  });
});
