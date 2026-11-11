// src/tests/test-guardian-uv.js — 末影守卫：**UV 面序契约**（Tier 2 内容级判据）
//
// ## 为什么必须有这一份
//
// 2026-11-11 实测缺陷：`bake-guardian` 的 `boxUVRects` 是从 `bake-ignis` 照抄的
// **Bedrock** 表，而守卫素材是 **Java + Citadel** —— 两者的 box UV 铺开不是同一套。
// 形态：**576 个角里 563 个 UV 错**，而骨骼数 / 盒数 / 顶点数 / 索引数 / UV 值域 / 指纹
// **全部通过**。只有画面能看出来（躯干亮面朝下、护甲渐变上下颠倒、侧面整体错位）。
//
// ⇒ 结构判据拓不到，必须**逐角**比对「产物 UV」与「Citadel 源码的角→UV 映射」。
//
// ## 判据的权威
//
// `tools/citadel-box-uv.mjs`（逐字摘录 Citadel `BasicModelPart.ModelBox`）。
// 本文件在浏览器里**独立重算**同一张表 —— 刻意不复用 tools/ 那份：
// 两侧共用同一份实现的话，表本身写错时两边一起错，判据就失去判别力
// （AGENTS.md：「对照脚本与被测代码只差一个变量」）。
// 这里的表是**第二份手写副本**，与 tools/ 那份互为对照；两份都被同一批角位置钉住。
//
// ⚠️ 本文件读 `assets/guardian/src/ModelEnder_Guardian.java`（烘焙输入，已入库），
// 用 `resourceUrl()` 取 —— 站点根绝对路径在子路径部署时会 404。
import { test } from './runner.js';
import * as THREE from 'three';
import { assertEqual, assertTrue } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
import { loadGuardianAsset } from '../render/guardian-model.js';

const TEX_SIZE = 256;

/**
 * Citadel `BasicModelPart.ModelBox` 的角→UV 映射（**独立第二份**，见文件头）。
 *
 * 8 角按源码**声明顺序** V0..V7（源码变量名后缀与顺序差一，别按名字读）：
 *   V0=(x,y,z) V1=(f,y,z) V2=(f,f1,z) V3=(x,f1,z)
 *   V4=(x,y,f2) V5=(f,y,f2) V6=(f,f1,f2) V7=(x,f1,f2)
 * 六面（顺序对齐 BoxGeometry 的 +X,−X,+Y,−Y,+Z,−Z）：
 *   +X←EAST  V{5,1,2,6} uv(f6,f11,f8,f12)
 *   −X←WEST  V{0,4,7,3} uv(f4,f11,f5,f12)
 *   +Y←DOWN  V{5,4,0,1} uv(f5,f10,f6,f11)   ← Java y 向下，DOWN 是 y 小的面
 *   −Y←UP    V{2,3,7,6} uv(f6,f11,f7,f10)   ← 注意 v1 > v2，源码原样
 *   +Z←SOUTH V{4,5,6,7} uv(f8,f11,f9,f12)
 *   −Z←NORTH V{1,0,3,2} uv(f5,f11,f6,f12)
 */
const FACES = [
  { face: '+X', n: [1, 0, 0], vi: [5, 1, 2, 6], uv: ['f6', 'f11', 'f8', 'f12'] },
  { face: '-X', n: [-1, 0, 0], vi: [0, 4, 7, 3], uv: ['f4', 'f11', 'f5', 'f12'] },
  { face: '+Y', n: [0, 1, 0], vi: [5, 4, 0, 1], uv: ['f5', 'f10', 'f6', 'f11'] },
  { face: '-Y', n: [0, -1, 0], vi: [2, 3, 7, 6], uv: ['f6', 'f11', 'f7', 'f10'] },
  { face: '+Z', n: [0, 0, 1], vi: [4, 5, 6, 7], uv: ['f8', 'f11', 'f9', 'f12'] },
  { face: '-Z', n: [0, 0, -1], vi: [1, 0, 3, 2], uv: ['f5', 'f11', 'f6', 'f12'] },
];

