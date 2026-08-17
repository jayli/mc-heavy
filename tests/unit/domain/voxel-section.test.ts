import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';
import { deserializeVoxelSection, serializeVoxelSection } from '../../../src/workers/voxel-section-codec';

describe('VoxelSection', () => {
  it('increments the version once and preserves the previous section after an edit', () => {
    const before = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);
    const after = before.set(0, 3);

    expect(before.get(0)).toBe(1);
    expect(after.get(0)).toBe(3);
    expect(after.editVersion).toBe(1);
  });

  it('does not create a new version when setting a cell to its current block id', () => {
    const section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);

    expect(section.set(12, 1)).toBe(section);
  });

  it('expands the palette while preserving the old section and other cells', () => {
    const before = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1);
    const after = before.set(12, 3);

    expect(after.get(12)).toBe(3);
    expect(before.get(12)).toBe(1);
    expect(before.get(13)).toBe(1);
    expect(after.get(13)).toBe(1);
    expect(after.editVersion).toBe(1);
  });

  it('round-trips palette and index arrays through the worker wire codec', () => {
    const indices = new Uint16Array(16 * 16 * 16);
    indices[17] = 1;
    const section = VoxelSection.fromPaletteIndices(
      { x: -2, y: 3, z: 4 },
      new Uint16Array([1, 4]),
      indices,
      7,
    );

    const wire = serializeVoxelSection(section);
    const decoded = deserializeVoxelSection(wire);

    expect(wire.palette).toBeInstanceOf(Uint16Array);
    expect(wire.indices).toBeInstanceOf(ArrayBuffer);
    expect(decoded.pos).toEqual({ x: -2, y: 3, z: 4 });
    expect(decoded.get(17)).toBe(4);
    expect(decoded.get(18)).toBe(1);
    expect(decoded.editVersion).toBe(7);
  });
});
