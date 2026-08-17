import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';
import { createGenerator } from '../../../src/world/terrain';
import { handleGenerationRequest, handleMeshingRequest } from '../../../src/workers/work-handlers';
import { deserializeVoxelSection, serializeVoxelSection } from '../../../src/workers/voxel-section-codec';

describe('worker protocol handlers', () => {
  it('generates every cell of the requested section with the deterministic generator', () => {
    const result = handleGenerationRequest({
      kind: 'generate',
      key: '-1,1,2',
      epoch: 4,
      editVersion: 3,
      seed: 123,
    });
    const section = deserializeVoxelSection(result.section);
    const generator = createGenerator(123);

    expect(result).toMatchObject({ kind: 'generated', key: '-1,1,2', epoch: 4, editVersion: 3 });
    expect(section.editVersion).toBe(3);
    expect(section.get(0)).toBe(generator.blockAt({ x: -16, y: 16, z: 32 }));
    expect(section.get(4095)).toBe(generator.blockAt({ x: -1, y: 31, z: 47 }));
    expect(result.section.palette.buffer).toBeInstanceOf(ArrayBuffer);
    expect(result.section.indices).toBeInstanceOf(ArrayBuffer);
  });

  it('meshes the serialized section and halo with transferable typed arrays', () => {
    const section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);
    const west = VoxelSection.filled({ x: -1, y: 0, z: 0 }, 1);
    const result = handleMeshingRequest({
      kind: 'mesh',
      key: '0,0,0',
      epoch: 2,
      editVersion: 0,
      section: serializeVoxelSection(section),
      neighbors: [serializeVoxelSection(west)],
    });

    expect(result).toMatchObject({ kind: 'meshed', key: '0,0,0', epoch: 2, editVersion: 0 });
    expect(result.mesh.sourceVersion).toBe(0);
    expect(result.mesh.positions).toBeInstanceOf(Float32Array);
    expect(result.mesh.indices).toBeInstanceOf(Uint32Array);
    expect(result.mesh.positions.buffer).toBeInstanceOf(ArrayBuffer);
    expect(result.mesh.indices.length).toBeGreaterThan(0);
  });
});
