import type { BlockDefinition, BlockRegistry, FaceIndex } from '../domain/blocks';
import { localIndex, SECTION_SIZE, type BlockPos } from '../domain/coords';
import type { VoxelSection } from '../domain/voxel-section';
import { computeCornerAo } from './ao';
import type {
  ChannelMesh,
  MeshChannel,
  MeshingInput,
  SectionMesh,
} from './mesh-types';

const HALO_WEST = 0;
const HALO_EAST = 1;
const HALO_DOWN = 2;
const HALO_UP = 3;
const HALO_NORTH = 4;
const HALO_SOUTH = 5;

type Axis = 0 | 1 | 2;
type Tuple3 = readonly [number, number, number];
type Tuple4 = readonly [number, number, number, number];

type Face = Readonly<{
  tileId: number;
  normal: Tuple3;
  ao: Tuple4;
}>;

type MeshBuffers = {
  positions: number[];
  normals: number[];
  uvs: number[];
  tileIds: number[];
  ao: number[];
  indices: number[];
};

const channelOf = (definition: BlockDefinition): MeshChannel | null => {
  if (definition.renderClass === 'opaque') return 'opaque';
  if (definition.renderClass === 'cutout') return 'cutout';
  if (definition.renderClass === 'translucent') return 'translucent';
  return null;
};

const axisCoordinate = (axis: Axis, value: number, otherA: number, otherB: number): BlockPos => {
  if (axis === 0) return { x: value, y: otherA, z: otherB };
  if (axis === 1) return { x: otherB, y: value, z: otherA };
  return { x: otherA, y: otherB, z: value };
};

