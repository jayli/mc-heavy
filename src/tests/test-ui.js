// M3-4 HUD：hotbar 图标裁剪计算 + 设置合并逻辑（纯函数单测）
import { test } from './runner.js';
import { assertEqual } from './assert.js';
import { tileStyle } from '../ui/hotbar.js';
import { DEFAULT_SETTINGS, resolveSettings } from '../ui/settings.js';

test('hotbar: tileStyle 按 atlas tile 像素坐标算 background 裁剪', () => {
  const tile = { x: 144, y: 352, w: 16, h: 16 };
  const s = tileStyle(tile, 40, 2048);
  // 放大倍率 = 40/16 = 2.5；background-size = 2048×2.5 = 5120
  assertEqual(s.backgroundSize, '5120px 5120px');
  // 偏移 = -(x×2.5), -(y×2.5)
  assertEqual(s.backgroundPosition, '-360px -880px');
});

test('hotbar: tileStyle 非方形 tile（128 大图）按 w/h 各自缩放', () => {
  const tile = { x: 0, y: 1024, w: 128, h: 128 };
  const s = tileStyle(tile, 40, 2048);
  assertEqual(s.backgroundSize, '640px 640px'); // 2048 × 40/128
  assertEqual(s.backgroundPosition, '0px -320px'); // -(1024 × 0.3125)；x=0 → "0px"
});

test('settings: 默认值（vd=8 / blur=off / volume=1 / 风格自动）', () => {
  assertEqual(DEFAULT_SETTINGS.viewDistance, 8);
  assertEqual(DEFAULT_SETTINGS.blur, false);
  assertEqual(DEFAULT_SETTINGS.volume, 1);
  assertEqual(DEFAULT_SETTINGS.visualStyle, null);
});

test('settings: resolveSettings 优先级 URL > 存储 > 默认', () => {
  // 无存储无 URL → 默认
  const d = resolveSettings(null, new URLSearchParams(''));
  assertEqual(d.viewDistance, 8);
  // 存储覆盖默认
  const s1 = resolveSettings({ viewDistance: 4, volume: 0.5 }, new URLSearchParams(''));
  assertEqual(s1.viewDistance, 4);
  assertEqual(s1.volume, 0.5);
  assertEqual(s1.blur, false); // 未存字段回落默认
  // URL 覆盖存储
  const s2 = resolveSettings({ viewDistance: 4 }, new URLSearchParams('vd=12&blur=1'));
  assertEqual(s2.viewDistance, 12);
  assertEqual(s2.blur, true);
});

test('settings: resolveSettings 视距钳制到合法档位（2~16）', () => {
  const s = resolveSettings({ viewDistance: 999 }, new URLSearchParams(''));
  assertEqual(s.viewDistance, 16);
  const s2 = resolveSettings(null, new URLSearchParams('vd=0'));
  assertEqual(s2.viewDistance, 2); // 钳制下限 = 架构最小值（M1 测试/调试用 vd=2）
  const s3 = resolveSettings(null, new URLSearchParams('vd=abc'));
  assertEqual(s3.viewDistance, 8); // 非法值回落默认
  // vd=2 保持 2（UI 预设从 4 起，但 URL/测试可达架构下限）
  assertEqual(resolveSettings(null, new URLSearchParams('vd=2')).viewDistance, 2);
});

test('settings: volume 钳制 [0,1]', () => {
  assertEqual(resolveSettings({ volume: 5 }, new URLSearchParams('')).volume, 1);
  assertEqual(resolveSettings({ volume: -1 }, new URLSearchParams('')).volume, 0);
});

test('settings: visualStyle 只接受合法键', () => {
  assertEqual(resolveSettings({ visualStyle: 'night' }, new URLSearchParams('')).visualStyle, 'night');
  assertEqual(resolveSettings({ visualStyle: 'bogus' }, new URLSearchParams('')).visualStyle, null);
  assertEqual(resolveSettings(null, new URLSearchParams('style=morning')).visualStyle, 'morning');
});
