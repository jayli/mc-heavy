#!/usr/bin/env node
// tools/ignis-java-reference.mjs — 焰魔「原版 Java 姿态」参考求值器（诊断/取数工具，非门禁）
//
// 用法：node tools/ignis-java-reference.mjs [ModelIgnis.java 路径]
//   缺省路径：~/jaylli/cataclysm1.19.2modding/.../client/model/entity/ModelIgnis.java
//
// 输出 `src/tests/test-ignis-bake.js` 里 `JAVA_REF` 冻结表的原文（px，Bedrock 几何空间）。
// 表里的数字**必须**由本工具复现 —— 改探针点/时刻后重跑、整表替换，不要手改单个数。
//
// ## 为什么要有它（v2.58，用户 2026-11-05「蓄力动作向后抡接近 180°」）
//
// 之前（v2.57）的结论是「Java `SWING_ATTACK` 与 Bedrock `attack6a` **数值逐帧一致**，不是转换缺陷」，
// 于是对蓄力段做衰减打补丁。数值确实一致 —— 但**数值相同 ≠ 姿态相同**：烘焙脚本把它们当作
// 标准右手系的 `Euler(x,y,z,'XYZ')`，而 Java/Bedrock 的约定不是。比对「数值」抓不到这个，
// 必须比对「按各自约定算出来的世界坐标」。本工具给出 Java 一侧的参考真值。
//
// ## Java 一侧的确定语义（Citadel `AdvancedModelBox` + `ModelAnimator`）
//
//   M(bone) = M(parent) · T(pos/16) · Rz(rz) · Ry(ry) · Rx(rx)       ← translateAndRotate 的调用序 Z→Y→X
//   关键帧值 = 与默认姿态**逐轴相加**的欧拉角（不是四元数复合）
//   缓动：`endKeyframe` 里 `inc = sin(frac·π/2)`，`dec = 1−inc`，值 = dec·prev + inc·cur；静态帧 = prev
//   模型空间 **y 向下、前方 = −z**
//
// ## 与 Bedrock 几何空间的换算
//
//   Bedrock 几何的 pivot 恰为 Java 绝对坐标的 `(x, 24 − y, z)`（y 翻转，x/z 不变；实测 right_arm_joint
//   Java (−15.8, −19.5, 4) ↔ Bedrock pivot (−15.8, 43.5, 4)）。同一个 Java 旋转在该空间里是
//   `S_y · R_java · S_y = Rz(−θz) · Ry(+θy) · Rx(−θx)`（X、Z 取反，Y 不变，顺序仍是 Z→Y→X）。
//   骨骼旋转数值在两侧完全相同 —— 正是这一点让「只比数值」得出了错误的结论。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SRC = path.join(os.homedir(),
  'jaylli/cataclysm1.19.2modding/src/main/java/com/github/L_Ender/cataclysm/client/model/entity/ModelIgnis.java');

const num = (s) => parseFloat(String(s).replace(/F$/i, ''));
const NUM = '(-?[\\d.]+)F?';

/** 解析构造函数里的骨骼树：name → {pos, rot（弧度）, parent, cubes} */
function parseBones(text) {
  const ctor = text.slice(text.indexOf('public ModelIgnis()'), text.indexOf('animator = ModelAnimator.create()'));
  const bones = new Map();
  for (const m of ctor.matchAll(/^\s*(\w+) = new AdvancedModelBox\(this\);/gm)) {
    bones.set(m[1], { pos: [0, 0, 0], rot: [0, 0, 0], parent: null, cubes: [] });
  }
  for (const m of ctor.matchAll(/(\w+)\.setTextureOffset\((\d+),\s*(\d+)\)\.addBox\(([^)]*)\);/g)) {
    const a = m[4].split(',').map((s) => num(s.trim()));
    bones.get(m[1]).cubes.push({ origin: a.slice(0, 3), size: a.slice(3, 6), inflate: a[6] || 0 });
  }
  for (const m of ctor.matchAll(new RegExp(`(\\w+)\\.setPos\\(\\s*${NUM},\\s*${NUM},\\s*${NUM}\\s*\\);`, 'g'))) {
    bones.get(m[1]).pos = [num(m[2]), num(m[3]), num(m[4])];
  }
  for (const m of ctor.matchAll(/(\w+)\.addChild\((\w+)\);/g)) bones.get(m[2]).parent = m[1];
  for (const m of ctor.matchAll(new RegExp(`setRotationAngle\\((\\w+),\\s*${NUM},\\s*${NUM},\\s*${NUM}\\s*\\);`, 'g'))) {
    bones.get(m[1]).rot = [num(m[2]), num(m[3]), num(m[4])];
  }
  return bones;
}

