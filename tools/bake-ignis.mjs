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
  applyWindupDamping(frames, frameCount, boneIndices, boneNameToIndex, fps);
  return { fps, frameCount, boneIndices, frames };
}

// ---------------------------------------------------------------------------
// 蓄力段衰减（v2.57，用户实玩反馈「手臂向后弯曲过多」）
// ---------------------------------------------------------------------------

/**
 * 蓄力段的时间窗口（秒）。
 *
 * ⚠️⚠️ **峰值是一段平台 [0.60, 1.00]，不是 0.60 这个单点。**
 * 素材 `attack6a` 在 t=0.6 到达 `right_arm_joint` X=−147.5° 后，靠
 * `setStaticKeyframe(8tick)` 把这个值**保持到 1.0s**，1.05s 才开始挥砍。
 * 把关窗点错放在 0.60（实测踩到）会让 0.60~1.00 的整个平台只被部分衰减，
 * 0.90s 处仰角仍有 79.5° —— 用户看到的「翻折」几乎没被修掉。
 */
const WINDUP_RAMP_SECONDS = 0.3;    // 起手：与 idle 的接缝，衰减 0→1
const WINDUP_PLATEAU_START = 0.60;  // 峰值平台起点
const WINDUP_PLATEAU_END = 1.00;    // 峰值平台终点（挥砍从 1.05s 开始）
const WINDUP_FADE_OUT = 0.15;       // 平台后的衰减收尾（防一帧反跳，见 weightAt 注释）

/**
 * 骨骼名 → [X, Y, Z] 三轴各自的**保留比例**（1 = 原样，0 = 完全去掉）。
 *
 * ## 为什么要这一层
 *
 * 用户 2026-11-05 反馈：「挥刀时手臂先向后弯曲，然后向前尖刺……左手向后弯曲过多，
 * 不自然」。
 *
 * **不是转换缺陷** —— 定量比对两侧原始素材完全相同（Java `ModelIgnis.java:429` 的
 * `SWING_ATTACK` 与 Bedrock `attack6a` 数值逐帧一致）。是作者原始设计本身幅度极大：
 *
 * | 部位 | idle(bind) | 蓄力 0.60s | 命中 1.25s |
 * |---|---|---|---|
 * | 右臂（持剑）上臂仰角 | −80.4°（垂在身侧） | **+82.0°**（举过头顶后方） | −50.2° |
 *
 * `right_arm_joint` 的 X 轴在蓄力时到 **−147.5°**，0.6s 内从垂下翻转 158.9°（265°/s），
 * 随后 0.65s 反向用 128.7° 下劈 —— 观感就是「胳膊向后翻折」。
 *
 * ## 修法
 *
 * **只衰减蓄力段的旋转幅度**，挥砍与回弹段保持原样，且**不动时间轴** ——
 * `hitFrameSeconds`（1.20s）、`attackAnimSeconds`（2.75s）、冷却与锥形判定全部不受影响。
 *
 * ## ⚠️⚠️ 两维都要收 —— 只收仰角不算修好（v2.57 第一版踩到）
 *
 * 第一版只衰减 `right_arm_joint.X`，实测**仰角确实从 82° 降到 41.5°**，
 * 但用户复测仍报「手臂弯折到身后很夸张」。对照用户录屏（0→1.3s，10fps 抽帧）定位到：
 * 夸张的是**前后方向**，手臂绕身体竖轴被甩到身后约 **55°**。
 *
 * 造成后甩的是两处 **Y 轴**（与仰角的 X 轴无关）：
 * - `upperbody.Y` 0 → +26.3°（整个上身扭转，把右肩向后带）
 * - `right_arm.Y` 0 → +28.7°（上臂绕身体竖轴向后扫）
 *
 * ## ⚠️⚠️ `right_arm_joint.X` 绝对不能衰减（第二次踩到，方向反了）
 *
 * 逐骨归零实验（每次只把一根骨的衰减设为 [0,0,0]，读 0.75s 的手臂向量）：
 *
 * | 归零的骨骼 | 仰角 | 前后 |
 * |---|---|---|
 * | （不衰减，基线） | 80.8° | −3.7° |
 * | `right_arm_joint` | **−51.1°** | 31.9° |
 * | `upperbody` | 82.2° | 4.7° |
 * | `right_arm` | 82.5° | 3.7° |
 *
 * ⇒ `right_arm_joint.X` **就是「举手」本身**：保持 1.0 时手臂笔直举到身后上方
 * （仰角 +80.8°、前后 −3.7°，不折）；收到 0.62 反而变成仰角 +41.5°、前后 +40.5°
 * —— 水平朝前伸，**视觉上正是「小臂折在身后」**。
 * 第一次修复的「后翻」其实是这个衰减自己造成的（用户两次复测都说没修好，原因在此）。
 *
 * 真正让上臂「拧到背后」的是两处 Y 轴（绕身体竖轴）：`upperbody.Y` 0 → +26.3°、
 * `right_arm.Y` 0 → +28.7°。收敛它们，手臂就跟着身体朝向走。
 */
