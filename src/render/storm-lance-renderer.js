// src/render/storm-lance-renderer.js — Storm Lance 的单槽渲染器（v3.20）
//
// 上游 `abilities/ThunderAbility.js` 的三拍节奏：
//   travel（strike 前沿推进）→ hold（保持并重击）→ fade（熄灭）
// 蓄力光球是本仓叠加的第四件事（用户要长按蓄力），走在 travel 之前。
//
// ## 为什么单槽就够（推导，不是拍的）
//
// 释放后总视觉时长 = travel(`range/speed`) + hold + fade = 24/105 + 0.45 + 0.5 = **1.179s**
// 两次施法最少间隔 = `chargeDelaySeconds + chargeSeconds` = **2.0s**
// ⇒ **两道闪电在时间上不可能重叠**。故不需要池、不需要「覆盖最旧」逻辑。
// `test-storm-lance.js` 用关系式钉住这个前提；抬 range/holdSeconds 必须同步改冷却或改多槽。
//
// ## 三条池化硬约束（与 flame-sigil / spike-fx / tracer 同口径）
//
//   · 空闲时全部 mesh `visible=false` —— 否则恒增 draw call，
//     且常驻透明 mesh 会进透明排序列表干扰水面绘制顺序不变式（`water-order.spec` 守）。
//   · 每帧零分配：临时向量/矩阵都是模块级常量。
//   · 时间基准 `performance.now()`，禁 `Date.now()`（相差约 17 亿毫秒 → 首帧即消失）。
//
// ## 时间基准：**全局单一时钟**
//
// `uTime` 恒为 `nowMs / 1000`（绝对秒），**不得在施放时切成相对秒**。
// 火花的 `aSpawn` 写同一个时钟 ⇒ `age = uTime - aSpawn` 恒正确。
// 混用两个时基的形态：蓄力期写入的吸入粒子在**释放瞬间全部消失**，
// 而相位/可见性/draw call 判据全绿（Nova Beam 版实测踩到）。
// 爆壳/冲击环各自的 age 走 `uBurstAge`/`uShockAge`，不覆写 uTime。
//
// ## R2：命中实体时冲击环**朝向玩家**，不是贴地
//
// 用户：「就在击中碰撞身体的位置爆炸」。落点由 `stormLanceSweep` 截到实体表面，
// 环若仍贴地就会画在 Boss 脚下的地面上 ⇒ 读作「炸在地上」而不是「炸在它身上」。
//
// **主线程专用**：构造 Mesh/InstancedMesh 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import { STORM_LANCE_FX as FX, stormBurstScale } from './storm-lance-config.js';
import {
  createBoltRibbonGeometry, createSparkGeometry, createBurstGeometry, createShockGeometry,
} from './storm-lance-geometry.js';
import { createStormLanceMaterials } from './storm-lance-material.js';
// v3.21：第二段蓄力球的暖橙光晕——**直接用 Cinder 的那张**（同一个手法与色阶，
// 不在这里另写一份渐变）。它归属 render/，与本模块同层。
import { makeCinderHaloTexture } from './cinder-fall-renderer.js';

const _v = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

const sat = (x) => Math.max(0, Math.min(1, x));
const outCubic = (t) => 1 - Math.pow(1 - t, 3);
const inCubic = (t) => t * t * t;

/**
 * 分数速率累加器：`tick(dt, rate)` 返回本帧该发几个。
 * 保证帧率无关（上游 `RateEmitter` 同语义）—— 直接 `Math.round(rate*dt)` 在低速率下
 * 会因取整而永不发射或恒发射。
 */
class RateAcc {
  constructor() { this.acc = 0; }
  reset() { this.acc = 0; }
  tick(dt, rate) {
    this.acc += rate * dt;
    const n = Math.floor(this.acc);
    this.acc -= n;
    return n;
  }
}

/**
 * 蓄力球光晕贴图 —— **照祭坛飞龙火球的手法**（`fireball-renderer.js:57`）。
 *
 * 用户 2026-11-19：「你看看祭坛飞龙吐的火球的外围一圈光晕是怎么加的，就那样加就行，
 * 很简单，不要搞得太复杂」。火球用的就是**canvas 径向渐变 + MeshBasicMaterial + billboard**，
 * 零 shader。渐变最后一停 alpha=0 ⇒ 边缘天然柔和，不需要任何噪声/衰减指数去调。
 *
 * 配色取 Storm Lance 的冷蓝白（火球是暖橙）：白热中心 → 淡蓝 → 蓝 → 透明。
 *
 * ⚠️ **主线程专用**（canvas 2D）—— 本文件归属 `render/`，不在同构目录。
 *
 * @param {number} [size=64] 贴图边长（64 足够：光晕是低频渐变，大尺寸无收益）
 * @returns {THREE.CanvasTexture}
 */
