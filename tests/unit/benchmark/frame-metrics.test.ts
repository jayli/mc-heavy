import { describe, expect, it } from 'vitest';
import { FrameMetrics } from '../../../src/benchmark/frame-metrics';

describe('FrameMetrics', () => {
  it('reports the hand-calculated 1% low from 100 completed frames', () => {
    const metrics = new FrameMetrics();
    metrics.recordFrame(0);
    for (let i = 1; i <= 99; i += 1) metrics.recordFrame(i * 10);
    metrics.recordFrame(1_200);

    const summary = metrics.summary();
    expect(summary.frames).toBe(100);
    expect(summary.averageFps).toBeCloseTo(83.3333333333, 8);
    expect(summary.onePercentLowFps).toBeCloseTo(4.7619047619, 5);
  });

  it('treats the first timestamp as a baseline rather than a completed frame', () => {
    const metrics = new FrameMetrics();

    metrics.recordFrame(500);
    expect(metrics.summary()).toEqual({
      frames: 0,
      averageFps: 0,
      onePercentLowFps: 0,
      p95FrameMs: 0,
      p99FrameMs: 0,
    });

    metrics.recordFrame(508);
    expect(metrics.summary()).toEqual({
      frames: 1,
      averageFps: 125,
      onePercentLowFps: 125,
      p95FrameMs: 8,
      p99FrameMs: 8,
    });
  });

  it('takes p95 and p99 from the ascending nearest-rank frame durations', () => {
    const metrics = new FrameMetrics();
    const frameDurations = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ];
    let timestamp = 0;
    metrics.recordFrame(timestamp);
    for (const duration of frameDurations) {
      timestamp += duration;
      metrics.recordFrame(timestamp);
    }

    const summary = metrics.summary();
    expect(summary.frames).toBe(20);
    expect(summary.averageFps).toBeCloseTo(95.2380952381, 8);
    expect(summary.onePercentLowFps).toBe(50);
    expect(summary.p95FrameMs).toBe(19);
    expect(summary.p99FrameMs).toBe(20);
  });
});
