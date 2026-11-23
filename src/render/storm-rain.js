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
import { isUnderRoof, rainBoxCenterY, RAIN_CEILING_Y } from './rain-shelter.js';


/** 遮挡解析的节流（秒）= 10Hz。雨滴位置每帧在动，但**遮挡关系**变化慢。 */
const SHELTER_INTERVAL = 0.1;
/** 每批解析几滴（削峰；5200 滴 / 每批 512 ⇒ 约 10 批走完一轮） */
const SHELTER_BATCH = 512;

export class StormRain {
  /**
   * @param {{scene: THREE.Scene, world: object, registry: object,
   *          playerPos: {x:number,y:number,z:number},
   *          shelterMap: import('./rain-shelter-map.js').RainShelterMap,
   *          mode?: 'sharp'|'performance',
   *          skyDim?: object, shadowStrength?: object,
   *          rand?: () => number}} deps
   *   `shelterMap` **必填**：逐列遮挡高度图（装配层给）。雨丝/水花查它，
   *   不再逐滴扫体素 —— 既便宜，又修掉「从滴自己的 y 往下扫看不到屋顶」的缺陷。
   */
  constructor({ scene, world, registry, playerPos, shelterMap, mode = 'sharp', skyDim, shadowStrength, rand = Math.random }) {
    this.scene = scene;
    this.world = world;
    this.registry = registry;
    this.shelterMap = shelterMap;
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
      shelterColumns: this.shelterMap?.lastTickColumns ?? 0,
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

    // ---- 玩家所在处是否被遮挡（**只喂音频**，不再当视觉总闸）----
    // ⚠️⚠️ v3.34：**删掉了「玩家室内 ⇒ 两个 mesh visible=false 并 return」的总闸**。
    // 用户 2026-11-23：「玩家待在屋里向外看，是能看到外面在下雨的」。
    // 遮挡是**空间属性**，不是玩家的属性 ⇒ 逐滴查列级高度图（下方）。
    // `_underRoof` 保留但语义收窄为「玩家头顶有没有盖」，喂雨声衰减与远雷门（听感正确）。
    this._underRoof = isUnderRoof(this.world, this.registry, playerPos.x, playerPos.y + 1.6, playerPos.z);

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
    const wcAttr = this.streakGeo.getAttribute('aWaterCol');
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
      // 截停面（屋顶/地面顶面 **或水面**）—— v3.34 改成**查列级高度图**。
      //
      // ⚠️⚠️ 旧写法 `rainStopY(world, reg, wx, wz, **wy**, 24)` 的扫描起点是
      // **雨滴自己当前的 y** ⇒ 屋内 y=5 的滴往下扫只会先撞到 y=0 的地板，
      // **永远看不到 y=9 的屋顶** ⇒ 雨照画在屋里（被总闸掩盖的静默缺陷）。
      // 高度图从**云层上界**往下扫 ⇒ 屋内地板那一列的 stop = 屋顶顶面。
      // null = 未知/无截停/窗外 ⇒ 安全失败（不遮挡）。
      const shelter = this.shelterMap.stopAt(wx, wz);
      /**
       * 该列有没有暴露水面（v3.30g）—— GPU 侧水下门的**列级**因子。
       * ⚠️ 与「滴的 y 在不在水下」分开：后者每帧在变，必须 GPU 逐顶点判；
       * 前者（列的水陆属性）变化慢，10Hz 采样足够。
       * ⚠️ **语义有意收窄**：单遍扫描遇屋顶即停 ⇒ 「屋顶盖住的水面」列 hasWater=0。
       * 已穷举证明不可达（5684 列全部 stop > 该列水面 ⇒ 不存在「水下且可见」的区间）。
       */
      wcAttr.setX(i, this.shelterMap.waterAt(wx, wz) ? 1 : 0);
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
    wcAttr.needsUpdate = true;
    this._shelterCursor = end >= this.capacity ? 0 : end;
    // 诊断计数取整轮的近似（每批覆盖 1/10，乘回去）
    this._shelteredDrops = Math.round(sheltered * (this.capacity / SHELTER_BATCH));
  }

  /**
   * 世界编辑后立即重解全部雨滴的截停面（v3.34）。
   *
   * ⚠️⚠️ **光把 column 插队首不够**（本轮 Tier 4 实测拓到的真缺陷）：
   * 高度图重扫了（`mapStopNow=28` = 屋顶），但**逐滴属性还是旧值**
   * （`attrMinY=23` = 地板）—— 10Hz 分批轮转要 ~1 s 才轮到那一半滴
   * ⇒ 新盖的屋顶下那期间**照旧下雨**（实测 7~11 滴），挖掉屋顶同理。
   * 用户要的是「挖放方块当帧跟随」⇒ 编辑事件必须同时刷逐滴属性。
   *
   * 成本：一次查表遍历（无体素扫描），5200 滴 ≈ 0.2 ms，只在编辑帧发生。
   */
  refreshShelterNow() {
    if (!this.shelterMap) return;
    const saved = this._shelterCursor;
    this._shelterCursor = 0;
    // ⚠️ **不能用 `while (cursor < capacity)`**：`_resolveShelterBatch` 末尾会把
    // 走到尾的 cursor **归 0**（环形轮转）⇒ 那个条件永远成立 ⇒ **主线程死循环**
    // （本轮实测：浏览器卡在这里，整个 page.evaluate 永不返回）。
    // 改用**固定批数**：ceil(capacity / 批大小) 趟恰好覆盖全量。
    const batches = Math.ceil(this.capacity / SHELTER_BATCH);
    for (let i = 0; i < batches; i++) this._resolveShelterBatch();
    this._shelterCursor = saved;
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
      // 落点：查列级高度图（v3.34）—— 与雨丝同源，不再逐点扫体素。
      // ⚠️ v3.30g：取 max(挡雨面, 水面) 的语义由高度图的单遍首命中承担
      // ⇒ **被水淹住的湖底不生成水花**，而**湖面本身生成**（用户裁定）。
      const y = this.shelterMap.stopAt(x, z);
      if (y === null) continue;
      if (y > playerPos.y + SP.maxAboveEye) continue;
      // ⚠️ **不需要额外的「在屋顶下」判据**（旧 isUnderRoof 那行已删）：
      // `stop` 本身就是该列**最高**截停面 ⇒ 落点要么在屋顶**上方**（该淋雨），
      // 要么被上一行 maxAboveEye 滤掉（屋内地板那一列的 stop = 屋顶顶面 ≫ 眼高）。
      // 旧写法是对同一个事实的第二次扫描。
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
