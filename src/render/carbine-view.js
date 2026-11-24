// src/render/carbine-view.js — KV-9 卡宾枪的第一人称视图模型与**动效**（主线程）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/game/weapon.js` 的 `update()`
// （rig 位置/旋转的九项叠加）与 `game/player.js` 的相机弹簧。
// **每一条曲线、每一个系数都逐字取自上游**，只把 ads（右键机瞄）那一端固定为 0
// —— 本仓右键是放方块，不做机瞄（用户没要求）。
//
// ## 三层结构（与上游同构）
//
//   camera
//     └ root（本类持有；切枪时挂/摘）
//         └ rig（每帧写位置/旋转 = 腰射基准 + 摆动 + 步态 + 后坐 + 换弹）
//             ├ gun / mag / armL / armR（四个 mesh，共用一个材质）
//             ├ reticle（holo 瞄准镜的环+点，自发光 quad）
//             ├ flash（枪口火光：星芒 + 两片十字 blade）
//             └ muzzle / port（两个空锚点，供 FX 取世界坐标）
//
// ⚠️ **弹匣与左臂必须是独立 mesh**：换弹时它们各自移动（上游 `mag.position` /
// `armL.position` 逐帧写）。合并成一个几何就没法动 —— 那是「换弹动作」的本体。
//
// ## 与上游的三处必要改写
//
// ① **材质**：上游是自定义 ShaderMaterial + `uVMProj`（把视图模型压到近裁剪面防穿墙）。
//    本仓走 `MeshStandardNodeMaterial` + 逐顶点 roughness/metalness（与既有三把 GLB 枪
//    同口径，吃场景双灯）。本仓相机 near=0.1、枪在 −0.31 ⇒ 不穿墙，不需要那套投影。
// ② **不做 ads/sprint 姿态**：本仓无这两态（右键放块、Shift 是飞行下降）。
//    上游 `lerp(a,b,ads)` 一律取 ads=0 端；`sprintK` 恒 0。
// ③ **sway 输入**：上游读 `input.dx/dy`（鼠标增量）。本仓 `Player` 不暴露鼠标增量，
//    故用**相机朝向的帧间差分**等价推算（yaw/pitch 变化率）—— 观感一致（枪跟着镜头滞后摆），
//    且不需要改 Player 的输入路径。
//
// ⚠️ **零贴图、零烘焙产物**：全部纯色盒/柱（上游也是）。
import * as THREE from 'three';
// ⚠️ 火光材质已提取到 `muzzle-flash-material.js`（士兵 Epic Task 7），
// 它用的 pow/cos/atan/exp 等 TSL 导入随函数一起搬走了 —— 本文件只留 reticle 与枪体所需。
import {
  Fn, float, vec3, vec4, uniform, attribute, varyingProperty,
  positionGeometry, uv, cameraProjectionMatrix, modelViewMatrix,
  abs, max, min, smoothstep, oneMinus, Discard, length,
} from 'three/tsl';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { CARBINE, carbineReloadPose } from '../player/weapons/carbine.js';
import {
  buildCarbineGun, buildCarbineMag, buildCarbineArms,
  CARBINE_ANCHORS, CARBINE_FLASH_QUADS, CARBINE_RETICLE_SIZE,
} from './carbine-geometry.js';
import { createMuzzleFlashMaterial } from './muzzle-flash-material.js';

/**
 * 动效参数（**上游原值**，冻结）。与玩法量分开：`CARBINE` 管弹匣/散布/后坐冲量，
 * 本表管「视图模型怎么摆」。两者都不写字面量到消费点。
 */
