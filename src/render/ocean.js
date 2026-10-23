// src/render/ocean.js — 动画海面（M2-5，移植 mc-lite Engine.js 海面 TSL 材质）
// 800×800 平面跟随相机（无限水面）；波浪动画 + Blinn-Phong 高光 + Fresnel + 距离淡出 + 水域遮罩。
// 水面高度 = SEA_Y + 0.5（mc-lite WATER_LEVEL_OFFSET 语义）。
import * as THREE from 'three';
import {
  uniform, Fn, float, vec3, sin, cos, max, pow, dot, normalize, length, floor,
  smoothstep, mix, positionWorld, cameraPosition, Discard, and, select,
} from 'three/tsl';
import {
  OCEAN_MASK_THRESHOLD, OCEAN_MASK_OFFSET, OCEAN_MASK_NO_CITY,
} from './ocean-mask.js';
import { TERRAIN_HEIGHT_PARAMS } from '../gen/terrain.js';
import { BIOME_PARAMS } from '../gen/noise.js';

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
  /**
   * 城市门控 bounds（xyzw = minX/maxX/minZ/maxZ）。
   * 默认取 `OCEAN_MASK_NO_CITY` 哨兵（minX > maxX → 判定恒假 → 门控关闭），
   * 未接线时不误伤任何点；`setCityBounds()` 接真实城市 bounds 后生效。
   */
  const uCityBounds = uniform(new THREE.Vector4(
    OCEAN_MASK_NO_CITY.minX, OCEAN_MASK_NO_CITY.maxX,
    OCEAN_MASK_NO_CITY.minZ, OCEAN_MASK_NO_CITY.maxZ,
  ));

  /** RedCity 门控 bounds（= influence，含过渡环）。默认哨兵 = 关闭；`setRedCityBounds()` 接真实值后生效 */
  const uRedCityBounds = uniform(new THREE.Vector4(
    OCEAN_MASK_NO_CITY.minX, OCEAN_MASK_NO_CITY.maxX,
    OCEAN_MASK_NO_CITY.minZ, OCEAN_MASK_NO_CITY.maxZ,
  ));

  const fadeStart = WATER_VISIBLE_DISTANCE - WATER_EDGE_FADE_BAND;
  const fadeEnd = WATER_VISIBLE_DISTANCE;

  /**
   * 水面遮罩用的地形高度 —— **与生成侧 `generateHeight` 同构**。
   *
   * ⚠️ TSL 无法调 JS 函数，只能同构实现。数值常量一律读
   * `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS`（单一权威，红线 1）——
   * 各写一份字面量会漂移出「生成侧的地形与遮罩判的不是同一套高度」的撕裂，
   * 后果是陆地上出现假水面或真实湖泊失去水面，肉眼只觉得「水怪怪的」。
   *
   * 与 mc-lite 的差异：mc-lite 只用基础噪声近似（不含 biome 调整），
   * 判据与真实地形偏差 +1.39~+6.71（DESERT/SWAMP 的调整没算进去）。
   */
  const P = TERRAIN_HEIGHT_PARAMS;
  const B = BIOME_PARAMS;
  const biomeNoise = (x, z, scale) => {
    const nx = x.add(uSeed);
    const nz = z.add(uSeed);
    return sin(nx.mul(scale)).mul(2.0).add(cos(nz.mul(scale)).mul(2.0));
  };
  const getTerrainHeight = (x, z) => {
    // 基础噪声（与 gen/noise.js 的 noise 同构）
    const base = floor(biomeNoise(x, z, P.COARSE_SCALE)
      .add(biomeNoise(x, z, P.FINE_SCALE).mul(P.FINE_WEIGHT)));
    // biome 判定（与 gen/noise.js 的 getBiome 同构；CITY 不在这里 —— 由 bounds 门控关掉）
    const temp = biomeNoise(x, z, B.TEMP_SCALE);
    const humidity = biomeNoise(x.add(B.HUMIDITY_OFFSET), z.add(B.HUMIDITY_OFFSET), B.HUMIDITY_SCALE);
    const desert = temp.lessThan(float(B.DESERT_TEMP_MAX));
    const swamp = and(
      and(temp.greaterThan(float(B.DESERT_TEMP_MAX)), temp.lessThan(float(B.SWAMP_TEMP_MAX))),
      humidity.greaterThan(float(B.SWAMP_HUMIDITY_MIN)),
    );
    const desertH = floor(base.mul(P.DESERT_FACTOR).add(P.DESERT_OFFSET));
    const swampH = floor(base.mul(P.SWAMP_FACTOR).add(P.SWAMP_OFFSET));
    return select(desert, desertH, select(swamp, swampH, base));
  };

  const colorNode = Fn(() => {
    const pos = positionWorld.xz;
    const dist = length(pos.sub(cameraPosition.xz));
    const waterFade = float(1.0).sub(smoothstep(float(fadeStart), float(fadeEnd), dist));

    // 远距离淡出裁剪
    Discard(waterFade.lessThanEqual(0.001));

    // 城市门控：城市 bounds 内一律不渲染（**不看距离**，与下面的近处遮罩独立）。
    // 理由：城市把地面压平到接近海平面（CITY_MIN_SURFACE_Y = SEA_Y+1），而水面平面在
    // SEA_Y+0.5 → 挖 2 格洞底顶面降到 -2 就低于水面平面，玩家在陆地上挖出一汪假水。
    // 遮罩算不出 CITY 调整（getBiome 不含 CITY，它由结构系统叠加）→ 只能靠 bounds 关掉。
    // CPU 侧同一判据见 ocean-mask.js 的 inCityBounds。
    const inCity = and(
      and(pos.x.greaterThanEqual(uCityBounds.x), pos.x.lessThanEqual(uCityBounds.y)),
      and(pos.y.greaterThanEqual(uCityBounds.z), pos.y.lessThanEqual(uCityBounds.w)),
    );
    Discard(inCity);
    // RedCity 门控：influence 内一律不渲染（core 全深度实心、ring 水域已补实成陆地，区域内下挖到 y<-1.5 会挖出陆地上的假水——
    // 与 City 同一理由）。CPU 侧同一判据见 ocean-mask.js（复用 inCityBounds 的同一不等式）。
    const inRedCity = and(
      and(pos.x.greaterThanEqual(uRedCityBounds.x), pos.x.lessThanEqual(uRedCityBounds.y)),
      and(pos.y.greaterThanEqual(uRedCityBounds.z), pos.y.lessThanEqual(uRedCityBounds.w)),
    );
    Discard(inRedCity);

    // 水域遮罩：近处仅在地形低于海平面附近显示，远处全显示
    // 阈值 = OCEAN_MASK_THRESHOLD（SEA_Y）；高度是整数 → `h < SEA_Y` ⟺ `h <= SEA_Y-1`，
    // 正是 fillColumn 的水体方块判据（判据同源，无需 mc-lite 的 floor 余量补偿）。
    // 五点取样（±OCEAN_MASK_OFFSET）= 水面沿海岸向内侵的纵深，让水陆边界不锯齿化。
    const threshold = float(OCEAN_MASK_THRESHOLD);
    const offsetVal = float(OCEAN_MASK_OFFSET);
    const h0 = getTerrainHeight(pos.x, pos.y);
    const h1 = getTerrainHeight(pos.x.add(offsetVal), pos.y);
    const h2 = getTerrainHeight(pos.x.sub(offsetVal), pos.y);
    const h3 = getTerrainHeight(pos.x, pos.y.add(offsetVal));
    const h4 = getTerrainHeight(pos.x, pos.y.sub(offsetVal));
    // 整数高度下 smoothstep(threshold-0.01, threshold, h) 恒等于阶跃 → 直接 select，
    // 省 5 次 GPU 调用且与 CPU 版判据一一对应
    const step = (h) => select(h.lessThan(threshold), float(1.0), float(0.0));
    const nearOceanMask = max(max(max(max(step(h0), step(h1)), step(h2)), step(h3)), step(h4));
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
  // issue #2：透明排序按锚点 NDC 深度（海面锚点=相机正下方、体素通道锚点=合并几何
  // 包围球中心），镜头转动时两者交叉 → 绘制顺序翻转 → 水色离散跳变。
  // 固定 renderOrder 让海面恒在体素水（默认 0）之后绘制，退出深度排序。
  plane.renderOrder = 1;
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
    /**
     * 接城市门控 bounds（全世界唯一，`CITY_REGION = [0,0]`）。
     * @param {{minX:number,maxX:number,minZ:number,maxZ:number}|null} city
     *   `buildCityLayout` 结果；null 或缺字段 → 恢复哨兵（门控关闭）。
     */
    setCityBounds(city) {
      const b = city && Number.isFinite(city.minX) ? city : OCEAN_MASK_NO_CITY;
      uCityBounds.value.set(b.minX, b.maxX, b.minZ, b.maxZ);
    },
    /**
     * 接 RedCity 门控 bounds（全世界唯一）。
     * @param {{influence:{minX:number,maxX:number,minZ:number,maxZ:number}}|null} redCity `buildRedCityLayout` 结果；
     *   null 或缺字段 → 恢复哨兵（门控关闭）。取 influence（含过渡环）而不是 core。
     */
    setRedCityBounds(redCity) {
      const inf = redCity && redCity.influence;
      const b = inf && Number.isFinite(inf.minX) ? inf : OCEAN_MASK_NO_CITY;
      uRedCityBounds.value.set(b.minX, b.maxX, b.minZ, b.maxZ);
    },
  };
}
