// src/tests/test-dragon-bake.js — 祭坛飞龙烘焙产物契约（Tier 1/2：产物是机制的地基）
//
// 产物在浏览器里 fetch（同构层不 import node 模块；`tools/dragon-fingerprint.mjs` 依赖
// node:fs，浏览器绝不能 import 它 —— AGENTS.md 已记该坑）。
//
// 判据全部是**关系式**（帧数 = length × fps、四元数归一化、loop 闭合、值域），不硬编码
// 「被测代码写入的那个值」（testing-policy §2.5）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual, AssertionError } from './assert.js';

const DEG = Math.PI / 180;

let asset = null;
async function loadAsset() {
  if (asset) return asset;
  const r = await fetch(new URL('../../assets/dragon/dragon.json', import.meta.url));
  asset = await r.json();
  return asset;
}

/** 源素材（入库的 .bbmodel 是 JSON）—— 判据从它自推导，不硬编码常量 */
let source = null;
async function loadSource() {
  if (source) return source;
  const r = await fetch(new URL('../../assets/dragon/src/amethyst_dragon.bbmodel', import.meta.url));
  source = await r.json();
  return source;
}

test('龙烘焙: 动画清单与帧数（frameCount = length × fps）', async () => {
  const d = await loadAsset();
  assertDeepEqual(Object.keys(d.animations).sort(), ['fly', 'glide']);
  assertEqual(d.animations.fly.fps, 30);
  assertEqual(d.animations.glide.fps, 30);
  // fly 1.2s × 30fps = 36；glide 3.0s × 30fps = 90（素材 length 实测 1.2 / 3.0）
  assertEqual(d.animations.fly.frameCount, 36);
  assertEqual(d.animations.glide.frameCount, 90);
});

test('龙烘焙: 只驱动部分骨骼，下标合法，四元数归一化', async () => {
  const d = await loadAsset();
  // ⚠️ 守卫：`Object.entries({})` 不进循环 → 空产物会让下面的遍历**空洞通过**
  assertDeepEqual(Object.keys(d.animations).sort(), ['fly', 'glide']);
  // fly 33 根 / glide 32 根（素材 animators 实测；其余 45 根运行时跟随父级）
  assertEqual(d.animations.fly.boneIndices.length, 33);
  assertEqual(d.animations.glide.boneIndices.length, 32);
  for (const [name, a] of Object.entries(d.animations)) {
    assertTrue(a.boneIndices.every((i) => i >= 0 && i < d.bones.length),
      `${name} boneIndices 越界`);
    // 下标升序且无重复（排序稳定的产物契约）
    for (let i = 1; i < a.boneIndices.length; i++) {
      assertTrue(a.boneIndices[i] > a.boneIndices[i - 1], `${name} boneIndices 非严格升序`);
    }
    assertEqual(a.frames.length, a.frameCount * a.boneIndices.length * 7,
      `${name} frames 扁平数组长度`);
    for (let f = 0; f < a.frameCount; f++) {
      for (let b = 0; b < a.boneIndices.length; b++) {
        const o = (f * a.boneIndices.length + b) * 7;
        const n = Math.hypot(a.frames[o], a.frames[o + 1], a.frames[o + 2], a.frames[o + 3]);
        if (!(Math.abs(n - 1) < 1e-4)) {
          throw new AssertionError(`${name} 帧${f} 骨骼槽${b} 四元数未归一化 n=${n}`);
        }
      }
    }
  }
});

