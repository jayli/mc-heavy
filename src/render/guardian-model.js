// src/render/guardian-model.js — 末影守卫：产物装载 + 动画采样
//
// 分层归属 `render/`（主线程专用：`loadGuardianAsset` 要 fetch 产物）。**采样函数是 three-free
// 的纯函数**（四元数 slerp 手写），浏览器单测可直接驱动 —— 与 `ignis-model.js` /
// `dragon-model.js` 同口径。
//
// 产物由 `tools/bake-guardian.mjs` 离线烘焙（`npm run guardian`），参数与指纹的权威在
// `tools/guardian-fingerprint.mjs`。
//
// ## 与 `ignis-model.js` 的关系（刻意复制、不抽公共层）
//
// `slerpQuat` / `multiplyQuat` / 采样与衔接逐字同形。理由照抄焰魔那份：飞龙/焰魔两份已在
// 生产运行且被大量用例覆盖，动它们是无收益的风险；而守卫的差异（**四条**攻击片段、
// **没有 idle 片段**⇒ 程序化摆臂、坐标口径 A）都落在**调用方式**上，抽公共层只能省 40 行纯数学。
//
// ⚠️ **动画帧是「相对 bind pose 的增量」**（运行期 `bindQuat * deltaRot`）：
// 采样结果必须与骨骼的 bind 变换**相乘**，不是替换。
//
// ⚠️⚠️ **坐标口径 A**（spec §2.2.1）：产物顶点是 Java **局部**坐标（仅 y 翻转）、`pivot` 恒零
// ⇒ 渲染器每帧 `bone.position = localPosition + delta.pos`，**不是**焰魔的
// `pivot − R·pivot + delta.pos`。本文件的采样只产出增量，公式在渲染器里。
import { resourceUrl } from '../core/resource-url.js';

/**
 * 加载烘焙产物。
 *
 * ⚠️ **路径必须走 `resourceUrl()`**：站点根绝对路径在仓库挂子路径部署时全部 404，
 * 而开发服务器恒为根路径 ⇒ 本机测试全绿、部署后白屏。
 * ⚠️ **贴图不在这里加载**：纹理参数（colorSpace / filter / flipY）是渲染层的事。
 *
 * @returns {Promise<{scale:number, bones:Array, geometry:object, animations:object, metrics:object}>}
 */
