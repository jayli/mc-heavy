import { describe, expect, it } from 'vitest';
import type { GenerationWorkerRequest, GenerationWorkerResponse } from '../../../src/workers/protocol';
import {
  createInProcessWorkerFactory,
  type WorkerFactory,
  type WorkerPort,
} from '../../../src/workers/worker-client';
import { WorldService } from '../../../src/world/world-service';

function failOnceWorkerFactory(): Readonly<{ factory: WorkerFactory; failNextGeneration(): void }> {
  const delegate = createInProcessWorkerFactory();
  let failNext = false;
  return {
    failNextGeneration: () => {
      failNext = true;
    },
    factory: {
      createGenerationWorker() {
        const inner = delegate.createGenerationWorker();
        const port: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse> = {
          onmessage: null,
          onerror: null,
          postMessage(message, transfer) {
            if (failNext) {
              failNext = false;
              queueMicrotask(() => {
                const error = new Error('worker crashed');
                port.onerror?.({ error, message: error.message } as ErrorEvent);
              });
              return;
            }
            inner.postMessage(message, transfer);
          },
          terminate: () => inner.terminate(),
        };
        inner.onmessage = (event) => port.onmessage?.(event);
        inner.onerror = (event) => port.onerror?.(event);
        return port;
      },
      createMeshingWorker: () => delegate.createMeshingWorker(),
    },
  };
}

describe('WorldService worker integration', () => {
  it('makes all nine spawn columns queryable before resolving prepareSpawn', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });

    await world.prepareSpawn({ x: 0, z: 0 });

    expect(world.loadedColumns()).toHaveLength(9);
    expect(world.isSolid({ x: 0, y: -1, z: 0 })).toBe(true);
    expect(world.visibleMeshFor('0,0,0')?.indices).toHaveLength(12);
    world.dispose();
  });

  it('publishes a replacement mesh with the latest world edit version', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    await world.prepareSpawn({ x: 0, z: 0 });

    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 0 }]);
    await world.prepareSpawn({ x: 0, z: 0 });

    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(world.visibleMeshFor('0,0,0')?.sourceVersion).toBe(1);
    world.dispose();
  });

  it('remeshes a visible edge section when a newly loaded column supplies its missing halo', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    await world.prepareSpawn({ x: 0, z: 0 });
    const edgeBefore = world.visibleMeshFor('1,0,0');

    await world.prepareSpawn({ x: 1, z: 0 });

    const edgeAfter = world.visibleMeshFor('1,0,0');
    expect(edgeAfter).not.toBe(edgeBefore);
    expect(edgeAfter?.sourceVersion).toBe(1);
    expect(edgeAfter?.indices).toHaveLength(12);
    world.dispose();
  });

  it('evicts departed halo sections and restores faces on the new visible boundary', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    await world.prepareSpawn({ x: 0, z: 0 });

    await world.prepareSpawn({ x: 1, z: 0 });

    expect(world.loadedColumns()).toHaveLength(9);
    expect(world.cachedSectionCount()).toBe(9);
    expect(world.visibleMeshFor('0,0,0')?.indices).toHaveLength(18);
    world.dispose();
  });

  it('invalidates the adjacent visible mesh after a boundary edit changes its halo', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    await world.prepareSpawn({ x: 0, z: 0 });
    const westBefore = world.visibleMeshFor('-1,0,0');
    const eastBefore = world.visibleMeshFor('1,0,0');

    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 0 }]);
    await world.prepareSpawn({ x: 0, z: 0 });

    expect(world.visibleMeshFor('0,0,0')?.sourceVersion).toBe(1);
    expect(world.visibleMeshFor('-1,0,0')).not.toBe(westBefore);
    expect(world.visibleMeshFor('-1,0,0')?.sourceVersion).toBe(1);
    expect(world.visibleMeshFor('1,0,0')).toBe(eastBefore);
    world.dispose();
  });

  it('keeps the currently visible mesh when replacement work fails', async () => {
    const controlled = failOnceWorkerFactory();
    const world = new WorldService({ seed: 123, workerFactory: controlled.factory });
    await world.prepareSpawn({ x: 0, z: 0 });
    const visible = world.visibleMeshFor('0,0,0');
    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 0 }]);
    controlled.failNextGeneration();

    await expect(world.prepareSpawn({ x: 0, z: 0 })).rejects.toThrow('worker crashed');

    expect(world.visibleMeshFor('0,0,0')).toBe(visible);
    await world.prepareSpawn({ x: 0, z: 0 });
    expect(world.visibleMeshFor('0,0,0')?.sourceVersion).toBe(1);
    world.dispose();
  });

  it('does not resolve an overlapping spawn request after its ring was superseded', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });

    const first = world.prepareSpawn({ x: 0, z: 0 });
    const second = world.prepareSpawn({ x: 100, z: 0 });

    await expect(first).rejects.toThrow('superseded');
    await second;
    expect(world.loadedColumns().map(({ x }) => x)).toEqual([99, 100, 101, 99, 100, 101, 99, 100, 101]);
    world.dispose();
  });
});
