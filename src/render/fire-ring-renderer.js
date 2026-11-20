// src/render/fire-ring-renderer.js — 焰魔扩散火圈（v3.22）
//
// 取代碎石圆环（`blockHitFx.spawnSmashRing`，本轮已删除）：持盾冲撞 / 举盾砸击命中帧
// 以**焰魔脚底为圆心**散出一个逐渐向外燃烧的火圈。用户 2026-11-20 裁定：
// 「不需要外加声音，只实现视觉特效」⇒ 无伤害、无音效、不碰动画与 AI。
//
// 两个 mesh：
//   RING  —— 贴地火舌环（每环一个独立材质实例：uRadius/uFade/uSeed 逐环不同）
//   SPARK —— 环缘条状火星（**共享一个 GPU 池**，不按环分）
//
// ## 为什么环是「小池」而火星是「共享池」
//
// 环最多 `IGNIS.maxAlive`（2）个并发 ⇒ 2 个 Mesh 足够，每个自带 uniform 组
// （⚠️ 共享一组会让两只焰魔的环互相覆写半径，形态是「一个环忽然跳到另一个的尺寸」）。
// 火星是几百颗的量 ⇒ 一个 InstancedBufferGeometry 环形缓冲，CPU 只写出生数据。
//
// ## 三条池化硬约束（与 flame-sigil / spike-fx / cinder-fall 同口径）
//   · 空闲时全部 mesh `visible=false` —— 否则恒增 draw call，且常驻透明 mesh 会进
//     透明排序列表干扰水面绘制顺序不变式（`water-order.spec.mjs` 守）；
//   · 每帧零分配：临时向量都是模块级常量；
//   · 时间基准 `performance.now()`，禁 `Date.now()`（相差约 17 亿毫秒 → 首帧即消失）。
//
// ⚠️⚠️ **火星用 `THREE.Mesh` + InstancedBufferGeometry，不能用 `InstancedMesh`**：
// 后者的 instanceMatrix 会接管 modelViewMatrix，把由 aOrigin 定位的粒子全塌到原点
// （v3.21 实测：落点变成一条白色竖糊，而 visible / 计数 / draw call 全绿）。
//
// ⚠️ **`aSpawn` 与 `uTime` 必须同一个时钟（绝对秒）**：混用两个时基的形态是
// 「粒子在某个瞬间全部消失」而所有数值判据全绿（v3.20 实测）。
//
// **主线程专用**：构造 Mesh/材质必然依赖 three。归属 `render/`。
import * as THREE from 'three';
import {
  FIRE_RING as FX, fireRingRadiusAt, fireRingFadeAt, fireRingSparks,
} from './fire-ring-config.js';
import { createFireRingMaterial, createFireSparkMaterial } from './fire-ring-material.js';

const _vel = new THREE.Vector3();
const _pos = new THREE.Vector3();

const sat = (x) => Math.max(0, Math.min(1, x));

/**
 * 火星 quad + 六个逐实例出生属性（照 `storm-lance-geometry.js:createSparkGeometry`）。
 *
 * ⚠️ `boundingSphere` 取 1e4：几何自身在单位立方内，实际被 shader 摆到几十格外
 * ⇒ 正常包围球会让它被误剔除。渲染器另设 `frustumCulled=false` 双保险。
 *
 * @param {number} capacity 环形缓冲容量
 * @returns {THREE.InstancedBufferGeometry}
 */
export function createFireRingSparkGeometry(capacity) {
  const cap = Math.max(1, Math.round(capacity));
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const mk = (name, itemSize) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * itemSize), itemSize);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  };
  mk('aOrigin', 3);
  mk('aVel', 3);
  mk('aSpawn', 1);
  mk('aLife', 1);
  mk('aSize', 1);
  mk('aSeed', 1);

  // 初始全部「已死」：aSpawn 远在过去、aLife 极小 ⇒ age/life > 1 ⇒ shader 缩零
  const spawn = geometry.getAttribute('aSpawn');
  const life = geometry.getAttribute('aLife');
  for (let i = 0; i < cap; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }

  geometry.instanceCount = cap;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