const WINDUP_KEEP = new Map([
  // ⚠️⚠️ **`right_arm_joint.X` 必须保持 1.0（不衰减）** —— 三次实测确认，前两版都栽在这里。
  //
  // 它**就是「举手」本身**：原始 −147.5° 让手臂笔直举到身后上方（剑尖朝上，肘部伸展）；
  // 一旦收到 0.62（−91.5°），上臂被压成水平朝前，而小臂还停在原处 ⇒ **肘部反折成 V 形**。
  // 用户两段录屏里那个「手臂弯折到身后」的姿态，正是这个衰减自己造出来的。
  //
  // 对照截图（0.75s 蓄力峰值，同一机位）：
  // - keep=0.62（旧）：小臂向后折、剑朝后下方甩出，肘部明显反关节；
  // - keep=1.00（现在）：手臂笔直上举、剑尖朝上、肘部自然。
  ['right_arm_joint', [1, 1, 1]],
  // 真正需要收的是**绕身体竖轴的扭转**（Y 轴）：它让整条手臂「拧到身体侧面/背后」，
  // 与上举本身无关。`upperbody.Y` 0→+26°、`right_arm.Y` 0→+29°。
  ['upperbody', [1, 0.55, 1]],
  ['right_arm', [1, 0.55, 1]],
  // 持盾的左臂：蓄力时 Y 轴 −50° 把整条臂向外摊得太开，收到七成。
  ['left_arm_joint', [1, 0.7, 1]],
]);

/**
 * 对蓄力段做旋转衰减（就地修改 frames）。
 *
 * 衰减系数按时窗平滑过渡（避免峰值处出折线，也保证与 idle 的接缝不跳）：
 * - `t ≤ RAMP`：0 → 1 线性上升；
 * - `RAMP < t ≤ PEAK`：保持 1；
 * - `PEAK < t < END`：1 → 0 线性下降；
 * - `t ≥ END`：0（挥砍段完全原样）。
 *
 * @param {number[]} frames 扁平帧数据（每骨 7 个：四元数 + 位置）
 * @param {number} frameCount 帧数
 * @param {number[]} boneIndices 参与动画的骨骼下标（升序）
 * @param {Map<string, number>} boneNameToIndex 骨骼名 → 下标
 * @param {number} fps 帧率
 */