export const CARBINE_VIEW = Object.freeze({
  /** rig 基准位（上游 ads=0 端：`lerp(0.165,0,ads)` 等三项） */
  base: Object.freeze([0.165, -0.175, -0.31]),
  /** rig 基准旋转（上游 ads=0 端：0.03 / 0.075 / 0） */
  baseRot: Object.freeze([0.03, 0.075, 0]),
  /** 后坐位移系数（上游 `kick * 0.045`，沿 +z 后退） */
  kickZ: 0.045,
  /** 后坐俯仰系数（上游 `kickRot * 0.03`） */
  kickPitch: 0.03,
  /** 侧向抖动位移/滚转系数（上游 `kickSide * 0.002` / `* 0.012`） */
  kickSideX: 0.002,
  kickSideRoll: 0.012,
  /** 三个 kick 弹簧的衰减率（上游 `damp(kick,0,16,dt)` 等） */
  kickDamp: 16,
  kickRotDamp: 13,
  kickSideDamp: 12,
  /** sway 弹簧（上游 `swayV += (-dx*0.00022 - sway)*90*dt - swayV*14*dt`） */
  swayGain: 0.00022,
  swayStiff: 90,
  swayDamp: 14,
  swayClamp: 0.03,
  /** sway → rig 的放大（上游 `sway.y*1.6` / `sway.x*2.2` / `sway.x*-1.4`） */
  swayPitch: 1.6,
  swayYaw: 2.2,
  swayRoll: -1.4,
  /** 步态摆动（上游 `cos(ph)*0.012*amp` / `-|sin(ph)|*0.014*amp` / `sin(ph)*0.018*amp`） */
  bobX: 0.012,
  bobY: 0.014,
  bobRoll: 0.018,
  /** 待机呼吸（上游 `sin(idle*1.4)*0.0022` / `sin(idle*1.1)*0.003`） */
  idleY: 0.0022,
  idleYHz: 1.4,
  idlePitch: 0.003,
  idlePitchHz: 1.1,
  /** 举枪（上游 `raise` 从 1 damp 到 0，位移 `-raise*0.35`、俯仰 `-raise*0.7`） */
  raiseDamp: 6,
  raiseY: 0.35,
  raisePitch: 0.7,
  /** 换弹 → rig（上游 `rl*0.02 / -rl*0.07 / rl*0.45 / rl*0.25 / -rl*0.5`） */
  reloadX: 0.02,
  reloadY: -0.07,
  reloadPitch: 0.45,
  reloadYaw: 0.25,
  reloadRoll: -0.5,
  /** 换弹 → 弹匣（上游 `-magOut*0.3` y、`+magOut*0.03` z、`magOut*0.35` 俯仰） */
  magDropY: -0.3,
  magDropZ: 0.03,
  magTiltX: 0.35,
  /** 换弹 → 左臂（上游三项位移 + `magOut*0.5` 俯仰 + rack 两项） */
  armMagX: 0.02,
  armMagY: -0.26,
  armMagZ: 0.18,
  armMagPitch: 0.5,
  armRackX: -0.01,
  armRackY: 0.04,
  armRackZ: 0.2,
  /** 枪口火光随机缩放（上游 `0.75 + random*0.6`） */
  flashScaleMin: 0.75,
  flashScaleRange: 0.6,
  /** reticle 亮度（上游 `0.35 + 0.65*ads`，ads=0 ⇒ 0.35） */
  reticleGain: 0.35,
  /** 火光在 ads=0 时的功率系数（上游 `1 - ads*0.45` ⇒ 1） */
  flashGain: 1.0,
});

/** 帧率无关的指数逼近（上游 `damp(cur,target,lambda,dt)`） */
function damp(cur, target, lambda, dt) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

/**
 * 视图模型材质：逐顶点色 + 逐顶点 roughness/metalness + 自发光标记。
 *
 * ⚠️ **必须吃场景灯光**（`lights: true`）：枪是金属件，metalness=1 时 diffuse 为 0、
 * 全靠镜面反射 —— 无灯则纯黑（既有三把 GLB 枪的同一条教训，见 game.js 的双灯注释）。
 * ⚠️ ** roughness/metalness 走逐顶点属性而不是材质常量**：枪体有金属/聚合物/手套/布料
 * 四类表面，用单一常量会让整把枪一个质感（上游是逐部件 aMat）。
 */
function makeCarbineMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const surf = attribute('aSurf', 'vec2');
  const glow = attribute('aGlow', 'float');
  mat.colorNode = vec4(attribute('color', 'vec3'), 1);
  mat.roughnessNode = surf.x;
  mat.metalnessNode = surf.y;
  // 自发光：战术灯窗（e=1.2）与弹匣橙条（e=0.4）。上游是 aMat.z 乘基色。
  // ⚠️ 显式拆分量（`vec3(Color)` 在 WebGPU 静默输出黑，本仓已记的教训）。
  mat.emissiveNode = vec3(1, 1, 1).mul(attribute('color', 'vec3')).mul(glow).mul(8.0);
  mat.side = THREE.FrontSide;
  // ⚠️ 视图模型不吃雾（挂在相机上，距离恒 0.3；吃雾会随视距档变色）
  mat.fog = false;
  return mat;
}

/**
 * holo reticle 材质（上游 `RETICLE_FRAG` 逐字：环 + 中心点 + 四向刻度）。
 * ⚠️ 同样在片元算径向（4 顶点 quad 的教训）。
 */
function makeReticleMaterial() {
  const U = { uGain: uniform(CARBINE_VIEW.reticleGain) };
  const vUv = varyingProperty('vec2', 'vCarbRetUv');
  const vertex = Fn(() => {
    // ⚠️ 同火光：必须用 uv()（PlaneGeometry 的 position.xy 是真实尺寸 ±0.018，
    // ×2 后只到 ±0.036 ⇒ 环/刻度的 r 阈值 0.42/0.62 永远达不到 ⇒ 只剩中心一个点）。
    vUv.assign(uv().mul(2).sub(1));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(positionGeometry, 1)));
  });
  const color = Fn(() => {
    const r = length(vUv);
    const ring = oneMinus(smoothstep(float(0.0), float(0.045), abs(r.sub(0.42))));
    const dot_ = oneMinus(smoothstep(float(0.02), float(0.07), r));
    const cross = oneMinus(smoothstep(float(0.0), float(0.035), min(abs(vUv.x), abs(vUv.y))));
    const ticks = cross.mul(smoothstep(float(0.40), float(0.42), r))
      .mul(oneMinus(smoothstep(float(0.62), float(0.64), r)));
    const a = ring.mul(0.8).add(dot_).add(ticks.mul(0.8)).mul(U.uGain);
    Discard(a.lessThanEqual(0.004));
    // 上游还叠了一层极暗的青底（`vec3(0.02,0.05,0.06)*(1-r*0.5)`）——保留
    const base = vec3(0.02, 0.05, 0.06).mul(max(float(0), float(1).sub(r.mul(0.5))));
    // ⚠️ alpha = a（同火光的理由：亮背景上 additive + HDR 必钳白）
    return vec4(vec3(1.0, 0.16, 0.08).mul(a).mul(5.0).add(base), a);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  mat.transparent = true;
  mat.blending = THREE.NormalBlending;
  mat.depthWrite = false;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  mat.lights = false;
  mat.toneMapped = false;
  return { material: mat, uniforms: U };
}

export class CarbineView {
  /**
   * @param {{camera: THREE.PerspectiveCamera, sunDirection?: object}} deps
   *   `sunDirection` 复用体素材质的 uniform 实例（红线 1；缺省不接，枪仍吃场景双灯）
   */
  constructor({ camera }) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'carbine-root';
    this.rig = new THREE.Group();
    this.root.add(this.rig);

    this.material = makeCarbineMaterial();
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, this.material);
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      return m;
    };
    this.gun = mk(buildCarbineGun());
    this.mag = mk(buildCarbineMag());
    this.mag.position.set(...CARBINE_ANCHORS.mag);
    const arms = buildCarbineArms();
    this.armL = mk(arms.left);
    this.armR = mk(arms.right);
    this.rig.add(this.gun, this.mag, this.armL, this.armR);
    this._geometries = [this.gun.geometry, this.mag.geometry, this.armL.geometry, this.armR.geometry];

    // holo reticle
    const ret = makeReticleMaterial();
    this.reticleMaterial = ret.material;
    this.reticleUniforms = ret.uniforms;
    this.reticle = new THREE.Mesh(
      new THREE.PlaneGeometry(CARBINE_RETICLE_SIZE[0], CARBINE_RETICLE_SIZE[1]), ret.material);
    this.reticle.position.set(...CARBINE_ANCHORS.reticle);
    this.reticle.frustumCulled = false;
    this.reticle.renderOrder = 30;
    this.rig.add(this.reticle);
    this._geometries.push(this.reticle.geometry);

    // 枪口火光：星芒 + 两片沿枪管的十字 blade（上游三片）
    const fl = createMuzzleFlashMaterial();
    this.flashMaterial = fl.material;
    this.flashUniforms = fl.uniforms;
    this.flash = new THREE.Group();
    this.flash.position.set(...CARBINE_ANCHORS.flash);
    const star = new THREE.Mesh(
      new THREE.PlaneGeometry(CARBINE_FLASH_QUADS.star[0], CARBINE_FLASH_QUADS.star[1]), fl.material);
    const b1 = new THREE.Mesh(
      new THREE.PlaneGeometry(CARBINE_FLASH_QUADS.blade[0], CARBINE_FLASH_QUADS.blade[1]), fl.material);
    b1.rotation.set(-Math.PI / 2, 0, 0);
    b1.position.z = CARBINE_FLASH_QUADS.bladeOffsetZ;
    const b2 = new THREE.Mesh(b1.geometry, fl.material);
    b2.rotation.set(-Math.PI / 2, Math.PI / 2, 0);
    b2.position.z = CARBINE_FLASH_QUADS.bladeOffsetZ;
    for (const m of [star, b1, b2]) {
      m.frustumCulled = false;
      m.renderOrder = 31;
      this.flash.add(m);
    }
    this._geometries.push(star.geometry, b1.geometry);
    this.flash.visible = false;
    this.rig.add(this.flash);

    // 两个空锚点（FX 取世界坐标；自身不产生 draw call）
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(...CARBINE_ANCHORS.muzzle);
    this.rig.add(this.muzzle);
    this.port = new THREE.Object3D();
    this.port.position.set(...CARBINE_ANCHORS.port);
    this.rig.add(this.port);

    // ---- 动效状态（上游同名字段）----
    this.kick = 0;
    this.kickRot = 0;
    this.kickSide = 0;
    this.flashT = 0;
    this.raise = 1;
    this.sway = new THREE.Vector2();
    this.swayV = new THREE.Vector2();
    this._prevYaw = null;
    this._prevPitch = null;
    this._idle = 0;
    this._mounted = false;
    /**
     * ⚠️⚠️ **两个锚点各用自己的 scratch，绝不共用**（本轮用户实玩报告的根因）：
     * 旧实现 `muzzleWorld(out = this._v)` 与 `portWorld(out = this._v)` 共用同一个
     * Vector3，而调用方写的是：
     *   `const mw = view.muzzleWorld(); const pw = view.portWorld();`
     *   `fx.spawnFromEffect({ muzzle: [mw.x,…], port: [pw.x,…] })`
     * ⇒ 对象字面量在**两次调用之后**才求值 ⇒ `mw` 已被 port 覆写
     * ⇒ **曳光从抛壳口射出**（实测偏移 +0.09x / +0.68z，屏幕上向右下偏几百像素）。
     * 拆成两个独立 scratch 后，即使调用方保持原写法也不会互相覆写。
     */
    this._vMuzzle = new THREE.Vector3();
    this._vPort = new THREE.Vector3();
  }

  /**
   * 挂到相机（选中 KV-9 时）。幂等。
   *
   * ⚠️ **必须当场写一次基准姿态**（本轮浏览器实测）：只置 `_mounted=true` 而不写
   * rig 位置时，rig 停在 Group 的默认 (0,0,0) ⇒ **枪横在屏幕正中心**（而不是右下）。
   * 帧循环下一帧就会纠回，但玩家切枪那一帧看得到，且任何「切枪后立即量位置」
   * 的判据都会读到 0（静默失效）。
   */
  mount() {
    if (this._mounted) return;
    this.camera.add(this.root);
    this._mounted = true;
    this.raise = 1;          // 重播举枪
    this.kick = this.kickRot = this.kickSide = 0;
    this.flashT = 0;
    this.flash.visible = false;
    this._prevYaw = this._prevPitch = null;
    this.sway.set(0, 0);
    this.swayV.set(0, 0);
    // 当场写一次姿态（raise=1 ⇒ 枪在下方待举起，与上游切枪同口径）
    this.update(0, { reloadT: -1 });
  }

  /** 从相机摘下（切枪时）。幂等；不 dispose 共享几何。 */
  unmount() {
    if (!this._mounted) return;
    this.camera.remove(this.root);
    this._mounted = false;
  }

  get mounted() { return this._mounted; }

  /**
   * 开火：累积三个 kick 弹簧 + 点亮火光（上游 `fire()` 的 feel 段逐字）。
   * @param {() => number} [rand]
   */
  onShot(rand = Math.random) {
    this.flashT = CARBINE.flashSeconds;
    this.flashUniforms.uSeed.value = rand();
    this.flash.rotation.z = rand() * 6.28;
    this.flash.scale.setScalar(CARBINE_VIEW.flashScaleMin + rand() * CARBINE_VIEW.flashScaleRange);
    this.kick = Math.min(this.kick + 1, CARBINE.kickMax);
    this.kickRot += 1;
    this.kickSide += (rand() - 0.5) * 2;
    /**
     * ⚠️⚠️ **当场点亮**（本轮浏览器实测）：只置 `flashT` 而等下一帧 `update()`
     * 才写 `visible` 时，若两帧间隔 > 45ms（低帧率/后台标签页）fireT 已减成负
     * ⇒ **火光一帧也不上屏**，而 kick/曳光/弹壳全对（静默失效）。
     * 功率也当场写满，下一帧 update 再按剩余寿命衰减。
     */
    this.flash.visible = true;
    this.flashUniforms.uPower.value = CARBINE_VIEW.flashGain;
  }

  /**
   * 每帧推进。
   *
   * @param {number} dt 秒
   * @param {{reloadT:number, bobPhase?:number, bobAmp?:number,
   *          yaw?:number, pitch?:number}} state
   *   `reloadT` = 弹匣的换弹秒数（−1 = 未换弹）；**唯一权威是 CarbineMagazine**，
   *   本类只读它算三条曲线，不自己计时（红线 1）。
   */
  update(dt, state = {}) {
    if (!this._mounted) return;
    const V = CARBINE_VIEW;
    this._idle += dt;
    // ---- 三个 kick 弹簧衰减（上游 damp）----
    this.kick = damp(this.kick, 0, V.kickDamp, dt);
    this.kickRot = damp(this.kickRot, 0, V.kickRotDamp, dt);
    this.kickSide = damp(this.kickSide, 0, V.kickSideDamp, dt);
    this.raise = damp(this.raise, 0, V.raiseDamp, dt);

    // ---- sway：镜头转动的滞后摆动 ----
    // 上游读鼠标增量 dx/dy；本仓用相机朝向的帧间差分等价推算（见文件头改写③）。
    // ⚠️ 首帧无基线 ⇒ 增量 0（不产生一次突跳）。
    let dx = 0;
    let dy = 0;
    if (Number.isFinite(state.yaw) && Number.isFinite(state.pitch)) {
      if (this._prevYaw !== null) {
        // yaw 差分要处理 ±π 环绕（否则转过头时枪会猛甩一下）
        let d = state.yaw - this._prevYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        dx = d;
        dy = state.pitch - this._prevPitch;
      }
      this._prevYaw = state.yaw;
      this._prevPitch = state.pitch;
    }
    // 上游的 dx 是像素增量、系数 0.00022；本仓 dx 是弧度 ⇒ 换算到同一量级：
    // 上游 sens ≈ 0.0022 rad/px ⇒ 1 rad ≈ 455 px ⇒ 系数 × 455。
    const SWAY_RAD_TO_PX = 1 / 0.0022;
    this.swayV.x += (-dx * SWAY_RAD_TO_PX * V.swayGain - this.sway.x) * V.swayStiff * dt - this.swayV.x * V.swayDamp * dt;
    this.swayV.y += (dy * SWAY_RAD_TO_PX * V.swayGain - this.sway.y) * V.swayStiff * dt - this.swayV.y * V.swayDamp * dt;
    this.sway.addScaledVector(this.swayV, dt);
    this.sway.x = Math.max(-V.swayClamp, Math.min(V.swayClamp, this.sway.x));
    this.sway.y = Math.max(-V.swayClamp, Math.min(V.swayClamp, this.sway.y));

    // ---- 换弹三条曲线（纯函数，唯一权威在 carbine.js）----
    const pose = carbineReloadPose(state.reloadT ?? -1);
    const rl = pose.rig;
    const magOut = pose.magOut;
    const rack = pose.rack;

    // ---- 步态（上游 bobPhase / bobAmp；本仓由 ViewBob 的距离驱动相位换算）----
    const ph = state.bobPhase ?? 0;
    const amp = state.bobAmp ?? 0;
    const idle = this._idle;

    this.rig.position.set(
      V.base[0] + this.sway.x + Math.cos(ph) * V.bobX * amp + rl * V.reloadX + this.kickSide * V.kickSideX,
      V.base[1] + this.sway.y - Math.abs(Math.sin(ph)) * V.bobY * amp
        + Math.sin(idle * V.idleYHz) * V.idleY + rl * V.reloadY - this.raise * V.raiseY,
      V.base[2] + this.kick * V.kickZ,
    );
    this.rig.rotation.set(
      V.baseRot[0] + this.kickRot * V.kickPitch + this.sway.y * V.swayPitch
        + rl * V.reloadPitch + Math.sin(idle * V.idlePitchHz) * V.idlePitch - this.raise * V.raisePitch,
      V.baseRot[1] + this.sway.x * V.swayYaw + rl * V.reloadYaw,
      this.sway.x * V.swayRoll + Math.sin(ph) * V.bobRoll * amp + rl * V.reloadRoll
        + this.kickSide * V.kickSideRoll,
    );

    // ---- 弹匣脱出/插回（换弹动作的本体）----
    this.mag.position.set(
      CARBINE_ANCHORS.mag[0],
      CARBINE_ANCHORS.mag[1] + magOut * V.magDropY,
      CARBINE_ANCHORS.mag[2] + magOut * V.magDropZ,
    );
    this.mag.rotation.x = magOut * V.magTiltX;
    // 上游：`magOut < 0.98 || reloadT < 0` —— 脱到底那一小段藏起来（读作「旧匣已扔掉」）
    this.mag.visible = pose.magVisible;

    // ---- 左臂：跟着弹匣下去、拉机柄时向后拉 ----
    this.armL.position.set(
      magOut * V.armMagX + rack * V.armRackX,
      magOut * V.armMagY + rack * V.armRackY,
      magOut * V.armMagZ + rack * V.armRackZ,
    );
    this.armL.rotation.x = magOut * V.armMagPitch;

    // ---- 火光 ----
    this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.flashUniforms.uPower.value = Math.max(0, Math.min(1, this.flashT / CARBINE.flashSeconds))
      * V.flashGain;
  }

  /**
   * 枪口世界坐标（曳光起点 / 火光位置）。零分配。
   * ⚠️ 默认 scratch 与 `portWorld` **分开**（见构造器里的根因注释）。
   */
  muzzleWorld(out = this._vMuzzle) {
    this.muzzle.getWorldPosition(out);
    return out;
  }

  /** 抛壳口世界坐标（弹壳出生点）。零分配。⚠️ scratch 与 muzzleWorld 分开。 */
  portWorld(out = this._vPort) {
    this.port.getWorldPosition(out);
    return out;
  }

  /** 只读快照（测试 / HUD） */
  get state() {
    return {
      mounted: this._mounted,
      kick: this.kick,
      flashVisible: this.flash.visible,
      magVisible: this.mag.visible,
      magY: this.mag.position.y,
      armLY: this.armL.position.y,
      rigZ: this.rig.position.z,
    };
  }

  /** 释放全部几何与材质（游戏退出 / 热重载）。 */
  dispose() {
    this.unmount();
    for (const g of this._geometries) g.dispose();
    this._geometries.length = 0;
    this.material.dispose();
    this.flashMaterial.dispose();
    this.reticleMaterial.dispose();
  }
}

/** 该武器 id 是否走 KV-9 视图模型（装配层与单测共用判据） */
export function isCarbineWeapon(id) {
  return id === WEAPON_IDS.CARBINE && !!WEAPONS[id]?.carbine;
}