/** 解析 `SWING_ATTACK`（非破盾分支）的关键帧语句序列 */
function parseSwing(text) {
  const seg = text.slice(
    text.indexOf('animator.setAnimation(SWING_ATTACK);'),
    text.indexOf('animator.setAnimation(SWING_ATTACK_SOUL);'));
  const body = seg.slice(seg.indexOf('if (!entity.getIsShieldBreak()) {'), seg.indexOf('} else {'));
  const stmts = [];
  for (const m of body.matchAll(/animator\.(\w+)\(([^;]*)\);/g)) {
    if (m[1] === 'rotate') {
      const parts = m[2].split(/,(?![^(]*\))/).map((s) => s.trim());
      const ang = parts.slice(1).map((p) => {
        const r = p.match(/Math\.toRadians\((-?[\d.]+)F?\)/);
        return r ? num(r[1]) * Math.PI / 180 : num(p);
      });
      stmts.push({ kind: 'rotate', name: parts[0], ang });
    } else if (m[1] !== 'setAnimation') {
      stmts.push({ kind: m[1], n: Number(m[2]) || 0 });
    }
  }
  return stmts;
}

/** `ModelAnimator` 语义：tick `tau` 处每骨的「附加欧拉角」（弧度） */
function evalSwing(stmts, tau) {
  const acc = new Map();
  const add = (name, v, w) => {
    const a = acc.get(name) || [0, 0, 0];
    acc.set(name, [a[0] + v[0] * w, a[1] + v[1] * w, a[2] + v[2] * w]);
  };
  let temp = 0, prevTemp = 0, cur = new Map(), prev = new Map();
  const end = (stationary) => {
    if (tau >= prevTemp && tau < temp) {
      if (stationary) {
        for (const [n, v] of prev) add(n, v, 1);
      } else {
        const inc = Math.sin(((tau - prevTemp) / (temp - prevTemp)) * Math.PI / 2);
        for (const [n, v] of prev) add(n, v, 1 - inc);
        for (const [n, v] of cur) add(n, v, inc);
      }
    }
    if (!stationary) prev = new Map(cur);
    cur = new Map();
  };
  const start = (d) => { prevTemp = temp; temp += d; cur = new Map(); };
  for (const s of stmts) {
    if (s.kind === 'startKeyframe') start(s.n);
    else if (s.kind === 'rotate') {
      const v = cur.get(s.name) || [0, 0, 0];
      cur.set(s.name, [v[0] + s.ang[0], v[1] + s.ang[1], v[2] + s.ang[2]]);
    } else if (s.kind === 'endKeyframe') end(false);
    else if (s.kind === 'setStaticKeyframe') { start(s.n); end(true); }
    else if (s.kind === 'resetKeyframe') { start(s.n); end(false); }
  }
  return acc;
}

// ---- 4×4 行主序矩阵 ----
const mul = (a, b) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
};
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; };
const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const apply = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** Java 骨骼世界矩阵（px；Java 模型空间，y 向下）。`anim` = 每骨附加欧拉角表（可空） */
function javaWorld(bones, anim) {
  const world = new Map();
  const get = (name) => {
    if (world.has(name)) return world.get(name);
    const b = bones.get(name);
    const a = anim?.get(name) || [0, 0, 0];
    const local = mul(T(...b.pos), mul(RZ(b.rot[2] + a[2]), mul(RY(b.rot[1] + a[1]), RX(b.rot[0] + a[0]))));
    const m = b.parent ? mul(get(b.parent), local) : local;
    world.set(name, m);
    return m;
  };
  for (const n of bones.keys()) get(n);
  return world;
}

/**
 * 探针点：`bone` 局部坐标里的一点（**Java 局部坐标**，px，y 向下）。
 * 剑尖 = sword 骨骼局部 (0,0,−49)（Java 剑身立方体 z∈[−49,−9]；Bedrock 的 sword 骨骼 cube z∈[−45,12]，
 * pivot z=4 ⇒ 相对 pivot 同为 −49）。
 */
