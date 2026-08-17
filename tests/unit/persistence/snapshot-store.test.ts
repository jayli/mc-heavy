import { indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotStore, type WorldSnapshot } from '../../../src/persistence/snapshot-store';

const databaseName = 'mc-heavy-snapshots';

const snapshotNamed = (id: string): WorldSnapshot => ({
  id,
  seed: 42,
  player: { x: 1, y: 2, z: 3, pitch: 4, yaw: 5 },
  edits: [{ pos: { x: 17, y: 0, z: -1 }, blockId: 5, orientation: 2 }],
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe('SnapshotStore', () => {
  it('round-trips a validated current snapshot through IndexedDB', async () => {
    const store = new SnapshotStore(indexedDB);
    await store.save(snapshotNamed('one'));

    expect(await store.loadCurrent()).toEqual(snapshotNamed('one'));
  });

  it('does not replace the current manifest when the next snapshot is invalid', async () => {
    const store = new SnapshotStore(indexedDB);
    await store.save(snapshotNamed('one'));

    await expect(store.save({ ...snapshotNamed('two'), edits: [{ pos: { x: 0, y: 0, z: 0 }, blockId: 99 }] }))
      .rejects.toThrow('Invalid snapshot block id');

    expect((await store.loadCurrent())?.id).toBe('one');
  });

  it('keeps the previous current manifest if writing the next snapshot fails before commit', async () => {
    const previousStore = new SnapshotStore(indexedDB);
    await previousStore.save(snapshotNamed('one'));
    const store = new SnapshotStore(indexedDB, () => new Error('quota'));

    await expect(store.save(snapshotNamed('two'))).rejects.toThrow('quota');

    expect((await store.loadCurrent())?.id).toBe('one');
  });

  it('returns no snapshot when the pointed manifest is malformed rather than a partial value', async () => {
    const store = new SnapshotStore(indexedDB);
    await store.save(snapshotNamed('one'));

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('manifests', 'readwrite');
        transaction.objectStore('manifests').put({ id: 'one', seed: 42, player: {} });
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });

    await expect(store.loadCurrent()).resolves.toBeNull();
  });
});
