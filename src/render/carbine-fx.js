// src/render/carbine-fx.js — KV-9 的五个特效池（曳光 / 火花 / 烟尘 / 弹壳 / 弹孔）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/fx/particles.js`。
// 本文件只负责**池管理与 CPU 模拟**；TSL 在 `carbine-fx-material.js`，
// 观感常量与纯函数在 `carbine-fx-config.js`（three-free，可单测）。
//
// ## 三条池化硬约束（与本仓其余特效池同口径，M6 实测教训）
//   · 空闲时 `visible=false` —— 否则恒增 draw call 且进透明排序列表，
//     干扰水面绘制顺序不变式（`water-order.spec`）；
//   · 每帧零分配：临时向量/矩阵都是模块级常量；
//   · 时间基准 `performance.now()`（装配层传 nowMs），**禁止 Date.now()**。
//
// ## 与上游的三处必要改写
//   ① **不接动态点光源**（上游 `lights.nearest` / `lights.flash`）：本仓全场景 unlit，
//      动态灯只影响 PBR 材质 ⇒ 会让枪体随命中闪烁而世界不变（观感是错的）。
//   ② **弹壳落地高度由装配层给**（`groundAt` 回调）：渲染层不查体素
//      （与 `flame-sigil` / `spike-fx` / `block-hit-fx` 同口径）。
//   ③ **弹孔不做 polygonOffset**（WebGPU 无此字段）：靠沿法线抬 0.012 格。
//
// ⚠️ **曳光/火花/烟尘/弹孔用 Mesh + InstancedBufferGeometry；弹壳用 InstancedMesh**
// —— 前者是 shader 定位的粒子（instanceMatrix 会把它们全塌到原点），
// 后者是 CPU 算矩阵的真实刚体。两者不可互换（本仓已记的教训）。
import * as THREE from 'three';
import {
  CARBINE_TRACER_FX as TR, CARBINE_SPARK_FX as SP,
  CARBINE_PUFF_FX as PU, CARBINE_CASING_FX as CA, CARBINE_HOLE_FX as HO,
  carbineSparkSeeds, carbineSparkParams, carbinePuffParams, carbineImpactKind,
  carbineImpactSound, carbineTracerLifetime,
} from './carbine-fx-config.js';
import {
  createCarbineTracerGeometry, createCarbineTracerMaterial,
  createCarbineSparkGeometry, createCarbineSparkMaterial,
  createCarbinePuffGeometry, createCarbinePuffMaterial,
  createCarbineHoleGeometry, createCarbineHoleMaterial,
  createCarbineCasingGeometry, createCarbineCasingMaterial,
} from './carbine-fx-material.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s1 = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class CarbineFx {
  /**
   * @param {{scene: THREE.Scene,
   *          groundAt?: (x:number,z:number,fromY:number)=>number|null,
   *          blockNameOf?: (id:number)=>string|null,
   *          onCasingBounce?: (pos:THREE.Vector3, bounce:number)=>void,
   *          enableHoles?: boolean,
   *          rand?: () => number}} deps
   *   `groundAt` 缺省 null ⇒ 弹壳不落地（一直下落直到寿命结束，仍可见）。
   *   `enableHoles` 缺省 **false**：用户 2026-11-22 裁定「单孔可以不要」。
   *   ⚠️ 弹孔池的几何/材质/代码**保留**（已实现且测过），但默认不 spawn；
   *   将来要开回来只改这一个开关，不用重建池。
   */
  constructor({ scene, groundAt = null, blockNameOf = null, onCasingBounce = null, enableHoles = false, rand = Math.random }) {
    this.scene = scene;
    this.groundAt = groundAt;
    this.blockNameOf = blockNameOf;
    this.onCasingBounce = onCasingBounce;
    this.enableHoles = !!enableHoles;
    this._rand = rand;

    // ---- ① 曳光 ----
    this.tracerGeo = createCarbineTracerGeometry();
    const tr = createCarbineTracerMaterial();
    this.tracerMat = tr.material;
    this.tracerUniforms = tr.uniforms;
    this.tracerMesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.renderOrder = TR.renderOrder;
    this.tracerMesh.visible = false;
    scene.add(this.tracerMesh);
    this._tracerCursor = 0;
    this._tracerUntil = 0;      // 最晚一条的到期绝对秒（visible 门控）

    // ---- ② 火花（CPU 模拟：要落地反弹）----
    this.sparkGeo = createCarbineSparkGeometry();
    this.sparkMat = createCarbineSparkMaterial().material;
    this.sparkMesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = SP.renderOrder;
    this.sparkMesh.visible = false;
    scene.add(this.sparkMesh);
    this._sparks = new Array(SP.capacity).fill(null).map(() => ({
      life: 0, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      r: 1, g: 1, b: 1, w: SP.width, floor: -1e9,
    }));
    this._sparkCursor = 0;
    this._sparkActive = 0;

    // ---- ③ 烟尘（CPU 模拟：阻力积分 + 尺寸增长）----
    this.puffGeo = createCarbinePuffGeometry();
    const pf = createCarbinePuffMaterial();
    this.puffMat = pf.material;
    this.puffUniforms = pf.uniforms;
    this.puffMesh = new THREE.Mesh(this.puffGeo, this.puffMat);
    this.puffMesh.frustumCulled = false;
    this.puffMesh.renderOrder = PU.renderOrder;
    this.puffMesh.visible = false;
    scene.add(this.puffMesh);
    this._puffs = new Array(PU.capacity).fill(null).map(() => ({
      life: 0, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      size: 0, grow: 0, alpha: 0, r: 1, g: 1, b: 1, drag: PU.drag,
    }));
    this._puffCursor = 0;
    this._puffActive = 0;

    // ---- ④ 弹壳（InstancedMesh：真实刚体）----
    this.casingGeo = createCarbineCasingGeometry(CA);
    this.casingMat = createCarbineCasingMaterial();
    this.casingMesh = new THREE.InstancedMesh(this.casingGeo, this.casingMat, CA.capacity);
    this.casingMesh.frustumCulled = false;
    this.casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.casingMesh.castShadow = false;
    this.casingMesh.receiveShadow = false;
    this.casingMesh.visible = false;
    for (let i = 0; i < CA.capacity; i++) this.casingMesh.setMatrixAt(i, _zero);
    this.casingMesh.instanceMatrix.needsUpdate = true;
    scene.add(this.casingMesh);
    this._casings = new Array(CA.capacity).fill(null).map(() => ({
      life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Euler(), spin: new THREE.Vector3(), bounces: 0, settled: false,
    }));
    this._casingCursor = 0;
    this._casingActive = 0;

    // ---- ⑤ 弹孔 ----
    this.holeGeo = createCarbineHoleGeometry();
    this.holeMat = createCarbineHoleMaterial().material;
    this.holeMesh = new THREE.Mesh(this.holeGeo, this.holeMat);
    this.holeMesh.frustumCulled = false;
    this.holeMesh.renderOrder = HO.renderOrder;
    this.holeMesh.visible = false;
    scene.add(this.holeMesh);
    this._holeCursor = 0;
    this._holeCount = 0;

    /** 最近一次命中的音效 id（装配层读它播一次；null = 不播） */
    this.lastImpactSound = null;
  }

  /** 全部 mesh（反射 pass 要临时隐身它们 —— 成本主杠杆是 draw call 数） */
  get meshes() {
    return [this.tracerMesh, this.sparkMesh, this.puffMesh, this.casingMesh, this.holeMesh];
  }

  /** 活跃计数（测试 / HUD） */
  get counts() {
    return {
      tracers: this.tracerMesh.visible ? 1 : 0,
      sparks: this._sparkActive,
      puffs: this._puffActive,
      casings: this._casingActive,
      holes: this._holeCount,
    };
  }

  /**
   * 一发子弹的全部视觉（上游 `fire()` 的视觉段）。
   *
   * @param {object} effect controller 的 `_fireCarbine` 产出
   * @param {{muzzle:number[], port:number[], right:number[], up:number[],
   *          forward:number[], playerVel?:number[]}} ctx 世界空间锚点与基底
   * @param {number} nowMs `performance.now()` 基准
   * @returns {{impactSound:string|null, impactKind:string|null}}
   */
  spawnFromEffect(effect, ctx, nowMs) {
    const tSec = nowMs / 1000;
    const out = { impactSound: null, impactKind: null };
    // ① 曳光：枪口 → 命中点（世界空间冻结，与既有 TracerRenderer 同口径）
    if (effect.carbineTracer && effect.start && effect.end) {
      this._fireTracer(ctx.muzzle, effect.end, effect.carbineTracer, tSec);
    }
    // ② 命中特效
    const isEntity = effect.type === 'entity-hit';
    const imp = effect.impacts?.[0] ?? null;
    if (isEntity || imp) {
      const end = effect.end;
      const normal = isEntity
        // 上游实体命中：法线取 `-dir` 并抬 y+0.3（火花朝来向偏上飞）
        ? [-ctx.forward[0], -ctx.forward[1] + 0.3, -ctx.forward[2]]
        : (imp.normal ?? [0, 1, 0]);
      const blockName = !isEntity && this.blockNameOf ? this.blockNameOf(imp.blockId) : null;
      const kind = carbineImpactKind({ isEntity, blockName, normal });
      out.impactKind = kind;
      out.impactSound = carbineImpactSound(kind);
      this.lastImpactSound = out.impactSound;
      // 火花
      const sp = carbineSparkParams(kind);
      const floorY = kind === 'floor' ? end[1] : -1e9;
      const seeds = carbineSparkSeeds(end, normal, sp, this._rand);
      this._spawnSparks(seeds, floorY);
      // 烟尘（上游：命中点沿法线外推 0.05，初速 = 法线×1.2 + 向上 0.4）
      const pp = carbinePuffParams(kind);
      const off = isEntity ? 0 : 0.05;
      this._spawnPuff({
        x: end[0] + normal[0] * off, y: end[1] + normal[1] * off, z: end[2] + normal[2] * off,
        vx: isEntity ? -ctx.forward[0] : normal[0] * 1.2,
        vy: isEntity ? 0.5 : normal[1] * 1.2 + 0.4,
        vz: isEntity ? -ctx.forward[2] : normal[2] * 1.2,
        size: pp.size, grow: pp.grow, life: pp.life, alpha: pp.alpha, color: pp.color,
      });
      // 弹孔（只打在方块上）。⚠️ **默认不启用**：用户 2026-11-22「单孔可以不要」。
      if (!isEntity && imp && this.enableHoles) this._addHole(end, normal);
    }
    // ③ 抛壳（每发一颗，上游同口径）
    if (ctx.port) this._ejectCasing(ctx, tSec);
    return out;
  }

  /** 曳光：写一个 slot 的三条属性（起点/出生秒、终点/速度、颜色/半宽） */
  _fireTracer(from, to, cfg, tSec) {
    const i = this._tracerCursor;
    this._tracerCursor = (i + 1) % TR.capacity;
    const g = this.tracerGeo;
    g.getAttribute('aA').setXYZW(i, from[0], from[1], from[2], tSec);
    g.getAttribute('aB').setXYZW(i, to[0], to[1], to[2], cfg.speed);
    g.getAttribute('aCol').setXYZW(i, cfg.color[0], cfg.color[1], cfg.color[2], cfg.width);
    g.getAttribute('aA').needsUpdate = true;
    g.getAttribute('aB').needsUpdate = true;
    g.getAttribute('aCol').needsUpdate = true;
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    this._tracerUntil = Math.max(this._tracerUntil, tSec + carbineTracerLifetime(dist));
    this.tracerMesh.visible = true;
  }

  /** 火花：写出生属性（后续由 update 逐帧推进位置/淡出） */
  _spawnSparks(seeds, floorY) {
    const g = this.sparkGeo;
    const pos = g.getAttribute('aPos');
    const vel = g.getAttribute('aVel');
    const col = g.getAttribute('aCol');
    const fl = g.getAttribute('aFloor');
    for (const s of seeds) {
      const i = this._sparkCursor;
      this._sparkCursor = (i + 1) % SP.capacity;
      const p = this._sparks[i];
      if (p.life <= 0) this._sparkActive++;
      p.x = s.pos[0]; p.y = s.pos[1]; p.z = s.pos[2];
      p.vx = s.vel[0]; p.vy = s.vel[1]; p.vz = s.vel[2];
      p.life = s.life; p.age = 0;
      p.r = s.color[0]; p.g = s.color[1]; p.b = s.color[2];
      p.w = s.width; p.floor = floorY;
      pos.setXYZW(i, p.x, p.y, p.z, p.w);
      vel.setXYZW(i, p.vx, p.vy, p.vz, 1);
      col.setXYZ(i, p.r, p.g, p.b);
      fl.setX(i, floorY);
    }
    pos.needsUpdate = true; vel.needsUpdate = true;
    col.needsUpdate = true; fl.needsUpdate = true;
    this.sparkMesh.visible = true;
  }

  /** 烟尘：写一个 slot（后续由 update 推进） */
  _spawnPuff(o) {
    const i = this._puffCursor;
    this._puffCursor = (i + 1) % PU.capacity;
    const p = this._puffs[i];
    if (p.life <= 0) this._puffActive++;
    p.x = o.x; p.y = o.y; p.z = o.z;
    p.vx = o.vx; p.vy = o.vy; p.vz = o.vz;
    p.size = o.size; p.grow = o.grow; p.life = o.life; p.age = 0;
    p.alpha = o.alpha; p.drag = PU.drag;
    p.r = o.color[0]; p.g = o.color[1]; p.b = o.color[2];
    const g = this.puffGeo;
    g.getAttribute('aPos').setXYZW(i, p.x, p.y, p.z, p.size);
    g.getAttribute('aCol').setXYZW(i, p.r, p.g, p.b, 0);
    g.getAttribute('aPos').needsUpdate = true;
    g.getAttribute('aCol').needsUpdate = true;
    this.puffMesh.visible = true;
  }

  /** 弹壳：从抛壳口以右+上+后的初速抛出（上游 fire() 的 ev 逐项） */
  _ejectCasing(ctx, tSec) {
    void tSec;
    const i = this._casingCursor;
    this._casingCursor = (i + 1) % CA.capacity;
    const p = this._casings[i];
    if (p.life <= 0) this._casingActive++;
    p.pos.set(ctx.port[0], ctx.port[1], ctx.port[2]);
    const r = this._rand;
    const kr = CA.ejectRight + r() * CA.ejectRightRange;
    const ku = CA.ejectUp + r() * CA.ejectUpRange;
    const pv = ctx.playerVel ?? [0, 0, 0];
    p.vel.set(
      ctx.right[0] * kr + ctx.up[0] * ku + ctx.forward[0] * CA.ejectBack + pv[0],
      ctx.right[1] * kr + ctx.up[1] * ku + ctx.forward[1] * CA.ejectBack + pv[1],
      ctx.right[2] * kr + ctx.up[2] * ku + ctx.forward[2] * CA.ejectBack + pv[2],
    );
    p.life = CA.life;
    p.bounces = 0;
    p.settled = false;
    p.rot.set(r() * 6, r() * 6, r() * 6);
    p.spin.set((r() - 0.5) * CA.spinRange, (r() - 0.5) * CA.spinRange, (r() - 0.5) * CA.spinRange);
    this.casingMesh.visible = true;
  }

  /** 弹孔：写一个 slot（静态，无 update） */
  _addHole(pos, normal) {
    const i = this._holeCursor;
    this._holeCursor = (i + 1) % HO.capacity;
    const size = HO.sizeMin + this._rand() * HO.sizeRange;
    const g = this.holeGeo;
    g.getAttribute('aP').setXYZW(i, pos[0], pos[1], pos[2], size);
    g.getAttribute('aN').setXYZ(i, normal[0], normal[1], normal[2]);
    g.getAttribute('aP').needsUpdate = true;
    g.getAttribute('aN').needsUpdate = true;
    this._holeCount = Math.min(HO.capacity, this._holeCount + 1);
    this.holeMesh.visible = true;
  }

  /**
   * 每帧推进三个 CPU 池 + 曳光时钟。
   * @param {number} nowMs `performance.now()` 基准
   * @param {number} dt 秒
   */
  update(nowMs, dt) {
    const tSec = nowMs / 1000;
    this.tracerUniforms.uTime.value = tSec;
    this.puffUniforms.uTime.value = tSec;
    if (this.tracerMesh.visible && tSec > this._tracerUntil) this.tracerMesh.visible = false;
    if (dt > 0) {
      this._updateSparks(dt);
      this._updatePuffs(dt);
      this._updateCasings(dt);
    }
  }

  /** 火花：重力 + 位移 + 落地反弹 + 淡出（上游 Sparks.update 逐字） */
  _updateSparks(dt) {
    if (this._sparkActive === 0) {
      if (this.sparkMesh.visible) this.sparkMesh.visible = false;
      return;
    }
    const g = this.sparkGeo;
    const pos = g.getAttribute('aPos');
    const vel = g.getAttribute('aVel');
    let active = 0;
    for (let i = 0; i < SP.capacity; i++) {
      const p = this._sparks[i];
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.life = 0;
        pos.setW(i, 0);
        vel.setW(i, 0);
        continue;
      }
      p.vy -= SP.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.floor + 0.01 && p.vy < 0) {
        p.y = p.floor + 0.01;
        p.vy *= SP.bounceY;
        p.vx *= SP.bounceXZ; p.vz *= SP.bounceXZ;
      }
      const u = p.age / p.life;
      const fade = 1 - u * u;
      pos.setXYZW(i, p.x, p.y, p.z, p.w);
      vel.setXYZW(i, p.vx, p.vy, p.vz, fade);
      active++;
    }
    pos.needsUpdate = true; vel.needsUpdate = true;
    this._sparkActive = active;
    this.sparkMesh.visible = active > 0;
  }

  /** 烟尘：阻力积分 + 尺寸增长 + 三段 alpha 包络（上游 Puffs.update 逐字） */
  _updatePuffs(dt) {
    if (this._puffActive === 0) {
      if (this.puffMesh.visible) this.puffMesh.visible = false;
      return;
    }
    const g = this.puffGeo;
    const pos = g.getAttribute('aPos');
    const col = g.getAttribute('aCol');
    let active = 0;
    for (let i = 0; i < PU.capacity; i++) {
      const p = this._puffs[i];
      if (p.life <= 0) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.life = 0;
        pos.setW(i, 0);
        col.setW(i, 0);
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.size += p.grow * dt;
      const u = p.age / p.life;
      // 上游：alpha × min(1, u*6) × (1−u)²
      const a = p.alpha * Math.min(1, u * 6) * (1 - u) * (1 - u);
      pos.setXYZW(i, p.x, p.y, p.z, p.size);
      col.setXYZW(i, p.r, p.g, p.b, a);
      active++;
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this._puffActive = active;
    this.puffMesh.visible = active > 0;
  }

  /** 弹壳：重力 + 落地反弹（最多响 3 声）+ 躺平 + 自旋（上游 Casings.update 逐字） */
  _updateCasings(dt) {
    if (this._casingActive === 0) {
      if (this.casingMesh.visible) this.casingMesh.visible = false;
      return;
    }
    let active = 0;
    let dirty = false;
    for (let i = 0; i < CA.capacity; i++) {
      const p = this._casings[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.casingMesh.setMatrixAt(i, _zero);
        dirty = true;
        continue;
      }
      if (!p.settled) {
        p.vel.y -= CA.gravity * dt;
        p.pos.addScaledVector(p.vel, dt);
        const g = this.groundAt ? this.groundAt(p.pos.x, p.pos.z, p.pos.y + 0.3) : null;
        if (g !== null && g !== undefined) {
          const floor = g + CA.floorOffset;
          if (p.pos.y < floor) {
            p.pos.y = floor;
            if (Math.abs(p.vel.y) > CA.bounceThreshold) {
              p.vel.y *= CA.bounceY;
              p.vel.x *= CA.bounceXZ; p.vel.z *= CA.bounceXZ;
              p.spin.multiplyScalar(CA.spinDamp);
              p.bounces++;
              if (this.onCasingBounce && p.bounces <= CA.maxBounceSounds) {
                this.onCasingBounce(p.pos, p.bounces);
              }
            } else {
              p.vel.set(0, 0, 0);
              p.spin.set(0, 0, 0);
              p.rot.x = Math.PI / 2;   // 躺平（上游同口径）
              p.rot.z = 0;
              p.settled = true;
            }
          }
        }
        p.rot.x += p.spin.x * dt;
        p.rot.y += p.spin.y * dt;
        p.rot.z += p.spin.z * dt;
      }
      _m.compose(p.pos, _q.setFromEuler(p.rot), _s1);
      this.casingMesh.setMatrixAt(i, _m);
      dirty = true;
      active++;
    }
    if (dirty) this.casingMesh.instanceMatrix.needsUpdate = true;
    this._casingActive = active;
    this.casingMesh.visible = active > 0;
  }

  /**
   * 清空全部池（切枪 / 瞬移后不想留旧特效时）。
   *
   * ⚠️⚠️ **必须同时把计数与 GPU 属性归零**（本轮 spec 实测）：
   * 只置 `p.life = 0` 而不清 `_casingActive` / `_tracerUntil` 时，`counts` 仍报旧值，
   * 且下一帧 `_updateCasings` 会因 `active===0` 早退而**不再写零矩阵**
   * ⇒ 弹壳冻在最后一帧的位置上永久可见（静默失效）。
   */
  clear() {
    const sg = this.sparkGeo;
    for (let i = 0; i < SP.capacity; i++) {
      this._sparks[i].life = 0;
      sg.getAttribute('aPos').setW(i, 0);
      sg.getAttribute('aVel').setW(i, 0);
    }
    sg.getAttribute('aPos').needsUpdate = true;
    sg.getAttribute('aVel').needsUpdate = true;
    const pg = this.puffGeo;
    for (let i = 0; i < PU.capacity; i++) {
      this._puffs[i].life = 0;
      pg.getAttribute('aPos').setW(i, 0);
      pg.getAttribute('aCol').setW(i, 0);
    }
    pg.getAttribute('aPos').needsUpdate = true;
    pg.getAttribute('aCol').needsUpdate = true;
    for (let i = 0; i < CA.capacity; i++) {
      this._casings[i].life = 0;
      this.casingMesh.setMatrixAt(i, _zero);
    }
    this.casingMesh.instanceMatrix.needsUpdate = true;
    // 曳光：把全部 slot 的出生时刻推到远过去 ⇒ shader 的 alive 门恒 0
    const tg = this.tracerGeo;
    for (let i = 0; i < TR.capacity; i++) tg.getAttribute('aA').setW(i, -1e3);
    tg.getAttribute('aA').needsUpdate = true;
    // 弹孔：尺寸归零（shader 的 quad 退化 ⇒ 不可见）
    const hg = this.holeGeo;
    for (let i = 0; i < HO.capacity; i++) hg.getAttribute('aP').setW(i, 0);
    hg.getAttribute('aP').needsUpdate = true;
    this._sparkActive = this._puffActive = this._casingActive = 0;
    this._holeCount = 0;
    this._tracerUntil = 0;
    this._tracerCursor = this._sparkCursor = this._puffCursor = this._casingCursor = this._holeCursor = 0;
    for (const m of this.meshes) m.visible = false;
  }

  /** 从 scene 移除并释放全部 GPU 资源。 */
  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    this.casingMesh.dispose();
    for (const g of [this.tracerGeo, this.sparkGeo, this.puffGeo, this.holeGeo, this.casingGeo]) g.dispose();
    for (const m of [this.tracerMat, this.sparkMat, this.puffMat, this.holeMat, this.casingMat]) m.dispose();
  }
}
