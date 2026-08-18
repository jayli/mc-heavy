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

/** 临时把三通道拼成单一 ChannelMesh，供单材质渲染路径使用；Task 7 后不再使用。 */
export function flattenSectionMesh(mesh: SectionMesh): ChannelMesh {
  const channels = MESH_CHANNELS.map((channel) => mesh[channel]);
  const vertexCount = channels.reduce((count, channel) => count + channel.positions.length / 3, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Int8Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const tileIds = new Uint16Array(vertexCount);
  const ao = new Uint8Array(vertexCount);
  const indices = new Uint32Array(channels.reduce((count, channel) => count + channel.indices.length, 0));

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const channel of channels) {
    positions.set(channel.positions, vertexOffset * 3);
    normals.set(channel.normals, vertexOffset * 3);
    uvs.set(channel.uvs, vertexOffset * 2);
    tileIds.set(channel.tileIds, vertexOffset);
    ao.set(channel.ao, vertexOffset);
    for (const index of channel.indices) {
      indices[indexOffset] = index + vertexOffset;
      indexOffset += 1;
    }
    vertexOffset += channel.positions.length / 3;
  }

  return Object.freeze({
    positions,
    normals,
    uvs,
    tileIds,
    ao,
    indices,
    sourceVersion: mesh.sourceVersion,
  });
}