test('龙烘焙: 面序映射正确（产物 UV 逐面等于素材 UV ÷ 128）', async () => {
  const d = await loadAsset();
  const src = await loadSource();
  // ⚠️ **这条是 spec §11 风险 1 的真正落点，不是像素判据**：实测这张贴图近乎均匀紫色
  // （skull 的 north/south/east/west 四区均值 120/117/115/…，两两差 < 6）且素材左右对称
  // → **面序映射错在像素上几乎不可检测**（注入 north↔up 互换后头部 luma 204.3 → 203.7）。
  // 故判据落在产物：逐元素逐面比对 UV 矩形，任何 FACE_ORDER / faceMap 错误都会精确暴露。
  const T = 128;
  const FACE_ORDER = ['east', 'west', 'up', 'down', 'south', 'north'];   // three BoxGeometry 面序
  const PX2B = d.scale / 16;
  const pos = d.geometry.position, uv = d.geometry.uv, skin = d.geometry.skinIndex;
  const boneIdx = new Map(d.bones.map((b, i) => [b.name, i]));
  // 元素 uuid → 所属骨骼名（从 outliner 遍历得到）
  const boneOfElem = new Map();
  (function walk(node) {
    for (const c of node.children || []) {
      if (typeof c === 'string') boneOfElem.set(c, node.name);
      else walk(c);
    }
  })(src.outliner[0]);
  // ⚠️ **顶点顺序 = `src.elements` 数组顺序**（烘焙脚本 `for (const el of elements)`），
  // 不是 outliner 遍历顺序、也不是按骨骼分组 —— 两者不同，按错的顺序遍历会让每个元素
  // 都比对到别的元素的 UV（实测首版就是这么错的：right_fang_up 读到了 skull 的 uv）。
  let checked = 0;
  let vBase = 0;
  for (const el of src.elements) {
    const bi = boneIdx.get(boneOfElem.get(el.uuid));
    assertTrue(bi !== undefined, `元素 ${el.name} 无骨骼归属`);
    {
      // 该元素的 24 个顶点：面 f 占 [vBase + f*4, vBase + f*4 + 4)
      // （这个裸块只是缩进容器，无副作用）
      for (let f = 0; f < 6; f++) {
        const faceName = FACE_ORDER[f];
        const rect = el.faces[faceName].uv;
        assertTrue(Array.isArray(rect) && rect.length === 4, `${el.name} ${faceName} 缺 uv`);
        const [u1, v1, u2, v2] = rect;
        // 该面 4 个顶点的 uv 必须落在这个矩形内（含边界，容差 1e-6）
        const eps = 1e-6;
        const uLo = Math.min(u1, u2) / T - eps, uHi = Math.max(u1, u2) / T + eps;
        // v 轴有 flipY 换算：v_three = 1 − v_px/128 → 矩形 [v1,v2] 映射到 [1−v2/T, 1−v1/T]
        const vLo = 1 - Math.max(v1, v2) / T - eps, vHi = 1 - Math.min(v1, v2) / T + eps;
        for (let k = 0; k < 4; k++) {
          const vi = vBase + f * 4 + k;
          const u = uv[vi * 2], v = uv[vi * 2 + 1];
          if (!(u >= uLo && u <= uHi && v >= vLo && v <= vHi)) {
            throw new AssertionError(
              `${el.name} 面 ${faceName} 顶点${k} 的 uv (${u.toFixed(4)},${v.toFixed(4)}) `
              + `不在素材矩形 u[${uLo.toFixed(4)},${uHi.toFixed(4)}] v[${vLo.toFixed(4)},${vHi.toFixed(4)}] 内`
              + `（面序映射错 / flipY 漏做）`);
          }
          checked++;
        }
      }
      // 该元素的 skinIndex 必须指向它所属的骨骼
      for (let k = 0; k < 24; k++) {
        assertEqual(skin[(vBase + k) * 4], bi, `${el.name} 顶点${k} 的 skinIndex 错`);
      }
      // 位置 bbox 必须等于素材 from/to（换算后）
      const f = el.from, t = el.to;
      const expLo = [f[0] * PX2B, f[1] * PX2B, f[2] * PX2B];
      const expHi = [t[0] * PX2B, t[1] * PX2B, t[2] * PX2B];
      for (let k = 0; k < 24; k++) {
        for (let a = 0; a < 3; a++) {
          const got = pos[(vBase + k) * 3 + a];
          // ⚠️ 容差 1e-6 不是 1e-9：three 的 `BoxGeometry.translate` 会引入 ~1e-7 的
          // 浮点累积误差（实测 right_hind_thigh_c 顶点 y=2.8687500953674316 vs 期望 2.86875）。
          assertTrue(got >= expLo[a] - 1e-6 && got <= expHi[a] + 1e-6,
            `${el.name} 顶点${k} 轴${a} 位置 ${got} 越出 [${expLo[a]},${expHi[a]}]`);
        }
      }
      vBase += 24;
    }
  }
  // ⚠️ 反向判据：防遍历静默空转
  // 每顶点计数一次（24 顶点/元素 × 115 元素 = vertexCount）
  assertEqual(checked, d.metrics.vertexCount, '应校验全部顶点的 uv');
  assertEqual(vBase, d.metrics.vertexCount, '应遍历全部元素');
});

