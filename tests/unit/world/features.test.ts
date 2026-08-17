import { describe, expect, it } from 'vitest';
import { createGenerator } from '../../../src/world/terrain';
import { materializeFeature, type Feature } from '../../../src/world/structure-template';

describe('structure feature materialization', () => {
  it('materializes both sides of a house that crosses x=16 without duplicate ownership', () => {
    const feature = { id: 'house:0:0', kind: 'house', seed: 9, bounds: { min: { x: 14, y: 0, z: 0 }, max: { x: 17, y: 3, z: 3 } } } as const;

    expect(materializeFeature(feature, { x: 15, y: 0, z: 0 })).toBe(5);
    expect(materializeFeature(feature, { x: 16, y: 0, z: 0 })).toBe(5);
  });

  it('uses the feature with the later id when structures overlap', () => {
    const generator = createGenerator(0);
    const features = generator.featuresForSupercell(0, 0);
    const house = features.find((candidate) => candidate.id === 'house:0:0');
    const tower = features.find((candidate) => candidate.id === 'tower:0:0');

    expect(house).toBeDefined();
    expect(tower).toBeDefined();
    expect(materializeFeature(house!, tower!.bounds.min)).toBe(5);
    expect(materializeFeature(tower!, tower!.bounds.min)).toBe(1);
    expect(generator.blockAt(tower!.bounds.min)).toBe(1);
  });

  it('returns null outside a feature bounds', () => {
    const feature: Feature = {
      id: 'pyramid:0:0',
      kind: 'pyramid',
      seed: 1,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 4 } },
    };

    expect(materializeFeature(feature, { x: 5, y: 0, z: 0 })).toBeNull();
  });
});