export function makeStormHaloTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');    // 白热中心
  g.addColorStop(0.3, 'rgba(201, 236, 255, 0.85)');   // 淡蓝（colorInner）
  g.addColorStop(0.65, 'rgba(58, 160, 255, 0.32)');   // 蓝外圈（colorOuter）
  g.addColorStop(1.0, 'rgba(11, 63, 200, 0.0)');      // 透明边缘（colorHalo）
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class StormLanceRenderer {
  /**
   * @param {{scene: THREE.Scene, haloTexture?: THREE.Texture|null,
   *          warmHaloTexture?: THREE.Texture|null}} deps
   *        `haloTexture` 可注入（单测传假纹理免 canvas，照 FireballRenderer 同手法）；
   *        缺省内部生成。
   *        v3.21 `warmHaloTexture` = 第二段（Cinder Fall）的暖橙光晕，同样可注入。
   *        ⚠️ **光晕是贴图不是 shader** ⇒ 换色必须切 `material.map`，
   *        只改 `uWarm` uniform 拓不到它（形态：球变暖了而光晕还是蓝的）。
   */
  constructor({ scene, haloTexture = null, warmHaloTexture = null }) {
    this.scene = scene;
    const mats = createStormLanceMaterials();
    this.uniforms = mats.uniforms;
    this._mats = mats;

    const ribbon = createBoltRibbonGeometry(FX.boltNodes, FX.maxStrands);
    ribbon.instanceCount = FX.strands;
    const spark = createSparkGeometry(FX.sparkCapacity);
    const orb = new THREE.IcosahedronGeometry(1, 3);

    const burst = createBurstGeometry();
    const shock = createShockGeometry();

    const mk = (name, geo, mat) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `storm:${name}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = FX.renderOrder;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    };
    // GLOW 先画、CORE 叠上去（上游 renderOrder 11 / 13 的相对次序）
    this.glowMesh = mk('glow', ribbon, mats.glow);
    this.coreMesh = mk('core', ribbon, mats.core);
    this.sparkMesh = mk('spark', spark, mats.spark);
    // v3.20c：光晕照**祭坛飞龙火球**的手法 —— 径向渐变贴图 + MeshBasicMaterial
    // + billboard，零 shader（用户「就那样加就行，很简单，不要搞得太复杂」）。
    // ⚠️ 尺寸给 1×1，实际大小由 setCharge 按 orbSize×orbHaloScale 缩放（与核心同源）。
    this._haloTexture = haloTexture || makeStormHaloTexture();
    this._ownsHaloTexture = haloTexture === null;
    /**
     * v3.21：第二段（Cinder Fall）的暖橙光晕。**惰初始化**。
     *
     * ⚠️⚠️ **不得在构造器里直接 `makeCinderHaloTexture()`**（实测踩到）：
     * 它要 canvas，而本渲染器在 **Node 轻档单测**里也会被构造（只查对象图）。
     *  eager 构造会让 6 个既有用例全部 `ReferenceError: document is not defined`。
     * 惰初始化后：注入假纹理的测试永不碰 canvas，真实浏览器里第一次进第二段才生成。
     */
    this._warmHaloTexture = warmHaloTexture;
    this._ownsWarmHaloTexture = warmHaloTexture === null;
    const halo = new THREE.PlaneGeometry(1, 1);
    const haloMaterial = new THREE.MeshBasicMaterial({
      map: this._haloTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    });
    this._haloMaterial = haloMaterial;
    this.haloMesh = new THREE.Mesh(halo, haloMaterial);
    this.haloMesh.name = 'storm:halo';
    this.haloMesh.frustumCulled = false;
    this.haloMesh.renderOrder = FX.renderOrder;
    this.haloMesh.visible = false;
    scene.add(this.haloMesh);
    this.orbMesh = mk('orb', orb, mats.orb);
    this.burstMesh = mk('burst', burst, mats.burst);
    this.shockMesh = mk('shock', shock, mats.shock);

    /** 六个 mesh（供水面倒影的 hidden 列表展开） */
    this.meshes = [
      this.glowMesh, this.coreMesh, this.sparkMesh,
      this.haloMesh, this.orbMesh, this.burstMesh, this.shockMesh,
    ];
    /** 束身两个 pass（travel/hold/fade 期可见） */
    this._bolt = [this.glowMesh, this.coreMesh];

    this._geos = [ribbon, spark, orb, halo, burst, shock];
    this._sparkGeo = spark;
    this._sparkSlot = 0;

    /** @type {'idle'|'travel'|'hold'|'fade'} */
    this._phase = 'idle';
    this._bornAt = 0;
    this._phaseAt = 0;
    this._front = 0;
    this._length = 1;
    this._charge = 0;
    this._orbFade = 1;
    this._hand = new THREE.Vector3();
    this._side = new THREE.Vector3(1, 0, 0);
    this._impact = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    /** 冲击环朝向：命中实体时 = 逆着束方向（朝玩家）；否则贴地 */
    this._impactKind = 'air';
    this._sparkIdleSince = -1;

    this._sparkAcc = new RateAcc();
    this._intakeAcc = new RateAcc();
    this._burstAt = -1;
    this._shockAt = -1;
    this._burstSize = 1;
    this._burstFrom = 0;
    this._shockRadius = 1;
  }

  get active() { return this._phase !== 'idle' || this._charge > 0; }
  get phase() { return this._phase; }

  /**
   * 蓄力期每帧调用。`progress=0` 时熄灭光球（**静默期由 controller 保证传 0**）。
   * @param {number} progress 0..1
   * @param {number[]} origin 手点世界坐标
   * @param {number[]} side 束的横向基
   * @param {number} nowMs `performance.now()` 基准
   * @param {THREE.Quaternion|null} [cameraQuat] 相机朝向 —— 光晕 billboard 用
   *        （照 `fireballRenderer.sync(entities, camera.quaternion, nowMs)` 的分工：
   *        渲染器不持有相机，由装配层每帧传入）。缺省 null ⇒ 面向 +Z。
   * @param {number} [warm=0] v3.21：0 = Storm Lance 冷蓝白，1 = Cinder Fall 暖橙白。
   *        **只换色不换形**（用户 R4：「蓄力的动作是完全一样的」）。
   *        缺省 0 ⇒ 既有五参调用逐位回到 v3.20 行为。
   *        ⚠️ **尺寸进度由装配层传 `max(p1,p2)`**：第二段起步时 p2 恰好是 0，
   *        直接拿它当进度会让球**闪断一下**（静默观感缺陷，数值判据拓不到）。
   */
  setCharge(progress, origin, side, nowMs, cameraQuat = null, warm = 0) {
    const p = Number.isFinite(progress) ? sat(progress) : 0;
    const w = Number.isFinite(warm) ? sat(warm) : 0;
    this._charge = p;
    this.uniforms.uWarm.value = w;
    // 光晕是贴图：换色靠切 map（uniform 只管核心球）。
    // 暖色贴图**惰生成**（只在真的进第二段时碰 canvas，见构造器注释）。
    if (w > 0.5 && !this._warmHaloTexture) this._warmHaloTexture = makeCinderHaloTexture();
    const wantMap = w > 0.5 ? this._warmHaloTexture : this._haloTexture;
    if (wantMap && this.haloMesh.material.map !== wantMap) {
      this.haloMesh.material.map = wantMap;
      this.haloMesh.material.needsUpdate = true;
    }
    if (!Number.isFinite(nowMs)) return;
    if (p <= 0) {
      this.orbMesh.visible = false;
      this.haloMesh.visible = false;
      this.uniforms.uCharge.value = 0;
      this._intakeAcc.reset();
      return;
    }
    if (!this._finite3(origin)) return;
    this._hand.set(origin[0], origin[1], origin[2]);
    if (this._finite3(side)) this._side.set(side[0], side[1], side[2]);
    this.uniforms.uCharge.value = p;
    const swell = 1 + FX.orbThrob * Math.sin((nowMs / 1000) * FX.orbThrobSpeed * Math.PI * 2);
    const size = FX.orbSize * (0.28 + 0.72 * outCubic(p)) * swell;
    this.orbMesh.position.copy(this._hand);
    this.orbMesh.scale.setScalar(Math.max(0.01, size));
    this.orbMesh.visible = true;
    // v3.20b：光晕跟随核心，但大一圈（orbHaloScale）。
    // 它的呼吸相位与核心**错开**（×0.7 频率）—— 同相呼吸会让两层读作一个硬物体。
    const haloSwell = 1 + FX.orbThrob * 1.6
      * Math.sin((nowMs / 1000) * FX.orbThrobSpeed * 0.7 * Math.PI * 2);
    this.haloMesh.position.copy(this._hand);
    this.haloMesh.scale.setScalar(Math.max(0.01, size * FX.orbHaloScale * haloSwell));
    // billboard：把相机朝向写进光晕（火球同手法）⇒ 永远正对镜头，不会看成一张斜卡片
    if (cameraQuat) {
      this.haloMesh.quaternion.copy(cameraQuat);
      this._lastCamQuat = this._lastCamQuat || new THREE.Quaternion();
      this._lastCamQuat.copy(cameraQuat);
    }
    this.haloMesh.visible = true;
    this.uniforms.uTime.value = nowMs / 1000;
  }

  /**
   * 施放。**冻结** origin/target/side/length（与曳光同口径：镜头移动时整条束纹丝不动）。
   * @param {{origin:number[], target:number[], side:number[], length:number,
   *          seed:number, impactKind?:string}} p
   * @param {number} nowMs
   */
  fire(p, nowMs) {
    if (!Number.isFinite(nowMs)) return;
    if (!this._finite3(p?.origin) || !this._finite3(p?.target) || !this._finite3(p?.side)) return;
    if (!Number.isFinite(p.length) || !(p.length > 0)) return;

    this._origin.set(p.origin[0], p.origin[1], p.origin[2]);
    this._impact.set(p.target[0], p.target[1], p.target[2]);
    this._side.set(p.side[0], p.side[1], p.side[2]);
    this._length = p.length;
    this._impactKind = p.impactKind ?? 'air';
    this._bornAt = nowMs;
    this._phaseAt = nowMs;
    this._front = 0;
    this._phase = 'travel';
    this._orbFade = 1;
    this._burstAt = -1;
    this._shockAt = -1;
    this._sparkAcc.reset();

    const u = this.uniforms;
    u.uOrigin.value.copy(this._origin);
    u.uTarget.value.copy(this._impact);
    u.uSide.value.copy(this._side);
    u.uSeed.value = Number.isFinite(p.seed) ? p.seed : 0;
    u.uStrands.value = FX.strands;
    u.uProgress.value = 0;
    u.uFade.value = 1;
    u.uBurstFade.value = 0;
    u.uShockFade.value = 0;

    for (const m of this._bolt) m.visible = true;
    this.sparkMesh.visible = true;
    // 枪口：小爆壳 + 一撮火花（上游 `_muzzleFx`）
    this._spawnBurst(this._origin, nowMs, FX.muzzleSize, FX.muzzleLifeSeconds);
    this._emitSparks(40, this._origin, this._dirOf(), FX.sparkSpeed * 1.5, nowMs, 0.85);
  }

  /**
   * 每帧推进相位与粒子。
   * @param {number} nowMs @param {number} dt 秒
   */
  update(nowMs, dt) {
    if (!Number.isFinite(nowMs)) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const u = this.uniforms;

    if (this._phase === 'idle') {
      u.uTime.value = nowMs / 1000;
      if (this._charge > 0) {
        this._emitIntake(step, nowMs);
        this.sparkMesh.visible = true;
        this._sparkIdleSince = -1;
      } else if (this.sparkMesh.visible) {
        // 蓄力被打断或施放刚结束：让已在飞的火花**自然衰亡**（两个最长寿命），
        // 而不是硬切 —— 硬切会让尾巴上的火花凭空消失。
        if (this._sparkIdleSince < 0) this._sparkIdleSince = nowMs;
        if (nowMs - this._sparkIdleSince > FX.sparkLifetime * 1000 * 2) {
          this.sparkMesh.visible = false;
          this._sparkIdleSince = -1;
        }
      }
      this._updateBurstShock(nowMs);
      return;
    }

    const age = (nowMs - this._bornAt) / 1000;
    // ⚠️ uTime 恒为绝对秒（与火花 aSpawn 同一时钟）
    u.uTime.value = nowMs / 1000;
    u.uAge.value = age;
    this._orbFade = Math.max(0, 1 - age / FX.orbFadeSeconds);
    u.uCharge.value = this._orbFade;
    if (this._orbFade > 0) {
      this.orbMesh.visible = true;
      this.orbMesh.position.copy(this._origin);
      const s = Math.max(0.01, FX.orbSize * this._orbFade);
      this.orbMesh.scale.setScalar(s);
      // 光晕同步淡出，但**扩张**（光散开而不是缩成一团）
      this.haloMesh.visible = true;
      this.haloMesh.position.copy(this._origin);
      this.haloMesh.scale.setScalar(
        Math.max(0.01, FX.orbSize * FX.orbHaloScale * (1 + (1 - this._orbFade) * 0.8)));
      if (this._lastCamQuat) this.haloMesh.quaternion.copy(this._lastCamQuat);
    } else {
      this.orbMesh.visible = false;
      this.haloMesh.visible = false;
    }

    if (this._phase === 'travel') {
      this._front += FX.speed * step;
      const prog = sat(this._front / this._length);
      u.uProgress.value = prog;
      this._emitBoltSparks(step, nowMs, prog);
      if (prog >= 1) {
        this._phase = 'hold';
        this._phaseAt = nowMs;
        this._onImpact(nowMs);
      }
      this._updateBurstShock(nowMs);
      return;
    }

    const lived = (nowMs - this._phaseAt) / 1000;
    if (this._phase === 'hold') {
      u.uProgress.value = 1;
      // 保持期仍在撒火花，但节流（上游 `fade * 0.6`）
      this._emitBoltSparks(step * 0.6, nowMs, 1);
      if (lived >= FX.holdSeconds) { this._phase = 'fade'; this._phaseAt = nowMs; }
      this._updateBurstShock(nowMs);
      return;
    }

    // fade：上游只有亮度 inCubic（没有 Nova Beam 的宽度收缩 —— 闪电是「挂住然后消失」）
    const k = sat(lived / FX.fadeSeconds);
    u.uFade.value = 1 - inCubic(k);
    this._emitBoltSparks(step * (1 - k) * 0.35, nowMs, 1);
    this._updateBurstShock(nowMs);
    if (k >= 1) this._finish();
  }

  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    for (const g of this._geos) g.dispose();
    for (const key of ['glow', 'core', 'spark', 'orb', 'burst', 'shock']) {
      this._mats[key].dispose();
    }
    this._haloMaterial.dispose();
    if (this._ownsHaloTexture) this._haloTexture.dispose();
    if (this._ownsWarmHaloTexture && this._warmHaloTexture) this._warmHaloTexture.dispose();
    this.meshes.length = 0;
    this._bolt.length = 0;
    this._phase = 'idle';
  }

  // ---------- 内部 ----------

  _finite3(a) {
    return Array.isArray(a) && a.length === 3
      && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
  }

  /**
   * 落点（上游 `onImpact`）：STORM 爆壳 + 冲击环 + 一撮回溅。
   * ⚠️ 爆壳从 `burstSize*0.2` 猛扩到 `burstSize`（outQuint），不是从 0.18 慢胀。
   */
  _onImpact(nowMs) {
    this._spawnBurst(this._impact, nowMs, FX.burstSize, FX.burstLifeSeconds);
    this._spawnShock(nowMs, FX.shockRadius);
    const back = this._dirOf().multiplyScalar(0.5).setY(0.7).normalize();
    this._emitSparks(FX.burstSparks, this._impact, back, FX.sparkSpeed * 2.2, nowMs, 1.0);
  }

  _finish() {
    this._phase = 'idle';
    this._charge = 0;
    // ⚠️ 火花不在这里硬切：fade 结束时仍有火花在飞（寿命 0.5s > fade 0.5s 的尾段）。
    // 交给 idle 分支的衰亡窗口自然收。其余 mesh 立即隐藏。
    for (const m of this.meshes) {
      if (m !== this.sparkMesh) m.visible = false;
    }
    this._sparkIdleSince = -1;
    const u = this.uniforms;
    u.uCharge.value = 0;
    u.uFade.value = 1;
    u.uBurstFade.value = 0;
    u.uShockFade.value = 0;
    this._burstAt = -1;
    this._shockAt = -1;
  }

  _dirOf() {
    return _dir.subVectors(this._impact, this._origin).normalize();
  }

  /** 束的局部正交基（与 shader 的 boltFrame 同口径） */
  _frame() {
    const dir = this._dirOf();
    _n1.copy(this._side).addScaledVector(dir, -this._side.dot(dir));
    if (_n1.lengthSq() < 1e-8) _n1.crossVectors(dir, _up);
    _n1.normalize();
    _n2.crossVectors(dir, _n1).normalize();
    return { dir, n1: _n1, n2: _n2 };
  }

  /**
   * 轴上一点（s∈[0,1]）—— 与 shader 的 `boltPoint` 的**轴部分**同口径（含 sag）。
   * ⚠️ 不含 kink：火花撒在束的包络内而不是精确贴在某条丝上（上游同分工）。
   */
  _axisPoint(s, out) {
    const t = sat(s);
    out.copy(this._origin).lerp(this._impact, t);
    out.y += FX.sag * Math.sin(t * Math.PI);
    return out;
  }

  /** 束半宽（与 shader 的 reach 同公式）—— 火花撒布半径 */
  _bundleRadius(s) {
    return FX.spreadNear + (FX.spread - FX.spreadNear)
      * Math.pow(sat(s), Math.max(0.01, FX.spreadCurve));
  }

  /**
   * 写一个火花 slot。CPU 只写出生数据，运动全在 GPU。
   * `aSpawn` 与 `uTime` **同一个时钟**（绝对秒，见文件头）。
   */
  _pushSpark(pos, vel, life, size, nowMs) {
    const g = this._sparkGeo;
    const i = this._sparkSlot;
    this._sparkSlot = (this._sparkSlot + 1) % FX.sparkCapacity;
    g.getAttribute('aOrigin').setXYZ(i, pos.x, pos.y, pos.z);
    g.getAttribute('aVel').setXYZ(i, vel.x, vel.y, vel.z);
    g.getAttribute('aSpawn').setX(i, nowMs / 1000);
    g.getAttribute('aLife').setX(i, life);
    g.getAttribute('aSize').setX(i, size);
    g.getAttribute('aSeed').setX(i, Math.random() * 100);
    for (const name of ['aOrigin', 'aVel', 'aSpawn', 'aLife', 'aSize', 'aSeed']) {
      g.getAttribute(name).needsUpdate = true;
    }
  }

  /** 一撮火花（给定中心与主方向，锥形散布）。零分配：用模块级 _vel。 */
  _emitSparks(count, center, dir, speed, nowMs, spread) {
    for (let i = 0; i < count; i++) {
      _vel.set(
        dir.x + (Math.random() - 0.5) * spread,
        dir.y + (Math.random() - 0.5) * spread,
        dir.z + (Math.random() - 0.5) * spread,
      ).normalize().multiplyScalar(speed * (0.6 + Math.random() * 0.8));
      this._pushSpark(center, _vel, FX.sparkLifetime * (0.7 + Math.random() * 0.6),
        FX.sparkSize * (0.6 + Math.random() * 0.8), nowMs);
    }
  }

  /** 蓄力吸入：手点周围球壳上生成，速度指向手点，壳随进度收紧 */
  _emitIntake(dt, nowMs) {
    const n = this._intakeAcc.tick(dt, FX.intakeRate * (0.35 + this._charge));
    if (n <= 0) return;
    const shell = FX.intakeRadius * (1 - 0.55 * this._charge);
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = Math.sin(phi);
      _v.set(s * Math.cos(theta), Math.cos(phi) * 0.7, s * Math.sin(theta)).normalize();
      _pos.copy(this._hand).addScaledVector(_v, shell * (0.7 + Math.random() * 0.45));
      _vel.copy(_v).multiplyScalar(-FX.intakeSpeed);
      this._pushSpark(_pos, _vel, (shell / FX.intakeSpeed) * 1.5, FX.sparkSize * 0.6, nowMs);
    }
  }

  /**
   * 束身撒火花：沿束**分批**撒（上游 SPARK_BATCHES=6）。
   * ⚠️ 单点发射会让每批读作「定点星爆」（上游注释明确点出这个失败形态）。
   */
  _emitBoltSparks(dt, nowMs, reach) {
    let n = this._sparkAcc.tick(dt, FX.sparkRate);
    if (n <= 0) return;
    const { dir } = this._frame();
    const batches = Math.min(n, FX.sparkBatches);
    const per = Math.ceil(n / batches);
    // 主方向：沿束前方拖 + 向上（上游 direction*0.45 setY(0.55)）
    _v.copy(dir).multiplyScalar(FX.sparkForward).setY(0.55).normalize();
    while (n > 0) {
      const s = (0.05 + Math.random() * 0.95) * Math.max(reach, 0.02);
      this._axisPoint(s, _pos);
      const count = Math.min(per, n);
      this._emitSparks(count, _pos, _v, FX.sparkSpeed, nowMs, 1.0);
      n -= count;
    }
  }

  /**
   * 生成爆壳。`from` = 起始半径比例（上游 `radius = burstSize*0.2`）。
   * @param {THREE.Vector3} center @param {number} nowMs
   * @param {number} size 终止半径 @param {number} lifeSeconds
   */
  _spawnBurst(center, nowMs, size, lifeSeconds) {
    this._burstAt = nowMs;
    this._burstSize = size;
    this._burstLife = lifeSeconds;
    this._burstFrom = size * 0.2;
    this.burstMesh.position.copy(center);
    this.burstMesh.visible = true;
    this.uniforms.uBurstAge.value = 0;
    this.uniforms.uBurstFade.value = 1;
  }

  /**
   * 生成冲击环。**朝向按 impactKind 分流**（R2）。
   * 命中实体 ⇒ 环面法线 = 逆束方向（朝玩家）；否则贴地（法线 +Y）。
   */
  _spawnShock(nowMs, radius) {
    this._shockAt = nowMs;
    this._shockRadius = radius;
    this.shockMesh.visible = true;
    this.uniforms.uShockAge.value = 0;
    this.uniforms.uShockFade.value = 1;
  }

  /**
   * 爆壳与冲击环的尺寸/亮度包络。
   *
   * ⚠️ **爆壳扩张走 `stormBurstScale`（outQuint）**：前 20% 时间冲掉 2/3 ⇒ 读作「炸开」。
   * outCubic 是「慢慢胀」（用户报的软绵绵）。
   * ⚠️ **各自写独立 fade/age uniform**，不共用 `uFade`（hold 期恒 1 ⇒ 只缩不淡、末尾硬 pop）。
   */
  _updateBurstShock(nowMs) {
    const u = this.uniforms;
    if (this._burstAt >= 0) {
      const life = (this._burstLife ?? FX.burstLifeSeconds) * 1000;
      const k = (nowMs - this._burstAt) / life;
      if (k >= 1) {
        this.burstMesh.visible = false;
        this._burstAt = -1;
        u.uBurstFade.value = 0;
        u.uBurstAge.value = 1;
      } else {
        const kk = sat(k);
        const s = this._burstFrom + (this._burstSize - this._burstFrom) * stormBurstScale(kk);
        // squash：竖向压扁（上游 scale.set(s, s*squash, s)）
        this.burstMesh.scale.set(s, s * FX.burstSquash, s);
        u.uBurstAge.value = kk;
        u.uBurstFade.value = 1;   // 亮度衰减由 shader 的 (1−age) 项做，避免双重衰减
      }
    }
    if (this._shockAt >= 0) {
      const k = (nowMs - this._shockAt) / (FX.shockLifeSeconds * 1000);
      if (k >= 1) {
        this.shockMesh.visible = false;
        this._shockAt = -1;
        u.uShockFade.value = 0;
        u.uShockAge.value = 1;
      } else {
        const kk = sat(k);
        const s = this._shockRadius;
        _scale.set(s, s, s);
        if (this._impactKind === 'entity') {
          // 环面法线朝玩家：PlaneGeometry 的法线是 +Z ⇒ 把 +Z 转到 −dir
          _v.copy(this._dirOf()).negate();
          _quat.setFromUnitVectors(_n2.set(0, 0, 1), _v);
          _pos.copy(this._impact).addScaledVector(_v, 0.02);
        } else {
          // 贴地：+Z 转到 +Y
          _quat.setFromUnitVectors(_n2.set(0, 0, 1), _up);
          _pos.copy(this._impact);
          _pos.y += 0.02;
        }
        _mat.compose(_pos, _quat, _scale);
        this.shockMesh.matrix.copy(_mat);
        this.shockMesh.matrixAutoUpdate = false;
        this.shockMesh.matrixWorldNeedsUpdate = true;
        u.uShockAge.value = kk;
        u.uShockFade.value = 1 - inCubic(kk);
      }
    }
  }
}