test('龙烘焙: 采样帧在关键帧时刻精确过控制点（catmullrom 的数学性质）', async () => {
  const d = await loadAsset();
  const src = await loadSource();
  // ⚠️ 判据从**源素材**自推导（关系式），不硬编码常量：素材换/参数改，判据自动跟上。
  // catmullrom 在 u=0 处恒等于 p1 ⇒ 凡关键帧时刻恰好落在采样帧上（time × fps 为整数），
  // 产物那一帧必须**精确**等于关键帧值。这抓：单位错（没除 pxPerBlock / 没乘 scale）、
  // 帧偏移、骨骼映射错、channel 漏采。
  const PX2BLOCK = d.scale / 16;
  let checked = 0;
  for (const [name, a] of Object.entries(d.animations)) {
    const anim = src.animations.find((x) => x.name === name);
    assertTrue(anim !== undefined, `素材缺动画 ${name}`);
    for (const animator of Object.values(anim.animators)) {
      const bi = d.bones.findIndex((b) => b.name === animator.name);
      assertTrue(bi >= 0, `骨骼 ${animator.name} 不在产物里`);
      const slot = a.boneIndices.indexOf(bi);
      if (slot < 0) continue;   // 该动画不驱动这根骨骼
      for (const kf of animator.keyframes) {
        const f = kf.time * a.fps;
        if (Math.abs(f - Math.round(f)) > 1e-9 || f >= a.frameCount) continue;
        const dp = kf.data_points[0];
        const o = (Math.round(f) * a.boneIndices.length + slot) * 7;
        if (kf.channel === 'position') {
          const exp = [dp.x || 0, dp.y || 0, dp.z || 0].map((v) => v * PX2BLOCK);
          for (let c = 0; c < 3; c++) {
            const got = a.frames[o + 4 + c];
            if (Math.abs(got - exp[c]) > 1e-9) {
              throw new AssertionError(
                `${name} ${animator.name} position[${c}] t=${kf.time}: 产物 ${got} ≠ 关键帧 ${exp[c]}`);
            }
          }
          checked++;
        } else if (kf.channel === 'rotation') {
          // 欧拉角（度）→ 四元数，用 three（与烘焙同一转换，不是第二份实现）
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            (dp.x || 0) * DEG, (dp.y || 0) * DEG, (dp.z || 0) * DEG, 'XYZ'));
          const exp = [q.x, q.y, q.z, q.w];
          for (let c = 0; c < 4; c++) {
            const got = a.frames[o + c];
            if (Math.abs(got - exp[c]) > 1e-9) {
              throw new AssertionError(
                `${name} ${animator.name} rotation[${c}] t=${kf.time}: 产物 ${got} ≠ 关键帧 ${exp[c]}`);
            }
          }
          checked++;
        }
      }
    }
  }
  // ⚠️ 反向判据：防「遍历静默退化成空操作」（AGENTS.md：排除量 > 0 的同款手法）
  assertTrue(checked > 100, `过控制点只校验了 ${checked} 个关键帧（遍历疑似空转）`);
});

