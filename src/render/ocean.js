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
/**
 * 水面基色。**有意偏离 mc-lite 的 `0x588be4`**（2026-10-26 用户实玩反馈：
 * 「海水的波纹的颜色有点泛白，改成大海应有的深色……稍微颜色深一些，灰一些」）。
 *
 * 泛白的根因是**基色 + 纯白高光加法叠加**：基色 0x588be4 在线性空间已是
 * [0.098, 0.258, 0.776]，高光按 `white × k` 加在它之上，ACES 在亮端压缩 → 平坦水面
 * （也就是画面里占面积最大的那层）实测众数峰 **170/189/220（luma 187）**，看上去就是一块粉白。
 * 两处一起改：基色往**灰蓝**压深、高光改**乘法混色**（只占基色→白之间的剩余量，天然有界）。
 *
 * 实测（noon / ACES exp=1.0 / 海岸机位，水区众数峰）：
 * | | 基色屏幕值 | 水面屏幕色 | luma |
 * |---|---|---|---|
 * | mc-lite `0x588be4` + 白高光 | 98/167/224 | `170/189/220` | 187 |
 * | v1.82 `0x707f89`（灰蓝） | 133/153/165 | `132/149/178` | 148 |
 * | v1.83 `0x0c342f`（深青绿，过暗发脏） | 8/61/50 | `69/98/107` | 92 |
 * | v1.84 `0x2a5f85`（海蓝，B−G 33） | `42/95/133` | `92/133/164` | 127 |
 * | **v1.85 `0x22598a`（更深一档的海蓝）** | **`32/85/129`** | **`76/122/166`** | **115** |
 *
 * v1.85（用户第四轮）「水波纹的颜色也稍微变蓝一些」：v1.84 的 B−G 是 33，仍偏青；
 * 基色调向蓝（R 降、B 升）→ B−G 升到 **44**，与体素水（`100/137/168`）的色相一致。
 *
 * ⚠️ **基色屏幕值 ≠ 水区实测值**：后者还含高光、雾与下层体素水的叠加。选色不能只看 hex，
 * 换算口径是 sRGB → 线性 → ACES → sRGB（同 `sun-shade.js` 的 `srgbEncode` / `acesFilmic`）。
 *
 * **色相演进（三轮实玩反馈定下来）**：
 * - v1.82：用户「泛白，要深一些、灰一些」→ 压亮度的方向对，但只做了「去饱和」，偏灰。
 * - v1.83：用户给了参照图 `/Users/bachi/ttt/bug/海.png`（实测海区 `67/107/124`，G−R **+40**）
 *   → 认定「真实海面是青绿」→ 改深青绿 `0x0c342f`，实测 G−R 31、B−G 11。
 * - v1.84：用户「又太暗了，显得水很脏，稍微再蓝一些亮一些，显得干净」。像素数据支持这个判断：
 *   v1.83 的 `69/98/107` **luma 只有 92**、**R 只有 69**（色度已足但亮度不够）
 *   → 观感是「发脏的浊水」。改成 **`0x2a5f85`（luma 127，偏蓝）**。
 *   ⚠️ **三条反馈不矛盾**：v1.82/83 要的是「不要白」，v1.84 要的是「不要脏」——
 *   **亮度与饱和度是两个自由度**，泛白的反义词不是发暗。参照图本身是一张**阴天**照片
 *   （海区 luma 仅 100），而游戏里是正午晴天，直接取其亮度就会脏。
 *   **可信的锚点只有色相（B ≥ G > R、G−R 为正），亮度得按本仓光照单独标定。**
 */
const WATER_COLOR = 0x22598a;
/**
 * 高光颜色（v1.84：偏青绿 → **偏海蓝**）。
 * 纯白/偏红的高光会把水面压成灰白（v1.82 的泛白就是这么来的）；B 最高、R 最低，
 * 叠上去仍是「深蓝海面被太阳照亮」，而不是「什么颜色的水面上盖一层白」。
 */
const WATER_HIGHLIGHT_COLOR = [0.70, 0.86, 1.00];
/**
 * 高光总权重上限：`(diffuse + scatter + spec + fresnel×0.1)` 的整体缩放。
 * mc-lite 原值口径下该和约 0.20（平静水面）~1.3（太阳高光斑），×0.55 后约
 * 0.11 / 0.72。前者给「波纹可见但不发白」的基底，后者仍保留成片的高光斑。
 */
