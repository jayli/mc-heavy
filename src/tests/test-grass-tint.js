// src/tests/test-grass-tint.js — 草色着色纯函数 + 烘焙产物契约（v3.12）
//
// 背景（用户 2026-11-17）：「我在游戏里的目前用的草方块过于鲜艳了」，参考图
// `/Users/bachi/ttt/b/Grass_Block_JE7_BE6.png`（与 wiki 官方渲染图逐字节相同）。
// 按等轴测三面逐 texel 反解出该图的着色 T = (119.2, 186.6, 101.5)
// （顶面 corr 0.9997 / RMSE 0.83；侧面模型 RMSE 0.86/1.15）。
// 本仓原 tint 是 (134.94, 204.98, 73.08) —— 饱和度 0.644 vs 参考 0.460。
//
// ⚠️ 本仓是 **unlit 管线、无 biome tint uniform** ⇒ 着色必须**预乘进贴图**（离线烘焙），
// 不能像 vanilla 那样运行时乘。故纯函数落 `src/voxel/tint-math.js`（无 DOM 无 fs 无 three），
// node 烘焙器与浏览器单测**共用同一份**（红线 1 / 红线 8）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import { GRASS_TINT, applyTint, retintFringe } from '../voxel/tint-math.js';

/** assertClose 不在 assert.js 里（它是 test-zombies.js 的文件内局部函数），本文件自带 */
function assertClose(actual, expected, tol, message = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${message ? message + ': ' : ''}期望 ${expected}±${tol}，实得 ${actual}`);
  }
}

/** 造一个 1×1 的「贴图」（纯函数只吃 {data,width,height}，不依赖 PNG 类） */
function px(r, g, b, a = 255) {
  return { width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, a]) };
}

test('GRASS_TINT 是从参考图反解的三个通道值', () => {
  assertDeepEqual([...GRASS_TINT], [119.2, 186.6, 101.5], 'GRASS_TINT');
});

test('applyTint：灰度 × T 逐通道四舍五入', () => {
  // 160×119.2/255=74.79→75 / 160×186.6/255=117.08→117 / 160×101.5/255=63.69→64
  const out = applyTint(px(160, 160, 160), GRASS_TINT);
  assertDeepEqual([...out.data], [75, 117, 64, 255], '160 灰度着色');
});

test('applyTint：alpha 原样保留（非 255 也不动）', () => {
  assertEqual(applyTint(px(160, 160, 160, 128), GRASS_TINT).data[3], 128, '半透明 alpha');
  assertEqual(applyTint(px(160, 160, 160, 0), GRASS_TINT).data[3], 0, '全透明 alpha');
});

test('applyTint：不改入参（返回新缓冲）', () => {
  const src = px(160, 160, 160);
  const out = applyTint(src, GRASS_TINT);
  assertDeepEqual([...src.data], [160, 160, 160, 255], '源缓冲未被改写');
  assertTrue(out.data !== src.data, '必须是新缓冲，不是同一份');
});

test('applyTint：黑/白端点', () => {
  assertDeepEqual([...applyTint(px(0, 0, 0), GRASS_TINT).data], [0, 0, 0, 255], '黑');
  // 255×T/255 = T 本身，四舍五入 → 119/187/102
  assertDeepEqual([...applyTint(px(255, 255, 255), GRASS_TINT).data], [119, 187, 102, 255], '白');
});

test('retintFringe：overlay alpha=0 处 base 逐字节原样', () => {
  const base = px(185, 133, 92);      // dirt 色
  const overlay = px(169, 169, 169, 0);
  const out = retintFringe(base, overlay, GRASS_TINT);
  assertDeepEqual([...out.data], [185, 133, 92, 255], 'alpha=0 → base 不动');
});

test('retintFringe：overlay alpha=255 处完全替换为 ovGray×T', () => {
  const base = px(185, 133, 92);
  const overlay = px(169, 169, 169, 255);
  const out = retintFringe(base, overlay, GRASS_TINT);
  // 169×119.2/255=79.0→79 / 169×186.6/255=123.66→124 / 169×101.5/255=67.27→67
  assertDeepEqual([...out.data], [79, 124, 67, 255], 'alpha=255 → ovGray×T');
});

test('retintFringe：alpha=128 处线性混合', () => {
  const base = px(200, 200, 200);
  const overlay = px(100, 100, 100, 128);
  const out = retintFringe(base, overlay, GRASS_TINT);
  const a = 128 / 255;
  for (let c = 0; c < 3; c++) {
    const expect = Math.round(200 * (1 - a) + 100 * GRASS_TINT[c] / 255 * a);
    assertEqual(out.data[c], expect, `通道 ${c} 线性混合`);
  }
});

test('retintFringe：输出 alpha 恒 255（草方块侧面是不透明的）', () => {
  const out = retintFringe(px(185, 133, 92, 255), px(169, 169, 169, 77), GRASS_TINT);
  assertEqual(out.data[3], 255, '输出不透明');
});

test('retintFringe：不改入参', () => {
  const base = px(185, 133, 92);
  const overlay = px(169, 169, 169, 255);
  retintFringe(base, overlay, GRASS_TINT);
  assertDeepEqual([...base.data], [185, 133, 92, 255], 'base 未被改写');
  assertDeepEqual([...overlay.data], [169, 169, 169, 255], 'overlay 未被改写');
});

test('两个函数都保住宽高（多像素）', () => {
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([160, 160, 160, 255, 0, 0, 0, 255]) };
  const out = applyTint(src, GRASS_TINT);
  assertEqual(out.width, 2, 'width');
  assertEqual(out.height, 1, 'height');
  assertEqual(out.data.length, 8, 'data 长度');
});

test('着色后的草色比原 tint 更不饱和（用户主诉的定量判据）', () => {
  // 原 tint (134.94,204.98,73.08) 饱和度 0.644；新 T 饱和度 0.460
  const sat = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx ? (mx - mn) / mx : 0; };
  const oldSat = sat(134.94, 204.98, 73.08);
  const newSat = sat(...GRASS_TINT);
  assertTrue(newSat < oldSat - 0.15, `新饱和度 ${newSat.toFixed(3)} 应显著低于原 ${oldSat.toFixed(3)}`);
  assertClose(newSat, 0.460, 0.005, '新 tint 饱和度');
});
