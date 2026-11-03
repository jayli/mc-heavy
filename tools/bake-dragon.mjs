#!/usr/bin/env node
// tools/bake-dragon.mjs — 祭坛飞龙烘焙（npm run dragon）
//
// 输入 `assets/dragon/src/amethyst_dragon.bbmodel`（Blockbench 4.10 modded_entity，box_uv），
// 输出三件套到 `assets/dragon/`：
//   - dragon.json  骨骼层级 + 合并几何（position/normal/uv/skinIndex/index）+ 动画（Task 2 填）
//   - dragon.png   内嵌 128² 贴图解码落盘
//   - dragon.meta.json  度量 + 输入指纹（check:data 的 [龙] 守过期）
//
// 参数与指纹的唯一权威 = `tools/dragon-fingerprint.mjs`（红线 1，与本脚本共用）。
//
// ⚠️ **几何用 three `BoxGeometry` 生成，不手工推导面序**：运行时渲染器（Task 7）用 three 的
//    SkinnedMesh，顶点序/法线/索引必须与 three 逐位一致。手工推导面序极易错（spec §11 风险 1），
//    而 three.core.js 在 Node 里可直接 import（已实测 `new BoxGeometry()` 可用）。
//
// ⚠️ **骨骼 `localPosition` 必须做旋转修正**（这是本脚本最易错的一处）：
//    Blockbench 的骨骼 `origin` 是**绝对模型空间**坐标，而 three 的 `Bone.position` 是**相对父
//    骨骼局部空间**的偏移。当父骨骼 bind 旋转 ≠ 0 时，直接用「origin 差」作 localPosition 会让
//    bind pose 下子骨骼的世界位置 ≠ 它的绝对 origin（实测 neck2：不修正得 [0,23.4,-12.6]，
//    而绝对 origin 是 [0,19.5,-14]）→ 元素顶点（绝对坐标）与骨骼世界变换不一致 → 蒙皮错位、龙散架。
//    修正公式：`localPosition = R_parentWorld⁻¹ · (childOrigin − parentOrigin)`，
//    其中 R_parentWorld 是父骨骼 bind pose 的**累积世界旋转**。可证 bind pose 下
//    骨骼世界位置 = childOrigin、世界旋转 = 累积 rotation（推导见 spec / 本文件 git 历史）。
//
// ⚠️ **UV 映射保留递减书写**（如 chest 的 up 面 [22,10,10,0] u1>u0）：规范化成 min/max 会让
//    那些面水平镜像（AGENTS.md 已记 MC 皮肤版式同一陷阱）。公式对 u1>u2 / v1>v2 天然支持。
//
// ⚠️ **v 轴 flipY 换算**：贴图运行时走 `TextureLoader`（默认 flipY=true，v=0 在图片底部），
//    而 bbmodel 的 uv 是图片像素坐标（左上原点，v 向下）。换算 `v_three = 1 − v_px/textureSize`。
//    调试方向问题时必须走真实 TextureLoader 路径，DataTexture（flipY=false）会给假结论（AGENTS.md）。
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from '../vendor/three/three.core.js';
import { PNG } from 'pngjs';
import {
  DRAGON_SOURCE_PATH, DRAGON_JSON, DRAGON_PNG, DRAGON_META,
  DRAGON_BAKE_PARAMS, DRAGON_METRICS, dragonInputFingerprint,
} from './dragon-fingerprint.mjs';

const { scale, textureSize, pxPerBlock } = DRAGON_BAKE_PARAMS;
/** px → 格（已含 scale 倍）。运行时不再乘 scale（spec §2.1） */
const PX2BLOCK = scale / pxPerBlock;
const DEG = Math.PI / 180;

/** 重采样帧率（spec §4.1：catmullrom 的复杂度留在 Node 侧，运行时只做帧间插值） */
const ANIM_FPS = 30;
/** 本期只导入盘旋用的两个动画（用户裁定 fly + glide 交替；idle/walk/attack 不导入，spec §10 第 7 条） */
const ANIM_NAMES = Object.freeze(['fly', 'glide']);

