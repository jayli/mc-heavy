import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { paramsAtHour, VISUAL_STYLES, VISUAL_STYLE_KEYS } from '../render/daynight.js';

test('三种风格参数齐全且照度语义正确', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING];
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON];
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT];
  assertEqual(n.skyDim, 1, 'noon full skylight');
  assertTrue(k.skyDim < n.skyDim, 'night dims skylight');
  assertTrue(k.blockBoost > n.blockBoost, 'night boosts blocklight relatively');
  assertTrue(m.skyDim < n.skyDim, 'morning slightly dimmer than noon');
});

test('paramsAtHour：正午/子夜取风格原值', () => {
  assertEqual(paramsAtHour(12).skyDim, VISUAL_STYLES.noon.skyDim);
  assertEqual(paramsAtHour(0).skyDim, VISUAL_STYLES.night.skyDim);
  assertEqual(paramsAtHour(24).skyDim, VISUAL_STYLES.night.skyDim, 'wrap 24==0');
});

test('paramsAtHour：昼夜过渡平滑（无跳变）', () => {
  // 分段线性插值天然连续；断言相邻 0.25h 的 skyDim 差不超过最陡坡（黎明 0.275/h→0.069/步）
  // 的余量 0.08，足以捕获任何真实跳变（跳变会 >>0.08）。
  let prev = paramsAtHour(0).skyDim;
  for (let h = 0.25; h <= 24; h += 0.25) {
    const cur = paramsAtHour(h).skyDim;
    assertTrue(Math.abs(cur - prev) < 0.08, `smooth at ${h}: ${prev}->${cur}`);
    prev = cur;
  }
});

test('paramsAtHour：晨昏介于夜与午之间', () => {
  const dawn = paramsAtHour(7);
  assertTrue(dawn.skyDim > VISUAL_STYLES.night.skyDim && dawn.skyDim <= VISUAL_STYLES.morning.skyDim + 1e-9, 'dawn between');
});
