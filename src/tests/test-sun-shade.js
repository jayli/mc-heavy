import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, FACE_NORMALS, sunTermFor, sunTermRGBFor,
  srgbEncode, acesFilmic,
} from '../render/sun-shade.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

const NOON = paramsAtHour(12).sunDirection;

test('sun-shade: SUN_AMBIENT 恒等于 SHADOW_FLOOR（同一语义：太阳被拿走后的环境地板）', () => {
  assertEqual(SUN_AMBIENT, SHADOW_FLOOR, '两个常数必须相等，否则影区与背光面亮度撕裂');
  assertEqual(SHADOW_FLOOR, 0.38, 'v1.70：用户选定 0.38 加深暗部（实测暗部 p5 45→28、迎光/背光比 1.30→1.46）');
});

test('sun-shade: SUN_INTENSITY 由正午太阳方向派生（不是字面量）', () => {
  assertTrue(Math.abs(NOON[1] - 0.8) < 1e-12, `正午太阳方向归一化后 y 应为 0.8，实测 ${NOON[1]}`);
  assertTrue(Math.abs(SUN_INTENSITY - 0.775) < 1e-12, `派生值应为 (1-0.38)/0.8=0.775，实测 ${SUN_INTENSITY}`);
});

test('sun-shade: 正午 +Y 面 sunTerm 恒等于 1.0（零回归不变式）', () => {
  const top = sunTermFor(2, NOON, 1, 1);
  assertTrue(Math.abs(top - 1) < 1e-12, `正午顶面必须等于现状的 1.0，实测 ${top}`);
});

test('sun-shade: strength=0 时所有面恒等于 1.0（关掉即逐位回到现状）', () => {
  for (let i = 0; i < 6; i++) {
    assertTrue(Math.abs(sunTermFor(i, NOON, 0, 1) - 1) < 1e-12, `面 ${i} 关掉方向光后必须为 1.0`);
  }
});

test('sun-shade: 正午六面亮度排序 —— 顶面 > 迎光侧 > 背光侧', () => {
  const v = [0, 1, 2, 3, 4, 5].map((i) => sunTermFor(i, NOON, 1, 1));
  // 期望（地板 0.38、强度 0.775）：+Y 1.0 / +Z 0.845 / ±X、-Y 0.38 / -Z 0.38
  assertTrue(v[2] > v[4], `顶面(${v[2]}) 须亮于 +Z 面(${v[4]})`);
  assertTrue(v[4] > v[5], `+Z 迎光面(${v[4]}) 须亮于 -Z 背光面(${v[5]})`);
  assertTrue(Math.abs(v[0] - 0.38) < 1e-12, `+X 面${v[0]}（太阳 x 分量为 0 → 恒 ambient=0.38）`);
  assertTrue(Math.abs(v[4] - 0.845) < 1e-12, `+Z 面应为 0.38+0.775×0.6=0.845，实测 ${v[4]}`);
});

test('sun-shade: 阴影把太阳只从太阳项里拿走（影区顶面回到 SHADOW_FLOOR）', () => {
  assertTrue(Math.abs(sunTermFor(2, NOON, 1, 0) - SHADOW_FLOOR) < 1e-12, 'shadowKill=0 时顶面 = 地板');
  assertTrue(Math.abs(sunTermFor(2, NOON, 1, 1) - 1) < 1e-12, 'shadowKill=1 时顶面 = 1');
  // shadowKill 不得影响环境地板本身：背光面在影子里仍是地板值
  assertTrue(Math.abs(sunTermFor(5, NOON, 1, 0) - SHADOW_FLOOR) < 1e-12, '背光面影区 = 地板');
});

test('sun-shade: 太阳转向另一边时迎光/背光互换（方向随日夜真的变）', () => {
  const morning = paramsAtHour(7).sunDirection;
  const plusZ = sunTermFor(4, morning, 1, 1);
  const minusZ = sunTermFor(5, morning, 1, 1);
  assertTrue(plusZ > 1, `morning 的 +Z 面应过曝（迎光），实测 ${plusZ}`);
  assertTrue(Math.abs(minusZ - SHADOW_FLOOR) < 1e-12, `morning 的 -Z 面 = 地板，实测 ${minusZ}`);
});

