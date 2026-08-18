import { describe, expect, it } from 'vitest';
import { computeCornerAo } from '../../../src/meshing/ao';

describe('computeCornerAo', () => {
  it('returns 0 in an enclosed corner and 3 in an open corner', () => {
    expect(computeCornerAo(true, true, true)).toBe(0);
    expect(computeCornerAo(false, false, false)).toBe(3);
  });

  it('deducts one for each occluding side or corner', () => {
    expect(computeCornerAo(true, false, false)).toBe(2);
    expect(computeCornerAo(true, false, true)).toBe(1);
    expect(computeCornerAo(false, true, true)).toBe(1);
    expect(computeCornerAo(true, true, false)).toBe(0);
  });
});
