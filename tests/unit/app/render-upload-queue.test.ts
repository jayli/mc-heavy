import { describe, expect, it } from 'vitest';
import type { ChannelMesh } from '../../../src/meshing/mesh-types';
import { RenderUploadQueue, type UploadSink } from '../../../src/app/render-upload-queue';

const BYTES_PER_MILLISECOND = 64 * 1024;

// Staged byte sizes (Int8 normals become Float32 on upload):
// positions 12, normals 12, uvs 8, tileIds 2, ao 1, indices 12 -> 47 bytes.
const smallMesh: ChannelMesh = {
  positions: new Float32Array([0, 0, 0]),
  normals: new Int8Array([0, 1, 0]),
  uvs: new Float32Array([0, 0]),
  tileIds: new Uint16Array([1]),
  ao: new Uint8Array([3]),
  indices: new Uint32Array([0, 0, 0]),
  sourceVersion: 1,
};

// positions 40000, normals 40000, uvs 80000, tileIds 20000, ao 10000,
// indices 40000 -> 230000 staged bytes, oversized against a 2 ms frame budget.
const oversizedMesh: ChannelMesh = {
  positions: new Float32Array(10_000),
  normals: new Int8Array(10_000),
  uvs: new Float32Array(20_000),
  tileIds: new Uint16Array(10_000),
  ao: new Uint8Array(10_000),
  indices: new Uint32Array(10_000),
  sourceVersion: 1,
};

const job = (key: string, mesh: ChannelMesh, estimatedUploadMs: number) => ({
  key,
  editVersion: mesh.sourceVersion,
  mesh,
  estimatedUploadMs,
});

function fakeSink(): Readonly<{
  sink: UploadSink;
  stagedBytes: Map<string, number>;
  stageCalls: Array<Readonly<{ key: string; maxBytes: number }>>;
  commits: string[];
}> {
  const stagedBytes = new Map<string, number>();
  const stageCalls: Array<Readonly<{ key: string; maxBytes: number }>> = [];
  const commits: string[] = [];
  return {
    stagedBytes,
    stageCalls,
    commits,
    sink: {
      stage(jobToStage, maxBytes) {
        stageCalls.push({ key: jobToStage.key, maxBytes });
        const total = oversizedMeshSizeFor(jobToStage.mesh);
        const done = stagedBytes.get(jobToStage.key) ?? 0;
        const amount = Math.min(maxBytes, total - done);
        stagedBytes.set(jobToStage.key, done + amount);
        return amount;
      },
      commit(jobToCommit) {
        commits.push(jobToCommit.key);
      },
    },
  };
}

function oversizedMeshSizeFor(mesh: ChannelMesh): number {
  if (mesh === oversizedMesh) return 230_000;
  return 47;
}

describe('RenderUploadQueue', () => {
  it('stages an oversized job within the per-frame byte budget and resumes it next frame', () => {
    const queue = new RenderUploadQueue();
    const sink = fakeSink();
    queue.enqueue(job('oversized', oversizedMesh, 2.5));
    queue.enqueue(job('later', smallMesh, 1));

    const firstFrame = queue.drain(2, sink.sink);

    expect(sink.commits).toEqual([]);
    expect(sink.stageCalls).toEqual([{ key: 'oversized', maxBytes: 2 * BYTES_PER_MILLISECOND }]);
    expect(sink.stagedBytes.get('oversized')).toBe(2 * BYTES_PER_MILLISECOND);
    expect(firstFrame).toEqual({ uploads: 0, uploadedBytes: 0, spentMs: 2, queued: 2 });

    const secondFrame = queue.drain(2, sink.sink);

    expect(sink.commits).toEqual(['oversized', 'later']);
    expect(sink.stageCalls[1]).toEqual({ key: 'oversized', maxBytes: 98_928 });
    expect(sink.stageCalls[2]).toEqual({ key: 'later', maxBytes: 47 });
    expect(sink.stagedBytes.get('oversized')).toBe(230_000);
    expect(sink.stagedBytes.get('later')).toBe(47);
    expect(secondFrame.uploads).toBe(2);
    expect(secondFrame.uploadedBytes).toBe(230_047);
    expect(secondFrame.spentMs).toBeCloseTo(98_975 / BYTES_PER_MILLISECOND, 9);
    expect(secondFrame.queued).toBe(0);
  });

  it('converts the remaining millisecond budget to bytes and reports exact spent time', () => {
    const queue = new RenderUploadQueue();
    const sink = fakeSink();
    queue.enqueue(job('small', smallMesh, 1));

    const result = queue.drain(0.0007171630859375, sink.sink);

    expect(sink.stageCalls).toEqual([{ key: 'small', maxBytes: 47 }]);
    expect(sink.commits).toEqual(['small']);
    expect(result.uploads).toBe(1);
    expect(result.uploadedBytes).toBe(47);
    expect(result.spentMs).toBeCloseTo(47 / BYTES_PER_MILLISECOND, 9);
    expect(result.queued).toBe(0);
  });

  it('retains only loaded keys and replaces a queued key with its newest version', () => {
    const queue = new RenderUploadQueue();
    const sink = fakeSink();
    queue.enqueue(job('retained', smallMesh, 1));
    queue.enqueue(job('evicted', smallMesh, 1));
    queue.enqueue(job('retained', { ...smallMesh, sourceVersion: 2 }, 1));
    queue.retain(new Set(['retained']));

    queue.drain(2, sink.sink);

    expect(sink.commits).toEqual(['retained']);
    expect(queue.queued).toBe(0);
  });

  it('rejects non-finite or negative upload estimates', () => {
    const queue = new RenderUploadQueue();

    expect(() => queue.enqueue(job('bad', smallMesh, Number.NaN))).toThrow('Upload estimate');
    expect(() => queue.enqueue(job('bad', smallMesh, -1))).toThrow('Upload estimate');
  });
});
