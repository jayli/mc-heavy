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
    ...report,
  };
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
