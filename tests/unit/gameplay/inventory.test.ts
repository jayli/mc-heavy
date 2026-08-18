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

    expect(() => inventory.add(9_999, 1)).toThrow('Unknown block id: 9999');
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

  it('lists stone, grass, sand, wood and glass in insertion order with selection', () => {
    const inventory = new Inventory();
    inventory.add(1, 1);
    inventory.add(2, 1);
    inventory.add(4, 1);
    inventory.add(5, 1);
    inventory.add(7, 1);

    expect(inventory.slots()).toEqual([
      { blockId: 1, count: 1 },
      { blockId: 2, count: 1 },
      { blockId: 4, count: 1 },
      { blockId: 5, count: 1 },
      { blockId: 7, count: 1 },
    ]);
    expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
    expect(inventory.select(4)).toBe(true);
    expect(inventory.selected()).toEqual({ blockId: 4, count: 1 });
    expect(inventory.select(99)).toBe(false);
    expect(inventory.selected()).toEqual({ blockId: 4, count: 1 });
  });

  it('selects by slot index and cycles next and previous with wrapping', () => {
    const inventory = new Inventory();
    inventory.add(1, 1);
    inventory.add(2, 1);
    inventory.add(4, 1);

    expect(inventory.selectSlot(2)).toBe(true);
    expect(inventory.selected()).toEqual({ blockId: 4, count: 1 });
    inventory.selectNext();
    expect(inventory.selected()).toEqual({ blockId: 1, count: 1 });
    inventory.selectPrevious();
    expect(inventory.selected()).toEqual({ blockId: 4, count: 1 });

    expect(inventory.selectSlot(3)).toBe(false);
    expect(inventory.selectSlot(-1)).toBe(false);
    expect(inventory.selectSlot(1.5)).toBe(false);
    expect(inventory.selected()).toEqual({ blockId: 4, count: 1 });
  });
});
