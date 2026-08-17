import type { BlockRegistry } from '../domain/blocks';
import { localIndex, SECTION_SIZE, type BlockPos } from '../domain/coords';
import type { VoxelSection } from '../domain/voxel-section';
import type { MeshingInput, OpaqueMesh } from './mesh-types';

const HALO_WEST = 0;
const HALO_EAST = 1;
const HALO_DOWN = 2;
const HALO_UP = 3;
const HALO_NORTH = 4;
const HALO_SOUTH = 5;

type Axis = 0 | 1 | 2;

type Face = Readonly<{
  blockId: number;
  normal: readonly [number, number, number];
  skyLight: number;
  blockLight: number;
  ao: number;
}>;

type MeshBuffers = {
  positions: number[];
  normals: number[];
  uvs: number[];
  materialIds: number[];
  indices: number[];
};

const axisCoordinate = (axis: Axis, value: number, otherA: number, otherB: number): BlockPos => {
  if (axis === 0) return { x: value, y: otherA, z: otherB };
  if (axis === 1) return { x: otherB, y: value, z: otherA };
  return { x: otherA, y: otherB, z: value };
};

function haloIndexFor(x: number, y: number, z: number): number | undefined {
  if (x === -1) return HALO_WEST;
  if (x === SECTION_SIZE) return HALO_EAST;
  if (y === -1) return HALO_DOWN;
  if (y === SECTION_SIZE) return HALO_UP;
  if (z === -1) return HALO_NORTH;
  if (z === SECTION_SIZE) return HALO_SOUTH;
  return undefined;
}

function expectedHaloPos(section: VoxelSection, haloIndex: number): BlockPos {
  const { x, y, z } = section.pos;
  switch (haloIndex) {
    case HALO_WEST:
      return { x: x - 1, y, z };
    case HALO_EAST:
      return { x: x + 1, y, z };
    case HALO_DOWN:
      return { x, y: y - 1, z };
    case HALO_UP:
      return { x, y: y + 1, z };
    case HALO_NORTH:
      return { x, y, z: z - 1 };
    default:
      return { x, y, z: z + 1 };
  }
}

function hasPosition(section: VoxelSection, expected: BlockPos): boolean {
  return section.pos.x === expected.x && section.pos.y === expected.y && section.pos.z === expected.z;
}

function sampleBlockId(input: MeshingInput, x: number, y: number, z: number): number {
  if (x >= 0 && x < SECTION_SIZE && y >= 0 && y < SECTION_SIZE && z >= 0 && z < SECTION_SIZE) {
    return input.section.get(localIndex({ x, y, z }));
  }

  const haloIndex = haloIndexFor(x, y, z);
  if (haloIndex === undefined) return 0;

  const halo = input.neighbors[haloIndex];
  if (!halo || !hasPosition(halo, expectedHaloPos(input.section, haloIndex))) return 0;

  const localX = x === -1 ? SECTION_SIZE - 1 : x === SECTION_SIZE ? 0 : x;
  const localY = y === -1 ? SECTION_SIZE - 1 : y === SECTION_SIZE ? 0 : y;
  const localZ = z === -1 ? SECTION_SIZE - 1 : z === SECTION_SIZE ? 0 : z;
  return halo.get(localIndex({ x: localX, y: localY, z: localZ }));
}

function isOpaque(blockId: number, blocks: BlockRegistry): boolean {
  return blocks.byId(blockId).renderClass === 'opaque';
}

function mergeable(first: Face | undefined, second: Face | undefined): boolean {
  return (
    first !== undefined &&
    second !== undefined &&
    first.blockId === second.blockId &&
    first.normal[0] === second.normal[0] &&
    first.normal[1] === second.normal[1] &&
    first.normal[2] === second.normal[2] &&
    first.skyLight === second.skyLight &&
    first.blockLight === second.blockLight &&
    first.ao === second.ao
  );
}

