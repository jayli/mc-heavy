import { importFromLegacyIndexedDb, parseLegacySnapshot } from '../persistence/legacy-import';
import { SnapshotStore, type WorldSnapshot } from '../persistence/snapshot-store';

type PersistenceWorkerRequest =
  | Readonly<{ kind: 'save'; snapshot: WorldSnapshot }>
  | Readonly<{ kind: 'load' }>
  | Readonly<{ kind: 'parseLegacy'; input: unknown }>
  | Readonly<{ kind: 'importLegacy' }>;

type PersistenceWorkerResponse = Readonly<{ kind: 'result'; result: unknown }>
  | Readonly<{ kind: 'error'; error: string }>;

type PersistenceWorkerScope = Readonly<{
  addEventListener(type: 'message', listener: (event: MessageEvent<PersistenceWorkerRequest>) => void): void;
  postMessage(message: PersistenceWorkerResponse): void;
}>;

const store = new SnapshotStore();
const workerScope = globalThis as unknown as PersistenceWorkerScope;

workerScope.addEventListener('message', ({ data }) => {
  void handlePersistenceRequest(data).then(
    (result) => workerScope.postMessage({ kind: 'result', result }),
    (error: unknown) => workerScope.postMessage({
      kind: 'error',
      error: error instanceof Error ? error.message : 'Persistence worker failed',
    }),
  );
});

async function handlePersistenceRequest(request: PersistenceWorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case 'save':
      await store.save(request.snapshot);
      return undefined;
    case 'load':
      return store.loadCurrent();
    case 'parseLegacy':
      return parseLegacySnapshot(request.input);
    case 'importLegacy':
      return importFromLegacyIndexedDb(globalThis.indexedDB);
  }
}
