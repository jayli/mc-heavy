// src/render/firefly-fx.js — 草地萤火虫池（v3.26）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md §4.2/§4.3
//
// 与 `leaf-fx.js` 共用语义（每帧 biome 门控 + 30Hz 距离检查 + 分批迁移 + isSolid 地面），
// 差别只在：目标 biome 是 PLAINS、颜色是常量（不依赖 atlas 取色）、
// 亮度与只数随 `nightBlend` 联动（**只数走逐实例 aAlive，不改 instanceCount**，spec §3.5）。
//
// ⚠️ **密度调节为什么不靠 instanceCount**：已核实 `geometry.instanceCount` 每次 draw 都读，
// 但「已建好 bindGroup 的 mesh 上改它是否立即生效」**没有 GPU 实测** ⇒ 不作为设计依赖。
// 容量固定 + 缩零（aAlive=0 ⇒ 尺寸 0）是本仓六个粒子池已验证的成熟手法，零新风险。
//
// ⚠️ **只在 count 真的变了时才写 aAlive**：日夜插值下 nb 每帧都在变，但 `round` 后多数帧
// 相同 ⇒ 一次整数比较即可跳过上传。
//
// **主线程专用**（依赖 three）。归属 `render/`。
import * as THREE from 'three';
import { getBiome } from '../gen/noise.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';
import { FIREFLY_FX, fireflySeedAt, fireflyNightAt } from './ambient-fx-config.js';
import {
  FIREFLY_ATTR, createFireflyGeometry, createFireflyMaterial,
} from './firefly-fx-material.js';

export class FireflyFxRenderer {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {{isSolid:(x:number,y:number,z:number)=>boolean}} deps.world
   * @param {number} deps.seed
   * @param {{x:number,y:number,z:number}} deps.playerPos
   * @param {number} [deps.capacity]
   * @param {() => number} [deps.rand]
   */
  constructor({
    scene, world, seed, playerPos,
    capacity = FIREFLY_FX.capacity, rand = Math.random,
  }) {
    this.scene = scene;
    this.world = world || null;
    this.seed = seed;
    this.capacity = Math.max(1, Math.round(capacity));
    this._rand = rand;

    this._geometry = createFireflyGeometry(this.capacity);
    const made = createFireflyMaterial();
    this._material = made.material;
    this.uniforms = made.uniforms;

    this.mesh = new THREE.Mesh(this._geometry, this._material);
    this.mesh.name = 'ambient:firefly';
    this.mesh.renderOrder = FIREFLY_FX.renderOrder;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    /** 供 `_renderWaterReflection` 的 hidden 展开 */
    this.meshes = [this.mesh];
    this.scene.add(this.mesh);

    this._time = 0;
    this._enabled = true;
    this._biome = null;
    this._refreshAcc = 0;
    this._cursor = 0;
    this._isRefreshing = false;
    /** 已真的播种成功的只数（地面未加载时可能少于容量 ⇒ 按 seedRetryInterval 重试差额） */
    this._seededCount = 0;
    /** 上次播种尝试的时刻（秒）—— 节流用，见 config 的 seedRetryInterval */
    this._seedTryAt = -1e3;
    this._count = -1;
    this._gain = FIREFLY_FX.gainDay;
    this._center = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    this._lastPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    this._target = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
  }

  /** @param {boolean} on @returns {boolean} 实际生效值（关闭时不清空缓冲 ⇒ 重开不闪断） */
  setEnabled(on) {
    this._enabled = !!on;
    if (!this._enabled) this.mesh.visible = false;
    return this._enabled;
  }

  get visible() { return this.mesh.visible; }

  get activeCount() { return this.mesh.visible ? Math.max(0, this._count) : 0; }

  debugState() {
    return {
      enabled: this._enabled,
      biome: this._biome,
      visible: this.mesh.visible,
      count: this.activeCount,
      seeded: this._seededCount,
      gain: this._gain,
      time: this._time,
      isRefreshing: this._isRefreshing,
      refreshCursor: this._cursor,
    };
  }

  /** 该列地面顶面 y（同 leaf-fx / rain 的口径）；扫不到返回 null ⇒ 跳过该只 */
  _resolveGroundY(x, z, fromY) {
    if (!this.world || typeof this.world.isSolid !== 'function') return null;
    // ⚠️ x/z 必须取整：`WorldData.getBlockId` 用 `blockIndex(x - cx*16, …)`，
    // 小数坐标会算出小数数组下标 ⇒ undefined ⇒ 全读成 air（玩家坐标恒带 .5）。
    const ix = Math.floor(x); const iz = Math.floor(z);
    const startY = Math.floor(fromY);
    // ⚠️⚠️ **下界必须钳在 WORLD_MIN_Y 之上**（本轮浏览器实测）：`WorldData.getBlockId`
    // 对 `y < WORLD_MIN_Y` 返回 **bedrock**（防穿底）⇒ 未加载 column 全 air 时扫描会
    // 一直命中世界底 ⇒ 地面被解成 −32 ⇒ 叶子全出生在地下（零像素而所有计数全对）。
    const endY = Math.max(WORLD_MIN_Y, startY - FIREFLY_FX.searchDepth);
    for (let y = startY; y >= endY; y--) {
      if (this.world.isSolid(ix, y, iz)) return y + 1;
    }
    return null;
  }