const WATER_HIGHLIGHT_GAIN = 0.42;
/**
 * 水面不透明度（v1.83：0.7 → 0.92，v1.84 维持）。
 * 这是「改基色仍泛白」的**第二个根因**：海面平面是半透明的，底下还有一层
 * **体素水方块**（v1.84 之前实测 `59/100/190`，高饱和紫蓝）。
 * 0.7 时 30% 的体素水直接透上来，把颜色往紫蓝拉并抬亮一档。
 * 实测（同一基色/高光，只改这个数）：0.70 → 近处 `86/111/146`；0.82 → `76/103/130`；
 * **0.92 → `67/95/112`**。
 * ⚠️ 不能再往上推太多：海面本来是半透明水面，接近 1.0 会变成一层塑料板。
 * v1.84 起体素水贴图已重烘（`npm run water`，均值 47/102/211 → 95/140/168）→ 两侧观感已接近，
 * 0.92 是「压住渗色」与「保留半透明水面」的交点。
 */
const WATER_OPACITY = 0.92;
const WATER_VISIBLE_DISTANCE = 80;
const WATER_EDGE_FADE_BAND = 15;
/**
 * 远距离雾色（v1.84 再调）。
 * `fogNear=20 / fogFar=70` → 远处海面几乎全是这个颜色，所以它就是「远处那片海」的观感。
 * 五个版本的屏幕值：mc-lite `0xa7d1e2` → `192/217/223`（白）；v1.82 `0x8aacbe` → `166/196/207`（仍偏亮）；
 * v1.83 `0x556e7e` → `93/131/152`（对得上参照图，但那图是阴天）；v1.84 `0x7aa4c4`；
 * 现行 `0x6b9cc0` → 与 v1.85 的深蓝水面同色系 —— 远景不再比近景暗一档（那正是「脏」的来源之一）。
 */
