import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, FACE_NORMALS, sunTermFor,
} from '../render/sun-shade.js';
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';

const NOON = paramsAtHour(12).sunDirection;

test('sun-shade: SUN_AMBIENT 恒等于 SHADOW_FLOOR（同一语义：太阳被拿走后的环境地板）', () => {
  assertEqual(SUN_AMBIENT, SHADOW_FLOOR, '两个常数必须相等，否则影区与背光面亮度撕裂');
  assertEqual(SHADOW_FLOOR, 0.5, 'SHADOW_FLOOR 是 mc-lite 2.3/(2.3+3.2*0.8)=0.4733 → sRGB 0.71 的标定产物');
});

test('sun-shade: SUN_INTENSITY 由正午太阳方向派生（不是字面量）', () => {
  assertTrue(Math.abs(NOON[1] - 0.8) < 1e-12, `正午太阳方向归一化后 y 应为 0.8，实测 ${NOON[1]}`);
  assertTrue(Math.abs(SUN_INTENSITY - 0.625) < 1e-12, `派生值应为 0.5/0.8=0.625，实测 ${SUN_INTENSITY}`);
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
  // 期望：+Y 1.0 / +Z 0.875 / ±X 0.5 / -Y 0.5 / -Z 0.5
  assertTrue(v[2] > v[4], `顶面(${v[2]}) 须亮于 +Z 面(${v[4]})`);
  assertTrue(v[4] > v[5], `+Z 迎光面(${v[4]}) 须亮于 -Z 背光面(${v[5]})`);
  assertTrue(Math.abs(v[0] - 0.5) < 1e-12, `+X 面${v[0]}（太阳 x 分量为 0 → 恒 ambient）`);
  assertTrue(Math.abs(v[4] - 0.875) < 1e-12, `+Z 面应为 0.875，实测 ${v[4]}`);
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
