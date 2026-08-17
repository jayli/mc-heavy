import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';

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
});
