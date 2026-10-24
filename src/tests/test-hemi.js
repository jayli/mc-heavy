import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { HEMI_GROUND, hemiFactorFor } from '../render/hemi-shade.js';

test('hemi-shade: 关闭档（ground=1）时六面因子恒为 1（逐位回到现状）', () => {
  for (let i = 0; i < 6; i++) {
    assertEqual(hemiFactorFor(i, 1.0), 1, `面 ${i} 关闭半球光后必须为 1`);
  }
});

test('hemi-shade: 顶面恒为 1、底面恒为 ground（与 ground 取值无关）', () => {
  for (const g of [0.2, 0.4, 0.6, 1.0]) {
    assertTrue(Math.abs(hemiFactorFor(2, g) - 1) < 1e-12, `+Y 面应恒为 1，g=${g}，实测 ${hemiFactorFor(2, g)}`);
    assertTrue(Math.abs(hemiFactorFor(3, g) - g) < 1e-12, `-Y 面应恒为 g=${g}，实测 ${hemiFactorFor(3, g)}`);
  }
});

test('hemi-shade: 四面侧面恒为 (ground+1)/2，且严格介于顶底之间', () => {
  for (const i of [0, 1, 4, 5]) {
    const v = hemiFactorFor(i, HEMI_GROUND);
    const want = (HEMI_GROUND + 1) / 2;
    assertTrue(Math.abs(v - want) < 1e-12, `面 ${i} 应为 ${want}，实测 ${v}`);
    assertTrue(v > HEMI_GROUND && v < 1, `面 ${i} 须严格介于底面与顶面之间，实测 ${v}`);
  }
});

test('hemi-shade: HEMI_GROUND 落在 (0,1) 且不是 1（1 = 关闭档）', () => {
  assertTrue(HEMI_GROUND > 0 && HEMI_GROUND < 1, `实测 ${HEMI_GROUND}`);
  assertTrue(HEMI_GROUND !== 1, '取 1 等于功能关闭，会让整项静默失效');
});

test('hemi-shade: 因子随 ground 单调（ground 越暗，朝下面越暗）', () => {
  const a = hemiFactorFor(3, 0.2);
  const b = hemiFactorFor(3, 0.6);
  const c = hemiFactorFor(3, 1.0);
  assertTrue(a < b && b < c, `底面因子须随 ground 单调增：0.2→${a} / 0.6→${b} / 1.0→${c}`);
});
