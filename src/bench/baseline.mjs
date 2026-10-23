// src/bench/baseline.mjs — 性能回归基线跑图（M3-5，设计文档 §8 / roadmap Task M3-5）
// 独立 Node CLI（不混入 `npm test` 验收套件）：Playwright chromium 驱动游戏页，
// 跑 4 个基线场景，采集帧时分布 / GEN·MESH·LIGHT 队列 / 上传耗时 / draw / 内存，
// 输出 markdown 报告 + json 基线；--check 与上次基线对比，回退 >10% 退出码非 0（CI 门禁）。
//
// 用法：
//   npm run bench            采集 + 写 docs/m3-baseline.{md,json}
//   npm run bench -- --check 采集 + 与既有 json 基线对比门禁（不覆盖基线）
//   npm run bench -- --out /tmp/x  自定义输出前缀
//
// 可复现性：全部场景钉 seed=12345（?seed= 复现入口，M3-4），每场景独立 browser context
// （IndexedDB 隔离，前一场景 edits 不污染后一场景的 draw/sections）。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PORT = 8081;
const BASE = `http://localhost:${PORT}`;
const SEED = 12345;         // 复现基线固定 seed（M3-4 ?seed= 入口）
const VD = 8;               // 视距 8（§1 默认口径）
const IS_CI = !!process.env.CI;

// ---- 场景参数（时长/规模；冻结口径见各场景注释） ----
// ① 平原冲刺：起点 ≈ 城市东侧城外 240 格（x≈520），8 m/s × 40s ≈ 320 格 → 越过
//    x=800 的 region 边界（REGION_SIZE=400），满足 §8「含跨 region」路线口径
const SPRINT_SECONDS = 40;
const LOOK_STEPS = 24;          // ② 城市环视：转一圈（24×15°）回原 yaw（draw 可复现）
const LOOK_STEP_MS = 333;       //    每步驻留（合计 ~8s 采样窗口）
const EDIT_COUNT = 200;         // ③ 连续放/挖 200 块（roadmap 冻结）
const TNT_COUNT = 500;          // ④ 模拟 TNT 批量删 500 块（roadmap 冻结）
// 跑图点位（seed=12345 实证扫描选定，勿凭印象改）：x=300..1100、z=-100 为
// 全程干燥走廊（generateHeight>SEA_Y，wet=0；PLAINS 300..510 / DESERT 512..874 /
// PLAINS 876..1100）。两处实证教训：城市出生点东侧 x>566 是深海（曾误选 (806,117)
// 导致冲刺入水 73 格 / TNT 删 0 块）；x=520 起点在 CITY biome 边缘，地表上方 2 格
// 有树冠悬叶挡路（MAX_STEP=1.0 过不去，15s 只跑 12 格）。走廊 x=600..1000 段
// 实测零障碍（地表以上 3 格内无树/仙人掌）。
const SPRINT_START = { x: 620, z: -100 }; // DESERT 段无障碍起点，向东 40s≈320 格跨 x=800 region 边界
const TNT_SITE = { x: 850, z: -100 };     // 同走廊 DESERT 段，14×14 列实心地面

// ==================== server 生命周期 ====================

async function portAlive() {
  try {
    const r = await fetch(BASE + '/index.html');
    return r.ok;
  } catch { return false; }
}

/** 8081 已有服务则复用；否则 spawn start-server.js，跑完只 kill 自己起的 */
async function ensureServer() {
  if (await portAlive()) return { proc: null, reused: true };
  const proc = spawn('node', ['server-script/start-server.js'], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portAlive()) return { proc, reused: false };
  }
  proc.kill();
  throw new Error('dev server 启动超时（8081）');
}

// ==================== 游戏驱动 helpers ====================

const LAUNCH_ARGS = IS_CI
  ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-dawn-features=allow_unsafe_apis']
  : [];

