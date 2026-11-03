// src/render/dragon-model.js — 祭坛飞龙（v2.41）：产物装载 + 动画采样
//
// 分层归属 `render/`（主线程专用：`loadDragonAsset` 要 fetch 产物）。**采样函数是 three-free
// 的纯函数**（四元数 slerp 手写），浏览器单测可直接驱动 —— 与 `zombie-model.js` 同口径。
//
// 产物由 `tools/bake-dragon.mjs` 离线烘焙（`npm run dragon`），参数与指纹的权威在
// `tools/dragon-fingerprint.mjs`。
//
// ⚠️ **动画帧是「相对 bind pose 的增量」**（spec §2.2，实测素材 `override: false` = additive）：
// 采样结果必须与骨骼的 bind 变换**相乘**（`bindQuat * deltaRot`），不是替换。
// 替换的形态是「龙摆成素材的绝对姿态」—— 脖子从 40° 变成 −9°，整条龙瘫掉。
import { resourceUrl } from '../core/resource-url.js';
import { dragonAnimStateAt } from '../entities/dragons/dragon-system.js';

/**
 * 加载烘焙产物。
 *
 * ⚠️ **路径必须走 `resourceUrl()`**（v1.87 约束）：站点根绝对路径 `'/assets/...'` 在仓库挂
 * 子路径部署时全部 404，而开发服务器恒为根路径 → 本机测试全绿、部署后白屏。
 * `check:arch` 的 `[资源 URL]` 环节零白名单拦截这类字面量。
 *
 * ⚠️ **贴图不在这里加载**：渲染器用 `TextureLoader`（与 `zombie-skin-texture.js` 同口径），
 * 因为纹理参数（colorSpace / filter / flipY）是渲染层的事。
 *
 * @returns {Promise<{scale:number, bones:Array, geometry:object, animations:object, metrics:object}>}
 */