  /**
   * 重出一只（出生或寿命到期）：先探基准地面，再用出生 x/z 重探。
   * ⚠️ 基准从**玩家脚下**往下扫（同落叶）：从头顶扫会把树冠顶当成地面。
   */
  _resetFly(i, center) {
    const probe = this._resolveGroundY(center.x, center.z, center.y);
    if (probe === null) return false;
    const s = fireflySeedAt(center, probe, this._rand);
    const ground = this._resolveGroundY(s.x, s.z, Math.min(s.y, center.y));
    if (ground === null) return false;
    const dy = ground - probe;
    const g = this._geometry;
    g.getAttribute(FIREFLY_ATTR.origin).setXYZ(i, s.x, s.y + dy, s.z);
    g.getAttribute(FIREFLY_ATTR.amp).setXYZ(i, s.ampX, s.ampY, s.ampZ);
    g.getAttribute(FIREFLY_ATTR.freq).setXYZ(i, s.freqX, s.freqY, s.freqZ);
    g.getAttribute(FIREFLY_ATTR.phase).setXYZ(i, s.phaseX, s.phaseY, s.phaseZ);
    // aSizeAlive = (size, alive, breatheFreq, breathePhase)；alive 由 _applyNight 统一写
    const sa = g.getAttribute(FIREFLY_ATTR.sizeAlive);
    sa.setX(i, s.size);
    sa.setZ(i, s.breatheFreq);
    sa.setW(i, s.breathePhase);
    g.getAttribute(FIREFLY_ATTR.life).setXY(i, this._time, s.life);
    // aDriftGround = (driftX, driftZ, groundY)；aSizeAlive.y 由 _applyNight 统一写
    g.getAttribute(FIREFLY_ATTR.driftGround).setXYZ(i, s.driftX, s.driftZ, ground);
    this._dirtyStatic = true;
    return true;
  }

  /**
   * 迁移一只：**只改 origin / ground**，不改 amp/freq/phase/size（保相位）。
   * ⚠️ 「不改那几项」**不减少上传字节**：它们照样每帧全刷（见 material 的 setUsage 处）。
   */
  _moveFly(i, center) {
    const g = this._geometry;
    const o = g.getAttribute(FIREFLY_ATTR.origin);
    const dg = g.getAttribute(FIREFLY_ATTR.driftGround);
    const life = g.getAttribute(FIREFLY_ATTR.life);
    const above = Math.min(FIREFLY_FX.heightMax,
      Math.max(FIREFLY_FX.heightMin, o.getY(i) - dg.getZ(i)));
    const probe = this._resolveGroundY(center.x, center.z, center.y);
    if (probe === null) return false;
    const ang = this._rand() * Math.PI * 2;
    const r = FIREFLY_FX.radius * Math.sqrt(this._rand());
    const x = center.x + Math.cos(ang) * r;
    const z = center.z + Math.sin(ang) * r;
    const ground = this._resolveGroundY(x, z, Math.min(probe + above, center.y));
    if (ground === null) return false;
    o.setXYZ(i, x, ground + above, z);
    dg.setZ(i, ground);
    life.setX(i, this._time);
    this._dirtyStatic = true;
    return true;
  }

  /** 首次进入目标 biome：整池播种（逐片记成败，地面未加载时每帧重试差额） */
  _seedAll() {
    this._dirtyStatic = false;
    const life = this._geometry.getAttribute(FIREFLY_ATTR.life);
    for (let i = 0; i < this.capacity; i++) {
      if (life.getX(i) > -100) continue;
      if (this._resetFly(i, this._center)) this._seededCount++;
    }
    this._flushStatic();
  }

  _startRefresh(playerPos) {
    if (!this._isRefreshing) {
      this._isRefreshing = true;
      this._cursor = 0;
    }
    this._target.x = playerPos.x;
    this._target.y = playerPos.y;
    this._target.z = playerPos.z;
  }

  _processRefresh() {
    if (!this._isRefreshing) return;
    this._dirtyStatic = false;
    const end = Math.min(this._cursor + FIREFLY_FX.refreshBatchSize, this.capacity);
    for (let i = this._cursor; i < end; i++) this._moveFly(i, this._target);
    this._cursor = end;
    this._flushStatic();
    if (this._cursor >= this.capacity) {
      this._isRefreshing = false;
      this._lastPos.x = this._target.x;
      this._lastPos.y = this._target.y;
      this._lastPos.z = this._target.z;
    }
  }

