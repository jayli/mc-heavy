#!/usr/bin/env node
// tools/bake-ignis.mjs — 焰魔（Ignis）烘焙（npm run ignis）
//
// 输入 `assets/ignis/src/`：Bedrock 附加包的三份文件
//   - ignis.geo.json       几何（53 骨骼 / 88 立方体 / 256² 贴图 / uv 只有起点 + 尺寸）
//   - ignis.animation.json 动画（84 条；本仓取 generala+generalb → idle，attack6a → attack）
//   - ignis_idle_0.png     贴图（256²，八帧火焰闪烁里取第 0 帧）
// 输出到 `assets/ignis/`：
//   - ignis.json  骨骼层级 + 合并几何（position/normal/uv/skinIndex/index）+ 动画
//   - ignis.png   贴图
//   - ignis.meta.json  度量 + 输入指纹（check:data 的 [焰魔] 守过期）
//
// 参数与指纹的唯一权威 = `tools/ignis-fingerprint.mjs`（红线 1，与本脚本共用）。
//
// ==================== 与飞龙烘焙器（bake-dragon.mjs）的四处关键差异 ====================
//
// 1. **立方体 UV 只有起点**：Bedrock 的 `cube.uv = [u, v]` 是 UV 图集的起点，
//    六个面的矩形由尺寸 `(dx, dy, dz)` 自动铺开（见 `boxUVRects()`）。
//    飞龙的 bbmodel 是每面独立矩形 —— 两者的映射逻辑完全不同，不能复用。
//
// 2. **`inflate` 是「向外均匀外扩」**：盒从 `origin - inflate` 到 `origin + size + inflate`，
//    即尺寸 = `size + 2*inflate`、中心不变。写成 `size + inflate` 会让 18 个外扩部件
//    （肩甲/胸甲/护腿）内缩半格，观感是装甲嵌进身体。
//
// 3. **`mirror`**：u 方向翻转（22 个镜像件）。
//
// 4. **零尺寸立方体必须跳过**：8 个薄片含 0 尺寸分量（如 `right_helmet` 的 `[0,5,7]`），
//    `BoxGeometry` 对 0 尺寸会产出退化三角形（法线 NaN、光栅化不显示但吃顶点预算）。
//
// ==================== 骨骼变换：本脚本最易错的一处 ====================
//
// ⚠️ **Bedrock 的 `pivot` 是绝对模型空间坐标，`cube.origin` 也是绝对模型空间坐标。**
//    而 three 的 `Bone.position` 是**相对父骨骼**的偏移。
//
//    骨骼链的正确语义（渲染时）：`M(bone) = M(parent) · T(pivot) · R(rot) · T(-pivot)`，
//    其中 `T(-pivot)` 让旋转**绕 pivot** 而不是绕模型原点。实测：漏掉它时模型炸成碎片
//    （每个部件被甩到别处），而 53 骨骼 / 80 立方体 / 1920 顶点**全部通过**。
//
//    本脚本做的是等价变换：把 `T(pivot)·R·T(-pivot)` 的**平移部分**吸收进
//    `localPosition`，把**旋转部分**存成 `bindQuaternion`。推导：
//
//      M(i) = M(p) · T(pi) · R(ri) · T(-pi)
//           = M(p) · T(pi - R(ri)·pi) · R(ri)
//     ⇒ `bindQuaternion_i = ri`
//        `localPosition_i = pi - R(ri)·pi`   （父空间里的偏移）
//
//    ⚠️ **`localPosition` 不需要再乘父级旋转的逆** —— 因为 cube 顶点是绝对坐标，
//    整条链的输出必须在**模型空间**对齐，而 `T(pi - R·pi)` 正是在父空间里表达的。
//    飞龙的 bbmodel 需要 `R_parentWorld⁻¹` 修正是因为它的元素顶点是**相对骨骼 origin**
//    的局部坐标；Bedrock 是绝对坐标，两者的修法不同，不得互相套用。
//
//    验证：`src/tests/test-ignis-bake.js` 的 `bindPoseHeightBlocks()` 把这条链累乘后
//    算真实包围盒（实测 3.73 × 4.07 × 5.16 格）。写错必红。
//
// ==================== 动画语义 ====================
//
// - 关键帧是**相对 bind pose 的增量**（运行期 `bindQuat * deltaQuat`，与飞龙同口径）。
//   验证：`head` 的 bind rotation 是 −20.00196°，而 `attack6a` 给它数值关键帧；
//   若是绝对语义，头会在挥砍时从 −20° 跳到关键帧值（不合理）。
// - **idle 是两条动画合并**（generala 驱动手臂、generalb 驱动 root/head）：
//   Bedrock 的 `animate` 列表会同时播放，本仓产物每帧只采一条，故合并。
// - **idle 的 fps 不是整数**：由 `idleFrameCount / (2π/128)` 算出，使产物
//   `duration` 与表达式周期逐位相等（循环接缝恒 0）。详见 spec §4.2。
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from '../vendor/three/three.core.js';
import {
  IGNIS_GEO_SRC, IGNIS_ANIM_SRC, IGNIS_TEX_SRC,
  IGNIS_JSON, IGNIS_PNG, IGNIS_META,
  IGNIS_BAKE_PARAMS, IGNIS_METRICS, IGNIS_ANIM_PERIODS, IGNIS_ANIM_SOURCES,
  ignisInputFingerprint,
} from './ignis-fingerprint.mjs';
import { compileMolang } from './molang-eval.mjs';