function applyWindupDamping(frames, frameCount, boneIndices, boneNameToIndex, fps) {
  const slotOf = new Map(boneIndices.map((bi, slot) => [bi, slot]));
  const targets = [...WINDUP_KEEP].map(([name, keep]) => {
    const bi = boneNameToIndex.get(name);
    if (bi === undefined) fail(`蓄力衰减表里的骨骼 "${name}" 不在几何里`);
    const slot = slotOf.get(bi);
    if (slot === undefined) fail(`蓄力衰减目标 "${name}" 没有动画通道`);
    return { slot, keep };
  });

  // ⚠️⚠️ 平台终点**必须渐变收尾**，不能断崖式撤掉。
  //
  // 实测踩到：平台在 1.000s（帧 30）衰减后是 −91.5°，若平台后立刻恢复原样，
  // 1.033s（帧 31）就跳回 −143.9° —— 一帧内反向 52°，肉眼是一下抽搐。
  // 那正是「挥砍起手」段，绝不能插入这种跳变。
  //
  // 因此在 [PLATEAU_END, PLATEAU_END + FADE_OUT] 内线性把衰减 1 → 0，
  // 让姿态从「衰减后的 −91.5°」平滑接回素材的挥砍起手。
  const weightAt = (t) => {
    if (t <= WINDUP_RAMP_SECONDS) return t / WINDUP_RAMP_SECONDS;
    if (t <= WINDUP_PLATEAU_END) return 1;
    const fadeEnd = WINDUP_PLATEAU_END + WINDUP_FADE_OUT;
    if (t >= fadeEnd) return 0;
    return 1 - (t - WINDUP_PLATEAU_END) / WINDUP_FADE_OUT;
  };

  const n = boneIndices.length;
  const q = new THREE.Quaternion();
  const damped = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let f = 0; f < frameCount; f++) {
    const w = weightAt(f / fps);
    if (w <= 0) continue;
    for (const { slot, keep } of targets) {
      const o = (f * n + slot) * 7;
      q.set(frames[o], frames[o + 1], frames[o + 2], frames[o + 3]);
      e.setFromQuaternion(q, 'XYZ');
      // ⚠️ 不能把四元数 slerp 到 identity —— 那会把三个轴同时缩小，
      // 而这里要的是「只收 X 轴、Y/Z 不动」。
      const factor = (k) => 1 - w * (1 - k);
      damped.setFromEuler(new THREE.Euler(
        e.x * factor(keep[0]),
        e.y * factor(keep[1]),
        e.z * factor(keep[2]),
        'XYZ',
      ));
      frames[o] = damped.x; frames[o + 1] = damped.y;
      frames[o + 2] = damped.z; frames[o + 3] = damped.w;
    }
  }
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
      /**
       * 该骨骼旋转中心（绝对模型空间坐标，单位格）。
       *
       * ⚠️⚠️ **渲染器必须用它按当前旋转重算 `bone.position`**（用户 2026-11-05 缺陷 C）：
       * `localPosition` 只是 **bind pose** 下的值（`p - R_bind·p`）。动画改变旋转后，
       * 骨骼原点必须移到新的 `p - R_current·p`，否则肢体绕「旧位置」转 ——
       * 形态是挥剑时胳膊从肩膀甩出去（实测 right_arm 顶点落到 y=-3.2，躯干在 y=1.75~3.14）。
       *
       * 公式（与文件头的 `T(piv)·R·T(-piv)` 同一套）：
       *   `bone.position = pivot - R_current · pivot + animDeltaPos`
       */
      pivot: [pi[0] * PX2BLOCK, pi[1] * PX2BLOCK, pi[2] * PX2BLOCK],
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
  // ==================== 6. 脚底补偿量（feetOffsetY）====================
  //
  // ⚠️⚠️ **这是用户 2026-11-05 实玩缺陷 A 的根因修复**（「焰魔生成出来后，身体的下半截
  // 埋在地下」）。几何的 y 原点**不是脚底**：bind pose 下模型最低点在 y = -0.27 格
  // （剑尖/脚甲探到原点下方），而渲染器当时用的是「身体核心中心」的偏移
  // （-IGNIS_MODEL_CENTER[1] = -1.7335），于是整个模型陷入地下 **1.70 格**。
  //
  // 正确语义：**渲染器把 mesh 平移 `feetOffsetY`**，使「**身体**（不含武器）在动画全程的
  // 最低点」恰好落在 `state.position.y`（脚底）。所以本值必须是**扫遍所有动画所有帧、
  // 且只算身体骨骼**得到的最小值。
  //
  // ⚠️ 本值**可为负**（现在就是 -0.2005）：模型空间里脚在 +0.31，要让脚落到 position.y
  // 就得往下移。负值不是 bug。
  //
  // 与 `IGNIS_MODEL_CENTER`（身体核心中心，用于命中盒）**语义不同**，两个都要留着。
  let lowestY = Infinity;
  const bakeBones = asset.bones;
  // ⚠️ **只扫「身体」骨骼，排除武器**（剑/盾）。
  // 用户 2026-11-05 追加报告：「焰魔的身体完全漂浮在地表之上一个方格之上的位置，
  // 焰魔的身体下降一个方格的距离我觉得刚好合适」。
  // 根因：用**全局**最低点（含剑）时，`feetOffsetY` 取的是「attack 动画里剑劈到最低」的
  // 1.6532，而脚（lowerbody2 的立方体底）在模型空间的 +0.3125 ⇒ 脚被抬到离地 1.97 格。
  // 正确语义是「**脚底**贴 position.y」—— 剑劈到地下是美术上可接受的（攻击动作本来就是
  // 往下方劈），把脚悬空才是错的。
  const WEAPON_BONE = /^(sword|shield)/;
  const bodyBoneIdx = new Set(
    bakeBones.map((b, i) => (WEAPON_BONE.test(b.name) ? -1 : i)).filter((i) => i >= 0),
  );
  // 复用一个 4x4 矩阵累乘器（与渲染器同一口径：position 固定为 localPosition）
  const mul4 = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = acc;
      }
    }
    return o;
  };
  const trMat = (q, t) => {
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
  const apply4 = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
  const qrot = (q, v) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      (1 - 2 * (yy + zz)) * v[0] + 2 * (xy - wz) * v[1] + 2 * (xz + wy) * v[2],
      2 * (xy + wz) * v[0] + (1 - 2 * (xx + zz)) * v[1] + 2 * (yz - wx) * v[2],
      2 * (xz - wy) * v[0] + 2 * (yz + wx) * v[1] + (1 - 2 * (xx + yy)) * v[2],
    ];
  };
  const qmulLocal = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const scanAnim = (anim) => {
    if (!anim || !(anim.frameCount > 0)) return;
    for (let f = 0; f < anim.frameCount; f++) {
      const world = new Array(bakeBones.length);
      for (let i = 0; i < bakeBones.length; i++) {
        const b = bakeBones[i];
        // 找该骨骼在这一帧的增量
        let dq = null;
        let dp = null;
        const slot = anim.boneIndices.indexOf(i);
        if (slot >= 0) {
          const o = (f * anim.boneIndices.length + slot) * 7;
          dq = [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]];
          dp = [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]];
        }
        const q = dq ? qmulLocal(b.bindQuaternion, dq) : b.bindQuaternion;
        // ⚠️ **必须按当前旋转重算骨骼原点**（缺陷 C 的同一公式）：
        //   position = pivot - R_current · pivot + animDeltaPos
        // 用 bind 的 localPosition 会让肢体绕旧位置转、扫出错误的包围盒。
        const rp = qrot(q, b.pivot);
        const pos = [
          b.pivot[0] - rp[0] + (dp ? dp[0] : 0),
          b.pivot[1] - rp[1] + (dp ? dp[1] : 0),
          b.pivot[2] - rp[2] + (dp ? dp[2] : 0),
        ];
        const local = trMat(q, pos);
        world[i] = b.parentIndex === -1 ? local : mul4(world[b.parentIndex], local);
      }
      for (let v = 0; v < vOff; v++) {
        if (!bodyBoneIdx.has(skinIndex[v * 4])) continue;   // 跳过剑/盾顶点
        const w = apply4(world[skinIndex[v * 4]], [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);
        if (w[1] < lowestY) lowestY = w[1];
      }
    }
  };
  scanAnim(animations.idle);
  scanAnim(animations.attack);
  if (!Number.isFinite(lowestY)) fail('脚底补偿扫描失败（没有任何顶点）');
  const feetOffsetY = -lowestY;
  asset.metrics.feetOffsetY = feetOffsetY;
  console.log(`[焰魔烘焙]   脚底补偿 feetOffsetY = ${feetOffsetY.toFixed(4)}`
    + `（动画全程最低点 y = ${lowestY.toFixed(4)} 格）`);

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
