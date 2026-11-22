// src/render/storm-rain.js — 持续雨（雨天光影档）：GPU 雨丝 + 地面水花冠
//
// 上游：`bj-shooting-game/night-heron-src/src/fx/rain.js` 的 `Rain` 类。
// 本文件只负责**池管理 + 逐滴遮挡解析 + 水花生成**；TSL 在 `storm-rain-material.js`，
// 观感常量与纯函数在 `storm-rain-config.js`（three-free，可单测）。
//
// ## 用户的三条硬约束（2026-11-22）
//   ① 室内不生效 —— 雨被房屋屋顶拦住（含玻璃屋顶）；
//   ② 树叶 / 云彩 / 空岛**不拦**雨；
//   ③ 雨特效生效高度**不高于云朵**。
// 全部落在 `rain-shelter.js` 的三个纯函数里（Tier 1 单测 21 例钉住），
// 本文件只消费它们，**不重写判据**（红线 1）。
//
// ## 三条池化硬约束（与本仓其余特效池同口径）
//   · 空闲/关闭时 `visible=false`（draw call 回基线，不进透明排序列表）；
//   · 每帧零分配（临时向量是模块级常量）；
//   · 时间基准由装配层给（`nowMs` = performance.now 基准）。
//
// ## 与上游的两处必要改写
//   ① 遮挡走**逐滴 CPU 解析 + 逐实例属性**（上游是静态 shelter 贴图）：
//      本仓世界可挖可放，静态贴图会过期。解析按 30Hz + 分批（同既有 rain.js 的削峰手法）。
//   ② 雨幕盒心钳在云层之下（`rainBoxCenterY`）。
import * as THREE from 'three';
import {
  STORM_STREAK as ST, STORM_SPLASH as SP,
  stormStreakCount, stormSplashRate,
} from './storm-rain-config.js';
import {
  createStormStreakGeometry, createStormStreakMaterial,
  createStormSplashGeometry, createStormSplashMaterial,
} from './storm-rain-material.js';
import { rainShelterY, isUnderRoof, rainBoxCenterY, RAIN_CEILING_Y } from './rain-shelter.js';


/** 遮挡解析的节流（秒）= 10Hz。雨滴位置每帧在动，但**遮挡关系**变化慢。 */
const SHELTER_INTERVAL = 0.1;
/** 每批解析几滴（削峰；5200 滴 / 每批 512 ⇒ 约 10 批走完一轮） */
const SHELTER_BATCH = 512;

export class StormRain {
  /**
   * @param {{scene: THREE.Scene, world: object, registry: object,
   *          playerPos: {x:number,y:number,z:number},
   *          mode?: 'sharp'|'performance',
   *          skyDim?: object, shadowStrength?: object,
   *          rand?: () => number}} deps
   */
  constructor({ scene, world, registry, playerPos, mode = 'sharp', skyDim, shadowStrength, rand = Math.random }) {
    this.scene = scene;
    this.world = world;
    this.registry = registry;
    this._rand = rand;
    this.capacity = stormStreakCount(mode);
    this.splashRate = stormSplashRate(mode);

    // ---- 雨丝 ----
    this.streakGeo = createStormStreakGeometry(this.capacity);
    const st = createStormStreakMaterial({ skyDim, shadowStrength });
    this.streakMat = st.material;
    this.streakUniforms = st.uniforms;
    this.streakMesh = new THREE.Mesh(this.streakGeo, this.streakMat);
    this.streakMesh.frustumCulled = false;
    this.streakMesh.renderOrder = ST.renderOrder;
    this.streakMesh.visible = false;
    scene.add(this.streakMesh);
    // 逐滴种子（[0,1)³，固定 ⇒ 雨幕图案可复现）
    const seedAttr = this.streakGeo.getAttribute('aSeed');
    for (let i = 0; i < this.capacity; i++) {
      seedAttr.setXYZ(i, rand(), rand(), rand());
    }
    seedAttr.needsUpdate = true;

    // ---- 水花 ----
    this.splashGeo = createStormSplashGeometry();
    const sp = createStormSplashMaterial({ skyDim, shadowStrength });
    this.splashMat = sp.material;
    this.splashUniforms = sp.uniforms;
    this.splashMesh = new THREE.Mesh(this.splashGeo, this.splashMat);
    this.splashMesh.frustumCulled = false;
    this.splashMesh.renderOrder = SP.renderOrder;
    this.splashMesh.visible = false;
    scene.add(this.splashMesh);
    this._splashCursor = 0;
    this._splashAcc = 0;
    this._splashUntil = 0;

    // ---- 状态 ----
    this._enabled = false;
    this._intensity = 0;
    this._time = 0;
    this._shelterAcc = SHELTER_INTERVAL;   // 首帧立即解析一轮
    this._shelterCursor = 0;
    this._center = new THREE.Vector3(playerPos.x, playerPos.y, playerPos.z);
    this._shelteredDrops = 0;
    this._underRoof = false;
    /** 相机前向（水花生成扇形用；装配层每帧写） */
    this._forward = new THREE.Vector3(0, 0, -1);
  }

