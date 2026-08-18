import { describe, expect, it } from 'vitest';
import { blockByKey, blockRegistry } from '../../../src/domain/blocks';
import { localIndex } from '../../../src/domain/coords';
import { textureTileId } from '../../../src/domain/texture-tiles';
import { VoxelSection } from '../../../src/domain/voxel-section';
import { meshOpaque, meshSection } from '../../../src/meshing/greedy-mesher';
import { flattenSectionMesh } from '../../../src/meshing/mesh-types';
import type { ChannelMesh, MeshingInput } from '../../../src/meshing/mesh-types';

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

function countQuadsWithNormal(mesh: ChannelMesh, normal: readonly [number, number, number]): number {
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
    expect(mesh.tileIds.length).toBe(vertexCount);
    expect(mesh.ao.length).toBe(vertexCount);
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

function someTileOnFace(
  mesh: { positions: Float32Array; normals: Int8Array; tileIds: Uint16Array; indices: Uint32Array },
  normal: readonly [number, number, number],
  tileId: number,
): boolean {
  for (let offset = 0; offset < mesh.indices.length; offset += 6) {
    const vertex = mesh.indices[offset] * 3;
    if (
      mesh.normals[vertex] === normal[0]
      && mesh.normals[vertex + 1] === normal[1]
      && mesh.normals[vertex + 2] === normal[2]
      && mesh.tileIds[mesh.indices[offset]] === tileId
    ) {
      return true;
    }
  }
  return false;
}

describe('meshSection channels', () => {
  it('puts full cubes, cutout cubes and translucent cubes into separate channels', () => {
    const section = sectionWith([
      { x: 0, y: 0, z: 0, blockId: blockByKey('stone').id },
      { x: 0, y: 1, z: 0, blockId: blockByKey('leaves').id },
      { x: 0, y: 2, z: 0, blockId: blockByKey('water').id },
    ]);

    const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);

    expect(mesh.opaque.indices.length).toBeGreaterThan(0);
    expect(mesh.cutout.indices.length).toBeGreaterThan(0);
    expect(mesh.translucent.indices.length).toBeGreaterThan(0);
    expect(mesh.opaque.ao.every((value) => value >= 0 && value <= 3)).toBe(true);
    expect(mesh.sourceVersion).toBe(1);
  });

  it('emits both faces between two adjacent cutout cubes', () => {
    const leaves = blockByKey('leaves').id;
    const section = sectionWith([
      { x: 0, y: 0, z: 0, blockId: leaves },
      { x: 1, y: 0, z: 0, blockId: leaves },
    ]);

    const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);

    expect(countQuadsWithNormal(mesh.cutout, [1, 0, 0])).toBeGreaterThanOrEqual(1);
    expect(countQuadsWithNormal(mesh.cutout, [-1, 0, 0])).toBeGreaterThanOrEqual(1);
  });

  it('emits a two-quad cross for a non-solid plant', () => {
    const flower = blockByKey('short_grass').id;
    const section = sectionWith([{ x: 3, y: 3, z: 3, blockId: flower }]);

    const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);

    expect(mesh.cutout.indices.length).toBe(12);
  });

  it('rotates a front-textured cube by its orientation', () => {
    const chest = blockByKey('chest').id;
    const section = sectionWith([{ x: 2, y: 2, z: 2, blockId: chest }]);
    const input = { section, neighbors: [], sourceVersion: 1, orientations: () => 2 };

    const mesh = meshSection(input, blockRegistry);

    expect(someTileOnFace(mesh.cutout, [-1, 0, 0], textureTileId('box_face.png'))).toBe(true);
  });

  it('shades an enclosed opaque face corner with AO zero', () => {
    const stone = blockByKey('stone').id;
    const grass = blockByKey('grass').id;
    const section = sectionWith([
      { x: 1, y: 1, z: 1, blockId: stone },
      { x: 0, y: 1, z: 1, blockId: grass },
      { x: 1, y: 1, z: 0, blockId: grass },
      { x: 0, y: 1, z: 0, blockId: grass },
    ]);

    const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);

    for (let offset = 0; offset < mesh.opaque.indices.length; offset += 6) {
      const vertexIndex = mesh.opaque.indices[offset];
      const position = vertexIndex * 3;
      const isTopCorner = mesh.opaque.positions[position] === 1
        && mesh.opaque.positions[position + 1] === 2
        && mesh.opaque.positions[position + 2] === 1;
      if (!isTopCorner) continue;
      expect(mesh.opaque.normals[position + 1]).toBe(1);
      expect(mesh.opaque.ao[vertexIndex]).toBe(0);
      return;
    }
    throw new Error('enclosed top corner was not emitted');
  });

  it('flattens three channels into one channel without index overlap', () => {
    const stone = blockByKey('stone').id;
    const leaves = blockByKey('leaves').id;
    const water = blockByKey('water').id;
    const section = sectionWith([
      { x: 0, y: 0, z: 0, blockId: stone },
      { x: 0, y: 1, z: 0, blockId: leaves },
      { x: 0, y: 2, z: 0, blockId: water },
    ]);

    const mesh = meshSection({ section, neighbors: [], sourceVersion: 7 }, blockRegistry);
    const flat = flattenSectionMesh(mesh);

    expect(flat.positions.length).toBe(
      mesh.opaque.positions.length + mesh.cutout.positions.length + mesh.translucent.positions.length,
    );
    expect(flat.indices.length).toBe(
      mesh.opaque.indices.length + mesh.cutout.indices.length + mesh.translucent.indices.length,
    );
    for (const index of flat.indices) expect(index).toBeLessThan(flat.positions.length / 3);
    expect(flat.sourceVersion).toBe(7);
  });
});