const faceForAxis = (axis: Axis, towardPositive: boolean): FaceIndex => {
  if (axis === 0) return towardPositive ? 0 : 1;
  if (axis === 1) return towardPositive ? 2 : 3;
  return towardPositive ? 4 : 5;
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

function occludes(input: MeshingInput, blocks: BlockRegistry, pos: BlockPos): boolean {
  return blocks.isFullOccluder(sampleBlockId(input, pos.x, pos.y, pos.z));
}

function aoForFace(
  input: MeshingInput,
  blocks: BlockRegistry,
  cell: BlockPos,
  u: Axis,
  v: Axis,
): Tuple4 {
  const atAxis = (axis: Axis, offset: number): boolean => occludes(input, blocks, {
    x: cell.x + (axis === 0 ? offset : 0),
    y: cell.y + (axis === 1 ? offset : 0),
    z: cell.z + (axis === 2 ? offset : 0),
  });
  const atCorner = (du: number, dv: number): boolean => occludes(input, blocks, {
    x: cell.x + (u === 0 ? du : 0) + (v === 0 ? dv : 0),
    y: cell.y + (u === 1 ? du : 0) + (v === 1 ? dv : 0),
    z: cell.z + (u === 2 ? du : 0) + (v === 2 ? dv : 0),
  });
  return [
    computeCornerAo(atAxis(u, -1), atAxis(v, -1), atCorner(-1, -1)),
    computeCornerAo(atAxis(u, 1), atAxis(v, -1), atCorner(1, -1)),
    computeCornerAo(atAxis(u, 1), atAxis(v, 1), atCorner(1, 1)),
    computeCornerAo(atAxis(u, -1), atAxis(v, 1), atCorner(-1, 1)),
  ];
}

function mergeable(first: Face | undefined, second: Face | undefined): boolean {
  return (
    first !== undefined
    && second !== undefined
    && first.tileId === second.tileId
    && first.normal[0] === second.normal[0]
    && first.normal[1] === second.normal[1]
    && first.normal[2] === second.normal[2]
  );
}

function addQuad(
  buffers: MeshBuffers,
  origin: Tuple3,
  du: Tuple3,
  dv: Tuple3,
  face: Face,
  uvOrigin: readonly [number, number] = [0, 0],
  uvSize: readonly [number, number] = [1, 1],
): void {
  const [x, y, z] = origin;
  const corners: readonly Tuple3[] = [
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
    buffers.tileIds.push(face.tileId);
    buffers.ao.push(face.ao[cornerIndex]);
  }
  buffers.uvs.push(
    uvOrigin[0], uvOrigin[1],
    uvOrigin[0] + uvSize[0], uvOrigin[1],
    uvOrigin[0] + uvSize[0], uvOrigin[1] + uvSize[1],
    uvOrigin[0], uvOrigin[1] + uvSize[1],
  );
  buffers.indices.push(
    vertexBase,
    vertexBase + 1,
    vertexBase + 2,
    vertexBase,
    vertexBase + 2,
    vertexBase + 3,
  );
}

function emitQuad(
  buffers: MeshBuffers,
  corners: Tuple3[],
  normal: Tuple3,
  tileId: number,
  ao = 3,
): void {
  const crossX = (corners[1][1] - corners[0][1]) * (corners[3][2] - corners[0][2])
    - (corners[1][2] - corners[0][2]) * (corners[3][1] - corners[0][1]);
  const crossY = (corners[1][2] - corners[0][2]) * (corners[3][0] - corners[0][0])
    - (corners[1][0] - corners[0][0]) * (corners[3][2] - corners[0][2]);
  const crossZ = (corners[1][0] - corners[0][0]) * (corners[3][1] - corners[0][1])
    - (corners[1][1] - corners[0][1]) * (corners[3][0] - corners[0][0]);
  const aligned = crossX * normal[0] + crossY * normal[1] + crossZ * normal[2] >= 0;
  const ordered = aligned ? corners : [corners[0], corners[3], corners[2], corners[1]];

  const vertexBase = buffers.positions.length / 3;
  for (const corner of ordered) {
    buffers.positions.push(corner[0], corner[1], corner[2]);
    buffers.normals.push(normal[0], normal[1], normal[2]);
    buffers.tileIds.push(tileId);
    buffers.ao.push(ao);
  }
  buffers.uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
  buffers.indices.push(
    vertexBase,
    vertexBase + 1,
    vertexBase + 2,
    vertexBase,
    vertexBase + 2,
    vertexBase + 3,
  );
}

function meshCubeChannel(
  input: MeshingInput,
  blocks: BlockRegistry,
  channel: MeshChannel,
  orientationAt: (localIndex: number) => number,
  buffers: MeshBuffers,
): void {
  for (let axis = 0; axis <= 2; axis += 1) {
    const currentAxis = axis as Axis;
    const u = ((currentAxis + 1) % 3) as Axis;
    const v = ((currentAxis + 2) % 3) as Axis;
    const bakeAo = channel === 'opaque';

    for (let slice = -1; slice < SECTION_SIZE; slice += 1) {
      const forwardMask: (Face | undefined)[] = new Array(SECTION_SIZE * SECTION_SIZE);
      const backwardMask: (Face | undefined)[] = new Array(SECTION_SIZE * SECTION_SIZE);
      for (let j = 0; j < SECTION_SIZE; j += 1) {
        for (let i = 0; i < SECTION_SIZE; i += 1) {
          const aPos = axisCoordinate(currentAxis, slice, i, j);
          const bPos = axisCoordinate(currentAxis, slice + 1, i, j);
          const aBlock = sampleBlockId(input, aPos.x, aPos.y, aPos.z);
          const bBlock = sampleBlockId(input, bPos.x, bPos.y, bPos.z);
          const aDefinition = blocks.byId(aBlock);
          const bDefinition = blocks.byId(bBlock);
          const aOccludes = blocks.isFullOccluder(aBlock);
          const bOccludes = blocks.isFullOccluder(bBlock);

          const maskIndex = i + j * SECTION_SIZE;
          if (aDefinition.geometryType === 'cube' && channelOf(aDefinition) === channel && !bOccludes) {
            const localCell = aPos.x >= 0 && aPos.x < SECTION_SIZE
              && aPos.y >= 0 && aPos.y < SECTION_SIZE
              && aPos.z >= 0 && aPos.z < SECTION_SIZE;
            const orientation = localCell ? orientationAt(localIndex(aPos)) : 0;
            forwardMask[maskIndex] = {
              tileId: blocks.tileForFace(aBlock, faceForAxis(currentAxis, true), orientation),
              normal: axisNormal(currentAxis, true),
              ao: bakeAo ? aoForFace(input, blocks, aPos, u, v) : [3, 3, 3, 3],
            };
          }
          if (bDefinition.geometryType === 'cube' && channelOf(bDefinition) === channel && !aOccludes) {
            const localCell = bPos.x >= 0 && bPos.x < SECTION_SIZE
              && bPos.y >= 0 && bPos.y < SECTION_SIZE
              && bPos.z >= 0 && bPos.z < SECTION_SIZE;
            const orientation = localCell ? orientationAt(localIndex(bPos)) : 0;
            backwardMask[maskIndex] = {
              tileId: blocks.tileForFace(bBlock, faceForAxis(currentAxis, false), orientation),
              normal: axisNormal(currentAxis, false),
              ao: bakeAo ? aoForFace(input, blocks, bPos, u, v) : [3, 3, 3, 3],
            };
          }
        }
      }

      greedyMerge(buffers, forwardMask, currentAxis, slice + 1, u, v);
      greedyMerge(buffers, backwardMask, currentAxis, slice + 1, u, v);
    }
  }
}

const axisNormal = (axis: Axis, positive: boolean): Tuple3 => {
  if (axis === 0) return [positive ? 1 : -1, 0, 0];
  if (axis === 1) return [0, positive ? 1 : -1, 0];
  return [0, 0, positive ? 1 : -1];
};

function greedyMerge(
  buffers: MeshBuffers,
  mask: (Face | undefined)[],
  axis: Axis,
  plane: number,
  u: Axis,
  v: Axis,
): void {
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

      const origin = axisCoordinate(axis, plane, i, j);
      const du: [number, number, number] = [0, 0, 0];
      const dv: [number, number, number] = [0, 0, 0];
      du[u] = width;
      dv[v] = height;
      const mergedFace: Face = {
        tileId: face.tileId,
        normal: face.normal,
        ao: [
          face.ao[0],
          mask[maskIndex + width - 1]!.ao[1],
          mask[maskIndex + width - 1 + (height - 1) * SECTION_SIZE]!.ao[2],
          mask[maskIndex + (height - 1) * SECTION_SIZE]!.ao[3],
        ],
      };
      addQuad(buffers, [origin.x, origin.y, origin.z], du, dv, mergedFace, [i, j], [width, height]);

      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          mask[maskIndex + column + row * SECTION_SIZE] = undefined;
        }
      }
    }
  }
}

