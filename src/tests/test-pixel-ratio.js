// src/tests/test-pixel-ratio.js — 渲染分辨率档位的纯函数契约（v2.27）
//
// 为什么要单独成模块：`renderer.setPixelRatio()` 是 GPU drawing buffer 的物理尺寸，
// **单测里验不到**（没有真 WebGPU backend 就不发 draw）。但「档位 → 像素比」这段换算
// 是有对错可言的逻辑，必须能被 Tier 1 钉住：
//   - `performance` 档在 Retina（dpr=2）与普通屏（dpr=1）上都得落到半分辨率；
//   - 下限钳制（极小 dpr / 非法 dpr）不能产出 0 —— 0 会让 canvas 宽高变 0，
//     渲染静默变黑屏而不是报错。
// Tier 4（`tests/settings-resolution.spec.mjs`）验的是「真的接进了 renderer」。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  PIXEL_RATIO_MODE_OPTIONS, DEFAULT_PIXEL_RATIO_MODE,
  PERFORMANCE_RATIO_SCALE, PIXEL_RATIO_MIN,
  pixelRatioFor, normPixelRatioMode,
} from '../render/pixel-ratio.js';

test('pixel-ratio: 档位集合与默认档自洽（默认档必须在集合内）', () => {
  // 默认档若不在集合里，面板两个按钮一个都不会高亮 —— 玩家看不出当前生效值
  assertTrue(PIXEL_RATIO_MODE_OPTIONS.includes(DEFAULT_PIXEL_RATIO_MODE),
    `默认档 ${DEFAULT_PIXEL_RATIO_MODE} 必须是档位集合之一`);
  assertEqual(PIXEL_RATIO_MODE_OPTIONS.length, 2, '用户裁定只要两档（清晰 / 性能）');
  // 默认必须是「清晰」= 本仓在本次改动前的观感（devicePixelRatio 原值），否则等于偷偷降了画质
  assertEqual(DEFAULT_PIXEL_RATIO_MODE, 'sharp', '默认档 = 清晰（改动前现状）');
});

test('pixel-ratio: 清晰档 = devicePixelRatio 原值（零回归）', () => {
  // 用户 2026-11-03 裁定：「『清晰』按钮就是当前分辨率」
  for (const dpr of [1, 1.5, 2, 3]) {
    assertEqual(pixelRatioFor('sharp', dpr), dpr, `清晰档在 dpr=${dpr} 时必须原样返回`);
  }
});

test('pixel-ratio: 性能档 = dpr × 0.5（Retina 与普通屏都降到半分辨率）', () => {
  // ⚠️ 这里钉的是「相对 dpr 的倍率」而不是绝对像素比 —— mc-lite 的绝对三档
  // （0.4/0.6/1.0）在 Retina 屏上语义会漂：它的 1.0「画质档」在本仓相当于降分辨率。
  assertEqual(PERFORMANCE_RATIO_SCALE, 0.5, '用户裁定 0.5 × dpr');
  assertEqual(pixelRatioFor('performance', 2), 1, 'Retina 屏(dpr=2) → 1.0');
  assertEqual(pixelRatioFor('performance', 1), 0.5, '普通屏(dpr=1) → 0.5');
  assertEqual(pixelRatioFor('performance', 3), 1.5, 'dpr=3 → 1.5');
});

test('pixel-ratio: 下限钳制（绝不产出 0，否则 canvas 宽高归零 → 静默黑屏）', () => {
  // dpr 为 0 / 负数 / NaN / Infinity 都不得让像素比落到 0 或非有限值。
  // 缺陷形态是**静默**的：canvas.width = 0 不抛异常，只是什么都不显示。
  assertEqual(pixelRatioFor('performance', 0), PIXEL_RATIO_MIN, 'dpr=0 落到下限');
  assertEqual(pixelRatioFor('performance', -2), PIXEL_RATIO_MIN, '负 dpr 落到下限');
  assertEqual(pixelRatioFor('sharp', 0), PIXEL_RATIO_MIN, '清晰档的 dpr=0 也落到下限');
  assertEqual(pixelRatioFor('sharp', NaN), PIXEL_RATIO_MIN, 'NaN 落到下限');
  assertEqual(pixelRatioFor('performance', NaN), PIXEL_RATIO_MIN, '性能档 NaN 落到下限');
  assertEqual(pixelRatioFor('sharp', Infinity), PIXEL_RATIO_MIN, 'Infinity 落到下限（非有限值）');
  for (const mode of PIXEL_RATIO_MODE_OPTIONS) {
    for (const dpr of [0, -1, NaN, Infinity, undefined, null]) {
      const r = pixelRatioFor(mode, dpr);
      assertTrue(Number.isFinite(r) && r >= PIXEL_RATIO_MIN,
        `${mode} 档在 dpr=${String(dpr)} 时必须产出有限且 ≥ ${PIXEL_RATIO_MIN} 的值，实测 ${r}`);
    }
  }
  // 下限本身必须 > 0（0 会让 canvas 宽高为 0）
  assertTrue(PIXEL_RATIO_MIN > 0, '下限必须为正');
});

test('pixel-ratio: 性能档恒不高于清晰档（档位语义不得反转）', () => {
  // 用户要的是「性能 = 更低的分辨率」。若某天有人把倍率改成 >1，
  // 按钮文案与实际行为就反了，而肉眼只是「看起来更清晰了」—— 不会有人报 bug。
  for (const dpr of [0.5, 1, 1.5, 2, 3, 4]) {
    const sharp = pixelRatioFor('sharp', dpr);
    const perf = pixelRatioFor('performance', dpr);
    assertTrue(perf <= sharp, `dpr=${dpr}：性能档 ${perf} 必须 ≤ 清晰档 ${sharp}`);
  }
});

test('pixel-ratio: 非法档位回落到默认档（不抛异常）', () => {
  // 旧存档 / 手改 URL 可能带来任意字符串 —— 必须回落而不是让渲染停在 undefined 像素比
  for (const bad of ['', 'SHARP', 'low', null, undefined, 0, 1, {}, []]) {
    assertEqual(normPixelRatioMode(bad), DEFAULT_PIXEL_RATIO_MODE,
      `非法档位 ${String(bad)} 应回落到默认档`);
    assertEqual(pixelRatioFor(bad, 2), 2, `非法档位下的像素比应等同默认档（清晰）`);
  }
  // 合法值原样返回
  for (const ok of PIXEL_RATIO_MODE_OPTIONS) {
    assertEqual(normPixelRatioMode(ok), ok, `合法档位 ${ok} 必须原样返回`);
  }
});
