import { blockById } from '../domain/blocks';
import type { BlockEdit } from '../world/world-query';
import type { PlayerSnapshot } from './legacy-import';

export type WorldSnapshot = Readonly<{
  id: string;
  seed: number;
  player: PlayerSnapshot;
  edits: readonly BlockEdit[];
}>;

type StoredSection = Readonly<{
  id: string;
  edits: readonly Readonly<{ index: number; edit: BlockEdit }>[];
}>;

type StoredManifest = Readonly<{
  id: string;
  seed: number;
  player: PlayerSnapshot;
  sectionIds: readonly string[];
}>;

const DATABASE_NAME = 'mc-heavy-snapshots';
const DATABASE_VERSION = 1;
const CURRENT_MANIFEST_KEY = 'currentManifestId';

export class SnapshotStore {
  constructor(private readonly indexedDb: IDBFactory = globalThis.indexedDB) {}

  async save(snapshot: WorldSnapshot): Promise<void> {
    const validSnapshot = validateSnapshot(snapshot);
    const database = await this.open();
    try {
      const sections = serializeSections(validSnapshot);
      const transaction = database.transaction(['sections', 'entities', 'manifests', 'meta'], 'readwrite');
      const sectionStore = transaction.objectStore('sections');
      for (const section of sections) sectionStore.put(section);
      transaction.objectStore('entities').add({ id: validSnapshot.id, entries: [] });
      transaction.objectStore('manifests').put({
        id: validSnapshot.id,
        seed: validSnapshot.seed,
        player: validSnapshot.player,
        sectionIds: sections.map((section) => section.id),
      } satisfies StoredManifest);
      transaction.objectStore('meta').put({ key: CURRENT_MANIFEST_KEY, value: validSnapshot.id });
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async loadCurrent(): Promise<WorldSnapshot | null> {
    const database = await this.open();
    try {
      const pointer = await readRecord<Readonly<{ value?: unknown }>>(database, 'meta', CURRENT_MANIFEST_KEY);
      if (!pointer || typeof pointer.value !== 'string') return null;
      const manifest = await readRecord<StoredManifest>(database, 'manifests', pointer.value);
      if (!isStoredManifest(manifest)) return null;

      const sections = await Promise.all(manifest.sectionIds.map((id) => readRecord<StoredSection>(database, 'sections', id)));
      const validSections = sections.filter(isStoredSection);
      if (validSections.length !== sections.length) return null;
      const edits = validSections.flatMap((section) => section.edits).sort((left, right) => left.index - right.index).map((entry) => entry.edit);
      try {
        return validateSnapshot({ id: manifest.id, seed: manifest.seed, player: manifest.player, edits });
      } catch {
        return null;
      }
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
      request.onerror = () => reject(request.error ?? new Error('Unable to open snapshot database'));
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('sections')) database.createObjectStore('sections', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('entities')) database.createObjectStore('entities', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('manifests')) database.createObjectStore('manifests', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
}

function serializeSections(snapshot: WorldSnapshot): readonly StoredSection[] {
  const bySection = new Map<string, Array<Readonly<{ index: number; edit: BlockEdit }>>>();
  snapshot.edits.forEach((edit, index) => {
    const key = `${Math.floor(edit.pos.x / 16)},${Math.floor(edit.pos.y / 16)},${Math.floor(edit.pos.z / 16)}`;
    const entries = bySection.get(key) ?? [];
    entries.push({ index, edit });
    bySection.set(key, entries);
  });
  return [...bySection].map(([key, edits]) => ({ id: `${snapshot.id}:${key}`, edits }));
}

function validateSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  if (!isRecord(snapshot) || typeof snapshot.id !== 'string' || snapshot.id.length === 0) throw new Error('Invalid snapshot id');
  if (!isFiniteNumber(snapshot.seed)) throw new Error('Invalid snapshot seed');
  const player = validatePlayer(snapshot.player);
  if (!Array.isArray(snapshot.edits)) throw new Error('Invalid snapshot edits');
  const edits = snapshot.edits.map(validateEdit);
  return Object.freeze({ id: snapshot.id, seed: snapshot.seed, player, edits: Object.freeze(edits) });
}

function validatePlayer(player: unknown): PlayerSnapshot {
  if (!isRecord(player) || !isFiniteNumber(player.x) || !isFiniteNumber(player.y) || !isFiniteNumber(player.z)
    || !isFiniteNumber(player.pitch) || !isFiniteNumber(player.yaw)) throw new Error('Invalid snapshot player');
  return Object.freeze({ x: player.x, y: player.y, z: player.z, pitch: player.pitch, yaw: player.yaw });
}

function validateEdit(edit: unknown): BlockEdit {
  if (!isRecord(edit) || !isRecord(edit.pos) || !isFiniteInteger(edit.pos.x) || !isFiniteInteger(edit.pos.y)
    || !isFiniteInteger(edit.pos.z) || !isFiniteInteger(edit.blockId)) throw new Error('Invalid snapshot edit');
  try {
    blockById(edit.blockId);
  } catch {
    throw new Error('Invalid snapshot block id');
  }
  if (edit.orientation !== undefined && (!isFiniteInteger(edit.orientation) || edit.orientation < 0 || edit.orientation > 3)) {
    throw new Error('Invalid snapshot orientation');
  }
  return Object.freeze({
    pos: Object.freeze({ x: edit.pos.x, y: edit.pos.y, z: edit.pos.z }),
    blockId: edit.blockId,
    ...(edit.orientation === undefined ? {} : { orientation: edit.orientation }),
  });
}

function isStoredManifest(value: unknown): value is StoredManifest {
  return isRecord(value) && typeof value.id === 'string' && isFiniteNumber(value.seed) && isRecord(value.player)
    && Array.isArray(value.sectionIds) && value.sectionIds.every((id) => typeof id === 'string');
}

function isStoredSection(value: unknown): value is StoredSection {
  return isRecord(value) && typeof value.id === 'string' && Array.isArray(value.edits)
    && value.edits.every((entry) => isRecord(entry) && isFiniteInteger(entry.index) && isRecord(entry.edit));
}

async function readRecord<T>(database: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const transaction = database.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).get(key) as IDBRequest<T | undefined>;
  const value = await requestValue(request);
  await transactionDone(transaction);
  return value;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Snapshot database request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Snapshot transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Snapshot transaction aborted'));
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