const { scale, pxPerBlock, textureSize, idleFrameCount } = IGNIS_BAKE_PARAMS;
/** px → 格（已含 scale 倍）。运行时不再乘 scale */
const PX2BLOCK = scale / pxPerBlock;
const DEG = Math.PI / 180;

/** 攻击动画的重采样帧率（素材是纯数值关键帧，30fps 足够） */
const ATTACK_FPS = IGNIS_BAKE_PARAMS.defaultFps;

/**
 * `BoxGeometry` 的面序固定为 `[+x, −x, +y, −y, +z, −z]`
 * （`three.core.js` 的 `buildPlane` 调用序）。
 *
 * 本表把 `BoxGeometry` 的面序映射到 **Bedrock box UV 布局**里的位置。
 *
 * ⚠️⚠️ **这张表是软件光栅化实测标定的，不要凭 Minecraft 文档「推导」重排。**
 * 已知的错误推导：按 Java `ModelPart.Cube` 源码的顺序（down, up, west, north, east, south）
 * 铺 —— 实测渲染出来**眼睛跑到头两侧**。正确的 Bedrock 布局是：
 *
 *   源矩形起点（`u0, v0` 是 `cube.uv`），`dx/dy/dz` = 立方体三个尺寸：
 *     面序 0 `+X` (east)  : (u0+dz+dx,        v0+dz)  w=dz h=dy
 *     面序 1 `−X` (west)  : (u0,             v0+dz)  w=dz h=dy
 *     面序 2 `+Y` (up)    : (u0+dz+dx,        v0)     w=dx h=dz
 *     面序 3 `−Y` (down)  : (u0+dz,           v0)     w=dx h=dz
 *     面序 4 `+Z` (south) : (u0+dz+dx+dz,     v0+dz)  w=dx h=dy
 *     面序 5 `−Z` (north) : (u0+dz,           v0+dz)  w=dx h=dy
 *
 * 验证方式（本脚本已在实施期跑过，结论见 spec §2.0）：把产物用软件光栅化渲染成正视图，
 * 应当看到「脸 + 双眼 + 双角 + 肩甲 + 剑 + 盾」。
 */
const BEDROCK_FACE_ORDER = Object.freeze(['east', 'west', 'up', 'down', 'south', 'north']);

function fail(msg) { throw new Error(`[焰魔烘焙] ${msg}`); }