test('sun-shade: FACE_NORMALS 与 mesher 的面序一致（+X,-X,+Y,-Y,+Z,-Z）', () => {
  assertEqual(FACE_NORMALS.length, 6);
  assertEqual(FACE_NORMALS[0].join(','), '1,0,0');
  assertEqual(FACE_NORMALS[1].join(','), '-1,0,0');
  assertEqual(FACE_NORMALS[2].join(','), '0,1,0');
  assertEqual(FACE_NORMALS[3].join(','), '0,-1,0');
  assertEqual(FACE_NORMALS[4].join(','), '0,0,1');
  assertEqual(FACE_NORMALS[5].join(','), '0,0,-1');
  // 六面法线表与 noon 风格数据的形状校验（防表被改乱）
  assertEqual(VISUAL_STYLES.noon.sunDirection.length, 3, 'noon 风格三分量');
});

// —— 色温（v1.71 dusk）——
// 色温必须是**纯函数 + 单一权威**：materials.js 的 TSL 与这里同公式，单测只测这一份。
// 关键不变式：色温取中性白时**逐位**回到标量版 sunTermFor（其余三种风格零回归）。

/** 从 dusk 风格数据取色温，避免断言里手写第二份字面量 */
const DUSK = VISUAL_STYLES.dusk;

test('sun-shade: 色温为中性白时逐位等于标量版（零回归不变式）', () => {
  for (let i = 0; i < 6; i++) {
    for (const strength of [0, 0.5, 1]) {
      const scalar = sunTermFor(i, NOON, strength, 1);
      const rgb = sunTermRGBFor(i, NOON, strength, 1, [1, 1, 1], [1, 1, 1]);
      for (let c = 0; c < 3; c++) {
        assertTrue(Math.abs(rgb[c] - scalar) < 1e-12,
          `面 ${i} strength=${strength} 通道 ${c}：中性色温须逐位等于标量版 ${scalar}，实测 ${rgb[c]}`);
      }
    }
  }
});

test('sun-shade: 标量版 sunTermFor 是色温版中性白下的 R 通道（不留第二份公式）', () => {
  const morning = paramsAtHour(7).sunDirection;
  for (let i = 0; i < 6; i++) {
    const s = sunTermFor(i, morning, 1, 1);
    const neutral = sunTermRGBFor(i, morning, 1, 1, [1, 1, 1], [1, 1, 1]);
    assertTrue(Math.abs(s - neutral[0]) < 1e-12, `面 ${i}：标量版必须等于色温版中性白的 R 通道`);
  }
});

