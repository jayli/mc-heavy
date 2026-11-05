// src/tests/test-ignis-bake.js — 焰魔烘焙产物契约（Tier 1/2：产物是机制的地基）
//
// 产物在浏览器里 fetch（同构层不 import node 模块；`tools/ignis-fingerprint.mjs` 依赖
// node:fs，浏览器绝不能 import 它 —— AGENTS.md 已记该坑）。
//
// 判据全部是**关系式**或**实测值**（不硬编码「被测代码写入的那个值」）：
//   - 计数类从素材源自推导（骨骼/立方体数），不抄指纹模块的常量；
//   - 几何/姿态类用**实测不变量**（模型高度、命中帧姿态差）。
//
// ## 本文件守的两个「计数全对但模型是坏的」缺陷（spec Review Focus 1 与 2）
//
// 1. **漏 `T(-pivot)`**：Bedrock 的 `pivot` 是绝对模型空间坐标，cube 顶点也是绝对的。
//    骨骼变换写错时模型炸成碎片，而 53 骨骼 / 80 立方体 / 1920 顶点**全部通过**。
//    ⇒ 用 `bindPoseHeightBlocks()` 算 bind pose 下的真实包围盒高度钉住（实测 4.0668 格）。
// 2. **UV 布局错**：六面矩形铺错的形态是贴图错位到邻面，而 UV 全在 [0,1]、指纹全对。
//    ⇒ 单测钉不住，靠 Tier 4 像素实测（`tests/ignis.spec.mjs`）；本文件只钉 UV 值域与
//    「每个立方体的六个面各自覆盖一个非零面积矩形」。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';

let asset = null;
async function loadAsset() {
  if (asset) return asset;
  const r = await fetch(new URL('../../assets/ignis/ignis.json', import.meta.url));
  asset = await r.json();
  return asset;
}

/** 源素材（入库的 Bedrock geo 是 JSON）—— 判据从它自推导，不硬编码常量 */
let source = null;
async function loadSource() {
  if (source) return source;
  const r = await fetch(new URL('../../assets/ignis/src/ignis.geo.json', import.meta.url));
  source = await r.json();
  return source;
}

// ==================== 结构性契约 ====================

test('焰魔烘焙: 产物存在且动画清单是 idle + attack', async () => {
  const d = await loadAsset();
  assertEqual(Object.keys(d.animations).sort().join(','), 'attack,idle');
});

test('焰魔烘焙: 骨骼数 = 素材骨骼数（漏骨骼 ⇒ 静默缺肉）', async () => {
  const d = await loadAsset();
  const s = await loadSource();
  const srcBones = s['geometry.null.ignis'].bones;
  assertEqual(d.bones.length, srcBones.length);
});

test('焰魔烘焙: 骨骼层级完整（parentIndex 恒指向更早的下标，根恒为 0 个）', async () => {
  const d = await loadAsset();
  let roots = 0;
  for (let i = 0; i < d.bones.length; i++) {
    const p = d.bones[i].parentIndex;
    if (p === -1) { roots++; continue; }
    assertTrue(p >= 0 && p < i, `${d.bones[i].name} 的 parentIndex ${p} 不早于自身 ${i}`);
  }
  assertEqual(roots, 1);   // 唯一根 = root
});

test('焰魔烘焙: 顶点/索引数 = 烘焙立方体数 × 24 / 36', async () => {
  const d = await loadAsset();
  const s = await loadSource();
  // 从源素材自推导：含 0 尺寸分量的立方体被跳过
  let baked = 0;
  for (const b of s['geometry.null.ignis'].bones) {
    for (const c of b.cubes || []) {
      if (c.size[0] !== 0 && c.size[1] !== 0 && c.size[2] !== 0) baked++;
    }
  }
  assertEqual(d.geometry.position.length / 3, baked * 24);
  assertEqual(d.geometry.index.length, baked * 36);
  // 与度量字段一致（两处都是「素材事实」）
  assertEqual(d.metrics.bakedCubes, baked);
  assertEqual(d.metrics.cubeCount - d.metrics.skippedCubes, baked);
});