/**
 * three `BoxGeometry` 的面序固定为 [+x, −x, +y, −y, +z, −z]（`three.core.js:29515-29520`
 * 的 buildPlane 调用序）。这里映射到 Blockbench/MC 的面名（与 `DRAGON_BAKE_PARAMS.faceMap`
 * 一致，但那是「名→轴」，这里是「面序→名」，两者互为反向）。
 */
const FACE_ORDER = Object.freeze(['east', 'west', 'up', 'down', 'south', 'north']);

function fail(msg) { throw new Error(`[龙烘焙] ${msg}`); }

/**
 * 标准 Catmull-Rom 样条求值（Blockbench 的 `interpolation: 'catmullrom'` 口径）。
 *
 * @param {number} p0 前一帧 @param {number} p1 段起点 @param {number} p2 段终点 @param {number} p3 后一帧
 * @param {number} u 段内归一化时间 ∈ [0,1)
 */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * ((2 * p1)
    + (-p0 + p2) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

/**
 * 把一条关键帧序列（**loop 动画**）转成「周期表示」：首末值相同时去掉末帧。
 *
 * ⚠️ 实测素材的 loop 动画**首末值全部相同**（fly 34/34、glide 33/33），且末帧 time = length。
 * 去掉末帧后 n 个独立帧覆盖 [0, length)，邻居环绕取 —— 这样 t=0 的前一帧是 t=length 的前一帧
 * （而不是 t=length 那个重复值），catmullrom 在接缝处才连续。
 *
 * @param {Array<{time:number, value:{x:number,y:number,z:number}}>} kfs 已按 time 升序
 * @param {number} length 动画时长
 * @returns {{times:number[], values:Array<{x:number,y:number,z:number}>, period:number}}
 */
function toPeriodic(kfs, length) {
  if (kfs.length === 0) fail('空关键帧序列');
  const first = kfs[0].value, last = kfs[kfs.length - 1].value;
  const closed = kfs.length >= 2
    && Math.abs(kfs[kfs.length - 1].time - length) < 1e-9
    && ['x', 'y', 'z'].every((k) => Math.abs((first[k] || 0) - (last[k] || 0)) < 1e-9);
  if (closed) return { times: kfs.slice(0, -1).map((k) => k.time), values: kfs.slice(0, -1).map((k) => k.value), period: length };
  // 非闭合（本期不会出现：只导入 loop 的 fly/glide）→ 端点重复取值，不做环绕
  return { times: kfs.map((k) => k.time), values: kfs.map((k) => k.value), period: length, clamp: true };
}

/** 在周期序列上按 catmullrom 采样一个分量。 */
function sampleChannel(seq, t) {
  const n = seq.times.length;
  if (n === 1) return { ...seq.values[0] };   // 恒定值（实测 12 根骨骼只有 2 帧且首末相同 → 退化为此）
  // 定位所在段
  let i = 0;
  while (i < n - 1 && seq.times[i + 1] <= t) i++;
  const t0 = seq.times[i];
  const t1 = i + 1 < n ? seq.times[i + 1] : seq.period;   // 末段的终点是 period（环绕到 t=0）
  const span = t1 - t0;
  const u = span > 0 ? (t - t0) / span : 0;
  const at = (k) => seq.values[seq.clamp ? Math.min(n - 1, Math.max(0, k)) : ((k % n) + n) % n];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  return {
    x: catmullRom(p0.x || 0, p1.x || 0, p2.x || 0, p3.x || 0, u),
    y: catmullRom(p0.y || 0, p1.y || 0, p2.y || 0, p3.y || 0, u),
    z: catmullRom(p0.z || 0, p1.z || 0, p2.z || 0, p3.z || 0, u),
  };
}

/**
 * 重采样一个动画成定长帧序列。
 *
 * ⚠️ **rotation 与 position 都是「相对 bind pose 的增量」**（实测：素材 `override: false`
 * = additive；neck1 的 bind rotation 是 40° 而 fly 关键帧是 ±10°，head 的 bind 是 −30°
 * 而关键帧是 +1.3~+7 —— 若按绝对替换语义，头会在每次拍翅时翻转 37°，不合理）。
 * 故 frames 里存的就是增量，运行时 `bindQuat * deltaQuat`（spec §2.2）。
 *
 * ⚠️ **每骨骼的关键帧数不同**（实测 fly：21 根 13 帧、12 根 2 帧；glide：20 根 9 帧、12 根 2 帧）
 * → 必须按每骨骼自己的时间序列插值，不能假设全动画共用一组时间点。
 *
 * @returns {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}}
 */
function resampleAnimation(anim, boneNameToIndex) {
  const frameCount = Math.round(anim.length * ANIM_FPS);
  if (!(frameCount > 0)) fail(`动画 ${anim.name} 帧数 ${frameCount} 非正`);
  // 被驱动的骨骼（按骨骼表序，保证 boneIndices 严格升序 —— 产物契约）
  const driven = [];
  for (const animator of Object.values(anim.animators || {})) {
    if (animator.type !== 'bone') fail(`动画 ${anim.name} 含非 bone 类型的 animator（${animator.type}）`);
    const bi = boneNameToIndex.get(animator.name);
    if (bi === undefined) fail(`动画 ${anim.name} 的 animator "${animator.name}" 不在骨骼表里`);
    driven.push({ bi, animator });
  }
  driven.sort((a, b) => a.bi - b.bi);
  const boneIndices = driven.map((d) => d.bi);
  // 预解析每骨骼每 channel 的周期序列
  const seqs = driven.map(({ animator }) => {
    const out = {};
    for (const ch of ['rotation', 'position']) {
      const kfs = animator.keyframes.filter((k) => k.channel === ch)
        .map((k) => {
          if (k.data_points.length !== 1) fail(`动画 ${anim.name} 骨骼 ${animator.name} 的 ${ch} 关键帧有 ${k.data_points.length} 个 data_points（本烘焙只支持 1 个）`);
          const dp = k.data_points[0];
          const v = { x: num(dp.x), y: num(dp.y), z: num(dp.z) };
          if (!Object.values(v).every(Number.isFinite)) fail(`动画 ${anim.name} 骨骼 ${animator.name} 的 ${ch} 关键帧含非数值（表达式？）`);
          return { time: k.time, value: v };
        })
        .sort((a, b) => a.time - b.time);
      out[ch] = kfs.length ? toPeriodic(kfs, anim.length) : null;
    }
    return out;
  });
  const frames = new Array(frameCount * driven.length * 7);
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  for (let f = 0; f < frameCount; f++) {
    const t = f / ANIM_FPS;   // ⚠️ 不含 t=length（loop 语义：那等价于 t=0）
    for (let b = 0; b < driven.length; b++) {
      const o = (f * driven.length + b) * 7;
      const rot = seqs[b].rotation ? sampleChannel(seqs[b].rotation, t) : { x: 0, y: 0, z: 0 };
      const pos = seqs[b].position ? sampleChannel(seqs[b].position, t) : { x: 0, y: 0, z: 0 };
      // 欧拉角逐分量插值后转四元数（与 Blockbench 一致：它插的是欧拉角，不是四元数）
      euler.set(rot.x * DEG, rot.y * DEG, rot.z * DEG, 'XYZ');
      quat.setFromEuler(euler);
      frames[o] = quat.x; frames[o + 1] = quat.y; frames[o + 2] = quat.z; frames[o + 3] = quat.w;
      frames[o + 4] = pos.x * PX2BLOCK;
      frames[o + 5] = pos.y * PX2BLOCK;
      frames[o + 6] = pos.z * PX2BLOCK;
    }
  }
  return { fps: ANIM_FPS, frameCount, boneIndices, frames };
}

/** 关键帧分量取值：缺省 0，字符串（表达式）视为非法 */
function num(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string') return Number.NaN;   // 交给调用方的 isFinite 检查报错
  return v;
}

function main() {
  if (!fs.existsSync(DRAGON_SOURCE_PATH)) fail(`烘焙输入缺失：${DRAGON_SOURCE_PATH}`);
  const raw = JSON.parse(fs.readFileSync(DRAGON_SOURCE_PATH, 'utf8'));
  const elements = raw.elements || [];
  if (elements.length !== DRAGON_METRICS.elementCount) {
    fail(`元素数 ${elements.length} ≠ 期望 ${DRAGON_METRICS.elementCount}（素材换了？同步 DRAGON_METRICS）`);
  }

  // ==================== 1. 骨骼层级 ====================
  const bonesRaw = [];
  const elemToBone = new Map();   // element uuid → bone index
  function walk(node, parentIndex) {
    const idx = bonesRaw.length;
    bonesRaw.push({
      name: node.name, parentIndex,
      origin: node.origin || [0, 0, 0],
      rotation: node.rotation || [0, 0, 0],
    });
    for (const c of node.children || []) {
      if (typeof c === 'string') elemToBone.set(c, idx);   // 元素 uuid
      else walk(c, idx);                                    // 子骨骼
    }
  }
  for (const root of raw.outliner || []) walk(root, -1);
  if (bonesRaw.length !== DRAGON_METRICS.boneCount) {
    fail(`骨骼数 ${bonesRaw.length} ≠ 期望 ${DRAGON_METRICS.boneCount}`);
  }

  // 旋转修正的 localPosition + bindQuaternion（见文件头注释）
  const worldQuat = [];   // 每骨骼 bind pose 的累积世界旋转
  const bones = [];
  for (let i = 0; i < bonesRaw.length; i++) {
    const b = bonesRaw[i];
    const localQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(b.rotation[0] * DEG, b.rotation[1] * DEG, b.rotation[2] * DEG, 'XYZ'));
    const parentWorldQuat = b.parentIndex === -1 ? new THREE.Quaternion() : worldQuat[b.parentIndex];
    worldQuat[i] = parentWorldQuat.clone().multiply(localQuat);
    const parentOrigin = b.parentIndex === -1 ? [0, 0, 0] : bonesRaw[b.parentIndex].origin;
    const d = new THREE.Vector3(
      b.origin[0] - parentOrigin[0], b.origin[1] - parentOrigin[1], b.origin[2] - parentOrigin[2]);
    d.applyQuaternion(parentWorldQuat.clone().invert());   // R_parentWorld⁻¹ · d
    bones.push({
      name: b.name,
      parentIndex: b.parentIndex,
      localPosition: [d.x * PX2BLOCK, d.y * PX2BLOCK, d.z * PX2BLOCK],
      bindQuaternion: [localQuat.x, localQuat.y, localQuat.z, localQuat.w],
    });
  }

  // ==================== 2. 合并几何 ====================
  const position = [], normal = [], uv = [], skinIndex = [], index = [];
  const bonesWithElems = new Set();
  let vOff = 0;
  for (const el of elements) {
    if (el.type !== 'cube') fail(`元素 "${el.name}" 类型 ${el.type} ≠ cube（本烘焙只支持 cube）`);
    const bi = elemToBone.get(el.uuid);
    if (bi === undefined) fail(`元素 "${el.name}" 无骨骼归属（outliner 里没有它）`);
    bonesWithElems.add(bi);
    const f = el.from, t = el.to;
    const sx = (t[0] - f[0]) * PX2BLOCK, sy = (t[1] - f[1]) * PX2BLOCK, sz = (t[2] - f[2]) * PX2BLOCK;
    if (!(sx > 0 && sy > 0 && sz > 0)) fail(`元素 "${el.name}" 尺寸非正 (${sx},${sy},${sz})`);
    const cx = (f[0] + t[0]) / 2 * PX2BLOCK;
    const cy = (f[1] + t[1]) / 2 * PX2BLOCK;
    const cz = (f[2] + t[2]) / 2 * PX2BLOCK;
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(cx, cy, cz);
    const gp = g.getAttribute('position'), gn = g.getAttribute('normal'),
      gu = g.getAttribute('uv'), gi = g.getIndex();
    // UV 重映射：把 BoxGeometry 的 [0,1] 标准 UV 线性映射到元素逐面矩形
    for (let face = 0; face < 6; face++) {
      const fn = FACE_ORDER[face];
      const rect = el.faces?.[fn]?.uv;
      if (!rect || rect.length !== 4) fail(`元素 "${el.name}" 面 ${fn} 缺 uv`);
      const [u1, v1, u2, v2] = rect;
      for (let k = 0; k < 4; k++) {
        const vi = face * 4 + k;
        const bu = gu.getX(vi), bv = gu.getY(vi);
        // bu=0→u1, bu=1→u2（保留递减）；bv=1→图片顶(v1), bv=0→图片底(v2)，flipY 换算
        const u = u1 / textureSize + bu * (u2 - u1) / textureSize;
        const v = (1 - v2 / textureSize) + bv * (v2 - v1) / textureSize;
        gu.setXY(vi, u, v);
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
  if (vOff !== DRAGON_METRICS.vertexCount) fail(`顶点数 ${vOff} ≠ 期望 ${DRAGON_METRICS.vertexCount}`);
  if (index.length !== DRAGON_METRICS.indexCount) fail(`索引数 ${index.length} ≠ 期望 ${DRAGON_METRICS.indexCount}`);
  if (bonesWithElems.size !== DRAGON_METRICS.bonesWithElements) {
    fail(`带元素骨骼数 ${bonesWithElems.size} ≠ 期望 ${DRAGON_METRICS.bonesWithElements}`);
  }
  for (const v of uv) if (!(v >= 0 && v <= 1)) fail(`UV 越界 ${v}（应 ∈ [0,1]）`);

  // ==================== 3. 贴图 ====================
  const tex = (raw.textures || [])[0];
  if (!tex?.source) fail('素材无内嵌贴图（textures[0].source 缺失）');
  const b64 = tex.source.split(',')[1];
  if (!b64) fail('贴图 source 不是 data URL');
  const pngBuf = Buffer.from(b64, 'base64');
  const png = PNG.sync.read(pngBuf);
  if (png.width !== textureSize || png.height !== textureSize) {
    fail(`贴图 ${png.width}×${png.height} ≠ 期望 ${textureSize}²`);
  }

  // ==================== 4. 动画重采样（catmullrom → 30fps 帧序列）====================
  const boneNameToIndex = new Map(bones.map((b, i) => [b.name, i]));
  const animations = {};
  for (const name of ANIM_NAMES) {
    const anim = (raw.animations || []).find((a) => a.name === name);
    if (!anim) fail(`素材缺动画 ${name}`);
    animations[name] = resampleAnimation(anim, boneNameToIndex);
    console.log(`[龙烘焙]   动画 ${name}: ${animations[name].frameCount} 帧 × ${animations[name].boneIndices.length} 骨骼`);
  }

  // ==================== 5. 写产物 ====================
  fs.mkdirSync(path.dirname(DRAGON_JSON), { recursive: true });
  fs.writeFileSync(DRAGON_PNG, pngBuf);
  const asset = {
    scale,
    bones,
    geometry: { position, normal, uv, skinIndex, index },
    animations,
    metrics: {
      elementCount: elements.length, boneCount: bones.length,
      bonesWithElements: bonesWithElems.size,
      vertexCount: vOff, indexCount: index.length, scale,
    },
  };
  fs.writeFileSync(DRAGON_JSON, JSON.stringify(asset));
  const fp = dragonInputFingerprint();
  fs.writeFileSync(DRAGON_META, JSON.stringify({
    fingerprints: { input: fp.input, bbmodelSha256: fp.sourceSha256, paramsSha256: fp.paramsSha256 },
    metrics: asset.metrics,
    textureSize,
  }, null, 1));

  const rel = (p) => path.relative(process.cwd(), p);
  console.log(`[龙烘焙] ✓ ${bones.length} 骨骼 / ${elements.length} 元素 / ${vOff} 顶点 / ${index.length} 索引 / 贴图 ${textureSize}²`);
  console.log(`[龙烘焙]   产物 ${rel(DRAGON_JSON)} + ${rel(DRAGON_PNG)} + ${rel(DRAGON_META)}`);
  console.log(`[龙烘焙]   指纹 ${fp.input}`);
}

main();