export const PROBES = Object.freeze([
  ['right_arm_joint', 'right_arm_joint', [0, 0, 0]],
  ['right_hand', 'right_hand', [0, 0, 0]],
  ['right_fist', 'right_fist', [0, 0, 0]],
  ['sword_grip', 'sword', [0, 0, 0]],
  ['sword_tip', 'sword', [0, 0, -49]],
  ['head_top', 'head', [0, -8, 0]],
  ['chest_top', 'upperbody', [0, -13, 0]],
  ['left_arm_joint', 'left_arm_joint', [0, 0, 0]],
  ['left_hand', 'left_hand', [0, 0, 0]],
  ['left_fist', 'left_fist', [0, 0, 0]],
]);

/** 采样时刻（秒）：`null` = bind pose（无动画） */
export const TIMES = Object.freeze([null, 0.6, 1.0, 1.5]);

export function referenceTable(src = DEFAULT_SRC) {
  const text = fs.readFileSync(src, 'utf8');
  const bones = parseBones(text);
  const swing = parseSwing(text);
  const out = {};
  for (const t of TIMES) {
    const world = javaWorld(bones, t === null ? null : evalSwing(swing, t * 20));
    const key = t === null ? 'bind' : `t${t}`;
    out[key] = {};
    for (const [name, bone, local] of PROBES) {
      const p = apply(world.get(bone), local);
      // Java → Bedrock 几何空间：y 翻转（pivot 恒为 24 − y）
      out[key][name] = [p[0], 24 - p[1], p[2]].map((v) => Math.round(v * 100) / 100);
    }
  }
  return out;
}

/**
 * Java 源码 bind pose 的整体包围盒（格）：全部**非零尺寸**立方体（与烘焙一致，零厚薄片不烘焙），含 inflate。
 * 用途：独立裁决产物的 bind pose 是否正确（与 `src/tests/test-ignis-bake.js` 的 bind pose 尺寸用例同源）。
 */
export function bindPoseBBoxBlocks(src = DEFAULT_SRC) {
  const bones = parseBones(fs.readFileSync(src, 'utf8'));
  const world = javaWorld(bones, null);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let cubes = 0;
  for (const [name, b] of bones) {
    for (const c of b.cubes) {
      if (c.size.some((v) => v === 0)) continue;
      cubes++;
      for (const x of [c.origin[0] - c.inflate, c.origin[0] + c.size[0] + c.inflate]) {
        for (const y of [c.origin[1] - c.inflate, c.origin[1] + c.size[1] + c.inflate]) {
          for (const z of [c.origin[2] - c.inflate, c.origin[2] + c.size[2] + c.inflate]) {
            const p = apply(world.get(name), [x, y, z]);
            const q = [p[0], -p[1], p[2]];
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
          }
        }
      }
    }
  }
  return { cubes, size: [0, 1, 2].map((k) => (hi[k] - lo[k]) / 16) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = process.argv[2] || DEFAULT_SRC;
  if (!fs.existsSync(src)) {
    console.error(`找不到 ModelIgnis.java：${src}（用第一个参数指定路径）`);
    process.exit(1);
  }
  const table = referenceTable(src);
  const fmt = (p) => `[${p.map((v) => String(v)).join(', ')}]`;
  console.log('// 由 tools/ignis-java-reference.mjs 生成（单位 px，Bedrock 几何空间：y 向上、前方 −z、右臂在 −x）');
  console.log('const JAVA_REF = {');
  console.log('  // 探针：[骨骼名, 该骨骼的 **Java 局部坐标** 偏移（y 向下）]');
  console.log('  probes: {');
  for (const [name, bone, local] of PROBES) console.log(`    '${name}': ['${bone}', ${fmt(local)}],`);
  console.log('  },');
  console.log('  poses: {');
  for (const [key, probes] of Object.entries(table)) {
    console.log(`    '${key}': {`);
    for (const [name, p] of Object.entries(probes)) console.log(`      '${name}': ${fmt(p)},`);
    console.log('    },');
  }
  console.log('  },');
  console.log('};');
  const bb = bindPoseBBoxBlocks(src);
  console.log(`// Java bind pose 包围盒（${bb.cubes} 个非零立方体）宽×高×深 = ${bb.size.map((v) => v.toFixed(4)).join(' × ')} 格`);
}
