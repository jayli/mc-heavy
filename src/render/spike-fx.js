// src/render/spike-fx.js — 焰魔尖刺攻击的火焰尖锥（v3.06）
//
// ⚠️⚠️ **原版没有尖刺几何**：`Ignis_Entity.java` 的 `ShieldSmashDamage` / `UltimateAttack`
// 都是生成 `Cm_Falling_Block_Entity`（把地面方块**整块掀飞**，真实体方块）+ 对该格 AABB
// 内的生物扣血。本仓的火焰尖锥是**新建的程序化几何**（用户 2026-11-15 裁定「火焰尖锥，
// 橙红发光」）—— 零新增贴图文件，颜色走逐实例 `instanceColor`。
//
// 与 `flame-sigil.js`（地面火焰法阵）的三处刻意差异：
//   ① **首根在正前方 2 格，不在脚底**（法阵 `firstOffset = 0`）：用户要「向**前** 10 格内
//      放出尖刺」，首根长在自己脚下读不出「向前」。落点 = 2/4/6/8/10 格。
//   ② **几何是竖直锥体而不是贴地 quad**：读作「从地里刺出来」。
//   ③ **带伤害**（`IGNIS_SPIKE.damage = 18`，在 `game.js` 结算）：法阵是纯视觉（v3.04 裁定），
//      本轮用户明确要尖刺带 18 ⇒ 新招新口径，不改法阵。
//
// ⚠️ 三条池化硬约束（与 flame-sigil / explosion-renderer 同口径，M6 实测教训）：
//   · 空闲 slot 零 scale，且**零活跃时 `visible=false`** —— 否则恒增 draw call，
//     且常驻透明 mesh 会进透明排序列表干扰水面绘制顺序不变式。
//   · 每帧零分配：临时矩阵/向量都是模块级常量。
//   · 时间基准 `performance.now()`，禁止 `Date.now()`。
//
// ⚠️⚠️ **逐根亮度必须走 `instanceColor`，不能写共享 `material.opacity`**（v3.04b 实测教训）：
// 5 根延迟只差 0~200ms，材质取「活跃根 opacity 最大值」会让**先缩回的根被后根拖着满亮**
// ⇒ `spikeScaleAt` 的包络在画面上基本不生效（纯函数单测全绿，只有逐实例判据能抓）。
//
// **主线程专用**：构造 InstancedMesh/材质必然依赖 three。归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查）。
import * as THREE from 'three';
import { IGNIS_SPIKE } from '../entities/ignis/ignis-config.js';

/**
 * 尖锥的节奏与容量（冻结，渲染层不得改写）。
 *
 * ⚠️ **几何/节奏/容量全部从 `IGNIS_SPIKE` 派生**（红线 1：同一事实只有一份权威）——
 * 玩法侧与渲染侧各写一份的形态是「伤害判定用的格与画出来的刺不在同一处」。
 * 本表只额外持有**纯观感**的两项：`shrinkFrom`（缩零起点）与 `color`（火焰色）。
 */
export const SPIKE_FX = Object.freeze({
  riseMs: IGNIS_SPIKE.riseMs,
  lifeMs: IGNIS_SPIKE.lifeMs,
  height: IGNIS_SPIKE.height,
  radius: IGNIS_SPIKE.radius,
  maxActive: IGNIS_SPIKE.maxActive,
  /** 寿命进度到此开始缩零（前 70% 保持满尺寸，含升起段） */
  shrinkFrom: 0.7,
  /**
   * 火焰橙红。比 `IGNIS_DEATH_COLOR`（1.0, 0.84, 0.25 偏黄）更红 ——
   * 读作「烧红的刺」而不是「一团火炸开」。additive 下它也是亮度上限。
   */
  color: Object.freeze([1.0, 0.45, 0.12]),
});

const _matrix = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();

