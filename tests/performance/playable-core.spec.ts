import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BENCHMARK_DURATION_MS = 300_000;
const reportPath = resolve('artifacts/perf/playable-core.json');

test('holds the fixed playable path above 90 FPS on real Chrome WebGPU', async ({ page }) => {
  test.setTimeout(BENCHMARK_DURATION_MS + 60_000);
  await page.goto('/');
  await page.locator('[data-testid="world-ready"], [data-testid="renderer-error"]').waitFor();

  const backend = await page.getByTestId('backend').count() === 1
    ? (await page.getByTestId('backend').textContent())?.replace('Backend: ', '')
    : `unavailable: ${await page.getByTestId('renderer-error').textContent()}`;
  test.skip(backend !== 'webgpu', `WebGPU benchmark skipped because backend is ${backend ?? 'unknown'}`);

  const report = await page.evaluate(async (durationMs) => {
    const modulePath = '/src/benchmark/run-path.ts';
    const { runBenchmarkPath } = await import(/* @vite-ignore */ modulePath);
    return runBenchmarkPath(window.game!, durationMs);
  }, BENCHMARK_DURATION_MS);

  await mkdir(resolve('artifacts/perf'), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  expect(report.onePercentLowFps).toBeGreaterThanOrEqual(90);
  expect(report.p99FrameMs).toBeLessThanOrEqual(11.1);
});