const WATER_FOG_COLOR = 0x6b9cc0;

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
   * 水面环境亮度乘数（v2.1）—— 由 `DayNight._apply` 按视觉风格写入（`skyUniforms.uWaterTint`）。
   *
   * **根因**：本材质是 unlit，此前只读 `uColor`/`uSunDirection`，**完全不跟着色环境的亮度**。
   * 而 dusk/night 的 `toneMappingExposure` 是 1.20 / 1.60（为体素世界的暗部补光，见
   * `daynight.js` 的 VISUAL_STYLES）→ 水面连带被提亮。实测（海岸机位，五变量冻结，水面众数峰）：
   * | 风格 | exposure | 水面 rgb | luma |
   * |---|---|---|---|
   * | morning | 1.00 | `77/122/165` | 116 |
   * | noon | 1.00 | `77/123/166` | 116 |
   * | dusk | 1.20 | `92/137/179` | **131** |
   * | night | 1.60 | `109/154/193` | **147** |
   * 用户 2026-10-31：「傍晚和晚上水面波纹过于亮，晚上像水面会发光」—— 数据完全对得上。
   * 夜里还有**反向撕裂**：体素水方块被 `skyDim 0.25` 压暗，水面平面反而变亮一档。
   *
   * ⚠️ **初值恒 1**：`1` 时下面的公式**逐位等于** v1.85 的原式（零回归）——
   * 即使无人接线（fixture / 单测 / 未装配），水面也回到改动前的表现。
   */
  const uWaterTint = uniform(new THREE.Vector3(1, 1, 1));
  /**
   * 城市门控 bounds（xyzw = minX/maxX/minZ/maxZ）。
   * 默认取 `OCEAN_MASK_NO_CITY` 哨兵（minX > maxX → 判定恒假 → 门控关闭），
   * 未接线时不误伤任何点；`setCityBounds()` 接真实城市 bounds 后生效。
   */
  const uCityBounds = uniform(new THREE.Vector4(
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

    // 高光合成：**乘进「基色 → 白」的剩余量，而不是加到基色之上**。
    // 加法在亮端会越界（基色 B 已 0.776，加 0.2 就到 0.98），ACES 压缩后几乎全白；
    // 乘法混色 `base + (1−base)×t` 天然有界（t=1 才到纯白），t 小时只提亮一点点，
    // 波纹因此「显出形状」而不「发白」。实测平坦水面的众数峰由此从 170/189/220 落到
    // 132/149/178（见 WATER_COLOR 的表）。
    //
    // ---- 环境亮度（v2.1）----
    // `uWaterTint` 是风格化的环境亮度乘数（晨/午 = 1），**乘在整个水面颜色上**（基色 + 高光）。
    // ⚠️ **必须乘高光，不能只乘基色**（实测踩坑）：高光走乘法混色 `base + highlight×glow×(1−base)`，
    // 它的可提升上限 `(1−base)` 会随基色变暗而变大 → 只压基色时高光反向补偿，
    // 实测 dusk 的 tint 从 1.0 压到 0.80 时水面 luma 只从 131 降到 125（目标 118）。
    // 整体相乘才能在「基色与高光都暗下去」上得到可标定的单调响应。
    // ⚠️ 先算完整颜色再乘 tint（不是改写 base，也不是乘在输出最后）：
    // `tint = 1` 时 `×1.0` 在 IEEE754 下逐位精确 → v1.85 原式零回归。
    const baseColor = uColor;
    const highlight = vec3(WATER_HIGHLIGHT_COLOR[0], WATER_HIGHLIGHT_COLOR[1], WATER_HIGHLIGHT_COLOR[2]);
    const glow = diffuse.add(scatter).add(spec).add(fresnel.mul(0.1))
      .mul(WATER_HIGHLIGHT_GAIN)
      .min(1.0);
    const litColor = baseColor.add(highlight.mul(glow).mul(vec3(1.0, 1.0, 1.0).sub(baseColor)));

    const depth = length(cameraPosition.sub(positionWorld));
    const fogFactor = smoothstep(uFogNear, uFogFar, depth);
    // ⚠️ **tint 必须乘在雾混合之后**（v2.2 修的根因，用户 2026-10-28 第二轮反馈
    // 「傍晚和夜晚的水面波纹颜色依然过于明亮」）：
    // `WATER_FOG_COLOR` 是正午口径的固定常量、`fogNear=20 / fogFar=70`，中远景海面几乎全由
    // 雾色决定。乘在 mix **之前**时雾色完全不吃风格亮度乘数 —— 实测（vd=8 深海机位、
    // 五变量冻结、水面众数峰 luma，按屏幕分带「远→近」）：
    // | 风格 | 0.55-0.65（远） | 0.65-0.75 | 0.75-0.85 | 0.85-0.96（近） |
    // |---|---|---|---|---|
    // | noon | 156 | 126 | 123 | 116 |
    // | dusk | **170** | 132 | 123 | 116 |
    // | night | **182** | 133 | 115 | 114 |
    // **夜晚远处 182 比正午 156 还亮一档** —— 这正是「像发光」的大头。
    // 判别性证据：tint 从 0.62 压到 0.34 时近处 114→76，而远处那一带**恒定 182 一点没变**。
    //
    // `tint = 1`（晨/午）时 `× 1.0` 在 IEEE754 下逐位精确 → 晨午零回归。
    return mix(litColor, uFogColor, fogFactor).mul(uWaterTint);
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
  /**
   * **水面必须写深度**（v2.2）。
   *
   * 根因（用户 2026-10-28：「曳光线被波纹水面所遮挡……只有当曳光线入水后，才被水面所遮挡」）：
   * 水面与曳光都在 transparent 队列、原先**都不写深度**，而海面 `renderOrder = 1` 排在曳光
   * （默认 0）之后绘制 → 曳光先画却不留深度，海面后画时深度测试无条件通过 → **连同水面上方的
   * 曳光也被整片盖住**。
   *
   * 实测（同机位，曳光固定在水面上方 3 格 / 下方 3.5 格，两配置交替各 3 轮，可见像素）：
   * | 配置 | 水面上方 | 水面下方 |
   * |---|---|---|
   * | 修前（不写深度、曳光先画） | 1544 / 1544 / 1544 | 3134 / 3134 / 3135 |
   * | 修后（写深度、曳光后画 + 深度测试） | 3528 / 3528 / 3528 | **0 / 0 / 0** |
   *
   * ⚠️ **与 `tracer-renderer.js` 的 `renderOrder = 2` 是一组耦合约定**，改任一处都要一起看：
   * 只写深度而不把曳光排到海面之后 → 曳光先画仍会被海面混合覆盖；只排后画而不写深度 →
   * 海面不留深度，曳光在水下也照样透出来。
   * `Discard` 已处理遮罩/淡出区，不会把深度写进本该透明的像素。
   */
  waterMaterial.depthWrite = true;
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
    /** 环境亮度乘数句柄（`DayNight` 经 `skyUniforms.uWaterTint` 写入；也供测试直接读） */
    uWaterTint,
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
  };
}
