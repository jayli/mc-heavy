// src/render/ignis-model.js — 焰魔（v2.55）：产物装载 + 动画采样
//
// 分层归属 `render/`（主线程专用：`loadIgnisAsset` 要 fetch 产物）。**采样函数是 three-free
// 的纯函数**（四元数 slerp 手写），浏览器单测可直接驱动 —— 与 `dragon-model.js` /
// `zombie-model.js` 同口径。
//
// 产物由 `tools/bake-ignis.mjs` 离线烘焙（`npm run ignis`），参数与指纹的权威在
// `tools/ignis-fingerprint.mjs`。
//
// ## 与 `dragon-model.js` 的关系（刻意复制、不抽公共层）
//
// `slerpQuat` / `multiplyQuat` / `sampleIgnisAnim` 与飞龙那份**逐字同形**。为什么不抽成
// 公共模块：飞龙那份已在生产运行且被 28 个用例覆盖，动它是无收益的风险；而焰魔的差异
// （两条动画由 `attackAnimT` 选择、attack 播完停末帧、idle 的 fps 不是整数）都落在
// **调用方式**上，抽公共层只能省掉 40 行纯数学。
//
// ⚠️ **动画帧是「相对 bind pose 的增量」**（运行期 `bindQuat * deltaRot`，与飞龙同口径）：
// 采样结果必须与骨骼的 bind 变换**相乘**，不是替换。替换的形态是「焰魔摆成素材的绝对姿态」
// —— 模型的头会从 −20° 翻到关键帧值。
import { resourceUrl } from '../core/resource-url.js';

/**
 * 加载烘焙产物。
 *
 * ⚠️ **路径必须走 `resourceUrl()`**（v1.87 约束）：站点根绝对路径 `'/assets/...'` 在仓库挂
 * 子路径部署时全部 404，而开发服务器恒为根路径 → 本机测试全绿、部署后白屏。
 *
 * ⚠️ **贴图不在这里加载**：渲染器用 `TextureLoader`（与 `zombie-skin-texture.js` /
 * `dragon-renderer.js` 同口径），因为纹理参数（colorSpace / filter / flipY）是渲染层的事。
 *
 * @returns {Promise<{scale:number, bones:Array, geometry:object, animations:object, metrics:object}>}
 */
export async function loadIgnisAsset() {
  // ⚠️ cache-busting：dev 服务器不设 Cache-Control，浏览器可能对同 origin 的 JSON 做启发式
  // 缓存 → 重烘产物后 reload 可能读到旧 JSON。（产物只在启动时加载一次，无性能代价。）
  const res = await fetch(`${resourceUrl('assets/ignis/ignis.json')}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`[ignis] 产物加载失败：${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * 焰魔死亡爆散的碎块基色（v2.64b，火焰橙）。0..1 三分量。
 *
 * ⚠️ **焰魔是纹理驱动的**（不像丧尸有 `fallbackColor` 可读），故这里单独给一个常量。
 * 取色依据：`assets/ignis/ignis.png` 的实测主色是金黄/橙的火焰色（占比前三档
 * rgb 255,234,144 / 255,215,63 / 205,126,0），取中间档 `255,215,63` 偏橙的火焰色，
 * 读作「一团火炸开」。与丧尸的「皮肤绿」同位点 —— 颜色由调用方（`Game._onEntityDeath`）给。
 */
export const IGNIS_DEATH_COLOR = Object.freeze([1.0, 0.84, 0.25]);

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
 * @returns {{rot:number[], pos:number[]}}
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
 * ⚠️ **时刻按 `frameCount / fps` 取模**：`idle` 的时长远短于一次待机展示（玩家可能站着不动
 * 几分钟），不取模会越界读到 undefined。取模让素材动画**循环播放**。
 *
 * ⚠️ **`frameCount <= 1` 时直接返回该帧**（不插值、不取模）：`frameCount = 1` 时
 * `i1 = (0 + 1) % 1 = 0`，插值退化成「永远第 0 帧」——这本身是对的，但 `duration` 可能是
 * 0（`fps` 非法），除零会得到 NaN 时刻。
 *
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}} anim
 * @param {number} timeSeconds
 * @returns {Map<number, {rot:number[], pos:number[]}>} boneIndex → 增量
 */
export function sampleIgnisAnim(anim, timeSeconds) {
  const out = new Map();
  if (!anim || !(anim.frameCount > 0) || !Array.isArray(anim.frames)) return out;
  const fps = Number.isFinite(anim.fps) && anim.fps > 0 ? anim.fps : 30;
  const duration = anim.frameCount / fps;
  // 非负取模（AGENTS.md：JS 的 % 对负数返回负值）
  const raw = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const t = ((raw % duration) + duration) % duration;
  const f = t * fps;
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
 * 采样「攻击动画在时刻 t」的姿态，**播完停在末帧**（不循环）。
 *
 * 与 `sampleIgnisAnim` 的差异只有一处：`t` 超过动画时长时**钳到末帧**而不是取模。
 * 理由：挥砍是一段有始有终的动作，播完回绕到起手帧会让「收招」变成「突然重新抬手」。
 * 真正回到 idle 由 **`attackAnimT` 被状态机清零**（`ignis-boss-agent` 的 `attackAnimT >=
 * attackAnimSeconds` 分支）驱动 —— 渲染层只负责「在 attack 态里画 attack 动画」。
 *
 * ⚠️ **不能靠「传 `duration − ε` 给 `sampleIgnisAnim`」实现钳制**：那个函数内部会再次
 * `t % duration`，而 `duration − 1e-9` 仍 < `duration` ⇒ 取模不生效、但它也不是末帧
 * 的精确时刻（差 1e-9 × fps 帧）。实测踩到：断言「停在末帧」时拿到了首帧姿态，
 * 因为绕了一圈后发现 `t` 又被算回了起点附近。故本函数**直接钳帧索引**。
 *
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}} anim
 * @param {number} timeSeconds
 * @returns {Map<number, {rot:number[], pos:number[]}>}
 */
export function sampleIgnisAttack(anim, timeSeconds) {
  if (!anim || !(anim.frameCount > 0) || !Array.isArray(anim.frames)) return new Map();
  const fps = Number.isFinite(anim.fps) && anim.fps > 0 ? anim.fps : 30;
  const raw = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  let f = raw * fps;
  if (f < 0) f = 0;
  // 越过末尾 → 钉在末帧（不取模、不回绕）
  if (f >= anim.frameCount - 1) f = anim.frameCount - 1;
  const out = new Map();
  const i0 = Math.floor(f);
  const i1 = Math.min(i0 + 1, anim.frameCount - 1);
  const frac = f - i0;
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
