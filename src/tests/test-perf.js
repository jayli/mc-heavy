import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { PerfMonitor } from '../core/perf.js';
import { PerfHUD } from '../core/perf-hud.js';
import { setDebugFlags } from '../core/debug-config.js';

test('PerfMonitor: 100 帧 16.67ms 间隔 → fps ≈ 60', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 16.67; m.tick(t); }
  const s = m.snapshot();
  assertTrue(Math.abs(s.fps - 60) < 2, `fps=${s.fps}`);
});

test('PerfMonitor: 帧时分位数正确', () => {
  const m = new PerfMonitor();
  let t = 0;
  // 90 帧 10ms + 10 帧 30ms
  for (let i = 0; i < 90; i++) { t += 10; m.tick(t); }
  for (let i = 0; i < 10; i++) { t += 30; m.tick(t); }
  const s = m.snapshot();
  assertTrue(s.frameMs.p50 <= 11, `p50=${s.frameMs.p50}`);
  assertTrue(s.frameMs.p95 >= 25, `p95=${s.frameMs.p95}`);
});

test('PerfMonitor: mark 聚合 count/avg', () => {
  const m = new PerfMonitor();
  m.mark('mesh-upload', 2);
  m.mark('mesh-upload', 4);
  const s = m.snapshot();
  assertEqual(s.marks['mesh-upload'].count, 2);
  assertEqual(s.marks['mesh-upload'].avgMs, 3);
});

test('PerfMonitor: 窗口滚动，内存有界', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 5000; i++) { t += 16; m.tick(t); }
  // 内部采样窗口不应无限增长
  assertTrue(m._frameSamples.count <= m.windowSize, 'sample window bounded');
});

function makeFakeStats() {
  return {
    blocks: 100, candidateFaces: 600, faces: 100, culledFaces: 500,
    cullRatio: 500 / 600, vertices: 400,
    channels: { opaque: { slots: 1, vertices: 400, triangles: 200 } },
    sections: 1, sectionCount: 1, columns: 1, drawCalls: 3, triangles: 200,
  };
}

test('PerfHUD: statsLog 开 → 2s 节奏 console.log 世界数据', () => {
  setDebugFlags({ worldStats: true, statsLog: true });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    hud.update(250);  // 首次世界刷新（_lastWorldUpdate=-2000）→ log 1 次
    hud.update(500);  // 距上次世界刷新仅 250ms → 不 log
    hud.update(2300); // 距上次世界刷新 2050ms → log 第 2 次
  } finally {
    console.log = origLog;
  }
  assertEqual(logs.length, 2, 'log on 2s cadence');
  assertTrue(String(logs[0][0]).includes('blocks=100'), 'log line has exact numbers');
});

test('PerfHUD: statsLog 关 → 不输出控制台日志（HUD 仍渲染）', () => {
  setDebugFlags({ worldStats: true, statsLog: false });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    hud.update(250);
  } finally {
    console.log = origLog;
    setDebugFlags({ statsLog: true }); // 还原默认（开发调试期全开）
  }
  assertEqual(logs.length, 0, 'no console log when statsLog off');
  assertTrue(container.textContent.includes('剔除'), 'HUD world section still rendered');
});
