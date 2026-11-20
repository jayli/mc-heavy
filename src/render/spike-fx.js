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
// ## v3.23：破土火星 + 上浮余烬（用户 2026-11-20）
//
// 「尖刺升起的时候带有粒子特效……就好像蹦出的火星一样」。两项裁定：
// **破土猛迸 + 余烬渐稀**（缩回时停）、**条状火星 + 少量上浮余烬**（不加烟）。
// 观感量与出生数据在 `spike-fx-config.js`（three-free），TSL 在 `spike-fx-material.js`。
// 本文件只负责**逐根按累计配额差值发射** —— 与尖锥共用同一份 `spikeScaleAt` 进度
// ⇒ 火星必然跟着那一根的破土时刻与升起高度走，不存在第二套时序。
//
// ⚠️⚠️ **粒子用 `THREE.Mesh` + InstancedBufferGeometry，不能用 `InstancedMesh`**：
// 后者的 instanceMatrix 会接管 modelViewMatrix，把由 aOrigin 定位的粒子全塌到原点
// （v3.21 实测：落点变一条白色竖糊，而 visible / 计数 / draw call 全绿）。
//
// **主线程专用**：构造 InstancedMesh/材质必然依赖 three。归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查）。
import * as THREE from 'three';
import { IGNIS_SPIKE } from '../entities/ignis/ignis-config.js';
import {
  SPIKE_SPARK_FX as SPARK, spikeSparkQuotaAt, spikeSparkSeeds,
  spikeTexUvRect, spikeTexPattern,
} from './spike-fx-config.js';
import {
  createSpikeSparkMaterial, createSpikeEmberMaterial, createSpikeSparkGeometry,
  createSpikeConeMaterial, createSpikePlainMaterial, SPIKE_TEX_ATTR,
} from './spike-fx-material.js';

/**
 * 纹样贴图边长 —— 与 `ignis.png` 一致（`IGNIS_BAKE_PARAMS.textureSize`）。
 * ⚠️ 换贴图尺寸时必须同步这个数与 `SPIKE_SPARK_FX.textureRect`（后者是**像素**坐标）。
 */
const SPIKE_TEX_SIZE = 256;

/**
 * 尖锥的节奏与容量（冻结，渲染层不得改写）。
 *
 * ⚠️ **几何/节奏/容量全部从 `IGNIS_SPIKE` 派生**（红线 1：同一事实只有一份权威）——
 * 玩法侧与渲染侧各写一份的形态是「伤害判定用的格与画出来的刺不在同一处」。
 * 本表只额外持有**纯观感**的一项：`color`（火焰色）；`shrinkFrom` 派生自
 * `SPIKE_SPARK_FX`（那边是「停止发射火星」的时刻，两者必须同一个数，
 * 权威放在 three-free 的 config 里是为了避免循环 import）。
 */
export const SPIKE_FX = Object.freeze({
  riseMs: IGNIS_SPIKE.riseMs,
  lifeMs: IGNIS_SPIKE.lifeMs,
  height: IGNIS_SPIKE.height,
  radius: IGNIS_SPIKE.radius,
  maxActive: IGNIS_SPIKE.maxActive,
  /** 寿命进度到此开始缩零（前 70% 保持满尺寸，含升起段）；火星同时停发 */
  shrinkFrom: SPARK.shrinkFrom,
  /**
   * 火焰橙红。比 `IGNIS_DEATH_COLOR`（1.0, 0.84, 0.25 偏黄）更红 ——
   * 读作「烧红的刺」而不是「一团火炸开」。additive 下它也是亮度上限。
   */
  color: Object.freeze([1.0, 0.45, 0.12]),
});

const _matrix = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
/** 粒子出生数据的临时载体（每帧零分配，不新建对象） */
const _spikeAt = { x: 0, y: 0, z: 0 };

