// src/render/materials.js — TSL 体素材质（顶点阶段 shade + atlas 采样 + 雾）
// r185.1 TSL：attribute('packed','uint') 读自定义顶点属性；位运算 bitAnd/shiftRight 已核验可用。
//
// AO/light 渐变的关键：shade 必须在【顶点阶段】算成 float，经 float varying 传到片元，
// GPU 才会双线性插值出平滑渐变。若直接在片元读 uint 属性，three.webgpu.js:65404 对
// int 类型 varying 强制加 `flat` 限定符 → 每三角形一个常量值 → 无色块间渐变
// （这正是"看不到 AO 渐变"的根因）。mc-lite AONodeSystem.js:140 同款机制
// （vAo = varying(vertexStage(aoComputed))）。
import * as THREE from 'three';
import {
  texture, attribute, float, vec3, vec4, mul, add, max,
  rangeFogFactor, uniform, fog,
  varying, vertexStage,
  shadow, mix, dot, select, clamp,
  cubeTexture, positionWorld, cameraPosition, normalize, length,
} from 'three/tsl';

import {
  SHADOW_FLOOR, SUN_INTENSITY, FACE_NORMALS, NOON_SUN_DIR,
} from './sun-shade.js';import { HEMI_GROUND } from './hemi-shade.js';
// v3.50 云专属着色地板（three-free 常量与 CPU 参考实现，与 TSL 同公式 —— 红线 1）
import {
  AO_CURVE_K, cloudSunFloorFor, cloudHemiFloorFor, cloudAoFloorFor,
} from './cloud-shade.js';import { FOG_SKY_Y_FLOOR_EPS } from './fog-sky-direction.js';
// v3.31 雨天湿表面（**从零实现**，不参考上游；按材质分类 + 有界天空反光）
import { createWetSurfaceNode, WET_SURFACE_UNIFORMS } from './wet-surface.js';

// ---- 顶点阶段 shade（light × AO），float varying 传片元 ----
// packed 属性解包：bit0-7 light（sky<<4|block），bit8-9 AO，bit10-12 世界面索引，
// bit13 材质自发光标记（§4.3），bit14 阴影不投射标记（§4.4.4，v1.45）
const packed = attribute('packed', 'uint');
const lightByte = packed.bitAnd(0xFF);
// 日夜调制（M2-6）：uSkyDim 黑夜压暗 skylight，uBlockBoost 黑夜相对增强 blocklight
const uSkyDim = uniform(1.0);
const uBlockBoost = uniform(1.0);
const sky = float(lightByte.shiftRight(4)).div(15).mul(uSkyDim);
const block = float(lightByte.bitAnd(0xF)).div(15).mul(uBlockBoost);
const ao = float(packed.shiftRight(8).bitAnd(3));
// AO 曲线（mc-lite AONodeSystem.js:129 口径）：ao=3（开阔）→1.0，ao=0（墙角）→0.1
// ⚠️ v3.50：系数从字面量 0.9 改为 import 的 `AO_CURVE_K`（唯一权威在 cloud-shade.js）——
// 云 AO 地板要用同一个曲线算最暗值，两处各写一份会漂移。
const aoFactor = float(1).sub(float(3).sub(ao).div(3).mul(AO_CURVE_K));

