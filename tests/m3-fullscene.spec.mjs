import { test, expect } from 'playwright/test';

// M3-1 验收：视距 8 全量调优（roadmap Task M3-1，设计文档 §1/§4.10/§8）
// m1-acceptance 的全量场景版：城市 + 悬浮空岛 + 云层 + 洞穴 + 水面 + 日夜全开，
// 断言 ① 稳态 fps（120Hz 本机 ≥115 目标下先守 §1 的 ≥90 底线 + p95 防跌破 60fps）
//      ② GEN/MESH/LIGHT 队列不积压（inflight 稳定、停跑后收敛归零）
//      ③ 内存预算达标（§4.10：体素 ~37MB + GPU 顶点 ~100MB 级）
// 帧时口径与全部性能 spec 一致：fps 为主断言，frameMs.p95 < 16.7 作二级门（vsync 量化）。

/** 等待世界全量就绪：289 列 + 空中云层内容 + 洞穴内容（数据级采样） */
async function waitFullWorld(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  // 空中结构：云层（Y=55 单云 / Y=35 云簇）已在加载列中
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const cloudId = g.registry.idOf('cloud');
    for (const [, col] of g.world.columns) {
      for (let lx = 0; lx < 16; lx += 2) for (let lz = 0; lz < 16; lz += 2) {
        if (col.get(lx, 55, lz) === cloudId || col.get(lx, 35, lz) === cloudId) return true;
      }
    }
    return false;
  }, null, { timeout: 60_000 });
  // 洞穴：地表以下存在空气格（M2-4 语义采样）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    for (const [, col] of g.world.columns) {
      for (let lx = 1; lx < 16; lx += 5) {
        for (let lz = 1; lz < 16; lz += 5) {
          let surface = -32;
          for (let y = 70; y > -32; y--) { if (col.get(lx, y, lz) !== 0) { surface = y; break; } }
          if (surface < 0) continue;
          for (let y = surface - 4; y > -28; y--) {
            if (col.get(lx, y, lz) === 0) return true;
          }
        }
      }
    }
    return false;
  }, null, { timeout: 60_000 });
}

test('M3-1：全量场景稳态帧率 + 队列不积压 + 内存预算', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345');
  await waitFullWorld(page);

  // 稳态沉淀：上传 burst 结束后队列应全部收敛归零（不积压的第一判据）
  await new Promise((r) => setTimeout(r, 5000));
  const steady = await page.evaluate(() => ({
    stats: window.__MC_GAME__.scheduler.stats(),
    perf: window.__MC_GAME__.perfSnapshot(),
  }));
  console.log('M3-1 STEADY:', JSON.stringify(steady));
  expect(steady.stats.inflight).toBe(0);         // GEN 全部完成
  expect(steady.stats.meshInflight).toBe(0);     // MESH 全部完成
  expect(steady.stats.uploadQueue).toBe(0);      // 上传队列清空
  expect(steady.stats.lightInflight).toBe(0);
  expect(steady.stats.ready).toBe(289);

  // 全量场景奔跑 10s（出生在城市，路径含建筑群 = 最坏 draw call 场景之一）
  await page.evaluate(() => { window.__MC_GAME__.player.keys.add('KeyW'); });
  await new Promise((r) => setTimeout(r, 10_000));
  const running = await page.evaluate(() => ({
    stats: window.__MC_GAME__.scheduler.stats(),
    perf: window.__MC_GAME__.perfSnapshot(),
  }));
  await page.evaluate(() => { window.__MC_GAME__.player.keys.delete('KeyW'); });
  console.log('M3-1 RUN:', JSON.stringify(running));

  // 队列不积压（inflight 稳定）：奔跑中 GEN 在途有界（视距 8 前沿新增 ≤ 2×17=34 列/批，
  // 加滞回重入余量放宽到 80），且明显小于总量 289——积压 = 持续接近/超过总量
  expect(running.stats.inflight).toBeLessThan(process.env.CI ? 289 : 80);
  expect(running.stats.uploadQueue).toBeLessThan(process.env.CI ? 2000 : 300);

  // 停跑后 8s 收敛：队列归零（无泄漏、无永久积压）
  await new Promise((r) => setTimeout(r, 8_000));
  const settled = await page.evaluate(() => window.__MC_GAME__.scheduler.stats());
  console.log('M3-1 SETTLED:', JSON.stringify(settled));
  expect(settled.inflight).toBe(0);
  expect(settled.meshInflight).toBe(0);
  expect(settled.uploadQueue).toBe(0);

  // 帧率：稳态窗口（PerfMonitor 600 帧窗口此时已覆盖奔跑后半段+收敛段）
  const perf = await page.evaluate(() => window.__MC_GAME__.perfSnapshot());
  console.log('M3-1 PERF:', JSON.stringify(perf));
  expect(perf.fps).toBeGreaterThan(process.env.CI ? 20 : 90);
  expect(perf.frameMs.p95).toBeLessThan(process.env.CI ? 50 : 16.7);

  // 内存预算（§4.10）：体素 CPU ~37MB、GPU 顶点缓冲 ~100MB 级（1.5× 余量红线）
  const mem = await page.evaluate(() => window.__MC_GAME__.memoryStats());
  console.log('M3-1 MEM:', JSON.stringify(mem));
  expect(mem.voxelBytes).toBeLessThan(45 * 1024 * 1024);   // 289×128KB≈37MB + 滞回带余量
  // U1′（RedCity，设计文档 v1.68 §4.10）：冻结预算 148.06 → 195.55 MiB（opaque 4.275M + cutout 2.2M + transparent 0.36M）× 30 B。
  // 本用例不 pin spawn=city：默认出生在 RedCity 正是新的最重场景，稳态帧率 / 队列 / 内存预算都应在它上面成立。
  expect(mem.gpuVertexBytes).toBeLessThan(196 * 1024 * 1024);
  if (!process.env.CI) {
    // jsHeapSizeLimit 仅 Chromium 暴露；CI 上 SwiftShader 内存形态不同，只在本机参考
    expect(mem.jsHeapUsedBytes ?? 0).toBeLessThan(1024 * 1024 * 1024);
  }
});