/**
 * 5 根尖刺的落点（**不含 y** —— 渲染层不查体素，地面高度由调用方算，
 * 与 `flame-sigil.js` / `block-hit-fx.js` 同口径）。
 *
 * ⚠️ **yaw 用本仓口径**：正前方 = `(−sin yaw, −cos yaw)`
 * （与 `entities/bosses/dragon-boss-agent.js` 的移动方向同一份语义）。
 * **不得照抄原版 `cos(yaw+90°)/sin(yaw+90°)`** —— 原版 yaw 定义不同，照抄会整排偏 90°，
 * 而根数/间距/延迟全部仍然正确（静默失效）。
 *
 * @param {number[]} at 焰魔身体位置 `[x,y,z]`（脚底）
 * @param {number} yaw 本仓 yaw（弧度）
 * @param {object} [cfg] 缺省 `IGNIS_SPIKE`
 * @returns {Array<{x:number, z:number, delayMs:number}>}
 */
export function spikeSpawnPoints(at, yaw, cfg = IGNIS_SPIKE) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const points = [];
  for (let i = 0; i < cfg.count; i++) {
    const d = cfg.spacing * (i + 1) + (cfg.firstOffset - cfg.spacing);
    points.push({
      x: at[0] + fx * d,
      z: at[2] + fz * d,
      delayMs: i * cfg.delayPerSegmentMs,
    });
  }
  return points;
}

/**
 * 单根尖刺的尺寸包络（升起 → 保持 → 缩回）。
 *
 * 三段语义：
 *   · `age < delay`：递延未到 ⇒ **不画**（但 slot 仍占用，不得回收）
 *   · `lived < riseMs`：从地里升起，scale 线性 0→1
 *   · `riseMs ≤ lived < lifeMs × shrinkFrom`：满尺寸保持
 *   · 之后线性缩回 0；`lived ≥ lifeMs` ⇒ `done`（回收 slot）
 *
 * ⚠️ **返回值默认是复用对象**（每帧每个 slot 调一次）：渲染器传模块级 `_env`，
 * 调用后须立即消费、不得保留引用。单测不传 `out` 时每次新建（方便逐次比较）。
 *
 * @param {number} ageMs 自 spawn 起的毫秒数
 * @param {number} delayMs 本根延迟
 * @param {object} [cfg]
 * @param {{scale:number, visible:boolean, done:boolean}} [out]
 * @returns {{scale:number, visible:boolean, done:boolean}}
 */
export function spikeScaleAt(ageMs, delayMs, cfg = SPIKE_FX,
  out = { scale: 0, visible: false, done: false }) {
  if (ageMs < delayMs) {
    out.scale = 0; out.visible = false; out.done = false;
    return out;
  }
  const lived = ageMs - delayMs;
  if (lived >= cfg.lifeMs) {
    out.scale = 0; out.visible = false; out.done = true;
    return out;
  }
  const shrinkAt = cfg.lifeMs * cfg.shrinkFrom;
  let s;
  if (lived < cfg.riseMs) s = lived / cfg.riseMs;
  else if (lived < shrinkAt) s = 1;
  else s = 1 - (lived - shrinkAt) / (cfg.lifeMs - shrinkAt);
  out.scale = Math.max(0, Math.min(1, s));
  out.visible = out.scale > 0;
  out.done = false;
  return out;
}

/** `spikeScaleAt` 的复用输出（每帧每 slot 一次，不得每帧新建对象） */
const _env = { scale: 0, visible: false, done: false };

