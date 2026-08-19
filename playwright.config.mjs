import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // 串行执行：worker-gen 的 GEN p95<8ms 是计时型冻结断言，
  // 并行 spec 会争抢 CPU 导致 flaky（实测隔离 4ms / 并行偶发 >8ms）。
  // suite 很小（6 spec ~4s），串行化消除整类计时抖动。
  workers: 1,
  use: {
    baseURL: 'http://localhost:8081',
    browserName: 'chromium',
    headless: true,
    // channel: 'chromium' 是必需项：默认的 headless shell 在零 flag 下拿不到 WebGPU
    // adapter，而完整 Chromium 新无头模式在本机（macOS ARM）零 flag 走 Metal。
    channel: 'chromium',
    launchOptions: {
      // 实测矩阵（macOS ARM + Chromium 151 + playwright 1.62.1，2026-08-19）：
      //   headless shell + 零 flag            → no-adapter
      //   headless shell + SwiftShader 组合   → vendor=google, arch=swiftshader
      //   channel:'chromium' + 零 flag        → vendor=apple, arch=metal-3（本机默认走这条）
      //   channel:'chromium' + SwiftShader 组 → vendor=google, arch=swiftshader（Linux CI）
      // 本地用真 GPU 性能数字才有代表性；Linux CI 无 Metal，用 SwiftShader 组合。
      // `--enable-features=Vulkan` 在 macOS 上无作用，已删除。
      args: process.env.CI
        ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-dawn-features=allow_unsafe_apis']
        : [],
    },
  },
  webServer: {
    command: 'npm start',
    port: 8081,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
