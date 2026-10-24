// src/render/sky.js — 天空盒（双立方图交叉淡入）+ 日轮/月轮（v1.58）
//
// 资源与绘制参数来自 mc-lite：`Engine.js:429-527`（canvas 日轮/月轮、CubeTextureLoader、
// configureSkyboxTexture）。**两处有意偏离**（spec §3.4）：
//  ① 不做 `backgroundBlurriness`。那个值（夜 0.28）会让 three 走 `pmremTexture` 路径
//     （`three.webgpu.js:55805` 判 `backgroundBlurriness > 0`），需要预滤波立方图 render target，
//     与本方案手工构建的 `scene.backgroundNode` 冲突；而且它本是 mc-lite **离散切风格**的补偿值
//     （让星空不那么刺眼），交叉淡入下星星该是清晰的。
//  ② 天空随连续日夜插值，而非点风格按钮时硬切换 —— 与本仓日夜模型一致（同 v1.44 太阳方向）。
//
// 为什么用 `scene.backgroundNode` 而不是直接 `scene.background = cubeTexture`：
//   后者只能一次显示一张立方图，无法做双图交叉淡入。手工构建 backgroundNode 时 three 仍会
//   复用背景球（`three.webgpu.js:48927-48984` 走 `backgroundNode.isNode` 分支），
//   并用 `context.getUV = () => backgroundRotation.mul(normalWorldGeometry)` 提供采样方向。
//   故此处 `cubeTexture(tex)` **不传 uvNode** —— 让 three 的上下文注入正确方向。
import * as THREE from 'three';
import { cubeTexture, mix, uniform } from 'three/tsl';
import { SKY_FACE_FILES, SKY_SETS } from './sky-config.js';

/**
 * 单个立方图的加载（Promise 化）。
 * `CubeTextureLoader.load` 的 `onError` 是唯一失败信号 —— 不 reject 的话缺失面会被静默
 * 填成空白（天空出现一块纯灰，控制台无异常、不阻断启动）。
 * @param {string} dir 目录（相对站点根，不带尾斜杠）
 * @returns {Promise<THREE.CubeTexture>}
 */
function loadCube(dir) {
  return new Promise((resolve, reject) => {
    new THREE.CubeTextureLoader().setPath(`${dir}/`).load(
      [...SKY_FACE_FILES],
      (tex) => {
        // 采样参数照 mc-lite `Engine.js:515-522` 的 configureSkyboxTexture。
        // ⚠️ `colorSpace = sRGB` 不可省：JPEG 是 sRGB 编码，当线性采样会整体偏暗发灰。
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      (err) => reject(new Error(`天空盒面加载失败（${dir}）：${err && err.message ? err.message : err}`)),
    );
  });
}

/** 月轮 sprite：先柔和月晕再画满月圆盘（参数照 mc-lite `Engine.js:463-495`） */
function makeMoonSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  glow.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
  glow.addColorStop(0.45, 'rgba(226, 236, 255, 0.35)');
  glow.addColorStop(1, 'rgba(200, 220, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  const disc = ctx.createRadialGradient(112, 112, 16, 128, 128, 64);
  disc.addColorStop(0, 'rgba(255, 255, 255, 1)');
  disc.addColorStop(0.55, 'rgba(245, 248, 255, 1)');
  disc.addColorStop(1, 'rgba(216, 226, 246, 1)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(128, 128, 60, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, fog: false, depthTest: true,
  }));
}

/** 日轮 sprite：三层暖色径向渐变（参数照 mc-lite `Engine.js:429-462`） */
function makeSunSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255, 205, 177, 1)');
  grad.addColorStop(0.1, 'rgba(255, 182, 142, 1)');
  grad.addColorStop(0.5, 'rgba(255, 247, 194, 0.7)'); // mc-lite sunColor 0xfff7c2
  grad.addColorStop(1, 'rgba(255, 247, 194, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, fog: false, depthTest: true,
  }));
}

/**
 * 装配天空盒 + 日轮/月轮。
 *
 * 三张立方图三层混合（v1.71）：`mix(mix(day, night, uNightBlend), dusk, uDuskBlend)`。
 * ⚠️ **嵌套顺序是载荷性的**：`uDuskBlend = 0` 时内层 mix 就是 v1.70 的原奇表达式 →
 * 逐位回到双图交叉淡入。写成 `mix(day, mix(night, dusk, ...), ...)` 也能算出 0，但两条路径
 * 各自漂移一次就没人能预判结果了。
 *
 * @param {THREE.Scene} scene
 * @returns {Promise<{
 *   uNightBlend: Object, uDuskBlend: Object,
 *   dayCube: THREE.CubeTexture, nightCube: THREE.CubeTexture, duskCube: THREE.CubeTexture,
 *   sunSprite: THREE.Sprite, moonSprite: THREE.Sprite, dispose: () => void,
 * }>}
 */