type ShapeEmitter = (
  buffers: MeshBuffers,
  input: MeshingInput,
  blocks: BlockRegistry,
  cell: BlockPos,
  definition: BlockDefinition,
  orientation: number,
) => void;

function tileFor(blocks: BlockRegistry, definition: BlockDefinition, face: FaceIndex, orientation: number): number {
  return blocks.tileForFace(definition.id, face, orientation);
}

function occluderBeside(input: MeshingInput, blocks: BlockRegistry, cell: BlockPos, normal: Tuple3): boolean {
  return occludes(input, blocks, {
    x: cell.x + normal[0],
    y: cell.y + normal[1],
    z: cell.z + normal[2],
  });
}

function emitBox(
  buffers: MeshBuffers,
  min: Tuple3,
  max: Tuple3,
  tiles: Record<'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz', number>,
): void {
  const faces: readonly [keyof typeof tiles, Tuple3, Tuple3[]][] = [
    ['px', [1, 0, 0], [[max[0], min[1], min[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]]]],
    ['nx', [-1, 0, 0], [[min[0], min[1], max[2]], [min[0], min[1], min[2]], [min[0], max[1], min[2]], [min[0], max[1], max[2]]]],
    ['py', [0, 1, 0], [[min[0], max[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]]],
    ['ny', [0, -1, 0], [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]]]],
    ['pz', [0, 0, 1], [[max[0], min[1], max[2]], [min[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]]]],
    ['nz', [0, 0, -1], [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]]],
  ];
  for (const [key, normal, corners] of faces) {
    emitQuad(buffers, corners, normal, tiles[key]);
  }
}