// ---- 云专属着色地板（v3.50）----
// 用户 2026-11-27：「云方块组成的云朵不会这么硬（像飘在空中的石头方块一样）」。
// 云贴图实测是 64×64 全 255 纯白零细节 ⇒ 立体感 100% 来自与石头共用的着色公式：
// 正午底面屏幕亮度 145 vs 顶面 226（比 1.559）、云簇凹角侧面掉到 99。
//
// 做法：给三个致暗因子（AO / 半球 / 太阳项）各加一个**地板**，用 `max(原值, 地板)`。
// ⚠️ **`max` 是载荷性的**：原值已高于地板的面恒等返回 ⇒ **亮面逐位不动**，
// 结构上不可能过曝，也不动 crosshair 的「最亮方块 < 200」阈值。
// 改 hemiGround/shadowFloor 系数会把顶面与迎光面一起抬亮；wrap lighting 连顶面的 dot 也抬。
//
// ⚠️ **模块顶层单例**：反射替身由同一个 `createVoxelMaterials` 造
// （render-world.js:203）⇒ 放顶层就自动跟随，无需同步（与 uSkyDim / WET_SURFACE_UNIFORMS 同口径）。
// ⚠️ 两个 per-style 地板由 `DayNight._apply` 每帧写（由当前 floor/ground 派生）；
// AO 地板与 style 无关，只由本初值提供。
export const CLOUD_SURFACE_UNIFORMS = {
  /** 柔和总强度 0..1。**0 = 逐位回到 v3.49**（零回归锚点，也是 Tier 4 单变量 A/B 旋钮）。 */
  uCloudSoften: uniform(1.0),
  /**
   * 太阳项地板的**标量权威**（初值 = 全局档派生值 0.597）。
   * ⚠️ **着色器不直接吃它** —— 消费方是下面的 RGB 版（vec3）。
   * 保留它的理由：① 亮度语义的单一权威（RGB 版三通道均值 ≡ 它）；
   * ② Tier 4 与单测读它校对派生值（比读 vec3 直观）。
   */
  uCloudSunFloor: uniform(cloudSunFloorFor(SHADOW_FLOOR)),
  /**
   * 太阳项地板的**逐通道**版（v3.50 自审修复）。
   * ☠️ `sunTerm` 是 vec3（含色温），标量 `max(vec3, float)` 逐分量取大
   * ⇒ 把傍晚/黑夜/普通档的冷色环境光抹成中性灰（实测 R−B −0.129/−0.097/−0.044 → 0）。
   * 由 `DayNight._apply` 每帧写（同一个 floor + 当前 ambientColor）。
   * 初值取中性色温 ⇒ 三通道都 = 标量地板（逐位零回归）。
   */
  uCloudSunFloorRGB: uniform(new THREE.Vector3(
    cloudSunFloorFor(SHADOW_FLOOR), cloudSunFloorFor(SHADOW_FLOOR), cloudSunFloorFor(SHADOW_FLOOR),
  )),
  /** 半球环境地板（初值 = 全局档派生值 0.8）。 */
  uCloudHemiFloor: uniform(cloudHemiFloorFor(HEMI_GROUND)),
  /** AO 地板（0.7，与 style 无关）。 */
  uCloudAoFloor: uniform(cloudAoFloorFor()),
};
const uCloudSoften = CLOUD_SURFACE_UNIFORMS.uCloudSoften;
const uCloudSunFloor = CLOUD_SURFACE_UNIFORMS.uCloudSunFloor;
const uCloudSunFloorRGB = CLOUD_SURFACE_UNIFORMS.uCloudSunFloorRGB;
const uCloudHemiFloor = CLOUD_SURFACE_UNIFORMS.uCloudHemiFloor;
const uCloudAoFloor = CLOUD_SURFACE_UNIFORMS.uCloudAoFloor;
// 逐 quad 标记（mesher 从方块名写 packed bit19）。**逐顶点常量** ⇒ 无需渐变。
const cloudBit = float(packed.shiftRight(19).bitAnd(1));
// ⚠️ **mix 而非 if**：非云方块 cloudBit=0 ⇒ cloudT 恒 0 ⇒ mix 取左端 ⇒ **结构性零回归**
// （已预验 `mix(a,b,0) = a + (b−a)×0` 在非整比输入上逐位等于 a）。
// 写 if 会出两条代码路径，未测的那条静默劣化（本仓 setupFog 已记这条教训）。
const cloudT = mul(cloudBit, uCloudSoften);
// AO 地板：云簇凹角不再像石缝（ao=1 时 0.4 → 0.7）。
const aoSoft = mix(aoFactor, max(aoFactor, uCloudAoFloor), cloudT);
// 太阳阴影只衰减 skylight 项，不碰 blocklight（对齐 mc-lite 的混合模型：它的阴影只拿走
// 方向光贡献，AmbientLight(2.3) 不受影响 → 影区是「暗一档」而非全黑）。故 sky/block 分开
// 传片元（max(sky,block)×ao ≡ max(sky×ao, block×ao)，ao≥0 → 拆分无损）；片元只把阴影因子
// 乘进 sky 项再取 max。**火把照亮的洞穴/室内不会被太阳阴影压暗**。
// ⚠️ 拆分把 `max` 的求值点从**顶点**移到了**片元**（旧：顶点算 max(sky,block)×ao 后插值一个
// varying；新：两个项各自插值后片元取 max）。两者只在「同一三角形内 sky/block 的胜者发生切换」
// 时有差（新写法更平滑：对两个连续场逐片元取 max，而非插值一个逐顶点的 max）。
// 实际影响面极小：skylight 恒 15（DR-14）而 blocklight 稀疏，胜者很少在 quad 内切换；
// 且 AO fixture（skylight=15 / blocklight=0）下 block 项恒 0 → 两写法**逐位等价**。
// 多付一个 float varying（vSkyShade + vBlockShade 取代 vShade）。
const vSkyShade = varying(vertexStage(mul(sky, aoSoft)), 'vSkyShade');
const vBlockShade = varying(vertexStage(mul(block, aoSoft)), 'vBlockShade');

