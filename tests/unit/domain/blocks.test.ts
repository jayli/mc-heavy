import { describe, expect, it } from 'vitest';
import { blockByKey, blockById } from '../../../src/domain/blocks';

describe('block registry', () => {
  it('keeps water non-solid and translucent while stone is opaque and solid', () => {
    expect(blockByKey('water')).toMatchObject({ id: 3, solid: false, renderClass: 'translucent' });
    expect(blockByKey('stone')).toMatchObject({ id: 1, solid: true, renderClass: 'opaque' });
  });

  it('supports lookup by id and rejects unknown keys', () => {
    expect(blockById(0)).toEqual({ id: 0, key: 'air', solid: false, renderClass: 'none', orientation: false });
    expect(() => blockByKey('unknown')).toThrow('Unknown block key: unknown');
  });
});
