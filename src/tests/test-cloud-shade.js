// src/tests/test-cloud-shade.js — 云专属着色地板（v3.50）的 Tier 1 不变式
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md §5.1 / §6.1
//
// ## 这些用例守什么
//
// 云的「半透光」观感 = 给三个致暗因子（太阳项 / 半球环境 / AO）各加一个**地板**，
// 用 `max(原值, 地板)` 抬暗面。`max` 是载荷性的：原值已高于地板的面恒等返回
// ⇒ **亮面逐位不动**（不过曝、不撞 crosshair 的「最亮方块 < 200」阈值）。
//
// 本文件钉的是「改坏了肉眼玩不出来」的那部分：
//   · 零回归（soften=0 / lift=0 必须**逐位**回到现状，不是「差不多」）；
//   · 亮面不动（整体提亮会冒充柔和，而云底面判据照样绿）；
//   · 任何面都不许变暗（柔和是单向抬升）。
//
// ⚠️ 逐位判据一律用 assertEqual（===），不用容差 —— 容差会把浮点重建缺陷放过去。
// ⚠️ 逐位判据的输入必须含**非整比值**：整数/整比输入下重建缺陷恒等，测不出来。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  CLOUD_SUN_LIFT, CLOUD_HEMI_LIFT, CLOUD_AO_LIFT, AO_CURVE_K,
  aoFactorFor, cloudSunFloorFor, cloudHemiFloorFor, cloudAoFloorFor, cloudShadeFor,
} from '../render/cloud-shade.js';
import {
  SHADOW_FLOOR, SUN_INTENSITY, NOON_SUN_DIR, FACE_NORMALS, sunTermRGBFor,
} from '../render/sun-shade.js';
import { HEMI_GROUND, hemiFactorFor } from '../render/hemi-shade.js';

/** 归一化（测试侧独立实现，不复用被测代码的 helper） */
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * 现状 shade 的**独立**参考实现（不 import 被测函数）。
 * 与 materials.js 的 `max(sky×hemi×sunTerm, block)` 在 block=0 时同式。
 * ⚠️ 字面量 0.9 / 3 / 2 是刻意的：这条用例要能抓到「被测模块改了 AO 曲线」，
 * 若从被测模块 import AO_CURVE_K 就变成同源恒真。
 */
function refShade(normalIndex, ao, sunDir, kill, floor, intensity, ground) {
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  return (floor + intensity * dot * kill)
    * (ground + (1 - ground) * (n[1] * 0.5 + 0.5))
    * (1 - (3 - ao) / 3 * 0.9);
}

test('cloud-shade: lift=0 时三个地板逐位等于原值（零回归锚点）', () => {
  for (const floor of [0.38, 0.14, 0.2713]) {
    assertEqual(cloudSunFloorFor(floor, 0), floor, `floor=${floor} 的太阳地板`);
  }
  for (const ground of [0.6, 0.12, 0.4319]) {
    assertEqual(cloudHemiFloorFor(ground, 0), ground, `ground=${ground} 的半球地板`);
  }
  assertEqual(cloudAoFloorFor(0), aoFactorFor(0), 'AO 地板 lift=0');
  // 前提断言：三个 lift 的正式值都不是 0（取 0 等于功能关闭，整项静默失效）
  assertTrue(CLOUD_SUN_LIFT > 0 && CLOUD_SUN_LIFT < 1, `CLOUD_SUN_LIFT=${CLOUD_SUN_LIFT}`);
  assertTrue(CLOUD_HEMI_LIFT > 0 && CLOUD_HEMI_LIFT < 1, `CLOUD_HEMI_LIFT=${CLOUD_HEMI_LIFT}`);
  assertTrue(CLOUD_AO_LIFT > 0 && CLOUD_AO_LIFT < 1, `CLOUD_AO_LIFT=${CLOUD_AO_LIFT}`);
});

test('cloud-shade: ao=3 时 AO 地板不改开阔面', () => {
  assertEqual(aoFactorFor(3), 1, '前提：开阔面 AO 因子本就恒 1');
  assertEqual(Math.max(aoFactorFor(3), cloudAoFloorFor()), aoFactorFor(3), '开阔面不受 AO 地板影响');
  assertEqual(AO_CURVE_K, 0.9, 'AO 曲线系数与 materials.js 现状一致');
});

test('cloud-shade: 正午顶面 sunTerm 恒 1.0 且高于云地板 ⇒ max 恒等（顶面不动）', () => {
  const st = SHADOW_FLOOR + SUN_INTENSITY * NOON_SUN_DIR[1];
  assertTrue(Math.abs(st - 1) < 1e-12, `正午顶面 sunTerm 应为 1.0，实测 ${st}`);
  assertTrue(st >= cloudSunFloorFor(SHADOW_FLOOR), `顶面 ${st} 须 ≥ 云地板 ${cloudSunFloorFor(SHADOW_FLOOR)}`);
  assertEqual(Math.max(st, cloudSunFloorFor(SHADOW_FLOOR)), st, 'max 必须恒等返回顶面原值');
});