// ---- 材质自发光（§4.3 bit13，v1.21）----
// 对齐 mc-lite `MeshStandardNodeMaterial` 的 emissive：实测 mc-lite **只有 hanging_lamp**
// 一处有材质自发光（`MaterialManager.js:1199`，`emissive:'#FFE4B5'` × `emissiveIntensity:0.8`），
// 故不能给整个通道加（会让 vine/flower/leaves 全部发光），必须按方块区分 → 顶点 bit13 传递。
// **与 blocks-data 的 `emissive:15` 是不同概念**：那是 blocklight 光照源（照亮周围方块），
// 这里是材质自身发亮。四个发光方块都有 blocklight 源，但只有 hanging_lamp 有材质自发光。
//
// 语义：three `MeshStandardMaterial` 的 emissive 是**独立加项**——不乘贴图色、不受光照/AO 影响，
// 直接加在 diffuse 之上（黑夜中灯依然发亮）。故加在 `× shade` 之后。
// 标记是逐顶点常量（同一 quad 4 顶点同值），走 vertexStage float varying 即可，无需渐变。
const vEmissive = varying(vertexStage(float(packed.shiftRight(13).bitAnd(1))), 'vEmissive');
const EMISSIVE_COLOR = vec3(0xFF / 255, 0xE4 / 255, 0xB5 / 255); // '#FFE4B5'（暖黄色）
const EMISSIVE_INTENSITY = 0.8; // mc-lite emissiveIntensity

// ---- 太阳阴影（shadow map 接收，§4.4.4）----
// uShadowStrength = 日夜联动的阴影浓度（白天 1.0 / 夜里随 uSkyDim 淡出，DR-6）。
// 恒创建（模块顶层单例，与 uSkyDim/uBlockBoost 同口径），供 DayNight 写入；
// 即使 sunLight 为 null（fixture 路径）句柄也存在，消费方判句柄存在再写。
const uShadowStrength = uniform(1.0);

// ---- 太阳方向光（N·L，v1.58）----
// 根因回顾：本材质是 unlit，顶点 shade 只有 `max(skylight, blocklight) × ao`。户外 skylight
// 恒 15（DR-14）→ **一个方块六面亮度完全相同**，不存在任何朝向差异（「光影平淡」的根因）。
// 三种视觉风格只改 skyDim/blockBoost 这类**全局乘数**，怎么调都没有朝向差异。
//
// 数据来源：面法线走 packed bit10-12 —— mesher 早已写入（§4.3），此前**零消费点**。
// ⚠️ 必须在**顶点阶段**算成 float varying：片元直接读 packed 会被 three.webgpu.js:65404
// 对 int 类型强制 `flat` 插值（每个三角形一个常量 → 色块）。
const uSunDirection = uniform(new THREE.Vector3(NOON_SUN_DIR[0], NOON_SUN_DIR[1], NOON_SUN_DIR[2]));
/**
 * 太阳方向光强度开关：0 = 关闭（sunTerm ≡ 1，**逐位回到** v1.57 的现状）/ 1 = 满强度。
 * Tier 4 像素判据用它做「只差一个变量」的 A/B；也是将来设置面板开关的接入点。
 */
const uSunStrength = uniform(1.0);

// 面法线解码：packed bit10-12 = 世界面索引 0..5（与 FACE_NORMALS 同序）。
// 六选一用 `select` 链而不是查表数组（GLSL 无动态索引常量数组的便携写法；只有 5 次 select，
// 且结果**逐顶点常量** → 编译期可折叠成一次常量）。
const worldFaceIndex = packed.shiftRight(10).bitAnd(7);
const FACE_NORMAL_NODES = FACE_NORMALS.map((n) => vec3(n[0], n[1], n[2]));
const faceNormalNode = FACE_NORMAL_NODES
  .slice(1)
  .reduce((acc, n, i) => select(worldFaceIndex.equal(i + 1), n, acc), FACE_NORMAL_NODES[0]);
// 太阳项的点积（顶点阶段，float varying）。
const vSunDot = varying(
  vertexStage(max(dot(faceNormalNode, uSunDirection), 0)), 'vSunDot');

// ---- 色温（v1.71，傍晚）----
// 根因：v1.70 之前太阳项是**纯标量**，`sunColor`/`ambientColor` 这类色相信息根本进不到着色器
// —— 于是「暖橙直射光 + 冷蓝紫环境光」这种傍晚观感在架构上不可表达（只能整体调曝光/天空色）。
// 公式（与 `sun-shade.js` 的 `sunTermRGBFor` 同源，红线 1）：
//   full_c    = SUN_AMBIENT × ambientColor_c + SUN_INTENSITY × N·L × shadowKill × sunColor_c
//   sunTerm_c = mix(1, full_c, uSunStrength)
// ⚠️ **环境项吃环境色、直射项吃直射色** —— 若两者都用直射色，阴影里也会变暖，就没了「暖光冷影」。
// ⚠️ uniform 初值全为 1：中性色时公式**逐位等于** v1.70 的标量版（其余三风格零回归）。
const uSunColor = uniform(new THREE.Vector3(1, 1, 1));
const uAmbientColor = uniform(new THREE.Vector3(1, 1, 1));