  /** 寿命到期即重新出生（常驻场，不是环形缓冲覆盖） */
  _recycle() {
    const life = this._geometry.getAttribute(FIREFLY_ATTR.life);
    this._dirtyStatic = false;
    for (let i = 0; i < this.capacity; i++) {
      const born = life.getX(i);
      if (born < -100) continue;   // 尚未播种（地面未加载）—— 由 _seedAll 重试
      if (this._time - born > life.getY(i)) this._resetFly(i, this._center);
    }
    this._flushStatic();
  }

  /**
   * 只把真的改过的属性置 needsUpdate。
   *
   * ⚠️⚠️ **它不决定上传量**：WebGPU 后端对 `DynamicDrawUsage` 属性每帧无条件全缓冲上传
   * （`three.webgpu.js:31003`）。实测本池每帧 7 次 `writeBuffer` / **7056 B**（容量 84 时的口径
   * ≈ 84 B/只；2026-11-21 容量抬到 168 ⇒ 估算 ≈14112 B/帧，按容量线性缩放，未重新实测）。
   * 完整实测与「为何不改 usage」的结论写在 `leaf-fx.js:_flushStatic`（两池同一口径）。
   */
  _flushStatic() {
    if (!this._dirtyStatic) return;
    this._dirtyStatic = false;
    for (const key of ['origin', 'amp', 'freq', 'phase', 'sizeAlive', 'life', 'driftGround']) {
      this._geometry.getAttribute(FIREFLY_ATTR[key]).needsUpdate = true;
    }
  }

  /**
   * 夜间联动：gain 每帧写（uniform，不过 instanced 属性缓冲），count 变了才重写 aAlive。
   * ⚠️ 容量按夜间上限分配，但**性能档容量只有一半** ⇒ count 必须按容量比例缩放，
   * 否则性能档夜里会把全部实例点亮（密度反而比清晰档高）。
   */
  _applyNight(nb) {
    const { gain, count } = fireflyNightAt(nb);
    this._gain = gain;
    this.uniforms.uGain.value = gain;
    const scaled = Math.min(this.capacity,
      Math.round(count * (this.capacity / FIREFLY_FX.capacity)));
    if (scaled === this._count) return;
    this._count = scaled;
    const sizeAlive = this._geometry.getAttribute(FIREFLY_ATTR.sizeAlive);
    for (let i = 0; i < this.capacity; i++) sizeAlive.setY(i, i < scaled ? 1 : 0);
    sizeAlive.needsUpdate = true;
  }

  /**
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} dt 秒
   * @param {number} [nightBlend] 0..1（唯一权威 `daynight.js:nightBlendOf`，由装配层算）
   */
  update(playerPos, dt, nightBlend = 0) {
    if (!Number.isFinite(dt) || dt < 0) return;
    if (!playerPos || !Number.isFinite(playerPos.x)
      || !Number.isFinite(playerPos.y) || !Number.isFinite(playerPos.z)) return;

    // ⚠️ uTime 在门控 return 之前累计（关闭态也推进 ⇒ 回来时 age 不跳变）
    this._time += dt;
    this.uniforms.uTime.value = this._time;

    // biome 每帧算（getBiome 实测 0.028µs/次）⇒ 跨边界那一帧就切换，无 200ms 迟滞
    this._biome = getBiome(Math.floor(playerPos.x), Math.floor(playerPos.z), this.seed);
    const want = this._biome === 'PLAINS' && this._enabled;
    if (!want) {
      this.mesh.visible = false;
      return;
    }

    this._center.x = playerPos.x;
    this._center.y = playerPos.y;
    this._center.z = playerPos.z;

    this._applyNight(Number.isFinite(nightBlend) ? nightBlend : 0);

    // ⚠️ 播种重试必须节流：地面长期扫不到（世界边缘 / 流式加载滞后）会永久持续，
    // 每帧全池重扫实测 0.359ms/帧。首帧恒试（_seedTryAt 初值远在过去）。
    if (this._seededCount < this.capacity
      && this._time - this._seedTryAt >= FIREFLY_FX.seedRetryInterval) {
      this._seedTryAt = this._time;
      this._seedAll();
      if (this._seededCount > 0) {
        this._lastPos.x = playerPos.x;
        this._lastPos.y = playerPos.y;
        this._lastPos.z = playerPos.z;
      }
    }

    this._processRefresh();
    this._recycle();
    this.mesh.visible = true;

    this._refreshAcc += dt;
    if (this._refreshAcc < FIREFLY_FX.refreshInterval) return;
    this._refreshAcc = 0;
    const ref = this._isRefreshing ? this._target : this._lastPos;
    const dx = playerPos.x - ref.x;
    const dy = playerPos.y - ref.y;
    const dz = playerPos.z - ref.z;
    if (dx * dx + dz * dz > FIREFLY_FX.refreshDistance * FIREFLY_FX.refreshDistance
      || Math.abs(dy) > FIREFLY_FX.refreshVertical) {
      this._startRefresh(playerPos);
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this._geometry.dispose();
    this._material.dispose();
    this.meshes.length = 0;
  }
}