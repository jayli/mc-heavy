import { blockRegistry } from '../domain/blocks';
import { localIndex, SECTION_SIZE, type SectionPos } from '../domain/coords';
import { VoxelSection } from '../domain/voxel-section';
import { meshOpaque } from '../meshing/greedy-mesher';
import { createGenerator } from '../world/terrain';
import type {
  GenerationWorkerRequest,
  GenerationWorkerResponse,
  MeshingWorkerRequest,
  MeshingWorkerResponse,
} from './protocol';
import { deserializeVoxelSection, serializeVoxelSection } from './voxel-section-codec';

function sectionPosForKey(key: string): SectionPos {
  const parts = key.split(',');
  if (parts.length !== 3) throw new Error(`Invalid section key: ${key}`);
  const [x, y, z] = parts.map(Number);
  if (![x, y, z].every(Number.isInteger)) throw new Error(`Invalid section key: ${key}`);
  return { x, y, z };
}

export function handleGenerationRequest(request: GenerationWorkerRequest): GenerationWorkerResponse {
  const pos = sectionPosForKey(request.key);
  const generator = createGenerator(request.seed);
  const palette: number[] = [];
  const paletteByBlock = new Map<number, number>();
  const indices = new Uint16Array(SECTION_SIZE ** 3);

  for (let y = 0; y < SECTION_SIZE; y += 1) {
    for (let z = 0; z < SECTION_SIZE; z += 1) {
      for (let x = 0; x < SECTION_SIZE; x += 1) {
        const blockId = generator.blockAt({
          x: pos.x * SECTION_SIZE + x,
          y: pos.y * SECTION_SIZE + y,
          z: pos.z * SECTION_SIZE + z,
        });
        let paletteIndex = paletteByBlock.get(blockId);
        if (paletteIndex === undefined) {
          paletteIndex = palette.length;
          palette.push(blockId);
          paletteByBlock.set(blockId, paletteIndex);
        }
        indices[localIndex({ x, y, z })] = paletteIndex;
      }
    }
  }

  const section = VoxelSection.fromPaletteIndices(
    pos,
    Uint16Array.from(palette),
    indices,
    request.editVersion,
  );
  return {
    kind: 'generated',
    key: request.key,
    epoch: request.epoch,
    editVersion: request.editVersion,
    section: serializeVoxelSection(section),
  };
}

export function handleMeshingRequest(request: MeshingWorkerRequest): MeshingWorkerResponse {
  const section = deserializeVoxelSection(request.section);
  const neighbors = request.neighbors.map((neighbor) => (
    neighbor ? deserializeVoxelSection(neighbor) : undefined
  ));
  return {
    kind: 'meshed',
    key: request.key,
    epoch: request.epoch,
    editVersion: request.editVersion,
    mesh: meshOpaque({ section, neighbors, sourceVersion: request.editVersion }, blockRegistry),
  };
}

function transferableBuffer(view: ArrayBufferView): ArrayBuffer {
  if (!(view.buffer instanceof ArrayBuffer)) throw new Error('Worker payload requires ArrayBuffer-backed arrays');
  return view.buffer;
}

export function generationTransferables(response: GenerationWorkerResponse): Transferable[] {
  return [transferableBuffer(response.section.palette), response.section.indices];
}

export function meshingTransferables(response: MeshingWorkerResponse): Transferable[] {
  return [
    transferableBuffer(response.mesh.positions),
    transferableBuffer(response.mesh.normals),
    transferableBuffer(response.mesh.uvs),
    transferableBuffer(response.mesh.tileIds),
    transferableBuffer(response.mesh.ao),
    transferableBuffer(response.mesh.indices),
  ];
}