test('焰魔烘焙: 全部 UV 落在 [0,1] 内，且法线是单位向量', async () => {
  const d = await loadAsset();
  for (const v of d.geometry.uv) {
    assertTrue(v >= 0 && v <= 1, `uv 越界 ${v}`);
  }
  const n = d.geometry.normal;
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    assertTrue(Math.abs(len - 1) < 1e-4, `法线长度 ${len}`);
  }
});

test('焰魔烘焙: 索引全部在顶点范围内', async () => {
  const d = await loadAsset();
  const vcount = d.geometry.position.length / 3;
  for (const i of d.geometry.index) {
    assertTrue(i >= 0 && i < vcount, `索引越界 ${i} / ${vcount}`);
  }
});

test('焰魔烘焙: skinIndex 全部是合法骨骼下标（刚性绑定）', async () => {
  const d = await loadAsset();
  const si = d.geometry.skinIndex;
  for (let i = 0; i < si.length; i += 4) {
    assertTrue(si[i] >= 0 && si[i] < d.bones.length, `skinIndex[${i}] = ${si[i]}`);
    // 余下三个权重槽必须是 0（每顶点只绑一根骨骼）
    assertEqual(si[i + 1], 0); assertEqual(si[i + 2], 0); assertEqual(si[i + 3], 0);
  }
});

test('焰魔烘焙: bindQuaternion 归一化，localPosition 有限', async () => {
  const d = await loadAsset();
  for (const b of d.bones) {
    const [x, y, z, w] = b.bindQuaternion;
    assertTrue(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-6, `${b.name} 四元数未归一化`);
    for (const v of b.localPosition) assertTrue(Number.isFinite(v), `${b.name} localPosition 非有限`);
  }
});

// ==================== Review Focus 1：模型没炸开 ====================

/**
 * bind pose 下模型的实际包围盒高度（格）。
 *
 * 把每根骨骼的 `localPosition` + `bindQuaternion` 按层级累乘成世界矩阵，
 * 再把每根骨骼名下的几何顶点变换过去取 y 跨度。
 *
 * ⚠️ **这是本文件最重要的断言**：`geometry.position` 存的是**绝对模型空间**坐标
 * （烘焙期不乘骨骼矩阵），所以只有经过骨骼层级变换后才能真正验证「烘焙的 localPosition
 * 是对的」。漏掉 `T(-pivot)` 的烘焙会在这里算出数倍于 4 格的高度。
 *
 * @returns {number} 高度（格）
 */
function bindPoseHeightBlocks(d) {
  // 骨骼下标 → 世界矩阵（4x4 行主序）
  const mats = d.bones.map(() => null);
  const mul = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
      }
    }
    return o;
  };
  const quatToMat = (q, t) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
      0, 0, 0, 1,
    ];
  };
  const apply = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];

  for (let i = 0; i < d.bones.length; i++) {
    const b = d.bones[i];
    const local = quatToMat(b.bindQuaternion, b.localPosition);
    mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
  }

  // 每个顶点属于哪根骨骼：从 skinIndex 反查
  const vcount = d.geometry.position.length / 3;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const bone = d.geometry.skinIndex[v * 4];
    const p = [d.geometry.position[v * 3], d.geometry.position[v * 3 + 1], d.geometry.position[v * 3 + 2]];
    const w = apply(mats[bone], p);
    if (w[1] < minY) minY = w[1];
    if (w[1] > maxY) maxY = w[1];
  }
  return maxY - minY;
}

test('焰魔烘焙: bind pose 的真实高度 ≈ 4.07 格（漏 T(-pivot) 会炸开数倍）', async () => {
  const d = await loadAsset();
  const h = bindPoseHeightBlocks(d);
  // 实测 4.0668 格（全模型含角与肩甲）。容差 0.05 格够容纳浮点与「某个膨胀件差一点点」。
  assertTrue(Math.abs(h - 4.0668) < 0.05, `bind pose 高度 ${h.toFixed(4)}，期望 ≈4.0668`);
});

