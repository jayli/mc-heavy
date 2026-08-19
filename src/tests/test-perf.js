import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { PerfMonitor } from '../core/perf.js';

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
