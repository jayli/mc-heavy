import { VoxelSection } from '../domain/voxel-section';
import type { SerializedVoxelSection } from './protocol';

export function serializeVoxelSection(section: VoxelSection): SerializedVoxelSection {
  const { palette, indices, orientations } = section.toPaletteIndices();
  const indicesBuffer = new ArrayBuffer(indices.byteLength);
  new Uint16Array(indicesBuffer).set(indices);
  const orientationsBuffer = new ArrayBuffer(orientations.byteLength);
  new Uint8Array(orientationsBuffer).set(orientations);
  return {
    pos: section.pos,
    palette,
    indices: indicesBuffer,
    orientations: orientationsBuffer,
    editVersion: section.editVersion,
  };
}

export function deserializeVoxelSection(serialized: SerializedVoxelSection): VoxelSection {
  return VoxelSection.fromPaletteIndices(
    serialized.pos,
    serialized.palette,
    new Uint16Array(serialized.indices),
    serialized.editVersion,
    serialized.orientations === undefined ? undefined : new Uint8Array(serialized.orientations),
  );
}