test('焰魔烘焙: bind pose 的水平跨度合理（宽 ≈3.73 / 深 ≈5.16 格）', async () => {
  const d = await loadAsset();
  const mats = [];
  const mul = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
      }
    }
    return o;
  };
  const quatToMat = (q, t) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
      0, 0, 0, 1,
    ];
  };
  for (let i = 0; i < d.bones.length; i++) {
    const b = d.bones[i];
    const local = quatToMat(b.bindQuaternion, b.localPosition);
    mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
  }
  const vcount = d.geometry.position.length / 3;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const m = mats[d.geometry.skinIndex[v * 4]];
    const p = [d.geometry.position[v * 3], d.geometry.position[v * 3 + 1], d.geometry.position[v * 3 + 2]];
    const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
    const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const w = maxX - minX;
  const dep = maxZ - minZ;
  assertTrue(Math.abs(w - 3.7329) < 0.1, `宽度 ${w.toFixed(4)}，期望 ≈3.7329`);
  assertTrue(Math.abs(dep - 5.1576) < 0.1, `深度 ${dep.toFixed(4)}，期望 ≈5.1576`);
});

// ==================== 动画契约 ====================

test('焰魔烘焙: idle 帧数 12，且 duration 逐位等于表达式周期（接缝恒 0）', async () => {
  const d = await loadAsset();
  const a = d.animations.idle;
  assertEqual(a.frameCount, 12);
  // ⚠️ fps 必须是非整数（12 / 2π/128 ≈ 244.46）。取整会破坏「duration ≡ 周期」
  assertTrue(a.fps !== Math.round(a.fps), `fps ${a.fps} 被取整了`);
  const duration = a.frameCount / a.fps;
  assertTrue(Math.abs(duration - 2 * Math.PI / 128) < 1e-12,
    `duration ${duration} ≠ 2π/128`);
});

test('焰魔烘焙: attack 帧数 = round(2.75 × 30)，fps 30', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  assertEqual(a.fps, 30);
  assertEqual(a.frameCount, Math.round(2.75 * 30));
});

test('焰魔烘焙: 两条动画的 frames 扁平数组长度自洽', async () => {
  const d = await loadAsset();
  for (const [name, a] of Object.entries(d.animations)) {
    assertEqual(a.frames.length, a.frameCount * a.boneIndices.length * 7, `${name} frames 长度`);
    // 每帧 7 个数 = 四元数 xyz w + 位移 xyz
    assertTrue(a.boneIndices.every((i) => i >= 0 && i < d.bones.length), `${name} boneIndices 越界`);
    for (let i = 1; i < a.boneIndices.length; i++) {
      assertTrue(a.boneIndices[i] > a.boneIndices[i - 1], `${name} boneIndices 非严格升序`);
    }
  }
});

test('焰魔烘焙: 动画四元数全部归一化', async () => {
  const d = await loadAsset();
  for (const [name, a] of Object.entries(d.animations)) {
    for (let o = 0; o < a.frames.length; o += 7) {
      const len = Math.hypot(a.frames[o], a.frames[o + 1], a.frames[o + 2], a.frames[o + 3]);
      assertTrue(Math.abs(len - 1) < 1e-5, `${name} 帧 ${o / 7} 四元数长度 ${len}`);
    }
  }
});

test('焰魔烘焙: idle 覆盖 generala + generalb 的全部骨骼（手臂 + root + head）', async () => {
  const d = await loadAsset();
  const names = d.animations.idle.boneIndices.map((i) => d.bones[i].name).sort();
  // 素材 generala 驱动 left_arm/left_hand/right_arm/right_hand，
  //      generalb 驱动 root/head —— 合并后必须都在
  for (const need of ['left_arm', 'left_hand', 'right_arm', 'right_hand', 'root', 'head']) {
    assertTrue(names.includes(need), `idle 缺骨骼 ${need}（现有 ${names.join(',')}）`);
  }
});

