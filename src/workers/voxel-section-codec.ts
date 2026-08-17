import { VoxelSection } from '../domain/voxel-section';
import type { SerializedVoxelSection } from './protocol';

export function serializeVoxelSection(section: VoxelSection): SerializedVoxelSection {
  const { palette, indices } = section.toPaletteIndices();
  const indicesBuffer = new ArrayBuffer(indices.byteLength);
  new Uint16Array(indicesBuffer).set(indices);
  return {
    pos: section.pos,
    palette,
    indices: indicesBuffer,
    editVersion: section.editVersion,
  };
}

export function deserializeVoxelSection(serialized: SerializedVoxelSection): VoxelSection {
  return VoxelSection.fromPaletteIndices(
    serialized.pos,
    serialized.palette,
    new Uint16Array(serialized.indices),
    serialized.editVersion,
  );
}
