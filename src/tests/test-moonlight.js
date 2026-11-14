// src/tests/test-moonlight.js — 夜间月光照耀（v3.00）的纯函数契约
//
// ## 不变式（用户 2026-11-14 二次裁定后的口径）
//
// 初版是「四风格 moonDirection ≡ sunDirection」。用户实玩后裁定
// 「月亮高度太低，月亮的方位不变，光源也不变，高度调高一些」⇒ 落地为：
//
//   · **所有风格的 `sunDirection` 一个字节不动**（「光源也不变」）—— 地面明暗与影子方向
//     仍完全由它驱动，阴影灯定位 / 枪 PBR 高光 / 三个 spec 的接线口径不受影响；
//   · 每个风格的 `moonDirection` = **本风格 `sunDirection` 的方位 + 仰角 35.4241°**
//     （方位不变、高度 = mc-lite 原 night 月亮的仰角）；
//   · 只有 night 的 `moonVisible` 为 true，morning/noon/dusk 不可见。
//
// ⚠️ **为什么另外三个风格也必须用新方位**（而不是回退 mc-lite 原值）：19:00~21:00 与
// 5:00~7:00 是 morning↔night 的插值段，而 `moonVisible` 在 19.25 就已经是 true。
// 若 morning 的旧向量 `[-0.38,0.45,-0.81]` 与新 night 向量几乎反向，插值会抳出一个
// **天顶弧**（实测仰角冲到 73.12°、方位单步跳 65°），而那时月亮已经可见 —— 视觉上是
// 「月亮从东边掠过天顶再落到西边」。三个不可见风格同方位后，可见时段只扫方位 1.7°/步、
// 仰角恒定。
import { test } from './runner.js';
import { assertTrue } from './assert.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** 仰角（度） */
function elevOf(v) {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return Math.asin(v[1] / l) * 180 / Math.PI;
}

/** 方位角（度，+Z 为 0、+X 为 +90） */
function azimOf(v) {
  return Math.atan2(v[0], v[2]) * 180 / Math.PI;
}

test('moonlight: 夜间月亮方位 = 光照方位，仰角 = 35.4241°（抬高但方位不变）', () => {
  const n = VISUAL_STYLES.night;
  const m = normalize(n.moonDirection);
  const s = normalize(n.sunDirection);
  // 方位一致（「方位不变」）
  assertTrue(Math.abs(azimOf(m) - azimOf(s)) < 0.01,
    `月亮方位须等于光照方位：moon=${azimOf(m).toFixed(4)}° sun=${azimOf(s).toFixed(4)}°`);
  // 仰角 = mc-lite 原值 35.4241°
  assertTrue(Math.abs(elevOf(m) - 35.4241) < 0.01,
    `月亮仰角须 ≈35.4241°（mc-lite 原值）：实测 ${elevOf(m).toFixed(4)}°`);
  // 光源不动 —— 仰角仍是 14.5° 那一档
  assertTrue(elevOf(s) < 15, `光源仰角须保持不动（<15°）：实测 ${elevOf(s).toFixed(4)}°`);
  // 两者之间的夹角量化（便于以后 review 对比）：同方位、仰角差 20.85°
  const dot = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
  assertTrue(dot > 0.9 && dot < 0.999,
    `月亮与光照须同方位但不同仰角（夹角应在 0~25°）：dot=${dot.toFixed(6)}`);
});

test('moonlight: 自动循环里月亮轨迹连续（无天顶弧、无跳变，0.125h 网格）', () => {
  // 阈值沿用既有「方向连续」用例的 0.05（归一化后分量差）。
  // ✅ 正确口径实测：最大分量差 0.01026 @h=8.375（余量 5×）。
  // ❌ 若 morning 的 moonDirection 回退成 mc-lite 原值（与新 night 反向），实测会到
  //    0.13+（h=5.25），本断言真 FAIL —— 这就是它守的东西。
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

test('moonlight: 月亮可见时段仰角恒定 35.42°（不得出现天顶弧）', () => {
  // 可见时段的**全时段**仰角都必须贴着 35.42° —— 不是"单调"，而是"不爬升"。
  // 这条直接钉住「19→21 抳到 73° 再落回」那类缺陷（回归形态见文件头注释）。
  const visibleHours = [];
  for (let h = 0; h <= 24; h += 0.125) {
    if (paramsAtHour(h).moonVisible) visibleHours.push(h);
  }
  assertTrue(visibleHours.length > 40, `可见时段须覆盖多个采样点（否则判据无法判别）：实测 ${visibleHours.length}`);

  let maxDev = 0, worstH = 0;
  for (const h of visibleHours) {
    const e = elevOf(paramsAtHour(h).moonDirection);
    const dev = Math.abs(e - 35.4241);
    if (dev > maxDev) { maxDev = dev; worstH = h; }
    assertTrue(dev < 0.05,
      `h=${h} 月亮可见时仰角须恒定 35.4241°（不得抳天顶）：实测 ${e.toFixed(3)}°`);
  }
  // 把最大偏差也打出来（实测 0.048° @h≈19.125 —— 那是 morning→night 插值的自然斜率，
  // 不是天顶弧；天顶弧的回归形态是 73°，会先被上面的断言拓住）
  assertTrue(maxDev < 0.1, `仰角最大偏差须 < 0.1°：实测 ${maxDev.toFixed(4)}° @h=${worstH}`);
});

test('moonlight: 月亮可见时方位只在同一条方位线上小幅扫动（不横穿天空）', () => {
  // 方位从 morning 的 +11.56° 平滑过渡到 night 的 +4.76°（不可见风格的方位也在这条线上）。
  // 若不可见风格回退成旧向量，可见时段会出现 −155° 那样的大跳（月亮横穿天空）。
  const visibleHours = [];
  for (let h = 0; h <= 24; h += 0.125) {
    if (paramsAtHour(h).moonVisible) visibleHours.push(h);
  }
  const azims = visibleHours.map((h) => azimOf(paramsAtHour(h).moonDirection));
  const lo = Math.min(...azims), hi = Math.max(...azims);
  assertTrue(hi - lo < 10,
    `可见时段方位跨度须 < 10°（不得横穿天空）：实测 ${lo.toFixed(2)}° ~ ${hi.toFixed(2)}°（跨度 ${(hi - lo).toFixed(2)}°）`);
  // 且必须落在 night 方位附近（+4.76°），不得跑到另一侧
  assertTrue(lo > -10 && hi < 20,
    `可见时段方位须在 night 方位附近（-10°~20°）：实测 ${lo.toFixed(2)}° ~ ${hi.toFixed(2)}°`);
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
