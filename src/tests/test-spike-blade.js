// src/tests/test-spike-blade.js — 焰魔尖刺的**剑体几何**契约（Tier 1，v3.27）
//
// 用户 2026-11-21：「每个尖刺要改成焰魔宝剑的上半部分（露出方块的部分），不要露出剑柄，
// 现在的圆锥体的带有纹路的尖刺模型不要了」。
//
// ## 为什么这些判据必须在 Node 层就钉住
//
// 剑体是从既有烘焙产物 `assets/ignis/ignis.json` **抽子几何**得来的（零重烘）。
// 抽取有三个「数值判据全绿而画面全错」的失效形态：
//   ① 取盒范围写宽 ⇒ 护手/剑柄进了几何 ⇒ 玩家蹲下或挖开地面就看到柄（RF-2）；
//   ② 对 raw 顶点再乘一次骨骼链 ⇒ sword_blade 偏 0.466 格（RF-3，见下）；
//   ③ 轴置换写错（x/z 互换）⇒ 剑侧着立，宽面变窄边。
//
// ⚠️⚠️ **bind 姿态下 skinning 是恒等变换**（2026-11-21 实测：全部 1920 顶点经
// `SkinnedMesh.applyBoneTransform` 后与 raw 最大差 **8.882e-16**）—— 产物顶点已是
// **绝对模型坐标**（`bake-ignis.mjs`：「cube 顶点是绝对模型空间坐标，直接写入，不乘骨骼矩阵」）。
// 所以抽子几何**直接取 raw**。这是守卫那条「顶点必须预乘 bind 世界矩阵」的**镜像**：
// 守卫是 Java 局部顶点所以必须乘，焰魔是 Bedrock 绝对顶点所以绝不能乘。
//
// ⚠️ 本文件的辅助函数**独立于被测实现**（自己遍历 raw 数组，不 import 被测模块的内部函数）
// —— 两侧共用同一个错误假设会得出「一致」的假结论（AGENTS.md 已记）。
import { test } from './runner.js';
import { assertEqual, assertTrue, AssertionError } from './assert.js';
import {
  selectBladeBoxes, buildSpikeBladeGeometry, SPIKE_BLADE_BONES,
} from '../render/spike-blade-geometry.js';

/** 浮点比较（`assert.js` 里没有 assertClose，同 test-spike-fx.js 的局部工具） */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

let cached = null;
async function loadAsset() {
  if (cached) return cached;
  const r = await fetch(new URL('../../assets/ignis/ignis.json', import.meta.url));
  cached = await r.json();
  return cached;
}

/** BoxGeometry 每盒 24 顶点（three 的 buildPlane 六面各 4 顶点） */
const VERTS_PER_BOX = 24;

/**
 * 某骨骼名下的全部盒（**独立复算**：自己扫 skinIndex，不用被测模块的选盒逻辑）。
 * @returns {Array<{start:number, zSpan:number, min:number[], max:number[]}>}
 */
function boxesOfBone(asset, boneName) {
  const names = asset.bones.map((b) => b.name);
  const pos = asset.geometry.position;
  const si = asset.geometry.skinIndex;
  const out = [];
  for (let s = 0; s < pos.length / 3; s += VERTS_PER_BOX) {
    if (names[si[s * 4]] !== boneName) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = s; i < s + VERTS_PER_BOX; i++) {
      for (let k = 0; k < 3; k++) {
        const c = pos[i * 3 + k];
        if (c < min[k]) min[k] = c;
        if (c > max[k]) max[k] = c;
      }
    }
    out.push({ start: s, zSpan: max[2] - min[2], min, max });
  }
  return out;
}

/** 按起始下标取两盒的 raw 顶点（顺序 = 传入顺序，每盒 24 个） */
function collectRaw(asset, starts) {
  const pos = asset.geometry.position;
  const out = [];
  for (const s of starts) {
    for (let i = s; i < s + VERTS_PER_BOX; i++) {
      out.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    }
  }
  return out;
}

function minOf(points) {
  return [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])));
}
function maxOf(points) {
  return [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])));
}
const xOf = (g) => g.position.filter((_, i) => i % 3 === 0);
const zOf = (g) => g.position.filter((_, i) => i % 3 === 2);

/** 输出第 i 个顶点在产物里的原下标（两盒顺序拼接） */
function sourceIndexOf(bodyStart, tipStart, i) {
  return i < VERTS_PER_BOX ? bodyStart + i : tipStart + (i - VERTS_PER_BOX);
}

// ==================== 选盒 ====================

test('spike blade: 选盒规则唯一 —— sword 取 z 跨度最大盒，sword_blade 只有一盒', async () => {
  const a = await loadAsset();
  const { bodyStart, tipStart } = selectBladeBoxes(a);
  // 判据从产物自推导，不硬编码 1248/1272（素材换版下标会漂）
  const names = a.bones.map((b) => b.name);
  assertEqual(names[a.geometry.skinIndex[bodyStart * 4]], 'sword');
  assertEqual(names[a.geometry.skinIndex[tipStart * 4]], 'sword_blade');
  assertEqual(SPIKE_BLADE_BONES.body, 'sword');
  assertEqual(SPIKE_BLADE_BONES.tip, 'sword_blade');
  // RF-2：剑身盒 z 跨度必须显著大于同骨骼其余盒（实测 2.5 vs 次名 0.75，差 3.3 倍）
  const spans = boxesOfBone(a, 'sword').map((b) => b.zSpan);
  const best = Math.max(...spans);
  assertTrue(best > 2.0, `剑身盒 z 跨度 ${best} 须 > 2 格`);
  assertEqual(spans.filter((s) => Math.abs(s - best) < 1e-9).length, 1, '最大跨度必须唯一');
  // 选中的确实是那个最大盒（而不是「随便一个 sword 盒」）
  const bodyBox = boxesOfBone(a, 'sword').find((b) => b.start === bodyStart);
  assertClose(bodyBox.zSpan, best, 1e-9, 'bodyStart 必须指向 z 跨度最大的盒');
  // sword_blade 只有一盒 ⇒ tipStart 唯一确定
  assertEqual(boxesOfBone(a, 'sword_blade').length, 1);
});