// ---- 半球环境光（v1.70）----
// 真实世界里天空来的环境光比地面反射的亮得多。本仓此前所有面吃同一个 skylight（户外恒 15，
// DR-14）→ 一个方块的顶面与底面完全一样亮，这是「一个色块、没立体感」的来源之一。
// 这里给 skylight 项乘一个只依赖面法线 y 的因子：朝上 1.0（**与现状逐位相同**，零回归锚点）、
// 朝下 uHemiGround、四侧面 (ground+1)/2。
//
// ⚠️ **只乘 skylight 项，不乘 blocklight**：火把照亮的洞穴底面不该变暗（与太阳项同一口径）。
// ⚠️ **与太阳无关**：它是环境光的方向性，`uSunStrength = 0` 时**仍然生效**。接进太阳项
// 会让「关掉方向光 → 半球差异一起消失」且夜间朝下面不暗（用户可见的语义错误）。
// ⚠️ uniform 初值 = HEMI_GROUND（常量唯一权威在 hemi-shade.js，此处不写字面量）；
// 取 1.0 时因子恒等 1 → **逐位回到 v1.69**，可作 A/B 隔离。
const uHemiGround = uniform(HEMI_GROUND);
const hemiFactor = mix(uHemiGround, float(1.0), mul(faceNormalNode.y, 0.5).add(0.5));
// 云半球地板（v3.50）：云底不再是黑底板（全局档 0.6 → 0.8）。
// ⚠️ 与太阳项同口径：只作用于 skylight 那一支（hemiFactor 本身只乘 vSkyShade）。
const hemiSoft = mix(hemiFactor, max(hemiFactor, uCloudHemiFloor), cloudT);

// ---- per-style 光影地板与太阳强度（v3.44，「普通」档）----
// 背景：上游 ASHLAR 的照片感主因实测是**直射/环境比**（上游 4.26 vs 本仓正午 1.63），
// 而这两个量在本仓是全局常量（写死）⇒ 任何风格都改不了它。
// 现在做成 uniform，由 `DayNight._apply` 按风格写：
//   · 「普通」档：floor 0.14 / intensity 0.956（配合 hemiGround 0.12）
//   · 其余四档与自动循环：写入全局常量 ⇒ **公式逐位回到现状**（零回归锚点）
// ⚠️ 初值 = 全局常量（权威在 shade-params.js，经 sun-shade.js re-export，此处不写字面量）。
// ⚠️ **uniform 走 uniform buffer，不占顶点属性** ⇒ gpuVertexBytes 零增量（200MiB 门不受影响）。
const uShadowFloor = uniform(SHADOW_FLOOR);
const uSunIntensity = uniform(SUN_INTENSITY);

/**
 * 阴影不投射标记（packed bit14，mesher 从 registry.shadowCastTable 写入）：在**阴影 pass**
 * 逐片元 discard（mc-lite `isShadowEnabled:false` 的 cloud/花草/藤/灯等不投影）。
 * ⚠️ `maskShadowNode` 只被阴影 pass 消费（three.webgpu.js `_getShadowNodes`），主 pass 的
 * `setupDiffuseColor` 只读 `maskNode` → 这些方块在主渲染里照常显示，只是不写阴影深度。
 *
 * 注：影区地板与太阳项环境地板是**同一个值**（`SHADOW_FLOOR ≡ SUN_AMBIENT`，
 * 权威在 `shade-params.js`）。v3.44 起它由 `uShadowFloor` 提供初值，
 * 且**同一个 uniform 实例**同时当影区地板与 `shadowKill` 的归一化分母 ——
 * 结构上不可能不同步（而不是靠两处各写同一个值）。
 */
const noShadowCastBit = float(packed.shiftRight(14).bitAnd(1));

/**
 * 创建三通道体素材质。
 * @param {THREE.Texture} atlasTexture
 * @param {THREE.DirectionalLight} [sunLight] 太阳灯（传 null 时不乘 shadowFactor，保持原路径）
 * @param {object} [reflectTexture] v3.33 积水真倒影：ocean 交出的 reflectTexture（null = 不挂）
 * @returns {{opaque: THREE.MeshBasicNodeMaterial, cutout: THREE.MeshBasicNodeMaterial, transparent: THREE.MeshBasicNodeMaterial, dayNight: Object, wet: Object}}
 */