export async function loadGuardianAsset() {
  // ⚠️ cache-busting：dev 服务器不设 Cache-Control，重烘产物后 reload 可能读到旧 JSON。
  // （产物只在启动时加载一次，无性能代价。这是全仓唯一允许 Date.now() 的位置之一。）
  const res = await fetch(`${resourceUrl('assets/guardian/guardian.json')}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`[guardian] 产物加载失败：${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * 守卫死亡爆散的碎块基色（主题紫）。0..1 三分量。
 *
 * 取色依据：眼睛层 `ender_guardian_layer.png` 的实测主色 `(161,83,254)`（542 像素，占比第一）
 * 归一化 ⇒ 读作「一团紫色虚空能量炸开」。与焰魔的火焰橙同位点 —— 颜色由调用方
 * （`Game._onEntityDeath`）给。
 */
export const GUARDIAN_DEATH_COLOR = Object.freeze([0.63, 0.33, 1.0]);

/**
 * 四元数球面插值（手写 —— 本文件的采样函数保持 three-free）。
 *
 * ⚠️ **`dot < 0` 时取反一端**：q 与 −q 是同一旋转，不取反会走长弧（骨骼瞬间翻转 360°）。
 * ⚠️ **`|dot| ≈ 1` 时退化成 lerp + 归一化**：slerp 的 `sin θ` 分母趋零会数值爆炸。
 *
 * @param {number[]} a `[x,y,z,w]` @param {number[]} b @param {number} t ∈ [0,1]
 * @returns {number[]} 新数组
 */
export function slerpQuat(a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  if (dot > 0.9995) {
    const x = a[0] + (bx - a[0]) * t, y = a[1] + (by - a[1]) * t;
    const z = a[2] + (bz - a[2]) * t, w = a[3] + (bw - a[3]) * t;
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
 * = `[qx,qy,qz,qw, px,py,pz]`（旋转是增量四元数，位移是增量、单位格）。
 */
function readFrame(anim, frameIndex, slot) {
  const o = (frameIndex * anim.boneIndices.length + slot) * 7;
  return {
    rot: [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]],
    pos: [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]],
  };
}

/**
 * 采样一个动画在某时刻的骨骼增量（帧间插值，**循环**）。
 *
 * ⚠️ 时刻按 `frameCount / fps` **非负取模**（JS 的 `%` 对负数返回负值）。
 * ⚠️ 守卫的四条片段都是攻击动画，本函数主要服务「需要循环播放」的场合与单测；
 * 攻击态走 `sampleGuardianAttack`（播完停末帧）。
 *
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}} anim
 * @param {number} timeSeconds
 * @returns {Map<number, {rot:number[], pos:number[]}>} boneIndex → 增量
 */
export function sampleGuardianAnim(anim, timeSeconds) {
  const out = new Map();
  if (!anim || !(anim.frameCount > 0) || !Array.isArray(anim.frames)) return out;
  const fps = Number.isFinite(anim.fps) && anim.fps > 0 ? anim.fps : 20;
  const duration = anim.frameCount / fps;
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
 * 采样攻击动画在时刻 t 的姿态，**播完停在末帧**（不循环）。
 *
 * ⚠️ **不能靠「传 duration − ε 给 sampleGuardianAnim」实现钳制**：那个函数内部会再取模，
 * 得到的不是末帧的精确时刻。焰魔实测踩过（断言「停在末帧」时拿到首帧姿态）。
 * 故本函数**直接钳帧索引**。
 *
 * 回到 idle 由状态机把 `attackAnimT` 清零驱动 —— 渲染层只负责「在 attack 态里画 attack」。
 *
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}} anim
 * @param {number} timeSeconds
 * @returns {Map<number, {rot:number[], pos:number[]}>}
 */
export function sampleGuardianAttack(anim, timeSeconds) {
  if (!anim || !(anim.frameCount > 0) || !Array.isArray(anim.frames)) return new Map();
  const fps = Number.isFinite(anim.fps) && anim.fps > 0 ? anim.fps : 20;
  const raw = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  let f = raw * fps;
  if (f < 0) f = 0;
  if (f >= anim.frameCount - 1) f = anim.frameCount - 1;   // 钳末帧，不取模
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

// ==================== 姿态衔接 ====================
//
// 与焰魔 v2.76 同一分工：来源切换（程序化 idle ↔ 四条攻击片段）时把「上一帧实际发布的姿态」
// 冻结成起点，用 smoothstep 权重混向新来源的**实时**采样。片段时钟不被推迟 ⇒
// 命中帧 / 动画时长 / 冷却一概不变（纯视觉层，权威 state 仍瞬时）。

/** 单位增量：某骨骼在一侧姿态里缺席时按它参与混合（= 回到 bind） */
const IDENTITY_DELTA = Object.freeze({
  rot: Object.freeze([0, 0, 0, 1]),
  pos: Object.freeze([0, 0, 0]),
});

/**
 * 两个骨骼增量的混合（旋转 slerp、位移 lerp）。
 *
 * ⚠️ **端点直接取值、不走 slerp**：`w=1` 时 slerp 在 `dot<0` 会返回 `−b`（同一旋转、符号相反），
 * 让「走满淡入后精确等于目标」在分量层面成立不了。返回值始终是新数组。
 */
function mixDelta(a, b, w) {
  if (w <= 0) return { rot: a.rot.slice(), pos: a.pos.slice() };
  if (w >= 1) return { rot: b.rot.slice(), pos: b.pos.slice() };
  return {
    rot: slerpQuat(a.rot, b.rot, w),
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * w,
      a.pos[1] + (b.pos[1] - a.pos[1]) * w,
      a.pos[2] + (b.pos[2] - a.pos[2]) * w,
    ],
  };
}

/**
 * 混合两个姿态：`w=0` → a，`w=1` → b。**骨骼集合取并集**，缺席一侧按单位增量。
 *
 * ⚠️ 取并集是必需的：不同来源驱动的骨骼不同（四招各驱动 9~12 根）。若混合后某骨骼从输出里
 * 消失而它当时不在 bind，它会永远停在那个姿态。
 *
 * @param {Map} a 起点（不被修改）@param {Map} b 终点（不被修改）@param {number} w ∈ [0,1]
 * @returns {Map} 新 Map
 */
export function blendGuardianPose(a, b, w) {
  const t = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;
  const out = new Map();
  for (const [bi, da] of a) out.set(bi, mixDelta(da, b.get(bi) || IDENTITY_DELTA, t));
  for (const [bi, db] of b) {
    if (!a.has(bi)) out.set(bi, mixDelta(IDENTITY_DELTA, db, t));
  }
  return out;
}

/**
 * 逐实例的姿态过渡器（**有状态**，每只守卫一份）。
 *
 * - 首帧 / `reset()` 后：直接发布 target；
 * - 来源切换：把**上一帧实际发布的姿态**冻结成起点（这样淡入中途被再次打断也从当前混合结果
 *   起步，永远没有跳变）；
 * - 过渡期：`blend(起点, target, smoothstep(elapsed / seconds))`；
 * - 走满那一帧：按并集 `w=1` 发布一次（让「起点驱动而目标不驱动」的骨骼回到 bind）。
 *
 * ⚠️ **持有 target**：调用方在 `step()` 之后不得再修改传入的 Map
 * （两个采样函数每次返回新 Map，天然满足）。
 */
export class GuardianPoseTransition {
  /** @param {number} seconds 默认淡入时长（秒）；≤0 / 非法 ⇒ 不过渡 */
  constructor(seconds) {
    this._seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    this.reset();
  }

  /** 清空衔接状态（实例复用给新实体时调用） */
  reset() {
    this._key = null;
    this._last = null;
    this._from = null;
    this._elapsed = 0;
    this._duration = this._seconds;
  }

  /**
   * @param {string} key 本帧来源（'idle' 或四档招式名）
   * @param {Map} target 该来源在本帧的实时采样
   * @param {number} dt 距上一帧的秒数
   * @param {number} [seconds] **本次切换**的淡入时长（切换时锁定；不传用构造默认值）
   * @returns {Map} 本帧应发布的姿态
   */
  step(key, target, dt, seconds) {
    const dtSafe = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this._last === null) {
      this._from = null;
    } else if (key !== this._key) {
      this._from = this._last;
      this._elapsed = 0;
      this._duration = seconds === undefined
        ? this._seconds
        : (Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }
    this._key = key;

    let out = target;
    if (this._from !== null) {
      this._elapsed += dtSafe;
      if (this._elapsed >= this._duration) {
        out = blendGuardianPose(this._from, target, 1);
        this._from = null;
      } else {
        const s = this._elapsed / this._duration;
        out = blendGuardianPose(this._from, target, s * s * (3 - 2 * s));   // smoothstep
      }
    }
    this._last = out;
    return out;
  }
}