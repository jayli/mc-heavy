// src/render/fireball-renderer.js — 飞龙火球渲染（v2.44，v2.45 改「燃烧的火球」）
//
// 与 `projectile-renderer.js` 同手法（差集驱动 slot + 零实例 visible=false），但**刻意独立**：
// 火球是球体（弹丸是圆柱）、火焰色（弹丸是灰白）、type 是 `fireball`（弹丸是 `projectile`）。
// 共用一个渲染器会让「火球被画成曳光弹」—— 两个 `sync` 都按 type 过滤，type 不同就互相看不见。
//
// ## v2.45 燃烧外观（用户：「要像一个燃烧的火球」）
//
// 两层叠加（与 TNT 爆炸「球体 + 序列帧」两层同思路）：
//   ① **亮核**：炽橙色球体（`MeshBasicMaterial`，unlit —— 火是自发光，不吃场景灯光）；
//   ② **发光光晕**：additive 混合的径向渐变 billboard（第二个 InstancedMesh，平面几何 +
//      相机四元数朝向），比核心大 ~3.4 倍 —— 读起来是「一团在烧的火」而不是「一个橙球」。
// 光晕尺度按时间 ±15% 脉动（相位按 slot 错开）→ 火焰的「跳动」感。
//
// ⚠️ **光晕用 InstancedMesh 而不是 N 个 Sprite**：16 个 Sprite = 16 个 draw call，
// 而 InstancedMesh 恒 1 个。billboard 靠 `sync` 时把**相机四元数**写进实例矩阵实现
// （调用方传 `camera.quaternion`；缺省单位四元数 = 面向 +Z，fixture 的相机正好朝 −Z 看）。
//
// ⚠️ 无活跃火球时两个 mesh 都 `visible=false`（否则恒增 draw call —— M6 实测教训）。
// ⚠️ 光晕贴图是**运行时 canvas 径向渐变**（矿车车斗纹理同先例：纯程序化、无离线烘焙
// ⇒ 无指纹门禁，观感回归靠 Tier 4 像素实测兜底）。
import * as THREE from 'three';
import { FIREBALL, FIREBALL_TYPE } from '../entities/dragons/dragon-config.js';

const _matrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _quat = new THREE.Quaternion();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 亮核颜色（炽橙）。
 *
 * ⚠️ **v2.45 从 v2.44 的 `0xff6a00` 调亮**：用户要「发光的样子」。纯橙在亮天空下读起来
 * 像塑料球；调亮到炽橙后 + 光晕层，读起来是「燃烧」。仍保持 R > G > B（Tier 4 的
 * 火焰色判据按此写）。改这个值必须重跑 `tests/fireball-render.spec.mjs`。
 */
export const FIREBALL_CORE_COLOR = 0xffb340;

/** 光晕相对核心的直径倍数（3.4 倍：够「发光」又不糊成一团） */
export const FIREBALL_HALO_SCALE = 3.4;

/** 脉动参数：幅度 ±15%、频率 6Hz（火焰跳动；相位按 slot 错开避免同步闪） */
export const FIREBALL_PULSE_AMP = 0.15;
export const FIREBALL_PULSE_HZ = 6;

/**
 * 生成光晕贴图（径向渐变：白热中心 → 橙 → 透明边缘）。
 *
 * ⚠️ **主线程专用**（canvas 2D）—— 本文件归属 `render/`，不在同构目录，无 Worker 消费。
 * 渐变停靠点是观感标定值（实玩可调）：中心留一点白热（火烧得最旺的地方），
 * 0.3 处转橙，边缘全透明 → additive 叠上去就是「光从中心透出来」。
 *
 * @param {number} [size=64] 贴图边长（64 足够：光晕是低频渐变，大尺寸无收益）
 * @returns {THREE.CanvasTexture}
 */
