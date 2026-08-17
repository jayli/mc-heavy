import type { GameApp } from '../app/main';
import { PLAYER_WALK_SPEED } from '../gameplay/player-controller';
import { FrameMetrics } from './frame-metrics';

export type PathLeg = Readonly<{ x: number; z: number }>;

export type BenchmarkPath = Readonly<{
  legDurationMs: number;
  speedBlocksPerSecond: number;
  totalDistanceBlocks: number;
  legs: readonly PathLeg[];
}>;

export type BenchmarkReport = Readonly<{
  seed: number;
  path: BenchmarkPath;
  averageFps: number;
  p95FrameMs: number;
  p99FrameMs: number;
  onePercentLowFps: number;
  frames: number;
}>;

// Four equal legs of 75 s at 4 blocks/s walk 300 blocks each for a 1200-block
// path that crosses five 256-block supercells, biome boundaries, and structures.
const PATH_LEG_DURATION_MS = 75_000;
const pathDirections = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
] as const;

export const benchmarkPath: BenchmarkPath = Object.freeze({
  legDurationMs: PATH_LEG_DURATION_MS,
  speedBlocksPerSecond: PLAYER_WALK_SPEED,
  totalDistanceBlocks: PLAYER_WALK_SPEED * (PATH_LEG_DURATION_MS / 1_000) * pathDirections.length,
  legs: Object.freeze(pathDirections.map((leg) => Object.freeze({ ...leg }))),
});

export async function runBenchmarkPath(game: GameApp, durationMs: number): Promise<BenchmarkReport> {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('Benchmark duration must be a finite, non-negative number');
  }

  const metrics = new FrameMetrics();
  let startTimestampMs: number | undefined;
  let previousTimestampMs: number | undefined;

  return new Promise((resolve) => {
    const advance = (timestampMs: number): void => {
      if (startTimestampMs === undefined) startTimestampMs = timestampMs;
      metrics.recordFrame(timestampMs);
      const elapsedMs = timestampMs - startTimestampMs;

      if (previousTimestampMs !== undefined) {
        const deltaSeconds = Math.min(50, timestampMs - previousTimestampMs) / 1_000;
        const leg = Math.floor(elapsedMs / PATH_LEG_DURATION_MS) % pathDirections.length;
        game.player.step(pathDirections[leg], deltaSeconds);
      }
      previousTimestampMs = timestampMs;

      if (elapsedMs < durationMs) {
        requestAnimationFrame(advance);
        return;
      }

      const summary = metrics.summary();
      resolve(Object.freeze({
        seed: game.seed,
        path: benchmarkPath,
        averageFps: summary.averageFps,
        p95FrameMs: summary.p95FrameMs,
        p99FrameMs: summary.p99FrameMs,
        onePercentLowFps: summary.onePercentLowFps,
        frames: summary.frames,
      }));
    };
    requestAnimationFrame(advance);
  });
}
