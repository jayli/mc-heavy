import { describe, expect, it } from 'vitest';
import type { GenerationWorkerRequest, GenerationWorkerResponse } from '../../../src/workers/protocol';
import {
  createInProcessWorkerFactory,
  type WorkerFactory,
  type WorkerPort,
} from '../../../src/workers/worker-client';
import { WorldService } from '../../../src/world/world-service';

function failOnceWorkerFactory(): Readonly<{
  factory: WorkerFactory;
  failNextGeneration(key?: string): void;
}> {
  const delegate = createInProcessWorkerFactory();
  let failureKey: string | undefined;
  let failNext = false;
  return {
    failNextGeneration: (key) => {
      failNext = true;
      failureKey = key;
    },
    factory: {
      createGenerationWorker() {
        const inner = delegate.createGenerationWorker();
        const port: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse> = {
          onmessage: null,
          onerror: null,
          postMessage(message, transfer) {
            if (failNext && (failureKey === undefined || failureKey === message.key)) {
              failNext = false;
              throw new Error('worker crashed');
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

function crashOnceWorkerFactory(): Readonly<{
  factory: WorkerFactory;
  armForKey(key: string): void;
  generationWorkerCreations(): number;
}> {
  const delegate = createInProcessWorkerFactory();
  let crashKey: string | undefined;
  let creations = 0;
  return {
    armForKey: (key) => {
      crashKey = key;
    },
    generationWorkerCreations: () => creations,
    factory: {
      createGenerationWorker() {
        creations += 1;
        const inner = delegate.createGenerationWorker();
        const port: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse> = {
          onmessage: null,
          onerror: null,
          postMessage(message, transfer) {
            if (message.key === crashKey) {
              crashKey = undefined;
              queueMicrotask(() => {
                const error = new Error('generation worker crashed');
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
    const loaded = world.loadedBlockAt({ x: 0, y: 0, z: 0 });
    const queriesBefore = world.streamingDiagnostics().loadedSectionQueries;
    expect(loaded).toBeDefined();
    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(loaded);
    expect(world.streamingDiagnostics().loadedSectionQueries).toBe(queriesBefore + 1);
    expect(world.isSolid({ x: 0, y: 0, z: 0 })).toBe(true);
    const rayQueriesBefore = world.streamingDiagnostics().loadedSectionQueries;
    expect(world.raycast({ x: 0.5, y: 0.5, z: 0.5 }, { x: 0, y: 0, z: 0 }, 1)).not.toBeNull();
    expect(world.streamingDiagnostics().loadedSectionQueries).toBeGreaterThan(rayQueriesBefore);
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

  it('waits for a failed generation retry before meshing its halo consumers', async () => {
    const controlled = failOnceWorkerFactory();
    const world = new WorldService({ seed: 123, workerFactory: controlled.factory });
    controlled.failNextGeneration('0,0,0');

    await expect(world.prepareSpawn({ x: 0, z: 0 })).rejects.toThrow('worker crashed');
    await world.prepareSpawn({ x: 0, z: 0 });

    expect(world.visibleMeshFor('0,0,1')?.indices).toHaveLength(18);
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

  it('ignores a failed superseded epoch while completing the latest spawn ring', async () => {
    const controlled = failOnceWorkerFactory();
    const world = new WorldService({ seed: 123, workerFactory: controlled.factory });
    controlled.failNextGeneration('-1,0,-1');

    const superseded = world.prepareSpawn({ x: 0, z: 0 });
    const current = world.prepareSpawn({ x: 100, z: 0 });

    await expect(superseded).rejects.toThrow('superseded');
    await current;
    expect(world.loadedColumns()).toHaveLength(9);
    expect(world.loadedColumns().every(({ x }) => x >= 99 && x <= 101)).toBe(true);
    world.dispose();
  });

  it('replaces a crashed generation worker and retries the current ring after supersession', async () => {
    const controlled = crashOnceWorkerFactory();
    const world = new WorldService({ seed: 123, workerFactory: controlled.factory });
    controlled.armForKey('100,0,0');

    const superseded = world.prepareSpawn({ x: 0, z: 0 });
    const current = world.prepareSpawn({ x: 100, z: 0 });

    await expect(superseded).rejects.toThrow('superseded');
    await current;
    expect(world.loadedColumns()).toHaveLength(9);
    expect(world.loadedColumns().every(({ x }) => x >= 99 && x <= 101)).toBe(true);
    expect(controlled.generationWorkerCreations()).toBeGreaterThan(1);
    world.dispose();
  });

  it('continues current mesh work after discarding a delayed stale mesh batch', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    const superseded = world.prepareSpawn({ x: 0, z: 0 });
    while (world.streamingDiagnostics().pendingMeshes < 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const current = world.prepareSpawn({ x: 100, z: 0 });

    await expect(superseded).rejects.toThrow('superseded');
    await current;
    expect(world.loadedColumns()).toHaveLength(9);
    expect(world.loadedColumns().every(({ x }) => x >= 99 && x <= 101)).toBe(true);
    world.dispose();
  });

  it('yields between bounded default-radius streaming batches', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });

    expect(world.updateStreaming({ x: 0, y: 0, z: 0 }, { x: 0, z: 0 })).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(world.cachedSectionCount()).toBeLessThanOrEqual(8);
    world.dispose();
  }, 10_000);

  it('keeps transient streaming state bounded across long movement and clears it on dispose', async () => {
    const world = new WorldService({ seed: 123, workerFactory: createInProcessWorkerFactory() });
    world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 0 }]);

    for (let x = 0; x < 20; x += 1) await world.prepareSpawn({ x, z: 0 });

    expect(world.streamingDiagnostics()).toMatchObject({
      cachedSections: 9,
      visibleMeshes: 9,
      failures: 0,
      persistentEditVersions: 1,
      pendingMeshes: 0,
      queuedWork: 0,
      tombstones: 0,
      sectionRecords: 9,
    });
    expect(world.streamingDiagnostics().transientVersions).toBeLessThanOrEqual(9);

    await world.prepareSpawn({ x: 0, z: 0 });
    expect(world.loadedBlockAt({ x: 0, y: 0, z: 0 })).toBe(0);
    expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);

    world.dispose();
    expect(world.streamingDiagnostics()).toMatchObject({
      cachedSections: 0,
      visibleMeshes: 0,
      failures: 0,
      transientVersions: 0,
      persistentEditVersions: 0,
      pendingMeshes: 0,
      queuedWork: 0,
      tombstones: 0,
      sectionRecords: 0,
    });
  }, 10_000);
});
