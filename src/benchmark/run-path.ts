import type { GameApp } from '../app/main';
import { FrameMetrics } from './frame-metrics';

export type BenchmarkReport = Readonly<{
  onePercentLowFps: number;
  p99FrameMs: number;
  frames: number;
}>;

const PATH_LEG_DURATION_MS = 5_000;
const pathDirections = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
] as const;

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
        onePercentLowFps: summary.onePercentLowFps,
        p99FrameMs: summary.p99FrameMs,
        frames: summary.frames,
      }));
    };
    requestAnimationFrame(advance);
  });
}
