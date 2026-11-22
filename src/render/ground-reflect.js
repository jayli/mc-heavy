// src/render/ground-reflect.js — 湿地面的**独立平面反射**（镜面 = 玩家脚下地面）
//
// 上游：`bj-shooting-game/night-heron-src/src/gfx/renderer.js` 的 planar reflection
// （`reflCam` 关于 y=0 镜像 + `uReflMatrix = bias·proj·view`）。
// 本仓地面是起伏体素 ⇒ 镜面必须跟着玩家脚下的地面高度（见 config 文件头的几何取证）。
//
// ## 三条载荷性约束（每条都是本仓已实测的教训）
//
// ① **必须在主 render 之前手动跑**：reflector 自动触发会在 transparent 队列末尾跑，
//    而 BatchedMesh 的 instance 索引走 `_indirectTexture`（GPU 纹理）、一帧内最后一次
//    写入胜出 ⇒ 主 pass 读到反射相机的索引表 ⇒ **天空整片撕成黑多边形**（v3.17 实测）。
//    ⇒ `updateBeforeType = NONE` + 由 Game 手动调。
// ② **两条 reflector pass 不能同帧交错**：本 pass 与水面 pass 各自跑完再跑下一条，
//    每条都套 multi-draw 守卫（`render-world.js` 的 `_installShadowListGuard` 同款手法）。
// ③ **反射期间藏掉第一人称物件 / 各特效池 / 水面平面**：前两者是镜像相机下的
//    巨大手臂/枪；水面平面会让地面映出水面（互反射亮斑）。
//
// ⚠️ **本 pass 只在雨天光影档开启时跑**（关闭 ⇒ 零成本）。
import * as THREE from 'three';
import { reflector, uniform } from 'three/tsl';
import {
  GROUND_REFLECT_SCALE, GROUND_REFLECT_MIP, GROUND_MIRROR_LIFT,
} from './ground-reflect-config.js';

/** NDC → uv 的 bias（y 行取负：RT 的 flipY 语义，同 ocean 的 reflectMatrix） */
const BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, -0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

/**
 * pass 期间的 1×1 占位图（懒建、全局共享）。
 * ⚠️ 必须是真实 Texture（不是 null）：节点采样 null 会报绑定错误。
 */
let _placeholder = null;
function placeholderTexture() {
  if (!_placeholder) {
    _placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    _placeholder.colorSpace = THREE.NoColorSpace;
    _placeholder.needsUpdate = true;
  }
  return _placeholder;
}

/**
 * 建地面反射。
 *
 * @param {{scene: THREE.Scene}} deps
 * @returns {object} 句柄集合（见返回字段注释）
 */
