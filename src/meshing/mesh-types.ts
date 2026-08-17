import type { VoxelSection } from '../domain/voxel-section';

export type MeshingInput = Readonly<{
  section: VoxelSection;
  neighbors: readonly (VoxelSection | undefined)[];
  sourceVersion: number;
}>;

export type OpaqueMesh = Readonly<{
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  materialIds: Uint16Array;
  indices: Uint32Array;
  sourceVersion: number;
}>;
