// src/render/muzzle-flash-material.js — 枪口火光材质（KV-9 与士兵**共用一份**）
//
// **本文件是从 `carbine-view.js` 提取出来的**（士兵 Epic Task 7），不是新写的 shader。
// 提取理由：士兵开火也要枪口火光，两侧各写一份会漂移出「士兵的火光是方块而玩家的不是」
// —— 那正是 v3.30b 修过的缺陷（`uv()*2-1` / NormalBlending / alpha=gain 三条实测标定）。
//
// ⚠️ **参数一个不许改**：下面每一条 ⚠️ 都对应一次真实像素实测的推翻。
// ⚠️ **varying 名 `vCarbFlashUv` 保持原样**：改名无害但会让既有调试探针与文档对不上号。
import * as THREE from 'three';
import {
  Fn, float, vec3, vec4, uniform, varyingProperty,
  positionGeometry, uv, cameraProjectionMatrix, modelViewMatrix,
  abs, pow, cos, atan, exp, smoothstep, oneMinus, Discard, length,
} from 'three/tsl';

/**
 * 枪口火光材质（上游 `FLASH_FRAG` 逐字移植成 TSL）。
 *
 * 形状 = 径向核 + 角向尖刺：
 *   spikes = |cos(a*2.5 + seed*6)|^10 + 0.6*|cos(a*3.5 − seed*9)|^6
 *   core   = exp(−r²*9)
 *   flare  = exp(−r*4.5) * (0.35 + spikes)
 *   col    = 橙 * flare * 5 + 暖白 * core * 7，再乘 power 与边缘 smoothstep
 *
 * ⚠️⚠️ **径向量必须在片元算**（本仓已记的 TSL 教训）：PlaneGeometry 只有 4 个顶点，
 * 顶点算 length 插值后恒为常数 ⇒ 整片 quad 一起亮再整片消失。故用 varying 传 uv，
 * 在 colorNode（片元）里算 r 与 a。
 * ⚠️ **additive + depthTest:false**（上游同口径）：火光是自发光，不该被枪管挡住。
 */
export function createMuzzleFlashMaterial() {
  const U = {
    uSeed: uniform(0),
    uPower: uniform(0),
  };
  const vUv = varyingProperty('vec2', 'vCarbFlashUv');
  const vertex = Fn(() => {
    /**
     * ⚠️⚠️ **必须用 `uv()` 而不是 `positionGeometry.xy.mul(2)`**（本轮像素实测的根因）：
     * `PlaneGeometry(0.24, 0.24)` 的 position.xy ∈ **±0.12**（它是真实尺寸，不是单位 quad）
     * ⇒ ×2 后只到 ±0.24 ⇒ `r = length(vUv) ≤ 0.34`，**永远到不了 0.7~1.0 的边缘门**
     * ⇒ `edge ≡ 1`、`core = exp(−r²·9) ≈ 0.9~1.0` 恒亮 ⇒ **整片 quad 满亮 = 白方块**。
     * 上游 `vUv = uv`（∈[0,1]）、片元里 `c = vUv*2−1`（∈±1）⇒ r 真正覆盖 0..1.41。
     * 实测对照（同机位只改这一个变量）：position×2 → fill 1.00 / warm 0；
     * uv×2−1 → fill 0.63 / warm 2342（星芒形状与暖色回来）。
     */
    vUv.assign(uv().mul(2).sub(1));
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(positionGeometry, 1)));
  });
  const color = Fn(() => {
    const r = length(vUv);
    const a = atan(vUv.y, vUv.x);
    const spikes = pow(abs(cos(a.mul(2.5).add(U.uSeed.mul(6.0)))), 10.0)
      .add(pow(abs(cos(a.mul(3.5).sub(U.uSeed.mul(9.0)))), 6.0).mul(0.6));
    const core = exp(r.mul(r).mul(9.0).negate());
    const flare = exp(r.mul(4.5).negate()).mul(spikes.add(0.35));
    const col = vec3(1.0, 0.55, 0.18).mul(flare).mul(5.0)
      .add(vec3(1.0, 0.9, 0.7).mul(core).mul(7.0));
    const edge = oneMinus(smoothstep(float(0.7), float(1.0), r));
    const gain = U.uPower.mul(edge);
    Discard(gain.lessThanEqual(0.002));
    /**
     * ⚠️⚠️ **alpha 必须 = gain，不能恒 1**（本轮像素实测的第二个根因）：
     * 上游是 **WebGL 夜景**（背景近黑）且 additive，故 `vec4(col*power, 1)` 成立。
     * 本仓是 **WebGPU + 正午亮天空（luma≈200）+ ACES**：
     *   · additive 下 `dst + src`，而 src 的 HDR 值（flare×5 + core×7）远大于 1
     *     ⇒ 任何背景上都被推到削顶 ⇒ **整片白**（实测 fill 1.00 / warm 0）；
     *   · 改 NormalBlending 但 alpha 恒 1 ⇒ 整片不透明覆盖，仍是白方块。
     * ⇒ **NormalBlending + alpha = gain**：边缘 gain→0 自然羽化（柔光），
     *   中心 col 仍 HDR 但经 ACES 滚落成暖白而不是硬白块。
     * 实测：additive+alpha1 → fill 1.00/warm 0；normal+alpha1 → fill 1.00/warm 0；
     *       normal+alpha=gain → fill 0.63/warm 2342。
     * 与本仓 fire-ring / cinder 尾巴的同一条教训（暖色 additive 在亮背景必钳白）。
     */
    return vec4(col.mul(gain), gain);
  });
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.vertexNode = vertex();
  mat.colorNode = color();
  mat.transparent = true;
  // ⚠️ NormalBlending（不是 additive）—— 理由见 colorNode 里的实测对照
  mat.blending = THREE.NormalBlending;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.side = THREE.DoubleSide;
  mat.fog = false;
  // ⚠️ 自发光粒子不吃场景灯（本仓其余粒子池全部 lights=false）
  mat.lights = false;
  mat.toneMapped = false;
  return { material: mat, uniforms: U };
}