export function setupGroundReflect({ scene }) {
  const node = reflector({
    resolutionScale: GROUND_REFLECT_SCALE,
    bounces: false,
    generateMipmaps: true,
  });
  /**
   * 镜面目标：一个空 Object3D，**每帧被放到玩家脚下地面高度**。
   * ⚠️ 必须入场景图，否则 matrixWorld 不更新 ⇒ 镜面位置错（ocean 同一条教训）。
   * ⚠️ 它的朝向必须是 **+Z 朝上**（reflector 用 target 的局部 +Z 作镜面法线）
   * ⇒ 绕 X 转 −90°（与 ocean 的水面平面 `rotation.x = −π/2` 同口径）。
   */
  const target = node.target;
  target.rotation.x = -Math.PI / 2;
  scene.add(target);

  const base = node.reflector;
  const update = base.updateBefore.bind(base);
  base.updateBeforeType = THREE.NodeUpdateType.NONE;
  base.updateBefore = () => {};

  /**
   * 采样节点（湿地面用）—— **必须是 clone，不能用 node 本身**。
   *
   * ⚠️⚠️ **本轮实测的根因**：`base.textureNode === node`（同一个对象），
   * 而 reflector 内部 `update()` 会把 `base.textureNode.value` 写成真 RT
   * ⇒ pass 前设的占位图**立即被覆写** ⇒ 同一 pass 里读写同一张 RT
   * ⇒ WebGPU 验证错误 ⇒ **整个 CommandBuffer 作废 ⇒ 全屏黑**。
   * clone 与 base 共享同一条 pass / 同一张 RT，但 **value 独立**
   * ⇒ pass 期间可安全地把 clone 换成占位图，pass 后再指回真 RT。
   * （与 ocean.js 的 reflectTexture 同一条教训。）
   */
  const sampleNode = node.clone();
  sampleNode.levelNode = uniform(GROUND_REFLECT_MIP);

  /** 镜面投影矩阵（湿地面采样坐标的唯一权威） */
  const matrix = { value: new THREE.Matrix4() };

  return {
    target,
    /** 采样纹理节点（交给体素材质） */
    texture: sampleNode,
    /** 镜面投影矩阵 uniform */
    matrix,
    /** base 节点（管 pass 调度与虚拟相机） */
    base,
    /** 当前镜面高度（诊断） */
    mirrorY: null,
    /** 实际刷新次数（诊断） */
    refreshes: 0,

    /** 注入 renderer（pass 需要它） */
    setRenderer(renderer) { this._renderer = renderer; },

    /**
     * 把矩阵写入目标 uniform（装配层传湿分支的 uWetReflMatrix）。
     * ⚠️ WET_UNIFORMS 是 Object.freeze ⇒ 不能替换成员，只能让本模块往它的 value 里写。
     */
    setMatrixTarget(u) { this._matrixTarget = u || null; },

    /** 把镜面放到指定高度（装配层每帧写；null ⇒ 本帧不跑） */
    setMirrorY(y) {
      this.mirrorY = y;
      if (y === null || !Number.isFinite(y)) return false;
      target.position.set(0, y + GROUND_MIRROR_LIFT, 0);
      target.updateMatrixWorld(true);
      return true;
    },

    /**
     * 跑一次地面反射 pass。**只能由 Game 在主 render 之前调**。
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Object3D[]} hidden 反射期间需隐身的节点（第一人称/特效池/水面）
     * @param {THREE.Material} ownMaterial 本 pass 自己的材质（reflector 内部要临时隐它）
     *   ⚠️ 地面反射**没有自己的 mesh**（地面就是体素）⇒ 传一个占位材质即可；
     *   reflector 只用它做 `material.visible = false/true`，不影响体素通道。
     */
    render(camera, hidden, ownMaterial) {
      if (this.mirrorY === null) return false;
      let restored = null;
      if (hidden?.length) {
        restored = [];
        for (const o of hidden) {
          if (!o) continue;
          restored.push([o, o.visible]);
          o.visible = false;
        }
      }
      /**
       * ⚠️⚠️ **pass 期间把自己的采样源换成占位图**（与 ocean 同一条约束）：
       * 本 pass 把 RT 当渲染目标（写），而体素 opaque 的湿分支在同一 pass 里
       * 采样它（读）⇒ WebGPU 报 `writable usage and another usage in the same
       * synchronization scope` ⇒ **整个 CommandBuffer 作废 ⇒ 全屏黑**。
       * ⚠️ 不能用「藏掉 opaque 通道」代替：那会让反射里看不到地面（倒影全黑）。
       */
      const savedTex = sampleNode.value;
      sampleNode.value = placeholderTexture();
      try {
        update({ scene, camera, renderer: this._renderer, material: ownMaterial });
        this.refreshes++;
        // 写镜面投影矩阵（湿地面采样坐标）
        const vc = base.virtualCameras?.get?.(camera);
        if (vc) {
          matrix.value.copy(BIAS).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
          // 同步到湿分支的 uniform（拷内容，不替换对象 —— WET_UNIFORMS 是 frozen）
          if (this._matrixTarget?.value) this._matrixTarget.value.copy(matrix.value);
        }
        return true;
      } finally {
        /**
         * ⚠️ pass 后必须指向**真 RT**：reflector 内部只写 `base.textureNode.value`，
         * 而本节点是独立的（uvNode/levelNode 自己一份）⇒ 不同步就永远停在占位图。
         */
        const real = base.textureNode?.value;
        sampleNode.value = real || savedTex;
        if (restored) for (const [o, v] of restored) o.visible = v;
      }
    },

    dispose() {
      scene.remove(target);
      node.dispose();
    },
  };
}

/** 占位材质（地面反射没有自己的 mesh；reflector 只需要一个可切 visible 的对象） */
export function createGroundReflectPlaceholderMaterial() {
  const m = new THREE.MeshBasicMaterial();
  m.visible = true;
  return m;
}