const shapeEmitters: Readonly<Record<string, ShapeEmitter>> = {
  cross(buffers, _input, blocks, cell, definition, orientation) {
    const x = cell.x;
    const y = cell.y;
    const z = cell.z;
    const tile = tileFor(blocks, definition, 2, orientation);
    emitQuad(buffers, [
      [x + 0.15, y, z + 0.5],
      [x + 0.85, y, z + 0.5],
      [x + 0.85, y + 1, z + 0.5],
      [x + 0.15, y + 1, z + 0.5],
    ], [1, 0, 0], tile);
    emitQuad(buffers, [
      [x + 0.5, y, z + 0.15],
      [x + 0.5, y, z + 0.85],
      [x + 0.5, y + 1, z + 0.85],
      [x + 0.5, y + 1, z + 0.15],
    ], [0, 0, 1], tile);
  },
  slab(buffers, input, blocks, cell, definition, orientation) {
    slabBox(buffers, input, blocks, cell, definition, orientation, 0, 0.5);
  },
  slab_top(buffers, input, blocks, cell, definition, orientation) {
    slabBox(buffers, input, blocks, cell, definition, orientation, 0.5, 1);
  },
  half_block(buffers, input, blocks, cell, definition, orientation) {
    slabBox(buffers, input, blocks, cell, definition, orientation, 0, 0.5);
  },
  pillar_vertical(buffers, input, blocks, cell, definition, orientation) {
    boxShape(buffers, input, blocks, cell, definition, orientation, 0.375, 0, 0.375, 0.625, 1, 0.625);
  },
  pillar_horizontal(buffers, input, blocks, cell, definition, orientation) {
    const axis = orientation % 2 === 0 ? 'x' : 'z';
    boxShape(buffers, input, blocks, cell, definition, orientation,
      axis === 'x' ? 0 : 0.375, 0.375, axis === 'x' ? 0.375 : 0,
      axis === 'x' ? 1 : 0.625, 0.625, axis === 'x' ? 0.625 : 1);
  },
  handrail(buffers, input, blocks, cell, definition, orientation) {
    railBox(buffers, input, blocks, cell, definition, orientation, 0.72, 0.88, 0.12);
  },
  handrail_a(buffers, input, blocks, cell, definition, orientation) {
    railBox(buffers, input, blocks, cell, definition, orientation, 0.72, 0.88, 0.12);
  },
  handrail_b(buffers, input, blocks, cell, definition, orientation) {
    railBox(buffers, input, blocks, cell, definition, orientation, 0.72, 0.88, 0.12);
  },
  chimney(buffers, input, blocks, cell, definition, orientation) {
    const x = cell.x;
    const z = cell.z;
    const y = cell.y;
    const walls: readonly [Tuple3, Tuple3][] = [
      [[x + 0.05, y, z + 0.05], [x + 0.95, y + 1, z + 0.15]],
      [[x + 0.05, y, z + 0.85], [x + 0.95, y + 1, z + 0.95]],
      [[x + 0.05, y, z + 0.05], [x + 0.15, y + 1, z + 0.95]],
      [[x + 0.85, y, z + 0.05], [x + 0.95, y + 1, z + 0.95]],
    ];
    for (const [min, max] of walls) {
      emitBox(buffers, min, max, allTiles(blocks, definition, orientation));
    }
  },
  lamp(buffers, input, blocks, cell, definition, orientation) {
    boxShape(buffers, input, blocks, cell, definition, orientation, 0.25, 0.65, 0.25, 0.75, 0.92, 0.75);
  },
  vine(buffers, _input, blocks, cell, definition, orientation) {
    const tile = tileFor(blocks, definition, 0, orientation);
    emitQuad(buffers, [
      [cell.x + 0.05, cell.y, cell.z + 0.05],
      [cell.x + 0.05, cell.y, cell.z + 0.95],
      [cell.x + 0.05, cell.y + 1, cell.z + 0.95],
      [cell.x + 0.05, cell.y + 1, cell.z + 0.05],
    ], [1, 0, 0], tile);
  },
  lilypad(buffers, _input, blocks, cell, definition, orientation) {
    const tile = tileFor(blocks, definition, 2, orientation);
    emitQuad(buffers, [
      [cell.x, cell.y + 0.05, cell.z + 1],
      [cell.x + 1, cell.y + 0.05, cell.z + 1],
      [cell.x + 1, cell.y + 0.05, cell.z],
      [cell.x, cell.y + 0.05, cell.z],
    ], [0, 1, 0], tile);
  },
  cactus(buffers, input, blocks, cell, definition, orientation) {
    boxShape(buffers, input, blocks, cell, definition, orientation, 0.0625, 0, 0.0625, 0.9375, 1, 0.9375);
  },
};

