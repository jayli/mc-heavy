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

// ==================== 姿态衔接（v2.76）====================
//
// 用户缺陷（录像「焰魔旋转.mov」1.13s）：「身体本来是站定的，突然就切换到身体旋转举刀的形态了，
// 中间没有补间过渡」。根因：渲染器在 idle 与攻击片段之间按 `attackAnimT > 0` **硬切**，而旋斩的
// t=0 姿态（root.y −75° / sword.x 180° …）本是原版 `SPIN_ATTACK` 的**衔接姿态**
//（`startKeyframe(0)` 瞬间到位，且原版只会把它接在 `HORIZONTAL_SMALL_SWING_ALT_ATTACK2` 的收势后，
// `Ignis_Entity.java:2297`）。本仓按「每次起手按权重随机」让它从站立起手 ⇒ 一帧内整副骨架跳变
//（真实产物实测单帧最大骨骼角 177°，旋斩自身最快的合法单帧仅 24.5°）。
//
// 解法在渲染层（纯视觉，权威 state 仍瞬时，与 v2.62 上台阶缓动同一分工）：来源切换时把「上一帧
// 实际发布的姿态」冻结成起点，用 smoothstep 权重混向新来源的**实时**采样。片段时钟不被推迟 ⇒
// 命中帧 / 动画时长 / 冷却一概不变。

/** 单位增量（无旋转、无位移）：某骨骼在一侧姿态里缺席时，按它参与混合（= 回到 bind） */
const IDENTITY_DELTA = Object.freeze({
  rot: Object.freeze([0, 0, 0, 1]),
  pos: Object.freeze([0, 0, 0]),
});

/**
 * 两个骨骼增量的混合（旋转 slerp、位移 lerp）。
 *
 * ⚠️ **端点直接取值、不走 slerp**：`w=1` 时 slerp 在 `dot<0` 会返回 `−b`（同一旋转、符号相反），
 * 让「走满淡入后精确等于目标」在分量层面成立不了；端点特判后返回值与入参同值，且始终是新数组
 *（不与入参共享，调用方可放心持有）。
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
 * 混合两个姿态：`w=0` → `a`，`w=1` → `b`（`w` 越界 / NaN 钳到 [0,1] / 0）。
 *
 * ## 骨骼集合取并集，缺席一侧按单位增量
 *
 * 不同来源驱动的骨骼不同（idle 驱动 6 根，旋斩驱动 9 根，其中 5 根 idle 不驱动，如 `sword`）。
 * 渲染器只写「本帧姿态里出现的骨骼」—— 若混合后某骨骼从输出里**消失**而它当时不在 bind，
 * 它会永远停在那个姿态。取并集 + 缺席按单位增量混合，能让它在 `w=1` 时精确回到 bind
 *（与 `dragon-model.js` 的 `sampleDragonPose` 同口径，那份是时钟驱动的无状态版）。
 *
 * @param {Map<number, {rot:number[], pos:number[]}>} a 起点姿态（不被修改）
 * @param {Map<number, {rot:number[], pos:number[]}>} b 终点姿态（不被修改）
 * @param {number} w 权重 ∈ [0,1]
 * @returns {Map<number, {rot:number[], pos:number[]}>} 新 Map（骨骼集合 = a ∪ b）
 */
export function blendIgnisPose(a, b, w) {
  const t = Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0;
  const out = new Map();
  for (const [bi, da] of a) out.set(bi, mixDelta(da, b.get(bi) || IDENTITY_DELTA, t));
  for (const [bi, db] of b) {
    if (!a.has(bi)) out.set(bi, mixDelta(IDENTITY_DELTA, db, t));
  }
  return out;
}

/**
 * 逐实例的姿态过渡器（每只焰魔一份，**有状态**）。
 *
 * 每帧传入「本帧来源的标识 `key`」与「该来源在本帧的实时采样 `target`」，返回本帧应发布的姿态：
 * - 首帧 / `reset()` 之后：没有「上一帧输出」可衔接，直接发布 `target`。
 * - `key` 与上一帧不同（来源切换）：把**上一帧实际发布的姿态**冻结成起点，`elapsed = 0`。
 *   ⚠️ 起点取「上一帧的输出」而不是「上一个来源的采样」—— 这样**淡入中途被再次打断**也从
 *   当前混合结果起步，永远没有跳变（连续性对任意切换序列成立）。
 * - 过渡期内：`blend(起点, target, smoothstep(elapsed / seconds))`。smoothstep 两端斜率为 0 ——
 *   起步不突兀、收尾与片段自身的运动无速度断裂（线性权重在两端都有速度突变）。
 * - 走满 `seconds` 的那一帧：按并集 `w=1` 发布一次（只有「起点驱动而目标不驱动」的骨骼要借这一帧
 *   以单位增量回到 bind），之后丢弃起点、直接发布 `target`。
 *
 * ⚠️ **持有 `target`**：过渡器把本帧输出留作下一次切换的起点，所以调用方在 `step()` 之后
 * 不得再修改传入的 Map（`sampleIgnisAnim` / `sampleIgnisAttack` 每次返回新 Map，天然满足）。
 *
 * ⚠️ **`dt` 是真实帧间隔**（秒）：过渡走的是墙钟时间，与攻击片段的时钟同源同步前进，所以
 * 淡入结束那一刻发布的就是片段在该时刻的姿态（片段时钟不被推迟）。
 */
export class IgnisPoseTransition {
  /**
   * @param {number} seconds 默认淡入淡出时长（秒）—— `step()` 没传「本次时长」时用它；
   *        ≤0 / 非法 ⇒ 不过渡，等价硬切换
   */
  constructor(seconds) {
    this._seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    this.reset();
  }

  /** 清空衔接状态（实例复用给新实体时调用：新实体不得从上一只的姿态淡出） */
  reset() {
    this._key = null;
    this._last = null;      // 上一帧实际发布的姿态
    this._from = null;      // 过渡起点（null = 不在过渡中）
    this._elapsed = 0;
    this._duration = this._seconds;   // 当前这次过渡的时长（切换时锁定）
  }

  /**
   * @param {string} key 本帧来源（'idle' | 'attack' | 'spin'）
   * @param {Map<number, {rot:number[], pos:number[]}>} target 该来源在本帧的实时采样
   * @param {number} dt 距上一帧的秒数（非法 / 负数按 0）
   * @param {number} [seconds] **本次切换**的淡入时长（秒；v2.77：旋斩入场比其余来源慢）。
   *        只在「这一帧发生了来源切换」时读取并**锁定**到走完 —— 淡入途中再传别的值不会改动正在
   *        进行的这一次；不传 ⇒ 构造时的默认值；≤0 / 非法 ⇒ 这一次不过渡。
   *        谁用哪个时长的策略不在本类：渲染器按目标来源取 `ignisBlendSeconds(key)`（单一权威）。
   * @returns {Map<number, {rot:number[], pos:number[]}>} 本帧应发布的姿态
   */
  step(key, target, dt, seconds) {
    const dtSafe = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this._last === null) {
      this._from = null;                       // 首帧：无从衔接
    } else if (key !== this._key) {
      this._from = this._last;                 // 来源切换：冻结上一帧的输出
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
        out = blendIgnisPose(this._from, target, 1);   // 并集 w=1：让目标不驱动的骨骼回到 bind
        this._from = null;
      } else {
        const s = this._elapsed / this._duration;
        out = blendIgnisPose(this._from, target, s * s * (3 - 2 * s));   // smoothstep
      }
    }
    this._last = out;
    return out;
  }
}