export async function setupSky(scene) {
  const [dayCube, nightCube, duskCube] = await Promise.all([
    loadCube(SKY_SETS.day),
    loadCube(SKY_SETS.night),
    loadCube(SKY_SETS.dusk),
  ]);

  // 夜间程度 0..1（由 DayNight 从既有 skyDim 派生后写入，见 daynight.js 的 nightBlendOf）。
  const uNightBlend = uniform(0);
  // 黄昏程度 0..1（v1.71）：只有手动选「傍晚」时是 1，自动循环恒 0（见 daynight.js）。
  const uDuskBlend = uniform(0);
  // ⚠️ **不传 uvNode**：three 会把 `backgroundRotation.mul(normalWorldGeometry)` 从上下文注入
  // （three.webgpu.js:48924-48928 → CubeTextureNode.setupUV 走 builder.context.getUV）。
  // 自己传方向会绕开它的 x 轴取反约定 → 天空左右镜像（肉眼很难察觉，须靠像素判据抓）。
  // 实测校准（自校准 day 贴图：已知正午太阳 azim 0°/elev 47°，探针能量到同值）：
  // 这条路径确实对 x 轴镜像 —— 所以 skyBox2 里落盘在 -X/+Z 的日落会出现在 **+X/+Z**
  // 象限（azim ≈ +44°），`VISUAL_STYLES.dusk.sunDirection` 就是按渲染结果定的。
  const dayNightMix = mix(cubeTexture(dayCube), cubeTexture(nightCube), uNightBlend);
  scene.backgroundNode = mix(dayNightMix, cubeTexture(duskCube), uDuskBlend);
  // 双设：`getBackgroundNode()` 优先读 backgroundNode（:55681），但保留 background = null
  // 让 DayNight 的 `scene.background.set(...)` 纯色路径自动跳过（它判 `background && .set`）。
  scene.background = null;

  const sunSprite = makeSunSprite();
  const moonSprite = makeMoonSprite();
  sunSprite.visible = false;
  moonSprite.visible = false;
  scene.add(sunSprite);
  scene.add(moonSprite);

  return {
    uNightBlend,
    uDuskBlend,
    dayCube,
    nightCube,
    duskCube,
    sunSprite,
    moonSprite,
    dispose() {
      scene.backgroundNode = null;
      scene.remove(sunSprite);
      scene.remove(moonSprite);
      sunSprite.material.map?.dispose();
      moonSprite.material.map?.dispose();
      sunSprite.material.dispose();
      moonSprite.material.dispose();
      dayCube.dispose();
      nightCube.dispose();
      duskCube.dispose();
    },
  };
}

/**
 * 日轮/月轮跟随（mc-lite `Game.js:539-547` 口径：位置 = 玩家 + 方向 × 距离，模拟无限远）。
 *
 * 与 mc-lite 的差异：距离改由相机 far 推导、尺寸同比缩放 —— 本仓视距可 2~16 变，
 * mc-lite 固定 150 单位 + 固定尺寸；照抄会在小视距下把 sprite 推出相机远裁面（月亮消失），
 * 大视距下又显得过小。
 *
 * ⚠️ 只在既有重定位节奏里调用（移动 >5 格 / 太阳方向过门控），**不得每帧调** ——
 * 调用方是 `Game._updateCelestial()`，由 `_updateSunPosition()` 的触发点带动。
 *
 * @param {THREE.Sprite} sprite
 * @param {THREE.Camera} camera
 * @param {readonly number[]} dir 已归一化的方向
 * @param {number} size 风格尺寸（mc-lite 值：太阳 28 / 月亮 18~34）
 */
export function placeCelestial(sprite, camera, dir, size) {
  // 距离取 0.55×far：落在远裁面内（0.55 < 1）、又远在地形之外（视距 8 时 ≈ 79 格）。
  const dist = camera.far * 0.55;
  sprite.position.set(
    camera.position.x + dir[0] * dist,
    camera.position.y + dir[1] * dist,
    camera.position.z + dir[2] * dist,
  );
  // 等比缩放：mc-lite 的 size 是「距离 150 处的角尺寸」，本仓距离不同 → 同比换算
  const scale = size * (dist / 150);
  sprite.scale.set(scale, scale, 1);
}
