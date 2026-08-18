import type { VoxelSection } from '../domain/voxel-section';

export type MeshingInput = Readonly<{
  section: VoxelSection;
  neighbors: readonly (VoxelSection | undefined)[];
  sourceVersion: number;
  orientations?: (localIndex: number) => number;
}>;

export type MeshChannel = 'opaque' | 'cutout' | 'translucent';

export const MESH_CHANNELS: readonly MeshChannel[] = Object.freeze(['opaque', 'cutout', 'translucent']);

export type ChannelMesh = Readonly<{
  positions: Float32Array;
  normals: Int8Array;
  uvs: Float32Array;
  tileIds: Uint16Array;
  ao: Uint8Array;
  indices: Uint32Array;
  sourceVersion: number;
}>;

export type SectionMesh = Readonly<{
  opaque: ChannelMesh;
  cutout: ChannelMesh;
  translucent: ChannelMesh;
  sourceVersion: number;
}>;

export function emptyChannelMesh(sourceVersion = 0): ChannelMesh {
  return Object.freeze({
    positions: new Float32Array(0),
    normals: new Int8Array(0),
    uvs: new Float32Array(0),
    tileIds: new Uint16Array(0),
    ao: new Uint8Array(0),
    indices: new Uint32Array(0),
    sourceVersion,
  });
}

export function emptySectionMesh(sourceVersion: number): SectionMesh {
  return Object.freeze({
    opaque: emptyChannelMesh(sourceVersion),
    cutout: emptyChannelMesh(sourceVersion),
    translucent: emptyChannelMesh(sourceVersion),
    sourceVersion,
  });
}

export const channelOf = (channel: MeshChannel): keyof Pick<SectionMesh, 'opaque' | 'cutout' | 'translucent'> => channel;