export function makeFireballHaloTexture(size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255, 244, 214, 1.0)');   // 白热中心
  g.addColorStop(0.3, 'rgba(255, 166, 64, 0.85)');   // 炽橙
  g.addColorStop(0.65, 'rgba(255, 96, 20, 0.32)');   // 暗橙外圈
  g.addColorStop(1.0, 'rgba(255, 60, 0, 0.0)');      // 透明边缘
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FireballRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, haloTexture?: THREE.Texture|null}} deps
   *        ⚠️ 缺省容量**从 `FIREBALL.poolSize` 派生**（不是硬编码）—— 单测不传 maxActive 时
   *        钉的是这个值（照 ProjectileRenderer 从 TURRET.projectilePoolSize 派生）。
   *        `haloTexture` 可注入（单测传假纹理免 canvas）；缺省内部生成。
   */
  constructor({ scene, maxActive = FIREBALL.poolSize, haloTexture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;

    // ---- ① 亮核（炽橙球体）----
    const geometry = new THREE.SphereGeometry(FIREBALL.radius, 12, 8);
    const material = new THREE.MeshBasicMaterial({ color: FIREBALL_CORE_COLOR });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'fireball:pool';
    // 实例池的包围球按 slot 0 的零 scale 算 → 会被误剔除；火球须无条件提交（同弹丸池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;              // ⚠️ 无活跃火球时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);

    // ---- ② 发光光晕（additive billboard）----
    this._haloTexture = haloTexture || makeFireballHaloTexture();
    this._ownsHaloTexture = haloTexture === null;
    const haloGeometry = new THREE.PlaneGeometry(
      FIREBALL.radius * FIREBALL_HALO_SCALE, FIREBALL.radius * FIREBALL_HALO_SCALE);
    const haloMaterial = new THREE.MeshBasicMaterial({
      map: this._haloTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,   // 发光感（与爆炸序列帧同口径）
      depthWrite: false,                  // 光晕不写深度：不挡核心球、不互相挡
      side: THREE.DoubleSide,             // billboard 朝向万一翻转也不消失
    });
    this.haloMesh = new THREE.InstancedMesh(haloGeometry, haloMaterial, maxActive);
    this.haloMesh.name = 'fireball:halo-pool';
    this.haloMesh.frustumCulled = false;
    this.haloMesh.visible = false;
    // ⚠️ renderOrder 高于核心：光晕后画，additive 叠在核心之上（两者都 depthWrite=false 时
    // 顺序决定叠加结果；核心写深度、光晕不写，实际上核心先画即可，这里显式钉住口径）
    this.haloMesh.renderOrder = 1;
    for (let i = 0; i < maxActive; i++) this.haloMesh.setMatrixAt(i, _zero);
    this.haloMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.haloMesh);

    /** @type {Map<string, number>} entityId → slot（差集驱动，本层自己分配） */
    this._slots = new Map();
    this._nextSlot = 0;
    this._geometry = geometry;
    this._material = material;
    this._haloGeometry = haloGeometry;
    this._haloMaterial = haloMaterial;
  }

  /**
   * 与当前火球集合对齐：新实体分配 slot、已有实体更新矩阵、消失实体归还 slot。
   *
   * ⚠️ **球体不需要朝向**（各向同性），核心矩阵只含平移 + 单位旋转；**光晕是 billboard**，
   * 矩阵旋转 = 相机四元数（调用方传 `camera.quaternion`）—— 缺省单位四元数（面向 +Z）。
   *
   * @param {Iterable<{id: string, type: string, state: {position: number[]}}>} entities
   * @param {THREE.Quaternion|null} [cameraQuat] 相机朝向（billboard 用；缺省面向 +Z）
   * @param {number} [nowMs] `performance.now()` 基准（光晕脉动用；缺省 0 = 静态）
   */
  sync(entities, cameraQuat = null, nowMs = 0) {
    const billboard = cameraQuat || _quat;
    const tSec = Number.isFinite(nowMs) ? nowMs / 1000 : 0;
    const live = new Set();
    for (const entity of entities) {
      if (entity.type !== FIREBALL_TYPE) continue;
      live.add(entity.id);
      let slot = this._slots.get(entity.id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(entity.id, slot);
      }
      const { position } = entity.state;
      _pos.set(position[0], position[1], position[2]);
      // ① 核心：平移 + 单位旋转 + 原尺寸
      _scale.set(1, 1, 1);
      _matrix.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(slot, _matrix);
      // ② 光晕：billboard 朝向 + 脉动尺度（±15%，相位按 slot 错开 → 多火球不同步闪）
      const pulse = 1 + FIREBALL_PULSE_AMP
        * Math.sin(2 * Math.PI * FIREBALL_PULSE_HZ * tSec + slot * 1.7);
      _scale.set(pulse, pulse, pulse);
      _matrix.compose(_pos, billboard, _scale);
      this.haloMesh.setMatrixAt(slot, _matrix);
    }
    // 归还消失实体的 slot（三条回收路径自动覆盖 —— 见文件头注释）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      this.mesh.setMatrixAt(slot, _zero);
      this.haloMesh.setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.haloMesh.instanceMatrix.needsUpdate = true;
    const any = this._slots.size > 0;
    this.mesh.visible = any;      // ⚠️ 无火球时不提交渲染
    this.haloMesh.visible = any;
  }

  /** 只读 slot 数（测试钩子：验证三条回收路径都归还了 slot）。@returns {number} */
  slotCount() { return this._slots.size; }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.haloMesh);
    this._geometry.dispose();
    this._material.dispose();   // InstancedMesh.dispose 不释放材质
    this._haloGeometry.dispose();
    this._haloMaterial.dispose();
    if (this._ownsHaloTexture) this._haloTexture.dispose();
    this.mesh.dispose();
    this.haloMesh.dispose();
    this._slots.clear();
  }
}
