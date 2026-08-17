import { describe, expect, it } from 'vitest';
import type { OpaqueMesh } from '../../../src/meshing/mesh-types';
import { RenderUploadQueue } from '../../../src/app/render-upload-queue';

const mesh: OpaqueMesh = {
  positions: new Float32Array([0, 0, 0]),
  normals: new Int8Array([0, 1, 0]),
  uvs: new Float32Array([0, 0]),
  materialIds: new Uint16Array([1]),
  indices: new Uint32Array([0, 0, 0]),
  sourceVersion: 1,
};

const job = (key: string, estimatedUploadMs: number, editVersion = 1) => ({
  key,
  editVersion,
  mesh: { ...mesh, sourceVersion: editVersion },
  estimatedUploadMs,
});

describe('RenderUploadQueue', () => {
  it('drains only jobs whose literal estimates fit the per-frame budget', () => {
    const queue = new RenderUploadQueue();
    queue.enqueue(job('a', 1));
    queue.enqueue(job('b', 1));
    queue.enqueue(job('c', 1));
    const uploaded: string[] = [];

    const result = queue.drain(2, (upload) => uploaded.push(upload.key));

    expect(uploaded).toEqual(['a', 'b']);
    expect(result).toEqual({ uploads: 2, uploadedBytes: 74, spentMs: 2, queued: 1 });
  });

  it('resumes an oversized head across bounded frames and then processes later jobs atomically', () => {
    const queue = new RenderUploadQueue();
    queue.enqueue(job('oversized', 2.5));
    queue.enqueue(job('later', 1));
    const uploaded: string[] = [];

    const firstFrame = queue.drain(2, (upload) => uploaded.push(upload.key));
    expect(uploaded).toEqual([]);
    queue.enqueue(job('oversized', 2.5));
    const secondFrame = queue.drain(2, (upload) => uploaded.push(upload.key));

    expect(firstFrame).toEqual({
      uploads: 0,
      uploadedBytes: 0,
      spentMs: 2,
      queued: 2,
    });
    expect(uploaded).toEqual(['oversized', 'later']);
    expect(secondFrame).toEqual({ uploads: 2, uploadedBytes: 74, spentMs: 1.5, queued: 0 });
    expect(firstFrame.spentMs).toBeLessThanOrEqual(2);
    expect(secondFrame.spentMs).toBeLessThanOrEqual(2);
  });

  it('retains only loaded keys and replaces a queued key with its newest version', () => {
    const queue = new RenderUploadQueue();
    queue.enqueue(job('retained', 1, 1));
    queue.enqueue(job('evicted', 1, 1));
    queue.enqueue(job('retained', 1, 2));
    queue.retain(new Set(['retained']));
    const versions: number[] = [];

    queue.drain(2, (upload) => versions.push(upload.editVersion));

    expect(versions).toEqual([2]);
    expect(queue.queued).toBe(0);
  });
});