export function createVoxelMaterials(atlasTexture, sunLight = null, reflectTexture = null) {
  // 阴影因子（两层 mix，**嵌套顺序是载荷性的，勿交换**）：
  //   内层 `mix(FLOOR, 1, shadow())` = 带地板的阴影：影外 1 / 影内 FLOOR（不再归零）；
  //   外层 `mix(1, 内层, uShadowStrength)` = 浓度调制：strength=0（关阴影/夜里）→ **恒 1 零影响**。
  // ⚠️ 写成单层 `mix(FLOOR, 1, shadow() × strength)` 是错的：strength=0 时 mix 取左端 = FLOOR
  // → **关掉阴影反而把全世界压到 50% 亮度**，且「关阴影 = 零视觉影响」的不变式静默失效
  // （spec 用例 7/8 的 A/B>0.85 断言会 FAIL）。
  // ⚠️ shadow() 第二参数是 LightShadow 实例（可选，缺省 = light.shadow），**不是** filter
  // 函数 —— PCF 滤波由 renderer.shadowMap.type 自动映射（PCFSoftShadowMap → PCFSoftShadowFilter）。
  // 误传 filter 函数会让 setupRenderTarget 读 shadow.mapSize 崩溃。故只传单参数。
  const shadowFactor = sunLight
    ? mix(float(1), mix(uShadowFloor, float(1), shadow(sunLight)), uShadowStrength)
    : null;

  // 最终亮度 = max(sky × 太阳项, block)。
  //
  // ---- 太阳项（v1.58，v1.71 加色温）----
  // `sunTerm_c = mix(1, SUN_AMBIENT × ambientColor_c + SUN_INTENSITY × N·L × shadowKill × sunColor_c, uSunStrength)`
  //
  // ⚠️ **阴影只作用在太阳项上**，不再直接乘 `vSkyShade`。若两边各乘一遍，正午顶面在影区会
  // 变成 `0.5 + 0.625×0.8×0.5 = 0.75`（应为 0.5）→ 阴影变淡 50%。
  // 故先把 shadowFactor 重标定到「太阳被拿走的比例」：
  //   shadowFactor = SHADOW_FLOOR（影区）→ shadowKill = 0 → sunTerm = 地板（同旧）
  //   shadowFactor = 1（受光）       → shadowKill = 1 → sunTerm = 1.0（同旧）
  //   uShadowStrength = 0（关阴影）   → shadowFactor = 1 → shadowKill = 1 → 满强度太阳
  // 无太阳灯（fixture 路径）时 shadowFactor 为 null → shadowKill 固定 1。
  //
  // ⚠️ sunTerm **只能**乘在 skylight 项上，不得乘 blocklight：火把照亮的洞穴/室内要照样亮
  // （与阴影只衰减 skylight 项同一道理）。
  // ⚠️ transparent 通道（水/玻璃）**不接**太阳：海面已有自己的 Blinn-Phong 高光（ocean.js），
  // 而且那个通道恰好是零回归的安全垫。
  // ⚠️⚠️ **分母必须用同一个 `uShadowFloor`**（v3.44）：per-style 化之前两处都是
  // 全局 SHADOW_FLOOR，天然同步；现在地板可随风格变，只改一处就会撕裂。
  // 实测缺陷形态（floor 0.14 但分母仍 0.62）：**两个端点完全一致**（影区 0 / 受光 1），
  // 变的是**半影中间调** —— shadowFactor 0.30 处同步 0.1860 / 不同步 **0.0000**
  // ⇒ 半影那一半太阳被吃掉，而所有「地板值对不对」的数值判据全绿。
  // CPU 参考实现是 `shadowKillFor`（sun-shade.js），两边同公式（红线 1）。
  const shadowKill = shadowFactor
    ? clamp(float(1).sub(float(1).sub(shadowFactor).div(float(1).sub(uShadowFloor))), 0, 1)
    : float(1);
  // 逐通道：直接项×直射色、环境项×环境色（见上方同名字段的注释）
  const sunTermFull = mul(uSunColor, uSunIntensity.mul(mul(vSunDot, shadowKill)))
    .add(mul(uAmbientColor, uShadowFloor));
  const sunTerm = mix(float(1), sunTermFull, uSunStrength);
  // 云太阳项地板（v3.50）：背光面不再死暗（全局档 0.38 → 0.597）。
  // ⚠️⚠️ **必须在 `sunTerm` 之后**，不是在 `vSunDot` 上 —— sunTerm 已含色温与 shadowKill；
  // 在 dot 上抬会绕过阴影因子（阴影语义被改，用户明确「阴影完全不动」）。
  // ⚠️ 副作用已记在设计稿 §7：影区的云也会被抬到地板 ⇒ 「云在阴影里比石头亮」。
  // 那正是「云自己散射」的语义；若实玩否掉，处置是把地板乘 shadowKill（一行）。
  // ⚠️⚠️ **必须用逐通道地板 `uCloudSunFloorRGB`**（自审修复）：sunTerm 是 vec3，
  // 标量 `max(vec3, float)` 逐分量取大会把三通道抬到同一值 ⇒ 抹掉色相。
  const sunTermSoft = mix(sunTerm, max(sunTerm, uCloudSunFloorRGB), cloudT);

  const shadeLit = max(mul(mul(vSkyShade, hemiSoft), sunTermSoft), vBlockShade);
  // 不接收阴影的通道（transparent = 水/玻璃）用无阴影亮度。
  // ⚠️ **不能只靠 `receiveShadow=false`**：那个标志只门控 three 的**灯光管线**
  // （three.webgpu.js:46101 `if (builder.object.receiveShadow) setupShadow()`），而本材质是
  // unlit + colorNode 里**显式**引用 `shadow(sunLight)` 节点 → 该节点不受 receiveShadow 门控，
  // 水面照样被压暗。mc-lite 对 water/glass 是 cast+receive 双 false（GlobalInstancedMeshManager.js:76-84），
  // 此处对齐：transparent 通道完全不参与阴影（不投影也不被压暗）。
  const shadeUnlit = max(mul(vSkyShade, hemiSoft), vBlockShade);

  const makeMaterial = ({ alphaTest = 0, transparent = false, side = THREE.FrontSide, emissive = false, receivesShadow = true, wet = false }) => {
    const mat = new THREE.MeshBasicNodeMaterial();
    const uvNode = attribute('uv', 'vec2');
    const texColor = texture(atlasTexture, uvNode);
    const shade = receivesShadow ? shadeLit : shadeUnlit;
    // emissive 只挂在需要的通道（hanging_lamp 走 cutout）：opaque 是最大通道，
    // 给它加一个恒为 0 的加项会白付一次逐像素 mul+add。
    // 亮度项 = texColor.rgb × shade；自发光加项在阴影相乘之后（灯在影区照样亮）。
    const rgb = emissive
      ? add(mul(texColor.rgb, shade), mul(EMISSIVE_COLOR, EMISSIVE_INTENSITY).mul(vEmissive))
      : mul(texColor.rgb, shade);
    /**
     * v3.31 雨天湿表面（用户 2026-11-22：「按材质分类重新从零实现」）。
     *
     * ⚠️⚠️ **挂 opaque 与 cutout 两个通道**：台阶/半砖/栏杆/柱子全在 cutout
     * （实测 45 个 cutout 方块里 20 个是建筑表面）。只挂 opaque 会让「石地面湿、石台阶干」。
     * 植被（PLANT 类）参数压到极弱 ⇒ 树叶/花草几乎不变（雨里保持哑光）。
     * ⚠️ **transparent 不挂**：水/玻璃本来就是镜面，水已有自己的高光与倒影。
     * ⚠️ **不新建地面 mesh**（红线 4/5）：效果作为本体素材质的一个可开关分支，
     * `uWet = 0` 时 `mix` 取左端 ⇒ **逐位回到未开启时的颜色**（零回归锚点）。
     * ⚠️ **不采样任何反射 RT**（v3.31 废弃了第二条 reflector pass）：
     * 反光反的是按反射方向插值的程序化天空 + 弱太阳高光，
     * 对任何朝向任何高度的面都几何正确（上游那套只对镜面那一层成立）。
     * ⚠️ 湿分支需要面法线 ⇒ 用已有的 `faceNormalNode`（packed bit10-12），
     * 材质类走 packed bit15-18，**两项都不新增顶点属性**
     * （加一个 float 属性会让 gpuVertexBytes 从 193.83 涨到 219.68 MiB，超 200 MiB 门）。
     */
    const finalRgb = wet
      ? createWetSurfaceNode({
        baseRgb: rgb,
        faceNormal: faceNormalNode,
        skyDim: uSkyDim,
        sunDirection: uSunDirection,
        sunColor: uSunColor,
        shadowKill,
        reflectTexture,
      })
      : rgb;
    mat.colorNode = vec4(finalRgb, texColor.a);
    // 阴影 pass 逐片元排除不投影方块（bit14=1 → discard）。只在有阴影接线且本通道参与
    // 阴影时挂，fixture / transparent 路径不白付一次位运算。
    if (sunLight && receivesShadow) mat.maskShadowNode = noShadowCastBit.equal(0);
    if (alphaTest > 0) { mat.alphaTest = alphaTest; }
    if (transparent) { mat.transparent = true; mat.depthWrite = false; }
    mat.side = side;
    return mat;
  };

  return {
    opaque: makeMaterial({ wet: true }),
    // cutout = FrontSide + alphaTest 0.3（mc-lite 树叶族口径：leaves 0.3/FrontSide，
    // 树冠内表面背向相机不可见 → 堆积不过密）。cross 植被与 DoubleSide 方块
    // （realistic_oak_leaves）由 mesher 双向绕线复刻双面可见，保持单材质单通道。
    // emissive: true —— hanging_lamp 的材质自发光走本通道（§4.3 bit13）。
    // ⚠️ **v3.31 cutout 也挂湿分支**：台阶/半砖/栏杆/柱子全在本通道，
    // 不挂会让「石地面湿、石台阶干」。植被由 PLANT 类参数压到极弱（不是靠不挂分支）。
    cutout: makeMaterial({ alphaTest: 0.3, side: THREE.FrontSide, emissive: true, wet: true }),
    transparent: makeMaterial({ transparent: true, receivesShadow: false }),
    dayNight: {
      uSkyDim, uBlockBoost, uShadowStrength, uSunDirection, uSunStrength, uHemiGround, uSunColor, uAmbientColor,
      // v3.44：per-style 光影地板 / 半球 / 太阳强度（「普通」档用，其余档写全局常量）。
      // ⚠️ uShadowFloor 同时是影区地板**与** shadowKill 的归一化分母 —— 同一个 uniform 实例，
      // 结构上不可能不同步（而不是靠两处各写同一个值）。
      uShadowFloor, uSunIntensity,
      // v3.31：湿表面反光的天顶/地平线色（指向**同一 uniform 实例**，红线 1）。
      // DayNight._apply 写它们 ⇒ 反光颜色跟着既有风格/日夜循环走，不新增权威。
      uWetHorizon: WET_SURFACE_UNIFORMS.uWetHorizon,
      uWetZenith: WET_SURFACE_UNIFORMS.uWetZenith,
      // v3.50：云柔和总强度（与既有 uHemiGround 并列）。两个 per-style 地板也在里面，
      // 由 `_apply` 写（指向**同一 uniform 实例**，红线 1）。
      uCloudSoften,
      uCloudSunFloor,
      uCloudSunFloorRGB,
      uCloudHemiFloor,
    },
    /** v3.31：湿表面的 uniform 句柄（装配层每帧写 uWet） */
    wet: WET_SURFACE_UNIFORMS,
    /** v3.50：云专属着色地板的句柄（Tier 4 经它写 uCloudSoften 做单变量 A/B） */
    cloud: CLOUD_SURFACE_UNIFORMS,
  };
}