  /** 两个 mesh（反射 pass 要临时隐身；成本主杠杆是 draw call 数） */
  get meshes() { return [this.streakMesh, this.splashMesh]; }

  /**
   * 开关（面板「雨天光影」）。关闭时两个 mesh 立即不可见。
   * ⚠️ **不清空缓冲**：重开立刻有内容，不闪断（同 leaf-fx 口径）。
   */
  setEnabled(on) {
    this._enabled = !!on;
    if (!this._enabled) {
      this.streakMesh.visible = false;
      this.splashMesh.visible = false;
    }
    return this._enabled;
  }

  get enabled() { return this._enabled; }

  /** 强度 0..1（雨天光影档恒 1；留接口供将来淡入淡出） */
  setIntensity(v) {
    this._intensity = Math.max(0, Math.min(1, v));
    const g = this._intensity;
    this.streakUniforms.uGain.value = g;
    this.splashUniforms.uGain.value = g;
    return this._intensity;
  }

  /** 相机前向（水花只在视野前方生成 —— 上游同口径，省掉背后的水花） */
  setForward(x, y, z) { this._forward.set(x, y, z); }

  /** 只读诊断（测试 / HUD） */
  debugState() {
    return {
      enabled: this._enabled,
      intensity: this._intensity,
      capacity: this.capacity,
      streakVisible: this.streakMesh.visible,
      splashVisible: this.splashMesh.visible,
      shelteredDrops: this._shelteredDrops,
      underRoof: this._underRoof,
      centerY: this._center.y,
      ceilingY: RAIN_CEILING_Y,
      splashRate: this.splashRate,
    };
  }

  /**
   * 每帧推进。
   *
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} dt 秒
   * @param {number} nowMs `performance.now()` 基准
   */
  update(playerPos, dt, nowMs) {
    if (!this._enabled || this._intensity <= 0) {
      if (this.streakMesh.visible) this.streakMesh.visible = false;
      if (this.splashMesh.visible) this.splashMesh.visible = false;
      return;
    }
    this._time += dt;
    const tSec = nowMs / 1000;
    this.streakUniforms.uTime.value = this._time;
    this.splashUniforms.uTime.value = tSec;

    // ---- 盒心：跟随玩家但**钳在云层之下**（用户约束③）----
    this._center.set(
      playerPos.x,
      rainBoxCenterY(playerPos.y, ST.box[1]),
      playerPos.z,
    );
    this.streakUniforms.uCenter.value.copy(this._center);

    // ---- 室内门（用户约束①）：玩家头顶有屋顶 ⇒ 整个雨效不生效 ----
    // ⚠️ 每帧一次扫描（最多 24 格）成本可忽略；它决定的是「玩家所在处是否室内」，
    // 而逐滴的 aShelter 决定「哪些滴在屋顶下」—— 两者互补：
    // 站在室内时整片雨停（连窗外远处的雨丝也不画，符合「室内不生效」）；
    // 站在室外时只有屋顶正下方那些滴被剔掉。
    this._underRoof = isUnderRoof(this.world, this.registry, playerPos.x, playerPos.y + 1.6, playerPos.z);
    if (this._underRoof) {
      this.streakMesh.visible = false;
      this.splashMesh.visible = false;
      return;
    }

    // ---- 逐滴遮挡解析（10Hz + 分批削峰）----
    this._shelterAcc += dt;
    if (this._shelterAcc >= SHELTER_INTERVAL) {
      this._shelterAcc = 0;
      this._resolveShelterBatch();
    }
    this.streakMesh.visible = true;

    // ---- 水花生成 ----
    this._spawnSplashes(playerPos, dt, tSec);
    if (this.splashMesh.visible && tSec > this._splashUntil) this.splashMesh.visible = false;
  }

