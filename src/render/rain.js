// src/render/rain.js — 雨滴效果（M3-3，移植 mc-lite src/world/effects/RainEffect.js）
// LineSegments + TSL GPU 下落，算法照搬：圆内均匀分布（sqrt 校正）、相位/速度差、
// isSolid 地面截停、30Hz 距离检查 + 分批（64/帧）雨幕迁移削峰。
// 天气状态机（晴雨周期）在 weather.js（three 无关，浏览器内单测覆盖）。
import * as THREE from 'three';
import { positionLocal, attribute, uniform, vec3, mod, max } from 'three/tsl';
import { RAIN } from './weather.js';

/**
 * 雨滴效果（mc-lite RainEffect 移植）：LineSegments + TSL 顶点位移，
 * 下落/循环全部在 GPU（uTime × speed × speedScale + phase mod cycleHeight），
 * 主线程只做 30Hz 距离检查 + 分批（64/帧）雨幕迁移削峰。
 */
export class RainEffect {
  /**
   * @param {THREE.Scene} scene
   * @param {Object} [opts]
   * @param {import('../voxel/world-data.js').WorldData} [opts.world] 提供 isSolid（地面截停）；缺省不截停
   * @param {{x:number,y:number,z:number}} [opts.playerPos] 初始雨幕中心
   * @param {number} [opts.particleCount] @param {number} [opts.radius] @param {number} [opts.speed]
   * @param {number} [opts.dropLength] @param {number} [opts.lineWidth] @param {number} [opts.cycleHeight]
   * @param {number} [opts.refreshDistance] @param {number} [opts.refreshBatchSize]
   * @param {() => number} [opts.rng]
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.particleCount = opts.particleCount || RAIN.PARTICLE_COUNT;
    this.radius = opts.radius || RAIN.RADIUS;
    this.speed = opts.speed || RAIN.SPEED;
    this.dropLength = opts.dropLength || RAIN.DROP_LENGTH;
    this.lineWidth = opts.lineWidth || RAIN.LINE_WIDTH;
    this.cycleHeight = opts.cycleHeight || RAIN.CYCLE_HEIGHT;
    this.refreshDistance = opts.refreshDistance || RAIN.REFRESH_DISTANCE;
    this.refreshDistanceSq = this.refreshDistance * this.refreshDistance;
    this.refreshInterval = opts.refreshInterval || (1 / 30); // 30Hz 玩家位置检查
    this.verticalRefreshDistance = opts.verticalRefreshDistance || 6;
    this.refreshBatchSize = opts.refreshBatchSize || 64; // 分批刷新，削峰
    this.floorOffset = opts.floorOffset || 0.02;
    this.searchDepth = opts.searchDepth || 56;
    this.world = opts.world || null;
    this.rng = opts.rng || Math.random;

    this.playerPos = opts.playerPos || { x: 0, y: 0, z: 0 };
    this.lastRefreshPos = { x: this.playerPos.x, y: this.playerPos.y, z: this.playerPos.z };
    this.elapsedTime = 0;
    this.refreshAccumulator = 0;
    this.isRefreshing = false;
    this.refreshCursor = 0;
    this.refreshTargetPos = { x: this.playerPos.x, y: this.playerPos.y, z: this.playerPos.z };

    this._initParticles();
  }

  /** 初始化粒子：每滴 2 顶点（顶/底），下落位移在顶点着色器算 */
  _initParticles() {
    const vertexCount = this.particleCount * 2;
    this.positions = new Float32Array(vertexCount * 3);
    this.phases = new Float32Array(vertexCount);
    this.speedScales = new Float32Array(vertexCount);
    this.isBottomVertex = new Float32Array(vertexCount);
    this.minYs = new Float32Array(vertexCount);

    for (let i = 0; i < this.particleCount; i++) this._resetParticle(i, this.playerPos);

    this.geometry = new THREE.BufferGeometry();
    const positionAttr = new THREE.BufferAttribute(this.positions, 3);
    positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', positionAttr);
    this.geometry.setAttribute('aPhase', new THREE.BufferAttribute(this.phases, 1));
    this.geometry.setAttribute('aSpeedScale', new THREE.BufferAttribute(this.speedScales, 1));
    this.geometry.setAttribute('aIsBottomVertex', new THREE.BufferAttribute(this.isBottomVertex, 1));
    this.geometry.setAttribute('aMinY', new THREE.BufferAttribute(this.minYs, 1));

    // GPU 下落（mc-lite TSL 原样）：fall = (uTime × speed × speedScale + phase) mod cycleHeight
    const uTime = uniform(0.0);
    const uBaseSpeed = uniform(this.speed);
    const uDropLength = uniform(this.dropLength);
    const uCycleHeight = uniform(this.cycleHeight);
    const uOpacity = uniform(0.0); // 初始透明：强度由 WeatherState.intensity 驱动
    this.uniforms = { uTime, uBaseSpeed, uDropLength, uCycleHeight, uOpacity };

    const aPhase = attribute('aPhase', 'float');
    const aSpeedScale = attribute('aSpeedScale', 'float');
    const aIsBottomVertex = attribute('aIsBottomVertex', 'float');
    const aMinY = attribute('aMinY', 'float');

    const fallDistance = mod(uTime.mul(uBaseSpeed).mul(aSpeedScale).add(aPhase), uCycleHeight);
    const newY = max(
      positionLocal.y.sub(fallDistance).sub(aIsBottomVertex.mul(uDropLength)),
      aMinY,
    );
    const displacedPosition = vec3(positionLocal.x, newY, positionLocal.z);

    this.material = new THREE.NodeMaterial();
    this.material.positionNode = displacedPosition;
    this.material.colorNode = vec3(1.0, 1.0, 1.0);
    this.material.opacityNode = uOpacity;
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.linewidth = this.lineWidth;

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false; // 雨幕跟随玩家，恒在视锥内，禁用剔除
    this.lines.visible = false;       // 晴天不可见（intensity=0）
    this.scene.add(this.lines);
  }

