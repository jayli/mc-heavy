import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { benchmarkPath } from '../../src/benchmark/run-path';
import {
  beginPerformanceArtifact,
  writePerformanceArtifact,
} from '../support/performance-artifact';

const BENCHMARK_DURATION_MS = 300_000;
const reportPath = resolve('artifacts/perf/playable-core.json');

test('holds the fixed playable path above 90 FPS on real Chrome WebGPU', async ({ page }) => {
  test.setTimeout(BENCHMARK_DURATION_MS + 60_000);
  const artifactRun = await beginPerformanceArtifact(reportPath);
  await page.goto('/');
  await page.locator('[data-testid="world-ready"], [data-testid="renderer-error"]').waitFor();

  const startupError = await page.getByTestId('renderer-error').count() === 1
    ? await page.getByTestId('renderer-error').textContent()
    : null;
  test.skip(startupError !== null, `WebGPU benchmark skipped because renderer is unavailable: ${startupError}`);
  await page.waitForFunction(() => ['webgpu', 'webgl2'].includes(
    document.documentElement.dataset.renderBackend ?? '',
  ));
  const backend = await page.evaluate(() => document.documentElement.dataset.renderBackend);
  test.skip(backend !== 'webgpu', `WebGPU benchmark skipped because backend is ${backend ?? 'unknown'}`);

  const report = await page.evaluate(async (durationMs) => {
    const modulePath = '/src/benchmark/run-path.ts';
    const { runBenchmarkPath } = await import(/* @vite-ignore */ modulePath);
    return runBenchmarkPath(window.game!, durationMs);
  }, BENCHMARK_DURATION_MS);

  expect(report.seed).toBe(0x5eed1234);
  expect(report.path).toEqual(benchmarkPath);
  await writePerformanceArtifact(reportPath, artifactRun, 'webgpu', BENCHMARK_DURATION_MS, report);
  expect(report.onePercentLowFps).toBeGreaterThanOrEqual(90);
  expect(report.p99FrameMs).toBeLessThanOrEqual(11.1);
});