/** 场景雾（与视距联动，§4.4.3 简化版：M1 固定雾距，M2 接日夜）
 *  r185.1 语义：`fog(color, factor)` 返回 vec4 混合节点，
 *  factor = rangeFogFactor(near, far)（0=无雾 1=全雾），赋给 scene.fogNode 即生效。
 *
 *  v1.59 新增「雾色融入天空」：`fog()` 的 **color 参数本就是任意节点**
 *  （`three.webgpu.js:42069` 实现为 `vec4(factor.mix(output.rgb, color.toVec3()), output.a)`），
 *  所以把「固定色」换成「按视线方向采样天空盒」**不需要额外渲染通道、不加 pass**。
 *
 *  为什么必须按方向采样而不是取单一色：天空盒是照片，天顶/地平线/各水平方向的亮度
 *  差很多（实测白天雾带 [188,202,229] vs 固定 0x87ceeb [134,205,234]，R 通道差 54）。
 *  远景方块染成单一色后与身后的云对不上，就成了「贴在天空前的一排色板」。
 *
 *  ⚠️ **开关用 `mix()` 插值，不写 `if` 分支**：`uFogColorMix = 0` 时必须**逐位**回到
 *  v1.58 行为（固定 0x87ceeb）。写 if 会出两条代码路径，未测的那条静默劣化。
 *  ⚠️ `uSkyDayCube` / `uSkyNightCube` 为 null（天空盒未装配/加载失败/`?skybox=0`）时
 *  退回纯固定色 —— 没有立方图就无从采样，不能用未绑定 uniform 采样（会读全黑）。
 *
 * @param {THREE.Scene} scene
 * @param {number} viewDistance
 * @param {{uNightBlend: Object, uDuskBlend: Object, dayCube: THREE.CubeTexture,
 *   nightCube: THREE.CubeTexture, duskCube: THREE.CubeTexture}|null} [sky]
 *   `setupSky()` 的返回值（天空盒未启用时传 null）
 */
