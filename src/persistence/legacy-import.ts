import { blockByKey } from '../domain/blocks';
import type { BlockEdit } from '../world/world-query';

export type LegacyImportReport = Readonly<{
  importedBlocks: number;
  preservedEntries: number;
  warnings: readonly string[];
}>;

export type PlayerSnapshot = Readonly<{
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
}>;

export const LEGACY_SAME_ORIGIN_GUIDANCE = '请从同一协议、主机和端口启动，或选择 JSON 文件';

type LegacyChunk = Readonly<{
  key: string;
  blocks?: Record<string, unknown>;
  entities?: unknown;
}>;

type ParsedLegacySnapshot = Readonly<{
  player: PlayerSnapshot;
  seed: number;
  edits: readonly BlockEdit[];
  report: LegacyImportReport;
}>;

export function parseLegacySnapshot(input: unknown): ParsedLegacySnapshot {
  if (!isRecord(input) || !('player' in input) || !Array.isArray(input.worldDeltas)) {
    throw new Error('Legacy save is missing player or worldDeltas');
  }

  const player = parsePlayer(input.player);
  if (!isFiniteNumber(input.seed)) throw new Error('Legacy save has an invalid seed');

  const edits: BlockEdit[] = [];
  const warnings: string[] = [];
  let preservedEntries = 0;

  for (const rawChunk of input.worldDeltas) {
    const chunk = parseChunk(rawChunk);
    const blocks = chunk.blocks ?? {};
    for (const [key, entry] of Object.entries(blocks)) {
      const position = decodeLegacyPosition(key);
      if (!position) {
        preservedEntries += 1;
        warnings.push(`Preserved block with invalid coordinate "${key}" in chunk "${chunk.key}"`);
        continue;
      }

      const parsedEntry = parseBlockEntry(entry);
      if (!parsedEntry) {
        preservedEntries += 1;
        warnings.push(`Preserved invalid block entry at ${position.x},${position.y},${position.z}`);
        continue;
      }

      try {
        const block = blockByKey(parsedEntry.type);
        edits.push(Object.freeze({
          pos: Object.freeze(position),
          blockId: block.id,
          ...(block.orientation ? { orientation: parsedEntry.orientation } : {}),
        }));
      } catch {
        preservedEntries += 1;
        warnings.push(`Preserved unknown block "${parsedEntry.type}" at ${position.x},${position.y},${position.z}`);
      }
    }

    const entityCount = countEntries(chunk.entities);
    if (entityCount > 0) {
      preservedEntries += entityCount;
      warnings.push(`Preserved ${entityCount} unsupported entities in chunk "${chunk.key}"`);
    }
  }

  return Object.freeze({
    player,
    seed: input.seed,
    edits: Object.freeze(edits),
    report: Object.freeze({
      importedBlocks: edits.length,
      preservedEntries,
      warnings: Object.freeze(warnings),
    }),
  });
}

export async function importFromLegacyIndexedDb(indexedDb: IDBFactory): Promise<ParsedLegacySnapshot | null> {
  const database = await openLegacyDatabase(indexedDb);
  try {
    if (!database.objectStoreNames.contains('snapshots')) return null;
    const transaction = database.transaction('snapshots', 'readonly');
    const request = transaction.objectStore('snapshots').get('latest');
    const snapshot = await requestValue(request);
    await transactionDone(transaction);
    return snapshot === undefined ? null : parseLegacySnapshot(snapshot);
  } finally {
    database.close();
  }
}

function parsePlayer(value: unknown): PlayerSnapshot {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.z)
    || !isFiniteNumber(value.pitch) || !isFiniteNumber(value.yaw)) {
    throw new Error('Legacy save has an invalid player');
  }
  return Object.freeze({ x: value.x, y: value.y, z: value.z, pitch: value.pitch, yaw: value.yaw });
}

function parseChunk(value: unknown): LegacyChunk {
  if (!isRecord(value) || typeof value.key !== 'string') throw new Error('Legacy save has an invalid world delta');
  if (value.blocks !== undefined && !isRecord(value.blocks)) throw new Error('Legacy save has invalid blocks');
  return { key: value.key, blocks: value.blocks, entities: value.entities };
}

function parseBlockEntry(value: unknown): Readonly<{ type: string; orientation: number }> | null {
  if (typeof value === 'string') return { type: value, orientation: 0 };
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  return { type: value.type, orientation: validOrientation(value.orientation) ? value.orientation : 0 };
}

function decodeLegacyPosition(key: string): Readonly<{ x: number; y: number; z: number }> | null {
  const coordinates = key.match(/^(-?\d+),(-?\d+),(-?\d+)$/);
  if (coordinates) {
    const x = Number(coordinates[1]);
    const y = Number(coordinates[2]);
    const z = Number(coordinates[3]);
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) && Number.isSafeInteger(z)
      ? Object.freeze({ x, y, z })
      : null;
  }

  const code = Number(key);
  if (!Number.isSafeInteger(code)) return null;
  const z = (code % 2_000_001) - 1_000_000;
  const remainder = Math.floor(code / 2_000_001);
  const y = (remainder % 2049) - 512;
  const x = Math.floor(remainder / 2049) - 1_000_000;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)
    || x < -1_000_000 || x > 1_000_000 || y < -512 || y > 512 || z < -1_000_000 || z > 1_000_000) return null;
  const encoded = ((x + 1_000_000) * 2049 + (y + 512)) * 2_000_001 + (z + 1_000_000);
  return encoded === code ? Object.freeze({ x, y, z }) : null;
}

function countEntries(value: unknown): number {
  if (!isRecord(value)) return 0;
  return Object.values(value).reduce<number>((count, entry) => count + (Array.isArray(entry) ? entry.length : 1), 0);
}

function validOrientation(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openLegacyDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open('mc_lite_manual_saves');
    } catch {
      reject(new Error(LEGACY_SAME_ORIGIN_GUIDANCE));
      return;
    }
    request.onerror = () => reject(new Error(LEGACY_SAME_ORIGIN_GUIDANCE));
    request.onsuccess = () => resolve(request.result);
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to read legacy save'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to read legacy save'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Unable to read legacy save'));
  });
}