export async function loadDragonAsset() {
  // ⚠️ cache-busting：dev 服务器不设 Cache-Control，浏览器可能对同 origin 的 JSON 做启发式
  // 缓存 → 重烘产物后 reload 可能读到旧 JSON。加时间戳查询参数保证每次启动都拿最新烘焙产物。
  // （产物只在启动时加载一次，禁用缓存无性能代价。）
  const res = await fetch(`${resourceUrl('assets/dragon/dragon.json')}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`[dragon] 产物加载失败：${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * 四元数球面插值（手写 —— 本文件的采样函数保持 three-free）。
 *
 * ⚠️ **`dot < 0` 时取反一端**：四元数 q 与 −q 表示同一旋转，不取反会走「长弧」
 * （插值路径绕远路 → 骨骼瞬间翻转 360°）。
 * ⚠️ **`|dot| ≈ 1` 时退化成 lerp + 归一化**：slerp 的 `sin θ` 分母趋零会数值爆炸。
 *
 * @param {number[]} a `[x,y,z,w]` @param {number[]} b `[x,y,z,w]` @param {number} t ∈ [0,1]
 * @returns {number[]} `[x,y,z,w]`（新数组）
 */
export function slerpQuat(a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    // 极近：线性插值后归一化（与 slerp 的极限一致）
    let x = a[0] + (bx - a[0]) * t, y = a[1] + (by - a[1]) * t;
    let z = a[2] + (bz - a[2]) * t, w = a[3] + (bw - a[3]) * t;
    const n = Math.hypot(x, y, z, w) || 1;
    return [x / n, y / n, z / n, w / n];
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [
    a[0] * wa + bx * wb, a[1] * wa + by * wb,
    a[2] * wa + bz * wb, a[3] * wa + bw * wb,
  ];
}

/** 四元数乘法 `a * b`（three 的 `Quaternion.multiply` 同口径）。@returns {number[]} 新数组 */
export function multiplyQuat(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * 读一帧里某骨骼槽的增量。
 *
 * 产物布局：`frames[(frame × boneIndices.length + slot) * 7]` 起 7 个数
 * = `[qx, qy, qz, qw, px, py, pz]`（旋转是增量四元数，位移是增量、单位格）。
 *
 * @returns {{rot:number[], pos:number[]}|null} 该动画不驱动这根骨骼时返回 null
 */
function readFrame(anim, frameIndex, slot) {
  const o = (frameIndex * anim.boneIndices.length + slot) * 7;
  return {
    rot: [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]],
    pos: [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]],
  };
}

/**
 * 采样一个动画在某时刻的骨骼增量（帧间插值）。
 *
 * ⚠️ **时刻按 `frameCount / fps` 取模**：状态机段长（fly 4.0s）远大于素材动画自身时长
 * （1.2s），不取模会越界读到 undefined。取模让素材动画在段内**循环播放**（spec §6.3）。
 *
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}} anim
 * @param {number} timeSeconds
 * @returns {Map<number, {rot:number[], pos:number[]}>} boneIndex → 增量
 */
export function sampleDragonAnim(anim, timeSeconds) {
  const out = new Map();
  if (!anim || anim.frameCount <= 0) return out;
  const duration = anim.frameCount / anim.fps;
  // 非负取模（AGENTS.md：JS 的 % 对负数返回负值）
  const t = ((timeSeconds % duration) + duration) % duration;
  const f = t * anim.fps;
  const i0 = Math.floor(f) % anim.frameCount;
  const i1 = (i0 + 1) % anim.frameCount;   // loop：末帧的下一帧是首帧
  const frac = f - Math.floor(f);
  for (let slot = 0; slot < anim.boneIndices.length; slot++) {
    const a = readFrame(anim, i0, slot);
    const b = readFrame(anim, i1, slot);
    out.set(anim.boneIndices[slot], {
      rot: slerpQuat(a.rot, b.rot, frac),
      pos: [
        a.pos[0] + (b.pos[0] - a.pos[0]) * frac,
        a.pos[1] + (b.pos[1] - a.pos[1]) * frac,
        a.pos[2] + (b.pos[2] - a.pos[2]) * frac,
      ],
    });
  }
  return out;
}

/**
 * 按状态机混合 fly/glide（spec §6.3）。
 *
 * `blend === 0` 时只采 primary（省一半计算）；淡入/淡出期两个都采并按 blend 混合
 * （旋转 slerp、位移 lerp）。
 *
 * @param {{fly:object, glide:object}} animations 产物的 `animations` 字段
 * @param {number} t 轨道时钟（秒，与 `dragonPoseAt` 同源）
 * @returns {Map<number, {rot:number[], pos:number[]}>} boneIndex → 增量
 */
export function sampleDragonPose(animations, t) {
  const state = dragonAnimStateAt(t);
  const primary = sampleDragonAnim(animations[state.primary], state.primaryTime);
  if (state.secondary === null || state.blend === 0) return primary;
  const secondary = sampleDragonAnim(animations[state.secondary], state.secondaryTime);
  const w = state.blend;
  // 以 primary 为基底，把 secondary 按权重混进来（两根骨骼集合可能不同 → 取并集）
  for (const [bi, delta] of secondary) {
    const base = primary.get(bi);
    if (!base) {
      // 只有 secondary 驱动这根骨骼：从「无增量」（单位四元数 + 零位移）混到它
      primary.set(bi, {
        rot: slerpQuat([0, 0, 0, 1], delta.rot, w),
        pos: delta.pos.map((v) => v * w),
      });
      continue;
    }
    primary.set(bi, {
      rot: slerpQuat(base.rot, delta.rot, w),
      pos: [
        base.pos[0] + (delta.pos[0] - base.pos[0]) * w,
        base.pos[1] + (delta.pos[1] - base.pos[1]) * w,
        base.pos[2] + (delta.pos[2] - base.pos[2]) * w,
      ],
    });
  }
  return primary;
}