/**
 * **五向半圆阵列**的落点（**不含 y** —— 渲染层不查体素，地面高度由调用方算，
 * 与 `flame-sigil.js` / `block-hit-fx.js` 同口径）。
 *
 * 用户 2026-11-21：「增加四个方向，分别是焰魔的左侧、右侧、左前侧、右前侧，
 * 各有六个尖刺冒出来，把焰魔围成一个半圆圈……先内圈，再逐渐外圈出现」。
 *
 * ## 三条载荷性口径
 *
 * ① **yaw 用本仓口径**：正前方 = `(−sin yaw, −cos yaw)`
 *    （与 `entities/bosses/dragon-boss-agent.js` 的移动方向同一份语义）。
 *    **不得照抄原版 `cos(yaw+90°)/sin(yaw+90°)`** —— 原版 yaw 定义不同，照抄会整排偏 90°，
 *    而根数/间距/延迟全部仍然正确（静默失效）。
 *
 * ② **左侧 = −90°**（`IGNIS_SPIKE.directionsDeg[3]`）—— 实测：`deg = −90` 的方向与
 *    模型 **+X**（`left_arm` / 盾所在侧）点积恒 **+1.00**。本仓 yaw 顺时针增长，
 *    `+90` 在数学直觉里是「左转」但实际落在模型**右手侧** ⇒ 写反会让整个阵列左右镜像，
 *    而根数/间距/延迟/半圆轮廓全部仍正确。
 *
 * ③ **延迟只跟半径序号 `i`**（不跟方向）⇒ 同一半径的 5 根**同帧**破土
 *    = 天然的「先内圈再外圈」，不需要新时序机制。
 *
 * ## 逐根朝向：宽面朝焰魔
 *
 * 剑体宽沿局部 X（0.4375）、厚沿局部 Z（0.0625）⇒ 宽面法线 = 局部 ±Z。
 * 实例 `rotation.y = θ` 后法线 = `(sin θ, cos θ)`；径向 outward = `(−sin ang, −cos ang)`
 * ⇒ 取 **θ = ang + π** 时法线与径向点积恒 **+1.000**（五个方向逐一实测）。
 * 不加 π 的形态是从焰魔/玩家方向看到 **0.0625 厚的窄边**而不是宽面
 *（投影面积差 **7.8 倍**），而 `DoubleSide` 让正视图几乎一样 ⇒ 静默失效。
 *
 * @param {number[]} at 焰魔身体位置 `[x,y,z]`（脚底）
 * @param {number} yaw 本仓 yaw（弧度）
 * @param {object} [cfg] 缺省 `IGNIS_SPIKE`
 * @returns {Array<{x:number, z:number, delayMs:number, yaw:number}>}
 *   长度 = `cfg.count × cfg.directionsDeg.length`（30）；顺序 = 方向外层、半径内层。
 *   `yaw` 是该根的**实例朝向**（弧度，已含 +π）。
 */
