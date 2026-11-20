// src/render/cinder-fall-renderer.js — Cinder Fall 的岩石与落点特效（v3.21）
//
// 四个 mesh：
//   ROCK  —— 程序化岩石 InstancedMesh（TSL：起伏 + 熔岩缝，越接近落点越亮）
//   HALO  —— **火球式径向渐变贴图 billboard**（零 shader，用户 v3.20c 裁定的手法）
//   BURST —— 落点爆壳（单槽）
//   SHOCK —— 冲击环（单槽）
//
// ## 为什么岩石是池、落点是单槽（推导，不是拍的）
//
// 岩石是**实体**，理论上可同时多发在飞 ⇒ InstancedMesh 池（`catalog.poolSize`，
// 对理论峰值留 4 倍余量）。落点特效的最长视觉 2.611s < 最小施法间隔 3.0s
// ⇒ 两次爆炸不可能重叠 ⇒ 单槽成立（`test-cinder-fall.js` 用关系式钉住）。
//
// ## 三条池化硬约束（与 fireball / tracer / explosion 同口径）
//   · 空闲时全部 mesh `visible=false` —— 否则恒增 draw call，且常驻透明 mesh 会进
//     透明排序列表干扰水面绘制顺序不变式（`water-order.spec` 守）；
//   · 每帧零分配：临时向量/矩阵都是模块级常量；
//   · 时间基准 `performance.now()`，禁 `Date.now()`（相差约 17 亿毫秒 → 首帧即消失）。
//
// ## slot 差集驱动（照 ProjectileRenderer / FireballRenderer）
//
// 岩石没有玩法服务（直接经 `entities.spawn/despawn`），故用「当前实体集合 vs 活动 slot」
// 的差集 —— 三条回收路径（命中 despawn / despawnColumn / dispose）自动覆盖，不需逐条记账。
//
// **主线程专用**：构造 Mesh/InstancedMesh 必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import { CINDER_FX as FX } from './cinder-fall-config.js';
import { createCinderMaterials } from './cinder-fall-material.js';
import {
  createFlameRibbonGeometry, createCinderParticleGeometry,
} from './cinder-fall-geometry.js';
import { cinderArcPoint } from '../player/weapons/cinder-fall.js';
import { CINDER_TYPE } from '../entities/cinder/cinder-system.js';

const _mat = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _spinAxis = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _toCam = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _emitAt = new THREE.Vector3();
const _back = new THREE.Vector3();
const _head = new THREE.Vector3();
const _tail = new THREE.Vector3();
const _prevHead = new THREE.Vector3();
// 冲击环定向用的两个固定轴（模块级复用，不在 burst 里新建 Vector3）
const _zAxis = new THREE.Vector3(0, 0, 1);
const _xAxis = new THREE.Vector3(1, 0, 0);

/**
 * 分数速率累加器（照 Storm Lance 的 `RateAcc` / 上游 `RateEmitter`）。
 * 直接 `Math.round(rate*dt)` 在低速率下会因取整而永不发射或恒发射。
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

const sat = (x) => Math.max(0, Math.min(1, x));
/** outQuint —— **冲击力的来源**（前 20% 冲掉 2/3）；outCubic 读作慢胀 */
const outQuint = (t) => 1 - Math.pow(1 - sat(t), 5);
const inCubic = (t) => Math.pow(sat(t), 3);

/**
 * 火焰光晕贴图 —— **照祭坛飞龙火球的手法**（`fireball-renderer.js:57`）。
 *
 * canvas 径向渐变，**最后一停 alpha=0** ⇒ 边缘天然柔和，不需要任何噪声/衰减指数去调。
 * 配色取暖橙（火球是炽橙，这里更红一点以区分「岩石在烧」）：
 * 白热中心 → 炽橙 → 暗橙红 → 透明。
 *
 * ⚠️ **主线程专用**（canvas 2D）—— 本文件归属 `render/`，不在同构目录。
 *
 * @param {number} [size=64] 贴图边长（光晕是低频渐变，大尺寸无收益）
 * @returns {THREE.CanvasTexture}
 */
