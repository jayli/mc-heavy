export type FrameMetricsSummary = Readonly<{
  frames: number;
  averageFps: number;
  onePercentLowFps: number;
  p95FrameMs: number;
  p99FrameMs: number;
}>;

const EMPTY_SUMMARY: FrameMetricsSummary = Object.freeze({
  frames: 0,
  averageFps: 0,
  onePercentLowFps: 0,
  p95FrameMs: 0,
  p99FrameMs: 0,
});

export class FrameMetrics {
  private previousTimestampMs: number | undefined;
  private readonly frameDurationsMs: number[] = [];

  recordFrame(timestampMs: number): void {
    if (this.previousTimestampMs !== undefined) {
      this.frameDurationsMs.push(timestampMs - this.previousTimestampMs);
    }
    this.previousTimestampMs = timestampMs;
  }

  summary(): FrameMetricsSummary {
    const frames = this.frameDurationsMs.length;
    if (frames === 0) return EMPTY_SUMMARY;

    const ascending = [...this.frameDurationsMs].sort((left, right) => left - right);
    const elapsedMs = this.frameDurationsMs.reduce((sum, duration) => sum + duration, 0);
    const onePercentFrameCount = Math.max(1, Math.ceil(frames * 0.01));
    const slowestFrames = ascending.slice(-onePercentFrameCount);
    const slowestElapsedMs = slowestFrames.reduce((sum, duration) => sum + duration, 0);

    return Object.freeze({
      frames,
      averageFps: (frames * 1_000) / elapsedMs,
      onePercentLowFps: (onePercentFrameCount * 1_000) / slowestElapsedMs,
      p95FrameMs: nearestRank(ascending, 0.95),
      p99FrameMs: nearestRank(ascending, 0.99),
    });
  }
}

function nearestRank(ascendingValues: readonly number[], percentile: number): number {
  const rank = Math.ceil(ascendingValues.length * percentile);
  return ascendingValues[rank - 1];
}
