import { blockById } from '../domain/blocks';

export class Inventory {
  private readonly counts = new Map<number, number>();
  private selectedBlockId: number | null = null;

  add(blockId: number, count: number): void {
    blockById(blockId);
    validateCount(count);

    this.counts.set(blockId, (this.counts.get(blockId) ?? 0) + count);
    if (this.selectedBlockId === null) this.selectedBlockId = blockId;
  }

  remove(blockId: number, count: number): boolean {
    blockById(blockId);
    validateCount(count);

    const current = this.counts.get(blockId) ?? 0;
    if (current < count) return false;

    if (current === count) {
      this.counts.delete(blockId);
      if (this.selectedBlockId === blockId) {
        this.selectedBlockId = this.counts.keys().next().value ?? null;
      }
    } else {
      this.counts.set(blockId, current - count);
    }
    return true;
  }

  selected(): Readonly<{ blockId: number; count: number }> | null {
    if (this.selectedBlockId === null) return null;
    const count = this.counts.get(this.selectedBlockId);
    if (count === undefined) return null;
    return Object.freeze({ blockId: this.selectedBlockId, count });
  }
}

const validateCount = (count: number): void => {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Inventory count must be a positive integer');
  }
};