  /**
   * 雨强度（WeatherState.intensity 接线）：0 → 隐藏省 draw；
   * (0,1) → 透明度过渡（淡入/淡出）。
   */
  setIntensity(v) {
    this.lines.visible = v > 0;
    this.uniforms.uOpacity.value = RAIN.OPACITY * v;
  }

  /** 单滴重置：圆内均匀分布（sqrt 校正），顶/底两顶点同 x/z */
  _resetParticle(i, playerPos, randomizeDynamics = true) {
    const angle = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * this.radius;
    const x = playerPos.x + Math.cos(angle) * r;
    const topY = playerPos.y + 30 + this.rng() * 20;
    const z = playerPos.z + Math.sin(angle) * r;
    const minY = this._resolveRainMinY(x, topY, z, playerPos.y);

    const phase = randomizeDynamics ? (this.rng() * this.cycleHeight) : null;
    const speedScale = randomizeDynamics ? (0.85 + this.rng() * 0.35) : null;

    const idx = i * 6;
    const vertexIdx = i * 2;

    // 顶点1（顶部）
    this.positions[idx] = x;
    this.positions[idx + 1] = topY;
    this.positions[idx + 2] = z;
    if (randomizeDynamics) {
      this.phases[vertexIdx] = phase;
      this.speedScales[vertexIdx] = speedScale;
    }
    this.isBottomVertex[vertexIdx] = 0;
    this.minYs[vertexIdx] = minY;

    // 顶点2（底部：位置同顶，长度在 shader 中经 uDropLength 下移）
    this.positions[idx + 3] = x;
    this.positions[idx + 4] = topY;
    this.positions[idx + 5] = z;
    if (randomizeDynamics) {
      this.phases[vertexIdx + 1] = phase;
      this.speedScales[vertexIdx + 1] = speedScale;
    }
    this.isBottomVertex[vertexIdx + 1] = 1;
    this.minYs[vertexIdx + 1] = minY;
  }

