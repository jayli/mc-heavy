import type { BlockPos } from '../domain/coords';
import { compareFeaturesById, featuresForSupercell, hash2, supercellOf, type Feature } from './features';
import { materializeFeature } from './structure-template';

export type Biome = 'plains' | 'desert' | 'snow' | 'coast';

export type WorldGenerator = {
  blockAt(pos: BlockPos): number;
  biomeAt(x: number, z: number): Biome;
  featuresForSupercell(x: number, z: number): readonly Feature[];
};

const SEA_LEVEL = 24;

const biomeFor = (seed: number, x: number, z: number): Biome => {
  const noise = hash2(seed ^ 0x1b873593, Math.floor(x / 64), Math.floor(z / 64));
  if (noise < 0.15) return 'coast';
  if (noise < 0.35) return 'desert';
  if (noise < 0.5) return 'snow';
  return 'plains';
};

const surfaceHeightAt = (seed: number, x: number, z: number): number => (
  SEA_LEVEL - 8 + Math.floor(hash2(seed, x, z) * 17)
);

const terrainBlockAt = (seed: number, pos: BlockPos): number => {
  const surface = surfaceHeightAt(seed, pos.x, pos.z);
  if (pos.y > surface) return pos.y <= SEA_LEVEL ? 3 : 0;
  if (pos.y < surface) return 1;

  const biome = biomeFor(seed, pos.x, pos.z);
  if (biome === 'desert' || biome === 'coast') return 4;
  if (biome === 'snow') return 1;
  return 2;
};

const materializedBlockAt = (seed: number, pos: BlockPos): number => {
  let block = terrainBlockAt(seed, pos);
  const supercellX = supercellOf(pos.x);
  const supercellZ = supercellOf(pos.z);
  const features: Feature[] = [];

  for (let x = supercellX - 1; x <= supercellX + 1; x += 1) {
    for (let z = supercellZ - 1; z <= supercellZ + 1; z += 1) {
      features.push(...featuresForSupercell(seed, x, z));
    }
  }

  for (const feature of features.sort(compareFeaturesById)) {
    const structureBlock = materializeFeature(feature, pos);
    if (structureBlock !== null) block = structureBlock;
  }
  return block;
};

export const createGenerator = (seed: number): WorldGenerator => Object.freeze({
  blockAt: (pos) => materializedBlockAt(seed, pos),
  biomeAt: (x, z) => biomeFor(seed, x, z),
  featuresForSupercell: (x, z) => featuresForSupercell(seed, x, z),
});