export class FireRingRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, rand?: () => number}} deps
   *   **无贴图依赖**（程序化几何 + TSL）⇒ 恒装配，不像法阵那样可能退 null。
   *   `rand` 可注入（单测要可复现）。
   */
  constructor({ scene, maxActive = FX.maxActive, rand = Math.random }) {
    this.scene = scene;
    this.maxActive = Math.max(1, Math.round(maxActive));
    this._rand = rand;
    this._geos = [];
    this._mats = [];

    /** @type {Array<{mesh:THREE.Mesh, uniforms:object, bornAt:number, x:number, y:number, z:number, seed:number, emitted:number}>} */
    this._rings = [];
    for (let i = 0; i < this.maxActive; i++) {
      // ⚠️ **每个环独立一组 uniform + 独立材质**：共享会让两只焰魔的环
      // 互相覆写半径（形态：一个环忽然跳到另一个的尺寸）。
      // 材质侧的 uniform 是**闭包捕获**的（见 fire-ring-material 文件头）——
      // TSL 的 Fn 体惰性求值，模块级变量会被后一次调用覆写。
      const { ring: ringMat, uniforms } = createFireRingMaterial();
      const geo = new THREE.PlaneGeometry(2, 2);
      geo.rotateX(-Math.PI / 2);      // XY → XZ（贴地，法线 +Y）
      this._geos.push(geo);
      this._mats.push(ringMat);
      const mesh = new THREE.Mesh(geo, ringMat);
      mesh.name = `ignis:fire-ring-${i}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = FX.renderOrder;
      mesh.visible = false;
      // 几何基准 ±1 ⇒ scale(endRadius) 后局部坐标范围 ±endRadius（世界米数）
      mesh.scale.setScalar(FX.endRadius);
      scene.add(mesh);
      this._rings.push({
        mesh, uniforms, bornAt: -1,
        x: 0, y: 0, z: 0, seed: 0, emitted: 0,
      });
    }
    // 火星是**全局共享池**（不按环分）⇒ 只需一组 uniform（uTime / uGain）
    const { spark: sparkMat, uniforms: sparkUniforms } = createFireSparkMaterial();
    this._sparkMaterial = sparkMat;
    this._sparkUniforms = sparkUniforms;
    this._mats.push(this._sparkMaterial);

    const sparkGeo = createFireRingSparkGeometry(FX.sparkCapacity);
    this._geos.push(sparkGeo);
    this._sparkGeo = sparkGeo;
    this._sparkSlot = 0;
    this.sparkMesh = new THREE.Mesh(sparkGeo, this._sparkMaterial);
    this.sparkMesh.name = 'ignis:fire-ring-spark';
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = FX.renderOrder;
    this.sparkMesh.visible = false;
    scene.add(this.sparkMesh);

    /** 供水面倒影的 hidden 列表展开（与 stormLance / cinderFall 同口径） */
    this.meshes = [...this._rings.map((r) => r.mesh), this.sparkMesh];
    /** 火星最后一次发射时刻（空闲两个寿命后隐藏，让在飞的自然衰亡） */
    this._sparkLastEmit = -1;
    this._nextRing = 0;
  }

  /** 活跃环数（测试钩子） */
  get activeCount() {
    let n = 0;
    for (const r of this._rings) if (r.bornAt >= 0) n++;
    return n;
  }

  /** 是否有任何东西在画（测试钩子） */
  get active() { return this.activeCount > 0 || this.sparkMesh.visible; }

  /** 第 i 个环的当前半径（格，测试钩子；未活跃返回 0） */
  radiusOf(i) {
    const r = this._rings[i];
    if (!r || r.bornAt < 0) return 0;
    return r.uniforms.uRadius.value;
  }

  /**
   * 起一个火圈。池满时覆盖最旧的环（纯视觉，丢弃无副作用）。
   *
   * @param {{x:number, y:number, z:number}} at **圆心 = 焰魔脚底**，
   *   `y` 已由调用方算好（地面顶面）；渲染层不查体素（同 flame-sigil / spike-fx）。
   * @param {number} nowMs `performance.now()` 基准
   */
  spawn(at, nowMs) {
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) return;
    // ⚠️ nowMs 非法会让 age = NaN ⇒ 半径 NaN ⇒ 整个环不上屏（同法阵/碎块的 NaN 守卫）
    if (!Number.isFinite(nowMs)) return;
    // 取空闲槽；没有空闲就覆盖 bornAt 最小（最旧）的那个
    let slot = this._rings.find((r) => r.bornAt < 0);
    if (!slot) {
      slot = this._rings[0];
      for (const r of this._rings) if (r.bornAt < slot.bornAt) slot = r;
    }
    slot.bornAt = nowMs;
    slot.x = at.x; slot.y = at.y; slot.z = at.z;
    slot.seed = this._rand() * 100;
    slot.emitted = 0;
    slot.mesh.position.set(at.x, at.y + FX.yLift, at.z);
    slot.mesh.scale.setScalar(FX.endRadius);
    slot.mesh.visible = true;
    slot.uniforms.uRadius.value = FX.startRadius;
    slot.uniforms.uFade.value = 1;
    slot.uniforms.uSeed.value = slot.seed;
    slot.uniforms.uTime.value = nowMs / 1000;
    this._sparkUniforms.uTime.value = nowMs / 1000;
    // 起手先撒第 1 批（脚下起火那一瞬就有火星，而不是等环扩出去才冒）。
    // ⚠️ 走与 update 同一份「累计配额」公式，不在这里另写一份颗数（红线 1）：
    // 两处各写会让总量变成 sparkCount + 一批（池账判据与实际发射量脱节）。
    slot.emitted = 1;
    this._emit(slot, FX.startRadius, nowMs / 1000, this._batchQuota(1));
  }

  /**
   * 前 n 批的**累计**火星配额（颗）。**唯一权威**：spawn 与 update 都调它。
   *
   * 用「累计差值」而不是 `ceil(count/batches) × n`：后者在不能整除时会超发
   * （150/6 恰好整除，但改参数就会静默超池）。
   *
   * @param {number} n 已撒批次（1..sparkBatches）
   * @returns {number}
   */
  _batchQuota(n) {
    const b = Math.max(1, Math.floor(FX.sparkBatches));
    return Math.round(FX.sparkCount * Math.min(n, b) / b);
  }

  /**
   * 写一批火星（CPU 只写出生数据，运动全在 GPU）。零分配：用模块级临时向量。
   * @param {object} slot @param {number} radius @param {number} tSec 绝对秒
   * @param {number} count
   */
  _emit(slot, radius, tSec, count) {
    const seeds = fireRingSparks(
      { x: slot.x, y: slot.y + FX.yLift, z: slot.z, radius }, count, this._rand, FX,
    );
    const g = this._sparkGeo;
    for (const s of seeds) {
      const i = this._sparkSlot;
      this._sparkSlot = (i + 1) % FX.sparkCapacity;
      _pos.set(s.pos[0], s.pos[1], s.pos[2]);
      _vel.set(s.vel[0], s.vel[1], s.vel[2]);
      g.getAttribute('aOrigin').setXYZ(i, _pos.x, _pos.y, _pos.z);
      g.getAttribute('aVel').setXYZ(i, _vel.x, _vel.y, _vel.z);
      g.getAttribute('aSpawn').setX(i, tSec);
      g.getAttribute('aLife').setX(i, s.life);
      g.getAttribute('aSize').setX(i, s.size);
      g.getAttribute('aSeed').setX(i, this._rand() * 100);
    }
    for (const name of ['aOrigin', 'aVel', 'aSpawn', 'aLife', 'aSize', 'aSeed']) {
      g.getAttribute(name).needsUpdate = true;
    }
    this._sparkLastEmit = tSec;
    this.sparkMesh.visible = true;
  }

  /**
   * 每帧推进：半径外扩、末段淡出、沿环缘分批撒火星、寿命结束回收。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    const tSec = nowMs / 1000;
    this._sparkUniforms.uTime.value = tSec;
    for (const r of this._rings) {
      r.uniforms.uTime.value = tSec;
      if (r.bornAt < 0) continue;
      const k = (nowMs - r.bornAt) / FX.lifeMs;
      if (k >= 1) {
        r.mesh.visible = false;
        r.bornAt = -1;
        r.uniforms.uFade.value = 0;
        continue;
      }
      const radius = fireRingRadiusAt(k);
      r.uniforms.uRadius.value = radius;
      r.uniforms.uFade.value = fireRingFadeAt(k);
      /**
       * 火星按「半径推进量」分批撒：每推进 1/sparkBatches 段撒一批
       * ⇒ 观感是整圈一路冒火星，而不是起手一次性星爆（v3.20 实测教训）。
       */
      const want = Math.min(FX.sparkBatches, Math.floor(sat(k) * FX.sparkBatches) + 1);
      if (want > r.emitted) {
        const quota = this._batchQuota(want) - this._batchQuota(r.emitted);
        if (quota > 0) this._emit(r, radius, tSec, quota);
        r.emitted = want;
      }
    }
    // 火星：最后一次发射后过两个最长寿命才隐藏（让在飞的自然衰亡，不硬切）
    if (this._sparkLastEmit >= 0 && tSec - this._sparkLastEmit > FX.sparkLifetime * 2) {
      this.sparkMesh.visible = false;
      this._sparkLastEmit = -1;
    }
  }

  /** 清空全部活跃特效（Tier 4 fixture 用来隔离对照组） */
  reset() {
    for (const r of this._rings) {
      r.bornAt = -1;
      r.mesh.visible = false;
      r.uniforms.uFade.value = 0;
    }
    this.sparkMesh.visible = false;
    this._sparkLastEmit = -1;
    this._sparkSlot = 0;
    const spawn = this._sparkGeo.getAttribute('aSpawn');
    const life = this._sparkGeo.getAttribute('aLife');
    for (let i = 0; i < FX.sparkCapacity; i++) { spawn.setX(i, -1e3); life.setX(i, 1e-3); }
    spawn.needsUpdate = true;
    life.needsUpdate = true;
  }

  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    this.meshes.length = 0;
    this._rings.length = 0;
    this._sparkLastEmit = -1;
  }
}