/** 从 Java 源码解析骨骼与盒（只取本判据需要的字段：origin/size/uv/inflate/mirror） */
function parseCubes(text) {
  const out = [];
  const re = /(\w+)\.setTextureOffset\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)\s*\.addBox\(([^)]*)\)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const args = m[4].split(',').map((s) => Number(s.trim().replace(/[Ff]$/, '')));
    // addBox(x,y,z,w,h,d[,delta][,mirror])
    const [x, y, z, w, h, d] = args;
    const inflate = args.length > 6 ? args[6] : 0;
    const mirror = args.length > 7 ? /true/.test(m[4].split(',')[7]) : false;
    out.push({
      bone: m[1],
      origin: [x, y, z], size: [w, h, d],
      uv: [Number(m[2]), Number(m[3])],
      inflate, mirror,
    });
  }
  return out;
}

/** 一个盒的 8 角（Java 空间 px，含 inflate 与 mirror 的 swap(x,f)） */
function cornersOf(c) {
  const inf = c.inflate || 0;
  const [w, h, d] = c.size;
  let x = c.origin[0] - inf;
  let f = c.origin[0] + w + inf;
  const y = c.origin[1] - inf;
  const f1 = c.origin[1] + h + inf;
  const z = c.origin[2] - inf;
  const f2 = c.origin[2] + d + inf;
  if (c.mirror) { const t = f; f = x; x = t; }
  return [
    [x, y, z], [f, y, z], [f, f1, z], [x, f1, z],
    [x, y, f2], [f, y, f2], [f, f1, f2], [x, f1, f2],
  ];
}

/** 期望的「角位置（格，y 已翻转）→ UV」表，按盒分组 */
function expectedFaces(c) {
  const V = cornersOf(c);
  const [w, h, d] = c.size;
  const u = c.uv[0];
  const v = c.uv[1];
  const b = {
    f4: u, f5: u + d, f6: u + d + w, f7: u + d + w + w,
    f8: u + d + w + d, f9: u + d + w + d + w,
    f10: v, f11: v + d, f12: v + d + h,
  };
  // 盒中心（Java 空间 px，y 向下）—— 推法线用
  const bc = [c.origin[0] + w / 2, c.origin[1] + h / 2, c.origin[2] + d / 2];
  return FACES.map((spec) => {
    const [u1, v1, u2, v2] = spec.uv.map((k) => b[k]);
    const uv = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]];
    // ⚠️⚠️ **mirror 不对调 UV**：Citadel 对调的是整个 {position, uv} 元素，
    // 「角位置 ↔ UV」配对不变（只改绕序）。mirror 对 UV 的影响已由
    // cornersOf() 的 swap(x,f) 体现；再对调一次会把 7 个 mirror 盒上下翻转。
    const raw = spec.vi.map((vi) => V[vi]);
    // ⚠️⚠️ **法线必须由角位置推，不能用 spec.n**（2026-11-11 实测）：
    // mirror 盒的 `swap(x,f)` 让标为 EAST(+X) 的四角落在 x **最小**侧
    // ⇒ 静态法线表会让 7 个 mirror 盒共 80 个角匹配不上。
    let axis = -1;
    for (let k = 0; k < 3; k++) {
      const vals = raw.map((p) => p[k]);
      if (Math.max(...vals) - Math.min(...vals) < 1e-9) { axis = k; break; }
    }
    assertTrue(axis >= 0, `${c.bone} ${spec.face} 四角应共面`);
    const center = raw.reduce((s, p) => s + p[axis], 0) / 4;
    const nJava = [0, 0, 0];
    nJava[axis] = Math.sign(center - bc[axis]) || 1;
    return {
      face: spec.face,
      n: [nJava[0], -nJava[1], nJava[2]],   // y 翻转
      pts: spec.vi.map((vi, k) => ({
        p: [V[vi][0] / 16, -V[vi][1] / 16, V[vi][2] / 16],
        uv: [uv[k][0] / TEX_SIZE, 1 - uv[k][1] / TEX_SIZE],
      })),
    };
  });
}

let cache = null;
async function fixture() {
  if (cache) return cache;
  const res = await fetch(resourceUrl('assets/guardian/src/ModelEnder_Guardian.java'));
  assertTrue(res.ok, 'Java 源码应可取到（烘焙输入已入库）');
  const cubes = parseCubes(await res.text());
  const asset = await loadGuardianAsset();
  cache = { cubes, asset };
  return cache;
}

