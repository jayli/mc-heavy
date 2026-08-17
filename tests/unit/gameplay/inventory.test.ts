import { describe, expect, it } from 'vitest';
import { Inventory } from '../../../src/gameplay/inventory';

describe('Inventory', () => {
  it('keeps the first added stack selected and returns an immutable snapshot', () => {
    const inventory = new Inventory();

    inventory.add(5, 2);
    inventory.add(1, 3);
    const selected = inventory.selected();

    expect(selected).toEqual({ blockId: 5, count: 2 });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it('rejects unknown blocks and non-positive or fractional add counts', () => {
    const inventory = new Inventory();

    expect(() => inventory.add(99, 1)).toThrow('Unknown block id: 99');
    expect(() => inventory.add(1, 0)).toThrow('positive integer');
    expect(() => inventory.add(1, 1.5)).toThrow('positive integer');
    expect(inventory.selected()).toBeNull();
  });

  it('does not decrement a stack when removal requests more than it holds', () => {
    const inventory = new Inventory();
    inventory.add(1, 1);

    expect(inventory.remove(1, 2)).toBe(false);
    expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
  });
});