test('焰魔烘焙: idle 的手臂摆动幅度符合表达式（±2.5° ⇒ 峰峰 5°）', async () => {
  const d = await loadAsset();
  const a = d.animations.idle;
  const idx = a.boneIndices.indexOf(d.bones.findIndex((b) => b.name === 'left_arm'));
  assertTrue(idx >= 0, 'idle 未驱动 left_arm');
  // ⚠️ **必须取带符号角（`2·atan2(z, w)`），不能用 `2·atan2(|xyz|, w)`**：
  // 后者是「旋转量」恒非负，会把 −2.5° 和 +2.5° 算成同一个值 → 峰峰只剩 2.5°
  // （实测踩到：烘焙是对的，断言把自己算错了）。left_arm 的表达式在 z 轴。
  let minDeg = Infinity;
  let maxDeg = -Infinity;
  for (let f = 0; f < a.frameCount; f++) {
    const o = (f * a.boneIndices.length + idx) * 7;
    const deg = 2 * Math.atan2(a.frames[o + 2], a.frames[o + 3]) * 180 / Math.PI;
    if (deg < minDeg) minDeg = deg;
    if (deg > maxDeg) maxDeg = deg;
  }
  // 表达式振幅 2.5° ⇒ 峰峰 5.0°。
  assertTrue(Math.abs((maxDeg - minDeg) - 5.0) < 0.05,
    `left_arm 峰峰摆幅 ${(maxDeg - minDeg).toFixed(4)}°（期望 5.0）`);
  // 首帧必须在 0（表达式 sin(0)=0），否则意味着相位错位
  const firstDeg = 2 * Math.atan2(a.frames[idx * 7 + 2], a.frames[idx * 7 + 3]) * 180 / Math.PI;
  assertTrue(Math.abs(firstDeg) < 1e-6, `首帧角度 ${firstDeg}，应为 0`);
});

test('焰魔烘焙: attack 在命中帧（t=1.20s）姿态与首帧显著不同', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  const hitFrame = Math.round(1.20 * a.fps);
  assertTrue(hitFrame < a.frameCount, `命中帧 ${hitFrame} 超出 ${a.frameCount}`);
  // 取所有骨骼的最大四元数分量差
  let maxDelta = 0;
  for (let b = 0; b < a.boneIndices.length; b++) {
    const o0 = (0 * a.boneIndices.length + b) * 7;
    const o1 = (hitFrame * a.boneIndices.length + b) * 7;
    for (let k = 0; k < 4; k++) {
      const delta = Math.abs(a.frames[o1 + k] - a.frames[o0 + k]);
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  assertTrue(maxDelta > 0.15, `命中帧与首帧的最大分量差 ${maxDelta.toFixed(3)}（应显著不同）`);
});

test('焰魔烘焙: attack 的 root 转身幅度 ≈65°（横扫，不是小幅转身）', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  const rootIdx = a.boneIndices.indexOf(d.bones.findIndex((b) => b.name === 'root'));
  assertTrue(rootIdx >= 0, 'attack 未驱动 root');
  // ⚠️ 取**带符号**的绕 Y 角（root 的转身在 y 轴），并记下绝对值最大的那一帧
  let extreme = 0;
  for (let f = 0; f < a.frameCount; f++) {
    const o = (f * a.boneIndices.length + rootIdx) * 7;
    const deg = 2 * Math.atan2(a.frames[o + 1], a.frames[o + 3]) * 180 / Math.PI;
    if (Math.abs(deg) > Math.abs(extreme)) extreme = deg;
  }
  // 素材 attack6a 的 root.rotation.y 峰值 −65°（配得上 arc 70° 的横扫）。
  // ⚠️ 断言**符号**：正向 65°（往反方向扫）与素材不符，说明取了错的分量或错的关键帧。
  assertTrue(extreme < 0, `root 最大转角应在负方向，实测 ${extreme.toFixed(2)}°`);
  assertTrue(Math.abs(extreme) > 55 && Math.abs(extreme) < 75,
    `root 最大转角 ${extreme.toFixed(2)}°（期望 ≈−65°）`);
});

test('焰魔烘焙: 产物的 scale 与度量一致（1 倍，产物已含、运行时不再乘）', async () => {
  const d = await loadAsset();
  assertEqual(d.scale, 1);
  assertEqual(d.metrics.scale, 1);
});
