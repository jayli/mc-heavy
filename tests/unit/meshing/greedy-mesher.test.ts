import { describe, expect, it } from 'vitest';
import { blockRegistry } from '../../../src/domain/blocks';
import { localIndex } from '../../../src/domain/coords';
import { VoxelSection } from '../../../src/domain/voxel-section';
import { meshOpaque } from '../../../src/meshing/greedy-mesher';
import type { MeshingInput, OpaqueMesh } from '../../../src/meshing/mesh-types';

const HALO_SLOT = {
  west: 0,
  east: 1,
  down: 2,
  up: 3,
  north: 4,
  south: 5,
} as const;

const registry = blockRegistry;

function sectionWith(
  cells: readonly Readonly<{ x: number; y: number; z: number; blockId: number }>[],
  pos = { x: 0, y: 0, z: 0 },
): VoxelSection {
  return cells.reduce(
    (section, cell) => section.set(localIndex(cell), cell.blockId),
    VoxelSection.filled(pos, 0),
  );
}

function meshingInput(
  section: VoxelSection,
  neighbors: readonly VoxelSection[] = [],
  sourceVersion = 73,
): MeshingInput {
  return { section, neighbors, sourceVersion };
}

function countQuadsWithNormal(mesh: OpaqueMesh, normal: readonly [number, number, number]): number {
  let count = 0;
  for (let indexOffset = 0; indexOffset < mesh.indices.length; indexOffset += 6) {
    const offset = mesh.indices[indexOffset] * 3;
    if (
      mesh.normals[offset] === normal[0] &&
      mesh.normals[offset + 1] === normal[1] &&
      mesh.normals[offset + 2] === normal[2]
    ) {
      count += 1;
    }
  }
  return count;
}

describe('meshOpaque', () => {
  it('emits six quads for one stone cube', () => {
    const mesh = meshOpaque(
      meshingInput(sectionWith([{ x: 0, y: 0, z: 0, blockId: 1 }])),
      registry,
    );

    expect(mesh.indices.length).toBe(36);
  });

  it('merges the exposed top of two adjacent stone cubes into one quad', () => {
    const mesh = meshOpaque(
      meshingInput(
        sectionWith([
          { x: 0, y: 0, z: 0, blockId: 1 },
          { x: 1, y: 0, z: 0, blockId: 1 },
        ]),
      ),
      registry,
    );

    expect(countQuadsWithNormal(mesh, [0, 1, 0])).toBe(1);
  });

  it('does not emit the east face when the east halo contains stone', () => {
    const center = sectionWith([{ x: 15, y: 0, z: 0, blockId: 1 }]);
    const eastHalo = sectionWith([{ x: 0, y: 0, z: 0, blockId: 1 }], { x: 1, y: 0, z: 0 });
    const neighbors: VoxelSection[] = [];
    neighbors[HALO_SLOT.east] = eastHalo;

    const mesh = meshOpaque(meshingInput(center, neighbors), registry);

    expect(countQuadsWithNormal(mesh, [1, 0, 0])).toBe(0);
  });

  it('does not merge stone and grass top faces into one quad', () => {
    const mesh = meshOpaque(
      meshingInput(
        sectionWith([
          { x: 0, y: 0, z: 0, blockId: 1 },
          { x: 1, y: 0, z: 0, blockId: 2 },
        ]),
      ),
      registry,
    );

    expect(countQuadsWithNormal(mesh, [0, 1, 0])).toBe(2);
  });

  it('keeps arrays self-consistent and forwards sourceVersion exactly', () => {
    const mesh = meshOpaque(
      meshingInput(sectionWith([{ x: 0, y: 0, z: 0, blockId: 1 }]), [], 121),
      registry,
    );
    const vertexCount = mesh.positions.length / 3;

    expect(mesh.positions.length % 3).toBe(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    expect(mesh.uvs.length).toBe(vertexCount * 2);
    expect(mesh.materialIds.length).toBe(vertexCount);
    expect(mesh.indices.length % 6).toBe(0);
    expect([...mesh.indices].every((index) => index < vertexCount)).toBe(true);
    expect(mesh.sourceVersion).toBe(121);
  });

  it('excludes non-opaque blocks from the mesh', () => {
    const mesh = meshOpaque(
      meshingInput(
        sectionWith([
          { x: 0, y: 0, z: 0, blockId: 3 },
          { x: 1, y: 0, z: 0, blockId: 7 },
        ]),
      ),
      registry,
    );

    expect(mesh.indices.length).toBe(0);
  });

  it('treats a halo at a non-adjacent position as air', () => {
    const center = sectionWith([{ x: 15, y: 0, z: 0, blockId: 1 }]);
    const misplacedHalo = sectionWith([{ x: 0, y: 0, z: 0, blockId: 1 }], { x: 2, y: 0, z: 0 });
    const neighbors: VoxelSection[] = [];
    neighbors[HALO_SLOT.east] = misplacedHalo;

    const mesh = meshOpaque(meshingInput(center, neighbors), registry);

    expect(countQuadsWithNormal(mesh, [1, 0, 0])).toBe(1);
  });
});
