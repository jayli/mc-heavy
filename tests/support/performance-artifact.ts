import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BenchmarkReport } from '../../src/benchmark/run-path';

export type PerformanceArtifactRun = Readonly<{
  runStartedAt: string;
}>;

export async function beginPerformanceArtifact(
  path: string,
  runStartedAt = new Date().toISOString(),
): Promise<PerformanceArtifactRun> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  return Object.freeze({ runStartedAt });
}

export async function writePerformanceArtifact(
  path: string,
  run: PerformanceArtifactRun,
  backend: 'webgpu',
  durationMs: number,
  report: BenchmarkReport,
  completedAt = new Date().toISOString(),
): Promise<void> {
  const artifact = {
    schemaVersion: 1,
    runStartedAt: run.runStartedAt,
    completedAt,
    backend,
    durationMs,
    seed: report.seed,
    path: report.path,
    frames: report.frames,
    averageFps: report.averageFps,
    p95FrameMs: report.p95FrameMs,
    p99FrameMs: report.p99FrameMs,
    onePercentLowFps: report.onePercentLowFps,
  };
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
