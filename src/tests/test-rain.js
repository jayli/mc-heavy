// M3-3 雨效：天气状态机（晴 → 雨 → 晴 随机周期，mc-lite weather 语义移植）
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { WeatherState, RAIN } from '../render/weather.js';

/** 固定序列 rng（周期可预测的单测注入） */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('weather: 初始晴，intensity=0', () => {
  const w = new WeatherState({ rng: seqRng([0.5]) });
  assertEqual(w.kind, 'clear');
  assertEqual(w.intensity, 0);
});

test('weather: 晴天时长 = 60~180s（rng 驱动）', () => {
  const w = new WeatherState({ rng: seqRng([0, 1, 0.5]) }); // rng 0 → 60s；1 → 180s
  assertEqual(w.stateSeconds, 60);
  const w2 = new WeatherState({ rng: seqRng([1]) });
  assertEqual(w2.stateSeconds, 180);
});

test('weather: 晴天到时自动转雨，5s 淡入到 intensity=1', () => {
  const w = new WeatherState({ rng: seqRng([0, 0]) }); // 晴 60s，雨 30s
  w.update(60); // 晴期满 → 进入 to-rain 过渡
  assertEqual(w.kind, 'rain');
  assertTrue(w.intensity < 1, '过渡中未满');
  w.update(RAIN.TRANSITION_SECONDS); // 5s 淡入
  assertTrue(Math.abs(w.intensity - 1) < 1e-6, `intensity=${w.intensity}`);
});

test('weather: 雨期到时自动转晴，5s 淡出到 intensity=0', () => {
  const w = new WeatherState({ rng: seqRng([0, 0]) }); // 晴 60s，雨 30s
  w.update(60 + RAIN.TRANSITION_SECONDS); // 到雨态满强度
  assertEqual(w.intensity, 1);
  w.update(30); // 雨期满 → to-clear
  w.update(RAIN.TRANSITION_SECONDS);
  assertEqual(w.intensity, 0);
  assertEqual(w.kind, 'clear');
});

test('weather: 过渡中强度连续（无跳变），步进 0.1s 单调', () => {
  const w = new WeatherState({ rng: seqRng([0, 0.5]) });
  w.update(60);
  let prev = 0;
  for (let i = 0; i < 50; i++) {
    w.update(0.1);
    assertTrue(w.intensity >= prev - 1e-9, '淡入单调不减');
    prev = w.intensity;
  }
  assertTrue(Math.abs(prev - 1) < 1e-6);
});

test('weather: force(kind) 立即进过渡，与自动周期语义一致', () => {
  const w = new WeatherState({ rng: seqRng([0.5]) });
  w.force('rain');
  assertEqual(w.kind, 'rain');
  w.update(RAIN.TRANSITION_SECONDS);
  assertEqual(w.intensity, 1);
  w.force('clear');
  w.update(RAIN.TRANSITION_SECONDS);
  assertEqual(w.intensity, 0);
  assertEqual(w.kind, 'clear');
});

test('weather: 雨中途 force(clear) 从当前强度淡出（不跳变）', () => {
  const w = new WeatherState({ rng: seqRng([0, 0]) });
  w.update(60);
  w.update(RAIN.TRANSITION_SECONDS / 2); // 半程 intensity≈0.5
  const mid = w.intensity;
  w.force('clear');
  assertTrue(w.intensity <= mid + 1e-9, '淡出从当前值开始');
  w.update(RAIN.TRANSITION_SECONDS);
  assertEqual(w.intensity, 0);
});

test('weather: isRaining = intensity > 0（视觉/雾效消费口径）', () => {
  const w = new WeatherState({ rng: seqRng([0, 0]) });
  assertEqual(w.isRaining, false);
  w.update(60.01);
  assertEqual(w.isRaining, true);
  w.force('clear');
  w.update(RAIN.TRANSITION_SECONDS);
  assertEqual(w.isRaining, false);
});

test('weather: 大步长 dt（后台切回）不产生越界强度', () => {
  const w = new WeatherState({ rng: seqRng([0, 0]) });
  w.update(10000); // 一步跨过多个周期
  assertTrue(w.intensity >= 0 && w.intensity <= 1, `intensity=${w.intensity}`);
});
