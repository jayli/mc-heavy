import { describe, expect, it } from 'vitest';
import { benchmarkPath } from '../../../src/benchmark/run-path';

describe('benchmarkPath descriptor', () => {
  it('describes four equal 75-second legs walking 1200 blocks at 4 blocks/s', () => {
    expect(benchmarkPath).toEqual({
      legDurationMs: 75_000,
      speedBlocksPerSecond: 4,
      totalDistanceBlocks: 1_200,
      legs: [
        { x: 1, z: 0 },
        { x: 0, z: 1 },
        { x: -1, z: 0 },
        { x: 0, z: -1 },
      ],
    });
  });
});