/**
 * 把产物顶点转回**骨骼局部**坐标（口径 B 需左乘 bindWorld⁻¹）。
 *
 * ⚠️⚠️ UV 判据比的是「**局部**角位置 ↔ UV」（Citadel 的角表是局部的），
 * 而产物自 2026-11-11 改为口径 B（绝对模型坐标，SkinnedMesh 必需）
 * ⇒ 必须先反解回局部，否则角位置全部对不上。
 */
function localVertices(asset) {
  const g = asset.geometry;
  const absolute = asset.metrics.vertexConvention === 'java-model-absolute';
  if (!absolute) {
    return Array.from({ length: g.position.length / 3 }, (_, i) => ({
      p: [g.position[i * 3], g.position[i * 3 + 1], g.position[i * 3 + 2]],
      uv: [g.uv[i * 2], g.uv[i * 2 + 1]],
      n: [g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]],
    }));
  }
  // bind 世界链
  const world = [];
  for (let i = 0; i < asset.bones.length; i++) {
    const b = asset.bones[i];
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...b.localPosition),
      new THREE.Quaternion(...b.bindQuaternion),
      new THREE.Vector3(1, 1, 1));
    world[i] = b.parentIndex === -1
      ? local
      : new THREE.Matrix4().multiplyMatrices(world[b.parentIndex], local);
  }
  const inv = world.map((m) => m.clone().invert());
  const nrmMat = world.map((m) => new THREE.Matrix3().getNormalMatrix(m).clone().invert());
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  return Array.from({ length: g.position.length / 3 }, (_, i) => {
    const bi = g.skinIndex[i * 4];
    v.set(g.position[i * 3], g.position[i * 3 + 1], g.position[i * 3 + 2]).applyMatrix4(inv[bi]);
    n.set(g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]).applyMatrix3(nrmMat[bi]).normalize();
    return {
      p: [v.x, v.y, v.z],
      uv: [g.uv[i * 2], g.uv[i * 2 + 1]],
      // 法线取整到 ±1/0（盒面法线本就是轴对齐，浮点往返后需归一）
      n: [n.x, n.y, n.z].map((x) => (Math.abs(x) < 0.5 ? 0 : Math.sign(x))),
    };
  });
}

test('守卫 UV: Java 源码解析出 24 个盒（判据的前提）', async () => {
  const { cubes } = await fixture();
  assertEqual(cubes.length, 24, '盒数');
  assertEqual(cubes.filter((c) => c.mirror).length, 7, 'mirror 盒数');
  assertEqual(cubes.filter((c) => c.inflate < 0).length, 1, '负 inflate 盒数');
});

test('守卫 UV: 逐角与 Citadel 源码映射全等（576 角，Bedrock 表会红 563 个）', async () => {
  const { cubes, asset } = await fixture();
  const g = asset.geometry;
  assertEqual(g.position.length / 3, 576, '顶点数');
  const locals = localVertices(asset);
  let checked = 0;
  const bad = [];
  for (let ci = 0; ci < cubes.length; ci++) {
    const base = ci * 24;
    const pv = locals.slice(base, base + 24);
    for (const f of expectedFaces(cubes[ci])) {
      const mine = pv.filter((q) => q.n[0] === f.n[0] && q.n[1] === f.n[1] && q.n[2] === f.n[2]);
      assertEqual(mine.length, 4, `${cubes[ci].bone} ${f.face} 应有 4 个顶点`);
      for (const e of f.pts) {
        checked++;
        const hit = mine.find((q) => Math.hypot(q.p[0] - e.p[0], q.p[1] - e.p[1], q.p[2] - e.p[2]) < 1e-6);
        if (!hit) { bad.push(`${cubes[ci].bone} ${f.face} 角缺失`); continue; }
        const du = Math.abs(hit.uv[0] - e.uv[0]);
        const dv = Math.abs(hit.uv[1] - e.uv[1]);
        if (du > 1e-6 || dv > 1e-6) {
          bad.push(`${cubes[ci].bone} ${f.face} Δuv=(${du.toFixed(4)},${dv.toFixed(4)})`);
        }
      }
    }
  }
  assertEqual(checked, 576, '比对的角数');
  assertEqual(bad.length, 0, `UV 不符的角数（前 3 条：${bad.slice(0, 3).join(' / ')}）`);
});

