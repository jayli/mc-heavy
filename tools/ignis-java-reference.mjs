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
import {
  parseBones, parseAnimation, evalKeyframes, javaWorld, applyMat,
  bindPoseBBoxBlocks as bboxOf,
} from './java-model-parse.mjs';

const DEFAULT_SRC = path.join(os.homedir(),
  'jaylli/cataclysm1.19.2modding/src/main/java/com/github/L_Ender/cataclysm/client/model/entity/ModelIgnis.java');

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
  const bones = parseBones(text, 'ModelIgnis');
  const swing = parseAnimation(text, 'SWING_ATTACK', { branch: 'if (!entity.getIsShieldBreak()) {' });
  const out = {};
  for (const t of TIMES) {
    const world = javaWorld(bones, t === null ? null : evalKeyframes(swing, t * 20));
    const key = t === null ? 'bind' : `t${t}`;
    out[key] = {};
    for (const [name, bone, local] of PROBES) {
      const p = applyMat(world.get(bone), local);
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
  return bboxOf(parseBones(fs.readFileSync(src, 'utf8'), 'ModelIgnis'));
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
