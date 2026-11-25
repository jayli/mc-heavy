// src/tests/test-puddle-reflect.js — 积水真倒影（方案 A：复用 ocean reflector RT）Tier 1
//
// 设计稿/复盘：docs/retro-2026-11-23-puddle-mirror-reflection.md
//
// ⚠️ 本文件只守**常量关系与门控**；「是不是真倒影」由 Tier 4 的**内容级判据**承担
// （改变场景内容 ⇒ 倒影跟着变）。亮度类判据对那个缺陷零判别力（用户两次退回的教训）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  PUDDLE_REFLECT_STRENGTH, PUDDLE_REFLECT_EDGE_FADE,
} from '../render/puddle-reflect.js';
import { REFLECT_MIP_LEVEL } from '../render/water-reflect-config.js';

function assertClose(a, b, eps = 1e-9, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg ? msg + ': ' : ''}期望 ${b}±${eps}，实际 ${a}`);
}

test('puddle reflect: 强度有界（mix 不钳白）', () => {
  assertTrue(PUDDLE_REFLECT_STRENGTH > 0 && PUDDLE_REFLECT_STRENGTH < 1,
    `强度 ${PUDDLE_REFLECT_STRENGTH} 须 ∈(0,1)`);
});

test('puddle reflect: 边缘淡出带合法（贴边淡出，避免取垃圾像素）', () => {
  assertTrue(PUDDLE_REFLECT_EDGE_FADE > 0 && PUDDLE_REFLECT_EDGE_FADE < 0.5,
    `淡出带 ${PUDDLE_REFLECT_EDGE_FADE} 须 ∈(0,0.5)`);
});

test('puddle reflect: 复用既有 mip 常量（不新写第二份朦胧度权威）', () => {
  // 红线 1：朦胧度与水面倒影同源，避免两处漂移
  assertTrue(Number.isFinite(REFLECT_MIP_LEVEL) && REFLECT_MIP_LEVEL >= 1,
    'mip 须 ≥1 才提供用户要的「模糊一些」');
});

test('puddle reflect: uPuddleReflect 初值 1，且既有两级锚点不变', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  assertTrue(!!U.uPuddleReflect, '必须有 uPuddleReflect 句柄（第三级零回归锚点）');
  assertEqual(U.uPuddleReflect.value, 1, '真倒影默认开');
  assertEqual(U.uWetPuddleRefl.value, 1, '既有积水开关不变');
  assertEqual(U.uWet.value, 0, '总强度默认仍 0（第一级锚点）');
});

test('puddle reflect: 权重恒有界（全组合扫描）', async () => {
  // CPU 同构：k = STRENGTH × puddleW × uStrength × edge，钳 ≤ STRENGTH
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const edgeAt = (u, v) => {
    const d = Math.min(u, 1 - u, v, 1 - v);
    return clamp01(d / PUDDLE_REFLECT_EDGE_FADE);
  };
  let maxK = 0;
  for (const puddleW of [0, 0.2, 0.5, 0.7682, 1]) {
    for (const strength of [0, 0.5, 1]) {
      for (const u of [0, 0.03, 0.5, 0.97, 1]) {
        const k = Math.min(
          PUDDLE_REFLECT_STRENGTH * puddleW * strength * edgeAt(u, 0.5),
          PUDDLE_REFLECT_STRENGTH,
        );
        assertTrue(k >= 0 && k <= PUDDLE_REFLECT_STRENGTH + 1e-12, `k=${k} 越界`);
        maxK = Math.max(maxK, k);
      }
    }
  }
  assertClose(maxK, PUDDLE_REFLECT_STRENGTH, 1e-9, '上界须真的可达（否则判据恒真）');
});

test('puddle reflect: 三条归零门（关档 / 无积水 / 强度 0）', () => {
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const k = (puddleW, strength) => Math.min(
    PUDDLE_REFLECT_STRENGTH * clamp01(puddleW) * clamp01(strength) * 1, PUDDLE_REFLECT_STRENGTH);
  assertEqual(k(0, 1), 0, '无积水（含墙面：topGate 已乘进 puddleW）');
  assertEqual(k(0.7682, 0), 0, '强度 0 ⇒ 逐位回到 v3.32b');
  assertTrue(k(0.7682, 1) > 0, '正常条件须有倒影');
});

test('puddle reflect: 反射替身材质与主材质同构（只差 RT 采样）', async () => {
  // 守卫：替身必须由同一个 createVoxelMaterials 造，且不传 reflectTexture
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../render/render-world.js', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');
  assertTrue(/createVoxelMaterials\(this\.atlasTexture,\s*this\._sunLight\s*\|\|\s*null,\s*null\)/.test(code),
    '替身材质须用同一个 createVoxelMaterials 且第三参为 null（保证除 RT 外着色完全一致）');
  assertTrue(/beginReflectMaterialSwap\(\)/.test(code), '必须提供材质替身入口');
});

test('puddle reflect: 装配层在反射 pass 前后成对调用守卫与替身', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../core/game.js', import.meta.url), 'utf8');
  const i = src.indexOf('beginReflectGuard()');
  // ⚠️ **窗口按「到 endReflectGuard() 为止」取，不用固定字符数**（v3.41 实测踩坑）：
  // 原写法 `slice(i, i + 900)` 在本段插入阴影刷新权隔离的注释后，`endReflectGuard()`
  // 落到 900 字符之外（实测跨度 1388）⇒ 判据对**正确的代码**真红。
  // 固定窗口会把「注释变长」误报成「守卫漏调」——判据须锚在结构上，不锚在字节数上。
  const end = src.indexOf('endReflectGuard()', i);
  assertTrue(end > i, 'beginReflectGuard() 之后必须能找到 endReflectGuard()');
  const seg = src.slice(i, end + 'endReflectGuard()'.length);
  assertTrue(seg.includes('beginReflectMaterialSwap()'), '守卫后必须换替身材质');
  assertTrue(/finally\s*\{[\s\S]*?swap\(\)[\s\S]*?endReflectGuard\(\)/.test(seg),
    '必须在 finally 里先恢复材质再结束守卫（异常时不留永久替身）');
  // v3.41：反射期必须冻结阴影刷新权并在 finally 里写回（否则替身 ShadowNode 抢走主贴图刷新）
  assertTrue(/needsUpdate\s*=\s*false[\s\S]*?finally\s*\{[\s\S]*?needsUpdate\s*=\s*\w+/.test(seg),
    '反射期须冻结 shadow.needsUpdate 并在 finally 写回（v3.41 阴影刷新权隔离）');
});