  /**
   * 解析一批雨滴的截停高度与「是否在屋顶下」。
   *
   * ⚠️ **雨滴的世界位置每帧在变**（GPU 循环），故这里用**当前时刻的解析位置**
   * 近似 —— 与既有 `rain.js` 的 30Hz 迁移同手法：遮挡关系变化慢，10Hz 足够。
   * ⚠️ 判据全部走 `rain-shelter.js`（不重写「哪些方块挡雨」）。
   */
  _resolveShelterBatch() {
    const seedAttr = this.streakGeo.getAttribute('aSeed');
    const minYAttr = this.streakGeo.getAttribute('aMinY');
    const shAttr = this.streakGeo.getAttribute('aShelter');
    const end = Math.min(this._shelterCursor + SHELTER_BATCH, this.capacity);
    const half = [ST.box[0] / 2, ST.box[1] / 2, ST.box[2] / 2];
    let sheltered = 0;
    for (let i = this._shelterCursor; i < end; i++) {
      // 与 GPU 同式地算出该滴此刻的世界位置（wrap 后）
      const sx = seedAttr.getX(i);
      const sy = seedAttr.getY(i);
      const sz = seedAttr.getZ(i);
      const sp = ST.speedMin + ST.speedRange * fract(sx * 7.31 + sz * 3.17);
      const rawX = sx * ST.box[0] + ST.vel[0] * this._time;
      const rawY = sy * ST.box[1] - ST.vel[1] * sp * this._time;
      const rawZ = sz * ST.box[2] + ST.vel[2] * this._time;
      const wx = mod(rawX - this._center.x + half[0], ST.box[0]) - half[0] + this._center.x;
      const wy = mod(rawY - this._center.y + half[1], ST.box[1]) - half[1] + this._center.y;
      const wz = mod(rawZ - this._center.z + half[2], ST.box[2]) - half[2] + this._center.z;
      // 截停面（屋顶/地面顶面）；null ⇒ 无截停
      const shelter = rainShelterY(this.world, this.registry, wx, wz, wy, 24);
      if (shelter === null) {
        minYAttr.setX(i, -1e9);
        shAttr.setX(i, 0);
      } else {
        minYAttr.setX(i, shelter);
        // 该滴此刻已在截停面之下 ⇒ 它在屋顶正下方（整滴不画）
        const under = wy < shelter ? 1 : 0;
        shAttr.setX(i, under);
        sheltered += under;
      }
    }
    minYAttr.needsUpdate = true;
    shAttr.needsUpdate = true;
    this._shelterCursor = end >= this.capacity ? 0 : end;
    // 诊断计数取整轮的近似（每批覆盖 1/10，乘回去）
    this._shelteredDrops = Math.round(sheltered * (this.capacity / SHELTER_BATCH));
  }

  /**
   * 生成水花冠（上游 `Rain.update` 的生成段逐字）。
   *
   * 在相机**前方扇形**内取随机点（半径平方分布 ⇒ 近处密），
   * 查该点的地面/屋顶顶面，高于眼高太多或在屋顶下则跳过。
   */
  _spawnSplashes(playerPos, dt, tSec) {
    this._splashAcc += dt * this.splashRate * this._intensity;
    let n = Math.min(SP.perFrameCap, Math.floor(this._splashAcc));
    this._splashAcc -= n;
    if (n <= 0) return;
    const attr = this.splashGeo.getAttribute('aSpawn');
    const baseAngle = Math.atan2(this._forward.x, this._forward.z);
    let wrote = false;
    while (n-- > 0) {
      const r = SP.radiusMin + this._rand() * this._rand() * SP.radiusRange;
      const a = baseAngle + (this._rand() - 0.5) * SP.angleSpread;
      const x = playerPos.x + Math.sin(a) * r;
      const z = playerPos.z + Math.cos(a) * r;
      // 落点：从眼高往上一点开始往下扫（上游 groundAt(x,z,camY+1.2,0.3)）
      const y = rainShelterY(this.world, this.registry, x, z, playerPos.y + 1.6, 24);
      if (y === null) continue;
      if (y > playerPos.y + SP.maxAboveEye) continue;
      // 该点在屋顶下 ⇒ 不溅水花（用户约束①：室内不生效）
      if (isUnderRoof(this.world, this.registry, x, y + 0.2, z, 12)) continue;
      const i = this._splashCursor;
      this._splashCursor = (i + 1) % SP.capacity;
      attr.setXYZW(i, x, y + SP.floorOffset, z, tSec + this._rand() * 0.03);
      wrote = true;
    }
    if (wrote) {
      attr.needsUpdate = true;
      this.splashMesh.visible = true;
      this._splashUntil = tSec + SP.life + 0.05;
    }
  }

  /** 清空水花（切档 / 关开关时不想留旧水花）。 */
  clearSplashes() {
    const attr = this.splashGeo.getAttribute('aSpawn');
    for (let i = 0; i < SP.capacity; i++) attr.setW(i, -1e3);
    attr.needsUpdate = true;
    this._splashUntil = 0;
    this.splashMesh.visible = false;
  }

  /** 从 scene 移除并释放 GPU 资源。 */
  dispose() {
    for (const m of this.meshes) this.scene.remove(m);
    this.streakGeo.dispose();
    this.splashGeo.dispose();
    this.streakMat.dispose();
    this.splashMat.dispose();
  }
}

function fract(x) { return x - Math.floor(x); }
function mod(x, m) { return ((x % m) + m) % m; }
