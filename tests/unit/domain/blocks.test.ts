import { describe, expect, it } from 'vitest';
import { blockById, blockByKey, blockRegistry } from '../../../src/domain/blocks';
import { textureTileId } from '../../../src/domain/texture-tiles';

describe('block registry', () => {
  it('keeps water non-solid and translucent while stone is opaque and solid', () => {
    expect(blockByKey('water')).toMatchObject({ id: 3, solid: false, renderClass: 'translucent' });
    expect(blockByKey('stone')).toMatchObject({ id: 1, solid: true, renderClass: 'opaque' });
  });

  it('supports lookup by id and rejects unknown keys', () => {
    expect(blockById(0)).toMatchObject({ id: 0, key: 'air', solid: false, renderClass: 'none', orientation: false });
    expect(() => blockByKey('unknown')).toThrow('Unknown block key: unknown');
  });
});

describe('block registry content', () => {
  it('keeps ids 0..7 stable and resolves the legacy glass_block alias', () => {
    expect(blockByKey('air').id).toBe(0);
    expect(blockByKey('glass').id).toBe(7);
    expect(blockByKey('glass_block').id).toBe(7);
  });

  it('marks chest as an oriented cutout cube and tnt as opaque', () => {
    expect(blockByKey('chest')).toMatchObject({
      solid: true,
      renderClass: 'cutout',
      geometryType: 'cube',
      orientation: true,
    });
    expect(blockByKey('tnt')).toMatchObject({ solid: true, renderClass: 'opaque', geometryType: 'cube' });
  });

  it('treats only opaque cubes as full occluders', () => {
    expect(blockRegistry.isFullOccluder(blockByKey('stone').id)).toBe(true);
    expect(blockRegistry.isFullOccluder(blockByKey('leaves').id)).toBe(false);
    expect(blockRegistry.isFullOccluder(blockByKey('bed_head').id)).toBe(false);
  });

  it('selects the front face tile from chest orientation', () => {
    const chest = blockByKey('chest').id;
    const front = blockRegistry.tileForFace(chest, 0, 0);
    expect(front).toBe(textureTileId('box_face.png'));
    expect(blockRegistry.tileForFace(chest, 0, 0)).toBe(front);
    expect(blockRegistry.tileForFace(chest, 2, 0)).not.toBe(front);
    expect(blockRegistry.tileForFace(chest, 1, 2)).toBe(front);
  });

  it('maps every mc-lite world block key without throwing', () => {
    for (const key of [
      'planks_step', 'cobblestone_step', 'cobblestone_step_updown', 'stone_diorite_step',
      'handrail', 'handrailA', 'handrailB', 'vertical_pillar', 'horizontal_pillar',
      'hanging_lamp', 'bed_head', 'bed_tail', 'sand_train_track', 'sand_train_track_corner',
      'glowstone', 'ochre_froglight', 'lava', 'deepslate_diamond_ore', 'bookbox',
    ]) {
      expect(() => blockByKey(key)).not.toThrow();
    }
  });
});
