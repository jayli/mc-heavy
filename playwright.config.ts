import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /integration\/app\/.*\.test\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chrome',
      testMatch: /performance\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