test('守卫 UV: 躯干顶面取「纯色暗块」而不是砖纹（内容级，钉住上下不颠倒）', async () => {
  // upperbody uv(0,0) size 40×32×20。贴图实测：源矩形 [20,0,60,20] 是 2 色纯色块，
  // [60,0,100,20] 是 8 色砖纹。Citadel 的 +Y（Java DOWN）取前者、−Y 取后者。
  //
  // ⚠️⚠️ **判据必须钉 v，不能只钉 u 区间**（实测踩过）：
  // Bedrock 表的 u 区间恰好也对（+Y 也是 [20,60]），错的是 **v 与角序**
  // ⇒ 只钉 u 区间的用例在旧产物上**照样绿**（零判别力）。
  const { cubes, asset } = await fixture();
  const ci = cubes.findIndex((c) => c.bone === 'upperbody');
  assertTrue(ci >= 0, '应有 upperbody');
  const locals = localVertices(asset);
  const base = ci * 24;
  // +Y 面：四个角的 (x,z) → 期望源像素 v。
  // Citadel +Y = Java DOWN，uv(f5,f10,f6,f11) ⇒ v ∈ [0,20]，
  // 且 z 小（−Z，模型前方）配 v=20、z 大配 v=0。
  const upVerts = [];
  for (let i = 0; i < 24; i++) {
    const q = locals[base + i];
    if (q.n[1] !== 1) continue;
    upVerts.push({
      x: q.p[0],
      z: q.p[2],
      u: q.uv[0] * TEX_SIZE,
      v: (1 - q.uv[1]) * TEX_SIZE,
    });
  }
  assertEqual(upVerts.length, 4, '+Y 面顶点数');
  for (const q of upVerts) {
    assertTrue(Math.abs(q.u - (q.x < 0 ? 20 : 60)) < 1e-6,
      `+Y 角 x=${q.x} 的 u 应为 ${q.x < 0 ? 20 : 60}，实测 ${q.u}`);
    // z < 0（前）⇒ v=20；z > 0（后）⇒ v=0
    assertTrue(Math.abs(q.v - (q.z < 0 ? 20 : 0)) < 1e-6,
      `+Y 角 z=${q.z} 的 v 应为 ${q.z < 0 ? 20 : 0}，实测 ${q.v}`);
  }
});

test('守卫 UV: 侧面（±X）逐角 UV 全等（Bedrock 表 v 反、角序错）', async () => {
  // upperbody：d=20, w=40, h=32。
  // Citadel −X = uv(f4,f11,f5,f12) ⇒ u∈[0,20], v∈[20,52]
  //        +X = uv(f6,f11,f8,f12) ⇒ u∈[60,80], v∈[20,52]
  // 角序：vi{0,4,7,3} / {5,1,2,6} ⇒ 不是「矩形 + u 镜像」能表达的。
  //
  // ⚠️ 只钉 u 区间零判别力（Bedrock 的 u 区间也对），必须逐角比 u 与 v。
  const { cubes, asset } = await fixture();
  const ci = cubes.findIndex((c) => c.bone === 'upperbody');
  const locals = localVertices(asset);
  const base = ci * 24;
  const faces = expectedFaces(cubes[ci]);
  for (const label of ['-X', '+X', '-Z', '+Z']) {
    const f = faces.find((q) => q.face === label);
    const mine = [];
    for (let i = 0; i < 24; i++) {
      const q = locals[base + i];
      if (q.n[0] === f.n[0] && q.n[1] === f.n[1] && q.n[2] === f.n[2]) {
        mine.push({ p: q.p, uv: q.uv });
      }
    }
    assertEqual(mine.length, 4, `${label} 面顶点数`);
    for (const e of f.pts) {
      const hit = mine.find((q) => Math.hypot(q.p[0] - e.p[0], q.p[1] - e.p[1], q.p[2] - e.p[2]) < 1e-6);
      assertTrue(!!hit, `${label} 角应存在`);
      assertTrue(Math.abs(hit.uv[0] - e.uv[0]) < 1e-6 && Math.abs(hit.uv[1] - e.uv[1]) < 1e-6,
        `${label} 角(${e.p.map((v) => v.toFixed(2))}) UV 应为 (${e.uv.map((v) => v.toFixed(4))})，`
        + `实测 (${hit.uv.map((v) => v.toFixed(4))})`);
    }
  }
});