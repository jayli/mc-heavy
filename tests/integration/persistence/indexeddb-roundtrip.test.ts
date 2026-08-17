import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../../src/persistence/snapshot-store';

const databaseName = 'mc-heavy-snapshots';

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe('IndexedDB snapshot roundtrip', () => {
  it('keeps only the fully published snapshot current across store instances', async () => {
    const firstStore = new SnapshotStore(indexedDB);
    await firstStore.save({
      id: 'session-1',
      seed: 17,
      player: { x: 8, y: 9, z: 10, pitch: 0.5, yaw: 1.5 },
      edits: [
        { pos: { x: -1, y: 63, z: 1 }, blockId: 1 },
        { pos: { x: 16, y: 64, z: 1 }, blockId: 5, orientation: 3 },
      ],
    });

    const secondStore = new SnapshotStore(indexedDB);
    expect(await secondStore.loadCurrent()).toEqual({
      id: 'session-1',
      seed: 17,
      player: { x: 8, y: 9, z: 10, pitch: 0.5, yaw: 1.5 },
      edits: [
        { pos: { x: -1, y: 63, z: 1 }, blockId: 1 },
        { pos: { x: 16, y: 64, z: 1 }, blockId: 5, orientation: 3 },
      ],
    });
  });
});
