// src/tests/test-moonlight.js — 夜间月光照耀（v3.00）的纯函数契约
//
// 方案 A 的核心不变式：**月亮方向 ≡ 光照方向**。这条不在着色器里，而在数据层：
// `VISUAL_STYLES[key].moonDirection` 与同风格 `sunDirection` 同向 ⇒ 月轮 sprite 出现在
// 太阳光来的那侧 ⇒ 夜间迎光面朝向月亮、影子背离月亮。
//
// ⚠️ 为什么必须四风格都对齐、而不是只改 night：19:00~21:00 是 `moonVisible` 已为 true
// 但方向仍在 morning→night 之间插值的时段。只改 night 会让月亮在这 2 小时里扫过天顶
// （仰角 26.7°→64.4°→14.5°、单步方位跳 61.7°）。四风格一起改则月亮永远沿太阳的既有
// 平滑轨迹（全程 dot = 1.000000）。
import { test } from './runner.js';
import { assertTrue } from './assert.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

test('moonlight: 全天任意小时 moonDirection ≡ sunDirection（插值同轨迹）', () => {
  // 0.125h 网格：既有「方向连续」用例用的就是这个网格（7/9/17/19 边界都是它的整数倍）
  for (let h = 0; h <= 24 + 1e-9; h += 0.125) {
    const p = paramsAtHour(h);
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(p.moonDirection[i] - p.sunDirection[i]) < 1e-12,
        `h=${h.toFixed(3)} 分量 ${i}: moon=${p.moonDirection[i]} sun=${p.sunDirection[i]}`);
    }
  }
});

test('moonlight: 月亮走过的轨迹连续（只改 night 会在 20:00 跳 61.7°）', () => {
  // 单独一条：即使「moon ≡ sun」成立，也不代表插值本身连续 —— 它依赖风格数据都对齐。
  // 阈值沿用既有用例的 0.05（归一化后分量差）。
  // ⚠️ 四风格全对齐后 moon 与 sun 同轨迹 ⇒ 实测最大分量差就是 sun 的 0.02513。
  //    只改 night 时实测会到 0.13+（20:00 单步跳 61.7°），本阈值能抓到。
  let prev = paramsAtHour(0).moonDirection;
  for (let h = 0.125; h <= 24 + 1e-9; h += 0.125) {
    const cur = paramsAtHour(h).moonDirection;
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(cur[i] - prev[i]) < 0.05,
        `moon 轨迹不连续 at h=${h.toFixed(3)} 分量 ${i}: ${prev[i]} -> ${cur[i]}`);
    }
    prev = cur;
  }
});

test('moonlight: 月亮出现的时段（19~21）方向必须单调走向 night 值', () => {
  // moonVisible 在 19.5 起为 true。此前插值的是 morning→night，此时 morning.moonDirection
  // 若不对齐会给出一个完全不同的方位 —— 这正是「只改 night」的失效形态。
  const nightDir = normalize(VISUAL_STYLES.night.moonDirection);
  for (const h of [19.5, 20, 20.5, 21, 22]) {
    const p = paramsAtHour(h);
    assertTrue(p.moonVisible === true, `h=${h} 月亮应可见`);
    const d = p.moonDirection;
    const dot = d[0] * nightDir[0] + d[1] * nightDir[1] + d[2] * nightDir[2];
    assertTrue(dot > 0.85, `h=${h} 月亮方向须接近 night 值（不得跳到另一侧）：dot=${dot.toFixed(4)}`);
  }
});

test('moonlight: night 的月光色温偏冷且量级合理', () => {
  const n = VISUAL_STYLES.night;
  // 冷色方向性：B > R
  assertTrue(n.sunColor[2] > n.sunColor[0], `直射须偏冷：R=${n.sunColor[0]} B=${n.sunColor[2]}`);
  assertTrue(n.ambientColor[2] > n.ambientColor[0], `环境须偏冷：R=${n.ambientColor[0]} B=${n.ambientColor[2]}`);
  // 量级：与 dusk（1.50 / 0.58）同档，不得失控
  for (const v of [...n.sunColor, ...n.ambientColor]) {
    assertTrue(v > 0.5 && v <= 1.5, `色温分量须在 (0.5, 1.5]：${v}`);
  }
});