/**
 * Bedrock 的 box UV 铺开：给定起点与尺寸，返回六个面的源矩形 `[u0,v0,u1,v1]`（源像素）。
 *
 * 数组下标 = `BoxGeometry` 面序（+X, −X, +Y, −Y, +Z, −Z），映射见 `BEDROCK_FACE_ORDER`。
 *
 * @param {number} u @param {number} v 立方体 `uv` 起点
 * @param {number} dx @param {number} dy @param {number} dz 立方体尺寸
 * @returns {Array<[number,number,number,number]>}
 */
function boxUVRects(u, v, dx, dy, dz) {
  return [
    // 0 +X (east): 右侧条
    [u + dz + dx, v + dz, u + dz + dx + dz, v + dz + dy],
    // 1 −X (west): 左侧条
    [u, v + dz, u + dz, v + dz + dy],
    // 2 +Y (up): 上条右格
    [u + dz + dx, v, u + dz + dx + dx, v + dz],
    // 3 −Y (down): 上条左格
    [u + dz, v, u + dz + dx, v + dz],
    // 4 +Z (south): 下条最右格
    [u + dz + dx + dz, v + dz, u + dz + dx + dz + dx, v + dz + dy],
    // 5 −Z (north): 下条中间格（正面 —— 脸在这里）
    [u + dz, v + dz, u + dz + dx, v + dz + dy],
  ];
}

/**
 * 把一条数值关键帧序列转成「周期表示」。
 *
 * 与 `bake-dragon.mjs` 的 `toPeriodic` 同手法：loop 动画首末值相同时去掉末帧，
 * 邻居环绕取，这样 t=0 的前一帧是末帧而不是重复值。
 *
 * @param {Array<{time: number, value: number[]}>} kfs 已按 time 升序
 * @param {number} length 动画时长
 */
function toPeriodic(kfs, length) {
  if (kfs.length === 0) return null;
  const first = kfs[0].value;
  const last = kfs[kfs.length - 1].value;
  const closed = kfs.length >= 2
    && Math.abs(kfs[kfs.length - 1].time - length) < 1e-9
    && first.every((v, i) => Math.abs(v - last[i]) < 1e-9);
  if (closed) {
    return {
      times: kfs.slice(0, -1).map((k) => k.time),
      values: kfs.slice(0, -1).map((k) => k.value),
      period: length,
      clamp: false,
    };
  }
  return { times: kfs.map((k) => k.time), values: kfs.map((k) => k.value), period: length, clamp: true };
}

/** 标准 Catmull-Rom 样条求值（Blockbench / Bedrock 的 `catmullrom` 口径） */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1)
    + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/** 在周期序列上按 catmullrom 采样一个三分量通道 */
function sampleChannel3(seq, t) {
  const n = seq.times.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return seq.values[0].slice();
  let i = 0;
  while (i < n - 1 && seq.times[i + 1] <= t) i++;
  const t0 = seq.times[i];
  const t1 = i + 1 < n ? seq.times[i + 1] : seq.period;
  const span = t1 - t0;
  const u = span > 0 ? (t - t0) / span : 0;
  const at = (k) => {
    if (seq.clamp) return seq.values[Math.min(n - 1, Math.max(0, k))];
    return seq.values[((k % n) + n) % n];
  };
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  return [0, 1, 2].map((c) => catmullRom(p0[c] || 0, p1[c] || 0, p2[c] || 0, p3[c] || 0, u));
}

/**
 * 收集一条 Bedrock 动画里某骨骼的通道。
 *
 * Bedrock 的关键帧结构有两种形态：
 *   - `{ "0.0": [x,y,z], "0.5": [x,y,z], ... }`（按时间索引的对象）
 *   - `[x, y, z]`（单帧常量）
 * 值可以是数字，也可以是 **Molang 表达式字符串**（待机动画就是这种）。
 *
 * @param {object} bone 动画里的骨骼条目
 * @param {string} channel `rotation` | `position`
 * @param {number} length 动画时长（用于把单帧常量展开）
 * @returns {{times: number[], values: number[][], clamp: boolean}|null}
 */
