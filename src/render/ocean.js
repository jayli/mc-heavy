// src/render/ocean.js — 动画海面（M2-5，移植 mc-lite Engine.js 海面 TSL 材质）
// 800×800 平面跟随相机（无限水面）；波浪动画 + Blinn-Phong 高光 + Fresnel + 距离淡出 + 水域遮罩。
// 水面高度 = SEA_Y + 0.5（mc-lite WATER_LEVEL_OFFSET 语义）。
import * as THREE from 'three';
import {
  uniform, Fn, float, vec3, sin, cos, max, pow, dot, normalize, length,
  smoothstep, mix, positionWorld, cameraPosition, Discard,
} from 'three/tsl';

export const WATER_LEVEL_OFFSET = -1.5; // SEA_Y + 0.5
const WATER_COLOR = 0x588be4;
const WATER_OPACITY = 0.7;
const WATER_VISIBLE_DISTANCE = 80;
const WATER_EDGE_FADE_BAND = 15;
const WATER_FOG_COLOR = 0xa7d1e2;

/**
 * 创建海面并挂到场景。
 * @param {THREE.Scene} scene
 * @returns {{update: (camera: THREE.Camera, dt: number) => void, plane: THREE.Mesh}}
 */
export function setupOcean(scene) {
  const waterGeo = new THREE.PlaneGeometry(800, 800);

  const uTime = uniform(0.0);
  const uColor = uniform(new THREE.Color(WATER_COLOR));
  const uSunDirection = uniform(new THREE.Vector3(0, 0.8, 0.6).normalize());
  const uOpacity = uniform(WATER_OPACITY);
  const uSeed = uniform(0.0);
  const uFogColor = uniform(new THREE.Color(WATER_FOG_COLOR));
  const uFogNear = uniform(20.0);
  const uFogFar = uniform(70.0);

  const fadeStart = WATER_VISIBLE_DISTANCE - WATER_EDGE_FADE_BAND;
  const fadeEnd = WATER_VISIBLE_DISTANCE;

  // 水面遮罩用的地形高度近似（与 mc-lite 着色器版噪声一致：0.08×2 + 0.02×6）
  const getTerrainHeight = (x, z) => {
    const nx = x.add(uSeed);
    const nz = z.add(uSeed);
    return sin(nx.mul(0.08)).mul(2.0)
      .add(cos(nz.mul(0.08)).mul(2.0))
      .add(sin(nx.mul(0.02)).mul(6.0))
      .add(cos(nz.mul(0.02)).mul(6.0));
  };

  const colorNode = Fn(() => {
    const pos = positionWorld.xz;
    const dist = length(pos.sub(cameraPosition.xz));
    const waterFade = float(1.0).sub(smoothstep(float(fadeStart), float(fadeEnd), dist));

    // 远距离淡出裁剪
    Discard(waterFade.lessThanEqual(0.001));

    // 水域遮罩：近处仅在地形低于海平面附近显示，远处全显示
    const h0 = getTerrainHeight(pos.x, pos.y);
    const offsetVal = float(3.5);
    const h1 = getTerrainHeight(pos.x.add(offsetVal), pos.y);
    const h2 = getTerrainHeight(pos.x.sub(offsetVal), pos.y);
    const h3 = getTerrainHeight(pos.x, pos.y.add(offsetVal));
    const h4 = getTerrainHeight(pos.x, pos.y.sub(offsetVal));
    const threshold = float(-0.8);
    const nearOceanMask = max(
      max(
        max(
          max(
            float(1.0).sub(smoothstep(threshold.sub(0.01), threshold, h0)),
            float(1.0).sub(smoothstep(threshold.sub(0.01), threshold, h1)),
          ),
          float(1.0).sub(smoothstep(threshold.sub(0.01), threshold, h2)),
        ),
        float(1.0).sub(smoothstep(threshold.sub(0.01), threshold, h3)),
      ),
      float(1.0).sub(smoothstep(threshold.sub(0.01), threshold, h4)),
    );
    const inRangeMask = smoothstep(float(100.0), float(99.0), dist);
    const oceanMask = mix(float(1.0), nearOceanMask, inRangeMask);
    Discard(oceanMask.lessThanEqual(0.001));

    // LOD：远距离减少波纹计算
    const detailMask = smoothstep(float(50.0), float(25.0), dist);

    // 基础 + 细节波纹
    let waves = sin(pos.x.mul(1.5).add(uTime.mul(5.5))).mul(0.1)
      .add(sin(pos.y.mul(1.3).sub(uTime.mul(3.2))).mul(0.1));
    waves = waves.add(
      sin(pos.x.mul(2.8).add(pos.y.mul(2.2)).add(uTime.mul(3.5))).mul(0.08).mul(detailMask)
        .add(sin(pos.x.mul(-2.1).add(pos.y.mul(3.7)).add(uTime.mul(2.8))).mul(0.06).mul(detailMask)),
    );

    const normal = normalize(vec3(waves.mul(2.0), 1.0, waves.mul(2.0)));
    const viewDir = normalize(cameraPosition.sub(positionWorld));

    // Blinn-Phong 太阳高光 + 漫反射/散射 + Fresnel
    const halfDir = normalize(uSunDirection.add(viewDir));
    const spec = pow(max(dot(normal, halfDir), 0.0), 100.0).mul(8.0).mul(detailMask);
    const diffuse = max(dot(normal, uSunDirection), 0.0).mul(0.15).mul(detailMask);
    const scatter = max(float(0.0), normal.y).mul(0.08).mul(detailMask);
    const fresnel = pow(float(1.0).sub(max(dot(vec3(0, 1, 0), viewDir), 0.0)), 3.0);

    const highlightColor = vec3(0.95, 0.98, 1.0);
    const finalColor = uColor.add(highlightColor.mul(diffuse.add(scatter).add(spec).add(fresnel.mul(0.1))));

    const depth = length(cameraPosition.sub(positionWorld));
    const fogFactor = smoothstep(uFogNear, uFogFar, depth);
    return mix(finalColor, uFogColor, fogFactor);
  })();

  const opacityNode = Fn(() => {
    const pos = positionWorld.xz;
    const dist = length(pos.sub(cameraPosition.xz));
    const waterFade = float(1.0).sub(smoothstep(float(fadeStart), float(fadeEnd), dist));
    return uOpacity.mul(waterFade);
  })();

  const waterMaterial = new THREE.NodeMaterial();
  waterMaterial.colorNode = colorNode;
  waterMaterial.opacityNode = opacityNode;
  waterMaterial.transparent = true;
  waterMaterial.depthWrite = false;
  waterMaterial.side = THREE.DoubleSide;

  const plane = new THREE.Mesh(waterGeo, waterMaterial);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = WATER_LEVEL_OFFSET;
  scene.add(plane);

  return {
    plane,
    /** 每帧：时间推进 + 跟随相机（无限水面） */
    update(camera, dt) {
      uTime.value += 0.015 * dt * 60;
      plane.position.x = camera.position.x;
      plane.position.z = camera.position.z;
    },
    setSeed(seed) { uSeed.value = seed; },
  };
}