function allTiles(blocks: BlockRegistry, definition: BlockDefinition, orientation: number) {
  return {
    px: tileFor(blocks, definition, 0, orientation),
    nx: tileFor(blocks, definition, 1, orientation),
    py: tileFor(blocks, definition, 2, orientation),
    ny: tileFor(blocks, definition, 3, orientation),
    pz: tileFor(blocks, definition, 4, orientation),
    nz: tileFor(blocks, definition, 5, orientation),
  };
}

function slabBox(
  buffers: MeshBuffers,
  input: MeshingInput,
  blocks: BlockRegistry,
  cell: BlockPos,
  definition: BlockDefinition,
  orientation: number,
  yMin: number,
  yMax: number,
): void {
  const x = cell.x;
  const z = cell.z;
  const tiles = allTiles(blocks, definition, orientation);
  const faces: readonly [Tuple3, keyof typeof tiles, Tuple3[]][] = [
    [[1, 0, 0], 'px', [[x + 1, cell.y + yMin, z], [x + 1, cell.y + yMin, z + 1], [x + 1, cell.y + yMax, z + 1], [x + 1, cell.y + yMax, z]]],
    [[-1, 0, 0], 'nx', [[x, cell.y + yMin, z + 1], [x, cell.y + yMin, z], [x, cell.y + yMax, z], [x, cell.y + yMax, z + 1]]],
    [[0, 1, 0], 'py', [[x, cell.y + yMax, z + 1], [x + 1, cell.y + yMax, z + 1], [x + 1, cell.y + yMax, z], [x, cell.y + yMax, z]]],
    [[0, -1, 0], 'ny', [[x, cell.y + yMin, z], [x + 1, cell.y + yMin, z], [x + 1, cell.y + yMin, z + 1], [x, cell.y + yMin, z + 1]]],
    [[0, 0, 1], 'pz', [[x + 1, cell.y + yMin, z + 1], [x, cell.y + yMin, z + 1], [x, cell.y + yMax, z + 1], [x + 1, cell.y + yMax, z + 1]]],
    [[0, 0, -1], 'nz', [[x, cell.y + yMin, z], [x + 1, cell.y + yMin, z], [x + 1, cell.y + yMax, z], [x, cell.y + yMax, z]]],
  ];
  for (const [normal, key, corners] of faces) {
    if (occluderBeside(input, blocks, cell, normal)) continue;
    emitQuad(buffers, corners, normal, tiles[key]);
  }
}

function boxShape(
  buffers: MeshBuffers,
  input: MeshingInput,
  blocks: BlockRegistry,
  cell: BlockPos,
  definition: BlockDefinition,
  orientation: number,
  xMin: number,
  yMin: number,
  zMin: number,
  xMax: number,
  yMax: number,
  zMax: number,
): void {
  const min: Tuple3 = [cell.x + xMin, cell.y + yMin, cell.z + zMin];
  const max: Tuple3 = [cell.x + xMax, cell.y + yMax, cell.z + zMax];
  const tiles = allTiles(blocks, definition, orientation);
  const faces: readonly [Tuple3, keyof typeof tiles, Tuple3[]][] = [
    [[1, 0, 0], 'px', [[max[0], min[1], min[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]]]],
    [[-1, 0, 0], 'nx', [[min[0], min[1], max[2]], [min[0], min[1], min[2]], [min[0], max[1], min[2]], [min[0], max[1], max[2]]]],
    [[0, 1, 0], 'py', [[min[0], max[1], max[2]], [max[0], max[1], max[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]]],
    [[0, -1, 0], 'ny', [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], min[1], max[2]], [min[0], min[1], max[2]]]],
    [[0, 0, 1], 'pz', [[max[0], min[1], max[2]], [min[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]]]],
    [[0, 0, -1], 'nz', [[min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]]]],
  ];
  for (const [normal, key, corners] of faces) {
    if (occluderBeside(input, blocks, cell, normal)) continue;
    emitQuad(buffers, corners, normal, tiles[key]);
  }
}