  /**
   * 雨滴可见最低高度（mc-lite 语义）：下方 searchDepth 内有实心方块 → 停在其顶面
   * （地面截停，雨滴不穿地）；无遮挡 → 默认循环最低高度（playerY - 0.35×cycleHeight）。
   */
  _resolveRainMinY(x, topY, z, playerY = 0) {
    const defaultMinY = playerY - (this.cycleHeight * 0.35);
    if (!this.world || typeof this.world.isSolid !== 'function') return defaultMinY;
    const startY = Math.floor(topY);
    const endY = Math.floor(Math.max(defaultMinY, topY - this.searchDepth));
    for (let y = startY; y >= endY; y--) {
      if (this.world.isSolid(x, y, z)) return y + 1 + this.floorOffset;
    }
    return defaultMinY;
  }

  /** 启动分批刷新：雨幕中心逐步迁移到目标点（mc-lite 削峰语义） */
  _startBatchedRefresh(playerPos) {
    if (!playerPos) return;
    const dx = playerPos.x - this.refreshTargetPos.x;
    const dy = playerPos.y - this.refreshTargetPos.y;
    const dz = playerPos.z - this.refreshTargetPos.z;
    const targetChangedEnough = (dx * dx + dz * dz) > (this.refreshDistanceSq * 0.36)
      || Math.abs(dy) > (this.verticalRefreshDistance * 0.6);
    if (!this.isRefreshing) {
      this.isRefreshing = true;
      this.refreshCursor = 0;
    } else if (targetChangedEnough) {
      this.refreshCursor = 0; // 目标变化大：从头刷，避免旧目标尾部残留
    }
    this.refreshTargetPos.x = playerPos.x;
    this.refreshTargetPos.y = playerPos.y;
    this.refreshTargetPos.z = playerPos.z;
  }

  /** 每帧处理一批（refreshBatchSize 滴）迁移，摊平 CPU 尖峰 */
  _processBatchedRefresh() {
    if (!this.isRefreshing) return;
    const end = Math.min(this.refreshCursor + this.refreshBatchSize, this.particleCount);
    for (let i = this.refreshCursor; i < end; i++) {
      // 分批刷新只迁移位置，不改速度相位（减少额外 attribute 上传）
      this._resetParticle(i, this.refreshTargetPos, false);
    }
    this.refreshCursor = end;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aMinY.needsUpdate = true;
    if (this.refreshCursor >= this.particleCount) {
      this.isRefreshing = false;
      this.lastRefreshPos.x = this.refreshTargetPos.x;
      this.lastRefreshPos.y = this.refreshTargetPos.y;
      this.lastRefreshPos.z = this.refreshTargetPos.z;
    }
  }

  /**
   * 每帧：推进 GPU 时间 + 分批迁移 + 30Hz 距离检查（玩家移动超阈值触发雨幕迁移）。
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} dt 秒
   */
  update(playerPos, dt) {
    if (!playerPos || typeof playerPos.x !== 'number') return;
    this.elapsedTime += dt;
    this.uniforms.uTime.value = this.elapsedTime;
    this._processBatchedRefresh();

    this.refreshAccumulator += dt;
    if (this.refreshAccumulator < this.refreshInterval) return;
    this.refreshAccumulator = 0;

    const referencePos = this.isRefreshing ? this.refreshTargetPos : this.lastRefreshPos;
    const dx = playerPos.x - referencePos.x;
    const dy = playerPos.y - referencePos.y;
    const dz = playerPos.z - referencePos.z;
    const moveDistSq = dx * dx + dz * dz;
    if (moveDistSq > this.refreshDistanceSq || Math.abs(dy) > this.verticalRefreshDistance) {
      this._startBatchedRefresh(playerPos);
    }
  }

  /** 释放资源 */
  dispose() {
    this.scene.remove(this.lines);
    this.geometry.dispose();
    this.material.dispose();
    this.lines = null;
  }
}