test('cloud-shade: soften=0 逐位等于现状公式（非整比输入，7776 组）', () => {
  const dirs = [
    [0.3187, 0.8721, -0.3719], [-0.4412, 0.6633, 0.6047],
    [0.7934, 0.5479, 0.3392], [0, 0.8, 0.6],
  ].map(norm);
  let checked = 0;
  for (const sunDir of dirs) {
    for (const shadowFloor of [0.38, 0.14, 0.2713]) {
      for (const hemiGround of [0.6, 0.12, 0.4319]) {
        for (const sunIntensity of [0.775, 0.956, 0.6173]) {
          for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
            for (const ao of [0, 1, 2, 3]) {
              for (const shadowKill of [1, 0.3719, 0]) {
                const got = cloudShadeFor({
                  normalIndex, ao, sunDir, shadowKill,
                  shadowFloor, sunIntensity, hemiGround, soften: 0,
                });
                const want = refShade(normalIndex, ao, sunDir, shadowKill, shadowFloor, sunIntensity, hemiGround);
                assertEqual(got, want,
                  `soften=0 逐位：face${normalIndex} ao${ao} floor${shadowFloor} ground${hemiGround} I${sunIntensity} kill${shadowKill}`);
                checked++;
              }
            }
          }
        }
      }
    }
  }
  // 防「循环没跑」的恒真：4×3×3×3×6×4×3 = 7776
  assertEqual(checked, 7776, '样本数');
});

test('cloud-shade: soften=1 时暗面变亮、亮面逐位不变、任何面都不变暗', () => {
  const sunDir = NOON_SUN_DIR;
  const base = { sunDir, shadowKill: 1, shadowFloor: SHADOW_FLOOR, sunIntensity: SUN_INTENSITY, hemiGround: HEMI_GROUND };
  let brighten = 0, unchanged = 0, dimmed = 0;
  for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
    for (const ao of [0, 1, 2, 3]) {
      const off = cloudShadeFor({ ...base, normalIndex, ao, soften: 0 });
      const on = cloudShadeFor({ ...base, normalIndex, ao, soften: 1 });
      if (on > off) brighten++;
      else if (on === off) unchanged++;
      else dimmed++;
    }
  }
  assertEqual(brighten, 20, '变亮的 face×AO 组合数');
  assertEqual(unchanged, 4, '逐位不变的组合数（顶面与迎光面的 ao=2/3）');
  assertEqual(dimmed, 0, '**任何面都不得变暗** —— 柔和是单向抬升');
  // 单独钉住两个亮面（整体提亮 / 改系数 / wrap lighting 都会让这两条真红）
  for (const normalIndex of [2, 4]) {
    const off = cloudShadeFor({ ...base, normalIndex, ao: 3, soften: 0 });
    const on = cloudShadeFor({ ...base, normalIndex, ao: 3, soften: 1 });
    assertEqual(on, off, `面 ${normalIndex}（顶面/迎光面）ao=3 必须逐位不变`);
  }
});

test('cloud-shade: 地板随 floor/ground 单调，且 normal 档派生值正确', () => {
  assertTrue(cloudSunFloorFor(0.14) < cloudSunFloorFor(0.38), '同 lift 下 floor 越大地板越大');
  assertTrue(cloudHemiFloorFor(0.12) < cloudHemiFloorFor(0.6), '同 lift 下 ground 越大地板越大');
  // 派生实测值（spec §5.1）
  assertTrue(Math.abs(cloudSunFloorFor(0.14) - 0.441) < 1e-12, `normal 档太阳地板 ${cloudSunFloorFor(0.14)}`);
  assertTrue(Math.abs(cloudHemiFloorFor(0.12) - 0.56) < 1e-12, `normal 档半球地板 ${cloudHemiFloorFor(0.12)}`);
  assertTrue(Math.abs(cloudAoFloorFor() - 0.7) < 1e-12, `AO 地板 ${cloudAoFloorFor()}`);
  assertTrue(Math.abs(cloudSunFloorFor(SHADOW_FLOOR) - 0.597) < 1e-12, '全局档太阳地板 0.597');
  assertTrue(Math.abs(cloudHemiFloorFor(HEMI_GROUND) - 0.8) < 1e-12, '全局档半球地板 0.8');
  // normal 档顶面也不动（per-style 跟随的关键：地板由当前 floor 派生，不是字面量）
  const nd = norm([0.7934, 0.5479, 0.3392]);
  const stNormal = 0.14 + 0.956 * nd[1];
  assertEqual(Math.max(stNormal, cloudSunFloorFor(0.14)), stNormal, 'normal 档顶面 max 恒等');
});

test('cloud-shade: soften=0 与 sun-shade/hemi-shade 的既有公式交叉一致（不留第二份公式）', () => {
  for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
    for (const ao of [0, 1, 2, 3]) {
      const ref = sunTermRGBFor(normalIndex, NOON_SUN_DIR, 1, 1)[0]
        * hemiFactorFor(normalIndex, HEMI_GROUND)
        * aoFactorFor(ao);
      const got = cloudShadeFor({
        normalIndex, ao, sunDir: NOON_SUN_DIR, shadowKill: 1,
        shadowFloor: SHADOW_FLOOR, sunIntensity: SUN_INTENSITY, hemiGround: HEMI_GROUND, soften: 0,
      });
      // 容差而非严格相等：两个模块的乘法顺序不同（逐位那条在上一个用例）
      assertTrue(Math.abs(got - ref) < 1e-12, `face${normalIndex} ao${ao}: ${got} vs ${ref}`);
    }
  }
});