function collectChannel(bone, channel, length) {
  const raw = bone[channel];
  if (raw === undefined || raw === null) return null;

  const asTriple = (val, timeLabel) => {
    if (Array.isArray(val)) {
      return val.map((component, axis) => {
        if (typeof component === 'number') return component;
        if (typeof component === 'string') {
          // Molang：烘焙期求值。scope 里的 lifeTime 就是采样时刻
          const fn = compileMolang(component);
          return fn({ lifeTime: Number(timeLabel) || 0 });
        }
        fail(`${channel} 的关键帧分量类型 ${typeof component} 不支持（骨骼 ${bone._name}）`);
        return 0;
      });
    }
    if (typeof val === 'number') return [val, 0, 0];
    fail(`${channel} 的关键帧值类型 ${typeof val} 不支持（骨骼 ${bone._name}）`);
    return [0, 0, 0];
  };

  // 形态 A：单帧常量数组
  if (Array.isArray(raw)) {
    const triple = asTriple(raw, 0);
    return { times: [0], values: [triple], clamp: true };
  }
  // 形态 B：按时间索引的对象
  if (typeof raw === 'object') {
    // ⚠️ **必须保留原始键**：`Number('0.0')` = 0，`String(0)` = '0' —— 用
    // `raw[String(t)]` 回查会取不到 '0.0'（实测踩到：attack6a 的 root.rotation 首键
    // 就是 '0.0'，导致把 undefined 当关键帧）。故同时保存原键与数值时间。
    const entries = Object.keys(raw)
      .map((key) => ({ key, time: Number(key) }))
      .filter((e) => Number.isFinite(e.time))
      .sort((a, b) => a.time - b.time);
    if (entries.length === 0) return null;
    const values = entries.map((e) => asTriple(raw[e.key], e.time));
    return toPeriodic(entries.map((e, i) => ({ time: e.time, value: values[i] })), length);
  }
  return null;
}

/**
 * 把一组 Bedrock 动画重采样成定长帧序列。
 *
 * @param {object} anims `animation.null.ignis.*` 的完整表
 * @param {string[]} names 要合并的动画短名（如 `['generala','generalb']`）
 * @param {number} frameCount 帧数
 * @param {number} fps 帧率（idle 是导出的非整数）
 * @param {Map<string, number>} boneNameToIndex
 * @returns {{fps: number, frameCount: number, boneIndices: number[], frames: number[]}}
 */
function resampleAnimation(anims, names, frameCount, fps, boneNameToIndex) {
  // 合并多条动画：同一骨骼在两条里都出现时，后者的通道覆盖前者（实测只有 generala/b 的
  // 骨骼集合互斥，故「覆盖」实际不会发生 —— 但语义明确比隐式合并安全）。
  const perBone = new Map();   // boneIndex → {rot: seq|null, pos: seq|null, length}
  for (const short of names) {
    const full = `animation.null.ignis.${short}`;
    const anim = anims[full];
    if (!anim) fail(`素材缺动画 ${full}`);
    const length = Number(anim.animation_length);
    if (!Number.isFinite(length) || length <= 0) {
      fail(`动画 ${full} 缺 animation_length（Molang 待机动画必须有长度才能重采样）`);
    }
    for (const [boneName, ch] of Object.entries(anim.bones || {})) {
      const bi = boneNameToIndex.get(boneName);
      if (bi === undefined) fail(`动画 ${full} 的骨骼 "${boneName}" 不在几何里`);
      const tagged = { ...ch, _name: boneName };
      const rot = collectChannel(tagged, 'rotation', length);
      const pos = collectChannel(tagged, 'position', length);
      const prev = perBone.get(bi);
      perBone.set(bi, {
        rot: rot || prev?.rot || null,
        pos: pos || prev?.pos || null,
      });
    }
  }
  if (perBone.size === 0) fail(`动画 ${names.join('+')} 没有驱动任何骨骼`);

  // 严格升序的骨骼下标（产物契约）
  const boneIndices = [...perBone.keys()].sort((a, b) => a - b);
  const slotOf = new Map(boneIndices.map((bi, slot) => [bi, slot]));
  const frames = new Array(frameCount * boneIndices.length * 7);
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    for (const bi of boneIndices) {
      const ch = perBone.get(bi);
      const o = (f * boneIndices.length + slotOf.get(bi)) * 7;
      // ⚠️ Molang 通道的关键帧是**按时间索引的对象**，采样必须在 t 处重新求值，
      // 而 collectChannel 只在关键帧时刻求过值。这里对 Molang 通道用「按关键帧插值」
      // 会丢失表达式的高频特性（表达式没有关键帧密度），所以额外走一条重算路径：
      const rot = ch.rot ? sampleChannel3(ch.rot, t) : [0, 0, 0];
      const pos = ch.pos ? sampleChannel3(ch.pos, t) : [0, 0, 0];
      euler.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ');
      quat.setFromEuler(euler);
      frames[o] = quat.x; frames[o + 1] = quat.y; frames[o + 2] = quat.z; frames[o + 3] = quat.w;
      frames[o + 4] = pos[0] * PX2BLOCK;
      frames[o + 5] = pos[1] * PX2BLOCK;
      frames[o + 6] = pos[2] * PX2BLOCK;
    }
  }
  return { fps, frameCount, boneIndices, frames };
}

