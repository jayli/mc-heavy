import { describe, expect, it } from 'vitest';
import { PriorityWorkQueue } from '../../../src/streaming/priority-queue';

describe('PriorityWorkQueue', () => {
  it('consumes a cancellation tombstone with its queued request', () => {
    const queue = new PriorityWorkQueue();
    queue.enqueue({ key: 'cancelled', epoch: 1, priority: 1, editVersion: 0, kind: 'generate' });
    queue.cancel('cancelled', 1);

    expect(queue.take()).toBeNull();
    expect(queue.diagnostics()).toEqual({ queuedWork: 0, tombstones: 0 });
  });

  it('takes the forward high-priority request before a farther side request', () => {
    const queue = new PriorityWorkQueue();
    queue.enqueue({ key: 'forward', epoch: 1, priority: 100, editVersion: 0, kind: 'generate' });
    queue.enqueue({ key: 'side', epoch: 1, priority: 10, editVersion: 0, kind: 'generate' });

    expect(queue.take()?.key).toBe('forward');
  });

  it('keeps insertion order for requests with equal priority', () => {
    const queue = new PriorityWorkQueue();
    queue.enqueue({ key: 'first', epoch: 1, priority: 10, editVersion: 0, kind: 'generate' });
    queue.enqueue({ key: 'second', epoch: 1, priority: 10, editVersion: 0, kind: 'generate' });

    expect(queue.take()?.key).toBe('first');
    expect(queue.take()?.key).toBe('second');
  });

  it('skips a cancelled epoch without cancelling a later epoch for the same key', () => {
    const queue = new PriorityWorkQueue();
    queue.enqueue({ key: '0,0,0', epoch: 1, priority: 100, editVersion: 0, kind: 'generate' });
    queue.enqueue({ key: '0,0,0', epoch: 2, priority: 10, editVersion: 0, kind: 'generate' });
    queue.cancel('0,0,0', 1);

    expect(queue.take()).toMatchObject({ key: '0,0,0', epoch: 2 });
    expect(queue.take()).toBeNull();
  });
});