function addQuad(
  buffers: MeshBuffers,
  origin: readonly [number, number, number],
  du: readonly [number, number, number],
  dv: readonly [number, number, number],
  face: Face,
): void {
  const [x, y, z] = origin;
  const corners: readonly (readonly [number, number, number])[] = [
    [x, y, z],
    [x + du[0], y + du[1], z + du[2]],
    [x + du[0] + dv[0], y + du[1] + dv[1], z + du[2] + dv[2]],
    [x + dv[0], y + dv[1], z + dv[2]],
  ];
  const vertexBase = buffers.positions.length / 3;
  const normalIsPositive = face.normal[0] + face.normal[1] + face.normal[2] > 0;
  const vertexOrder = normalIsPositive ? [0, 1, 2, 3] : [0, 3, 2, 1];

  for (const cornerIndex of vertexOrder) {
    const corner = corners[cornerIndex];
    buffers.positions.push(corner[0], corner[1], corner[2]);
    buffers.normals.push(face.normal[0], face.normal[1], face.normal[2]);
    buffers.materialIds.push(face.blockId);
  }
  buffers.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  buffers.indices.push(vertexBase, vertexBase + 1, vertexBase + 2, vertexBase, vertexBase + 2, vertexBase + 3);
}

function meshAxis(input: MeshingInput, blocks: BlockRegistry, axis: Axis, buffers: MeshBuffers): void {
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;

  for (let slice = -1; slice < SECTION_SIZE; slice += 1) {
    const mask: (Face | undefined)[] = new Array(SECTION_SIZE * SECTION_SIZE);
    for (let j = 0; j < SECTION_SIZE; j += 1) {
      for (let i = 0; i < SECTION_SIZE; i += 1) {
        const a = axisCoordinate(axis, slice, i, j);
        const b = axisCoordinate(axis, slice + 1, i, j);
        const aBlockId = sampleBlockId(input, a.x, a.y, a.z);
        const bBlockId = sampleBlockId(input, b.x, b.y, b.z);
        const aOpaque = isOpaque(aBlockId, blocks);
        const bOpaque = isOpaque(bBlockId, blocks);
        if (aOpaque === bOpaque) continue;

        const blockId = aOpaque ? aBlockId : bBlockId;
        const normalComponent = aOpaque ? 1 : -1;
        const normal: [number, number, number] = [0, 0, 0];
        normal[axis] = normalComponent;
        mask[i + j * SECTION_SIZE] = {
          blockId,
          normal,
          skyLight: 0,
          blockLight: 0,
          ao: 0,
        };
      }
    }

    for (let j = 0; j < SECTION_SIZE; j += 1) {
      for (let i = 0; i < SECTION_SIZE; i += 1) {
        const maskIndex = i + j * SECTION_SIZE;
        const face = mask[maskIndex];
        if (!face) continue;

        let width = 1;
        while (i + width < SECTION_SIZE && mergeable(face, mask[maskIndex + width])) width += 1;

        let height = 1;
        while (j + height < SECTION_SIZE) {
          let rowMatches = true;
          for (let offset = 0; offset < width; offset += 1) {
            if (!mergeable(face, mask[maskIndex + offset + height * SECTION_SIZE])) {
              rowMatches = false;
              break;
            }
          }
          if (!rowMatches) break;
          height += 1;
        }

        const origin = axisCoordinate(axis, slice + 1, i, j);
        const du: [number, number, number] = [0, 0, 0];
        const dv: [number, number, number] = [0, 0, 0];
        du[u] = width;
        dv[v] = height;
        addQuad(buffers, [origin.x, origin.y, origin.z], du, dv, face);

        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            mask[maskIndex + column + row * SECTION_SIZE] = undefined;
          }
        }
      }
    }
  }
}

export function meshOpaque(input: MeshingInput, blocks: BlockRegistry): OpaqueMesh {
  const buffers: MeshBuffers = { positions: [], normals: [], uvs: [], materialIds: [], indices: [] };
  meshAxis(input, blocks, 0, buffers);
  meshAxis(input, blocks, 1, buffers);
  meshAxis(input, blocks, 2, buffers);

  return {
    positions: new Float32Array(buffers.positions),
    normals: new Int8Array(buffers.normals),
    uvs: new Float32Array(buffers.uvs),
    materialIds: new Uint16Array(buffers.materialIds),
    indices: new Uint32Array(buffers.indices),
    sourceVersion: input.sourceVersion,
  };
}