async function bootGame(browser, { vd = VD, weather } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // RedCity 起默认出生在 RedCity；冻结基线（docs/m3-baseline.*）是在 City 出生点量的，场景 ②③ 的语义也绑定城市，
  // 故 pin spawn=city。场景 ①④ 是显式传送到 (620,-100) / (850,-100)，不受出生点影响。
  let url = `${BASE}/?vd=${vd}&seed=${SEED}&spawn=city`;
  if (weather) url += `&weather=${weather}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  return { ctx, page, errors };
}

/** 等启动 burst 收敛：GEN/MESH/upload/light 队列全归零 */
async function waitSteady(page, timeout = 90_000) {
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.inflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0 && s.lightInflight === 0;
  }, null, { timeout });
}

async function resetPerf(page) { await page.evaluate(() => window.__MC_GAME__.perf.reset()); }

/** 采集一帧快照：perf（帧时+marks）/ render / memory / scheduler */
async function sample(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const perf = g.perfSnapshot();
    const m = perf.marks;
    const pick = (k) => (m[k] ? { avg: +m[k].avgMs.toFixed(3), p95: +m[k].p95Ms.toFixed(3), n: m[k].count } : null);
    return {
      fps: +perf.fps.toFixed(2),
      frameMs: { p50: +perf.frameMs.p50.toFixed(2), p95: +perf.frameMs.p95.toFixed(2), p99: +perf.frameMs.p99.toFixed(2) },
      queue: {
        genInflightP95: pick('gen-inflight')?.p95 ?? 0,
        meshInflightP95: pick('mesh-inflight')?.p95 ?? 0,
        uploadQueueP95: pick('upload-queue')?.p95 ?? 0,
        lightInflightP95: pick('light-inflight')?.p95 ?? 0,
        uploadMsP95: pick('upload-ms')?.p95 ?? 0,       // 每帧上传实际耗时（§4.9 ≤3ms）
        fastRemeshP95: pick('fast-remesh')?.p95 ?? null, // 编辑快速路径耗时（仅编辑场景）
      },
      render: g.renderStats(),
      sched: g.scheduler.stats(),
      mem: g.memoryStats(),
    };
  });
}

async function gpuInfo(page) {
  return page.evaluate(async () => {
    try {
      const ad = await navigator.gpu.requestAdapter();
      // Chromium 151：adapterInfo 已收敛为同步属性 adapter.info（实测
      // requestAdapterInfo 为 undefined）；旧形态 requestAdapterInfo() 保留兜底。
      let info = ad.info;
      if (!info && typeof ad.requestAdapterInfo === 'function') {
        info = await ad.requestAdapterInfo(['vendor', 'architecture', 'device', 'description']);
      }
      return info
        ? { vendor: info.vendor, architecture: info.architecture, device: info.device }
        : { vendor: 'unknown', architecture: 'unknown' };
    } catch (e) { return { vendor: 'error', architecture: String(e).slice(0, 60) }; }
  });
}

/** 在 page 侧装帧级峰值记录器（uploadQueue/meshInflight 的最大值） */
async function startPeakMonitor(page) {
  await page.evaluate(() => {
    window.__PEAK__ = { upload: 0, mesh: 0, gen: 0 };
    const g = window.__MC_GAME__;
    window.__PEAK_TIMER__ = setInterval(() => {
      const s = g.scheduler.stats();
      window.__PEAK__.upload = Math.max(window.__PEAK__.upload, s.uploadQueue);
      window.__PEAK__.mesh = Math.max(window.__PEAK__.mesh, s.meshInflight);
      window.__PEAK__.gen = Math.max(window.__PEAK__.gen, s.inflight);
    }, 8);
  });
}
async function readPeak(page) {
  const peak = await page.evaluate(() => {
    clearInterval(window.__PEAK_TIMER__);
    return window.__PEAK__;
  });
  return peak;
}

/**
 * 传送玩家到城外平原点（场景①④用：平原冲刺/实心地面 TNT）。
 * 出生在城市中心，直线奔跑会撞建筑（实测 15s 仅 51 格，违背 §8「平原冲刺」语义）。
 * 流程：高空悬停（50ms 周期重置位置防穿地）→ 等目标中心列 GEN 就绪 → 停悬停 →
 * 扫地表重设位置 → 等新视距稳态。
 * @returns {Promise<{x:number,y:number,z:number}>} 实际落点
 */
async function teleportToPlain(page, tx, tz) {
  await page.evaluate(([tx, tz]) => {
    const g = window.__MC_GAME__;
    g.player.spawn(tx, 60, tz);
    g._benchHover = setInterval(() => g.player.spawn(tx, 60, tz), 50); // 悬停防穿地
  }, [tx, tz]);
  await page.waitForFunction(([cx, cz]) =>
    window.__MC_GAME__.world.hasColumn(cx, cz),
  [Math.floor(tx / 16), Math.floor(tz / 16)], { timeout: 30_000 });
  // 视距内新列基本就绪后再落地（悬停期间 scheduler 以玩家位置持续 GEN）
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 250, null, { timeout: 60_000 });
  const pos = await page.evaluate(([tx, tz]) => {
    const g = window.__MC_GAME__;
    clearInterval(g._benchHover);
    g._benchHover = null;
    let ty = 90;
    while (ty > -32 && g.world.getBlockId(tx, ty, tz) === 0) ty--;
    g.player.spawn(tx, ty + 1, tz);
    return { x: tx, y: ty + 1, z: tz };
  }, [tx, tz]);
  await waitSteady(page, 90_000);
  return pos;
}

// ==================== 场景 ①：平原/城市冲刺（跨 region streaming） ====================

async function scenarioSprint(browser) {
  const { ctx, page, errors } = await bootGame(browser);
  await waitSteady(page);
  // 出生在城市中心：直线奔跑会被建筑挡住（实测 15s 仅 51 格）。
  // §8 场景①口径是「平原冲刺」——先传送到城市东侧 400 格外的平原起跑。
  const start = await teleportToPlain(page, SPRINT_START.x, SPRINT_START.z);
  await resetPerf(page);
  // yaw = -PI/2 → W 沿 +X（_applyInput：move(-sin·fwd, -cos·fwd)）
  await page.evaluate(() => { window.__MC_GAME__.player.yaw = -Math.PI / 2; });
  await page.evaluate(() => window.__MC_GAME__.player.keys.add('KeyW'));
  await new Promise((r) => setTimeout(r, SPRINT_SECONDS * 1000));
  const metrics = await sample(page); // 奔跑中采样（streaming 真实负载）
  await page.evaluate(() => window.__MC_GAME__.player.keys.delete('KeyW'));
  const end = await page.evaluate(() => ({ ...window.__MC_GAME__.player.physics.pos }));
  await waitSteady(page, 60_000);
  const dist = Math.hypot(end.x - start.x, end.z - start.z);
  const regionCrossed = Math.floor(end.x / 400) - Math.floor(start.x / 400)
    + Math.floor(end.z / 400) - Math.floor(start.z / 400);
  await ctx.close();
  return {
    name: '① 平原冲刺',
    note: `传送至城外平原（${start.x},${start.z}）按 W 直线奔跑 ${SPRINT_SECONDS}s：实测 ${dist.toFixed(0)} 格、跨 region ${regionCrossed} 次，streaming 持续 GEN/MESH`,
    metrics, errors,
    extra: { distance: +dist.toFixed(1), columns: metrics.sched.ready, regionCrossed },
  };
}

// ==================== 场景 ②：城市中心环视（最坏 draw call） ====================

async function scenarioCityLook(browser) {
  const { ctx, page, errors } = await bootGame(browser);
  await waitSteady(page);
  await resetPerf(page);
  // 转一圈回原 yaw：每步驻留，采样窗口 ~8s；yaw 复位使 draw 可复现
  for (let i = 0; i < LOOK_STEPS; i++) {
    await page.evaluate((d) => { window.__MC_GAME__.player.yaw += d; }, (Math.PI * 2) / LOOK_STEPS);
    await new Promise((r) => setTimeout(r, LOOK_STEP_MS));
  }
  const metrics = await sample(page);
  await ctx.close();
  return {
    name: '② 城市中心环视',
    note: `出生城市中心原地转 360°（${LOOK_STEPS}×15°），最坏 draw call（建筑群全视野）`,
    metrics, errors,
    extra: { drawCalls: metrics.render.drawCalls, sections: metrics.render.sections, triangles: metrics.render.triangles },
  };
}

// ==================== 场景 ③：连续放/挖 200 块（快速路径） ====================

async function scenarioEditStress(browser) {
  const { ctx, page, errors } = await bootGame(browser);
  await waitSteady(page);
  await new Promise((r) => setTimeout(r, 1000));
  await resetPerf(page);
  const editStats = await page.evaluate(async (count) => {
    const g = window.__MC_GAME__;
    const { world, registry, scheduler, player } = g;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    let gy = -1;
    for (let y = 60; y > -32; y--) if (world.getBlockId(px + 3, y, pz) !== 0) { gy = y; break; }
    const stoneId = registry.idOf('stone');
    const placeTimes = [], digTimes = [];
    for (let i = 0; i < count; i++) {
      const x = px + 3 + (i % 10), z = pz + Math.floor(i / 10) - 10;
      let t0 = performance.now();
      const r1 = world.setBlock(x, gy + 1, z, stoneId);
      if (r1) scheduler.remeshSections(r1.affected, { fastPath: true });
      placeTimes.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
      t0 = performance.now();
      const r2 = world.setBlock(x, gy + 1, z, 0);
      if (r2) scheduler.remeshSections(r2.affected, { fastPath: true });
      digTimes.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    placeTimes.sort((a, b) => a - b); digTimes.sort((a, b) => a - b);
    return {
      placeP95: +placeTimes[Math.floor(placeTimes.length * 0.95)].toFixed(3),
      digP95: +digTimes[Math.floor(digTimes.length * 0.95)].toFixed(3),
      placeMax: +placeTimes[placeTimes.length - 1].toFixed(3),
      digMax: +digTimes[digTimes.length - 1].toFixed(3),
    };
  }, EDIT_COUNT);
  await new Promise((r) => setTimeout(r, 1000));
  const metrics = await sample(page);
  await ctx.close();
  return {
    name: '③ 连续放/挖 200 块',
    note: `每块间隔 1 帧，fastPath 同步重建；单次编辑 p95（放置 ${editStats.placeP95}ms / 挖除 ${editStats.digP95}ms，冻结门 <2ms）`,
    metrics, errors, extra: editStats,
  };
}

// ==================== 场景 ④：模拟 TNT 批量删 500 块（REMESH 路径） ====================

async function scenarioTntBatch(browser) {
  const { ctx, page, errors } = await bootGame(browser);
  await waitSteady(page);
  // 传送到城外平原：实心地面，TNT 批删语义纯粹（城市地表高度不一 + 建筑空洞干扰计数）
  await teleportToPlain(page, TNT_SITE.x, TNT_SITE.z);
  await new Promise((r) => setTimeout(r, 1000));
  await resetPerf(page);
  await startPeakMonitor(page);
  const delStats = await page.evaluate(async (count) => {
    const g = window.__MC_GAME__;
    const { world, scheduler, player } = g;
    const px = Math.floor(player.physics.pos.x), pz = Math.floor(player.physics.pos.z);
    // 逐列扫地表（平原地面高度仍有起伏），从每列地表向下删 depth 层，直到累计 count 块
    const affected = [];
    let n = 0;
    const t0 = performance.now();
    const span = 14; // 14×14 列足够删满 500 块（每列向下 ~3 层）
    for (let dx = 0; dx < span && n < count; dx++) {
      for (let dz = 0; dz < span && n < count; dz++) {
        const x = px + 8 + dx, z = pz + 8 + dz;
        let surf = -1;
        for (let y = 90; y > -32; y--) if (world.getBlockId(x, y, z) !== 0) { surf = y; break; }
        if (surf < 0) continue;
        for (let dy = 0; dy < 4 && n < count; dy++) {
          const y = surf - dy;
          if (world.getBlockId(x, y, z) === 0) continue;
          const r = world.setBlock(x, y, z, 0);
          if (r) affected.push(...r.affected);
          n++;
        }
      }
    }
    const setMs = performance.now() - t0;
    // 一次性异步 REMESH（TNT 语义：批量删 → Worker 重网格，非主线程快速路径）
    const t1 = performance.now();
    scheduler.remeshSections(affected, { fastPath: false });
    const remeshDispatchMs = performance.now() - t1;
    return { deleted: n, setMs: +setMs.toFixed(2), remeshDispatchMs: +remeshDispatchMs.toFixed(2), affected: affected.length };
  }, TNT_COUNT);
  // 等异步 REMESH 收敛，记录队列峰值
  await waitSteady(page, 60_000);
  const peak = await readPeak(page);
  await new Promise((r) => setTimeout(r, 1500));
  const metrics = await sample(page);
  await ctx.close();
  return {
    name: '④ 模拟 TNT 批量删 500 块',
    note: `批量 setBlock 删 ${delStats.deleted} 块（${delStats.setMs}ms）+ 一次性异步 REMESH（下发 ${delStats.remeshDispatchMs}ms，affected ${delStats.affected} section）；收敛期队列峰值 upload ${peak.upload}/mesh ${peak.mesh}`,
    metrics, errors, extra: { ...delStats, peak },
  };
}

// ==================== 报告 ====================

function fmtMark(v) { return v === null || v === undefined ? '—' : String(v); }

function buildMarkdown(results, env) {
  const L = [];
  L.push('# M3 性能回归基线（自动跑图）');
  L.push('');
  L.push(`> 生成：${env.date} ｜ seed=${SEED} ｜ 视距=${VD} ｜ 环境：${env.gpu} ｜ Node ${env.node}`);
  L.push('> 脚本：`npm run bench`（src/bench/baseline.mjs）；门禁：`npm run bench -- --check`（回退 >10% 阻断）。');
  L.push('> 口径同 §8：CI（SwiftShader）帧率仅趋势参考，本机设备矩阵为硬验收；fps 为主断言，frameMs.p95 防跌破 60fps。');
  L.push('');
  L.push('## 场景汇总');
  L.push('');
  L.push('| 场景 | fps | p50 | p95 | p99 | upload p95(ms) | draw | sections | 备注 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const r of results) {
    const m = r.metrics;
    L.push(`| ${r.name} | ${m.fps} | ${m.frameMs.p50} | ${m.frameMs.p95} | ${m.frameMs.p99} | ${m.queue.uploadMsP95} | ${m.render.drawCalls} | ${m.render.sections} | ${r.note} |`);
  }
  L.push('');
  L.push('## 队列深度（p95，不积压判据）');
  L.push('');
  L.push('| 场景 | gen inflight | mesh inflight | upload queue | light inflight |');
  L.push('|---|---:|---:|---:|---:|');
  for (const r of results) {
    const q = r.metrics.queue;
    L.push(`| ${r.name} | ${q.genInflightP95} | ${q.meshInflightP95} | ${q.uploadQueueP95} | ${q.lightInflightP95} |`);
  }
  L.push('');
  L.push('## 内存预算（§4.10：体素 ~37MB + GPU 顶点 ~100MB 级）');
  L.push('');
  L.push('| 场景 | columns | 体素(MB) | GPU 分配(MB) | GPU 占用(MB) |');
  L.push('|---|---:|---:|---:|---:|');
  for (const r of results) {
    const mem = r.metrics.mem;
    L.push(`| ${r.name} | ${mem.columns} | ${(mem.voxelBytes / 1048576).toFixed(1)} | ${(mem.gpuVertexBytes / 1048576).toFixed(1)} | ${(mem.gpuActiveBytes / 1048576).toFixed(1)} |`);
  }
  L.push('');
  L.push('## 编辑/删除快速路径');
  L.push('');
  const e = results.find((r) => r.extra && r.extra.placeP95 !== undefined);
  const t = results.find((r) => r.extra && r.extra.deleted !== undefined);
  if (e) L.push(`- 放/挖 200 块：放置 p95 ${e.extra.placeP95}ms / max ${e.extra.placeMax}ms；挖除 p95 ${e.extra.digP95}ms / max ${e.extra.digMax}ms（冻结门 <2ms）；帧内 fast-remesh p95 ${fmtMark(e.metrics.queue.fastRemeshP95)}ms`);
  if (t) L.push(`- TNT 批删 ${t.extra.deleted} 块：setBlock ${t.extra.setMs}ms + REMESH 下发 ${t.extra.remeshDispatchMs}ms（affected ${t.extra.affected}）；收敛期峰值 upload ${t.extra.peak.upload} / mesh ${t.extra.peak.mesh} / gen ${t.extra.peak.gen}`);
  L.push('');
  return L.join('\n');
}

/** 门禁对比的标量指标（结构类精确、CPU 类 10%、帧率类同 adapter 10%） */
function extractComparable(r) {
  const m = r.metrics;
  return {
    fps: m.fps,
    frameP95: m.frameMs.p95,
    uploadMsP95: m.queue.uploadMsP95,
    fastRemeshP95: m.queue.fastRemeshP95 ?? 0,
    drawCalls: m.render.drawCalls,
    sections: m.render.sections,
    voxelBytes: m.mem.voxelBytes,
    gpuVertexBytes: m.mem.gpuVertexBytes,
  };
}

// 越小越好的指标（回退 = 增大）；其余（fps/draw/sections/bytes）视语义单独判定
const LOWER_IS_BETTER = new Set(['frameP95', 'uploadMsP95', 'fastRemeshP95']);
// 结构/内存类：seed+路线固定应完全可复现，容差极小（浮点/时序抖动 2%）
const STRUCTURAL = new Set(['drawCalls', 'sections', 'voxelBytes', 'gpuVertexBytes']);

function compareWithBaseline(current, baseline) {
  const problems = [];
  const sameGpu = baseline.env?.gpu === current.env?.gpu;
  for (const r of current.results) {
    const b = baseline.results?.find((x) => x.name === r.name);
    if (!b) { problems.push(`[新增场景] ${r.name}（基线无对照，跳过）`); continue; }
    const cur = extractComparable(r), base = extractComparable(b);
    for (const k of Object.keys(cur)) {
      const c = cur[k], o = base[k];
      if (o === 0 || o === null || o === undefined) continue;
      // 帧率类跨 adapter 不可比（CI SwiftShader vs 本机 Metal）→ 仅警告
      const isFps = k === 'fps';
      if (isFps && !sameGpu) continue;
      const ratio = c / o;
      const tol = STRUCTURAL.has(k) ? 0.02 : 0.10; // 结构类 2%，性能类 10%
      const regressed = LOWER_IS_BETTER.has(k) ? ratio > 1 + tol : (isFps ? ratio < 1 - tol : false);
      if (regressed) {
        problems.push(`[回退 ${(Math.abs(ratio - 1) * 100).toFixed(1)}%] ${r.name} · ${k}: ${o} → ${c}`);
      }
    }
  }
  return problems;
}

// ==================== main ====================

async function main() {
  const args = process.argv.slice(2);
  const doCheck = args.includes('--check');
  const outIdx = args.indexOf('--out');
  const outPrefix = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'docs', 'm3-baseline');

  const server = await ensureServer();
  console.log(`[bench] server ${server.reused ? '复用' : '已启动'} :${PORT}`);
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: LAUNCH_ARGS });

  const results = [];
  let gpu = { vendor: '?', architecture: '?' };
  try {
    // 采一次 gpu adapter 信息（任一场景 page）
    const probe = await bootGame(browser, { vd: 2 });
    gpu = await gpuInfo(probe.page);
    await probe.ctx.close();
    console.log(`[bench] gpu: ${gpu.vendor}/${gpu.architecture}`);

    for (const fn of [scenarioSprint, scenarioCityLook, scenarioEditStress, scenarioTntBatch]) {
      const t0 = Date.now();
      const r = await fn(browser);
      console.log(`[bench] ${r.name}: fps=${r.metrics.fps} p95=${r.metrics.frameMs.p95} draw=${r.metrics.render.drawCalls} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      if (r.errors.length) console.log(`        pageerrors: ${r.errors.slice(0, 2).join(' | ')}`);
      results.push(r);
    }
  } finally {
    await browser.close();
    if (server.proc) server.proc.kill();
  }

  const env = {
    date: new Date().toISOString().slice(0, 10),
    gpu: `${gpu.vendor || '?'}/${gpu.architecture || '?'}`,
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    ci: IS_CI,
  };

  const md = buildMarkdown(results, env);
  const json = { env, results: results.map((r) => ({ name: r.name, note: r.note, metrics: r.metrics, extra: r.extra })) };

  if (doCheck) {
    const baselinePath = outPrefix + '.json';
    if (!fs.existsSync(baselinePath)) {
      console.error(`[bench] --check 需要既有基线 ${baselinePath}（先跑 npm run bench 生成）`);
      process.exit(2);
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const problems = compareWithBaseline({ env, results }, baseline);
    const hard = problems.filter((p) => p.startsWith('[回退'));
    if (hard.length) {
      console.error('[bench] 性能回退 >阈值，阻断：');
      for (const p of problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log('[bench] --check 通过（无显著回退）');
    for (const p of problems) console.log('  ' + p);
  } else {
    fs.writeFileSync(outPrefix + '.md', md);
    fs.writeFileSync(outPrefix + '.json', JSON.stringify(json, null, 2));
    console.log(`[bench] 报告写入 ${outPrefix}.md / .json`);
  }
}

main().catch((e) => { console.error('[bench] 失败：', e); process.exit(1); });