test('sun-shade: 迎光面因暖色温偏红、背光面因冷环境光偏蓝（傍晚的核心观感）', () => {
  // ⚠️ **判据必须走屏幕口径（sRGB + ACES），不能看线性 shade 比值**：
  // 线性空间里 R/B 只有 1.28，过了 sRGB 传递函数再叠 ACES 后屏幕差距才被拉开到可感知
  // （同 CLAUDE.md 里 `shadow.radius` / 太阳项的既有教训）。
  const duskDir = (() => {
    const d = DUSK.sunDirection;
    const l = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    return [d[0] / l, d[1] / l, d[2] / l];
  })();
  // 找出 dusk 太阳最正对的那个面（用它做「迎光面」，不写死索引）
  const dots = FACE_NORMALS.map((n) => n[0] * duskDir[0] + n[1] * duskDir[1] + n[2] * duskDir[2]);
  const litIdx = dots.indexOf(Math.max(...dots));
  const shadowIdx = dots.indexOf(Math.min(...dots));
  assertTrue(dots[litIdx] > 0.5, `dusk 太阳须明显正对某个面（否则观感上没有迎光面）：dot=${dots[litIdx]}`);
  /**
   * 线性 shade → 屏幕 sRGB 值（与 GPU 同序：shade × skyDim × 曝光 × 贴图基色 → ACES → sRGB）。
   *
   * ⚠️ **必须带一个贴图基色**：ACES + sRGB 在高亮端压缩最狠，基色越亮暖色被压得越平
   * （实测基色 1.00 → 屏幕 R−B 只有 12；基色 0.50 → 21；基色 0.35 → 35）。
   * 取 0.5（草地/石头的典型中间调）作为**有代表性**的口径 —— 用 1.0 测等于在一个
   * 真实贴图几乎不会出现的极端上判「暖色够不够」。
   */
  const BASE = [0.5, 0.5, 0.5];
  const toScreen = (linear) => {
    const p = DUSK;
    return linear.map((v, c) => Math.round(
      srgbEncode(acesFilmic(v * p.skyDim * p.toneMappingExposure * BASE[c])) * 255,
    ));
  };
  const lit = toScreen(sunTermRGBFor(litIdx, duskDir, 1, 1, DUSK.sunColor, DUSK.ambientColor));
  const shadowed = toScreen(sunTermRGBFor(shadowIdx, duskDir, 1, 1, DUSK.sunColor, DUSK.ambientColor));
  // 屏幕口径的「暖」= R − B（0 = 中性灰）。实测迎光 **+21** / 影面 **−24**（基色 0.5 中间灰）
  assertTrue(lit[0] - lit[2] > 12, `迎光面须明显偏暖（屏幕 R−B > 12）：实测 ${lit[0] - lit[2]}（${lit.join(',')}）`);
  assertTrue(shadowed[0] - shadowed[2] < -10, `背光面须明显偏冷（屏幕 R−B < −10）：实测 ${shadowed[0] - shadowed[2]}（${shadowed.join(',')}）`);
  // 迎光面整体亮度也须高于背光面（暖光 + 更亮，才是它们不是同一颜色的两档）
  const luma = (s) => 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
  assertTrue(luma(lit) > luma(shadowed) * 1.25,
    `迎光面亮度须明显高于背光面：lit=${luma(lit).toFixed(1)} shadow=${luma(shadowed).toFixed(1)}`);
});

test('sun-shade: 色温只作用于各自那一项，不改变明暗结构（影区仍由 SHADOW_FLOOR 支配）', () => {
  const dir = paramsAtHour(12).sunDirection; // 方向不影响地板
  // shadowKill = 0（影区/背光）：只剩环境光 → 各通道 = 地板 × 环境色
  const dark = sunTermRGBFor(2, dir, 1, 0, DUSK.sunColor, DUSK.ambientColor);
  for (let c = 0; c < 3; c++) {
    assertTrue(Math.abs(dark[c] - SHADOW_FLOOR * DUSK.ambientColor[c]) < 1e-12,
      `通道 ${c}：影区须 = SHADOW_FLOOR × 环境色，实测 ${dark[c]}`);
  }
  // strength = 0：色温也不得生效（关掉方向光必须逐位回到现状）
  const off = sunTermRGBFor(2, dir, 0, 1, DUSK.sunColor, DUSK.ambientColor);
  for (let c = 0; c < 3; c++) {
    assertTrue(Math.abs(off[c] - 1) < 1e-12, `strength=0 时通道 ${c} 须恒为 1，实测 ${off[c]}`);
  }
});

test('sun-shade: 色温是相对乘数（均值 ≈1，不得偷偷改曝光）', () => {
  const mean = (v) => (v[0] + v[1] + v[2]) / 3;
  const sunMean = mean(DUSK.sunColor);
  const ambMean = mean(DUSK.ambientColor);
  assertTrue(sunMean > 0.9 && sunMean < 1.15, `dusk sunColor 均值须 ≈1：${sunMean.toFixed(3)}`);
  assertTrue(ambMean > 0.9 && ambMean < 1.15, `dusk ambientColor 均值须 ≈1：${ambMean.toFixed(3)}`);
});