export function makeCinderHaloTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255, 243, 208, 1.0)');    // 白热中心（colorHot）
  g.addColorStop(0.3, 'rgba(255, 176, 46, 0.85)');    // 炽橙（colorFlameMid）
  g.addColorStop(0.65, 'rgba(255, 61, 16, 0.32)');    // 暗橙红（colorFlameEdge）
  g.addColorStop(1.0, 'rgba(120, 20, 0, 0.0)');       // 透明边缘
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class CinderFallRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, haloTexture?: THREE.Texture|null}} deps
   *        `haloTexture` 可注入（单测传假纹理免 canvas，照 FireballRenderer 同手法）。
   */
  constructor({ scene, maxActive = FX.poolSize, haloTexture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    const mats = createCinderMaterials();
    this.uniforms = mats.uniforms;
    this._mats = mats;
    this._geos = [];

    // ---- ① 岩石（InstancedMesh + 逐实例种子）----
    const rockGeo = new THREE.IcosahedronGeometry(1, FX.rockDetail);
    // 非 instanced 几何也要能带逐实例属性：转成 InstancedBufferGeometry
    const rockInstGeo = new THREE.InstancedBufferGeometry();
    rockInstGeo.index = rockGeo.index;
    rockInstGeo.attributes.position = rockGeo.attributes.position;
    rockInstGeo.attributes.normal = rockGeo.attributes.normal;
    rockInstGeo.attributes.uv = rockGeo.attributes.uv;
    const seeds = new Float32Array(maxActive);
    for (let i = 0; i < maxActive; i++) seeds[i] = (i * 37.13) % 10;
    rockInstGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    rockInstGeo.instanceCount = maxActive;
    rockGeo.dispose();
    this._geos.push(rockInstGeo);
    this.rockMesh = new THREE.InstancedMesh(rockInstGeo, mats.rock, maxActive);
    this.rockMesh.name = 'cinder:rock';

    // ---- ② 火焰光晕（billboard，零 shader）----
    this._haloTexture = haloTexture || makeCinderHaloTexture();
    this._ownsHaloTexture = haloTexture === null;
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    this._geos.push(haloGeo);
    this._haloMaterial = new THREE.MeshBasicMaterial({
      map: this._haloTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.haloMesh = new THREE.InstancedMesh(haloGeo, this._haloMaterial, maxActive);
    this.haloMesh.name = 'cinder:halo';

    // ---- ③④ 落点爆壳与冲击环（单槽）----
    const burstGeo = new THREE.IcosahedronGeometry(1, 3);
    const shockGeo = new THREE.PlaneGeometry(2, 2);
    this._geos.push(burstGeo, shockGeo);
    this.burstMesh = new THREE.Mesh(burstGeo, mats.burst);
    this.burstMesh.name = 'cinder:burst';
    this.shockMesh = new THREE.Mesh(shockGeo, mats.shock);
    this.shockMesh.name = 'cinder:shock';

    /**
     * ⑤ 火焰尾巴（相机朝向 ribbon，单槽）。
     * ⚠️ 单槽与爆壳同理：冷却 3.0s > 飞行 1.11s + 烧回 1.2s（关系式单测钉）。
     * 多发同时在飞时尾巴只跟**最新那一发**（最早那发仍有自己的光晕）。
     */
    const flameGeo = createFlameRibbonGeometry(FX.trailNodes);
    this._geos.push(flameGeo);
    this.flameMesh = new THREE.Mesh(flameGeo, mats.flame);
    this.flameMesh.name = 'cinder:flame';

    // ---- ⑥⑦⑧ GPU 粒子池：火星（条状）/ 余烬（圆点）/ 烟（遮挡）----
    const sparkGeo = createCinderParticleGeometry(FX.sparkCapacity);
    const emberGeo = createCinderParticleGeometry(FX.sparkCapacity);
    const smokeGeo = createCinderParticleGeometry(FX.smokeCapacity);
    this._geos.push(sparkGeo, emberGeo, smokeGeo);
    this._sparkGeo = sparkGeo;
    this._emberGeo = emberGeo;
    this._smokeGeo = smokeGeo;
    this._sparkSlot = 0;
    this._emberSlot = 0;
    this._smokeSlot = 0;
    /**
     * ⚠️⚠️ **粒子用 `THREE.Mesh` + InstancedBufferGeometry，不能用 `InstancedMesh`**
     * （照 `storm-lance-renderer.js:131` 的 `mk()`，已验证的做法）。
     *
     * `InstancedMesh` 会在 shader 里额外乘上它自己的 `instanceMatrix`（此处恒为单位阵，
     * 因为位置全由 `aOrigin` 给）—— 而 `modelViewMatrix` 已被它接管，
     * 导致粒子全部塌到原点附近。实测形态：落点变成**一条白色竖糊**而不是爆炸，
     * 而 `visible` / 存活计数 / draw call / 零 console 错误 **全绿**。
     */
    this.sparkMesh = new THREE.Mesh(sparkGeo, mats.spark);
    this.sparkMesh.name = 'cinder:spark';
    this.emberMesh = new THREE.Mesh(emberGeo, mats.ember);
    this.emberMesh.name = 'cinder:ember';
    this.smokeMesh = new THREE.Mesh(smokeGeo, mats.smoke);
    this.smokeMesh.name = 'cinder:smoke';
    // 粒子自己管 boundingSphere（1e4），但 InstancedMesh 另算一份 ⇒ 关掉剔除
    this._sparkAcc = new RateAcc();
    this._emberAcc = new RateAcc();
    this._smokeAcc = new RateAcc();
    /** 粒子最后一次发射时刻（空闲两个寿命后隐藏 mesh，让在飞的自然衰亡） */
    this._particleLastEmit = -1;
    /** 尾巴烧回：岩石消失时刻（-1 = 还在飞） */
    this._trailGoneAt = -1;
    this._trailLaunch = null;
    this._trailProg = 0;
    this._lastTrailT = -1;

    /** 八个 mesh（供水面倒影的 hidden 列表展开） */
    this.meshes = [
      this.rockMesh, this.haloMesh, this.flameMesh,
      this.sparkMesh, this.emberMesh, this.smokeMesh,
      this.burstMesh, this.shockMesh,
    ];
    for (const m of this.meshes) {
      m.frustumCulled = false;
      m.renderOrder = FX.renderOrder;
      m.visible = false;
      scene.add(m);
    }
    for (const m of [this.rockMesh, this.haloMesh]) {
      for (let i = 0; i < maxActive; i++) m.setMatrixAt(i, _zero);
      m.instanceMatrix.needsUpdate = true;
    }

    /** @type {Map<string, number>} entityId → slot（差集驱动） */
    this._slots = new Map();
    /**
     * 场上岩石数（由装配层每帧写入，`entities.count(CINDER_TYPE)` 零分配）。
     * ⚠️ 它是 `sync` 的**常态早退门**：没有它就得每帧遍历全量实体 + 新建 Set。
     */
    this._rockCount = 0;
    /** 装配层是否告知过数量（未告知 ⇒ 不启用早退门，见 sync） */
    this._countKnown = false;
    this._nextSlot = 0;
    this._burstAt = -1;
    this._shockAt = -1;
    this._lastCamPos = new THREE.Vector3();
    this._hasCamPos = false;
  }

  get active() {
    return this._slots.size > 0 || this._burstAt >= 0 || this._shockAt >= 0
      || this.flameMesh.visible || this.sparkMesh.visible
      || this.emberMesh.visible || this.smokeMesh.visible;
  }

  /** 只读 slot 数（测试钩子：验证三条回收路径都归还了 slot） */
  slotCount() { return this._slots.size; }

  /**
   * 装配层每帧告知场上岩石数（`entities.count()`，零分配）—— `sync` 的常态早退门。
   * ⚠️ 不传时 `_rockCount` 恒 0，但 `_slots.size > 0` 仍会让 sync 正常跑（回收路径不丢）。
   * @param {number} n
   */
  setRockCount(n) {
    this._rockCount = Number.isFinite(n) ? n : 0;
    this._countKnown = true;
  }

  /**
   * 与当前岩石集合对齐：新实体分配 slot、已有实体更新矩阵、消失实体归还 slot。
   *
   * @param {Iterable<{id:string, type:string, state:object}>} entities
   * @param {THREE.Quaternion|null} [cameraQuat] 光晕 billboard 用（装配层每帧传）
   * @param {number} [nowMs] `performance.now()` 基准
   * @param {THREE.Vector3|null} [cameraPos] 命中实体时冲击环朝向用
   */
  sync(entities, cameraQuat = null, nowMs = 0, cameraPos = null) {
    const tSec = Number.isFinite(nowMs) ? nowMs / 1000 : 0;
    if (cameraPos) {
      this._lastCamPos.copy(cameraPos);
      this._hasCamPos = true;
    }
    /**
     * ⚠️⚠️ **常态零分配门控**（AGENTS.md：`_updateFireballs` 无门控时把
     * fastRemeshP95 从 1.1 抬到 4.5）。下面要新建 `live` Set 并遍历全量实体，
     * 而绝大多数帧场上根本没有岩石 ⇒ 那两笔成本是白付的。
     *
     * ⚠️ **门控只在装配层明确告知过数量时生效**（`_countKnown`）：
     * 否则（单测/其它调用方直接 sync）早退会**静默吃掉全部工作**，
     * 形态是「传了岩石却什么都没画」—— 比多遍历一次坏得多。
     */
    if (this._countKnown && this._rockCount === 0 && this._slots.size === 0) {
      if (this.rockMesh.visible) { this.rockMesh.visible = false; this.haloMesh.visible = false; }
      /**
       * ⚠️ **早退也必须启动尾巴烧回**：`void` 回收路径（掉出世界底/超时）**不走 burst()**，
       * 若只靠 burst 置 `_trailGoneAt`，那条路径下尾巴会**永远停在满亮度**（泄漏）。
       */
      if (this.flameMesh.visible && this._trailGoneAt < 0) this._trailGoneAt = tSec;
      return;
    }
    const live = new Set();
    let maxHeat = 0;
    let headFound = false;
    for (const entity of entities) {
      if (entity.type !== CINDER_TYPE) continue;
      const p = entity.state?.position;
      if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) continue;
      live.add(entity.id);
      let slot = this._slots.get(entity.id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;
        this._slots.set(entity.id, slot);
      }
      _pos.set(p[0], p[1], p[2]);
      // 受热程度：飞行进度^chargeCurve（越接近落点越亮）
      const dist = entity.state.launch?.distance ?? 0;
      const prog = dist > 0 ? sat((entity.state.traveled ?? 0) / dist) : 1;
      const heat = Math.pow(prog, Math.max(0.05, FX.chargeCurve));
      if (heat > maxHeat) maxHeat = heat;

      // 岩石：自旋（绕一条由 slot 派生的固定轴，读作翻滚而不是原地打转）
      _spinAxis.set(Math.sin(slot * 2.1), 1, Math.cos(slot * 1.7)).normalize();
      _quat.setFromAxisAngle(_spinAxis, tSec * FX.spin + slot);
      _scale.setScalar(FX.radius);
      _mat.compose(_pos, _quat, _scale);
      this.rockMesh.setMatrixAt(slot, _mat);

      // 光晕：billboard + 呼吸（相位按 slot 错开，多岩石不同步闪）
      const pulse = 1 + FX.haloPulseAmp
        * Math.sin(2 * Math.PI * FX.haloPulseHz * tSec + slot * 1.7);
      const haloSize = FX.radius * FX.haloScale * pulse * (0.75 + heat * 0.45);
      _scale.setScalar(haloSize);
      _mat.compose(_pos, cameraQuat || _quat.identity(), _scale);
      this.haloMesh.setMatrixAt(slot, _mat);

      /**
       * 火焰尾巴：中心线**从弹道推导**而不是记录历史（上游 `_updateTrail` 同口径）。
       * ⇒ 尾巴天然贴着抛物线弯，而不是一条直线。
       * 取「最新那一发」作头（多发时只有一条尾巴，单槽前提见构造器）。
       */
      const lc = entity.state.launch;
      if (lc && Array.isArray(lc.origin) && Array.isArray(lc.target)) {
        const d = lc.distance > 0 ? lc.distance : 1;
        const prog = sat((entity.state.traveled ?? 0) / d);
        _head.set(p[0], p[1], p[2]);
        // 尾端：沿弹道往回 trailSpan 格（不越过手点）
        const spanT = Math.min(prog, FX.trailSpan / d);
        const tailP = cinderArcPoint(lc, Math.max(0, prog - spanT));
        _tail.set(tailP[0], tailP[1], tailP[2]);
        this._trailLaunch = lc;
        this._trailProg = prog;
        headFound = true;
        this._trailGoneAt = -1;
        this.uniforms.uTail.value.copy(_tail);
        this.uniforms.uHead.value.copy(_head);
        this.uniforms.uTrailFade.value = 1;
        this.uniforms.uTrailBurn.value = 0;
        // 尾巴方向（向后）—— 粒子沿它喷
        _back.subVectors(_tail, _head);
        if (_back.lengthSq() < 1e-8) _back.set(0, 0, 1);
        _back.normalize();
      }
    }
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      this.rockMesh.setMatrixAt(slot, _zero);
      this.haloMesh.setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    this.rockMesh.instanceMatrix.needsUpdate = true;
    this.haloMesh.instanceMatrix.needsUpdate = true;
    const any = this._slots.size > 0;
    this.rockMesh.visible = any;
    this.haloMesh.visible = any;
    this.uniforms.uHeat.value = maxHeat;
    // 岩石没了 ⇒ 尾巴开始烧回头（不硬切，上游 trailBurnout）
    if (!headFound && this.flameMesh.visible && this._trailGoneAt < 0) {
      this._trailGoneAt = tSec;
    }
    if (headFound) this.flameMesh.visible = true;
    // 沿弧撒粒子（仅在真的在飞时）
    if (headFound) this._emitTrailParticles(tSec);
  }

  /**
   * 沿本帧走过的弧段撒火星 / 余烬 / 烟。
   *
   * ⚠️⚠️ **必须分多批沿弧撒**（上游 `TRAIL_BATCHES = 3`）：岩石 18 格/秒，
   * 一帧跑 0.3 格 ⇒ 全部从头部发射会让尾巴读作**一串 beads**（上游注释明确点出）。
   *
   * ⚠️ 零分配：用模块级 `_emitAt` / `_vel`，不新建 Vector3。
   * @param {number} tSec 绝对秒
   */
  _emitTrailParticles(tSec) {
    const dt = this._lastTrailT >= 0 ? Math.min(0.1, Math.max(0, tSec - this._lastTrailT)) : 0;
    this._lastTrailT = tSec;
    if (dt <= 0) return;
    const lc = this._trailLaunch;
    if (!lc) return;
    const d = lc.distance > 0 ? lc.distance : 1;
    const prog = sat(this._trailProg ?? 0);
    const spanT = Math.min(prog, FX.trailSpan / d);
    const lo = Math.max(0, prog - spanT);

    const nSpark = this._sparkAcc.tick(dt, FX.sparkRate);
    if (nSpark > 0) {
      const batches = Math.min(nSpark, FX.trailBatches);
      const per = Math.ceil(nSpark / batches);
      let left = nSpark;
      while (left > 0) {
        const p = cinderArcPoint(lc, lo + (prog - lo) * Math.random());
        _emitAt.set(p[0], p[1], p[2]);
        const n = Math.min(per, left);
        this._emitCone(n, _emitAt, _back, FX.sparkSpeed, FX.sparkLifetime,
          FX.sparkSize, tSec, 'spark', 0.95);
        left -= n;
      }
    }
    const nEmber = this._emberAcc.tick(dt, FX.emberRate);
    if (nEmber > 0) {
      const batches = Math.min(nEmber, FX.trailBatches);
      const per = Math.ceil(nEmber / batches);
      let left = nEmber;
      while (left > 0) {
        const p = cinderArcPoint(lc, lo + (prog - lo) * Math.random());
        _emitAt.set(p[0], p[1], p[2]);
        const n = Math.min(per, left);
        this._emitCone(n, _emitAt, _back, FX.emberSpeed, FX.emberLifetime,
          FX.emberSize, tSec, 'ember', 0.85);
        left -= n;
      }
    }
    const nSmoke = this._smokeAcc.tick(dt, FX.smokeRate);
    if (nSmoke > 0) {
      const p = cinderArcPoint(lc, lo + (prog - lo) * Math.random());
      _emitAt.set(p[0], p[1], p[2]);
      this._emitCone(nSmoke, _emitAt, _back, FX.smokeSpeed, FX.smokeLifetime,
        FX.smokeSize, tSec, 'smoke', 0.75);
    }
  }

  /**
   * 写一个粒子 slot。CPU 只写出生数据，运动全在 GPU。
   * `aSpawn` 与 `uTime` **同一个时钟**（绝对秒）。
   */
  _push(kind, pos, vel, life, size, tSec) {
    const g = kind === 'spark' ? this._sparkGeo : kind === 'ember' ? this._emberGeo : this._smokeGeo;
    const cap = kind === 'smoke' ? FX.smokeCapacity : FX.sparkCapacity;
    const key = kind === 'spark' ? '_sparkSlot' : kind === 'ember' ? '_emberSlot' : '_smokeSlot';
    const i = this[key];
    this[key] = (i + 1) % cap;
    g.getAttribute('aOrigin').setXYZ(i, pos.x, pos.y, pos.z);
    g.getAttribute('aVel').setXYZ(i, vel.x, vel.y, vel.z);
    g.getAttribute('aSpawn').setX(i, tSec);
    g.getAttribute('aLife').setX(i, life);
    g.getAttribute('aSize').setX(i, size);
    g.getAttribute('aSeed').setX(i, Math.random() * 100);
    for (const name of ['aOrigin', 'aVel', 'aSpawn', 'aLife', 'aSize', 'aSeed']) {
      g.getAttribute(name).needsUpdate = true;
    }
    this._particleLastEmit = tSec;
  }

  /** 一簇粒子（给定中心与主方向，锥形散布）。零分配：用模块级 _vel。 */
  _emitCone(count, center, dir, speed, life, size, tSec, kind, spread) {
    for (let i = 0; i < count; i++) {
      _vel.set(
        dir.x + (Math.random() - 0.5) * spread,
        dir.y + (Math.random() - 0.5) * spread + 0.25,
        dir.z + (Math.random() - 0.5) * spread,
      ).normalize().multiplyScalar(speed * (0.6 + Math.random() * 0.8));
      this._push(kind, center, _vel, life * (0.7 + Math.random() * 0.6),
        size * (0.6 + Math.random() * 0.8), tSec);
    }
    const mesh = kind === 'spark' ? this.sparkMesh : kind === 'ember' ? this.emberMesh : this.smokeMesh;
    mesh.visible = true;
  }

  /**
   * 落点爆炸：爆壳 + 冲击环。
   *
   * ⚠️ **冲击环朝向按 impactKind 分流**（与 Storm Lance 的 R2 同口径）：
   * 命中实体 ⇒ 环面法线朝玩家（读作「炸在它身上」）；否则贴地。
   * 共用一套会让打 Boss 时环画在脚下地面上。
   *
   * @param {number[]} at 世界坐标的**表面接触点**
   * @param {number} nowMs @param {'block'|'entity'|'air'} kind
   * @param {number[]} [cameraPos] 命中实体时的朝向参考（缺省用最近一次 sync 传入的）
   * @param {number[]} [normal] 命中面法线（block）—— 环要贴在**那个面**上，
   *        而不是恒贴地（撞墙时恒贴地会把环画进墙里）。
   */
  burst(at, nowMs, kind = 'block', cameraPos = null, normal = null) {
    if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isFinite)) return;
    if (!Number.isFinite(nowMs)) return;
    if (cameraPos && cameraPos.every(Number.isFinite)) {
      this._lastCamPos.set(cameraPos[0], cameraPos[1], cameraPos[2]);
      this._hasCamPos = true;
    }
    this._burstAt = nowMs;
    this._shockAt = nowMs;
    this.burstMesh.position.set(at[0], at[1], at[2]);
    this.burstMesh.scale.setScalar(FX.burstSize * 0.2);
    this.burstMesh.visible = true;
    this.shockMesh.position.set(at[0], at[1], at[2]);
    this.shockMesh.scale.setScalar(FX.shockRadius);
    if (kind === 'entity' && this._hasCamPos) {
      // 环面法线（几何是 XY 平面 ⇒ 法线 +Z）指向相机
      _toCam.subVectors(this._lastCamPos, this.shockMesh.position);
      if (_toCam.lengthSq() > 1e-8) {
        _toCam.normalize();
        this.shockMesh.quaternion.setFromUnitVectors(_zAxis, _toCam);
      }
    } else if (Array.isArray(normal) && normal.length === 3
      && normal.some((v) => v !== 0)) {
      // 贴**命中面**：地面 [0,1,0] / 墙面 [±1,0,0]、[0,0,±1] / 天花板 [0,-1,0]
      _toCam.set(normal[0], normal[1], normal[2]).normalize();
      this.shockMesh.quaternion.setFromUnitVectors(_zAxis, _toCam);
    } else {
      // 无法线信息（旧调用方/空气）⇒ 沿用贴地
      this.shockMesh.quaternion.setFromAxisAngle(_xAxis, -Math.PI / 2);
    }
    /**
     * ⚠️⚠️ **环必须沿法线抬离表面一点点**（实测：不抬时它渲染 **0 像素**）。
     *
     * v3.21 把落点改成了**真实表面接触点**，而环是贴在那个面上的平面：
     * 与地面**共面** ⇒ `depthTest:true` 下被地面完全遮住（z-fight 全输）。
     * 形态：`shockMesh.visible=true` / age / fade 全对而**画面上什么都没有**。
     * 上游同类贴花均带高度偏移（`DecalType.SCORCH` 的 `height: 0.015`）。
     * 取 0.03 格（远小于一个体素，读不出浮空）。
     */
    _toCam.set(0, 0, 1).applyQuaternion(this.shockMesh.quaternion);
    this.shockMesh.position.addScaledVector(_toCam, FX.shockLift);
    this.shockMesh.visible = true;
    this.uniforms.uBurstAge.value = 0;
    this.uniforms.uBurstFade.value = 1;
    this.uniforms.uShockAge.value = 0;
    this.uniforms.uShockFade.value = 1;

    /**
     * ⚠️⚠️ **落点大喷发**（用户 2026-11-19：「爆炸的时候蹦出的火星粒子很多，
     * 是爆炸的样子，而不是现在一样像烟花」）。
     *
     * 上游 `MeteorAbility.onImpact` 一次喷：embers 260 / sparks 180 / smoke 70，
     * 速度分别是飞行期的 2.6 / 2.4 / 2.6 倍，主方向**向上**（setY(0.6) / (0,1,0)）。
     * 旧实现零火星 ⇒ 只有一圈光环扩开 = 烟花。
     *
     * ⚠️ 三类分工不能合并：火星是**条状高速**（爆炸的锐利感），
     * 余烬是**圆点上浮**（燃烧感），烟是**遮挡**（层次感）。
     */
    const tSec = nowMs / 1000;
    _emitAt.set(at[0], at[1] + FX.burstSize * 0.12, at[2]);
    _back.set(0, 0.6, 0).normalize();
    this._emitCone(FX.burstSparks, _emitAt, _back,
      FX.sparkSpeed * FX.sparkBurstSpeedMul, FX.sparkLifetime * 1.6,
      FX.sparkSize * 1.5, tSec, 'spark', 2.0);
    this._emitCone(FX.burstEmbers, _emitAt, _back,
      FX.emberSpeed * FX.emberBurstSpeedMul, FX.emberLifetime * 1.5,
      FX.emberSize * 1.4, tSec, 'ember', 2.0);
    _emitAt.set(at[0], at[1] + 0.2, at[2]);
    _back.set(0, 1, 0);
    this._emitCone(FX.burstSmoke, _emitAt, _back,
      FX.smokeSpeed * 2.6, FX.smokeLifetime * 1.6,
      FX.smokeSize * 1.5, tSec, 'smoke', 1.0);
    // 岩石已炸 ⇒ 尾巴从头部烧回去
    if (this._trailGoneAt < 0) this._trailGoneAt = tSec;
  }

  /**
   * 每帧推进爆壳与冲击环的包络。
   * ⚠️ 两者**各写独立 fade/age**，不共用（否则寿命短的那个被拖着满亮，末尾硬 pop）。
   * @param {number} nowMs @param {number} _dt 秒（本渲染器按绝对时刻算，不需 dt）
   */
  update(nowMs, _dt = 0) {
    if (!Number.isFinite(nowMs)) return;
    const u = this.uniforms;
    const tSec = nowMs / 1000;
    u.uTime.value = tSec;

    /**
     * 尾巴烧回（上游 `trailBurnout`）：岩石没了之后尾巴**从头部往尾端吃掉**
     * 并变细变冷，而不是直接 invisible（硬切会让尾巴凭空消失）。
     */
    if (this.flameMesh.visible) {
      if (this._trailGoneAt >= 0) {
        const burn = sat((tSec - this._trailGoneAt) / Math.max(0.05, FX.trailBurnout));
        u.uTrailBurn.value = burn;
        u.uTrailFade.value = 1 - burn * burn;
        if (burn >= 1) {
          this.flameMesh.visible = false;
          u.uTrailFade.value = 0;
          this._trailGoneAt = -1;
          this._trailLaunch = null;
          this._lastTrailT = -1;
          this._sparkAcc.reset();
          this._emberAcc.reset();
          this._smokeAcc.reset();
        }
      } else {
        u.uTrailBurn.value = 0;
        u.uTrailFade.value = 1;
      }
    }

    /**
     * 粒子池：最后一次发射后过两个最长寿命才隐藏 —— 让已在飞的**自然衰亡**。
     * 硬切会让尾巴上的火星凭空消失（与 Storm Lance 同口径）。
     */
    if (this._particleLastEmit >= 0
      && tSec - this._particleLastEmit > FX.particleIdleSeconds) {
      this.sparkMesh.visible = false;
      this.emberMesh.visible = false;
      this.smokeMesh.visible = false;
      this._particleLastEmit = -1;
    }
    if (this._burstAt >= 0) {
      const k = (nowMs - this._burstAt) / (FX.burstLifeSeconds * 1000);
      if (k >= 1) {
        this.burstMesh.visible = false;
        this._burstAt = -1;
        u.uBurstFade.value = 0;
      } else {
        const s = FX.burstSize * (0.2 + 0.8 * outQuint(k));
        this.burstMesh.scale.set(s, s * FX.burstSquash, s);
        u.uBurstAge.value = sat(k);
        u.uBurstFade.value = 1 - inCubic(k);
      }
    }
    if (this._shockAt >= 0) {
      const k = (nowMs - this._shockAt) / (FX.shockLifeSeconds * 1000);
      if (k >= 1) {
        this.shockMesh.visible = false;
        this._shockAt = -1;
        u.uShockFade.value = 0;
      } else {
        u.uShockAge.value = sat(k);
        u.uShockFade.value = 1 - inCubic(k);
      }
    }
  }

  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    for (const g of this._geos) g.dispose();
    for (const key of ['rock', 'flame', 'spark', 'ember', 'smoke', 'burst', 'shock']) {
      this._mats[key].dispose();
    }
    this._haloMaterial.dispose();
    if (this._ownsHaloTexture) this._haloTexture.dispose();
    this.rockMesh.dispose();
    this.haloMesh.dispose();
    this.meshes.length = 0;
    this._slots.clear();
    this._burstAt = -1;
    this._shockAt = -1;
    this._trailGoneAt = -1;
    this._particleLastEmit = -1;
  }
}