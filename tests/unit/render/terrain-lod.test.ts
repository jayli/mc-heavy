import { describe, expect, it } from 'vitest';
import { TerrainLod } from '../../../src/render/terrain-lod';
import { WaterSurface } from '../../../src/render/water';

describe('TerrainLod', () => {
  it('keeps a finite set of ring resources centered on the moving camera', () => {
    const lod = new TerrainLod();
    const initial = lod.diagnostics();

    lod.update({ x: 64, z: -32 });
    const moved = lod.diagnostics();

    expect(initial.center).toEqual({ x: 0, z: 0 });
    expect(initial.ringCount).toBeGreaterThan(0);
    expect(initial.ringCount).toBeLessThanOrEqual(8);
    expect(moved.center).toEqual({ x: 64, z: -32 });
    expect(moved.ringCount).toBe(initial.ringCount);
    expect(moved.geometryIds).toEqual(initial.geometryIds);
    lod.dispose();
  });
});

describe('WaterSurface', () => {
  it('updates camera following position and time without recreating geometry', () => {
    const water = new WaterSurface();
    const geometry = water.geometry;

    water.update({ x: 64, z: -32 }, 1_500);

    expect(water.geometry).toBe(geometry);
    expect(water.diagnostics()).toMatchObject({
      position: { x: 64, z: -32 },
      timeMs: 1_500,
    });
    water.dispose();
  });
});
