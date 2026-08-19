import { test, expect } from 'playwright/test';

test('WebGPU 发布路径语义实测（设计文档 v1.7 断言）', async ({ page }) => {
  // bench 页需从 CDN 加载 three 并跑 5 组用例（各 100 帧），放宽到 180s
  // （config 全局 timeout 60s 对本 spec 不够）
  test.setTimeout(180_000);
  await page.goto('/src/bench/webgpu-publish.html');
  await page.waitForFunction(() => window.__BENCH__ !== undefined, null, { timeout: 120_000 });
  const b = await page.evaluate(() => window.__BENCH__);
  expect(b.error).toBeUndefined();

  // 1. material 数组逐 group 发 draw（Renderer.js:3149-3158）
  expect(b.threeGroup.drawCalls).toBe(3);
  expect(b.twentyFourGroup.drawCalls).toBe(24);

  // 2. WebGPU 后端 BatchedMesh 非 multi-draw：逐 instance 一次 draw
  //    （WebGPUBackend.js:1806-1824）
  expect(b.batchedRaw.drawCalls).toBe(2312);

  // 3. 开剔除+排序且全部 instance 可见：命令数不变；CPU 循环阈值环境相关
  //    （本地真 GPU 硬门槛 4ms/帧 = 120fps 预算的一半；CI SwiftShader 放宽 30ms 趋势参考）
  expect(b.batchedCulled.drawCalls).toBe(2312);
  expect(b.batchedCulled.cpuMs).toBeLessThan(process.env.CI ? 30 : 4);

  // 4. setGeometryAt 快路径：纯主线程拷贝，环境无关，硬门槛 2ms（设计文档 §7 M0 ③）
  expect(b.setGeometryAt.replaceAvgMs).toBeLessThan(2);

  console.log('BENCH RESULT:', JSON.stringify(b));
});