test('龙烘焙: 采样是 catmullrom 而不是线性插值（曲率存在性）', async () => {
  const d = await loadAsset();
  const src = await loadSource();
  // catmullrom 与 lerp 在段内不同（实测 body pos.y 最大差 0.0135 格）。
  // 若烘焙退化成 lerp，本判据 FAIL；若「过控制点」与本条同时通过，采样曲线形状即被钉住。
  let maxCurvature = 0;
  for (const [name, a] of Object.entries(d.animations)) {
    const anim = src.animations.find((x) => x.name === name);
    for (const animator of Object.values(anim.animators)) {
      const kfs = animator.keyframes.filter((k) => k.channel === 'position')
        .sort((p, q) => p.time - q.time);
      if (kfs.length < 3) continue;
      const bi = d.bones.findIndex((b) => b.name === animator.name);
      const slot = a.boneIndices.indexOf(bi);
      if (slot < 0) continue;
      const PX2BLOCK = d.scale / 16;
      for (let f = 0; f < a.frameCount; f++) {
        const t = f / a.fps;
        let i = 0;
        while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++;
        const t0 = kfs[i].time;
        const t1 = i + 1 < kfs.length ? kfs[i + 1].time : anim.length;
        if (!(t1 > t0)) continue;
        const u = (t - t0) / (t1 - t0);
        if (u === 0) continue;   // 控制点上两者相同，无判别力
        const p1 = kfs[i].data_points[0], p2 = kfs[i + 1 < kfs.length ? i + 1 : 0].data_points[0];
        for (const axis of ['x', 'y', 'z']) {
          const lerp = ((p1[axis] || 0) + ((p2[axis] || 0) - (p1[axis] || 0)) * u) * PX2BLOCK;
          const got = a.frames[(f * a.boneIndices.length + slot) * 7 + 4 + { x: 0, y: 1, z: 2 }[axis]];
          maxCurvature = Math.max(maxCurvature, Math.abs(got - lerp));
        }
      }
    }
  }
  assertTrue(maxCurvature > 0.005,
    `catmullrom 与 lerp 的最大差只有 ${maxCurvature.toFixed(6)} 格（疑似退化成线性插值）`);
});

test('龙烘焙: loop 动画的邻居环绕取（接缝处采样连续）', async () => {
  const d = await loadAsset();
  const src = await loadSource();
  // ⚠️ 这条判据**必须自证判别力**：初版写的「首末帧落差 < 0.5」被负向验证实测证明无效
  // （邻居不环绕的注入只差 0.017 格，远小于阈值 → 注入后仍全绿）。
  // 现判据 = 与「环绕取的独立 catmullrom oracle」逐帧比对（容差 1e-9），
  // 并同时断言「不环绕的 oracle」与产物**明显不同**（> 0.01 格）—— 后者证明本条不是空转。
  const PX2BLOCK = d.scale / 16;
  const cr = (p0, p1, p2, p3, u) => {
    const u2 = u * u, u3 = u2 * u;
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
  };
  let maxClampDiff = 0;
  for (const [name, a] of Object.entries(d.animations)) {
    const anim = src.animations.find((x) => x.name === name);
    for (const animator of Object.values(anim.animators)) {
      const kfs = animator.keyframes.filter((k) => k.channel === 'position')
        .sort((p, q) => p.time - q.time);
      if (kfs.length < 3) continue;
      const bi = d.bones.findIndex((b) => b.name === animator.name);
      const slot = a.boneIndices.indexOf(bi);
      if (slot < 0) continue;
      // 素材 loop 动画首末值相同（实测 fly 34/34、glide 33/33）→ 去掉末帧成周期表示
      const vals = kfs.map((k) => k.data_points[0]);
      const times = kfs.map((k) => k.time);
      const periodic = vals.slice(0, -1);
      const ptimes = times.slice(0, -1);
      const n = periodic.length;
      for (let f = 0; f < a.frameCount; f++) {
        const t = f / a.fps;
        let i = 0;
        while (i < n - 1 && ptimes[i + 1] <= t) i++;
        const t0 = ptimes[i];
        const t1 = i + 1 < n ? ptimes[i + 1] : anim.length;
        const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        for (let c = 0; c < 3; c++) {
          const key = ['x', 'y', 'z'][c];
          const wrap = (k) => periodic[((k % n) + n) % n][key] || 0;
          const clamp = (k) => periodic[Math.min(n - 1, Math.max(0, k))][key] || 0;
          const o = (f * a.boneIndices.length + slot) * 7 + 4 + c;
          const expect = cr(wrap(i - 1), wrap(i), wrap(i + 1), wrap(i + 2), u) * PX2BLOCK;
          if (Math.abs(a.frames[o] - expect) > 1e-9) {
            throw new AssertionError(
              `${name} ${animator.name} pos[${c}] 帧${f}: 产物 ${a.frames[o]} ≠ 环绕 oracle ${expect}`);
          }
          const clampVal = cr(clamp(i - 1), clamp(i), clamp(i + 1), clamp(i + 2), u) * PX2BLOCK;
          maxClampDiff = Math.max(maxClampDiff, Math.abs(a.frames[o] - clampVal));
        }
      }
    }
  }
  // 自证判别力：不环绕的 oracle 必须与产物明显不同（实测 0.017 格）
  assertTrue(maxClampDiff > 0.01,
    `环绕与不环绕的采样只差 ${maxClampDiff.toFixed(6)} 格 → 本判据无判别力（阈值需重标）`);
});

