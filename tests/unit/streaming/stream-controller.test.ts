import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';
import type { ChannelMesh } from '../../../src/meshing/mesh-types';
import { StreamController } from '../../../src/streaming/stream-controller';
import type { WorkRequest } from '../../../src/workers/protocol';

const freshWorldEditVersion = (): number => 0;

function emptyMesh(sourceVersion = 0): ChannelMesh {
  return {
    positions: new Float32Array(),
    normals: new Int8Array(),
    uvs: new Float32Array(),
    tileIds: new Uint16Array(),
    ao: new Uint8Array(),
    indices: new Uint32Array(),
    sourceVersion,
  };
}

function requestedStream(editVersionForKey = freshWorldEditVersion): StreamController {
  const stream = new StreamController(editVersionForKey);
  stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);
  return stream;
}

function sectionAtVersion(version: number): VoxelSection {
  let section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 0);
  for (let index = 0; index < version; index += 1) section = section.set(index, 1);
  return section;
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
  it('requests every configured vertical section for a visible column', () => {
    const stream = new StreamController(freshWorldEditVersion);

    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0, [0, 1, 2]);

    const keys: string[] = [];
    let work = stream.takeWork();
    while (work) {
      keys.push(work.key);
      work = stream.takeWork();
    }
    expect(new Set(keys)).toEqual(new Set(['0,0,0', '0,1,0', '0,2,0']));
  });

  it('requests a square footprint so radius one covers all nine columns', () => {
    const stream = new StreamController(freshWorldEditVersion);
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 1);
    const keys: string[] = [];

    let work = stream.takeWork();
    while (work) {
      keys.push(work.key);
      work = stream.takeWork();
    }

    expect(new Set(keys)).toEqual(new Set([
      '-1,0,-1', '0,0,-1', '1,0,-1',
      '-1,0,0', '0,0,0', '1,0,0',
      '-1,0,1', '0,0,1', '1,0,1',
    ]));
  });

  it('removes a failed flight so a later visibility refresh can retry it', () => {
    const stream = requestedStream();
    const failed = take(stream, 'generate');

    expect(stream.rejectWork(failed)).toBe(true);
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);

    const retry = take(stream, 'generate');
    expect(retry.epoch).toBeGreaterThan(failed.epoch);
  });

  it('releases queued work, records, uploads, and tombstones when disposed', () => {
    const stream = requestedStream();
    const flight = take(stream, 'generate');
    stream.rejectWork(flight);
    stream.requestVisibleColumns({ x: 1, z: 0 }, { x: 0, z: 0 }, 1);

    stream.dispose();

    expect(stream.diagnostics()).toEqual({
      queuedWork: 0,
      tombstones: 0,
      sectionRecords: 0,
      uploads: 0,
    });
  });

  it('rejects a mesh result whose editVersion is older than the loaded section', () => {
    const section = sectionAtVersion(2);
    const stream = requestedStream(() => section.editVersion);
    const generate = take(stream, 'generate');
    expect(
      stream.acceptGenerated({
        key: generate.key,
        epoch: generate.epoch,
        editVersion: generate.editVersion,
        section,
      }),
    ).toBe(true);
    const mesh = take(stream, 'mesh');

    expect(mesh.editVersion).toBe(2);
    expect(stream.acceptMeshed({ ...mesh, editVersion: 1, mesh: emptyMesh(1) })).toBe(false);
  });

  it('hands the accepted generated section to the mesh work request', () => {
    const section = sectionAtVersion(2);
    const stream = requestedStream(() => section.editVersion);
    const generate = take(stream, 'generate');
    expect(stream.acceptGenerated({ ...generate, section })).toBe(true);

    const mesh = take(stream, 'mesh');
    if (mesh.kind !== 'mesh') throw new Error('expected mesh work');
    expect(mesh.section).toBe(section);
  });

  it('does not hand a cancelled generated section to a replacement request', () => {
    const stream = requestedStream();
    const generate = take(stream, 'generate');
    expect(stream.acceptGenerated({ ...generate, section: sectionAtVersion(0) })).toBe(true);
    stream.requestVisibleColumns({ x: 1, z: 0 }, { x: 0, z: 0 }, 0);

    const replacement = take(stream, 'generate');
    expect(replacement).toMatchObject({ key: '1,0,0', kind: 'generate' });
    expect(replacement).not.toHaveProperty('section');
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

  it('requeues a new generation epoch when the live edit version changes in flight', () => {
    let liveVersion = 2;
    const stream = requestedStream(() => liveVersion);
    const staleGenerate = take(stream, 'generate');
    liveVersion = 3;

    expect(stream.acceptGenerated({ ...staleGenerate, section: sectionAtVersion(2) })).toBe(false);

    const replacement = take(stream, 'generate');
    expect(replacement).toMatchObject({
      key: staleGenerate.key,
      epoch: staleGenerate.epoch + 1,
      editVersion: 3,
      kind: 'generate',
    });
    expect(replacement).not.toHaveProperty('section');
  });

  it('requeues an in-flight generation on a visibility refresh after the version changes', () => {
    let liveVersion = 2;
    const stream = requestedStream(() => liveVersion);
    const staleGenerate = take(stream, 'generate');
    liveVersion = 3;
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 0, z: 0 }, 0);

    const replacement = take(stream, 'generate');
    expect(replacement).toMatchObject({
      key: staleGenerate.key,
      epoch: staleGenerate.epoch + 1,
      editVersion: 3,
    });
    expect(stream.acceptGenerated({ ...staleGenerate, section: sectionAtVersion(2) })).toBe(false);
    expect(stream.acceptGenerated({ ...replacement, section: sectionAtVersion(3) })).toBe(true);
  });

  it('requeues a new generation epoch when the live version changes during meshing', () => {
    let liveVersion = 2;
    const stream = requestedStream(() => liveVersion);
    const generate = take(stream, 'generate');
    expect(stream.acceptGenerated({ ...generate, section: sectionAtVersion(2) })).toBe(true);
    const staleMesh = take(stream, 'mesh');
    liveVersion = 3;

    expect(stream.acceptMeshed({ ...staleMesh, mesh: emptyMesh(2) })).toBe(false);

    const replacement = take(stream, 'generate');
    expect(replacement).toMatchObject({
      key: staleMesh.key,
      epoch: staleMesh.epoch + 1,
      editVersion: 3,
      kind: 'generate',
    });
    expect(replacement).not.toHaveProperty('section');
  });

  it('does not cancel a current mesh flight for a result with only a stale callback version', () => {
    const stream = requestedStream(() => 2);
    const generate = take(stream, 'generate');
    expect(stream.acceptGenerated({ ...generate, section: sectionAtVersion(2) })).toBe(true);
    const mesh = take(stream, 'mesh');

    expect(stream.acceptMeshed({ ...mesh, editVersion: 1, mesh: emptyMesh(1) })).toBe(false);
    expect(stream.acceptMeshed({ ...mesh, mesh: emptyMesh(2) })).toBe(true);
  });

  it('assigns a higher request priority to columns in the velocity direction', () => {
    const stream = requestedStream();
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 1, z: 0 }, 2);

    expect(stream.peekPriority({ x: 2, z: 0 })).toBeGreaterThan(stream.peekPriority({ x: -2, z: 0 }));
  });

  it('re-scores queued work when velocity reverses without changing the visible footprint', () => {
    const stream = new StreamController(freshWorldEditVersion);
    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: 1, z: 0 }, 2);
    expect(stream.peekPriority({ x: 2, z: 0 })).toBeGreaterThan(stream.peekPriority({ x: -2, z: 0 }));

    stream.requestVisibleColumns({ x: 0, z: 0 }, { x: -1, z: 0 }, 2);

    expect(stream.peekPriority({ x: -2, z: 0 })).toBeGreaterThan(stream.peekPriority({ x: 2, z: 0 }));
    expect(stream.takeWork()?.key).toBe('-1,0,0');
    expect(stream.takeWork()?.key).toBe('0,0,0');
    expect(stream.takeWork()?.key).toBe('-1,0,-1');
  });

  it('returns no more jobs than fit in the declared upload budget', () => {
    const stream = requestedStream();
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

  it('throws with the section key when an illegal lifecycle edge is attempted', () => {
    const stream = requestedStream();
    const internals = stream as unknown as {
      transition(
        record: { key: string; state: 'absent' },
        from: 'absent',
        to: 'visible',
      ): void;
    };

    expect(() => internals.transition({ key: 'illegal,0,edge', state: 'absent' }, 'absent', 'visible')).toThrow(
      'illegal,0,edge',
    );
  });
});
