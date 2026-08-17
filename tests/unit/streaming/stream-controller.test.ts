import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';
import type { OpaqueMesh } from '../../../src/meshing/mesh-types';
import { StreamController } from '../../../src/streaming/stream-controller';
import type { WorkRequest } from '../../../src/workers/protocol';

function emptyMesh(sourceVersion = 0): OpaqueMesh {
  return {
    positions: new Float32Array(),
    normals: new Int8Array(),
    uvs: new Float32Array(),
    materialIds: new Uint16Array(),
    indices: new Uint32Array(),
    sourceVersion,
  };
}

function requestedStream(): StreamController {
  const stream = new StreamController();
  stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);
  return stream;
}

function take(stream: StreamController, kind: WorkRequest['kind']): WorkRequest {
  const request = stream.takeWork();
  expect(request).toMatchObject({ kind });
  return request as WorkRequest;
}

function queueUpload(stream: StreamController): void {
  while (true) {
    const request = stream.takeWork();
    if (!request) throw new Error('expected queued work');
    if (request.kind === 'generate') {
      expect(
        stream.acceptGenerated({
          ...request,
          section: VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1),
        }),
      ).toBe(true);
      continue;
    }
    expect(stream.acceptMeshed({ ...request, mesh: emptyMesh(request.editVersion) })).toBe(true);
    return;
  }
}

describe('StreamController', () => {
  it('rejects a mesh result whose editVersion is older than the loaded section', () => {
    const stream = requestedStream();
    const generate = take(stream, 'generate');
    expect(
      stream.acceptGenerated({
        key: generate.key,
        epoch: generate.epoch,
        editVersion: generate.editVersion,
        section: VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1),
      }),
    ).toBe(true);
    const mesh = take(stream, 'mesh');

    expect(stream.acceptMeshed({ ...mesh, editVersion: mesh.editVersion - 1, mesh: emptyMesh() })).toBe(false);
  });

  it('rejects an obsolete generation callback after its column was cancelled and requested again', () => {
    const stream = requestedStream();
    const oldRequest = take(stream, 'generate');
    stream.requestVisibleColumns({ x: 1, z: 0 }, { x: 0, z: 0 }, 0);
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);
    const currentRequest = take(stream, 'generate');

    expect(currentRequest.epoch).toBeGreaterThan(oldRequest.epoch);
    expect(
      stream.acceptGenerated({
        ...oldRequest,
        section: VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1),
      }),
    ).toBe(false);
  });

  it('assigns a higher request priority to columns in the velocity direction', () => {
    const stream = new StreamController();
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 1, z: 0 }, 2);

    expect(stream.peekPriority({ x: 2, z: 0 })).toBeGreaterThan(stream.peekPriority({ x: -2, z: 0 }));
  });

  it('returns no more jobs than fit in the declared upload budget', () => {
    const stream = new StreamController();
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 1);
    queueUpload(stream);
    queueUpload(stream);

    expect(stream.drainUploads(1)).toHaveLength(1);
    expect(stream.drainUploads(1)).toHaveLength(1);
  });

  it('keeps an upload queued when its estimated cost exceeds the budget', () => {
    const stream = requestedStream();
    queueUpload(stream);

    expect(stream.drainUploads(0.5)).toEqual([]);
    expect(stream.drainUploads(1)).toHaveLength(1);
  });
});
