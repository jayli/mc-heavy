import type { BlockPos } from '../domain/coords';
import type { Feature } from './features';

export type { Aabb, Feature } from './features';

const contains = (feature: Feature, pos: BlockPos): boolean => (
  pos.x >= feature.bounds.min.x && pos.x <= feature.bounds.max.x
  && pos.y >= feature.bounds.min.y && pos.y <= feature.bounds.max.y
  && pos.z >= feature.bounds.min.z && pos.z <= feature.bounds.max.z
);

/** Returns a structure block only where a template owns the queried voxel. */
export const materializeFeature = (feature: Feature, pos: BlockPos): number | null => {
  if (!contains(feature, pos)) return null;

  if (feature.kind === 'tower') return 1;
  if (feature.kind === 'pyramid') return 4;
  return 5;
};
