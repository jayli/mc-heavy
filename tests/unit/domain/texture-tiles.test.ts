import { describe, expect, it } from 'vitest';
import { TILE_COUNT, syntheticTileId, textureTileId, textureTileName, tileSpec } from '../../../src/domain/texture-tiles';

describe('texture tiles', () => {
  it('assigns a stable id to every known texture and round-trips names', () => {
    expect(TILE_COUNT).toBeGreaterThanOrEqual(122);
    const id = textureTileId('stone.png');
    expect(textureTileId('stone.png')).toBe(id);
    expect(textureTileName(id)).toBe('stone.png');
    expect(tileSpec(id)).toEqual({ kind: 'file', name: 'stone.png' });
  });

  it('assigns synthetic color and draw tiles after file tiles', () => {
    const water = syntheticTileId('color:#205099');
    expect(water).toBeGreaterThanOrEqual(textureTileId('zombie_nest_alias_block.png'));
    expect(tileSpec(water)).toEqual({
      kind: 'synthetic',
      spec: { key: 'color:#205099', color: '#205099' },
    });
    expect(tileSpec(syntheticTileId('draw:flower'))).toMatchObject({
      kind: 'synthetic',
      spec: { draw: 'flower' },
    });
  });

  it('rejects unknown texture names', () => {
    expect(() => textureTileId('missing.png')).toThrow('Unknown texture: missing.png');
    expect(() => syntheticTileId('color:#000000')).toThrow('Unknown synthetic tile: color:#000000');
  });
});
