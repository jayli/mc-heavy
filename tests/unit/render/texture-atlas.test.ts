import { describe, expect, it } from 'vitest';
import { packTextureAtlas, type TileInput } from '../../../src/render/texture-atlas';

function tile(rgba: readonly number[]): TileInput {
  const pixels = new Uint8ClampedArray(16);
  for (let offset = 0; offset < 4; offset += 1) pixels.set(rgba, offset * 4);
  return { width: 2, height: 2, rgba: pixels };
}

describe('packTextureAtlas', () => {
  it('lays tiles out on a column-major grid and falls back to magenta', () => {
    const packed = packTextureAtlas(
      [tile([255, 0, 0, 255]), tile([0, 255, 0, 255]), tile([0, 0, 255, 255])],
      new Uint8Array([0, 255, 128]),
      2,
      2,
    );

    expect(packed.columns).toBe(2);
    expect(packed.rows).toBe(2);
    expect(packed.tileSize).toBe(2);
    expect(packed.pixels.length).toBe(4 * 4 * 4);
    expect([...packed.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...packed.pixels.subarray(8, 12)]).toEqual([0, 255, 0, 255]);
    // 第三个 tile 落在第二行第一列：y=2。
    const secondRow = 2 * 2 * 2 * 4;
    expect([...packed.pixels.subarray(secondRow, secondRow + 4)]).toEqual([0, 0, 255, 255]);
    expect([...packed.emissive]).toEqual([0, 255, 128]);
  });

  it('fills a missing tile with magenta and preserves emissive', () => {
    const packed = packTextureAtlas(
      [{ width: 2, height: 2 }],
      new Uint8Array([200]),
      1,
      2,
    );

    expect([...packed.pixels.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
    expect([...packed.emissive]).toEqual([200]);
  });
});