export function setupFog(scene, viewDistance, sky = null) {
  // 雾距与相机 far / 世界加载半径联动（避免边缘 pop-in）：
  // 世界加载半径 = (viewDistance+2)*16（滞回 +2），雾在加载边缘前完成（0.95 系数），
  // 相机 far 覆盖对角线（1.5 > sqrt2）。近景（< 0.75*vd*16）保持清晰。
  const fogNear = uniform(viewDistance * 16 * 0.75);
  const fogFar = uniform((viewDistance + 2) * 16 * 0.95);
  const fogColor = uniform(new THREE.Color(0x87ceeb));
  // 雾色模式开关（面板「雾色」）：0 = 固定色（默认，v1.58 行为），1 = 融入天空
  const uFogColorMix = uniform(0.0);

  let colorNode = fogColor;
  if (sky) {
    // 视线方向 = 片元世界位置 − 相机位置（与 ocean.js:148 的距离计算同源，均已核实片元可用）。
    //
    // ⚠️ **俯角（y ≤ 0）一律归到地平线带，只看方位角** —— 与 Tier 1 测的纯函数
    // `fog-sky-direction.js` 同构（红线 1：不得各写一份钳制规则）。
    // 直接用完整视线方向会让俯视时采样到立方图的天底那半张（实测 [97,125,186] vs
    // 地平线 [207,216,232]）→ 雾色反向变暗（实测 G −17 / B −12）。
    // ε 从 `fog-sky-direction.js` import（着色器侧写第二份字面量会漂移）。
    const dir = normalize(positionWorld.sub(cameraPosition));
    // ① y：俯角/水平（y ≤ 0）取 ε（贴地平线）；仰视保留原值。
    const sy = select(dir.y.greaterThan(0.0), dir.y, float(FOG_SKY_Y_FLOOR_EPS));
    // ② 水平分量：保留原值（方位角差异是本功能的价值）；垂直俯视时水平分量为零向量，
    //    取 +x 作确定性兼就（不能返回天顶 —— 实测会让俯视雾色反向变暗）。
    const horizLen = length(vec3(dir.x, 0.0, dir.z));
    const degenerate = horizLen.lessThanEqual(FOG_SKY_Y_FLOOR_EPS);
    const hx = select(degenerate, 1.0, dir.x);
    const hz = select(degenerate, 0.0, dir.z);
    const skyDir = normalize(vec3(hx, sy, hz));
    // 采样两套立方图后按同一个 uNightBlend 交叉淡入 —— **与场景背景共用该 uniform**，
    // 故雾色与天空永远同步（各写一份混合因子会漂移出「雾是白天色、天是夜幕色」的撕裂）。
    // ⚠️ `cubeTexture()` **不传 uvNode** → 用默认的方向采样映射（CubeReflectionMapping）。
    // 天空背景那边不传 uvNode 是为了让 three 注入 backgroundRotation；雾这边**没有**
    // backgroundRotation 的语义（雾不带天空旋转），传自定义方向是正确的。
    const daySample = cubeTexture(sky.dayCube, skyDir);
    const nightSample = cubeTexture(sky.nightCube, skyDir);
    const dayNight = mix(daySample.rgb, nightSample.rgb, sky.uNightBlend);
    // 三层混合（v1.71）：黄昏那层同样叠在最上层，与 `sky.js` 的 backgroundNode **同嵌套顺序**。
    // 不做这层的话，傍晚开着「雾色」时雾采样的是**白天/夜空**的贴图 → 远处方块染成蓝白色，
    // 与背后的暖色天空完全对不上（而这正是雾色功能存在的意义）。
    // ⚠️ 与背景共用同一个 `uDuskBlend` uniform 实例（与 uNightBlend 同一口径）。
    const duskSample = cubeTexture(sky.duskCube, skyDir);
    const duskMix = mix(dayNight, duskSample.rgb, sky.uDuskBlend);
    // 第四层（v3.44）：「普通」天空。**与背景共用同一个 `uNormalBlend` 实例**
    // 且**同嵌套顺序**（叠在最上层）—— 不做这层的话，开着「难色」时难采样的是
    // 白天/夜空/黄昏贴图 ⇒ 远处方块染成蓝白色，与背后的普通天空完全对不上
    // （而那正是难色功能存在的意义）。`uNormalBlend = 0` 时取左端 ⇒ 逐位零回归。
    const normalSample = cubeTexture(sky.normalCube, skyDir);
    const skyColor = mix(duskMix, normalSample.rgb, sky.uNormalBlend);
    colorNode = mix(fogColor, skyColor, uFogColorMix);
  }

  scene.fogNode = fog(colorNode, rangeFogFactor(fogNear, fogFar));
  return { fogNear, fogFar, fogColor, uFogColorMix };
}
