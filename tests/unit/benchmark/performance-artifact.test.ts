import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginPerformanceArtifact,
  writePerformanceArtifact,
} from '../../support/performance-artifact';

it('removes a stale report before a run and stamps only the completed run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mc-heavy-perf-'));
  const path = join(directory, 'playable-core.json');
  try {
    await writeFile(path, '{"frames":999999}\n', 'utf8');

    const run = await beginPerformanceArtifact(path, '2026-08-18T00:00:00.000Z');

    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await writePerformanceArtifact(path, run, 'webgpu', 300_000, {
      seed: 0x5eed1234,
      path: {
        legDurationMs: 75_000,
        speedBlocksPerSecond: 4,
        totalDistanceBlocks: 1_200,
        legs: [
          { x: 1, z: 0 },
          { x: 0, z: 1 },
          { x: -1, z: 0 },
          { x: 0, z: -1 },
        ],
      },
      frames: 36_000,
      averageFps: 118.2,
      p95FrameMs: 9.1,
      onePercentLowFps: 96.5,
      p99FrameMs: 10.2,
    }, '2026-08-18T00:05:00.000Z');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      runStartedAt: '2026-08-18T00:00:00.000Z',
      completedAt: '2026-08-18T00:05:00.000Z',
      backend: 'webgpu',
      durationMs: 300_000,
      seed: 0x5eed1234,
      path: {
        legDurationMs: 75_000,
        speedBlocksPerSecond: 4,
        totalDistanceBlocks: 1_200,
        legs: [
          { x: 1, z: 0 },
          { x: 0, z: 1 },
          { x: -1, z: 0 },
          { x: 0, z: -1 },
        ],
      },
      frames: 36_000,
      averageFps: 118.2,
      p95FrameMs: 9.1,
      onePercentLowFps: 96.5,
      p99FrameMs: 10.2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