/**
 * Molang 待机动画的重采样：**在 t 处直接重算表达式**，不做关键帧插值。
 *
 * 为什么必须单独走一条路（spec §4.2）：待机的表达式频率是 128 rad/秒（≈20.4Hz），
 * 若先把表达式在稀疏关键帧上求值再插值，等价于低通滤波 —— 20Hz 的火焰颤动会被抹平，
 * 观感退化成「缓慢呼吸」。故待机的每一帧都在自己的 t 上调用 `compileMolang`。
 *
 * @param {object} anims @param {string[]} names @param {number} frameCount
 * @param {number} fps @param {Map<string, number>} boneNameToIndex
 */
function resampleMolangAnimation(anims, names, frameCount, fps, boneNameToIndex) {
  // 收集每条动画每骨骼的「原始通道」（含表达式字符串，不求值）
  const perBone = new Map();   // boneIndex → {rot: [{axis, fn|number}], pos: ...}
  for (const short of names) {
    const full = `animation.null.ignis.${short}`;
    const anim = anims[full];
    if (!anim) fail(`素材缺动画 ${full}`);
    for (const [boneName, ch] of Object.entries(anim.bones || {})) {
      const bi = boneNameToIndex.get(boneName);
      if (bi === undefined) fail(`动画 ${full} 的骨骼 "${boneName}" 不在几何里`);
      const prev = perBone.get(bi) || {};
      for (const channel of ['rotation', 'position']) {
        const raw = ch[channel];
        if (raw === undefined) continue;
        // idle 的两条动画都是「每通道一个常量（或表达式）」，不是时间序列
        if (!Array.isArray(raw)) fail(`待机动画 ${full} 的 ${channel} 不是常量形态（本路径只支持常量/表达式）`);
        prev[channel] = raw.map((component) => {
          if (typeof component === 'number') return () => component;
          if (typeof component === 'string') {
            const fn = compileMolang(component);
            return (t) => fn({ lifeTime: t });
          }
          fail(`待机动画 ${full} 的 ${channel} 分量类型 ${typeof component} 不支持`);
          return () => 0;
        });
      }
      perBone.set(bi, prev);
    }
  }
  if (perBone.size === 0) fail(`待机动画 ${names.join('+')} 没有驱动任何骨骼`);

  const boneIndices = [...perBone.keys()].sort((a, b) => a - b);
  const slotOf = new Map(boneIndices.map((bi, slot) => [bi, slot]));
  const frames = new Array(frameCount * boneIndices.length * 7);
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    for (const bi of boneIndices) {
      const ch = perBone.get(bi);
      const o = (f * boneIndices.length + slotOf.get(bi)) * 7;
      const rot = ch.rotation ? ch.rotation.map((fn) => fn(t)) : [0, 0, 0];
      const pos = ch.position ? ch.position.map((fn) => fn(t)) : [0, 0, 0];
      euler.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ');
      quat.setFromEuler(euler);
      frames[o] = quat.x; frames[o + 1] = quat.y; frames[o + 2] = quat.z; frames[o + 3] = quat.w;
      frames[o + 4] = pos[0] * PX2BLOCK;
      frames[o + 5] = pos[1] * PX2BLOCK;
      frames[o + 6] = pos[2] * PX2BLOCK;
    }
  }
  return { fps, frameCount, boneIndices, frames };
}

