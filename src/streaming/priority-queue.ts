import type { WorkRequest } from '../workers/protocol';

type QueueEntry = Readonly<{ request: WorkRequest; sequence: number }>;

function cancellationKey(key: string, epoch: number): string {
  return `${key}\u0000${epoch}`;
}

export class PriorityWorkQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly tombstones = new Set<string>();
  private nextSequence = 0;

  enqueue(request: WorkRequest): void {
    this.entries.push({ request, sequence: this.nextSequence });
    this.nextSequence += 1;
  }

  updatePriority(key: string, epoch: number, priority: number): boolean {
    const index = this.entries.findIndex((entry) => entry.request.key === key && entry.request.epoch === epoch);
    if (index < 0) return false;
    const entry = this.entries[index];
    this.entries[index] = {
      sequence: entry.sequence,
      request: { ...entry.request, priority },
    };
    return true;
  }

  cancel(key: string, epoch: number): void {
    if (this.entries.some((entry) => entry.request.key === key && entry.request.epoch === epoch)) {
      this.tombstones.add(cancellationKey(key, epoch));
    }
  }

  take(): WorkRequest | null {
    while (this.entries.length > 0) {
      let selectedIndex = 0;
      for (let index = 1; index < this.entries.length; index += 1) {
        if (this.precedes(this.entries[index], this.entries[selectedIndex])) selectedIndex = index;
      }
      const [entry] = this.entries.splice(selectedIndex, 1);
      const key = cancellationKey(entry.request.key, entry.request.epoch);
      if (!this.tombstones.delete(key)) return entry.request;
    }
    return null;
  }

  clear(): void {
    this.entries.length = 0;
    this.tombstones.clear();
    this.nextSequence = 0;
  }

  diagnostics(): Readonly<{ queuedWork: number; tombstones: number }> {
    return { queuedWork: this.entries.length, tombstones: this.tombstones.size };
  }

  private precedes(candidate: QueueEntry, current: QueueEntry): boolean {
    return (
      candidate.request.priority > current.request.priority ||
      (candidate.request.priority === current.request.priority && candidate.sequence < current.sequence)
    );
  }
}
