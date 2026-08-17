import type { BlockPos } from '../domain/coords';

export const SUPERCELL_SIZE = 256;

export type Aabb = Readonly<{ min: BlockPos; max: BlockPos }>;

export type Feature = Readonly<{
  id: string;
  kind: 'house' | 'tower' | 'pyramid';
  bounds: Aabb;
  seed: number;
}>;

export const compareFeaturesById = (left: Feature, right: Feature): number => {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
};

const mix32 = (value: number): number => {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
};

/** Returns repeatable pseudo-noise in the half-open range [0, 1). */
export const hash2 = (seed: number, x: number, z: number): number => {
  const combined = (seed | 0) ^ Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(z | 0, 0x85ebca77);
  return mix32(combined) / 0x1_0000_0000;
};

export const supercellOf = (coordinate: number): number => Math.floor(coordinate / SUPERCELL_SIZE);

/**
 * Creates a small, stable manifest for one 256 by 256 world area.
 * The two structures deliberately share their footprint so layering can stay
 * deterministic: ids sort house before tower, making the tower topmost.
 */
export const featuresForSupercell = (seed: number, supercellX: number, supercellZ: number): readonly Feature[] => {
  const originX = supercellX * SUPERCELL_SIZE + 32 + Math.floor(hash2(seed, supercellX, supercellZ) * 176);
  const originZ = supercellZ * SUPERCELL_SIZE + 32 + Math.floor(hash2(seed ^ 0x51ed270b, supercellX, supercellZ) * 176);
  const baseY = 25 + Math.floor(hash2(seed ^ 0x68bc21eb, supercellX, supercellZ) * 8);
  const featureSeed = mix32((seed | 0) ^ Math.imul(supercellX | 0, 0x27d4eb2d) ^ Math.imul(supercellZ | 0, 0x165667b1));
  const features: Feature[] = [
    {
      id: `house:${supercellX}:${supercellZ}`,
      kind: 'house',
      seed: featureSeed,
      bounds: {
        min: { x: originX, y: baseY, z: originZ },
        max: { x: originX + 7, y: baseY + 5, z: originZ + 7 },
      },
    },
    {
      id: `tower:${supercellX}:${supercellZ}`,
      kind: 'tower',
      seed: mix32(featureSeed ^ 0xa5a5a5a5),
      bounds: {
        min: { x: originX + 3, y: baseY, z: originZ + 3 },
        max: { x: originX + 8, y: baseY + 11, z: originZ + 8 },
      },
    },
  ];

  if (hash2(seed ^ 0x3c6ef372, supercellX, supercellZ) < 0.5) {
    features.push({
      id: `pyramid:${supercellX}:${supercellZ}`,
      kind: 'pyramid',
      seed: mix32(featureSeed ^ 0x5a5a5a5a),
      bounds: {
        min: { x: originX + 24, y: baseY, z: originZ + 24 },
        max: { x: originX + 34, y: baseY + 5, z: originZ + 34 },
      },
    });
  }

  return Object.freeze(features.sort(compareFeaturesById));
};