export function spikeSpawnPoints(at, yaw, cfg = IGNIS_SPIKE) {
  const points = [];
  for (const deg of cfg.directionsDeg) {
    const ang = yaw + deg * Math.PI / 180;
    const dx = -Math.sin(ang);
    const dz = -Math.cos(ang);
    for (let i = 0; i < cfg.count; i++) {
      const d = cfg.spacing * (i + 1) + (cfg.firstOffset - cfg.spacing);
      points.push({
        x: at[0] + dx * d,
        z: at[2] + dz * d,
        delayMs: i * cfg.delayPerSegmentMs,
        yaw: ang + Math.PI,
      });
    }
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
   * @param {{scene: THREE.Scene, maxActive?: number, rand?: () => number,
   *          texture?: THREE.Texture|null}} deps
   *   `texture` 是焰魔贴图（`ignis.png`）：**给了才挂剑纹**，缺省退回纯色锥（旧观感）。
   *   ⚠️ 缺贴图时**不得抛错**：贴图加载失败不该让尖刺整个不见（与法阵/龙的容错口径一致）。
   *   `rand` 可注入（单测要可复现，同 FireRingRenderer）。
   */
  constructor({ scene, maxActive = SPIKE_FX.maxActive, rand = Math.random, texture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    this._rand = rand;

    // 6 棱锥（像素风）；`translate` 把底面移到 y=0 ⇒ 实例 position 就是地面顶面
    const geometry = new THREE.ConeGeometry(SPIKE_FX.radius, SPIKE_FX.height, 6);
    geometry.translate(0, SPIKE_FX.height / 2, 0);
    /**
     * v3.24：锥面剑纹的**逐实例参数**（用户要「可以随机一些」）。
     *
     * ⚠️ 属性必须在这里就建好（即使当前走纯色回退）—— 否则材质一旦切到剑纹版，
     * shader 会因缺属性而静默读到全 0 ⇒ 每根纹理完全一样（Storm Lance v3.20 同类坑）。
     */
    const mkInst = (name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(maxActive), 1);
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    this._texTiles = mkInst(SPIKE_TEX_ATTR.tiles);
    this._texReps = mkInst(SPIKE_TEX_ATTR.reps);
    this._texPhase = mkInst(SPIKE_TEX_ATTR.phase);
    this._texMirror = mkInst(SPIKE_TEX_ATTR.mirror);
    for (let i = 0; i < maxActive; i++) {
      const pat = spikeTexPattern(rand, SPARK);
      this._texTiles.setX(i, pat.tiles);
      this._texReps.setX(i, pat.reps);
      this._texPhase.setX(i, pat.phase);
      this._texMirror.setX(i, pat.mirror);
    }
    for (const a of [this._texTiles, this._texReps, this._texPhase, this._texMirror]) {
      a.needsUpdate = true;
    }

    /**
     * 材质：有贴图走剑纹版，否则退回纯色版（旧观感）。
     * `textured` 标志供单测与 Tier 4 断言 —— 剑纹版没有 `map`，不要靠「有没有 map」去猜。
     */
    this.textured = texture !== null && texture !== undefined;
    const material = this.textured
      ? createSpikeConeMaterial({
        texture,
        uvRect: spikeTexUvRect(SPARK.textureRect, SPIKE_TEX_SIZE),
      })
      : createSpikePlainMaterial(SPIKE_FX.color);
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'ignis:spike-fx';
    /**
     * ⚠️⚠️ **必须排在海水之前**（v3.24 实测的回归，不是预防性改动）。
     *
     * 锥体 `depthWrite=false` + `renderOrder=0`，而海面 `ocean.js` 是 `renderOrder=1`
     * 且 `depthWrite=true` —— 水后画时按自己的 alpha 把锥体混掉。实测（只改海面
     * `renderOrder` 的单变量对照，水面区域内锥体的发光增量 p50）：
     * 默认（海面后画）**11.6** / 海面先画 **20.5** ⇒ 被冲淡 **1.77 倍**。
     * 与 `tracer-renderer.js`（曳光 2）、本文件粒子池（`SPARK.renderOrder = 3`）同口径：
     * 特效一律排在海面之后。`ocean.js:477` 已声明这组三重顺序是耦合约定。
     */
    this.mesh.renderOrder = SPARK.renderOrder;
    // 实例包围球按零 scale 算会被误剔除；特效须无条件提交（同 tracer / explosion 池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;            // ⚠️ 零活跃时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    // 逐实例色初始化（建出 instanceColor 属性）—— **逐根亮度**靠它，见 update 的 ⚠️
    this.mesh.setColorAt(0, _color.setRGB(...SPIKE_FX.color));
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);

    /** @type {Array<{slot:number, x:number, y:number, z:number, delayMs:number, bornAt:number, sparkEmitted:number, emberEmitted:number}>} */
    this._active = [];
    this._nextSlot = 0;
    this._geometry = geometry;
    this._material = material;

    // ---- v3.23：破土火星 / 上浮余烬两个共享 GPU 池 ----
    // ☠️ 两组 uniform **各自独立**（闭包捕获）：共享一份会让两个池互相覆写 uTime。
    const sparkMade = createSpikeSparkMaterial();
    const emberMade = createSpikeEmberMaterial();
    this._sparkMaterial = sparkMade.spark;
    this._sparkUniforms = sparkMade.uniforms;
    this._emberMaterial = emberMade.ember;
    this._emberUniforms = emberMade.uniforms;
    this._sparkGeo = createSpikeSparkGeometry(SPARK.capacity);
    this._emberGeo = createSpikeSparkGeometry(SPARK.capacity);
    this._sparkSlot = 0;
    this._emberSlot = 0;
    /** 粒子最后一次发射时刻（绝对秒）—— 空闲超时后隐藏，让在飞的自然衰亡 */
    this._sparkLastEmit = -1;
    this.sparkMesh = new THREE.Mesh(this._sparkGeo, this._sparkMaterial);
    this.sparkMesh.name = 'ignis:spike-spark';
    this.emberMesh = new THREE.Mesh(this._emberGeo, this._emberMaterial);
    this.emberMesh.name = 'ignis:spike-ember';
    for (const m of [this.sparkMesh, this.emberMesh]) {
      m.frustumCulled = false;
      m.renderOrder = SPARK.renderOrder;
      m.visible = false;
      this.scene.add(m);
    }
    /** 供水面倒影的 hidden 列表展开（与 stormLance / cinderFall / fireRing 同口径） */
    this.meshes = [this.mesh, this.sparkMesh, this.emberMesh];
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
        // v3.23：逐根的累计发射量（配额差值的基准）—— 不得共享一个全局计数器，
        // 否则 5 根只有第一根会喷火星（其余四根的配额被它吃掉）。
        sparkEmitted: 0,
        emberEmitted: 0,
      });
      // 延迟期内先摆成零 scale（不可见），update 到点后再摆出来
      this.mesh.setMatrixAt(slot, _zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  /**
   * 写一批粒子（CPU 只写出生数据，运动全在 GPU）。零分配：用模块级 `_spikeAt`。
   *
   * ⚠️ `aSpawn` 写**绝对秒**（nowMs/1000）—— 与 shader 的 `uTime` 同一个时钟。
   * 写毫秒会让 `age = uTime − aSpawn` 恒负 ⇒ 粒子全灭而计数/可见性全绿（v3.20 实测）。
   *
   * @param {object} s 活跃根 @param {'spark'|'ember'} kind
   * @param {number} progress 该根升起进度 0..1 @param {number} count
   * @param {number} tSec 绝对秒
   */
  _emitSparks(s, kind, progress, count, tSec) {
    if (count <= 0) return;
    const ember = kind === 'ember';
    const g = ember ? this._emberGeo : this._sparkGeo;
    _spikeAt.x = s.x; _spikeAt.y = s.y; _spikeAt.z = s.z;
    const seeds = spikeSparkSeeds(_spikeAt, progress, kind, count, this._rand, SPARK);
    const key = ember ? '_emberSlot' : '_sparkSlot';
    for (const p of seeds) {
      const i = this[key];
      this[key] = (i + 1) % SPARK.capacity;
      g.getAttribute('aOrigin').setXYZ(i, p.pos[0], p.pos[1], p.pos[2]);
      g.getAttribute('aVel').setXYZ(i, p.vel[0], p.vel[1], p.vel[2]);
      g.getAttribute('aSpawn').setX(i, tSec);
      g.getAttribute('aLife').setX(i, p.life);
      g.getAttribute('aSize').setX(i, p.size);
      g.getAttribute('aSeed').setX(i, this._rand() * 100);
    }
    for (const name of ['aOrigin', 'aVel', 'aSpawn', 'aLife', 'aSize', 'aSeed']) {
      g.getAttribute(name).needsUpdate = true;
    }
    this._sparkLastEmit = tSec;
    (ember ? this.emberMesh : this.sparkMesh).visible = true;
  }

  /**
   * 每帧推进：延迟到点的根升起、保持、缩回、寿命结束的回收；逐根按配额差值喷火星。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    const tSec = nowMs / 1000;
    this._sparkUniforms.uTime.value = tSec;
    this._emberUniforms.uTime.value = tSec;
    if (this._active.length === 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      this._decayParticles(tSec);
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

      /**
       * v3.23：按**累计配额差值**喷火星 / 余烬。
       *
       * ☠️ `lived = age − delay`（自**破土**起）而不是 `age` —— 用 age 会让延迟期
       * 内的根提前喷火星（刺还在地里就先冒火）。
       * ☠️ 配额函数在 `lived ≥ lifeMs × shrinkFrom` 后**不再增长** ⇒ 缩回段自然停发，
       * 不需要另写一道「是否在缩回」的门（两处各写一份就是第二个权威）。
       * ☠️ 进度传 `env.scale`：升起段它 0→1（出生高度跟着锥面上爬），
       * 保持段恒 1，缩回段下降但那时已停发 ⇒ 不会出现「火星跟着刺往下钻」。
       */
      const lived = nowMs - s.bornAt - s.delayMs;
      const wantSpark = spikeSparkQuotaAt(lived, 'spark', SPARK);
      if (wantSpark > s.sparkEmitted) {
        this._emitSparks(s, 'spark', env.scale, wantSpark - s.sparkEmitted, tSec);
        s.sparkEmitted = wantSpark;
      }
      const wantEmber = spikeSparkQuotaAt(lived, 'ember', SPARK);
      if (wantEmber > s.emberEmitted) {
        this._emitSparks(s, 'ember', env.scale, wantEmber - s.emberEmitted, tSec);
        s.emberEmitted = wantEmber;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // 全部仍在递延期或已全部结束 ⇒ 不提交渲染（draw call 回到基线）
    this.mesh.visible = anyVisible;
    this._decayParticles(tSec);
  }

  /**
   * 粒子层空闲回收：最后一次发射后过 `particleIdleSeconds` 才隐藏。
   *
   * ⚠️ **不得在尖锥回收那一帧硬切**：那时仍有火星/余烬在飞（余烬寿命 0.95s
   * 远长于尖锥剩下的寿命）⇒ 硬切会让它们凭空消失（同 Cinder / 火圈口径）。
   */
  _decayParticles(tSec) {
    if (this._sparkLastEmit >= 0 && tSec - this._sparkLastEmit > SPARK.particleIdleSeconds) {
      this.sparkMesh.visible = false;
      this.emberMesh.visible = false;
      this._sparkLastEmit = -1;
    }
  }

  /** 清空全部活跃特效（Tier 4 fixture 用来隔离对照组，同 FireRingRenderer.reset） */
  reset() {
    for (const s of this._active) this.mesh.setMatrixAt(s.slot, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this._active.length = 0;
    this.mesh.visible = false;
    this.sparkMesh.visible = false;
    this.emberMesh.visible = false;
    this._sparkLastEmit = -1;
    this._sparkSlot = 0;
    this._emberSlot = 0;
    for (const g of [this._sparkGeo, this._emberGeo]) {
      const spawn = g.getAttribute('aSpawn');
      const life = g.getAttribute('aLife');
      for (let i = 0; i < SPARK.capacity; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }
      spawn.needsUpdate = true;
      life.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    this.mesh.dispose();        // 释放 instanceMatrix / instanceColor 缓冲
    this._geometry.dispose();
    this._material.dispose();   // InstancedMesh.dispose 不释放材质
    this._sparkGeo.dispose();
    this._emberGeo.dispose();
    this._sparkMaterial.dispose();
    this._emberMaterial.dispose();
    this._active.length = 0;
    this.meshes.length = 0;
    this._sparkLastEmit = -1;
  }
}