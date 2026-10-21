import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  FOG_SKY_Y_FLOOR_EPS, fogSkySampleDir,
} from '../render/fog-sky-direction.js';

const isUnit = (v) => Math.abs(Math.hypot(v[0], v[1], v[2]) - 1) < 1e-12;

test('fog-sky-direction: 仰视只做归一化（ε 不得抬高仰角）', () => {
  const v = [0.3, 0.5, -0.4];
  const len = Math.hypot(...v);
  const d = fogSkySampleDir(...v);
  for (let i = 0; i < 3; i++) {
    assertTrue(Math.abs(d[i] - v[i] / len) < 1e-12, `仰视第 ${i} 分量应等于原始归一化值，实测 ${d[i]} vs ${v[i] / len}`);
  }
});

test('fog-sky-direction: 俯视的 y 被钳到 ε（只看上半球）', () => {
  const d = fogSkySampleDir(0.6, -0.8, 0.2);
  assertTrue(isUnit(d), `必须归一化，实测模长 ${Math.hypot(d[0], d[1], d[2])}`);
  assertTrue(d[1] > 0, `y 必须为正（钳到上半球），实测 ${d[1]}`);
  assertTrue(d[1] < 1e-4, `y 应被钳到地平线带，实测 ${d[1]}`);
});

test('fog-sky-direction: 纯水平视线恰为地平线方向（y=ε，几乎水平）', () => {
  const d = fogSkySampleDir(1, 0, 0);
  assertTrue(isUnit(d), '必须归一化');
  assertTrue(d[1] < 1e-4, `y=0 时应几乎水平（只剩 ε），实测 y=${d[1]}`);
  assertTrue(Math.abs(d[0] - 1) < 1e-4, `x 方向应几乎不变，实测 ${d[0]}`);
});

test('fog-sky-direction: 方位角差异被保留（不同朝向得到不同方向）', () => {
  // 同俯角、不同方位 → 水平分量方向不同（本功能的价值来源）
  const north = fogSkySampleDir(0, -0.5, 1);
  const east = fogSkySampleDir(1, -0.5, 0);
  assertTrue(Math.abs(north[0] - east[0]) > 0.5, `方位角差异必须保留，实测 x ${north[0]} vs ${east[0]}`);
  assertTrue(Math.abs(north[2] - east[2]) > 0.5, `方位角差异必须保留，实测 z ${north[2]} vs ${east[2]}`);
});

test('fog-sky-direction: 所有俯角都归到地平线带（不采样天底那半张图）', () => {
  // 这是本功能的核心不变式：无论俯角多深，y 都必须 ≥ 0 且极小 →
  // 永远取地平线附近的天色，而不是脚下那半张（实测天底 [97,125,186] 比地平线
  // [207,216,232] 暗得多，直接采样会让俯视时雾色反向变暗）。
  for (const dy of [-0.2, -0.5, -0.8, -1]) {
    const d = fogSkySampleDir(0, dy, 1);
    assertTrue(d[1] > 0, `俯角 ${dy} 的 y 必须为正，实测 ${d[1]}`);
    assertTrue(d[1] < 1e-4, `俯角 ${dy} 应贴地平线（不是天底），实测 y=${d[1]}`);
  }
});

test('fog-sky-direction: 垂直俯视/水平/仰视三种极端都合法（不产 NaN，方向可预测）', () => {
  const straightDown = fogSkySampleDir(0, -1, 0);
  const level = fogSkySampleDir(0, 0, 1);
  const up = fogSkySampleDir(0, 1, 0);
  // 垂直俯视：水平分量为零 → 取 +x 确定性兼就，y 仍在ε带（不是天顶）
  assertTrue(isUnit(straightDown), `垂直俯视必须归一化：${JSON.stringify(straightDown)}`);
  assertTrue(straightDown[1] < 1e-4, `垂直俯视也应贴地平线（不能取天顶），实测 y=${straightDown[1]}`);
  assertTrue(Math.abs(straightDown[0] - 1) < 1e-6, `退化时应取 +x，实测 x=${straightDown[0]}`);
  // 水平：贴地平线
  assertTrue(level[1] < 1e-4, `水平视线应贴地平线，实测 y=${level[1]}`);
  // 仰视：保留原方向（天顶）
  assertTrue(up[1] > 0.9, `仰视应保留原方向，实测 y=${up[1]}`);
});

test('fog-sky-direction: ε 是导出常量且为正（着色器侧须 import 同一个值）', () => {
  assertTrue(FOG_SKY_Y_FLOOR_EPS > 0, 'ε 必须为正，否则归一化会除零');
  assertTrue(FOG_SKY_Y_FLOOR_EPS < 1e-3, 'ε 须足够小，否则水平视线会被明显抬离地平线');
});