// ==================== 尺寸与露出 ====================

test('spike blade: 48 顶点 / 24 三角，尺寸取原剑（不缩放）', async () => {
  const g = buildSpikeBladeGeometry(await loadAsset(), 1.6);
  assertEqual(g.position.length / 3, 48);
  assertEqual(g.index.length, 72);
  assertEqual(g.metrics.vertexCount, 48);
  assertEqual(g.metrics.triangleCount, 24);
  assertClose(g.metrics.width, 0.4375, 1e-6, '剑面宽 = 原剑尺寸');
  assertClose(g.metrics.thickness, 0.0625, 1e-6, '剑厚 = 原剑尺寸');
  assertClose(g.metrics.length, 2.655625, 1e-6, '剑身总长');
});

test('spike blade: 露出 1.6 格、埋入 1.055625 格，剑尖在上（RF-2）', async () => {
  const g = buildSpikeBladeGeometry(await loadAsset(), 1.6);
  assertClose(g.metrics.maxY, 1.6, 1e-6, '剑尖恰好 1.6 格');
  assertClose(g.metrics.minY, -1.055625, 1e-6, '埋入深度');
  assertClose(g.metrics.buriedDepth, 1.055625, 1e-6);
  assertClose(g.metrics.halfWidth, 0.21875, 1e-6);
  assertClose(g.metrics.exposeHeight, 1.6, 1e-9);
  // 轴置换正确性：x 是宽、z 是厚（写反会让剑侧着立）
  assertClose(Math.max(...xOf(g)) - Math.min(...xOf(g)), 0.4375, 1e-6, 'x 跨度须是剑面宽');
  assertClose(Math.max(...zOf(g)) - Math.min(...zOf(g)), 0.0625, 1e-6, 'z 跨度须是剑厚');
});

// ==================== 变换正确性 ====================

test('spike blade: 顶点是 raw 的轴置换，没多乘骨骼链（RF-3）', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  const { bodyStart, tipStart } = selectBladeBoxes(a);
  // 独立复算：直接从 raw 取两盒，按 spec §3.3 的公式算一遍
  const raw = collectRaw(a, [bodyStart, tipStart]);
  const mn = minOf(raw);
  const mx = maxOf(raw);
  const L = mx[2] - mn[2];
  const cy = (mn[1] + mx[1]) / 2;
  const cx = (mn[0] + mx[0]) / 2;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    assertClose(g.position[i * 3], p[1] - cy, 1e-6, `顶点 ${i} x`);
    assertClose(g.position[i * 3 + 1], (mx[2] - p[2]) - (L - 1.6), 1e-6, `顶点 ${i} y`);
    assertClose(g.position[i * 3 + 2], p[0] - cx, 1e-6, `顶点 ${i} z`);
  }
  // 负向锚点：若实现里乘了骨骼链，sword_blade 那 24 个顶点会偏 0.466 格 ⇒ 上面必红
});

test('spike blade: 法线同轴置换、UV 原样搬', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  const { bodyStart, tipStart } = selectBladeBoxes(a);
  for (let i = 0; i < 48; i++) {
    const src = sourceIndexOf(bodyStart, tipStart, i);
    assertClose(g.normal[i * 3], a.geometry.normal[src * 3 + 1], 1e-9, `顶点 ${i} 法线 x`);
    assertClose(g.normal[i * 3 + 1], -a.geometry.normal[src * 3 + 2], 1e-9, `顶点 ${i} 法线 y`);
    assertClose(g.normal[i * 3 + 2], a.geometry.normal[src * 3], 1e-9, `顶点 ${i} 法线 z`);
    assertEqual(g.uv[i * 2], a.geometry.uv[src * 2], 'UV 必须原样（产物 UV 已正确）');
    assertEqual(g.uv[i * 2 + 1], a.geometry.uv[src * 2 + 1]);
  }
  // 法线必须是单位长（轴置换保长；写成插值/归一化错会在这里红）
  for (let i = 0; i < 48; i++) {
    const n = [g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]];
    assertClose(Math.hypot(...n), 1, 1e-6, `顶点 ${i} 法线长度`);
  }
});

test('spike blade: 索引全部落在 [0,48)，且三角数守恒', async () => {
  const a = await loadAsset();
  const g = buildSpikeBladeGeometry(a, 1.6);
  for (const i of g.index) assertTrue(i >= 0 && i < 48, `索引 ${i} 越界`);
  // 产物里这两盒共 24 个三角，一个都不能丢
  assertEqual(g.index.length / 3, 24);
  // 每个顶点都必须被至少一个三角引用（漏搬一盒的形态是「顶点在但没人用」）
  const used = new Set(g.index);
  assertEqual(used.size, 48, `只有 ${used.size} 个顶点被索引引用 —— 漏搬了一盒？`);
});

test('spike blade: 露出高度可参数化（改它只改露出段，不改剑粗细）', async () => {
  const a = await loadAsset();
  const g2 = buildSpikeBladeGeometry(a, 2.0);
  assertClose(g2.metrics.maxY, 2.0, 1e-6);
  assertClose(g2.metrics.minY, -(2.655625 - 2.0), 1e-6);
  assertClose(g2.metrics.width, 0.4375, 1e-6, '粗细不随露出高度变');
  assertClose(g2.metrics.thickness, 0.0625, 1e-6);
});