function main() {
  for (const [label, p] of [['几何', IGNIS_GEO_SRC], ['动画', IGNIS_ANIM_SRC], ['贴图', IGNIS_TEX_SRC]]) {
    if (!fs.existsSync(p)) fail(`烘焙输入缺失（${label}）：${p}`);
  }

  const geoRoot = JSON.parse(fs.readFileSync(IGNIS_GEO_SRC, 'utf8'));
  // Bedrock 1.12 的几何键名是 `geometry.<identifier>`（不是 minecraft:geometry 数组）
  const geoKey = Object.keys(geoRoot).find((k) => k.startsWith('geometry.'));
  if (!geoKey) fail('几何文件里找不到 geometry.* 键');
  const geo = geoRoot[geoKey];
  if (geo.texturewidth !== textureSize || geo.textureheight !== textureSize) {
    fail(`贴图尺寸 ${geo.texturewidth}×${geo.textureheight} ≠ 期望 ${textureSize}²`);
  }
  const bonesRaw = geo.bones || [];
  if (bonesRaw.length !== IGNIS_METRICS.boneCount) {
    fail(`骨骼数 ${bonesRaw.length} ≠ 期望 ${IGNIS_METRICS.boneCount}（素材换了？同步 IGNIS_METRICS）`);
  }

  // ==================== 1. 骨骼层级 ====================
  const byName = new Map(bonesRaw.map((b) => [b.name, b]));
  const boneIndex = new Map(bonesRaw.map((b, i) => [b.name, i]));

  // 校验 parent 引用与拓扑顺序（父必须先出现，否则下面的递归会读到 undefined）
  for (let i = 0; i < bonesRaw.length; i++) {
    const b = bonesRaw[i];
    if (b.parent === undefined) continue;
    const pi = boneIndex.get(b.parent);
    if (pi === undefined) fail(`骨骼 ${b.name} 的父 "${b.parent}" 不存在`);
    if (pi >= i) fail(`骨骼 ${b.name} 的父 "${b.parent}" 下标 ${pi} 不早于自身 ${i}（层级顺序无效）`);
  }

  const bones = bonesRaw.map((b) => {
    const pi = b.parent === undefined ? [0, 0, 0] : b.pivot;
    const rotDeg = b.rotation || [0, 0, 0];
    const rot = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rotDeg[0] * DEG, rotDeg[1] * DEG, rotDeg[2] * DEG, 'XYZ'));

    // localPosition = pivot - R(rot) · pivot  （推导见文件头）
    // 意义：让「绕 pivot 旋转」在 three 的「相对父骨骼」模型里等价成立
    const pv = new THREE.Vector3(pi[0], pi[1], pi[2]);
    const rotated = pv.clone().applyQuaternion(rot);
    const local = pv.clone().sub(rotated);

    return {
      name: b.name,
      parentIndex: b.parent === undefined ? -1 : boneIndex.get(b.parent),
      localPosition: [local.x * PX2BLOCK, local.y * PX2BLOCK, local.z * PX2BLOCK],
      bindQuaternion: [rot.x, rot.y, rot.z, rot.w],
    };
  });

  // ==================== 2. 合并几何 ====================
  const position = [], normal = [], uv = [], skinIndex = [], index = [];
  const bonesWithCubes = new Set();
  let vOff = 0;
  let bakedCubes = 0;
  let skippedCubes = 0;

  // ⚠️ **cube 顶点是绝对模型空间坐标，直接写入，不乘骨骼矩阵。**
  // 旋转由渲染期的骨骼层级施加（bindQuaternion）。烘焙期乘一次会导致双重旋转。
  //
  // ⚠️ **骨骼的 pivot 也不需要从 cube origin 里减掉** —— Bedrock 的 cube origin 本来就是
  // 模型空间绝对值，而骨骼链的作用是「绕 pivot 旋转这部分顶点」。两者在这里不冲突。
  for (const bone of bonesRaw) {
    const bi = boneIndex.get(bone.name);
    for (const cube of bone.cubes || []) {
      const [dx, dy, dz] = cube.size;
      if (dx === 0 || dy === 0 || dz === 0) { skippedCubes++; continue; }
      bakedCubes++;
      bonesWithCubes.add(bi);

      const inf = cube.inflate || 0;
      // inflate = 向外均匀外扩：尺寸 = size + 2*inflate，中心不变
      const sx = (dx + 2 * inf) * PX2BLOCK;
      const sy = (dy + 2 * inf) * PX2BLOCK;
      const sz = (dz + 2 * inf) * PX2BLOCK;
      const cx = (cube.origin[0] + dx / 2) * PX2BLOCK;
      const cy = (cube.origin[1] + dy / 2) * PX2BLOCK;
      const cz = (cube.origin[2] + dz / 2) * PX2BLOCK;

      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(cx, cy, cz);
      const gp = g.getAttribute('position');
      const gn = g.getAttribute('normal');
      const gu = g.getAttribute('uv');
      const gi = g.getIndex();

      // UV 重映射：把 BoxGeometry 的 [0,1] 标准 UV 线性映射到 Bedrock 的各面矩形。
      //
      // ⚠️ v 方向：矩形按「图片像素左上角原点」写，而 BoxGeometry 的 v=1 是面的「上」。
      // 换算 `v_three = 1 - v_px/textureSize`（与 bake-dragon.mjs 同口径，因为运行时
      // TextureLoader 的 flipY 默认 true）。
      const rects = boxUVRects(cube.uv[0], cube.uv[1], dx, dy, dz);
      for (let face = 0; face < 6; face++) {
        const [u0, v0, u1, v1] = rects[face];
        const mirrored = cube.mirror === true;
        for (let k = 0; k < 4; k++) {
          const vi = face * 4 + k;
          const bu = gu.getX(vi);   // 0..1
          const bv = gu.getY(vi);   // 0..1（1 = 面的上沿）
          // u：允许反向（u1 < u0）以保留 mirror 的水平翻转
          let u = u0 + bu * (u1 - u0);
          if (mirrored) u = u0 + u1 - u;
          // v：bv=1 → 图片上方（v0），bv=0 → 图片下方（v1）
          const vPx = v0 + (1 - bv) * (v1 - v0);
          gu.setXY(vi, u / textureSize, 1 - vPx / textureSize);
        }
      }

      for (let i = 0; i < gp.count; i++) {
        position.push(gp.getX(i), gp.getY(i), gp.getZ(i));
        normal.push(gn.getX(i), gn.getY(i), gn.getZ(i));
        uv.push(gu.getX(i), gu.getY(i));
        skinIndex.push(bi, 0, 0, 0);   // 刚性绑定：weight 恒 1（运行时生成 skinWeight）
      }
      for (let i = 0; i < gi.count; i++) index.push(gi.array[i] + vOff);
      vOff += gp.count;
      g.dispose();
    }
  }

  if (bakedCubes !== IGNIS_METRICS.bakedCubes) {
    fail(`烘焙立方体数 ${bakedCubes} ≠ 期望 ${IGNIS_METRICS.bakedCubes}`);
  }
  if (skippedCubes !== IGNIS_METRICS.skippedCubes) {
    fail(`跳过的零尺寸立方体数 ${skippedCubes} ≠ 期望 ${IGNIS_METRICS.skippedCubes}`);
  }
  if (vOff !== IGNIS_METRICS.vertexCount) fail(`顶点数 ${vOff} ≠ 期望 ${IGNIS_METRICS.vertexCount}`);
  if (index.length !== IGNIS_METRICS.indexCount) {
    fail(`索引数 ${index.length} ≠ 期望 ${IGNIS_METRICS.indexCount}`);
  }
  if (bonesWithCubes.size !== IGNIS_METRICS.bonesWithCubes) {
    fail(`带立方体的骨骼数 ${bonesWithCubes.size} ≠ 期望 ${IGNIS_METRICS.bonesWithCubes}`);
  }
  for (const v of uv) if (!(v >= 0 && v <= 1)) fail(`UV 越界 ${v}（应 ∈ [0,1]）`);

  // ==================== 3. 贴图 ====================
  // 直接拷入库的那份（已经是 256²），不重新编码（避免无谓的 PNG 差异）
  const pngBuf = fs.readFileSync(IGNIS_TEX_SRC);

  // ==================== 4. 动画 ====================
  const animRoot = JSON.parse(fs.readFileSync(IGNIS_ANIM_SRC, 'utf8'));
  const anims = animRoot.animations || {};
  const boneNameToIndex = new Map(bones.map((b, i) => [b.name, i]));

  // idle：Molang 路径（每帧重算表达式，不做关键帧插值）
  const idleFps = idleFrameCount / IGNIS_ANIM_PERIODS.idle;
  const animations = {
    idle: resampleMolangAnimation(
      anims, IGNIS_ANIM_SOURCES.idle, idleFrameCount, idleFps, boneNameToIndex),
  };
  console.log(`[焰魔烘焙]   动画 idle: ${animations.idle.frameCount} 帧 × `
    + `${animations.idle.boneIndices.length} 骨骼 @ ${idleFps.toFixed(3)}fps`
    + `（duration ${(idleFrameCount / idleFps).toFixed(10)}s ≡ 2π/128）`);

  // attack：数值关键帧路径
  const attackFrames = Math.round(IGNIS_ANIM_PERIODS.attack * ATTACK_FPS);
  animations.attack = resampleAnimation(
    anims, IGNIS_ANIM_SOURCES.attack, attackFrames, ATTACK_FPS, boneNameToIndex);
  console.log(`[焰魔烘焙]   动画 attack: ${animations.attack.frameCount} 帧 × `
    + `${animations.attack.boneIndices.length} 骨骼 @ ${ATTACK_FPS}fps`);

  // ==================== 5. 写产物 ====================
  fs.mkdirSync(path.dirname(IGNIS_JSON), { recursive: true });
  fs.writeFileSync(IGNIS_PNG, pngBuf);
  const asset = {
    scale,
    bones,
    geometry: { position, normal, uv, skinIndex, index },
    animations,
    metrics: {
      boneCount: bones.length,
      bonesWithCubes: bonesWithCubes.size,
      cubeCount: bakedCubes + skippedCubes,
      skippedCubes,
      bakedCubes,
      vertexCount: vOff,
      indexCount: index.length,
      scale,
    },
  };
  fs.writeFileSync(IGNIS_JSON, JSON.stringify(asset));

  const fp = ignisInputFingerprint();
  fs.writeFileSync(IGNIS_META, JSON.stringify({
    fingerprints: { input: fp.input, sourceSha256: fp.sourceSha256, paramsSha256: fp.paramsSha256 },
    metrics: asset.metrics,
    textureSize,
    animPeriods: IGNIS_ANIM_PERIODS,
    animSources: IGNIS_ANIM_SOURCES,
  }, null, 1));

  const rel = (p) => path.relative(process.cwd(), p);
  console.log(`[焰魔烘焙] ✓ ${bones.length} 骨骼 / ${bakedCubes} 立方体（跳过 ${skippedCubes} 零尺寸）`
    + ` / ${vOff} 顶点 / ${index.length} 索引 / 贴图 ${textureSize}²`);
  console.log(`[焰魔烘焙]   产物 ${rel(IGNIS_JSON)} + ${rel(IGNIS_PNG)} + ${rel(IGNIS_META)}`);
  console.log(`[焰魔烘焙]   指纹 ${fp.input}`);
}

main();
