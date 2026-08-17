import { describe, expect, it } from 'vitest';
import { parseLegacySnapshot } from '../../../src/persistence/legacy-import';

describe('parseLegacySnapshot', () => {
  it('converts a legacy string coordinate and oriented entry into a block edit', () => {
    const result = parseLegacySnapshot({
      player: { x: 1, y: 2, z: 3, pitch: 0, yaw: 0 },
      seed: 7,
      worldDeltas: [{
        key: '0,0',
        blocks: { '1,2,3': { type: 'wood', orientation: 2 } },
        entities: {},
      }],
    });

    expect(result.edits).toEqual([{ pos: { x: 1, y: 2, z: 3 }, blockId: 5, orientation: 2 }]);
    expect(result.report).toEqual({ importedBlocks: 1, preservedEntries: 0, warnings: [] });
  });

  it('decodes a numeric legacy coordinate and defaults a string entry orientation', () => {
    const legacyCode = ((1_000_004 * 2049) + 510) * 2_000_001 + 999_994;
    const result = parseLegacySnapshot({
      player: { x: 0, y: 1, z: 2, pitch: 0, yaw: 0 },
      seed: 3,
      worldDeltas: [{ key: '0,0', blocks: { [legacyCode]: 'wood' }, entities: {} }],
    });

    expect(result.edits).toEqual([{ pos: { x: 4, y: -2, z: -6 }, blockId: 5, orientation: 0 }]);
  });

  it('preserves unsupported blocks and entities in its exact report', () => {
    const result = parseLegacySnapshot({
      player: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 },
      seed: 9,
      worldDeltas: [{
        key: '0,0',
        blocks: { '1,2,3': 'future_block' },
        entities: { zombie: { id: 'z-1' }, carts: [{ id: 'c-1' }, { id: 'c-2' }] },
      }],
    });

    expect(result.edits).toEqual([]);
    expect(result.report).toEqual({
      importedBlocks: 0,
      preservedEntries: 4,
      warnings: [
        'Preserved unknown block "future_block" at 1,2,3',
        'Preserved 3 unsupported entities in chunk "0,0"',
      ],
    });
  });

  it('does not import a block whose legacy string coordinate is outside the safe integer range', () => {
    const result = parseLegacySnapshot({
      player: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 },
      seed: 9,
      worldDeltas: [{ key: '0,0', blocks: { '999999999999999999999,2,3': 'stone' }, entities: {} }],
    });

    expect(result).toMatchObject({
      edits: [],
      report: { importedBlocks: 0, preservedEntries: 1 },
    });
  });

  it('rejects the known empty Promise-shaped mc-lite export instead of claiming success', () => {
    expect(() => parseLegacySnapshot({ version: '1.0', exportedAt: '2026-08-17T00:00:00Z' }))
      .toThrow('Legacy save is missing player or worldDeltas');
  });
});