function railBox(
  buffers: MeshBuffers,
  input: MeshingInput,
  blocks: BlockRegistry,
  cell: BlockPos,
  definition: BlockDefinition,
  orientation: number,
  yMin: number,
  yMax: number,
  width: number,
): void {
  const axis = orientation % 2 === 0 ? 'x' : 'z';
  const center = 0.5 - width / 2;
  boxShape(buffers, input, blocks, cell, definition, orientation,
    axis === 'x' ? 0 : center, yMin, axis === 'x' ? center : 0,
    axis === 'x' ? 1 : 0.5 + width / 2, yMax, axis === 'x' ? 0.5 + width / 2 : 1);
}

function meshShapes(
  input: MeshingInput,
  blocks: BlockRegistry,
  orientationAt: (localIndex: number) => number,
  buffers: Record<MeshChannel, MeshBuffers>,
): void {
  for (let y = 0; y < SECTION_SIZE; y += 1) {
    for (let z = 0; z < SECTION_SIZE; z += 1) {
      for (let x = 0; x < SECTION_SIZE; x += 1) {
        const index = localIndex({ x, y, z });
        const definition = blocks.byId(input.section.get(index));
        const channel = channelOf(definition);
        if (!channel || definition.geometryType === 'cube') continue;
        const emitter = shapeEmitters[definition.geometryType];
        emitter?.(
          buffers[channel],
          input,
          blocks,
          { x, y, z },
          definition,
          orientationAt(index),
        );
      }
    }
  }
}

function finalize(buffers: MeshBuffers, sourceVersion: number): ChannelMesh {
  return Object.freeze({
    positions: new Float32Array(buffers.positions),
    normals: new Int8Array(buffers.normals),
    uvs: new Float32Array(buffers.uvs),
    tileIds: new Uint16Array(buffers.tileIds),
    ao: new Uint8Array(buffers.ao),
    indices: new Uint32Array(buffers.indices),
    sourceVersion,
  });
}

export function meshSection(input: MeshingInput, blocks: BlockRegistry): SectionMesh {
  const orientationAt = input.orientations ?? ((index: number) => input.section.getOrientation(index));
  const buffers: Record<MeshChannel, MeshBuffers> = {
    opaque: emptyBuffers(),
    cutout: emptyBuffers(),
    translucent: emptyBuffers(),
  };
  meshCubeChannel(input, blocks, 'opaque', orientationAt, buffers.opaque);
  meshCubeChannel(input, blocks, 'cutout', orientationAt, buffers.cutout);
  meshCubeChannel(input, blocks, 'translucent', orientationAt, buffers.translucent);
  meshShapes(input, blocks, orientationAt, buffers);

  return Object.freeze({
    opaque: finalize(buffers.opaque, input.sourceVersion),
    cutout: finalize(buffers.cutout, input.sourceVersion),
    translucent: finalize(buffers.translucent, input.sourceVersion),
    sourceVersion: input.sourceVersion,
  });
}

/** 兼容阶段 1 的单通道调用：返回 opaque 通道。 */
export function meshOpaque(input: MeshingInput, blocks: BlockRegistry): ChannelMesh {
  return meshSection(input, blocks).opaque;
}

function emptyBuffers(): MeshBuffers {
  return { positions: [], normals: [], uvs: [], tileIds: [], ao: [], indices: [] };
}