export class SpikeFxRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number}} deps
   *   **无贴图依赖**（程序化几何 + 逐实例颜色）⇒ 恒装配，不像法阵那样可能退 null。
   */
  constructor({ scene, maxActive = SPIKE_FX.maxActive }) {
    this.scene = scene;
    this.maxActive = maxActive;

    // 6 棱锥（像素风）；`translate` 把底面移到 y=0 ⇒ 实例 position 就是地面顶面
    const geometry = new THREE.ConeGeometry(SPIKE_FX.radius, SPIKE_FX.height, 6);
    geometry.translate(0, SPIKE_FX.height / 2, 0);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,   // 发光：读作「烧红的刺」
      depthWrite: false,                  // 不写深度：不挡地面、根间不互相挡
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'ignis:spike-fx';
    // 实例包围球按零 scale 算会被误剔除；特效须无条件提交（同 tracer / explosion 池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;            // ⚠️ 零活跃时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    // 逐实例色初始化（建出 instanceColor 属性）—— **逐根亮度**靠它，见 update 的 ⚠️
    this.mesh.setColorAt(0, _color.setRGB(...SPIKE_FX.color));
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);

    /** @type {Array<{slot:number, x:number, y:number, z:number, delayMs:number, bornAt:number}>} */
    this._active = [];
    this._nextSlot = 0;
    this._geometry = geometry;
    this._material = material;
  }

  /** 活跃根数（测试钩子） */
  get activeCount() { return this._active.length; }

  /**
   * 起一排尖刺。池满时覆盖最旧 slot（纯视觉，丢弃无副作用）。
   * @param {Array<{x:number, y:number, z:number, delayMs:number}>} points
   *   **y 已由调用方算好**（地面顶面）；调用方负责跳过找不到地面的根。
   * @param {number} nowMs `performance.now()` 基准
   */
  spawn(points, nowMs) {
    if (!Array.isArray(points) || points.length === 0) return;
    // ⚠️ `nowMs` 非法（undefined/NaN）会让 `age = NaN` ⇒ scale NaN ⇒ NaN 写进
    // `setMatrixAt` 污染**整个池**（同法阵/碎块路径的 NaN 守卫口径）。
    if (!Number.isFinite(nowMs)) return;
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      const slot = this._nextSlot;
      this._nextSlot = (this._nextSlot + 1) % this.maxActive;
      const existing = this._active.findIndex((s) => s.slot === slot);
      if (existing !== -1) this._active.splice(existing, 1);
      this._active.push({
        slot, x: p.x, y: p.y, z: p.z,
        delayMs: Number.isFinite(p.delayMs) ? p.delayMs : 0,
        bornAt: nowMs,
      });
      // 延迟期内先摆成零 scale（不可见），update 到点后再摆出来
      this.mesh.setMatrixAt(slot, _zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  /**
   * 每帧推进：延迟到点的根升起、保持、缩回、寿命结束的回收。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    if (this._active.length === 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }
    let anyVisible = false;
    let colorDirty = false;
    for (let i = this._active.length - 1; i >= 0; i--) {
      const s = this._active[i];
      const env = spikeScaleAt(nowMs - s.bornAt, s.delayMs, SPIKE_FX, _env);
      if (env.done) {
        this.mesh.setMatrixAt(s.slot, _zero);
        this._active.splice(i, 1);
        continue;
      }
      if (!env.visible) {
        // 递延未到：占着 slot 但不画
        this.mesh.setMatrixAt(s.slot, _zero);
        continue;
      }
      anyVisible = true;
      // 三轴同比例缩放 ⇒ 读作「整根从地里长出来」（而不是只拔高变细）。
      // 底面已在几何里 translate 到 y=0 ⇒ 缩放不会把底面抬离地面。
      _matrix.makeScale(env.scale, env.scale, env.scale);
      // ⚠️ makeScale 会清掉位移 ⇒ 必须最后 setPosition
      //（`explosion-renderer.js` 记过这个坑：照抄 makeTranslation 会丢位置）
      _matrix.setPosition(s.x, s.y, s.z);
      this.mesh.setMatrixAt(s.slot, _matrix);
      // ⚠️⚠️ **逐根亮度走 instanceColor，不写共享 material.opacity**（见文件头）：
      // additive 下「颜色 × 系数」等价调亮度 ⇒ 用它做逐根淡出。
      const k = env.scale;
      _color.setRGB(SPIKE_FX.color[0] * k, SPIKE_FX.color[1] * k, SPIKE_FX.color[2] * k);
      this.mesh.setColorAt(s.slot, _color);
      colorDirty = true;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // 全部仍在递延期或已全部结束 ⇒ 不提交渲染（draw call 回到基线）
    this.mesh.visible = anyVisible;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();        // 释放 instanceMatrix / instanceColor 缓冲
    this._geometry.dispose();
    this._material.dispose();   // InstancedMesh.dispose 不释放材质
    this._active.length = 0;
  }
}