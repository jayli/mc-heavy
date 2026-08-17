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

  cancel(key: string, epoch: number): void {
    this.tombstones.add(cancellationKey(key, epoch));
  }

  take(): WorkRequest | null {
    while (this.entries.length > 0) {
      let selectedIndex = 0;
      for (let index = 1; index < this.entries.length; index += 1) {
        if (this.precedes(this.entries[index], this.entries[selectedIndex])) selectedIndex = index;
      }
      const [entry] = this.entries.splice(selectedIndex, 1);
      if (!this.tombstones.has(cancellationKey(entry.request.key, entry.request.epoch))) return entry.request;
    }
    return null;
  }

  private precedes(candidate: QueueEntry, current: QueueEntry): boolean {
    return (
      candidate.request.priority > current.request.priority ||
      (candidate.request.priority === current.request.priority && candidate.sequence < current.sequence)
    );
  }
}