test('龙烘焙: 采样值落在关键帧值域内（catmullrom 不发散、单位正确）', async () => {
  const d = await loadAsset();
  // body 骨骼的 position.y 增量：素材关键帧实测 ±2.4927 px（fly）→ 3 倍后 ±0.467 格。
  // catmullrom 过冲很小，取 (0.05, 0.6) 区间：下界防「增量恒 0（没采到）」，
  // 上界防「单位错（没除 pxPerBlock 或没乘 scale → 2.5 或 7.5 格）」。
  const bodyIdx = d.bones.findIndex((b) => b.name === 'body');
  assertTrue(bodyIdx >= 0, '产物必须有 body 骨骼');
  const a = d.animations.fly;
  const slot = a.boneIndices.indexOf(bodyIdx);
  assertTrue(slot >= 0, 'fly 必须驱动 body');
  let maxY = 0;
  for (let f = 0; f < a.frameCount; f++) {
    maxY = Math.max(maxY, Math.abs(a.frames[(f * a.boneIndices.length + slot) * 7 + 5]));
  }
  assertTrue(maxY > 0.05 && maxY < 0.6,
    `fly body y 增量峰值 ${maxY.toFixed(4)} 超出 (0.05, 0.6)（采样错或单位错）`);
});

test('龙烘焙: 增量语义（t=0 帧的旋转增量应接近单位四元数，不是 bind 姿态）', async () => {
  const d = await loadAsset();
  // neck1 的 bind rotation 是 40°，但动画关键帧是 ±10° 的**增量**。
  // 若烘焙误把「bind + 增量」或「纯 bind」写进 frames，t=0 帧的 neck1 四元数会明显偏离单位四元数。
  const neckIdx = d.bones.findIndex((b) => b.name === 'neck1');
  const a = d.animations.fly;
  const slot = a.boneIndices.indexOf(neckIdx);
  assertTrue(slot >= 0, 'fly 必须驱动 neck1');
  const o = slot * 7;   // 帧 0
  const qw = a.frames[o + 3];   // 只判 w 分量（增量四元数应接近单位）
  // 增量四元数应接近单位（|qw| 接近 1）；40° 的 bind 会让 |qw| ≈ cos(20°) ≈ 0.94 以下
  assertTrue(Math.abs(qw) > 0.99, `neck1 t=0 增量四元数 qw=${qw.toFixed(4)}（疑似混入 bind 姿态）`);
});
