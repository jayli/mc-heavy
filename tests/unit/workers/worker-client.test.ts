import { describe, expect, it } from 'vitest';
import { VoxelSection } from '../../../src/domain/voxel-section';
import { createInProcessWorkerFactory, WorkerClient } from '../../../src/workers/worker-client';
import { serializeVoxelSection } from '../../../src/workers/voxel-section-codec';

describe('WorkerClient', () => {
  it('uses the in-process protocol adapter to run real generation work', async () => {
    const client = new WorkerClient(createInProcessWorkerFactory());

    const result = await client.generate({
      kind: 'generate',
      key: '0,0,0',
      epoch: 1,
      editVersion: 0,
      seed: 123,
    });

    expect(result).toMatchObject({ kind: 'generated', key: '0,0,0', epoch: 1, editVersion: 0 });
    expect(result.section.indices.byteLength).toBe(16 * 16 * 16 * Uint16Array.BYTES_PER_ELEMENT);
    client.dispose();
  });

  it('rejects handler failures from the in-process worker adapter', async () => {
    const client = new WorkerClient(createInProcessWorkerFactory());

    await expect(client.generate({
      kind: 'generate',
      key: 'invalid',
      epoch: 1,
      editVersion: 0,
      seed: 123,
    })).rejects.toThrow('Invalid section key');
    client.dispose();
  });

  it('rejects unfinished requests when disposed', async () => {
    const client = new WorkerClient(createInProcessWorkerFactory());
    const pending = client.generate({
      kind: 'generate',
      key: '0,0,0',
      epoch: 1,
      editVersion: 0,
      seed: 123,
    });

    client.dispose();

    await expect(pending).rejects.toThrow('disposed');
  });

  it('transfers serialized section buffers when submitting mesh work', async () => {
    const client = new WorkerClient(createInProcessWorkerFactory());
    const section = serializeVoxelSection(VoxelSection.filled({ x: 0, y: 0, z: 0 }, 1));

    const pending = client.mesh({
      kind: 'mesh',
      key: '0,0,0',
      epoch: 1,
      editVersion: 0,
      section,
      neighbors: [],
    });

    expect(section.palette.byteLength).toBe(0);
    expect(section.indices.byteLength).toBe(0);
    expect((await pending).mesh.indices.length).toBeGreaterThan(0);
    client.dispose();
  });
});
